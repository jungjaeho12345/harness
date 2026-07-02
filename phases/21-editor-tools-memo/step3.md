# Step 3: writer-wiring — WriterPage 메모장 결선(메뉴/툴바/상태/영속화/다이얼로그)

## 배경 / 요구사항

앞 step들(0: `editorMemo.js`, 1: `MemoDialog.jsx`, 2: 툴바 `enabledIds`)을 **WriterPage에서 하나로 결선**한다. 도구 메뉴 `tools.memo`와 툴바 `tool.memo` 두 진입점 모두에서 메모장 다이얼로그가 열리고, 입력 내용이 세션을 넘어 유지되게 한다. 기존 다이얼로그 결선(약물입력 `showGlyphInput`·찾기 `showFind`)과 동일한 **표시 토글 + 컴포넌트** 패턴을 따른다.

이 step은 **`WriterPage.jsx`(+ 그 테스트)만** 수정한다. Editor.jsx는 접촉하지 않는다.

### 매핑 모드 정책 — 메모장은 매핑에서도 열린다 (근거를 반드시 반영)

매핑 모드의 불변식은 **"본문-only 불변식"**(본문 텍스트를 바꾸지 않는다)이다. 찾기/약물입력/날짜삽입은 본문을 바꾸므로 `isMapping` 가드 뒤에 두어 매핑에서 차단한다. 그러나 **메모장은 본문(blocks/updateField)을 전혀 건드리지 않는 스크래치패드**이므로 매핑 모드에서도 열려도 된다. 따라서 메모 라우팅은 `help.preferences`·URL 임베드처럼 **`if (isMapping) return;` 가드 이전**에 둔다(매핑에서도 열리는 죽지 않는 버튼).

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`, `/docs/UI_GUIDE.md`.
- **Step 0 산출물**: `web/src/view/editorMemo.js` — `loadMemo()`/`saveMemo(text)`.
- **Step 1 산출물**: `web/src/view/MemoDialog.jsx` — `MemoDialog({ open, text, onChange, onClose })`.
- **Step 2 산출물**: `web/src/view/EditorToolBar.jsx` — 이제 `enabledIds`/`onSelect`를 받는다(`enabledIds` 미전달 시 전 버튼 disabled).
- `web/src/view/WriterPage.jsx` — **수정 대상**. 특히:
  - `MENU_ENABLED` 배열(68행) — 결선된 메뉴 id 목록. 여기에 `'tools.memo'`를 추가한다.
  - `showGlyphInput` 상태·`GlyphInputDialog` 결선(104행, 700~706행) — **메모 상태/다이얼로그의 참조 패턴**.
  - `loadEditorPrefs()` lazy 초기화 패턴(100·112행) — 마운트 시 저장값으로 상태 초기화하는 방식(메모는 `loadMemo()`로 동형).
  - `onMenuSelect`(292~334행) — `help.preferences`/URL 임베드가 `if (isMapping) return;`(303행) **앞**에 있음(매핑 허용). 메모도 그 앞에 라우팅한다.
  - `<EditorToolBar />`(576행) — 현재 props 없이 렌더. 여기에 `enabledIds`/`onSelect`를 준다.
  - `<GlyphInputDialog ... />`(700~706행)·`<UrlEmbedDialog ... />`(710~715행) 근처 — `<MemoDialog>`를 나란히 렌더한다.
- `web/src/view/WriterPage.test.jsx` — 결선 통합 테스트 스타일(메뉴 클릭→다이얼로그, 매핑 케이스) 참고 및 갱신 대상.

## 작업

TDD. `WriterPage.test.jsx`에 메모 결선 테스트를 먼저 추가(red)한 뒤 `WriterPage.jsx`를 고친다.

### (1) 상태 + 영속화

- `import { loadMemo, saveMemo } from './editorMemo.js';` / `import { MemoDialog } from './MemoDialog.jsx';`
- 표시 토글: `const [showMemo, setShowMemo] = useState(false);`
- 텍스트(마운트 lazy 초기화 — `editorBg`/`glyphFavorites`와 동일 게이트):
  `const [memoText, setMemoText] = useState(() => loadMemo());`
- 변경 핸들러(입력마다 상태 + 영속화):
  ```js
  const onMemoChange = (text) => { setMemoText(text); saveMemo(text); };
  ```
  (영속화를 `onChange`에서 바로 한다 — MemoDialog는 순수 제어 컴포넌트라 저장은 부모가 주도.)

### (2) 메뉴 라우팅 (매핑 가드 앞)

- `MENU_ENABLED`에 `'tools.memo'` 추가.
- `onMenuSelect`에서 `if (isMapping) return;`(303행) **앞** 구간에 추가:
  ```js
  if (id === 'tools.memo') { setShowMemo(true); return; }
  ```
  주석으로 "매핑 가드 앞 — 메모장은 본문 무변경 스크래치패드라 매핑에서도 연다"를 남긴다.

### (3) 툴바 결선

- `<EditorToolBar />`를 다음으로 교체:
  ```jsx
  <EditorToolBar
    enabledIds={['tool.memo']}
    onSelect={(id) => { if (id === 'tool.memo') setShowMemo(true); }}
  />
  ```
  (툴바 id는 `tool.memo`, 메뉴바 id는 `tools.memo` — 접두가 다르므로 각각 정확히 매칭한다. 두 진입점 모두 `setShowMemo(true)`로 수렴.)

### (4) 다이얼로그 렌더

- `GlyphInputDialog`/`UrlEmbedDialog` 근처에:
  ```jsx
  <MemoDialog
    open={showMemo}
    text={memoText}
    onChange={onMemoChange}
    onClose={() => setShowMemo(false)}
  />
  ```

## 핵심 규칙 (반드시 준수)

1. **본문 무변경(매핑 허용의 근거)**: 메모 결선의 어떤 경로도 `updateField('body', ...)`/`serialize`/blocks를 호출하지 않는다. 이것이 성립해야 매핑 모드에서 여는 것이 안전하다. 이유: 본문-only 불변식.
2. **매핑 가드 앞 라우팅**: `tools.memo`는 `if (isMapping) return;` **앞**에 둔다(`help.preferences`·URL 임베드와 동일 위치). 이유: 매핑에서도 열려야 하는 본문 비변경 기능 — 죽은 버튼 방지.
3. **두 진입점 단일 수렴**: 메뉴(`tools.memo`)·툴바(`tool.memo`) 모두 `setShowMemo(true)` 하나로 수렴한다(중복 상태 만들지 말 것). 이유: 단일 소스.
4. **영속화 게이트**: `memoText`는 마운트 시 `loadMemo()`로 lazy 초기화하고, `onMemoChange`에서 `saveMemo`한다. 환경설정 `onPrefsClose` 게이트에 끼워넣지 마라(메모는 prefs와 분리된 store). 이유: step0 설계 결정.
5. **Editor.jsx 무접촉**: 이 결선은 WriterPage 레벨에서만 한다. `Editor.jsx`를 수정하지 마라. 이유: 고위험 본체 최소 접촉 원칙.
6. **툴바 하위호환 유지**: `EditorToolBar`에 넘기는 `enabledIds`는 `['tool.memo']`만(다른 버튼 결선 금지). 이유: 범위 최소화.

## Acceptance Criteria

```bash
npm run test:web   # WriterPage 메모 결선 통합 테스트 포함 web 전체 통과
npm run build      # vite 빌드 에러 없음
npm run lint       # ESLint 통과
```

추가 단언(`WriterPage.test.jsx`, `fakeModel` 주입):
- 도구 메뉴 '메모장'(`tools.memo`) 클릭 → `data-testid="memo"` 다이얼로그가 열린다.
- 툴바 '메모장' 버튼(`tool-메모장`) 클릭 → 동일 다이얼로그가 열린다(단일 토글 수렴).
- 메모 textarea에 입력 → `saveMemo`로 영속(리마운트 후 `loadMemo()` 값이 textarea에 표시)되고, **본문(에디터 텍스트/임베드)은 불변**이다.
- **매핑 모드**(`isMapping`)에서도 메모장이 열린다(본문 비변경 → 매핑 허용). 열고 입력해도 본문/임베드가 바뀌지 않는다.
- 닫기/Escape로 다이얼로그가 닫힌다.

## 검증 절차

1. 위 AC 커맨드 실행(red→green 흐름 확인).
2. 아키텍처 체크:
   - 메모 경로 어디에도 `updateField('body'...)`/`serialize`/blocks 변경 없음(본문 무변경).
   - `tools.memo`가 매핑 가드 앞에 라우팅됨.
   - `Editor.jsx` diff 없음, `server/`·DB 미변경.
   - CLAUDE.md 규칙(DB 비파괴·TDD·client 전용) 준수.
3. `phases/21-editor-tools-memo/index.json`의 step 3을 갱신하고, phase 완료 시 `phases/index.json`(top-level)의 `21-editor-tools-memo` 항목 status/note를 갱신한다.

## 금지사항

- 메모 결선에서 본문(`updateField('body')`/`serialize`/blocks/캐럿)을 건드리지 마라. 이유: 본문-only 불변식이 깨지면 매핑에서 여는 것이 위험해지고 스크래치패드 정의에 어긋난다.
- `tools.memo`를 `if (isMapping) return;` 뒤에 두지 마라. 이유: 매핑에서 죽은 버튼이 된다(본문 비변경이라 열려야 함).
- `Editor.jsx`를 수정하지 마라. 이유: 고위험 본체 — 메모장은 WriterPage 레벨 별도 다이얼로그로 충분하다.
- 메모 텍스트를 `editorPrefs`/`onPrefsClose` 게이트에 끼워넣지 마라. 이유: step0에서 분리한 전용 store를 쓴다(적용/취소 결합 회피).
- `server/`·스키마·마이그레이션을 건드리지 마라. 이유: 메모장은 client 전용, DB 비파괴.
- 툴바에 `tool.memo` 외 다른 버튼을 활성화하지 마라. 이유: 범위 밖.
