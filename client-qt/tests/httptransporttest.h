#ifndef CLIENT_QT_TESTS_HTTPTRANSPORTTEST_H
#define CLIENT_QT_TESTS_HTTPTRANSPORTTEST_H

#include <QObject>

// HttpTransport against a loopback stub server (phase 77 step7). Every case judges what reached
// the wire - request-target bytes, header lines, body bytes - not what the client meant to send.
//
// The canonical (web/src/model/httpModel.test.js) mocks fetch, so it could never see the wire;
// it also never mentions 423, 429 or 'locked', never sends lockArticle without an action, and
// never checks that a session does not outlive the process. Those are new coverage here.
class HttpTransportTest : public QObject
{
    Q_OBJECT

private slots:
    // --- round trips -----------------------------------------------------------------------
    void parsesAJsonAnswer();
    void keepsTheJsonOfAnErrorStatus();
    void flagsABodyThatIsNotAJsonObject_data();
    void flagsABodyThatIsNotAJsonObject();
    void timesOutInsteadOfWaitingForever();
    void reportsARefusedConnection();
    void refusesABodyOnAGet();

    // --- the session cookie -----------------------------------------------------------------
    void carriesTheSessionCookieToTheNextRequest();
    void stopsSendingTheCookieAfterClearSession();
    void forgetsTheCookieTheServerExpires();
    void keepsNoSessionAcrossARestart();
    void dropsTheSessionOnlyOnUnauthenticated_data();
    void dropsTheSessionOnlyOnUnauthenticated();

    // --- headers ------------------------------------------------------------------------------
    void sendsNoOriginRefererOrSessionHeader();
    void attachesTheEditClientOnlyOnItsThreeRoutes_data();
    void attachesTheEditClientOnlyOnItsThreeRoutes();

    // --- body ---------------------------------------------------------------------------------
    void sendsNeitherBodyNorContentTypeWithoutABody_data();
    void sendsNeitherBodyNorContentTypeWithoutABody();
    void sendsAnEmptyObjectWhenTheBodyIsEmpty();
    void sendsTheJsonBody();

    // --- status and token -----------------------------------------------------------------------
    void deliversEachStatusAsADistinctOutcome();
    void judgesATextHtml429AsRateLimited();
    void separatesTheTwoLockedTokens();

    // --- query, redirects, diag ---------------------------------------------------------------
    void putsTheQueryOnTheWire_data();
    void putsTheQueryOnTheWire();
    void followsOnlySameOriginRedirectsForApiCalls();
    void logsOneNetRequestLinePerRequest();
};

#endif // CLIENT_QT_TESTS_HTTPTRANSPORTTEST_H
