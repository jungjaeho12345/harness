# Step 0: simptrad-table-convert-dialog — 간↔번 변환표 데이터 + 변환 순수 함수 + 방향 선택 다이얼로그

## 배경 / 요구사항

에디터 **도구 메뉴 '간체↔번체 변환'(`tools.simpTradConvert`)** (news.md L182 '간체<->번체 변환')는 현재 `web/src/view/EditorMenuBar.jsx`(L99)에 **id·라벨이 실존하나 disabled placeholder**로 결선돼 있지 않다. 이 phase는 이를 결선한다 — 현재 기사 본문의 중국어를 간체(简体)↔번체(繁體)로 **수동** 변환한다.

이 기능은 **바로 직전 phase 23(약어변환)과 동일한 '수동 본문 transform' 패턴**을 재사용한다: 순수 변환 함수 + `*InBlocks` 블록 순회(임베드/"(끝)" 불변·원본 mutate 없음·`changed` 전후비교) + 안전 경로 `updateField('body', serialize(...))` 결선.

**방향 처리(핵심 설계 결정)**: 메뉴 id는 `tools.simpTradConvert` **하나**인데 변환은 **양방향**(간체→번체 / 번체→간체)이다. 자동 방향 감지는 문서가 두 서체를 섞을 수 있어 신뢰할 수 없다 → **작은 방향 선택 다이얼로그**를 띄워 사용자가 두 버튼('간체→번체' / '번체→간체') 중 하나를 명시 선택하게 한다(죽은 버튼 방지·직관성). 다이얼로그는 방향만 콜백으로 돌려주고, 실제 본문 변환은 부모(Step 1 WriterPage)가 안전 경로로 수행한다(ADR-003 — 표시 컴포넌트는 transport/본문 비의존).

**변환표 소스(핵심 설계 결정)**: 완전한 간↔번 표는 대형 데이터라 **새 npm 의존성(opencc-js 등)은 이번 scope 밖**이다. 대신 **번들 curated 표**(전용 데이터 모듈, 상용 한자 위주)를 쓴다. **미매핑 문자는 pass-through(원문 유지)** = 안전측 미변환(약어의 '미확장' 철학과 동일 — 오변환이 미변환보다 위험). "표는 완전하지 않음"을 코드 주석·다이얼로그 안내에 문서화한다.

**변환 의미론(핵심 설계 결정)**: 간↔번은 대체로 **문자단위 1:1 매핑**(약어의 다문자 최장일치와 달리 단순). 순수 함수 `convertSimpTrad(text, direction)`이 **코드포인트 단위**로 치환한다. 1:多 모호성(간체→번체는 한 간체가 여러 번체에 대응 — 예 发→發/髮, 后→後/后)은 v1에서 **표에 먼저 나열된 매핑(최빈)** 을 채택하고 문서화한다(번체→간체는 대체로 결정적).

이 step(Step 0)은 **결선 없이** 데이터/순수/표시 레이어 모듈과 테스트·CSS만 만든다(결선은 Step 1, `WriterPage.jsx`·`Editor.jsx`·`EditorMenuBar.jsx` 미접촉):

1. **`web/src/view/simpTradTable.js`** — 번들 간↔번 매핑 **원시 데이터**(`SIMP_TRAD_PAIRS`: `[간체, 번체]` 튜플 배열). 순수 데이터만(로직/DOM/React 없음).
2. **`web/src/view/simpTradConvert.js`** — **변환 의미론 순수 함수 2개**: 문자열 단위 `convertSimpTrad(text, direction)` + 블록 단위 `convertSimpTradInBlocks(blocks, direction)`. DOM/React/localStorage 비의존.
3. **`web/src/view/SimpTradConvertDialog.jsx`** — **방향 선택** 다이얼로그(간체→번체 / 번체→간체 버튼 + 닫기). 내부 state 없는 순수 표시 컴포넌트(ADR-003) — 방향을 `onConvert(direction)`으로 부모에 위임한다.

> **⚠️ 이번 scope 밖(DEFER)** — 아래는 이 phase에서 만들지 마라:
> - **opencc-js 등 완전 변환 라이브러리 도입**: 새 npm 의존성은 사용자 결정 사항 → 원하면 후속 phase. 이번엔 번들 curated 표만.
> - **자동 방향 감지**·문맥 기반 1:多 해소·이체자(異體字) 정규화: v1은 문자단위 최빈 매핑만.
> - **환경설정 언어(news.md L192 '중국어')·UI 언어**와의 연동.

news.md에는 항목명만 있고 세부 동작 명세가 없다 → 자기완결 최소 기능으로 정의한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC(View=순수/표시), DB 비파괴, 명령어(`npm run test:web`/`build`/`lint`, web 루트).
- `/docs/ADR.md` — **ADR-003**(순수 표시 컴포넌트, transport 비의존, props 주입).
- `/docs/news.md` — L182(도구 메뉴 '간체<->번체 변환').
- `web/src/view/abbrevConvert.js` — **⭐ 재사용 패턴 원본(필독)**: `expandAbbrevInBlocks(blocks, pairs)`가 `normalizeBlocks`로 정규화 → 텍스트 블록만 변환 → **임베드·"(끝)"(`END_MARKER`) 불변** → 입력 mutate 없음(새 배열/새 `textBlock`) → `{ blocks, changed }` 반환(원 텍스트와 다른 블록이 하나라도 있으면 `changed=true`). **`convertSimpTradInBlocks`는 이 구조를 그대로 따른다**(치환 함수만 `convertSimpTrad`로 교체). 단 abbrev의 단어경계/최장일치/좌→우 스캔은 **불필요**(간↔번은 문자단위 1:1).
- `web/src/view/editorContent.js` — `textBlock`/`isTextBlock`/`isEmbedBlock`/`normalizeBlocks`/`END_MARKER`(`'(끝)'`)/`blocksToText`. `convertSimpTradInBlocks`가 텍스트 블록만 변환하고 임베드·"(끝)"는 통과시키는 데 쓴다.
- `web/src/view/abbrevConvert.test.js` — **테스트 컨벤션 원본**: 문자열 함수 단위테스트(입력→기대 출력), `*InBlocks`의 임베드/"(끝)" 불변·`changed`·mutate 없음 단언. `simpTradConvert.test.js`도 동형으로 작성.
- `web/src/view/MemoDialog.jsx`, `web/src/view/AbbrevManageDialog.jsx` — **다이얼로그 템플릿**: `open` false→`null`, `role="dialog"`+`aria-label`, 전용 className/testid, `handleKeyDown`의 **Escape만 닫기**, '닫기' 버튼, 콜백 미전달 가드, model/fetch/localStorage/`window`/`document` 비의존. `SimpTradConvertDialog`는 MemoDialog보다 더 단순(내부 state 없음 — 입력창 없이 방향 버튼 2개 + 닫기).
- `web/src/view/MemoDialog.test.jsx` 또는 `web/src/view/AbbrevManageDialog.test.jsx` — 다이얼로그 테스트 컨벤션(`getByRole('dialog', { name })`, 버튼 클릭→콜백 mock, Esc/닫기, 콜백 미전달 graceful, 한글 `describe`/`it`).
- `web/src/styles/yonhap.css`(L1150 `.yh-abbrev-manage` 인근) — 다이얼로그 스타일 위치. `yh-simptrad-convert` 스타일을 `yh-abbrev-manage` 인근에 추가한다(기존 스타일 미파손).

## 작업

TDD로 진행한다(vitest). **각 모듈마다 테스트 먼저** 작성하고 통과하는 구현을 만든다.

### 1) simpTradTable.js — 번들 간↔번 매핑 원시 데이터

```js
// 간체(简体)↔번체(繁體) 변환표 — 번들 정적 데이터(상용 한자 위주). client 전용·서버/DB 무관.
// ⚠️ 이 표는 완전하지 않다(전체 간↔번 표는 대형 데이터이며 새 의존성 도입은 이번 scope 밖). 미등록 문자는
//    변환 시 원문이 그대로 유지된다(pass-through). 오변환이 미변환보다 위험하므로 안전측을 택한다.
// 형식: [간체, 번체] 튜플 배열 — 각 원소는 단일 CJK 문자 2개. 1:多(간체 하나가 여러 번체) 모호성은
//    먼저 나열된 매핑(최빈)이 우선한다(예: 发→發 우선, 后→後 우선). simpTradConvert가 이 배열로 두 방향 Map을 만든다.
export const SIMP_TRAD_PAIRS = [
  ['国', '國'], ['学', '學'], ['电', '電'], ['车', '車'], ['门', '門'],
  ['时', '時'], ['语', '語'], ['汉', '漢'], ['华', '華'], ['马', '馬'],
  ['见', '見'], ['长', '長'], ['东', '東'], ['说', '說'], ['会', '會'],
  // ... 상용 한자 위주로 확장(아래 요구사항의 규모/모호성 규칙을 따른다)
];
```

요구사항:
- **원시 데이터만** — 함수/Map/DOM/React/`import` 로직 없음(순수 배열 export). Map 구성은 `simpTradConvert.js`가 한다.
- 각 원소는 `[간체문자, 번체문자]` — **단일 문자 2개**(코드포인트 1개씩). 간체와 번체가 동일한(통합) 문자는 넣지 않는다(변환 불필요 → pass-through로 처리됨).
- **규모**: 상용 한자 위주로 **최소 ~150쌍 이상**(가장 흔히 다른 간↔번 문자)을 씨앗으로 채운다. 완전성은 목표가 아니며 주석에 "표 불완전·미등록 pass-through"를 명시한다. (완전 변환은 opencc 등 별도 phase.)
- **1:多 모호성**: 한 간체가 여러 번체에 대응하는 경우(예 发→發/髮, 后→後/后, 台→臺/台, 干→幹/乾) **가장 흔한 번체를 먼저 나열**한다. `simpTradConvert`의 Map 구성이 "먼저 나열된 것 우선(first-wins)"이므로 순서로 최빈 매핑을 표현한다.
- 아래 AC 테스트가 고정하는 쌍은 반드시 포함: `国↔國`, `学↔學`, `电↔電`, `车↔車`, `门↔門`, `时↔時`, `语↔語`, `汉↔漢`, `华↔華`, `马↔馬`, `见↔見`, `长↔長`, `东↔東`, `说↔說`, `会↔會`.

### 2) simpTradConvert.js — 변환 의미론 순수 함수 (테스트 먼저: `simpTradConvert.test.js`)

```js
// 간↔번 변환 순수 계산 — 본문 텍스트의 중국어를 문자단위로 치환한다. DOM/window/transport/React/localStorage 비의존.
// direction: 'toTrad'(간체→번체) | 'toSimp'(번체→간체). 그 외 값은 원문 그대로 반환(방어).
// 미매핑 문자는 원문 유지(pass-through). 표는 완전하지 않다(simpTradTable 주석 참조).
import { textBlock, isTextBlock, normalizeBlocks, END_MARKER } from './editorContent.js';
import { SIMP_TRAD_PAIRS } from './simpTradTable.js';

export const DIRECTIONS = Object.freeze({ TO_TRAD: 'toTrad', TO_SIMP: 'toSimp' });

// 문자열 text를 direction 방향으로 변환한 새 문자열을 반환.
export function convertSimpTrad(text, direction) { ... }

// 블록 배열의 각 "텍스트 블록"에 convertSimpTrad를 적용한 새 블록 배열을 반환. 임베드·"(끝)" 블록은 불변.
// 반환: { blocks, changed } — changed는 어느 블록이라도 text가 바뀌었는지(부모가 no-op 판정에 사용).
export function convertSimpTradInBlocks(blocks, direction) { ... }
```

#### `convertSimpTrad(text, direction)` — 변환 의미론 (반드시 이대로, 위반 시 반려)

1. `text`는 `String(text ?? '')`로 강제.
2. **모듈 로드 시 1회** `SIMP_TRAD_PAIRS`로 두 Map을 만든다(매 호출 재구성 금지):
   - `SIMP_TO_TRAD`: `[간, 번]`에서 key=간, value=번. **이미 있으면 덮지 않음(first-wins — 최빈 우선)**.
   - `TRAD_TO_SIMP`: key=번, value=간. 동일하게 first-wins.
3. `direction === 'toTrad'`면 `SIMP_TO_TRAD`, `'toSimp'`면 `TRAD_TO_SIMP`를 고른다. **그 외 값이면 text를 그대로 반환**(방어 — 죽지 않음).
4. **코드포인트 단위 순회**(`for (const ch of src)` 또는 `Array.from(src)` — surrogate-safe). 각 문자를 `map.get(ch) ?? ch`로 치환해 이어붙인다(**미매핑은 원문 유지**). `src[i]`/`.length` 인덱싱으로 surrogate를 쪼개지 마라.
5. **순수** — `window`/`document`/`Date`/`fetch`/model/localStorage 호출 금지. 입력 mutate 없음.

#### `convertSimpTradInBlocks(blocks, direction)` — abbrevConvert의 `expandAbbrevInBlocks`와 동형

- `normalizeBlocks(blocks)`로 정규화한다.
- 각 블록: **텍스트 블록**이고 `String(block.text).trim() !== END_MARKER`이면 `textBlock(convertSimpTrad(block.text, direction))`로 교체. **임베드 블록·"(끝)" 블록은 그대로 통과**(불변).
- `changed`: 원 텍스트와 다른 블록이 하나라도 있으면 `true`, 아니면 `false`.
- **입력 blocks를 mutate 하지 않는다**(새 배열/새 `textBlock`만). 블록 순서·개수·임베드·"(끝)" 불변.

### 3) SimpTradConvertDialog.jsx — 방향 선택 다이얼로그 (테스트 먼저: `SimpTradConvertDialog.test.jsx`)

```jsx
// 간↔번 방향 선택 다이얼로그 — 순수 표시(stateless) 컴포넌트(ADR-003). 내부 state·localStorage·model 없음.
// 방향만 onConvert(direction)로 부모에 위임한다(실제 본문 변환은 Step 1 WriterPage가 안전 경로로 수행).
// 전용 yh-simptrad-convert/simptrad-convert className·testid로 다른 다이얼로그와 충돌 방지. Escape만 닫기.
export function SimpTradConvertDialog({
  open,
  onConvert, // (direction: 'toTrad' | 'toSimp') => void — 방향 버튼 클릭 시
  onClose,   // () => void — '닫기'/Esc
}) { ... }
```

요구사항:
- `open`이 false면 `null` 반환.
- `role="dialog"`, `aria-label`(예 '간체/번체 변환'), **전용 className `yh-simptrad-convert`·testid `simptrad-convert`**. 기존 `yh-abbrev-manage`/`yh-editor-memo`/`yh-file-info`/`yh-glyph-input`/`yh-url-embed`/`yh-find-replace`/`yh-editor-glyphbar`와 충돌 금지.
- **방향 버튼 2개**: '간체→번체'(testid `simptrad-to-trad`) → `onConvert('toTrad')`; '번체→간체'(testid `simptrad-to-simp`) → `onConvert('toSimp')`. 문자열 리터럴 대신 위 `DIRECTIONS` 상수를 import해 넘겨도 된다(구현 재량).
- **안내 문구**(표 불완전 문서화): 예 "변환표는 상용 한자 위주로 완전하지 않을 수 있습니다. 미등록 문자는 원문이 유지됩니다." — 다이얼로그 안에 텍스트로 표시(testid는 선택).
- **'닫기' 버튼**(testid `simptrad-close`) → `onClose`. **Esc** → `onClose`(컨테이너 `onKeyDown`에서 `e.key === 'Escape'`만).
- `onConvert`/`onClose` 미전달 시 가드(예외 금지).
- 내부 `useState`·model/fetch/transport/localStorage/`window`/`document`/`Date` 호출 금지. `simpTradTable`/`simpTradConvert`를 import 하지 않는다(변환은 부모의 몫 — Enter 미인터셉트).
- CSS: `yh-simptrad-convert` 떠있는 패널을 `yh-abbrev-manage` 인근에 추가(기존 스타일 미파손).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **문자단위 순수 치환 + 미매핑 pass-through**: `convertSimpTrad`는 표에 있는 문자만 바꾸고 **없는 문자·서로 같은(통합) 문자는 원문 그대로** 둔다. 이유: 오변환(false conversion)은 발행 기사 무결성 사고 — 미변환이 오변환보다 안전(약어 '미확장'과 동일 철학).
2. **코드포인트 안전 순회**: `for...of`/`Array.from`로 순회한다(`text[i]`·`.length` 인덱싱 금지). 이유: 보충면(astral) CJK를 surrogate로 쪼개면 문자를 파손한다.
3. **Map 1회 구성·first-wins**: 두 Map은 모듈 로드 시 한 번만 만든다(매 호출 재구성 금지). 1:多 간체는 표에서 먼저 나열된 번체가 이긴다. 이유: 성능 + 최빈 매핑을 순서로 명시.
4. **임베드·"(끝)" 불변**: `convertSimpTradInBlocks`는 임베드 블록과 "(끝)"(`END_MARKER`) 텍스트 블록을 절대 바꾸지 않는다(abbrevConvert와 동일 불변식). 이유: "(끝)"은 송고 게이트 마커, 임베드는 첨부 — 변환 대상이 아니다.
5. **입력 mutate 금지(순수성)**: `convertSimpTrad`/`convertSimpTradInBlocks`는 입력을 변형하지 않고 새 값을 반환한다. 이유: 순수 함수는 테스트·재사용·예측이 쉽다(ADR 철학).
6. **방향 방어**: `direction`이 `'toTrad'`/`'toSimp'`가 아니면 원문을 그대로 반환한다(throw 금지·부분변환 금지). 이유: 잘못된 인자에도 본문을 파손하지 않는다.
7. **다이얼로그 순수성·Enter 미인터셉트**: `SimpTradConvertDialog`는 내부 state·localStorage·`simpTradConvert` import를 두지 않는다(방향만 콜백 위임). `handleKeyDown`은 **Escape만** 처리. 이유: 값/변환은 부모 소유(결선 레이어 분리), UX 혼선 방지.
8. **전용 className/testid**: `yh-simptrad-convert`/`simptrad-convert`. 약어관리/파일정보/약물입력/URL임베드/찾기/메모/약물바와 겹치지 마라. 이유: 회귀·스타일 충돌 방지.
9. **새 npm 의존성 금지**: `package.json`을 건드리지 마라(opencc-js 등 추가 금지). 표는 번들 정적 데이터만. 이유: 자기완결·client-only 스트릭 유지 + 의존성 도입은 사용자 결정.

## Acceptance Criteria

```bash
cd web
npm run test:web -- simpTradConvert        # 신규 simpTradConvert.test.js 통과
npm run test:web -- SimpTradConvertDialog   # 신규 SimpTradConvertDialog.test.jsx 통과
npm run test:web                            # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest):

`simpTradConvert.test.js`:
- 빈/방어: `convertSimpTrad('', 'toTrad')` → `''`. `convertSimpTrad('abc', 'toTrad')` → `'abc'`(라틴 pass-through). `convertSimpTrad('国', 'bogus')` → `'国'`(잘못된 방향 → 원문). `convertSimpTrad(null, 'toTrad')` → `''`.
- **간체→번체**: `convertSimpTrad('国', 'toTrad')` → `'國'`; `convertSimpTrad('学习', 'toTrad')` → `'學習'`(習도 표에 포함해야 함 — 필요 시 표에 추가); `convertSimpTrad('电车', 'toTrad')` → `'電車'`.
- **번체→간체(역방향)**: `convertSimpTrad('國', 'toSimp')` → `'国'`; `convertSimpTrad('電車', 'toSimp')` → `'电车'`; `convertSimpTrad('學', 'toSimp')` → `'学'`.
- **미매핑 pass-through(혼합)**: `convertSimpTrad('한글 abc 国 123', 'toTrad')` → `'한글 abc 國 123'`(중국어만 변환, 한글/라틴/숫자/공백 불변).
- **왕복(round-trip, 결정적 쌍)**: 위 고정 쌍들에 대해 `convertSimpTrad(convertSimpTrad(x,'toTrad'),'toSimp')`가 원 간체로 복귀(1:1 결정적 쌍만 — 1:多 쌍은 제외).
- **길이 보존**: `Array.from(convertSimpTrad(s,'toTrad')).length === Array.from(s).length`(문자단위 1:1이라 코드포인트 수 불변).
- `convertSimpTradInBlocks`: `[textBlock('国'), <embed>, textBlock('学')]` + `'toTrad'` → 텍스트 블록만 `'國'`/`'學'`로, **임베드 블록 동일(참조/내용 보존)**, `changed === true`.
- `convertSimpTradInBlocks`가 **"(끝)" 블록 불변**: `[textBlock('国'), textBlock('(끝)')]` + `'toTrad'` → `[textBlock('國'), textBlock('(끝)')]`.
- `convertSimpTradInBlocks`가 **변환 대상 없음이면 `changed === false`**: 본문이 한글/라틴뿐이면 `changed=false`. 잘못된 방향(`'bogus'`)도 `changed=false`.
- **입력 blocks mutate 없음**: 원본 배열/객체가 호출 후에도 불변(단언).

`SimpTradConvertDialog.test.jsx`:
- `open={false}`면 `container.firstChild === null`.
- `open` 시 `role="dialog"`(name '간체/번체 변환')·testid `simptrad-convert`·'간체→번체'·'번체→간체'·'닫기' 버튼과 표 불완전 안내 문구가 보인다.
- '간체→번체'(`simptrad-to-trad`) 클릭 → `onConvert('toTrad')` 호출. '번체→간체'(`simptrad-to-simp`) 클릭 → `onConvert('toSimp')` 호출.
- '닫기'(`simptrad-close`) 클릭·Esc → `onClose` 호출. Enter 키는 `onConvert`/`onClose`를 **호출하지 않는다**.
- `onConvert`/`onClose` 미전달 시 버튼 클릭/Esc가 예외를 던지지 않는다.

## 검증 절차

1. 위 AC 커맨드를 web 루트(`web/`)에서 실행한다(필요 시 `PYTHONUTF8=1` 또는 UTF-8 콘솔 — 한자/한글 출력).
2. 아키텍처 체크리스트: `simpTradTable` 순수 데이터·표 규모(~150+)·1:多 first-wins·불완전 주석; `convertSimpTrad` 코드포인트 순회·미매핑 pass-through·방향 방어·Map 1회 구성·입력 mutate 없음; `convertSimpTradInBlocks` 임베드/"(끝)" 불변·`changed`; `SimpTradConvertDialog` stateless·Enter 미인터셉트·전용 className/testid; `package.json` 무변경.
3. 결과에 따라 `phases/24-editor-simptrad/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- `WriterPage.jsx`·`Editor.jsx`·`EditorMenuBar.jsx`·`EditorToolBar.jsx`·`server/`·DB를 수정하지 마라(이 step은 신규 simpTradTable/simpTradConvert/SimpTradConvertDialog + 테스트 + CSS만). 이유: 결선은 Step 1, Editor 미접촉, client 전용·DB 비파괴.
- `package.json`에 opencc-js 등 새 의존성을 추가하지 마라. 이유: 자기완결·client-only 스트릭 유지 + 의존성 도입은 사용자 결정(별도 phase).
- `convertSimpTrad`를 `text.replace(/.../g, ...)` 정규식 전역치환이나 `text[i]` 인덱싱으로 구현하지 마라. 이유: (1) surrogate(보충면 CJK) 파손, (2) Map 미사용 시 성능/명료성 저하 — 코드포인트 순회 + Map 조회로 구현.
- 미매핑 문자를 임의 문자(물음표·공백 등)로 바꾸거나 제거하지 마라 — 반드시 원문 유지(pass-through). 이유: 오변환/본문 파손 방지(안전측 미변환).
- `convertSimpTradInBlocks`가 임베드·"(끝)" 블록을 바꾸거나 입력 blocks를 mutate 하게 두지 마라. 이유: 송고 게이트 마커·첨부 보존, 순수성.
- `SimpTradConvertDialog`에 내부 `useState`·`localStorage`·`simpTradTable`/`simpTradConvert` import·model/fetch를 넣지 마라. `handleKeyDown`에서 Enter로 변환/닫기 하지 마라(Escape만). 이유: stateless 표시 컴포넌트 — 변환은 부모(Step 1) 소유, UX 혼선 방지.
- 약어관리/파일정보/약물입력/URL임베드/찾기/메모/약물바와 같은 className/testid를 재사용하지 마라. 이유: 회귀·스타일 충돌.
