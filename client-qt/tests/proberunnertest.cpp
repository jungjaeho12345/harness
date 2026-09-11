#include "proberunnertest.h"

#include "shell/diag.h"
#include "shell/proberunner.h"
#include "shell/serverurl.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QString>
#include <QTemporaryDir>
#include <QtTest>

namespace {

// A transport double: answers with a fixed verdict and a fixed "final URL".
class ScriptedRunner : public shell::ProbeRunner
{
public:
    shell::HealthVerdict verdict;
    QString finalUrl;  // null QString = nothing observed
    int calls = 0;

    shell::HealthVerdict probe(const QString &, QString *reached) override
    {
        ++calls;
        if (reached)
            *reached = finalUrl;
        return verdict;
    }
};

QList<QJsonObject> readEvents(const QString &path)
{
    QList<QJsonObject> events;
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        return events;
    for (const QByteArray &line : file.readAll().split('\n')) {
        if (line.trimmed().isEmpty())
            continue;
        events << QJsonDocument::fromJson(line).object();
    }
    return events;
}

} // namespace

void ProbeRunnerTest::unimplementedRunnerNeverPretendsToSucceed()
{
    shell::UnimplementedProbeRunner runner;
    QString reached = QStringLiteral("untouched");
    const shell::HealthVerdict verdict = runner.probe(QStringLiteral("http://127.0.0.1:3001"), &reached);

    QVERIFY2(!verdict.ok, "a stand-in that answers ok would hide the missing transport");
    QCOMPARE(verdict.reason, QStringLiteral("unreachable"));
    QVERIFY2(reached.isNull(), "nothing was reached, so no final URL may be reported");
    QCOMPARE(runner.callCount(), 1);

    // The notice the setup screen shows - it has to say what is missing and who brings it.
    const QString notice = runner.limitationNotice();
    QVERIFY(!notice.isEmpty());
    QVERIFY2(notice.contains(QStringLiteral("step7")), qPrintable(notice));
    QVERIFY(notice.contains(QStringLiteral("unreachable")));

    // A real transport has no notice by default (the base class answers empty).
    ScriptedRunner real;
    QVERIFY(real.limitationNotice().isEmpty());
}

void ProbeRunnerTest::logsOneProbeLineWithTheCanonicalPayload()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString diagPath = QDir(tmp.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);

    shell::UnimplementedProbeRunner runner;
    const shell::ProbeOutcome outcome =
        shell::probeOrigin(runner, diag, QStringLiteral("http://127.0.0.1:3001"));
    QVERIFY(!outcome.ok);
    QCOMPARE(outcome.reason, QStringLiteral("unreachable"));
    QCOMPARE(outcome.origin, QStringLiteral("http://127.0.0.1:3001"));
    QVERIFY(!outcome.promoted);

    ScriptedRunner ok;
    ok.verdict.ok = true;
    shell::probeOrigin(ok, diag, QStringLiteral("http://h:3001"));

    const QList<QJsonObject> events = readEvents(diagPath);
    QCOMPARE(events.size(), 2);

    // client/main.js:196-198: {origin, ok, finalOrigin, promoted} + reason only on failure.
    const QJsonObject failed = events.at(0);
    QCOMPARE(failed.value(QStringLiteral("event")).toString(), QStringLiteral("probe"));
    QCOMPARE(failed.value(QStringLiteral("origin")).toString(), QStringLiteral("http://127.0.0.1:3001"));
    QCOMPARE(failed.value(QStringLiteral("ok")).toBool(true), false);
    QCOMPARE(failed.value(QStringLiteral("finalOrigin")).toString(),
             QStringLiteral("http://127.0.0.1:3001"));
    QCOMPARE(failed.value(QStringLiteral("promoted")).toBool(true), false);
    QCOMPARE(failed.value(QStringLiteral("reason")).toString(), QStringLiteral("unreachable"));

    const QJsonObject passed = events.at(1);
    QCOMPARE(passed.value(QStringLiteral("ok")).toBool(false), true);
    QVERIFY2(!passed.contains(QStringLiteral("reason")), "a success carries no reason");
}

// R26 (moved here from a text scan of client/main.js): promotion needs BOTH a successful
// verdict and an acceptable final URL. The pure rules of resolveFinalOrigin (R19-R25, including
// the https -> http refusal) are step2's; this table proves the orchestrator consults them only
// after a success.
void ProbeRunnerTest::promotesTheOriginOnlyOnASuccessfulProbe_data()
{
    QTest::addColumn<QString>("requested");
    QTest::addColumn<bool>("verdictOk");
    QTest::addColumn<QString>("reason");
    QTest::addColumn<QString>("finalUrl");
    QTest::addColumn<QString>("origin");
    QTest::addColumn<bool>("promoted");

    QTest::newRow("success redirected to https -> promoted")
        << QStringLiteral("http://h:3001") << true << QString()
        << QStringLiteral("https://h/api/health") << QStringLiteral("https://h") << true;
    QTest::newRow("success without a redirect -> same origin")
        << QStringLiteral("http://h:3001") << true << QString()
        << QStringLiteral("http://h:3001/api/health") << QStringLiteral("http://h:3001") << false;
    QTest::newRow("success, nothing observed -> requested origin")
        << QStringLiteral("http://h:3001") << true << QString() << QString()
        << QStringLiteral("http://h:3001") << false;
    QTest::newRow("FAILURE redirected to a portal -> never promoted")
        << QStringLiteral("http://h:3001") << false << QStringLiteral("not-article-server")
        << QStringLiteral("http://portal.example/login") << QStringLiteral("http://h:3001") << false;
    QTest::newRow("FAILURE with an https final URL -> never promoted")
        << QStringLiteral("http://h:3001") << false << QStringLiteral("http-status")
        << QStringLiteral("https://h/api/health") << QStringLiteral("http://h:3001") << false;
    QTest::newRow("success downgraded https -> http -> refused by step2")
        << QStringLiteral("https://h") << true << QString()
        << QStringLiteral("http://h/api/health") << QStringLiteral("https://h") << false;
}

void ProbeRunnerTest::promotesTheOriginOnlyOnASuccessfulProbe()
{
    QFETCH(QString, requested);
    QFETCH(bool, verdictOk);
    QFETCH(QString, reason);
    QFETCH(QString, finalUrl);
    QFETCH(QString, origin);
    QFETCH(bool, promoted);

    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString diagPath = QDir(tmp.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);

    ScriptedRunner runner;
    runner.verdict.ok = verdictOk;
    runner.verdict.reason = reason;
    runner.finalUrl = finalUrl;

    const shell::ProbeOutcome outcome = shell::probeOrigin(runner, diag, requested);
    QCOMPARE(runner.calls, 1);
    QCOMPARE(outcome.ok, verdictOk);
    QCOMPARE(outcome.origin, origin);
    QCOMPARE(outcome.promoted, promoted);

    const QList<QJsonObject> events = readEvents(diagPath);
    QCOMPARE(events.size(), 1);
    QCOMPARE(events.first().value(QStringLiteral("finalOrigin")).toString(), origin);
    QCOMPARE(events.first().value(QStringLiteral("promoted")).toBool(!promoted), promoted);
}
