#include "httpproberunnertest.h"

#include "stubhttpserver.h"

#include "net/httpproberunner.h"
#include "shell/diag.h"
#include "shell/proberunner.h"
#include "shell/serverurl.h"

#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QtTest>

namespace {

const QByteArray kHealthBody = R"json({"ok":true})json";

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

} // namespace

void HttpProbeRunnerTest::reachesTheArticleServer()
{
    StubHttpServer server;
    QVERIFY(server.listen());
    server.always(StubReply::json(200, kHealthBody));
    net::HttpProbeRunner runner(nullptr, 3000);

    QString reached;
    const shell::HealthVerdict verdict = runner.probe(server.origin(), &reached);

    QVERIFY(verdict.ok);
    QCOMPARE(reached, shell::healthUrl(server.origin()));
    QCOMPARE(server.requests().size(), 1);
    QCOMPARE(server.requests().first().method, QByteArray("GET"));
    QCOMPARE(server.requests().first().target, QByteArray("/api/health"));
}

// client/main.js:231-233 follows every hop and keeps the last arrival. A 302 to another origin
// (the http -> other-host case the stub can stage) is followed and reported.
void HttpProbeRunnerTest::followsARedirectToTheFinalUrl()
{
    StubHttpServer typed;
    StubHttpServer real;
    QVERIFY(typed.listen());
    QVERIFY(real.listen());
    typed.always(StubReply::redirect(shell::healthUrl(real.origin()).toUtf8()));
    real.always(StubReply::json(200, kHealthBody));
    net::HttpProbeRunner runner(nullptr, 3000);

    QString reached;
    const shell::HealthVerdict verdict = runner.probe(typed.origin(), &reached);

    QVERIFY(verdict.ok);
    QCOMPARE(reached, shell::healthUrl(real.origin()));
    QCOMPARE(typed.requests().size(), 1);
    QCOMPARE(real.requests().size(), 1);
}

void HttpProbeRunnerTest::reportsNothingReachedWhenNobodyListens()
{
    const quint16 port = unusedLocalPort();
    QVERIFY(port != 0);
    net::HttpProbeRunner runner(nullptr, 8000);

    QString reached = QStringLiteral("untouched");
    const shell::HealthVerdict verdict =
        runner.probe(QStringLiteral("http://127.0.0.1:") + QString::number(port), &reached);

    QVERIFY(!verdict.ok);
    QCOMPARE(verdict.reason, QStringLiteral("unreachable"));
    QVERIFY2(reached.isNull(), "nothing answered, so nothing may be reported as reached");
}

void HttpProbeRunnerTest::givesUpAtItsDeadline()
{
    StubHttpServer server;
    QVERIFY(server.listen());
    StubReply silent;
    silent.hang = true;
    server.always(silent);
    net::HttpProbeRunner runner(nullptr, 300);

    QElapsedTimer clock;
    clock.start();
    QString reached;
    const shell::HealthVerdict verdict = runner.probe(server.origin(), &reached);

    QVERIFY(!verdict.ok);
    QCOMPARE(verdict.reason, QStringLiteral("unreachable"));
    QVERIFY(reached.isNull());
    QVERIFY2(clock.elapsed() < 5000, qPrintable(QString::number(clock.elapsed())));
}

// 200 alone proves nothing (a portal answers 200) - and a failed verdict never promotes.
void HttpProbeRunnerTest::judgesAPortalPageNotArticleServer()
{
    StubHttpServer portal;
    QVERIFY(portal.listen());
    portal.always(StubReply::html(200, "<html>Sign in to the Wi-Fi</html>"));
    net::HttpProbeRunner runner(nullptr, 3000);
    shell::Diag noDiag;

    const shell::ProbeOutcome outcome = shell::probeOrigin(runner, noDiag, portal.origin());

    QVERIFY(!outcome.ok);
    QCOMPARE(outcome.reason, QStringLiteral("not-article-server"));
    QCOMPARE(outcome.origin, portal.origin());
    QVERIFY(!outcome.promoted);
}

// A fresh transport per probe: a candidate server gets no cookie, and what one sets is gone
// before the next probe.
void HttpProbeRunnerTest::carriesNoCookieFromOneProbeToTheNext()
{
    StubHttpServer server;
    QVERIFY(server.listen());
    StubReply withCookie = StubReply::json(200, kHealthBody);
    withCookie.headers.append({"Set-Cookie", sessionCookieLine("from-health")});
    server.always(withCookie);
    net::HttpProbeRunner runner(nullptr, 3000);

    QString reached;
    QVERIFY(runner.probe(server.origin(), &reached).ok);
    QVERIFY(runner.probe(server.origin(), &reached).ok);

    QCOMPARE(server.requests().size(), 2);
    QVERIFY(!server.requests().at(0).hasHeader("cookie"));
    QVERIFY(!server.requests().at(1).hasHeader("cookie"));
}

// step5 put the warning on the RUNNER so that it disappears when the real one arrives.
void HttpProbeRunnerTest::confessesNoLimitation()
{
    net::HttpProbeRunner runner(nullptr);
    QVERIFY(runner.limitationNotice().isEmpty());
    QVERIFY(!shell::UnimplementedProbeRunner().limitationNotice().isEmpty());  // control
}

// One user action = net-request{route:health} + probe{origin,ok,finalOrigin,promoted}; the
// response URL itself is never written (client/main.js:194-198).
void HttpProbeRunnerTest::logsTheHealthRouteAndTheProbe()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString diagPath = QDir(tmp.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);

    StubHttpServer typed;
    StubHttpServer real;
    QVERIFY(typed.listen());
    QVERIFY(real.listen());
    typed.always(StubReply::redirect(shell::healthUrl(real.origin()).toUtf8()));
    real.always(StubReply::json(200, kHealthBody));
    net::HttpProbeRunner runner(&diag, 3000);

    const shell::ProbeOutcome outcome = shell::probeOrigin(runner, diag, typed.origin());
    QVERIFY(outcome.ok);
    QVERIFY(outcome.promoted);
    QCOMPARE(outcome.origin, real.origin());

    const QList<QJsonObject> events = readEvents(diagPath);
    QCOMPARE(events.size(), 2);
    QCOMPARE(events.at(0).value(QStringLiteral("event")).toString(), QStringLiteral("net-request"));
    QCOMPARE(events.at(0).value(QStringLiteral("route")).toString(), QStringLiteral("health"));
    QCOMPARE(events.at(0).value(QStringLiteral("method")).toString(), QStringLiteral("GET"));
    QCOMPARE(events.at(0).value(QStringLiteral("status")).toInt(), 200);

    const QJsonObject probe = events.at(1);
    QCOMPARE(probe.value(QStringLiteral("event")).toString(), QStringLiteral("probe"));
    QCOMPARE(probe.value(QStringLiteral("origin")).toString(), typed.origin());
    QCOMPARE(probe.value(QStringLiteral("ok")).toBool(false), true);
    QCOMPARE(probe.value(QStringLiteral("finalOrigin")).toString(), real.origin());
    QCOMPARE(probe.value(QStringLiteral("promoted")).toBool(false), true);
    QVERIFY(!probe.contains(QStringLiteral("reason")));
    const QStringList keys = probe.keys();
    QCOMPARE(QSet<QString>(keys.begin(), keys.end()),
             (QSet<QString>{QStringLiteral("ts"), QStringLiteral("event"), QStringLiteral("origin"),
                            QStringLiteral("ok"), QStringLiteral("finalOrigin"), QStringLiteral("promoted")}));
}
