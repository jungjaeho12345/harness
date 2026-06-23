# Step 0: embed-render-validators — 오디오/링크/로컬영상 렌더 분기 + URL 검증 유틸(단일 출처)

## 배경 / 요구사항

phase18(`18-editor-tools-menu`)에서 도구 메뉴 '그림 삽입'(`tools.insertImage`)·'유튜브 영상 삽입'(`tools.insertYoutube`)을 URL 직접 입력 다이얼로그(`UrlEmbedDialog`)로 결선했다. 그러나 **'오디오 삽입'(`tools.insertAudio`)·'링크 삽입'(`tools.insertLink`)·'로컬영상 삽입'(`tools.insertLocalVideo`)**(news.md L180)은 **`InlineEmbed.jsx`가 그 임베드 타입을 렌더하지 못해**(현재 `image`/`video`/`article` 분기만 존재, 그 외 타입은 빈 `figure`) phase18에서 **DEFER**했다. 이 phase가 그 렌더 확장 + 결선을 한다.

이 step(step0)은 **렌더 레이어와 URL 검증 유틸만** 다룬다(팩토리/다이얼로그/결선은 step1·step2). 두 가지를 한다:

1. **URL 검증 유틸(단일 출처)**: 오디오/로컬영상의 `src`, 링크의 `href`는 **사용자 입력 URL**이고 발행 기사에 렌더된다 = **신뢰 경계**. 위험 스킴(`javascript:`/`data:`/그 외)을 차단하는 검증 함수를 `web/src/view/clipboardEmbed.js`에 추가한다(기존 `isAllowedImageSrc`와 **동일 모듈·동일 패턴**). 이 모듈이 **에디터 렌더(`InlineEmbed`)와 상세보기 렌더(`articleDetail`) 양쪽이 공유하는 단일 검증 출처**다.
2. **렌더 분기 확장**: `web/src/view/InlineEmbed.jsx`(에디터)와 `web/src/view/articleDetail.js`(상세/발행 새 창)에 `audio`/`link`/`localVideo` 타입 분기를 **양쪽 모두** 추가한다. **한쪽만 고치면 에디터에서 보이던 임베드가 발행 시 깨지므로 반드시 두 경로를 함께 확장한다.**

이 step에는 **임베드 생성(팩토리)·다이얼로그·WriterPage 결선이 없다**. 검증과 렌더만으로 자기완결 TDD가 가능하다(임베드 객체를 직접 만들어 `InlineEmbed`/`embedHtml`에 넣는 테스트).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`(보안 경계 — 신뢰 경계·DB 비파괴), `/docs/ADR.md`.
- `/docs/news.md` — L180(도구 메뉴: 링크 삽입·로컬영상 삽입·오디오 삽입), L159~160(임베딩·크기 규칙 — 참고).
- `web/src/view/clipboardEmbed.js` — **검증 유틸을 여기 추가**. 현재 `isAllowedImageSrc(src)`(L24~32: https:/`data:image/`·상대경로만 허용, `javascript:`/`data:text`/`http:` 거부), `parseYouTubeId`, `EMBED_SIZE`, `make*Embed` 팩토리. 새 검증 함수는 이 파일의 `isAllowedImageSrc` **바로 옆**에 둔다(단일 검증 출처).
- `web/src/view/clipboardEmbed.test.js` — 검증/팩토리 테스트 컨벤션.
- `web/src/view/InlineEmbed.jsx` — **에디터 렌더 분기 확장 대상**. 현재 `type === 'image'`(L19, `isAllowedImageSrc` 가드 후 `<img>`)·`'video'`(L32, `parseYouTubeId`로 canonical YouTube `<iframe>`)·`'article'`(L46, 내부 링크 카드) 분기. `figureWidth` 계산(L56)·`figure` 래퍼·`× 삭제 버튼`(`aria-label="임베드 삭제"`) 구조. `isAllowedImageSrc`를 `clipboardEmbed`에서 import해 재노출하는 패턴(L5·L9) — 새 검증 유틸도 동일하게 import.
- `web/src/view/InlineEmbed.test.jsx` — **직접 템플릿**. `image`/`video` 보안 단언 패턴(`javascript:`/`data:text/html`/`http:` src → `<img>`/`<iframe>` 미렌더, 허용 src만 렌더, `referrerPolicy=no-referrer`). 새 타입 테스트를 이 컨벤션으로 추가.
- `web/src/view/articleDetail.js` — **상세/발행 렌더 분기 확장 대상**. `embedHtml(b)`(L125~145)가 `image`(`isAllowedImageSrc` 가드 후 `<img>`)·`video`(canonical `<iframe>` + sandbox)·`article`(제목 텍스트) HTML을 만들고, **알 수 없거나 허용 안 된 임베드는 원본 값을 노출하지 않고 자리표시자**(`[type]`)만 둔다(L143~144). 모든 값은 `escapeHtml`(L29). `DETAIL_STYLE`(L69~119)에 `.yh-detail__embed--media`(이미지/영상은 라벨/박스 크롬 없이 미디어만, L113~117). `isAllowedImageSrc`/`parseYouTubeId`를 `clipboardEmbed`에서 import(L8) — 새 검증 유틸도 동일 경로 import.
- `web/src/view/articleDetail.test.js` — 상세 렌더 보안 단언 패턴(`javascript:alert(1)` 이미지 → `html`에 원본 미포함, video → `<iframe>` 포함/미포함).

## 작업

TDD로 진행한다(vitest). **검증 유틸 → 에디터 렌더 → 상세 렌더** 순으로, 각 단위마다 테스트를 먼저 쓴다.

### (1) URL 검증 유틸 (clipboardEmbed.js — 단일 출처)

`isAllowedImageSrc` 옆에 두 함수를 추가한다. 시그니처:

```js
// 오디오/로컬영상 미디어 src 허용 검사 — https: 와 scheme 없는 상대경로만 허용.
// 이미지(isAllowedImageSrc)와 달리 data: 를 허용하지 않는다(오디오/영상은 data: 인라인 불필요·표면 축소).
// javascript:/data:/http:/blob: 등은 모두 거부. 에디터(InlineEmbed)·상세(articleDetail) 렌더가 공유.
export function isAllowedMediaSrc(src) { ... }   // boolean

// 링크 href 허용 검사 — https: 와 scheme 없는 상대경로만 허용. javascript:/data: 등 거부.
// (mailto:/tel: 등 추가 스킴이 필요하면 명시적으로 허용 목록에 더한다 — 기본은 https/상대만.)
export function isAllowedHref(href) { ... }      // boolean
```

규칙(반드시):
- 입력이 문자열 아니거나 빈 문자열이면 `false`.
- scheme 정규식(`/^([a-zA-Z][a-zA-Z0-9+.-]*):/`)으로 스킴을 뽑되, **스킴 없음 = 상대경로 → 허용**(기존 `isAllowedImageSrc`와 동일 정책 — 자료/업로드 파일 상대경로 지원).
- 허용 스킴은 `https`만(소문자 비교). 그 외(`javascript`, `data`, `http`, `blob`, `file`, `vbscript` 등)는 모두 `false`. **`data:`는 미디어·링크에서 허용하지 않는다**(이미지의 `data:image/` 예외와 의도적으로 구분 — 이유는 주석에 명시).
- `isAllowedMediaSrc`와 `isAllowedHref`는 현재 동일 규칙이라도 **의미가 다르므로 두 함수로 둔다**(향후 링크에 `mailto:` 등을 더할 여지). 내부 공통 헬퍼로 묶어도 되나 export는 두 이름 모두.

### (2) 에디터 렌더 분기 (InlineEmbed.jsx)

`clipboardEmbed`에서 `isAllowedMediaSrc`/`isAllowedHref`를 import(기존 `isAllowedImageSrc` import 라인 확장)하고, `image`/`video`/`article` 분기 뒤에 추가한다:

- **`type === 'audio'`**: `isAllowedMediaSrc(embed.src)`가 true일 때만 `<audio controls src={embed.src}>` 렌더. 거부면 `body = null`(빈 figure — 크래시 금지). `referrerPolicy="no-referrer"`(이미지와 동형 — 외부 추적 최소화) 권장.
- **`type === 'localVideo'`**: `isAllowedMediaSrc(embed.src)`가 true일 때만 `<video controls src={embed.src}>` 렌더(YouTube `<iframe>`이 아니라 로컬/업로드 영상 파일 `<video>` 엘리먼트 — 둘은 별개 타입). 거부면 `body = null`. `figureWidthPx`(기본 612px) 폭을 영상과 동일하게 둔다.
- **`type === 'link'`**: `isAllowedHref(embed.href)`가 true일 때만 `<a href={embed.href} rel="noopener noreferrer" target="_blank">{embed.title || embed.href}</a>` 렌더. 거부면 `body = null`. **`rel="noopener noreferrer"` 필수**(탭내빙·referrer 누출 차단), `target` 정책 명시(새 탭 `_blank`).
- `figureWidth` 계산(L56~60)에 새 타입을 반영: `audio`/`link`는 콘텐츠 폭(`fit-content` 또는 적정 고정폭) 권장, `localVideo`는 `figureWidthPx`. **이미지(`fit-content`)·영상(`figureWidthPx`)·기사(`widthPx`) 기존 정책을 깨지 마라** — 새 타입만 분기 추가.
- `data-embed-type`은 `type` 그대로(`audio`/`link`/`localVideo`) 박는다(기존 패턴).

### (3) 상세/발행 렌더 분기 (articleDetail.js)

`embedHtml(b)`(L125)에 `image`/`video`/`article` 뒤, 폴백 자리표시자(L143) 앞에 동형 분기를 추가한다(모든 사용자 값은 **반드시 `escapeHtml`**):

- **`audio`**: `isAllowedMediaSrc(b.src)`면 `<figure ... data-embed-type="audio"><audio controls src="${escapeHtml(b.src)}"></audio></figure>`. 거부면 폴백 자리표시자로 떨어진다(원본 src 미노출).
- **`localVideo`**: `isAllowedMediaSrc(b.src)`면 `<video controls src="${escapeHtml(b.src)}">` figure. 거부면 폴백.
- **`link`**: `isAllowedHref(b.href)`면 `<a href="${escapeHtml(b.href)}" rel="noopener noreferrer" target="_blank">${escapeHtml(b.title || b.href)}</a>` figure. 거부면 폴백.
- 검증 실패 시 **절대 원본 URL을 HTML에 넣지 마라** — 기존 폴백(L143~144: `[type]` 자리표시자, 원본 값 미노출)으로 떨어뜨린다.
- `DETAIL_STYLE`에 미디어 표시용 스타일을 더해도 되나(예 `audio`/`video` 폭 100% 캡), **필수는 아니며** 기존 스타일을 깨지 않는 선에서만. `escapeHtml`로 감싼 정적 스킴만 박는다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **URL 검증 단일 출처**: 검증 함수는 `clipboardEmbed.js`에만 정의한다. `InlineEmbed.jsx`/`articleDetail.js`는 **import해 호출만** 한다 — 두 곳에 검증 로직을 복붙하지 마라. WriterPage(step2)에도 검증을 두지 않는다. 이유: 규칙이 갈라지면 한쪽만 막혀 발행 시 우회된다(phase18 규칙).
2. **양쪽 렌더 일관성**: `audio`/`link`/`localVideo` 분기를 **`InlineEmbed.jsx`와 `articleDetail.js` 모두**에 추가한다. 한쪽만 고치면 에디터에서 보이던 임베드가 발행 시 깨진다. 이유: 두 경로가 같은 임베드 객체를 렌더하므로 일관해야 한다.
3. **악성 URL 거부 = 렌더 거부(크래시 금지)**: `javascript:`/`data:`/`http:`/`blob:` 등 비허용 src·href는 렌더하지 않고 빈/안전 폴백으로 둔다. 예외를 던지거나 원본 값을 DOM/HTML에 노출하지 마라. 이유: 신뢰 경계 — 발행 기사에 XSS·스푸핑 주입 차단.
4. **링크 하드닝**: 렌더되는 `<a>`는 `rel="noopener noreferrer"` 필수. `target` 정책(예 `_blank`)을 명시한다. 이유: 탭내빙(reverse tabnabbing)·referrer 누출 차단.
5. **Editor.jsx 미접촉**: 이 step은 `InlineEmbed.jsx`(임베드 렌더 컴포넌트)·`articleDetail.js`·`clipboardEmbed.js`만 만진다. `Editor.jsx`(에디터 입력/키 경로)는 손대지 않고 `<Editor>`에 새 prop도 추가하지 않는다. 이유: 입력 경로 변경은 회귀 위험·범위 밖.
6. **기존 분기 보존**: `image`/`video`/`article` 렌더와 `isAllowedImageSrc`·기존 폴백을 바꾸지 마라. 새 타입 분기만 가산한다. 이유: 회귀 방지.
7. **`escapeHtml` 강제(articleDetail)**: 상세 렌더에서 모든 사용자 값(src/href/title)은 `escapeHtml`로 감싼다. 이유: 새 창은 정적 HTML 문자열 — 이스케이프 누락 시 XSS.

## Acceptance Criteria

```bash
cd web && npm run test -- clipboardEmbed    # 검증 유틸 단언 통과
cd web && npm run test -- InlineEmbed       # 에디터 렌더 분기 통과
cd web && npm run test -- articleDetail     # 상세 렌더 분기 통과
cd .. && npm run test:web                   # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest):

**`clipboardEmbed.test.js`**:
- `isAllowedMediaSrc('https://cdn.example.com/a.mp3')` === true, `isAllowedMediaSrc('clip.webm')`(상대경로) === true.
- `isAllowedMediaSrc('javascript:alert(1)')` === false, `isAllowedMediaSrc('data:text/html,<b>x</b>')` === false, `isAllowedMediaSrc('data:audio/mp3;base64,AAAA')` === false(미디어는 data: 불허), `isAllowedMediaSrc('http://insecure/a.mp3')` === false, `isAllowedMediaSrc('')` === false, `isAllowedMediaSrc(null)` === false.
- `isAllowedHref('https://example.com')` === true, `isAllowedHref('/list.do')`(상대) === true; `isAllowedHref('javascript:alert(1)')` === false, `isAllowedHref('data:text/html,x')` === false, `isAllowedHref('http://x')` === false.

**`InlineEmbed.test.jsx`** (악성 URL 거부 단언 포함):
- `embedType:'audio'` + 허용 https src → `<audio>` 렌더되고 `controls` 속성·src가 박힌다.
- `embedType:'audio'` + `javascript:alert(1)` src → `<audio>` **미렌더**(`document.querySelector('audio')` null).
- `embedType:'audio'` + `data:audio/...` src → **미렌더**.
- `embedType:'localVideo'` + 허용 https src → `<video controls>` 렌더(`<iframe>`이 아님 — `querySelector('iframe')` null, `querySelector('video')` 존재).
- `embedType:'localVideo'` + `javascript:`/`http:` src → `<video>` **미렌더**.
- `embedType:'link'` + 허용 https href → `<a>` 렌더되고 `href`·`rel="noopener noreferrer"`가 박힌다(`getAttribute('rel')`에 `noopener`·`noreferrer` 포함).
- `embedType:'link'` + `javascript:alert(1)` href → `<a href>` **미렌더**(또는 href 미설정 — 링크 텍스트만/빈 figure).
- 새 타입 모두 `× 삭제 버튼`(`aria-label="임베드 삭제"`)이 보이고(readOnly false), readOnly면 숨는다(기존 패턴 회귀 확인).

**`articleDetail.test.js`** (악성 URL 거부 단언 포함):
- `audio` 허용 src → `renderDetailHtml` 결과에 `<audio` 포함.
- `audio` `javascript:` src → 결과 HTML에 `javascript:` **미포함**(원본 src 비노출, 폴백 자리표시자만).
- `localVideo` 허용 src → `<video` 포함, 같은 src `javascript:`/`http:` → 원본 미포함.
- `link` 허용 https href → `<a` + `rel="noopener noreferrer"` 포함; `javascript:` href → 원본 미포함.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트:
   - 검증 함수는 `clipboardEmbed.js`에만(렌더 두 곳은 import·호출만 — `grep`으로 `InlineEmbed`/`articleDetail`에 검증 로직 복붙 없음 확인).
   - `audio`/`link`/`localVideo` 분기가 `InlineEmbed.jsx`·`articleDetail.js` **양쪽**에 존재.
   - 비허용 URL이 DOM/HTML에 노출되지 않음(보안 단언 green).
   - `Editor.jsx`·`server/` 무변경, `<Editor>` 신규 prop 없음.
3. 결과에 따라 `phases/19-editor-embed-types/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- 검증 로직을 `InlineEmbed.jsx`/`articleDetail.js`/`WriterPage.jsx`에 복붙하지 마라. 이유: 단일 출처가 갈라지면 한쪽만 막혀 발행 시 우회된다.
- `audio`/`link`/`localVideo` 분기를 한쪽 렌더 경로에만 추가하지 마라. 이유: 에디터·상세 일관성 — 한쪽만 고치면 발행 시 깨진다.
- 비허용(`javascript:`/`data:`/`http:`/`blob:`) src·href를 렌더하거나 원본 값을 DOM/HTML에 넣지 마라(예외도 던지지 마라 — 안전 폴백). 이유: 발행 기사 신뢰 경계 — XSS/스푸핑 차단.
- 링크 `<a>`에서 `rel="noopener noreferrer"`를 빼지 마라. 이유: 탭내빙·referrer 누출.
- `data:` 를 미디어/링크 검증에 허용하지 마라(이미지의 `data:image/` 예외를 복제 금지). 이유: 표면 축소 — 오디오/영상/링크는 data: 인라인이 불필요.
- `Editor.jsx`를 수정하거나 `<Editor>`에 prop을 추가하지 마라. 이유: 에디터 입력/키 경로 변경은 회귀 위험·범위 밖(InlineEmbed는 별개 렌더 컴포넌트라 수정 대상).
- `make*Embed` 팩토리·`UrlEmbedDialog`·`WriterPage` 결선을 이 step에서 만들지 마라. 이유: step1·step2 담당(Scope 최소화).
- `server/`·DB·`editorPrefs`(쓰기)를 건드리지 마라. 이유: 이 phase는 client 렌더 전용·DB 비파괴.
