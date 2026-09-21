#include "editor/editorroles.h"

namespace editor {

const QString END_MARKER = QStringLiteral("(끝)");

QVector<Role> classifyLines(const QStringList &lines)
{
    // The subtitle region is indices 1..4 (web slice(1, 5)); one empty line there means "no subtitle".
    bool blankInSubtitle = false;
    const qsizetype subtitleEnd = qMin<qsizetype>(lines.size(), 5);
    for (qsizetype i = 1; i < subtitleEnd; ++i) {
        if (lines.at(i).isEmpty()) {
            blankInSubtitle = true;
            break;
        }
    }

    QVector<Role> roles;
    roles.reserve(lines.size());
    for (qsizetype i = 0; i < lines.size(); ++i) {
        if (lines.at(i).trimmed() == END_MARKER)
            roles.append(Role::End);
        else if (i == 0)
            roles.append(Role::Title);
        else if (blankInSubtitle)
            roles.append(Role::Body);
        else
            roles.append(i <= 4 ? Role::Subtitle : Role::Body);
    }
    return roles;
}

QColor colorForRole(Role role)
{
    switch (role) {
    case Role::Title:
        return QColor(QStringLiteral("#0a4da6"));
    case Role::Subtitle:
        return QColor(QStringLiteral("#c8102e"));
    case Role::End:
        return QColor(QStringLiteral("#d4af37"));
    case Role::Body:
        break;
    }
    return QColor(QStringLiteral("#1a1a1a"));
}

bool isInputBlocked(const QString &text, int caretOffset)
{
    // lastIndexOf on UTF-16 - the same unit and the same "last marker" rule as the JS canonical.
    const qsizetype markerStart = text.lastIndexOf(END_MARKER);
    if (markerStart < 0)
        return false;
    return caretOffset >= markerStart;
}

} // namespace editor
