# Step 3: spa-parity-probe

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` — `baseline` (A)(G) · `decisions` (3)(4)(12)(13)
- `phases/76-spring-cutover/step2.md` — 이 step은 step2가 만든 서빙 면을 **Node와 대조**한다
- `test/spa-serving.test.js` — Node 규칙의 정본(무접촉 · 명세서로 읽는다)
- `server/index.js` 1219~1238행 · 174~250행
- `scripts/spring-contract.mjs` — **환경 조립부**(`javaChildEnv()` 허용 목록 · `runnerChildEnv()`의 `SPA_DIR` 삭제 · 임시 `DATA_DIR` 시드 · 빈 포트 프로브 `[15000,20000)` · 자식 종료·정리) — **이 step은 이 파일을 고치지 않는다. 절차를 베낀다.**
- `scripts/lib/mysqlHarness.mjs`(순수 판정부 분리 + 자기검사 패턴 — 새 하네스의 형태 참고)
- `docs/ops-mysql.md` §10(계약 하네스를 MySQL로 돌리기)

## 배경

step2는 "Spring이 Node의 규칙대로 서빙한다"를 **Java 테스트로** 주장한다. 그러나 그 테스트의 기대값은 사람이 Node 코드를 읽고 옮겨 적은 것이다 — **옮겨 적기가 틀렸다면 테스트는 틀린 기대를 green으로 지킨다.** 이 리포가 그 실패를 이미 여러 번 겪었다(73의 `URLSearchParams` 인코딩 — 계획서가 "무영향"이라고 적은 축이 실측에서 반증됐다).

**대조군이 있는데 쓰지 않을 이유가 없다.** Node 서버는 살아 있고 같은 `web/dist`를 서빙할 수 있다. 그래서 이 step은 **두 서버를 같은 SPA 루트로 띄우고 같은 요청을 보내 응답을 바이트로 대조**한다. 계약 하네스(`contract-run.mjs`)는 SPA를 보지 않으므로(하네스가 `SPA_DIR`을 넘기지 않는다 — 그리고 **그것을 고치면 안 된다**) 이 대조는 **별도 스크립트**여야 한다.

이 step이 만드는 것은 **P3의 '실운영 시나리오 통과'를 지탱하는 첫 기계 판정**이다. 화면이 뜨는지를 사람 눈이 아니라 바이트가 판정한다.

## 작업

### A. 신규 스크립트 `scripts/spa-parity.mjs`

`spring-contract.mjs`의 **절차를 본뜨되 그 파일을 고치지 않는다**(정본 이원화를 피하려면 공용 부분은 `scripts/lib/`로 뽑아도 좋다 — 다만 `spring-contract.mjs`를 건드리면 계약 하네스 회귀 위험이 생기므로 **이번에는 뽑지 말고 필요한 만큼만 새로 쓰는 쪽을 기본으로 한다**).

절차:

1. **임시 작업 루트를 리포 밖**(OS 임시 디렉토리)에 만든다. 리포 `news.db`·`uploads/`에 **절대 바인딩하지 않는다**.
2. Node 서버를 띄운다: 임시 `DATA_DIR`(스키마·시드는 `src/db/**`의 단일 출처 사용) · `SPA_DIR=<리포>/web/dist` · 빈 포트.
3. Spring을 띄운다: **같은 `SPA_DIR`** · 별도 임시 `DATA_DIR` · 별도 빈 포트 · `DB_KIND=sqlite`(이 step은 SPA 축만 본다 — 저장소 축은 계약이 이미 본다).
4. **요청 표**를 두 대상에 각각 보내고 응답을 기록한다. 요청은 **원문 요청줄**로 보낸다(정규화된 클라이언트를 쓰면 인코딩 변형을 시험할 수 없다).
5. 리포트 2벌을 만들어 **기계 비교**하고, 차이를 `only-in-A`/`only-in-B`/`value-diff`로 출력한다.
6. 두 자식 프로세스를 확실히 죽이고 임시 디렉토리를 지운다(kill → 확인 → SIGKILL 폴백 — `spring-contract.mjs`의 규율).

**요청 표(최소 30건)** — 각 항목은 `{name, method, rawPath, headers}`:

- `/` · 7개 `.do` 경로 · `?query` 붙은 `.do` · `HEAD /list.do`
- `/assets/<실제 파일명>` · `/assets/does-not-exist.js`(Accept `*/*`) · `/index.html`
- `/api/health` · `/api/articles`(미인증) · `/api/unknown-path` · `/api/does-not-exist` · `/API/unknown`
- `/uploads/missing.png`
- `POST /list.do`(Accept text/html)
- 경로 탈출 변형 6종 이상(`/../`, `%2e%2e%2f`, 이중 인코딩, 백슬래시, 널바이트 인코딩, 후행 슬래시)
- dotfile 2종(`/.hidden/x`, `/.env`)
- 후행 슬래시·경로 파라미터(`/list.do;a=b`)·대소문자 변형(`/List.do`)

**비교 대상(리포트에 싣는 것)**: `status` · `content-type` **원문 문자열** · `content-length` 유무 · **본문 바이트의 sha256** · 본문이 `index.html`과 같은가(불리언) · 본문 길이 · **보안 헤더 11종의 원문**(아래).

**보안 헤더는 반드시 관측·출력한다(② 검토 반영 — 초안의 결함이었다).** 초안의 비교 대상에는 헤더가 `content-type`뿐이어서, **Spring이 CSP를 포함한 보안 헤더를 하나도 내지 않아도 대조기가 diffs 0을 내고 통과**시켰다 — 이 step 자신의 금지사항("차이 나는 축을 조용히 빼지 마라")을 계획이 어긴 자리다. 그래서:

- **관측 대상 헤더(원문 문자열, 부재는 `null`)**: `content-security-policy` · `strict-transport-security` · `x-content-type-options` · `x-frame-options` · `x-dns-prefetch-control` · `x-download-options` · `x-permitted-cross-domain-policies` · `referrer-policy` · `cross-origin-opener-policy` · `cross-origin-resource-policy` · `origin-agent-cluster`. **정확한 집합은 Node 응답을 실측해 확정하라**(helmet 판본이 무엇을 내는지 이 목록으로 추정하지 마라 — Node 응답 헤더를 그대로 나열해 상수로 박고, 그 상수를 자기검사가 잠근다).
- **판정은 두 갈래이고, 그 경계는 step2 작업 D와 한 글자도 다르지 않아야 한다(② 재검토 · 일원화)**: **① `content-security-policy`의 diff는 실패다 — 단 응답의 출처가 SPA 핸들러(폴백 `index.html` + `/assets/*` 등 정적 자산)일 때만이다.** 그 경로에서는 **Node 원문과 바이트 동일**(직렬화 순서·구분자·공백 포함)이어야 한다. **`/api/**` 와 `/uploads/**` 응답의 CSP 부재는 '허용 diff'** 다 — **현재 설계**이며(excluded (d) ②) `/uploads`를 빠뜨리면 `GET /uploads/missing.png` 같은 항목이 **오탐으로 실패**한다. **분류는 (경로군 × 헤더)의 코드 상수**로 두고 테스트가 그 **집합**을 단언한다(경로군은 최소 셋: `spa` · `api` · `uploads`). **② 나머지 10종은 전 경로군에서 '허용 diff'** 지만 **리포트에 반드시 출력**하고 요약 줄에 **`허용 diff N건`** 으로 센다. 0으로 숨기지 마라.
- **허용 diff 집합을 늘리는 것은 결정이다** — 늘리려면 문서에 축·이유·대체 방어선을 적어라(늘리는 변이가 아래 N4다).

**세션 토큰·절대경로·시스템 파일 내용은 리포트에 싣지 마라**(경로 탈출 시험은 '내용이 실렸는가'를 불리언으로만 기록한다).

**그 밖의 알려진 divergence 처리**: `ETag`·`Last-Modified`·`Accept-Ranges`·정적 `Cache-Control`은 **허용 diff로 분류하되 위와 같은 규칙**(출력·계수·집합 잠금)을 적용한다. **"차이가 나서 뺐다"를 조용히 하지 마라** — 뺀 축은 아무도 보지 않는 축이 된다(75 forward_notes (4)).

### B. 스크립트 자기검사

`mysqlHarness.mjs`의 선례대로 **순수 판정부**(리포트 비교·요청 표 검증)를 분리하고 `node --test`로 도는 자기검사를 둔다. 시작 시 자동 실행한다. 최소: 같은 리포트 2벌 → diffs 0 · 한 값만 다른 2벌 → diffs 1 · 표에 중복 `name`이 있으면 **즉시 실패**(조용한 덮어쓰기 금지) · **관측 헤더 상수의 집합 단언**(개수만 세지 마라) · **허용 diff 분류 집합의 단언**(무엇이 허용인지가 코드에 박혀 있고 테스트가 그것을 읽는다) · 허용 diff가 있는 리포트에서 **요약 줄에 그 건수가 실제로 나오는지**.

### C. 문서

`docs/cutover-p3.md`에 §2를 추가: 이 하네스가 무엇을 보고 무엇을 보지 않는가 · 실행 커맨드 · 관측 수 · **허용 diff 목록 전문(축·현재 값·이유·대체 방어선)** — 이 목록이 step10 런북 §0 낭독과 §10 분기의 입력이다(특히 「Spring `/api` 응답에는 보안 헤더가 없다」) · 실패했을 때 리포트 읽는 법.

## Acceptance Criteria

```bash
# 0) jar 최신화
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests

# 1) SPA 대조 — exit 0 · diffs 0
node scripts/spa-parity.mjs

# 2) 자기검사 (스크립트가 시작 시 자동 실행하지만 단독으로도 돈다)
node --test scripts/lib/*spa*self-test*.mjs      # 실제 경로는 구현이 정한다

# 3) 계약 무회귀 2축
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --db mysql --parity

# 4) 리포 자산 무변
md5sum news.db

# 5) 무접촉
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs scripts/spring-contract.mjs server src web client test package.json   # 무출력
```

- 1번이 **exit 0**이고 **관측 ≥ 30 · diffs 0 · 허용 diff N건**을 출력한다. 관측 수를 출력하지 않는 하네스는 공허하다(몇 건을 봤는지 모르면 0 diff는 아무 뜻이 없다). **허용 diff N건도 반드시 출력**한다 — 그 숫자가 "이 phase가 알고도 남겨 둔 차이"의 크기이고, 런북 §0 낭독 문구의 근거다.
- 5번에 **`scripts/spring-contract.mjs`가 포함**된다 — 이 step은 계약 하네스를 고치지 않는다.
- 실행 후 임시 디렉토리와 두 자식 프로세스가 **남지 않는다**(확인 명령을 결과표에 적어라).
- **변이 전건 결과표(필수)** — 최소 8종:
  - **N1** Spring 폴백의 `Accept` 게이트 제거 → 기대: `/assets/does-not-exist.js` 항목에서 diff 1건 이상.
  - **N2** Spring 예약 접두사에서 `/api` 제거 → 기대: `/api/unknown-path`·`/api/does-not-exist`에서 diff.
  - **N3** **[② 검토 반영 · 재정의]** Spring이 `index.html` 대신 1바이트 다른 본문을 돌려주게 한다 → 기대: 본문 sha256 diff. **초안의 「리포 `web/dist/index.html` 끝에 개행 추가」는 폐기한다 — 두 서버가 같은 루트를 공유하므로 (i) 리포 쓰기 금지 위반이고 (ii) 양쪽이 함께 바뀌어 diff가 나지 않는다(기대값 자체가 틀렸다).** 대신 둘 중 하나로 한다: **(가) Spring 리졸버 코드 변이**(폴백이 돌려주는 바이트 끝에 1바이트를 덧붙인다) 또는 **(나) Spring에만 리포 밖 사본 루트를 주고 그 사본의 `index.html`을 1바이트 고친다**. (가)를 기본으로 하고, (나)를 쓸 때는 **사본을 쓴다는 사실 자체가 대조 전제를 바꾸므로**(두 서버가 같은 산출물을 본다는 전제) 변이 표에 그 사실을 함께 적어라.
  - **N4** 대조기의 **허용 diff 집합에 `content-security-policy`를 추가**(그리고 별도로 `content-type`을 비교에서 뺀 변이도) → 기대: **CSP 부재가 조용히 통과**하고 N1~N3 중 일부도 통과. **대조기 자체의 공허화 실증**이며, "무엇을 허용 목록에 넣으면 무엇이 안 보이는지"를 기록하라. **이 변이가 H1이 지적한 초안 결함의 재발 방지 장치다.**
  - **N5** 요청 표에서 `.do` 7경로 중 하나를 뺌 → 기대: 관측 수 감소가 출력에 드러난다(수치를 출력하지 않으면 이 변이가 무해해진다 → 그 자체가 결함).
  - **N6** 두 서버 중 하나에만 `SPA_DIR`을 준다 → 기대: 대규모 diff(하네스가 "한쪽만 켜진 상태"를 잡는지).
  - **N7** Spring의 CSP 헤더 제거(step2 작업 D 되돌리기) → 기대: **SPA 경로에서 실패 diff**(허용 diff가 아니다). 보안 헤더 관측이 실제로 판정에 연결됐는지의 실증.
  - **N8** 관측 헤더 상수에서 항목 1개 삭제 → 기대: 자기검사 red(집합 잠금이 있는지). 없으면 만들어라.
  - **N9** **[② 재검토 반영]** 허용 diff 분류에서 **`uploads` 경로군을 제거**(=`/api`만 허용) → 기대: `GET /uploads/missing.png` 같은 항목이 **오탐으로 실패**한다. 경로군 3종 분류가 실제로 필요하다는 실증이고, 반대로 `spa` 경로군을 허용으로 옮기면 N7이 통과해 버리는지도 함께 재라(두 방향 모두 기록).
  - 각 변이에 기대/실제/원복 확인.
- **추가 실측 기록**: N1·N2를 심은 채 `--parity`(계약)를 돌려 **313관측 diffs 0**인지 재라. 0이면 "계약은 SPA 축을 구조적으로 보지 않는다"가 이 phase의 실측으로 확정된다 — 그 문장을 문서에 넣어라.

## 검증 절차

1. 스크립트를 **연속 2회** 돌려 같은 결과가 나오는지(자기 결정성) 본다. 다르면 포트·임시 디렉토리 재사용을 의심하라.
2. 두 서버의 기동 로그를 각각 저장하고, 둘 다 **SPA 활성 로그 1줄**을 냈는지 확인한다(하나만 켜진 상태로 diffs 0이 나오면 그건 대조가 아니다 — N6이 그 함정을 잡는다).
3. 경로 탈출 항목에서 **어떤 응답도 리포 밖 파일 내용을 싣지 않았는지** 눈으로 한 번 확인한다(자동 판정은 불리언이지만, 첫 실행은 사람이 본다).
4. 실행 전후로 리포 `news.db` md5를 잰다.

## 되돌림 절차

새 스크립트 파일 삭제로 끝난다. **런타임·운영 영향 0**. 단, 스크립트가 남긴 임시 디렉토리가 있으면 지워라(리포 밖).

## 금지사항

- **`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`scripts/spring-contract.mjs`를 고치지 마라.** 이유: 계약 판정의 정본이고, 이 step의 실패가 계약 실패로 위장되면 진단이 무너진다.
- **리포 `news.db`·`uploads/`·`web/dist`에 쓰기를 하지 마라.** 읽기만 한다. 이유: DB 비파괴 규칙이자, `web/dist`는 두 서버가 **공유하는 입력**이라 한쪽이 바꾸면 대조가 무의미해진다.
- **차이가 나는 축을 조용히 비교에서 빼지 마라.** 이유: 뺀 축은 아무도 보지 않는 축이 된다. 빼려면 문서에 축·이유·대체 방어선을 적어라.
- **관측 수를 출력하지 않는 하네스를 만들지 마라.** 이유: 0 diff가 "다 같다"인지 "아무것도 안 봤다"인지 구분되지 않는다(75 step7 M9c의 교훈과 같은 계열).
- **두 서버를 같은 `DATA_DIR`로 띄우지 마라.** 이유: Node는 SQLite 파일을 잠그고, 그 경합은 SPA 축과 무관한 실패를 만든다.
- **임시 산출물을 리포 안에 만들지 마라.** 이유: `git status`가 오염되고 다른 세션 산출물과 섞인다.
