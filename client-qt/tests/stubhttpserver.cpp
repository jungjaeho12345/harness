#include "stubhttpserver.h"

#include <QDateTime>
#include <QHostAddress>
#include <QLocale>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTimeZone>

namespace {

QByteArray reasonPhrase(int status)
{
    switch (status) {
    case 200: return "OK";
    case 201: return "Created";
    case 301: return "Moved Permanently";
    case 302: return "Found";
    case 307: return "Temporary Redirect";
    case 400: return "Bad Request";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 409: return "Conflict";
    case 418: return "I'm a Teapot";
    case 423: return "Locked";
    case 429: return "Too Many Requests";
    case 500: return "Internal Server Error";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    default: return "Status";
    }
}

// RFC 7231 IMF-fixdate, the way express writes Expires.
QByteArray httpDate(const QDateTime &when)
{
    return QLocale::c()
        .toString(when.toTimeZone(QTimeZone::UTC), QStringLiteral("ddd, dd MMM yyyy HH:mm:ss 'GMT'"))
        .toLatin1();
}

} // namespace

bool StubRequest::hasHeader(const QByteArray &lowerName) const
{
    return headerCount(lowerName) > 0;
}

QByteArray StubRequest::header(const QByteArray &lowerName) const
{
    for (const auto &pair : headers) {
        if (pair.first == lowerName)
            return pair.second;
    }
    return QByteArray();
}

int StubRequest::headerCount(const QByteArray &lowerName) const
{
    int count = 0;
    for (const auto &pair : headers) {
        if (pair.first == lowerName)
            ++count;
    }
    return count;
}

StubReply StubReply::json(int status, const QByteArray &body)
{
    StubReply reply;
    reply.status = status;
    reply.body = body;
    return reply;
}

StubReply StubReply::html(int status, const QByteArray &body)
{
    StubReply reply;
    reply.status = status;
    reply.contentType = "text/html; charset=utf-8";
    reply.body = body;
    return reply;
}

StubReply StubReply::redirect(const QByteArray &location)
{
    // What express's res.redirect() writes: 302, a short text body, a Location line.
    StubReply reply;
    reply.status = 302;
    reply.contentType = "text/plain; charset=utf-8";
    reply.body = "Found. Redirecting to " + location;
    reply.headers.append({"Location", location});
    return reply;
}

StubHttpServer::StubHttpServer(QObject *parent) : QObject(parent), m_server(new QTcpServer(this))
{
    connect(m_server, &QTcpServer::newConnection, this, &StubHttpServer::onNewConnection);
}

StubHttpServer::~StubHttpServer() = default;

bool StubHttpServer::listen()
{
    return m_server->listen(QHostAddress::LocalHost, 0);
}

quint16 StubHttpServer::port() const
{
    return m_server->serverPort();
}

QString StubHttpServer::origin() const
{
    return QStringLiteral("http://127.0.0.1:") + QString::number(port());
}

void StubHttpServer::always(const StubReply &reply)
{
    m_handler = [reply](const StubRequest &) { return reply; };
}

void StubHttpServer::inOrder(const QList<StubReply> &replies)
{
    m_queue = replies;
    m_handler = [this](const StubRequest &) {
        if (m_queue.isEmpty())
            return StubReply();
        return m_queue.takeFirst();
    };
}

void StubHttpServer::handle(std::function<StubReply(const StubRequest &)> handler)
{
    m_handler = std::move(handler);
}

const QList<StubRequest> &StubHttpServer::requests() const
{
    return m_requests;
}

void StubHttpServer::onNewConnection()
{
    while (QTcpSocket *socket = m_server->nextPendingConnection()) {
        m_buffers.insert(socket, QByteArray());
        connect(socket, &QTcpSocket::readyRead, this, [this, socket] { onReadyRead(socket); });
        connect(socket, &QTcpSocket::disconnected, this, [this, socket] {
            m_buffers.remove(socket);
            socket->deleteLater();
        });
    }
}

void StubHttpServer::onReadyRead(QTcpSocket *socket)
{
    auto it = m_buffers.find(socket);
    if (it == m_buffers.end())
        return;  // this connection's request was already answered (or is being held)
    QByteArray &buffer = *it;
    buffer += socket->readAll();

    const qsizetype headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0)
        return;  // the head is still arriving

    StubRequest request;
    const QList<QByteArray> lines = buffer.left(headerEnd).split('\n');
    const QList<QByteArray> requestLine = lines.value(0).trimmed().split(' ');
    request.method = requestLine.value(0);
    request.target = requestLine.value(1);
    qsizetype contentLength = 0;
    for (qsizetype i = 1; i < lines.size(); ++i) {
        const QByteArray line = lines.at(i).trimmed();
        const qsizetype colon = line.indexOf(':');
        if (colon <= 0)
            continue;
        const QByteArray name = line.left(colon).trimmed().toLower();
        const QByteArray value = line.mid(colon + 1).trimmed();
        request.headers.append({name, value});
        if (name == "content-length")
            contentLength = value.toLongLong();
    }
    const qsizetype total = headerEnd + 4 + contentLength;
    if (buffer.size() < total)
        return;  // the body is still arriving
    request.body = buffer.mid(headerEnd + 4, contentLength);
    m_buffers.erase(it);  // one request per connection

    m_requests.append(request);
    const StubReply reply = m_handler ? m_handler(request) : StubReply();
    if (reply.hang)
        return;  // keep the socket open and silent; the client's deadline has to end it

    QByteArray out = "HTTP/1.1 " + QByteArray::number(reply.status) + ' ' + reasonPhrase(reply.status) + "\r\n";
    if (!reply.contentType.isEmpty())
        out += "Content-Type: " + reply.contentType + "\r\n";
    for (const auto &pair : reply.headers)
        out += pair.first + ": " + pair.second + "\r\n";
    out += "Content-Length: " + QByteArray::number(reply.body.size()) + "\r\n";
    out += "Connection: close\r\n\r\n";
    out += reply.body;
    socket->write(out);
    socket->flush();
    socket->disconnectFromHost();
}

quint16 unusedLocalPort()
{
    QTcpServer probe;
    if (!probe.listen(QHostAddress::LocalHost, 0))
        return 0;
    const quint16 port = probe.serverPort();
    probe.close();
    return port;
}

QByteArray sessionCookieLine(const QByteArray &sid)
{
    const QDateTime expires = QDateTime::currentDateTimeUtc().addSecs(3600);
    return "sid=" + sid + "; Max-Age=3600; Path=/; Expires=" + httpDate(expires) + "; HttpOnly; SameSite=Lax";
}

QByteArray clearedSessionCookieLine()
{
    return "sid=; Max-Age=0; Path=/; Expires=" + httpDate(QDateTime::currentDateTimeUtc())
        + "; HttpOnly; SameSite=Lax";
}
