# Step 4: image-embed-empty-src

(선별 minor) `clipboardEmbed.js`의 `makeImageEmbed(src)`는 **빈/공백 src에도 임베드 블록을 생성**한다. 형제 팩토리(`makeAudioEmbed`/`makeLinkEmbed`/`makeLocalVideoEmbed`)는 모두 `trim` 후 빈값이면 `null`을 돌려주는데 이미지만 이 가드가 빠져 있어, 빈 src로 **깨진 이미지 임베드**가 본문에 삽입될 수 있다. 형제 팩토리와 동형으로 맞춘다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 프로젝트의 아키텍처와 설계 의도를 파악하라:

- `/CLAUDE.md` — 프로젝트 규칙(DB 비파괴·TDD·conventional commits).
- `/docs/ARCHITECTURE.md` — 프론트 MVC, 순수 view 로직(ADR-003).
- `/docs/ADR.md` — zero-dep·TDD.
- `/docs/news.md` — 이미지/영상/글기사 임베딩(161~162행), 붙여넣기 이미지 크기(162행).
- `/web/src/view/clipboardEmbed.js` — **수정 대상**. `makeImageEmbed(src, { alt })`(약 76~85행): 현재 `src: String(src ?? '')`로 빈값도 임베드를 만든다. 형제 팩토리 선례를 확인하라:
  - `makeAudioEmbed`(약 114~123행): `const value = String(src ?? '').trim(); if (!value) return null;`.
  - `makeLinkEmbed`(약 138~146행)·`makeLocalVideoEmbed`(약 126~135행): 동일 패턴.
  - `makeVideoEmbed`(약 88~100행): 유튜브가 아니면(빈값 포함) 이미 `null`.
- `/web/src/view/WriterPage.jsx` — **참고(수정 금지)**. `makeImageEmbed` 호출부가 `null`을 안전히 처리하는지 확인:
  - `onUrlEmbedSubmit`(약 693~702행): `insertEmbed(embed)` → `insertEmbedAtLine`이 `if (!embed) return`으로 no-op.
  - 검색 onPick(약 838행): `insertEmbed(makeImageEmbed(item.src ?? item.link ?? item.url ?? '', ...))` → 빈값이면 `null` → no-op.
  - `pasteImageAtCaret`(약 646~651행): `makeImageEmbed(r.path, ...)`의 `r.path`는 검증된 비어있지 않은 업로드 경로(가드에 영향 없음).
- `/web/src/view/InlineEmbed.jsx`(있으면) 또는 임베드 렌더러 — 참고. 빈 src 이미지가 렌더 시에도 `isAllowedImageSrc('')===false`로 무력화되지만, **애초에 임베드를 만들지 않는 게** 본문 markup 오염을 막는 올바른 위치임을 이해하라.
- `/web/src/view/clipboardEmbed.test.js`(또는 동일 디렉토리 임베드 팩토리 테스트) — **수정/신규 대상**. 형제 팩토리의 "빈 src → null" 테스트 스타일을 따른다. 파일이 없으면 신규 작성.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 설계 의도를 이해한 뒤 작업하라.

## 배경(결함 상세)

- `makeImageEmbed('')`/`makeImageEmbed('   ')`/`makeImageEmbed(null)`이 `src:''`인 임베드 블록을 만들어 본문에 삽입되면, 렌더는 무력화되어도 **markupVersion에 쓸모없는 깨진 임베드 블록이 영속**된다(직렬화·저장·불러오기에서 그대로 남음).
- 형제 팩토리는 모두 빈값에 `null`을 돌려주고, 호출부(`insertEmbedAtLine`의 `!embed` 가드)가 no-op으로 흡수한다. 이미지만 맞추면 된다.

## 작업 (TDD — 테스트 먼저)

### 1) 테스트 먼저 작성 — `clipboardEmbed.test.js`

- `makeImageEmbed('')`·`makeImageEmbed('   ')`(공백만)·`makeImageEmbed(null)`·`makeImageEmbed(undefined)`가 **`null`**을 돌려줌을 단언한다.
- `makeImageEmbed('data:image/png;base64,AAAA')`·`makeImageEmbed('/uploads/x.png')` 등 **정상 src**는 기존대로 `embedType:'image'` 임베드를 돌려주고 `src`가 보존됨을 단언한다(앞뒤 공백은 trim되어도 무방 — 형제 팩토리와 동일 정책).
- (권장) 기존 `makeImageEmbed` 관련 테스트가 있으면 정상 src 케이스가 **그대로 통과**함을 확인한다.

### 2) 구현 — `/web/src/view/clipboardEmbed.js` (`makeImageEmbed`)

- 형제 팩토리와 동형으로 가드를 추가한다:
  ```js
  export function makeImageEmbed(src, { alt = '' } = {}) {
    const value = String(src ?? '').trim();
    if (!value) return null;         // 빈/공백 src → 임베드 생성 안 함(형제 팩토리와 동일)
    return embedBlock({ embedType: 'image', src: value, alt, /* 기존 크기 필드 유지 */ });
  }
  ```
- 기존 크기 필드(`widthPercent`/`heightPercent`/`figureWidthPx` = `EMBED_SIZE.*`)는 **그대로 유지**한다(news.md 162행 크기 규칙 불변).

### 핵심 불변식(반드시 준수)

- 빈/공백/null/undefined src → `makeImageEmbed`가 `null`을 반환한다(임베드 미생성).
- 정상 src → 기존과 동일한 이미지 임베드(크기 필드 포함)를 반환한다.
- `clipboardEmbed.js`는 순수 함수·transport 비의존을 유지한다.

## Acceptance Criteria

```bash
npm run test:web   # 신규 빈 src 가드 테스트 + 전체 회귀 통과 (vitest, web 루트)
npm run build      # vite 프로덕션 빌드 에러 없음
npm run lint       # ESLint 위반 없음
```

모든 신규/수정 텍스트는 UTF-8로 저장하라.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트를 확인한다:
   - 형제 팩토리(audio/link/localVideo)와 동일한 `trim`+`null` 가드 형태인가?
   - 크기 필드(EMBED_SIZE) 규칙을 유지했는가?
   - 호출부(WriterPage)를 수정하지 않고도 `null` 반환이 안전히 no-op으로 흡수되는가?
3. 결과에 따라 `phases/28-audit-stabilization/index.json`의 step 4를 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 시도 후에도 실패 → `"status": "error"`, `"error_message": "구체적 에러 내용"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "구체적 사유"` 후 즉시 중단

## 금지사항

- 다른 팩토리(`makeVideoEmbed`/`makeAudioEmbed` 등)나 호출부(WriterPage)를 수정하지 마라. 이유: 이 결함은 `makeImageEmbed`의 가드 누락 하나뿐이다 — scope 최소화(다른 step과 파일 겹침 방지).
- 크기 필드(widthPercent/heightPercent/figureWidthPx)를 바꾸지 마라. 이유: news.md 162행 붙여넣기 이미지 크기 규칙이며 이 step 범위 밖이다.
- 렌더러(InlineEmbed)에서 빈 src를 걸러내는 것으로 대체하지 마라. 이유: 올바른 위치는 임베드를 **애초에 만들지 않는** 팩토리다 — 렌더 방어만으로는 깨진 블록이 markup에 영속된다.
- 서버/DB 스키마를 수정하지 마라. 이유: 순수 클라이언트 로직 결함이며 DB 비파괴 원칙을 지킨다.
- 새 npm 의존성을 추가하지 마라(zero-dep).
- 기존 테스트를 깨뜨리지 마라. 이유: 회귀 스위트가 하류 단계의 안전망이다.
