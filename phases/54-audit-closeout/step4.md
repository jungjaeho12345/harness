# Step 4: writer-stale-coords

## 목표

`web/src/view/WriterPage.jsx`에서 **"좌표를 계산한 시점"과 "그 좌표를 적용하는 시점"이 어긋나 엉뚱한 문서/줄에 반영되는 결함 3건**을 닫는다. 세 건 모두 같은 파일·같은 계열이라 한 step에서 다룬다.

| # | 결함 | 지점(심볼) |
|---|---|---|
| A | 기사이력비교 다이얼로그가 **탭 전환에도 안 닫혀** 이전 문서의 이력 목록·비교 텍스트가 다른 탭으로 이월된다(선택 시 다른 기사 id로 스냅샷을 조회). | 탭 전환 조정 블록(`caretTabId !== activeTabId`) / `openHistoryCompare` / `selectCompareTarget` |
| B | 이미지 업로드 대기 중 **본문 줄 구조가 바뀌면** 붙여넣기 시점의 `caret.lineIndex`가 최신 본문에 그대로 적용돼 임베드가 엉뚱한 줄에 삽입된다. | `pasteImageAtCaret` |
| C | `onReplaceOne`이 **치환 후 캐럿 오프셋을 치환 전 본문 텍스트로 줄 환산**해, 대체문 길이가 다르면 캐럿이 다른 줄로 간다(이후 '다음 찾기' 순서까지 교란). | `onReplaceOne` → `focusMatchLine` |

> **선행**: WriterPage 패스의 첫 step. `web/src/view/WriterPage.jsx`는 이 step → step5 순서로만 수정한다(동시 수정 금지). step3(writerBody.js·editorShortcuts.js)과 파일 중복 없음.
> 수정 대상은 **`web/src/view/WriterPage.jsx` + `web/src/view/WriterPage.test.jsx` 2개뿐**이다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/news.md` — 기사이력비교(도구 메뉴), 커서 위치 임베딩(156행), 찾기/바꾸기.
- `docs/ARCHITECTURE.md` — 프론트 MVC(View ← Controller ← Model), 클라이언트 로컬 상태(작성 탭은 sessionStorage 보존).
- `web/src/view/WriterPage.jsx`
  - **탭 전환 조정 블록**: `const [caretTabId, setCaretTabId] = useState(activeTabId); if (caretTabId !== activeTabId) { … }` — 렌더 중 조정 패턴(effect 아님: effect는 마운트에서도 돌고 flush 지연 레이스가 있다). 지금 여기서 초기화하는 것: `lastCaretRef`·`statusCaret`·`showSpell`/`spellIssues`·`spellHighlights`·`tableDialog`·`metaDialog`·`urlEmbedKind`·`showPhotoPublish`·`showUiLanguage`. **기사이력비교 state는 빠져 있다** ← 결함 A.
  - 기사이력비교 state 6종: `showHistoryCompare`·`historyEntries`·`histLeftKey`·`histRightKey`·`histLeftText`·`histRightText` + 레이스 가드 ref `histReqRef`(`{ left, right }`).
  - `openHistoryCompare()` — 열 때 `histReqRef.current = { left:null, right:null }`로 초기화하고 `model.queryHistory(activeTab.articleId)`로 채운다.
  - **`histReqRef`의 선언 위치는 `selectCompareTarget` 바로 위(≈L672)이고, 탭 전환 조정 블록은 그보다 훨씬 앞(≈L352)이다** — 조정 블록에서 `histReqRef`를 그대로 참조하면 `const` TDZ로 `ReferenceError`가 난다(state setter 6종은 L247~252 선언이라 안전하다). 작업 1을 보라.
  - `selectCompareTarget(side, key)` — `'current'`는 즉시 `bodyText`, 스냅샷 id는 `await model.getHistorySnapshot(activeTab.articleId, key)` 후 `histReqRef` 대조로 stale 응답을 폐기한다.
  - `insertEmbedAtLine(embed, caretLine, srcBody = body, mapping = isMapping)` — `caretLine == null`이거나 매핑이면 `appendEmbedToBody`(문서 끝, "(끝)" 앞), 아니면 `insertEmbedAfterLine(srcBody, embed, caretLine)`.
  - `pasteImageAtCaret(file, caret)` — 시작 시 `const tabId = activeTab.id`, `await model.uploadFile(file)`, 실패면 alert 후 return, 성공하면 `const current = activeTabRef.current`로 **탭 동일성**을 확인하고(다르면 안내 후 취소) `insertEmbedAtLine(makeImageEmbed(r.path,{alt:''}), caret ? caret.lineIndex : null, current.fields.body, …)`. ← 결함 B는 이 `caret.lineIndex`다.
  - `onReplaceOne(replacement)` — `replaceOne(blocks, findQuery, replacement, { caseSensitive: findCase, fromOffset })` → `commitBody(serialize(r.blocks))` → `focusMatchLine(r.caretOffset)` → `setActiveIndex(-1)`.
  - `focusMatchLine(offset)` — `lineAtOffset(bodyText, offset)`의 `lineIndex`로 `setPendingCaretLine`. **`bodyText`는 이번 렌더(=치환 전) 본문**이다 ← 결함 C.
  - 이미 import 되어 있는 것들: `deserialize`·`serialize`·`blocksToText`(`./editorContent.js`), `lineAtOffset`(**`./editorCaret.js`** — WriterPage L70의 import 문), `makeImageEmbed`, `appendEmbedToBody`/`insertEmbedAfterLine`(`./writerBody.js`). 새 import를 추가할 필요가 없다.
- `web/src/view/editorFind.js` — `replaceOne`의 반환 계약: `{ blocks, replaced, matchStart, caretOffset }`이고 **`caretOffset = match.start + 대체문 길이`(= 치환 후 텍스트 기준 좌표)**다.
- `web/src/view/WriterPage.test.jsx` — 테스트 헬퍼 관례: `openWith([textBlock(...)])`(편집 탭 열기), `caretAtLine(container, i)`(캐럿 지정), `pasteImageEvent(box)`(이미지 붙여넣기 이벤트), 지연 업로드는 `vi.spyOn(model,'uploadFile').mockImplementation(() => new Promise((res) => { resolveUpload = res; }))` + `await act(async () => resolveUpload({...}))`, 탭 추가는 `screen.getByRole('button', { name: '새 작성 탭' })`.
  - **기존 케이스 확인 필수**: "연속 붙여넣기 2건", "업로드 대기 중 다른 탭으로 이동하면 새 탭 본문이 파손되지 않는다(삽입 취소 + 안내)", 찾기/바꾸기 블록.
- 참고(수정 금지): `pasteClipboardTextInto` — 같은 파일의 텍스트 붙여넣기는 await **뒤에** `lastCaretRef.current`(라이브 값)를 읽으므로 이 결함이 없다. 이미지 경로만 시작 시점 캐럿을 들고 간다(비동기 업로드 중 selection이 사라질 수 있어 동기로 확보하기 때문).

## 배경 (자기완결) — 왜 결함인가

**A.** 기사이력비교 state는 전부 **문서(탭)-로컬**이다. 비모달이라 열린 채 탭을 바꿀 수 있고, 그러면 이전 기사의 이력 목록이 새 탭 위에 떠 있다. 그 상태에서 항목을 고르면 `selectCompareTarget`이 **새 탭의 `activeTab.articleId`** 로 **이전 기사의 이력 id**를 조회한다(빈 결과 또는 무관한 스냅샷). `'현재 본문'`을 고르면 새 탭 본문이 이전 기사 이력과 나란히 비교돼 사용자가 오독한다. 이 프로젝트는 같은 계열(캐럿·맞춤법·표·메타·사진발행·URL임베드 다이얼로그)을 전부 "탭 전환 시 닫는다"로 처리해 왔고, 이력비교만 누락됐다.

**B.** `pasteImageAtCaret`은 phase 20에서 **탭** 이월은 막았지만(activeTabRef 재확인) **같은 탭 안의 줄 구조 변경**은 보지 않는다. 업로드 왕복(수백 ms~수 초) 동안 사용자가 **대상 줄보다 앞에서** Enter를 치거나 줄을 지우면 `caret.lineIndex`가 다른 줄을 가리키고, 임베드는 사용자가 지목한 적 없는 줄 뒤에 들어간다(되돌리기는 있지만 사용자는 원인을 모른다). 반대로 **대상 줄 자체에 이어서 타이핑하거나 대상 줄 뒤가 늘어나는 것**은 인덱스를 밀지 않으므로 오늘처럼 캐럿 줄 뒤에 삽입돼야 한다 — 판정이 이 둘을 구분하지 못하면 결함 수정이 곧 새 회귀가 된다.

**C.** `replaceOne`의 `caretOffset`은 **치환 후** 텍스트 좌표인데 `focusMatchLine`은 **치환 전** `bodyText`로 줄을 환산한다. 대체문이 원문보다 길면 오프셋이 앞 줄들의 개행 경계를 넘어 다른 줄로 계산될 수 있고, 캐럿이 엉뚱한 줄로 이동한 뒤 '다음 찾기'가 그 위치를 기준으로 도는 바람에 치환 순서가 교란된다.

## TDD — 테스트 먼저

`web/src/view/WriterPage.test.jsx`에 red → green으로 추가한다(기존 케이스는 아래 명시한 1건 외에는 수정 금지).

**A. 이력비교 탭 이월**
1. 결함 재현: 기사 편집 탭을 열고 도구>기사이력비교를 연다(모델의 `queryHistory`를 스냅샷 보유 항목으로 모킹). 다이얼로그가 보이는 것을 확인한 뒤 '새 작성 탭'으로 전환하면 **다이얼로그가 사라진다**(`queryByText`/`data-testid` 부재 단언).
2. 재개방 시 상태 초기화: 다시 열면 좌/우 선택과 비교 텍스트가 비어 있고(이전 선택이 남지 않는다), `queryHistory`가 **새 탭 기준으로** 다시 호출된다.
3. 지연 응답 폐기: `getHistorySnapshot`을 지연 Promise로 만들어 선택 → 탭 전환 → 응답 도착 순서를 만들면, 늦게 온 텍스트가 어디에도 렌더되지 않는다(크래시 없음).
4. 회귀: 같은 탭에 머무는 동안에는 다이얼로그가 닫히지 않고 좌/우 선택·비교 텍스트가 유지된다.

**B. 업로드 대기 중 줄 구조 변경**
5. 결함 재현: `openWith([textBlock('제목'), textBlock('본문'), textBlock('꼬리')])`, `caretAtLine(container, 2)`(대상=`'꼬리'`) 후 이미지 붙여넣기(업로드 지연). 대기 중 **대상 줄보다 앞쪽 구조를 바꾼 뒤**(앞 줄에 줄 추가 또는 앞 줄 삭제) 업로드를 resolve하면, 임베드가 **문서 끝**(마지막 텍스트 뒤/"(끝)" 앞)에 들어가고 `window.alert`가 1회 뜬다. 원래 인덱스(2) 뒤에 엉뚱한 임베드가 없다.
6. 정상 플로우 회귀(중요): 대기 중 본문을 **건드리지 않으면** 오늘과 동일하게 캐럿 줄 뒤에 삽입되고 alert가 뜨지 않는다.
7. 정상 플로우 회귀(중요 — 이 단언이 판정 규칙을 'prefix 동일'로 정한 이유를 잠근다): 대기 중 **대상 줄 자체에 이어서 타이핑**해도(가장 흔한 시나리오) 캐럿 줄 뒤 삽입이 유지되고 alert가 뜨지 않는다.
8. 정상 플로우 회귀: 대상 줄 **뒤쪽**에서만 본문이 늘어난 경우(연속 붙여넣기로 빈 줄이 생기는 케이스)에도 캐럿 줄 뒤 삽입이 유지된다 — 기존 "연속 붙여넣기 2건" 케이스가 **무수정 green**이어야 한다.
9. 회귀: `caret`이 `null`이면 오늘처럼 문서 끝에 삽입하고 **alert는 뜨지 않는다**(원래 캐럿이 없던 것이지 좌표가 어긋난 게 아니다).
10. 회귀: 탭 전환 케이스(기존 테스트)는 그대로 "삽입 취소 + 안내"다 — 이 step이 그 분기를 바꾸지 않는다.

**C. 바꾸기 캐럿**
10. 결함 재현: 본문 `['가나다', '라마바', '사아자']`에서 '다'를 아주 긴 문자열(예: `'X'.repeat(50)`)로 바꾸면, 캐럿이 **치환된 줄(index 0)** 로 간다(치환 전 텍스트로 계산하면 뒷줄로 밀린다). 캐럿 이동은 `pendingCaretLine` 소비 결과(포커스된 줄) 또는 상태표시줄 캐럿 표시로 관찰하라 — 기존 찾기 테스트가 쓰는 관찰 방식을 그대로 따른다.
11. 회귀: 짧은 대체문(길이 동일/더 짧음)에서도 캐럿 줄이 기존과 동일하다.
12. 회귀: `onReplaceAll`·`findStep`(다음/이전 찾기)의 캐럿 이동은 이번 변경의 영향을 받지 않는다(기존 테스트 무수정 green).

**기존 케이스 중 유일하게 손봐도 되는 것**: "업로드 대기 중 …" 계열에서 새로 alert가 뜨는 시나리오가 생기면 `vi.spyOn(window,'alert')` 모킹을 추가하는 정도. 단언 자체를 완화하지 마라.

## 작업

1. **A — 탭 전환 시 이력비교 닫기**: 탭 전환 조정 블록(`if (caretTabId !== activeTabId)`) 안에서 `setShowHistoryCompare(false)`와 함께 `historyEntries`·`histLeftKey`·`histRightKey`·`histLeftText`·`histRightText`를 초기값으로 되돌리고, `histReqRef.current = { left: null, right: null }`로 in-flight 응답을 폐기한다. 기존 형제 항목들(`setTableDialog(null)` 등) 바로 옆에 두고, **왜 닫는지 한 줄 주석**을 같은 톤으로 남겨라(문서-로컬 좌표 이월 계열).
   - **선행 이동(필수)**: `histReqRef` 선언(`const histReqRef = useRef({ left: null, right: null });`)은 현재 `selectCompareTarget` 바로 위(≈L672)에 있어 조정 블록(≈L352)에서 참조하면 `const` **TDZ ReferenceError**가 난다. 선언을 **이력비교 state 6종 옆(조정 블록보다 위)** 으로 옮겨라 — 훅은 렌더마다 순서대로 무조건 실행되므로 위치 이동은 안전하고 훅 순서도 바뀌지 않는다(`useRef` 호출 개수·순번 유지). 이동한 자리에 "조정 블록에서 참조하므로 위로 올렸다"는 한 줄 주석을 남기고, `selectCompareTarget`·`openHistoryCompare`의 사용부는 그대로 둔다.
2. **B — 업로드 후 대상 줄 유효성 확인**: `pasteImageAtCaret` 시작 시점에 본문 스냅샷을 잡는다(`const bodyAtStart = activeTab.fields.body;` — `tabId` 캡처 바로 옆). 업로드 성공 + 탭 동일성 확인 뒤, 대상 줄을 아래 규칙으로 결정한다.
   - `caret == null` → 오늘과 동일(`null` 전달, 안내 없음).
   - 그 외: **대상 줄 앞쪽(prefix)** 만 비교한다 — 스냅샷과 최신 본문 각각에서 `blocksToText(deserialize(body)).split('\n')`을 만들고, `lines.slice(0, caret.lineIndex).join('\n')`이 서로 같고 **최신 본문에 그 인덱스의 줄이 존재하면**(`caret.lineIndex < lines.length`) `caret.lineIndex`를 쓴다. 하나라도 어긋나면 `null`을 쓰고 `window.alert`로 1회 안내한다(문구는 기존 안내들과 같은 톤: 본문이 바뀌어 이미지를 문서 끝에 넣었다는 사실 + 사용자가 옮길 수 있다는 함의). 안내 후에도 **삽입은 반드시 수행한다**(업로드본 폐기 금지).
   - **대상 줄 자체의 텍스트는 비교하지 마라**: 업로드 대기 중 그 줄에 이어서 타이핑하는 것은 흔한 정상 시나리오이고 인덱스를 밀지 않는다 — 그것까지 폴백으로 보내면 오늘 정상 동작하던 경로가 문서 끝 삽입 + 안내로 바뀌어 결함 수정이 회귀를 만든다. 인덱스를 미는 변경은 오직 **앞쪽** 줄 추가·삭제뿐이므로 prefix 비교로 정확히 잡힌다.
   - 판정 함수는 컴포넌트 **밖 모듈 스코프의 순수 헬퍼**로 두어라(예: `samePrefixLines(prevBody, nextBody, lineIndex)` — 같은 파일 안 `submitFailMessage` 등 모듈 스코프 헬퍼 관례를 따른다). 렌더마다 재생성되는 클로저에 넣지 마라.
3. **C — 치환 후 텍스트로 줄 환산**: `focusMatchLine(offset, text = bodyText)`처럼 **선택 인자**를 받게 하고(기본값은 현재 렌더 본문 — 기존 호출부 무변경), `onReplaceOne`만 치환 결과 텍스트를 넘긴다: `focusMatchLine(r.caretOffset, blocksToText(r.blocks))`. `replaceOne`·`editorFind.js`는 수정하지 않는다.

공통 제약:
- 본문 반영은 기존 단일 경로(`commitBody(serialize(...))`)만 쓴다. 새 저장/업로드/네트워크 경로를 만들지 않는다.
- `insertEmbedAtLine`의 시그니처·기본값·매핑 분기를 바꾸지 마라(동기 호출부 3곳이 그대로 동작해야 한다).
- `activeTabRef` 탭 동일성 가드와 그 안내 문구는 그대로 둔다.

## Acceptance Criteria

```bash
npm run lint      # 통과
npm run build     # 통과
npm run test:web  # 실패 0 — 87 files, 2124 + step3 신규 + 이번 신규 케이스
npm test          # 백엔드 무접촉 — 실패 0(개수는 step2 종료 시점과 동일)
```

`git diff --name-only`는 `web/src/view/WriterPage.jsx`, `web/src/view/WriterPage.test.jsx` **2개뿐**이어야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다. **단독 full run 2회 연속 green**을 확인한다(이 파일의 테스트는 타이밍 flake 전례가 있다).
2. 변이 검증 4종(각각 확인 후 원복):
   - 탭 전환 블록에서 `setShowHistoryCompare(false)`를 지우면 A 케이스만 red.
   - prefix 비교를 상수 `true`로 바꾸면 B의 결함 재현 케이스만 red(정상 플로우 회귀 6·7·8은 green 유지).
   - prefix 비교를 "대상 줄 텍스트 동일" 비교로 바꾸면 **정상 플로우 회귀 7(대상 줄에 이어 타이핑)** 이 red가 되는지 확인한다(이 규칙 선택이 회귀 방지 목적이라는 증거).
   - `focusMatchLine`의 두 번째 인자를 지우면 C 케이스만 red.
3. 회귀 눈검사: 기존 "연속 붙여넣기 2건"·"업로드 대기 중 다른 탭 이동"·찾기/바꾸기 블록이 **단언 완화 없이** green인지 확인한다.
4. 아키텍처 체크리스트:
   - View 계층만 수정했는가(controller/model/backend 무접촉)?
   - 업로드는 여전히 `model.uploadFile` 경유이고 base64를 만들지 않는가(ADR-003)?
   - 새 타이머(setTimeout/setInterval)·새 네트워크 호출이 없는가(ADR-008)?
   - DB·스키마 변경 0건인가?
5. `phases/54-audit-closeout/index.json`의 step4를 `completed` + `summary`로 갱신한다. summary에 (a) 탭 전환 시 닫는 state 목록 + `histReqRef` 선언 이동, (b) B의 판정 규칙("대상 줄 앞쪽 prefix 동일 + 인덱스 범위"만 본다 — 대상 줄 텍스트·줄 수는 보지 않는다)과 폴백·안내 정책, (c) `focusMatchLine`의 새 선택 인자 계약을 명시하라.

## 금지사항

- 업로드 실패도 아닌데 삽입을 취소하지 마라(B). 이유: 파일은 이미 업로드돼 경로가 발급됐고, 취소하면 사용자는 다시 붙여넣어야 하며 업로드본만 고아로 남는다.
- 대상 줄을 "가장 비슷한 줄 탐색" 같은 휴리스틱으로 찾지 마라. 이유: 같은 텍스트 줄이 여럿인 문서에서 결과가 비결정적이라 계약을 테스트로 고정할 수 없다.
- 판정에 줄 **개수**나 **대상 줄 텍스트**를 넣지 마라. 이유: 대상 줄 뒤에 줄이 늘어나는 것(연속 붙여넣기가 만드는 빈 줄)과 대상 줄에 이어서 타이핑하는 것은 모두 인덱스를 밀지 않는 정상 시나리오다 — 그 둘까지 폴백으로 보내면 오늘 정상 동작하던 경로가 문서 끝 삽입 + 안내로 바뀐다(결함 수정이 회귀 생성).
- `activeTabRef` 탭 동일성 가드나 그 안내를 제거·완화하지 마라. 이유: 다른 기사 본문 파손을 막는 phase 20 방어다.
- `editorFind.replaceOne`의 `caretOffset` 계약(치환 후 좌표)을 바꾸지 마라. 이유: 이 값은 순수 모듈의 확정 계약이며 다른 호출부·테스트가 의존한다 — 이번 결함은 **소비 측**의 환산 기준 문제다.
- 탭 전환 초기화를 `useEffect`로 옮기지 마라. 이유: effect는 마운트에서도 돌고 flush가 늦으면 전환 후 새로 기록된 값을 지운다(렌더 중 조정 패턴을 쓰는 이유가 코드 주석에 있다).
- `historiesRef`(탭별 undo 히스토리)를 탭 전환에서 지우지 마라. 이유: 그것은 의도적으로 **보존**하는 상태이며 제거는 탭 닫기·문서 리셋에서만 한다.
- `Editor.jsx`·`editorFind.js`·`writerBody.js`·컨트롤러·`src/`·`server/`를 수정하지 마라. 이유: 이 step은 View 결선 한 파일만 다룬다(다른 파일은 다른 step의 소유이거나 무접촉 대상).
- `docs/ADR.md`·`docs/news.md`(읽기 전용 — 스펙 근거로만 참조)·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라.
- 기존 테스트를 깨뜨리지 마라.
