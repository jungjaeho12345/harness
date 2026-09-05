# Step 5: dialect-seam

`server-spring`에서 **SQLite 전용 표면을 한 파일로 모은다**. 이 step은 **동작을 하나도 바꾸지 않는다** — 기본 방언은 SQLite 그대로이고, 계약 **313관측 diffs 0 무회귀가 곧 AC**다. MySQL 기동은 step6이다.

## 읽어야 할 파일

- `phases/75-mysql-migration/index.json` · `step1.md`와 step1 summary · `docs/db-mysql-mapping.md`
- `server-spring/src/main/java/harness/news/db/` 4파일 전부(`DbConfig` 64행 · `NewsDataSource` 93행 · `RequiredSchema` 144행 · `SchemaGuard` 80행)
- `server-spring/src/test/java/harness/news/db/` 4파일 전부(`DbBootGuardTest` · `NewsDataSourceTest` · `NoSchemaSqlInMainSourcesTest` · `SchemaGuardTest`)
- `server-spring/src/main/java/harness/news/model/DistributionTargetRepository.java` 100~175행 · `ReceiverConfigRepository.java` 95~165행 · `PhotoRepository.java` 60~95행 · `ArticleHistoryRepository.java` 130~200행
- `server-spring/src/main/java/harness/news/config/AppProperties.java`
- `server-spring/README.md` (설정키 ↔ 환경변수 대응표)

## 배경 (동결된 사실 — 실측 목록. 이것이 작업 목록의 전부다)

`server-spring/src/main` 전체에서 SQLite에 묶인 자리는 **정확히 5곳**이다(2026-09-01 실측):
1. `NewsDataSource.java` 60~61행 — `setDriverClassName("org.sqlite.JDBC")` · `setJdbcUrl("jdbc:sqlite:" + db)`
2. `NewsDataSource.java` 63행 + 82~97행 — `PRAGMA busy_timeout` 설정과 read-back 검증
3. `SchemaGuard.java` 70행 — `SELECT name FROM pragma_table_info(?)`
4. `DistributionTargetRepository.java` 172행 — `SELECT last_insert_rowid()`
5. `ReceiverConfigRepository.java` 160행 — `SELECT last_insert_rowid()`

추가로 `ArticleHistoryRepository.java` 198행의 `length(markupVersion) > 0`은 **양쪽에서 성립**하지만 의미(문자 vs 바이트)가 다르다 — step1 측정 9의 결론을 주석으로 남겨라.

그리고 **`PhotoRepository`·`ArticleHistoryRepository`는 이미 `GeneratedKeyHolder`를 쓴다**(실측). 즉 4·5는 **이미 있는 패턴으로 수렴**시키는 작업이고 새 발명이 아니다.

## 작업 (TDD — 각 항목 테스트 먼저)

### A. 방언 설정 주입 — 명시 주입, 런타임 탐지 금지

- `app.db.kind` = `sqlite`(기본) | `mysql`. `application.properties`에 `${DB_KIND:sqlite}` 형태로 추가하고 `AppProperties`(또는 신설 `DbProperties`)에 바인딩한다.
- `mysql`이면 `app.db.url`·`app.db.username`·`app.db.password`(환경변수 `NEWS_DB_URL`·`NEWS_DB_USERNAME`·`NEWS_DB_PASSWORD`)가 **전부 비어 있지 않아야** 하고, 하나라도 비면 **기동 실패**(무엇이 없는지 지목). `sqlite`면 그 3키는 무시하고 지금처럼 `<data-dir>/news.db`를 연다.
- **URL을 보고 방언을 추론하지 마라**(포팅 불변식 7 「런타임 탐지보다 명시 주입」). 값이 서로 모순되면(`kind=sqlite`인데 `url`이 mysql) **기동을 거부**한다.
- `app.data-dir`은 **여전히 필수**다 — 업로드 루트(`uploadsDirPath`)가 그 값에서 나온다. mysql 모드에서도 그대로다.
- **`application.properties`에 `flyway`·`ddl-auto`·`schema.sql`·`liquibase` 철자를 넣지 마라**(`NoSchemaSqlInMainSourcesTest.mainResourcesDeclareNoAutomaticMigration`이 리소스 트리를 스캔한다).

### B. `NewsDataSource` — 유일한 방언 지점

- sqlite 분기는 **지금 동작 그대로**(파일 없으면 만들지 않고 실패 · `busy_timeout` 설정 후 read-back 검증 · 풀 1).
- mysql 분기는 이 step에서 **배선만** 만들고(드라이버·URL·풀 1·접속 파라미터는 step1 측정 11의 확정 집합), **기동 검증은 step6**이 붙인다. 이 step에서 mysql 분기가 실제로 뜨는지까지 볼 필요는 없다 — 다만 **분기 선택 로직 자체는 테스트로 잠근다**.
- `MAX_POOL_SIZE = 1`을 **유지**한다(ADR-016 결정 6 — 확대는 P3).

### C. `SchemaGuard` — 방언 중립화

- `pragma_table_info` 대신 **JDBC `DatabaseMetaData`**(`getTables`/`getColumns`)로 컬럼 목록을 읽는다. 양쪽 방언에서 같은 코드가 돈다.
- 비교는 지금처럼 **소문자 정규화**로 한다(`lower_case_table_names=1` 실측과 정합).
- 기존 드리프트 픽스처 6종(`db/*-drift.sql`)이 **그대로 red를 만드는지**가 이 변경의 무회귀 판정이다 — `SchemaGuardTest` 297행이 그 계약을 이미 갖고 있다.
- 실패 메시지의 문구·지목 방식(무엇이 없는지)을 바꾸지 마라(테스트가 그것을 본다).

### D. `last_insert_rowid()` 2곳 → `GeneratedKeyHolder`

- `DistributionTargetRepository` 172행 · `ReceiverConfigRepository` 160행을 같은 문장에서 키를 회수하는 방식으로 바꾼다(이미 `PhotoRepository`·`ArticleHistoryRepository`가 쓰는 패턴).
- 두 파일의 javadoc에 적힌 **「삽입과 id 판독은 한 트랜잭션이다」(2026-08-24 리뷰 med)** 근거는 여전히 유효한지 재판정하고, 유효하면 트랜잭션 경계를 유지한 채 바꾼다. **javadoc과 코드가 어긋나게 두지 마라.**

### E. 정적 잠금 — 방언 철자의 단일 지점

새 테스트: `server-spring/src/main` 전체에서 `jdbc:sqlite`·`org.sqlite`·`PRAGMA`·`pragma_`·`last_insert_rowid`·`jdbc:mysql`·`com.mysql` 철자가 **`NewsDataSource.java`(및 설정 클래스) 밖에 0건**임을 단언한다. 예외 목록은 **파일 집합**으로 단언한다(개수만 세지 마라 — 74 forward_notes (4)의 교훈: 개수 단언은 파일이 바뀌어도 green이다).

## Acceptance Criteria

```bash
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests   # 하네스가 쓸 최신 jar
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --dual-run
git diff --stat -- server-spring/src/test/java/harness/news/db/NoSchemaSqlInMainSourcesTest.java
```

**종료 조건**
- `clean verify` BUILD SUCCESS · Failures/Errors/**Skipped 0** · `Tests run`이 step1 대비 증가(감소 0).
- **`--parity` 313관측 diffs 0**(default 246 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3) — **관측 수가 하나도 줄지 않았다**. `--dual-run`도 313관측 diffs 0.
- `NoSchemaSqlInMainSourcesTest.java` **0줄 변경**.
- 무접촉 목록(`contract/**`·`docs/api-contract/**`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`server/**`·`src/**`·`web/**`·`client/**`·`test/**`·`package.json`·`news.db`·`uploads/`) diff 0.
- **변이 전건 결과표 기록.** 미기록 시 미완.

## 검증 절차

**변이 검증(최소 6종)**
- M1: `app.db.kind=mysql`인데 url을 비우고 기동 → **기동 실패**인가(조용히 sqlite로 폴백하면 red여야 한다).
- M2: `kind=sqlite` + mysql url(모순) → 기동 거부인가.
- M3: `SchemaGuard`가 존재하지 않는 컬럼을 못 잡도록 비교를 느슨하게 하면 드리프트 픽스처 6종이 red인가(전부? 몇 개?).
- M4: D의 키 회수를 **삽입과 다른 트랜잭션**으로 옮기면 어떤 테스트가 red인가 — red가 없으면 그 축은 무방비이고 테스트를 보강하라.
- M5: E의 예외 목록에 파일을 하나 더 넣으면 집합 단언이 red인가. `NewsDataSource` 밖에 `jdbc:sqlite` 문자열을 심으면 red인가.
- M6: `MAX_POOL_SIZE`를 2로 바꾸면 어떤 테스트가 red인가 — **`LogsStreamWireTest` 항목 22(74 ⑤ 폐색)** 가 그 상수에 의존한다. red가 아니면 그 방어선이 상수와 연결돼 있지 않다는 뜻이니 사실대로 기록하라.

green 즉시 커밋한다.

## 금지사항

- **이 step에서 동작을 바꾸지 마라.** 이유: 313관측 무회귀가 유일한 판정 수단이다. 기능 변경과 리팩터가 섞이면 diff가 나왔을 때 원인 격리가 불가능하다.
- **`RequiredSchema`의 목록·순서를 고치지 마라.** 이유: 그 목록이 곧 응답 키 집합이고(`Article` 5키·`Photo` 6키), 순서 드리프트도 계약 위반이다.
- **`NoSchemaSqlInMainSourcesTest`·`Adr008DisciplineTest`·`RoutePolicy`를 고치지 마라.** 이유: 이 설계는 새 라우트·타이머·스레드·DDL을 만들지 않는다. 고쳐야 한다면 설계가 틀린 것이다.
- **`sqlite-jdbc` 의존성을 제거하지 마라.** 이유: sqlite 기본 모드가 롤백 레버이고 1366개 Java 테스트의 기반이다(제거 시점 판단은 P3).
- **`spring-contract.mjs`를 고치지 마라.** 이유: 하네스 변경은 step7 소유다. 여기서 손대면 「무회귀」의 기준이 흔들린다.
