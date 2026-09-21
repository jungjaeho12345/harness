#include "editorcontenttest.h"

#include "repofiles.h"

#include "editor/editorcontent.h"
#include "editor/editorroles.h"

#include <QByteArray>
#include <QString>
#include <QStringList>
#include <QStringView>
#include <QVector>
#include <QtTest>

#include <initializer_list>
#include <utility>

using editor::Block;
using editor::JsonValue;

namespace {

// A UTF-16 literal copied verbatim. Not QString::fromUtf16: that one treats a leading U+FEFF as a byte
// order mark and drops it, which silently removed the BOM from the "bom" row.
QString u16(const char16_t *literal)
{
    return QStringView(literal).toString();
}

JsonValue str(const QString &value)
{
    return JsonValue::makeString(value);
}

// A JS object literal, keys applied in the order written (so a later "type" lands last, like the web).
JsonValue object(std::initializer_list<std::pair<QString, JsonValue>> members)
{
    JsonValue out = JsonValue::makeObject();
    for (const auto &member : members)
        out.insert(member.first, member.second);
    return out;
}

// What the web writes for one document holding these block bytes.
QString doc(const QString &blocksJson)
{
    return QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[") + blocksJson
           + QStringLiteral("]}");
}

// The web fallback contract: at least one block, text blocks only, joined text == the raw input.
void verifyPlainTextFallback(const QString &raw, int minimumBlocks)
{
    const QVector<Block> blocks = editor::deserialize(raw);
    QVERIFY2(blocks.size() >= minimumBlocks, qPrintable(editor::serialize(blocks)));
    for (const Block &block : blocks)
        QVERIFY(editor::isTextBlock(block));
    QStringList texts;
    for (const Block &block : blocks)
        texts.append(block.text);
    QCOMPARE(texts.join(QLatin1Char('\n')), raw);
}

} // namespace

// ---- editorContent — block model -------------------------------------------------------------

void EditorContentTest::serializeWrapsBlocksInTheDocumentShape()
{
    QCOMPARE(editor::EDITOR_FORMAT, QStringLiteral("yh-editor"));
    QCOMPARE(editor::EDITOR_VERSION, 1);
    QCOMPARE(editor::serialize({editor::textBlock(QStringLiteral("제목")), editor::textBlock(QStringLiteral("본문"))}),
             doc(QStringLiteral("{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"}")));
}

void EditorContentTest::roundTripsTextAndEmbedBlocksPreservingOrder()
{
    const QVector<Block> blocks{
        editor::textBlock(QStringLiteral("제목")),
        editor::textBlock(QStringLiteral("본문 한 줄")),
        editor::embedBlock(object({{QStringLiteral("embedType"), str(QStringLiteral("image"))},
                                   {QStringLiteral("src"), str(QStringLiteral("x.png"))}})),
        editor::textBlock(QStringLiteral("더 본문")),
    };
    const QString markup = editor::serialize(blocks);
    QCOMPARE(markup,
             doc(QStringLiteral("{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문 한 줄\"},"
                                "{\"embedType\":\"image\",\"src\":\"x.png\",\"type\":\"embed\"},"
                                "{\"type\":\"text\",\"text\":\"더 본문\"}")));
    const QVector<Block> restored = editor::deserialize(markup);
    QCOMPARE(restored.size(), blocks.size());
    QVERIFY(restored == blocks);
}

void EditorContentTest::deserializeLoadsLegacyPlainTextOneBlockPerLine()
{
    const QVector<Block> blocks = editor::deserialize(QStringLiteral("제목\n부제\n본문"));
    QCOMPARE(blocks.size(), 3);
    QVERIFY(blocks.at(0) == editor::textBlock(QStringLiteral("제목")));
    QVERIFY(blocks.at(1) == editor::textBlock(QStringLiteral("부제")));
    QVERIFY(blocks.at(2) == editor::textBlock(QStringLiteral("본문")));
}

void EditorContentTest::deserializeAcceptsABlocksArrayOrADocObject()
{
    const QVector<Block> fromArray = editor::deserialize(QStringLiteral("[{\"type\":\"text\",\"text\":\"a\"}]"));
    QCOMPARE(fromArray.size(), 1);
    QVERIFY(fromArray.at(0) == editor::textBlock(QStringLiteral("a")));

    const QVector<Block> fromDoc =
        editor::deserialize(QStringLiteral("{\"blocks\":[{\"type\":\"text\",\"text\":\"b\"}]}"));
    QCOMPARE(fromDoc.size(), 1);
    QVERIFY(fromDoc.at(0) == editor::textBlock(QStringLiteral("b")));
}

void EditorContentTest::deserializeReturnsNothingForEmptyOrNull()
{
    // '' / null / undefined on the web; a C++ string is either empty or null.
    QVERIFY(editor::deserialize(QStringLiteral("")).isEmpty());
    QVERIFY(editor::deserialize(QString()).isEmpty());
}

void EditorContentTest::normalizeBlocksDropsUnknownBlocksAndCoercesText()
{
    // web: normalizeBlocks([{type:'text',text:1}, {type:'bogus'}, embedBlock({embedType:'video'})]).
    // An unknown block and a numeric text cannot exist in a typed QVector<Block>; they arrive as JSON.
    const QVector<Block> blocks = editor::deserialize(QStringLiteral(
        "[{\"type\":\"text\",\"text\":1},{\"type\":\"bogus\"},{\"embedType\":\"video\",\"type\":\"embed\"}]"));
    QCOMPARE(blocks.size(), 2);
    QVERIFY(blocks.at(0) == editor::textBlock(QStringLiteral("1")));
    QVERIFY(editor::isEmbedBlock(blocks.at(1)));
    QCOMPARE(editor::serialize(blocks),
             doc(QStringLiteral("{\"type\":\"text\",\"text\":\"1\"},{\"embedType\":\"video\",\"type\":\"embed\"}")));
}

void EditorContentTest::isTextBlockAndIsEmbedBlockDistinguishBlockTypes()
{
    QVERIFY(editor::isTextBlock(editor::textBlock(QStringLiteral("x"))));
    QVERIFY(!editor::isEmbedBlock(editor::textBlock(QStringLiteral("x"))));
    const Block embed = editor::embedBlock(object({{QStringLiteral("embedType"), str(QStringLiteral("image"))}}));
    QVERIFY(editor::isEmbedBlock(embed));
    QVERIFY(!editor::isTextBlock(embed));
}

void EditorContentTest::blocksToTextJoinsOnlyTextBlocks()
{
    const QVector<Block> blocks{
        editor::textBlock(QStringLiteral("제목")),
        editor::embedBlock(object({{QStringLiteral("embedType"), str(QStringLiteral("image"))}})),
        editor::textBlock(QStringLiteral("본문")),
    };
    QCOMPARE(editor::blocksToText(blocks), QStringLiteral("제목\n본문"));
}

void EditorContentTest::textToBlocksSplitsLinesIntoTextBlocks()
{
    const QVector<Block> blocks = editor::textToBlocks(QStringLiteral("a\nb"));
    QCOMPARE(blocks.size(), 2);
    QVERIFY(blocks.at(0) == editor::textBlock(QStringLiteral("a")));
    QVERIFY(blocks.at(1) == editor::textBlock(QStringLiteral("b")));
    // Port additions (node): '' is one empty block (deserialize('') is none), a trailing '\n' adds one.
    QCOMPARE(editor::serialize(editor::textToBlocks(QString())), doc(QStringLiteral("{\"type\":\"text\",\"text\":\"\"}")));
    QCOMPARE(editor::serialize(editor::textToBlocks(QStringLiteral("a\n"))),
             doc(QStringLiteral("{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"\"}")));
}

void EditorContentTest::hasEndMarkerDetectsTheMarkerInTextBlocks()
{
    QVERIFY(editor::hasEndMarker({editor::textBlock(QStringLiteral("본문")), editor::textBlock(editor::END_MARKER)}));
    QVERIFY(!editor::hasEndMarker({editor::textBlock(QStringLiteral("본문"))}));
    // Text blocks only: the marker spelled inside an embed payload is not the article's marker.
    QVERIFY(!editor::hasEndMarker(
        {editor::embedBlock(object({{QStringLiteral("title"), str(editor::END_MARKER)}}))}));
}

// ---- editorContent — deserialize 전량 드롭 폴백 (원문 보존) ------------------------------------------

void EditorContentTest::fallsBackToPlainTextForAJsonStringArray()
{
    verifyPlainTextFallback(QStringLiteral("[\"첫 줄 원문\",\"둘째 줄 원문\",\"셋째 줄 원문\"]"), 1);
}

void EditorContentTest::fallsBackPreservingEachLineForPrettyPrintedJson()
{
    verifyPlainTextFallback(QStringLiteral("[\n  \"원문 가\",\n  \"원문 나\"\n]"), 2);
}

void EditorContentTest::fallsBackForAnArrayOfForeignSchemaObjects()
{
    verifyPlainTextFallback(
        QStringLiteral("[{\"paragraph\":\"원본 문단 하나\"},{\"paragraph\":\"원본 문단 둘\"}]"), 1);
}

void EditorContentTest::fallsBackForADocWhoseBlocksAreAllUnknown()
{
    verifyPlainTextFallback(
        QStringLiteral("{\"format\":\"other-editor\",\"blocks\":[{\"kind\":\"p\",\"body\":\"살릴 원문\"}]}"), 1);
}

void EditorContentTest::keepsIntentionallyEmptyDocumentsEmpty()
{
    QVERIFY(editor::deserialize(QStringLiteral("[]")).isEmpty());
    QVERIFY(editor::deserialize(editor::serialize({})).isEmpty());
    QVERIFY(editor::deserialize(QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")).isEmpty());
}

void EditorContentTest::keepsPartialDropBehaviour()
{
    const QVector<Block> fromArray =
        editor::deserialize(QStringLiteral("[{\"type\":\"text\",\"text\":\"정상 블록\"},{\"kind\":\"bogus\"}]"));
    QCOMPARE(fromArray.size(), 1);
    QVERIFY(fromArray.at(0) == editor::textBlock(QStringLiteral("정상 블록")));

    const QVector<Block> fromDoc = editor::deserialize(
        QStringLiteral("{\"blocks\":[{\"type\":\"text\",\"text\":\"정상 블록\"},{\"kind\":\"bogus\"}]}"));
    QCOMPARE(fromDoc.size(), 1);
    QVERIFY(fromDoc.at(0) == editor::textBlock(QStringLiteral("정상 블록")));
}

// ---- editorContent — align 필드 (보기 정렬) --------------------------------------------------------

void EditorContentTest::alignValuesWhitelistTheFourAlignments()
{
    QCOMPARE(editor::ALIGN_VALUES, (QStringList{QStringLiteral("left"), QStringLiteral("center"),
                                                QStringLiteral("right"), QStringLiteral("justify")}));
    for (const QString &value : editor::ALIGN_VALUES)
        QVERIFY(editor::isValidAlign(value));
    QVERIFY(!editor::isValidAlign(QStringLiteral("bogus")));
    QVERIFY(!editor::isValidAlign(QString())); // undefined / null on the web
    QVERIFY(!editor::isValidAlign(QStringLiteral("")));
    QVERIFY(!editor::isValidAlign(QStringLiteral("Center"))); // includes() is exact
}

void EditorContentTest::textBlockAttachesOnlyAValidAlign()
{
    QCOMPARE(editor::textBlock(QStringLiteral("x"), QStringLiteral("right")).align, QStringLiteral("right"));
    QVERIFY(editor::textBlock(QStringLiteral("x")).align.isEmpty());
    QVERIFY(editor::textBlock(QStringLiteral("x"), QStringLiteral("bad")).align.isEmpty());
    // 'align' in block === false <=> the key is absent from the stored bytes.
    QCOMPARE(editor::serialize({editor::textBlock(QStringLiteral("x"), QStringLiteral("right"))}),
             doc(QStringLiteral("{\"type\":\"text\",\"text\":\"x\",\"align\":\"right\"}")));
    QCOMPARE(editor::serialize({editor::textBlock(QStringLiteral("x"))}),
             doc(QStringLiteral("{\"type\":\"text\",\"text\":\"x\"}")));
    QCOMPARE(editor::serialize({editor::textBlock(QStringLiteral("x"), QStringLiteral("bad"))}),
             doc(QStringLiteral("{\"type\":\"text\",\"text\":\"x\"}")));
}

void EditorContentTest::normalizeBlocksPreservesAValidAlignAndDropsAnInvalidOne()
{
    Block centered;
    centered.text = QStringLiteral("a");
    centered.align = QStringLiteral("center");
    Block bogus;
    bogus.text = QStringLiteral("a");
    bogus.align = QStringLiteral("bogus");
    Block plain;
    plain.text = QStringLiteral("a");

    const QVector<Block> input{centered, bogus, plain};
    const QVector<Block> normalized = editor::normalizeBlocks(input);
    QCOMPARE(normalized.size(), 3);
    QCOMPARE(normalized.at(0).align, QStringLiteral("center"));
    QVERIFY(normalized.at(1).align.isEmpty());
    QVERIFY(normalized.at(2).align.isEmpty());
    QCOMPARE(normalized.at(1).text, QStringLiteral("a"));
    // Nothing here mutates its input.
    QCOMPARE(input.at(1).align, QStringLiteral("bogus"));
}

void EditorContentTest::normalizeBlocksLeavesEmbedBlocksUntouched()
{
    const Block embed = editor::embedBlock(object({{QStringLiteral("embedType"), str(QStringLiteral("image"))},
                                                   {QStringLiteral("src"), str(QStringLiteral("x"))},
                                                   {QStringLiteral("align"), str(QStringLiteral("center"))}}));
    const QVector<Block> normalized = editor::normalizeBlocks({embed});
    QCOMPARE(normalized.size(), 1);
    QVERIFY(normalized.at(0) == embed);
    QCOMPARE(editor::serialize(normalized),
             doc(QStringLiteral("{\"embedType\":\"image\",\"src\":\"x\",\"align\":\"center\",\"type\":\"embed\"}")));
}

void EditorContentTest::serializeDeserializeRoundTripsAlign()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("제목"), QStringLiteral("center")),
                                editor::textBlock(QStringLiteral("본문"))};
    const QString markup = editor::serialize(blocks);
    QCOMPARE(markup, doc(QStringLiteral("{\"type\":\"text\",\"text\":\"제목\",\"align\":\"center\"},"
                                        "{\"type\":\"text\",\"text\":\"본문\"}")));
    QVERIFY(editor::deserialize(markup) == blocks);
}

void EditorContentTest::unalignedSerializationHasNoAlignKey()
{
    const QString markup = editor::serialize({editor::textBlock(QStringLiteral("본문"))});
    QVERIFY(!markup.contains(QStringLiteral("align")));
    QCOMPARE(markup, doc(QStringLiteral("{\"type\":\"text\",\"text\":\"본문\"}")));
}

// ---- port locks --------------------------------------------------------------------------------

// The header is part of the stored bytes and the contract froze it: Article.markupVersion is described
// as '{"format":"yh-editor","version":1,"blocks":[...]}'. The serializer's own prefix has to appear there
// verbatim - a changed EDITOR_FORMAT / EDITOR_VERSION (or key order) goes red here, not on the server.
void EditorContentTest::formatAndVersionMatchTheFrozenContract()
{
    QByteArray bytes;
    QString error;
    QVERIFY2(readRepoFile(QStringLiteral("docs/api-contract/openapi.yaml"), &bytes, &error), qPrintable(error));
    const QString contract = QString::fromUtf8(bytes);

    const QString empty = editor::serialize({});
    QCOMPARE(empty, QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}"));
    const QString header = empty.chopped(2); // drop "]}" -> {"format":...,"blocks":[
    QVERIFY2(contract.contains(header + QStringLiteral("...]}")),
             qPrintable(QStringLiteral("openapi.yaml does not describe markupVersion as %1...]}").arg(header)));
}

void EditorContentTest::reproducesTheWebSerializerBytes_data()
{
    QTest::addColumn<QString>("input");
    QTest::addColumn<QString>("serialized"); // web serialize(deserialize(input))
    QTest::addColumn<int>("count");          // web deserialize(input).length
    QTest::addColumn<QString>("text");       // web blocksToText(deserialize(input))
    QTest::addColumn<bool>("marker");        // web hasEndMarker(deserialize(input))

    // Generated from web/src/view/editorContent.js under node 24 (2026-09-22). Row names are ASCII.
    QTest::newRow("empty") << QString()
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << 0 << QString() << false;
    QTest::newRow("webDoc") << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"}]}")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"}]}")
        << 2 << u16(u"제목" u"\x000a" u"본문") << false;
    QTest::newRow("legacy") << u16(u"제목" u"\x000a" u"부제" u"\x000a" u"본문")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"부제\"},{\"type\":\"text\",\"text\":\"본문\"}]}")
        << 3 << u16(u"제목" u"\x000a" u"부제" u"\x000a" u"본문") << false;
    QTest::newRow("crlf") << u16(u"a" u"\x000d" u"\x000a" u"b" u"\x000d" u"\x000a")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\\r\"},{\"type\":\"text\",\"text\":\"b\\r\"},{\"type\":\"text\",\"text\":\"\"}]}")
        << 3 << u16(u"a" u"\x000d" u"\x000a" u"b" u"\x000d" u"\x000a") << false;
    QTest::newRow("bom") << u16(u"\xfeff" u"[{\"type\":\"text\",\"text\":\"a\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"" u"\xfeff" u"[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"a\\\"}]\"}]}")
        << 1 << u16(u"\xfeff" u"[{\"type\":\"text\",\"text\":\"a\"}]") << false;
    QTest::newRow("arrOfBlocks") << u16(u"[{\"type\":\"text\",\"text\":\"a\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"}]}")
        << 1 << u16(u"a") << false;
    QTest::newRow("docBlocks") << u16(u"{\"blocks\":[{\"type\":\"text\",\"text\":\"b\"}]}")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"b\"}]}")
        << 1 << u16(u"b") << false;
    QTest::newRow("objNoBlocks") << u16(u"{\"a\":1}")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"{\\\"a\\\":1}\"}]}")
        << 1 << u16(u"{\"a\":1}") << false;
    QTest::newRow("topString") << u16(u"\"abc\"")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\\\"abc\\\"\"}]}")
        << 1 << u16(u"\"abc\"") << false;
    QTest::newRow("topNumber") << u16(u"  12 ")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"  12 \"}]}")
        << 1 << u16(u"  12 ") << false;
    QTest::newRow("topNull") << u16(u"null")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"null\"}]}")
        << 1 << u16(u"null") << false;
    QTest::newRow("trailingComma") << u16(u"[{\"type\":\"text\",\"text\":\"a\"},]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"a\\\"},]\"}]}")
        << 1 << u16(u"[{\"type\":\"text\",\"text\":\"a\"},]") << false;
    QTest::newRow("leadingZero") << u16(u"[{\"type\":\"embed\",\"w\":01}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[{\\\"type\\\":\\\"embed\\\",\\\"w\\\":01}]\"}]}")
        << 1 << u16(u"[{\"type\":\"embed\",\"w\":01}]") << false;
    QTest::newRow("coerce") << u16(u"[{\"type\":\"text\",\"text\":1},{\"type\":\"bogus\"},{\"type\":\"embed\",\"embedType\":\"video\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"1\"},{\"type\":\"embed\",\"embedType\":\"video\"}]}")
        << 2 << u16(u"1") << false;
    QTest::newRow("coerce2") << u16(u"[{\"type\":\"text\",\"text\":true},{\"type\":\"text\",\"text\":null},{\"type\":\"text\"},{\"type\":\"text\",\"text\":[1,[2,null],\"x\",{\"a\":1}]},{\"type\":\"text\",\"text\":{\"a\":1}},{\"type\":\"text\",\"text\":1.5e300},{\"type\":\"text\",\"text\":-0},{\"type\":\"text\",\"text\":0.000001},{\"type\":\"text\",\"text\":1e-7},{\"type\":\"text\",\"text\":1e21},{\"type\":\"text\",\"text\":123456789012345680000}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"true\"},{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"1,2,,x,[object Object]\"},{\"type\":\"text\",\"text\":\"[object Object]\"},{\"type\":\"text\",\"text\":\"1.5e+300\"},{\"type\":\"text\",\"text\":\"0\"},{\"type\":\"text\",\"text\":\"0.000001\"},{\"type\":\"text\",\"text\":\"1e-7\"},{\"type\":\"text\",\"text\":\"1e+21\"},{\"type\":\"text\",\"text\":\"123456789012345680000\"}]}")
        << 11 << u16(u"true" u"\x000a" u"\x000a" u"\x000a" u"1,2,,x,[object Object]" u"\x000a" u"[object Object]" u"\x000a" u"1.5e+300" u"\x000a" u"0" u"\x000a" u"0.000001" u"\x000a" u"1e-7" u"\x000a" u"1e+21" u"\x000a" u"123456789012345680000") << false;
    QTest::newRow("alignKeep") << u16(u"[{\"type\":\"text\",\"text\":\"a\",\"align\":\"center\"},{\"type\":\"text\",\"text\":\"b\",\"align\":\"bogus\"},{\"text\":\"c\",\"align\":\"left\",\"type\":\"text\",\"extra\":1}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\",\"align\":\"center\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"c\",\"align\":\"left\"}]}")
        << 3 << u16(u"a" u"\x000a" u"b" u"\x000a" u"c") << false;
    QTest::newRow("embedOrder") << u16(u"[{\"embedType\":\"image\",\"src\":\"x.png\",\"alt\":\"\",\"widthPercent\":17,\"heightPercent\":17,\"figureWidthPx\":612,\"type\":\"embed\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x.png\",\"alt\":\"\",\"widthPercent\":17,\"heightPercent\":17,\"figureWidthPx\":612,\"type\":\"embed\"}]}")
        << 1 << QString() << false;
    QTest::newRow("embedTypeFirst") << u16(u"[{\"type\":\"embed\",\"embedType\":\"table\",\"rows\":[[\"a\",\"b\"],[\"c\",\"\"]],\"align\":\"center\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"embed\",\"embedType\":\"table\",\"rows\":[[\"a\",\"b\"],[\"c\",\"\"]],\"align\":\"center\"}]}")
        << 1 << QString() << false;
    QTest::newRow("numericKeys") << u16(u"[{\"type\":\"embed\",\"b\":1,\"2\":2,\"a\":3,\"1\":4,\"01\":5,\"4294967295\":6,\"4294967294\":7}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"1\":4,\"2\":2,\"4294967294\":7,\"type\":\"embed\",\"b\":1,\"a\":3,\"01\":5,\"4294967295\":6}]}")
        << 1 << QString() << false;
    QTest::newRow("dupKeys") << u16(u"[{\"type\":\"embed\",\"a\":1,\"b\":2,\"a\":3}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"embed\",\"a\":3,\"b\":2}]}")
        << 1 << QString() << false;
    QTest::newRow("numbers") << u16(u"[{\"type\":\"embed\",\"n\":[0,-0,1.0,1E2,1e+2,-1.5e-3,1e400,5e-324,0.1,123.456,1e21,1e20,-1e-7,100,2.5e-6]}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"embed\",\"n\":[0,0,1,100,100,-0.0015,null,5e-324,0.1,123.456,1e+21,100000000000000000000,-1e-7,100,0.0000025]}]}")
        << 1 << QString() << false;
    QTest::newRow("escapes") << u16(u"{\"blocks\":[{\"type\":\"text\",\"text\":\"q\\\"b\\\\s/\\b\\f\\n\\r\\t\\u0001\\u001b\\u001f" u"\x007f" u"\x2028" u"\x2029" u"😀\"},{\"type\":\"text\",\"text\":\"lone\\ud800x\\udc00\"}]}")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"q\\\"b\\\\s/\\b\\f\\n\\r\\t\\u0001\\u001b\\u001f" u"\x007f" u"\x2028" u"\x2029" u"😀\"},{\"type\":\"text\",\"text\":\"lone\\ud800x\\udc00\"}]}")
        << 2 << u16(u"q\"b\\s/" u"\x0008" u"\x000c" u"\x000a" u"\x000d" u"\x0009" u"\x0001" u"\x001b" u"\x001f" u"\x007f" u"\x2028" u"\x2029" u"😀" u"\x000a" u"lone" u"\xd800" u"x" u"\xdc00") << false;
    QTest::newRow("escapesInEmbed") << u16(u"[{\"type\":\"embed\",\"s\":\"\\u0041\\u00e9\\uD83D\\uDE00\\ud800\\/\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"embed\",\"s\":\"Aé😀\\ud800/\"}]}")
        << 1 << QString() << false;
    QTest::newRow("rawControlInString") << u16(u"[{\"type\":\"text\",\"text\":\"a" u"\x0001" u"b\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"a\\u0001b\\\"}]\"}]}")
        << 1 << u16(u"[{\"type\":\"text\",\"text\":\"a" u"\x0001" u"b\"}]") << false;
    QTest::newRow("whitespace") << u16(u" " u"\x0009" u"\x000d" u"\x000a" u"[ {\"type\" : \"text\" ," u"\x000a" u" \"text\":\"w\"} ] " u"\x000a")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"w\"}]}")
        << 1 << u16(u"w") << false;
    QTest::newRow("emptyArr") << u16(u"[]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << 0 << QString() << false;
    QTest::newRow("emptyDoc") << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << 0 << QString() << false;
    QTest::newRow("emptyDocFull") << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << 0 << QString() << false;
    QTest::newRow("stringArray") << u16(u"[\"첫 줄 원문\",\"둘째 줄 원문\",\"셋째 줄 원문\"]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[\\\"첫 줄 원문\\\",\\\"둘째 줄 원문\\\",\\\"셋째 줄 원문\\\"]\"}]}")
        << 1 << u16(u"[\"첫 줄 원문\",\"둘째 줄 원문\",\"셋째 줄 원문\"]") << false;
    QTest::newRow("pretty") << u16(u"[" u"\x000a" u"  \"원문 가\"," u"\x000a" u"  \"원문 나\"" u"\x000a" u"]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[\"},{\"type\":\"text\",\"text\":\"  \\\"원문 가\\\",\"},{\"type\":\"text\",\"text\":\"  \\\"원문 나\\\"\"},{\"type\":\"text\",\"text\":\"]\"}]}")
        << 4 << u16(u"[" u"\x000a" u"  \"원문 가\"," u"\x000a" u"  \"원문 나\"" u"\x000a" u"]") << false;
    QTest::newRow("foreign") << u16(u"[{\"paragraph\":\"원본 문단 하나\"},{\"paragraph\":\"원본 문단 둘\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[{\\\"paragraph\\\":\\\"원본 문단 하나\\\"},{\\\"paragraph\\\":\\\"원본 문단 둘\\\"}]\"}]}")
        << 1 << u16(u"[{\"paragraph\":\"원본 문단 하나\"},{\"paragraph\":\"원본 문단 둘\"}]") << false;
    QTest::newRow("docForeign") << u16(u"{\"format\":\"other-editor\",\"blocks\":[{\"kind\":\"p\",\"body\":\"살릴 원문\"}]}")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"{\\\"format\\\":\\\"other-editor\\\",\\\"blocks\\\":[{\\\"kind\\\":\\\"p\\\",\\\"body\\\":\\\"살릴 원문\\\"}]}\"}]}")
        << 1 << u16(u"{\"format\":\"other-editor\",\"blocks\":[{\"kind\":\"p\",\"body\":\"살릴 원문\"}]}") << false;
    QTest::newRow("partial") << u16(u"[{\"type\":\"text\",\"text\":\"정상 블록\"},{\"kind\":\"bogus\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"정상 블록\"}]}")
        << 1 << u16(u"정상 블록") << false;
    QTest::newRow("partialDoc") << u16(u"{\"blocks\":[{\"type\":\"text\",\"text\":\"정상 블록\"},{\"kind\":\"bogus\"}]}")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"정상 블록\"}]}")
        << 1 << u16(u"정상 블록") << false;
    QTest::newRow("typeNotString") << u16(u"[{\"type\":[\"text\"],\"text\":\"a\"},{\"type\":\"TEXT\",\"text\":\"b\"},{\"type\":\"embed \"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[{\\\"type\\\":[\\\"text\\\"],\\\"text\\\":\\\"a\\\"},{\\\"type\\\":\\\"TEXT\\\",\\\"text\\\":\\\"b\\\"},{\\\"type\\\":\\\"embed \\\"}]\"}]}")
        << 1 << u16(u"[{\"type\":[\"text\"],\"text\":\"a\"},{\"type\":\"TEXT\",\"text\":\"b\"},{\"type\":\"embed \"}]") << false;
    QTest::newRow("nonObjElements") << u16(u"[null,1,\"text\",[{\"type\":\"text\"}],{\"type\":\"text\",\"text\":\"ok\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ok\"}]}")
        << 1 << u16(u"ok") << false;
    QTest::newRow("badEscape") << u16(u"[{\"type\":\"text\",\"text\":\"\\x41\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"\\\\x41\\\"}]\"}]}")
        << 1 << u16(u"[{\"type\":\"text\",\"text\":\"\\x41\"}]") << false;
    QTest::newRow("badUnicode") << u16(u"[{\"type\":\"text\",\"text\":\"\\u12\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"\\\\u12\\\"}]\"}]}")
        << 1 << u16(u"[{\"type\":\"text\",\"text\":\"\\u12\"}]") << false;
    QTest::newRow("literalsBad") << u16(u"[{\"type\":\"text\",\"text\":tru}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"[{\\\"type\\\":\\\"text\\\",\\\"text\\\":tru}]\"}]}")
        << 1 << u16(u"[{\"type\":\"text\",\"text\":tru}]") << false;
    QTest::newRow("protoKey") << u16(u"[{\"type\":\"embed\",\"__proto__\":{\"x\":1},\"k\":\"v\"}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"embed\",\"__proto__\":{\"x\":1},\"k\":\"v\"}]}")
        << 1 << QString() << false;
    QTest::newRow("nestedEmbedObj") << u16(u"[{\"type\":\"embed\",\"meta\":{\"z\":1,\"a\":{\"y\":2,\"b\":3},\"1\":0}}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"embed\",\"meta\":{\"1\":0,\"z\":1,\"a\":{\"y\":2,\"b\":3}}}]}")
        << 1 << QString() << false;
    QTest::newRow("deepOk") << u16(u"[{\"type\":\"embed\",\"d\":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]}]")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"embed\",\"d\":[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]}]}")
        << 1 << QString() << false;
    QTest::newRow("markerOnly") << u16(u"(끝)")
        << u16(u"{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << 1 << u16(u"(끝)") << true;
}

void EditorContentTest::reproducesTheWebSerializerBytes()
{
    QFETCH(QString, input);
    QFETCH(QString, serialized);
    QFETCH(int, count);
    QFETCH(QString, text);
    QFETCH(bool, marker);

    const QVector<Block> blocks = editor::deserialize(input);
    QCOMPARE(editor::serialize(blocks), serialized);
    QCOMPARE(blocks.size(), count);
    QCOMPARE(editor::blocksToText(blocks), text);
    QCOMPARE(editor::hasEndMarker(blocks), marker);
    // The canonical form is a fixed point: loading what we would save changes nothing.
    QCOMPARE(editor::serialize(editor::deserialize(serialized)), serialized);
}

void EditorContentTest::embedBlockSetsTypeLikeTheObjectSpread()
{
    // {...{embedType, src}, type:'embed'} appends "type"; an existing "type" keeps its place.
    QCOMPARE(editor::serialize({editor::embedBlock(object({{QStringLiteral("embedType"), str(QStringLiteral("image"))},
                                                           {QStringLiteral("src"), str(QStringLiteral("x"))}}))}),
             doc(QStringLiteral("{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}")));
    QCOMPARE(editor::serialize({editor::embedBlock(object({{QStringLiteral("type"), str(QStringLiteral("text"))},
                                                           {QStringLiteral("embedType"), str(QStringLiteral("image"))},
                                                           {QStringLiteral("src"), str(QStringLiteral("x"))}}))}),
             doc(QStringLiteral("{\"type\":\"embed\",\"embedType\":\"image\",\"src\":\"x\"}")));
    // No argument / a non-object argument spreads to {}.
    QCOMPARE(editor::serialize({editor::embedBlock()}), doc(QStringLiteral("{\"type\":\"embed\"}")));
    QCOMPARE(editor::serialize({editor::embedBlock(str(QStringLiteral("x")))}), doc(QStringLiteral("{\"type\":\"embed\"}")));

    // An embed block built without the factory is repaired by normalizeBlocks the same way.
    Block raw;
    raw.type = Block::Type::Embed;
    raw.embed = object({{QStringLiteral("embedType"), str(QStringLiteral("video"))}});
    QCOMPARE(editor::serialize({raw}), doc(QStringLiteral("{\"embedType\":\"video\",\"type\":\"embed\"}")));
    QCOMPARE(raw.embed.members.size(), size_t(1)); // the caller's block is untouched
}
