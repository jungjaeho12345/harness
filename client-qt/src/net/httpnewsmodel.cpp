#include "net/httpnewsmodel.h"

#include "net/changestream.h"
#include "net/routetable.h"

#include <QDateTime>
#include <QJsonValue>
#include <QObject>
#include <QPointer>
#include <QVariant>

#include <cmath>

namespace net {
namespace {

// subscribeLogs() for the whole of P4: nothing is opened, nothing is reported, unsubscribe() is a
// no-op (the log stream is Z-only and P7's).
class InertSubscription : public Subscription
{
public:
    bool connected() const override { return false; }
    void unsubscribe() override {}
};

// subscribe(): the canonical {connected(), unsubscribe()} handle over one ChangeStream (step9).
//   ready        -> onStatus(true)
//   change       -> onChange({kind} or {} , filter) - the caller's filter handed back as given (L80)
//   any close but unsubscribe -> onStatus(false)   (httpModel.js:330-332 - unauthorized and error)
//   unauthorized frame / 401 before opening -> onSessionEnd() after onStatus(false)
// unsubscribe() - and dropping the handle - says nothing to the screen: it may be going away.
class StreamSubscription : public Subscription
{
public:
    StreamSubscription(HttpTransport *transport, const QVariantMap &filter, ChangeHandler onChange,
                       StatusHandler onStatus, SessionEndHandler onSessionEnd)
        : m_stream(new ChangeStream(transport, transport ? transport->diag() : nullptr))
    {
        ChangeStream *stream = m_stream.data();
        QObject::connect(stream, &ChangeStream::readyReceived, stream, [onStatus] {
            if (onStatus)
                onStatus(true);
        });
        QObject::connect(stream, &ChangeStream::changed, stream, [onChange, filter](const QString &kind) {
            if (onChange)
                onChange(kind.isEmpty() ? QJsonObject() : QJsonObject{{QStringLiteral("kind"), kind}}, filter);
        });
        QObject::connect(stream, &ChangeStream::disconnected, stream, [onStatus](CloseReason reason, int) {
            if (reason != CloseReason::Stopped && onStatus)
                onStatus(false);
        });
        QObject::connect(stream, &ChangeStream::unauthorized, stream, [onSessionEnd] {
            if (onSessionEnd)
                onSessionEnd();
        });
        stream->start();
    }
    ~StreamSubscription() override { unsubscribe(); }

    bool connected() const override { return m_stream && m_stream->isConnected(); }

    void unsubscribe() override
    {
        ChangeStream *stream = m_stream.data();
        m_stream = nullptr;
        if (!stream)
            return;
        QObject::disconnect(stream, nullptr, nullptr, nullptr);  // no handler hears the stop
        stream->stop();
        stream->deleteLater();  // this may run inside one of the stream's own signals
    }

private:
    QPointer<ChangeStream> m_stream;
};

// JS truthiness of dto.articleId (httpModel.js:189 - "if (dto.articleId)").
bool truthy(const QJsonValue &value)
{
    switch (value.type()) {
    case QJsonValue::Bool: return value.toBool();
    case QJsonValue::Double: return value.toDouble() != 0 && !std::isnan(value.toDouble());
    case QJsonValue::String: return !value.toString().isEmpty();
    case QJsonValue::Array:
    case QJsonValue::Object: return true;
    default: return false;
    }
}

// A JSON id as a path parameter (a string, or an integral number).
QVariant pathValue(const QJsonValue &value)
{
    if (value.isString())
        return value.toString();
    if (value.isDouble())
        return value.toInteger();
    return QVariant();
}

// { key: value } - or {} when value is null, the way JSON.stringify drops an undefined value.
QJsonObject optionalField(const QString &key, const QString &value)
{
    return value.isNull() ? QJsonObject() : QJsonObject{{key, value}};
}

// A query value that is absent when null (buildQuery drops the key).
QVariant optionalQuery(const QString &value)
{
    return value.isNull() ? QVariant() : QVariant(value);
}

QVariantMap idParam(const QVariant &id)
{
    return QVariantMap{{QStringLiteral("id"), id}};
}

} // namespace

HttpNewsModel::HttpNewsModel(HttpTransport *transport) : m_transport(transport) {}

ModelResult HttpNewsModel::call(const QString &routeId, const QVariantMap &pathParams,
                                const std::optional<QJsonObject> &body, const QVariantMap &query,
                                const QString &editClientId)
{
    const RouteSpec *route = findRoute(routeId);
    const QString path = route ? buildPath(routeId, pathParams) : QString();
    if (!route || path.isEmpty() || !m_transport)
        return notSentResult();

    RequestSpec spec;
    spec.routeId = route->id;
    spec.method = route->method;
    spec.path = path;
    // The table decides whether a body goes at all: a bodyless route never sends one, a body route
    // always does ({} when the caller has nothing - articles-lock without an action).
    if (route->hasBody)
        spec.body = body.value_or(QJsonObject());
    spec.query = query;
    // Handed over only where the table allows it; the transport enforces the same set again.
    if (route->sendsEditClient)
        spec.editClientId = editClientId;
    return modelResultFrom(m_transport->send(spec));
}

// --- auth / session ------------------------------------------------------------------------------
ModelResult HttpNewsModel::login(const QString &userId, const QString &password)
{
    ModelResult result = call(QStringLiteral("login"), QVariantMap(),
                              QJsonObject{{QStringLiteral("userId"), userId}, {QStringLiteral("password"), password}});
    // decisions (6): the session is the cookie the jar already holds. The body's sessionId exists
    // for the web's header fallback, which this client does not have - no caller ever sees it.
    result.body.remove(QStringLiteral("sessionId"));
    return result;
}

ModelResult HttpNewsModel::logout()
{
    const ModelResult result = call(QStringLiteral("logout"));
    // httpModel.js:134 forgets the local session after the request whatever it answered; the jar
    // is the local session here.
    if (m_transport)
        m_transport->clearSession();
    return result;
}

ModelResult HttpNewsModel::restoreSession()
{
    return call(QStringLiteral("session"));
}

// --- users -----------------------------------------------------------------------------------------
ModelResult HttpNewsModel::queryUsers(const QVariantMap &filters)
{
    return call(QStringLiteral("users-list"), QVariantMap(), std::nullopt, filters);
}

ModelResult HttpNewsModel::createUser(const QJsonObject &payload)
{
    return call(QStringLiteral("users-create"), QVariantMap(), payload);
}

ModelResult HttpNewsModel::updateUser(const QString &userId, const QJsonObject &fields)
{
    return call(QStringLiteral("users-update"), idParam(userId), fields);
}

// --- articles / search -----------------------------------------------------------------------------
ModelResult HttpNewsModel::queryArticles(const QVariantMap &filters)
{
    // The filters go to buildQuery unchanged: a list repeats its key (status=RDS&status=DDH).
    return call(QStringLiteral("articles-list"), QVariantMap(), std::nullopt, filters);
}

ModelResult HttpNewsModel::getArticle(const QString &articleId)
{
    return call(QStringLiteral("articles-get"), idParam(articleId));
}

ModelResult HttpNewsModel::searchArticles(const QString &q)
{
    return call(QStringLiteral("articles-search"), QVariantMap(), std::nullopt,
                QVariantMap{{QStringLiteral("q"), optionalQuery(q)}});
}

ModelResult HttpNewsModel::searchMedia(const QString &query, const QString &type)
{
    return call(QStringLiteral("media-search"), QVariantMap(), std::nullopt,
                QVariantMap{{QStringLiteral("q"), optionalQuery(query)}, {QStringLiteral("type"), optionalQuery(type)}});
}

ModelResult HttpNewsModel::publishPhoto(const QJsonObject &payload)
{
    return call(QStringLiteral("photos-create"), QVariantMap(), payload);
}

ModelResult HttpNewsModel::searchPhotos(const QString &q)
{
    return call(QStringLiteral("photos-search"), QVariantMap(), std::nullopt,
                QVariantMap{{QStringLiteral("q"), optionalQuery(q)}});
}

// --- actions / save / edit lock --------------------------------------------------------------------
ModelResult HttpNewsModel::applyAction(const QString &articleId, const QString &action)
{
    return call(QStringLiteral("articles-action"), idParam(articleId), optionalField(QStringLiteral("action"), action));
}

ModelResult HttpNewsModel::saveArticle(const QJsonObject &dto, const QString &clientId, const QString &action)
{
    const QJsonValue articleId = dto.value(QStringLiteral("articleId"));
    if (truthy(articleId)) {
        // PUT: the dto as it is (the action never rides here - state changes are applyAction's).
        return call(QStringLiteral("articles-update"), idParam(pathValue(articleId)), dto, QVariantMap(), clientId);
    }
    QJsonObject body = dto;
    if (!action.isEmpty())
        body.insert(QStringLiteral("action"), action);
    // clientId is passed like the canonical does, and dropped by the table: articles-create
    // does not send x-edit-client.
    return call(QStringLiteral("articles-create"), QVariantMap(), body, QVariantMap(), clientId);
}

ModelResult HttpNewsModel::lockArticle(const QString &articleId, const QString &action, const QString &clientId)
{
    // Always a body - {} without an action (httpModel.js:248).
    const QJsonObject body = action.isEmpty() ? QJsonObject() : QJsonObject{{QStringLiteral("action"), action}};
    return call(QStringLiteral("articles-lock"), idParam(articleId), body, QVariantMap(), clientId);
}

ModelResult HttpNewsModel::unlockArticle(const QString &articleId, const QString &clientId)
{
    return call(QStringLiteral("articles-unlock"), idParam(articleId), std::nullopt, QVariantMap(), clientId);
}

ModelResult HttpNewsModel::forceUnlockArticle(const QString &articleId)
{
    return call(QStringLiteral("articles-force-unlock"), idParam(articleId));
}

// --- receiver config -------------------------------------------------------------------------------
ModelResult HttpNewsModel::queryReceiverConfig(const QVariantMap &filters)
{
    return call(QStringLiteral("receiver-config-list"), QVariantMap(), std::nullopt, filters);
}

ModelResult HttpNewsModel::createReceiverConfig(const QJsonObject &entry)
{
    return call(QStringLiteral("receiver-config-create"), QVariantMap(), entry);
}

ModelResult HttpNewsModel::deleteReceiverConfig(qint64 id)
{
    return call(QStringLiteral("receiver-config-delete"), idParam(id));
}

// --- distribution targets --------------------------------------------------------------------------
ModelResult HttpNewsModel::queryDistributionTargets(const QVariantMap &filters)
{
    return call(QStringLiteral("distribution-targets-list"), QVariantMap(), std::nullopt, filters);
}

ModelResult HttpNewsModel::createDistributionTarget(const QJsonObject &entry)
{
    return call(QStringLiteral("distribution-targets-create"), QVariantMap(), entry);
}

ModelResult HttpNewsModel::updateDistributionTarget(qint64 id, const QJsonObject &fields)
{
    return call(QStringLiteral("distribution-targets-update"), idParam(id), fields);
}

ModelResult HttpNewsModel::deactivateDistributionTarget(qint64 id)
{
    return call(QStringLiteral("distribution-targets-deactivate"), idParam(id));
}

// --- distribution failures / tick ------------------------------------------------------------------
ModelResult HttpNewsModel::queryDistributionFailures(const QVariantMap &filters)
{
    return call(QStringLiteral("distribution-failures"), QVariantMap(), std::nullopt, filters);
}

ModelResult HttpNewsModel::retryDistribution(qint64 historyId)
{
    // Exactly { historyId } - article, target and kind are the server's to derive (ADR-004).
    return call(QStringLiteral("distribution-retry"), QVariantMap(), QJsonObject{{QStringLiteral("historyId"), historyId}});
}

ModelResult HttpNewsModel::runDistributionTick()
{
    return call(QStringLiteral("distribution-tick"));
}

// --- realtime --------------------------------------------------------------------------------------
std::unique_ptr<Subscription> HttpNewsModel::subscribe(const QVariantMap &filter, ChangeHandler onChange,
                                                       StatusHandler onStatus, SessionEndHandler onSessionEnd)
{
    // One independent stream per call, like the canonical's new EventSource per subscribe() - two
    // at once (writer + list) is the normal pattern (sse.md 90). Same session: the transport's jar.
    return std::make_unique<StreamSubscription>(m_transport, filter, std::move(onChange), std::move(onStatus),
                                                std::move(onSessionEnd));
}

// --- history / derive / translate / upload / snapshot ----------------------------------------------
ModelResult HttpNewsModel::queryHistory(const QString &articleId, bool sendOnly)
{
    return call(QStringLiteral("articles-history"), idParam(articleId), std::nullopt,
                sendOnly ? QVariantMap{{QStringLiteral("sendOnly"), 1}} : QVariantMap());
}

ModelResult HttpNewsModel::deriveArticle(const QString &articleId, const QString &mode)
{
    return call(QStringLiteral("articles-derive"), idParam(articleId), optionalField(QStringLiteral("mode"), mode));
}

ModelResult HttpNewsModel::translate(const QString &articleId, const QString &targetLang)
{
    return call(QStringLiteral("articles-translate"), idParam(articleId),
                optionalField(QStringLiteral("targetLang"), targetLang));
}

ModelResult HttpNewsModel::uploadFile(const QString &fileName, const QByteArray &content, const QString &mimeType)
{
    // Raw base64 without a data: prefix (httpModel.js:236) and the canonical file name rule.
    const QJsonObject body{
        {QStringLiteral("filename"), resolveUploadFilename(fileName, mimeType, QDateTime::currentMSecsSinceEpoch())},
        {QStringLiteral("contentBase64"), QString::fromLatin1(content.toBase64())}};
    return call(QStringLiteral("upload"), QVariantMap(), body);
}

ModelResult HttpNewsModel::getHistorySnapshot(const QString &articleId, qint64 historyId)
{
    return call(QStringLiteral("articles-history-snapshot"),
                QVariantMap{{QStringLiteral("id"), articleId}, {QStringLiteral("historyId"), historyId}});
}

// --- log viewer ------------------------------------------------------------------------------------
std::unique_ptr<Subscription> HttpNewsModel::subscribeLogs(LogHandler, StatusHandler)
{
    // excluded (c): the log stream is Z-only and P7's. P4 opens nothing.
    return std::make_unique<InertSubscription>();
}

ModelResult HttpNewsModel::getLogsDigest()
{
    return call(QStringLiteral("logs-digest"));
}

} // namespace net
