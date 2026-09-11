#ifndef CLIENT_QT_UI_LISTSCREEN_H
#define CLIENT_QT_UI_LISTSCREEN_H

// The article list screen (phase 77 step11 B) - one of the three P4 screens (login, list, setup). It
// lives in the main window's content area (ui::MainWindow), on the page after login.
//
// A view: it renders the ListViewState it is handed and emits the paging the user asked for. It holds
// no Model and no controller (the shell wires them - shell::AppShell). READ ONLY on purpose (excluded
// (b)): no context menu, no double-click action, no editing, no detail window, no column settings -
// those are P7's, and building them now would stand an action matrix on a cached identity.
//
// What it shows (docs/UI_GUIDE.md table): the 11 default columns of the web's catalog
// (web/src/view/columnConfig.js - 12 columns, distributedAt hidden by default: override L97/L100), times
// in the fixed default format YYYY-MM-DD HH:mm, centred (override L104 - the global date-format setting
// is P6's), the status as a badge in the web's colours (web/src/view/statusBadge.js = the UI_GUIDE
// tokens), a blue-tinted hover row, 10 rows a page with a pager.

#include "ui/listcontroller.h"

#include <QJsonValue>
#include <QList>
#include <QString>
#include <QStringList>
#include <QWidget>

class QEvent;
class QLabel;
class QPushButton;
class QTableWidget;

namespace ui {

// One column of the catalog (columnConfig.js COLUMNS, same order and labels).
struct ListColumn {
    QString key;
    QString label;
    bool defaultVisible = true;
};

const QList<ListColumn> &listColumnCatalog();  // 12
QList<ListColumn> listColumns();                // the 11 shown in P4 (the catalog's default-visible ones)

// listFormat.js with the default format: 'YYYY-MM-DD HH:mm' cut from the ISO string itself (no time
// zone arithmetic). Empty for no value; the original text when it is not an ISO date-time.
QString formatListTime(const QString &iso);
// listFormat.js formatCell: the four time columns get formatListTime, anything else JS String(value)
// ('' for null / absent).
QString formatListCell(const QString &key, const QJsonValue &value);

// statusBadge.js - the badge colours per status; an unknown status gets the grey fallback with its own
// text as the label.
struct StatusBadge {
    QString label;
    QString background;
    QString foreground;
};
StatusBadge statusBadgeFor(const QString &status);

class ListScreen : public QWidget
{
    Q_OBJECT

public:
    explicit ListScreen(QWidget *parent = nullptr);

    void render(const ListViewState &state);

    // Observation points (tests, the harness has no pixels).
    int rowCount() const;
    QString cellText(int row, int column) const;
    QString pageText() const;
    QString errorText() const;

signals:
    void previousPageRequested();
    void nextPageRequested();

protected:
    // The hovered row (UI_GUIDE: the whole row gets the blue tint, not one cell) - tracked on the table's
    // viewport. Nothing else is read from the mouse: no click, double-click or context-menu action.
    bool eventFilter(QObject *watched, QEvent *event) override;

private:
    void setHoveredRow(int row);

    QLabel *m_title = nullptr;
    QLabel *m_error = nullptr;
    QTableWidget *m_table = nullptr;
    QPushButton *m_previous = nullptr;
    QPushButton *m_next = nullptr;
    QLabel *m_page = nullptr;
    int m_hoveredRow = -1;  // read by the cell painter
};

} // namespace ui

#endif // CLIENT_QT_UI_LISTSCREEN_H
