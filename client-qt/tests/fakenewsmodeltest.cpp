#include "fakenewsmodeltest.h"

#include "repofiles.h"

#include "net/fakenewsmodel.h"
#include "net/newsmodel.h"

#include <QByteArray>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QPair>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QVariantMap>
#include <QtTest>

#include <functional>
#include <memory>
#include <type_traits>

using net::FakeNewsModel;
using net::FakeSeed;
using net::ModelResult;
using net::Outcome;

namespace {

// L21 and the canonical's "no delete key" (contract.test.js:57-58), as types: none of these
// members may exist on the interface or on the fake.
#define DEFINE_HAS_MEMBER(member)                                                                  \
    template <typename T, typename = void>                                                         \
    struct Has_##member : std::false_type {};                                                      \
    template <typename T>                                                                          \
    struct Has_##member<T, std::void_t<decltype(&T::member)>> : std::true_type {};
DEFINE_HAS_MEMBER(deleteUser)
DEFINE_HAS_MEMBER(removeUser)
DEFINE_HAS_MEMBER(deleteDistributionTarget)
DEFINE_HAS_MEMBER(deleteArticle)
static_assert(!Has_deleteUser<net::INewsModel>::value && !Has_deleteUser<FakeNewsModel>::value, "L21: no user deletion");
static_assert(!Has_removeUser<net::INewsModel>::value && !Has_removeUser<FakeNewsModel>::value, "L21: no user deletion");
static_assert(!Has_deleteDistributionTarget<net::INewsModel>::value, "deactivate is the only removal (ADR-008)");
static_assert(!Has_deleteArticle<net::INewsModel>::value, "no article deletion");
static_assert(!std::is_abstract_v<FakeNewsModel>, "all 35 methods implemented");

QByteArray compact(const QJsonObject &object)
{
    return QJsonDocument(object).toJson(QJsonDocument::Compact);
}

bool containsKeyDeep(const QJsonValue &value, const QString &key)
{
    if (value.isObject()) {
        const QJsonObject object = value.toObject();
        for (auto it = object.begin(); it != object.end(); ++it) {
            if (it.key() == key || containsKeyDeep(it.value(), key))
                return true;
        }
    } else if (value.isArray()) {
        for (const QJsonValue &element : value.toArray()) {
            if (containsKeyDeep(element, key))
                return true;
        }
    }
    return false;
}

QStringList sortedKeys(const QJsonObject &object)
{
    QStringList keys = object.keys();
    keys.sort();
    return keys;
}

QJsonObject user(const QString &id, const QString &password, const QString &role, const QString &active = QStringLiteral("Y"))
{
    return QJsonObject{{QStringLiteral("userId"), id},
                       {QStringLiteral("name"), id.toUpper()},
                       {QStringLiteral("password"), password},
                       {QStringLiteral("role"), role},
                       {QStringLiteral("department"), QStringLiteral("SOC")},
                       {QStringLiteral("departmentCode"), QStringLiteral("S1")},
                       {QStringLiteral("active"), active},
                       {QStringLiteral("failedLoginCount"), QStringLiteral("2")},
                       {QStringLiteral("lockedUntil"), QStringLiteral("0")},
                       {QStringLiteral("lastFailedLoginAt"), QStringLiteral("0")}};
}

FakeSeed seedWithKim()
{
    FakeSeed seed;
    seed.users << user(QStringLiteral("kim"), QStringLiteral("pw"), QStringLiteral("R"));
    return seed;
}

QJsonArray items(const ModelResult &r)
{
    return r.body.value(QStringLiteral("items")).toArray();
}

bool answered(const ModelResult &r)
{
    return r.body.value(QStringLiteral("ok")).isBool();
}

} // namespace

// ---------------------------------------------------------------------------------------------
// rule 1: the same seed and the same calls give the same bytes - stamps and ids included - and
// the stamps are the fake's counter clock, not the wall clock.
void FakeNewsModelTest::rule1_isDeterministic()
{
    const auto script = [](net::INewsModel &m) {
        QList<QByteArray> out;
        out << compact(m.login(QStringLiteral("kim"), QStringLiteral("pw")).body);
        out << compact(m.createDistributionTarget(QJsonObject{{QStringLiteral("name"), QStringLiteral("KBS")},
                                                              {QStringLiteral("kind"), QStringLiteral("press")},
                                                              {QStringLiteral("spoolDir"), QStringLiteral("kbs")}})
                           .body);
        out << compact(m.publishPhoto(QJsonObject{{QStringLiteral("src"), QStringLiteral("/x.png")}}).body);
        out << compact(m.saveArticle(QJsonObject{{QStringLiteral("title"), QStringLiteral("a")}}).body);
        out << compact(m.saveArticle(QJsonObject{{QStringLiteral("title"), QStringLiteral("b")}}).body);
        out << compact(m.createReceiverConfig(QJsonObject{{QStringLiteral("name"), QStringLiteral("F")}}).body);
        out << compact(m.runDistributionTick().body);
        out << compact(m.queryDistributionTargets().body);
        out << compact(m.searchPhotos(QString()).body);
        out << compact(m.queryArticles().body);
        out << compact(m.uploadFile(QStringLiteral("a.txt"), QByteArray("x")).body);
        return out;
    };

    FakeNewsModel first(seedWithKim());
    const QList<QByteArray> a = script(first);
    QTest::qWait(20);  // a wall-clock fake would drift across this pause
    FakeNewsModel second(seedWithKim());
    const QList<QByteArray> b = script(second);

    QCOMPARE(a.size(), 11);
    for (int i = 0; i < a.size(); ++i)
        QVERIFY2(a.at(i) == b.at(i), (a.at(i) + "  !=  " + b.at(i)).constData());

    // The clock and the id counter are the documented ones (fakenewsmodel.cpp), not wall time.
    FakeNewsModel clockModel;
    net::INewsModel &clock = clockModel;
    QVERIFY(clock.createDistributionTarget(QJsonObject{{QStringLiteral("name"), QStringLiteral("K")}}).ok());
    const QJsonObject row = items(clock.queryDistributionTargets()).at(0).toObject();
    QCOMPARE(row.value(QStringLiteral("createdAt")).toString(), QStringLiteral("2026-01-01T00:00:01.000Z"));
    FakeNewsModel idModel;
    net::INewsModel &ids = idModel;
    QCOMPARE(compact(ids.saveArticle(QJsonObject()).body),
             QByteArray(R"json({"articleId":"AKRFAKE000000001","ok":true})json"));
}

// rule 2: no network. The fake's sources name no network or socket type at all, and it is built
// without any address to reach.
void FakeNewsModelTest::rule2_touchesNoNetwork()
{
    const QStringList files{QStringLiteral("client-qt/src/net/fakenewsmodel.h"),
                            QStringLiteral("client-qt/src/net/fakenewsmodel.cpp")};
    const QStringList forbidden{QStringLiteral("QNetwork"),   QStringLiteral("QTcp"),       QStringLiteral("QUdp"),
                                QStringLiteral("QSslSocket"), QStringLiteral("QLocalSocket"), QStringLiteral("QHostAddress"),
                                QStringLiteral("QAbstractSocket"), QStringLiteral("HttpTransport"),
                                QStringLiteral("httptransport.h"), QStringLiteral("HttpNewsModel")};
    for (const QString &relative : files) {
        QByteArray bytes;
        QString error;
        QVERIFY2(readRepoFile(relative, &bytes, &error), qPrintable(error));
        QVERIFY2(bytes.size() > 200, qPrintable(relative));  // non-vacuity: the real source was read
        const QString text = QString::fromUtf8(bytes);
        for (const QString &token : forbidden)
            QVERIFY2(!text.contains(token), qPrintable(relative + QStringLiteral(" names ") + token));
    }
    static_assert(std::is_constructible_v<FakeNewsModel>, "built from nothing - no origin, no transport");
    static_assert(!std::is_constructible_v<FakeNewsModel, QString>, "no address to reach");
}

// rule 3: every MODEL_KEYS method answers - the assertModel of the port. The names are the
// interface's compiled list; the contract test ties that list to contract.js.
void FakeNewsModelTest::rule3_answersEveryModelKey()
{
    using Probe = std::function<bool(net::INewsModel &)>;
    const QList<QPair<QString, Probe>> probes{
        {QStringLiteral("login"), [](net::INewsModel &m) { return answered(m.login(QStringLiteral("kim"), QStringLiteral("pw"))); }},
        {QStringLiteral("logout"), [](net::INewsModel &m) { return answered(m.logout()); }},
        {QStringLiteral("restoreSession"), [](net::INewsModel &m) { return answered(m.restoreSession()); }},
        {QStringLiteral("queryUsers"), [](net::INewsModel &m) { return answered(m.queryUsers()); }},
        {QStringLiteral("createUser"), [](net::INewsModel &m) { return answered(m.createUser(QJsonObject())); }},
        {QStringLiteral("updateUser"), [](net::INewsModel &m) { return answered(m.updateUser(QStringLiteral("kim"), QJsonObject())); }},
        {QStringLiteral("queryArticles"), [](net::INewsModel &m) { return answered(m.queryArticles()); }},
        {QStringLiteral("getArticle"), [](net::INewsModel &m) { return answered(m.getArticle(QStringLiteral("AKR1"))); }},
        {QStringLiteral("searchArticles"), [](net::INewsModel &m) { return answered(m.searchArticles(QString())); }},
        {QStringLiteral("searchMedia"), [](net::INewsModel &m) { return answered(m.searchMedia(QString())); }},
        {QStringLiteral("publishPhoto"), [](net::INewsModel &m) { return answered(m.publishPhoto(QJsonObject())); }},
        {QStringLiteral("searchPhotos"), [](net::INewsModel &m) { return answered(m.searchPhotos(QString())); }},
        {QStringLiteral("applyAction"), [](net::INewsModel &m) { return answered(m.applyAction(QStringLiteral("AKR1"), QStringLiteral("send"))); }},
        {QStringLiteral("saveArticle"), [](net::INewsModel &m) { return answered(m.saveArticle(QJsonObject())); }},
        {QStringLiteral("lockArticle"), [](net::INewsModel &m) { return answered(m.lockArticle(QStringLiteral("AKR1"))); }},
        {QStringLiteral("unlockArticle"), [](net::INewsModel &m) { return answered(m.unlockArticle(QStringLiteral("AKR1"))); }},
        {QStringLiteral("forceUnlockArticle"), [](net::INewsModel &m) { return answered(m.forceUnlockArticle(QStringLiteral("AKR1"))); }},
        {QStringLiteral("queryReceiverConfig"), [](net::INewsModel &m) { return answered(m.queryReceiverConfig()); }},
        {QStringLiteral("createReceiverConfig"), [](net::INewsModel &m) { return answered(m.createReceiverConfig(QJsonObject())); }},
        {QStringLiteral("deleteReceiverConfig"), [](net::INewsModel &m) { return answered(m.deleteReceiverConfig(1)); }},
        {QStringLiteral("queryDistributionTargets"), [](net::INewsModel &m) { return answered(m.queryDistributionTargets()); }},
        {QStringLiteral("createDistributionTarget"), [](net::INewsModel &m) { return answered(m.createDistributionTarget(QJsonObject())); }},
        {QStringLiteral("updateDistributionTarget"), [](net::INewsModel &m) { return answered(m.updateDistributionTarget(1, QJsonObject())); }},
        {QStringLiteral("deactivateDistributionTarget"), [](net::INewsModel &m) { return answered(m.deactivateDistributionTarget(1)); }},
        {QStringLiteral("queryDistributionFailures"), [](net::INewsModel &m) { return answered(m.queryDistributionFailures()); }},
        {QStringLiteral("retryDistribution"), [](net::INewsModel &m) { return answered(m.retryDistribution(1)); }},
        {QStringLiteral("runDistributionTick"), [](net::INewsModel &m) { return answered(m.runDistributionTick()); }},
        {QStringLiteral("subscribe"),
         [](net::INewsModel &m) {
             const std::unique_ptr<net::Subscription> s = m.subscribe(QVariantMap(), [](const QJsonObject &, const QVariantMap &) {});
             return s != nullptr && s->connected();
         }},
        {QStringLiteral("queryHistory"), [](net::INewsModel &m) { return answered(m.queryHistory(QStringLiteral("AKR1"))); }},
        {QStringLiteral("deriveArticle"), [](net::INewsModel &m) { return answered(m.deriveArticle(QStringLiteral("AKR1"), QStringLiteral("continue"))); }},
        {QStringLiteral("translate"), [](net::INewsModel &m) { return answered(m.translate(QStringLiteral("AKR1"))); }},
        {QStringLiteral("uploadFile"), [](net::INewsModel &m) { return answered(m.uploadFile(QStringLiteral("a.png"), QByteArray("x"))); }},
        {QStringLiteral("getHistorySnapshot"), [](net::INewsModel &m) { return answered(m.getHistorySnapshot(QStringLiteral("AKR1"), 1)); }},
        {QStringLiteral("subscribeLogs"),
         [](net::INewsModel &m) {
             const std::unique_ptr<net::Subscription> s = m.subscribeLogs([](const QJsonObject &) {});
             return s != nullptr && s->connected();
         }},
        {QStringLiteral("getLogsDigest"), [](net::INewsModel &m) { return answered(m.getLogsDigest()); }},
    };

    QStringList names;
    for (const auto &probe : probes)
        names << probe.first;
    QCOMPARE(names, net::modelMethodNames());  // same 35, same order
    QCOMPARE(names.size(), 35);

    FakeNewsModel fakeModel(seedWithKim());
    net::INewsModel &fake = fakeModel;
    net::INewsModel &model = fake;
    for (const auto &probe : probes)
        QVERIFY2(probe.second(model), qPrintable(probe.first + QStringLiteral(" did not answer {ok:bool}")));
}

// rule 4: no user answer carries a password - nor the lockout fields (the server's SAFE_FIELDS
// allowlist is how the fake strips). Session and login shapes are the server's (5 and 6 keys).
void FakeNewsModelTest::rule4_neverAnswersAPassword()
{
    FakeSeed seed = seedWithKim();
    seed.users << user(QStringLiteral("lee"), QStringLiteral("secret"), QStringLiteral("Z"));
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;

    const QList<ModelResult> answers{
        fake.login(QStringLiteral("kim"), QStringLiteral("pw")),
        fake.restoreSession(),
        fake.queryUsers(),
        fake.createUser(QJsonObject{{QStringLiteral("userId"), QStringLiteral("park")},
                                    {QStringLiteral("password"), QStringLiteral("p4ss")},
                                    {QStringLiteral("role"), QStringLiteral("D")}}),
        fake.updateUser(QStringLiteral("lee"), QJsonObject{{QStringLiteral("password"), QStringLiteral("new")}}),
        fake.queryUsers(),
    };
    for (const ModelResult &r : answers) {
        QVERIFY2(r.ok(), compact(r.body).constData());
        for (const QString &key : {QStringLiteral("password"), QStringLiteral("failedLoginCount"),
                                   QStringLiteral("lockedUntil"), QStringLiteral("lastFailedLoginAt")})
            QVERIFY2(!containsKeyDeep(r.body, key), qPrintable(key + QStringLiteral(" in ") + QString::fromUtf8(compact(r.body))));
    }
    QCOMPARE(items(answers.at(5)).size(), 3);  // non-vacuity: the users are really there

    // GET /api/session: exactly 5 keys; POST /api/login: the 6 SAFE_FIELDS (endpoints.json notes).
    QCOMPARE(sortedKeys(answers.at(1).body.value(QStringLiteral("user")).toObject()),
             (QStringList{QStringLiteral("department"), QStringLiteral("departmentCode"), QStringLiteral("name"),
                          QStringLiteral("role"), QStringLiteral("userId")}));
    QCOMPARE(sortedKeys(answers.at(0).body.value(QStringLiteral("user")).toObject()),
             (QStringList{QStringLiteral("active"), QStringLiteral("department"), QStringLiteral("departmentCode"),
                          QStringLiteral("name"), QStringLiteral("role"), QStringLiteral("userId")}));
    // The password still works - it was stored, only never echoed.
    FakeNewsModel again(seed);
    QVERIFY(again.login(QStringLiteral("lee"), QStringLiteral("secret")).ok());
    QVERIFY(!again.login(QStringLiteral("lee"), QStringLiteral("wrong")).ok());
}

// rule 5: removal is soft. A target is deactivated (row kept, active 'N'); a user is removed by
// updateUser {active:'N'} (row kept); there is no delete member for either (static_asserts above).
// deleteReceiverConfig drops a SETTINGS row exactly as the server does - never an article.
void FakeNewsModelTest::rule5_removesNothingButDeactivates()
{
    FakeSeed seed = seedWithKim();
    seed.articles << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")}, {QStringLiteral("title"), QStringLiteral("t")}};
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;

    const qint64 a = fake.createDistributionTarget(QJsonObject{{QStringLiteral("name"), QStringLiteral("SBS")},
                                                               {QStringLiteral("kind"), QStringLiteral("press")},
                                                               {QStringLiteral("spoolDir"), QStringLiteral("sbs")}})
                         .body.value(QStringLiteral("id"))
                         .toInteger();
    fake.createDistributionTarget(QJsonObject{{QStringLiteral("name"), QStringLiteral("intra")},
                                              {QStringLiteral("kind"), QStringLiteral("nonpress")},
                                              {QStringLiteral("spoolDir"), QStringLiteral("intra")}});
    QCOMPARE(compact(fake.deactivateDistributionTarget(a).body), QByteArray(R"json({"changes":1,"ok":true})json"));
    const QJsonArray targets = items(fake.queryDistributionTargets());
    QCOMPARE(targets.size(), 2);  // nothing disappeared
    QCOMPARE(targets.at(0).toObject().value(QStringLiteral("active")).toString(), QStringLiteral("N"));
    QCOMPARE(targets.at(1).toObject().value(QStringLiteral("active")).toString(), QStringLiteral("Y"));
    QCOMPARE(fake.deactivateDistributionTarget(9999).reason(), QStringLiteral("not-found"));

    // users-update: 200 {ok, changes} (no not-found - endpoints.json notes), the row stays.
    QCOMPARE(compact(fake.updateUser(QStringLiteral("kim"), QJsonObject{{QStringLiteral("active"), QStringLiteral("N")}}).body),
             QByteArray(R"json({"changes":1,"ok":true})json"));
    QCOMPARE(compact(fake.updateUser(QStringLiteral("ghost"), QJsonObject{{QStringLiteral("active"), QStringLiteral("N")}}).body),
             QByteArray(R"json({"changes":0,"ok":true})json"));
    const QJsonArray users = items(fake.queryUsers());
    QCOMPARE(users.size(), 1);
    QCOMPARE(users.at(0).toObject().value(QStringLiteral("active")).toString(), QStringLiteral("N"));

    // The settings row only.
    const qint64 config = fake.createReceiverConfig(QJsonObject{{QStringLiteral("name"), QStringLiteral("F")}})
                              .body.value(QStringLiteral("id"))
                              .toInteger();
    QCOMPARE(items(fake.queryReceiverConfig()).size(), 1);
    QCOMPARE(compact(fake.deleteReceiverConfig(config).body), QByteArray(R"json({"changes":1,"ok":true})json"));
    QCOMPARE(compact(fake.deleteReceiverConfig(config).body), QByteArray(R"json({"changes":0,"ok":true})json"));
    QCOMPARE(items(fake.queryReceiverConfig()).size(), 0);
    QCOMPARE(items(fake.queryArticles()).size(), 1);

    QVERIFY(!Has_deleteUser<net::INewsModel>::value);
    QVERIFY(!Has_deleteDistributionTarget<net::INewsModel>::value);
}

// rule 6: the server keeps the text in markupVersion and drops a body key (ARTICLE_FIELDS pick) -
// so does the fake, on create and on update, or a "text sent as body" bug stays green here.
void FakeNewsModelTest::rule6_saveArticleDropsTheBodyKey()
{
    FakeNewsModel fakeModel;
    net::INewsModel &fake = fakeModel;
    const ModelResult created = fake.saveArticle(QJsonObject{{QStringLiteral("title"), QStringLiteral("t")},
                                                             {QStringLiteral("body"), QStringLiteral("text")},
                                                             {QStringLiteral("markupVersion"), QStringLiteral("m1")}});
    const QString id = created.body.value(QStringLiteral("articleId")).toString();
    QVERIFY(!id.isEmpty());
    const QJsonObject stored = fake.getArticle(id).body.value(QStringLiteral("article")).toObject();
    QVERIFY2(!stored.contains(QStringLiteral("body")), compact(stored).constData());
    QCOMPARE(stored.value(QStringLiteral("markupVersion")).toString(), QStringLiteral("m1"));
    QCOMPARE(stored.value(QStringLiteral("status")).toString(), QStringLiteral("RDS"));

    fake.saveArticle(QJsonObject{{QStringLiteral("articleId"), id},
                                 {QStringLiteral("body"), QStringLiteral("again")},
                                 {QStringLiteral("markupVersion"), QStringLiteral("m2")}});
    const QJsonObject updated = fake.getArticle(id).body.value(QStringLiteral("article")).toObject();
    QVERIFY2(!updated.contains(QStringLiteral("body")), compact(updated).constData());
    QCOMPARE(updated.value(QStringLiteral("markupVersion")).toString(), QStringLiteral("m2"));
    QVERIFY(!containsKeyDeep(fake.queryArticles().body, QStringLiteral("body")));
}

// L131: lockerSessionId / lockerClientId are in no answer - not even when a seeded row carries
// them - while the lock itself still behaves (the holder is kept apart from the rows).
void FakeNewsModelTest::neverExposesTheLockHolder()
{
    FakeSeed seed;
    seed.articles << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")},
                                 {QStringLiteral("title"), QStringLiteral("held")},
                                 {QStringLiteral("status"), QStringLiteral("RDS")},
                                 {QStringLiteral("lockYN"), QStringLiteral("Y")},
                                 {QStringLiteral("lockerUserId"), QStringLiteral("desk")},
                                 {QStringLiteral("lockerSessionId"), QStringLiteral("live-session-token")},
                                 {QStringLiteral("lockerClientId"), QStringLiteral("c-holder")}};
    seed.articles << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR2")}, {QStringLiteral("title"), QStringLiteral("free")}};
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;

    const auto noLocker = [](const ModelResult &r) {
        return !containsKeyDeep(r.body, QStringLiteral("lockerSessionId")) && !containsKeyDeep(r.body, QStringLiteral("lockerClientId"));
    };
    QVERIFY(noLocker(fake.queryArticles()));
    QVERIFY(noLocker(fake.getArticle(QStringLiteral("AKR1"))));
    QVERIFY(noLocker(fake.searchArticles(QStringLiteral("held"))));
    QCOMPARE(items(fake.searchArticles(QStringLiteral("held"))).size(), 1);  // non-vacuity
    const QJsonObject row = fake.getArticle(QStringLiteral("AKR1")).body.value(QStringLiteral("article")).toObject();
    QCOMPARE(row.value(QStringLiteral("lockYN")).toString(), QStringLiteral("Y"));        // the UI contract stays
    QCOMPARE(row.value(QStringLiteral("lockerUserId")).toString(), QStringLiteral("desk"));

    // The seeded holder still holds: another surface is refused, the holder is not.
    QCOMPARE(fake.lockArticle(QStringLiteral("AKR1"), QString(), QStringLiteral("c-other")).reason(), QStringLiteral("locked"));
    QCOMPARE(fake.lockArticle(QStringLiteral("AKR1"), QString(), QStringLiteral("c-other")).outcome, Outcome::EditLockConflict);
    QCOMPARE(fake.saveArticle(QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")}}, QStringLiteral("c-other")).reason(),
             QStringLiteral("not-holder"));
    QCOMPARE(fake.unlockArticle(QStringLiteral("AKR1"), QStringLiteral("c-other")).reason(), QStringLiteral("not-holder"));
    QVERIFY(fake.lockArticle(QStringLiteral("AKR1"), QString(), QStringLiteral("c-holder")).ok());
    QVERIFY(fake.unlockArticle(QStringLiteral("AKR1"), QStringLiteral("c-holder")).ok());
    QVERIFY(fake.lockArticle(QStringLiteral("AKR1"), QString(), QStringLiteral("c-other")).ok());
    QVERIFY(fake.forceUnlockArticle(QStringLiteral("AKR1")).ok());
    QVERIFY(noLocker(fake.getArticle(QStringLiteral("AKR1"))));
    QVERIFY(noLocker(fake.queryArticles()));
}

// L123-128 / ADR-004: the session holds an id, never an identity snapshot. A role change shows
// at once; a deactivated user's session is dropped and stays dropped.
void FakeNewsModelTest::rederivesTheSessionIdentityOnEveryCall()
{
    FakeNewsModel fakeModel(seedWithKim());
    net::INewsModel &fake = fakeModel;
    QVERIFY(fake.login(QStringLiteral("kim"), QStringLiteral("pw")).ok());
    QCOMPARE(fake.restoreSession().body.value(QStringLiteral("user")).toObject().value(QStringLiteral("role")).toString(),
             QStringLiteral("R"));

    fake.updateUser(QStringLiteral("kim"), QJsonObject{{QStringLiteral("role"), QStringLiteral("D")}});
    QCOMPARE(fake.restoreSession().body.value(QStringLiteral("user")).toObject().value(QStringLiteral("role")).toString(),
             QStringLiteral("D"));

    fake.updateUser(QStringLiteral("kim"), QJsonObject{{QStringLiteral("active"), QStringLiteral("N")}});
    const ModelResult gone = fake.restoreSession();
    QCOMPARE(gone.reason(), QStringLiteral("unauthenticated"));
    QCOMPARE(gone.outcome, Outcome::Unauthenticated);
    fake.updateUser(QStringLiteral("kim"), QJsonObject{{QStringLiteral("active"), QStringLiteral("Y")}});
    QCOMPARE(fake.restoreSession().reason(), QStringLiteral("unauthenticated"));  // not resurrected

    // An inactive account cannot log in (server: 403 inactive, checked before the password).
    fake.updateUser(QStringLiteral("kim"), QJsonObject{{QStringLiteral("active"), QStringLiteral("N")}});
    const ModelResult refused = fake.login(QStringLiteral("kim"), QStringLiteral("pw"));
    QCOMPARE(refused.reason(), QStringLiteral("inactive"));
    QCOMPARE(refused.status, 403);
    QCOMPARE(refused.outcome, Outcome::Forbidden);
}

// decisions (6): the fake answers login like HttpNewsModel does - no session id for any caller.
void FakeNewsModelTest::keepsTheSessionIdOutOfTheLoginResult()
{
    FakeNewsModel fakeModel(seedWithKim());
    net::INewsModel &fake = fakeModel;
    const ModelResult r = fake.login(QStringLiteral("kim"), QStringLiteral("pw"));
    QVERIFY(r.ok());
    QVERIFY2(!containsKeyDeep(r.body, QStringLiteral("sessionId")), compact(r.body).constData());
    QCOMPARE(r.status, 200);
    QCOMPARE(r.outcome, Outcome::Ok);
    const ModelResult wrong = fake.login(QStringLiteral("kim"), QStringLiteral("nope"));
    QCOMPARE(compact(wrong.body), QByteArray(R"json({"ok":false,"reason":"invalid-credentials"})json"));
    QCOMPARE(wrong.outcome, Outcome::InvalidCredentials);
    QCOMPARE(wrong.status, 401);
}

// --- canonical contract.test.js cases ----------------------------------------------------------
void FakeNewsModelTest::loginRestoreLogoutRoundTrip()
{
    FakeNewsModel fakeModel(seedWithKim());
    net::INewsModel &fake = fakeModel;
    QCOMPARE(fake.restoreSession().reason(), QStringLiteral("unauthenticated"));
    const ModelResult r = fake.login(QStringLiteral("kim"), QStringLiteral("pw"));
    QVERIFY(r.ok());
    QCOMPARE(r.body.value(QStringLiteral("user")).toObject().value(QStringLiteral("userId")).toString(), QStringLiteral("kim"));
    const ModelResult restored = fake.restoreSession();
    QVERIFY(restored.ok());
    QCOMPARE(restored.body.value(QStringLiteral("user")).toObject().value(QStringLiteral("userId")).toString(), QStringLiteral("kim"));
    QVERIFY(fake.logout().ok());
    QVERIFY(!fake.restoreSession().ok());
    QVERIFY(fake.logout().ok());  // logout is always 200 {ok:true} (endpoints.json)
}

void FakeNewsModelTest::saveArticleAssignsAnIdAndNotifies()
{
    FakeNewsModel fakeModel;
    net::INewsModel &fake = fakeModel;
    QList<QJsonObject> signals_;
    QStringList menus;
    const std::unique_ptr<net::Subscription> sub =
        fake.subscribe(QVariantMap{{QStringLiteral("menu"), QStringLiteral("desk")}},
                       [&signals_, &menus](const QJsonObject &signal, const QVariantMap &filter) {
                           menus << filter.value(QStringLiteral("menu")).toString();
                           signals_ << signal;
                       });
    const ModelResult r = fake.saveArticle(QJsonObject{{QStringLiteral("title"), QStringLiteral("new")}});
    QVERIFY(r.ok());
    QVERIFY(!r.body.value(QStringLiteral("articleId")).toString().isEmpty());
    QCOMPARE(signals_.size(), 1);
    QCOMPARE(menus, QStringList{QStringLiteral("desk")});  // the controller's own filter comes back
    QCOMPARE(compact(signals_.first()), QByteArray(R"json({"kind":"create"})json"));  // no row data (L80)
    fake.saveArticle(QJsonObject{{QStringLiteral("articleId"), r.body.value(QStringLiteral("articleId"))}});
    QCOMPARE(compact(signals_.last()), QByteArray(R"json({"kind":"update"})json"));
}

void FakeNewsModelTest::filtersArticlesByStatus()
{
    FakeSeed seed;
    for (const QString &status : {QStringLiteral("RDS"), QStringLiteral("DDH"), QStringLiteral("DPS")})
        seed.articles << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("A-") + status}, {QStringLiteral("status"), status}};
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;
    QCOMPARE(items(fake.queryArticles()).size(), 3);
    QCOMPARE(items(fake.queryArticles(QVariantMap{
                       {QStringLiteral("status"), QStringList{QStringLiteral("RDS"), QStringLiteral("DDH")}}}))
                 .size(),
             2);
    QCOMPARE(items(fake.queryArticles(QVariantMap{{QStringLiteral("status"), QStringLiteral("DPS")}})).size(), 1);
    QCOMPARE(items(fake.queryArticles(QVariantMap{{QStringLiteral("excludeStatus"), QStringLiteral("DPS")}})).size(), 2);
    QCOMPARE(items(fake.queryArticles(QVariantMap{{QStringLiteral("status"), QVariant()}})).size(), 3);  // null = no filter
    // (The canonical's "answers are copies" is structural here: QJsonObject/QJsonArray are values.)
}

void FakeNewsModelTest::queryHistoryIsLightAndLeavesTheSeed()
{
    FakeSeed seed;
    seed.histories.insert(QStringLiteral("AKR1"),
                          {QJsonObject{{QStringLiteral("id"), 2}, {QStringLiteral("action"), QStringLiteral("send")},
                                       {QStringLiteral("markupVersion"), QStringLiteral("blob")}},
                           QJsonObject{{QStringLiteral("id"), 1}, {QStringLiteral("action"), QJsonValue(QJsonValue::Null)},
                                       {QStringLiteral("markupVersion"), QStringLiteral("blob1")}}});
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;
    const QJsonArray all = items(fake.queryHistory(QStringLiteral("AKR1")));
    QCOMPARE(all.size(), 2);
    QVERIFY(!containsKeyDeep(all, QStringLiteral("markupVersion")));
    const QJsonArray sent = items(fake.queryHistory(QStringLiteral("AKR1"), true));
    QCOMPARE(sent.size(), 1);
    QCOMPARE(sent.at(0).toObject().value(QStringLiteral("action")).toString(), QStringLiteral("send"));
    QVERIFY(fake.queryHistory(QStringLiteral("NOPE")).ok());
    QVERIFY(items(fake.queryHistory(QStringLiteral("NOPE"))).isEmpty());
    // The blob is still there for the snapshot read (the list only hid it).
    QCOMPARE(fake.getHistorySnapshot(QStringLiteral("AKR1"), 2).body.value(QStringLiteral("item")).toObject()
                 .value(QStringLiteral("markupVersion")).toString(),
             QStringLiteral("blob"));
}

void FakeNewsModelTest::getHistorySnapshotReturnsACopy()
{
    FakeSeed seed;
    seed.histories.insert(QStringLiteral("AKR1"),
                          {QJsonObject{{QStringLiteral("id"), 2}, {QStringLiteral("markupVersion"), QStringLiteral("{}")}}});
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;
    ModelResult r = fake.getHistorySnapshot(QStringLiteral("AKR1"), 2);
    QVERIFY(r.ok());
    r.body.insert(QStringLiteral("item"), QJsonObject{{QStringLiteral("markupVersion"), QStringLiteral("tampered")}});
    QCOMPARE(fake.getHistorySnapshot(QStringLiteral("AKR1"), 2).body.value(QStringLiteral("item")).toObject()
                 .value(QStringLiteral("markupVersion")).toString(),
             QStringLiteral("{}"));
    QCOMPARE(compact(fake.getHistorySnapshot(QStringLiteral("AKR1"), 999).body),
             QByteArray(R"json({"ok":false,"reason":"not-found"})json"));
    QCOMPARE(fake.getHistorySnapshot(QStringLiteral("NOPE"), 2).outcome, Outcome::NotFound);
}

void FakeNewsModelTest::deriveArticleLeavesTheSource()
{
    FakeSeed seed;
    seed.articles << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")},
                                 {QStringLiteral("title"), QStringLiteral("원본")},
                                 {QStringLiteral("status"), QStringLiteral("DPS")}};
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;
    int changes = 0;
    const auto sub = fake.subscribe(QVariantMap(), [&changes](const QJsonObject &, const QVariantMap &) { ++changes; });
    const ModelResult r = fake.deriveArticle(QStringLiteral("AKR1"), QStringLiteral("continue"));
    QVERIFY(r.ok());
    QVERIFY(r.body.value(QStringLiteral("articleId")).toString() != QLatin1String("AKR1"));
    QCOMPARE(changes, 1);
    const QJsonObject source = fake.getArticle(QStringLiteral("AKR1")).body.value(QStringLiteral("article")).toObject();
    QCOMPARE(source.value(QStringLiteral("title")).toString(), QStringLiteral("원본"));
    QCOMPARE(source.value(QStringLiteral("status")).toString(), QStringLiteral("DPS"));
    QCOMPARE(fake.deriveArticle(QStringLiteral("NOPE"), QStringLiteral("continue")).reason(), QStringLiteral("not-found"));
}

void FakeNewsModelTest::publishPhotoStampsTheSessionUser()
{
    FakeNewsModel fakeModel(seedWithKim());
    net::INewsModel &fake = fakeModel;
    fake.login(QStringLiteral("kim"), QStringLiteral("pw"));
    const ModelResult r = fake.publishPhoto(QJsonObject{{QStringLiteral("src"), QStringLiteral("/uploads/a.png")},
                                                        {QStringLiteral("caption"), QStringLiteral("현장 사진")},
                                                        {QStringLiteral("registeredBy"), QStringLiteral("attacker")}});
    QVERIFY(r.ok());
    const QJsonArray found = items(fake.searchPhotos(QStringLiteral("현장")));
    QCOMPARE(found.size(), 1);
    QCOMPARE(found.at(0).toObject().value(QStringLiteral("registeredBy")).toString(), QStringLiteral("kim"));
    QVERIFY(!found.at(0).toObject().value(QStringLiteral("createdAt")).toString().isEmpty());
    QVERIFY(items(fake.searchPhotos(QStringLiteral("없는캡션"))).isEmpty());
}

void FakeNewsModelTest::translateFallsBackToTheTitle()
{
    FakeSeed seed;
    seed.translations.insert(QStringLiteral("AKR1"), QStringLiteral("번역문"));
    seed.articles << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR2")}, {QStringLiteral("title"), QStringLiteral("원문")}};
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;
    QCOMPARE(fake.translate(QStringLiteral("AKR1"), QStringLiteral("ko")).body.value(QStringLiteral("translatedText")).toString(),
             QStringLiteral("번역문"));
    QCOMPARE(fake.translate(QStringLiteral("AKR2")).body.value(QStringLiteral("translatedText")).toString(), QStringLiteral("원문"));
}

void FakeNewsModelTest::distributionTargetsRoundTrip()
{
    FakeNewsModel fakeModel;
    net::INewsModel &fake = fakeModel;
    const ModelResult created = fake.createDistributionTarget(QJsonObject{{QStringLiteral("id"), 999},
                                                                          {QStringLiteral("name"), QStringLiteral("KBS")},
                                                                          {QStringLiteral("kind"), QStringLiteral("press")},
                                                                          {QStringLiteral("spoolDir"), QStringLiteral("kbs")},
                                                                          {QStringLiteral("createdAt"), QStringLiteral("1999")}});
    const qint64 id = created.body.value(QStringLiteral("id")).toInteger();
    QVERIFY(id != 999);
    QJsonObject row = items(fake.queryDistributionTargets()).at(0).toObject();
    QCOMPARE(row.value(QStringLiteral("active")).toString(), QStringLiteral("Y"));
    QVERIFY(row.value(QStringLiteral("createdAt")).toString() != QLatin1String("1999"));

    QCOMPARE(compact(fake.updateDistributionTarget(id, QJsonObject{{QStringLiteral("name"), QStringLiteral("한국방송")},
                                                                   {QStringLiteral("id"), 42}})
                         .body),
             QByteArray(R"json({"changes":1,"ok":true})json"));
    row = items(fake.queryDistributionTargets()).at(0).toObject();
    QCOMPARE(row.value(QStringLiteral("name")).toString(), QStringLiteral("한국방송"));
    QCOMPARE(row.value(QStringLiteral("kind")).toString(), QStringLiteral("press"));
    QCOMPARE(row.value(QStringLiteral("id")).toInteger(), id);
    QCOMPARE(fake.updateDistributionTarget(9999, QJsonObject()).reason(), QStringLiteral("not-found"));

    fake.createDistributionTarget(QJsonObject{{QStringLiteral("name"), QStringLiteral("사내망")},
                                              {QStringLiteral("kind"), QStringLiteral("nonpress")},
                                              {QStringLiteral("spoolDir"), QStringLiteral("intra")}});
    fake.deactivateDistributionTarget(id);
    QCOMPARE(items(fake.queryDistributionTargets(QVariantMap{{QStringLiteral("active"), QStringLiteral("Y")}})).size(), 1);
    QCOMPARE(items(fake.queryDistributionTargets(QVariantMap{{QStringLiteral("kind"), QStringLiteral("press")}})).size(), 1);
    QCOMPARE(items(fake.queryDistributionTargets(QVariantMap{{QStringLiteral("nope"), QStringLiteral("zzz")}})).size(), 2);
}

void FakeNewsModelTest::distributionFailuresAndTick()
{
    FakeSeed seed;
    seed.distributionFailures << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")}, {QStringLiteral("targetId"), 3},
                                             {QStringLiteral("kind"), QStringLiteral("press")}, {QStringLiteral("historyId"), 11}};
    seed.distributionFailures << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR2")}, {QStringLiteral("targetId"), 4},
                                             {QStringLiteral("kind"), QStringLiteral("nonpress")}, {QStringLiteral("historyId"), 12}};
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;
    QCOMPARE(items(fake.queryDistributionFailures()).size(), 2);
    QCOMPARE(items(fake.queryDistributionFailures(QVariantMap{{QStringLiteral("limit"), 1}})).size(), 1);

    QCOMPARE(compact(fake.retryDistribution(999).body), QByteArray(R"json({"ok":false,"reason":"no-failure"})json"));
    QCOMPARE(fake.retryDistribution(999).outcome, Outcome::NotFound);
    const ModelResult retried = fake.retryDistribution(11);
    QVERIFY(retried.ok());
    QCOMPARE(retried.body.value(QStringLiteral("articleId")).toString(), QStringLiteral("AKR1"));
    QVERIFY(!retried.body.value(QStringLiteral("at")).toString().isEmpty());
    QCOMPARE(items(fake.queryDistributionFailures()).size(), 1);

    const QJsonObject tick = fake.runDistributionTick().body;
    QVERIFY(tick.value(QStringLiteral("ok")).toBool());
    QVERIFY(tick.value(QStringLiteral("scanned")).isDouble());
    QVERIFY(tick.value(QStringLiteral("distributed")).isArray());
    QVERIFY(tick.value(QStringLiteral("failed")).isArray());
    QVERIFY(tick.value(QStringLiteral("invalid")).isArray());
    FakeSeed seeded;
    seeded.tickResult = QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("scanned"), 2},
                                    {QStringLiteral("distributed"), QJsonArray{QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")}}}},
                                    {QStringLiteral("failed"), QJsonArray()}, {QStringLiteral("invalid"), QJsonArray()}};
    QCOMPARE(FakeNewsModel(seeded).runDistributionTick().body.value(QStringLiteral("scanned")).toInt(), 2);
}

// The handle is the subscription: unsubscribe() - or dropping it - stops the calls, twice is fine.
void FakeNewsModelTest::subscriptionsEndWithTheirHandle()
{
    FakeSeed seed;
    seed.articles << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")}};
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;
    int a = 0;
    int b = 0;
    QList<bool> statuses;
    std::unique_ptr<net::Subscription> first = fake.subscribe(
        QVariantMap(), [&a](const QJsonObject &, const QVariantMap &) { ++a; }, [&statuses](bool up) { statuses << up; });
    std::unique_ptr<net::Subscription> second =
        fake.subscribe(QVariantMap(), [&b](const QJsonObject &, const QVariantMap &) { ++b; });
    QCOMPARE(statuses, QList<bool>{true});  // the fake stream is up at once (canonical)
    QVERIFY(first->connected());

    fake.applyAction(QStringLiteral("AKR1"), QStringLiteral("send"));
    QCOMPARE(a, 1);
    QCOMPARE(b, 1);
    first->unsubscribe();
    first->unsubscribe();
    QVERIFY(!first->connected());
    second.reset();  // dropping the handle ends it too
    fake.applyAction(QStringLiteral("AKR1"), QStringLiteral("send"));
    QCOMPARE(a, 1);
    QCOMPARE(b, 1);

    // A handle that outlives the fake is still safe to end.
    std::unique_ptr<net::Subscription> orphan;
    {
        FakeNewsModel shortLivedModel;
        net::INewsModel &shortLived = shortLivedModel;
        orphan = shortLived.subscribe(QVariantMap(), [](const QJsonObject &, const QVariantMap &) {});
    }
    QVERIFY(orphan != nullptr);
    orphan->unsubscribe();
    QVERIFY(!orphan->connected());
    orphan.reset();
}

void FakeNewsModelTest::subscribeLogsReplaysTheSeed()
{
    FakeSeed seed;
    seed.logs << QJsonObject{{QStringLiteral("seq"), 1}, {QStringLiteral("message"), QStringLiteral("boot")}};
    seed.logs << QJsonObject{{QStringLiteral("seq"), 2}, {QStringLiteral("message"), QStringLiteral("next")}};
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;
    QList<qint64> seen;
    const auto sub = fake.subscribeLogs([&seen](const QJsonObject &record) { seen << record.value(QStringLiteral("seq")).toInteger(); });
    QCOMPARE(seen, (QList<qint64>{1, 2}));
    QVERIFY(sub->connected());
    QCOMPARE(items(fake.getLogsDigest()).size(), 2);
}

// step9: what the real stream does on the unauthorized frame - status down, then "session over",
// then silence - so a controller test on the fake sees the order it will see on the wire.
void FakeNewsModelTest::endsTheStreamSessionLikeTheServer()
{
    FakeSeed seed;
    seed.articles << QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")}};
    FakeNewsModel fakeModel(seed);
    net::INewsModel &fake = fakeModel;
    QStringList heard;
    std::unique_ptr<net::Subscription> sub = fake.subscribe(
        QVariantMap(), [&heard](const QJsonObject &, const QVariantMap &) { heard << QStringLiteral("change"); },
        [&heard](bool up) { heard << (up ? QStringLiteral("up") : QStringLiteral("down")); },
        [&heard] { heard << QStringLiteral("session-end"); });
    // The optional handlers are optional here too.
    const std::unique_ptr<net::Subscription> bare =
        fake.subscribe(QVariantMap(), [](const QJsonObject &, const QVariantMap &) {});

    fake.applyAction(QStringLiteral("AKR1"), QStringLiteral("send"));
    fakeModel.endStreamSession();
    QCOMPARE(heard, (QStringList{QStringLiteral("up"), QStringLiteral("change"), QStringLiteral("down"),
                                 QStringLiteral("session-end")}));
    QVERIFY(!sub->connected());
    QVERIFY(!bare->connected());

    fake.applyAction(QStringLiteral("AKR1"), QStringLiteral("send"));  // closed for good
    fakeModel.endStreamSession();                                       // nothing left to end
    QCOMPARE(heard.size(), 4);
    sub->unsubscribe();  // still safe after the stream ended itself
    QVERIFY(!sub->connected());
}
