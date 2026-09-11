#ifndef CLIENT_QT_TESTS_CHANGESTREAMTEST_H
#define CLIENT_QT_TESTS_CHANGESTREAMTEST_H

#include <QObject>

// ChangeStream against a loopback streaming stub (phase 77 step9 B). Every reconnect is counted and
// timed on the stub's side of the wire, not taken from the client's word.
//
// The canonical (web/src/model/httpModel.test.js 353-785) drives a fake EventSource, so it can
// assert the unauthorized close and the kept-open error - but everything EventSource did by itself
// (refusing a non-200 or non-event-stream answer without reconnecting, the retry itself, the frame
// parser) was never under test there. Those are new coverage here: three terminal paths and one
// retried path, each its own case.
class ChangeStreamTest : public QObject
{
    Q_OBJECT

private slots:
    // --- pure helpers ---------------------------------------------------------------------------
    void judgesTheContentType_data();
    void judgesTheContentType();
    void growsTheReconnectDelay_data();
    void growsTheReconnectDelay();
    void spellsTheCloseReasons();

    // --- an open stream ---------------------------------------------------------------------------
    void opensTheStreamWithTheSessionCookie();
    void raisesOneSignalPerChangeWhateverTheKind();
    void assemblesAFrameSplitAcrossHttpChunks();
    void neverSendsAnythingButTheStreamRequest();

    // --- the three terminal paths -----------------------------------------------------------------
    void stopsForGoodOnTheUnauthorizedFrame();
    void readsTheUnauthorizedFrameThatArrivesWithTheClose();
    void rejectsA401BeforeTheStreamOpens();
    void rejectsA503BeforeTheStreamOpensWithoutEndingTheSession();
    void neverParsesA200ThatIsNotAnEventStream_data();
    void neverParsesA200ThatIsNotAnEventStream();

    // --- the one retried path -----------------------------------------------------------------------
    void reconnectsWithAGrowingDelayAfterTransientDrops();
    void restartsTheDelayOnceTheStreamIsReady();
    void reconnectsWhenTheServerNeverAnswers();
    void treatsARefusedConnectionAsTransient();
    void aReconnectThatMeetsA401StopsThere();

    // --- lifecycle and concurrency ------------------------------------------------------------------
    void stopClosesForGoodAndIsIdempotent();
    void staysSilentOnceStopped();
    void runsTwoIndependentStreamsOnOneSession();
};

#endif // CLIENT_QT_TESTS_CHANGESTREAMTEST_H
