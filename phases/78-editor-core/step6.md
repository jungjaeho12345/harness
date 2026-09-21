# Step 6: undo-history

되돌리기/다시실행용 본문 히스토리 스택을 이식한다. 순수 자료구조(coalesce 불리언만 받는다 — 시각 판정은 상태 기계 step9).

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — decisions (1)(5).
- `web/src/view/editorHistory.js` — **이식 원본**. shape `{ entries: string[], index: number }`(entries[index]=현재). `createHistory(initialBody)` · 새 스냅샷 push(동일 body no-op — 동일 참조/무변 반환) · undo/redo · coalesce(불리언 인자). **불변식**: `entries[0]`(베이스라인=문서 연 시점 본문)은 coalesce로 절대 교체되지 않는다(limit 절단으로만 탈락). body는 **불투명 문자열** — deserialize/JSON.parse로 해석·정규화 금지(정규화는 serialize가 담당). 모든 함수는 입력 mutate 금지.
- `web/src/view/editorHistory.test.js` — 명세서.
- step1 산출물(블록 모델 — 단, 히스토리는 body를 불투명 문자열로만 다룬다).

## 작업
1. `client-qt/src/editor/editorhistory.h`/`.cpp` 신설. 순수(React/DOM/clipboard/transport 비의존).
2. 시그니처(웹 1:1): `struct History{ QStringList entries; int index; }` · `History createHistory(const QString& initial)` · `History push(const History&, const QString& body, bool coalesce)` · `History undo(const History&)` · `History redo(const History&)` · `bool canUndo(const History&)`/`canRedo`. 반환은 새 값(입력 불변).
3. **body는 불투명 문자열**: 히스토리 안에서 직렬화/정규화하지 마라(동일-body 판정이 어긋나면 헛 스냅샷). 베이스라인 `entries[0]` 보존 불변식 · limit 절단 규칙 이식.
4. QtTest: `editorHistory.test.js` 케이스(동일 body no-op · coalesce로 현재 교체 · 베이스라인 불변 · undo/redo 경계 · limit 절단). TDD red 먼저.

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 0 failed.
- `node scripts/verify-qt-client.mjs --scenario boot --server exe` → exit 0.
- `git status --porcelain` 이 `client-qt/src/editor/**`·`client-qt/tests/**`·`phases/78-editor-core/**` 밖 무변.

## 검증 절차
1. 웹 케이스와 QtTest 1:1 대조 — 특히 `entries[0]` 베이스라인이 coalesce로 교체되지 않음.
2. 우회 변이 2종(베이스라인 교체 허용 · 동일-body no-op 제거로 헛 스냅샷)으로 red 실증 후 원복.
3. 무접촉 경로 diff 0.

## 금지사항
- 히스토리 안에서 body를 정규화/역직렬화하지 마라. 이유: 동일-body 판정이 어긋나 헛 스냅샷이 생긴다(웹 CRITICAL 주석).
- 타이머·시각 판정을 이 모듈에 넣지 마라. 이유: coalesce는 불리언 인자다 — 시각 판정은 step9(상태 기계).
- `entries[0]` 베이스라인을 coalesce로 교체하지 마라. 이유: 문서 연 시점으로의 되돌리기가 불가능해진다.
