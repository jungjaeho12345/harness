# Step 6: shortcuts

**목표**: 웹 소스의 **predicate 함수 10종**(isInsertEndMarker·isInsertContinueMarker·isDeleteLine·isToggleOverwrite·isUndo·isRedo·isCompanyCode·isGlyphInput·isPasteOriginal·isFindReplace)의 키 인식(순수)을 전부 이식하고, **P5 소유 액션**(insertEndMarker·deleteLineAt·insertContinueMarker·transformTextLine·대소문자 4종)을 이식한다. 나머지 인식 키 3종(Backspace/Delete/Enter)은 predicate가 아니라 step11의 위젯 keyPressEvent 분기다(predicate 10종 + 위젯 분기 키 3종 = **키 인식 13종**). P6 소유 액션(약물/원본붙여넣기/기업코드/찾기바꾸기)은 predicate만 두고 액션은 스텁+forward note. 순수(키 이벤트는 값 객체로 추상화).

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §5(단축키 13종 표 + 재파생)·§3(마커).
- `web/src/view/editorShortcuts.js` (150행) — predicate 9종 + `insertEndMarker`·`deleteLineAt`·`insertContinueMarker`·`transformTextLine`·`toUpper/toLower/capitalizeFirst/toggleCase`·`CONTINUE_MARKER`.
- `web/src/view/editorFind.js:14` — `isFindReplace`(Ctrl+F predicate만).
- `web/src/view/WriterPage.jsx:1230-1333` — 키 결선 순서·충돌 규율(Insert→Ctrl+B→Ctrl+F→Alt+O→Alt+V→Alt+Y→Ctrl+Y→Undo→Redo→Ctrl+D/Backspace/Delete)·빈 줄 Backspace 판정.
- `web/src/view/editorShortcuts.test.js` (247행).
- **이전 step 산출물**: `blockmodel`(step1) · `writerbody.textLineToBlockIndex`+`marker`(step2).

## 작업 (테스트 먼저)
1. **red 먼저**: `client-qt/tests/shortcutstest.{h,cpp}`에 predicate 진리표 + 액션 케이스를 data-driven으로 옮긴다.
2. `client-qt/src/editor/shortcuts.{h,cpp}`:
   - **키 이벤트 추상화**: `struct KeyChord { QString key; QString code; bool ctrl, alt, shift, meta; }`(위젯의 `QKeyEvent`를 이 값으로 환산 — 위젯 결선은 step11). predicate는 `KeyChord`만 받는다(위젯 타입 비의존).
   - predicate 13종: `isInsertEndMarker`(Alt+Y)·`isInsertContinueMarker`(Ctrl+Y)·`isDeleteLine`(Ctrl+D)·`isToggleOverwrite`(Insert)·`isUndo`(Ctrl+Z)·`isRedo`(Ctrl+Shift+Z)·`isCompanyCode`(Ctrl+B)·`isGlyphInput`(Alt+O)·`isPasteOriginal`(Alt+V)·`isFindReplace`(Ctrl+F). 각 modifier 배제 규율을 그대로(예: `isInsertContinueMarker`는 `!alt`, `isFindReplace`는 `!alt`). 레이아웃 무관하게 `key` OR `code`.
   - **P5 액션**: `insertEndMarker(blocks)`→`{blocks, inserted, spellcheck}`(중복이면 미삽입, spellcheck 항상 true) · `deleteLineAt(blocks, index)`→`{blocks, removed, removedEmbed}`(텍스트 줄 뒤 임베드 1개 동반) · `insertContinueMarker(blocks, textLineIndex)`→`{blocks, caretTextLine}`(마커 최종 정규화) · `transformTextLine(blocks, textLineIndex, fn)` · `toUpper/toLower/capitalizeFirst/toggleCase`.
   - `CONTINUE_MARKER` = "(계속)".
   - **P6 액션은 만들지 않는다** — predicate만 이식하고, step11 위젯 결선에서 인식 시 `preventDefault` 상당 + no-op(forward note "P6가 다이얼로그/변환기 결선").
3. Enter/Backspace/Delete는 predicate가 아니라 위젯 keyPressEvent 분기(step11)이나, **빈 줄 Backspace/Delete → deleteLineAt** 규칙(`WriterPage.jsx:1327-1328`)과 마커 병합 가드(port-spec D3)는 step11에서 결선한다 — 이 step은 `deleteLineAt`만 제공.
4. 모듈 등록 2곳 + 테스트는 `tests.pro`에만.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
```

## 검증 절차
1. `editorShortcuts.test.js` predicate 진리표 + 액션 케이스 대응(누락 0). modifier 배제 규율(shift/meta 무시, alt/ctrl 구분) 전수.
2. **predicate 함수 10종 존재 + Backspace/Delete/Enter는 step11 위젯 분기로 이월**(port-spec §5 표와 대조). Backspace/Delete/Enter는 predicate가 아니므로 bogus `isBackspace`/`isEnter` predicate를 만들지 않았는지 확인. P6 액션이 만들어지지 않았는지 확인.
3. TDD red: `insertEndMarker` 중복 가드 제거 변이 → 중복 삽입 케이스 red(원복). `isInsertContinueMarker`에서 `!alt` 제거 변이 → Alt+Y 오인 케이스 red.

## 금지사항
- P6 액션(약물 다이얼로그·원본 붙여넣기·기업코드 변환·찾기바꾸기)을 구현하지 마라. 이유: 이 액션들은 P6 소유이고, 지금 만들면 없는 다이얼로그/변환기 위에 쌓인다 — predicate 인식 + 스텁까지만.
- predicate가 위젯 타입(`QKeyEvent`)에 의존하게 하지 마라. 이유: 순수 진리표 테스트가 GUI를 띄우게 된다 — `KeyChord` 값으로 받는다.
- 테스트 더블을 `common.pri`에 넣지 마라(F1).
