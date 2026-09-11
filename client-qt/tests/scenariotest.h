#ifndef CLIENT_QT_TESTS_SCENARIOTEST_H
#define CLIENT_QT_TESTS_SCENARIOTEST_H

#include <QObject>

// The scenario hook's guard (phase 77 step10 A - shell/scenario.h). The hook is an automatic login
// path inside the production binary, so its front door is tested row by row: without
// CLIENT_SELFTEST exactly "1" every spelling of --scenario is refused (fail-closed), an unusable
// request is refused rather than half-run, and a refusal never echoes an argument or a credential.
class ScenarioTest : public QObject
{
    Q_OBJECT

private slots:
    void parses_data();
    void parses();
    void refusesEveryScenarioWithoutTheSelftestGuard_data();
    void refusesEveryScenarioWithoutTheSelftestGuard();
    void neverEchoesAnArgumentOrACredential();
    void readsItsOwnEnvironmentNames();
};

#endif // CLIENT_QT_TESTS_SCENARIOTEST_H
