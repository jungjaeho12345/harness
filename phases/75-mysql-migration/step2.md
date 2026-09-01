# Step 2: adr-and-migrator-baseline

**ADR-016을 신설**하고(근거는 step1의 실측), **독립 Maven 모듈 `tools/news-migrator/`** 를 세우고, **Flyway 기반선(V1 baseline)** 과 **파괴적 SQL 정적 게이트**를 건다. 행 복사는 이 step이 하지 않는다(step3).

## 읽어야 할 파일

- `phases/75-mysql-migration/index.json` · `step1.md`와 step1이 남긴 summary
- `docs/db-mysql-mapping.md` (**step1 산출물 — 이 step의 입력 정본**)
- `docs/ADR.md` 전문 (특히 ADR-002 · ADR-013 · ADR-014 10행의 「소급 수정은 이력을 오염시킨다」 · ADR-015)
- `docs/porting-plan-cpp-spring.md` §3-② · §7 P2 행 · §8
- `src/db/schema.js` (스키마 정본)
- `server-spring/src/test/java/harness/news/db/NoSchemaSqlInMainSourcesTest.java` (**승계 대상 선례** — 특히 `inlineTableConstants` 펼치기와 자기검사 테스트들)
- `server-spring/src/test/java/harness/news/service/Adr008DisciplineTest.java` (예외 목록의 **크기·구성**을 단언하는 규율의 선례)
- `server-spring/pom.xml` · `server-spring/mvnw` · `server-spring/.mvn/`
- `server-spring/src/test/java/harness/news/testsupport/EphemeralMysqlDb.java` (step1 산출물)

## 배경 (동결된 사실)

1. **`NoSchemaSqlInMainSourcesTest.FORBIDDEN`은 `flyway`·`liquibase`·`ddl-auto` 철자를 `server-spring/src/main/java`와 `src/main/resources` 양쪽에서 금지한다**(실측 · 파일 44~53행). 그래서 **Flyway를 `server-spring`에 넣을 수 없다.** 이 제약은 완화 대상이 아니라 **설계 입력**이다: Flyway는 별도 모듈이 소유하고, `server-spring`은 ADR-013 ②의 「DDL 0 · 부팅 시 존재만 읽기 검증」을 그대로 유지한다. ⇒ **이 phase는 `NoSchemaSqlInMainSourcesTest`를 0줄 고친다.**
2. **ADR은 소급 수정하지 않는다**(ADR-014 10행이 명문화한 규율). ADR-013 ②의 「스키마 소유자는 P2까지 Node다」는 **그 시점의 사실 기록**이므로 지우지 말고, ADR-016이 **그 이양 시점이 지금임을 선언**한다. 73이 ADR-005를 오인용해 revise를 받은 전례가 있다 — **근거 없는 ADR 인용 금지.**
3. **`server-spring`은 독립 Maven 프로젝트**(멀티모듈 reactor 아님)이고 `scripts/spring-contract.mjs`가 그 `target/*.jar` 경로에 의존한다. **reactor로 바꾸지 마라** — 산출물 경로가 움직여 하네스가 깨진다.
4. Maven 로컬 캐시에 Flyway가 없다(step0 실측) — 네트워크 필요.

## 작업

### A. ADR-016 신설 — `docs/ADR.md`에 **순수 추가**(삭제 0행)

제목 예: `ADR-016: 저장소는 MySQL 8.0 — 이관은 읽기 전용 소스·별도 마이그레이터 모듈이 소유하고 Flyway 기반선은 server-spring 밖에 둔다`

결정 문단에 **최소 8항**을 박는다(각 항은 step1의 측정값을 근거로 인용한다):
1. **DB는 MySQL 8.0**(사용자 결정). 계획서 §3-②의 MariaDB 권장안·§10 열린 질문 1의 DB 축이 이것으로 닫힌다.
2. **Node 서버(`server/**`·`src/**`)는 SQLite `news.db`를 계속 쓴다** — 무수정 정본이다. 즉 이 phase 이후 **Node=SQLite / Spring=MySQL 병존이 정상 상태**이고, ADR-013 트레이드오프의 「두 서버가 같은 `news.db`를 동시에 여는 상황」은 **이 결정으로 소멸한다**(대신 두 저장소가 서로 다른 데이터를 갖는 새 위험이 생긴다 — 전환기 규율은 step8 런북이 소유한다).
3. **스키마 소유자 이양**: MySQL 측 스키마의 정본은 **`tools/news-migrator`의 Flyway 마이그레이션**이다. SQLite 측 정본은 여전히 `src/db/schema.js`다. 두 정본의 동형성은 step3의 전 행 대조와 step7의 계약 패리티가 판정한다.
4. **`server-spring`은 여전히 DDL을 한 줄도 실행하지 않는다.** Flyway·`ddl-auto`·`schema.sql`은 그 모듈에 들어가지 않으며 `NoSchemaSqlInMainSourcesTest`는 무변이다.
5. **collation·타입 매핑 확정값**(step1 표에서 인용 — 근거 한 줄씩).
6. **커넥션 풀은 1을 유지한다.** SQLite 단일 writer라는 원래 근거는 사라지지만, 늘리는 것은 **동시성 동작을 바꾸는 별개 결정**이고 74 ⑤가 폐색한 락 순서 결함의 방어선(`LogsStreamWireTest` 항목 22 = 실제 Hikari 상한 1로 순환 대기를 세우는 테스트)이 그 상수에 걸려 있다. 확대는 P3 소유.
7. **최소 권한이 DB 비파괴의 1차 방어선이다**: 런타임 계정에 `DELETE`·`DROP`을 주지 않는다(step0 부트스트랩). 정적 스캔은 2차다.
8. **`mvnw verify`가 MySQL 서버를 요구하게 된다**(step1 `MysqlConfiguredGuardTest`의 fail-closed 선택). 트레이드오프 문단에 그 대가(오프라인 개발 불가)와 대안(skip 허용)을 적고, 이 선택의 이유가 「71a 12/12·72 11/11·73 8/10·74 2건이 전부 green이었던 공허한 게이트의 재발 방지」임을 밝힌다.

트레이드오프 문단에는 **step1이 「완전 일치 불가」로 판정한 축 전부**를 옮겨 적는다.

### B. 모듈 골격 — `tools/news-migrator/`

- `pom.xml` — groupId `harness`, artifactId `news-migrator`, Java **25**, 실행 가능 jar(shade 또는 spring-boot-maven-plugin 없이 `maven-jar-plugin`+의존성 포함 방식 중 택1 — **판단 근거를 주석으로 남겨라**). 의존성: `org.xerial:sqlite-jdbc`(로컬 캐시에 3.47.2.0 존재) · `com.mysql:mysql-connector-j` · `org.flywaydb:flyway-core` + `flyway-mysql` · JUnit 5. **Spring을 넣지 마라**(이 도구는 컨테이너가 필요 없다).
- `server-spring/mvnw`·`mvnw.cmd`·`.mvn/`을 복사해 같은 래퍼로 빌드되게 한다(시스템 java가 1.8이라 `JAVA_HOME` 필수).
- `.gitignore`에 `tools/news-migrator/target/` 추가.
- **CLI 계약**(구현은 이 step에서 골격만, 나머지는 후속 step):
  - `migrate --source <sqlite-file> --target <env-key-set>` (step3)
  - `verify --source <sqlite-file> --target <env-key-set>` (step3)
  - `export --target <env-key-set> --out <sqlite-file>` (step4)
  - `ephemeral-create --name <harness_ct_xxxx>` / `ephemeral-drop --name <...>` (step7이 쓴다)
  - **접속 비밀번호는 오직 환경변수에서만 읽는다**(argv 금지 — 프로세스 목록 노출). URL·사용자명도 환경변수 기본, argv로는 **키 이름만** 넘긴다.
  - 종료코드: 0=성공, 그 외=실패. 실패는 **조용히 0을 내지 않는다**.

### C. Flyway 기반선 — `tools/news-migrator/src/main/resources/db/migration/V1__baseline.sql`

- `src/db/schema.js`의 7테이블 · 컬럼 **순서까지 동일**하게, step1 매핑표의 타입·collation으로 작성한다.
- `CREATE TABLE IF NOT EXISTS` + 명시 `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE <확정값>`.
- **DEFAULT 값 3개를 정본대로 옮긴다**: `Contents.lockYN DEFAULT 'N'` · `User.active DEFAULT 'Y'` · `User.failedLoginCount DEFAULT '0'` · `ReceiverConfig.active DEFAULT 'Y'` · `DistributionTarget.active DEFAULT 'Y'`(실측: sqlite_master DDL과 대조해 개수·값을 확인하라).
- **보조 인덱스·FK를 만들지 마라**(정본이 `PK 자동 인덱스만 사용`이다).
- `lower_case_table_names=1` 환경이므로 테이블 이름 표기 규약을 정하고(정본 표기 `User`·`ArticleHistory` 유지 권장) 그 선택이 `SchemaGuard`·리포지토리 SQL에서 성립함을 step1 측정 10으로 확인한 값과 함께 주석으로 남겨라.

### D. 정적 게이트 — `MigratorHasNoDestructiveSqlTest`

`tools/news-migrator/src/test/java/.../MigratorHasNoDestructiveSqlTest.java`. `NoSchemaSqlInMainSourcesTest`의 설계를 **승계**한다(복제가 아니라 같은 규율의 재적용 — 두 모듈이 서로의 소스를 못 보므로 물리적 공유는 불가하고, 그 사실을 주석에 적어라).

- 금지: `DELETE FROM` · `DROP TABLE|INDEX|VIEW|TRIGGER|COLUMN|DATABASE|SCHEMA` · `TRUNCATE` · `REPLACE INTO` · `INSERT OR REPLACE` · `UPDATE` (마이그레이터는 **삽입만** 한다).
- 스캔 대상: `src/main/java` **전체** + `src/main/resources` 전체(마이그레이션 SQL 포함).
- **예외는 정확히 1파일**: `ephemeral-drop` 구현 파일 하나. 그 예외 목록의 **크기와 구성(파일 경로)** 자체를 단언한다(`Adr008DisciplineTest`의 규율). 그리고 그 파일 안에서도 드롭 대상 이름이 **`^harness_ct_[0-9a-f]{16}$`** 를 만족할 때만 진행함을 행동 테스트로 잠근다.
- **우회 방어**(71a 12/12·72 11/11·73 8/10·74 2건이 전부 green이었던 실패의 재발 방지): 판정 전에 ① 문자열 이어붙이기(`"delete from" + " Contents"`) 펼치기 ② 테이블 이름 상수 펼치기 ③ 클래스 한정 이름 제거 ④ 대소문자 무시를 적용한다. **그리고 그 펼치기가 실제로 동작함을 자기검사 테스트로 단언한다**(선례: `theDeleteScanSeesThroughConcatenationAndStillAllowsTheReceiverConfigException`).

### E. 단일 출처 수렴

step1의 `EphemeralMysqlDb`가 **C의 baseline SQL 파일을 읽어** 스키마를 세우도록 바꾼다(인라인 DDL 제거). 경로가 깨지면 red가 되게 하고, 파일을 못 찾으면 **조용히 건너뛰지 말고 던져라**.

## Acceptance Criteria

```bash
# 마이그레이터 모듈
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
# server-spring 무회귀 (E의 변경이 테스트 트리에만 있다)
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
# 계약 무회귀
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
# ADR 순수 추가 확인 (삭제 행 0이어야 한다)
git diff -U0 -- docs/ADR.md | grep -c '^-[^-]'
# server-spring main 무접촉
git diff --stat -- server-spring/src/main
```

**종료 조건**
- 두 모듈 모두 BUILD SUCCESS · Failures/Errors/**Skipped 0**.
- `--parity` exit 0 · diffs 0 · 관측 수 step0과 동일.
- `git diff -U0 -- docs/ADR.md | grep -c '^-[^-]'` → **0**(순수 추가) · `### ADR-` 개수 15 → **16**.
- `git diff -- server-spring/src/main`이 비어 있다.
- `NoSchemaSqlInMainSourcesTest.java`가 **0줄** 변경됐다.
- **변이 전건 결과표 기록**(아래). 미기록 시 미완.

## 검증 절차

**변이 검증(최소 7종 · 전건 결과표 필수)** — 각각 심어 red를 보고 원복한다.
- M1: 마이그레이터 main에 `sql("DELETE FROM Contents WHERE 1=1")` → red인가.
- M2: 문자열을 끊어 쓴 `"delete from" + " Contents"` → red인가(원문만 보는 정규식은 이것을 **놓친다**는 것이 실측된 우회다).
- M3: 테이블 이름을 상수로 조립한 `"DROP TABLE " + TABLES.CONTENTS` → red인가.
- M4: 리터럴 안 `//` 주석 형태로 감춘 `String s = "-- DROP TABLE User";` → 잡히는가/못 잡는가(**못 잡으면 그 사실을 정직하게 적어라** — 과장 금지).
- M5: 한정 이름(`java.sql.Statement`를 통한 우회 형태 등) → 잡히는가.
- M6: `ephemeral-drop`의 이름 정규식을 `harness_ct.*`로 넓히면 행동 테스트가 red인가. `news`를 넘기면 거부하는가.
- M7: 예외 목록에 파일 하나를 더 넣으면 목록 크기·구성 단언이 red인가.

+ `V1__baseline.sql`의 컬럼 이름·순서·DEFAULT를 `src/db/schema.js`와 **기계로** 대조하는 테스트를 두고(수작업 대조 금지), 컬럼 하나를 빼면 red인지 확인한다.

green 즉시 커밋한다.

## 금지사항

- **`server-spring`에 Flyway·`ddl-auto`·`schema.sql`·`data.sql`을 넣지 마라.** 이유: `NoSchemaSqlInMainSourcesTest`가 main 소스·리소스에서 그 철자를 금지하고, 그 게이트를 완화하는 것은 이 phase의 목적(비파괴 보장 강화)과 정반대다.
- **`NoSchemaSqlInMainSourcesTest`·`Adr008DisciplineTest`를 고치지 마라.** 이유: 게이트 확장·완화는 그 자체가 아키텍처 결정이며 별도 ADR·리뷰가 필요하다(74 forward_notes (3)(9)).
- **`server-spring`을 멀티모듈 reactor로 바꾸지 마라.** 이유: `scripts/spring-contract.mjs`가 jar 경로에 의존한다.
- **마이그레이터에 `UPDATE`를 넣지 마라.** 이유: 이관은 삽입만으로 완결돼야 한다. UPDATE가 있으면 「부분 실패 후 덮어쓰기」 경로가 생기고 멱등성 판정이 흐려진다.
- **ADR-013·ADR-002를 수정하지 마라.** 이유: ADR은 그 시점의 결정 기록이고 소급 수정은 이력을 오염시킨다(ADR-014가 명문화한 규율).
