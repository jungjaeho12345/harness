# Step 5: shortcuts-13

단축키 13종의 키 인식 + 순수 변환을 이식한다. 위젯(step8)은 이 순수 판정을 호출만 한다(조합 중 인터셉트 금지 — IME 규율은 step8).

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — decisions (2)(4) · open_questions (2).
- `web/src/view/editorShortcuts.js` — **이식 원본**. Alt+Y `(끝)` 삽입(골드색·중복 금지·맞춤법 on·마커 뒤 입력 차단) · Ctrl+Y `(계속)`(`CONTINUE_MARKER='(계속)'`) · Ctrl+D 라인 삭제(임베드 동반) · 대소문자 변환(텍스트-줄 단위). 키 인식은 레이아웃 무관하게 `code`(`KeyY`/`KeyD`)도 본다.
- `web/src/view/editorShortcuts.test.js` — 명세서(28 it).
- `web/src/view/editorEditOps.js` + `editorEditOps.test.js` — 단어삭제(마커 줄이면 no-op) · 정렬은 P6(excluded). **단어삭제만 이 step**.
- `web/src/view/writerBody.js` — `textLineToBlockIndex`(텍스트 줄 → 블록 인덱스 매핑 · 단축키가 블록 위에서 동작).
- step1~4 산출물(블록 모델·마커 가드·캐럿/범위).

## 작업
1. `client-qt/src/editor/editorshortcuts.h`/`.cpp` 신설. 순수(DOM/transport 비의존 — Qt에선 키 이벤트를 `{ Qt::KeyboardModifiers, key, code }` 정규 구조로 받는다).
2. **13종 키 인식 함수**(웹 1:1): `isInsertEndMarker`(Alt+Y) · `isInsertContinueMarker`(Ctrl+Y) · `isDeleteLine`(Ctrl+D) · 대소문자 변환 등. 각 변환은 **블록 배열 in → 블록 배열 out(입력 불변)**.
3. **마커 무결성**: `(끝)` 삽입은 중복 금지·마커 뒤 입력 차단(step3 게이트 경유) · 삭제/변환이 마커를 손상 조각으로 만들면 no-op(`editorEditOps` 가드 동형). 단어삭제가 마커 줄이면 no-op.
4. **키 인식은 순수 판정만** — 실제 인터셉트 타이밍(조합 중 무개입)은 step8 위젯이 소유. `editorEditOps`의 정렬(align)은 **P6**(여기 만들지 마라).
5. QtTest: `editorShortcuts.test.js`(28) + `editorEditOps.test.js`의 단어삭제 케이스. TDD red 먼저.

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 0 failed.
- `node scripts/verify-qt-client.mjs --scenario boot --server exe` → exit 0.
- `git status --porcelain` 이 `client-qt/src/editor/**`·`client-qt/tests/**`·`phases/78-editor-core/**` 밖 무변.

## 검증 절차
1. 웹 28 + 단어삭제 케이스와 QtTest 1:1 대조.
2. 우회 변이 2종(Alt+Y 중복 마커 허용 · Ctrl+D 임베드 동반 삭제 누락)으로 red 실증 후 원복.
3. 무접촉 경로 diff 0.

## 금지사항
- 정렬(align)을 이 step에 넣지 마라. 이유: 보기 정렬 메뉴는 P6이다(index.json open_questions (2)).
- 키를 `key`(문자)로만 인식하지 마라. 이유: 레이아웃 무관 인식에 `code`(KeyY/KeyD)가 필요하다(웹 계약).
- `(끝)` 삽입을 step3 게이트를 우회해 하지 마라. 이유: 마커 계약이 갈라진다.
