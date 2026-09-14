# Step 11: find-engine

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (6)(11)(12) · `excluded` (c)
- **정본 소스(읽기 전용)**: `web/src/view/editorFind.js` (125행)
- **정본 테스트(전환 대상)**: `web/src/view/editorFind.test.js` (34 케이스) — 전수 전환
- `phases/78-qt-editor-core/step2.md`·`step3.md`·`step8.md` — `blockmodel`(blocksToText)·`writerbody`(textLineToBlockIndex)·`caret`(lineAtOffset) import

## 배경

찾기/바꾸기 **순수 계산 엔진**을 이식한다 — 본문 텍스트(임베드 제외)에서 리터럴 부분문자열을 찾고 치환한다. 좌표는 `blocksToText(blocks)` 절대 오프셋 기준. 바꾸기는 텍스트 블록 text만 수정한 새 블록 배열을 돌려준다(임베드·"(끝)"·순서 불변). **다이얼로그·캐럿 이동·하이라이트는 P6**이다(decisions (6)) — 이 step은 엔진 + `isFindReplace`(Ctrl+F 인식)만.

정본 규칙: `isFindReplace(e)` = Ctrl+F(`!alt`, key/code 병행, meta 무시). 찾기(다음/이전·대소문자·전체)·바꾸기(1건/전체) 계산 export를 전수 열어 옮긴다. "(끝)" 줄·임베드는 치환 대상에서 보존한다.

## 작업

**테스트 먼저.** `editorFind.test.js` 34 케이스를 QtTest로 옮긴다. 정본 export 시그니처를 실물에서 맞춘다.

`client-qt/src/editor/find.{h,cpp}`: `isFindReplace` + 찾기/바꾸기 엔진(리터럴 substring · 좌표 blocksToText 절대 오프셋 · 치환은 새 블록 배열 반환).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorFind.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 34와 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **34에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 반드시 존재: 다음/이전 순환 · 대소문자 · 전체 바꾸기가 임베드·"(끝)"·순서를 보존 · 한글/공백 리터럴 케이스.

## 검증 절차

1. `editorFind.test.js` 전수 대조(원본 34 대비 이식 수 기록).
2. **변이 2종**: (M11-a) 바꾸기가 임베드 블록도 건드리게 → 임베드 보존 케이스 red? 원복. (M11-b) 좌표를 blocks 인덱스로 오용(blocksToText 오프셋 아님) → 오프셋 케이스 red? 원복. 결과표 기록.

## 금지사항

- **다이얼로그·캐럿 이동·하이라이트를 여기서 만들지 마라.** 이유: P6의 것이다(decisions (6)) — 이 step은 순수 엔진만.
- **임베드·"(끝)"을 치환 대상으로 삼지 마라.** 이유: 정본은 텍스트 블록 text만 수정한다.
- **위젯 의존·웹 원본 수정 금지.**
