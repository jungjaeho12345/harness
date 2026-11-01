#include "editor/editorroles.h"

#include <QChar>
#include <QStringView>

namespace editor {

const QString END_MARKER = QStringLiteral("(끝)");

// The defaults as the web spells them (editorColoring.COLORS). Every colour reader goes through
// this one object; nothing else in the editor layer spells a colour literal.
const EditorColors COLORS{QColor(QStringLiteral("#0a4da6")), QColor(QStringLiteral("#c8102e")),
                          QColor(QStringLiteral("#1a1a1a")), QColor(QStringLiteral("#d4af37"))};

// ECMAScript String.prototype.trim() strips WhiteSpace (TAB, VT, FF, SP, NBSP, ZWNBSP U+FEFF and
// every Unicode Space_Separator) and LineTerminator (LF, CR, LS U+2028, PS U+2029); the regex class
// \s is the same set. This is NOT QChar::isSpace(): that one also strips U+0085 (NEL) and does not
// strip U+FEFF. Measured on both sides (node 24 · Qt 6.8.3, 2026-11-01); the test tables in
// tests/editorcoloringtest.cpp (trim) and tests/editorrangetest.cpp (\s) hold the rows.
bool isJsWhitespace(QChar c)
{
    switch (c.unicode()) {
    case 0x0009:
    case 0x000A:
    case 0x000B:
    case 0x000C:
    case 0x000D:
    case 0x0020:
    case 0x00A0:
    case 0x2028:
    case 0x2029:
    case 0xFEFF:
        return true;
    default:
        return c.category() == QChar::Separator_Space; // Unicode Zs
    }
}

namespace {

QStringView trimLikeJs(const QString &s)
{
    qsizetype begin = 0;
    qsizetype end = s.size();
    while (begin < end && isJsWhitespace(s.at(begin)))
        ++begin;
    while (end > begin && isJsWhitespace(s.at(end - 1)))
        --end;
    return QStringView(s).mid(begin, end - begin);
}

} // namespace

bool isEndLine(const QString &line)
{
    return trimLikeJs(line) == END_MARKER;
}

QVector<Role> classifyLines(const QStringList &lines)
{
    // The subtitle region is indices 1..4 (web slice(1, 5)); one exactly-empty line there
    // (web l === '') means "no subtitle". Whitespace-only lines are not blank.
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
        if (isEndLine(lines.at(i)))
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
        return COLORS.title;
    case Role::Subtitle:
        return COLORS.subtitle;
    case Role::End:
        return COLORS.end;
    case Role::Body:
        break;
    }
    // Body, and any value outside the enumerators (web: activeColors[role] ?? activeColors.body).
    return COLORS.body;
}

QVector<ColoredLine> colorLines(const QString &text)
{
    // JS split('\n'): "\n" alone separates, "" is one line, a trailing "\n" leaves a trailing
    // empty line - QString::split keeps empty parts by default.
    const QStringList lines = text.split(QLatin1Char('\n'));
    const QVector<Role> roles = classifyLines(lines);
    QVector<ColoredLine> out;
    out.reserve(lines.size());
    for (qsizetype i = 0; i < lines.size(); ++i)
        out.append(ColoredLine{lines.at(i), roles.at(i), colorForRole(roles.at(i))});
    return out;
}

const QStringList RECOLOR_TRIGGERS{QStringLiteral("compositionend"), QStringLiteral("blur"),
                                   QStringLiteral("load")};

bool shouldRecolor(const QString &trigger, bool composing)
{
    if (composing)
        return false;
    return RECOLOR_TRIGGERS.contains(trigger); // case-sensitive, like Array.prototype.includes
}

} // namespace editor
