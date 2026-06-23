# Step 0: glyph-insert-pure — 캐럿 위치 약물 삽입 순수 헬퍼

## 배경 / 요구사항

phase16에서 환경설정에 "자주쓰는 약물(glyphFavorites)"·"사용자 키보드 약물(glyphKeymap)"을 등록/저장하는 UI가 들어왔지만, 등록한 약물을 **본문에 실제로 삽입**하는 동작은 없다(news.md L155·L173·L180·L206~209). 이번 phase에서 약물바(glyph bar)와 약물입력(Alt+O) UI를 만들어 약물을 캐럿 위치에 삽입한다.

이 step은 그 토대가 되는 **순수 함수 모듈** `web/src/view/editorGlyph.js`를 만든다. 약물(짧은 문자열)을 캐럿 `{lineIndex, offset}`에 삽입한 새 블록 배열을 돌려주는 헬퍼다. UI/결선/DOM/transport는 이 step이 하지 않는다(Step 1~4). phase9 `editorShortcuts.js`(insertContinueMarker)·phase14 `editorFind.js`(replaceAtMatch)와 **동일한 순수 함수·블록 모델 패턴**을 따른다.

CRITICAL: 약물 삽입은 contentEditable/DOM을 직접 조작하지 않는다. 이 step은 블록 배열만 다루는 순수 계산이며, 실제 본문 반영(`updateField('body', serialize(...))` + `setPendingCaretLine`)은 Step 2/4에서 WriterPage가 한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — 계층 분리, 순수 view 헬퍼는 transport 비의존.
- `/docs/news.md` — L152~181(기사 에디터·메뉴바), L206~209(자주쓰는 약물·사용자 키보드 약물).
- `web/src/view/editorContent.js` — 블록 모델: `textBlock`, `blocksToText`, `normalizeBlocks`, `isTextBlock`, `isEmbedBlock`, `END_MARKER`. (약물 삽입의 입출력은 모두 블록 배열이다.)
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(텍스트-줄 인덱스 → blocks 배열 인덱스). 재사용한다.
- `web/src/view/editorCaret.js` — `lineAtOffset(text, caretOffset)` → `{lineIndex, start, end}`(줄 안 컬럼 계산용).
- `web/src/view/editorShortcuts.js` — **참고 패턴**: `insertContinueMarker(blocks, textLineIndex)`가 텍스트-줄 다음에 한 줄을 끼우고 `caretTextLine`을 돌려주는 순수 함수 구조.
- `web/src/view/editorFind.js` — **참고 패턴**: `replaceAtMatch(list, text, match, replacement)`가 `lineAtOffset`+`textLineToBlockIndex`로 텍스트 블록 한 줄의 text만 갈아끼우는 구조(줄 안 컬럼 슬라이스).
- `web/src/view/editorFind.test.js`, `web/src/view/editorShortcuts.test.js` — 순수 함수 테스트 작성 컨벤션(vitest, describe/it, 입력 mutate 금지 단언).

## 작업

TDD로 진행한다(vitest). **테스트를 먼저 작성**(`web/src/view/editorGlyph.test.js`)하고, 통과하는 구현(`web/src/view/editorGlyph.js`)을 만든다. 순수 함수만 — DOM/window/transport/React 비의존.

### 구현할 함수 (시그니처 수준)

```js
// 약물(glyph) 문자열을 캐럿 {lineIndex, offset}의 텍스트 줄 안 컬럼에 삽입한 새 블록 배열을 돌려준다.
// caret 좌표는 blocksToText(blocks) 기준(텍스트 블록만 개행으로 이은 평문) — editorFind/replaceAtMatch와 동일 좌표계.
// 반환: { blocks, caretTextLine }
//   - blocks: 삽입 결과 블록 배열(입력 mutate 금지 — 새 배열).
//   - caretTextLine: 삽입된 줄의 텍스트-줄 인덱스(number) 또는 null(삽입 실패 시).
export function insertGlyphAtCaret(blocks, caret, glyph) { ... }
```

규칙:
1. `glyph`가 빈 문자열/null/undefined면 **no-op** — `{ blocks: normalizeBlocks(blocks), caretTextLine: null }` 반환.
2. `caret`이 null이거나 `caret.lineIndex`가 텍스트 블록 범위 밖이면 **폴백**: 마지막 텍스트 줄 끝에 삽입(없으면 첫 텍스트 블록 생성). 어떤 경우든 `caretTextLine`은 실제 삽입된 텍스트-줄 인덱스. (단순화: editorFind와 동일하게 줄 안 정확 컬럼은 caret.offset 기반으로 계산하되, caret이 없으면 줄 끝.)
3. 캐럿이 유효하면 `lineAtOffset(blocksToText(list), caret.offset)`로 그 줄의 시작 오프셋(start)을 구하고, `caret.offset - start`를 줄 안 컬럼으로 삼아 해당 텍스트 블록의 `text`를 `text.slice(0,col) + glyph + text.slice(col)`로 교체한다(editorFind.replaceAtMatch와 동일한 슬라이스 방식). `lineIndex`는 `caret.lineIndex`를 신뢰하되 `textLineToBlockIndex`로 blocks 인덱스를 구한다.
4. **임베드 블록·"(끝)" 마커·블록 순서·개수는 불변**: 약물은 텍스트 블록의 text만 바꾼다(임베드를 추가/삭제/이동하지 않는다). "(끝)" 줄에는 삽입하지 않는다(폴백 시에도 "(끝)" 앞 줄을 택한다 — phase14 replaceAll이 "(끝)" 텍스트를 건드리지 않는 것과 정합).
5. 입력 `blocks`를 **변형하지 마라**(새 배열/새 textBlock으로만). `normalizeBlocks`로 입력을 먼저 정규화한다(editorShortcuts/editorFind와 동일 진입 처리).

선택적으로(권장) 약물 유효성 헬퍼를 같은 모듈에 둘 수 있다(예: `normalizeGlyph(s)` — 트림/빈값 판정). UI(Step 1/3)에서 재사용 가능. 단, 키 인터셉트(keymap keys → glyph 자동치환)는 **이 phase 범위 밖**이므로 키조합 파싱 함수는 만들지 마라.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 함수**: DOM/window/document/transport/React 비의존. 입력 blocks를 mutate하지 마라. 이유: 부수효과가 있으면 Step 2/4 결선에서 캐럿/타이핑 회귀를 낸다.
2. **임베드·순서·개수 불변**: 약물은 텍스트 블록 text만 바꾼다. 임베드/"(끝)"을 추가/삭제/이동하지 마라. 이유: news.md 156·167행 블록 순서 보존 불변식.
3. **좌표계 일관**: caret 좌표는 `blocksToText` 평문 오프셋 기준(editorFind와 동일). 새 좌표계를 만들지 마라. 이유: Step 2/4가 `lastCaretRef`/`statusCaret`({lineIndex, offset})을 그대로 넘긴다.
4. **editorPrefs 스키마 불변**: 이 step은 editorPrefs.js를 import하지도 수정하지도 않는다(약물 데이터는 Step 2/4에서 주입). 이유: glyphFavorites/glyphKeymap 구조·기본값·loadEditorPrefs 병합은 읽기만(스키마 변경 불필요).

## Acceptance Criteria

```bash
cd web && npm run test -- editorGlyph    # 신규 editorGlyph.test.js 통과
cd .. && npm run test:web                # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `editorGlyph.test.js`):
- `insertGlyphAtCaret([textBlock('가나다')], { lineIndex: 0, offset: 2 }, '※')` → blocks의 첫 텍스트가 `'가※나다'`(컬럼 2 삽입), `caretTextLine === 0`.
- 빈 glyph(`''`/null/undefined)는 no-op(blocks 텍스트 불변, `caretTextLine === null`).
- caret null → 폴백으로 마지막 텍스트 줄 끝에 삽입되고 `caretTextLine`이 그 줄 인덱스.
- 임베드가 섞인 blocks(`[textBlock('a'), embedBlock(...), textBlock('b')]`)에서 텍스트 줄에 삽입해도 임베드 블록 위치·내용·개수 불변.
- "(끝)" 마커가 있는 blocks에서 폴백 삽입 시 "(끝)" 텍스트가 변경되지 않는다(약물은 "(끝)" 앞 줄에 들어간다).
- 입력 blocks 배열·요소가 mutate되지 않는다(원본 참조 비교 또는 deep-equal 단언).

## 검증 절차

1. 위 AC 커맨드를 실행한다(시스템 python cp949 이슈 시 `PYTHONUTF8=1` 환경변수).
2. 아키텍처 체크리스트: 순수 함수(부수효과 없음), 임베드/순서 불변, 좌표계 일관, editorPrefs 미접촉, Editor.jsx 미접촉.
3. 결과에 따라 `phases/17-editor-glyph-tools/index.json`의 step 0을 갱신(성공 → completed + summary / 3회 실패 → error / 개입 필요 → blocked).

## 금지사항

- contentEditable/DOM/selection을 조작하지 마라. 이유: 이 step은 순수 계산만 — DOM 반영은 Step 2/4 WriterPage 안전 경로.
- 임베드/"(끝)"을 추가·삭제·이동하지 마라. 이유: 블록 순서 보존 불변식(news.md 156·167행).
- editorPrefs.js를 수정하거나 새 스키마 키를 만들지 마라. 이유: glyphFavorites/glyphKeymap 구조는 그대로 읽기만.
- 키조합 인터셉트(keymap keys → glyph 자동치환) 파서를 만들지 마라. 이유: Editor 키 핸들러 변경이 필요 → 이번 phase 명시적 DEFER.
- `Editor.jsx`를 수정하지 마라. 이유: 타이핑/IME/캐럿/remount 불변식.
