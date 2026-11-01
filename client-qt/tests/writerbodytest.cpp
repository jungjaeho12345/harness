#include "writerbodytest.h"

#include "editor/editorcontent.h"
#include "editor/editornewline.h"
#include "editor/editorroles.h"
#include "editor/writerbody.h"

#include <QString>
#include <QStringView>
#include <QtTest>

// web/src/view/writerBody.js bodyTitle, run by node 24 (scratchpad s9-gen-rows.mjs - the rows below are its output,
// unedited): legacy plain text and yh-editor JSON, JS trim (U+FEFF trimmed, U+0085 kept - the two code points where
// QString::trimmed disagrees), the ideographic space, embeds that do not count, CRLF, broken / foreign JSON.
void WriterBodyTest::bodyTitleMatchesTheWeb_data()
{
    QTest::addColumn<QString>("body");
    QTest::addColumn<QString>("title");
    QTest::newRow("empty") << QStringView(u"").toString() << QStringView(u"").toString();
    QTest::newRow("legacyTwoLines") << QStringView(u"Title line\nbody (\ub05d)").toString() << QStringView(u"Title line").toString();
    QTest::newRow("jsonThreeBlocks") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"T1\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(\ub05d)\"}]}").toString() << QStringView(u"T1").toString();
    QTest::newRow("jsTrimSpaces") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"  spaced  \"},{\"type\":\"text\",\"text\":\"x\"}]}").toString() << QStringView(u"spaced").toString();
    QTest::newRow("firstLineEmpty") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"second\"}]}").toString() << QStringView(u"").toString();
    QTest::newRow("bomTrimmedByJs") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\ufeffbom\"},{\"type\":\"text\",\"text\":\"x\"}]}").toString() << QStringView(u"bom").toString();
    QTest::newRow("nelKeptByJs") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\u0085nel\"},{\"type\":\"text\",\"text\":\"x\"}]}").toString() << QStringView(u"\u0085nel").toString();
    QTest::newRow("ideographicSpace") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\u3000wide\u3000\"}]}").toString() << QStringView(u"wide").toString();
    QTest::newRow("embedFirst") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"kind\":\"image\",\"src\":\"a.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"after embed\"}]}").toString() << QStringView(u"after embed").toString();
    QTest::newRow("embedsOnly") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"kind\":\"image\",\"src\":\"a.png\",\"type\":\"embed\"}]}").toString() << QStringView(u"").toString();
    QTest::newRow("legacyCrlf") << QStringView(u"crlf\r\nnext").toString() << QStringView(u"crlf").toString();
    QTest::newRow("brokenJson") << QStringView(u"{").toString() << QStringView(u"{").toString();
    QTest::newRow("jsonWithoutBlocks") << QStringView(u"{\"a\":1}").toString() << QStringView(u"{\"a\":1}").toString();
    QTest::newRow("hangulTitle") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\ud55c\uae00 \uc81c\ubaa9\"},{\"type\":\"text\",\"text\":\"\ubcf8\ubb38\"},{\"type\":\"text\",\"text\":\"(\ub05d)\"}]}").toString() << QStringView(u"\ud55c\uae00 \uc81c\ubaa9").toString();
    QTest::newRow("markerOnly") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(\ub05d)\"}]}").toString() << QStringView(u"(\ub05d)").toString();
    QTest::newRow("tabAndNbsp") << QStringView(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\\t\u00a0x\u00a0\\t\"}]}").toString() << QStringView(u"x").toString();
}

void WriterBodyTest::bodyTitleMatchesTheWeb()
{
    QFETCH(QString, body);
    QFETCH(QString, title);
    QCOMPARE(editor::bodyTitle(body), title);
    QCOMPARE(editor::bodyTitle(body), editor::bodyTitle(QString(body)));  // pure: same input, same answer
}

// writerBody.serializeBodyFromBlocks = serialize(renormalizeEndMarker(blocks)) - step3's P3 table locks that equality
// with the web byte for byte; here the one name of it moves the marker last, folds two into one, leaves a body
// without a marker line alone and keeps a "(끝)" glued to text where it is.
void WriterBodyTest::serializeBodyFromBlocksRenormalizesTheMarker()
{
    using editor::END_MARKER;
    using editor::textBlock;
    const QVector<editor::Block> markerInside{textBlock(QStringLiteral("a")), textBlock(END_MARKER), textBlock(QStringLiteral("b"))};
    QCOMPARE(editor::serializeBodyFromBlocks(markerInside),
             editor::serialize({textBlock(QStringLiteral("a")), textBlock(QStringLiteral("b")), textBlock(END_MARKER)}));
    const QVector<editor::Block> twoMarkers{textBlock(END_MARKER, QStringLiteral("center")), textBlock(QStringLiteral("x")),
                                            textBlock(END_MARKER)};
    QCOMPARE(editor::serializeBodyFromBlocks(twoMarkers),
             editor::serialize({textBlock(QStringLiteral("x")), textBlock(END_MARKER, QStringLiteral("center"))}));
    const QVector<editor::Block> none{textBlock(QStringLiteral("no marker")), textBlock(QStringLiteral("here"))};
    QCOMPARE(editor::serializeBodyFromBlocks(none), editor::serialize(none));
    const QVector<editor::Block> glued{textBlock(QStringLiteral("text") + END_MARKER), textBlock(QStringLiteral("after"))};
    QCOMPARE(editor::serializeBodyFromBlocks(glued), editor::serialize(glued));
    for (const QVector<editor::Block> &blocks : {markerInside, twoMarkers, none, glued})
        QCOMPARE(editor::serializeBodyFromBlocks(blocks), editor::serialize(editor::renormalizeEndMarker(blocks)));
    QCOMPARE(editor::serializeBodyFromBlocks({}), editor::serialize({}));
}
