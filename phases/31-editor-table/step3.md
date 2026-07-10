# Step 3: table-wiring — 표 메뉴 10종 WriterPage 결선(삽입/편집/행·열/복사/잘라내기/삭제)

## 배경 / 요구사항

step0(데이터 모델·순수 헬퍼), step1(에디터+상세 렌더), step2(편집 다이얼로그)를 조립해 **에디터 상단 '표' 메뉴 10종을 결선**한다(news.md L181). 대상 파일은 `web/src/view/WriterPage.jsx` 하나(+테스트). phase 18/19의 도구 메뉴 결선(`onMenuSelect` 라우팅 + 다이얼로그 렌더 + `MENU_ENABLED` 추가)과 **동일 패턴**을 따른다.

### 결선할 10종 메뉴 항목 (EditorMenuBar id)
1. `table.insert` 표 삽입 — 빈 그리드 다이얼로그 → `makeTableEmbed(rows)` → 캐럿 줄 뒤 삽입.
2. `table.delete` 표 삭제 — 대상 표 블록 제거.
3. `table.copy` 표 복사 — 대상 표를 시스템 클립보드에 TSV로 쓴다.
4. `table.cut` 표 잘라내기 — 복사 + 대상 표 블록 제거.
5. `table.deleteRow` 행 삭제 — 대상 표 마지막 행 삭제(최소 1행).
6. `table.deleteCol` 열 삭제 — 대상 표 마지막 열 삭제(최소 1열).
7. `table.addRowAbove` 위에 행 추가 — 대상 표 맨 위(index 0)에 빈 행.
8. `table.addRowBelow` 아래에 행 추가 — 대상 표 맨 아래(append)에 빈 행.
9. `table.addColLeft` 왼쪽에 열 추가 — 모든 행 index 0에 빈 셀.
10. `table.addColRight` 오른쪽에 열 추가 — 모든 행 끝에 빈 셀.

### 확정된 설계 결정 (이 방향으로 결선하라 — 근거는 각 항목에)

- **셀 편집 UX = 다이얼로그**(인라인 아님). 본문 표는 읽기 전용 렌더(step1). 편집은 `TableEditDialog`(step2). 근거: 인라인 셀 편집은 `Editor.readEditorBlocks`의 "1줄=1 텍스트 블록" 불변식·`readCaret`을 파괴하고 Editor.jsx 대수술을 부른다(범위 밖). 모든 기존 임베드도 본문에서 읽기 전용이다.
- **대상 표 선택 = 캐럿 인접**(메뉴 연산). `table.delete`/`copy`/`cut`/`deleteRow`/`deleteCol`/`add*`는 `findTargetTableIndex(blocks, caretBlockIndex)`(step0)로 캐럿에 가장 가까운 표를 대상으로 한다. `caretBlockIndex`는 `lastCaretRef.current.lineIndex`(텍스트-줄) → `textLineToBlockIndex(blocks, lineIndex)`(writerBody)로 계산한다. 대상 표가 없으면 `window.alert`로 안내하고 no-op. 근거: 클릭-선택 하이라이트는 Editor가 snapRef로 재렌더를 막아 시각 피드백이 어렵고 Editor.jsx 결합을 부른다 — 캐럿 인접은 결정적이고 추가 인프라·Editor.jsx 접촉이 없다. 표 삽입 직후 캐럿이 표 바로 뒤 빈 줄에 놓이므로(insertEmbedAtLine) 곧바로 그 표가 대상이 되는 자연스러운 흐름.
- **셀 편집 진입 = 본문 표 더블클릭**. `.yh-writer__canvas` 래퍼에 `onDoubleClick` 위임을 달아(기존 `onContextMenu` 위임과 동형) `e.target.closest('figure.yh-embed[data-embed-type="table"]')`의 `data-embed-key`(= 블록 인덱스, InlineEmbed L88)를 읽어 그 표를 `TableEditDialog`(편집 모드, 기존 rows)로 연다. 제출 시 그 블록을 교체한다. 근거: '표 수정' 메뉴 항목이 없다 → 편집 진입은 표준 더블클릭 제스처. DOM 위임은 Editor.jsx 미접촉으로 가능(canvas는 이미 위임 지점).
- **표 복사/잘라내기 = 시스템 클립보드(TSV)**. '표 붙여넣기' 메뉴 항목이 없으므로 내부 버퍼 재붙여넣기는 범위 밖. 복사는 `tableToTsv(rows)`를 `navigator.clipboard.writeText`로 쓰고(외부 앱 붙여넣기 지원), 잘라내기는 복사 후 블록 제거. 클립보드 미지원/거부 시 `window.alert` 안내(pasteOriginalAtCaret 가드 선례). 근거: 워드프로세서의 표 복사=외부로 반출, 앱 내 표-붙여넣기 대상이 없다.
- **매핑 모드 정책 = 임베드 parity(표 연산 허용)**. 표는 임베드이므로 phase 18/19의 "임베드 삽입/삭제는 매핑에서도 허용" 정책을 따른다. 모든 `table.*` 라우팅을 `onMenuSelect`의 `if (isMapping) return;` **앞**에 둔다(tools.insertImage와 동형). 표 연산은 **임베드 블록만** 바꾸고 텍스트 블록은 건드리지 않으므로 본문-only 불변식이 자동 보존된다.
- **행/열 엣지 시맨틱**: 본문 표에는 셀 캐럿이 없으므로 add/delete의 위치를 결정적으로 고정한다 — addRowAbove=index0, addRowBelow=append, addColLeft=index0, addColRight=append, deleteRow=마지막 행, deleteCol=마지막 열. 세밀한 위치 편집은 다이얼로그(step2)가 담당. 근거: 결정적·테스트 가능·모호성 없음.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`.
- `/docs/news.md` — L181(표 메뉴 10종), L161·L167(임베딩·"(끝)" 규칙 — 삽입 위치 정합).
- `web/src/view/WriterPage.jsx` — **결선 대상**. 읽을 앵커:
  - `MENU_ENABLED`(L80: 결선 메뉴 id 배열 — 여기에 `table.*` 10개 추가).
  - `onMenuSelect(id)`(L415~470: 매핑 가드 앞=임베드/열기 항목, 뒤=본문 변경 항목. `tools.insertImage`가 `setUrlEmbedKind('image')`로 다이얼로그를 여는 패턴 — table.insert도 동형).
  - `insertEmbedAtLine(embed, caretLine, srcBody, mapping)`(L603~612)·`insertEmbed(embed)`(L615: 검색패널 삽입 = `lastCaretRef.current.lineIndex`에 삽입). table.insert가 재사용.
  - `onRemoveEmbed(blockIndex)`(L592~597: 블록 splice 후 `updateField('body', serialize(next))`) — 표 삭제/블록 교체의 참조 패턴.
  - `lastCaretRef`(L188: 마지막 캐럿 {lineIndex, offset})·`blocks = deserialize(body)`(L185).
  - `onUrlEmbedSubmit(url)`(L693~702) + `<UrlEmbedDialog .../>` 렌더(L894~899) — 다이얼로그 열기/제출/닫기 결선 패턴(table 다이얼로그도 동형).
  - `.yh-writer__canvas` 래퍼의 `onContextMenu`(L774: `e.preventDefault(); setCtxMenu({x,y})`) — `onDoubleClick` 위임을 나란히 추가할 지점.
  - `pasteOriginalAtCaret`(L659~687: `navigator.clipboard` 미지원/거부 시 `window.alert` 가드) — 클립보드 접근·실패 안내 선례.
- `web/src/view/tableModel.js`(step0) — `makeTableEmbed`, `insertRow`/`insertCol`/`deleteRow`/`deleteCol`, `tableToTsv`, `findTargetTableIndex`, `isTableEmbed`, `normalizeTableRows`.
- `web/src/view/writerBody.js` — `textLineToBlockIndex(blocks, textLineIndex)`(캐럿 텍스트-줄 → 블록 인덱스).
- `web/src/view/TableEditDialog.jsx`(step2) — props(`open`/`initialRows`/`onSubmit`/`onClose`).
- `web/src/view/InlineEmbed.jsx`(step1) — 표 figure에 `data-embed-type="table"`·`data-embed-key`(블록 인덱스)가 박히는지 확인(더블클릭 위임의 근거).
- `web/src/view/WriterPage.test.jsx` — **테스트 하니스**: `setup({identity, pendingEdit, seed})`, `openTopMenu(name)`(우클릭→'메뉴바 보이기'→상단 메뉴 클릭), `openWith(blocks)`(markupVersion 편집 진입), `fireEvent`/`userEvent`/`within`. 표 메뉴 결선 테스트를 이 컨벤션으로 추가.

## 작업

TDD로 진행한다(vitest). WriterPage.test.jsx에 표 메뉴 결선 테스트를 먼저 추가하고, 통과하도록 WriterPage.jsx를 결선한다.

### 결선 항목

1. **import**: `tableModel`에서 `makeTableEmbed`/`insertRow`/`insertCol`/`deleteRow`/`deleteCol`/`tableToTsv`/`findTargetTableIndex`/`isTableEmbed`/`normalizeTableRows`, `TableEditDialog` 추가.
2. **`MENU_ENABLED`**: `table.insert`/`delete`/`copy`/`cut`/`deleteRow`/`deleteCol`/`addRowAbove`/`addRowBelow`/`addColLeft`/`addColRight` 10개 추가.
3. **다이얼로그 state**: `const [tableDialog, setTableDialog] = useState(null);` — `null`(닫힘) | `{ mode:'insert' }` | `{ mode:'edit', blockIndex, rows }`. (UrlEmbedDialog의 `urlEmbedKind` 패턴 확장.)
4. **대상 표 도출 헬퍼**(WriterPage 내부): 캐럿 → 대상 표 블록 인덱스.
   ```js
   const targetTableIndex = () => {
     const caretLine = lastCaretRef.current ? lastCaretRef.current.lineIndex : null;
     const caretBlock = caretLine == null ? null : textLineToBlockIndex(blocks, caretLine);
     return findTargetTableIndex(blocks, caretBlock);
   };
   ```
5. **`onMenuSelect`에 table.* 라우팅(매핑 가드 앞)**:
   - `table.insert` → `setTableDialog({ mode:'insert' })`.
   - 나머지 9종 → 공통 헬퍼로 대상 표를 잡고 없으면 alert:
     ```js
     const idx = targetTableIndex();
     if (idx < 0) { window.alert('대상 표가 없습니다. 표 근처에 커서를 두세요.'); return; }
     const rows = blocks[idx].rows;
     ```
     - `table.delete` → `blocks`에서 idx 블록 splice → `updateField('body', serialize(next))`(onRemoveEmbed 패턴).
     - `table.copy` → `writeTableToClipboard(rows)`(아래).
     - `table.cut` → `writeTableToClipboard(rows)` 후 idx 블록 splice.
     - `table.deleteRow` → 블록 rows를 `deleteRow(rows, rows.length-1)`로 교체.
     - `table.deleteCol` → `deleteCol(rows, cols-1)`로 교체.
     - `table.addRowAbove` → `insertRow(rows, 0)`; `addRowBelow` → `insertRow(rows, rows.length)`.
     - `table.addColLeft` → `insertCol(rows, 0)`; `addColRight` → `insertCol(rows, cols)`.
     - 블록 교체는 `makeTableEmbed(newRows)`로 새 임베드를 만들어 `next[idx] = newEmbed` 후 직렬화(정규화 일관 — rows를 직접 심지 말고 팩토리 경유).
6. **클립보드 헬퍼**(WriterPage 내부, pasteOriginalAtCaret 선례):
   ```js
   const writeTableToClipboard = async (rows) => {
     const clip = typeof navigator !== 'undefined' ? navigator.clipboard : null;
     if (!clip || typeof clip.writeText !== 'function') { window.alert('이 브라우저에서는 표 복사를 지원하지 않습니다.'); return false; }
     try { await clip.writeText(tableToTsv(rows)); return true; }
     catch { window.alert('클립보드 접근이 거부되어 표를 복사할 수 없습니다.'); return false; }
   };
   ```
   잘라내기는 복사 성공/실패와 무관하게 블록 제거할지, 복사 성공 시에만 제거할지 결정해 주석에 명시(권장: 복사 실패해도 잘라내기의 '제거'는 진행 — 사용자 의도는 제거).
7. **다이얼로그 제출 핸들러**:
   ```js
   const onTableSubmit = (rows) => {
     const embed = makeTableEmbed(rows); // 빈 표면 null → no-op
     if (tableDialog?.mode === 'edit' && typeof tableDialog.blockIndex === 'number') {
       // 편집: 해당 블록 교체(임베드면). embed가 null(전부 비었지만 구조 유효)이면 정책 결정: 빈 표 유지 위해 makeTableEmbed가 null 안 되게 최소 1×1 보장됨.
       const next = blocks.slice();
       if (embed && isTableEmbed(next[tableDialog.blockIndex])) next[tableDialog.blockIndex] = embed;
       updateField('body', serialize(next));
     } else if (embed) {
       insertEmbed(embed); // 삽입: 캐럿 줄 뒤(매핑 시 "(끝)" 앞 append) — 기존 임베드 경로 재사용
     }
     setTableDialog(null);
   };
   ```
   (편집 시 `blockIndex`가 최신 blocks에서 여전히 table 임베드인지 `isTableEmbed`로 방어 — 그 사이 본문이 바뀌었을 수 있음.)
8. **더블클릭 위임**: `.yh-writer__canvas`에 `onDoubleClick` 추가:
   ```js
   onDoubleClick={(e) => {
     const fig = e.target.closest && e.target.closest('figure.yh-embed[data-embed-type="table"]');
     if (!fig) return;
     const key = fig.dataset ? fig.dataset.embedKey : undefined;
     const i = key == null || key === '' ? -1 : Number(key);
     if (i < 0 || i >= blocks.length || !isTableEmbed(blocks[i])) return;
     setTableDialog({ mode:'edit', blockIndex:i, rows: normalizeTableRows(blocks[i].rows) });
   }}
   ```
   기존 `onContextMenu`는 유지(나란히 추가). 매핑 모드에서도 편집 진입 허용(임베드 변경 parity) — 단 mapping이면 편집 제출이 임베드만 바꾸므로 안전.
9. **다이얼로그 렌더**(다른 다이얼로그 인근, L951 부근):
   ```jsx
   <TableEditDialog
     open={tableDialog !== null}
     initialRows={tableDialog && tableDialog.mode === 'edit' ? tableDialog.rows : undefined}
     onSubmit={onTableSubmit}
     onClose={() => setTableDialog(null)}
   />
   ```

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **본문-only 불변식 보존**: 모든 표 연산은 **임베드 블록만** 바꾼다(splice/교체). 텍스트 블록의 텍스트·순서를 바꾸지 마라. 삽입은 기존 `insertEmbed`/`insertEmbedAtLine` 경로만 쓴다("(끝)" 최종 블록·커서 이동 규칙 재사용). 이유: 매핑/일반 모두에서 텍스트 무결성·news.md L167("(끝)" 규칙) 유지.
2. **팩토리 경유 정규화**: 블록에 심는 rows는 항상 `makeTableEmbed`(내부 `normalizeTableRows`)로 만든 임베드로 넣는다. `blocks[idx].rows`를 직접 수정하거나 raw 2차원 배열을 블록에 심지 마라. 이유: 직사각형·문자열 강제 단일 출처(step0) 우회 방지.
3. **매핑 = 임베드 parity**: `table.*` 라우팅은 `if (isMapping) return;` **앞**에 둔다. 이유: 표는 임베드 — phase 18/19 정책과 일치, 매핑에서도 임베드 추가/삭제/변경 허용.
4. **불변 갱신**: `blocks.slice()` 후 교체/splice → `updateField('body', serialize(next))`만으로 본문을 바꾼다. `contentEditable` DOM을 직접 조작하지 마라(더블클릭 위임의 `closest`/`dataset` **읽기**는 허용). 이유: 안전 경로(직렬화)만 — Editor 캐럿/크래시 방지 규칙.
5. **Editor.jsx·InlineEmbed 미접촉**: 이 step은 `WriterPage.jsx`(+test)만 만진다. `Editor.jsx`에 prop을 추가하거나 `InlineEmbed.jsx`를 바꾸지 마라(step1에서 표 렌더 완료). 이유: 입력/키 경로 회귀 위험 — 더블클릭은 canvas DOM 위임으로 해결(Editor 결합 없음).
6. **클립보드 실패 graceful**: `navigator.clipboard` 미지원/거부 시 예외를 던지지 말고 `window.alert`로만 안내(pasteOriginalAtCaret 선례). 이유: jsdom/구브라우저에서 죽지 않게.
7. **대상 없음 no-op**: 대상 표가 없으면(`findTargetTableIndex` -1) alert 후 조용히 return. 본문을 바꾸지 마라. 이유: 죽은 연산 방지·본문 오염 방지.
8. **server/·DB·스키마 무변경**: 표는 본문 markupVersion 안에 직렬화된다. `server/`·DB·스키마를 건드리지 마라. 이유: 스키마 변경 없이 가능(기존 임베드와 동일 저장 경로)·DB 비파괴.

## Acceptance Criteria

```bash
npm run test:web -- WriterPage        # 표 메뉴 결선 테스트 통과(vitest 파일 필터)
npm run test:web -- tableModel TableEditDialog InlineEmbed articleDetail   # step0~2 회귀
npm run test:web                      # web 전체 회귀 통과
npm run test                          # 백엔드 회귀(무변경 확인)
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx` — `openTopMenu`/`openWith` 하니스 사용):
- '표' 상단 메뉴의 10개 항목이 **활성**이다(전부 `MENU_ENABLED`). (이전 placeholder였음 → 활성으로 갱신하는 회귀 단언.)
- **삽입**: `table.insert` 클릭 → `table-dialog`가 열린다. 셀 입력 후 '삽입' → 본문 blocks에 `embedType:'table'` 임베드가 추가되고 셀 값이 보존된다(직렬화 body 검사 또는 렌더된 `<table>` 셀 텍스트).
- **편집(더블클릭)**: 표 임베드를 가진 기사로 진입(`openWith([textBlock('제목'), tableEmbed, ...])`) → 본문 표 figure를 `fireEvent.doubleClick` → `table-dialog`가 기존 rows로 열린다. 셀 수정 후 제출 → 그 블록의 rows가 갱신되고 **다른 블록·텍스트는 불변**.
- **행/열 연산**: 캐럿을 표 인근 줄에 둔 상태(또는 표가 유일)에서 `table.addRowBelow`/`addColRight`/`deleteRow`/`deleteCol` → 대상 표의 행/열 수가 기대대로 변한다(최소 1행/1열 유지). `addRowAbove`/`addColLeft`는 index 0에 추가.
- **삭제**: `table.delete` → 대상 표 임베드가 blocks에서 사라지고 텍스트 블록은 유지.
- **복사/잘라내기**: `navigator.clipboard.writeText`를 mock(`vi.fn()`)해 `table.copy` → TSV로 호출됨(`expect(writeText).toHaveBeenCalledWith(expect.stringContaining('\t'))`). `table.cut` → writeText 호출 + 블록 제거.
- **대상 없음**: 표가 없는 본문에서 `table.delete`/`addRowBelow` 등 → `window.alert`(mock) 호출되고 본문 불변.
- **매핑 parity**: 매핑 모드 진입(mapping) 상태에서 `table.insert`/`table.delete` 등이 동작하고(임베드 변경 허용), **본문 텍스트 블록은 불변**.
- **XSS end-to-end**: 삽입 다이얼로그 셀에 `<script>alert(1)</script>` 입력 후 삽입 → 본문 표 렌더에 `document.querySelector('script')` null, 문자 그대로 표시(step1 렌더가 이스케이프).
- **클립보드 미지원 graceful**: `navigator.clipboard` 없음일 때 `table.copy` → alert만, 예외 없음.

## 검증 절차

1. 위 AC 커맨드 실행(한글 깨지면 UTF-8 로케일 확인). 백엔드 `npm run test`도 돌려 server/ 무변경 회귀 확인.
2. 아키텍처 체크리스트:
   - `WriterPage.jsx`만 변경(`git diff --name-only`에 `Editor.jsx`/`InlineEmbed.jsx`/`server/`/DB/스키마 없음).
   - 모든 `table.*`가 `if (isMapping) return;` **앞**에 라우팅(매핑 parity — `grep`으로 위치 확인).
   - 블록 변경이 `blocks.slice()` + `serialize` 안전 경로만(`contentEditable` 직접 텍스트 조작 없음). rows는 `makeTableEmbed` 경유로만 블록에 심음.
   - 더블클릭 위임이 `data-embed-key`(블록 인덱스) 읽기 + `isTableEmbed` 방어를 거침.
   - 클립보드 접근이 `navigator.clipboard` 가드(미지원/거부 alert) 포함.
   - XSS end-to-end green(삽입→렌더 스크립트 미실행).
3. 결과에 따라 `phases/31-editor-table/index.json`의 step 3을 갱신(completed+summary / error / blocked).

## 금지사항

- 표 연산에서 텍스트 블록을 추가/삭제/수정하지 마라(임베드 블록만 조작). 이유: 본문-only 불변식·매핑 정합·news.md "(끝)" 규칙.
- `blocks[idx].rows`를 직접 mutate하거나 raw 2차원 배열을 블록에 심지 마라(반드시 `makeTableEmbed` 경유). 이유: step0 정규화(직사각형/문자열) 단일 출처 우회 시 렌더/XSS 방어가 어긋난다.
- `table.*` 라우팅을 `if (isMapping) return;` 뒤에 두지 마라. 이유: 표는 임베드 — 매핑에서도 허용(phase 18/19 정책). 뒤에 두면 매핑에서 죽은 메뉴가 된다.
- `contentEditable` DOM의 텍스트를 코드로 직접 바꾸지 마라(더블클릭 위임의 `closest`/`dataset` 읽기만 허용). 이유: Editor 캐럿 초기화·removeChild 크래시(Editor.jsx 주석의 타이핑 안정성 규칙).
- `Editor.jsx`에 prop을 추가하거나 `InlineEmbed.jsx`를 수정하지 마라. 이유: 표 렌더는 step1에서 완료 — 입력 경로 변경은 회귀 위험, 편집 진입은 canvas DOM 위임으로 해결.
- 시스템 클립보드 접근에서 `navigator.clipboard` 가드를 빼거나 예외를 방치하지 마라. 이유: jsdom/구브라우저 크래시·무피드백 방지(pasteOriginalAtCaret 선례).
- '표 붙여넣기'용 내부 버퍼/신규 붙여넣기 경로를 만들지 마라(메뉴 항목 없음). 이유: Scope 밖 — 복사/잘라내기는 시스템 클립보드까지만.
- `server/`·DB·스키마·`editorContent.js`를 수정하지 마라. 이유: 표는 기존 임베드 저장 경로(markupVersion)로 스키마 변경 없이 저장 — DB 비파괴·하위호환.
