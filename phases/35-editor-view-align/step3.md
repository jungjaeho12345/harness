# Step 3: detail-render

저장된 정렬을 **상세보기(읽기전용 새 창)에서 렌더**한다. 에디터(step1)와 동형으로 텍스트 줄 `<p>`에 `text-align`을 주입한다. 이 step은 **`web/src/view/articleDetail.js` 한 모듈만** 변경한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003).
- `docs/news.md` L108~112(상세보기 — 본문을 저장된 블록 순서대로, 모든 내용 HTML 이스케이프해 스크립트 비실행), L183(보기 정렬).
- `web/src/view/editorContent.js` — **step0에서 추가된** `ALIGN_VALUES`·`isValidAlign`·align 보존 `deserialize`. (step0 요약이 프롬프트에 함께 전달된다.)
- `web/src/view/articleDetail.js` — **이 step에서 변경할 대상.** 특히:
  - import — `deserialize`·`isEmbedBlock` from `./editorContent.js`, `escapeHtml`(L32) 등.
  - `buildDetail`(L56~67) — `deserialize(article.markupVersion ?? ...)`로 blocks 산출.
  - `embedHtml(b)`(L129~181) — 임베드 블록 → 상세 HTML(셀/속성 escapeHtml).
  - `renderDetailHtml`의 본문 map(L199~206): `blocks.map((b) => { if (isEmbedBlock(b)) return embedHtml(b); return \`<p class="yh-detail__line">${escapeHtml(b.text)}</p>\`; })`.
  - `DETAIL_STYLE`(L80~127 근처) — `.yh-detail__line`(L102, `:first-child`=제목 L103~) 스타일.
- `web/src/view/articleDetail.test.js` — 기존 렌더/이스케이프 테스트 패턴(정렬 테스트를 여기에 추가).

## 배경 (자기완결)

상세보기는 `renderDetailHtml`이 서버 렌더 문자열이 아닌 클라이언트에서 만든 HTML을 새 창에 쓴다. 본문 텍스트 블록은 `<p class="yh-detail__line">…</p>`로 렌더되며 텍스트는 반드시 `escapeHtml`로 이스케이프된다(XSS 비실행 — news.md L112). 정렬값은 블록 모델의 통제된 enum(`ALIGN_VALUES` 4종)이므로, `<p>`에 `style="text-align:<값>"`를 붙이되 **화이트리스트를 통과한 4개 리터럴만** 방출한다(임의 문자열이 style에 들어가지 않게 — 방어).

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 1) 정렬 스타일 헬퍼

`ALIGN_VALUES`(또는 `isValidAlign`)를 `./editorContent.js`에서 import해 화이트리스트 스타일 조각을 만든다:

```js
// 통제된 enum(ALIGN_VALUES)만 style로 방출한다 — 임의 문자열 주입 차단(방어). 미정렬/무효 → 빈 문자열(좌측 기본).
function alignStyleAttr(align) {
  return isValidAlign(align) ? ` style="text-align:${align}"` : '';
}
```

### 2) 본문 map(L201~204)에 주입

```js
return `<p class="yh-detail__line"${alignStyleAttr(b.align)}>${escapeHtml(b.text)}</p>`;
```

`escapeHtml(b.text)`는 **그대로 유지**한다(텍스트는 항상 이스케이프). `align`은 enum이라 이스케이프 대상이 아니라 화이트리스트로 통제한다.

**못박음**: 임베드 분기(`embedHtml`)·`:first-child` 제목 스타일·`DETAIL_STYLE`은 건드리지 마라. 제목 줄도 텍스트 블록이므로 정렬을 지정했다면 `text-align`이 붙지만, 그것은 사용자가 첫 줄에 정렬을 건 결과라 정상이다(별도 예외 처리 없음).

### 테스트 — `web/src/view/articleDetail.test.js`

- `align:'center'` 텍스트 블록이 포함된 `markupVersion`으로 `renderDetailHtml` → 해당 `<p class="yh-detail__line" style="text-align:center">`가 방출.
- 미정렬 블록 → `<p class="yh-detail__line">`(style 없음) — 하위호환.
- 무효 align('bad', 방어) → style 없음.
- 4종 각각(left/center/right/justify) style 문자열 정확.
- 텍스트 이스케이프 회귀: `align`이 있어도 `<`,`&` 등이 여전히 이스케이프됨.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
npm run test
```

(상세보기는 클라이언트 렌더지만, 백엔드 무변경 회귀 확인을 위해 `npm test`도 실행한다 — `markupVersion`은 서버가 verbatim 저장하므로 정렬은 서버 로직 변경 없이 라운드트립해야 한다.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 변경이 `web/src/view/articleDetail.js`(+테스트)에 국한되는가? 서버(`src/`)·스키마·DB가 diff에 없는가?(백엔드 무변경 — verbatim 저장 전제)
   - 텍스트가 여전히 `escapeHtml`로만 들어가는가?(XSS 비실행 — news.md L112) style에 화이트리스트 외 값이 방출되지 않는가?
   - 기존 상세보기 렌더/이스케이프/임베드 테스트가 그린인가?
   - ADR-003·CLAUDE.md(DB 비파괴·client 전용·UTF-8)?
3. 결과에 따라 `phases/35-editor-view-align/index.json`의 step3을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (alignStyleAttr 화이트리스트·`<p>` text-align 주입·escapeHtml 유지·하위호환·추가 테스트·백엔드 무변경 확인)를 한 줄 요약. **이 step이 phase 마지막이므로 phase 전체 산출물(모델→에디터→결선→상세)을 요약에 담아라.**
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 35 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- 정렬값을 화이트리스트 없이 style에 문자열 보간하지 마라. 이유: 블록 모델이 오염된 경우(방어적으로) 임의 CSS가 상세보기 HTML에 주입될 수 있다 — 반드시 `isValidAlign`/`ALIGN_VALUES`로 4개 리터럴만 방출한다.
- `escapeHtml(b.text)`를 제거·완화하지 마라. 이유: 본문 텍스트는 사용자 입력이라 XSS 비실행 규칙(news.md L112)상 항상 이스케이프해야 한다.
- 서버(`src/`)·스키마·DB를 건드리지 마라. 이유: `markupVersion`은 verbatim 저장되므로 정렬은 클라이언트 보존만으로 라운드트립한다 — 백엔드 변경은 불필요하고 DB 비파괴 규칙 위반 위험만 만든다.
- `DETAIL_STYLE`/`:first-child` 제목 규칙/`embedHtml`을 바꾸지 마라. 이유: 이 phase 범위는 텍스트 줄 정렬 주입뿐이며, 다른 렌더를 건드리면 회귀 표면이 커진다.
- 기존 테스트를 깨뜨리지 마라.
