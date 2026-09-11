#include "routecontracttest.h"

#include "repofiles.h"

#include "net/httptransport.h"
#include "net/newsmodel.h"
#include "net/routetable.h"

#include <QByteArray>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QRegularExpression>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QVector>
#include <QtTest>

#include <algorithm>

using net::RouteSpec;

namespace {

const QString kEndpointsFile = QStringLiteral("docs/api-contract/endpoints.json");
const QString kModelContractFile = QStringLiteral("web/src/model/contract.js");

// --- the policies the plan fixes (step8.md A/C, decisions (3), excluded (i)) - not route lists ---
const QSet<QString> kForbidden{QStringLiteral("collection-receive"), QStringLiteral("collection-pull")};
const QSet<QString> kEditClient{QStringLiteral("articles-lock"), QStringLiteral("articles-unlock"),
                                QStringLiteral("articles-update")};
const QString kSaveArticle = QStringLiteral("saveArticle");
const QSet<QString> kSaveArticleRoutes{QStringLiteral("articles-create"), QStringLiteral("articles-update")};
const int kModelKeyCount = 35;  // web/src/model/contract.test.js:8

// --- loading ---------------------------------------------------------------------------------------
bool parseEndpoints(const QByteArray &bytes, QJsonArray *routes, QString *error)
{
    QJsonParseError parseError;
    const QJsonDocument doc = QJsonDocument::fromJson(bytes, &parseError);
    if (parseError.error != QJsonParseError::NoError || !doc.isObject()) {
        *error = QStringLiteral("endpoints.json is not a JSON object: ") + parseError.errorString();
        return false;
    }
    const QJsonValue value = doc.object().value(QStringLiteral("routes"));
    if (!value.isArray() || value.toArray().isEmpty()) {
        *error = QStringLiteral("endpoints.json has no non-empty routes array");
        return false;
    }
    *routes = value.toArray();
    return true;
}

bool loadEndpoints(QJsonArray *routes, QString *error)
{
    QByteArray bytes;
    return readRepoFile(kEndpointsFile, &bytes, error) && parseEndpoints(bytes, routes, error);
}

// MODEL_KEYS = Object.freeze([ ... ]); - one quoted name per line, '//' comment lines between.
// Strict on purpose: a line that is neither is an error, so a format change cannot be half-read.
QStringList parseModelKeys(const QByteArray &source, QString *error)
{
    const QString text = QString::fromUtf8(source);
    const QString marker = QStringLiteral("export const MODEL_KEYS = Object.freeze([");
    const qsizetype start = text.indexOf(marker);
    const qsizetype end = start < 0 ? -1 : text.indexOf(QStringLiteral("]);"), start);
    if (start < 0 || end < 0) {
        *error = QStringLiteral("MODEL_KEYS declaration not found in contract.js");
        return {};
    }
    static const QRegularExpression literal(QStringLiteral("^'([A-Za-z0-9_]+)',?$"));
    QStringList keys;
    const QString body = text.mid(start + marker.size(), end - start - marker.size());
    for (const QString &raw : body.split(QLatin1Char('\n'))) {
        const QString line = raw.trimmed();
        if (line.isEmpty() || line.startsWith(QStringLiteral("//")))
            continue;
        const QRegularExpressionMatch match = literal.match(line);
        if (!match.hasMatch()) {
            *error = QStringLiteral("unexpected line inside MODEL_KEYS: ") + line;
            return {};
        }
        keys << match.captured(1);
    }
    if (keys.isEmpty())
        *error = QStringLiteral("MODEL_KEYS parsed empty");
    return keys;
}

bool loadModelKeys(QStringList *keys, QString *error)
{
    QByteArray bytes;
    if (!readRepoFile(kModelContractFile, &bytes, error))
        return false;
    *keys = parseModelKeys(bytes, error);
    return !keys->isEmpty();
}

QHash<QString, QJsonObject> byId(const QJsonArray &contract)
{
    QHash<QString, QJsonObject> rows;
    for (const QJsonValue &value : contract) {
        const QJsonObject row = value.toObject();
        rows.insert(row.value(QStringLiteral("id")).toString(), row);
    }
    return rows;
}

QSet<QString> tableIds(const QVector<RouteSpec> &table)
{
    QSet<QString> ids;
    for (const RouteSpec &row : table)
        ids.insert(row.id);
    return ids;
}

QString sorted(const QSet<QString> &set)
{
    QStringList list(set.begin(), set.end());
    list.sort();
    return list.join(QStringLiteral(", "));
}

// --- the checks: pure, contract passed in as data (the drift test feeds doctored copies) ---------

// C-1: table ∪ forbidden = the contract's ids exactly (37 + 2 = 39), no duplicates, no overlap.
QStringList checkIdSet(const QJsonArray &contract, const QVector<RouteSpec> &table, const QSet<QString> &forbidden)
{
    QStringList problems;
    QSet<QString> contractIds;
    for (const QJsonValue &value : contract) {
        const QString id = value.toObject().value(QStringLiteral("id")).toString();
        if (id.isEmpty() || contractIds.contains(id))
            problems << QStringLiteral("contract id empty or duplicated: '%1'").arg(id);
        contractIds.insert(id);
    }
    const QSet<QString> ids = tableIds(table);
    if (ids.size() != table.size())
        problems << QStringLiteral("the table has duplicated ids");
    const QSet<QString> overlap = ids & forbidden;
    if (!overlap.isEmpty())
        problems << QStringLiteral("forbidden ids inside the table: ") + sorted(overlap);
    const QSet<QString> covered = ids | forbidden;
    const QSet<QString> missing = contractIds - covered;
    const QSet<QString> extra = covered - contractIds;
    if (!missing.isEmpty())
        problems << QStringLiteral("contract routes neither in the table nor forbidden: ") + sorted(missing);
    if (!extra.isEmpty())
        problems << QStringLiteral("table/forbidden ids the contract does not have: ") + sorted(extra);
    if (table.size() + forbidden.size() != contract.size())
        problems << QStringLiteral("table %1 + forbidden %2 != contract %3")
                        .arg(table.size())
                        .arg(forbidden.size())
                        .arg(contract.size());
    return problems;
}

// C-2: method and path, character for character.
QStringList checkMethodAndPath(const QJsonArray &contract, const QVector<RouteSpec> &table)
{
    QStringList problems;
    const QHash<QString, QJsonObject> rows = byId(contract);
    for (const RouteSpec &row : table) {
        if (!rows.contains(row.id)) {
            problems << QStringLiteral("%1: not in the contract").arg(row.id);
            continue;
        }
        const QJsonObject c = rows.value(row.id);
        const QString method = c.value(QStringLiteral("method")).toString();
        const QString path = c.value(QStringLiteral("path")).toString();
        if (row.method != method)
            problems << QStringLiteral("%1: method '%2' != contract '%3'").arg(row.id, row.method, method);
        if (row.pathTemplate != path)
            problems << QStringLiteral("%1: path '%2' != contract '%3'").arg(row.id, row.pathTemplate, path);
    }
    return problems;
}

// C-3: the auth class, verbatim (public / session / admin / session-role / lock-holder / token).
QStringList checkAuth(const QJsonArray &contract, const QVector<RouteSpec> &table)
{
    QStringList problems;
    const QHash<QString, QJsonObject> rows = byId(contract);
    for (const RouteSpec &row : table) {
        const QString auth = rows.value(row.id).value(QStringLiteral("auth")).toString();
        if (auth.isEmpty())
            problems << QStringLiteral("%1: the contract row has no auth").arg(row.id);
        else if (row.auth != auth)
            problems << QStringLiteral("%1: auth '%2' != contract '%3'").arg(row.id, row.auth, auth);
    }
    return problems;
}

// C-4: the forbidden pair is real (in the contract), absent from the table, unreachable through
// findRoute()/buildPath(), and covers every server-to-server token route.
QStringList checkForbidden(const QJsonArray &contract, const QVector<RouteSpec> &table, const QSet<QString> &forbidden)
{
    QStringList problems;
    const QHash<QString, QJsonObject> rows = byId(contract);
    if (forbidden != kForbidden)
        problems << QStringLiteral("forbiddenRouteIds() is {%1}, the plan fixes {%2}")
                        .arg(sorted(forbidden), sorted(kForbidden));
    for (const QString &id : forbidden) {
        if (!rows.contains(id))
            problems << QStringLiteral("forbidden id '%1' is not a contract route (a typo forbids nothing)").arg(id);
        if (net::findRoute(id) != nullptr)
            problems << QStringLiteral("findRoute('%1') answers a row").arg(id);
        if (!net::buildPath(id).isEmpty())
            problems << QStringLiteral("buildPath('%1') spells a path").arg(id);
    }
    for (const RouteSpec &row : table) {
        if (forbidden.contains(row.id))
            problems << QStringLiteral("forbidden route '%1' is in the table").arg(row.id);
    }
    for (auto it = rows.constBegin(); it != rows.constEnd(); ++it) {
        if (it.value().value(QStringLiteral("auth")).toString() == QLatin1String("token") && !forbidden.contains(it.key()))
            problems << QStringLiteral("token-auth route '%1' is not forbidden").arg(it.key());
    }
    return problems;
}

// C-5: sse flags agree both ways, and the contract has SSE rows at all (non-vacuity).
QStringList checkSse(const QJsonArray &contract, const QVector<RouteSpec> &table)
{
    QStringList problems;
    const QHash<QString, QJsonObject> rows = byId(contract);
    QSet<QString> contractSse;
    for (auto it = rows.constBegin(); it != rows.constEnd(); ++it) {
        if (it.value().value(QStringLiteral("sse")).toBool(false))
            contractSse.insert(it.key());
    }
    if (contractSse.isEmpty())
        problems << QStringLiteral("the contract has no sse:true row - the comparison would be vacuous");
    for (const RouteSpec &row : table) {
        const bool expected = contractSse.contains(row.id);
        if (row.sse != expected)
            problems << QStringLiteral("%1: sse %2 != contract %3")
                            .arg(row.id, row.sse ? QStringLiteral("true") : QStringLiteral("false"),
                                 expected ? QStringLiteral("true") : QStringLiteral("false"));
    }
    for (const QString &id : contractSse) {
        if (!tableIds(table).contains(id))
            problems << QStringLiteral("SSE route '%1' is not in the table").arg(id);
    }
    return problems;
}

// C-6: exactly three x-edit-client rows, the three the plan names, the transport's own set, and
// every lock-holder route among them.
QStringList checkEditClient(const QJsonArray &contract, const QVector<RouteSpec> &table, const QSet<QString> &transport)
{
    QStringList problems;
    QSet<QString> rows;
    int count = 0;
    for (const RouteSpec &row : table) {
        if (row.sendsEditClient) {
            rows.insert(row.id);
            ++count;
        }
    }
    if (count != 3)
        problems << QStringLiteral("%1 rows send x-edit-client, exactly 3 may").arg(count);
    if (rows != kEditClient)
        problems << QStringLiteral("x-edit-client rows {%1} != {%2}").arg(sorted(rows), sorted(kEditClient));
    if (transport != rows)
        problems << QStringLiteral("the transport enforces {%1}, the table says {%2}").arg(sorted(transport), sorted(rows));
    const QHash<QString, QJsonObject> contractRows = byId(contract);
    for (const QString &id : kEditClient) {
        if (!contractRows.contains(id))
            problems << QStringLiteral("x-edit-client id '%1' is not a contract route").arg(id);
    }
    for (auto it = contractRows.constBegin(); it != contractRows.constEnd(); ++it) {
        if (it.value().value(QStringLiteral("auth")).toString() == QLatin1String("lock-holder") && !rows.contains(it.key()))
            problems << QStringLiteral("lock-holder route '%1' does not send x-edit-client").arg(it.key());
    }
    return problems;
}

// C-7: one consumer per row · ProbeRunner = health only · every other consumer is a MODEL_KEYS
// method · every MODEL_KEYS method owns >= 1 row · only saveArticle owns 2, and exactly
// {articles-create, articles-update}.
QStringList checkConsumers(const QVector<RouteSpec> &table, const QStringList &modelKeys)
{
    QStringList problems;
    const QString probe = net::probeRunnerConsumer();
    if (probe.isEmpty())
        problems << QStringLiteral("probeRunnerConsumer() is empty");
    const QSet<QString> keys(modelKeys.begin(), modelKeys.end());
    QHash<QString, QSet<QString>> owned;
    QSet<QString> probeRows;
    static const QRegularExpression oneName(QStringLiteral("^[A-Za-z][A-Za-z0-9]*$"));
    for (const RouteSpec &row : table) {
        if (!oneName.match(row.consumer).hasMatch()) {
            problems << QStringLiteral("%1: consumer '%2' is not exactly one name").arg(row.id, row.consumer);
            continue;
        }
        if (row.consumer == probe) {
            probeRows.insert(row.id);
            continue;
        }
        if (!keys.contains(row.consumer))
            problems << QStringLiteral("%1: consumer '%2' is not a MODEL_KEYS method").arg(row.id, row.consumer);
        owned[row.consumer].insert(row.id);
    }
    if (probeRows != QSet<QString>{QStringLiteral("health")})
        problems << QStringLiteral("ProbeRunner rows {%1} != {health}").arg(sorted(probeRows));
    for (const QString &key : modelKeys) {
        if (owned.value(key).isEmpty())
            problems << QStringLiteral("MODEL_KEYS method '%1' owns no route").arg(key);
    }
    for (auto it = owned.constBegin(); it != owned.constEnd(); ++it) {
        if (it.value().size() > 1 && it.key() != kSaveArticle)
            problems << QStringLiteral("'%1' owns %2 routes - only saveArticle may own more than one")
                            .arg(it.key())
                            .arg(it.value().size());
    }
    if (owned.value(kSaveArticle) != kSaveArticleRoutes)
        problems << QStringLiteral("saveArticle owns {%1}, must own {%2}")
                        .arg(sorted(owned.value(kSaveArticle)), sorted(kSaveArticleRoutes));
    return problems;
}

// C-8: MODEL_KEYS (read from contract.js) == the interface's names, count and order.
QStringList checkModelKeys(const QStringList &modelKeys, const QStringList &interfaceNames)
{
    QStringList problems;
    if (modelKeys.size() != kModelKeyCount)
        problems << QStringLiteral("contract.js MODEL_KEYS has %1 names, the contract test fixes %2")
                        .arg(modelKeys.size())
                        .arg(kModelKeyCount);
    if (QSet<QString>(modelKeys.begin(), modelKeys.end()).size() != modelKeys.size())
        problems << QStringLiteral("MODEL_KEYS has duplicates");
    for (const QString &key : modelKeys) {
        if (!interfaceNames.contains(key))
            problems << QStringLiteral("MODEL_KEYS '%1' is missing from INewsModel").arg(key);
    }
    for (const QString &name : interfaceNames) {
        if (!modelKeys.contains(name))
            problems << QStringLiteral("INewsModel '%1' is not in MODEL_KEYS").arg(name);
    }
    if (problems.isEmpty() && modelKeys != interfaceNames)
        problems << QStringLiteral("same names, different order - keep MODEL_KEYS order");
    return problems;
}

QString report(const QStringList &problems)
{
    return problems.isEmpty() ? QString() : QStringLiteral("\n  - ") + problems.join(QStringLiteral("\n  - "));
}

#define LOAD_CONTRACT(routes)                                                                      \
    QJsonArray routes;                                                                             \
    {                                                                                              \
        QString loadError;                                                                         \
        QVERIFY2(loadEndpoints(&routes, &loadError), qPrintable(loadError));                       \
    }

#define LOAD_MODEL_KEYS(keys)                                                                      \
    QStringList keys;                                                                              \
    {                                                                                              \
        QString loadError;                                                                         \
        QVERIFY2(loadModelKeys(&keys, &loadError), qPrintable(loadError));                         \
    }

QJsonArray withRow(QJsonArray routes, const QString &id, const QString &key, const QJsonValue &value)
{
    for (int i = 0; i < routes.size(); ++i) {
        QJsonObject row = routes.at(i).toObject();
        if (row.value(QStringLiteral("id")).toString() == id) {
            if (value.isUndefined())
                row.remove(key);
            else
                row.insert(key, value);
            routes.replace(i, row);
        }
    }
    return routes;
}

bool mentions(const QStringList &problems, const QString &needle)
{
    return std::any_of(problems.begin(), problems.end(), [&](const QString &p) { return p.contains(needle); });
}

} // namespace

// ---------------------------------------------------------------------------------------------
void RouteContractTest::findsTheContractFilesFromTheRepositoryRoot()
{
    QStringList searched;
    const QString endpoints = findRepoFile(kEndpointsFile, &searched);
    QVERIFY2(!endpoints.isEmpty(), qPrintable(QStringLiteral("not found from: ") + searched.join(QStringLiteral(" | "))));
    const QString contract = findRepoFile(kModelContractFile);
    QVERIFY2(!contract.isEmpty(), "web/src/model/contract.js not found from the repository root");
    qInfo("contract files: %s | %s", qPrintable(endpoints), qPrintable(contract));
}

// A file that is missing, not JSON, or has no routes is a failure with a message - never an empty
// table that every check would then pass vacuously.
void RouteContractTest::refusesAContractItCannotRead()
{
    QString error;
    QByteArray bytes;
    QVERIFY(!readRepoFile(QStringLiteral("docs/api-contract/no-such-file.json"), &bytes, &error));
    QVERIFY2(error.contains(QStringLiteral("not found")), qPrintable(error));

    QJsonArray routes;
    QVERIFY(!parseEndpoints(QByteArray("not json"), &routes, &error));
    QVERIFY(!parseEndpoints(QByteArray(R"json({"version":1})json"), &routes, &error));
    QVERIFY(!parseEndpoints(QByteArray(R"json({"version":1,"routes":[]})json"), &routes, &error));
    QVERIFY(parseEndpoints(QByteArray(R"json({"version":1,"routes":[{"id":"x"}]})json"), &routes, &error));

    QVERIFY(parseModelKeys(QByteArray("export const OTHER = 1;"), &error).isEmpty());
    QVERIFY(parseModelKeys(QByteArray("export const MODEL_KEYS = Object.freeze([\n  login,\n]);"), &error).isEmpty());
    QVERIFY2(error.contains(QStringLiteral("unexpected line")), qPrintable(error));
    QCOMPARE(parseModelKeys(QByteArray("export const MODEL_KEYS = Object.freeze([\r\n  'login',\r\n  // c\r\n  'logout',\r\n]);"),
                            &error),
             (QStringList{QStringLiteral("login"), QStringLiteral("logout")}));
}

void RouteContractTest::c1_idSetIsExactlyTheContract()
{
    LOAD_CONTRACT(contract);
    // The named comparison first, so a drift is reported by id rather than by a count.
    const QStringList problems = checkIdSet(contract, net::routeTable(), net::forbiddenRouteIds());
    QVERIFY2(problems.isEmpty(), qPrintable(report(problems)));
    QCOMPARE(contract.size(), 39);  // the frozen inventory (README: REST 37 + SSE 2)
    QCOMPARE(net::routeTable().size(), 37);
}

void RouteContractTest::c2_methodAndPathMatchTheContract()
{
    LOAD_CONTRACT(contract);
    QVERIFY(!net::routeTable().isEmpty());
    const QStringList problems = checkMethodAndPath(contract, net::routeTable());
    QVERIFY2(problems.isEmpty(), qPrintable(report(problems)));
}

void RouteContractTest::c3_authMatchesTheContract()
{
    LOAD_CONTRACT(contract);
    QVERIFY(!net::routeTable().isEmpty());
    const QStringList problems = checkAuth(contract, net::routeTable());
    QVERIFY2(problems.isEmpty(), qPrintable(report(problems)));
}

void RouteContractTest::c4_forbiddenRoutesAreNotInTheTable()
{
    LOAD_CONTRACT(contract);
    const QStringList problems = checkForbidden(contract, net::routeTable(), net::forbiddenRouteIds());
    QVERIFY2(problems.isEmpty(), qPrintable(report(problems)));
}

void RouteContractTest::c5_sseRowsMatchTheContract()
{
    LOAD_CONTRACT(contract);
    QVERIFY(!net::routeTable().isEmpty());
    const QStringList problems = checkSse(contract, net::routeTable());
    QVERIFY2(problems.isEmpty(), qPrintable(report(problems)));
}

void RouteContractTest::c6_editClientRowsAreExactlyThreeAndTheTransportsSet()
{
    LOAD_CONTRACT(contract);
    const QStringList problems = checkEditClient(contract, net::routeTable(), net::editClientRouteIds());
    QVERIFY2(problems.isEmpty(), qPrintable(report(problems)));
}

void RouteContractTest::c7_consumersMapOneToMany()
{
    LOAD_MODEL_KEYS(keys);
    const QStringList problems = checkConsumers(net::routeTable(), keys);
    QVERIFY2(problems.isEmpty(), qPrintable(report(problems)));
    QCOMPARE(net::routesOf(kSaveArticle).size(), 2);
}

void RouteContractTest::c8_modelKeysAreTheInterface()
{
    LOAD_MODEL_KEYS(keys);
    const QStringList problems = checkModelKeys(keys, net::modelMethodNames());
    QVERIFY2(problems.isEmpty(), qPrintable(report(problems)));
}

// 검증 절차 3 (drift detection): every comparator reports a doctored copy by name. The copies
// live in memory; docs/api-contract/** and web/** are only read.
void RouteContractTest::detectsDriftInACopyOfTheContract()
{
    LOAD_CONTRACT(contract);
    LOAD_MODEL_KEYS(keys);
    const QVector<RouteSpec> &table = net::routeTable();
    const QSet<QString> &forbidden = net::forbiddenRouteIds();

    // A row the table lacks (the contract grew by one).
    QJsonArray grown = contract;
    grown.append(QJsonObject{{QStringLiteral("id"), QStringLiteral("articles-bulk-edit")},
                             {QStringLiteral("method"), QStringLiteral("POST")},
                             {QStringLiteral("path"), QStringLiteral("/api/articles/bulk")},
                             {QStringLiteral("auth"), QStringLiteral("admin")}});
    QVERIFY2(mentions(checkIdSet(grown, table, forbidden), QStringLiteral("articles-bulk-edit")),
             qPrintable(report(checkIdSet(grown, table, forbidden))));

    // A row the contract lost.
    QJsonArray shrunk;
    for (const QJsonValue &row : contract) {
        if (row.toObject().value(QStringLiteral("id")).toString() != QLatin1String("users-update"))
            shrunk.append(row);
    }
    QVERIFY(mentions(checkIdSet(shrunk, table, forbidden), QStringLiteral("users-update")));

    // A path, a method, an auth class, an sse flag.
    QVERIFY(mentions(checkMethodAndPath(withRow(contract, QStringLiteral("articles-get"), QStringLiteral("path"),
                                                QStringLiteral("/api/article/:id")),
                                        table),
                     QStringLiteral("articles-get")));
    QVERIFY(mentions(checkMethodAndPath(withRow(contract, QStringLiteral("logout"), QStringLiteral("method"),
                                                QStringLiteral("GET")),
                                        table),
                     QStringLiteral("logout")));
    QVERIFY(mentions(checkAuth(withRow(contract, QStringLiteral("login"), QStringLiteral("auth"), QStringLiteral("session")),
                               table),
                     QStringLiteral("login")));
    QVERIFY(mentions(checkSse(withRow(contract, QStringLiteral("stream"), QStringLiteral("sse"),
                                      QJsonValue(QJsonValue::Undefined)),
                              table),
                     QStringLiteral("stream")));
    // A new token route would be callable unless it is forbidden too.
    QJsonArray tokenRoute = contract;
    tokenRoute.append(QJsonObject{{QStringLiteral("id"), QStringLiteral("collection-push")},
                                  {QStringLiteral("auth"), QStringLiteral("token")}});
    QVERIFY(mentions(checkForbidden(tokenRoute, table, forbidden), QStringLiteral("collection-push")));
    // The contract making articles-create a lock-holder route would demand x-edit-client there.
    QVERIFY(mentions(checkEditClient(withRow(contract, QStringLiteral("articles-create"), QStringLiteral("auth"),
                                             QStringLiteral("lock-holder")),
                                     table, net::editClientRouteIds()),
                     QStringLiteral("articles-create")));

    // contract.js gaining a key: missing from the interface and owning no route.
    QStringList grownKeys = keys;
    grownKeys << QStringLiteral("deleteUser");
    QVERIFY(mentions(checkModelKeys(grownKeys, net::modelMethodNames()), QStringLiteral("deleteUser")));
    QVERIFY(mentions(checkConsumers(table, grownKeys), QStringLiteral("deleteUser")));
    // ... and losing one.
    QStringList shrunkKeys = keys;
    shrunkKeys.removeAll(QStringLiteral("getLogsDigest"));
    QVERIFY(mentions(checkModelKeys(shrunkKeys, net::modelMethodNames()), QStringLiteral("getLogsDigest")));
    QVERIFY(mentions(checkConsumers(table, shrunkKeys), QStringLiteral("getLogsDigest")));
}
