#include "listcontrollertest.h"

#include "loginwire.h"
#include "repofiles.h"
#include "stubhttpserver.h"

#include "net/fakenewsmodel.h"
#include "net/httpnewsmodel.h"
#include "net/httptransport.h"
#include "net/newsmodel.h"
#include "shell/diag.h"
#include "ui/listcontroller.h"
#include "ui/logincontroller.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QSet>
#include <QSignalSpy>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QTimer>
#include <QVariantMap>
#include <QtTest>

#include <functional>
#include <optional>
#include <type_traits>

using ui::ListController;
using ui::StreamEvent;

namespace {

// A diag sink in a temporary folder, read back line by line.
struct DiagFile {
    QTemporaryDir dir;
    shell::Diag diag;

    DiagFile() : diag(QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"))) {}

    QByteArray raw() const
    {
        QFile file(diag.filePath());
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray();
    }

    QList<QJsonObject> events() const
    {
        QList<QJsonObject> out;
        for (const QByteArray &line : raw().split('\n')) {
            if (!line.trimmed().isEmpty())
                out << QJsonDocument::fromJson(line).object();
        }
        return out;
    }

    QList<QJsonObject> named(const QString &name) const
    {
        QList<QJsonObject> out;
        for (const QJsonObject &event : events()) {
            if (event.value(QStringLiteral("event")).toString() == name)
                out << event;
        }
        return out;
    }

    QList<int> listCounts() const
    {
        QList<int> counts;
        for (const QJsonObject &event : named(QStringLiteral("list-loaded")))
            counts << event.value(QStringLiteral("count")).toInt(-1);
        return counts;
    }
};

QJsonObject row(const QString &id, const QString &status, const QString &createdAt, const QString &title = QString())
{
    QJsonObject r{{QStringLiteral("articleId"), id},
                  {QStringLiteral("status"), status},
                  {QStringLiteral("title"), title.isEmpty() ? QStringLiteral("제목 ") + id : title},
                  {QStringLiteral("author"), QStringLiteral("김기자")},
                  {QStringLiteral("lockYN"), QStringLiteral("N")}};
    if (!createdAt.isEmpty())
        r.insert(QStringLiteral("createdAt"), createdAt);
    return r;
}

// n rows, all inside the deskUnsent filter, created one minute apart (newest last in the list).
QList<QJsonObject> rows(int n)
{
    QList<QJsonObject> out;
    for (int i = 0; i < n; ++i) {
        out << row(QStringLiteral("AKR%1").arg(i, 4, 10, QLatin1Char('0')), QStringLiteral("RDS"),
                   QStringLiteral("2026-09-01T00:%1:00.000Z").arg(i % 60, 2, 10, QLatin1Char('0')));
    }
    return out;
}

net::FakeSeed seedWith(const QList<QJsonObject> &articles)
{
    net::FakeSeed seed = loginwire::deskSeed();
    seed.articles = articles;
    return seed;
}

// A new article the fake stores as RDS (saveArticle without an id = articles-create).
QJsonObject newArticle(int n)
{
    return QJsonObject{{QStringLiteral("title"), QStringLiteral("새 기사 %1").arg(n)},
                       {QStringLiteral("createdAt"), QStringLiteral("2026-09-02T00:00:%1.000Z").arg(n, 2, 10, QLatin1Char('0'))}};
}

net::ModelResult okItems(const QList<QJsonObject> &items)
{
    QJsonArray array;
    for (const QJsonObject &item : items)
        array.append(item);
    const QByteArray body = QJsonDocument(QJsonObject{{QStringLiteral("ok"), true}, {QStringLiteral("items"), array}})
                                .toJson(QJsonDocument::Compact);
    return net::modelResultFrom(loginwire::wireAnswer(QStringLiteral("articles-list"), 200, body));
}

// The fake, with every list-relevant call counted and ordered. queryArticles can answer scripted rows
// or a scripted wire answer, and can run a hook INSIDE a query - after its answer was computed, before
// it returns - which is exactly where a change lands while the real transport waits in send().
class CountingModel : public loginwire::WireScriptedModel
{
public:
    explicit CountingModel(const net::FakeSeed &seed = loginwire::deskSeed()) : WireScriptedModel(seed) {}

    int queryCalls = 0;
    int subscribeCalls = 0;
    int depth = 0;
    int maxDepth = 0;
    QStringList calls;
    QList<QVariantMap> filters;
    std::optional<QList<QJsonObject>> scriptedItems;
    std::optional<net::HttpResponse> queryWire;
    std::function<void()> duringQuery;  // one shot; a hook may re-arm it

    // A new article (articles-create) through the interface - the interface holds the default
    // arguments, an override hides them (step8).
    net::ModelResult saveArticle(const QJsonObject &dto)
    {
        return static_cast<net::INewsModel &>(*this).saveArticle(dto);
    }

    net::ModelResult restoreSession() override
    {
        calls << QStringLiteral("session");
        return WireScriptedModel::restoreSession();
    }

    net::ModelResult queryArticles(const QVariantMap &filter) override
    {
        ++queryCalls;
        calls << QStringLiteral("query");
        filters << filter;
        ++depth;
        maxDepth = qMax(maxDepth, depth);
        net::ModelResult result;
        if (queryWire)
            result = net::modelResultFrom(*queryWire);
        else if (scriptedItems)
            result = okItems(*scriptedItems);
        else
            result = FakeNewsModel::queryArticles(filter);
        if (duringQuery) {
            std::function<void()> hook;
            hook.swap(duringQuery);
            hook();
        }
        --depth;
        return result;
    }

    std::unique_ptr<net::Subscription> subscribe(const QVariantMap &filter, net::ChangeHandler onChange,
                                                 net::StatusHandler onStatus, net::SessionEndHandler onSessionEnd) override
    {
        ++subscribeCalls;
        calls << QStringLiteral("subscribe");
        return FakeNewsModel::subscribe(filter, std::move(onChange), std::move(onStatus), std::move(onSessionEnd));
    }
};

void logIn(CountingModel &model)
{
    // Straight on the fake: the server-side session the list controller then asks about.
    QVERIFY(model.login(loginwire::kUser, loginwire::kPassword).ok());
}

QString sourceText(const QString &relative)
{
    QByteArray bytes;
    QString error;
    if (!readRepoFile(relative, &bytes, &error))
        return QString();
    return QString::fromUtf8(bytes);
}

} // namespace

// ---------------------------------------------------------------------------
// The one P4 menu: deskUnsent = {status:['RDS','DDH']} (useViewController.js:70-72), handed to the Model
// as it is - and only RDS/DDH rows come back. M11-3 (RDS only) turns this red.
void ListControllerTest::queriesTheDeskUnsentFilter()
{
    QCOMPARE(ui::deskUnsentMenu(), QStringLiteral("deskUnsent"));
    const QVariantMap filter = ui::deskUnsentFilter();
    QCOMPARE(filter.keys(), QStringList{QStringLiteral("status")});
    QCOMPARE(filter.value(QStringLiteral("status")).toStringList(), (QStringList{QStringLiteral("RDS"), QStringLiteral("DDH")}));

    CountingModel model(seedWith({row(QStringLiteral("A1"), QStringLiteral("RDS"), QStringLiteral("2026-09-01T01:00:00.000Z")),
                                  row(QStringLiteral("A2"), QStringLiteral("DDH"), QStringLiteral("2026-09-01T02:00:00.000Z")),
                                  row(QStringLiteral("A3"), QStringLiteral("DPS"), QStringLiteral("2026-09-01T03:00:00.000Z")),
                                  row(QStringLiteral("A4"), QStringLiteral("RRH"), QStringLiteral("2026-09-01T04:00:00.000Z")),
                                  row(QStringLiteral("A5"), QStringLiteral("RRK"), QStringLiteral("2026-09-01T05:00:00.000Z"))}));
    logIn(model);
    ListController controller(model, nullptr);
    QCOMPARE(controller.filter(), filter);
    QCOMPARE(controller.menu(), QStringLiteral("deskUnsent"));

    QVERIFY(controller.enter().ok);
    QCOMPARE(model.filters.size(), 1);
    QCOMPARE(model.filters.at(0), filter);
    QCOMPARE(controller.total(), 2);
    QSet<QString> statuses;
    for (const QJsonObject &item : controller.items())
        statuses.insert(item.value(QStringLiteral("status")).toString());
    QCOMPARE(statuses, (QSet<QString>{QStringLiteral("RDS"), QStringLiteral("DDH")}));
}

// Entering = the identity asked of the server, THEN one query, THEN the stream - and the diag says
// session{200} then list-loaded{menu, count}.
void ListControllerTest::entersWithTheIdentityCheckThenOneQueryThenTheStream()
{
    CountingModel model(seedWith(rows(2)));
    logIn(model);
    DiagFile sink;
    ListController controller(model, &sink.diag);
    QSignalSpy changed(&controller, &ListController::listChanged);

    const ui::ListEntry entry = controller.enter();

    QVERIFY(entry.ok);
    QCOMPARE(entry.sessionStatus, 200);
    QCOMPARE(entry.identityLabel, QStringLiteral("desk · 편집부 · (D)"));
    QVERIFY(entry.message.isEmpty());
    QCOMPARE(model.calls, (QStringList{QStringLiteral("session"), QStringLiteral("query"), QStringLiteral("subscribe")}));
    QVERIFY(controller.isEntered());
    QVERIFY(controller.live());  // the fake's stream is connected at once (its ready)
    QVERIFY(changed.count() >= 1);
    QCOMPARE(controller.total(), 2);

    const QList<QJsonObject> events = sink.events();
    QCOMPARE(events.size(), 2);
    QCOMPARE(events.at(0).value(QStringLiteral("event")).toString(), QStringLiteral("session"));
    QCOMPARE(events.at(0).value(QStringLiteral("status")).toInt(), 200);
    QCOMPARE(events.at(1).value(QStringLiteral("event")).toString(), QStringLiteral("list-loaded"));
    QCOMPARE(events.at(1).value(QStringLiteral("menu")).toString(), QStringLiteral("deskUnsent"));
    QCOMPARE(events.at(1).value(QStringLiteral("count")).toInt(), 2);
}

// decisions (7): every entry asks again - a role changed between two entries shows at once - and a
// second entry replaces the first one's stream (one change = one query, not two).
void ListControllerTest::reasksTheServerOnEveryEntry()
{
    CountingModel model(seedWith(rows(1)));
    logIn(model);
    ListController controller(model, nullptr);
    QCOMPARE(controller.enter().identityLabel, QStringLiteral("desk · 편집부 · (D)"));

    model.updateUser(loginwire::kUser,
                     QJsonObject{{QStringLiteral("role"), QStringLiteral("Z")}, {QStringLiteral("department"), QStringLiteral("운영부")}});
    const ui::ListEntry again = controller.enter();
    QVERIFY(again.ok);
    QCOMPARE(again.identityLabel, QStringLiteral("desk · 운영부 · (Z)"));
    QCOMPARE(model.sessionCalls, 2);
    QCOMPARE(model.subscribeCalls, 2);

    const int before = model.queryCalls;
    model.saveArticle(newArticle(1));
    QCOMPARE(model.queryCalls, before + 1);
}

// Fail-closed: no confirmed session -> nothing is queried, nothing is subscribed, and the caller is told
// why (a 401 = the session is over; no answer = the server could not be reached).
void ListControllerTest::refusesToEnterWithoutAConfirmedSession()
{
    CountingModel model(seedWith(rows(3)));  // never logged in: the server has no session for us
    DiagFile sink;
    ListController controller(model, &sink.diag);

    const ui::ListEntry denied = controller.enter();
    QVERIFY(!denied.ok);
    QCOMPARE(denied.sessionStatus, 401);
    QCOMPARE(denied.message, ui::sessionEndedMessage());
    QVERIFY(denied.identityLabel.isEmpty());
    QCOMPARE(model.queryCalls, 0);
    QCOMPARE(model.subscribeCalls, 0);
    QVERIFY(!controller.isEntered());
    QCOMPARE(controller.total(), 0);
    QCOMPARE(sink.named(QStringLiteral("list-loaded")).size(), 0);

    model.sessionWire = loginwire::noAnswer(net::Outcome::NetworkError);
    const ui::ListEntry unreachable = controller.enter();
    QVERIFY(!unreachable.ok);
    QCOMPARE(unreachable.sessionStatus, -1);
    QCOMPARE(unreachable.message, ui::loginFailureMessage(ui::LoginFailure::Unreachable));
    QCOMPARE(model.queryCalls, 0);
    QCOMPARE(model.subscribeCalls, 0);
}

// Rule 1: one change signal = exactly one full re-query with the same filter.
void ListControllerTest::reQueriesExactlyOncePerChangeSignal()
{
    CountingModel model(seedWith(rows(2)));
    logIn(model);
    DiagFile sink;
    ListController controller(model, &sink.diag);
    QVERIFY(controller.enter().ok);
    QCOMPARE(model.queryCalls, 1);

    model.saveArticle(newArticle(1));  // the fake notifies {kind:"create"}
    QCOMPARE(model.queryCalls, 2);
    QCOMPARE(controller.total(), 3);
    QCOMPARE(model.filters.last(), ui::deskUnsentFilter());

    model.saveArticle(newArticle(2));
    QCOMPARE(model.queryCalls, 3);
    controller.onStreamEvent(StreamEvent::Change);
    QCOMPARE(model.queryCalls, 4);
    QCOMPARE(sink.listCounts(), (QList<int>{2, 3, 4, 4}));
}

// Rule 2: ready is not a re-query trigger - not the first one, not a reconnect's. The gate's "exactly
// 2 articles-list calls" stands on this.
void ListControllerTest::neverReQueriesOnReady()
{
    CountingModel model(seedWith(rows(2)));
    logIn(model);
    ListController controller(model, nullptr);
    QVERIFY(controller.enter().ok);  // the fake reports its ready inside subscribe()
    QCOMPARE(model.queryCalls, 1);
    QVERIFY(controller.live());

    QSignalSpy live(&controller, &ListController::liveChanged);
    controller.onStreamEvent(StreamEvent::Ready);
    controller.onStreamEvent(StreamEvent::Ready);
    controller.onStreamEvent(StreamEvent::Ready);
    QCOMPARE(model.queryCalls, 1);
    QCOMPARE(live.count(), 0);  // already live: nothing to say

    controller.onStreamEvent(StreamEvent::Dropped);
    QVERIFY(!controller.live());
    controller.onStreamEvent(StreamEvent::Ready);  // a reconnect's ready
    QVERIFY(controller.live());
    QCOMPARE(model.queryCalls, 1);
    QCOMPARE(live.count(), 2);
    QCOMPARE(live.at(0).at(0).toBool(), false);
    QCOMPARE(live.at(1).at(0).toBool(), true);
}

// Rule 2, the other half: no timer. The same stretch of time (longer than M11-1p's 2 s poll) passes
// with the call count unchanged, and the controller owns no timer object.
void ListControllerTest::hasNoPeriodicTimer()
{
    CountingModel model(seedWith(rows(2)));
    logIn(model);
    ListController controller(model, nullptr);
    QVERIFY(controller.enter().ok);
    QCOMPARE(model.queryCalls, 1);

    QTest::qWait(2600);

    QCOMPARE(model.queryCalls, 1);
    QVERIFY(controller.findChildren<QTimer *>().isEmpty());
}

// Rule 1: the kind decides nothing. Every kind the fake emits (create, update, lock, status, a derive's
// create) and a kindless frame each cause exactly one query, always with the same filter - and the
// controller's source never even names the kind key.
void ListControllerTest::treatsEveryKindAsTheSameSignal()
{
    CountingModel model(seedWith({row(QStringLiteral("A1"), QStringLiteral("RDS"), QStringLiteral("2026-09-01T01:00:00.000Z"))}));
    logIn(model);
    ListController controller(model, nullptr);
    QVERIFY(controller.enter().ok);

    const QList<QPair<QString, std::function<void()>>> signals_{
        {QStringLiteral("create"), [&model] { model.saveArticle(newArticle(1)); }},
        {QStringLiteral("update"),
         [&model] { model.saveArticle(QJsonObject{{QStringLiteral("articleId"), QStringLiteral("A1")}, {QStringLiteral("title"), QStringLiteral("고침")}}); }},
        {QStringLiteral("lock"), [&model] { model.lockArticle(QStringLiteral("A1"), QString(), QString()); }},
        {QStringLiteral("status"), [&model] { model.applyAction(QStringLiteral("A1"), QStringLiteral("send")); }},
        {QStringLiteral("derive create"), [&model] { model.deriveArticle(QStringLiteral("A1"), QStringLiteral("followUp")); }},
        {QStringLiteral("kindless frame"), [&controller] { controller.onStreamEvent(StreamEvent::Change); }},
    };
    for (const auto &signal : signals_) {
        const int before = model.queryCalls;
        signal.second();
        QVERIFY2(model.queryCalls == before + 1, qPrintable(signal.first));
        QVERIFY2(model.filters.last() == ui::deskUnsentFilter(), qPrintable(signal.first));
    }

    const QString source = sourceText(QStringLiteral("client-qt/src/ui/listcontroller.cpp"));
    QVERIFY2(source.size() > 500, "non-vacuity: the real source was read");
    QVERIFY2(!source.contains(QStringLiteral("\"kind\"")), "listcontroller.cpp names the change kind");
}

// Client paging, 10 a page (the contract has no paging - baseline (F)). Paging never queries.
void ListControllerTest::pagesTenRowsAtATime_data()
{
    QTest::addColumn<int>("count");
    QTest::addColumn<int>("pages");
    QTest::addColumn<int>("firstPageRows");
    QTest::addColumn<int>("lastPageRows");

    QTest::newRow("0 rows - one empty page") << 0 << 1 << 0 << 0;
    QTest::newRow("9 rows") << 9 << 1 << 9 << 9;
    QTest::newRow("10 rows - still one page") << 10 << 1 << 10 << 10;
    QTest::newRow("11 rows - a second page of 1") << 11 << 2 << 10 << 1;
    QTest::newRow("23 rows - 10 10 3") << 23 << 3 << 10 << 3;
}

void ListControllerTest::pagesTenRowsAtATime()
{
    QFETCH(int, count);
    QFETCH(int, pages);
    QFETCH(int, firstPageRows);
    QFETCH(int, lastPageRows);

    QCOMPARE(ui::kListPageSize, 10);
    QCOMPARE(ui::pageCountFor(count), pages);
    QCOMPARE(ui::pageSlice(rows(count), 1).size(), firstPageRows);
    QCOMPARE(ui::pageSlice(rows(count), pages).size(), lastPageRows);

    CountingModel model;
    model.scriptedItems = rows(count);
    logIn(model);
    ListController controller(model, nullptr);
    QVERIFY(controller.enter().ok);

    QCOMPARE(controller.total(), count);
    QCOMPARE(controller.pageCount(), pages);
    QCOMPARE(controller.page(), 1);
    QCOMPARE(controller.pageItems().size(), firstPageRows);

    controller.setPage(pages);
    QCOMPARE(controller.page(), pages);
    QCOMPARE(controller.pageItems().size(), lastPageRows);
    controller.nextPage();
    QCOMPARE(controller.page(), pages);  // clamped at the last page
    controller.setPage(999);
    QCOMPARE(controller.page(), pages);
    controller.setPage(0);
    QCOMPARE(controller.page(), 1);
    controller.previousPage();
    QCOMPARE(controller.page(), 1);
    if (pages > 1) {
        controller.nextPage();
        QCOMPARE(controller.page(), 2);
        QCOMPARE(controller.pageItems().first(), controller.items().at(10));
    }

    const ui::ListViewState state = controller.viewState();
    QCOMPARE(state.rows, controller.pageItems());
    QCOMPARE(state.page, controller.page());
    QCOMPARE(state.pageCount, pages);
    QCOMPARE(state.total, count);
    QCOMPARE(state.menu, QStringLiteral("deskUnsent"));
    QCOMPARE(model.queryCalls, 1);  // paging is not a query
}

// A re-query that shrinks the list pulls the page back into range (useViewController.js:160-163); one
// that grows it keeps the page.
void ListControllerTest::clampsThePageWhenTheListShrinks()
{
    CountingModel model;
    model.scriptedItems = rows(23);
    logIn(model);
    ListController controller(model, nullptr);
    QVERIFY(controller.enter().ok);
    controller.setPage(3);
    QCOMPARE(controller.page(), 3);

    model.scriptedItems = rows(11);
    controller.onStreamEvent(StreamEvent::Change);
    QCOMPARE(controller.pageCount(), 2);
    QCOMPARE(controller.page(), 2);
    QCOMPARE(controller.pageItems().size(), 1);

    model.scriptedItems = rows(0);
    controller.onStreamEvent(StreamEvent::Change);
    QCOMPARE(controller.page(), 1);
    QCOMPARE(controller.pageItems().size(), 0);

    model.scriptedItems = rows(23);
    controller.onStreamEvent(StreamEvent::Change);
    controller.setPage(2);
    model.scriptedItems = rows(30);
    controller.onStreamEvent(StreamEvent::Change);
    QCOMPARE(controller.page(), 2);
}

// Newest first by createdAt, stable: equal times keep the server's order, rows without a time go last.
void ListControllerTest::showsTheNewestFirst()
{
    const QList<QJsonObject> served{row(QStringLiteral("A"), QStringLiteral("RDS"), QStringLiteral("2026-01-01T10:00:00.000Z")),
                                    row(QStringLiteral("B"), QStringLiteral("RDS"), QStringLiteral("2026-01-03T09:00:00.000Z")),
                                    row(QStringLiteral("C"), QStringLiteral("DDH"), QStringLiteral("2026-01-02T08:00:00.000Z")),
                                    row(QStringLiteral("D"), QStringLiteral("RDS"), QString()),
                                    row(QStringLiteral("E"), QStringLiteral("RDS"), QStringLiteral("2026-01-03T09:00:00.000Z"))};
    auto ids = [](const QList<QJsonObject> &list) {
        QStringList out;
        for (const QJsonObject &item : list)
            out << item.value(QStringLiteral("articleId")).toString();
        return out;
    };
    const QStringList expected{QStringLiteral("B"), QStringLiteral("E"), QStringLiteral("C"), QStringLiteral("A"), QStringLiteral("D")};
    QCOMPARE(ids(ui::newestFirst(served)), expected);

    CountingModel model;
    model.scriptedItems = served;
    logIn(model);
    ListController controller(model, nullptr);
    QVERIFY(controller.enter().ok);
    QCOMPARE(ids(controller.items()), expected);
}

// Rule 3: three changes land while a re-query is running (the hook runs INSIDE the query, after its
// answer was computed). They merge into exactly ONE follow-up query - never an overlapping one - and
// the list ends up with every row.
void ListControllerTest::mergesChangesThatArriveDuringAQuery()
{
    CountingModel model(seedWith(rows(2)));
    logIn(model);
    DiagFile sink;
    ListController controller(model, &sink.diag);
    QVERIFY(controller.enter().ok);
    QCOMPARE(model.queryCalls, 1);

    model.duringQuery = [&model] {
        for (int i = 10; i < 13; ++i)
            model.saveArticle(newArticle(i));  // three change signals while the query is "on the wire"
    };
    model.saveArticle(newArticle(1));  // the change that starts the re-query

    QCOMPARE(model.queryCalls, 3);  // entry + the re-query + ONE follow-up for three merged changes
    QCOMPARE(model.maxDepth, 1);    // never two queries at once
    QCOMPARE(controller.total(), 6);
    QCOMPARE(sink.listCounts(), (QList<int>{2, 3, 6}));
}

// Rule 3, the other half: merging never throws a signal away. A change during the follow-up itself
// earns one more follow-up; the list is never left stale.
void ListControllerTest::neverDropsAChangeThatArrivesDuringAQuery()
{
    CountingModel model(seedWith(rows(2)));
    logIn(model);
    DiagFile sink;
    ListController controller(model, &sink.diag);
    QVERIFY(controller.enter().ok);

    model.duringQuery = [&model] {
        model.saveArticle(newArticle(20));
        model.duringQuery = [&model] { model.saveArticle(newArticle(21)); };  // lands during the follow-up
    };
    model.saveArticle(newArticle(1));

    QCOMPARE(model.queryCalls, 4);  // entry, re-query, follow-up, follow-up of the follow-up
    QCOMPARE(model.maxDepth, 1);
    QCOMPARE(controller.total(), 5);
    QCOMPARE(sink.listCounts().last(), 5);
    QVERIFY(!model.duringQuery);
}

// A 401 on a re-query ends the session: the stream is closed for good, the rows are forgotten and the
// caller hears sessionEnded. During the entry itself it is the entry's answer (no signal).
void ListControllerTest::endsTheSessionOnA401Answer()
{
    const net::HttpResponse unauthenticated = loginwire::wireAnswer(
        QStringLiteral("articles-list"), 401, QByteArrayLiteral(R"json({"ok":false,"reason":"unauthenticated"})json"));

    CountingModel model(seedWith(rows(2)));
    logIn(model);
    DiagFile sink;
    ListController controller(model, &sink.diag);
    QVERIFY(controller.enter().ok);
    QSignalSpy ended(&controller, &ListController::sessionEnded);

    model.queryWire = unauthenticated;
    model.saveArticle(newArticle(1));

    QCOMPARE(model.queryCalls, 2);
    QCOMPARE(ended.count(), 1);
    QCOMPARE(ended.at(0).at(0).toString(), ui::sessionEndedMessage());
    QVERIFY(!controller.isEntered());
    QVERIFY(!controller.live());
    QCOMPARE(controller.total(), 0);
    QCOMPARE(sink.listCounts(), QList<int>{2});

    model.queryWire.reset();
    model.saveArticle(newArticle(2));  // the stream is gone
    QCOMPARE(model.queryCalls, 2);

    CountingModel entering(seedWith(rows(2)));
    logIn(entering);
    entering.queryWire = unauthenticated;
    ListController second(entering, nullptr);
    QSignalSpy secondEnded(&second, &ListController::sessionEnded);
    const ui::ListEntry entry = second.enter();
    QVERIFY(!entry.ok);
    QCOMPARE(entry.message, ui::sessionEndedMessage());
    QCOMPARE(secondEnded.count(), 0);
    QCOMPARE(entering.subscribeCalls, 0);
    QVERIFY(!second.isEntered());
}

// A query that fails for another reason (no answer, not our server) keeps the rows it had, says so, and
// writes no list-loaded (there is no count to write). The next change queries again.
void ListControllerTest::keepsTheRowsWhenAQueryFailsWithoutEndingTheSession()
{
    CountingModel model(seedWith(rows(2)));
    logIn(model);
    DiagFile sink;
    ListController controller(model, &sink.diag);
    QVERIFY(controller.enter().ok);
    QVERIFY(controller.errorText().isEmpty());

    model.queryWire = loginwire::noAnswer(net::Outcome::NetworkError);
    model.saveArticle(newArticle(1));
    QVERIFY(!controller.errorText().isEmpty());
    QCOMPARE(controller.viewState().error, controller.errorText());
    QCOMPARE(controller.total(), 2);
    QVERIFY(controller.isEntered());
    QCOMPARE(sink.listCounts(), QList<int>{2});

    model.queryWire.reset();
    controller.onStreamEvent(StreamEvent::Change);
    QVERIFY(controller.errorText().isEmpty());
    QCOMPARE(controller.total(), 3);
    QCOMPARE(sink.listCounts(), (QList<int>{2, 3}));
}

// The stream's unauthorized frame (the fake's endStreamSession: status down, then the session end) ends
// the session without a query, and nothing reaches the controller afterwards.
void ListControllerTest::endsTheSessionWhenTheStreamSaysSo()
{
    CountingModel model(seedWith(rows(2)));
    logIn(model);
    ListController controller(model, nullptr);
    QVERIFY(controller.enter().ok);
    QStringList order;
    connect(&controller, &ListController::liveChanged, this,
            [&order](bool live) { order << (live ? QStringLiteral("live") : QStringLiteral("not-live")); });
    connect(&controller, &ListController::sessionEnded, this, [&order](const QString &) { order << QStringLiteral("ended"); });

    model.endStreamSession();

    QCOMPARE(order, (QStringList{QStringLiteral("not-live"), QStringLiteral("ended")}));
    QVERIFY(!controller.isEntered());
    QCOMPARE(model.queryCalls, 1);
    model.saveArticle(newArticle(1));
    QCOMPARE(model.queryCalls, 1);
    controller.onStreamEvent(StreamEvent::SessionEnd);  // a second report changes nothing
    QCOMPARE(order.size(), 2);
}

// leave(): the stream closes, the rows go (no data survives the page), late changes and refreshes do
// nothing. Twice is fine.
void ListControllerTest::leaveClosesTheStreamAndForgetsTheRows()
{
    CountingModel model(seedWith(rows(2)));
    logIn(model);
    ListController controller(model, nullptr);
    QVERIFY(controller.enter().ok);
    QSignalSpy changed(&controller, &ListController::listChanged);

    controller.leave();
    QVERIFY(!controller.isEntered());
    QVERIFY(!controller.live());
    QCOMPARE(controller.total(), 0);
    QCOMPARE(changed.count(), 1);

    model.saveArticle(newArticle(1));
    controller.refresh();
    QCOMPARE(model.queryCalls, 1);
    controller.leave();
    QCOMPARE(changed.count(), 1);
}

// Rule 5: list-loaded carries the menu id and a number - never a title, never an article id - and the
// vocabulary is exactly session + list-loaded, both inside the step4 gate.
void ListControllerTest::writesACountNeverATitleOrAnId()
{
    const QString title = QStringLiteral("헤드라인-비공개-7c1f");
    const QString id = QStringLiteral("AKRSECRET0042");
    CountingModel model(seedWith({row(id, QStringLiteral("RDS"), QStringLiteral("2026-09-01T01:00:00.000Z"), title)}));
    logIn(model);
    DiagFile sink;
    ListController controller(model, &sink.diag);
    QVERIFY(controller.enter().ok);
    model.saveArticle(newArticle(1));

    const QByteArray raw = sink.raw();
    QVERIFY2(raw.size() > 60, "non-vacuity: lines were written");
    QVERIFY2(!raw.contains(title.toUtf8()), "a title reached the diag");
    QVERIFY2(!raw.contains(id.toUtf8()), "an article id reached the diag");
    const QList<QJsonObject> loaded = sink.named(QStringLiteral("list-loaded"));
    QCOMPARE(loaded.size(), 2);
    for (const QJsonObject &event : loaded) {
        const QStringList keys = event.keys();
        QCOMPARE(QSet<QString>(keys.begin(), keys.end()),
                 (QSet<QString>{QStringLiteral("ts"), QStringLiteral("event"), QStringLiteral("menu"), QStringLiteral("count")}));
    }

    const QStringList vocabulary = ui::listControllerDiagEvents();
    QCOMPARE(QSet<QString>(vocabulary.begin(), vocabulary.end()),
             (QSet<QString>{QStringLiteral("session"), QStringLiteral("list-loaded")}));
    for (const QString &name : vocabulary)
        QVERIFY2(shell::isAllowedDiagEvent(name), qPrintable(name));
    QCOMPARE(sink.diag.rejectedEventCount(), 0);
}

// ADR-003: the Model interface and a diag sink - no widget, no transport, no timer. The scan keeps it so.
void ListControllerTest::dependsOnNoWidgetAndNoTimer()
{
    static_assert(std::is_constructible_v<ListController, net::INewsModel &, shell::Diag *>,
                  "ListController(INewsModel&, Diag*) - step11 A");
    static_assert(!std::is_copy_constructible_v<ListController>, "one controller per Model");

    const QStringList forbidden{QStringLiteral("QWidget"),        QStringLiteral("QTableWidget"),
                                QStringLiteral("QLabel"),         QStringLiteral("QPushButton"),
                                QStringLiteral("QApplication"),   QStringLiteral("ui/listscreen.h"),
                                QStringLiteral("ui/mainwindow.h"), QStringLiteral("HttpTransport"),
                                QStringLiteral("HttpNewsModel"),  QStringLiteral("QTimer"),
                                QStringLiteral("startTimer"),     QStringLiteral("singleShot")};
    for (const QString &relative : {QStringLiteral("client-qt/src/ui/listcontroller.h"),
                                    QStringLiteral("client-qt/src/ui/listcontroller.cpp")}) {
        const QString text = sourceText(relative);
        QVERIFY2(text.size() > 500, qPrintable(relative));
        for (const QString &token : forbidden)
            QVERIFY2(!text.contains(token), qPrintable(relative + QStringLiteral(" names ") + token));
    }
}

// On the real Model the filter goes through step7's buildQuery: status repeated, never comma-joined,
// never QUrlQuery (which would leave '+' bare).
void ListControllerTest::spellsTheFilterWithBuildQueryOnTheWire()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    stub.handle([](const StubRequest &request) {
        if (request.target.startsWith("/api/session"))
            return StubReply::json(200, R"json({"ok":true,"user":{"userId":"desk","role":"D","department":"편집부"}})json");
        if (request.target.startsWith("/api/articles"))
            return StubReply::json(200, R"json({"ok":true,"items":[]})json");
        return StubReply::json(404, R"json({"ok":false,"reason":"not-found"})json");  // the stream: refused
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel http(&transport);
    ListController controller(http, nullptr);

    QVERIFY(controller.enter().ok);
    controller.leave();

    QByteArrayList targets;
    for (const StubRequest &request : stub.requests()) {
        if (request.target.startsWith("/api/articles"))
            targets << request.target;
    }
    QCOMPARE(targets, QByteArrayList{QByteArray("/api/articles?status=RDS&status=DDH")});
}
