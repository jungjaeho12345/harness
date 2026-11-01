#ifndef CLIENT_QT_TESTS_EDITORCONTENTTEST_H
#define CLIENT_QT_TESTS_EDITORCONTENTTEST_H

#include <QObject>

// editor::serialize / deserialize / normalizeBlocks / textBlock / embedBlock / blocksToText /
// textToBlocks / hasEndMarker / ALIGN_VALUES (phase 78 step1) - the body block model.
//
// The first 22 functions are web/src/view/editorContent.test.js, one per `it`, in the same order
// (describe "block model" 10 · "전량 드롭 폴백" 6 · "align 필드" 6). Where the web passes a JS array or
// object to deserialize, the port passes its JSON text - a C++ caller holds either a string or an
// already-typed QVector<Block>, never an untyped JS value.
//
// The last three are the port's own locks: the header bytes against the frozen contract, a byte-parity
// table whose every expected value was produced by running the canonical web module under node
// (2026-09-22 - serialize(deserialize(x)), block count, blocksToText, hasEndMarker), and the
// embedBlock spread semantics.
class EditorContentTest : public QObject
{
    Q_OBJECT

private slots:
    // editorContent — block model
    void serializeWrapsBlocksInTheDocumentShape();
    void roundTripsTextAndEmbedBlocksPreservingOrder();
    void deserializeLoadsLegacyPlainTextOneBlockPerLine();
    void deserializeAcceptsABlocksArrayOrADocObject();
    void deserializeReturnsNothingForEmptyOrNull();
    void normalizeBlocksDropsUnknownBlocksAndCoercesText();
    void isTextBlockAndIsEmbedBlockDistinguishBlockTypes();
    void blocksToTextJoinsOnlyTextBlocks();
    void textToBlocksSplitsLinesIntoTextBlocks();
    void hasEndMarkerDetectsTheMarkerInTextBlocks();

    // editorContent — deserialize 전량 드롭 폴백 (원문 보존)
    void fallsBackToPlainTextForAJsonStringArray();
    void fallsBackPreservingEachLineForPrettyPrintedJson();
    void fallsBackForAnArrayOfForeignSchemaObjects();
    void fallsBackForADocWhoseBlocksAreAllUnknown();
    void keepsIntentionallyEmptyDocumentsEmpty();
    void keepsPartialDropBehaviour();

    // editorContent — align 필드 (보기 정렬)
    void alignValuesWhitelistTheFourAlignments();
    void textBlockAttachesOnlyAValidAlign();
    void normalizeBlocksPreservesAValidAlignAndDropsAnInvalidOne();
    void normalizeBlocksLeavesEmbedBlocksUntouched();
    void serializeDeserializeRoundTripsAlign();
    void unalignedSerializationHasNoAlignKey();

    // Port locks
    void formatAndVersionMatchTheFrozenContract();
    void reproducesTheWebSerializerBytes_data();
    void reproducesTheWebSerializerBytes();
    void embedBlockSetsTypeLikeTheObjectSpread();
};

#endif // CLIENT_QT_TESTS_EDITORCONTENTTEST_H
