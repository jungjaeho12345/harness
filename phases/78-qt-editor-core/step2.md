# Step 2: body-serializer-marker

**목표**: 본문 직렬화 정규화(`writerBody.js`)와 "(끝)" 마커 판정 헬퍼(`editorNewline.js` 마커부)를 이식한다. "(끝)"을 항상 최종 블록으로 정규화하고 임베드 순서를 보존하며, **바이트 패리티 골든 픽스처**로 잠근다. 순수.

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §3(serializer/마커 계약 + S군)·§0(좌표계).
- `web/src/view/writerBody.js` (85행) — `bodyTitle`·`serializeBodyFromBlocks`·`textLineToBlockIndex`·`insertEmbedAfterLine`·`appendEmbedToBody`.
- `web/src/view/editorNewline.js:1-29,78-82` — `hasEndMarker`·`appendEndMarker`·`isInputBlocked`(substring)·`isMarkerBlock`(trim).
- `web/src/view/writerBody.test.js` (184행) · `web/src/view/editorNewline.test.js` 중 마커/`isInputBlocked`/`appendEndMarker` describe 블록.
- **이전 step 산출물**: `client-qt/src/editor/blockmodel.{h,cpp}`(step1 — `serialize`/`deserialize`/`normalizeBlocks`/`blocksToText`/`END_MARKER`/`textBlock`).

## 작업 (테스트 먼저)
1. **red 먼저**: `client-qt/tests/writerbodytest.{h,cpp}` + `markertest.{h,cpp}`(또는 한 클래스)에 `writerBody.test.js`와 `editorNewline.test.js` 마커부 케이스를 QtTest data-driven으로 옮긴다.
2. `client-qt/src/editor/writerbody.{h,cpp}`:
   - `QString bodyTitle(const QString& body)` — 블록→텍스트→첫 줄 trim.
   - `QString serializeBodyFromBlocks(...)` — deserialize→정규화, **"(끝)"은 항상 최종 블록**(첫 마커 align 승계), 임베드는 순서 보존. 결과는 `blockmodel::serialize`로 낸다(바이트 패리티 계승).
   - `int textLineToBlockIndex(const QList<Block>&, int textLineIndex)` — null/음수/범위밖 = -1.
   - `insertEmbedAfterLine`/`appendEmbedToBody` — 마커 앞 삽입 + 최종 정규화(순수 규칙만 — 실제 임베드 UI는 P6). 반환 shape은 웹과 동형(`{body, caretTextLine}`).
3. `client-qt/src/editor/marker.{h,cpp}`(또는 blockmodel/newline에 통합):
   - `bool hasEndMarker(const QString& text)`(substring) · `QString appendEndMarker(const QString&)` · `bool isInputBlocked(const QString& text, int caretOffset)`(**`lastIndexOf` substring 기준**) · `bool isMarkerBlock(const Block&)`(**`text.trimmed() == END_MARKER`**).
   - **두 기준을 섞지 마라**(port-spec §3): 차단 판정=substring, 재정규화/블록 판정=trim.
4. **바이트 패리티 골든 픽스처**: 웹에서 `serializeBodyFromBlocks`로 만든 골든 문자열 셋(마커 중간→최종 이동, align 승계, 임베드 순서 보존, 레거시 평문 로드)을 픽스처로 두고 C++ 출력과 바이트 `QCOMPARE`.
5. 모듈 등록 2곳(`common.pri` + `tests/main.cpp`), 테스트는 `tests.pro`에만.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
```

## 검증 절차
1. `writerBody.test.js` + `editorNewline.test.js` 마커부 케이스 대응(누락 0).
2. 골든 픽스처가 바이트 비교인지 확인. 마커를 중간에 둔 malformed 입력이 최종으로 재정규화되는 케이스 포함.
3. TDD red: `isInputBlocked`를 trim 기준으로 바꾸는 변이 → "(끝)" 본문 인용 편집 케이스가 red(원복). `serializeBodyFromBlocks`가 마커를 최종으로 옮기지 않는 변이 → 골든 red.
4. `isMarkerBlock`(trim)과 `hasEndMarker`(substring)가 서로 다른 기준을 쓰는지 소스 확인.

## 금지사항
- 마커 substring/trim 두 기준을 통일하지 마라. 이유: 통일하면 "(끝)" 인용 기사의 정상 편집이 막히거나 재정규화 보호가 헛돈다(`editorNewline.js:78-101`).
- undo body처럼 여기서 body를 재파싱해 재정규화하지 마라(단, `serializeBodyFromBlocks`의 정규화는 계약이다) — 상위 히스토리(step8)는 body를 불투명 문자열로 다룬다.
- 테스트 더블을 `common.pri`에 넣지 마라(F1).
