# Step 8: undo-history

**목표**: 되돌리기/다시실행 스냅샷 스택(`editorHistory.js`)을 이식한다 — body(markupVersion 문자열)를 불투명 스냅샷으로 다루는 순수 자료구조. 코얼레싱·limit 절단·베이스라인 불변식. 순수.

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §7(undo/redo).
- `web/src/view/editorHistory.js` (58행) — `createHistory`·`pushHistory`·`undo`·`redo`·`canUndo`·`canRedo`.
- `web/src/view/editorHistory.test.js` (197행).
- **이전 step 산출물**: 없음(이 모듈은 body 문자열만 다뤄 blockmodel에 의존하지 않는다 — 의존 추가 금지).

## 작업 (테스트 먼저)
1. **red 먼저**: `client-qt/tests/historytest.{h,cpp}`에 케이스를 data-driven으로 옮긴다.
2. `client-qt/src/editor/history.{h,cpp}`:
   - `struct History { QStringList entries; int index; }` — `entries[index]`=현재, `entries[0]`=베이스라인.
   - `History createHistory(const QString& initialBody)`.
   - `History pushHistory(const History&, const QString& nextBody, bool coalesce, int limit=0)` — 동일 body no-op(동일 값 반환), coalesce&최상단&index>0이면 top 교체(성장 없음), 아니면 redo 분기 절단(`index+1`까지) 후 push, limit(양의 정수)>0 & 초과면 오래된 것부터 drop + index 보정. **베이스라인(entries[0])은 코얼레싱으로 교체되지 않는다.**
   - `struct UndoResult { History history; QString body; bool changed; }`(body 없음은 별도 표현) · `undo`/`redo` — 불가면 동일 history + changed=false.
   - `bool canUndo(const History&)`(index>0) · `bool canRedo(const History&)`(index<size-1).
   - **body는 불투명 문자열** — deserialize/JSON 파싱/재정규화 **절대 금지**(동일-body 판정이 어긋나 헛 스냅샷이 생긴다). 이 모듈은 blockmodel을 include하지 않는다.
3. 코얼레싱 시각 판정·탭 매핑은 이 모듈이 아니라 상위(step11 에디터 컨트롤러)가 `coalesce` 불리언으로 넘긴다.
4. 모듈 등록 2곳 + 테스트는 `tests.pro`에만.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed
# body를 재파싱하지 않는가(불투명 문자열 규율)
! grep -nE 'deserialize|fromJson|blockmodel' client-qt/src/editor/history.cpp
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
```

## 검증 절차
1. `editorHistory.test.js` 케이스 대응(누락 0). 코얼레싱 top 교체, redo 분기 절단, limit 절단+index 보정, 베이스라인 불변, 동일 body no-op.
2. TDD red: 베이스라인 코얼레싱 금지(`index>0`)를 제거하는 변이 → 베이스라인 교체 케이스 red(원복).
3. history.cpp가 blockmodel/JSON을 include하지 않는지 확인(불투명 규율).

## 금지사항
- body를 deserialize/재정규화하지 마라. 이유: 정규화는 직렬화(step1) 책임이고, 여기서 또 하면 동일-body 판정이 어긋나 헛 스냅샷이 쌓인다(`editorHistory.js:4-5`).
- 베이스라인(entries[0])을 코얼레싱으로 교체하지 마라. 이유: 문서를 연 시점 복원 지점이 사라진다.
- 테스트 더블을 `common.pri`에 넣지 마라(F1).
