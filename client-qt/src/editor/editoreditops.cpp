#include "editor/editoreditops.h"

#include "editor/editornewline.h" // isMarkerBlock - the step3 marker-line criterion
#include "editor/editorrange.h"   // wordBoundsAt - the step4 word bounds

namespace editor {

WordDeletion deleteWordAt(const QVector<Block> &blocks, int caretLineIndex, int column)
{
    const QVector<Block> list = normalizeBlocks(blocks);
    const int blockIndex = textLineToBlockIndex(list, caretLineIndex);
    if (blockIndex < 0)
        return WordDeletion{list, false, std::nullopt};
    const Block &line = list.at(blockIndex);
    if (isMarkerBlock(line))
        return WordDeletion{list, false, std::nullopt}; // the marker stays whole
    const WordBounds word = wordBoundsAt(line.text, column);
    if (word.start == word.end)
        return WordDeletion{list, false, std::nullopt}; // no word here
    QVector<Block> next = list;
    next[blockIndex] = textBlock(line.text.left(word.start) + line.text.mid(word.end), line.align);
    return WordDeletion{next, true, word.start};
}

} // namespace editor
