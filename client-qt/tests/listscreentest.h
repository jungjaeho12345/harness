#ifndef CLIENT_QT_TESTS_LISTSCREENTEST_H
#define CLIENT_QT_TESTS_LISTSCREENTEST_H

// The list screen and the main window's top bar (phase 77 step11 B) - the view half, checked against
// the web's own tables (columnConfig.js, statusBadge.js) read at run time.

#include <QObject>

class ListScreenTest : public QObject
{
    Q_OBJECT

private slots:
    void catalogMatchesTheCanonicalColumns();
    void formatsTimesInTheDefaultFormat_data();
    void formatsTimesInTheDefaultFormat();
    void formatsOtherCellsAsStrings();
    void coloursBadgesLikeTheWeb();
    void rendersTheCurrentPageInElevenColumns();
    void pagerFollowsThePage();
    void showsAQueryErrorAboveTheRows();
    void isReadOnly();
    void topBarIs48PxWithALiveIndicatorOnTheListPage();
};

#endif // CLIENT_QT_TESTS_LISTSCREENTEST_H
