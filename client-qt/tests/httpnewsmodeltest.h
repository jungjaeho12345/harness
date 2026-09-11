#ifndef CLIENT_QT_TESTS_HTTPNEWSMODELTEST_H
#define CLIENT_QT_TESTS_HTTPNEWSMODELTEST_H

#include <QObject>

// HttpNewsModel on the wire, against the loopback stub (phase 77 step8 B).
//
// The decisive case is eachMethodSendsTheRouteTheTableGivesIt: every REST method of the 35 is
// called once and the request that reached the stub (method, target, body, x-edit-client) and
// the diag route id are compared with the canonical call (web/src/model/httpModel.js) AND with
// the route table's consumer column - that is how the 29 methods no P4 screen calls are still
// locked. A real server round trip is claimed only for the P4 six (step10/11 drive them).
class HttpNewsModelTest : public QObject
{
    Q_OBJECT

private slots:
    void eachMethodSendsTheRouteTheTableGivesIt();
    void queryArticlesSpellsItsFiltersWithBuildQuery();
    void normalisesAnswersLikeTheCanonicalRequest_data();
    void normalisesAnswersLikeTheCanonicalRequest();
    void returnsAServerJsonAnswerUntouched();
    void flagsANonJsonAnswerAsInvalidResponse();
    void tellsARateLimitOnlyByOutcome();
    void sendsNothingWhenThePathCannotBeBuilt();
    void keepsTheSessionIdOutOfTheLoginResult();
    void forgetsTheSessionOnLogoutWhateverTheServerSays();
    void resolvesUploadFilenamesLikeTheCanonical();
    void neverOpensTheLogStreamInP4();
};

#endif // CLIENT_QT_TESTS_HTTPNEWSMODELTEST_H
