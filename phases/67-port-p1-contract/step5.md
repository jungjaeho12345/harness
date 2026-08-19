# Step 5: articles-write

기사 **쓰기·잠금 5 라우트**를 동결한다: `POST /api/articles`(#23) · `PUT /api/articles/:id`(#27) · `POST /api/articles/:id/lock`(#28) · `POST /api/articles/:id/unlock`(#29) · `POST /api/articles/:id/force-unlock`(#30). 핵심 계약 축은 **서버 stamp(부서·작성자·수정자·초기 status)**, **`x-edit-client` 탭 단위 잠금 보유자 인가**, **멱등 unlock**이다.

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — decisions **(2)(5)(6)(8)(16)(18)**
- `phases/67-port-p1-contract/step2.md` "작업 A" — `fixtures.createArticle`·`fixtures.acquireLock`·`actor`
- `docs/api-contract/endpoints.json` — `articles-create`·`articles-update`·`articles-lock`·`articles-unlock`·`articles-force-unlock` 행
- `server/index.js` — create(853~870행: `delete dto.role`·부서/작성자 stamp·`action` 의도 전달), update(926~947행: `x-edit-client` → `assertLockHolder` → `modifier` stamp → 빈 부서 보정), lock(952~966행: `editDps` 게이트와 `not-dps` 통과 규칙), unlock(968~979행), force-unlock(982~991행), `articleJson` 10mb 라우트 분기(536~543행)
- `src/services/articleService.js` — `create`(필드 화이트리스트 `ARTICLE_FIELDS`·`CONTENTS_FIELDS` 18~26행), `update`, `acquireEditLock`(TTL 30분·같은 탭 재획득·재로그인 takeover), `releaseEditLock`(멱등), `forceReleaseEditLock`, `assertLockHolder`
- `src/services/authorization.js` — `editDps`(DPS 편집은 D만)
- `docs/SCHEMA.md` — Contents 잠금 4컬럼·공통정보 컬럼
- `test/editLock.test.js` · `test/articleService.test.js` — 예측 수립용(베끼지 말고 기대값 도출에만 사용)

## 배경

- `POST /api/articles`는 클라가 보낸 `role`을 **지우고**, `department`/`author`가 비면 **세션에서 stamp**한다. 초기 status는 서버가 계산한다(기본 RDS, Z/D + `action:'hold'`면 DDH, R + hold면 RRH). 클라가 보낸 `status`는 반영되지 않는다 — **이것을 음성 케이스로 못 박아야** ADR-004 계약이 Spring에서도 산다.
- `PUT /api/articles/:id`는 세션만으로는 못 쓴다. `x-edit-client`(탭 식별자)까지 일치하는 **잠금 보유자**만 통과하고, 아니면 403 `not-holder`다.
- `POST .../lock`은 비-DPS 기사면 인증된 R/D/Z 누구나, DPS 기사면 D(·Z 여부는 실측)만. 다른 탭이 잠근 기사에 대한 잠금 시도는 401 `locked`(전역 매핑상 401 — **놀라운 매핑이므로 반드시 실측 확인하고 명세에 굵게 기록**).
- `POST .../unlock`은 잠겨 있지 않아도 200(멱등 — 탭 닫기·pagehide가 중복 호출한다).
- 이 3 라우트는 SSE `lock` 신호를 유발한다(신호 자체 검증은 step11 소유 — 여기서는 상태 변화만 본다).

## 작업

### A. `contract/cases/default/articles-write.contract.js`

1. **인가**: 5 라우트 전부 미인증 → 401. `POST /api/articles`를 **역할이 R/D/Z가 아닌 세션**으로 호출하는 케이스는 만들 수 없다(시드 계정이 셋뿐) — 만들지 말고, 그 사실을 명세의 `403 forbidden` 서술에 "정의 외 role에서만 도달 — 스위트 미검증"으로 남긴다.
2. **create 성공**: R 세션 + 고유 제목 → 200 `{ok:true, articleId}` · articleId 형식(`AKR` + 8자리 + 9자리)을 정규식으로 단언(값은 리포트에 마스킹). 이어서 `GET /api/articles/:id`로 되읽어 **stamp 결과**를 단언: `author`가 세션 사용자, `department`/`departmentCode`가 세션 부서, `status`가 `RDS`.
3. **create 신뢰 경계 음성 케이스**: body에 `role:'Z'`, `status:'DPS'`, `author:'someone-else'`, `sender`, `distributedAt`, `articleId`를 넣어 저장 → 200이지만 되읽었을 때 `status`는 `RDS`, `articleId`는 서버 발급 값, `sender`/`distributedAt`은 비어 있음. **`author`는 클라 값이 보존되는지 실측**하고(코드상 명시 author는 보존된다) 그 사실을 명세에 명시한다 — "무엇이 무시되고 무엇이 존중되는가"가 계약이다.
4. **create + `action:'hold'`**: D 세션 → `DDH`, R 세션 → `RRH`(실측 확인).
5. **lock 성공**: 자기 기사에 `x-edit-client: <tabA>`로 잠금 → 200. 되읽어 `lockYN='Y'`·`lockerUserId`가 세션 사용자 · **`lockerSessionId`·`lockerClientId`는 응답에 없음**.
6. **lock 충돌**: 같은 기사에 **다른 사용자**(D 세션) + `<tabB>`로 잠금 시도 → 실측 상태/토큰(예상: 401 `locked`)을 단언. 같은 사용자·같은 탭 재획득은 200(멱등).
7. **lock 404**: 없는 articleId → 404 `not-found`.
8. **lock DPS 게이트**: `fixtures.createSentArticle()`(D가 send해 DPS)로 만든 기사에 **R 세션**이 잠금 시도 → 403 `forbidden`(실측). D 세션은 200. `action:'portalRevise'` 분기도 1건 확인.
9. **update 보유자 인가**: (a) 잠금 없이 PUT → 403 `not-holder` (b) 잠금 보유 탭(`<tabA>`)으로 PUT → 200 · 되읽어 반영 확인 · `modifier`가 세션 사용자로 stamp (c) **같은 세션의 다른 탭**(`<tabB>`)으로 PUT → 403 `not-holder`(탭 단위 인가의 핵심 케이스).
10. **update 화이트리스트**: PUT body에 `status`·`sender`·`articleId`·`role`을 섞어 보내도 반영되지 않음을 되읽어 확인. `department`를 빈 문자열로 보내면 세션 부서로 보정되는지 실측.
11. **update 404**: 없는 articleId + 아무 탭 → 실측 상태(잠금 검사가 먼저인지 존재 검사가 먼저인지가 드러난다 — 그 순서가 계약이다).
12. **unlock**: 보유 탭 → 200 · 되읽어 `lockYN='N'`. 잠기지 않은 기사에 다시 unlock → **200(멱등)**. 다른 사용자·다른 탭 unlock → 403 `not-holder`.
13. **force-unlock**: R 세션 → 403 `forbidden`. D 세션 → 200 · 되읽어 해제. 잠기지 않은 기사에 대한 force-unlock 동작 실측(200인지 다른지).

### B. 명세 반영 `docs/api-contract/openapi.yaml`

- 5 라우트 paths 추가. `x-edit-client` 헤더 파라미터 컴포넌트를 정의해 lock/unlock/update에서 참조한다.
- create/update의 **요청 필드 화이트리스트**를 스키마로 적고, "여기 없는 필드는 무시된다"·"role/status/articleId/sender는 서버가 결정한다"를 description에 명시한다.
- 본문 크기 상한(기사 쓰기 라우트만 10mb JSON 파서)을 서술한다.

## Acceptance Criteria

```bash
npm run test:contract -- --profile default --files contract/cases/default/articles-write.contract.js
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

## 검증 절차

1. 예측 먼저: 특히 (a) 다른 사용자 잠금 충돌의 상태코드 (b) update 404 vs 403 우선순위 (c) create에서 클라 `author`가 보존되는지 — 세 항목은 코드에서 읽은 예측을 적고 실측과 대조해 요약에 남긴다.
2. **잠금 정리 규율**: 각 케이스는 자기가 잠근 기사를 `finally`에서 unlock(또는 force-unlock)한다. 잠긴 채로 남으면 다음 실행에서 30분 TTL 안에는 다른 판정이 나올 수 있다(재실행 결정성이 깨진다). 같은 파일을 연속 2회 실행해 둘 다 green인지 확인하라.
3. **vacuity 변이 2종**(각각 원복): (a) 9-(c)의 기대를 200으로 뒤집어 red 확인(탭 단위 인가가 실제로 검증되고 있다는 증거), (b) 3번에서 `status` 기대를 `DPS`로 바꿔 red 확인(신뢰 경계 단언이 살아 있다는 증거).
4. AC 전부 실행 · 리포트 누출 재확인(articleId·본문이 리포트에 없어야 한다).
5. `git status --porcelain` 증분 = `contract/cases/default/articles-write.contract.js` · `docs/api-contract/openapi.yaml` · `phases/67-port-p1-contract/index.json`.
6. 아키텍처 체크: 서버 코드 무수정 · `npm test` 1327 유지.
7. index.json step5 status·summary 갱신.

## 금지사항

- 잠금을 획득한 채 케이스를 끝내지 마라. 이유: 30분 TTL 동안 후속 실행의 판정이 달라져 비결정적 실패가 된다.
- `force-unlock`을 정리용 만능 도구로 남발하지 마라. 이유: 그 라우트 자체가 검증 대상이고, 다른 케이스의 잠금 상태를 조용히 바꾸면 실패 원인이 갈라진다(정리는 자기가 잠근 것을 자기가 푸는 것이 원칙).
- 클라이언트가 보낸 `role`/`status`가 반영되기를 기대하는 케이스를 쓰지 마라. 이유: ADR-004의 신뢰 경계다 — 반영되면 그것이 결함이다(발견 시 수정하지 말고 기록).
- 픽스처 기사에 실제 사용자 데이터를 흉내 낸 값을 넣지 마라. 이유: 리포트·로그로 흘러갈 수 있다 — 고유 토큰 + 무해한 문구만 쓴다.
- 기사 행을 지우려 하지 마라(그런 API도 없다). 이유: DB 비파괴 원칙이며, 삭제는 `approveDelete` 상태 전이(step6)로만 표현된다.
- `PUT /api/articles/:id`로 큰 본문(수 MB)을 보내 상한을 탐색하지 마라. 이유: 실행 시간이 늘고, 본문 상한 계약은 명세 서술로 충분하다(업로드 too-large는 step9이 소유).
