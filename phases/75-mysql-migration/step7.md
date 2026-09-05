# Step 7: harness-mysql-parity — **GREEN**

계약 하네스가 **Spring을 MySQL로 띄운 채** Node(SQLite) 대비 **313관측 diffs 0**을 내게 만든다. 이 step이 「이관이 동작을 바꾸지 않았다」를 기계로 증명하는 유일한 지점이다.

## 읽어야 할 파일

- `phases/75-mysql-migration/index.json` · `step2.md`·`step3.md`·`step6.md`와 각 summary
- `scripts/spring-contract.mjs` **807행 전문**(특히 `runSpringPass` 498~610행 · `runNodePass` 610~630행 · 메인 루프 650~800행 · `javaChildEnv` 355~365행 · 리포 스냅샷 713~780행)
- `scripts/contract-run.mjs` **무수정 정본** — 특히 `judgeCoverage`(451~473행)와 외부 대상 모드(`--base-url-map`·`--credentials`) 진입점
- `contract/lib/record.js` 103~127행
- `src/db/schema.js` · `src/db/seed.js` (하네스가 시드에 쓰는 **단일 출처**)
- `tools/news-migrator/` CLI 계약(step2·step3)
- `docs/ops-mysql.md`

## 배경 (동결된 사실 — 설계를 강제하는 제약들)

1. **`package.json`은 무수정이다** ⇒ Node 하네스에 MySQL 드라이버를 넣을 수 없다. `spring-contract.mjs`가 쓸 수 있는 것은 **내장 모듈**(`node:sqlite` 포함)과 **자식 프로세스**뿐이다. ⇒ **MySQL은 오직 마이그레이터 jar를 통해서만 만진다.** (`mysql.exe` 경로에 의존하지 마라 — 그 설치 경로는 이 머신의 사정이다.)
2. **`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`는 무수정 정본**이다. 러너는 외부 대상 모드(`--base-url-map`·`--credentials`)로 이미 「이미 떠 있는 서버」를 시험할 수 있다 ⇒ **러너는 대상 서버가 어떤 DB를 쓰는지 알 필요가 없다.** 하네스만 바뀌면 된다.
3. **현재 시드 경로**(실측 `runSpringPass` 512~520행): 임시 `DATA_DIR` 생성 → `new DatabaseSync(<dataDir>/news.db)` → `createSchema(db)` → `seedUsers(db)`. **이 경로를 지우지 마라** — 스키마·시드의 단일 출처가 `src/db/schema.js`·`src/db/seed.js`라는 사실이 유지돼야 Node 대조가 같은 데이터에서 출발한다.
4. **Node 대조 패스는 언제나 SQLite다**(Node 서버 무수정). 즉 이 step의 green은 **Node(SQLite) vs Spring(MySQL)** 비교이고, 그것이 정확히 우리가 원하는 판정이다.
5. `--dual-run`은 **패스마다 새 `DATA_DIR` + 새 프로세스**를 요구한다(자기 결정성). MySQL 모드에서는 **패스마다 새 DB**여야 같은 의미가 된다.
6. 하네스는 리포 `news.db`·`uploads/` 스냅샷을 실행 전후로 떠 무변을 단언한다 — 그 규율을 유지·확장한다.
7. **기준선(2026-09-02 이 브랜치에서 재측정)**: `--parity` exit 0 · profiles=5 · **313관측 diffs 0**(default 246 cases=209 covered=32/39 · minimal 55 cases=53 · auth-negative 4 · failclosed 5 · prod-cookie 3).

## 작업

### A. `--db <sqlite|mysql>` 옵션 (기본 `sqlite` — 기존 커맨드는 한 글자도 바뀌지 않는다)

`mysql`일 때 `runSpringPass`의 절차를 이렇게 바꾼다:

1. 지금과 **똑같이** 임시 `DATA_DIR`에 SQLite를 시드한다(`createSchema` + `seedUsers`) — 이것이 MySQL 적재의 **입력**이다.
2. **패스마다 새 ephemeral DB 이름**을 만든다: `harness_ct_<16 hex>`. 이름은 stdout에 남긴다(`--dual-run`의 두 패스가 정말 다른 DB인지 눈으로 확인 — 지금 `dataDir`·pid·port를 남기는 것과 같은 규율).
3. 마이그레이터 jar를 자식 프로세스로 호출: `ephemeral-create` → `migrate --source <임시 news.db> --target <그 DB>`. **비밀번호는 argv가 아니라 자식 env로만** 넘긴다.
4. Spring을 `DB_KIND=mysql` + `NEWS_DB_URL/USERNAME/PASSWORD`(그 ephemeral DB를 가리킨다) + 기존 `DATA_DIR`(업로드용) + 기존 축(포트·HOST·스풀·토큰)으로 띄운다.
   - **⚠ 그 `NEWS_DB_*`에 넣는 값은 `news_ct` 자격이다**(`NEWS_CT_MYSQL_*`에서 파생). `news_app`을 쓰지 마라 — 그 계정은 `harness_ct_*`에 **권한이 0**이라 기동조차 못 한다(`SchemaGuard`가 첫 조회에서 죽는다). 즉 **하네스 경로는 `news_app`의 최소 권한을 검증하지 않으며**, 그 검증은 step6 A가 `news_stage`에서 따로 소유한다.
   - Spring 자식 env의 `NEWS_DB_URL`은 **패스마다 다른 DB 이름**을 가리켜야 한다(고정값을 쓰면 `--dual-run` 두 패스가 같은 DB를 공유한다).
5. 러너 호출은 **지금과 동일**하다(외부 대상 모드).
6. `finally`에서 **항상** `ephemeral-drop`을 부른다(성패·`--keep` 무관. 실패하면 이름을 stderr에 남겨 사람이 지울 수 있게 한다 — 비밀 파일 삭제 실패 처리와 같은 형태).

### B. 자격증명·비밀 취급

- 하네스는 `NEWS_CT_MYSQL_URL`·`NEWS_CT_MYSQL_USERNAME`·`NEWS_CT_MYSQL_PASSWORD`를 **자기 프로세스 env에서만** 읽는다. 없으면 `--db mysql`에서 **즉시 실패**(조용한 sqlite 폴백 금지 — 그러면 게이트가 통째로 공허해진다).
- 비밀번호를 **stdout·리포트·`targets.json`·`creds.json`·진단 메시지 어디에도 싣지 마라.** 로그에는 **불리언·DB 이름**만(현재 `token=yes/no` 규율과 동일).
- `javaChildEnv()`가 지우는 키 목록에 MySQL 키가 잘못 섞이지 않게 하되, **Spring 자식에게 넘기는 값은 명시 대입만** 한다.

### C. 데이터 안전 단언 확장

- 기존 리포 `news.db`·`uploads/` 스냅샷 유지.
- **추가**: MySQL 패스가 끝난 뒤 **임시 `DATA_DIR`의 `news.db`가 바이트 무변**임을 단언한다. 이것이 「mysql 모드의 Spring이 SQLite를 열지 않았다」의 실증이다(적재 이후 시점을 기준으로 md5를 뜬다).
- **추가**: ephemeral DB 이름이 `^harness_ct_[0-9a-f]{16}$`가 아니면 **만들지도 지우지도 않는다**(하네스 쪽에도 같은 정규식을 둔다 — 마이그레이터의 가드와 이중).

### D. 러너 집계 규율 유지

- `--require-full-coverage`(74가 신설한 Spring 합산 게이트)는 `--db mysql`에서도 그대로 동작해야 한다. **판정 규칙의 정본은 `contract-run.mjs`의 `judgeCoverage`이고 하네스의 것은 복제**다(74 forward_notes (2)) — 복제를 손대야 한다면 정본과 어긋나지 않는지 확인하라.
- 합산 대상은 **Spring 리포트만**이다(Node 리포트·dual-run b 패스를 섞으면 게이트가 조용히 공허해진다).

### E. 실행 시간

MySQL 패스는 패스마다 마이그레이터를 2~3회 호출한다. `--parity`(5 패스)·`--dual-run`(10 패스)의 **실측 소요 시간을 기록**하고, 눈에 띄게 느려지면 배치·연결 재사용으로 줄이되 **구조(패스마다 새 DB)는 바꾸지 마라**.

## Acceptance Criteria

```bash
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
# 1) 기존 경로 무회귀 (기본 sqlite)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --parity
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --dual-run
# 2) GREEN — MySQL 패리티
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --db mysql --parity
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --db mysql --dual-run
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/spring-contract.mjs --db mysql --require-full-coverage
# 3) 무접촉·데이터 안전
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json
md5sum news.db
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
```

**종료 조건**
- **`--db mysql --parity` exit 0 · profiles=5 · 313관측 diffs 0**(default 246 · minimal 55 · auth-negative 4 · failclosed 5 · prod-cookie 3 — **관측 수가 sqlite 모드와 정확히 같아야 한다**. 하나라도 줄면 케이스가 조용히 건너뛰어진 것이다).
- **`--db mysql --dual-run` 313관측 diffs 0**이고 10 패스의 **DB 이름·pid·port·DATA_DIR이 전부 상이**함이 로그로 확인된다.
- `--db mysql --require-full-coverage` **covered 39/39 · 미커버 0쌍**.
- 기본(sqlite) `--parity`·`--dual-run` **313관측 diffs 0 무회귀**.
- `contract-run.mjs`·`contract-diff.mjs`·`contract/**`·`docs/api-contract/**`·`package.json`·Node 축 전부 **diff 0**.
- 리포 `news.db` md5 무변 · `uploads/` 무변 · **잔존 `harness_ct_*` DB 0개**(실행 후 목록으로 확인).
- Java `clean verify` BUILD SUCCESS · Skipped 0.
- **변이 전건 결과표 기록.** 미기록 시 미완.

## 검증 절차

**변이 검증(최소 10종 · M1a/M1b는 분리 필수)** — 심어 red를 보고 원복한다. **이 step의 변이는 「게이트가 정말 MySQL을 보고 있는가」를 겨냥한다.**
- **M1a: `DB_KIND` 주입만 뺀다.** step5 A의 「`kind`와 URL이 모순이면 기동 거부」에 **먼저 걸려** Spring이 아예 뜨지 않을 것이다(그러면 C의 md5 단언은 **실행조차 되지 않는다**). 그 거부가 실제로 나는지 확인하고 기록하라 — 이것은 방언 게이트의 실증이 **아니다**.
- **M1b(본 실증): `DB_KIND=sqlite`로 두고 `NEWS_DB_*`를 아예 주입하지 않는다.** 모순이 없으므로 Spring은 **정상적으로 sqlite로 뜬다** — 즉 `--db mysql` 실행인데 서버는 SQLite를 쓰는 상태다. 이때 **계약이 green인지 red인지**를 보고, **C의 「임시 `DATA_DIR`의 `news.db` 바이트 무변」 단언이 red를 내는지**를 확인한다. 계약이 green이고 md5 단언도 red를 못 내면 **`open_questions (9)`의 방어가 공허**하다는 뜻이므로, 그 사실을 forward_notes **1급 항목**으로 올리고 대체 방어(예: 기동 로그의 방언 표기 검사 · `/api/health` 이전에 서버가 보고하는 방언 표식)를 이 step에서 만들어라.
- M2: `migrate` 호출을 건너뛰어 **빈 MySQL DB**로 띄우면 red인가(어떤 관측이 먼저 깨지는가).
- M3: 시드 사용자 1명을 빼면 red인가.
- M4: `ephemeral-drop`을 지우면 잔존 DB 확인이 red인가.
- M5: ephemeral 이름 정규식을 넓히고 `news`를 넘기면 **거부되는가**(하네스·마이그레이터 양쪽에서).
- M6: `NEWS_CT_MYSQL_PASSWORD`를 지우고 `--db mysql`을 돌리면 **즉시 실패**하는가(sqlite로 조용히 폴백하면 red여야 한다).
- M7: 비밀번호를 stdout에 찍는 코드를 넣으면 어떤 단언이 잡는가 — 없다면 **비밀 유출 스캔을 하네스 출력까지 넓혀라**.
- M8: `--dual-run`의 두 패스가 **같은 DB 이름**을 쓰게 하면 자기 결정성 판정이 어떻게 되는가(diff가 나는가, 아니면 조용히 통과하는가).
- M9: `--require-full-coverage`의 합산에 Node 리포트를 섞으면 미커버가 사라지는가(74가 경고한 함정의 재확인).

flake는 **재실행 2회 연속 green**으로 판정한다. green 즉시 커밋한다.

## 금지사항

- **`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`contract/**`·`docs/api-contract/**`를 고치지 마라.** 이유: 정본을 고쳐 통과시키면 패리티 판정이 자기 자신을 증명하는 순환이 된다.
- **`package.json`에 의존성을 추가하지 마라.** 이유: 무수정 목록이며, 그 제약이 이 설계(마이그레이터 CLI 경유)를 만든 근거다.
- **`--db mysql`에서 sqlite로 폴백하지 마라.** 이유: 폴백은 「green인데 아무것도 검증하지 않은」 상태를 만든다 — 이 리포에서 정적 스캔이 매번 공허했던 것과 같은 실패 양식이다.
- **운영 `news` DB나 `harness_ct_` 접두사 밖의 DB에 접속하지 마라.** 이유: 하네스는 실행마다 DB를 만들고 지운다. 접두사 규약과 grant가 그 폭발 반경을 가두는 유일한 장치다.
- **`mvnw verify`와 이 하네스를 동시에 돌리지 마라.** 이유: 와이어 63건이 500으로 무너진 실측이 있다.
- **jar를 빌드하지 않고 하네스를 돌리지 마라.** 이유: `spring-contract.mjs`는 jar를 스스로 빌드하지 않는다 — 소스를 고친 뒤에는 `package -DskipTests`가 선행이다.
