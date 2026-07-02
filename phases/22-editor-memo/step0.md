# Step 0: memo-store-dialog — 메모 영속 모듈 + 메모장 다이얼로그 컴포넌트

## 배경 / 요구사항

에디터 **도구 메뉴 '메모장'**(`tools.memo`, label '메모장' — news.md L182; 툴바에도 L157에 항목명만 존재)은 현재 `web/src/view/EditorMenuBar.jsx`에 **disabled placeholder로 실존**하나 결선돼 있지 않다. 이 phase의 목표는 이를 결선해, 기자가 자유롭게 메모를 적고 새로고침/이동 후에도 유지되는 **client 전용 스크래치패드 다이얼로그**를 띄우는 것이다.

news.md에는 메뉴/툴바 목록에 항목명만 있고 세부 동작 명세가 없다 → 자기완결 최소 기능으로 정의한다:
- **텍스트 영역(textarea) + '저장' + '닫기'** 버튼.
- 메모는 **localStorage에 영속**하는 **기사와 무관한 전역 메모 1개**(articleId·탭·본문과 독립).
- 메모는 기사 본문(`markupVersion`)을 **절대 건드리지 않는다**.

이 step은 두 가지를 만든다(둘 다 결선은 Step 1):
1. **`web/src/view/memoStore.js`** — 전역 메모 문자열의 **순수 load/save 함수**(localStorage, graceful 폴백). DOM/React 비의존.
2. **`web/src/view/MemoDialog.jsx`** — **props 주도(controlled)** 표시/입력 컴포넌트(textarea + 저장/닫기). 자체 상태·영속을 갖지 않는다(값과 영속은 부모가 소유 — Step 1).

> **왜 controlled(부모 소유)인가**: 메모는 스크래치패드라 다이얼로그를 닫았다 다시 열어도 세션 내 편집이 살아 있어야 자연스럽다. 값을 부모(WriterPage) state에 두면 open 토글로 컴포넌트가 unmount(`open=false → null`)돼도 값이 보존된다. `FileInfoDialog`/`GlyphInputDialog`처럼 **내부 state 없는 얇은 표시 컴포넌트**로 유지한다(ADR-003).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC(View=순수/표시), DB 비파괴, 명령어(`npm run test:web`/`build`/`lint`).
- `/docs/ADR.md` — **ADR-003**(순수 표시 컴포넌트, transport 비의존, props 주입).
- `/docs/news.md` — L182(도구 메뉴 '메모장'), L157(툴바 '메모장' — 참조; 이번 결선 대상은 **도구 메뉴 `tools.memo`**이며 툴바는 out-of-scope, 아래 금지사항 참조).
- `web/src/view/editorDraft.js` — **영속 모듈 실측 기준**: `try/catch` + `JSON.parse(localStorage.getItem(...))` graceful 읽기, `globalThis.localStorage?.setItem`, localStorage 불가 시 no-op. `memoStore.js`도 동일 패턴을 따른다. **단 memoStore는 단일 전역 문자열**이라 key별 맵이 아니다(더 단순).
- `web/src/view/editorPrefs.js` — 동일 graceful 패턴(`readAll`의 `JSON.parse` try/catch, 파싱 실패 시 기본값) 참고. **STORAGE_KEY 명명 규칙**(`yh.editorPrefs`, `yh.editorDrafts`) 확인 — memoStore는 충돌 없는 **전용 키 `yh.editorMemo`**를 쓴다.
- `web/src/view/FileInfoDialog.jsx` — **다이얼로그 직접 템플릿(가장 최근)**: `open` false→`null`, `role="dialog"`+`aria-label`, 전용 className/testid, `handleKeyDown`의 Esc 닫기, '닫기' 버튼(`onClose`), 콜백 미전달 가드. **단 이 컴포넌트는 읽기전용** — 메모장은 입력(textarea)과 저장 콜백이 추가된다.
- `web/src/view/UrlEmbedDialog.jsx` — 입력이 있는 다이얼로그 패턴 참고. **주의**: UrlEmbedDialog는 **Enter로 submit**하지만, **메모장 textarea는 Enter가 개행이어야 하므로 Enter를 가로채지 않는다**(아래 핵심 규칙 3). 또 UrlEmbedDialog는 내부 useState를 쓰지만 **메모장은 controlled(내부 state 없음)** — 값은 props로 받는다.
- `web/src/view/FileInfoDialog.test.jsx`, `web/src/view/GlyphInputDialog.test.jsx` — 다이얼로그 테스트 컨벤션(open 토글로 null, `getByRole('dialog', { name })`, Esc/닫기 콜백 mock, 콜백 미전달 graceful, `describe`/`it` 한글 케이스명).
- `web/src/styles/yonhap.css` — 다이얼로그 스타일 위치. `yh-file-info`(약 L1068)·`yh-glyph-input`(약 L953)·`yh-url-embed`(약 L1028) 인근에 `yh-editor-memo` 스타일을 추가한다.

## 작업

TDD로 진행한다(vitest). **테스트 먼저** 작성하고 통과하는 구현을 만든다.

### 1) memoStore.js — 순수 load/save (테스트 먼저)

`web/src/view/memoStore.test.js`를 먼저 작성하고 통과하는 `web/src/view/memoStore.js`를 만든다.

```js
// 전역 메모(스크래치패드) 영속 — client localStorage 전용(서버 무관, 기사와 무관한 단일 전역 메모 1개).
// editorDraft/editorPrefs와 동일한 graceful 패턴(접근 불가/parse 실패 → 안전 폴백). DOM/React 비의존.
const STORAGE_KEY = 'yh.editorMemo';

// 저장된 메모 문자열 반환. 부재/파싱 실패/비문자열이면 '' 폴백.
export function loadMemo() { ... }

// 메모 문자열 저장(JSON.stringify). 비문자열이면 ''로 취급. localStorage 불가 시 no-op. 반환: 저장한 문자열.
export function saveMemo(text) { ... }
```

요구사항:
- **전용 키 `yh.editorMemo`** — `yh.editorPrefs`/`yh.editorDrafts`/`yh.columnConfig` 등 기존 키와 겹치지 않는다.
- `loadMemo()`: `JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY))` 후 `typeof === 'string'`이면 그 값, 아니면 `''`. `try/catch`로 parse 실패/접근 불가 시 `''`.
- `saveMemo(text)`: 비문자열 입력은 `''`로 취급한 뒤 `JSON.stringify`해 저장. `try/catch`로 localStorage 불가 시 no-op(throw 금지). 저장한 문자열을 반환.
- 두 함수 모두 **순수 로직 + localStorage 접근만** — `window`/`document`/`Date`/`fetch`/model 호출 금지.

### 2) MemoDialog.jsx — controlled 표시/입력 다이얼로그 (테스트 먼저)

`web/src/view/MemoDialog.test.jsx`를 먼저 작성하고 통과하는 `web/src/view/MemoDialog.jsx`를 만든다.

```jsx
// 메모장 다이얼로그 — 순수 표시/입력(controlled) 컴포넌트(ADR-003).
// 값(value)·영속·표시여부는 부모(Step 1 WriterPage)가 소유한다 — 이 컴포넌트는 내부 state·localStorage·model이 없다.
// 기사 본문/markupVersion과 무관한 전역 스크래치패드. 전용 yh-editor-memo/editor-memo className·testid로 다른 다이얼로그와 충돌 방지.
export function MemoDialog({
  open,
  value = '',   // 현재 메모 텍스트(부모 소유 — controlled)
  onChange,     // (text) => void — textarea 입력 시
  onSave,       // () => void — '저장' 클릭 시(부모가 localStorage 영속)
  onClose,      // () => void — '닫기'/Esc
}) { ... }
```

요구사항:
- `open`이 false면 `null` 반환.
- `role="dialog"`, `aria-label`(예 '메모장'), **전용 className `yh-editor-memo`·전용 testid `editor-memo`**. 기존 `yh-file-info`/`yh-glyph-input`/`yh-url-embed`/`yh-find-replace`/`yh-editor-glyphbar`와 충돌 금지.
- **`<textarea>`**(testid 예 `editor-memo-text`): `value={value}`, `onChange={(e) => onChange && onChange(e.target.value)}`. 여러 줄 입력 가능(개행 허용). `aria-label` 부여.
- **'저장' 버튼**(testid 예 `editor-memo-save`) → `onSave`. **'닫기' 버튼**(testid 예 `editor-memo-close`) → `onClose`.
- **Esc** → `onClose`(컨테이너 `onKeyDown`에서 `e.key === 'Escape'`만 처리). `onChange`/`onSave`/`onClose` 미전달 시 모두 가드(예외 금지).
- CSS: `yh-editor-memo` 떠있는 패널 스타일을 `yh-file-info` 인근에 추가한다(기존 스타일 미파손). textarea가 편집 가능한 충분한 크기를 갖도록 한다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **순수성·계층 분리(ADR-003)**: `MemoDialog`는 model/fetch/transport/localStorage/`window`/`document`/`Date` 호출 금지, **내부 state 금지**(controlled — 값은 props). 영속은 `memoStore`의 몫이고 그 호출은 부모(Step 1)가 한다. `memoStore`는 localStorage 접근만 하고 그 외 부수효과 금지. 이유: 테스트 가능성·비결정성 제거·결선 레이어 분리.
2. **전용 localStorage 키**: `yh.editorMemo`. 기존 키(`yh.editorPrefs`/`yh.editorDrafts`/`yh.columnConfig`)를 읽거나 쓰지 마라. 이유: 기존 설정/초안 오염 방지(DB 비파괴 정신을 클라이언트 저장소에도 적용).
3. **Enter는 개행 — 가로채지 마라**: `MemoDialog`의 `handleKeyDown`은 **Escape만** 처리한다. `UrlEmbedDialog`처럼 Enter로 submit/save 하지 마라. 이유: 메모는 여러 줄 스크래치패드 — Enter는 textarea 개행이어야 한다(Enter를 삼키면 줄바꿈 불가).
4. **전용 className/testid**: `yh-editor-memo`/`editor-memo`(또는 동급 전용 이름). 파일정보(`yh-file-info`)·약물입력(`yh-glyph-input`)·URL임베드(`yh-url-embed`)·찾기(`yh-find-replace`)·약물바(`yh-editor-glyphbar`)와 겹치지 마라. 이유: 회귀·스타일 충돌 방지.
5. **안전 폴백**: `loadMemo`는 부재/parse 실패/비문자열에 `''`를 반환하고 throw 하지 않는다. `saveMemo`는 localStorage 불가 시 no-op(throw 금지). 이유: localStorage 미지원/사파리 프라이빗 모드 등에서도 앱이 죽지 않아야 한다.

## Acceptance Criteria

```bash
npm run test:web -- memoStore     # 신규 memoStore.test.js 통과
npm run test:web -- MemoDialog    # 신규 MemoDialog.test.jsx 통과
npm run test:web                  # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest):

`memoStore.test.js` (localStorage 격리 — `beforeEach`에서 `localStorage.clear()`):
- `loadMemo()`가 저장 전 `''`를 반환한다(부재).
- `saveMemo('안녕')` 후 `loadMemo()`가 `'안녕'`을 반환한다(왕복).
- `saveMemo('여러\n줄\n메모')` 후 `loadMemo()`가 개행을 보존한다.
- 저장 키가 `yh.editorMemo`임을 단언(`localStorage.getItem('yh.editorMemo')`가 non-null; 다른 기존 키 미오염).
- `localStorage`에 잘못된 값(예 `localStorage.setItem('yh.editorMemo', '{{{')`)이 있어도 `loadMemo()`가 `''`(안전 폴백)이고 throw 하지 않는다.
- `saveMemo(null)`/`saveMemo(undefined)`가 throw 하지 않고 이후 `loadMemo()`가 `''`.

`MemoDialog.test.jsx`:
- `open={false}`면 아무것도 렌더되지 않는다(`container.firstChild === null`).
- `open` 시 `role="dialog"`('메모장')와 testid `editor-memo`, textarea(`editor-memo-text`)가 보인다.
- textarea에 입력하면 `onChange`가 입력값으로 호출된다(`fireEvent.change` → `onChange` mock에 최신 문자열 전달).
- textarea가 `value` prop을 그대로 표시한다(controlled — 주입값이 화면에 보임).
- '저장' 클릭 시 `onSave` 호출. '닫기' 클릭 시 `onClose` 호출. Esc 키에서 `onClose` 호출.
- `onChange`/`onSave`/`onClose` 미전달 시 입력/저장/닫기/Esc가 예외를 던지지 않는다.
- Enter 키가 `onSave`/`onClose`를 호출하지 **않는다**(Enter는 개행 — 인터셉트 안 함). `fireEvent.keyDown(dialog, { key: 'Enter' })` 후 `onSave`/`onClose` 미호출 단언.

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1` 또는 UTF-8 콘솔).
2. 아키텍처 체크리스트: `MemoDialog` 순수성(내부 state·localStorage·model 없음, props 주도)·Enter 미인터셉트·전용 className/testid; `memoStore` 전용 키(`yh.editorMemo`)·graceful 폴백·localStorage 접근 외 부수효과 없음.
3. 결과에 따라 `phases/22-editor-memo/index.json`의 step 0을 갱신(completed+summary / error / blocked).

## 금지사항

- `MemoDialog`에 내부 `useState`(값 보관)·`localStorage`·`memoStore` import·model/fetch를 넣지 마라. 이유: controlled 표시 컴포넌트 — 값/영속은 부모(Step 1) 소유(ADR-003 순수성·결선 레이어 분리).
- `MemoDialog`의 `handleKeyDown`에서 Enter로 저장/닫기 하지 마라(Escape만). 이유: 메모는 여러 줄 — Enter는 개행이어야 한다.
- 기존 localStorage 키(`yh.editorPrefs`/`yh.editorDrafts`/`yh.columnConfig` 등)를 읽거나 쓰지 마라. 새 전용 키 `yh.editorMemo`만 쓴다. 이유: 기존 설정/초안 오염 방지.
- 파일정보/약물입력/URL임베드/찾기/약물바와 같은 className/testid를 재사용하지 마라. 이유: 회귀·스타일 충돌.
- `loadMemo`/`saveMemo`가 throw 하게 두지 마라(항상 try/catch로 폴백/no-op). 이유: localStorage 미지원 환경에서도 앱이 죽지 않아야 한다.
- `WriterPage.jsx`·`Editor.jsx`·`EditorMenuBar.jsx`·`EditorToolBar.jsx`·`server/`·DB를 수정하지 마라(이 step은 신규 memoStore + 신규 MemoDialog + 테스트 + CSS만). 이유: 결선은 Step 1, Editor 미접촉, client 전용·DB 비파괴.
