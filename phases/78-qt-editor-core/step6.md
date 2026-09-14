# Step 6: coloring

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (4)(11)(12)
- **정본 소스(읽기 전용)**: `web/src/view/editorColoring.js` (71행 전체)
- **정본 테스트(전환 대상)**: `web/src/view/editorColoring.test.js` (10 케이스) — 전수 전환
- `spikes/p0-qt-editor/editorlogic.{h,cpp}` — `classifyLines`·`colorForRole`(스파이크 초판 · 승격·확장)
- `phases/78-qt-editor-core/step2.md` — `blockmodel`(END_MARKER)

## 배경

줄 역할 색 규칙(순수)과 재색칠 시점 판정을 이식한다. **스파이크 `editorlogic`이 `classifyLines`/`colorForRole`를 이미 담았다** — 이를 정식 `src/editor/coloring` 모듈로 승격하고 `setEditorColors`/`shouldRecolor`를 더한다. IME 조합 중 재색칠 금지(decisions (4))의 순수 판정부가 여기다.

정본 규칙:
- `COLORS`(freeze): title `#0a4da6` · subtitle `#c8102e` · body `#1a1a1a` · end `#d4af37`.
- `classifyLines(lines)`: trim==="(끝)" → 'end' · i===0 → 'title' · 부제 구간(인덱스 1~4 = slice(1,5))에 빈 줄('')이 있으면 i≥1 전부 'body' · 아니면 i≤4 'subtitle' 나머지 'body'.
- `setEditorColors(colors)`: 화이트리스트 `['title','subtitle','body']` 키만 병합(background/end/unknown 무시) · `resetEditorColors()` 되돌림 · `colorForRole(role)` = 현재 적용 색(없으면 body).
- `colorLines(text)`: 줄별 `{text, role, color}`.
- `shouldRecolor(trigger, {composing})`: composing이면 false · `RECOLOR_TRIGGERS=['compositionend','blur','load']` 포함이면 true.

## 작업

**테스트 먼저.** `editorColoring.test.js` 10 케이스를 QtTest로 옮긴다.

`client-qt/src/editor/coloring.{h,cpp}`:
```cpp
namespace editor {
  enum class Role { Title, Subtitle, Body, End };   // 스파이크 editorlogic::Role 승계
  QVector<Role> classifyLines(const QStringList& lines);
  QColor colorForRole(Role);                        // 현재 적용 색
  void setEditorColors(const QJsonObject& colors);  // 화이트리스트 병합
  void resetEditorColors();
  struct LineColor { QString text; Role role; QColor color; };
  QVector<LineColor> colorLines(const QString& text);
  extern const QStringList RECOLOR_TRIGGERS;
  bool shouldRecolor(const QString& trigger, bool composing);
}
```
- 스파이크 `editorlogic.{h,cpp}`와 중복되면 그 정본을 `coloring`으로 승격하고 위젯(step14)이 이를 쓰게 한다(두 벌 색 규칙 금지).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
npm test
npm run lint
git status --porcelain
```
- **정본 `editorColoring.test.js`의 케이스를 전수 이식**(누락·병합·분해 내역을 요약에 기록) · 실측 수가 10과 다르면 실측을 정본으로 삼되 사유를 요약에 명기(decisions (12)·open_question (4)) · **10에 맞추려 padding 금지** · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 부제 구간 빈 줄 → body 강등 · setEditorColors 화이트리스트(end/background 무시) · shouldRecolor composing 게이트 케이스가 존재한다.

## 검증 절차

1. `editorColoring.test.js` 전수 대조(원본 10 대비 이식 수 기록).
2. **변이 2종**: (M6-a) 부제 구간 빈 줄 판정 제거 → body 강등 케이스 red? 원복. (M6-b) `shouldRecolor`에서 composing 게이트 제거 → 조합 중 재색칠 케이스 red? 원복. 결과표 기록.

## 금지사항

- **`shouldRecolor`의 composing 게이트를 우회하지 마라.** 이유: 조합 중 재색칠은 캐럿 튐의 원인이다(decisions (4) · 실기 육안 게이트 step15와 직결).
- **색 규칙을 두 벌로 두지 마라.** 이유: 스파이크 editorlogic과 이 모듈이 갈리면 위젯 색이 테스트와 어긋난다.
- **위젯 의존·웹 원본 수정 금지.**
