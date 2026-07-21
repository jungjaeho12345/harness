# Step 1: editor-spell-render

step0의 순수 세그먼트 모델(`buildLineHighlights`)을 **에디터 본문에 표시전용 하이라이트로 렌더**한다. 이 step은 `Editor.jsx` 한 모듈만 바꾼다. **phase 30이 안전상 defer한 contentEditable 텍스트 노드 분할을 이 step에서 수행**하므로, 캐럿/echo/IME 불변식을 깨지 않는 것이 이 step의 전부다. 아래 "안전 불변식"을 계약으로 지켜라.

## 읽어야 할 파일

먼저 아래를 읽고 **왜 타이핑 중 재렌더가 금지인지**를 정확히 이해하라(이 step의 위험 전부가 여기서 나온다):

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`.
- `/docs/news.md` L171(Alt+Y 네이티브 맞춤법 — **별개 기능**, `spellCheck` 속성; 이 하이라이트와 혼동 금지), L216~219(오류 표현 굵게/밑줄), L168·L176(IME 조합 중 재색칠 금지).
- `web/src/view/Editor.jsx` — **전체**. 특히:
  - L6~9 파일 상단 CRITICAL 주석(타이핑 중 state 재렌더 → 캐럿 초기화·removeChild 크래시).
  - L259~306 `snapRef`/`lastEmittedRef`/`lastAlignRef`/`forceRecolorRef`/`renderTick` 선언 + **`[blocks]` echo/structural 판정 effect**(L280~306). echo면 무-remount(캐럿 보존), structural이면 snapshot 갱신 + `setRenderTick`(remount).
  - L308~325 `useLayoutEffect` 캐럿 복원(`pendingCaretLine` 우선 → `refocusRef` → `focusLineStart`).
  - L113~131 `readCaret`(**offsetInLine이 "줄에 텍스트 노드가 하나"라고 가정** — 하이라이트 span이 들어오면 깨진다), L138~206 `readCaretForInsert`(Enter/여러줄 붙여넣기 캐럿 — 인라인 span 안의 캐럿을 감지 못함), L220~235 `focusLineStart`.
  - L327~329 `renderBlocks = snapRef.current`(렌더 소스는 **prop이 아니라 snapshot ref**), `classifyLines(blocksToText(renderBlocks).split('\n'))`.
  - L444~501 렌더 루프(텍스트 블록 → `<div className="yh-editor__line" ...>{block.text}</div>`, `textLine` 증가로 `lineRoles` 매핑).
- `web/src/view/Editor.test.jsx` — 테스트 본보기(RTL, contentEditable, `window.getSelection`/`document.createRange`로 selection 구성, input/composition 시뮬레이션).
- `web/src/view/editorSpellHighlight.js` — **step0 산출물**. `buildLineHighlights(text, spans)` 계약(줄 인덱스 배열 → 세그먼트 `[{text,hl}]`). (step0 요약이 프롬프트에 함께 전달된다.)
- `web/src/view/editorContent.js` — `blocksToText`(텍스트 줄 좌표계). `classifyLines`가 `blocksToText(...).split('\n')`을 `textLine`으로 색인하는 것과 **동일 인덱스**로 세그먼트를 매핑해야 한다.
- `web/src/styles/yonhap.css` — L497~517(`.yh-editor`/`.yh-editor__line`). 하이라이트 span 클래스를 여기 추가.

## 배경 — 안전 불변식 (자기완결, 반드시 이해)

에디터는 **타이핑 중에는 편집 div를 다시 그리지 않는다**. 렌더 소스는 `blocks` prop이 아니라 `snapRef.current`(고정 snapshot)이고, snapshot과 `renderTick`(remount 키)은 **오직 `[blocks]` effect의 structural 분기에서만** 갱신된다. 타이핑(echo)은 snapshot을 그대로 두므로, React가 다시 렌더해도 "직전 렌더(=snapshot)와 동일"이라 DOM을 건드리지 않는다 → 브라우저가 찍은 글자가 살아남고 캐럿이 보존된다. structural 변경(로드·Ctrl+D·임베드·Enter·정렬·blur 재색칠)일 때만 `renderTick`을 올려 **키를 바꿔 통째로 remount**한다(브라우저가 만든 DOM과의 child-diff를 회피 → 크래시 방지).

**하이라이트도 정확히 이 규율을 따라야 한다:**

1. **렌더는 frozen snapshot만 읽는다.** 하이라이트 세그먼트는 `highlightSnapRef.current`(신규, `snapRef`와 형제)에서만 읽고, **`spellHighlights` prop을 렌더에서 직접 읽지 마라**. 이유: prop을 직접 읽으면 타이핑 중 부모 재렌더가 편집 div의 자식(span)을 브라우저 변형 DOM과 child-diff → removeChild 크래시/캐럿 소실.
2. **하이라이트 변화는 remount로만 반영한다.** 세그먼트를 붙이거나 없애는 시각 변화는 `renderTick` 증가(키 변경)로만 일어난다. bare prop 변화로 span을 추가/삭제(재조정)하지 마라.
3. **하이라이트 시그니처는 독립적이다.** `lastHighlightSigRef`(신규, `lastAlignRef`와 형제)로 하이라이트 변화를 판정한다. 하이라이트 유무/내용이 `lastEmittedRef`(텍스트)·`embedSig`·`alignSig`에 **절대 영향 주지 않게** 한다. 이유: phase 35 alignSig(lastAlignRef) 선례 — 표시 신호가 텍스트 echo 판정을 오염시키면 타이핑마다 헛 remount(캐럿 점프·자동저장 유실).
4. **하이라이트가 없으면 DOM은 오늘과 바이트 동일하다.** `spellHighlights`가 비면 `highlightSnapRef.current = null`이고 렌더는 `{block.text}` 순수 텍스트 노드로 폴백한다(span 0개). 이유: 회귀 표면 0 — 기존 캐럿/echo/IME 불변식을 하이라이트 미사용 경로에서 완전 보존.
5. **IME 조합 중 클리어-remount 금지(불변식).** 하이라이트 클리어는 `onTextChange`(→ step2 commitBody) 경로로만 일어나고, `handleInput`은 `composingRef` 가드로 **조합 중 `onTextChange`를 발화하지 않는다**(L410~411) → 하이라이트 클리어-remount는 **`compositionend` 이후로 자연 지연**된다. `compositionstart`나 조합 중 어떤 경로에서도 하이라이트를 지우거나 remount하지 마라. 이유: 조합 중 remount는 진행 중인 글자를 유실/이중입력시킨다(news.md L168·L176). 이 불변식은 step2(클리어 소유자)와 정합해야 한다.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

`Editor.jsx`만 수정(+ `editorSpellHighlight.js`·`yonhap.css`). 아래는 시그니처/메커니즘 수준 지시이며 구현 세부는 재량이되, **못박은 규칙은 벗어나지 마라.**

### 1) 신규 props

```
spellHighlights = []          // [{ start, end }] — blocksToText 절대 오프셋 span 목록(표시 대상)
spellHighlightStyle = 'bold'  // 'bold' | 'underline'
```

기존 props/동작은 불변. 두 prop 모두 표시 전용이며 콜백을 유발하지 않는다.

### 2) 하이라이트 snapshot + 시그니처

- `const highlightSnapRef = useRef(null);` — `{ map, style }` 또는 `null`. `map`은 step0 `buildLineHighlights` 결과(줄 인덱스 → 세그먼트).
- `const lastHighlightSigRef = useRef(highlightSig(spellHighlights, spellHighlightStyle));`
- `highlightSig(spans, style)` 지역 헬퍼: `JSON.stringify({ s: spans || [], st: style })`. 스타일(bold↔underline) 변경도 remount가 필요하므로 시그니처에 포함.
- snapshot 계산은 **structural remount 시 1회만**: `highlightSnapRef.current = (spellHighlights && spellHighlights.length) ? { map: buildLineHighlights(blocksToText(blocks), spellHighlights), style: spellHighlightStyle } : null;` (비면 `null`). **렌더 본문에서 `buildLineHighlights`를 호출하지 마라**(성능 — guard 5).

### 3) echo/structural effect 확장 (L280~306)

- effect 의존성에 하이라이트를 추가한다: `[blocks, spellHighlights, spellHighlightStyle]`.
- `structural` 조건에 `|| highlightSig(spellHighlights, spellHighlightStyle) !== lastHighlightSigRef.current`를 **추가**한다(기존 3조건은 그대로).
- structural 분기에서 snapshot을 갱신할 때 `highlightSnapRef`(위 2)와 `lastHighlightSigRef.current = highlightSig(...)`도 함께 갱신한다. `snapRef`/`lastEmittedRef`/`lastAlignRef`/`forceRecolorRef` 갱신은 기존대로.
- **캐럿 복원 대상 계산(캐럿 임계 — 산문 금지, 아래 의사코드대로 못박음)**: 열(column) 복원은 **"하이라이트-only 클리어 while focused"**에만 한다. 그 외는 기존 줄-시작 복원 그대로.

  ```js
  const textChanged  = incomingText !== lastEmittedRef.current;
  const embedChanged = embedSig(blocks) !== embedSig(snapRef.current);
  const alignChanged = alignSig(blocks) !== lastAlignRef.current;
  const hlChanged    = highlightSig(spellHighlights, spellHighlightStyle) !== lastHighlightSigRef.current;
  // 이번 structural이 "하이라이트 변화만"이고, 그 변화가 "클리어(신규 하이라이트 빈 경우)"인가:
  const hlOnlyClear  = hlChanged && !textChanged && !embedChanged && !alignChanged
                       && !(spellHighlights && spellHighlights.length);
  const override = nextCaretLineRef.current; nextCaretLineRef.current = null;
  if (override != null) {
    refocusRef.current = { lineIndex: override };             // Enter/여러줄 붙여넣기 — 줄 시작(기존)
  } else if (wasFocused && hlOnlyClear) {
    const c = readCaret(focusedRoot);                         // span-aware → { lineIndex, offset, col }
    refocusRef.current = c ? { lineIndex: c.lineIndex, col: c.col } : { lineIndex: 0 };
  } else if (wasFocused) {
    const c = readCaret(focusedRoot);
    refocusRef.current = { lineIndex: c ? c.lineIndex : 0 };  // 그 외 structural — 줄 시작(기존 계약 불변)
  } else {
    refocusRef.current = null;                                // blur/외부 로드/검색 삽입 — 포커스 가로채기 금지
  }
  ```

  이유: 열-복원은 **하이라이트를 지우는 remount(타이핑-echo 클리어)**에만 필요하다(guard 2c/2d — 타이핑 중 클리어가 줄 시작으로 튀지 않게). **`hlOnlyClear` 조건에 "신규 하이라이트 빈 경우"를 포함**해 하이라이트 SET-while-focused(신규 비지 않음)를 열-복원에서 제외한다 — 그래야 §6 focusCaretAt이 **클리어 후 단일 텍스트 노드 줄**에서만 호출된다([med] 정합). 하이라이트 외 structural(Ctrl+D/Enter/로드)은 줄-시작 복원 그대로 두어 회귀를 만들지 마라.

### 4) `readCaret` span-aware 고침 (L113~131)

- 현재 `offsetInLine = node.nodeType === 3 ? sel.anchorOffset : 0`는 줄에 텍스트 노드가 하나라고 가정한다. 하이라이트 span이 생기면 줄이 `[텍스트, <span>, 텍스트, …]`가 되어, "앞 형제 텍스트 노드"만 세는 좁은 규칙으로는 **anchor가 span 뒤 텍스트 노드일 때 앞 span 길이가 누락**돼 col이 과소 계산된다 → 클리어-remount에서 캐럿이 왼쪽으로 튄다.
- **정확 규칙(계약)**: `offsetInLine` = **줄 요소 시작부터 캐럿 지점 `(anchorNode, anchorOffset)`까지 document-order로 앞서는 모든 텍스트의 길이**(span 내부 텍스트 포함). anchor가 요소 노드면 그 자식 경계까지.
- **구현 제안**(재량이나 이 정의를 만족해야 함):

  ```js
  const r = document.createRange();
  r.selectNodeContents(lineEl);           // 줄 내용 시작
  r.setEnd(node, sel.anchorOffset);       // 캐럿 지점까지
  const offsetInLine = r.toString().length; // 앞선 전체 텍스트 길이(span 내부 포함)
  ```

  (`document.createRange`/`selectNodeContents` 가드는 `focusLineStart`와 동형.) **단일 텍스트 노드일 때 `r.toString().length === anchorOffset`**이라 기존과 동일(하위호환).
- 반환에 `col`(= `offsetInLine`)을 **추가로** 노출한다: `{ lineIndex, offset, col }`. 기존 호출부(lineIndex/offset만 사용)는 불변. 이유: (3)의 열-정확 복원과 상태표시줄이 span 존재 시에도 정확한 열을 얻는다.

### 5) `readCaretForInsert` span-aware 고침 (L138~206)

- `walkBlock`의 인라인 분기(L170~173)는 인라인 요소를 통째 textContent로 더하며, 그 **안의 텍스트 노드에 있는 캐럿(A)을 감지하지 못한다** → span 안에서 Enter 시 `caretLine=null` 반환 → 삽입 위치 오류.
- 인라인 요소 자식이 anchor를 **포함**하면 그 자식의 텍스트 노드들을 순회하며 `cur` 누적으로 `caretCol`을 잡도록 일반화하라(요소 자신이 anchor인 기존 케이스도 유지). span 없을 때 결과 불변(하위호환).

### 6) `focusCaretAt(root, lineIndex, col)` 신규 헬퍼 (`focusLineStart` 형제)

- root focus 후 `lineIndex` 줄(clamp)에서 `col` 위치에 collapsed 캐럿을 놓는다.
- **하이라이트-클리어 remount 직후 그 줄은 단일 텍스트 노드**(세그먼트 없음)이므로: 줄 요소의 `firstChild`(텍스트 노드)에 `range.setStart(textNode, min(col, textNode.length))`; collapse(true). 줄이 비어 텍스트 노드가 없으면 `selectNodeContents` + `collapse(true)`(줄 시작)로 폴백.
- `window.getSelection`/`document.createRange` 가드는 `focusLineStart`와 동형.
- **[med] 정합(택1 = "클리어 케이스 한정"을 명시)**: `focusCaretAt`은 §3의 `hlOnlyClear`(신규 하이라이트 빈 경우)에서만 호출된다. 따라서 호출 시 줄은 **항상 하이라이트가 비어 단일 텍스트 노드**이며 `firstChild=텍스트노드` 가정이 성립한다 — span이 남은 줄(SET-while-focused 등)에서는 호출되지 않는다. focusCaretAt을 span 순회형으로 일반화할 필요는 없다(그 대안은 채택하지 않음).

### 7) `useLayoutEffect` 복원 확장 (L314~325)

- `pendingCaretLine`(number) 우선 처리는 그대로.
- `refocusRef` 소비 시: `target.col != null`이면 `focusCaretAt(root, target.lineIndex, target.col)`, 아니면 기존 `focusLineStart(root, target.lineIndex)`.

### 8) 렌더 (L480~496)

- `textLine` 매핑은 그대로. 텍스트 블록 자식만 교체한다:

  ```jsx
  const hl = highlightSnapRef.current;
  const segs = hl ? hl.map[textLine] : null;
  const hlStyle = hl ? hl.style : 'bold';
  // children:
  (segs && segs.length && segs.some((s) => s.hl))
    ? segs.map((seg, k) => (seg.hl
        ? <span key={k} className={`yh-editor__spell yh-editor__spell--${hlStyle === 'underline' ? 'underline' : 'bold'}`} data-testid="spell-hl">{seg.text}</span>
        : seg.text))
    : block.text
  ```

  - **hl 세그먼트가 하나도 없으면 `{block.text}`로 폴백**(순수 텍스트 노드 — 오늘과 동일 DOM). 비-hl 세그먼트는 bare 문자열로 렌더(텍스트 노드; span 아님). hl 세그먼트만 span으로 감싼다.
  - span은 색을 지정하지 않는다(줄 role 색 상속). 굵게/밑줄만 클래스로.
  - `data-role`/`data-align`/`style`(color/textAlign)·`key`·`className="yh-editor__line"`는 불변.

### 9) CSS (`yonhap.css`)

`.yh-editor__line` 규칙(L517) 근처에 추가:

```css
.yh-editor__spell--bold { font-weight: 700; }
.yh-editor__spell--underline { text-decoration: underline; }
```

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test`는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. `Editor.test.jsx`에 아래를 **TDD로** 추가(적대적 — 캐럿/echo/IME):
   - **렌더**: `spellHighlights=[{start,end}]`+`spellHighlightStyle='bold'` → 해당 텍스트가 `.yh-editor__spell--bold` span으로 감싸이고, 줄 전체 `textContent`는 원문과 동일. `'underline'` → underline 클래스.
   - **미사용 DOM 동일성(회귀 가드)**: `spellHighlights=[]` → `.yh-editor__spell` 0개, 각 텍스트 줄은 단일 텍스트 노드(오늘과 동일).
   - **echo 독립성**: 하이라이트가 있는 상태에서 타이핑(onInput) 시뮬레이션 → `onTextChange`가 **정확한 텍스트**(span 투과 추출)로 발화. 하이라이트 유무가 텍스트 echo 판정을 바꾸지 않음(예: 텍스트만 echo이고 highlightSig 불변이면 remount/캐럿 튐이 없음 — 관측 가능한 근접 단언으로: 입력 후 편집 div가 remount되지 않고 텍스트가 보존됨).
   - **span-aware `readCaret`([high-1] 두 케이스 필수)**: `[텍스트 "AB", <span>"CD"</span>, 텍스트 "EF"]` 줄을 구성하고 —
     - (a) anchor가 **span 뒤 텍스트 노드**("EF")의 offset 1 → `col`이 `2("AB") + 2("CD") + 1 = 5`(앞 span 길이 포함), `offset`은 앞 줄들 + 5.
     - (b) anchor가 **span 내부 텍스트 노드**("CD")의 offset 1 → `col`이 `2("AB") + 1 = 3`.
     - 단일 텍스트 노드 케이스는 기존값 불변(하위호환).
   - **span-aware `readCaretForInsert`**: 캐럿을 span 안에 두고 Enter → `emitInsert` 분할 위치가 정확(결과 blocks 단언).
   - **`focusCaretAt`/열-정확 복원**: 하이라이트+포커스+캐럿을 줄 중간 col C에 둔 뒤 `spellHighlights`를 `[]`로 재렌더 → 편집 div가 remount되고 selection이 **줄 시작이 아니라 col C**에 복원, `.yh-editor__spell` 사라짐.
   - **IME([high-2] 강화 필수)**: 하이라이트 존재 상태에서 **첫 입력이 한글 조합**인 두 케이스(캐럿이 span **경계**·span **내부**) 각각 —
     - `compositionstart`→(조합 입력)→`compositionend` 시뮬레이션에서 **조합 중 편집 div remount 없음**(`renderTick` 불변 — 조합 중 하이라이트 클리어/remount가 일어나지 않음).
     - 조합 글자 **무손실·무중복**(compositionend 후 본문 텍스트가 정확).
     - `compositionend` **이후** 클리어-remount에서 캐럿 **열-정확 보존**(줄 시작으로 튀지 않음), `.yh-editor__spell` 사라짐.
   - **"(끝)" 마커**: 하이라이트가 있는 본문에서 마커 근처 캐럿의 `caretBlocked` 판정이 정확(삽입 차단/허용) — span-aware offset 덕분에 오탐/미탐 없음.
   - **[low-3] 정렬 줄 회귀**: 가운데(`align:'center'`)·우측(`align:'right'`) 정렬 텍스트 줄에 하이라이트를 걸어도 그 줄의 `data-align`/`style.textAlign`(및 role color)이 보존되고, hl 세그먼트는 정렬 줄 안에서 정상 span 렌더된다.
   - **기존 회귀**: 타이핑 안정성·Ctrl+D·Enter 분할·임베드 삭제·색상·정렬 기존 테스트 green.
3. 아키텍처 체크: 렌더가 `spellHighlights` prop을 직접 읽지 않고 `highlightSnapRef`만 읽음. 하이라이트가 `lastEmittedRef`/`embedSig`/`alignSig`에 영향 없음. `onTextChange`/직렬화를 하이라이트 렌더·클리어가 호출하지 않음. `InlineEmbed` 미변경. ADR-003(서버 호출 미추가)·CLAUDE.md(DB 무관·client 전용·UTF-8).
4. 결과에 따라 `phases/39-editor-spell-highlight/index.json`의 step1을 업데이트(성공 → completed + summary / 3회 실패 → error / 개입 필요 → blocked).

## 금지사항

- 렌더에서 `spellHighlights` prop을 직접 읽지 마라(반드시 `highlightSnapRef.current`). 이유: 타이핑 중 부모 재렌더가 편집 div 자식(span)을 브라우저 변형 DOM과 child-diff → removeChild 크래시·캐럿 소실(파일 상단 CRITICAL).
- 하이라이트 유무/내용을 `lastEmittedRef`·`embedSig`·`alignSig`에 반영하지 마라. 이유: 표시 신호가 텍스트/임베드/정렬 echo 판정을 오염시키면 타이핑마다 헛 remount(캐럿 점프·자동저장 유실) — phase 35 alignSig 계열 회귀.
- 하이라이트 시각 변경을 bare prop 재조정으로 하지 마라(반드시 `renderTick` remount). 이유: (위와 동일) 브라우저 변형 DOM과의 child-diff 회피.
- 하이라이트 렌더/클리어에서 `onTextChange`·`serialize`·`commitBody`를 호출하지 마라. 이유: 표시 전용 — 본문/markupVersion/undo 히스토리 오염 금지(guard 2a/#6).
- `spellHighlights`가 빌 때 span을 렌더하지 마라. 이유: 빈 경우 DOM이 오늘과 바이트 동일해야 캐럿/echo 기존 불변식이 보존된다(회귀 표면 0).
- 하이라이트 외 structural 변경(Ctrl+D/Enter/로드)의 캐럿 복원을 열-정확으로 바꾸지 마라. 이유: 기존 줄-시작 복원 계약을 바꾸면 기존 테스트/동작이 회귀한다 — 열 복원은 "하이라이트-클리어 while focused"에만.
- `buildLineHighlights`를 렌더 본문에서 호출하지 마라(오직 structural remount snapshot 시). 이유: 성능(guard 5) — 타이핑/렌더마다 재계산 금지.
- `compositionstart`(또는 조합 중 임의 경로)에서 하이라이트를 클리어하거나 remount하지 마라. 이유: 조합 중 remount는 진행 중인 글자를 유실/이중입력시킨다(news.md L176 계열) — 클리어는 `compositionend` 이후 `onTextChange`(step2 commitBody) 경로로만 일어나야 한다(위 "배경 — 안전 불변식" #5).
- `InlineEmbed`/임베드 처리를 건드리지 마라. 이유: 범위 = 텍스트 줄 하이라이트만.
- `phases/index.json`(top-level)을 수정하지 마라. 이유: 오케스트레이터 담당.
- 기존 테스트를 깨뜨리지 마라.
