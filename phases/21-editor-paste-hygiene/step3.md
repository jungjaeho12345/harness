# Step 3: paste-upload-error-feedback — 붙여넣기 업로드 네트워크 실패 사용자 피드백 (WriterPage)

## 배경 / 요구사항

Phase 20에서 붙여넣기 이미지는 `WriterPage.jsx`의 `pasteImageAtCaret(file, caret)`가 `model.uploadFile(file)`로 업로드한 뒤 반환 `path`로 임베드를 삽입한다. 현재 코드는 응답 실패(`!(r && r.ok && r.path)`, 예: `too-large`)에 대해서는 `window.alert`로 안내한다. 그러나 **`model.uploadFile`이 reject(네트워크 오류·FileReader 오류 등 throw/rejected Promise)** 하는 경우는 `try/catch`로 감싸지 않아 처리되지 않는다.

호출부인 `Editor.jsx`의 `onPasteImageFile(file, caret)`(약 369행)는 반환 Promise를 `await`하거나 `catch`하지 않으므로, `pasteImageAtCaret`가 reject하면 **조용한 실패(무피드백 + unhandled rejection)** 가 된다. phase 20 코드리뷰가 비차단 nit로 지적한 항목이다.

이 step은 `pasteImageAtCaret`의 업로드를 `try/catch`로 감싸, **reject/throw 시에도** 기존 실패 정책과 동일하게 사용자에게 알리고 임베드를 삽입하지 않는다.

**동반 sub-finding 재검증 — `current.fields.body` undefined 방어는 무효(불필요).** phase 20 코드리뷰가 "신규 빈 탭에서 `insertEmbedAtLine(…, current.fields.body, …)`의 `body`가 undefined일 수 있으니 방어하라"고 나열했다. 그러나 컨트롤러(`useWriteController.js`)를 재검증한 결과 `blankFields`가 `EDITABLE_FIELDS`(‘body’ 포함)를 모두 `''`로 시드하고, `fieldsFromArticle`/`tabFromSource`도 `body`를 `... ?? ''`로 항상 문자열로 채운다. 즉 **`fields.body`는 어떤 탭 생성 경로에서도 undefined가 될 수 없다**(빈 탭은 `''`). 게다가 `writerBody.js`의 `deserialize`/`insertEmbedAfterLine`/`appendEmbedToBody`는 빈 문자열을 정상 처리한다. **따라서 undefined 방어 코드를 추가하지 않는다**(불필요한 방어는 실제 계약을 흐린다). 이 step에서는 코드 변경 없이 재검증 결과만 기록한다.

이 step은 **`WriterPage.jsx` 한 파일(+그 테스트)만** 다룬다. 커밋 타입: **fix:**.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(계층 분리·ADR-003), `/docs/ADR.md`.
- `web/src/view/WriterPage.jsx` — **수정 대상**. `pasteImageAtCaret`(약 458~483):
  ```js
  const pasteImageAtCaret = async (file, caret) => {
    const tabId = activeTab.id;
    const r = await model.uploadFile(file);              // ← reject 시 무처리(try/catch 없음)
    if (!(r && r.ok && r.path)) {
      const msg = r && r.reason === 'too-large'
        ? '이미지가 너무 커 첨부할 수 없습니다(5MB 초과).'
        : '이미지 업로드에 실패했습니다.';
      window.alert(msg);
      return;
    }
    const current = activeTabRef.current;
    if (!current || current.id !== tabId) {
      window.alert('편집 탭이 바뀌어 이미지 삽입이 취소되었습니다.');
      return;
    }
    insertEmbedAtLine(makeImageEmbed(r.path, { alt: '' }), caret ? caret.lineIndex : null, current.fields.body, current.mode === 'mapping');
  };
  ```
  기존 두 분기(`too-large`/비-ok 응답, 탭 전환 취소)의 문구·동작은 **그대로 유지**한다. 추가하는 것은 **reject/throw 경로의 catch뿐**이다.
- `web/src/view/Editor.jsx` — **읽기만**. `handlePaste`의 `onPasteImageFile(file, caret)`(약 369) 호출부. 이 step에서 `Editor.jsx`는 수정하지 않는다.
- `web/src/view/WriterPage.test.jsx` — **수정 대상(테스트)**. 붙여넣기 통합 테스트 블록(약 513~600, `openWith` 헬퍼·`pasteImageEvent`·`model.uploadFile` mock 패턴). 기존 케이스: 성공(`mockResolvedValue({ ok:true, path })`), `too-large`(`mockResolvedValue({ ok:false, reason:'too-large' })`). **rejected 케이스는 아직 없음** → 이 step에서 추가.

## 작업

TDD(vitest). `WriterPage.test.jsx`에 **실패 테스트를 먼저** 추가한 뒤 구현한다.

### (1) 실패 테스트(먼저)

기존 붙여넣기 describe 블록에 rejected 케이스를 추가한다(성공/`too-large` 케이스의 `openWith`/`pasteImageEvent`/`caretAtLine` 패턴 재사용):

```js
it('업로드가 reject(네트워크 오류) → 실패 alert + 임베드 미삽입(본문 불변)', async () => {
  const { container, model } = await openWith([textBlock('제목'), textBlock('본문')]);
  vi.spyOn(model, 'uploadFile').mockRejectedValue(new Error('network'));
  const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
  caretAtLine(container, 0);
  const box = container.querySelector('.yh-editor');
  fireEvent(box, pasteImageEvent(box));

  await waitFor(() => expect(alert).toHaveBeenCalledWith('이미지 업로드에 실패했습니다.'));
  expect(container.querySelector('[data-embed-type="image"]')).toBeFalsy(); // 미삽입
  expect(blockTypes(container)).toEqual(['text', 'text']);                    // 본문 불변
  expect(container.querySelector('.yh-editor img[src^="data:"]')).toBeFalsy(); // base64 폴백 없음
});
```

### (2) 구현

`pasteImageAtCaret`의 업로드+삽입을 `try/catch`로 감싼다. catch에서 `window.alert('이미지 업로드에 실패했습니다.')`를 띄우고 임베드를 삽입하지 않는다(같은 함수의 기존 실패 정책과 일치).

```js
const pasteImageAtCaret = async (file, caret) => {
  const tabId = activeTab.id;
  try {
    const r = await model.uploadFile(file);
    if (!(r && r.ok && r.path)) { /* 기존 too-large/비-ok 분기 그대로 */ return; }
    const current = activeTabRef.current;
    if (!current || current.id !== tabId) { /* 기존 탭 전환 취소 분기 그대로 */ return; }
    insertEmbedAtLine(/* 기존 인자 그대로 */);
  } catch {
    window.alert('이미지 업로드에 실패했습니다.');
  }
};
```

- catch는 **throw/rejected 경로 전용**이다. `too-large`(정상 응답의 `ok:false`)와 탭 전환 취소 분기는 기존 문구·동작 그대로 둔다.
- catch 경로에서도 base64 폴백을 만들지 마라(신규 base64 벡터 차단이 phase 20의 목적이자 유지 대상).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **catch 범위 한정**: 추가하는 것은 reject/throw를 잡는 catch뿐이다. 기존 `too-large`·비-ok 응답 분기, 탭 전환 취소 분기의 문구·동작을 바꾸지 마라. 이유: 확정된 실패 정책 회귀 방지.
2. **실패 = 삽입 취소 + alert(폴백 없음)**: catch에서 임베드를 삽입하지 마라. base64 인라인 폴백을 만들지 마라. 이유: 신규 base64 벡터 차단이 phase 20의 근본 목적.
3. **계층/신뢰경계 불변**: `WriterPage`만 수정한다. `Editor.jsx`(뷰는 transport 직접 호출 금지, ADR-003)·`model`/`server`/DB를 건드리지 마라.
4. **캐럿/탭 계약 불변**: `insertEmbedAtLine`·`activeTabRef`·`tabId` 고정 로직(업로드 대기 중 탭 전환 방어)을 바꾸지 마라. 이유: phase 20 코드리뷰가 데이터 무결성 버그로 도입한 방어 로직이다.

## Acceptance Criteria

```bash
npm run test:web   # web 전체 테스트 통과(rejected 케이스 포함)
npm test           # 서버 테스트 회귀 없음(server/ 미변경 확인)
npm run build      # vite 빌드 에러 없음
npm run lint       # ESLint 통과
```

추가 단언(`WriterPage.test.jsx`):

- **reject(신규, 실패 먼저)**: `model.uploadFile`이 `mockRejectedValue(...)`일 때 붙여넣기 → `window.alert('이미지 업로드에 실패했습니다.')` 호출 + `[data-embed-type="image"]` 미삽입 + 본문 블록 불변 + `img[src^="data:"]` 없음.
- **기존 회귀 유지**: 성공(`{ ok:true, path }`) 삽입, `too-large`(`{ ok:false, reason:'too-large' }`) alert+미삽입 케이스가 그대로 통과.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `WriterPage.jsx`와 그 테스트만 변경, `Editor.jsx`·`model`·`server/`·DB 미변경.
   - catch는 reject/throw 전용, 기존 분기 불변.
   - CLAUDE.md 규칙(DB 비파괴·TDD·UTF-8) 준수.
3. 결과에 따라 `phases/21-editor-paste-hygiene/index.json`의 step 3을 갱신한다(completed+summary / error / blocked).

## 금지사항

- 기존 `too-large`/비-ok/탭 전환 분기의 문구나 동작을 바꾸지 마라. 이유: 확정 실패 정책 회귀.
- catch에서 base64 폴백을 만들거나 임베드를 삽입하지 마라. 이유: 신규 base64 벡터 차단이 목적.
- `Editor.jsx`를 수정하지 마라(호출부에서 await/catch 추가 포함). 이유: 이 step 범위는 `WriterPage`의 오케스트레이션 실패 처리 한 건이며, 실패 피드백 단일 출처를 `pasteImageAtCaret`에 둔다.
- `model`/`server/`/DB/스키마를 건드리지 마라. 이유: 프론트+phase-doc 위생 전용, 신뢰경계=서버.
- 기존 테스트를 깨뜨리지 마라.
