# Step 0: model-upload-filename — 클립보드 이미지 업로드용 파일명 합성 (모델 계층)

## 배경 / 요구사항

Phase 20의 목적: **Ctrl+V 이미지 붙여넣기가 본문(`markupVersion`)에 base64 data URL을 인라인 저장하던 것을 끊고**, 기존 `POST /api/upload`(서버발급 random-hex 파일명·확장자 화이트리스트·5MB 상한)를 재사용해 이미지를 서버에 업로드한 뒤 반환된 상대경로(`/uploads/<hex>.<ext>`)를 임베드 `src`로 본문에 저장하도록 전환한다. 큰 이미지 한 장이 base64(원본의 ~1.37배)로 인라인되어 본문 크기가 폭증하던 문제를 근본 해결한다.

이 step(step0)은 **클라이언트 모델 계층만** 다룬다. `model.uploadFile(file)`은 첨부/자료 파일용으로 이미 존재하지만, **클립보드에서 얻은 이미지 `File`은 `file.name`이 비어 있고 확장자가 없어** 서버의 확장자 화이트리스트에서 `invalid-file`로 거부된다. 그래서 `uploadFile`이 **확장자 없는 파일일 때만** MIME(`file.type`)에서 이미지 확장자를 도출해 유효 파일명을 합성하도록 보강한다.

- 붙여넣기 흐름 전환(Editor→WriterPage 결선)은 **step1**.
- 신규 `/uploads` 경로 + 레거시 base64 렌더 회귀 잠금은 **step2**.

## 읽어야 할 파일

먼저 아래 파일을 읽고 아키텍처·설계 의도를 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(계층 분리·신뢰경계=서버), `/docs/ADR.md`(ADR-003 주입형 Model 계약).
- `web/src/model/httpModel.js` — **수정 대상**. `uploadFile(file)`(161~173): `File`→`FileReader`로 dataURL 읽기 → `/^data:[^;]*;base64,/` 접두 제거 → `request('/api/upload', { method:'POST', body:{ filename: file.name, contentBase64 } })` → 응답 `{ ok, path, filename }` 그대로 반환. `request`(50~66)는 `res.json()`만 반환하고 HTTP status는 검사하지 않는다.
- `web/src/model/httpModel.test.js` — 테스트 컨벤션(fetch mock·요청 body 검증).
- `web/src/model/contract.js` — `MODEL_KEYS`에 `'uploadFile'`이 등록되어 있음(계약 seam). **읽기만.**
- `server/index.js` — `POST /api/upload` 라우트: 요청 `{ filename, contentBase64 }`, 확장자 화이트리스트(png/jpg/jpeg/gif/webp 등)·`UPLOAD_MAX_BYTES`(5MB) 검증, 성공 응답 `{ ok:true, path:'/uploads/<hex>.<ext>', filename }`, too-large 시 `{ ok:false, reason:'too-large' }`, 확장자 밖이면 `{ ok:false, reason:'invalid-file' }`. **읽기만 — 수정 금지.**

## 작업

TDD로 진행한다(vitest). `httpModel.test.js`(또는 아래 순수 함수 단위 테스트)에 **실패 테스트를 먼저** 추가한 뒤 구현한다.

`uploadFile(file)`을 다음 규칙으로 보강한다. **시그니처는 `uploadFile(file)`로 불변**하며, 요청 body 형태(`{ filename, contentBase64 }`)·응답 반환도 불변이다. 파일명 결정 로직만 추가한다.

파일명 결정 규칙:

1. 원본 `file.name`에 **확장자가 있으면**(마지막 `.` 뒤가 비어있지 않으면) `file.name`을 **그대로** 사용한다(첨부/자료 파일 하위호환).
2. 확장자가 **없으면**(빈 `name` 포함) `file.type`(MIME)에서 이미지 확장자를 도출해 `pasted-<ts>.<ext>` 파일명을 합성한다. MIME 맵:
   ```js
   const IMAGE_EXT_BY_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
   ```
3. MIME 맵에 **없고**(예: `image/bmp`, `image/svg+xml`) 원본 확장자도 없으면 **합성하지 말고 `file.name`을 그대로 전송**한다 → 서버가 `invalid-file`로 안전 거부하게 둔다(클라가 임의 확장자를 지어내 화이트리스트를 우회 시도하지 않는다).

시그니처 스케치(내부 구현은 재량, 테스트 용이하게 순수 함수 분리 권장):

```js
// 순수 함수 — file.name/type만으로 서버에 보낼 파일명을 결정한다.
export function resolveUploadFilename(name, type) { ... } // → string
```

- `<ts>`는 `Date.now()` 등으로 만들되, 테스트는 파일명이 `/^pasted-\d+\.png$/` 같은 패턴에 매치되게 검증한다(고정값 불필요). 순수 함수 `resolveUploadFilename`을 export해 직접 단위 테스트하면 시간 의존을 피할 수 있다.
- `contentBase64` 접두 제거(`/^data:[^;]*;base64,/`)와 `request('/api/upload', ...)` 호출 형태는 그대로 재사용한다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **계약 seam 불변**: `uploadFile(file)` 시그니처, `contract.js`의 `MODEL_KEYS['uploadFile']`, `assertModelShape`를 바꾸지 마라. 이유: seam이 흔들리면 기존 호출부(`WriterPage`의 `CommonInfo.onFileChange`)·모델 계약 테스트가 깨진다.
2. **확장자 있는 파일명 보존**: 확장자가 이미 있는 파일명(pdf/doc/docx/xls/xlsx/hwp 등)은 재작성하지 마라. 이유: 기존 첨부/자료 파일 업로드 하위호환.
3. **신뢰경계=서버**: 클라 파일명 합성은 편의일 뿐이며 서버의 확장자 화이트리스트·5MB 검증을 대체하지 않는다. `server/index.js`를 수정하지 마라.
4. **MIME 맵 미스는 서버가 판정**: 맵에 없는 이미지 타입 + 빈 파일명이면 임의 확장자를 지어내지 말고 원본 그대로 보내 서버가 거부하게 둔다. 이유: 화이트리스트 우회 시도 방지·거부 경로 명확화.

## Acceptance Criteria

```bash
npm run test:web   # web 전체 테스트 통과
npm run build      # vite 빌드 에러 없음
npm run lint       # ESLint 통과
```

추가 단언(`httpModel.test.js` 또는 `resolveUploadFilename` 단위):

- `name='' , type='image/png'` → 요청 `filename`이 `/^pasted-\d+\.png$/` 매치.
- `type='image/jpeg'`→`.jpg`, `image/gif`→`.gif`, `image/webp`→`.webp`.
- `name='report.pdf'` → `filename === 'report.pdf'`(하위호환, 재작성 없음).
- `name='' , type='image/bmp'`(맵 미스) → 합성하지 않음(`filename === ''` 그대로 전송 — 서버가 거부).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 모델 계층(`httpModel.js`)만 변경, `server/`·`contract.js` `MODEL_KEYS` 미변경.
   - `uploadFile(file)` 시그니처·요청/응답 shape 불변.
   - CLAUDE.md 규칙(DB 비파괴·UTF-8·TDD) 준수.
3. 결과에 따라 `phases/20-editor-image-upload-embed/index.json`의 step 0을 갱신한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`(생성/수정 파일·핵심 결정 포함).
   - 수정 3회 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 중단.

## 금지사항

- `server/index.js`의 `/api/upload`·`UPLOAD_EXT_ALLOWLIST`·`UPLOAD_MAX_BYTES`를 수정하지 마라. 이유: 이미지 확장자는 이미 화이트리스트에 있고 서버 계약을 그대로 재사용한다.
- 확장자가 있는 파일명을 재작성하지 마라. 이유: 첨부/자료 파일 업로드 하위호환이 깨진다.
- `uploadFile`에 새 필수 인자를 추가하거나 `contract.js` `MODEL_KEYS`를 바꾸지 마라. 이유: 모델 계약 seam이 흔들려 `assertModelShape`·기존 호출부가 깨진다.
- MIME 맵 미스일 때 임의 확장자(`.bin` 등)를 붙이지 마라. 이유: 서버 화이트리스트 밖 파일이 통과를 시도해 거부 경로가 흐려진다 — 서버가 판정하게 둔다.
- 기존 테스트를 깨뜨리지 마라.
