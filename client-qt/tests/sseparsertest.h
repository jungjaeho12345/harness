#ifndef CLIENT_QT_TESTS_SSEPARSERTEST_H
#define CLIENT_QT_TESTS_SSEPARSERTEST_H

#include <QObject>

// The pure SSE frame parser (phase 77 step9 A), locked with byte fixtures copied from
// docs/api-contract/sse.md. Nothing in the web tree ever locked the wire framing - the browser's
// EventSource parsed it invisibly (net port spec sse R10) - so these cases are the first lock.
//
// The parser is an incremental state machine: chunk boundaries have nothing to do with frame
// boundaries (half a frame, or three and a half, may come in one read). Every fixture is also fed
// split at every byte position and one byte at a time, and must give the same events.
class SseParserTest : public QObject
{
    Q_OBJECT

private slots:
    void parsesOneFrame();
    void parsesTheContractVocabularyInOneChunk();
    void givesTheSameEventsWhereverTheChunksSplit();
    void keepsHalfAFrameUntilItsBlankLine();
    void dispatchesNothingWithoutTheBlankLine();
    void namesAFrameWithoutAnEventLineMessage();
    void dispatchesAnEmptyDataLineAsEmptyData();
    void dropsAFrameWithoutDataAndForgetsItsName();
    void passesUnknownEventNamesThrough();
    void ignoresCommentsIdRetryAndUnknownFields();
    void joinsSeveralDataLinesWithLf();
    void stripsOnlyOneSpaceAfterTheColon();
    void acceptsCrLfAndCrLineEnds();
    void keepsACrLfSplitAcrossChunksOneLineEnd();
    void keepsUtf8BytesSplitAcrossChunks();
    void resetForgetsAPartialFrame();
};

#endif // CLIENT_QT_TESTS_SSEPARSERTEST_H
