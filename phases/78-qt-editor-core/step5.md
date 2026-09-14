# Step 5: shortcuts

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (11)(12) · `excluded` (b)(c)
- **정본 소스(읽기 전용)**: `web/src/view/editorShortcuts.js` (150행 전체)
- **정본 테스트(전환 대상)**: `web/src/view/editorShortcuts.test.js` (28 케이스) — 전수 전환
- `phases/78-qt-editor-core/step2.md`·`step3.md`·`step4.md` — `blockmodel`·`writerbody`·`newline`(import)
- `web/src/view/writerBody.js` — `textLineToBlockIndex`(import)

## 배경

단축키 13종의 **키 인식 predicate + 블록 변환 로직**을 이식한다. 실제 keydown 결선은 step14/15(위젯)이고, 이 step은 **순수 인식/변환만**이다. 키 인식은 레이아웃 무관하게 **`e.key` OR `e.code`** 를 함께 본다(한글 입력 상태에서도 인식).

정본 predicate(수식어 조합 정확히 옮긴다):
- `isInsertEndMarker`(Alt+Y · !ctrl) · `isDeleteLine`(Ctrl+D · !alt) · `isInsertContinueMarker`(Ctrl+Y · !alt) · `isCompanyCode`(Ctrl+B · !alt) · `isToggleOverwrite`(Insert · 수식어 없음) · `isUndo`(Ctrl/Cmd+Z · !alt !shift) · `isRedo`(Ctrl/Cmd+Shift+Z · !alt) · `isGlyphInput`(Alt+O · !ctrl) · `isPasteOriginal`(Alt+V · !ctrl).

변환 함수:
- `insertEndMarker(blocks)`: 중복이면 `{blocks, inserted:false, spellcheck:true}` · 아니면 최종 블록에 `textBlock(END_MARKER)` 추가 · **spellcheck는 항상 true**(단, override L174 — 이 값은 로직 반환일 뿐 네이티브 맞춤법을 켜는 데 쓰지 마라).
- `deleteLineAt(blocks, index)`: 해당 블록 제거 · 텍스트 줄이면 **바로 뒤 임베드 1개 동반 삭제** · 반환 `{blocks, removed, removedEmbed}`.
- `insertContinueMarker(blocks, textLineIndex)`: 지정 텍스트 줄 다음에 `(계속)` 한 줄 · "(끝)" 최종 정규화(align 승계) · **멱등 아님**(여러 번 가능) · 반환 `{blocks, caretTextLine}`.
- `transformTextLine(blocks, i, fn)`: 텍스트 줄 fn 적용 · align 승계 · 범위 밖 no-op.
- 대소문자 4종: `toUpper`·`toLower`·`capitalizeFirst`·`toggleCase`(비알파벳 그대로).

## 작업

**테스트 먼저.** `editorShortcuts.test.js` 28 케이스를 QtTest로 옮긴다. 키 이벤트는 순수 구조체(예: `struct KeyEvent { QString key, code; bool ctrl, alt, shift, meta; }`)로 표현해 위젯 없이 판정한다(정본이 `e` 객체를 받는 것과 동형).

`client-qt/src/editor/shortcuts.{h,cpp}`: 위 predicate 9종 + 변환 5종 + 대소문자 4종. `CONTINUE_MARKER='(계속)'`.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorShortcuts.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 28과 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **28에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- key/code 병행 인식(한글 입력 상태 시뮬) · Alt+Y와 Ctrl+Y 구분 · redo와 undo(shift) 구분 케이스가 존재한다.

## 검증 절차

1. `editorShortcuts.test.js` 전수 대조(원본 28 대비 이식 수 기록).
2. **변이 2종**: (M5-a) `isInsertEndMarker`에서 `!ctrl` 제거 → Ctrl+Y가 Alt+Y로 오인되는 케이스 red? 원복. (M5-b) `deleteLineAt` 임베드 동반 삭제 제거 → 임베드 잔류 케이스 red? 원복. 결과표 기록.

## 금지사항

- **`insertEndMarker`의 `spellcheck:true` 반환으로 네이티브 맞춤법을 켜지 마라.** 이유: override L174 · ADR-011 — 셸에서 네이티브 맞춤법은 확정 미배선이다(값은 이식하되 배선은 금지).
- **여기서 keydown을 위젯에 결선하지 마라.** 이유: 결선은 step14/15의 것이고 이 step은 순수 인식/변환만이다.
- **위젯 의존·웹 원본 수정 금지.**
