#ifndef CLIENT_QT_TESTS_WINDOWPOLICYTEST_H
#define CLIENT_QT_TESTS_WINDOWPOLICYTEST_H

#include <QObject>

// App window geometry decisions (phase 77 step5). Almost everything here is NEW coverage: the
// canonical tested buildWindowOptions (test/client-shell-core.test.js:312-342) but never the
// live-window half of the bounds contract - R8 (maximize after creation), R9 (normal rectangle),
// R10 (shown gate), W-N1 (the 800..1023 x 600..719 band), W-N2 (stale value kept at close) and
// R3 (restore only a minimized window) all ship without a safety net there (port spec section 6).
// Each case names the rule it locks.
class WindowPolicyTest : public QObject
{
    Q_OBJECT

private slots:
    void usesTheCanonicalWindowConstants();
    void plansTheDefaultWindowWithoutAPosition();
    void plansTheRestoredRectangle();
    void startsMaximizedOnlyWhenTheStoredBoundsSaySo_data();
    void startsMaximizedOnlyWhenTheStoredBoundsSaySo();
    void clampsTheMinimumSizeBandToTheWindowMinimum_data();
    void clampsTheMinimumSizeBandToTheWindowMinimum();
    void neverMovesAWindowWithoutAStoredPosition();
    void placesAWindowAtItsStoredRectangle();
    void capturesTheNormalRectangleOfAMaximizedWindow();
    void capturesNothingFromAnEmptyRectangle();
    void keepsThePreviousBoundsWhenTheClosingRectangleIsOffScreen();
    void savesBoundsOnlyForAWindowThatWasShown();
    void restoresOnlyAMinimizedWindow_data();
    void restoresOnlyAMinimizedWindow();
};

#endif // CLIENT_QT_TESTS_WINDOWPOLICYTEST_H
