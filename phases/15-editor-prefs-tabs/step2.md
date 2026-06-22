# Step 2: spellcheck-tab — 환경설정 '맞춤법' 탭 (UI + 영속)

## 배경 / 요구사항

Step 0에서 store(`editorPrefs.js`)에 `spellcheck` 카테고리 기본값이 갖춰졌다. 이 step은 `EditorPrefsDialog.jsx`에 **맞춤법(spellcheck)** 탭 UI를 추가하고 기존 적용/취소/기본값 패턴에 결선해 **localStorage 영속**까지 한다. 검사옵션(enum 단일 선택)·오류유형(다중 bool)·오류표현(enum)을 다뤄 step1보다 폼이 조금 복잡하므로 별도 step으로 둔다.

설정값의 실제 **맞춤법 검사 실행은 이 step에서 하지 않는다**(저장만 — 아래 DEFERRED EFFECTS).

탭에 들어갈 필드(news.md L210~213) — store 키 `spellcheck` = `{ checkOption, errorTypes, errorStyle }`:
- **검사옵션** `checkOption`(enum 단일) — select. 옵션 5종: 절차오류=`procedure`, 띄어쓰기=`spacing`, 붙여쓰기=`joining`, 띄어쓰기+붙여쓰기=`spacingJoining`, 순환용어·외래어=`circularLoan`. `data-testid="pref-spellcheck-checkOption"`.
- **오류유형** `errorTypes`(다중 bool) — 체크박스 6개. 키: 오용어=`misuse`, 다수어절=`multiWord`, 의미문체=`semantic`, 순환용어=`circular`, 통계붙여쓰기=`statSpacing`, 그외=`others`. testid: `pref-spellcheck-errorType-misuse` / `-multiWord` / `-semantic` / `-circular` / `-statSpacing` / `-others`.
- **오류표현** `errorStyle`(enum) — 굵게=`bold`, 밑줄=`underline`. select 또는 라디오. `data-testid="pref-spellcheck-errorStyle"`.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 컴포넌트(ADR-003: editorPrefs 같은 view 모듈 직접 호출은 서버 호출이 아니라 허용).
- `/docs/news.md` L210~213(맞춤법).
- `phases/15-editor-prefs-tabs/step0.md` — `spellcheck` 키 구조·기본값·enum 값의 **단일 출처**(`checkOption: 'spacing'`, `errorTypes` 6키 전부 false, `errorStyle: 'bold'`).
- `web/src/view/editorPrefs.js` — **step0 결과 반영됨**. `DEFAULT_EDITOR_PREFS.spellcheck`, `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref`.
- `web/src/view/EditorPrefsDialog.jsx` — **변경 대상**. **step1이 추가한 편집/바이라인 탭이 이미 있을 수 있다**(같은 phase). `PREF_TABS`, form state 패턴, `open` 재초기화 `useEffect`, `apply()` 합성 체인, `reset()`, 탭 렌더 블록, testid 컨벤션을 그대로 미러링한다.
- `web/src/view/EditorPrefsDialog.test.jsx` — **변경 대상**(신규 단언 추가). 기존 탭 테스트 스타일 미러링.

## 작업

TDD로 진행한다(vitest + @testing-library/react). **테스트를 먼저 쓰고 통과시킨다.**

### 1. `PREF_TABS`에 `{ key: 'spellcheck', label: '맞춤법' }` 추가

news.md 환경설정 목록 마지막군(약물/맞춤법)에 해당하므로 배열 뒤쪽에 둔다. 기존 탭 항목·순서 동작은 깨지 않는다(회귀 금지).

### 2. form state + open 재초기화 + reset (3-지점 동기화)

- `const [spellcheck, setSpellcheck] = useState(() => loadEditorPrefs().spellcheck);`
- `open` 재초기화 `useEffect([open])` 블록에 `setSpellcheck(prefs.spellcheck);` 추가.
- `reset()`에 `setSpellcheck(DEFAULT_EDITOR_PREFS.spellcheck);` 추가.

오류유형 체크박스 onChange는 중첩 객체를 보존하며 갱신한다:
`setSpellcheck((s) => ({ ...s, errorTypes: { ...s.errorTypes, [key]: checked } }))`. checkOption/errorStyle는 `setSpellcheck((s) => ({ ...s, checkOption: value }))` 패턴.

### 3. `apply()` 합성 체인에 spellcheck 추가 (상호 보존)

기존 `apply()`의 `setEditorPref` 체인에 `'spellcheck'`를 한 단계 더 끼운다 — `setEditorPref(prev, 'spellcheck', { checkOption, errorTypes, errorStyle })`. **errorTypes는 객체 전체를 통째로 넘긴다**(step0 한 단계 병합 한계 대응 — 부분만 넘기면 다른 errorTypes 키가 손실된다). `loadEditorPrefs()`를 base로 spread하는 기존 구조라 명시 합성하지 않은 카테고리(glyph 등)도 보존된다. colors·autosave·edit·byline·dateFormat·spellcheck가 결과 `next`에 누락 없이 담겨야 한다.

### 4. 탭 렌더 블록 `{tab === 'spellcheck' && (...)}` 추가

- 검사옵션 select(`pref-spellcheck-checkOption`) — `value={spellcheck.checkOption}`, 옵션 5종.
- 오류유형 체크박스 6개 — 각 `checked={spellcheck.errorTypes[key]}`.
- 오류표현 select/라디오(`pref-spellcheck-errorStyle`) — `value={spellcheck.errorStyle}`, 옵션 2종.

옵션 라벨은 한국어 표시, value는 enum 코드.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **저장-only(effect 금지)**: 맞춤법 검사 실행·오류 하이라이트를 결선하지 마라(아래 DEFERRED EFFECTS). **Editor.jsx·WriterPage.jsx를 건드리지 마라.** WriterPage의 `spell` 상태(spellcheck DOM 속성)는 이 설정과 무관하므로 손대지 마라.
2. **errorTypes 통째 저장**: `apply()`에서 errorTypes는 6키 객체 전체를 넘긴다(부분 넘기면 한 단계 병합이라 나머지 키 손실).
3. **상호 보존**: colors·autosave·edit·byline·dateFormat·spellcheck를 함께 저장한다(+base spread로 glyph 카테고리 보존).
4. **기존 탭 회귀 금지**: 색상/자동저장/날짜형식 + step1의 편집/바이라인 탭과 그 테스트가 그대로 통과.
5. **store 시그니처 불변**: `editorPrefs.js`를 수정하지 마라(step0 확정). 이 step은 다이얼로그·테스트만 만진다.

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(`EditorPrefsDialog.test.jsx`, vitest):
- 맞춤법 탭(`prefs-tab-spellcheck`) 클릭 시 검사옵션 select·오류유형 체크박스 6개(`pref-spellcheck-errorType-misuse` 등)·오류표현(`pref-spellcheck-errorStyle`)이 렌더되고 다른 탭 입력은 사라진다.
- 검사옵션 `joining` 선택 + 오류유형 `misuse`·`semantic` 체크 + 오류표현 `underline` 선택 후 '적용' → `loadEditorPrefs().spellcheck`가 `{ checkOption: 'joining', errorTypes: { misuse: true, semantic: true, multiWord: false, ... }, errorStyle: 'underline' }`로 영속되고 `onClose(true)`.
- **errorTypes 부분 손실 없음**: 두 개만 체크해도 저장된 errorTypes에 나머지 4키가 false로 남아 있다(통째 저장 확인).
- **재오픈 복원**: 저장값으로 다시 열면 맞춤법 폼이 저장값으로 초기화된다.
- **상호 보존**: 색상/편집 등을 바꾼 적 없이 맞춤법만 바꿔 '적용'해도 적용 후 `loadEditorPrefs()`의 colors·autosave·edit·byline·dateFormat이 기존 값 그대로 유지된다.
- '기본값'(`prefs-reset`) 클릭 시 맞춤법 폼이 `DEFAULT_EDITOR_PREFS.spellcheck`로 리셋된다(checkOption `spacing`, errorTypes 전부 false, errorStyle `bold`).
- **회귀**: 기존 색상/자동저장/날짜형식 + 편집/바이라인 탭 테스트 전부 통과.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: ADR-003(editorPrefs는 view 모듈 — 서버 호출 없음) / DB 비파괴(무관) / 기존 탭 회귀 없음 / Editor.jsx·WriterPage.jsx 무변경.
3. `phases/15-editor-prefs-tabs/index.json`의 step 2를 갱신한다(성공 → `completed` + `summary` / 3회 실패 → `error` + `error_message` / 개입 필요 → `blocked` + `blocked_reason`).

## DEFERRED EFFECTS

이 step은 맞춤법 설정을 **저장만** 한다. 다음은 결선하지 않는다:
- 맞춤법 검사 실행(절차/띄어쓰기/붙여쓰기 등)·오류 하이라이트(굵게/밑줄 표현)·메뉴바 '맞춤법' 메뉴 동작(news.md L178) → **후속 phase**(검사 엔진·Editor 본문 마크업 변경 필요 — 이 phase 범위 밖).

## 금지사항

- **Editor.jsx·WriterPage.jsx를 수정하지 마라.** 이유: 본 step은 환경설정 UI + 영속만이고, 검사/하이라이트 effect는 후속 phase다(Editor 불변식 보호·범위 격리).
- `apply()`에서 errorTypes를 부분 객체로 넘기지 마라(6키 전체). 이유: 한 단계 병합이라 넘기지 않은 키가 손실된다.
- `apply()`에서 colors/autosave/edit/byline/dateFormat 중 하나라도 누락하지 마라(상호 보존).
- `editorPrefs.js`의 store 함수 시그니처·로직을 바꾸지 마라(step0 확정).
- 기존 탭(색상/자동저장/날짜형식/편집/바이라인)의 마크업·testid·동작을 바꾸지 마라(회귀 금지).
- 서버 저장을 하지 마라(localStorage 전용).
- 기존 테스트를 깨뜨리지 마라.
