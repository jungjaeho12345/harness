#ifndef CLIENT_QT_TESTS_LOGINCONTROLLERTEST_H
#define CLIENT_QT_TESTS_LOGINCONTROLLERTEST_H

#include <QObject>

// ui::LoginController on FakeNewsModel (phase 77 step10 B) - no server, no widget.
//
// The five axes the step names (200 · 401 · 423 · 429 · no answer) each have a test of their own,
// then the rules that make them mean something: the kind is decided by the Model's OUTCOME and never
// by body.reason (a 429 carries reason "invalid-response"), every kind has its own sentence (423 and
// 429 are different remedies), the identity shown comes from GET /api/session and not from the login
// answer (L123-128), and no password reaches the diag.
class LoginControllerTest : public QObject
{
    Q_OBJECT

private slots:
    // --- the five axes --------------------------------------------------------------------
    void succeedsOn200AndSaysSoOnce();
    void reportsWrongCredentialsOn401();
    void reportsTheAccountLockOn423();
    void reportsTheIpRateLimitOn429NotABrokenAnswer();
    void reportsANetworkFailureWhenNoAnswerArrives();

    // --- the rules behind them ------------------------------------------------------------
    void mapsEveryOutcomeToOneKind_data();
    void mapsEveryOutcomeToOneKind();
    void givesEveryKindItsOwnSentence();
    void tellsARealBrokenAnswerFromTheRateLimit();
    void neverReadsTheReasonToken();
    void confirmsTheIdentityWithTheServerNotTheLoginAnswer();
    void reportsAnEndedSessionOnTheIdentityCheck();
    void cannotConfirmAnIdentityWithoutAnAnswer();
    void writesOnlyStatusesAndNeverThePassword();
    void dependsOnNoWidget();
};

#endif // CLIENT_QT_TESTS_LOGINCONTROLLERTEST_H
