#include "sseparsertest.h"

#include "net/sseparser.h"

#include <QByteArray>
#include <QString>
#include <QStringList>
#include <QVector>
#include <QtTest>

using net::SseEvent;
using net::SseParser;

namespace {

// docs/api-contract/sse.md 40-53, byte for byte (the blank terminator lines are real LFs here).
const QByteArray kReady = "event: ready\ndata: {\"ok\":true}\n\n";
const QByteArray kChange = "event: change\ndata: {\"kind\":\"update\"}\n\n";
const QByteArray kLog = "event: log\ndata: {\"seq\":42,\"ts\":1755590400000,\"level\":\"INFO\",\"message\":\"<redacted>\","
                        "\"line\":\"[YYYY-MM-DD HH:MM:SS] [INFO] <redacted>\"}\n\n";
const QByteArray kUnauthorized = "event: unauthorized\ndata: {\"ok\":false,\"reason\":\"unauthenticated\"}\n\n";
const QByteArray kVocabulary = kReady + kChange + kLog + kUnauthorized;

// "name|data" per event, joined with " ; " - one QCOMPARE shows every difference at once.
QString describe(const QVector<SseEvent> &events)
{
    QStringList parts;
    for (const SseEvent &event : events)
        parts << event.name + QLatin1Char('|') + QString::fromUtf8(event.data);
    return parts.join(QStringLiteral(" ; "));
}

QVector<SseEvent> feedAll(const QByteArray &bytes)
{
    SseParser parser;
    return parser.feed(bytes);
}

QVector<SseEvent> feedByteByByte(const QByteArray &bytes)
{
    SseParser parser;
    QVector<SseEvent> events;
    for (qsizetype i = 0; i < bytes.size(); ++i)
        events += parser.feed(bytes.mid(i, 1));
    return events;
}

} // namespace

void SseParserTest::parsesOneFrame()
{
    // server/index.js:1137 - the ready frame the server writes right after the headers.
    const QVector<SseEvent> events = feedAll(kReady);
    QCOMPARE(events.size(), 1);
    QCOMPARE(events.first().name, QStringLiteral("ready"));
    QCOMPARE(events.first().data, QByteArray("{\"ok\":true}"));
}

void SseParserTest::parsesTheContractVocabularyInOneChunk()
{
    // Four frames in one read - the parser must not assume one frame per chunk.
    QCOMPARE(describe(feedAll(kVocabulary)),
             QStringLiteral("ready|{\"ok\":true} ; change|{\"kind\":\"update\"} ; "
                            "log|{\"seq\":42,\"ts\":1755590400000,\"level\":\"INFO\",\"message\":\"<redacted>\","
                            "\"line\":\"[YYYY-MM-DD HH:MM:SS] [INFO] <redacted>\"} ; "
                            "unauthorized|{\"ok\":false,\"reason\":\"unauthenticated\"}"));
}

void SseParserTest::givesTheSameEventsWhereverTheChunksSplit()
{
    const QString whole = describe(feedAll(kVocabulary));
    QVERIFY(!whole.isEmpty());

    // Every two-way split.
    for (qsizetype cut = 0; cut <= kVocabulary.size(); ++cut) {
        SseParser parser;
        QVector<SseEvent> events = parser.feed(kVocabulary.left(cut));
        events += parser.feed(kVocabulary.mid(cut));
        QVERIFY2(describe(events) == whole, qPrintable(QStringLiteral("split at %1").arg(cut)));
    }
    // One byte per read.
    QCOMPARE(describe(feedByteByByte(kVocabulary)), whole);
    // Three and a half frames, then the other half.
    const qsizetype threeAndAHalf = kReady.size() + kChange.size() + kLog.size() + kUnauthorized.size() / 2;
    SseParser parser;
    const QVector<SseEvent> first = parser.feed(kVocabulary.left(threeAndAHalf));
    QCOMPARE(first.size(), 3);
    const QVector<SseEvent> second = parser.feed(kVocabulary.mid(threeAndAHalf));
    QCOMPARE(second.size(), 1);
    QCOMPARE(second.first().name, QStringLiteral("unauthorized"));
}

void SseParserTest::keepsHalfAFrameUntilItsBlankLine()
{
    SseParser parser;
    QVERIFY(parser.feed("event: cha").isEmpty());
    QVERIFY(parser.feed("nge\ndata: {\"kind\":\"up").isEmpty());
    QVERIFY(parser.feed("date\"}\n").isEmpty());  // a complete data line is NOT a complete frame
    const QVector<SseEvent> events = parser.feed("\n");
    QCOMPARE(describe(events), QStringLiteral("change|{\"kind\":\"update\"}"));
}

// sse.md 35 CRITICAL: without the blank line the browser dispatches nothing - neither does this.
void SseParserTest::dispatchesNothingWithoutTheBlankLine()
{
    QVERIFY(feedAll("event: ready\ndata: {\"ok\":true}\n").isEmpty());
    QVERIFY(feedAll("event: change\ndata: {\"kind\":\"create\"}").isEmpty());
    QVERIFY(feedAll("event: unauthorized\ndata: {\"ok\":false,\"reason\":\"unauthenticated\"}\n").isEmpty());
    // Two data lines and no terminator: still nothing (a per-line dispatch would emit two events).
    QVERIFY(feedAll("event: change\ndata: a\ndata: b\n").isEmpty());
}

void SseParserTest::namesAFrameWithoutAnEventLineMessage()
{
    // WHATWG: no event field -> the default type "message" (not part of this contract's vocabulary).
    QCOMPARE(describe(feedAll("data: {\"kind\":\"create\"}\n\n")), QStringLiteral("message|{\"kind\":\"create\"}"));
}

void SseParserTest::dispatchesAnEmptyDataLineAsEmptyData()
{
    const QVector<SseEvent> bare = feedAll("event: change\ndata:\n\n");
    QCOMPARE(bare.size(), 1);
    QCOMPARE(bare.first().name, QStringLiteral("change"));
    QVERIFY(bare.first().data.isEmpty());

    const QVector<SseEvent> spaced = feedAll("event: change\ndata: \n\n");
    QCOMPARE(spaced.size(), 1);
    QVERIFY(spaced.first().data.isEmpty());
}

void SseParserTest::dropsAFrameWithoutDataAndForgetsItsName()
{
    // WHATWG: an empty data buffer dispatches nothing and clears the event type - the name must not
    // leak into the next frame.
    SseParser parser;
    QVERIFY(parser.feed("event: change\n\n").isEmpty());
    QCOMPARE(describe(parser.feed("data: x\n\n")), QStringLiteral("message|x"));
}

void SseParserTest::passesUnknownEventNamesThrough()
{
    // The parser does not know the vocabulary (ChangeStream does); an unknown name is an event
    // like any other and the frames after it still parse.
    QCOMPARE(describe(feedAll("event: bogus\ndata: 1\n\n" + kChange)),
             QStringLiteral("bogus|1 ; change|{\"kind\":\"update\"}"));
}

void SseParserTest::ignoresCommentsIdRetryAndUnknownFields()
{
    // sse.md 36: id:/retry: are never sent; if they were, they would change nothing here.
    const QByteArray bytes = ": keep-alive comment\n"
                             "id: 7\n"
                             "retry: 10\n"
                             "foo: bar\n"
                             "event: change\n"
                             "data: {\"kind\":\"lock\"}\n"
                             "\n";
    QCOMPARE(describe(feedAll(bytes)), QStringLiteral("change|{\"kind\":\"lock\"}"));
    QCOMPARE(describe(feedAll(": only a comment\n\n")), QString());
}

void SseParserTest::joinsSeveralDataLinesWithLf()
{
    QCOMPARE(describe(feedAll("event: change\ndata: a\ndata: b\n\n")), QStringLiteral("change|a\nb"));
}

void SseParserTest::stripsOnlyOneSpaceAfterTheColon()
{
    QCOMPARE(describe(feedAll("event:ready\ndata:{\"ok\":true}\n\n")), QStringLiteral("ready|{\"ok\":true}"));
    QCOMPARE(describe(feedAll("event: change\ndata:  x\n\n")), QStringLiteral("change| x"));
}

// The contract is LF (sse.md 34). DECISION: CRLF and a lone CR are ACCEPTED as line ends, as the
// browser's EventSource accepts them (WHATWG) - the canonical client stood on that parser. Being
// stricter would turn a proxy that rewrites line ends into the sse.md 35 failure mode: nothing is
// dispatched, so the unauthorized frame is never seen and the client never stops reconnecting.
void SseParserTest::acceptsCrLfAndCrLineEnds()
{
    const QString expected = QStringLiteral("ready|{\"ok\":true} ; change|{\"kind\":\"update\"}");
    QByteArray crlf = kReady + kChange;
    crlf.replace("\n", "\r\n");
    QCOMPARE(describe(feedAll(crlf)), expected);
    QCOMPARE(describe(feedByteByByte(crlf)), expected);

    QByteArray cr = kReady + kChange;
    cr.replace("\n", "\r");
    QCOMPARE(describe(feedAll(cr)), expected);
    QCOMPARE(describe(feedByteByByte(cr)), expected);

    // Mixed within one frame.
    QCOMPARE(describe(feedAll("event: change\r\ndata: {\"kind\":\"update\"}\n\r\n")),
             QStringLiteral("change|{\"kind\":\"update\"}"));
}

void SseParserTest::keepsACrLfSplitAcrossChunksOneLineEnd()
{
    // A CR at the end of one read and its LF at the start of the next are ONE line end. Counted as
    // two, the blank line would dispatch the event line early and the data would arrive as "message".
    SseParser parser;
    QVector<SseEvent> events = parser.feed("event: change\r");
    events += parser.feed("\ndata: {\"kind\":\"create\"}\r");
    events += parser.feed("\n\r");
    events += parser.feed("\n");
    QCOMPARE(describe(events), QStringLiteral("change|{\"kind\":\"create\"}"));
}

void SseParserTest::keepsUtf8BytesSplitAcrossChunks()
{
    // LF/CR never occur inside a UTF-8 sequence, so a byte-level split is safe; the data stays bytes.
    const QByteArray kind = QStringLiteral("변경").toUtf8();  // two Hangul syllables
    const QByteArray frame = "event: change\ndata: {\"kind\":\"" + kind + "\"}\n\n";
    const QVector<SseEvent> events = feedByteByByte(frame);
    QCOMPARE(events.size(), 1);
    QCOMPARE(events.first().data, QByteArray("{\"kind\":\"" + kind + "\"}"));
}

void SseParserTest::resetForgetsAPartialFrame()
{
    SseParser parser;
    QVERIFY(parser.feed("event: unauthorized\ndata: {\"ok\":false").isEmpty());
    parser.reset();  // a new connection starts clean: the half frame of the old one is gone
    QCOMPARE(describe(parser.feed(kReady)), QStringLiteral("ready|{\"ok\":true}"));
    // A data line without its blank line, then a reset: the data does not ride into the next frame.
    QVERIFY(parser.feed("event: change\ndata: stale\n").isEmpty());
    parser.reset();
    QCOMPARE(describe(parser.feed(kChange)), QStringLiteral("change|{\"kind\":\"update\"}"));
}
