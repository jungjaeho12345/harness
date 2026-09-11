#ifndef CLIENT_QT_TESTS_LIVESERVERTEST_H
#define CLIENT_QT_TESTS_LIVESERVERTEST_H

#include <QObject>

// A MANUAL round trip against a real server (phase 77 step7 검증 절차 3·4) - not a gate.
//
// tests/main.cpp registers this class only when CLIENT_QT_LIVE_ORIGIN is set, so build.bat never
// runs it (and never reports it as skipped). A driver outside the repository starts a server on a
// temporary DATA_DIR, sets CLIENT_QT_LIVE_ORIGIN / CLIENT_QT_LIVE_USER / CLIENT_QT_LIVE_PASSWORD
// (the harness seed account) and runs the test binary. What it measures on the real thing:
//   - the probe answers ok against /api/health
//   - the non-production sid cookie (HttpOnly; SameSite=Lax; no Secure) is replayed by Qt's jar
//   - a state-changing POST with no Origin/Referer passes the CSRF guard (404, not 403)
//   - logout's Max-Age=0 empties the jar
// No credential is written anywhere by this class (it reads them from the environment only).
class LiveServerTest : public QObject
{
    Q_OBJECT

private slots:
    void roundTripsAgainstARealServer();
};

#endif // CLIENT_QT_TESTS_LIVESERVERTEST_H
