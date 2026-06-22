# Step 0: byline-prefs-tab — 환경설정 '바이라인' 탭 (store 확장 + 다이얼로그 UI)

## 배경 / 요구사항

에디터 환경설정(EditorPrefsDialog)에는 현재 **색상 / 자동저장 / 날짜형식** 3개 탭만 있다. news.md(172, 201-203)는 **바이라인** 탭에 `E-MAIL 사용여부`·`Blog 사용여부`를 둔다고 명시한다. 이 step은 그 **바이라인 탭**을 추가하고 영속까지 결선한다.

핵심 결정(이미 확정됨 — 이 파일이 단일 출처):
- 작성자의 email/blog 값은 DB·세션 어디에도 없다(USER 테이블 컬럼: userId/name/password/role/department/departmentCode/active — email/blog 없음). 따라서 **바이라인 탭이 email/blog 값 자체를 입력받아 localStorage(editorPrefs)에 저장**한다.
- 즉 바이라인 설정 = `{ email: 사용여부(bool), emailValue: 값(str), blog: 사용여부(bool), blogValue: 값(str) }`.
- 실제 **출력(상세보기 작성자에 부가 표시)은 Step 1**에서 한다. 이 step은 store 확장 + 탭 UI + 영속(apply)까지만.

이 설정은 **클라이언트 localStorage 전용**이다 — 서버 저장(model.save/PUT/POST)과 무관하다.

## 읽어야 할 파일

먼저 아래를 읽고 기존 설계 의도·패턴을 정확히 파악하라. **색상/자동저장/날짜형식 탭이 쓰는 패턴을 그대로 미러링**하는 것이 이 step의 핵심이다.

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` (특히 ADR-003: view 컴포넌트는 model/fetch 직접 호출 금지. 단 editorPrefs/editorColoring 같은 **view 모듈** 직접 호출은 서버 호출이 아니므로 허용 — EditorPrefsDialog 상단 주석 참조).
- `web/src/view/editorPrefs.js` — `DEFAULT_EDITOR_PREFS`(colors/autosave/**byline**/dateFormat), `loadEditorPrefs`(카테고리별 **얕은 병합**), `saveEditorPrefs`, `setEditorPref`(순수·비-mutate 카테고리 병합). **byline 키는 이미 `{ email: false, blog: false }`로 존재**한다(값 필드 emailValue/blogValue만 추가하면 된다).
- `web/src/view/EditorPrefsDialog.jsx` — `PREF_TABS`, 탭별 form state(`useState(() => loadEditorPrefs().X)`), `open` 시 재초기화 `useEffect`, `apply()`(colors+autosave를 `setEditorPref`로 합성 + dateFormat spread로 보존), `reset()`, 탭 렌더 블록(`{tab === 'colors' && ...}` 등)과 testid 컨벤션(`prefs-tab-${key}`, `pref-<category>-<field>`).
- `web/src/view/EditorPrefsDialog.test.jsx` — 기존 색상/자동저장/날짜형식 탭 테스트 패턴(탭 렌더·입력·apply 영속·상호 보존·reset). 신규 바이라인 테스트를 같은 스타일로 추가한다.

## 작업

TDD로 진행한다(vitest + @testing-library/react). 테스트를 먼저 쓰고 통과시킨다.

### 1. store 확장 — `editorPrefs.js`

- `DEFAULT_EDITOR_PREFS.byline`을 `{ email: false, emailValue: '', blog: false, blogValue: '' }`로 확장한다.
- **`loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref` 시그니처·로직은 바꾸지 마라.** 이유: `loadEditorPrefs`는 `byline: { ...DEFAULT.byline, ...(saved.byline||{}) }`로 이미 얕은 병합하므로, 기본값에 새 키(emailValue/blogValue)를 추가하면 **과거에 `{email,blog}`만 저장된 prefs도 자동으로 새 키를 기본값으로 노출**한다(하위호환). 추가 로직 불필요.

### 2. 바이라인 탭 — `EditorPrefsDialog.jsx`

색상/자동저장/날짜형식과 **동일한 패턴**으로 다음을 추가한다:

- `PREF_TABS`에 `{ key: 'byline', label: '바이라인' }`를 추가한다(권장 위치: `autosave`와 `dateFormat` 사이 — news.md 환경설정 순서가 …색상·바이라인·날짜형식이므로).
- form state: `const [byline, setByline] = useState(() => loadEditorPrefs().byline);`
- `open` 재초기화 `useEffect`에 `setByline(prefs.byline);`를 추가한다(다른 탭과 함께).
- `reset()`에 `setByline(DEFAULT_EDITOR_PREFS.byline);`를 추가한다.
- `apply()`에서 byline을 **기존 합성 체인에 추가**한다 — `setEditorPref(prev, 'byline', { email, emailValue, blog, blogValue })` 형태로 colors/autosave와 같은 방식으로 합성하고, dateFormat은 기존대로 spread 보존. **결과 `next`에 colors·autosave·byline·dateFormat 네 설정이 모두 누락 없이 담겨야 한다**(상호 보존 — 아래 금지사항 참조).
- 탭 렌더 블록 `{tab === 'byline' && ( ... )}`을 추가한다. 필드 4개:
  - `E-MAIL 사용` 체크박스 — `id`/`data-testid` = `pref-byline-email`, `checked={byline.email}`.
  - email 값 입력 — `type="text"`, `data-testid` = `pref-byline-emailValue`, `value={byline.emailValue}`.
  - `Blog 사용` 체크박스 — `data-testid` = `pref-byline-blog`, `checked={byline.blog}`.
  - blog 값 입력 — `type="text"`, `data-testid` = `pref-byline-blogValue`, `value={byline.blogValue}`.
  - 각 onChange는 `setByline((b) => ({ ...b, <field>: <value> }))` 패턴(자동저장 탭의 `setAutosave` 미러).

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(EditorPrefsDialog.test.jsx, vitest):
- 바이라인 탭(`prefs-tab-byline`) 클릭 시 4개 필드(`pref-byline-email`/`-emailValue`/`-blog`/`-blogValue`)가 렌더된다.
- email 사용 체크 + email 값 입력 후 '적용'(`prefs-apply`) → `loadEditorPrefs().byline`이 `{ email: true, emailValue: '<입력값>', ... }`로 영속된다.
- **상호 보존**: 색상/자동저장/날짜형식 값을 바꾼 적 없이 바이라인만 바꿔 적용해도, 적용 후 `loadEditorPrefs()`의 colors·autosave·dateFormat이 **기존 값 그대로 유지**된다(반대로 색상만 바꿔 적용해도 byline 보존). 즉 apply가 네 설정을 함께 저장한다.
- '기본값'(`prefs-reset`) 클릭 시 바이라인 폼이 `{ email:false, emailValue:'', blog:false, blogValue:'' }`로 리셋된다.
- 기존 색상/자동저장/날짜형식 탭 테스트 전부 통과(회귀 없음).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: ARCHITECTURE.md 디렉토리 구조 준수 / ADR-003(서버 호출 없음 — editorPrefs는 view 모듈) / CLAUDE.md CRITICAL(DB 비파괴 — 이 step은 DB 무관) 위반 없음.
3. `phases/15-editor-prefs-byline/index.json`의 step 0을 갱신한다(성공 → `completed` + `summary`에 산출물 한 줄 요약 / 3회 실패 → `error` + `error_message` / 개입 필요 → `blocked` + `blocked_reason`).

## 금지사항

- **서버 저장을 하지 마라**(model.save/PUT/POST/articleUpdate 등). 이유: 바이라인은 localStorage(editorPrefs) 전용 설정이다.
- **`apply()`에서 colors/autosave/dateFormat 중 하나라도 누락하지 마라.** 이유: 네 설정이 한 객체에 함께 저장되므로, byline만 저장하고 나머지를 빠뜨리면 다른 탭 설정이 사라진다(상호 보존 위반).
- `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref`의 시그니처·병합 로직을 바꾸지 마라. 이유: 얕은 병합이 이미 새 키를 하위호환으로 처리한다.
- 색상/자동저장/날짜형식 탭의 마크업·testid·동작을 바꾸지 마라(회귀 금지).
- 기존 테스트를 깨뜨리지 마라.
