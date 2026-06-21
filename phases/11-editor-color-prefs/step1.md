# Step 1: color-prefs-dialog — 색상 환경설정 모달 + 적용 결선

## 배경 / 요구사항

Step 0에서 `editorColoring`이 `setEditorColors`로 색을 갈아끼울 수 있게 됐다. 이 step은 **색상 환경설정 모달**(도움말 > 환경설정에서 열림)을 만들어 사용자가 제목/부제목/본문/바탕 색을 바꾸고, 저장(`editorPrefs`)·적용(`editorColoring`/배경)하게 한다. 이것이 환경설정 다이얼로그의 **첫 탭(색상)**이며, 후속 phase가 같은 다이얼로그에 자동저장/바이라인/날짜형식 탭을 추가한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view, ADR-003
- `/docs/news.md` — "# 에디터 환경설정 > 색상"(제목/부제목/본문/바탕 RGB 설정)
- `web/src/view/editorColoring.js` — **Step 0 결과**: `setEditorColors(partial)`, `resetEditorColors()`, `COLORS`(폴백/기본).
- `web/src/view/editorPrefs.js` — `loadEditorPrefs()`, `saveEditorPrefs(prefs)`, `setEditorPref(prefs,'colors',patch)`, `DEFAULT_EDITOR_PREFS.colors`(title/subtitle/body/end/background).
- `web/src/view/EditorMenuBar.jsx` — 도움말>환경설정 항목 id = **`help.preferences`**(L109). 활성화는 phase 9 패턴(`enabledIds`)으로.
- `web/src/view/WriterPage.jsx` — `MENU_ENABLED`(phase 9, transform 6개 id 배열), `onMenuSelect(id)`(phase 9 — 여기에 `help.preferences` 분기 추가), `<EditorMenuBar onSelect={onMenuSelect} enabledIds={MENU_ENABLED} />`(약 L257), 좌측 `<section className="yh-writer__editor">`(배경 적용 지점), `useEffect`/`useState` import(L6). 모달 컴포넌트(ListPage 상세보기 모달 등)나 `yonhap.css`의 모달 패턴 참고.
- `web/src/view/EditorMenuBar.test.jsx`, `web/src/view/WriterPage.test.jsx` — 회귀/신규 단언 위치(vitest).
- `web/src/styles/yonhap.css` — 모달·폼·`yh-*` 스타일.

## 작업

TDD로 진행한다(vitest).

### 1. 색상 환경설정 모달 `web/src/view/EditorPrefsDialog.jsx`

```jsx
export function EditorPrefsDialog({ open, onClose })  // 환경설정 모달 — 이번 phase는 '색상' 탭만. onClose(applied:boolean).
```

- `open`이 false면 렌더하지 않는다. 열리면 `loadEditorPrefs().colors`를 초기값으로 한 폼을 보여준다.
- 색 입력 4개: **제목/부제목/본문/바탕** (`title`/`subtitle`/`body`/`background`). `<input type="color">` 또는 hex 텍스트 입력(둘 다 무방, `data-testid`로 식별: `pref-color-title` 등). (end "(끝)" 색은 스펙상 사용자 설정 대상 아님 — 폼에 두지 마라.)
- 버튼: **적용**(저장+적용+닫기), **취소**(닫기만), **기본값**(`DEFAULT_EDITOR_PREFS.colors`의 title/subtitle/body/background로 폼 리셋 — end는 폼에 없으므로 건드리지 않음). `data-testid`: `prefs-apply`/`prefs-cancel`.
- **적용**(적용 버튼):
  1. `const next = setEditorPref(loadEditorPrefs(), 'colors', { title, subtitle, body, background });`
  2. `saveEditorPrefs(next);`
  3. `setEditorColors({ title, subtitle, body });`(텍스트 색 — background 제외, editorColoring은 텍스트 색만)
  4. `onClose(true);` — applied=true로 닫아 부모(WriterPage)가 배경 적용 + Editor 재렌더.
- **취소**(취소 버튼/바깥 클릭): `onClose(false);` — 저장·`setEditorColors`·배경 갱신 없이 닫기만(색/배경 불변).
- 순수 표시/폼 컴포넌트(model/fetch 없음). 적용 로직은 내부에서 editorPrefs/editorColoring 직접 호출(둘 다 view 모듈이라 ADR-003 위반 아님 — 서버 호출 아님).

### 2. WriterPage 결선 (`web/src/view/WriterPage.jsx`)

- `MENU_ENABLED`에 **`'help.preferences'`** 추가. `onMenuSelect`에서 **매핑 가드(`if(isMapping) return;`)보다 앞에** `if (id === 'help.preferences') { setShowPrefs(true); return; }`를 둔다 — 색 설정은 본문 잠금과 무관하므로 매핑 모드에서도 열려야 한다(활성인데 안 열리는 죽은 버튼 방지).
- `const [showPrefs, setShowPrefs] = useState(false);` + `<EditorPrefsDialog open={showPrefs} onClose={onPrefsClose} />` 렌더.
- **배경색 적용 — 전용 캔버스 래퍼**: 배경을 `yh-writer__editor` section 전체에 입히면 메뉴바/툴바/상태바까지 칠해진다. 대신 **Editor만 감싸는 전용 래퍼 div**를 두고 거기에만 배경을 적용한다: `<div className="yh-writer__canvas" data-testid="editor-canvas" style={{ backgroundColor: editorBg }}><Editor .../></div>`. `const [editorBg, setEditorBg] = useState(() => loadEditorPrefs().colors.background);`
  - `yonhap.css`에서 `.yh-editor`(Editor 내부 편집 div)가 불투명 배경을 가지면 캔버스 배경이 가려진다 — `.yh-editor` 배경이 `transparent`(또는 미설정)인지 확인하고, 아니면 캔버스 래퍼 배경이 보이도록 CSS를 맞춘다(Editor.jsx는 건드리지 않고 CSS로).
- **마운트 시 영속 색 적용**: `useEffect(() => { const c = loadEditorPrefs().colors; setEditorColors({title:c.title,subtitle:c.subtitle,body:c.body}); setEditorBg(c.background); }, []);` — 새로고침 후에도 저장된 색이 반영되게.
- **onPrefsClose(applied)** — 적용/취소 경로 구분: 모달이 `onClose(applied)`로 적용 여부를 알린다. `applied===true`(적용)면 WriterPage가 `setEditorBg(loadEditorPrefs().colors.background)` 후 `setShowPrefs(false)`. `applied`가 아니면(취소) `setEditorColors`/배경 갱신 없이 `setShowPrefs(false)`만(취소 시 색/배경 불변). 적용 시 모달이 이미 `setEditorColors`를 호출했으므로, 모달 닫힘으로 WriterPage가 재렌더 → Editor가 재렌더되며 `colorForRole`가 새 색을 읽어 **본문이 새 색으로 칠해진다**(강제 remount/recolor 트리거 불필요 — 자연 재렌더로 충분, IME 중 아니므로 안전).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **Editor.jsx 무변경**: 색 적용은 `setEditorColors`(module 상태) + 모달 닫힘에 의한 자연 재렌더로만. Editor의 타이핑/IME/캐럿/remount 로직을 건드리지 마라.
2. **기본값/회귀**: 저장값이 없으면 기본 색(부제목 빨강)이 그대로 적용된다. phase 9의 `MENU_ENABLED`/`onMenuSelect` 기존 6개 변환·매핑 가드·Ctrl+Y는 불변(추가만).
3. **하위호환**: `EditorMenuBar`는 phase 9 그대로(`enabledIds`에 `help.preferences`만 추가). 다른 항목 비활성 유지.
4. **ADR-003**: 서버/`model`/fetch를 부르지 마라(색 설정은 클라 localStorage·module 상태만).
5. **영속 정합**: 적용은 반드시 `saveEditorPrefs`로 저장 + `setEditorColors`/배경 적용을 함께 한다(저장만 하고 미적용, 또는 적용만 하고 미저장 금지).

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (모달·메뉴 결선·적용/저장·마운트 적용 + 기존 회귀)
npm run build
npm run lint
```

**테스트 격리(필수)**: 이 step에서 추가하는 색/모달/마운트 describe의 `beforeEach`에 `localStorage.clear()`(editorPrefs는 localStorage 'yh.editorPrefs' 사용 — 누수 시 마운트 effect가 오염됨)와 `afterEach(() => resetEditorColors())`(editorColoring module 상태 복원)를 둔다. 기존 `WriterPage.test.jsx` beforeEach는 sessionStorage만 비우므로 localStorage 정리를 추가해야 한다.

추가 단언(vitest):
- `EditorMenuBar`에서 `help.preferences` 활성·클릭 시 `onSelect('help.preferences')` 호출(phase 9 패턴).
- WriterPage: 도움말>환경설정 클릭 시 `EditorPrefsDialog`가 열린다(open=true). **매핑 모드에서도 열린다**(가드 이전 처리 — 죽은 버튼 아님).
- 모달에서 부제목 색을 바꾸고 '적용' 시 `saveEditorPrefs`가 호출돼 `loadEditorPrefs().colors.subtitle`이 새 값이고, `colorForRole('subtitle')`(editorColoring)도 새 값을 반환한다.
- **취소** 시: `saveEditorPrefs` 미호출, `colorForRole`/배경 불변.
- 배경: `data-testid="editor-canvas"` 요소의 `style.backgroundColor`가 `prefs.colors.background`를 반영한다.
- 마운트 시 저장된 색이 `setEditorColors`로 적용된다(저장값 있는 환경에서 `colorForRole`가 저장색 반환).
- 색 적용은 Editor remount 없이(자연 재렌더) 반영 — 색 반영을 위해 Editor에 `key` 부여/remount를 추가하지 않는다(금지사항).
- 기존 phase 9 변환 메뉴(대소문자 등)·매핑 가드(텍스트 변환은 매핑 차단) 단언 불변.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 컴포넌트/결선, Editor.jsx 무변경, ADR-003, 저장+적용 정합, 회귀 없음.
3. 결과에 따라 `phases/11-editor-color-prefs/index.json`의 step 1을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "EditorPrefsDialog(색상 탭)·help.preferences 결선·적용(saveEditorPrefs+setEditorColors+배경)·마운트 영속 적용 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- `Editor.jsx`를 수정하지 마라(색 적용은 module 상태+자연 재렌더). 이유: phase 5/8 불변식.
- 색 적용을 위해 Editor를 강제 remount(key 변경 등)하지 마라. 이유: 타이핑/캐럿 회귀 위험 — 자연 재렌더로 충분.
- 저장만 하고 적용 안 하거나, 적용만 하고 저장 안 하지 마라(정합).
- 다른 환경설정 카테고리(자동저장/바이라인/날짜형식)를 이번에 구현하지 마라(후속 phase — 이번은 색상 탭만).
- 서버/model/fetch를 부르지 마라.
- 기존 테스트(phase 9 메뉴 결선 포함)를 깨뜨리지 마라.
