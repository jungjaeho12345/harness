#include "net/changestream.h"

#include "net/routetable.h"
#include "shell/diag.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QJsonValue>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QVariant>

namespace net {

QString closeReasonName(CloseReason reason)
{
    switch (reason) {
    case CloseReason::PreOpenRejected: return QStringLiteral("pre-open-rejected");
    case CloseReason::UnauthorizedFrame: return QStringLiteral("unauthorized-frame");
    case CloseReason::Transient: return QStringLiteral("transient");
    case CloseReason::Stopped: return QStringLiteral("stopped");
    }
    return QStringLiteral("stopped");
}

bool isEventStreamContentType(const QByteArray &contentType)
{
    const qsizetype semicolon = contentType.indexOf(';');
    const QByteArray essence = (semicolon < 0 ? contentType : contentType.left(semicolon)).trimmed().toLower();
    return essence == "text/event-stream";
}

int reconnectDelayMs(int attempt, int baseMs, int capMs)
{
    qint64 delay = baseMs;
    for (int i = 1; i < attempt && delay < capMs; ++i)
        delay *= 2;
    return int(qMin<qint64>(delay, capMs));
}

ChangeStream::ChangeStream(HttpTransport *transport, shell::Diag *diag, const ChangeStreamOptions &options,
                           QObject *parent)
    : QObject(parent), m_transport(transport), m_diag(diag), m_options(options)
{
    m_openTimer.setSingleShot(true);
    m_reconnectTimer.setSingleShot(true);
    connect(&m_openTimer, &QTimer::timeout, this, &ChangeStream::onOpenDeadline);
    connect(&m_reconnectTimer, &QTimer::timeout, this, [this] {
        if (m_state == State::Waiting)
            connectNow();
    });
}

ChangeStream::~ChangeStream()
{
    // No signal from a destructor - but the diag still records that the stream went away.
    if (!isRunning())
        return;
    releaseReply();
    log(QStringLiteral("sse-closed"), QVariantMap{{QStringLiteral("reason"), closeReasonName(CloseReason::Stopped)}});
}

void ChangeStream::start()
{
    if (isRunning())
        return;
    m_attempt = 0;
    connectNow();
}

void ChangeStream::stop()
{
    if (!isRunning())
        return;
    closeForGood(CloseReason::Stopped, -1);
}

bool ChangeStream::isConnected() const
{
    return m_connected;
}

bool ChangeStream::isRunning() const
{
    return m_state == State::Connecting || m_state == State::Rejecting || m_state == State::Open
        || m_state == State::Waiting;
}

void ChangeStream::connectNow()
{
    m_state = State::Connecting;
    m_connected = false;
    m_status = -1;
    m_parser.reset();  // a new connection starts clean - no half frame of the old one

    // The route table's "stream" row (method and path are the table's, not spelled here).
    QNetworkReply *reply = nullptr;
    if (const RouteSpec *route = findRoute(QStringLiteral("stream")); route && m_transport) {
        RequestSpec spec;
        spec.routeId = route->id;
        spec.method = route->method;
        spec.path = buildPath(route->id);
        reply = m_transport->openStream(spec);
    }
    if (!reply) {
        endTransient();  // nothing could be sent: no answer, retried like one
        return;
    }
    m_reply = reply;
    connect(reply, &QNetworkReply::metaDataChanged, this, &ChangeStream::onHead);
    connect(reply, &QNetworkReply::readyRead, this, &ChangeStream::onReadyRead);
    connect(reply, &QNetworkReply::finished, this, &ChangeStream::onFinished);
    m_openTimer.start(qMax(1, m_options.openTimeoutMs));
}

void ChangeStream::onHead()
{
    if (sender() != m_reply.data() || m_state != State::Connecting)
        return;
    if (!m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).isValid())
        return;
    decideOpen();
}

void ChangeStream::decideOpen()
{
    m_status = m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt();
    // sse.md 20-30: the head is the verdict - status 200 AND Content-Type text/event-stream.
    // Cache-Control / Connection are not judged (a proxy may rewrite them; they decide nothing).
    if (m_status == 200 && isEventStreamContentType(m_reply->rawHeader("Content-Type"))) {
        m_openTimer.stop();  // the head arrived; the body has no deadline
        m_state = State::Open;
        log(QStringLiteral("sse-open"));
        return;
    }
    if (m_status == 200) {
        // A 200 that is not an event stream (a captive portal, a proxy page). Its body may never end
        // and is never parsed: close now.
        closeForGood(CloseReason::PreOpenRejected, m_status);
        return;
    }
    // Any other status: the stream never opened. The (short) body is read whole when it ends - a
    // 401's token decides whether the session goes too - bounded by the still-running open deadline.
    m_state = State::Rejecting;
}

void ChangeStream::onReadyRead()
{
    if (sender() != m_reply.data())
        return;
    if (m_state == State::Connecting) {
        if (!m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).isValid())
            return;
        decideOpen();
    }
    if (m_state == State::Open)
        consume(m_reply->readAll());
}

void ChangeStream::onFinished()
{
    if (sender() != m_reply.data())
        return;
    if (m_state == State::Connecting) {
        if (!m_reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).isValid()) {
            endTransient();  // no HTTP answer at all: refused, reset, DNS
            return;
        }
        decideOpen();
    }
    if (m_state == State::Open) {
        // The last bytes and the close can arrive together - the server writes the unauthorized
        // frame and ends the response at once (sse.md 60). Read them BEFORE calling it a drop.
        consume(m_reply->readAll());
        if (m_state == State::Open)
            endTransient();
        return;
    }
    if (m_state == State::Rejecting) {
        const QByteArray body = m_reply->readAll();
        QJsonParseError error;
        const QJsonDocument document = QJsonDocument::fromJson(body, &error);
        const bool jsonOk = error.error == QJsonParseError::NoError && document.isObject();
        const QJsonValue reason = jsonOk ? document.object().value(QStringLiteral("reason")) : QJsonValue();
        // step7's rule holds on this path too: the session goes on 401 + unauthenticated and on
        // nothing else (the same classification send() applies).
        if (m_transport
            && classifyResponse(QStringLiteral("stream"), m_status, jsonOk, reason.toString()) == Outcome::Unauthenticated)
            m_transport->clearSession();
        closeForGood(CloseReason::PreOpenRejected, m_status);
    }
}

void ChangeStream::onOpenDeadline()
{
    if (m_state == State::Connecting)
        endTransient();  // no head in time: no answer
    else if (m_state == State::Rejecting)
        closeForGood(CloseReason::PreOpenRejected, m_status);  // a head whose body never ended
}

void ChangeStream::consume(const QByteArray &bytes)
{
    const QVector<SseEvent> events = m_parser.feed(bytes);
    for (const SseEvent &event : events) {
        // Sealed: once closed (the unauthorized frame, or a slot that stopped the stream), nothing
        // else goes out - even frames that arrived in the same read (net port spec R6).
        if (m_state != State::Open)
            return;
        dispatch(event);
    }
}

void ChangeStream::dispatch(const SseEvent &event)
{
    if (event.name == QLatin1String("ready")) {
        m_connected = true;
        m_attempt = 0;  // the stream proved alive: the next drop starts the ladder over
        log(QStringLiteral("sse-ready"));
        emit readyReceived();
    } else if (event.name == QLatin1String("change")) {
        // One invalidation signal whatever the kind (L80). The kind is read for the record only;
        // empty or unparseable data is still a change (httpModel.js:318-324 falls back to {}).
        const QJsonDocument document = QJsonDocument::fromJson(event.data);
        const QJsonValue kindValue = document.isObject() ? document.object().value(QStringLiteral("kind")) : QJsonValue();
        const QString kind = kindValue.isString() ? kindValue.toString() : QString();
        log(QStringLiteral("sse-change"),
            QVariantMap{{QStringLiteral("kind"), kind.isEmpty() ? QVariant() : QVariant(kind)}});
        emit changed(kind);
    } else if (event.name == QLatin1String("unauthorized")) {
        // A fixed token - not parsed, not branched on (httpModel.js:329).
        log(QStringLiteral("sse-unauthorized"));
        closeForGood(CloseReason::UnauthorizedFrame, -1);
    }
    // log, message and any other name: not this stream's vocabulary - ignored.
}

void ChangeStream::endTransient()
{
    releaseReply();
    m_openTimer.stop();
    m_connected = false;
    m_state = State::Waiting;
    log(QStringLiteral("sse-closed"), QVariantMap{{QStringLiteral("reason"), closeReasonName(CloseReason::Transient)}});
    emit disconnected(CloseReason::Transient, -1);
    if (m_state != State::Waiting)
        return;  // a slot stopped the stream meanwhile
    ++m_attempt;
    m_reconnectTimer.start(reconnectDelayMs(m_attempt, m_options.backoffBaseMs, m_options.backoffCapMs));
}

void ChangeStream::closeForGood(CloseReason reason, int status)
{
    releaseReply();
    m_openTimer.stop();
    m_reconnectTimer.stop();
    m_connected = false;
    m_state = State::Closed;
    const int reported = reason == CloseReason::PreOpenRejected ? status : -1;
    QVariantMap payload{{QStringLiteral("reason"), closeReasonName(reason)}};
    if (reason == CloseReason::PreOpenRejected)
        payload.insert(QStringLiteral("status"), reported);
    log(QStringLiteral("sse-closed"), payload);
    emit disconnected(reason, reported);
    // "The session is over": the unauthorized frame, or a 401 before the stream opened. A 503 (or
    // any other refusal) only reports the close.
    if (reason == CloseReason::UnauthorizedFrame || (reason == CloseReason::PreOpenRejected && status == 401))
        emit unauthorized();
}

void ChangeStream::releaseReply()
{
    QNetworkReply *reply = m_reply.data();
    m_reply = nullptr;
    if (!reply)
        return;
    disconnect(reply, nullptr, this, nullptr);  // nothing it says from here on reaches this stream
    if (!reply->isFinished())
        reply->abort();
    reply->deleteLater();
}

void ChangeStream::log(const QString &event, const QVariantMap &payload)
{
    if (m_diag)
        m_diag->log(event, payload);
}

} // namespace net
