# Step 3: glyph-tabs — '자주쓰는 약물' + '사용자 키보드 약물' 탭 (등록/목록 UI + 영속)

## 배경 / 요구사항

Step 0에서 store(`editorPrefs.js`)에 `glyphFavorites = { items: [] }`·`glyphKeymap = { items: [] }` 기본값이 갖춰졌다. 이 step은 `EditorPrefsDialog.jsx`에 **자주쓰는 약물(glyphFavorites)** 탭과 **사용자 키보드 약물(glyphKeymap)** 탭 UI를 추가한다. 둘 다 목록형(등록/삭제/목록) UI라 한 step으로 묶는다.

**범위는 등록/목록/삭제 UI + localStorage 영속까지다.** 약물의 실제 **에디터 입력 동작·약물바(glyph bar)·키조합 인터셉트는 이 step에서 하지 않는다**(aux-tools 후속 phase 소관 — 아래 DEFERRED EFFECTS). WriterPage에 `showGlyphBar` placeholder 토글이 이미 있으나 그 바는 미렌더 상태이며 이 step과 무관하다(건드리지 마라).

탭에 들어갈 것(news.md L206~209):

**자주쓰는 약물(glyphFavorites)** — store 키 `glyphFavorites.items: string[]`(약물 문자열 목록):
- 약물 입력 text + '등록' 버튼 — `data-testid="pref-glyphFav-input"`, `data-testid="pref-glyphFav-add"`.
- 등록된 약물 목록 — 각 항목에 삭제 버튼. 목록 컨테이너 `data-testid="pref-glyphFav-list"`, 각 항목 `data-testid="pref-glyphFav-item-{index}"`, 삭제 버튼 `data-testid="pref-glyphFav-remove-{index}"`.

**사용자 키보드 약물(glyphKeymap)** — store 키 `glyphKeymap.items: { keys: string, glyph: string }[]`:
- 키조합 text + 약물 text + '등록' 버튼 — `data-testid="pref-glyphKey-keys"`, `data-testid="pref-glyphKey-glyph"`, `data-testid="pref-glyphKey-add"`.
- 등록된 매핑 목록 — `data-testid="pref-glyphKey-list"`, 각 항목 `data-testid="pref-glyphKey-item-{index}"`, 삭제 버튼 `data-testid="pref-glyphKey-remove-{index}"`.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 컴포넌트(ADR-003: editorPrefs는 view 모듈 직접 호출 허용).
- `/docs/news.md` L206~209(자주쓰는 약물 / 사용자 키보드 약물).
- `phases/15-editor-prefs-tabs/step0.md` — `glyphFavorites`/`glyphKeymap` 키 구조·기본값(`items: []`)의 **단일 출처**.
- `web/src/view/editorPrefs.js` — **step0 결과 반영됨**. `DEFAULT_EDITOR_PREFS.glyphFavorites`/`.glyphKeymap`, `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref`.
- `web/src/view/EditorPrefsDialog.jsx` — **변경 대상**. step1/step2가 추가한 탭들이 이미 있을 수 있다(같은 phase). `PREF_TABS`, form state 패턴, `open` 재초기화, `apply()` 합성 체인, `reset()`, 탭 렌더 블록, testid 컨벤션을 미러링.
- `web/src/view/EditorPrefsDialog.test.jsx` — **변경 대상**(신규 단언 추가).

## 작업

TDD로 진행한다(vitest + @testing-library/react). **테스트를 먼저 쓰고 통과시킨다.**

### 1. `PREF_TABS`에 탭 2개 추가

`{ key: 'glyphFavorites', label: '자주쓰는 약물' }`, `{ key: 'glyphKeymap', label: '사용자 키보드 약물' }`를 (맞춤법 근처) 약물군 위치에 추가한다. 기존 탭 순서 동작은 깨지 않는다.

### 2. form state + open 재초기화 + reset (3-지점 동기화) + 등록/삭제 로컬 입력 state

- `const [glyphFav, setGlyphFav] = useState(() => loadEditorPrefs().glyphFavorites);`
- `const [glyphKey, setGlyphKey] = useState(() => loadEditorPrefs().glyphKeymap);`
- `open` 재초기화 `useEffect([open])`에 `setGlyphFav(prefs.glyphFavorites); setGlyphKey(prefs.glyphKeymap);` 추가.
- `reset()`에 `setGlyphFav(DEFAULT_EDITOR_PREFS.glyphFavorites); setGlyphKey(DEFAULT_EDITOR_PREFS.glyphKeymap);` 추가.
- 등록 입력칸용 별도 로컬 state(미커밋 입력 버퍼): `favInput`(string), `keyInputKeys`/`keyInputGlyph`(string) 등.

**등록/삭제는 순수 배열 연산으로 처리한다**(mutate 금지):
- 자주쓰는 약물 등록: 입력이 공백 아니면 `setGlyphFav((g) => ({ ...g, items: [...g.items, favInput.trim()] }))` 후 입력 비움. 빈 입력은 no-op.
- 자주쓰는 약물 삭제(index): `setGlyphFav((g) => ({ ...g, items: g.items.filter((_, i) => i !== index) }))`.
- 키보드 약물 등록: keys·glyph 둘 다 비어있지 않을 때만 `setGlyphKey((g) => ({ ...g, items: [...g.items, { keys, glyph }] }))`.
- 키보드 약물 삭제(index): filter로 제거.

**중요(저장-on-apply vs 즉시 저장 결정):** 이 다이얼로그의 다른 탭은 '적용' 버튼에서만 영속한다. 일관성을 위해 **목록 편집(등록/삭제)도 form state에만 반영하고 '적용' 시점에 영속**한다. 즉 등록/삭제 후 '적용'을 눌러야 localStorage에 저장되고, '취소'하면 목록 변경도 버려진다(다른 탭과 동일한 적용/취소 의미). 등록 직후 자동 저장하지 마라(취소 의미와 충돌).

### 3. `apply()` 합성 체인에 glyphFavorites·glyphKeymap 추가 (상호 보존)

기존 `setEditorPref` 체인에 두 카테고리를 끼운다 — `setEditorPref(prev, 'glyphFavorites', { items: glyphFav.items })`, `setEditorPref(prev, 'glyphKeymap', { items: glyphKey.items })`. **items 배열 전체를 넘긴다.** colors·autosave·edit·byline·dateFormat·spellcheck·glyphFavorites·glyphKeymap이 결과 `next`에 누락 없이 담겨야 한다(상호 보존).

### 4. 탭 렌더 블록 추가

`{tab === 'glyphFavorites' && (...)}` / `{tab === 'glyphKeymap' && (...)}`. 입력칸·등록 버튼·목록(map으로 `items` 렌더, 각 항목에 삭제 버튼)을 위 배경의 testid로 구성한다. 목록이 비면 빈 목록 컨테이너만 렌더(빈 상태 텍스트는 선택).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **등록/목록/영속까지만(effect 금지)**: 약물의 에디터 입력·약물바·키조합 인터셉트를 결선하지 마라(아래 DEFERRED EFFECTS). **Editor.jsx·WriterPage.jsx를 건드리지 마라.** 특히 WriterPage의 `showGlyphBar`/약물바 placeholder를 손대지 마라(별개 — aux-tools 소관).
2. **순수 배열 연산**: 등록/삭제는 `[...arr, x]`/`filter`로 새 배열 생성(기존 배열 mutate 금지 — `push`/`splice` 금지). 이유: React state 불변성·예측 가능한 리렌더.
3. **적용 시 영속**: 목록 변경은 form state에만 두고 '적용' 시 저장한다(다른 탭과 동일한 적용/취소 의미). 등록 즉시 localStorage에 쓰지 마라.
4. **items 배열 통째 저장**: `apply()`에서 items 배열 전체를 넘긴다(한 단계 병합).
5. **상호 보존**: 8개 카테고리(colors·autosave·edit·byline·dateFormat·spellcheck·glyphFavorites·glyphKeymap)를 함께 저장한다.
6. **기존 탭 회귀 금지**: 모든 선행 탭과 그 테스트가 그대로 통과.
7. **store 시그니처 불변**: `editorPrefs.js`를 수정하지 마라(step0 확정).

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(`EditorPrefsDialog.test.jsx`, vitest):
- 자주쓰는 약물 탭(`prefs-tab-glyphFavorites`) 클릭 시 입력(`pref-glyphFav-input`)·등록(`pref-glyphFav-add`)·목록(`pref-glyphFav-list`)이 렌더된다.
- 약물 문자열 입력 + 등록 클릭 → 목록에 항목(`pref-glyphFav-item-0`)이 추가되고 입력칸이 비워진다. 빈 입력으로 등록 클릭은 no-op(항목 안 늘어남).
- 항목 삭제(`pref-glyphFav-remove-0`) 클릭 → 그 항목이 목록에서 사라진다.
- '적용'(`prefs-apply`) → `loadEditorPrefs().glyphFavorites.items`에 등록한 약물이 영속되고 `onClose(true)`.
- 사용자 키보드 약물 탭(`prefs-tab-glyphKeymap`): keys·glyph 입력 후 등록 → 목록에 `{ keys, glyph }` 항목 추가. keys 또는 glyph가 비면 등록 no-op. '적용' 후 `loadEditorPrefs().glyphKeymap.items`에 `{ keys, glyph }`가 영속.
- **취소 시 목록 변경 버려짐**: 항목을 등록한 뒤 '취소'(`prefs-cancel`)하면 `loadEditorPrefs().glyphFavorites.items`가 변경 전 상태(빈 배열 등)로 남는다.
- **재오픈 복원**: 저장된 items가 있으면 다시 열 때 목록이 그 items로 렌더된다.
- **상호 보존**: 약물만 바꿔 '적용'해도 colors·autosave·edit·byline·dateFormat·spellcheck가 기존 값 그대로 유지된다.
- '기본값'(`prefs-reset`) 클릭 시 두 약물 목록이 빈 배열로 리셋된다.
- **회귀**: 모든 선행 탭 테스트 전부 통과.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: ADR-003(editorPrefs는 view 모듈 — 서버 호출 없음) / DB 비파괴(무관) / 기존 탭 회귀 없음 / Editor.jsx·WriterPage.jsx 무변경 / 순수 배열 연산(mutate 없음).
3. `phases/15-editor-prefs-tabs/index.json`의 step 3을 갱신한다(성공 → `completed` + `summary` / 3회 실패 → `error` + `error_message` / 개입 필요 → `blocked` + `blocked_reason`).

## DEFERRED EFFECTS

이 step은 약물 등록/목록을 **저장만** 한다. 다음은 결선하지 않는다:
- 등록된 약물의 에디터 본문 입력(약물 입력 Alt+O — news.md L173)·약물바(glyph bar) 렌더·사용자 키조합 인터셉트(키 입력 → 약물 치환) → **aux-tools 후속 phase**(Editor 입력 경로·키 핸들러 변경 필요 — 이 phase 범위 밖).

## 금지사항

- **Editor.jsx·WriterPage.jsx를 수정하지 마라.** 이유: 약물 입력/약물바/키조합 인터셉트는 aux-tools 후속 phase이며, Editor 타이핑/IME/캐럿 불변식을 보호해야 한다.
- WriterPage의 `showGlyphBar`/약물바 placeholder를 건드리지 마라(별개 — 이 step과 무관).
- 등록/삭제에서 배열을 mutate하지 마라(`push`/`splice`/직접 인덱스 할당 금지). 이유: React state 불변성.
- 목록 변경을 등록 즉시 localStorage에 쓰지 마라(적용/취소 의미와 충돌 — '적용' 시 영속).
- `apply()`에서 8개 카테고리 중 하나라도 누락하지 마라(상호 보존).
- `editorPrefs.js`의 store 함수 시그니처·로직을 바꾸지 마라(step0 확정).
- 기존 탭의 마크업·testid·동작을 바꾸지 마라(회귀 금지).
- 서버 저장을 하지 마라(localStorage 전용).
- 기존 테스트를 깨뜨리지 마라.
