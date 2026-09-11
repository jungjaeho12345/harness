#ifndef CLIENT_QT_NET_HTTPNEWSMODEL_H
#define CLIENT_QT_NET_HTTPNEWSMODEL_H

// The real Model - web/src/model/httpModel.js over the one transport (phase 77 step8).
//
// Every request is built from the route table: the method names a route id, and the table gives
// the HTTP method, the path template (parameters through encodePathSegment), whether a body goes
// at all, and whether x-edit-client may ride. The query goes through buildQuery (URLSearchParams
// rules - QUrlQuery leaves '+' bare and the server reads it back as a space). Nothing here spells a
// path or an HTTP method.
//
// What P4 actually drives against a server (decisions (9)): login, restoreSession, logout,
// queryArticles, subscribe (+ getArticle, optional). The other methods are assembled and locked
// against the route table on a loopback stub (tests/httpnewsmodeltest.cpp) - no P4 screen calls
// them, so a real round trip for them is NOT verified here (P5/P7 own that).
//
// SSE: subscribe() opens one ChangeStream per call on the table's "stream" row (step9 - see
// net/changestream.h for the close/reconnect discipline). subscribeLogs() stays inert for the whole
// of P4 - the log stream is Z-only and P7's.

#include "net/newsmodel.h"

#include <QVariantMap>

#include <optional>

namespace net {

class HttpNewsModel : public INewsModel
{
public:
    // transport: not owned, outlives the model. Its cookie jar is the session.
    explicit HttpNewsModel(HttpTransport *transport);

    ModelResult login(const QString &userId, const QString &password) override;
    ModelResult logout() override;
    ModelResult restoreSession() override;
    ModelResult queryUsers(const QVariantMap &filters) override;
    ModelResult createUser(const QJsonObject &payload) override;
    ModelResult updateUser(const QString &userId, const QJsonObject &fields) override;
    ModelResult queryArticles(const QVariantMap &filters) override;
    ModelResult getArticle(const QString &articleId) override;
    ModelResult searchArticles(const QString &q) override;
    ModelResult searchMedia(const QString &query, const QString &type) override;
    ModelResult publishPhoto(const QJsonObject &payload) override;
    ModelResult searchPhotos(const QString &q) override;
    ModelResult applyAction(const QString &articleId, const QString &action) override;
    ModelResult saveArticle(const QJsonObject &dto, const QString &clientId, const QString &action) override;
    ModelResult lockArticle(const QString &articleId, const QString &action, const QString &clientId) override;
    ModelResult unlockArticle(const QString &articleId, const QString &clientId) override;
    ModelResult forceUnlockArticle(const QString &articleId) override;
    ModelResult queryReceiverConfig(const QVariantMap &filters) override;
    ModelResult createReceiverConfig(const QJsonObject &entry) override;
    ModelResult deleteReceiverConfig(qint64 id) override;
    ModelResult queryDistributionTargets(const QVariantMap &filters) override;
    ModelResult createDistributionTarget(const QJsonObject &entry) override;
    ModelResult updateDistributionTarget(qint64 id, const QJsonObject &fields) override;
    ModelResult deactivateDistributionTarget(qint64 id) override;
    ModelResult queryDistributionFailures(const QVariantMap &filters) override;
    ModelResult retryDistribution(qint64 historyId) override;
    ModelResult runDistributionTick() override;
    std::unique_ptr<Subscription> subscribe(const QVariantMap &filter, ChangeHandler onChange,
                                            StatusHandler onStatus, SessionEndHandler onSessionEnd) override;
    ModelResult queryHistory(const QString &articleId, bool sendOnly) override;
    ModelResult deriveArticle(const QString &articleId, const QString &mode) override;
    ModelResult translate(const QString &articleId, const QString &targetLang) override;
    ModelResult uploadFile(const QString &fileName, const QByteArray &content, const QString &mimeType) override;
    ModelResult getHistorySnapshot(const QString &articleId, qint64 historyId) override;
    std::unique_ptr<Subscription> subscribeLogs(LogHandler onLog, StatusHandler onStatus) override;
    ModelResult getLogsDigest() override;

private:
    // The one request path: route id -> table row -> RequestSpec -> transport -> ModelResult.
    // A route that is unknown/forbidden, or a path that cannot be built, sends NOTHING.
    ModelResult call(const QString &routeId, const QVariantMap &pathParams = QVariantMap(),
                     const std::optional<QJsonObject> &body = std::nullopt,
                     const QVariantMap &query = QVariantMap(), const QString &editClientId = QString());

    HttpTransport *m_transport = nullptr;
};

} // namespace net

#endif // CLIENT_QT_NET_HTTPNEWSMODEL_H
