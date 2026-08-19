# Step 5: guard-support-endpoints

## 목표
`session-guard.contract.js`가 재도출(ADR-004)을 실증하기 위해 건드리는 **최소 지원 라우트**만 구현한다: `POST /api/users`(Z), `PUT /api/users/:id`(Z), `GET /api/logs/digest`(Z 게이트), `GET /api/articles`(세션 게이트, 목록). 이 라우트들의 **전체 계약**(users/logs/articles 도메인)은 이 phase 밖이며, 여기서는 session-guard가 관측하는 동작만 Node와 일치시킨다.

## 왜 최소인가
session-guard는 Z 픽스처 계정을 만들고(생성) → 그 세션으로 Z 전용 라우트 통과 확인 → role 강등/비활성(수정) → 재도출로 403/401 확인의 왕복을 한다. 그래서 필요한 것은 "생성·수정·Z 게이트·세션 게이트"뿐이다. 목록 필터·투영 전체는 후속 phase의 users/articles 계약이 잠근다.

## 계약 상세 (실측 — `contract/cases/default/session-guard.contract.js`)
패리티는 관측의 `status·ok·reason·bodyKeys`를 Node와 비교한다. 아래 shape을 정확히 맞춰라.
- `POST /api/users`(Z 전용): 성공 시 `{"ok":true}`(session-guard의 `before()`가 `status===200 && json.ok===true`만 검사, 기록 안 함). 생성된 계정으로 **로그인이 가능해야** 하므로 body의 password를 **bcrypt 해시로 저장**(cost 10). body: `{userId,name,role,department,departmentCode,password}`. acting role은 **세션에서만**(Z) — body role은 신뢰 대상이 아니라 저장 필드일 뿐. 미인증 401, 비-Z 403 `forbidden`.
- `PUT /api/users/:id`(Z 전용): 성공 시 **정확히 `{"ok":true,"changes":1}`**(deepEqual). body `{role:'R'}` 또는 `{active:'N'}` 등 부분 수정. `updateUser` 화이트리스트 경유. 미인증 401, 비-Z 403.
- `GET /api/logs/digest`(Z 전용): Z → 200 `{"ok":true,"items":[...]}` — **top-level 키 정확히 `items`·`ok`**(Node는 `{ ok:true, items: logService.digest() }` 반환). 비-Z(강등된 R) → 403 `{"ok":false,"reason":"forbidden"}`. `items` 내용은 패리티 비교 대상이 아니다(케이스가 값을 기록하지 않음) — 빈 배열/최소 다이제스트로 충분하되 **키는 반드시 `items`·`ok`**.
- `GET /api/articles`(세션 게이트): session-guard는 **죽은 토큰으로 401** `{"ok":false,"reason":"unauthenticated"}`만 관측한다. 정상 목록은 `{ok:true,items:[...]}`로 두되(step2 `listArticles`) 패리티 비교는 401 경로만 걸린다.

## 읽어야 할 파일
- `contract/cases/default/session-guard.contract.js` — 생성·강등·비활성·재도출·무효화 영구성 전 케이스(단언값 정본).
- `docs/api-contract/reason-tokens.md` 표1 #1(`unauthenticated` 401)·#4(`forbidden` 403) — Z 게이트 토큰.
- `server/index.js`의 `/api/logs/digest` 라우트(`{ ok:true, items: logService.digest() }`)·`/api/users`(POST/PUT)·`/api/articles`(목록) — 동작·본문 키 정본.
- `src/services/userService.js` — 사용자 생성/수정 shape·SAFE_FIELDS(응답에 password/잠금 컬럼 제외).
- 이전 step 산출물: `SessionGuard`(step3 재도출), `NewsDb.insertUser/updateUser/listArticles`(step2), 인증 컨트롤러·Z 판정에 쓸 세션 신원(step4).

## 작업 (TDD — 테스트 먼저)
1. **테스트 먼저** MockMvc:
   - `POST /api/users`: Z 세션 → 200 `{ok:true}` + 저장 후 그 계정으로 login 성공(해시 저장 실증). 미인증 401·비-Z 403.
   - `PUT /api/users/:id`: Z 세션 → `{ok:true,changes:1}`(role·active 각각). 비-Z 403·미인증 401.
   - `GET /api/logs/digest`: Z → 200 top-level 키 `items`·`ok`; 비-Z(R) → 403 `forbidden`.
   - `GET /api/articles`: 죽은/미인증 토큰 → 401 `unauthenticated`.
2. 구현: 컨트롤러 4개(또는 도메인별 2~3개 컨트롤러). Z 판정은 `SessionGuard`가 재도출한 신원의 role로만(요청 body 불신). 생성 시 password는 bcrypt 해시. 수정은 `updateUser` 화이트리스트. logs/digest는 최소 다이제스트(키 `items`·`ok` 고정). 계층 규율·생성자 주입 유지.
3. `session-guard.contract.js`가 재도출을 실증하려면 강등/비활성 **직후 같은 토큰**의 다음 요청이 403/401이어야 한다 — step3 가드가 이미 이를 보장하지만, 이 라우트들이 **가드를 실제로 경유**하는지 확인(가드 우회 라우트 금지).

## Acceptance Criteria (실행 커맨드)
```bash
# 0) 빌드/유닛
mvn -f server-spring/pom.xml -q test && mvn -f server-spring/pom.xml -q -DskipTests package
# 1) session-guard 계약이 Spring green + Node와 diff 0
node scripts/contract-run.mjs --target node  --profile default --files contract/cases/default/session-guard.contract.js --out /tmp/n-guard.json --timeout 60000
node scripts/contract-run.mjs --target spring --profile default --files contract/cases/default/session-guard.contract.js --out /tmp/s-guard.json --timeout 60000
node scripts/contract-diff.mjs /tmp/n-guard.json /tmp/s-guard.json
# 2) 정적 안전망 + DB 비파괴
! grep -rniE "DROP |DELETE FROM|TRUNCATE|CREATE TABLE|ALTER TABLE" server-spring/src/main/java
npm run lint
```
- `contract-diff` → `contract-diff-ok` + exit 0. 리포 news.db 무변.

## 검증 절차
- session-guard의 5개 축(강등→403, 신원 DB최신값, 비활성→401, 무효화 영구성, Z 라우트 200)이 전부 green인지 diff 0으로 확인.
- logs/digest 200의 bodyKeys가 `["items","ok"]`로 Node와 동일한지(diff 0) 확인 — 임의 키 추가 금지.
- 생성한 픽스처 계정이 임시 DB에만 들어가고 리포 news.db는 무변인지 확인.

## 금지사항
- users/articles/logs의 **전체 계약**(목록 필터·투영 전 필드·negative 전수)을 여기서 구현하지 마라. 이유: 이 phase는 auth/session 슬라이스다 — 나머지는 후속 phase의 계약이 잠근다. 과구현은 검증되지 않은 표면을 남긴다.
- Z 판정을 요청 body의 role로 하지 마라. 이유: acting role은 세션 재도출에서만(ADR-004).
- 지원 라우트가 `SessionGuard`를 우회하게 만들지 마라. 이유: 강등/비활성 즉시 반영이 깨져 session-guard가 red가 된다.
- logs/digest 응답에 `items`·`ok` 외 top-level 키를 추가하지 마라. 이유: Node와 bodyKeys diff.
- 사용자 생성/수정에 DDL/DELETE를 쓰지 마라. 이유: DB 비파괴.
