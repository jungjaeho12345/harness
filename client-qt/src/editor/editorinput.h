#ifndef CLIENT_QT_EDITOR_EDITORINPUT_H
#define CLIENT_QT_EDITOR_EDITORINPUT_H

// The pure half of the text engine's input routing (phase 78 step8). The widget (ui/editorwidget.*) is a Qt
// adapter; every decision it takes about an input that can be made without a window lives here, so QtTest locks it
// without a GUI:
//   - which shortcut a key press is, in the web's order (shortcutFor - web/src/view/WriterPage.jsx onKeyDown)
//   - what KeyInput a Qt key event is (keyInputFromQt - measured on this machine, see below)
//   - whether Qt's text engine would type a key's text (insertsText)
//   - which characters a QTextDocument block cannot hold, and how a line is shown (isBlockBreakChar / displayLine)
//   - the line join a Backspace / Delete at a line boundary performs once isLineMergeBlocked allowed it
//   - where a native (Qt-performed) edit happened (nativeEditBetween)
// Nothing here re-decides the "(끝)" marker: the gates are editornewline.h's isInputBlocked, replaceRangeInBlocks and
// isLineMergeBlocked, and the widget asks them - never a substring or trim of its own.
//
// Pure: QString, Qt key enums and the step1 block model only - no widget, no global state, nothing mutates its input.

#include "editor/editorcontent.h"
#include "editor/editorshortcuts.h"

#include <QChar>
#include <QString>
#include <QStringList>
#include <QVector>
#include <qnamespace.h>

#include <optional>

namespace editor {

// The shortcuts a key press can be, named after the step5 predicate that recognises each.
enum class Shortcut {
    ToggleOverwrite,      // isToggleOverwrite
    CompanyCode,          // isCompanyCode       - the conversion itself is P6
    FindReplace,          // isFindReplace       - P6
    GlyphInput,           // isGlyphInput        - P6
    PasteOriginal,        // isPasteOriginal     - P6
    InsertEndMarker,      // isInsertEndMarker
    InsertContinueMarker, // isInsertContinueMarker
    Undo,                 // isUndo              - performed by the state machine (step9)
    Redo,                 // isRedo              - performed by the state machine (step9)
    DeleteLine,           // isDeleteLine
};

// The predicate names in the order shortcutFor asks them - web WriterPage.jsx onKeyDown, which a test reads at run
// time and compares with this list (so the two cannot drift apart silently).
extern const QStringList SHORTCUT_ORDER;

// The shortcut a press is: the FIRST of the step5 predicates that fires, in the web's onKeyDown order -
//   isToggleOverwrite, isCompanyCode, isFindReplace, isGlyphInput, isPasteOriginal, isInsertEndMarker,
//   isInsertContinueMarker, isUndo, isRedo, isDeleteLine.
// The order matters where a layout's character and its physical key name different letters (Dvorak Ctrl + the
// physical Y types "f": isFindReplace and isInsertContinueMarker both fire, the web runs Find). nullopt: no shortcut.
// The web's user glyph keymap (P6) and overwrite typing sit between isRedo and isDeleteLine; neither is a shortcut.
// The caller asks only while no IME composition is in progress (decisions (4)).
std::optional<Shortcut> shortcutFor(const KeyInput &e);

// What a Qt key event is in the web KeyboardEvent's terms. Measured on this machine (Qt 6.8.3, the windows platform
// plugin, Korean layout 0x0412, WM_KEYDOWN / WM_SYSKEYDOWN posted to a probe window - phase 78 step8):
//   - key() is the layout's letter (Qt::Key_Y for the Y key with or without Ctrl / Alt / Shift)
//   - text() under Ctrl is a control character (Ctrl+Y gives U+0019, Ctrl+D U+0004), under Alt the letter -
//     so text() is never read here
//   - nativeScanCode() is the set-1 make code of the physical key (0x15 for Y), 0xE0xx for an extended key
//     (Insert 0xE052, Delete 0xE053); the keypad 0 / Insert key is 0x52 with Qt::KeypadModifier
// So: modifiers as given (the predicates read Ctrl / Alt / Shift / Meta only); key = the letter of a printable key
// (upper case under Shift, as the web's key would be) or the web name of a named key (Insert, Delete, Backspace,
// Enter, Tab, Escape); code = the web KeyboardEvent.code of the physical key - KeyA..KeyZ, Insert, Numpad0, Delete,
// NumpadDecimal, Backspace, Enter, NumpadEnter - and "" for every other scan code (QTest's synthetic events carry
// scan code 0, so their code is "" and the key alone decides, as for the web's key-only events).
KeyInput keyInputFromQt(int qtKey, Qt::KeyboardModifiers modifiers, quint32 nativeScanCode);

// Whether Qt's text engine types this key's text - the rule of Qt 6.8.3's QInputControl::isAcceptableInput for a
// text edit (tests/editorinputtest.cpp checks it against a live QPlainTextEdit): the first character is a format
// character (Cf); or, unless the modifiers are exactly Ctrl or Ctrl+Shift, it is printable, private use, the start of
// a surrogate pair or a tab. Measured consequence: Alt+letter types the letter in a QPlainTextEdit (the web never
// types on an Alt combination - the widget refuses those itself), AltGr (Ctrl+Alt) types what the layout gives.
bool insertsText(Qt::KeyboardModifiers modifiers, const QString &text);

// The characters QTextCursor::insertText turns into a block break (measured over every UTF-16 code unit on Qt 6.8.3):
// LF, CR (CR LF is one break), U+2029, U+FDD0 and U+FDD1. A text line holding one of them cannot be one block of the
// widget's document as it is, which would break the step4 caret contract (one text line = one document block,
// TextPoint{blockNumber, position}). LF inside a block's text never comes from the editor; CR does - a collected
// article split on LF keeps its CR (src/services/collectionService.js toMarkup).
bool isBlockBreakChar(QChar c);

// How a text line is shown: every block-break character replaced by one stand-in, so the shown line has the same
// length as the real one and every offset maps 1:1. LF, CR and U+2029 become a space - the web shows CR as one in its
// pre-wrap line (web/src/styles/yonhap.css .yh-editor__line); U+FDD0 / U+FDD1 (non-characters) become U+FFFD. The
// real text stays in the widget's blocks; a copy carries the real text.
QString displayLine(const QString &line);

// The line join of a Backspace at the start of text line upperTextLine + 1 or a Delete at the end of upperTextLine
// - to be called only after isLineMergeBlocked(upper, lower) said no. The two text lines become one: the upper text +
// the lower text, the upper line's align (the line the caret stays on); the embeds between the two go right after the
// joined line, in their order. This is exactly what replaceRangeInBlocks does for the range over the line break when
// no marker line takes part (tests lock the equality); with a marker line it would refuse (its clamp), and the merge
// gate is the one that decides there - a join it allowed keeps the marker line whole by definition. upperTextLine
// without a next text line: the normalized blocks unchanged.
QVector<Block> joinTextLines(const QVector<Block> &blocks, int upperTextLine);

// A native edit - one Qt performed itself - located between the shown text before and after it: before[start, start +
// removed) became `inserted`. Every native edit the widget lets Qt make covers the cursor or selection it started from,
// [selStart, selEnd]:
//   forward  (typing, an IME commit, Delete, a single-line selection removed or typed over) starts exactly at selStart
//   backward (Backspace, Ctrl+Backspace) ends exactly at selEnd (= the cursor)
// That anchor makes the answer exact where identical characters would let a plain prefix / suffix diff slide - a space
// typed right before a CR shown as a space goes before the CR. nullopt: `after` is not one edit of that shape (the
// widget then puts the document back - fail closed). Equal texts give {selStart, 0, ""}.
struct TextEdit {
    int start = 0;
    int removed = 0;
    QString inserted;
};
std::optional<TextEdit> nativeEditBetween(const QString &before, const QString &after, int selStart, int selEnd,
                                          bool backward);

// What an edit the widget reports was, for the state machine's undo coalescing (step9 - web WriterPage.commitBody):
//   Typing    what the web's Editor reports through onTextChange: typing, Enter, paste, IME commits, character /
//             selection deletes, line joins - consecutive Typing commits may coalesce into one undo step
//   Operation the web's WriterPage edit ops: Ctrl+D and Backspace / Delete on an empty line (deleteLineAt), Alt+Y,
//             Ctrl+Y, the case conversion - one undo step each
enum class EditKind { Typing, Operation };

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORINPUT_H
