# Step 0: history-model

편집 메뉴 **되돌리기(undo)·다시실행(redo)**가 쓸 **탭별 본문 히스토리 스택 순수 모델**을 만든다. 본문(markupVersion 문자열) 스냅샷의 과거/현재/미래를 관리하는 순수 함수 집합이다. 이 step은 **순수 로직만** — React/DOM/clipboard/transport 미접촉(결선·탭 수명·키 인터셉트는 step1 WriterPage).

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — view는 순수 함수/컴포넌트, transport 비의존; 철학: TDD·zero-dep·표준 기능 우선).
- `docs/news.md` L182(편집 메뉴 — **되돌리기, 다시실행**이 첫 두 항목), L175(본문 = 텍스트/임베드 블록 구조 markupVersion).
- `web/src/view/editorContent.js` — 본문 직렬화 계약. `serialize(blocks)`→markupVersion 문자열, `deserialize(raw)`→블록 배열. **이 히스토리는 blocks가 아니라 `serialize` 결과인 body 문자열(markupVersion)을 스냅샷으로 저장한다**(step1의 `commitBody(nextBody)`가 받는 값과 동일 타입). 이 step에서 editorContent를 import할 필요는 없다 — 히스토리는 body를 불투명(opaque) 문자열로만 다룬다(내용 해석 금지).
- `web/src/view/editorEditOps.js` 또는 `web/src/view/editorClipboard.js` — 순수 헬퍼의 반환형/테스트 스타일(vitest) 참조용(구조 참고만, 로직 복사 금지).

## 배경 (자기완결)

기사 에디터 편집 메뉴에는 되돌리기/다시실행이 있으나 현재 미결선이다(비활성). step1이 WriterPage의 **본문 변경 단일 choke point `commitBody(nextBody)`**에 이 모델을 결선해, 본문이 바뀔 때마다 스냅샷을 쌓고 되돌리기/다시실행으로 이전/다음 스냅샷을 복원한다.

핵심 요구(step1이 의존하는 계약이므로 이 모델이 반드시 만족해야 함):
1. **탭별 격리** — 히스토리는 탭(문서)마다 완전히 독립이다. 이 모델은 "히스토리 1개"의 순수 자료구조만 정의하고, "탭→히스토리 매핑"은 step1이 관리한다. 따라서 이 모델은 탭을 몰라도 된다 — 순수하게 한 문서의 스냅샷 스택만 다룬다.
2. **베이스라인 보존** — 첫 스냅샷(문서를 연 시점의 본문)은 절대 유실되면 안 된다(되돌리기로 최초 상태까지 돌아갈 수 있어야 함).
3. **redo 분기 절단** — 되돌린 뒤 새 편집이 들어오면 미래(redo) 스냅샷은 버린다(표준 undo 스택 의미론).
4. **코얼레싱** — 타이핑 연타로 스냅샷이 폭증하지 않도록, "코얼레싱" 플래그가 켜진 연속 캡처는 스택 top을 **교체**(성장 없이 최신 body로 갱신)한다. 단 베이스라인(첫 항목)은 교체하지 않는다.
5. **상한(메모리)** — 항목 수가 상한을 넘으면 가장 오래된 것부터 버린다(탭별 메모리 무한 증식 방지).

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 신규 `web/src/view/editorHistory.js` — 본문 히스토리 스택(순수)

아래 시그니처를 만족하는 순수 함수 집합을 구현하라. **자료구조 shape과 구현 세부는 재량**이되, 아래 시그니처·반환 계약·불변식은 반드시 지켜라(step1이 이 계약에 결선한다).

```js
// 히스토리 상태(불변 취급) — 예시 shape. entries: body 문자열 배열, index: 현재 위치(0-base).
//   entries[index]가 '현재 본문'. index>0이면 undo 가능, index<entries.length-1이면 redo 가능.
// createHistory(initialBody) → 히스토리(항목 1개=베이스라인, index 0)
export function createHistory(initialBody) { /* ... */ }

// 새 본문 스냅샷을 반영한 새 히스토리를 돌려준다(입력 불변 — 새 객체 반환).
//   opts.coalesce === true 이고 top(현재가 최신)이며 베이스라인이 아니면: top 항목을 nextBody로 '교체'(성장 없음).
//   그 외: 현재 위치 이후(redo 분기)를 잘라내고 nextBody를 push, index를 top으로 이동.
//   nextBody가 현재 본문과 동일하면 no-op(동일 히스토리 반환 — 헛 스냅샷/중복 방지).
//   opts.limit(양의 정수)면 push 후 항목 수가 limit을 넘을 때 가장 오래된 항목부터 버리고 index를 보정한다.
export function pushHistory(history, nextBody, opts = {}) { /* ... */ }

// 되돌리기 — 가능하면 index를 하나 뒤로 옮긴 새 히스토리와 그 시점 body를 돌려준다.
//   불가(이미 베이스라인)면 { history: 동일, body: null, changed: false }.
export function undo(history) { /* → { history, body, changed } */ }

// 다시실행 — 가능하면 index를 하나 앞으로 옮긴 새 히스토리와 그 시점 body를 돌려준다.
//   불가(이미 최신)면 { history: 동일, body: null, changed: false }.
export function redo(history) { /* → { history, body, changed } */ }

// 되돌리기/다시실행 가능 여부(메뉴 활성/비활성 판정용 — step1이 쓸 수 있으나 필수는 아님).
export function canUndo(history) { /* → boolean */ }
export function canRedo(history) { /* → boolean */ }
```

구현 지침(순수):
1. `createHistory(initialBody)` — `String(initialBody ?? '')` 1개를 담은 베이스라인 히스토리(index 0).
2. `pushHistory`:
   - `next = String(nextBody ?? '')`. `next === history.entries[history.index]` → **no-op**(동일 히스토리 그대로 반환).
   - **코얼레싱**: `opts.coalesce === true && history.index === history.entries.length - 1 && history.index > 0` → `entries[index]`를 `next`로 교체한 새 히스토리 반환(길이·index 불변). `index > 0` 가드로 **베이스라인은 절대 교체하지 않는다**.
   - **일반 push**: `entries.slice(0, index + 1)`(미래 절단) 뒤 `next`를 push, `index = 새 길이 - 1`.
   - **상한**: `opts.limit`이 양의 정수이고 push 후 `entries.length > limit`이면 앞에서부터 `entries.length - limit`개를 버리고 `index`를 같은 수만큼 감소(음수 방지 clamp).
3. `undo`/`redo` — index 이동 + 이동한 위치의 body 반환. 경계면 `changed:false`, `body:null`.
4. 모든 함수는 입력 `history`를 **변형(mutate)하지 않는다** — 새 객체/새 배열만 반환.

**못박음(불변식 — 어기면 step1 결선이 데이터 무결성 버그를 낸다)**:
- **베이스라인 불멸**: 어떤 코얼레싱도 `entries[0]`(문서를 연 시점 본문)을 덮어쓰지 않는다. 상한 절단으로만 오래된 항목이 사라진다(그때도 되돌릴 수 있는 범위가 줄 뿐 현재/미래는 보존).
- **동일 body no-op**: `nextBody`가 현재와 같으면 스택을 늘리지 않는다(React 재렌더/StrictMode 이중 호출로 같은 body가 두 번 와도 헛항목이 안 생긴다).
- **redo 분기 절단**: 코얼레싱이 아닌 일반 push는 반드시 현재 index 이후를 버린다(되돌린 뒤 편집하면 이전 redo 경로는 사라진다).
- **입력 불변**: 인자로 받은 history·entries 배열을 mutate 금지(순수 — 동일 참조 반환은 no-op일 때만 허용).
- body는 **불투명 문자열**로만 다뤄라 — `deserialize`/`JSON.parse`로 내용을 해석하거나 정규화하지 마라(직렬화 정규화는 step1의 `serialize`가 이미 담당 — 여기서 또 하면 동일-body 판정이 어긋난다).

### 테스트 — `web/src/view/editorHistory.test.js`

최소 아래를 커버하라(vitest):
- `createHistory('A')` → `canUndo`=false, `canRedo`=false, 현재 body='A'.
- push 후 undo/redo 왕복: `A→push B→push C`, undo→'B', undo→'A'(베이스라인, 더는 undo 불가), redo→'B', redo→'C'.
- **redo 분기 절단**: `A→B→C`, undo→'B', 여기서 `push D` → redo 불가(C가 사라짐), undo→'A'로만 이어짐(경로 A,B,D).
- **동일 body no-op**: 현재와 같은 body push → 히스토리 불변(길이·index 그대로).
- **코얼레싱**: `createHistory('')` 후 `push('a',{coalesce:true})`(베이스라인 다음 첫 타이핑이라 **push**)·이어 `push('ab',{coalesce:true})`·`push('abc',{coalesce:true})`가 top을 교체 → entries 길이=2(베이스라인 '' + 'abc'), undo→''(베이스라인 보존 확인).
- **베이스라인 비교체**: `createHistory('base')` 후 `push('x',{coalesce:true})` → 베이스라인은 그대로 남고 'x'가 새 항목(길이 2, index 1). undo→'base'.
- **상한**: `limit:3`로 4번 이상 push → 길이가 3으로 유지되고 가장 오래된 항목이 사라지되, 현재 body와 redo 불가/undo 가능 관계가 정합(index가 범위 내).
- 입력 불변: push/undo/redo가 원본 history 객체를 바꾸지 않음(원본 entries 길이·index 불변 단언).

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(순수 클라이언트 로직 — 백엔드 무관. `npm test`(node --test)는 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `editorHistory.js`가 순수 함수만 담고 React/DOM/clipboard/transport에 의존하지 않는가?(ADR-003)
   - body를 불투명 문자열로만 다루는가(deserialize/JSON.parse로 해석하지 않는가)?
   - 베이스라인 불멸·redo 절단·동일 body no-op·입력 불변 불변식이 테스트로 잠겨 있는가?
   - CLAUDE.md(DB 무관·client 전용·UTF-8 저장)?
3. 결과에 따라 `phases/37-editor-undo-redo/index.json`의 step0을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (모듈 경로 `web/src/view/editorHistory.js` · 시그니처 `createHistory/pushHistory(coalesce,limit)/undo/redo/canUndo/canRedo` · 각 반환 계약 `{history,body,changed}` · 베이스라인/코얼레싱/상한/동일-body 규칙 · 테스트 수)를 한 줄 요약. **step1이 import 경로·시그니처·반환 shape을 알 수 있게 담아라.**
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 37 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- body 문자열을 `deserialize`/`JSON.parse`로 파싱하거나 정규화하지 마라. 이유: 정규화는 step1의 `serialize`가 이미 담당한다 — 여기서 또 하면 "동일 body" 판정이 어긋나 헛 스냅샷/중복 undo 단계가 생긴다.
- 코얼레싱으로 베이스라인(entries[0])을 교체하지 마라. 이유: 문서를 연 최초 상태로 되돌릴 수 없게 되어 데이터 유실이다(되돌리기 미구현 시절 phase 29~32 stale 버그가 "복구 불가"였던 이유와 동일 계열).
- WriterPage.jsx·Editor.jsx·editorShortcuts.js·editorContent.js를 이 step에서 수정하지 마라. 이유: 이 step은 순수 모델 신설만 — 결선·키 인터셉트·탭 매핑은 step1이다.
- React state/ref/effect나 Date.now·타이머를 이 모듈에 넣지 마라. 이유: 순수 모델이어야 단위 테스트가 결정적이다. 시각 기반 코얼레싱 판정(now 비교)은 step1(WriterPage)이 하고, 이 모델은 `coalesce` 불리언만 받는다.
- 기존 테스트를 깨뜨리지 마라.
