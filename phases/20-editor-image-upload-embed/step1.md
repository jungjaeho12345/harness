# Step 1: paste-upload-embed — 붙여넣기 base64 제거 + 업로드→경로 임베드 (Editor + WriterPage)

## 배경 / 요구사항

Phase 20의 핵심 step. 붙여넣기 이미지가 **새 base64 data URL을 생성하는 유일 지점**(`Editor.jsx` `handlePaste`의 `FileReader.readAsDataURL`)을 제거하고, 감지한 raw `File`을 상위(`WriterPage`)로 위임한다. `WriterPage`는 **step0에서 보강한 `model.uploadFile(file)`** 로 서버에 업로드하고, 성공 시 반환된 `path`(`/uploads/<hex>.<ext>`)로 `makeImageEmbed(path)`를 만들어 `insertEmbedAtLine`으로 본문 캐럿 줄에 삽입한다.

**왜 Editor와 WriterPage를 한 step에서 함께 바꾸나(중요):** `WriterPage.test.jsx`는 실제 `Editor`를 렌더해 Ctrl+V→이미지 임베드 삽입을 검증하는 **통합 테스트**다. `Editor`의 붙여넣기 계약(`onPasteEmbed`→`onPasteImageFile`)만 바꾸고 `WriterPage` 결선을 다음 step으로 미루면, 중간 상태에서 붙여넣기가 no-op이 되어 `WriterPage` 통합 테스트가 타임아웃으로 red가 된다. `Editor` 붙여넣기 계약과 그 유일 소비자(`WriterPage`)는 **같은 커밋에서** 바꿔야 `npm run test:web` 전체가 green으로 유지된다.

**확정 정책(설계 논의 결과 — 반드시 반영):**
- 업로드 실패/5MB 초과 → `window.alert` 안내 + **삽입 취소**(base64 폴백 없음).
- 5MB 검사는 **서버 판정**(클라 사전 `file.size` 검사 없음, 왕복 1회).
- 로딩 placeholder 없음 — **업로드 완료 후 한 번에 삽입**(await-then-insert).

## 읽어야 할 파일

먼저 아래 파일을 읽고 붙여넣기 흐름·계약을 정확히 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(ADR-003: View는 transport 직접 호출 금지 — 업로드는 model 경유), `/docs/ADR.md`.
- **Step 0 산출물**: `web/src/model/httpModel.js` — `uploadFile(file)`(빈 name → MIME 확장자 합성 포함), 응답 `{ ok, path, filename }`. `request`는 `res.json()`만 반환(HTTP status 미검사) → 성공 판정은 `r && r.ok && r.path`.
- `web/src/view/Editor.jsx` — **수정 대상**:
  - `Editor` props 구조분해(232~243), `onPasteEmbed`(237) → `onPasteImageFile`로 교체.
  - `handlePaste`(357~386): 이미지 분기(364~377)에서 `new FileReader()`(369)·`reader.onload`(370~373)·`reader.readAsDataURL(file)`(374)로 **base64를 생성**한다 → **제거 대상**. `readCaret(e.currentTarget)`(368, 동기 캐럿 스냅샷)은 유지. `caretBlocked`('(끝)' 뒤 차단, 358)·여러 줄 텍스트 `emitInsert`(378~385)는 불변.
  - `contentEditable` div의 `onPaste={handlePaste}` 결선.
  - `embedFromPaste` import — 더 이상 쓰지 않으면 제거(미사용 import lint 에러 방지).
- `web/src/view/Editor.test.jsx` — 이미지 붙여넣기 describe 블록(약 364~470, `'(끝)'` 뒤 차단 케이스 포함) — 새 계약으로 교체.
- `web/src/view/WriterPage.jsx` — **수정 대상**:
  - `const { identity, model } = useAppContext();`(78) — 메인 스코프에서 `model.uploadFile` 접근 가능.
  - `insertEmbedAtLine(embed, caretLine)`(437~446): `!embed`면 no-op, `isMapping || caretLine==null`이면 `appendEmbedToBody`('(끝)' 앞), 아니면 `insertEmbedAfterLine`로 캐럿 줄 뒤 삽입.
  - `pasteEmbedAtCaret(embed, caret)`(452) → `pasteImageAtCaret(file, caret)`로 교체.
  - `<Editor onPasteEmbed={pasteEmbedAtCaret}>`(569) → `onPasteImageFile={pasteImageAtCaret}`로 교체.
  - `CommonInfo.onFileChange`(710~715): `const r = await model.uploadFile(file); if (r && r.ok && r.path) ...` — **성공 판정 패턴 참고**(동일 seam).
- `web/src/view/WriterPage.test.jsx` — 붙여넣기 통합 테스트(실제 `Editor` 렌더, Ctrl+V → `[data-embed-type=image]`).
- `web/src/view/clipboardEmbed.js` — `makeImageEmbed(src, { alt })`(76~85, 이미 `WriterPage`에 import됨), `isAllowedImageSrc`(46~53, scheme 없는 상대경로 `/uploads` 허용 — **이 step에서 변경 안 함**).

## 작업

TDD. `Editor.test.jsx`·`WriterPage.test.jsx`의 붙여넣기 관련 테스트를 새 계약으로 **함께** 갱신하면서 프로덕션 코드를 바꾼다.

### (1) `Editor.jsx` — base64 생성 제거, raw File 위임

- props: `onPasteEmbed`를 제거하고 `onPasteImageFile` 추가. 새 시그니처:
  ```js
  onPasteImageFile?: (file: File, caret: { lineIndex: number, offset: number } | null) => void
  ```
- `handlePaste` 이미지 분기를 다음으로 바꾼다(핸들러는 계속 **동기**):
  - `caretBlocked` 가드 유지.
  - 이미지 감지 조건: `items && onPasteImageFile && Array.from(items).find((it) => it && typeof it.type === 'string' && it.type.startsWith('image/'))`. (핸들러가 없으면 이미지 붙여넣기 비활성 — 절대 base64를 만들지 않는다.)
  - `const file = imageItem.getAsFile()` → `e.preventDefault()` → `const caret = readCaret(e.currentTarget)`(동기 스냅샷) → `onPasteImageFile(file, caret)`.
- `new FileReader` / `reader.readAsDataURL` / `reader.onload`에서 `embedFromPaste` 호출을 **전부 제거**한다. 미사용이 되는 `embedFromPaste` import도 제거한다.
- 여러 줄 텍스트 붙여넣기(`emitInsert`)·`'(끝)'` 뒤 차단·`composition` 경로는 건드리지 않는다.

### (2) `WriterPage.jsx` — 업로드 오케스트레이션

- `pasteEmbedAtCaret`(452)을 async `pasteImageAtCaret(file, caret)`로 교체:
  ```js
  const pasteImageAtCaret = async (file, caret) => {
    const r = await model.uploadFile(file);
    if (r && r.ok && r.path) {
      insertEmbedAtLine(makeImageEmbed(r.path, { alt: '' }), caret ? caret.lineIndex : null);
    } else {
      const msg = r && r.reason === 'too-large'
        ? '이미지가 너무 커 첨부할 수 없습니다(5MB 초과).'
        : '이미지 업로드에 실패했습니다.';
      window.alert(msg);
    }
  };
  ```
- 성공 판정은 `r && r.ok && r.path`만 사용(`request`는 HTTP status를 안 보고 `res.json()`만 반환 — `onFileChange`와 동일 계약).
- `<Editor>` 결선을 `onPasteImageFile={pasteImageAtCaret}`로 교체. `makeImageEmbed`는 이미 import되어 있다(재사용).
- 캐럿: `Editor`가 넘긴 동기 스냅샷 `caret.lineIndex`를 그대로 `insertEmbedAtLine(embed, caretLine)`에 넘긴다(기존 계약 재사용). `isMapping`이거나 `caret` null이면 `insertEmbedAtLine` 내부에서 기존대로 `'(끝)'` 앞 append로 폴백한다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **새 base64 생성 제거(근본 목적)**: `Editor`에서 data:base64를 만드는 코드(`new FileReader`·`reader.readAsDataURL`·`onload`의 `embedFromPaste`)를 전부 제거한다. 실패 대비로도 base64를 만들지 마라. 이유: 이 phase는 신규 base64 생성 벡터를 완전히 없앤다.
2. **View는 transport 직접 호출 금지(ADR-003)**: `Editor` 안에서 `fetch`/`model` 호출 금지 — 업로드 오케스트레이션은 `WriterPage`가 `model.uploadFile`로 수행한다. 이유: 계층 분리.
3. **실패 = 삽입 취소 + alert(폴백 없음)**: 업로드 실패/`too-large`면 `window.alert` 안내 후 삽입하지 않는다. base64 인라인 폴백을 만들지 마라. 이유: 확정 정책.
4. **캐럿 계약 재사용**: 동기 `readCaret` 스냅샷 → `caret.lineIndex` → `insertEmbedAtLine`. `insertEmbedAtLine`/`insertEmbed`/`lastCaretRef` 계약을 바꾸지 마라. 이유: 검색패널·URL삽입 등 다른 삽입 경로가 같은 계약을 공유해 회귀가 번진다.
5. **본문 sink 분리**: 반환 `path`는 body(`markupVersion`) 임베드의 `src`로만 넣는다. `tab.fields.attachmentFile`/`referenceFile`(첨부/자료 메타 필드)에 넣지 마라. 이유: 본문 인라인 이미지와 첨부/자료 파일은 다른 sink다.
6. **매핑 parity**: `isMapping`이면 기존대로 `'(끝)'` 앞 append 폴백만 허용한다(검색패널·기존 붙여넣기와 동일). 매핑 본문-only 불변식을 바꾸지 마라.
7. **테스트 동반 갱신**: `Editor.test.jsx`와 `WriterPage.test.jsx`의 붙여넣기 관련 테스트를 같은 커밋에서 새 계약으로 갱신해 `npm run test:web` 전체가 green이 되게 한다.

## Acceptance Criteria

```bash
npm run test:web   # web 전체 테스트 통과(Editor·WriterPage 통합 포함)
npm run build      # vite 빌드 에러 없음
npm run lint       # ESLint 통과(미사용 import 없음)
```

추가 단언:

**`Editor.test.jsx`**:
- 이미지 item 붙여넣기 → `e.preventDefault` + `onPasteImageFile(file, caret)`가 `File`과 `caret{lineIndex}`로 호출됨.
- `onPasteImageFile` 경로에서 `Editor` 내부가 `FileReader`/base64를 만들지 않음(FileReader 스텁 없이 통과).
- 여러 줄 텍스트 붙여넣기·`'(끝)'` 뒤 차단 동작은 불변.

**`WriterPage.test.jsx`**(`model.uploadFile` mock):
- 성공(mock `{ ok:true, path:'/uploads/abc.png' }`): 붙여넣기 후 body에 `embedType:'image'`, `src:'/uploads/abc.png'` 임베드가 캐럿 줄 뒤에 삽입되고, 본문 텍스트는 불변, body에 `data:base64`가 없음.
- 실패(mock `{ ok:false, reason:'too-large' }`): 임베드 미삽입 + `window.alert` 호출 + body에 base64 없음.
- 매핑 모드(`isMapping`): `'(끝)'` 앞 append로 삽입(parity).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `Editor`는 `model`/`fetch` 미호출(위임만) — `grep`으로 `Editor.jsx`에 `readAsDataURL`/`embedFromPaste` 잔존 없음 확인.
   - 업로드는 `WriterPage`가 `model.uploadFile`로 수행.
   - `server/`·DB·`clipboardEmbed.js`(`isAllowedImageSrc`) 미변경.
   - CLAUDE.md 규칙(DB 비파괴·TDD) 준수.
3. 결과에 따라 `phases/20-editor-image-upload-embed/index.json`의 step 1을 갱신한다(completed+summary / error / blocked).

## 금지사항

- `Editor` 안에서 `fetch`/`model.uploadFile`을 호출하지 마라. 이유: ADR-003 — 뷰는 transport를 직접 호출하지 않는다.
- 업로드 실패 시 base64로 폴백하거나, 실패 대비로 base64를 만들어 두지 마라. 이유: 신규 base64 차단이 이 phase의 목적이다.
- 클라에서 `file.size`로 5MB를 사전 판단하지 마라(이번 범위). 이유: 확정 정책은 서버 판정 — 신뢰경계=서버, 왕복 1회.
- `insertEmbedAtLine`/`insertEmbed`/`lastCaretRef`의 캐럿 스냅샷 계약을 바꾸지 마라. 이유: 검색패널·URL 삽입 등 다른 삽입 경로가 같은 계약을 공유해 회귀가 번진다.
- 텍스트 붙여넣기(`emitInsert`)·`'(끝)'` 차단·`composition` 로직을 건드리지 마라. 이유: 개행 보존/끝표시 차단/한글 입력 회귀.
- 반환 `path`를 `attachmentFile`/`referenceFile`에 저장하지 마라. 이유: 본문 임베드 `src`와 다른 sink다.
- `isAllowedImageSrc`/`clipboardEmbed.js` 검증 규칙을 바꾸지 마라. 이유: step2의 회귀 잠금 대상 — 여기서 조이면 레거시/신규 렌더가 깨진다.
- 기존 테스트를 깨뜨리지 마라.
