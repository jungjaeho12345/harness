# Step 8: caret-and-range

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (11)(12) · `open_questions` (1)
- **정본 소스(읽기 전용)**: `web/src/view/editorCaret.js` (38행) · `web/src/view/editorRange.js` (52행)
- **정본 테스트(전환 대상)**: `web/src/view/editorCaret.test.js` (6) · `web/src/view/editorRange.test.js` (17) — 전수 전환
- `phases/78-qt-editor-core/step0.md` — `src/editor/` 배치

## 배경

캐럿/라인 계산과 단어/문단 범위 계산 — 둘 다 소형 순수 기하 leaf다. editOps(step10)·find(step11)·stats(step9)가 이들을 import하므로 먼저 세운다. **DOM 비의존**(캐럿 좌표는 인자로 받는다).

정본 규칙:
- `lines(text)` = split('\n'). `lineAtOffset(text, caretOffset)`: clamp 후 `{lineIndex, start, end}`(개행 수·직전 개행+1·다음 개행/끝). `removeLineFromText(text, i)`: 라인 제거 후 `{text, removed, caret}`(캐럿 = 그 자리 라인 시작, 마지막이면 새 끝).
- `wordBoundsAt(lineText, column)`: 연속 `\S` 런 경계 `{start,end}`(end 배타) · 캐럿이 단어 내부면 그 단어 · 공백이면 왼쪽 가장 가까운 단어 · 없으면 오른쪽 · 어느 쪽도 없으면 `start===end`(빈 범위).
- `paragraphBoundsAt`: 빈 줄('') 경계 문단(공백만 있는 줄은 비-빈 줄 — `editorStats.paragraphIndex`와 동일 정의).

## 작업

**테스트 먼저.** 두 테스트 파일(6+17=23)을 QtTest로 옮긴다.

`client-qt/src/editor/caret.{h,cpp}` + `client-qt/src/editor/range.{h,cpp}`:
```cpp
namespace editor {
  QStringList lines(const QString&);
  struct LineSpan { int lineIndex, start, end; };
  LineSpan lineAtOffset(const QString&, int caretOffset);
  struct RemoveLineResult { QString text; QString removed; bool hadLine; int caret; };
  RemoveLineResult removeLineFromText(const QString&, int lineIndex);
  struct Bounds { int start, end; };
  Bounds wordBoundsAt(const QString& lineText, int column);
  Bounds paragraphBoundsAt(const QStringList& lines, int lineIndex);   // 정본 시그니처 확인 후 맞춘다
}
```
- `paragraphBoundsAt`의 정확한 입력형(문자열 vs 줄 배열)은 정본 `editorRange.js`를 열어 맞춘다.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorCaret.test.js`·`editorRange.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 23(6+17)과 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **23에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 단어 경계의 공백-왼쪽/오른쪽 폴백 · 빈 범위(no-op 신호) · removeLine 마지막 줄 캐럿 케이스가 존재한다.

## 검증 절차

1. 두 테스트 파일 전수 대조(원본 6·17 대비 이식 수 기록).
2. **변이 2종**: (M8-a) `wordBoundsAt` 공백 위 왼쪽 폴백 제거 → 폴백 케이스 red? 원복. (M8-b) `lineAtOffset` clamp 제거 → 범위 밖 offset 케이스 red? 원복. 결과표 기록.

## 금지사항

- **캐럿을 DOM/위젯에서 읽지 마라.** 이유: 순수 계층은 좌표를 인자로 받는다(위젯 결선은 step14).
- **문단 정의를 임의로 바꾸지 마라.** 이유: `editorStats`(step9)·정렬(step10)과 정의가 갈리면 소비 측이 어긋난다.
- **위젯 의존·웹 원본 수정 금지.**
