# Step 1: diff-and-compare-dialog — 라인 diff 순수 함수 + 읽기전용 비교 다이얼로그

## 배경 / 요구사항

Step 0이 백엔드에 편집 본문 스냅샷 기록 + 단건 스냅샷 조회 API를 만들었다. 이 step은 **클라이언트 순수 로직**만 만든다(결선은 step2):
1. 라인 기반 **diff 순수 함수** `diffLines(a, b)`(LCS — **새 npm 의존성 금지**, 직접 구현).
2. **읽기전용 비교 다이얼로그** `HistoryCompareDialog.jsx` — 스냅샷 목록에서 비교 대상 2개(또는 1개 + 현재 본문)를 선택해 좌우/인라인 diff를 표시한다. 본문/캐럿/임베드를 바꾸지 않는다(표시 전용).

이 step은 **transport에 의존하지 않는다**(ADR-003) — 다이얼로그는 `httpModel`/`fetch`/`model`을 호출하지 않는다. 비교 대상 데이터(스냅샷 목록, 선택된 두 본문 텍스트)는 **부모(step2 WriterPage)가 props로 주입**한다. diff 계산은 순수 함수라 다이얼로그 렌더 중 호출해도 되고, 부모가 계산해 넘겨도 된다(구현 재량).

기존 다이얼로그 패턴을 따른다: **읽기전용 표시 다이얼로그는 `FileInfoDialog.jsx`가 선례**(props만·입력폼/onSubmit 없음·전용 className/testid·Esc/닫기 onClose). 선택 UI가 있으므로 완전 stateless일 필요는 없으나(선택 인덱스는 UI 상태로 로컬 보유 가능), **transport 호출·본문 변경은 절대 하지 않는다**.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC(View 순수 ← Controller ← Model), 명령어. View는 transport-agnostic.
- `/docs/ADR.md` — ADR-003(View는 순수·transport 비의존, Model 뒤로 REST 격리). 철학(외부 의존성 최소화 — diff 직접 구현).
- `/docs/news.md` L182 — 도구 메뉴 '기사이력비교'.
- `web/src/view/FileInfoDialog.jsx` — **읽기전용 다이얼로그 선례**: props(open/데이터/onClose)만, `if (!open) return null`, `role="dialog"` + aria-label, 전용 `yh-file-info`/`file-info` className·testid, 각 표시 항목 testid, `handleKeyDown`으로 Esc→onClose, 입력폼/onSubmit 없음, 안전 폴백. **이 구조를 그대로 본뜬다.**
- `web/src/view/FindReplaceDialog.jsx` — 선택/컨트롤이 있는 다이얼로그의 로컬 UI 상태 패턴 참고(선택 인덱스 정도의 로컬 state는 View에서 허용 — transport만 아니면 됨).
- `web/src/view/editorContent.js` — `deserialize(raw)`, `blocksToText(blocks)`. 스냅샷 본문(markupVersion 블록 JSON)을 **비교용 텍스트로 변환**할 때 재사용한다(임베드 제외, 텍스트 블록만). 순수 함수라 다이얼로그에서 import 가능. (단, 부모가 텍스트로 변환해 주입하는 방식도 허용 — 구현 재량. 어느 쪽이든 변환 로직은 **이 두 순수 함수만** 쓴다.)
- `web/src/view/editorFind.js`, `web/src/view/editorSelect.js` — 순수 view 헬퍼 모듈 컨벤션(파일 구조·export 스타일·JSDoc 톤) 참고. diff 모듈을 같은 스타일로 작성한다.
- `web/src/view/editorStats.test.js` 또는 `web/src/view/editorFind.test.js` — 순수 함수 vitest 테스트 컨벤션(입력→기대 출력 케이스 나열).
- `web/src/view/FileInfoDialog.test.jsx` (있으면) — 읽기전용 다이얼로그 vitest 렌더/닫기/testid 단언 컨벤션.
- `web/src/styles/yonhap.css` — `yh-file-info` 등 다이얼로그 패널 스타일 참고(신규 `yh-history-compare` 스타일을 추가할 위치).

## 작업

TDD로 진행한다(vitest). **테스트를 먼저** 작성하고 통과하는 구현을 만든다.

### 1. 순수 diff 함수 — 새 파일 `web/src/view/historyDiff.js`
- 시그니처: `export function diffLines(aText, bText)` — 두 본문 **텍스트**(개행으로 구분된 라인들)를 받아 라인 단위 diff를 반환한다.
- 알고리즘: **LCS(최장 공통 부분수열)** 기반 라인 diff를 **직접 구현**한다(새 의존성 없음). 표준 동적계획 LCS면 충분하다.
- 반환: 순서가 보존된 세그먼트 배열. 각 세그먼트는 최소한 `{ type, text }`를 갖는다:
  - `type: 'equal'` — 양쪽에 공통인 라인.
  - `type: 'del'` — a(왼쪽/이전)에만 있는 라인(제거됨).
  - `type: 'add'` — b(오른쪽/이후)에만 있는 라인(추가됨).
  - (선택) 라인 번호(`aIndex`/`bIndex`) 등 부가 필드는 재량. 다이얼로그가 좌우 정렬 렌더에 쓸 수 있으면 유용.
- 순수·결정적: 같은 입력 → 같은 출력. 부수효과·`Date`·`Math.random`·DOM·fetch 없음.
- 엣지: 빈 문자열/동일 입력(전부 equal)/완전 상이(모두 del+add)/한쪽만 빈 경우를 안전 처리.

### 2. 비교 다이얼로그 — 새 파일 `web/src/view/HistoryCompareDialog.jsx`
- 읽기전용 표시 컴포넌트(`FileInfoDialog` 구조 본뜨기). `if (!open) return null`. 전용 className `yh-history-compare`, 루트 `data-testid="history-compare"`, `role="dialog"` + `aria-label="기사 이력 비교"`. Esc/닫기 → `onClose`.
- props(계약 — 이름/형태는 구현 재량이되 아래 역할을 만족):
  - `open` — 표시 여부.
  - `entries` — 비교 대상 선택 목록. 각 항목은 `{ key, label }` 형태(예: `{ key: 'current', label: '현재 본문' }`, `{ key: <historyId>, label: '<시각> <작성자>' }`). **부모가 스냅샷 이력 + 현재 본문을 합쳐 주입**한다.
  - `leftKey`/`rightKey`(선택된 두 대상 key) — 부모 소유 또는 로컬 선택 상태(재량). 좌/우 각각 `entries`에서 하나 선택.
  - `leftText`/`rightText` — 선택된 두 대상의 **비교용 텍스트**(부모가 스냅샷을 지연 조회·변환해 주입, 로딩 중이면 null/빈값). null이면 "불러오는 중/선택하세요" 안내.
  - `onSelectLeft(key)`/`onSelectRight(key)` — 선택 변경 콜백(부모가 해당 스냅샷 본문을 조회·해소).
  - `onClose` — 닫기.
- 렌더:
  - 좌/우 대상 선택 컨트롤(예: `<select>` 또는 버튼 목록) — `entries`로 채운다.
  - 두 텍스트가 모두 준비되면 `diffLines(leftText, rightText)`로 diff를 계산해 **읽기전용**으로 표시한다(좌우 컬럼 또는 인라인 — 재량). 각 세그먼트 type에 따라 시각 구분(추가/삭제/공통) 클래스를 준다.
  - 스냅샷이 하나도 없을 때(entries에 비교 가능한 스냅샷 없음)는 **빈 상태**("비교할 이력이 없습니다" 등)를 표시한다. 죽지 않는다.
- **읽기전용 불변식**: 입력폼(본문 편집)·onSubmit·onPick(삽입) 없음. `updateField`/`serialize`/model 호출 없음. 이 컴포넌트는 **표시만** 한다.
- diff 세그먼트에는 안정적 testid/className(예: `history-compare-diff`, 세그먼트별 `data-type`)을 부여해 테스트가 add/del/equal을 검증할 수 있게 한다.

### 3. 스타일 — `web/src/styles/yonhap.css`
- `yh-history-compare` 패널 + diff 세그먼트(추가/삭제/공통) 스타일을 추가한다(`yh-file-info` 패널 스타일과 동일 톤). 표시 전용 — 레이아웃/색 구분만.

## Acceptance Criteria

```bash
npm run test:web      # web(vitest) — historyDiff + HistoryCompareDialog 신규 테스트 + 전체 회귀 통과
npm run lint          # ESLint
```

기대 단언(vitest):
- `diffLines`:
  - 동일 텍스트 → 전 세그먼트 `equal`.
  - 한 라인 추가/삭제 → 해당 라인만 `add`/`del`, 나머지 `equal`(LCS로 공통 라인 유지).
  - 완전 상이 → 왼쪽 라인들 `del` + 오른쪽 라인들 `add`.
  - 빈 문자열·한쪽만 빈 경우 안전(throw 없음).
  - 순수·결정적(같은 입력 2회 호출 동일 결과).
- `HistoryCompareDialog`:
  - `open=false`면 렌더되지 않는다.
  - `entries`를 좌/우 선택 컨트롤에 표시한다.
  - 두 텍스트 주입 시 `diffLines` 결과가 표시된다(추가/삭제 세그먼트가 각각 렌더됨 — testid/`data-type`로 확인).
  - 비교할 스냅샷이 없으면 빈 상태를 표시한다.
  - **읽기전용**: 다이얼로그 안에 본문 입력용 input/textarea가 없다(선택용 select는 허용 — 본문 편집 입력만 없음을 단언).
  - '닫기'/Esc로 `onClose`가 호출된다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: diff는 순수·의존성 0·LCS 직접 구현·결정적. 다이얼로그는 transport 미호출·본문/캐럿/임베드 무변경·읽기전용·전용 className/testid·Esc/닫기 onClose. 스냅샷→텍스트 변환은 `deserialize`/`blocksToText`만 사용.
3. 결과에 따라 `phases/25-article-history-compare/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- `diffLines`에 diff 라이브러리(npm 의존성)를 추가하지 마라. 이유: 철학 — 외부 의존성 최소화, LCS 라인 diff는 직접 구현으로 충분.
- `diffLines`에 `Date`/`Math.random`/DOM/fetch 등 부수효과를 넣지 마라. 이유: 순수·결정적이어야 테스트·재사용이 안전.
- `HistoryCompareDialog`에서 `httpModel`/`fetch`/`model`을 호출하지 마라. 이유: ADR-003 — View는 transport 비의존. 스냅샷 조회는 부모(step2)가 model 경유로 한다.
- 다이얼로그에서 `updateField`/`serialize`/`insertEmbed`/본문 편집 입력폼을 두지 마라. 이유: 읽기전용 표시 — 본문/캐럿/임베드 무변경(매핑에서도 안전해야 함).
- 스냅샷 본문 → 텍스트 변환에 `deserialize`/`blocksToText` 외 다른 파서를 새로 만들지 마라. 이유: 본문 포맷 단일 출처(editorContent) — 백엔드/에디터와 동일 규칙.
- `WriterPage.jsx`·`server/`·`contract.js`·`httpModel.js`·`Editor.jsx`·`EditorMenuBar.jsx`를 이 step에서 건드리지 마라. 이유: 이 step은 순수 로직/컴포넌트만 — 결선은 step2.
