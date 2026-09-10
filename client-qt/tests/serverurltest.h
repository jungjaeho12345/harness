#ifndef CLIENT_QT_TESTS_SERVERURLTEST_H
#define CLIENT_QT_TESTS_SERVERURLTEST_H

#include <QObject>

// Port of the serverUrl half of test/client-shell-core.test.js and of the resolveFinalOrigin
// half of test/client-probe-origin.test.js (phase 77 step2). Those two files are the
// specification: every row below is either a case lifted from them or a Qt-only case added
// because QUrl and WHATWG URL disagree (or because a canonical rule had no test at all).
// Rows that document a deliberate divergence from the canonical say so on the row.
class ServerUrlTest : public QObject
{
    Q_OBJECT

private slots:
    void normalizesOperatorInput_data();
    void normalizesOperatorInput();
    void rejectsWithCanonicalReason_data();
    void rejectsWithCanonicalReason();
    void buildsHealthUrl();
    void comparesOrigins_data();
    void comparesOrigins();
    void resolvesFinalOrigin_data();
    void resolvesFinalOrigin();
    void interpretsHealthResponse_data();
    void interpretsHealthResponse();
    void originSpellingIsConsistentAcrossEntryPoints_data();
    void originSpellingIsConsistentAcrossEntryPoints();
    void documentsQUrlDivergencesThisPortCorrects();
};

#endif // CLIENT_QT_TESTS_SERVERURLTEST_H
