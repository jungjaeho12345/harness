# Step 1: model-filename-collision — 클립보드 붙여넣기 파일명 충돌 방지 (모델 계층)

## 배경 / 요구사항

Phase 20에서 클립보드(Ctrl+V) 이미지 붙여넣기를 base64 인라인 저장에서 `POST /api/upload` 서버 업로드 경로 참조로 전환했다. 이때 확장자 없는 클립보드 `File`의 파일명을 `resolveUploadFilename(name, type)`이 MIME으로 합성한다(`pasted-<Date.now()>.<ext>`).

**finding 재검증 결과 — 원 finding의 전제(서버 덮어쓰기 위험)는 무효(REFUTED).** phase 20 코드리뷰의 nit는 "`pasted-${Date.now()}.${ext}` 하나뿐이라 같은 밀리초 안에 두 번 붙여넣으면 동일한 파일명 → 서버측 덮어쓰기(overwrite)"였다. 그러나 서버 계약(`test/upload.test.js`)을 재검증한 결과 **서버는 요청 `filename`을 저장 키로 쓰지 않는다** — 확장자 화이트리스트 검증에만 쓰고, 디스크에는 항상 `/uploads/<random-hex>.<ext>`로 저장한다(`assert.match(r.body.path, /^\/uploads\/[0-9a-f]+\.png$/)`, 경로 탐색 방지). 게다가 `pasteImageAtCaret`(WriterPage)은 임베드 src로 `r.path`만 쓰고 응답의 `filename`은 사용하지 않는다. **따라서 같은 ms 연속 붙여넣기가 디스크 파일을 덮어쓰거나 임베드가 뒤바뀌는 관찰 가능한 버그는 존재하지 않는다.**

**그럼에도 이 step으로 재정의하는 유효한 위생 항목(범위 조정):** `resolveUploadFilename`은 주석·설계상 **"순수 함수"로 문서화**돼 있으나(35행 위 주석 "순수 함수"), 본문에서 `Date.now()`를 직접 호출해 **비결정적**이다 → (1) 단위 테스트로 합성 파일명을 정확히 단언할 수 없고(유일성 보장을 검증 불가), (2) 방어적으로도 연속 호출이 서로 다른 파일명을 반환하는 편이 낫다(응답 `filename` 로깅·향후 서버 계약 변화 대비). 이 step은 **비결정성 제거 + 연속 호출 유일성 보장 + 결정적 테스트 가능성 확보**로 목표를 재정의한다. 서버 덮어쓰기 방지가 아니라 **모델 함수의 순수성/테스트 가능성 위생**이 목적이다.

이 step은 **클라이언트 모델 계층 한 파일(`httpModel.js`)만** 다룬다. 서버·DB·계약(contract) seam은 건드리지 않는다. 커밋 타입: **fix:**.

## 읽어야 할 파일

먼저 아래를 읽고 계약·설계 의도를 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(계층 분리·신뢰경계=서버), `/docs/ADR.md`(ADR-003 주입형 Model 계약).
- `web/src/model/httpModel.js` — **수정 대상**.
  - `IMAGE_EXT_BY_MIME`(15~20): `image/png→png`, `image/jpeg→jpg`, `image/gif→gif`, `image/webp→webp` (서버 확장자 화이트리스트의 이미지 항목과 정합).
  - `hasExtension(name)`(23~27): 마지막 `.` 뒤가 비어있지 않으면 확장자 있음.
  - `resolveUploadFilename(name, type)`(35~41) — **핵심 수정 지점**. 현재:
    ```js
    export function resolveUploadFilename(name, type) {
      const original = typeof name === 'string' ? name : '';
      if (hasExtension(original)) return original;
      const ext = IMAGE_EXT_BY_MIME[type];
      if (!ext) return original;
      return `pasted-${Date.now()}.${ext}`;   // ← 같은 ms 내 충돌
    }
  - `uploadFile(file)` — `resolveUploadFilename`을 호출해 `filename`을 만들어 `request('/api/upload', { body:{ filename, contentBase64 } })`로 보낸다. **시그니처·요청/응답 shape 불변.**
- `web/src/model/httpModel.test.js` — **수정 대상(테스트)**. 기존 `resolveUploadFilename`/`uploadFile` 테스트 컨벤션과 `/^pasted-\d+\.png$/` 정규식 단언 위치를 확인하라.
- `web/src/model/contract.js` — `MODEL_KEYS`에 `'uploadFile'` 등록됨(계약 seam). **읽기만 — 변경 금지.**
- `server/index.js` — `POST /api/upload`(확장자 화이트리스트·5MB). **읽기만 — 변경 금지.**

## 작업

TDD(vitest). `httpModel.test.js`에 **실패 테스트를 먼저** 추가한 뒤 구현한다.

목표는 두 가지다: **(A) 결정적 테스트 가능성** — `resolveUploadFilename`이 유일성 성분을 주입받을 수 있어 고정 입력에 대해 정확한 파일명을 단언할 수 있게 한다. **(B) 런타임 유일성** — 인자를 주입하지 않는 실제 호출부(`uploadFile`)에서 같은 밀리초 연속 호출도 서로 다른 파일명을 반환하게 한다.

권장 구현(재량이나 아래 계약을 반드시 지킬 것): **주입 가능한 단조(monotonic) 스탬프 소스**. 시그니처에 선택적 세 번째 인자를 추가하되 기본값이 현재 런타임 동작을 보존하게 한다.

```js
// 모듈 레벨: 단조 증가 스탬프 — 같은 ms에 여러 번 호출돼도 엄격히 증가하는 정수를 반환(런타임 유일성, (B)).
let lastStamp = 0;
function nextUploadStamp() {
  let t = Date.now();
  if (t <= lastStamp) t = lastStamp + 1;
  lastStamp = t;
  return t;
}

// 세 번째 인자 stamp: 주입되면 그 값을 그대로 사용(결정적 테스트, (A)). 생략되면 nextUploadStamp()(런타임, (B)).
export function resolveUploadFilename(name, type, stamp = nextUploadStamp()) {
  const original = typeof name === 'string' ? name : '';
  if (hasExtension(original)) return original;
  const ext = IMAGE_EXT_BY_MIME[type];
  if (!ext) return original;
  return `pasted-${stamp}.${ext}`;
}
```

- `uploadFile(file)`는 계속 **2개 인자로만** `resolveUploadFilename(file.name, file.type)`를 호출한다 → 기본값 경로(런타임 단조 스탬프)로 유일성 확보. `uploadFile` 시그니처·요청/응답 shape 불변.
- 주입 stamp가 정수면 파일명은 계속 **순수 숫자**(`\d+`)라 기존 `/^pasted-\d+\.png$/` 패턴을 그대로 만족한다.
- **주의(기본값 평가 시점):** `stamp = nextUploadStamp()`는 인자 미전달 시 호출마다 평가되므로 매 호출 유일하다(모듈 로드 1회 평가가 아님 — JS 기본 인자는 호출 시 평가). 이 동작을 테스트로 잠근다.
- **포맷 결정(반드시 명시적으로 선택하고 완료 시 summary에 기록):** 기존 `httpModel.test.js`는 `/^pasted-\d+\.png$/`를 단언한다(대략 310·319·413~420행). 위 정수 스탬프 방식(정규식 유지)을 **기본 권장**한다. 랜덤/카운터 접미사(예: `pasted-<ts>-<rand>.<ext>`) 등 다른 포맷을 택하면 `\d+` 정규식이 더 이상 매치하지 않으므로 해당 정규식/테스트를 새 포맷에 맞게 **함께 갱신**해야 한다(둘 중 한 방법을 반드시 이행).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수/결정적 계약 유지**: `resolveUploadFilename`은 export된 채로 유지하며 단위 테스트에서 직접 호출 가능해야 한다. 유일성 성분(카운터/스탬프)은 모듈 레벨 상태로 두되, 함수의 반환 계약(문자열 파일명)은 유지한다.
2. **분기 3종 불변**:
   - (1) 확장자 있는 name → **그대로 반환**(첨부/자료 파일 하위호환, 재작성 금지).
   - (2) 확장자 없음 + MIME 맵 미스(예: `image/bmp`, `image/svg+xml`) → **원본 name 그대로 반환**(임의 확장자 지어내지 않음 → 서버가 `invalid-file` 거부).
   - (3) 확장자 없음 + MIME 맵 히트일 때만 파일명 합성.
   - 유일성 성분은 **(3) 합성 경로에만** 적용한다. (1)·(2)는 절대 건드리지 마라.
3. **화이트리스트 정합**: 합성 파일명의 확장자는 반드시 `IMAGE_EXT_BY_MIME`에서 온 값이어야 하고, 파일명은 안전 문자(영숫자·`-`·`.`)만 포함하는 유효한 이름이어야 한다.
4. **seam 불변**: `uploadFile(file)` 시그니처, `contract.js` `MODEL_KEYS['uploadFile']`, 요청 body `{ filename, contentBase64 }`·응답 shape을 바꾸지 마라.
5. **서버/DB 미변경**: `server/index.js` 및 DB/스키마를 수정하지 마라(신뢰경계=서버).

## Acceptance Criteria

```bash
npm run test:web   # web 전체 테스트 통과
npm test           # 서버 테스트 회귀 없음(이 step은 server/ 미변경이라 green 유지 확인)
npm run build      # vite 빌드 에러 없음
npm run lint       # ESLint 통과
```

추가 단언(`httpModel.test.js`, 실패 먼저 작성):

- **결정적 주입((A), 신규)**: `resolveUploadFilename('', 'image/png', 12345)` === `'pasted-12345.png'` — 주입 stamp가 그대로 반영된다(순수/결정적).
- **런타임 유일성((B), 신규)**: stamp 미주입으로 `resolveUploadFilename('', 'image/png')`를 연속 2회(또는 여러 회) 호출 → 반환값이 서로 **다르다**. `Date.now`를 고정 mock 해 같은 ms를 강제해도 서로 달라야 한다(단조 스탬프).
- **확장자/화이트리스트 계약**: 합성 파일명의 확장자가 MIME에 대응하는 화이트리스트 값(`image/png→.png`, `image/jpeg→.jpg`, `image/gif→.gif`, `image/webp→.webp`)이다.
- **기존 케이스 회귀**: `report.pdf`→그대로, `photo.jpeg`→그대로, `image.`(trailing dot=확장자 없음)+`image/png`→합성, `''`+`image/bmp`(맵 미스)→`''` 그대로, `''`+빈/미지정 MIME→`''` 그대로.
- 기존 `/^pasted-\d+\.png$/` 단언이 통과하거나(권장 구현) 새 포맷에 맞게 갱신되어 통과.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 모델 계층(`httpModel.js`)만 변경, `server/`·`contract.js` `MODEL_KEYS`·DB 미변경.
   - `uploadFile(file)` 시그니처·요청/응답 shape 불변.
   - CLAUDE.md 규칙(DB 비파괴·UTF-8·TDD) 준수.
3. 결과에 따라 `phases/21-editor-paste-hygiene/index.json`의 step 1을 갱신한다:
   - 성공 → `"status": "completed"` + `"summary"`(생성/수정 파일·핵심 결정 한 줄).
   - 수정 3회 실패 → `"status": "error"` + `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"` + `"blocked_reason"` 후 중단.

## 금지사항

- 확장자가 있는 파일명을 재작성하지 마라. 이유: 첨부/자료 파일 업로드 하위호환이 깨진다.
- MIME 맵 미스일 때 임의 확장자를 붙이지 마라. 이유: 서버 화이트리스트 우회 시도를 만들고 거부 경로가 흐려진다 — 서버가 판정하게 둔다.
- `uploadFile` 시그니처/요청 body/`contract.js` `MODEL_KEYS`를 바꾸지 마라. 이유: 모델 계약 seam이 흔들려 `assertModelShape`·기존 호출부가 깨진다.
- `server/index.js`·DB·스키마를 수정하지 마라. 이유: 이 phase는 프론트+phase-doc 위생 전용, 신뢰경계=서버.
- 기존 테스트를 깨뜨리지 마라(정규식을 갱신하는 경우에도 다른 케이스는 그대로 통과해야 한다).
