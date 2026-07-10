# Step 2: table-dialog — 표 편집 다이얼로그(그리드 입력, 순수 표시/폼)

## 배경 / 요구사항

표 메뉴에는 '표 수정' 항목이 없다(news.md L181: 삽입/삭제/복사/잘라내기/행·열 추가·삭제만). 본문의 표 임베드는 **읽기 전용 렌더**(step1)이므로, **셀 내용 입력·수정은 다이얼로그**로 한다. 이 step은 그 **순수 표시/폼 컴포넌트** `web/src/view/TableEditDialog.jsx`를 만든다:

- **표 삽입**(`table.insert`): 빈 그리드로 열려 셀을 채우고 삽입한다.
- **표 편집**(본문 표 더블클릭 → step3 결선): 기존 `rows`로 열려 셀을 수정하고 반영한다.

`UrlEmbedDialog.jsx`(phase 18/19)·`GlyphInputDialog.jsx`(phase 17)·`FindReplaceDialog.jsx`(phase 14)와 **동일한 떠있는 다이얼로그 패턴**을 따른다: 순수 표시(모델/fetch/transport/localStorage/window/document 미접근), `open` false→null, `role="dialog"`+`aria-label`, 전용 클래스/testid, Esc 닫기, 동작은 props 콜백 위임.

이 컴포넌트는 **그리드 편집 UI**만 담당한다. 임베드 생성(`makeTableEmbed`)·삽입·본문 블록 교체·타겟 탐색·클립보드는 **부모(step3 WriterPage)**가 한다. 편집 결과는 `onSubmit(rows)`로 2차원 문자열 배열만 넘긴다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003(순수 표시/폼, transport 비의존).
- `/docs/news.md` — L181(표 메뉴), L157(툴바 '표 삽입').
- `web/src/view/UrlEmbedDialog.jsx` — **직접 템플릿**: `open` false→null, 내부 입력 state + `open` false→true 시 초기화(`useEffect`), `useFocusOnOpen(ref, open)`로 열림 시 첫 입력에 포커스(**포커스가 에디터 본문에 남으면 타이핑이 본문에 새고 Esc가 안 먹는다 — 반드시 적용**), `handleKeyDown`(Esc→onClose, Enter→submit), 전용 클래스(`yh-url-embed`)·testid(`url-embed`), '삽입'/'닫기' 버튼, `onSubmit`/`onClose` 미전달 가드, 트림 후 빈 값 no-op.
- `web/src/view/UrlEmbedDialog.test.jsx` — 다이얼로그 테스트 컨벤션(open 토글, 콜백 mock, Esc/닫기, 재오픈 초기화, 미전달 콜백 graceful).
- `web/src/view/useFocusOnOpen.js` — 열림 시 포커스 훅(UrlEmbedDialog가 사용). 그대로 재사용.
- `web/src/view/GlyphInputDialog.jsx` — 참고(순수 표시 + 콜백 위임 + 닫기 버튼 패턴).
- `web/src/view/tableModel.js`(step0) — **순수 그리드 헬퍼 재사용**: `makeEmptyTableRows(r,c)`(삽입 기본 그리드), `insertRow`/`insertCol`/`deleteRow`/`deleteCol`/`setCell`/`normalizeTableRows`. 다이얼로그 로컬 그리드 state 조작에 이 순수 함수들을 쓴다(중복 구현 금지). **이 헬퍼들만 import 허용**(순수) — `makeTableEmbed`(임베드 생성)는 import하지 않는다(부모 책임).
- `web/src/styles/yonhap.css` — 다이얼로그 스타일 위치(`yh-url-embed`/`yh-glyph-input` 인근).

## 작업

TDD로 진행한다(vitest). 먼저 `web/src/view/TableEditDialog.test.jsx`를 작성하고, 통과하는 `web/src/view/TableEditDialog.jsx`를 만든다.

### 컴포넌트 계약 (시그니처 수준)

```jsx
// 표 편집 다이얼로그 — 순수 표시/폼(ADR-003). 그리드 입력 UI만 담당한다.
// 임베드 생성(makeTableEmbed)·삽입·본문 반영·타겟 탐색·클립보드는 부모(step3 WriterPage)가 한다.
// model/fetch/transport/localStorage/window/document 호출 없음. tableModel의 '순수 그리드 헬퍼'만 로컬 편집에 사용.
export function TableEditDialog({
  open,
  initialRows,   // string[][] | undefined — 편집 시 기존 rows, 삽입 시 undefined(기본 그리드로 시작)
  onSubmit,      // (rows: string[][]) => void — '적용/삽입' 클릭 또는 확정 시(정규화된 2차원 배열)
  onClose,       // () => void
}) { ... }
```

요구사항:
- `open`이 false면 `null`. `role="dialog"`, `aria-label`(예 '표 편집'), 전용 클래스(예 `yh-table-dialog`)·전용 testid(예 `table-dialog`). Esc로 `onClose`.
- **로컬 그리드 state**(2차원 문자열 배열)를 내부에서 들고 편집한다. `open` false→true 전환 시 `initialRows`(있으면 `normalizeTableRows(initialRows)`, 없으면 `makeEmptyTableRows(기본 r, 기본 c)`)로 **초기화**한다(`useEffect` — 재오픈 시 이전 편집 잔존 금지). 기본 그리드 크기는 합리적 소형(예 2×2). 최소 1×1.
- **셀 입력**: 각 셀은 `<input>`(또는 `<textarea>`)로, 값은 로컬 state, `onChange`는 `setCell(rows, r, c, value)`로 갱신. 셀마다 식별 가능한 접근성 라벨/testid(예 `aria-label="셀 r,c"` 또는 `data-testid="cell-0-1"`) — 테스트가 특정 셀을 찾을 수 있어야 한다.
- **구조 편집 버튼**: '행 추가'(`insertRow`로 끝에 추가), '열 추가'(`insertCol`), '행 삭제'(`deleteRow`, 최소 1행), '열 삭제'(`deleteCol`, 최소 1열). 각 버튼은 로컬 state를 순수 헬퍼로 갱신만 한다. (위/아래·좌/우 위치 구분은 부모 메뉴 연산이 담당하므로 다이얼로그는 단순 추가/삭제로 충분 — 과한 UI 지양.)
- **확정 버튼**: '삽입'(또는 '적용') 클릭 시 `onSubmit(normalizeTableRows(rows))` 호출 후, 부모가 닫는다(또는 컴포넌트가 onClose 호출 — UrlEmbedDialog는 부모가 setUrlEmbedKind(null)로 닫음; 여기서는 `onSubmit`만 부르고 닫기는 부모에 맡긴다). '닫기'/Esc는 `onClose`.
- **빈 표 가드**: 모든 셀이 공백이어도 표 구조(행/열)는 유효하므로 삽입 허용한다(URL 다이얼로그의 '빈 값 no-op'과 다름 — 표는 빈 셀이 정상). 단 `onSubmit`/`onClose` 미전달 시 예외를 던지지 않는다.
- **CSS**: `yh-table-dialog` 떠있는 패널 + 그리드 스타일 추가(`yh-url-embed` 인근). 기존 스타일 불변.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 표시/폼(ADR-003)**: `model`/`fetch`/`transport`/`localStorage`/`window`/`document`(직접 조작)·`navigator` 호출 금지. 로컬 그리드 state 외 부수효과 없음. 동작은 `onSubmit`/`onClose`로만 위임. 이유: 계층 분리.
2. **임베드 생성 금지**: `makeTableEmbed`·`embedBlock`·블록/캐럿 계산·`insertEmbedAtLine`을 import하거나 호출하지 마라. `onSubmit(rows)`로 **2차원 문자열 배열만** 넘긴다. 이유: Scope 최소화 — 임베드화·삽입은 step3.
3. **순수 헬퍼만 재사용**: `tableModel`에서 `makeEmptyTableRows`/`insertRow`/`insertCol`/`deleteRow`/`deleteCol`/`setCell`/`normalizeTableRows`(순수)만 import. 그리드 변형 로직을 이 컴포넌트에 복붙하지 마라. 이유: step0 단일 출처.
4. **열림 시 포커스 이전**: `useFocusOnOpen`으로 첫 셀(또는 논리적 첫 입력)에 포커스를 옮긴다. 이유: 포커스가 에디터 본문에 남으면 셀 타이핑이 기사 본문에 삽입되고 Esc 닫기가 발화하지 않는다(27-editor-critical-fixes 사례).
5. **전용 클래스/testid**: `yh-url-embed`/`yh-glyph-input`/`yh-find-replace`와 다른 전용 className/testid. 이유: 회귀·스타일 충돌 방지.
6. **재오픈 초기화**: `open` false→true마다 `initialRows`(정규화)/기본 그리드로 재초기화. 이전 세션 편집이 남지 않게. 이유: 삽입/편집 재사용 시 stale 그리드 방지.

## Acceptance Criteria

```bash
npm run test:web -- TableEditDialog   # 신규 TableEditDialog.test.jsx 통과(vitest 파일 필터)
npm run test:web -- tableModel        # step0 회귀 통과
npm run test:web                      # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `TableEditDialog.test.jsx`):
- `open={false}`면 아무것도 렌더되지 않는다(null).
- `open` + `initialRows` 미전달 → 기본 그리드(예 2×2) 셀 입력이 보인다(`role="dialog"` '표 편집').
- `open` + `initialRows={[["가","나"]]}` → 셀 입력에 `가`/`나`가 채워져 보인다.
- 특정 셀 입력에 타이핑 후 '삽입/적용' 클릭 시 `onSubmit`이 그 값을 반영한 2차원 배열로 호출된다(예 `[["가","수정"],...]`).
- '행 추가' 클릭 → 행 수가 1 증가(셀 입력 개수 증가). '열 추가' → 열 수 증가.
- '행 삭제'가 최소 1행을 남긴다(1행에서 삭제 시 그대로). '열 삭제' 동형(최소 1열).
- Esc 또는 '닫기'로 `onClose` 호출.
- `open` false→true 재전환 시 그리드가 `initialRows`/기본으로 초기화된다(이전 편집 미잔존).
- `onSubmit`/`onClose` 미전달 시 클릭/Enter/Esc가 예외를 던지지 않는다.
- (순수성) 컴포넌트가 `model`/`fetch`/`localStorage`/`navigator`를 호출하지 않는다(`grep` 확인 — 테스트는 렌더/콜백만).

## 검증 절차

1. 위 AC 커맨드 실행(한글 깨지면 UTF-8 로케일 확인).
2. 아키텍처 체크리스트: 순수 표시(transport/localStorage/검증/임베드 생성 없음), `makeTableEmbed`/`embedBlock` 미import(`grep`), `tableModel` **순수 헬퍼만** import, 전용 클래스/testid, `useFocusOnOpen` 적용, 재오픈 초기화.
3. 결과에 따라 `phases/31-editor-table/index.json`의 step 2를 갱신(completed+summary / error / blocked).

## 금지사항

- `makeTableEmbed`/`embedBlock`/`insertEmbedAtLine`을 import하거나 호출하지 마라. 이유: 임베드 생성·삽입은 step3 결선 담당(Scope 최소화).
- 블록/캐럿/본문 직렬화(`serialize`/`deserialize`) 계산을 이 컴포넌트에 넣지 마라. 이유: step3 WriterPage 담당.
- `model`/`fetch`/`localStorage`/`window`/`document`(직접 DOM 조작)·`navigator.clipboard`를 호출하지 마라. 이유: ADR-003 순수 표시/폼.
- 그리드 변형 로직(행/열 추가·삭제·셀 치환)을 자체 구현하지 마라. 이유: step0 `tableModel` 순수 헬퍼가 단일 출처 — 갈라지면 정규화/불변식이 어긋난다.
- `yh-url-embed`/`yh-glyph-input`/`yh-find-replace`와 같은 className/testid를 재사용하지 마라. 이유: 회귀·스타일 충돌.
- `Editor.jsx`/`WriterPage.jsx`/`InlineEmbed.jsx`/`server/`를 수정하지 마라(이 step은 신규 컴포넌트+테스트+CSS만). 이유: 결선은 step3.
- 셀 값을 이스케이프하거나 HTML로 변환하지 마라. 이유: XSS 방어는 렌더(step1)의 텍스트-only가 담당 — 다이얼로그는 원본 문자열만 보관(이중 이스케이프 방지).
