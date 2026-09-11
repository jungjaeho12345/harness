#ifndef CLIENT_QT_NET_HTTPTRANSPORT_H
#define CLIENT_QT_NET_HTTPTRANSPORT_H

// The HTTP transport - the ONE place that assembles headers, carries the session cookie,
// enforces the timeout and classifies the outcome (phase 77 step7). It is the Qt counterpart of
// request() in web/src/model/httpModel.js:88-118; two such places would split the discipline.
//
// What it inherits from the canonical:
//   - one attempt per call: no retry of any status or failure (httpModel.js:102-117)
//   - the body is parsed whatever the status; a body that is not a JSON object is flagged
//     (jsonOk=false), never guessed at (httpModel.js:110-117)
//   - Content-Type and a body ONLY when a body is given (httpModel.js:98-101)
// What it adds (native-only policy, no canonical precedent - client-qt/README.md):
//   - a hard deadline on every request (fetch has none; a hung server hung the page)
//   - the classification below, keyed by (route, status, token) - never by the token alone
//   - x-edit-client enforced by ROUTE here, not by caller data flow as on the web
//   - session disposal on 401 + "unauthenticated" and on nothing else
// What it refuses (index.json decisions (6)(7), step7.md 금지사항):
//   - an x-session-id header path (the cookie jar is the only carrier)
//   - Origin / Referer headers (both absent = server-to-server; a wrong one = 403 forbidden-origin)
//   - persisting the cookie (the jar is memory only: restarting the app means logging in again)
//   - caching any response (identity is re-derived by the server on every request - ADR-004)

#include <QByteArray>
#include <QJsonObject>
#include <QSet>
#include <QString>
#include <QVariantMap>
#include <QtGlobal>

#include <memory>
#include <optional>

class QNetworkAccessManager;

namespace shell {
class Diag;
} // namespace shell

namespace net {

// What happened to one request, as the layers above need to tell it apart. The key is
// (route, status, token): 'locked' is a 423 account lock on login and a 401 edit-lock conflict
// on articles-lock, and login's 429 carries no token at all (its body is text/html).
enum class Outcome {
    Ok,                 // 2xx with a JSON object (its own "ok" is the Model's to read)
    NetworkError,       // no HTTP response: refused, reset, DNS, or a request that could not be built
    Timeout,            // no complete HTTP response before the deadline
    RateLimited,        // 429 - decided by the status alone, before the body is looked at
    AccountLocked,      // (login, 423, locked)
    EditLockConflict,   // (articles-lock, 401, locked) - the session is fine
    Unauthenticated,    // 401 + unauthenticated - the ONLY outcome that discards the session
    InvalidCredentials, // (login, 401, invalid-credentials)
    BadRequest,         // 400
    Forbidden,          // 403
    NotFound,           // 404
    Conflict,           // 409
    ServerError,        // 500
    Unavailable,        // 503
    InvalidResponse,    // the body is not a JSON object (proxy page, portal, empty body)
    Unclassified        // a JSON answer this table does not name - status + reason are still there
};

QString outcomeName(Outcome outcome);

// The pure classification. Order is the contract: (1) status that needs no body (429),
// (2) no JSON envelope -> InvalidResponse, (3) the (route, status, token) triples, (4) status
// buckets. Transport failures never reach this function (they have no status).
Outcome classifyResponse(const QString &routeId, int status, bool jsonOk, const QString &reason);

// The three routes on which the server reads x-edit-client (server/index.js 932 / 961 / 974 =
// articles-update / articles-lock / articles-unlock). Everywhere else the header is NOT sent,
// even when a value is supplied. Since step8 the set is DERIVED from the route table's
// sendsEditClient column (net/routetable.h) - the table is the one source.
const QSet<QString> &editClientRouteIds();
bool sendsEditClient(const QString &routeId);

enum class RedirectPolicy {
    SameOriginOnly,        // API calls: follow a redirect only to the same scheme/host/port
    FollowUnlessDowngrade  // the health probe: follow like the canonical, except https -> http
};

constexpr int kDefaultTimeoutMs = 15000;
// Never an infinite wait: anything below 1 ms becomes the default.
int effectiveTimeoutMs(int requested);

struct RequestSpec {
    QString routeId;                    // endpoints.json id - the diag carries this, never the path
    QString method = QStringLiteral("GET");
    QString path;                       // already encoded by the caller ("/api/articles/AKR1/lock")
    std::optional<QJsonObject> body;    // nullopt = no Content-Type, no body / {} = "{}" is sent
    QVariantMap query;                  // serialised with buildQuery()
    QString editClientId;               // sent only on editClientRouteIds() and only when non-empty
    int timeoutMs = kDefaultTimeoutMs;
    RedirectPolicy redirects = RedirectPolicy::SameOriginOnly;
};

struct HttpResponse {
    int status = -1;          // -1 = no HTTP response (NetworkError / Timeout)
    QByteArray body;
    QJsonObject json;
    bool jsonOk = false;      // the body parsed as a JSON object
    QString reason;           // the server's own token; empty when there is none (never invented here)
    Outcome outcome = Outcome::NetworkError;
    QString finalUrl;         // the URL that answered, after redirects; empty without a response
};

class HttpTransport
{
public:
    // origin: a normalised origin (shell::normalizeServerUrl), no trailing slash. diag may be null.
    HttpTransport(const QString &origin, shell::Diag *diag);
    ~HttpTransport();
    HttpTransport(const HttpTransport &) = delete;
    HttpTransport &operator=(const HttpTransport &) = delete;

    // Synchronous: waits in a local event loop that excludes user input (no re-entrant clicks).
    // Writes exactly one net-request{route,method,status,ms} diag line per call.
    HttpResponse send(const RequestSpec &spec);

    // Forget every cookie (logout; also done by send() itself on 401 + unauthenticated).
    void clearSession();

    QString origin() const;

private:
    void logRequest(const RequestSpec &spec, const HttpResponse &response, qint64 elapsedMs);

    QString m_origin;
    shell::Diag *m_diag = nullptr;
    std::unique_ptr<QNetworkAccessManager> m_manager;
};

} // namespace net

#endif // CLIENT_QT_NET_HTTPTRANSPORT_H
