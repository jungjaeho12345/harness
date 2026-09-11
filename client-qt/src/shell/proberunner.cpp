#include "shell/proberunner.h"

#include "shell/diag.h"

#include <QVariantMap>

#include <optional>

namespace shell {

ProbeRunner::~ProbeRunner() = default;

QString ProbeRunner::limitationNotice() const
{
    return QString();  // a real transport has nothing to confess
}

HealthVerdict UnimplementedProbeRunner::probe(const QString &origin, QString *finalUrl)
{
    Q_UNUSED(origin);
    ++m_calls;
    if (finalUrl)
        *finalUrl = QString();  // nothing was reached, so nothing may be reported as reached
    HealthVerdict verdict;
    verdict.ok = false;
    verdict.reason = QStringLiteral("unreachable");
    return verdict;
}

QString UnimplementedProbeRunner::limitationNotice() const
{
    return QStringLiteral(
        "연결 확인 대역 러너가 주입되어 있습니다 — 실제 HTTP 러너(step7 net::HttpProbeRunner)가 아닙니다. "
        "[연결 확인]은 서버에 요청을 보내지 않고 항상 '서버에 닿지 못함(unreachable)'으로 답하며, "
        "[저장]은 연결 확인이 성공해야만 저장하므로 이 러너로는 저장되지 않습니다.");
}

int UnimplementedProbeRunner::callCount() const
{
    return m_calls;
}

ProbeOutcome probeOrigin(ProbeRunner &runner, Diag &diag, const QString &origin)
{
    QString reached;
    const HealthVerdict verdict = runner.probe(origin, &reached);

    // R26: a failed probe never promotes - an error page or a captive portal that redirected
    // must not rewrite the address the user typed (client/main.js:191-193).
    FinalOrigin resolved;
    if (verdict.ok) {
        const std::optional<QString> responseUrl =
            reached.isNull() ? std::nullopt : std::optional<QString>(reached);
        resolved = resolveFinalOrigin(origin, responseUrl);
    } else {
        resolved.origin = origin;
        resolved.changed = false;
    }

    // client/main.js:196-198 - the response URL itself never goes into the line, only the
    // resulting origin and the flag.
    QVariantMap payload;
    payload.insert(QStringLiteral("origin"), origin);
    payload.insert(QStringLiteral("ok"), verdict.ok);
    payload.insert(QStringLiteral("finalOrigin"), resolved.origin);
    payload.insert(QStringLiteral("promoted"), resolved.changed);
    if (!verdict.ok)
        payload.insert(QStringLiteral("reason"), verdict.reason);
    diag.log(QStringLiteral("probe"), payload);

    ProbeOutcome outcome;
    outcome.ok = verdict.ok;
    outcome.reason = verdict.ok ? QString() : verdict.reason;
    outcome.origin = resolved.origin;
    outcome.promoted = resolved.changed;
    return outcome;
}

} // namespace shell
