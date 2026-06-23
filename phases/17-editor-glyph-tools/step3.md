# Step 3: glyph-input-dialog — 약물입력(Alt+O) 다이얼로그 컴포넌트

## 배경 / 요구사항

약물입력(약물 입력)은 메뉴/우클릭/단축키(Alt+O)로 여는 다이얼로그다(news.md L155 툴바 '약물입력', L173 우클릭 '약물입력 Alt+O', L180 도구 메뉴 '약물 입력'). 자주쓰는 약물(`glyphFavorites.items`) 기반으로 약물을 선택하면 캐럿 위치에 삽입된다. 사용자 키보드 약물(`glyphKeymap.items` `{keys, glyph}[]`)은 이 UI에 **참조 표시**할 수 있다(키조합 인터셉트는 범위 밖 — 표시만).

이 step은 그 **순수 표시/폼 다이얼로그** `web/src/view/GlyphInputDialog.jsx`를 만든다(결선은 Step 4). phase14 `FindReplaceDialog.jsx`와 **동일한 떠있는 다이얼로그 패턴**(순수 표시, props 콜백 위임, `role="dialog"`, Esc 닫기, open false→true 시 초기화)을 따른다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003(순수 표시/폼, transport 비의존).
- `/docs/news.md` — L155·L173·L180(약물입력 위치), L206~209(자주쓰는 약물·사용자 키보드 약물).
- `web/src/view/FindReplaceDialog.jsx` — **참고 패턴**: `open`/콜백 props, 내부 폼 state만, `useEffect`로 open 전환 시 초기화, `role="dialog"`+`aria-label`, Esc 닫기(`handleKeyDown`), 전용 클래스/testid(`yh-find-replace`/`find-*`), 동작은 콜백 위임(검색/치환·DOM 없음).
- `web/src/view/FindReplaceDialog.test.jsx` — 다이얼로그 테스트 컨벤션(open 토글, 입력, 콜백 mock 단언).
- `web/src/view/editorPrefs.js` — `glyphFavorites: { items: [] }`(string[]), `glyphKeymap: { items: [] }`(`{keys, glyph}[]`) 구조(컴포넌트는 import하지 않고 props로 받음 — 구조만 파악).
- `web/src/view/EditorPrefsDialog.jsx` — **참고**: glyph 목록 렌더 방식(`glyphFav.items.map`, `glyphKey.items.map` — `${m.keys} → ${m.glyph}` 표시, key 안정화 `${g}-${i}`).
- `web/src/index.css`/`yonhap.css`(`yh-find-replace` 스타일이 있는 CSS) — 다이얼로그 스타일 추가 위치.

## 작업

TDD로 진행한다(vitest). 먼저 `web/src/view/GlyphInputDialog.test.jsx`를 작성하고, 통과하는 `web/src/view/GlyphInputDialog.jsx`를 만든다.

### 컴포넌트 계약 (시그니처 수준)

```jsx
// 약물입력 다이얼로그 — 자주쓰는 약물(favorites: string[]) 중 하나를 선택해 onPick(glyph)로 삽입 위임.
// 사용자 키보드 약물(keymap: {keys, glyph}[])은 참조용으로 표시만 한다(클릭으로도 삽입 위임 가능 — 재량).
// 순수 표시/폼(ADR-003): model/fetch/localStorage/window/document 없음. 데이터는 부모가 loadEditorPrefs로 읽어 주입(Step 4).
export function GlyphInputDialog({
  open,
  favorites = [],   // string[] — 자주쓰는 약물
  keymap = [],      // {keys, glyph}[] — 사용자 키보드 약물(참조 표시)
  onPick,           // (glyph) => void — 약물 선택 시
  onClose,          // () => void
}) { ... }
```

요구사항:
- `open`이 false면 `null` 반환(FindReplaceDialog와 동일). `role="dialog"`, `aria-label`(예: "약물 입력"), 전용 클래스(예: `yh-glyph-input`)·전용 testid(예: `glyph-input`). Esc로 `onClose`.
- 자주쓰는 약물(`favorites`)을 선택 가능한 버튼/그리드로 렌더한다. 버튼 클릭 시 `onPick(glyph)` 호출(`onPick` 미전달 시 가드). 약물 삽입 후 닫을지(`onClose` 호출)는 재량 — 단 동작을 주석으로 명시.
- 사용자 키보드 약물(`keymap`)은 **참조 표시** 영역(예: "키보드 약물" 목록)에 `keys → glyph` 형식으로 렌더한다(EditorPrefsDialog와 동일 표기). 키조합 인터셉트는 하지 않는다(표시만). 이 항목을 클릭해 `onPick(glyph)`으로 삽입하는 것은 허용(편의) — 단 키 입력으로 자동 치환하는 로직은 만들지 마라.
- `favorites`가 빈 배열이면 "등록된 약물 없음" 안내 + 환경설정 안내(재량) — 크래시 없이 graceful. `keymap` 빈 배열도 동일.
- key 안정화: 약물/키맵 중복 가능 → `${glyph}-${i}` / `${m.keys}-${m.glyph}-${i}`.
- 닫기 버튼(`data-testid` 부여)을 둔다(FindReplaceDialog `find-close` 패턴).
- CSS: `yh-glyph-input` 떠있는 패널 스타일을 추가한다(FindReplaceDialog `yh-find-replace` 인근). 기존 스타일을 깨지 않는다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 표시/폼(ADR-003)**: model/fetch/transport/localStorage/window/document 호출 금지. 데이터는 props(`favorites`/`keymap`)로만 받고 동작은 `onPick`/`onClose` 콜백으로만 위임한다. 이유: 계층 분리.
2. **약물 삽입 로직 금지**: 블록 조작/캐럿 계산을 하지 않는다(Step 0 헬퍼·Step 4 WriterPage 담당). `onPick(glyph)`만 부른다. 이유: Scope 최소화.
3. **키조합 인터셉트 금지**: `keymap`은 **표시(참조)만**. 키 입력을 받아 glyph로 치환하는 로직(keydown 핸들러로 keys 매칭 등)을 만들지 마라. 이유: Editor 키 핸들러 변경 필요 → 이번 phase 명시적 DEFER.
4. **전용 클래스/testid**: 찾기/바꾸기(`yh-find-replace`)·약물바(`yh-editor-glyphbar`)와 다른 전용 className/testid. 이유: 회귀·스타일 충돌 방지.
5. **editorPrefs 미접촉**: editorPrefs.js를 import하지 않는다(데이터는 props). 이유: 스키마 의존을 결선 레이어로 한정.

## Acceptance Criteria

```bash
cd web && npm run test -- GlyphInputDialog    # 신규 GlyphInputDialog.test.jsx 통과
cd .. && npm run test:web                     # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `GlyphInputDialog.test.jsx`):
- `open={false}`면 아무것도 렌더되지 않는다(null).
- `open` + `favorites={['※','◇']}`면 다이얼로그(`role="dialog"` '약물 입력')와 약물 버튼 2개가 보인다.
- 약물 버튼 클릭 시 `onPick`이 그 약물로 호출된다(예: '◇' 버튼 → `onPick('◇')`).
- `keymap={[{keys:'Ctrl+1', glyph:'★'}]}`이면 `Ctrl+1 → ★` 참조 표시가 보인다.
- Esc 키 또는 닫기 버튼으로 `onClose`가 호출된다.
- `favorites={[]}`·`keymap={[]}`(빈 배열)이어도 크래시 없이 렌더된다.
- `onPick`/`onClose` 미전달 시 클릭/Esc가 예외를 던지지 않는다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 순수 표시(transport/localStorage 없음), 키조합 인터셉트 부재, 전용 클래스/testid, editorPrefs 미import.
3. 결과에 따라 `phases/17-editor-glyph-tools/index.json`의 step 3을 갱신(completed+summary / error / blocked).

## 금지사항

- model/fetch/localStorage/window/document를 호출하지 마라. 이유: ADR-003 순수 표시/폼.
- 블록/캐럿/약물 삽입 계산을 이 컴포넌트에 넣지 마라. 이유: Step 0 헬퍼·Step 4 결선 담당.
- 키 입력을 받아 keymap glyph로 치환하는 로직을 만들지 마라(표시만). 이유: 키조합 인터셉트는 명시적 DEFER.
- 찾기/바꾸기·약물바와 같은 className/testid를 재사용하지 마라. 이유: 회귀·스타일 충돌.
- `Editor.jsx`/`WriterPage.jsx`를 수정하지 마라(이 step은 신규 컴포넌트+테스트+CSS만). 이유: 결선은 Step 4.
