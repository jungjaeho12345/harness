#ifndef CLIENT_QT_UI_LOGINCONTROLLER_H
#define CLIENT_QT_UI_LOGINCONTROLLER_H

// The login controller (phase 77 step10 B) - the Qt counterpart of web/src/controller/
// useLoginController.js. ADR-003: View <- Controller <- Model. It knows the Model interface and the
// diag sink and nothing else - no widget type, no transport - so every branch below is tested on
// FakeNewsModel without a server or a screen.
//
// Three rules carry the weight of this file:
//   1. FAILURES ARE TOLD APART BY THE MODEL'S OUTCOME, NEVER BY body.reason. Login's 429 is
//      express-rate-limit's text/html page, so its Model body is {ok:false, reason:"invalid-response"}
//      - the same body a broken proxy page gets. Only the outcome (RateLimited) says "IP rate limit"
//      (step8). A controller that read the reason would tell the user "the server's answer is broken"
//      when the truth is "wait, then try again". The account lock (423) and the IP limit (429) are two
//      different axes with two different remedies (override L22 / L142) and get two different sentences.
//   2. NO IDENTITY IS KEPT (decisions (7), override L123-128). The login answer's user is not stored
//      anywhere; entering the post-login screen asks the server again (GET /api/session), and the only
//      thing kept from that answer is a DISPLAY label ("user · department · (role)"). There is no role
//      truth table here - P4 has no action buttons (P7's).
//   3. NO CREDENTIAL IS KEPT OR LOGGED. The password goes to the Model and nowhere else; the diag
//      lines are login{status} and session{status} - a number, or null without an answer.

#include "net/newsmodel.h"

#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QStringList>

namespace shell {
class Diag;
} // namespace shell

namespace ui {

// What the login screen can say. One kind per remedy.
enum class LoginFailure {
    None,
    InvalidCredentials,  // 401 invalid-credentials - check the id / password
    AccountLocked,       // 423 locked - the ACCOUNT is locked after repeated failures (right password refused too)
    RateLimited,         // 429 - too many attempts from this machine (IP), whichever account
    Refused,             // 403 - the server refuses this account (deactivated)
    Unreachable,         // no HTTP answer at all (refused, reset, DNS)
    TimedOut,            // no complete answer before the request deadline
    InvalidResponse,     // an answer that is not our server's JSON (proxy page, captive portal)
    Unexpected           // any other answer - its HTTP status is shown
};

// Pure. The Model's outcome -> the kind shown. Never consults the reason token (rule 1).
LoginFailure loginFailureFor(net::Outcome outcome);
// Pure. One sentence per kind; the status is only used by Unexpected.
QString loginFailureMessage(LoginFailure failure, int status = -1);
// The sentence shown when the server ended the session (401 on the identity check, the stream's
// unauthorized frame).
QString sessionEndedMessage();
// The label the top bar shows: "userId · department · (role)" (docs/UI_GUIDE.md layout) - DISPLAY
// only, built from a GET /api/session answer.
QString identityLabelFrom(const QJsonObject &sessionUser);

// Every diag event this controller writes (both inside shell::allowedDiagEvents()).
QStringList loginControllerDiagEvents();

struct LoginAttempt {
    bool ok = false;
    int status = -1;  // the HTTP status, -1 without an answer
    LoginFailure failure = LoginFailure::Unexpected;
    QString message;  // empty on success
};

struct SessionCheck {
    bool ok = false;
    int status = -1;
    bool sessionEnded = false;  // 401 unauthenticated: the session is gone - back to login
    QString identityLabel;      // display only
    QString message;            // empty on success
};

// GET /api/session - the identity asked of the server (decisions (7) 2). The one implementation of the
// check: LoginController::confirmSession() and the list's entry (ListController::enter, step11) both
// call it. Writes one session{status} line (null without an answer). diag may be null.
SessionCheck checkSession(net::INewsModel &model, shell::Diag *diag);

class LoginController : public QObject
{
    Q_OBJECT

public:
    // model: not owned, outlives the controller. diag may be null.
    LoginController(net::INewsModel &model, shell::Diag *diag, QObject *parent = nullptr);

    // The login action. The screen's button and the scenario hook both call exactly this, so what
    // follows (the screen change) is the same app path either way. Writes one login{status} line
    // (null without an answer), THEN emits loginSucceeded or loginFailed(message).
    LoginAttempt login(const QString &userId, const QString &password);

    // GET /api/session - the identity asked of the server, every time a screen is entered (decisions
    // (7) 2). Writes one session{status} line. Emits nothing: the caller decides where to go.
    SessionCheck confirmSession();

signals:
    void loginSucceeded();
    void loginFailed(const QString &message);

private:
    net::INewsModel &m_model;
    shell::Diag *m_diag = nullptr;
};

} // namespace ui

#endif // CLIENT_QT_UI_LOGINCONTROLLER_H
