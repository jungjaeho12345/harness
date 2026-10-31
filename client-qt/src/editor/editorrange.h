#ifndef CLIENT_QT_EDITOR_EDITORRANGE_H
#define CLIENT_QT_EDITOR_EDITORRANGE_H

// Edit ranges: word (\S run) and paragraph (blank-line) bounds (phase 78 step4). A 1:1 port of
// web/src/view/editorRange.js (its spec, editorRange.test.js, lives on as tests/editorrangetest.cpp).
//
// Callers - selection, word delete, paragraph sort (step5 · step8) - pass one line or the line list; this
// layer never calls blocksToText / serialize. A column is a line-local UTF-16 code unit index (a QString
// index into the line - never bytes); a line index is a text-line ordinal, the TextPoint.lineIndex of
// editorcaret.h. How a caller turns a bound into a selection replaceRangeInBlocks (editornewline.h) takes,
// as the web's edit.selectWord / edit.selectParagraph wiring does (WriterPage.jsx):
//   word       lineStart = lineAtOffset(text, caret.offset).start, column = caret.offset - lineStart,
//              b = wordBoundsAt(lines(text).value(caret.lineIndex), column)
//              -> TextRange{TextPoint{caret.lineIndex, lineStart + b.start}, TextPoint{caret.lineIndex, lineStart + b.end}}
//   paragraph  p = paragraphBoundsAt(lines(text), caret.lineIndex)
//              -> from the start of line p.startLine to the end of line p.endLine
// The marker clamp stays where it is - replaceRangeInBlocks applies it to whatever range it is given.
//
// Pure: QString only - no widget, no global state, nothing mutates its input.

#include <QString>
#include <QStringList>

namespace editor {

// A word in one line: [start, end) - end exclusive. start == end is the empty range, the web's "no word
// here" no-op signal (callers do nothing on it).
struct WordBounds {
    int start = 0;
    int end = 0;
};

// The word at column (editorRange.wordBoundsAt): a maximal run of code units that are not whitespace - JS
// /\S/ per code unit, i.e. editor::isJsWhitespace (editorroles.h), never QChar::isSpace(). column is clamped
// into [0, length] first. Then:
//   - on a word unit: that word
//   - otherwise (whitespace, or the line end): the nearest word to the LEFT - so a caret right after a word
//     takes it - and only when there is none, the nearest word to the right
//   - no word in the line at all: {column, column}, the empty range
// A lone surrogate is a word unit (it is not whitespace), as in JS.
WordBounds wordBoundsAt(const QString &lineText, int column);

// Whether a line is a paragraph boundary: exactly the empty string (web arr[i] === ''). A whitespace-only
// line is a non-blank line. The ONE paragraph definition of the editor layer - paragraphBoundsAt reads it,
// and the status bar's paragraph number (web editorStats.paragraphIndex, ported with the status bar in P6)
// has to call it rather than spell its own.
bool isParagraphBoundary(const QString &line);

// A paragraph: text-line indices [startLine, endLine], both inclusive.
struct ParagraphBounds {
    int startLine = 0;
    int endLine = 0;
};

// The paragraph lineIndex belongs to (editorRange.paragraphBoundsAt): a non-blank line extends up and down
// over the adjacent non-blank lines; a blank line (isParagraphBoundary) is a paragraph of its own. lineIndex
// is clamped into [0, size - 1]; an empty list gives {0, 0}. (The web also accepts a bare string as a
// one-line list; the C++ caller writes QStringList{text}.)
ParagraphBounds paragraphBoundsAt(const QStringList &textLines, int lineIndex);

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORRANGE_H
