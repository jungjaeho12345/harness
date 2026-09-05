# Step 0: baseline-and-credentials

기준선을 **직접 재측정**하고, MySQL 접속 자격증명을 **비밀을 리포·대화에 남기지 않는 절차**로 확보하고, 그 비밀이 새는 것을 막는 정적 그물을 세운다. 이 step은 Java main 소스를 **한 줄도** 고치지 않는다.

## 읽어야 할 파일

- `docs/porting-plan-cpp-spring.md` — §3-② (DB 결정) · §7 P2 행 · §8 (검증 전략) · §10 (열린 질문 1)
- `phases/75-mysql-migration/index.json` — 이 phase의 `scope`·`baseline`·`decisions`·`excluded`·`open_questions` 전문
- `phases/74-spring-sse/index.json` — `forward_notes` 전문(특히 (8) P2 인계 · (9) JDK 25 · (10) 환경 함정)
- `docs/ADR.md` — ADR-002(SQLite 채택) · ADR-013(server-spring 결정 ②의 「스키마 소유자는 P2까지 Node다」)
- `server-spring/src/main/java/harness/news/db/` 4파일 전부
- `server-spring/src/test/java/harness/news/db/NoSchemaSqlInMainSourcesTest.java` (375행 전문 — 이 phase의 최대 제약)
- `server-spring/src/test/java/harness/news/config/RepoDataIsolationTest.java`
- `scripts/spring-contract.mjs` (807행 — 특히 `runSpringPass` 498~610행의 시드·비밀 파일 취급)
- `.gitignore`
- `server-spring/README.md` (설정키 ↔ 환경변수 대응표)

## 배경 (동결된 사실 — 다시 조사하지 마라)

1. **DB는 MySQL 8.0으로 확정됐다**(사용자 결정 2026-09-01). 계획서 §3-②의 MariaDB는 *가정*이었고 이 결정이 §10 열린 질문 1의 DB 축을 닫는다.
2. **이 머신 실측(2026-09-01)**: `C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe` = **Ver 8.0.46 for Win64**. 포트 3306 응답(무비밀번호 접속은 `ERROR 1045 (28000) Access denied` = 서버 도달 확인). `C:\ProgramData\MySQL\MySQL Server 8.0\my.ini` 실측: `lower_case_table_names=1` · `sql-mode="ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION"` · `default-storage-engine=INNODB` · `max_allowed_packet=64M` · `max_connections=151` · `secure-file-priv="C:/ProgramData/MySQL/MySQL Server 8.0/Uploads"` · `character-set-server` **미설정**(= 8.0 기본 `utf8mb4` / `utf8mb4_0900_ai_ci`) · `log-bin` 활성.
3. **root 비밀번호는 아무도 모른다.** 이 phase는 root로 붙지 않는다 — 사용자가 직접 1회 실행하는 부트스트랩 SQL로 **전용 DB·전용 사용자 3종**을 만들고, 이후 모든 자동화는 그 최소권한 계정만 쓴다.
4. **Maven 로컬 캐시에 `com.mysql:mysql-connector-j`도 `org.flywaydb:*`도 없다**(`~/.m2/repository` 실측). 즉 이 phase는 **Maven Central 네트워크 접근이 필요**하다. 안 되면 이 step에서 `blocked`다.
5. **`package.json`은 무수정이다** → Node 하네스에 MySQL 드라이버를 넣을 수 없다. 이 사실이 step7의 설계를 강제한다(하네스는 java CLI로만 MySQL을 만진다).
6. **환경 함정**: VS Code의 App Modernization(java-upgrade) 세션이 `git stash -u`로 미커밋 작업을 통째로 가져간 전례가 있다(74 forward_notes (10)). **green이 되는 즉시 커밋하라.** `git add -A` 금지(경로를 지정해 add). Bash 인라인 한글은 exit 127 — 파일 작성은 Write 도구, 커밋 메시지는 `git commit -F`.

## 작업

### A. 기준선 재측정 (계획서 수치를 믿지 말고 직접 측정)

아래 6개를 순서대로 돌리고 **결과 수치를 step summary와 (수치가 계획서와 다르면) `index.json`의 `baseline`에 기록**한다. `mvnw verify`와 계약 하네스를 **동시에 돌리지 마라**(74 forward_notes (10) ④).

1. `cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify`
2. `SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity` (리포 루트 cwd)
3. `node scripts/contract-inventory-check.mjs --require-spec-paths`
4. `npm test`
5. `md5sum news.db && ls -l news.db` (기대: `7247e9e0dfe5cc8cd040ebb1dc9fb967` · 606,208 B)
6. `git log --oneline -1` — HEAD가 `9df5381`(또는 그 이후 이 브랜치 커밋)인지, 낯선 커밋이 없는지

### B. 자격증명 확보 절차 — 산출물 2개 (**비밀은 어디에도 쓰지 않는다**)

- `ops/mysql/bootstrap.sql` (신규) — **사용자가 root로 직접 1회 실행**하는 템플릿. 비밀번호 자리는 반드시 `__CHANGE_ME_APP__` 류의 **플레이스홀더 문자열**이고 실제 값을 절대 적지 않는다.
  - ⚠ **이 파일은 이 phase에서 단 한 번 실행된다는 전제로 설계하라.** 뒤 step이 새 grant·새 DB를 요구하면 **사용자에게 root 재실행을 다시 부탁하는 중도 blocked**가 되고, blocked 복구 절차는 이 step에만 있다. 그래서 **step3(스테이징 대상)·step6(`ReceiverConfig` 삭제 예외)이 필요로 하는 권한을 지금 전부 넣는다.**
  - **전 문장을 재실행 멱등으로 쓴다**: `CREATE DATABASE IF NOT EXISTS` · `CREATE USER IF NOT EXISTS` · `GRANT`(멱등) · `ALTER USER ... IDENTIFIED BY`는 **넣지 마라**(재실행이 비밀번호를 덮어써 기존 설정을 깬다). 사용자가 두 번 실행해도 안전해야 한다.
  - 내용은 아래 5덩어리:
  - `CREATE DATABASE IF NOT EXISTS news CHARACTER SET utf8mb4 COLLATE <step1이 확정할 collation>;` — collation 값은 이 step에서는 **주석으로 후보만** 적고(`utf8mb4_0900_bin` 유력), step1의 실측이 확정한 뒤 step2가 확정값으로 고친다.
  - **스테이징 DB** — step3·step4가 이관 리허설·왕복 대조에 쓸 대상이다. **`harness_ct_` 접두사를 쓰지 않는다**(그 접두사는 하네스가 만들고 지우는 공간이라 리허설 산출물이 실행 도중 사라질 수 있다). 이름을 `news_stage`로 고정하고 `news_migrator`에게 `news`.*와 **동일한 권한**을 준다. **step3·step4의 대상은 이 DB로 못 박는다**(뒤에서 다시 정하지 마라).
  - `news_app`@`localhost` — **서버 런타임 계정**. 기본 권한은 `SELECT, INSERT, UPDATE` **만**(`news`.* 와 `news_stage`.*). **`DROP`·`ALTER`·`CREATE`를 주지 마라** — 최상위 규칙(DB 행 삭제 금지)을 코드가 아니라 **DB 서버가** 강제하게 만드는 것이 이 설계의 핵심이다.
    - **여기에 더해 테이블 단위 삭제 예외 1건을 지금 부여한다**: `GRANT DELETE ON news.ReceiverConfig TO news_app@localhost;`(그리고 `news_stage.ReceiverConfig`도 동일). 근거는 실측이다 — `ReceiverConfigRepository`의 `remove(double)`(**153행**)가 `DELETE FROM ReceiverConfig WHERE id = ?`를 **실제로 실행**하고, 계약은 그 응답을 `200 {ok:true,changes:1}`로 동결한다(phase 70이 「행 삭제가 허용된 유일 테이블」로 확정). 이 grant가 없으면 **step6·step7에서 그 라우트가 권한 오류로 무너져 패리티가 깨진다.**
    - 테이블 단위 grant이므로 **나머지 6테이블(User·Article·Contents·ArticleHistory·DistributionTarget·Photo)의 삭제는 여전히 DB 서버가 막는다.** 그 거부를 **실증**하는 것은 step6 C의 일이고, **부여는 여기서 끝난다.**
  - `news_migrator`@`localhost` — **마이그레이터 계정**. `SELECT, INSERT, CREATE, ALTER, INDEX, REFERENCES` on `news`.* **와 `news_stage`.*** (**DELETE·DROP·TRUNCATE 금지**). Flyway 이력 테이블 생성이 필요하므로 CREATE가 있다.
  - `news_ct`@`localhost` — **계약 하네스 전용**. `ALL PRIVILEGES ON \`harness\_ct\_%\`.*` (백틱 안에서 `_`를 이스케이프해 와일드카드 접두사로 고정). 이 계정은 `news`·`news_stage` DB에 **어떤 권한도 없다**.
- `docs/ops-mysql.md` (신규) — 런북. ① 사용자가 실행할 명령(`mysql -u root -p < ops/mysql/bootstrap.sql`) ② **리포 밖** 환경변수 파일 위치 규약(`D:/agents/secrets/news-mysql.env` — 리포 안 금지) ③ 그 파일이 정의하는 키 이름 목록 ④ 각 커맨드를 돌리기 전에 그 파일을 셸에 로드하는 방법 ⑤ **비밀번호를 커맨드라인 인자로 넘기지 않는 이유**(프로세스 목록 노출) ⑥ 접속 확인 커맨드.
  - 환경변수 키(이 phase 전체가 이 이름만 쓴다): `NEWS_DB_URL` · `NEWS_DB_USERNAME` · `NEWS_DB_PASSWORD`(서버) / `NEWS_MIGRATOR_URL` · `NEWS_MIGRATOR_USERNAME` · `NEWS_MIGRATOR_PASSWORD`(마이그레이터) / `NEWS_CT_MYSQL_URL` · `NEWS_CT_MYSQL_USERNAME` · `NEWS_CT_MYSQL_PASSWORD`(하네스·Java 테스트).

### C. 비밀 위생 그물 (TDD — 테스트 먼저)

`server-spring/src/test/java/harness/news/config/SecretHygieneTest.java` (신규)를 **먼저 red로 세우고** 통과시킨다. 스캔 대상은 **리포 루트 전체**(`../` — `RepoDataIsolationTest`의 `REPO_ROOT` 도출 방식을 그대로 승계)이되 `node_modules/`·`target/`·`.git/`·`web/dist/`는 제외한다. 단언 4종:
1. 추적 대상 파일 어디에도 `jdbc:mysql://` URL에 **비밀번호가 박힌 형태**(`//user:pw@`)가 없다.
2. `NEWS_DB_PASSWORD`·`NEWS_CT_MYSQL_PASSWORD`·`NEWS_MIGRATOR_PASSWORD` 뒤에 `=` + 비-빈 리터럴이 오는 줄이 없다(환경변수 *이름*의 등장은 허용 — 값 대입만 금지).
3. `ops/mysql/bootstrap.sql`의 `IDENTIFIED BY` 우변은 전부 `__CHANGE_ME` 접두 플레이스홀더다.
4. `.gitignore`가 `*.env`·`secrets/`·`ops/mysql/*.local.sql`을 무시한다.

**비공허성 실증(필수)**: 위 4단언 각각에 대해 위반 문자열을 임시 파일로 **심어 red를 눈으로 보고 원복**한다. 문자열을 끊어 쓴 형태(`"jdbc:mysql:" + "//u:p@h/d"`)도 잡히는지 확인하고, 못 잡으면 못 잡는다는 사실을 summary에 적어라(과장 금지).

### D. 툴체인 전제 프로브

1. **Maven 네트워크**: `cd server-spring && JAVA_HOME=... ./mvnw -B dependency:get -Dartifact=com.mysql:mysql-connector-j:9.1.0` 와 `-Dartifact=org.flywaydb:flyway-mysql:11.0.0` 를 각각 시도해 **해석 가능 여부만** 확인한다(버전은 해석되는 최신 안정판으로 조정해도 된다 — 확정은 step2·step6). **`pom.xml`은 이 step에서 고치지 않는다.**
2. **자격증명 왕복**: 사용자가 부트스트랩을 실행한 뒤 아래를 **전부** 확인한다. 확인 커맨드와 결과를 summary에 적되 **비밀번호는 적지 마라**.
   - 세 계정 각각으로 `SELECT 1`.
   - **`news_ct`가 `harness_ct_<16hex>` DB를 실제로 CREATE/DROP** 할 수 있는가(와일드카드 grant가 CREATE까지 허용하는지는 **실측 대상** — 안 되면 open question (3)의 대안으로 간다).
   - **`news_app`이 `DELETE FROM Contents`를 시도하면 거부**되는가.
   - **`news_app`이 `DELETE FROM ReceiverConfig`는 성공**하는가(예외 grant가 실제로 붙었는지 — 이것이 안 되면 step6·step7이 무너진다).
   - **`news_migrator`가 `news_stage`에 `CREATE TABLE`** 을 할 수 있는가(step3 리허설의 전제).
   - **부트스트랩을 한 번 더 실행해도 오류 없이 끝나는가**(재실행 멱등 — 사용자가 실수로 두 번 돌려도 안전해야 한다).
3. **세션 실측(설정파일 읽기로 대신하지 마라)**: 배경 2의 MySQL 수치는 **`my.ini` 파일을 읽은 값**이고 세션에 실제로 적용된 값이 아니며 collation은 **추론**이다. `news_ct`로 붙어 다음을 실행해 **실제 세션값**을 확정하고 summary에 적는다 — `SHOW VARIABLES LIKE 'lower_case_table_names'` · `'sql_mode'` · `'character_set_%'` · `'collation_%'` · `'max_allowed_packet'` · `'wait_timeout'` · `'innodb_lock_wait_timeout'` · `SELECT VERSION()`. **`my.ini`와 다르면 세션값이 정본**이고 `index.json`의 `baseline`을 그 값으로 고친다.
4. 사용자가 아직 부트스트랩을 실행하지 않았으면 이 step은 **`blocked`**로 끝낸다(추측으로 root 비밀번호를 시도하지 마라).

## Acceptance Criteria

```bash
# 1) Java 기준선 (수치를 summary에 기록)
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
# 2) 계약 기준선 (리포 루트 cwd · verify와 동시 실행 금지)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
# 3) 인벤토리 / Node 축
node scripts/contract-inventory-check.mjs --require-spec-paths
npm test
# 4) DB 비파괴
md5sum news.db
# 5) 무접촉 확인 (아래 목록 전부 diff 0)
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json news.db
```

**종료 조건(전건 충족해야 completed)**
- Java `clean verify` **BUILD SUCCESS · Failures 0 · Errors 0 · Skipped 0**이고 `Tests run` 수치를 기록했다(74 마감 기준선은 1358이며 이 브랜치의 base `9df5381`에서는 다를 수 있다 — **측정값이 정본**이다).
- `--parity` **exit 0 · profiles=5 · diffs 0**이고 **총 관측 수**를 기록했다(74 마감 기준선 313).
- `npm test` fail 0, 인벤토리 routes=39 · spec-paths=39/39.
- `news.db` md5 `7247e9e0dfe5cc8cd040ebb1dc9fb967` · 606,208 B 무변.
- `SecretHygieneTest` 신규 테스트가 green이고 **4단언 각각의 심은-변이 red 결과표가 summary에 기록**됐다. **미기록 시 이 step은 미완이다.**
- `ops/mysql/bootstrap.sql`·`docs/ops-mysql.md`가 존재하고 **실제 비밀번호 문자열이 0건**이다.
- **부트스트랩이 뒤 step의 요구를 전부 포함한다 — 아래 3항이 실측으로 확인됐다(하나라도 미확인이면 이 step은 미완이다. 뒤에서 root 재실행을 요구하면 phase가 중도 blocked가 된다)**:
  (a) `news_app`이 **`DELETE FROM ReceiverConfig` 성공 · `DELETE FROM Contents` 거부**(테이블 단위 예외가 실제로 붙었고 나머지는 막힌다)
  (b) `news_migrator`가 **`news_stage`에 `CREATE TABLE` 가능**(step3·step4의 대상 DB가 이미 존재하고 권한이 있다)
  (c) 부트스트랩 **재실행이 오류 없이 끝난다**(멱등)
- D-3의 **세션 실측값**(`SHOW VARIABLES` 8종 + `VERSION()`)이 summary에 있고, `my.ini` 추론값과 다른 항목은 `baseline`이 정정됐다.
- 세 계정 왕복 확인 결과(성공/실패 + 와일드카드 CREATE 가부)가 summary에 기록됐다.

## 검증 절차

1. A의 6커맨드를 돌리고 수치를 적는다. 계획서 `baseline`과 다르면 **`index.json`의 `baseline`을 실측값으로 고친다**(계획서 문구가 아니라 실측이 정본이다).
2. C의 비공허성 변이 4종을 심고 red를 확인한 뒤 원복한다. **변이 → 기대 → 실제**를 표로 남긴다.
3. D-2를 사용자 부트스트랩 실행 후 수행한다. 실행 전이면 blocked.
4. green 즉시 커밋한다(`git commit -F` · 경로 지정 add).

## 금지사항

- **root로 접속하지 마라.** 이유: 비밀번호를 모르고, 추측 시도는 `max_connect_errors=100`(실측)에 걸려 호스트가 차단된다.
- **비밀번호를 커맨드라인 인자·리포 파일·step summary·커밋 메시지에 쓰지 마라.** 이유: 프로세스 목록과 git 이력은 되돌릴 수 없다.
- **`pom.xml`을 고치지 마라.** 이유: 의존성 추가는 step2(마이그레이터)·step6(서버)의 소유이고, 여기서 넣으면 어느 step이 그 표면을 책임지는지 흐려진다.
- **`server-spring/src/main/**`을 고치지 마라.** 이유: 이 step은 측정·문서·테스트 그물만 소유한다.
- **리포 `news.db`를 열어 쓰지 마라(읽기도 사본으로 하라).** 이유: 원본 바이트 무변이 이 phase의 완료 게이트다.
- **`git add -A`를 쓰지 마라.** 이유: 이 브랜치에서 `.vscode/`가 섞인 전례가 있다.
