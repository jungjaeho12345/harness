# Step 0: contract-harness-profiles

Spring 계약 하네스(`scripts/spring-contract.mjs`)의 프로파일 표에 **`host`·`spool`·`token` 축**을 세우고, 다섯 번째 프로파일 **`failclosed`**를 신설한다. 이 phase가 구현할 5 라우트 중 3개(수집 2·배부 tick)는 **서버 구성(바인드 주소·수집 토큰·스풀 루트)이 계약의 입력**이라, 하네스가 그 구성을 주입하지 못하면 계약 파일을 **돌릴 수단 자체가 없다**.

이 step은 **`scripts/spring-contract.mjs` 한 파일만** 건드린다. Java 소스는 한 줄도 고치지 않으며, 새 env는 아직 Spring이 읽지 않으므로 **관측이 하나도 바뀌지 않는 것**이 성공 조건이다.

## 읽어야 할 파일

- `phases/71-spring-distribution/index.json` — scope · baseline · order (c) · decisions **(24)** · open_questions **(c)**
- `scripts/spring-contract.mjs` — 이 step이 고치는 유일한 파일. 특히 `SCOPE` 표(58~99행 부근) · `javaChildEnv()` · `pickFreePort()` · `waitHealthy()` · `runSpringPass()`(임시 DATA_DIR 시드 → 포트 → 기동 → health → 비밀 파일 → 러너) · `runNodePass()` · `main()`의 `profiles` 조립
- `scripts/contract-run.mjs` — **읽기 전용 정본**. 확인할 것: 42~43행 `COLLECTION_TEST_TOKEN` 리터럴 · 53~59행 `PROFILES` 프리셋 표(`default {sessions:true,spool:true,token:true,host:'127.0.0.1'}` · `minimal {…spool:false,token:false…}` · `auth-negative {sessions:false,spool:true,token:true}` · **`failclosed {sessions:true,spool:false,token:false,host:'0.0.0.0'}`** · `prod-cookie`) · 305~322행(스풀 디렉토리 생성·`DIST_SPOOL_DIR`·`COLLECTION_TOKEN` 주입, 접속은 항상 `127.0.0.1`) · 366~370행(`caseEnv.CONTRACT_COLLECTION_TOKEN`은 **외부 대상 모드에서도** `profile.token`이면 설정된다)
- `contract/cases/failclosed/collection-disabled.contract.js` — 이 프로파일의 **유일한** 케이스(파일 서문: 다른 도메인을 여기 추가하지 마라)
- `contract/lib/profiles.js` — `requireProfile`이 어떻게 프로파일 불일치를 죽이는지

## 배경 (동결된 사실)

- 현재 Spring 하네스의 java 자식 env는 **`DATA_DIR`·`PORT`·`HOST`(상수 `127.0.0.1`) + `profile.extraEnv`**뿐이다(`runSpringPass` 3번 단계). `DIST_SPOOL_DIR`·`COLLECTION_TOKEN`은 **어느 프로파일에도 없다**.
- Node 대조 패스(`runNodePass`)는 러너의 **자체 프리셋**을 쓴다 — 즉 Node 쪽 default는 이미 `spool:true, token:true`다. 그래서 두 대상의 구성을 맞추려면 **Spring 쪽만** 채우면 된다.
- 러너는 `--base-url-map`(외부 대상) 모드에서도 `caseEnv.CONTRACT_COLLECTION_TOKEN`을 `profile.token` 기준으로 넘긴다. 따라서 **케이스가 보는 토큰 값과 Spring 서버가 설정한 값이 같아야** `collection.contract.js`가 401이 아니라 200을 본다.
- `contract/cases/default/collection.contract.js`는 `CONTRACT_COLLECTION_TOKEN`이 없으면 **로드 시점에 throw**한다 — 토큰이 없는 default 프로파일은 그 파일을 돌릴 수 없다.
- `--parity`는 프로파일마다 Node 패스를 함께 돌린다. `failclosed`를 SCOPE에 넣으면 Node 쪽도 `--profile failclosed`로 돌아간다(러너가 이미 지원한다 — 러너 수정 불필요).

## 작업

### A. Node 대조 리포트로 실측부터(decisions (25))

리포 **밖** 임시 경로에 Node 기준선을 뽑아 둔다(이 phase 내내 대조 기준이다):

```
node scripts/contract-run.mjs --profile failclosed --out <임시경로>/failclosed-node.json
node scripts/contract-run.mjs --profile minimal --files contract/cases/minimal/collection-open.contract.js --out <임시경로>/minimal-collection-node.json
```

두 리포트의 `status`·`bodyKeys`·`values`를 요약에 적는다. **리포 안에 리포트를 쓰지 마라.**

### B. SCOPE 표에 구성 축 3개 추가

- 각 프로파일 항목에 `host`(기본 `'127.0.0.1'`)·`spool`(불리언)·`token`(불리언)을 명시한다. **러너 프리셋과 값이 같아야 한다**: `default {host:'127.0.0.1', spool:true, token:true}` · `minimal {…, spool:false, token:false}` · `auth-negative {…, spool:true, token:true}` · `prod-cookie {…, spool:false, token:false}`.
- 표 주석에 "값은 `scripts/contract-run.mjs`의 `PROFILES`와 **반드시 일치**한다 — 갈리면 두 대상이 서로 다른 서버 구성을 측정한다"를 남긴다.

### C. `failclosed` 프로파일 신설

- `{ name:'failclosed', host:'0.0.0.0', spool:false, token:false, files:[], extraEnv:{} }`.
- `files`는 **이 step에서 비워 둔다**(케이스 편입은 step5 — green이 되는 step에서만 scope를 늘린다). 주석으로 그 사실과 담당 step을 남긴다.
- `SCOPE_NAMES`·usage 문자열이 자동으로 5개가 되는지 확인한다(하드코딩된 프로파일 목록이 있으면 함께 갱신).

### D. env 조립 확장(`runSpringPass`)

- `pickFreePort(host)` — 후보 포트를 **그 host로 실제 listen**해 본다(`0.0.0.0` 포함). 시그니처에 host를 받도록 바꾸고 호출부를 갱신한다.
- 기동 env: `env.HOST = profile.host`.
- `profile.spool`이면 **패스 임시 루트 아래** 스풀 디렉토리를 만들어(`mkdirSync`) `env.DIST_SPOOL_DIR`에 절대경로로 넣는다. **패스마다 새로 만든다**(`--dual-run` 두 패스가 같은 스풀을 공유하면 자기 결정성 판정이 오염된다).
- `profile.token`이면 `env.COLLECTION_TOKEN = <러너에서 읽은 토큰>`.
- 접속 URL은 **언제나 `http://127.0.0.1:<port>`**다(`0.0.0.0`으로 접속하지 마라). `waitHealthy`·`targets.json`도 그 값을 쓴다.
- 기동 로그 한 줄에 `host=<profile.host> spool=<yes|no> token=<yes|no>`를 남긴다. **토큰 값은 절대 출력하지 않는다**(변수명·불리언만).

### E. 수집 토큰의 단일 출처 — 러너 소스에서 추출

- `readRunnerCollectionToken()`: `scripts/contract-run.mjs`를 **텍스트로 읽어** `const COLLECTION_TEST_TOKEN = '<값>'` 리터럴을 정규식으로 추출한다. 못 찾으면 `usageDie`로 즉시 죽인다(메시지에 **값은 담지 않는다** — 찾지 못한 사실과 파일 경로만).
- **`import`하지 마라**: 러너는 import 시점에 `main()`을 실행한다.
- **하드코딩하지 마라**: 값이 갈리면 default 프로파일의 모든 수집 케이스가 401이 되는데, 그 원인이 '계약 실패'로 위장된다.

### F. 스크립트 자기 검사

`scripts/**`는 eslint ignore 대상이라 정적 안전망이 인자 가드뿐이다. 다음을 실행 초반에 확인하고 실패하면 usage로 죽인다:

1. SCOPE의 프로파일 이름이 전부 러너 `PROFILES`에 존재하는가(러너 텍스트에서 이름 목록을 추출해 대조).
2. `token:true`인 프로파일이 하나라도 있으면 토큰 추출이 성공했는가.
3. `--files`가 지정된 단일 프로파일 실행에서 그 파일들이 존재하는가(기존 검사 유지).

## Acceptance Criteria

프레시 체크아웃이면 먼저: `cd d:/agents/harness && npm ci`

```bash
cd d:/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --profile failclosed --boot-check
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --parity
cd d:/agents/harness && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" node scripts/spring-contract.mjs --dual-run
cd d:/agents/harness && git status --porcelain
```

- 1번: exit 0(jar 존재 확보).
- 2번: exit 0 · 로그에 `host=0.0.0.0` · health 왕복 성공 · `sessions ok roles=R,D,Z` · java 프로세스 잔존 0. **방화벽 차단으로 실패하면 step을 `blocked`로 보고한다**(open_questions (c) — 우회 바인딩을 임의로 만들지 마라).
- 3번: exit 0 · **5 프로파일** 실행 · diffs **0** · 관측 수 **215 불변**(default 163 · minimal 45 · auth-negative 4 · prod-cookie 3 · failclosed **0**). 관측 수가 움직였으면 env 주입이 서버 동작을 바꾼 것이므로 실패다.
- 4번: exit 0 · 5 프로파일 diffs 0 · 프로파일마다 두 패스의 **pid·port·DATA_DIR·DIST_SPOOL_DIR이 서로 다른지** 로그로 확인.
- 5번 증분 = `scripts/spring-contract.mjs` · `phases/71-spring-distribution/index.json`(step 상태) **뿐**.

## 검증 절차

1. **A의 Node 실측을 먼저** 뽑고 요약에 싣는다(수치를 계획서에서 베끼지 않는다).
2. `--profile default --boot-check`로 스풀·토큰 주입이 기동을 깨지 않는지 확인(Spring이 아직 그 env를 읽지 않으므로 무해해야 한다).
3. 임시 스풀 디렉토리가 **패스마다 다른 경로**로 만들어지는지 `--dual-run --keep` 로그로 확인한 뒤, 확인이 끝나면 남은 임시 디렉토리를 직접 지운다.
4. **토큰 추출 실패 변이(원복)**: 추출 정규식을 일부러 틀리게 바꿔 `--profile default --boot-check`가 **usage 실패로 즉사**하는지 확인 → 원복. (조용히 빈 토큰으로 진행하면 안 된다.)
5. **stdout/stderr·리포트 어디에도 토큰 값이 없는지** 확인한다(`--keep`으로 남긴 리포트를 문자열 검색).
6. 리포 `news.db` size·mtime, `uploads/` 항목 수가 실행 전후 무변인지 확인.
7. `phases/71-spring-distribution/index.json`의 step0 상태를 갱신한다.

## 금지사항

- `scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`contract/**`·`docs/api-contract/**`를 고치지 마라. 이유: 계약 정본이다 — 대상 서버가 계약에 맞추는 것이지 그 반대가 아니다(phase 68 forward_notes (19)의 클라우드 브랜치가 러너를 개조해 정본을 침범한 전례).
- `failclosed`의 `files`에 케이스 파일을 넣지 마라. 이유: 수집 라우트가 없어 확정 red이고, scope는 green이 되는 step(step5)에서만 늘린다.
- `DIST_SPOOL_DIR`을 리포 안이나 고정 경로로 주지 마라. 이유: 패스 간 스풀 오염 + 리포 오염이며, `--dual-run` 결정성 판정이 무의미해진다.
- 토큰 값을 로그·리포트·에러 메시지에 담지 마라. 이유: 테스트 토큰이라도 자격증명 규율은 동일하다.
- `0.0.0.0`으로 **접속**하지 마라(바인드만 그 주소다). 이유: 접속 주소가 바뀌면 `BASE_URL` 기반 계약(pull self-health)이 갈린다.
- java 자식 env에 부모 env를 통째로 넘기지 마라. 이유: `.env` 잔재·외부 키·`NODE_OPTIONS`가 대상 서버 동작을 바꾼다(기존 허용 목록 방식 유지).
- Java 소스를 고치지 마라. 이유: 이 step은 하네스 전용이며, 관측 불변이 성공 조건이다.
