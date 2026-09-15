# 환경 제약 — 클라우드 Linux 세션에서 client-qt TDD 검증 불가 (2026-09-15)

## 결론
- step1~11의 C++ TDD(red→green)와 QtTest 실행은 이 클라우드 Linux 세션에서 **수행 불가**.
- 실물 **Windows(MSVC + Qt 6.8.3, `client-qt\build.bat`)** 환경이 필요하다.
- 이 세션에서는 **step0(ADR-019, 문서)까지만** 완료한다.

## 근거 1 (치명·의도된 설계)
- `client-qt/src/shell/singleinstance.cpp:14-24` 가 비-Windows에서 `#error "client-qt single instance: P4 builds on Windows only (ADR-018 (1))"` + `#include <windows.h>` 로 하드 차단한다. Linux 코드 경로가 없다.
- 이 파일은 `common.pri` 의 `CLIENT_SOURCES` 에 포함돼 app·tests 양쪽에 링크되므로, Linux에서는 tests 타깃 자체가 빌드 불가다.

## 근거 2 (부차)
- `QTimeZone::UTC`(Qt 6.5+ 전용)를 다음에서 사용한다:
  - `src/shell/diag.cpp:164`
  - `src/net/fakenewsmodel.cpp:195`
  - `tests/stubhttpserver.cpp:39`
- Ubuntu 24.04 apt는 Qt 6.4.2 상한(`QTimeZone::utc()` 필요)이라 컴파일되지 않는다.

## 확인된 사실
- Qt6 자체는 이 컨테이너에 설치 가능하다: apt `qt6-base-dev` = 6.4.2, ~31MB DL / ~156MB, 디스크 여유 ~30GB.
- `.pro` 파일은 플랫폼 무관하다(`QT += core gui widgets network testlib`, tests `main.cpp` 가 `QT_QPA_PLATFORM=offscreen` 강제). 즉 원인은 툴체인이 아니라 위 2개 소스다.
- 근거 3은 없다 — 위 둘만이다.

## IME/캐럿 게이트(OQ-6)
- step10/11 완료 게이트(실기 IME·캐럿 육안 판정)도 동일하게 실물 Windows+MS-IME가 필요하다.
- 즉 P5 구현·검증 환경은 근본적으로 Windows다.

## 선택지 (사용자/오케스트레이터 결정 필요)
1. **Windows 환경에서 구현 진행** (기존 phase 77과 동일). 이 세션은 ①기획·②검토·step0까지 인계한다.
2. **client-qt 크로스플랫폼 포팅** — `singleinstance.cpp` 에 `#else`(QLocalServer/QLockFile) 추가 + `QTimeZone::UTC`→`utc()`. 그러면 Linux CI/TDD가 가능해진다. 단 이는 **ADR-018의 Windows-only 결정을 바꾸는 아키텍처 변경**이라 별도 승인 + 신규 ADR이 필요하다(이 세션 범위 밖).

## 현재 진행 상태
- ①기획 완료(`e20e43a`)
- ②검토 approve
- step0 ADR-019 완료(`6a07d71`)
- step1~11 구현 환경 대기
