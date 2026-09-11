#ifndef CLIENT_QT_TESTS_ROUTECONTRACTTEST_H
#define CLIENT_QT_TESTS_ROUTECONTRACTTEST_H

#include <QObject>

// The route table and the Model interface against the FROZEN contract, read at run time
// (phase 77 step8 C · decisions (4)): docs/api-contract/endpoints.json (39 routes) and
// web/src/model/contract.js (MODEL_KEYS). Both are found relative to the repository root; a
// missing file is a red on every check, never a skip. Nothing here lists the 39 routes - only
// the policies the plan fixes (the two forbidden ids, the three x-edit-client ids, saveArticle's
// two routes, the 35 count) are written down.
class RouteContractTest : public QObject
{
    Q_OBJECT

private slots:
    void findsTheContractFilesFromTheRepositoryRoot();
    void refusesAContractItCannotRead();

    void c1_idSetIsExactlyTheContract();
    void c2_methodAndPathMatchTheContract();
    void c3_authMatchesTheContract();
    void c4_forbiddenRoutesAreNotInTheTable();
    void c5_sseRowsMatchTheContract();
    void c6_editClientRowsAreExactlyThreeAndTheTransportsSet();
    void c7_consumersMapOneToMany();
    void c8_modelKeysAreTheInterface();

    // The comparators are not vacuous: a doctored COPY of each file (the originals are never
    // touched) makes the matching check report the drift by name.
    void detectsDriftInACopyOfTheContract();
};

#endif // CLIENT_QT_TESTS_ROUTECONTRACTTEST_H
