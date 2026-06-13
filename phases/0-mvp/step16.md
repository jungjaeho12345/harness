# Step 16: embed-security-cleanup

본문 임베드(이미지/영상)의 **검증되지 않은 src**를 막고(iframe src allowlist + sandbox, img scheme allowlist), 사변적/데드 코드(TopBar의 미사용 `right` prop, `editorColoring.js`의 미사용 `ROLES` export)를 제거한다. **이 step은 임베드 렌더 보안 + 소규모 데드코드 제거 한 가지 관심사만 다룬다. 본문 contract(step14)·에디터 키 입력 결선(step15)은 건드리지 마라.**

## 근본 원인 (이 step에서 고치는 것)

### 16-A [Medium][보안] video iframe src 미검증 + sandbox 없음
- `web/src/view/InlineEmbed.jsx`(L16-24)가 `<iframe src={embed.src}>`를 **역직렬화된 블록에서 그대로** 렌더한다.
- `web/src/view/editorContent.js`의 `normalizeBlocks`(L27-35)는 임베드 속성을 **검증 없이 보존**한다(`{...b, type:'embed'}`). 따라서 저장본/레거시/위조된 markupVersion이 임의 `src`를 가질 수 있다.
- 신규 임베드만 `web/src/view/clipboardEmbed.js`의 `makeVideoEmbed`(L34-46)가 `https://www.youtube.com/embed/<id>`로 제약한다. 하지만 렌더 시점에는 이 제약이 강제되지 않는다.
- React가 `javascript:` src는 막아도, **임의 cross-origin `https:`/`data:` iframe 로드는 막지 못한다.** `sandbox` 속성도 없다.
- (참고: 서버 helmet CSP `frameSrc`(server/index.js L75)는 `:3001` API origin용이다. SPA는 `:5173` Vite origin이라 이 CSP가 적용되지 않는다 — ADR-001. 따라서 **클라이언트 렌더에서 직접 방어**해야 한다.)

### 16-B [Low][보안] image embed src 미검증
- `InlineEmbed.jsx`(L14-15)의 `<img src={embed.src}>`도 역직렬화 블록에서 그대로 렌더된다. 스크립트 실행은 아니지만 임의 외부 URL(`data:`, 임의 호스트)로 트래킹/콘텐츠 스푸핑이 가능하다. scheme allowlist가 없다.

### 16-C [Nit][유지보수] TopBar 미사용 prop
- `web/src/view/TopBar.jsx`(L8 `TopBar({ right = null })`, L24 `{right}`)의 `right` 슬롯이 있으나, `App.jsx`(L27 `<TopBar />`)는 prop을 전달하지 않는다. step12 스펙도 요구하지 않는 사변적 확장이다.

### 16-D [Nit][유지보수] ROLES 데드 export
- `web/src/view/editorColoring.js`(L15 `export const ROLES`)는 정의부 외 참조가 프로덕션·테스트 모두 전무하다.

## 읽어야 할 파일

먼저 아래를 읽고 임베드 블록 모델·보안 경계를 파악하라:

- `/docs/ADR.md` — ADR-001(SPA는 `:5173`, API는 `:3001` — 두 origin 분리이므로 API CSP가 SPA에 적용 안 됨), ADR-004(신뢰 경계 = 서버이나 클라 렌더 방어도 필요).
- `/docs/ARCHITECTURE.md`(보안 경계 절), `/docs/news.md`(기사 에디터 157행 임베드 크기·159행 "(끝)" — 임베드 자체 규칙).
- `web/src/view/InlineEmbed.jsx`(이미지 img·영상 iframe·기사 카드 렌더), `web/src/view/clipboardEmbed.js`(`parseYouTubeId` L16-19·`makeVideoEmbed` L34-46 — canonical URL 재구성 참고), `web/src/view/editorContent.js`(`normalizeBlocks` L27-35).
- `web/src/view/TopBar.jsx`, `web/src/app/App.jsx`(TopBar 사용처 L27), `web/src/view/editorColoring.js`(ROLES L15).
- 테스트 패턴: `web/src/view/InlineEmbed.test.jsx`, `web/src/view/clipboardEmbed.test.js`, `web/src/view/editorColoring.test.js`, `web/src/test/setup.js`.

이전 step에서 만들어진 코드를 꼼꼼히 읽고, 임베드 src가 어디서 들어오는지(신규 생성 vs 역직렬화 로드) 추적한 뒤 작업하라.

## 작업

### TDD 순서: 위조 src 거부/sandbox 적용을 검증하는 실패 테스트를 먼저

1. **video 보안 테스트** — `InlineEmbed.test.jsx`에 추가: (a) 위조 iframe src(예: `https://evil.example.com/x`, `data:text/html,...`)를 가진 video 임베드는 **iframe으로 렌더되지 않는다**(렌더 거부 — null 또는 안내 텍스트). (b) 정상 YouTube 임베드(`videoId` 또는 youtube URL)는 `https://www.youtube.com/embed/<id>`(또는 `youtube-nocookie`)로 **canonical하게 재구성된 src**로 렌더되고, `sandbox` 속성이 있다.
2. **image 보안 테스트** — 위조 image src(임의 호스트가 아닌 비허용 scheme, 예: `javascript:`/허용되지 않은 scheme)는 렌더 거부 또는 빈 src로 떨어지고, 허용 scheme(`https:`, `data:image/`)만 `<img>`로 렌더된다.
3. 현재 코드에서 이 테스트들이 **실패**하는 것을 먼저 확인한 뒤 구현한다.

### 구현 16-A: video iframe src allowlist + sandbox

`InlineEmbed.jsx`의 video 렌더(L16-24)를 수정하라:
- 렌더 시 `embed`로부터 **canonical YouTube embed URL을 재구성**하라. `clipboardEmbed.js`의 `parseYouTubeId`를 재사용해 `embed.videoId`(있으면 우선) 또는 `embed.src`/`embed.url`에서 11자리 video id를 추출하고, `https://www.youtube.com/embed/<id>`(또는 `https://www.youtube-nocookie.com/embed/<id>`)로 src를 만든다.
- video id를 추출할 수 없으면(= 비-YouTube/위조 src) **iframe을 렌더하지 마라.** 대신 null 또는 "재생할 수 없는 영상" 같은 안내 텍스트로 떨어뜨린다. 임의 src를 절대 iframe에 그대로 넣지 마라.
- iframe에 `sandbox` 속성을 추가하라(YouTube 재생에 필요한 최소 권한만, 예: `sandbox="allow-scripts allow-same-origin allow-presentation"` — 실제 재생되는 최소 조합을 선택). `allow-fullscreen`은 기존 `allowFullScreen` 유지.

### 구현 16-B: image src scheme allowlist

`InlineEmbed.jsx`의 image 렌더(L14-15)를 수정하라:
- `embed.src`가 허용 scheme(`https:` 또는 `data:image/`)일 때만 `<img src>`에 넣는다. 그 외(`javascript:`, `data:text/...`, `http:` 등 비허용)는 렌더 거부(null) 또는 빈 이미지로 떨어뜨린다.
- `referrerPolicy="no-referrer"`를 고려해 추가하라(트래킹 완화 — 선택이지만 권장).
- scheme 검사는 작은 헬퍼로 분리해 단위테스트 가능하게 하라(예: `isAllowedImageSrc(src)`). `InlineEmbed.jsx` 내부 함수여도 되고, 별 모듈이어도 된다.

### 구현 16-A/B(선택 보강): normalizeBlocks 방어 추가는 신중히

`editorContent.js`의 `normalizeBlocks`(L27-35)에서 임베드 속성을 검증 없이 보존하는 것이 근본 토양이다. **렌더 시점 방어(InlineEmbed)를 1차 방어선으로 반드시 두되**, normalizeBlocks에서 임베드 src를 정규화/제거하는 것은 **선택**이다. 만약 normalizeBlocks를 손댄다면:
- `serialize`/`deserialize` round-trip이 깨지지 않아야 한다(news.md 167행: 편집-저장-불러오기 반복 시 블록 순서 보존).
- 기존 editorContent.test.js·writerBody.test.js·clipboardEmbed.test.js가 전부 통과해야 한다.
- 위험하면 normalizeBlocks는 건드리지 말고 렌더 시점 방어만으로 마감하라(렌더에서 막으면 보안 목적은 달성된다).

### 구현 16-C: TopBar 미사용 right prop 제거

`TopBar.jsx`에서 `right` prop(L8)과 `{right}` 슬롯(L24)을 제거하라. `App.jsx`(L27)는 이미 prop을 전달하지 않으므로 사용처 변경은 없다. TopBar 테스트가 `right`를 검증하지 않는지 grep으로 확인하라(검증하면 그 테스트도 함께 정리).

### 구현 16-D: ROLES 데드 export 제거

`editorColoring.js`(L15)의 `export const ROLES`를 제거하라. 제거 전 `grep`으로 프로덕션·테스트 양쪽에서 `ROLES`(editorColoring 경유) 참조가 없는지 반드시 확인하라. `COLORS`/`classifyLines`/`colorForRole`/`colorLines`/`shouldRecolor`/`RECOLOR_TRIGGERS`는 건드리지 마라.

## Acceptance Criteria

```bash
npm run lint                              # ESLint 통과 (미사용 import/export 없음)
npm run build                             # 프론트 빌드 에러 없음
npm test                                  # 백엔드 node --test 전부 통과(변동 없어야 정상)
npm run test:web                          # Vitest 전부 통과(신규 보안 테스트 포함)
```

이 step 시작 시점의 전체 테스트(프론트 + 백엔드)를 깨뜨리지 마라. 백엔드는 손대지 않으므로 그대로 통과해야 한다.

## 검증 절차

1. 위 AC 커맨드를 전부 실행한다.
2. 아키텍처 체크리스트:
   - video iframe이 **YouTube embed canonical URL로만** 렌더되고 위조 src는 거부되는가? `sandbox`가 있는가? (16-A)
   - image가 허용 scheme(`https:`/`data:image/`)으로만 렌더되는가? (16-B)
   - 렌더 시점 방어가 1차 방어선인가? (SPA origin에는 API CSP가 적용 안 됨 — ADR-001)
   - normalizeBlocks를 건드렸다면 serialize/deserialize round-trip(블록 순서 보존, news.md 167행)이 유지되는가?
   - 제거한 데드코드(TopBar right·ROLES)가 다른 곳에서 참조되지 않음을 grep으로 확인했는가?
3. 결과에 따라 `phases/0-mvp/index.json`의 step 16을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary": "산출물 한 줄 요약"`
   - 수정 3회 실패 → `"status": "error"`, `"error_message": "구체적 에러"`
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason": "사유"` 후 중단

## 금지사항

- iframe에 임의 `src`를 그대로 넣지 마라. 이유: React가 `javascript:`는 막아도 임의 cross-origin `https:`/`data:` iframe 로드는 못 막는다(16-A 근본 원인). 반드시 video id를 추출해 YouTube embed canonical URL로 재구성하고, 추출 실패 시 iframe 자체를 렌더하지 마라.
- img에 비허용 scheme src를 넣지 마라. 이유: `data:text/...`/임의 호스트로 트래킹·콘텐츠 스푸핑이 가능하다. `https:`/`data:image/`만 허용한다.
- 데드코드(ROLES/right)를 grep 확인 없이 지우지 마라. 이유: 테스트나 다른 모듈이 import하면 그 코드가 깨진다.
- normalizeBlocks를 건드려 serialize/deserialize round-trip을 깨지 마라. 이유: news.md 167행(편집-저장-불러오기 반복 시 블록 순서 보존)을 위반하고 기존 editorContent/writerBody 테스트를 깬다. 불확실하면 렌더 시점 방어만으로 마감하라.
- 본문 contract(markupVersion 전송, step14)·에디터 키 입력 결선("(끝)" 차단·Ctrl+D·IME, step15)을 건드리지 마라. 이유: 각각 다른 step의 응집 단위다. 범위를 섞으면 실패 격리가 불가능하다.
- 신규 임베드 생성 경로(`makeVideoEmbed`/`makeImageEmbed`)의 동작을 바꾸지 마라(이미 youtube/embed로 제약됨). 이 step은 **렌더 시점** 방어를 추가하는 것이다 — 생성과 렌더 양쪽에서 일관되게 안전하면 충분하다.
- 기존 테스트를 깨뜨리지 마라.
