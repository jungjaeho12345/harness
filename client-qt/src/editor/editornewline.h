#ifndef CLIENT_QT_EDITOR_EDITORNEWLINE_H
#define CLIENT_QT_EDITOR_EDITORNEWLINE_H

// The "(끝)" marker gate, newline insertion and the marker renormalization (phase 78 step3). A 1:1
// port of web/src/view/editorNewline.js (its spec, editorNewline.test.js, lives on as
// tests/editornewlinetest.cpp), plus the renormalization rule the web repeats inline in four places
// (writerBody.serializeBodyFromBlocks / insertEmbedAfterLine, editorShortcuts.insertContinueMarker,
// editorEditOps.sortDocument), plus one deliberate divergence: the line-merge gate (isLineMergeBlocked).
//
// CRITICAL (index.json decisions (2) · porting plan §5 risk 3): this module is the ONE place the editor
// decides whether an edit may touch the "(끝)" marker. A marker violation ships a contaminated body to
// sending and distribution, and that cannot be undone. Every insertion path of the text engine
// (typing, Enter, paste, drop, IME commit, shortcuts, conversions - step8) asks this module; nothing
// re-decides the marker with its own substring or trim.
//
// Two marker criteria live side by side and must not be mixed (web editorNewline.js:78-82):
//   - substring, lastIndexOf(END_MARKER): isInputBlocked / hasEndMarker - the input gate and the send
//     guard. A "(끝)" quoted mid-line closes the text after it.
//   - marker line, editor::isEndLine (JS trim() === END_MARKER - step2): isMarkerBlock and everything
//     built on it - replaceRangeInBlocks' clamp, renormalizeEndMarker, isLineMergeBlocked. A quoted
//     "(끝)" is ordinary text here.
// With several markers the web semantics are kept as they are: the input gate looks at the LAST one,
// replaceRangeInBlocks clamps at the FIRST marker line, renormalizeEndMarker folds them all into one
// final marker carrying the first one's align. The merge gate (no web counterpart) protects every
// marker line.
//
// Offsets are UTF-16 code units: a QString index, the same unit as a JS string index. Never bytes -
// a Hangul syllable is one unit but three UTF-8 bytes, so a byte offset moves the blocked position.
//
// Deleting, moving and selecting are not gated: removing the marker re-opens input (news.md). The one
// deletion this module judges is a line-boundary merge, and only by its result (isLineMergeBlocked).
//
// Pure: QString and the step1 block model only - no widget, no global state. Nothing mutates its input.

#include "editor/editorcontent.h"

#include <QString>
#include <QVector>

#include <optional>

namespace editor {

// Whether the text holds "(끝)" anywhere (editorNewline.hasEndMarker - substring). The overload for
// blocks in editorcontent.h applies the same criterion to the text blocks.
bool hasEndMarker(const QString &text);

// The text with "(끝)" appended on its own line (editorNewline.appendEndMarker): unchanged when it
// already holds the marker anywhere (no duplicate); no extra newline when it is empty or already ends
// with "\n".
QString appendEndMarker(const QString &text);

// Whether inserting at caretOffset is refused (editorNewline.isInputBlocked): blocked at or after the
// start of the LAST "(끝)" (lastIndexOf), allowed before it, never blocked without a marker. Insertion
// only - deleting, moving and selecting never ask this.
bool isInputBlocked(const QString &text, int caretOffset);

// Overwrite mode: whether the character after the caret is replaced rather than inserted before
// (editorNewline.shouldOverwriteNextChar). False at or past the end, on a "\n" (the next line is never
// eaten), wherever isInputBlocked, and inside a surrogate pair (a low surrogate right after a high one
// - replacing half a pair would store a broken code unit). A lone surrogate counts as a character.
bool shouldOverwriteNextChar(const QString &text, int offset);

// Overwrite mode: how many code units the replaced character spans (editorNewline.overwriteExtendLength)
// - 2 for a surrogate pair starting at offset, 1 otherwise (out of range and lone surrogates included).
int overwriteExtendLength(const QString &text, int offset);

// Whether a block is the "(끝)" marker line: a text block whose text isEndLine. Embeds never are,
// whatever their payload holds. The one block-level criterion behind editorNewline.js isMarkerBlock,
// editorEditOps.js isEndMarkerBlock and the isEnd lambdas of editorShortcuts.js / writerBody.js.
bool isMarkerBlock(const Block &block);

// A caret in text-only coordinates (the web Point): lineIndex = the ordinal of a text block (embeds
// are not counted), offset = an absolute offset into blocksToText(blocks).
struct TextPoint {
    int lineIndex = 0;
    int offset = 0;
};

// A selection. An end that is std::nullopt is unknown. Both unknown is the web's `range = null` and
// `{start: null, end: null}` at once - the web treats the two alike, so C++ has one spelling: TextRange{}.
struct TextRange {
    std::optional<TextPoint> start;
    std::optional<TextPoint> end;
};

// The web's { blocks, caretLineIndex }: the new blocks, and the text line the caret goes to.
struct InsertResult {
    QVector<Block> blocks;
    int caretLineIndex = 0;
};

// Inserts text (it may hold "\n") at the caret - Enter and multi-line paste
// (editorNewline.insertTextIntoBlocks). It is replaceRangeInBlocks with start == end, so every rule
// below applies; an unknown caret takes rule 1-b.
InsertResult insertTextIntoBlocks(const QVector<Block> &blocks, const std::optional<TextPoint> &caret,
                                  const QString &text);

// Deletes the range and inserts text in its place, keeping "one line = one text block"
// (editorNewline.replaceRangeInBlocks). The web's rules, in its numbering:
//   1-a  one known end -> collapsed there; a reversed range is swapped.
//   1-b  no known end -> insert at the end of the last text line, but never onto the marker line: at
//        the end of the line before the FIRST marker line, or - when the marker is the first text line
//        - as new text lines right in front of it. No text line at all -> new lines after every block.
//   3    the first marker line and every block after it are never changed: a start on or after it
//        falls back to 1-b; an end on or after it is clamped to the end of the line before it
//        (collapsed onto the start if that point would lie before the start).
//   4    embeds inside the range are kept, after the merged lines, in their order.
//   5    the first result line takes the start line's align, the last one the end line's, new middle
//        lines the start line's (an invalid align never becomes a key).
// A point whose lineIndex is outside the text lines is unknown; its in-line offset (offset minus the
// lines before it) is clamped into the line. The text is split on "\n" only ("\r" stays text).
// caretLineIndex = the start line + the inserted line count - 1.
InsertResult replaceRangeInBlocks(const QVector<Block> &blocks, const TextRange &range, const QString &text);

// The marker renormalization every web save and every block rearrangement applies (the rule of
// writerBody.serializeBodyFromBlocks without the serialize): every marker line (isMarkerBlock) is
// removed and, if there was one, a single canonical END_MARKER text block goes last, carrying the align
// of the first marker in document order. All other blocks keep their order. No marker -> none is made.
// A "(끝)" glued to other text is not a marker line and stays where it is - which is what makes the
// line-merge gate below necessary.
QVector<Block> renormalizeEndMarker(const QVector<Block> &blocks);

// The line-boundary merge gate - pre-decision 1, a deliberate divergence from the web. The web leaves
// Backspace at a line start and Delete at a line end to the browser with no marker guard
// (web/src/view/Editor.jsx isInsertionKey, WriterPage.jsx onKeyDown): "본문" + "(끝)" becomes
// "본문(끝)", which still passes the substring send guard but is no longer a marker line, so
// renormalizeEndMarker cannot move it - a contaminated body goes out.
//
// Whether joining upperLine with lowerLine (Backspace at the start of lowerLine, Delete at the end of
// upperLine) is refused: exactly when one of the two is a marker line (isEndLine) and the joined line is
// not. A merge that keeps the marker line whole (an empty or whitespace-only neighbour) and a merge of
// two non-marker lines pass, as in the web. This judges the RESULT of the merge; it does not block a
// key: deleting characters never asks it, and Backspace/Delete on an empty line is a line delete (web
// deleteLineAt - step5), not a merge.
bool isLineMergeBlocked(const QString &upperLine, const QString &lowerLine);

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORNEWLINE_H
