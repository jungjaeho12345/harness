# Step 7: autosave-draft

초안 자동저장 저장소를 이식한다. 시간·저장 매체를 주입받는 순수 계층으로 두고, localStorage 자리에 Qt 파일/QSettings 저장소를 이음매로 주입한다.

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — decisions (5).
- `web/src/view/editorDraft.js` — **이식 원본**. `STORAGE_KEY='yh.editorDrafts'` · 저장 shape `{ [key]: { data, savedAt(ms) } }` · **시간은 인자(nowMs)로 받는다(내부 Date.now 금지)** · graceful 패턴(접근 불가/throw 시 기본/no-op) · key는 불투명 문자열(호출자가 articleId/탭 식별자로 정함).
- `web/src/view/editorDraft.test.js` — 명세서.
- `client-qt/src/shell/configstore.*` — Qt 파일 저장소 패턴(tmp→rename 원자적 쓰기 · 화이트리스트) **참고용**(초안은 config와 별개 파일). 읽되 고치지 마라(P4 shell 회귀).
- `client-qt/src/shell/clientconfig.*` — CRITICAL: 세션ID·비밀번호·쿠키·토큰 금지 규율(초안에도 승계).

## 작업
1. `client-qt/src/editor/editordraft.h`/`.cpp` 신설. **모듈은 순수** — 저장 매체를 인터페이스로 주입받는다(`IDraftStore` 이음매: `save(key,data,savedAtMs)`/`load(key)`/`remove(key)`). 실제 구현은 Qt 파일 또는 `QSettings`(별도 파일 — config와 분리).
2. 시그니처(웹 계약 이식): `saveDraft(store, key, data, nowMs)` · `loadDraft(store, key)` · `clearDraft(store, key)` · `listDrafts(store)`. **`nowMs`는 인자**(모듈이 Date.now/`QDateTime::currentMSecs`를 부르지 않는다 — 테스트 결정성).
3. **타이머는 모듈에 없다** — 스냅샷 시점은 호출자(상태 기계 step9)가 결정(phase 77 `TimerPolicyTest`가 반복 타이머를 소스 스캔으로 금지).
4. **초안에 세션·쿠키·비밀번호·토큰을 담지 마라**(clientConfig CRITICAL 승계).
5. QtTest: `editorDraft.test.js` 케이스를 가짜 `IDraftStore`로 결정적으로 돈다(throw 시 no-op·기본 반환 포함). TDD red 먼저.

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 0 failed.
- `node scripts/verify-qt-client.mjs --scenario boot --server exe` → exit 0.
- `git status --porcelain` 이 `client-qt/src/editor/**`·`client-qt/tests/**`·`phases/78-editor-core/**`·(신규 초안 저장 구현 파일) 밖 무변 — 특히 `client-qt/src/shell/**` 무변.

## 검증 절차
1. 웹 케이스와 QtTest 1:1 대조(graceful throw → 기본/no-op 포함).
2. 우회 변이 2종(내부에서 현재시각 호출 · throw를 삼키지 않음)으로 red 실증 후 원복.
3. 무접촉 경로 diff 0 — `client-qt/src/shell` 무변 확인.

## 금지사항
- 모듈 내부에서 현재 시각을 읽지 마라. 이유: 웹 계약이 `nowMs` 인자 주입이며 테스트 결정성을 깬다.
- 타이머를 이 모듈에 넣지 마라. 이유: `TimerPolicyTest`가 반복 타이머를 금지한다 — 스냅샷 시점은 상태 기계(step9)가 소유.
- 초안에 세션/쿠키/비밀번호/토큰을 저장하지 마라. 이유: clientConfig CRITICAL 규율(민감정보 저장 금지).
- `client-qt/src/shell/configstore`를 고쳐 초안을 담지 마라. 이유: config(serverUrl/bounds)와 초안(복구)은 별개 파일이며 shell은 P4 회귀 기준이다.
