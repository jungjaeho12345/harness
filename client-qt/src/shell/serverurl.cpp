#include "shell/serverurl.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QLatin1Char>
#include <QLatin1String>
#include <QRegularExpression>
#include <QRegularExpressionMatch>
#include <QUrl>

namespace shell {
namespace {

// client/lib/serverUrl.js:6 - the scheme sniffer, character class for character class.
const QRegularExpression &schemeRe()
{
    static const QRegularExpression re(QStringLiteral("^([a-zA-Z][a-zA-Z0-9+.-]*):"));
    return re;
}

// client/lib/serverUrl.js:18 - the "host:port" heuristic (/^\d+([/?#]|$)/). [0-9] is spelled
// out on purpose: JS \d is ASCII-only, while PCRE \d would start matching other digit scripts
// the moment somebody adds UseUnicodePropertiesOption here.
const QRegularExpression &hostPortRestRe()
{
    static const QRegularExpression re(QStringLiteral("^[0-9]+([/?#]|$)"));
    return re;
}

bool isAllowedScheme(const QString &scheme)
{
    return scheme == QLatin1String("http") || scheme == QLatin1String("https");
}

int defaultPortFor(const QString &scheme)
{
    if (scheme == QLatin1String("http"))
        return 80;
    if (scheme == QLatin1String("https"))
        return 443;
    return -1;  // unknown scheme: no port is implied, so an explicit one is always spelled out
}

// Origin assembly, the half of parseUrlParts() this file was built around (X3). QUrl has no
// origin accessor, so the spelling is built by hand exactly once: every entry point here and
// in shell/diag.cpp goes through it. A second builder would make the same origin come out two
// ways and split the same-origin decision.
//
// Contract: scheme (lowercase) + "://" + host (IPv6 keeps its brackets) + ":" port, the port
// only when it differs from the scheme default. Returns false when the string is not a usable
// absolute URL WITH a host - that is this port's replacement for `new URL()` throwing (X2-a).
bool parsedOrigin(const QString &text, QString *origin, QString *scheme)
{
    const UrlParts parts = parseUrlParts(text);
    if (!parts.ok || !parts.hasHost)
        return false;
    if (origin)
        *origin = parts.origin;
    if (scheme)
        *scheme = parts.scheme;
    return true;
}

// client/lib/serverUrl.js:36 + :74 - one predicate for both credential checks, so the
// normalisation contract and the redirect contract can never drift apart.
bool hasCredentials(const QUrl &url)
{
    return !url.userName().isEmpty() || !url.password().isEmpty();
}

// client/lib/serverUrl.js:79-85 - fail-open-to-general-rule: if the requested origin does not
// parse, the "no downgrade" test simply does not apply (the general promotion rule wins).
// Do NOT turn this into fail-closed: it is the one helper in this file that leans open.
bool isHttpsOrigin(const QString &origin)
{
    QString scheme;
    if (!parsedOrigin(origin, nullptr, &scheme))
        return false;
    return scheme == QLatin1String("https");
}

NormalizedUrl rejected(const QString &reason)
{
    NormalizedUrl result;
    result.ok = false;
    result.reason = reason;
    return result;
}

// client/lib/serverUrl.js:12-20 - scheme repair. Operators type "192.168.0.10:3001", and
// "localhost:3001" looks like a scheme to every URL parser (QUrl reads it exactly the same
// way), so a numeric rest after the colon means host:port. Returns false for a scheme that is
// neither allowed nor a host:port mis-read.
bool ensureScheme(const QString &input, QString *out)
{
    const QRegularExpressionMatch match = schemeRe().match(input);
    if (!match.hasMatch()) {
        *out = QStringLiteral("http://") + input;
        return true;
    }
    if (isAllowedScheme(match.captured(1).toLower())) {
        *out = input;
        return true;
    }
    const QString rest = input.mid(match.capturedLength(0));
    if (hostPortRestRe().match(rest).hasMatch()) {
        *out = QStringLiteral("http://") + input;  // host:port mis-read, prefix the whole input
        return true;
    }
    return false;
}

} // namespace

UrlParts parseUrlParts(const QString &text)
{
    UrlParts parts;
    const QUrl url(text, QUrl::StrictMode);
    if (!url.isValid())
        return parts;

    parts.scheme = url.scheme().toLower();
    if (parts.scheme.isEmpty())
        return parts;  // relative reference ("garbage", "not a url", "", "/api/articles/5")
    parts.ok = true;
    parts.path = url.path(QUrl::FullyEncoded);

    // FullyEncoded keeps an internationalised host in its ACE/punycode form, which is what
    // url.origin gives in the canonical (measured: http://<hangul>.com -> xn--bj0bj06e.com).
    QString host = url.host(QUrl::FullyEncoded);
    if (host.isEmpty())
        return parts;  // "http://", "http://:3001", "mailto:user@h", "data:text/plain,x"
    parts.hasHost = true;
    if (host.contains(QLatin1Char(':')) && !host.startsWith(QLatin1Char('[')))
        host = QStringLiteral("[") + host + QStringLiteral("]");  // IPv6 literal

    parts.origin = parts.scheme + QStringLiteral("://") + host;
    const int port = url.port();  // -1 when absent; 0 is a real, explicitly written port
    if (port != -1 && port != defaultPortFor(parts.scheme)) {
        parts.origin += QLatin1Char(':');
        parts.origin += QString::number(port);
    }
    return parts;
}

NormalizedUrl normalizeServerUrl(const QString &input)
{
    const QString trimmed = input.trimmed();
    if (trimmed.isEmpty())
        return rejected(QStringLiteral("empty"));

    QString withScheme;
    if (!ensureScheme(trimmed, &withScheme))
        return rejected(QStringLiteral("unsupported-scheme"));

    const QUrl url(withScheme, QUrl::StrictMode);

    // Defence in depth (canonical R8): unreachable, because ensureScheme() either kept an
    // http/https input or prefixed one. Kept anyway - the predicate it shares with
    // resolveFinalOrigin is what the ftp/file/data/chrome-error rows exercise.
    if (url.isValid() && !isAllowedScheme(url.scheme().toLower()))
        return rejected(QStringLiteral("unsupported-scheme"));

    // Credentials are checked before the origin is built: "http://user@h:3001" parses fine,
    // and the point is to keep credentials out of the stored address entirely.
    if (url.isValid() && hasCredentials(url))
        return rejected(QStringLiteral("credentials"));

    QString origin;
    if (!parsedOrigin(withScheme, &origin, nullptr))
        return rejected(QStringLiteral("invalid"));

    NormalizedUrl result;
    result.ok = true;
    result.origin = origin;  // path, query and fragment are gone by construction
    return result;
}

QString healthUrl(const QString &origin)
{
    return origin + QStringLiteral("/api/health");
}

bool isSameOrigin(const QString &url, const QString &origin)
{
    QString left;
    QString right;
    if (!parsedOrigin(url, &left, nullptr))
        return false;  // fail-closed
    if (!parsedOrigin(origin, &right, nullptr))
        return false;
    return left == right;
}

FinalOrigin resolveFinalOrigin(const QString &requestedOrigin,
                               const std::optional<QString> &responseUrl)
{
    const FinalOrigin keep{ requestedOrigin, false };
    if (!responseUrl.has_value())
        return keep;

    QString origin;
    QString scheme;
    if (!parsedOrigin(*responseUrl, &origin, &scheme))
        return keep;
    if (!isAllowedScheme(scheme))
        return keep;
    if (hasCredentials(QUrl(*responseUrl, QUrl::StrictMode)))
        return keep;
    // Directional on purpose: http -> https is promoted two lines below, https -> http is not.
    // Making this symmetric re-opens the hole it closes (a captive portal or MITM proxy
    // flipping a stored https origin to plaintext).
    if (scheme == QLatin1String("http") && isHttpsOrigin(requestedOrigin))
        return keep;

    return FinalOrigin{ origin, origin != requestedOrigin };
}

HealthVerdict interpretHealthResponse(int status, const QByteArray &body)
{
    if (status < 0)
        return { false, QStringLiteral("unreachable") };
    if (status != 200)
        return { false, QStringLiteral("http-status") };

    // 200 alone proves nothing - any web server, corporate proxy or captive portal answers
    // 200. Only a JSON object whose "ok" is the boolean true is the article server.
    const QJsonDocument doc = QJsonDocument::fromJson(body);
    if (doc.isObject()) {
        const QJsonValue ok = doc.object().value(QStringLiteral("ok"));
        if (ok.isBool() && ok.toBool())
            return { true, QString() };
    }
    return { false, QStringLiteral("not-article-server") };
}

} // namespace shell
