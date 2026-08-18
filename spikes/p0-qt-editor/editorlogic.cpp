#include "editorlogic.h"

namespace editorlogic {

const QString END_MARKER = QStringLiteral("(끝)");

QVector<Role> classifyLines(const QStringList &lines) {
  // 부제 구간(인덱스 1~4 = 웹 slice(1,5))에 빈 줄이 있으면 부제 없이 인덱스 1부터 본문.
  bool blankInSubtitle = false;
  const int subEnd = int(qMin<qsizetype>(lines.size(), 5));
  for (int i = 1; i < subEnd; ++i) {
    if (lines.at(i).isEmpty()) { blankInSubtitle = true; break; }
  }
  QVector<Role> roles;
  roles.reserve(int(lines.size()));
  for (int i = 0; i < lines.size(); ++i) {
    if (lines.at(i).trimmed() == END_MARKER) { roles.append(Role::End); continue; }
    if (i == 0) { roles.append(Role::Title); continue; }
    if (blankInSubtitle) { roles.append(Role::Body); continue; }
    roles.append(i <= 4 ? Role::Subtitle : Role::Body);
  }
  return roles;
}

QColor colorForRole(Role role) {
  switch (role) {
    case Role::Title: return QColor(QStringLiteral("#0a4da6"));
    case Role::Subtitle: return QColor(QStringLiteral("#c8102e"));
    case Role::End: return QColor(QStringLiteral("#d4af37"));
    case Role::Body: break;
  }
  return QColor(QStringLiteral("#1a1a1a"));
}

bool isInputBlocked(const QString &text, int caretOffset) {
  // 웹 editorNewline.isInputBlocked와 동형 — lastIndexOf(substring) 기준. QString은 UTF-16이라
  // indexOf/캐럿 오프셋 단위가 JS 문자열과 동일하다(서로게이트 페어 = 2 코드유닛).
  const qsizetype idx = text.lastIndexOf(END_MARKER);
  if (idx < 0) return false;
  return caretOffset >= idx;
}

} // namespace editorlogic
