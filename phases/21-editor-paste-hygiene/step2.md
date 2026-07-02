# Step 2: remove-dead-embedfrompaste — 死코드 embedFromPaste 제거 (뷰 유틸)

## 배경 / 요구사항

Phase 20에서 붙여넣기 흐름을 base64 인라인에서 서버 업로드 경로로 전환하면서, `Editor.jsx`가 더 이상 `embedFromPaste`를 사용하지 않게 되었다(FileReader/base64 생성 경로 제거됨). 그 결과 `web/src/view/clipboardEmbed.js`의 `export function embedFromPaste(...)`는 **프로덕션 코드에서 아무 곳도 호출하지 않는 死코드**이며, 오직 자기 자신의 테스트(`clipboardEmbed.test.js`)만 참조한다(phase 20 코드리뷰가 비차단 nit로 지적).

이 step은 `embedFromPaste`와 그 전용 테스트 블록을 제거한다. **삭제 전 반드시 grep으로 다른 소비자가 없음을 재확인**한 뒤 제거한다.

이 step은 **뷰 유틸 한 파일(`clipboardEmbed.js`)과 그 테스트만** 다룬다. 커밋 타입: **refactor:**.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(계층 분리), `/docs/ADR.md`.
- `web/src/view/clipboardEmbed.js` — **수정 대상**. `embedFromPaste`(약 148~154):
  ```js
  // 클립보드 페이로드({imageDataUrl?, text?}) → 임베드 블록(없으면 null).
  export function embedFromPaste({ imageDataUrl, text } = {}) {
    if (imageDataUrl) return makeImageEmbed(imageDataUrl);
    if (text) return makeVideoEmbed(text);
    return null;
  }
  ```
  **유지해야 할 export들**(절대 건드리지 마라): `parseYouTubeId`, `makeImageEmbed`, `makeVideoEmbed`, `makeArticleEmbed`, `makeLocalVideoEmbed`, `makeLinkEmbed`, `EMBED_SIZE`, `isAllowedImageSrc`/`isAllowedMediaSrc`/`isAllowedHref`, `classifyUrl` 등 나머지 전부.
- `web/src/view/clipboardEmbed.test.js` — **수정 대상(테스트)**. `embedFromPaste`를 다루는 `describe`/`it` 블록만 제거한다. 다른 export의 테스트는 그대로 둔다.
- `web/src/view/Editor.jsx` — **읽기만**(phase 20에서 이미 `embedFromPaste` import/사용을 제거했음을 확인).

## 작업

TDD 관점: 이것은 **삭제**다. 실패 테스트를 새로 작성하는 대신, "제거 후 전체 스위트와 빌드가 여전히 green이고 어떤 import 참조도 깨지지 않는다"가 검증 목표다.

1. **소비자 부재 재확인(선행 강제)**: 아래 grep으로 프로덕션 소비자가 없음을 확인한다.
   ```bash
   rg -n "embedFromPaste" web/src server
   ```
   기대 결과: `clipboardEmbed.js`(정의)와 `clipboardEmbed.test.js`(전용 테스트)에서만 매치. 그 외(특히 `Editor.jsx`·`WriterPage.jsx`·`server/`)에서 매치가 나오면 **제거하지 말고 blocked 처리**하고 오케스트레이터에 보고한다(계획 전제가 틀린 것).
2. `clipboardEmbed.js`에서 `embedFromPaste` 함수 정의와 그 주석을 제거한다.
3. `clipboardEmbed.test.js`에서 `embedFromPaste` 전용 `describe`/`it` 블록(및 그 블록에서만 쓰이는 import/헬퍼)을 제거한다.
4. `makeImageEmbed`·`makeVideoEmbed` 등 여전히 쓰이는 export가 lint의 미사용 경고 없이 그대로 export/사용되는지 확인한다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **선(先)확인 후(後)삭제**: grep으로 소비자 부재를 확인하기 전에는 제거하지 마라. 매치가 정의+전용테스트 외에 있으면 blocked.
2. **다른 export 불변**: `embedFromPaste`만 제거한다. `parseYouTubeId`/`make*Embed`/`EMBED_SIZE`/`isAllowed*`/`classifyUrl` 등 나머지 export의 시그니처·동작을 바꾸지 마라. 이유: 검색패널·URL삽입·InlineEmbed·articleDetail 등 다수 소비자가 공유한다.
3. **테스트만 동반 제거**: `embedFromPaste` 전용 테스트만 지운다. 다른 함수 테스트를 삭제하지 마라.

## Acceptance Criteria

```bash
npm run test:web   # web 전체 테스트 통과(embedFromPaste 테스트 제거 후에도 green)
npm test           # 서버 테스트 회귀 없음(server/ 미변경 확인)
npm run build      # vite 빌드 에러 없음(dangling import 없음)
npm run lint       # ESLint 통과(미사용 export/import 없음)
```

추가 검증:

- `rg -n "embedFromPaste" web/src server` → **매치 0건**(정의·테스트 모두 사라짐, 프로덕션 참조 없음).
- `clipboardEmbed.js`의 다른 export(`makeImageEmbed` 등)는 여전히 정상 export되고 다른 테스트가 통과.

## 검증 절차

1. 위 AC 커맨드와 grep을 실행한다.
2. 아키텍처 체크리스트:
   - `clipboardEmbed.js`와 그 테스트만 변경, `Editor.jsx`·`WriterPage.jsx`·`server/`·DB 미변경.
   - 유지 대상 export 계약 불변.
   - CLAUDE.md 규칙(DB 비파괴·TDD·UTF-8) 준수.
3. 결과에 따라 `phases/21-editor-paste-hygiene/index.json`의 step 2를 갱신한다(completed+summary / error / blocked).

## 금지사항

- grep 확인 없이 제거하지 마라. 이유: 소비자가 남아 있으면 런타임/빌드가 깨지고 phase 전제가 무너진다.
- `embedFromPaste` 외 다른 export를 제거·수정하지 마라. 이유: 다수 소비자 공유 계약이라 회귀가 광범위하게 번진다.
- `Editor.jsx`/`WriterPage.jsx`/`server/`/DB를 건드리지 마라. 이유: 이 step 범위는 死코드 제거 한 건.
- 기존(다른 함수) 테스트를 깨뜨리지 마라.
