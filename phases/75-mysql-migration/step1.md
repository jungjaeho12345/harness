# Step 1: dialect-semantics-probe

SQLite와 MySQL 8.0.46의 **의미론 차이를 전수 실측**하고, 그 측정을 **영구 차등 테스트**로 굳히고, 결과를 매핑표 문서로 확정한다. 이 phase의 모든 후속 결정(타입 매핑·collation·id 생성·접속 파라미터)이 이 step의 측정값에서 나온다. **추측으로 채우지 마라 — 못 재면 「미측정」으로 적어라.**

## 읽어야 할 파일

- `phases/75-mysql-migration/index.json` (`decisions`·`open_questions` 전문)
- `phases/75-mysql-migration/step0.md` 및 step0이 남긴 summary(자격증명·프로브 결과)
- `docs/ops-mysql.md` (step0 산출물 — 환경변수 키 이름)
- `src/db/schema.js` (204행 — **스키마 정본**. SCHEMA 상수 7테이블 · `createSchema`의 멱등 규율)
- `server-spring/src/main/java/harness/news/model/` 전부 — 특히 `ColumnValues.java`(Node `node:sqlite`의 바인딩 의미론 단일 출처) · `ArticleRepository.java` 253~262행(3컬럼 LIKE) · `PhotoRepository.java` 34행·102~115행(무이스케이프 LIKE + `ORDER BY id DESC`) · `ArticleHistoryRepository.java` 141행(`GeneratedKeyHolder`)·162·198·226행 · `DistributionTargetRepository.java` 172행(`SELECT last_insert_rowid()`) · `ReceiverConfigRepository.java` 160행(동일)
- `server-spring/src/main/java/harness/news/db/NewsDataSource.java`·`SchemaGuard.java`
- `server-spring/src/test/java/harness/news/testsupport/TempNewsDb.java`
- `server-spring/src/test/resources/db/user-schema.sql`
- `contract/lib/record.js` 103~127행 (`fromResponse` — **리포트가 무엇을 싣는지**)
- `contract/cases/default/articles-read.contract.js` 237·382·400행 · `contract/cases/default/media-upload.contract.js` 310~345행

## 배경 (동결된 사실 — 재조사 불필요)

1. **리포 `news.db` 실측(2026-09-01, 읽기 전용 사본에서 측정)**: 7테이블 · **총 178행**(Article 77 · ArticleHistory 12 · Contents 77 · DistributionTarget 0 · Photo 1 · ReceiverConfig 0 · User 11). `typeof()` 집계는 **text/null/integer 3종뿐**(real·blob 0건). `Article.markupVersion` 최대 **165,734자 / 165,802바이트** — **MySQL `VARCHAR`로는 담을 수 없다**(행 크기 상한). `Contents.createdAt`은 77행 전부 상이(현재 데이터에 tie 없음). 빈 문자열과 NULL이 **같은 컬럼에 공존**한다(예: `Contents.embargoAt` = text 67(그중 빈 문자열 52) + null 10 / `secondEmbargoAt` = text 67(전부 빈 문자열) + null 10). `Contents.title` 76/77행, `User.name` 11/11행이 **비ASCII(한글)** 다.
2. **계약이 못 보는 축과 — 정확히 한 군데의 예외**(실측). 리포트 관측은 `status`·`ok`·`reason`·`bodyKeys`·**케이스가 명시한 `values`**·허용 헤더뿐이다(`contract/lib/record.js` 119~126행). 그리고 목록 케이스는 **`idsOf(items).sort()`로 비교**한다(`articles-read.contract.js` 237·382·400행) — 그 파일에서는 **정렬 순서가 단언되지 않는다**. `photos-search`는 랜덤 소문자 토큰만 쓰므로 **LIKE 대소문자는 관측되지 않는다**. `receiver-config` 케이스는 `id` **원값을 리포트에 싣지 않는다**.
   - ⚠ **예외 1건(반드시 이 형태로 인계하라)**: `contract/cases/default/media-upload.contract.js` **342행**이 `assert.deepEqual(mine.map((it) => it.id), [fromHttps.json.id, fromUpload.json.id], '최신 등록 우선(id DESC)')` 로 **`photos-search`의 반환 순서를 직접 단언**한다. 어서션 실패는 러너 비-0 종료 = 패스 실패이므로 **`PhotoRepository`의 `ORDER BY id DESC` 축은 계약이 실제로 잡는다.** ⇒ 「정렬은 계약이 구조적으로 못 본다」는 **그 1건을 제외하고** 참이다. 이것을 뭉뚱그려 적지 마라 — 74 ②가 잡은 거짓 주장(「계약이 잡는다」)의 **거울상 오류**다.
   - ⇒ 유일 방어선이 Java 테스트인 축: **`Article`·`ArticleHistory`·`DistributionTarget`·`ReceiverConfig`의 정렬 · LIKE 대소문자 · id 재사용**. `Photo` 정렬만 계약과 이중 방어다.
3. **SQLite 전용 표면은 main 소스에 정확히 5자리다**(실측): `NewsDataSource` 60~61행(driver·URL) · **64행**(`setConnectionInitSql("PRAGMA busy_timeout ...")`) · `SchemaGuard` 70행(`SELECT name FROM pragma_table_info(?)`) · `DistributionTargetRepository` 172행 · `ReceiverConfigRepository` 160행(둘 다 `SELECT last_insert_rowid()`) · `ArticleHistoryRepository` 198행(`length(markupVersion) > 0`). 이 목록은 step5의 작업 목록이다.
4. **MySQL 서버 실측 설정**(step0 배경 2 참조): `lower_case_table_names=1` · `STRICT_TRANS_TABLES` 포함 sql-mode · 8.0 기본 collation `utf8mb4_0900_ai_ci`.

## 작업

### A. 테스트 지원 — `EphemeralMysqlDb`

`server-spring/src/test/java/harness/news/testsupport/EphemeralMysqlDb.java` (신규).

- `NEWS_CT_MYSQL_URL` / `NEWS_CT_MYSQL_USERNAME` / `NEWS_CT_MYSQL_PASSWORD` **환경변수에서만** 접속 정보를 읽는다(리터럴·기본값 금지).
- `create()` → `harness_ct_<16 hex>` 이름의 DB를 만들고 그 DB를 가리키는 `DataSource`를 준다. 이름은 **정확히 `^harness_ct_[0-9a-f]{16}$`** 를 만족해야 하며 그 정규식은 이 클래스의 상수 하나다.
- `close()`/종료 훅에서 **자기가 만든 이름만** 드롭한다. 이름이 정규식에 맞지 않으면 **드롭하지 않고 던진다**. (근거: 임시 MySQL DB는 오늘의 임시 SQLite 파일과 같은 지위다. 최상위 규칙이 지키는 것은 뉴스 데이터이고, 그 보호는 접두사 정규식 + step0의 grant 이중으로 건다.)
- **`pom.xml`에 `com.mysql:mysql-connector-j` 1개를 추가한다**(이 step이 유일한 pom 편집 지점이다. `maven-compiler-plugin` 블록을 추가하지 마라 — 74 forward_notes (9)).
  - **scope를 명시한다: `runtime`**(테스트 전용 `test`가 아니다 — step6이 실제 기동에 쓰므로 `test`로 넣으면 step6에서 pom을 다시 고쳐야 한다). 그 결과 **jar 크기가 이 step에서 증가**하니(sqlite-jdbc와 같은 자리) **증가 전후 크기를 summary에 적어라** — 안 적으면 step9의 마감 실측이 그 증가를 회귀로 읽는다.
- **`MysqlConfiguredGuardTest`**: 환경변수 3종이 없으면 **skip이 아니라 fail**한다. 근거: 조용한 skip은 이 phase의 모든 MySQL 게이트를 공허하게 만든다(정적 스캔이 매번 공허했던 71a~74의 재발 형태다). 트레이드오프(이 리포의 `mvnw verify`가 MySQL 서버를 요구하게 된다)는 ADR-016(step2)에 적는다.

### B. 측정 — 12축. 각 축은 **SQLite와 MySQL에서 같은 입력을 돌려 결과를 나란히 비교**하는 JUnit 테스트다

`server-spring/src/test/java/harness/news/db/dialect/DialectSemanticsProbeTest.java`(또는 축별 분할). 각 축은 **측정한 값을 그대로 단언**한다(기대값을 추측해서 적지 말고, 먼저 출력해 보고 그 값을 박아라).

1. **바인딩 표현**: 텍스트 컬럼에 `int 0`·`long 2`·`double 0.0`·`double 2.0`·`boolean`을 바인딩했을 때 **저장된 문자열**. (SQLite는 TEXT affinity에서 `2.0` → `"2.0"`이 실측돼 있다 — 74 이월. MySQL은 무엇이 되는가.)
2. **빈 문자열 vs NULL**: 왕복 보존 · `IS NULL` / `= ''` / `COALESCE` 결과.
3. **`=` 비교**: 대소문자(`abc` vs `ABC`) · **후행 공백**(`x` vs `x `) · 전각/반각 · 한글 자모 조합. collation 후보 **`utf8mb4_bin`(PAD SPACE 계열) · `utf8mb4_0900_bin`(NO PAD) · `utf8mb4_0900_ai_ci`** 3종 전부에서 재고, SQLite BINARY와 **정확히 일치하는 것이 무엇인지 판정**한다. ⚠ 이 축은 보안 축이다 — `WHERE userId = ?`가 대소문자·후행 공백을 무시하면 **다른 계정으로 로그인**할 수 있다.
4. **`LIKE`**: ASCII 대소문자(SQLite는 무시가 기본) · 한글 · `%`/`_`가 든 질의어(이 리포는 **ESCAPE 없이** 바인딩한다 — `PhotoRepository` 34행) · 빈 질의(`%%`) · NULL 컬럼. 3종 collation 전부에서 재고, **SQLite와 완전 일치하는 조합이 존재하는지** 판정한다. 없으면 「완전 일치 불가」를 결론으로 적고 가장 가까운 조합 + 남는 차이를 기록한다.
5. **`ORDER BY`**: 한글 문자열 20개 이상 · 한영숫자 혼합 · ISO 시각 문자열. SQLite BINARY 순서와 각 collation 순서를 **리스트로 나란히** 비교한다. 추가로 **동일 키 tie**에서의 반환 순서(양쪽 다 비보장이라는 사실을 단언으로 남긴다).
6. **id 생성**: `INTEGER PRIMARY KEY`(SQLite) vs `BIGINT AUTO_INCREMENT`(MySQL). ① 연속 삽입 시 값 ② `GeneratedKeyHolder`가 돌려주는 값 ③ **최댓값 행을 지운 뒤 재삽입했을 때 id 재사용 여부**(SQLite rowid는 재사용, InnoDB는 미재사용이 예상 — 실측하라) ④ **롤백 후의 다음 id**: 삽입 → 롤백 → 재삽입에서 **InnoDB는 소비한 번호를 되돌리지 않아 번호에 간격이 생기고**(예상) SQLite rowid는 복구된다(예상). 두 경우 모두 **실측하고 간격의 유무를 기록**하라. ⚠ 이 리포의 **유일한 행 삭제 예외가 `DELETE FROM ReceiverConfig`**(`ReceiverConfigRepository` 153행)이므로 ③의 divergence는 실제로 도달 가능한 경로다.
7. **대용량**: 165,802바이트 문자열 저장·왕복·`LIKE` 검색. `LONGTEXT`/`MEDIUMTEXT`/`VARCHAR(n)` 각각의 가부와 오류 코드. `max_allowed_packet=64M`(실측) 안에서의 동작.
8. **길이 초과 — 절단만 보지 말고 「수락 vs 거부」 divergence를 보라.** SQLite의 `VARCHAR`는 **길이 제한이 없어 무엇이든 수락**하지만 MySQL `VARCHAR(768)`는 STRICT 모드에서 **거부(1406)** 한다. 즉 절단이 없어도 **Node 200 / Spring 500**이 되는 divergence다. 측정할 것: ① 769자 삽입 시 MySQL의 오류 코드(1406인가 · 조용한 절단인가 — **조용한 절단이면 그 매핑을 채택하지 마라**) ② 같은 입력에서 SQLite는 성공하는가 ③ **도달 경로가 실제로 있는가**: PK로 매핑될 3종(`User.userId`·`Article.articleId`·`Contents.articleId`) 중 **사용자 입력에서 오는 것**을 코드로 확인하라(`userId`는 관리자 생성 API 입력이고 길이 검증이 있는지 실측하라. `articleId`는 서버 생성이다). ④ 도달 가능하면 그 divergence를 `docs/db-mysql-mapping.md`에 **「Node 수락 / Spring 500」** 으로 명시하고, 길이를 늘려 회피할지(768이 utf8mb4 인덱스 상한이라 더 못 늘린다) 애플리케이션 검증을 P3로 넘길지 **판정하고 근거를 적어라**.
9. **`length()`**: SQLite `length()`(문자) vs MySQL `LENGTH()`(바이트)/`CHAR_LENGTH()`. `ArticleHistoryRepository` 198행의 `> 0` 술어가 양쪽에서 같은 행 집합을 주는지.
10. **식별자 대소문자**: `lower_case_table_names=1`에서 `CREATE TABLE User` 후 `information_schema.TABLES`·`DatabaseMetaData.getTables/getColumns`가 돌려주는 **표기**. `SchemaGuard`가 대소문자 무시 비교로 성립하는지(현재도 `toLowerCase` 비교다).
11. **접속·트랜잭션**: `caching_sha2_password` + 비TLS localhost에서 필요한 Connector/J 파라미터(`allowPublicKeyRetrieval`·`useSSL`·`characterEncoding`·`connectionCollation`·`sessionVariables`로 `sql_mode` 고정 가부)를 **하나씩 빼 보며** 최소 집합을 찾는다. 그리고 **커넥션 풀 1**(`NewsDataSource.MAX_POOL_SIZE`) 유지 상태에서 트랜잭션 롤백·자동커밋이 SQLite와 동형인지, `innodb_lock_wait_timeout` 값이 얼마인지 기록한다.
    - **추가 축 — 단일 연결의 노후화**: 서버 `wait_timeout`(step0 D-3의 세션 실측값)과 Hikari `maxLifetime`·`idleTimeout`의 관계를 확인한다. **풀 크기가 1이라 그 하나가 서버에 의해 끊기면 다음 요청이 실패**할 수 있다(SQLite에는 없던 축이다). `maxLifetime < wait_timeout`이 성립하는지 계산하고, 성립하지 않으면 명시 설정으로 맞춘 뒤 **그 값이 왜 그 값인지** 주석에 남겨라. 장시간 유휴 후 첫 요청이 성공하는지 실측할 수 있으면 하고, 못 하면 **미측정으로 적어라**(운영에서 처음 드러나는 유형의 결함이다).

12. **예약어 충돌 — `decisions (16)`의 전제를 검증하는 축.** 이 phase는 리포지토리 SQL을 고치지 않기로 했으므로 식별자가 **인용부호 없이(무백틱)** 나간다: 테이블 `User`·`Article`·`Contents`, 컬럼 `status`·`action`·`region`·`keyword`·`type`·`port`·`name`·`password`·`active`·`reason` 등. **MySQL 예약어와 하나라도 충돌하면 그 결정이 통째로 무너진다**(SQL이 파싱 단계에서 죽는다). 추측하지 말고 **기계로 대조**하라: `SELECT WORD FROM INFORMATION_SCHEMA.KEYWORDS WHERE RESERVED = 1` 을 읽어, `src/db/schema.js`의 **7테이블 이름 + 전 컬럼 이름**과 교집합을 구하고 **0건**임을 단언하는 테스트를 둔다(이 서버의 버전이 정본이다 — 문서의 예약어 목록을 베끼지 마라).
    - 충돌이 나오면 선택지는 둘이고 **판정해서 적어라**: (a) 해당 식별자를 백틱으로 인용(리포지토리 SQL 수정 = `decisions (16)`의 「방언 지점 하나」가 깨진다 → 그 결정을 고쳐야 한다) (b) 매핑에서 이름을 바꾼다(**금지** — 컬럼 이름은 응답 키 집합이고 계약이다).
    - 이 테스트는 **영구 회귀 그물**이다: 나중에 컬럼이 추가되거나 MySQL이 업그레이드돼 예약어가 늘면 여기서 red가 난다.

### C. 산출물 — `docs/db-mysql-mapping.md` (신규)

- **컬럼별 타입 매핑표**(7테이블 · 전 컬럼). 규칙 후보: PK/`=` 조회 대상 텍스트 → `VARCHAR(768)`(utf8mb4에서 단일 컬럼 인덱스 상한 3072바이트에 맞춘 값) · 나머지 텍스트 → `LONGTEXT` · `INTEGER PRIMARY KEY` → `BIGINT AUTO_INCREMENT` · `targetId INTEGER` → `BIGINT` · **날짜·시각은 `DATETIME`으로 승격하지 않는다**(정본이 ISO 문자열을 TEXT에 넣는다 — 승격하면 포맷·타임존이 왕복에서 갈린다). 이 규칙을 측정 7·8로 **검증한 뒤** 확정하고, 검증에 실패하면 규칙을 바꿔라.
- **collation 결정 + 근거**(측정 3·4·5의 표).
- **보조 인덱스 0 유지**(정본이 `PK 자동 인덱스만 사용 · 보조 인덱스/FK 미선언`이다 — `src/db/schema.js` 3행). 성능 차이는 divergence로 기록하고 P3에 넘긴다.
- **접속 URL 파라미터 확정 집합**(측정 11).
- **잔여 divergence 목록** — 「완전 일치 불가」로 판정된 축 전부 + 각 축의 **유일 방어선**(어느 Java 테스트인지 파일·메서드 이름으로).

## Acceptance Criteria

```bash
# MySQL 자격증명을 셸에 로드한 뒤 (docs/ops-mysql.md 절차)
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
# 계약 무회귀 (이 step은 main 소스를 고치지 않으므로 관측 수·diff가 step0과 같아야 한다)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
# main 소스 무접촉 (pom.xml 1줄 외에는 diff 0)
git diff --stat -- server-spring/src/main
```

**종료 조건**
- `clean verify` BUILD SUCCESS · Failures 0 · Errors 0 · **Skipped 0** · `Tests run`이 step0 기준선보다 증가했고 그 증가분이 이 step의 신규 테스트 수와 일치한다.
- `--parity` **exit 0 · diffs 0 · 관측 수 step0과 동일**.
- `git diff -- server-spring/src/main`이 **비어 있다**(pom.xml 의존성 1개 추가만 허용).
- `docs/db-mysql-mapping.md`가 **12축 전부**에 대해 측정값 또는 「미측정 + 이유」를 담고 있다.
- **축 12(예약어) 교집합 0건**이 기계 대조로 확인됐다(충돌이 있으면 `decisions (16)`을 고치는 것이 먼저다).
- **축 8의 「Node 수락 / Spring 500」 divergence 판정**과 도달 경로 조사 결과가 기록됐다.
- **변이 전건 결과표가 summary에 기록**됐다(아래 검증 절차 2). **미기록 시 이 step은 미완이다.**

## 검증 절차

1. 각 축은 **먼저 값을 출력해 보고** 그 실측값을 단언으로 박는다(기대값을 상상해 적고 맞추려 하지 마라).
2. **변이 검증(최소 6종 · 전건 결과표 필수)**:
   - M1: `MysqlConfiguredGuardTest`가 실제로 fail하는지 — 환경변수 하나를 비우고 돌려 red를 본다.
   - M2: `EphemeralMysqlDb`의 이름 정규식을 `harness_ct_.*`로 넓히면 드롭 가드 테스트가 red인가.
   - M3: collation을 결정값에서 `utf8mb4_0900_ai_ci`로 바꾸면 축 3·4·5 중 **정확히 어느 단언이** red가 되는가(개수와 이름을 적어라).
   - M4: 텍스트 컬럼 매핑을 `VARCHAR(768)`로 바꾸면 축 7(165,802바이트)이 red인가 — **red가 아니면 그 축은 공허하다.**
   - M5: 축 6의 id 재사용 단언을 반대로 뒤집으면 red인가.
   - M6: 축 12의 예약어 목록에 실재 컬럼 이름 하나(예: `status`)를 강제로 예약어로 취급하게 하면 red인가 — **red가 아니면 그 대조는 공허하다**(목록을 못 읽고 빈 집합과 비교하고 있을 수 있다).
3. 계약 하네스와 `mvnw verify`를 **동시에 돌리지 마라**.
4. green 즉시 커밋한다.

## 금지사항

- **`server-spring/src/main/**`을 고치지 마라.** 이유: 이 step은 측정만 소유한다. 서버 코드를 만지면 「측정이 코드 변경을 정당화하고 코드 변경이 측정을 오염시키는」 순환이 생긴다.
- **`pom.xml`에 Flyway를 넣지 마라.** 이유: `NoSchemaSqlInMainSourcesTest.FORBIDDEN`이 main 소스·**main 리소스**에서 `flyway` 철자를 금지한다(실측). Flyway는 step2에서 **별도 모듈**이 소유한다.
- **측정 결과를 문서에만 적고 테스트로 굳히지 않은 채 끝내지 마라.** 이유: 문서는 회귀를 잡지 못한다. 이 phase의 나머지 전부가 이 측정을 전제로 세워진다.
- **`news_app`·`news_migrator` 계정으로 프로브를 돌리지 마라.** 이유: 프로브는 임시 DB를 만들고 지운다 — `news_ct` 계정의 권한 경계 안에서만 돌아야 그 경계가 실제로 검증된다.
- **리포 `news.db`를 프로브 소스로 쓰지 마라.** 이유: 원본 무변이 완료 게이트다. 프로브는 자기 픽스처만 쓴다.
