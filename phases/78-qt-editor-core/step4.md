# Step 4: caret-range-math

**목표**: 캐럿/라인 순수 계산(`editorCaret.js`)과 단어/문단 경계(`editorRange.js`)를 이식한다. 위젯이 실제 DOM/QTextCursor 캐럿을 이 오프셋과 동기화한다(결선은 step10/11). 순수.

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §0(좌표계)·§6(caret)·§4(단어/문단 경계는 edit-ops가 사용).
- `web/src/view/editorCaret.js` (38행) — `lines`·`lineAtOffset`·`removeLineFromText`.
- `web/src/view/editorRange.js` (52행) — `wordBoundsAt`(\S 런)·`paragraphBoundsAt`(빈 줄 경계).
- `web/src/view/editorCaret.test.js` (36행) · `web/src/view/editorRange.test.js` (86행).
- **이전 step 산출물**: `client-qt/src/editor/blockmodel.{h,cpp}`(step1 · `blocksToText`).

## 작업 (테스트 먼저)
1. **red 먼저**: `client-qt/tests/caretmathtest.{h,cpp}`에 두 테스트 파일 케이스를 data-driven으로 옮긴다.
2. `client-qt/src/editor/caretmath.{h,cpp}`:
   - `QStringList lines(const QString&)` = `split('\n')`(빈 줄 보존 — `QString::split(u'\n')`, KeepEmptyParts).
   - `struct LineSpan { int lineIndex, start, end; }` · `LineSpan lineAtOffset(const QString& text, int caretOffset)` — clamp[0,len], 앞부분 개행 수 = lineIndex, 줄 start/end 오프셋.
   - `struct RemoveResult { QString text; QString removed; int caret; }`(removed 없음 표현은 별도 bool/optional) · `RemoveResult removeLineFromText(const QString&, int lineIndex)` — 범위 밖이면 무변, 삭제 후 캐럿은 그 자리(다음/마지막 줄 시작).
3. `client-qt/src/editor/textrange.{h,cpp}`:
   - `struct Bounds { int start, end; }` · `Bounds wordBoundsAt(const QString& line, int column)` — `\S` 런(공백 아닌 문자 런), 단어 없으면 start==end.
   - `Bounds paragraphBoundsAt(const QStringList& lines, int lineIndex)` — 빈 줄 경계 문단 범위(editorStats.paragraphIndex와 동일 기준).
   - **오프셋은 UTF-16 코드유닛**(QString 인덱스) — `\S` 판정은 코드유닛 단위로 웹과 동일(`editorRange.js` 대조).
4. 모듈 등록 2곳 + 테스트는 `tests.pro`에만.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
```

## 검증 절차
1. `editorCaret.test.js`·`editorRange.test.js` 케이스 대응(누락 0). 경계값(오프셋 0/len/범위 밖, 빈 줄 문단, 단어 없는 위치).
2. TDD red: `lineAtOffset`의 clamp 제거 변이 → 범위 밖 오프셋 케이스 red(원복).
3. `\n` split이 KeepEmptyParts인지(빈 줄이 유실되지 않는지) 케이스로 확인.

## 금지사항
- 위젯/QTextCursor에 의존하지 마라. 이유: 순수 계산이므로 위젯 없이 단위 판정 가능해야 한다 — DOM/QTextCursor 동기화는 step10/11.
- `QString::split`에서 빈 파트를 버리지 마라(`SkipEmptyParts` 금지). 이유: 빈 줄이 유실되면 색상 구간(부제↔본문) 판정과 라인 인덱스가 어긋난다.
- 테스트 더블을 `common.pri`에 넣지 마라(F1).
