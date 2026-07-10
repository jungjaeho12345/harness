# Step 1: spell-result-dialog — 맞춤법 검사 결과 목록 다이얼로그(표시 컴포넌트)

## 배경 / 요구사항

Step 0 엔진이 낸 오류 후보를 **결과 목록으로 보여주는 순수 표시 컴포넌트** `SpellCheckDialog.jsx`만 만든다. 검사 엔진을 호출하지도, 본문을 바꾸지도, 오프셋을 계산하지도 않는다 — 입력은 props로만 받고, 항목 클릭·닫기는 콜백으로 위임한다(ADR-003). WriterPage 결선은 Step 2다.

**표시 방식 결정 = 인라인 하이라이트가 아니라 결과 목록 다이얼로그다.** 근거: 인라인 하이라이트는 `Editor.jsx`의 본문 렌더(`<div className="yh-editor__line">{block.text}</div>`)를 span 분할로 바꿔야 하고, 이는 "1 텍스트 줄 = 1 `.yh-editor__line` = 1 텍스트 블록" 불변식과 contentEditable 타이핑 안정성(`readEditorBlocks`/`readEditorText`가 `textContent`에 의존)을 위협한다. 모든 에디터 phase가 지켜온 **Editor.jsx 미접촉** 원칙을 유지하기 위해 결과 목록 + 항목 클릭→해당 줄 이동(Step 2) 방식을 택한다 — 찾기/바꾸기(`FindReplaceDialog` + `setPendingCaretLine`) 선례와 동형이다.

오류 표현(`errorStyle`: `bold`/`underline`)은 **각 결과 행의 오류 조각(snippet) 렌더에 반영**한다(인라인 하이라이트가 아니라 목록 안 조각 스타일).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 순수 표시 컴포넌트, ADR-003(transport 없음).
- `/docs/news.md` L180(맞춤법 메뉴 5종), L215(오류 표현 굵게/밑줄).
- `phases/30-editor-spellcheck/step0.md` — Step 0 엔진의 Issue 계약(`{ start, end, group, message, suggestion }`) 원문. 이 컴포넌트의 `issues` prop 필드명은 이 계약을 따른다(단, 컴포넌트는 editorSpell.js를 import하지 않는다 — 의도된 독립).
- `web/src/view/FileInfoDialog.jsx` — **본보기 구조**. `if (!open) return null`, `className="yh-editor-dialog yh-file-info"`, `role="dialog"`+`aria-label`, `data-testid`, `onKeyDown` Esc 닫기, `useFocusOnOpen(closeRef, open)`으로 '닫기' 버튼에 포커스 이전(포커스가 에디터 본문에 남으면 Esc 미발화 + 타이핑 오염). 읽기전용 다이얼로그의 정확한 틀.
- `web/src/view/HistoryCompareDialog.jsx` — **목록/선택형 다이얼로그 본보기**(entries 목록 렌더, 항목 콜백, 빈 상태 분기). 이 컴포넌트의 항목 렌더·onSelect 위임 패턴을 따른다.
- `web/src/view/useFocusOnOpen.js` — 열림 시 포커스 이전 훅(항상 실재하는 focusable 요소=닫기 버튼에 달 것).
- `web/src/view/FileInfoDialog.test.jsx` 또는 `web/src/view/HistoryCompareDialog.test.jsx` — 다이얼로그 컴포넌트 vitest+RTL 테스트 패턴(render/screen/userEvent, testid 조회, Esc·onClose·항목 클릭 콜백 검증).
- `web/src/styles/yonhap.css` — `yh-editor-dialog`·`yh-*` 클래스 컨벤션(신규 `yh-spellcheck` 클래스 추가 위치). 기존 다이얼로그(`yh-file-info`/`yh-history-compare`/`yh-find-replace`/`yh-glyph-input`/`yh-url-embed`)와 충돌하지 않는 전용 클래스를 쓴다.

## 작업

TDD로 진행한다(vitest+RTL, 테스트 먼저). 새 컴포넌트 `web/src/view/SpellCheckDialog.jsx`, 새 테스트 `web/src/view/SpellCheckDialog.test.jsx`. 필요한 CSS는 `yonhap.css`에 `yh-spellcheck*`로 추가.

### `SpellCheckDialog.jsx` 시그니처 (인터페이스만 — 렌더 구현 재량)

```jsx
export function SpellCheckDialog({
  open,
  issues,       // [{ start, snippet, group, message, suggestion }] — 부모가 Step 0 결과에 snippet(오류 조각 텍스트)을 넣어 주입.
                //   start/group/message/suggestion 필드명은 step0 checkSpelling의 Issue 계약을 그대로 따른다(임의 개명 금지).
  errorStyle,   // 'bold' | 'underline' — 오류 조각 렌더 스타일(news.md L215)
  onSelect,     // (issue) => void  — 항목 클릭 시(부모가 issue.start로 캐럿 이동, 이 컴포넌트는 start를 해석하지 않는다)
  onClose,      // () => void
})
```

- `open` false면 `null` 반환(FileInfoDialog와 동일).
- 루트: `className="yh-editor-dialog yh-spellcheck"`, `role="dialog"`, `aria-label="맞춤법 검사"`, `data-testid="spellcheck"`, `onKeyDown`에서 `Escape`→`onClose()`.
- `useFocusOnOpen(closeRef, open)`으로 열림 시 '닫기' 버튼에 포커스.
- `issues`가 빈 배열/미주입이면 빈 상태 메시지(`data-testid="spellcheck-empty"`, 예: `맞춤법 오류가 없습니다.`). 비배열이어도 죽지 않게 안전 폴백(`Array.isArray` 가드).
- 각 이슈는 목록 항목(버튼/li)으로 렌더:
  - 오류 조각 `snippet`을 `errorStyle`대로 표시 — `bold`면 굵게(`font-weight`/`<strong>`), `underline`면 밑줄(`text-decoration: underline`). 조각에 `data-testid="spellcheck-snippet"` + `data-style={errorStyle}`.
  - 규칙 메시지(`message`)와 교정 제안(`suggestion`, 있을 때만 `→ {suggestion}` 형태)을 함께 표시.
  - 항목 클릭 → `onSelect(issue)` 위임(항목 버튼 `data-testid="spellcheck-item-{i}"`, `type="button"`).
  - 오류 총 개수 표시(`data-testid="spellcheck-count"`, 예: `3건`).
- '닫기' 버튼(`data-testid="spellcheck-close"`, `type="button"`, `ref={closeRef}`) → `onClose()`.
- **순수 표시/폼 컴포넌트**: `useRef`(포커스)만 허용. 엔진 호출·오프셋 계산·`window`/`document`/transport·본문 변경 없음 — 전부 props/콜백 위임.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 표시 컴포넌트**: 검사·오프셋 계산·DOM 조작·transport 없음. 모든 동작은 props 콜백으로 위임(ADR-003). 이유: Step 2가 Step 0 엔진과 안전 경로로 결선한다.
2. **본문 변경·자동교체 UI 금지**: 교정 제안은 **표시만** 한다. "이 제안으로 바꾸기"류의 일괄/개별 자동교체 버튼을 만들지 마라(항목 클릭은 캐럿 이동 위임일 뿐, 텍스트를 바꾸지 않는다). 이유: news.md 확정 정책(자동 수정 금지).
3. **Editor/WriterPage 무변경**: `Editor.jsx`·`WriterPage.jsx`를 수정하지 마라(결선은 Step 2).
4. **다이얼로그 충돌 금지**: 전용 클래스 `yh-spellcheck`·testid `spellcheck*`만 쓴다. `yh-file-info`/`yh-history-compare`/`yh-find-replace` 등 다른 다이얼로그 클래스/컴포넌트를 재사용·수정하지 마라.
5. **접근성/포커스**: `role="dialog"`+`aria-label="맞춤법 검사"`, `useFocusOnOpen`으로 닫기 버튼 포커스(에디터 본문 포커스 잔류 시 Esc 미발화·타이핑 오염 — FileInfoDialog 주석 참조). 항목/버튼은 `type="button"`.

## Acceptance Criteria

```bash
npm run test:web
npm run build
npm run lint
```

추가 단언(vitest+RTL):
- `open={false}`면 아무것도 렌더하지 않는다(dialog 없음).
- `open` + issues 있으면 `role="dialog"`(name '맞춤법 검사')·항목 N개·개수 표시가 보인다.
- `errorStyle="bold"`면 snippet이 굵게(`data-style="bold"`), `errorStyle="underline"`면 밑줄(`data-style="underline"`)로 렌더된다.
- `suggestion`이 있는 이슈는 제안 텍스트(`→ 역할` 등)를 함께 보여주고, `suggestion`이 `null`이면 제안을 렌더하지 않는다.
- 항목 클릭 → `onSelect`가 그 issue 객체로 호출된다.
- `spellcheck-close` 클릭 → `onClose` 호출. Esc 키 → `onClose` 호출.
- `issues={[]}`(또는 미주입) → `spellcheck-empty` 빈 상태가 보인다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크: view 순수 표시 컴포넌트(ADR-003), `Editor.jsx`/`WriterPage.jsx` 무변경, 엔진/오프셋/transport 호출 없음, 전용 클래스로 다른 다이얼로그와 충돌 없음, 자동교체 버튼 없음.
3. 결과에 따라 `phases/30-editor-spellcheck/index.json`의 step 1을 업데이트(성공 → completed + summary / 3회 실패 → error / 개입 필요 → blocked).

## 금지사항

- 검사/오프셋 로직을 다이얼로그 안에 넣지 마라(콜백/props 위임). 이유: 엔진은 Step 0, 결선은 Step 2 — 자가교정 범위를 좁힌다.
- 교정 제안 자동교체(개별/일괄) 버튼을 만들지 마라. 이유: news.md 확정 정책(본문 자동 수정 금지) — 표시·항목 이동까지만.
- `Editor.jsx`/`WriterPage.jsx`를 수정하지 마라(결선은 Step 2).
- `window`/`document`/transport(model/fetch)·`localStorage`를 호출하지 마라. 이유: 순수 표시 컴포넌트 불변식(prefs 로드는 Step 2가 한다).
- 다른 다이얼로그의 `yh-file-info`/`yh-history-compare`/`yh-find-replace` 클래스나 컴포넌트를 재사용·수정하지 마라. 이유: 다이얼로그 충돌·회귀.
- 기존 테스트를 깨뜨리지 마라.
