# Step 1: db-access

`server-spring`의 SQLite 데이터 접근 계층을 만든다. 스파이크의 `NewsDb`는 **읽기 전용**이었지만, 이 phase는 사용자 생성/수정·로그인 잠금 카운터 영속이 필요하므로 **읽기·쓰기** 계층이다(단, DDL 없음·행 삭제 없음).

## 읽어야 할 파일

- `/home/user/harness/phases/68-spring-auth/step0.md` 과 이전 step 산출물(`server-spring/**`) — AppConfig의 `app.db-path` 주입, 패키지 base `harness.server`.
- `/home/user/harness/src/db/schema.js` — **User 테이블 컬럼의 단일 진실 공급원**. 컬럼: `userId`(TEXT PK), `name`, `password`, `role`, `department`, `departmentCode`, `active`(기본 'Y'), `failedLoginCount`(기본 '0'), `lockedUntil`, `lastFailedLoginAt`. 전부 TEXT.
- `/home/user/harness/src/db/seed.js` — `SAMPLE_USERS`(reporter/R·desk/D·admin/Z), bcrypt cost 10 해시 저장. 시드는 계약 하네스(step5)가 Node `src/db`로 수행하므로 **Spring은 시드하지 않는다**.
- `/home/user/harness/src/services/userService.js` — `SAFE_FIELDS`(userId·name·role·department·departmentCode·active), `sanitize`, create/update 규칙(비밀번호 해시·반환 제외). Spring이 동형으로 재현할 도메인 규칙의 정본.
- `/home/user/harness/spikes/p0-spring/src/main/java/harness/p0_spring/NewsDb.java` — SQLite JDBC 접근 패턴 참고(단 이 step은 `readOnly=false`).
- `/home/user/harness/docs/ADR.md` (ADR-002 직접 SQL 철학 · ADR-006 계층 분리)

## 작업

`harness.server` 하위에 사용자 데이터 접근 컴포넌트(예: `UserRepository` 또는 `NewsDb`)를 만든다. `app.db-path`로 열되 **읽기·쓰기**로 연다. `busy_timeout`을 5000ms로 설정(동시 쓰기 대비 — 스파이크의 요청당 연결 패턴 유지 가능).

메서드 시그니처(재량이되 계약은 고정):

- `User findUser(String userId)` — `userId` PK로 1행. 반환 레코드는 로그인/세션 가드에 필요한 필드 전부: `userId,name,role,department,departmentCode,active,password,failedLoginCount,lockedUntil,lastFailedLoginAt`. **`password`는 BCrypt 검증에만 쓰고 어떤 응답에도 싣지 않는다**(레코드에 담되 상위 계층이 절대 직렬화하지 않도록 DTO 분리는 step3/4가 책임).
- `List<Map<String,Object>> listUsers()` — 전 사용자. **SQL은 필요한 컬럼만 SELECT**하되, 역할별 투영(Z=6키 / 비-Z=4키)은 상위(step4)가 결정하므로 여기서는 SAFE_FIELDS 6키(userId·name·role·department·departmentCode·active)까지 읽어 돌려준다. 잠금 필드(failedLoginCount 등)·password는 목록에 **절대 싣지 않는다**.
- `void insertUser(...)` — 신규 사용자 INSERT. `userId` PK 중복이면 JDBC가 예외를 던지게 둔다(상위가 500 internal-error로 매핑 — 계약). `active` 미지정 시 'Y'. password는 해시된 값을 받는다(해싱은 서비스 계층 책임 — 여기서는 저장만).
- `int updateUser(String userId, Map<String,Object> patch)` — 주어진 필드만 UPDATE, 변경 행 수 반환. 없는 userId면 0(존재 판정 안 함 — 계약 `changes:0`). patch에 오는 값(role·active·name·department·departmentCode·password·failedLoginCount·lockedUntil·lastFailedLoginAt)만 SET. **`null` 값은 SQL NULL로 SET**(로그인 성공 시 lockout 리셋이 lockedUntil/lastFailedLoginAt을 NULL로 비운다 — userService.resetLockout 동형).

핵심 규칙(반드시 박기):

- **DDL 금지**: 프로덕션 코드는 `CREATE`/`ALTER`/`DROP`/`DELETE`를 **한 줄도** 실행하지 않는다. 스키마는 계약 하네스(step5)가 Node `src/db/schema.js`로 만든 임시 DB를 연다. (테스트는 예외 — 아래 참조.)
- **행 삭제 금지**: 어떤 경로도 `DELETE`하지 않는다. 비활성화는 `active='N'` UPDATE(soft delete)뿐이다.
- **PreparedStatement만** — 문자열 concat SQL 금지(인젝션·따옴표 파손). 식별자(테이블/컬럼)는 하드코딩 리터럴만.

### 테스트(TDD, 먼저 작성)

Spring 테스트에서 임시 DB 파일을 만들고 User 테이블을 **테스트 전용 DDL**(`CREATE TABLE User(...)` — schema.js 컬럼과 동일)로 세운 뒤:
- `findUser` 왕복(존재/부재 null), `insertUser`→`findUser` 반영, 중복 PK insert 예외, `updateUser`(부분 필드·없는 id는 0·null로 컬럼 비우기), `listUsers`가 잠금 필드·password를 싣지 않음.
테스트 전용 DDL은 `src/test/**`에만 두고 프로덕션 코드에는 두지 않는다.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && ./mvnw -q -DskipTests=false test
```

- 데이터 접근 테스트 전부 green. 프로덕션 소스에 `DELETE`/`DROP`/`CREATE TABLE`/`ALTER` 문자열이 없다(테스트 소스의 셋업 DDL은 허용).

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트:
   - 프로덕션 Java 소스에 DDL/DELETE가 0건인가(`grep -rin "drop\|delete\|create table\|alter table" server-spring/src/main`)?
   - password·잠금 필드가 `listUsers` 결과에 새지 않는가?
   - 연결이 읽기·쓰기이고 `busy_timeout`이 설정됐는가?
3. 결과 반영: 성공 → `completed` + `summary`(컴포넌트명·메서드·테스트 개수). 실패 3회 → `error`. 외부 요인(드라이버 다운로드 실패 등) → `blocked`.

## 금지사항

- 프로덕션 코드에서 DDL/DELETE/DROP을 실행하지 마라. 이유: 스키마는 하네스가 소유하고, 이 서버는 데이터를 파괴하지 않는다(DB 비파괴 최상위 규칙).
- `password`나 잠금 필드(failedLoginCount·lockedUntil·lastFailedLoginAt)를 목록/조회 shape에 싣지 마라. 이유: 계정 열거 단서·자격 유출(userService SAFE_FIELDS 계약).
- 리포 `news.db`를 열지 마라. 이유: DB 비파괴 — 테스트도 임시 파일만 쓴다.
- `server/**`·`src/**`·`web/**`·`contract/**`·`docs/**`를 수정하지 마라. 이유: 기존 npm test 1328 불변.
- 기존 테스트를 깨뜨리지 마라.
