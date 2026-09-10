# Step 0: project-scaffold

## 읽어야 할 파일

먼저 아래를 읽고 포팅 아키텍처와 설계 의도를 파악하라:

- `/docs/porting-plan-cpp-spring.md` (특히 §3-① Qt 6 결정 · §6.2 "앱 구조(제안)" `core/net/editor/ui/shell` · §7 P4 행)
- `/docs/ADR.md` (ADR-011 클라이언트 접속형 셸 정책 · ADR-003 주입 가능한 Model 계약 seam)
- `/CLAUDE.md` (TDD · Conventional Commits · UTF-8 · DB 비파괴)
- `/spikes/p0-qt-editor/spike.pro` · `/spikes/p0-qt-editor/selftest.cpp` (P0 go 스파이크가 쓴 Qt 구성 — `QT += widgets testlib`, `c++17`. 이식 대상이 아니라 **구성 참고**용)

## 작업

새 디렉토리 `client-cpp/`에 **Qt 6 (C++17) 프로젝트 골격 + 테스트 하네스**만 만든다. 화면·네트워크·셸 로직은 이 step에서 만들지 않는다(다음 step들이 각 모듈을 채운다).

1. **빌드 시스템 = CMake.** `client-cpp/CMakeLists.txt`를 최상위로 두고 `find_package(Qt6 REQUIRED COMPONENTS Core Network Widgets Test)`를 선언한다. 이유: Qt 6는 CMake를 1급으로 지원하고 본 환경에 `cmake`가 설치돼 있다(P0 스파이크의 qmake `.pro`는 스파이크 전용이었다 — 골격은 CMake로 통일한다). `set(CMAKE_CXX_STANDARD 17)` · `set(CMAKE_CXX_STANDARD_REQUIRED ON)` · `CMAKE_AUTOMOC ON`.
2. **디렉토리 골격**(빈 소스라도 CMake 타깃에 등록): `client-cpp/core/` · `client-cpp/net/` · `client-cpp/shell/` · `client-cpp/ui/` · `client-cpp/tests/`. §6.2의 `editor/`는 P5~P6 범위이므로 **만들지 않는다**.
3. **정적 라이브러리 타깃 + 앱 타깃 분리**: 순수/로직 코드는 `newsclient_core`(static lib) 타깃에, `main.cpp`(QApplication 부트스트랩만)은 `newsclient`(app) 타깃에 둔다. 테스트가 로직 라이브러리에 링크할 수 있어야 한다(ADR-006 계층 분리와 동형 — transport/부트스트랩과 로직 분리).
4. **테스트 하네스**: `QtTest` + CTest. `client-cpp/tests/`에 스모크 테스트 1개(`tst_smoke.cpp`)를 두어 `QCOMPARE(1+1, 2)` 수준으로 하네스가 도는지만 확인한다. `enable_testing()` + `add_test(NAME ... COMMAND ...)` 또는 `qt_add_test`로 ctest에 등록한다.
5. **버전/제품 메타 자리만 예약**: `main.cpp`에서 `QApplication::setApplicationName("기사작성기")` · `setApplicationVersion("1.0.0")`만 설정한다(실제 창·프로브는 이후 step). UTF-8 소스로 저장한다.
6. **README 금지 대신 CMake 주석**으로 각 서브디렉토리의 책임(core=순수 로직 이식층 · net=REST/SSE + 쿠키 세션 · shell=config/diag/프로브/단일 인스턴스/bounds · ui=화면)을 1줄씩 명시한다.

핵심 규칙(벗어나지 마라):
- **런타임 네트워크 코드를 이 step에서 넣지 마라.** 이 step의 산출물은 "빌드되고 빈 스모크 테스트가 통과하는 골격"이다.
- 앱 타깃과 로직 라이브러리 타깃을 **반드시 분리**하라. 이유: 이후 모든 step이 QtTest로 로직 라이브러리를 직접 링크해 단위 테스트한다 — main에 로직이 섞이면 테스트가 QApplication 이벤트 루프에 묶인다.

## Acceptance Criteria

```bash
cmake -S client-cpp -B client-cpp/build -DCMAKE_BUILD_TYPE=Debug
cmake --build client-cpp/build -j
ctest --test-dir client-cpp/build --output-on-failure
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 디렉토리 골격이 §6.2(단, editor 제외)를 따르는가?
   - 로직 라이브러리 타깃과 앱 타깃이 분리됐는가?
   - 모든 소스가 UTF-8인가?
3. **Qt 6 미설치 시 처리(중요)**: `cmake -S ... -B ...` 단계에서 `find_package(Qt6)`가 실패하면(본 하네스 환경엔 Qt SDK가 없을 수 있다) 이는 코드 결함이 아니라 **외부 SDK 부재**다. 3회 자가교정으로 우회하지 말고 즉시 `phases/77-cpp-qt-client-skeleton/index.json`의 step0을 `"status":"blocked"` + `"blocked_reason":"Qt 6 SDK 미설치 — find_package(Qt6 COMPONENTS Core Network Widgets Test) 실패. 빌드 환경에 Qt 6.x(qt6-base-dev 등) + CMake Qt6 config 필요"`로 기록하고 **중단**한다. (오케스트레이터가 사용자에게 Qt SDK 설치를 요청한 뒤 재개한다.)
4. 결과 반영:
   - 성공 → `"status":"completed"`, `"summary"`에 생성한 CMake 타깃명(`newsclient_core`/`newsclient`)·디렉토리 골격·Qt 6 모듈(Core/Network/Widgets/Test)을 한 줄로 기록.
   - Qt 부재 → 위 3의 blocked.
   - 그 외 실패 3회 → `"status":"error"` + `error_message`.

## 금지사항

- `editor/` 디렉토리를 만들지 마라. 이유: 텍스트 엔진은 P5~P6 범위이고, 골격에 빈 에디터층을 두면 범위가 흐려진다.
- qmake `.pro` 빌드를 도입하지 마라. 이유: 골격 전체를 CMake 단일 빌드로 통일한다 — 스파이크의 qmake와 혼재하면 이후 step의 AC 커맨드가 갈라진다.
- Node/Spring/Electron/web 소스를 건드리지 마라. 이유: 이 phase는 신규 `client-cpp/`만 만든다. 기존 클라(Electron)는 P4~P7 상시 대체재로 보존한다.
- 기존 테스트를 깨뜨리지 마라.
