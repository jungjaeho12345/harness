#ifndef CLIENT_QT_TESTS_LIVESTREAMTEST_H
#define CLIENT_QT_TESTS_LIVESTREAMTEST_H

#include <QObject>

// A MANUAL measurement against a real server (phase 77 step9 검증 절차 2 / index.json
// open_questions (2)) - not a gate.
//
// tests/main.cpp registers this class only when CLIENT_QT_LIVE_SSE is set, so build.bat never runs
// it (and never reports it as skipped). A driver outside the repository starts a server on a
// temporary DATA_DIR and sets:
//   CLIENT_QT_LIVE_ORIGIN                               the server
//   CLIENT_QT_LIVE_USER / _PASSWORD                     the writer (creates the articles - role R)
//   CLIENT_QT_LIVE_WATCH_USER / _WATCH_PASSWORD         the watcher (subscribes)
//   CLIENT_QT_LIVE_SSE_ROUNDS (default 5)               change frames to time
//   CLIENT_QT_LIVE_SSE_IDLE_MS (default 0)              an idle wait before one more change
//
// The question is whether QNetworkAccessManager holds frames back (buffering, HTTP/2, automatic
// decompression). So the Qt stream is timed against a REFERENCE: a raw QTcpSocket on the same event
// loop reading the same stream with its own session. qt - raw is the delay Qt adds; both are also
// timed from the trigger (the POST that makes the server write the change frame). The Qt stream's
// response head is logged too (HTTP/2 used? Content-Encoding? Transfer-Encoding?).
// No credential is written anywhere (read from the environment only; the cookie stays in memory).
class LiveStreamTest : public QObject
{
    Q_OBJECT

private slots:
    void measuresFrameDeliveryOnARealServer();
};

#endif // CLIENT_QT_TESTS_LIVESTREAMTEST_H
