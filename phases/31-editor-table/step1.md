# Step 1: table-render — 표 임베드 렌더 분기(에디터 + 상세보기 동형, XSS 텍스트-only)

## 배경 / 요구사항

step0에서 `embedType:'table'` 임베드(`rows: string[][]`)와 순수 헬퍼(`tableModel.js`)를 만들었다. 이 step은 그 임베드를 **읽기 전용 `<table>`로 렌더**하는 두 경로를 **동시에** 확장한다:

1. **에디터 본문 렌더** — `web/src/view/InlineEmbed.jsx`(`image`/`video`/`article`/`audio`/`localVideo`/`link` 분기 뒤에 `table` 추가).
2. **상세보기/발행 새 창 렌더** — `web/src/view/articleDetail.js`의 `embedHtml(b)`(동형 분기 추가) + `DETAIL_STYLE`에 표 스타일.

**두 경로를 반드시 함께 확장한다.** phase 19(`19-editor-embed-types`)에서 확립한 규칙: 한쪽만 고치면 에디터에서 보이던 임베드가 발행(상세보기) 시 깨진다.

### ⚠️ 최우선 규칙 — XSS(phase 19 반려 사례 재발 금지)

셀 내용(`rows[i][j]`)은 **사용자 입력**이며 발행 기사에 렌더된다 = **신뢰 경계**. 반드시 **텍스트로만** 렌더한다:
- **에디터(InlineEmbed, React)**: 셀은 JSX 표현식 `{cell}`로 렌더한다(React가 자동 이스케이프). **`dangerouslySetInnerHTML` 절대 금지.**
- **상세보기(articleDetail, 문자열 HTML)**: 셀은 **반드시 `escapeHtml(cell)`**로 감싼다(L31~38 기존 함수). 원본 문자열을 HTML에 그대로 넣지 마라.

phase 19 step0에서 확립한 사례: 비허용/원본 값을 DOM/HTML에 그대로 노출하면 저장형 XSS가 발행 기사에서 실행된다. 표는 `src`/`href` 같은 URL은 없지만 **셀 텍스트 자체가 주입 벡터**(`<script>`, `<img onerror>` 등)이므로 이스케이프가 유일한 방어다. 이 step의 리뷰는 XSS 단언 green을 필수 게이트로 본다.

이 step에는 **다이얼로그·WriterPage 결선·셀 편집 로직이 없다**. 임베드 객체(`{embedType:'table', rows:[...]}`)를 직접 만들어 `InlineEmbed`/`embedHtml`에 넣는 자기완결 TDD가 가능하다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(보안 경계), `/docs/ADR.md`.
- `/docs/news.md` — L108(상세보기: 모든 내용 HTML 이스케이프, 스크립트 미실행), L181(표 메뉴), L156~172(임베드 렌더).
- `phases/19-editor-embed-types/step0.md` — **XSS 반려 사례·양쪽 렌더 일관성 규칙의 원전**(특히 '핵심 규칙' 3·7, '금지사항'). 표에도 동일 적용.
- `web/src/view/tableModel.js`(step0 산출) — `isTableEmbed(block)`, `normalizeTableRows(rows)`(렌더 직전 방어적 정규화 — ragged/비문자열 셀 방지). `TABLE_EMBED_TYPE`.
- `web/src/view/InlineEmbed.jsx` — **에디터 렌더 확장 대상**. 현재 `image`(L21)·`video`(L34)·`article`(L48)·`audio`(L54)·`localVideo`(L59)·`link`(L64) 분기와 `body` 변수 패턴, `figureWidth` 계산(L78~82), `figure` 래퍼(L84~103, `data-embed-type={type}`·`data-embed-key={blockIndex}`·× 삭제 버튼 `aria-label="임베드 삭제"`). **`clipboardEmbed`에서 검증 유틸을 import해 재노출하는 패턴(L5~11)** — table은 URL 검증이 없으니 `tableModel`에서 `isTableEmbed`/`normalizeTableRows`만 import.
- `web/src/view/InlineEmbed.test.jsx` — **직접 템플릿**. `render(<InlineEmbed embed={...} onRemove={...} />)` 후 `screen`/`document.querySelector`로 단언, readOnly 시 × 숨김(L30~35), 보안 단언 패턴(L38~67). 표 테스트를 이 컨벤션으로 추가.
- `web/src/view/articleDetail.js` — **상세 렌더 확장 대상**. `embedHtml(b)`(L129~165)의 `image`/`video`/`article`/`audio`/`localVideo`/`link` 분기와 **폴백 자리표시자**(L164: 알 수 없는 kind → `[type]`, 원본 미노출), `escapeHtml`(L31~38), `DETAIL_STYLE`(L71~123, `.yh-detail__embed`·`.yh-detail__embed--media`). `renderDetailHtml`(L169)이 블록을 순회하며 임베드는 `embedHtml`, 텍스트는 `escapeHtml`.
- `web/src/view/articleDetail.test.js` — 상세 렌더 보안 단언 컨벤션(`renderDetailHtml(article)` 문자열에 원본 미포함/포함 단언).
- `web/src/styles/yonhap.css` — `.yh-embed` 스타일 위치(에디터 표 스타일 추가 지점).

## 작업

TDD로 진행한다(vitest). **에디터 렌더 → 상세 렌더** 순으로 각 단위마다 테스트를 먼저 쓴다. 두 경로에 XSS 단언을 반드시 포함한다.

### (1) 에디터 렌더 분기 (InlineEmbed.jsx)

`tableModel`에서 `isTableEmbed`/`normalizeTableRows`를 import하고, 기존 분기 뒤에 `type === 'table'` 분기를 추가한다:

- `normalizeTableRows(embed.rows)`로 방어적 정규화한 뒤 `<table className="yh-embed__table"><tbody>`에 행/셀을 렌더한다. 각 셀은 `<td>{cell}</td>`(JSX 자동 이스케이프). 헤더 행 구분은 선택(첫 행을 `<th>`로 강조해도 되나 필수 아님 — 하되 여전히 `{cell}` 텍스트).
- 빈 rows(정규화 결과 `[]`)면 `body = null`(빈 figure — 크래시 금지, 기존 image/audio 거부 패턴과 동형).
- `figureWidth`(L78~82)에 table 분기 반영: `fit-content`(내용 폭) 권장. **이미지(`fit-content`)·영상(`figureWidthPx`)·기사(`widthPx`) 기존 정책을 깨지 마라** — table만 가산.
- `data-embed-type`은 `'table'` 그대로(기존 패턴). × 삭제 버튼(readOnly 시 숨김)은 기존 figure 공통 코드가 처리하므로 별도 작업 없음.

### (2) 상세/발행 렌더 분기 (articleDetail.js)

`embedHtml(b)`에 `image`/`video`/... 뒤, **폴백 자리표시자(L164) 앞**에 `table` 분기를 추가한다:

- `normalizeTableRows(b.rows)`(tableModel에서 import) 후 `<figure class="yh-detail__embed yh-detail__embed--table" data-embed-type="table"><table>...<td>${escapeHtml(cell)}</td>...</table></figure>` 문자열을 만든다. **모든 셀은 `escapeHtml`**. 빈 rows면 폴백 자리표시자(`[table]`)로 떨어뜨린다(빈 표 미노출).
- **표 badge 유지(결정)**: `.yh-detail__embed::before`(`articleDetail.js` L111~114)가 `data-embed-type`을 대문자 라벨("TABLE")로 표 위에 표시한다. 표 figure는 `yh-detail__embed--media`가 아니므로(`--table`) 이 라벨이 **그대로 뜬다** — 이는 **의도된 표시로 유지한다**(미디어(image/video/audio/localVideo)만 `--media::before{content:none}`로 억제해온 기존 규칙 보존). 이 phase에서 표 badge를 억제하지 마라 — 억제는 별도 UX 결정이 필요하다. `data-embed-type="table"` 그대로 두면 된다(추가 작업 없음).
- `DETAIL_STYLE`(정적 문자열, 사용자 값 없음)에 `.yh-detail__embed--table table`(테두리·셀 패딩·`border-collapse` 등) 스타일을 더한다. 정적 CSS라 XSS 무관 — **셀 값을 CSS에 넣지 마라**.

### (3) 에디터 CSS (yonhap.css)

`.yh-embed__table`(테두리·`border-collapse`·셀 패딩)을 `.yh-embed` 인근에 추가한다. 기존 스타일을 깨지 않는다. 정적 CSS만.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **XSS 텍스트-only(최우선)**: 에디터는 `{cell}`(JSX), 상세는 `escapeHtml(cell)`. `dangerouslySetInnerHTML`·원본 문자열 HTML 삽입 **절대 금지**. 이유: 셀 텍스트가 저장형 XSS 벡터 — phase 19 반려 사례.
2. **양쪽 렌더 동형**: `table` 분기를 `InlineEmbed.jsx`와 `articleDetail.js` **모두**에 추가한다. 한쪽만 고치면 발행 시 깨진다. 이유: 두 경로가 같은 임베드 객체를 렌더(phase 19 규칙).
3. **정규화 단일 출처**: 렌더 직전 `tableModel.normalizeTableRows`로만 정규화한다. `InlineEmbed`/`articleDetail`에 정규화 로직(직사각형화·문자열 강제)을 복붙하지 마라. 이유: 규칙 분기 방지(step0가 단일 출처).
4. **읽기 전용 렌더**: 본문/상세의 표는 **비편집**이다(`contentEditable` 셀·input 금지). 편집은 다이얼로그(step2)가 담당. 이유: 기존 임베드는 전부 본문에서 읽기 전용 — 인라인 편집은 Editor.jsx 대수술·`readEditorBlocks` 불변식 파괴를 부른다(아래 금지사항).
5. **Editor.jsx 미접촉**: 이 step은 `InlineEmbed.jsx`·`articleDetail.js`·`tableModel.js`(import만)·`yonhap.css`만 만진다. `Editor.jsx`를 수정하거나 `<Editor>`에 prop을 추가하지 마라. 이유: 입력/키 경로 변경은 회귀 위험(phase 19 규칙 5와 동일).
6. **기존 분기·폴백 보존**: `image`/`video`/`article`/`audio`/`localVideo`/`link` 렌더와 폴백 자리표시자(L164)를 바꾸지 마라. table 분기만 가산. 이유: 회귀 방지.
7. **하위호환(알 수 없는 kind)**: 구버전 렌더가 table 임베드를 만나면 InlineEmbed는 `body=null`(빈 figure), articleDetail는 `[type]` 폴백으로 **크래시 없이** 떨어져야 한다(기존 폴백이 이미 처리 — 이 동작을 깨지 마라). 이유: 표 포함 신규 기사와 표 미지원 구버전이 서로 죽지 않아야 한다.

## Acceptance Criteria

```bash
npm run test:web -- InlineEmbed       # 에디터 표 렌더 + XSS 단언 통과(vitest 파일 필터)
npm run test:web -- articleDetail     # 상세 표 렌더 + XSS 단언 통과
npm run test:web -- tableModel        # step0 회귀 통과(정규화 재사용)
npm run test:web                      # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest):

**`InlineEmbed.test.jsx`**:
- `embedType:'table'` + `rows:[["a","b"],["c","d"]]` → `document.querySelector('table')` 존재, 셀 텍스트 `a`/`b`/`c`/`d`가 보인다(`screen.getByText`).
- **XSS**: `rows:[["<script>alert(1)</script>"]]` → 렌더 후 `document.querySelector('script')` **null**, 텍스트 `<script>alert(1)</script>`가 **문자 그대로** 보인다(실행/HTML 파싱 안 됨). `rows:[["<img src=x onerror=alert(1)>"]]` → `document.querySelector('img')` **null**.
- `rows:[]`(빈 표) → `<table>` 미렌더(빈 figure). 크래시 없음.
- × 삭제 버튼(`aria-label="임베드 삭제"`)이 readOnly false면 보이고, readOnly면 숨는다(기존 패턴 회귀).
- ragged rows(`[["a"],["b","c"]]`) → 정규화되어 표가 직사각형으로 렌더(각 행 셀 수 동일).

**`articleDetail.test.js`**:
- `table` 허용 rows → `renderDetailHtml(article)` 결과에 `<table` 포함, 셀 텍스트 이스케이프 포함.
- **XSS**: 셀에 `<script>alert(1)</script>` → 결과 HTML에 **원본 `<script>` 태그 미포함**(`&lt;script&gt;`로 이스케이프됨 — `expect(html).not.toContain('<script>')`, `expect(html).toContain('&lt;script&gt;')`).
- 셀에 `"><img onerror=...>` 류 브레이크아웃 시도 → 원본 태그 미포함(이스케이프).
- 빈 rows → 폴백 자리표시자(`[table]`)로 떨어지고 원본 미노출.

## 검증 절차

1. 위 AC 커맨드 실행(한글 깨지면 UTF-8 로케일 확인).
2. 아키텍처 체크리스트:
   - `table` 분기가 `InlineEmbed.jsx`·`articleDetail.js` **양쪽**에 존재(`grep 'table'` 두 파일 확인).
   - `dangerouslySetInnerHTML` 미사용(`grep -r dangerouslySetInnerHTML web/src/view/InlineEmbed.jsx` 없음), 상세는 셀에 `escapeHtml` 적용.
   - 정규화는 `tableModel.normalizeTableRows` import·호출(두 파일에 정규화 로직 복붙 없음).
   - `Editor.jsx`·`server/` 무변경, `<Editor>` 신규 prop 없음.
   - XSS 단언 green(스크립트/이미지 태그 미렌더, 이스케이프 확인).
3. 결과에 따라 `phases/31-editor-table/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- 셀을 `dangerouslySetInnerHTML`로 렌더하거나(에디터), 원본 셀 문자열을 이스케이프 없이 HTML에 넣지 마라(상세). 이유: 저장형 XSS — phase 19 반려 사례, 이 phase 최우선 게이트.
- `table` 분기를 한쪽 렌더 경로에만 추가하지 마라. 이유: 에디터·상세 일관성 — 한쪽만 고치면 발행 시 깨진다.
- 본문/상세의 표 셀을 `contentEditable`/`<input>`으로 만들지 마라(인라인 편집 금지). 이유: 편집은 다이얼로그(step2) 담당 — 인라인 셀 편집은 `Editor.readEditorBlocks`의 "1줄=1 텍스트 블록" 불변식과 `readCaret`을 파괴하고 Editor.jsx 대수술을 요구한다(범위 밖·회귀 위험).
- 정규화 로직(직사각형화/문자열 강제)을 `InlineEmbed`/`articleDetail`에 복붙하지 마라. 이유: step0 `normalizeTableRows`가 단일 출처 — 갈라지면 한쪽만 방어된다.
- `Editor.jsx`를 수정하거나 `<Editor>`에 prop을 추가하지 마라. 이유: 입력/키 경로 회귀 위험(phase 19 규칙 5).
- 기존 임베드 분기(`image`/`video`/`article`/`audio`/`localVideo`/`link`)·폴백 자리표시자·`isAllowedImageSrc` 등을 바꾸지 마라. 이유: 회귀 방지.
- 다이얼로그·`WriterPage` 결선·`make*Embed` 호출·클립보드 접근을 이 step에서 하지 마라. 이유: step2·step3 담당(Scope 최소화).
- `DETAIL_STYLE`/`yonhap.css`에 셀 값(사용자 데이터)을 삽입하지 마라(정적 CSS만). 이유: CSS 주입 표면 차단.
