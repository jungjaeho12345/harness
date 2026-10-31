#include "editor/editorcaret.h"

#include <QLatin1Char>
#include <QStringView>
#include <QtGlobal>

#include <algorithm>

namespace editor {

QStringList lines(const QString &text)
{
    // JS split('\n'): QString::split keeps empty parts by default, so "" -> [""] and "a\n" -> ["a", ""].
    return text.split(QLatin1Char('\n'));
}

LineBounds lineAtOffset(const QString &text, int caretOffset)
{
    // Math.max(0, Math.min(caretOffset, length)) - in 64 bits, so INT_MIN / INT_MAX need no special case.
    const qsizetype clamped = std::clamp<qsizetype>(caretOffset, 0, text.size());
    const QStringView before = QStringView(text).left(clamped);
    const qsizetype lineIndex = before.count(QLatin1Char('\n'));
    const qsizetype start = before.lastIndexOf(QLatin1Char('\n')) + 1; // 0 without a newline before
    const qsizetype nl = text.indexOf(QLatin1Char('\n'), clamped);
    const qsizetype end = nl < 0 ? text.size() : nl;
    return LineBounds{int(lineIndex), int(start), int(end)};
}

LineRemoval removeLineFromText(const QString &text, int lineIndex)
{
    QStringList arr = lines(text);
    if (lineIndex < 0 || lineIndex >= arr.size())
        return LineRemoval{text, std::nullopt, 0};

    const QString removed = arr.takeAt(lineIndex);
    const QString newText = arr.join(QLatin1Char('\n'));
    // The caret goes to the start of the line now in the removed one's slot - the new last line when the
    // last one went; nothing left -> 0.
    qsizetype caret = 0;
    if (!arr.isEmpty()) {
        const qsizetype target = qMin<qsizetype>(lineIndex, arr.size() - 1);
        for (qsizetype i = 0; i < target; ++i)
            caret += arr.at(i).size() + 1;
        caret = qMin(caret, newText.size());
    }
    return LineRemoval{newText, removed, int(caret)};
}

} // namespace editor
