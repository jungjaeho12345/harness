# Step 1: memo-dialog — 메모장 다이얼로그 컴포넌트 (MemoDialog.jsx)

## 배경 / 요구사항

메모장 UI를 담당하는 순수 표시/폼 컴포넌트 `MemoDialog.jsx`를 TDD로 추가한다. 기존 다이얼로그(`GlyphInputDialog`·`FindReplaceDialog`·`EditorPrefsDialog`)와 동일한 **"표시 토글 + 콜백 위임"** 패턴을 따른다 — 자체 상태/영속화/캐럿 계산을 하지 않고, 텍스트는 부모(WriterPage)가 주입하고 변경/닫기는 콜백으로 위임한다.

이 step은 **컴포넌트만** 만든다(WriterPage 결선·영속화는 step 3). news.md에는 메모장의 상세 동작 명세가 없어(도구 메뉴 L182·툴바 L157 목록에만 등장), 합리적으로 도출한다: **본문과 무관한 자유 텍스트 스크래치패드**(여러 줄 textarea 1개 + 닫기).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(프론트 MVC — View 순수), `/docs/ADR.md`(ADR-003), `/docs/UI_GUIDE.md`(클래스 네이밍 `yh-*`·블루 크롬·밀도·안티패턴 금지).
- `web/src/view/GlyphInputDialog.jsx` — **주 패턴 참고**. `if (!open) return null`, `role="dialog"` + `aria-label`, `data-testid`, `onKeyDown`에서 Escape→`onClose`, 닫기 버튼(`yh-btn yh-btn--primary`). 전용 클래스/testid로 다른 다이얼로그와 충돌 회피.
- `web/src/view/GlyphInputDialog.test.jsx` — 다이얼로그 테스트 스타일(open 토글·Escape·콜백 spy) 참고.
- `web/src/styles/yonhap.css` — `yh-glyph-input` 등 기존 다이얼로그 스타일 블록을 참고해 `yh-memo` 스타일을 추가할 수 있다(선택 — 기능은 CSS 없이도 성립하나 UI_GUIDE 밀도/색을 따른다).

## 작업

TDD. 먼저 `web/src/view/MemoDialog.test.jsx`를 실패 테스트로 작성한 뒤, 통과하는 `web/src/view/MemoDialog.jsx`를 만든다.

### `MemoDialog.jsx` 시그니처 (계약 고정, 마크업은 재량)

```js
export function MemoDialog({
  open,             // boolean — false면 null 반환(렌더 안 함)
  text = '',        // string — 표시할 메모 텍스트(부모가 주입)
  onChange,         // (text: string) => void — textarea 입력 시
  onClose,          // () => void — 닫기 버튼/Escape
}) { /* ... */ }
export default MemoDialog;
```

- `open`이 falsy면 `null` 반환.
- `role="dialog"`, `aria-label="메모장"`, `data-testid="memo"`.
- 여러 줄 입력: `<textarea>` 하나. `value={text}` (제어 컴포넌트), `onChange={(e) => onChange && onChange(e.target.value)}`. `aria-label="메모 내용"` + 전용 testid(예: `memo-textarea`).
- 닫기 버튼(`yh-btn yh-btn--primary`, testid `memo-close`) → `onClose`. `onKeyDown`에서 `Escape` → `onClose`.
- 전용 클래스 `yh-memo`(+ `yh-memo__*`)·전용 testid를 써서 `yh-glyph-input`/`yh-find-replace` 등과 충돌하지 않게 한다.
- **순수**: `model`/`fetch`/`localStorage`/`window`/`document`(이벤트 핸들러 인자 제외) 호출 금지, 자체 `useState`로 텍스트를 보관하지 않는다(제어 컴포넌트 — 텍스트 소유는 부모).

## 핵심 규칙 (반드시 준수)

1. **순수 표시 컴포넌트(ADR-003)**: 영속화(`saveMemo`)·캐럿·본문 접근을 하지 않는다. 텍스트 소유·저장은 부모(step 3). 이유: View는 transport/상태를 소유하지 않는다.
2. **제어 컴포넌트**: 메모 텍스트는 `props.text`로만 표시하고 변경은 `onChange`로 위임한다. 컴포넌트 내부 `useState`로 텍스트를 두지 마라. 이유: 부모가 영속화를 주도해야 세션 간 유지가 성립한다.
3. **본문 무접촉**: 이 컴포넌트는 어떤 형태로도 에디터 본문(blocks/updateField)에 접근하지 않는다. 이유: 메모장은 본문과 무관한 스크래치패드다.
4. **클래스 네이밍**: `yh-memo` 접두 전용 클래스만 쓴다(기존 다이얼로그 클래스 재사용 금지). 이유: 스타일/testid 충돌 방지.

## Acceptance Criteria

```bash
npm run test:web   # MemoDialog.test.jsx 포함 web 전체 통과
npm run build      # vite 빌드 에러 없음
npm run lint       # ESLint 통과
```

추가 단언(`MemoDialog.test.jsx`):
- `open={false}`면 아무것도 렌더하지 않는다(`queryByTestId('memo')`가 null).
- `open`이면 `data-testid="memo"` 다이얼로그 + textarea가 `text` 값을 표시한다.
- textarea 입력 시 `onChange`가 입력값으로 호출된다.
- 닫기 버튼 클릭 / Escape 키에서 `onClose`가 호출된다.

## 검증 절차

1. 위 AC 커맨드 실행(red→green 흐름 확인).
2. 아키텍처 체크: `MemoDialog.jsx`에 `model`/`fetch`/`localStorage` 호출 없음, 내부 텍스트 `useState` 없음(제어), `yh-memo` 전용 클래스 사용.
3. `phases/21-editor-tools-memo/index.json`의 step 1을 갱신한다.

## 금지사항

- 컴포넌트 내부에서 `saveMemo`/`loadMemo`/`localStorage`를 호출하지 마라. 이유: 영속화는 부모(step 3) 책임이며 View는 순수해야 한다.
- 메모 텍스트를 컴포넌트 로컬 `useState`로 보관하지 마라. 이유: 부모 소유 제어 컴포넌트여야 세션 간 유지가 된다.
- 기존 다이얼로그(`yh-glyph-input`·`yh-find-replace`)의 클래스/testid를 재사용하지 마라. 이유: 충돌·테스트 오탐.
- 에디터 본문(blocks/updateField/캐럿)에 접근하지 마라. 이유: 메모장은 본문 비변경 스크래치패드다.
