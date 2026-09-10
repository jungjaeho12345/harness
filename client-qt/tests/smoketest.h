#ifndef CLIENT_QT_TESTS_SMOKETEST_H
#define CLIENT_QT_TESTS_SMOKETEST_H

#include <QObject>

// step0 smoke test. Its only job is to prove that the runner really executes test
// functions: with no test class at all the runner could report a green while running
// nothing, which is exactly the vacuous gate this repo keeps getting burned by
// (index.json decisions (12)). Real behaviour tests arrive with step2+.
class SmokeTest : public QObject
{
    Q_OBJECT

private slots:
    void toolchainIsCpp17And64Bit();
    void qtRuntimeIsUsable();
};

#endif // CLIENT_QT_TESTS_SMOKETEST_H
