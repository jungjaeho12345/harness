# Step 2: url-embed-dialog — URL 직접 임베드 입력 다이얼로그 컴포넌트

## 배경 / 요구사항

도구 메뉴 '그림 삽입'(`tools.insertImage`)·'유튜브 영상 삽입'(`tools.insertYoutube`)(news.md L180)은 검색패널(이미지=Google/영상=YouTube)과 달리 **URL을 직접 입력해** 본문에 임베드한다. 이 step은 그 **순수 표시/폼 다이얼로그** `web/src/view/UrlEmbedDialog.jsx`를 만든다(결선은 Step 3). phase17 `GlyphInputDialog.jsx`·phase14 `FindReplaceDialog.jsx`와 **동일한 떠있는 다이얼로그 패턴**(순수 표시, props 콜백 위임, `role="dialog"`, Esc 닫기)을 따른다.

**범위 한정(중요)**: 이미지·유튜브 **두 종류만** 다룬다. 오디오/로컬영상/링크 임베드는 `InlineEmbed.jsx`가 렌더하지 못하므로(빈 figure가 됨) 이 phase에서 **DEFER**한다(아래 금지사항). 이 다이얼로그는 임베드 종류를 prop(`kind: 'image' | 'video'`)으로 받아 라벨/placeholder만 달리하고, 실제 임베드 생성·삽입은 Step 3 WriterPage가 `make*Embed`/`insertEmbed`로 한다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003(순수 표시/폼, transport 비의존).
- `/docs/news.md` — L180(도구 메뉴 '그림 삽입'·'유튜브 영상 삽입'), L159~160(검색 결과 임베딩·크기 규칙 — 참고).
- `web/src/view/GlyphInputDialog.jsx` — **직접 템플릿**: `open` false→null, `role="dialog"`+`aria-label`, 전용 클래스(`yh-glyph-input`)·testid(`glyph-input`), Esc 닫기(`handleKeyDown`), 동작은 `onPick`/`onClose` 콜백 위임, 닫기 버튼(`glyph-input-close`). 이 패턴을 그대로 가져오되 입력 필드(URL `<input>`)와 '삽입' 버튼을 더한다.
- `web/src/view/GlyphInputDialog.test.jsx` — 다이얼로그 테스트 컨벤션(open 토글, 콜백 mock, Esc/닫기, 미전달 콜백 graceful).
- `web/src/view/FindReplaceDialog.jsx` — **참고**: 입력 필드가 있는 다이얼로그의 내부 폼 state(`useState`) + open 전환 시 초기화(`useEffect`) 패턴. URL 입력값을 내부 state로 들고 '삽입' 시 콜백에 넘긴다.
- `web/src/view/clipboardEmbed.js` — `parseYouTubeId(url)`(11자리 video id 추출, 아니면 null), `isAllowedImageSrc(src)`(https:/data:image/·상대경로만). **이 step에서 직접 import하지 않는다**(검증은 Step 3 결선에서) — 단, '유튜브가 아닌 URL'·'허용 안 되는 이미지 src'의 거부는 Step 3 책임임을 이해하고, 다이얼로그는 입력 UI만 담당함을 명확히 한다.
- `web/src/index.css`/`yonhap.css`(`yh-glyph-input`/`yh-find-replace` 스타일이 있는 CSS) — 다이얼로그 스타일 추가 위치.

## 작업

TDD로 진행한다(vitest). 먼저 `web/src/view/UrlEmbedDialog.test.jsx`를 작성하고, 통과하는 `web/src/view/UrlEmbedDialog.jsx`를 만든다.

### 컴포넌트 계약 (시그니처 수준)

```jsx
// URL 직접 임베드 입력 다이얼로그 — 순수 표시/폼(ADR-003).
// URL을 입력해 onSubmit(url)로 위임한다. 임베드 생성(make*Embed)·삽입·URL 검증은 부모(Step 3 WriterPage)가 한다.
// model/fetch/localStorage/window/document 호출 없음.
export function UrlEmbedDialog({
  open,
  kind,          // 'image' | 'video' — 라벨/placeholder/aria-label 결정(동작 분기는 부모)
  onSubmit,      // (url) => void — '삽입' 클릭 또는 Enter 시
  onClose,       // () => void
}) { ... }
```

요구사항:
- `open`이 false면 `null` 반환. `role="dialog"`, `aria-label`(`kind`별 — 예 '그림 삽입'/'유튜브 영상 삽입'), 전용 클래스(예 `yh-url-embed`)·전용 testid(예 `url-embed`). Esc로 `onClose`.
- URL `<input>`(전용 testid 예 `url-embed-input`, `aria-label`) + '삽입' 버튼(예 `url-embed-submit`) + '닫기' 버튼(예 `url-embed-close`). 입력값은 **내부 state**로 들고, '삽입' 클릭/Enter 시 `onSubmit(url)`(트림한 값)을 호출한다. `onSubmit`/`onClose` 미전달 시 가드.
- 빈 URL(트림 후 `''`)이면 '삽입'을 **no-op**(또는 버튼 disabled) — `onSubmit('')`을 부르지 않는다(부모가 빈 임베드를 만들지 않게). 동작을 주석으로 명시.
- `open`이 false→true로 바뀔 때 입력값을 초기화한다(`useEffect` — FindReplaceDialog 패턴). 재오픈 시 이전 URL이 남지 않게.
- `kind`별 placeholder/라벨만 다르다(예 image='이미지 URL(https://...)', video='유튜브 URL'). **검증 메시지/거부는 이 컴포넌트가 하지 않는다**(부모 책임) — 단, 부모가 거부했음을 표시할 수 있게 `error` prop(선택, 문자열)을 받아 있으면 노출하는 정도는 재량(과하면 생략).
- CSS: `yh-url-embed` 떠있는 패널 스타일 추가(`yh-glyph-input` 인근). 기존 스타일을 깨지 않는다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수 표시/폼(ADR-003)**: model/fetch/transport/localStorage/window/document 호출 금지. URL 입력값 외 상태 없음. 동작은 `onSubmit`/`onClose`로만 위임. 이유: 계층 분리.
2. **임베드 생성/검증 금지**: `make*Embed`/`parseYouTubeId`/`isAllowedImageSrc`를 호출하지 마라(import 금지). 블록/캐럿 계산 금지. `onSubmit(url)`만 부른다. 이유: Scope 최소화 — 생성·검증은 Step 3.
3. **전용 클래스/testid**: 약물입력(`yh-glyph-input`)·찾기(`yh-find-replace`)와 다른 전용 className/testid. 이유: 회귀·스타일 충돌 방지.
4. **이미지·유튜브만**: `kind`는 `'image'`/`'video'`만 가정한다. 오디오/로컬영상/링크 UI를 추가하지 마라. 이유: `InlineEmbed`가 렌더 못 하는 임베드는 DEFER.
5. **editorPrefs·clipboardEmbed 미import**: 데이터/검증 의존을 결선 레이어(Step 3)로 한정. 이유: 순수성.

## Acceptance Criteria

```bash
cd web && npm run test -- UrlEmbedDialog    # 신규 UrlEmbedDialog.test.jsx 통과
cd .. && npm run test:web                   # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `UrlEmbedDialog.test.jsx`):
- `open={false}`면 아무것도 렌더되지 않는다(null).
- `open` + `kind='image'`면 `role="dialog"`('그림 삽입')와 URL 입력·'삽입'·'닫기' 버튼이 보인다.
- URL 입력 후 '삽입' 클릭 시 `onSubmit`이 그 URL(트림)로 호출된다.
- URL 입력 후 Enter 시에도 `onSubmit`이 호출된다.
- 빈 URL(공백만)에서 '삽입'은 `onSubmit`을 호출하지 않는다(no-op 또는 disabled).
- `kind='video'`면 aria-label/placeholder가 유튜브용으로 바뀐다.
- Esc 또는 '닫기' 버튼으로 `onClose`가 호출된다.
- `open`이 false→true 재전환 시 입력값이 초기화된다(이전 URL 미잔존).
- `onSubmit`/`onClose` 미전달 시 클릭/Enter/Esc가 예외를 던지지 않는다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 순수 표시(transport/localStorage/검증 없음), make*Embed/parse 미import, 전용 클래스/testid, image/video만.
3. 결과에 따라 `phases/18-editor-tools-menu/index.json`의 step 2를 갱신(completed+summary / error / blocked).

## 금지사항

- `make*Embed`/`parseYouTubeId`/`isAllowedImageSrc`/`embedBlock`을 import하거나 호출하지 마라. 이유: 임베드 생성·URL 검증은 Step 3 결선 담당(Scope 최소화).
- 블록/캐럿/임베드 삽입 계산을 이 컴포넌트에 넣지 마라. 이유: Step 3 WriterPage 담당.
- 오디오/로컬영상/링크 입력 UI를 추가하지 마라. 이유: `InlineEmbed`가 렌더 못 하는 임베드 종류는 명시적 DEFER(별도 phase에서 InlineEmbed 확장과 함께).
- 약물입력/찾기와 같은 className/testid를 재사용하지 마라. 이유: 회귀·스타일 충돌.
- model/fetch/localStorage/window/document를 호출하지 마라. 이유: ADR-003 순수 표시/폼.
- `Editor.jsx`/`WriterPage.jsx`/`server/`를 수정하지 마라(이 step은 신규 컴포넌트+테스트+CSS만). 이유: 결선은 Step 3.
