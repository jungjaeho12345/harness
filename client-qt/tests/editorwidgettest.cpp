#include "editorwidgettest.h"

#include "editor/editorcaret.h"
#include "editor/editorcontent.h"
#include "editor/editorinput.h"
#include "editor/editornewline.h"
#include "editor/editorroles.h"
#include "editor/editorshortcuts.h"
#include "ui/editorwidget.h"

#include <QApplication>
#include <QClipboard>
#include <QCoreApplication>
#include <QDragEnterEvent>
#include <QDropEvent>
#include <QFocusEvent>
#include <QInputMethodEvent>
#include <QKeyEvent>
#include <QMimeData>
#include <QString>
#include <QStringList>
#include <QTextBlock>
#include <QTextCursor>
#include <QTextDocument>
#include <QTextLayout>
#include <QVector>
#include <QtTest>

#include <optional>

using editor::Block;
using editor::EditKind;
using editor::Shortcut;
using editor::TextPoint;
using editor::TextRange;
using ui::EditorWidget;

namespace {

// The spike's 7-line sample (spikes/p0-qt-editor/selftest.cpp sample7): 0 title, 1..4 subtitle, 5 body, 6 "(끝)".
const QString SAMPLE = QStringLiteral("제목 줄\n부제1\n부제2\n부제3\n부제4\n본문 첫 줄입니다.\n(끝)");

Block text(const QString &t, const QString &align = QString())
{
    return editor::textBlock(t, align);
}

QVector<Block> lines(const QStringList &ls)
{
    QVector<Block> out;
    for (const QString &l : ls)
        out.append(text(l));
    return out;
}

editor::JsonValue object(std::initializer_list<std::pair<QString, editor::JsonValue>> members)
{
    editor::JsonValue out = editor::JsonValue::makeObject();
    for (const auto &member : members)
        out.insert(member.first, member.second);
    return out;
}

Block image(const QString &src)
{
    return editor::embedBlock(object({{QStringLiteral("embedType"), editor::JsonValue::makeString(QStringLiteral("image"))},
                                      {QStringLiteral("src"), editor::JsonValue::makeString(src)}}));
}

QString bytes(const QVector<Block> &b)
{
    return editor::serialize(b);
}

QString real(const EditorWidget &w)
{
    return editor::blocksToText(w.blocks());
}

QString shown(const EditorWidget &w)
{
    QString out;
    for (QTextBlock b = w.document()->begin(); b.isValid(); b = b.next()) {
        if (b != w.document()->begin())
            out += QLatin1Char('\n');
        out += b.text();
    }
    return out;
}

QString displayed(const QVector<Block> &blocks)
{
    QStringList out;
    for (const Block &b : blocks) {
        if (editor::isTextBlock(b))
            out << editor::displayLine(b.text);
    }
    return out.join(QLatin1Char('\n'));
}

void caretTo(EditorWidget &w, int pos)
{
    QTextCursor c = w.textCursor();
    c.setPosition(pos);
    w.setTextCursor(c);
}

void select(EditorWidget &w, int anchor, int position)
{
    QTextCursor c = w.textCursor();
    c.setPosition(anchor);
    c.setPosition(position, QTextCursor::KeepAnchor);
    w.setTextCursor(c);
}

// A point of a well-formed body (no line break inside a block): the text line the offset sits on.
TextPoint pointIn(const QVector<Block> &b, int offset)
{
    return TextPoint{editor::lineAtOffset(editor::blocksToText(b), offset).lineIndex, offset};
}

TextRange rangeIn(const QVector<Block> &b, int from, int to)
{
    return TextRange{pointIn(b, from), pointIn(b, to)};
}

void preedit(EditorWidget &w, const QString &p)
{
    QInputMethodEvent e(p, {});
    QApplication::sendEvent(&w, &e);
}

void commit(EditorWidget &w, const QString &c, const QString &p = QString())
{
    QInputMethodEvent e(p, {});
    e.setCommitString(c);
    QApplication::sendEvent(&w, &e);
}

// A key press shaped like the windows platform plugin's (measured - scan code, text) rather than QTest's synthetic one.
void windowsKey(EditorWidget &w, int key, Qt::KeyboardModifiers mods, quint32 scan, const QString &txt = QString())
{
    QKeyEvent press(QEvent::KeyPress, key, mods, scan, 0, 0, txt);
    QApplication::sendEvent(&w, &press);
}

void focusOut(EditorWidget &w)
{
    QFocusEvent out(QEvent::FocusOut, Qt::OtherFocusReason);
    QApplication::sendEvent(&w, &out);
}

// The colour the highlighter put on a block (its format range from 0) - the layout's formats, not a cache.
QColor applied(const QTextBlock &b)
{
    const auto ranges = b.layout()->formats();
    for (const auto &r : ranges) {
        if (r.start == 0 && r.length > 0 && r.format.hasProperty(QTextFormat::ForegroundBrush))
            return r.format.foreground().color();
    }
    return QColor();
}

QColor lineColour(const EditorWidget &w, int line)
{
    return applied(w.document()->findBlockByNumber(line));
}

struct Recorder {
    QObject context;
    QVector<EditKind> edits;
    QVector<Shortcut> shortcuts;
    explicit Recorder(EditorWidget &w)
    {
        QObject::connect(&w, &EditorWidget::edited, &context, [this](EditKind k) { edits.append(k); });
        QObject::connect(&w, &EditorWidget::shortcutTriggered, &context, [this](Shortcut s) { shortcuts.append(s); });
    }
    void clear()
    {
        edits.clear();
        shortcuts.clear();
    }
};

bool lastIsMarkerLine(const QVector<Block> &b)
{
    return !b.isEmpty() && editor::isMarkerBlock(b.last());
}

} // namespace

// One document block per text line - CR, U+2029, the non-characters and a malformed line break inside a block are
// shown with a stand-in (displayLine) so lines and offsets map 1:1; embeds are carried, not shown; no text line at all
// is one empty document block that holds no line.
void EditorWidgetTest::rendersOneDocumentBlockPerTextLine()
{
    EditorWidget w;
    const Block e = image(QStringLiteral("x.png"));
    const QVector<Block> b{text(QStringLiteral("본문\r")),
                           e,
                           text(QStringLiteral("a") + QChar(0x2029) + QStringLiteral("b")),
                           text(QStringLiteral("c\nd")),
                           text(QString(QChar(0xFDD0))),
                           text(QString(QChar(0x00A0)) + QChar(0x2028), QStringLiteral("center")),
                           text(QStringLiteral("(끝)"))};
    w.setBlocks(b);
    QCOMPARE(w.document()->blockCount(), 6);
    QCOMPARE(shown(w), displayed(b));
    QCOMPARE(bytes(w.blocks()), bytes(b));
    QCOMPARE(w.document()->characterCount() - 1, int(editor::blocksToText(b).size()));
    QCOMPARE(w.recolorCount(), 1); // "load"

    w.setBlocks({});
    QCOMPARE(w.document()->blockCount(), 1);
    QVERIFY(w.blocks().isEmpty());
    QCOMPARE(shown(w), QString());
    w.setBlocks({e});
    QCOMPARE(bytes(w.blocks()), bytes({e}));
    QCOMPARE(w.document()->blockCount(), 1);
}

// The style runs are the role colours: classifyLines + colorForRole per line, which is colorLines' colour too.
void EditorWidgetTest::styleRunsMatchTheRoleColours()
{
    const QStringList samples{SAMPLE,
                              QStringLiteral("제목 줄\n부제1\n\n셋째 줄\n(끝)"),
                              QStringLiteral("a\n  (끝)  \nb\nc\nd\ne\nf"),
                              QStringLiteral("단 한 줄")};
    for (const QString &sample : samples) {
        EditorWidget w;
        w.setBlocks(editor::textToBlocks(sample));
        const QStringList ls = sample.split(QLatin1Char('\n'));
        const QVector<editor::Role> roles = editor::classifyLines(ls);
        const QVector<editor::ColoredLine> coloured = editor::colorLines(sample);
        QCOMPARE(w.document()->blockCount(), int(ls.size()));
        for (int i = 0; i < ls.size(); ++i) {
            if (ls.at(i).isEmpty())
                continue; // an empty line has nothing to colour
            const QColor got = lineColour(w, i);
            QVERIFY2(got == editor::colorForRole(roles.at(i)), qPrintable(QStringLiteral("line %1 of %2").arg(i).arg(sample)));
            QCOMPARE(got, coloured.at(i).color);
        }
    }
    EditorWidget w;
    w.setBlocks(editor::textToBlocks(SAMPLE));
    QCOMPARE(lineColour(w, 0), editor::COLORS.title);
    QCOMPARE(lineColour(w, 1), editor::COLORS.subtitle);
    QCOMPARE(lineColour(w, 4), editor::COLORS.subtitle);
    QCOMPARE(lineColour(w, 5), editor::COLORS.body);
    QCOMPARE(lineColour(w, 6), editor::COLORS.end);
}

// Recolouring is shouldRecolor's: "load" (setBlocks and every structural edit - the web's remount), "blur",
// "compositionend". Plain typing is the web's echo path: the runs stay as they were.
void EditorWidgetTest::recolorsOnTheTriggersOnly()
{
    EditorWidget w;
    w.setBlocks(editor::textToBlocks(QStringLiteral("제목\n\n부제\n본문\n(끝)"))); // blank at 1: no subtitle region
    const int c0 = w.recolorCount();
    QCOMPARE(c0, 1);
    QCOMPARE(lineColour(w, 2), editor::COLORS.body);
    caretTo(w, 3); // the empty line 1
    QTest::keyClicks(&w, QStringLiteral("x"));
    QCOMPARE(real(w), QStringLiteral("제목\nx\n부제\n본문\n(끝)"));
    QCOMPARE(w.recolorCount(), c0);
    QCOMPARE(lineColour(w, 2), editor::COLORS.body); // the old run, as the web's echo keeps it
    focusOut(w);
    QCOMPARE(w.recolorCount(), c0 + 1);
    QCOMPARE(lineColour(w, 2), editor::COLORS.subtitle);
    caretTo(w, 9); // the end of "부제"
    QTest::keyClick(&w, Qt::Key_Return);
    QCOMPARE(w.recolorCount(), c0 + 2);
    QCOMPARE(lineColour(w, 4), editor::COLORS.subtitle); // "본문" moved to line 4, inside the subtitle region
}

// decisions (4): no recolour while a composition is in progress - not on blur, not on anything; the colours stay
// (Qt keeps the highlighter's run around the preedit - measured) and one recolour follows the composition's end.
void EditorWidgetTest::neverRecolorsWhileComposing()
{
    EditorWidget w;
    w.setBlocks(editor::textToBlocks(SAMPLE));
    const int c0 = w.recolorCount();
    const int insertPos = w.document()->findBlockByNumber(5).position() + 2;
    caretTo(w, insertPos);
    preedit(w, QStringLiteral("ㅎ"));
    QVERIFY(w.isComposing());
    focusOut(w);
    QVERIFY(w.isComposing()); // a focus-out event alone does not end the composition
    QCOMPARE(w.recolorCount(), c0);
    preedit(w, QStringLiteral("하"));
    QCOMPARE(w.recolorCount(), c0);
    QCOMPARE(lineColour(w, 5), editor::COLORS.body);
    QCOMPARE(lineColour(w, 0), editor::COLORS.title);
    commit(w, QStringLiteral("한"));
    QVERIFY(!w.isComposing());
    QCOMPARE(w.recolorCount(), c0 + 1);
}

// Typing asks isInputBlocked at the insertion point: at / after the last "(끝)" nothing changes, before it Qt types.
void EditorWidgetTest::typingIsGatedAtTheMarker()
{
    const QVector<Block> b = editor::textToBlocks(SAMPLE);
    const int ms = int(SAMPLE.lastIndexOf(editor::END_MARKER));
    for (int pos : {ms, ms + 1, ms + 2, ms + 3}) {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, pos);
        QTest::keyClicks(&w, QStringLiteral("abc"));
        QVERIFY2(real(w) == SAMPLE, qPrintable(QStringLiteral("typed at %1").arg(pos)));
        QCOMPARE(shown(w), displayed(b));
    }
    {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, ms - 1); // the end of the body line
        QTest::keyClicks(&w, QStringLiteral("x"));
        QCOMPARE(real(w), SAMPLE.left(ms - 1) + QStringLiteral("x") + SAMPLE.mid(ms - 1));
    }
    {
        // a single-line selection starting inside the marker is typed over nowhere
        EditorWidget w;
        w.setBlocks(b);
        select(w, ms + 1, ms + 3);
        QTest::keyClicks(&w, QStringLiteral("x"));
        QCOMPARE(real(w), SAMPLE);
    }
    {
        // two markers: between them input is open (lastIndexOf), after the last it is not; a line after it is closed
        const QString two = QStringLiteral("a(끝)b\n(끝)\n꼬리");
        EditorWidget w;
        w.setBlocks(editor::textToBlocks(two));
        caretTo(w, 4);
        QTest::keyClicks(&w, QStringLiteral("x"));
        QCOMPARE(real(w), QStringLiteral("a(끝)xb\n(끝)\n꼬리"));
        caretTo(w, int(real(w).size()));
        QTest::keyClicks(&w, QStringLiteral("y"));
        QCOMPARE(real(w), QStringLiteral("a(끝)xb\n(끝)\n꼬리"));
    }
}

// Enter - whatever the modifiers - is replaceRangeInBlocks(..., "\n") behind isInputBlocked; never Qt's own block
// break and never its Shift+Enter line separator U+2028.
void EditorWidgetTest::enterIsGatedAndGoesThroughReplaceRange()
{
    const QVector<Block> b = editor::textToBlocks(SAMPLE);
    const int ms = int(SAMPLE.lastIndexOf(editor::END_MARKER));
    for (int pos : {ms, int(SAMPLE.size())}) {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, pos);
        QTest::keyClick(&w, Qt::Key_Return);
        QCOMPARE(real(w), SAMPLE);
    }
    const int at = ms - 4;
    const editor::InsertResult expected = editor::replaceRangeInBlocks(b, rangeIn(b, at, at), QStringLiteral("\n"));
    const QList<QPair<int, Qt::KeyboardModifiers>> presses{{Qt::Key_Return, Qt::NoModifier},
                                                           {Qt::Key_Return, Qt::ShiftModifier},
                                                           {Qt::Key_Return, Qt::ControlModifier},
                                                           {Qt::Key_Return, Qt::AltModifier},
                                                           {Qt::Key_Enter, Qt::KeypadModifier}};
    for (const auto &press : presses) {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, at);
        QTest::keyClick(&w, Qt::Key(press.first), press.second);
        QCOMPARE(bytes(w.blocks()), bytes(expected.blocks));
        QVERIFY(!real(w).contains(QChar(0x2028)));
        QCOMPARE(w.document()->blockCount(), 8);
        QCOMPARE(w.caret().lineIndex, expected.caretLineIndex);
        QCOMPARE(w.textCursor().positionInBlock(), 0); // the new line's start
    }
}

// Ctrl+V, Shift+Insert and paste() all end in insertFromMimeData: isInputBlocked, then replaceRangeInBlocks - one
// line or several, over a selection that reaches into the marker line (clamped).
void EditorWidgetTest::pasteIsGatedOnEveryRoute()
{
    const QVector<Block> b = editor::textToBlocks(SAMPLE);
    const int ms = int(SAMPLE.lastIndexOf(editor::END_MARKER));
    const QList<std::function<void(EditorWidget &)>> routes{
        [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_V, Qt::ControlModifier); },
        [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Insert, Qt::ShiftModifier); },
        [](EditorWidget &w) { w.paste(); },
    };
    for (const QString &clip : {QStringLiteral("PASTE"), QStringLiteral("붙여\n넣기")}) {
        QApplication::clipboard()->setText(clip);
        for (int r = 0; r < routes.size(); ++r) {
            for (int pos : {ms, ms + 2, int(SAMPLE.size())}) {
                EditorWidget w;
                w.setBlocks(b);
                caretTo(w, pos);
                routes.at(r)(w);
                QVERIFY2(real(w) == SAMPLE, qPrintable(QStringLiteral("route %1 at %2").arg(r).arg(pos)));
            }
            EditorWidget w;
            w.setBlocks(b);
            caretTo(w, 0);
            routes.at(r)(w);
            QCOMPARE(bytes(w.blocks()), bytes(editor::replaceRangeInBlocks(b, rangeIn(b, 0, 0), clip).blocks));
            // over a selection from the body line into the marker line: the clamp keeps the marker line whole
            EditorWidget s;
            s.setBlocks(b);
            select(s, ms - 3, ms + 2);
            routes.at(r)(s);
            QCOMPARE(bytes(s.blocks()), bytes(editor::replaceRangeInBlocks(b, rangeIn(b, ms - 3, ms + 2), clip).blocks));
            QVERIFY(lastIsMarkerLine(s.blocks()));
        }
    }
}

// The spike's T3, ported: the preedit never enters the document, the caret (the logical cursor) stays, the commit
// lands once; where input is blocked the composition never starts and a commit is refused.
void EditorWidgetTest::imeCommitIsGatedAndThePreeditStaysOutOfTheDocument()
{
    const QVector<Block> b = editor::textToBlocks(SAMPLE);
    {
        EditorWidget w;
        w.setBlocks(b);
        const int insertPos = w.document()->findBlockByNumber(5).position() + 2;
        caretTo(w, insertPos);
        const int c0 = w.recolorCount();
        for (const QString &pre : {QStringLiteral("ㅎ"), QStringLiteral("하"), QStringLiteral("한")}) {
            preedit(w, pre);
            QVERIFY(w.isComposing());
            QCOMPARE(real(w), SAMPLE);
            QCOMPARE(w.textCursor().position(), insertPos);
            QCOMPARE(w.recolorCount(), c0);
        }
        commit(w, QStringLiteral("한"));
        QCOMPARE(real(w), SAMPLE.left(insertPos) + QStringLiteral("한") + SAMPLE.mid(insertPos));
        QCOMPARE(w.textCursor().position(), insertPos + 1);
        QVERIFY(!w.isComposing());
    }
    {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, int(SAMPLE.size()));
        QCOMPARE(w.inputMethodQuery(Qt::ImEnabled).toBool(), false);
        preedit(w, QStringLiteral("ㅎ"));
        QVERIFY(!w.isComposing());
        preedit(w, QStringLiteral("하"));
        commit(w, QStringLiteral("한"));
        QCOMPARE(real(w), SAMPLE);
        caretTo(w, 0);
        QCOMPARE(w.inputMethodQuery(Qt::ImEnabled).toBool(), true);
    }
    {
        // a commit with no composition before it (an emoji panel, a Hanja conversion) at the marker
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, int(SAMPLE.lastIndexOf(editor::END_MARKER)));
        commit(w, QStringLiteral("한"));
        QCOMPARE(real(w), SAMPLE);
    }
}

// A commit Qt would type as more than one line, or one that replaces text around the caret, goes through
// replaceRangeInBlocks behind isInputBlocked; a composition starting over a multi-line selection deletes it through
// replaceRangeInBlocks(..., "") first (Qt would remove it natively).
void EditorWidgetTest::imeCommitsThatCannotGoNativelyAreRouted()
{
    const QVector<Block> b = editor::textToBlocks(SAMPLE);
    const int ms = int(SAMPLE.lastIndexOf(editor::END_MARKER));
    {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 2);
        commit(w, QStringLiteral("가\n나"));
        QCOMPARE(bytes(w.blocks()), bytes(editor::replaceRangeInBlocks(b, rangeIn(b, 2, 2), QStringLiteral("가\n나")).blocks));
    }
    {
        EditorWidget w;
        w.setBlocks(b);
        const int p = ms - 3;
        caretTo(w, p);
        QInputMethodEvent e(QString(), {});
        e.setCommitString(QStringLiteral("X"), -2, 2);
        QApplication::sendEvent(&w, &e);
        QCOMPARE(bytes(w.blocks()), bytes(editor::replaceRangeInBlocks(b, rangeIn(b, p - 2, p), QStringLiteral("X")).blocks));
    }
    {
        // a replacement reaching from the body line into the marker: clamped, the marker line whole
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, ms - 1);
        QInputMethodEvent e(QString(), {});
        e.setCommitString(QStringLiteral("X"), 0, 3);
        QApplication::sendEvent(&w, &e);
        QCOMPARE(bytes(w.blocks()), bytes(editor::replaceRangeInBlocks(b, rangeIn(b, ms - 1, ms + 2), QStringLiteral("X")).blocks));
        QVERIFY(lastIsMarkerLine(w.blocks()));
    }
    {
        // a replacement starting in the marker: refused
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, ms + 1);
        QInputMethodEvent e(QString(), {});
        e.setCommitString(QStringLiteral("X"), -1, 1);
        QApplication::sendEvent(&w, &e);
        QCOMPARE(real(w), SAMPLE.left(ms) + editor::END_MARKER);
    }
    {
        // a replacement aimed into the marker from a caret where input is open: the gate is asked where it lands
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, ms - 1);
        QInputMethodEvent e(QString(), {});
        e.setCommitString(QStringLiteral("X"), 2, 1);
        QApplication::sendEvent(&w, &e);
        QCOMPARE(real(w), SAMPLE);
    }
    {
        const QVector<Block> two = lines({QStringLiteral("본문"), QStringLiteral("(끝)")});
        EditorWidget w;
        w.setBlocks(two);
        select(w, 1, 5); // "문\n(끝"
        preedit(w, QStringLiteral("ㅎ"));
        QCOMPARE(bytes(w.blocks()), bytes(editor::replaceRangeInBlocks(two, rangeIn(two, 1, 5), QString()).blocks));
        QCOMPARE(real(w), QStringLiteral("본\n(끝)"));
        commit(w, QStringLiteral("한"));
        QCOMPARE(real(w), QStringLiteral("본한\n(끝)"));
    }
}

// decisions (4): while a composition is in progress no shortcut is recognised - nothing is performed or reported.
void EditorWidgetTest::shortcutsAreNeverInterceptedWhileComposing()
{
    const QVector<Block> b = lines({QStringLiteral("본문 줄"), QStringLiteral("둘째 줄")});
    EditorWidget w;
    w.setBlocks(b);
    caretTo(w, 2);
    preedit(w, QStringLiteral("ㅎ"));
    QVERIFY(w.isComposing());
    Recorder rec(w);
    QTest::keyClick(&w, Qt::Key_Y, Qt::AltModifier);
    QTest::keyClick(&w, Qt::Key_Y, Qt::ControlModifier);
    QTest::keyClick(&w, Qt::Key_D, Qt::ControlModifier);
    QTest::keyClick(&w, Qt::Key_Z, Qt::ControlModifier);
    QTest::keyClick(&w, Qt::Key_Insert);
    QVERIFY(rec.shortcuts.isEmpty());
    QCOMPARE(bytes(w.blocks()), bytes(b));
    QVERIFY(w.isComposing());
    QVERIFY(!w.overwriting());
}

void EditorWidgetTest::shortcutsRunInTheWebOrder_data()
{
    QTest::addColumn<int>("key");
    QTest::addColumn<int>("mods");
    QTest::addColumn<uint>("scan");
    QTest::addColumn<QString>("txt");
    QTest::addColumn<QString>("expected");

    const int C = int(Qt::ControlModifier);
    const int A = int(Qt::AltModifier);
    const int S = int(Qt::ShiftModifier);
    QTest::newRow("ctrl y") << int(Qt::Key_Y) << C << 0x15u << QString(QChar(0x19)) << QStringLiteral("InsertContinueMarker");
    QTest::newRow("alt y") << int(Qt::Key_Y) << A << 0x15u << QStringLiteral("y") << QStringLiteral("InsertEndMarker");
    QTest::newRow("ctrl d") << int(Qt::Key_D) << C << 0x20u << QString(QChar(0x04)) << QStringLiteral("DeleteLine");
    QTest::newRow("ctrl z") << int(Qt::Key_Z) << C << 0x2Cu << QString(QChar(0x1A)) << QStringLiteral("Undo");
    QTest::newRow("ctrl shift z") << int(Qt::Key_Z) << (C | S) << 0x2Cu << QString(QChar(0x1A)) << QStringLiteral("Redo");
    QTest::newRow("ctrl b") << int(Qt::Key_B) << C << 0x30u << QString(QChar(0x02)) << QStringLiteral("CompanyCode");
    QTest::newRow("ctrl f") << int(Qt::Key_F) << C << 0x21u << QString(QChar(0x06)) << QStringLiteral("FindReplace");
    QTest::newRow("alt o") << int(Qt::Key_O) << A << 0x18u << QStringLiteral("o") << QStringLiteral("GlyphInput");
    QTest::newRow("alt v") << int(Qt::Key_V) << A << 0x2Fu << QStringLiteral("v") << QStringLiteral("PasteOriginal");
    QTest::newRow("insert") << int(Qt::Key_Insert) << 0 << 0xE052u << QString() << QStringLiteral("ToggleOverwrite");
    QTest::newRow("keypad insert") << int(Qt::Key_Insert) << int(Qt::KeypadModifier) << 0x52u << QString() << QStringLiteral("ToggleOverwrite");
    QTest::newRow("dvorak ctrl phys-Y types f: find, not (계속)") << int(Qt::Key_F) << C << 0x15u << QString(QChar(0x06)) << QStringLiteral("FindReplace");
    QTest::newRow("qwertz ctrl phys-Y types z: (계속), not undo") << int(Qt::Key_Z) << C << 0x15u << QString(QChar(0x1A)) << QStringLiteral("InsertContinueMarker");
    QTest::newRow("azerty ctrl phys-W types z: undo") << int(Qt::Key_Z) << C << 0x11u << QString(QChar(0x1A)) << QStringLiteral("Undo");
    QTest::newRow("ctrl a: native") << int(Qt::Key_A) << C << 0x1Eu << QString(QChar(0x01)) << QString();
    QTest::newRow("shift insert: native paste") << int(Qt::Key_Insert) << S << 0xE052u << QString() << QString();
    QTest::newRow("plain y: typing") << int(Qt::Key_Y) << 0 << 0x15u << QStringLiteral("y") << QString();
}

// The widget reports exactly what shortcutFor(keyInputFromQt(...)) says - the first predicate of the web's order.
void EditorWidgetTest::shortcutsRunInTheWebOrder()
{
    QFETCH(int, key);
    QFETCH(int, mods);
    QFETCH(uint, scan);
    QFETCH(QString, txt);
    QFETCH(QString, expected);
    const Qt::KeyboardModifiers m = Qt::KeyboardModifiers(mods);
    EditorWidget w;
    w.setBlocks(lines({QStringLiteral("본문"), QStringLiteral("둘째")}));
    caretTo(w, 1);
    Recorder rec(w);
    windowsKey(w, key, m, scan, txt);
    const std::optional<Shortcut> pure = editor::shortcutFor(editor::keyInputFromQt(key, m, scan));
    QCOMPARE(rec.shortcuts.size(), pure ? 1 : 0);
    if (pure)
        QCOMPARE(rec.shortcuts.first(), *pure);
    const QStringList names{QStringLiteral("ToggleOverwrite"), QStringLiteral("CompanyCode"), QStringLiteral("FindReplace"),
                            QStringLiteral("GlyphInput"),      QStringLiteral("PasteOriginal"), QStringLiteral("InsertEndMarker"),
                            QStringLiteral("InsertContinueMarker"), QStringLiteral("Undo"), QStringLiteral("Redo"),
                            QStringLiteral("DeleteLine")};
    QCOMPARE(pure ? names.at(int(*pure)) : QString(), expected);
    if (expected == QLatin1String("FindReplace") || expected == QLatin1String("Undo") || expected == QLatin1String("Redo"))
        QCOMPARE(real(w), QStringLiteral("본문\n둘째")); // reported only - and Find ran instead of (계속)
}

// Alt+Y appends "(끝)" only where the text has none (insertEndMarker - substring, glued and quoted count), wherever
// the caret is; Ctrl+Y is insertContinueMarker (the marker stays last); Ctrl+D is deleteLineAt, the marker line
// included (deleting it re-opens input) and a text line's embed with it.
void EditorWidgetTest::shortcutsKeepTheMarkerContract()
{
    const QStringList withMarker{SAMPLE, QStringLiteral("본문(끝)"), QStringLiteral("a (끝) b")};
    for (const QString &t : withMarker) {
        EditorWidget w;
        w.setBlocks(editor::textToBlocks(t));
        caretTo(w, int(t.size()));
        QTest::keyClick(&w, Qt::Key_Y, Qt::AltModifier);
        QCOMPARE(real(w), t);
    }
    {
        const QVector<Block> b = lines({QStringLiteral("제목"), QStringLiteral("본문")});
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 1);
        QTest::keyClick(&w, Qt::Key_Y, Qt::AltModifier);
        QCOMPARE(bytes(w.blocks()), bytes(editor::insertEndMarker(b).blocks));
        QVERIFY(lastIsMarkerLine(w.blocks()));
        QCOMPARE(w.textCursor().position(), 1); // the caret stays
    }
    const QVector<Block> b = editor::textToBlocks(SAMPLE);
    for (int line : {5, 6}) {
        EditorWidget w;
        w.setBlocks(b);
        w.focusLineStart(line);
        QTest::keyClick(&w, Qt::Key_Y, Qt::ControlModifier);
        const editor::ContinueMarkerInsertion r = editor::insertContinueMarker(b, line);
        QCOMPARE(bytes(w.blocks()), bytes(r.blocks));
        QVERIFY(lastIsMarkerLine(w.blocks()));
        QCOMPARE(w.caret().lineIndex, r.caretTextLine);
        QCOMPARE(w.textCursor().positionInBlock(), 0);
    }
    {
        const Block e = image(QStringLiteral("x.png"));
        const QVector<Block> withEmbed{text(QStringLiteral("a")), text(QStringLiteral("b")), e, text(QStringLiteral("(끝)"))};
        EditorWidget w;
        w.setBlocks(withEmbed);
        w.focusLineStart(1);
        QTest::keyClick(&w, Qt::Key_D, Qt::ControlModifier);
        QCOMPARE(bytes(w.blocks()), bytes(editor::deleteLineAt(withEmbed, 1).blocks));
        QCOMPARE(bytes(w.blocks()), bytes({text(QStringLiteral("a")), text(QStringLiteral("(끝)"))}));
        w.focusLineStart(1); // the marker line
        QTest::keyClick(&w, Qt::Key_D, Qt::ControlModifier);
        QCOMPARE(bytes(w.blocks()), bytes({text(QStringLiteral("a"))}));
        caretTo(w, 1);
        QTest::keyClicks(&w, QStringLiteral("z")); // input re-opened
        QCOMPARE(real(w), QStringLiteral("az"));
    }
    {
        EditorWidget w;
        w.setBlocks({});
        Recorder rec(w);
        QTest::keyClick(&w, Qt::Key_D, Qt::ControlModifier); // nothing to delete: still consumed and reported
        QCOMPARE(rec.shortcuts, (QVector<Shortcut>{Shortcut::DeleteLine}));
        QVERIFY(rec.edits.isEmpty());
        QVERIFY(w.blocks().isEmpty());
    }
}

// The web: Backspace / Delete on an empty line delete that line (deleteLineAt), whatever the modifiers.
void EditorWidgetTest::emptyLineBackspaceAndDeleteDeleteTheLine()
{
    const QVector<Block> b = lines({QStringLiteral("a"), QString(), QStringLiteral("b"), QStringLiteral("(끝)")});
    const QString expected = bytes(editor::deleteLineAt(b, 1).blocks);
    const QList<QPair<int, Qt::KeyboardModifiers>> presses{{Qt::Key_Backspace, Qt::NoModifier},
                                                           {Qt::Key_Delete, Qt::NoModifier},
                                                           {Qt::Key_Backspace, Qt::ControlModifier},
                                                           {Qt::Key_Delete, Qt::ControlModifier},
                                                           {Qt::Key_Delete, Qt::ShiftModifier}};
    for (const auto &press : presses) {
        EditorWidget w;
        w.setBlocks(b);
        Recorder rec(w);
        caretTo(w, 2);
        QTest::keyClick(&w, Qt::Key(press.first), press.second);
        QCOMPARE(bytes(w.blocks()), expected);
        QCOMPARE(rec.edits, (QVector<EditKind>{EditKind::Operation}));
        QCOMPARE(w.caret().lineIndex, 1);
    }
    {
        // a line holding only a CR is not empty: Backspace at its start is a join
        const QVector<Block> cr = lines({QStringLiteral("a"), QStringLiteral("\r")});
        EditorWidget w;
        w.setBlocks(cr);
        caretTo(w, 2);
        QTest::keyClick(&w, Qt::Key_Backspace);
        QCOMPARE(bytes(w.blocks()), bytes(lines({QStringLiteral("a\r")})));
    }
}

// Pre-decision 1: a join that would glue a marker line to other text is refused - Backspace at the line start, Delete
// at the line end, and their Ctrl (word) forms, which Qt itself would join (measured). Joins that keep a marker line
// whole and joins of plain lines go through joinTextLines.
void EditorWidgetTest::lineJoinsGoThroughTheMergeGate()
{
    const QVector<Block> b = lines({QStringLiteral("본문"), QStringLiteral("(끝)")});
    const QList<QPair<int, QPair<int, Qt::KeyboardModifiers>>> refused{
        {3, {Qt::Key_Backspace, Qt::NoModifier}},
        {3, {Qt::Key_Backspace, Qt::ControlModifier}},
        {2, {Qt::Key_Delete, Qt::NoModifier}},
        {2, {Qt::Key_Delete, Qt::ControlModifier}},
    };
    for (const auto &r : refused) {
        EditorWidget w;
        w.setBlocks(b);
        Recorder rec(w);
        caretTo(w, r.first);
        QTest::keyClick(&w, Qt::Key(r.second.first), r.second.second);
        QCOMPARE(bytes(w.blocks()), bytes(b));
        QVERIFY(rec.edits.isEmpty());
    }
    struct Allowed {
        QVector<Block> blocks;
        int caret;
        int key;
        QVector<Block> expected;
    };
    const Block e = image(QStringLiteral("x.png"));
    const QList<Allowed> allowed{
        {lines({QString(), QStringLiteral("(끝)")}), 1, Qt::Key_Backspace, lines({QStringLiteral("(끝)")})},
        {lines({QStringLiteral("   "), QStringLiteral("(끝)")}), 4, Qt::Key_Backspace, lines({QStringLiteral("   (끝)")})},
        {lines({QStringLiteral("(끝)"), QStringLiteral("  ")}), 3, Qt::Key_Delete, lines({QStringLiteral("(끝)  ")})},
        {lines({QStringLiteral("ab"), QStringLiteral("cd")}), 3, Qt::Key_Backspace, lines({QStringLiteral("abcd")})},
        {lines({QStringLiteral("ab"), QStringLiteral("cd")}), 2, Qt::Key_Delete, lines({QStringLiteral("abcd")})},
        {{text(QStringLiteral("ab")), e, text(QStringLiteral("cd"))}, 3, Qt::Key_Backspace, {text(QStringLiteral("abcd")), e}},
    };
    for (const Allowed &a : allowed) {
        EditorWidget w;
        w.setBlocks(a.blocks);
        Recorder rec(w);
        caretTo(w, a.caret);
        QTest::keyClick(&w, Qt::Key(a.key));
        QCOMPARE(bytes(w.blocks()), bytes(a.expected));
        QCOMPARE(rec.edits, (QVector<EditKind>{EditKind::Typing}));
    }
    {
        // the join point is where the caret goes; the first line's start and the last line's end join nothing
        EditorWidget w;
        w.setBlocks(lines({QStringLiteral("ab"), QStringLiteral("cd")}));
        caretTo(w, 3);
        QTest::keyClick(&w, Qt::Key_Backspace);
        QCOMPARE(w.textCursor().position(), 2);
        caretTo(w, 0);
        QTest::keyClick(&w, Qt::Key_Backspace);
        caretTo(w, 4);
        QTest::keyClick(&w, Qt::Key_Delete);
        QCOMPARE(real(w), QStringLiteral("abcd"));
    }
}

// The step3 carry-over: a multi-line selection removed by any route is replaceRangeInBlocks(..., "") - "본문⏎(끝)"
// minus "문⏎(끝" is "본⏎(끝)" (the clamp), never "본)" or "본(끝)". Typing, Enter, paste and an IME commit over it are
// replaceRangeInBlocks with their text. The web quirk the step3 P4 rows lock comes along: when the marker is the
// first text line, a range starting on it inserts an empty line in front of it.
void EditorWidgetTest::multiLineSelectionDeletesGoThroughReplaceRange()
{
    const QVector<Block> b = lines({QStringLiteral("본문"), QStringLiteral("(끝)")});
    const QString deleted = bytes(editor::replaceRangeInBlocks(b, rangeIn(b, 1, 5), QString()).blocks);
    QCOMPARE(deleted, bytes(lines({QStringLiteral("본"), QStringLiteral("(끝)")})));
    const QList<std::function<void(EditorWidget &)>> deletes{
        [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Backspace); },
        [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Delete); },
        [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_X, Qt::ControlModifier); },
        [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Delete, Qt::ShiftModifier); },
        [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Backspace, Qt::ControlModifier); },
        [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Delete, Qt::ControlModifier); },
    };
    for (int i = 0; i < deletes.size(); ++i) {
        for (const bool reversed : {false, true}) {
            EditorWidget w;
            w.setBlocks(b);
            reversed ? select(w, 5, 1) : select(w, 1, 5);
            deletes.at(i)(w);
            QVERIFY2(bytes(w.blocks()) == deleted, qPrintable(QStringLiteral("delete route %1 reversed %2: %3").arg(i).arg(reversed).arg(real(w))));
            QVERIFY(lastIsMarkerLine(w.blocks()));
        }
    }
    {
        EditorWidget w;
        w.setBlocks(b);
        select(w, 1, 5);
        QTest::keyClick(&w, Qt::Key_X, Qt::ControlModifier);
        QCOMPARE(QApplication::clipboard()->text(), QStringLiteral("문\n(끝"));
    }
    for (int i = 0; i < deletes.size(); ++i) {
        // the step3 summary's own example: "문⏎" out of "본문⏎(끝)" - natively "본(끝)", a marker glued to text that
        // passes the substring send guard; through the clamp only "문" goes
        EditorWidget w;
        w.setBlocks(b);
        select(w, 1, 4);
        deletes.at(i)(w);
        QCOMPARE(bytes(w.blocks()), bytes(editor::replaceRangeInBlocks(b, rangeIn(b, 1, 4), QString()).blocks));
        QCOMPARE(real(w), QStringLiteral("본\n(끝)"));
    }
    const QList<QPair<QString, std::function<void(EditorWidget &)>>> replaces{
        {QStringLiteral("x"), [](EditorWidget &w) { QTest::keyClicks(&w, QStringLiteral("x")); }},
        {QStringLiteral("\n"), [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Return); }},
        {QStringLiteral("P"), [](EditorWidget &w) {
             QApplication::clipboard()->setText(QStringLiteral("P"));
             QTest::keyClick(&w, Qt::Key_V, Qt::ControlModifier);
         }},
        {QStringLiteral("한"), [](EditorWidget &w) { commit(w, QStringLiteral("한")); }},
    };
    for (const auto &r : replaces) {
        EditorWidget w;
        w.setBlocks(b);
        select(w, 1, 5);
        r.second(w);
        QCOMPARE(bytes(w.blocks()), bytes(editor::replaceRangeInBlocks(b, rangeIn(b, 1, 5), r.first).blocks));
        QVERIFY(lastIsMarkerLine(w.blocks()));
    }
    {
        // the web quirk: marker first, a range starting on it -> an empty line in front of the marker
        const QVector<Block> first = lines({QStringLiteral("(끝)"), QStringLiteral("abc")});
        EditorWidget w;
        w.setBlocks(first);
        select(w, 1, 6);
        QTest::keyClick(&w, Qt::Key_Backspace);
        const QVector<Block> pure = editor::replaceRangeInBlocks(first, rangeIn(first, 1, 6), QString()).blocks;
        QCOMPARE(bytes(w.blocks()), bytes(pure));
        QCOMPARE(bytes(pure), bytes(lines({QString(), QStringLiteral("(끝)"), QStringLiteral("abc")})));
    }
    {
        // a single-line selection inside the marker line is an ordinary delete (deleting is never gated)
        EditorWidget w;
        w.setBlocks(b);
        select(w, 3, 4);
        QTest::keyClick(&w, Qt::Key_Delete);
        QCOMPARE(real(w), QStringLiteral("본문\n끝)"));
    }
}

// Qt types and deletes inside a line itself; the widget locates the edit from the cursor it started at
// (nativeEditBetween) and mirrors it into the real text - so a CR shown as a space keeps its place exactly.
void EditorWidgetTest::nativeEditsAreMirroredExactly()
{
    const QVector<Block> b = lines({QStringLiteral("본문\r"), QStringLiteral("(끝)")});
    struct Case {
        int caret;
        std::function<void(EditorWidget &)> act;
        QString line0;
    };
    const QList<Case> cases{
        {2, [](EditorWidget &w) { QTest::keyClicks(&w, QStringLiteral("x")); }, QStringLiteral("본문x\r")},
        {3, [](EditorWidget &w) { QTest::keyClicks(&w, QStringLiteral("x")); }, QStringLiteral("본문\rx")},
        {2, [](EditorWidget &w) { QTest::keyClicks(&w, QStringLiteral(" ")); }, QStringLiteral("본문 \r")},
        {3, [](EditorWidget &w) { QTest::keyClicks(&w, QStringLiteral(" ")); }, QStringLiteral("본문\r ")},
        {3, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Backspace); }, QStringLiteral("본문")},
        {2, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Delete); }, QStringLiteral("본문")},
        {2, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Backspace); }, QStringLiteral("본\r")},
        {2, [](EditorWidget &w) {
             preedit(w, QStringLiteral("ㄱ"));
             commit(w, QStringLiteral("가"));
         }, QStringLiteral("본문가\r")},
    };
    for (const Case &c : cases) {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, c.caret);
        c.act(w);
        QCOMPARE(w.blocks().first().text, c.line0);
        QCOMPARE(shown(w), displayed(w.blocks()));
        QCOMPARE(w.document()->blockCount(), 2);
    }
    {
        // a key that types U+2029 (a block break for Qt) is inserted as text, still one line
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 1);
        windowsKey(w, Qt::Key_unknown, Qt::NoModifier, 0, QString(QChar(0x2029)));
        QCOMPARE(w.blocks().first().text, QStringLiteral("본") + QChar(0x2029) + QStringLiteral("문\r"));
        QCOMPARE(w.document()->blockCount(), 2);
        QCOMPARE(shown(w), displayed(w.blocks()));
    }
}

// A document change no path of the widget made - QPlainTextEdit's own API, a cursor on the document - is put back
// from the blocks: fail closed, nothing reaches blocks(), nothing is reported.
void EditorWidgetTest::outOfBandDocumentChangesAreUndone()
{
    const QVector<Block> b = editor::textToBlocks(SAMPLE);
    EditorWidget w;
    w.setBlocks(b);
    Recorder rec(w);
    caretTo(w, int(SAMPLE.size()));
    w.insertPlainText(QStringLiteral("x"));
    QCoreApplication::processEvents();
    QCOMPARE(real(w), SAMPLE);
    QCOMPARE(shown(w), displayed(b));
    w.setPlainText(QStringLiteral("evil"));
    QCoreApplication::processEvents();
    QCOMPARE(shown(w), displayed(b));
    QTextCursor c(w.document());
    c.insertText(QStringLiteral("y\nz"));
    QCoreApplication::processEvents();
    QCOMPARE(shown(w), displayed(b));
    QCOMPARE(real(w), SAMPLE);
    QVERIFY(rec.edits.isEmpty());
}

// No drops (an image drop is P6's embed), no context menu (P7's 14 actions), no text drags: a press inside the
// selection does not arm one - it is an ordinary click (the web refuses dragstart in the editor).
void EditorWidgetTest::dropsContextMenuAndTextDragsAreClosed()
{
    const QVector<Block> b = lines({QStringLiteral("abcdef"), QStringLiteral("(끝)")});
    EditorWidget w;
    w.setBlocks(b);
    w.resize(400, 200);
    w.show();
    QCoreApplication::processEvents();
    QVERIFY(!w.acceptDrops());
    QVERIFY(!w.viewport()->acceptDrops());
    QCOMPARE(w.contextMenuPolicy(), Qt::NoContextMenu);
    QMimeData mime;
    mime.setText(QStringLiteral("DROP"));
    QDragEnterEvent enter(QPoint(5, 5), Qt::CopyAction | Qt::MoveAction, &mime, Qt::LeftButton, Qt::NoModifier);
    QApplication::sendEvent(w.viewport(), &enter);
    QVERIFY(!enter.isAccepted());
    QDropEvent drop(QPointF(5, 5), Qt::CopyAction, &mime, Qt::LeftButton, Qt::NoModifier);
    QApplication::sendEvent(w.viewport(), &drop);
    QCOMPARE(real(w), QStringLiteral("abcdef\n(끝)"));
    select(w, 0, 4);
    QTextCursor inside = w.textCursor();
    inside.setPosition(2);
    const QPoint pos = w.cursorRect(inside).center();
    QTest::mousePress(w.viewport(), Qt::LeftButton, Qt::NoModifier, pos);
    QVERIFY(!w.textCursor().hasSelection()); // no drag armed
    QTest::mouseRelease(w.viewport(), Qt::LeftButton, Qt::NoModifier, pos);
    QCOMPARE(real(w), QStringLiteral("abcdef\n(끝)"));
}

// The document's own undo stack is off - the step6 snapshot history is the only undo. Ctrl+Z / Ctrl+Shift+Z are
// reported for the state machine; Ctrl+Y is "(계속)", not redo; Qt's Alt+Backspace undo does nothing.
void EditorWidgetTest::documentUndoIsOffAndUndoKeysAreReported()
{
    EditorWidget w;
    QVERIFY(!w.document()->isUndoRedoEnabled());
    w.setBlocks(lines({QStringLiteral("본문")}));
    caretTo(w, 2);
    QTest::keyClicks(&w, QStringLiteral("abc"));
    Recorder rec(w);
    QTest::keyClick(&w, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(rec.shortcuts, (QVector<Shortcut>{Shortcut::Undo}));
    QCOMPARE(real(w), QStringLiteral("본문abc"));
    QTest::keyClick(&w, Qt::Key_Z, Qt::ControlModifier | Qt::ShiftModifier);
    QCOMPARE(rec.shortcuts, (QVector<Shortcut>{Shortcut::Undo, Shortcut::Redo}));
    QCOMPARE(real(w), QStringLiteral("본문abc"));
    QTest::keyClick(&w, Qt::Key_Backspace, Qt::AltModifier);
    QCOMPARE(real(w), QStringLiteral("본문abc"));
    QVERIFY(rec.edits.isEmpty());
    QTest::keyClick(&w, Qt::Key_Y, Qt::ControlModifier);
    QCOMPARE(rec.shortcuts.last(), Shortcut::InsertContinueMarker);
    QCOMPARE(real(w), QStringLiteral("본문abc\n(계속)"));
}

// edited() carries the step9 coalescing class: the web Editor's onTextChange paths are Typing, WriterPage's edit
// operations are Operation; a composition is reported once, at its end; setBlocks and refused input report nothing.
void EditorWidgetTest::editsAreReportedWithTheirKind()
{
    const QVector<Block> b = lines({QStringLiteral("abc"), QString(), QStringLiteral("def")});
    struct Case {
        const char *name;
        int caret;
        std::function<void(EditorWidget &)> act;
        QVector<EditKind> expected;
    };
    const QList<Case> cases{
        {"typing", 1, [](EditorWidget &w) { QTest::keyClicks(&w, QStringLiteral("x")); }, {EditKind::Typing}},
        {"two keys", 1, [](EditorWidget &w) { QTest::keyClicks(&w, QStringLiteral("xy")); }, {EditKind::Typing, EditKind::Typing}},
        {"enter", 1, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Return); }, {EditKind::Typing}},
        {"backspace", 2, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Backspace); }, {EditKind::Typing}},
        {"join", 5, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Backspace); }, {EditKind::Typing}},
        {"paste", 1, [](EditorWidget &w) {
             QApplication::clipboard()->setText(QStringLiteral("p"));
             w.paste();
         }, {EditKind::Typing}},
        {"empty line backspace", 4, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Backspace); }, {EditKind::Operation}},
        {"ctrl d", 1, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_D, Qt::ControlModifier); }, {EditKind::Operation}},
        {"alt y", 1, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Y, Qt::AltModifier); }, {EditKind::Operation}},
        {"ctrl y", 1, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Y, Qt::ControlModifier); }, {EditKind::Operation}},
        {"conversion", 1, [](EditorWidget &w) { w.transformCaretLine(editor::toUpper); }, {EditKind::Operation}},
        {"composition", 1, [](EditorWidget &w) {
             preedit(w, QStringLiteral("ㅎ"));
             preedit(w, QStringLiteral("하"));
             commit(w, QStringLiteral("한"), QStringLiteral("ㄱ")); // a syllable commits, the next one composes
             commit(w, QStringLiteral("글"));
         }, {EditKind::Typing}},
        {"set blocks", 1, [](EditorWidget &w) { w.setBlocks(lines({QStringLiteral("other")})); }, {}},
        {"backspace at the document start", 0, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Backspace); }, {}},
        {"ctrl z", 1, [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Z, Qt::ControlModifier); }, {}},
    };
    for (const Case &c : cases) {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, c.caret);
        Recorder rec(w);
        c.act(w);
        QVERIFY2(rec.edits == c.expected, c.name);
    }
    {
        // a composition's text is in the document before it ends, but reported only at the end
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 1);
        Recorder rec(w);
        preedit(w, QStringLiteral("ㅎ"));
        commit(w, QStringLiteral("한"), QStringLiteral("ㄱ"));
        QCOMPARE(real(w), QStringLiteral("a한bc\n\ndef"));
        QVERIFY(rec.edits.isEmpty());
        commit(w, QStringLiteral("글"));
        QCOMPARE(rec.edits, (QVector<EditKind>{EditKind::Typing}));
    }
}

// The case conversion is transformTextLine behind isInputBlocked at the line's end: a line reaching the last "(끝)"
// (the marker line, a glued marker, anything after it) is never converted.
void EditorWidgetTest::conversionIsGatedAtTheMarker()
{
    const QVector<Block> b = lines({QStringLiteral("title"), QStringLiteral("body text"), QStringLiteral("(끝)")});
    {
        EditorWidget w;
        w.setBlocks(b);
        w.focusLineStart(1);
        QVERIFY(w.transformCaretLine(editor::toUpper));
        QCOMPARE(bytes(w.blocks()), bytes(editor::transformTextLine(b, 1, editor::toUpper)));
        w.focusLineStart(2);
        QVERIFY(!w.transformCaretLine(editor::toUpper));
        QCOMPARE(w.blocks().last().text, QStringLiteral("(끝)"));
    }
    const QList<QPair<QVector<Block>, int>> refused{
        {lines({QStringLiteral("a"), QStringLiteral("end (끝) tail")}), 1},
        {lines({QStringLiteral("a"), QStringLiteral("(끝)"), QStringLiteral("tail")}), 2},
    };
    for (const auto &r : refused) {
        EditorWidget w;
        w.setBlocks(r.first);
        w.focusLineStart(r.second);
        QVERIFY(!w.transformCaretLine(editor::toUpper));
        QCOMPARE(bytes(w.blocks()), bytes(r.first));
    }
}

// Insert toggles the overwrite mode; typing then replaces the next character - shouldOverwriteNextChar /
// overwriteExtendLength: never the line break, a surrogate pair whole, nothing in the marker (blocked anyway).
void EditorWidgetTest::overwriteModeReplacesWithinTheLineOnly()
{
    EditorWidget w;
    w.setBlocks(lines({QStringLiteral("abc"), QStringLiteral("(끝)")}));
    Recorder rec(w);
    caretTo(w, 0);
    QTest::keyClick(&w, Qt::Key_Insert);
    QVERIFY(w.overwriting());
    QVERIFY(!w.overwriteMode()); // Qt's own overwrite stays off
    QCOMPARE(rec.shortcuts, (QVector<Shortcut>{Shortcut::ToggleOverwrite}));
    QTest::keyClicks(&w, QStringLiteral("X"));
    QCOMPARE(real(w), QStringLiteral("Xbc\n(끝)"));
    caretTo(w, 3);
    QTest::keyClicks(&w, QStringLiteral("Y"));
    QCOMPARE(real(w), QStringLiteral("XbcY\n(끝)"));
    caretTo(w, int(real(w).size()) - 1);
    QTest::keyClicks(&w, QStringLiteral("Z"));
    QCOMPARE(real(w), QStringLiteral("XbcY\n(끝)"));
    QTest::keyClick(&w, Qt::Key_Insert);
    QVERIFY(!w.overwriting());
    {
        const QString pair = QString(QChar(0xD83D)) + QChar(0xDE00);
        EditorWidget s;
        s.setBlocks(lines({QStringLiteral("a") + pair + QStringLiteral("b")}));
        caretTo(s, 1);
        QTest::keyClick(&s, Qt::Key_Insert);
        QTest::keyClicks(&s, QStringLiteral("Z"));
        QCOMPARE(real(s), QStringLiteral("aZb"));
    }
}

// The web never types on an Alt combination; Qt would (measured: Alt+Q types "q"). AltGr (Ctrl+Alt) types.
void EditorWidgetTest::altLettersDoNotTypeButAltGrDoes()
{
    EditorWidget w;
    w.setBlocks(lines({QStringLiteral("본문")}));
    caretTo(w, 2);
    QTest::keyClick(&w, Qt::Key_Q, Qt::AltModifier);
    windowsKey(w, Qt::Key_Q, Qt::AltModifier, 0x10, QStringLiteral("q"));
    QCOMPARE(real(w), QStringLiteral("본문"));
    windowsKey(w, Qt::Key_Q, Qt::ControlModifier | Qt::AltModifier, 0x10, QStringLiteral("@"));
    QCOMPARE(real(w), QStringLiteral("본문@"));
    QTest::keyClick(&w, Qt::Key_Y, Qt::AltModifier);
    QCOMPARE(real(w), QStringLiteral("본문@\n(끝)"));
}

// Read-only (the state machine's lock-failed view): no path changes anything, nothing is reported; copy still works.
void EditorWidgetTest::readOnlyRefusesEveryEdit()
{
    const QVector<Block> b = lines({QStringLiteral("본문"), QString(), QStringLiteral("끝 없음")});
    EditorWidget w;
    w.setBlocks(b);
    w.setReadOnly(true);
    Recorder rec(w);
    caretTo(w, 1);
    QTest::keyClicks(&w, QStringLiteral("abc"));
    QTest::keyClick(&w, Qt::Key_Return);
    QApplication::clipboard()->setText(QStringLiteral("P"));
    QTest::keyClick(&w, Qt::Key_V, Qt::ControlModifier);
    w.paste();
    preedit(w, QStringLiteral("ㅎ"));
    commit(w, QStringLiteral("한"));
    QTest::keyClick(&w, Qt::Key_Backspace);
    QTest::keyClick(&w, Qt::Key_Delete);
    caretTo(w, 3);
    QTest::keyClick(&w, Qt::Key_Backspace); // the empty line
    QTest::keyClick(&w, Qt::Key_D, Qt::ControlModifier);
    QTest::keyClick(&w, Qt::Key_Y, Qt::AltModifier);
    QTest::keyClick(&w, Qt::Key_Y, Qt::ControlModifier);
    QTest::keyClick(&w, Qt::Key_Z, Qt::ControlModifier);
    QTest::keyClick(&w, Qt::Key_Insert);
    QVERIFY(!w.transformCaretLine(editor::toUpper));
    QCOMPARE(bytes(w.blocks()), bytes(b));
    QVERIFY(rec.edits.isEmpty());
    QVERIFY(rec.shortcuts.isEmpty());
    QVERIFY(!w.overwriting());
    select(w, 0, 2);
    QTest::keyClick(&w, Qt::Key_C, Qt::ControlModifier);
    QCOMPARE(QApplication::clipboard()->text(), QStringLiteral("본문"));
}

// caret() / selectionRange() are the step4 TextPoint: lineIndex = text-line ordinal (embeds not counted) = document
// block number, offset = blocksToText offset = document position. focusLineStart clamps like the web's.
void EditorWidgetTest::caretIsTheStep4TextPoint()
{
    const Block e = image(QStringLiteral("x.png"));
    const QVector<Block> b{text(QStringLiteral("ab")), e, text(QStringLiteral("cd")), text(QStringLiteral("(끝)"))};
    EditorWidget w;
    w.setBlocks(b);
    caretTo(w, 4);
    QCOMPARE(w.caret().lineIndex, 1);
    QCOMPARE(w.caret().offset, 4);
    QCOMPARE(w.caret().lineIndex, editor::lineAtOffset(editor::blocksToText(b), 4).lineIndex);
    select(w, 5, 1);
    const TextRange r = w.selectionRange();
    QVERIFY(r.start && r.end);
    QCOMPARE(r.start->lineIndex, 0);
    QCOMPARE(r.start->offset, 1);
    QCOMPARE(r.end->lineIndex, 1);
    QCOMPARE(r.end->offset, 5);
    w.focusLineStart(2);
    QCOMPARE(w.caret().lineIndex, 2);
    QCOMPARE(w.caret().offset, 6);
    w.focusLineStart(99);
    QCOMPARE(w.caret().lineIndex, 2);
    w.focusLineStart(-5);
    QCOMPARE(w.caret().offset, 0);
}

// A copy carries the real text - a CR shown as a space is a CR on the clipboard - never QTextCursor::selectedText()'s
// U+2029 block separators or toPlainText()'s NBSP-to-space.
void EditorWidgetTest::copyCarriesTheRealText()
{
    const QVector<Block> b = lines({QStringLiteral("본문\r"), QString(QChar(0x00A0)) + QStringLiteral("x"), QStringLiteral("(끝)")});
    EditorWidget w;
    w.setBlocks(b);
    select(w, 0, 8);
    QTest::keyClick(&w, Qt::Key_C, Qt::ControlModifier);
    QCOMPARE(QApplication::clipboard()->text(), editor::blocksToText(b).left(8));
    QCOMPARE(QApplication::clipboard()->text(), QStringLiteral("본문\r\n") + QChar(0x00A0) + QStringLiteral("x\n("));
}

// phase 78 ④ tester reinforcement. decisions (4) hands every key to Qt while a composition is in progress - a key
// that moves the caret too (Qt moves it and keeps the preedit) and a paste. A later commit, or a key the input method
// passes on, is then typed wherever the caret is NOW, and the composition-start gate (isInputBlocked before the first
// preedit) is behind it: what keeps the last "(끝)" closed there is the second ask, at the point the text went in
// (runNative -> nativeEditBetween -> acceptNativeEdit). The mutant without that second ask passed the whole suite
// (643/0) and typed "본문(끝)한" / "본문(끝)x" / "본문(끝)한" (pasted marker) - a marker glued to text, as legacy bodies
// and the web's unguarded line join (pre-decision 1) leave it.
void EditorWidgetTest::aCompositionNeverCarriesInputPastTheMarker()
{
    const QString glued = QStringLiteral("본문") + editor::END_MARKER;
    const QVector<Block> b = lines({glued});
    const QList<QPair<QString, std::function<void(EditorWidget &)>>> moves{
        {QStringLiteral("End"), [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_End); }},
        {QStringLiteral("Right"), [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_Right); }},
        {QStringLiteral("Ctrl+End"), [](EditorWidget &w) { QTest::keyClick(&w, Qt::Key_End, Qt::ControlModifier); }},
    };
    for (const auto &move : moves) {
        for (const bool byCommit : {true, false}) {
            const QString label = move.first + (byCommit ? QStringLiteral(" then a commit") : QStringLiteral(" then a key"));
            EditorWidget w;
            w.setBlocks(b);
            caretTo(w, 1);
            Recorder rec(w);
            preedit(w, QStringLiteral("ㅎ"));
            move.second(w);
            // the path under test: still composing, and the caret where input is blocked
            QVERIFY2(w.isComposing(), qPrintable(label));
            QVERIFY2(editor::isInputBlocked(real(w), w.textCursor().position()), qPrintable(label));
            if (byCommit)
                commit(w, QStringLiteral("한"));
            else
                QTest::keyClicks(&w, QStringLiteral("x"));
            QVERIFY2(real(w) == glued, qPrintable(label + QStringLiteral(": ") + real(w)));
            QCOMPARE(bytes(w.blocks()), bytes(b));
            QCOMPARE(shown(w), displayed(b));
            QVERIFY2(rec.edits.isEmpty(), qPrintable(label));
        }
    }
    {
        // a "(끝)" pasted while composing - the paste is gated and allowed where no marker is yet - leaves the caret
        // after it with the composition still on: its commit is refused there
        EditorWidget w;
        w.setBlocks(lines({QStringLiteral("본문")}));
        caretTo(w, 2);
        preedit(w, QStringLiteral("ㅎ"));
        QApplication::clipboard()->setText(editor::END_MARKER);
        QTest::keyClick(&w, Qt::Key_V, Qt::ControlModifier);
        QCOMPARE(real(w), glued);
        QVERIFY(w.isComposing());
        QVERIFY(editor::isInputBlocked(real(w), w.textCursor().position()));
        commit(w, QStringLiteral("한"));
        QCOMPARE(real(w), glued);
        QCOMPARE(shown(w), displayed(b));
    }
}

// phase 78 ④ tester reinforcement. While composing, Enter and a Delete at a line end also reach Qt untouched, and Qt
// would split or join the line itself. Only the widget's own paths change the line structure (one document block =
// one text line): the native edit is refused and the document put back - a Delete that would glue the line above to
// "(끝)" included (pre-decision 1). The mutant that let a native line break through passed the whole suite (643/0).
void EditorWidgetTest::aCompositionNeverChangesTheLineStructureNatively()
{
    const QVector<Block> b = lines({QStringLiteral("ab"), QStringLiteral("cd"), editor::END_MARKER});
    const QList<QPair<int, Qt::KeyboardModifiers>> enters{{Qt::Key_Return, Qt::NoModifier}, {Qt::Key_Enter, Qt::KeypadModifier}};
    for (const auto &press : enters) {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 1);
        Recorder rec(w);
        preedit(w, QStringLiteral("ㅎ"));
        QVERIFY(w.isComposing());
        QTest::keyClick(&w, Qt::Key(press.first), press.second);
        QCOMPARE(bytes(w.blocks()), bytes(b));
        QCOMPARE(w.document()->blockCount(), 3);
        QCOMPARE(shown(w), displayed(b));
        QVERIFY(rec.edits.isEmpty());
        commit(w, QStringLiteral("한")); // the composition still lands where it was, on its own line
        QCOMPARE(real(w), QStringLiteral("a한b\ncd\n") + editor::END_MARKER);
        QCOMPARE(w.document()->blockCount(), 3);
    }
    {
        const QVector<Block> m = lines({QStringLiteral("body"), editor::END_MARKER});
        EditorWidget w;
        w.setBlocks(m);
        caretTo(w, 4); // the end of "body", the marker line below
        Recorder rec(w);
        preedit(w, QStringLiteral("ㅎ"));
        QVERIFY(w.isComposing());
        QTest::keyClick(&w, Qt::Key_Delete);
        QCOMPARE(bytes(w.blocks()), bytes(m));
        QCOMPARE(shown(w), displayed(m));
        QCOMPARE(w.document()->blockCount(), 2);
        QVERIFY(rec.edits.isEmpty());
    }
}

// phase 78 ⑤ follow-upF1. The caret after an Enter is where replaceRangeInBlocks put the text, never a reading of a
// diff of the two documents: "ab" + Enter over "cd" is "ab⏎⏎cd", whose common prefix with "ab⏎cd" runs one character
// past the edit ("ab⏎"), and the caret went to the start of "cd" - the next key typed "ab⏎⏎xcd". The web puts it at the
// start of the new line (focusLineStart(caretLineIndex)).
void EditorWidgetTest::enterAtALineEndPutsTheCaretOnTheNewLine()
{
    const QVector<Block> b = lines({QStringLiteral("ab"), QStringLiteral("cd"), editor::END_MARKER});
    EditorWidget w;
    w.setBlocks(b);
    caretTo(w, 2); // the end of "ab" - a line follows
    QTest::keyClick(&w, Qt::Key_Return);
    const editor::InsertResult expected = editor::replaceRangeInBlocks(b, rangeIn(b, 2, 2), QStringLiteral("\n"));
    QCOMPARE(bytes(w.blocks()), bytes(expected.blocks));
    QCOMPARE(expected.caretLineIndex, 1);
    QCOMPARE(w.caret().lineIndex, 1);
    QCOMPARE(w.textCursor().positionInBlock(), 0);
    QTest::keyClicks(&w, QStringLiteral("x"));
    QCOMPARE(real(w), QStringLiteral("ab\nx\ncd\n") + editor::END_MARKER);
}

// phase 78 ⑤ follow-upF1. An Enter at the end of the line above "(끝)": the misplaced caret went to the start of the
// marker line, where input is blocked - the next key was refused without a sound ("ab⏎cd⏎⏎(끝)"). Where rule 3 moves the
// insertion (a caret between two marker lines: the new line goes under the line above the first one) the caret follows
// the insertion - it went to the start of the first marker line instead, and since the input gate looks at the LAST
// "(끝)", the next key glued itself to the first marker ("x(끝)" - no longer a marker line).
void EditorWidgetTest::enterAboveTheMarkerLineKeepsTheNextKeystroke()
{
    {
        const QVector<Block> b = lines({QStringLiteral("ab"), QStringLiteral("cd"), editor::END_MARKER});
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 5); // the end of "cd" - the marker line below
        QTest::keyClick(&w, Qt::Key_Return);
        QCOMPARE(w.caret().lineIndex, 2);
        QCOMPARE(w.textCursor().positionInBlock(), 0);
        QVERIFY(!editor::isInputBlocked(real(w), w.textCursor().position()));
        QTest::keyClicks(&w, QStringLiteral("x"));
        QCOMPARE(real(w), QStringLiteral("ab\ncd\nx\n") + editor::END_MARKER);
    }
    {
        const QVector<Block> two = lines({QStringLiteral("a"), editor::END_MARKER, QStringLiteral("b"), editor::END_MARKER});
        EditorWidget w;
        w.setBlocks(two);
        const int at = w.document()->findBlockByNumber(2).position(); // the start of "b", between the two markers
        caretTo(w, at);
        QTest::keyClick(&w, Qt::Key_Return);
        const editor::InsertResult expected = editor::replaceRangeInBlocks(two, rangeIn(two, at, at), QStringLiteral("\n"));
        QCOMPARE(bytes(w.blocks()), bytes(expected.blocks));
        QCOMPARE(expected.caretLineIndex, 1); // rule 3: the new line went in under "a"
        QCOMPARE(w.caret().lineIndex, 1);
        QCOMPARE(w.textCursor().positionInBlock(), 0);
        QTest::keyClicks(&w, QStringLiteral("x"));
        QCOMPARE(real(w), QStringLiteral("a\nx\n") + editor::END_MARKER + QStringLiteral("\nb\n") + editor::END_MARKER);
    }
}

// phase 78 ⑤ follow-upF1. An insertion whose text repeats its neighbours: "bc" pasted into "a|bcd" - the common
// prefix ran past the edit and the caret landed after "abcbc" (5), not after the pasted "bc" (3); "b⏎b" pasted into
// "a|b" - the caret went to the end, past the "b" that was there before. Typing over a multi-line selection slid the
// other way: "d" over "b⏎cd" leaves "ad", the common suffix took the typed "d" and the caret went before it. The caret is
// the end of the inserted text (multi-line: the end of its last line - step8 (d)), counted from the insertion point.
void EditorWidgetTest::anInsertionThatRepeatsItsNeighboursPutsTheCaretAfterIt()
{
    {
        const QVector<Block> b = lines({QStringLiteral("abcd"), editor::END_MARKER});
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 1);
        QApplication::clipboard()->setText(QStringLiteral("bc"));
        QTest::keyClick(&w, Qt::Key_V, Qt::ControlModifier);
        QCOMPARE(real(w), QStringLiteral("abcbcd\n") + editor::END_MARKER);
        QCOMPARE(w.textCursor().position(), 3);
    }
    {
        const QVector<Block> b = lines({QStringLiteral("ab")});
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 1);
        QApplication::clipboard()->setText(QStringLiteral("b\nb"));
        QTest::keyClick(&w, Qt::Key_V, Qt::ControlModifier);
        QCOMPARE(real(w), QStringLiteral("ab\nbb"));
        QCOMPARE(w.caret().lineIndex, 1);
        QCOMPARE(w.textCursor().positionInBlock(), 1);
    }
    {
        const QVector<Block> b = lines({QStringLiteral("ab"), QStringLiteral("cd")});
        EditorWidget w;
        w.setBlocks(b);
        select(w, 1, 5); // "b⏎cd"
        QTest::keyClicks(&w, QStringLiteral("d"));
        QCOMPARE(bytes(w.blocks()), bytes(editor::replaceRangeInBlocks(b, rangeIn(b, 1, 5), QStringLiteral("d")).blocks));
        QCOMPARE(real(w), QStringLiteral("ad"));
        QCOMPARE(w.textCursor().position(), 2);
    }
}

// phase 78 ⑤ follow-upF3. While composing, Shift+Enter reaches Qt untouched (decisions (4)) and Qt types it as U+2028,
// a line break inside the block - which divergence ⑦ (Shift+Enter = Enter, never Qt's line separator) rules out: it read
// "ab<U+2028>한". The native edit is refused like a line break and the composition lands on its own line. One rule, so a
// key that types U+2028 outside a composition is refused the same way.
void EditorWidgetTest::aCompositionNeverTypesALineSeparator()
{
    const QVector<Block> b = lines({QStringLiteral("ab"), editor::END_MARKER});
    {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 2);
        Recorder rec(w);
        preedit(w, QStringLiteral("ㅎ"));
        QVERIFY(w.isComposing());
        QTest::keyClick(&w, Qt::Key_Return, Qt::ShiftModifier);
        QVERIFY2(!real(w).contains(QChar(0x2028)), qPrintable(real(w)));
        QCOMPARE(bytes(w.blocks()), bytes(b));
        QCOMPARE(shown(w), displayed(b));
        QVERIFY(rec.edits.isEmpty());
        commit(w, QStringLiteral("한"));
        QCOMPARE(real(w), QStringLiteral("ab한\n") + editor::END_MARKER);
    }
    {
        EditorWidget w;
        w.setBlocks(b);
        caretTo(w, 1);
        Recorder rec(w);
        windowsKey(w, Qt::Key_unknown, Qt::NoModifier, 0, QString(QChar(0x2028)));
        QCOMPARE(bytes(w.blocks()), bytes(b));
        QCOMPARE(shown(w), displayed(b));
        QVERIFY(rec.edits.isEmpty());
    }
}

// phase 78 ⑤ follow-upF5. Every entry point puts a pending out-of-band change back before it acts - the focus-out
// too: without that, its native pass (runNative) took the foreign text for an edit of its own and, where input is open,
// mirrored it into the blocks and reported it as typing (fail open).
void EditorWidgetTest::aFocusOutPutsAPendingOutOfBandChangeBackFirst()
{
    const QVector<Block> b = lines({QStringLiteral("본문")});
    EditorWidget w;
    w.setBlocks(b);
    caretTo(w, 2);
    Recorder rec(w);
    w.insertPlainText(QStringLiteral("x")); // QPlainTextEdit's own API: the put-back is queued, not run yet
    focusOut(w);
    QCOMPARE(real(w), QStringLiteral("본문"));
    QCOMPARE(shown(w), displayed(b));
    QVERIFY(rec.edits.isEmpty());
    QCoreApplication::processEvents();
    QCOMPARE(real(w), QStringLiteral("본문"));
    QCOMPARE(shown(w), displayed(b));
    QVERIFY(rec.edits.isEmpty());
}
