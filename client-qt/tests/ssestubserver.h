#ifndef CLIENT_QT_TESTS_SSESTUBSERVER_H
#define CLIENT_QT_TESTS_SSESTUBSERVER_H

// A loopback server for the SSE tests (phase 77 step9).
//
// StubHttpServer answers one complete response per connection. An event stream is the opposite:
// the head goes out at once and the body is written later, piece by piece, while the connection
// stays open. This stub does that - chunked transfer, the way Node's res.write() sends it - and
// lets each test decide, per request, what happens: a stream, a complete answer (a 401 JSON, a
// 503, a captive portal's 200 text/html) or silence. The test then writes frames, ends the stream
// (res.end()) or drops the connection (a cut cable) whenever it wants.
//
// Every request is recorded with its arrival time, so reconnects can be counted and their spacing
// measured on the wire rather than taken from the client's word.

#include "stubhttpserver.h"  // StubRequest, sessionCookieLine

#include <QByteArray>
#include <QElapsedTimer>
#include <QHash>
#include <QList>
#include <QObject>
#include <QPair>
#include <QPointer>
#include <QString>

#include <functional>

class QTcpServer;
class QTcpSocket;

struct SseAnswer {
    enum class Kind { Stream, Complete, Silent };
    Kind kind = Kind::Stream;
    int status = 200;
    QByteArray contentType = "text/event-stream; charset=utf-8";  // empty = no Content-Type line
    QByteArray body;            // Stream: the first chunk (none when empty) / Complete: the whole body
    bool endAfterBody = false;  // Stream: the last chunk and the close follow the first chunk at once
    QList<QPair<QByteArray, QByteArray>> headers;

    static SseAnswer stream(const QByteArray &firstChunk = QByteArray());
    static SseAnswer streamThenEnd(const QByteArray &body);
    static SseAnswer complete(int status, const QByteArray &contentType, const QByteArray &body);
    static SseAnswer silent();
};

class SseStubServer : public QObject
{
    Q_OBJECT

public:
    explicit SseStubServer(QObject *parent = nullptr);
    ~SseStubServer() override;

    bool listen();
    QString origin() const;  // http://127.0.0.1:<port>

    // The answer to request #index (0-based, arrival order). Without a handler: stream(ready frame).
    void handle(std::function<SseAnswer(const StubRequest &request, int index)> handler);

    int requestCount() const;
    const QList<StubRequest> &requests() const;
    QList<qint64> arrivalMs() const;  // ms on this stub's monotonic clock, one per request
    qint64 nowMs() const;             // the same clock
    int streamRequestCount() const;   // requests whose target is /api/stream

    // On the connection that carried request #index (a Stream answer):
    void write(int index, const QByteArray &bytes);  // one HTTP chunk, flushed
    void end(int index);                             // the last chunk, then close (res.end())
    void drop(int index);                            // close without the last chunk
    bool isOpen(int index) const;                    // neither side has closed it

private:
    void onNewConnection();
    void onReadyRead(QTcpSocket *socket);
    void answer(QTcpSocket *socket, const SseAnswer &reply);

    QTcpServer *m_server = nullptr;
    QElapsedTimer m_clock;
    QHash<QTcpSocket *, QByteArray> m_buffers;
    std::function<SseAnswer(const StubRequest &, int)> m_handler;
    QList<StubRequest> m_requests;
    QList<qint64> m_arrivals;
    QList<QPointer<QTcpSocket>> m_sockets;  // per request index
};

// docs/api-contract/sse.md 40-53 / server/index.js:1137 - the frames the server writes.
extern const QByteArray kSseReadyFrame;
extern const QByteArray kSseUnauthorizedFrame;
QByteArray sseChangeFrame(const QByteArray &kind);

#endif // CLIENT_QT_TESTS_SSESTUBSERVER_H
