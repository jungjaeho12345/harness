#ifndef CLIENT_QT_TESTS_PROBERUNNERTEST_H
#define CLIENT_QT_TESTS_PROBERUNNERTEST_H

#include <QObject>

// Probe injection point (phase 77 step5). Two things are locked here:
//   1. The stand-in runner the composition root injects never pretends: always unreachable,
//      and it carries a notice the setup screen shows.
//   2. probeOrigin() - the port of client/main.js:188-200 - promotes a redirected origin ONLY on
//      a successful verdict (port spec R26). The canonical locked that with a text scan of
//      main.js (test/client-probe-origin.test.js:207-215); here it is a behavioural case.
class ProbeRunnerTest : public QObject
{
    Q_OBJECT

private slots:
    void unimplementedRunnerNeverPretendsToSucceed();
    void logsOneProbeLineWithTheCanonicalPayload();
    void promotesTheOriginOnlyOnASuccessfulProbe_data();
    void promotesTheOriginOnlyOnASuccessfulProbe();
};

#endif // CLIENT_QT_TESTS_PROBERUNNERTEST_H
