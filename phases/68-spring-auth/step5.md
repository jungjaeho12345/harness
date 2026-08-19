# Step 5: spring-contract-harness

계약 스위트의 auth/session 부분집합을 **Spring 서버에 겨눠** green으로 만들고 **Node/Spring diff 0**을 기계 판정하는 하네스를 만든다. 이 step이 phase 68의 합격 게이트다.

## 설계 결함(반드시 반영) — 이중 실행은 하네스가 소유한다

기존 `scripts/contract-run.mjs`의 `--base-url-map`(외부 대상) 경로는 서버를 기동·시드하지 않고 base URL로만 접근한다. 대상 Spring 서버가 **계속 떠 있으면** `/api/login` IP 레이트리밋(15분/10회) 카운터가 **프로파일 간 누적**되어 auth-negative가 다른 프로파일 로그인과 예산을 공유해 구조적으로 red가 된다(phase 67이 green이던 건 Node 러너가 **프로파일마다 서버를 새로 띄웠기** 때문 — contract-run.mjs가 프로파일당 임시 DATA_DIR·새 프로세스로 기동).

→ **이 하네스는 이중 실행을 직접 소유한다**: 프로파일마다(그리고 대상 Node/Spring 각각) **새 프로세스 + 새 임시 시드 DB + 빈 포트**로 서버를 띄우고, 부분집합 케이스를 실행한 뒤 죽인다. `--base-url-map`으로 상시 서버를 가리키는 방식을 쓰지 마라.

## 읽어야 할 파일

- 이전 step 산출물(`server-spring/**`) — 빌드 산출물(jar) 실행법·주입 키(`app.db-path`·`app.prod-cookie`·`server.port`·`server.address`).
- `/home/user/harness/scripts/contract-run.mjs` — **프로파일당 기동/시드/세션준비/케이스 spawn/데이터안전/정리의 정본 패턴**. 특히: 임시 DATA_DIR에 `createSchema`+`seedUsers`로 시드(299~305행) · 빈 포트 실listen(pickFreePort) · 자식 env 명시 조립(cleanEnv) · `CONTRACT_BASE_URL`/`CONTRACT_PROFILE`/`CONTRACT_CREDENTIALS`/`CONTRACT_SESSIONS`/`CONTRACT_REPORT_DIR` 주입(364~372행) · R/D/Z 3회 로그인 세션 준비(prepareSessions) · 리포 news.db/uploads before/after 무변 단언 · 비밀 파일 0600·finally 무조건 삭제 · killChild.
- `/home/user/harness/scripts/contract-diff.mjs` — `compareReports(a,b)`·`formatDiffLines` (리포트 2개 기계 비교). **재구현 금지 — import해서 그대로 쓴다.**
- `/home/user/harness/scripts/lib/cliArgs.mjs` — `flagValue`(인자 파싱).
- `/home/user/harness/src/db/schema.js`(`createSchema`)·`src/db/seed.js`(`seedUsers`,`SAMPLE_USERS`) — 시드 단일 출처(Node로 시드 → Spring/Node 둘 다 같은 DB shape).
- `/home/user/harness/contract/README.md` — 프로파일 프리셋·로그인 예산·자격증명 인터페이스·데이터 안전.
- `/home/user/harness/contract/lib/**`(http·session·record·profiles·fixtures·sse) 와 부분집합 케이스:
  - `contract/cases/default/{health,auth,users,session-guard}.contract.js`
  - `contract/cases/auth-negative/login-negative.contract.js`
  - `contract/cases/prod-cookie/cookie-prod.contract.js`
  이 파일들과 `contract/lib/**`는 **동결이다 — 한 줄도 고치지 마라.** 서버가 계약에 맞춘다.

## 작업

1. 새 스크립트 `scripts/contract-run-spring.mjs`를 만든다. auth/session **부분집합**만 대상으로 한다(위 6개 케이스 파일, 프로파일 3종). 프로파일별 케이스 목록(default=health/auth/users/session-guard, auth-negative=login-negative, prod-cookie=cookie-prod)을 이 스크립트가 명시 소유한다(`requireProfile`가 프로파일 불일치를 즉시 실패시키므로 한 실행에 프로파일을 섞지 않는다).
2. **대상 2종(Node·Spring) 각각, 프로파일 3종 각각**을 다음처럼 격리 실행한다(총 6 서버 기동, 전부 새 프로세스):
   - 임시 디렉토리에 `news.db` 생성 → `createSchema`+`seedUsers`(Node `src/db` 직접) → **리포 news.db는 절대 열지 않는다**.
   - 빈 포트 실listen 확보. 자식 env 명시 조립(외부 API 키·`.env` 미로드).
   - Node 대상: `node server/index.js`를 `DATA_DIR`·`PORT`·`HOST`·`SPA_DIR=''`로 기동(contract-run.mjs와 동형). prod-cookie 프로파일은 `NODE_ENV=production`·`FORCE_HTTPS=false`.
   - Spring 대상: `java -jar server-spring/target/<jar>`(또는 `./mvnw -q spring-boot:run`)를 `--app.db-path=<임시 news.db>`·`--server.port=<port>`·`--server.address=127.0.0.1`로 기동. prod-cookie 프로파일은 `--app.prod-cookie=true`, 그 외 false.
   - `/api/health` 왕복으로 기동 대기(실패는 조용한 skip이 아니라 진단 첨부 + 종합 실패).
   - `default`·`failclosed` 성격(sessions:true) 프로파일은 R/D/Z 3회 로그인으로 `sessions.json` 준비. auth-negative·prod-cookie는 준비하지 않는다(케이스가 직접 로그인 — contract-run.mjs PROFILES 표의 sessions 플래그 동형). credentials.json은 `SAMPLE_USERS`에서 조립(0600·finally 삭제).
   - 케이스를 `node --test --test-concurrency=1 <프로파일 파일들>`로 spawn하고 `CONTRACT_BASE_URL`/`CONTRACT_PROFILE`/`CONTRACT_CREDENTIALS`/`CONTRACT_SESSIONS`/`CONTRACT_REPORT_DIR`를 주입한다. exit≠0이면 그 대상·프로파일 실패.
   - 서버를 반드시 종료한다(killChild 동형 — 잔존 = 다음 기동 오염).
3. 각 대상의 관측(JSONL)을 병합해 정규화 리포트 2개(nodeReport·springReport)를 만들고(contract-run.mjs `readObservations`·정렬 동형), `compareReports(nodeReport, springReport)`로 **diff 0**을 판정한다(차이 있으면 상세 출력 + exit 1).
4. 게이트 3종을 모두 통과해야 성공:
   - (a) Spring 대상 전 케이스 green(부분집합).
   - (b) Node 대상 전 케이스 green(기준선 — 회귀 감시).
   - (c) `compareReports` diffCount == 0(Node/Spring 정규화 관측 동일).
5. 리포 데이터 안전: 리포 `news.db`·`uploads/` before/after 무변 단언(contract-run.mjs `repoDataSnapshot` 동형). 비밀 파일(credentials/sessions)은 0600·finally 무조건 삭제.
6. `package.json`에 `"test:contract:spring": "node scripts/contract-run-spring.mjs"` 스크립트를 **추가만** 한다(기존 스크립트 무변경). Spring jar가 없으면 먼저 `cd server-spring && ./mvnw -q -DskipTests package`가 필요함을 스크립트가 안내하거나 자동 수행한다.

핵심 규칙: `contract/lib/**`·`contract/cases/**`·`docs/api-contract/**`·`scripts/contract-run.mjs`·`scripts/contract-diff.mjs`를 **수정하지 마라**(재사용은 import). 케이스가 서버에 맞추는 게 아니라 서버가 케이스에 맞춘다.

## Acceptance Criteria

```bash
# 0) Spring 서버 빌드
cd /home/user/harness/server-spring && ./mvnw -q -DskipTests package

# 1) 핵심 게이트: Spring 부분집합 green + Node 기준선 green + Node/Spring diff 0
cd /home/user/harness && npm run test:contract:spring

# 2) 기존 Node 계약 스위트 무회귀(부분집합에 한정하지 않는 전체는 시간이 크면 최소 default 프로파일)
cd /home/user/harness && npm run test:contract -- --profile default --files contract/cases/default/health.contract.js,contract/cases/default/auth.contract.js,contract/cases/default/users.contract.js,contract/cases/default/session-guard.contract.js

# 3) 기존 npm test 무회귀(1328 불변)
cd /home/user/harness && npm test
```

- `npm run test:contract:spring`이 exit 0(Spring green · Node green · diff 0)이고, `npm test`가 1328 불변이며 리포 news.db/uploads가 안 변한다.

## 검증 절차

1. AC 커맨드 전부 실행.
2. 아키텍처 체크리스트:
   - 프로파일마다·대상마다 **새 프로세스 + 새 임시 시드 DB**로 기동하는가(레이트리밋 카운터 누적 구조 제거)?
   - `--base-url-map`으로 상시 서버를 가리키는 방식을 쓰지 않았는가?
   - `contract/lib`·`contract/cases`·`docs/api-contract`·`contract-run.mjs`·`contract-diff.mjs`가 무변경인가(`git diff --stat`으로 확인)?
   - 리포 news.db/uploads before/after 무변 단언이 있는가? 비밀 파일 0600·삭제가 있는가?
   - `package.json`은 스크립트 1줄 추가만인가?
3. 결과 반영: 성공 → `completed` + `summary`(하네스 스크립트·부분집합 파일·게이트 3종 결과·diff 0·npm test 수). Maven 패키지/네트워크 실패 → `blocked` + 사유. 케이스 red가 3회 자가교정으로도 안 풀리면 → `error`(원인 분석 — 서버 계약 불일치 지점 명시).

## 금지사항

- `contract/lib/**`·`contract/cases/**`·`docs/api-contract/**`를 수정해 green을 만들지 마라. 이유: 계약은 동결 사양이다 — 케이스를 고치면 패리티 판정이 무의미해진다(서버가 맞춰야 한다).
- `scripts/contract-run.mjs`·`scripts/contract-diff.mjs`를 수정하지 마라. 이유: Node 경로 회귀·비교 규칙 분기를 만든다(diff 규칙은 단일 출처).
- 상시(persistent) 서버 하나에 전 프로파일을 겨누지 마라. 이유: 로그인 레이트리밋 카운터 누적으로 구조적 red(이 step의 핵심 결함 회피 사유).
- 리포 `news.db`를 열거나 시드하지 마라. 이유: DB 비파괴 — 임시 시드 DB만.
- `server/**`·`src/**`·`web/**`를 수정하지 마라. 이유: 기존 npm test 1328 불변(시드는 `src/db` import 재사용이지 수정이 아니다).
- 기존 테스트를 깨뜨리지 마라.
