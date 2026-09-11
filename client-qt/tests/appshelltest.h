#ifndef CLIENT_QT_TESTS_APPSHELLTEST_H
#define CLIENT_QT_TESTS_APPSHELLTEST_H

#include <QObject>

// The app shell (phase 77 step5), driven end to end with injected fakes: boot branches and their
// exact diag sequences, the silent second instance, the second-instance handler, and the whole
// bounds lifecycle of a live window (restore -> clamp -> maximize -> save once on close).
//
// The canonical could test none of this - createAppWindow, saveBoundsFrom and the
// second-instance handler need a live BrowserWindow, and verify-client.mjs runs with
// CLIENT_SELFTEST=1, which returns before every one of those branches. Widgets here run on the
// offscreen platform (tests/main.cpp), so "shown" never reaches the desktop, and every file
// lives in a QTemporaryDir.
class AppShellTest : public QObject
{
    Q_OBJECT

private slots:
    void initTestCase();
    void cleanupTestCase();

    // --- boot -------------------------------------------------------------------------
    void decidesTheBootScreenFromTheConfig_data();
    void decidesTheBootScreenFromTheConfig();
    void bootsToTheAppWindowWhenAServerIsConfigured();
    void bootsToTheSetupScreenWithoutAConfig();
    void neverProbesOnTheBootPath();
    void emitsOnlyAllowedEventNames();

    // --- single instance ----------------------------------------------------------------
    void staysSilentAsASecondInstance();
    void aSecondShellOnTheSameFolderOpensNoWindow();
    void recordsASecondInstanceWithoutTouchingWindowsUnderSelftest();
    void bringsAMinimizedWindowBackWithoutUnmaximizingIt();
    void leavesAMaximizedWindowMaximizedWhenActivated();

    // --- showing ------------------------------------------------------------------------
    void neverShowsAWindowUnderSelftest();
    void showsTheWindowOutsideSelftest();

    // --- bounds -------------------------------------------------------------------------
    void restoresTheStoredRectangleThenMaximizes();
    void opensAtTheDefaultsWhenNoWorkAreaHoldsTheStoredBounds();
    void clampsBandBoundsToTheWindowMinimumOnBoot();
    void savesBoundsOnceOnCloseAndNeverOnResize();
    void savesTheNormalRectangleOfAMaximizedWindow();
    void doesNotSaveBoundsForAWindowThatWasNeverShown();
    void keepsThePreviousBoundsWhenTheWindowClosesOffScreen();
    void closesEvenWhenTheConfigCannotBeWritten();

    // --- setup screen -------------------------------------------------------------------
    void probesOnlyWhenTheUserAsks();
    void showsTheStandInNoticeOnTheSetupScreen();
    void showsNoNoticeOnceTheRealRunnerIsInjected();
    void refusesToSaveAnAddressThatDoesNotNormalise();

    // --- save = probe first, then the final origin (step7 restores client/main.js:129-137) ---
    void savesNothingWhenTheProbeFails();
    void savesTheProbedFinalOriginAndOpensTheAppWindow();
    void savesTheRedirectedOriginOfARealProbe();
    void savesNothingWhenARealProbeMeetsAPortal();

    // --- login (step10): the app window's two pages and the screen changes ---------------
    void opensTheAppWindowOnTheLoginPageWithoutAskingTheServer();
    void masksThePasswordAndLetsGoOfItOnSubmit();
    void entersTheListSlotOnlyAfterTheServerConfirmsTheIdentity();
    void staysOnTheLoginPageWhenLoginFails();
    void goesBackToLoginWhenTheIdentityCheckFails();
    void goesBackToLoginWhenTheStreamEndsTheSession();
    void runsTheLoginScenarioThroughTheControllerNotTheWidgets();
    void cannotRunTheLoginScenarioWithoutAnAppWindow();

    // --- list (step11): the list screen in the list slot, live -------------------------------
    void showsTheListAndRefreshesTheScreenOnAChange();
    void neverShowsTheListPageWithoutEnteringTheList();
    void leavesTheListWhenGoingBackToLogin();

    // --- --selftest ---------------------------------------------------------------------
    void selfTestPassesAfterACleanBoot();
    void selfTestFailsWhenTheInvariantsDoNotHold();

private:
    bool m_savedQuitOnLastWindowClosed = true;
};

#endif // CLIENT_QT_TESTS_APPSHELLTEST_H
