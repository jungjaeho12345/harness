#ifndef CLIENT_QT_EDITOR_EDITORCARET_H
#define CLIENT_QT_EDITOR_EDITORCARET_H

// The caret and the line math under it (phase 78 step4). A 1:1 port of web/src/view/editorCaret.js (its
// spec, editorCaret.test.js, lives on as tests/editorcarettest.cpp), plus the caret itself - the web's
// readCaret contract { lineIndex, offset } (web/src/view/Editor.jsx readCaret) as editor::TextPoint.
//
// Offsets are UTF-16 code units: a QString index, the same unit as a JS string index (pre-decision 7).
// Never bytes - a Hangul syllable is one unit but three UTF-8 bytes, so a byte offset lands on another
// character.
//
// Pure: QString only - no widget, no global state, nothing mutates its input. The text engine (step8) reads
// its cursor into a TextPoint and hands it to these functions, to editorrange.h and to editornewline.h.

#include <QString>
#include <QStringList>

#include <optional>

namespace editor {

// The caret - and either end of a selection - in text-only coordinates: the web readCaret contract and the
// Point of editorNewline.js. lineIndex = the ordinal of a text line (a text block; embeds are not counted),
// offset = an absolute offset into the text, blocksToText(blocks) - the text lines joined with "\n". It is
// the type replaceRangeInBlocks (editornewline.h) takes, so a caret read here goes there unconverted. The
// two fields describe one position: lineIndex is lineAtOffset(text, offset).lineIndex. (Defined in
// editornewline.h in step3; the caret model owns it since step4.)
struct TextPoint {
    int lineIndex = 0;
    int offset = 0;
};

// The text split on "\n" alone (editorCaret.lines - JS String(text ?? '').split('\n')): "" is one empty
// line, "\r" stays in the line, a trailing "\n" leaves a trailing empty line, U+2028 / U+2029 / U+0085 do
// not split.
QStringList lines(const QString &text);

// The line a caret offset sits on (editorCaret.lineAtOffset). The offset is clamped into [0, length] first
// (an out-of-range caret lands on the first / last line); lineIndex = the "\n" count before it, and
// [start, end) is that line's own span in the text - end is the next "\n" or the text end. An offset on a
// "\n" belongs to the line that "\n" ends.
struct LineBounds {
    int lineIndex = 0;
    int start = 0;
    int end = 0;
};
LineBounds lineAtOffset(const QString &text, int caretOffset);

// One line taken out of the text (editorCaret.removeLineFromText): the new text, the removed line and the
// caret - the start offset of the line that now sits in the removed one's slot (the new last line when the
// last one went, 0 when nothing is left). An out-of-range lineIndex changes nothing: the text as given,
// removed = std::nullopt (the web's null - an empty removed line is "", which is a different answer) and
// caret 0.
struct LineRemoval {
    QString text;
    std::optional<QString> removed;
    int caret = 0;
};
LineRemoval removeLineFromText(const QString &text, int lineIndex);

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORCARET_H
