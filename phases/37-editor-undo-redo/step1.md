# Step 1: writer-undo-redo

step0의 `editorHistory` 모델을 WriterPage에 결선해 **편집 메뉴 되돌리기(edit.undo)·다시실행(edit.redo)**와 **키보드 Ctrl+Z / Ctrl+Shift+Z**를 완성한다. 히스토리는 **탭(문서)별로 격리**되고, 본문 스냅샷 캡처는 **`commitBody` 단일 choke point**에서만 일어난다. 이 step은 `web/src/view/editorShortcuts.js`(키 프레디킷 2개 추가)와 `web/src/view/WriterPage.jsx`(결선)만 변경한다. **Editor.jsx는 건드리지 않는다.**

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도를 파악하라(라인 번호는 대략치 — 반드시 **심볼명으로 grep**해 정확 위치를 확정하라):

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — View←Controller←Model, 서버 호출은 controller 경유; DB 비파괴).
- `docs/news.md` L182(편집 메뉴 — **되돌리기, 다시실행**, 그리고 같은 줄의 **(계속)삽입 Ctrl+Y**), L178(우클릭 메뉴 단축키 목록 — **되돌리기/다시실행에 대응하는 Ctrl+Z/Ctrl+Y 문구가 없음**), L170("(끝)" 마커 뒤 입력 차단), L173(IME 조합 중 무개입).
- `web/src/view/editorHistory.js` — **step0 신설.** `createHistory(initialBody)` · `pushHistory(history, nextBody, {coalesce, limit}) → history` · `undo(history)/redo(history) → {history, body, changed}` · `canUndo/canRedo`. (step0 요약이 프롬프트에 함께 전달된다.)
- `web/src/view/editorShortcuts.js` — **변경 대상(프레디킷 추가).** 기존 키 프레디킷 패턴: `isDeleteLine`(Ctrl+D), `isInsertContinueMarker`(Ctrl+Y — `ctrlKey && !altKey && key==='y'`), `isPasteOriginal`(Alt+V). **레이아웃 무관하게 `e.code`도 함께 보는 관례**(예: `e.key==='z' || e.code==='KeyZ'`)를 따르라.
- `web/src/view/WriterPage.jsx` — **주 변경 대상.** 특히:
  - import 블록(L34~73) 및 `MENU_ENABLED`(L97) — 편집 결선 목록.
  - `commitBody`(L305~308) — **본문 변경 단일 choke point**(`updateField('body',...)` + `updateField('title', bodyTitle(...))`). **여기가 유일한 캡처 지점이 된다.**
  - `onTextChange`(L312~314) — 타이핑 경로(Editor onInput→여기→commitBody). **코얼레싱 신호를 켤 유일한 경로.**
  - `activeTabId`·`activeTab`·`tabs`(L108~113, controller 반환) · `body`(L225) · `blocks`(L226) · `isMapping`(L223).
  - `lastCaretRef`(L229) 및 그 아래 **탭 전환 렌더-중 조정 블록**(L234~249: `if (caretTabId !== activeTabId) { ... }` — lastCaretRef/statusCaret/spell/tableDialog/metaDialog를 리셋). **히스토리는 여기서 리셋하지 않는다**(탭별 보존이 목적 — 아래 §탭 수명 참조).
  - `onKeyDown`(L873~924) — 키 인터셉트 구역(`isFindReplace`→`isGlyphInput`→`isPasteOriginal`→`isInsertEndMarker`→`isInsertContinueMarker`→Ctrl+D/Backspace/Delete). **여기에 Ctrl+Z/Ctrl+Shift+Z를 추가**(insertContinue와 동일한 위치·매핑 가드 관례).
  - `onMenuSelect`(L608~803) — 편집 dispatch 구역. `edit.insertEnd`/`edit.insertContinue`(L771~772) 근처에 `edit.undo`/`edit.redo` 추가.
  - `file.recover` 핸들러(L690~699) — 현재 `Object.entries(draft).forEach(([k,v]) => updateField(k,v))`로 body를 **commitBody 우회**해 반영한다(아래 §recover 참조).
  - `onAction`(L1133~1150) · `onSaveMapping`(L1153~1158) — 송고/보류/KILL/매핑 저장 성공 후 `resetTabToBlank`가 일어나는 지점(아래 §탭 수명 리셋).
- `web/src/controller/useWriteController.js` — 탭 모델 이해용(수정 대상 아님). `activeTab.id`(탭 식별자, 안정) · `resetTabToBlank(id)`(송고/보류/KILL·매핑 저장 성공 시 **탭 id는 유지하고 fields만 blank로** 교체) · `removeTab`/`closeTab`(× 버튼·SSE force-unlock) · `updateField`(매핑 모드는 `body`만 허용).
- `web/src/view/WriterPage.test.jsx` — 갱신 대상 기존 테스트(아래 §기존 테스트 갱신)와 헬퍼(`openWith`/`openTopMenu`/`editMenuItem`/`within`/`focusCaretAtLine` 등) 스타일.

## 배경 (자기완결) — 반드시 숙지할 아키텍처 사실

1. **본문(body)은 markupVersion 문자열**이다. `activeTab.fields.body`가 그 문자열, `blocks = deserialize(body)`. `commitBody(nextBody)`는 직렬화된 body 문자열을 받아 `updateField('body', nextBody)` + 제목 재동기화를 한다. **모든 본문 변경(타이핑·(끝)/(계속)삽입·약물·날짜·약어·간체번체·찾기바꾸기·줄삭제·정렬·대소문자·지우기·임베드 삽입/삭제·표·붙여넣기)이 `commitBody`를 지난다**(verified). 따라서 `commitBody`가 히스토리 캡처의 **단일 지점**이다.

2. **Editor는 body(blocks) 변경을 자동 반영한다.** `<Editor key={activeTabId} blocks={blocks} .../>`(L1219~1231). undo/redo가 `commitBody(과거 body)`를 호출하면 blocks prop이 바뀌고, Editor의 echo-vs-structural 판정이 이를 **structural**로 보아 편집 div를 remount하며 복원된 본문을 그린다. **그래서 Editor.jsx를 수정할 필요가 없다** — DOM 직접 조작 금지, 복원은 commitBody→prop→remount 경로만.

3. **Ctrl+Y는 이미 점유**되어 있다 — `isInsertContinueMarker`가 Ctrl+Y를 "(계속)삽입"으로 가로채며 `e.preventDefault()`로 **브라우저 네이티브 redo를 이미 무력화**한다(onKeyDown L903~907). 그러므로 redo에 Ctrl+Y를 쓸 수 없고, 네이티브 redo는 이미 죽어 있다.

4. **네이티브 Ctrl+Z(브라우저 contentEditable undo)는 제어 상태와 어긋난다.** 우리는 structural 변경마다 편집 div를 remount하는데, remount는 브라우저의 네이티브 undo 스택을 지운다. 따라서 네이티브 Ctrl+Z는 신뢰할 수 없고, 제어 히스토리와 이원화되면 서로 충돌한다. 코드베이스는 이미 네이티브 redo(Ctrl+Y)를 가로채는 선례가 있다.

5. **탭 전환 렌더-중 조정 블록**(L234~249)은 lastCaretRef·statusCaret·다이얼로그 등 **문서-로컬 임시 좌표**를 탭 전환 시 리셋한다. 히스토리는 이와 반대다 — **탭마다 보존**되어야 한다(다른 탭으로 갔다 와도 그 탭의 undo 스택이 살아 있어야 함). 그래서 히스토리는 이 리셋 블록에 넣지 않고, **탭 id로 키잉된 Map**에 보관한다.

## 설계 결정 (이 phase의 범위 — 못박음)

- **undo 대상 = 본문(body)만.** 제목은 commitBody가 body에서 파생하므로 자동 포함. 공통정보(작성자/지역/내용/속성/엠바고 등 메타)는 undo 대상이 **아니다**(updateField 직접 경로 — 에디터 본문 히스토리와 무관). 근거: news.md 되돌리기는 에디터 본문 기능이고, 범위 최소화 원칙(본문만이 기본).
- **캡처 지점 = `commitBody` 단일 지점.** 분산 금지.
- **탭별 격리 = 탭 id 키 Map(ref).** 히스토리는 세션-로컬(휘발) — sessionStorage에 저장하지 않는다(새로고침 후 undo 스택 미보존은 허용 — 표준).
- **키보드 = Ctrl+Z(되돌리기), Ctrl+Shift+Z(다시실행).** 둘 다 `preventDefault`(네이티브 undo/redo 차단). Ctrl+Y는 그대로 insertContinue(불변). 이들은 Ctrl+D/Ctrl+F/Alt+Y처럼 **하드코딩된 표준 편집 단축키**이며, 환경설정 '키조합 인터셉트'(사용자 지정 약물/기업코드 — 다음 phase)와 **무관·무충돌**이다.
- **매핑 모드 = undo/redo no-op.** 아래 §매핑 정책.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 1) editorShortcuts.js — 키 프레디킷 2개 추가 (순수)

`isInsertContinueMarker` 근처에 추가한다(기존 스타일·code 병행 관례 준수):

```js
// Ctrl+Z / Cmd+Z — 되돌리기(undo). Shift 없이(Shift+Z는 redo). Alt 없이(다른 조합 오인 방지).
export function isUndo(e) {
  return !!(e && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey
    && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ'));
}

// Ctrl+Shift+Z / Cmd+Shift+Z — 다시실행(redo). Ctrl+Y는 이미 "(계속)삽입" 점유라 redo에 쓰지 않는다.
export function isRedo(e) {
  return !!(e && (e.ctrlKey || e.metaKey) && !e.altKey && e.shiftKey
    && (e.key === 'z' || e.key === 'Z' || e.code === 'KeyZ'));
}
```

테스트(`editorShortcuts.test.js`): Ctrl+Z→isUndo true·isRedo false, Ctrl+Shift+Z→isRedo true·isUndo false, Ctrl+Y→둘 다 false(insertContinue 불간섭 회귀), Alt+Z/그냥 Z→둘 다 false, `e.code==='KeyZ'`만으로도 인식(레이아웃 무관).

### 2) WriterPage.jsx — import + MENU_ENABLED

- `import { createHistory, pushHistory, undo as undoHistory, redo as redoHistory } from './editorHistory.js';` (이름 충돌 피해 alias 권장.)
- `editorShortcuts.js` import 목록(L50~54)에 `isUndo, isRedo` 추가.
- `MENU_ENABLED`(L97)에 `'edit.undo', 'edit.redo'` 추가.

### 3) 탭별 히스토리 저장소 (ref) + 상수

WriterPage 함수 본문 상단(다른 ref들 근처)에 둔다:

```js
// 탭(문서)별 본문 히스토리 — 탭 id → editorHistory 상태. 세션-로컬(휘발, sessionStorage 미저장).
// 탭 전환에도 보존(탭별 격리 목적) — 리셋은 탭 닫기(prune)·문서 리셋(submit/매핑저장 성공)에서만.
const historiesRef = useRef(new Map());
// undo/redo 적용 중 commitBody 재캡처 억제 플래그(적용은 캡처를 만들면 안 됨 — 루프 방지).
const applyingHistoryRef = useRef(false);
// 코얼레싱 시각/탭 미러 — 같은 탭에서 짧은 간격의 '타이핑' 연속 커밋을 top 교체로 합친다.
// wasTyping: 직전 커밋이 타이핑이었는지 — 코얼레싱(top 교체)은 '직전도 타이핑'일 때만 지속한다(편집 op 스냅샷 보호, §4).
const lastCommitRef = useRef({ tabId: null, at: 0, wasTyping: false });
```

모듈 상수(파일 상단 상수 구역):
```js
const HISTORY_LIMIT = 100;   // 탭별 최대 스냅샷 수(메모리 상한 — body 문자열 × 100 × 열린 탭. phase 20 이후 이미지는 업로드 경로라 base64 폭증 없음).
const COALESCE_MS = 500;     // 같은 탭 타이핑 연타를 하나의 undo 단계로 합치는 시간 창.
```

**베이스라인 lazy 시드(렌더 중 조정 — L234~249 caretTabId 블록과 동형 패턴)**: 활성 탭의 히스토리가 없으면 현재 body로 생성한다. ref 지연 초기화라 렌더 중 안전하다:
```js
// 활성 탭 히스토리 lazy 시드 — 없으면 현재 본문을 베이스라인으로. (신규 탭/편집 진입 탭 모두 이 경로로 시드.)
if (!historiesRef.current.has(activeTabId)) {
  historiesRef.current.set(activeTabId, createHistory(body));
}
```
(이 블록은 `body`/`activeTabId`가 계산된 이후, 렌더 반환 전에 둔다. setState를 부르지 않으므로 caretTabId 블록처럼 렌더-중 실행이 안전하다.)

**못박음(load-bearing)**: 이 렌더-중 시드는 **변경 前 body(현재 렌더의 `body`)를 베이스라인으로 캡처하는 유일한 지점**이다. 최초 편집 시 commitBody가 이미 채워진 히스토리에 첫 스냅샷을 push하므로, 시드가 없으면 "편집 이전 상태"가 스택에 없어 최초 편집으로 되돌릴 수 없다. 이 시드를 제거하거나 commitBody의 히스토리 조회를 **변경 後 nextBody 폴백**(`createHistory(nextBody)`)으로 대체하지 마라(§4·§금지사항 — nextBody는 이미 바뀐 본문이라 베이스라인이 부정확해진다).

### 4) commitBody에 캡처 결선 (단일 지점)

`commitBody`를 확장한다 — **적용 중이 아니면** 활성 탭 히스토리에 스냅샷을 쌓는다. 타이핑 경로만 코얼레싱한다:

```js
// 두 번째 인자는 선택 — onTextChange(타이핑)만 { coalesce:true }를 넘긴다. 나머지 호출부는 인자 없이 그대로(기본 false).
const commitBody = (nextBody, { coalesce = false } = {}) => {
  updateField('body', nextBody);
  updateField('title', bodyTitle(nextBody));
  if (applyingHistoryRef.current) return;               // undo/redo 적용 커밋은 캡처하지 않음(루프 방지).
  const now = Date.now();                                // 비결정 시각은 여기서만(순수 모델은 coalesce 불리언만 받음 — insertDate의 Date.now 패턴).
  const last = lastCommitRef.current;
  // 코얼레싱(top 교체)은 이번 커밋이 타이핑이고 '직전 커밋도 타이핑'(last.wasTyping)이며 같은 탭·시간창일 때만 지속한다.
  // last.wasTyping을 빼면 정렬/줄삭제 등 coalesce=false 편집 op 직후 시간창 내 첫 타이핑이 그 op 스냅샷을 top-교체로
  // 덮어 op의 독립 undo 단계가 사라진다(리뷰 게이트 minor). 연타 코얼레싱 의도는 그대로 유지된다.
  const coalesceNow = coalesce && last.wasTyping && last.tabId === activeTabId && (now - last.at) < COALESCE_MS;
  const hist = historiesRef.current.get(activeTabId); // 렌더 시드(§3)가 항상 채워둔다 — 폴백(createHistory(nextBody))에 의존하지 않는다(베이스라인 부정확 방지).
  historiesRef.current.set(activeTabId, pushHistory(hist, nextBody, { coalesce: coalesceNow, limit: HISTORY_LIMIT }));
  lastCommitRef.current = { tabId: activeTabId, at: now, wasTyping: coalesce };
};
```

`onTextChange`(타이핑)만 코얼레싱을 켠다:
```js
const onTextChange = (text, editedBlocks) => {
  commitBody(serializeBodyFromBlocks(editedBlocks), { coalesce: true });
};
```
**다른 commitBody 호출부는 전부 그대로 둔다**(기본 coalesce=false) — 즉 타이핑은 연타가 한 단계로 합쳐지고, 개별 편집 op(임베드/표/붙여넣기/정렬/삭제/마커 등)는 각자 하나의 undo 단계가 된다.

### 5) 되돌리기/다시실행 핸들러

```js
// 되돌리기 — 활성 탭 히스토리에서 이전 스냅샷을 commitBody로 복원(적용 플래그로 재캡처 억제).
const doUndo = () => {
  if (isMapping) return;                                 // 매핑 no-op(§매핑 정책)
  const hist = historiesRef.current.get(activeTabId);
  const r = undoHistory(hist);
  if (!r.changed) return;                                // 베이스라인 — no-op
  historiesRef.current.set(activeTabId, r.history);
  applyingHistoryRef.current = true;
  commitBody(r.body);                                    // body 복원 + 제목 재동기화(캡처는 억제됨)
  applyingHistoryRef.current = false;
};
// 다시실행 — 대칭.
const doRedo = () => {
  if (isMapping) return;
  const hist = historiesRef.current.get(activeTabId);
  const r = redoHistory(hist);
  if (!r.changed) return;
  historiesRef.current.set(activeTabId, r.history);
  applyingHistoryRef.current = true;
  commitBody(r.body);
  applyingHistoryRef.current = false;
};
```
**캐럿 복원은 강제하지 않는다**(setPendingCaretLine 미호출) — 메뉴 클릭 시 에디터는 blur 상태라 Editor가 포커스를 가로채지 않고, Ctrl+Z 시엔 Editor의 wasFocused 복원이 현재 줄에 캐럿을 되돌린다(기존 remount 복원 경로). 정밀 캐럿 복원은 이 범위 밖(과잉 설계 금지).

### 6) 메뉴 dispatch (편집 구역)

`edit.insertEnd`/`edit.insertContinue`(L771~772) 근처, **매핑 가드(L683 `if (isMapping) return;`) 뒤**에 둔다(doUndo/doRedo 내부에도 매핑 가드가 있어 이중 방어):
```js
if (id === 'edit.undo') { doUndo(); return; }
if (id === 'edit.redo') { doRedo(); return; }
```

### 7) 키보드 인터셉트 (onKeyDown)

`isInsertContinueMarker` 블록(L903~907) 바로 아래, Ctrl+D/Backspace 조기 return(L908~909)보다 **위**에 둔다. `isFindReplace`가 매핑에서 `preventDefault`는 하되 다이얼로그는 안 여는 관례(L879~883)와 동형:
```js
if (isUndo(e)) {
  e.preventDefault();      // 네이티브 브라우저 undo 차단(제어 히스토리와 이원화 방지)
  doUndo();                // 내부 매핑 가드 — 매핑이면 no-op
  return;
}
if (isRedo(e)) {
  e.preventDefault();
  doRedo();
  return;
}
```
IME 조합 중 무개입 가드(L876 `isComposing/keyCode===229` 조기 return)가 이미 위에 있으므로 조합 중엔 도달하지 않는다(그대로 둔다).

### 8) 탭 수명 — prune(닫기) + 리셋(문서 전환)

**(a) 닫힌 탭 prune(메모리)** — 열려 있는 탭 집합에 없는 히스토리 키를 지운다. ×/파일 닫기/SSE force-unlock/마지막 탭 등 **모든 닫기 경로**를 한 곳에서 처리한다:
```js
useEffect(() => {
  const live = new Set(tabs.map((t) => t.id));
  for (const key of Array.from(historiesRef.current.keys())) {
    if (!live.has(key)) historiesRef.current.delete(key);
  }
}, [tabs]);
```

**(b) 문서 리셋(같은 탭 id, 새 문서)** — 송고/보류/KILL·매핑 저장이 성공하면 `resetTabToBlank`가 **탭 id는 유지한 채 fields를 blank**로 바꾼다. 이때 그 탭의 히스토리를 지워야 한다 — 안 지우면 undo가 방금 송고한 기사의 본문을 빈 새 기사 탭에 되살린다(문서-로컬 상태 이월 = phase 29~32 계열 버그). 성공 직후 명시 삭제한다:
```js
// onAction 내부 — 리셋 대상 탭 id를 기존 key 캡처와 대칭으로 await 전에 잡아둔다:
const key = activeTab.articleId || activeTab.id;   // (기존)
const histTabId = activeTab.id;                    // 리셋 대상 탭 id(resetTabToBlank가 유지) — key와 대칭으로 await 전 캡처.
const r = await submit(action);                    // (기존)
if (r && r.ok) { clearDraft(key); historiesRef.current.delete(histTabId); }
// onSaveMapping도 동일 — const histTabId = activeTab.id; 를 await(saveMapping) 전에 캡처해 성공 시 delete.
```
삭제 후 다음 렌더의 lazy 시드가 blank body로 베이스라인을 다시 만든다(§3). **주의**: 삭제 키는 `resetTabToBlank`가 유지하는 `activeTab.id`(탭 id)여야 한다 — clearDraft의 `key`(=articleId||tab.id)와 다를 수 있으니 혼동하지 마라. (기능 차이는 없으나 `key`와 대칭으로 await 전에 잡아 stale 캡처 오해를 없애고 가독성을 맞춘다.)

### 9) file.recover — body를 commitBody로 반영

현재 `file.recover`는 `Object.entries(draft).forEach(([k,v]) => updateField(k,v))`로 body까지 updateField로 직접 쓴다(commitBody 우회 → 캡처 누락 + 히스토리 베이스라인과 불일치). **body만 commitBody 경로로** 돌린다(나머지 필드는 updateField 유지, title은 commitBody가 body에서 파생):
```js
Object.entries(draft).forEach(([k, v]) => {
  if (k === 'body') commitBody(v);        // 복구 본문을 캡처 지점으로(undo 가능 + 제목 파생)
  else if (k !== 'title') updateField(k, v); // title은 commitBody가 body에서 재동기화(중복 방지)
});
```
결과: 복구가 하나의 undo 단계가 되고(복구 전으로 되돌리기 가능), 히스토리 베이스라인 불일치가 사라진다. (title을 updateField로 또 쓰지 않는 것은 commitBody의 제목 파생과 이중 기록을 피하기 위함 — 기능상 draft.title은 bodyTitle(draft.body)와 같아야 정상.)

### §매핑 정책 (못박음)

undo/redo는 **매핑 모드에서 no-op**이다(doUndo/doRedo 첫 줄 `if (isMapping) return;` + 메뉴는 매핑 가드 뒤 배치 + 키는 preventDefault만). 근거:
- phase 36 클립보드 5종(잘라내기/붙여넣기 등 본문 편집 항목)도 매핑에서 no-op — 편집 메뉴 본문-편집 항목의 일관된 정책.
- 매핑은 임베드 전용 제한 편집(본문 텍스트 잠금, updateField가 `body`만 허용). undo가 body 스냅샷을 복원하면 이론상 잠긴 텍스트를 건드릴 위험이 있어, 보수적으로 차단한다(본문-only 불변식 보호).
- 캡처 자체는 매핑에서도 commitBody가 수행하지만(임베드 변경), 매핑 탭은 매핑으로 유지되므로 그 히스토리는 소비되지 않고 무해하다.
- (검토됨·기각: "매핑에서 임베드만 undo 허용"안 — 텍스트-불변 판정을 매 스냅샷 비교해야 해 복잡·위험. 최소·안전을 택함.)

### §기존 테스트 갱신 (WriterPage.test.jsx)

**먼저 방어적으로 전수 확인하라** — `되돌리기` 또는 `다시실행` + `toBeDisabled`(비활성 단언)를 **grep으로 모두 찾아** 아래 목록 외 누락이 없는지 확인한다. phase 36이 "미결선 예시"로 되돌리기/다시실행을 써 놨기 때문에, edit.undo/edit.redo 결선 시 이 단언들이 전부 거짓이 되어 `test:web`(AC)이 깨진다:

- **L1420~1430** `it('활성 항목 외(되돌리기·다시실행)는 여전히 비활성이다')` — `되돌리기`·`다시실행` 둘 다 `toBeDisabled`. 
- **L2482~2489** `it("활성 항목 외(다시실행·되돌리기)는 여전히 비활성이다(회귀)")` — 어순만 다른 **near-duplicate**.
- **L5213~5215** `editMenuItem('되돌리기')/('다시실행') …toBeDisabled()`.

**갱신 방법**: phase 37 이후 편집 메뉴는 전 항목이 활성이 되므로, "미결선 비활성 예시"를 **여전히 미결선인 다른 메뉴 항목**으로 바꾼다. 미결선 확정 항목(EditorMenuBar.jsx·MENU_ENABLED 대조): 도구 `사진발행/DB등록`(tools.publishPhoto)·`UI 언어 설정`(tools.uiLanguage), 도움말 `도움말 열기`(help.open)·`에디터 정보`(help.about). **권장: 도구 `사진발행/DB등록`**(백엔드/DB 필요 — 명확히 out-of-scope). 각 테스트에서 해당 top 메뉴(예: `openTopMenu('도구')` → `screen.getByTestId('menu-도구')`)를 열고 그 항목이 `toBeDisabled`임을 단언하도록 바꾸고, 주석 근거를 갱신하라. 그리고 **되돌리기/다시실행이 이제 활성**임을 같은(또는 인접) 테스트에서 positive로 단언하라(`editMenuItem('되돌리기')).toBeEnabled()`).

(라인 번호는 대략치 — 반드시 문자열/심볼 grep으로 확정하고, 위에 없는 추가 비활성 단언이 있으면 같은 원칙으로 함께 갱신하라. phase 36 step1이 남긴 near-duplicate 다수 존재.)

### §신규 테스트 (WriterPage.test.jsx)

핵심 시나리오를 커버하라(헬퍼·모킹은 기존 스타일 재사용):
- **되돌리기/다시실행 활성**: 편집 메뉴에서 `되돌리기`·`다시실행`이 `toBeEnabled`(위 갱신과 통합 가능).
- **본문 되돌리기 왕복**: 본문을 2회 변경(예: 편집 op로 body가 바뀌는 경로 — 대소문자 변환/줄삭제/약물삽입 등 결정적 헬퍼)한 뒤 `되돌리기` → 이전 본문 복원(Editor 렌더/`activeTab.fields.body` 확인), `다시실행` → 재적용.
- **redo 분기 절단**: 변경→되돌리기→새 변경 후 `다시실행`이 no-op(이전 redo 소실).
- **키보드**: 에디터에 Ctrl+Z `keydown`→되돌리기 발동·`preventDefault` 호출, Ctrl+Shift+Z→다시실행. Ctrl+Y는 여전히 "(계속)"삽입(회귀 — 되돌리기 아님).
- **탭별 격리**: 탭A 편집→탭B로 전환·편집→탭A로 복귀 시 탭A의 되돌리기가 **탭A 본문만** 되돌리고 탭B 불변(문서-로컬 이월 없음 — phase 29~32 계열 회귀 잠금). 탭B에서 되돌리기가 탭A 내용을 건드리지 않음.
- **문서 리셋 후 히스토리 격리**: (가능하면) 편집 탭 송고/매핑 저장 성공 → 빈 새 기사 탭으로 전환 후 `되돌리기`가 **송고한 기사 본문을 되살리지 않음**(historiesRef.delete 확인 — resetTabToBlank 후 undo no-op 또는 blank 베이스라인).
- **매핑 no-op**: 매핑 모드에서 되돌리기/다시실행이 본문을 바꾸지 않음(메뉴·키 모두).
- **코얼레싱**(선택, 가능하면): 타이핑 연속 입력(onTextChange 다회, 짧은 간격) 후 되돌리기 1회가 그 타이핑 버스트를 되돌림(개별 글자 단위가 아님). 시각 제어가 어려우면 최소한 "개별 편집 op는 각자 한 단계"만 단언.

**테스트 팁**: 키보드는 `fireEvent.keyDown(editor, { key:'z', ctrlKey:true })` / `{ key:'z', ctrlKey:true, shiftKey:true }`. `preventDefault` 확인은 `fireEvent` 반환값 또는 spy. 탭 전환은 기존 탭 헬퍼(`addTab`/탭 클릭)·`focusCaretAtLine` 패턴 재사용. 본문 변경은 DOM 타이핑보다 **결정적 편집 op 메뉴 클릭**(예: 대문자 변환·줄삭제)이 안정적이다.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — 백엔드·DB 무관. `npm test`(node --test) 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - 변경이 `editorShortcuts.js`(프레디킷 2개+테스트)·`WriterPage.jsx`(+테스트)에 국한되는가? **`Editor.jsx`·`editorHistory.js`가 diff에 없는가?**
   - 히스토리 캡처가 `commitBody` **단일 지점**에서만 일어나는가? undo/redo 적용이 `applyingHistoryRef`로 재캡처를 억제하는가?
   - 히스토리가 **탭 id 키 Map**으로 격리되고, 탭 전환에 보존되며, 닫기(prune effect)·문서 리셋(submit/매핑저장 성공 delete)에서만 제거되는가?
   - undo/redo 적용이 `commitBody→blocks prop→Editor remount` 경로만 쓰고 **DOM 직접 조작이 없는가**?
   - 매핑 모드에서 undo/redo가 본문/DOM을 바꾸지 않는가?(메뉴·키 모두)
   - Ctrl+Z/Ctrl+Shift+Z가 `preventDefault`로 네이티브 undo/redo를 차단하고, Ctrl+Y(insertContinue)가 회귀 없이 유지되는가?
   - 갱신한 기존 비활성 단언(되돌리기/다시실행)이 미결선 항목으로 교체돼 그린인가? sessionStorage에 히스토리를 저장하지 않는가?
   - ADR-003(서버 호출 미추가)·CLAUDE.md(DB 비파괴·client 전용·UTF-8)?
3. 결과에 따라 `phases/37-editor-undo-redo/index.json`의 step1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (isUndo/isRedo 프레디킷·MENU_ENABLED edit.undo/redo·historiesRef 탭 Map·commitBody 캡처+applyingHistoryRef+코얼레싱·doUndo/doRedo·Ctrl+Z/Ctrl+Shift+Z·prune effect·submit/매핑저장 리셋 delete·file.recover commitBody 경로·매핑 no-op·갱신/신규 테스트)를 한 줄 요약. **phase 마지막 step이므로 phase 전체 산출물을 담아라.**
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 37 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- undo/redo 복원에서 contentEditable/DOM을 직접 조작하지 마라. 이유: 복원은 `commitBody(과거 body)`→blocks prop→Editor remount 단일 경로여야 한다(검증된 렌더 경로 — DOM을 직접 만지면 "1줄=1블록" 불변식·캐럿 안정이 깨진다).
- 히스토리 캡처를 `commitBody` 밖(개별 핸들러·Editor·onInput 등)에 흩뿌리지 마라. 이유: 캡처 지점이 분산되면 경로 누락으로 일부 편집이 되돌려지지 않는다(단일 choke point가 목적).
- 렌더-중 베이스라인 시드(§3)를 제거하거나 commitBody의 히스토리 조회를 변경 後 body 폴백(`createHistory(nextBody)`)으로 대체하지 마라. 이유: 렌더 시드가 **변경 前 body를 베이스라인으로 캡처하는 유일한 지점**이다 — 제거하고 nextBody 폴백에 의존하면 베이스라인이 이미 바뀐 본문이 되어 최초 편집 이전 상태로 되돌릴 수 없다.
- 코얼레싱 지속 조건에서 `last.wasTyping`(직전 커밋 타이핑 여부)을 빼지 마라. 이유: 빼면 정렬/줄삭제 등 편집 op 직후 시간창 내 첫 타이핑이 그 op 스냅샷을 top-교체로 덮어 op의 독립 undo 단계가 사라진다.
- undo/redo 적용 커밋을 다시 캡처하지 마라(`applyingHistoryRef` 생략 금지). 이유: 적용이 새 스냅샷을 만들면 무한 루프/스택 오염이 된다.
- 히스토리를 탭 전환 조정 블록(L234~249)에서 리셋하지 마라. 이유: 히스토리는 탭별 **보존**이 목적이다 — 거기서 지우면 다른 탭 갔다 오면 undo가 사라진다.
- 문서 리셋(송고/보류/KILL·매핑 저장 성공) 시 그 탭 히스토리를 지우는 것을 빼먹지 마라. 이유: 안 지우면 빈 새 기사 탭에서 undo가 방금 송고한 기사 본문을 되살린다(문서-로컬 상태 이월 = phase 29~32 Major 버그 계열).
- 히스토리를 sessionStorage나 tab.fields(컨트롤러 탭 상태)에 저장하지 마라. 이유: 휘발 세션-로컬 상태다 — 영속하면 sessionStorage 비대·직렬화 부담·새로고침 후 스택 이월 같은 예기치 않은 의미가 생긴다.
- redo에 Ctrl+Y를 쓰거나 insertContinue(Ctrl+Y)를 건드리지 마라. 이유: Ctrl+Y는 이미 "(계속)삽입" 점유다 — 재사용하면 기능이 충돌한다. redo는 Ctrl+Shift+Z.
- Editor.jsx·editorHistory.js·컨트롤러(useWriteController.js)·server를 이 step에서 수정하지 마라. 이유: 결선은 WriterPage(+editorShortcuts 프레디킷)만으로 완성된다 — 범위 밖 변경은 회귀 표면을 넓힌다.
- 갱신 대상 기존 비활성 단언(되돌리기/다시실행 + toBeDisabled)을 일부만 고치고 방치하지 마라. 이유: 최소 3곳(L1420·L2482·L5213, near-duplicate 포함)이 결선 시 전부 거짓이 된다 — grep 전수 확인 후 미결선 항목으로 교체하고 AC(test:web) 그린을 확인하라.
- 기존 테스트를 깨뜨리지 마라.
