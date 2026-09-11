#include "windowpolicytest.h"

#include "shell/clientconfig.h"
#include "shell/windowpolicy.h"

#include <QList>
#include <QPoint>
#include <QRect>
#include <QSize>
#include <QWidget>
#include <QtTest>

using shell::Activation;
using shell::Bounds;
using shell::WindowPlacement;

Q_DECLARE_METATYPE(shell::Activation)
Q_DECLARE_METATYPE(shell::Bounds)

namespace {

Bounds makeBounds(int width, int height, int x, int y, bool maximized = false)
{
    Bounds b;
    b.width = width;
    b.height = height;
    b.x = x;
    b.y = y;
    b.maximized = maximized;
    b.valid = true;
    return b;
}

const QList<QRect> kOneMonitor{QRect(0, 0, 1920, 1080)};

} // namespace

// windowPolicy.js:39-42 / 61-62 and port spec X5: two minimum-size constants, never merged.
void WindowPolicyTest::usesTheCanonicalWindowConstants()
{
    QCOMPARE(shell::kAppWindowDefaultWidth, 1440);
    QCOMPARE(shell::kAppWindowDefaultHeight, 900);
    QCOMPARE(shell::kAppWindowMinWidth, 1024);
    QCOMPARE(shell::kAppWindowMinHeight, 720);
    QCOMPARE(shell::kSetupWindowWidth, 560);
    QCOMPARE(shell::kSetupWindowHeight, 420);

    // The stored-rectangle lower bound (clientConfig.js:14-15) stays BELOW the window minimum.
    // Raising it to 1024x720 would turn the W-N1 band into "discard the bounds and open at
    // 1440x900" - a different, observable result than the canonical's clamp.
    QCOMPARE(shell::kMinStoredWidth, 800);
    QCOMPARE(shell::kMinStoredHeight, 600);
    QVERIFY(shell::kMinStoredWidth < shell::kAppWindowMinWidth);
    QVERIFY(shell::kMinStoredHeight < shell::kAppWindowMinHeight);
}

// R4/R5: no stored bounds -> the defaults, and no position at all (the platform places it).
void WindowPolicyTest::plansTheDefaultWindowWithoutAPosition()
{
    const WindowPlacement plan = shell::planAppWindow(Bounds());
    QCOMPARE(plan.minimumSize, QSize(1024, 720));
    QCOMPARE(plan.size, QSize(1440, 900));
    QVERIFY2(!plan.position.has_value(), "a missing position must stay missing, never (0,0)");
    QVERIFY(!plan.startMaximized);
}

void WindowPolicyTest::plansTheRestoredRectangle()
{
    const WindowPlacement plan = shell::planAppWindow(makeBounds(1200, 800, 30, 40));
    QCOMPARE(plan.minimumSize, QSize(1024, 720));
    QCOMPARE(plan.size, QSize(1200, 800));
    QVERIFY(plan.position.has_value());
    QCOMPARE(*plan.position, QPoint(30, 40));
    QVERIFY(!plan.startMaximized);
}

// R8: the maximized flag is honoured only from stored bounds, and it never changes the normal
// rectangle the window is created with (created normal, maximized after).
void WindowPolicyTest::startsMaximizedOnlyWhenTheStoredBoundsSaySo_data()
{
    QTest::addColumn<Bounds>("restored");
    QTest::addColumn<bool>("startMaximized");
    QTest::addColumn<QSize>("size");

    QTest::newRow("stored maximized -> maximize after creation")
        << makeBounds(1200, 800, 30, 40, true) << true << QSize(1200, 800);
    QTest::newRow("stored normal -> normal") << makeBounds(1200, 800, 30, 40, false) << false
                                             << QSize(1200, 800);
    Bounds invalidButFlagged = makeBounds(1200, 800, 30, 40, true);
    invalidButFlagged.valid = false;
    QTest::newRow("no usable bounds -> defaults, never maximized")
        << invalidButFlagged << false << QSize(1440, 900);
}

void WindowPolicyTest::startsMaximizedOnlyWhenTheStoredBoundsSaySo()
{
    QFETCH(Bounds, restored);
    QFETCH(bool, startMaximized);
    QFETCH(QSize, size);

    const WindowPlacement plan = shell::planAppWindow(restored);
    QCOMPARE(plan.startMaximized, startMaximized);
    QCOMPARE(plan.size, size);
}

// W-N1 (NEW coverage - the canonical suite only pokes 799/599, below the stored bound): a stored
// rectangle in 800..1023 x 600..719 passes validation and is then clamped by the window minimum.
// Both halves are asserted: it IS valid (so it is not discarded to 1440x900) and the window IS
// 1024x720 wide/high at least.
void WindowPolicyTest::clampsTheMinimumSizeBandToTheWindowMinimum_data()
{
    QTest::addColumn<int>("storedWidth");
    QTest::addColumn<int>("storedHeight");
    QTest::addColumn<QSize>("windowSize");

    QTest::newRow("850x650 band on both axes") << 850 << 650 << QSize(1024, 720);
    QTest::newRow("800x600 the stored lower bound") << 800 << 600 << QSize(1024, 720);
    QTest::newRow("1023x719 one below the window minimum") << 1023 << 719 << QSize(1024, 720);
    QTest::newRow("1100x650 only the height in the band") << 1100 << 650 << QSize(1100, 720);
    QTest::newRow("900x800 only the width in the band") << 900 << 800 << QSize(1024, 800);
    QTest::newRow("1024x720 exactly the minimum (control)") << 1024 << 720 << QSize(1024, 720);
    QTest::newRow("1300x800 above the band (control)") << 1300 << 800 << QSize(1300, 800);
}

void WindowPolicyTest::clampsTheMinimumSizeBandToTheWindowMinimum()
{
    QFETCH(int, storedWidth);
    QFETCH(int, storedHeight);
    QFETCH(QSize, windowSize);

    const Bounds restored = shell::sanitizeBounds(makeBounds(storedWidth, storedHeight, 10, 10),
                                                  kOneMonitor);
    QVERIFY2(restored.valid, "the band must pass validation - it is clamped, not discarded");

    const WindowPlacement plan = shell::planAppWindow(restored);
    QCOMPARE(plan.size, QSize(storedWidth, storedHeight));  // the plan carries the stored size

    QWidget window;
    shell::applyWindowPlacement(window, plan);
    QCOMPARE(window.minimumSize(), QSize(1024, 720));
    QCOMPARE(window.size(), windowSize);  // ...and the window minimum clamps it
}

// R5: without a stored position the window is not moved at all - Qt marks every explicit
// move()/setGeometry() with WA_Moved, so its absence proves no (0,0) sentinel was used.
void WindowPolicyTest::neverMovesAWindowWithoutAStoredPosition()
{
    QWidget window;
    shell::applyWindowPlacement(window, shell::planAppWindow(Bounds()));
    QVERIFY(!window.testAttribute(Qt::WA_Moved));
    QCOMPARE(window.size(), QSize(1440, 900));
}

void WindowPolicyTest::placesAWindowAtItsStoredRectangle()
{
    QWidget window;
    shell::applyWindowPlacement(window, shell::planAppWindow(makeBounds(1200, 800, 30, 40)));
    QVERIFY(window.testAttribute(Qt::WA_Moved));
    // geometry() excludes the frame, like normalGeometry() that the save path reads.
    QCOMPARE(window.geometry(), QRect(30, 40, 1200, 800));
}

// R9 (NEW coverage - the most valuable unlocked rule of the module): a maximized window persists
// its normal rectangle, not the maximized one (client/main.js:370 getNormalBounds()).
void WindowPolicyTest::capturesTheNormalRectangleOfAMaximizedWindow()
{
    QWidget window;
    shell::applyWindowPlacement(window, shell::planAppWindow(makeBounds(1200, 800, 30, 40)));
    window.show();
    QVERIFY(QTest::qWaitForWindowExposed(&window));
    const QRect normal = window.geometry();

    window.showMaximized();
    QTRY_VERIFY(window.isMaximized());
    // Non-vacuity: if maximizing did not move the geometry, this case could not tell
    // normalGeometry() from geometry() and would pass for the wrong reason.
    QTRY_VERIFY(window.geometry() != normal);

    const Bounds captured = shell::captureBoundsFrom(window);
    QVERIFY(captured.valid);
    QCOMPARE(QRect(captured.x, captured.y, captured.width, captured.height), normal);
    QVERIFY(captured.maximized);
}

void WindowPolicyTest::capturesNothingFromAnEmptyRectangle()
{
    QVERIFY(!shell::capturedBounds(QRect(), true).valid);
    QVERIFY(!shell::capturedBounds(QRect(10, 10, 0, 0), false).valid);

    const Bounds b = shell::capturedBounds(QRect(12, 34, 1200, 800), false);
    QVERIFY(b.valid);
    QCOMPARE(b, makeBounds(1200, 800, 12, 34, false));
}

// W-N2 (NEW coverage): client/main.js:371-373 has no else branch. A closing rectangle that no
// monitor holds keeps the previous known-good value - it is not reset to "no bounds".
void WindowPolicyTest::keepsThePreviousBoundsWhenTheClosingRectangleIsOffScreen()
{
    const Bounds previous = makeBounds(1200, 800, 30, 40, false);
    const Bounds offScreen = makeBounds(1200, 800, 5000, 5000, true);
    const Bounds onScreen = makeBounds(1300, 850, 100, 100, true);

    QCOMPARE(shell::boundsToSave(previous, offScreen, kOneMonitor), previous);
    QCOMPARE(shell::boundsToSave(previous, onScreen, kOneMonitor), onScreen);
    QCOMPARE(shell::boundsToSave(previous, makeBounds(700, 500, 0, 0), kOneMonitor), previous);
    QCOMPARE(shell::boundsToSave(previous, onScreen, QList<QRect>()), previous);  // all detached
    QCOMPARE(shell::boundsToSave(previous, Bounds(), kOneMonitor), previous);
    // With nothing known-good, "keep" means staying without bounds - never inventing some.
    QCOMPARE(shell::boundsToSave(Bounds(), offScreen, kOneMonitor), Bounds());
}

// R10 (NEW coverage).
void WindowPolicyTest::savesBoundsOnlyForAWindowThatWasShown()
{
    QVERIFY(shell::shouldSaveBoundsOnClose(true));
    QVERIFY(!shell::shouldSaveBoundsOnClose(false));
}

// R3 (NEW coverage): restoring a window that is not minimized un-maximizes it
// (client/main.js:86), and selftest never touches a window at all.
void WindowPolicyTest::restoresOnlyAMinimizedWindow_data()
{
    QTest::addColumn<bool>("selftest");
    QTest::addColumn<bool>("haveWindow");
    QTest::addColumn<bool>("minimized");
    QTest::addColumn<Activation>("expected");

    QTest::newRow("minimized -> restore then show") << false << true << true
                                                    << Activation::RestoreThenShow;
    QTest::newRow("normal or maximized -> show only") << false << true << false << Activation::Show;
    QTest::newRow("selftest minimized -> log only") << true << true << true << Activation::LogOnly;
    QTest::newRow("selftest normal -> log only") << true << true << false << Activation::LogOnly;
    QTest::newRow("no window -> log only") << false << false << false << Activation::LogOnly;
}

void WindowPolicyTest::restoresOnlyAMinimizedWindow()
{
    QFETCH(bool, selftest);
    QFETCH(bool, haveWindow);
    QFETCH(bool, minimized);
    QFETCH(Activation, expected);

    QCOMPARE(shell::planActivation(selftest, haveWindow, minimized), expected);
}
