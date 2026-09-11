#ifndef CLIENT_QT_NET_HTTPPROBERUNNER_H
#define CLIENT_QT_NET_HTTPPROBERUNNER_H

// The real server probe (phase 77 step7) - replaces step5's UnimplementedProbeRunner in the
// composition root. One GET <origin>/api/health through the one transport (route id "health"),
// verdict by shell::interpretHealthResponse, final URL after redirects for
// shell::probeOrigin's success-only promotion (R26).
//
// Canonical: requestHealthViaNet in client/main.js:209-248 - follows every redirect and records
// the last arrival, 5000 ms one-shot deadline, never rejects. Differences (README): Qt refuses to
// follow https -> http (FollowUnlessDowngrade) where the canonical follows and then declines to
// promote; either way the stored address never becomes plaintext.
//
// Every probe gets a FRESH transport, so a server the user has not chosen yet never receives a
// cookie, and nothing a candidate sets survives into the next probe.

#include "shell/proberunner.h"

namespace shell {
class Diag;
} // namespace shell

namespace net {

constexpr int kProbeTimeoutMs = 5000;  // client/main.js:224 - one-shot, never a periodic timer

class HttpProbeRunner : public shell::ProbeRunner
{
public:
    explicit HttpProbeRunner(shell::Diag *diag, int timeoutMs = kProbeTimeoutMs);

    shell::HealthVerdict probe(const QString &origin, QString *finalUrl) override;
    // limitationNotice() stays the base class's empty answer: a real transport has nothing to confess.

private:
    shell::Diag *m_diag = nullptr;
    int m_timeoutMs = kProbeTimeoutMs;
};

} // namespace net

#endif // CLIENT_QT_NET_HTTPPROBERUNNER_H
