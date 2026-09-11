#include "changestreamtest.h"

#include "ssestubserver.h"
#include "stubhttpserver.h"

#include "net/changestream.h"
#include "net/httptransport.h"
#include "shell/diag.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QPair>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QtTest>

using net::ChangeStream;
using net::CloseReason;

namespace {

using Close = QPair<CloseReason, int>;

const QByteArray kJson = "application/json; charset=utf-8";

// Short ladders so the tests measure real waiting without taking long: 40, 80, 160, 320, 320 ...
net::ChangeStreamOptions fast(int openTimeoutMs = 3000)
{
    net::ChangeStreamOptions options;
    options.backoffBaseMs = 40;
    options.backoffCapMs = 320;
    options.openTimeoutMs = openTimeoutMs;
    return options;
}

// Everything a stream says, in order. Declared before the stream it listens to (outlives it).
struct Recorder {
    int ready = 0;
    QStringList kinds;  // one per changed()
    int unauthorized = 0;
    QList<Close> closes;
    QStringList order;

    void attach(ChangeStream &stream)
    {
        QObject::connect(&stream, &ChangeStream::readyReceived, [this] {
            ++ready;
            order << QStringLiteral("ready");
        });
        QObject::connect(&stream, &ChangeStream::changed, [this](const QString &kind) {
            kinds << kind;
            order << QStringLiteral("change:") + kind;
        });
        QObject::connect(&stream, &ChangeStream::unauthorized, [this] {
            ++unauthorized;
            order << QStringLiteral("unauthorized");
        });
        QObject::connect(&stream, &ChangeStream::disconnected, [this](CloseReason reason, int status) {
            closes << Close(reason, status);
            order << QStringLiteral("closed:") + net::closeReasonName(reason);
        });
    }
};

SseAnswer loginAnswer()
{
    SseAnswer answer = SseAnswer::complete(
        200, kJson, R"json({"ok":true,"sessionId":"sid-sse","user":{"userId":"desk","role":"D"}})json");
    answer.headers.append({"Set-Cookie", sessionCookieLine("sid-sse")});
    return answer;
}

SseAnswer unauthenticated401()
{
    return SseAnswer::complete(401, kJson, R"json({"ok":false,"reason":"unauthenticated"})json");
}

net::RequestSpec loginSpec()
{
    net::RequestSpec spec;
    spec.routeId = QStringLiteral("login");
    spec.method = QStringLiteral("POST");
    spec.path = QStringLiteral("/api/login");
    spec.body = QJsonObject{{QStringLiteral("userId"), QStringLiteral("desk")},
                            {QStringLiteral("password"), QStringLiteral("pw")}};
    return spec;
}

net::RequestSpec sessionSpec()
{
    net::RequestSpec spec;
    spec.routeId = QStringLiteral("session");
    spec.path = QStringLiteral("/api/session");
    return spec;
}

QList<QJsonObject> readEvents(const QString &path)
{
    QList<QJsonObject> events;
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        return events;
    for (const QByteArray &line : file.readAll().split('\n')) {
        if (!line.trimmed().isEmpty())
            events << QJsonDocument::fromJson(line).object();
    }
    return events;
}

QStringList names(const QList<QJsonObject> &events)
{
    QStringList out;
    for (const QJsonObject &event : events)
        out << event.value(QStringLiteral("event")).toString();
    return out;
}

QList<QJsonObject> only(const QList<QJsonObject> &events, const QString &name)
{
    QList<QJsonObject> out;
    for (const QJsonObject &event : events) {
        if (event.value(QStringLiteral("event")).toString() == name)
            out << event;
    }
    return out;
}

QString describe(const QList<Close> &closes)
{
    QStringList parts;
    for (const Close &close : closes)
        parts << net::closeReasonName(close.first) + QLatin1Char('/') + QString::number(close.second);
    return parts.join(QStringLiteral(", "));
}

// Waits well past the whole reconnect ladder of fast() (40 + 80 + 160 + 320 ms): a stream that was
// going to reconnect has done so by now.
void waitPastTheLadder()
{
    QTest::qWait(700);
}

} // namespace

// ---------------------------------------------------------------------------------------------
// pure helpers

void ChangeStreamTest::judgesTheContentType_data()
{
    QTest::addColumn<QByteArray>("contentType");
    QTest::addColumn<bool>("isStream");

    QTest::newRow("the server's value (sse.md 23)") << QByteArray("text/event-stream; charset=utf-8") << true;
    QTest::newRow("no parameters") << QByteArray("text/event-stream") << true;
    QTest::newRow("case and spaces") << QByteArray(" TEXT/Event-Stream ;charset=UTF-8") << true;
    QTest::newRow("captive portal") << QByteArray("text/html; charset=utf-8") << false;
    QTest::newRow("json") << QByteArray("application/json; charset=utf-8") << false;
    QTest::newRow("text/plain") << QByteArray("text/plain") << false;
    QTest::newRow("a longer subtype") << QByteArray("text/event-streamx") << false;
    QTest::newRow("a suffixed subtype") << QByteArray("text/event-stream-v2; charset=utf-8") << false;
    QTest::newRow("missing") << QByteArray() << false;
}

void ChangeStreamTest::judgesTheContentType()
{
    QFETCH(QByteArray, contentType);
    QFETCH(bool, isStream);
    QCOMPARE(net::isEventStreamContentType(contentType), isStream);
}

void ChangeStreamTest::growsTheReconnectDelay_data()
{
    QTest::addColumn<int>("attempt");
    QTest::addColumn<int>("base");
    QTest::addColumn<int>("cap");
    QTest::addColumn<int>("expected");

    // step9.md: 1 s -> 2 s -> 4 s ..., capped at 30 s.
    QTest::newRow("1st") << 1 << 1000 << 30000 << 1000;
    QTest::newRow("2nd") << 2 << 1000 << 30000 << 2000;
    QTest::newRow("3rd") << 3 << 1000 << 30000 << 4000;
    QTest::newRow("4th") << 4 << 1000 << 30000 << 8000;
    QTest::newRow("5th") << 5 << 1000 << 30000 << 16000;
    QTest::newRow("6th hits the cap") << 6 << 1000 << 30000 << 30000;
    QTest::newRow("7th stays at the cap") << 7 << 1000 << 30000 << 30000;
    QTest::newRow("40th does not overflow") << 40 << 1000 << 30000 << 30000;
    QTest::newRow("0 is the first") << 0 << 1000 << 30000 << 1000;
    QTest::newRow("negative is the first") << -3 << 1000 << 30000 << 1000;
    QTest::newRow("test ladder 1st") << 1 << 40 << 320 << 40;
    QTest::newRow("test ladder 4th") << 4 << 40 << 320 << 320;
}

void ChangeStreamTest::growsTheReconnectDelay()
{
    QFETCH(int, attempt);
    QFETCH(int, base);
    QFETCH(int, cap);
    QFETCH(int, expected);
    QCOMPARE(net::reconnectDelayMs(attempt, base, cap), expected);
}

void ChangeStreamTest::spellsTheCloseReasons()
{
    // step9.md: sse-closed{reason} uses exactly these four values.
    QCOMPARE(net::closeReasonName(CloseReason::PreOpenRejected), QStringLiteral("pre-open-rejected"));
    QCOMPARE(net::closeReasonName(CloseReason::UnauthorizedFrame), QStringLiteral("unauthorized-frame"));
    QCOMPARE(net::closeReasonName(CloseReason::Transient), QStringLiteral("transient"));
    QCOMPARE(net::closeReasonName(CloseReason::Stopped), QStringLiteral("stopped"));
}

// ---------------------------------------------------------------------------------------------
// an open stream

void ChangeStreamTest::opensTheStreamWithTheSessionCookie()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    stub.handle([](const StubRequest &request, int) {
        return request.target == "/api/login" ? loginAnswer() : SseAnswer::stream(kSseReadyFrame);
    });
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString diagPath = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);
    net::HttpTransport transport(stub.origin(), &diag);
    QCOMPARE(transport.send(loginSpec()).status, 200);

    Recorder rec;
    ChangeStream stream(&transport, &diag, fast());
    rec.attach(stream);
    QVERIFY(!stream.isConnected());  // httpModel.test.js:387 - not connected before ready
    stream.start();
    QVERIFY(stream.isRunning());
    QVERIFY(!stream.isConnected());
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 1, 5000);
    QVERIFY(stream.isConnected());

    // EventSource sends the cookie and nothing else to authenticate (httpModel.js:305-314):
    // no x-session-id, no ?session= query, no x-edit-client, no Origin.
    QCOMPARE(stub.requestCount(), 2);
    const StubRequest &request = stub.requests().at(1);
    QCOMPARE(request.method, QByteArray("GET"));
    QCOMPARE(request.target, QByteArray("/api/stream"));
    QVERIFY2(request.header("cookie").contains("sid=sid-sse"), request.header("cookie").constData());
    QCOMPARE(request.header("accept"), QByteArray("text/event-stream"));
    QVERIFY(!request.hasHeader("x-session-id"));
    QVERIFY(!request.hasHeader("x-edit-client"));
    QVERIFY(!request.hasHeader("origin"));
    QVERIFY(!request.hasHeader("referer"));
    QVERIFY(request.body.isEmpty());

    // One net-request line for the stream (the route ledger needs it - step11 expects "stream"),
    // then sse-open when the head passed, sse-ready on the frame.
    const QList<QJsonObject> events = readEvents(diagPath);
    QCOMPARE(names(events), (QStringList{QStringLiteral("net-request"), QStringLiteral("net-request"),
                                         QStringLiteral("sse-open"), QStringLiteral("sse-ready")}));
    const QJsonObject line = events.at(1);
    QCOMPARE(line.value(QStringLiteral("route")).toString(), QStringLiteral("stream"));
    QCOMPARE(line.value(QStringLiteral("method")).toString(), QStringLiteral("GET"));
    QCOMPARE(line.value(QStringLiteral("status")).toInt(), 200);
    QVERIFY(line.value(QStringLiteral("ms")).isDouble());

    stream.stop();
}

void ChangeStreamTest::raisesOneSignalPerChangeWhateverTheKind()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString diagPath = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);
    net::HttpTransport transport(stub.origin(), &diag);

    Recorder rec;
    ChangeStream stream(&transport, &diag, fast());
    rec.attach(stream);
    stream.start();
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 1, 5000);

    const QByteArray frames = sseChangeFrame("create") + sseChangeFrame("update") + sseChangeFrame("status")
                              + sseChangeFrame("lock")
                              + "event: log\ndata: {\"seq\":1}\n\n"              // the log stream's word
                              + "data: {\"kind\":\"create\"}\n\n"                 // no event line = message
                              + "event: bogus\ndata: {\"kind\":\"create\"}\n\n"   // outside the vocabulary
                              + sseChangeFrame("someday-a-new-kind")              // a kind nobody knows yet
                              + "event: change\ndata:\n\n"                        // empty data (R3)
                              + "event: change\ndata: not-json\n\n"               // unparseable (R3)
                              + "event: change\ndata: [\"kind\"]\n\n";            // JSON, not an object
    stub.write(0, frames);
    QTRY_COMPARE_WITH_TIMEOUT(rec.kinds.size(), 8, 5000);
    QTest::qWait(50);

    // Every change frame is the same signal - the kind never decides whether it goes up (L80).
    QCOMPARE(rec.kinds, (QStringList{QStringLiteral("create"), QStringLiteral("update"), QStringLiteral("status"),
                                     QStringLiteral("lock"), QStringLiteral("someday-a-new-kind"), QString(),
                                     QString(), QString()}));
    QCOMPARE(rec.ready, 1);
    QCOMPARE(rec.unauthorized, 0);
    QVERIFY(rec.closes.isEmpty());
    QVERIFY(stream.isConnected());

    // The diag carries the kind for the record (null when there is none) - one line per frame.
    const QList<QJsonObject> changes = only(readEvents(diagPath), QStringLiteral("sse-change"));
    QCOMPARE(changes.size(), 8);
    QCOMPARE(changes.at(0).value(QStringLiteral("kind")).toString(), QStringLiteral("create"));
    QCOMPARE(changes.at(4).value(QStringLiteral("kind")).toString(), QStringLiteral("someday-a-new-kind"));
    QVERIFY(changes.at(5).value(QStringLiteral("kind")).isNull());
    QVERIFY(changes.at(7).value(QStringLiteral("kind")).isNull());
    stream.stop();
}

// The M9-1 guard on the wire: a frame split over several HTTP chunks (several reads) goes out once,
// at its blank line - not at its data line.
void ChangeStreamTest::assemblesAFrameSplitAcrossHttpChunks()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);
    Recorder rec;
    ChangeStream stream(&transport, nullptr, fast());
    rec.attach(stream);
    stream.start();
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 1, 5000);

    stub.write(0, "event: cha");
    QTest::qWait(60);
    QVERIFY(rec.kinds.isEmpty());
    stub.write(0, "nge\ndata: {\"kind\":\"up");
    QTest::qWait(60);
    QVERIFY(rec.kinds.isEmpty());
    stub.write(0, "date\"}\n");
    QTest::qWait(60);
    QVERIFY2(rec.kinds.isEmpty(), "a complete data line is not a complete frame");
    stub.write(0, "\n");
    QTRY_COMPARE_WITH_TIMEOUT(rec.kinds, QStringList{QStringLiteral("update")}, 5000);
    stream.stop();
}

// Override L127 / net port spec R11: receiving frames is not session activity. The stream sends
// nothing but GET /api/stream - no session check, no touch, no keep-alive request of its own -
// across frames, a drop and a reconnect.
void ChangeStreamTest::neverSendsAnythingButTheStreamRequest()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    stub.handle([](const StubRequest &, int index) {
        return index == 0 ? SseAnswer::streamThenEnd(kSseReadyFrame + sseChangeFrame("create"))
                          : SseAnswer::stream(kSseReadyFrame + sseChangeFrame("update"));
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    Recorder rec;
    ChangeStream stream(&transport, nullptr, fast());
    rec.attach(stream);
    stream.start();
    QTRY_COMPARE_WITH_TIMEOUT(rec.kinds.size(), 2, 5000);
    QTest::qWait(300);

    QCOMPARE(rec.ready, 2);
    QCOMPARE(stub.requestCount(), 2);
    for (const StubRequest &request : stub.requests()) {
        QCOMPARE(request.method, QByteArray("GET"));
        QCOMPARE(request.target, QByteArray("/api/stream"));
    }
    stream.stop();
}

// ---------------------------------------------------------------------------------------------
// the three terminal paths

void ChangeStreamTest::stopsForGoodOnTheUnauthorizedFrame()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString diagPath = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);
    net::HttpTransport transport(stub.origin(), &diag);

    Recorder rec;
    ChangeStream stream(&transport, &diag, fast());
    rec.attach(stream);
    stream.start();
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 1, 5000);

    stub.write(0, kSseUnauthorizedFrame);
    QTRY_COMPARE_WITH_TIMEOUT(rec.unauthorized, 1, 5000);
    stub.end(0);  // the server's res.end() right after the frame (sse.md 60)

    QCOMPARE(describe(rec.closes), QStringLiteral("unauthorized-frame/-1"));
    QCOMPARE(rec.order, (QStringList{QStringLiteral("ready"), QStringLiteral("closed:unauthorized-frame"),
                                     QStringLiteral("unauthorized")}));
    QVERIFY(!stream.isConnected());
    QVERIFY(!stream.isRunning());
    QTRY_VERIFY_WITH_TIMEOUT(!stub.isOpen(0), 5000);  // the client hung up itself

    // Reconnect 0: the canonical's 327-329 failure mode is a dead session re-knocking forever.
    waitPastTheLadder();
    QCOMPARE(stub.streamRequestCount(), 1);
    QCOMPARE(rec.closes.size(), 1);  // the server's own close afterwards is not a second event

    const QList<QJsonObject> events = readEvents(diagPath);
    QCOMPARE(only(events, QStringLiteral("sse-unauthorized")).size(), 1);
    const QList<QJsonObject> closed = only(events, QStringLiteral("sse-closed"));
    QCOMPARE(closed.size(), 1);
    QCOMPARE(closed.first().value(QStringLiteral("reason")).toString(), QStringLiteral("unauthorized-frame"));
    QVERIFY(!closed.first().contains(QStringLiteral("status")));
}

// Net port spec sse (c): the server writes the frame and ends the response at once, so the bytes and
// the close arrive together. The frame must still be read - reacting to the close first would file
// it as a transient drop and reconnect.
void ChangeStreamTest::readsTheUnauthorizedFrameThatArrivesWithTheClose()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    stub.handle([](const StubRequest &, int index) {
        return index == 0 ? SseAnswer::streamThenEnd(kSseReadyFrame + kSseUnauthorizedFrame + sseChangeFrame("create"))
                          : SseAnswer::stream(kSseReadyFrame);
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    Recorder rec;
    ChangeStream stream(&transport, nullptr, fast());
    rec.attach(stream);
    stream.start();
    QTRY_VERIFY_WITH_TIMEOUT(!rec.closes.isEmpty(), 5000);

    waitPastTheLadder();
    QCOMPARE(describe(rec.closes), QStringLiteral("unauthorized-frame/-1"));
    QCOMPARE(rec.unauthorized, 1);
    QCOMPARE(rec.ready, 1);
    QVERIFY2(rec.kinds.isEmpty(), "nothing after the terminal frame goes out (httpModel.js:335-336)");
    QCOMPARE(stub.streamRequestCount(), 1);
}

void ChangeStreamTest::rejectsA401BeforeTheStreamOpens()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    int streams = 0;
    stub.handle([&streams](const StubRequest &request, int) {
        if (request.target == "/api/login")
            return loginAnswer();
        if (request.target == "/api/session")
            return SseAnswer::complete(401, kJson, R"json({"ok":false,"reason":"unauthenticated"})json");
        return ++streams == 1 ? unauthenticated401() : SseAnswer::stream(kSseReadyFrame);
    });
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString diagPath = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);
    net::HttpTransport transport(stub.origin(), &diag);
    QCOMPARE(transport.send(loginSpec()).status, 200);

    Recorder rec;
    ChangeStream stream(&transport, &diag, fast());
    rec.attach(stream);
    stream.start();
    QTRY_VERIFY_WITH_TIMEOUT(!rec.closes.isEmpty(), 5000);

    // Reconnect 0 and "session over" (step9.md AC). EventSource fails such a connection without
    // scheduling a retry (WHATWG) - httpModel.js has no line for it because the browser did it.
    waitPastTheLadder();
    QCOMPARE(describe(rec.closes), QStringLiteral("pre-open-rejected/401"));
    QCOMPARE(rec.unauthorized, 1);
    QCOMPARE(rec.order, (QStringList{QStringLiteral("closed:pre-open-rejected"), QStringLiteral("unauthorized")}));
    QCOMPARE(rec.ready, 0);
    QVERIFY(rec.kinds.isEmpty());
    QCOMPARE(stub.streamRequestCount(), 1);
    QVERIFY(!stream.isRunning());
    QVERIFY(stub.requests().at(1).header("cookie").contains("sid=sid-sse"));

    // 401 + unauthenticated disposes of the session on this path exactly as send() does.
    transport.send(sessionSpec());
    QVERIFY2(!stub.requests().last().hasHeader("cookie"), stub.requests().last().header("cookie").constData());

    const QList<QJsonObject> events = readEvents(diagPath);
    QVERIFY(only(events, QStringLiteral("sse-open")).isEmpty());
    QVERIFY(only(events, QStringLiteral("sse-unauthorized")).isEmpty());  // no frame was read
    const QList<QJsonObject> closed = only(events, QStringLiteral("sse-closed"));
    QCOMPARE(closed.size(), 1);
    QCOMPARE(closed.first().value(QStringLiteral("reason")).toString(), QStringLiteral("pre-open-rejected"));
    QCOMPARE(closed.first().value(QStringLiteral("status")).toInt(), 401);
}

void ChangeStreamTest::rejectsA503BeforeTheStreamOpensWithoutEndingTheSession()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    int streams = 0;
    stub.handle([&streams](const StubRequest &request, int) {
        if (request.target == "/api/login")
            return loginAnswer();
        if (request.target == "/api/session")
            return SseAnswer::complete(200, kJson, R"json({"ok":true,"user":{"userId":"desk"}})json");
        return ++streams == 1 ? SseAnswer::complete(503, kJson, R"json({"ok":false,"reason":"unavailable"})json")
                              : SseAnswer::stream(kSseReadyFrame);
    });
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString diagPath = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);
    net::HttpTransport transport(stub.origin(), &diag);
    QCOMPARE(transport.send(loginSpec()).status, 200);

    Recorder rec;
    ChangeStream stream(&transport, &diag, fast());
    rec.attach(stream);
    stream.start();
    QTRY_VERIFY_WITH_TIMEOUT(!rec.closes.isEmpty(), 5000);

    waitPastTheLadder();
    QCOMPARE(describe(rec.closes), QStringLiteral("pre-open-rejected/503"));
    QCOMPARE(rec.unauthorized, 0);  // "real-time is down" - not "the session is over"
    QCOMPARE(stub.streamRequestCount(), 1);
    QVERIFY(!stream.isRunning());

    transport.send(sessionSpec());
    QVERIFY(stub.requests().last().header("cookie").contains("sid=sid-sse"));  // the session stays

    const QList<QJsonObject> closed = only(readEvents(diagPath), QStringLiteral("sse-closed"));
    QCOMPARE(closed.size(), 1);
    QCOMPARE(closed.first().value(QStringLiteral("reason")).toString(), QStringLiteral("pre-open-rejected"));
    QCOMPARE(closed.first().value(QStringLiteral("status")).toInt(), 503);
}

void ChangeStreamTest::neverParsesA200ThatIsNotAnEventStream_data()
{
    QTest::addColumn<QByteArray>("contentType");
    QTest::addColumn<bool>("streamed");

    QTest::newRow("captive portal page") << QByteArray("text/html; charset=utf-8") << false;
    QTest::newRow("no Content-Type") << QByteArray() << false;
    QTest::newRow("json") << QByteArray("application/json; charset=utf-8") << false;
    QTest::newRow("a longer subtype") << QByteArray("text/event-streamx") << false;
    QTest::newRow("html that keeps coming") << QByteArray("text/html; charset=utf-8") << true;
}

// sse.md 20-30: the headers are the client's verdict. A proxy or a captive portal answering 200 with
// something that merely LOOKS like frames must not be fed to the parser.
void ChangeStreamTest::neverParsesA200ThatIsNotAnEventStream()
{
    QFETCH(QByteArray, contentType);
    QFETCH(bool, streamed);

    // Well-formed frames the parser WOULD dispatch - only the Content-Type keeps them out.
    const QByteArray looksLikeFrames = kSseReadyFrame + sseChangeFrame("create") + kSseUnauthorizedFrame;
    SseStubServer stub;
    QVERIFY(stub.listen());
    stub.handle([contentType, streamed, looksLikeFrames](const StubRequest &, int index) {
        if (index > 0)
            return SseAnswer::stream(kSseReadyFrame);  // a reconnect would be visible
        SseAnswer answer = streamed ? SseAnswer::stream(looksLikeFrames)
                                    : SseAnswer::complete(200, contentType, looksLikeFrames);
        answer.contentType = contentType;
        return answer;
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    Recorder rec;
    ChangeStream stream(&transport, nullptr, fast());
    rec.attach(stream);
    stream.start();
    QTRY_VERIFY_WITH_TIMEOUT(!rec.closes.isEmpty(), 5000);

    waitPastTheLadder();
    QCOMPARE(describe(rec.closes), QStringLiteral("pre-open-rejected/200"));
    QCOMPARE(rec.ready, 0);
    QVERIFY(rec.kinds.isEmpty());
    QCOMPARE(rec.unauthorized, 0);
    QCOMPARE(stub.streamRequestCount(), 1);
    if (streamed)
        QTRY_VERIFY_WITH_TIMEOUT(!stub.isOpen(0), 5000);  // the client did not keep reading it
}

// ---------------------------------------------------------------------------------------------
// the one retried path

void ChangeStreamTest::reconnectsWithAGrowingDelayAfterTransientDrops()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    // The head, then the end - no ready, every time: each connection is one more failure.
    stub.handle([](const StubRequest &, int) { return SseAnswer::streamThenEnd(QByteArray()); });
    net::HttpTransport transport(stub.origin(), nullptr);
    Recorder rec;
    ChangeStream stream(&transport, nullptr, fast());
    rec.attach(stream);
    stream.start();
    QTRY_VERIFY_WITH_TIMEOUT(stub.streamRequestCount() >= 6, 8000);
    stream.stop();

    // Measured on the stub's side: the gap between two requests is the delay the client waited.
    const QList<qint64> arrivals = stub.arrivalMs();
    const QList<int> expected{40, 80, 160, 320, 320};
    QList<qint64> gaps;
    for (int i = 0; i < expected.size(); ++i)
        gaps << arrivals.at(i + 1) - arrivals.at(i);
    QString spacing;
    for (qint64 gap : gaps)
        spacing += QString::number(gap) + QLatin1Char(' ');
    qInfo("reconnect gaps on the wire (ms), ladder 40/80/160/320/320: %s", qPrintable(spacing));
    for (int i = 0; i < expected.size(); ++i)
        QVERIFY2(gaps.at(i) >= expected.at(i) - 25, qPrintable(QStringLiteral("gaps(ms): ") + spacing));
    QVERIFY2(gaps.at(3) >= gaps.at(0) + 200, qPrintable(QStringLiteral("the delay must grow - gaps(ms): ") + spacing));

    QVERIFY(rec.closes.size() >= 6);
    for (int i = 0; i + 1 < rec.closes.size(); ++i)
        QCOMPARE(describe({rec.closes.at(i)}), QStringLiteral("transient/-1"));
    QCOMPARE(describe({rec.closes.last()}), QStringLiteral("stopped/-1"));
    QCOMPARE(rec.unauthorized, 0);
    QCOMPARE(rec.ready, 0);
}

void ChangeStreamTest::restartsTheDelayOnceTheStreamIsReady()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    stub.handle([](const StubRequest &, int index) {
        return index < 2 ? SseAnswer::streamThenEnd(QByteArray()) : SseAnswer::stream(kSseReadyFrame);
    });
    net::ChangeStreamOptions options;
    options.backoffBaseMs = 150;
    options.backoffCapMs = 2400;
    net::HttpTransport transport(stub.origin(), nullptr);
    Recorder rec;
    ChangeStream stream(&transport, nullptr, options);
    rec.attach(stream);
    stream.start();
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 1, 5000);  // the third connection

    // The ladder climbed before the ready: 150, then 300.
    const qint64 secondRung = stub.arrivalMs().at(2) - stub.arrivalMs().at(1);
    QVERIFY2(secondRung >= 275, qPrintable(QString::number(secondRung)));

    const qint64 cut = stub.nowMs();
    stub.end(2);  // the ready stream ends
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 2, 5000);
    const qint64 again = stub.arrivalMs().at(3) - cut;
    qInfo("second rung %lld ms; after a ready, the next reconnect came %lld ms after the drop", secondRung, again);
    // Back to the base (150), not the next rung (600): a stream that proved alive starts over.
    QVERIFY2(again >= 125 && again < 450, qPrintable(QString::number(again)));
    stream.stop();
}

void ChangeStreamTest::reconnectsWhenTheServerNeverAnswers()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    stub.handle([](const StubRequest &, int index) {
        return index == 0 ? SseAnswer::silent() : SseAnswer::stream(kSseReadyFrame);
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    Recorder rec;
    ChangeStream stream(&transport, nullptr, fast(300));
    rec.attach(stream);
    stream.start();
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 1, 5000);

    // No head within the open deadline is no answer: transient, not rejected.
    QCOMPARE(describe(rec.closes), QStringLiteral("transient/-1"));
    QCOMPARE(rec.unauthorized, 0);
    QCOMPARE(stub.streamRequestCount(), 2);
    const qint64 gap = stub.arrivalMs().at(1) - stub.arrivalMs().at(0);
    QVERIFY2(gap >= 290, qPrintable(QString::number(gap)));  // the deadline was really waited
    stream.stop();
}

// No HTTP answer at all is transient - EventSource re-establishes after a network error (WHATWG);
// the server being down for a restart must not end real-time for good. (Windows reports a refused
// loopback connection only after ~4.1 s - step7's measurement - hence the long wait.)
void ChangeStreamTest::treatsARefusedConnectionAsTransient()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString diagPath = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);
    const quint16 port = unusedLocalPort();
    QVERIFY(port != 0);
    net::HttpTransport transport(QStringLiteral("http://127.0.0.1:") + QString::number(port), &diag);
    Recorder rec;
    ChangeStream stream(&transport, &diag, fast(10000));
    rec.attach(stream);
    stream.start();
    QTRY_VERIFY_WITH_TIMEOUT(!rec.closes.isEmpty(), 9000);
    stream.stop();

    QCOMPARE(describe({rec.closes.first()}), QStringLiteral("transient/-1"));
    QCOMPARE(describe({rec.closes.last()}), QStringLiteral("stopped/-1"));
    QCOMPARE(rec.unauthorized, 0);
    const QList<QJsonObject> requests = only(readEvents(diagPath), QStringLiteral("net-request"));
    QVERIFY(!requests.isEmpty());
    QCOMPARE(requests.first().value(QStringLiteral("route")).toString(), QStringLiteral("stream"));
    QVERIFY(requests.first().value(QStringLiteral("status")).isNull());
}

// The canonical's failure mode in full: the stream drops, the session died meanwhile, the reconnect
// meets a 401 before opening - and that is where it stops.
void ChangeStreamTest::aReconnectThatMeetsA401StopsThere()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    int streams = 0;
    stub.handle([&streams](const StubRequest &request, int) {
        if (request.target == "/api/login")
            return loginAnswer();
        ++streams;
        return streams == 2 ? unauthenticated401() : SseAnswer::stream(kSseReadyFrame);
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    QCOMPARE(transport.send(loginSpec()).status, 200);
    Recorder rec;
    ChangeStream stream(&transport, nullptr, fast());
    rec.attach(stream);
    stream.start();
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 1, 5000);

    stub.drop(1);  // a cut cable
    QTRY_COMPARE_WITH_TIMEOUT(rec.closes.size(), 2, 5000);
    waitPastTheLadder();
    QCOMPARE(describe(rec.closes), QStringLiteral("transient/-1, pre-open-rejected/401"));
    QCOMPARE(rec.unauthorized, 1);
    QCOMPARE(stub.streamRequestCount(), 2);
    QVERIFY(!stream.isRunning());
}

// ---------------------------------------------------------------------------------------------
// lifecycle and concurrency

void ChangeStreamTest::stopClosesForGoodAndIsIdempotent()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    stub.handle([](const StubRequest &, int index) {
        return index < 2 ? SseAnswer::stream(kSseReadyFrame) : SseAnswer::streamThenEnd(QByteArray());
    });
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString diagPath = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);
    net::HttpTransport transport(stub.origin(), &diag);

    Recorder rec;
    ChangeStream stream(&transport, &diag, fast());
    rec.attach(stream);
    stream.stop();  // never started: nothing to close, nothing said
    QVERIFY(rec.closes.isEmpty());
    QVERIFY(!stream.isRunning());

    stream.start();
    stream.start();  // already running: nothing more is opened
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 1, 5000);
    QCOMPARE(stub.streamRequestCount(), 1);

    stream.stop();
    QCOMPARE(describe(rec.closes), QStringLiteral("stopped/-1"));
    QVERIFY(!stream.isRunning());
    QVERIFY(!stream.isConnected());
    QTRY_VERIFY_WITH_TIMEOUT(!stub.isOpen(0), 5000);  // the connection is really closed
    stream.stop();  // idempotent (httpModel.test.js:693)
    QCOMPARE(rec.closes.size(), 1);
    waitPastTheLadder();
    QCOMPARE(stub.streamRequestCount(), 1);

    // After a close, start() starts afresh.
    stream.start();
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 2, 5000);
    stream.stop();
    QCOMPARE(rec.closes.size(), 2);

    // stop() while waiting to reconnect cancels the reconnect.
    net::ChangeStreamOptions slow = fast();
    slow.backoffBaseMs = 500;
    slow.backoffCapMs = 500;
    Recorder waiting;
    ChangeStream dropping(&transport, &diag, slow);
    waiting.attach(dropping);
    dropping.start();  // request #2: head, then the end
    QTRY_COMPARE_WITH_TIMEOUT(waiting.closes.size(), 1, 5000);
    QCOMPARE(describe(waiting.closes), QStringLiteral("transient/-1"));
    QVERIFY(dropping.isRunning());  // waiting to reconnect is still running
    dropping.stop();
    QCOMPARE(describe(waiting.closes), QStringLiteral("transient/-1, stopped/-1"));
    QTest::qWait(800);
    QCOMPARE(stub.streamRequestCount(), 3);

    const QList<QJsonObject> closed = only(readEvents(diagPath), QStringLiteral("sse-closed"));
    QStringList reasons;
    for (const QJsonObject &line : closed)
        reasons << line.value(QStringLiteral("reason")).toString();
    QCOMPARE(reasons, (QStringList{QStringLiteral("stopped"), QStringLiteral("stopped"), QStringLiteral("transient"),
                                   QStringLiteral("stopped")}));
}

// Net port spec R6: EventSource.close() silences everything at once; a QNetworkReply does not, so
// the stream seals itself. A slot that stops the stream on the first of three frames in one read
// hears nothing more.
void ChangeStreamTest::staysSilentOnceStopped()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);
    Recorder rec;
    ChangeStream stream(&transport, nullptr, fast());
    rec.attach(stream);
    QObject::connect(&stream, &ChangeStream::changed, &stream, [&stream] { stream.stop(); });
    stream.start();
    QTRY_COMPARE_WITH_TIMEOUT(rec.ready, 1, 5000);

    stub.write(0, sseChangeFrame("create") + sseChangeFrame("update") + kSseUnauthorizedFrame);
    QTRY_VERIFY_WITH_TIMEOUT(!rec.closes.isEmpty(), 5000);
    stub.write(0, sseChangeFrame("status"));  // too late: the connection is gone
    QTest::qWait(200);

    QCOMPARE(rec.kinds, QStringList{QStringLiteral("create")});
    QCOMPARE(describe(rec.closes), QStringLiteral("stopped/-1"));
    QCOMPARE(rec.unauthorized, 0);
}

// sse.md 90: two streams at once (writer + list) is the normal pattern. Each has its own connection,
// its own parser and its own close - a half frame on one must not mix with the other, and stopping
// one leaves the other running.
void ChangeStreamTest::runsTwoIndependentStreamsOnOneSession()
{
    SseStubServer stub;
    QVERIFY(stub.listen());
    stub.handle([](const StubRequest &request, int) {
        return request.target == "/api/login" ? loginAnswer() : SseAnswer::stream(kSseReadyFrame);
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    QCOMPARE(transport.send(loginSpec()).status, 200);

    Recorder a;
    Recorder b;
    ChangeStream first(&transport, nullptr, fast());
    ChangeStream second(&transport, nullptr, fast());
    a.attach(first);
    b.attach(second);
    first.start();
    QTRY_COMPARE_WITH_TIMEOUT(a.ready, 1, 5000);
    second.start();
    QTRY_COMPARE_WITH_TIMEOUT(b.ready, 1, 5000);
    QCOMPARE(stub.streamRequestCount(), 2);
    QVERIFY(stub.requests().at(1).header("cookie").contains("sid=sid-sse"));  // one session, two streams
    QVERIFY(stub.requests().at(2).header("cookie").contains("sid=sid-sse"));

    const QByteArray create = sseChangeFrame("create");
    stub.write(1, create.left(20));  // "event: change\ndata: " - half a frame on the first
    QTest::qWait(60);
    stub.write(2, sseChangeFrame("update"));  // a whole frame on the second
    QTRY_COMPARE_WITH_TIMEOUT(b.kinds, QStringList{QStringLiteral("update")}, 5000);
    QVERIFY(a.kinds.isEmpty());
    stub.write(1, create.mid(20));
    QTRY_COMPARE_WITH_TIMEOUT(a.kinds, QStringList{QStringLiteral("create")}, 5000);
    QCOMPARE(b.kinds, QStringList{QStringLiteral("update")});

    first.stop();
    QCOMPARE(describe(a.closes), QStringLiteral("stopped/-1"));
    QVERIFY(b.closes.isEmpty());
    QVERIFY(second.isConnected());
    stub.write(2, sseChangeFrame("status"));
    QTRY_COMPARE_WITH_TIMEOUT(b.kinds, (QStringList{QStringLiteral("update"), QStringLiteral("status")}), 5000);
    QCOMPARE(a.kinds, QStringList{QStringLiteral("create")});
    QTest::qWait(200);
    QCOMPARE(stub.streamRequestCount(), 2);
    second.stop();
}
