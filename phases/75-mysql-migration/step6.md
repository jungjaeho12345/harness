# Step 6: mysql-runtime

`server-spring`을 **MySQL로 실제 기동**시키고, **계약이 구조적으로 못 보는 축**(정렬·LIKE 대소문자·id 재사용·바인딩 표현·잠금)에 **리포지토리 차등 테스트**를 배정한다. 계약 green은 아직 SQLite 경로가 내고(무회귀), MySQL 계약 green은 step7이다.

## 읽어야 할 파일

- `phases/75-mysql-migration/index.json` · `step1.md`·`step5.md`와 두 step의 summary
- `docs/db-mysql-mapping.md` (확정 매핑·접속 파라미터·잔여 divergence)
- `docs/ADR.md` ADR-016
- `server-spring/src/main/java/harness/news/db/` 전부(step5 이후 상태)
- `server-spring/src/main/java/harness/news/model/` **11파일 전부** — 이 step의 대상은 이 계층의 SQL 전량이다
- `server-spring/src/test/java/harness/news/testsupport/EphemeralMysqlDb.java`(step1) · `TempNewsDb.java`
- `server-spring/src/test/java/harness/news/controller/LogsStreamWireTest.java` 항목 22 (74 ⑤가 폐색한 락 순서 결함의 방어선 — Hikari 상한 1 의존)
- `contract/lib/record.js` 103~127행 · `contract/cases/default/articles-read.contract.js` 237·382·400행

## 배경 (동결된 사실)

1. **계약 리포트는 `status`·`ok`·`reason`·`bodyKeys`·케이스가 명시한 `values`·허용 헤더만 싣는다**(실측). 그리고 목록 케이스는 **id를 정렬해 비교**한다 — 즉 **행 순서는 단언되지 않는다**. `photos-search`는 소문자 랜덤 토큰만 쓰므로 **LIKE 대소문자도 관측되지 않는다**. `receiver-config` 케이스는 **id 원값을 리포트에 싣지 않는다**. ⇒ **이 세 축의 유일 방어선은 이 step이 만드는 Java 테스트다.** (「계약이 잡는다」고 적지 마라.)
2. **관련된 리포지토리 SQL 실측 좌표**: `ArticleRepository` 246행(`ORDER BY createdAt DESC`) · 259행(3컬럼 `LIKE`) / `PhotoRepository` 111행(`caption LIKE ? ORDER BY id DESC`, **ESCAPE 없음**) / `ArticleHistoryRepository` 162·198·226행(`ORDER BY id DESC`, `length(...)>0`) / `DistributionTargetRepository` 88행 · `ReceiverConfigRepository` 92행(`ORDER BY id`).
3. **유일한 행 삭제 예외는 `DELETE FROM ReceiverConfig`**다(`NoSchemaSqlInMainSourcesTest`가 그 하나만 허용). step0 부트스트랩의 `news_app`은 `SELECT/INSERT/UPDATE`만 갖는다 — **그 예외를 어떻게 열지는 이 step이 실측으로 판정**한다(후보: `GRANT DELETE ON news.ReceiverConfig TO news_app` 테이블 단위 부여. 그러면 나머지 6테이블의 삭제는 **DB 서버가** 계속 막는다).
4. `Contents.createdAt`은 현재 데이터에서 77/77 상이하지만(실측) **동일 값 tie는 양쪽 다 순서 비보장**이다.
5. `MAX_POOL_SIZE = 1` 유지(ADR-016 결정 6).

## 작업 (TDD)

### A. MySQL 기동을 실제로 세운다

- `NewsDataSource`의 mysql 분기를 완성한다: 드라이버·URL 파라미터(step1 측정 11의 확정 집합) · 풀 1 · **접속 후 read-back 검증**(sqlite의 `busy_timeout` read-back과 같은 규율으로, 예: 세션 `sql_mode`·`character_set_connection`·`collation_connection`이 의도한 값인지 읽어 확인하고 어긋나면 기동 실패). **조용히 다른 설정으로 뜨지 않게 하라.**
- `SchemaGuard`가 MySQL 대상에서 7테이블·전 컬럼을 검증한다. 드리프트 상황(컬럼 1개 결손)에서 **컬럼을 지목하며 기동 거부**하는지 MySQL에서도 확인한다.
- `@SpringBootTest` 기반 **MySQL 와이어 스모크**: 로그인 → 목록 → 기사 생성 → 잠금 → 상태 전이 → 사진 등록·검색 → 수집설정 생성·삭제 → 로그 다이제스트. 픽스처는 `EphemeralMysqlDb`.

### B. 리포지토리 차등 테스트 — **같은 입력, 두 방언, 결과 동일 단언**

`server-spring/src/test/java/harness/news/model/dialect/` 아래. 각 축은 **SQLite 결과를 기대값으로 삼고 MySQL 결과가 그것과 같은지** 본다(정본이 SQLite다).

1. **정렬**: `ArticleRepository.search`(`ORDER BY createdAt DESC`)·`PhotoRepository`(`id DESC`)·`ArticleHistoryRepository`(`id DESC`)·`DistributionTargetRepository`/`ReceiverConfigRepository`(`id`). 픽스처에 **한글 제목 20건 이상**과 한영숫자 혼합을 넣고 **반환 순서 리스트가 완전히 같은지** 단언한다(`sort()` 하고 비교하지 마라 — 그러면 계약과 같은 맹점이 된다).
2. **LIKE**: 대소문자 혼합 캡션/제목 · `%`·`_`가 든 질의어 · 한글 · 빈 질의(`%%`) · NULL 컬럼. **양쪽이 같은 행 집합**을 주는지. 다르면 step1이 「완전 일치 불가」로 판정한 그 축이므로 **테스트로 divergence를 고정**하고(기대값을 양쪽 각각으로 명시) `docs/db-mysql-mapping.md`에 옮겨 적는다.
3. **id 생성·재사용**: `ReceiverConfig` 삽입 → 최댓값 행 삭제 → 재삽입. SQLite는 id 재사용, MySQL은 미재사용이 예상(step1 측정 6). **divergence면 그대로 고정하고**, 계약이 이 축을 보지 못한다는 사실을 테스트 javadoc에 적어라.
4. **바인딩 표현**: `ColumnValues`가 허용하는 값들(정수·실수·불리언 거부 등)이 MySQL에서 **어떤 문자열로 저장·조회되는지**. 특히 `2.0` 같은 정수값의 실수 표기(71a~74 누적 이월 항목)가 MySQL에서 **다른 문자열이 되는지** — 되면 divergence 목록에 추가한다.
5. **NULL vs 빈 문자열**: 저장·조회·`IS NULL`·`= ''`·투영까지 왕복.
6. **트랜잭션·잠금**: `TransactionTemplate` 롤백이 두 방언에서 동형인지. 풀 1 상태에서 `LogsStreamWireTest` 항목 22가 세운 사슬(구독 콜백의 DB 조회 ↔ 요청 필터의 로그)이 **MySQL에서도 성립하는지**(= 무관한 `GET /api/health`가 막히지 않는지). InnoDB `innodb_lock_wait_timeout`과 `busy_timeout`의 차이를 기록한다.
7. **`length()` 술어**: `ArticleHistoryRepository` 198행이 두 방언에서 같은 행 집합을 주는지(멀티바이트 본문 포함).

### C. `DELETE FROM ReceiverConfig` 예외 경로

- `news_app` 권한으로 그 삭제가 되는지 실측하고, 안 되면 **테이블 단위 grant를 `ops/mysql/bootstrap.sql`에 추가**한다(그리고 나머지 6테이블 삭제가 여전히 거부되는지 **실측으로 확인**한다 — 이것이 「최소 권한이 1차 방어선」 주장의 유일한 근거다).
- 거부 상황에서 서버가 어떤 응답을 내는지도 확인한다(계약은 200 `{ok:true,changes:1}`을 요구한다 — 권한 오류가 500으로 새면 패리티가 깨진다. step7에서 실제로 드러날 축이므로 여기서 먼저 잡아라).

### D. 문서

`server-spring/README.md`의 설정키 ↔ 환경변수 표에 `DB_KIND`·`NEWS_DB_URL`·`NEWS_DB_USERNAME`·`NEWS_DB_PASSWORD`를 추가하고, mysql 모드에서 `DATA_DIR`이 여전히 필수인 이유(업로드 루트)를 적는다.

## Acceptance Criteria

```bash
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --dual-run
md5sum news.db
```

**종료 조건**
- `clean verify` BUILD SUCCESS · Failures/Errors/**Skipped 0** · `Tests run` 증가(감소 0).
- **`--parity`·`--dual-run` 둘 다 313관측 diffs 0**(SQLite 경로 무회귀 — 이 step은 아직 하네스를 MySQL로 돌리지 않는다).
- B의 7축 전부에 테스트가 있고, **divergence로 판정된 축은 「양쪽 기대값을 각각 명시한 테스트」 + `docs/db-mysql-mapping.md` 기록**이 있다.
- C의 실측 결과(어떤 grant를 추가했는지 · 나머지 6테이블 삭제가 거부되는지)가 summary에 있다.
- `news.db` md5 무변 · 무접촉 목록 diff 0.
- **변이 전건 결과표 기록.** 미기록 시 미완.

## 검증 절차

**변이 검증(최소 8종)**
- M1: `ORDER BY`를 하나 지우면 B-1이 red인가(**어느 리포지토리에서 재현했는지 적어라**).
- M2: MySQL collation을 결정값에서 `utf8mb4_0900_ai_ci`로 바꾸면 B-1·B-2 중 몇 개가 red인가.
- M3: `WHERE userId = ?` 경로에서 대소문자·후행 공백이 다른 값으로 로그인이 되는가(**된다면 그것은 결함이고 이 step에서 막아야 한다**).
- M4: NULL을 빈 문자열로 뭉개면 B-5가 red인가.
- M5: `GeneratedKeyHolder` 회수를 다른 트랜잭션으로 옮기면 red인가.
- M6: `MAX_POOL_SIZE`를 2로 바꾸면 B-6이 red인가.
- M7: mysql 분기의 read-back 검증을 지우면(= 다른 `sql_mode`로 조용히 뜨게 하면) 어떤 테스트가 red인가.
- M8: `SchemaGuard`가 MySQL에서 컬럼 결손을 못 잡게 하면 red인가.

flake 판정은 **재실행 2회 연속 green** 규약을 따른다. green 즉시 커밋한다.

## 금지사항

- **정렬 결과를 `sort()`한 뒤 비교하지 마라.** 이유: 그것이 계약이 이 축을 놓치는 정확한 이유다(실측). 순서 자체가 단언 대상이다.
- **divergence를 발견하고 「Node를 고쳐서」 맞추려 하지 마라.** 이유: `server/**`·`src/**`는 무수정 정본이다. 맞출 수 없으면 **기록**하고 유일 방어선을 지정하라.
- **계약 케이스·러너를 고쳐 통과시키지 마라.** 이유: 계약과 다르면 Spring을 고친다(ADR-013 ④).
- **`Adr008DisciplineTest`의 예외 목록을 넓히지 마라.** 이유: 이 step은 새 스레드·타이머·egress를 만들지 않는다. 필요하다고 느끼면 설계가 틀렸다.
- **커넥션 풀을 늘리지 마라.** 이유: 74 ⑤가 폐색한 결함의 방어선이 상한 1에 걸려 있고, 확대는 별도 ADR이 필요한 동시성 결정이다.
