# Step 2: statusbar-lang-bytes

상태표시줄(`StatusBar.jsx`)이 **언어 라벨**과 **입력모드별 바이트(+ 비호환 개수)**를 표시하도록 결선한다. `StatusBar`는 **순수 표시 컴포넌트**를 유지한다(내부 state/effect/타이머 없음). 계산은 props와 step0·step1의 순수 함수 호출로만 한다. 이 step은 `StatusBar.jsx`와 그 테스트만 다룬다 — WriterPage 결선·Editor는 step3이다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — 프론트 MVC, View는 순수 표시).
- `docs/news.md` L160(상태표시줄: 워드수·Byte·N단락N행N열·삽입/수정·언어), L196(언어 9종), L198(입력모드 KSC-5601/Unicode).
- `web/src/view/StatusBar.jsx` — 현재 순수 표시 컴포넌트. props `language`(기본 `'한국어'`, placeholder)·`overwrite`(placeholder)가 이미 있고, `editorStats`의 `wordCount`/`byteLength`/`caretPosition`를 호출한다. `data-testid`: `stat-words`·`stat-bytes`·`stat-caret`·`stat-mode`·`stat-language`.
- `web/src/view/StatusBar.test.jsx` — 기존 5 케이스. **이 중 `stat-language` `'한국어'`/`'English'` 단언과 바이트 단언을 이 step에서 갱신**한다.
- `web/src/view/editorEncoding.js` — **step0 산출물**: `normalizeInputMode(mode)`·`euckrStats(text) → { bytes, incompatible }`.
- `web/src/view/editorLanguage.js` — **step1 산출물**: `languageLabel(code)`(폴백 '한글')·`LANGUAGE_LABELS`.
- `web/src/view/editorStats.js` — `byteLength(text)`(UTF-8) — Unicode 모드에서 **그대로** 쓴다(변경 금지).

step0·step1 요약이 프롬프트에 함께 전달된다. 두 모듈을 먼저 읽고 계약을 확인하라.

## 배경 (자기완결)

현재 `StatusBar`는 `language`를 **표시용 라벨 문자열**로 그대로 렌더하고(기본 placeholder `'한국어'`), 바이트는 항상 `byteLength`(UTF-8)로 표시한다. 이 step에서 `language` prop의 의미를 **언어 코드**로 바꾸고(예: `'ko'` → `languageLabel`로 `'한글'` 표시), `inputMode` prop을 추가해 KSC-5601 모드일 때 바이트를 EUC-KR 근사로 전환하고 비호환 개수를 병기한다. WriterPage 주입은 step3에서 하며, 이 step 이후에도 WriterPage가 아직 prop을 안 넘겨 **기본값**으로 동작한다(회귀 없음).

### `StatusBar` 시그니처(변경)

```jsx
export function StatusBar({
  text = '',
  caret = null,
  language = 'ko',        // ← 의미 변경: 라벨 문자열 → 언어 코드. languageLabel(language)로 표시.
  inputMode = 'unicode',  // ← 신규: 'unicode' | 'ksc5601'. 바이트 계산 모드.
  overwrite = false,      // 기존 placeholder 유지(이 phase 범위 밖 — 건드리지 마라).
}) { ... }
```

### 표시 규칙 (못박음)

1. **언어 라벨**: `stat-language`는 `languageLabel(language)`를 표시한다. 미지원 코드는 step1 폴백으로 `'한글'`.
2. **바이트/비호환**: `const mode = normalizeInputMode(inputMode);`
   - `mode === 'unicode'`: `stat-bytes` = `` `${byteLength(text)}B` ``(현행과 **완전 동일** — 문자열·DOM 불변). 비호환 요소 **없음**.
   - `mode === 'ksc5601'`: `const { bytes, incompatible } = euckrStats(text);` → `stat-bytes` = `` `${bytes}B` ``. `incompatible > 0`이면 별도 요소 `data-testid="stat-incompat"`를 추가해 개수를 병기한다(예 텍스트 `` `비호환 ${incompatible}자` ``, 정확한 문구는 재량이되 개수를 포함). `incompatible === 0`이면 비호환 요소를 렌더하지 않는다.
3. **구분자**: 기존 항목들은 `<span className="yh-editor-statusbar__sep" aria-hidden="true">·</span>`로 구분된다. `stat-incompat`를 추가할 때도 앞에 동일 `sep`을 두어 시각 일관을 지킨다(조건부 렌더 — ksc5601 && incompatible>0일 때만 sep+item).

**Unicode 모드 DOM 불변(핵심 회귀 가드)**: 기본(`inputMode='unicode'`)에서 상태표시줄의 DOM은 이 step 이전과 **바이트 요소 텍스트·요소 구성이 동일**해야 한다(`stat-incompat` 요소가 존재하지 않음). 유일한 표시 변화는 `stat-language`가 코드→라벨로 바뀌는 것뿐이다.

## 작업 (TDD — 실패하는 테스트부터)

### `web/src/view/StatusBar.test.jsx` (갱신)

기존 케이스 중 아래를 **갱신**하고 신규 케이스를 추가한다:

- 기존 "기본값은 삽입·한국어(placeholder)" → 기본 `language`가 코드 `'ko'`이므로 `stat-language`는 `'한글'`을 단언(문구 갱신). `stat-mode` `'삽입'`은 유지.
- 기존 "language props를 그대로 표시한다"(`language="English"` 기대 `'English'`) → prop 의미가 코드로 바뀌었으므로 `language="en"` → `'영어'`, 그리고 미지원 `language="xx"` → `'한글'`(폴백) 단언으로 교체.
- 바이트: `<StatusBar text="한글" />`(기본 unicode) → `stat-bytes` `'6'` 포함(UTF-8 — 현행 유지).
- KSC-5601 바이트: `<StatusBar text="한글" inputMode="ksc5601" />` → `stat-bytes` `'4'` 포함(2음절×2B), `stat-incompat` **부재**(`queryByTestId('stat-incompat')`가 null).
- 비호환 병기: `<StatusBar text="a😀" inputMode="ksc5601" />` → `stat-bytes` `'1'` 포함(a=1B, 😀 비호환 0B), `stat-incompat` **존재**하고 텍스트에 `'1'` 포함.
- Unicode 회귀: `<StatusBar text="a😀" />` → `stat-bytes` `'5'` 포함(UTF-8: a 1B + 😀 4B), `stat-incompat` **부재**.

### `web/src/view/StatusBar.jsx` (구현)

위 시그니처·표시 규칙대로 구현한다. `languageLabel`은 `./editorLanguage.js`, `normalizeInputMode`·`euckrStats`는 `./editorEncoding.js`, `byteLength`(및 기존 `wordCount`/`caretPosition`)는 `./editorStats.js`에서 import한다. 내부 state/effect/ref를 도입하지 마라 — props의 순수 함수여야 한다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — 백엔드 `npm test`는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다(전부 green).
2. 아키텍처 체크리스트:
   - `StatusBar`가 여전히 순수 표시인가?(useState/useEffect/useRef 미도입)
   - `editorStats.byteLength`·`Editor.jsx`·`WriterPage.jsx`·`FileInfoDialog.jsx`가 diff에 **없는가**?(이 step은 StatusBar + 그 테스트만)
   - Unicode 기본 경로의 바이트 표시가 현행과 동일(회귀 없음)한가?
   - ADR-003(View 순수)·CLAUDE.md(client 전용·UTF-8) 준수?
3. 결과에 따라 `phases/40-editor-lang-inputmode/index.json`의 step2를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (StatusBar language=코드→라벨·inputMode prop 추가·ksc5601 EUC-KR 바이트+stat-incompat·Unicode DOM 불변·테스트 갱신)를 한 줄 요약. **step3이 WriterPage에서 `language`(코드)·`inputMode`를 주입한다**는 다음-step 힌트를 요약에 포함.
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 40 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- `StatusBar`에 내부 state/effect/ref를 넣지 마라. 이유: 순수 표시 컴포넌트 계약(props → 렌더)을 유지해야 테스트가 결정적이고 캐럿/본문 소스와 결합이 생기지 않는다.
- `editorStats.byteLength`를 바꾸거나 KSC 계산을 그 안에 넣지 마라. 이유: 파일 정보 다이얼로그의 'UTF-8 바이트' 항목이 이 함수를 공유한다 — 모드 전환은 상태표시줄에서만, EUC-KR은 `editorEncoding` 모듈로 격리한다.
- `FileInfoDialog.jsx`를 건드리지 마라. 이유: 파일 정보의 바이트는 'UTF-8 바이트'로 고정 표기이며 입력모드 설정의 영향을 받지 않는다(범위 밖).
- Unicode 모드에서 `stat-incompat` 요소나 추가 sep을 렌더하지 마라. 이유: 기본 경로 DOM 불변이 회귀 가드다 — 비호환 병기는 KSC-5601 && 개수>0에서만.
- `overwrite`(삽입/수정) 표시를 바꾸지 마라. 이유: 이 phase 범위 밖 placeholder다.
- 기존 테스트를 깨뜨리지 마라(갱신이 필요한 `stat-language`·바이트 단언 외 다른 케이스는 그대로 green이어야 한다).
