#ifndef CLIENT_QT_NET_NEWSMODEL_H
#define CLIENT_QT_NET_NEWSMODEL_H

// The Model contract - the Qt counterpart of web/src/model/contract.js (ADR-003, phase 77 step8).
//
// 35 pure virtual methods, one per MODEL_KEYS entry, in MODEL_KEYS order. Controllers know this
// interface and nothing else (no transport, no widget), so screen logic is tested against
// FakeNewsModel without a server - the saving ADR-003 bought for the web, kept for the port.
// HttpNewsModel is the real wiring; both are under src/net.
//
// What a call answers (ModelResult):
//   - body    = what the canonical request() resolves to (web/src/model/httpModel.js:88-118): the
//               server's JSON object untouched, or {ok:false, reason:"network-error"} when no HTTP
//               answer arrived, or {ok:false, reason:"invalid-response"} when the body is not a
//               JSON object. Nothing else is ever synthesised.
//   - outcome = the transport's (route, status, token) classification. THIS is what a screen
//               branches on: login's 429 is text/html, so its body is the canonical
//               {ok:false, reason:"invalid-response"} and only outcome (RateLimited) tells an IP
//               rate limit from a broken proxy page; 'locked' is AccountLocked on login and
//               EditLockConflict on articles-lock.
//   - status  = the HTTP status, -1 without an answer.
//
// Deliberately absent (docs/news-md-overrides.md):
//   - any way to delete a user (L21 - the only "removal" is updateUser with active 'N'),
//   - any way to delete a distribution target (deactivate is the soft delete),
//   - lockerSessionId / lockerClientId in anything (L131 - no response carries them),
//   - a cached identity: restoreSession asks the server every time (L123-128, ADR-004),
//   - the session id: login's result does not carry it (decisions (6) - the cookie jar is the
//     only carrier; the token never reaches a controller, a log or a screen).

#include "net/httptransport.h"

#include <QByteArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <QVariantMap>
#include <QtGlobal>

#include <functional>
#include <memory>

namespace net {

struct ModelResult {
    Outcome outcome = Outcome::NetworkError;
    int status = -1;
    QJsonObject body;

    bool ok() const;         // body.ok === true
    QString reason() const;  // body.reason, empty when absent
};

// The canonical request()'s normalisation of one transport answer (see above).
ModelResult modelResultFrom(const HttpResponse &response);
// What a request that could not be built resolves to - the canonical's fetch-throws path.
ModelResult notSentResult();

// The handle subscribe()/subscribeLogs() return - the canonical {connected(), unsubscribe()}.
// Destroying it unsubscribes (a dropped handle must not keep calling into a dead screen).
class Subscription
{
public:
    virtual ~Subscription() = default;
    virtual bool connected() const = 0;
    virtual void unsubscribe() = 0;  // idempotent
};

// onChange(signal, filter): the signal is the invalidation {kind} only - no row data (L80). The
// filter is handed back so the controller re-queries with its own filter.
using ChangeHandler = std::function<void(const QJsonObject &signal, const QVariantMap &filter)>;
using StatusHandler = std::function<void(bool connected)>;
using LogHandler = std::function<void(const QJsonObject &record)>;

class INewsModel
{
public:
    virtual ~INewsModel() = default;

    // --- auth / session (MODEL_KEYS 1-3) -------------------------------------------------------
    virtual ModelResult login(const QString &userId, const QString &password) = 0;
    virtual ModelResult logout() = 0;
    virtual ModelResult restoreSession() = 0;

    // --- users (4-6) - no delete: deactivation is updateUser(id, {active:"N"}) ------------------
    virtual ModelResult queryUsers(const QVariantMap &filters = QVariantMap()) = 0;
    virtual ModelResult createUser(const QJsonObject &payload) = 0;
    virtual ModelResult updateUser(const QString &userId, const QJsonObject &fields) = 0;

    // --- articles / search (7-12) ----------------------------------------------------------------
    virtual ModelResult queryArticles(const QVariantMap &filters = QVariantMap()) = 0;
    virtual ModelResult getArticle(const QString &articleId) = 0;
    virtual ModelResult searchArticles(const QString &q) = 0;
    virtual ModelResult searchMedia(const QString &query, const QString &type = QString()) = 0;
    virtual ModelResult publishPhoto(const QJsonObject &payload) = 0;
    virtual ModelResult searchPhotos(const QString &q) = 0;

    // --- actions / save / edit lock (13-17) ------------------------------------------------------
    virtual ModelResult applyAction(const QString &articleId, const QString &action) = 0;
    // articleId in dto -> PUT articles-update (with clientId); none -> POST articles-create (the
    // action rides in the body only here). clientId is an EditClientId value (one per surface).
    virtual ModelResult saveArticle(const QJsonObject &dto, const QString &clientId = QString(),
                                    const QString &action = QString()) = 0;
    virtual ModelResult lockArticle(const QString &articleId, const QString &action = QString(),
                                    const QString &clientId = QString()) = 0;
    virtual ModelResult unlockArticle(const QString &articleId, const QString &clientId = QString()) = 0;
    virtual ModelResult forceUnlockArticle(const QString &articleId) = 0;

    // --- receiver config (18-20) -----------------------------------------------------------------
    virtual ModelResult queryReceiverConfig(const QVariantMap &filters = QVariantMap()) = 0;
    virtual ModelResult createReceiverConfig(const QJsonObject &entry) = 0;
    virtual ModelResult deleteReceiverConfig(qint64 id) = 0;

    // --- distribution targets (21-24) - no delete: deactivate is the soft delete ----------------
    virtual ModelResult queryDistributionTargets(const QVariantMap &filters = QVariantMap()) = 0;
    virtual ModelResult createDistributionTarget(const QJsonObject &entry) = 0;
    virtual ModelResult updateDistributionTarget(qint64 id, const QJsonObject &fields) = 0;
    virtual ModelResult deactivateDistributionTarget(qint64 id) = 0;

    // --- distribution failures / tick (25-27) ----------------------------------------------------
    virtual ModelResult queryDistributionFailures(const QVariantMap &filters = QVariantMap()) = 0;
    virtual ModelResult retryDistribution(qint64 historyId) = 0;
    virtual ModelResult runDistributionTick() = 0;

    // --- realtime (28) ---------------------------------------------------------------------------
    virtual std::unique_ptr<Subscription> subscribe(const QVariantMap &filter, ChangeHandler onChange,
                                                    StatusHandler onStatus = StatusHandler()) = 0;

    // --- history / derive / translate / upload / snapshot (29-33) --------------------------------
    virtual ModelResult queryHistory(const QString &articleId, bool sendOnly = false) = 0;
    virtual ModelResult deriveArticle(const QString &articleId, const QString &mode) = 0;
    virtual ModelResult translate(const QString &articleId, const QString &targetLang = QStringLiteral("ko")) = 0;
    virtual ModelResult uploadFile(const QString &fileName, const QByteArray &content,
                                   const QString &mimeType = QString()) = 0;
    virtual ModelResult getHistorySnapshot(const QString &articleId, qint64 historyId) = 0;

    // --- log viewer (34-35) - Z only; P4 never connects the log stream (excluded (c)) ------------
    virtual std::unique_ptr<Subscription> subscribeLogs(LogHandler onLog, StatusHandler onStatus = StatusHandler()) = 0;
    virtual ModelResult getLogsDigest() = 0;
};

// The 35 method names in MODEL_KEYS order. Each entry is compiled against INewsModel (a name that
// is not a member does not build), and the contract test compares the list with the MODEL_KEYS
// array read from web/src/model/contract.js at run time.
const QStringList &modelMethodNames();

// The canonical resolveUploadFilename (httpModel.js:43-49): a name with an extension is kept; an
// extensionless name with an image MIME type becomes pasted-<nowMs>.<ext>; anything else is sent
// as it is (the server's allowlist rejects it - no extension is invented).
QString resolveUploadFilename(const QString &name, const QString &mimeType, qint64 nowMs);

} // namespace net

#endif // CLIENT_QT_NET_NEWSMODEL_H
