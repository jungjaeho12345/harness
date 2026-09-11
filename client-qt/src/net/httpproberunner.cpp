#include "net/httpproberunner.h"

#include "net/httptransport.h"
#include "shell/serverurl.h"

namespace net {

HttpProbeRunner::HttpProbeRunner(shell::Diag *diag, int timeoutMs) : m_diag(diag), m_timeoutMs(timeoutMs) {}

shell::HealthVerdict HttpProbeRunner::probe(const QString &origin, QString *finalUrl)
{
    // A fresh transport - and so a fresh, empty cookie jar - per probe.
    HttpTransport transport(origin, m_diag);

    RequestSpec spec;
    spec.routeId = QStringLiteral("health");  // endpoints.json id; path = shell::healthUrl() minus origin
    spec.method = QStringLiteral("GET");
    spec.path = QStringLiteral("/api/health");
    spec.timeoutMs = m_timeoutMs;
    spec.redirects = RedirectPolicy::FollowUnlessDowngrade;  // a proxy/https redirect is followed (main.js:231-233)
    const HttpResponse response = transport.send(spec);

    // Only an arrival counts as "reached": no HTTP response = nothing observed = no promotion.
    if (finalUrl)
        *finalUrl = response.status >= 0 ? response.finalUrl : QString();
    // status -1 is interpretHealthResponse's "no HTTP response at all" (step2 README 이탈 6).
    return shell::interpretHealthResponse(response.status, response.body);
}

} // namespace net
