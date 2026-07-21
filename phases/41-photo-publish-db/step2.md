# Step 2: register-dialog — 사진 등록 다이얼로그 + 도구 메뉴 결선

## 배경 / 요구사항

step0(백엔드 등록 API)·step1(계약 `publishPhoto`)이 준비됐다. 이 step은 에디터에서 사진을 등록하는 UI를 결선한다:

- 도구>사진발행/DB등록(`tools.publishPhoto`)을 누르면 **등록 다이얼로그**가 열린다.
- 다이얼로그는 **현재 기사 본문의 이미지 임베드 목록**을 보여주고, 사용자가 하나를 골라 **캡션을 입력**해 등록한다.
- 등록은 `model.publishPhoto({ src, caption, sourceArticleId })`를 호출한다.

**이 step은 등록 경로만** 다룬다(다이얼로그 + 도구 메뉴 결선 + 회귀 가드 교체). 검색 패널의 '사진DB' 소스(재임베드)는 step3이 담당한다.

### 확정된 설계 결정 (그대로 구현)

- **다이얼로그는 순수 컴포넌트**(ADR-003) — props 주입, transport/model 비의존. WriterPage가 model을 호출한다(FileInfoDialog·MemoDialog·SimpTradConvertDialog와 동형).
- **매핑 모드 정책: 매핑 가드 앞(매핑에서도 열림).** 등록은 **본문/캐럿/임베드를 변경하지 않는다** — 현재 본문의 이미지 임베드를 *읽어서* 사진DB에 *쓰는* 액션이다(본문 무변경). 그래서 `tools.fileInfo`(본문 통계 읽기)·`tools.historyCompare`(이력 읽기)와 같은 부류로 `if (isMapping) return;` **앞**에 둔다(매핑 모드 죽은 버튼 방지). 근거: 본문-only 불변식과 무관(본문을 안 바꾼다).
- **다이얼로그 상태는 boolean 토글**(`showFileInfo` 패턴). imageEmbeds/sourceArticleId는 렌더 시점에 현재 활성 탭에서 파생한다. **탭 전환 시 닫는다**(imageEmbeds가 탭-로컬이라 열린 채 전환하면 이전 탭 이미지가 보임 — phase 29~32 계열 문서-로컬 좌표 이월 방지).
- **`sourceArticleId`는 best-effort 출처**: `activeTab.articleId || ''`(미저장 신규 기사면 빈 문자열). 등록을 막지 않는다.
- **캡션은 XSS 안전**: 다이얼로그는 캡션을 JSX 텍스트/input value로만 다룬다(자동 이스케이프). 등록된 캡션은 step3 재임베드에서 이미지 alt가 되고, 상세보기(articleDetail `embedHtml`)는 이미 alt를 `escapeHtml`로 넣으므로 발행 HTML까지 안전하다(렌더 경로 무변경 — 이 step은 렌더를 건드리지 않는다).

## 읽어야 할 파일

먼저 아래를 읽고 순수 다이얼로그 컴포넌트 규약·도구 메뉴 결선·매핑 가드·탭 전환 조정 패턴을 파악하라:

- `/docs/ADR.md` — ADR-003(순수 컴포넌트·props 주입·transport 비의존), ADR-004(신원은 세션).
- `/docs/UI_GUIDE.md` — 다이얼로그/버튼/입력 디자인 토큰(yh-btn·yh-field·명조/고딕·블루 기조).
- `/docs/news.md` L186(도구 '사진발행/DB등록'), L165(검색 결과 임베딩).
- **step1 산출물**: `web/src/model/contract.js`의 `publishPhoto`, `web/src/model/httpModel.js`/`fakeModel.js`의 `publishPhoto`(응답 `{ ok, id }`). 등록 호출은 `model.publishPhoto({ src, caption, sourceArticleId })`.
- `web/src/view/FileInfoDialog.jsx` — **다이얼로그 템플릿**: 순수·읽기전용·props(stats)만·`useFocusOnOpen`·Esc/닫기 `onClose`·`yh-editor-dialog` 공용 클래스(PR#60 규약). MemoDialog/AbbrevManageDialog/SimpTradConvertDialog도 형제.
- `web/src/view/useFocusOnOpen.js` — 다이얼로그 오픈 시 포커스 훅(기존 다이얼로그가 쓰는 접근성 패턴).
- `web/src/view/MemoDialog.jsx` — 입력(텍스트) + 버튼(저장/닫기)이 있는 다이얼로그 형태(FileInfo 읽기전용과 달리 입력이 있는 형제 — 등록 다이얼로그는 선택+입력+제출이라 이쪽이 더 가깝다).
- `web/src/view/EditorMenuBar.jsx` — `tools.publishPhoto` 항목(L97, label '사진발행/DB등록')과 `enabledIds`(활성 항목만 클릭 → onSelect 위임, 나머지는 disabled placeholder).
- `web/src/view/WriterPage.jsx` — **핵심 결선 지점**:
  - `MENU_ENABLED` 배열(L106~107) — 결선된 메뉴 id 목록. `'tools.publishPhoto'`를 추가한다.
  - 탭 전환 조정 블록(L259~275) — `if (caretTabId !== activeTabId) { ... setMetaDialog(null); ... }`. 여기에 다이얼로그 닫기(`setShowPhotoPublish(false)`)를 추가한다.
  - `body`/`blocks`(L249~250, `const blocks = deserialize(body)`) — 현재 본문 블록. 이미지 임베드 목록은 여기서 파생한다(`isEmbedBlock` + `embedType==='image'`).
  - 다이얼로그 상태 선언부(L145~200, `showFileInfo`/`showMemo` 등 boolean 토글) — `showPhotoPublish` 상태를 추가한다.
  - `onMenuSelect`(L718~) — 매핑 가드(`if (isMapping) return;`, **L793**) 앞에 있는 형제 항목: `tools.fileInfo`(L730)·`tools.memo`(L732)·`tools.historyCompare`(L736). `tools.publishPhoto` 분기를 **이들 근처(가드 앞)** 에 추가한다.
  - 다이얼로그 렌더부(L1457~1600, `<FileInfoDialog .../>` 등) — `<PhotoPublishDialog .../>`를 추가한다.
  - `insertEmbed`/`insertEmbedAtLine`(L1078~1090) — **이 step에서는 호출하지 않는다**(등록은 본문 무변경). 참고용.
- `web/src/view/editorContent.js` — `deserialize`·`isEmbedBlock`(L32~34)·`embedBlock`. 이미지 임베드 판정은 `isEmbedBlock(b) && b.embedType === 'image'`.
- `web/src/view/clipboardEmbed.js` — 이미지 임베드 필드(`makeImageEmbed`가 만든 블록: `{ embedType:'image', src, alt, ... }`, L77~88). 다이얼로그가 읽을 필드는 `src`·`alt`.
- `web/src/view/WriterPage.test.jsx` — **회귀 가드 스윕 대상**(아래 작업 §4). 현재 `tools.publishPhoto`(사진발행/DB등록)를 "미결선 예시"로 **비활성 단언**하는 곳이 여럿(테스트명·주석·`toBeDisabled()`). 결선하면 그 단언이 깨진다.
- `web/src/view/FileInfoDialog.test.jsx`/`MemoDialog.test.jsx` — 다이얼로그 컴포넌트 테스트 컨벤션(props 주입·onSubmit/onClose 위임·Esc 단언).

이전 step(step1)의 계약과 이 파일들의 설계 의도를 이해한 뒤 작업하라.

## 작업

TDD로 진행한다(`vitest`). **테스트를 먼저** 작성하고 통과하는 구현을 만든다.

### 1. 등록 다이얼로그 — `web/src/view/PhotoPublishDialog.jsx` (신규)
순수 컴포넌트(model/fetch 없음). props:
- `open` (boolean) — 닫힘이면 `null` 반환(다른 다이얼로그와 동형).
- `imageEmbeds` (array) — `[{ src, alt }]`. 현재 본문의 이미지 임베드 목록(부모가 파생).
- `onSubmit` (fn) — `({ src, caption }) => void`. 선택한 이미지의 src + 입력 캡션으로 위임.
- `onClose` (fn) — 닫기/Esc/취소.

UI 계약(구현은 재량, 아래 골격 준수):
- `yh-editor-dialog` 공용 클래스 + 전용 클래스(예: `yh-photo-publish`). `useFocusOnOpen`으로 열 때 포커스.
- 이미지 목록을 선택 가능하게 렌더(라디오 또는 클릭형 썸네일). 각 항목은 `<img src={embed.src} ...>` 썸네일 + 선택 표시. **초기 선택은 첫 항목**(있으면).
- 캡션 `<input>`(라벨 '캡션', placeholder 안내). 캡션은 value로만 다룬다(자동 이스케이프).
- '등록' 버튼 → 선택된 이미지 src + 캡션으로 `onSubmit({ src, caption })`. **선택된 이미지가 없으면 등록 버튼 비활성**(또는 no-op).
- '취소'/Esc → `onClose`.
- **빈 상태**: `imageEmbeds`가 비면 "본문에 등록할 이미지가 없습니다. 이미지를 먼저 삽입하세요." 안내 + 등록 버튼 없음/비활성(에디터에 이미지가 없으면 등록 불가).
- transport/model을 import하지 않는다(순수).

### 2. 도구 메뉴 결선 — `web/src/view/WriterPage.jsx`
- `import { PhotoPublishDialog } from './PhotoPublishDialog.jsx';`
- 상태 추가(다이얼로그 boolean 토글, `showFileInfo` 옆): `const [showPhotoPublish, setShowPhotoPublish] = useState(false);`
- `MENU_ENABLED` 배열에 `'tools.publishPhoto'`를 추가한다(도구 형제 항목들 사이).
- `onMenuSelect`에서 **매핑 가드(`if (isMapping) return;`) 앞**에 분기 추가(fileInfo/memo/historyCompare 근처):
  ```js
  // 사진발행/DB등록 — 현재 본문 이미지 임베드를 읽어 캡션과 함께 사진DB에 등록(본문/캐럿/임베드 무변경).
  // 매핑 가드 앞(본문 무관 읽기+외부 쓰기 → 매핑에서도 열림, tools.fileInfo와 동일 정책).
  if (id === 'tools.publishPhoto') { setShowPhotoPublish(true); return; }
  ```
- 탭 전환 조정 블록(L259~275)에 닫기 추가:
  ```js
  // 등록 다이얼로그의 imageEmbeds/sourceArticleId는 활성 탭-로컬 — 열린 채 전환하면 이전 탭 이미지가
  // 보이고 '등록'이 엉뚱한 기사 사진을 올린다(phase 29~32 문서-로컬 좌표 이월 계열). 함께 닫는다.
  setShowPhotoPublish(false);
  ```
- 다이얼로그 렌더부에 추가(FileInfoDialog 옆):
  ```jsx
  <PhotoPublishDialog
    open={showPhotoPublish}
    imageEmbeds={blocks.filter((b) => isEmbedBlock(b) && b.embedType === 'image').map((b) => ({ src: b.src, alt: b.alt ?? '' }))}
    onSubmit={async ({ src, caption }) => {
      const r = await model.publishPhoto({ src, caption, sourceArticleId: activeTab.articleId || '' });
      window.alert(r && r.ok ? '사진을 DB에 등록했습니다.' : '사진 등록에 실패했습니다.');
      setShowPhotoPublish(false);
    }}
    onClose={() => setShowPhotoPublish(false)}
  />
  ```
  - `isEmbedBlock`가 WriterPage에 아직 import 안 돼 있으면 `editorContent.js`에서 import한다(이미 `deserialize` 등을 쓰므로 같은 모듈).
  - 등록은 `blocks`(현재 본문)를 **읽기만** 한다 — `commitBody`/`updateField`/`insertEmbed`/`serialize`를 **호출하지 않는다**(본문 무변경).
  - 실패 응답(`!r.ok`, 예: invalid-src)은 alert로만 안내한다(다른 실패 정책과 동형).

### 3. 다이얼로그 컴포넌트 테스트 — `web/src/view/PhotoPublishDialog.test.jsx` (신규)
- `open=false`면 아무것도 렌더 안 함.
- `imageEmbeds`를 주면 썸네일 목록이 렌더되고 첫 항목이 기본 선택됨.
- 이미지 선택 + 캡션 입력 후 '등록' → `onSubmit({ src, caption })`이 선택 src·입력 캡션으로 호출됨.
- '취소'/Esc → `onClose` 호출(`onSubmit` 미호출).
- `imageEmbeds`가 비면 빈 상태 안내가 뜨고 등록이 불가함.
- onSubmit/onClose 미전달 시 상호작용이 예외를 던지지 않음(방어적 — 형제 다이얼로그 컨벤션).

### 4. WriterPage 결선 + 회귀 가드 스윕 — `web/src/view/WriterPage.test.jsx`
**(A) 신규 결선 테스트(양성 커버리지):**
- 도구 메뉴에서 '사진발행/DB등록' 항목이 이제 **활성(enabled)** 임을 단언.
- 클릭하면 등록 다이얼로그가 열리고, 본문에 이미지 임베드가 있으면 목록에 나타남.
- 이미지 선택 + 캡션 입력 + 등록 → `model.publishPhoto`가 `{ src, caption, sourceArticleId }`로 호출됨(fakeModel spy 또는 등록 후 fake 검색으로 확인). `sourceArticleId`가 현재 편집 기사아이디(편집 탭)임을 단언.
- 등록이 **본문을 바꾸지 않음**을 단언(등록 전후 `blocks`/body 동일 — 읽기 액션).
- (선택) 매핑 탭에서도 '사진발행/DB등록'이 활성이고 다이얼로그가 열림을 단언(매핑 가드 앞 정책).

**(B) 미결선 예시 교체(가드 유지 — 약화 금지):**
현재 이 테스트 파일은 `tools.publishPhoto`(사진발행/DB등록)를 "여전히 비활성인 미결선 예시"로 쓴다. 결선했으므로 그 단언은 깨진다. **각 지점을 남은 미결선 항목 `tools.uiLanguage`('UI 언어 설정')로 교체**한다(p21/p34 선례 — 단언을 약화하지 말고 아직 미결선인 항목으로 옮긴다).
- **먼저 grep으로 전수한다**: `web/src/view/WriterPage.test.jsx`에서 `사진발행/DB등록` 과 `publishPhoto` 를 모두 찾는다(현재 대략 L1420·1431·2580·2589·3927·3933·3990·4650·4655·4811·4815 — 테스트명/주석/단언 쌍. 실행 시점 줄번호는 다를 수 있으니 문자열로 찾는다).
- 각 지점에서:
  - `getByText('사진발행/DB등록')...toBeDisabled()` 단언의 대상 텍스트를 `'UI 언어 설정'`으로 바꾼다(`.toBeDisabled()`는 **유지** — 약화 금지).
  - 테스트명/주석의 '사진발행/DB등록'·'tools.publishPhoto' 언급을 'UI 언어 설정'·'tools.uiLanguage'로 바꾼다.
- **확인**: 교체 후 `tools.uiLanguage`가 `MENU_ENABLED`에 없어(이 phase도 결선하지 않음) 여전히 비활성이라 단언이 성립한다. `tools.publishPhoto`는 이제 (A)의 양성 테스트가 활성임을 커버한다.
- L4650의 '사진발행/UI언어' 처럼 두 항목을 함께 언급하는 테스트는, 사진발행이 활성이 됐으므로 **UI 언어 설정만** 비활성 단언 대상으로 남긴다.

## Acceptance Criteria

```bash
npm run lint          # ESLint 클린
npm run build         # vite 빌드
npm run test:web      # 웹 테스트 — 신규 PhotoPublishDialog/WriterPage 결선 + 교체된 가드 전부 통과
npm test              # 백엔드(node --test) — 이 step은 백엔드 미변경이라 그대로 통과
```

기대 단언(요약):
- `PhotoPublishDialog`가 이미지 목록+캡션으로 `onSubmit({src,caption})`을 위임하고 Esc/취소로 닫힌다.
- 도구>사진발행/DB등록이 활성이 되고, 열어서 등록하면 `model.publishPhoto`가 올바른 payload로 호출된다(본문 무변경).
- 매핑 탭에서도 열린다(가드 앞).
- 남은 미결선 가드가 `tools.uiLanguage`로 교체되어 여전히 비활성 단언이 성립한다(약화 없음).
- 기존 웹·백엔드 테스트가 **모두 통과**한다(교체된 가드 포함 회귀 없음).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 다이얼로그는 순수 컴포넌트(model/fetch 미import) — 등록 호출은 WriterPage에서만.
   - 등록이 본문/캐럿/임베드를 바꾸지 않음(`commitBody`/`serialize`/`insertEmbed`/`updateField` 미호출).
   - 매핑 가드 앞 배치(죽은 버튼 방지)·탭 전환 시 닫힘(문서-로컬 이월 방지).
   - 회귀 가드는 교체만(약화 금지)·남은 미결선은 `tools.uiLanguage`.
   - Editor.jsx 미접촉.
3. 결과에 따라 `phases/41-photo-publish-db/index.json`의 step 2를 갱신(completed+summary / error / blocked).

## 금지사항

- 상위 `phases/index.json`(top-level 트래커)을 수정하지 마라. 이유: 오케스트레이터/execute.py 관리 파일 — step은 `phases/41-photo-publish-db/index.json`(로컬)만 갱신한다.
- 등록 경로에서 본문(`commitBody`/`serialize`/`updateField`/`insertEmbed`/`setPendingCaretLine`)을 호출하지 마라. 이유: 등록은 본문 무변경 읽기 액션 — 본문/캐럿을 건드리면 매핑 가드 앞 배치 근거가 무너지고 사용자 본문이 오염된다.
- `PhotoPublishDialog`에서 `model`/`fetch`/`httpModel`을 import하지 마라. 이유: ADR-003 순수 컴포넌트 — transport는 WriterPage(부모)만.
- `tools.publishPhoto` 분기를 매핑 가드(`if (isMapping) return;`) **뒤**에 두지 마라. 이유: 등록은 본문 무관이라 매핑에서도 열려야 한다(죽은 버튼 방지, fileInfo와 동일 정책).
- 탭 전환 조정 블록에 `setShowPhotoPublish(false)`를 빼먹지 마라. 이유: imageEmbeds/sourceArticleId가 탭-로컬 — 열린 채 전환하면 이전 탭 이미지를 다른 기사 사진으로 등록한다(phase 29~32 계열 버그).
- 회귀 가드의 `toBeDisabled()` 단언을 삭제하거나 `toBeEnabled()`로 약화하지 마라. 이유: 미결선 항목 커버리지는 유지해야 한다 — 대상만 `tools.uiLanguage`로 옮긴다(p21/p34 선례).
- `Editor.jsx`를 건드리지 마라. 이유: 등록은 WriterPage 경로만 — 에디터 렌더/입력은 무관(phase 30/33/39/40 결선 불변).
- 기존 테스트를 깨뜨리지 마라(교체 대상 외).
