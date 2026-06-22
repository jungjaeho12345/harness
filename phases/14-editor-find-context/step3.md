# Step 3: editor-context-menu — 에디터 우클릭 컨텍스트 메뉴 + 바 보이기 토글

## 배경 / 요구사항

`docs/news.md` L173:

> 마우스 우클릭시 기업코드변환 Ctrl+B, 잘라내기 Ctrl+X, 복사 Ctrl+C, 붙여넣기 Ctrl+V, 원본 붙여넣기 Alt+V, 텍스트 붙여넣기 Ctrl+V, 약물입력 Alt+O, 찾기/바꾸기 Ctrl+F, 전체 선택 Ctrl+A, 메뉴바 보이기, 툴바 보이기, 약물바 보이기 있다.

이 step은 에디터 본문 영역의 **우클릭 컨텍스트 메뉴**를 만들고 WriterPage에 결선한다. 항목은 명세 순서대로 전부 **노출**하되, **이번 phase에서 동작하는 항목만 활성**이고 aux-tools 의존 항목은 **비활성 placeholder**다.

활성(결선) 항목:
- 찾기/바꾸기(Ctrl+F) → Step 2 `setShowFind(true)`.
- 전체 선택(Ctrl+A) → Step 2 전체 선택 핸들러.
- 잘라내기/복사/붙여넣기(Ctrl+X/C/V) → 브라우저 기본 편집 동작에 위임(아래 설계 참조).
- 메뉴바 보이기 / 툴바 보이기 / 약물바 보이기 → 보이기 토글(메뉴바·툴바는 기존 상태, 약물바는 placeholder 상태).

비활성 placeholder(aux-tools 의존 — 이번 범위 밖):
- 기업코드변환(Ctrl+B), 원본 붙여넣기(Alt+V), 텍스트 붙여넣기(Ctrl+V), 약물입력(Alt+O).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view, ADR-003
- `/docs/news.md` — L173(우클릭 항목·단축키 정확히 확인), "기사 에디터"
- `web/src/view/ContextMenu.jsx` — **조회페이지 전용** 컨텍스트 메뉴(`yh-context-menu`, `buildContextMenuItems`). **재사용·수정 금지** — 에디터 메뉴는 별도 컴포넌트로 만들고 충돌하지 않게 한다(다른 클래스/testid). 패턴(항목 배열 + `enabled` 플래그 + `onSelect(key)`)만 참고한다.
- `web/src/view/EditorMenuBar.jsx` — `enabledIds`(배열/Set 정규화)·`disabled={!enabledSet.has(id)}`·`onClick`에서 활성일 때만 `onSelect(id)` 위임 패턴. 이 패턴을 에디터 컨텍스트 메뉴에도 동일 적용한다(미결선 항목 비활성).
- `web/src/view/WriterPage.jsx` — Step 2 결선 결과:
  - `showMenuBar`/`setShowMenuBar`(L78), `showToolBar`/`setShowToolBar`(L79) — 기존 보이기 토글 상태(L305~324의 전용 버튼과 정합).
  - `showFind`/`setShowFind`(Step 2) — 찾기 다이얼로그 토글.
  - `onMenuSelect`(찾기/전체선택 분기) — 컨텍스트 메뉴 활성 항목과 동일 동작을 공유할 수 있으면 재사용(중복 금지).
  - `<div className="yh-writer__canvas" data-testid="editor-canvas">`(L328) — `<Editor>`를 감싸는 래퍼. 여기에 `onContextMenu`를 단다(에디터 본문 우클릭 캡처).
  - `isMapping`(L107) — 매핑 모드에서 본문 변경 항목 비활성/가드.
- `web/src/view/ListPage.jsx` — L196~198: `onContextMenu={(e)=>{ e.preventDefault(); setCtx({...}) }}` + 위치(x/y) 상태로 메뉴를 띄우는 기존 패턴. 에디터에도 같은 방식(좌표 상태 + 바깥클릭/Esc 닫기)을 쓴다.
- `web/src/styles/yonhap.css` — `yh-context-menu` 스타일(에디터 메뉴는 `yh-editor-context-menu` 등 별도 클래스 추가).
- `web/src/view/WriterPage.test.jsx`, 기존 컨텍스트 메뉴 테스트 — 회귀 기준 + 신규 단언 위치.

## 작업

TDD로 진행한다(vitest+RTL, 테스트 먼저). 새 컴포넌트 `web/src/view/EditorContextMenu.jsx` + 테스트 `web/src/view/EditorContextMenu.test.jsx`, WriterPage 결선.

### 1. `EditorContextMenu.jsx`

```jsx
// 항목 config — news.md L173 순서. {id, label, shortcut?}.
export const EDITOR_CONTEXT_ITEMS = Object.freeze([
  { id: 'ctx.companyCode', label: '기업코드변환', shortcut: 'Ctrl+B' },
  { id: 'ctx.cut', label: '잘라내기', shortcut: 'Ctrl+X' },
  { id: 'ctx.copy', label: '복사', shortcut: 'Ctrl+C' },
  { id: 'ctx.paste', label: '붙여넣기', shortcut: 'Ctrl+V' },
  { id: 'ctx.pasteOriginal', label: '원본 붙여넣기', shortcut: 'Alt+V' },
  { id: 'ctx.pasteText', label: '텍스트 붙여넣기', shortcut: 'Ctrl+V' },
  { id: 'ctx.symbolInput', label: '약물입력', shortcut: 'Alt+O' },
  { id: 'ctx.findReplace', label: '찾기/바꾸기', shortcut: 'Ctrl+F' },
  { id: 'ctx.selectAll', label: '전체 선택', shortcut: 'Ctrl+A' },
  { id: 'ctx.showMenuBar', label: '메뉴바 보이기' },
  { id: 'ctx.showToolBar', label: '툴바 보이기' },
  { id: 'ctx.showGlyphBar', label: '약물바 보이기' },
]);

export function EditorContextMenu({ position = {}, enabledIds, checkedIds, onSelect, onClose })
```

- `EditorMenuBar`의 `enabledSet` 정규화(배열/Set 허용, 미전달 시 빈 집합 → 전 항목 비활성)와 `disabled={!enabledSet.has(id)}`·활성일 때만 `onSelect(id)` 패턴을 그대로 쓴다.
- `checkedIds`(보이기 토글 항목의 현재 on/off 표시용 — 배열/Set): 해당 항목에 `aria-checked`/체크 표식을 단다(예: `메뉴바 보이기` 앞 `✓`). 토글 상태 표현(선택)이지 disabled와 무관.
- `ListPage` 패턴대로 `position.x/position.y`로 절대 위치, `onMouseLeave`/Esc/바깥클릭 시 `onClose`. 항목 클릭 → 활성이면 `onSelect(id)` + `onClose()`.
- **조회페이지 ContextMenu와 충돌 금지**: 클래스 `yh-editor-context-menu`(또는 동등), testid `editor-context-menu`. `yh-context-menu`/`buildContextMenuItems`를 재사용하지 마라.
- 순수 표시 컴포넌트(transport 없음). 동작은 `onSelect`로 위임.

### 2. WriterPage 결선 (`WriterPage.jsx`)

- 약물바 placeholder 상태: `const [showGlyphBar, setShowGlyphBar] = useState(false);` — **실제 약물바는 렌더하지 않는다**(약물바 컴포넌트가 아직 없음 — 토글 상태만 보존하는 placeholder, news.md 범위 경계). 토글만 동작한다.
- 컨텍스트 메뉴 위치 상태: `const [ctxMenu, setCtxMenu] = useState(null);`(`{x, y}` 또는 null).
- `yh-writer__canvas` 래퍼(L328)에 `onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}` — 에디터 본문 우클릭 시 브라우저 기본 메뉴 대신 커스텀 메뉴를 띄운다.
- 활성 항목(enabledIds) 계산:
  - 항상 활성: `ctx.findReplace`, `ctx.selectAll`, `ctx.showMenuBar`, `ctx.showToolBar`, `ctx.showGlyphBar`.
  - 표준 편집(`ctx.cut`/`ctx.copy`/`ctx.paste`): **매핑이 아니고**(텍스트 편집 가능할 때) 활성. 매핑(텍스트 잠금)에서는 잘라내기/붙여넣기 비활성(복사는 무해하나 단순화를 위해 일관되게 비활성도 허용 — 결정해 주석).
  - aux-tools 의존(`ctx.companyCode`/`ctx.pasteOriginal`/`ctx.pasteText`/`ctx.symbolInput`): **항상 비활성**(미구현 placeholder).
- `checkedIds`: 현재 켜진 보이기 항목(`showMenuBar`→`ctx.showMenuBar`, `showToolBar`→`ctx.showToolBar`, `showGlyphBar`→`ctx.showGlyphBar`).
- `onSelect(id)` 라우팅:
  - `ctx.findReplace` → `if (!isMapping) setShowFind(true);`(Step 2와 동일 — 매핑에선 안 엶).
  - `ctx.selectAll` → Step 2 전체 선택 핸들러 호출(중복 금지 — 같은 함수 재사용).
  - `ctx.showMenuBar`/`ctx.showToolBar`/`ctx.showGlyphBar` → 각 토글 setter(`setShowMenuBar((v)=>!v)` 등).
  - `ctx.cut`/`ctx.copy`/`ctx.paste` → **브라우저 기본 클립보드 동작에 위임**한다: 핸들러에서 본문을 직접 바꾸지 말고, 에디터 root를 포커스한 뒤 `document.execCommand('cut'|'copy'|'paste')`를 호출하거나(jsdom 한계 시 no-op 허용) 그냥 메뉴만 닫는다. **contentEditable 텍스트를 코드로 직접 조작하지 마라**(Editor 불변식·붙여넣기는 Editor.handlePaste가 이미 (끝) 차단/이미지 임베드를 처리하므로 그 경로를 깨지 마라). 결정·한계를 주석으로 남겨라.
  - aux 항목은 비활성이라 호출되지 않는다.
- `<EditorContextMenu>`를 `ctxMenu` 있을 때만 렌더(EditorPrefsDialog/FindReplaceDialog 옆). 바깥클릭/Esc/항목선택 시 `setCtxMenu(null)`.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **에디터 불변식**: `Editor.jsx`를 수정하지 마라(phase 5/8/9). 컨텍스트 메뉴는 WriterPage 래퍼(`yh-writer__canvas`)의 `onContextMenu`로만 결선한다. 잘라내기/복사/붙여넣기는 코드로 본문 텍스트/블록을 바꾸지 말고 브라우저 기본/Editor 기존 paste 경로에 위임한다(직접 contentEditable 조작 금지 — 붙여넣기 (끝) 차단·이미지 임베드 회귀 방지).
2. **ContextMenu 충돌 금지**: 조회페이지 `ContextMenu.jsx`/`yh-context-menu`/`buildContextMenuItems`를 재사용·수정하지 마라. 에디터 메뉴는 별도 컴포넌트·클래스·testid. 이유: 두 메뉴가 같은 클래스를 쓰면 스타일/테스트가 충돌한다.
3. **id 일관(namespaced)**: 컨텍스트 항목 id는 `ctx.*` 네임스페이스로 통일. 라벨 문자열로 라우팅하지 마라.
4. **미구현 비활성**: aux-tools 의존 항목(기업코드변환/원본·텍스트 붙여넣기/약물입력)은 **항상 비활성 placeholder**. 동작 없는 항목을 활성으로 노출하지 마라.
5. **약물바 placeholder**: 약물바는 실제 바를 렌더하지 않는다(토글 상태만). 이유: glyph bar 컴포넌트는 이번 범위 밖(news.md 경계).
6. **매핑 보호**: 매핑 모드에서 본문을 바꾸는 항목(찾기 다이얼로그·잘라내기/붙여넣기)은 본문을 변경하지 않게 한다(텍스트 잠금 불변식).
7. **회귀 금지**: 조회페이지 우클릭 메뉴(ListPage), 메뉴바/툴바 전용 토글 버튼, Ctrl+F/전체선택(Step 2), Alt+Y/Ctrl+Y/Ctrl+D 등 기존 동작 불변.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (EditorContextMenu + WriterPage 결선 + 기존 회귀)
npm run build
npm run lint
```

추가 단언(vitest+RTL):
- EditorContextMenu: `EDITOR_CONTEXT_ITEMS`가 news.md L173 12개 항목을 순서대로 정의한다(라벨·shortcut 검증). `enabledIds` 미전달 시 전 항목 비활성.
- EditorContextMenu: `enabledIds=['ctx.findReplace']`면 찾기/바꾸기만 활성·클릭 시 `onSelect('ctx.findReplace')`. aux 항목(`ctx.companyCode` 등)은 비활성.
- EditorContextMenu: `checkedIds=['ctx.showMenuBar']`면 '메뉴바 보이기'에 체크 표식(`aria-checked="true"` 또는 ✓)이 보인다.
- WriterPage: 에디터 캔버스(`editor-canvas`) 우클릭 시 `editor-context-menu`가 뜨고 브라우저 기본 메뉴가 막힌다(`preventDefault`).
- WriterPage: 컨텍스트 메뉴 '찾기/바꾸기' 클릭 시 찾기 다이얼로그가 열린다. '메뉴바 보이기' 클릭 시 메뉴바가 토글된다(`menubar` 표시/숨김). '약물바 보이기' 클릭은 에러 없이 토글 상태만 바뀐다(실제 바 없음).
- WriterPage: aux 항목(기업코드변환/약물입력/원본 붙여넣기/텍스트 붙여넣기)은 컨텍스트 메뉴에서 비활성(disabled)으로 보인다.
- WriterPage(매핑 모드): 컨텍스트 메뉴 '찾기/바꾸기' 클릭이 다이얼로그를 열지 않고 `updateField('body', …)`가 호출되지 않는다. 잘라내기/붙여넣기는 비활성.
- 회귀: 조회페이지 ListPage 우클릭 메뉴(`yh-context-menu`)는 영향받지 않는다. 메뉴바/툴바 전용 토글 버튼·Step 2 결선 불변.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 결선(ADR-003), 에디터 무변경, 두 컨텍스트 메뉴 분리, id 일관, 미구현 비활성, 매핑 보호, 회귀 없음.
3. 결과에 따라 `phases/14-editor-find-context/index.json`의 step 3을 업데이트(성공 → completed + summary / 3회 실패 → error / 개입 필요 → blocked). phase 전체가 끝나면 `phases/index.json`의 `14-editor-find-context` 엔트리도 completed로 갱신(타임스탬프는 실행 세션이 기록).

## 금지사항

- `Editor.jsx`를 수정하지 마라. 이유: phase 5/8/9 타이핑/IME/캐럿/remount 불변식. 컨텍스트 메뉴는 WriterPage 래퍼 결선으로만.
- 조회페이지 `ContextMenu.jsx`/`yh-context-menu`/`buildContextMenuItems`를 재사용·수정하지 마라. 이유: 두 메뉴 충돌 — 별도 컴포넌트.
- 잘라내기/복사/붙여넣기를 코드로 contentEditable 텍스트/블록을 직접 조작해 구현하지 마라. 이유: (끝) 차단·이미지 임베드(Editor.handlePaste) 회귀.
- aux-tools 의존 항목을 활성화하거나 동작을 구현하지 마라(미구현 placeholder). 이유: 동작 없는 항목이 활성으로 보이면 오작동.
- 약물바 컴포넌트/약물 기능을 만들지 마라(placeholder 토글만). 이유: glyph bar는 범위 밖.
- 서버/DB/마이그레이션을 건드리지 마라. 이유: 이 phase는 클라이언트 전용.
- 기존 테스트(ListPage 우클릭·Step 2 결선·phase 8/9 회귀)를 깨뜨리지 마라.
