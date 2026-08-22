# Step 10: lifecycle-http

생애주기의 **HTTP 표면 2개**를 만든다: `POST /api/articles/:id/action` · `POST /api/articles/:id/derive`.

이 step에서 **`contract/cases/default/articles-write.contract.js`가 green이 된다**(그 파일이 필요로 하던 마지막 조각이 송고다). scope 표에 그 파일을 올리고 `--parity` diff 0을 확인하는 것이 합격 기준이다.

## 읽어야 할 파일

- `phases/69-spring-articles/index.json` — decisions **(3)(12)(13)(15)(19)(22)(23)** · order (a)
- `server/index.js` 874~910행 — **이식 원본 2라우트**. 특히 (a) 역할 집합 게이트(R/D/Z) (b) **action 어휘 검증이 서비스 호출보다 먼저**(400 `unknown-action`) (c) 실패는 `fail(res, r, 409)` — **폴백이 409**다 (d) derive의 mode 어휘 검증(400 `unknown-mode`)과 기본 폴백(400) (e) derive의 작성자 stamp(`me.name ?? me.userId` — **`??`이지 `||`가 아니다**)
- `contract/cases/default/articles-write.contract.js` — 이 step에서 green이 되는 파일 전체(특히 DPS 잠금 게이트 케이스가 `createSentArticle`로 송고를 부른다)
- `contract/cases/minimal/transitions.contract.js` 100~170행 — action·derive의 인가·검증 케이스(이 파일은 step11에서 green이 된다)
- `scripts/spring-contract.mjs` 55~80행 — scope 표(default 행에 파일 1개 추가)
- step9(생애주기 서비스) · step7·step8(컨트롤러 패턴) 산출물

## 배경 (동결된 계약 사실)

- **action**: 200 `{ok:true, status}` **정확히 2키**. 어휘는 `send`·`hold`·`kill`·`approveDelete` 4종이고 **누락·정의 밖은 400 `unknown-action`**이며 그때 상태는 그대로다. 서비스 실패의 상태 매핑은 `not-found` 404 · `no-end-marker` 400 · `forbidden-transition` 409이고 **폴백도 409**다.
- **derive**: 200 `{ok:true, articleId}` **정확히 2키**. 모드는 `followUp`·`continue` 2종이고 누락·정의 밖은 400 `unknown-mode`. 없는 원본은 404. **R·D·Z 모두 가능**하고 원본이 `DPS`여도 파생된다(라우트는 역할 집합만 본다).
- **작성자 stamp**: derive는 `name ?? userId`(빈 문자열 이름이면 **빈 문자열**), 신규 저장은 `name || userId`(빈 문자열이면 userId). **두 라우트의 연산자가 다르다** — 그대로 옮긴다.
- 미인증은 401 `unauthenticated`(경로 정책 필터) — 두 라우트 모두.
- **배부 훅은 없다**(decisions (2)(3)). `default` 프로파일에서도 수신처 0건이라 송고의 부수효과가 없다는 것을 이 step의 `--parity`가 **기계로 증명**한다(diff 0이면 증명된 것이다).

## 작업

### A. Node 대조 리포트 실측 (구현 전, decisions (23))

```bash
cd /d/agents/harness && OUT="$(mktemp -d)" && node scripts/contract-run.mjs --profile default --files contract/cases/default/articles-write.contract.js --out "$OUT/node-aw.json" && node scripts/contract-run.mjs --profile minimal --files contract/cases/minimal/transitions.contract.js --out "$OUT/node-tr.json" && ls -l "$OUT"
```

`$TMPDIR`를 쓰지 마라 — win32 Git Bash에서 비어 있을 수 있어 `--out`이 `/node-aw.json`으로 펴진다(리포 밖 보장이 깨진다). `mktemp -d`를 쓰고, 없는 셸이면 `${TMPDIR:-${TMP:-/tmp}}` 폴백으로 디렉토리를 만들어 쓴다. 두 리포트는 **한 커맨드 안에서** 같은 디렉토리에 뽑는다(셸 변수는 호출 간에 유지되지 않는다). 실제 경로를 요약에 남긴다.

`articles-action`·`articles-derive` 관측의 `status`·`reason`·`bodyKeys`·`values`를 확인한다. 특히 **송고 케이스의 `values`에 배부 흔적(distributedAt 관련 값)이 없다는 것**을 눈으로 확인하고 요약에 적는다(decisions (3)의 실측 근거).

### B. 컨트롤러 2개

- **action**: 신원 → 역할 집합(R/D/Z, 아니면 403 `forbidden`) → **어휘 검증(400)** → 서비스 호출 → 실패면 **폴백 409**로 매핑 → 성공 `{ok:true, status}`.
- **derive**: 신원 → 역할 집합 → 모드 검증(400) → 작성자 stamp(`name ?? userId`) → 서비스 호출 → 실패면 폴백 400 매핑(`not-found` 404) → 성공 `{ok:true, articleId}`.
- 어휘 검증은 **문자열 비교**다: 본문 값이 문자열이 아니면 어휘에 없으므로 400이다(Node의 집합 조회와 같은 결과).
- `ReasonStatus`에 `forbidden-transition` 409 · `no-end-marker` 400 · `unknown-action`/`unknown-mode` 400을 추가한다(도달하는 토큰만). **action 라우트의 폴백이 409**라는 사실을 매핑 호출부에 명시한다(전역 폴백 400과 다르다).

### C. scope 표 · 인벤토리 갱신

- `scripts/spring-contract.mjs`의 default 행 `files`에 `contract/cases/default/articles-write.contract.js`를 **알파벳 순서 위치**에 추가한다(`articles-read`가 아직 없으므로 이 파일이 목록의 첫 번째가 된다).
- `HandlerInventoryTest`의 `IMPLEMENTED_ROUTES`에 2행 추가 + **메서드명·실패 메시지의 라우트 수 표기도 같은 step에서 갱신**(decisions (15)).
- **derive는 이 phase에서 유일하게 '구현했는데 같은 step의 계약 관측이 따라오지 않는' 라우트다**(decisions (15) — scope 표가 늘어나는 step 10·11 기준): 구현은 이 step, 계약 편입은 step11(그 파일이 이력 라우트를 요구한다). 그 사실을 `HandlerInventoryTest`의 목록 주석과 step 요약에 **명시**하고, 대신 아래 E의 derive 와이어 테스트로 계약 케이스의 단언을 선반영한다.

### D. 테스트 (먼저 쓴다 — 전 기동 + 원시 HTTP)

1. action 성공 2키 · 되읽은 상태 일치(대표 3칸: `RDS`+D+send → `DPS` · `RDS`+R+send → `RDS` · `DPS`+D+approveDelete → `DPD`).
2. action 거부: 표 밖 칸 → **409 `forbidden-transition`**이고 상태 그대로.
3. action 검증: 누락·정의 밖·비문자열 → 400 `unknown-action`, 상태 그대로.
4. action 404(없는 기사) · 미인증 401.
5. 마커: 없는 본문으로 송고 → 400 `no-end-marker` · 마커 없고 전이도 불가 → **409**(순서 실증).
6. 송고 stamp: `sender`가 세션 사용자 · `sentAt` 존재 · **`distributedAt`은 여전히 `null`**.
7. 엠바고 기사 송고 → `DES`(D) / `RDS`(R).
8. derive 성공 2키 · 새 id · `RDS` · 작성자 = 세션 사용자 · 원본 무변 · R·D·Z 전부 가능 · `DPS` 원본에서도 가능.
9. derive 검증: 누락·정의 밖 mode → 400 `unknown-mode` · 없는 원본 404 · 미인증 401.
10. Content-Type이 `application/json; charset=utf-8`이다.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B verify
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile default --files contract/cases/default/articles-write.contract.js --parity
cd /d/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd /d/agents/harness && npm test
cd /d/agents/harness && git status --porcelain
```

- 3번: **이 step의 본 게이트** — `articles-write.contract.js` 단독 실행이 green이고 Node 대비 `diffs=0`.
- 4번: scope 표 전체(default 6파일 + auth-negative + prod-cookie) exit 0 · 전 프로파일 `diffs=0`. default 관측 수가 크게 늘어난 것을 확인한다.
- 5번: **1328/1328**.

## 검증 절차

1. red 먼저(D의 10군). 3번 AC 커맨드를 **구현 전에** 1회 돌려 **실패 목록이 송고 관련 케이스**임을 재확인한다(step8 진단과 이어진다) — 이 선실행은 **진단이며 실패가 정상**이다(AC exit 0 판정은 구현 후 실행에만 적용한다).
2. AC 실행. `--parity`의 `[diff] A=default-node B=default-spring observations=<n> diffs=0`에서 `<n>` 증가를 기록한다.
3. **decisions (3) 검증(이 step의 필수 관측)**: Node 대조 리포트와 Spring 리포트가 **송고 케이스에서 diff 0**이라는 사실을 요약에 명시한다 — 이것이 '배부가 켜진 Node와 배부가 없는 Spring이 이 프로파일에서 동형'이라는 기계 증명이다. 만약 diff가 나면 **Spring에 배부를 구현하지 말고** 무엇이 달랐는지 기록한 뒤 폐색(index.json open_questions에 추가)하라.
4. **변이 실증 3종**(확인 후 원복): (a) action 실패 폴백을 400으로 바꾸면 2번이 red인가 (b) 어휘 검증을 서비스 호출 뒤로 옮기면 3번(상태 불변)이 red인가 (c) derive 작성자 stamp를 `||` 의미론으로 바꾸면 이름이 빈 계정에서 결과가 달라지는가(Java 테스트로 실증).
5. **DB 비파괴**: 하네스의 리포 `news.db`·`uploads/` 무변 단언 + 크기·mtime 눈 확인.
6. `git status --porcelain` 증분 = `server-spring/src/main/java/harness/news/{controller,web}/**` · `server-spring/src/test/**` · `scripts/spring-contract.mjs` · `phases/69-spring-articles/index.json`.
7. index.json step10 status·summary 갱신(계약 파일 1개 green · derive의 계약 편입이 step11이라는 사실 포함).

## 금지사항

- action 실패의 폴백을 400으로 두지 마라. 이유: 정본이 `fail(res, r, 409)`로 부른다 — 알 수 없는 사유도 409다.
- 어휘 검증을 서비스 호출 뒤로 옮기지 마라. 이유: 검증 거부는 상태를 건드리지 않아야 하고, 순서가 바뀌면 존재하지 않는 기사에 400 대신 404가 나가는 등 상태코드가 갈린다.
- derive에서 클라이언트가 보낸 `author`·`role`·`status`·`articleId`를 쓰지 마라. 이유: 작성자는 세션 사용자로 stamp하고 나머지는 신규 저장이 강제한다(ADR-004).
- 배부 훅을 만들지 마라(스풀 쓰기·타이머·네트워크 전송). 이유: excluded (c) — ADR-008 아키텍처를 따르는 배부 phase 소유다.
- `articles-read.contract.js`·`transitions.contract.js`를 scope 표에 넣지 마라. 이유: 이 step에서는 아직 green이 될 수 없다(목록·검색·이력 라우트 부재) — 넣으면 매 step 공통 회귀 게이트(`--parity` exit 0)가 무너진다.
- 응답을 메시지 컨버터로 반환하지 마라(decisions (22)).
