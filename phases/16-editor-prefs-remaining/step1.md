# Step 1: edit-tab — 환경설정 '편집' 탭 (UI + 영속)

## 배경 / 요구사항

Step 0에서 store(`editorPrefs.js`)에 `edit` 카테고리 기본값이 갖춰졌다(`{ columnLimit, dragDrop, noCommonAbbr, companyCode, language, lineSpacing, inputMode }`). 이 step은 `EditorPrefsDialog.jsx`에 **편집(edit)** 탭 UI를 추가하고, 기존 적용/취소/기본값 패턴에 결선해 **localStorage 영속**까지 한다.

> **바이라인 탭은 이미 ship됨(PR #43)이라 만들지 않는다.** 현재 `PREF_TABS`에는 `colors`/`autosave`/`byline`/`dateFormat` 4탭이 이미 있다. 이 step은 거기에 `edit` 탭 1개만 추가한다.

설정값의 **실제 적용(effect)은 이 step에서 하지 않는다**(저장만). 컬럼제한 effect는 step4, 나머지(드래그앤드롭/언어/줄간격/입력모드/공용약어/기업코드)는 후속 phase로 defer(아래 DEFERRED EFFECTS).

탭에 들어갈 필드(news.md L184~192) — store 키 `edit`:
- 컬럼제한 — 체크박스, `data-testid="pref-edit-columnLimit"`.
- 드래그앤드롭 — 체크박스, `data-testid="pref-edit-dragDrop"`.
- 공용약어 사용안함 — 체크박스, `data-testid="pref-edit-noCommonAbbr"`.
- 기업코드 — select(수동=`manual`/자동=`auto`), `data-testid="pref-edit-companyCode"`.
- 언어 — select 9종(한글=`ko`/영어=`en`/일어=`ja`/중국어=`zh`/스페인=`es`/프랑스=`fr`/아랍어=`ar`/베트남=`vi`/러시아어=`ru`), `data-testid="pref-edit-language"`.
- 줄간격 — select 또는 number 입력(예 1.0/1.2/1.5/1.8/2.0), `data-testid="pref-edit-lineSpacing"`.
- 입력모드 — select(KSC-5601=`ksc5601`/Unicode=`unicode`), `data-testid="pref-edit-inputMode"`.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 컴포넌트(ADR-003: model/fetch 직접 호출 금지. 단 editorPrefs 같은 **view 모듈** 직접 호출은 서버 호출이 아니라 허용 — EditorPrefsDialog.jsx 상단 주석 참조).
- `/docs/news.md` L184~192(편집).
- `phases/16-editor-prefs-remaining/step0.md` — 신규 카테고리 키 이름·기본값·허용 enum 값의 **단일 출처**.
- `web/src/view/editorPrefs.js` — **step0 결과 반영됨**. `DEFAULT_EDITOR_PREFS.edit`, `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref`.
- `web/src/view/EditorPrefsDialog.jsx` — **변경 대상. 반드시 정독하라.** 핵심 패턴(그대로 미러링):
  - `PREF_TABS` 배열(현재 `colors`/`autosave`/`byline`/`dateFormat`).
  - 탭별 form state: `const [byline, setByline] = useState(() => loadEditorPrefs().byline);` 등.
  - `open` 재초기화 `useEffect([open])` 블록(다시 열 때 저장값으로 리셋 — `setByline(prefs.byline)` 등).
  - `apply()`: `colors`+`autosave`+`byline`을 `setEditorPref` 중첩 체인으로 합성하고 `dateFormat`을 spread로 보존 → `saveEditorPrefs(next)` → `setEditorColors(...)` → `onClose(true)`.
  - `reset()`: 폼을 `DEFAULT_EDITOR_PREFS`로 리셋.
  - 탭 렌더 블록 `{tab === 'byline' && (...)}` 형태.
  - testid 컨벤션: `prefs-tab-${key}`, `pref-<category>-<field>`.
- `web/src/view/EditorPrefsDialog.test.jsx` — **변경 대상**(신규 단언 추가). 기존 색상/자동저장/바이라인/날짜형식 탭 테스트 스타일(탭 렌더·입력·apply 영속·상호 보존·reset)을 미러링.

## 작업

TDD로 진행한다(vitest + @testing-library/react). **테스트를 먼저 쓰고 통과시킨다.**

### 1. `PREF_TABS`에 편집 탭 1개 추가

news.md 환경설정 순서(편집·자동저장·색상·바이라인·날짜형식)를 고려해 자연스러운 위치에 `{ key: 'edit', label: '편집' }`를 추가한다(권장: 배열 앞쪽, `colors` 근처). 기존 4탭(colors/autosave/byline/dateFormat) 항목·testid·순서 동작은 깨지 않는다(회귀 금지).

### 2. form state + open 재초기화 + reset (기존 3-지점 동기화 패턴 그대로)

기존 colors/autosave/byline 처럼 다음 3곳을 **모두** 갱신한다(누락 시 재오픈 시 저장값 복원 불변식이 편집 탭에서만 깨짐):
- `const [edit, setEdit] = useState(() => loadEditorPrefs().edit);`
- `open` 재초기화 `useEffect([open])` 블록에 `setEdit(prefs.edit);` 추가.
- `reset()`에 `setEdit(DEFAULT_EDITOR_PREFS.edit);` 추가.

각 필드 onChange는 `setEdit((s) => ({ ...s, <field>: <value> }))` 패턴(`setByline` 미러). 줄간격 select/number value는 문자열이므로 저장 시 `Number()`로 변환한다(autosave `intervalSec`과 동일 처리).

### 3. `apply()` 합성 체인에 edit 추가 (**상호 보존 필수**)

기존 `apply()`는 `next = { ...setEditorPref(setEditorPref(setEditorPref(loadEditorPrefs(), 'colors', {...}), 'autosave', {...}), 'byline', {...}), dateFormat }` 형태로 colors·autosave·byline을 합성하고 dateFormat은 spread로 보존한다. 여기에 `edit`를 **같은 `setEditorPref` 체인**으로 한 단계 더 끼운다:

```js
const next = {
  ...setEditorPref(
    setEditorPref(
      setEditorPref(
        setEditorPref(loadEditorPrefs(), 'colors', { title, subtitle, body, background }),
        'autosave', { enabled, intervalSec: Number(intervalSec), retentionDays: Number(retentionDays) }),
      'byline', { email, emailValue, blog, blogValue }),
    'edit', { columnLimit, dragDrop, noCommonAbbr, companyCode, language, lineSpacing: Number(lineSpacing), inputMode }),
  dateFormat,
};
saveEditorPrefs(next);
```

**결과 `next`에 colors·autosave·byline·edit·dateFormat이 모두 누락 없이 담겨야 한다**(상호 보존). step2/step3가 추가할 spellcheck/glyphFavorites/glyphKeymap은 아직 합성에 없어도 된다 — **`loadEditorPrefs()`를 base로 spread하므로 명시 합성하지 않은 카테고리도 저장값이 보존된다**(그 동작을 깨지 마라). 정확한 체인 형태는 실제 코드를 정독해 현재 합성 순서에 맞춰 끼운다(위는 예시).

### 4. 탭 렌더 블록 추가

`{tab === 'edit' && (...)}` 블록을 기존 `{tab === 'byline' && ...}` 패턴으로 추가한다. 각 입력은 `id`/`data-testid`를 위 배경의 testid 그대로 부여하고 `value`/`checked`를 state에 바인딩한다. select 옵션 라벨은 한국어 표시(예: 언어 select는 `<option value="ko">한글</option>` 등), value는 enum 코드.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **저장-only(effect 금지)**: 이 step은 값 저장만 한다. columnLimit/dragDrop/language/inputMode 등의 실제 동작을 결선하지 마라(아래 DEFERRED EFFECTS). 특히 **WriterPage.jsx·Editor.jsx를 건드리지 마라**(컬럼제한 effect는 step4).
2. **상호 보존**: `apply()`가 colors·autosave·byline·edit·dateFormat을 한 객체로 함께 저장한다(+`loadEditorPrefs()` base spread로 spellcheck/glyph 등 미합성 카테고리도 보존). 하나라도 누락하면 다른 탭 설정이 사라진다.
3. **기존 탭 회귀 금지**: 색상/자동저장/바이라인/날짜형식 탭의 마크업·testid·apply/취소/기본값 동작과 그 테스트가 그대로 통과해야 한다. 색상 탭은 절대 건드리지 마라. 부제목색 기본 `#c8102e` 유지.
4. **store 시그니처 불변**: `editorPrefs.js`의 `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref`를 수정하지 마라(step0에서 확정). 이 step은 다이얼로그·테스트만 만진다.
5. **줄간격 숫자 저장**: select/number value(문자열)는 `Number()`로 변환해 저장한다.
6. **바이라인 탭 재구현 금지**: byline 탭은 이미 ship됨 — 새로 만들거나 마크업을 바꾸지 마라(회귀).

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(`EditorPrefsDialog.test.jsx`, vitest):
- 편집 탭(`prefs-tab-edit`) 클릭 시 7개 필드(`pref-edit-columnLimit`/`-dragDrop`/`-noCommonAbbr`/`-companyCode`/`-language`/`-lineSpacing`/`-inputMode`)가 렌더되고 다른 탭 입력(`pref-color-title`)은 사라진다.
- 편집 탭에서 컬럼제한 체크 + 언어 `ja` 선택 + 줄간격 `1.5` 선택 후 '적용'(`prefs-apply`) → `loadEditorPrefs().edit`가 `{ columnLimit: true, language: 'ja', lineSpacing: 1.5(숫자), ... }`로 영속되고 `onClose(true)` 호출.
- **재오픈 복원**: 저장값이 있는 상태로 다시 열면(open prop 토글) 편집 폼이 저장값으로 초기화된다.
- **상호 보존**: 색상/자동저장/바이라인/날짜형식을 바꾼 적 없이 편집만 바꿔 '적용'해도 적용 후 `loadEditorPrefs()`의 colors·autosave·byline·dateFormat이 기존 값 그대로 유지된다(반대로 색상만 바꿔도 edit 보존).
- '기본값'(`prefs-reset`) 클릭 시 편집 폼이 `DEFAULT_EDITOR_PREFS.edit`로 리셋된다.
- **회귀**: 기존 색상/자동저장/바이라인/날짜형식 탭 테스트 전부 통과.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: ARCHITECTURE.md 디렉토리 구조 / ADR-003(editorPrefs는 view 모듈 — 서버 호출 없음) / CLAUDE.md CRITICAL(DB 비파괴 — 무관, server/ 무변경) / 기존 탭 회귀 없음 / Editor.jsx·WriterPage.jsx 무변경.
3. `phases/16-editor-prefs-remaining/index.json`의 step 1을 갱신한다(성공 → `completed` + `summary` / 3회 실패 → `error` + `error_message` / 개입 필요 → `blocked` + `blocked_reason`).
4. 작업 종료 후 Slack harness 채널에 결과를 보고한다(오케스트레이터 소관).

## DEFERRED EFFECTS

이 step은 편집 값을 **저장만** 한다. 다음 동작은 결선하지 않는다:
- 편집>컬럼제한(좌우 여백 10% 축소) → **step4**(WriterPage 래퍼 레벨에서 안전 적용).
- 편집>드래그앤드롭 허용·언어 전환·줄간격 적용·입력모드(KSC-5601/Unicode)·공용약어/기업코드 변환 → **후속 phase**(Editor.jsx 내부/IME/aux-tools 소관 — 이 phase 범위 밖).

## 금지사항

- **WriterPage.jsx·Editor.jsx를 수정하지 마라.** 이유: 본 step은 환경설정 다이얼로그 UI + 영속만이고, effect 결선은 step4/후속 phase다(범위 격리·Editor 타이핑/IME/캐럿/remount 불변식 보호).
- `apply()`에서 colors/autosave/byline/dateFormat 중 하나라도 누락하지 마라. 이유: 모든 설정이 한 객체에 함께 저장되므로 누락 시 다른 탭 설정이 사라진다(상호 보존 위반).
- `editorPrefs.js`의 `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref` 시그니처·로직을 바꾸지 마라(step0 확정).
- 색상/자동저장/바이라인/날짜형식 탭의 마크업·testid·동작을 바꾸지 마라(회귀 금지). 색상 탭·byline 탭은 건드리지 마라.
- 서버 저장(model.save/PUT/POST/articleUpdate)을 하지 마라. 이유: 환경설정은 localStorage 전용(server/ 무변경).
- 기존 테스트를 깨뜨리지 마라.
