#include "editor/editorrange.h"

#include "editor/editorroles.h" // isJsWhitespace - the one whitespace predicate (step2)

#include <QtGlobal>

#include <algorithm>

namespace editor {

namespace {

// JS isWord(s[k]) = s[k] != null && /\S/.test(s[k]): one UTF-16 code unit that is not whitespace. Past
// either end there is no unit (JS undefined), so no word.
bool isWordUnit(const QString &s, qsizetype k)
{
    return k >= 0 && k < s.size() && !isJsWhitespace(s.at(k));
}

} // namespace

WordBounds wordBoundsAt(const QString &lineText, int column)
{
    const QString &s = lineText;
    const qsizetype col = std::clamp<qsizetype>(column, 0, s.size());

    // The anchor: the unit under the caret, else the nearest word unit to the LEFT, else to the right.
    qsizetype anchor = -1;
    if (isWordUnit(s, col)) {
        anchor = col;
    } else {
        for (qsizetype k = col - 1; k >= 0; --k) {
            if (isWordUnit(s, k)) {
                anchor = k;
                break;
            }
        }
        if (anchor == -1) {
            for (qsizetype k = col + 1; k < s.size(); ++k) {
                if (isWordUnit(s, k)) {
                    anchor = k;
                    break;
                }
            }
        }
    }
    if (anchor == -1)
        return WordBounds{int(col), int(col)}; // no word at all - the empty range

    // Grow the run both ways; end stays exclusive.
    qsizetype start = anchor;
    qsizetype end = anchor + 1;
    while (start > 0 && isWordUnit(s, start - 1))
        --start;
    while (end < s.size() && isWordUnit(s, end))
        ++end;
    return WordBounds{int(start), int(end)};
}

bool isParagraphBoundary(const QString &line)
{
    return line.isEmpty(); // web === '' - a whitespace-only line is text
}

ParagraphBounds paragraphBoundsAt(const QStringList &textLines, int lineIndex)
{
    if (textLines.isEmpty())
        return ParagraphBounds{0, 0};
    const qsizetype i = std::clamp<qsizetype>(lineIndex, 0, textLines.size() - 1);
    if (isParagraphBoundary(textLines.at(i)))
        return ParagraphBounds{int(i), int(i)};
    qsizetype startLine = i;
    qsizetype endLine = i;
    while (startLine > 0 && !isParagraphBoundary(textLines.at(startLine - 1)))
        --startLine;
    while (endLine < textLines.size() - 1 && !isParagraphBoundary(textLines.at(endLine + 1)))
        ++endLine;
    return ParagraphBounds{int(startLine), int(endLine)};
}

} // namespace editor
