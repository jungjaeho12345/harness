#include "editor/editornewline.h"

#include "editor/editorroles.h"

#include <QChar>
#include <QLatin1Char>
#include <QStringList>

#include <algorithm>
#include <utility>

namespace editor {

bool hasEndMarker(const QString &text)
{
    return text.contains(END_MARKER);
}

QString appendEndMarker(const QString &text)
{
    if (text.contains(END_MARKER))
        return text;
    if (text.isEmpty() || text.endsWith(QLatin1Char('\n')))
        return text + END_MARKER;
    return text + QLatin1Char('\n') + END_MARKER;
}

bool isInputBlocked(const QString &text, int caretOffset)
{
    // lastIndexOf on UTF-16 - the same unit and the same "last marker" rule as the JS canonical.
    const qsizetype markerStart = text.lastIndexOf(END_MARKER);
    if (markerStart < 0)
        return false;
    return caretOffset >= markerStart;
}

bool shouldOverwriteNextChar(const QString &text, int offset)
{
    if (offset < 0 || offset >= text.size())
        return false;
    if (text.at(offset) == QLatin1Char('\n'))
        return false; // the line end - the next line (or an embed boundary) is never eaten
    if (isInputBlocked(text, offset))
        return false; // the marker and everything after it
    if (offset > 0 && text.at(offset).isLowSurrogate() && text.at(offset - 1).isHighSurrogate())
        return false; // inside a pair - replacing the low half alone would leave a lone high surrogate
    return true;
}

int overwriteExtendLength(const QString &text, int offset)
{
    if (offset < 0 || offset >= text.size())
        return 1;
    if (text.at(offset).isHighSurrogate() && offset + 1 < text.size() && text.at(offset + 1).isLowSurrogate())
        return 2;
    return 1;
}

bool isMarkerBlock(const Block &block)
{
    return isTextBlock(block) && isEndLine(block.text);
}

namespace {

// A point resolved against one text line: its in-line offset is already clamped into the line.
struct LinePoint {
    int lineIndex;
    qsizetype inLine;
};

bool isAfter(const LinePoint &a, const LinePoint &b)
{
    return a.lineIndex > b.lineIndex || (a.lineIndex == b.lineIndex && a.inLine > b.inLine);
}

QVector<Block> textBlocksOf(const QStringList &lines)
{
    QVector<Block> out;
    out.reserve(lines.size());
    for (const QString &line : lines)
        out.append(textBlock(line));
    return out;
}

} // namespace

InsertResult insertTextIntoBlocks(const QVector<Block> &blocks, const std::optional<TextPoint> &caret,
                                  const QString &text)
{
    // A collapsed caret is a range whose start and end are the same point - one set of rules, not two.
    return replaceRangeInBlocks(blocks, TextRange{caret, caret}, text);
}

InsertResult replaceRangeInBlocks(const QVector<Block> &blocks, const TextRange &range, const QString &text)
{
    const QVector<Block> list = normalizeBlocks(blocks); // a copy - the input is never touched
    const QStringList insLines = text.split(QLatin1Char('\n'));
    const int insCount = int(insLines.size());

    // Text line index -> index into list.
    QVector<qsizetype> textArrIdx;
    for (qsizetype i = 0; i < list.size(); ++i) {
        if (isTextBlock(list.at(i)))
            textArrIdx.append(i);
    }
    const int lineCount = int(textArrIdx.size());
    const auto lineLen = [&](int line) { return list.at(textArrIdx.at(line)).text.size(); };

    // The clamp point is the FIRST marker line; the blocks after it (a second marker included) are not
    // this function's business.
    int markerLine = -1;
    for (int line = 0; line < lineCount; ++line) {
        if (isMarkerBlock(list.at(textArrIdx.at(line)))) {
            markerLine = line;
            break;
        }
    }

    // A point outside the text lines is unknown; the in-line offset is clamped into its line. 64-bit
    // arithmetic, so an extreme int offset cannot overflow.
    const auto resolve = [&](const std::optional<TextPoint> &p) -> std::optional<LinePoint> {
        if (!p || p->lineIndex < 0 || p->lineIndex >= lineCount)
            return std::nullopt;
        qint64 before = 0;
        for (int line = 0; line < p->lineIndex; ++line)
            before += lineLen(line) + 1;
        const qint64 inLine = qint64(p->offset) - before;
        return LinePoint{p->lineIndex, qsizetype(std::clamp<qint64>(inLine, 0, lineLen(p->lineIndex)))};
    };

    // Rule 1-a: one known end -> collapsed there; a reversed range is swapped.
    std::optional<LinePoint> start = resolve(range.start);
    std::optional<LinePoint> end = resolve(range.end);
    if (!start)
        start = end;
    if (!end)
        end = start;
    if (start && isAfter(*start, *end))
        std::swap(start, end);

    // Rule 1-b's one insertion point "before the marker" (the end of the last text line when there is
    // no marker), shared by the unknown-caret fallback and rule 3-start - two copies of the marker
    // protection would drift apart. When the marker is the first text line there is no line before it:
    // the inserted lines become new text blocks right in front of it and that is the whole result
    // (falling back to "the last text line" there would be the marker line itself - "(끝)A").
    const auto insertBeforeMarker = [&](LinePoint *point) -> std::optional<InsertResult> {
        if (markerLine == 0) {
            const qsizetype at = textArrIdx.at(0);
            return InsertResult{list.mid(0, at) + textBlocksOf(insLines) + list.mid(at), insCount - 1};
        }
        const int targetLine = markerLine > 0 ? markerLine - 1 : lineCount - 1;
        *point = LinePoint{targetLine, lineLen(targetLine)};
        return std::nullopt;
    };

    // Rule 1-b: no known end. No text line at all -> the new lines go after every block.
    if (!start) {
        if (lineCount == 0)
            return InsertResult{list + textBlocksOf(insLines), insCount - 1};
        LinePoint point{};
        if (const std::optional<InsertResult> done = insertBeforeMarker(&point))
            return *done;
        start = point;
        end = start;
    }

    // Rule 3-start: a start on or after the marker line means the whole range is there (start is its
    // front), so the insertion goes back to rule 1-b's point and nothing is deleted.
    if (markerLine >= 0 && start->lineIndex >= markerLine) {
        LinePoint point{};
        if (const std::optional<InsertResult> done = insertBeforeMarker(&point))
            return *done;
        start = point;
        end = start;
    }

    // Rule 3-end: the deletion stops before the marker line; clamped behind the start, it deletes nothing.
    if (markerLine >= 0 && end->lineIndex >= markerLine) {
        std::optional<LinePoint> clamped;
        if (markerLine > 0)
            clamped = LinePoint{markerLine - 1, lineLen(markerLine - 1)};
        end = (clamped && !isAfter(*start, *clamped)) ? clamped : start;
    }

    // Rules 4 and 5: start line head + inserted lines + end line tail, the range's embeds after them.
    const qsizetype startArr = textArrIdx.at(start->lineIndex);
    const qsizetype endArr = textArrIdx.at(end->lineIndex);
    const QString startAlign = list.at(startArr).align;
    const QString endAlign = list.at(endArr).align;
    QStringList newLines = insLines;
    newLines[0] = list.at(startArr).text.left(start->inLine) + newLines.at(0);
    const qsizetype last = newLines.size() - 1;
    newLines[last] += list.at(endArr).text.mid(end->inLine);
    QVector<Block> merged;
    merged.reserve(newLines.size());
    for (qsizetype i = 0; i < newLines.size(); ++i)
        merged.append(textBlock(newLines.at(i), i == last && last > 0 ? endAlign : startAlign));
    QVector<Block> keptEmbeds;
    for (qsizetype i = startArr; i <= endArr; ++i) {
        if (isEmbedBlock(list.at(i)))
            keptEmbeds.append(list.at(i));
    }
    return InsertResult{list.mid(0, startArr) + merged + keptEmbeds + list.mid(endArr + 1),
                        start->lineIndex + (insCount - 1)};
}

QVector<Block> renormalizeEndMarker(const QVector<Block> &blocks)
{
    const QVector<Block> list = normalizeBlocks(blocks);
    QVector<Block> rest;
    rest.reserve(list.size());
    const Block *firstMarker = nullptr;
    for (const Block &block : list) {
        if (isMarkerBlock(block)) {
            if (!firstMarker)
                firstMarker = &block;
            continue;
        }
        rest.append(block);
    }
    // The canonical literal, the first marker's align (textBlock keeps a valid one only).
    if (firstMarker)
        rest.append(textBlock(END_MARKER, firstMarker->align));
    return rest;
}

bool isLineMergeBlocked(const QString &upperLine, const QString &lowerLine)
{
    if (!isEndLine(upperLine) && !isEndLine(lowerLine))
        return false; // no marker line takes part - the web's native merge, unchanged
    return !isEndLine(upperLine + lowerLine);
}

} // namespace editor
