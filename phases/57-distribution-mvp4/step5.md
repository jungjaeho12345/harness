# Step 5: failure-routes

## 목표

배부 실패 조회·재전송을 HTTP 경계에 노출한다(얇은 transport — ADR-006).

- `GET  /api/distribution/failures` — Z 전용, 미해소 수신처 실패 목록.
- `POST /api/distribution/retry` — Z 전용, `{ articleId, targetId }` 1건 재전송.

## 읽어야 할 파일

- `docs/ADR.md` **ADR-004**·**ADR-006**·**ADR-008 (3)**·**ADR-009**(CSRF Origin/Referer 가드 — 상태 변경 메서드는 전역 미들웨어가 이미 검사한다). **읽기 전용(무접촉)**.
- `server/index.js` — 특히
  - L165~193 `UNAUTH`/`FORBIDDEN`/`STATUS_BY_REASON`/`fail(res, result, fallback)`.
  - L215~227 `FILTER_KEYS`·`pickFilters`(쿼리 화이트리스트 선례 — `distributedAtFrom/To`가 **이미 있다**).
  - L536~581 배부 대상 라우트 + `POST /api/distribution/tick`(주석의 3대 규율: 앱 타이머 없음 / 부수효과라 GET 금지 / body 미사용).
  - L424 `app.notifyChange(kind)`, L573~581 tick이 실제 배부가 있을 때만 `notifyChange('status')`를 보내는 패턴.
  - `readSessionToken`(쿠키 우선 + `x-session-id` 폴백) 정의 위치.
- `src/controllers/index.js`(step4) — `controllers.distribution.failures/retry` 시그니처.
- `src/services/distributionRetryService.js`(step3) — 거부 사유 토큰 전체.
- `test/distribution-tick-api.test.js` **전체** — 이 step 테스트의 하네스 원본(in-memory db + `createApp` + 실제 fetch + 가짜 spool FS + 응답 위생 단언).
- `test/response-secrets.test.js` **전체** — 이 step이 **수정하는 파일**이다. 특히 L106~126 `routesFor()`(파일 상단 규정: "새 라우트가 추가되면 반드시 여기에 넣는다"), L128~130 `inAuditScope`(현재 `/api/articles*`와 `/api/distribution/tick`만), L132~ `registeredRoutes`(Express 라우터 반영으로 **누락을 자동 검출**한다 — 라우트를 추가하고 이 배열에 넣지 않으면 이 파일이 red가 된다).

## 배경 (자기완결)

`POST /api/distribution/tick`이 세운 계약을 그대로 승계한다.

- 세션 토큰은 `readSessionToken(req)`로만 읽는다(쿠키 우선, `x-session-id` 폴백). 쿼리스트링 토큰은 없다.
- 부수효과가 있는 연산은 **POST**로만 연다(GET 프리페치·크롤러가 배부를 트리거하면 안 된다).
- 응답 본문에 **서버 파일시스템 경로가 실리지 않는다**(서비스 투영이 transport까지 유지되는지 라우트 테스트가 잠근다).
- 라우트는 shape 매핑·게이트 위임만 한다 — 판정·조회·기록 로직 0.

`retry`는 body에서 **`articleId`·`targetId`만** 읽는다. `role`·`kind`·시각·`spoolDir`는 읽지 않는다(읽으면 그 자체가 인가 우회 표면이다).

새 거부 사유의 HTTP 매핑(`STATUS_BY_REASON`에 additive 추가):

| reason | status | 근거 |
| --- | --- | --- |
| `no-failure` | 404 | 재전송할 미해소 실패가 없다(대상 없음) |
| `status-changed` | 409 | 기사 상태가 배부 불가로 바뀐 상태 충돌 |
| `kind-changed` | 409 | 수신처의 현재 kind가 실패 이력의 kind와 달라진 상태 충돌 |

`inactive`(403)·`not-found`(404)·`spool-disabled`(503)·`forbidden`(403)·`unauthenticated`(401)는 이미 매핑돼 있다.

## TDD — 테스트 먼저

`test/distribution-failure-api.test.js`를 새로 만든다(`test/distribution-tick-api.test.js`의 `start`/`api`/`loginAs`/`fakeSpoolFs` 하네스를 복제해 쓴다 — 실제 파일을 만들지 않는다).

### GET /api/distribution/failures

1. 미인증 → 401 `{ ok:false, reason:'unauthenticated' }`, `items` 없음.
2. R/D 세션 → 403 `forbidden`.
3. Z 세션 → 200 `{ ok:true, items:[...] }`. 실패 이력을 시드한 기사·수신처가 항목으로 나온다.
4. **응답 위생**: 200 본문 문자열 어디에도 스풀 루트(`/spool/...`)·수신처 `spoolDir` 슬러그가 등장하지 않는다(문자열 검색 단언 — tick 테스트의 (3)과 동형).
5. `?limit=1`이 적용된다(항목 2건 시드 후 1건).
6. 재전송 성공 이력이 있는 항목은 목록에 없다.

### POST /api/distribution/retry

7. 미인증 → 401. 비-Z → 403. 두 경우 모두 **스풀 FS 호출 0회**(가짜 FS 스파이로 확인).
8. `body.role='Z'`를 실어도 비-Z 세션이면 403이다(ADR-004 잠금).
9. Z 세션 + 유효한 미해소 실패 → 200 `{ ok:true, articleId, targetId, kind, at }`. 스풀 FS에 `mkdir`/`writeFile`/`rename`이 정확히 1세트 호출되고, 응답에 `file`·`spoolDir`가 **없다**.
10. 성공 후 `Contents.distributedAt`이 갱신되고 `status`는 불변이다(DB 직접 조회).
11. 성공 후 `GET /api/distribution/failures`에서 그 항목이 사라진다(왕복).
12. 미해소 실패가 없는 쌍 → 404 `no-failure`, 스풀 FS 호출 0회.
13. 기사 status가 `EEK` → 409 `status-changed`, FS 호출 0회.
14. 비활성 수신처 → 403 `inactive`.
15. 없는 수신처 id·없는 기사 → 404 `not-found`.
16. 스풀 미설정(`DIST_SPOOL_DIR` 없음) + Z → 503 `spool-disabled`. 같은 환경에서 `GET .../failures`는 200이다.
17. `GET /api/distribution/retry`는 라우트가 없어 404다(부수효과 연산을 GET으로 열지 않았다는 증거).
18. 재전송 성공 시에만 SSE 무효화 신호 `'status'`가 1회 발생하고, 실패·거부 응답에서는 발생하지 않는다(tick 테스트의 signals 스파이 패턴 복제).
19. `targetId`를 문자열로 보내도(JSON `"12"`) 정상 처리된다(HTTP 경계 정규화).
20. 수신처 kind가 바뀐 상태에서 재전송 → **409** `kind-changed`, 스풀 FS 호출 0회.

### `test/response-secrets.test.js` 등록(누락 방지 규정)

21. `routesFor()` 배열에 신규 라우트 2개를 추가한다 — `['GET', '/api/distribution/failures', {}, '/api/distribution/failures']`, `['POST', '/api/distribution/retry', { body: { articleId: '…', targetId: 1 } }, '/api/distribution/retry']`. R 세션 호출이라 403이 나와도 **응답 본문 위생은 검사된다**(tick 라우트와 동일 취급).
22. `inAuditScope` 조건에 두 경로를 포함시켜 감사 범위에 넣는다(`/api/distribution/`으로 시작하는 경로를 묶는 방식 권장 — tick도 자연히 포함된다).
23. 그 파일의 "누락 방지" 테스트(라우터 반영 대조)가 green이어야 한다 — red면 배열 등록을 빠뜨린 것이다.

## 작업

`server/index.js`만 수정한다.

1. `STATUS_BY_REASON`에 `'no-failure': 404`, `'status-changed': 409`, `'kind-changed': 409`를 추가한다(기존 항목 변경 금지).
2. 배부 tick 라우트 바로 아래에 라우트 2개를 추가한다.

```js
// --- 배부 실패 조회/재전송 (Z 전용 — 게이트는 authorization.manageDistributionFailure, ADR-008 MVP-4) ---
// 조회는 부수효과가 없으므로 GET, 재전송은 스풀 파일을 쓰므로 POST다(프리페치 트리거 금지).
// body에서 읽는 값은 articleId·targetId뿐이다 — role·kind·시각·경로를 받으면 인가가 무력화된다(ADR-004).
app.get('/api/distribution/failures', (req, res, next) => { /* controllers.distribution.failures */ });
app.post('/api/distribution/retry', async (req, res, next) => { /* controllers.distribution.retry */ });
```

규칙:

1. 세션 토큰은 `readSessionToken(req)`만 쓴다.
2. 실패 응답은 `fail(res, r)`로 통일한다(상태 코드 매핑 단일 지점).
3. `retry`는 `async` 라우트다 — `try/catch`로 감싸 `next(e)`로 넘겨라(Express 4는 async rejection을 잡지 못한다 — tick 라우트 주석의 명시 경고).
4. 재전송이 **성공했을 때만** `app.notifyChange('status')`를 부른다(`distributedAt`이 바뀌어 목록 재조회가 필요하다). 거부·실패에는 신호를 보내지 않는다.
5. `limit`은 `req.query.limit`만 화이트리스트로 넘긴다(쿼리 통짜 전달 금지).
6. `targetId`는 `Number(...)`로 정규화해 넘긴다(`Number(req.params.id)` 선례).
7. 라우트에 판정 분기(상태·실패 존재·활성)를 넣지 마라 — 전부 서비스가 이미 한다.

## Acceptance Criteria

```bash
npm test          # 실패 0 — step4 종료 시점 개수 + 신규 케이스
npm run lint      # 통과
```

**diff scope**: 시작 시점 스냅샷 대비 증분이 `server/index.js`, `test/distribution-failure-api.test.js`, `test/response-secrets.test.js` **3개뿐**.

## 검증 절차

1. 위 AC 커맨드를 실행한다. `test/server.test.js`·`test/csrf-origin.test.js`가 **무수정 green**인지 확인하라(`test/response-secrets.test.js`는 라우트 등록만 추가하고 단언 로직은 무수정이어야 한다).
2. 변이 검증 4종(확인 후 원복):
   - `retry`를 `app.get`으로 바꾸면 케이스 17이 red.
   - 응답에 서비스 반환을 통짜로 싣지 않고 `spoolDir`를 추가해 보면 케이스 4/9가 red(위생 단언 동작 확인).
   - `notifyChange`를 무조건 호출하면 케이스 18이 red.
   - `routesFor()` 등록을 되돌리면 `test/response-secrets.test.js`의 누락 방지 테스트가 red(등록 규정이 실제로 강제됨).
3. 아키텍처 체크리스트:
   - 라우트에 비즈니스 로직이 0인가(위임·매핑만)?
   - `req.body.role`을 읽는 코드가 없는가?
   - 새 라우트가 CSRF 가드(비-GET 전역 미들웨어) 뒤에 있는가(라우트 등록 위치)?
   - 앱에 타이머·주기 실행을 추가하지 않았는가(ADR-008)?
4. `phases/57-distribution-mvp4/index.json`의 step5를 `completed` + `summary`로 갱신한다. summary에 두 라우트의 메서드·경로·요청 필드·응답 shape·새 STATUS_BY_REASON 매핑·SSE 신호 조건을 명시하라.

## 금지사항

- 재전송을 GET으로 열지 마라(디버그용 별칭 포함). 이유: 브라우저 프리페치·크롤러·이미지 태그가 배부를 트리거할 수 있고, ADR-009 CSRF 가드는 비-GET에만 적용된다.
- body에서 `role`·`kind`·`spoolDir`·시각·`actorUserId`를 읽지 마라. 이유: 배부 대상·시점·신원을 클라이언트가 정하면 엠바고와 Z 게이트가 무력화된다(ADR-004).
- 쿼리스트링으로 세션 토큰을 받지 마라. 이유: 평문 토큰 URL 누출 표면 — `?session=` 폴백은 이미 제거된 결함이다.
- 서비스 반환값에 라우트에서 필드를 덧붙이지 마라(특히 대상 행 스프레드). 이유: `spoolDir`·파일 경로가 그 경로로 샌다.
- `STATUS_BY_REASON`의 기존 매핑을 바꾸지 마라. 이유: 다른 라우트 전체의 상태 코드 계약이 함께 흔들린다.
- 라우트 파일에 `setInterval`/스케줄러/워커를 추가하지 마라. 이유: ADR-008 (3) — 다중 인스턴스 중복 배부.
- `docs/news.md`·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하지 마라.
- `docs/ADR.md`를 이 step에서 수정하지 마라. 이유: ADR-008 보강은 step13이 단독 소유하는 작업이다 — 같은 파일을 두 step이 만지면 diff scope 판정이 무너진다.
- `git add -A`/`git add .` 금지, 미커밋 사용자 파일의 `restore`/`checkout`/`stash`/`clean` 금지.
