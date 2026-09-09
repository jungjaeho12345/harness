# Step 0: baseline-and-toolchain-survey

이 phase(P4 — C++ Qt 클라이언트 골격)의 **기준선을 이 트리에서 직접 재측정**하고, **Qt/CMake 툴체인을 실제 실행 머신에서 실측**하며, **사용자 실행 항목을 분리**한다. 코드는 만들지 않는다 — 측정·기록만 한다.

## 읽어야 할 파일
- `docs/porting-plan-cpp-spring.md` (§5 최대 리스크 · §6.2 클라이언트 매핑 · §7 P4 행 181행 · §10 열린 질문)
- `phases/77-cpp-client-skeleton/index.json` (이 phase의 baseline·decisions·open_questions)
- `spikes/p0-qt-editor/build.bat` (툴체인 경로 정본 — MSVC·WinSDK·Qt 경로) · `spikes/p0-qt-editor/spike.pro`
- `scripts/verify-client.mjs` · `scripts/verify-integration.mjs` (재사용할 verify 계약의 현 상태)
- `web/src/model/contract.js` (`MODEL_KEYS` — net 이식 정본, 35개인지 재확인)

## 작업
1. **기준선 재측정(이 트리에서 직접 · 인계값 검증)**. 각 커맨드를 **연속 2회** 돌려 flake 0을 확인하고 값을 기록한다. 인계값과 다르면 **다른 사실부터** 적는다:
   - `npm test` (기대 인계값 1328 pass / 0 fail / 0 skip)
   - `npm run lint` · `npm run build` (exit 0)
   - 리포 `news.db` md5 (기대 `7247e9e0dfe5cc8cd040ebb1dc9fb967`) · `uploads/` 파일수·바이트
   - (있으면) `node scripts/spring-contract.mjs --parity` exit 0 관측수
2. **Qt/CMake 툴체인 실측**(실제 실행 머신에서). 추측 금지 — 잰 것만 값으로 적는다:
   - Qt 6 버전(`qmake -v` 또는 Qt CMake 패키지 버전) · 설치 경로 · Widgets·Test 모듈 존재
   - CMake 존재·버전 (`cmake --version`) · 사용할 제너레이터(Windows=NMake/Ninja/MSBuild 중 실측 가용한 것)
   - 오프스크린 렌더 가용성: `QT_QPA_PLATFORM=offscreen`으로 스파이크 selftest가 도는지(step2가 본격 실행하므로 여기서는 **가용성만** 확인)
   - 컴파일러(MSVC 버전) · C++17 이상 지원
3. **스파이크 지문**: `spikes/p0-qt-editor/`의 파일 목록·`spike.pro` 내용·`selftest.cpp`의 4축(T1 색상·T2 마커·T3 IME·T4 캐럿) 존재를 기록한다(step2의 go/no-go 재현 입력 고정).
4. **사용자 실행 항목 분리**: 에이전트가 못 하는 것(예: Qt 런타임 설치·Windows 실기 IME 육안·정식 브랜치 명명)을 "왜 사람이 · 정확한 확인 방법 · 성공 판정"으로 목록화한다. **`docs/cutover-p4.md`를 신설**하고 그 §0에 남긴다.
5. **`docs/cutover-p4.md`를 P4 산출 문서 정본으로 확정한다** — §앵커 구조를 고정한다: **§0**(baseline·툴체인 실측·사용자 실행 항목 — 이 step) · **§1**(ADR-overrode-news.md 목록 — step1) · **§2**(에디터 스파이크 go/no-go 판정 — step2) · **§5**(diag 유지/재매핑 이벤트 목록 — step5). step2·step5·step9·step11·step12가 이 §앵커를 하드 참조한다. 이 step은 최소한 §0을 채우고 §1·§2·§5 헤더를 자리표시자로 만들어 둔다(대안 문서 없음 — "또는 porting-plan 착수 노트"는 쓰지 않는다).
6. **툴체인 부재 blocked 게이트(step2 no-go 분기와 동형)**: 2번 실측에서 **실행 머신에 Qt6 또는 CMake가 부재하거나 `QT_QPA_PLATFORM=offscreen` ctest가 불가**하면 → 그 사실(무엇이 없나·어떤 커맨드가 어떻게 실패했나)을 `docs/cutover-p4.md` §0에 그대로 기록하고, **이 phase를 blocked(사용자 툴체인 프로비저닝 대기)로 표시한 뒤 step3 진입을 금지**한다. 이는 프로덕션 결함이 아니라 환경 미비이므로 **execute.py가 하드실패를 오해 소지 있는 error로 3회 재시도·마감하게 두지 마라** — blocked로 명시 표기하고 오케스트레이터/사용자 판단을 기다린다.
7. 측정 전·중·후 `git diff --stat`이 `docs/cutover-p4.md` 신설 외에는 무출력(소스 무접촉)인지 단언한다.

## Acceptance Criteria
```
cd /home/user/harness && npm test        # 2회 연속 동일 · 0 fail · 0 skip
cd /home/user/harness && npm run lint     # exit 0
cd /home/user/harness && npm run build    # exit 0
cd /home/user/harness && git diff --stat  # docs/cutover-p4.md 신설 외 무출력(측정은 소스 트리를 바꾸지 않는다)
```
- 툴체인 실측표(Qt 버전·CMake 유무·오프스크린 가용)와 기준선 재측정표가 **`docs/cutover-p4.md` §0**에 기록되어 있다(정본 — 대안 문서 없음). §1·§2·§5 자리표시자 헤더가 존재한다.
- 인계값과 어긋난 항목이 있으면 "무엇이 · 얼마나 · 왜"가 함께 적혀 있다.
- **툴체인 부재 시**: Qt6/CMake 부재 또는 offscreen ctest 불가가 §0에 기록되고 phase가 **blocked(툴체인 프로비저닝 대기)** 로 표시되어 있다 — 이 경우 이 AC의 다른 항목(빌드형 후속 step)은 판정 대상이 아니고 step3 진입이 막힌다.

## 검증 절차
1. 위 AC 커맨드를 순서대로 실행하고 출력을 문서에 붙인다.
2. Qt/CMake 실측은 실행 머신에서 버전 커맨드를 직접 돌린 출력을 적는다(경로만 베끼지 마라).
3. 사용자 실행 항목 §0-1이 각 항목마다 "왜 사람이"를 명시하는지 확인한다.
4. 툴체인이 부재하면 phase가 blocked로 표시됐는지, step3 진입 금지가 문서에 박혔는지 확인한다.

## 금지사항
- 인계 수치를 실측으로 위장하지 마라. 이유: 하류 step이 틀린 기준선 위에서 무회귀를 오판한다.
- 빈칸을 추측으로 채우지 마라(운영 실값·미상 툴체인 경로). 이유: 추측이 계약처럼 굳으면 다음 게이트가 오염된다 — "미상 + 막는 step"으로 남겨라.
- 툴체인 부재를 프로덕션 error로 취급해 재시도로 넘기지 마라. 이유: 환경 미비(Qt6/CMake 없음)는 코드 결함이 아니다 — blocked로 명시하고 사용자 프로비저닝을 기다려야 execute.py가 오해 소지 있는 마감을 하지 않는다(step2 no-go 분기와 동형).
- 어떤 소스 파일도 수정하지 마라(이 step은 측정 + `docs/cutover-p4.md` 신설 뿐이다). 이유: 측정이 소스 트리를 바꾸면 무접촉 단언이 깨진다.
