# Step 11: ime-shortcut-wiring

**목표**: 에디터 위젯에 IME(한글 조합)·단축키 13종·undo/redo·자동저장 debounce·"(끝)" 입력 차단 및 **마커 병합 가드(발산 D3)**를 결선한다. 순수 모듈(step3/6/7/8/9)을 위젯 이벤트에 붙인다. IME·캐럿은 실기+**육안 체크리스트**로 판정(P5 완료 게이트).

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §5(단축키)·§6(IME/caret + 마커 병합 가드 D3)·§7(undo/autosave · D5)·§1(R5/R9).
- `spikes/p0-qt-editor/editorwidget.cpp` — `keyPressEvent`/`inputMethodEvent`/`caretBlockedForInsert`/`inputMethodQuery(ImEnabled)` 스파이크 구현(IME 무개입·마커 게이트 실증).
- `web/src/view/Editor.jsx:305-332,398-409,541-544` — `caretBlocked`·`isInsertionKey`·composing 게이트·Enter 삽입 결선(계약만).
- `web/src/view/WriterPage.jsx:1230-1333` — 단축키 결선 순서·빈 줄 Backspace/Delete 판정.
- **이전 step 산출물**: `rangeedit`(step3) · `shortcuts`(step6 · predicate+P5 액션) · `coloring`(step7 · shouldRecolor) · `history`(step8) · `draftstore`(step9) · `editorwidget`(step10).
- `client-qt/src/net/editclientid.h` — `EditClientId` 수명(편집 표면당) · `client-qt/README.md:1177-1179,1189-1195`.

## 작업 (테스트 먼저 · 프로그램적 QtTest + IME 육안 체크리스트)
1. **red 먼저**: `client-qt/tests/editorwiringtest.{h,cpp}` — 프로그램적으로 검증 가능한 것: 마커 뒤 문자 입력 차단(마커 앞 편집 허용), 빈 줄 Backspace→줄 삭제, 마커 병합 가드(마커 줄 시작 Backspace no-op / 마커 직전 줄 끝 Delete no-op), Alt+Y 삽입, Ctrl+D 삭제, Ctrl+Z/Ctrl+Shift+Z undo/redo, 자동저장 debounce가 `setSingleShot(true)`인지(TimerPolicy 계열).
2. `editorwidget.cpp`에 결선:
   - **IME**: `inputMethodEvent` — 조합 시작/끝으로 `m_composing` 토글, 조합 중 재색칠 no-op(`shouldRecolor(..., composing)`), 조합 완료(commit) 시 재색칠. 마커 차단 구간에서 `inputMethodQuery(Qt::ImEnabled)`로 플랫폼 IME off(스파이크 승계).
   - **입력 차단(R5)**: `keyPressEvent`에서 삽입성 키(문자+Enter)면 `isInputBlocked(text, caretOffset)` 검사 후 차단(`caretBlockedForInsert`). 붙여넣기(`insertFromMimeData`)·드롭도 차단. 삭제/이동/선택은 허용.
   - **마커 병합 가드(D3 발산)**: (a) "(끝)" 줄 시작 Backspace = no-op, (b) "(끝)" 직전 줄 끝 Delete = no-op. 나머지 삭제는 통과. 웹은 브라우저에 위임했으나 Qt는 앱이 제어하므로 명시 가드(port-spec §6). 테스트로 잠근다.
   - **단축키 13종**: `QKeyEvent`→`shortcuts::KeyChord` 환산 후 predicate 분기. **P5 액션 결선**: Alt+Y(insertEndMarker+spellcheck on)·Ctrl+Y(insertContinueMarker)·Ctrl+D 및 빈 줄 Backspace/Delete(deleteLineAt+동반 임베드)·Insert(overwrite 토글, `shouldOverwriteNextChar` 소비)·Ctrl+Z(undo)·Ctrl+Shift+Z(redo)·Enter(insertTextIntoBlocks('\n')). **P6 액션(Alt+O/Alt+V/Ctrl+B/Ctrl+F)**: 인식 시 이벤트 소비(accept)만 하고 no-op — forward note "P6 결선".
   - **undo 결선**: 편집마다 `pushHistory`(코얼레싱 시각 판정은 위젯/컨트롤러가 `coalesce` 불리언으로), body는 `serializeBodyFromBlocks` 결과(불투명). undo/redo가 위젯 블록을 되돌린다.
   - **자동저장 debounce(D5)**: 편집 시 `QTimer`(**`setSingleShot(true)`**) 재arm → 만료 시 `saveDraft(draftKeyFor(...), body, nowMs)`. 반복 타이머 금지(TimerPolicyTest).
   - **재색칠 트리거**: commit(조합완료)/focusOut(blur)/load에만 재색칠(`shouldRecolor`).
   - **EditClientId**: 편집 표면(위젯 인스턴스) 생성/소멸에 `EditClientId` 수명을 붙인다(프로세스/세션/창당 아님). 잠금 획득 호출 자체는 P6/P7이 붙이나, 식별자 수명 자리는 여기서 만든다. `lockerSessionId`/`lockerClientId`를 읽지 마라.
3. **IME 육안 체크리스트** `client-qt/CHECKLIST-editor-ime.md`(또는 README 절): (i) 한글 조합 중 캐럿 튐 0, (ii) 조합 중 재색칠 없음(완료 시에만 색), (iii) "(끝)" 뒤 타이핑/Enter/붙여넣기/IME 전부 차단, 마커 앞 편집 허용, "(끝)" 삭제 시 입력 재개, (iv) 마커 줄로의 Backspace/Delete 병합이 막히는가, (v) overwrite 모드에서 서로게이트(이모지) 온전 대체. 판정 주체=사람(실물 MS-IME).
4. 모듈 등록: 테스트는 `tests.pro`+`tests/main.cpp`. `TimerPolicyTest`가 새 반복 타이머를 잡지 않는지(자동저장은 single-shot) 확인.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed(위젯 결선 QtTest + TimerPolicyTest 포함)
# 자동저장이 반복 타이머가 아닌가
! grep -nE 'setInterval|startTimer|setSingleShot\s*\(\s*false' client-qt/src/editor/editorwidget.cpp
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
```
**IME/캐럿 육안 체크리스트(사람 판정 · P5 완료 게이트)**: `CHECKLIST-editor-ime.md`의 (i)~(v)를 실물 Windows+MS-IME에서 확인. 자동 판정 불가 — 사람이 판정하고 결과를 step 요약에 기록(porting-plan §182 게이트).

## 노트
- step11은 결선 범위가 무겁다. 한 구현자 세션에 완료하기 어려우면 자연 경계에서 (a) IME + 입력 차단(R5) + 마커 병합 가드(D3)와 (b) 단축키 P5 액션 + undo + 자동저장 debounce로 분할한다.

## 검증 절차
1. 프로그램적 QtTest green: 마커 입력 차단·마커 병합 가드·단축키 P5 액션·undo/redo·debounce single-shot.
2. IME/캐럿 육안 체크리스트 (i)~(v) 판정 결과가 요약에 기록됐는지(미확인은 미확인으로 정직 기록).
3. TDD red: 마커 병합 가드를 제거하는 변이 → 마커 줄 병합 케이스 red(원복 · D3 실증). 자동저장을 `setSingleShot(false)`로 바꾸는 변이 → TimerPolicyTest red.
4. P6 액션 predicate가 인식되어 이벤트를 소비(no-op)하는지(브라우저 기본 동작/충돌 방지).
5. `EditClientId` 수명이 편집 표면당인지(프로세스/세션/창당 아님) 확인.

## 금지사항
- 조합 중 재색칠·본문 동기화를 하지 마라. 이유: 캐럿 튐·조합 파손(news.md:179 · ADR-018 IME 이점).
- 자동저장에 반복 타이머(`setInterval`/`setSingleShot(false)`/반복 `startTimer`)를 쓰지 마라. 이유: `TimerPolicyTest`가 red로 막는다 — single-shot 재arm debounce만.
- "(끝)" 마커 줄로의 삭제 병합을 브라우저처럼 방치하지 마라. 이유: `prev(끝)` 오염이 substring 송고 가드를 통과해 비가역 송고·배부된다(D3).
- P6 액션(다이얼로그/변환기/찾기)을 구현하지 마라. 이유: P6 소유 — predicate 인식+no-op까지.
- `lockerSessionId`/`lockerClientId`를 읽는 코드를 짜지 마라. 이유: 어떤 응답에도 없다(ADR-018 ③ · 과거 권한상승 수정).
- 테스트 더블을 `common.pri`에 넣지 마라(F1).
