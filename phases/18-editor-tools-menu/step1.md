# Step 1: insert-date-wiring — 날짜 삽입(tools.insertDate) WriterPage 결선

## 배경 / 요구사항

도구 메뉴 '날짜 삽입'(`tools.insertDate`, news.md L180)을 WriterPage에 결선한다. 클릭하면 **현재 날짜/시각**을 사용자의 날짜형식 prefs(`dateFormat`, 9종)대로 포맷해 **캐럿 위치 본문에 텍스트로** 삽입한다.

Step 0의 순수 헬퍼 `insertDateAtCaret(blocks, caret, dateString)`을 쓰되, **비결정 시각은 WriterPage에서만 주입**한다: `new Date().toISOString()` → `applyDateFormat(iso, format)` → 그 문자열을 헬퍼에 넘긴다. 약물입력(phase17) `onGlyphPick`과 **동일한 안전 경로**(`updateField('body', serialize(r.blocks))` + `setPendingCaretLine`)로 본문을 바꾼다 — Editor/contentEditable/DOM 직접 조작 금지.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — ADR-003(View←Controller←Model), 신뢰 경계·DB 비파괴.
- `/docs/news.md` — L180(도구 메뉴 '날짜 삽입'), L204~205(날짜형식 9종), L155~159(본문/캐럿/임베드).
- `web/src/view/editorDate.js` (**Step 0 생성**) — `insertDateAtCaret(blocks, caret, dateString) → { blocks, caretTextLine }`.
- `web/src/view/WriterPage.jsx` — **결선 위치**. 특히:
  - `MENU_ENABLED`(L62) — 결선된 메뉴 id 배열. 여기에 `'tools.insertDate'`를 추가한다.
  - `onMenuSelect(id)`(L271~303) — 메뉴 라우팅. 매핑 가드(`if (isMapping) return;`) **뒤**(본문 변경이므로)에 `tools.insertDate` 분기를 추가한다. `help.preferences`처럼 본문 무변경인 항목은 가드 앞에 있음에 유의.
  - `onGlyphPick(glyph)`(L217~223) — **재사용할 안전 경로 템플릿**: `lastCaretRef.current` 캐럿 → 헬퍼 → `updateField('body', serialize(r.blocks))` → `setPendingCaretLine`.
  - `lastCaretRef`(L142)·`setPendingCaretLine`(L144)·`blocks`(L139)·`isMapping`(L136)·`serialize`(import L27).
- `web/src/view/listFormat.js` — `applyDateFormat(iso, format)`(ISO 문자열에서 YYYY/MM/DD/HH/mm 추출 치환, `Date` 비사용), `DATE_FORMATS`. **이것으로 날짜 문자열을 만든다**. 단, `currentFormat`(module-level)에 의존하지 말고 `applyDateFormat(iso, format)`에 prefs 형식을 명시적으로 넘긴다.
- `web/src/view/editorPrefs.js` — `loadEditorPrefs().dateFormat`(string, 9종 중 하나). **읽기 전용**.
- `web/src/view/WriterPage.test.jsx` — 결선 테스트 컨벤션. 특히 L959~1075 '텍스트 변환/마커 결선' describe: `caretAtLine`/`focusCaretAtLine`(keyUp→onCaretChange로 `lastCaretRef` 갱신), `openWith`/`editorLines` 헬퍼. 메뉴 클릭은 `userEvent.click(screen.getByRole('menuitem', { name: '도구' }))` → `userEvent.click(screen.getByText('날짜 삽입'))`.

## 작업

TDD로 진행한다. 먼저 `WriterPage.test.jsx`에 `describe('WriterPage — 날짜 삽입(tools.insertDate) 결선')`를 추가하고, 통과하도록 `WriterPage.jsx`를 결선한다.

### 결선 (시그니처 수준)

1. **import**: `WriterPage.jsx` 상단에 `import { insertDateAtCaret } from './editorDate.js';`, `import { applyDateFormat } from './listFormat.js';` 추가(이미 `loadEditorPrefs` import됨).
2. **핸들러**: `onGlyphPick`을 모델 삼아 날짜 핸들러를 추가한다(시그니처):
   ```js
   // 도구>날짜 삽입 — 현재 시각(비결정)을 날짜형식 prefs대로 포맷해 캐럿 위치에 텍스트로 삽입.
   // 비결정성은 여기서만(new Date) — 헬퍼는 완성된 문자열만 받는다. 약물입력과 동일 안전 경로.
   const insertDate = () => {
     if (isMapping) return;                                  // 매핑(텍스트 잠금) no-op
     const fmt = loadEditorPrefs().dateFormat;               // 읽기 전용
     const dateString = applyDateFormat(new Date().toISOString(), fmt);
     const caret = lastCaretRef.current;
     const r = insertDateAtCaret(blocks, caret, dateString);
     updateField('body', serialize(r.blocks));               // 안전 경로(DOM 직접 조작 금지)
     if (typeof r.caretTextLine === 'number') setPendingCaretLine(r.caretTextLine);
   };
   ```
3. **메뉴 활성화**: `MENU_ENABLED`에 `'tools.insertDate'` 추가.
4. **라우팅**: `onMenuSelect`의 매핑 가드 **뒤**에 `if (id === 'tools.insertDate') { insertDate(); return; }` 추가.

`new Date().toISOString()`은 항상 `YYYY-MM-DDTHH:mm:...` 꼴이라 `applyDateFormat`의 정규식(`^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})`)과 매칭된다(타임존: UTC 기준 — 제품 결정상 충분, 로컬타임 변환은 범위 밖).

### 테스트에서 시각 결정화

`new Date()`는 비결정적이므로 테스트는 시각을 고정한다 — `vi.useFakeTimers()` + `vi.setSystemTime(new Date('2026-06-24T01:23:00Z'))` 또는 `vi.spyOn(Date.prototype, 'toISOString')` 등으로 ISO를 고정하고, 끝나면 `vi.useRealTimers()`/`restoreAllMocks`로 복원한다. prefs 날짜형식은 `saveEditorPrefs({ ...loadEditorPrefs(), dateFormat: 'YYYY.MM.DD' })`로 주입하고 `localStorage`를 `beforeEach`에서 격리한다(기존 색상/컬럼제한 테스트와 동일 패턴).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **Editor.jsx 미접촉·`<Editor>` 신규 prop 금지**: 본문 변경은 `updateField('body', serialize(...))` + `setPendingCaretLine` 안전 경로만. contentEditable/DOM/execCommand 직접 조작 금지. 이유: 과거 BLOCKER(에디터 결합).
2. **기존 메뉴 id 재사용**: `tools.insertDate` id/라벨('날짜 삽입')을 그대로 쓴다. 새 id·라벨 매칭 금지. 이유: 과거 BLOCKER.
3. **매핑 모드 본문-only 불변식**: `isMapping`이면 날짜 삽입 no-op(약물입력·찾기와 동일 가드). 매핑 가드 **뒤**에 분기를 둔다. 이유: 매핑은 임베드만 변경.
4. **비결정성은 결선 레이어로 한정**: `new Date()`/시각 포맷팅은 `WriterPage`에서만. `editorDate.js`(Step 0)는 건드리지 마라. 이유: 순수 헬퍼 테스트 가능성 유지.
5. **editorPrefs 읽기 전용·server 미접촉**: `loadEditorPrefs().dateFormat`만 읽고 저장/변경하지 않는다. `server/` 미접촉(DB 비파괴). 이유: 이 phase는 client 전용.
6. **비결선 메뉴/툴바 회귀 금지**: `MENU_ENABLED`에는 `tools.insertDate`만 추가하고 다른 비결선 항목은 비활성 유지. 이유: 회귀 차단.

## Acceptance Criteria

```bash
cd web && npm run test -- WriterPage    # 신규 '날짜 삽입 결선' describe 통과
cd .. && npm run test:web               # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx`):
- 시각 고정 + `dateFormat='YYYY.MM.DD'`에서 캐럿을 줄에 둔 뒤 도구>'날짜 삽입' 클릭 시, 그 줄 텍스트에 `'2026.06.24'`(고정 시각 포맷)가 삽입된다.
- 캐럿이 없을 때(포커스 미발생) 클릭하면 "(끝)"이 아닌 마지막 텍스트 줄 끝에 날짜가 삽입되고 크래시하지 않는다.
- 매핑 모드(`mode:'mapping'`)에서 도구>'날짜 삽입'은 **비활성**이거나(클릭 불가) 클릭해도 본문이 불변이다(약물입력 매핑 가드와 동일 — 매핑에서 `tools.*` 본문 변경 항목 비활성 정책을 따른다).
- `tools.insertDate`가 `MENU_ENABLED`에 들어 메뉴 항목이 활성(`disabled` 아님)이다.
- 날짜형식 prefs를 바꾸면(예: `'YYYY-MM-DD'`) 삽입 문자열도 그 형식을 따른다.
- 다른 비결선 도구 항목(예: `tools.fileInfo`)은 여전히 비활성이다(회귀 없음).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: Editor.jsx/`<Editor>` prop 무변경, 안전 경로(serialize+pendingCaretLine)만, 매핑 가드 준수, `new Date`는 WriterPage에만, editorPrefs 읽기 전용, server 무변경.
3. 결과에 따라 `phases/18-editor-tools-menu/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- `Editor.jsx`를 수정하거나 `<Editor>`에 새 prop을 넘기지 마라. 이유: 본문 변경은 안전 경로만(과거 BLOCKER).
- contentEditable/DOM/`document.execCommand`로 날짜를 직접 써넣지 마라. 이유: 직렬화 안전 경로 우회 — 블록 모델이 깨진다.
- `editorDate.js`(Step 0 헬퍼)에 `new Date`/포맷팅을 넣어 비결정성을 헬퍼로 끌어오지 마라. 이유: 순수성 — 테스트 불가해진다.
- 매핑 모드에서 날짜를 삽입하지 마라. 이유: 본문-only 불변식(매핑은 임베드만).
- `tools.insertDate` 외 비결선 메뉴를 `MENU_ENABLED`에 추가하지 마라. 이유: 미구현 액션 죽은 버튼 활성화·회귀.
- `server/`·`editorPrefs` 저장 로직을 건드리지 마라. 이유: DB 비파괴·client 전용 phase.
