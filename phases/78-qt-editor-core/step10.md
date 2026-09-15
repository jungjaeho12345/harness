# Step 10: editor-widget

**목표**: QPlainTextEdit 기반 네이티브 에디터 위젯을 세운다 — 블록 로드→렌더, 줄 역할 색상(QSyntaxHighlighter), 캐럿 렌더/이동, 선택, 텍스트 편집→블록 라운드트립(직렬화). 순수 모듈(step1~7)을 위젯에 결선한다. IME·단축키·undo·자동저장은 step11. 캐럿은 실기+**육안 체크리스트**로 판정.

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §6(engine/caret)·§0(좌표계)·§2(block-model)·§4(edit-ops)·§10(제약).
- `spikes/p0-qt-editor/editorwidget.h`·`editorwidget.cpp`·`main.cpp` — **P0 스파이크 위젯 전체**(QPlainTextEdit + RoleHighlighter + loadSample/focusLineStart/recolorNow). 이 위젯을 프로덕션 `src/editor/`로 승격·정리하는 것이 이 step의 뼈대다.
- `web/src/view/Editor.jsx:1-104,334-373,375-409` — 렌더 계약·`focusLineStart`/`focusCaretAt`·props 계약(readOnly/textEditable/spellcheck/lang) — **DOM 워킹 코드는 이식하지 않고 계약만** 읽는다.
- **이전 step 산출물**: `blockmodel`(step1) · `writerbody`(step2) · `rangeedit`(step3) · `caretmath`/`textrange`(step4) · `coloring`(step7).
- `client-qt/src/ui/` 기존 화면(컨트롤러↔뷰 분리 관례) · `client-qt/README.md:1174`(의존 방향).

## 작업 (테스트 먼저 · 위젯은 QtTest 프로그램적 입력 + 육안 체크리스트)
1. **red 먼저**: `client-qt/tests/editorwidgettest.{h,cpp}` — QtTest로 프로그램적 검증 가능한 것부터: 블록 로드 후 `toPlainText()`가 `blocksToText`와 일치, `focusLineStart(n)` 후 커서 줄 인덱스, 편집 후 위젯→블록 라운드트립(`serializeBodyFromBlocks`)이 로드한 body와 일치(임베드 없는 케이스), 줄 역할 분류가 `coloring::classifyLines`와 일치. (QtTest GUI는 offscreen 플랫폼으로 — 스파이크 `main.cpp`의 `--selftest` offscreen 관례 승계.)
2. `client-qt/src/editor/editorwidget.{h,cpp}` — 스파이크 위젯 승격:
   - `class EditorWidget : public QPlainTextEdit` + `RoleHighlighter : public QSyntaxHighlighter`(줄 역할→색, `coloring` 모듈 사용).
   - `void loadBlocks(const QList<Block>&)` / `QList<Block> currentBlocks() const` — 위젯 텍스트↔블록 변환(임베드 블록은 블록 모델에 보존, 위젯엔 텍스트만 — D2/임베드 P6). load는 웹 RECOLOR_TRIGGERS 'load'와 동형(즉시 재색칠).
   - `void focusLineStart(int lineIndex)` / 캐럿 col 이동(`caretmath` 좌표 사용).
   - `void recolorNow()` — 조합 중이면 no-op(step11이 composing 연결 전엔 항상 실행 가능).
   - props 계약: `readOnly`/`textEditable`(매핑 모드 — 텍스트 비편집)·`spellcheck`/`lang`(표시 힌트) setter.
   - **캐럿/선택→좌표 환산**은 `QTextCursor`로(웹 `readCaret`/`readSelectionForInsert` DOM 워킹을 이식하지 않는다) — 순수 `rangeedit`의 `Point`/`Range` 좌표로 변환하는 얇은 어댑터만.
3. **캐럿 육안 체크리스트** `client-qt/CHECKLIST-editor-caret.md`(또는 README 절) 신설: (i) 본문 로드 후 색상이 제목 파랑/부제 빨강/본문 검정/"(끝)" 골드로 보이는가, (ii) 마우스 클릭·방향키로 캐럿이 자연 이동하는가, (iii) 줄 삭제/외부 재색칠 후 캐럿이 의도 위치로 복원되는가, (iv) 긴 문서 스크롤 중 히트테스트가 정확한가. 각 항에 판정 주체(사람)를 명시.
4. 모듈 등록: 위젯은 `common.pri`, 테스트는 `tests.pro`+`tests/main.cpp`.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed(위젯 QtTest 포함)
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
# 육안 체크리스트 파일 존재
test -f client-qt/CHECKLIST-editor-caret.md || grep -q '캐럿' client-qt/README.md
```
**육안 체크리스트(사람 판정)**: `CHECKLIST-editor-caret.md`의 (i)~(iv)를 실물 Qt 앱에서 확인. 자동 판정 불가 항목이므로 exit 코드가 아니라 사람이 판정하고 결과를 step 요약에 기록한다.

## 검증 절차
1. QtTest 프로그램적 케이스(로드/라운드트립/색상 분류/캐럿 이동) green.
2. 육안 체크리스트 4항 판정 결과가 요약에 기록됐는지.
3. TDD red: 로드 시 재색칠을 빼는 변이 → 색상 분류 케이스 red(원복).
4. 위젯이 `src/editor/`에 있고 컨트롤러가 위젯 타입에 의존하지 않는지(ADR-018 · 의존 방향).
5. contentEditable 방어 코드(snapshot/remount)를 이식하지 않았는지 확인(불필요 — port-spec §6).

## 금지사항
- 웹 `Editor.jsx`의 DOM 워킹(`readEditorBlocks`/`elementToLines`/`readCaret`/`readPointForInsert`)을 이식하지 마라. 이유: Qt는 `QTextDocument`/`QTextCursor`가 대신하며, 브라우저 길들이기 코드는 네이티브에서 구조적으로 불필요하다(ADR-018).
- 임베드 인라인 렌더를 구현하지 마라. 이유: 임베드 7종은 P6다 — P5 위젯은 텍스트만, 임베드 블록은 무손실 보존.
- QtTest GUI를 창을 띄우는 방식으로 돌리지 마라. 이유: offscreen이 아니면 헤드리스 빌드에서 실패한다(스파이크 offscreen 관례).
- 테스트 더블을 `common.pri`에 넣지 마라(F1).
