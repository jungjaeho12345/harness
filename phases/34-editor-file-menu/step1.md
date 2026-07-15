# Step 1: file-print

파일 메뉴의 **인쇄(`file.print`)** 와 **인쇄미리보기(`file.printPreview`)** 를 결선한다. 두 항목 모두 **현재 편집 탭의 본문·공통정보를 상세보기(article) 형태로 새 창에 렌더**한다. 렌더는 이미 검증된 `renderDetailHtml`(이스케이프된 안전 HTML)을 재사용하고, 새 창 열기/쓰기 패턴은 `ListPage.openDetail`을 그대로 따른다. 차이는 단 하나 — **인쇄는 렌더 후 `w.print()`까지, 인쇄미리보기는 창만 연다.**

## 배경 (자기완결)

- `ListPage`는 목록 행 클릭 시 `openDetail(article, loadDetail)`로 **새 창(720×800)을 동기로 먼저 열고**(팝업 차단 회피), 본문을 받은 뒤 `renderDetailHtml(full, loadEditorPrefs().byline)`을 `w.document.write`한다. 목록 행은 본문이 없어 `loadDetail`(async 재조회)이 필요했다.
- **인쇄는 async 재조회가 불필요**하다 — 현재 탭에 본문(`activeTab.fields.body`, 직렬화된 `markupVersion` 문자열)과 공통정보가 이미 메모리에 있다. 따라서 **동기로 창을 열고 즉시 write/close**한다(팝업 차단 회피 + 단순).
- `renderDetailHtml(article, byline)`은 `article.markupVersion ?? article.body ?? article.content`를 `deserialize`해 본문 블록을 렌더하고, 공통정보(`DETAIL_COMMON_FIELDS`)와 창 제목(`article.title`)을 이스케이프해 박는다. **모든 사용자 값이 `escapeHtml`을 거치므로 스크립트가 실행되지 않는다**(발행/상세보기 XSS 이중차단). 이 escape를 우회하면 안 된다.

편집 탭 fields → `renderDetailHtml`이 먹는 article-형태로의 **매핑은 순수 함수로 분리**해 단위 테스트한다(DOM 없이 검증). 새 창 열기/`print()`만 `WriterPage`에 얇게 남긴다.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — view 모듈끼리의 순수 렌더 재사용은 허용, 서버 호출만 controller 경유. 이 step은 서버 호출 없음).
- `docs/news.md` L181(파일 메뉴: 인쇄, 인쇄미리보기).
- `web/src/view/ListPage.jsx` L28-44 — `openDetail(article, loadDetail)`: `window.open('', '_blank', 'width=720,height=800')` → `w.document.open()` → `w.document.write(renderDetailHtml(full, loadEditorPrefs().byline))` → `w.document.close()`. **이 새 창 패턴을 인쇄에 그대로 재사용**(단 async 재조회 제거).
- `web/src/view/articleDetail.js` — `renderDetailHtml(article, byline)` L185, `buildDetail(article, byline)` L56(본문 소스 = `article.markupVersion ?? article.body ?? article.content`, 창 제목 = `article.title`), `DETAIL_COMMON_FIELDS` L17, `escapeHtml` L32.
- `web/src/view/editorContent.js` — `serialize(blocks)` L38(블록→`markupVersion` 문자열), `deserialize` L43.
- `web/src/view/editorPrefs.js` — `loadEditorPrefs().byline`(상세보기 작성자 부가 라인. `ListPage.openDetail`과 동일 call-site prefs 패턴).
- `web/src/view/WriterPage.jsx`:
  - 상단 import(L42 `loadEditorPrefs`, L46 `serialize`/`deserialize` 이미 import됨), L93 `MENU_ENABLED`, `activeTab`(L105 구조분해), `body`/`blocks`(L215-216), L535-691 `onMenuSelect`, L598 `isMapping` 가드.
- `web/src/view/WriterPage.test.jsx` — 상단 메뉴 열기/항목 클릭 헬퍼.
- **이전 step 산출물**: step0이 `MENU_ENABLED`/`onMenuSelect`에 `file.new`/`file.close`를 이미 추가했을 수 있다 — 기존 항목을 제거하지 말고 네 id만 추가하라.

## 작업 (TDD — 실패하는 테스트부터)

### 1) 신규 순수 모듈 `web/src/view/printDocument.js`

인쇄용 순수 헬퍼. **model/fetch/window/document 호출 없음** — 탭을 article-형태로 매핑하고 HTML 문자열만 만든다.

- `export function buildPrintArticle(tab)` — 현재 편집 탭을 `renderDetailHtml`이 먹는 article-형태 객체로 매핑한다:
  - `{ ...tab.fields, ...tab.readOnly, markupVersion: <직렬화된 현재 본문> }` 형태.
  - **`markupVersion`은 현재 화면 본문을 반영해야 한다.** `tab.fields.body`는 이미 직렬화된 `markupVersion` 문자열이므로 그대로 쓰거나(`markupVersion: tab.fields.body`), 안전하게 `serialize(deserialize(tab.fields.body))`로 정규화해도 된다(구현 재량). 공통정보(author/coAuthor/category/region/attribute/keyword/코멘트/첨부·자료파일/엠바고)와 제목(`title`)은 `tab.fields`에 있으므로 자연 포함된다.
  - `tab`이 `undefined`/필드 결손이어도 죽지 않게 방어(빈 값 → 상세보기가 '—'로 렌더).
- `export function renderPrintHtml(tab, byline)` — `renderDetailHtml(buildPrintArticle(tab), byline)`을 반환한다. **반드시 `renderDetailHtml` 경유**(이스케이프 보존). 절대 필드값을 직접 문자열 연결해 HTML을 만들지 마라.

> 핵심(못박음): 이 모듈은 순수 문자열 변환만 한다. 새 창/`print()`/`document.write`는 여기 두지 않는다(테스트 가능성·순수성).

### 2) `web/src/view/WriterPage.jsx` — 새 창 렌더 + `print()`(얇은 배선)

1. `import { renderPrintHtml } from './printDocument.js';` 추가.
2. 얇은 헬퍼(`ListPage.openDetail`의 동기 버전):

   ```jsx
   const printCurrentTab = (doPrint) => {
     const html = renderPrintHtml(activeTab, loadEditorPrefs().byline);
     const w = window.open('', '_blank', 'width=720,height=800');
     if (!w || !w.document) return;          // 팝업 차단/미지원 — 조용히 종료(죽지 않음)
     w.document.open();
     w.document.write(html);
     w.document.close();
     if (doPrint) { try { w.print(); } catch { /* print 미지원 — 무시 */ } }
   };
   ```

3. `MENU_ENABLED`(L93)에 `'file.print'`, `'file.printPreview'` 추가(기존 id 유지).
4. `onMenuSelect`에서 **`isMapping` 가드 앞**에 분기 추가(읽기전용 렌더 — 본문 무변경이라 매핑에서도 열림, `tools.fileInfo`와 동일 정책):
   - `if (id === 'file.print') { printCurrentTab(true); return; }`
   - `if (id === 'file.printPreview') { printCurrentTab(false); return; }`

### 테스트

**`web/src/view/printDocument.test.js`(순수 — DOM 불필요):**

- `buildPrintArticle`가 `tab.fields`의 공통정보·제목을 그대로 담고, `markupVersion`이 현재 본문(블록)에서 나온 문자열임을 단언.
- `renderPrintHtml`이 제목/본문 텍스트를 포함한 완전한 HTML 문서(`<!doctype html>` … `</html>`) 문자열을 반환함을 단언.
- **XSS 회귀 잠금(핵심)**: `title`/`author`/본문에 `<script>alert(1)</script>` 같은 값을 넣은 탭 → `renderPrintHtml` 결과에 리터럴 `<script>`가 **없고** `&lt;script&gt;`(이스케이프)로 나타남을 단언. 이스케이프 우회가 없음을 잠근다.
- 빈/결손 탭(`buildPrintArticle(undefined)` 또는 빈 fields)에서도 예외 없이 렌더됨을 단언.

**`web/src/view/WriterPage.test.jsx`(새 창 배선):**

- `window.open`을 fake 창(`{ document: { open: spy, write: spy, close: spy }, print: spy }`)을 반환하도록 스텁한다(원복은 `afterEach`).
- 파일 메뉴 → '인쇄' 클릭 → `window.open` 호출 + `document.write`에 인쇄 HTML 전달 + **`w.print()` 호출됨** 단언.
- 파일 메뉴 → '인쇄미리보기' 클릭 → `window.open`/`document.write` 호출되나 **`w.print()`는 호출되지 않음** 단언(이것이 인쇄와의 유일한 차이).
- `window.open`이 `null`을 반환(팝업 차단)해도 예외 없이 no-op임을 단언.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test` 불필요. client 전용.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `web/src/view/Editor.jsx`·`server/`·DB 스키마가 diff에 없는가?
   - `renderDetailHtml`의 escape를 우회하지 않았는가?(HTML은 오직 `renderPrintHtml`→`renderDetailHtml`로만 생성)
   - `articleDetail.js`/`ListPage.jsx`를 수정하지 않고 **재사용**만 했는가?
   - `MENU_ENABLED`에서 기존 id(step0 포함)가 제거되지 않았는가?
   - CLAUDE.md 준수(UTF-8·DB 비파괴·ADR-003 — 서버 호출 미추가).
3. 결과에 따라 `phases/34-editor-file-menu/index.json`의 step1을 업데이트한다:
   - 성공 → `"status": "completed"` + `"summary"`(신규 `printDocument.js`·`buildPrintArticle`/`renderPrintHtml`·`print()` 분기·XSS 회귀 테스트).
   - 실패/blocked 처리는 step0과 동일 규약.
4. top-level `phases/index.json`의 34 상태는 execute.py가 관리한다.

## 금지사항

- `renderDetailHtml`의 이스케이프를 우회하거나, 필드값을 직접 문자열 연결해 인쇄 HTML을 만들지 마라. 이유: 편집 탭 본문/공통정보는 사용자 입력이라 raw 삽입 시 새 창(`document.write` 싱크)에서 스크립트가 실행된다(발행기사 XSS와 동일 표면 — phase 19 선례). 반드시 `renderDetailHtml` 경유.
- 새 창 열기/`print()`/`document.write`를 `printDocument.js`(순수 모듈)에 넣지 마라. 이유: 순수/불순을 섞으면 매핑 로직을 DOM 없이 단위 테스트할 수 없다 — 창 조작은 `WriterPage`의 얇은 배선에만 둔다.
- 인쇄 렌더에 async 재조회(`getArticle`/`loadDetail`)를 추가하지 마라. 이유: 현재 탭 본문이 이미 메모리에 있고, `window.open` 후 await 사이에 사용자가 탭을 전환하면 다른 기사를 인쇄하는 레이스가 생긴다. 동기로 열고 즉시 write한다.
- `web/src/view/Editor.jsx`·`server/`·DB 스키마를 건드리지 마라.
- `MENU_ENABLED`에서 기존 결선 id(step0 `file.new`/`file.close` 포함)를 제거하지 마라.
- 기존 테스트를 깨뜨리지 마라.
