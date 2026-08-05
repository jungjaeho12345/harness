# Step 1: editor-selection-delete

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `CLAUDE.md` — TDD(테스트 먼저)
- `docs/ADR.md` — ADR-003(View는 순수 로직 + 컴포넌트, transport 비의존)
- `docs/news.md` 158~178행 — 기사 에디터 규칙(특히 167~170행 "(끝)" 마커 계약)
- `web/src/view/Editor.jsx` — **이 step이 수정하는 유일한 프로덕션 파일**. 파일 상단 CRITICAL 주석(타이핑 중 재렌더 금지·remount 계약), `readCaret`(L130~154), `readCaretForInsert`(L161~246), `caretBlocked`(L249~252), `emitInsert`(L438~444), `handleKeyDown`(L458~469), `handlePaste`(L480~505), `handleInput`(L514~522)
- `web/src/view/editorNewline.js` — **step 0에서 추가된** `replaceRangeInBlocks(blocks, range, text)`와 그 좌표 계약(`lineIndex`=텍스트 블록 순번, `offset`=`blocksToText` 절대 오프셋), 규칙 1-b(캐럿 미상 폴백은 마커 줄 직전). 이 step은 이 파일을 수정하지 않고 **호출만** 한다
- `web/src/view/editorNewline.test.js` — step 0이 잠근 규칙(마커 clamp·임베드 보존·align 승계·collapsed 동치)
- `web/src/view/editorSelect.js` — **앱이 실제로 만드는 선택의 모양**. 전체 선택 `selectAllInEditor`(L12~15: `range.selectNodeContents(root)`), 한 줄 선택 `selectLineInEditor`(L40~42: `selectNodeContents(lineEl)`), 문단 선택 `selectParagraphInEditor`(L75~78: `setStartBefore`/`setEndAfter`), 단어 선택 `selectWordInEditor`(L57~59: 텍스트 노드 offset). 앞의 셋은 **요소(element) 앵커**를 만든다
- `web/src/view/WriterPage.jsx` — `edit.selectAll`/`selectParagraph`/`selectLine`/`selectWord` 메뉴가 위 함수들을 호출하는 결선부(수정하지 않는다 — 이 step은 Editor.jsx만 만진다)
- `web/src/view/Editor.test.jsx` — 기존 캐럿/Enter/붙여넣기 테스트와 `caretAtLine`(`selectNodeContents(lineEl)` + `collapse` — **요소 앵커 offset 0**)·`setCaret` 헬퍼

## 배경 (이 step 안에서 자기완결)

Enter(`handleKeyDown` L463~467)와 여러 줄 붙여넣기(`handlePaste` L497~504)는 `e.preventDefault()`로 브라우저 기본 동작(선택 범위 삭제 후 삽입)을 막고 `emitInsert`에 위임한다. 그런데 `emitInsert`가 쓰는 `readCaretForInsert`는 `sel.anchorNode`/`sel.anchorOffset`만 읽고 `isCollapsed`/`focusNode`를 보지 않으므로, 선택 범위가 있어도 **한 점**으로만 취급된다. 결과적으로 선택 텍스트가 지워지지 않는다.

재현: `hello world`에서 `world` 선택 → `A\nB` 붙여넣기 → 기대 `hello A` / `B`, 실제 `hello A` / `Bworld`. Enter도 동일. 한 줄 붙여넣기는 네이티브 위임이라 정상 대체되므로 **동작 분기**가 생긴다.

step 0이 순수 계층에 `replaceRangeInBlocks(blocks, range, text)`를 만들어 두었다(범위 삭제 + 삽입 + 마커 clamp + 임베드 보존 + align 승계). 이 step은 **DOM selection을 그 range 좌표로 환산해 넘기는 결선**만 한다.

**여기서 반드시 해결해야 할 것 — 요소(element) 앵커**: 이 앱에서 사용자가 만드는 선택의 상당수는 텍스트 노드가 아니라 **요소**를 앵커로 갖는다.

| 제스처 | 만드는 range | anchor/focus 노드 |
|---|---|---|
| 편집>전체 선택(`selectAllInEditor`) | `selectNodeContents(root)` | **편집 div(root)** + 자식 인덱스 offset |
| 편집>한 줄 선택(`selectLineInEditor`) | `selectNodeContents(lineEl)` | `.yh-editor__line` 요소 + 자식 인덱스 |
| 편집>문단 선택(`selectParagraphInEditor`) | `setStartBefore`/`setEndAfter` | **root** + 자식 인덱스 |
| 편집>단어 선택(`selectWordInEditor`) | `setStart/End(textNode, col)` | 텍스트 노드 |
| 마우스 드래그 | 보통 텍스트 노드 | 텍스트 노드 |

그런데 재사용 대상인 `readCaretForInsert`(L219~246)는 **root가 앵커면 `caretLine`을 못 채워 `null`을 반환**하고, `walkBlock`(L176·L195)은 요소가 앵커면 **offset을 무시하고 col 0으로 고정**한다. 그대로 두면:

- 전체 선택·문단 선택 → range가 `null` → step 0의 **캐럿 미상 폴백**으로 흘러 삭제 0 + 문서 끝(마커 앞) 덧붙임
- 한 줄 선택 → anchor/focus 둘 다 col 0으로 접혀 **collapsed** → 삭제 0

즉 "선택 후 Enter/붙여넣기가 선택을 지운다"는 이 phase의 목표가 **가장 흔한 메뉴 제스처에서 미해결로 남는다**. 텍스트 노드 offset만 쓰는 테스트는 전부 green이므로 결함이 조용히 통과한다. 따라서 이 step은 **요소 지점 환산 규칙을 반드시 포함한다.**

## 작업

### 1) 착수 전 실측

```bash
npm run test:web    # step 0 완료 기준선(2011 + step0 신규)이 전부 green인지 확인
npm run lint
```

### 2) 테스트 먼저 (TDD — red 확인 필수)

`web/src/view/Editor.test.jsx`에 케이스를 추가한다. 선택 범위는 jsdom Selection으로 만든다:

```js
const sel = window.getSelection();
sel.removeAllRanges();
const r = document.createRange();
r.setStart(node, startOffset); r.setEnd(node2, endOffset);
sel.addRange(r);                       // 정방향
// 역방향은 sel.setBaseAndExtent(node2, endOffset, node, startOffset) 사용
```

결함 재현 케이스(구현 전 red여야 한다):

1. `[textBlock('hello world')]`에서 `world`(offset 6~11)를 선택하고 여러 줄 붙여넣기(`clipboardData.getData('text/plain')`가 `'A\nB'`) → `onTextChange`가 받은 텍스트가 `'hello A\nB'`.
2. 같은 선택에서 Enter 키다운 → `onTextChange` 텍스트가 `'hello \n'`.
3. 두 줄에 걸친 선택(line0 중간 ~ line1 중간)에서 Enter → 두 줄이 병합·분할된 결과(step 0 규칙과 일치).

정상 플로우 무손상(회귀 케이스 — 반드시 포함):

4. collapsed 캐럿 Enter/여러 줄 붙여넣기의 기존 테스트가 전부 그대로 green이다(줄 중간 분할·`<br>`로 거칠어진 줄·remount 후 캐럿 줄 지정 포함).
5. 한 줄 붙여넣기는 여전히 `preventDefault`하지 않고 `onTextChange`를 호출하지 않는다(네이티브 위임 유지).
6. 이미지 붙여넣기(`onPasteImageFile` 위임)와 `"(끝)"` 뒤 붙여넣기 차단이 그대로다.
7. 타이핑(`input` 이벤트) echo 경로가 그대로다 — 타이핑 후 편집 div가 remount되지 않는다(캐럿 보존 계약).

**요소 앵커 케이스(필수 — 구현 전 red여야 한다)**: 각 케이스는 `web/src/view/editorSelect.js`의 실제 함수를 import해 선택을 만들고(앱과 같은 경로), Enter와 여러 줄 붙여넣기 **양쪽**에서 선택 텍스트가 실제로 사라지는지 단언한다.

10. **전체 선택**(`selectAllInEditor(box)`) + 여러 줄 붙여넣기(`'A\nB'`) → 본문이 통째로 대체돼 `onTextChange` 텍스트가 `'A\nB'`다(선택 텍스트 0 잔존). 같은 선택 + Enter → `'\n'`.
11. **문단 선택**(`selectParagraphInEditor(box, 0, 1)` — `setStartBefore`/`setEndAfter`, root 앵커) + Enter → 두 줄이 사라지고 빈 두 줄만 남는다(step 0 규칙과 일치).
12. **한 줄 선택**(`selectLineInEditor(box, 0)` — 줄 요소 앵커) + `'X'` 포함 여러 줄 붙여넣기 → 그 줄 내용이 대체된다(collapsed로 접혀 삭제 0이 되면 안 된다).
13. **전체 선택 + 마커 문서**: `[text('본문'), text('(끝)')]`에서 `selectAllInEditor` 후 `'A\nB'` 붙여넣기 → 결과 본문에 `'(끝)'` 블록이 **정확히 하나 온전히** 남고 `'(끝)A'` 같은 오염이 없다(step 0 규칙 1-b·3이 결선 레벨에서 성립하는지 확인 — 이 경로는 `readCaret`도 null이라 `caretBlocked`가 막지 않는다).

경계 케이스:

14. **역방향 선택**(`setBaseAndExtent`로 anchor가 뒤, focus가 앞): 1과 동일한 결과.
15. **focus가 에디터 밖**(예: focus 노드를 컨테이너 밖 요소로 둔 선택): 삭제 없이 anchor collapsed 삽입(오늘 동작 유지 — 폴백).
16. **anchor 환산 실패**: anchor 자체를 환산할 수 없으면(에디터 밖 노드 등) `emitInsert`가 `range: null`로 흘러 step 0의 캐럿 미상 폴백을 탄다(오늘과 동일 — focus가 유효해도 anchor 없이 범위를 지어내지 않는다).
17. **마커에 걸친 선택**: `[text('본문'), text('(끝)')]`에서 line0 중간 ~ 마커 줄 끝까지 선택 후 Enter → 결과 본문에 `'(끝)'` 줄이 정확히 하나 온전히 남는다(step 0 clamp가 걸리는지 결선 레벨에서 확인).
18. **역방향으로 anchor가 마커 뒤인 선택**: 기존 `caretBlocked`가 걸려 `onTextChange`가 호출되지 않는다(본문 무변경 — 의도된 보수적 no-op).

### 3) 구현 — `web/src/view/Editor.jsx`만 수정

1. 기존 private 함수 `readCaretForInsert(root)`를 **지점 계산 함수로 일반화**한다:

```js
// (node, offset) 지점을 텍스트-only 좌표 { lineIndex, offset }로 환산한다. 미발견/에디터 밖이면 null.
function readPointForInsert(root, node, offset)

// 현재 selection을 삽입용 range로 읽는다. { start, end } (둘 다 위 좌표) 또는 null.
function readSelectionForInsert(root)
```

- 기존 walk 로직(줄 안 `<br>`·중첩 블록·인라인 span·임베드 경계 처리)은 **그대로 재사용**한다. anchor 전용으로 하드코딩된 `A`/`AO`를 인자로 받게 바꾸는 수준의 변경이면 충분하다.
- **요소 지점 규칙(필수 — 위 배경 표의 제스처를 살리는 핵심)**: `node`가 요소면 `offset`은 문자 오프셋이 아니라 **자식 경계 인덱스**다(DOM Range 표준).
  - `offset < node.childNodes.length` → `node.childNodes[offset]` **바로 앞** 지점으로 환산한다.
  - `offset >= node.childNodes.length`(= `selectNodeContents`의 끝, `setEndAfter`가 만드는 지점) → **그 요소 내용의 끝** 지점으로 환산한다.
  - `node === root`(전체 선택·문단 선택이 만드는 앵커)도 반드시 처리한다 — 오늘처럼 `null`을 돌려주면 안 된다. root의 자식 경계를 위 규칙대로 해석해 "그 자식 앞의 텍스트 줄 경계" 또는 "문서 끝"으로 환산하라.
  - 임베드(`.yh-embed`) 자식 경계는 텍스트 좌표계에서 앞 텍스트 줄의 끝/다음 텍스트 줄의 시작 중 하나로 수렴한다(임베드는 `blocksToText`에 포함되지 않는다 — step 0 좌표 계약).
  - **회귀 안전 근거(리뷰어 전수 확인)**: 오늘 요소 앵커를 쓰는 경로는 전부 `offset === 0`이다 — `focusLineStart`(L262~275)·`focusCaretAt`의 빈 줄 폴백은 `selectNodeContents(line)` + `collapse(true)`, `Editor.test.jsx`의 `caretAtLine`도 동일하다. 새 규칙에서 `offset 0`은 "첫 자식 앞" = 줄 시작 = col 0으로 **오늘과 같은 값**이 나온다. 기존 Enter/붙여넣기 테스트는 텍스트 노드 앵커라 영향이 없다.
- `readSelectionForInsert`:
  - anchor 지점 환산이 **null이면 `null`을 반환**한다(focus가 유효해도 범위를 지어내지 않는다 — 오늘의 폴백 동작 유지).
  - `sel.isCollapsed`이거나 `focusNode`가 없거나 `root.contains(focusNode)`가 false거나 focus 지점 환산이 null이면 **anchor로 collapsed range**를 만든다(삭제 없음).
  - 그 외에는 anchor/focus 두 지점을 `{ start, end }`로 담아 넘긴다(순서 정규화는 step 0의 순수 함수가 한다 — 여기서 중복 구현하지 마라).

2. `emitInsert(root, text)`가 `insertTextIntoBlocks(cur, caret, text)` 대신 `replaceRangeInBlocks(cur, range, text)`를 쓰도록 바꾼다. import도 함께 정리한다(`insertTextIntoBlocks`가 더 이상 이 파일에서 쓰이지 않으면 import에서 제거하되, `isInputBlocked`는 유지).

3. 그 외 동작은 **전부 그대로 둔다**:
   - `caretBlocked`(`readCaret` anchor 기준)는 **수정 금지** — Enter/붙여넣기/타이핑/IME 전부가 쓰는 전역 차단 규칙이고 좌표계가 다르다(A-3 결정).
   - `handleKeyDown`/`handlePaste`의 분기 조건·`preventDefault` 위치·`textLocked`/`composingRef` 가드 불변.
   - `emitInsert`는 계속 `nextCaretLineRef.current`를 설정하고 `onTextChange(blocksToText(next), next)`만 호출한다. `lastEmittedRef`는 **갱신하지 않는다**(갱신하면 echo로 판정돼 remount가 사라지고 `<br>`/미래핑 DOM이 살아남는다).

## Acceptance Criteria

```bash
npm run test:web    # step0 기준선 + 신규 케이스, fail 0
npm run lint        # clean
npm run build       # 번들 빌드 성공
npm test            # 백엔드 무접촉 확인 — 751 그대로 green
```

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 변이 검증(각각 확인 후 반드시 원복):
   - `readSelectionForInsert`가 항상 collapsed range를 반환하도록 바꾸면 케이스 1·2·3·14가 red가 되는가?
   - 요소 지점 규칙을 제거(요소 앵커 → col 0 고정, root → null)하면 케이스 10·11·12·13이 red가 되는가? **이 변이가 red를 만들지 못하면 요소 앵커 테스트가 실제 제스처를 재현하지 못하고 있는 것이다 — 테스트를 고쳐라.**
   - focus가 에디터 밖일 때의 폴백을 제거하면 케이스 15가 red가 되는가?
3. 아키텍처 체크리스트:
   - 수정 범위가 `web/src/view/Editor.jsx` + `web/src/view/Editor.test.jsx`뿐인가? (`editorNewline.js`·`WriterPage.jsx`·`server/`·`src/` 변경 0건)
   - 편집 div의 DOM을 직접 조작하는 코드가 새로 생기지 않았는가?(파일 상단 CRITICAL)
   - 본문 변경이 여전히 `onTextChange` 단일 경로로만 나가는가?
4. 결과에 따라 `phases/53-integrity-fixes/index.json`의 step 1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "선택 range 환산 방식·폴백 규칙·테스트 증감·collapsed 회귀 확인 요약"`
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 즉시 중단

## 금지사항

- `range.deleteContents()`·`document.execCommand('delete')`·`node.remove()` 등으로 편집 div DOM을 직접 지우지 마라. 이유: 브라우저가 바꾼 DOM을 React가 재조정하면 캐럿 소실·removeChild 크래시가 나기 때문에 이 컴포넌트는 구조 변경을 blocks→remount로만 반영한다(파일 상단 CRITICAL). execCommand는 폐기 API이자 jsdom 미구현이라 회귀 방어도 불가능하다.
- `caretBlocked`/`readCaret`의 구현이나 caret 소스를 바꾸지 마라. 이유: 타이핑·한 줄 붙여넣기·IME 조합까지 쓰는 전역 차단 규칙이고, `readCaret`(.yh-editor__line 좌표)과 `readCaretForInsert`(줄 분할 좌표)는 dirty DOM에서 값이 갈린다 — 회귀 표면이 이 phase 범위를 넘는다.
- `emitInsert`에서 `lastEmittedRef.current`를 갱신하지 마라. 이유: echo로 판정되어 remount가 생략되고 "1줄 = 1 `.yh-editor__line` = 1 텍스트 블록" 불변식이 깨진다.
- 선택 범위 정규화(역방향 swap)·마커 clamp·임베드 보존 로직을 이 파일에 다시 구현하지 마라. 이유: step 0의 순수 함수가 단일 출처다. 두 벌이 되면 규칙이 갈라진다.
- 요소 앵커를 "col 0"으로 접거나 `null`로 흘려보내지 마라. 이유: 편집 메뉴의 전체/문단/한 줄 선택이 전부 요소 앵커라, 그렇게 두면 이 phase의 A 결함이 **가장 흔한 제스처에서 그대로 남는다**(텍스트 노드 기반 테스트만으로는 드러나지 않는다).
- `web/src/view/editorSelect.js`를 수정하지 마라. 이유: 선택 연산만 하는 헬퍼이고(파일 상단 CRITICAL: 본문/DOM 무변경), 선택의 모양이 아니라 **환산 규칙**이 이번 결함의 원인이다.
- 한 줄 붙여넣기 경로에 `preventDefault`를 추가하지 마라. 이유: 네이티브 대체가 이미 정확하며, 우리 경로로 끌어오면 IME·서식 붙여넣기 등 검증되지 않은 표면이 늘어난다.
- `web/src/view/editorNewline.js`를 수정하지 마라. 이유: 순수 계층 계약은 step 0에서 확정됐고, 두 파일 동시 수정은 실패 원인 격리를 불가능하게 한다.
- 기존 테스트를 깨뜨리지 마라.
