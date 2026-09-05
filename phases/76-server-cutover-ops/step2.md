# Step 2: scenario-dual-compare

## 읽어야 할 파일

- `phases/76-server-cutover-ops/index.json` — scope·**environment**(축 A/B 구분)·decisions (2)(3)(4)(7). step0·step1 summary.
- `scripts/operation-scenario.mjs` — **step1 산출물**. 이 step이 `--dual`·`--server spring`·`--db`를 더한다.
- `scripts/lib/spoolCanon.mjs` — **step0**. `diffManifests`로 두 매니페스트를 바이트 대조.
- `scripts/spring-contract.mjs` — **정본으로 삼는 형태**: (a) Spring jar를 스스로 빌드하지 않고 `server-spring/target/*.jar`를 요구 (b) `--db mysql`에서 `scripts/lib/mysqlHarness.mjs` + 마이그레이터 jar로 ephemeral `harness_ct_<16hex>`를 만들어 시드를 적재하고 Spring을 `DB_KIND=mysql`로 붙임 (c) `NEWS_CT_MYSQL_*`만 요구(없으면 sqlite 폴백 없이 즉시 실패) (d) 임시 DB는 성패 무관 정리, 실패 시 이름을 stderr로.
- `scripts/lib/mysqlHarness.mjs` — ephemeral DB 이름 규약(`^harness_ct_[0-9a-f]{16}$`)·URL 조립·비밀 길이 하한·가리기 판정부(재사용).
- `docs/ops-mysql.md` §3(자격 싣기 · 한 줄씩) · §10(계약 하네스를 MySQL로 돌리기 · 자격은 `news_ct`).
- `server-spring/README.md` — `DB_KIND`·`DATA_DIR`·`DIST_SPOOL_DIR` 기동 계약.

## 작업

step1 드라이버를 확장해 **동일 seed 행**에서 출발한 Node(SQLite)와 Spring이 **`POST /api/distribution/tick`만**으로 쓴 배부 스풀을 **정규화 후 바이트 대조**(diff 0)한다. 이것이 로드맵 P3의 "배부 스풀 산출물 바이트 대조" 게이트다. (작성→송고를 라이브로 우회하는 근거는 아래 참조 — 그 라이브 통과는 step1이 소유한다.)

`scripts/operation-scenario.mjs`에 추가:

```
node scripts/operation-scenario.mjs --dual [--db sqlite|mysql] [--keep] [--timeout <ms>]
```

- `--dual`: 배부 스풀 **바이트 대조** 모드. 두 서버가 **완전히 동일한 seed 행**에서 출발하도록, 시드에 **고정 기사 1건**(고정 `articleId`·`createdAt`·`sentAt`·`embargoAt`(과거 절대값 문자열)·`status`·본문)과 **활성 수신처 1곳**(`spoolDir` slug)을 넣는다. 임시 DB는 `src/db/schema.js`(스키마 단일 출처)로 만들고, 고정 행은 **이 시나리오 전용 seed 헬퍼**로 넣는다 — **`src/db/seed.js`의 공유 `seedUsers`를 바꾸지 마라**(spring-contract·verify-integration의 기존 시드와 313관측 baseline이 그 함수에 걸려 있어, 여기에 기사 행을 더하면 그 baseline이 회귀한다). **두 서버가 같은 seed DB에서 출발**하게 한다. 그 뒤 각 서버에 Z로 로그인해 **`POST /api/distribution/tick`만** 1회 호출하고(작성·송고를 REST로 다시 하지 않는다 — 아래 근거) 결과 스풀을 `diffManifests`로 대조한다.
  - Node: 임시 `DATA_DIR`의 SQLite에 seed → `node server/index.js` 기동.
  - Spring: `server-spring/target/*.jar`를 `DATA_DIR=<임시>`·`DIST_SPOOL_DIR=<임시>`·`PORT=<[15000,20000) 범위>`로 기동. **jar를 스스로 빌드하지 않는다**(요구만 · `spring-contract.mjs`와 동형).
  - `--db sqlite`(기본): Spring이 **같은 seed SQLite**를 연다(`DB_KIND` 기본). **MySQL·자격 불요** — Spring 기동에 JDK 25만 필요.
  - `--db mysql`: `mysqlHarness.mjs` + 마이그레이터 jar로 패스 전용 ephemeral `harness_ct_<16hex>`를 만들어 **같은 seed SQLite**를 적재하고 Spring을 `DB_KIND=mysql`로 붙인다(spring-contract.mjs 경로 재사용). 자격은 `NEWS_CT_MYSQL_*`만. 임시 DB는 성패 무관 정리.
- **작성→송고를 대조에서 우회하는 이유(정직한 경계)**: 두 서버는 `articleId`를 **서버가 난수 생성**하고(`generateArticleId` — 9자리 난수) `createdAt`(작성)·`sentAt`(송고)를 각각 **서버 벽시계**(`src/services/articleService.js`의 `nowISO()` · L150·L227)로 찍는다. 두 라이브 실행은 다른 시각·다른 난수라 **구조적으로 갈리므로** 라이브 루프로는 diff 0이 원천 불가능하다. 그래서 대조는 **동일 seed 행 + tick만**으로 결정성을 확보한다. **작성→송고→배부→수집의 라이브 통과 증명은 step1**(단일 대상 전체 루프)이 소유하고, **create/send의 Node↔Spring 응답 패리티는 계약 스위트**(`articles-write.contract.js`·`distribution-tick.contract.js` · 313관측)가 이미 소유한다. 이 step은 그 위에서 **스풀 writer의 직렬화 파일 파리티**(필드 allowlist·키 순서·JSON 이스케이프·숫자 표기·MySQL 왕복 값 표현)만 격리 판정한다.
- **정규화 경계(단 하나)**: seed가 `articleId`·`createdAt`·`sentAt`·`embargoAt`·`secondEmbargoAt`를 **양쪽 동일한 절대값**으로 고정한다. `embargoAt`/`secondEmbargoAt`는 요청/시드가 주는 **절대 문자열**이지 서버 파생이 아니다(`articleService.create`가 `pick(dto, CONTENTS_FIELDS)`로 그대로 저장 · L153). 따라서 **tick 시점에 서버 `nowISO()`로 찍히는 `distributedAt` 값과 파일명의 그 타임스탬프, 그 둘만** 볼러타일이고 step0 정규화가 흡수한다. **그 외 어떤 필드도 정규화하지 마라** — 값이 갈리면 그것은 실제 divergence(예: MySQL 왕복 숫자 표기)이고 **기록** 대상이지 은폐 대상이 아니다(decisions (3)).
- **대조**: `diffManifests(nodeManifest, springManifest)`가 `equal: true`가 아니면 **비-0 종료**하고 diff를 위생 형태(값 원문 없이)로 보고한다.
- **데이터 안전**: 리포 `news.db`·`uploads/` 무변 단언(step1과 동일). ephemeral DB만 만지고 운영 `news`·`news_stage`에 **쓰지 않는다**.

## Acceptance Criteria

```bash
# --- 축 B(개발 머신 실행 환경 · 포터블 JDK 25) ---
# 1) jar 준비(하네스는 스스로 빌드하지 않는다)
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests
cd tools/news-migrator && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests

# 2) sqlite 모드 이중 대조 — MySQL 불요(JDK 25만)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/operation-scenario.mjs --dual --db sqlite   # exit 0 · 스풀 diff 0

# 3) (확장) mysql 모드 — docs/ops-mysql.md §3로 NEWS_CT_MYSQL_* 만 싣고(NEWS_DB_* 금지)
SPRING_JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" node scripts/operation-scenario.mjs --dual --db mysql   # exit 0 · 스풀 diff 0 · 잔존 harness_ct_* 0

# --- 회귀(컨테이너에서도 가능) ---
node --test scripts/lib/spoolCanon.test.mjs
npm run lint && npm test
```

> 실행 환경 주의: 축 B AC는 phase 75가 확립한 개발 머신에서 돈다(포터블 JDK 25 · 로컬 MySQL 8.0.46 · 리포 밖 `D:/agents/secrets/news-mysql.env`). 그 환경이 아니면 해당 AC는 **blocked**로 기록하고 사유를 남긴다(추측 green 금지).

## 검증 절차

1. jar 2개를 빌드한 뒤 위 AC를 순차로 실행한다(하네스와 `mvnw`를 동시에 돌리지 마라 — 포트·MySQL 경합).
2. 실행 후 리포 `news.db`가 **있으면 md5 무변 / 없으면 생성 0**(컨테이너에는 `.gitignore`로 부재), 잔존 `harness_ct_*` 0개(`--db mysql` 시)를 확인한다.
3. 아키텍처 체크리스트:
   - 스풀 대조가 diff 0인가? diff가 있으면 **정규화로 숨기지 말고** 규명해 divergence로 기록한다.
   - ephemeral DB만 만졌는가(운영 `news`·`news_stage` 무접촉)?
   - `contract/**`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`package.json`·앱 코드 무접촉인가?
4. **정직한 공백 명시**: `--db mysql`은 `news_ct`(ALL)로 ephemeral DB에서 돌아 `GRANT DELETE ON <db>.ReceiverConfig` 부재를 **볼 수 없다**(decisions (2)). 이 사실을 summary에 적는다.
5. step 2를 업데이트한다(completed→summary / error→error_message / blocked→blocked_reason).

## 금지사항

- 스풀 diff를 정규화 대상 확대로 덮지 마라. 이유: 계약 패리티가 못 보던 파일 레벨 divergence를 조용히 삼키면 이 phase의 유일한 파일 대조 게이트가 공허해진다. `distributedAt`과 파일명 타임스탬프 **둘만** 정규화한다(decisions (3)).
- `src/db/seed.js`의 공유 `seedUsers`에 기사·수신처 행을 더하지 마라. 이유: spring-contract·verify-integration이 그 함수에 걸려 있어 313관측 baseline이 회귀한다 — 고정 seed는 시나리오 전용 헬퍼로 넣는다.
- Spring/마이그레이터 jar를 하네스가 스스로 빌드하게 만들지 마라. 이유: `spring-contract.mjs`의 확립된 계약(요구만)과 어긋나고 빌드 실패가 대조 실패로 오독된다.
- 운영 `news`·`news_stage`에 쓰지 마라. 이유: DB 비파괴·스테이징 드리프트 방지. ephemeral `harness_ct_*`만 쓴다.
- `NEWS_DB_*`를 셸에 통째로 싣지 마라. 이유: `DB_KIND` 없이 `NEWS_DB_URL`만 남으면 kind/URL 모순으로 Spring 기동이 거부된다(설계된 거부).
- 계약 정본·앱 코드·`package.json`·`pom.xml`을 고치지 마라(새 의존성 0).
- 기존 테스트를 깨뜨리지 마라.
