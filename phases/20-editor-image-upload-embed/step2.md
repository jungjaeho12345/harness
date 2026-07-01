# Step 2: render-backcompat-regression — 신규 /uploads 경로 + 레거시 base64 렌더 회귀 잠금

## 배경 / 요구사항

step1로 새 붙여넣기 이미지는 `/uploads/<hex>.<ext>` **상대경로** `src`로 본문에 저장된다. 한편 이미 저장된 레거시 기사에는 `data:image/...;base64,...` `src`가 들어 있다(마이그레이션하지 않는다 — 이번 phase 범위는 **"신규 base64 생성 차단 + 레거시 렌더 보존"** 으로 확정).

이 step은 **두 형식(신규 상대경로 + 레거시 base64)이 에디터 렌더(`InlineEmbed`)와 상세보기 렌더(`articleDetail`) 양쪽에서 계속 `<img>`로 렌더됨을 회귀 테스트로 잠근다.** `isAllowedImageSrc`는 **조이지 않는다**(레거시 로드가 깨지면 기존 기사 이미지가 사라진다). 정밀 조사 결과 두 형식 모두 현재 규칙에서 이미 허용되므로, 정상이라면 이 step은 **프로덕션 코드 변경 없이 회귀 테스트만 추가**하고 통과해야 한다.

- 붙여넣기 흐름 전환은 step1에서 완료됨(전제).

## 읽어야 할 파일

먼저 아래 파일을 읽고 렌더/검증 계약을 파악하라:

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`.
- **Step 1 산출물**: 붙여넣기가 `/uploads` 경로 임베드를 생성(`web/src/view/WriterPage.jsx`의 `pasteImageAtCaret`).
- `web/src/view/clipboardEmbed.js` — `isAllowedImageSrc`(46~53): `classifyUrl` 기반. scheme 없음(상대경로) → `true`, `data` → `/^data:image\//i` → `true`, `https` → `isHttpsAuthority`. 즉 **신규 `/uploads`(상대)·레거시 `data:image` 둘 다 허용**됨. **이 step에서 변경 금지.**
- `web/src/view/InlineEmbed.jsx` — image 렌더(21~33): `isAllowedImageSrc(embed.src)` 가드 후 `<img src referrerPolicy="no-referrer">`(최대 200×200 캡).
- `web/src/view/articleDetail.js` — `embedHtml`의 image 분기: `isAllowedImageSrc` 가드 + 모든 값 `escapeHtml`, 비허용 스킴은 원본 미노출(폴백 자리표시자). 발행 XSS 싱크(ListPage `document.write`)와 연결됨.
- `web/src/view/InlineEmbed.test.jsx`, `web/src/view/articleDetail.test.js`, `web/src/view/clipboardEmbed.test.js` — 렌더/검증 테스트 컨벤션. (`articleDetail.test.js`에 이미 `/uploads/...` 렌더 케이스가 있을 수 있으니 확인하고 중복을 피한다.)

## 작업

TDD(vitest). 프로덕션 코드는 원칙적으로 손대지 않고 **회귀 단언만** 추가한다:

- **`clipboardEmbed.test.js`**:
  - `isAllowedImageSrc('/uploads/deadbeef.png')` === `true`(신규 상대경로).
  - `isAllowedImageSrc('data:image/png;base64,AAAA')` === `true`(레거시 하위호환).
  - `isAllowedImageSrc('javascript:alert(1)')` === `false`, `isAllowedImageSrc('data:text/html,x')` === `false`(악성 거부 유지).
- **`InlineEmbed.test.jsx`**:
  - `{ embedType:'image', src:'/uploads/deadbeef.png' }` → `<img src="/uploads/deadbeef.png">` 렌더.
  - 레거시 `{ embedType:'image', src:'data:image/png;base64,AAAA' }` → 여전히 `<img>` 렌더.
- **`articleDetail.test.js`**:
  - `/uploads/deadbeef.png` 이미지 임베드 → `renderDetailHtml`/`embedHtml` 출력에 `<img src="/uploads/deadbeef.png" ...>` 포함.
  - 레거시 `data:image/...;base64` 이미지 → 출력에 `<img` 포함(렌더 보존).
  - 악성(`javascript:`, `data:text/html`) 이미지 → 결과 HTML에 원본 `src` **미포함**(폴백만).
- 만약 신규 테스트가 예상과 달리 실패하면(상대경로/레거시가 안 걸림), **규칙을 조이거나 완화하지 말고 그대로 보고**하라 — 조사 결과는 둘 다 허용됨을 확인했다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **`isAllowedImageSrc`/`classifyUrl` 불변**: `data:image`(레거시)와 scheme 없는 상대경로(`/uploads`) 둘 다 계속 허용해야 한다. 이유: 레거시 base64 임베드·기존 상대경로 렌더 회귀 방지 + 하위호환.
2. **렌더 분기 불변**: `InlineEmbed.jsx`·`articleDetail.js`의 `<img>` 속성·`referrerPolicy`·`escapeHtml`·스킴 게이트를 바꾸지 마라. 이유: 이 step은 회귀 잠금이며, 발행 XSS 싱크(ListPage `document.write`) 안전성은 현재 `escapeHtml`+스킴 게이트에 의존한다.
3. **레거시 본문 불가침**: 이미 저장된 base64 본문을 마이그레이션·삭제·절단하지 마라. 이유: DB 비파괴 원칙 + 하위호환(기존 기사 이미지 소실 금지). "신규 생성 차단"과 "레거시 로드 보존"은 별개다.

## Acceptance Criteria

```bash
npm run test:web   # web 전체(신규/레거시 렌더 + 악성 거부) 통과
npm run build      # vite 빌드 에러 없음
npm run lint       # ESLint 통과
```

(서버 코드 미변경이므로 `npm run test`(node --test)는 서버 무회귀 확인용으로만 선택 실행한다 — 이 step의 권위 있는 게이트는 `npm run test:web`이다.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `isAllowedImageSrc`/렌더 분기 미변경(테스트만 추가) — `grep`으로 프로덕션 diff가 없음을 확인.
   - 신규 상대경로·레거시 base64 두 형식이 `InlineEmbed`·`articleDetail` 양쪽에서 렌더됨(green).
   - 악성 URL 거부(원본 미노출) 유지.
   - CLAUDE.md 규칙(DB 비파괴) 준수.
3. 결과에 따라 `phases/20-editor-image-upload-embed/index.json`의 step 2를 갱신한다(completed+summary / error / blocked).

## 금지사항

- `isAllowedImageSrc`/`classifyUrl`을 `/uploads` 접두로 한정하거나 `data:image` 허용을 제거하는 등 규칙을 강화·완화하지 마라. 이유: 레거시 base64 임베드와 기존 상대경로 렌더가 회귀로 깨지고, 이 phase 범위(크기 근본해결)를 벗어난다.
- 기존에 저장된 base64 본문을 마이그레이션하거나 삭제/절단하지 마라. 이유: DB 비파괴 + 하위호환.
- `InlineEmbed.jsx`·`articleDetail.js`의 렌더 분기(`<img>` 속성·`referrerPolicy`·`escapeHtml`)를 바꾸지 마라. 이유: 회귀 잠금 step이며 발행 XSS 싱크 안전성이 여기에 의존한다.
- 기존 테스트를 깨뜨리지 마라.
