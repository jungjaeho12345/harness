# Step 3: app-skeleton

`client-qt/` 독립 모듈을 **CMake 프로젝트**로 세운다 — core/net/ui/shell 라이브러리 타깃 레이아웃 + QtTest/ctest 배선 + 최소 실행 진입점. 이 step은 **골격만** 만든다(빈 창이 뜨고 ctest 1건이 green). shell/net/ui의 실제 로직은 후속 step이 채운다.

## 읽어야 할 파일
- `docs/porting-plan-cpp-spring.md` §6.2 「앱 구조(제안)」(core/net/editor/ui/shell 레이아웃)
- `spikes/p0-qt-editor/spike.pro`(모듈·Qt 컴포넌트 참고 — `QT += widgets testlib`, `c++17`) · `spikes/p0-qt-editor/build.bat`(툴체인 경로)
- `phases/77-cpp-client-skeleton/index.json` decisions (2)(3) · open_questions (1)
- `docs/cutover-p4.md` §0(step0 툴체인 실측 — Qt 버전·CMake 제너레이터·오프스크린)
- `docs/ADR.md` 새 P4 ADR(step1 신설분 — 모듈 위치·빌드 시스템 결정)

## 작업
1. **TDD**: 먼저 실패하는 최소 테스트를 둔다 — 예: `client-qt/tests/`에 `SmokeTest`(빌드 존재 확인 + 버전 상수 1건 단언). 구현 전 red를 확인한다.
2. `client-qt/CMakeLists.txt`(루트) + 하위 `core/`·`net/`·`ui/`·`shell/`·`tests/` `add_subdirectory`. Qt 6 `find_package(Qt6 COMPONENTS Widgets Test REQUIRED)`. C++17 이상. `enable_testing()` + `add_test`로 ctest에 스모크 테스트 등록.
3. 각 레이어는 **라이브러리 타깃**(예: `client_qt_core`, `client_qt_net`, `client_qt_shell`, `client_qt_ui`)으로 두고, 앱 실행 파일(`client_qt_app`)이 이들을 링크한다. P4에 없는 `editor/`는 만들지 않는다.
4. 최소 `main.cpp`: `QApplication` + 빈 `QMainWindow`(제목만) — 아직 로그인/목록 아님. `--selftest` 같은 헤드리스 모드는 스파이크 관례를 따라 오프스크린으로 돌 수 있게 둔다(후속 step의 AC가 이를 쓴다).
5. `client-qt/README.md`에 빌드·테스트 커맨드(step0 실측 툴체인 기준)와 모듈 레이아웃을 적는다.
6. **디렉토리 규율**: `client-qt/`는 리포 루트 신규 모듈이다 — 기존 `client/`(Electron)·`server-spring/`·`web/`·`src/`를 한 파일도 건드리지 않는다.

## Acceptance Criteria
```
# step0이 실측한 제너레이터/툴체인으로(예: Ninja 또는 NMake · Windows MSVC 환경):
cd client-qt && cmake -S . -B build [-G <제너레이터>]      # 구성 성공
cmake --build client-qt/build                              # 빌드 성공 · 경고 0 목표
QT_QPA_PLATFORM=offscreen ctest --test-dir client-qt/build --output-on-failure   # 스모크 1건 green
cd /home/user/harness && npm test                          # 1328 pass(기존 회귀 없음 — client-qt는 npm 밖)
cd /home/user/harness && git diff --stat                   # client-qt/** 만 추가된다
```
- ctest가 최소 1건 green이고, 그 테스트는 구현 전 red였다가 이 step에서 green이 된 것이다(TDD 증거를 커밋 메시지/문서에 남긴다).
- `client/**`·`server-spring/**`·`web/**`·`src/**`·`contract/**`가 무접촉이다.

## 검증 절차
1. `cmake -S client-qt -B build` → `cmake --build` → `ctest`를 순서대로 돌려 3단계 모두 성공을 확인.
2. `git status`로 새 파일이 전부 `client-qt/` 아래인지 확인.
3. `npm test`로 기존 JS 테스트가 그대로 green인지 확인(신규 C++ 모듈이 기존 러너에 영향 0).

## 금지사항
- shell·net·ui의 **실제 로직**(config 파싱·REST 호출·화면)을 여기서 구현하지 마라. 이유: 이 step은 골격 전용이다 — 로직을 섞으면 후속 step의 실패 격리가 불가능해진다(원칙 1).
- `editor/` 모듈을 만들지 마라. 이유: 에디터는 P5 범위다(excluded (a)).
- 기존 스파이크 `spike.pro`를 CMake로 개종하거나 `client/**`를 건드리지 마라. 이유: 스파이크는 go/no-go 증거물이고 Electron 클라는 무수정 대체재다(excluded (d)).
- Qt 외 서드파티 네트워크/JSON 라이브러리를 끌어오지 마라. 이유: ADR 철학(의존성 최소) — Qt 기본(QtNetwork·QJson*)으로 충분하다.
