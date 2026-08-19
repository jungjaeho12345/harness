# Step 7: admin-crud

**Z 전용 관리 CRUD 6 라우트**를 동결한다: 사용자 `GET/POST /api/users`·`PUT /api/users/:id`(#5·6·7)와 수집 수신 설정 `GET/POST /api/receiver-config`·`DELETE /api/receiver-config/:id`(#8·9·10). 계약 축은 **역할별 응답 투영(비-Z는 4필드)**, **비밀번호 절대 미노출**, **DELETE가 설정 행만 지우고 수집된 기사는 건드리지 않는다**는 것이다.

## 읽어야 할 파일

- `phases/67-port-p1-contract/index.json` — decisions **(2)(5)(6)(11)(14)(16)(18)**
- `docs/api-contract/endpoints.json` — `users-*`·`receiver-config-*` 행
- `server/index.js` — users 3 라우트(654~683행: Z 분기 투영 4필드·`manageUsers` 게이트), receiver-config 3 라우트(686~705행: 게이트를 서비스가 강제·`Number(req.params.id)`)
- `src/services/userService.js` — `query`(정제 필드)·`create`·`update`의 반환 shape와 검증 토큰
- `src/services/authorization.js` — `manageUsers`(Z 전용·`unknown-capability`)
- `src/services/receiverConfigService.js` · `src/models/receiverConfigModel.js` — 검증·삭제 범위
- `docs/SCHEMA.md` — User 테이블(active 'Y'/'N'·role R/D/Z) · ReceiverConfig 테이블(type FTP/API·active·행 삭제 범위)
- `docs/RCV.md` — 수신 설정 관리 스펙(rcvMgmt.do 조회/생성/삭제)
- `test/userService.test.js` · `test/receiverConfigService.test.js` — 예측 수립용

## 배경

- `GET /api/users`는 **세션만 있으면** 200이지만 응답이 역할에 따라 다르다: Z는 전체(비밀번호 제외), 그 외는 `userId,name,department,departmentCode` **4필드만**. 이 투영이 Spring에서 빠지면 기자가 전 사용자 role·active를 보게 된다.
- `POST/PUT /api/users`는 Z 전용(게이트는 `controllers.auth.manageUsers`). 비-Z는 403, 미인증은 401.
- receiver-config 3 라우트는 라우트에 게이트가 없고 **서비스가 세션 토큰을 받아 판정**한다(같은 결과, 다른 구조 — Spring 이식 시 게이트 위치를 옮겨도 계약은 같아야 한다).
- `DELETE /api/receiver-config/:id`는 이 시스템의 **유일한 DELETE 라우트**다. 설정 행만 지우고 수집된 Article/Contents는 절대 건드리지 않는다(DB 비파괴 원칙의 명시적 예외 경계).

## 작업

### A. `contract/cases/default/users.contract.js`

1. **인가**: `GET /api/users` 미인증 → 401. `POST`/`PUT` 미인증 → 401, **R 세션** → 403(사유 토큰 실측). 
2. **투영**: R 세션으로 `GET` → items 원소의 키 집합이 **정확히 4개**(`userId,name,department,departmentCode`)인지 단언(추가 키 1개라도 있으면 실패). Z 세션으로 `GET` → 키 집합에 `role`·`active`가 있고 **`password`가 없다**. 응답 전체 문자열에 `$2a$`/`$2b$`(bcrypt 해시 접두사)가 없는지도 확인한다.
3. **생성**: Z 세션으로 고유 `userId`(예: `ct-<unique>`) 사용자 생성 → 200 · 응답 shape 실측 · 응답에 `password` 부재. 이어서 `GET /api/users`(Z)에서 그 사용자가 보이고 필드가 요청대로인지 확인.
4. **중복 생성**: 같은 userId로 재생성 → 실측 상태/토큰(400·409 중 무엇인지 확인해 명세에 기록).
5. **검증 실패**: 필수 필드 누락·잘못된 role 값 → 실측 상태/토큰.
6. **수정**: 3에서 만든 사용자의 부서/이름을 `PUT`으로 변경 → 200 · 되읽어 반영 확인 · 응답에 `password` 부재. 비밀번호 변경 요청 시 응답에 평문/해시가 실리지 않는지 확인.
7. **비활성화**: 3에서 만든 사용자를 `active:'N'`으로 수정 → 200 · 되읽어 반영. (**시드 계정에는 절대 하지 마라** — 금지사항 참조.)
8. **없는 사용자 수정** → 실측 상태/토큰.

### B. `contract/cases/default/receiver-config.contract.js`

1. **인가**: 3 라우트 × (미인증 401 · R 세션 403) 전수.
2. **생성**: Z로 고유 `sourceId`(`ct-src-<unique>`) 설정 생성(type `FTP` 1건, `API` 1건) → 200 · 응답 shape 실측 · **비밀번호/apiKey가 응답에 실리는지 실측**하고 결과를 명세에 명시(실린다면 그 사실이 계약이자 잠재 위험 — 요약과 forward_notes에 기록하되 서버는 고치지 마라).
3. **목록**: Z로 `GET` → 자기가 만든 설정이 보인다(절대 개수 단언 금지). 쿼리 파라미터가 있는지 실측(라우트가 `req.query`를 그대로 넘긴다 — 서비스가 무엇을 받는지 확인).
4. **삭제**: 자기가 만든 설정 id로 `DELETE` → 200 · 되읽어 목록에서 사라짐. 같은 id로 재삭제 → 실측(멱등인지 404인지).
5. **잘못된 id**: 숫자가 아닌 id(`/api/receiver-config/abc`) → 실측 상태(라우트가 `Number()`로 NaN을 만든다 — 그 결과가 계약이다).
6. **DB 비파괴 경계**: 삭제 대상 설정과 같은 `sourceId`로 수집된 기사가 있어도 기사는 남는다 — **이 케이스는 step8(collection)과 결합되므로 여기서는 만들지 않는다**. 대신 명세 description에 그 계약을 서술하고, step8이 실제 케이스를 소유한다는 것을 `notes`에 남긴다.

### C. 명세 반영 `docs/api-contract/openapi.yaml`

- 6 라우트 paths 추가. `GET /api/users`의 **응답 2변형**(Z 전체 / 비-Z 4필드)을 `oneOf` 또는 두 예시로 명확히 표현하고, 판정 기준이 **요청자의 세션 role**임을 description에 명시한다.
- `password`는 어떤 응답에도 없다는 것을 User 스키마 description에 명시한다.
- DELETE의 삭제 범위(설정 행만 · 수집된 기사 불변)를 description에 명시한다.

## Acceptance Criteria

```bash
npm run test:contract -- --profile default --files contract/cases/default/users.contract.js,contract/cases/default/receiver-config.contract.js
npm run test:contract
npm test
npm run lint
node scripts/contract-inventory-check.mjs
git status --porcelain
```

## 검증 절차

1. 예측 먼저: 6 라우트의 기대 상태·토큰·응답 키 집합을 코드에서 읽어 적고 실측과 대조(특히 중복 userId·NaN id·재삭제 3건은 예측이 빗나가기 쉽다).
2. **비밀 누출 검사**: users 응답과 receiver-config 응답 전체를 문자열로 훑어 bcrypt 해시 접두사·`password` 키·`apiKey` 원문이 있는지 확인하고 결과를 요약에 남긴다(있다면 **서버를 고치지 말고** 기록만).
3. **vacuity 변이 2종**(각각 원복): (a) A-2의 4필드 단언을 3필드로 바꿔 red 확인 (b) B-1의 R 세션 기대를 200으로 바꿔 red 확인.
4. 결정성: 파일을 연속 2회 실행해 둘 다 green(고유 id 생성으로 중복 충돌이 없어야 한다).
5. AC 전부 실행 · 리포트 누출 재확인.
6. `git status --porcelain` 증분 = `contract/cases/default/users.contract.js` · `contract/cases/default/receiver-config.contract.js` · `docs/api-contract/openapi.yaml` · `phases/67-port-p1-contract/index.json`.
7. 아키텍처 체크: 서버 코드 무수정 · `npm test` 1327 유지.
8. index.json step7 status·summary 갱신.

## 금지사항

- **시드 계정(reporter·desk·admin)을 수정하지 마라** — 특히 `active:'N'`·role 변경·비밀번호 변경 금지. 이유: 러너가 그 세 계정으로 세션을 만든다. 비활성화하면 그 순간부터 **모든 프로파일의 모든 케이스가 401로 무너지고**, 원인이 이 파일에 있다는 것을 알아내기 매우 어렵다.
- 자기가 만들지 않은 `ReceiverConfig` 행을 삭제하지 마라. 이유: 이 라우트는 시스템의 유일한 DELETE다 — 대상 서버(68+)에 실제 운영 설정이 있을 수 있고, DB 비파괴 원칙은 계약 스위트에도 적용된다.
- 사용자 픽스처의 `userId`를 짧고 흔한 문자열로 만들지 마라(`test`·`admin2` 등). 이유: 대상 서버의 기존 계정과 충돌하면 그 계정이 수정될 수 있다 — `ct-` 접두사 + 고유 토큰을 쓴다.
- 비밀번호·apiKey 값을 리포트나 요약에 원문으로 남기지 마라. 이유: LOGS.md 마스킹 규율(응답에 실렸다면 "실렸다는 사실"만 기록).
- 사용자 생성 뒤 그 계정으로 로그인하지 마라. 이유: 로그인 예산(15분/10회)을 소진해 뒤의 케이스를 429로 무너뜨린다.
- 응답에 비밀번호가 실리는 결함을 발견해도 서버를 고치지 마라. 이유: 이 phase는 계약 동결이며 코드 수정은 별도 phase의 판단이다(발견은 forward_notes로 넘긴다).
