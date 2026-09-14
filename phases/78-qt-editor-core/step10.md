# Step 10: edit-ops

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (3)(11)(12)
- **정본 소스(읽기 전용)**: `web/src/view/editorEditOps.js` (110행 — 특히 1~9행 정책 주석)
- **정본 테스트(전환 대상)**: `web/src/view/editorEditOps.test.js` (38 케이스) — 전수 전환
- `phases/78-qt-editor-core/step2.md`·`step3.md`·`step8.md` — `blockmodel`·`writerbody`(textLineToBlockIndex)·`range`(wordBoundsAt·paragraphBoundsAt) import
- `web/src/view/editorNewline.js` 78~101행 — 마커 이중 기준(재확인)

## 배경

편집 메뉴 문서/문단 정렬 · 단어 삭제 — 블록 배열 in→out(입력 불변). 정책(정본 1~9행): **"(끝)" 마커는 정렬 대상에서 제외하고 항상 최종 블록으로 유지**(step3 재정규화 규칙 동형) · 임베드는 정렬 대상이 아니며 자리를 옮기지 않는다(텍스트 값·정렬 쌍만 텍스트-블록 슬롯에 순서대로 되쓴다) · **단어 삭제는 마커 줄이면 no-op**(부분 삭제가 마커를 '끝)' 손상 조각으로 만들어 송고 자격을 조용히 깨는 것 방지). 한 줄 지우기는 여기 만들지 않는다(`deleteLineAt`이 단일 출처 — step5).

## 작업

**테스트 먼저.** `editorEditOps.test.js` 38 케이스를 QtTest로 옮긴다. 정본 export(정렬·단어 삭제 함수)를 전수 열어 시그니처를 맞춘다.

`client-qt/src/editor/editops.{h,cpp}`: 문서/문단 정렬 · 단어 삭제. 마커 재정규화는 step3의 trim 헬퍼를 재사용(두 벌 금지). 단어 경계는 step8 `wordBoundsAt`, 문단 경계는 `paragraphBoundsAt`를 쓴다.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorEditOps.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 38과 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **38에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 반드시 존재: 마커 줄 정렬 제외(최종 유지) · 임베드 자리 불변 · 단어 삭제 마커 줄 no-op · align 승계 케이스.

## 검증 절차

1. `editorEditOps.test.js` 전수 대조(원본 38 대비 이식 수 기록).
2. **변이 2종**: (M10-a) 단어 삭제 마커 no-op 가드 제거 → 마커 손상 케이스 red? 원복. (M10-b) 정렬이 임베드 자리를 옮기게 → 임베드 불변 케이스 red? 원복. 결과표 기록.

## 금지사항

- **단어 삭제가 마커 줄을 부분 삭제하게 두지 마라.** 이유: '끝)' 손상 조각이 송고 자격을 조용히 깬다(decisions (3)).
- **임베드를 정렬 대상으로 옮기지 마라.** 이유: 정본 정책(임베드는 자리 불변).
- **위젯 의존·웹 원본 수정 금지.**
