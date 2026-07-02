# Step 2: writer-page-wiring — 도구>기사이력비교 결선(이력 조회 + 스냅샷 지연 로드 + 다이얼로그)

## 배경 / 요구사항

Step 0(백엔드 스냅샷 + 단건 조회 API)과 Step 1(순수 `diffLines` + `HistoryCompareDialog`)이 준비됐다. 이 step은 `web/src/view/WriterPage.jsx`에서 도구 메뉴 **'기사이력비교'**(`tools.historyCompare`, 현재 disabled placeholder)를 결선한다:
1. 메뉴 클릭 → 현재 편집 탭 기사의 이력(스냅샷 목록)을 `model.queryHistory`로 조회해 `HistoryCompareDialog`에 주입하고 다이얼로그를 연다.
2. 사용자가 비교 대상(스냅샷 2개, 또는 스냅샷 1개 + 현재 본문)을 고르면 선택된 스냅샷 본문을 `model.getHistorySnapshot`으로 **지연 조회**해 텍스트로 변환·주입한다.
3. 현재 본문은 편집 중인 in-memory 본문(`activeTab.fields.body`)을 텍스트로 변환해 비교 대상으로 제공한다(조회 불필요).

**읽기전용**이다 — 이 경로는 본문/캐럿/임베드를 절대 바꾸지 않는다(조회 결과는 다이얼로그 표시 상태에만 들어간다). 따라서 **매핑 가드 앞**에 결선한다(`fileInfo`/임베드 삽입 항목과 동일 정책 — 매핑에서도 열림, 죽은 버튼 방지). 저장 안 된 새 기사(articleId 없음)나 스냅샷이 없는 기사는 **"이력 없음" 빈 상태**로 연다.

> **비동기 안전**: phase20에서 async 업로드 대기 후 stale body/탭 클로저로 본문을 덮어써 데이터가 파손된 전례가 있다. 이 기능은 **읽기전용이라 본문을 전혀 쓰지 않으므로** 그 위험이 없다 — 조회 결과는 다이얼로그 표시 state로만 흘려보내고, `updateField`/`serialize`/`insertEmbed`를 이 경로에서 호출하지 않는 것으로 불변식을 지킨다.

기존 결선 패턴을 그대로 따른다(`WriterPage.jsx`): `MENU_ENABLED` 배열에 id 추가 → `onMenuSelect(id)` 분기(매핑 가드 앞) → 표시 state → 기존 다이얼로그들 옆에 `<HistoryCompareDialog>` 배치.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC, 명령어. 데이터는 Model(httpModel) 경유(ADR-003).
- `/docs/ADR.md` — ADR-003(Model 계약 seam — MODEL_KEYS를 httpModel·fakeModel과 동기화), ADR-004(읽기전용은 세션 게이트 — 본문/캐럿 불변).
- `/docs/news.md` L182 — 도구 메뉴 '기사이력비교'.
- `web/src/view/WriterPage.jsx` — **결선 지점(실측)**:
  - `MENU_ENABLED` 배열(L79) — 여기에 `'tools.historyCompare'` 추가.
  - `onMenuSelect(id)`(L350~) — 분기 라우팅. **읽기전용이라 `if (isMapping) return;`(L367) 앞**에 둔다(`tools.fileInfo` L362와 동일 위치).
  - `showFileInfo`/`showMemo` 등 표시 state 선언부(L119~132) — 동일 패턴의 표시 state 추가.
  - `fileInfoStats` 파생계산(L425~438) — "열 때만 파생/조회" 패턴 참고(단, 파일정보는 동기 순수계산, 이력비교는 async 조회라 state가 필요).
  - `activeTab`/`activeTab.articleId`/`activeTab.fields.body`(L172·L602 등) — 현재 편집 기사 id·본문. `blocks = deserialize(body)`(L173), `blocksToText`(이미 import L36) — 현재 본문 텍스트 변환.
  - 다이얼로그 렌더 블록(L764~851 — `<FileInfoDialog>`/`<MemoDialog>`/`<AbbrevManageDialog>`/`<SimpTradConvertDialog>` 등) — 여기에 `<HistoryCompareDialog>` 추가.
  - `model`(L89, `useAppContext`) — `model.queryHistory`/`model.getHistorySnapshot` 호출 소스.
- `web/src/view/HistoryCompareDialog.jsx`, `web/src/view/historyDiff.js` (Step 1 산출물) — props 계약(entries/left·rightKey/left·rightText/onSelectLeft·onSelectRight/onClose).
- `web/src/view/editorContent.js` — `deserialize`/`blocksToText`(스냅샷 markupVersion·현재 본문 → 비교용 텍스트).
- `web/src/model/contract.js` — `MODEL_KEYS`(L5~31, frozen). 새 메서드 `getHistorySnapshot`을 **추가**한다. `assertModel`이 MODEL_KEYS 전부를 함수로 요구하므로 httpModel·fakeModel도 함께 구현해야 한다.
- `web/src/model/httpModel.js` — `queryHistory`(L167~171, `GET /api/articles/:id/history`) 패턴. 바로 옆에 `getHistorySnapshot`을 추가한다.
- `web/src/test/fakeModel.js` — `queryHistory`(L124~128, seed `histories` 반환), `histories` seed 구조(L18). 여기에 `getHistorySnapshot`을 추가한다(seed 이력에서 단건 본문 모사).
- `web/src/view/WriterPage.test.jsx` — **테스트 컨벤션**: `setup({ identity, pendingEdit, seed })`, `openWith(blocks, {mode,status,role})`, 메뉴 열기→항목 클릭(`screen.getByRole('menuitem',{name:'도구'})` → `within(menu).getByText('기사이력비교').closest('button')`), 다이얼로그 오픈/닫기, `toBeEnabled()`/비활성 회귀 가드. 파일 정보 결선 테스트(L2855~)와 URL 임베드 결선 테스트(L2652 부근 — 비결선 항목 `tools.publishPhoto`로 회귀 가드)를 그대로 본뜬다. **fakeModel seed에 `histories`를 주입해 이력을 시드**한다.

## 작업

TDD로 진행한다(vitest). **`WriterPage.test.jsx`에 단언을 먼저 추가**하고 통과하는 결선을 만든다.

### 1. Model seam 확장(3곳 동기화 필수)
- `web/src/model/contract.js`: `MODEL_KEYS`에 `'getHistorySnapshot'`을 추가한다. **주의: httpModel·fakeModel 둘 다 구현하지 않으면 `assertModel`이 throw한다 — 반드시 3곳 함께.**
- `web/src/model/httpModel.js`: `getHistorySnapshot(articleId, historyId)` 추가 — `GET /api/articles/${encodeURIComponent(articleId)}/history/${encodeURIComponent(historyId)}`. `queryHistory`와 동일한 `request(...)` 사용, role은 안 싣는다(세션에서 도출 — ADR-004). 응답 `{ ok, item }`을 그대로 반환.
- `web/src/test/fakeModel.js`: `getHistorySnapshot(articleId, historyId)` 추가 — seed `histories[articleId]`에서 `id === historyId`(또는 그에 준하는 식별자)인 항목의 스냅샷 본문(markupVersion)을 `{ ok: true, item }`로 반환, 없으면 `{ ok: false, reason: 'not-found' }`. **원본을 변경하지 않는다**(읽기 전용 모사).

### 2. WriterPage 결선
- **import**: `HistoryCompareDialog`(그리고 필요 시 `diffLines`는 다이얼로그가 내부에서 쓰므로 WriterPage에서 불필요) 추가. `deserialize`/`blocksToText`는 이미 import됨(L36).
- **표시 state**(구현 재량이되 아래 역할):
  - `showHistoryCompare`(boolean) — 다이얼로그 표시.
  - `historyEntries`(스냅샷 이력 목록) — 열 때 `model.queryHistory` 결과에서 `hasSnapshot` 있는 항목만 담는다.
  - 선택/해소 텍스트 상태(`leftKey`/`rightKey`/`leftText`/`rightText`) — 선택 시 지연 조회 결과를 담는다. 현재 본문 선택은 조회 없이 in-memory 텍스트를 쓴다.
- **열기(onMenuSelect 분기)** — `if (isMapping) return;` **앞**에 둔다:
  ```js
  if (id === 'tools.historyCompare') { openHistoryCompare(); return; }
  ```
  `openHistoryCompare()`:
  - `activeTab.articleId`가 없으면(저장 안 된 새 기사) 빈 이력으로 다이얼로그를 연다(빈 상태 표시).
  - 있으면 `const r = await model.queryHistory(activeTab.articleId);` → `r.items` 중 스냅샷 있는 항목(`hasSnapshot` truthy)만 `historyEntries`로 세팅하고 다이얼로그를 연다.
  - 조회 실패/빈 배열이어도 죽지 않고 빈 상태로 연다.
- **비교 대상 목록(entries)**: `현재 본문` 항목(key 예: `'current'`, 텍스트=`blocksToText(deserialize(activeTab.fields.body))`) + `historyEntries`(각 항목 key=historyId, label=`시각/작성자`)를 합쳐 다이얼로그 `entries`로 넘긴다.
- **선택 → 지연 조회(onSelectLeft/onSelectRight)**: 선택된 key가 `'current'`면 현재 본문 텍스트를 즉시 세팅. 스냅샷 id면 `const s = await model.getHistorySnapshot(activeTab.articleId, key);` → `blocksToText(deserialize(s.item.markupVersion))`로 텍스트 변환해 해당 쪽(left/right) 텍스트 state에 세팅. **읽기전용 — 조회 결과는 표시 state에만 넣고 `updateField`/`serialize`를 호출하지 않는다.**
- **MENU_ENABLED**: 배열에 `'tools.historyCompare'` 추가.
- **다이얼로그 렌더**: 기존 다이얼로그들 옆에 추가:
  ```jsx
  <HistoryCompareDialog
    open={showHistoryCompare}
    entries={/* current + historyEntries */}
    leftKey={...} rightKey={...}
    leftText={...} rightText={...}
    onSelectLeft={...} onSelectRight={...}
    onClose={() => setShowHistoryCompare(false)}
  />
  ```

### 3. 회귀 가드 갱신
- `WriterPage.test.jsx`에서 `tools.historyCompare`가 **비활성이라고 단언하는 회귀 가드가 있으면**(grep으로 확인) 활성으로 갱신하고, "비결선 항목 비활성" 가드는 여전히 미결선인 항목으로 교체한다. **아직 미결선 후보**: `tools.publishPhoto`(사진발행/DB등록), `tools.uiLang`(UI 언어 설정). 기존 가드가 이미 `tools.publishPhoto`를 쓰고 있으면 그대로 두면 된다(historyCompare가 그 가드 대상이 아니었을 수 있음 — 확인 후 결정).

## Acceptance Criteria

```bash
npm run test:web      # web(vitest) — 기사이력비교 결선 단언 + 전체 회귀 통과
npm run build         # Vite 프로덕션 빌드
npm run lint          # ESLint
```

추가 단언(vitest, `WriterPage.test.jsx`):
- 도구 메뉴의 '기사이력비교'(`tools.historyCompare`)가 **활성**이다(이전엔 disabled placeholder — 비활성→활성 전환 단언).
- '기사이력비교' 클릭 시 `HistoryCompareDialog`(testid `history-compare`, `role="dialog"` '기사 이력 비교')가 열린다.
- **스냅샷 시드가 있는 기사**(fakeModel seed `histories`에 markupVersion/hasSnapshot 포함)에서 열면 이력 항목이 선택 목록에 표시된다.
- 좌/우로 스냅샷(또는 현재 본문)을 선택하면 두 본문의 diff가 표시된다(추가/삭제 세그먼트가 렌더 — Step 1 testid로 확인). `model.getHistorySnapshot`가 선택된 스냅샷에 대해 호출됨을 spy로 단언.
- **저장 안 된 새 기사(articleId 없음)** 또는 스냅샷 없는 기사에서 열면 "이력 없음" 빈 상태로 열린다(죽지 않음).
- **읽기전용 검증**: 기사이력비교를 열고 선택·닫아도 본문(`saveArticle` markupVersion)이 변하지 않는다(파일 정보 테스트 L2953 패턴 — 보류/저장 후 markupVersion 불변 단언), 또는 다이얼로그에 본문 편집 입력이 없음을 단언.
- **매핑 모드에서도 열린다**: 매핑 탭(`mode==='mapping'`)에서도 '기사이력비교'가 활성이고 다이얼로그가 열린다(읽기전용 — 파일정보/임베드 삽입 항목과 동일).
- 비결선 도구 항목(`tools.publishPhoto`)은 여전히 비활성이다(회귀 가드).
- '닫기'/Esc로 다이얼로그가 닫힌다.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: MODEL_KEYS·httpModel·fakeModel 3곳 동기화(assertModel 통과)·읽기전용(본문/캐럿/임베드 무변경)·매핑 가드 앞 배치·현재 본문/스냅샷 텍스트 변환은 deserialize+blocksToText·지연 조회 결과는 표시 state에만·MENU_ENABLED에 historyCompare만 추가·기존 메뉴 id 재사용.
3. 결과에 따라 `phases/25-article-history-compare/index.json`의 step 2를 갱신(completed+summary / error / blocked).

## 금지사항

- 기사이력비교 경로에서 `updateField`/`serialize`/`insertEmbed`/`setPendingCaretLine`/`Editor`의 새 prop을 쓰지 마라. 이유: 읽기전용 — 본문/캐럿/임베드 무변경(매핑 안전·phase20 stale-body 파손 방지).
- `tools.historyCompare` 분기를 매핑 가드(`if (isMapping) return;`) 뒤에 두지 마라. 이유: 읽기전용이라 매핑에서도 열려야 함(죽은 버튼 방지 — 파일정보와 동일 정책).
- `MODEL_KEYS`에 `getHistorySnapshot`을 추가하고 httpModel/fakeModel 중 하나라도 구현을 빠뜨리지 마라. 이유: `assertModel`이 throw해 앱/테스트가 부팅 실패한다.
- 스냅샷/현재 본문 텍스트 변환에 `deserialize`/`blocksToText` 외 별도 파서를 만들지 마라. 이유: 본문 포맷 단일 출처.
- `HistoryCompareDialog`가 직접 `model`/`fetch`를 호출하도록 하지 마라(부모가 조회해 props로 주입). 이유: ADR-003 — View는 transport 비의존.
- `tools.historyCompare`에 새 메뉴 id/라벨을 만들지 마라(`EditorMenuBar.jsx`의 기존 `tools.historyCompare` 그대로 결선). 이유: id 불일치로 메뉴가 죽는다(전력).
- `Editor.jsx`·`EditorMenuBar.jsx`·`server/`·`src/`(백엔드)·DB 스키마를 이 step에서 수정하지 마라. 이유: 결선만 — 백엔드는 step0에서 완료·Editor 미접촉·DB 비파괴.
- `MENU_ENABLED`에 `tools.historyCompare` 외 다른 미결선 항목(사진발행/UI언어 등)을 추가하지 마라. 이유: Scope 최소화.
