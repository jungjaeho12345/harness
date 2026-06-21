# Step 2: editor-toolbar — 에디터 툴바 (글꼴/크기 셀렉트 + 버튼군, 비활성 placeholder)

## 배경 / 요구사항

`docs/news.md` "기사 에디터":

> 상단 메뉴바 밑에는 **글씨체, 글씨크기, 새문서, 불러오기, 저장하기, 인쇄, 인쇄미리보기, 찾기/바꾸기, 맞춤법검사, 약물입력, 약어변환, 표 삽입, 그림삽입, 유튜브영상 삽입, 메모장**이 있다.

이 step은 그 **툴바 컴포넌트**를 만든다. 이번 phase는 **쉘**이므로 버튼은 **비활성 placeholder**, 셀렉트는 표시용으로 렌더한다(실제 액션 결선은 후속 phase). WriterPage 배치는 Step 3.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 레이어, 단순화·접근성
- `/docs/news.md` — "기사 에디터" 절(툴바 항목)
- `web/src/view/WriterPage.jsx` — 기존 `yh-btn`/`yh-actionbar` 등 버튼·바 클래스 패턴 참고(스타일 일관).
- `web/src/styles/yonhap.css` — `yh-*` 스타일 컨벤션(툴바 클래스 추가).
- (참고) Step 1의 `web/src/view/EditorMenuBar.jsx` — 같은 쉘 군. 메뉴바 바로 아래 배치되는 형제 컴포넌트(스타일 톤 일관).

## 작업

TDD로 진행한다(vitest).

### 1. 툴바 컴포넌트 `web/src/view/EditorToolBar.jsx`

```jsx
export function EditorToolBar({ onSelect })  // onSelect(toolId) — 이번 phase 미결선/no-op 허용
```

- 구성(news.md 순서):
  - **글씨체(글꼴) 셀렉트** + **글씨크기 셀렉트** — placeholder 옵션 몇 개(예: 글꼴: 바탕/돋움/굴림; 크기: 10/12/14/16). 선택은 표시만(에디터 폰트 실제 변경 없음).
  - **버튼군**: 새문서, 불러오기, 저장하기, 인쇄, 인쇄미리보기, 찾기/바꾸기, 맞춤법검사, 약물입력, 약어변환, 표 삽입, 그림삽입, 유튜브영상 삽입, 메모장 — **모두 비활성(disabled) placeholder**.
- 각 버튼/셀렉트에 접근 가능한 라벨(`aria-label` 또는 텍스트)과 `data-testid`(예: `toolbar`, `tool-새문서`)를 부여한다.
- 순수 UI 컴포넌트(상태는 셀렉트의 로컬 표시값 정도만 — `model`/fetch 금지).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **쉘만 — 액션 미구현**: 버튼은 비활성 placeholder다. 저장/인쇄/찾기/표/그림/유튜브 등 어떤 동작도 이 컴포넌트에서 실행하지 마라. 이유: 후속 phase 범위. (그림/유튜브 삽입은 이미 우측 검색패널로 동작하지만, 툴바 버튼 결선은 후속 phase에서 한다 — 여기서 중복 구현 금지.)
2. **에디터/WriterPage 무변경**: `Editor.jsx`·`WriterPage.jsx`를 수정하지 마라(배치는 Step 3).
3. **모델/네트워크 없음**: 툴바는 순수 UI다 — `model`/fetch를 부르지 마라.
4. **셀렉트는 표시만**: 글꼴/크기 선택이 실제 에디터 폰트를 바꾸지 않는다(placeholder). 이유: 폰트 적용은 환경설정/후속 범위.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (EditorToolBar 렌더·비활성 버튼·셀렉트 단언)
npm run build
npm run lint
```

추가 단언(vitest):
- 글꼴/크기 셀렉트 2개가 렌더된다(옵션 존재).
- '새문서'·'저장하기'·'인쇄'·'찾기/바꾸기'·'표 삽입' 등 버튼이 렌더되고 **disabled**다.
- 버튼 클릭이 어떤 부수효과(model 호출 등)도 일으키지 않는다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 컴포넌트, ADR 위반 없음, 에디터 무변경, 쉘 범위 준수.
3. 결과에 따라 `phases/8-editor-chrome-shell/index.json`의 step 2를 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "EditorToolBar 글꼴/크기 셀렉트·13버튼 비활성 placeholder 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- 버튼에 실제 액션을 결선하지 마라. 이유: 후속 phase 범위. 이번은 비활성 쉘.
- 글꼴/크기 셀렉트로 에디터 폰트를 실제로 바꾸지 마라. 이유: 폰트 적용은 범위 밖.
- `Editor.jsx`/`WriterPage.jsx`를 수정하지 마라. 이유: 배치는 Step 3.
- 기존 테스트를 깨뜨리지 마라.
