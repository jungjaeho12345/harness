#include "netpolicytest.h"

#include "net/editclientid.h"
#include "net/httptransport.h"

#include <QRegularExpression>
#include <QSet>
#include <QString>
#include <QtTest>

#include <type_traits>

using net::Outcome;

// The surface identity must not be shareable by copy or move (ADR-018 ③).
static_assert(!std::is_copy_constructible_v<net::EditClientId>, "one id per surface - no copies");
static_assert(!std::is_copy_assignable_v<net::EditClientId>, "one id per surface - no copies");
static_assert(!std::is_move_constructible_v<net::EditClientId>, "one id per surface - no hand-over");

void NetPolicyTest::classifiesByRouteStatusAndToken_data()
{
    QTest::addColumn<QString>("route");
    QTest::addColumn<int>("status");
    QTest::addColumn<bool>("jsonOk");
    QTest::addColumn<QString>("reason");
    QTest::addColumn<QString>("expected");

    const QString none;
    // (2) the status decides before the body: login's 429 is text/html with no token
    // (contract/cases/auth-negative/login-negative.contract.js:108-111).
    QTest::newRow("login 429 text/html -> RateLimited (status first)")
        << "login" << 429 << false << none << "RateLimited";
    QTest::newRow("429 with a JSON envelope is still RateLimited")
        << "login" << 429 << true << "anything" << "RateLimited";
    QTest::newRow("429 on another route -> RateLimited") << "session" << 429 << false << none << "RateLimited";

    // (3) the triples that share a token.
    QTest::newRow("(login, 423, locked) -> AccountLocked") << "login" << 423 << true << "locked" << "AccountLocked";
    QTest::newRow("(articles-lock, 401, locked) -> EditLockConflict")
        << "articles-lock" << 401 << true << "locked" << "EditLockConflict";
    QTest::newRow("(login, 401, invalid-credentials) -> InvalidCredentials")
        << "login" << 401 << true << "invalid-credentials" << "InvalidCredentials";
    QTest::newRow("(session, 401, unauthenticated) -> Unauthenticated")
        << "session" << 401 << true << "unauthenticated" << "Unauthenticated";
    QTest::newRow("(articles-lock, 401, unauthenticated) -> Unauthenticated")
        << "articles-lock" << 401 << true << "unauthenticated" << "Unauthenticated";
    QTest::newRow("(articles-get, 401, unauthenticated) -> Unauthenticated")
        << "articles-get" << 401 << true << "unauthenticated" << "Unauthenticated";

    // (4) status buckets for a JSON answer.
    QTest::newRow("200 JSON -> Ok") << "session" << 200 << true << none << "Ok";
    QTest::newRow("201 JSON -> Ok") << "articles-create" << 201 << true << none << "Ok";
    QTest::newRow("200 JSON ok:false (graceful translate) is still Ok at this layer")
        << "articles-translate" << 200 << true << "no-key" << "Ok";
    QTest::newRow("400 -> BadRequest") << "articles-action" << 400 << true << "unknown-action" << "BadRequest";
    QTest::newRow("403 -> Forbidden") << "articles-force-unlock" << 403 << true << "forbidden" << "Forbidden";
    QTest::newRow("403 forbidden-origin -> Forbidden") << "logout" << 403 << true << "forbidden-origin"
                                                        << "Forbidden";
    QTest::newRow("404 -> NotFound") << "articles-get" << 404 << true << "not-found" << "NotFound";
    QTest::newRow("409 -> Conflict") << "articles-action" << 409 << true << "forbidden-transition" << "Conflict";
    QTest::newRow("500 -> ServerError") << "articles-create" << 500 << true << "internal-error" << "ServerError";
    QTest::newRow("503 -> Unavailable") << "distribution-tick" << 503 << true << "spool-disabled" << "Unavailable";
    QTest::newRow("418 JSON -> Unclassified") << "session" << 418 << true << "teapot" << "Unclassified";

    // (2') no envelope: a proxy page, a portal, an empty body - whatever the status.
    QTest::newRow("200 text/html (captive portal) -> InvalidResponse")
        << "session" << 200 << false << none << "InvalidResponse";
    QTest::newRow("401 text/html (proxy) -> InvalidResponse, not a lost session")
        << "session" << 401 << false << none << "InvalidResponse";
    QTest::newRow("502 text/html (gateway) -> InvalidResponse")
        << "articles-list" << 502 << false << none << "InvalidResponse";
    QTest::newRow("500 text/html -> InvalidResponse") << "articles-list" << 500 << false << none
                                                       << "InvalidResponse";
    QTest::newRow("302 not followed, text body -> InvalidResponse")
        << "session" << 302 << false << none << "InvalidResponse";
}

void NetPolicyTest::classifiesByRouteStatusAndToken()
{
    QFETCH(QString, route);
    QFETCH(int, status);
    QFETCH(bool, jsonOk);
    QFETCH(QString, reason);
    QFETCH(QString, expected);
    QCOMPARE(net::outcomeName(net::classifyResponse(route, status, jsonOk, reason)), expected);
}

// The token 'locked' means two different things (docs/api-contract/reason-tokens.md 표1 #8 · 표2 #1)
// and server/index.js:629 even calls the edit-lock status 409 while the code says 401. Only the
// two documented (route, status) pairs are named; the token on any other pair is not trusted.
void NetPolicyTest::neverReadsLockedFromTheTokenAlone()
{
    const QString locked = QStringLiteral("locked");
    QCOMPARE(net::classifyResponse(QStringLiteral("login"), 423, true, locked), Outcome::AccountLocked);
    QCOMPARE(net::classifyResponse(QStringLiteral("articles-lock"), 401, true, locked), Outcome::EditLockConflict);

    QCOMPARE(net::classifyResponse(QStringLiteral("articles-lock"), 423, true, locked), Outcome::Unclassified);
    QCOMPARE(net::classifyResponse(QStringLiteral("login"), 401, true, locked), Outcome::Unclassified);
    QCOMPARE(net::classifyResponse(QStringLiteral("articles-get"), 401, true, locked), Outcome::Unclassified);
    QCOMPARE(net::classifyResponse(QStringLiteral("articles-lock"), 409, true, locked), Outcome::Conflict);
    QCOMPARE(net::classifyResponse(QStringLiteral("session"), 401, true, QStringLiteral("invalid-credentials")),
             Outcome::Unclassified);
}

void NetPolicyTest::spellsEveryOutcomeDifferently()
{
    const QList<Outcome> all{Outcome::Ok,           Outcome::NetworkError,    Outcome::Timeout,
                             Outcome::RateLimited,  Outcome::AccountLocked,   Outcome::EditLockConflict,
                             Outcome::Unauthenticated, Outcome::InvalidCredentials, Outcome::BadRequest,
                             Outcome::Forbidden,    Outcome::NotFound,        Outcome::Conflict,
                             Outcome::ServerError,  Outcome::Unavailable,     Outcome::InvalidResponse,
                             Outcome::Unclassified};
    QSet<QString> names;
    for (Outcome outcome : all) {
        const QString name = net::outcomeName(outcome);
        QVERIFY2(!name.isEmpty() && name != QLatin1String("?"), qPrintable(name));
        names.insert(name);
    }
    QCOMPARE(names.size(), all.size());
}

// server/index.js reads x-edit-client at exactly 932 (PUT /api/articles/:id), 961 (lock) and
// 974 (unlock). The set is the transport's single constant (step8 C-6 compares its table to it).
void NetPolicyTest::namesExactlyThreeEditClientRoutes()
{
    QCOMPARE(net::editClientRouteIds(),
             (QSet<QString>{QStringLiteral("articles-lock"), QStringLiteral("articles-unlock"),
                            QStringLiteral("articles-update")}));
    QVERIFY(net::sendsEditClient(QStringLiteral("articles-update")));
    QVERIFY(!net::sendsEditClient(QStringLiteral("articles-create")));
    QVERIFY(!net::sendsEditClient(QStringLiteral("articles-force-unlock")));
    QVERIFY(!net::sendsEditClient(QStringLiteral("ARTICLES-LOCK")));
    QVERIFY(!net::sendsEditClient(QString()));
}

// "무한 대기 금지" (step7.md): a zero or negative timeout is not "no timeout", it is the default.
void NetPolicyTest::neverWaitsForever()
{
    QVERIFY(net::kDefaultTimeoutMs > 0);
    QCOMPARE(net::effectiveTimeoutMs(0), net::kDefaultTimeoutMs);
    QCOMPARE(net::effectiveTimeoutMs(-1), net::kDefaultTimeoutMs);
    QCOMPARE(net::effectiveTimeoutMs(250), 250);
    QCOMPARE(net::RequestSpec().timeoutMs, net::kDefaultTimeoutMs);
    QVERIFY2(!net::RequestSpec().body.has_value(), "a default request carries no body");
}

// web/src/controller/useWriteController.js:44-47: "c-" + crypto.randomUUID() (lowercase v4).
void NetPolicyTest::issuesEditClientIdsInTheCanonicalFormat()
{
    static const QRegularExpression format(
        QStringLiteral("^c-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"));
    QSet<QString> seen;
    for (int i = 0; i < 200; ++i) {
        const QString id = net::issueEditClientId();
        QVERIFY2(format.match(id).hasMatch(), qPrintable(id));
        seen.insert(id);
    }
    QCOMPARE(seen.size(), 200);
}

void NetPolicyTest::keepsOneIdPerSurface()
{
    const net::EditClientId first;
    const net::EditClientId second;
    QVERIFY(!first.value().isEmpty());
    QCOMPARE(first.value(), first.value());  // stable for the surface's life
    QVERIFY2(first.value() != second.value(), "two surfaces got the same lock identity");
}
