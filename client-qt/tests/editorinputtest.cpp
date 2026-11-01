#include "editorinputtest.h"

#include "repofiles.h"

#include "editor/editorcontent.h"
#include "editor/editorinput.h"
#include "editor/editornewline.h"
#include "editor/editorroles.h"
#include "editor/editorshortcuts.h"

#include <QApplication>
#include <QChar>
#include <QKeyEvent>
#include <QPlainTextEdit>
#include <QRegularExpression>
#include <QString>
#include <QStringList>
#include <QTextCursor>
#include <QTextDocument>
#include <QVector>
#include <QtTest>

#include <initializer_list>
#include <optional>
#include <utility>
#include <vector>

using editor::Block;
using editor::KeyInput;
using editor::Shortcut;

namespace {

// "CASM" - Ctrl / Alt / Shift / Meta, '-' where the flag is off (the step5 test's spelling).
Qt::KeyboardModifiers modifiers(const QString &mods)
{
    Qt::KeyboardModifiers out = Qt::NoModifier;
    if (mods.contains(QLatin1Char('C')))
        out |= Qt::ControlModifier;
    if (mods.contains(QLatin1Char('A')))
        out |= Qt::AltModifier;
    if (mods.contains(QLatin1Char('S')))
        out |= Qt::ShiftModifier;
    if (mods.contains(QLatin1Char('M')))
        out |= Qt::MetaModifier;
    if (mods.contains(QLatin1Char('K')))
        out |= Qt::KeypadModifier;
    return out;
}

QString shortcutName(const std::optional<Shortcut> &s)
{
    if (!s)
        return QString();
    switch (*s) {
    case Shortcut::ToggleOverwrite: return QStringLiteral("ToggleOverwrite");
    case Shortcut::CompanyCode: return QStringLiteral("CompanyCode");
    case Shortcut::FindReplace: return QStringLiteral("FindReplace");
    case Shortcut::GlyphInput: return QStringLiteral("GlyphInput");
    case Shortcut::PasteOriginal: return QStringLiteral("PasteOriginal");
    case Shortcut::InsertEndMarker: return QStringLiteral("InsertEndMarker");
    case Shortcut::InsertContinueMarker: return QStringLiteral("InsertContinueMarker");
    case Shortcut::Undo: return QStringLiteral("Undo");
    case Shortcut::Redo: return QStringLiteral("Redo");
    case Shortcut::DeleteLine: return QStringLiteral("DeleteLine");
    }
    return QStringLiteral("?");
}

// The step5 predicates by name - the oracle for "the first one that fires".
bool fires(const QString &name, const KeyInput &e)
{
    if (name == QLatin1String("isToggleOverwrite")) return editor::isToggleOverwrite(e);
    if (name == QLatin1String("isCompanyCode")) return editor::isCompanyCode(e);
    if (name == QLatin1String("isFindReplace")) return editor::isFindReplace(e);
    if (name == QLatin1String("isGlyphInput")) return editor::isGlyphInput(e);
    if (name == QLatin1String("isPasteOriginal")) return editor::isPasteOriginal(e);
    if (name == QLatin1String("isInsertEndMarker")) return editor::isInsertEndMarker(e);
    if (name == QLatin1String("isInsertContinueMarker")) return editor::isInsertContinueMarker(e);
    if (name == QLatin1String("isUndo")) return editor::isUndo(e);
    if (name == QLatin1String("isRedo")) return editor::isRedo(e);
    if (name == QLatin1String("isDeleteLine")) return editor::isDeleteLine(e);
    return false;
}

QString predicateToShortcut(const QString &name)
{
    return name.mid(2); // "isUndo" -> "Undo"
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

Block text(const QString &t, const QString &align = QString())
{
    return editor::textBlock(t, align);
}

QString bytes(const QVector<Block> &blocks)
{
    return editor::serialize(blocks);
}

// The offset (into blocksToText) of the start / end of text line `line`.
int lineStartOffset(const QVector<Block> &blocks, int line)
{
    int offset = 0;
    int seen = 0;
    for (const Block &b : blocks) {
        if (!editor::isTextBlock(b))
            continue;
        if (seen == line)
            return offset;
        offset += int(b.text.size()) + 1;
        ++seen;
    }
    return offset;
}

int lineEndOffset(const QVector<Block> &blocks, int line)
{
    const int index = editor::textLineToBlockIndex(blocks, line);
    return lineStartOffset(blocks, line) + int(blocks.at(index).text.size());
}

struct JoinRow {
    const char *name;
    QVector<Block> blocks;
    int upper;
    QVector<Block> expected;
};

std::vector<JoinRow> joinRows()
{
    const Block e1 = image(QStringLiteral("one.png"));
    const Block e2 = image(QStringLiteral("two.png"));
    return {
        {"two plain lines", {text(QStringLiteral("ab")), text(QStringLiteral("cd"))}, 0, {text(QStringLiteral("abcd"))}},
        {"the upper align stays", {text(QStringLiteral("a"), QStringLiteral("center")), text(QStringLiteral("b"), QStringLiteral("right"))}, 0,
         {text(QStringLiteral("ab"), QStringLiteral("center"))}},
        {"lower align only is dropped", {text(QStringLiteral("a")), text(QStringLiteral("b"), QStringLiteral("right"))}, 0, {text(QStringLiteral("ab"))}},
        {"an embed between goes after", {text(QStringLiteral("a")), e1, text(QStringLiteral("b"))}, 0, {text(QStringLiteral("ab")), e1}},
        {"two embeds keep their order", {text(QStringLiteral("a")), e1, e2, text(QStringLiteral("b")), text(QStringLiteral("c"))}, 0,
         {text(QStringLiteral("ab")), e1, e2, text(QStringLiteral("c"))}},
        {"middle pair", {text(QStringLiteral("x")), text(QStringLiteral("a")), text(QStringLiteral("b")), text(QStringLiteral("y"))}, 1,
         {text(QStringLiteral("x")), text(QStringLiteral("ab")), text(QStringLiteral("y"))}},
        {"empty upper + marker (gate allows)", {text(QString()), text(QStringLiteral("(끝)"))}, 0, {text(QStringLiteral("(끝)"))}},
        {"blank upper + marker (gate allows)", {text(QStringLiteral("   ")), text(QStringLiteral("(끝)"))}, 0, {text(QStringLiteral("   (끝)"))}},
        {"marker + blank lower (gate allows)", {text(QStringLiteral("(끝)")), text(QStringLiteral("  "))}, 0, {text(QStringLiteral("(끝)  "))}},
        {"marker + empty lower (gate allows)", {text(QStringLiteral("본문")), text(QStringLiteral("(끝)")), text(QString())}, 1,
         {text(QStringLiteral("본문")), text(QStringLiteral("(끝)"))}},
        {"after the marker (no marker line takes part)", {text(QStringLiteral("(끝)")), text(QStringLiteral("a")), text(QStringLiteral("b"))}, 1,
         {text(QStringLiteral("(끝)")), text(QStringLiteral("ab"))}},
        {"CR kept inside the joined line", {text(QStringLiteral("a\r")), text(QStringLiteral("b\r"))}, 0, {text(QStringLiteral("a\rb\r"))}},
        {"no next line - unchanged", {text(QStringLiteral("a")), text(QStringLiteral("b"))}, 1, {text(QStringLiteral("a")), text(QStringLiteral("b"))}},
        {"negative - unchanged", {text(QStringLiteral("a")), text(QStringLiteral("b"))}, -1, {text(QStringLiteral("a")), text(QStringLiteral("b"))}},
        {"embeds only - unchanged", {e1, e2}, 0, {e1, e2}},
        {"trailing embed after the lower stays", {text(QStringLiteral("a")), text(QStringLiteral("b")), e1}, 0, {text(QStringLiteral("ab")), e1}},
    };
}

struct EditRow {
    const char *name;
    QString before;
    QString after;
    int selStart;
    int selEnd;
    bool backward;
    bool valid;
    int start;
    int removed;
    QString inserted;
};

std::vector<EditRow> editRows()
{
    const QString pairEmoji = QString(QChar(0xD83D)) + QChar(0xDE00);
    return {
        {"type x", QStringLiteral("ab"), QStringLiteral("axb"), 1, 1, false, true, 1, 0, QStringLiteral("x")},
        {"type a before a (no slide right)", QStringLiteral("aa"), QStringLiteral("aaa"), 1, 1, false, true, 1, 0, QStringLiteral("a")},
        {"type space before a CR shown as space", QStringLiteral("a "), QStringLiteral("a  "), 1, 1, false, true, 1, 0, QStringLiteral(" ")},
        {"type space after it", QStringLiteral("a "), QStringLiteral("a  "), 2, 2, false, true, 2, 0, QStringLiteral(" ")},
        {"type at 0", QStringLiteral("x(끝)"), QStringLiteral("xx(끝)"), 0, 0, false, true, 0, 0, QStringLiteral("x")},
        {"backspace", QStringLiteral("aa"), QStringLiteral("a"), 2, 2, true, true, 1, 1, QString()},
        {"backspace between identical glyphs", QStringLiteral("a  "), QStringLiteral("a "), 2, 2, true, true, 1, 1, QString()},
        {"backspace at the end of identical glyphs", QStringLiteral("a  "), QStringLiteral("a "), 3, 3, true, true, 2, 1, QString()},
        {"delete between identical glyphs", QStringLiteral("a  "), QStringLiteral("a "), 1, 1, false, true, 1, 1, QString()},
        {"delete the last glyph", QStringLiteral("a  "), QStringLiteral("a "), 2, 2, false, true, 2, 1, QString()},
        {"selection typed over", QStringLiteral("abcd"), QStringLiteral("aXd"), 1, 3, false, true, 1, 2, QStringLiteral("X")},
        {"selection removed", QStringLiteral("abcd"), QStringLiteral("ad"), 1, 3, false, true, 1, 2, QString()},
        {"selection typed over by its own first char", QStringLiteral("abab"), QStringLiteral("aab"), 1, 3, false, true, 1, 2, QStringLiteral("a")},
        {"backspace a surrogate pair", QStringLiteral("a") + pairEmoji, QStringLiteral("a"), 3, 3, true, true, 1, 2, QString()},
        {"word backspace", QStringLiteral("ab cd"), QStringLiteral("ab "), 5, 5, true, true, 3, 2, QString()},
        {"word delete", QStringLiteral("ab cd"), QStringLiteral("ab "), 3, 3, false, true, 3, 2, QString()},
        {"unchanged", QStringLiteral("ab"), QStringLiteral("ab"), 1, 1, false, true, 1, 0, QString()},
        {"forward edit not at the cursor", QStringLiteral("abc"), QStringLiteral("bc"), 1, 1, false, false, 0, 0, QString()},
        {"backward edit not ending at the cursor", QStringLiteral("abc"), QStringLiteral("ab"), 1, 1, true, false, 0, 0, QString()},
        {"newline inserted natively", QStringLiteral("ab"), QStringLiteral("a\nb"), 1, 1, false, true, 1, 0, QStringLiteral("\n")},
    };
}

} // namespace

// The web's onKeyDown asks the predicates in one order (web/src/view/WriterPage.jsx); SHORTCUT_ORDER must be that
// order, read from the file itself so an edit there is caught here.
void EditorInputTest::shortcutOrderIsTheWebOnKeyDownOrder()
{
    QByteArray raw;
    QString error;
    QVERIFY2(readRepoFile(QStringLiteral("web/src/view/WriterPage.jsx"), &raw, &error), qPrintable(error));
    const QString source = QString::fromUtf8(raw);
    const qsizetype start = source.indexOf(QStringLiteral("const onKeyDown = (e) => {"));
    QVERIFY2(start >= 0, "onKeyDown not found in WriterPage.jsx");
    const qsizetype end = source.indexOf(QStringLiteral("const onRemoveEmbed"), start);
    QVERIFY2(end > start, "the end of onKeyDown not found");
    const QString body = source.mid(start, end - start);
    static const QRegularExpression call(QStringLiteral(R"(\b(is[A-Z][A-Za-z]+)\(e\))"));
    QStringList order;
    for (auto it = call.globalMatch(body); it.hasNext();) {
        const QString name = it.next().captured(1);
        if (!order.contains(name))
            order << name;
    }
    QCOMPARE(order, editor::SHORTCUT_ORDER);
    QCOMPARE(editor::SHORTCUT_ORDER.size(), 10);
}

// 384 presses (16 modifier sets x 24 key / code pairs: the reserved letters, layout crosses, Hangul jamo, Insert)
// - the expected shortcut is what the web runs: generated by running web/src/view/editorShortcuts.js +
// editorFind.js under node 24 in the order read from WriterPage.jsx (no transcription).
void EditorInputTest::shortcutForFollowsTheWebOrder_data()
{
    QTest::addColumn<QString>("mods");
    QTest::addColumn<QString>("key");
    QTest::addColumn<QString>("code");
    QTest::addColumn<QString>("expected");
    QTest::newRow("k000 ---- y/KeyY") << QStringLiteral("----") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k001 C--- y/KeyY") << QStringLiteral("C---") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k002 -A-- y/KeyY") << QStringLiteral("-A--") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k003 CA-- y/KeyY") << QStringLiteral("CA--") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k004 --S- y/KeyY") << QStringLiteral("--S-") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k005 C-S- y/KeyY") << QStringLiteral("C-S-") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k006 -AS- y/KeyY") << QStringLiteral("-AS-") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k007 CAS- y/KeyY") << QStringLiteral("CAS-") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k008 ---M y/KeyY") << QStringLiteral("---M") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k009 C--M y/KeyY") << QStringLiteral("C--M") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k010 -A-M y/KeyY") << QStringLiteral("-A-M") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k011 CA-M y/KeyY") << QStringLiteral("CA-M") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k012 --SM y/KeyY") << QStringLiteral("--SM") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k013 C-SM y/KeyY") << QStringLiteral("C-SM") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k014 -ASM y/KeyY") << QStringLiteral("-ASM") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k015 CASM y/KeyY") << QStringLiteral("CASM") << QStringView(u"y").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k016 ---- d/KeyD") << QStringLiteral("----") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k017 C--- d/KeyD") << QStringLiteral("C---") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("DeleteLine");
    QTest::newRow("k018 -A-- d/KeyD") << QStringLiteral("-A--") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k019 CA-- d/KeyD") << QStringLiteral("CA--") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k020 --S- d/KeyD") << QStringLiteral("--S-") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k021 C-S- d/KeyD") << QStringLiteral("C-S-") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("DeleteLine");
    QTest::newRow("k022 -AS- d/KeyD") << QStringLiteral("-AS-") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k023 CAS- d/KeyD") << QStringLiteral("CAS-") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k024 ---M d/KeyD") << QStringLiteral("---M") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k025 C--M d/KeyD") << QStringLiteral("C--M") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("DeleteLine");
    QTest::newRow("k026 -A-M d/KeyD") << QStringLiteral("-A-M") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k027 CA-M d/KeyD") << QStringLiteral("CA-M") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k028 --SM d/KeyD") << QStringLiteral("--SM") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k029 C-SM d/KeyD") << QStringLiteral("C-SM") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("DeleteLine");
    QTest::newRow("k030 -ASM d/KeyD") << QStringLiteral("-ASM") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k031 CASM d/KeyD") << QStringLiteral("CASM") << QStringView(u"d").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k032 ---- b/KeyB") << QStringLiteral("----") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k033 C--- b/KeyB") << QStringLiteral("C---") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("CompanyCode");
    QTest::newRow("k034 -A-- b/KeyB") << QStringLiteral("-A--") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k035 CA-- b/KeyB") << QStringLiteral("CA--") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k036 --S- b/KeyB") << QStringLiteral("--S-") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k037 C-S- b/KeyB") << QStringLiteral("C-S-") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("CompanyCode");
    QTest::newRow("k038 -AS- b/KeyB") << QStringLiteral("-AS-") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k039 CAS- b/KeyB") << QStringLiteral("CAS-") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k040 ---M b/KeyB") << QStringLiteral("---M") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k041 C--M b/KeyB") << QStringLiteral("C--M") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("CompanyCode");
    QTest::newRow("k042 -A-M b/KeyB") << QStringLiteral("-A-M") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k043 CA-M b/KeyB") << QStringLiteral("CA-M") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k044 --SM b/KeyB") << QStringLiteral("--SM") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k045 C-SM b/KeyB") << QStringLiteral("C-SM") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("CompanyCode");
    QTest::newRow("k046 -ASM b/KeyB") << QStringLiteral("-ASM") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k047 CASM b/KeyB") << QStringLiteral("CASM") << QStringView(u"b").toString() << QStringLiteral("KeyB") << QStringLiteral("");
    QTest::newRow("k048 ---- z/KeyZ") << QStringLiteral("----") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k049 C--- z/KeyZ") << QStringLiteral("C---") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k050 -A-- z/KeyZ") << QStringLiteral("-A--") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k051 CA-- z/KeyZ") << QStringLiteral("CA--") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k052 --S- z/KeyZ") << QStringLiteral("--S-") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k053 C-S- z/KeyZ") << QStringLiteral("C-S-") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k054 -AS- z/KeyZ") << QStringLiteral("-AS-") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k055 CAS- z/KeyZ") << QStringLiteral("CAS-") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k056 ---M z/KeyZ") << QStringLiteral("---M") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k057 C--M z/KeyZ") << QStringLiteral("C--M") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k058 -A-M z/KeyZ") << QStringLiteral("-A-M") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k059 CA-M z/KeyZ") << QStringLiteral("CA-M") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k060 --SM z/KeyZ") << QStringLiteral("--SM") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k061 C-SM z/KeyZ") << QStringLiteral("C-SM") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k062 -ASM z/KeyZ") << QStringLiteral("-ASM") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k063 CASM z/KeyZ") << QStringLiteral("CASM") << QStringView(u"z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k064 ---- Z/KeyZ") << QStringLiteral("----") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k065 C--- Z/KeyZ") << QStringLiteral("C---") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k066 -A-- Z/KeyZ") << QStringLiteral("-A--") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k067 CA-- Z/KeyZ") << QStringLiteral("CA--") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k068 --S- Z/KeyZ") << QStringLiteral("--S-") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k069 C-S- Z/KeyZ") << QStringLiteral("C-S-") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k070 -AS- Z/KeyZ") << QStringLiteral("-AS-") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k071 CAS- Z/KeyZ") << QStringLiteral("CAS-") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k072 ---M Z/KeyZ") << QStringLiteral("---M") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k073 C--M Z/KeyZ") << QStringLiteral("C--M") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k074 -A-M Z/KeyZ") << QStringLiteral("-A-M") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k075 CA-M Z/KeyZ") << QStringLiteral("CA-M") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k076 --SM Z/KeyZ") << QStringLiteral("--SM") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k077 C-SM Z/KeyZ") << QStringLiteral("C-SM") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k078 -ASM Z/KeyZ") << QStringLiteral("-ASM") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k079 CASM Z/KeyZ") << QStringLiteral("CASM") << QStringView(u"Z").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k080 ---- o/KeyO") << QStringLiteral("----") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k081 C--- o/KeyO") << QStringLiteral("C---") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k082 -A-- o/KeyO") << QStringLiteral("-A--") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("GlyphInput");
    QTest::newRow("k083 CA-- o/KeyO") << QStringLiteral("CA--") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k084 --S- o/KeyO") << QStringLiteral("--S-") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k085 C-S- o/KeyO") << QStringLiteral("C-S-") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k086 -AS- o/KeyO") << QStringLiteral("-AS-") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("GlyphInput");
    QTest::newRow("k087 CAS- o/KeyO") << QStringLiteral("CAS-") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k088 ---M o/KeyO") << QStringLiteral("---M") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k089 C--M o/KeyO") << QStringLiteral("C--M") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k090 -A-M o/KeyO") << QStringLiteral("-A-M") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("GlyphInput");
    QTest::newRow("k091 CA-M o/KeyO") << QStringLiteral("CA-M") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k092 --SM o/KeyO") << QStringLiteral("--SM") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k093 C-SM o/KeyO") << QStringLiteral("C-SM") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k094 -ASM o/KeyO") << QStringLiteral("-ASM") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("GlyphInput");
    QTest::newRow("k095 CASM o/KeyO") << QStringLiteral("CASM") << QStringView(u"o").toString() << QStringLiteral("KeyO") << QStringLiteral("");
    QTest::newRow("k096 ---- v/KeyV") << QStringLiteral("----") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k097 C--- v/KeyV") << QStringLiteral("C---") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k098 -A-- v/KeyV") << QStringLiteral("-A--") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("PasteOriginal");
    QTest::newRow("k099 CA-- v/KeyV") << QStringLiteral("CA--") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k100 --S- v/KeyV") << QStringLiteral("--S-") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k101 C-S- v/KeyV") << QStringLiteral("C-S-") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k102 -AS- v/KeyV") << QStringLiteral("-AS-") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("PasteOriginal");
    QTest::newRow("k103 CAS- v/KeyV") << QStringLiteral("CAS-") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k104 ---M v/KeyV") << QStringLiteral("---M") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k105 C--M v/KeyV") << QStringLiteral("C--M") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k106 -A-M v/KeyV") << QStringLiteral("-A-M") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("PasteOriginal");
    QTest::newRow("k107 CA-M v/KeyV") << QStringLiteral("CA-M") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k108 --SM v/KeyV") << QStringLiteral("--SM") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k109 C-SM v/KeyV") << QStringLiteral("C-SM") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k110 -ASM v/KeyV") << QStringLiteral("-ASM") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("PasteOriginal");
    QTest::newRow("k111 CASM v/KeyV") << QStringLiteral("CASM") << QStringView(u"v").toString() << QStringLiteral("KeyV") << QStringLiteral("");
    QTest::newRow("k112 ---- f/KeyF") << QStringLiteral("----") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k113 C--- f/KeyF") << QStringLiteral("C---") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("FindReplace");
    QTest::newRow("k114 -A-- f/KeyF") << QStringLiteral("-A--") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k115 CA-- f/KeyF") << QStringLiteral("CA--") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k116 --S- f/KeyF") << QStringLiteral("--S-") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k117 C-S- f/KeyF") << QStringLiteral("C-S-") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("FindReplace");
    QTest::newRow("k118 -AS- f/KeyF") << QStringLiteral("-AS-") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k119 CAS- f/KeyF") << QStringLiteral("CAS-") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k120 ---M f/KeyF") << QStringLiteral("---M") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k121 C--M f/KeyF") << QStringLiteral("C--M") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("FindReplace");
    QTest::newRow("k122 -A-M f/KeyF") << QStringLiteral("-A-M") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k123 CA-M f/KeyF") << QStringLiteral("CA-M") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k124 --SM f/KeyF") << QStringLiteral("--SM") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k125 C-SM f/KeyF") << QStringLiteral("C-SM") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("FindReplace");
    QTest::newRow("k126 -ASM f/KeyF") << QStringLiteral("-ASM") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k127 CASM f/KeyF") << QStringLiteral("CASM") << QStringView(u"f").toString() << QStringLiteral("KeyF") << QStringLiteral("");
    QTest::newRow("k128 ---- a/KeyA") << QStringLiteral("----") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k129 C--- a/KeyA") << QStringLiteral("C---") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k130 -A-- a/KeyA") << QStringLiteral("-A--") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k131 CA-- a/KeyA") << QStringLiteral("CA--") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k132 --S- a/KeyA") << QStringLiteral("--S-") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k133 C-S- a/KeyA") << QStringLiteral("C-S-") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k134 -AS- a/KeyA") << QStringLiteral("-AS-") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k135 CAS- a/KeyA") << QStringLiteral("CAS-") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k136 ---M a/KeyA") << QStringLiteral("---M") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k137 C--M a/KeyA") << QStringLiteral("C--M") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k138 -A-M a/KeyA") << QStringLiteral("-A-M") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k139 CA-M a/KeyA") << QStringLiteral("CA-M") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k140 --SM a/KeyA") << QStringLiteral("--SM") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k141 C-SM a/KeyA") << QStringLiteral("C-SM") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k142 -ASM a/KeyA") << QStringLiteral("-ASM") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k143 CASM a/KeyA") << QStringLiteral("CASM") << QStringView(u"a").toString() << QStringLiteral("KeyA") << QStringLiteral("");
    QTest::newRow("k144 ---- q/KeyQ") << QStringLiteral("----") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k145 C--- q/KeyQ") << QStringLiteral("C---") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k146 -A-- q/KeyQ") << QStringLiteral("-A--") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k147 CA-- q/KeyQ") << QStringLiteral("CA--") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k148 --S- q/KeyQ") << QStringLiteral("--S-") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k149 C-S- q/KeyQ") << QStringLiteral("C-S-") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k150 -AS- q/KeyQ") << QStringLiteral("-AS-") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k151 CAS- q/KeyQ") << QStringLiteral("CAS-") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k152 ---M q/KeyQ") << QStringLiteral("---M") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k153 C--M q/KeyQ") << QStringLiteral("C--M") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k154 -A-M q/KeyQ") << QStringLiteral("-A-M") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k155 CA-M q/KeyQ") << QStringLiteral("CA-M") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k156 --SM q/KeyQ") << QStringLiteral("--SM") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k157 C-SM q/KeyQ") << QStringLiteral("C-SM") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k158 -ASM q/KeyQ") << QStringLiteral("-ASM") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k159 CASM q/KeyQ") << QStringLiteral("CASM") << QStringView(u"q").toString() << QStringLiteral("KeyQ") << QStringLiteral("");
    QTest::newRow("k160 ---- f/KeyY") << QStringLiteral("----") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k161 C--- f/KeyY") << QStringLiteral("C---") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("FindReplace");
    QTest::newRow("k162 -A-- f/KeyY") << QStringLiteral("-A--") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k163 CA-- f/KeyY") << QStringLiteral("CA--") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k164 --S- f/KeyY") << QStringLiteral("--S-") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k165 C-S- f/KeyY") << QStringLiteral("C-S-") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("FindReplace");
    QTest::newRow("k166 -AS- f/KeyY") << QStringLiteral("-AS-") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k167 CAS- f/KeyY") << QStringLiteral("CAS-") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k168 ---M f/KeyY") << QStringLiteral("---M") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k169 C--M f/KeyY") << QStringLiteral("C--M") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("FindReplace");
    QTest::newRow("k170 -A-M f/KeyY") << QStringLiteral("-A-M") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k171 CA-M f/KeyY") << QStringLiteral("CA-M") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k172 --SM f/KeyY") << QStringLiteral("--SM") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k173 C-SM f/KeyY") << QStringLiteral("C-SM") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("FindReplace");
    QTest::newRow("k174 -ASM f/KeyY") << QStringLiteral("-ASM") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k175 CASM f/KeyY") << QStringLiteral("CASM") << QStringView(u"f").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k176 ---- z/KeyY") << QStringLiteral("----") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k177 C--- z/KeyY") << QStringLiteral("C---") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k178 -A-- z/KeyY") << QStringLiteral("-A--") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k179 CA-- z/KeyY") << QStringLiteral("CA--") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k180 --S- z/KeyY") << QStringLiteral("--S-") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k181 C-S- z/KeyY") << QStringLiteral("C-S-") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k182 -AS- z/KeyY") << QStringLiteral("-AS-") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k183 CAS- z/KeyY") << QStringLiteral("CAS-") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k184 ---M z/KeyY") << QStringLiteral("---M") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("Undo");
    QTest::newRow("k185 C--M z/KeyY") << QStringLiteral("C--M") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k186 -A-M z/KeyY") << QStringLiteral("-A-M") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k187 CA-M z/KeyY") << QStringLiteral("CA-M") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k188 --SM z/KeyY") << QStringLiteral("--SM") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("Redo");
    QTest::newRow("k189 C-SM z/KeyY") << QStringLiteral("C-SM") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k190 -ASM z/KeyY") << QStringLiteral("-ASM") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k191 CASM z/KeyY") << QStringLiteral("CASM") << QStringView(u"z").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k192 ---- y/KeyZ") << QStringLiteral("----") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k193 C--- y/KeyZ") << QStringLiteral("C---") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k194 -A-- y/KeyZ") << QStringLiteral("-A--") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k195 CA-- y/KeyZ") << QStringLiteral("CA--") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k196 --S- y/KeyZ") << QStringLiteral("--S-") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k197 C-S- y/KeyZ") << QStringLiteral("C-S-") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k198 -AS- y/KeyZ") << QStringLiteral("-AS-") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k199 CAS- y/KeyZ") << QStringLiteral("CAS-") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k200 ---M y/KeyZ") << QStringLiteral("---M") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k201 C--M y/KeyZ") << QStringLiteral("C--M") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k202 -A-M y/KeyZ") << QStringLiteral("-A-M") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k203 CA-M y/KeyZ") << QStringLiteral("CA-M") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k204 --SM y/KeyZ") << QStringLiteral("--SM") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k205 C-SM y/KeyZ") << QStringLiteral("C-SM") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k206 -ASM y/KeyZ") << QStringLiteral("-ASM") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k207 CASM y/KeyZ") << QStringLiteral("CASM") << QStringView(u"y").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k208 ---- y/KeyT") << QStringLiteral("----") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("");
    QTest::newRow("k209 C--- y/KeyT") << QStringLiteral("C---") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k210 -A-- y/KeyT") << QStringLiteral("-A--") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k211 CA-- y/KeyT") << QStringLiteral("CA--") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("");
    QTest::newRow("k212 --S- y/KeyT") << QStringLiteral("--S-") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("");
    QTest::newRow("k213 C-S- y/KeyT") << QStringLiteral("C-S-") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k214 -AS- y/KeyT") << QStringLiteral("-AS-") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k215 CAS- y/KeyT") << QStringLiteral("CAS-") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("");
    QTest::newRow("k216 ---M y/KeyT") << QStringLiteral("---M") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("");
    QTest::newRow("k217 C--M y/KeyT") << QStringLiteral("C--M") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k218 -A-M y/KeyT") << QStringLiteral("-A-M") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k219 CA-M y/KeyT") << QStringLiteral("CA-M") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("");
    QTest::newRow("k220 --SM y/KeyT") << QStringLiteral("--SM") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("");
    QTest::newRow("k221 C-SM y/KeyT") << QStringLiteral("C-SM") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k222 -ASM y/KeyT") << QStringLiteral("-ASM") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k223 CASM y/KeyT") << QStringLiteral("CASM") << QStringView(u"y").toString() << QStringLiteral("KeyT") << QStringLiteral("");
    QTest::newRow("k224 ---- w/KeyZ") << QStringLiteral("----") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k225 C--- w/KeyZ") << QStringLiteral("C---") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k226 -A-- w/KeyZ") << QStringLiteral("-A--") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k227 CA-- w/KeyZ") << QStringLiteral("CA--") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k228 --S- w/KeyZ") << QStringLiteral("--S-") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k229 C-S- w/KeyZ") << QStringLiteral("C-S-") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k230 -AS- w/KeyZ") << QStringLiteral("-AS-") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k231 CAS- w/KeyZ") << QStringLiteral("CAS-") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k232 ---M w/KeyZ") << QStringLiteral("---M") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k233 C--M w/KeyZ") << QStringLiteral("C--M") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k234 -A-M w/KeyZ") << QStringLiteral("-A-M") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k235 CA-M w/KeyZ") << QStringLiteral("CA-M") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k236 --SM w/KeyZ") << QStringLiteral("--SM") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k237 C-SM w/KeyZ") << QStringLiteral("C-SM") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k238 -ASM w/KeyZ") << QStringLiteral("-ASM") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k239 CASM w/KeyZ") << QStringLiteral("CASM") << QStringView(u"w").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k240 ---- z/KeyW") << QStringLiteral("----") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k241 C--- z/KeyW") << QStringLiteral("C---") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("Undo");
    QTest::newRow("k242 -A-- z/KeyW") << QStringLiteral("-A--") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k243 CA-- z/KeyW") << QStringLiteral("CA--") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k244 --S- z/KeyW") << QStringLiteral("--S-") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k245 C-S- z/KeyW") << QStringLiteral("C-S-") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("Redo");
    QTest::newRow("k246 -AS- z/KeyW") << QStringLiteral("-AS-") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k247 CAS- z/KeyW") << QStringLiteral("CAS-") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k248 ---M z/KeyW") << QStringLiteral("---M") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("Undo");
    QTest::newRow("k249 C--M z/KeyW") << QStringLiteral("C--M") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("Undo");
    QTest::newRow("k250 -A-M z/KeyW") << QStringLiteral("-A-M") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k251 CA-M z/KeyW") << QStringLiteral("CA-M") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k252 --SM z/KeyW") << QStringLiteral("--SM") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("Redo");
    QTest::newRow("k253 C-SM z/KeyW") << QStringLiteral("C-SM") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("Redo");
    QTest::newRow("k254 -ASM z/KeyW") << QStringLiteral("-ASM") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k255 CASM z/KeyW") << QStringLiteral("CASM") << QStringView(u"z").toString() << QStringLiteral("KeyW") << QStringLiteral("");
    QTest::newRow("k256 ---- u315b/KeyY") << QStringLiteral("----") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k257 C--- u315b/KeyY") << QStringLiteral("C---") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k258 -A-- u315b/KeyY") << QStringLiteral("-A--") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k259 CA-- u315b/KeyY") << QStringLiteral("CA--") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k260 --S- u315b/KeyY") << QStringLiteral("--S-") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k261 C-S- u315b/KeyY") << QStringLiteral("C-S-") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k262 -AS- u315b/KeyY") << QStringLiteral("-AS-") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k263 CAS- u315b/KeyY") << QStringLiteral("CAS-") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k264 ---M u315b/KeyY") << QStringLiteral("---M") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k265 C--M u315b/KeyY") << QStringLiteral("C--M") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k266 -A-M u315b/KeyY") << QStringLiteral("-A-M") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k267 CA-M u315b/KeyY") << QStringLiteral("CA-M") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k268 --SM u315b/KeyY") << QStringLiteral("--SM") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k269 C-SM u315b/KeyY") << QStringLiteral("C-SM") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("k270 -ASM u315b/KeyY") << QStringLiteral("-ASM") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("k271 CASM u315b/KeyY") << QStringLiteral("CASM") << QStringView(u"\u315b").toString() << QStringLiteral("KeyY") << QStringLiteral("");
    QTest::newRow("k272 ---- u3147/KeyD") << QStringLiteral("----") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k273 C--- u3147/KeyD") << QStringLiteral("C---") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("DeleteLine");
    QTest::newRow("k274 -A-- u3147/KeyD") << QStringLiteral("-A--") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k275 CA-- u3147/KeyD") << QStringLiteral("CA--") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k276 --S- u3147/KeyD") << QStringLiteral("--S-") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k277 C-S- u3147/KeyD") << QStringLiteral("C-S-") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("DeleteLine");
    QTest::newRow("k278 -AS- u3147/KeyD") << QStringLiteral("-AS-") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k279 CAS- u3147/KeyD") << QStringLiteral("CAS-") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k280 ---M u3147/KeyD") << QStringLiteral("---M") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k281 C--M u3147/KeyD") << QStringLiteral("C--M") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("DeleteLine");
    QTest::newRow("k282 -A-M u3147/KeyD") << QStringLiteral("-A-M") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k283 CA-M u3147/KeyD") << QStringLiteral("CA-M") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k284 --SM u3147/KeyD") << QStringLiteral("--SM") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k285 C-SM u3147/KeyD") << QStringLiteral("C-SM") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("DeleteLine");
    QTest::newRow("k286 -ASM u3147/KeyD") << QStringLiteral("-ASM") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k287 CASM u3147/KeyD") << QStringLiteral("CASM") << QStringView(u"\u3147").toString() << QStringLiteral("KeyD") << QStringLiteral("");
    QTest::newRow("k288 ---- u314b/KeyZ") << QStringLiteral("----") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k289 C--- u314b/KeyZ") << QStringLiteral("C---") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k290 -A-- u314b/KeyZ") << QStringLiteral("-A--") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k291 CA-- u314b/KeyZ") << QStringLiteral("CA--") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k292 --S- u314b/KeyZ") << QStringLiteral("--S-") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k293 C-S- u314b/KeyZ") << QStringLiteral("C-S-") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k294 -AS- u314b/KeyZ") << QStringLiteral("-AS-") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k295 CAS- u314b/KeyZ") << QStringLiteral("CAS-") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k296 ---M u314b/KeyZ") << QStringLiteral("---M") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k297 C--M u314b/KeyZ") << QStringLiteral("C--M") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("k298 -A-M u314b/KeyZ") << QStringLiteral("-A-M") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k299 CA-M u314b/KeyZ") << QStringLiteral("CA-M") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k300 --SM u314b/KeyZ") << QStringLiteral("--SM") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k301 C-SM u314b/KeyZ") << QStringLiteral("C-SM") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("k302 -ASM u314b/KeyZ") << QStringLiteral("-ASM") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k303 CASM u314b/KeyZ") << QStringLiteral("CASM") << QStringView(u"\u314b").toString() << QStringLiteral("KeyZ") << QStringLiteral("");
    QTest::newRow("k304 ---- Insert/Insert") << QStringLiteral("----") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("ToggleOverwrite");
    QTest::newRow("k305 C--- Insert/Insert") << QStringLiteral("C---") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k306 -A-- Insert/Insert") << QStringLiteral("-A--") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k307 CA-- Insert/Insert") << QStringLiteral("CA--") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k308 --S- Insert/Insert") << QStringLiteral("--S-") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k309 C-S- Insert/Insert") << QStringLiteral("C-S-") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k310 -AS- Insert/Insert") << QStringLiteral("-AS-") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k311 CAS- Insert/Insert") << QStringLiteral("CAS-") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k312 ---M Insert/Insert") << QStringLiteral("---M") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k313 C--M Insert/Insert") << QStringLiteral("C--M") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k314 -A-M Insert/Insert") << QStringLiteral("-A-M") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k315 CA-M Insert/Insert") << QStringLiteral("CA-M") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k316 --SM Insert/Insert") << QStringLiteral("--SM") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k317 C-SM Insert/Insert") << QStringLiteral("C-SM") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k318 -ASM Insert/Insert") << QStringLiteral("-ASM") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k319 CASM Insert/Insert") << QStringLiteral("CASM") << QStringView(u"Insert").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k320 ---- Insert/Numpad0") << QStringLiteral("----") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("ToggleOverwrite");
    QTest::newRow("k321 C--- Insert/Numpad0") << QStringLiteral("C---") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k322 -A-- Insert/Numpad0") << QStringLiteral("-A--") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k323 CA-- Insert/Numpad0") << QStringLiteral("CA--") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k324 --S- Insert/Numpad0") << QStringLiteral("--S-") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k325 C-S- Insert/Numpad0") << QStringLiteral("C-S-") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k326 -AS- Insert/Numpad0") << QStringLiteral("-AS-") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k327 CAS- Insert/Numpad0") << QStringLiteral("CAS-") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k328 ---M Insert/Numpad0") << QStringLiteral("---M") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k329 C--M Insert/Numpad0") << QStringLiteral("C--M") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k330 -A-M Insert/Numpad0") << QStringLiteral("-A-M") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k331 CA-M Insert/Numpad0") << QStringLiteral("CA-M") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k332 --SM Insert/Numpad0") << QStringLiteral("--SM") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k333 C-SM Insert/Numpad0") << QStringLiteral("C-SM") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k334 -ASM Insert/Numpad0") << QStringLiteral("-ASM") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k335 CASM Insert/Numpad0") << QStringLiteral("CASM") << QStringView(u"Insert").toString() << QStringLiteral("Numpad0") << QStringLiteral("");
    QTest::newRow("k336 ---- /Insert") << QStringLiteral("----") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("ToggleOverwrite");
    QTest::newRow("k337 C--- /Insert") << QStringLiteral("C---") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k338 -A-- /Insert") << QStringLiteral("-A--") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k339 CA-- /Insert") << QStringLiteral("CA--") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k340 --S- /Insert") << QStringLiteral("--S-") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k341 C-S- /Insert") << QStringLiteral("C-S-") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k342 -AS- /Insert") << QStringLiteral("-AS-") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k343 CAS- /Insert") << QStringLiteral("CAS-") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k344 ---M /Insert") << QStringLiteral("---M") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k345 C--M /Insert") << QStringLiteral("C--M") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k346 -A-M /Insert") << QStringLiteral("-A-M") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k347 CA-M /Insert") << QStringLiteral("CA-M") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k348 --SM /Insert") << QStringLiteral("--SM") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k349 C-SM /Insert") << QStringLiteral("C-SM") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k350 -ASM /Insert") << QStringLiteral("-ASM") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k351 CASM /Insert") << QStringLiteral("CASM") << QStringView(u"").toString() << QStringLiteral("Insert") << QStringLiteral("");
    QTest::newRow("k352 ---- Enter/Enter") << QStringLiteral("----") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k353 C--- Enter/Enter") << QStringLiteral("C---") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k354 -A-- Enter/Enter") << QStringLiteral("-A--") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k355 CA-- Enter/Enter") << QStringLiteral("CA--") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k356 --S- Enter/Enter") << QStringLiteral("--S-") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k357 C-S- Enter/Enter") << QStringLiteral("C-S-") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k358 -AS- Enter/Enter") << QStringLiteral("-AS-") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k359 CAS- Enter/Enter") << QStringLiteral("CAS-") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k360 ---M Enter/Enter") << QStringLiteral("---M") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k361 C--M Enter/Enter") << QStringLiteral("C--M") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k362 -A-M Enter/Enter") << QStringLiteral("-A-M") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k363 CA-M Enter/Enter") << QStringLiteral("CA-M") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k364 --SM Enter/Enter") << QStringLiteral("--SM") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k365 C-SM Enter/Enter") << QStringLiteral("C-SM") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k366 -ASM Enter/Enter") << QStringLiteral("-ASM") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k367 CASM Enter/Enter") << QStringLiteral("CASM") << QStringView(u"Enter").toString() << QStringLiteral("Enter") << QStringLiteral("");
    QTest::newRow("k368 ---- /") << QStringLiteral("----") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k369 C--- /") << QStringLiteral("C---") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k370 -A-- /") << QStringLiteral("-A--") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k371 CA-- /") << QStringLiteral("CA--") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k372 --S- /") << QStringLiteral("--S-") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k373 C-S- /") << QStringLiteral("C-S-") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k374 -AS- /") << QStringLiteral("-AS-") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k375 CAS- /") << QStringLiteral("CAS-") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k376 ---M /") << QStringLiteral("---M") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k377 C--M /") << QStringLiteral("C--M") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k378 -A-M /") << QStringLiteral("-A-M") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k379 CA-M /") << QStringLiteral("CA-M") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k380 --SM /") << QStringLiteral("--SM") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k381 C-SM /") << QStringLiteral("C-SM") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k382 -ASM /") << QStringLiteral("-ASM") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("k383 CASM /") << QStringLiteral("CASM") << QStringView(u"").toString() << QStringLiteral("") << QStringLiteral("");
}

void EditorInputTest::shortcutForFollowsTheWebOrder()
{
    QFETCH(QString, mods);
    QFETCH(QString, key);
    QFETCH(QString, code);
    QFETCH(QString, expected);
    QCOMPARE(shortcutName(editor::shortcutFor(KeyInput{modifiers(mods), key, code})), expected);
    // Qt-only flags are not modifiers of the web's event
    const Qt::KeyboardModifiers extra = modifiers(mods) | Qt::KeypadModifier | Qt::GroupSwitchModifier;
    QCOMPARE(shortcutName(editor::shortcutFor(KeyInput{extra, key, code})), expected);
}

// The whole alphabet, every modifier set, matching and crossed physical keys: shortcutFor is the first predicate of
// SHORTCUT_ORDER that fires, and nothing when none does.
void EditorInputTest::shortcutForIsTheFirstFiringPredicate()
{
    int checked = 0;
    int some = 0;
    for (int m = 0; m < 16; ++m) {
        Qt::KeyboardModifiers mods = Qt::NoModifier;
        if (m & 1) mods |= Qt::ControlModifier;
        if (m & 2) mods |= Qt::AltModifier;
        if (m & 4) mods |= Qt::ShiftModifier;
        if (m & 8) mods |= Qt::MetaModifier;
        for (char letter = 'a'; letter <= 'z'; ++letter) {
            for (char physical : {letter, char('a' + (letter - 'a' + 7) % 26)}) {
                for (bool upper : {false, true}) {
                    const QString key = QString(QLatin1Char(upper ? char(letter - 32) : letter));
                    const QString code = QStringLiteral("Key") + QChar::fromLatin1(char(physical - 32));
                    const KeyInput e{mods, key, code};
                    QString first;
                    for (const QString &name : editor::SHORTCUT_ORDER) {
                        if (fires(name, e)) {
                            first = predicateToShortcut(name);
                            break;
                        }
                    }
                    const QString got = shortcutName(editor::shortcutFor(e));
                    QVERIFY2(got == first, qPrintable(QStringLiteral("mods %1 key %2 code %3: %4 != %5")
                                                          .arg(m).arg(key, code, got, first)));
                    ++checked;
                    if (!first.isEmpty())
                        ++some;
                }
            }
        }
    }
    QCOMPARE(checked, 16 * 26 * 2 * 2);
    QVERIFY(some > 100); // non-vacuity
}

// Rows measured on this machine: Qt 6.8.3's windows platform plugin turned the posted WM_KEYDOWN / WM_SYSKEYDOWN of
// each key into these (key(), modifiers(), nativeScanCode()) - phase 78 step8 probe (scratch, not in the repository).
// The expected code is the web KeyboardEvent.code of that physical key; the expected key is the web key.
void EditorInputTest::mapsMeasuredQtKeyEventsToKeyInput_data()
{
    QTest::addColumn<int>("qtKey");
    QTest::addColumn<QString>("mods");
    QTest::addColumn<uint>("scan");
    QTest::addColumn<QString>("key");
    QTest::addColumn<QString>("code");
    QTest::addColumn<QString>("shortcut");

    QTest::newRow("y") << int(Qt::Key_Y) << QStringLiteral("----") << 0x15u << QStringLiteral("y") << QStringLiteral("KeyY") << QString();
    QTest::newRow("shift y") << int(Qt::Key_Y) << QStringLiteral("--S-") << 0x15u << QStringLiteral("Y") << QStringLiteral("KeyY") << QString();
    QTest::newRow("ctrl y (text U+0019)") << int(Qt::Key_Y) << QStringLiteral("C---") << 0x15u << QStringLiteral("y") << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("ctrl shift y") << int(Qt::Key_Y) << QStringLiteral("C-S-") << 0x15u << QStringLiteral("Y") << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("alt y") << int(Qt::Key_Y) << QStringLiteral("-A--") << 0x15u << QStringLiteral("y") << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("alt shift y") << int(Qt::Key_Y) << QStringLiteral("-AS-") << 0x15u << QStringLiteral("Y") << QStringLiteral("KeyY") << QStringLiteral("InsertEndMarker");
    QTest::newRow("ctrl d (text U+0004)") << int(Qt::Key_D) << QStringLiteral("C---") << 0x20u << QStringLiteral("d") << QStringLiteral("KeyD") << QStringLiteral("DeleteLine");
    QTest::newRow("ctrl z") << int(Qt::Key_Z) << QStringLiteral("C---") << 0x2Cu << QStringLiteral("z") << QStringLiteral("KeyZ") << QStringLiteral("Undo");
    QTest::newRow("ctrl shift z") << int(Qt::Key_Z) << QStringLiteral("C-S-") << 0x2Cu << QStringLiteral("Z") << QStringLiteral("KeyZ") << QStringLiteral("Redo");
    QTest::newRow("ctrl b") << int(Qt::Key_B) << QStringLiteral("C---") << 0x30u << QStringLiteral("b") << QStringLiteral("KeyB") << QStringLiteral("CompanyCode");
    QTest::newRow("ctrl f") << int(Qt::Key_F) << QStringLiteral("C---") << 0x21u << QStringLiteral("f") << QStringLiteral("KeyF") << QStringLiteral("FindReplace");
    QTest::newRow("alt o") << int(Qt::Key_O) << QStringLiteral("-A--") << 0x18u << QStringLiteral("o") << QStringLiteral("KeyO") << QStringLiteral("GlyphInput");
    QTest::newRow("alt v") << int(Qt::Key_V) << QStringLiteral("-A--") << 0x2Fu << QStringLiteral("v") << QStringLiteral("KeyV") << QStringLiteral("PasteOriginal");
    QTest::newRow("ctrl a") << int(Qt::Key_A) << QStringLiteral("C---") << 0x1Eu << QStringLiteral("a") << QStringLiteral("KeyA") << QString();
    QTest::newRow("alt q") << int(Qt::Key_Q) << QStringLiteral("-A--") << 0x10u << QStringLiteral("q") << QStringLiteral("KeyQ") << QString();
    QTest::newRow("insert (E0 52)") << int(Qt::Key_Insert) << QStringLiteral("----") << 0xE052u << QStringLiteral("Insert") << QStringLiteral("Insert") << QStringLiteral("ToggleOverwrite");
    QTest::newRow("keypad insert, numlock off (52)") << int(Qt::Key_Insert) << QStringLiteral("---K") << 0x52u << QStringLiteral("Insert") << QStringLiteral("Numpad0") << QStringLiteral("ToggleOverwrite");
    QTest::newRow("keypad 0, numlock on (52)") << int(Qt::Key_0) << QStringLiteral("---K") << 0x52u << QStringLiteral("0") << QStringLiteral("Numpad0") << QString();
    QTest::newRow("shift insert (paste)") << int(Qt::Key_Insert) << QStringLiteral("--S-") << 0xE052u << QStringLiteral("Insert") << QStringLiteral("Insert") << QString();
    QTest::newRow("backspace") << int(Qt::Key_Backspace) << QStringLiteral("----") << 0x0Eu << QStringLiteral("Backspace") << QStringLiteral("Backspace") << QString();
    QTest::newRow("delete (E0 53)") << int(Qt::Key_Delete) << QStringLiteral("----") << 0xE053u << QStringLiteral("Delete") << QStringLiteral("Delete") << QString();
    QTest::newRow("return") << int(Qt::Key_Return) << QStringLiteral("----") << 0x1Cu << QStringLiteral("Enter") << QStringLiteral("Enter") << QString();
    QTest::newRow("keypad enter (E0 1C)") << int(Qt::Key_Enter) << QStringLiteral("---K") << 0xE01Cu << QStringLiteral("Enter") << QStringLiteral("NumpadEnter") << QString();
    QTest::newRow("synthetic ctrl y (scan 0)") << int(Qt::Key_Y) << QStringLiteral("C---") << 0u << QStringLiteral("y") << QString() << QStringLiteral("InsertContinueMarker");
    QTest::newRow("dvorak ctrl phys-Y types f") << int(Qt::Key_F) << QStringLiteral("C---") << 0x15u << QStringLiteral("f") << QStringLiteral("KeyY") << QStringLiteral("FindReplace");
    QTest::newRow("qwertz ctrl phys-Y types z") << int(Qt::Key_Z) << QStringLiteral("C---") << 0x15u << QStringLiteral("z") << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("azerty ctrl phys-W types z") << int(Qt::Key_Z) << QStringLiteral("C---") << 0x11u << QStringLiteral("z") << QStringLiteral("KeyW") << QStringLiteral("Undo");
    QTest::newRow("cyrillic ctrl phys-Y") << 0x41D << QStringLiteral("C---") << 0x15u << QString(QChar(0x43D)) << QStringLiteral("KeyY") << QStringLiteral("InsertContinueMarker");
    QTest::newRow("f1 (unmapped scan)") << int(Qt::Key_F1) << QStringLiteral("----") << 0x3Bu << QString() << QString() << QString();
    QTest::newRow("tab") << int(Qt::Key_Tab) << QStringLiteral("----") << 0x0Fu << QStringLiteral("Tab") << QString() << QString();
    QTest::newRow("escape") << int(Qt::Key_Escape) << QStringLiteral("----") << 0x01u << QStringLiteral("Escape") << QString() << QString();
    QTest::newRow("shift 1 (key ! )") << int(Qt::Key_Exclam) << QStringLiteral("--S-") << 0x02u << QStringLiteral("!") << QString() << QString();
}

void EditorInputTest::mapsMeasuredQtKeyEventsToKeyInput()
{
    QFETCH(int, qtKey);
    QFETCH(QString, mods);
    QFETCH(uint, scan);
    QFETCH(QString, key);
    QFETCH(QString, code);
    QFETCH(QString, shortcut);
    const KeyInput e = editor::keyInputFromQt(qtKey, modifiers(mods), scan);
    QCOMPARE(e.modifiers, modifiers(mods));
    QCOMPARE(e.key, key);
    QCOMPARE(e.code, code);
    QCOMPARE(shortcutName(editor::shortcutFor(e)), shortcut);
}

// The oracle is Qt itself: a QPlainTextEdit is handed each (modifiers, text) key press and either types it or not.
void EditorInputTest::insertsTextExactlyWhereQtTypes()
{
    const QList<Qt::KeyboardModifiers> mods{Qt::NoModifier,
                                            Qt::ShiftModifier,
                                            Qt::ControlModifier,
                                            Qt::ControlModifier | Qt::ShiftModifier,
                                            Qt::AltModifier,
                                            Qt::AltModifier | Qt::ShiftModifier,
                                            Qt::ControlModifier | Qt::AltModifier,
                                            Qt::MetaModifier,
                                            Qt::KeypadModifier,
                                            Qt::ControlModifier | Qt::KeypadModifier};
    const QStringList texts{QStringLiteral("a"),
                            QStringLiteral("Z"),
                            QStringLiteral("\t"),
                            QStringLiteral(" "),
                            QString(QChar(0x19)),
                            QString(QChar(0x08)),
                            QString(QChar(0x7F)),
                            QString(QChar(0x0D)),
                            QString(QChar(0x200D)),
                            QString(QChar(0xE000)),
                            QString(QChar(0xD83D)) + QChar(0xDE00),
                            QString(QChar(0xD83D)),
                            QString(QChar(0x00A0)),
                            QString(QChar(0x3131)),
                            QString(QChar(0xFDD0)),
                            QString()};
    QPlainTextEdit live;
    int typed = 0;
    for (const Qt::KeyboardModifiers m : mods) {
        for (const QString &t : texts) {
            live.setPlainText(QString());
            QKeyEvent press(QEvent::KeyPress, Qt::Key_unknown, m, t);
            QApplication::sendEvent(&live, &press);
            const bool qtTyped = !live.document()->toRawText().isEmpty();
            QVERIFY2(editor::insertsText(m, t) == qtTyped,
                     qPrintable(QStringLiteral("mods 0x%1 text U+%2: Qt typed=%3")
                                    .arg(int(m), 0, 16)
                                    .arg(t.isEmpty() ? 0 : t.at(0).unicode(), 4, 16, QLatin1Char('0'))
                                    .arg(qtTyped)));
            if (qtTyped)
                ++typed;
        }
    }
    QVERIFY(typed > 20); // non-vacuity: Qt typed a good part of the grid
    // the measured facts the widget relies on
    QVERIFY(editor::insertsText(Qt::AltModifier, QStringLiteral("q")));
    QVERIFY(!editor::insertsText(Qt::ControlModifier, QString(QChar(0x11))));
    QVERIFY(!editor::insertsText(Qt::ControlModifier | Qt::AltModifier, QString()));
}

// Every UTF-16 code unit, inserted between two letters into a fresh document: exactly the block-break characters
// make two blocks.
void EditorInputTest::blockBreakCharsAreWhatQtSplitsOn()
{
    QTextDocument doc;
    QStringList breaks;
    for (int u = 0; u <= 0xFFFF; ++u) {
        doc.setPlainText(QStringLiteral("a") + QChar(char16_t(u)) + QStringLiteral("b"));
        const bool split = doc.blockCount() > 1;
        if (split)
            breaks << QStringLiteral("%1").arg(u, 4, 16, QLatin1Char('0'));
        QVERIFY2(editor::isBlockBreakChar(QChar(char16_t(u))) == split,
                 qPrintable(QStringLiteral("U+%1 splits=%2").arg(u, 4, 16, QLatin1Char('0')).arg(split)));
    }
    QCOMPARE(breaks, (QStringList{QStringLiteral("000a"), QStringLiteral("000d"), QStringLiteral("2029"),
                                  QStringLiteral("fdd0"), QStringLiteral("fdd1")}));
    // CR LF is one break, U+2028 stays inside the block (measured)
    doc.setPlainText(QStringLiteral("a\r\nb"));
    QCOMPARE(doc.blockCount(), 2);
    doc.setPlainText(QStringLiteral("a") + QChar(0x2028) + QStringLiteral("b"));
    QCOMPARE(doc.blockCount(), 1);
}

void EditorInputTest::displayLineKeepsTheLengthAndHidesBreaks_data()
{
    QTest::addColumn<QString>("line");
    QTest::addColumn<QString>("shown");
    QTest::newRow("empty") << QString() << QString();
    QTest::newRow("plain") << QStringLiteral("abc") << QStringLiteral("abc");
    QTest::newRow("trailing CR (collected article)") << QStringLiteral("본문\r") << QStringLiteral("본문 ");
    QTest::newRow("CR LF inside a block") << QStringLiteral("a\r\nb") << QStringLiteral("a  b");
    QTest::newRow("U+2029") << QString(QChar(0x2029)) << QStringLiteral(" ");
    QTest::newRow("non-characters") << QString(QChar(0xFDD0)) + QStringLiteral("x") + QChar(0xFDD1)
                                    << QString(QChar(0xFFFD)) + QStringLiteral("x") + QChar(0xFFFD);
    QTest::newRow("U+2028 stays") << QStringLiteral("a") + QChar(0x2028) + QStringLiteral("b") << QStringLiteral("a") + QChar(0x2028) + QStringLiteral("b");
    QTest::newRow("NBSP stays") << QString(QChar(0x00A0)) << QString(QChar(0x00A0));
    QTest::newRow("marker with CR") << QStringLiteral("(끝)\r") << QStringLiteral("(끝) ");
    QTest::newRow("U+FFFC stays") << QString(QChar(0xFFFC)) << QString(QChar(0xFFFC));
}

void EditorInputTest::displayLineKeepsTheLengthAndHidesBreaks()
{
    QFETCH(QString, line);
    QFETCH(QString, shown);
    const QString got = editor::displayLine(line);
    QCOMPARE(got, shown);
    QCOMPARE(got.size(), line.size());
    for (const QChar c : got)
        QVERIFY(!editor::isBlockBreakChar(c));
    QTextDocument doc;
    doc.setPlainText(got);
    QCOMPARE(doc.blockCount(), 1);
}

void EditorInputTest::joinsTwoTextLines_data()
{
    QTest::addColumn<int>("row");
    const std::vector<JoinRow> rows = joinRows();
    for (int i = 0; i < int(rows.size()); ++i)
        QTest::newRow(rows.at(size_t(i)).name) << i;
}

void EditorInputTest::joinsTwoTextLines()
{
    QFETCH(int, row);
    const JoinRow r = joinRows().at(size_t(row));
    const QVector<Block> before = r.blocks;
    QCOMPARE(bytes(editor::joinTextLines(r.blocks, r.upper)), bytes(r.expected));
    QCOMPARE(bytes(r.blocks), bytes(before)); // input untouched
}

// Where no marker line takes part (and the pair sits before any marker line), the join is the range delete of the
// line break - replaceRangeInBlocks' rules 4 and 5 - so the two cannot drift apart.
void EditorInputTest::joinEqualsTheRangeDeleteWhenNoMarkerLineTakesPart()
{
    const Block e1 = image(QStringLiteral("one.png"));
    const Block e2 = image(QStringLiteral("two.png"));
    const std::vector<QVector<Block>> lists{
        {text(QStringLiteral("a")), text(QStringLiteral("b")), text(QStringLiteral("c"))},
        {text(QStringLiteral("a"), QStringLiteral("center")), e1, text(QStringLiteral("b"), QStringLiteral("right")), text(QStringLiteral("c"))},
        {text(QString()), text(QStringLiteral("x")), e1, e2, text(QString()), text(QStringLiteral("y"))},
        {text(QStringLiteral("제목")), text(QStringLiteral("부제")), e1, text(QStringLiteral("본문")), text(QStringLiteral("(끝)"))},
        {text(QStringLiteral("a\r")), text(QStringLiteral("b\r")), text(QStringLiteral("(끝)"))},
        {text(QStringLiteral("  ")), text(QStringLiteral("")), text(QStringLiteral("z"), QStringLiteral("justify")), e1},
    };
    int compared = 0;
    for (const QVector<Block> &list : lists) {
        int lineCount = 0;
        int firstMarker = -1;
        for (const Block &b : list) {
            if (!editor::isTextBlock(b))
                continue;
            if (firstMarker < 0 && editor::isMarkerBlock(b))
                firstMarker = lineCount;
            ++lineCount;
        }
        for (int i = 0; i + 1 < lineCount; ++i) {
            if (firstMarker >= 0 && i + 1 >= firstMarker)
                break;
            const editor::TextRange range{editor::TextPoint{i, lineEndOffset(list, i)},
                                          editor::TextPoint{i + 1, lineStartOffset(list, i + 1)}};
            const QVector<Block> viaRange = editor::replaceRangeInBlocks(list, range, QString()).blocks;
            QVERIFY2(bytes(editor::joinTextLines(list, i)) == bytes(viaRange),
                     qPrintable(bytes(list) + QStringLiteral(" join ") + QString::number(i)));
            ++compared;
        }
    }
    QCOMPARE(compared, 2 + 2 + 3 + 2 + 1 + 2);
}

void EditorInputTest::locatesANativeEditFromItsAnchor_data()
{
    QTest::addColumn<int>("row");
    const std::vector<EditRow> rows = editRows();
    for (int i = 0; i < int(rows.size()); ++i)
        QTest::newRow(rows.at(size_t(i)).name) << i;
}

void EditorInputTest::locatesANativeEditFromItsAnchor()
{
    QFETCH(int, row);
    const EditRow r = editRows().at(size_t(row));
    const std::optional<editor::TextEdit> edit =
        editor::nativeEditBetween(r.before, r.after, r.selStart, r.selEnd, r.backward);
    QCOMPARE(edit.has_value(), r.valid);
    if (!edit)
        return;
    QCOMPARE(edit->start, r.start);
    QCOMPARE(edit->removed, r.removed);
    QCOMPARE(edit->inserted, r.inserted);
    // the edit reproduces `after`
    QCOMPARE(r.before.left(edit->start) + edit->inserted + r.before.mid(edit->start + edit->removed), r.after);
}
