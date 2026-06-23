# Step 2: tools-menu-wiring — 도구 메뉴 오디오/링크/로컬영상 결선(WriterPage)

## 배경 / 요구사항

step0(렌더+검증)·step1(팩토리+다이얼로그 kind)로 오디오/링크/로컬영상 임베드의 **렌더·생성·입력 UI**가 모두 준비됐다. 이 step(step2)은 마지막으로 도구 메뉴 항목 **'오디오 삽입'(`tools.insertAudio`)·'링크 삽입'(`tools.insertLink`)·'로컬영상 삽입'(`tools.insertLocalVideo`)**(news.md L180)을 `WriterPage.jsx`에서 결선한다 — phase18이 `tools.insertImage`/`tools.insertYoutube`를 결선한 **것과 동일한 패턴**(메뉴 클릭 → `UrlEmbedDialog` 오픈 → URL 제출 시 팩토리+`insertEmbed`)을 그대로 확장한다.

**신규 메커니즘이 없다** — 기존 `urlEmbedKind` state·`onUrlEmbedSubmit`·`insertEmbed` 안전 경로·`<UrlEmbedDialog>` 배치를 audio/link/localVideo로 넓히기만 한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`(ADR-003·ADR-004 — 결선은 view, transport 직접 호출 금지).
- `/docs/news.md` — L180(도구 메뉴 오디오/링크/로컬영상), L159~160(임베딩 — 커서 위치 삽입·결과 유지).
- **step0·step1 산출물**(이 step의 전제):
  - `web/src/view/clipboardEmbed.js` — step1이 추가한 `makeAudioEmbed(src,{title})`·`makeLinkEmbed(href,{title})`·`makeLocalVideoEmbed(src,{title})`(빈 입력 시 null 폴백 정책 포함). 기존 `makeImageEmbed`/`makeVideoEmbed`.
  - `web/src/view/UrlEmbedDialog.jsx` — step1이 추가한 `KIND_META`에 `audio`/`link`/`localVideo` 라벨.
  - `web/src/view/InlineEmbed.jsx`·`articleDetail.js` — step0이 추가한 렌더 분기(결선이 만든 임베드가 양쪽에서 렌더됨 — 이 step에서 수정하지 않음).
- `web/src/view/WriterPage.jsx` — **결선 대상**. phase18 임베드 결선부를 정확히 확장한다:
  - L38: `import { makeImageEmbed, makeVideoEmbed, makeArticleEmbed } from './clipboardEmbed.js';` — `makeAudioEmbed`/`makeLinkEmbed`/`makeLocalVideoEmbed` 추가.
  - L65: `MENU_ENABLED` 배열(현재 `tools.insertImage`/`tools.insertYoutube` 포함) — `tools.insertAudio`/`tools.insertLink`/`tools.insertLocalVideo` 추가.
  - L103: `const [urlEmbedKind, setUrlEmbedKind] = useState(null);` — kind 값에 `'audio'`/`'link'`/`'localVideo'`도 들어갈 수 있음(state 변경 불필요, 값 도메인만 확장).
  - L289 `onMenuSelect`: L294~295가 `tools.insertImage`→`setUrlEmbedKind('image')`, `tools.insertYoutube`→`setUrlEmbedKind('video')`를 **매핑 가드 앞**에서 라우팅. 여기에 세 항목 라우팅 추가(동일 위치 — 임베드는 매핑에서도 허용).
  - L450 `onUrlEmbedSubmit(url)`: 현재 `urlEmbedKind === 'image' ? makeImageEmbed(url,{alt:''}) : makeVideoEmbed(url,{title:''})` → `insertEmbed(embed)` → `setUrlEmbedKind(null)`. **이 분기를 audio/link/localVideo로 확장**한다.
  - L442 `insertEmbed`·L430 `insertEmbedAtLine` — **기존 안전 삽입 경로**(검색패널·그림/유튜브와 공유). 신규 삽입 경로를 만들지 마라.
  - L668 `<UrlEmbedDialog open={urlEmbedKind !== null} kind={urlEmbedKind || 'image'} ...>` — 배치·open 조건 그대로(kind 값만 넓어짐).
- `web/src/view/EditorMenuBar.jsx` — `tools.insertLink`(L93)·`tools.insertLocalVideo`(L95)·`tools.insertAudio`(L96) id **실존 확인**. **이 id를 그대로 쓴다**(새 id·라벨 매칭 금지 — phase18 BLOCKER 전력).
- `web/src/view/WriterPage.test.jsx` — phase18 'URL 직접 임베드 결선' describe(메뉴 활성/오디오-당시-비활성·다이얼로그 오픈·image/video 삽입·비유튜브 no-op·본문 텍스트 불변·매핑 허용·닫기 시 미삽입). **이 컨벤션으로 audio/link/localVideo 테스트를 추가**한다(phase18 테스트가 '오디오는 아직 비활성'을 단언했다면 그 단언을 이번에 '활성'으로 갱신).

## 작업

TDD로 진행한다(vitest, `@testing-library/react` + `fakeModel`). 먼저 `WriterPage.test.jsx`에 audio/link/localVideo 결선 테스트를 추가하고, 통과하도록 `WriterPage.jsx`를 확장한다.

### 결선 (WriterPage.jsx)

1. **import 확장**(L38): `makeAudioEmbed`/`makeLinkEmbed`/`makeLocalVideoEmbed` 추가.
2. **MENU_ENABLED 확장**(L65): `'tools.insertAudio'`, `'tools.insertLink'`, `'tools.insertLocalVideo'` 추가(EditorMenuBar id 그대로).
3. **onMenuSelect 라우팅**(L294 인근, 매핑 가드 **앞**): phase18의 image/youtube 분기 옆에 세 줄 추가:
   ```js
   if (id === 'tools.insertAudio') { setUrlEmbedKind('audio'); return; }
   if (id === 'tools.insertLink') { setUrlEmbedKind('link'); return; }
   if (id === 'tools.insertLocalVideo') { setUrlEmbedKind('localVideo'); return; }
   ```
   매핑 가드 앞에 두는 이유: 임베드 삽입은 매핑 모드에서도 허용(검색패널 `onPick`·그림/유튜브와 동일 정책 — `insertEmbed`→`insertEmbedAtLine`이 매핑 시 "(끝)" 앞 append 폴백).
4. **onUrlEmbedSubmit 분기 확장**(L450): `urlEmbedKind`별 팩토리 선택을 audio/link/localVideo로 넓힌다. 시그니처(예):
   ```js
   const onUrlEmbedSubmit = (url) => {
     let embed = null;
     if (urlEmbedKind === 'image') embed = makeImageEmbed(url, { alt: '' });
     else if (urlEmbedKind === 'video') embed = makeVideoEmbed(url, { title: '' });
     else if (urlEmbedKind === 'audio') embed = makeAudioEmbed(url, { title: '' });
     else if (urlEmbedKind === 'localVideo') embed = makeLocalVideoEmbed(url, { title: '' });
     else if (urlEmbedKind === 'link') embed = makeLinkEmbed(url, { title: '' });
     insertEmbed(embed);        // embed falsy면 no-op(insertEmbedAtLine의 !embed 가드). 매핑 시 "(끝)" 앞 append.
     setUrlEmbedKind(null);     // 1회성 삽입 후 닫는다.
   };
   ```
   `if/else` 사슬이 과하면 `urlEmbedKind`→팩토리 매핑 객체(`{ image: ..., audio: ... }`)로 단순화해도 된다(재량). **단 기존 image/video 동작을 깨지 마라.**
5. **`<UrlEmbedDialog>` 배치**(L668): 변경 불필요(`open={urlEmbedKind !== null}`, `kind={urlEmbedKind || 'image'}`가 새 kind를 그대로 통과).

### 절대 하지 말 것(이 step 범위 밖)

- **URL 검증을 WriterPage에 추가하지 마라**. 검증은 step0 렌더 단일 출처(`InlineEmbed`/`articleDetail`이 `isAllowedMediaSrc`/`isAllowedHref` 적용). WriterPage는 팩토리로 임베드를 만들고 `insertEmbed`만 한다 — 악성 URL은 렌더 시점에 거부된다(phase18 그림/유튜브와 동일 — WriterPage 검증 중복 금지).
- 비결선 메뉴 항목(약어변환·사진발행 등)·툴바·표 메뉴를 활성화하지 마라(회귀).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **기존 메뉴 id 재사용**: `tools.insertAudio`/`tools.insertLink`/`tools.insertLocalVideo`(EditorMenuBar 실존) 그대로 쓴다. 새 id·라벨 매칭 금지. 이유: phase18에서 새 id 매칭으로 결선이 깨진 BLOCKER 전력.
2. **안전 삽입 경로만**: 임베드 삽입은 기존 `insertEmbed`/`insertEmbedAtLine`만 쓴다. 신규 삽입 메커니즘·`updateField('body', ...)` 직접 조작·DOM 직접 조작 금지. 이유: "(끝)"/임베드 순서·커서 보존 불변식이 안전 경로에 묶여 있다.
3. **URL 검증 미중복**: WriterPage에 `isAllowedMediaSrc`/`isAllowedHref`/스킴 검사를 추가하지 마라. 검증은 렌더 단일 출처(step0). 이유: 갈라지면 한쪽만 막혀 발행 시 우회(phase18 규칙).
4. **매핑 정책 = 허용**: 세 항목 라우팅을 매핑 가드 **앞**에 둔다(임베드는 매핑에서도 허용 — 검색패널·그림/유튜브 parity). 이유: 일관성 — 매핑 모드는 임베드 추가/삭제 허용(본문 텍스트만 잠금).
5. **Editor.jsx 미접촉·`<Editor>` prop 금지**: 결선은 WriterPage state·핸들러·`UrlEmbedDialog` 배치만. `Editor.jsx`/`<Editor>` 신규 prop 금지. 이유: 에디터 입력/키 경로 변경은 회귀 위험.
6. **server/·DB·editorPrefs(쓰기) 미접촉**: client 전용 결선·DB 비파괴·`editorPrefs` 읽기전용. 이유: 이 phase는 제작 시스템 client 렌더/결선만.
7. **기존 결선 보존**: phase18 image/youtube·날짜·찾기·약물입력 결선과 비결선 항목 비활성을 깨지 마라. 가산만. 이유: 회귀 방지.

## Acceptance Criteria

```bash
cd web && npm run test -- WriterPage     # 신규 audio/link/localVideo 결선 단언 통과
cd .. && npm run test:web                 # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx`):
- 도구 메뉴에서 '오디오 삽입'·'링크 삽입'·'로컬영상 삽입'이 **활성**이다(phase18에서 비활성이던 단언을 활성으로 갱신).
- '오디오 삽입' 클릭 시 `UrlEmbedDialog`가 `kind='audio'`(aria-label '오디오 삽입')로 열린다. '링크 삽입'→'링크 삽입', '로컬영상 삽입'→'로컬영상 삽입' 동형.
- 다이얼로그에 허용 https URL 입력 후 '삽입' → 본문 블록에 해당 `embedType`(`audio`/`link`/`localVideo`) 임베드가 추가된다(`useWriteController`/fakeModel의 body 직렬화 또는 렌더된 임베드로 확인).
- **악성 URL 거부 단언(필수)**: `javascript:alert(1)`을 오디오/링크 URL로 제출해 임베드가 본문에 추가되더라도, 렌더 경로(`InlineEmbed`)에서 `<audio>`/`<a href>`가 **렌더되지 않는다**(검증 단일 출처 회귀 — step0 보안 단언이 결선 후에도 유효함을 WriterPage 레벨에서 확인). *또는* WriterPage 테스트에서 직접 렌더를 검사하기 어려우면 step0의 InlineEmbed 보안 단언으로 커버하고, WriterPage 테스트는 '검증을 WriterPage가 하지 않음'(악성 URL도 onUrlEmbedSubmit이 예외 없이 처리)만 단언한다 — 채택 방식을 주석에 명시.
- 본문 **텍스트**(blocksToText)는 임베드 삽입으로 바뀌지 않는다(임베드는 블록만 추가, 텍스트 불변).
- 매핑 모드에서도 세 항목으로 임베드를 추가할 수 있다("(끝)" 앞 append — 그림/유튜브와 동일).
- 다이얼로그를 '닫기'/Esc로 닫으면 임베드가 추가되지 않는다(미제출 no-op).
- 비유튜브 URL이 `tools.insertYoutube`로 들어가면 여전히 no-op(phase18 회귀 green).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트:
   - `tools.insertAudio`/`insertLink`/`insertLocalVideo` 메뉴 활성·다이얼로그 오픈·삽입 동작.
   - WriterPage에 URL 검증 로직 없음(`grep`으로 `isAllowedMediaSrc`/`isAllowedHref`/스킴 정규식이 WriterPage에 없음 확인 — 검증은 렌더 단일 출처).
   - 삽입은 `insertEmbed`/`insertEmbedAtLine` 경유(신규 삽입 메커니즘 없음).
   - `Editor.jsx`/`<Editor>` prop/`server/`/DB 무변경.
   - 비결선 메뉴·툴바·표 메뉴 여전히 비활성(회귀).
3. 결과에 따라 `phases/19-editor-embed-types/index.json`의 step 2를 갱신(completed+summary / error / blocked). phase 전체가 끝났으면 상위 `phases/index.json`의 phase19 status를 갱신한다.

## 금지사항

- `tools.insertAudio`/`insertLink`/`insertLocalVideo` 외 새 메뉴 id·라벨 매칭으로 결선하지 마라. 이유: phase18 BLOCKER 전력(새 id 매칭이 결선을 깼다).
- URL 검증(`isAllowedMediaSrc`/`isAllowedHref`/스킴 검사)을 WriterPage에 추가하지 마라. 이유: 검증 단일 출처는 렌더(step0) — 중복 시 우회 위험.
- 신규 삽입 메커니즘·`updateField('body', ...)` 직접 조작·`document`/DOM 직접 조작으로 임베드를 넣지 마라. 이유: "(끝)"/순서/커서 불변식은 `insertEmbed`/`insertEmbedAtLine`에 묶여 있다.
- 세 항목 라우팅을 매핑 가드 뒤에 두지 마라(매핑에서 임베드가 막힌다). 이유: 검색패널·그림/유튜브와 일관 — 임베드는 매핑 허용.
- `Editor.jsx`를 수정하거나 `<Editor>`에 prop을 추가하지 마라. 이유: 에디터 입력/키 경로 회귀 위험.
- `server/`·DB·`editorPrefs`(쓰기)를 건드리지 마라. 이유: client 전용 결선·DB 비파괴.
- 비결선 메뉴/툴바/표 메뉴를 활성화하지 마라. 이유: 미구현 액션 노출 회귀.
- phase18 image/youtube·날짜·찾기·약물입력 결선을 변경하지 마라(가산만). 이유: 회귀.
