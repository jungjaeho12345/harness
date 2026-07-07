# Step 0: dialog-focus-management

에디터에서 여는 다이얼로그가 열릴 때 포커스를 다이얼로그 내부로 가져오지 않아, 포커스가 에디터 본문(contentEditable)에 남는 **본문 데이터 오염** 결함을 고친다. 최우선 대상은 `FindReplaceDialog`(Ctrl+F 진입)이며, 같은 결함을 공유하는 나머지 에디터 다이얼로그의 Esc 닫기도 실제 포커스 상태에서 동작하도록 개선한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 프론트 MVC(View←Controller←Model), transport 격리(ADR-003).
- `/docs/ADR.md` — ADR-003(주입형 Model 계약, View/Controller transport 비의존), zero-dep 철학.
- `/docs/news.md` — 기사 에디터(154~183행: 상단 메뉴/도구, 찾기/바꾸기 Ctrl+F, "(끝)" 마커).
- `/docs/UI_GUIDE.md` — yonhap.css 디자인 토큰(신규 스타일이 필요하면 참조만, 이 step은 스타일 변경 불필요).
- `/web/src/view/FindReplaceDialog.jsx` — 최우선 수정 대상. 현재 `find-query` input에 autoFocus/ref.focus() 없음. 루트 div `onKeyDown`(Escape→onClose)만 있어 포커스가 본문에 있으면 Esc가 발화하지 않는다.
- `/web/src/view/FindReplaceDialog.test.jsx` — 컴포넌트 단위 테스트(신규 포커스 단언을 여기에 추가).
- `/web/src/view/WriterPage.jsx` — 다이얼로그 렌더 배선 확인용. `openFind`(약 211행: 상태만 켬), Ctrl+F 핸들러(약 541행: `if(isFindReplace(e)){e.preventDefault();if(!isMapping)openFind();return;}`), 다이얼로그들이 `<Editor>`와 형제로 인라인 렌더(약 745·834행)됨을 확인하라. **이 step에서 WriterPage.jsx는 원칙적으로 수정하지 않는다**(포커스 이전은 다이얼로그 컴포넌트 내부에서 처리).
- `/web/src/view/GlyphInputDialog.jsx`, `/web/src/view/FileInfoDialog.jsx`, `/web/src/view/MemoDialog.jsx`, `/web/src/view/AbbrevManageDialog.jsx`, `/web/src/view/SimpTradConvertDialog.jsx`, `/web/src/view/HistoryCompareDialog.jsx`, `/web/src/view/UrlEmbedDialog.jsx` — 같은 결함(열림 시 포커스 미이전 → Esc 불능)을 공유. 각 파일의 논리적 첫 텍스트 입력·닫기 버튼을 확인하라(포커스 대상 선택은 아래 규칙 준수).
- 위 7개 다이얼로그의 각 `*.test.jsx`(예: `/web/src/view/MemoDialog.test.jsx` 등 동일 디렉토리) — 회귀 단언을 여기에 1건씩 추가한다. 파일이 없으면 신규 작성.
- **대상 범위(엄수):** 이 step의 수정 대상은 `FindReplaceDialog` + 위 7개 = **8개 다이얼로그**다. `EditorPrefsDialog`(환경설정 8탭 모달)는 **의도적으로 제외**한다 — 에디터 단축키가 아니라 도움말>환경설정 메뉴로만 열리고 Esc onKeyDown 구조가 다른 별개 성격이라 이 결함(Ctrl+F/Alt+O 등 캐럿 보유 상태 진입)의 본문 오염 경로에 해당하지 않는다. `EditorPrefsDialog`는 건드리지 마라.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- 다이얼로그들은 `<Editor>`(contentEditable)와 **형제로 인라인 렌더**되고, `showFind` 등 표시 상태는 `blocks`와 무관하므로 다이얼로그가 떠도 Editor는 remount되지 않아 **DOM 포커스를 계속 보유**한다.
- 증상 A(본문 오염): 본문에 캐럿을 둔 채 Ctrl+F → 다이얼로그는 뜨지만 포커스가 본문에 남아, 이어 타이핑하는 검색어가 검색창이 아니라 기사 본문에 삽입된다(→ `onTextChange`→`updateField('body')`→자동저장으로 영속 가능).
- 증상 B(Esc 불능): 포커스가 본문에 있어 다이얼로그 루트 div의 `onKeyDown`이 발화하지 않아 Esc로 닫히지 않는다. 위 "대상 범위"의 8개 다이얼로그에 공통이다(EditorPrefsDialog는 제외 — 위 참조).
- 기존 테스트가 결함을 가림: `WriterPage.test.jsx`의 find 테스트가 `userEvent.type(getByTestId('find-query'), ...)`로 input을 **직접 포커스**해 타이핑하므로 이 결함이 드러나지 않았다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성

**(a) `FindReplaceDialog.test.jsx`에 포커스 단언 추가 (필수·핵심)**

- `FindReplaceDialog`를 `open={true}`로 렌더한 직후(어떤 사용자 입력도 하기 전) `document.activeElement`가 `find-query` input(testid `find-query`)임을 단언한다.
- `open`을 `false`로 렌더했다가 `true`로 rerender했을 때도(닫힘→열림 전이) 포커스가 `find-query`로 이동함을 단언한다.
- 참고: jsdom은 `element.focus()`로 `document.activeElement`를 갱신한다. React `autoFocus`는 요소 mount 시 focus를 호출한다. 둘 중 어떤 구현이든 이 단언을 통과시켜야 한다.

**(b) `WriterPage.test.jsx`에 통합 회귀 테스트 추가 (본문 오염 방지 증명)**

- WriterPage를 편집 본문으로 렌더한 뒤, 에디터 루트(`.yh-editor`)에 포커스가 있는 상태에서 Ctrl+F(`keyDown { key:'f', ctrlKey:true }`)를 발생시켜 다이얼로그를 연다.
- 다이얼로그가 열린 직후 `document.activeElement`가 **에디터 본문이 아니라** 다이얼로그 내부 요소(`find-query` input)임을 단언한다.
- jsdom에서 contentEditable이 포커스를 가질 수 있는지 불확실하면, 최소한 "다이얼로그 열림 직후 `document.activeElement` === `find-query` input"을 단언하는 형태로 작성하라(이 양성 단언이 본문 오염 방지의 실효를 보장한다).

### 2) 구현

**FindReplaceDialog.jsx (필수):**
- 다이얼로그가 열릴 때(open false→true, 또는 open=true로 mount될 때) 논리적 첫 요소인 `find-query` input으로 포커스를 이전한다.
- 방법은 재량이다: `find-query` input에 `ref`를 달고 기존 `useEffect(..., [open])`(약 24행, 폼 초기화 effect)에서 `open`일 때 `ref.current?.focus()`를 호출하거나, `autoFocus`를 부여한다. **ref+effect 방식을 권장**한다(재열림 전이에서도 확실히 동작).
- 핵심 불변식: **열림 시 포커스가 에디터 본문이 아니라 다이얼로그 내부(find-query)로 가야 한다.**

**나머지 에디터 다이얼로그(GlyphInputDialog, FileInfoDialog, MemoDialog, AbbrevManageDialog, SimpTradConvertDialog, HistoryCompareDialog, UrlEmbedDialog):**
- 각 다이얼로그도 열릴 때 내부 요소로 포커스를 이전해, Esc 닫기가 실제 포커스 상태에서 동작하도록 한다. **포커스 대상 선택 규칙(엄수):**
  - **논리적 첫 텍스트 입력(`<input type=text>`/`<textarea>`/`<select>`)이 있으면 그것으로** 포커스한다(예: MemoDialog=textarea, AbbrevManageDialog=약어 input, UrlEmbedDialog=URL input).
  - **텍스트 입력이 없으면 그 다이얼로그의 명시적 '닫기' 버튼으로** 포커스한다(예: GlyphInputDialog·SimpTradConvertDialog·FileInfoDialog·HistoryCompareDialog — 각 파일에 `*-close` testid 닫기 버튼이 실재하니 그것을 대상으로 삼아라).
  - **CRITICAL — 본문/설정을 변경하는 액션 버튼에는 절대 초기 포커스를 두지 마라.** 이유: 네이티브 `<button>`은 포커스 상태에서 Space/Enter로 onClick이 발화하므로, 예컨대 SimpTradConvertDialog의 첫 버튼(`simptrad-to-trad` = 간체→번체 변환)이나 GlyphInputDialog의 favorite glyph 버튼에 초기 포커스를 두면, 열림 직후 사용자가 무심코 Space/Enter를 눌러 **기사 본문 전체가 변환되거나 약물이 삽입되는 우발적 파괴**가 일어난다. "첫 포커스 가능 요소"를 기계적으로 고르지 말고 위 규칙(텍스트 입력 → 없으면 닫기 버튼)을 따르라.
  - **루트 컨테이너(bare `<div>`)로 포커스하지 마라.** 이유: `tabIndex`가 없는 div는 `focus()`가 `document.activeElement`를 갱신하지 않아(jsdom·브라우저 공통) 실제로 포커스가 이동하지 않는다 — 위 규칙대로 항상 실재하는 focusable 요소(입력 또는 닫기 버튼)를 대상으로 하면 이 문제가 없다.
- 중복을 줄이려면 **작은 공용 헬퍼/훅**(예: `useFocusOnOpen(ref, open)` 같은 view 레이어 유틸)을 만들어 각 다이얼로그가 재사용하는 것을 권장한다. 단, 공용 헬퍼 도입이 scope를 키운다면 각 다이얼로그의 열림 effect에서 개별 `ref.focus()`로 처리해도 된다.
- **회귀 테스트(각 컴포넌트 테스트에 1건씩·필수 형태):** `open={true}`로 렌더한 **직후**(어떤 입력·키 이벤트도 하기 전) `document.activeElement`가 **그 다이얼로그가 포커스 대상으로 지정한 요소(텍스트 입력 또는 닫기 버튼)임을 단언**하라. **"내부 요소에 Esc keyDown → onClose 호출" 형태의 단언은 쓰지 마라.** 이유: 각 다이얼로그의 루트 `onKeyDown`(Escape→onClose)이 이미 있어 React 이벤트 버블링으로 인해 **포커스 이전 코드를 전혀 추가하지 않아도 그 단언은 통과**한다 — 증상 B(열림 시 포커스 미이전) 수정 여부를 전혀 검증하지 못하는 공허한 테스트다. 반드시 `document.activeElement` 양성 단언으로 실제 포커스 이동을 못 박아라.

### 시그니처 수준 지시

- 공용 훅을 만든다면(선택): `web/src/view/`에 순수 view 유틸로 두고 시그니처는 `useFocusOnOpen(ref, open)` — `open`이 falsy→truthy로 바뀔 때 `ref.current?.focus()`를 호출. DOM/React만 사용, transport 무관. `ref`는 항상 실재하는 focusable 요소(텍스트 입력 또는 닫기 버튼)에 달아라(액션 버튼·bare div 금지).
- 각 다이얼로그의 공개 props 계약(open/onClose/on\* 콜백)은 **변경하지 마라**. 내부에 ref/effect만 추가한다.

## Acceptance Criteria

```bash
npm run test:web   # 신규 포커스 테스트 + 전체 회귀 통과 (vitest, web 루트)
npm run build      # vite 프로덕션 빌드 에러 없음
npm run lint       # ESLint 위반 없음
```

필요 시 UTF-8 강제: `PYTHONUTF8=1`은 파이썬 도구용이며 이 step은 불필요. 모든 신규/수정 텍스트는 UTF-8로 저장하라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - View 컴포넌트만 수정했는가(ADR-003 — transport/fetch/EventSource를 View에서 직접 호출하지 않았는가)?
   - 다이얼로그 public props 계약을 바꾸지 않았는가?
   - CLAUDE.md 규칙(DB 비파괴·zero-dep)을 위반하지 않았는가?
3. 결과에 따라 `phases/27-editor-critical-fixes/index.json`의 step 0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약(수정 파일·핵심 불변식)"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- WriterPage.jsx의 로직(openFind/Ctrl+F 핸들러/자동저장 등)을 바꾸지 마라. 이유: 이 결함은 다이얼로그 컴포넌트가 열릴 때 포커스를 스스로 가져오면 해결되며, WriterPage를 건드리면 step2·step3와 파일이 겹쳐 병합·격리가 어려워진다. (부득이하게 필요하면 Ctrl+F 핸들러의 최소 변경만 허용하되 우선순위는 다이얼로그 내부 처리다.)
- 다이얼로그를 `<Editor>`와 다른 위치로 옮기거나 포털/모달 오버레이 구조로 재작성하지 마라. 이유: scope가 렌더 구조 전면 개편으로 번져 회귀 위험이 커진다 — 이 step은 "열림 시 포커스 이전"만 고친다.
- View 컴포넌트에서 `fetch`/`EventSource`/`model.*` 호출을 추가하지 마라. 이유: ADR-003에 따라 transport는 httpModel 안에만 둔다.
- 새 npm 의존성을 추가하지 마라(zero-dep). 이유: ADR 철학 — focus-trap 등 외부 라이브러리 금지, React/DOM 표준만 사용.
- 서버/DB 스키마를 수정하지 마라. 이유: 이 결함은 순수 클라이언트 UI 문제이며 DB 비파괴 원칙을 지킨다.
- 본문/설정을 변경하는 액션 버튼(변환 실행·항목 삽입 등)에 초기 포커스를 두지 마라. 이유: 열림 직후 우발적 Space/Enter로 기사 본문이 파괴적으로 변형된다(SimpTrad 변환·Glyph 삽입). 텍스트 입력이 없으면 '닫기' 버튼으로 포커스한다.
- 다이얼로그 회귀 테스트를 "Esc keyDown → onClose 호출" 형태로만 작성하지 마라. 이유: 루트 onKeyDown 버블링 때문에 포커스 이전 없이도 통과해 수정 여부를 검증하지 못한다 — `document.activeElement` 양성 단언을 써라.
- 기존 테스트를 깨뜨리지 마라(특히 `WriterPage.test.jsx`의 기존 find 테스트, `FindReplaceDialog.test.jsx`). 이유: 회귀 스위트가 하류 단계의 안전망이다.
