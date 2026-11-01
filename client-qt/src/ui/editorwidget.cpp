#include "ui/editorwidget.h"

#include "editor/editorroles.h"     // classifyLines, colorForRole, shouldRecolor, COLORS
#include "editor/editorshortcuts.h" // insertEndMarker, insertContinueMarker, deleteLineAt, transformTextLine

#include <QClipboard>
#include <QColor>
#include <QDragEnterEvent>
#include <QDragMoveEvent>
#include <QDropEvent>
#include <QFocusEvent>
#include <QGuiApplication>
#include <QInputMethod>
#include <QInputMethodEvent>
#include <QKeyEvent>
#include <QKeySequence>
#include <QLatin1Char>
#include <QMetaObject>
#include <QMimeData>
#include <QMouseEvent>
#include <QStringList>
#include <QSyntaxHighlighter>
#include <QTextBlock>
#include <QTextCharFormat>
#include <QTextCursor>
#include <QTextDocument>
#include <QTextLayout>

#include <algorithm>
#include <utility>

namespace ui {

// The role colours as style runs - one colour per text line, recomputed only by EditorWidget::recolor (shouldRecolor's
// triggers, never while composing). Qt re-runs highlightBlock by itself whenever a block changes, a preedit included
// (measured: a preedit event reports its block as changed), and then re-applies the colour last computed for that
// line: an edit alone does not recolour (the web's echo path) and a composition sees no colour change. Qt keeps these
// formats around the preedit's own (measured).
class RoleHighlighter : public QSyntaxHighlighter
{
public:
    explicit RoleHighlighter(QTextDocument *document) : QSyntaxHighlighter(document) {}

    void setColours(QVector<QColor> colours) { m_colours = std::move(colours); }

protected:
    void highlightBlock(const QString &text) override
    {
        const int line = currentBlock().blockNumber();
        QTextCharFormat format;
        format.setForeground(line >= 0 && line < m_colours.size() ? m_colours.at(line) : editor::COLORS.body);
        setFormat(0, int(text.size()), format);
    }

private:
    QVector<QColor> m_colours;
};

namespace {

// While one is alive, a document change is the widget's own (expected); any other is put back.
class ScopedCount
{
public:
    explicit ScopedCount(int &count) : m_count(count) { ++m_count; }
    ~ScopedCount() { --m_count; }
    ScopedCount(const ScopedCount &) = delete;
    ScopedCount &operator=(const ScopedCount &) = delete;

private:
    int &m_count;
};

bool holdsBlockBreak(const QString &text)
{
    for (const QChar c : text) {
        if (editor::isBlockBreakChar(c))
            return true;
    }
    return false;
}

} // namespace

EditorWidget::EditorWidget(QWidget *parent) : QPlainTextEdit(parent)
{
    document()->setUndoRedoEnabled(false);   // the step6 snapshot history is the only undo
    setOverwriteMode(false);                 // the Insert-key overwrite is the widget's (shouldOverwriteNextChar)
    setTabChangesFocus(true);                // the web's Tab leaves the editor - it never types
    setContextMenuPolicy(Qt::NoContextMenu); // the editor's context menu (14 actions) is P7
    setAcceptDrops(false);                   // drops of image files are P6's embeds; nothing else is dropped
    viewport()->setAcceptDrops(false);
    m_highlighter = new RoleHighlighter(document());
    connect(document(), &QTextDocument::contentsChange, this, [this](int, int, int) {
        if (m_guard > 0 || m_restoreQueued)
            return;
        // A change none of the widget's paths made (QPlainTextEdit's own API, assistive technology, a drag that
        // moved text out): put the document back from the blocks - after this signal, never inside it.
        m_restoreQueued = true;
        QMetaObject::invokeMethod(this, [this] { restoreIfPending(); }, Qt::QueuedConnection);
    });
    connect(this, &QPlainTextEdit::cursorPositionChanged, this, [] {
        // The caret may have entered or left the blocked region: let the platform input method ask ImEnabled again.
        if (QInputMethod *im = QGuiApplication::inputMethod())
            im->update(Qt::ImEnabled);
    });
    m_shown = documentText();
}

EditorWidget::~EditorWidget()
{
    disconnect(document(), nullptr, this, nullptr);
}

// --- the body ------------------------------------------------------------------------------------------------------

void EditorWidget::setBlocks(const QVector<editor::Block> &blocks)
{
    if (m_composing || preeditActive()) {
        if (QInputMethod *im = QGuiApplication::inputMethod())
            im->reset();
        QInputMethodEvent clear; // the preedit the document is showing goes - the body is replaced under it
        {
            ScopedCount guard(m_guard);
            QPlainTextEdit::inputMethodEvent(&clear);
        }
        m_composing = false;
        m_typingPending = false;
    }
    m_restoreQueued = false;
    const bool fresh = documentText().isEmpty();
    m_blocks = editor::normalizeBlocks(blocks);
    showText(shownText());
    if (fresh)
        setTextCursor(QTextCursor(document()));
    recolor(QStringLiteral("load"));
}

QVector<editor::Block> EditorWidget::blocks() const
{
    return m_blocks;
}

editor::TextPoint EditorWidget::caret() const
{
    return pointAt(textCursor().position());
}

editor::TextRange EditorWidget::selectionRange() const
{
    const QTextCursor c = textCursor();
    return editor::TextRange{pointAt(c.selectionStart()), pointAt(c.selectionEnd())};
}

void EditorWidget::focusLineStart(int lineIndex)
{
    const int line = std::clamp(lineIndex, 0, document()->blockCount() - 1);
    setTextCursor(QTextCursor(document()->findBlockByNumber(line)));
    setFocus();
}

bool EditorWidget::transformCaretLine(const std::function<QString(const QString &)> &fn)
{
    restoreIfPending();
    if (isReadOnly() || m_composing || !fn)
        return false;
    const int line = textCursor().blockNumber();
    if (line >= textLineCount())
        return false;
    const QTextBlock block = document()->findBlockByNumber(line);
    if (editor::isInputBlocked(realText(), block.position() + int(block.text().size())))
        return false; // the line reaches the last "(끝)": nothing at or after it changes
    return applyBlocks(editor::transformTextLine(m_blocks, line, fn), editor::EditKind::Operation, CaretAfter::Keep);
}

bool EditorWidget::isComposing() const
{
    return m_composing;
}

bool EditorWidget::overwriting() const
{
    return m_overwrite;
}

int EditorWidget::recolorCount() const
{
    return m_recolorCount;
}

QVariant EditorWidget::inputMethodQuery(Qt::InputMethodQuery query) const
{
    if (query == Qt::ImEnabled && !isReadOnly() && !m_composing && insertionBlocked())
        return QVariant(false); // no composition starts where input is blocked (the spike's Qt-only gate)
    return QPlainTextEdit::inputMethodQuery(query);
}

// --- reading the state ---------------------------------------------------------------------------------------------

QString EditorWidget::realText() const
{
    return editor::blocksToText(m_blocks);
}

int EditorWidget::textLineCount() const
{
    int count = 0;
    for (const editor::Block &b : m_blocks) {
        if (editor::isTextBlock(b))
            ++count;
    }
    return count;
}

QString EditorWidget::realLine(int textLine) const
{
    const int index = editor::textLineToBlockIndex(m_blocks, textLine);
    return index < 0 ? QString() : m_blocks.at(index).text;
}

QString EditorWidget::documentText() const
{
    QString out;
    for (QTextBlock b = document()->begin(); b.isValid(); b = b.next()) {
        if (b != document()->begin())
            out += QLatin1Char('\n');
        out += b.text(); // raw - never toPlainText(), which turns NBSP into a space and U+2028 into '\n'
    }
    return out;
}

QString EditorWidget::shownText() const
{
    QStringList shown;
    for (const editor::Block &b : m_blocks) {
        if (editor::isTextBlock(b))
            shown << editor::displayLine(b.text);
    }
    return shown.join(QLatin1Char('\n'));
}

editor::TextPoint EditorWidget::pointAt(int position) const
{
    QTextBlock block = document()->findBlock(position);
    if (!block.isValid())
        block = document()->lastBlock();
    return editor::TextPoint{block.blockNumber(), position};
}

int EditorWidget::insertionPoint() const
{
    return textCursor().selectionStart();
}

bool EditorWidget::insertionBlocked() const
{
    return editor::isInputBlocked(realText(), insertionPoint());
}

bool EditorWidget::selectionSpansLines() const
{
    const QTextCursor c = textCursor();
    return c.hasSelection() && document()->findBlock(c.selectionStart()) != document()->findBlock(c.selectionEnd());
}

bool EditorWidget::preeditActive() const
{
    const QTextBlock block = textCursor().block();
    return block.isValid() && block.layout() && !block.layout()->preeditAreaText().isEmpty();
}

// --- writing the document ------------------------------------------------------------------------------------------

void EditorWidget::restoreIfPending()
{
    if (!m_restoreQueued)
        return;
    m_restoreQueued = false;
    if (documentText() != m_shown)
        restoreDocument();
}

void EditorWidget::restoreDocument()
{
    showText(shownText());
}

// The document becomes `target` through one minimal edit (the common prefix and suffix stay), so the caret and the
// scroll position survive where the text did not change. Returns the end of the changed region in the new text.
int EditorWidget::showText(const QString &target)
{
    const QString current = documentText();
    const qsizetype nc = current.size();
    const qsizetype nt = target.size();
    qsizetype p = 0;
    const qsizetype maxP = std::min(nc, nt);
    while (p < maxP && current.at(p) == target.at(p))
        ++p;
    qsizetype s = 0;
    const qsizetype maxS = std::min(nc - p, nt - p);
    while (s < maxS && current.at(nc - 1 - s) == target.at(nt - 1 - s))
        ++s;
    const QString inserted = target.mid(p, nt - s - p);
    {
        ScopedCount guard(m_guard);
        QTextCursor edit(document());
        edit.setPosition(int(p));
        edit.setPosition(int(nc - s), QTextCursor::KeepAnchor);
        if (edit.hasSelection())
            edit.removeSelectedText();
        if (!inserted.isEmpty())
            edit.insertText(inserted); // '\n' is the only block break a shown text holds
        if (documentText() != target)
            document()->setPlainText(target); // never expected - the shown text maps 1:1 onto blocks
    }
    m_shown = target;
    return int(p + inserted.size());
}

bool EditorWidget::applyBlocks(const QVector<editor::Block> &next, editor::EditKind kind, CaretAfter caret, int caretLine)
{
    const QVector<editor::Block> normalized = editor::normalizeBlocks(next);
    if (normalized == m_blocks)
        return false;
    m_blocks = normalized;
    const int editEnd = showText(shownText());
    if (caret == CaretAfter::EditEnd) {
        QTextCursor c = textCursor();
        c.setPosition(std::clamp(editEnd, 0, document()->characterCount() - 1));
        setTextCursor(c);
    } else if (caret == CaretAfter::LineStart) {
        const int line = std::clamp(caretLine, 0, document()->blockCount() - 1);
        setTextCursor(QTextCursor(document()->findBlockByNumber(line)));
    }
    recolor(QStringLiteral("load")); // a structural edit re-renders, as the web's remount does
    emitEdited(kind);
    return true;
}

// Qt edits the document itself (typing, an IME commit, a character or a word deleted inside one line). The edit is
// then located from the cursor it started at, validated - no line break made or removed, nothing inserted where the
// marker gate refuses - and mirrored into the blocks; anything else puts the document back.
template <typename Call>
bool EditorWidget::runNative(Call &&call, bool backward)
{
    const QTextCursor before = textCursor();
    const int selStart = before.selectionStart();
    const int selEnd = before.selectionEnd();
    {
        ScopedCount guard(m_guard);
        call();
    }
    const QString after = documentText();
    if (after == m_shown)
        return false;
    const std::optional<editor::TextEdit> edit = editor::nativeEditBetween(m_shown, after, selStart, selEnd, backward);
    if (!edit || !acceptNativeEdit(*edit)) {
        restoreDocument();
        return false;
    }
    m_shown = after;
    emitEdited(editor::EditKind::Typing);
    return true;
}

bool EditorWidget::acceptNativeEdit(const editor::TextEdit &edit)
{
    if (isReadOnly())
        return false; // no native edit is legitimate in read-only (the IME path above proved Qt can make one)
    if (m_shown.mid(edit.start, edit.removed).contains(QLatin1Char('\n')) || edit.inserted.contains(QLatin1Char('\n')))
        return false; // a line made or removed natively - only the widget's own paths change the line structure
    if (!edit.inserted.isEmpty() && editor::isInputBlocked(realText(), edit.start))
        return false; // the marker gate, at the point the text went in
    const int line = int(m_shown.left(edit.start).count(QLatin1Char('\n')));
    const int lineStart = edit.start == 0 ? 0 : int(m_shown.lastIndexOf(QLatin1Char('\n'), edit.start - 1)) + 1;
    int index = editor::textLineToBlockIndex(m_blocks, line);
    if (index < 0) {
        if (line != 0 || textLineCount() != 0)
            return false;
        m_blocks.append(editor::textBlock()); // the first text line of an empty body - after every block (rule 1-b)
        index = int(m_blocks.size()) - 1;
    }
    QString &text = m_blocks[index].text;
    const int column = edit.start - lineStart;
    text = text.left(column) + edit.inserted + text.mid(column + edit.removed);
    return true;
}

void EditorWidget::emitEdited(editor::EditKind kind)
{
    if (m_composing) {
        m_typingPending = true; // reported once, when the composition ends (the web's compositionend commit)
        return;
    }
    emit edited(kind);
}

bool EditorWidget::recolor(const QString &trigger)
{
    if (!editor::shouldRecolor(trigger, m_composing))
        return false;
    QStringList textLines;
    for (const editor::Block &b : m_blocks) {
        if (editor::isTextBlock(b))
            textLines << b.text;
    }
    QVector<QColor> colours;
    for (const editor::Role role : editor::classifyLines(textLines))
        colours << editor::colorForRole(role);
    m_highlighter->setColours(std::move(colours));
    {
        ScopedCount guard(m_guard);
        m_highlighter->rehighlight();
    }
    ++m_recolorCount;
    return true;
}

void EditorWidget::updateComposing()
{
    const bool was = m_composing;
    m_composing = preeditActive();
    if (was && !m_composing) {
        recolor(QStringLiteral("compositionend"));
        if (m_typingPending) {
            m_typingPending = false;
            emit edited(editor::EditKind::Typing);
        }
    }
}

// --- the edit paths ------------------------------------------------------------------------------------------------

bool EditorWidget::replaceRange(const editor::TextRange &range, const QString &text, editor::EditKind kind)
{
    const int at = std::min(range.start ? range.start->offset : 0, range.end ? range.end->offset : 0);
    if (!text.isEmpty() && editor::isInputBlocked(realText(), at))
        return false; // the marker gate; a deletion is never refused here - replaceRangeInBlocks clamps it
    const editor::InsertResult result = editor::replaceRangeInBlocks(m_blocks, range, text);
    return applyBlocks(result.blocks, kind, CaretAfter::EditEnd);
}

bool EditorWidget::replaceSelection(const QString &text, editor::EditKind kind)
{
    return replaceRange(selectionRange(), text, kind);
}

void EditorWidget::deleteSelection()
{
    if (!textCursor().hasSelection())
        return;
    if (selectionSpansLines()) {
        replaceSelection(QString(), editor::EditKind::Typing); // the marker clamp - never "본(끝)"
        return;
    }
    runNative(
        [this] {
            QTextCursor c = textCursor();
            c.removeSelectedText();
            setTextCursor(c);
        },
        false);
}

void EditorWidget::cutSelection()
{
    QGuiApplication::clipboard()->setMimeData(createMimeDataFromSelection());
    deleteSelection();
}

void EditorWidget::deleteLine(int textLine)
{
    const int index = editor::textLineToBlockIndex(m_blocks, textLine);
    if (index < 0)
        return;
    applyBlocks(editor::deleteLineAt(m_blocks, index).blocks, editor::EditKind::Operation, CaretAfter::LineStart, textLine);
}

void EditorWidget::deleteKey(QKeyEvent *e, bool backward)
{
    if (textCursor().hasSelection()) {
        deleteSelection();
        return;
    }
    const QTextCursor c = textCursor();
    const int line = c.blockNumber();
    if (line < textLineCount() && realLine(line).isEmpty()) {
        deleteLine(line); // the web: Backspace / Delete on an empty line delete it, whatever the modifiers
        return;
    }
    const int column = c.positionInBlock();
    if (backward ? column == 0 : column == int(c.block().text().size())) {
        // A line join - pre-decision 1: never one that glues a marker line to other text.
        const int upper = backward ? line - 1 : line;
        if (upper < 0 || upper + 1 >= textLineCount())
            return;
        if (editor::isLineMergeBlocked(realLine(upper), realLine(upper + 1)))
            return;
        const int joinAt = document()->findBlockByNumber(upper).position() + int(realLine(upper).size());
        if (applyBlocks(editor::joinTextLines(m_blocks, upper), editor::EditKind::Typing, CaretAfter::Keep)) {
            QTextCursor at = textCursor();
            at.setPosition(joinAt);
            setTextCursor(at);
        }
        return;
    }
    if (e->modifiers().testFlag(Qt::ControlModifier)) {
        // Qt's word delete moves PreviousWord / NextWord; where that leaves the line it is a multi-line delete.
        QTextCursor probe = c;
        probe.movePosition(backward ? QTextCursor::PreviousWord : QTextCursor::NextWord, QTextCursor::KeepAnchor);
        if (document()->findBlock(probe.selectionStart()) != document()->findBlock(probe.selectionEnd())) {
            replaceRange(editor::TextRange{pointAt(probe.selectionStart()), pointAt(probe.selectionEnd())}, QString(),
                         editor::EditKind::Typing);
            return;
        }
    }
    runNative([&] { QPlainTextEdit::keyPressEvent(e); }, backward);
}

void EditorWidget::typeKey(QKeyEvent *e)
{
    if (insertionBlocked())
        return; // the marker gate
    const QString text = e->text();
    if (holdsBlockBreak(text) || selectionSpansLines()) {
        replaceSelection(text, editor::EditKind::Typing);
        return;
    }
    if (m_overwrite && !textCursor().hasSelection() && text.size() == 1) {
        const QString real = realText();
        QTextCursor c = textCursor();
        if (editor::shouldOverwriteNextChar(real, c.position())) {
            c.setPosition(c.position() + editor::overwriteExtendLength(real, c.position()), QTextCursor::KeepAnchor);
            setTextCursor(c);
        }
    }
    runNative([&] { QPlainTextEdit::keyPressEvent(e); }, false);
}

void EditorWidget::triggerShortcut(editor::Shortcut shortcut)
{
    if (isReadOnly())
        return; // consumed - nothing performed, nothing reported
    switch (shortcut) {
    case editor::Shortcut::ToggleOverwrite:
        m_overwrite = !m_overwrite;
        break;
    case editor::Shortcut::InsertEndMarker:
        applyBlocks(editor::insertEndMarker(m_blocks).blocks, editor::EditKind::Operation, CaretAfter::Keep);
        break;
    case editor::Shortcut::InsertContinueMarker: {
        const editor::ContinueMarkerInsertion r = editor::insertContinueMarker(m_blocks, textCursor().blockNumber());
        applyBlocks(r.blocks, editor::EditKind::Operation, CaretAfter::LineStart, r.caretTextLine);
        break;
    }
    case editor::Shortcut::DeleteLine:
        deleteLine(textCursor().blockNumber());
        break;
    case editor::Shortcut::CompanyCode:   // P6
    case editor::Shortcut::FindReplace:   // P6
    case editor::Shortcut::GlyphInput:    // P6
    case editor::Shortcut::PasteOriginal: // P6
    case editor::Shortcut::Undo:          // the state machine's history (step9)
    case editor::Shortcut::Redo:
        break;
    }
    emit shortcutTriggered(shortcut);
}

// --- events --------------------------------------------------------------------------------------------------------

void EditorWidget::keyPressEvent(QKeyEvent *e)
{
    restoreIfPending();
    const int key = e->key();
    const Qt::KeyboardModifiers mods = e->modifiers();
    // The web never types on an Alt combination (Qt does - measured: Alt+Q types "q"); AltGr is Ctrl+Alt and types.
    const bool altLetter = mods.testFlag(Qt::AltModifier) && !mods.testFlag(Qt::ControlModifier) && key >= Qt::Key_A
                           && key <= Qt::Key_Z;
    if (m_composing) {
        // decisions (4): nothing is intercepted while a composition is in progress - Qt and the IME have the key.
        if (altLetter) {
            e->ignore();
            return;
        }
        runNative([&] { QPlainTextEdit::keyPressEvent(e); }, false);
        updateComposing();
        return;
    }
    if (const std::optional<editor::Shortcut> shortcut =
            editor::shortcutFor(editor::keyInputFromQt(key, mods, e->nativeScanCode()))) {
        e->accept();
        triggerShortcut(*shortcut);
        return;
    }
    if (altLetter || key == Qt::Key_Tab || key == Qt::Key_Backtab) {
        e->ignore(); // never types (the web's Tab leaves the editor)
        return;
    }
    if (isReadOnly()) {
        runNative([&] { QPlainTextEdit::keyPressEvent(e); }, false); // navigation and copy - Qt refuses edits
        return;
    }
    if (key == Qt::Key_Return || key == Qt::Key_Enter) {
        e->accept(); // any modifiers - never Qt's block break, never its Shift+Enter U+2028
        replaceSelection(QStringLiteral("\n"), editor::EditKind::Typing);
        return;
    }
    if (e->matches(QKeySequence::Undo) || e->matches(QKeySequence::Redo)) {
        e->accept(); // Qt's other undo keys (Alt+Backspace): there is no undo but the history's
        return;
    }
    if (e->matches(QKeySequence::Cut)) {
        e->accept();
        if (textCursor().hasSelection())
            cutSelection();
        else if (key == Qt::Key_Delete)
            deleteKey(e, false); // Shift+Delete without a selection is a Delete (the web reads e.key)
        return;
    }
    if (key == Qt::Key_Backspace || key == Qt::Key_Delete) {
        e->accept();
        deleteKey(e, key == Qt::Key_Backspace);
        return;
    }
    if (editor::insertsText(mods, e->text())) {
        e->accept();
        typeKey(e);
        return;
    }
    runNative([&] { QPlainTextEdit::keyPressEvent(e); }, false); // navigation, copy, select all, paste (-> mime)
}

void EditorWidget::inputMethodEvent(QInputMethodEvent *e)
{
    restoreIfPending();
    if (isReadOnly()) {
        // Measured: a read-only QPlainTextEdit still types a delivered commit (Qt only counts on the platform not
        // sending one - WA_InputMethodEnabled is off). Read-only takes no input-method text at all.
        e->accept();
        return;
    }
    const QString commitText = e->commitString();
    const bool replaces = e->replacementLength() > 0 || (e->replacementStart() != 0 && !commitText.isEmpty());
    const bool hasContent = !e->preeditString().isEmpty() || !commitText.isEmpty() || replaces;
    if (!hasContent && !m_composing) {
        runNative([&] { QPlainTextEdit::inputMethodEvent(e); }, false); // attributes only
        return;
    }
    if (!m_composing && hasContent && insertionBlocked()) {
        e->accept(); // the composition never starts where input is blocked (Qt::ImEnabled is false there already)
        return;
    }
    const bool routed = (!commitText.isEmpty() || replaces) && (replaces || holdsBlockBreak(commitText) || selectionSpansLines());
    if (routed) {
        // A commit Qt would type as several lines, replace text around the caret with, or type over a multi-line
        // selection: through the gate and replaceRangeInBlocks; the rest of the event (the preedit) goes on to Qt.
        const QTextCursor c = textCursor();
        editor::TextRange range = selectionRange();
        if (replaces) {
            const int last = document()->characterCount() - 1;
            const int from = std::clamp(c.position() + e->replacementStart(), 0, last);
            const int to = std::clamp(from + e->replacementLength(), from, last);
            range = editor::TextRange{pointAt(from), pointAt(to)};
        }
        replaceRange(range, commitText, editor::EditKind::Typing);
        QInputMethodEvent rest(e->preeditString(), e->attributes());
        runNative([&] { QPlainTextEdit::inputMethodEvent(&rest); }, false);
    } else {
        if (selectionSpansLines() && !e->preeditString().isEmpty())
            deleteSelection(); // Qt would remove it natively as the composition starts - through the clamp instead
        runNative([&] { QPlainTextEdit::inputMethodEvent(e); }, false);
    }
    e->accept();
    updateComposing();
}

void EditorWidget::insertFromMimeData(const QMimeData *source)
{
    restoreIfPending();
    if (isReadOnly() || !source || !source->hasText())
        return; // only text in P5 - an image is P6's embed
    const QString text = source->text();
    if (text.isEmpty())
        return;
    replaceSelection(text, editor::EditKind::Typing); // isInputBlocked, then replaceRangeInBlocks - one line or many
}

QMimeData *EditorWidget::createMimeDataFromSelection() const
{
    // The real text of the selection: a CR shown as a space is a CR here, and the offsets map 1:1 - never
    // QTextCursor::selectedText() (U+2029 between blocks) or toPlainText() (NBSP becomes a space).
    const QTextCursor c = textCursor();
    auto *mime = new QMimeData;
    mime->setText(realText().mid(c.selectionStart(), c.selectionEnd() - c.selectionStart()));
    return mime;
}

void EditorWidget::focusOutEvent(QFocusEvent *e)
{
    runNative([&] { QPlainTextEdit::focusOutEvent(e); }, false);
    updateComposing();
    recolor(QStringLiteral("blur"));
}

void EditorWidget::mousePressEvent(QMouseEvent *e)
{
    restoreIfPending();
    if (e->button() == Qt::LeftButton && !e->modifiers().testFlag(Qt::ShiftModifier)) {
        QTextCursor c = textCursor();
        if (c.hasSelection()) {
            const int hit = cursorForPosition(e->position().toPoint()).position();
            if (hit >= c.selectionStart() && hit <= c.selectionEnd()) {
                c.clearSelection(); // a press inside the selection would arm a text drag - P5 has none
                setTextCursor(c);
            }
        }
    }
    runNative([&] { QPlainTextEdit::mousePressEvent(e); }, false);
    updateComposing();
}

void EditorWidget::dragEnterEvent(QDragEnterEvent *e)
{
    e->ignore();
}

void EditorWidget::dragMoveEvent(QDragMoveEvent *e)
{
    e->ignore();
}

void EditorWidget::dropEvent(QDropEvent *e)
{
    e->ignore();
}

} // namespace ui
