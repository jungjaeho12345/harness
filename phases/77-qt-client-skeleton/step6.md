# Step 6: verify-harness-boot

## 읽어야 할 파일

- `phases/77-qt-client-skeleton/index.json` — `baseline`(C)(D)(G) · `decisions` (2)(10)(12)
- `docs/ADR.md` **ADR-018**(자동 검증 결정)
- **본보기(읽기 전용 · 고치지 마라)**: `scripts/verify-client.mjs` **전문** — 인자 파서 · `cleanEnv` · `readDiag`/`findSequence`/`waitForSequence`(94~126행) · `appDataSnapshot`/`appDataUnchanged`(127~148행) · 시나리오 A/B 구성 · `check()` 집계와 종료 코드
- **본보기(읽기 전용 · 고치지 마라)**: `scripts/verify-integration.mjs` — 서버 자식 기동부 · `pickFreePort`(198행) · `healthOk`(220행) · `repoDataSnapshot`/`appDataSnapshot`/`distDataSnapshot`(275~316행) · `makeTmpCleanup`(434행) · 임시 `DATA_DIR` 시드(482행 부근 `createSchema`+`seedUsers`)
- **재사용 모듈(읽기 전용 · import만)**: `scripts/lib/integrationMode.mjs` — `parseServerMode` · `springServerEnv`(5키 **전부 명시 주입** · 하나라도 비면 throw) · `osEnvAllowlist`(win32에서 **PATH를 넘기지 않는다**) · `listFilesRecursive`
- **강제 규칙(읽기 전용)**: `test/harness-vacuity-guards.test.js` **전문** — `scripts/lib/**`의 자기검사는 **드라이버가 시작 시 돌리거나 `test/**`가 import**해야 하며 아니면 **고아로 red**다. 그리고 대조기는 **관측 수를 스스로 확인**해야 한다(0건이 green이 되는 길 차단).
- `scripts/lib/spaParity.self-test.mjs`·`scripts/spa-parity.mjs`(자기검사를 드라이버가 돌리는 **결선 선례**)
- `phases/77-qt-client-skeleton/step4.md`·`step5.md` 산출물(diag 이벤트 이름과 부팅 시퀀스)

## 배경

**네이티브 클라에는 CDP가 없다.** Electron 판 통합 검증은 렌더러에 JS를 주입해 DOM을 읽었지만 여기서는 그 수단이 없다. 그래서 판정은 **두 축의 교차**다(`decisions` (2)):

- **클라가 남긴 diag JSONL** — 앱이 무엇을 했는가.
- **서버 측 사실** — 드라이버가 Node `fetch`로 직접 만들고 확인하는 것.

이 step은 그 드라이버의 **v1(부팅 축)** 을 세운다. 이후 step10·step11이 시나리오를 **덧붙인다**. 하네스를 화면보다 먼저 세우는 이유는 하나다 — 뒤에 오면 step7~11이 전부 「미검증인 채로 완료」가 된다.

**`scripts/verify-integration.mjs`·`verify-client.mjs`는 고치지 않는다**(Electron 경로는 P8까지 회귀 기준이다). 재사용은 **`scripts/lib/integrationMode.mjs`를 import**해서 하고, 두 스크립트의 **수법**(시퀀스 판정·스냅샷·정리)은 본보기로 읽어 새로 쓴다.

## 작업

### A. 순수 판정부 — `scripts/lib/qtClientDiag.mjs`

부수효과 없는 판정만 둔다(파일 읽기는 인자로 받은 경로 아래만).

```js
export function parseDiagLines(text)                  // JSONL → [{ts,event,...}] · 깨진 줄은 이유와 함께 버린다
export function findSequence(lines, sequence)         // 이벤트 이름 또는 [이름, 술어] 배열 · {ok, missing}
export function judgeEventNames(lines, allowedNames)  // 허용 집합 밖 이벤트 = 위반
export function judgeRouteLedger(lines, { knownRouteIds, forbiddenRouteIds, expectedRouteIds, expectedCounts })
export function judgeObservationCount(lines, minCount) // 0건이 green 이 되는 길을 막는다
```

- `judgeRouteLedger`는 `net-request` 이벤트의 `route` 값만 본다: ① 계약 39 밖 호출 0건 ② 금지 라우트(`collection-receive`·`collection-pull`) 0건 ③ 기대 집합 포함 여부 ④ **`expectedCounts`(라우트별 정확 호출 횟수) 대조** — step11의 완료 게이트가 「`articles-list` 호출 횟수 정확히 2」로 **폴링 클라를 배제**하는 데 쓴다(② 검토 반영). ④는 **지정한 라우트에만** 적용하고 나머지는 횟수를 보지 않는다. 라우트 목록은 **`docs/api-contract/endpoints.json`을 읽어 만든다**(하드코딩 금지 — 계약이 정본이다).
- **자기검사** `scripts/lib/qtClientDiag.self-test.mjs`를 함께 만들고, **드라이버가 시작 시 실행**한다(`spa-parity.mjs` 선례). 결선하지 않으면 `test/harness-vacuity-guards.test.js`가 **red**다.

### B. 드라이버 — `scripts/verify-qt-client.mjs`

```
node scripts/verify-qt-client.mjs [--scenario boot|all] [--server exe|spring] [--client-exe <path>]
     [--qt-bin <dir>] [--server-exe <path>] [--jar <path>] [--java-home <path>] [--keep] [--timeout <ms>]
```

동작:

1. **자기검사 실행**(A의 self-test). 실패면 즉시 exit 1.
2. **임시 자산 준비**(전부 OS 임시 폴더 — 리포 밖): `DATA_DIR`(새 sqlite DB에 `createSchema` + `seedUsers`) · `CLIENT_USER_DATA` · `CLIENT_DIAG_FILE` · 스풀 폴더.
3. **서버 기동**(`--server exe|spring`):
   - `exe` = 서버 SEA exe(`dist/` 아래). 없으면 **exit 1 + 빌드 힌트**(`npm run dist:server`). **skip 금지.**
   - `spring` = `java -jar server-spring/target/*.jar` — env는 `springServerEnv`로 조립한다. **`SPA_DIR`은 비면 throw이므로 리포 `web/dist`를 넘긴다**(Qt 클라는 SPA를 쓰지 않지만 조립 규칙이 5키 전부를 요구한다). `--java-home` 기본값은 `D:/agents/tools/jdk-25.0.4.1+1`. jar이 없으면 **exit 1 + 빌드 힌트**.
   - 빈 포트를 골라 `PORT`로 주입하고 `/api/health`가 `{ok:true}`를 줄 때까지 기다린다(실패는 명시 실패).
4. **Qt 클라 기동**: `client-qt/release/news-client.exe`(없으면 exit 1 + `cmd /c client-qt\build.bat` 힌트). 드라이버는 **exe를 직접 spawn한다**(`run.bat` 경유 금지 — 배치를 거치면 자식 종료 제어와 종료 코드 전달이 흐려진다). 자식 env는 **허용목록 조립**이되 **`PATH`에 Qt `bin`을 반드시 싣는다**(`--qt-bin` 또는 env `QT_BIN_DIR`, 기본 `D:/agents/tools/Qt/6.8.3/msvc2022_64/bin`). `osEnvAllowlist`는 win32에서 PATH를 넘기지 않으므로 **그대로 쓰지 말고 이 자식용 조립을 따로 두고 이유를 주석에 적어라**(java 자식과 요구가 다르다). `CLIENT_SELFTEST=1`로 창 표시를 억제한다.
5. **시나리오 `boot`** — `verify-client.mjs`의 A/B 이식:
   - **A(설정 있음)**: `CLIENT_USER_DATA`에 유효 `serverUrl`(위에서 띄운 서버 origin) config를 주입해 기동 → `app-ready` → `config-loaded{hasServerUrl:true}` → `app-window`. 그리고 **두 번째 인스턴스**를 띄워 즉시 종료(exit 0)와 첫 diag의 `second-instance`를 확인.
   - **B(설정 없음)**: 빈 폴더로 기동 → `app-ready` → `config-loaded{hasServerUrl:false}` → `setup-shown` → `local-window{page:'setup'}`.
   - 두 경로 모두 **부팅만으로 `probe`가 남지 않음**을 단언(정본 설계).
   - **허용 이벤트 이름 집합**과 **관측 수 최소치**를 단언(공허 통과 차단).
6. **데이터 안전 단언**: 리포 `news.db`(크기·mtime) · 리포 `uploads/`(파일 수·총 바이트) · 실사용자 `%APPDATA%\기사작성기`·`%APPDATA%\기사작성기-qt` · `dist/*/data` 를 **전후 스냅샷 비교**해 무변임을 단언한다(하나라도 변하면 실패).
7. **정리**: 자식 종료(강제 종료 포함) · 임시 폴더 삭제(`--keep`면 보존하고 경로 출력).
8. **집계**: 항목별 `check()` 출력 + 실패 목록 + 총계. 종료 코드는 0/1. **어떤 실패도 「경고」로 낮추지 마라.**

## Acceptance Criteria

```
node scripts/verify-qt-client.mjs --scenario boot --server exe
node scripts/verify-qt-client.mjs --scenario boot --server spring
npm test
npm run lint
git status --porcelain
```
- 두 모드 **모두 exit 0** · 출력에 **관측 이벤트 수와 판정 항목 수**가 보인다(0이면 실패).
- `npm test` 무회귀 — 특히 **`test/harness-vacuity-guards.test.js`가 green**이어야 한다(새 자기검사 파일이 고아가 아니라는 증거).
- `git status`에 임시 산출물·diag 파일이 **없다**(전부 리포 밖).

## 검증 절차

1. **공허 통과 차단 실증(필수 4종)** — 각각 심고 **red**를 본 뒤 원복한다:
   - M6-1 서버를 띄우지 않고 시나리오를 돌린다 → **기동/health 실패**로 exit 1인가?
   - M6-2 Qt 앱 대신 즉시 종료하는 더미를 기동한다(예: `cmd /c exit 0`) → diag가 비어 **exit 1**인가? (`judgeObservationCount`가 잡아야 한다.)
   - M6-3 기대 시퀀스에서 한 이벤트를 앱이 남기지 않도록 클라 코드에 변이를 심는다 → **exit 1**인가? 원복.
   - M6-4 `--qt-bin`을 틀린 경로로 준다 → 앱이 DLL 부재로 뜨지 못하고 **exit 1**인가?(무음 green 금지)
2. **자기검사 결선 실증**: `scripts/lib/qtClientDiag.self-test.mjs`의 단언 1건을 깨뜨리면 **드라이버가 시작 즉시 exit 1**인가? 그리고 자기검사 호출 줄을 지우면 `npm test`의 vacuity 가드가 **red**인가? 둘 다 확인하고 원복.
3. **연속 2회 실행**해 flake가 없음을 확인한다(포트·타이밍 축). 다르면 그 사실과 원인 가설을 요약에 적는다.

## 되돌림

`scripts/verify-qt-client.mjs`·`scripts/lib/qtClientDiag*.mjs` 3파일 삭제로 원상 복구된다(다른 경로 무변).

## 금지사항

- **`scripts/verify-integration.mjs`·`scripts/verify-client.mjs`를 고치지 마라.** 이유: Electron 경로는 P8까지 회귀 기준이고, 두 클라의 판정을 한 파일에 섞으면 한쪽이 늙는다(`decisions` (2)).
- **자산이 없을 때 skip하고 green을 내지 마라.** 이유: 이 리포에서 게이트는 매번 공허하게 통과했다 — 없으면 **exit 1 + 빌드 힌트**다(`decisions` (10)).
- **리포 `news.db`·`uploads/`·실사용자 `%APPDATA%`·`dist/*/data`에 바인딩하지 마라.** 이유: 검증이 실데이터를 오염시키면 이후 모든 판정의 기준점이 사라진다(CLAUDE.md 최상위 규칙과 `verify-integration.mjs`의 CRITICAL).
- **`scripts/lib/integrationMode.mjs`를 고치지 마라.** 이유: `verify-integration.mjs`가 그 위에 서 있고 `test/integration-mode-judgment.test.js`가 결선까지 단언한다. 필요한 차이(자식 `PATH`)는 **새 모듈에** 두어라.
- **판정을 클라의 diag에만 의존시키지 마라.** 이유: 앱의 자기 신고만 보면 앱이 거짓말할 때 green이 된다 — 서버 측 사실과 교차해야 한다(이 step은 최소한 `/api/health`와 데이터 스냅샷을 그 축으로 쓴다).
