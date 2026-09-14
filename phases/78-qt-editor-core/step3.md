# Step 3: body-serialization

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (3)(8)(12) · `baseline` (D)
- **정본 소스(읽기 전용)**: `web/src/view/writerBody.js` (85행 전체)
- **정본 테스트(전환 대상)**: `web/src/view/writerBody.test.js` (19 케이스) — 전수 전환
- `phases/78-qt-editor-core/step2.md` — `blockmodel` 계약(이 step이 import)
- `web/src/view/editorNewline.js` 78~101행 — **마커 이중 기준 CRITICAL 주석**(읽기 · step4와 공유)

## 배경

`writerBody`는 에디터가 읽은 블록(텍스트 + 임베드)을 **정규 순서**(본문 텍스트 → 임베드 → "(끝)")로 직렬화한다. **"(끝)" 마커는 항상 최종 블록으로** 재정규화되고, 그 판정은 **블록 trim 정확 비교**(`String(b.text).trim() === END_MARKER`)다 — step4의 substring `isInputBlocked`와 **절대 섞지 마라**(decisions (3)).

정본 규칙:
- `bodyTitle(body)` = `blocksToText(deserialize(body))`의 첫 줄 trim.
- `serializeBodyFromBlocks(blocks)`: deserialize → 첫 마커(trim 비교)를 찾아 제거 후 나머지 뒤에 `textBlock(END_MARKER, prevMarker.align)`을 붙여 serialize. **마커 align 승계**.
- `textLineToBlockIndex(blocks, i)`: 텍스트 블록만 0-base로 세어 배열 인덱스 반환 · null/음수/범위 밖 → -1.
- `insertEmbedAfterLine`: 지정 텍스트 줄 뒤에 임베드 + 빈 텍스트 줄 삽입 · "(끝)" 최종 정규화 · 빈 줄은 "(끝)" 앞 · 반환 `{body, caretTextLine}`.
- `appendEmbedToBody`: "(끝)" 앞(있으면)에 임베드 삽입, 없으면 끝.

## 작업

**테스트 먼저.** `writerBody.test.js` 19 케이스를 QtTest로 옮긴다(red 실증 후 구현).

`client-qt/src/editor/writerbody.{h,cpp}`:
```cpp
namespace editor {
  QString bodyTitle(const QString& body);
  QString serializeBodyFromBlocks(const QVector<Block>& blocks);   // 또는 QString body 입력 오버로드
  int textLineToBlockIndex(const QVector<Block>&, int textLineIndex);
  struct EmbedInsertResult { QString body; int caretTextLine; };   // caretTextLine 없음 = -1/nullopt
  EmbedInsertResult insertEmbedAfterLine(const QString& currentBody, const Block& embed, int textLineIndex);
  QString appendEmbedToBody(const QString& currentBody, const Block& embed);
}
```
- 마커 판정은 **trim 정확 비교** 헬퍼 하나로 통일하고 그 헬퍼 이름을 step4가 재사용한다(두 벌 금지).
- caretTextLine이 "없음"인 경우(null)를 표현 가능한 반환형을 쓴다(-1 또는 optional).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `writerBody.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 19와 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **19에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 마커 align 승계 · "(끝)" 최종 재정규화 · 임베드 순서 보존 케이스가 존재한다.

## 검증 절차

1. `writerBody.test.js` 전수 대조(원본 19 대비 이식 수 기록).
2. **변이 2종**: (M3-a) 마커 판정을 substring으로 바꿈 → 마커를 본문 중간에 인용한 케이스가 오정규화되어 red? 원복. (M3-b) 임베드 순서 재배치 → 순서 보존 케이스 red? 원복. 결과표 기록.

## 금지사항

- **마커 판정에 substring(`lastIndexOf`)을 쓰지 마라.** 이유: 이 계층은 재정규화 주체라 trim 정확 비교여야 한다 — substring으로 clamp하면 마커 인용 기사의 정상 편집이 막힌다(decisions (3)).
- **임베드를 삭제하거나 순서를 바꾸지 마라.** 이유: 미디어가 무음으로 사라지면 복구 수단이 없다(정본 규칙 4).
- **위젯 의존·웹 원본 수정 금지.**
