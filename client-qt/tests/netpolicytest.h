#ifndef CLIENT_QT_TESTS_NETPOLICYTEST_H
#define CLIENT_QT_TESTS_NETPOLICYTEST_H

#include <QObject>

// The pure policies of the net layer (phase 77 step7): how a (route, status, token) answer is
// classified, which routes may carry x-edit-client, that no request waits forever, and the
// format of an edit-surface id. The canonical test suite locks none of these - httpModel.test.js
// never mentions 423, 429 or 'locked' - so every row here is new coverage.
class NetPolicyTest : public QObject
{
    Q_OBJECT

private slots:
    void classifiesByRouteStatusAndToken_data();
    void classifiesByRouteStatusAndToken();
    void neverReadsLockedFromTheTokenAlone();
    void spellsEveryOutcomeDifferently();
    void namesExactlyThreeEditClientRoutes();
    void neverWaitsForever();
    void issuesEditClientIdsInTheCanonicalFormat();
    void keepsOneIdPerSurface();
};

#endif // CLIENT_QT_TESTS_NETPOLICYTEST_H
