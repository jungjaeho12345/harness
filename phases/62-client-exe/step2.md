# Step 2: shell-verify

## 읽어야 할 파일

- `CLAUDE.md`, `docs/ARCHITECTURE.md`(배포 산출물·보안 경계), `docs/ADR.md`(ADR-008·009)
- `phases/62-client-exe/index.json` — decisions (7)(11)(12)(14), open_questions (b)(c)(d)
- `phases/62-client-exe/step1.md` — **8절 진단 이벤트 계약**(이 step의 단언 대상)과 부팅 순서 계약
- `client/main.js`·`client/diag.js`·`client/pages/**`(step1 산출물) — 읽기만 한다. **수정하지 마라.**
- `scripts/verify-server-exe.mjs` — 자식 프로세스 기동 → 폴링 → 프로브 → 확실한 종료(Windows 잔류 방지)와 **임시 DATA_DIR 시드** 패턴. 이 step은 그 형태를 그대로 따른다.
- `test/same-origin-hardening.test.js` 135~204행 — 서버 실기 기동 패턴(상속 env 정리 포함)
- `scripts/seed.js` · `src/db/seed.js` · `src/db/schema.js` — 임시 DB에 R/D/Z 계정을 시드하는 방법

## 배경

step1이 만든 셸을 **자동 스모크**와 **실기 매트릭스(D-1~D-9)** 두 축으로 검증한다. 자동 스모크는 diag JSONL(step1 8절)을 단언해 사람 없이 판정하고, 실기 매트릭스는 Electron에서만 드러나는 항목(인쇄·클립보드·IME·잠금 해제)을 사람이 확인해 **사실을 기록**한다.

**데이터 안전 전제**: 모든 검증은 임시 `DATA_DIR`(서버)과 임시 `CLIENT_USER_DATA`(클라이언트)에서 돈다. 리포 루트의 `news.db`·`uploads/`와 실사용자 `%APPDATA%\기사작성기`에는 **어떤 검증도 바인딩하지 않는다**(DB 비파괴 원칙).

## 작업

### 1. `scripts/verify-client.mjs` (신규)

```
node scripts/verify-client.mjs (--dev | --exe <path>) [--scenario a|b|all] [--server <origin>] [--keep] [--timeout <ms>]
```

- **인자 가드(필수)**: `--dev`/`--exe`가 **정확히 하나**가 아니면 사용법 출력 후 exit 1. `--exe` 경로가 없으면 exit 1. `--scenario` 값이 목록 밖이면 exit 1. 경로 인자는 즉시 절대화한다. 이유: `scripts/**`는 eslint 커버리지 밖이라 오타가 "검증 통과"로 둔갑한다(phase 61 선례).
- 공통 준비:
  1. `--server` 미지정이면 **임시 `DATA_DIR`로 서버를 자식 프로세스 기동**한다(`node server/index.js`, env: 랜덤 PORT·`HOST=127.0.0.1`·`DATA_DIR=<tmp>`·`SPA_DIR=<repo>/web/dist`; 상속 env에서 `NODE_ENV`·`FORCE_HTTPS`·`ALLOWED_ORIGINS`·`COLLECTION_TOKEN`·`RCV_SPOOL_DIR`·`DIST_SPOOL_DIR` 제거). `web/dist`가 없으면 **"npm run build를 먼저 실행하라"**는 메시지로 실패시켜라.
  2. `GET /api/health` 200 + 본문 `{ ok:true }`까지 폴링(최대 30초).
  3. **실사용자 `%APPDATA%\기사작성기`의 사전 상태를 스냅샷**한다(존재 여부 + 존재하면 `config.json`의 mtime·크기).
- **시나리오 A (설정 있음 → 앱 창 경로)**:
  1. 임시 `userData` 디렉토리에 `config.json`을 **미리 써서** 서버 주소를 주입한다(schemaVersion 1 + serverUrl).
  2. env `CLIENT_USER_DATA=<tmp>` · `CLIENT_DIAG_FILE=<tmp>/diag.jsonl` · `CLIENT_SELFTEST=1`로 클라이언트를 기동한다.
  3. diag 단언: **`app-ready` → `config-loaded{hasServerUrl:true}` → `app-window` → `did-finish-load`** 순서, `did-navigate.httpResponseCode === 200`, `did-finish-load.title`이 비어 있지 않음.
  4. **두 번째 인스턴스**를 같은 env로 띄워 즉시 종료(exit 0)되고 첫 인스턴스 diag에 `second-instance`가 남는지 확인한다.
- **시나리오 B (설정 없음 → 설정 화면 경로)**:
  1. **빈** 임시 `userData`(config.json 없음)로 기동한다.
  2. diag 단언: `config-loaded{hasServerUrl:false}` → **`setup-shown{reason:'no-config'}`** → 로컬 창의 **`did-finish-load{url: …/pages/setup.html}`**.
  3. **IPC 왕복 확인**: 설정 페이지가 부팅 시 호출하는 `getState`가 diag에 **`ipc{channel:'getState',trusted:true}`** 로 남는지 단언한다(preload·contextBridge·ipcMain 결선이 실제로 살아 있다는 증거 — 패키지 배치에서 `pages/`나 `preload.cjs`가 누락되면 여기서 잡힌다).
  4. **실패 주소 프로브**: 도달 불가 주소(예: `http://127.0.0.1:1`)로 프로브를 유발해 **`probe{ok:false}`** 가 남는지 확인한다. 유발 수단은 (i) 설정 페이지에 `CLIENT_SELFTEST=1`일 때만 동작하는 자동 입력을 두거나 (ii) 검증 스크립트가 `sendInputEvent` 없이 확인 가능한 경로를 쓰는 것 중 **step1 코드를 고치지 않고 되는 방법**을 택하라. 방법이 없으면 이 항목만 "미검증"으로 기록하고 나머지는 진행하라(step1 코드를 이 step에서 수정하는 것은 금지 — 필요하면 보고해 step1로 되돌린다).
- **userData 격리 단언(전 시나리오 공통 — decisions (11))**:
  - 임시 `userData`에 Chromium 프로필 산출물(예: `Preferences`·`Local Storage`·`Cache` 등 **디렉토리 내용이 비어 있지 않음**)이 생겼는지 확인한다 → `CLIENT_USER_DATA`가 실제로 적용됐다는 증거.
  - 실사용자 `%APPDATA%\기사작성기`가 **검증 전후로 변하지 않았는지**(없던 폴더가 생기지 않았고, 있던 `config.json`의 mtime·크기가 그대로인지) 확인한다. 변했으면 **실패**시켜라 — 부팅 순서(setPath → 잠금)가 뒤집혔다는 신호다.
  - 참고: Windows의 단일 인스턴스 잠금은 파일이 아니라 프로필 경로 기반 커널 객체일 수 있다. **잠금 파일 존재를 단언하지 마라** — 위 두 가지(프로필 산출물 생성 + 실사용자 폴더 무변)와 두 번째 인스턴스 즉시 종료로 판정한다.
- 종료: 클라이언트·서버 kill → 200ms → 살아 있으면 SIGKILL. 임시 디렉토리는 `--keep`이 없으면 정리한다. **임시 디렉토리 밖의 어떤 파일도 지우지 마라.**
- 출력: 성공 요약(모드·시나리오·기동 시간·확인한 이벤트 목록)을 stdout에 출력하고 exit 0. 실패 시 원인 + 자식 로그 + diag 파일 내용을 stderr에 출력하고 exit 1.

### 2. 실기 매트릭스 D-1 ~ D-9 (사람 확인 — 결과를 요약에 **사실/수치**로 남긴다)

준비(**리포 DB 오염 금지 — decisions (17)**):

```bash
npm run build
# 임시 DATA_DIR에 스키마+샘플 계정 시드 후 그 DIR로 서버 기동 (scripts/verify-server-exe.mjs의 시드 절차와 동형)
# 예: DATA_DIR=<tmp> HOST=127.0.0.1 PORT=<n> node server/index.js
# 클라이언트: CLIENT_USER_DATA=<tmp-client> npm run client:dev
```

- **리포 루트 `news.db`에 붙지 마라.** D-6(잠금)·기사 작성·송고가 실 데이터를 건드리면 되돌릴 수 없다(DB 비파괴).
- 검증 중 남은 편집 잠금은 **UI의 잠금 해제(데스크 강제 해제 포함)로만** 푼다. **DB를 직접 수정하거나 행을 지우지 마라.**

항목:

- **D-1 상세보기**: list.do 행 클릭 → 720×800 새 창, 창 제목 = 기사 제목(없으면 `(제목 없음)`), 본문 렌더 정상.
- **D-2 인쇄미리보기**: 에디터 파일>인쇄미리보기 → 새 창에 내용이 그려지는가.
- **D-3 인쇄(핵심 실측)**: 파일>인쇄 → `w.print()`로 **Windows 인쇄 대화상자가 뜨는가**. 안 뜨면 그 사실을 기록하고 open_questions (d)의 폴백 판단 근거로 남겨라(**이 step에서 셸 코드를 고치지 마라** — 필요하면 step1으로 되돌리는 보고 대상이다).
- **D-4 클립보드(핵심 실측)**: `http://127.0.0.1:<port>`와 **`http://<LAN IP>:<port>` 둘 다에서** 목록 우클릭>본문복사, 에디터 우클릭>붙여넣기가 동작하는가. LAN IP에서만 실패하면 secure context 문제다 → open_questions (b)의 판단 근거로 기록하라(**스위치를 임의로 켜지 마라**).
- **D-5 세션/실시간/탭 보존/새로고침**: 로그인 → 목록 SSE 상태바가 "연결됨"인가(HttpOnly 쿠키 증거). **메뉴 `보기 > 새로고침` 클릭** 후 세션이 유지되는가(F5 키가 아니라 메뉴 클릭 기준 — 커스텀 메뉴에는 액셀러레이터가 없다). 작성 탭 2개를 연 뒤 list.do ↔ writer.do를 오가도 탭이 보존되는가. **창을 닫았다 다시 켜면 탭이 사라지는 것이 정상**이다(sessionStorage 계약).
- **D-6 편집 잠금 해제**: 편집 탭을 연 상태로 **창을 닫고**, 다른 클라이언트/브라우저에서 그 기사의 `lockYN`이 풀렸는지 확인하라(조회 화면으로 확인 — DB 직접 조회·수정 금지). 풀리지 않으면 그 사실 그대로 기록한다(open_questions (c)).
- **D-7 외부 링크/임베드**: 본문 유튜브 임베드가 보이는가, 상세보기의 외부 링크 클릭이 **기본 브라우저**로 열리는가(앱 창에 남으면 정책 결선 오류).
- **D-8 한글 IME·Alt 단축키**: 에디터에서 한글 입력·조합이 정상인가. **`Alt+Y`((끝) 삽입)·`Alt+V`(원본 붙여넣기)·`Alt+O`(약물입력)** 가 메뉴바(Alt) 활성화에 삼켜지지 않고 동작하는가. 삼켜지면 step1 5절의 폴백 사다리 중 어디까지 필요한지 판단해 **보고**하라(이 step에서 셸 코드를 고치지 마라). `spellcheck:false`이므로 **맞춤법 밑줄이 없는 것이 정상**이다(decisions (13)) — 그 사실을 확인만 하라.
- **D-9 장애 UX·좀비 창**: 서버를 내리고 [다시 연결] → 오류 화면 문구가 맞는가. [서버 주소 변경] → 잘못된 주소 저장이 거부되는가. **오류 화면을 X로 닫으면 프로세스가 완전히 종료되는가**(작업 관리자에서 잔류 프로세스 0 확인) → 종료 후 **재실행이 정상 동작**하는가(좀비 잠금 없음). 두 번째 실행이 기존 창을 포커스/복원하는가(최소화 상태에서도).

## Acceptance Criteria

```bash
npm run lint          # clean (scripts/**는 eslint ignore — 이 스크립트는 lint가 검사하지 않는다)
npm test              # step0·step1 기준선 그대로, 실패 0
npm run test:web      # 2368/2368 무영향
npm run build         # clean (검증이 web/dist를 쓴다)

node scripts/verify-client.mjs --dev --scenario all      # 시나리오 A+B 자동 스모크
node scripts/verify-client.mjs --dev --scenario all      # 2회차도 성공(멱등 — 임시 디렉토리 잔여물로 깨지지 않는다)

# 인자 가드 — 넷 다 비-0 종료여야 한다.
node scripts/verify-client.mjs;                            echo "exit=$?  # 0이면 실패"
node scripts/verify-client.mjs --exe nope.exe;             echo "exit=$?  # 0이면 실패"
node scripts/verify-client.mjs --dev --exe x.exe;          echo "exit=$?  # 0이면 실패"
node scripts/verify-client.mjs --dev --scenario zzz;       echo "exit=$?  # 0이면 실패"

# 데이터 안전 — 검증이 리포 DB/실사용자 프로필을 건드리지 않았는지
git status --porcelain news.db uploads 2>/dev/null | tee /dev/stderr | test "$(wc -l)" -eq 0 && echo "REPO-DB-CLEAN-OK"
```

`npm run test:web` 비고정 실패 규약: 1건이 비고정으로 실패하면 **최대 2회 재실행 + 단독 실행**으로 판정한다(green이면 통과, 사실을 요약에 남긴다).

## 검증 절차

1. 위 AC를 전부 실행한다.
2. **D-1 ~ D-9를 수행**하고 각 항목을 "정상 / 제약 있음(구체 서술) / 미검증(사유)" 중 하나로 요약에 남긴다. 특히 **D-3(인쇄)·D-4(클립보드)·D-6(잠금)·D-8(Alt)·D-9(좀비 창)** 는 step4 문서와 ADR-011 트레이드오프의 입력이므로 반드시 결론을 남겨라.
3. 실측 기록: 셸 기동~`did-finish-load` 소요 · 시나리오 A/B 각 소요 · 임시 userData에 생긴 프로필 산출물 목록 · 실사용자 `%APPDATA%\기사작성기` 무변 확인 결과.
4. `git status --porcelain` 증분이 `scripts/verify-client.mjs` 뿐인지 확인한다(시작 시점 스냅샷 대비 증분).
5. 아키텍처 체크리스트: `package.json` 무수정 / `client/**`·`web/**`·`src/**`·`server/**`·`test/**` 무수정 / DB 스키마·행 변경 0 / 앱 내 타이머·egress 0.
6. `phases/62-client-exe/index.json`의 step2를 갱신한다. **부분 산출물 규칙**: 중간 실패 시 만든 파일을 지우지 말고 어디까지 됐는지 error_message에 남겨라(후속 세션이 증분 대조로 잔여만 완결한다). **blocked 판정 기준**: 셸 결선 결함으로 스모크가 통과하지 못하는 경우(수정은 step1 소유 — 여기서 고치지 말고 보고).

## 금지사항

- `client/**`를 수정하지 마라(step1 소유). 이유: 검증 실패의 원인이 "셸 결함"인지 "검증 스크립트 결함"인지 격리할 수 없게 된다. 셸 결함은 고치지 말고 근거와 함께 보고하라.
- 리포 루트 `news.db`·`uploads/`에 바인딩하지 마라. 이유: 검증이 실 데이터를 오염·잠금 상태로 만들면 복구 경로가 없다(DB 비파괴).
- 검증에서 DB 행을 직접 수정·삭제해 잠금을 풀지 마라. 이유: 앱이 강제 해제 UI를 제공하며, DB 직접 조작은 이 프로젝트의 최우선 금지 사항이다.
- 실사용자 `%APPDATA%\기사작성기`를 쓰거나 지우지 마라. 이유: 사용자의 실제 서버 설정이 날아가고, 스모크 판정이 실환경 상태에 오염된다.
- `--user-data-dir` 같은 Chromium 스위치에 의존하지 마라. 이유: 계약은 `CLIENT_USER_DATA` env(step1이 명시 처리)이며, 스위치 파싱 동작에 의존하면 패키지 배치에서 조용히 어긋난다.
- 검증 스크립트를 `test/**`에 넣거나 `npm test` 글롭에 걸리게 하지 마라. 이유: GUI 프로세스 기동은 수십 초이고 실패 원인이 단위 테스트 실패로 뭉개진다.
- diag 이벤트 이름·필드를 이 step에서 바꾸지 마라. 이유: step1이 정의한 계약이 단일 출처다 — 양쪽이 서로를 고치면 검증이 무의미해진다.
