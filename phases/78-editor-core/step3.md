# Step 3: marker-newline-guard

"(끝)" 마커 계약의 단일 게이트를 이식한다. 마지막 `(끝)` 이후 입력 차단·개행 처리·마커 재정규화. 위젯(step8)의 **모든 입력 경로가 이 게이트를 경유**하도록 순수 층에 잠근다.

> 이 계약은 위반 시 오염 본문이 송고·배부되며 **비가역**이다(§5 리스크 ③). P5에서 가장 위험한 축이다.

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — decisions (2)(4).
- `docs/porting-plan-cpp-spring.md` §5 리스크 ③ — 마커 계약과 「모든 입력 경로가 게이트를 경유」.
- `web/src/view/editorNewline.js` — **이식 원본**. `isInputBlocked(text, caretOffset)`: 마지막 `(끝)`(`lastIndexOf`) 시작 오프셋 「이상」이면 차단(UTF-16 코드유닛 오프셋). 삭제/이동/선택 차단에는 쓰지 않는다.
- `web/src/view/editorNewline.test.js` — 명세서(55 it — 가장 큰 케이스 집합).
- `web/src/view/editorContent.js` — `END_MARKER` · `normalizeBlocks`(마커 최종 블록 유지).
- step0/step1 산출물(`END_MARKER` 단일 출처 · 블록 모델).

## 작업
1. `client-qt/src/editor/editornewline.h`/`.cpp` 신설(step0의 `isInputBlocked`를 여기로 이관·확장하거나 재수출). 순수.
2. 시그니처(웹 1:1): `bool isInputBlocked(const QString& text, int caretOffset)`(**UTF-16 코드유닛 오프셋** — `QString`은 UTF-16이라 자연 일치) · 개행 삽입 헬퍼(마커 뒤 차단 반영) · 마커 재정규화 헬퍼(`(끝)`을 항상 최종 블록으로 유지 — `editorEditOps`/`editorShortcuts`의 재정규화 동형).
3. **차단 대상은 삽입뿐**: 삭제·이동·선택은 차단하지 않는다(마커를 지우면 입력 재개 — news.md). 부분 삭제가 `(끝)`을 `끝)` 손상 조각으로 만드는 것을 막는 가드는 삭제 경로가 아니라 **삭제 결과의 마커 무결성 판정**으로(단어삭제 no-op 규칙 — step5와 공유).
4. QtTest: `editorNewline.test.js`의 55 케이스를 옮긴다(마지막 마커 `lastIndexOf`·오프셋 경계 「이상」·복수 마커·마커 없음). TDD red 먼저.

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 0 failed.
- `node scripts/verify-qt-client.mjs --scenario boot --server exe` → exit 0.
- `git status --porcelain` 이 `client-qt/src/editor/**`·`client-qt/tests/**`·`phases/78-editor-core/**` 밖 무변.

## 검증 절차
1. 웹 55 케이스와 QtTest 1:1 대조 — 특히 오프셋 경계(마커 시작 오프셋과 「같을 때」 차단).
2. 우회 변이 2종(`lastIndexOf`→`indexOf` · 부등호 「이상」→「초과」)으로 red 실증 후 원복.
3. 무접촉 경로 diff 0.

## 금지사항
- 위젯이 substring/trim으로 마커를 재판정하는 경로를 만들지 마라. 이유: 판정이 두 곳이면 계약이 갈라지고 오염 본문이 새어 나간다 — 단일 게이트만.
- 삭제·이동·선택을 차단하지 마라. 이유: `(끝)`을 지우면 입력이 재개되는 것이 계약이다(news.md).
- 오프셋을 바이트로 다루지 마라. 이유: 웹 계약은 UTF-16 코드유닛이며 한글에서 바이트≠코드유닛이라 차단 위치가 어긋난다.
