# Step 4: client-integration

## 읽어야 할 파일

- `phases/76-spring-cutover/index.json` — `baseline` (B)(C)(D) · `decisions` (1)(5)(9) · `open_questions` (2)(5)
- `docs/ADR.md` **ADR-017**(step1) · **ADR-011**(Electron 접속형 셸 — 원격 페이지에 Node 권한 0) · **ADR-012**(단일 인스턴스)
- `scripts/verify-integration.mjs` **전문 739줄** — 특히 파일 머리 주석(측정 원칙·데이터 안전 CRITICAL·env CRITICAL)·`cleanEnv()`·`resolveExe()`·`repoDataSnapshot()`/`appDataSnapshot()`/`distDataSnapshot()`·`runScenario()`·포트 범위 규율(서버 20000~34999 / CDP 35000~44999)
- `client/main.js`(`probeOrigin`·`appUrl`·`loadURL`·diag 이벤트) · `client/lib/serverUrl.js` · `client/lib/clientConfig.js` · `client/diag.js`
- `packaging/README-배포-통합.md` · `packaging/client/README-배포-클라이언트.md` · `packaging/체크리스트-육안확인.md`
- `server-spring/README.md`「빌드·테스트·실행」·「설정 키 ↔ 환경변수」
- `phases/76-spring-cutover/step2.md`·`step3.md`(SPA 서빙과 그 대조는 이미 있다)

## 배경

로드맵 P3의 완료 게이트 첫 항목은 **"실운영 시나리오(작성→송고→배부→수집) 통과"** 다. 이 리포에는 그 시나리오의 절반을 이미 자동 판정하는 자산이 있다: `scripts/verify-integration.mjs`(phase 63)는 **서버 exe와 클라이언트 exe를 함께 띄워** CDP로 `secure context → 로그인(desk) → 목록 SSE '실시간' → 기사 작성 → 목록 행 등장(SSE) → 상세보기 팝업(720×800) → 송고(RDS→DPS) → 행 소멸(SSE) → 클립보드 왕복`까지 몬다.

**그 스크립트를 Spring에도 겨눌 수 있게 만드는 것이 이 step이다.** 그러면 "Electron 클라가 Spring에 붙는다"가 사람 눈이 아니라 exit code로 판정된다.

이 시나리오가 통과하려면 step2의 SPA 서빙이 **실제로 브라우저에서 동작**해야 한다(클라는 `${origin}/`을 `loadURL`한다). 즉 이 step은 step2의 **실기 검증**이기도 하다 — 와이어 테스트가 통과해도 실제 Chromium에서 asset 로딩·history 라우팅·SSE가 깨질 수 있다.

**규율(decisions (9))**: 그 스크립트를 **복제하지 않는다**(739줄 · `export` 0 · 정본이 둘이 되면 한쪽이 늙는다). **서버 기동부만 모드로 분기**하고 나머지는 한 줄도 바꾸지 않으며, **기존 `--server exe` 경로가 여전히 exit 0**임을 같은 step에서 실증한다.

## 작업

### A. `scripts/verify-integration.mjs`에 `--server exe|spring` 추가 (기본 `exe`)

- 인자 파싱은 기존 `flagValue` 규율(missing/empty/flag-like fail-fast)을 그대로 쓴다. 허용값 밖이면 `die()`.
- `spring` 모드에서 바뀌는 것은 **서버 자식 프로세스를 만드는 자리 하나**다:
  - 실행: `<JAVA_HOME>/bin/java -jar server-spring/target/server-spring-0.0.1-SNAPSHOT.jar` (jar 경로는 플래그로 덮을 수 있게 — 기본은 위 경로. **하네스가 스스로 빌드하지 않는다**는 규율을 승계하고, jar가 없으면 빌드 커맨드를 안내하며 죽어라).
  - env: 기존 `cleanEnv()` 규율을 그대로 적용하고 **허용 목록 방식**으로 조립한다(부모 env 통째 상속 금지 — `spring-contract.mjs`의 `javaChildEnv()`가 정본 형태다). 최소 키: `DATA_DIR`(임시) · `PORT` · `HOST` · **`SPA_DIR`**(리포 `web/dist` 또는 지정) · `DIST_SPOOL_DIR`(임시 — 송고 시 배부 스풀이 실제로 생기는지 보려면 필요하다) · MySQL 축으로 돌릴 때만 `DB_KIND`/`NEWS_DB_*`.
  - `NODE_ENV=production` 금지 규율은 Spring 축에서 **`APP_ENV=production` 금지**로 대응한다(평문 HTTP에서 쿠키 Secure가 켜지면 인증이 조용히 실패한다 — 같은 함정이다).
  - 헬스 대기: 기존 `healthOk(origin, ...)`(`/api/health` 본문 `{ok:true}`)를 **그대로** 쓴다. 클라 프로브와 같은 판정이라 이 자리를 바꾸면 안 된다.
  - 종료: 기존 `killChild` 규율(kill → 확인 → SIGKILL 폴백).
- **DB 축 선택**: 기본은 `sqlite`(임시 `DATA_DIR`에 `src/db/**`로 시드 — 기존 코드가 이미 한다). `--db mysql`을 추가할지는 재량이되, **추가한다면 임시 DB는 `harness_ct_<16hex>` 규약과 드롭 장부를 그대로 따르라**(75가 세운 규약을 깨지 마라). 추가하지 않는다면 그 사실과 이유를 문서에 적어라.
- **데이터 안전 CRITICAL 승계**: 리포 `news.db`·`uploads/`·실사용자 `%APPDATA%\기사작성기`·`dist/*/data`에 바인딩 금지 + 종료 후 스냅샷 대조. spring 모드에서도 **같은 스냅샷 대조를 돈다**(코드가 이미 시나리오 공통이면 그대로 살아 있는지 확인하라).

### B. 시나리오 확장 — 배부 스풀 관측 1건

기존 시나리오의 **송고(RDS→DPS)** 뒤에 한 단계를 더한다: `DIST_SPOOL_DIR` 아래에 **파일이 1개 이상 생겼는가**와 그 파일명이 `<articleId>_<stamp>.json` 형태인가. (바이트 대조는 step5가 한다 — 여기서는 "배부가 실제로 일어났다"만 본다.)

**주의**: 배부가 일어나려면 활성 `DistributionTarget`이 있어야 한다. 시드에 대상이 없으면 스풀은 비고, 그건 결함이 아니다 — **시나리오가 대상을 만들고(관리자 API) 그 다음에 송고**하도록 하거나, 대상이 없으면 이 관측을 **skip이 아니라 명시적 실패**로 두어라(조용한 skip이 이 리포의 실패 양식이다).

### C. 문서

- `docs/cutover-p3.md` §3: 실기 시나리오 실행법(두 모드) · 무엇을 자동 판정하고 무엇을 못 하는가 · 실패 시 진단 순서.
- `packaging/README-배포-통합.md`에 **Spring 서버로 기동하는 절**을 추가한다. **기존 Node 절을 지우지 마라**(롤백 자산이다). 두 절이 나란히 있고, 어느 쪽이 현재 운영인지 런북(step10)이 가리킨다.

## Acceptance Criteria

```bash
# 0) 전제: 두 exe와 jar가 있다
ls dist/기사작성기-server dist/기사작성기
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B -q package -DskipTests

# 1) 신규 경로 — Electron 클라가 Spring에 붙는다
node scripts/verify-integration.mjs --server spring --scenario loopback

# 2) 기존 경로 무회귀 (이것이 이 step의 두 번째 AC다)
node scripts/verify-integration.mjs --scenario loopback
node scripts/verify-integration.mjs --server exe --scenario loopback

# 3) 계약·Java 무회귀
cd server-spring && JAVA_HOME="D:/agents/tools/jdk-25.0.4.1+1" ./mvnw -B clean verify
node scripts/spring-contract.mjs --parity
node scripts/spring-contract.mjs --db mysql --parity

# 4) SPA 대조 무회귀
node scripts/spa-parity.mjs

# 5) 무접촉
git diff --stat -- contract docs/api-contract scripts/contract-run.mjs scripts/contract-diff.mjs server src web client test package.json   # 무출력
```

- 1·2번이 **모두 exit 0**. 2번은 **인자 없이도** 기존과 같아야 한다(기본값 `exe`).
- LAN 시나리오(`--scenario lan`)의 3분법(skip=0 / 제품 실패=1 / 환경 차단=2)이 **spring 모드에서도 같은 의미**인지 확인하고 결과를 기록한다(방화벽 때문에 2가 나오면 그것은 환경이지 결함이 아니다 — 정직하게 적어라).
- 종료 후 **임시 디렉토리·자식 프로세스 잔존 0**, 리포 `news.db`·`uploads/`·`%APPDATA%` 스냅샷 **무변**.
- **변이 전건 결과표(필수)** — 최소 5종:
  - **P1** Spring의 SPA 서빙을 끔(`SPA_DIR` 미주입) → 기대: spring 모드가 **실패**(클라가 화면을 못 받는다). 이 변이가 "SPA 서빙이 실기의 전제"임을 실증한다.
  - **P2** `DIST_SPOOL_DIR` 미주입 → 기대: 배부 관측 단계에서 명시적 실패(조용한 통과가 아님).
  - **P3** 헬스 판정을 상태코드만 보도록 바꿈(본문 `{ok:true}` 무시) → 기대: 잘못된 서버에도 붙는다 — **클라 프로브와 같은 판정을 써야 하는 이유**를 실증하고 원복.
  - **P4** `--server` 인자에 허용값 밖(`--server foo`) → 기대: 즉시 `die()`(조용한 기본값 폴백 금지).
  - **P5** spring 모드 env를 부모 env 통째 상속으로 바꿈 → 기대: 결정성 훼손 관측(예: 개발 머신의 `COLLECTION_TOKEN`·`DIST_SPOOL_DIR` 잔재가 결과를 바꾼다). 실제 관측을 적고 원복.
- 각 변이에 기대/실제/원복 확인. **기대와 실제가 다르면 그것이 발견이다.**

## 검증 절차

1. spring 모드를 **연속 2회** 돌려 flake를 판정한다(1회 실패는 재실행 2회 규약으로 판정 — 이 리포의 flake 규약).
2. 실패 시 진단 순서: (a) jar가 최신인가 (b) `SPA_DIR`이 실제 `index.html`을 가리키는가 (c) 포트 충돌 (d) `APP_ENV`가 production이 아닌가 (e) diag JSONL의 셸 부팅 시퀀스가 어디서 끊겼는가.
3. **창이 잠깐 뜨는 것은 정상**이다(상세보기 팝업은 Chromium이 만든다 — 스크립트 머리 주석).
4. 실행 전후 리포 자산 지문을 비교한다.

## 되돌림 절차

- 코드 되돌림: `scripts/verify-integration.mjs`의 추가분 제거(모드 분기 + 배부 관측). **기본 경로가 무변경이므로 되돌림은 부분 되돌림으로 충분하고, 되돌려도 exe 검증 경로는 그대로 산다.**
- 운영 되돌림: 해당 없음.
- 문서 되돌림: `packaging/README-배포-통합.md`의 추가 절만 제거(기존 Node 절은 애초에 건드리지 않는다).

## 금지사항

- **`scripts/verify-integration.mjs`를 복제해 새 스크립트를 만들지 마라.** 이유: 739줄 정본이 둘이 되면 한쪽이 늙고, 다음 사람이 어느 쪽을 믿을지 알 수 없다.
- **기존 `--server exe` 경로의 동작을 바꾸지 마라.** 이유: phase 60~65가 세운 exe 검증 자산이고, 이 phase의 롤백 검증이 그것에 의존한다.
- **`client/**`·`web/**`를 고치지 마라.** 이유: 무수정이 롤백 속성의 근거다. 클라가 붙지 않으면 **서버를 고쳐라**(그 방향이 이 phase의 설계다).
- **`APP_ENV=production`(또는 `NODE_ENV=production`)을 주지 마라.** 이유: 평문 HTTP에서 쿠키가 `Secure`가 되어 로그인 화면은 뜨는데 인증만 조용히 실패한다.
- **조용한 skip을 만들지 마라.** 이유: 이 리포의 게이트는 언제나 '조용한 green'으로 무너졌다. 전제가 없으면 실패시켜라.
- **`DATA_DIR`을 리포 루트나 운영 폴더로 주지 마라.** 이유: 스크립트의 CRITICAL 규율이자 DB 비파괴 규칙이다.
