#ifndef CLIENT_QT_TESTS_FAKENEWSMODELTEST_H
#define CLIENT_QT_TESTS_FAKENEWSMODELTEST_H

#include <QObject>

// FakeNewsModel's discipline (phase 77 step8 B). A fake that behaves unlike the server makes every
// controller test above it a false green, so each rule is a test of its own:
//   rule 1 deterministic · rule 2 no network · rule 3 all 35 methods · rule 4 no password ·
//   rule 5 soft removal · rule 6 saveArticle drops body · rule 7 not linked into the shipped exe
// plus the override ledger (L131 locker fields, L123-128 identity re-derivation, L21 no delete)
// and the canonical cases of web/src/model/contract.test.js ported one for one.
class FakeNewsModelTest : public QObject
{
    Q_OBJECT

private slots:
    void rule1_isDeterministic();
    void rule2_touchesNoNetwork();
    void rule3_answersEveryModelKey();
    void rule4_neverAnswersAPassword();
    void rule5_removesNothingButDeactivates();
    void rule6_saveArticleDropsTheBodyKey();
    void rule7_isNotLinkedIntoTheApp();

    void neverExposesTheLockHolder();
    void rederivesTheSessionIdentityOnEveryCall();
    void keepsTheSessionIdOutOfTheLoginResult();

    // web/src/model/contract.test.js, case by case
    void loginRestoreLogoutRoundTrip();
    void saveArticleAssignsAnIdAndNotifies();
    void filtersArticlesByStatus();
    void queryHistoryIsLightAndLeavesTheSeed();
    void getHistorySnapshotReturnsACopy();
    void deriveArticleLeavesTheSource();
    void publishPhotoStampsTheSessionUser();
    void translateFallsBackToTheTitle();
    void distributionTargetsRoundTrip();
    void distributionFailuresAndTick();
    void subscriptionsEndWithTheirHandle();
    void subscribeLogsReplaysTheSeed();
    void endsTheStreamSessionLikeTheServer();  // step9: the same order HttpNewsModel reports
};

#endif // CLIENT_QT_TESTS_FAKENEWSMODELTEST_H
