# Step 8: text-engine-widget

Qt 텍스트 엔진 위젯을 세운다. 블록을 스타일 런으로 렌더하고, 캐럿/선택/줄 레이아웃을 다루며, **한글 IME 조합 중 무개입**하고, **모든 입력 경로가 마커 가드(step3)를 경유**하게 한다. 순수 로직(step1~7)은 호출만 한다.

> 이 step은 GUI라 QtTest 커버리지가 제한된다. **IME·캐럿은 자동 green 대상이 아니다**(로드맵 AC (2)) — 실물 MS-IME 육안은 step10 체크리스트. green을 지어내지 마라.

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — decisions (2)(4)(7) · open_questions (1).
- `docs/porting-plan-cpp-spring.md` §5 리스크 ①②③④ — 텍스트 엔진·IME·마커·스타일 런.
- `spikes/p0-qt-editor/editorwidget.h`·`editorwidget.cpp`·`main.cpp` — **P0가 go 판정을 받은 위젯 스파이크**. 기반 위젯 선택(open_questions (1))·스타일 런·마커 차단·캐럿 복원의 실증 경로. **읽고 복제하되 스파이크 파일은 고치지 마라(동결).**
- step0~7 산출물 전부(`client-qt/src/editor/**` — 블록·색·마커·캐럿/범위·단축키·undo·자동저장).
- `docs/news-md-overrides.md` L164(툴바 2개)·L174(네이티브 맞춤법 미배선).
- `client-qt/src/ui/**` — 기존 화면 컨트롤러(위젯 타입 0 규율 참고). **로그인/목록 컨트롤러는 회귀 — 고치지 마라.**

## 작업
1. `client-qt/src/editor/editorwidget.h`/`.cpp`(또는 `client-qt/src/ui/` 하위) 신설. 기반은 open_questions (1) 판정(스파이크가 go한 기반 — `QTextEdit`/`QTextDocument` 확장 또는 커스텀 `QAbstractScrollArea`).
2. **렌더**: step1 블록 모델 → step2 역할 색을 스타일 런으로 적용(줄 역할별 색 4종).
3. **입력 경로 라우팅(CRITICAL)**: 타이핑·Enter·붙여넣기·IME 커밋·단축키·변환 **모든 삽입 경로**가 step3 `isInputBlocked`/마커 게이트를 경유. 위젯이 스스로 substring/trim으로 재판정하는 경로 0.
4. **한글 IME(decisions (4))**: `inputMethodEvent`의 preedit/commit 분리 · 단축키 인식(step5)은 **조합 진행 중 아닐 때만**(preedit 비어 있을 때만) · 스타일 런 재계산은 commit 후에만(preedit 위 재색칠 금지 — 캐럿 튐 방지).
5. **단축키 결선**: step5 순수 판정을 `keyPressEvent`에서 호출(조합 중 인터셉트 금지).
6. **undo/자동저장 훅 자리**만 위젯에 노출(실제 결선은 step9 상태 기계).
7. QtTest(GUI 비의존 가능한 만큼): 마커 게이트 경유 실증(각 입력 경로에서 차단 위치 본문 무변) · 스타일 런이 역할 색과 일치 · 단축키 호출이 순수 판정 결과와 일치. **IME 조합 중 캐럿 안정·preedit 렌더는 QtTest로 잠그지 못한다 — step10 육안**.

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 신규 위젯 QtTest 포함 0 failed.
- `node scripts/verify-qt-client.mjs --scenario boot|login|list --server exe` → 각 exit 0(P4 화면 회귀 무변 — 목록/로그인은 그대로).
- 화면 인벤토리: 에디터 화면 추가는 「기사 편집」 1경로만(우클릭·6메뉴 없음 — P7 경계).
- `git status --porcelain` 이 가변 목록(index.json baseline) 밖 무변 — 특히 `client-qt/src/net`·`client-qt/src/shell` 무변.

## 검증 절차
1. 각 입력 경로(타이핑/Enter/붙여넣기/IME commit/단축키/변환)에서 마커 차단 위치 본문 무변을 QtTest로 실증.
2. 우회 변이 2종 이상(붙여넣기 경로가 마커 게이트 미경유 · preedit 위 재색칠)으로 red/결함 실증 후 원복(preedit 재색칠은 QtTest로 못 잡으면 육안 항목으로 명시).
3. 무접촉 경로 diff 0.

## 금지사항
- 임베드 인라인 렌더·맞춤법 하이라이트·찾기바꾸기·표를 넣지 마라. 이유: 전부 P6이다(excluded (a)).
- 조합(preedit) 중 단축키를 인터셉트하거나 재색칠하거나 캐럿을 옮기지 마라. 이유: 기자가 즉시 체감하는 캐럿 튐 결함(§5 리스크 ②).
- 위젯이 마커를 자체 substring/trim으로 재판정하지 마라. 이유: 마커 계약이 두 곳으로 갈라진다 — step3 게이트만.
- IME·캐럿 안정을 QtTest green으로 「증명했다」고 적지 마라. 이유: 자동 판정 불가 축이다 — 실물 IME 육안(step10)만이 판정한다. green 조작 금지.
- `client-qt/src/net`·`client-qt/src/shell`·기존 로그인/목록 컨트롤러를 고치지 마라. 이유: P4 회귀 기준이다.
