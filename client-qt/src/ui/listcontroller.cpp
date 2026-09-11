#include "ui/listcontroller.h"

#include "shell/diag.h"
#include "ui/logincontroller.h"

#include <QJsonArray>
#include <QJsonValue>
#include <QVariant>

#include <algorithm>
#include <utility>

namespace ui {
namespace {

// A query that failed WITHOUT ending the session. Told apart by the Model's outcome (never the reason
// token - the login screen's rule 1), with the same sentences for the three "no usable answer" kinds.
QString queryFailureMessage(const net::ModelResult &result)
{
    const LoginFailure failure = loginFailureFor(result.outcome);
    if (failure == LoginFailure::Unreachable || failure == LoginFailure::TimedOut
        || failure == LoginFailure::InvalidResponse)
        return QStringLiteral("목록을 불러오지 못했습니다. ") + loginFailureMessage(failure);
    return result.status >= 0 ? QStringLiteral("목록을 불러오지 못했습니다(HTTP %1).").arg(result.status)
                              : QStringLiteral("목록을 불러오지 못했습니다.");
}

} // namespace

QString deskUnsentMenu()
{
    return QStringLiteral("deskUnsent");
}

QVariantMap deskUnsentFilter()
{
    // A list, so buildQuery repeats the key (status=RDS&status=DDH - the server reads an IN).
    return QVariantMap{{QStringLiteral("status"), QStringList{QStringLiteral("RDS"), QStringLiteral("DDH")}}};
}

int pageCountFor(int itemCount)
{
    return itemCount <= 0 ? 1 : (itemCount + kListPageSize - 1) / kListPageSize;
}

QList<QJsonObject> pageSlice(const QList<QJsonObject> &items, int page)
{
    const qsizetype first = qsizetype(qMax(1, page) - 1) * kListPageSize;
    if (first >= items.size())
        return {};
    return items.mid(first, kListPageSize);
}

QList<QJsonObject> newestFirst(QList<QJsonObject> items)
{
    // ISO-8601 strings of one format order as text. Stable: equal times keep the server's order; a row
    // without a time ("") sorts last.
    std::stable_sort(items.begin(), items.end(), [](const QJsonObject &a, const QJsonObject &b) {
        return a.value(QStringLiteral("createdAt")).toString() > b.value(QStringLiteral("createdAt")).toString();
    });
    return items;
}

QStringList listControllerDiagEvents()
{
    return {QStringLiteral("session"), QStringLiteral("list-loaded")};
}

ListController::ListController(net::INewsModel &model, shell::Diag *diag, QObject *parent)
    : QObject(parent), m_model(model), m_diag(diag), m_filter(deskUnsentFilter())
{
}

ListController::~ListController()
{
    // Quietly: the stream goes and nobody is told (the screen may already be gone).
    m_subscription.reset();
}

ListEntry ListController::enter()
{
    leave();  // afresh: nothing of a previous entry survives - its stream, its rows

    ListEntry entry;
    const SessionCheck check = checkSession(m_model, m_diag);  // rule 4: asked, never remembered
    entry.sessionStatus = check.status;
    if (!check.ok) {
        entry.message = check.message;  // fail-closed: nothing is queried, nothing is subscribed
        return entry;
    }

    m_entered = true;
    m_page = 1;
    if (runQuery() == QueryResult::SessionEnded || !m_entered) {
        leave();
        entry.message = sessionEndedMessage();
        return entry;  // the entry's own answer - no sessionEnded signal for it
    }

    // The stream last: its ready says "connected" and nothing more (rule 2); its change is a re-query.
    m_subscription = m_model.subscribe(
        m_filter, [this](const QJsonObject &, const QVariantMap &) { onStreamEvent(StreamEvent::Change); },
        [this](bool connected) { onStreamEvent(connected ? StreamEvent::Ready : StreamEvent::Dropped); },
        [this] { onStreamEvent(StreamEvent::SessionEnd); });

    entry.ok = true;
    entry.identityLabel = check.identityLabel;
    return entry;
}

void ListController::refresh()
{
    if (!m_entered)
        return;  // no list on screen - a late change after leave() queries nothing
    if (m_querying) {
        m_dirty = true;  // rule 3: merged into the ONE follow-up of the query that is running
        return;
    }
    do {
        m_dirty = false;
        if (runQuery() == QueryResult::SessionEnded) {
            endSession();
            return;
        }
    } while (m_dirty && m_entered);  // a change during the query earned exactly one more
}

void ListController::leave()
{
    m_entered = false;
    m_dirty = false;
    if (m_subscription) {
        const std::unique_ptr<net::Subscription> subscription = std::move(m_subscription);
        subscription->unsubscribe();
    }
    setLive(false);
    if (!m_items.isEmpty() || !m_error.isEmpty() || m_page != 1) {
        m_items.clear();  // no row outlives the page it was shown on
        m_error.clear();
        m_page = 1;
        emit listChanged();
    }
}

void ListController::onStreamEvent(StreamEvent event)
{
    switch (event) {
    case StreamEvent::Ready:
        if (m_entered)
            setLive(true);  // rule 2: connected - NOT a re-query (the entry query already ran)
        return;
    case StreamEvent::Dropped:
        setLive(false);
        return;
    case StreamEvent::Change:
        refresh();  // rule 1: the whole list again, same filter, whatever changed
        return;
    case StreamEvent::SessionEnd:
        endSession();
        return;
    }
}

void ListController::setPage(int page)
{
    const int clamped = qBound(1, page, pageCount());
    if (clamped == m_page)
        return;
    m_page = clamped;
    emit listChanged();
}

void ListController::nextPage()
{
    setPage(m_page + 1);
}

void ListController::previousPage()
{
    setPage(m_page - 1);
}

bool ListController::isEntered() const
{
    return m_entered;
}

bool ListController::live() const
{
    return m_live;
}

QString ListController::menu() const
{
    return deskUnsentMenu();
}

QVariantMap ListController::filter() const
{
    return m_filter;
}

int ListController::page() const
{
    return m_page;
}

int ListController::pageCount() const
{
    return pageCountFor(total());
}

int ListController::total() const
{
    return static_cast<int>(m_items.size());
}

QList<QJsonObject> ListController::items() const
{
    return m_items;
}

QList<QJsonObject> ListController::pageItems() const
{
    return pageSlice(m_items, m_page);
}

QString ListController::errorText() const
{
    return m_error;
}

ListViewState ListController::viewState() const
{
    ListViewState state;
    state.menu = menu();
    state.rows = pageItems();
    state.page = m_page;
    state.pageCount = pageCount();
    state.total = total();
    state.error = m_error;
    return state;
}

ListController::QueryResult ListController::runQuery()
{
    m_querying = true;
    const net::ModelResult result = m_model.queryArticles(m_filter);
    m_querying = false;

    if (!m_entered)
        return QueryResult::Left;  // left while the answer was on its way (the stream ended the session)
    if (result.outcome == net::Outcome::Unauthenticated)
        return QueryResult::SessionEnded;
    if (result.outcome != net::Outcome::Ok || !result.ok()) {
        m_error = queryFailureMessage(result);  // the rows it had stay on screen
        emit listChanged();
        return QueryResult::Failed;
    }

    QList<QJsonObject> items;
    for (const QJsonValue &value : result.body.value(QStringLiteral("items")).toArray()) {
        if (value.isObject())
            items << value.toObject();
    }
    m_items = newestFirst(items);
    m_page = qMin(m_page, pageCount());  // a shrunk list pulls the page back into range
    m_error.clear();

    // rule 5: the menu id and a number - never a row. The line first, then the signal.
    if (m_diag)
        m_diag->log(QStringLiteral("list-loaded"),
                    QVariantMap{{QStringLiteral("menu"), deskUnsentMenu()}, {QStringLiteral("count"), total()}});
    emit listChanged();
    return QueryResult::Applied;
}

void ListController::endSession()
{
    if (!m_entered)
        return;  // already over - the first report is the one that counts
    leave();
    emit sessionEnded(sessionEndedMessage());
}

void ListController::setLive(bool live)
{
    if (m_live == live)
        return;
    m_live = live;
    emit liveChanged(live);
}

} // namespace ui
