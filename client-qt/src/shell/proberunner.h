#ifndef CLIENT_QT_SHELL_PROBERUNNER_H
#define CLIENT_QT_SHELL_PROBERUNNER_H

// Server probe - the injection point (phase 77 step5). The runner that really asks
// GET <origin>/api/health is net::HttpProbeRunner (step7), and that is what the composition root
// injects; the stand-in below stays for tests and says, loudly, that it is one.
//
// probeOrigin() is the port of client/main.js:188-200 and owns the rule the pure verdict module
// could not lock (port spec R26): the redirect-promoted origin is used ONLY when the verdict is a
// success. A captive portal or an error page that redirects must never rewrite the address the
// user typed.
//
// The canonical design is also inherited: a probe runs on a user action and only then
// (client/main.js:8, scripts/verify-client.mjs:8-9). Nothing on the boot path calls this.

#include "shell/serverurl.h"

#include <QString>

namespace shell {

class Diag;

class ProbeRunner
{
public:
    virtual ~ProbeRunner();

    // One health round trip. *finalUrl: the URL the transport finally reached after following
    // redirects - left null when nothing was observed (then no promotion is possible).
    virtual HealthVerdict probe(const QString &origin, QString *finalUrl) = 0;

    // Non-empty while this runner is a stand-in rather than a transport. The setup screen shows
    // it verbatim, so the day a real runner is injected the warning disappears by itself instead
    // of lingering as a lie in a label nobody remembers to delete.
    virtual QString limitationNotice() const;
};

// step5's stand-in (the composition root injected it until step7). It sends nothing and answers
// unreachable every time - never ok, never a guess. Its notice says so on the setup screen.
class UnimplementedProbeRunner : public ProbeRunner
{
public:
    HealthVerdict probe(const QString &origin, QString *finalUrl) override;
    QString limitationNotice() const override;

    int callCount() const;

private:
    int m_calls = 0;
};

struct ProbeOutcome {
    bool ok = false;
    QString reason;        // set only when !ok
    QString origin;        // the requested origin, or the promoted one (success only)
    bool promoted = false;
};

// run -> verdict -> promote only on success (R26) -> exactly one "probe" diag line with the
// canonical payload {origin, ok, finalOrigin, promoted[, reason]}.
ProbeOutcome probeOrigin(ProbeRunner &runner, Diag &diag, const QString &origin);

} // namespace shell

#endif // CLIENT_QT_SHELL_PROBERUNNER_H
