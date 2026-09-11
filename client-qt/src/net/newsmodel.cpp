#include "net/newsmodel.h"

#include <QHash>
#include <QJsonValue>

namespace net {
namespace {

QJsonObject failure(const QString &reason)
{
    return QJsonObject{{QStringLiteral("ok"), false}, {QStringLiteral("reason"), reason}};
}

// httpModel.js:18-19 - the two client-only tokens. Nothing else is ever synthesised.
const QString kNetworkError = QStringLiteral("network-error");
const QString kInvalidResponse = QStringLiteral("invalid-response");

// httpModel.js:31-35: an extension is "something after the last dot" (a trailing dot is none).
bool hasExtension(const QString &name)
{
    const qsizetype dot = name.lastIndexOf(QLatin1Char('.'));
    return dot >= 0 && dot < name.size() - 1;
}

} // namespace

bool ModelResult::ok() const
{
    return body.value(QStringLiteral("ok")).toBool(false);
}

QString ModelResult::reason() const
{
    return body.value(QStringLiteral("reason")).toString();
}

ModelResult modelResultFrom(const HttpResponse &response)
{
    ModelResult result;
    result.outcome = response.outcome;
    result.status = response.status;
    if (response.status < 0) {
        // No HTTP answer (refused, reset, DNS, deadline): httpModel.js:105-108 - two keys only.
        result.body = failure(kNetworkError);
    } else if (!response.jsonOk) {
        // httpModel.js:114-117 - the body cannot be trusted. login's text/html 429 lands here too;
        // its outcome (RateLimited) is what tells it apart.
        result.body = failure(kInvalidResponse);
    } else {
        // httpModel.js:110-113 - a JSON object is returned as it is, whatever the status.
        result.body = response.json;
    }
    return result;
}

ModelResult notSentResult()
{
    ModelResult result;
    result.outcome = Outcome::NetworkError;
    result.status = -1;
    result.body = failure(kNetworkError);
    return result;
}

// Each name is evaluated as &INewsModel::<name> before it becomes a string, so the list cannot
// hold a name the interface does not have (it would not compile).
#define NEWS_MODEL_METHOD(name) (static_cast<void>(&INewsModel::name), QStringLiteral(#name))

const QStringList &modelMethodNames()
{
    static const QStringList names{
        NEWS_MODEL_METHOD(login),
        NEWS_MODEL_METHOD(logout),
        NEWS_MODEL_METHOD(restoreSession),
        NEWS_MODEL_METHOD(queryUsers),
        NEWS_MODEL_METHOD(createUser),
        NEWS_MODEL_METHOD(updateUser),
        NEWS_MODEL_METHOD(queryArticles),
        NEWS_MODEL_METHOD(getArticle),
        NEWS_MODEL_METHOD(searchArticles),
        NEWS_MODEL_METHOD(searchMedia),
        NEWS_MODEL_METHOD(publishPhoto),
        NEWS_MODEL_METHOD(searchPhotos),
        NEWS_MODEL_METHOD(applyAction),
        NEWS_MODEL_METHOD(saveArticle),
        NEWS_MODEL_METHOD(lockArticle),
        NEWS_MODEL_METHOD(unlockArticle),
        NEWS_MODEL_METHOD(forceUnlockArticle),
        NEWS_MODEL_METHOD(queryReceiverConfig),
        NEWS_MODEL_METHOD(createReceiverConfig),
        NEWS_MODEL_METHOD(deleteReceiverConfig),
        NEWS_MODEL_METHOD(queryDistributionTargets),
        NEWS_MODEL_METHOD(createDistributionTarget),
        NEWS_MODEL_METHOD(updateDistributionTarget),
        NEWS_MODEL_METHOD(deactivateDistributionTarget),
        NEWS_MODEL_METHOD(queryDistributionFailures),
        NEWS_MODEL_METHOD(retryDistribution),
        NEWS_MODEL_METHOD(runDistributionTick),
        NEWS_MODEL_METHOD(subscribe),
        NEWS_MODEL_METHOD(queryHistory),
        NEWS_MODEL_METHOD(deriveArticle),
        NEWS_MODEL_METHOD(translate),
        NEWS_MODEL_METHOD(uploadFile),
        NEWS_MODEL_METHOD(getHistorySnapshot),
        NEWS_MODEL_METHOD(subscribeLogs),
        NEWS_MODEL_METHOD(getLogsDigest),
    };
    return names;
}

#undef NEWS_MODEL_METHOD

QString resolveUploadFilename(const QString &name, const QString &mimeType, qint64 nowMs)
{
    // httpModel.js:23-28 - MIME -> image extension (the server's UPLOAD_EXT_ALLOWLIST images).
    static const QHash<QString, QString> imageExtByMime{{QStringLiteral("image/png"), QStringLiteral("png")},
                                                        {QStringLiteral("image/jpeg"), QStringLiteral("jpg")},
                                                        {QStringLiteral("image/gif"), QStringLiteral("gif")},
                                                        {QStringLiteral("image/webp"), QStringLiteral("webp")}};
    if (hasExtension(name))
        return name;
    const QString ext = imageExtByMime.value(mimeType);
    if (ext.isEmpty())
        return name;  // no extension is invented - the server's allowlist rejects it
    return QStringLiteral("pasted-%1.%2").arg(nowMs).arg(ext);
}

} // namespace net
