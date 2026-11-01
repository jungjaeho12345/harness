#include "writerhosttest.h"

#include "editwire.h"

#include "editor/editorcontent.h"
#include "editor/editorroles.h"
#include "editor/writerbody.h"
#include "ui/editcontroller.h"
#include "ui/editorwidget.h"
#include "ui/listcontroller.h"
#include "ui/listscreen.h"
#include "ui/mainwindow.h"
#include "ui/writerhost.h"

#include <QApplication>
#include <QLabel>
#include <QPushButton>
#include <QSignalSpy>
#include <QTableWidget>
#include <QtTest>

#include <memory>

using editwire::EditWireModel;
using editwire::MemoryDraftStore;
using ui::EditState;

namespace {

const QString kId = QStringLiteral("AKR20261101000100001");

QString markup(const QVector<editor::Block> &blocks)
{
    return editor::serialize(blocks);
}

QString threeLineBody()
{
    return markup({editor::textBlock(QStringLiteral("Title one")), editor::textBlock(QStringLiteral("Body line")),
                   editor::textBlock(editor::END_MARKER)});
}

QJsonObject defaultArticle(const QString &body = threeLineBody())
{
    return editwire::articleRow(kId, QStringLiteral("Title one"), body);
}

QJsonObject heldElsewhere()
{
    QJsonObject row = defaultArticle();
    row.insert(QStringLiteral("lockYN"), QStringLiteral("Y"));
    row.insert(QStringLiteral("lockerClientId"), QStringLiteral("c-someone-else"));
    return row;
}

// One window, its writer host over the recording fake, and one event log in which the window's page signals and the
// Model's calls interleave in the order they happened.
struct HostRig {
    EditWireModel model;
    MemoryDraftStore drafts;
    qint64 now = 1000;
    ui::MainWindow window{QStringLiteral("http://127.0.0.1:3001")};
    std::unique_ptr<ui::WriterHost> host;
    QStringList order;

    explicit HostRig(const QList<QJsonObject> &articles = {defaultArticle()}, ui::AutosaveConfig autosave = ui::AutosaveConfig())
        : model(editwire::seedWith(articles))
    {
        model.onCall = [this](const QString &method) { order << method; };
        QObject::connect(&window, &ui::MainWindow::listPageLeft, [this] { order << QStringLiteral("listPageLeft"); });
        QObject::connect(&window, &ui::MainWindow::listPageEntered, [this] { order << QStringLiteral("listPageEntered"); });
        ui::WriterHost::Options options;
        options.autosave = autosave;
        options.clock = [this] { return now; };
        options.draftScope = QStringLiteral("w-host");
        host = std::make_unique<ui::WriterHost>(model, drafts, window, options);
        window.showListPage();  // where a double-click comes from
        order.clear();
    }

    ui::EditorWidget *editor() const { return window.editorWidget(); }
    QPushButton *button(const char *name) const { return window.findChild<QPushButton *>(QLatin1String(name)); }
    QString lockId() const
    {
        const QList<editwire::ModelCall> locks = model.callsOf(QStringLiteral("lockArticle"));
        return locks.isEmpty() ? QString() : locks.first().clientId;
    }
};

} // namespace

void WriterHostTest::initTestCase()
{
    // A window closing inside a test must never post a quit to the runner's application (AppShellTest's rule).
    m_savedQuitOnLastWindowClosed = QApplication::quitOnLastWindowClosed();
    QApplication::setQuitOnLastWindowClosed(false);
}

void WriterHostTest::cleanupTestCase()
{
    QApplication::setQuitOnLastWindowClosed(m_savedQuitOnLastWindowClosed);
}

// The main window's third page (step9): the step8 editor screen, with its own part of the top bar - a plain-text
// sentence and [저장] [복구] [닫기] - shown on the editor page only, where the list's live indicator is not.
void WriterHostTest::theEditorPageHasItsOwnTopBarActions()
{
    ui::MainWindow window(QStringLiteral("http://127.0.0.1:3001"));
    QVERIFY(window.editorWidget());
    QVERIFY(window.loginPageShown());
    QVERIFY(!window.editorActionsVisible());
    QSignalSpy entered(&window, &ui::MainWindow::listPageEntered);
    QSignalSpy left(&window, &ui::MainWindow::listPageLeft);
    window.showListPage();
    QCOMPARE(entered.count(), 1);
    QVERIFY(!window.editorActionsVisible());

    window.showEditorPage();
    QVERIFY(window.editorPageShown());
    QVERIFY(!window.listPageShown());
    QVERIFY(window.editorActionsVisible());
    QVERIFY(!window.liveStatusVisible());
    QCOMPARE(left.count(), 1);  // the editor page is not the list page: the list is left

    QLabel *notice = window.findChild<QLabel *>(QStringLiteral("editorNotice"));
    QVERIFY(notice);
    QCOMPARE(notice->textFormat(), Qt::PlainText);  // server wording is shown, never rendered
    window.setEditorNotice(QStringLiteral("<b>x</b>"));
    QCOMPARE(window.editorNoticeText(), QStringLiteral("<b>x</b>"));

    QPushButton *save = window.findChild<QPushButton *>(QStringLiteral("editorSaveButton"));
    QPushButton *recover = window.findChild<QPushButton *>(QStringLiteral("editorRecoverButton"));
    QPushButton *close = window.findChild<QPushButton *>(QStringLiteral("editorCloseButton"));
    QVERIFY(save && recover && close);
    window.setEditorActionsEnabled(false, false);
    QVERIFY(!save->isEnabled() && !recover->isEnabled() && close->isEnabled());
    window.setEditorActionsEnabled(true, true);
    QVERIFY(save->isEnabled() && recover->isEnabled());
    QSignalSpy saveRequested(&window, &ui::MainWindow::editorSaveRequested);
    QSignalSpy recoverRequested(&window, &ui::MainWindow::editorRecoverRequested);
    QSignalSpy closeRequested(&window, &ui::MainWindow::editorCloseRequested);
    save->click();
    recover->click();
    close->click();
    QCOMPARE(saveRequested.count(), 1);
    QCOMPARE(recoverRequested.count(), 1);
    QCOMPARE(closeRequested.count(), 1);

    window.showListPage();
    QVERIFY(!window.editorActionsVisible());
    QCOMPARE(entered.count(), 2);
}

// A double-click on a list row opens that article: the editor page becomes current FIRST - the list is left (its
// stream closes) before the article is asked for - then getArticle and lockArticle; the text engine shows the body,
// writable, and the actions are enabled.
void WriterHostTest::doubleClickOpensTheArticleOnTheEditorPage()
{
    HostRig rig;
    ui::ListViewState state;
    state.rows = {defaultArticle()};
    state.total = 1;
    rig.window.listScreen()->render(state);
    QTableWidget *table = rig.window.listScreen()->findChild<QTableWidget *>(QStringLiteral("listTable"));
    QVERIFY(table);
    emit table->cellDoubleClicked(0, 1);

    QVERIFY(rig.window.editorPageShown());
    QVERIFY(rig.host->surface());
    QCOMPARE(rig.host->surface()->state(), EditState::Editing);
    QCOMPARE(rig.order, (QStringList{QStringLiteral("listPageLeft"), QStringLiteral("getArticle"), QStringLiteral("lockArticle")}));
    ui::EditorWidget *editor = rig.editor();
    QVERIFY(editor);
    QCOMPARE(editor->blocks(), editor::deserialize(threeLineBody()));
    QVERIFY(!editor->isReadOnly());
    QVERIFY(rig.window.editorActionsVisible());
    QVERIFY(rig.button("editorSaveButton") && rig.button("editorSaveButton")->isEnabled());
    QVERIFY(rig.button("editorRecoverButton") && rig.button("editorRecoverButton")->isEnabled());
    QVERIFY2(rig.window.editorNoticeText().isEmpty(), qPrintable(rig.window.editorNoticeText()));
}

// The text engine's typing reaches the controller as a Typing commit (serializeBodyFromBlocks - the title follows the
// first line); Ctrl+Z / Ctrl+Shift+Z are the controller's undo / redo, written back into the widget.
void WriterHostTest::typingCommitsAndUndoGoesBack()
{
    HostRig rig;
    ui::EditController *surface = rig.host->openArticle(kId);
    QVERIFY(surface);
    ui::EditorWidget *editor = rig.editor();
    QVERIFY(editor);
    editor->focusLineStart(0);
    QTest::keyClicks(editor, QStringLiteral("z"));
    const QVector<editor::Block> typedBlocks{editor::textBlock(QStringLiteral("zTitle one")), editor::textBlock(QStringLiteral("Body line")),
                                             editor::textBlock(editor::END_MARKER)};
    QCOMPARE(surface->body(), editor::serializeBodyFromBlocks(typedBlocks));
    QCOMPARE(surface->title(), QStringLiteral("zTitle one"));
    QCOMPARE(surface->history().entries.size(), 2);

    QTest::keyClick(editor, Qt::Key_Z, Qt::ControlModifier);
    QCOMPARE(surface->body(), threeLineBody());
    QCOMPARE(editor->blocks(), editor::deserialize(threeLineBody()));
    QTest::keyClick(editor, Qt::Key_Z, Qt::ControlModifier | Qt::ShiftModifier);
    QCOMPARE(editor->blocks(), typedBlocks);
    QCOMPARE(surface->body(), editor::serializeBodyFromBlocks(typedBlocks));
}

// [저장] is the PUT (the surface keeps editing - the web's File > Save); [닫기] is the unlock, then the list page again
// (the shell re-enters the list there) with no text left behind in the editor.
void WriterHostTest::saveAndCloseRunTheRoundTrip()
{
    HostRig rig;
    ui::EditController *surface = rig.host->openArticle(kId);
    QVERIFY(surface);
    ui::EditorWidget *editor = rig.editor();
    editor->focusLineStart(0);
    QTest::keyClicks(editor, QStringLiteral("q"));
    rig.order.clear();
    QVERIFY(rig.button("editorSaveButton"));
    rig.button("editorSaveButton")->click();
    QCOMPARE(rig.model.count(QStringLiteral("saveArticle")), 1);
    QCOMPARE(rig.model.callsOf(QStringLiteral("saveArticle")).first().clientId, rig.lockId());
    QCOMPARE(rig.model.callsOf(QStringLiteral("saveArticle")).first().dto.value(QStringLiteral("title")).toString(),
             QStringLiteral("qTitle one"));
    QCOMPARE(rig.window.editorNoticeText(), QStringView(u"저장되었습니다.").toString());
    QVERIFY(rig.window.editorPageShown());

    QVERIFY(rig.button("editorCloseButton"));
    rig.button("editorCloseButton")->click();
    QCOMPARE(rig.order, (QStringList{QStringLiteral("saveArticle"), QStringLiteral("unlockArticle"), QStringLiteral("listPageEntered")}));
    QCOMPARE(rig.model.callsOf(QStringLiteral("unlockArticle")).first().clientId, rig.lockId());
    QVERIFY(rig.window.listPageShown());
    QVERIFY(!rig.host->surface());
    QVERIFY(editor->blocks().isEmpty());
    QVERIFY(editor->isReadOnly());
    QVERIFY(!rig.window.editorActionsVisible());
    rig.host->closeSurface();
    QCOMPARE(rig.model.count(QStringLiteral("unlockArticle")), 1);
}

// The lock not granted: the article read only with the web's sentence, [저장] / [복구] disabled, and [닫기] unlocks nothing.
void WriterHostTest::aRefusedLockShowsTheArticleReadOnly()
{
    HostRig rig({heldElsewhere()});
    ui::EditController *surface = rig.host->openArticle(kId);
    QVERIFY(surface);
    QCOMPARE(surface->state(), EditState::LockRefused);
    ui::EditorWidget *editor = rig.editor();
    QVERIFY(editor->isReadOnly());
    QCOMPARE(editor->blocks(), editor::deserialize(threeLineBody()));
    QCOMPARE(rig.window.editorNoticeText(), ui::lockFailMessage(QStringLiteral("locked")));
    QVERIFY(!rig.button("editorSaveButton")->isEnabled());
    QVERIFY(!rig.button("editorRecoverButton")->isEnabled());
    QVERIFY(rig.button("editorCloseButton")->isEnabled());
    rig.button("editorCloseButton")->click();
    QCOMPARE(rig.model.count(QStringLiteral("unlockArticle")), 0);
    QVERIFY(rig.window.listPageShown());
}

// step8 (c): a typing commit is renormalized (serializeBodyFromBlocks); when that moves the marker - here a loaded body
// with text after "(끝)" - the widget is handed the renormalized blocks (the web's remount), so what is shown is what
// is saved.
void WriterHostTest::aRenormalizedBodyIsPushedBackToTheWidget()
{
    const QString body = markup({editor::textBlock(QStringLiteral("a")), editor::textBlock(editor::END_MARKER),
                                 editor::textBlock(QStringLiteral("b"))});
    HostRig rig({defaultArticle(body)});
    ui::EditController *surface = rig.host->openArticle(kId);
    QVERIFY(surface);
    ui::EditorWidget *editor = rig.editor();
    QCOMPARE(editor->blocks(), editor::deserialize(body));
    editor->focusLineStart(0);
    QTest::keyClicks(editor, QStringLiteral("x"));
    const QVector<editor::Block> fixed{editor::textBlock(QStringLiteral("xa")), editor::textBlock(QStringLiteral("b")),
                                       editor::textBlock(editor::END_MARKER)};
    QCOMPARE(editor->blocks(), fixed);
    QCOMPARE(surface->body(), editor::serialize(fixed));
}

// The main window closing is the web's pagehide: the open surface unlocks - and the list is NOT re-entered (the app is
// on its way out). MainWindow::closeEvent -> closing is AppShellTest's (savesBoundsOnceOnCloseAndNeverOnResize).
void WriterHostTest::theWindowClosingUnlocksWithoutGoingBackToTheList()
{
    HostRig rig;
    QVERIFY(rig.host->openArticle(kId));
    rig.order.clear();
    emit rig.window.closing();
    QCOMPARE(rig.order, QStringList{QStringLiteral("unlockArticle")});
    QVERIFY(!rig.host->surface());
}

// The autosave timer (WriterPage's setInterval, as TimerPolicyTest allows it): single-shot, re-armed after every
// snapshot; armed only while editing and only when enabled - the web default is off.
void WriterHostTest::autosaveRunsOnASingleShotTimerOnlyWhenEnabled()
{
    {
        HostRig rig;
        QVERIFY(rig.host->openArticle(kId));
        QVERIFY2(!rig.host->autosaveArmed(), "autosave armed with the default (off) preferences");
    }
    {
        HostRig rig({heldElsewhere()}, ui::AutosaveConfig{true, 1, 1});
        QVERIFY(rig.host->openArticle(kId));
        QVERIFY2(!rig.host->autosaveArmed(), "autosave armed on a read-only surface");
    }
    HostRig rig({defaultArticle()}, ui::AutosaveConfig{true, 1, 1});
    QVERIFY(rig.host->openArticle(kId));
    QVERIFY(rig.host->autosaveArmed());
    QSignalSpy saved(rig.host.get(), &ui::WriterHost::autosaved);
    QVERIFY(saved.wait(5000));
    QCOMPARE(saved.count(), 1);
    QVERIFY(rig.drafts.find(kId));
    QCOMPARE(editwire::stringMember(rig.drafts.find(kId)->data, QStringLiteral("body")), threeLineBody());
    QVERIFY2(rig.host->autosaveArmed(), "the single-shot timer was not re-armed");
    rig.host->closeSurface();
    QVERIFY(!rig.host->autosaveArmed());
}

// One surface at a time (P5): the same article again is the open surface (no second lock - the web's dedup); another
// article is refused while one is open.
void WriterHostTest::opensOneSurfaceAtATime()
{
    HostRig rig({defaultArticle(), editwire::articleRow(QStringLiteral("AKR2"), QStringLiteral("Second"), threeLineBody())});
    ui::EditController *first = rig.host->openArticle(kId);
    QVERIFY(first);
    QCOMPARE(rig.host->openArticle(kId), first);
    QCOMPARE(rig.model.count(QStringLiteral("lockArticle")), 1);
    QVERIFY(!rig.host->openArticle(QStringLiteral("AKR2")));
    QCOMPARE(rig.model.count(QStringLiteral("getArticle")), 1);
    QVERIFY(!rig.host->openArticle(QString()));
}
