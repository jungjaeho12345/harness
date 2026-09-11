#include "net/httpproberunner.h"

#include "net/httptransport.h"
#include "net/routetable.h"
#include "shell/serverurl.h"

namespace net {

HttpProbeRunner::HttpProbeRunner(shell::Diag *diag, int timeoutMs) : m_diag(diag), m_timeoutMs(timeoutMs) {}

shell::HealthVerdict HttpProbeRunner::probe(const QString &origin, QString *finalUrl)
{
    // A fresh transport - and so a fresh, empty cookie jar - per probe.
    HttpTransport transport(origin, m_diag);

    // The health row of the route table (step8) - its only consumer is this runner. Without it
    // nothing is sent (an empty path would probe the server root instead).
    const RouteSpec *health = findRoute(QStringLiteral("health"));
    if (!health) {
        if (finalUrl)
            finalUrl->clear();
        return shell::interpretHealthResponse(-1, QByteArray());
    }
    RequestSpec spec;
    spec.routeId = health->id;
    spec.method = health->method;
    spec.path = buildPath(health->id);
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
