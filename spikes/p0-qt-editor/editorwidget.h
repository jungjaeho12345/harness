// EditorWidget — Qt 6 QPlainTextEdit 기반 P0-b 스파이크(go/no-go).
// 검증 4축: ① 줄 역할 색상(QSyntaxHighlighter) ② "(끝)" 마커 입력 게이트 ③ 한글 IME 조합 무개입 ④ 프로그램적 캐럿 복원.
#pragma once
#include <QPlainTextEdit>
#include "editorlogic.h"

class RoleHighlighter;

class EditorWidget : public QPlainTextEdit {
  Q_OBJECT
public:
  explicit EditorWidget(QWidget *parent = nullptr);

  // 본문 로드 + 즉시 재색칠 — 웹 RECOLOR_TRIGGERS의 'load' 트리거와 동형.
  void loadSample(const QString &text);
  // n번째 줄(0-base) 시작으로 캐럿 이동 + 포커스 — 프로그램적 캐럿 복원 API(T4). 범위 밖은 no-op.
  void focusLineStart(int lineIndex);
  // 지금 전체 재색칠(재분류) — 조합 중이면 no-op(웹 shouldRecolor의 composing 게이트와 동형).
  void recolorNow();

  bool isComposing() const { return m_composing; }
  // 문서 전체 역할 재분류(=재색칠) 횟수 — T3 "조합 중 재색칠 0" 단언용 카운터.
  int reclassifyCount() const;
  // QWidget과 동일하게 public — 차단 구간에서 플랫폼 IME를 끄는 ImEnabled 판정(T3에서 직접 조회).
  QVariant inputMethodQuery(Qt::InputMethodQuery query) const override;

protected:
  void keyPressEvent(QKeyEvent *e) override;
  void inputMethodEvent(QInputMethodEvent *e) override;
  void insertFromMimeData(const QMimeData *source) override;

private:
  bool caretBlockedForInsert() const;
  RoleHighlighter *m_highlighter = nullptr;
  bool m_composing = false;
};
