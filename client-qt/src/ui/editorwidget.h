#ifndef CLIENT_QT_UI_EDITORWIDGET_H
#define CLIENT_QT_UI_EDITORWIDGET_H

// The text engine (phase 78 step8) - the editor's one GUI piece and the P5 editor screen's main panel (README
// 「화면」). Base: QPlainTextEdit + QSyntaxHighlighter, the P0 spike's go path (spikes/p0-qt-editor/editorwidget.*,
// index.json open_questions (1)). Everything that can be decided without a window is the pure layer's (editor/**):
// this class reads its cursor and keys, asks the pure functions, and writes their answers back.
//
// The model. The widget holds the body as blocks (editor::Block - text lines and the embeds P5 carries without
// rendering them). The document shows the text lines, ONE DOCUMENT BLOCK PER TEXT LINE, so a caret is the step4
// TextPoint{blockNumber, position} unconverted and every document offset is the same offset into
// blocksToText(blocks()). Characters a document block cannot hold (editor::isBlockBreakChar - a collected article's
// trailing CR, mostly) are shown through editor::displayLine, one stand-in each; the real text stays in the blocks.
//
// The "(끝)" marker gate (decisions (2)). Every path that writes the document goes through editornewline.h:
//   typing, IME commit         isInputBlocked at the insertion point (the selection start); Qt types it, then the
//                              edit is located (nativeEditBetween), checked again - blocked insertion, a line break
//                              made or removed -> the document is put back - and mirrored into the blocks
//   Enter, paste, typing / an IME commit over a multi-line selection or holding a line break, an IME replacement
//                              isInputBlocked, then replaceRangeInBlocks (its marker clamp)
//   a multi-line selection deleted (Backspace, Delete, cut, a word delete that crosses lines, an IME starting over it)
//                              replaceRangeInBlocks(..., "") - "본문⏎(끝)" minus "문⏎(끝" is "본⏎(끝)", never "본(끝)"
//   Backspace at a line start / Delete at a line end
//                              isLineMergeBlocked (pre-decision 1), then joinTextLines
//   Backspace / Delete on an empty line, Ctrl+D
//                              deleteLineAt (removing the marker line re-opens input - news.md)
//   Alt+Y / Ctrl+Y             insertEndMarker / insertContinueMarker (the marker stays last)
//   the case conversion        transformCaretLine: isInputBlocked at the line end, then transformTextLine
//   anything else (an API call on QPlainTextEdit, assistive technology, a drag that moved text out)
//                              noticed as a document change no path of ours made, and undone (fail closed)
// Single-line deletes are not gated - deleting, moving and selecting never are; only joins and multi-line deletes
// can glue a marker line to other text. Drops, the context menu and text drags do not exist in P5 (drops of image
// files are P6's embeds; the context menu's 14 actions are P7).
//
// IME (decisions (4)). While a composition is in progress nothing is intercepted: no shortcut, no recolour, no
// caret move. A composition never starts where input is blocked (Qt::ImEnabled is false there, and a stray event is
// refused). Recolouring follows editor::shouldRecolor - "load" (setBlocks and every structural edit, like the web's
// remount), "blur", "compositionend" - and never while composing. Whether the caret stays still under a real MS-IME
// is NOT something a test here can tell: that is the step10 eye check.
//
// Undo (decisions / step6). The document's own undo stack is off; Ctrl+Z / Ctrl+Shift+Z are reported
// (shortcutTriggered) for the state machine's snapshot history (step9), which writes back with setBlocks. The state
// machine also owns the coalescing clock: edited() says whether an edit was typing or an edit operation.

#include "editor/editorcontent.h"
#include "editor/editorinput.h"
#include "editor/editornewline.h"

#include <QPlainTextEdit>
#include <QString>
#include <QVariant>
#include <QVector>

#include <functional>
#include <optional>

class QDragEnterEvent;
class QDragMoveEvent;
class QDropEvent;
class QFocusEvent;
class QInputMethodEvent;
class QKeyEvent;
class QMimeData;
class QMouseEvent;

namespace ui {

class RoleHighlighter;

class EditorWidget : public QPlainTextEdit
{
    Q_OBJECT

public:
    explicit EditorWidget(QWidget *parent = nullptr);
    ~EditorWidget() override;

    // The body. setBlocks is the state machine's write - opening an article, applying an undo / redo snapshot,
    // pushing back a renormalized body: the document follows with a minimal edit (the caret keeps its place where the
    // text did not change; a pushed-back renormalization of the current body keeps it on its own line and column -
    // only the marker lines move), colours are recomputed ("load") and edited() is NOT emitted. A composition in
    // progress is dropped first. blocks() is the current body: normalized blocks, embeds where they were.
    void setBlocks(const QVector<editor::Block> &blocks);
    QVector<editor::Block> blocks() const;

    // The caret and the selection in step4 / step3 terms (lineIndex = text-line ordinal = document block number,
    // offset = blocksToText offset). selectionRange() is normalized (start <= end); no selection = start == end.
    editor::TextPoint caret() const;
    editor::TextRange selectionRange() const;
    // The caret to the start of text line lineIndex (clamped, as the web's focusLineStart) and the focus here.
    void focusLineStart(int lineIndex);

    // The 보기 menu's case conversion of the caret's line (editorShortcuts.transformTextLine with fn - toUpper /
    // toLower / capitalizeFirst / toggleCase). Refused when the line reaches the last "(끝)" (isInputBlocked at the
    // line end), when composing and when read-only. true = the body changed (reported as an Operation); false =
    // refused, or the line had nothing to convert. The menu itself is P6.
    bool transformCaretLine(const std::function<QString(const QString &)> &fn);

    bool isComposing() const; // a preedit is showing
    bool overwriting() const; // the Insert-key overwrite mode (not QPlainTextEdit::overwriteMode, which stays off)
    int recolorCount() const; // how many times the role colours were recomputed - the "never while composing" check

    QVariant inputMethodQuery(Qt::InputMethodQuery query) const override;

signals:
    // A user edit changed blocks(). Typing / Operation is the undo-coalescing class (editor::EditKind). An edit made
    // while composing is reported once, when the composition ends. setBlocks never reports.
    void edited(editor::EditKind kind);
    // Every shortcut the widget recognised (and consumed), in the web's order (editor::shortcutFor). The widget itself
    // performs ToggleOverwrite, InsertEndMarker, InsertContinueMarker and DeleteLine; Undo / Redo are the state
    // machine's; CompanyCode / FindReplace / GlyphInput / PasteOriginal are P6 features and only reported here.
    // Read-only: consumed, not performed, not reported.
    void shortcutTriggered(editor::Shortcut shortcut);

protected:
    void keyPressEvent(QKeyEvent *e) override;
    void inputMethodEvent(QInputMethodEvent *e) override;
    void insertFromMimeData(const QMimeData *source) override;
    QMimeData *createMimeDataFromSelection() const override;
    void focusOutEvent(QFocusEvent *e) override;
    void mousePressEvent(QMouseEvent *e) override;
    void dragEnterEvent(QDragEnterEvent *e) override;
    void dragMoveEvent(QDragMoveEvent *e) override;
    void dropEvent(QDropEvent *e) override;

private:
    enum class CaretAfter { Keep, Line }; // Keep: where Qt's minimal edit leaves it; Line: a text line and a column

    QString realText() const;
    int textLineCount() const;
    QString realLine(int textLine) const;
    QString documentText() const;
    QString shownText() const;
    editor::TextPoint pointAt(int position) const;
    int insertionPoint() const;
    bool insertionBlocked() const;
    bool selectionSpansLines() const;
    bool preeditActive() const;

    void restoreIfPending();
    void restoreDocument();
    void showText(const QString &target);
    void placeCaret(int textLine, int column);
    bool applyBlocks(const QVector<editor::Block> &next, editor::EditKind kind, CaretAfter caret, int caretLine = 0,
                     int caretColumn = 0);
    template <typename Call>
    bool runNative(Call &&call, bool backward);
    bool acceptNativeEdit(const editor::TextEdit &edit);
    void emitEdited(editor::EditKind kind);
    bool recolor(const QString &trigger);
    void updateComposing();

    bool replaceRange(const editor::TextRange &range, const QString &text, editor::EditKind kind);
    bool replaceSelection(const QString &text, editor::EditKind kind);
    void deleteSelection();
    void cutSelection();
    void deleteKey(QKeyEvent *e, bool backward);
    void deleteLine(int textLine);
    void typeKey(QKeyEvent *e);
    void triggerShortcut(editor::Shortcut shortcut);

    QVector<editor::Block> m_blocks;
    QString m_shown; // the document's text as the widget last wrote or mirrored it (display lines joined with '\n')
    RoleHighlighter *m_highlighter = nullptr;
    int m_guard = 0;
    bool m_restoreQueued = false;
    bool m_composing = false;
    bool m_typingPending = false;
    bool m_overwrite = false;
    int m_recolorCount = 0;
};

} // namespace ui

#endif // CLIENT_QT_UI_EDITORWIDGET_H
