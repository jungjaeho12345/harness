# Step 3: latent-state-hygiene

## 목표

phase 31이 백로그로 남긴 **잠복(현재 오손 없음) 위생 2건**을 일괄 정리한다. 둘 다 "지금은 문제가 안 나지만 계열 교훈상 바로잡아 둘" 위생이다:

- **(a) urlEmbedKind 탭 전환 미초기화** — URL 직접 임베드 다이얼로그의 `urlEmbedKind` 로컬 state가 탭 전환 시 초기화되지 않는다. 삽입 전용이라 좌표 오손은 없지만, phase 29~32 계열 교훈("비모달 다이얼로그 + 문서/탭-로컬 상태는 탭 전환마다 초기화")대로 탭 전환 조정 블록에서 닫는다.
- **(b) tableModel deleteRow/deleteCol 최소크기 no-op 비정규화 반환** — 행/열이 1개 이하라 삭제하지 않을 때 **정규화 안 된 원본 `rows`**를 그대로 반환한다(다른 그리드 함수는 정규화 그리드를 반환). 호출부가 모두 정규화 입력이라 무해하나, 반환 계약을 일관되게 `return grid`(정규화)로 맞춘다.

두 변경은 **phase 31 index.json note가 명시적으로 함께 남긴 백로그**라 하나의 응집된 위생 관심사로 묶는다. 각각 재현/회귀 테스트를 먼저 둔다.

## 읽어야 할 파일

라인 번호는 실측 힌트 — 심볼명으로 재확인하라.

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003). `phases/31-editor-table/` note(phases/index.json L179)와 phase 29~32 탭-전환 조정 계열.
- **(a)** `web/src/view/WriterPage.jsx`:
  - **탭 전환 조정 블록 `if (caretTabId !== activeTabId) { ... }`(L317~338)**. 이미 `lastCaretRef.current=null`·`setStatusCaret(null)`·`setShowSpell(false)`·`setSpellIssues([])`·`setSpellHighlights([])`·**`setTableDialog(null)`(L329)**·**`setMetaDialog(null)`(L332)**·`setShowPhotoPublish(false)`·`setShowUiLanguage(false)`를 리셋한다. **여기 `setUrlEmbedKind(null)`이 빠져 있다** — 추가 대상.
  - `const [urlEmbedKind, setUrlEmbedKind] = useState(null);`(L178). 값 도메인 `null | 'image' | 'video' | 'audio' | 'link' | 'localVideo'`. `<UrlEmbedDialog open={urlEmbedKind !== null} ...>`(L1686~).
- **(b)** `web/src/view/tableModel.js`:
  - **`deleteRow(rows, index)`(L69~74)**. L71 `if (grid.length <= 1) return rows;` ← **`return grid;`로 교체**.
  - **`deleteCol(rows, index)`(L77~83)**. L80 `if (cols <= 1) return rows;` ← **`return grid;`로 교체**.
  - `normalizeTableRows`(L17~24): 빈/비배열 → `[]`(새 배열), 셀 문자열 강제·열 패딩. `grid`는 항상 정규화된 새 배열.
- **(a)** `web/src/view/WriterPage.test.jsx` — **탭 전환 다이얼로그 닫힘 테스트 패턴**: L1077('열린 메타 팝업은 탭 전환 시 닫힌다'), L7104·L7292('＋ 버튼으로 새 작성 탭 추가 → 활성 탭 전환 → 조정 블록이 다이얼로그를 닫는다'). URL 임베드 다이얼로그 testid: `url-embed-input`/`url-embed-submit`/`url-embed-close`(L4105·L4212·L7062). 다이얼로그 여는 경로(도구 메뉴 tools.insertImage → `setUrlEmbedKind('image')`, L843)도 확인.
- **(b)** `web/src/view/tableModel.test.js` — **L90~104**(deleteRow/deleteCol 최소 유지 + **L100~104 빈 표 참조-동일성 `toBe(empty)`** ← 계약 변경으로 갱신 대상), L113~126(입력 불변 — 2×2라 정상 경로, 무영향).

## 배경 (자기완결)

**(a)** 탭 전환 조정 블록은 "문서/탭-로컬 상태가 다른 탭으로 이월돼 오작동하는" 계열 버그(phase 29 lastCaretRef·30 spellIssues·31 tableDialog·32 metaDialog)를 렌더-중 조정으로 일괄 리셋한다. `urlEmbedKind`는 **삽입 전용**(다이얼로그에서 URL 1개 입력 → insertEmbed → 즉시 `setUrlEmbedKind(null)`)이라 현재는 이월돼도 실제 오손이 없다(문서-로컬 좌표를 안 들고 있음). 그래도 열린 채 탭 전환하면 다른 탭에서 다이얼로그가 열려 보이는 혼란이 있고, 계열 일관성(비모달+로컬 상태는 전환 시 닫는다)상 조정 블록에 포함하는 게 옳다. `setTableDialog(null)`(L329) 바로 옆에 한 줄 추가한다.

**(b)** `tableModel`의 다른 그리드 함수(insertRow/insertCol/setCell 정상 경로)는 `normalizeTableRows`를 거친 **정규화 그리드**를 반환한다. 그런데 deleteRow/deleteCol의 최소크기 no-op(행/열 1개 이하)만 `return rows`로 **정규화 안 된 원본**을 반환한다. 호출부(WriterPage 표 편집)는 항상 정규화된 rows를 넘기므로 실무상 무해하나, 반환 계약이 비일관하다(같은 함수가 경로에 따라 정규화/비정규화). `return grid`로 통일한다.

**주의(테스트 계약 변경):** 기존 `tableModel.test.js` L100~104는 빈 표에 `deleteRow(empty,0).toBe(empty)`(**참조 동일성**)를 단언한다. `return grid`로 바꾸면 빈 입력의 `grid = normalizeTableRows([])`가 **새 `[]`**라 참조가 달라진다 → 이 단언은 계약 변경에 따라 `toEqual([])`(구조 동일)로 **의도적 갱신**한다(phase 44 step0가 계약 변경 시 기존 단언을 갱신한 선례와 동형).

## TDD — 테스트 먼저

### (a) `web/src/view/WriterPage.test.jsx` — URL 임베드 다이얼로그 탭 전환 닫힘
탭 전환 다이얼로그 닫힘 패턴(L7104·L1077 동형) 1건 추가:
- 도구>그림 삽입 등으로 URL 임베드 다이얼로그를 연다(`setUrlEmbedKind('image')` → `url-embed-input`이 문서에 존재) → ＋ 버튼으로 새 작성 탭 추가/활성 전환 → **다이얼로그가 닫힌다**(`queryByTestId('url-embed-input')`가 `null`, `open={urlEmbedKind !== null}`이 false). *수정 전에는 열린 채 유지돼 실패한다.*

### (b) `web/src/view/tableModel.test.js` — 최소크기 no-op 정규화 반환
- **기존 L100~104 갱신**: `deleteRow([], 0)`·`deleteCol([], 0)` → `toEqual([])`(참조 `toBe(empty)` 단언 제거 — 계약 변경).
- **신규(관측 가능한 위생 red→green)**: 정규화 안 된 최소크기 입력이 **정규화되어** 반환:
  - `deleteRow([['a', null, 3]], 0)` → `toEqual([['a', '', '3']])`(1행이라 삭제 no-op이지만 null→''·3→'3' 정규화). *수정 전에는 원본 `[['a', null, 3]]`을 반환해 실패.*
  - `deleteCol([['a'], [null]], 0)` → `toEqual([['a'], ['']])`(1열이라 no-op이지만 null→'' 정규화). *수정 전 실패.*
- 기존 L90~98(정상 삭제 경로)·L113~126(입력 불변, 2×2 정상 경로) 그린 유지.

## 작업 (구현 상세)

### (a) `web/src/view/WriterPage.jsx`
- 탭 전환 조정 블록(L317~338)의 `setTableDialog(null);`(L329) 근처에 추가:
  ```js
  // URL 임베드 다이얼로그(urlEmbedKind)도 비모달 로컬 state — 삽입 전용이라 오손은 없지만 열린 채
  // 탭 전환되면 다른 탭에서 열려 보인다. 계열 일관성(비모달+로컬 상태는 전환 시 닫는다)상 함께 닫는다.
  setUrlEmbedKind(null);
  ```

### (b) `web/src/view/tableModel.js`
- `deleteRow` L71: `if (grid.length <= 1) return rows;` → `if (grid.length <= 1) return grid;`
- `deleteCol` L80: `if (cols <= 1) return rows;` → `if (cols <= 1) return grid;`
- 두 함수 주석의 "원본 반환"을 "정규화 그리드 반환"으로 정확화(최소 1행/1열 유지 의미는 보존).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — `npm test` 불필요.)

## 회귀 가드 / 불변식

- **(a) 다른 리셋 불변**: 조정 블록의 기존 리셋(lastCaretRef·statusCaret·spell·tableDialog·metaDialog·photoPublish·uiLanguage)은 그대로 — `setUrlEmbedKind(null)` 한 줄만 추가. 삽입 후 `setUrlEmbedKind(null)`(L1407) 경로 불변.
- **(b) 정상 삭제 경로 불변**: 행/열이 2개 이상일 때의 삭제(정규화 새 배열 반환)는 변경 없음. 입력 mutate 없음(순수) 유지.
- **(b) 최소 유지 계약 보존**: 1행/1열은 여전히 삭제하지 않는다(0×N/N×0 방지) — 반환 형태만 정규화로 통일.
- 기준 무회귀: web 1871·backend 427·lint/build clean(단 tableModel.test.js L100~104는 계약 변경으로 의도적 갱신).

## 커밋 계획

- **fix**: `fix(45-editor-backlog-cleanup): step3 — phase31 잠복 위생(urlEmbedKind 탭 전환 초기화 + tableModel deleteRow/deleteCol 정규화 반환)` — `WriterPage.jsx`·`tableModel.js` + `WriterPage.test.jsx`·`tableModel.test.js`.
- **chore**: `chore(45-editor-backlog-cleanup): step3 status — completed` — index.json step3.

## 금지사항

- 탭 전환 조정 블록의 기존 리셋 순서/대상을 재배치하거나 제거하지 마라. 이유: 각 리셋은 특정 계열 버그의 회귀 잠금이다 — `setUrlEmbedKind(null)` 추가만 하라.
- `urlEmbedKind`를 탭별 격리(탭-로컬 state)로 바꾸지 마라. 이유: 삽입 전용 전역 토글이면 충분하다 — 전환 시 닫기(null)만 하면 계열 일관성이 확보된다.
- `tableModel`의 최소 1행/1열 유지 계약을 바꾸지 마라(삭제를 허용하지 마라). 이유: 0×N/N×0 표는 렌더/직렬화를 깨뜨린다 — no-op은 유지하되 반환만 정규화한다.
- `normalizeTableRows`를 건드리지 마라. 이유: 이미 옳다 — deleteRow/deleteCol이 그 결과(`grid`)를 반환하기만 하면 된다.
- 기존 테스트를 깨뜨리지 마라(tableModel.test.js L100~104 참조-동일성 단언은 계약 변경에 따라 `toEqual`로 의도적 갱신 — 그 외는 보존).
