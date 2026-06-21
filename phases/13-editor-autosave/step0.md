# Step 0: editor-draft-store — 초안 자동저장 저장소 + 자동저장 설정 탭

## 배경 / 요구사항

`docs/news.md` "# 에디터 환경설정 > 자동저장: 저장 간격(30초~5분), 보존 기한(1일~7일)" + "파일 > 복구" 메뉴. 해석: **편집 중 내용을 주기적으로 localStorage에 초안으로 저장**하고, **보존 기한이 지난 초안은 정리**하며, **파일>복구**로 되살린다(서버 저장 아님 — 안전).

이 step은 **초안 저장소 모듈(localStorage)** + **자동저장 설정 탭**(간격/보존기한)을 만든다. 타이머 스냅샷·복구 결선은 Step 1.

## 읽어야 할 파일

- `/CLAUDE.md`, `/docs/ARCHITECTURE.md`, `/docs/ADR.md` — view, 단순화, 클라 전용(서버 무관)
- `/docs/news.md` — "# 에디터 환경설정 > 자동저장", "파일 > 복구"
- `web/src/view/columnConfig.js`, `web/src/view/editorPrefs.js` — localStorage 저장소 패턴(STORAGE_KEY·readAll try/catch·graceful). **본보기**.
- `web/src/view/editorPrefs.js` — `DEFAULT_EDITOR_PREFS.autosave`(phase 10: `{ enabled:false, intervalSec:60, retentionDays:1 }`), `loadEditorPrefs`/`saveEditorPrefs`/`setEditorPref`.
- `web/src/view/EditorPrefsDialog.jsx` — phase 12에서 **탭 구조**(색상/날짜형식). **자동저장 탭을 추가**한다.
- `web/src/view/EditorPrefsDialog.test.jsx` — 회귀/신규 단언.

## 작업

TDD로 진행한다(vitest).

### 1. 초안 저장소 `web/src/view/editorDraft.js`

`editorPrefs`/`columnConfig`와 동일한 graceful localStorage 패턴:

```js
const STORAGE_KEY = 'yh.editorDrafts';   // { [key]: { data, savedAt(ms) } }

export function saveDraft(key, data, nowMs)   // key별 초안 저장({ data, savedAt:nowMs }). graceful.
export function loadDraft(key)                 // key의 초안 data 반환(없으면 null). graceful.
export function clearDraft(key)                // key 초안 삭제.
export function expireDrafts(retentionDays, nowMs) // savedAt이 retentionDays(일)보다 오래된 항목 제거.
```

규칙:
- `key`: 호출자(Step 1)가 `articleId`(기존 기사) 또는 탭 식별자(신규)로 정한다. 이 모듈은 key를 불투명 문자열로만 다룬다.
- `data`: 직렬화 가능한 객체(제목/본문/공통정보 등 — 호출자가 구성). 이 모듈은 내용 구조를 가정하지 않는다.
- **시간은 인자로 받는다**(`nowMs`) — 모듈 내부에서 `Date.now()`를 부르지 마라(테스트 결정성·순수성). 호출자(Step 1)가 `Date.now()`를 넘긴다.
- localStorage read/write는 try/catch graceful(불가/throw 시 기본/no-op). DROP/DELETE는 이 키(yh.editorDrafts)에 한정 — 다른 저장소 건드리지 마라.
- `expireDrafts(retentionDays, nowMs)`: `savedAt < nowMs - retentionDays*86400000`인 항목 제거 후 저장.

### 2. 자동저장 설정 탭 (`EditorPrefsDialog.jsx`)

- 탭 네비에 **자동저장** 탭 추가(`data-testid="prefs-tab-autosave"`). phase 12의 색상/날짜형식 탭·동작은 보존(회귀 금지).
- 폼: **사용** 토글(`enabled`), **저장 간격** select(30초/1분/2분/3분/4분/5분 → `intervalSec` 30/60/120/180/240/300), **보존 기한** select(1~7일 → `retentionDays`). `data-testid`: `pref-autosave-enabled`/`pref-autosave-interval`/`pref-autosave-retention`.
- **폼 상태 3-지점 동기화(필수 — 색상/날짜형식과 동일, 누락 시 phase 12 '재오픈 시 저장값 복원' 불변식이 autosave 탭에서만 깨짐)**:
  1. `const [autosave, setAutosave] = useState(() => loadEditorPrefs().autosave);`
  2. open 재초기화 `useEffect([open])` 블록에 `setAutosave(prefs.autosave);` 추가(다시 열 때 저장값으로 리셋).
  3. `reset()`(기본값)에 `setAutosave(DEFAULT_EDITOR_PREFS.autosave)` 추가(색/날짜형식과 동일하게 리셋).
- **적용(`apply`) 합성** — 기존 apply는 `next = { ...setEditorPref(loadEditorPrefs(),'colors',{...}), dateFormat }`로 dateFormat을 spread로 붙인다. autosave를 끼울 때 **colors/dateFormat 보존을 못박는다**:
  ```js
  const next = {
    ...setEditorPref(setEditorPref(loadEditorPrefs(), 'colors', { title, subtitle, body, background }),
                     'autosave', { enabled, intervalSec: Number(intervalSec), retentionDays: Number(retentionDays) }),
    dateFormat,
  };
  saveEditorPrefs(next);
  ```
  - select value는 문자열이므로 `intervalSec`/`retentionDays`는 `Number()`로 변환해 저장한다.
- 취소/기본값은 phase 12 동작 유지(기본값은 `DEFAULT_EDITOR_PREFS.autosave`). **EditorPrefsDialog.test.jsx의 색상+날짜형식 동시 적용 단언이 그대로 통과**해야 한다(회귀 확인).

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **graceful 영속**: localStorage 접근 try/catch(없거나 throw해도 기본/no-op).
2. **`Date.now()` 모듈 밖**: `editorDraft`는 시간을 인자(`nowMs`)로 받는다(순수·테스트 결정성). 내부에서 시계를 읽지 마라.
3. **탭 회귀 금지**: phase 12 색상/날짜형식 탭·testid·적용/취소/기본값을 보존하고 자동저장 탭만 추가.
4. **이 키만**: `editorDraft`는 `yh.editorDrafts` 키만 다룬다(다른 저장소/서버 무관).
5. **범위**: 이 step은 저장소+설정 탭만. 타이머 스냅샷·복구는 Step 1.

## Acceptance Criteria

```bash
npm run test:web && npm run build && npm run lint
```

추가 단언(vitest):
- `saveDraft('a',{title:'t'},1000)` 후 `loadDraft('a')`가 `{title:'t'}`; `loadDraft('none')===null`.
- `clearDraft('a')` 후 `loadDraft('a')===null`.
- `expireDrafts(1, 1000 + 2*86400000)`는 savedAt=1000 초안을 제거(2일 경과 > 1일 보존).
- localStorage 없거나 throw해도 save/load가 예외 없이 동작.
- 자동저장 탭: enabled/간격/보존기한 입력 후 '적용' → `loadEditorPrefs().autosave`에 반영. 색상/날짜형식 탭 기존 단언 불변.

## 검증 절차

1. AC 실행. 2. 아키텍처 체크(view 모듈, 서버 무관, graceful, Date.now 모듈 밖, 탭 회귀). 3. `phases/13-editor-autosave/index.json` step 0 갱신(성공 completed+summary / 실패 error / 개입 blocked).

## 금지사항

- 모듈 내부에서 `Date.now()`/`new Date()`를 부르지 마라(시간은 인자). 이유: 테스트 결정성·순수성.
- 타이머/스냅샷/복구를 이 step에서 구현하지 마라(Step 1).
- 서버/model/fetch를 부르지 마라(클라 localStorage 전용).
- phase 12 탭(색상/날짜형식)을 깨뜨리지 마라.
- 기존 테스트를 깨뜨리지 마라.
