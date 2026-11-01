#include "editscenariotest.h"

#include "editwire.h"
#include "loginwire.h"

#include "editor/editorcaret.h"
#include "editor/editorcontent.h"
#include "editor/editornewline.h"
#include "editor/editorroles.h"
#include "editor/writerbody.h"
#include "shell/scenario.h"
#include "ui/editcontroller.h"
#include "ui/editscenario.h"
#include "ui/listcontroller.h"
#include "ui/mainwindow.h"
#include "ui/writerhost.h"

#include <QApplication>
#include <QSignalSpy>
#include <QStringList>
#include <QtTest>

#include <memory>

using editwire::EditWireModel;
using editwire::MemoryDraftStore;

namespace {

const QString kId = QStringLiteral("AKR20261101000100001");
const QString kTitle = QStringLiteral("Scenario title");

QString threeLineBody()
{
    return editor::serialize({editor::textBlock(kTitle), editor::textBlock(QStringLiteral("Body line")),
                              editor::textBlock(editor::END_MARKER)});
}

QJsonObject scenarioArticle()
{
    return editwire::articleRow(kId, kTitle, threeLineBody());
}

bool isAscii(const QString &text)
{
    for (const QChar c : text) {
        if (c.unicode() > 0x7e || (c.unicode() < 0x20 && c != QLatin1Char('\n')))
            return false;
    }
    return true;
}

// The app's composition for the hook, without the shell: the logged-in Model, the list controller (entered), the
// window and its writer host - wired the way AppShell wires the list page (left -> leave()).
struct ScenarioRig {
    EditWireModel model;
    MemoryDraftStore drafts;
    qint64 now = 1000;
    ui::MainWindow window{QStringLiteral("http://127.0.0.1:3001")};
    ui::ListController list;
    std::unique_ptr<ui::WriterHost> host;
    QStringList failures;

    explicit ScenarioRig(const QList<QJsonObject> &articles = {scenarioArticle()},
                         ui::AutosaveConfig autosave = ui::editScenarioAutosave(), bool deferReady = false)
        : model(editwire::seedWith(articles)), list(model, nullptr)
    {
        model.deferReady = deferReady;
        model.login(loginwire::kUser, loginwire::kPassword);
        QObject::connect(&window, &ui::MainWindow::listPageLeft, &list, &ui::ListController::leave);
        ui::WriterHost::Options options;
        options.autosave = autosave;
        options.clock = [this] { return now; };
        options.draftScope = QStringLiteral("w-scenario");
        host = std::make_unique<ui::WriterHost>(model, drafts, window, options);
        window.showListPage();
    }

    bool enter()
    {
        const ui::ListEntry entry = list.enter();
        model.calls.clear();
        return entry.ok;
    }

    std::unique_ptr<ui::EditScenario> scenario(const QString &articleId = kId)
    {
        return std::make_unique<ui::EditScenario>(list, *host, articleId, [this](const QString &why) { failures << why; });
    }

    // The edit-path calls only (the list's own queries interleave when a change re-queries it).
    QStringList editCalls() const
    {
        QStringList out;
        for (const QString &method : model.methods()) {
            if (method == QLatin1String("getArticle") || method == QLatin1String("lockArticle")
                || method == QLatin1String("saveArticle") || method == QLatin1String("unlockArticle"))
                out << method;
        }
        return out;
    }
};

} // namespace

void EditScenarioTest::initTestCase()
{
    m_savedQuitOnLastWindowClosed = QApplication::quitOnLastWindowClosed();
    QApplication::setQuitOnLastWindowClosed(false);
}

void EditScenarioTest::cleanupTestCase()
{
    QApplication::setQuitOnLastWindowClosed(m_savedQuitOnLastWindowClosed);
}

// Only the exact two-argument spelling becomes `list`; anything else reaches the shell's guard as it was given (and
// the guard refuses what it does not accept).
void EditScenarioTest::rewritesOnlyTheTwoArgumentEditSpelling_data()
{
    QTest::addColumn<QStringList>("arguments");
    QTest::addColumn<QStringList>("shell");
    QTest::addColumn<bool>("requested");
    const QString s = QStringLiteral("--scenario");
    QTest::newRow("edit") << QStringList{s, QStringLiteral("edit")} << QStringList{s, QStringLiteral("list")} << true;
    QTest::newRow("edit among others") << QStringList{QStringLiteral("-x"), s, QStringLiteral("edit"), QStringLiteral("--foo")}
                                       << QStringList{QStringLiteral("-x"), s, QStringLiteral("list"), QStringLiteral("--foo")} << true;
    QTest::newRow("edit twice") << QStringList{s, QStringLiteral("edit"), s, QStringLiteral("edit")}
                                << QStringList{s, QStringLiteral("list"), s, QStringLiteral("list")} << true;
    QTest::newRow("list") << QStringList{s, QStringLiteral("list")} << QStringList{s, QStringLiteral("list")} << false;
    QTest::newRow("login") << QStringList{s, QStringLiteral("login")} << QStringList{s, QStringLiteral("login")} << false;
    QTest::newRow("equals spelling") << QStringList{QStringLiteral("--scenario=edit")} << QStringList{QStringLiteral("--scenario=edit")} << false;
    QTest::newRow("edit without the flag") << QStringList{QStringLiteral("edit")} << QStringList{QStringLiteral("edit")} << false;
    QTest::newRow("flag without a name") << QStringList{s} << QStringList{s} << false;
    QTest::newRow("upper case name") << QStringList{s, QStringLiteral("EDIT")} << QStringList{s, QStringLiteral("EDIT")} << false;
    QTest::newRow("nothing") << QStringList() << QStringList() << false;
}

void EditScenarioTest::rewritesOnlyTheTwoArgumentEditSpelling()
{
    QFETCH(QStringList, arguments);
    QFETCH(QStringList, shell);
    QFETCH(bool, requested);
    const ui::EditScenarioArgs args = ui::editScenarioArgs(arguments);
    QCOMPARE(args.shellArguments, shell);
    QCOMPARE(args.requested, requested);
}

// The guard is the shell's, unchanged (shell/scenario.cpp): CLIENT_SELFTEST first and alone, then the spelling rules
// and the credentials - for `edit` exactly as for `list`.
void EditScenarioTest::theShellGuardStillDecides()
{
    const auto parse = [](const QStringList &arguments, const QString &selftest, const QString &user = loginwire::kUser,
                          const QString &password = loginwire::kPassword) {
        return shell::parseScenarioRequest(ui::editScenarioArgs(arguments).shellArguments, selftest, user, password);
    };
    const QString s = QStringLiteral("--scenario");
    const shell::ScenarioRequest ok = parse({s, QStringLiteral("edit")}, QStringLiteral("1"));
    QVERIFY(!ok.refused);
    QCOMPARE(ok.scenario, shell::Scenario::List);
    for (const QString &selftest : {QString(), QStringLiteral("0"), QStringLiteral("true")}) {
        const shell::ScenarioRequest refused = parse({s, QStringLiteral("edit")}, selftest);
        QVERIFY(refused.refused);
        QVERIFY2(refused.refusal.contains(QStringLiteral("CLIENT_SELFTEST=1")), qPrintable(refused.refusal));
    }
    QVERIFY(parse({QStringLiteral("--scenario=edit")}, QStringLiteral("1")).refused);
    QVERIFY(parse({s, QStringLiteral("edit"), s, QStringLiteral("edit")}, QStringLiteral("1")).refused);
    QVERIFY(parse({s, QStringLiteral("edit"), QStringLiteral("--selftest")}, QStringLiteral("1")).refused);
    QVERIFY(parse({s, QStringLiteral("edit")}, QStringLiteral("1"), QString(), QString()).refused);
}

void EditScenarioTest::namesTheArticleVariableAndRefusesWithoutIt()
{
    QCOMPARE(ui::editScenarioArticleEnvVar(), QStringLiteral("CLIENT_SCENARIO_ARTICLE"));
    const QString refusal = ui::editScenarioArticleRefusal();
    QVERIFY(!refusal.isEmpty());
    QVERIFY2(isAscii(refusal), qPrintable(refusal));
    QVERIFY(refusal.contains(QStringLiteral("CLIENT_SCENARIO_ARTICLE")));
    QVERIFY(refusal.contains(QStringLiteral("--scenario edit")));
}

// The scenario's autosave is on, every second - so the round trip contains one real snapshot; the production default
// stays the web's (off, 60 s, 1 day).
void EditScenarioTest::runsAutosaveOnEverySecondInTheScenarioOnly()
{
    const ui::AutosaveConfig scenario = ui::editScenarioAutosave();
    QVERIFY(scenario.enabled);
    QCOMPARE(scenario.intervalSec, 1);
    QCOMPARE(scenario.retentionDays, 1);
    const ui::AutosaveConfig production;
    QVERIFY(!production.enabled);
    QCOMPARE(production.intervalSec, 60);
    QCOMPARE(production.retentionDays, 1);
}

// The one edit: the text at the end of the first text line, through the gates typing uses - isInputBlocked at the
// caret (a first line that reaches the last "(끝)" refuses), then insertTextIntoBlocks (the same blocks the widget's
// typing would make).
void EditScenarioTest::theEditGoesThroughTheGates()
{
    const QString text = ui::editScenarioText();
    QVERIFY(!text.isEmpty());
    QVERIFY(isAscii(text));
    QVERIFY(!text.contains(QLatin1Char('\n')));

    const QVector<editor::Block> blocks = editor::deserialize(threeLineBody());
    const std::optional<QVector<editor::Block>> edited = ui::editScenarioEdit(blocks);
    QVERIFY(edited);
    QCOMPARE(*edited, (QVector<editor::Block>{editor::textBlock(kTitle + text), editor::textBlock(QStringLiteral("Body line")),
                                               editor::textBlock(editor::END_MARKER)}));
    const editor::TextPoint caret{0, static_cast<int>(kTitle.size())};
    QCOMPARE(*edited, editor::insertTextIntoBlocks(blocks, caret, text).blocks);

    QVERIFY(!ui::editScenarioEdit({editor::textBlock(editor::END_MARKER)}));
    QVERIFY(!ui::editScenarioEdit({editor::textBlock(QStringLiteral("a") + editor::END_MARKER), editor::textBlock(QStringLiteral("b"))}));
    QVERIFY(!ui::editScenarioEdit({editor::embedBlock()}));
    QVERIFY(!ui::editScenarioEdit({}));
    const std::optional<QVector<editor::Block>> shortDoc =
        ui::editScenarioEdit({editor::textBlock(QStringLiteral("a")), editor::textBlock(editor::END_MARKER)});
    QVERIFY(shortDoc);
    QCOMPARE(shortDoc->first().text, QStringLiteral("a") + text);
}

// The whole round trip on FakeNewsModel: the list's row -> the writer opens it (get -> lock) -> the gated edit -> one
// real autosave snapshot -> save (PUT with the same id) -> close (unlock) -> the list page again. What the fake stored
// is exactly the edited body and the title the commit derived.
void EditScenarioTest::runsTheRoundTripThroughTheControllers()
{
    ScenarioRig rig;
    QVERIFY(rig.enter());
    QVERIFY(rig.list.live());
    auto scenario = rig.scenario();
    QSignalSpy finished(scenario.get(), &ui::EditScenario::finished);
    scenario->start();
    QVERIFY(finished.count() == 1 || finished.wait(5000));
    QVERIFY2(rig.failures.isEmpty(), qPrintable(rig.failures.join(QStringLiteral(" | "))));
    QVERIFY(scenario->done());
    QVERIFY(!scenario->failed());

    QCOMPARE(rig.editCalls(), (QStringList{QStringLiteral("getArticle"), QStringLiteral("lockArticle"), QStringLiteral("saveArticle"),
                                           QStringLiteral("unlockArticle")}));
    const QString id = rig.model.callsOf(QStringLiteral("lockArticle")).first().clientId;
    QVERIFY(!id.isEmpty());
    QCOMPARE(rig.model.callsOf(QStringLiteral("saveArticle")).first().clientId, id);
    QCOMPARE(rig.model.callsOf(QStringLiteral("unlockArticle")).first().clientId, id);

    const QString expected = editor::serializeBodyFromBlocks(*ui::editScenarioEdit(editor::deserialize(threeLineBody())));
    const QJsonObject dto = rig.model.callsOf(QStringLiteral("saveArticle")).first().dto;
    QCOMPARE(dto.value(QStringLiteral("markupVersion")).toString(), expected);
    QCOMPARE(dto.value(QStringLiteral("title")).toString(), kTitle + ui::editScenarioText());
    const net::ModelResult stored = rig.model.net::FakeNewsModel::getArticle(kId);
    QCOMPARE(stored.body.value(QStringLiteral("article")).toObject().value(QStringLiteral("markupVersion")).toString(), expected);
    QCOMPARE(stored.body.value(QStringLiteral("article")).toObject().value(QStringLiteral("lockYN")).toString(), QStringLiteral("N"));

    const MemoryDraftStore::Saved *draft = rig.drafts.find(kId);
    QVERIFY2(draft, "no autosave snapshot was written during the round trip");
    QCOMPARE(editwire::stringMember(draft->data, QStringLiteral("body")), expected);
    QVERIFY(!editor::stringifyJson(draft->data).contains(id));

    QVERIFY(rig.window.listPageShown());
    QVERIFY(!rig.host->surface());
}

// The edit starts only once the list is live (its stream's ready): nothing is asked before.
void EditScenarioTest::waitsForTheListToBeLive()
{
    ScenarioRig rig({scenarioArticle()}, ui::editScenarioAutosave(), true);
    QVERIFY(rig.enter());
    QVERIFY(!rig.list.live());
    auto scenario = rig.scenario();
    QSignalSpy finished(scenario.get(), &ui::EditScenario::finished);
    scenario->start();
    QTest::qWait(50);
    QVERIFY2(rig.editCalls().isEmpty(), qPrintable(rig.editCalls().join(QLatin1Char(','))));
    QVERIFY(!scenario->done() && !scenario->failed());
    rig.model.reportReady();
    QVERIFY(finished.count() == 1 || finished.wait(5000));
    QVERIFY2(rig.failures.isEmpty(), qPrintable(rig.failures.join(QStringLiteral(" | "))));
    QVERIFY(scenario->done());
}

// The article must be a row of the list the user sees - the hook opens what a double-click could open.
void EditScenarioTest::stopsWhenTheArticleIsNotInTheList()
{
    ScenarioRig rig;
    QVERIFY(rig.enter());
    const QString missing = QStringLiteral("AKR20261101999999999");
    auto scenario = rig.scenario(missing);
    scenario->start();
    QVERIFY(scenario->failed());
    QCOMPARE(rig.failures.size(), 1);
    QVERIFY2(isAscii(rig.failures.first()) && !rig.failures.first().contains(missing), qPrintable(rig.failures.first()));
    QVERIFY(rig.editCalls().isEmpty());
}

// A lock that is not granted stops the round trip: nothing is saved, nothing is unlocked; the sentence names the state,
// not the article.
void EditScenarioTest::stopsWhenTheArticleDoesNotOpenForEditing()
{
    QJsonObject held = scenarioArticle();
    held.insert(QStringLiteral("lockYN"), QStringLiteral("Y"));
    held.insert(QStringLiteral("lockerClientId"), QStringLiteral("c-someone-else"));
    ScenarioRig rig({held});
    QVERIFY(rig.enter());
    auto scenario = rig.scenario();
    scenario->start();
    QVERIFY(scenario->failed());
    QCOMPARE(rig.failures.size(), 1);
    QVERIFY2(rig.failures.first().contains(QStringLiteral("LockRefused")), qPrintable(rig.failures.first()));
    QVERIFY(isAscii(rig.failures.first()) && !rig.failures.first().contains(kId) && !rig.failures.first().contains(kTitle));
    QCOMPARE(rig.model.count(QStringLiteral("saveArticle")), 0);
    QCOMPARE(rig.model.count(QStringLiteral("unlockArticle")), 0);
}

// The round trip needs its autosave snapshot: with autosave off it stops before the save instead of waiting forever.
void EditScenarioTest::stopsWhenAutosaveIsOff()
{
    ScenarioRig rig({scenarioArticle()}, ui::AutosaveConfig());
    QVERIFY(rig.enter());
    auto scenario = rig.scenario();
    scenario->start();
    QVERIFY(scenario->failed());
    QCOMPARE(rig.failures.size(), 1);
    QVERIFY2(rig.failures.first().contains(QStringLiteral("autosave")), qPrintable(rig.failures.first()));
    QVERIFY(isAscii(rig.failures.first()));
    QCOMPARE(rig.model.count(QStringLiteral("saveArticle")), 0);
}
