# Step 1: parity-harness

## 목표
계약 러너가 **Spring 서버의 수명을 직접 소유**하도록 확장한다. `scripts/contract-run.mjs`에 `--target <node|spring>`을 추가하고, `spring`일 때 **프로파일마다 새 Spring 프로세스**를 임시 시드 DB로 띄운다(Node 경로와 동형). 그리고 Node↔Spring 리포트를 교차 비교하는 오케스트레이터 `scripts/contract-parity-spring.mjs`를 만든다. 이 step은 **Node 스크립트 계층만** 건드린다(Java 무수정).

## 왜 이 구조인가 (과거 ②검토가 잡은 핵심 결함 — 반드시 반영)
- 이중 실행을 "외부에 계속 떠 있는 서버 1개"에 맡기면 **로그인 레이트리밋·계정잠금 카운터가 프로파일 간 누적**된다. 특히 `auth-negative`는 일부러 429/423까지 카운터를 소진하므로, 다른 프로파일과 프로세스를 공유하면 구조적으로 red가 된다.
- 해결: 러너가 프로파일마다 **새 프로세스 + 새 임시 DATA_DIR**로 Spring을 띄운다(현행 Node 경로 `runProfile`이 이미 그렇게 한다 — 그 대칭을 Spring에 준다). `auth-negative`는 자기 전용 Spring 프로세스라 카운터가 격리된다.
- 이 phase의 패리티 판정 = **같은 큐레이션 파일 집합을 Node와 Spring 각각에 (프로파일마다 새 프로세스로) 돌려** 리포트 2개를 만들고 `scripts/contract-diff.mjs`로 **diff 0**.

## 읽어야 할 파일
- `scripts/contract-run.mjs` 전체 — 특히 `runProfile`(서버 spawn·health-gate·세션 준비·케이스 실행·teardown·비밀파일 삭제), `PROFILES` 표, `cleanEnv`, `repoDataSnapshot`(데이터 안전), `main`의 프로파일 루프. **이 파일이 대상 서버를 어떻게 띄우는지 아는 유일한 코드**라는 규율을 유지하라.
- `scripts/contract-diff.mjs` — CLI 사용법(`node scripts/contract-diff.mjs <A.json> <B.json>`, diff 0이면 exit 0). 재사용만 하고 비교 규칙을 새로 만들지 마라.
- `contract/README.md` — 프로파일 프리셋·로그인 예산·대상 사전조건.
- `phases/68-spring-auth/step0.md`의 "환경변수 계약" 표 — 하네스가 Spring에 넘길 env(`APS_DB_FILE`·`PORT`·`HOST`·`APS_PROD_COOKIE`).
- 이전 step 산출물: `server-spring/`(step0 — health만 있는 부팅 가능 Spring, jar 경로 `server-spring/target/spring-auth.jar`).

## 작업 (TDD — 기존 러너 회귀 테스트 먼저)
1. **기존 Node 경로 무회귀 확인 먼저**: `npm run test:contract -- --profile prod-cookie --boot-check`가 지금도 green인지 실행해 기준선을 잡는다(변경 후에도 동일해야 한다).
2. `scripts/contract-run.mjs`에 `--target <node|spring>`(기본 `node`) 추가. 인자 가드는 `scripts/lib/cliArgs.mjs` 패턴을 따른다(잘못된 값은 die).
3. `target==='spring'`일 때 `runProfile`의 **서버 spawn 부분만** 분기한다. 나머지(임시 DATA_DIR 시드=`createSchema`+`seedUsers`, health-gate, 세션 준비, 케이스 spawn with `CONTRACT_BASE_URL`, teardown/kill, 비밀파일 삭제, 데이터 안전 스냅샷)는 **그대로 재사용**한다.
   - Spring spawn: `spawn('java', ['-jar', <springJarAbs>], { env })`. env는 **명시 조립**: `APS_DB_FILE=<임시 news.db 절대경로>`, `PORT=<pickFreePort>`, `HOST=<profile.host>`, 프로파일이 `prod-cookie`면 `APS_PROD_COOKIE='true'`. 그리고 `PATH`·`JAVA_HOME`만 상속. 외부 API 키·`NODE_*`는 넘기지 않는다(egress 0).
   - jar 경로 해석: 환경변수 `APS_SPRING_JAR`가 있으면 그것, 없으면 `server-spring/target/spring-auth.jar`. 파일이 없으면 **한 번** `mvn -f server-spring/pom.xml -q -DskipTests package`로 빌드(빌드 실패는 조용한 skip 금지 — 진단 첨부 + exit 1).
   - health-gate는 기존 `healthOk(baseUrl, timeout, child)`를 그대로 쓴다(Spring 부팅은 Node보다 느리다 — `--timeout` 기본으로 부족하면 AC에서 넉넉히 준다). 접속은 항상 `http://127.0.0.1:<port>`.
   - Node 경로가 사용하는 spool/token env(`DIST_SPOOL_DIR`·`COLLECTION_TOKEN`)는 이 phase의 Spring 대상 프로파일(default·auth-negative·prod-cookie)에 **불필요**하므로 Spring env에 넣지 않는다(auth 슬라이스는 collection/distribution을 구현하지 않는다).
4. `scripts/contract-parity-spring.mjs`(신규, 얇은 오케스트레이터): 이 phase의 큐레이션 집합을 프로파일별로 Node·Spring 각각 `--out`으로 실행하고 프로파일별로 `contract-diff`를 돌려 **전부 diff 0**이면 exit 0. 큐레이션 표(이 파일에 하드코딩):
   - `default` → `contract/cases/default/health.contract.js`, `contract/cases/default/auth.contract.js`, `contract/cases/default/session-guard.contract.js`
   - `auth-negative` → `contract/cases/auth-negative/login-negative.contract.js`
   - `prod-cookie` → `contract/cases/prod-cookie/cookie-prod.contract.js`
   - **주의(러너 `--files`는 전역 적용)**: `--files`는 선택된 모든 프로파일에 같은 목록을 적용하므로, **프로파일당 한 번씩 별도 러너 실행**(`--profile <p> --files <그 프로파일 파일들>`)으로 호출해야 한다(한 실행에 여러 프로파일+파일을 섞으면 `requireProfile` 불일치로 죽는다). 각 실행이 프로파일당 새 Spring 프로세스를 뜻하므로 카운터 격리는 자동으로 성립한다.
   - 리포트는 OS 임시 디렉토리에만 쓴다(리포 오염 금지). 성패·경로를 stdout에 명시.
5. `package.json` scripts에 추가: `"test:contract:spring": "node scripts/contract-run.mjs --target spring"`, `"test:contract:parity": "node scripts/contract-parity-spring.mjs"`.

## 이 step에서 검증 가능한 범위 (login 미구현 상태)
step4까지 login/session이 없으므로 **세션이 필요 없는(sessions:false) 프로파일**로만 하네스를 실증한다. `default`의 케이스 green은 step4~6에서 완성된다.

## Acceptance Criteria (실행 커맨드)
```bash
# 0) jar 준비(step0 산출물)
mvn -f server-spring/pom.xml -q -DskipTests package && test -f server-spring/target/spring-auth.jar
# 1) 하네스가 Spring을 프로파일마다 새 프로세스로 띄워 health까지 도달(sessions:false 프로파일)
node scripts/contract-run.mjs --target spring --profile auth-negative --boot-check --timeout 60000
node scripts/contract-run.mjs --target spring --profile prod-cookie  --boot-check --timeout 60000
# 2) Node 경로 무회귀 — 같은 커맨드가 여전히 Node를 띄운다
node scripts/contract-run.mjs --target node --profile prod-cookie --boot-check
npm run test:contract -- --profile prod-cookie --boot-check
# 3) 스크립트 정적 안전망
npm run lint
```
- 1)의 두 커맨드는 각각 `boot ok` + `shutdown ok`를 출력하고 exit 0이어야 한다(프로파일마다 별도 프로세스·별도 임시 DATA_DIR).
- 리포 `news.db`·`uploads/`가 무변이어야 한다(러너의 데이터 안전 단언이 이를 강제 — 실패 시 exit 1).

## 검증 절차
- 두 `--boot-check`가 각각 다른 포트/임시 디렉토리를 쓰는지 stdout `boot ok ... port=` 라인으로 확인(프로세스 격리 = 카운터 격리의 근거).
- `contract-parity-spring.mjs`는 이 step에서 login 의존 파일이 아직 red이므로 **완주 AC로 걸지 않는다**(step6에서 최종 게이트). 이 step은 스크립트 존재 + `--help`/드라이 경로 정도만 lint로 확인.
- Maven 빌드가 프록시/오프라인으로 실패하면 `blocked`(step0과 동일 사유) 기록 후 중단.

## 금지사항
- Spring을 "한 번 띄워 계속 재사용"하는 외부 서버 방식으로 만들지 마라. 이유: 프로파일 간 로그인 레이트리밋/계정잠금 카운터 누적으로 `auth-negative`가 구조적으로 red가 된다(이 step의 존재 이유).
- `contract-diff.mjs`의 비교 규칙을 새로 구현하거나 느슨하게 고치지 마라(값 비우기·bodyKeys 비교 끄기 금지). 이유: 패리티 판정이 거짓 green이 된다.
- 리포 `news.db`에 Spring을 바인딩하지 마라(항상 임시 시드 DB). 이유: DB 비파괴 최상위 규칙 위반.
- `server/**`·`src/**`·`web/**`를 계약 케이스 경로로 import하게 만들지 마라. 이유: 프레임워크 중립이 깨진다(케이스는 `CONTRACT_BASE_URL`로만).
- Java 코드(`server-spring/**`)를 수정하지 마라. 이유: 이 step은 하네스(Node) 계층 전용이다.
