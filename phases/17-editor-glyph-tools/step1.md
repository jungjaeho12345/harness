# Step 1: glyph-bar-component — 약물바(glyph bar) 표시 컴포넌트

## 배경 / 요구사항

약물바(glyph bar)는 자주쓰는 약물(`editorPrefs.glyphFavorites.items`, string[])을 버튼으로 렌더하는 막대다(news.md L173 "약물바 보이기"). 사용자가 약물 버튼을 클릭하면 현재 캐럿 위치에 그 약물이 삽입된다. 이 step은 그 **순수 표시 컴포넌트** `web/src/view/EditorGlyphBar.jsx`를 만든다(결선은 Step 2).

기존 `EditorToolBar.jsx`(쉘 툴바)·`EditorMenuBar.jsx`·`EditorContextMenu.jsx`와 **동일한 순수 표시 컴포넌트 패턴**(ADR-003 — model/fetch/transport 없음, 클릭은 props 콜백으로 위임)을 따른다. 데이터(약물 목록)는 props로 주입받고, 클릭 시 `onPick(glyph)`로 부모에 위임한다. 약물바 자체는 localStorage를 읽지 않는다(Step 2 WriterPage가 `loadEditorPrefs`로 읽어 주입).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003(view는 순수 표시, transport 비의존), Model←Controller←View.
- `/docs/news.md` — L173("약물바 보이기"), L206~209(자주쓰는 약물).
- `web/src/view/EditorToolBar.jsx` — **참고 패턴**: 순수 표시 컴포넌트, 버튼 config 배열, `data-testid`/`aria-label`, `onSelect` 콜백 위임, `role="toolbar"`.
- `web/src/view/EditorContextMenu.jsx` — **참고 패턴**: 항목 클릭 시 `onSelect(item.id)` 위임, 빈 목록 graceful, 전용 클래스/testid로 조회페이지 메뉴와 충돌 회피.
- `web/src/view/editorPrefs.js` — `glyphFavorites: { items: [] }`(string[]) 구조 확인(컴포넌트는 import하지 않고 props로 받음 — 구조만 파악).
- `web/src/view/EditorToolBar.test.jsx` — 순수 표시 컴포넌트 테스트 컨벤션(render + testid + 클릭 콜백 단언).
- `web/src/index.css` 또는 `web/src/**/yonhap.css`(툴바 스타일이 있는 CSS 파일) — 약물바 스타일을 추가할 위치(`yh-editor-toolbar`/`yh-editor-chrome-bar` 인근). 정확한 파일 경로는 `EditorToolBar.jsx`의 className(`yh-editor-toolbar`)을 CSS에서 grep해 찾는다.

## 작업

TDD로 진행한다(vitest). 먼저 `web/src/view/EditorGlyphBar.test.jsx`를 작성하고, 통과하는 `web/src/view/EditorGlyphBar.jsx`를 만든다.

### 컴포넌트 계약 (시그니처 수준)

```jsx
// 약물바 — 자주쓰는 약물(items: string[])을 버튼으로 렌더. 클릭 시 onPick(glyph)로 위임.
// 순수 표시(ADR-003): model/fetch/localStorage/window 없음. items는 부모가 loadEditorPrefs로 읽어 주입(Step 2).
export function EditorGlyphBar({ items = [], onPick }) { ... }
```

요구사항:
- `role="toolbar"`, `aria-label`(예: "약물바"), `data-testid="glyph-bar"`. 조회페이지/툴바와 충돌하지 않는 **전용 클래스**(예: `yh-editor-glyphbar`)·전용 testid를 쓴다(EditorToolBar의 `yh-editor-toolbar`/`toolbar`와 별개).
- `items`의 각 약물을 버튼으로 렌더한다. 버튼 클릭 시 `onPick(glyph)` 호출(`onPick` 미전달 시 안전 가드).
- `items`가 빈 배열이면 빈 약물바(또는 "등록된 약물 없음" 안내) — 크래시 없이 graceful. 등록된 약물이 없을 때의 표시는 재량(단 버튼은 0개).
- 약물 텍스트가 중복될 수 있으므로 key는 인덱스를 포함해 안정화한다(`${glyph}-${i}`, EditorPrefsDialog glyph-list와 동일).
- 각 약물 버튼에 식별 가능한 `data-testid`(예: `glyph-bar-item-${i}`)와 접근성 라벨을 단다.
- CSS: 툴바 인근에 `yh-editor-glyphbar` 막대 스타일을 추가한다(가로 버튼 나열). 기존 `yh-editor-toolbar`/`yh-editor-chrome-bar` 스타일을 깨지 않는다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 표시(ADR-003)**: model/fetch/transport/localStorage/window/document 호출 금지. 데이터는 props(`items`)로만 받고 동작은 `onPick` 콜백으로만 위임한다. 이유: View는 계약을 통해서만 외부와 통신(계층 분리).
2. **약물 삽입 로직 금지**: 이 컴포넌트는 블록 조작/캐럿 계산을 하지 않는다(Step 0 헬퍼·Step 2 WriterPage 담당). `onPick(glyph)`만 부른다. 이유: Scope 최소화 — 표시와 결선 분리.
3. **전용 클래스/testid**: 조회페이지(`yh-context-menu`)·툴바(`yh-editor-toolbar`)와 다른 전용 className/testid를 쓴다. 이유: 회귀 테스트·스타일 충돌 방지(EditorContextMenu가 같은 이유로 분리했다).
4. **editorPrefs 미접촉**: 이 컴포넌트는 editorPrefs.js를 import하지 않는다(items는 props). 이유: 스키마 의존을 결선 레이어로 한정.

## Acceptance Criteria

```bash
cd web && npm run test -- EditorGlyphBar    # 신규 EditorGlyphBar.test.jsx 통과
cd .. && npm run test:web                   # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `EditorGlyphBar.test.jsx`):
- `items={['※','◇','▲']}`로 렌더 시 버튼 3개가 보이고 각 약물 텍스트가 표시된다(`data-testid="glyph-bar"` 안에).
- 약물 버튼 클릭 시 `onPick`이 그 약물 문자열로 호출된다(`onPick` mock 단언, 예: 두 번째 버튼 → `onPick('◇')`).
- `items={[]}`(빈 배열)이어도 크래시 없이 렌더되고 버튼은 0개다.
- `onPick` 미전달 시 버튼 클릭이 예외를 던지지 않는다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 순수 표시(transport/localStorage 없음), 전용 클래스/testid, 약물 삽입 로직 부재, editorPrefs 미import.
3. 결과에 따라 `phases/17-editor-glyph-tools/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- model/fetch/localStorage/window/document를 호출하지 마라. 이유: ADR-003 순수 표시 컴포넌트.
- 블록/캐럿/약물 삽입 계산을 이 컴포넌트에 넣지 마라. 이유: Step 0 헬퍼·Step 2 결선이 담당(Scope 최소화).
- 조회페이지·툴바와 같은 className/testid를 재사용하지 마라. 이유: 회귀·스타일 충돌.
- `Editor.jsx`/`WriterPage.jsx`를 수정하지 마라(이 step은 신규 컴포넌트+테스트+CSS만). 이유: 결선은 Step 2.
