# Step 5: spool-byte-parity

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` — `baseline` (F) · `decisions` (8)(12)(13)
- `docs/ADR.md` **ADR-008**(파일 스풀 outbound · 앱 내 타이머/egress 금지 · tick pull)
- **Node 정본**: `src/services/spoolWriter.js` 전문(필드 allowlist · `pick` 의미론 · `compactStamp` · 원자 게시) · `src/services/spoolDir.js` · `src/services/distributionService.js`
- **Spring 대응**: `server-spring/src/main/java/harness/news/service/SpoolWriter.java` 전문(특히 `MAPPER`·`LowercaseHexEscapes`·`payload()`·`write()`) · `SpoolDir.java` · `DistributionService.java` · `DistributionTickService.java`
- `server-spring/src/test/java/harness/news/service/SpoolWriterTest.java`(현재 유일 방어선 — **바이트 단언이지만 Node 산출물과의 대조는 아니다**) · `GatedSpoolWriter.java`
- `contract/cases/default/distribution-tick.contract.js` — 특히 `assertNoSpoolPath`(**62~70행** — 4단언: `spoolDir` 키·수신처 슬러그·`.json` 파일명·경로 구분자) — **계약이 스풀 파일을 보지 않는다는 증거**
- `scripts/spring-contract.mjs` — 프로파일별 `DIST_SPOOL_DIR` 주입 자리(686행 부근) · 임시 `DATA_DIR` 시드 절차
- `phases/76-spring-cutover/step3.md`(두 서버를 같은 시드로 띄우는 절차가 이미 확립돼 있다)
- `docs/ARCHITECTURE.md` 68~84행([배부]·[tick]·[실패복구] 흐름)

## 배경

로드맵 P3의 완료 게이트 둘째는 **"배부 스풀 산출물 바이트 대조"** 다. 그것이 게이트인 이유는 **아무도 그 바이트를 보지 않기 때문**이다:

- 계약 스위트는 **응답에 스풀 경로가 실리지 않음**을 단언한다(정반대 방향의 관측이다).
- `--parity`는 HTTP 응답만 비교한다.
- Java `SpoolWriterTest`는 **자기 기대값**과 비교한다. Node 산출물과 대조한 적이 없다.

두 구현은 서로를 보고 옮겨 적은 것이다: 필드 allowlist 18키 + `markupVersion` + `articleId` + `title` 폴백 + `distributedAt`, **키 순서가 곧 파일 내용**, `pick`은 값이 `null`이면 **키 자체를 뺀다**(API 투영의 'NULL 키 보존'과 정반대다), JSON은 공백 없음·비ASCII 그대로·`\u00XX` 16진수는 **소문자**. 이 중 **하나라도 어긋나면 외부 전송기가 받는 파일이 달라지고, 컷오버 당일에는 아무도 모른다.**

**비결정 요소는 정확히 둘이고 같은 값에서 나온다**(decisions (8)): 파일명의 `compactStamp(stamp)`와 페이로드 마지막 키 `distributedAt`. Node `src/services/spoolWriter.js` **60행** `const stamp = now()` · Java `SpoolWriter.java` **145행** `String stamp = Iso8601.now(this.clock)`(좌표는 2026-09-05 재확인 — 초안의 62/148은 오기였다). HTTP 경계에는 시계 주입 경로가 **없다**(계약이 `injectedClockRejected`를 관측한다). 그래서 대조는 **정규화 + 정합성 단언 3겹**이다.

## 작업

### A. 신규 스크립트 `scripts/spool-parity.mjs`

절차:

1. 리포 밖 임시 루트를 만든다. Node용·Spring용 **각각의** `DATA_DIR`과 **각각의** `DIST_SPOOL_DIR`.
2. **같은 시드**에서 출발한다 — 스키마·시드의 단일 출처는 `src/db/**`다(`spring-contract.mjs` decisions (4)의 규율을 그대로 따른다). MySQL 축으로도 돌리려면 마이그레이터 jar로 시드 SQLite를 임시 `harness_ct_<16hex>` DB에 적재하는 **75의 경로를 그대로** 쓴다(새 경로를 발명하지 마라).
3. 두 서버를 띄운다(각자 빈 포트 · `DIST_SPOOL_DIR` 주입 · `SPA_DIR` 미주입).
4. **같은 시나리오를 두 대상에 재생**한다. 최소 5축:
   - (가) **엠바고 없는 일반 기사 송고** → 즉시 언론사+비언론사 전체 배부(DPS).
   - (나) **2차 엠바고만** → 언론사 즉시 배부(EPS).
   - (다) **1차 엠바고** → 배부 대기(DES) 후 **tick**으로 시점 배부.
   - (라) **재전송**(`POST /api/distribution/retry`)으로 같은 수신처에 다시 쓰기.
   - (마) **한글·이모지·따옴표·개행·백슬래시·제어문자**가 든 본문/제목(이스케이프 축이 갈리는 자리다. 75 forward_notes (5) ⑤가 '이모지·서로게이트는 재지 않았다'고 남긴 공백을 여기서 일부 메운다).
   - 기사 id는 서버가 만든다 — **양쪽에서 같은 id가 나오지 않는다**. 그래서 파일 짝짓기는 **파일명 전체가 아니라 (수신처 폴더, 정렬 순서)** 또는 페이로드의 `articleId`를 **양쪽에서 각각 읽어** 대응시켜야 한다. **정렬로 짝짓지 마라 — 75의 교훈 (10) ③과 같은 계열의 함정이다.** 시나리오가 기사 1건씩 순차로 만들면 대응이 결정적이 된다(그 설계를 택하라).
5. **대조**: 수신처 폴더 집합 · 폴더별 파일 수 · 각 파일의 **정규화 후 바이트**.

### B. 정규화와 정합성 3겹 (decisions (8))

각 파일에 대해 **양쪽 각각에서** 다음을 한다:

1. **형식 단언**: `distributedAt`이 ISO-8601 밀리초 UTC(`YYYY-MM-DDTHH:MM:SS.sssZ`)인가.
2. **정합 단언**: 파일명의 stamp가 `distributedAt`에서 `-`·`:`·`.`를 제거한 값과 **정확히 같은가**.
3. **정규화 후 대조**: `distributedAt` 값과 파일명 stamp를 고정 자리표시자로 치환한 뒤 **나머지 전 바이트가 동일한가**.

그리고 **`articleId`도 양쪽이 다르므로** 같은 방식으로 자리표시자 처리하되, **자리표시자로 바꾼 자리 수를 출력**하라(몇 자리를 눈감았는지 모르면 대조가 공허해진다). 자리표시자 대상은 **정확히 `distributedAt`·파일명 stamp·`articleId`(그리고 그 파생인 `title` 기본값 등이 있다면 명시) 뿐**이고, 그 목록은 **상수 1곳**이 소유하며 테스트가 그 **집합**을 단언한다(개수만 세지 마라 — 75 `DialectSeamTest`의 규율).

### C. 자기검사

순수 판정부(정규화·짝짓기·비교)를 분리하고 `node --test` 자기검사를 둔다. 최소: 같은 파일 2벌 → 0 · 키 순서만 다른 2벌 → **1 이상**(순서가 곧 산출물이다) · `\uAC00` 대소문자만 다른 2벌 → **1 이상** · 자리표시자 목록에 없는 키가 다르면 → **1 이상** · 파일 수가 다르면 → 즉시 실패.

### D. 문서

- `docs/cutover-p3.md` §4: 무엇을 대조하는가 · **무엇을 눈감았는가(자리표시자 3종)와 그 대신 무엇을 단언하는가** · 실행 커맨드 · 실패 시 읽는 법.
- `server-spring/README.md`의 ADR-008 절에 "스풀 산출물의 Node 대조는 `scripts/spool-parity.mjs`가 유일 방어선"을 명시(파일·커맨드 이름으로).

## Acceptance Criteria

```bash
# 0) jar 최신화
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests

# 1) 스풀 바이트 대조 — exit 0 · diffs 0
node scripts/spool-parity.mjs

# 2) MySQL 축으로도 (Spring이 MySQL을 열어도 스풀 바이트가 같은가)
node scripts/spool-parity.mjs --db mysql

# 3) 자기검사
node --test <자기검사 파일 경로>

# 4) 무회귀
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --db mysql --parity
node scripts/spa-parity.mjs

# 5) 무접촉
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json   # 무출력
```

- 1·2번이 **exit 0**이고 **대조한 파일 수 · 자리표시자로 눈감은 자리 수**를 출력한다.
- 실행 후 임시 디렉토리·자식·잔존 `harness_ct_*` **0**.
- **변이 전건 결과표(필수)** — 최소 8종. **Java 측 변이는 심고 → 빌드 → 대조 → 원복 → 바이트 동일 확인** 순이다:
  - **Q1** Java `CONTENTS_FIELDS`에서 키 1개 제거 → 기대: diff(그 키가 빠진 파일).
  - **Q2** Java `payload()`의 키 **순서** 변경(예: `markupVersion`을 앞으로) → 기대: diff. **키 순서가 산출물임을 실증한다.**
  - **Q3** `LowercaseHexEscapes` 제거(대문자 `\u00XX`) → 기대: diff. (한글·이모지 표본이 시나리오 (마)에 있어야 이 변이가 유의미하다 — 없으면 무해해진다. **이 함정을 확인하라**: 75 교훈 ⑤와 같은 계열.)
  - **Q4** `pick` 의미론 뒤집기(값이 null이어도 키를 남김) → 기대: diff.
  - **Q5** `internalComment`(내부코멘트) 또는 잠금 컬럼을 allowlist에 추가 → 기대: diff. **이 변이는 보안 축이다** — 잠금 컬럼에는 유효 세션 토큰이 들어 있다(`SpoolWriter` javadoc). 대조기가 **새 키가 늘어난 경우**를 잡는지 실증하라(allowlist가 아니라 blacklist로 비교하면 못 잡는다).
  - **Q6** 대조기의 자리표시자 목록에 `title`을 추가 → 기대: Q1~Q5 중 일부가 **조용히 통과**(대조기 공허화 실증 · 무엇을 눈감으면 무엇이 안 보이는지 기록).
  - **Q7** 정합 단언(파일명 stamp ↔ `distributedAt`) 제거 → 기대: 파일명 stamp를 엉뚱한 값으로 바꾼 변이가 통과. 두 변이를 조합해 실증하라.
  - **Q8** Node 대상 스풀 디렉토리를 Spring 것과 **같게** 준다(둘 다 같은 폴더에 쓴다) → 기대: 대조기가 **즉시 실패**(파일 수 배증·짝짓기 붕괴를 잡는가).
  - 각 변이에 기대/실제/원복 확인(**원복 후 `cmp` 바이트 동일**).
- **추가 실측 기록**: Q1·Q2·Q5를 심은 채 `--parity`(계약)와 `npm test`를 돌려 **둘 다 green인지** 재라. green이면 "배부 산출물은 계약도 backend 테스트도 못 보는 축"이 이 phase의 실측으로 확정된다.

## 검증 절차

1. 첫 실행은 `--keep`류 옵션(있다면)으로 산출물을 남겨 **사람이 한 파일을 직접 열어 본다**(키 순서·한글 표기·이스케이프를 눈으로 확인. 자동 판정 전에 한 번은 봐야 한다).
2. 두 대상의 파일 수가 다르면 **먼저 시나리오를 의심하라**(대상 활성 여부·엠바고 판정·tick 호출 순서). 구현 차이로 단정하기 전에 시나리오 로그를 봐라.
3. 연속 2회 실행해 자기 결정성을 본다.
4. 실행 전후 리포 `news.db`·`uploads/` 지문 대조.

## 되돌림 절차

새 스크립트 삭제로 끝난다(런타임 코드 0줄 변경). **단, 변이 실험에서 `server-spring/src/main`을 건드렸으므로 각 변이 원복 후 `git diff`가 무출력인지 반드시 확인하라** — 미원복 변이가 남으면 다음 step이 그 위에서 돈다(75가 실제로 겪은 사고 계열).

## 금지사항

- **시계를 주입하려고 `server/**`·`src/**`·계약을 고치지 마라.** 이유: 무수정 정본이고, 계약은 오히려 시계 주입 거부를 관측한다. 정규화 3겹이 그 대신이다.
- **자리표시자 목록을 늘려 diff를 없애지 마라.** 이유: 그 순간 대조가 공허해진다(Q6가 그것을 실증한다). 늘려야 한다면 **왜·무엇을 대신 단언하는지**를 문서에 적어라.
- **파일 짝짓기를 정렬로 하지 마라.** 이유: 양쪽 `articleId`가 다르고 파일명이 시각을 담아 정렬이 우연히 맞을 뿐이다(75 교훈 ③과 같은 함정).
- **`DIST_SPOOL_DIR`를 리포 안이나 운영 스풀로 주지 마라.** 이유: 외부 전송기가 실제로 그 폴더를 걷어 간다 — 테스트 파일이 **진짜로 발송된다**.
- **Spring에 배부 자동 재시도·타이머·큐를 추가하지 마라.** 이유: ADR-008 (6). 재전송은 Z의 명시 실행뿐이다.
- **`Adr008DisciplineTest`의 파일 쓰기 예외 목록(2파일)을 넓히지 마라.** 이유: 이 step은 새 파일 쓰기 지점을 만들지 않는다(대조기는 `scripts/`에 있고 main 소스가 아니다).
