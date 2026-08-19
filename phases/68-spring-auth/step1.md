# Step 1: contract-target-harness

계약 스위트(`contract/**`)를 **Spring 서버에 겨누는 실행 경로**를 만든다. 산출물은 `scripts/spring-contract.mjs`(신설) 하나 + `package.json`의 npm script 1줄 + `server-spring/README.md`의 실행 절이다. Spring 코드는 이 step에서 한 줄도 쓰지 않는다.

이 하네스가 **이 phase 계열 전체의 진행률 측정 수단**이다. 이후 모든 step의 Acceptance Criteria가 "이 스크립트로 계약 파일 N개가 green"이라는 형태가 된다.

## 읽어야 할 파일

- `phases/68-spring-auth/index.json` — decisions **(2)(5)(6)(7)(8)(16)(17)** · baseline · order
- `scripts/contract-run.mjs` — **정독 필수**. 특히: 외부 대상 모드(`--base-url-map`·`--credentials`, 550~563행), 프로파일 표 `PROFILES`(49~60행), `resolveCaseFiles`(260~269행 — `--files`는 **선택된 전 프로파일에 동일 적용**된다), 세션 준비 `prepareSessions`(228~258행 — R/D/Z 정확 3회 로그인), skipped/실패 정책(`profile-unavailable`·`profile-boot-failed`), 리포트 스키마와 `--out`·`--keep`·`--dual-run` 규칙, 리포 데이터 무변 단언(`repoDataSnapshot`)
- `scripts/contract-diff.mjs` — 비교 규칙(매칭 키 `(profile, routeId, tag, caseId)`, `meta.target`은 차이가 아님, `skipped-vs-observed`)
- `contract/README.md` — "대상 서버 사전조건 계약"(계정 3종·프로파일 프리셋 필수3/선택2·기존 데이터 무관)·"케이스 작성 규칙"(로그인 예산·공용 세션 복구 의무)
- `docs/api-contract/README.md` — "68+ (Spring 대상) 사용법" 절(3단계 커맨드)·"계정 표기 규율"
- `contract/lib/profiles.js` · `contract/lib/session.js` — `requireProfile`(프로파일 오배치 시 로드 시점 throw), `credentials`/`sid`/`republish`
- `src/db/schema.js`(`createSchema`) · `src/db/seed.js`(`seedUsers`·`SAMPLE_USERS`) — 하네스가 임시 DATA_DIR을 시드할 때 쓰는 **단일 출처**
- `scripts/lib/cliArgs.mjs` — 인자 파싱 헬퍼(`flagValue`) — `scripts/**`는 eslint 대상이 아니라 인자 가드가 유일한 정적 안전망이다
- `server-spring/README.md` — step0이 적은 실행 커맨드·환경변수 대응표

## 배경 (계약 러너의 제약 — 설계가 여기서 결정된다)

- 외부 대상 모드에서 러너는 **서버를 띄우지도, 시드하지도 않는다**. `--credentials`가 **필수**다(비밀번호를 추측하지 않는다).
- `--files`는 선택된 **모든** 프로파일에 그대로 적용된다. 그런데 케이스 파일은 상단에서 `requireProfile('<name>')`을 호출해 다른 프로파일에서 실행되면 즉시 throw한다. **따라서 프로파일마다 한 번씩 러너를 호출해야 한다**(한 번에 여러 프로파일 + 여러 파일은 불가능).
- 그래서 리포트도 프로파일당 1개가 나온다. Node 대조(패리티)도 **같은 파티션**으로 뽑아 프로파일 쌍끼리 diff한다.
- `default` 프로파일은 러너가 R/D/Z **3회 로그인**해 공용 세션을 만든다 — 이것이 실패하면 `profile-boot-failed`이고 종합 exit는 1이다. 즉 로그인이 구현되기 전(step5 이전)에는 default 프로파일의 부팅 자체가 실패한다. **그것이 정상이며 숨기지 않는다.**
- `auth-negative`·`prod-cookie`는 러너가 세션을 준비하지 않는다(`sessions:false`) — `/api/health`만 있으면 `--boot-check`가 통과한다. 그래서 이 step의 AC가 성립한다.
- **러너의 `--dual-run`은 외부 대상에 쓸 수 없다(중요 — 이 step의 설계를 결정한다).** 두 겹의 이유가 있다:
  1. **가드**: `scripts/contract-run.mjs` 118행이 `--dual-run`과 `--out`의 병용을 즉시 거부한다(리포트 경로는 그 모드가 스스로 정한다). 이 하네스는 프로파일별 리포트를 모아야 해서 `--out`이 필수다 — 두 플래그는 공존할 수 없다.
  2. **가드를 피해도 계약이 깨진다**: 러너의 `runDualRun`(500~509행)은 **같은 base URL**로 2패스를 돌린다. 러너가 서버를 직접 spawn하는 Node 대상에서는 프로파일마다 서버가 새로 뜨므로 로그인 IP 카운터가 리셋되지만(phase 67의 dual-run이 green이었던 이유가 이것이다), **외부 대상에서는 같은 프로세스가 계속 떠 있어 카운터가 누적된다**(로그인 레이트리밋 15분/10회 — `server/index.js` 609~612행). `default`는 패스당 6회(러너 3 + auth 2 + session-guard 1) → 2패스 12회 > 10이라 패스 2에서 429이고, `auth-negative`는 패스 1이 **설계상 정확히 11회**를 소진하므로 패스 2는 첫 케이스부터 429다. 둘 다 확정 red다.
  → 그래서 **자기 결정성 판정(dual-run)은 이 하네스가 직접 소유한다**: 프로파일마다 **독립된 임시 DATA_DIR + 새 Spring 프로세스**로 두 패스를 돌리고 리포트 2개를 `contract-diff.mjs`로 비교한다. **"같은 인스턴스에 2회"는 상태를 갖는 대상(레이트리밋·계정 잠금 카운터·세션 스토어)에서는 성립하지 않는다** — 이 원칙을 전 step이 공유한다.

## 작업

### A. `scripts/spring-contract.mjs`

**CLI**(가드는 `scripts/lib/cliArgs.mjs`의 `flagValue`를 쓴다. 알 수 없는 인자는 usage 출력 후 exit 1):

```
node scripts/spring-contract.mjs [--profile <name>]... [--files <path>[,<path>]...]
                                 [--jar <path>] [--java-home <path>] [--out-dir <dir>]
                                 [--boot-check] [--parity] [--dual-run] [--keep] [--timeout <ms>]
```

- `--profile` 반복 가능. 미지정이면 **scope 표의 전 프로파일**.
- `--files` 지정 시 그 프로파일의 scope 표를 덮어쓴다(단일 프로파일 실행 전용 — 2개 이상 프로파일과 함께 쓰면 즉시 실패시켜라. 이유: 케이스가 `requireProfile`로 죽는다).
- `--jar` 미지정 시 `server-spring/target/*.jar`에서 실행 가능 jar를 찾는다. 없으면 **빌드 커맨드를 안내하고 exit 1**(자동 빌드 금지 — 금지사항 참조).
- `--java-home` 미지정 시 `SPRING_JAVA_HOME` → `JAVA_HOME` 순으로 읽고, 둘 다 없으면 포터블 JDK 경로를 안내하고 exit 1(시스템 java 1.8로 떨어지면 원인 불명 기동 실패가 된다).
- `--out-dir` 미지정 시 OS 임시 디렉토리에 `mkdtemp`로 만들고, **성공 + `--keep` 없음**이면 정리한다(실패·`--keep`이면 진단 자산으로 보존). 어느 경우에도 경로를 요약에 1줄 출력하고, **리포 안에는 어떤 경우에도 쓰지 않는다**(러너의 `--out` 미지정 규칙과 동형).
- `--boot-check`는 러너에 그대로 전달한다(케이스 없이 기동·health·세션 준비만).
- `--dual-run`은 **이 스크립트가 직접 수행한다**(러너에 전달하지 마라 — 배경의 두 가지 이유). 프로파일마다: 패스 A(임시 DATA_DIR#1 + Spring 프로세스#1 → 러너 `--out <outDir>/<p>-a.json`) → **프로세스 종료·DATA_DIR 폐기** → 패스 B(임시 DATA_DIR#2 + Spring 프로세스#2 → 러너 `--out <outDir>/<p>-b.json`) → `contract-diff.mjs`로 A·B 비교. 차이가 있으면 exit 1. 비교 규칙은 재구현하지 말고 `contract-diff.mjs`(CLI 실행 또는 export된 `compareReports` import)에 위임한다 — 규칙이 두 벌로 갈라지면 판정이 두 벌이 된다.
- `--dual-run`과 `--boot-check`의 병용은 **거부**한다(러너 119행과 같은 근거: 관측 0건끼리의 비교는 차이 0을 보장할 뿐 계약 판정이 아니다).
- `--parity`는 같은 파티션으로 **Node 대상 리포트**도 뽑아(러너를 `--base-url-map` 없이 호출) `scripts/contract-diff.mjs`로 프로파일 쌍마다 비교하고, 차이가 있으면 exit 1.

**scope 표(이 phase가 소유 — 파일 목록은 정렬 순서 그대로)**:

| 프로파일 | 케이스 파일 | Spring 기동 env |
|---|---|---|
| `default` | `contract/cases/default/auth.contract.js`, `contract/cases/default/crosscutting.contract.js`, `contract/cases/default/health.contract.js`, `contract/cases/default/session-guard.contract.js` | `DATA_DIR`=임시, `PORT`=프로브, `HOST`=127.0.0.1 |
| `auth-negative` | `contract/cases/auth-negative/login-negative.contract.js` | 위와 동일 · **전용 인스턴스**(카운터 격리) |
| `prod-cookie` | `contract/cases/prod-cookie/cookie-prod.contract.js` | 위 + `APP_ENV=production` |

- 표는 **데이터로** 둔다(후속 phase가 행만 추가하면 되도록). `minimal`·`failclosed`는 이 phase의 표에 넣지 않는다(decisions (7)).
- 파일 목록은 알파벳 정렬 순서를 유지한다 — 러너가 디렉토리 스캔으로 도는 순서와 같아야 `auth.contract.js`의 **공용 세션 복구 규약**(파일 끝에서 R 재로그인)이 뒤 파일에 의도대로 이어진다.
- `health.contract.js`가 default 행에 있는 이유: step0이 `/api/health`를 구현하므로 **계약 검증 없이 남겨 두면 decisions (8)①("스텁·미검증 구현 금지") 자기 위반**이다. 게다가 이 케이스는 **로그인 0회·부수효과 0**이면서 `content-type`을 리포트에 실어 **JSON Content-Type 패리티를 가장 싸게 잠근다**(decisions (9)의 조기 경보). 다만 이 step과 step0~4의 AC에는 넣지 않는다 — default 프로파일은 러너의 세션 준비(로그인 3회) 때문에 step5 전에는 부팅 자체가 실패하므로, 실제 실행은 **step5부터** 포함한다.

**프로파일 1개 실행 절차**(순서가 계약이다):

1. OS 임시 디렉토리에 프로파일 전용 루트를 만들고 그 아래 `data/`에 `news.db`를 **Node의 `createSchema` + `seedUsers`로** 생성한다(decisions (5) — 스키마·시드 단일 출처). 리포 `news.db`는 절대 열지 않는다.
2. 빈 포트를 **[15000, 20000)**에서 실제 listen으로 확보한다(decisions (16) — 추측 금지, `contract-run.mjs`의 `pickFreePort` 동형).
3. `java -jar <jar>`로 기동한다. env는 **명시 조립**한다(`DATA_DIR`·`PORT`·`HOST`·프로파일별 추가 키만. 부모 env를 통째로 넘기지 마라 — 결정성).
4. `/api/health`가 200 `{ok:true}`를 돌려줄 때까지 대기(타임아웃 = `--timeout`, 기본 45000ms). 대기 중 자식이 죽으면 즉시 실패하고 **자식 stdout/stderr를 진단에 첨부**한다.
5. `targets.json`(`{ "<profile>": "http://127.0.0.1:<port>" }`)과 `creds.json`(`{R,D,Z} × {userId,password}` — `SAMPLE_USERS`에서 조립)을 임시 디렉토리에 **mode 0600**으로 쓴다.
6. `node scripts/contract-run.mjs --profile <p> --files <표> --base-url-map <targets> --credentials <creds> --out <outDir>/<p>.json [--boot-check]`를 자식으로 실행하고 stdout/stderr를 그대로 흘린다. **러너에 `--dual-run`을 전달하지 마라**(배경 참조 — `--out`과 병용 불가이고, 같은 인스턴스 2패스는 레이트리밋 카운터 때문에 확정 red다).
7. `finally`에서 **항상**: java 자식 종료(kill → 확인 → SIGKILL 폴백), `creds.json`·`targets.json` 삭제(성패·`--keep` 무관 — 비밀 파일 수명 규율).

`--dual-run`이면 위 1~7을 **그 프로파일에 대해 두 번**(리포트 이름만 `-a`/`-b`로 다르게) 수행한 뒤 `contract-diff.mjs`로 비교한다. 두 패스는 **DATA_DIR도 프로세스도 공유하지 않는다** — 그래야 레이트리밋·계정 잠금·세션 스토어 상태가 리셋되어 "같은 대상에 같은 입력이면 같은 리포트"라는 판정이 성립한다.

**종료 판정·요약 1줄**: `spring-contract ok|FAILED profiles=<n> reports=<경로들> diffs=<n|->` 형태로 stdout에 남긴다. 실패 사유는 stderr에 `FAIL ` 접두로 모아 출력한다.

**데이터 안전(필수)**: 실행 전후로 리포 `news.db`·`uploads/` 스냅샷을 떠 무변을 단언한다(러너도 하지만 이 스크립트도 자체 단언한다 — 잘못 설정된 Spring이 리포 DB를 열 수 있는 유일한 위험 지점이 여기다). 변동이 있으면 FAIL.

**로그 규율**: 비밀번호·세션 토큰·쿠키 값을 stdout/stderr/파일 어디에도 쓰지 않는다. 자식 env를 통째로 덤프하지 않는다.

### B. `package.json`

`"test:contract:spring": "node scripts/spring-contract.mjs"` **1줄만** 추가한다. `test` 스크립트는 건드리지 않는다(`npm test`는 1328 그대로여야 한다).

### C. `server-spring/README.md`

"계약 스위트로 검증하기" 절을 추가한다: 빌드 → `npm run test:contract:spring` → `--parity` → 실패 시 리포트 읽는 법(리포트는 마스킹돼 있어 그대로 공유 가능). `creds.json`은 **리포 밖 임시 디렉토리에만** 만들어지고 항상 삭제된다는 사실을 명시한다.

## Acceptance Criteria

```bash
cd /d/agents/harness/server-spring && JAVA_HOME="D:/agents/tools/jdk-21.0.12+8" ./mvnw -B -q package -DskipTests
cd /d/agents/harness && node scripts/spring-contract.mjs --boot-check --profile auth-negative --profile prod-cookie
cd /d/agents/harness && node scripts/spring-contract.mjs --boot-check --profile default; echo "boot-check-default expected-exit=1 actual-exit=$?"
cd /d/agents/harness && node scripts/spring-contract.mjs --profile prod-cookie > "${TEMP:-/tmp}/s1-prodcookie.log" 2>&1; echo "prod-cookie expected-exit=1 actual-exit=$?"; tail -20 "${TEMP:-/tmp}/s1-prodcookie.log"
cd /d/agents/harness && node scripts/spring-contract.mjs --dual-run --boot-check --profile prod-cookie; echo "dual-run-with-boot-check expected-exit=1 actual-exit=$?"
cd /d/agents/harness && npm test
cd /d/agents/harness && npm run lint
cd /d/agents/harness && git status --porcelain
```

**AC 커맨드 해설**(echo 문자열은 ASCII 고정 — 한글 인라인 금지, win32 Bash 규약):

- 2번째: **exit 0**이어야 한다(health만으로 통과하는 두 프로파일).
- 3번째: **의도된 red(exit 1)**. `default`는 러너가 R/D/Z 로그인을 시도하므로 `profile-boot-failed`가 나야 하고, 진단 메시지가 "세션 준비 실패"와 로그인 응답 상태를 가리켜야 한다. **이 실패가 나오지 않으면 하네스가 부팅 실패를 삼키고 있다는 뜻이다.**
- 4번째: **의도된 red(exit 1)**. 로그인 미구현 상태에서 케이스가 도는지, 실패 출력이 사람이 읽을 수 있는지 확인한다. 출력은 파이프 대신 **파일로 받은 뒤** `tail`로 읽는다 — 파이프라인 뒤의 `$?`는 `tail`의 종료코드라 판정이 무의미해진다.
- 5번째: **의도된 red(exit 1)**. `--dual-run`과 `--boot-check` 병용 거부 가드의 실증(관측 0건끼리의 비교는 판정이 아니다).
- 세 red의 출력 요지를 요약에 적는다.

## 검증 절차

1. **red 먼저**: 스크립트를 쓰기 전에 손으로 러너를 외부 대상 모드로 한 번 호출해 본다(`--base-url-map`만 주고 `--credentials`를 빼면 즉시 실패하는지 등) — 러너 계약을 실측으로 확인한 뒤 자동화한다.
2. AC 커맨드를 위에서부터 실행한다. 2번 커맨드는 **연속 2회** 돌려 둘 다 green인지 본다(임시 디렉토리·포트 누수가 있으면 2회차에서 드러난다).
3. **자기 변이 3종**(각각 확인 후 원복): (a) java 자식을 일부러 잘못된 jar 경로로 띄워 부팅 실패 진단(자식 stderr 첨부)이 나오는지, (b) `creds.json` 삭제 로직을 잠시 건너뛰어 임시 디렉토리에 비밀 파일이 남는 것을 확인한 뒤 원복해 **남지 않음**을 재확인, (c) 리포 데이터 스냅샷 경로를 임시 디렉토리로 바꿔 무변 단언이 실제로 FAIL을 만드는지.
4. 실행 후 OS 임시 디렉토리에 `spring-contract-*`·`contract-*` 잔존이 0인지 확인한다(성공 + `--keep` 없음일 때). 실패 실행이 진단용으로 남긴 디렉토리는 확인 후 직접 삭제한다.
5. **비밀 누출 스캔**: 실행 로그·리포트에 64-hex 토큰·`SAMPLE_USERS` 비밀번호 문자열이 없는지 확인한다(0건이어야 한다).
6. **`--dual-run` 경로는 이 step에서 end-to-end 실증이 불가능하다**(계약 케이스가 아직 전부 red다) — 구현은 여기서 하되 **첫 실증은 step5**(cookie-prod 프로파일)다. 이 step에서는 (a) `--boot-check` 병용 거부 가드 (b) 두 패스가 **서로 다른 임시 DATA_DIR·서로 다른 java PID**로 뜨는지(로그의 경로·PID를 눈으로 확인) 두 가지만 확인하고 그 사실을 요약에 정직하게 적는다.
7. `npm test` 1328/1328 · `npm run lint` clean(`scripts/**`는 eslint ignore지만 `package.json` 편집이 다른 것을 깨지 않았는지 확인).
8. `git status --porcelain` 증분 = `scripts/spring-contract.mjs` · `package.json` · `server-spring/README.md` · `phases/68-spring-auth/index.json`.
9. index.json step1 status·summary 갱신(세 의도된 red의 출력 요지·포트 실측·임시 파일 수명·dual-run 미실증 사실 포함).

## 금지사항

- `scripts/contract-run.mjs`·`scripts/contract-diff.mjs`·`contract/**`·`docs/api-contract/**`를 고치지 마라. 이유: 러너를 고쳐 통과시키는 순간 패리티 판정이 거짓 green이 된다 — 이 하네스의 존재 이유가 사라진다(decisions (17)). Spring이 계약과 다르면 **Spring을 고친다**.
- 하네스가 Maven을 호출해 jar를 자동 빌드하게 만들지 마라. 이유: 빌드는 수 분·네트워크·JDK 환경 변수에 의존하고, 실패가 "계약 실패"와 섞이면 진단이 무너진다. jar가 없으면 **커맨드를 안내하고 종료**한다.
- 리포 `news.db`·`uploads/`를 Spring의 `DATA_DIR`로 주지 마라. 절대 금지. 이유: DB 비파괴 최상위 규칙이며, 되돌릴 수 없다. 프로파일마다 임시 DATA_DIR을 새로 만든다.
- `creds.json`·`targets.json`을 리포 안에 쓰지 마라(그리고 커밋하지 마라). 이유: 외부 대상 자격증명 파일은 사용자 소유 비밀이며, 리포에 남으면 그대로 유출 표면이 된다.
- 자식 프로세스에 부모 env를 통째로 넘기지 마라. 이유: 결정성이 깨진다(외부 API 키·`.env` 잔재·`NODE_OPTIONS`가 대상 서버 동작을 바꾼다 — 러너가 같은 이유로 env를 명시 조립한다).
- 여러 프로파일 + `--files`를 동시에 허용하지 마라. 이유: 케이스가 `requireProfile`로 로드 시점에 throw해 "설정 실수"가 "계약 실패"처럼 보인다.
- 실패한 프로파일을 조용히 skip하지 마라(`profile-unavailable`로 위장 금지). 이유: 통과로 위장된 미검증이 이 하네스가 막으려는 것 자체다.
- 러너에 `--dual-run`을 전달하지 마라. 이유: `--out`과 병용 불가(러너 118행)이고, 통과시키려고 `--out`을 포기하면 **같은 인스턴스 2패스**가 되어 로그인 레이트리밋 카운터 누적으로 확정 red가 된다(배경 참조). 자기 결정성은 **새 프로세스 2회**로만 판정한다.
- AC·스크립트의 `echo`/진단 문자열을 파이프 뒤 `$?`로 판정하거나 같은 줄에 한글을 섞지 마라. 이유: 파이프라인의 `$?`는 마지막 명령(`tail`)의 코드이고, win32 Bash에서 한글 인라인은 규약 위반이다(설명은 AC 블록 밖 불릿에 한글로 쓴다).
- Spring 코드(`server-spring/src/**`)를 이 step에서 수정하지 마라. 이유: 이 step은 Node 스크립트 레이어 하나만 소유한다 — 층을 섞으면 실패 원인 격리가 불가능해진다.
