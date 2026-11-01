#include "editor/writerbody.h"

#include "editor/editornewline.h"
#include "editor/editorroles.h"

namespace editor {
namespace {

// JS String.prototype.trim() - the editor layer's one whitespace set (isJsWhitespace, step2/step4).
QString trimLikeJs(const QString &text)
{
    qsizetype start = 0;
    qsizetype end = text.size();
    while (start < end && isJsWhitespace(text.at(start)))
        ++start;
    while (end > start && isJsWhitespace(text.at(end - 1)))
        --end;
    return text.mid(start, end - start);
}

} // namespace

QString bodyTitle(const QString &body)
{
    // writerBody.js: (blocksToText(deserialize(body)).split('\n')[0] ?? '').trim() - only "\n" splits.
    const QString text = blocksToText(deserialize(body));
    const qsizetype newline = text.indexOf(QLatin1Char('\n'));
    return trimLikeJs(newline < 0 ? text : text.left(newline));
}

QString serializeBodyFromBlocks(const QVector<Block> &blocks)
{
    return serialize(renormalizeEndMarker(blocks));
}

} // namespace editor
