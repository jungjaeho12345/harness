#include "ssestubserver.h"

#include <QHostAddress>
#include <QTcpServer>
#include <QTcpSocket>

const QByteArray kSseReadyFrame = "event: ready\ndata: {\"ok\":true}\n\n";
const QByteArray kSseUnauthorizedFrame = "event: unauthorized\ndata: {\"ok\":false,\"reason\":\"unauthenticated\"}\n\n";

QByteArray sseChangeFrame(const QByteArray &kind)
{
    return "event: change\ndata: {\"kind\":\"" + kind + "\"}\n\n";
}

namespace {

QByteArray reasonPhrase(int status)
{
    switch (status) {
    case 200: return "OK";
    case 302: return "Found";
    case 401: return "Unauthorized";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 500: return "Internal Server Error";
    case 502: return "Bad Gateway";
    case 503: return "Service Unavailable";
    default: return "Status";
    }
}

QByteArray chunk(const QByteArray &bytes)
{
    return QByteArray::number(bytes.size(), 16) + "\r\n" + bytes + "\r\n";
}

} // namespace

SseAnswer SseAnswer::stream(const QByteArray &firstChunk)
{
    SseAnswer answer;
    answer.body = firstChunk;
    return answer;
}

SseAnswer SseAnswer::streamThenEnd(const QByteArray &body)
{
    SseAnswer answer;
    answer.body = body;
    answer.endAfterBody = true;
    return answer;
}

SseAnswer SseAnswer::complete(int status, const QByteArray &contentType, const QByteArray &body)
{
    SseAnswer answer;
    answer.kind = Kind::Complete;
    answer.status = status;
    answer.contentType = contentType;
    answer.body = body;
    return answer;
}

SseAnswer SseAnswer::silent()
{
    SseAnswer answer;
    answer.kind = Kind::Silent;
    return answer;
}

SseStubServer::SseStubServer(QObject *parent) : QObject(parent), m_server(new QTcpServer(this))
{
    m_clock.start();
    connect(m_server, &QTcpServer::newConnection, this, &SseStubServer::onNewConnection);
}

SseStubServer::~SseStubServer() = default;

bool SseStubServer::listen()
{
    return m_server->listen(QHostAddress::LocalHost, 0);
}

QString SseStubServer::origin() const
{
    return QStringLiteral("http://127.0.0.1:") + QString::number(m_server->serverPort());
}

void SseStubServer::handle(std::function<SseAnswer(const StubRequest &, int)> handler)
{
    m_handler = std::move(handler);
}

int SseStubServer::requestCount() const
{
    return int(m_requests.size());
}

const QList<StubRequest> &SseStubServer::requests() const
{
    return m_requests;
}

QList<qint64> SseStubServer::arrivalMs() const
{
    return m_arrivals;
}

qint64 SseStubServer::nowMs() const
{
    return m_clock.elapsed();
}

int SseStubServer::streamRequestCount() const
{
    int count = 0;
    for (const StubRequest &request : m_requests) {
        if (request.target == "/api/stream")
            ++count;
    }
    return count;
}

void SseStubServer::write(int index, const QByteArray &bytes)
{
    QTcpSocket *socket = m_sockets.value(index);
    if (!socket || socket->state() != QAbstractSocket::ConnectedState || bytes.isEmpty())
        return;
    socket->write(chunk(bytes));
    socket->flush();
}

void SseStubServer::end(int index)
{
    QTcpSocket *socket = m_sockets.value(index);
    if (!socket || socket->state() != QAbstractSocket::ConnectedState)
        return;
    socket->write("0\r\n\r\n");
    socket->flush();
    socket->disconnectFromHost();
}

void SseStubServer::drop(int index)
{
    QTcpSocket *socket = m_sockets.value(index);
    if (socket)
        socket->abort();
}

bool SseStubServer::isOpen(int index) const
{
    const QTcpSocket *socket = m_sockets.value(index);
    return socket && socket->state() == QAbstractSocket::ConnectedState;
}

void SseStubServer::onNewConnection()
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

void SseStubServer::onReadyRead(QTcpSocket *socket)
{
    auto it = m_buffers.find(socket);
    if (it == m_buffers.end()) {
        socket->readAll();  // the request was answered; nothing else is expected on this connection
        return;
    }
    QByteArray &buffer = *it;
    buffer += socket->readAll();

    const qsizetype headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0)
        return;

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
        return;
    request.body = buffer.mid(headerEnd + 4, contentLength);
    m_buffers.erase(it);  // one request per connection

    const int index = int(m_requests.size());
    m_requests.append(request);
    m_arrivals.append(m_clock.elapsed());
    m_sockets.append(QPointer<QTcpSocket>(socket));

    const SseAnswer reply = m_handler ? m_handler(request, index) : SseAnswer::stream(kSseReadyFrame);
    answer(socket, reply);
}

void SseStubServer::answer(QTcpSocket *socket, const SseAnswer &reply)
{
    if (reply.kind == SseAnswer::Kind::Silent)
        return;  // the socket stays open and says nothing; the client's own deadline has to end it

    QByteArray head = "HTTP/1.1 " + QByteArray::number(reply.status) + ' ' + reasonPhrase(reply.status) + "\r\n";
    if (!reply.contentType.isEmpty())
        head += "Content-Type: " + reply.contentType + "\r\n";
    for (const auto &pair : reply.headers)
        head += pair.first + ": " + pair.second + "\r\n";

    if (reply.kind == SseAnswer::Kind::Complete) {
        head += "Content-Length: " + QByteArray::number(reply.body.size()) + "\r\n";
        head += "Connection: close\r\n\r\n";
        socket->write(head + reply.body);
        socket->flush();
        socket->disconnectFromHost();
        return;
    }

    // The stream: server/index.js:1131-1137 sends these three headers, then flushes. The stub closes
    // the connection when the stream ends (no keep-alive reuse to race against in the tests).
    head += "Cache-Control: no-cache\r\n";
    head += "Connection: close\r\n";
    head += "Transfer-Encoding: chunked\r\n\r\n";
    QByteArray out = head;
    if (!reply.body.isEmpty())
        out += chunk(reply.body);
    if (reply.endAfterBody)
        out += "0\r\n\r\n";
    socket->write(out);
    socket->flush();
    if (reply.endAfterBody)
        socket->disconnectFromHost();
}
