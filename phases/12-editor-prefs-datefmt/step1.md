# Step 1: datefmt-dialog-tab — 환경설정 탭화 + 날짜형식 탭 + ListPage 적용

## 배경 / 요구사항

Step 0에서 `listFormat`이 9종 형식을 지원하고 `setDateFormat`으로 현재 형식을 바꿀 수 있게 됐다. 이 step은:
1. `EditorPrefsDialog`를 **탭 구조**로 만든다(현재는 색상 단일 폼). 탭: **색상 / 날짜형식**. (후속 phase가 자동저장/바이라인 탭을 더한다.)
2. **날짜형식 탭**: 9종 select, 저장(`editorPrefs.dateFormat`).
3. **ListPage 적용**: 조회페이지(list.do) 마운트 시 저장된 형식을 `setDateFormat`으로 적용 → 날짜 컬럼이 선택 형식으로 표시.

환경설정 모달은 작성페이지(writer.do)에서 열리고 날짜는 조회페이지(list.do)에서 표시되는 별개 SPA 뷰다. 모달은 형식을 **localStorage에 저장만** 하고, ListPage가 자기 마운트 시 읽어 적용한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view, ADR-003
- `/docs/news.md` — "# 에디터 환경설정 > 날짜형식", "기사 조회페이지" 날짜 컬럼
- `web/src/view/listFormat.js` — **Step 0 결과**: `DATE_FORMATS`, `DEFAULT_DATE_FORMAT`, `setDateFormat`, `formatDateTime`/`formatCell`.
- `web/src/view/editorPrefs.js` — `loadEditorPrefs()`, `saveEditorPrefs()`, `setEditorPref(prefs,'dateFormat',value)`(원시값 — setEditorPref가 category 'dateFormat'에 원시값을 어떻게 다루는지 확인; 객체 병합이 아니라 원시 교체가 맞다. 필요하면 `{ ...prefs, dateFormat: value }` 직접 구성). `DEFAULT_EDITOR_PREFS.dateFormat`.
- `web/src/view/EditorPrefsDialog.jsx` — **phase 11 결과**(색상 단일 폼: `COLOR_FIELDS`, `apply`/`cancel`/`reset`, `yh-prefs` 모달, 제목 "환경설정 — 색상"). **여기에 탭 구조를 도입**한다.
- `web/src/view/EditorPrefsDialog.test.jsx` — 기존 색상 단언(회귀 기준).
- `web/src/view/ListPage.jsx` — 마운트/조회 effect, `formatCell` 사용처. 여기서 `setDateFormat(loadEditorPrefs().dateFormat)`를 적용한다.
- `web/src/view/ListPage.test.jsx`, `web/src/styles/yonhap.css` — 회귀/탭 스타일.

## 작업

TDD로 진행한다(vitest).

### 1. EditorPrefsDialog 탭화 (`EditorPrefsDialog.jsx`)

- 모달 안에 **탭 네비**(색상 / 날짜형식)를 둔다(`data-testid`: `prefs-tab-colors`, `prefs-tab-dateFormat`). 활성 탭만 폼을 보여준다.
- **색상 탭은 phase 11 동작·testid(`pref-color-*`, `prefs-apply/cancel/reset`)·적용/취소 로직을 그대로 보존**한다(회귀 금지). 제목은 "환경설정"으로 일반화하거나 탭에 따라 갱신.
- **날짜형식 탭**: `DATE_FORMATS` 9종 select(`data-testid="pref-dateFormat"`), 초기값 `loadEditorPrefs().dateFormat`.
- **적용(`apply`)**: 색 + 날짜형식을 함께 저장한다. 날짜형식은 `const next = { ...loadEditorPrefs(), dateFormat };`처럼 원시값 교체로 저장(+ 색은 기존 로직). `saveEditorPrefs(next)` 후 `setEditorColors(...)`(기존) — 날짜형식은 writer 화면에 즉시 보일 대상이 없으므로 setDateFormat을 여기서 부르지 않아도 된다(ListPage가 마운트 시 적용). `onClose(true)`.
  - 단순화를 위해 적용은 "현재 폼의 색 + 날짜형식 모두 저장"으로 한 번에 처리한다(탭 전환해도 미적용 값이 보존되게 폼 상태를 모달 레벨에 둔다).
- 취소/기본값은 phase 11 동작 유지(기본값은 활성 탭 기준 또는 전체 — 색은 DEFAULT 색, 날짜형식은 DEFAULT_EDITOR_PREFS.dateFormat).

### 2. ListPage 적용 (`ListPage.jsx`)

- 마운트 시 저장된 날짜형식을 적용: `useEffect(() => { setDateFormat(loadEditorPrefs().dateFormat); }, []);` (조회/리렌더보다 먼저 — 첫 렌더 전 적용이 이상적이나, effect 후 재조회/재렌더로 반영돼도 무방. 단순/안정 우선).
- `formatCell`/`formatDateTime` 호출부는 그대로(형식은 module 상태로 적용됨).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **색상 탭 회귀 금지**: phase 11 색상 폼·적용/취소/기본값·testid·동작을 보존(탭 안으로 옮기되 깨지 마라).
2. **저장+적용 정합**: 날짜형식은 모달에서 **저장**(editorPrefs), ListPage 마운트에서 **적용**(setDateFormat). 한쪽만 하지 마라.
3. **ADR-003**: 서버/model/fetch 금지(클라 localStorage·module 상태).
4. **격리(테스트)**: 신규 describe의 `beforeEach`에 `localStorage.clear()`, `afterEach`에 `setDateFormat(DEFAULT_DATE_FORMAT)`(및 색 테스트는 `resetEditorColors`). module/localStorage 누수 방지.
5. **Editor 무관**: 이 step은 다이얼로그/리스트만 — `Editor.jsx`를 건드리지 마라.

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(vitest):
- 모달에 색상/날짜형식 탭이 있고 전환된다. 색상 탭의 기존 단언(색 변경·적용 → colorForRole 반영)이 불변.
- 날짜형식 탭에서 형식 선택 후 '적용' → `loadEditorPrefs().dateFormat`이 새 값(saveEditorPrefs 호출).
- ListPage 마운트 시 `setDateFormat(loadEditorPrefs().dateFormat)` 적용 → 저장 형식이 'YYYY.MM.DD'일 때 날짜 셀이 그 형식으로 표시(`formatCell('createdAt', iso)` 또는 렌더 검증).
- 저장값 없을 때 기본 형식('YYYY-MM-DD HH:mm') 유지(회귀).

## 검증 절차

1. AC 실행. 2. 아키텍처 체크(view 결선, ADR-003, 저장+적용, Editor 무관). 3. `phases/12-editor-prefs-datefmt/index.json` step 1 갱신(성공 completed+summary / 실패 error / 개입 blocked).

## 금지사항

- 색상 탭 동작/testid를 깨뜨리지 마라(phase 11 회귀).
- 저장만 하고 ListPage 적용 안 하거나, 적용만 하고 저장 안 하지 마라.
- 자동저장/바이라인 탭을 이번에 구현하지 마라(후속 phase — 이번은 색상(기존)+날짜형식).
- `Editor.jsx`/서버/model/fetch를 건드리지 마라.
- 기존 테스트를 깨뜨리지 마라.
