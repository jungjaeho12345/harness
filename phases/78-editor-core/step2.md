# Step 2: coloring-roles

줄 역할 분류(제목/부제/본문/`(끝)`)와 역할별 색을 이식한다. 이것이 텍스트 엔진(step8) 스타일 런의 원천이다.

## 읽어야 할 파일
- `phases/78-editor-core/index.json` — decisions (1)(4)(8).
- `web/src/view/editorColoring.js` — **이식 원본**. `classifyLines(lines)` 규칙: `trim === '(끝)'` → End · 인덱스 0 → Title · 부제 구간(인덱스 1~4 = slice(1,5))에 빈 줄이 있으면 부제 없이 인덱스 1부터 전부 Body · 그 외 1~4 → Subtitle · 5부터 Body. `COLORS` 기본값(제목 `#0a4da6`/부제 `#c8102e`/본문 `#1a1a1a`/`(끝)` `#d4af37`).
- `web/src/view/editorColoring.test.js` — 명세서(10 it).
- step0 `client-qt/src/editor/editorroles.*` — step0이 이미 `classifyLines`/`colorForRole`을 스파이크에서 이식했다. **step2는 그것을 웹 정본과 전수 대조해 보강**한다(부제 빈 줄 폴백 등 스파이크가 요약만 한 규칙의 전 케이스).

## 작업
1. step0의 `editorroles`(또는 `editorcoloring`으로 분리)를 웹 `editorColoring.js`와 **전 규칙 대조**해 누락 케이스를 채운다(특히 부제 구간 빈 줄 → 인덱스 1부터 Body 폴백).
2. 색은 환경설정 override 가능 값의 **기본값**만 P5 범위(전역 색 환경설정 연동은 P6 — excluded (a)). 기본 상수를 단일 출처로.
3. 이 모듈은 순수(QString/QColor만) — 위젯 비의존. 텍스트 엔진(step8)이 줄별 역할→색을 스타일 런으로 적용.
4. QtTest: `editorColoring.test.js`의 10 케이스 전부 + 경계(부제 빈 줄·`(끝)` trim·인덱스 4/5 경계). TDD red 먼저.

## Acceptance Criteria
- `cmd.exe /c "client-qt\build.bat"` → exit 0 · 0 failed.
- `node scripts/verify-qt-client.mjs --scenario boot --server exe` → exit 0.
- `git status --porcelain` 이 `client-qt/src/editor/**`·`client-qt/tests/**`·`phases/78-editor-core/**` 밖 무변.

## 검증 절차
1. 웹 10 케이스와 QtTest 출력 1:1 대조.
2. 우회 변이 2종(부제 구간 상한 4→3 · 빈 줄 폴백 제거)으로 red 실증 후 원복.
3. 무접촉 경로 diff 0.

## 금지사항
- 전역 색 환경설정 연동을 지금 붙이지 마라. 이유: 환경설정 8탭은 P6이다 — P5는 기본 색 상수만.
- 색·역할 판정을 위젯 코드에 인라인하지 마라. 이유: 순수 모듈이라야 위젯 없이 QtTest로 잠긴다.
