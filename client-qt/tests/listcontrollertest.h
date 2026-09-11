#ifndef CLIENT_QT_TESTS_LISTCONTROLLERTEST_H
#define CLIENT_QT_TESTS_LISTCONTROLLERTEST_H

// ListController (phase 77 step11 A) on FakeNewsModel - no server, no screen.

#include <QObject>

class ListControllerTest : public QObject
{
    Q_OBJECT

private slots:
    void queriesTheDeskUnsentFilter();
    void entersWithTheIdentityCheckThenOneQueryThenTheStream();
    void reasksTheServerOnEveryEntry();
    void refusesToEnterWithoutAConfirmedSession();
    void reQueriesExactlyOncePerChangeSignal();
    void neverReQueriesOnReady();
    void hasNoPeriodicTimer();
    void treatsEveryKindAsTheSameSignal();
    void pagesTenRowsAtATime_data();
    void pagesTenRowsAtATime();
    void clampsThePageWhenTheListShrinks();
    void showsTheNewestFirst();
    void mergesChangesThatArriveDuringAQuery();
    void neverDropsAChangeThatArrivesDuringAQuery();
    void endsTheSessionOnA401Answer();
    void keepsTheRowsWhenAQueryFailsWithoutEndingTheSession();
    void endsTheSessionWhenTheStreamSaysSo();
    void leaveClosesTheStreamAndForgetsTheRows();
    void writesACountNeverATitleOrAnId();
    void dependsOnNoWidgetAndNoTimer();
    void spellsTheFilterWithBuildQueryOnTheWire();
};

#endif // CLIENT_QT_TESTS_LISTCONTROLLERTEST_H
