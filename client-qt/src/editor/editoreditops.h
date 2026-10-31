#ifndef CLIENT_QT_EDITOR_EDITOREDITOPS_H
#define CLIENT_QT_EDITOR_EDITOREDITOPS_H

// Edit-menu block operations (phase 78 step5): web/src/view/editorEditOps.js, the word delete only - its spec
// cases (editorEditOps.test.js: describe "deleteWordAt" and the input-immutability case) live on as
// tests/editoreditopstest.cpp. The module's other two functions, sortDocument / sortParagraph (문서 / 문단
// 정렬), belong to the 보기 정렬 menu, which is P6 (index.json open_questions (2)); when they come they go here,
// and sortParagraph calls paragraphBoundsAt (editorrange.h) rather than computing the bounds again.
// Line deletion is not here either: Ctrl+D's single source is deleteLineAt (editorshortcuts.h).
//
// Pure: QString, the step1 block model and step4's word bounds - no widget, nothing mutates its input.

#include "editor/editorcontent.h"

#include <QVector>

#include <optional>

namespace editor {

// The web's { blocks, changed, caretColumn }. caretColumn is where the caret goes, line-local (the deleted
// word's start); std::nullopt is the web's null - nothing was deleted.
struct WordDeletion {
    QVector<Block> blocks;
    bool changed = false;
    std::optional<int> caretColumn;
};

// Deletes the word at column of text line caretLineIndex (editorEditOps.deleteWordAt). The word is
// wordBoundsAt(line, column) (editorrange.h - a whitespace-free run; the whitespace around it is neither merged
// nor deleted) and the line keeps its align. A no-op - the normalized blocks, changed false, caretColumn
// std::nullopt - when the line does not map to a text block (textLineToBlockIndex < 0), when it is the "(끝)"
// marker line (isMarkerBlock - a partial delete would leave a broken "끝)" that silently costs the article its
// right to be sent), or when there is no word (start == end).
// A word holds no whitespace and neither does "(끝)", so a delete takes every "(끝)" it touches whole or none.
WordDeletion deleteWordAt(const QVector<Block> &blocks, int caretLineIndex, int column);

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITOREDITOPS_H
