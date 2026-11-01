# RUNBOOK — phase 78-editor-core (로드맵 P5 '에디터 코어')

이 문서는 **툴체인이 갖춰진 Windows+Qt 빌드 호스트**에서 phase `78-editor-core`의 ③구현·④테스트·⑤리뷰를 개시하기 위한 실행 인계서다. 계획(①기획+②검토)은 브랜치 `claude/slack-session-ebshe0`에 이미 커밋돼 있고, 실제 빌드·측정은 **Qt/MSVC 부재 환경에서는 불가능**하다(index.json `open_questions` (0)). 이 문서는 그 실행을 그대로 재현 가능하게 만드는 것이 목적이며, **어떤 빌드/테스트 결과도 이 문서에서 미리 만들어 넣지 않았다**(측정은 호스트의 step0이 자기 손으로 한다).

---

## 1. 사전조건 체크리스트 (Windows 빌드 호스트)

### 1.1 툴체인 (모두 절대경로 하드코딩 — 정본 파일 명시)
| 항목 | 버전 | 경로(정본) | 정본 파일 |
|---|---|---|---|
| Qt | **6.8.3 msvc2022_64** | `D:\agents\tools\Qt\6.8.3\msvc2022_64` | `client-qt/env.bat` L6 (`QTDIR`) |
| MSVC | **14.50.35717** | `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Tools\MSVC\14.50.35717` | `client-qt/build.bat` L11 |
| Windows SDK | **10.0.26100.0** | `C:\Program Files (x86)\Windows Kits\10` | `client-qt/build.bat` L12–16 |
| JDK (spring 모드 하네스 전용) | **Temurin 25** (`jdk-25.0.4.1+1`) | `D:/agents/tools/jdk-25.0.4.1+1` | `scripts/verify-qt-client.mjs` L74 (`DEFAULT_JAVA_HOME`) |
| Node | 리포 기본 | PATH | — |

> 주의: 툴체인 경로 정본은 **한 곳이 아니라 세 파일에 흩어져 있다** — Qt는 `env.bat`, MSVC/SDK는 `build.bat`, JDK는 `verify-qt-client.mjs`. 네 경로가 실제 호스트와 하나라도 다르면 **먼저 그 사실을 기록**하고(위장 금지), 경로 교정은 `env.bat`/`build.bat`(가변 대상) 내에서만 한다. `env.bat`은 ASCII 전용(cmd가 cp949로 파싱).

### 1.2 서버 산출물 (verify-qt-client가 **빌드하지 않음** — 반드시 선빌드)
`verify-qt-client.mjs`는 `boot` 시나리오조차 서버 SEA exe를 요구하고(없으면 exit), 하네스가 서버를 빌드하지 않는다. **step0의 기준선 재측정 첫 커맨드에서 즉시 실패하지 않으려면 아래를 먼저 만들어야 한다.**
- 서버 SEA exe: **`npm run dist:server`** → `dist/기사작성기-server/기사작성기-server.exe` 생성 (verify-qt-client L77·L186)
- Spring jar(step9/step10의 `--server spring`용): **`cd server-spring && ./mvnw -B -q package -DskipTests`** → `server-spring/target/server-spring-0.0.1-SNAPSHOT.jar` 생성 (verify-qt-client L75·L191, `--jar`는 자동 빌드 안 함)

### 1.3 git 상태
- 브랜치 **`claude/slack-session-ebshe0`** 를 체크아웃한 상태여야 한다. 이 브랜치가 78-editor-core 계획 커밋(`phases/78-editor-core/index.json` + `step0.md`..`step10.md` + 본 RUNBOOK)을 담고 있다.
- 작업 트리 clean에서 시작(`git status --porcelain` 무출력).
- **왜 중요한가**: `execute.py`는 step 파일을 **작업 트리에서** 읽는다(`_invoke_claude`, execute.py L242). 계획이 없는 브랜치에서 실행하면 `step0.md`를 못 찾아 즉시 ERROR 종료한다.

---

## 2. 실행 절차 (단일 시퀀스)

```
# 1) 계획을 담은 브랜치를 최신화하여 체크아웃한다
git fetch origin
git checkout claude/slack-session-ebshe0
git pull --ff-only origin claude/slack-session-ebshe0

# 2) 서버 산출물 선빌드 (1.2 — 없으면 step0 첫 verify에서 실패)
npm run dist:server
cd server-spring && .\mvnw.cmd -B -q package -DskipTests && cd ..

# 3) 파이프라인 개시
python3 scripts/execute.py 78-editor-core --push
```

### 2.1 `execute.py`가 실제로 하는 일 (읽고 넘어가지 말 것)
- **작업 브랜치는 `feat-78-editor-core`다** — `claude/slack-session-ebshe0`가 아니다. `execute.py`는 `branch = f"feat-{phase}"`로 계산한다(index.json의 `"phase": "78-editor-core"` → `feat-78-editor-core`, execute.py L123).
  - 현재 브랜치가 그 이름이 아니면, 존재하면 checkout, 없으면 **현재 HEAD에서 `checkout -b feat-78-editor-core`**(L134–135). 따라서 **반드시 계획을 담은 `claude/slack-session-ebshe0`에서 실행**해야 새 브랜치가 계획 커밋을 상속한다.
- step0→step10을 **순차 실행**한다. 각 step은 `step{N}.md`를 Claude에 넘겨 구현시키고, 그 step이 `index.json`의 자기 status를 `completed`(+`summary`)로 바꾸면 다음으로 넘어간다.
  - `completed` → 커밋(`feat(78-editor-core): step N — <name>`) 후 진행. `git add`는 명시 경로가 아니라 `-A`를 쓴다(execute.py L149) — **그래서 1.2/1.3의 트리 청결과 `.gitignore`가 빌드 산출물을 걸러 주는 것이 전제다**.
  - `blocked` → 즉시 중단, exit 2, 상위 index status `blocked`. 사람이 해소 후 해당 step status를 `pending`으로 되돌려 재개.
  - `error`(3회 재시도 실패) → 중단, exit 1, 상위 index status `error`.
- **`--push`**: 전 step 완료 후 `_finalize`에서 `git push -u origin feat-78-editor-core`(execute.py L413–414). **대상 브랜치는 `origin/feat-78-editor-core`다.** 네트워크 실패 시 exit 1.
- 완료 후 병합은 **PR로** 한다(phase 77이 `feat-77-qt-client-skeleton` → PR #126으로 병합한 것과 동형). `execute.py`는 PR을 만들지 않는다.

---

## 3. step별 AC 요약 (0~10)

각 step 공통: `git status --porcelain`이 가변 목록(주로 `client-qt/src/editor/**`·`tests/**`·`common.pri`·`phases/78-editor-core/**`) 밖을 건드리지 않아야 하고, 리포 `news.db` md5(`7247e9e0dfe5cc8cd040ebb1dc9fb967`)는 **무변**이어야 한다.

| step | 이름 | 한 줄 AC 커맨드 | 통과 기준 | 판정 축 |
|---|---|---|---|---|
| 0 | baseline-and-editor-skeleton | `cmd /c client-qt\build.bat` + `verify-qt-client --scenario boot --server exe` | build exit 0 · QtTest Totals 첫 숫자가 이전(≈310)+신규 함수 수만큼 증가 · 0 failed · boot exit 0 · 기준선 12커맨드 2회 flake 0 | **자동 QtTest** |
| 1 | block-model | `cmd /c client-qt\build.bat` + boot exe | build exit 0 · 0 failed(직렬화 왕복·레거시 평문·align·정규화) | **자동 QtTest** |
| 2 | coloring-roles | `cmd /c client-qt\build.bat` + boot exe | build exit 0 · 0 failed(웹 10 케이스·부제 빈 줄 폴백·`(끝)` trim) | **자동 QtTest** |
| 3 | marker-newline-guard | `cmd /c client-qt\build.bat` + boot exe | build exit 0 · 0 failed(웹 55 케이스·오프셋 「이상」 경계) | **자동 QtTest** |
| 4 | caret-range | `cmd /c client-qt\build.bat` + boot exe | build exit 0 · 0 failed(단어/문단 경계·공백 위 좌우·빈 범위 no-op) | **자동 QtTest** |
| 5 | shortcuts-13 | `cmd /c client-qt\build.bat` + boot exe | build exit 0 · 0 failed(웹 28 + 단어삭제·마커 무결성) | **자동 QtTest** |
| 6 | undo-history | `cmd /c client-qt\build.bat` + boot exe | build exit 0 · 0 failed(동일-body no-op·베이스라인 불변·limit 절단) | **자동 QtTest** |
| 7 | autosave-draft | `cmd /c client-qt\build.bat` + boot exe | build exit 0 · 0 failed(가짜 store 결정적·graceful throw·`nowMs` 주입) · `client-qt/src/shell/**` 무변 | **자동 QtTest** |
| 8 | text-engine-widget | `cmd /c client-qt\build.bat` + `verify-qt-client --scenario boot\|login\|list --server exe` | build exit 0 · 0 failed · 3시나리오 각 exit 0 · 각 입력 경로 마커 게이트 경유 실증 | **자동 QtTest(본문 무변) + 육안(IME·캐럿, step10)** |
| 9 | writer-state-machine | `verify-qt-client --scenario edit --server exe` **및** `--scenario edit --server spring --java-home <JDK25>` + boot\|login\|list exe | 각 exit 0 · build 0 failed · `x-edit-client`가 정확히 3라우트(lock·unlock·update)에만 · 표면당 EditClientId 1개 | **자동(드라이버 교차 실기)** |
| 10 | closeout | `build.bat` + `--scenario edit exe/spring` + `boot\|login\|list exe` + `npm test`·`lint`·`build` | 전부 exit 0(무회귀) · 마감 실측 2회 flake 0 · 문서만 변경 | **자동(무회귀) + 육안 체크리스트(4)** |

> **주의(step9/step10 전제)**: `--scenario edit`는 아직 `verify-qt-client.mjs`에 **없다** — 현재 드라이버는 `boot|login|list|all`만 허용한다(L145 검증 배열·L104 USAGE). **step9가 그 시나리오를 드라이버에 덧붙이면서**(decisions (6) · 새 드라이버 신설 금지, 판정부는 `scripts/lib/qtClientDiag.mjs`) 검증 배열과 USAGE를 함께 확장해야 한다. step9 착수 시 이 두 곳 갱신을 잊지 말 것.

---

## 4. 육안 판정 축 (자동 green 불가 — 사람만 판정)

로드맵 P5 완료 게이트 (2)는 **IME·캐럿 실기 체크리스트**다. 이 축은 `verify-qt-client`/QtTest가 **대신 써 주지 못한다**. step8/step10의 금지사항이 명시하듯 「IME·캐럿 안정을 QtTest green으로 증명했다」고 적는 것은 금지다(green 조작). 위젯 실행은 **`client-qt\run.bat`**으로만 한다(Qt 동적 링크 — 맨 셸 실행은 `0xC0000135` 즉사).

실물 **MS-IME**로 한글을 조합하며 각 항목을 사람이 1회 수행하고 pass/fail을 그대로 기록한다(step10 작업 4·검증 3):
1. **조합 중 캐럿 튐 0** — 한글 조합(preedit) 도중 캐럿이 튀지 않는다.
2. **조합 중 단축키 미개입** — preedit이 비어 있지 않은 동안 Alt+Y·Ctrl+Y·Ctrl+D 등이 인터셉트되지 않는다(step8 decisions (4): preedit 비었을 때만 인식).
3. **commit 후에만 재색칠** — 역할 색(제목/부제/본문/`(끝)`) 스타일 런은 조합 확정 후에만 재계산된다(preedit 위 재색칠 = 캐럿 튐).
4. **마커 뒤 입력 차단 실기** — 마지막 `(끝)` 이후 위치에서 타이핑/Enter/붙여넣기/IME commit/단축키/변환 어느 경로로도 본문이 바뀌지 않는다(단, 삭제·이동·선택은 차단 대상 아님 — 마커 지우면 입력 재개).
5. **undo/redo 체감** · **자동저장/복구 실기**.

step8 금지사항(참조): 조합(preedit) 중 단축키 인터셉트·재색칠·캐럿 이동 금지 / 위젯이 substring·trim으로 마커 재판정 금지(step3 게이트 단일 지점만) / 임베드·맞춤법·찾기바꾸기·표는 P6이므로 넣지 말 것.
step10 금지사항(참조): 코드 수정 금지(문서 전용) / ADR 기존 텍스트 수정·삭제 금지(순수 추가만) / 체크리스트를 「통과했다」로 지어 쓰기 금지 / 미검증 숨기기 금지.

---

## 5. 블록/실패 시 대응

- **step이 `blocked`(exit 2) 또는 `error`(exit 1)로 멈추면**, `execute.py`가 상위 `phases/index.json`의 78 status를 `blocked`/`error`로 바꾸고 중단한다. 캡처하여 harness Slack 채널로 보낼 것:
  - `phases/78-editor-core/index.json`의 해당 step `blocked_reason` 또는 `error_message`(3회 시도 후 누적 메시지).
  - `phases/78-editor-core/step{N}-output.json`(해당 step의 Claude stdout/stderr 전문 — execute.py가 저장).
  - 실패한 AC 커맨드의 콘솔 출력. 특히:
    - build 실패면 `%TEMP%\client-qt-tests.log`(build.bat L19·L34가 테스트 러너 출력을 여기 남긴다). 러너 red 시 `Totals:` 첫 숫자는 음수다.
    - `Bash 도구로 build.bat을 부를 때 findstr 부재로 인한 거짓 BUILD FAILED`이면 `PATH=/c/Windows/System32:$PATH`를 붙였는지 확인(phase 77 함정).
    - verify 실패면 exit 코드와 판정 라인, `--server exe`는 `dist/기사작성기-server/` 존재 여부, `--server spring`은 jar 경로·`--java-home` 지정 여부(미지정 시 usage exit 1 — 회귀 아님).
  - 재빌드 exe md5는 매번 다르므로 **변이 원복 판정은 항상 소스 diff**(`git diff --stat -- client-qt/src client-qt/app client-qt/tests`).
- **재개**: 원인 해소 후 해당 step status를 `pending`으로 되돌리고(그리고 3회-실패 누적 시 `error_message` 제거) `python3 scripts/execute.py 78-editor-core --push`를 다시 실행하면 그 step부터 이어 간다.
- **절단점(step9)**: 일정이 막히면 로드맵 P5 기능 게이트(순수 QtTest green + IME·캐럿 육안)는 **step9까지에서 충족**되고 step10(문서·마감)은 후속으로 넘길 수 있다(index.json order 근거 (e)). 그 경우 「P5 기능 게이트 충족 · 문서 미완」으로 정직히 기록.

---

## 6. 프리즈/DB 비파괴 규율 (전 step 불변)
- 무접촉(수정·`git add` 금지): `server/**`·`src/**`·`server-spring/**`·`web/**`·`client/**`·`contract/**`·`docs/api-contract/**`·`spikes/**`·`client-qt/src/net/**`·`client-qt/src/shell/**`·리포 `news.db`(지문 읽기만)·`uploads/`.
- 가변: `client-qt/src/editor/**`(신설)·`client-qt/src/ui/**`(에디터 화면·상태 기계 추가)·`client-qt/app/main.cpp`·`common.pri`·`tests/**`·`scripts/verify-qt-client.mjs`·`scripts/lib/qtClientDiag.mjs`·`client-qt/README.md`·`docs/ADR.md`(순수 추가)·`phases/78-editor-core/**`·`phases/index.json`.
- `EditClientId`(`client-qt/src/net/editclientid.h`)는 **읽고 인스턴스를 생성·전달만** — 파일 자체는 고치지 않는다. `routetable.cpp`의 `sendsEditClient` 3행도 불변(네 번째에 헤더를 실으면 `RouteContractTest` red).
- 임시 산출물은 리포 밖(하네스가 OS 임시 폴더에 `DATA_DIR`·`CLIENT_USER_DATA`·diag). 앱·테스트가 리포 `news.db`를 DB로 여는 것 금지 — 실행은 임시 `DATA_DIR`.
