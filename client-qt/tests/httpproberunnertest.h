#ifndef CLIENT_QT_TESTS_HTTPPROBERUNNERTEST_H
#define CLIENT_QT_TESTS_HTTPPROBERUNNERTEST_H

#include <QObject>

// The real probe runner (phase 77 step7) against loopback stubs: health verdict, the final URL
// after redirects (the input of shell::probeOrigin's success-only promotion), the deadline, and
// the fact that a probe never carries a cookie. The save order it enables is locked in
// AppShellTest.
class HttpProbeRunnerTest : public QObject
{
    Q_OBJECT

private slots:
    void reachesTheArticleServer();
    void followsARedirectToTheFinalUrl();
    void reportsNothingReachedWhenNobodyListens();
    void givesUpAtItsDeadline();
    void judgesAPortalPageNotArticleServer();
    void carriesNoCookieFromOneProbeToTheNext();
    void confessesNoLimitation();
    void logsTheHealthRouteAndTheProbe();
};

#endif // CLIENT_QT_TESTS_HTTPPROBERUNNERTEST_H
