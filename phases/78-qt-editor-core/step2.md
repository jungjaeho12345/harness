# Step 2: block-model

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (2)(8)(11)(12) · `baseline` (C)(D)
- **정본 소스(읽기 전용)**: `web/src/view/editorContent.js` (96행 전체) — 이식 대상
- **정본 테스트(전환 대상)**: `web/src/view/editorContent.test.js` (22 케이스) — **전수 열어 QtTest로 옮긴다**
- `spikes/p0-qt-editor/editorlogic.{h,cpp}` — `END_MARKER` 리터럴·QString 순수 규율(읽기)
- `docs/api-contract/openapi.yaml`·`endpoints.json` — 본문 직렬화 shape 확인용(읽기)
- `phases/78-qt-editor-core/step0.md` — `src/editor/` 배치·common.pri·러너 결선

## 배경

블록 모델은 에디터 전체의 기반이다 — 이후 모든 순수 step이 이 타입과 함수를 import한다. 본문 직렬화 `{format:'yh-editor',version:1,blocks:[]}` 는 **백엔드·계약과 바이트 동일**해야 한다(decisions (8)).

정본 규칙(벗어나지 마라):
- 상수: `EDITOR_FORMAT='yh-editor'` · `EDITOR_VERSION=1` · `END_MARKER='(끝)'` · `ALIGN_VALUES=['left','center','right','justify']`.
- `textBlock(text, align?)`: 유효 align만 필드로 넣고 무효/부재는 **키 자체를 생략**(미정렬 블록은 `{type,text}` — 직렬화 바이트 안정).
- `normalizeBlocks`: 배열 아니면 `[]`. text 블록은 text 문자열 강제 + 유효 align만 보존. embed 블록은 `{...b,type:'embed'}`. 알 수 없는 타입은 드롭.
- `serialize(blocks)` = `JSON.stringify({format,version,blocks:normalizeBlocks(blocks)})` — **키 순서·이스케이프가 JSON.stringify와 동일**해야 한다.
- `deserialize(raw)`: null/undefined/'' → `[]` · 배열 → normalize · 객체는 `blocks` 배열만 · 문자열은 JSON 시도 후 **전량 드롭이면 평문 폴백**(원문 텍스트 보존), 빈 문서(`source.length===0`)는 `[]` 그대로. 56~81행 분기를 정확히 옮긴다.
- `blocksToText` = 텍스트 블록만 `\n` 조인(임베드 제외) · `textToBlocks` = 줄당 텍스트 블록 · `hasEndMarker` = `blocksToText.includes(END_MARKER)`(substring).

## 작업

**테스트 먼저.** `client-qt/tests/`에 `editorContent.test.js` 22 케이스를 QtTest로 옮긴 클래스를 만들고 `tests/main.cpp`에 등록한다(red 실증 후 구현).

`client-qt/src/editor/blockmodel.{h,cpp}`에 순수 모듈(위젯 비의존):

```cpp
namespace editor {
  struct Block { QString type; QString text; QString align; QJsonObject embed; }; // 또는 variant — 재량
  extern const QString END_MARKER, EDITOR_FORMAT; constexpr int EDITOR_VERSION = 1;
  bool isValidAlign(const QString&);
  Block textBlock(const QString& text = {}, const QString& align = {});
  Block embedBlock(const QJsonObject& embed);
  bool isTextBlock(const Block&); bool isEmbedBlock(const Block&);
  QVector<Block> normalizeBlocks(const QVector<Block>&);
  QString serialize(const QVector<Block>&);            // JSON.stringify 바이트 동형
  QVector<Block> deserialize(const QString& raw);       // 문자열 입력
  QVector<Block> deserializeJson(const QJsonValue& raw);// 배열/객체 입력(오버로드 또는 별도)
  QString blocksToText(const QVector<Block>&);
  QVector<Block> textToBlocks(const QString&);
  bool hasEndMarker(const QVector<Block>&);
}
```
- Block 표현은 재량이나 **align 부재와 빈 align("")을 구분**할 수 있어야 한다(직렬화 시 키 생략 판정). embed의 임의 필드(`{...embed}`)를 보존해야 한다(QJsonObject 권장).
- `serialize`의 출력을 정본 `JSON.stringify` 결과와 **문자열 바이트로 대조**하는 케이스를 반드시 넣는다(한글·이스케이프·align 유무·임베드 필드 순서).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- `build.bat` exit 0 · **정본 `editorContent.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 22와 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **22에 맞추려 padding 금지** · 실패 0.
- `serialize` 바이트 대조 케이스 · `deserialize` 전량 드롭/빈 문서/평문 폴백 분기 케이스가 존재한다.
- P4 게이트(시나리오·npm test·lint) 무회귀 · 무접촉 diff 0.

## 검증 절차

1. `editorContent.test.js`를 전수 열어 옮긴 케이스 수를 원본 22와 대조하고 누락·병합·분해 내역을 요약에 적는다(decisions (12)).
2. **변이 2종 이상**: (M2-a) `textBlock`이 무효 align도 키로 넣게 → 바이트 대조 케이스 red? 원복. (M2-b) `deserialize` 전량 드롭 폴백 제거 → 평문 보존 케이스 red? 원복. 결과표(기대/실제/원복) 기록.
3. TDD red→green 실증 기록.

## 금지사항

- **body를 여기서 정규화 외로 재해석하지 마라**(marker 재정렬 등은 step3 writerBody). 이유: 계층 분리 — 이 모듈은 순수 직렬화/역직렬화만.
- **JSON 키 순서·이스케이프를 임의로 바꾸지 마라.** 이유: 백엔드·계약·검색(markupVersion LIKE)과 바이트가 갈리면 저장·검색 패리티가 깨진다.
- **위젯 타입(QPlainTextEdit 등)에 의존하지 마라.** 이유: 순수 모듈은 위젯 없이 QtTest로 판정돼야 한다(decisions (2)).
- **웹 원본을 고치지 마라.** 이유: 명세서 겸 대조군이다.
