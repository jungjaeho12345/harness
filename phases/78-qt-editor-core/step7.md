# Step 7: coloring

**목표**: 줄 역할 색상(`editorColoring.js`)을 이식한다 — 제목/부제/본문/"(끝)" 분류, 색 화이트리스트, 재색칠 시점(IME 조합 중 금지). 순수(색은 인자로 받아 전역 가변 상태를 피한다 — OQ-2 계획안).

## 읽어야 할 파일
- `phases/78-qt-editor-core/port-spec.md` §1(R2/R9)·§6(색상 트리거)·open_questions (2).
- `web/src/view/editorColoring.js` (71행) — `COLORS`·`classifyLines`·`colorForRole`·`colorLines`·`setEditorColors`·`resetEditorColors`·`shouldRecolor`·`RECOLOR_TRIGGERS`.
- `web/src/view/editorColoring.test.js` (86행).
- `spikes/p0-qt-editor/editorlogic.h:14-23`·`editorlogic.cpp` — `Role`/`classifyLines`/`colorForRole` 스파이크 선례(있으면 이식 기준으로 비교, 없으면 신규).
- `docs/news.md:165-167,179` (+ overrides) — 색상/재색칠 요구사항.
- **이전 step 산출물**: `blockmodel`(step1 · `END_MARKER`) · `caretmath.lines`(step4).

## 작업 (테스트 먼저)
1. **red 먼저**: `client-qt/tests/coloringtest.{h,cpp}`에 케이스를 data-driven으로 옮긴다. 스파이크에 `editorlogic`의 색상 테스트가 있으면 그것과 합친다(중복 제거).
2. `client-qt/src/editor/coloring.{h,cpp}`:
   - `enum class Role { Title, Subtitle, Body, End }`.
   - `struct Colors { QColor title, subtitle, body, end; }` · 기본값 `COLORS`(title #0a4da6 / subtitle #c8102e / body #1a1a1a / end #d4af37).
   - `QVector<Role> classifyLines(const QStringList& lines)` — trim=="(끝)"→End, i==0→Title, 부제 구간(인덱스 1~4)에 빈 줄 있으면 인덱스 1부터 Body, 아니면 1~4 Subtitle·5부터 Body.
   - `QColor colorForRole(Role, const Colors& = 기본)` — **색을 인자로 받는다**(전역 가변 `activeColors` 대신 — OQ-2). 사용자 설정 병합은 `Colors mergeUserColors(const Colors& base, ...)`로 화이트리스트(title/subtitle/body만; background/end 무시)만.
   - `struct ColoredLine { QString text; Role role; QColor color; }` · `QVector<ColoredLine> colorLines(const QString& text, const Colors& = 기본)`.
   - `bool shouldRecolor(const QString& trigger, bool composing)` — composing이면 false, trigger ∈ {compositionend, blur, load}.
3. **OQ-2 판정 기록**: 색을 인자로 받는 설계가 웹의 전역 `setEditorColors`/`resetEditorColors` 시맨틱과 어긋나지 않는지(테스트가 전역 상태를 가정하는지) 확인하고, 필요하면 얇은 인스턴스 홀더(에디터별 `Colors`)를 둔다 — 판정을 step 요약에 기록.
4. 모듈 등록 2곳 + 테스트는 `tests.pro`에만.

## Acceptance Criteria
```bash
cd /home/user/harness
cmd /c client-qt\build.bat          # exit 0 · Totals: N passed, 0 failed
git status --porcelain -- server src web client test contract docs/api-contract   # 무출력
```

## 검증 절차
1. `editorColoring.test.js` 케이스 대응(누락 0). 부제 구간 빈 줄→본문 전환, "(끝)" End, 색 화이트리스트 병합(end/background 무시), 재색칠 트리거·composing 게이트.
2. OQ-2 판정(인자형 vs 인스턴스 홀더)이 요약에 기록됐는지.
3. TDD red: `shouldRecolor`의 composing 게이트 제거 변이 → 조합 중 재색칠 케이스 red(원복).

## 금지사항
- IME 조합 중 재색칠을 허용하지 마라. 이유: 조합 중 재색칠은 캐럿 튐·조합 파손을 부른다(news.md:179).
- "(끝)"(end) 색과 background를 사용자 설정 화이트리스트에 넣지 마라. 이유: 웹 계약상 사용자 설정 대상은 title/subtitle/body뿐이다(`editorColoring.js:16-18`).
- 테스트 더블을 `common.pri`에 넣지 마라(F1).
