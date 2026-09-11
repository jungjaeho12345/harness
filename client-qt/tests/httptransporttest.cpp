#include "httptransporttest.h"

#include "stubhttpserver.h"

#include "net/editclientid.h"
#include "net/httptransport.h"
#include "shell/diag.h"

#include <QByteArray>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QVariantMap>
#include <QtTest>

using net::Outcome;

namespace {

net::RequestSpec make(const QString &route, const QString &method, const QString &path)
{
    net::RequestSpec spec;
    spec.routeId = route;
    spec.method = method;
    spec.path = path;
    return spec;
}

net::RequestSpec withBody(net::RequestSpec spec, const QJsonObject &body)
{
    spec.body = body;
    return spec;
}

net::RequestSpec loginSpec()
{
    return withBody(make(QStringLiteral("login"), QStringLiteral("POST"), QStringLiteral("/api/login")),
                    QJsonObject{{QStringLiteral("userId"), QStringLiteral("kim")},
                                {QStringLiteral("password"), QStringLiteral("pw")}});
}

net::RequestSpec sessionSpec()
{
    return make(QStringLiteral("session"), QStringLiteral("GET"), QStringLiteral("/api/session"));
}

net::RequestSpec lockSpec(const QString &articlePath = QStringLiteral("/api/articles/AKR1/lock"))
{
    return withBody(make(QStringLiteral("articles-lock"), QStringLiteral("POST"), articlePath), QJsonObject());
}

// The login answer of server/index.js:621-625: the sid cookie AND a sessionId in the body (the
// web's header fallback reads that one; this client must not).
StubReply loginReply(const QByteArray &sid)
{
    StubReply reply = StubReply::json(
        200, R"json({"ok":true,"sessionId":")json" + sid + R"json(","user":{"userId":"kim","role":"R"}})json");
    reply.headers.append({"Set-Cookie", sessionCookieLine(sid)});
    return reply;
}

const QByteArray kOkBody = R"json({"ok":true})json";

// express-rate-limit's default answer - no custom handler on loginLimiter (server/index.js:609-614)
// - which contract/cases/auth-negative/login-negative.contract.js:108-111 proves is not JSON.
StubReply rateLimitReply()
{
    StubReply reply = StubReply::html(429, "Too many requests, please try again later.");
    reply.headers.append({QByteArray("RateLimit-Limit"), QByteArray("10")});
    reply.headers.append({QByteArray("RateLimit-Remaining"), QByteArray("0")});
    reply.headers.append({QByteArray("RateLimit-Reset"), QByteArray("900")});
    return reply;
}

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

QString name(Outcome outcome)
{
    return net::outcomeName(outcome);
}

} // namespace

// ---------------------------------------------------------------------------------------------
void HttpTransportTest::parsesAJsonAnswer()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.always(StubReply::json(200, R"json({"ok":true,"user":{"userId":"kim"}})json"));
    net::HttpTransport transport(stub.origin(), nullptr);

    const net::HttpResponse r = transport.send(sessionSpec());

    QCOMPARE(r.status, 200);
    QVERIFY(r.jsonOk);
    QCOMPARE(r.json.value(QStringLiteral("ok")).toBool(false), true);
    QCOMPARE(r.json.value(QStringLiteral("user")).toObject().value(QStringLiteral("userId")).toString(),
             QStringLiteral("kim"));
    QVERIFY(r.reason.isEmpty());
    QCOMPARE(name(r.outcome), QStringLiteral("Ok"));
    QCOMPARE(r.finalUrl, stub.origin() + QStringLiteral("/api/session"));
    QCOMPARE(stub.requests().size(), 1);
    QCOMPARE(stub.requests().first().method, QByteArray("GET"));
    QCOMPARE(stub.requests().first().target, QByteArray("/api/session"));
}

// R6 (httpModel.js:110-113): the body is parsed whatever the status; the status is not thrown away.
void HttpTransportTest::keepsTheJsonOfAnErrorStatus()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.always(StubReply::json(403, R"json({"ok":false,"reason":"forbidden"})json"));
    net::HttpTransport transport(stub.origin(), nullptr);

    const net::HttpResponse r =
        transport.send(make(QStringLiteral("articles-force-unlock"), QStringLiteral("POST"),
                            QStringLiteral("/api/articles/AKR1/force-unlock")));

    QCOMPARE(r.status, 403);
    QVERIFY(r.jsonOk);
    QCOMPARE(r.json.value(QStringLiteral("ok")).toBool(true), false);
    QCOMPARE(r.reason, QStringLiteral("forbidden"));
    QCOMPARE(name(r.outcome), QStringLiteral("Forbidden"));
}

void HttpTransportTest::flagsABodyThatIsNotAJsonObject_data()
{
    QTest::addColumn<QByteArray>("contentType");
    QTest::addColumn<QByteArray>("body");

    QTest::newRow("proxy html page") << QByteArray("text/html; charset=utf-8")
                                     << QByteArray("<html><body>Bad gateway</body></html>");
    QTest::newRow("empty body") << QByteArray("application/json") << QByteArray();
    QTest::newRow("JSON array") << QByteArray("application/json") << QByteArray("[1,2]");
    QTest::newRow("JSON string") << QByteArray("application/json") << QByteArray("\"ok\"");
    QTest::newRow("truncated JSON") << QByteArray("application/json") << QByteArray("{\"ok\":");
}

// R7 (httpModel.js:114-117): a body that is not ours is flagged, never guessed at. The transport
// does not invent a reason token for it - that translation belongs to the Model (step8).
void HttpTransportTest::flagsABodyThatIsNotAJsonObject()
{
    QFETCH(QByteArray, contentType);
    QFETCH(QByteArray, body);

    StubHttpServer stub;
    QVERIFY(stub.listen());
    StubReply reply = StubReply::json(200, body);
    reply.contentType = contentType;
    stub.always(reply);
    net::HttpTransport transport(stub.origin(), nullptr);

    const net::HttpResponse r = transport.send(sessionSpec());

    QCOMPARE(r.status, 200);
    QVERIFY(!r.jsonOk);
    QVERIFY(r.json.isEmpty());
    QVERIFY(r.reason.isEmpty());
    QCOMPARE(r.body, body);
    QCOMPARE(name(r.outcome), QStringLiteral("InvalidResponse"));
}

// R13 (native-only): fetch has no deadline; this transport never waits forever.
void HttpTransportTest::timesOutInsteadOfWaitingForever()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    StubReply silent;
    silent.hang = true;
    stub.always(silent);
    net::HttpTransport transport(stub.origin(), nullptr);

    net::RequestSpec spec = sessionSpec();
    spec.timeoutMs = 300;
    QElapsedTimer clock;
    clock.start();
    const net::HttpResponse r = transport.send(spec);
    const qint64 elapsed = clock.elapsed();

    QCOMPARE(name(r.outcome), QStringLiteral("Timeout"));
    QCOMPARE(r.status, -1);
    QVERIFY(r.body.isEmpty());
    QVERIFY(r.finalUrl.isEmpty());
    QVERIFY2(elapsed >= 250 && elapsed < 5000, qPrintable(QString::number(elapsed)));
    QCOMPARE(stub.requests().size(), 1);  // it reached the server: the deadline ended it, not a refusal
}

// R8: nobody listening -> NetworkError with no status (and no message leaked anywhere).
void HttpTransportTest::reportsARefusedConnection()
{
    const quint16 port = unusedLocalPort();
    QVERIFY(port != 0);
    net::HttpTransport transport(QStringLiteral("http://127.0.0.1:") + QString::number(port), nullptr);

    net::RequestSpec spec = sessionSpec();
    spec.timeoutMs = 10000;
    QElapsedTimer clock;
    clock.start();
    const net::HttpResponse r = transport.send(spec);
    const qint64 elapsed = clock.elapsed();
    qInfo("refused connection reported after %lld ms", static_cast<long long>(elapsed));

    QCOMPARE(name(r.outcome), QStringLiteral("NetworkError"));
    QCOMPARE(r.status, -1);
    QVERIFY(r.body.isEmpty());
    QVERIFY2(elapsed < 9000, "a refusal must not be reported as a deadline");
}

// fetch() throws a TypeError for a GET with a body and the canonical maps that onto
// network-error without sending anything. Qt would send it; this transport refuses.
void HttpTransportTest::refusesABodyOnAGet()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);

    const net::HttpResponse r = transport.send(withBody(sessionSpec(), QJsonObject()));

    QCOMPARE(name(r.outcome), QStringLiteral("NetworkError"));
    QVERIFY(stub.requests().isEmpty());
}

// ---------------------------------------------------------------------------------------------
// The jar replays the server's sid cookie - including the non-production SameSite=Lax cookie on
// a state-changing POST (step7.md 검증 절차 4: measured, not assumed).
void HttpTransportTest::carriesTheSessionCookieToTheNextRequest()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({loginReply("abc123"), StubReply::json(200, kOkBody), StubReply::json(200, kOkBody)});
    net::HttpTransport transport(stub.origin(), nullptr);

    transport.send(loginSpec());
    transport.send(sessionSpec());
    transport.send(lockSpec());

    QCOMPARE(stub.requests().size(), 3);
    QVERIFY(!stub.requests().at(0).hasHeader("cookie"));
    QCOMPARE(stub.requests().at(1).header("cookie"), QByteArray("sid=abc123"));
    QCOMPARE(stub.requests().at(1).headerCount("cookie"), 1);
    QCOMPARE(stub.requests().at(2).method, QByteArray("POST"));
    QCOMPARE(stub.requests().at(2).header("cookie"), QByteArray("sid=abc123"));
}

void HttpTransportTest::stopsSendingTheCookieAfterClearSession()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({loginReply("abc123")});
    net::HttpTransport transport(stub.origin(), nullptr);

    transport.send(loginSpec());
    transport.send(sessionSpec());
    transport.clearSession();
    transport.send(sessionSpec());

    QCOMPARE(stub.requests().size(), 3);
    QCOMPARE(stub.requests().at(1).header("cookie"), QByteArray("sid=abc123"));  // non-vacuity
    QVERIFY(!stub.requests().at(2).hasHeader("cookie"));
}

// logout: the server answers sid=; Max-Age=0 (server/index.js:576-584) and the jar lets it go.
void HttpTransportTest::forgetsTheCookieTheServerExpires()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    StubReply logout = StubReply::json(200, kOkBody);
    logout.headers.append({"Set-Cookie", clearedSessionCookieLine()});
    stub.inOrder({loginReply("abc123"), logout});
    net::HttpTransport transport(stub.origin(), nullptr);

    transport.send(loginSpec());
    transport.send(make(QStringLiteral("logout"), QStringLiteral("POST"), QStringLiteral("/api/logout")));
    transport.send(sessionSpec());

    QCOMPARE(stub.requests().size(), 3);
    QCOMPARE(stub.requests().at(1).header("cookie"), QByteArray("sid=abc123"));
    QVERIFY(!stub.requests().at(2).hasHeader("cookie"));
}

// decisions (6) / ADR-018 ⑤: the jar is memory only. A transport built after the first one is
// gone - an app restart - must not carry the old session, wherever a persistent jar would have
// written it. (Divergence from the web's one-hour persistent cookie, on purpose.)
void HttpTransportTest::keepsNoSessionAcrossARestart()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({loginReply("sid-restart")});
    {
        net::HttpTransport first(stub.origin(), nullptr);
        first.send(loginSpec());
        first.send(sessionSpec());
    }
    QCOMPARE(stub.requests().size(), 2);
    QCOMPARE(stub.requests().at(1).header("cookie"), QByteArray("sid=sid-restart"));  // the jar did hold it

    net::HttpTransport second(stub.origin(), nullptr);
    second.send(sessionSpec());

    QCOMPARE(stub.requests().size(), 3);
    QVERIFY2(!stub.requests().at(2).hasHeader("cookie"),
             "a session outlived the transport - the cookie was persisted somewhere");
}

void HttpTransportTest::dropsTheSessionOnlyOnUnauthenticated_data()
{
    QTest::addColumn<QString>("route");
    QTest::addColumn<QString>("method");
    QTest::addColumn<QString>("path");
    QTest::addColumn<int>("status");
    QTest::addColumn<bool>("html");
    QTest::addColumn<QByteArray>("body");
    QTest::addColumn<bool>("keeps");

    QTest::newRow("edit-lock conflict (articles-lock, 401, locked) keeps the session")
        << "articles-lock" << "POST" << "/api/articles/AKR1/lock" << 401 << false
        << QByteArray(R"json({"ok":false,"reason":"locked"})json") << true;
    QTest::newRow("wrong password (login, 401, invalid-credentials) keeps it")
        << "login" << "POST" << "/api/login" << 401 << false
        << QByteArray(R"json({"ok":false,"reason":"invalid-credentials"})json") << true;
    QTest::newRow("account lock (login, 423, locked) keeps it")
        << "login" << "POST" << "/api/login" << 423 << false
        << QByteArray(R"json({"ok":false,"reason":"locked"})json") << true;
    QTest::newRow("rate limit (login, 429, text/html) keeps it")
        << "login" << "POST" << "/api/login" << 429 << true
        << QByteArray("Too many requests, please try again later.") << true;
    QTest::newRow("forbidden (403) keeps it")
        << "articles-force-unlock" << "POST" << "/api/articles/AKR1/force-unlock" << 403 << false
        << QByteArray(R"json({"ok":false,"reason":"forbidden"})json") << true;
    QTest::newRow("a 401 page without a token keeps it")
        << "session" << "GET" << "/api/session" << 401 << true << QByteArray("<html>401</html>") << true;
    QTest::newRow("(session, 401, unauthenticated) drops it")
        << "session" << "GET" << "/api/session" << 401 << false
        << QByteArray(R"json({"ok":false,"reason":"unauthenticated"})json") << false;
    QTest::newRow("(articles-lock, 401, unauthenticated) drops it")
        << "articles-lock" << "POST" << "/api/articles/AKR1/lock" << 401 << false
        << QByteArray(R"json({"ok":false,"reason":"unauthenticated"})json") << false;
}

// step7.md: session disposal is 401 + unauthenticated ONLY. Dropping it on every 401 logs the
// user out on an edit-lock conflict.
void HttpTransportTest::dropsTheSessionOnlyOnUnauthenticated()
{
    QFETCH(QString, route);
    QFETCH(QString, method);
    QFETCH(QString, path);
    QFETCH(int, status);
    QFETCH(bool, html);
    QFETCH(QByteArray, body);
    QFETCH(bool, keeps);

    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({loginReply("sess-1"), html ? StubReply::html(status, body) : StubReply::json(status, body),
                  StubReply::json(200, kOkBody)});
    net::HttpTransport transport(stub.origin(), nullptr);

    transport.send(loginSpec());
    transport.send(make(route, method, path));
    transport.send(sessionSpec());

    QCOMPARE(stub.requests().size(), 3);
    QCOMPARE(stub.requests().at(1).header("cookie"), QByteArray("sid=sess-1"));  // non-vacuity
    QCOMPARE(stub.requests().at(2).hasHeader("cookie"), keeps);
}

// ---------------------------------------------------------------------------------------------
// ADR-009 / server/index.js:288-292: Origin and Referer both absent = passes the CSRF guard; a
// wrong Origin = 403 forbidden-origin on every state change. And no x-session-id: even with a
// sessionId in the login body, the cookie jar is the only carrier (decisions (6)).
void HttpTransportTest::sendsNoOriginRefererOrSessionHeader()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({loginReply("sid-h")});
    net::HttpTransport transport(stub.origin(), nullptr);

    transport.send(loginSpec());
    transport.send(sessionSpec());
    transport.send(make(QStringLiteral("articles-unlock"), QStringLiteral("POST"),
                        QStringLiteral("/api/articles/AKR1/unlock")));
    transport.send(withBody(make(QStringLiteral("articles-update"), QStringLiteral("PUT"),
                                 QStringLiteral("/api/articles/AKR1")),
                            QJsonObject{{QStringLiteral("title"), QStringLiteral("t")}}));
    transport.send(make(QStringLiteral("receiver-config-delete"), QStringLiteral("DELETE"),
                        QStringLiteral("/api/receiver-config/7")));

    QCOMPARE(stub.requests().size(), 5);
    for (const StubRequest &request : stub.requests()) {
        const QByteArray label = request.method + ' ' + request.target;
        QVERIFY2(request.hasHeader("host"), label.constData());  // non-vacuity: headers were recorded
        QVERIFY2(!request.hasHeader("origin"), label.constData());
        QVERIFY2(!request.hasHeader("referer"), label.constData());
        QVERIFY2(!request.hasHeader("x-session-id"), label.constData());
    }
}

void HttpTransportTest::attachesTheEditClientOnlyOnItsThreeRoutes_data()
{
    QTest::addColumn<QString>("route");
    QTest::addColumn<QString>("method");
    QTest::addColumn<QString>("path");
    QTest::addColumn<bool>("supplyId");
    QTest::addColumn<bool>("expectHeader");

    QTest::newRow("articles-lock carries it") << "articles-lock" << "POST" << "/api/articles/AKR1/lock" << true
                                              << true;
    QTest::newRow("articles-unlock carries it") << "articles-unlock" << "POST" << "/api/articles/AKR1/unlock"
                                                << true << true;
    QTest::newRow("articles-update carries it") << "articles-update" << "PUT" << "/api/articles/AKR1" << true
                                                << true;
    QTest::newRow("articles-lock without an id -> none") << "articles-lock" << "POST"
                                                         << "/api/articles/AKR1/lock" << false << false;
    // The one route the canonical request() COULD tag (saveArticle POST) - never by route here.
    QTest::newRow("articles-create with an id -> none") << "articles-create" << "POST" << "/api/articles"
                                                        << true << false;
    QTest::newRow("articles-force-unlock with an id -> none")
        << "articles-force-unlock" << "POST" << "/api/articles/AKR1/force-unlock" << true << false;
    QTest::newRow("articles-action with an id -> none") << "articles-action" << "POST"
                                                        << "/api/articles/AKR1/action" << true << false;
    QTest::newRow("articles-get with an id -> none") << "articles-get" << "GET" << "/api/articles/AKR1" << true
                                                     << false;
    QTest::newRow("login with an id -> none") << "login" << "POST" << "/api/login" << true << false;
    QTest::newRow("session with an id -> none") << "session" << "GET" << "/api/session" << true << false;
    QTest::newRow("users-update with an id -> none") << "users-update" << "PUT" << "/api/users/kim" << true
                                                     << false;
    QTest::newRow("health with an id -> none") << "health" << "GET" << "/api/health" << true << false;
    QTest::newRow("upper-cased route id -> none") << "ARTICLES-LOCK" << "POST" << "/api/articles/AKR1/lock"
                                                  << true << false;
    QTest::newRow("empty route id -> none") << "" << "POST" << "/api/articles/AKR1/lock" << true << false;
}

// decisions (3): the header rides on exactly three routes, enforced by ROUTE in the transport -
// a value supplied anywhere else is dropped (the web keeps the same traffic by caller data flow).
void HttpTransportTest::attachesTheEditClientOnlyOnItsThreeRoutes()
{
    QFETCH(QString, route);
    QFETCH(QString, method);
    QFETCH(QString, path);
    QFETCH(bool, supplyId);
    QFETCH(bool, expectHeader);

    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);
    const net::EditClientId surface;

    net::RequestSpec spec = make(route, method, path);
    if (method != QLatin1String("GET"))
        spec.body = QJsonObject();
    spec.editClientId = supplyId ? surface.value() : QString();
    transport.send(spec);

    QCOMPARE(stub.requests().size(), 1);
    const StubRequest &request = stub.requests().first();
    if (expectHeader) {
        QCOMPARE(request.header("x-edit-client"), surface.value().toUtf8());
        QCOMPARE(request.headerCount("x-edit-client"), 1);
    } else {
        QVERIFY2(!request.hasHeader("x-edit-client"), request.header("x-edit-client").constData());
    }
}

// ---------------------------------------------------------------------------------------------
void HttpTransportTest::sendsNeitherBodyNorContentTypeWithoutABody_data()
{
    QTest::addColumn<QString>("route");
    QTest::addColumn<QString>("method");
    QTest::addColumn<QString>("path");

    // The canonical's bodyless calls (httpModel.js:133, 252, 255, 284, 301 + GET/DELETE).
    QTest::newRow("unlockArticle") << "articles-unlock" << "POST" << "/api/articles/AKR1/unlock";
    QTest::newRow("forceUnlockArticle") << "articles-force-unlock" << "POST" << "/api/articles/AKR1/force-unlock";
    QTest::newRow("runDistributionTick") << "distribution-tick" << "POST" << "/api/distribution/tick";
    QTest::newRow("deactivateDistributionTarget") << "distribution-targets-deactivate" << "POST"
                                                  << "/api/distribution-targets/3/deactivate";
    QTest::newRow("logout") << "logout" << "POST" << "/api/logout";
    QTest::newRow("deleteReceiverConfig") << "receiver-config-delete" << "DELETE" << "/api/receiver-config/7";
    QTest::newRow("restoreSession (GET)") << "session" << "GET" << "/api/session";
}

// step7.md 본문 2축, first axis: body == nullopt -> no Content-Type, no body bytes.
void HttpTransportTest::sendsNeitherBodyNorContentTypeWithoutABody()
{
    QFETCH(QString, route);
    QFETCH(QString, method);
    QFETCH(QString, path);

    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);

    const net::RequestSpec spec = make(route, method, path);
    QVERIFY(!spec.body.has_value());
    transport.send(spec);

    QCOMPARE(stub.requests().size(), 1);
    const StubRequest &request = stub.requests().first();
    QCOMPARE(request.method, method.toLatin1());
    QVERIFY2(!request.hasHeader("content-type"), request.header("content-type").constData());
    QVERIFY(request.body.isEmpty());
    if (request.hasHeader("content-length"))
        QCOMPARE(request.header("content-length"), QByteArray("0"));
    QVERIFY(!request.hasHeader("transfer-encoding"));
    qInfo("%s %s: content-length %s", request.method.constData(), request.target.constData(),
          request.hasHeader("content-length") ? request.header("content-length").constData() : "absent");
}

// The second axis: lockArticle without an action sends the literal {} (httpModel.js:247-249) -
// Content-Type included. The canonical suite never checks this case.
void HttpTransportTest::sendsAnEmptyObjectWhenTheBodyIsEmpty()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);

    transport.send(lockSpec());

    QCOMPARE(stub.requests().size(), 1);
    const StubRequest &request = stub.requests().first();
    QCOMPARE(request.header("content-type"), QByteArray("application/json"));
    QCOMPARE(request.body, QByteArray("{}"));
    QCOMPARE(request.header("content-length"), QByteArray("2"));
}

void HttpTransportTest::sendsTheJsonBody()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);

    transport.send(withBody(make(QStringLiteral("articles-lock"), QStringLiteral("POST"),
                                 QStringLiteral("/api/articles/AKR1/lock")),
                            QJsonObject{{QStringLiteral("action"), QStringLiteral("portalRevise")}}));
    transport.send(withBody(make(QStringLiteral("articles-update"), QStringLiteral("PUT"),
                                 QStringLiteral("/api/articles/AKR1")),
                            QJsonObject{{QStringLiteral("title"), QStringLiteral("제목 \"따옴표\"")}}));

    QCOMPARE(stub.requests().size(), 2);
    QCOMPARE(stub.requests().at(0).header("content-type"), QByteArray("application/json"));
    QCOMPARE(QJsonDocument::fromJson(stub.requests().at(0).body).object(),
             (QJsonObject{{QStringLiteral("action"), QStringLiteral("portalRevise")}}));
    QCOMPARE(QJsonDocument::fromJson(stub.requests().at(1).body).object(),
             (QJsonObject{{QStringLiteral("title"), QStringLiteral("제목 \"따옴표\"")}}));
}

// ---------------------------------------------------------------------------------------------
// step7 AC: 401/403/404/409/423/429/500/503 each reach the caller as a distinct result - and
// each takes exactly one request (no retry of anything, R11).
void HttpTransportTest::deliversEachStatusAsADistinctOutcome()
{
    struct Row {
        net::RequestSpec spec;
        StubReply reply;
        QString expected;
    };
    const QString lockPath = QStringLiteral("/api/articles/AKR1/lock");
    const QList<Row> rows{
        {sessionSpec(), StubReply::json(401, R"json({"ok":false,"reason":"unauthenticated"})json"),
         QStringLiteral("Unauthenticated")},
        {loginSpec(), StubReply::json(401, R"json({"ok":false,"reason":"invalid-credentials"})json"),
         QStringLiteral("InvalidCredentials")},
        {lockSpec(lockPath), StubReply::json(401, R"json({"ok":false,"reason":"locked"})json"),
         QStringLiteral("EditLockConflict")},
        {make(QStringLiteral("articles-force-unlock"), QStringLiteral("POST"),
              QStringLiteral("/api/articles/AKR1/force-unlock")),
         StubReply::json(403, R"json({"ok":false,"reason":"forbidden"})json"), QStringLiteral("Forbidden")},
        {make(QStringLiteral("articles-get"), QStringLiteral("GET"), QStringLiteral("/api/articles/NOPE")),
         StubReply::json(404, R"json({"ok":false,"reason":"not-found"})json"), QStringLiteral("NotFound")},
        {withBody(make(QStringLiteral("articles-action"), QStringLiteral("POST"),
                       QStringLiteral("/api/articles/AKR1/action")),
                  QJsonObject{{QStringLiteral("action"), QStringLiteral("kill")}}),
         StubReply::json(409, R"json({"ok":false,"reason":"forbidden-transition"})json"),
         QStringLiteral("Conflict")},
        {loginSpec(), StubReply::json(423, R"json({"ok":false,"reason":"locked"})json"),
         QStringLiteral("AccountLocked")},
        {loginSpec(), rateLimitReply(), QStringLiteral("RateLimited")},
        {withBody(make(QStringLiteral("articles-create"), QStringLiteral("POST"), QStringLiteral("/api/articles")),
                  QJsonObject()),
         StubReply::json(500, R"json({"ok":false,"reason":"internal-error"})json"), QStringLiteral("ServerError")},
        {make(QStringLiteral("distribution-tick"), QStringLiteral("POST"), QStringLiteral("/api/distribution/tick")),
         StubReply::json(503, R"json({"ok":false,"reason":"spool-disabled"})json"), QStringLiteral("Unavailable")},
        {withBody(make(QStringLiteral("articles-action"), QStringLiteral("POST"),
                       QStringLiteral("/api/articles/AKR1/action")),
                  QJsonObject{{QStringLiteral("action"), QStringLiteral("nope")}}),
         StubReply::json(400, R"json({"ok":false,"reason":"unknown-action"})json"), QStringLiteral("BadRequest")},
        {sessionSpec(), StubReply::json(200, kOkBody), QStringLiteral("Ok")},
        {sessionSpec(), StubReply::html(502, "<html>bad gateway</html>"), QStringLiteral("InvalidResponse")},
    };

    StubHttpServer stub;
    QVERIFY(stub.listen());
    QList<StubReply> replies;
    for (const Row &row : rows)
        replies << row.reply;
    stub.inOrder(replies);
    net::HttpTransport transport(stub.origin(), nullptr);

    QSet<QString> seen;
    for (int i = 0; i < rows.size(); ++i) {
        const net::HttpResponse r = transport.send(rows.at(i).spec);
        QCOMPARE(name(r.outcome), rows.at(i).expected);
        QCOMPARE(r.status, rows.at(i).reply.status);
        QCOMPARE(stub.requests().size(), i + 1);  // exactly one attempt each
        seen.insert(name(r.outcome));
    }
    QCOMPARE(seen.size(), rows.size());
}

// The trap step7.md names: login's 429 is text/html with no token. Parsing first would drop it
// into the "broken response" bucket and the screen could not say "IP rate limit".
void HttpTransportTest::judgesATextHtml429AsRateLimited()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.always(rateLimitReply());
    net::HttpTransport transport(stub.origin(), nullptr);

    const net::HttpResponse r = transport.send(loginSpec());

    QCOMPARE(r.status, 429);
    QVERIFY(!r.jsonOk);
    QVERIFY(r.reason.isEmpty());
    QCOMPARE(r.body, QByteArray("Too many requests, please try again later."));
    QCOMPARE(name(r.outcome), QStringLiteral("RateLimited"));
    QCOMPARE(stub.requests().size(), 1);
}

// One token, two meanings: (login, 423, locked) = account lock · (articles-lock, 401, locked) =
// edit-lock conflict (server/index.js:330 - NOT the 409 the comment at 629 claims).
void HttpTransportTest::separatesTheTwoLockedTokens()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({StubReply::json(423, R"json({"ok":false,"reason":"locked"})json"),
                  StubReply::json(401, R"json({"ok":false,"reason":"locked"})json")});
    net::HttpTransport transport(stub.origin(), nullptr);

    const net::HttpResponse account = transport.send(loginSpec());
    const net::HttpResponse edit = transport.send(lockSpec());

    QCOMPARE(account.reason, QStringLiteral("locked"));
    QCOMPARE(edit.reason, QStringLiteral("locked"));
    QCOMPARE(name(account.outcome), QStringLiteral("AccountLocked"));
    QCOMPARE(name(edit.outcome), QStringLiteral("EditLockConflict"));
}

// ---------------------------------------------------------------------------------------------
void HttpTransportTest::putsTheQueryOnTheWire_data()
{
    QTest::addColumn<QString>("route");
    QTest::addColumn<QString>("path");
    QTest::addColumn<QVariantMap>("query");
    QTest::addColumn<QByteArray>("target");

    QTest::newRow("deskUnsent filter reaches the server as repeated keys")
        << "articles-list" << "/api/articles"
        << QVariantMap{{QStringLiteral("status"), QStringList{QStringLiteral("RDS"), QStringLiteral("DDH")}}}
        << QByteArray("/api/articles?status=RDS&status=DDH");
    QTest::newRow("canonical row 197-202")
        << "articles-list" << "/api/articles"
        << QVariantMap{{QStringLiteral("departments"), QStringList{QStringLiteral("정치"), QStringLiteral("경제")}},
                       {QStringLiteral("status"), QStringLiteral("DPS")}}
        << QByteArray("/api/articles?departments=%EC%A0%95%EC%B9%98&departments=%EA%B2%BD%EC%A0%9C&status=DPS");
    QTest::newRow("reserved characters are not decoded on the way out")
        << "articles-search" << "/api/articles/search"
        << QVariantMap{{QStringLiteral("q"), QStringLiteral("a+b&c=d e")}}
        << QByteArray("/api/articles/search?q=a%2Bb%26c%3Dd+e");
    // MEASURED DIVERGENCE (Qt 6.8.3, README): '~' is unreserved (RFC 3986 §2.3), and QUrl decodes
    // buildQuery's %7E back to '~' before it reaches the wire. It is the only character
    // URLSearchParams encodes that is unreserved, and a server decodes both spellings to '~'.
    QTest::newRow("DIVERGENCE: QUrl sends buildQuery's %7E as '~'")
        << "articles-search" << "/api/articles/search" << QVariantMap{{QStringLiteral("q"), QStringLiteral("~x")}}
        << QByteArray("/api/articles/search?q=~x");
    QTest::newRow("the reserved sub-delims stay encoded on the wire")
        << "articles-search" << "/api/articles/search"
        << QVariantMap{{QStringLiteral("q"), QStringLiteral("!'()*,;$@/?")}}
        << QByteArray("/api/articles/search?q=%21%27%28%29*%2C%3B%24%40%2F%3F");
    QTest::newRow("a null filter leaves no '?'")
        << "articles-list" << "/api/articles" << QVariantMap{{QStringLiteral("q"), QVariant()}}
        << QByteArray("/api/articles");
    QTest::newRow("an encoded path segment passes through")
        << "articles-get" << "/api/articles/AKR%201" << QVariantMap() << QByteArray("/api/articles/AKR%201");
}

void HttpTransportTest::putsTheQueryOnTheWire()
{
    QFETCH(QString, route);
    QFETCH(QString, path);
    QFETCH(QVariantMap, query);
    QFETCH(QByteArray, target);

    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);

    net::RequestSpec spec = make(route, QStringLiteral("GET"), path);
    spec.query = query;
    transport.send(spec);

    QCOMPARE(stub.requests().size(), 1);
    QCOMPARE(stub.requests().first().target, target);
}

// Redirect policy, set explicitly (step7.md - Qt's default is not trusted): an API call follows a
// redirect to the SAME origin only - the cookie and the body never leave the configured server.
void HttpTransportTest::followsOnlySameOriginRedirectsForApiCalls()
{
    StubHttpServer home;
    StubHttpServer elsewhere;
    QVERIFY(home.listen());
    QVERIFY(elsewhere.listen());
    const QByteArray elsewhereUrl = (elsewhere.origin() + QStringLiteral("/api/articles")).toUtf8();
    home.handle([&](const StubRequest &request) {
        if (request.target == "/api/login")
            return loginReply("sid-r");
        if (request.target == "/api/session")
            return StubReply::redirect("/api/session-moved");
        if (request.target == "/api/session-moved")
            return StubReply::json(200, kOkBody);
        if (request.target == "/api/articles")
            return StubReply::redirect(elsewhereUrl);
        return StubReply::json(404, R"json({"ok":false,"reason":"not-found"})json");
    });
    elsewhere.always(StubReply::json(200, kOkBody));
    net::HttpTransport transport(home.origin(), nullptr);

    transport.send(loginSpec());
    const net::HttpResponse same = transport.send(sessionSpec());
    const net::HttpResponse cross =
        transport.send(make(QStringLiteral("articles-list"), QStringLiteral("GET"), QStringLiteral("/api/articles")));
    qInfo("same-origin 302: outcome %s status %d final %s", qPrintable(name(same.outcome)), same.status,
          qPrintable(same.finalUrl));
    qInfo("cross-origin 302: outcome %s status %d final %s", qPrintable(name(cross.outcome)), cross.status,
          qPrintable(cross.finalUrl));

    // Same origin: followed, and the cookie rode along.
    QCOMPARE(name(same.outcome), QStringLiteral("Ok"));
    QCOMPARE(same.status, 200);
    QCOMPARE(same.finalUrl, home.origin() + QStringLiteral("/api/session-moved"));
    QCOMPARE(home.requests().size(), 4);
    QCOMPARE(home.requests().at(2).target, QByteArray("/api/session-moved"));
    QCOMPARE(home.requests().at(2).header("cookie"), QByteArray("sid=sid-r"));

    // Cross origin: not followed - the other server never saw a request. Measured on Qt 6.8.3:
    // the reply ends with the 302 itself (status 302, its text body, URL unchanged), which the
    // classification files as InvalidResponse.
    QVERIFY(elsewhere.requests().isEmpty());
    QCOMPARE(name(cross.outcome), QStringLiteral("InvalidResponse"));
    QCOMPARE(cross.status, 302);
    QCOMPARE(cross.finalUrl, home.origin() + QStringLiteral("/api/articles"));
}

// net-request{route,method,status,ms} per request, the route as its id - never the path (the
// diag redaction is fail-open on relative paths, so a path would keep its article id).
void HttpTransportTest::logsOneNetRequestLinePerRequest()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString diagPath = QDir(tmp.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);

    StubHttpServer stub;
    QVERIFY(stub.listen());
    StubReply silent;
    silent.hang = true;
    stub.inOrder({StubReply::json(401, R"json({"ok":false,"reason":"locked"})json"),
                  StubReply::json(200, R"json({"ok":true,"items":[]})json"), silent});
    net::HttpTransport transport(stub.origin(), &diag);

    transport.send(lockSpec(QStringLiteral("/api/articles/AKR-SECRET-42/lock")));
    net::RequestSpec search =
        make(QStringLiteral("articles-search"), QStringLiteral("GET"), QStringLiteral("/api/articles/search"));
    search.query = QVariantMap{{QStringLiteral("q"), QStringLiteral("secret headline")}};
    transport.send(search);
    net::RequestSpec hung = sessionSpec();
    hung.timeoutMs = 300;
    transport.send(hung);

    const QList<QJsonObject> events = readEvents(diagPath);
    QCOMPARE(events.size(), 3);
    const QSet<QString> expectedKeys{QStringLiteral("ts"),     QStringLiteral("event"), QStringLiteral("route"),
                                     QStringLiteral("method"), QStringLiteral("status"), QStringLiteral("ms")};
    for (const QJsonObject &event : events) {
        QCOMPARE(event.value(QStringLiteral("event")).toString(), QStringLiteral("net-request"));
        const QStringList keys = event.keys();
        QCOMPARE(QSet<QString>(keys.begin(), keys.end()), expectedKeys);
        QVERIFY(event.value(QStringLiteral("ms")).isDouble());
        QVERIFY(event.value(QStringLiteral("ms")).toDouble() >= 0);
    }
    QCOMPARE(events.at(0).value(QStringLiteral("route")).toString(), QStringLiteral("articles-lock"));
    QCOMPARE(events.at(0).value(QStringLiteral("method")).toString(), QStringLiteral("POST"));
    QCOMPARE(events.at(0).value(QStringLiteral("status")).toInt(), 401);
    QCOMPARE(events.at(1).value(QStringLiteral("route")).toString(), QStringLiteral("articles-search"));
    QCOMPARE(events.at(1).value(QStringLiteral("status")).toInt(), 200);
    QCOMPARE(events.at(2).value(QStringLiteral("route")).toString(), QStringLiteral("session"));
    QVERIFY2(events.at(2).value(QStringLiteral("status")).isNull(), "no HTTP response -> status null");

    QFile raw(diagPath);
    QVERIFY(raw.open(QIODevice::ReadOnly));
    const QByteArray bytes = raw.readAll();
    QVERIFY2(!bytes.contains("AKR-SECRET-42"), "a concrete article id reached the diag");
    QVERIFY2(!bytes.contains("secret"), "a query value reached the diag");
    QVERIFY2(!bytes.contains("/api/"), "a path reached the diag");
}
