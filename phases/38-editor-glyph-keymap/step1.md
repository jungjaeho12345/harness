# Step 1: writer-glyph-keymap-wiring

step0의 `editorGlyphKeymap` 매칭 모델을 WriterPage에 결선해 **사용자 키보드약물(glyphKeymap) 인터셉트**를 완성한다. 에디터에서 사용자가 등록한 키조합을 누르면 매칭된 약물이 캐럿 위치에 자동 삽입된다. 이 step은 **`web/src/view/WriterPage.jsx` 한 파일**만 변경한다(+ `WriterPage.test.jsx`). **Editor.jsx·editorShortcuts.js·editorGlyphKeymap.js·editorPrefs.js·server는 건드리지 않는다.**

## 읽어야 할 파일

먼저 아래를 읽고 설계 의도·기존 결선 구조를 파악하라(라인 번호는 대략치 — 반드시 **심볼명으로 grep**해 정확 위치를 확정하라):

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — View←Controller←Model; DB 비파괴; 표준 기능 우선).
- `docs/news.md` L214~215(사용자 키보드 약물), L178(예약 단축키 목록), L173(**IME 조합 중 무개입**), L170("(끝)" 마커 뒤 입력 차단).
- `web/src/view/editorGlyphKeymap.js` — **step0 신설.** `compileGlyphKeymap(items) → {combo,glyph}[]` · `matchGlyphKeymap(compiled, e) → string|null` · `parseKeyCombo` · `RESERVED_COMBOS`. (step0 요약이 프롬프트에 함께 전달된다.)
- `web/src/view/editorGlyph.js` — **재사용 대상(수정 안 함).** `insertGlyphAtCaret(blocks, caret, glyph) → { blocks, caretTextLine }`(caret=`{lineIndex,offset}`|null, 빈 glyph no-op, **"(끝)" 블록을 가리키면 폴백** — 마커 뒤 삽입 차단이 이미 내장).
- `web/src/view/WriterPage.jsx` — **주 변경 대상.** 특히:
  - `glyphKeymap` state(L141 근처) — 이미 `useState(() => loadEditorPrefs().glyphKeymap.items)` lazy 초기화가 있고, `onPrefsClose(applied)` 분기(L225 근처)에 `setGlyphKeymap(loadEditorPrefs().glyphKeymap.items)` 갱신이 **이미 결선**돼 있다(glyphFavorites와 동일 게이트). **새 로드 경로를 만들지 말고 이 state를 그대로 재사용**한다.
  - `onGlyphPick`(L412 근처) — **재사용할 안전 삽입 경로.** `if (isMapping) return;` → `caret = lastCaretRef.current` → `insertGlyphAtCaret(blocks, caret, glyph)` → `commitBody(serialize(r.blocks))` → `setPendingCaretLine(r.caretTextLine)`. 약물바·약물입력 다이얼로그와 **동일 소스·캐럿 규약**이다.
  - `matches` useMemo(L295 근처) — 파생 계산을 `useMemo`로 캐시하는 기존 패턴(컴파일 캐시의 본).
  - `onKeyDown`(L961~1025) — **키 인터셉트 구역.** 순서: IME 가드(L964) → `isFindReplace`(Ctrl+F) → `isGlyphInput`(Alt+O) → `isPasteOriginal`(Alt+V) → `isInsertEndMarker`(Alt+Y) → `isInsertContinueMarker`(Ctrl+Y) → `isUndo`(Ctrl+Z) → `isRedo`(Ctrl+Shift+Z) → `const ctrlD = isDeleteLine(e)` + `if (!ctrlD && e.key !== 'Backspace' && e.key !== 'Delete') return;`(L1009~1010) → Ctrl+D/Backspace/Delete 라인삭제. **삽입 지점은 아래 §배치에서 못박는다.**
  - `<Editor ... onKeyDown={isMapping ? undefined : onKeyDown} .../>`(L1329 근처) — 매핑 모드에서는 onKeyDown이 아예 붙지 않는다(매핑 무개입의 1차 방어).
  - `isMapping`(L231)·`blocks`(L234)·`lastCaretRef`(L237)·`commitBody`(L338)·`setPendingCaretLine`(L282).
- `web/src/view/Editor.jsx` — **수정 안 함.** 확인만: `handleKeyDown`(L354 근처)이 `if (onKeyDown) onKeyDown(e); if (e.defaultPrevented) return;`로 부모를 먼저 처리하고, `e.defaultPrevented`면 자신의 Enter/삽입 처리를 건너뛴다(우리가 매칭 시 `preventDefault`하면 Editor는 개입하지 않는다).
- `web/src/view/WriterPage.test.jsx` — 기존 테스트/헬퍼 스타일(특히 L3107~ '약물입력 다이얼로그' describe의 `seedPrefs({keymap})`·`createEvent.keyDown(box, {...})`·`fireEvent` 패턴, 캐럿 헬퍼 `focusCaretAtLine` 등). **키다운 시뮬레이션 관례를 그대로 재사용**한다.

## 배경 (자기완결) — 반드시 숙지할 아키텍처 사실

1. **`glyphKeymap` state는 이미 존재하고 이미 갱신된다.** 마운트 lazy-init(L141) + `onPrefsClose(applied)`의 `setGlyphKeymap`(L225). 현재 이 state는 GlyphInputDialog의 **참조 표시(`keymap={glyphKeymap}`, L1435 근처)에만** 쓰인다. 이 step은 같은 state를 **매칭용으로도** 소비할 뿐 새 저장/로드/구독을 추가하지 않는다.

2. **삽입은 `onGlyphPick` 재사용이 정답.** `onGlyphPick(glyph)`는 이미 (a) 매핑 no-op 가드, (b) `lastCaretRef` 캐럿 소스, (c) `insertGlyphAtCaret`(→"(끝)" 마커 뒤 차단 내장), (d) `commitBody(serialize(...))` 단일 경로, (e) `setPendingCaretLine`을 모두 담는다. keymap 매칭 분기는 **매칭된 glyph로 `onGlyphPick`을 호출**하기만 하면 된다 — DOM 직접 조작·별도 삽입 로직 금지.

3. **undo 결합은 자동(coalesce 없음).** `onGlyphPick`은 `commitBody(serialize(...))`를 **인자 없이**(기본 `coalesce=false`) 호출한다 → phase 37 규약상 **약물 삽입은 독립 undo 한 단계**가 된다(타이핑만 coalesce). 별도 처리 불필요.

4. **IME·매핑·예약키는 이미 방어된다.**
   - IME: onKeyDown 최상단 `isComposing/keyCode===229` 조기 return(L964)이 조합 중 keydown을 먼저 걸러낸다 → keymap 분기는 그 **뒤**라 조합 중엔 도달하지 않는다.
   - 매핑: `onKeyDown={isMapping ? undefined : onKeyDown}`(L1329)로 매핑 시 핸들러 미부착(1차) + `onGlyphPick` 내부 `isMapping` 가드(2차).
   - 예약키: Ctrl+F/Alt+O/Alt+V/Alt+Y/Ctrl+Y/Ctrl+Z/Ctrl+Shift+Z는 keymap 분기 **앞**에서 각각 조기 return(섀도잉 1차 차단). Ctrl+D와 브라우저 예약(Ctrl+A/C/X/V/B)은 keymap 분기 **뒤/미처리**지만 step0 `compileGlyphKeymap`이 `RESERVED_COMBOS` 충돌 항목을 이미 버려(2차 차단) 매칭 자체가 안 된다.

## 설계 결정 (이 phase의 범위 — 못박음)

- **매칭 캐시 = `useMemo([glyphKeymap])`.** keydown마다 재파싱하지 않는다 — `glyphKeymap` state가 바뀔 때(마운트·`onPrefsClose(applied)`)만 컴파일한다. 매칭은 O(n)(n=등록 항목 수, 소수) + step0의 빠른 탈출(수식어 없으면 즉시 null)로 일반 타이핑은 사실상 O(1).
- **삽입 경로 = `onGlyphPick` 재사용.** 새 삽입 로직·캐럿 소스·DOM 조작 없음. `lastCaretRef` 캐럿 규약을 약물바/약물입력과 공유(동일 소스).
- **onKeyDown 배치 = isRedo 조기 return 뒤, `const ctrlD` 앞**(아래 §배치). 예약 조기 return **뒤**, 라인삭제 바일아웃 **앞**.
- **매칭 시 `e.preventDefault()` + return.** 브라우저 기본(Ctrl+숫자 등)을 베스트에포트로 억제하고, Editor의 후속 처리(Enter 등)를 건너뛰게 한다.
- **범위 밖(넣지 마라)**: 맞춤법 하이라이트 effect(phase 39)·언어/입력모드(phase 40)·기업코드변환(Ctrl+B)·keymap 등록 UI 변경·live 캐럿 정밀 복원.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### 1) import + 컴파일 캐시(useMemo)

- import 블록(editorGlyph import 근처)에 추가:
  ```js
  import { compileGlyphKeymap, matchGlyphKeymap } from './editorGlyphKeymap.js';
  ```
- 기존 `matches` useMemo(L295 근처) 인근에 컴파일 캐시를 둔다(`glyphKeymap` state가 선언된 뒤):
  ```js
  // 사용자 키보드약물 컴파일 캐시 — keydown마다 재파싱하지 않게 glyphKeymap 변경 시(마운트·onPrefsClose(applied))만 컴파일한다.
  // compileGlyphKeymap이 예약 충돌·수식어 없는·빈 glyph 항목을 이미 걸러내 매칭 후보만 남긴다(step0).
  const compiledKeymap = useMemo(() => compileGlyphKeymap(glyphKeymap), [glyphKeymap]);
  ```
  (`useMemo`는 이미 import돼 있다 — L6 확인. `glyphKeymap` state·`setGlyphKeymap` 갱신은 이미 존재하므로 **새로 만들지 마라**.)

### 2) onKeyDown에 keymap 매칭 분기 (§배치 — 못박음)

`isRedo` 블록의 `return;`(L1007 근처) **바로 아래**, `const ctrlD = isDeleteLine(e);`(L1009) **바로 위**에 삽입한다:

```js
// 사용자 키보드약물(환경설정 glyphKeymap) — 하드코딩 예약 단축키(위 조기 return들)에 안 걸린 키만 여기 도달한다.
// compiledKeymap은 예약 조합(RESERVED_COMBOS)·수식어 없는·빈 glyph 항목을 이미 제외(step0) → 매칭되면 그 약물을
// 기존 안전 경로(onGlyphPick → insertGlyphAtCaret → commitBody)로 캐럿에 삽입한다. DOM 직접 조작 없음.
const keymapGlyph = matchGlyphKeymap(compiledKeymap, e);
if (keymapGlyph) {
  e.preventDefault();          // 브라우저 기본(Ctrl+숫자 등) 억제 + Editor 후속 처리(Enter) 건너뛰기.
  onGlyphPick(keymapGlyph);    // 내부 isMapping 가드·lastCaretRef 캐럿·insertGlyphAtCaret·commitBody·setPendingCaretLine.
  return;
}
```

**배치 근거(load-bearing)**:
- **예약 조기 return 뒤**: Ctrl+F/Alt+O/Alt+V/Alt+Y/Ctrl+Y/Ctrl+Z/Ctrl+Shift+Z는 이미 위에서 처리·return됐으므로 이 지점에 도달하지 않는다(섀도잉 1차 방어).
- **`const ctrlD` 앞**: L1010의 `if (!ctrlD && e.key !== 'Backspace' && e.key !== 'Delete') return;`가 **임의 조합(Ctrl+1 등)을 조기 return으로 삼켜버리기 전에** keymap을 먼저 본다. keymap 분기를 이 아래에 두면 Ctrl+1 같은 조합이 매칭되기도 전에 return돼 인터셉트가 죽는다.
- **Ctrl+D 섀도잉 방지**: Ctrl+D는 keymap 분기 **뒤**(L1009~)에서 처리되지만, step0 `compileGlyphKeymap`이 `Ctrl+D`를 `RESERVED_COMBOS` 충돌로 버려 `matchGlyphKeymap`이 Ctrl+D에 대해 null을 반환한다 → 분기를 그냥 통과해 실제 Ctrl+D 라인삭제로 falls through(2차 방어). Ctrl+Shift+D(비예약)를 매핑하면 여기서 매칭돼 삽입된다(정상).

### §기존 테스트 영향 점검 (WriterPage.test.jsx)

- **먼저 방어적으로 grep하라**: keymap을 seed한 채 **예약/일반 조합을 keydown**하고 "아무 일도 없음"을 단언하는 기존 테스트가 있는지 확인한다. 현재 대부분 테스트의 `seedPrefs` 기본 keymap은 비어 있어(`keymap: []`) 회귀 위험이 낮지만, `keymap: [{ keys: 'Ctrl+1', glyph: '★' }]`를 seed하는 참조-표시 테스트(L3212 근처)는 **Ctrl+1을 keydown하지 않고** 다이얼로그 텍스트만 단언하므로 그대로 통과해야 한다(확인하라).
- 참조 표시(GlyphInputDialog `keys → glyph`)는 **이 step에서 변경하지 않는다** — 표시 계약 회귀 없음.

### §신규 테스트 (WriterPage.test.jsx)

기존 '약물입력 다이얼로그' describe의 `seedPrefs`/키다운 헬퍼를 재사용해 신규 describe(예: '사용자 키보드약물 인터셉트')를 추가하고 아래를 커버하라:

- **기본 매칭 삽입**: `seedPrefs({ keymap: [{ keys: 'Ctrl+1', glyph: '★' }] })` 후 에디터에 캐럿을 두고 `fireEvent.keyDown(box, { key: '1', ctrlKey: true })` → 본문(`activeTab.fields.body`/에디터 렌더)에 `★` 삽입 + `preventDefault` 호출. 임베드·"(끝)" 불변.
- **한영/레이아웃(code 경로)**: `keymap: [{ keys: 'Ctrl+K', glyph: '§' }]` 후 `{ ctrlKey: true, code: 'KeyK', key: 'ㅏ' }` → `§` 삽입(code로 매칭).
- **예약 섀도잉 금지**: `keymap: [{ keys: 'Ctrl+F', glyph: '✕' }]` 후 Ctrl+F keydown → **찾기/바꾸기 다이얼로그가 열리고**(기존 동작 보존) 본문에 `✕`가 삽입되지 **않음**. `keymap: [{ keys: 'Ctrl+D', glyph: '✕' }]` + 라인 위 캐럿 후 Ctrl+D → **라인 삭제가 일어나고** `✕` 미삽입.
- **매핑 no-op**: 매핑 모드 탭에서 매핑된 조합 keydown → 본문 무변경(onKeyDown 미부착 + onGlyphPick 가드). (매핑에선 Editor에 onKeyDown이 없어 실제로는 box에 핸들러가 없음 — 기존 매핑 Ctrl+F 테스트 L2562 근처 패턴 참고.)
- **IME 조합 중 무개입**: 매핑된 조합을 `{ ...combo, isComposing: true }`(또는 `keyCode: 229`)로 keydown → 삽입 없음(IME 가드가 먼저 return).
- **미등록/수식어 없는 키 무개입**: keymap 비었을 때 임의 조합 keydown → 삽입 없음; 등록됐어도 **수식어 없는** 일반 타이핑(`{ key: '1' }`, ctrl 없음)은 삽입 트리거 안 됨(빠른 탈출).
- **약물 삽입 = 독립 undo 한 단계**(가능하면): 매핑 조합으로 삽입 후 되돌리기(Ctrl+Z 또는 편집>되돌리기)가 그 삽입만 되돌림(phase 37 회귀 — 삽입이 commitBody 기본 경로를 타는지 확인).

**테스트 팁**: 키다운은 `fireEvent.keyDown(box, { key:'1', ctrlKey:true })`, code 경로는 `{ ctrlKey:true, code:'KeyK', key:'ㅏ' }`. `preventDefault` 확인은 `createEvent.keyDown` + `fireEvent` 반환값(기존 Ctrl+F 테스트 L2444·L2506 패턴). 캐럿 배치·본문 변경 단언은 기존 약물입력/약물바 삽입 테스트(L3220~ ※ 삽입) 스타일 재사용.

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
   - 변경이 `WriterPage.jsx`(+`WriterPage.test.jsx`)에 **국한**되는가? **`Editor.jsx`·`editorShortcuts.js`·`editorGlyphKeymap.js`·`editorPrefs.js`·server가 diff에 없는가?**
   - keymap 매칭이 `useMemo([glyphKeymap])` 컴파일 캐시를 쓰고 keydown마다 재파싱하지 않는가?
   - 매칭 삽입이 **`onGlyphPick` 재사용**(insertGlyphAtCaret → commitBody)만으로 이뤄지고 DOM 직접 조작이 없는가?
   - keymap 분기가 **모든 예약 조기 return 뒤 + `const ctrlD` 앞**에 있는가? IME 가드 뒤인가?
   - 예약 조합(Ctrl+F/Ctrl+D/Alt+O/Ctrl+Z 등)이 keymap으로 **가려지지 않는가**(섀도잉 금지 — 테스트 잠금)?
   - 매핑 모드에서 인터셉트가 본문을 바꾸지 않는가? "(끝)" 마커 뒤 삽입이 insertGlyphAtCaret 내장 가드로 차단되는가?
   - 약물 삽입이 독립 undo 한 단계인가(coalesce 없음)?
   - ADR-003(서버 호출 미추가)·CLAUDE.md(DB 비파괴·client 전용·UTF-8)?
3. 결과에 따라 `phases/38-editor-glyph-keymap/index.json`의 step1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (compiledKeymap useMemo·onKeyDown 배치(isRedo 뒤/const ctrlD 앞)·onGlyphPick 재사용·preventDefault·예약 섀도잉 2차 방어·매핑/IME 무개입·신규 테스트)를 한 줄 요약. **phase 마지막 step이므로 phase 전체 산출물(step0 매칭 모델 + step1 결선)을 담아라.**
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 38 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- keymap 매칭 분기를 `const ctrlD = isDeleteLine(e)`/라인삭제 바일아웃(L1009~1010) **아래**에 두지 마라. 이유: L1010의 `if (!ctrlD && e.key !== 'Backspace' && e.key !== 'Delete') return;`가 Ctrl+1 같은 임의 조합을 매칭 전에 삼켜 인터셉트가 죽는다.
- keymap 매칭 분기를 예약 조기 return(isFindReplace~isRedo) **위**로 올리지 마라. 이유: 사용자 keymap이 표준 편집 단축키를 앞질러 가려(섀도잉) 조용히 죽인다 — 예약은 항상 먼저 매칭돼야 한다.
- IME 가드(`isComposing`/`keyCode===229`) 조기 return을 옮기거나 그 위로 keymap을 올리지 마라. 이유: 조합 중 키를 인터셉트하면 한글 입력이 깨진다(news.md L173 무개입 원칙).
- 삽입을 `onGlyphPick`(insertGlyphAtCaret → commitBody) 대신 DOM/contentEditable 직접 조작이나 새 삽입 로직으로 하지 마라. 이유: 안전 경로를 벗어나면 "(끝)" 차단·캐럿 규약·undo 결합·제목 재동기화가 깨진다(약물바/약물입력과 단일 소스 유지).
- keydown마다 `compileGlyphKeymap`/`parseKeyCombo`를 다시 부르지 마라(반드시 `useMemo([glyphKeymap])` 캐시). 이유: 매 키 입력에 전체 keymap 재파싱은 불필요한 낭비이며, step0가 재사용 가능한 컴파일 결과를 제공한 취지에 어긋난다.
- `glyphKeymap` state·`setGlyphKeymap`·`onPrefsClose` 갱신을 새로 만들지 마라(이미 존재·결선됨). 이유: 중복 로드 경로는 환경설정 적용 즉시 반영 게이트를 이원화한다.
- `editorGlyphKeymap.js`·`editorGlyph.js`·`Editor.jsx`·`editorShortcuts.js`·`editorPrefs.js`·server를 이 step에서 수정하지 마라. 이유: 결선은 WriterPage 한 파일로 완성된다 — 범위 밖 변경은 회귀 표면을 넓힌다.
- 맞춤법 하이라이트·언어/입력모드·기업코드변환(Ctrl+B)을 이 phase에 넣지 마라. 이유: 각각 phase 39/40 및 별도 작업 — 범위 최소화(한 step 한 관심사).
- 기존 테스트를 깨뜨리지 마라(특히 keymap 참조 표시 `keys → glyph`·기존 예약키 keydown 동작).
