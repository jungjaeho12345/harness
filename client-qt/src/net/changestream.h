#ifndef CLIENT_QT_NET_CHANGESTREAM_H
#define CLIENT_QT_NET_CHANGESTREAM_H

// ChangeStream - GET /api/stream, the invalidation signal (phase 77 step9 B).
//
// The canonical is web/src/model/httpModel.js:313-337 over the browser's EventSource. What it keeps:
//   - one independent connection, parser and reconnect state PER INSTANCE - no module state, no
//     singleton ("the" stream). Two at once is the normal pattern (sse.md 90: writer + list; P5 adds
//     the editor's). The session is the transport's cookie jar, shared by every stream on it.
//   - ready -> readyReceived(); change -> changed(kind) for EVERY change frame whatever its kind:
//     one invalidation signal, the caller re-queries with its own filter (override L80, ADR-005). The
//     kind rides along for the diag only - nothing here branches on it. Empty or unparseable data is
//     still a change (kind "") - httpModel.js:318-324 falls back to {} (net port spec R3).
//   - the unauthorized frame ends the stream for good (httpModel.js:327-330) - the frame carries a
//     fixed token and is not parsed.
// What EventSource did invisibly and this class does by hand (WHATWG):
//   - an answer that is not "200 + Content-Type text/event-stream" fails the connection with NO
//     reconnect (sse.md 12-18 and 20-30: a 401 JSON before the stream opens; a captive portal's
//     200 text/html). Its body is never parsed.
//   - a connection that ends, or no answer at all, is retried - with a growing delay here (1 s,
//     2 s, 4 s ... 30 s; back to 1 s once a ready arrives). EventSource retries at a roughly constant
//     interval (no retry: field is sent - sse.md 36); the growing delay is a divergence in the gentle
//     direction. This is the client's connection repair, not ADR-008's "periodic job in the app".
//
// Four ways to close, three of them for good (CloseReason):
//   PreOpenRejected   an HTTP answer that is not a 200 event stream  -> closed (no reconnect)
//   UnauthorizedFrame the unauthorized frame after the stream opened -> closed (no reconnect)
//   Transient         no HTTP answer (refused, reset, the open deadline) or the open stream ended
//                                                                     -> reconnect after a delay
//   Stopped           stop()                                          -> closed
// unauthorized() - "the session is over, back to the login screen" - follows the unauthorized frame
// and a 401 before the stream opened; a 503 before opening only reports the close. Mixing the three
// terminal paths into the one retried path would hammer a permanently-401 endpoint forever - the
// failure the canonical's 327-329 comment names, in its before-open form.
//
// Not done here, on purpose: receiving frames is not session activity (override L127 - the server
// re-checks with a non-extending peek), so nothing reads this stream's liveness to judge or extend
// the session, and there is no idle timer: an idle stream is silent for hours (no heartbeat - the
// server has no periodic timer, ADR-008). The log stream (/api/logs/stream) is P7's and never opened.
//
// Lifetime: the transport outlives every stream on it. Never delete a stream from one of its own
// signals - use deleteLater() (stop() is safe anywhere, any number of times).

#include "net/httptransport.h"
#include "net/sseparser.h"

#include <QByteArray>
#include <QObject>
#include <QPointer>
#include <QString>
#include <QTimer>
#include <QVariantMap>

class QNetworkReply;

namespace shell {
class Diag;
} // namespace shell

namespace net {

enum class CloseReason { PreOpenRejected, UnauthorizedFrame, Transient, Stopped };

// The diag spelling: pre-open-rejected / unauthorized-frame / transient / stopped.
QString closeReasonName(CloseReason reason);

// The MIME essence of a Content-Type value is text/event-stream (case-insensitive, parameters
// ignored). "text/event-streamx" and a missing value are not.
bool isEventStreamContentType(const QByteArray &contentType);

// The delay before reconnect attempt n (1-based): base * 2^(n-1), never above cap.
int reconnectDelayMs(int attempt, int baseMs, int capMs);

struct ChangeStreamOptions {
    int backoffBaseMs = 1000;
    int backoffCapMs = 30000;
    int openTimeoutMs = kDefaultTimeoutMs;  // until the answer's head; the stream body has no deadline
};

class ChangeStream : public QObject
{
    Q_OBJECT

public:
    // transport: not owned, outlives the stream. diag may be null.
    ChangeStream(HttpTransport *transport, shell::Diag *diag,
                 const ChangeStreamOptions &options = ChangeStreamOptions(), QObject *parent = nullptr);
    ~ChangeStream() override;

    void start();  // no-op while running; after a close it starts afresh
    void stop();   // closes for good (CloseReason::Stopped); no-op when not running

    bool isConnected() const;  // a ready arrived on the current connection
    bool isRunning() const;    // connecting, open, or waiting to reconnect

signals:
    void readyReceived();
    void changed(const QString &kind);  // kind "" when the frame's data has no string kind
    void unauthorized();                // the session is over (unauthorized frame, or 401 before opening)
    void disconnected(net::CloseReason reason, int status);  // status: the HTTP status for PreOpenRejected, else -1

private:
    enum class State { Idle, Connecting, Rejecting, Open, Waiting, Closed };

    void connectNow();
    void onHead();
    void onReadyRead();
    void onFinished();
    void onOpenDeadline();
    void decideOpen();
    void consume(const QByteArray &bytes);
    void dispatch(const SseEvent &event);
    void endTransient();
    void closeForGood(CloseReason reason, int status);
    void releaseReply();
    void log(const QString &event, const QVariantMap &payload = QVariantMap());

    HttpTransport *m_transport = nullptr;
    shell::Diag *m_diag = nullptr;
    ChangeStreamOptions m_options;
    SseParser m_parser;              // this connection's own parser - never shared
    QPointer<QNetworkReply> m_reply;
    QTimer m_openTimer;
    QTimer m_reconnectTimer;
    State m_state = State::Idle;
    bool m_connected = false;
    int m_attempt = 0;               // failed connections since the last ready
    int m_status = -1;               // the current answer's HTTP status, -1 until known
};

} // namespace net

#endif // CLIENT_QT_NET_CHANGESTREAM_H
