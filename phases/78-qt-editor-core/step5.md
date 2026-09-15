# Step 5: line-ops-encoding

**목표**: 문서/문단 정렬·단어 삭제(`editorEditOps.js`)와 EUC-KR 바이트 근사(`editorEncoding.js`)를 이식한다. `localeCompare`는 `QCollator`로 근사하고 웹 기대 순서와의 불일치를 실측 기록한다. 순수.

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §4(edit-ops · D2 localeCompare 발산).
- `web/src/view/editorEditOps.js` (110행) — `sortDocument`·`sortParagraph`·`deleteWordAt`·`sameBlocks`.
- `web/src/view/editorEncoding.js` (53행) — `normalizeInputMode`·`euckrStats`(2B 범위 테이블 + incompatible 카운트).
- `web/src/view/editorEditOps.test.js` (329행) · `web/src/view/editorEncoding.test.js` (88행).
- **이전 step 산출물**: `blockmodel`(step1) · `writerbody.textLineToBlockIndex`+`marker`(step2) · `textrange.wordBoundsAt`/`paragraphBoundsAt`(step4).

## 작업 (테스트 먼저)
1. **red 먼저**: `client-qt/tests/lineopstest.{h,cpp}` + `encodingtest.{h,cpp}`에 케이스를 data-driven으로 옮긴다.
2. `client-qt/src/editor/lineops.{h,cpp}`:
   - `struct SortResult { QList<Block> blocks; bool changed; }`.
   - `SortResult sortDocument(const QList<Block>&)` — 텍스트 줄만 안정 정렬(마커/임베드 제외), align은 텍스트 따라 이동, 마커 최종 재정규화(첫 마커 align 승계), `changed`는 `sameBlocks` 기준.
   - `SortResult sortParagraph(const QList<Block>&, int caretLineIndex)` — 캐럿 문단만, 매핑 실패/단일 줄 no-op.
   - `struct DeleteWordResult { QList<Block> blocks; bool changed; int caretColumn; }` · `deleteWordAt(blocks, caretLineIndex, column)` — 마커 줄/매핑 실패/단어 없음 no-op(caretColumn = -1/optional), align 승계.
   - **정렬 비교기**: `QCollator collator; collator.setNumericMode(false);` 기본 로케일. 안정 정렬은 인덱스 tie-break 또는 `std::stable_sort`로 보장(`localeCompare`가 안정 정렬인 점 계승).
3. `client-qt/src/editor/encoding.{h,cpp}`:
   - `QString normalizeInputMode(const QString&)` — 'ksc5601' 아니면 'unicode'.
   - `struct EuckrStats { int bytes, incompatible; }` · `euckrStats(const QString&)` — 코드포인트 단위 순회(서로게이트 페어를 한 문자로), ASCII 1B, 2B 범위 테이블(`editorEncoding.js:19-30` 그대로), 그 외 incompatible+1(바이트 0 기여).
4. **D2 관측**: 정렬 케이스를 돌려 웹 기대 순서와 `QCollator` 결과가 어긋나는 케이스가 있으면 그 입력·양쪽 순서·회피책을 step 요약에 실측 기록한다(관측 없이 "같다" 금지). 어긋나면 그 케이스만 QtTest 기대값을 실측값으로 두고 사유를 주석에 남긴다.
5. 모듈 등록 2곳 + 테스트는 `tests.pro`에만.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
```

## 검증 절차
1. `editorEditOps.test.js`·`editorEncoding.test.js` 케이스 대응(누락 0). align 이동·changed 판정·마커/임베드 제외·서로게이트 바이트.
2. D2 관측 결과가 step 요약에 기록됐는지(불일치 유무·케이스).
3. TDD red: `sortDocument`가 마커를 정렬 대상에 포함하는 변이 → 마커 제외 케이스 red(원복).

## 금지사항
- 관측 없이 "QCollator가 웹과 같다"고 적지 마라. 이유: ICU 로케일 규칙 차이는 실측 전 미확인이다(ADR-018 규율) — 어긋나면 케이스와 회피책을 기록한다.
- 정렬을 불안정 정렬(`std::sort`)로 하지 마라. 이유: 동일 값 상대 순서가 바뀌면 align 이동·changed 판정이 웹과 어긋난다.
- 테스트 더블을 `common.pri`에 넣지 마라(F1).
