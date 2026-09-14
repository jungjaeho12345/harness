# Step 9: stats-and-encoding

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (11)(12)(13 · L201)
- **정본 소스(읽기 전용)**: `web/src/view/editorStats.js` (66행) · `web/src/view/editorEncoding.js` (53행)
- **정본 테스트(전환 대상)**: `web/src/view/editorStats.test.js` (24) · `web/src/view/editorEncoding.test.js` (15) — 전수 전환
- `web/src/view/editorCaret.js` — `lines`(stats가 import) · step8 산출물
- `docs/news-md-overrides.md` — **L201**(입력모드의 유일한 효과 = 상태표시줄 Byte 계산식)

## 배경

상태표시줄 계산 — 워드수·바이트수·캐럿 위치(단락·행·열)와 EUC-KR 바이트 근사. 둘 다 순수 계산이다. 입력모드(KSC-5601/Unicode)의 유일한 효과는 이 Byte 계산식이다(override L201).

정본 규칙:
- `wordCount(text)` = trim 후 `\s+` split filter(Boolean) 길이.
- stats의 `caret`은 `Editor.readCaret` 계약 `{lineIndex, offset}`를 받는다(row=lineIndex, column=offset). 단락·행·열 계산·바이트수 등 `editorStats.js`의 export를 전수 옮긴다.
- `normalizeInputMode(mode)` = 'ksc5601'이면 'ksc5601', 아니면 'unicode'(폴백).
- `euckrStats(text)`: 코드포인트 순회(서로게이트 페어 = 한 문자) · ASCII(≤0x7F) 1B · `EUCKR_2B_RANGES` 10개 범위(0x0370~0x03FF … 0xFF00~0xFFEF) 2B · 그 외 비호환(바이트 0 기여 + `incompatible` 카운트) · 반환 `{bytes, incompatible}`. 범위 상수를 정확히 옮긴다(index step9 배경 또는 정본 19~30행).

## 작업

**테스트 먼저.** 두 테스트 파일(24+15=39)을 QtTest로 옮긴다.

`client-qt/src/editor/stats.{h,cpp}` + `client-qt/src/editor/encoding.{h,cpp}`: `wordCount` + stats export 전수 + `normalizeInputMode` + `euckrStats`. QString의 `codePointAt` 상당은 `QString::toUcs4()`/`QChar` 서로게이트 API로 코드포인트 순회를 정본과 동형으로 만든다.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorStats.test.js`·`editorEncoding.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 39(24+15)와 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **39에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 반드시 존재: 완성형 한글 2B · ASCII 1B · 이모지(비BMP) incompatible 카운트(바이트 0) · 경계값(범위 lo/hi) 케이스.

## 검증 절차

1. 두 테스트 파일 전수 대조(원본 24·15 대비 이식 수 기록).
2. **변이 2종**: (M9-a) 서로게이트를 코드유닛 단위로 세게 → 이모지 케이스 red? 원복. (M9-b) 2B 범위 하나 삭제 → 그 범위 문자 케이스 red? 원복. 결과표 기록.

## 금지사항

- **`euckrStats`를 실제 EUC-KR 인코더로 대체하지 마라.** 이유: 정본은 KS X 1001 전수 테이블이 아니라 **블록 범위 기반 과대근사**이고 그것이 계약이다(TextEncoder는 EUC-KR 미지원).
- **입력모드에 Byte 계산 외 효과를 주지 마라.** 이유: override L201 — 유일한 효과다.
- **위젯 의존·웹 원본 수정 금지.**
