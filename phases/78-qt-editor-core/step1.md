# Step 1: block-model

**목표**: 웹 `editorContent.js`(블록 모델 + 직렬화/역직렬화)를 `client-qt/src/editor/`로 이식한다. **순서 보존 직렬화기**(QJsonObject 금지)로 markupVersion 바이트 패리티를 확보한다. 순수(QtGui/위젯 비의존).

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §0(오프셋)·§2(block-model)·§3-S군(직렬화 바이트/키순서)·§10(아키텍처 제약).
- `web/src/view/editorContent.js` (96행) — 이식 원본 전체.
- `web/src/view/editorContent.test.js` (165행) — QtTest로 전환할 명세.
- `spikes/p0-qt-editor/editorlogic.h`/`editorlogic.cpp` — 순수 모듈 구조 선례(`QString`/`QColor`만, 위젯 비의존).
- `client-qt/common.pri` — `CLIENT_SOURCES`/`CLIENT_HEADERS` 등록 지점. `client-qt/tests/main.cpp` — `runTestClass<…>()` 등록 지점. `client-qt/tests/tests.pro` — 테스트 전용 파일 등록 지점.
- `docs/SCHEMA.md:42-53`(Contents/markupVersion)·`docs/news-md-overrides.md:208`(검색이 markupVersion LIKE) — 왜 바이트가 계약인지.

## 작업 (테스트 먼저)
1. **red 먼저**: `client-qt/tests/blockmodeltest.{h,cpp}`를 만들고 `editorContent.test.js`의 케이스를 QtTest data-driven(`_data()`)으로 옮긴다 — 빈 구현 대비 먼저 fail.
2. `client-qt/src/editor/blockmodel.{h,cpp}`에 이식한다. 시그니처(구현은 재량, 규칙은 준수):
   - `namespace editor` 안에 `struct Block { enum Type {Text, Embed}; ... }` 또는 동등 표현. 텍스트 블록은 `text`(QString) + 선택 `align`, 임베드 블록은 **원본 JSON을 보존한 불투명 문자열**(D1).
   - `QString END_MARKER`(= "(끝)"), `ALIGN_VALUES`(left/center/right/justify), `bool isValidAlign(const QString&)`.
   - `QList<Block> normalizeBlocks(...)` — 알 수 없는 타입 제거, text는 문자열 강제, 입력 불변(복사본).
   - `QString serialize(const QList<Block>&)` — `{format:'yh-editor',version:1,blocks:[...]}` **compact JSON, 키순서 `format,version,blocks`**. 텍스트 블록 키순서 `type,text[,align]`(align은 유효할 때만). 임베드는 보존한 원본 JSON을 verbatim.
   - `QList<Block> deserialize(const QString&)` — null/빈/배열/객체/문자열 분기, JSON 실패/전량드롭이면 평문 폴백(원문 보존), 빈 문서는 빈 리스트, 부분 드롭은 정규화 결과(`editorContent.js:60-81` 그대로).
   - `QString blocksToText(...)`(텍스트 블록만 `'\n'` 조인) · `QList<Block> textToBlocks(const QString&)` · `bool hasEndMarker(...)`(= `blocksToText().contains(END_MARKER)`, **substring 기준**).
3. **JSON 이스케이프**는 JSON 규격 = `JSON.stringify`와 동일해야 한다(`"`·`\`·`\n`·`\r`·`\t`·`\b`·`\f`·`\u00xx` 제어문자). **`QJsonDocument`/`QJsonObject`로 직렬화하지 마라**(키 알파벳 정렬로 바이트가 깨진다). 파싱은 `QJsonDocument::fromJson`을 읽기용으로 써도 되나, **임베드 블록은 원본 substring을 별도 보존**해 재출력한다.
4. `common.pri`에 `src/editor/blockmodel.{h,cpp}` 등록, `tests/tests.pro`에 `blockmodeltest.*` 등록(테스트는 tests.pro에만 — F1), `tests/main.cpp`에 `runTestClass<BlockModelTest>()` 한 줄 추가.
5. **바이트 패리티 확인 케이스**를 반드시 포함: 웹에서 `serialize`로 만든 골든 문자열(예: `{"format":"yh-editor","version":1,"blocks":[{"type":"text","text":"제목"},{"type":"text","text":"","align":"center"}]}`)과 C++ `serialize` 출력이 **바이트 동일**함을 `QCOMPARE`.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · QtTest Totals: N passed, 0 failed
# 순서 보존 직렬화기 확인: QJsonObject로 blocks를 직렬화하지 않았는가
! grep -RnE 'QJsonObject|QJsonDocument\s*\([^)]*\)\.toJson' client-qt/src/editor/blockmodel.cpp | grep -i serialize
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력(무접촉)
```
(빌드는 Windows+Qt 머신에서 `client-qt\build.bat`으로만 green이 된다 — ADR-018 트레이드오프 ①. 빌드 불가 환경이면 그 사실을 요약에 적고 QtTest 소스의 케이스 대응만 검토한다.)

## 검증 절차
1. `editorContent.test.js`의 각 `it`/`describe`가 QtTest 케이스로 대응되는지 대조(누락 0 · port-spec §9).
2. 바이트 패리티 케이스가 실제로 골든 문자열과 `QCOMPARE`하는지 확인.
3. TDD red 실증: 직렬화 키순서를 알파벳으로 바꾸는 변이를 심어 바이트 패리티 케이스가 red가 되는지(원복).
4. `common.pri`에 `fake`/테스트 더블이 들어가지 않았는지(`rule7` 회귀 방지).

## 금지사항
- `QJsonObject`/`QJsonDocument`로 blocks를 직렬화하지 마라. 이유: 키를 알파벳 정렬해 markupVersion 바이트가 깨지고, 검색(LIKE)·웹↔Qt 기사 호환이 조용히 어긋난다.
- 임베드 블록을 재구성(키 재정렬/필드 재작성)하지 마라. 이유: 원본 키순서가 유실되면 바이트 패리티가 깨진다 — 파싱 시 원본 JSON을 보존해 verbatim 재출력한다.
- 테스트 더블/스텁을 `common.pri`에 등록하지 마라. 이유: 프로덕션 exe에 링크되어 `FakeNewsModelTest::rule7`이 red가 된다(phase 77 F1).
- 위젯/QtGui에 의존하지 마라. 이유: 순수 모듈은 위젯 없이 단위 판정 가능해야 한다(ADR-018 · 스파이크 구조).
