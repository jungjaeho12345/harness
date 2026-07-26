# Step 0: toolbar-font-store

## 목표

에디터 툴바(EditorToolBar)의 글꼴·글씨크기 셀렉트가 **표시만 하고 에디터에 반영되지 않는** 문제를 해결하기 위한 전제인 **값의 정의(계약)와 컨트롤(툴바)**을 만든다. 이 step은 **phase 33 줄간격 effect의 step0(store/계약)과 동형** — 값 계약(editorPrefs additive 키 + 순수 매핑 헬퍼) + 컨트롤 컴포넌트(EditorToolBar props화)만 다룬다. **에디터에 실제 반영(WriterPage state·CSS 변수 주입·yonhap.css 변수화)은 step1이다.**

이 phase의 폰트는 **선택영역 서식이 아니라 에디터 전체 표시 폰트**다(사용자 확정). 즉 캔버스 래퍼에 CSS 변수를 주입해 `.yh-editor` 전체 폰트를 바꾸는 것이며(phase 33 줄간격 `--yh-editor-line-height`와 동형), 본문 데이터(markupVersion)는 건드리지 않는다.

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도·기존 관례를 파악하라(라인 번호는 실측 힌트 — 심볼명으로 재확인하라):

- `docs/ARCHITECTURE.md`, `docs/ADR.md` — ADR-003(view 모듈은 localStorage/모듈 상태 직접 접근 가능, 서버 호출만 controller 경유). `editorPrefs.js`·`EditorToolBar.jsx`는 view 모듈이라 localStorage 직접 접근이 위반이 아니다.
- **`phases/33-editor-linespacing-effect/step0.md`, `phases/33-editor-linespacing-effect/step1.md`** — 이 phase가 반드시 모방할 **동형 패턴의 권위 출처**. 특히 step0의 "store 기본값은 CSS fallback과 일치시켜 회귀를 막는다" 원칙과 step1의 "캔버스 래퍼 style에 CSS 변수 상시/조건부 주입, `Editor.jsx` 미접촉, yonhap.css를 `var(--x, fallback)`으로 변수화" 메커니즘.
- `web/src/view/EditorToolBar.jsx` — 전체(31줄). L8 `TOOLBAR_FONTS = ['바탕','돋움','굴림']`, L9 `TOOLBAR_SIZES = ['10','12','14','16']`, L11 `EditorToolBar()`(props 없음), L16·L21 두 `<select>`(`data-testid="tool-font"`/`"tool-size"`, `defaultValue` + `tabIndex={-1}`, onChange 없음). L5·L7·L14의 "표시 전용/placeholder" 주석.
- `web/src/view/EditorToolBar.test.jsx` — 전체(60줄). L23~31(옵션 개수 === 배열 length), L33~40(버튼 0개 회귀 가드), **L42~49("선택은 표시값만 바꾸고 부수효과 없음" — 이 step에서 계약이 바뀌므로 갱신 대상)**, L54~58(tabIndex=-1 마우스 전용).
- `web/src/view/editorPrefs.js` — 전체(101줄). L12~35 `DEFAULT_EDITOR_PREFS`(**L19~21 `edit` 카테고리** — 여기에 additive 키 추가), L61~74 `loadEditorPrefs`(카테고리 1단계 병합), L85~93 `normalizeLineSpacing`(순수 소비-시점 정규화 헬퍼의 본), L96~100 `setEditorPref`.
- `web/src/view/editorPrefs.test.js` — edit 기본값·부분병합·라운드트립 테스트 스타일 확인(추가 단언을 동형으로 붙인다).
- `web/src/styles/yonhap.css` — L34~35(`--yh-serif`·`--yh-sans` 토큰), L63~70(body `font-family: var(--yh-sans)`), **L497~510(`.yh-editor` — L506 `font-size: 0.95rem`, `font-family` 미선언 → body에서 `var(--yh-sans)` 상속)**. 이 두 값이 이 phase의 **"현재값(fallback)"** 이다. step1에서 변수화한다(이 step은 CSS 미접촉 — 확인만).

## 배경 (자기완결 — 이전 대화 참조 없이 여기서 이해하라)

**핵심 문제(회귀 함정):** 툴바의 현재 defaultValue는 글꼴 `'바탕'`(=명조/serif), 크기 `'14'`(=14px)다. 그런데 `.yh-editor`의 **실제 현재 렌더는 `var(--yh-sans)`(Noto Sans KR) / `0.95rem`(≈15.2px)** 이다(L506 + body 상속). 따라서 `'바탕'`을 곧이곧대로 serif로, `'14'`를 14px로 매핑해 기본 상태에 적용하면 **손댄 적 없는 사용자의 에디터 폰트가 sans→serif, 15.2px→14px로 바뀐다 = 시각 회귀**. 이는 phase 33이 `lineSpacing 1.0`을 제거하고 base를 1.8(=CSS와 동일)로 못박은 것과 정확히 같은 문제다.

**결정 (이 값 해석을 못박는다 — phase 33 §결정과 동형):**

- 폰트/크기는 **CSS 변수 override**로 해석한다. `.yh-editor { font-family: var(--yh-editor-font-family, var(--yh-sans)); font-size: var(--yh-editor-font-size, 0.95rem); }`(변수화는 step1). fallback = **현재값**.
- **기본값은 "override 없음"을 뜻하는 sentinel `'기본'`으로 한다.** 옵션 집합에 `'기본'`을 **맨 앞에 추가**하고 이를 default 선택으로 삼는다:
  - `TOOLBAR_FONTS = ['기본', '바탕', '돋움', '굴림']`
  - `TOOLBAR_SIZES = ['기본', '10', '12', '14', '16']`
- **매핑 헬퍼는 `'기본'`(및 미상/무효값)에 대해 `null`(주입 안 함)을 반환**하고, 명명 폰트/수치에만 실제 CSS 문자열을 반환한다. → 기본 상태(`'기본'`)는 CSS 변수를 주입하지 않아 fallback(현재값)이 렌더된다 = **바이트 동일 회귀 가드**. 사용자가 명시적으로 `'바탕'`을 고르면 실제 serif가 적용된다 = **거짓 컨트롤 아님**(phase 33이 "1.0을 골라도 1.8이 되는 거짓 컨트롤" 금지한 교훈의 직접 계승).

> **설계 결정(플랜 리뷰어 확인 요망):** 사용자 지시의 "기본값=현재 표시값"에서 현재 표시 defaultValue는 `'바탕'`/`'14'`였다. 그러나 그 두 값은 에디터의 **실제 현재 렌더(sans/0.95rem)와 불일치**하므로, 이를 그대로 default-effect로 삼으면 "미설정/기본값일 때 바이트 동일" 하드 회귀 가드를 위반한다. 두 제약을 동시에 만족하는 유일한 해법이 중립 sentinel `'기본'`이다. 이 편차(default 표시가 `'바탕'`→`'기본'`)는 회귀 가드 + 거짓 컨트롤 금지를 위한 의도적 결정이다.

## TDD — 테스트 먼저

`web/src/view/editorPrefs.test.js`:
- `DEFAULT_EDITOR_PREFS.edit.editorFont === '기본'`, `DEFAULT_EDITOR_PREFS.edit.editorFontSize === '기본'`.
- `loadEditorPrefs().edit`가 신규 키를 기본값으로 노출하고, 부분 저장(`{edit:{columnLimit:true}}`)에도 `editorFont/editorFontSize`가 기본값으로 병합되는지(1단계 병합 회귀).
- `fontFamilyCss('기본') === null`, `fontFamilyCss(undefined) === null`, `fontFamilyCss('없는값') === null`; `fontFamilyCss('바탕')`·`'돋움'`·`'굴림'`은 각각 비어있지 않은 문자열(실제 CSS font-family 스택)을 반환.
- `fontSizeCss('기본') === null`, `fontSizeCss('없는값') === null`; `fontSizeCss('14') === '14px'`, `fontSizeCss('16') === '16px'`(숫자 문자열 → `'<n>px'`), `fontSizeCss(0) === null`·`fontSizeCss('x') === null`(무효값 → null).

`web/src/view/EditorToolBar.test.jsx`(기존 테스트 갱신 — 계약 변경):
- L23~31(옵션 개수 === 배열 length)은 `'기본'` 추가로도 유지된다(개수 단언이 배열 length 기준이라 자동 통과 — 확인).
- L42~49를 **controlled 계약으로 재작성**: `<EditorToolBar font="기본" fontSize="기본" onFontChange={fn} onFontSizeChange={fn} />` 렌더 → `tool-font`에서 `'바탕'` 선택 시 `onFontChange('바탕')` 호출(부수효과=콜백만, model/fetch 없음), `tool-size`에서 `'16'` 선택 시 `onFontSizeChange('16')`. controlled라 value는 prop을 따른다(stateful 하네스로 감싸 value 반영을 확인하거나, 콜백 인자만 단언).
- 신규: `font`/`fontSize` prop 미전달 시에도 렌더가 깨지지 않는다(기본 prop `'기본'`) — 기존 `render(<EditorToolBar />)` 테스트(L18~40, L54~58) 보존.

## 작업 (구현 상세 — 시그니처 고정, 내부는 재량)

### 1. `web/src/view/editorPrefs.js`
- `DEFAULT_EDITOR_PREFS.edit`에 additive 키 2개 추가(나머지 edit 키 불변): `editorFont: '기본'`, `editorFontSize: '기본'`. **키 순서/기존 값은 건드리지 마라(additive만).**
- 순수 export 헬퍼 2개 추가(소비-시점 매핑 — `normalizeLineSpacing`과 동형 위치·스타일):
  ```js
  // 저장된 글꼴 선택값을 실제 CSS font-family 문자열로 매핑한다. '기본'/미상/무효 → null(override 없음).
  export function fontFamilyCss(value) // -> string | null
  // 저장된 글씨크기 선택값을 실제 CSS font-size 문자열('<n>px')로 매핑한다. '기본'/미상/무효 → null.
  export function fontSizeCss(value) // -> string | null
  ```
  - `fontFamilyCss`: `'기본'`이나 매핑에 없는 값이면 `null`. `'바탕'`→명조/serif 스택(예: `"'Batang', 바탕, serif"`), `'돋움'`→고딕/sans 스택(예: `"'Dotum', 돋움, sans-serif"`), `'굴림'`→`"'Gulim', 굴림, sans-serif"`. **정확한 폰트 스택은 재량**이되, 세 값 모두 실제 한국어 폰트 스택이어야 하고 `'기본'`은 반드시 `null`이어야 한다.
  - `fontSizeCss`: `const n = Number(value); if (!Number.isFinite(n) || n <= 0) return null; return \`${n}px\`;` (`'기본'`은 `Number('기본')=NaN`→null로 자동 처리). 선택 옵션 10/12/14/16만 정상 통과하면 된다.
- **`loadEditorPrefs` 병합에 매핑을 넣지 마라** — store는 raw 선택값을 유지한다(정규화/매핑은 소비 시점 step1에서만, `normalizeLineSpacing` 계약과 동일).

### 2. `web/src/view/EditorToolBar.jsx`
- `TOOLBAR_FONTS`에 `'기본'`을 맨 앞에 추가 → `['기본', '바탕', '돋움', '굴림']`. `TOOLBAR_SIZES` → `['기본', '10', '12', '14', '16']`.
- 시그니처를 controlled로 변경(기본 prop로 하위호환): `EditorToolBar({ font = '기본', fontSize = '기본', onFontChange, onFontSizeChange })`.
- 두 `<select>`를 controlled로: `value={font}` + `onChange={(e) => onFontChange && onFontChange(e.target.value)}`(글꼴), 크기도 동형. `defaultValue`를 제거하고 `value`로 대체. **`tabIndex={-1}`·`data-testid`·`aria-label`·클래스는 그대로 유지**(마우스 전용 chrome 규약·mousedown 미차단).
- L5·L7·L14의 "표시 전용/에디터 폰트 미적용/placeholder" 주석을 실제 동작(캔버스 폰트 반영)에 맞게 갱신하라. 단 "툴바 기본 숨김·우클릭 토글·마우스 전용" 규약 설명은 보존.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(순수 client — 백엔드 무관. `npm test`(node --test)는 서버 파일 미변경이라 불필요.)

## 회귀 가드 / 불변식

- **바이트 동일 기본값**: 신규 키 기본값은 `'기본'`이고, `fontFamilyCss('기본')`/`fontSizeCss('기본')`는 반드시 `null`. → step1에서 기본 상태는 CSS 변수를 주입하지 않아 fallback(현재값)이 렌더된다.
- **거짓 컨트롤 금지**: 명명 폰트/수치는 실제 CSS 값을 반환해야 한다(사용자가 고른 값이 무시되면 안 됨).
- **additive-only**: `DEFAULT_EDITOR_PREFS`의 기존 카테고리/키/값을 바꾸지 마라(edit에 2키 추가만). `loadEditorPrefs`의 병합 구조 불변.
- **컨트롤만**: 이 step은 `WriterPage.jsx`·`web/src/styles/yonhap.css`·`Editor.jsx`를 건드리지 않는다(step1 범위).
- 기존 `EditorToolBar.test.jsx` 버튼-0개 가드(L33~40)·tabIndex 가드(L54~58)·옵션 개수 가드는 통과 유지.

## 커밋 계획

- **feat**: `feat(44-editor-gap-closeout): step0 — 툴바 글꼴/크기 store 계약(editorPrefs editorFont/editorFontSize + fontFamilyCss/fontSizeCss + EditorToolBar controlled)` — `editorPrefs.js`·`EditorToolBar.jsx` + 두 테스트 파일.
- **chore**: `chore(44-editor-gap-closeout): step0 status — completed` — `phases/44-editor-gap-closeout/index.json`의 step0 `status`/`summary`. 코드/테스트와 분리 커밋.

## 금지사항

- `'바탕'`/`'14'`를 default-effect(serif/14px)로 만들지 마라. 이유: 손대지 않은 에디터가 sans/0.95rem → serif/14px로 바뀌어 바이트 동일 회귀 가드를 위반한다. 기본은 sentinel `'기본'`(=override 없음)이어야 한다.
- 옵션에 `'기본'`을 넣고도 명명 폰트를 no-op로 만들지 마라(거짓 컨트롤). 이유: phase 33이 "1.0을 골라도 1.8이 되는 거짓 컨트롤"을 금지한 것과 동일 — 명명 값은 실제로 적용돼야 한다.
- `loadEditorPrefs` 병합에 `fontFamilyCss`/`fontSizeCss`를 주입하지 마라. 이유: store는 raw 선택값을 유지해야 라운드트립·툴바 표시가 오염되지 않는다(매핑은 소비 시점만).
- `WriterPage.jsx`·`yonhap.css`·`Editor.jsx`를 건드리지 마라. 이유: 이 step은 값 계약+컨트롤만 — 반영(effect)은 step1이며, 한 step에 여러 레이어를 섞으면 실패 격리가 불가능하다.
- 본문 데이터(markupVersion)·`articleDetail.js`(발행 기사 렌더)를 건드리지 마라. 이유: 폰트는 에디터 표시 스타일이며 저장 데이터/발행 렌더와 무관하다.
- 기존 테스트를 깨뜨리지 마라(단, L42~49 "부수효과 없음" 테스트는 계약 변경에 따라 controlled 콜백 단언으로 **의도적으로 갱신**한다).
