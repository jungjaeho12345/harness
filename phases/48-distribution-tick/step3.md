# Step 3: tick-route-docs

배부 tick을 HTTP로 노출하고(외부 운영 cron이 pull), 배부/전이 결과를 SSE 무효화 신호로 재발행한 뒤, 문서를 현행화한다.
이 step으로 **phase 47이 phase 48에 넘긴 인수인계 3건**이 모두 닫힌다:
(1) `POST /api/distribution/tick` 라우트, (2) 엠바고 시점 판정, (3) EPS→DPS 완결 전이.
(2)(3)은 step0~step2에서 구현됐고, 여기서는 (1)과 결선·문서만 한다.

## 읽어야 할 파일

- `docs/ADR.md` — **ADR-008 (3)**(tick pull 엔드포인트, 앱 타이머/egress 금지), **ADR-005**(SSE는 행 데이터 없는 무효화 신호), ADR-004, ADR-006(얇은 transport).
- `server/index.js` —
  - `STATUS_BY_REASON` 맵과 `fail(res, result, fallback)` 헬퍼,
  - `readSessionToken(req)`(쿠키 우선 → `x-session-id` 헤더 폴백),
  - `app.notifyChange(kind)`와 `/api/stream` SSE,
  - `POST /api/collection/pull` 라우트(**기계 pull 엔드포인트의 청사진** — 로깅 마스킹 + `notifyChange` 패턴),
  - `/api/distribution-targets` 라우트 블록(배부 라우트가 모여 있는 위치),
  - `bootstrap()`의 `DIST_SPOOL_DIR` 로그 한 줄.
- **step2 산출물** `src/controllers/index.js` — `controllers.distribution.runTick(sessionId)` (async, 인자는 세션 토큰 하나).
- **step1 산출물** `src/services/distributionTickService.js` — 반환 shape `{ ok, checked, distributed, completed, incomplete }` / `{ ok:false, reason:'spool-disabled'|'tick-in-progress'|'invalid-clock' }`.
- `test/distribution-targets-api.test.js` — transport 테스트 하네스(`createApp` + `listen(0)` + `fetch` + `x-session-id`) 관례.
- `docs/ARCHITECTURE.md`(services 목록·데이터 흐름 `[배부]` 블록), `docs/SCHEMA.md`(Contents 절), `README.md`(환경변수/운영 절).

## 작업

**TDD: `test/distribution-tick-api.test.js`를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) `server/index.js` — 라우트 추가

배부 대상 라우트 블록 아래에 추가한다.

```js
// --- 시점/엠바고 배부 tick (Z/시스템 전용 — 게이트는 controllers.distribution이 강제, ADR-008 (3)) ---
// 외부 운영 cron이 주기 호출하는 pull 엔드포인트다. 앱에는 타이머가 없다.
// 요청 바디는 읽지 않는다 — 대상/시각/actor 주입 차단(ADR-004).
app.post('/api/distribution/tick', async (req, res, next) => { /* ... */ });
```

**고정 규칙**

1. **`req.body`를 한 번도 읽지 마라.** 호출은 `await controllers.distribution.runTick(readSessionToken(req))` 하나뿐이다.
2. 실패는 `fail(res, r)`로 매핑한다. `STATUS_BY_REASON`에 **additive로 2개만** 추가한다:
   - `'spool-disabled': 503` (배부 미설정 — 서버가 아직 그 기능을 제공하지 않음)
   - `'tick-in-progress': 409` (이전 tick 실행 중 — cron 중복 호출)
   기존 매핑 값(`unauthenticated:401`, `forbidden:403` 등)은 **수정하지 마라**.
   `'invalid-clock'`은 별도 매핑 없이 기본 400으로 떨어뜨린다.
3. 성공 시 응답은 서비스 반환값 그대로(`res.json(r)`).
4. **로깅**: `logService.info(\`distribution tick checked=.. distributed=.. completed=.. incomplete=..\`)` 형태로 **건수만** 남긴다.
   기사 본문·제목·스풀 파일 경로·페이로드는 절대 담지 마라(마스킹 규율 — 로그는 Z에게 SSE로 스트리밍된다).
   미완결이 있으면 `logService.warn`으로 `articleId`와 `missing` kind까지만 남겨도 된다(본문 금지).
5. **SSE 재발행**: `r.ok && (r.distributed.length > 0 || r.completed.length > 0)`일 때만 `app.notifyChange('distribute')`를 호출한다.
   - 이유(호출 조건): cron이 분 단위로 호출하는데 무조건 발행하면 전 클라이언트가 매분 재조회한다(ADR-005 naive broadcast).
   - 이유(신호 발행 자체): tick은 `Contents.status`를 EPS→DPS로 바꾸고 `distributedAt`을 갱신한다 — 조회 목록(엠바고 관리/부서별 송고)이 갱신되지 않으면 실시간 화면이 어긋난다.
   - 페이로드는 기존과 동일하게 `{ kind }` 신호뿐이다. **기사 행 데이터를 실어 보내지 마라**(ADR-005).
   - 클라이언트는 무변경으로 동작한다: 목록 컨트롤러는 신호 종류와 무관하게 재조회하고, `useWriteController`는 `kind !== 'lock'`이면 무시한다. 확인만 하고 `web/**`은 건드리지 않는다.

### 2) `server/index.js` — 부트스트랩

- **아무 것도 추가하지 않는 것이 기본이다.** 기존 `DIST_SPOOL_DIR` 로그 한 줄이면 충분하다.
- `setInterval`/`setTimeout`으로 tick을 자동 호출하는 코드를 넣지 마라(아래 금지사항 참조).

### 3) 테스트 `test/distribution-tick-api.test.js` (신규)

하네스는 `test/distribution-targets-api.test.js`와 동일하게 구성하되, `createControllers(db, { sessionService, env: { ...ENV, DIST_SPOOL_DIR: 'spool' }, spoolFs })`로 **가짜 FS를 주입**해 실제 파일을 쓰지 않는다.

1. 미인증(세션 헤더 없음) → **401**, 비-Z(R/D) 세션 → **403**. 응답에 tick 결과가 섞이지 않는다.
2. Z 세션 → **200** + `{ ok:true, checked, distributed, completed, incomplete }` shape.
3. **바디 무시**: Z 세션으로 `{ role:'Z', articleId:'AKR...', now:'2030-01-01T00:00:00Z', kinds:['press','nonpress'] }`를 보내도 결과가 바디 없이 호출했을 때와 동일하다(미래 시각/대상 주입이 반출을 일으키지 않는다).
4. **권한 상승 차단**: R 세션 + 바디 `{ role:'Z' }` → 403(바디 role 무시).
5. `DIST_SPOOL_DIR` 미설정 컨트롤러 → Z 세션 호출 시 **503** `spool-disabled`, 비-Z는 여전히 403(설정 상태 누출 없음).
6. **엔드투엔드 1건**: 활성 press 수신처를 Z 세션으로 등록 → 엠바고(1차, 과거 시각·오프셋 포함 ISO) 기사를 EPS 상태로 넣고 tick 호출 → 가짜 FS에 스풀 파일 1건 기록, `Contents.status`가 `DPS`, `ArticleHistory`에 `distribute` 1행 + `embargoComplete` 1행. 같은 tick을 한 번 더 호출하면 파일 쓰기 추가 0건(멱등).
7. **SSE 신호**: `/api/stream` 구독 중 tick으로 배부가 발생하면 `change` 이벤트(`kind:'distribute'`)가 오고, 배부/전이가 0건인 tick에서는 오지 않는다.
8. `GET /api/distribution/tick`은 존재하지 않는다(404) — 실행은 POST만.

### 4) 문서 현행화

- `docs/ARCHITECTURE.md`
  - `services/` 목록에 `embargoSchedule`·`distributionTick` 추가.
  - 데이터 흐름 `[배부]` 블록 아래에 `[배부 tick]` 한 블록 추가:
    외부 cron → `POST /api/distribution/tick`(Z 세션) → EPS 기사 조회 → `embargoSchedule`로 도래 kind 판정 →
    `distributionService`(스풀 기록) → ArticleHistory 기반 완결 판정 → EPS→DPS 전이 + `embargoComplete` 이력 → SSE `distribute` 신호.
    **앱에는 타이머·네트워크 egress가 없다**는 문구를 유지한다.
- `docs/SCHEMA.md`
  - Contents 절 `status` 설명에 한 줄: EPS는 tick이 배부 완결을 판정하면 DPS로 전이한다(시스템 전이 — 사용자 액션 아님, 이력은 `eventType='status'`, `action='embargoComplete'`).
  - 필요하면 배부 이력 표기(`eventType='distribute'`, `action=kind`) 한 줄까지만 추가한다.
  - **새 테이블/컬럼을 추가하지 마라** — 이 phase는 스키마 변경이 없다.
- `README.md`
  - 운영 절에 배부 tick 항목 추가: 외부 cron이 주기적으로 `POST /api/distribution/tick`을 **Z 계정 세션**으로 호출한다(앱 내 타이머 없음 — ADR-008), 미설정(`DIST_SPOOL_DIR` 없음) 시 503.
  - **엠바고 시각 입력 형식 주의**를 한 줄 명시한다: `embargoAt`/`secondEmbargoAt`는 **타임존 오프셋을 포함한 ISO-8601**(`2026-07-30T09:00:00+09:00` 또는 `...Z`)이어야 tick이 도래로 인정한다. 오프셋이 없거나 파싱되지 않는 값은 배부되지 않고 기사가 EPS에 머문다(조기 반출 방지 fail-safe).
- **docs에 없던 정책을 새로 발명해 적지 마라.** 위 항목은 ADR-008·news.md와 step0~2 구현에서 도출된 사실의 기록이다. `docs/news.md`는 수정하지 않는다(사용자 소유 스펙).

## Acceptance Criteria

```bash
npm run lint && npm run build && npm test && npm run test:web
```

- lint 경고 0, build clean, 백엔드 테스트 fail 0(phase 47 완료 기준선 527 pass + 이 phase 신규분), 웹 테스트 기준선 **1927 pass / 0 fail** 유지(web 무변경).

```bash
grep -rnE "setInterval|setTimeout|fetch\(" server/index.js | grep -i "tick\|distribution"
```
- **0건**(앱 내 타이머·egress 금지).

```bash
git diff --stat -- web
```
- **변경 0**.

## 검증 절차

1. 의존성 설치 확인(`node_modules` 없으면 무관한 테스트가 대량 실패 — 코드 문제 아님).
2. 구현 전 `node --test test/distribution-tick-api.test.js` red 확인·기록.
3. `npm test` 전체 green → `npm run test:web` 무회귀 → `npm run lint` → `npm run build`.
4. `grep -n "req.body" server/index.js | grep -A2 -B2 tick` — tick 라우트에서 바디 참조 0건 확인.
5. `git diff docs/ README.md`로 문서 변경이 위 4개 항목 범위 안인지 확인한다.

## 금지사항

- 라우트 안에 배부/판정/전이 로직을 두지 마라. 이유: ADR-006 얇은 transport — 라우트는 세션 토큰 전달과 응답 매핑, SSE 신호만 한다.
- `req.body`에서 대상 기사·kind·시각·actor·role을 읽지 마라. 이유: 엠바고 통제와 인가가 동시에 무너진다(ADR-004/ADR-008).
- `setInterval`/`setTimeout`/워커로 tick을 자동 실행하지 마라. 이유: ADR-008 (3)은 외부 cron pull을 명시한다 — 앱 내 스케줄러는 다중 인스턴스에서 중복 반출을 만들고 오프라인 테스트 결정성을 깬다.
- tick 라우트에 `COLLECTION_TOKEN` 류의 토큰 우회 인증을 추가하지 마라. 이유: ADR-008 (3)이 Z/시스템 전용 세션 게이트로 못 박았다 — 인증 경로를 늘리면 검토되지 않은 두 번째 신뢰 경계가 생긴다.
- SSE 페이로드에 기사 행 데이터를 싣지 마라. 이유: ADR-005는 역할별 노출을 피하려고 무효화 신호만 보낸다.
- 배부/전이가 0건인 tick에서도 `notifyChange`를 발행하지 마라. 이유: cron 주기마다 전 클라이언트가 재조회한다(불필요한 부하).
- 기존 `STATUS_BY_REASON` 항목의 값을 바꾸지 마라(추가만). 이유: 기존 라우트의 응답 코드 계약이 깨진다.
- `src/services/distributionTickService.js`·`embargoSchedule.js`·`authorization.js`의 규칙을 라우트에서 다시 구현하거나 우회하지 마라. 이유: 판정 지점이 둘로 갈라지면 한쪽만 고쳐져 조기 반출이 재발한다.
- 행 삭제(`DELETE`/`DROP`)나 스키마 파괴 변경을 하지 마라. 이유: DB 비파괴 원칙(ADR-002).
- `web/**` 를 수정하지 마라. 이유: 배부 현황 UI는 MVP-4 후속 범위다(PRD).
