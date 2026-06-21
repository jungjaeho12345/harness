# Step 1: editor-menubar — 에디터 상단 메뉴바 (7메뉴 + 드롭다운, 비활성 placeholder)

## 배경 / 요구사항

`docs/news.md` "## 기사 상단 메뉴바"가 7개 상단 메뉴와 각 드롭다운 항목을 정의한다. 이 step은 그 **메뉴바 컴포넌트**를 만든다. 이번 phase는 **쉘**이므로 드롭다운 항목들은 **비활성 placeholder**로 렌더한다(실제 액션 결선은 후속 phase). WriterPage 배치는 Step 3.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view 레이어, 단순화·접근성
- `/docs/news.md` — "## 기사 상단 메뉴바" 절(7메뉴 + 항목 전체 목록), "기사 에디터"의 상단 메뉴바 줄.
- `web/src/view/ListPage.jsx` 또는 `web/src/view/ContextMenu.jsx` — 드롭다운/메뉴 UI·키보드·외부클릭 닫기·`yh-*` 클래스의 기존 패턴 참고.
- `web/src/styles/yonhap.css` — `yh-*` 스타일 컨벤션(메뉴바 클래스 추가).
- (참고) Step 0에서 만든 `web/src/view/StatusBar.jsx` — 같은 쉘 군의 표시 컴포넌트(스타일 톤 일관).

## 작업

TDD로 진행한다(vitest).

### 1. 메뉴 구성 + 컴포넌트 `web/src/view/EditorMenuBar.jsx`

- 7개 상단 메뉴와 항목을 **데이터 구성(config)**으로 둔다(news.md "## 기사 상단 메뉴바" 그대로):
  - 파일: 새문서, 문서열기, 저장, 다른이름으로 저장, 복구, 인쇄, 인쇄미리보기, 닫기
  - 편집: 되돌리기, 다시실행, 잘라내기, 복사, 붙여넣기, 원본 붙여넣기, 텍스트 붙여넣기, 찾기/바꾸기, 전체 선택, 문단 선택, 한줄 선택, 단어 선택, 문서 정렬, 문단 정렬, 한줄 지우기, 단어 지우기, (끝)삽입(Alt+Y), (계속)삽입(Ctrl+Y)
  - 보기: 대문자로 바꾸기, 소문자로 바꾸기, 첫글자 대문자로, 대/소문자 전환, 양쪽으로 정렬, 왼쪽으로 정렬, 가운데로 정렬, 오른쪽으로 정렬
  - 맞춤법: 통합 맞춤법 검사, 문단식 검사, 현재위치까지 검사, 현재위치부터 검사, 통합 맞춤법 검사 안함
  - 표: 표 삽입, 표 삭제, 표 복사, 표 잘라내기, 행 삭제, 열 삭제, 위에 행 추가, 아래에 행 추가, 왼쪽에 열 추가, 오른쪽에 열 추가
  - 도구: 약어변환, 약어관리, 약물 입력, 날짜 삽입, 파일 정보, 그림 삽입, 링크 삽입, 유튜브 영상 삽입, 로컬영상 삽입, 오디오 삽입, 사진발행/DB등록, 기사이력비교, 간체↔번체 변환, 메모장, UI 언어 설정
  - 도움말: 도움말 열기, 에디터 정보, 환경설정
- 시그니처(재량 — 단 계약 유지):
  ```jsx
  export function EditorMenuBar({ onSelect })  // onSelect(itemId) — 선택 콜백(이번 phase에선 미결선/no-op 허용)
  ```
- 동작:
  - 상단 메뉴(파일/편집/…)를 클릭하면 해당 드롭다운이 열리고, 다시 클릭/외부 클릭/Esc로 닫힌다(한 번에 하나만 열림).
  - 드롭다운 항목은 **모두 비활성(disabled) placeholder**로 렌더한다(이번 phase는 쉘). 항목 옆 단축키 표기는 표시만 한다.
  - `onSelect`는 계약상 받아두되, 이번 phase에선 호출하지 않아도 된다(후속 phase에서 항목을 활성화하며 결선). **여기서 실제 편집 액션을 구현하지 마라.**
- 접근성: 상단 메뉴 버튼에 `aria-haspopup`/`aria-expanded`, 드롭다운에 역할/`data-testid`(예: `menubar`, `menu-파일`)를 부여한다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **쉘만 — 액션 미구현**: 드롭다운 항목은 비활성 placeholder다. (끝)삽입·찾기·정렬 등 어떤 편집 동작도 이 컴포넌트에서 실행하지 마라. 이유: 액션 결선은 후속 phase(editor-existing-actions/text-transforms 등)이며, 지금 구현하면 중복·범위 초과.
2. **에디터/WriterPage 무변경**: `Editor.jsx`·`WriterPage.jsx`를 수정하지 마라(배치는 Step 3).
3. **단일 열림**: 동시에 두 드롭다운이 열리지 않게 하라(UX 일관).
4. **모델/네트워크 없음**: 메뉴바는 순수 UI다 — `model`/fetch를 부르지 마라.

## Acceptance Criteria

```bash
npm run test:web    # web 전체 통과 (EditorMenuBar 렌더·드롭다운 열고닫기·비활성 단언)
npm run build
npm run lint
```

추가 단언(vitest):
- 7개 상단 메뉴(파일/편집/보기/맞춤법/표/도구/도움말)가 렌더된다.
- '파일' 클릭 시 드롭다운이 열리고 '새문서'·'인쇄' 등 항목이 보인다. 다시 클릭/Esc로 닫힌다.
- 드롭다운 항목은 `disabled`(비활성)로 렌더된다.
- '편집' 클릭 시 '파일' 드롭다운은 닫힌다(단일 열림).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트: view 컴포넌트, ADR 위반 없음, 에디터 무변경, 쉘 범위 준수.
3. 결과에 따라 `phases/8-editor-chrome-shell/index.json`의 step 1을 업데이트:
   - 성공 → `"status": "completed"`, `"summary": "EditorMenuBar 7메뉴 config·드롭다운 동작·비활성 placeholder 요약"`
   - 3회 실패 → `"status": "error"`, `"error_message"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단

## 금지사항

- 드롭다운 항목에 실제 편집 액션을 결선하지 마라. 이유: 후속 phase 범위. 이번은 비활성 쉘.
- `Editor.jsx`/`WriterPage.jsx`를 수정하지 마라. 이유: 배치는 Step 3.
- 환경설정(도움말>환경설정) 다이얼로그를 구현하지 마라. 이유: 환경설정은 버킷 B의 별도 phase. 여기선 비활성 항목으로만 표시.
- 기존 테스트를 깨뜨리지 마라.
