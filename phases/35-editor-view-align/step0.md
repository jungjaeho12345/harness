# Step 0: align-model

보기 정렬 4종(양쪽/왼쪽/가운데/오른쪽)의 **데이터 모델과 순수 연산**을 만든다. 정렬값은 **텍스트 블록의 선택적 `align` 필드**로 저장하며, 이후 step에서 Editor가 `data-align` DOM 라운드트립으로 타이핑 후에도 보존하고(step1), WriterPage가 캐럿 줄에 결선하며(step2), 상세보기가 렌더한다(step3). 이 step은 **순수 로직만** — React/DOM 미접촉.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — view 모듈 규칙).
- `docs/news.md` L160·L183(상단 메뉴바 '보기' — 양쪽/왼쪽/가운데/오른쪽 정렬), L175(본문=텍스트/임베드 블록 구조 markupVersion, 편집-저장-불러오기 반복해도 블록 순서 보존).
- `web/src/view/editorContent.js` — **이 step에서 확장할 대상.** `textBlock`(L10~12), `embedBlock`, `isTextBlock`/`isEmbedBlock`, `normalizeBlocks`(L27~35 — 텍스트 블록에서 `{type,text}`만 남기고 알 수 없는 필드를 버린다), `serialize`/`deserialize`(L37~59), `blocksToText`(L62~64), `END_MARKER`(L8).
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(L30~39 — 텍스트 줄 인덱스(임베드 제외) → blocks 배열 인덱스, 범위밖이면 -1). **재사용 대상.**
- `web/src/view/editorGlyph.js` 또는 `web/src/view/editorEditOps.js` — 기존 순수 헬퍼 모듈의 구조/테스트 패턴(신규 `editorAlign.js`를 이 패턴으로 만든다). 있으면 참조.

## 배경 (자기완결)

본문은 블록 배열 `[{type:'text',text}, {type:'embed',...}, ...]`로 다뤄지고, `serialize`가 `{format:'yh-editor',version:1,blocks:[...]}` JSON 문자열(=`markupVersion`)로 직렬화한다. **핵심 제약**: 현재 `normalizeBlocks`는 텍스트 블록을 `{ type:'text', text:String(...) }`로만 재구성해 **다른 필드를 전부 버린다**. 따라서 `align`을 블록에 얹으려면 `normalizeBlocks`(와 `textBlock` 팩토리)가 이를 **보존**하도록 확장해야 한다. 그래야 `serialize`/`deserialize`·저장(`markupVersion`은 백엔드가 VARCHAR로 verbatim 저장하므로 클라이언트가 보존하면 DB 라운드트립도 자동 생존)에서 정렬이 살아남는다.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 1) `web/src/view/editorContent.js` — `align` 필드 보존

- 화이트리스트 상수를 export한다: `export const ALIGN_VALUES = ['left', 'center', 'right', 'justify'];`
- 검증 헬퍼를 export한다: `export function isValidAlign(v) { return ALIGN_VALUES.includes(v); }`
- `textBlock(text = '', align)` 확장 — **유효한 align만 필드로 넣고, 무효/부재면 필드 자체를 생략**한다:

  ```js
  export function textBlock(text = '', align) {
    const block = { type: 'text', text: String(text ?? '') };
    if (isValidAlign(align)) block.align = align;
    return block;
  }
  ```

- `normalizeBlocks`의 텍스트 분기(L31)를 동일 규칙으로 확장한다: `isTextBlock(b)`일 때 `{ type:'text', text:String(b.text ?? '') }`를 만들되 `isValidAlign(b.align)`이면 `align`을 얹는다(무효/부재면 생략). 임베드 분기(L32 `{ ...b, type:'embed' }`)는 **변경하지 마라**.

**못박음**: 부재/무효 정렬은 `align: undefined`가 아니라 **키 자체를 생략**하라. 이유: 미정렬 블록이 `{type,text}` 그대로 유지되어야 (a) 레거시/기존 저장본과 직렬화가 바이트 동일(하위호환·회귀), (b) step1의 `alignSig`(정렬 서명) 비교가 안정적이다.

### 2) 신규 `web/src/view/editorAlign.js` — 순수 연산

- 메뉴 id → 정렬값 매핑을 export한다:

  ```js
  export const ALIGN_BY_MENU = {
    'view.justify': 'justify',
    'view.alignLeft': 'left',
    'view.alignCenter': 'center',
    'view.alignRight': 'right',
  };
  ```

- 캐럿 줄(텍스트 줄 인덱스, 임베드 제외)에 정렬을 설정하는 순수 함수를 export한다:

  ```js
  // 대상 텍스트 줄 블록에만 align을 설정한 새 blocks와 changed를 반환한다.
  // - textLineIndex는 '텍스트 줄' 순번(임베드 제외) — writerBody.textLineToBlockIndex로 blocks 인덱스로 환산.
  // - 범위 밖(-1)·무효 align·기존 값과 동일 → { blocks: <원본 정규화>, changed: false } no-op.
  // - 임베드/다른 텍스트 줄/"(끝)" 마커는 절대 건드리지 않는다.
  export function setLineAlign(blocks, textLineIndex, align) { /* ... */ }
  ```

  구현 지침: `normalizeBlocks`로 입력을 정규화 → `textLineToBlockIndex(list, textLineIndex)`로 대상 인덱스 산출 → `isValidAlign(align)` 아니거나 인덱스 < 0 이면 `{ blocks: list, changed: false }` → 대상 블록의 현재 `align`이 이미 `align`과 같으면 `{ blocks: list, changed: false }`(불필요 dirty 방지) → 아니면 대상 인덱스만 `textBlock(list[i].text, align)`로 교체한 새 배열 반환 `{ blocks: next, changed: true }`. `writerBody.js`에서 `textLineToBlockIndex`를, `editorContent.js`에서 `normalizeBlocks`·`textBlock`·`isValidAlign`을 import한다.

### 테스트

`web/src/view/editorContent.test.js`(기존) 보강 + `web/src/view/editorAlign.test.js`(신규):

- `normalizeBlocks`: `{type:'text',text:'a',align:'center'}` → align 보존; `align:'bogus'` → align 제거; align 없음 → `{type,text}` 그대로; 임베드 블록 무변경.
- `serialize`→`deserialize` 라운드트립: align 보존. 미정렬 블록 직렬화에 `align` 키가 **없음**(문자열 단언).
- `textBlock('x','right')` → `{type:'text',text:'x',align:'right'}`; `textBlock('x')`/`textBlock('x','bad')` → `{type:'text',text:'x'}`(align 키 없음).
- `ALIGN_BY_MENU`: 4개 매핑 정확.
- `setLineAlign`:
  - 임베드가 섞인 blocks에서 텍스트 줄 인덱스 2에 'center' 설정 → 그 텍스트 블록만 align, 임베드·다른 줄 무변경, `changed:true`.
  - 범위 밖 인덱스 → `changed:false`, 원본 동등.
  - 이미 'center'인 줄에 'center' 재설정 → `changed:false`.
  - 무효 align('bad') → `changed:false`.
  - 'left'도 유효값 — 미정렬 줄에 'left' 설정 → `changed:true`, align:'left' 저장.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(순수 클라이언트 로직 — 백엔드 무관. `npm test`는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `editorAlign.js`가 순수 함수만 담고 React/DOM/transport에 의존하지 않는가?(ADR-003)
   - `editorContent.js`의 임베드 분기·`serialize`/`deserialize` 시그니처가 불변인가?(기존 테스트 그린)
   - CLAUDE.md 규칙(DB 무관·client 전용·UTF-8)?
3. 결과에 따라 `phases/35-editor-view-align/index.json`의 step0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (ALIGN_VALUES·isValidAlign·textBlock/normalizeBlocks align 보존·editorAlign.setLineAlign/ALIGN_BY_MENU·테스트 수)를 한 줄 요약. **다음 step이 import 경로와 시그니처를 알 수 있게 담아라.**
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 35 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- 부재/무효 align을 `align: undefined`로 넣지 마라. 이유: 미정렬 블록이 `{type,text}`에서 벗어나면 기존 저장본과 직렬화가 달라져 하위호환·회귀가 깨지고 step1 `alignSig`가 불안정해진다.
- `normalizeBlocks`의 임베드 분기를 바꾸지 마라. 이유: 임베드 필드 보존은 이 phase 범위 밖이며 회귀 표면만 키운다.
- `setLineAlign`에서 임베드나 대상 외 텍스트 줄을 재배열/변경하지 마라. 이유: 본문 블록 순서 보존(news.md L175)·데이터 무결성.
- Editor.jsx·WriterPage.jsx·articleDetail.js를 이 step에서 건드리지 마라. 이유: 이 step은 순수 모델/로직 레이어만 — 렌더·결선은 step1~3.
- 기존 테스트를 깨뜨리지 마라.
