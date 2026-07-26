# Step 2: overwrite-toggle

## 목표

상태표시줄의 **삽입/수정(overwrite) 표시를 실동작화**한다 — Insert 키로 삽입/수정 모드를 토글하고 상태표시줄이 그 상태를 표시한다. 이 step은 **토글 + 표시**까지만(실제 캐럿 뒤 글자 덮어쓰기 입력 로직은 step3). 변경 대상: `editorShortcuts.js`(Insert predicate) + `WriterPage.jsx`(overwrite state·Insert 토글·StatusBar prop). `StatusBar.jsx`는 이미 `overwrite` prop을 렌더하므로 **수정하지 않는다**(WriterPage에서 prop만 전달).

## 읽어야 할 파일

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — View←Controller←Model; 표준 기능 우선).
- `docs/news.md` — 상태표시줄 삽입/수정, 우클릭 단축키 목록(예약 조합), IME 조합 중 무개입 원칙.
- **`phases/38-editor-glyph-keymap/step0.md`, `phases/38-editor-glyph-keymap/step1.md`** — 예약 조합/키 인터셉트 관례의 권위 출처. 특히 `matchGlyphKeymap`의 **빠른 탈출**("e에 Ctrl/Alt/Meta가 하나도 없으면 스캔 없이 즉시 null")과 `parseKeyCombo`의 **실수식어 필수**(수식어 없는 조합은 파싱 실패). → 아래 §phase 38 전수 확인의 근거.
- `web/src/view/editorShortcuts.js` — 전체. **L17~19 `isDeleteLine`**(`!!(e && e.ctrlKey && !e.altKey && (...))` 형태 — 신규 predicate의 본), L44~52(`isGlyphInput`/`isPasteOriginal`의 `e.key`+`e.code` 병행 관례).
- `web/src/view/editorShortcuts.test.js` — predicate 단위 테스트 스타일(신규 `isToggleOverwrite` 테스트를 동형으로 추가).
- `web/src/view/StatusBar.jsx` — L11 `StatusBar({ text, caret, language, inputMode, overwrite = false })`, **L31 `{overwrite ? '수정' : '삽입'}`**(`data-testid="stat-mode"`). 이미 완성 — 수정 금지.
- `web/src/view/StatusBar.test.jsx` — L19~27(기본 `'삽입'`, `overwrite` → `'수정'`). 이 계약을 WriterPage 결선이 만족해야 한다.
- `web/src/view/WriterPage.jsx` — 특히:
  - L276~303(**탭 전환 조정 블록** `if (caretTabId !== activeTabId) { ... }` — 문서-로컬 좌표 리셋. **overwrite는 여기 넣지 마라** — 아래 §탭 격리 결정 근거).
  - L1068~1149(`onKeyDown` — L1071 IME 가드, L1074~1122 예약 조기 return들, L1123~1132 keymapGlyph, L1133~1134 `const ctrlD`/바일아웃). **Insert 토글 배치 지점 = L1071 IME 가드 바로 아래**.
  - **L1471 `<StatusBar text={blocksToText(blocks)} caret={statusCaret} language={language} inputMode={inputMode} />`**(L1470 주석 "overwrite는 기본값(placeholder) 유지"). 여기에 `overwrite={overwrite}` 추가 + 주석 갱신.
- `web/src/view/WriterPage.test.jsx` — 키다운 시뮬레이션 관례(`fireEvent.keyDown(box, {...})`), StatusBar `stat-mode` 단언 스타일.

## 배경 (자기완결)

- `StatusBar`는 이미 `overwrite` prop을 `'수정'`/`'삽입'`으로 렌더한다(L31). 현재 WriterPage는 이 prop을 **미전달**(기본 false → 항상 '삽입', L1470 placeholder 주석). 이 step은 overwrite state를 만들어 Insert로 토글하고 prop을 전달한다.
- `onKeyDown`은 매 keydown마다 `Editor.handleKeyDown`이 먼저 호출한다(부모 우선). L1071 IME 가드(`isComposing`/`keyCode===229`) 조기 return 뒤, L1074~1122 예약 조기 return, L1133~1134 `const ctrlD = isDeleteLine(e); if (!ctrlD && e.key !== 'Backspace' && e.key !== 'Delete') return;`가 있다. **Insert는 수식어 없는 키라 L1134 바일아웃에서 삼켜진다** — 따라서 토글 분기는 반드시 L1134 **위**에 둬야 한다. L1071 IME 가드 바로 아래가 가장 깨끗하다(다른 predicate와 무충돌·조기 실행).

### §탭 격리 결정 (전역 1개 — 못박음)

overwrite는 **전역 단일 state**(`useState(false)`, 영속 없음, 탭별 격리 없음)로 둔다. 근거:
1. overwrite는 **입력 모드**(키보드/세션 속성)이지 문서(탭) 속성이 아니다 — 실제 에디터(hwp/Word/브라우저)도 Insert 모드를 전역으로 다룬다.
2. **stale-carry 버그 계열(phase 29/30/31/32)을 애초에 만들지 않는다.** 그 버그들은 "문서-로컬 좌표"가 탭 전환에 이월돼 생겼다. overwrite는 좌표가 아니라 모드라 이월돼도 오손이 없다. 오히려 탭별 격리로 만들면 **탭 전환 리셋 요구가 새로 생겨** 그 버그 표면을 자초한다.
3. 휘발(새로고침 시 삽입으로 리셋)이 관례적 기본값 — editorPrefs 영속 키를 만들지 않는다.

→ 따라서 **L276~303 탭 전환 조정 블록에 overwrite를 추가하지 않는다**(전역 모드라 리셋 대상이 아님).

### §phase 38 전수 확인 (예약 조합 충돌 없음 — 못박음)

Insert(수식어 없음)는 `matchGlyphKeymap`의 빠른 탈출(Ctrl/Alt/Meta 없으면 즉시 null)에 걸려 사용자 키보드약물과 **매칭되지 않는다**. 또 `parseKeyCombo`가 실수식어 필수라 사용자가 bare `Insert`를 keymap으로 **등록할 수도 없다**. → `editorGlyphKeymap.js`의 `RESERVED_COMBOS`에 Insert를 추가할 필요가 **없다**(충돌 불가). 이 사실을 확인만 하고 `editorGlyphKeymap.js`는 건드리지 마라.

## TDD — 테스트 먼저

`web/src/view/editorShortcuts.test.js`:
- `isToggleOverwrite({ key: 'Insert' }) === true`, `isToggleOverwrite({ code: 'Insert' }) === true`.
- **수식어 배제**: `Shift+Insert`(붙여넣기)·`Ctrl+Insert`(복사)·`Alt+Insert`·`Meta+Insert` → 모두 `false`.
- 무관 키(`{ key: 'a' }`, `{ key: 'Delete' }`, `null`/`undefined`) → `false`.

`web/src/view/WriterPage.test.jsx`(신규 describe '상태표시줄 삽입/수정 토글'):
- 초기 렌더 → `stat-mode` 텍스트 `'삽입'`.
- 에디터 box에 `fireEvent.keyDown(box, { key: 'Insert' })` → `stat-mode` `'수정'`. 한 번 더 → `'삽입'`(토글).
- `Shift+Insert` keydown → `stat-mode` 불변(`'삽입'`) — 수식어 조합은 토글하지 않음.
- **탭 격리 회귀**: overwrite `'수정'`으로 켠 뒤 새 탭 추가/탭 전환 → `stat-mode`가 `'수정'` 유지(전역 모드라 리셋 안 됨). (탭 전환 헬퍼는 기존 테스트 재사용.)

## 작업 (구현 상세)

### 1. `web/src/view/editorShortcuts.js`
- `isDeleteLine`(L17~19) 형태로 신규 predicate 추가:
  ```js
  // Insert — 삽입/수정(overwrite) 모드 토글. 수식어 없는 Insert만(Shift+Insert=붙여넣기·Ctrl+Insert=복사 레거시 제외).
  export function isToggleOverwrite(e) {
    return !!(e && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey
      && (e.key === 'Insert' || e.code === 'Insert'));
  }
  ```

### 2. `web/src/view/WriterPage.jsx`
- import에 `isToggleOverwrite` 추가(기존 `editorShortcuts` import에 병합).
- overwrite state 추가(전역 단일, 영속 없음): `const [overwrite, setOverwrite] = useState(false);` — statusCaret/showToolBar 등 크롬 state 근처(L141~143). **L276~303 탭 조정 블록에는 넣지 마라.**
- `onKeyDown`의 **L1071 IME 가드 바로 아래**(L1074 `isCompanyCode` 위)에 삽입:
  ```js
  // 삽입/수정 모드 토글(Insert). 수식어 없는 키라 아래 라인삭제 바일아웃(!ctrlD return)에서 삼켜지기 전에 여기서 처리.
  // 실제 덮어쓰기 입력은 step3(overwrite state를 소비). 여기서는 모드 토글 + 상태표시줄 표시만.
  if (isToggleOverwrite(e)) {
    e.preventDefault();
    setOverwrite((v) => !v);
    return;
  }
  ```
- L1471 `<StatusBar ... />`에 `overwrite={overwrite}` 추가. L1470 주석의 "overwrite는 기본값(placeholder) 유지"를 실동작(Insert 토글) 설명으로 갱신.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(client 전용 — 백엔드/DB 무관. `npm test` 불필요.)

## 회귀 가드 / 불변식

- **StatusBar 미변경**: `StatusBar.jsx`는 이미 overwrite를 렌더한다 — diff에 없어야 한다. `StatusBar.test.jsx` L19~27 통과 유지.
- **예약 조합 미충돌**: `Shift+Insert`/`Ctrl+Insert`는 토글하지 않는다(붙여넣기/복사 레거시 보존). `editorGlyphKeymap.js` 미변경(Insert는 매칭 불가 — §phase 38 전수 확인).
- **전역 모드**: overwrite는 탭 전환에 리셋되지 않는다(문서-로컬 좌표 아님). 새 editorPrefs 키/영속 없음.
- **배치**: Insert 토글은 L1071 IME 가드 뒤 + L1134 바일아웃 앞. IME 조합 중(`isComposing`/229)에는 도달하지 않는다.

## 커밋 계획

- **feat**: `feat(44-editor-gap-closeout): step2 — 삽입/수정 토글(editorShortcuts isToggleOverwrite + WriterPage overwrite state·Insert 토글·StatusBar 결선)` — `editorShortcuts.js`·`WriterPage.jsx` + `editorShortcuts.test.js`·`WriterPage.test.jsx`.
- **chore**: `chore(44-editor-gap-closeout): step2 status — completed` — index.json step2.

## 금지사항

- `StatusBar.jsx`를 수정하지 마라. 이유: 이미 `overwrite` prop을 렌더한다 — WriterPage에서 prop 전달만 하면 된다(중복/이원화 금지).
- overwrite를 L276~303 탭 전환 조정 블록에 넣지 마라. 이유: 전역 입력 모드는 문서-로컬 좌표가 아니라 리셋 대상이 아니다 — 넣으면 탭 전환마다 모드가 꺼져 관례(전역 모드)에 어긋난다.
- overwrite를 editorPrefs에 영속하지 마라. 이유: Insert 모드는 휘발성 세션 상태(관례적으로 새로고침 시 삽입으로 리셋).
- Insert 토글 분기를 L1133~1134 `const ctrlD`/바일아웃 아래에 두지 마라. 이유: `if (!ctrlD && key !== Backspace && key !== Delete) return;`가 수식어 없는 Insert를 삼켜 토글이 죽는다.
- 수식어 있는 Insert(Shift/Ctrl/Alt/Meta)를 토글 대상으로 만들지 마라. 이유: Shift+Insert(붙여넣기)·Ctrl+Insert(복사) 레거시 동작을 가로채면 표준 편집이 깨진다.
- `editorGlyphKeymap.js`를 건드리지 마라. 이유: Insert는 수식어가 없어 keymap 매칭/등록이 불가(§phase 38 전수 확인) — RESERVED_COMBOS 변경 불필요.
- 실제 덮어쓰기 입력 로직을 이 step에 넣지 마라. 이유: 그건 step3(overwrite state 소비) — 한 step 한 관심사.
- 기존 테스트를 깨뜨리지 마라.
