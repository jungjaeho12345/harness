# Step 4: caret-range

캐럿/줄 모델과 편집 범위(단어/문단 경계)를 이식한다. 단축키(step5)·상태 기계(step9)가 캐럿을 이 계약으로 다룬다.

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — decisions (1) · open_questions (2).
- `web/src/view/editorCaret.js` — **이식 원본**. 줄 분해(`lines`) · 캐럿 계약 `{ lineIndex, offset }`(readCaret 계약).
- `web/src/view/editorCaret.test.js` — 명세서.
- `web/src/view/editorRange.js` — **이식 원본**. `wordBoundsAt(lineText, column)`(연속 `\S` 런 · 캐럿이 공백 위면 왼쪽 가장 가까운 단어, 없으면 오른쪽, 어느 쪽에도 없으면 빈 범위 = no-op 신호) · `paragraphBoundsAt`(빈 줄 '' 경계 · 공백만 있는 줄은 비-빈 줄).
- `web/src/view/editorRange.test.js` — 명세서.

## 작업
1. `client-qt/src/editor/editorcaret.h`/`.cpp` · `editorrange.h`/`.cpp` 신설. 순수(위젯 비의존 — 문자열/줄 배열 입력).
2. 시그니처(웹 1:1): `QStringList lines(const QString&)` · 캐럿 struct `{ int lineIndex; int offset; }` · `Range wordBoundsAt(const QString& lineText, int column)`(end 배타 · 빈 범위 = `start==end`) · `Range paragraphBoundsAt(...)`.
3. `column`/`offset` 클램프 규칙 이식(`Math.max(0, Math.min(trunc, length))` 동형).
4. QtTest: `editorCaret.test.js`·`editorRange.test.js` 케이스. TDD red 먼저.

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 0 failed.
- `node scripts/verify-qt-client.mjs --scenario boot --server exe` → exit 0.
- `git status --porcelain` 이 `client-qt/src/editor/**`·`client-qt/tests/**`·`phases/78-editor-core/**` 밖 무변.

## 검증 절차
1. 웹 케이스와 QtTest 1:1 대조 — 특히 공백 위 캐럿의 좌/우 단어 선택, 빈 범위 no-op 신호.
2. 우회 변이 2종(공백 위 좌우 우선순위 뒤집기 · end 배타→포함)으로 red 실증 후 원복.
3. 무접촉 경로 diff 0.

## 금지사항
- 캐럿 offset을 바이트로 다루지 마라. 이유: 웹 계약은 UTF-16 코드유닛 — 한글에서 어긋난다.
- 문단 경계 정의를 `editorRange`와 상태표시줄(`editorStats`)에서 따로 두지 마라. 이유: 둘은 같은 정의여야 한다(웹 주석) — `editorStats`는 P6이지만 정의는 지금 맞춘다.
