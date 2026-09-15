# Step 3: edit-ops-range

**목표**: 범위 편집 코어(`editorNewline.js`의 `replaceRangeInBlocks`/`insertTextIntoBlocks`)와 수정(overwrite) 모드 판정(`shouldOverwriteNextChar`/`overwriteExtendLength`, 서로게이트 페어 포함)을 이식한다. Enter·여러 줄 붙여넣기·범위 대체·마커 clamp·임베드 보존·정렬 승계 규칙을 순수 계층에서 잠근다. 순수.

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §4(edit-ops)·§0(서로게이트).
- `web/src/view/editorNewline.js:31-206` — overwrite 헬퍼 + `insertTextIntoBlocks` + `replaceRangeInBlocks`(규칙 1-a/1-b/3/4/5 전부, 주석 포함).
- `web/src/view/editorNewline.test.js` (553행) 중 range/overwrite describe 블록(마커 헬퍼부는 step2에서 이미 전환).
- **이전 step 산출물**: `client-qt/src/editor/blockmodel.{h,cpp}`(step1) · `writerbody`/`marker`(step2 — `isMarkerBlock`).

## 작업 (테스트 먼저)
1. **red 먼저**: `client-qt/tests/rangeeditstest.{h,cpp}`에 range/overwrite 케이스를 data-driven으로 옮긴다.
2. `client-qt/src/editor/rangeedit.{h,cpp}`:
   - `struct Point { int lineIndex; int offset; }`(좌표 계약 = port-spec §0). `struct Range { optional<Point> start, end; }` 또는 동등.
   - `struct ReplaceResult { QList<Block> blocks; int caretLineIndex; }`.
   - `ReplaceResult replaceRangeInBlocks(const QList<Block>& blocks, const Range& range, const QString& text)` — 규칙 1-a(swap/collapsed), 1-b(캐럿 미상 폴백 = 마커 직전), **규칙 3(마커 clamp: start≥마커면 마커 직전, end는 마커 줄 시작 이전으로 clamp)**, 규칙 4(범위 내 임베드는 병합 결과 뒤 순서 보존), 규칙 5(align 승계: 첫=start, 마지막=end, 중간=start).
   - `ReplaceResult insertTextIntoBlocks(blocks, Point caret, text)` = `replaceRangeInBlocks(blocks, {caret, caret}, text)` 위임(규칙 두 벌 유지 금지).
   - `bool shouldOverwriteNextChar(const QString& text, int offset)` — 정수/범위/`'\n'`/`isInputBlocked`/서로게이트 low-내부 전부 false 폴백(`editorNewline.js:44-51`).
   - `int overwriteExtendLength(const QString& text, int offset)` — high+low 페어면 2, 아니면 1.
3. 마커 판정은 step2의 `isMarkerBlock`(trim) 재사용. `isInputBlocked`(substring)는 overwrite 게이트에서 재사용.
4. 모듈 등록 2곳 + 테스트는 `tests.pro`에만.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
```

## 검증 절차
1. `editorNewline.test.js` range/overwrite 케이스 대응(누락 0). 특히: 전체 선택(요소 앵커)에서 마커 오염 방지, 임베드 보존 순서, align 승계 3분기, 서로게이트 페어 overwrite.
2. TDD red: 규칙 3의 start clamp를 제거하는 변이 → `'[(끝)] + 전체선택 + 붙여넣기'`가 `'X\nY(끝)'` 오염으로 red(원복). overwrite 서로게이트 게이트 제거 → lone-high 잔존 케이스 red.
3. 입력 blocks가 mutate되지 않는지(복사본) 확인하는 케이스 존재.

## 금지사항
- 마커 보호를 호출부(위젯)로 미루지 마라. 이유: 요소 앵커 제스처의 start를 위젯 좌표계가 못 보므로 순수 계층에 모아야 마커가 지켜진다(`editorNewline.js:97-101`).
- collapsed 삽입과 범위 대체 규칙을 두 벌로 만들지 마라. 이유: 규칙이 갈리면 마커 보호 지점이 어긋난다 — `insertTextIntoBlocks`는 `replaceRangeInBlocks`에 위임한다.
- 범위 내 임베드를 삭제하지 마라. 이유: 미디어 무음 유실은 복구 수단이 없다(`editorNewline.js:102-105`).
- 테스트 더블을 `common.pri`에 넣지 마라(F1).
