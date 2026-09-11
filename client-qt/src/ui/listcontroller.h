#ifndef CLIENT_QT_UI_LISTCONTROLLER_H
#define CLIENT_QT_UI_LISTCONTROLLER_H

// The list controller (phase 77 step11 A) - the Qt counterpart of web/src/controller/
// useViewController.js, cut down to what P4 owns: ONE menu (deskUnsent), read only, client paging.
// ADR-003: View <- Controller <- Model. It knows the Model interface and the diag sink and nothing
// else - no widget type, no transport - so every rule below is tested on FakeNewsModel.
//
// The rules this file exists for:
//   1. A CHANGE SIGNAL RE-QUERIES THE WHOLE LIST WITH THE SAME FILTER, WHATEVER ITS KIND (override
//      L80, ADR-005, useViewController.js:143-147). The server sends no row data; the controller does
//      not even receive the kind (onStreamEvent takes none), so it cannot branch on it.
//   2. ONLY A CHANGE SIGNAL OR A USER ACTION RE-QUERIES. The stream's ready is not one (the entry
//      query already ran) and there is no timer of any kind. The step11 gate counts articles-list
//      calls - exactly 2 (entry + one change) - and that count stands on this rule: a polling client
//      makes more.
//   3. RE-QUERIES MERGE, THEY ARE NEVER DROPPED. The real transport's send() waits in a local event
//      loop, so a change can arrive while a query is running (step9). That change does not start a second,
//      overlapping query; it marks the list dirty, and exactly ONE follow-up query runs when the
//      current one ends - however many changes arrived meanwhile. Dropping it would leave the list
//      stale; overlapping would let an older answer land after a newer one.
//   4. NO IDENTITY IS KEPT (decisions (7), override L123-128). enter() asks the server who we are
//      (GET /api/session) every time the list is entered; the answer's display label is handed to the
//      caller and not stored. A 401 anywhere (the identity check, a query, the stream's unauthorized
//      frame) ends the session: the stream is closed for good and the caller goes back to login.
//   5. The diag gets list-loaded{menu, count} - a menu id and a number, never a title or an id.
//
// Paging is the client's (the contract has none - baseline (F)): 10 rows a page. Rows are shown
// newest first by createdAt (the server's ORDER BY is not in the contract, so the client keeps the
// order itself - a stable sort, a no-op on a server that already sends that order).

#include "net/newsmodel.h"

#include <QJsonObject>
#include <QList>
#include <QObject>
#include <QString>
#include <QStringList>
#include <QVariantMap>

#include <memory>

namespace shell {
class Diag;
} // namespace shell

namespace ui {

inline constexpr int kListPageSize = 10;  // useViewController.js PAGE_SIZE

// The one P4 menu and its filter (useViewController.js:70-72 - departments stay '전체', i.e. absent).
QString deskUnsentMenu();
QVariantMap deskUnsentFilter();

// Pure paging and ordering.
int pageCountFor(int itemCount);  // max(1, ceil(n / 10))
QList<QJsonObject> pageSlice(const QList<QJsonObject> &items, int page);
QList<QJsonObject> newestFirst(QList<QJsonObject> items);  // stable, by createdAt descending

// Every diag event this controller writes (both inside shell::allowedDiagEvents()).
QStringList listControllerDiagEvents();

// What the stream reported, as the Model's subscription hands it over. Change carries no kind: the
// kind is not this controller's business (rule 1).
enum class StreamEvent { Ready, Change, Dropped, SessionEnd };

// The result of entering the list: the identity check and the entry query.
struct ListEntry {
    bool ok = false;         // the server confirmed the session (the list may still show a query error)
    int sessionStatus = -1;  // GET /api/session's status, -1 without an answer
    QString identityLabel;   // display only
    QString message;         // why the list could not be entered (empty on success)
};

// Everything the list screen shows, in one value (the view pulls nothing else).
struct ListViewState {
    QString menu;
    QList<QJsonObject> rows;  // the current page, newest first
    int page = 1;
    int pageCount = 1;
    int total = 0;
    QString error;            // a query that failed without ending the session; empty otherwise
};

class ListController : public QObject
{
    Q_OBJECT

public:
    // model: not owned, outlives the controller. diag may be null.
    ListController(net::INewsModel &model, shell::Diag *diag, QObject *parent = nullptr);
    ~ListController() override;  // closes its stream

    // GET /api/session (the identity, again) -> the entry query -> the change stream. Not ok when the
    // session could not be confirmed (nothing is queried or subscribed then) or when the entry query
    // said the session is gone. A second enter() starts afresh.
    ListEntry enter();
    // The whole list again, same filter (a change signal, or a user action). Merged while a query runs.
    void refresh();
    // Closes the stream; later changes do nothing. Idempotent.
    void leave();
    // The stream, as subscribe()'s handlers report it (rule 1-2: ready never re-queries).
    void onStreamEvent(StreamEvent event);

    // Paging (user actions - never a query).
    void setPage(int page);
    void nextPage();
    void previousPage();

    bool isEntered() const;
    bool live() const;
    QString menu() const;
    QVariantMap filter() const;
    int page() const;
    int pageCount() const;
    int total() const;
    QList<QJsonObject> items() const;      // every row, newest first
    QList<QJsonObject> pageItems() const;  // the current page
    QString errorText() const;
    ListViewState viewState() const;

signals:
    void listChanged();                         // rows, page or error changed - re-render
    void liveChanged(bool live);                // the stream's ready / drop
    void sessionEnded(const QString &message);  // after enter(): a 401 or the unauthorized frame

private:
    enum class QueryResult { Applied, Failed, SessionEnded, Left };
    QueryResult runQuery();
    void endSession();
    void setLive(bool live);

    net::INewsModel &m_model;
    shell::Diag *m_diag = nullptr;
    const QVariantMap m_filter;
    std::unique_ptr<net::Subscription> m_subscription;
    QList<QJsonObject> m_items;
    int m_page = 1;
    QString m_error;
    bool m_entered = false;
    bool m_live = false;
    bool m_querying = false;
    bool m_dirty = false;
};

} // namespace ui

#endif // CLIENT_QT_UI_LISTCONTROLLER_H
