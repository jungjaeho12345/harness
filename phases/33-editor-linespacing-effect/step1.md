# Step 1: linespacing-effect

step0에서 정리한 줄간격 계약(기본 1.8·옵션 [1.2,1.5,1.8,2.0]·레거시 1.0→1.8 정규화)을 **실제 에디터 줄간격에 반영(effect)**한다. 반영 방식은 이미 검증된 **columnLimit effect의 직계 패턴** — 캔버스 래퍼 style에 값 주입, `Editor.jsx` 내부 미접촉. 다만 columnLimit은 래퍼 자기 padding으로 끝나지만, 줄간격은 자식(`.yh-editor`)의 line-height라 **CSS 변수 상속**으로 전달한다.

## 읽어야 할 파일

먼저 아래 파일들을 읽고 설계 의도를 파악하라:

- `docs/ARCHITECTURE.md`, `docs/ADR.md`(ADR-003 — view 모듈은 서버 호출만 controller 경유).
- `docs/news.md` L191(컬럼제한 — 동형 래퍼 effect 참조), L197(줄간격).
- `web/src/view/editorPrefs.js` — **step0에서 추가된** `normalizeLineSpacing`·`BASE_LINE_HEIGHT`·기본값 1.8. (step0 요약이 프롬프트에 함께 전달된다.)
- `web/src/view/WriterPage.jsx` — L173~204(prefs state/게이트: `editorBg`·`columnLimit`·`autosaveCfg`의 useState + 마운트 effect + `onPrefsClose(applied)` 갱신 — **동일 게이트에 lineSpacing을 나란히 추가**), L1000~1037(`.yh-writer__canvas` = `data-testid="editor-canvas"` 래퍼 style 객체 + 그 안의 `<Editor>`).
- `web/src/view/WriterPage.test.jsx` — L1~40(`setup`/`openTopMenu` 헬퍼), L1491~1494(editorBg 스타일 단언), **L1539~1647(columnLimit effect describe 블록 — 이 블록을 동형 템플릿으로 삼아라)**.
- `web/src/styles/yonhap.css` — L495~517(`.yh-editor` L507 `line-height: 1.8`, `.yh-editor__line` L517 `min-height: 1.8em`).

## 배경 (자기완결)

`edit.lineSpacing`을 소비하는 코드는 현재 어디에도 없다(저장만 됨). columnLimit·editorBg는 `WriterPage`가 `loadEditorPrefs()`로 읽어 캔버스 래퍼 style에 반영하고, prefs 다이얼로그 '적용'/마운트 시 재동기화한다(취소 시 불변). 줄간격도 **같은 게이트**에 얹는다.

### 메커니즘 (못박음)

1. `web/src/styles/yonhap.css`의 하드코딩 line-height를 **CSS 변수 + fallback**으로 바꾼다(값을 삭제하지 말고 fallback으로 1.8을 보존):
   - `.yh-editor { line-height: var(--yh-editor-line-height, 1.8); }` (L507)
   - `.yh-editor__line { min-height: calc(var(--yh-editor-line-height, 1.8) * 1em); white-space: pre-wrap; }` (L517 — 빈 줄 높이도 같은 변수를 따르게 해 채운 줄과 일관)
2. `WriterPage`가 캔버스 래퍼 style에 `--yh-editor-line-height`를 주입한다. **CSS custom property는 상속**되므로, 래퍼에 설정하면 자식 `.yh-editor`/`.yh-editor__line`의 `var()`가 이를 사용한다. 주입이 없으면 fallback 1.8(현행 그대로 — 회귀 안전망)이 적용된다.

이 접근이 회귀를 막는 이유: 손댄 적 없는 사용자(기본 1.8)·레거시 저장 1.0(정규화 1.8)·주입 누락 경로(fallback 1.8) **모두 1.8**로 수렴하고, 의도적으로 고른 1.2/1.5/2.0만 그 값으로 반영된다.

## 작업 (TDD — 실패하는 테스트부터 작성한 뒤 구현)

### `web/src/view/WriterPage.jsx` (columnLimit/editorBg 게이트에 나란히 추가)

1. state: `const [lineSpacing, setLineSpacing] = useState(() => loadEditorPrefs().edit.lineSpacing);` — L179 `columnLimit` 옆. columnLimit이 raw bool을 보관하듯 **raw 저장값을 보관**한다(정규화는 주입 시점에).
2. 마운트 effect(L186~191)에 `setLineSpacing(loadEditorPrefs().edit.lineSpacing);` 추가(새로고침 후에도 반영).
3. `onPrefsClose`의 `applied` 분기(L196~202)에 `setLineSpacing(loadEditorPrefs().edit.lineSpacing);` 추가. **취소(applied=false) 시 불변** — editorBg/columnLimit과 동일 게이트.
4. 캔버스 래퍼 style 객체(L1005~1009)에 CSS 변수를 주입한다:

   ```jsx
   style={{
     backgroundColor: editorBg,
     ...(columnLimit ? { paddingLeft: '10%', paddingRight: '10%' } : null),
     '--yh-editor-line-height': String(normalizeLineSpacing(lineSpacing)),
   }}
   ```

   `normalizeLineSpacing`을 `./editorPrefs.js`에서 import한다. `backgroundColor`·`columnLimit` padding과 **공존**(별도 키라 상호 무간섭)해야 한다.

### `web/src/styles/yonhap.css`

위 메커니즘대로 L507·L517 **두 곳만** 변수화한다. `articleDetail.js`의 line-height나 다른 규칙(L67/316/332/… 등)은 건드리지 마라.

### 주의 (못박음)

- **주입 문자열 포맷**: JS 수치라 `String(2.0) === '2'`(소수 탈락). CSS `line-height: 2`는 유효하다. 따라서 테스트는 2.0 선택 시 변수값을 `'2'`로 단언하라(`'2.0'` 아님). 다른 값: 1.5→`'1.5'`, 1.8→`'1.8'`, 1.2→`'1.2'`.
- **매핑 모드 무관**: 캔버스 래퍼는 매핑/편집 양쪽에서 렌더된다(`<Editor>`가 `textEditable={!isMapping}`로만 분기). 따라서 `isMapping` 분기 없이 **항상 주입**한다. 줄간격은 표시 스타일이라 본문·캐럿에 영향이 없다.
- **캐럿 무영향 근거**: line-height/min-height 변경은 `.yh-editor__line` DOM 구조(줄 요소 개수·텍스트 노드)를 바꾸지 않으므로, `.yh-editor__line` 단위로 좌표를 읽는 캐럿 로직(readCaret)에 영향이 없다. `Editor.jsx`를 만질 이유가 없다.

### 테스트 — `web/src/view/WriterPage.test.jsx`

L1541 columnLimit describe 블록을 **동형 템플릿**으로 신규 describe(`WriterPage — 편집>줄간격(editor-canvas line-height 변수) 적용`)를 추가한다. `beforeEach`에서 `localStorage.clear()`.

- 헬퍼: `const saveLineSpacing = (v) => saveEditorPrefs({ ...loadEditorPrefs(), edit: { ...loadEditorPrefs().edit, lineSpacing: v } });`
- 단언 방식: `getByTestId('editor-canvas').style.getPropertyValue('--yh-editor-line-height')` 문자열 비교(jsdom에서 실제 line-height 계산 스타일은 신뢰 불가 — CSS 변수 주입 여부만 잠근다).
- (a) `saveLineSpacing(1.5)` 렌더 → 변수 `'1.5'`.
- (b) 미저장(기본) 렌더 → `'1.8'`(step0 기본).
- (c) **레거시 `saveLineSpacing(1.0)` 렌더 → `'1.8'`**(정규화 회귀 가드 — 이 phase의 핵심 단언).
- (d) editorBg + columnLimit + lineSpacing을 함께 저장하고 렌더 → 캔버스에 `backgroundColor`·`paddingLeft: '10%'`·변수 `'1.5'`가 **모두** 반영(공존 회귀).
- (e) 라이브 게이트: prefs 메뉴로 열고(`openTopMenu('도움말')` → 환경설정) 편집 탭에서 줄간격 `2.0` 선택 후 '적용' → 변수 `'2'`. **select의 실제 DOM value는 `'2'`다(React가 `value={2.0}`을 `"2"`로 직렬화, label만 `toFixed`로 "2.0"). 따라서 선택 조작은 `userEvent.selectOptions(select, '2')`(또는 `fireEvent.change` target value `'2'`)로 하라 — `'2.0'`을 넘기면 무매칭으로 공란이 된다(② 검토 minor 2).**
- (f) '취소' → 변수 불변.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm run test:web
```

(백엔드 무관 — `npm test`는 실행 불필요.)

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `web/src/view/Editor.jsx`가 diff에 없는가?(래퍼-레벨 effect 유지 — 내부 미접촉)
   - editorBg·columnLimit 기존 테스트(L1491~1494, L1541~1647)가 그린인가?(공존 회귀 없음)
   - ADR-003 준수(서버 호출 미추가)·CLAUDE.md(DB 무관·client 전용·UTF-8)?
3. 결과에 따라 `phases/33-editor-linespacing-effect/index.json`의 step1을 업데이트한다:
   - 성공 → `"status": "completed"`, `"summary"`에 (주입 변수명 `--yh-editor-line-height`·CSS L507/L517 변수화·기본 1.8·레거시 1.0→1.8·추가 테스트)를 한 줄 요약.
   - 3회 수정 후에도 실패 → `"status": "error"`, `"error_message"`.
   - 사용자 개입 필요 → `"status": "blocked"`, `"blocked_reason"` 후 즉시 중단.
4. top-level `phases/index.json`의 33 항목 상태는 execute.py가 관리한다(직접 건드리지 마라).

## 금지사항

- `web/src/view/Editor.jsx`를 건드리지 마라. 이유: 검증된 래퍼-레벨 effect 패턴을 유지한다 — 내부 DOM/캐럿 로직 변경은 회귀 위험이 크고 이 effect에 불필요하다.
- `web/src/styles/yonhap.css`의 하드코딩 `1.8`을 그냥 삭제하지 마라. 반드시 `var(--yh-editor-line-height, 1.8)` fallback으로 보존하라. 이유: 변수 주입이 없거나 값이 무효인 경로에서도 현행 1.8 렌더를 지켜 회귀를 막는다.
- 줄간격을 columnLimit처럼 조건부(값이 있을 때만) 주입하지 마라. 이유: 정규화된 line-height는 항상 유효하므로 상시 주입이 단순·안전하다(빈 값 주입 엣지가 없다).
- `isMapping`으로 주입을 분기하지 마라. 이유: 줄간격은 표시 스타일이라 매핑/편집 동일 적용이 스펙에 맞고, 캐럿·본문이 불변이다.
- `articleDetail.js` 등 다른 line-height를 변수화하지 마라. 이유: 이 phase 범위는 에디터 줄간격뿐이며, 상세보기 렌더까지 바꾸면 범위가 넘치고 회귀 표면이 커진다.
- 기존 테스트를 깨뜨리지 마라.
