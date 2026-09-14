# Step 4: marker-newline

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (3)(11)(12) · `baseline` (D)
- **정본 소스(읽기 전용)**: `web/src/view/editorNewline.js` (206행 전체 — 특히 78~109행 설계 이유 주석, 절대 요약하지 말고 규칙 1-a/1-b/3/4/5를 그대로 옮긴다)
- **정본 테스트(전환 대상)**: `web/src/view/editorNewline.test.js` (55 케이스) — 전수 전환
- `phases/78-qt-editor-core/step2.md`·`step3.md` — `blockmodel`·`writerbody`(trim 마커 헬퍼 재사용)
- `spikes/p0-qt-editor/editorlogic.{h,cpp}` — `isInputBlocked`(스파이크 초판 · 승격·검증)

## 배경

이 step이 "(끝)" 마커 계약의 핵심이다. **두 판정 기준이 공존하며 절대 섞으면 안 된다**(decisions (3)):
- **`isInputBlocked(text, caretOffset)`** = `lastIndexOf(END_MARKER)`(**substring** · UTF-16 코드유닛 오프셋) — 캐럿이 마커 시작 오프셋 **이상**이면 입력 차단. 마커 앞 편집·삭제·이동은 허용.
- **`isMarkerBlock(block)`**(step3의 trim 헬퍼 재사용) — `replaceRangeInBlocks`의 clamp 기준.

정본 규칙(벗어나지 마라):
- `hasEndMarker(text)` = substring `includes`. `appendEndMarker(text)`: 이미 있으면 그대로 · 빈 문자열/`\n` 끝이면 `+END_MARKER` · 아니면 `+'\n'+END_MARKER`.
- `shouldOverwriteNextChar(text, offset)`: 정수·범위(0≤offset<length) · `text[offset]!=='\n'` · `!isInputBlocked` · 서로게이트 페어 내부(low & 직전 high)면 false. 나머지 true. (수정 모드 캐럿 뒤 1글자 대체 판정)
- `overwriteExtendLength(text, offset)`: high+low 페어면 2, 아니면 1(astral 온전 대체).
- `insertTextIntoBlocks(blocks, caret, text)` = `replaceRangeInBlocks(blocks, {start:caret,end:caret}, text)`.
- `replaceRangeInBlocks(blocks, range, text)`: 좌표 = lineIndex(텍스트 블록 순번, 임베드 제외) + offset(blocksToText 절대 오프셋). **규칙 1-a**(한쪽만 있으면 collapsed·역방향 swap) · **1-b**(마커 앞 삽입 · markerLine===0이면 마커 앞 새 줄) · **3-start/3-end**(start가 마커 줄 이상이면 마커 직전으로 · end는 마커 줄 시작 이전으로 clamp) · **4**(범위 내 임베드는 병합 텍스트 **뒤**에 순서대로 보존) · **5**(정렬 승계: 첫 줄=start align · 마지막 줄=end align · 중간=start align). 반환 `{blocks, caretLineIndex}`.

## 작업

**테스트 먼저.** `editorNewline.test.js` 55 케이스를 QtTest로 옮긴다(red 실증 후 구현).

`client-qt/src/editor/newline.{h,cpp}`:
```cpp
namespace editor {
  bool hasEndMarkerText(const QString&);           // substring
  QString appendEndMarker(const QString&);
  bool isInputBlocked(const QString& text, int caretOffset);   // substring lastIndexOf
  bool shouldOverwriteNextChar(const QString& text, int offset);
  int  overwriteExtendLength(const QString& text, int offset);
  struct Point { int lineIndex; int offset; bool valid; };     // null 표현
  struct Range { Point start; Point end; };
  struct ReplaceResult { QVector<Block> blocks; int caretLineIndex; };
  ReplaceResult insertTextIntoBlocks(const QVector<Block>&, const Point& caret, const QString& text);
  ReplaceResult replaceRangeInBlocks(const QVector<Block>&, const Range&, const QString& text);
}
```
- UTF-16 서로게이트: QString은 UTF-16 코드유닛이라 정본과 오프셋 의미가 일치한다 — high(0xD800~0xDBFF)/low(0xDC00~0xDFFF) 판정을 그대로 옮긴다.
- 마커 clamp는 step3의 trim 헬퍼를 **재사용**(두 벌 금지). `isInputBlocked`만 substring이다.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorNewline.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 55와 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **55에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 반드시 존재하는 케이스: 서로게이트 페어 overwrite(1/2) · 마커 직전/직후 입력 차단 경계 · 규칙 3-start/3-end clamp(전체 선택·문단 선택이 마커 줄에 얹히는 경로) · 규칙 4 임베드 보존 · 규칙 5 정렬 승계.

## 검증 절차

1. `editorNewline.test.js` 전수 대조(원본 55 대비 이식 수 기록).
2. **변이 3종**: (M4-a) `isInputBlocked`를 trim 블록 기준으로 바꿈 → 마커 중간 인용 편집 케이스 red? 원복. (M4-b) 규칙 3-end clamp 제거 → `X\nY(끝)` 오염 케이스 red? 원복. (M4-c) `overwriteExtendLength`를 항상 1로 → astral 대체 케이스 red? 원복. 결과표 기록.

## 금지사항

- **`isInputBlocked`(substring)와 마커 블록 clamp(trim)를 하나로 합치지 마라.** 이유: decisions (3) — 오염 본문이 송고·배부되면 비가역이다.
- **규칙 3(마커 clamp)·규칙 4(임베드 보존)를 「호출부 책임」으로 미루지 마라.** 이유: 정본이 순수 계층 한 곳에 보호를 모았다(요소 앵커 제스처는 caretBlocked가 못 본다 — editorNewline 97~101행).
- **위젯 의존·웹 원본 수정 금지.**
