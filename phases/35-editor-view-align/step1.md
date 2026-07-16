# Step 1: editor-roundtrip

step0의 `align` 모델을 **에디터에서 렌더하고, 타이핑 후에도 보존**한다. 정렬은 텍스트 줄 div의 `data-align` 속성 + `text-align` 스타일로 렌더하며, `readEditorBlocks`가 이 속성을 되읽어 타이핑 라운드트립에서 살린다(임베드가 `data-embed-key`로 생존하는 것과 동형). 이 step은 **`web/src/view/Editor.jsx` 한 모듈만** 변경한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003).
- `docs/news.md` L173(줄 삭제 시 동반 임베드), L175(블록 순서 보존), L176(IME 조합 중 재색칠 금지).
- `web/src/view/editorContent.js` — **step0에서 추가된** `ALIGN_VALUES`·`isValidAlign`·`textBlock(text, align)`·`normalizeBlocks`(align 보존). (step0 요약이 프롬프트에 함께 전달된다.)
- `web/src/view/Editor.jsx` — **이 step에서 변경할 대상.** 특히:
  - import(L11~15) — `blocksToText, isEmbedBlock, isTextBlock, textBlock` from `./editorContent.js`.
  - `readEditorBlocks(root, snapshotBlocks)`(L63~96) — DOM → 블록 재구성. 클린패스 분기(L87~89): `.yh-editor__line`/블록 요소를 `elementToLines`로 펼쳐 `textBlock(line)`으로 push. 임베드는 `data-embed-key`(snapshot 인덱스)로 안정 매칭(L77~83).
  - `embedSig(blocks)`(L99~101) — 임베드 서명(구조 변경 감지용).
  - 재렌더(remount) 판정 effect(L266~290) — `structural = forceRecolorRef.current || incomingText !== lastEmittedRef.current || embedSig(blocks) !== embedSig(snapRef.current)`. structural일 때만 `snapRef.current = blocks` + `setRenderTick`(remount). `renderBlocks = snapRef.current`(L312).
  - `handleInput`(L394~401) — 타이핑 반영: `readEditorBlocks` → `lastEmittedRef.current = text`(echo 기준 갱신) → `onTextChange`. 이 순서 덕에 타이핑은 structural이 아니어서 remount되지 않는다(캐럿 보존).
  - 텍스트 줄 렌더(L462~474) — `isTextBlock(block)`이면 `<div className="yh-editor__line" data-role={role} style={{ color: colorForRole(role) }}>{block.text}</div>`.
- `web/src/view/Editor.test.jsx` — 기존 렌더/타이핑 테스트 패턴(이 파일에 정렬 테스트를 추가한다).

## 배경 (자기완결 — 왜 세 가지를 다 해야 하나)

에디터는 contentEditable이고, **매 입력마다 `readEditorBlocks`가 DOM에서 블록을 재구성**한다. 텍스트 블록은 DOM 텍스트로부터 `textBlock(line)`으로 새로 만들어지므로, `align`을 블록 필드로만 저장하면 **타이핑 순간 유실**된다(임베드는 `data-embed-key`로 snapshot에서 되살아나 생존). 따라서 정렬을 살리려면 정렬도 DOM에 실어(`data-align`) 되읽어야 한다. 또한 재렌더 판정이 텍스트·임베드 변화만 보므로, **정렬만 바뀐 변경은 remount되지 않아 화면에 반영되지 않는다** → 서명에 정렬을 추가해야 한다.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### A) 텍스트 줄 렌더 (L462~474) — `data-align` + `text-align`

`isValidAlign`을 `./editorContent.js`에서 import한다. 화이트리스트를 통과한 값만 렌더에 쓴다(step3와 방어 깊이 통일). 텍스트 줄 div를 다음처럼 확장한다(미정렬/무효면 속성/스타일 **생략**):

```jsx
const align = isValidAlign(block.align) ? block.align : undefined;
// ...
<div
  key={`text-${i}`}
  className="yh-editor__line"
  data-role={role}
  data-align={align}
  style={{ color: colorForRole(role), ...(align ? { textAlign: align } : null) }}
>
  {block.text}
</div>
```

`data-align={undefined}`는 속성이 렌더되지 않는다(미정렬 줄은 현행과 DOM 동일 — 회귀 안전).

### B) `readEditorBlocks` 클린패스 (L87~89) — `data-align` 되읽기

클린패스 분기에서 요소의 `data-align`을 화이트리스트로 읽어 **첫 줄에만** 승계한다:

```js
} else if ((el.classList && el.classList.contains('yh-editor__line')) || BLOCK_TAGS.has(el.tagName)) {
  flush();
  const a = (el.dataset && isValidAlign(el.dataset.align)) ? el.dataset.align : undefined;
  const lines = elementToLines(el);
  lines.forEach((line, idx) => out.push(textBlock(line, idx === 0 ? a : undefined)));
}
```

**못박음**: 클린 케이스(`.yh-editor__line` 1요소=1줄)에선 `elementToLines`가 1줄을 반환하므로 그 줄에 정렬이 승계된다. dirty 케이스(브라우저가 Enter/붙여넣기로 만든 중첩 → 여러 줄)에선 첫 줄만 승계하고 나머지는 미정렬로 둔다 — **새로 생긴 줄은 미정렬이 정상**이다. 다른 분기(bare 텍스트노드 L74·`<br>` L84~86·인라인 L90~92)는 `textBlock(pending)`/`textBlock(pending ?? '')` 그대로 두어 미정렬(정상).

### C) 정렬 서명 추가 — remount 트리거

`embedSig`(L99~101) 옆에 정렬 서명을 추가한다:

```js
// 텍스트 블록들의 정렬 서명 — 정렬만 바뀐 변경도 remount(재렌더)시키기 위함(텍스트/임베드와 독립).
function alignSig(blocks) {
  return JSON.stringify((Array.isArray(blocks) ? blocks : []).filter(isTextBlock).map((b) => b.align || ''));
}
```

재렌더 판정 effect(L268~270)의 `structural`에 정렬 서명 비교를 **추가**한다:

```js
const structural = forceRecolorRef.current
  || incomingText !== lastEmittedRef.current
  || embedSig(blocks) !== embedSig(snapRef.current)
  || alignSig(blocks) !== alignSig(snapRef.current);
```

**왜 타이핑을 깨지 않나(못박음)**: 타이핑 시 `handleInput`이 `data-align`을 그대로 둔 DOM을 `readEditorBlocks`로 읽으므로 재구성 블록의 정렬 = snapshot 정렬 → `alignSig` 동일 → structural 아님 → remount 없음(캐럿 보존). 정렬 메뉴 클릭(step2)으로 정렬이 실제 바뀔 때만 `alignSig`가 달라져 remount되고, 그때 캐럿은 step2가 넘기는 `pendingCaretLine`으로 복원된다.

### 알려진 한계 (범위 밖 — 버그 아님, 확장 금지)

정렬된 줄 **한가운데서 Enter로 줄을 나누면** 나뉜 두 줄이 모두 미정렬이 된다. 이유: 줄 분할은 `web/src/view/editorNewline.js`의 `insertTextIntoBlocks`가 `textBlock`(정렬 인자 없음)으로 새 줄을 만들기 때문이며, **이 모듈은 이 phase에서 건드리지 않는다**(scope 최소화). 이는 "새로 생긴 줄은 미정렬이 정상"이라는 이 step의 철학과 정합하는 **의도된 한계**다 — 크래시/손상/직렬화 파손이 없고, 나눈 뒤 다시 정렬 메뉴로 지정하면 된다. tester는 이를 결함으로 반려하지 말고, 구현자는 이를 고치려 `editorNewline.js`로 scope를 넓히지 마라.

### 테스트 — `web/src/view/Editor.test.jsx`

- **렌더**: `align:'center'` 텍스트 블록을 렌더 → 해당 `.yh-editor__line`이 `data-align="center"`·`style.textAlign === 'center'`. 미정렬 블록 → `data-align` 없음·`textAlign` 비어 있음.
- **타이핑 라운드트립**: 정렬된 줄 + 다른 줄이 있는 blocks로 렌더하고, 다른 줄에 입력을 발생시켜(`onInput`) `onTextChange` 콜백이 받은 블록 배열에서 **정렬된 줄의 align이 보존**됨을 단언한다(정렬 줄의 DOM `data-align`을 브라우저가 유지 → readEditorBlocks가 되읽음). jsdom 한계로 실제 selection이 어려우면, 정렬 줄 div에 `data-align`을 갖춘 상태에서 `fireEvent.input`(또는 컴포넌트가 노출한 입력 경로)을 발생시켜 emit된 블록에 align이 있음을 확인하는 수준으로 잠근다.
- **정렬-only remount**: 초기 blocks 렌더 후 `rerender`로 같은 텍스트·같은 임베드에 **정렬만 바뀐** blocks를 넘기면 해당 줄 DOM의 `textAlign`/`data-align`이 갱신됨을 단언(= `alignSig`가 structural을 태워 snapshot 갱신). 정렬·텍스트 모두 그대로면 재렌더 없음(회귀).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test`는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 변경이 `web/src/view/Editor.jsx`(+테스트)에 **국한**되는가? editorContent.js·WriterPage.jsx·articleDetail.js가 diff에 없는가?
   - 기존 타이핑/색상/임베드/Ctrl+D/(끝) 테스트가 전부 그린인가?(정렬 추가가 텍스트·임베드 라운드트립을 오염시키지 않았는지 — 이 phase 최대 리스크 지점)
   - ADR-003 준수(서버 호출 미추가)·CLAUDE.md(DB 무관·client 전용·UTF-8)?
3. 결과에 따라 `phases/35-editor-view-align/index.json`의 step1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (렌더 data-align/textAlign·readEditorBlocks 되읽기·alignSig structural·타이핑 라운드트립 보존·추가 테스트)를 한 줄 요약.
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 35 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- 정렬을 블록 필드로만 저장하고 `data-align` 렌더/되읽기를 생략하지 마라. 이유: `readEditorBlocks`가 매 입력마다 텍스트 블록을 DOM에서 재구성하므로, DOM에 싣지 않으면 타이핑 즉시 정렬이 유실된다.
- `alignSig`를 `structural` 판정에 추가하는 것을 빠뜨리지 마라. 이유: 정렬만 바뀐 변경은 텍스트·임베드 서명이 동일해 remount되지 않아 화면에 반영되지 않는다.
- `lastEmittedRef`·`handleInput`의 emit 순서(먼저 `lastEmittedRef` 갱신 후 `onTextChange`)를 바꾸지 마라. 이유: 이 순서가 타이핑을 echo로 만들어 remount·캐럿 튐을 막는다. 정렬 추가와 무관한 회귀를 부른다.
- dirty/분할 경로(중첩 div·`<br>`)에서 정렬을 억지로 복원하려 하지 마라. 이유: 새로 생긴 줄은 미정렬이 정상이며, 여기서 좌표를 추정하면 과거 stale 좌표 버그 계열을 재현한다.
- `web/src/view/editorNewline.js`(줄 분할·붙여넣기 `insertTextIntoBlocks`)를 건드리지 마라. 이유: Enter 분할 시 정렬 승계는 '알려진 한계'로 범위 밖이다 — 이 모듈을 고치면 scope가 넘치고 타이핑/붙여넣기 회귀 표면이 커진다.
- `contentEditable` 편집 div를 매 입력마다 state로 재렌더하지 마라(파일 상단 CRITICAL 주석). 이유: 캐럿 초기화·removeChild 크래시.
- 기존 테스트를 깨뜨리지 마라.
