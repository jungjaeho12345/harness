#ifndef CLIENT_QT_NET_FAKENEWSMODEL_H
#define CLIENT_QT_NET_FAKENEWSMODEL_H

// FakeNewsModel - the in-memory Model for controller tests and screen work without a server
// (ADR-003, phase 77 step8). The Qt counterpart of web/src/test/fakeModel.js.
//
// Discipline (each rule is locked by tests/fakenewsmodeltest.cpp):
//   1. deterministic - no wall clock, no randomness: the same seed and the same calls give the
//      same answers byte for byte (timestamps come from a counter clock, ids from a counter)
//   2. no network - this file and its header include no network or socket type at all
//   3. all 35 MODEL_KEYS methods, each answering the canonical {ok, ...} shape
//   4. user answers never carry a password (canonical stripPassword) - done as the server does it,
//      with its SAFE_FIELDS allowlist, so the lockout fields never leave either
//   5. removal is soft: deactivateDistributionTarget flips active to 'N', a user is "removed" by
//      updateUser {active:'N'}; no row disappears (the one exception is deleteReceiverConfig, which
//      removes a settings row exactly as the server does - never an article)
//   6. saveArticle drops the dto's body key before storing it (the server's ARTICLE_FIELDS pick
//      keeps the text in markupVersion only - a body-sent-as-body bug shows up here too)
// And the override ledger (docs/news-md-overrides.md):
//   - L131: no answer carries lockerSessionId / lockerClientId. The lock holder is kept apart
//     from the article rows; a seeded row's locker fields are taken in and never echoed.
//   - L123-128: identity is re-derived on every call from the current user row. restoreSession
//     reflects a role change at once, and a deactivated user's session is dropped.
//   - L21: no user deletion, no distribution-target deletion.
//
// A reduced model, like the canonical one: authorization, validation and the server's full lock
// rules are not simulated. The truth for those is the server and its contract suite.

#include "net/newsmodel.h"

#include <QHash>
#include <QJsonObject>
#include <QList>
#include <QString>

#include <memory>
#include <optional>

namespace net {

struct FakeSeed {
    QList<QJsonObject> users;                   // may carry "password" - it is never echoed
    QList<QJsonObject> articles;                // flat rows; locker fields are taken in, never echoed
    QList<QJsonObject> receiverConfigs;
    QList<QJsonObject> distributionTargets;
    QList<QJsonObject> distributionFailures;    // the server-derived "unresolved" list
    std::optional<QJsonObject> tickResult;
    QList<QJsonObject> mediaItems;
    QList<QJsonObject> photos;
    QHash<QString, QList<QJsonObject>> histories;  // articleId -> newest first
    QHash<QString, QString> translations;          // articleId -> translated text
    QList<QJsonObject> logs;
    std::optional<QList<QJsonObject>> logsDigest;
};

class FakeNewsModel : public INewsModel
{
public:
    explicit FakeNewsModel(const FakeSeed &seed = FakeSeed());
    ~FakeNewsModel() override;
    FakeNewsModel(const FakeNewsModel &) = delete;
    FakeNewsModel &operator=(const FakeNewsModel &) = delete;

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

    // Test seam: the server ends every change stream as it does for a dead session - the
    // unauthorized frame. Each subscriber hears onStatus(false) then onSessionEnd(), and its stream
    // is closed for good (no more changes, connected() false). Same order as the real stream.
    void endStreamSession();

private:
    struct State;
    std::unique_ptr<State> d;
};

} // namespace net

#endif // CLIENT_QT_NET_FAKENEWSMODEL_H
