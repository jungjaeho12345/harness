# Step 9: autosave-draft

**목표**: 초안 자동저장 저장소(`editorDraft.js`)를 이식하되 브라우저 저장소를 **주입형 백엔드**로 바꾼다. 프로덕션은 Qt userData 파일(tmp→rename 원자적), 테스트는 인메모리 fake. `savedAt`은 주입(순수·결정성). 자동저장 타이머는 step11에서 debounce(`setSingleShot(true)`)로 결선.

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §7(autosave · D4/D5)·open_questions (3).
- `web/src/view/editorDraft.js` (118행) — `saveDraft`·`loadDraft`·`clearDraft`·`draftKeyFor`·`loadDraftForRecover`·`expireDrafts`(스코프 id 로직은 §7 D4에 따라 이식 제외 검토).
- `web/src/view/editorDraft.test.js` (190행).
- `client-qt/src/shell/configstore.{h,cpp}` (이전 phase 산출물) — tmp→rename 원자적 쓰기 + 주입형 `ConfigFileSystem` 이음매 패턴(재사용/모사). `client-qt/src/shell/appidentity.h` — userData 폴더(`기사작성기-qt`) 정본.
- `client-qt/README.md:1189-1195` — `TimerPolicyTest`(반복 타이머 금지).

## 작업 (테스트 먼저)
1. **red 먼저**: `client-qt/tests/draftstoretest.{h,cpp}`에 `editorDraft.test.js` 케이스를 **인메모리 fake 저장소**로 재배선해 옮긴다(브라우저 저장소 의존 제거, 단언 내용 보존). fake는 `tests/tests.pro`에만.
2. `client-qt/src/editor/draftstore.{h,cpp}`:
   - `struct Draft { QByteArray data; qint64 savedAt; }`(data는 직렬화 가능한 불투명 바이트/문자열 — 구조는 호출자 책임).
   - `class DraftStorage`(순수 가상): `read()`/`write(all)` — 저장소 전체를 key→Draft 맵으로. graceful(접근 불가/실패 시 기본/no-op).
   - `void saveDraft(DraftStorage&, key, data, qint64 nowMs)` · `optional<data> loadDraft(DraftStorage&, key)` · `void clearDraft(DraftStorage&, key)`(다른 key 보존) · `void expireDrafts(DraftStorage&, int retentionDays, qint64 nowMs)`(savedAt<cutoff 제거).
   - `QString draftKeyFor(const QString& articleId, const QString& tabId)` — articleId 있으면 그대로, 없으면 `<tabId>`(또는 `<scope>:<tabId>` — OQ-3 판정에 따름). `loadDraftForRecover(articleId, tabId)`→`{key, data}` 폴백(기존 기사엔 폴백 없음).
   - **프로덕션 백엔드** `FileDraftStorage : DraftStorage` — `%APPDATA%\기사작성기-qt\drafts.json`에 tmp→rename 원자적 쓰기(configstore 패턴). **이 프로덕션 클래스는 `common.pri`에 등록**, fake는 `tests.pro`에만.
3. **OQ-3 판정**: Qt는 단일 인스턴스(named mutex)라 창 간 공유 충돌이 없다 — 스코프 접두사를 생략할지 판정하고 요약에 기록. 생략하면 키를 articleId/tabId로만 구성.
4. **타이머 없음**: 이 step은 순수 저장 로직만. 자동저장 주기/debounce는 step11이 `setSingleShot(true)` QTimer로 붙인다 — 이 step에서 반복 타이머를 두지 마라.
5. 모듈 등록 2곳 + fake·테스트는 `tests.pro`에만.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed
# 반복 타이머/내부 시각 호출 부재
! grep -nE 'setInterval|startTimer|QBasicTimer|QDateTime::currentMSecsSinceEpoch|QTime::currentTime' client-qt/src/editor/draftstore.cpp
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
```

## 검증 절차
1. `editorDraft.test.js` 케이스 대응(누락 0 · 스코프 id 로직은 OQ-3 판정에 따라 제외/유지). save/load/clear 격리, expire cutoff, recover 폴백.
2. OQ-3 판정(스코프 접두사 유무)이 요약에 기록됐는지.
3. `FileDraftStorage`가 tmp→rename 원자적인지(부분 쓰기 시 기존 파일 보존) 케이스 확인.
4. TDD red: `clearDraft`가 다른 key까지 지우는 변이 → 격리 케이스 red(원복).

## 금지사항
- 모듈 내부에서 시각(now)을 읽지 마라. 이유: 순수·결정성을 위해 `savedAt`은 호출자가 `nowMs`로 주입한다(`editorDraft.js:3`). id 생성용 예외조차 P5에선 두지 않는다(스코프 접두사 생략 시).
- 반복 타이머를 두지 마라. 이유: `TimerPolicyTest`가 red로 막는다 — 자동저장 타이머는 step11의 `setSingleShot(true)` debounce다.
- 초안을 서버로 보내지 마라. 이유: 초안은 클라 로컬 파일이다(서버 DB 무관 · DB 비파괴와 별개 축).
- `FileDraftStorage`를 `common.pri`에 두되 fake는 `tests.pro`에만. 이유: fake가 프로덕션 exe에 링크되면 `rule7` red(F1).
