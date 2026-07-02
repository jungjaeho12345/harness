# Step 1: writer-page-wiring — 도구>메모장 결선(전역 메모 state + 다이얼로그 + 영속)

## 배경 / 요구사항

Step 0이 순수 영속 모듈(`memoStore.loadMemo`/`saveMemo`)과 controlled `MemoDialog.jsx`(textarea + 저장/닫기)를 만들었다. 이 step은 `web/src/view/WriterPage.jsx`에서 도구 메뉴 **'메모장'**(`tools.memo`)을 결선한다 — 메뉴 클릭 시 전역 메모를 편집하는 다이얼로그를 띄우고, '저장'으로 localStorage에 영속한다.

**동작 모델(controlled + 명시 저장)** — 반드시 이대로 구현한다:
- 부모(WriterPage)가 메모 텍스트 state(`memoText`)를 소유한다. **마운트 시 `loadMemo()`로 lazy-init**(새로고침 후 저장된 메모 복원).
- textarea 입력 → `onChange`가 `setMemoText`만 한다(**세션 내 in-memory** — 다이얼로그를 닫았다 다시 열어도 편집이 살아 있음).
- **'저장' → `saveMemo(memoText)`로 localStorage에 영속**(새로고침/이동 후에도 유지). 저장 후 다이얼로그는 **열린 채 유지**한다(닫기는 '닫기'/Esc로 명시 — 두 버튼이 별개 동작).
- **'닫기'/Esc → `setShowMemo(false)`만** 한다(자동 저장 없음 — 명시 저장 모델). 세션 state는 남으므로 재오픈 시 미저장 편집이 보인다.

**메모는 기사와 완전히 독립**이다 — 본문(`body`/`markupVersion`)·캐럿·임베드·탭을 절대 건드리지 않는다. 따라서 **매핑 모드(텍스트 잠금)에서도 안전하게 열려야 한다**(file-info와 동일 정책 — 매핑 가드 앞 결선).

기존 결선 패턴을 그대로 따른다(`web/src/view/WriterPage.jsx`):
- 메뉴 활성: `MENU_ENABLED` 배열에 id 추가.
- 라우팅: `onMenuSelect(id)`에 분기 추가(**매핑 가드 앞**).
- 표시 토글 state: `showFileInfo`/`showGlyphInput`와 동일한 boolean state(`showMemo`).
- 값 state: `glyphFavorites`처럼 마운트 lazy-init(`useState(() => loadMemo())`).
- 다이얼로그 배치: `<FileInfoDialog>` 옆에 `<MemoDialog>` 추가.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md` — 프론트 MVC, DB 비파괴, 명령어(`npm run test:web`/`build`/`lint`).
- `/docs/ADR.md` — ADR-003(View 순수·transport 비의존). 매핑 모드의 본문 불변식(markupVersion을 바꾸지 않음)은 ADR 항목이 아니라 `docs/ARCHITECTURE.md`/코드의 markupVersion 규칙에서 온다 — 메모는 본문과 무관하므로 이 불변식과 충돌하지 않는다(그래서 매핑 가드 앞 결선 안전).
- `/docs/news.md` — L182(도구 메뉴 '메모장'), L175(우클릭 메뉴에는 메모장 없음 — 이번 결선은 도구 메뉴만).
- `web/src/view/WriterPage.jsx` — **결선 지점(실측; 라인은 근사)**:
  - `MENU_ENABLED` 배열(L72) — 여기에 `'tools.memo'`를 추가한다(기존 `'tools.fileInfo'` 등과 같은 배열).
  - state 선언부 — `showFileInfo`(L112)·`glyphFavorites`(L104, `useState(() => loadEditorPrefs()....)`) 패턴을 따라 `showMemo`·`memoText`를 추가한다.
  - `onMenuSelect(id)`(L298~) — 분기 라우팅. `tools.fileInfo` 분기(L310)가 **매핑 가드 `if (isMapping) return;`(L311) 앞**에 있다. `tools.memo`도 **같은 위치(매핑 가드 앞)**에 둔다.
  - 다이얼로그 렌더 블록(L703~749 — `<EditorPrefsDialog>`/`<FindReplaceDialog>`/`<GlyphInputDialog>`/`<UrlEmbedDialog>`/`<FileInfoDialog>`) — 여기에 `<MemoDialog>`를 추가한다.
  - `import { FileInfoDialog } ...`(L19) 인접에 `import { MemoDialog } from './MemoDialog.jsx';` 추가, `import { loadMemo, saveMemo } from './memoStore.js';` 추가.
- `web/src/view/MemoDialog.jsx` (Step 0 산출물) — props 계약: `open`, `value`, `onChange(text)`, `onSave()`, `onClose()`.
- `web/src/view/memoStore.js` (Step 0 산출물) — `loadMemo()`(→string)·`saveMemo(text)`(→string, 영속).
- `web/src/view/EditorMenuBar.jsx` — `tools.memo`(라벨 '메모장', L100) id 확인. **이 id를 그대로 결선**한다(새 id 금지).
- `web/src/view/WriterPage.test.jsx` — **테스트 컨벤션**: fakeModel/렌더, 메뉴 열기→항목 클릭, 다이얼로그 오픈/닫기, 메뉴 활성/비활성 단언, 매핑 탭 렌더. phase18/19/21이 `tools.*` 결선을 추가한 패턴을 그대로 따른다. **localStorage 격리**: 메모 영속을 검증하는 케이스는 `beforeEach`/케이스 내에서 `localStorage.clear()` 또는 `localStorage.removeItem('yh.editorMemo')`로 격리한다(다른 테스트의 잔존 메모로 인한 flakiness 방지).

## 작업

TDD로 진행한다(vitest). **`WriterPage.test.jsx`에 단언을 먼저 추가**하고 통과하는 결선을 만든다.

### 결선 (시그니처/배치 수준 — 구현 재량)

1. **import**: `web/src/view/WriterPage.jsx` 상단에
   ```js
   import { MemoDialog } from './MemoDialog.jsx';
   import { loadMemo, saveMemo } from './memoStore.js';
   ```

2. **state**:
   ```js
   const [showMemo, setShowMemo] = useState(false);        // showFileInfo 패턴
   const [memoText, setMemoText] = useState(() => loadMemo()); // glyphFavorites 패턴(마운트 lazy-init)
   ```

3. **라우팅**: `onMenuSelect`에 분기를 추가한다 — **매핑 가드(`if (isMapping) return;`) 앞**(메모는 본문 무관 → 매핑에서도 열림, 죽은 버튼 방지). `tools.fileInfo` 분기 인근에 둔다:
   ```js
   if (id === 'tools.memo') { setShowMemo(true); return; }
   ```

4. **MENU_ENABLED**: 배열에 `'tools.memo'`를 추가한다(다른 미결선 항목은 추가하지 않는다).

5. **다이얼로그 렌더**: `<FileInfoDialog>` 옆에 추가한다:
   ```jsx
   {/* 메모장(도구>메모장) — 기사와 무관한 전역 스크래치패드. controlled: 값은 memoText(부모 소유·마운트 lazy-init),
       '저장'만 localStorage 영속(saveMemo), 닫기/Esc는 닫기만(자동 저장 없음). 본문/캐럿/임베드 무변경 → 매핑에서도 안전. */}
   <MemoDialog
     open={showMemo}
     value={memoText}
     onChange={setMemoText}
     onSave={() => saveMemo(memoText)}
     onClose={() => setShowMemo(false)}
   />
   ```

> **주의**: 이 경로에서 `updateField`·`serialize`·`insertEmbed`·`setPendingCaretLine`·`Editor`의 새 prop 등 **본문/캐럿을 바꾸는 어떤 호출도 하지 마라**. 메모는 `memoText` state와 `saveMemo`(localStorage)만 만진다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **본문/캐럿/임베드 무변경(메모는 기사와 독립)**: 메모 경로에서 `updateField`·`serialize`·`insertEmbed`·`setPendingCaretLine` 등 본문/캐럿/탭 변경 호출을 하지 마라. `setShowMemo`·`setMemoText`·`saveMemo`만 쓴다. 이유: 메모는 본문(`markupVersion`)과 무관한 별도 저장소 — 본문을 오염시키면 안 된다(매핑 안전의 근거이기도 함).
2. **매핑 가드 앞 배치**: `tools.memo` 분기는 `if (isMapping) return;` **앞**에 둔다(`tools.fileInfo`/임베드 삽입 항목과 같은 영역). 이유: 메모는 본문 무관이라 매핑에서도 열려야 함(죽은 버튼 방지).
3. **명시 저장 모델**: '저장'만 `saveMemo(memoText)`로 localStorage에 영속한다. `onChange`(입력)와 '닫기'/Esc에서는 localStorage에 쓰지 마라(닫기는 자동 저장 없음). 이유: 두 버튼(저장/닫기)이 별개 동작 — 명세한 UX. (세션 내 편집 보존은 `memoText` state가 담당.)
4. **마운트 lazy-init**: `memoText`는 `useState(() => loadMemo())`로 한 번만 초기화한다. 매 렌더/매 오픈마다 `loadMemo()`를 다시 호출하지 마라(입력 중 값이 저장본으로 되돌아감). 이유: state가 세션 내 진실 소스 — 새로고침 시에만 저장본에서 복원(glyphFavorites와 동일 게이트).
5. **전역 메모 1개**: `memoText`는 articleId/탭에 종속시키지 마라(탭 전환 시 다시 로드/초기화 금지). 이유: 명세상 기사와 무관한 전역 메모 1개.
6. **기존 메뉴 id 재사용**: `EditorMenuBar`의 `tools.memo`(라벨 '메모장')를 그대로 결선한다. **새 id·새 라벨을 추가하지 마라**(id 불일치 시 메뉴가 죽는다 — BLOCKER 전력). 이유: 라벨이 아니라 안정 id 매칭.
7. **client 전용·server/DB 미변경**: `server/`·DB 스키마·`editorPrefs`를 건드리지 마라. 영속은 `memoStore`(localStorage)만. 이유: DB 비파괴·client 전용 기능.
8. **비결선 메뉴 비활성 유지**: `MENU_ENABLED`에 `tools.memo`만 추가한다(약어변환 등 다른 미결선 항목을 함께 켜지 마라). 이유: Scope 최소화.

## Acceptance Criteria

```bash
npm run test:web -- WriterPage    # 신규 메모장 결선 단언 통과
npm run test:web                  # web 전체 회귀 통과
npm run build
npm run lint
```

추가 단언(vitest, `WriterPage.test.jsx` — localStorage는 케이스별로 격리):
- 도구 메뉴의 '메모장' 항목이 **활성**이다(이전엔 disabled placeholder — 비활성→활성 전환 단언).
- '메모장' 클릭 시 `MemoDialog`(testid `editor-memo`, `role="dialog"` '메모장')가 열리고 textarea(`editor-memo-text`)가 보인다.
- textarea에 입력하면 값이 반영된다(controlled — 입력 후 textarea `value`가 입력값).
- 입력 후 **'저장' 클릭 시 localStorage(`yh.editorMemo`)에 영속된다** — `loadMemo()` 또는 `localStorage.getItem('yh.editorMemo')`가 입력값을 담는다.
- '닫기' 또는 Esc로 다이얼로그가 닫힌다(`editor-memo`가 사라짐).
- **재오픈 시 세션 내 편집 유지**: 입력(저장 안 함) → 닫기 → 다시 열기 하면 textarea에 방금 입력값이 남아 있다(부모 state 보존).
- **저장 없이 닫으면 localStorage 미변경**: 입력만 하고 '닫기'/Esc로 닫으면 `yh.editorMemo`가 갱신되지 않는다(명시 저장 모델).
- **매핑 모드에서도 열린다**: 매핑 탭(`mode==='mapping'`)에서도 '메모장'이 활성이고 다이얼로그가 열린다.
- **본문 무변경**: 메모를 열고 입력/저장/닫기 해도 기사 본문(`body`/`updateField`)이 변경되지 않는다(fakeModel/컨트롤러 상 본문 불변 단언, 또는 body prop이 그대로임을 단언).

## 검증 절차

1. 위 AC 커맨드를 실행한다(필요 시 `PYTHONUTF8=1`).
2. 아키텍처 체크리스트: 본문/캐럿/임베드 무변경·매핑 가드 앞 배치·명시 저장(저장만 영속)·마운트 lazy-init·전역 메모 1개·기존 id 재사용·server/editorPrefs/DB 불변·`MENU_ENABLED`에 `tools.memo`만 추가.
3. 결과에 따라 `phases/22-editor-memo/index.json`의 step 1을 갱신(completed+summary / error / blocked).

## 금지사항

- 메모 경로에서 `updateField`/`serialize`/`insertEmbed`/`setPendingCaretLine`/`Editor`의 새 prop을 쓰지 마라. 이유: 메모는 본문(`markupVersion`)과 독립 — 본문/캐럿 무변경(매핑 안전).
- `tools.memo` 분기를 매핑 가드(`if (isMapping) return;`) 뒤에 두지 마라. 이유: 메모는 본문 무관이라 매핑에서도 열려야 함(죽은 버튼 방지).
- `onChange`/'닫기'/Esc에서 `saveMemo`(localStorage 쓰기)를 호출하지 마라 — 영속은 '저장'에서만. 이유: 명시 저장 모델(저장/닫기가 별개 동작).
- `memoText`를 렌더/오픈마다 `loadMemo()`로 다시 초기화하거나 articleId/탭에 종속시키지 마라. 이유: 입력 값이 되돌아가고, 전역 메모 1개 명세에 어긋난다.
- `tools.memo`에 새 메뉴 id/라벨을 만들지 마라(기존 id 그대로 결선). 이유: id 불일치로 메뉴가 죽는다(BLOCKER 전력).
- 툴바의 `tool.memo`(단수, `EditorToolBar.jsx`) 또는 `EditorToolBar` 렌더(`<EditorToolBar />`, onSelect 미결선)를 건드리지 마라. 이유: 툴바 전체가 아직 미결선 상태라 별도 phase 범위 — 이번 scope는 도구 메뉴(`tools.memo`)만.
- `Editor.jsx`·`EditorMenuBar.jsx`·`server/`·`editorPrefs`·DB 스키마를 수정하지 마라. 이유: 결선만 — Editor 미접촉·client 전용·DB 비파괴.
- `MENU_ENABLED`에 `tools.memo` 외 다른 미결선 항목을 추가하지 마라. 이유: Scope 최소화.
