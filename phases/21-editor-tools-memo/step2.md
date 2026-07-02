# Step 2: toolbar-enable — 툴바 메모장 버튼 활성화(enabledIds 패턴)

## 배경 / 요구사항

에디터 툴바(`EditorToolBar.jsx`)는 현재 **모든 버튼이 무조건 `disabled` placeholder**다(phase 8 쉘 상태). 메모장 버튼(`tool.memo`)을 결선하려면, 메뉴바(`EditorMenuBar`)가 이미 쓰는 **`enabledIds` 패턴**을 툴바에도 도입해 특정 버튼만 활성화하고 클릭 시 `onSelect(id)`로 위임하게 한다.

이 step은 **`EditorToolBar.jsx` 컴포넌트만** 수정한다(WriterPage 결선은 step 3). `enabledIds` 미전달 시 전 버튼 비활성 — **기존 동작과 하위호환**이어야 한다(WriterPage는 아직 `<EditorToolBar />`를 props 없이 렌더 → 현재 테스트 green 유지).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(프론트 MVC — View 순수), `/docs/ADR.md`(ADR-003).
- `web/src/view/EditorToolBar.jsx` — **수정 대상**. `TOOLBAR_BUTTONS`(각 `{id,label}`), 현재 모든 `<button>`에 `disabled` 하드코딩(51행)·`onClick`은 계약상 `onSelect` 호출(54행)이나 disabled라 미호출.
- `web/src/view/EditorToolBar.test.jsx` — **수정 대상**. "버튼은 모두 비활성(disabled) placeholder다"(56~61행)·"비활성 버튼 클릭은 onSelect를 호출하지 않는다"(63~69행) 테스트가 있다. `enabledIds` 도입에 맞춰 **하위호환(props 없으면 전부 disabled)** 을 유지하면서 활성화 케이스 테스트를 추가한다.
- `web/src/view/EditorMenuBar.jsx` — **enabledIds 패턴의 참조 구현**(114~119행: `enabledSet = enabledIds instanceof Set ? ... : new Set(enabledIds || [])`, 159행: `disabled={!enabledSet.has(item.id)}`, 161행: 활성 항목만 `onSelect` 위임). 툴바도 이와 동일 규약을 쓴다.

## 작업

TDD. `EditorToolBar.test.jsx`에 활성화 케이스 테스트를 먼저 추가(red)한 뒤 컴포넌트를 고친다.

### `EditorToolBar.jsx` 변경 (enabledIds 도입 — 메뉴바와 동일 규약)

```js
export function EditorToolBar({ onSelect, enabledIds }) {
  const enabledSet = enabledIds instanceof Set ? enabledIds : new Set(enabledIds || []);
  // ...
  // 각 버튼:
  //   disabled={!enabledSet.has(btn.id)}
  //   onClick={() => { if (enabledSet.has(btn.id) && onSelect) onSelect(btn.id); }}
}
```

- `enabledIds` 미전달(undefined) → `enabledSet` 빈 집합 → **전 버튼 disabled**(현재 쉘 동작 그대로, 하위호환).
- 글꼴/글씨크기 셀렉트는 그대로 표시 전용(placeholder) — 이번 step에서 결선하지 않는다.
- 주석의 "모든 버튼은 비활성 placeholder다"를 "enabledIds에 든 버튼만 활성, 그 외 placeholder"로 갱신한다(메뉴바 주석과 동형).

### `EditorToolBar.test.jsx` 갱신

- 기존 "props 없이 렌더 시 전 버튼 disabled"·"onSelect 미호출" 테스트는 **enabledIds 미전달 케이스로 유지**(하위호환 잠금).
- 추가: `enabledIds={['tool.memo']}` + `onSelect` spy로 렌더 → `tool-메모장` 버튼이 **활성**이고 클릭 시 `onSelect('tool.memo')` 1회 호출, 그 외 버튼(`tool-새문서` 등)은 여전히 disabled임을 단언.

## 핵심 규칙 (반드시 준수)

1. **하위호환(중요)**: `enabledIds` 미전달 시 전 버튼 disabled — 현재 `<EditorToolBar />`(props 없음) 렌더가 그대로 동작해야 한다. 이유: WriterPage 결선(step 3) 전까지 회귀 없이 green을 유지한다.
2. **메뉴바 규약 재사용**: `enabledSet` 계산·`disabled`·`onSelect` 위임을 `EditorMenuBar`와 동일 형태로 둔다. 이유: 두 크롬의 활성화 계약을 한 가지로 통일해 인지 부담·불일치 버그를 줄인다.
3. **순수 UI 유지(ADR-003)**: `model`/`fetch` 호출 금지. 글꼴/크기 셀렉트는 표시 전용으로 남긴다. 이유: 이 step의 범위는 메모 버튼 활성화 seam뿐이다.
4. **범위 최소화**: `tool.memo` 외 다른 툴바 버튼을 결선하지 마라(찾기/저장 등은 별도 phase). 이유: scope 최소화 원칙.

## Acceptance Criteria

```bash
npm run test:web   # EditorToolBar.test.jsx(하위호환 + 활성화 케이스) 포함 web 전체 통과
npm run build      # vite 빌드 에러 없음
npm run lint       # ESLint 통과
```

추가 단언(`EditorToolBar.test.jsx`):
- props 없이 렌더 시 전 버튼 disabled, 클릭해도 `onSelect` 미호출(하위호환).
- `enabledIds={['tool.memo']}`이면 `tool-메모장`이 활성이고 클릭 시 `onSelect('tool.memo')` 호출, 나머지 버튼은 disabled 유지.

## 검증 절차

1. 위 AC 커맨드 실행.
2. 아키텍처 체크: `EditorToolBar.jsx`에 `model`/`fetch` 없음, `enabledIds` 미전달 하위호환 유지, `EditorMenuBar`와 동일 enabledSet 규약.
3. `phases/21-editor-tools-memo/index.json`의 step 2를 갱신한다.

## 금지사항

- `enabledIds` 미전달 시의 "전 버튼 disabled" 하위호환을 깨지 마라. 이유: WriterPage 결선 전 단계에서 회귀·red 발생.
- `tool.memo` 외 다른 버튼(저장/인쇄/찾기 등)을 이 step에서 결선하지 마라. 이유: scope 최소화 — 각 액션은 자체 설계/phase가 필요하다.
- 글꼴/크기 셀렉트를 실제 에디터 폰트에 결선하지 마라. 이유: 이번 범위 밖(placeholder 유지).
- 기존 툴바 테스트를 삭제해 하위호환 검증을 없애지 마라. 이유: 하위호환은 이 step의 핵심 계약이다.
