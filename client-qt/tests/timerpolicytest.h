#ifndef CLIENT_QT_TESTS_TIMERPOLICYTEST_H
#define CLIENT_QT_TESTS_TIMERPOLICYTEST_H

// No periodic timer lives in the client (phase 77 - tester gate).
//
// Why a source scan and why here: the app must never poll. ListControllerTest locks that for the list
// controller object (hasNoPeriodicTimer · dependsOnNoWidgetAndNoTimer) and the driver's list scenario
// locks it for the running app - but only for periods shorter than its 5 s observation window
// (client-qt/README.md 「기계가 판정하지 않는 것」 6). A repeating timer with a longer period, or one
// living in any module other than the list controller, is red nowhere today. This scan closes that
// gap for every file under client-qt/src and client-qt/app, whatever the period is.
//
// The rule: every QTimer object a module declares is made single-shot in that same module, and the
// periodic spellings (setInterval · startTimer · setSingleShot(false) · QBasicTimer · timerEvent) do
// not appear at all. QTimer::singleShot(...) is allowed - it fires once.
//
// A finding is a FAILURE, never a skip: not being able to read the sources fails too (the same rule
// repofiles.h states), so a binary run outside the repository cannot report a green it never earned.

#include <QObject>

class TimerPolicyTest : public QObject
{
    Q_OBJECT

private slots:
    void scannerFlagsPeriodicTimersAndAcceptsSingleShotOnes();
    void clientSourcesDeclareNoPeriodicTimer();
};

#endif // CLIENT_QT_TESTS_TIMERPOLICYTEST_H
