#include "logincontrollertest.h"

#include "loginwire.h"
#include "repofiles.h"

#include "net/fakenewsmodel.h"
#include "net/httptransport.h"
#include "net/newsmodel.h"
#include "shell/diag.h"
#include "ui/logincontroller.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QSet>
#include <QSignalSpy>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QtTest>

#include <type_traits>

using loginwire::WireScriptedModel;
using ui::LoginController;
using ui::LoginFailure;

Q_DECLARE_METATYPE(net::Outcome)
Q_DECLARE_METATYPE(ui::LoginFailure)

namespace {

// A diag sink in a temporary folder, read back line by line.
struct DiagFile {
    QTemporaryDir dir;
    shell::Diag diag;

    DiagFile() : diag(QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"))) {}

    QByteArray raw() const
    {
        QFile file(diag.filePath());
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray();
    }

    QList<QJsonObject> events() const
    {
        QList<QJsonObject> out;
        for (const QByteArray &line : raw().split('\n')) {
            if (!line.trimmed().isEmpty())
                out << QJsonDocument::fromJson(line).object();
        }
        return out;
    }
};

QString eventName(const QJsonObject &event)
{
    return event.value(QStringLiteral("event")).toString();
}

QString sentence(LoginFailure failure)
{
    return ui::loginFailureMessage(failure);
}

const QList<LoginFailure> kFailureKinds{LoginFailure::InvalidCredentials, LoginFailure::AccountLocked,
                                        LoginFailure::RateLimited,        LoginFailure::Refused,
                                        LoginFailure::Unreachable,        LoginFailure::TimedOut,
                                        LoginFailure::InvalidResponse,    LoginFailure::Unexpected};

} // namespace

// ---------------------------------------------------------------------------
// Axis 1 - 200. One login line, THEN one success signal (the shell switches screens on that signal,
// and the driver reads login{200} before the session request that follows it).
void LoginControllerTest::succeedsOn200AndSaysSoOnce()
{
    WireScriptedModel model;
    DiagFile sink;
    LoginController controller(model, &sink.diag);
    QSignalSpy succeeded(&controller, &LoginController::loginSucceeded);
    QSignalSpy failed(&controller, &LoginController::loginFailed);
    int linesWhenSignalled = -1;
    connect(&controller, &LoginController::loginSucceeded, this,
            [&sink, &linesWhenSignalled] { linesWhenSignalled = static_cast<int>(sink.events().size()); });

    const ui::LoginAttempt attempt = controller.login(loginwire::kUser, loginwire::kPassword);

    QVERIFY(attempt.ok);
    QCOMPARE(attempt.status, 200);
    QCOMPARE(attempt.failure, LoginFailure::None);
    QVERIFY(attempt.message.isEmpty());
    QCOMPARE(succeeded.count(), 1);
    QCOMPARE(failed.count(), 0);
    QCOMPARE(linesWhenSignalled, 1);  // the login line is on disk before anyone hears the signal
    QCOMPARE(model.loginCalls, 1);
    QCOMPARE(model.sessionCalls, 0);  // the identity check is the screen change's step, not login()'s

    const QList<QJsonObject> events = sink.events();
    QCOMPARE(events.size(), 1);
    QCOMPARE(eventName(events.at(0)), QStringLiteral("login"));
    QCOMPARE(events.at(0).value(QStringLiteral("status")).toInt(), 200);
}

// Axis 2 - 401 invalid-credentials (the fake's own answer, as the server gives it).
void LoginControllerTest::reportsWrongCredentialsOn401()
{
    WireScriptedModel model;
    DiagFile sink;
    LoginController controller(model, &sink.diag);
    QSignalSpy succeeded(&controller, &LoginController::loginSucceeded);
    QSignalSpy failed(&controller, &LoginController::loginFailed);

    const ui::LoginAttempt attempt = controller.login(loginwire::kUser, QStringLiteral("not-the-password"));

    QVERIFY(!attempt.ok);
    QCOMPARE(attempt.status, 401);
    QCOMPARE(attempt.failure, LoginFailure::InvalidCredentials);
    QCOMPARE(attempt.message, sentence(LoginFailure::InvalidCredentials));
    QVERIFY(!attempt.message.isEmpty());
    QCOMPARE(succeeded.count(), 0);
    QCOMPARE(failed.count(), 1);
    QCOMPARE(failed.at(0).at(0).toString(), attempt.message);
    QCOMPARE(sink.events().size(), 1);
    QCOMPARE(sink.events().at(0).value(QStringLiteral("status")).toInt(), 401);
}

// Axis 3 - 423: the ACCOUNT is locked (5 failures -> 15 minutes, override L22). The right password is
// refused too, so the sentence must not send the user back to retyping it.
void LoginControllerTest::reportsTheAccountLockOn423()
{
    WireScriptedModel model;
    model.loginWire = loginwire::accountLocked();
    DiagFile sink;
    LoginController controller(model, &sink.diag);
    QSignalSpy succeeded(&controller, &LoginController::loginSucceeded);
    QSignalSpy failed(&controller, &LoginController::loginFailed);

    const ui::LoginAttempt attempt = controller.login(loginwire::kUser, loginwire::kPassword);

    QVERIFY(!attempt.ok);
    QCOMPARE(attempt.status, 423);
    QCOMPARE(attempt.failure, LoginFailure::AccountLocked);
    QCOMPARE(attempt.message, sentence(LoginFailure::AccountLocked));
    QVERIFY2(attempt.message != sentence(LoginFailure::InvalidCredentials),
             "423 (account lock) must not read like a wrong password (401)");
    QVERIFY2(attempt.message != sentence(LoginFailure::RateLimited),
             "423 (account lock) and 429 (IP rate limit) are two axes (override L142)");
    QCOMPARE(succeeded.count(), 0);
    QCOMPARE(failed.count(), 1);
    QCOMPARE(sink.events().size(), 1);
    QCOMPARE(sink.events().at(0).value(QStringLiteral("status")).toInt(), 423);
}

// Axis 4 - 429: the IP rate limit. Its body is express-rate-limit's text, so the Model body is the
// canonical {ok:false, reason:"invalid-response"} - the precondition below proves it - and only the
// outcome says "rate limited". Reading the reason would print "the answer is broken" here.
void LoginControllerTest::reportsTheIpRateLimitOn429NotABrokenAnswer()
{
    WireScriptedModel model;
    model.loginWire = loginwire::rateLimited();
    const net::ModelResult raw = net::modelResultFrom(*model.loginWire);
    QCOMPARE(raw.reason(), QStringLiteral("invalid-response"));
    QCOMPARE(raw.outcome, net::Outcome::RateLimited);

    DiagFile sink;
    LoginController controller(model, &sink.diag);
    QSignalSpy failed(&controller, &LoginController::loginFailed);

    const ui::LoginAttempt attempt = controller.login(loginwire::kUser, loginwire::kPassword);

    QVERIFY(!attempt.ok);
    QCOMPARE(attempt.status, 429);
    QCOMPARE(attempt.failure, LoginFailure::RateLimited);
    QCOMPARE(attempt.message, sentence(LoginFailure::RateLimited));
    QVERIFY2(attempt.message != sentence(LoginFailure::InvalidResponse),
             "a 429 must not be shown as a broken answer (its reason token is invalid-response)");
    QVERIFY2(attempt.message != sentence(LoginFailure::AccountLocked), "429 is not the account lock");
    QCOMPARE(failed.count(), 1);
    QCOMPARE(sink.events().size(), 1);
    QCOMPARE(sink.events().at(0).value(QStringLiteral("status")).toInt(), 429);
}

// Axis 5 - no answer at all. status -1, and the diag says null (no number is invented).
void LoginControllerTest::reportsANetworkFailureWhenNoAnswerArrives()
{
    WireScriptedModel model;
    model.loginWire = loginwire::noAnswer(net::Outcome::NetworkError);
    DiagFile sink;
    LoginController controller(model, &sink.diag);
    QSignalSpy succeeded(&controller, &LoginController::loginSucceeded);
    QSignalSpy failed(&controller, &LoginController::loginFailed);

    const ui::LoginAttempt attempt = controller.login(loginwire::kUser, loginwire::kPassword);

    QVERIFY(!attempt.ok);
    QCOMPARE(attempt.status, -1);
    QCOMPARE(attempt.failure, LoginFailure::Unreachable);
    QCOMPARE(attempt.message, sentence(LoginFailure::Unreachable));
    QCOMPARE(succeeded.count(), 0);
    QCOMPARE(failed.count(), 1);
    const QList<QJsonObject> events = sink.events();
    QCOMPARE(events.size(), 1);
    QVERIFY(events.at(0).contains(QStringLiteral("status")));
    QVERIFY(events.at(0).value(QStringLiteral("status")).isNull());

    // The deadline is its own kind (a slow server is not a missing one).
    model.loginWire = loginwire::noAnswer(net::Outcome::Timeout);
    const ui::LoginAttempt late = controller.login(loginwire::kUser, loginwire::kPassword);
    QCOMPARE(late.status, -1);
    QCOMPARE(late.failure, LoginFailure::TimedOut);
}

// ---------------------------------------------------------------------------
// Every outcome the transport can report lands on exactly one kind.
void LoginControllerTest::mapsEveryOutcomeToOneKind_data()
{
    QTest::addColumn<net::Outcome>("outcome");
    QTest::addColumn<LoginFailure>("expected");

    QTest::newRow("Ok") << net::Outcome::Ok << LoginFailure::None;
    QTest::newRow("InvalidCredentials 401") << net::Outcome::InvalidCredentials << LoginFailure::InvalidCredentials;
    QTest::newRow("AccountLocked 423") << net::Outcome::AccountLocked << LoginFailure::AccountLocked;
    QTest::newRow("RateLimited 429") << net::Outcome::RateLimited << LoginFailure::RateLimited;
    QTest::newRow("Forbidden 403 inactive") << net::Outcome::Forbidden << LoginFailure::Refused;
    QTest::newRow("NetworkError") << net::Outcome::NetworkError << LoginFailure::Unreachable;
    QTest::newRow("Timeout") << net::Outcome::Timeout << LoginFailure::TimedOut;
    QTest::newRow("InvalidResponse") << net::Outcome::InvalidResponse << LoginFailure::InvalidResponse;
    QTest::newRow("Unauthenticated (not a login answer)") << net::Outcome::Unauthenticated << LoginFailure::Unexpected;
    QTest::newRow("EditLockConflict (not a login answer)") << net::Outcome::EditLockConflict << LoginFailure::Unexpected;
    QTest::newRow("BadRequest") << net::Outcome::BadRequest << LoginFailure::Unexpected;
    QTest::newRow("NotFound") << net::Outcome::NotFound << LoginFailure::Unexpected;
    QTest::newRow("Conflict") << net::Outcome::Conflict << LoginFailure::Unexpected;
    QTest::newRow("ServerError") << net::Outcome::ServerError << LoginFailure::Unexpected;
    QTest::newRow("Unavailable") << net::Outcome::Unavailable << LoginFailure::Unexpected;
    QTest::newRow("Unclassified") << net::Outcome::Unclassified << LoginFailure::Unexpected;
}

void LoginControllerTest::mapsEveryOutcomeToOneKind()
{
    QFETCH(net::Outcome, outcome);
    QFETCH(LoginFailure, expected);
    QCOMPARE(ui::loginFailureFor(outcome), expected);
}

// Each remedy has its own sentence - the step's rule "423 and 429 are never one sentence", widened to
// every kind. Success has none.
void LoginControllerTest::givesEveryKindItsOwnSentence()
{
    QVERIFY(ui::loginFailureMessage(LoginFailure::None).isEmpty());
    QSet<QString> seen;
    for (const LoginFailure kind : kFailureKinds) {
        const QString text = sentence(kind);
        QVERIFY2(!text.isEmpty(), qPrintable(QStringLiteral("kind %1 has no sentence").arg(static_cast<int>(kind))));
        QVERIFY2(!seen.contains(text), qPrintable(QStringLiteral("kind %1 repeats a sentence: ").arg(static_cast<int>(kind)) + text));
        seen.insert(text);
    }
    QCOMPARE(seen.size(), kFailureKinds.size());
    QVERIFY(ui::loginFailureMessage(LoginFailure::Unexpected, 500).contains(QStringLiteral("500")));
    QVERIFY(!ui::sessionEndedMessage().isEmpty());
    QVERIFY(!seen.contains(ui::sessionEndedMessage()));
}

// The other half of axis 4: a genuinely broken answer (a captive portal's HTML on 200) carries the
// SAME reason token as the 429 - and still gets its own sentence, because the outcome differs. A
// 200 that does not say ok:true is not a success either.
void LoginControllerTest::tellsARealBrokenAnswerFromTheRateLimit()
{
    WireScriptedModel model;
    LoginController controller(model, nullptr);

    model.loginWire = loginwire::wireAnswer(QStringLiteral("login"), 200, QByteArrayLiteral("<html>portal</html>"));
    QCOMPARE(net::modelResultFrom(*model.loginWire).reason(), QStringLiteral("invalid-response"));
    const ui::LoginAttempt portal = controller.login(loginwire::kUser, loginwire::kPassword);
    QCOMPARE(portal.failure, LoginFailure::InvalidResponse);

    model.loginWire = loginwire::rateLimited();
    const ui::LoginAttempt limited = controller.login(loginwire::kUser, loginwire::kPassword);
    QCOMPARE(limited.failure, LoginFailure::RateLimited);
    QVERIFY(portal.message != limited.message);

    model.loginWire = loginwire::wireAnswer(QStringLiteral("login"), 200, QByteArrayLiteral(R"json({"ok":false})json"));
    QSignalSpy succeeded(&controller, &LoginController::loginSucceeded);
    const ui::LoginAttempt notOk = controller.login(loginwire::kUser, loginwire::kPassword);
    QVERIFY(!notOk.ok);
    QCOMPARE(notOk.failure, LoginFailure::Unexpected);
    QCOMPARE(succeeded.count(), 0);
}

// Rule 1 as a structural lock: the controller has no way to reach the reason token at all.
void LoginControllerTest::neverReadsTheReasonToken()
{
    QByteArray bytes;
    QString error;
    QVERIFY2(readRepoFile(QStringLiteral("client-qt/src/ui/logincontroller.cpp"), &bytes, &error), qPrintable(error));
    QVERIFY2(bytes.size() > 500, "non-vacuity: the real source was read");
    const QString text = QString::fromUtf8(bytes);
    for (const QString &token : {QStringLiteral(".reason()"), QStringLiteral("\"reason\"")})
        QVERIFY2(!text.contains(token), qPrintable(QStringLiteral("logincontroller.cpp reads ") + token));
}

// L123-128 / decisions (7): the label comes from GET /api/session, asked every time. The server
// changes the account between the login and the check; the label follows the server, and a second
// check asks again (nothing is cached).
void LoginControllerTest::confirmsTheIdentityWithTheServerNotTheLoginAnswer()
{
    WireScriptedModel model;
    DiagFile sink;
    LoginController controller(model, &sink.diag);
    QVERIFY(controller.login(loginwire::kUser, loginwire::kPassword).ok);

    model.updateUser(loginwire::kUser,
                     QJsonObject{{QStringLiteral("role"), QStringLiteral("Z")}, {QStringLiteral("department"), QStringLiteral("운영부")}});
    const ui::SessionCheck check = controller.confirmSession();

    QVERIFY(check.ok);
    QCOMPARE(check.status, 200);
    QVERIFY(!check.sessionEnded);
    QVERIFY(check.message.isEmpty());
    QCOMPARE(check.identityLabel, QStringLiteral("desk · 운영부 · (Z)"));
    QCOMPARE(model.sessionCalls, 1);

    const QList<QJsonObject> events = sink.events();
    QCOMPARE(events.size(), 2);
    QCOMPARE(eventName(events.at(1)), QStringLiteral("session"));
    QCOMPARE(events.at(1).value(QStringLiteral("status")).toInt(), 200);

    controller.confirmSession();
    QCOMPARE(model.sessionCalls, 2);
    QCOMPARE(ui::identityLabelFrom(QJsonObject{{QStringLiteral("userId"), QStringLiteral("kim")},
                                               {QStringLiteral("role"), QStringLiteral("R")}}),
             QStringLiteral("kim · (R)"));
}

// 401 unauthenticated on the identity check = the session is gone (decisions (7) 4).
void LoginControllerTest::reportsAnEndedSessionOnTheIdentityCheck()
{
    WireScriptedModel model;
    model.sessionWire = loginwire::wireAnswer(QStringLiteral("session"), 401,
                                              QByteArrayLiteral(R"json({"ok":false,"reason":"unauthenticated"})json"));
    DiagFile sink;
    LoginController controller(model, &sink.diag);

    const ui::SessionCheck check = controller.confirmSession();

    QVERIFY(!check.ok);
    QCOMPARE(check.status, 401);
    QVERIFY(check.sessionEnded);
    QVERIFY(check.identityLabel.isEmpty());
    QCOMPARE(check.message, ui::sessionEndedMessage());
    QCOMPARE(sink.events().size(), 1);
    QCOMPARE(sink.events().at(0).value(QStringLiteral("status")).toInt(), 401);
}

// No answer, or not our server's answer: the identity is NOT confirmed (and the session is not
// declared over either - the server never said so).
void LoginControllerTest::cannotConfirmAnIdentityWithoutAnAnswer()
{
    WireScriptedModel model;
    DiagFile sink;
    LoginController controller(model, &sink.diag);

    model.sessionWire = loginwire::noAnswer(net::Outcome::NetworkError);
    const ui::SessionCheck lost = controller.confirmSession();
    QVERIFY(!lost.ok);
    QCOMPARE(lost.status, -1);
    QVERIFY(!lost.sessionEnded);
    QVERIFY(lost.identityLabel.isEmpty());
    QCOMPARE(lost.message, sentence(LoginFailure::Unreachable));
    QVERIFY(!lost.message.isEmpty());
    QCOMPARE(sink.events().size(), 1);
    QVERIFY(sink.events().at(0).contains(QStringLiteral("status")));
    QVERIFY(sink.events().at(0).value(QStringLiteral("status")).isNull());

    model.sessionWire = loginwire::wireAnswer(QStringLiteral("session"), 200, QByteArrayLiteral("<html>portal</html>"));
    const ui::SessionCheck portal = controller.confirmSession();
    QVERIFY(!portal.ok);
    QVERIFY(!portal.sessionEnded);
    QCOMPARE(portal.message, sentence(LoginFailure::InvalidResponse));
}

// Rule 3: the diag carries login/session with a status and nothing else - never the password (a right
// one, a wrong one), whichever way the attempt ended.
void LoginControllerTest::writesOnlyStatusesAndNeverThePassword()
{
    const QString password = QStringLiteral("pw-7f3a9c-right");
    const QString wrong = QStringLiteral("pw-0b61e2-wrong");
    net::FakeSeed seed = loginwire::deskSeed();
    seed.users[0].insert(QStringLiteral("password"), password);
    WireScriptedModel model(seed);
    DiagFile sink;
    LoginController controller(model, &sink.diag);

    controller.login(loginwire::kUser, wrong);
    QVERIFY(controller.login(loginwire::kUser, password).ok);
    controller.confirmSession();
    for (const net::HttpResponse &wire : {loginwire::accountLocked(), loginwire::rateLimited(),
                                          loginwire::noAnswer(net::Outcome::NetworkError)}) {
        model.loginWire = wire;
        controller.login(loginwire::kUser, password);
    }

    const QByteArray raw = sink.raw();
    QVERIFY2(raw.size() > 100, "non-vacuity: the lines were written");
    QVERIFY2(!raw.contains(password.toUtf8()), "the right password reached the diag");
    QVERIFY2(!raw.contains(wrong.toUtf8()), "a wrong password reached the diag");

    const QStringList vocabulary = ui::loginControllerDiagEvents();
    QCOMPARE(QSet<QString>(vocabulary.begin(), vocabulary.end()),
             (QSet<QString>{QStringLiteral("login"), QStringLiteral("session")}));
    for (const QString &name : vocabulary)
        QVERIFY2(shell::isAllowedDiagEvent(name), qPrintable(name));
    const QList<QJsonObject> events = sink.events();
    QCOMPARE(events.size(), 6);
    for (const QJsonObject &event : events) {
        QVERIFY(vocabulary.contains(eventName(event)));
        const QStringList keys = event.keys();
        QCOMPARE(QSet<QString>(keys.begin(), keys.end()),
                 (QSet<QString>{QStringLiteral("ts"), QStringLiteral("event"), QStringLiteral("status")}));
    }
    QCOMPARE(sink.diag.rejectedEventCount(), 0);
}

// ADR-003: the controller takes the Model interface and a diag sink - no widget, no transport. The
// scan keeps it that way (a widget include would make these tests need a screen).
void LoginControllerTest::dependsOnNoWidget()
{
    static_assert(std::is_constructible_v<LoginController, net::INewsModel &, shell::Diag *>,
                  "LoginController(INewsModel&, Diag*) - step10 B");
    static_assert(!std::is_copy_constructible_v<LoginController>, "one controller per Model");

    const QStringList forbidden{QStringLiteral("QWidget"),        QStringLiteral("QLineEdit"),
                                QStringLiteral("QLabel"),         QStringLiteral("QPushButton"),
                                QStringLiteral("QApplication"),   QStringLiteral("ui/loginscreen.h"),
                                QStringLiteral("ui/mainwindow.h"), QStringLiteral("HttpTransport"),
                                QStringLiteral("HttpNewsModel")};
    for (const QString &relative : {QStringLiteral("client-qt/src/ui/logincontroller.h"),
                                    QStringLiteral("client-qt/src/ui/logincontroller.cpp")}) {
        QByteArray bytes;
        QString error;
        QVERIFY2(readRepoFile(relative, &bytes, &error), qPrintable(error));
        QVERIFY2(bytes.size() > 500, qPrintable(relative));
        const QString text = QString::fromUtf8(bytes);
        for (const QString &token : forbidden)
            QVERIFY2(!text.contains(token), qPrintable(relative + QStringLiteral(" names ") + token));
    }
}
