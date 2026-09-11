#ifndef CLIENT_QT_TESTS_STUBHTTPSERVER_H
#define CLIENT_QT_TESTS_STUBHTTPSERVER_H

// A minimal HTTP/1.1 server on 127.0.0.1 for the net-layer tests (phase 77 step7).
//
// It runs on the test thread; the transport under test waits in a local event loop, which is
// what lets this server's socket events run while send() blocks. It records every request
// exactly as it arrived (request-target bytes, header lines, body) so the tests judge the wire,
// not what the client meant to send. One request per connection ("Connection: close").
//
// Nothing here talks to a real server or to the network beyond the loopback interface.

#include <QByteArray>
#include <QHash>
#include <QList>
#include <QObject>
#include <QPair>
#include <QString>

#include <functional>

class QTcpServer;
class QTcpSocket;

struct StubRequest {
    QByteArray method;
    QByteArray target;                              // request-target, byte for byte
    QList<QPair<QByteArray, QByteArray>> headers;   // names lower-cased, in arrival order
    QByteArray body;

    bool hasHeader(const QByteArray &lowerName) const;
    QByteArray header(const QByteArray &lowerName) const;  // first value, empty when absent
    int headerCount(const QByteArray &lowerName) const;
};

struct StubReply {
    int status = 200;
    QByteArray contentType = "application/json; charset=utf-8";  // empty = no Content-Type line
    QByteArray body = "{\"ok\":true}";
    QList<QPair<QByteArray, QByteArray>> headers;  // extra lines (Set-Cookie, Location, ...)
    bool hang = false;                             // read the request, never answer

    static StubReply json(int status, const QByteArray &body);
    static StubReply html(int status, const QByteArray &body);
    static StubReply redirect(const QByteArray &location);
};

class StubHttpServer : public QObject
{
    Q_OBJECT

public:
    explicit StubHttpServer(QObject *parent = nullptr);
    ~StubHttpServer() override;

    bool listen();
    quint16 port() const;
    QString origin() const;  // http://127.0.0.1:<port>

    // The same answer to every request.
    void always(const StubReply &reply);
    // Answers in order; once they run out, the default 200 {"ok":true}.
    void inOrder(const QList<StubReply> &replies);
    // Full control.
    void handle(std::function<StubReply(const StubRequest &)> handler);

    const QList<StubRequest> &requests() const;

private:
    void onNewConnection();
    void onReadyRead(QTcpSocket *socket);

    QTcpServer *m_server = nullptr;
    QHash<QTcpSocket *, QByteArray> m_buffers;
    std::function<StubReply(const StubRequest &)> m_handler;
    QList<StubReply> m_queue;
    QList<StubRequest> m_requests;
};

// A port on 127.0.0.1 nobody listens on (bound, read, released).
quint16 unusedLocalPort();

// The Set-Cookie line express writes for the session (server/index.js:566-574, non-production:
// HttpOnly, Path=/, SameSite=Lax, Max-Age one hour, no Secure).
QByteArray sessionCookieLine(const QByteArray &sid);
// ... and the one clearSessionCookie writes (server/index.js:576-584, Max-Age=0).
QByteArray clearedSessionCookieLine();

#endif // CLIENT_QT_TESTS_STUBHTTPSERVER_H
