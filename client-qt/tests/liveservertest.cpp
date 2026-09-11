#include "liveservertest.h"

#include "net/httpproberunner.h"
#include "net/httptransport.h"

#include <QJsonObject>
#include <QString>
#include <QtTest>

namespace {

net::RequestSpec make(const QString &route, const QString &method, const QString &path)
{
    net::RequestSpec spec;
    spec.routeId = route;
    spec.method = method;
    spec.path = path;
    return spec;
}

} // namespace

void LiveServerTest::roundTripsAgainstARealServer()
{
    const QString origin = qEnvironmentVariable("CLIENT_QT_LIVE_ORIGIN");
    const QString user = qEnvironmentVariable("CLIENT_QT_LIVE_USER");
    const QString password = qEnvironmentVariable("CLIENT_QT_LIVE_PASSWORD");
    QVERIFY2(!origin.isEmpty() && !user.isEmpty() && !password.isEmpty(),
             "CLIENT_QT_LIVE_ORIGIN / _USER / _PASSWORD are required");

    // 검증 절차 3: the real probe against the real /api/health.
    net::HttpProbeRunner runner(nullptr);
    QString reached;
    const shell::HealthVerdict verdict = runner.probe(origin, &reached);
    qInfo("LIVE probe: ok=%d reason=%s final=%s", verdict.ok, qPrintable(verdict.reason), qPrintable(reached));
    QVERIFY(verdict.ok);

    net::HttpTransport transport(origin, nullptr);

    const net::HttpResponse before = transport.send(make(QStringLiteral("session"), QStringLiteral("GET"),
                                                         QStringLiteral("/api/session")));
    qInfo("LIVE session before login: %d %s", before.status, qPrintable(net::outcomeName(before.outcome)));
    QCOMPARE(before.outcome, net::Outcome::Unauthenticated);

    net::RequestSpec login = make(QStringLiteral("login"), QStringLiteral("POST"), QStringLiteral("/api/login"));
    login.body = QJsonObject{{QStringLiteral("userId"), user}, {QStringLiteral("password"), password}};
    const net::HttpResponse loggedIn = transport.send(login);
    qInfo("LIVE login: %d %s", loggedIn.status, qPrintable(net::outcomeName(loggedIn.outcome)));
    QCOMPARE(loggedIn.status, 200);

    // 검증 절차 4: the SameSite=Lax, HttpOnly, non-Secure sid cookie goes back on the next GET...
    const net::HttpResponse session = transport.send(make(QStringLiteral("session"), QStringLiteral("GET"),
                                                          QStringLiteral("/api/session")));
    qInfo("LIVE session after login: %d %s", session.status, qPrintable(net::outcomeName(session.outcome)));
    QCOMPARE(session.status, 200);
    QCOMPARE(session.json.value(QStringLiteral("user")).toObject().value(QStringLiteral("userId")).toString(), user);

    // ... and on a state-changing POST with neither Origin nor Referer: the CSRF guard lets it
    // through (the article does not exist -> 404, not 403 forbidden-origin).
    net::RequestSpec lock = make(QStringLiteral("articles-lock"), QStringLiteral("POST"),
                                 QStringLiteral("/api/articles/NO-SUCH-ARTICLE/lock"));
    lock.body = QJsonObject();
    const net::HttpResponse locked = transport.send(lock);
    qInfo("LIVE lock of a missing article: %d %s reason=%s", locked.status,
          qPrintable(net::outcomeName(locked.outcome)), qPrintable(locked.reason));
    QCOMPARE(locked.status, 404);

    const net::HttpResponse out = transport.send(make(QStringLiteral("logout"), QStringLiteral("POST"),
                                                      QStringLiteral("/api/logout")));
    QCOMPARE(out.status, 200);
    const net::HttpResponse after = transport.send(make(QStringLiteral("session"), QStringLiteral("GET"),
                                                        QStringLiteral("/api/session")));
    qInfo("LIVE session after logout: %d %s", after.status, qPrintable(net::outcomeName(after.outcome)));
    QCOMPARE(after.outcome, net::Outcome::Unauthenticated);
}
