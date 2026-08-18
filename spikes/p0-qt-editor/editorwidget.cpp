#include "editorwidget.h"
#include <QGuiApplication>
#include <QInputMethod>
#include <QKeyEvent>
#include <QMimeData>
#include <QSyntaxHighlighter>
#include <QTextBlock>

// 줄 역할 하이라이터 — 문서 리비전당 1회 전체 재분류(캐시), 조합 중에는 캐시만 적용(재분류 0).
// 웹은 재색칠(remount)이 캐럿을 튀게 해 트리거를 compositionend/blur/load로 제한했지만,
// Qt는 setFormat이 캐럿·선택을 건드리지 않아 조합 밖 즉시 재색칠이 안전하다 — 억제할 것은 조합 중 재분류뿐.
class RoleHighlighter : public QSyntaxHighlighter {
public:
  RoleHighlighter(EditorWidget *editor, QTextDocument *doc)
      : QSyntaxHighlighter(doc), m_editor(editor) {}

  int reclassifyCount = 0;

protected:
  void highlightBlock(const QString &) override {
    ensureRoles();
    const int n = currentBlock().blockNumber();
    if (n < 0 || n >= m_roles.size()) return;
    QTextCharFormat f;
    f.setForeground(editorlogic::colorForRole(m_roles.at(n)));
    setFormat(0, int(currentBlock().length()), f);
  }

private:
  void ensureRoles() {
    // 조합 중 재분류 금지(웹 계약 동형) — 직전 캐시를 그대로 써서 조합 중 색 변화 0을 보장한다.
    if (m_editor->isComposing() && !m_roles.isEmpty()) return;
    const int rev = document()->revision();
    if (rev == m_rev && !m_roles.isEmpty()) return;
    m_roles = editorlogic::classifyLines(document()->toPlainText().split(QLatin1Char('\n')));
    m_rev = rev;
    ++reclassifyCount;
  }

  EditorWidget *m_editor;
  QVector<editorlogic::Role> m_roles;
  int m_rev = -1;
};

EditorWidget::EditorWidget(QWidget *parent) : QPlainTextEdit(parent) {
  m_highlighter = new RoleHighlighter(this, document());
  // 캐럿이 차단 구간을 드나들 때 플랫폼 IME에 ImEnabled 재조회를 알린다 — 차단 구간에선 조합 시작 자체가 안 된다.
  connect(this, &QPlainTextEdit::cursorPositionChanged, this, [] {
    if (QGuiApplication::inputMethod()) QGuiApplication::inputMethod()->update(Qt::ImEnabled);
  });
}

void EditorWidget::loadSample(const QString &text) {
  setPlainText(text);
  recolorNow(); // 웹 RECOLOR_TRIGGERS 'load' 동형 — 로드 직후 결정적으로 1회 재색칠.
}

void EditorWidget::focusLineStart(int lineIndex) {
  const QTextBlock b = document()->findBlockByNumber(lineIndex);
  if (!b.isValid()) return; // 범위 밖 — no-op(캐럿 유지)
  setTextCursor(QTextCursor(b)); // QTextCursor(block)은 블록 시작 위치
  setFocus();
}

void EditorWidget::recolorNow() {
  if (m_composing) return; // 웹 shouldRecolor(composing=true)=false 동형
  m_highlighter->rehighlight();
}

int EditorWidget::reclassifyCount() const {
  return m_highlighter->reclassifyCount;
}

// 삽입 키 판정 — Enter·붙여넣기 단축키·인쇄 가능 문자(탭 포함)만 삽입으로 본다.
// Backspace(0x08)·Delete·화살표·Home/End·복사/선택 계열은 text()가 비었거나 제어 문자라 삽입이 아니다(허용 계약).
static bool isInsertionKey(const QKeyEvent *e) {
  if (e->key() == Qt::Key_Return || e->key() == Qt::Key_Enter) return true;
  if (e->matches(QKeySequence::Paste)) return true;
  const QString t = e->text();
  for (const QChar &ch : t) {
    if (ch.isPrint() || ch == QLatin1Char('\t')) return true;
  }
  return false;
}

// 삽입 게이트 오프셋 — collapsed면 캐럿, 선택이면 앞점(selectionStart) 기준(웹 isInputBlocked 동형).
// 스파이크 단순화: 선택 끝점이 마커 구간에 걸쳐도 차단한다 — 웹은 replaceRangeInBlocks 규칙 3이 clamp로
// 입력을 살리지만 그 순수 로직 이식은 P5 범위다. 여기서는 "마커 오염 불가"만 보장한다(더 엄격한 쪽).
bool EditorWidget::caretBlockedForInsert() const {
  const QTextCursor c = textCursor();
  const QString text = toPlainText();
  if (editorlogic::isInputBlocked(text, int(c.hasSelection() ? c.selectionStart() : c.position()))) return true;
  if (c.hasSelection() && editorlogic::isInputBlocked(text, int(c.selectionEnd()))) return true;
  return false;
}

void EditorWidget::keyPressEvent(QKeyEvent *e) {
  if (isInsertionKey(e) && caretBlockedForInsert()) { e->accept(); return; } // 차단 — 문서·캐럿 무변경
  QPlainTextEdit::keyPressEvent(e);
}

// 붙여넣기 전 경로(단축키·컨텍스트 메뉴·프로그램 paste()) 공통 관문 — 차단 구간이면 무삽입.
void EditorWidget::insertFromMimeData(const QMimeData *source) {
  if (caretBlockedForInsert()) return;
  QPlainTextEdit::insertFromMimeData(source);
}

// IME 조합 관문 — 시작 시점에 캐럿이 차단 구간이면 조합 자체를 거부하고,
// 허용 구간이면 Qt 기본 처리에 전부 위임한다(조합 중 개입 0 — 웹 계약 동형).
// preedit는 QTextLayout preedit 영역에만 있고 문서에는 없다 — 커밋 시 1회만 문서에 반영된다(Qt가 흡수).
void EditorWidget::inputMethodEvent(QInputMethodEvent *e) {
  const bool hasContent = !e->preeditString().isEmpty() || !e->commitString().isEmpty();
  if (!m_composing && hasContent && caretBlockedForInsert()) {
    e->accept(); // 조합 거부 — 실플랫폼에선 ImEnabled=false로 애초에 시작되지 않는다(이 분기는 fail-safe)
    return;
  }
  if (!hasContent && !m_composing) { QPlainTextEdit::inputMethodEvent(e); return; } // 속성-전용 이벤트
  m_composing = true; // 기본 처리 중 하이라이터 재분류 억제(조합 중 재색칠 0)
  QPlainTextEdit::inputMethodEvent(e);
  if (e->preeditString().isEmpty()) { // 조합 종료(커밋/취소) — 이 시점 1회만 반영·재색칠
    m_composing = false;
    recolorNow();
  }
}

// 차단 구간에서는 플랫폼 IME 자체를 끈다(ImEnabled=false) — 조합 시작 전에 막는 Qt 고유 수단.
// 웹은 compositionstart preventDefault가 IME를 실제로 멈추지 못해 사후 방어에 의존했다.
QVariant EditorWidget::inputMethodQuery(Qt::InputMethodQuery query) const {
  if (query == Qt::ImEnabled && caretBlockedForInsert()) return QVariant(false);
  return QPlainTextEdit::inputMethodQuery(query);
}
