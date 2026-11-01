#ifndef CLIENT_QT_EDITOR_EDITORSHORTCUTS_H
#define CLIENT_QT_EDITOR_EDITORSHORTCUTS_H

// The editor shortcuts: key recognition and the pure block transforms behind them (phase 78 step5). A 1:1
// port of web/src/view/editorShortcuts.js (its spec, editorShortcuts.test.js, lives on as
// tests/editorshortcutstest.cpp), plus two items the web keeps in other modules:
//   - isFindReplace (web editorFind.js) - the Ctrl+F key test only; the find / replace engine is P6
//   - RESERVED_COMBOS (web editorGlyphKeymap.js) - the 13 reserved shortcuts, the porting plan's "단축키 13종".
//     The user glyph keymap that refuses them is P6 and reads this list instead of spelling its own.
//
// The 13, in the web order, and what recognises each:
//   Ctrl+B        isCompanyCode           기업코드 변환 (the conversion itself is not P5)
//   Ctrl+X        - native                잘라내기 (the text engine's own cut)
//   Ctrl+C        - native                복사
//   Ctrl+V        - native                붙여넣기 (through the marker gate - step8)
//   Alt+V         isPasteOriginal         원본 붙여넣기 (P6)
//   Alt+O         isGlyphInput            약물 입력 (P6)
//   Ctrl+F        isFindReplace           찾기/바꾸기 (P6)
//   Ctrl+A        - native                전체 선택
//   Ctrl+Y        isInsertContinueMarker  (계속) 삽입 - insertContinueMarker
//   Ctrl+Z        isUndo                  되돌리기 (step6)
//   Ctrl+Shift+Z  isRedo                  다시실행 (step6)
//   Ctrl+D        isDeleteLine            한줄 지우기 - deleteLineAt
//   Alt+Y         isInsertEndMarker       (끝) 삽입 - insertEndMarker
// Insert (isToggleOverwrite) is a shortcut as well but not a reserved one: it has no modifier, so no keymap
// entry can ever claim it.
//
// Key recognition is pure judgement. WHEN a key is intercepted belongs to the text engine (step8): never while
// an IME composition is in progress (decisions (4)), and in the order of the web's WriterPage.onKeyDown,
// because the predicates overlap where a layout's character and physical key disagree (Ctrl + "f" typed on the
// physical Y key under Dvorak is Ctrl+F and Ctrl+Y at once - the web runs the earlier one):
//   isToggleOverwrite, isCompanyCode, isFindReplace, isGlyphInput, isPasteOriginal, isInsertEndMarker,
//   isInsertContinueMarker, isUndo, isRedo, [the user glyph keymap - P6], [overwrite typing], then isDeleteLine
//   together with Backspace / Delete on an empty line, which the web sends to deleteLineAt as well.
//
// Marker integrity (decisions (2)). insertEndMarker refuses exactly when the text holds "(끝)" anywhere - the
// step3 substring criterion (hasEndMarker), which is the input gate isInputBlocked asked at the end of the
// document, where the marker would go. insertContinueMarker keeps the marker last through step3's
// renormalizeEndMarker. Deleting a whole line, the marker line included, is allowed: removing the marker
// re-opens input (news.md). The case transforms cannot change a marker line - "(끝)" and the whitespace around
// it have no case (tests/editorshortcutstest.cpp locks it).
//
// Pure: QString and the step1 block model only - no widget, no global state, nothing mutates its input.

#include "editor/editorcontent.h"

#include <QString>
#include <QVector>
#include <qnamespace.h>

#include <functional>
#include <optional>

namespace editor {

// "(계속)" - the continuation marker Ctrl+Y inserts (editorShortcuts.CONTINUE_MARKER).
extern const QString CONTINUE_MARKER;

// One key press in the web KeyboardEvent's terms - the shape every predicate below reads.
//   modifiers  Ctrl / Alt / Shift / Meta (web ctrlKey / altKey / shiftKey / metaKey). Only those four flags are
//              read; Qt::KeypadModifier and Qt::GroupSwitchModifier are ignored.
//   key        web KeyboardEvent.key - what the key types under the current layout: "y", "Y", "ㅛ" (Hangul
//              input), or a named key such as "Insert".
//   code       web KeyboardEvent.code - the physical key, whatever the layout: "KeyY", "Insert".
// Filling it from a QKeyEvent is the text engine's job (step8), to be measured there on the real keyboard: under
// Ctrl, QKeyEvent::text() is expected to be a control character rather than the letter, so `key` cannot simply
// be text(); `code` has to come from the physical key (the scan code), not from the layout.
// The web's null / undefined event is KeyInput{} - nothing pressed - for which every predicate is false.
struct KeyInput {
    Qt::KeyboardModifiers modifiers = Qt::NoModifier;
    QString key;
    QString code;
};

// The web predicates, 1:1. A letter is recognised by `key` in either case OR by `code` - never by `key` alone:
// under Hangul input the key types a jamo and only the code still says "KeyY" (web contract).
bool isInsertEndMarker(const KeyInput &e);      // Alt+Y: alt && !ctrl; shift / meta ignored
bool isDeleteLine(const KeyInput &e);           // Ctrl+D: ctrl && !alt; shift / meta ignored
bool isInsertContinueMarker(const KeyInput &e); // Ctrl+Y: ctrl && !alt; shift / meta ignored
bool isCompanyCode(const KeyInput &e);          // Ctrl+B: ctrl && !alt; shift / meta ignored
bool isToggleOverwrite(const KeyInput &e);      // Insert with no modifier at all (Shift / Ctrl+Insert are paste / copy)
bool isUndo(const KeyInput &e);                 // Ctrl+Z or Meta+Z: (ctrl || meta) && !alt && !shift
bool isRedo(const KeyInput &e);                 // Ctrl+Shift+Z or Meta+Shift+Z: (ctrl || meta) && !alt && shift
bool isGlyphInput(const KeyInput &e);           // Alt+O: alt && !ctrl; shift / meta ignored
bool isPasteOriginal(const KeyInput &e);        // Alt+V: alt && !ctrl; shift / meta ignored
bool isFindReplace(const KeyInput &e);          // Ctrl+F (web editorFind.js): ctrl && !alt; shift / meta ignored

// A key combination in the web parseKeyCombo shape: exact modifier flags and the key in lower case.
struct KeyCombo {
    bool ctrl = false;
    bool alt = false;
    bool shift = false;
    bool meta = false;
    QString key;
};
bool operator==(const KeyCombo &a, const KeyCombo &b);
inline bool operator!=(const KeyCombo &a, const KeyCombo &b) { return !(a == b); }

// The 13 reserved shortcuts (web editorGlyphKeymap.RESERVED_COMBOS - the single source), in the web order:
// Ctrl+B, Ctrl+X, Ctrl+C, Ctrl+V, Alt+V, Alt+O, Ctrl+F, Ctrl+A, Ctrl+Y, Ctrl+Z, Ctrl+Shift+Z, Ctrl+D, Alt+Y.
extern const QVector<KeyCombo> RESERVED_COMBOS;

// Alt+Y (editorShortcuts.insertEndMarker): "(끝)" appended as the final block - after the text and every
// embed. Not inserted when the text blocks already hold "(끝)" anywhere (hasEndMarker - glued and quoted
// markers count; an embed payload does not). spellcheck is always true: the web turns spell checking on at
// Alt+Y (the checker itself is P6 - the flag carries its trigger).
struct EndMarkerInsertion {
    QVector<Block> blocks;
    bool inserted = false;
    bool spellcheck = true;
};
EndMarkerInsertion insertEndMarker(const QVector<Block> &blocks);

// Ctrl+D (editorShortcuts.deleteLineAt - the single source of line deletion; Backspace / Delete on an empty
// line use it too). index is a BLOCK index. The block goes; when it is a text block and an embed follows it,
// that one embed goes with it (a text line's embed is the one right after it - one at a time) and removedEmbed
// is true. Out of range: the normalized blocks, removed = std::nullopt (the web's null), removedEmbed false.
struct LineDeletion {
    QVector<Block> blocks;
    std::optional<Block> removed;
    bool removedEmbed = false;
};
LineDeletion deleteLineAt(const QVector<Block> &blocks, int index);

// Ctrl+Y (editorShortcuts.insertContinueMarker): a "(계속)" line right after text line textLineIndex - no
// blank line is made. A line that does not map to a text block (std::nullopt - no caret yet -, negative, past
// the end) puts it at the end instead. Then the "(끝)" marker is renormalized last (renormalizeEndMarker,
// the first marker's align kept). Not idempotent: every press adds one. caretTextLine = the text line the new
// "(계속)" ends up on.
struct ContinueMarkerInsertion {
    QVector<Block> blocks;
    int caretTextLine = 0;
};
ContinueMarkerInsertion insertContinueMarker(const QVector<Block> &blocks, std::optional<int> textLineIndex);

// The 보기 menu's case conversion of one text line (editorShortcuts.transformTextLine): fn applied to text line
// textLineIndex (embeds are not counted); the line keeps its align (and gets none it did not have); every
// other block is untouched. A line that does not map to a text block changes nothing. (The web returns
// { blocks }; here it is the blocks.)
QVector<Block> transformTextLine(const QVector<Block> &blocks, int textLineIndex,
                                 const std::function<QString(const QString &)> &fn);

// The four case transforms (editorShortcuts toUpper / toLower / capitalizeFirst / toggleCase). JS toUpperCase /
// toLowerCase are locale-independent full Unicode case mappings (ß -> SS, İ -> i̇) and so are QString::toUpper /
// toLower. Measured on this machine against node 24 for every code point and over random strings, they agree
// except in three ways - the port fixes one and keeps two (tests/editorshortcutstest.cpp locks all three):
//   fixed  QString::toUpper / toLower turn an unpaired surrogate that comes after the first changed character
//          into U+FFFD; JS keeps it. Here the runs between lone surrogates are converted and every lone
//          surrogate is copied as it is.
//   kept   JS toLowerCase applies the Final_Sigma rule (a capital sigma that ends a word becomes ς U+03C2);
//          Qt maps each code point on its own (σ U+03C3).
//   kept   56 code points whose case pairs Unicode 17.0 made (U+A7CE.., U+16EA0..; U+A7D3 / U+A7D5 are 14.0
//          letters whose capitals came in 17.0): Qt 6.8.3's tables are Unicode 16.0 and leave them as they are
//          (the web's own answer depends on its runtime's ICU).
// None of this can reach the "(끝)" marker, which has no case.
QString toUpper(const QString &s);
QString toLower(const QString &s);
// The first UTF-16 code unit upper-cased, the rest lower-cased - JS charAt(0) / slice(1), so an astral first
// letter is split and stays as it is.
QString capitalizeFirst(const QString &s);
// Each code point (JS Array.from - a lone surrogate is one) that is purely lower case becomes upper case and
// the other way round; a code point that is both or neither (digits, Hangul, title case ǅ) stays.
QString toggleCase(const QString &s);

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORSHORTCUTS_H
