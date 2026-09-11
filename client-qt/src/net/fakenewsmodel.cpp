#include "net/fakenewsmodel.h"

#include <QDate>
#include <QDateTime>
#include <QJsonArray>
#include <QJsonValue>
#include <QLatin1Char>
#include <QMetaType>
#include <QStringList>
#include <QTime>
#include <QTimeZone>
#include <QVariant>

#include <functional>
#include <map>
#include <memory>

namespace net {
namespace {

using Handler = std::function<void(const QJsonObject &)>;

// Listeners by registration order (std::map, not QHash: QHash's per-process seed would make the
// call order differ from run to run - rule 1).
struct Registry {
    std::map<quint64, Handler> handlers;
    quint64 next = 1;
};

class FakeSubscription : public Subscription
{
public:
    FakeSubscription(const std::shared_ptr<Registry> &registry, quint64 id) : m_registry(registry), m_id(id) {}
    ~FakeSubscription() override { unsubscribe(); }
    bool connected() const override { return m_active && !m_registry.expired(); }
    void unsubscribe() override
    {
        if (!m_active)
            return;
        m_active = false;
        if (const std::shared_ptr<Registry> registry = m_registry.lock())
            registry->handlers.erase(m_id);
    }

private:
    std::weak_ptr<Registry> m_registry;  // the fake may die first - the handle stays safe
    quint64 m_id = 0;
    bool m_active = true;
};

// userService.js:10 SAFE_FIELDS - what any user answer may carry (the canonical stripPassword,
// done as the server does it: an allowlist, so the lockout fields never leave either).
const QStringList kUserFields{QStringLiteral("userId"), QStringLiteral("name"), QStringLiteral("role"),
                              QStringLiteral("department"), QStringLiteral("departmentCode"), QStringLiteral("active")};
// GET /api/session answers exactly these five (endpoints.json "session" notes).
const QStringList kSessionFields{QStringLiteral("userId"), QStringLiteral("name"), QStringLiteral("role"),
                                 QStringLiteral("department"), QStringLiteral("departmentCode")};
// receiverConfigService.js:9-12 - password and apiKey are write-only secrets.
const QStringList kReceiverConfigFields{QStringLiteral("id"),        QStringLiteral("sourceId"), QStringLiteral("type"),
                                        QStringLiteral("name"),      QStringLiteral("host"),     QStringLiteral("port"),
                                        QStringLiteral("apiEndpoint"), QStringLiteral("active"), QStringLiteral("createdAt"),
                                        QStringLiteral("username")};
// contentsProjection.js:18 PRIVATE_CONTENTS_COLS (override L131) - never in an answer.
const QStringList kPrivateArticleFields{QStringLiteral("lockerSessionId"), QStringLiteral("lockerClientId")};
// fakeModel.js:7-8 - distribution-target filter keys and mutable fields.
const QStringList kTargetFilterKeys{QStringLiteral("id"), QStringLiteral("name"), QStringLiteral("kind"),
                                    QStringLiteral("spoolDir"), QStringLiteral("active")};
const QStringList kTargetMutableKeys{QStringLiteral("name"), QStringLiteral("kind"), QStringLiteral("spoolDir"),
                                     QStringLiteral("active")};

QJsonObject pick(const QJsonObject &row, const QStringList &fields)
{
    QJsonObject out;
    for (const QString &field : fields) {
        if (row.contains(field))
            out.insert(field, row.value(field));
    }
    return out;
}

QJsonObject withoutPrivate(QJsonObject row)
{
    for (const QString &field : kPrivateArticleFields)
        row.remove(field);
    return row;
}

QJsonArray toArray(const QList<QJsonObject> &rows)
{
    QJsonArray array;
    for (const QJsonObject &row : rows)
        array.append(row);
    return array;
}

QJsonObject ok(const QJsonObject &fields = QJsonObject())
{
    QJsonObject body = fields;
    body.insert(QStringLiteral("ok"), true);
    return body;
}

QJsonObject failed(const QString &reason)
{
    return QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("reason"), reason}};
}

// server/index.js STATUS_BY_REASON for the tokens this fake emits (fallback 400 like fail()).
int statusFor(const QString &reason)
{
    if (reason == QLatin1String("unauthenticated") || reason == QLatin1String("invalid-credentials")
        || reason == QLatin1String("locked"))
        return 401;
    if (reason == QLatin1String("inactive") || reason == QLatin1String("not-holder"))
        return 403;
    if (reason == QLatin1String("not-found") || reason == QLatin1String("no-failure"))
        return 404;
    return 400;
}

// The same (route, status, token) classification the transport applies, so a screen tested on
// the fake branches exactly as it will on the wire. Only login and articles-lock need their id.
ModelResult answer(const QJsonObject &body, const QString &routeId = QString())
{
    ModelResult result;
    result.body = body;
    const QString reason = body.value(QStringLiteral("reason")).toString();
    result.status = body.value(QStringLiteral("ok")).toBool(false) ? 200 : statusFor(reason);
    result.outcome = classifyResponse(routeId, result.status, true, reason);
    return result;
}

bool isNullish(const QVariant &value)
{
    return !value.isValid() || value.typeId() == QMetaType::Nullptr;
}

QStringList asList(const QVariant &value)
{
    if (value.typeId() == QMetaType::QStringList || value.typeId() == QMetaType::QVariantList)
        return value.toStringList();
    return QStringList{value.toString()};
}

// JS truthiness of dto.articleId (fakeModel.js:144).
bool truthy(const QJsonValue &value)
{
    switch (value.type()) {
    case QJsonValue::Bool: return value.toBool();
    case QJsonValue::Double: return value.toDouble() != 0;
    case QJsonValue::String: return !value.toString().isEmpty();
    case QJsonValue::Array:
    case QJsonValue::Object: return true;
    default: return false;
    }
}

qint64 idOf(const QJsonObject &row)
{
    return row.value(QStringLiteral("id")).toInteger();
}

} // namespace

struct FakeNewsModel::State {
    QList<QJsonObject> users;
    QList<QJsonObject> articles;              // never hold a PRIVATE field (taken out at the door)
    QHash<QString, QString> lockHolders;      // articleId -> the holding surface's clientId
    QList<QJsonObject> receiverConfigs;
    QList<QJsonObject> distributionTargets;
    QList<QJsonObject> distributionFailures;
    std::optional<QJsonObject> tickResult;
    QList<QJsonObject> mediaItems;
    QList<QJsonObject> photos;
    QHash<QString, QList<QJsonObject>> histories;
    QHash<QString, QString> translations;
    QList<QJsonObject> logs;
    std::optional<QList<QJsonObject>> logsDigest;

    QString sessionUserId;  // an id - never an identity snapshot (L123-128)
    qint64 seq = 1;         // ids, as the canonical's seq
    qint64 ticks = 0;       // the counter clock (rule 1)
    std::shared_ptr<Registry> changes = std::make_shared<Registry>();
    std::shared_ptr<Registry> logListeners = std::make_shared<Registry>();

    // 2026-01-01T00:00:00.000Z + one second per stamp. Never the wall clock.
    static QDateTime base() { return QDateTime(QDate(2026, 1, 1), QTime(0, 0), QTimeZone::UTC); }
    QString stamp() { return base().addSecs(++ticks).toString(Qt::ISODateWithMs); }
    QString nextArticleId() { return QStringLiteral("AKRFAKE%1").arg(seq++, 9, 10, QLatin1Char('0')); }

    int userIndex(const QString &userId) const
    {
        for (int i = 0; i < users.size(); ++i) {
            if (users.at(i).value(QStringLiteral("userId")).toString() == userId)
                return i;
        }
        return -1;
    }
    int articleIndex(const QString &articleId) const
    {
        for (int i = 0; i < articles.size(); ++i) {
            if (articles.at(i).value(QStringLiteral("articleId")).toString() == articleId)
                return i;
        }
        return -1;
    }
    int targetIndex(qint64 id) const
    {
        for (int i = 0; i < distributionTargets.size(); ++i) {
            if (idOf(distributionTargets.at(i)) == id)
                return i;
        }
        return -1;
    }

    // Identity re-derived on every call: the current row, or no session at all. A missing or
    // deactivated user ends the session there and then (ADR-004).
    std::optional<QJsonObject> sessionUser()
    {
        if (sessionUserId.isEmpty())
            return std::nullopt;
        const int i = userIndex(sessionUserId);
        if (i < 0 || users.at(i).value(QStringLiteral("active")).toString() == QLatin1String("N")) {
            sessionUserId.clear();
            return std::nullopt;
        }
        return users.at(i);
    }

    // A row coming in (seed or save): the holder moves to lockHolders, the PRIVATE fields go.
    QJsonObject admitArticle(const QJsonObject &row)
    {
        const QString holder = row.value(QStringLiteral("lockerClientId")).toString();
        const QString id = row.value(QStringLiteral("articleId")).toString();
        if (!holder.isEmpty() && !id.isEmpty())
            lockHolders.insert(id, holder);
        return withoutPrivate(row);
    }

    // The invalidation signal {kind} - no row data (L80).
    void notify(const QString &kind)
    {
        const std::map<quint64, Handler> snapshot = changes->handlers;  // a handler may unsubscribe
        for (const auto &entry : snapshot)
            entry.second(QJsonObject{{QStringLiteral("kind"), kind}});
    }
};

FakeNewsModel::FakeNewsModel(const FakeSeed &seed) : d(std::make_unique<State>())
{
    d->users = seed.users;
    for (const QJsonObject &row : seed.articles)
        d->articles << d->admitArticle(row);
    d->receiverConfigs = seed.receiverConfigs;
    d->distributionTargets = seed.distributionTargets;
    d->distributionFailures = seed.distributionFailures;
    d->tickResult = seed.tickResult;
    d->mediaItems = seed.mediaItems;
    d->photos = seed.photos;
    d->histories = seed.histories;
    d->translations = seed.translations;
    d->logs = seed.logs;
    d->logsDigest = seed.logsDigest;
}

FakeNewsModel::~FakeNewsModel() = default;

// --- auth / session ------------------------------------------------------------------------------
ModelResult FakeNewsModel::login(const QString &userId, const QString &password)
{
    const int i = d->userIndex(userId);
    // userService.login: an inactive account is refused before the password matters.
    if (i >= 0 && d->users.at(i).value(QStringLiteral("active")).toString() == QLatin1String("N"))
        return answer(failed(QStringLiteral("inactive")), QStringLiteral("login"));
    if (i < 0 || d->users.at(i).value(QStringLiteral("password")).toString() != password)
        return answer(failed(QStringLiteral("invalid-credentials")), QStringLiteral("login"));
    d->sessionUserId = userId;
    // No sessionId in the answer: the real model keeps it in the cookie jar (decisions (6)).
    return answer(ok(QJsonObject{{QStringLiteral("user"), pick(d->users.at(i), kUserFields)}}), QStringLiteral("login"));
}

ModelResult FakeNewsModel::logout()
{
    d->sessionUserId.clear();
    return answer(ok());
}

ModelResult FakeNewsModel::restoreSession()
{
    const std::optional<QJsonObject> me = d->sessionUser();
    if (!me)
        return answer(failed(QStringLiteral("unauthenticated")));
    return answer(ok(QJsonObject{{QStringLiteral("user"), pick(*me, kSessionFields)}}));
}

// --- users ---------------------------------------------------------------------------------------
ModelResult FakeNewsModel::queryUsers(const QVariantMap &)
{
    QJsonArray items;
    for (const QJsonObject &row : d->users)
        items.append(pick(row, kUserFields));
    return answer(ok(QJsonObject{{QStringLiteral("items"), items}}));
}

ModelResult FakeNewsModel::createUser(const QJsonObject &payload)
{
    QJsonObject row = payload;
    if (!row.contains(QStringLiteral("active")))
        row.insert(QStringLiteral("active"), QStringLiteral("Y"));  // userService.create default
    d->users << row;
    return answer(ok(QJsonObject{{QStringLiteral("user"), pick(row, kUserFields)}}));
}

// The only way a user leaves: active 'N'. 200 {ok, changes} - no not-found (endpoints.json).
ModelResult FakeNewsModel::updateUser(const QString &userId, const QJsonObject &fields)
{
    const int i = d->userIndex(userId);
    if (i < 0)
        return answer(ok(QJsonObject{{QStringLiteral("changes"), 0}}));
    QJsonObject row = d->users.at(i);
    for (auto it = fields.begin(); it != fields.end(); ++it)
        row.insert(it.key(), it.value());
    d->users[i] = row;
    return answer(ok(QJsonObject{{QStringLiteral("changes"), 1}}));
}

// --- articles / search ---------------------------------------------------------------------------
ModelResult FakeNewsModel::queryArticles(const QVariantMap &filters)
{
    const QVariant status = filters.value(QStringLiteral("status"));
    const QVariant exclude = filters.value(QStringLiteral("excludeStatus"));
    QJsonArray items;
    for (const QJsonObject &row : d->articles) {
        const QString rowStatus = row.value(QStringLiteral("status")).toString();
        if (!isNullish(status) && !asList(status).contains(rowStatus))
            continue;
        if (!isNullish(exclude) && asList(exclude).contains(rowStatus))
            continue;
        items.append(withoutPrivate(row));
    }
    return answer(ok(QJsonObject{{QStringLiteral("items"), items}}));
}

ModelResult FakeNewsModel::getArticle(const QString &articleId)
{
    const int i = d->articleIndex(articleId);
    if (i < 0)
        return answer(failed(QStringLiteral("not-found")));
    // server getById: { article, contents } - the flat in-memory row stands for both.
    const QJsonObject row = withoutPrivate(d->articles.at(i));
    return answer(ok(QJsonObject{{QStringLiteral("article"), row}, {QStringLiteral("contents"), row}}));
}

ModelResult FakeNewsModel::searchArticles(const QString &q)
{
    QJsonArray items;
    for (const QJsonObject &row : d->articles) {
        if (row.value(QStringLiteral("title")).toString().contains(q))
            items.append(withoutPrivate(row));
    }
    return answer(ok(QJsonObject{{QStringLiteral("items"), items}}));
}

ModelResult FakeNewsModel::searchMedia(const QString &, const QString &type)
{
    QJsonArray items;
    for (const QJsonObject &row : d->mediaItems) {
        if (type.isEmpty() || row.value(QStringLiteral("type")).toString() == type)
            items.append(row);
    }
    return answer(ok(QJsonObject{{QStringLiteral("items"), items}, {QStringLiteral("error"), false}}));
}

// registeredBy is the session's user - never the payload's (ADR-004).
ModelResult FakeNewsModel::publishPhoto(const QJsonObject &payload)
{
    const qint64 id = d->seq++;
    const std::optional<QJsonObject> me = d->sessionUser();
    const QJsonValue caption = payload.value(QStringLiteral("caption"));
    const QJsonValue source = payload.value(QStringLiteral("sourceArticleId"));
    d->photos << QJsonObject{{QStringLiteral("id"), id},
                             {QStringLiteral("src"), payload.value(QStringLiteral("src"))},
                             {QStringLiteral("caption"), caption.isUndefined() || caption.isNull() ? QJsonValue(QString()) : caption},
                             {QStringLiteral("sourceArticleId"),
                              source.isUndefined() || source.isNull() ? QJsonValue(QString()) : source},
                             {QStringLiteral("registeredBy"),
                              me ? me->value(QStringLiteral("userId")) : QJsonValue(QJsonValue::Null)},
                             {QStringLiteral("createdAt"), d->stamp()}};
    return answer(ok(QJsonObject{{QStringLiteral("id"), id}}));
}

ModelResult FakeNewsModel::searchPhotos(const QString &q)
{
    QJsonArray items;
    for (const QJsonObject &row : d->photos) {
        if (row.value(QStringLiteral("caption")).toString().contains(q))
            items.append(row);
    }
    return answer(ok(QJsonObject{{QStringLiteral("items"), items}}));
}

// --- actions / save / edit lock ------------------------------------------------------------------
ModelResult FakeNewsModel::applyAction(const QString &articleId, const QString &action)
{
    const int i = d->articleIndex(articleId);
    if (i < 0)
        return answer(failed(QStringLiteral("not-found")));
    d->articles[i].insert(QStringLiteral("lastAction"), action);
    d->notify(QStringLiteral("status"));
    return answer(ok(QJsonObject{{QStringLiteral("articleId"), articleId}}));
}

// rule 6: the body key is dropped (the server keeps the text in markupVersion only). Like the
// canonical, only the clientId is checked against the holder - the server also checks the user.
ModelResult FakeNewsModel::saveArticle(const QJsonObject &dto, const QString &clientId, const QString &)
{
    QJsonObject persist = dto;
    persist.remove(QStringLiteral("body"));
    if (truthy(persist.value(QStringLiteral("articleId")))) {
        const QString articleId = persist.value(QStringLiteral("articleId")).toVariant().toString();
        const int i = d->articleIndex(articleId);
        const QString holder = d->lockHolders.value(articleId);
        if (i >= 0 && d->articles.at(i).value(QStringLiteral("lockYN")).toString() == QLatin1String("Y")
            && !holder.isEmpty() && !clientId.isEmpty() && clientId != holder)
            return answer(failed(QStringLiteral("not-holder")));
        persist = withoutPrivate(persist);
        if (i >= 0) {
            QJsonObject row = d->articles.at(i);
            for (auto it = persist.begin(); it != persist.end(); ++it)
                row.insert(it.key(), it.value());
            d->articles[i] = row;
        } else {
            d->articles << persist;
        }
        d->notify(QStringLiteral("update"));
        return answer(ok(QJsonObject{{QStringLiteral("articleId"), articleId}}));
    }
    const QString articleId = d->nextArticleId();
    persist = withoutPrivate(persist);
    persist.insert(QStringLiteral("articleId"), articleId);
    persist.insert(QStringLiteral("status"), QStringLiteral("RDS"));
    d->articles << persist;
    d->notify(QStringLiteral("create"));
    return answer(ok(QJsonObject{{QStringLiteral("articleId"), articleId}}));
}

// The canonical's reduced lock: another surface holding it -> 'locked'; the same surface (or a
// caller without one) re-acquires. The holder lives in lockHolders, never in a row.
ModelResult FakeNewsModel::lockArticle(const QString &articleId, const QString &, const QString &clientId)
{
    const int i = d->articleIndex(articleId);
    if (i >= 0) {
        const QString holder = d->lockHolders.value(articleId);
        if (d->articles.at(i).value(QStringLiteral("lockYN")).toString() == QLatin1String("Y") && !holder.isEmpty()
            && !clientId.isEmpty() && holder != clientId)
            return answer(failed(QStringLiteral("locked")), QStringLiteral("articles-lock"));
        d->articles[i].insert(QStringLiteral("lockYN"), QStringLiteral("Y"));
        if (clientId.isEmpty())
            d->lockHolders.remove(articleId);
        else
            d->lockHolders.insert(articleId, clientId);
    }
    d->notify(QStringLiteral("lock"));
    return answer(ok());
}

ModelResult FakeNewsModel::unlockArticle(const QString &articleId, const QString &clientId)
{
    const int i = d->articleIndex(articleId);
    if (i >= 0) {
        const QString holder = d->lockHolders.value(articleId);
        if (d->articles.at(i).value(QStringLiteral("lockYN")).toString() == QLatin1String("Y") && !holder.isEmpty()
            && !clientId.isEmpty() && holder != clientId)
            return answer(failed(QStringLiteral("not-holder")));
        d->articles[i].insert(QStringLiteral("lockYN"), QStringLiteral("N"));
        d->lockHolders.remove(articleId);
    }
    d->notify(QStringLiteral("lock"));
    return answer(ok());
}

ModelResult FakeNewsModel::forceUnlockArticle(const QString &articleId)
{
    const int i = d->articleIndex(articleId);
    if (i >= 0) {
        d->articles[i].insert(QStringLiteral("lockYN"), QStringLiteral("N"));
        d->lockHolders.remove(articleId);
    }
    d->notify(QStringLiteral("lock"));
    return answer(ok());
}

// --- receiver config (secrets are write-only) ----------------------------------------------------
ModelResult FakeNewsModel::queryReceiverConfig(const QVariantMap &)
{
    QJsonArray items;
    for (const QJsonObject &row : d->receiverConfigs)
        items.append(pick(row, kReceiverConfigFields));
    return answer(ok(QJsonObject{{QStringLiteral("items"), items}}));
}

ModelResult FakeNewsModel::createReceiverConfig(const QJsonObject &entry)
{
    const qint64 id = d->seq++;
    QJsonObject row = entry;
    row.insert(QStringLiteral("id"), id);
    d->receiverConfigs << row;
    return answer(ok(QJsonObject{{QStringLiteral("id"), id}}));
}

// The one row this fake removes - a settings row, exactly as receiverConfigModel.remove does
// (collected articles are never touched). 200 {ok, changes} even for an unknown id.
ModelResult FakeNewsModel::deleteReceiverConfig(qint64 id)
{
    for (int i = 0; i < d->receiverConfigs.size(); ++i) {
        if (idOf(d->receiverConfigs.at(i)) == id) {
            d->receiverConfigs.removeAt(i);
            return answer(ok(QJsonObject{{QStringLiteral("changes"), 1}}));
        }
    }
    return answer(ok(QJsonObject{{QStringLiteral("changes"), 0}}));
}

// --- distribution targets (no delete - deactivate is the soft delete) ----------------------------
ModelResult FakeNewsModel::queryDistributionTargets(const QVariantMap &filters)
{
    QJsonArray items;
    for (const QJsonObject &row : d->distributionTargets) {
        bool match = true;
        for (const QString &key : kTargetFilterKeys) {
            const QVariant wanted = filters.value(key);
            if (!isNullish(wanted) && row.value(key).toVariant().toString() != wanted.toString())
                match = false;
        }
        if (match)
            items.append(row);
    }
    return answer(ok(QJsonObject{{QStringLiteral("items"), items}}));
}

// id / createdAt / updatedAt are the server's - the entry's own are ignored (ADR-004).
ModelResult FakeNewsModel::createDistributionTarget(const QJsonObject &entry)
{
    const qint64 id = d->seq++;
    const QString stamp = d->stamp();
    const QJsonValue active = entry.value(QStringLiteral("active"));
    d->distributionTargets << QJsonObject{{QStringLiteral("id"), id},
                                          {QStringLiteral("name"), entry.value(QStringLiteral("name"))},
                                          {QStringLiteral("kind"), entry.value(QStringLiteral("kind"))},
                                          {QStringLiteral("spoolDir"), entry.value(QStringLiteral("spoolDir"))},
                                          {QStringLiteral("active"),
                                           active.isUndefined() || active.isNull() ? QJsonValue(QStringLiteral("Y")) : active},
                                          {QStringLiteral("createdAt"), stamp},
                                          {QStringLiteral("updatedAt"), stamp}};
    return answer(ok(QJsonObject{{QStringLiteral("id"), id}}));
}

ModelResult FakeNewsModel::updateDistributionTarget(qint64 id, const QJsonObject &fields)
{
    const int i = d->targetIndex(id);
    if (i < 0)
        return answer(failed(QStringLiteral("not-found")));
    QJsonObject row = d->distributionTargets.at(i);
    for (const QString &key : kTargetMutableKeys) {
        if (fields.contains(key) && !fields.value(key).isUndefined())
            row.insert(key, fields.value(key));
    }
    row.insert(QStringLiteral("updatedAt"), d->stamp());
    d->distributionTargets[i] = row;
    return answer(ok(QJsonObject{{QStringLiteral("changes"), 1}}));
}

// rule 5: the row stays; only active flips to 'N'.
ModelResult FakeNewsModel::deactivateDistributionTarget(qint64 id)
{
    const int i = d->targetIndex(id);
    if (i < 0)
        return answer(failed(QStringLiteral("not-found")));
    d->distributionTargets[i].insert(QStringLiteral("active"), QStringLiteral("N"));
    d->distributionTargets[i].insert(QStringLiteral("updatedAt"), d->stamp());
    return answer(ok(QJsonObject{{QStringLiteral("changes"), 1}}));
}

// --- distribution failures / tick ----------------------------------------------------------------
ModelResult FakeNewsModel::queryDistributionFailures(const QVariantMap &filters)
{
    QList<QJsonObject> rows = d->distributionFailures;
    const QVariant limit = filters.value(QStringLiteral("limit"));
    if (!isNullish(limit) && limit.toInt() >= 0 && limit.toInt() < rows.size())
        rows = rows.mid(0, limit.toInt());
    return answer(ok(QJsonObject{{QStringLiteral("items"), toArray(rows)}}));
}

// The unresolved list is what the server DERIVES from its append-only history; leaving it is a
// resolution, not a row deletion (fakeModel.js:23-26).
ModelResult FakeNewsModel::retryDistribution(qint64 historyId)
{
    for (int i = 0; i < d->distributionFailures.size(); ++i) {
        const QJsonObject failure = d->distributionFailures.at(i);
        if (failure.value(QStringLiteral("historyId")).toInteger() != historyId)
            continue;
        d->distributionFailures.removeAt(i);
        return answer(ok(QJsonObject{{QStringLiteral("articleId"), failure.value(QStringLiteral("articleId"))},
                                     {QStringLiteral("targetId"), failure.value(QStringLiteral("targetId"))},
                                     {QStringLiteral("kind"), failure.value(QStringLiteral("kind"))},
                                     {QStringLiteral("at"), d->stamp()}}));
    }
    return answer(failed(QStringLiteral("no-failure")));
}

// A manual tick only - no timer of any kind (ADR-008 (3)).
ModelResult FakeNewsModel::runDistributionTick()
{
    if (d->tickResult)
        return answer(*d->tickResult);
    return answer(ok(QJsonObject{{QStringLiteral("at"), State::base().toString(Qt::ISODateWithMs)},
                                 {QStringLiteral("scanned"), 0},
                                 {QStringLiteral("distributed"), QJsonArray()},
                                 {QStringLiteral("failed"), QJsonArray()},
                                 {QStringLiteral("invalid"), QJsonArray()}}));
}

// --- realtime ------------------------------------------------------------------------------------
std::unique_ptr<Subscription> FakeNewsModel::subscribe(const QVariantMap &filter, ChangeHandler onChange,
                                                       StatusHandler onStatus)
{
    const quint64 id = d->changes->next++;
    d->changes->handlers.emplace(id, [filter, onChange](const QJsonObject &signal) {
        if (onChange)
            onChange(signal, filter);
    });
    if (onStatus)
        onStatus(true);  // the fake stream is connected at once (canonical)
    return std::make_unique<FakeSubscription>(d->changes, id);
}

// --- history / derive / translate / upload / snapshot --------------------------------------------
ModelResult FakeNewsModel::queryHistory(const QString &articleId, bool sendOnly)
{
    QJsonArray items;
    for (QJsonObject row : d->histories.value(articleId)) {
        if (sendOnly && row.value(QStringLiteral("action")).toString() != QLatin1String("send"))
            continue;
        row.remove(QStringLiteral("markupVersion"));  // the list is light; the seed keeps its blob
        items.append(row);
    }
    return answer(ok(QJsonObject{{QStringLiteral("items"), items}}));
}

ModelResult FakeNewsModel::deriveArticle(const QString &articleId, const QString &mode)
{
    const int i = d->articleIndex(articleId);
    if (i < 0)
        return answer(failed(QStringLiteral("not-found")));
    const QString newId = d->nextArticleId();
    QJsonObject derived = d->articles.at(i);  // a copy - the source is never touched
    derived.insert(QStringLiteral("articleId"), newId);
    derived.insert(QStringLiteral("status"), QStringLiteral("RDS"));
    if (mode == QLatin1String("followUp"))
        derived.remove(QStringLiteral("body"));
    d->articles << derived;
    d->notify(QStringLiteral("create"));
    return answer(ok(QJsonObject{{QStringLiteral("articleId"), newId}}));
}

ModelResult FakeNewsModel::translate(const QString &articleId, const QString &)
{
    if (d->translations.contains(articleId))
        return answer(ok(QJsonObject{{QStringLiteral("translatedText"), d->translations.value(articleId)}}));
    const int i = d->articleIndex(articleId);
    const QString title = i >= 0 ? d->articles.at(i).value(QStringLiteral("title")).toString() : QString();
    return answer(ok(QJsonObject{{QStringLiteral("translatedText"), title}}));
}

ModelResult FakeNewsModel::uploadFile(const QString &fileName, const QByteArray &, const QString &)
{
    const QString name = fileName.isEmpty() ? QStringLiteral("file") : fileName;
    return answer(ok(QJsonObject{{QStringLiteral("path"), QStringLiteral("/uploads/fake-") + name},
                                 {QStringLiteral("filename"), name}}));
}

ModelResult FakeNewsModel::getHistorySnapshot(const QString &articleId, qint64 historyId)
{
    for (const QJsonObject &row : d->histories.value(articleId)) {
        if (idOf(row) == historyId)
            return answer(ok(QJsonObject{{QStringLiteral("item"), row}}));
    }
    return answer(failed(QStringLiteral("not-found")));
}

// --- log viewer ----------------------------------------------------------------------------------
std::unique_ptr<Subscription> FakeNewsModel::subscribeLogs(LogHandler onLog, StatusHandler onStatus)
{
    for (const QJsonObject &record : d->logs) {  // the server replays its buffer on connect
        if (onLog)
            onLog(record);
    }
    const quint64 id = d->logListeners->next++;
    d->logListeners->handlers.emplace(id, [onLog](const QJsonObject &record) {
        if (onLog)
            onLog(record);
    });
    if (onStatus)
        onStatus(true);
    return std::make_unique<FakeSubscription>(d->logListeners, id);
}

ModelResult FakeNewsModel::getLogsDigest()
{
    return answer(ok(QJsonObject{{QStringLiteral("items"), toArray(d->logsDigest.value_or(d->logs))}}));
}

} // namespace net
