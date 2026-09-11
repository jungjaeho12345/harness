#include "livestreamtest.h"

#include "net/changestream.h"
#include "net/httptransport.h"
#include "net/routetable.h"
#include "shell/diag.h"

#include <QByteArray>
#include <QDir>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QString>
#include <QTcpSocket>
#include <QTemporaryDir>
#include <QUrl>
#include <QtTest>

#include <algorithm>

namespace {

net::RequestSpec make(const QString &route, const QString &method, const QString &path)
{
    net::RequestSpec spec;
    spec.routeId = route;
    spec.method = method;
    spec.path = path;
    return spec;
}

net::RequestSpec loginSpec(const QString &user, const QString &password)
{
    net::RequestSpec spec = make(QStringLiteral("login"), QStringLiteral("POST"), QStringLiteral("/api/login"));
    spec.body = QJsonObject{{QStringLiteral("userId"), user}, {QStringLiteral("password"), password}};
    return spec;
}

int envInt(const char *name, int fallback)
{
    bool ok = false;
    const int value = qEnvironmentVariable(name).toInt(&ok);
    return ok ? value : fallback;
}

qint64 median(QList<qint64> values)
{
    if (values.isEmpty())
        return -1;
    std::sort(values.begin(), values.end());
    return values.at(values.size() / 2);
}

// The reference reader: a plain socket, no QNetworkAccessManager. It counts frame markers as the
// bytes arrive (each frame is one write on the server, so a marker is never split by the chunked
// framing) and stamps each on the shared clock.
class RawStream : public QObject
{
public:
    RawStream(const QString &host, quint16 port, const QElapsedTimer *clock) : m_host(host), m_port(port), m_clock(clock)
    {
        connect(&m_socket, &QTcpSocket::readyRead, this, [this] { onBytes(); });
    }

    // Its own session, over its own socket. The value stays in this object's memory only.
    bool login(const QString &user, const QString &password)
    {
        QTcpSocket socket;
        socket.connectToHost(m_host, m_port);
        if (!socket.waitForConnected(5000))
            return false;
        const QByteArray body = QJsonDocument(QJsonObject{{QStringLiteral("userId"), user},
                                                          {QStringLiteral("password"), password}})
                                    .toJson(QJsonDocument::Compact);
        socket.write("POST /api/login HTTP/1.1\r\nHost: " + hostHeader() + "\r\nContent-Type: application/json\r\n"
                     "Content-Length: " + QByteArray::number(body.size()) + "\r\nConnection: close\r\n\r\n" + body);
        QByteArray answer;
        while (socket.waitForReadyRead(5000))
            answer += socket.readAll();
        answer += socket.readAll();
        const QByteArray lower = answer.toLower();
        const qsizetype at = lower.indexOf("\r\nset-cookie: sid=");
        if (at < 0)
            return false;
        const qsizetype start = at + int(sizeof("\r\nset-cookie: sid=")) - 1;
        const qsizetype end = answer.indexOf(';', start);
        m_sid = answer.mid(start, end < 0 ? -1 : end - start);
        return !m_sid.isEmpty();
    }

    void open()
    {
        m_openedAt = m_clock->elapsed();
        m_socket.connectToHost(m_host, m_port);
        m_socket.write("GET /api/stream HTTP/1.1\r\nHost: " + hostHeader() + "\r\nAccept: text/event-stream\r\n"
                       "Cookie: sid=" + m_sid + "\r\n\r\n");
    }

    void close() { m_socket.abort(); }

    qint64 openedAt() const { return m_openedAt; }
    const QList<qint64> &readyAt() const { return m_readyAt; }
    const QList<qint64> &changeAt() const { return m_changeAt; }

private:
    QByteArray hostHeader() const { return m_host.toLatin1() + ':' + QByteArray::number(m_port); }

    void onBytes()
    {
        const qint64 now = m_clock->elapsed();
        m_buffer += m_socket.readAll();
        while (m_buffer.count("event: ready") > m_readyAt.size())
            m_readyAt << now;
        while (m_buffer.count("event: change") > m_changeAt.size())
            m_changeAt << now;
    }

    QString m_host;
    quint16 m_port = 0;
    const QElapsedTimer *m_clock = nullptr;
    QTcpSocket m_socket;
    QByteArray m_sid;
    QByteArray m_buffer;
    qint64 m_openedAt = -1;
    QList<qint64> m_readyAt;
    QList<qint64> m_changeAt;
};

} // namespace

void LiveStreamTest::measuresFrameDeliveryOnARealServer()
{
    const QString origin = qEnvironmentVariable("CLIENT_QT_LIVE_ORIGIN");
    const QString writerUser = qEnvironmentVariable("CLIENT_QT_LIVE_USER");
    const QString writerPassword = qEnvironmentVariable("CLIENT_QT_LIVE_PASSWORD");
    const QString watchUser = qEnvironmentVariable("CLIENT_QT_LIVE_WATCH_USER");
    const QString watchPassword = qEnvironmentVariable("CLIENT_QT_LIVE_WATCH_PASSWORD");
    QVERIFY2(!origin.isEmpty() && !writerUser.isEmpty() && !writerPassword.isEmpty() && !watchUser.isEmpty()
                 && !watchPassword.isEmpty(),
             "CLIENT_QT_LIVE_ORIGIN / _USER / _PASSWORD / _WATCH_USER / _WATCH_PASSWORD are required");
    const int rounds = envInt("CLIENT_QT_LIVE_SSE_ROUNDS", 5);
    const int idleMs = envInt("CLIENT_QT_LIVE_SSE_IDLE_MS", 0);

    QElapsedTimer clock;
    clock.start();
    // A loopback test origin (http://127.0.0.1:<port>) - the raw socket needs its host and port.
    const QUrl url(origin);

    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    shell::Diag diag(QDir(dir.path()).filePath(QStringLiteral("diag.jsonl")));
    net::HttpTransport watcher(origin, &diag);
    net::HttpTransport writer(origin, nullptr);
    QCOMPARE(watcher.send(loginSpec(watchUser, watchPassword)).status, 200);
    QCOMPARE(writer.send(loginSpec(writerUser, writerPassword)).status, 200);
    RawStream raw(url.host(), quint16(url.port(80)), &clock);
    QVERIFY(raw.login(watchUser, watchPassword));

    // What the head of the Qt stream says - the three suspects of open_questions (2).
    {
        net::RequestSpec spec = make(QStringLiteral("stream"), QStringLiteral("GET"), net::buildPath(QStringLiteral("stream")));
        QNetworkReply *probe = watcher.openStream(spec);
        QVERIFY(probe != nullptr);
        QTRY_VERIFY_WITH_TIMEOUT(probe->attribute(QNetworkRequest::HttpStatusCodeAttribute).isValid(), 10000);
        qInfo("LIVE-SSE head: status=%d http2=%d content-type=[%s] content-encoding=[%s] transfer-encoding=[%s] "
              "cache-control=[%s] connection=[%s]",
              probe->attribute(QNetworkRequest::HttpStatusCodeAttribute).toInt(),
              probe->attribute(QNetworkRequest::Http2WasUsedAttribute).toBool() ? 1 : 0,
              probe->rawHeader("Content-Type").constData(), probe->rawHeader("Content-Encoding").constData(),
              probe->rawHeader("Transfer-Encoding").constData(), probe->rawHeader("Cache-Control").constData(),
              probe->rawHeader("Connection").constData());
        probe->abort();
        probe->deleteLater();
    }

    // The first frame (ready) - from the start of each connection.
    raw.open();
    QList<qint64> qtChangeAt;
    qint64 qtReadyAt = -1;
    int drops = 0;
    net::ChangeStream stream(&watcher, &diag);
    QObject::connect(&stream, &net::ChangeStream::readyReceived, [&] { qtReadyAt = clock.elapsed(); });
    QObject::connect(&stream, &net::ChangeStream::changed, [&](const QString &) { qtChangeAt << clock.elapsed(); });
    QObject::connect(&stream, &net::ChangeStream::disconnected, [&](net::CloseReason, int) { ++drops; });
    const qint64 qtStartedAt = clock.elapsed();
    stream.start();
    QTRY_VERIFY_WITH_TIMEOUT(qtReadyAt >= 0 && !raw.readyAt().isEmpty(), 10000);
    qInfo("LIVE-SSE first frame (ready): qt=%lld ms raw=%lld ms (each from its own connect)",
          qtReadyAt - qtStartedAt, raw.readyAt().first() - raw.openedAt());

    // The change frames - from the trigger. The server writes the frame before it answers the POST
    // (server/index.js notifyChange on the route's stack), so both readers usually hear it while
    // the synchronous send() below is still waiting.
    QList<qint64> qtFromTrigger;
    QList<qint64> rawFromTrigger;
    QList<qint64> qtMinusRaw;
    const int total = rounds + (idleMs > 0 ? 1 : 0);
    for (int i = 0; i < total; ++i) {
        if (i == rounds) {
            qInfo("LIVE-SSE idle %d ms before the last change", idleMs);
            QTest::qWait(idleMs);
        }
        net::RequestSpec create = make(QStringLiteral("articles-create"), QStringLiteral("POST"), QStringLiteral("/api/articles"));
        create.body = QJsonObject{{QStringLiteral("title"), QStringLiteral("live-sse-%1").arg(i)}};
        const qint64 triggerAt = clock.elapsed();
        const net::HttpResponse created = writer.send(create);
        const qint64 answeredAt = clock.elapsed();
        QTRY_VERIFY_WITH_TIMEOUT(qtChangeAt.size() > i && raw.changeAt().size() > i, 10000);
        const qint64 qt = qtChangeAt.at(i) - triggerAt;
        const qint64 ref = raw.changeAt().at(i) - triggerAt;
        qtFromTrigger << qt;
        rawFromTrigger << ref;
        qtMinusRaw << qtChangeAt.at(i) - raw.changeAt().at(i);
        qInfo("LIVE-SSE change %d: post status=%d post=%lld ms | raw=+%lld qt=+%lld ms | qt-raw=%lld ms", i,
              created.status, answeredAt - triggerAt, ref, qt, qtChangeAt.at(i) - raw.changeAt().at(i));
        QTest::qWait(150);
    }
    qInfo("LIVE-SSE summary: rounds=%d idle=%d ms | qt from trigger min/median/max=%lld/%lld/%lld ms | "
          "raw from trigger median=%lld ms | qt-raw min/median/max=%lld/%lld/%lld ms | drops=%d",
          total, idleMs, *std::min_element(qtFromTrigger.begin(), qtFromTrigger.end()), median(qtFromTrigger),
          *std::max_element(qtFromTrigger.begin(), qtFromTrigger.end()), median(rawFromTrigger),
          *std::min_element(qtMinusRaw.begin(), qtMinusRaw.end()), median(qtMinusRaw),
          *std::max_element(qtMinusRaw.begin(), qtMinusRaw.end()), drops);
    QCOMPARE(drops, 0);  // one connection all along - the idle wait did not cut it

    stream.stop();
    raw.close();
    watcher.send(make(QStringLiteral("logout"), QStringLiteral("POST"), QStringLiteral("/api/logout")));
    writer.send(make(QStringLiteral("logout"), QStringLiteral("POST"), QStringLiteral("/api/logout")));
}
