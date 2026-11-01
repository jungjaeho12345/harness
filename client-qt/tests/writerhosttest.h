#ifndef CLIENT_QT_TESTS_WRITERHOSTTEST_H
#define CLIENT_QT_TESTS_WRITERHOSTTEST_H

// The writer of an app window (phase 78 step9 - ui::WriterHost) and the main window's editor page: the list's
// double-click -> the editor page (the list left first) -> getArticle / lockArticle; the text engine's edits, undo and
// the top bar's [저장] [복구] [닫기] reaching the edit controller; the renormalized body pushed back; the window's closing
// as the unlock; the single-shot autosave. Offscreen widgets over FakeNewsModel - the GUI half of the state machine.

#include <QObject>

class WriterHostTest : public QObject
{
    Q_OBJECT

private slots:
    void initTestCase();
    void cleanupTestCase();
    void theEditorPageHasItsOwnTopBarActions();
    void doubleClickOpensTheArticleOnTheEditorPage();
    void typingCommitsAndUndoGoesBack();
    void saveAndCloseRunTheRoundTrip();
    void aRefusedLockShowsTheArticleReadOnly();
    void aRenormalizedBodyIsPushedBackToTheWidget();
    void theWindowClosingUnlocksWithoutGoingBackToTheList();
    void autosaveRunsOnASingleShotTimerOnlyWhenEnabled();
    void opensOneSurfaceAtATime();
    void anEditOperationSavesTheBlocksTheEditorShows();
    void aSessionThatEndsOnSaveTurnsTheEditorReadOnly();
    void aJoinBehindTheMarkerKeepsTheCaretThroughThePushBack();
    void aDeleteBehindTheMarkerKeepsTheCaretThroughThePushBack();

private:
    bool m_savedQuitOnLastWindowClosed = true;
};

#endif // CLIENT_QT_TESTS_WRITERHOSTTEST_H
