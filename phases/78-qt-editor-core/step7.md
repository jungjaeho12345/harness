# Step 7: history-undo

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (9)(11)(12)
- **정본 소스(읽기 전용)**: `web/src/view/editorHistory.js` (58행 전체 — 특히 1~9행 CRITICAL 주석·불변식)
- **정본 테스트(전환 대상)**: `web/src/view/editorHistory.test.js` (14 케이스) — 전수 전환

## 배경

undo/redo용 본문 히스토리 스택 — **순수 자료구조**다. body는 **불투명 문자열**이고 여기서 다시 파싱·정규화하면 동일-body 판정이 어긋나 헛 스냅샷이 생긴다(decisions (9)). 탭↔히스토리 매핑·코얼레싱 시각 판정은 위젯/화면(P5/P6)의 것이고, 이 모델은 `coalesce` 불리언만 받는다.

정본 규칙:
- shape: `{entries: string[], index}` · `entries[index]` = 현재 본문.
- 불변식: `entries[0]`(베이스라인)은 coalesce로 **절대 교체되지 않고** limit 절단으로만 탈락.
- `createHistory(initialBody)` = `{entries:[String(initialBody??'')], index:0}`.
- `pushHistory(history, nextBody, opts)`: 동일 body는 **no-op(동일 참조 반환)** · `coalesce===true && atTop && index>0`이면 top 교체(성장 없음) · 그 외 redo 분기 절단 후 push · `limit`(양의 정수) 초과분은 오래된 것부터 버리고 index 보정.
- `undo`/`redo`: 불가면 `{history, body:null, changed:false}` · 가능하면 index ±1 · `{history:{entries, index}, body:entries[index], changed:true}`.
- `canUndo` = index>0 · `canRedo` = index<length-1.

## 작업

**테스트 먼저.** `editorHistory.test.js` 14 케이스를 QtTest로 옮긴다.

`client-qt/src/editor/history.{h,cpp}`:
```cpp
namespace editor {
  struct History { QStringList entries; int index; };
  History createHistory(const QString& initialBody);
  struct PushOpts { bool coalesce = false; int limit = 0; };   // limit<=0 = 무제한
  History pushHistory(const History&, const QString& nextBody, const PushOpts& = {});
  struct UndoResult { History history; QString body; bool changed; };  // body 없음 표현 필요
  UndoResult undo(const History&); UndoResult redo(const History&);
  bool canUndo(const History&); bool canRedo(const History&);
}
```
- body를 절대 deserialize/normalize하지 않는다(불투명 문자열 비교만). `body:null`(변경 없음)을 표현 가능한 반환형을 쓴다.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorHistory.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 14와 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **14에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- coalesce top 교체(성장 없음) · 베이스라인 불변 · limit 절단 index 보정 · redo 분기 절단 케이스가 존재한다.

## 검증 절차

1. `editorHistory.test.js` 전수 대조(원본 14 대비 이식 수 기록).
2. **변이 2종**: (M7-a) coalesce가 베이스라인(index 0)도 교체하게 → 베이스라인 불변 케이스 red? 원복. (M7-b) limit 절단 시 index 미보정 → index 보정 케이스 red? 원복. 결과표 기록.

## 금지사항

- **body를 파싱·정규화하지 마라.** 이유: 동일-body 판정이 어긋나 헛 스냅샷이 생긴다(decisions (9)).
- **베이스라인을 coalesce로 교체하지 마라.** 이유: 정본 불변식(entries[0]은 limit로만 탈락).
- **위젯 의존·웹 원본 수정 금지.**
