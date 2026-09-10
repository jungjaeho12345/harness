# client-qt — Qt 네이티브 클라이언트 (로드맵 P4 · phase 77)

`docs/porting-plan-cpp-spring.md` §7 **P4 「C++ 클라 골격」** 의 산출물이다. Electron 셸 + 웹 SPA(`client/` + `web/`)를
대체할 네이티브 클라이언트를 여기에 세운다. **P4까지는 Electron 클라가 상시 대체재**이므로(로드맵 187행) 이 모듈이
동작하지 않아도 운영은 영향을 받지 않는다.

## 빌드 · 실행

```
cmd /c client-qt\build.bat        빌드(app + tests) 후 테스트 실행 — 실패하면 비-0 종료
cmd /c client-qt\run.bat          앱 실행(인자는 그대로 전달)
cmd /c client-qt\run.bat --selftest   창 없이 Qt 런타임 확인만 하고 0으로 종료
```

- **`run.bat`을 거치지 않고 `release\news-client.exe`를 맨 셸에서 실행하면 Qt DLL 부재로 즉사한다.** Qt는 동적
  링크이고 PATH에 `D:\agents\tools\Qt\6.8.3\msvc2022_64\bin`이 있어야 한다. Qt 경로의 정본은 **`env.bat` 한 곳**이고
  `build.bat`·`run.bat`이 그것을 `call` 한다. (자동 검증 드라이버만 exe를 직접 spawn하며, 같은 PATH를 자기가 싣는다.)
- 빌드 환경(MSVC · Windows SDK)은 `build.bat`이 명시 설정한다 — **이 머신은 VsDevCmd가 고장**이라
  `INCLUDE`/`LIB`/`PATH`를 직접 넣어야 `cl.exe`가 뜬다. 값은 P0 스파이크(`spikes/p0-qt-editor/build.bat`)가
  실증한 레시피의 복제다: MSVC `14.50.35717` · SDK `10.0.26100.0` · Qt `6.8.3 msvc2022_64`.
- **배치 파일은 전부 ASCII로 유지한다.** `cmd`가 배치를 cp949로 파싱하기 때문에 한글을 넣으면 조용히 깨진다.

## 디렉토리 규약

```
client-qt.pro   subdirs(app, tests)     — 두 타깃을 순차 빌드
common.pri      공통 소스/헤더 목록 · INCLUDEPATH · CONFIG(c++17) · QT 모듈
src/shell/      프로브 판정 · config · diag · 창 정책            (step2~5)
src/net/        라우트 표 · 전송 · Model 인터페이스 · SSE        (step7~9)
src/ui/         로그인 · 목록 · 서버 주소 설정                   (step10~11)
app/            TARGET = news-client        → client-qt/release/news-client.exe
tests/          TARGET = client-qt-tests    → client-qt/tests/release/client-qt-tests.exe
```

- **새 모듈은 `common.pri`의 `CLIENT_SOURCES`/`CLIENT_HEADERS`에 등록한다.** 앱과 테스트 러너가 항상 같은 코드를
  컴파일하게 하기 위해서다.
- **새 테스트 클래스는 `tests/main.cpp`의 `runTestClass<...>()` 한 줄로 등록한다.** 러너는 실행한 테스트 함수 수를
  세고 **0건이면 green을 거부**한다(exit 2).

## 이 트리에서 실측한 사실 (2026-09-10 · step0)

- **qmake `subdirs` 다중 타깃은 이 머신에서 실제로 선다.** 폴백(독립 `.pro` 2개 순차 호출)은 쓰지 않았다.
- **QtTest 자신의 PASS/FAIL 출력은 stdout이 리다이렉트되면 사라진다**(기본값도 `-o -,txt`도 동일 · 파일 로거는 정상).
  그래서 `tests/main.cpp`가 클래스마다 임시 파일 로거를 붙이고 그 내용을 자기 손으로 stdout에 다시 쓴다. 이 우회를
  걷어내면 `build.bat` 로그에 실패 건수만 남고 **어느 테스트가 깨졌는지 알 수 없게 된다**.
- 앱은 스파이크와 같이 **콘솔 서브시스템**으로 링크된다(`--selftest`가 셸에 결과를 찍어야 한다). 출시 바이너리의
  서브시스템·한글 제품명·아이콘·`windeployqt`·설치 패키징은 **P8(배포)의 결정**이지 P4가 아니다.

## 무엇이 P4가 아닌가

| 범위 밖 | 소유 phase |
|---|---|
| 에디터(텍스트 엔진·블록 모델·IME·undo·자동저장) | P5 |
| 임베드·맞춤법·찾기바꾸기·표·인쇄·다이얼로그 17종·환경설정 8탭·i18n | P6 |
| 조회 6메뉴·컬럼 설정·우클릭 14액션·상세보기 창·관리 4화면 | P7 |
| 한글 제품명 exe·아이콘·windeployqt·설치 패키징·Electron 은퇴 | P8 |

**서버·웹·Electron 클라·계약(`server/**`·`src/**`·`web/**`·`client/**`·`contract/**`·`docs/api-contract/**`)은 이
모듈이 한 줄도 고치지 않는다.** 계약은 동결(P1)이고 클라이언트는 그것만 믿는다.
