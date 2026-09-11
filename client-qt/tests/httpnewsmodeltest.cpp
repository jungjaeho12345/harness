#include "httpnewsmodeltest.h"

#include "stubhttpserver.h"

#include "net/editclientid.h"
#include "net/httpnewsmodel.h"
#include "net/httptransport.h"
#include "net/newsmodel.h"
#include "net/routetable.h"
#include "shell/diag.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QRegularExpression>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QUrl>
#include <QUrlQuery>
#include <QVariantMap>
#include <QtTest>

#include <functional>
#include <optional>

using net::Outcome;

namespace {

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

QByteArray compact(const QJsonObject &object)
{
    return QJsonDocument(object).toJson(QJsonDocument::Compact);
}

// One canonical call: what httpModel.js sends for it (method, target, body, x-edit-client).
struct Call {
    QString name;                                             // the MODEL_KEYS method
    std::function<net::ModelResult(net::INewsModel &)> invoke;
    QString route;                                            // the endpoints.json id
    QByteArray method;
    QByteArray target;
    std::optional<QJsonObject> body;                          // nullopt = no Content-Type, no body
    bool editClient = false;
};

StubReply loginReply(const QByteArray &sid)
{
    StubReply reply = StubReply::json(
        200, R"json({"ok":true,"sessionId":")json" + sid +
                 R"json(","user":{"userId":"kim","name":"K","role":"R","department":"D","departmentCode":"DC","active":"Y"}})json");
    reply.headers.append({"Set-Cookie", sessionCookieLine(sid)});
    return reply;
}

} // namespace

// ---------------------------------------------------------------------------------------------
// The 33 REST methods (34 calls - saveArticle twice), each against its canonical call. The
// expectations are httpModel.js line by line; the route id is also checked against the table's
// consumer column, so the table and the wiring cannot drift apart.
void HttpNewsModelTest::eachMethodSendsTheRouteTheTableGivesIt()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString diagPath = QDir(tmp.path()).filePath(QStringLiteral("diag.jsonl"));
    shell::Diag diag(diagPath);
    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), &diag);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)
    const net::EditClientId surface;
    const QString cid = surface.value();

    const QList<Call> calls{
        {QStringLiteral("login"), [](net::INewsModel &m) { return m.login(QStringLiteral("kim"), QStringLiteral("pw")); },
         QStringLiteral("login"), "POST", "/api/login",
         QJsonObject{{QStringLiteral("userId"), QStringLiteral("kim")}, {QStringLiteral("password"), QStringLiteral("pw")}}},
        {QStringLiteral("logout"), [](net::INewsModel &m) { return m.logout(); }, QStringLiteral("logout"), "POST",
         "/api/logout", std::nullopt},
        {QStringLiteral("restoreSession"), [](net::INewsModel &m) { return m.restoreSession(); },
         QStringLiteral("session"), "GET", "/api/session", std::nullopt},
        {QStringLiteral("queryUsers"), [](net::INewsModel &m) { return m.queryUsers(); }, QStringLiteral("users-list"),
         "GET", "/api/users", std::nullopt},
        {QStringLiteral("createUser"),
         [](net::INewsModel &m) {
             return m.createUser(QJsonObject{{QStringLiteral("userId"), QStringLiteral("kim")},
                                             {QStringLiteral("password"), QStringLiteral("x")}});
         },
         QStringLiteral("users-create"), "POST", "/api/users",
         QJsonObject{{QStringLiteral("userId"), QStringLiteral("kim")}, {QStringLiteral("password"), QStringLiteral("x")}}},
        {QStringLiteral("updateUser"),
         [](net::INewsModel &m) {
             return m.updateUser(QStringLiteral("kim"), QJsonObject{{QStringLiteral("active"), QStringLiteral("N")}});
         },
         QStringLiteral("users-update"), "PUT", "/api/users/kim", QJsonObject{{QStringLiteral("active"), QStringLiteral("N")}}},
        {QStringLiteral("queryArticles"),
         [](net::INewsModel &m) {
             return m.queryArticles(
                 QVariantMap{{QStringLiteral("status"), QStringList{QStringLiteral("RDS"), QStringLiteral("DDH")}}});
         },
         QStringLiteral("articles-list"), "GET", "/api/articles?status=RDS&status=DDH", std::nullopt},
        {QStringLiteral("getArticle"), [](net::INewsModel &m) { return m.getArticle(QStringLiteral("AKR1")); },
         QStringLiteral("articles-get"), "GET", "/api/articles/AKR1", std::nullopt},
        {QStringLiteral("searchArticles"), [](net::INewsModel &m) { return m.searchArticles(QStringLiteral("a b")); },
         QStringLiteral("articles-search"), "GET", "/api/articles/search?q=a+b", std::nullopt},
        {QStringLiteral("searchMedia"),
         [](net::INewsModel &m) { return m.searchMedia(QStringLiteral("cat"), QStringLiteral("image")); },
         QStringLiteral("media-search"), "GET", "/api/media/search?q=cat&type=image", std::nullopt},
        {QStringLiteral("publishPhoto"),
         [](net::INewsModel &m) {
             return m.publishPhoto(QJsonObject{{QStringLiteral("src"), QStringLiteral("/uploads/a.png")},
                                               {QStringLiteral("caption"), QStringLiteral("c")}});
         },
         QStringLiteral("photos-create"), "POST", "/api/photos",
         QJsonObject{{QStringLiteral("src"), QStringLiteral("/uploads/a.png")}, {QStringLiteral("caption"), QStringLiteral("c")}}},
        {QStringLiteral("searchPhotos"), [](net::INewsModel &m) { return m.searchPhotos(QStringLiteral("토픽")); },
         QStringLiteral("photos-search"), "GET", "/api/photos/search?q=%ED%86%A0%ED%94%BD", std::nullopt},
        {QStringLiteral("applyAction"),
         [](net::INewsModel &m) { return m.applyAction(QStringLiteral("AKR1"), QStringLiteral("send")); },
         QStringLiteral("articles-action"), "POST", "/api/articles/AKR1/action",
         QJsonObject{{QStringLiteral("action"), QStringLiteral("send")}}},
        // create: the intent action rides in the body; the surface id is supplied but NOT sent.
        {QStringLiteral("saveArticle"),
         [cid](net::INewsModel &m) {
             return m.saveArticle(QJsonObject{{QStringLiteral("title"), QStringLiteral("new")}}, cid, QStringLiteral("hold"));
         },
         QStringLiteral("articles-create"), "POST", "/api/articles",
         QJsonObject{{QStringLiteral("title"), QStringLiteral("new")}, {QStringLiteral("action"), QStringLiteral("hold")}}},
        // update: the dto as it is (no action), with the surface id.
        {QStringLiteral("saveArticle"),
         [cid](net::INewsModel &m) {
             return m.saveArticle(QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")},
                                              {QStringLiteral("title"), QStringLiteral("edit")}},
                                  cid, QStringLiteral("send"));
         },
         QStringLiteral("articles-update"), "PUT", "/api/articles/AKR1",
         QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")}, {QStringLiteral("title"), QStringLiteral("edit")}},
         true},
        {QStringLiteral("lockArticle"),
         [cid](net::INewsModel &m) { return m.lockArticle(QStringLiteral("AKR1"), QString(), cid); },
         QStringLiteral("articles-lock"), "POST", "/api/articles/AKR1/lock", QJsonObject(), true},
        {QStringLiteral("unlockArticle"), [cid](net::INewsModel &m) { return m.unlockArticle(QStringLiteral("AKR1"), cid); },
         QStringLiteral("articles-unlock"), "POST", "/api/articles/AKR1/unlock", std::nullopt, true},
        {QStringLiteral("forceUnlockArticle"),
         [](net::INewsModel &m) { return m.forceUnlockArticle(QStringLiteral("AKR1")); },
         QStringLiteral("articles-force-unlock"), "POST", "/api/articles/AKR1/force-unlock", std::nullopt},
        {QStringLiteral("queryReceiverConfig"), [](net::INewsModel &m) { return m.queryReceiverConfig(); },
         QStringLiteral("receiver-config-list"), "GET", "/api/receiver-config", std::nullopt},
        {QStringLiteral("createReceiverConfig"),
         [](net::INewsModel &m) { return m.createReceiverConfig(QJsonObject{{QStringLiteral("name"), QStringLiteral("F")}}); },
         QStringLiteral("receiver-config-create"), "POST", "/api/receiver-config",
         QJsonObject{{QStringLiteral("name"), QStringLiteral("F")}}},
        {QStringLiteral("deleteReceiverConfig"), [](net::INewsModel &m) { return m.deleteReceiverConfig(7); },
         QStringLiteral("receiver-config-delete"), "DELETE", "/api/receiver-config/7", std::nullopt},
        {QStringLiteral("queryDistributionTargets"),
         [](net::INewsModel &m) {
             return m.queryDistributionTargets(QVariantMap{{QStringLiteral("active"), QStringLiteral("Y")}});
         },
         QStringLiteral("distribution-targets-list"), "GET", "/api/distribution-targets?active=Y", std::nullopt},
        {QStringLiteral("createDistributionTarget"),
         [](net::INewsModel &m) {
             return m.createDistributionTarget(QJsonObject{{QStringLiteral("name"), QStringLiteral("KBS")},
                                                           {QStringLiteral("kind"), QStringLiteral("press")},
                                                           {QStringLiteral("spoolDir"), QStringLiteral("kbs")}});
         },
         QStringLiteral("distribution-targets-create"), "POST", "/api/distribution-targets",
         QJsonObject{{QStringLiteral("name"), QStringLiteral("KBS")}, {QStringLiteral("kind"), QStringLiteral("press")},
                     {QStringLiteral("spoolDir"), QStringLiteral("kbs")}}},
        {QStringLiteral("updateDistributionTarget"),
         [](net::INewsModel &m) {
             return m.updateDistributionTarget(7, QJsonObject{{QStringLiteral("name"), QStringLiteral("x")}});
         },
         QStringLiteral("distribution-targets-update"), "PUT", "/api/distribution-targets/7",
         QJsonObject{{QStringLiteral("name"), QStringLiteral("x")}}},
        {QStringLiteral("deactivateDistributionTarget"), [](net::INewsModel &m) { return m.deactivateDistributionTarget(7); },
         QStringLiteral("distribution-targets-deactivate"), "POST", "/api/distribution-targets/7/deactivate", std::nullopt},
        {QStringLiteral("queryDistributionFailures"),
         [](net::INewsModel &m) { return m.queryDistributionFailures(QVariantMap{{QStringLiteral("limit"), 5}}); },
         QStringLiteral("distribution-failures"), "GET", "/api/distribution/failures?limit=5", std::nullopt},
        {QStringLiteral("retryDistribution"), [](net::INewsModel &m) { return m.retryDistribution(34); },
         QStringLiteral("distribution-retry"), "POST", "/api/distribution/retry",
         QJsonObject{{QStringLiteral("historyId"), 34}}},
        {QStringLiteral("runDistributionTick"), [](net::INewsModel &m) { return m.runDistributionTick(); },
         QStringLiteral("distribution-tick"), "POST", "/api/distribution/tick", std::nullopt},
        {QStringLiteral("queryHistory"), [](net::INewsModel &m) { return m.queryHistory(QStringLiteral("AKR1"), true); },
         QStringLiteral("articles-history"), "GET", "/api/articles/AKR1/history?sendOnly=1", std::nullopt},
        {QStringLiteral("deriveArticle"),
         [](net::INewsModel &m) { return m.deriveArticle(QStringLiteral("AKR1"), QStringLiteral("continue")); },
         QStringLiteral("articles-derive"), "POST", "/api/articles/AKR1/derive",
         QJsonObject{{QStringLiteral("mode"), QStringLiteral("continue")}}},
        {QStringLiteral("translate"), [](net::INewsModel &m) { return m.translate(QStringLiteral("AKR1"), QStringLiteral("en")); },
         QStringLiteral("articles-translate"), "POST", "/api/articles/AKR1/translate",
         QJsonObject{{QStringLiteral("targetLang"), QStringLiteral("en")}}},
        {QStringLiteral("uploadFile"),
         [](net::INewsModel &m) {
             return m.uploadFile(QStringLiteral("pic.png"), QByteArray("hello"), QStringLiteral("image/png"));
         },
         QStringLiteral("upload"), "POST", "/api/upload",
         QJsonObject{{QStringLiteral("filename"), QStringLiteral("pic.png")},
                     {QStringLiteral("contentBase64"), QStringLiteral("aGVsbG8=")}}},
        {QStringLiteral("getHistorySnapshot"),
         [](net::INewsModel &m) { return m.getHistorySnapshot(QStringLiteral("AKR1"), 7); },
         QStringLiteral("articles-history-snapshot"), "GET", "/api/articles/AKR1/history/7", std::nullopt},
        {QStringLiteral("getLogsDigest"), [](net::INewsModel &m) { return m.getLogsDigest(); },
         QStringLiteral("logs-digest"), "GET", "/api/logs/digest", std::nullopt},
    };

    QSet<QString> coveredMethods;
    QSet<QString> coveredRoutes;
    for (int i = 0; i < calls.size(); ++i) {
        const Call &call = calls.at(i);
        const QByteArray label = (call.name + QLatin1Char(' ') + call.route).toUtf8();
        const net::ModelResult result = call.invoke(model);
        QVERIFY2(stub.requests().size() == i + 1, label.constData());
        const StubRequest &request = stub.requests().last();
        QVERIFY2(request.method == call.method, label.constData());
        QVERIFY2(request.target == call.target, (label + " -> " + request.target).constData());
        if (call.body.has_value()) {
            QVERIFY2(request.header("content-type") == "application/json", label.constData());
            QVERIFY2(request.body == compact(*call.body), (label + " -> " + request.body).constData());
        } else {
            QVERIFY2(!request.hasHeader("content-type"), label.constData());
            QVERIFY2(request.body.isEmpty(), label.constData());
        }
        if (call.editClient)
            QVERIFY2(request.header("x-edit-client") == cid.toUtf8(), label.constData());
        else
            QVERIFY2(!request.hasHeader("x-edit-client"), label.constData());
        QVERIFY2(!request.hasHeader("x-session-id"), label.constData());
        QVERIFY2(result.outcome == Outcome::Ok && result.ok(), label.constData());

        const net::RouteSpec *row = net::findRoute(call.route);
        QVERIFY2(row != nullptr, label.constData());
        QVERIFY2(row->consumer == call.name, (label + " consumer " + row->consumer.toUtf8()).constData());
        coveredMethods.insert(call.name);
        coveredRoutes.insert(call.route);
    }

    // The diag route of every request is the expected id, in order.
    const QList<QJsonObject> events = readEvents(diagPath);
    QCOMPARE(events.size(), calls.size());
    for (int i = 0; i < calls.size(); ++i)
        QCOMPARE(events.at(i).value(QStringLiteral("route")).toString(), calls.at(i).route);

    // Coverage: every MODEL_KEYS method but the two streams, every table route but health and the streams.
    QSet<QString> restMethods(net::modelMethodNames().begin(), net::modelMethodNames().end());
    restMethods.remove(QStringLiteral("subscribe"));
    restMethods.remove(QStringLiteral("subscribeLogs"));
    QCOMPARE(restMethods.size(), 33);
    QCOMPARE(coveredMethods, restMethods);
    QSet<QString> restRoutes;
    for (const net::RouteSpec &row : net::routeTable()) {
        if (!row.sse && row.consumer != net::probeRunnerConsumer())
            restRoutes.insert(row.id);
    }
    QCOMPARE(restRoutes.size(), 34);
    QCOMPARE(coveredRoutes, restRoutes);
}

// The M8-7 wiring proof: queryArticles hands its filters to buildQuery (URLSearchParams rules).
// A comma-joined array, or QUrlQuery (which leaves '+' bare - the server reads a space), is red.
void HttpNewsModelTest::queryArticlesSpellsItsFiltersWithBuildQuery()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)

    // The step11 gate's filter (deskUnsent = {status:['RDS','DDH']}).
    model.queryArticles(QVariantMap{{QStringLiteral("status"), QStringList{QStringLiteral("RDS"), QStringLiteral("DDH")}}});
    // web/src/model/httpModel.test.js:197-202, in its own words.
    model.queryArticles(
        QVariantMap{{QStringLiteral("departments"), QStringList{QStringLiteral("정치"), QStringLiteral("경제")}},
                    {QStringLiteral("status"), QStringLiteral("DPS")}});
    model.queryArticles(QVariantMap{{QStringLiteral("author"), QStringLiteral("a+b c")}});
    model.queryArticles(QVariantMap{{QStringLiteral("status"), QVariant()}});
    model.queryArticles();

    QCOMPARE(stub.requests().size(), 5);
    QCOMPARE(stub.requests().at(0).target, QByteArray("/api/articles?status=RDS&status=DDH"));

    const QUrl canonical(QStringLiteral("http://x") + QString::fromUtf8(stub.requests().at(1).target));
    QCOMPARE(canonical.path(), QStringLiteral("/api/articles"));
    const QUrlQuery query(canonical);
    QCOMPARE(query.allQueryItemValues(QStringLiteral("departments"), QUrl::FullyDecoded),
             (QStringList{QStringLiteral("정치"), QStringLiteral("경제")}));
    QCOMPARE(query.allQueryItemValues(QStringLiteral("status")), QStringList{QStringLiteral("DPS")});

    QCOMPARE(stub.requests().at(2).target, QByteArray("/api/articles?author=a%2Bb+c"));
    QCOMPARE(stub.requests().at(3).target, QByteArray("/api/articles"));
    QCOMPARE(stub.requests().at(4).target, QByteArray("/api/articles"));
}

void HttpNewsModelTest::normalisesAnswersLikeTheCanonicalRequest_data()
{
    QTest::addColumn<int>("outcome");
    QTest::addColumn<int>("status");
    QTest::addColumn<bool>("jsonOk");
    QTest::addColumn<QByteArray>("json");
    QTest::addColumn<QByteArray>("expectedBody");

    // httpModel.js:105-108 - no answer: exactly {ok:false, reason:'network-error'} (no status, no message).
    QTest::newRow("refused") << int(Outcome::NetworkError) << -1 << false << QByteArray()
                             << QByteArray(R"json({"ok":false,"reason":"network-error"})json");
    QTest::newRow("deadline") << int(Outcome::Timeout) << -1 << false << QByteArray()
                              << QByteArray(R"json({"ok":false,"reason":"network-error"})json");
    // 114-117 - an answer that is not a JSON object.
    QTest::newRow("proxy page") << int(Outcome::InvalidResponse) << 502 << false << QByteArray()
                                << QByteArray(R"json({"ok":false,"reason":"invalid-response"})json");
    QTest::newRow("login 429 text/html") << int(Outcome::RateLimited) << 429 << false << QByteArray()
                                         << QByteArray(R"json({"ok":false,"reason":"invalid-response"})json");
    // 110-113 - a JSON object is returned untouched, whatever the status.
    QTest::newRow("200 JSON") << int(Outcome::Ok) << 200 << true << QByteArray(R"json({"ok":true,"items":[]})json")
                              << QByteArray(R"json({"items":[],"ok":true})json");
    QTest::newRow("403 JSON") << int(Outcome::Forbidden) << 403 << true
                              << QByteArray(R"json({"ok":false,"reason":"forbidden"})json")
                              << QByteArray(R"json({"ok":false,"reason":"forbidden"})json");
    QTest::newRow("429 with a JSON envelope keeps it") << int(Outcome::RateLimited) << 429 << true
                                                       << QByteArray(R"json({"ok":false,"reason":"slow"})json")
                                                       << QByteArray(R"json({"ok":false,"reason":"slow"})json");
}

void HttpNewsModelTest::normalisesAnswersLikeTheCanonicalRequest()
{
    QFETCH(int, outcome);
    QFETCH(int, status);
    QFETCH(bool, jsonOk);
    QFETCH(QByteArray, json);
    QFETCH(QByteArray, expectedBody);

    net::HttpResponse response;
    response.outcome = static_cast<Outcome>(outcome);
    response.status = status;
    response.jsonOk = jsonOk;
    if (jsonOk)
        response.json = QJsonDocument::fromJson(json).object();
    const net::ModelResult result = net::modelResultFrom(response);

    QCOMPARE(compact(result.body), expectedBody);
    QCOMPARE(int(result.outcome), outcome);
    QCOMPARE(result.status, status);
    QCOMPARE(result.ok(), result.body.value(QStringLiteral("ok")).toBool(false));
    QCOMPARE(result.reason(), result.body.value(QStringLiteral("reason")).toString());
    QCOMPARE(compact(net::notSentResult().body), QByteArray(R"json({"ok":false,"reason":"network-error"})json"));
    QCOMPARE(net::notSentResult().outcome, Outcome::NetworkError);
}

void HttpNewsModelTest::returnsAServerJsonAnswerUntouched()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({StubReply::json(200, R"json({"ok":true,"user":{"userId":"kim"}})json"),
                  StubReply::json(403, R"json({"ok":false,"reason":"forbidden"})json")});
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)

    const net::ModelResult session = model.restoreSession();
    QVERIFY(session.ok());
    QCOMPARE(session.status, 200);
    QCOMPARE(session.body.value(QStringLiteral("user")).toObject().value(QStringLiteral("userId")).toString(),
             QStringLiteral("kim"));
    const net::ModelResult denied = model.queryDistributionTargets();
    QVERIFY(!denied.ok());
    QCOMPARE(denied.reason(), QStringLiteral("forbidden"));
    QCOMPARE(denied.outcome, Outcome::Forbidden);
    QCOMPARE(denied.status, 403);
}

void HttpNewsModelTest::flagsANonJsonAnswerAsInvalidResponse()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.always(StubReply::html(502, "<html>bad gateway</html>"));
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)

    const net::ModelResult r = model.queryArticles();
    QCOMPARE(compact(r.body), QByteArray(R"json({"ok":false,"reason":"invalid-response"})json"));
    QCOMPARE(r.outcome, Outcome::InvalidResponse);
    QCOMPARE(r.status, 502);
}

// Login's 429 is express-rate-limit's text/html page: the canonical body is invalid-response, so
// only outcome tells a screen "IP rate limit" (step10 maps outcome, never the synthesised reason).
void HttpNewsModelTest::tellsARateLimitOnlyByOutcome()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({StubReply::html(429, "Too many requests, please try again later."),
                  StubReply::json(423, R"json({"ok":false,"reason":"locked"})json"),
                  StubReply::json(401, R"json({"ok":false,"reason":"invalid-credentials"})json")});
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)

    const net::ModelResult limited = model.login(QStringLiteral("kim"), QStringLiteral("pw"));
    QCOMPARE(limited.outcome, Outcome::RateLimited);
    QCOMPARE(limited.status, 429);
    QCOMPARE(limited.reason(), QStringLiteral("invalid-response"));
    const net::ModelResult locked = model.login(QStringLiteral("kim"), QStringLiteral("pw"));
    QCOMPARE(locked.outcome, Outcome::AccountLocked);
    QCOMPARE(locked.reason(), QStringLiteral("locked"));
    const net::ModelResult wrong = model.login(QStringLiteral("kim"), QStringLiteral("nope"));
    QCOMPARE(wrong.outcome, Outcome::InvalidCredentials);
}

// An id that would put the request on another route ("" -> /api/articles/, ".." -> dot segment)
// sends nothing and resolves like the canonical's fetch-throws path.
void HttpNewsModelTest::sendsNothingWhenThePathCannotBeBuilt()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)

    const net::ModelResult empty = model.getArticle(QString());
    const net::ModelResult dots = model.saveArticle(QJsonObject{{QStringLiteral("articleId"), QStringLiteral("..")}});
    const net::ModelResult unlock = model.unlockArticle(QStringLiteral("."), QStringLiteral("c-x"));

    QVERIFY(stub.requests().isEmpty());
    for (const net::ModelResult &r : {empty, dots, unlock}) {
        QCOMPARE(r.outcome, Outcome::NetworkError);
        QCOMPARE(compact(r.body), QByteArray(R"json({"ok":false,"reason":"network-error"})json"));
    }
    // Non-vacuity: a real id goes out.
    model.getArticle(QStringLiteral("AKR 1"));
    QCOMPARE(stub.requests().size(), 1);
    QCOMPARE(stub.requests().first().target, QByteArray("/api/articles/AKR%201"));
}

// decisions (6): the session lives in the cookie jar only. The server's body sessionId (kept for
// the web's header fallback) is not handed to any caller, and no x-session-id ever goes out.
void HttpNewsModelTest::keepsTheSessionIdOutOfTheLoginResult()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({loginReply("sid-model")});
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)

    const net::ModelResult r = model.login(QStringLiteral("kim"), QStringLiteral("pw"));
    QVERIFY(r.ok());
    QVERIFY2(!r.body.contains(QStringLiteral("sessionId")), qPrintable(QString::fromUtf8(compact(r.body))));
    QCOMPARE(r.body.value(QStringLiteral("user")).toObject().value(QStringLiteral("userId")).toString(),
             QStringLiteral("kim"));
    model.restoreSession();
    QCOMPARE(stub.requests().size(), 2);
    QCOMPARE(stub.requests().at(1).header("cookie"), QByteArray("sid=sid-model"));
    QVERIFY(!stub.requests().at(1).hasHeader("x-session-id"));
}

// httpModel.js:132-135 - logout forgets the local session whatever the answer (writeSessionId(null)
// runs after the request). Here: the jar is cleared even when the server fails or never answers.
void HttpNewsModelTest::forgetsTheSessionOnLogoutWhateverTheServerSays()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.inOrder({loginReply("sid-out"), StubReply::json(500, R"json({"ok":false,"reason":"internal-error"})json")});
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)

    model.login(QStringLiteral("kim"), QStringLiteral("pw"));
    const net::ModelResult out = model.logout();
    QCOMPARE(out.status, 500);
    model.restoreSession();

    QCOMPARE(stub.requests().size(), 3);
    QCOMPARE(stub.requests().at(1).header("cookie"), QByteArray("sid=sid-out"));  // non-vacuity
    QVERIFY2(!stub.requests().at(2).hasHeader("cookie"), "the session outlived logout");
}

// web/src/model/httpModel.test.js resolveUploadFilename block, plus the uploadFile wire of an
// extensionless clipboard image.
void HttpNewsModelTest::resolvesUploadFilenamesLikeTheCanonical()
{
    const qint64 now = 1700000000000;
    QCOMPARE(net::resolveUploadFilename(QStringLiteral("report.pdf"), QStringLiteral("application/pdf"), now),
             QStringLiteral("report.pdf"));
    QCOMPARE(net::resolveUploadFilename(QStringLiteral("photo.jpeg"), QStringLiteral("image/png"), now),
             QStringLiteral("photo.jpeg"));
    QCOMPARE(net::resolveUploadFilename(QString(), QStringLiteral("image/png"), now),
             QStringLiteral("pasted-1700000000000.png"));
    QCOMPARE(net::resolveUploadFilename(QString(), QStringLiteral("image/jpeg"), now),
             QStringLiteral("pasted-1700000000000.jpg"));
    QCOMPARE(net::resolveUploadFilename(QString(), QStringLiteral("image/gif"), now),
             QStringLiteral("pasted-1700000000000.gif"));
    QCOMPARE(net::resolveUploadFilename(QString(), QStringLiteral("image/webp"), now),
             QStringLiteral("pasted-1700000000000.webp"));
    QCOMPARE(net::resolveUploadFilename(QStringLiteral("image."), QStringLiteral("image/png"), now),
             QStringLiteral("pasted-1700000000000.png"));
    QCOMPARE(net::resolveUploadFilename(QString(), QStringLiteral("image/bmp"), now), QString());
    QCOMPARE(net::resolveUploadFilename(QString(), QStringLiteral("image/svg+xml"), now), QString());
    QCOMPARE(net::resolveUploadFilename(QString(), QString(), now), QString());

    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)
    model.uploadFile(QString(), QByteArray("hello"), QStringLiteral("image/png"));
    QCOMPARE(stub.requests().size(), 1);
    const QJsonObject body = QJsonDocument::fromJson(stub.requests().first().body).object();
    static const QRegularExpression pasted(QStringLiteral("^pasted-\\d+\\.png$"));
    QVERIFY2(pasted.match(body.value(QStringLiteral("filename")).toString()).hasMatch(),
             qPrintable(body.value(QStringLiteral("filename")).toString()));
    QCOMPARE(body.value(QStringLiteral("contentBase64")).toString(), QStringLiteral("aGVsbG8="));
}

// excluded (c): the log stream is Z-only and P7's. P4's model opens nothing for it.
void HttpNewsModelTest::neverOpensTheLogStreamInP4()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel httpModel(&transport);
    net::INewsModel &model = httpModel;  // callers hold the interface (its default arguments live there)

    int records = 0;
    std::unique_ptr<net::Subscription> logs = model.subscribeLogs([&records](const QJsonObject &) { ++records; });
    QVERIFY(logs != nullptr);
    QVERIFY(!logs->connected());
    logs->unsubscribe();
    logs->unsubscribe();  // idempotent
    QVERIFY(stub.requests().isEmpty());
    QCOMPARE(records, 0);
}
