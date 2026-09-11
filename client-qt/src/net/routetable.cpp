#include "net/routetable.h"

#include <QByteArray>
#include <QLatin1Char>
#include <QStringList>
#include <QVariant>

namespace net {
namespace {

RouteSpec row(const char *id, const char *method, const char *path, const char *auth, const char *consumer,
              bool hasBody, bool sendsEditClient = false, bool sse = false)
{
    RouteSpec spec;
    spec.id = QString::fromLatin1(id);
    spec.method = QString::fromLatin1(method);
    spec.pathTemplate = QString::fromLatin1(path);
    spec.auth = QString::fromLatin1(auth);
    spec.consumer = QString::fromLatin1(consumer);
    spec.hasBody = hasBody;
    spec.sendsEditClient = sendsEditClient;
    spec.sse = sse;
    return spec;
}

constexpr bool kBody = true;
constexpr bool kNoBody = false;
constexpr bool kEditClient = true;
constexpr bool kSse = true;

// encodeURIComponent's unreserved set: A-Z a-z 0-9 - _ . ! ~ * ' ( )
bool keptBySegmentEncoding(uchar c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_'
        || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')';
}

} // namespace

QString probeRunnerConsumer()
{
    return QStringLiteral("ProbeRunner");
}

// Contract order (docs/api-contract/endpoints.json) minus the two forbidden rows. Every string on
// a row is checked against that file at test time (tests/routecontracttest.cpp C-1..C-7).
const QVector<RouteSpec> &routeTable()
{
    static const QVector<RouteSpec> rows{
        row("health", "GET", "/api/health", "public", "ProbeRunner", kNoBody),
        row("login", "POST", "/api/login", "public", "login", kBody),
        row("logout", "POST", "/api/logout", "public", "logout", kNoBody),
        row("session", "GET", "/api/session", "session", "restoreSession", kNoBody),
        row("users-list", "GET", "/api/users", "session", "queryUsers", kNoBody),
        row("users-create", "POST", "/api/users", "admin", "createUser", kBody),
        row("users-update", "PUT", "/api/users/:id", "admin", "updateUser", kBody),
        row("receiver-config-list", "GET", "/api/receiver-config", "admin", "queryReceiverConfig", kNoBody),
        row("receiver-config-create", "POST", "/api/receiver-config", "admin", "createReceiverConfig", kBody),
        row("receiver-config-delete", "DELETE", "/api/receiver-config/:id", "admin", "deleteReceiverConfig", kNoBody),
        row("distribution-targets-list", "GET", "/api/distribution-targets", "admin", "queryDistributionTargets", kNoBody),
        row("distribution-targets-create", "POST", "/api/distribution-targets", "admin", "createDistributionTarget", kBody),
        row("distribution-targets-update", "PUT", "/api/distribution-targets/:id", "admin", "updateDistributionTarget",
            kBody),
        row("distribution-targets-deactivate", "POST", "/api/distribution-targets/:id/deactivate", "admin",
            "deactivateDistributionTarget", kNoBody),
        row("distribution-tick", "POST", "/api/distribution/tick", "admin", "runDistributionTick", kNoBody),
        row("distribution-failures", "GET", "/api/distribution/failures", "admin", "queryDistributionFailures", kNoBody),
        row("distribution-retry", "POST", "/api/distribution/retry", "admin", "retryDistribution", kBody),
        row("articles-search", "GET", "/api/articles/search", "session", "searchArticles", kNoBody),
        row("articles-list", "GET", "/api/articles", "session", "queryArticles", kNoBody),
        row("articles-get", "GET", "/api/articles/:id", "session", "getArticle", kNoBody),
        row("articles-history", "GET", "/api/articles/:id/history", "session", "queryHistory", kNoBody),
        row("articles-history-snapshot", "GET", "/api/articles/:id/history/:historyId", "session", "getHistorySnapshot",
            kNoBody),
        row("articles-create", "POST", "/api/articles", "session-role", "saveArticle", kBody),
        row("articles-action", "POST", "/api/articles/:id/action", "session-role", "applyAction", kBody),
        row("articles-derive", "POST", "/api/articles/:id/derive", "session-role", "deriveArticle", kBody),
        row("articles-translate", "POST", "/api/articles/:id/translate", "session", "translate", kBody),
        row("articles-update", "PUT", "/api/articles/:id", "lock-holder", "saveArticle", kBody, kEditClient),
        row("articles-lock", "POST", "/api/articles/:id/lock", "session", "lockArticle", kBody, kEditClient),
        row("articles-unlock", "POST", "/api/articles/:id/unlock", "lock-holder", "unlockArticle", kNoBody, kEditClient),
        row("articles-force-unlock", "POST", "/api/articles/:id/force-unlock", "session-role", "forceUnlockArticle",
            kNoBody),
        row("media-search", "GET", "/api/media/search", "session", "searchMedia", kNoBody),
        row("upload", "POST", "/api/upload", "session", "uploadFile", kBody),
        row("photos-create", "POST", "/api/photos", "session", "publishPhoto", kBody),
        row("photos-search", "GET", "/api/photos/search", "session", "searchPhotos", kNoBody),
        row("stream", "GET", "/api/stream", "session", "subscribe", kNoBody, false, kSse),
        row("logs-digest", "GET", "/api/logs/digest", "admin", "getLogsDigest", kNoBody),
        row("logs-stream", "GET", "/api/logs/stream", "admin", "subscribeLogs", kNoBody, false, kSse),
    };
    return rows;
}

// Server-to-server token routes (excluded (i)). Policy, not a route list: the contract test
// checks both ids exist in endpoints.json, so a typo cannot forbid nothing.
const QSet<QString> &forbiddenRouteIds()
{
    static const QSet<QString> ids{QStringLiteral("collection-receive"), QStringLiteral("collection-pull")};
    return ids;
}

const RouteSpec *findRoute(const QString &routeId)
{
    if (forbiddenRouteIds().contains(routeId))
        return nullptr;
    for (const RouteSpec &spec : routeTable()) {
        if (spec.id == routeId)
            return &spec;
    }
    return nullptr;
}

QVector<RouteSpec> routesOf(const QString &consumer)
{
    QVector<RouteSpec> rows;
    if (consumer.isEmpty())
        return rows;
    for (const RouteSpec &spec : routeTable()) {
        if (spec.consumer == consumer)
            rows << spec;
    }
    return rows;
}

QString encodePathSegment(const QString &value)
{
    static const char hex[] = "0123456789ABCDEF";
    const QByteArray utf8 = value.toUtf8();
    QString out;
    out.reserve(utf8.size() * 3);
    for (const char ch : utf8) {
        const uchar c = static_cast<uchar>(ch);
        if (keptBySegmentEncoding(c)) {
            out += QLatin1Char(static_cast<char>(c));
        } else {
            out += QLatin1Char('%');
            out += QLatin1Char(hex[c >> 4]);
            out += QLatin1Char(hex[c & 0x0F]);
        }
    }
    return out;
}

QString buildPath(const QString &routeId, const QVariantMap &params)
{
    const RouteSpec *spec = findRoute(routeId);
    if (!spec)
        return QString();
    QStringList segments = spec->pathTemplate.split(QLatin1Char('/'));
    for (QString &segment : segments) {
        if (!segment.startsWith(QLatin1Char(':')))
            continue;
        const QVariant value = params.value(segment.mid(1));
        const QString text = value.isValid() && !value.isNull() ? value.toString() : QString();
        // "", "." and ".." would move the request to another route: /api/articles/ is the list,
        // /api/articles/.. is a dot segment. Refuse - the caller sends nothing.
        if (text.isEmpty() || text == QLatin1String(".") || text == QLatin1String(".."))
            return QString();
        segment = encodePathSegment(text);
    }
    return segments.join(QLatin1Char('/'));
}

} // namespace net
