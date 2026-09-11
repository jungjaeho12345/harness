#include "ui/logincontroller.h"

#include "shell/diag.h"

#include <QJsonValue>
#include <QVariant>
#include <QVariantMap>

namespace ui {
namespace {

// One line per call: the HTTP status, or null when no answer arrived (no number is invented). The
// payload is a literal with one named field - never the result, never the input (diag.h rule 4).
void logStatus(shell::Diag *diag, const QString &event, int status)
{
    if (!diag)
        return;
    diag->log(event, QVariantMap{{QStringLiteral("status"), status >= 0 ? QVariant(status) : QVariant()}});
}

} // namespace

LoginFailure loginFailureFor(net::Outcome outcome)
{
    // Keyed by the outcome ALONE (header rule 1): the transport already classified the answer by
    // (route, status, token), and a 429's body token is "invalid-response" - the one fact that makes
    // a reason-keyed branch show the IP rate limit as a broken answer.
    switch (outcome) {
    case net::Outcome::Ok: return LoginFailure::None;
    case net::Outcome::InvalidCredentials: return LoginFailure::InvalidCredentials;
    case net::Outcome::AccountLocked: return LoginFailure::AccountLocked;
    case net::Outcome::RateLimited: return LoginFailure::RateLimited;
    case net::Outcome::Forbidden: return LoginFailure::Refused;
    case net::Outcome::NetworkError: return LoginFailure::Unreachable;
    case net::Outcome::Timeout: return LoginFailure::TimedOut;
    case net::Outcome::InvalidResponse: return LoginFailure::InvalidResponse;
    case net::Outcome::EditLockConflict:
    case net::Outcome::Unauthenticated:
    case net::Outcome::BadRequest:
    case net::Outcome::NotFound:
    case net::Outcome::Conflict:
    case net::Outcome::ServerError:
    case net::Outcome::Unavailable:
    case net::Outcome::Unclassified:
        return LoginFailure::Unexpected;
    }
    return LoginFailure::Unexpected;
}

QString loginFailureMessage(LoginFailure failure, int status)
{
    // One sentence per remedy. The account lock and the IP limit never share one (override L142):
    // the first is about THIS ACCOUNT (the right password is refused too, until the lock expires or an
    // administrator lifts it), the second about THIS MACHINE (any account, until the window passes).
    // No server policy numbers here - the server owns them and may change them.
    switch (failure) {
    case LoginFailure::None:
        return QString();
    case LoginFailure::InvalidCredentials:
        return QStringLiteral("아이디 또는 암호가 올바르지 않습니다.");
    case LoginFailure::AccountLocked:
        return QStringLiteral("계정이 잠겼습니다. 로그인 실패가 반복되어 이 계정은 당분간 로그인할 수 없습니다"
                              "(올바른 암호도 거부됩니다). 잠시 후 다시 시도하거나 관리자에게 문의하세요.");
    case LoginFailure::RateLimited:
        return QStringLiteral("이 컴퓨터(IP)에서 로그인 시도가 너무 많습니다. 계정과 관계없이 잠시 뒤에 다시 시도하세요.");
    case LoginFailure::Refused:
        return QStringLiteral("서버가 이 계정의 로그인을 거부했습니다(사용 중지된 계정 등). 관리자에게 문의하세요.");
    case LoginFailure::Unreachable:
        return QStringLiteral("서버에 연결하지 못했습니다. 네트워크와 서버 주소를 확인하세요.");
    case LoginFailure::TimedOut:
        return QStringLiteral("서버 응답이 제한 시간 안에 오지 않았습니다. 잠시 후 다시 시도하세요.");
    case LoginFailure::InvalidResponse:
        return QStringLiteral("기사 서버의 응답이 아닙니다. 서버 주소와 네트워크(프록시·인증 페이지)를 확인하세요.");
    case LoginFailure::Unexpected:
        return status >= 0 ? QStringLiteral("로그인하지 못했습니다(HTTP %1).").arg(status)
                           : QStringLiteral("로그인하지 못했습니다.");
    }
    return QString();
}

QString sessionEndedMessage()
{
    return QStringLiteral("세션이 끝났습니다. 다시 로그인하세요.");
}

QString identityLabelFrom(const QJsonObject &sessionUser)
{
    // docs/UI_GUIDE.md layout: "유저아이디 · 부서 · (권한)". Display only - nothing decides on it.
    QStringList parts;
    const QString userId = sessionUser.value(QStringLiteral("userId")).toString();
    const QString department = sessionUser.value(QStringLiteral("department")).toString();
    const QString role = sessionUser.value(QStringLiteral("role")).toString();
    if (!userId.isEmpty())
        parts << userId;
    if (!department.isEmpty())
        parts << department;
    if (!role.isEmpty())
        parts << QStringLiteral("(%1)").arg(role);
    return parts.join(QStringLiteral(" · "));
}

QStringList loginControllerDiagEvents()
{
    return {QStringLiteral("login"), QStringLiteral("session")};
}

LoginController::LoginController(net::INewsModel &model, shell::Diag *diag, QObject *parent)
    : QObject(parent), m_model(model), m_diag(diag)
{
}

LoginAttempt LoginController::login(const QString &userId, const QString &password)
{
    // The password goes to the Model and nowhere else (header rule 3). The answer's user is not
    // read at all: who we are is asked of the server when a screen is entered (rule 2).
    const net::ModelResult result = m_model.login(userId, password);

    LoginAttempt attempt;
    attempt.status = result.status;
    attempt.failure = loginFailureFor(result.outcome);
    // A 2xx is a success only when it says ok:true (the canonical's r.ok - useLoginController.js:18).
    if (attempt.failure == LoginFailure::None && !result.ok())
        attempt.failure = LoginFailure::Unexpected;
    attempt.ok = attempt.failure == LoginFailure::None;
    attempt.message = loginFailureMessage(attempt.failure, attempt.status);

    // The line first, then the signal: whoever reacts to the signal (the shell's screen change and
    // its session request) comes after login{status} in the diag.
    logStatus(m_diag, QStringLiteral("login"), attempt.status);
    if (attempt.ok)
        emit loginSucceeded();
    else
        emit loginFailed(attempt.message);
    return attempt;
}

SessionCheck LoginController::confirmSession()
{
    const net::ModelResult result = m_model.restoreSession();

    SessionCheck check;
    check.status = result.status;
    check.sessionEnded = result.outcome == net::Outcome::Unauthenticated;
    check.ok = result.outcome == net::Outcome::Ok && result.ok();
    if (check.ok) {
        check.identityLabel = identityLabelFrom(result.body.value(QStringLiteral("user")).toObject());
    } else if (check.sessionEnded) {
        check.message = sessionEndedMessage();
    } else {
        const LoginFailure failure = loginFailureFor(result.outcome);
        check.message = loginFailureMessage(failure == LoginFailure::None ? LoginFailure::Unexpected : failure,
                                            check.status);
    }
    logStatus(m_diag, QStringLiteral("session"), check.status);
    return check;
}

} // namespace ui
