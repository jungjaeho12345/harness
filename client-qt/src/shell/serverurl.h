#ifndef CLIENT_QT_SHELL_SERVERURL_H
#define CLIENT_QT_SHELL_SERVERURL_H

// Server address normalisation + health verdict - the Qt port of client/lib/serverUrl.js
// (phase 77 step2). Pure module: no network, no filesystem, no global state. The probe that
// actually performs the request lives in step5/step7; this file only decides.
//
// CRITICAL (inherited from the canonical module header): an origin is never assembled by
// slicing the input string or by regex. Everything goes through QUrl and through the one
// origin-assembly helper in serverurl.cpp, because port omission, IPv6 and unicode hosts
// silently produce a wrong origin otherwise - and that value feeds the same-origin decision
// (= which links are allowed to open in-app).
//
// Reason vocabulary of normalizeServerUrl (canonical contract):
//   empty | unsupported-scheme | invalid | credentials | no-host
// "no-host" is not produced by this port; see client-qt/README.md ("정본과의 의도적 이탈").

#include <QByteArray>
#include <QString>

#include <optional>

namespace shell {

struct NormalizedUrl {
    bool ok = false;
    QString origin;  // set only when ok
    QString reason;  // set only when !ok
};

struct FinalOrigin {
    QString origin;
    bool changed = false;
};

struct HealthVerdict {
    bool ok = false;
    QString reason;  // set only when !ok: unreachable | http-status | not-article-server
};

// Operator input (or a stored value) -> one canonical origin string. Path, query and
// fragment are always dropped.
NormalizedUrl normalizeServerUrl(const QString &input);

// origin + "/api/health". Plain concatenation, no re-parsing (canonical R12).
QString healthUrl(const QString &origin);

// Same-origin test used by the "open external links in the default browser" policy.
// fail-closed: if either side does not parse, the answer is false.
bool isSameOrigin(const QString &url, const QString &origin);

// Redirect promotion. std::nullopt = the transport observed no final URL (the canonical
// takes a non-string there). fail-safe = keep the requested origin.
FinalOrigin resolveFinalOrigin(const QString &requestedOrigin,
                               const std::optional<QString> &responseUrl);

// Pure verdict over a (status, body) pair. status < 0 means "no HTTP response at all"
// (network failure) - the transport has to map its error state onto that, and must never
// pass a real HTTP status there.
HealthVerdict interpretHealthResponse(int status, const QByteArray &body);

} // namespace shell

#endif // CLIENT_QT_SHELL_SERVERURL_H
