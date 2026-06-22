# Step 1: find-replace-dialog — 찾기/바꾸기 다이얼로그(표시 컴포넌트)

## 배경 / 요구사항

`docs/news.md` "기사 에디터"/"기사 상단 메뉴바"의 찾기/바꾸기(Ctrl+F) UI다. 이 step은 **순수 표시/폼 컴포넌트** `FindReplaceDialog.jsx`만 만든다 — 검색 엔진(Step 0)을 호출하지도, 본문을 바꾸지도 않는다. 입력은 콜백/props로만 받고, WriterPage 결선은 Step 2다.

다이얼로그는 "찾을 내용", "바꿀 내용" 입력란과 **다음 찾기 / 이전 찾기 / 바꾸기 / 모두 바꾸기 / 닫기** 버튼, 대소문자 구분 체크박스, 매치 현황 표시(예: `3/12` 또는 `검색 결과 없음`)를 가진다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view, ADR-003(순수 표시 컴포넌트, transport 없음)
- `/docs/news.md` — "기사 에디터"(찾기/바꾸기), "## 기사 상단 메뉴바"(편집>찾기/바꾸기)
- `web/src/view/EditorPrefsDialog.jsx` — **모달 본보기**. `if (!open) return null`, `yh-modal__backdrop`/`yh-modal`, `role="dialog"`, `aria-label`, `onMouseDown` stopPropagation, `data-testid` 컨벤션. 다만 이 다이얼로그는 **비파괴(non-modal)에 가까운 도구 패널**이라 backdrop으로 본문 클릭을 막을 필요는 없다(있어도 무방하나 backdrop 클릭=닫기만). 폼 상태(query/replacement/caseSensitive)는 다이얼로그 내부 state로 둔다.
- `web/src/view/EditorPrefsDialog.test.jsx` — 다이얼로그 컴포넌트의 vitest+RTL 테스트 패턴(`render`/`screen`/`userEvent`, testid 조회).
- `web/src/styles/yonhap.css` — `yh-*`/`yh-modal*` 클래스 컨벤션(다이얼로그 클래스 추가 위치).

## 작업

TDD로 진행한다(vitest+RTL, 테스트 먼저). 새 컴포넌트 `web/src/view/FindReplaceDialog.jsx`, 새 테스트 `web/src/view/FindReplaceDialog.test.jsx`.

### `FindReplaceDialog.jsx`

```jsx
export function FindReplaceDialog({
  open,
  matchCount = 0,        // 현재 query의 전체 매치 수(부모가 Step 0 findMatches로 계산해 주입)
  activeIndex = -1,      // 현재 활성 매치의 0-base 인덱스(-1이면 없음)
  onQueryChange,         // (query, { caseSensitive }) => void  — 입력/체크박스 변경 시
  onFindNext,            // () => void
  onFindPrev,            // () => void
  onReplaceOne,          // (replacement) => void
  onReplaceAll,          // (replacement) => void
  onClose,               // () => void
})
```

- `open` false면 `null` 반환(EditorPrefsDialog와 동일).
- 입력란 2개(찾을 내용 `data-testid="find-query"`, 바꿀 내용 `data-testid="find-replacement"`) — 각각 `aria-label` 부여. 둘 다 다이얼로그 내부 state.
- 대소문자 구분 체크박스(`data-testid="find-case"`, `aria-label="대소문자 구분"`).
- 버튼: 다음 찾기(`find-next`), 이전 찾기(`find-prev`), 바꾸기(`find-replace-one`), 모두 바꾸기(`find-replace-all`), 닫기(`find-close`). 각 `type="button"`.
  - 다음/이전 찾기 클릭 → `onFindNext()/onFindPrev()`. 바꾸기 → `onReplaceOne(replacement)`. 모두 바꾸기 → `onReplaceAll(replacement)`. 닫기 → `onClose()`.
- **query/caseSensitive 변경은 즉시 `onQueryChange(query, { caseSensitive })`로 부모에 알린다**(부모가 매치 수를 재계산해 `matchCount`/`activeIndex`로 되돌려줌). replacement 변경은 부모에 알릴 필요 없다(바꾸기 클릭 시 인자로 전달).
- 매치 현황 표시(`data-testid="find-status"`): `matchCount===0`이면 query가 비었으면 빈 표시, query가 있으면 `검색 결과 없음`. `matchCount>0`이면 `{activeIndex+1>0 ? activeIndex+1 : 1}/{matchCount}` 형태.
- Esc로 닫기: 다이얼로그에 `onKeyDown`을 달아 `e.key==='Escape'`면 `onClose()`. (EditorPrefsDialog는 backdrop이 mousedown으로 닫지만 여기선 Esc도 지원 — 검색 도구 관례.)
- **순수 표시/폼 컴포넌트**다: `useState`(폼 입력)만 허용. **검색/치환 로직·`window`/`document`/transport 호출을 넣지 마라** — 전부 콜백으로 위임한다.
- `open`이 true→true 사이에 query를 리셋하지 마라(타이핑 중 유지). `open`이 false→true(새로 열림)일 때만 입력을 초기화한다(`useEffect([open])`로, EditorPrefsDialog 재초기화 패턴 참고). 단 활성 줄의 선택 텍스트를 초기 query로 채우는 기능은 **이번 범위 밖**(부모가 prop으로 줄 수도 있으나 이번엔 빈 값으로 시작 — 단순화).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 표시 컴포넌트**: 검색·치환·DOM 조작·transport 없음. 모든 동작은 props 콜백으로 위임(ADR-003). 이유: Step 2에서 WriterPage가 Step 0 엔진과 안전 경로로 결선해 재사용·테스트.
2. **에디터/WriterPage 무변경**: `Editor.jsx`·`WriterPage.jsx`를 수정하지 마라(결선은 Step 2).
3. **조회페이지 ContextMenu와 충돌 금지**: 이 다이얼로그는 `yh-find-replace`(또는 동등) 전용 클래스/testid를 쓴다. `yh-context-menu` 클래스/`ContextMenu` 컴포넌트를 재사용하거나 건드리지 마라.
4. **접근성**: `role="dialog"` + `aria-label="찾기/바꾸기"`. 입력/체크박스/버튼에 `aria-label` 또는 연결된 `<label>`.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (FindReplaceDialog 단위 테스트 포함)
npm run build
npm run lint
```

추가 단언(vitest+RTL):
- `open={false}`면 아무것도 렌더하지 않는다(`container`가 비거나 dialog 없음).
- `open` 시 `role="dialog"`(name '찾기/바꾸기')와 find-query/find-replacement/find-case/버튼 5종(find-next/find-prev/find-replace-one/find-replace-all/find-close)이 보인다.
- find-query에 'foo' 입력 시 `onQueryChange`가 `('foo', { caseSensitive:false })`로 호출된다.
- find-case 체크 시 `onQueryChange`가 `caseSensitive:true`로 호출된다(현재 query와 함께).
- find-next/find-prev 클릭 → `onFindNext`/`onFindPrev` 호출.
- find-replacement에 'bar' 입력 후 바꾸기 클릭 → `onReplaceOne('bar')`; 모두 바꾸기 클릭 → `onReplaceAll('bar')`.
- find-close 클릭 → `onClose` 호출. Esc 키 → `onClose` 호출.
- `matchCount={12} activeIndex={2}` → find-status에 `3/12` 표시. `matchCount={0}` + query 입력 → `검색 결과 없음`.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 순수 표시 컴포넌트(ADR-003), 에디터/WriterPage 무변경, ContextMenu와 충돌 없음.
3. 결과에 따라 `phases/14-editor-find-context/index.json`의 step 1을 업데이트(성공 → completed + summary / 3회 실패 → error / 개입 필요 → blocked).

## 금지사항

- 검색/치환 로직을 다이얼로그 안에 넣지 마라(콜백 위임). 이유: 엔진은 Step 0, 결선은 Step 2 — 분리해야 자가교정 범위가 좁다.
- `Editor.jsx`/`WriterPage.jsx`를 수정하지 마라(결선은 Step 2).
- `window`/`document`/transport(model/fetch)를 호출하지 마라. 이유: 순수 표시 컴포넌트 불변식.
- 조회페이지 `ContextMenu.jsx`/`yh-context-menu`를 재사용·수정하지 마라. 이유: 컨텍스트 메뉴 충돌은 Step 3 리스크 — 다이얼로그는 별도 클래스.
- 기존 테스트를 깨뜨리지 마라.
