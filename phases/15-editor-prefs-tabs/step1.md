# Step 1: edit-byline-tabs — 환경설정 '편집' + '바이라인' 탭 (UI + 영속)

## 배경 / 요구사항

Step 0에서 store(`editorPrefs.js`)에 `edit`·`byline` 카테고리 기본값이 갖춰졌다. 이 step은 `EditorPrefsDialog.jsx`에 **편집(edit)** 탭과 **바이라인(byline)** 탭 UI를 추가하고, 기존 적용/취소/기본값 패턴에 결선해 **localStorage 영속**까지 한다. 둘 다 단순 bool/enum/text 폼이라 위험이 낮아 한 step으로 묶는다.

설정값의 **실제 적용(effect)은 이 step에서 하지 않는다**(저장만). 컬럼제한 effect는 step4, 나머지는 후속 phase(아래 DEFERRED EFFECTS 참조).

탭에 들어갈 필드(news.md L184~190, L201~203):

**편집(edit)** — store 키 `edit` = `{ columnLimit, dragDrop, noCommonAbbr, companyCode, language, lineSpacing, inputMode }`:
- 컬럼제한 — 체크박스, `data-testid="pref-edit-columnLimit"`.
- 드래그앤드롭 — 체크박스, `data-testid="pref-edit-dragDrop"`.
- 공용약어 사용안함 — 체크박스, `data-testid="pref-edit-noCommonAbbr"`.
- 기업코드 — select(수동=`manual`/자동=`auto`), `data-testid="pref-edit-companyCode"`.
- 언어 — select 9종(한글=`ko`/영어=`en`/일어=`ja`/중국어=`zh`/스페인=`es`/프랑스=`fr`/아랍어=`ar`/베트남=`vi`/러시아어=`ru`), `data-testid="pref-edit-language"`.
- 줄간격 — select 또는 number 입력(예 1.0/1.2/1.5/1.8/2.0), `data-testid="pref-edit-lineSpacing"`.
- 입력모드 — select(KSC-5601=`ksc5601`/Unicode=`unicode`), `data-testid="pref-edit-inputMode"`.

**바이라인(byline)** — store 키 `byline` = `{ email, emailValue, blog, blogValue }`:
- E-MAIL 사용 — 체크박스, `data-testid="pref-byline-email"`.
- email 값 — text 입력, `data-testid="pref-byline-emailValue"`.
- Blog 사용 — 체크박스, `data-testid="pref-byline-blog"`.
- blog 값 — text 입력, `data-testid="pref-byline-blogValue"`.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 컴포넌트(ADR-003: model/fetch 직접 호출 금지. 단 editorPrefs 같은 **view 모듈** 직접 호출은 서버 호출이 아니라 허용 — EditorPrefsDialog.jsx 상단 주석 참조).
- `/docs/news.md` L184~190(편집), L201~203(바이라인).
- `phases/15-editor-prefs-tabs/step0.md` — 신규 카테고리 키 이름·기본값·허용 enum 값의 **단일 출처**.
- `web/src/view/editorPrefs.js` — **step0 결과 반영됨**. `DEFAULT_EDITOR_PREFS.edit`/`.byline`, `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref`.
- `web/src/view/EditorPrefsDialog.jsx` — **변경 대상**. `PREF_TABS` 배열, 탭별 form state(`useState(() => loadEditorPrefs().X)`), `open` 시 재초기화 `useEffect([open])`, `apply()`(colors+autosave를 `setEditorPref`로 합성 + dateFormat spread 보존), `reset()`, 탭 렌더 블록(`{tab === 'X' && (...)}`), testid 컨벤션(`prefs-tab-${key}`, `pref-<category>-<field>`). **이 패턴을 그대로 미러링하는 것이 핵심.**
- `web/src/view/EditorPrefsDialog.test.jsx` — **변경 대상**(신규 단언 추가). 기존 색상/자동저장/날짜형식 탭 테스트 스타일(탭 렌더·입력·apply 영속·상호 보존·reset)을 미러링.

## 작업

TDD로 진행한다(vitest + @testing-library/react). **테스트를 먼저 쓰고 통과시킨다.**

### 1. `PREF_TABS`에 탭 2개 추가

news.md 환경설정 순서(편집·자동저장·색상·바이라인·날짜형식)에 맞춰 자연스러운 위치에 추가한다. 권장: `{ key: 'edit', label: '편집' }`를 배열 앞쪽(색상/자동저장 근처), `{ key: 'byline', label: '바이라인' }`를 `dateFormat` 앞에. 기존 3탭(colors/autosave/dateFormat) 항목·testid·순서 동작은 깨지 않는다(회귀 금지).

### 2. form state + open 재초기화 + reset (기존 3-지점 동기화 패턴 그대로)

기존 colors/autosave/byline 처럼 다음 3곳을 **모두** 갱신한다(누락 시 재오픈 시 저장값 복원 불변식이 해당 탭에서만 깨짐):
- `const [edit, setEdit] = useState(() => loadEditorPrefs().edit);`
- `const [byline, setByline] = useState(() => loadEditorPrefs().byline);`
- `open` 재초기화 `useEffect([open])` 블록에 `setEdit(prefs.edit); setByline(prefs.byline);` 추가.
- `reset()`에 `setEdit(DEFAULT_EDITOR_PREFS.edit); setByline(DEFAULT_EDITOR_PREFS.byline);` 추가.

각 필드 onChange는 `setEdit((s) => ({ ...s, <field>: <value> }))` / `setByline((b) => ({ ...b, <field>: <value> }))` 패턴(자동저장 탭의 `setAutosave` 미러). 줄간격 select value는 문자열이므로 저장 시 `Number()`로 변환한다(자동저장 intervalSec과 동일 처리).

### 3. `apply()` 합성 체인에 edit·byline 추가 (**상호 보존 필수**)

기존 `apply()`는 `next = { ...setEditorPref(setEditorPref(loadEditorPrefs(), 'colors', {...}), 'autosave', {...}), dateFormat }` 형태로 colors·autosave를 합성하고 dateFormat은 spread로 보존한다. 여기에 `edit`·`byline`을 **같은 `setEditorPref` 체인**으로 끼운다:

```js
const next = {
  ...setEditorPref(
    setEditorPref(
      setEditorPref(
        setEditorPref(loadEditorPrefs(), 'colors', { title, subtitle, body, background }),
        'autosave', { enabled, intervalSec: Number(...), retentionDays: Number(...) }),
      'edit', { columnLimit, dragDrop, noCommonAbbr, companyCode, language, lineSpacing: Number(lineSpacing), inputMode }),
    'byline', { email, emailValue, blog, blogValue }),
  dateFormat,
};
saveEditorPrefs(next);
```

**결과 `next`에 colors·autosave·edit·byline·dateFormat이 모두 누락 없이 담겨야 한다**(상호 보존). step2/step3가 추가할 spellcheck/glyphFavorites/glyphKeymap 보존은 각 step이 책임지므로 이 step에서는 아직 합성에 없어도 된다(단, **`loadEditorPrefs()`를 base로 spread하므로 명시 합성하지 않은 카테고리도 저장값이 보존된다** — 그 동작을 깨지 마라).

### 4. 탭 렌더 블록 추가

`{tab === 'edit' && (...)}` / `{tab === 'byline' && (...)}` 블록을 기존 `{tab === 'colors' && ...}` 패턴으로 추가한다. 각 입력은 `id`/`data-testid`를 위 배경의 testid 그대로 부여하고 `value`/`checked`를 state에 바인딩한다. select의 옵션 라벨은 한국어 표시(예: 언어 select는 `<option value="ko">한글</option>` 등), value는 enum 코드.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **저장-only(effect 금지)**: 이 step은 값 저장만 한다. columnLimit/dragDrop/language/inputMode 등의 실제 동작을 결선하지 마라(아래 DEFERRED EFFECTS). 특히 **WriterPage.jsx·Editor.jsx를 건드리지 마라**(컬럼제한 effect는 step4).
2. **상호 보존**: `apply()`가 colors·autosave·edit·byline·dateFormat을 한 객체로 함께 저장한다(+`loadEditorPrefs()` base spread로 spellcheck/glyph 등 미합성 카테고리도 보존). 하나라도 누락하면 다른 탭 설정이 사라진다.
3. **기존 탭 회귀 금지**: 색상/자동저장/날짜형식 탭의 마크업·testid·apply/취소/기본값 동작과 그 테스트가 그대로 통과해야 한다. 색상 탭은 절대 건드리지 마라.
4. **store 시그니처 불변**: `editorPrefs.js`의 `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref`를 수정하지 마라(step0에서 확정). 이 step은 다이얼로그·테스트만 만진다.
5. **줄간격 숫자 저장**: select/number value(문자열)는 `Number()`로 변환해 저장한다.

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(`EditorPrefsDialog.test.jsx`, vitest):
- 편집 탭(`prefs-tab-edit`) 클릭 시 7개 필드(`pref-edit-columnLimit`/`-dragDrop`/`-noCommonAbbr`/`-companyCode`/`-language`/`-lineSpacing`/`-inputMode`)가 렌더되고 다른 탭 입력(`pref-color-title`)은 사라진다.
- 바이라인 탭(`prefs-tab-byline`) 클릭 시 4개 필드(`pref-byline-email`/`-emailValue`/`-blog`/`-blogValue`)가 렌더된다.
- 편집 탭에서 컬럼제한 체크 + 언어 `ja` 선택 + 줄간격 `1.5` 선택 후 '적용'(`prefs-apply`) → `loadEditorPrefs().edit`가 `{ columnLimit: true, language: 'ja', lineSpacing: 1.5(숫자), ... }`로 영속되고 `onClose(true)` 호출.
- 바이라인 탭에서 email 사용 체크 + email 값 입력 후 '적용' → `loadEditorPrefs().byline`이 `{ email: true, emailValue: '<입력값>', ... }`로 영속된다.
- **재오픈 복원**: 저장값이 있는 상태로 다시 열면(또는 open prop 토글) 편집/바이라인 폼이 저장값으로 초기화된다.
- **상호 보존**: 색상/자동저장/날짜형식을 바꾼 적 없이 편집 또는 바이라인만 바꿔 '적용'해도 적용 후 `loadEditorPrefs()`의 colors·autosave·dateFormat이 기존 값 그대로 유지된다(반대로 색상만 바꿔도 edit/byline 보존).
- '기본값'(`prefs-reset`) 클릭 시 편집/바이라인 폼이 `DEFAULT_EDITOR_PREFS.edit`/`.byline`으로 리셋된다.
- **회귀**: 기존 색상/자동저장/날짜형식 탭 테스트 전부 통과.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: ARCHITECTURE.md 디렉토리 구조 / ADR-003(editorPrefs는 view 모듈 — 서버 호출 없음) / CLAUDE.md CRITICAL(DB 비파괴 — 무관) / 기존 탭 회귀 없음 / Editor.jsx·WriterPage.jsx 무변경.
3. `phases/15-editor-prefs-tabs/index.json`의 step 1을 갱신한다(성공 → `completed` + `summary` / 3회 실패 → `error` + `error_message` / 개입 필요 → `blocked` + `blocked_reason`).

## DEFERRED EFFECTS

이 step은 편집/바이라인 값을 **저장만** 한다. 다음 동작은 결선하지 않는다:
- 편집>컬럼제한(좌우 여백 10% 축소) → **step4**(WriterPage 래퍼 레벨에서 안전 적용).
- 편집>드래그앤드롭 허용·언어 전환·줄간격 적용·입력모드(KSC-5601/Unicode)·공용약어/기업코드 변환 → **후속 phase**(Editor.jsx 내부/IME/aux-tools 소관 — 이 phase 범위 밖).
- 바이라인 상세보기 출력(작성자에 email/blog 부가 표시) → **후속 phase**(articleDetail/ListPage 렌더 경로 변경 필요 — 이 phase는 환경설정 UI까지만).

## 금지사항

- **WriterPage.jsx·Editor.jsx를 수정하지 마라.** 이유: 본 step은 환경설정 다이얼로그 UI + 영속만이고, effect 결선은 step4/후속 phase다(범위 격리·Editor 불변식 보호).
- `apply()`에서 colors/autosave/dateFormat 중 하나라도 누락하지 마라. 이유: 네 설정이 한 객체에 함께 저장되므로 누락 시 다른 탭 설정이 사라진다(상호 보존 위반).
- `editorPrefs.js`의 `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref` 시그니처·로직을 바꾸지 마라(step0 확정).
- 색상/자동저장/날짜형식 탭의 마크업·testid·동작을 바꾸지 마라(회귀 금지). 색상 탭은 건드리지 마라.
- 서버 저장(model.save/PUT/POST/articleUpdate)을 하지 마라. 이유: 환경설정은 localStorage 전용.
- 기존 테스트를 깨뜨리지 마라.
