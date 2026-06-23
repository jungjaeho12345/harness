# Step 3: url-embed-wiring — 그림/유튜브 URL 직접 삽입(tools.insertImage·tools.insertYoutube) 결선

## 배경 / 요구사항

도구 메뉴 '그림 삽입'(`tools.insertImage`)·'유튜브 영상 삽입'(`tools.insertYoutube`)(news.md L180)을 WriterPage에 결선한다. 클릭하면 Step 2 `UrlEmbedDialog`가 열리고, 사용자가 URL을 입력해 '삽입'하면 **기존 인프라**(`makeImageEmbed`/`makeVideoEmbed` + `insertEmbed`)로 캐럿 줄 뒤에 임베드가 삽입된다. **신규 임베드 메커니즘을 만들지 않는다** — 검색패널이 쓰는 그 경로를 그대로 재사용한다.

검색패널(이미지=Google/영상=YouTube)과 메뉴는 **경로만 다르다**(검색 vs URL 직접 입력) — 임베드 종류·삽입 경로·크기 규칙은 동일하다. 이미지·유튜브 **두 항목만** 결선한다(오디오/로컬영상/링크는 `InlineEmbed`가 렌더 못 하므로 DEFER).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003, DB 비파괴.
- `/docs/news.md` — L180(도구 메뉴), L159~160(임베딩·크기), L156(커서 위치 삽입).
- `web/src/view/UrlEmbedDialog.jsx` (**Step 2 생성**) — `UrlEmbedDialog({ open, kind, onSubmit, onClose })`.
- `web/src/view/WriterPage.jsx` — **결선 위치**. 특히:
  - `MENU_ENABLED`(L62) — `'tools.insertImage'`·`'tools.insertYoutube'` 추가.
  - `onMenuSelect(id)`(L271~303) — 매핑 가드 **뒤**(본문 변경)에 두 항목 분기 추가(다이얼로그 오픈). 약물입력(`tools.symbolInput`, L289)이 이미 같은 위치에 있으니 그 옆에 둔다.
  - `insertEmbed(embed)`(L418) / `insertEmbedAtLine(embed, caretLine)`(L406~415) — **재사용**. `embed`가 falsy면 no-op(makeVideoEmbed가 유튜브 아니면 null 반환)이라 안전. 매핑/캐럿 없음 시 끝("(끝)" 앞) append 폴백.
  - `makeImageEmbed`/`makeVideoEmbed`(import L35) — **재사용**. 검색패널 `onPick`(L577·585)이 쓰는 그 팩토리.
  - 검색패널 `onPick` 라인(L577 이미지, L585 영상) — `makeImageEmbed(src, {alt})`/`makeVideoEmbed(url, {title})` 호출 형태(인자 shape) 참고.
  - 약물입력 다이얼로그 배치(L623~629)·상태(`showGlyphInput` L98)·라우팅(L289) — **결선 템플릿**(다이얼로그 state + 메뉴 오픈 + 컴포넌트 배치).
  - `lastCaretRef`(L142)·`isMapping`(L136).
- `web/src/view/clipboardEmbed.js` — `makeImageEmbed`/`makeVideoEmbed`(유튜브 아니면 null)/`isAllowedImageSrc`(이미지 src 거부 시 makeImageEmbed는 만들지만 InlineEmbed가 렌더 거부). **검증 정책 이해용**.
- `web/src/view/WriterPage.test.jsx` — 결선 테스트 컨벤션. 특히 L546~651 '검색패널 임베드: 커서 줄 뒤 삽입' describe(`caretAtLine`/`focusCaretAtLine`/`spyEditorFocus`/임베드 figure 단언 `[data-embed-type]`), L1764~ 약물입력 결선 describe(메뉴/다이얼로그 오픈 패턴).

## 작업

TDD로 진행한다. 먼저 `WriterPage.test.jsx`에 `describe('WriterPage — URL 직접 임베드(tools.insertImage·tools.insertYoutube) 결선')`를 추가하고, 통과하도록 `WriterPage.jsx`를 결선한다.

### 결선 (시그니처 수준)

1. **import**: `import { UrlEmbedDialog } from './UrlEmbedDialog.jsx';`.
2. **상태**: 다이얼로그 표시 + 종류를 하나의 state로 든다(약물입력 `showGlyphInput` 패턴 확장):
   ```js
   // URL 직접 임베드 다이얼로그 — null(닫힘) | 'image' | 'video'. 도구>그림/유튜브 삽입으로 열린다.
   const [urlEmbedKind, setUrlEmbedKind] = useState(null);
   ```
3. **라우팅**(`onMenuSelect` — 임베드 변경은 매핑에서도 허용이므로 매핑 가드 `if (isMapping) return;` **앞**에 둔다. 검색패널 onPick에 매핑 가드가 없는 것과 동일 정책. 본문 텍스트를 바꾸는 약물입력/날짜는 매핑 가드 뒤에 있음에 유의):
   ```js
   if (id === 'tools.insertImage') { setUrlEmbedKind('image'); return; }
   if (id === 'tools.insertYoutube') { setUrlEmbedKind('video'); return; }
   ```
4. **제출 핸들러**(검색패널 onPick과 동일 팩토리·경로):
   ```js
   // URL 직접 입력 → 종류별 팩토리로 임베드 생성 → insertEmbed(검색패널과 동일 경로). 유튜브 아닌 URL은 makeVideoEmbed가 null → insertEmbed no-op.
   // 매핑 가드를 두지 않는다 — 검색패널 onPick(WriterPage.jsx:577·585)과 동일하게 매핑 모드에서도 임베드 삽입을 허용한다(텍스트가 아닌 임베드 변경이라 본문-only 불변식과 무관).
   //   insertEmbed→insertEmbedAtLine(L406-415)이 isMapping일 때 "(끝)" 앞 append 폴백으로 임베드를 실제 삽입하는 것이 의도된 동작이다(WriterPage.test.jsx:710-723이 못박음).
   const onUrlEmbedSubmit = (url) => {
     const embed = urlEmbedKind === 'image'
       ? makeImageEmbed(url, { alt: '' })
       : makeVideoEmbed(url, { title: '' });
     insertEmbed(embed);                                  // embed falsy면 no-op(insertEmbedAtLine가 가드). 매핑 시엔 "(끝)" 앞 append 폴백.
     setUrlEmbedKind(null);                               // 삽입 후 닫는다(약물입력과 달리 1회성 — URL 1개 삽입)
   };
   ```
5. **메뉴 활성화**: `MENU_ENABLED`에 `'tools.insertImage'`·`'tools.insertYoutube'` 추가.
6. **컴포넌트 배치**(GlyphInputDialog 옆):
   ```jsx
   <UrlEmbedDialog
     open={urlEmbedKind !== null}
     kind={urlEmbedKind || 'image'}
     onSubmit={onUrlEmbedSubmit}
     onClose={() => setUrlEmbedKind(null)}
   />
   ```

매핑 모드 정책(**확정** — 오케스트레이터 결정): `tools.insertImage`/`tools.insertYoutube`는 본문 **텍스트가 아닌 임베드** 변경이다. 매핑 불변식은 "텍스트 잠금·임베드만 변경 가능"이므로 그림/유튜브는 **매핑에서도 허용**한다 — 검색패널 onPick(`WriterPage.jsx:577·585`)이 매핑 가드 없이 `insertEmbedAtLine`(L406-415)의 "(끝)" 앞 append 폴백으로 임베드를 실제 삽입하는 것과 **동일 정책**이며, 그 동작은 `WriterPage.test.jsx:710-723`("매핑 모드에서 이미지 검색 결과 클릭 시 임베드 추가") 통과 테스트가 못박는다. 따라서 **추가 매핑 가드를 두지 말고 기존 `insertEmbed`/`insertEmbedAtLine`를 그대로 재사용**한다(코드 더 적음·단일 경로 일관). 메뉴 항목도 매핑에서 활성으로 둔다. — 단 **날짜 삽입(step1)은 본문 텍스트를 바꾸므로 매핑 비활성 유지**(약물입력과 동일). 두 트랙의 매핑 정책이 다른 이유: **임베드 변경(insertImage/insertYoutube)은 매핑 허용, 텍스트 변경(insertDate)은 매핑 차단.**

### 테스트

- 캐럿을 줄에 둔 뒤(`focusCaretAtLine`) 도구>'그림 삽입' 클릭 → 다이얼로그 오픈 → 유효 https URL 입력 → '삽입' → `[data-embed-type="image"]` figure가 캐럿 줄 뒤에 생긴다.
- 도구>'유튜브 영상 삽입' → 유효 유튜브 URL 입력 → '삽입' → `[data-embed-type="video"]` figure가 생긴다.
- 유튜브가 **아닌** URL을 '유튜브 영상 삽입'에 넣으면 임베드가 생기지 않는다(makeVideoEmbed null → no-op, 크래시 없음). 다이얼로그는 닫힌다(또는 제품 결정대로 — error 표시 시 그에 맞춰).
- 매핑 모드(`mode:'mapping'`)에서도 두 항목은 **활성**이고, 그림/유튜브 URL 삽입 시 임베드가 본문에 추가된다(검색패널과 동일 — `WriterPage.test.jsx:710-723` 패턴의 "(끝)" 앞 append).
- `tools.insertImage`/`tools.insertYoutube`가 활성(`disabled` 아님)이고, 다른 비결선 도구(예: `tools.insertAudio`)는 비활성 유지(회귀 없음).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **신규 임베드 메커니즘 금지**: `makeImageEmbed`/`makeVideoEmbed` + `insertEmbed`(기존)만 쓴다. 새 팩토리·새 삽입 경로·`embedBlock` 직접 호출 금지. 이유: 검색패널과 단일 경로 유지(크기 규칙·"(끝)" 정규화 일관).
2. **Editor.jsx 미접촉·`<Editor>` 신규 prop 금지**: 임베드 삽입은 `insertEmbed`(→ `updateField('body', ...)` + `setPendingCaretLine`) 안전 경로만. contentEditable/DOM 직접 조작 금지. 이유: 과거 BLOCKER.
3. **기존 메뉴 id 재사용**: `tools.insertImage`/`tools.insertYoutube` id/라벨 그대로. 새 id·라벨 매칭 금지. 이유: 과거 BLOCKER.
4. **이미지·유튜브만**: `tools.insertLink`/`tools.insertAudio`/`tools.insertLocalVideo`는 결선하지 마라(비활성 유지). 이유: `InlineEmbed`가 렌더 못 함 → DEFER.
5. **매핑에서 임베드 삽입 허용(검색패널과 일치)**: 두 항목에 매핑 비활성 가드를 두지 마라 — 기존 `insertEmbed`/`insertEmbedAtLine`를 그대로 재사용하면 매핑 시 "(끝)" 앞 append 폴백으로 임베드가 삽입된다(검색패널 onPick `WriterPage.jsx:577·585`과 동일, `WriterPage.test.jsx:710-723`이 못박은 의도된 동작). 이유: 매핑 불변식 = 텍스트 잠금·임베드만 변경 가능 → 임베드 변경은 일관적으로 허용. (텍스트를 바꾸는 날짜 삽입(step1)만 매핑 차단 — 약물입력과 동일.)
6. **URL 검증은 팩토리/렌더에 위임**: 유튜브 아닌 URL은 `makeVideoEmbed`가 null(→ no-op), 허용 안 되는 이미지 src는 `InlineEmbed`/`isAllowedImageSrc`가 렌더 거부. 별도 검증 코드를 WriterPage에 중복 작성하지 마라. 이유: 단일 출처 검증(clipboardEmbed)·중복 금지.
7. **server 미접촉·editorPrefs 무관**: client 전용. 이유: DB 비파괴.

## Acceptance Criteria

```bash
cd web && npm run test -- WriterPage    # 신규 'URL 직접 임베드 결선' describe 통과
cd .. && npm run test:web               # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx`) — 위 '테스트' 항목을 단언으로:
- 도구>'그림 삽입' → URL 입력 → '삽입' 시 `[data-embed-type="image"]`가 생긴다.
- 도구>'유튜브 영상 삽입' → 유튜브 URL 입력 → '삽입' 시 `[data-embed-type="video"]`가 생긴다.
- 유튜브 아닌 URL 입력 시 video 임베드가 생기지 않고 크래시하지 않는다.
- 매핑 모드(`mode:'mapping'`)에서 그림/유튜브 메뉴로 URL 임베드 삽입 시 임베드가 본문에 추가된다(검색패널과 동일, `WriterPage.test.jsx:710-723` 패턴). 즉 매핑에서 비활성이 **아니다**.
- `tools.insertImage`/`tools.insertYoutube`는 활성, `tools.insertAudio`는 비활성(회귀 없음).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 기존 make*Embed/insertEmbed 재사용(신규 메커니즘 없음), Editor.jsx/`<Editor>` prop 무변경, 기존 id 재사용, image/video만 결선, 매핑에서 임베드 삽입 허용(검색패널과 일치 — 추가 매핑 가드 없음), server 무변경.
3. 결과에 따라 `phases/18-editor-tools-menu/index.json`의 step 3을 갱신(completed+summary / error / blocked).

## 금지사항

- 새 임베드 팩토리/삽입 경로를 만들거나 `embedBlock`을 직접 호출하지 마라. 이유: 검색패널과 단일 경로(크기·정규화 일관) — 중복 금지.
- `tools.insertLink`/`tools.insertAudio`/`tools.insertLocalVideo`를 결선하지 마라. 이유: `InlineEmbed`가 렌더 못 하는 임베드 종류는 DEFER(별도 phase에서 InlineEmbed 확장 동반).
- `Editor.jsx`를 수정하거나 `<Editor>`에 새 prop을 넘기지 마라. 이유: 안전 경로만(과거 BLOCKER).
- 그림/유튜브 삽입에 매핑 비활성 가드(`if (isMapping) return;`/메뉴 비활성)를 추가하지 마라. 이유: 검색패널 onPick은 매핑 가드가 없고 매핑은 임베드 변경을 허용한다(`WriterPage.test.jsx:710-723`) — 가드를 넣으면 검색패널과 불일치하고 코드만 늘어난다. (텍스트를 바꾸는 날짜 삽입(step1)에만 매핑 가드를 둔다.)
- URL 유효성 검사를 WriterPage에 새로 작성하지 마라(makeVideoEmbed/isAllowedImageSrc에 위임). 이유: 검증 단일 출처·중복 금지.
- `server/`를 건드리지 마라. 이유: DB 비파괴·client 전용 phase.
