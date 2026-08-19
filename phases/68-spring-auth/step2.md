# Step 2: db-access

기존 `news.db`(SQLite) 스키마를 **그대로 읽고 쓰는** DB 접근층을 만든다. 이 step이 소유하는 것은 DataSource·부팅 스키마 검증·`User` 테이블 리포지토리 하나다. 세션·인증 로직은 다음 step들이 이 위에 올린다.

**MariaDB 이전은 이 phase 범위 밖이다**(계획서 P2). 이 step의 전제는 "스키마는 Node 서버가 소유하고 Spring은 읽고 쓰기만 한다"이다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(3)(4)(5)(11)(13)(14)** · excluded (g)
- `src/models/userModel.js` — **이식 원본**. 컬럼 화이트리스트 10개(`userId, name, password, role, department, departmentCode, active, failedLoginCount, lockedUntil, lastFailedLoginAt`), `findById`/`query`/`insert`/`update`의 SQL 조립 규칙, "삭제 함수는 두지 않는다"
- `src/db/schema.js` — `User` 테이블 정의(첫 컬럼이 PK, TEXT 타입), 멱등·additive 마이그레이션 원칙, 잠금 컬럼 주석(**주석의 'ISO-8601'은 드리프트다 — decisions (11) 참조**)
- `src/services/userService.js` — 잠금 컬럼에 실제로 어떤 값이 들어가는지(문자열 정수 / epoch ms 문자열 / NULL 리셋)
- `src/db/connection.js` — 부트 PRAGMA(`busy_timeout`) 설정 방식
- `docs/SCHEMA.md` — 테이블 정본
- `docs/ADR.md` ADR-002(직접 SQL·ORM 회피) · ADR-006(계층)
- `spikes/p0-spring/src/main/java/harness/p0_spring/NewsDb.java` — sqlite-jdbc 사용 예(**참고만**. 스파이크는 읽기 전용 + `SELECT *`라 그대로 쓰면 안 된다)
- `server-spring/README.md`(step0) — 설정 키 ↔ 환경변수 표

## 배경

- **DB 비파괴는 이 phase의 절대 규칙이다.** Spring은 DDL을 실행하지 않는다: 스키마 생성·변경은 P2까지 Node 서버(`createSchema`)가 소유한다. 이 서버는 "없으면 만든다"가 아니라 **"없으면 뜨지 않는다"**로 동작한다.
- 계약 하네스(step1)는 임시 DATA_DIR을 `createSchema`+`seedUsers`로 시드해 Spring에 물린다. 그래서 스키마는 항상 Node가 만든 것이다.
- Java 단위 테스트는 그 Node 코드를 부를 수 없으므로 **테스트 리소스에만 존재하는 DDL 픽스처**로 임시 DB를 만든다(decisions (5)). 이 이중 경로가 어긋나면 **Java 테스트는 green인데 계약 실행이 red**가 된다 — 그 조합을 보면 픽스처 드리프트를 먼저 의심하라.
- SQLite는 단일 파일이고 동시 쓰기에서 `SQLITE_BUSY`를 낸다. Node 서버는 단일 연결·동기 실행이라 이 문제가 없었다. Spring은 멀티스레드이므로 **커넥션 풀 최대 1 + `busy_timeout`**으로 시작한다(decisions (3)).

## 작업

### A. 의존성 결정(실측으로 확정한다 — 추측 금지)

1. `spring-boot-starter-jdbc`(JdbcClient·HikariCP)를 pom에 추가하고 `./mvnw -B dependency:resolve`(또는 `verify`)로 **해석 가능한지 실측**한다.
2. 해석에 성공하면 그 경로로 간다. 네트워크 부재 등으로 실패하면 **폴백**: `org.xerial:sqlite-jdbc`(3.47.2.0 — `~/.m2`에 캐시 존재)의 `SQLiteDataSource` + 얇은 JDBC 헬퍼로 구현하고 starter-jdbc 의존성은 pom에서 제거한다.
3. 어느 경로를 택했는지, 해석에 네트워크가 필요했는지를 **요약에 실측으로 기록**한다(open_questions (e)의 처분).

### B. `db` 패키지 — DataSource와 스키마 검증

- `app.data-dir`(step0에서 정의)을 받아 `<data-dir>/news.db`를 연다. 파일이 없으면 **만들지 말고** 기동 실패시킨다(경로를 메시지에 담되 비밀은 담지 않는다).
- 연결 설정: `busy_timeout`(Node 부트값과 동형)만 적용한다. **`journal_mode`·`synchronous` 등 파일 포맷을 바꾸는 PRAGMA는 금지**(금지사항 참조).
- **부팅 스키마 검증**(읽기 전용): 이 phase가 쓰는 테이블·컬럼의 존재를 확인한다(최소 `User`의 컬럼 10개). 없으면 **무엇이 없는지 명시**하고 기동 실패. 검증에 쓰는 필수 컬럼 목록은 **main 코드의 상수 1곳**에 둔다.
- 커넥션 풀 최대 1(또는 폴백 경로에서는 요청마다 열고 닫기) — 어느 쪽인지 주석에 근거를 남긴다.

### C. `model` 패키지 — `User` 리포지토리

`src/models/userModel.js`와 **1:1** 대응하는 4개 연산만 만든다:

- `findById(userId)` → 행 또는 없음. **컬럼을 명시 나열**한다(`SELECT *` 금지).
- `query(filters)` → 화이트리스트 컬럼만 AND 동등 필터(임의 컬럼명 주입 차단). 화이트리스트 밖 키는 **무시**한다(에러가 아니다 — Node 동형).
- `insert(row)` → 값이 있는 화이트리스트 컬럼만 INSERT. 컬럼이 하나도 없으면 예외.
- `update(userId, patch)` → 값이 있는 화이트리스트 컬럼만 SET, `userId`는 SET 대상에서 제외, **영향 행 수(changes)를 반환**한다(계약이 `{ok:true, changes:n}`을 쓴다). 대상 컬럼이 없으면 0을 반환하고 SQL을 실행하지 않는다.
- 반환 타입은 도메인 레코드/맵 중 하나로 정하되 **DB 행을 그대로 응답으로 흘릴 수 없는 형태**여야 한다(decisions (13) — 투영은 서비스 계층 책임이며 리포지토리는 raw를 준다).
- **삭제 연산을 만들지 마라**(Node도 없다 — 비활성화는 `active='N'` UPDATE).

### D. 테스트(먼저 쓴다)

1. **DDL 픽스처**: `src/test/resources/` 아래에 이 phase가 쓰는 테이블의 `CREATE TABLE IF NOT EXISTS`를 둔다. 파일 머리말에 "**테스트 전용. 정본은 `src/db/schema.js`이며 main 소스에는 DDL이 없다**"를 적는다.
2. `@TempDir` 임시 파일 DB에 픽스처를 적용하고 리포지토리 4연산을 검증한다: 삽입→조회 왕복 · 부분 업데이트가 지정 컬럼만 바꾸고 changes를 정확히 반환 · 없는 id 업데이트는 changes 0 · **화이트리스트 밖 컬럼명이 필터·패치로 들어와도 SQL에 섞이지 않는다**(주입 차단) · 잠금 컬럼에 문자열 정수/epoch ms 문자열/NULL을 왕복 저장했을 때 값이 그대로 읽힌다(decisions (11)).
3. **스키마 검증 테스트**: 컬럼이 빠진 DB로 기동하면 실패하고 메시지가 빠진 컬럼을 지목한다.
4. **정적 잠금 테스트**: main 소스 트리(`src/main/java`)를 읽어 `CREATE TABLE`·`ALTER TABLE`·`DROP`·`DELETE FROM` 정규식 매치가 **0건**임을 단언한다. 이유는 금지사항 참조.

TDD 순서: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs --boot-check --profile auth-negative --profile prod-cookie
cd /d/agents/harness && npm test
cd /d/agents/harness && npm run lint
cd /d/agents/harness && git status --porcelain
```

- 3번째 커맨드가 **여전히 exit 0**이어야 한다: DB 계층이 붙은 뒤에도 하네스가 시드한 임시 DATA_DIR로 정상 기동한다는 실증이다(스키마 검증이 Node 시드 DB를 거부하면 여기서 잡힌다 — 이 phase에서 가장 중요한 조기 경보다).

## 검증 절차

1. red 먼저(D의 테스트 4종). red 관측을 요약에 남긴다.
2. AC 실행. 3번 커맨드는 **연속 2회** green이어야 한다.
3. **DB 무변 실증**: 하네스 실행 전후로 리포 `news.db`의 크기·mtime이 동일한지 확인한다(하네스가 자체 단언하지만 눈으로도 확인해 요약에 수치를 남긴다).
4. **변이 2종**(확인 후 원복): (a) 필수 컬럼 상수에서 `lockedUntil`을 빼면 스키마 검증 테스트가 red가 되는지, (b) `update`가 changes 대신 항상 1을 반환하게 하면 리포지토리 테스트가 red가 되는지(계약이 `changes`를 싣기 때문에 이 축은 뒤 step에서 계약 red로도 나타난다).
5. 의존성 경로(A) 실측 결과를 요약에 기록한다 — `spring-boot-starter-jdbc` 채택 여부, 캐시 히트/네트워크 필요 여부.
6. `git status --porcelain` 증분 = `server-spring/pom.xml` · `server-spring/src/main/**` · `server-spring/src/test/**` · `phases/68-spring-auth/index.json`.
7. index.json step2 status·summary 갱신.

## 금지사항

- `spring.jpa.hibernate.ddl-auto`·`schema.sql`·`data.sql`·Flyway·Liquibase를 쓰지 마라. 이유: 이 서버가 스키마를 만들거나 바꾸는 순간 "스키마 소유자는 Node"라는 전제가 깨지고, 자동 마이그레이션은 **DROP/재생성 경로를 항상 품고 있다** — DB 비파괴 규칙과 정면 충돌한다.
- `journal_mode`(WAL 등)·`synchronous`를 바꾸지 마라. 이유: WAL 전환은 **DB 파일 자체를 변형**하고 `-wal`/`-shm` 파일을 만든다. P3 전환기에 Node 서버가 같은 파일을 여는 상황에서 되돌리기 어려운 변경이다.
- `DELETE`/`DROP` SQL을 쓰지 마라(잠금 리셋도 UPDATE로 한다). 이유: 최상위 규칙(DB에 있는 내용은 절대 삭제하지 않는다)이며, D-4의 정적 잠금 테스트가 이를 기계로 지킨다.
- `SELECT *`를 쓰지 마라. 이유: 컬럼이 늘면 응답 투영이 조용히 넓어진다(계약 스위트가 잡지 못하는 유출 경로 — `photos/search`의 실제 사례가 `docs/api-contract/README.md` 결함 후보 #5다).
- 리포 `news.db`를 테스트·수동 확인에서 열지 마라. 이유: 하나의 실수로 되돌릴 수 없다. 테스트는 `@TempDir`만 쓴다.
- 커넥션 풀을 크게 잡거나 트랜잭션 경계를 임의로 넓히지 마라. 이유: SQLite 단일 파일에서 동시 쓰기는 `SQLITE_BUSY`를 만들고, 그 실패는 계약 스위트에서 **간헐적**으로 나타나 flake로 오인된다.
- 세션·인증·HTTP 코드를 이 step에서 쓰지 마라. 이유: 이 step은 DB 계층 하나만 소유한다(다음 두 step이 서비스 계층을 올린다).
