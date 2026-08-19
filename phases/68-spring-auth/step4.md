# Step 4: admin-routes

사용자 관리 3라우트 + 세션 가드가 소비하는 Z 전용 라우트 하나를 만든다. 역할별 응답 투영과 Z 게이트를 계약대로 잠근다. 이로써 session-guard 계약(강등/비활성 재도출)이 실제 라우트 위에서 실증된다.

## 읽어야 할 파일

- 이전 step 산출물 전부(`server-spring/**`) — `SessionStore.resolve`(재도출 신원), `findUser`/`insertUser`/`updateUser`/`listUsers`, reason→status 매핑·DTO 투영 헬퍼(step3).
- `/home/user/harness/contract/cases/default/users.contract.js` — **사용자 관리 계약**:
  - GET /api/users: Z → SAFE_FIELDS **6키**(userId,name,role,department,departmentCode,active) 전체 명단 · 비-Z(R) → **정확 4키**(userId,name,department,departmentCode — role·active 미노출) · 미인증 401.
  - POST /api/users: Z 전용(미인증 401 · 비-Z 403 이고 **행이 생기지 않음**) · 성공 200 `{ok:true,user:sanitize(row)}`(sanitize는 **undefined 필드를 뺀다**) · active 미지정 시 기본 'Y' · 검증 없음(정의 밖 role·필드 누락도 200) · **중복 userId → 500 `{ok:false,reason:'internal-error'}`**(400/409 아님) · 응답에 password/해시 없음.
  - PUT /api/users/:id: Z 전용(미인증 401 · 비-Z 403 이고 값 불변) · 성공 200 `{ok:true,changes:1}`(user 객체 미반환) · 비밀번호 오면 해시 저장·응답에 평문/해시 없음 · **없는 userId도 200 `{ok:true,changes:0}`**(404 아님) · active='N' 비활성화 200이고 **행은 남는다**(명단에 active='N'으로 존재).
- `/home/user/harness/contract/cases/default/session-guard.contract.js` — **Z 전용 라우트로 `GET /api/logs/digest`를 사용**한다: 갓 로그인한 Z는 200 `{ok:true,...}` · role을 PUT으로 R 강등 후 같은 토큰은 403 `{ok:false,reason:'forbidden'}`(재도출) · active='N' 후 401. 즉 이 phase는 logs-digest의 **Z 게이트만** 필요하다(24h 다이제스트 본문 semantics는 후속 phase 범위).
- `/home/user/harness/src/services/userService.js` — `sanitize`(SAFE_FIELDS, undefined 제외) · create(password 해시·기본 active='Y'·검증 없음) · update(password 오면 해시·changes 반환).
- `/home/user/harness/docs/api-contract/reason-tokens.md` — `forbidden`→403(Z 게이트) · `unauthenticated`→401 · `internal-error`→500(중복 키 등 미처리 예외).

## 작업

`AdminController`(또는 `UsersController` + `LogsController`)를 추가한다. 모든 판정 기준은 **세션 role**(step2 재도출)이다.

- `GET /api/users`: 세션 필수(미인증 401). Z → `listUsers`를 SAFE_FIELDS 6키로 · 비-Z → **정확 4키 투영**(userId,name,department,departmentCode). 역할별 투영은 요청자 세션 role로 분기(클라 body/헤더 role 불신).
- `POST /api/users`: **Z 전용**(미인증 401 `unauthenticated` · 비-Z 403 `forbidden`, 게이트에서 막혀 **모델 호출 없이** 거부). 성공: `UserService.create`(password BCrypt 해시·기본 active='Y'·검증 없음) → 200 `{ok:true, user:sanitize(row)}`(undefined 필드 제외). 중복 userId는 repository 예외를 잡지 말고 전역 에러 핸들러로 흘려 **500 `{ok:false,reason:'internal-error'}`**. 응답에 password/해시 절대 없음.
- `PUT /api/users/:id`: **Z 전용**(미인증 401 · 비-Z 403, 값 불변). `UserService.update`(password 오면 해시) → 200 `{ok:true, changes:<n>}`. 없는 userId면 `changes:0`(404 아님). active='N' UPDATE는 행 유지(soft delete).
- `GET /api/logs/digest`: **Z 전용**(미인증 401 `unauthenticated` · 비-Z 403 `forbidden`). Z면 200 `{ok:true, entries:[]}` 형태의 **최소 응답**으로 충분하다 — 이 phase는 Z 게이트만 계약에 걸린다(24h 링버퍼 다이제스트 본문은 후속 phase). 이 축소를 `summary`/코드 주석에 명시하라(false-green 방지 — Z 게이트는 진짜, 본문은 스텁).
- **전역 에러 핸들러**(`@ControllerAdvice`): 미처리 예외 → 500 `{ok:false,reason:'internal-error'}`(JSON). 중복 키 500 경로가 여기로 흐른다. 스택/원문을 응답에 싣지 않는다.

핵심 규칙: Z 게이트는 **재도출된 세션 role**로 판정한다(강등이 즉시 반영돼야 session-guard가 green). 투영/게이트는 step3의 DTO·매핑 헬퍼를 재사용(중복 shape 로직 금지).

### 테스트(TDD, 먼저 작성)

MockMvc로 임시 시드 DB 위에서: Z 6키·비-Z 4키 투영(추가 키 0)·미인증 401·POST Z 생성/중복 500/검증부재 200/비-Z 403 무행·PUT changes 1|0·비밀번호 무에코·active='N' 행유지·logs-digest Z 200/비-Z 403/미인증 401. 강등 후 logs-digest 403(재도출)까지 커버.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && ./mvnw -q -DskipTests=false test
```

- 사용자 관리 + logs-digest Z 게이트 테스트 전부 green.

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트:
   - 투영이 Z=6키/비-Z=4키로 정확한가(추가 키 0)? 비-Z에 role/active가 새지 않는가?
   - 쓰기 2라우트가 Z 전용이고 비-Z 거부 시 행이 생기/바뀌지 않는가?
   - 중복 userId가 500 internal-error인가(400/409 아님)? 없는 id PUT이 changes:0(404 아님)인가?
   - Z 게이트가 재도출 role로 판정되는가(강등 즉시 403)?
   - password/해시가 응답에 0건인가?
3. 결과 반영: 성공 → `completed` + `summary`(라우트·투영·게이트·logs-digest 축소 명시·테스트 수). 실패 3회 → `error`. 외부 요인 → `blocked`.

## 금지사항

- 클라이언트가 보낸 role/body로 인가를 판정하지 마라. 이유: 신뢰 경계=서버(ADR-004) — 세션 재도출 role만.
- 비-Z 투영에 role/active/잠금 필드를 싣지 마라. 이유: 기자에게 권한/상태 유출은 계약 위반(users.contract 4키 고정).
- 중복 userId를 400/409로 매핑하지 마라. 이유: 계약은 500 internal-error를 동결한다(라우트가 예외를 삼키지 않는다).
- 없는 userId PUT을 404로 만들지 마라. 이유: 계약은 200 changes:0(존재 판정 안 함).
- `active='N'` 대신 행을 DELETE하지 마라. 이유: DB 비파괴(soft delete만).
- logs-digest에 Z 게이트를 빼거나 비-Z에 200을 주지 마라. 이유: session-guard 계약이 이 게이트로 재도출 불변식을 실증한다.
- `server/**`·`src/**`·`web/**`·`contract/**`·`docs/**`를 수정하지 마라. 이유: 기존 npm test 1328 불변.
- 기존 테스트를 깨뜨리지 마라.
