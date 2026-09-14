# Step 12: glyph-keymap

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (11)(12)
- **정본 소스(읽기 전용)**: `web/src/view/editorGlyphKeymap.js` (130행 — 특히 5~14행 보수적 해석 규칙)
- **정본 테스트(전환 대상)**: `web/src/view/editorGlyphKeymap.test.js` (29 케이스) — 전수 전환
- `web/src/view/editorShortcuts.js` — code 병행 관례(동형) · RESERVED_COMBOS 참조

## 배경

사용자 키보드약물(glyphKeymap) 키조합 매칭 — 순수 모델. 환경설정에 자유입력 텍스트로 저장된 keys("Ctrl+1"·"ctrl+k" 등)를 정규화 combo로 파싱하고, keydown을 그 combo와 대조해 매칭 약물을 돌려준다. **React/DOM/localStorage/editorPrefs 비의존**.

보수적 해석(정본이 권위 — 벗어나지 마라):
1. 실수식어 필수(Ctrl/Alt/Meta 중 하나 · 바 키·Shift-only는 파싱 null — 수식어 없는 항목 인터셉트는 일반 타이핑 파괴).
2. 예약 조합 무시(RESERVED_COMBOS 정확 일치 + 상위 핸들러가 shift/meta 무시하거나 Ctrl/Cmd 동일 취급해 삼키는 '느슨 변형'은 컴파일에서 버린다).
3. a–z/0–9는 key(대소문자 무관)와 code(KeyK/Digit1) 병행 매칭(한글 입력 상태에서도 인식).
4. 수식어(Ctrl/Alt/Shift/Meta)는 정확 일치.

## 작업

**테스트 먼저.** `editorGlyphKeymap.test.js` 29 케이스를 QtTest로 옮긴다. keydown은 순수 구조체(step5 KeyEvent 재사용 가능)로 표현. combo 파싱 규칙·RESERVED_COMBOS·isSwallowedByReservedHandlers 로직을 전수 옮긴다.

`client-qt/src/editor/glyphkeymap.{h,cpp}`: combo 파싱 · keydown 대조 · 매칭 약물 반환.

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorGlyphKeymap.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 29와 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **29에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 반드시 존재: 수식어 없는 항목 파싱 null · 예약 조합·느슨 변형 버림 · key/code 병행 · 수식어 정확 일치 케이스.

## 검증 절차

1. `editorGlyphKeymap.test.js` 전수 대조(원본 29 대비 이식 수 기록).
2. **변이 2종**: (M12-a) 실수식어 필수 규칙 제거 → 바 키 항목이 타이핑을 삼키는 케이스 red? 원복. (M12-b) 예약 조합 버림 제거 → 죽은 항목 발화 케이스 red? 원복. 결과표 기록.

## 금지사항

- **수식어 없는 항목을 매칭 대상으로 두지 마라.** 이유: 일반 타이핑이 파괴된다(정본 보수적 해석 1).
- **예약 조합·느슨 변형을 발화시키지 마라.** 이유: 상위 핸들러가 먼저 삼켜 죽은 항목이 된다(정본 규칙 2).
- **위젯 의존·웹 원본 수정 금지.**
