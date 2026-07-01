# Step 1: embed-factories-dialog-kinds — 오디오/링크/로컬영상 팩토리 + 다이얼로그 kind 확장

## 배경 / 요구사항

step0에서 `InlineEmbed.jsx`(에디터)·`articleDetail.js`(상세/발행)에 `audio`/`link`/`localVideo` 렌더 분기를 추가하고, `clipboardEmbed.js`에 URL 검증 유틸(`isAllowedMediaSrc`/`isAllowedHref`)을 단일 출처로 두었다. 이제 그 임베드 객체를 **만드는 팩토리**와, URL을 입력받는 **다이얼로그의 kind 라벨**을 확장한다.

이 step(step1)은 두 가지를 한다(둘 다 순수·전송 비의존이라 한 step으로 묶되, 모듈이 다르므로 작업·테스트를 분리):

1. **팩토리(`clipboardEmbed.js`)**: `makeAudioEmbed`/`makeLinkEmbed`/`makeLocalVideoEmbed` 추가. 기존 `makeImageEmbed`/`makeVideoEmbed`/`makeArticleEmbed`와 동형(`embedBlock({...})` 반환).
2. **다이얼로그 kind(`UrlEmbedDialog.jsx`)**: phase18에서 만든 순수 URL 입력 폼이 현재 `kind: 'image' | 'video'`만 라벨/placeholder를 가진다. `audio`/`link`/`localVideo` 라벨/placeholder/aria-label을 더한다. **컴포넌트 구조·동작은 그대로** — `KIND_META`에 항목만 추가한다.

이 step에는 **WriterPage 결선이 없다**(step2). 팩토리는 임베드 객체를 반환하고, 다이얼로그는 라벨만 바뀐다 — 둘 다 단위 테스트로 자기완결.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`(ADR-003 — 다이얼로그 순수 표시/폼).
- `/docs/news.md` — L180(도구 메뉴: 오디오 삽입·링크 삽입·로컬영상 삽입), L159~160(임베딩·크기 17%/figure 612px 규칙).
- **step0 산출물**(이 step의 전제):
  - `web/src/view/clipboardEmbed.js` — step0이 추가한 `isAllowedMediaSrc`/`isAllowedHref`(이 step의 팩토리는 검증을 호출하지 않는다 — 검증은 렌더 시점(step0 InlineEmbed/articleDetail) 단일 출처. 팩토리는 객체만 만든다, `makeVideoEmbed`처럼 명백히 부적격(빈 값)일 때만 null 가능). 기존 `EMBED_SIZE`(figureWidthPx=612), `makeImageEmbed`(L35)·`makeVideoEmbed`(L47, 유튜브 아니면 null)·`makeArticleEmbed`(L62) 시그니처·`embedBlock` import.
  - `web/src/view/InlineEmbed.jsx` — step0이 추가한 `audio`/`localVideo`는 `embed.src`, `link`는 `embed.href`·`embed.title`을 읽는다. **팩토리가 그 필드명(`src`/`href`/`title`)을 정확히 채워야 렌더가 동작한다** — step0 렌더 분기에서 읽는 키를 확인하고 일치시킨다.
  - `web/src/view/articleDetail.js` — 상세 렌더도 같은 키(`b.src`/`b.href`/`b.title`)를 읽는다 — 팩토리 필드명이 양쪽 렌더와 일치해야 한다.
- `web/src/view/clipboardEmbed.test.js` — 팩토리 테스트 컨벤션(반환 객체 `type:'embed'`+`embedType`+필드 확인, 부적격 입력 null).
- `web/src/view/UrlEmbedDialog.jsx` — `KIND_META`(L11~14: `image`/`video`만)·`kind` prop·`aria-label`(L49·61)·placeholder(L62). **이 `KIND_META`에 항목 추가가 이 step의 전부**(구조 변경 금지).
- `web/src/view/UrlEmbedDialog.test.jsx` — kind별 라벨/placeholder 단언 컨벤션.

## 작업

TDD로 진행한다(vitest). **팩토리 → 다이얼로그 kind** 순으로 테스트를 먼저 쓴다.

### (1) 팩토리 (clipboardEmbed.js)

기존 `make*Embed` 옆에 추가한다. 시그니처:

```js
// 오디오 임베드 — src는 사용자 입력 URL(검증은 렌더 시점 isAllowedMediaSrc에 위임).
export function makeAudioEmbed(src, { title = '' } = {}) {
  // embedBlock({ embedType: 'audio', src: String(src ?? ''), title, figureWidthPx: EMBED_SIZE.figureWidthPx })
}

// 로컬영상 임베드 — <video> 엘리먼트로 렌더(유튜브 iframe과 별개). src는 사용자 입력 URL.
export function makeLocalVideoEmbed(src, { title = '' } = {}) {
  // embedBlock({ embedType: 'localVideo', src: String(src ?? ''), title, figureWidthPx: EMBED_SIZE.figureWidthPx })
}

// 링크 임베드 — href는 사용자 입력 URL. title 없으면 href를 표시 텍스트로(렌더 시점 결정).
export function makeLinkEmbed(href, { title = '' } = {}) {
  // embedBlock({ embedType: 'link', href: String(href ?? ''), title })
}
```

규칙:
- 필드명은 **step0 렌더가 읽는 키와 정확히 일치**(`audio`/`localVideo`=`src`, `link`=`href`, 표시 텍스트=`title`). 불일치 시 렌더가 빈 figure가 된다.
- 팩토리는 **URL 검증을 호출하지 않는다**(검증은 렌더 단일 출처 — step0). 사용자가 빈/악성 URL을 넣어도 팩토리는 객체를 만들고, 렌더에서 거부된다. **예외**: 입력이 빈 문자열/누락이라 임베드 자체가 무의미하면 null을 반환해도 된다(makeVideoEmbed가 유튜브 아니면 null 반환하는 패턴) — 정책을 주석에 명시(권장: 트림 후 빈 src/href면 null, 그러면 step2 insertEmbed가 no-op).
- 크기: 오디오/로컬영상 figure 폭은 `EMBED_SIZE.figureWidthPx`(612px, 영상과 동일). 링크는 폭 필드 불필요(콘텐츠 폭 — step0 렌더의 `fit-content`).
- `embedBlock`(editorContent.js)으로 감싸 `type:'embed'`를 붙인다(기존 팩토리와 동일).

### (2) 다이얼로그 kind 확장 (UrlEmbedDialog.jsx)

`KIND_META`(L11)에 세 항목을 추가한다. **다른 변경 금지** — 컴포넌트 로직·구조·testid는 그대로:

```js
const KIND_META = {
  image: { title: '그림 삽입', placeholder: '이미지 URL (https://...)' },
  video: { title: '유튜브 영상 삽입', placeholder: '유튜브 URL (https://www.youtube.com/...)' },
  audio: { title: '오디오 삽입', placeholder: '오디오 URL (https://...)' },
  link: { title: '링크 삽입', placeholder: '링크 URL (https://...)' },
  localVideo: { title: '로컬영상 삽입', placeholder: '영상 URL (https://...)' },
};
```

- 라벨/placeholder는 news.md L180 메뉴 명칭과 일치('오디오 삽입'·'링크 삽입'·'로컬영상 삽입').
- `kind`가 미정의 값이면 기존 폴백(`KIND_META[kind] || KIND_META.image`, L31)이 그대로 동작 — 변경하지 마라.
- 컴포넌트는 여전히 **검증·임베드 생성을 하지 않는다**(phase18 규칙) — `clipboardEmbed`를 import하지 마라.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **팩토리 필드명 = 렌더 키 일치**: `audio`/`localVideo`는 `src`, `link`는 `href`, 표시 텍스트는 `title`. step0 `InlineEmbed`/`articleDetail`이 읽는 키와 정확히 맞춰라. 이유: 불일치 시 렌더가 빈 figure가 된다.
2. **팩토리는 검증 안 함**: `isAllowedMediaSrc`/`isAllowedHref`를 팩토리에서 호출하지 마라. 검증은 렌더 단일 출처(step0). 이유: 검증 중복 금지(단일 출처) — phase18 규칙. (단, 빈 입력 → null 폴백은 허용.)
3. **다이얼로그 순수성 유지(ADR-003)**: `UrlEmbedDialog`는 `KIND_META` 항목만 추가한다. `clipboardEmbed`/`make*Embed`/검증 import·호출 금지, model/fetch/localStorage/window/document 금지. 이유: 계층 분리 — 생성·검증은 결선(step2).
4. **기존 팩토리·kind 보존**: `makeImageEmbed`/`makeVideoEmbed`/`makeArticleEmbed`와 `image`/`video` `KIND_META`를 바꾸지 마라. 가산만. 이유: 회귀 방지.
5. **WriterPage 미접촉**: 이 step은 `clipboardEmbed.js`·`UrlEmbedDialog.jsx`(+테스트)만. `WriterPage.jsx`/`Editor.jsx`/`server/` 무변경. 이유: 결선은 step2(Scope 최소화).

## Acceptance Criteria

```bash
cd web && npm run test -- clipboardEmbed     # 팩토리 단언 통과
cd web && npm run test -- UrlEmbedDialog      # kind 라벨 단언 통과
cd .. && npm run test:web                      # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest):

**`clipboardEmbed.test.js`**:
- `makeAudioEmbed('https://cdn/a.mp3', { title: '인터뷰' })` → `{ type:'embed', embedType:'audio', src:'https://cdn/a.mp3', title:'인터뷰', figureWidthPx:612 }` 형태(키 존재 확인).
- `makeLocalVideoEmbed('https://cdn/a.webm')` → `embedType:'localVideo'`, `src` 채워짐, `figureWidthPx:612`. (`embedType`이 `video`가 **아님** — 유튜브와 별개.)
- `makeLinkEmbed('https://example.com', { title: '원문' })` → `embedType:'link'`, `href:'https://example.com'`, `title:'원문'`.
- 빈/누락 입력 정책 단언: 채택한 정책대로(예 `makeAudioEmbed('')`/`makeLinkEmbed('')` → null) — 정책과 테스트를 일치시킨다.
- (선택) 만든 임베드를 step0 렌더에 통과시키는 통합 단언: `makeAudioEmbed(허용src)`로 만든 객체를 `InlineEmbed`에 넣으면 `<audio>`가 렌더된다(필드명 일치 회귀 가드 — InlineEmbed.test.jsx에 두어도 됨).

**`UrlEmbedDialog.test.jsx`**:
- `kind='audio'` → `role="dialog"` aria-label '오디오 삽입', placeholder가 오디오용.
- `kind='link'` → aria-label '링크 삽입'.
- `kind='localVideo'` → aria-label '로컬영상 삽입'.
- 기존 `image`/`video` 단언 회귀 green.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트:
   - 팩토리 필드명이 step0 렌더 키(`src`/`href`/`title`)와 일치(통합 단언 또는 코드 대조).
   - 팩토리·다이얼로그가 검증을 호출하지 않음(`grep`으로 `isAllowedMediaSrc`/`isAllowedHref` 호출이 팩토리/다이얼로그에 없음 확인).
   - `UrlEmbedDialog`가 `clipboardEmbed`를 import하지 않음.
   - `WriterPage.jsx`/`Editor.jsx`/`server/` 무변경.
3. 결과에 따라 `phases/19-editor-embed-types/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- 팩토리에서 `isAllowedMediaSrc`/`isAllowedHref`를 호출하지 마라. 이유: 검증 단일 출처는 렌더(step0) — 중복 금지.
- 팩토리 필드명을 렌더 키와 다르게 두지 마라(예 `link`에 `src` 사용). 이유: 빈 figure가 된다.
- `UrlEmbedDialog`에 `clipboardEmbed`/`make*Embed`/검증을 import하거나 model/fetch/localStorage/window/document를 호출하지 마라. 이유: ADR-003 순수 표시/폼.
- `UrlEmbedDialog`의 컴포넌트 구조·testid·동작을 바꾸지 마라(KIND_META 항목 추가만). 이유: 회귀·결선 호환.
- 기존 `make*Embed`·`image`/`video` `KIND_META`를 수정하지 마라. 이유: 회귀.
- `WriterPage.jsx`/`Editor.jsx`/`server/`/DB를 건드리지 마라. 이유: 결선은 step2·client 전용·DB 비파괴.
