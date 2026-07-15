# Step 3: file-open-dialog

파일 메뉴의 마지막 항목 **문서열기(`file.open`)** 를 결선한다. 저장소는 DB이므로, 문서열기 = **에디터 내 DB 기사 피커 다이얼로그** — 목록/검색으로 기사를 고르면 기존 편집 진입 경로(`openArticle` → `getArticle` + `lockArticle`, 잠금 획득·dedup)로 편집 탭을 연다. 새 다이얼로그 컴포넌트(순수·controlled)와 컨트롤러 passthrough 2개(`queryArticles`/`searchArticles`)만 추가한다.

## 배경 (자기완결)

- 이미 `openArticle(article, mode='edit')`(컨트롤러 L211-241)이 편집 진입의 단일 경로다: 이미 열린 기사면 그 탭 활성화(dedup), 아니면 `getArticle`로 본문 채우고 `lockArticle`로 잠금 획득, 다른 세션이 편집 중(`{ ok:false, reason:'locked' }`)이면 **'편집중입니다.' alert 후 탭을 열지 않는다**. 문서열기는 **이 경로를 그대로 재사용**한다 — 잠금/dedup/locked 처리를 재구현하지 마라.
- 기사 목록/검색은 `model.queryArticles(filters)` / `model.searchArticles(q)`가 제공한다. **ADR-003: view는 model을 직접 부르지 않고 controller를 경유**한다. 현재 컨트롤러 공개 API(L388-393)에는 `queryArticles`/`searchArticles`가 없으므로 **passthrough를 additive로 추가**한다(`openArticle`은 이미 노출됨).
- 다이얼로그는 이 프로젝트의 중앙 모달 규약 `yh-editor-dialog`(예: `MetaSelectDialog`)를 따른다 — controlled(부모가 open/데이터/열림 소유), 순수(model/fetch/window/document 없음), `useFocusOnOpen`으로 열림 시 포커스 이전(에디터 본문에 포커스가 남아 타이핑/Esc가 새는 것 방지), Esc→`onClose`.

## 읽어야 할 파일

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(**ADR-003 — view는 controller 경유, model/transport 직접 호출 금지**. ADR-004 — 잠금 인가는 서버가 세션으로 강제).
- `docs/news.md` L181(문서열기).
- `docs/UI_GUIDE.md`(있으면 — 다이얼로그/모달 규약), `docs/SCHEMA.md`(기사 필드 shape 참고).
- `web/src/view/MetaSelectDialog.jsx` — `yh-editor-dialog` 중앙 모달 규약의 참조 구현: props controlled, `if (!open) return null`, `useFocusOnOpen(focusRef, open)`, Esc→onClose, 전용 클래스/`data-testid`, `yh-btn`/`yh-btn--primary`. **동형으로 새 다이얼로그를 작성**.
- `web/src/view/useFocusOnOpen.js` — 열림 시 포커스 이전 훅.
- `web/src/controller/useWriteController.js`:
  - `openArticle` L211-241(getArticle + lockArticle + dedup + locked alert), 반환 객체 L388-393(현재 `openArticle` 노출, `queryArticles`/`searchArticles` 미노출 — 추가 대상).
- `web/src/model/httpModel.js` — `queryArticles(filters)` L132, `searchArticles(q)` L139, `getArticle` L136, `lockArticle` L216(문서열기가 이들을 직접 부르지 않고 `openArticle`/passthrough로 도달하는지 확인용).
- `web/src/view/WriterPage.jsx`:
  - L103 `useAppContext`(model 접근 — **이 step에서 model을 직접 부르지 마라, controller 경유**), L104-108 구조분해(`openArticle` 추가 + passthrough 추가), L93 `MENU_ENABLED`, L535-691 `onMenuSelect`, L598 `isMapping` 가드.
  - 다이얼로그 표시 state 패턴: `showFileInfo`/`tableDialog`/`metaDialog`(L135-140) — open 상태를 부모가 소유하고 탭 전환 시 닫는 조정 블록(L225-239).
- `web/src/view/WriterPage.test.jsx`, 기존 다이얼로그 테스트(`MetaSelectDialog.test.jsx` 등) — 순수 컴포넌트 테스트 + WriterPage 통합 테스트 패턴.
- **이전 step 산출물**: step0~2가 `MENU_ENABLED`/`onMenuSelect`/구조분해에 file 계열을 추가했을 수 있다 — 기존 항목을 제거하지 말고 네 것만 추가하라.

## 작업 (TDD — 실패하는 테스트부터)

### 1) 신규 순수 컴포넌트 `web/src/view/DocumentOpenDialog.jsx`

`MetaSelectDialog`와 동형의 controlled·순수 다이얼로그. **model/fetch/window/document/localStorage 호출 없음** — 표시와 이벤트 위임만.

- props:
  - `open: boolean` — `if (!open) return null`.
  - `articles: Array` — 표시할 기사 목록(부모가 채움). 각 행 표시: articleId·제목·상태 등(있는 필드로 방어적 렌더, 없으면 '—').
  - `onSearch: (query: string) => void` — 검색어 입력/제출 시 위임(부모가 `searchArticles` 호출). 빈 검색어면 부모가 전체 목록으로 되돌리는 정책(구현 재량 — 다이얼로그는 문자열만 전달).
  - `onPick: (article) => void` — 행 선택(클릭/Enter) 시 위임.
  - `onClose: () => void` — 닫기 버튼/Esc.
- `yh-editor-dialog` + 전용 클래스(예 `yh-doc-open-dialog`)·전용 `data-testid`(예 `doc-open-dialog`)로 다른 다이얼로그와 충돌 회피(`MetaSelectDialog`의 주석 규약 참고).
- `useFocusOnOpen`으로 열림 시 첫 focusable(검색 입력 또는 닫기 버튼)로 포커스 이전.
- 목록이 비면 '기사가 없습니다.' 류 빈 상태 표기.
- **부모가 open을 소유**한다(제출/선택 후 닫기 판단은 부모 — `MetaSelectDialog` 정책과 동형).

### 2) `web/src/controller/useWriteController.js` — passthrough 추가(additive)

반환 객체(L388-393)에 아래 2개를 additive로 노출한다(얇은 위임 — model 계약 그대로):

- `queryArticles: (filters) => model.queryArticles(filters)`
- `searchArticles: (q) => model.searchArticles(q)`

(`useCallback`로 감싸 참조 안정화 권장. `openArticle`은 이미 노출돼 있으니 그대로 사용.)

### 3) `web/src/view/WriterPage.jsx` — 결선

1. 구조분해(L104-108)에 **`openArticle`, `queryArticles`, `searchArticles`** 추가.
2. 다이얼로그 상태(부모 소유): `const [showOpenDialog, setShowOpenDialog] = useState(false);` 와 목록 `const [openArticles, setOpenArticles] = useState([]);`.
3. 열기 핸들러(async — `queryArticles`로 초기 목록 채운 뒤 표시). 조회 실패해도 빈 목록으로 다이얼로그를 연다(죽지 않음):

   ```jsx
   const openDocumentPicker = async () => {
     setShowOpenDialog(true);
     try {
       const r = await queryArticles({});
       setOpenArticles((r && r.items) || []);
     } catch { setOpenArticles([]); }
   };
   ```

4. 검색 핸들러: `onSearch={async (q) => { try { const r = q ? await searchArticles(q) : await queryArticles({}); setOpenArticles((r && r.items) || []); } catch { setOpenArticles([]); } }}`.
5. 선택 핸들러: `onPick`에서 **`openArticle(article, 'edit')`** 호출(잠금/dedup/locked 처리는 openArticle에 위임). 성공/dedup(탭 id 반환) 시 다이얼로그를 닫고, `null`(locked — '편집중입니다.' alert가 이미 뜸) 시 다이얼로그를 열어 둔 채 다른 기사를 고르게 한다(구현 재량이나 이 정책 권장).
6. `MENU_ENABLED`에 `'file.open'` 추가(기존 id 유지).
7. `onMenuSelect`에서 **`isMapping` 가드(L598) 앞**에 분기: `if (id === 'file.open') { openDocumentPicker(); return; }`.
   - 배치 이유(못박음): 문서열기는 **다른 기사를 새 탭으로 여는 것**(현재 탭 본문 무변경)이라 매핑 모드에서도 유효하다(탭 관리 계열 — step0 file.new/close와 동일 정책). 죽은 버튼 방지.
8. `<DocumentOpenDialog open={showOpenDialog} articles={openArticles} onSearch={...} onPick={...} onClose={() => setShowOpenDialog(false)} />`를 다른 다이얼로그들과 같은 위치에 렌더.
9. **탭 전환 조정 블록(L225-239)과의 관계**: 이 다이얼로그는 문서-로컬 좌표(캐럿/blockIndex)를 들지 않으므로(선택 시 즉시 openArticle로 소비) phase 29~32 계열의 stale 위험이 없다. 다만 열린 채 탭을 전환해도 상태 오손이 없으면 굳이 닫지 않아도 된다(구현 재량 — 필요하면 조정 블록에 `setShowOpenDialog(false)` 추가 가능하나 데이터 정합성 이슈는 없다).

### 테스트

**`web/src/view/DocumentOpenDialog.test.jsx`(순수):**

- `open=false`면 아무것도 렌더 안 함.
- `articles` 목록의 각 행(articleId/제목)이 렌더됨. 빈 배열이면 빈 상태 문구.
- 검색 입력/제출 시 `onSearch(query)` 호출.
- 행 클릭 시 `onPick(article)`이 그 기사로 호출.
- 닫기 버튼/Esc 시 `onClose` 호출.
- 열림 시 포커스가 다이얼로그 내부로 이전됨(에디터 본문에 남지 않음).

**컨트롤러 테스트:** `queryArticles`/`searchArticles` passthrough가 주입 model의 동명 메서드를 그대로 호출·반환함 단언.

**`web/src/view/WriterPage.test.jsx`(통합):** fakeModel 주입.

- 파일 메뉴 → '문서열기' 클릭 → 다이얼로그가 열리고 `queryArticles`로 받은 목록이 보임 단언.
- 목록에서 한 기사 선택 → `openArticle` 경로가 타서 `getArticle`+`lockArticle` 호출 + 새 편집 탭 생김 단언.
- **locked 케이스**: fakeModel `lockArticle`가 `{ ok:false, reason:'locked' }` 반환 → '편집중입니다.' alert 발생 + 편집 탭이 열리지 않음 단언(기존 openArticle 계약 재사용 확인).
- (선택) 이미 열린 기사 선택 → dedup(새 탭 안 생기고 기존 탭 활성).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test` 불필요. client 전용, 기존 엔드포인트만 재사용.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `web/src/view/Editor.jsx`·`server/`·DB 스키마가 diff에 없는가?
   - **ADR-003**: `DocumentOpenDialog`/`WriterPage`가 `model.*`를 직접 부르지 않고 controller passthrough(`queryArticles`/`searchArticles`)·`openArticle`만 쓰는가?(다이얼로그 자체는 순수 — model 미접근)
   - 잠금/dedup/locked 처리를 재구현하지 않고 `openArticle`을 재사용했는가?
   - `MENU_ENABLED`에서 기존 id(step0~2 포함)가 제거되지 않았는가?
   - CLAUDE.md 준수(UTF-8·DB 비파괴·ADR-003/004).
3. 결과에 따라 `phases/34-editor-file-menu/index.json`의 step3을 업데이트한다:
   - 성공 → `"status": "completed"` + `"summary"`(신규 `DocumentOpenDialog`·passthrough 2개·openArticle 재사용·locked/dedup 테스트).
   - 실패/blocked 처리는 step0과 동일 규약.
4. top-level `phases/index.json`의 34 상태는 execute.py가 관리한다.

## 금지사항

- `DocumentOpenDialog`나 `WriterPage`에서 `model.queryArticles`/`model.searchArticles`/`model.getArticle`/`model.lockArticle`을 직접 부르지 마라. 이유: ADR-003 — view는 transport를 controller 경유로만 접근한다. 목록/검색은 passthrough, 열기는 `openArticle`을 쓴다.
- 문서열기에서 잠금 획득·`getArticle`·dedup·'편집중입니다.' 분기를 새로 구현하지 마라. 이유: `openArticle`이 이 계약(잠금/dedup/locked)을 단일 지점에서 강제한다 — 재구현하면 잠금 수명·중복 탭 방지가 이원화돼 편집 잠금 정합성이 깨진다.
- 문서열기가 현재 편집 탭의 본문을 바꾸게 하지 마라. 이유: 문서열기는 **다른 기사를 새 탭으로** 여는 동작이다(dedup 시 기존 탭 활성). 현재 탭 본문/캐럿은 불변이어야 한다.
- `DocumentOpenDialog`를 비-controlled(스스로 open/데이터 소유)로 만들지 마라. 이유: 이 프로젝트의 다이얼로그 규약은 부모 소유 controlled다(`MetaSelectDialog` 계약) — 상태를 다이얼로그에 두면 탭 전환/재오픈 초기화 계약이 어긋난다.
- `web/src/view/Editor.jsx`·`server/`·DB 스키마를 건드리지 마라. DB 행 삭제/스키마 변경 금지.
- `MENU_ENABLED`에서 기존 결선 id를 제거하지 마라. 기존 테스트를 깨뜨리지 마라.
