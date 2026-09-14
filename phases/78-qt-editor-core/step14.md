# Step 14: editor-widget

## 읽어야 할 파일

- **툴체인·환경(P4 승계 함정)**: index.json `baseline` 문단 — 빌드는 `client-qt\build.bat`(Bash면 `PATH=/c/Windows/System32:$PATH` · `findstr` 부재 = 거짓 BUILD FAILED) · 배치·빌드타깃명 ASCII만 · 커밋은 `git commit -F` · `git add -A` 금지 · CRLF diff 주의 · green이면 즉시 커밋
- `phases/78-qt-editor-core/index.json` — `decisions` (1)(2)(4)(7)(9)(10)(11) · `open_questions` (1)(5) · `excluded` (a)(e)(f)
- **정본 접근(승격 대상)**: `spikes/p0-qt-editor/editorwidget.{h,cpp}`(131행) · `selftest.cpp`(T1 색상·T4 캐럿 복원 축) · `main.cpp`
- `client-qt/src/editor/*` — step2~13이 세운 순수 모듈(이 위젯이 소비)
- `phases/78-qt-editor-core/step6.md`(coloring) · `step7.md`(history) · `step4.md`(newline overwrite)
- `client-qt/src/net/editclientid.h` — 편집 표면 clientId(P4 산출물 · 재사용)
- `web/src/view/Editor.jsx` — 렌더·캐럿·색상 오버레이 결선의 명세(읽기 · DOM부는 QPlainTextEdit로 대체)

## 배경

순수 로직층 위에 **QPlainTextEdit + QSyntaxHighlighter 텍스트 엔진 위젯**을 붙인다(decisions (1) · 스파이크 승격). 이 step은 **오프스크린 QtTest로 기계 판정 가능한 축**이다(스파이크 selftest가 실증): 블록 렌더 · 줄 역할 색상(`RoleHighlighter` → `classifyLines`/`colorForRole`) · 프로그램적 캐럿 복원(`focusLineStart`) · 수정(overwrite) 모드(`shouldOverwriteNextChar`/`overwriteExtendLength`) · undo/redo 결선(step7 history) · 전체 선택(네이티브 `selectAll()`). **IME·마커 게이트 전 입력 경로 결선은 step15**(판정 수단이 다르다).

## 작업

**테스트 먼저.** `client-qt/tests/`에 오프스크린 QtTest(`QT_QPA_PLATFORM=offscreen` · 스파이크 selftest 방식)로:
- 본문 로드 → `RoleHighlighter`가 줄 역할 색을 칠한다(T1 동형).
- `focusLineStart(i)` 캐럿 복원(T4 동형) · 범위 밖 no-op.
- overwrite 모드: 캐럿 뒤 1글자 대체(서로게이트 페어는 2 코드유닛) · 마커 차단 구간·줄 끝은 삽입 폴백.
- undo/redo: 위젯 편집 → history push → undo가 이전 본문 복원.
- `selectAll()`이 본문 전체를 선택한다(open_question (1) — `editorSelect.test.js`를 열어 순수 동작 케이스만큼 추가 판정, DOM 메커니즘은 버림, 판정 결과를 요약에 기록).

`client-qt/src/editor/editorwidget.{h,cpp}`(스파이크 승격):
```cpp
class EditorWidget : public QPlainTextEdit {
  Q_OBJECT
public:
  void loadBody(const QString& markupVersion);   // deserialize → 렌더 + 즉시 재색칠('load' 트리거)
  void focusLineStart(int lineIndex);             // 캐럿 복원(범위 밖 no-op)
  void recolorNow();                              // 재분류(조합 중이면 no-op — step15가 게이트)
  int  reclassifyCount() const;                   // 재색칠 횟수(step15 IME 단언)
  bool overwriteMode() const; void setOverwriteMode(bool);
  // undo/redo는 editor::History로 관리(QPlainTextEdit 기본 undo 스택과 이중이 되지 않게 단일화)
protected:
  void keyPressEvent(QKeyEvent*) override;        // overwrite·undo·redo·단축키 결선(마커 게이트는 step15)
private:
  RoleHighlighter* m_highlighter;
  editor::History m_history;
  net::EditClientId m_clientId;                   // 편집 표면 1개당 1개(decisions (5)·open_question (5) · lock 호출은 P6/P7)
};
```
- **편집 표면 = 이 위젯 인스턴스**가 `net::issueEditClientId()`로 clientId를 소유한다(표면당 1개 · 복사·이동 금지 · `EditClientId`가 이미 삭제). **lock/unlock/update 라우트는 부르지 않는다**(화면 없음 — P6/P7 이월).
- QPlainTextEdit 기본 undo와 step7 history가 이중이 되지 않게 undo 경로를 단일화한다(재량 — 기본 undo 비활성 또는 history로 위임).
- 색 규칙은 step6 `coloring` 단일 출처만 쓴다(스파이크 editorlogic 중복 승격 완료 전제).

## Acceptance Criteria

```
cmd /c client-qt\build.bat
node scripts/verify-qt-client.mjs --scenario list --server exe
node scripts/verify-qt-client.mjs --scenario list --server spring
npm test
npm run lint
git status --porcelain
```
- `build.bat` exit 0 · 오프스크린 위젯 QtTest 추가분 green · 실패 0 · P4 게이트 무회귀 · 무접촉 diff 0.
- 색상·캐럿 복원·overwrite·undo/redo·selectAll 오프스크린 케이스가 존재한다.

## 검증 절차

1. open_question (1): `editorSelect.test.js` 22 케이스를 순수 동작 vs DOM 메커니즘으로 분류하고 옮긴/버린 수를 요약에 기록.
2. **변이 2종 + 사각 기록**: (M14-a) overwrite에서 서로게이트 확장 길이를 1 고정 → astral 대체 케이스 red? 원복. (M14-b) undo를 QPlainTextEdit 기본 스택으로 되돌려 history 이중화 → 이전 본문 복원 케이스 red? 원복. **사각**: 오프스크린은 픽셀을 못 보므로 「색이 실제로 화면에 칠해지는가」는 step15/16 육안이 본다 — 이 한계를 요약에 적는다.

## 금지사항

- **커스텀 QAbstractScrollArea·QTextDocument 밑바닥 텍스트 엔진을 만들지 마라.** 이유: QPlainTextEdit이 정본 접근이다(decisions (1)).
- **네이티브 맞춤법(`setSpellCheckingEnabled`류)을 켜지 마라.** 이유: override L174 · ADR-011.
- **lock/unlock/update 라우트를 부르지 마라.** 이유: 화면·서버 결선은 P6/P7이다(decisions (5)·(f)).
- **`client-qt/src/net|shell|ui/**`를 고치지 마라.** 이유: P4 산출물 재사용만.
- **색 규칙·마커 판정을 위젯에 재구현하지 마라.** 이유: step6/step4 순수 모듈이 단일 출처다.
