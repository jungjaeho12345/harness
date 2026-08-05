# Step 5: draft-key-scope

## 목표

**신규(미저장) 작성 탭의 자동저장 초안 키가 브라우저 창 사이에서 충돌하는 결함**을 닫는다. 지금 키는 `tab.articleId || tab.id`이고 신규 탭의 `tab.id`는 모듈 카운터가 만드는 `tab-1`, `tab-2`…다. `localStorage`는 **같은 출처의 모든 창이 공유**하므로 창 A의 `tab-1`과 창 B의 `tab-1`이 같은 초안 슬롯을 놓고 서로 덮어쓰고, 파일>복구는 다른 창에서 쓰던 기사를 되살린다.

해결은 **초안 키에만** 브라우저 탭 스코프 접두사를 붙이는 것이다. 탭 id 생성 규칙·탭 복원 로직·기존 기사 키(`articleId`)는 손대지 않는다.

> **선행**: WriterPage 패스의 두 번째 step. **step4가 끝난 뒤** 시작한다(같은 파일 `web/src/view/WriterPage.jsx`를 순차 수정 — 동시 수정 금지).
> 수정 대상은 **`web/src/view/editorDraft.js`, `web/src/view/WriterPage.jsx` + 두 테스트 파일**이다.

## 읽어야 할 파일

라인 번호는 실측 힌트다 — 심볼명으로 재확인하라.

- `docs/news.md` — "에디터 환경설정 > 자동저장", "파일 > 복구".
- `docs/ARCHITECTURE.md` — 클라이언트 로컬 상태(작성 탭 목록/내용은 `sessionStorage`, 초안은 `localStorage`), 프론트 MVC.
- `web/src/view/editorDraft.js` — 파일 전체(61줄).
  - `const STORAGE_KEY = 'yh.editorDrafts';` — `{ [key]: { data, savedAt } }`.
  - `readAll`/`writeAll` — `try/catch`로 감싼 graceful 패턴(접근 불가/throw 시 기본값·no-op).
  - `saveDraft(key, data, nowMs)` / `loadDraft(key)` / `clearDraft(key)` / `expireDrafts(retentionDays, nowMs)` — 시간은 인자로 주입받는다(모듈 안에서 `Date.now()` 금지).
  - 파일 상단 주석: "key는 불투명 문자열(호출자가 articleId 또는 탭 식별자로 정함)".
- `web/src/view/WriterPage.jsx` — 초안 키를 만드는 **5곳**(전부 `tab.articleId || tab.id` 형태):
  1. 자동저장 타이머 `useEffect` 안(`const key = tab.articleId || tab.id;`, 주석 "기존=articleId(안정), 신규=tab.id(best-effort)"),
  2. `saveDocument`의 신규 분기(`saveDraft(tab.articleId || tab.id, draftFields, Date.now())`),
  3. `file.recover` 처리(`const key = activeTab.articleId || activeTab.id;` → `loadDraft`/`clearDraft`),
  4. `onAction`(`const key = activeTab.articleId || activeTab.id;` → 성공 시 `clearDraft(key)`),
  5. `onSaveMapping`(같은 형태).
- `web/src/controller/useWriteController.js` — `nextTabId()`가 모듈 카운터로 `tab-${n}`을 만들고, `restoreTabs`가 `Number(String(t.id).replace(/^tab-/, ''))`로 카운터를 복원한다. **이 파일은 수정하지 않는다**(형식을 바꾸면 복원 로직과 다수 테스트가 함께 흔들린다).
  - 참고: 같은 파일의 `newClientId()`가 `globalThis.crypto?.randomUUID?.()` → 실패 시 `Date.now().toString(36)` 조합으로 폴백하는 관례를 쓴다(이번 스코프 id 생성도 같은 관례를 따르라).
- `web/src/view/editorDraft.test.js` — 순수 모듈 테스트 스타일(localStorage 스텁/초기화).
- `web/src/view/WriterPage.test.jsx` — 자동저장/복구 테스트 관례: `readDraftsStore()`(저장소 원본 파싱 — 대부분 **키를 모른다고 전제하고 `Object.keys(store)[0]`로 접근**), `enableAutosave()`, `vi.useFakeTimers()` + `advanceTimersByTime`, 기존 기사 초안은 `saveDraft('AKR1', …)`로 직접 시드.
  - **예외 1건(반드시 갱신)**: 파일>저장(신규 탭) 테스트의 `expect(keys[0]).toMatch(/^tab-/); // 신규 탭 key=tab.id(…)`(≈L2642)는 **새 키 규약과 정면으로 충돌해 반드시 red가 된다**. 이 단언 한 줄만 `expect(keys[0]).toBe(draftKeyFor(null, 'tab-1'));`(같은 파일에 `draftKeyFor` import 추가)로 갱신하고 옆 주석도 새 규약으로 고쳐라 — 구현이 틀린 것이 아니다. 그 밖의 기존 단언은 손대지 마라.
  - 다른 초안 테스트(자동저장 스냅샷 ≈L2255, 파일>복구 ≈L2646, 매핑/송고 계열 ≈L7685)는 `Object.keys(store)[0]`·`saveDraft('AKR1', …)` 접근이라 **영향이 없다**(무수정 green이어야 한다).

## 배경 (자기완결) — 왜 결함인가

`sessionStorage`(탭 목록)는 브라우저 탭별로 격리되지만 `localStorage`(초안)는 **출처 단위로 공유**된다. 그래서:

- 창 A와 창 B에서 각각 새 기사를 쓰면 둘 다 `tab-1`을 키로 자동저장한다 → 나중에 저장한 쪽이 상대 초안을 **덮어쓴다**(사용자는 알 수 없다).
- 창 B에서 파일>복구를 누르면 창 A가 쓰던 기사가 복구된다(**다른 문서 오복구**).
- 한쪽에서 송고/매핑 저장에 성공해 `clearDraft(key)`를 부르면 **다른 창의 초안까지 사라진다**.

기존 기사(`articleId`)는 전역 고유라 이 문제가 없다 — 결함은 신규 탭 키에만 있다.

## TDD — 테스트 먼저

**A. `editorDraft.js`(순수 모듈) — `web/src/view/editorDraft.test.js`**
1. `draftKeyFor('AKR1', 'tab-1')` → `'AKR1'`(기존 기사 키는 접두사 없이 그대로 — 창을 옮겨도 같은 기사 초안을 찾는다).
2. `draftKeyFor(null, 'tab-1')` / `draftKeyFor('', 'tab-1')` / `draftKeyFor(undefined, 'tab-1')` → `'<스코프>:tab-1'` 형태이고 `'tab-1'`과 **다르다**.
3. 같은 로드 안에서 여러 번 불러도 스코프가 **동일**하다(안정성) — `draftKeyFor(null,'tab-1') === draftKeyFor(null,'tab-1')`.
4. 창 격리 모사: `sessionStorage`를 비운(=다른 창) 뒤 다시 부르면 **다른 스코프**가 나온다. 반대로 `sessionStorage` 값이 유지되면(F5 모사: 모듈 캐시를 무시하고 저장값을 읽는 경로) 같은 키가 나온다 — 두 시나리오를 각각 단언하라(모듈 캐시 리셋이 필요하면 `vi.resetModules()` + 동적 import를 쓴다).
5. `sessionStorage` 접근이 throw하는 환경에서도 예외가 새지 않고 문자열 키를 돌려준다(graceful — 기존 `readAll`/`writeAll` 규율과 동형).
6. 회귀: `saveDraft`/`loadDraft`/`clearDraft`/`expireDrafts`의 기존 동작·시그니처가 그대로다(기존 테스트 무수정 green).

**B. `WriterPage` 결선 — `web/src/view/WriterPage.test.jsx`**
7. 결함 재현(키 격리): 신규 탭에서 자동저장이 돌면 저장소의 **유일한 키가 `'tab-1'`이 아니고** 접두사를 포함한다. (구현 상수를 그대로 베끼지 말고 `draftKeyFor(null, 'tab-1')`를 import해 기대값을 만들어라 — 계약 대조.)
8. 정상 플로우 회귀(핵심): 신규 탭 자동저장 → 파일>복구가 **그 초안을 되살린다**(같은 창·같은 탭이면 키가 일치한다는 증거). 복구 후 초안이 제거되는 기존 동작도 유지.
9. 정상 플로우 회귀: 기존 기사(articleId 있음) 초안은 `saveDraft('AKR1', …)`로 시드해도 파일>복구가 그대로 찾아낸다(접두사 미적용 증거) — 기존 테스트가 무수정 green이어야 한다.
10. 회귀: 송고 성공 시 `clearDraft`가 **그 탭의 키**만 지운다(다른 키의 초안은 남는다) — 다른 키를 하나 시드해 두고 단언.
11. 회귀: 파일>저장(신규)이 로컬 초안만 만들고 `saveArticle`을 부르지 않는 기존 계약이 유지된다.

기존 테스트는 **위에 명시한 1건(`/^tab-/` 단언)을 제외하고** 수정하지 않는다. 나머지 자동저장/복구 테스트는 키를 모른다고 전제하고 `Object.keys(store)[0]`로 접근하므로 그대로 통과해야 한다 — 통과하지 않으면 구현이 계약을 벗어난 것이다.

## 작업

1. `web/src/view/editorDraft.js`에 두 개를 추가한다(기존 함수는 무수정).
   ```js
   // 브라우저 탭 스코프 id — sessionStorage에 1회 만들어 보관한다(창/탭마다 다르고 F5에는 유지).
   export function draftScopeId() { /* … */ }
   // 초안 키 단일 출처. 기존 기사는 articleId 그대로, 신규 탭은 '<scope>:<tabId>'.
   export function draftKeyFor(articleId, tabId) { /* … */ }
   ```
   규칙:
   - `articleId`가 비어 있지 않은 문자열이면 **그대로** 반환한다(접두사 금지).
   - 스코프 id는 `sessionStorage`의 전용 키(예: `'yh.draftScope'`)에서 읽고, 없으면 만들어 저장한다. 생성은 `globalThis.crypto?.randomUUID?.()` → 실패 시 `Date.now().toString(36)`+난수 조합(`useWriteController.newClientId` 관례).
   - `sessionStorage` 접근이 불가하거나 throw하면 **모듈 스코프 메모리 값**으로 폴백해 이 페이지 로드 동안은 안정된 키를 쓴다(그 경우 F5 후 복구가 안 될 수 있음을 주석 한 줄로 남긴다).
   - 이 모듈은 계속 시계를 호출하지 않는다 — 스코프 생성의 `Date.now()` 폴백은 **id 생성 전용**이며 `savedAt` 등 저장 데이터에 쓰지 않는다.
   - 기존 `STORAGE_KEY`(`'yh.editorDrafts'`) 값·저장 shape·함수 시그니처는 바꾸지 않는다.
2. `web/src/view/WriterPage.jsx`의 **5곳**을 기계적으로 `draftKeyFor(tab.articleId, tab.id)`(또는 `activeTab` 기준)로 바꾼다. import에 `draftKeyFor`를 추가한다. 다른 로직(자동저장 조건·복구 확인창·성공 시 초안 제거 시점)은 한 줄도 바꾸지 않는다.
   - 자동저장 타이머의 주석 "신규=tab.id(best-effort)"는 새 규약에 맞게 **한 줄만** 고쳐라(창 간 충돌 방지 목적 명시).
3. 마이그레이션·정리 코드를 만들지 않는다. 옛 `tab-N` 초안은 그대로 두고 `expireDrafts`(보존일수)가 자연 정리한다.

## Acceptance Criteria

```bash
npm run lint      # 통과
npm run build     # 통과
npm run test:web  # 실패 0 — 87 files, step4 종료 시점 + 이번 신규 케이스
npm test          # 백엔드 무접촉 — 실패 0(개수는 step2 종료 시점과 동일)
```

`git diff --name-only`는 `web/src/view/editorDraft.js`, `web/src/view/editorDraft.test.js`, `web/src/view/WriterPage.jsx`, `web/src/view/WriterPage.test.jsx` **4개뿐**이어야 한다.

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 잔여 확인: `git grep -nE "articleId \|\| (tab|activeTab)\.id" -- web/src/view/WriterPage.jsx`로 옛 키 조합이 **0건**인지 확인한다(5곳 모두 교체됐다는 증거). 넓은 패턴(`"articleId || "`)으로 검색하면 초안 키와 무관한 3곳(탭 라벨 `t.fields.title || t.articleId || '새 기사'`, `publishPhoto`의 `sourceArticleId: activeTab.articleId || ''`, 문서 열기 목록의 `item.title || item.articleId || '(제목 없음)'`)이 잡힌다 — **그 3곳은 손대지 마라**(초안 키가 아니다).
3. 변이 검증 2종(확인 후 원복):
   - `draftKeyFor`가 항상 `tabId`만 돌려주게 바꾸면 키 격리 케이스(7)만 red.
   - `articleId` 분기를 지워 기존 기사에도 접두사를 붙이면 기존 기사 복구 케이스(9)가 red.
4. 아키텍처 체크리스트:
   - `editorDraft.js`가 여전히 클라이언트 저장소 전용 모듈인가(React/DOM/transport/네트워크 미도입)?
   - 컨트롤러(`useWriteController.js`)·탭 id 형식이 그대로인가?
   - 새 타이머·새 저장소 키(초안 저장소 자체)·마이그레이션 코드가 없는가?
   - 사용자 데이터를 삭제하는 코드가 없는가(옛 초안 정리 금지)?
5. `phases/54-audit-closeout/index.json`의 step5를 `completed` + `summary`로 갱신한다. summary에 키 규약(`articleId` 그대로 / 신규는 `<scope>:<tabId>`), 스코프 저장 위치(sessionStorage 키 이름), 폴백 동작, 옛 초안 무삭제 방침을 명시하라.

## 금지사항

- 옛 `tab-N` 초안을 지우거나 새 키로 옮기는 마이그레이션을 만들지 마라. 이유: 사용자 데이터를 지우지 않는다는 프로젝트 규율에 어긋나고, 어느 창의 초안인지 판별할 수단이 없어 잘못 이관하면 다른 문서를 덮어쓴다.
- `useWriteController`의 `nextTabId`/`restoreTabs`(`tab-N` 형식)를 바꾸지 마라. 이유: 복원 카운터가 접미 숫자를 파싱하고 다수 테스트가 이 형식을 단언한다 — 회귀 표면이 이번 결함보다 크다.
- 기존 기사 키(`articleId`)에 스코프 접두사를 붙이지 마라. 이유: 창을 옮기거나 다시 열었을 때 기존 기사 초안을 못 찾는 새 결함이 생긴다.
- 스코프 id를 `localStorage`에 저장하지 마라. 이유: 창 간 공유 저장소라 스코프가 다시 같아져 결함이 되살아난다.
- 초안 저장소 키(`'yh.editorDrafts'`)나 저장 shape(`{ data, savedAt }`)을 바꾸지 마라. 이유: 기존 초안이 통째로 유실되고 `expireDrafts` 계약이 깨진다.
- `editorDraft.js` 안에서 `Date.now()`로 `savedAt`을 만들지 마라. 이유: 시간 주입 계약(테스트 결정성)이며 기존 주석이 이를 못 박고 있다.
- 자동저장 타이머의 간격·조건(빈 탭 스킵·`expireDrafts` 호출)을 바꾸지 마라. 이유: 이 step은 키 규약만 바꾼다.
- `docs/ADR.md`·`docs/news.md`(읽기 전용 — 스펙 근거로만 참조)·`.claude/skills/**`·`phases/49-mini-backlog-cleanup/step0.md`·`phases/50-hygiene-cleanup/**`를 수정하거나 커밋에 포함하지 마라.
- 기존 테스트를 깨뜨리지 마라.
