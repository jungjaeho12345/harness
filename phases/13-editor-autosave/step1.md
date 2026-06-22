# Step 1: autosave-timer-recover — 자동저장 타이머 + 파일>복구 복원

## 배경 / 요구사항

Step 0에서 초안 저장소(`editorDraft.js`)와 자동저장 설정(`editorPrefs.autosave`)이 준비됐다. 이 step은:
1. **WriterPage 자동저장 타이머**: 설정이 켜져 있으면 간격마다 **활성 탭 내용을 초안으로 스냅샷**(`editorDraft.saveDraft`)하고, 보존 기한 지난 초안을 정리(`expireDrafts`).
2. **파일 > 복구**(`file.recover` 메뉴): 활성 탭의 최신 초안을 되살린다(`loadDraft` → `updateField`).

서버 저장이 아니다 — localStorage 초안만. `Editor.jsx`는 건드리지 않는다.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md`
- `web/src/view/editorDraft.js` — **Step 0 결과**: `saveDraft(key,data,nowMs)`/`loadDraft(key)`/`clearDraft(key)`/`expireDrafts(retentionDays,nowMs)`.
- `web/src/view/editorPrefs.js` — `loadEditorPrefs().autosave`(enabled/intervalSec/retentionDays).
- `web/src/view/WriterPage.jsx` — `activeTab`(`fields`/`articleId`/`id`/`mode`), `updateField(field,value)`, `MENU_ENABLED`/`onMenuSelect`(phase 9·11 — `help.preferences` 포함), `<EditorMenuBar enabledIds={MENU_ENABLED}/>`, `isMapping`, useEffect/useState/useRef import.
- `web/src/view/EditorMenuBar.jsx` — 파일>복구 항목 id = **`file.recover`**(L? — 파일 메뉴, '복구'). 활성화는 `enabledIds` 패턴.
- `web/src/controller/useWriteController.js` — `updateField`(필드 1개 설정), `activeTab.fields` 구조(title/body/author/coAuthor/region/.../embargoAt/secondEmbargoAt 등). 복구는 이 fields를 되돌린다.
- `web/src/view/WriterPage.test.jsx` — 회귀/신규(타이머는 vitest fake timers `vi.useFakeTimers()` 사용).

## 작업

TDD로 진행한다(vitest, 타이머는 `vi.useFakeTimers()`).

### 1. 자동저장 타이머 (WriterPage)

- 자동저장 설정을 상태로 보유: `const [autosaveCfg, setAutosaveCfg] = useState(() => loadEditorPrefs().autosave);` 환경설정 모달 닫힘(`onPrefsClose(applied)`)의 **`applied===true` 분기 안**에서 `setAutosaveCfg(loadEditorPrefs().autosave)`로 갱신(editorBg 갱신과 동일 게이트 — 취소 시 불필요). (cross: step0 `apply()`가 autosave를 `saveEditorPrefs`로 영속한 뒤 `onClose(true)`를 부르므로 이 재읽기가 최신값을 반영한다.)
- **활성 탭 ref 신설·미러링(필수 — WriterPage에 `activeTabRef`는 아직 없다; `lastCaretRef`(L105)만 존재)**: 타이머가 매 타이핑마다 재설정되지 않게 활성 탭을 ref로 읽되, 그 ref를 **새로 만들어 동기화**한다. 이게 없으면 `activeTab`이 `[autosaveCfg]` 클로저에 고정돼 stale된다.
  ```js
  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);  // lastCaretRef와 동일 미러링 패턴, 타이머 effect와 별개
  ```
- 타이머 effect(의존성 `[autosaveCfg]`만 — `activeTab`/`tab.fields`를 넣지 마라):
  ```js
  useEffect(() => {
    if (!autosaveCfg.enabled) return;            // 꺼져 있으면 타이머 없음
    const ms = autosaveCfg.intervalSec * 1000;
    const id = setInterval(() => {
      const tab = activeTabRef.current;                // 최신 활성 탭(미러 ref)
      const key = tab.articleId || tab.id;             // 기존=articleId, 신규=tab.id
      const hasContent = !!(tab.fields.body || tab.fields.title);
      if (!hasContent) return;                         // 빈 탭은 스냅샷 안 함
      saveDraft(key, { ...tab.fields }, Date.now());
      expireDrafts(autosaveCfg.retentionDays, Date.now());
    }, ms);
    return () => clearInterval(id);
  }, [autosaveCfg]);   // enabled/interval 변경 시 타이머 재설정, unmount 시 정리
  ```
  - `Date.now()`는 여기(WriterPage 런타임)서 호출해 `saveDraft`/`expireDrafts`에 넘긴다(저장소는 시계를 모름 — Step 0 규칙).
  - 스냅샷은 `tab.fields`(=EDITABLE_FIELDS 구성)만 저장한다 — `id`/`articleId`/`mode` 등 메타를 섞지 마라(복구는 `updateField` 화이트리스트만 통과하므로 메타는 무시되지만, 깨끗하게 fields만 저장).

### 2. 파일 > 복구 (`file.recover`)

- `MENU_ENABLED`에 `'file.recover'` 추가. `onMenuSelect`에서 **기존 공통 매핑 가드(`if (isMapping) return;`, help.preferences 분기 다음에 있음) 뒤에** 분기를 둔다(복구는 본문을 바꾸므로 매핑 차단 = 공통 가드 재사용, 분기 내 중복 isMapping 체크 불필요):
  ```js
  if (id === 'file.recover') {
    const tab = activeTab;
    const key = tab.articleId || tab.id;
    const draft = loadDraft(key);
    if (!draft) { window.alert('복구할 자동저장 내용이 없습니다.'); return; }
    if (!window.confirm('자동저장된 내용으로 복구하시겠습니까?')) return;
    Object.entries(draft).forEach(([k, v]) => updateField(k, v));   // updateField가 EDITABLE_FIELDS만 통과(메타 무시)
    clearDraft(key);                                                 // 복구 후 초안 제거 — 재복구로 부활 방지
    return;
  }
  ```
  - 복구는 초안 `data`(=저장된 `tab.fields`)의 각 필드를 `updateField`로 되돌린다. `body`/`title`을 모두 복원해 에디터가 재렌더(기존 본문 로드와 동일 경로 — `Editor.jsx` 무변경).

### 3. 초안 수명 — 송고/저장 후 무효화 (부활 방지)

- **문제**: `resetTabToBlank`(submit/saveMapping 성공 시)가 같은 `tab.id`를 재사용하므로, 무효화하지 않으면 빈 새 탭에서 복구 시 **이미 송고/제출된 내용이 부활**한다(news.md L144 "송고/보류/KILL 후 초기화" 위반).
- WriterPage의 `onAction`(송고/보류/KILL)·`onSaveMapping`에서 **성공 시** 직전 탭 키의 `clearDraft(key)`를 호출한다(전이/저장 직전에 `const key = activeTab.articleId || activeTab.id;`를 잡아두고, `await submit(...)`/`saveMapping()` 성공 후 `clearDraft(key)`).
- 신규 탭 키(`tab.id`)는 sessionStorage 탭에 묶여 같은 세션 reload엔 안정적이나, sessionStorage 소실/새 브라우저 탭에선 재발급돼 키가 어긋난다 → **신규 탭 복구는 best-effort**, 기존 기사(`articleId`)는 안정적으로 복구. (구현자가 추가 안정 키를 발명하지 마라 — best-effort로 둔다.)

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **Editor.jsx 무변경**: 복구도 `updateField('body', …)`의 기존 안전 경로로만. contentEditable/DOM 직접 조작 금지.
2. **타이머 안전**: `clearInterval`로 unmount/설정변경 시 정리. 의존성은 `[autosaveCfg]`만(타이핑마다 재설정 금지 — 활성 탭은 ref). 빈 탭/비활성 시 스냅샷 안 함.
3. **서버 무관**: 자동저장은 localStorage 초안만 — `model.save`/서버 PUT을 부르지 마라(신규 탭에 PUT/POST 트리거 위험 차단).
4. **복구 가드**: 초안 없으면 alert, 있으면 confirm 후 복구. 매핑 모드 차단.
5. **회귀 금지**: phase 9/11 메뉴 결선(변환·환경설정)·매핑 가드·타이핑 불변. `help.preferences` 등 기존 분기 보존.

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(vitest, `vi.useFakeTimers()`):
- 자동저장 켜짐 + 본문 있는 탭에서 `vi.advanceTimersByTime(intervalSec*1000)` → `editorDraft`에 활성 탭 키로 초안이 저장된다.
- **stale-closure 회귀**: 자동저장 켠 뒤 본문을 여러 번 바꾸고 advanceTimers → 저장된 초안이 **초기값이 아니라 최신 본문**이다(activeTabRef 미러링 검증).
- 자동저장 꺼짐이면 타이머 진행해도 초안 미저장. 빈 탭(본문/제목 없음)은 스냅샷 안 함.
- 파일>복구: 초안 있으면 confirm 후 `updateField`로 본문/필드 복원되고 본문이 초안 값으로 렌더된다; 복구 후 `clearDraft`로 초안 제거(재복구 시 alert); 초안 없으면 alert.
- **초안 무효화**: 송고/보류/KILL(또는 매핑 저장) 성공 후 해당 키 초안이 `clearDraft`된다(빈 새 탭에서 복구 시 부활 안 함).
- unmount 시 `clearInterval`(타이머 누수 없음). phase 9/11 메뉴 단언 불변.

## 검증 절차

1. AC 실행. 2. 아키텍처 체크(Editor 무변경, 서버 무관, 타이머 정리, 회귀). 3. `phases/13-editor-autosave/index.json` step 1 갱신(성공 completed+summary / 실패 error / 개입 blocked).

## 금지사항

- 자동저장으로 서버 저장(`model.save`/PUT/POST)을 하지 마라. 이유: 신규 탭에 POST면 기사 자동 생성, 기존 탭 PUT은 잠금/SSE 부작용 — localStorage 초안만.
- `Editor.jsx`를 수정하지 마라(복구는 updateField 경로).
- 타이머 의존성에 `activeTab`/`tab.fields`를 넣지 마라(타이핑마다 재설정). 활성 탭은 ref로 읽어라.
- 복구로 사용자 확인 없이 본문을 덮어쓰지 마라(confirm).
- phase 9/11 메뉴 결선·매핑 가드를 깨뜨리지 마라.
- 기존 테스트를 깨뜨리지 마라.
