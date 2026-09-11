#include "listscreentest.h"

#include "repofiles.h"

#include "ui/listcontroller.h"
#include "ui/listscreen.h"
#include "ui/mainwindow.h"
#include "ui/theme.h"

#include <QAbstractItemView>
#include <QFrame>
#include <QHeaderView>
#include <QJsonObject>
#include <QJsonValue>
#include <QLabel>
#include <QList>
#include <QPushButton>
#include <QRegularExpression>
#include <QSignalSpy>
#include <QString>
#include <QStringList>
#include <QTableWidget>
#include <QtTest>

using ui::ListColumn;
using ui::ListScreen;

namespace {

QString repoText(const QString &relative, QString *error)
{
    QByteArray bytes;
    if (!readRepoFile(relative, &bytes, error))
        return QString();
    return QString::fromUtf8(bytes);
}

QTableWidget *tableOf(ListScreen &screen)
{
    return screen.findChild<QTableWidget *>(QStringLiteral("listTable"));
}

int columnOf(const QString &key)
{
    const QList<ListColumn> columns = ui::listColumns();
    for (int i = 0; i < columns.size(); ++i) {
        if (columns.at(i).key == key)
            return i;
    }
    return -1;
}

QJsonObject sampleRow()
{
    return QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR20260912000100001")},
                       {QStringLiteral("title"), QStringLiteral("국회 본회의 개최")},
                       {QStringLiteral("author"), QStringLiteral("김기자")},
                       {QStringLiteral("modifier"), QStringLiteral("박데스크")},
                       {QStringLiteral("department"), QStringLiteral("정치부")},
                       {QStringLiteral("departmentCode"), QStringLiteral("POL")},
                       {QStringLiteral("createdAt"), QStringLiteral("2026-09-12T03:04:05.678Z")},
                       {QStringLiteral("editedAt"), QStringLiteral("2026-09-12T04:05:06.000Z")},
                       {QStringLiteral("sentAt"), QJsonValue(QJsonValue::Null)},
                       {QStringLiteral("distributedAt"), QStringLiteral("2026-09-12T05:06:07.000Z")},
                       {QStringLiteral("status"), QStringLiteral("DDH")},
                       {QStringLiteral("lockYN"), QStringLiteral("Y")}};
}

ui::ListViewState stateWith(const QList<QJsonObject> &rows, int page, int pageCount, int total)
{
    ui::ListViewState state;
    state.menu = ui::deskUnsentMenu();
    state.rows = rows;
    state.page = page;
    state.pageCount = pageCount;
    state.total = total;
    return state;
}

} // namespace

// columnConfig.js COLUMNS, read at run time: 12 columns in the same order with the same labels, and
// distributedAt is the only one hidden by default - so the P4 list shows the other 11 (override L97/L100).
void ListScreenTest::catalogMatchesTheCanonicalColumns()
{
    QString error;
    const QString source = repoText(QStringLiteral("web/src/view/columnConfig.js"), &error);
    QVERIFY2(!source.isEmpty(), qPrintable(error));
    const QRegularExpression entry(
        QStringLiteral(R"re(\{\s*key:\s*'([A-Za-z]+)',\s*label:\s*'([^']+)'(\s*,\s*defaultVisible:\s*false)?\s*\})re"));
    QList<ListColumn> canonical;
    for (auto it = entry.globalMatch(source); it.hasNext();) {
        const QRegularExpressionMatch m = it.next();
        canonical << ListColumn{m.captured(1), m.captured(2), m.captured(3).isEmpty()};
    }
    QCOMPARE(canonical.size(), 12);

    const QList<ListColumn> &catalog = ui::listColumnCatalog();
    QCOMPARE(catalog.size(), canonical.size());
    for (int i = 0; i < catalog.size(); ++i) {
        QCOMPARE(catalog.at(i).key, canonical.at(i).key);
        QCOMPARE(catalog.at(i).label, canonical.at(i).label);
        QCOMPARE(catalog.at(i).defaultVisible, canonical.at(i).defaultVisible);
    }

    const QList<ListColumn> shown = ui::listColumns();
    QCOMPARE(shown.size(), 11);
    QStringList keys;
    for (const ListColumn &column : shown)
        keys << column.key;
    QCOMPARE(keys, (QStringList{QStringLiteral("articleId"), QStringLiteral("title"), QStringLiteral("author"),
                                QStringLiteral("modifier"), QStringLiteral("department"), QStringLiteral("departmentCode"),
                                QStringLiteral("createdAt"), QStringLiteral("editedAt"), QStringLiteral("sentAt"),
                                QStringLiteral("status"), QStringLiteral("lockYN")}));
}

// listFormat.js applyDateFormat with DEFAULT_DATE_FORMAT: the digits of the stored string, no zone shift.
void ListScreenTest::formatsTimesInTheDefaultFormat_data()
{
    QTest::addColumn<QString>("iso");
    QTest::addColumn<QString>("shown");

    QTest::newRow("UTC with millis") << QStringLiteral("2026-09-12T03:04:05.678Z") << QStringLiteral("2026-09-12 03:04");
    QTest::newRow("space separator") << QStringLiteral("2026-09-12 23:59:00") << QStringLiteral("2026-09-12 23:59");
    QTest::newRow("no seconds") << QStringLiteral("2026-01-02T00:00") << QStringLiteral("2026-01-02 00:00");
    QTest::newRow("empty") << QString() << QString();
    QTest::newRow("not a date - kept") << QStringLiteral("어제") << QStringLiteral("어제");
    QTest::newRow("date only - kept") << QStringLiteral("2026-09-12") << QStringLiteral("2026-09-12");
}

void ListScreenTest::formatsTimesInTheDefaultFormat()
{
    QFETCH(QString, iso);
    QFETCH(QString, shown);
    QCOMPARE(ui::formatListTime(iso), shown);
}

// formatCell: the four time columns are formatted, anything else is JS String(value), '' for nothing.
void ListScreenTest::formatsOtherCellsAsStrings()
{
    for (const QString &key : {QStringLiteral("createdAt"), QStringLiteral("editedAt"), QStringLiteral("sentAt"),
                               QStringLiteral("distributedAt")})
        QCOMPARE(ui::formatListCell(key, QJsonValue(QStringLiteral("2026-09-12T03:04:05Z"))), QStringLiteral("2026-09-12 03:04"));
    QCOMPARE(ui::formatListCell(QStringLiteral("sentAt"), QJsonValue(QJsonValue::Null)), QString());
    QCOMPARE(ui::formatListCell(QStringLiteral("title"), QJsonValue(QStringLiteral("2026-09-12T03:04:05Z"))),
             QStringLiteral("2026-09-12T03:04:05Z"));
    QCOMPARE(ui::formatListCell(QStringLiteral("lockYN"), QJsonValue(QStringLiteral("N"))), QStringLiteral("N"));
    QCOMPARE(ui::formatListCell(QStringLiteral("author"), QJsonValue(QJsonValue::Undefined)), QString());
    QCOMPARE(ui::formatListCell(QStringLiteral("author"), QJsonValue(QJsonValue::Null)), QString());
    QCOMPARE(ui::formatListCell(QStringLiteral("departmentCode"), QJsonValue(42)), QStringLiteral("42"));
    QCOMPARE(ui::formatListCell(QStringLiteral("departmentCode"), QJsonValue(true)), QStringLiteral("true"));
}

// statusBadge.js, read at run time: every status the web colours gets the same label and colours; an
// unknown one the grey fallback with its own text. The UI_GUIDE table's six are pinned by value too.
void ListScreenTest::coloursBadgesLikeTheWeb()
{
    QString error;
    const QString source = repoText(QStringLiteral("web/src/view/statusBadge.js"), &error);
    QVERIFY2(!source.isEmpty(), qPrintable(error));
    const QRegularExpression entry(QStringLiteral(
        R"re(([A-Z]{3}):\s*\{\s*label:\s*'([^']*)',\s*bg:\s*'(#[0-9a-fA-F]+)',\s*fg:\s*'(#[0-9a-fA-F]+)'\s*\})re"));
    int seen = 0;
    for (auto it = entry.globalMatch(source); it.hasNext();) {
        const QRegularExpressionMatch m = it.next();
        const ui::StatusBadge badge = ui::statusBadgeFor(m.captured(1));
        QCOMPARE(badge.label, m.captured(2));
        QCOMPARE(badge.background, m.captured(3));
        QCOMPARE(badge.foreground, m.captured(4));
        ++seen;
    }
    QCOMPARE(seen, 11);

    const QList<QStringList> guide{{QStringLiteral("RDS"), QStringLiteral("#e8e8e8"), QStringLiteral("#555")},
                                   {QStringLiteral("DPS"), QStringLiteral("#c8102e"), QStringLiteral("#fff")},
                                   {QStringLiteral("RRH"), QStringLiteral("#d97706"), QStringLiteral("#fff")},
                                   {QStringLiteral("DDH"), QStringLiteral("#d97706"), QStringLiteral("#fff")},
                                   {QStringLiteral("RRK"), QStringLiteral("#374151"), QStringLiteral("#fff")},
                                   {QStringLiteral("DDK"), QStringLiteral("#374151"), QStringLiteral("#fff")}};
    for (const QStringList &g : guide) {
        QCOMPARE(ui::statusBadgeFor(g.at(0)).background, g.at(1));
        QCOMPARE(ui::statusBadgeFor(g.at(0)).foreground, g.at(2));
    }
    const ui::StatusBadge unknown = ui::statusBadgeFor(QStringLiteral("XYZ"));
    QCOMPARE(unknown.label, QStringLiteral("XYZ"));
    QCOMPARE(unknown.background, QStringLiteral("#e8e8e8"));
    QCOMPARE(unknown.foreground, QStringLiteral("#555"));
}

// The page it is handed, in the 11 columns: header labels in catalog order, times formatted and
// centred, the status as its code (the delegate paints the badge), distributedAt nowhere.
void ListScreenTest::rendersTheCurrentPageInElevenColumns()
{
    ListScreen screen;
    QTableWidget *table = tableOf(screen);
    QVERIFY(table);
    QCOMPARE(table->columnCount(), 11);
    const QList<ListColumn> columns = ui::listColumns();
    for (int i = 0; i < columns.size(); ++i)
        QCOMPARE(table->horizontalHeaderItem(i)->text(), columns.at(i).label);

    QJsonObject second = sampleRow();
    second.insert(QStringLiteral("articleId"), QStringLiteral("AKR20260912000100002"));
    second.insert(QStringLiteral("status"), QStringLiteral("RDS"));
    screen.render(stateWith({sampleRow(), second}, 1, 1, 2));

    QCOMPARE(screen.rowCount(), 2);
    QCOMPARE(screen.cellText(0, columnOf(QStringLiteral("articleId"))), QStringLiteral("AKR20260912000100001"));
    QCOMPARE(screen.cellText(0, columnOf(QStringLiteral("title"))), QStringLiteral("국회 본회의 개최"));
    QCOMPARE(screen.cellText(0, columnOf(QStringLiteral("createdAt"))), QStringLiteral("2026-09-12 03:04"));
    QCOMPARE(screen.cellText(0, columnOf(QStringLiteral("editedAt"))), QStringLiteral("2026-09-12 04:05"));
    QCOMPARE(screen.cellText(0, columnOf(QStringLiteral("sentAt"))), QString());
    QCOMPARE(screen.cellText(0, columnOf(QStringLiteral("status"))), QStringLiteral("DDH"));
    QCOMPARE(screen.cellText(1, columnOf(QStringLiteral("status"))), QStringLiteral("RDS"));
    QCOMPARE(screen.cellText(0, columnOf(QStringLiteral("lockYN"))), QStringLiteral("Y"));
    for (int c = 0; c < table->columnCount(); ++c)
        QVERIFY(!screen.cellText(0, c).contains(QStringLiteral("05:06")));  // distributedAt is not shown

    const int created = columnOf(QStringLiteral("createdAt"));
    const int title = columnOf(QStringLiteral("title"));
    QVERIFY(table->item(0, created)->textAlignment() & Qt::AlignHCenter);
    QVERIFY(!(table->item(0, title)->textAlignment() & Qt::AlignHCenter));

    screen.render(stateWith({}, 1, 1, 0));  // a re-render replaces, never appends
    QCOMPARE(screen.rowCount(), 0);
}

void ListScreenTest::pagerFollowsThePage()
{
    ListScreen screen;
    QPushButton *previous = screen.findChild<QPushButton *>(QStringLiteral("previousPageButton"));
    QPushButton *next = screen.findChild<QPushButton *>(QStringLiteral("nextPageButton"));
    QVERIFY(previous && next);
    QSignalSpy wantPrevious(&screen, &ListScreen::previousPageRequested);
    QSignalSpy wantNext(&screen, &ListScreen::nextPageRequested);

    screen.render(stateWith({sampleRow()}, 1, 3, 23));
    QVERIFY(!previous->isEnabled());
    QVERIFY(next->isEnabled());
    QVERIFY2(screen.pageText().contains(QStringLiteral("1 / 3")), qPrintable(screen.pageText()));
    QVERIFY2(screen.pageText().contains(QStringLiteral("23")), qPrintable(screen.pageText()));
    next->click();
    QCOMPARE(wantNext.count(), 1);

    screen.render(stateWith({sampleRow()}, 3, 3, 23));
    QVERIFY(previous->isEnabled());
    QVERIFY(!next->isEnabled());
    previous->click();
    QCOMPARE(wantPrevious.count(), 1);

    screen.render(stateWith({}, 1, 1, 0));
    QVERIFY(!previous->isEnabled());
    QVERIFY(!next->isEnabled());
}

void ListScreenTest::showsAQueryErrorAboveTheRows()
{
    ListScreen screen;
    ui::ListViewState state = stateWith({sampleRow()}, 1, 1, 1);
    screen.render(state);
    QVERIFY(screen.errorText().isEmpty());

    state.error = QStringLiteral("목록을 불러오지 못했습니다.");
    screen.render(state);
    QCOMPARE(screen.errorText(), state.error);
    QCOMPARE(screen.rowCount(), 1);  // the rows it had stay
}

// excluded (b): no context menu, no double-click action, no editing, no selection - and nothing in the
// source that would open a menu, a dialog or an article.
void ListScreenTest::isReadOnly()
{
    ListScreen screen;
    QTableWidget *table = tableOf(screen);
    QVERIFY(table);
    QCOMPARE(table->editTriggers(), QAbstractItemView::NoEditTriggers);
    QCOMPARE(table->contextMenuPolicy(), Qt::NoContextMenu);
    QCOMPARE(table->selectionMode(), QAbstractItemView::NoSelection);

    QString error;
    const QString source = repoText(QStringLiteral("client-qt/src/ui/listscreen.cpp"), &error);
    QVERIFY2(source.size() > 500, qPrintable(error));
    for (const QString &token : {QStringLiteral("doubleClicked"), QStringLiteral("customContextMenuRequested"),
                                 QStringLiteral("contextMenuEvent"), QStringLiteral("QMenu"), QStringLiteral("QDialog"),
                                 QStringLiteral("INewsModel"), QStringLiteral("lockArticle"), QStringLiteral("getArticle")})
        QVERIFY2(!source.contains(token), qPrintable(QStringLiteral("listscreen.cpp names ") + token));
}

// UI_GUIDE layout: a 48 px top bar; the live indicator sits on its right on the list page only, and
// says connected / dropped. The page switches are announced exactly once each.
void ListScreenTest::topBarIs48PxWithALiveIndicatorOnTheListPage()
{
    ui::MainWindow window(QStringLiteral("http://127.0.0.1:3001"));
    QFrame *topBar = window.findChild<QFrame *>(QStringLiteral("topBar"));
    QVERIFY(topBar);
    QCOMPARE(topBar->minimumHeight(), ui::theme::kTopBarHeight);
    QCOMPARE(topBar->maximumHeight(), ui::theme::kTopBarHeight);
    QCOMPARE(ui::theme::kTopBarHeight, 48);
    QVERIFY(window.listScreen());
    QVERIFY(window.loginPageShown());
    QVERIFY(!window.liveStatusVisible());

    QSignalSpy entered(&window, &ui::MainWindow::listPageEntered);
    QSignalSpy left(&window, &ui::MainWindow::listPageLeft);
    window.showListPage();
    window.showListPage();
    QCOMPARE(entered.count(), 1);
    QVERIFY(window.liveStatusVisible());
    window.setLiveStatus(true);
    QVERIFY2(window.liveStatusText().contains(QStringLiteral("실시간")), qPrintable(window.liveStatusText()));
    window.setLiveStatus(false);
    QVERIFY2(window.liveStatusText().contains(QStringLiteral("연결 끊김")), qPrintable(window.liveStatusText()));

    window.showLoginPage();
    QCOMPARE(left.count(), 1);
    QVERIFY(!window.liveStatusVisible());
}
