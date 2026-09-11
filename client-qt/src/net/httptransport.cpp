#include "net/httptransport.h"

#include "net/querystring.h"
#include "net/routetable.h"
#include "shell/diag.h"

#include <QElapsedTimer>
#include <QEventLoop>
#include <QJsonDocument>
#include <QJsonParseError>
#include <QJsonValue>
#include <QNetworkAccessManager>
#include <QNetworkCookieJar>
#include <QNetworkReply>
#include <QNetworkRequest>
#include <QObject>
#include <QTimer>
#include <QUrl>
#include <QVariant>
#include <QVariantMap>

#include <chrono>
#include <memory>

namespace net {
namespace {

QNetworkRequest::RedirectPolicy qtRedirectPolicy(RedirectPolicy policy)
{
    // Explicit on every request - Qt's default (NoLessSafeRedirectPolicy since Qt 6) is not
    // trusted, and the two paths want different things (README "리다이렉트 정책").
    return policy == RedirectPolicy::FollowUnlessDowngrade ? QNetworkRequest::NoLessSafeRedirectPolicy
                                                           : QNetworkRequest::SameOriginRedirectPolicy;
}

} // namespace

QString outcomeName(Outcome outcome)
{
    switch (outcome) {
    case Outcome::Ok: return QStringLiteral("Ok");
    case Outcome::NetworkError: return QStringLiteral("NetworkError");
    case Outcome::Timeout: return QStringLiteral("Timeout");
    case Outcome::RateLimited: return QStringLiteral("RateLimited");
    case Outcome::AccountLocked: return QStringLiteral("AccountLocked");
    case Outcome::EditLockConflict: return QStringLiteral("EditLockConflict");
    case Outcome::Unauthenticated: return QStringLiteral("Unauthenticated");
    case Outcome::InvalidCredentials: return QStringLiteral("InvalidCredentials");
    case Outcome::BadRequest: return QStringLiteral("BadRequest");
    case Outcome::Forbidden: return QStringLiteral("Forbidden");
    case Outcome::NotFound: return QStringLiteral("NotFound");
    case Outcome::Conflict: return QStringLiteral("Conflict");
    case Outcome::ServerError: return QStringLiteral("ServerError");
    case Outcome::Unavailable: return QStringLiteral("Unavailable");
    case Outcome::InvalidResponse: return QStringLiteral("InvalidResponse");
    case Outcome::Unclassified: return QStringLiteral("Unclassified");
    }
    return QStringLiteral("Unclassified");
}

Outcome classifyResponse(const QString &routeId, int status, bool jsonOk, const QString &reason)
{
    // (1) The status that needs no body. loginLimiter has no custom handler, so its 429 is
    //     express-rate-limit's text/html page with no token (login-negative.contract.js:108-111).
    //     Looking at the body first would file it under "broken response".
    if (status == 429)
        return Outcome::RateLimited;

    // (2) No JSON object = not our server's answer (a proxy page, a portal, an empty body),
    //     whatever the status says (httpModel.js:114-117 - the canonical's invalid-response).
    if (!jsonOk)
        return Outcome::InvalidResponse;

    // (3) The (route, status, token) triples. 401 has three meanings and 'locked' two
    //     (reason-tokens.md 표1 #1·#2·#8, 표2 #1); the token alone never decides.
    if (status == 401) {
        if (reason == QLatin1String("unauthenticated"))
            return Outcome::Unauthenticated;
        if (routeId == QLatin1String("login") && reason == QLatin1String("invalid-credentials"))
            return Outcome::InvalidCredentials;
        // server/index.js:330 STATUS_BY_REASON.locked = 401 (the comment at :629 says 409 - drift).
        if (routeId == QLatin1String("articles-lock") && reason == QLatin1String("locked"))
            return Outcome::EditLockConflict;
        return Outcome::Unclassified;
    }
    if (status == 423) {
        // server/index.js:627-630 - the login route's own 423 for the account lock.
        if (routeId == QLatin1String("login") && reason == QLatin1String("locked"))
            return Outcome::AccountLocked;
        return Outcome::Unclassified;
    }

    // (4) Status buckets of a JSON answer. The body's own "ok" is the Model's to read (200 with
    //     ok:false exists - the graceful translate of reason-tokens.md 표3 #13·#14).
    if (status >= 200 && status < 300)
        return Outcome::Ok;
    switch (status) {
    case 400: return Outcome::BadRequest;
    case 403: return Outcome::Forbidden;
    case 404: return Outcome::NotFound;
    case 409: return Outcome::Conflict;
    case 500: return Outcome::ServerError;
    case 503: return Outcome::Unavailable;
    default: return Outcome::Unclassified;
    }
}

const QSet<QString> &editClientRouteIds()
{
    // Derived from the route table's sendsEditClient column (step8) - one source, not two.
    static const QSet<QString> ids = [] {
        QSet<QString> fromTable;
        for (const RouteSpec &route : routeTable()) {
            if (route.sendsEditClient)
                fromTable.insert(route.id);
        }
        return fromTable;
    }();
    return ids;
}

bool sendsEditClient(const QString &routeId)
{
    return editClientRouteIds().contains(routeId);
}

int effectiveTimeoutMs(int requested)
{
    return requested > 0 ? requested : kDefaultTimeoutMs;
}

HttpTransport::HttpTransport(const QString &origin, shell::Diag *diag)
    : m_origin(origin), m_diag(diag), m_manager(std::make_unique<QNetworkAccessManager>())
{
    // A plain QNetworkCookieJar keeps cookies in memory only - never a persisting subclass
    // (decisions (6): restarting the app means logging in again; divergence from the web).
    m_manager->setCookieJar(new QNetworkCookieJar(m_manager.get()));
}

HttpTransport::~HttpTransport() = default;

HttpResponse HttpTransport::send(const RequestSpec &spec)
{
    QElapsedTimer clock;
    clock.start();
    HttpResponse response;

    const QByteArray verb = spec.method.toLatin1();
    const QUrl url = QUrl::fromEncoded((m_origin + spec.path + buildQuery(spec.query)).toUtf8(), QUrl::StrictMode);
    const bool bodyNotAllowed = verb == "GET" || verb == "HEAD";
    if (!url.isValid() || (bodyNotAllowed && spec.body.has_value())) {
        // fetch() throws before sending (a GET with a body is a TypeError) and the canonical
        // turns that into network-error (httpModel.js:105-108). Nothing leaves the process.
        response.outcome = Outcome::NetworkError;
        logRequest(spec, response, clock.elapsed());
        return response;
    }

    QNetworkRequest request(url);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, qtRedirectPolicy(spec.redirects));
    // No response is ever cached (ADR-004: identity is re-derived by the server on every request).
    request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
    request.setAttribute(QNetworkRequest::CacheSaveControlAttribute, false);
    // decisions (3): by ROUTE, not by "a value was supplied" (the web's request() tags any route).
    if (sendsEditClient(spec.routeId) && !spec.editClientId.isEmpty())
        request.setRawHeader("x-edit-client", spec.editClientId.toUtf8());

    QNetworkReply *reply = nullptr;
    if (verb == "GET") {
        reply = m_manager->get(request);
    } else if (!spec.body.has_value()) {
        // httpModel.js:98-101: no body -> neither Content-Type nor body bytes. No upload device at
        // all, so Qt has nothing to describe (post() would invent a form Content-Type).
        reply = m_manager->sendCustomRequest(request, verb);
    } else {
        request.setHeader(QNetworkRequest::ContentTypeHeader, QByteArrayLiteral("application/json"));
        reply = m_manager->sendCustomRequest(request, verb, QJsonDocument(*spec.body).toJson(QJsonDocument::Compact));
    }

    // The deadline is the whole exchange, not idle time: fetch has none and a hung server hung the
    // page; here nothing waits longer than effectiveTimeoutMs().
    bool timedOut = false;
    QEventLoop loop;
    QTimer deadline;
    deadline.setSingleShot(true);
    QObject::connect(&deadline, &QTimer::timeout, &loop, [&timedOut, reply] {
        timedOut = true;
        reply->abort();
    });
    QObject::connect(reply, &QNetworkReply::finished, &loop, &QEventLoop::quit);
    deadline.start(effectiveTimeoutMs(spec.timeoutMs));
    if (!reply->isFinished())
        loop.exec(QEventLoop::ExcludeUserInputEvents);  // no re-entrant clicks while waiting
    deadline.stop();

    const QVariant status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute);
    if (timedOut) {
        response.outcome = Outcome::Timeout;
    } else if (!status.isValid()) {
        // Never reached a server. reply->errorString() is NOT copied anywhere (httpModel.js:106-107:
        // no status, URL, message or stack in the result).
        response.outcome = Outcome::NetworkError;
    } else {
        response.status = status.toInt();
        response.body = reply->readAll();
        response.finalUrl = reply->url().toString(QUrl::FullyEncoded);
        QJsonParseError parseError;
        const QJsonDocument document = QJsonDocument::fromJson(response.body, &parseError);
        response.jsonOk = parseError.error == QJsonParseError::NoError && document.isObject();
        if (response.jsonOk) {
            response.json = document.object();
            const QJsonValue reason = response.json.value(QStringLiteral("reason"));
            if (reason.isString())
                response.reason = reason.toString();
        }
        response.outcome = classifyResponse(spec.routeId, response.status, response.jsonOk, response.reason);
    }
    reply->deleteLater();

    // step7.md: the session goes on 401 + unauthenticated and on nothing else - an edit-lock
    // conflict is also a 401, and dropping the session there would log the user out. No retry
    // and no automatic re-login follow: the caller sees Unauthenticated and goes to the login screen.
    if (response.outcome == Outcome::Unauthenticated)
        clearSession();

    logRequest(spec, response, clock.elapsed());
    return response;
}

void HttpTransport::clearSession()
{
    // The manager deletes the old jar (it is its child) and starts from an empty one.
    m_manager->setCookieJar(new QNetworkCookieJar(m_manager.get()));
}

QNetworkReply *HttpTransport::openStream(const RequestSpec &spec)
{
    QElapsedTimer clock;
    clock.start();
    const QUrl url = QUrl::fromEncoded((m_origin + spec.path + buildQuery(spec.query)).toUtf8(), QUrl::StrictMode);
    if (!url.isValid() || spec.method.toLatin1() != "GET" || spec.body.has_value()) {
        logLine(spec.routeId, spec.method, -1, clock.elapsed());
        return nullptr;
    }

    QNetworkRequest request(url);
    request.setAttribute(QNetworkRequest::RedirectPolicyAttribute, qtRedirectPolicy(spec.redirects));
    request.setAttribute(QNetworkRequest::CacheLoadControlAttribute, QNetworkRequest::AlwaysNetwork);
    request.setAttribute(QNetworkRequest::CacheSaveControlAttribute, false);
    // What EventSource sends (WHATWG). The server does not read it; a proxy in between may.
    request.setRawHeader("Accept", "text/event-stream");
    // The one request whose body has no deadline (step7 R13's exception): an idle stream is silent
    // for hours. Explicit, so a manager-wide transfer timeout set later cannot cut it.
    request.setTransferTimeout(std::chrono::milliseconds::zero());
    if (sendsEditClient(spec.routeId) && !spec.editClientId.isEmpty())
        request.setRawHeader("x-edit-client", spec.editClientId.toUtf8());

    QNetworkReply *reply = m_manager->get(request);

    // Exactly one net-request line: at the head (the status is known), or when the reply ends
    // without one (refused, reset, aborted before the head - status null, as send() writes it).
    const auto logged = std::make_shared<bool>(false);
    const QString route = spec.routeId;
    const QString method = spec.method;
    const auto logOnce = [this, reply, logged, clock, route, method] {
        if (*logged)
            return;
        *logged = true;
        const QVariant status = reply->attribute(QNetworkRequest::HttpStatusCodeAttribute);
        logLine(route, method, status.isValid() ? status.toInt() : -1, clock.elapsed());
    };
    QObject::connect(reply, &QNetworkReply::metaDataChanged, reply, [reply, logOnce] {
        if (reply->attribute(QNetworkRequest::HttpStatusCodeAttribute).isValid())
            logOnce();
    });
    QObject::connect(reply, &QNetworkReply::finished, reply, logOnce);
    return reply;
}

QString HttpTransport::origin() const
{
    return m_origin;
}

shell::Diag *HttpTransport::diag() const
{
    return m_diag;
}

void HttpTransport::logRequest(const RequestSpec &spec, const HttpResponse &response, qint64 elapsedMs)
{
    logLine(spec.routeId, spec.method, response.status, elapsedMs);
}

void HttpTransport::logLine(const QString &routeId, const QString &method, int status, qint64 elapsedMs)
{
    if (!m_diag)
        return;
    // Named fields only (diag.h: never hand a whole request/response to log()). The route is its
    // id - a concrete path would keep its article id (diag redaction is fail-open on relative
    // paths), and a query value could be a headline.
    QVariantMap payload;
    payload.insert(QStringLiteral("route"), routeId);
    payload.insert(QStringLiteral("method"), method);
    payload.insert(QStringLiteral("status"), status >= 0 ? QVariant(status) : QVariant());
    payload.insert(QStringLiteral("ms"), elapsedMs);
    m_diag->log(QStringLiteral("net-request"), payload);
}

} // namespace net
