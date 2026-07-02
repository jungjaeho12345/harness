# Step 0: abbrev-store-convert-dialog — 약어 영속 모듈 + 치환 순수 함수 + 약어관리 다이얼로그

## 배경 / 요구사항

에디터 **도구 메뉴 '약어변환'(`tools.abbrConvert`)·'약어관리'(`tools.abbrManage`)** (news.md L182)는 현재 `web/src/view/EditorMenuBar.jsx`에 **id·라벨이 실존하나 disabled placeholder**로 결선돼 있지 않다. 이 phase는 둘을 결선한다:

1. **약어관리(`tools.abbrManage`)** — 약어(짧은형 → 확장형) 목록을 CRUD 하는 다이얼로그. localStorage 영속.
2. **약어변환(`tools.abbrConvert`)** — **수동** 액션. 등록된 약어를 현재 기사 본문에서 확장형으로 치환한다(본문 transform).

이 step(Step 0)은 **결선 없이** 세 개의 순수/표시 레이어 모듈과 테스트·CSS만 만든다(결선은 Step 1, `WriterPage.jsx`·`Editor.jsx`·`EditorMenuBar.jsx` 미접촉):

1. **`web/src/view/abbrevStore.js`** — 약어 목록(`{ short, long }[]`)의 **순수 load/save/normalize**(localStorage, graceful 폴백). DOM/React 비의존.
2. **`web/src/view/abbrevConvert.js`** — **치환 의미론 순수 함수 2개**: 문자열 단위 `expandAbbrev(text, pairs)` + 블록 단위 `expandAbbrevInBlocks(blocks, pairs)`. DOM/React/localStorage 비의존.
3. **`web/src/view/AbbrevManageDialog.jsx`** — **controlled** 목록 CRUD 다이얼로그(약어 추가 폼 + 목록 + 삭제). 커밋된 목록은 부모(Step 1)가 소유하고, 미커밋 입력값만 내부 state로 둔다(ADR-003).

> **⚠️ 이번 scope 밖(DEFER)** — 아래는 이 phase에서 만들지 마라:
> - **자동 키 인터셉트(타이핑 중 약어 자동 확장)**: `Editor.jsx` 키핸들러 변경이 필요하므로 별도 phase. 이번엔 **관리 다이얼로그 + 수동 변환 액션만**.
> - **공용약어**(환경설정 '공용약어 사용안함' 토글, news.md L189): 사용자 등록 약어만 다룬다.

news.md에는 항목명만 있고 세부 동작 명세가 없다 → 자기완결 최소 기능으로 정의한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC(View=순수/표시), DB 비파괴, 명령어(`npm run test:web`/`build`/`lint`).
- `/docs/ADR.md` — **ADR-003**(순수 표시 컴포넌트, transport 비의존, props 주입).
- `/docs/news.md` — L182(도구 메뉴 '약어변환'/'약어관리'), L189(공용약어 — **이번 scope 밖**, 참조만).
- `web/src/view/memoStore.js` — **영속 모듈 실측 기준(가장 최근·가장 단순)**: 전용 `STORAGE_KEY`, `try/catch` + `JSON.parse(globalThis.localStorage?.getItem(...))` graceful 읽기, `globalThis.localStorage?.setItem`, localStorage 불가 시 no-op. **단 memoStore는 단일 문자열**이고 abbrevStore는 **`{ short, long }[]` 배열 + normalize**가 추가된다.
- `web/src/view/editorPrefs.js` — `readAll`의 `JSON.parse` try/catch + 폴백, `loadEditorPrefs`의 방어적 정규화(형식 안 맞으면 기본값), `setEditorPref`의 **입력 mutate 금지 순수 병합** 패턴. **STORAGE_KEY 명명 규칙**(`yh.editorPrefs`) 참고 — abbrevStore는 충돌 없는 **전용 키 `yh.editorAbbrevs`**를 쓴다.
- `web/src/view/editorGlyph.js`, `web/src/view/editorDate.js` — **블록 순수 헬퍼 실측 기준**: `normalizeBlocks`로 정규화, 입력 blocks mutate 금지(새 배열), **임베드·"(끝)" 마커 불변**(`END_MARKER` 비교로 "(끝)" 블록 보존), `import { ... } from './editorContent.js'`. `expandAbbrevInBlocks`도 이 규칙(임베드/"(끝)" 보존)을 따른다.
- `web/src/view/editorContent.js` — `textBlock`/`isTextBlock`/`isEmbedBlock`/`normalizeBlocks`/`END_MARKER`(`'(끝)'`)/`blocksToText`. `expandAbbrevInBlocks`가 텍스트 블록만 변환하고 임베드·"(끝)"는 통과시키는 데 쓴다.
- `web/src/view/EditorPrefsDialog.jsx`(L138~159, L515~562) — **목록 CRUD 다이얼로그 실측 기준**: `addGlyphKey`(두 입력 트림→둘 중 하나라도 비면 no-op→목록에 push→입력 클리어), `removeGlyphKey`(index filter), 목록 렌더(`key={`${m.keys}-${m.glyph}-${i}`}`, `span` 표시 + '삭제' 버튼). `AbbrevManageDialog`도 동형이되 **커밋 목록은 부모 소유(controlled)**로 두고 콜백(`onAdd`/`onRemove`)만 위임한다.
- `web/src/view/MemoDialog.jsx`, `web/src/view/GlyphInputDialog.jsx`, `web/src/view/FileInfoDialog.jsx` — **다이얼로그 템플릿**: `open` false→`null`, `role="dialog"`+`aria-label`, 전용 className/testid, `handleKeyDown`의 **Escape만 닫기**, '닫기' 버튼, 콜백 미전달 가드. `AbbrevManageDialog`는 이 골격에 **추가 폼(입력 2개+추가) + 목록(삭제)**을 더한다.
- `web/src/view/UrlEmbedDialog.jsx` — 내부 입력 state를 갖는 다이얼로그 참고. **주의**: UrlEmbedDialog는 Enter로 submit 하지만, `AbbrevManageDialog`는 **Enter를 가로채지 않는다**(추가는 '추가' 버튼 클릭으로만, Escape만 닫기 — 아래 핵심 규칙 6).
- `web/src/view/memoStore.test.js`, `web/src/view/FileInfoDialog.test.jsx`, `web/src/view/GlyphInputDialog.test.jsx` — 테스트 컨벤션(`beforeEach` `localStorage.clear()`, `getByRole('dialog', { name })`, Esc/닫기 콜백 mock, 콜백 미전달 graceful, 한글 `describe`/`it`).
- `web/src/styles/yonhap.css`(약 L1114 `.yh-editor-memo` 인근) — 다이얼로그 스타일 위치. `yh-abbrev-manage` 스타일을 `yh-editor-memo`/`yh-file-info` 인근에 추가한다.

## 작업

TDD로 진행한다(vitest). **각 모듈마다 테스트 먼저** 작성하고 통과하는 구현을 만든다.

### 1) abbrevStore.js — 순수 load/save/normalize (테스트 먼저: `abbrevStore.test.js`)

```js
// 사용자 등록 약어(짧은형→확장형) 영속 — client localStorage 전용(서버 무관). editorDraft/editorPrefs와 동일한
// graceful 패턴(접근 불가/parse 실패/형식오류 → 빈 목록/no-op). DOM/React 비의존. 기사 본문과 무관.
const STORAGE_KEY = 'yh.editorAbbrevs';

// 목록을 { short, long }[] 로 정규화(순수). 비배열 → []. 각 항목: short/long을 String 트림, short 빈값이면 제외.
// long 빈값(트림 후 '')도 제외한다(빈 확장형은 무의미·오삭제 위험). 알 수 없는 형태(문자열/누락)는 버린다. 입력 mutate 금지.
export function normalizeAbbrevs(list) { ... }

// 저장된 약어 목록을 { short, long }[] 로 반환. 부재/파싱 실패/형식오류 → []. throw 금지.
export function loadAbbrevs() { ... }

// 목록을 normalize 후 JSON.stringify 해 저장. localStorage 불가 시 no-op(throw 금지). 반환: 저장한 정규화 목록.
export function saveAbbrevs(list) { ... }
```

요구사항:
- **전용 키 `yh.editorAbbrevs`** — `yh.editorPrefs`/`yh.editorDrafts`/`yh.columnConfig`/`yh.editorMemo`/`yh.pendingEdit`/`yh.pendingNew`/`yh.sessionId` 등 기존 키와 겹치지 않는다.
- `normalizeAbbrevs(list)`: `Array.isArray` 아니면 `[]`. 각 원소가 객체이고 `s = String(short ?? '').trim()`·`l = String(long ?? '').trim()` 둘 다 `!== ''`일 때만 `{ short: s, long: l }`로 채택. 그 외(문자열/누락/빈값) 제외. **입력 배열/원소를 mutate 하지 않는다**(새 배열/새 객체).
- `loadAbbrevs()`: `JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY))` 후 `normalizeAbbrevs`. `try/catch`로 parse 실패/접근 불가 시 `[]`.
- `saveAbbrevs(list)`: `normalizeAbbrevs(list)` → `JSON.stringify` 저장. `try/catch`로 localStorage 불가 시 no-op. **정규화된 목록을 반환**한다(부모가 state에 그대로 반영할 수 있게 — editorPrefs.saveEditorPrefs가 prefs를 돌려주는 것과 동형).
- 세 함수 모두 **순수 로직 + localStorage 접근만** — `window`/`document`/`Date`/`fetch`/model 호출 금지.
- **중복 short 허용**(dedupe 강제 안 함) — 목록에 같은 short가 둘 있어도 저장/로드는 그대로. (변환 시 tie-break은 `expandAbbrev`가 정의.)

### 2) abbrevConvert.js — 치환 의미론 순수 함수 (테스트 먼저: `abbrevConvert.test.js`)

```js
// 약어 치환 순수 계산 — 등록된 약어(짧은형→확장형)를 텍스트에서 확장한다. DOM/window/transport/React/localStorage 비의존.
// CRITICAL: 부분문자열 오확장을 막는 "단어경계 가드 + 최장일치 우선 + 단일 좌→우 스캔" 의미론을 정확히 지킨다(아래 규칙).
import {
  textBlock, isTextBlock, normalizeBlocks, END_MARKER,
} from './editorContent.js';

// 문자열 text 안의 약어를 확장한 새 문자열을 반환. pairs: { short, long }[].
export function expandAbbrev(text, pairs) { ... }

// 블록 배열의 각 "텍스트 블록"에 expandAbbrev를 적용한 새 블록 배열을 반환. 임베드·"(끝)" 블록은 불변.
// 반환: { blocks, changed } — changed는 어느 블록이라도 text가 바뀌었는지(부모가 no-op 판정에 사용).
export function expandAbbrevInBlocks(blocks, pairs) { ... }
```

#### `expandAbbrev(text, pairs)` — 치환 의미론 (반드시 이대로, 위반 시 반려)

`text`는 `String(text ?? '')`로 강제한다. 후보(candidate) 목록을 이렇게 만든다:
1. `pairs`가 배열이 아니면 그대로 반환(text). 각 원소에서 `short = String(p.short ?? '')`, `long = String(p.long ?? '')`. `short === ''`인 항목은 제외(방어 — 정상 입력은 store가 이미 트림·필터).
2. **최장일치 우선(longest-match-first)**: 후보를 `short.length` **내림차순**으로 정렬한다. 길이가 같으면 **원배열 순서 유지**(JS `Array.prototype.sort`는 안정 정렬 — 먼저 등록된 것이 tie에서 우선). 이로써 겹치는 short('US'/'USA')는 긴 쪽이 이긴다.
3. **단일 좌→우 스캔**(반복 replace-all 금지 — 확장형 안에 다른 short가 있어도 재확장되지 않게):
   - 위치 `i`를 0부터 증가. 각 `i`에서 정렬된 후보를 순서대로 보며 **경계 유효한 최초 매치**를 찾는다:
     - `text.startsWith(short, i)`이고 아래 **경계 규칙**을 만족하면 매치.
   - 매치되면 출력에 `long`을 이어붙이고 `i += short.length`(치환 결과는 재스캔하지 않음). 매치 없으면 `text[i]`를 이어붙이고 `i += 1`.
4. **경계 규칙**(부분문자열 오확장 차단): `WORD_CHAR = /[\p{L}\p{N}_]/u`(유니코드 문자/숫자/밑줄), `isWordChar(ch) = 문자열이고 WORD_CHAR.test(ch)`.
   - **왼쪽 경계 OK** ⇔ `i === 0` **또는** `!isWordChar(text[i-1])` **또는** `!isWordChar(short[0])`.
   - **오른쪽 경계 OK** ⇔ `j === text.length`(j = i+short.length) **또는** `!isWordChar(text[j])` **또는** `!isWordChar(short[short.length-1])`.
   - 즉 **short의 양끝이 단어문자일 때만** 인접 단어문자와 붙는 것을 막는다. short가 구두점 등 비단어문자로 시작/끝나면 그쪽 경계는 무조건 통과.
5. **대소문자 구분(case-sensitive)** — 'US' ≠ 'us'. (대소문자 무시는 이번 scope 밖.)

> **의도된 보수성(문서화 필수)**: 이 규칙은 **오확장(false positive)을 확실히 막는 대신, 조사·접미가 붙은 형태는 확장하지 않는다**. 예) short '정부' → '행정부'(앞이 '정') 미확장(정확), '정부가'(뒤가 '가') **미확장**(보수적). 뉴스 편집에서 본문 파손(오확장)이 미확장보다 위험하므로 안전 우선을 택한다. 조사 결합 확장이 필요하면 사용자가 해당 형태를 별도 등록하거나 조사 앞에서 변환한다. 이 트레이드오프를 `abbrevConvert.js` 상단 주석에 명시한다.

#### `expandAbbrevInBlocks(blocks, pairs)`

- `normalizeBlocks(blocks)`로 정규화한다.
- 각 블록: **텍스트 블록**이고 `String(block.text).trim() !== END_MARKER`이면 `textBlock(expandAbbrev(block.text, pairs))`로 교체. **임베드 블록·"(끝)" 블록은 그대로 통과**(불변).
- `changed`: 원 텍스트와 다른 블록이 하나라도 있으면 `true`, 아니면 `false`.
- **입력 blocks를 mutate 하지 않는다**(새 배열/새 textBlock만). 블록 순서·개수·임베드·"(끝)" 불변.

### 3) AbbrevManageDialog.jsx — controlled 목록 CRUD 다이얼로그 (테스트 먼저: `AbbrevManageDialog.test.jsx`)

```jsx
// 약어 관리 다이얼로그 — 순수 표시/CRUD(controlled) 컴포넌트(ADR-003).
// 커밋된 약어 목록(items)·영속·표시여부는 부모(Step 1 WriterPage)가 소유한다 — 내부 state는 "미커밋 입력 2개"뿐.
// 전용 yh-abbrev-manage/abbrev-manage className·testid로 다른 다이얼로그와 충돌 방지.
export function AbbrevManageDialog({
  open,
  items = [],   // { short, long }[] — 부모 소유(커밋된 목록)
  onAdd,        // (short, long) => void — '추가' 클릭 시(둘 다 비면 no-op)
  onRemove,     // (index) => void — 행 '삭제' 클릭 시
  onClose,      // () => void — '닫기'/Esc
}) { ... }
```

요구사항:
- `open`이 false면 `null` 반환.
- `role="dialog"`, `aria-label`(예 '약어 관리'), **전용 className `yh-abbrev-manage`·testid `abbrev-manage`**. 기존 `yh-editor-memo`/`yh-file-info`/`yh-glyph-input`/`yh-url-embed`/`yh-find-replace`/`yh-editor-glyphbar`와 충돌 금지.
- **추가 폼**: 짧은형 입력(testid 예 `abbrev-manage-short`) + 확장형 입력(`abbrev-manage-long`) + '추가' 버튼(`abbrev-manage-add`). 각 입력은 **내부 state**(`shortInput`/`longInput`). '추가' 클릭 → 트림한 두 값이 **둘 다 비지 않으면** `onAdd(short, long)` 호출 후 두 입력 클리어(EditorPrefsDialog `addGlyphKey`와 동형). 하나라도 비면 no-op.
- **목록**: `items`를 순회해 각 행에 `short → long` 표시 + '삭제' 버튼(testid `abbrev-manage-remove-{i}`, 행 testid `abbrev-manage-item-{i}`). 리스트 testid `abbrev-manage-list`. `key`는 `` `${it.short}-${it.long}-${i}` ``(중복 대비 index 포함).
- **'닫기' 버튼**(testid `abbrev-manage-close`) → `onClose`. **Esc** → `onClose`(컨테이너 `onKeyDown`에서 `e.key === 'Escape'`만).
- `onAdd`/`onRemove`/`onClose` 미전달 시 모두 가드(예외 금지).
- model/fetch/transport/localStorage/`window`/`document`/`Date` 호출 금지. `abbrevStore`/`abbrevConvert`를 import 하지 않는다(영속·치환은 부모/다른 모듈의 몫).
- CSS: `yh-abbrev-manage` 떠있는 패널을 `yh-editor-memo` 인근에 추가(기존 스타일 미파손).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **치환 의미론 정확성**: `expandAbbrev`는 위 "단어경계 가드 + 최장일치 우선 + 단일 좌→우 스캔 + case-sensitive" 규칙을 정확히 구현한다. 특히 **부분문자열 오확장 금지**(short '정부'는 '행정부' 안에서 치환되면 안 됨)와 **확장형 재확장 금지**(long 안에 short가 있어도 다시 확장 안 함). 이유: 본문 파손(오확장)은 발행 기사 무결성 사고다.
2. **임베드·"(끝)" 불변**: `expandAbbrevInBlocks`는 임베드 블록과 "(끝)"(`END_MARKER`) 텍스트 블록을 절대 바꾸지 않는다(editorGlyph/editorDate와 동일 불변식). 이유: "(끝)"은 송고 게이트 마커, 임베드는 첨부 — 치환 대상이 아니다.
3. **입력 mutate 금지(순수성)**: `normalizeAbbrevs`/`expandAbbrev`/`expandAbbrevInBlocks`는 입력을 변형하지 않고 새 값을 반환한다. 이유: 순수 함수는 테스트·재사용·예측이 쉽다(ADR 철학).
4. **전용 localStorage 키 `yh.editorAbbrevs`**: 기존 키(`yh.editorPrefs`/`yh.editorDrafts`/`yh.editorMemo`/`yh.columnConfig` 등)를 읽거나 쓰지 마라. 이유: 기존 설정/초안/메모 오염 방지(DB 비파괴 정신을 클라이언트 저장소에도 적용).
5. **안전 폴백**: `loadAbbrevs`는 부재/parse 실패/형식오류에 `[]`를 반환하고 throw 하지 않는다. `saveAbbrevs`는 localStorage 불가 시 no-op. 이유: localStorage 미지원/프라이빗 모드에서도 앱이 죽지 않아야 한다.
6. **다이얼로그 순수성·Enter 미인터셉트**: `AbbrevManageDialog`는 커밋 목록에 내부 state를 두지 않는다(controlled — 목록은 props). 내부 state는 미커밋 입력 2개뿐. `handleKeyDown`은 **Escape만** 처리(Enter로 추가/닫기 하지 마라). 이유: 값/영속은 부모 소유(결선 레이어 분리), 실수로 Enter가 다이얼로그를 닫거나 예기치 않게 추가하는 UX 혼선 방지.
7. **전용 className/testid**: `yh-abbrev-manage`/`abbrev-manage`. 파일정보/약물입력/URL임베드/찾기/메모/약물바와 겹치지 마라. 이유: 회귀·스타일 충돌 방지.

## Acceptance Criteria

```bash
npm run test:web -- abbrevStore        # 신규 abbrevStore.test.js 통과
npm run test:web -- abbrevConvert      # 신규 abbrevConvert.test.js 통과
npm run test:web -- AbbrevManageDialog # 신규 AbbrevManageDialog.test.jsx 통과
npm run test:web                       # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest):

`abbrevStore.test.js` (`beforeEach`에서 `localStorage.clear()`):
- `loadAbbrevs()`가 저장 전 `[]`.
- `saveAbbrevs([{ short: 'US', long: 'United States' }])` 후 `loadAbbrevs()`가 같은 목록(왕복).
- 저장 키가 `yh.editorAbbrevs`(non-null)이고, 미리 넣어둔 `yh.editorPrefs`/`yh.editorMemo`가 **미오염**(memoStore.test 패턴).
- 잘못된 값(`localStorage.setItem('yh.editorAbbrevs', '{{{')`)이 있어도 `loadAbbrevs()`가 `[]`이고 throw 안 함.
- 비배열 저장(`JSON.stringify(123)`) → `loadAbbrevs()` `[]`.
- `normalizeAbbrevs`/`saveAbbrevs`가 잡동사니를 버린다: `[{short:'A',long:'B'},{short:'',long:'X'},{short:'C'},{foo:1},'str',null]` → `[{short:'A',long:'B'}]`(빈 short·빈 long·비객체 제거).
- 트림: `saveAbbrevs([{short:'  US  ',long:' 미국 '}])` → `[{short:'US',long:'미국'}]`.
- `saveAbbrevs(null)`/`undefined`/비배열이 throw 안 하고 `[]` 반환.

`abbrevConvert.test.js`:
- `expandAbbrev('x', [])` → `'x'`(빈 목록 그대로). `expandAbbrev('x', undefined)` → `'x'`.
- 기본 확장: `expandAbbrev('정부 발표', [{short:'정부',long:'대한민국 정부'}])` → `'대한민국 정부 발표'`.
- **재확장 금지(anti-cascade)**: 위 결과의 long 안에 '정부'가 있어도 재확장되지 않는다(한 번만 확장).
- **부분문자열 오확장 차단(왼쪽)**: `expandAbbrev('행정부 개편', [{short:'정부',long:'X'}])` → `'행정부 개편'`(불변).
- **보수적 미확장(오른쪽 조사)**: `expandAbbrev('정부가', [{short:'정부',long:'X'}])` → `'정부가'`(불변, 의도된 보수성).
- **구두점 경계 확장**: `expandAbbrev('(정부)', [{short:'정부',long:'X'}])` → `'(X)'`.
- **최장일치 우선**: `expandAbbrev('USA 발표', [{short:'US',long:'United States'},{short:'USA',long:'미국'}])` → `'미국 발표'`.
- **양쪽 독립 확장**: `expandAbbrev('US and USA', [{short:'US',long:'United States'},{short:'USA',long:'미국'}])` → `'United States and 미국'`.
- **case-sensitive**: `expandAbbrev('us', [{short:'US',long:'X'}])` → `'us'`(불변).
- **순서 독립·단일 스캔**: `expandAbbrev('A B', [{short:'A',long:'B'},{short:'B',long:'C'}])` → `'B C'`(첫 'A'→'B'가 다시 'C'로 되지 않음).
- **다중 발생**: `expandAbbrev('정부 정부', [{short:'정부',long:'X'}])` → `'X X'`.
- `expandAbbrevInBlocks`: `[textBlock('정부'), <embed>, textBlock('정부')]` + `[{short:'정부',long:'X'}]` → 텍스트 블록만 `'X'`로, **임베드 블록 동일(참조/내용 보존)**, `changed === true`.
- `expandAbbrevInBlocks`가 **"(끝)" 블록 불변**: `[textBlock('정부'), textBlock('(끝)')]` + `[{short:'정부',long:'X'}]` → `[textBlock('X'), textBlock('(끝)')]`. 또 `[{short:'끝',long:'Z'}]`로도 `'(끝)'` 블록은 안 바뀐다.
- `expandAbbrevInBlocks`가 빈 목록/텍스트 블록 없음이면 `changed === false`. **입력 blocks를 mutate 하지 않는다**(원본 배열/객체 불변 단언).

`AbbrevManageDialog.test.jsx`:
- `open={false}`면 `container.firstChild === null`.
- `open` 시 `role="dialog"`('약어 관리')·testid `abbrev-manage`·입력 2개·'추가'·'닫기'가 보인다.
- `items=[{short:'US',long:'미국'}]`이면 `US → 미국` 행과 삭제 버튼(`abbrev-manage-remove-0`)이 보인다.
- 짧은형·확장형 입력 후 '추가' 클릭 → `onAdd`가 `('US','미국')`(트림값)로 호출되고 이후 두 입력이 비워진다(내부 state 클리어).
- 짧은형만/확장형만 입력하고 '추가' → `onAdd` **미호출**(no-op).
- 행 '삭제'(`abbrev-manage-remove-0`) 클릭 → `onRemove(0)` 호출.
- '닫기' 클릭·Esc → `onClose` 호출. Enter 키는 `onAdd`/`onClose`를 **호출하지 않는다**.
- `onAdd`/`onRemove`/`onClose` 미전달 시 추가/삭제/닫기/Esc가 예외를 던지지 않는다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1` 또는 UTF-8 콘솔).
2. 아키텍처 체크리스트: `abbrevStore` 전용 키(`yh.editorAbbrevs`)·graceful·순수; `expandAbbrev` 경계/최장일치/단일스캔/case-sensitive 정확·입력 mutate 없음; `expandAbbrevInBlocks` 임베드/"(끝)" 불변; `AbbrevManageDialog` controlled(내부 state=입력2개만)·Enter 미인터셉트·전용 className/testid.
3. 결과에 따라 `phases/23-editor-abbrev/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- `WriterPage.jsx`·`Editor.jsx`·`EditorMenuBar.jsx`·`EditorToolBar.jsx`·`server/`·DB를 수정하지 마라(이 step은 신규 abbrevStore/abbrevConvert/AbbrevManageDialog + 테스트 + CSS만). 이유: 결선은 Step 1, Editor 미접촉, client 전용·DB 비파괴.
- `expandAbbrev`를 "pair마다 `text.split(short).join(long)` 반복"으로 구현하지 마라. 이유: (1) 부분문자열 오확장(경계 무시), (2) 확장형 재확장(cascade), (3) 적용 순서 의존이 생겨 의미론이 깨진다 — 반드시 단일 좌→우 스캔.
- 자동 키 인터셉트(타이핑 중 자동 확장)를 만들지 마라 — `Editor.jsx` 키핸들러/`onKeyDown` 확장 금지. 이유: Editor.jsx 미접촉 원칙(별도 phase로 DEFER).
- 공용약어(환경설정 `edit.noCommonAbbr`) 로직을 넣지 마라. 이유: 이번 scope는 사용자 등록 약어만.
- `AbbrevManageDialog`에 커밋 목록용 내부 `useState`·`localStorage`·`abbrevStore`/`abbrevConvert` import·model/fetch를 넣지 마라(입력 2개만 내부 state). `handleKeyDown`에서 Enter로 추가/닫기 하지 마라(Escape만). 이유: controlled 표시 컴포넌트 — 값/영속은 부모(Step 1) 소유, UX 혼선 방지.
- 기존 localStorage 키를 읽거나 쓰지 마라. 새 전용 키 `yh.editorAbbrevs`만. 이유: 기존 설정/초안/메모 오염 방지.
- `loadAbbrevs`/`saveAbbrevs`가 throw 하게 두지 마라(항상 try/catch로 폴백/no-op). 이유: localStorage 미지원 환경에서도 앱이 죽지 않아야 한다.
- 파일정보/약물입력/URL임베드/찾기/메모/약물바와 같은 className/testid를 재사용하지 마라. 이유: 회귀·스타일 충돌.
