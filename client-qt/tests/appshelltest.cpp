#include "appshelltest.h"

#include "shell/appshell.h"
#include "shell/clientconfig.h"
#include "shell/configstore.h"
#include "shell/diag.h"
#include "shell/proberunner.h"
#include "shell/singleinstance.h"
#include "ui/mainwindow.h"
#include "ui/setupscreen.h"

#include <QApplication>
#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QList>
#include <QPushButton>
#include <QRect>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QtTest>

#include <memory>

using shell::AppShell;
using shell::BootScreen;
using shell::ClientConfig;

Q_DECLARE_METATYPE(shell::BootScreen)

namespace {

const QString kOrigin = QStringLiteral("http://127.0.0.1:3001");

// Stands in for the OS lock. primary=false plays a second launch.
class FakeGuard : public shell::InstanceGuard
{
public:
    FakeGuard(const shell::InstanceNames &names, bool primary) : m_names(names), m_primary(primary)
    {
    }

    bool tryBecomePrimary() override
    {
        ++attempts;
        m_held = m_primary;
        return m_primary;
    }
    bool notifyPrimary() override
    {
        ++notifications;
        return true;
    }
    bool isPrimary() const override { return m_held; }
    shell::InstanceNames names() const override { return m_names; }

    void setNames(const shell::InstanceNames &names) { m_names = names; }
    void knock() { emit activationRequested(); }

    int attempts = 0;
    int notifications = 0;

private:
    shell::InstanceNames m_names;
    bool m_primary = true;
    bool m_held = false;
};

// The real filesystem, with every call recorded. failWrites makes writeFile answer false.
class RecordingFileSystem : public shell::ConfigFileSystem
{
public:
    QStringList calls;
    bool failWrites = false;

    bool makeDirectory(const QString &dirPath) override
    {
        calls << QStringLiteral("makeDirectory");
        return shell::realFileSystem().makeDirectory(dirPath);
    }
    bool writeFile(const QString &filePath, const QByteArray &data) override
    {
        calls << QStringLiteral("writeFile");
        return !failWrites && shell::realFileSystem().writeFile(filePath, data);
    }
    bool renameOver(const QString &fromPath, const QString &toPath) override
    {
        calls << QStringLiteral("renameOver");
        return shell::realFileSystem().renameOver(fromPath, toPath);
    }
    bool readFile(const QString &filePath, QByteArray *out) override
    {
        calls << QStringLiteral("readFile");
        return shell::realFileSystem().readFile(filePath, out);
    }

    int count(const QString &name) const { return calls.count(name); }
};

QList<QJsonObject> readEvents(const QString &path)
{
    QList<QJsonObject> events;
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        return events;
    for (const QByteArray &line : file.readAll().split('\n')) {
        if (line.trimmed().isEmpty())
            continue;
        events << QJsonDocument::fromJson(line).object();
    }
    return events;
}

QStringList namesOf(const QList<QJsonObject> &events)
{
    QStringList names;
    for (const QJsonObject &event : events)
        names << event.value(QStringLiteral("event")).toString();
    return names;
}

QByteArray boundsJson(int width, int height, int x, int y, bool maximized)
{
    return QStringLiteral(R"json({"width":%1,"height":%2,"x":%3,"y":%4,"maximized":%5})json")
        .arg(width)
        .arg(height)
        .arg(x)
        .arg(y)
        .arg(maximized ? QStringLiteral("true") : QStringLiteral("false"))
        .toUtf8();
}

QByteArray configJson(const QString &serverUrl, const QByteArray &bounds = "null")
{
    return QByteArray(R"json({"schemaVersion":1,"serverUrl":")json") + serverUrl.toUtf8()
        + QByteArray(R"json(","bounds":)json") + bounds + QByteArray("}\n");
}

QRect rectOf(const shell::Bounds &b)
{
    return QRect(b.x, b.y, b.width, b.height);
}

// One test's world: a temporary user data folder with the diag file inside it (the harness
// layout), the fakes, and the shell under test.
struct Rig {
    QTemporaryDir dir;
    RecordingFileSystem fs;
    shell::Diag diag;
    FakeGuard guard;
    shell::UnimplementedProbeRunner runner;
    QList<QRect> workAreas{QRect(0, 0, 1920, 1080)};
    std::unique_ptr<AppShell> app;

    explicit Rig(bool selftest, bool primary = true)
        : diag(QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"))),
          guard(shell::instanceNamesFor(dir.path()), primary)
    {
        AppShell::Options options;
        options.selftest = selftest;
        options.workAreas = [this] { return workAreas; };
        app = std::make_unique<AppShell>(dir.path(), guard, diag, fs, runner, options);
    }

    QString diagPath() const { return QDir(dir.path()).filePath(QStringLiteral("diag.jsonl")); }
    QList<QJsonObject> events() const { return readEvents(diagPath()); }
    QStringList eventNames() const { return namesOf(events()); }

    bool writeConfig(const QByteArray &json) const
    {
        QFile file(QDir(dir.path()).filePath(QStringLiteral("config.json")));
        if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate))
            return false;
        return file.write(json) == json.size();
    }

    ClientConfig savedConfig() const { return shell::loadConfig(dir.path()); }

    void click(const char *buttonName) const
    {
        QVERIFY2(app->setupScreen(), "no setup screen to click on");
        QPushButton *button = app->setupScreen()->findChild<QPushButton *>(QLatin1String(buttonName));
        QVERIFY2(button, buttonName);
        button->click();
    }
};

} // namespace

void AppShellTest::initTestCase()
{
    // Closing a window inside a test must never post a quit to the runner's application.
    m_savedQuitOnLastWindowClosed = QApplication::quitOnLastWindowClosed();
    QApplication::setQuitOnLastWindowClosed(false);
}

void AppShellTest::cleanupTestCase()
{
    QApplication::setQuitOnLastWindowClosed(m_savedQuitOnLastWindowClosed);
}

// ---------------------------------------------------------------------------
// Boot branch (step5 AC: the boot-branch verdict): a stored, re-validated origin -> app window;
// anything else -> the setup screen.
void AppShellTest::decidesTheBootScreenFromTheConfig_data()
{
    QTest::addColumn<QByteArray>("raw");
    QTest::addColumn<BootScreen>("expected");

    QTest::newRow("stored origin") << configJson(kOrigin) << BootScreen::App;
    QTest::newRow("host:port the operator typed") << configJson(QStringLiteral("localhost:3001"))
                                                  << BootScreen::App;
    QTest::newRow("no file") << QByteArray() << BootScreen::Setup;
    QTest::newRow("broken json") << QByteArray("{oops") << BootScreen::Setup;
    QTest::newRow("hand-edited non-http origin")
        << configJson(QStringLiteral("mailto:x@y")) << BootScreen::Setup;
    QTest::newRow("serverUrl not a string") << QByteArray(R"json({"serverUrl":123})json")
                                            << BootScreen::Setup;
    QTest::newRow("serverUrl null") << QByteArray(R"json({"serverUrl":null})json")
                                    << BootScreen::Setup;
}

void AppShellTest::decidesTheBootScreenFromTheConfig()
{
    QFETCH(QByteArray, raw);
    QFETCH(BootScreen, expected);
    QCOMPARE(shell::decideBootScreen(shell::parseConfig(raw)), expected);
}

// Scenario A (scripts/verify-client.mjs:257-263, minus the Electron-only did-navigate /
// did-finish-load): app-ready -> config-loaded{true} -> app-window, and nothing else.
void AppShellTest::bootsToTheAppWindowWhenAServerIsConfigured()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));

    QCOMPARE(rig.app->start(), AppShell::StartResult::Primary);

    const QList<QJsonObject> events = rig.events();
    QCOMPARE(namesOf(events), (QStringList{QStringLiteral("app-ready"), QStringLiteral("config-loaded"),
                                           QStringLiteral("app-window")}));
    QCOMPARE(events.at(1).value(QStringLiteral("hasServerUrl")).toBool(false), true);
    QCOMPARE(events.at(2).value(QStringLiteral("origin")).toString(), kOrigin);

    QVERIFY(rig.app->appWindow());
    QVERIFY(!rig.app->setupScreen());
    QCOMPARE(rig.app->serverOrigin(), kOrigin);
}

// Scenario B. The canonical writes local-window BEFORE setup-shown (client/main.js:338-339); the
// judge does not pin their relative order (verify-client.mjs:293-303), this port keeps the
// canonical's.
void AppShellTest::bootsToTheSetupScreenWithoutAConfig()
{
    Rig rig(true);

    QCOMPARE(rig.app->start(), AppShell::StartResult::Primary);

    const QList<QJsonObject> events = rig.events();
    QCOMPARE(namesOf(events), (QStringList{QStringLiteral("app-ready"), QStringLiteral("config-loaded"),
                                           QStringLiteral("local-window"), QStringLiteral("setup-shown")}));
    QCOMPARE(events.at(1).value(QStringLiteral("hasServerUrl")).toBool(true), false);
    QCOMPARE(events.at(2).value(QStringLiteral("page")).toString(), QStringLiteral("setup"));
    QCOMPARE(events.at(3).value(QStringLiteral("reason")).toString(), QStringLiteral("no-config"));

    QVERIFY(rig.app->setupScreen());
    QVERIFY(!rig.app->appWindow());
    QVERIFY(rig.app->serverOrigin().isEmpty());
}

// Probes are user actions only (client/main.js:8, verify-client.mjs:8-9).
void AppShellTest::neverProbesOnTheBootPath()
{
    Rig withConfig(true);
    QVERIFY(withConfig.writeConfig(configJson(kOrigin)));
    withConfig.app->start();
    Rig without(true);
    without.app->start();

    for (const Rig *rig : {&withConfig, &without}) {
        QVERIFY(!rig->eventNames().contains(QStringLiteral("probe")));
        QCOMPARE(rig->runner.callCount(), 0);
        QCOMPARE(rig->app->probeCount(), 0);
    }
}

// step5 AC (the event-name set): the shell's vocabulary is exactly eight names, all inside the
// step4 gate, and a full session writes nothing outside it.
void AppShellTest::emitsOnlyAllowedEventNames()
{
    const QStringList vocabulary = shell::shellDiagEvents();
    const QSet<QString> expected{QStringLiteral("app-ready"),      QStringLiteral("config-loaded"),
                                 QStringLiteral("config-saved"),   QStringLiteral("probe"),
                                 QStringLiteral("second-instance"), QStringLiteral("local-window"),
                                 QStringLiteral("setup-shown"),    QStringLiteral("app-window")};
    QCOMPARE(QSet<QString>(vocabulary.begin(), vocabulary.end()), expected);
    QCOMPARE(vocabulary.size(), expected.size());
    for (const QString &name : vocabulary)
        QVERIFY2(shell::isAllowedDiagEvent(name), qPrintable(name));

    Rig rig(true);
    rig.app->start();
    QVERIFY(rig.app->setupScreen());
    rig.app->setupScreen()->setAddress(QStringLiteral("127.0.0.1:3001"));
    rig.click("probeButton");
    rig.click("saveButton");
    rig.guard.knock();

    const QStringList written = rig.eventNames();
    QCOMPARE(written.size(), 8);  // boot 4 + probe + config-saved + app-window + second-instance
    for (const QString &name : written)
        QVERIFY2(vocabulary.contains(name), qPrintable(name));
    QCOMPARE(rig.diag.rejectedEventCount(), 0);
}

// ---------------------------------------------------------------------------
// R2 (half of it unlocked in the canonical): a second launch creates no window, reads no config,
// creates no folder and writes not a single diag line - it only knocks.
void AppShellTest::staysSilentAsASecondInstance()
{
    Rig rig(true, /*primary=*/false);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));

    QCOMPARE(rig.app->start(), AppShell::StartResult::Secondary);

    QCOMPARE(rig.guard.attempts, 1);
    QCOMPARE(rig.guard.notifications, 1);
    QVERIFY2(rig.fs.calls.isEmpty(), qPrintable(rig.fs.calls.join(QLatin1Char(','))));
    QVERIFY2(!QFile::exists(rig.diagPath()), "a second instance wrote diag lines");
    QVERIFY(!rig.app->appWindow());
    QVERIFY(!rig.app->setupScreen());
}

// The same, with the real OS lock: two shells on one folder, one diag file (as two processes
// launched with the same CLIENT_USER_DATA / CLIENT_DIAG_FILE would have).
void AppShellTest::aSecondShellOnTheSameFolderOpensNoWindow()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString diagPath = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));
    {
        QFile config(QDir(dir.path()).filePath(QStringLiteral("config.json")));
        QVERIFY(config.open(QIODevice::WriteOnly));
        config.write(configJson(kOrigin));
    }

    const shell::InstanceNames names = shell::instanceNamesFor(dir.path());
    shell::SingleInstanceGuard guardA(names);
    shell::SingleInstanceGuard guardB(names);
    shell::Diag diagA(diagPath);
    shell::Diag diagB(diagPath);
    RecordingFileSystem fsA;
    RecordingFileSystem fsB;
    shell::UnimplementedProbeRunner runnerA;
    shell::UnimplementedProbeRunner runnerB;
    AppShell::Options options;
    options.selftest = true;
    options.workAreas = [] { return QList<QRect>{QRect(0, 0, 1920, 1080)}; };

    AppShell first(dir.path(), guardA, diagA, fsA, runnerA, options);
    AppShell second(dir.path(), guardB, diagB, fsB, runnerB, options);

    QCOMPARE(first.start(), AppShell::StartResult::Primary);
    QCOMPARE(second.start(), AppShell::StartResult::Secondary);

    QVERIFY(first.appWindow());
    QVERIFY2(!second.appWindow() && !second.setupScreen(), "the second launch opened a window");
    QVERIFY(fsB.calls.isEmpty());
    QTRY_VERIFY_WITH_TIMEOUT(namesOf(readEvents(diagPath)).contains(QStringLiteral("second-instance")),
                             5000);
    QCOMPARE(namesOf(readEvents(diagPath)).count(QStringLiteral("app-ready")), 1);
}

// R3 (b): under selftest the knock is recorded and no window is touched.
void AppShellTest::recordsASecondInstanceWithoutTouchingWindowsUnderSelftest()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window);

    rig.guard.knock();

    QCOMPARE(rig.eventNames().last(), QStringLiteral("second-instance"));
    QVERIFY(!window->isVisible());
}

// R3 (c): a minimized window comes back to the state it had before minimizing. Electron's
// restore() does that; Qt's showNormal() would drop the maximized state, so it is not used.
void AppShellTest::bringsAMinimizedWindowBackWithoutUnmaximizingIt()
{
    Rig rig(false);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window && window->isVisible());

    window->setWindowState(Qt::WindowMinimized | Qt::WindowMaximized);
    QVERIFY(window->isMinimized());
    rig.guard.knock();
    QVERIFY(!window->isMinimized());
    QVERIFY2(window->isMaximized(), "un-minimizing must not un-maximize");
    QVERIFY(window->isVisible());

    // A window minimized from the NORMAL state comes back normal. It has to be normal before it
    // is minimized: on the real windows platform the OS restores a window minimized from
    // maximized straight back to maximized (measured 2026-09-11 - offscreen has no such memory).
    window->showNormal();
    QTRY_VERIFY(!window->isMaximized());
    window->setWindowState(Qt::WindowMinimized);
    QVERIFY(window->isMinimized());
    rig.guard.knock();
    QVERIFY(!window->isMinimized());
    QTRY_VERIFY(!window->isMaximized());

    QCOMPARE(rig.eventNames().count(QStringLiteral("second-instance")), 2);
}

// R3 (c), the other half: a window that is not minimized is only brought forward
// (client/main.js:86 - calling restore() unconditionally would un-maximize it).
void AppShellTest::leavesAMaximizedWindowMaximizedWhenActivated()
{
    Rig rig(false);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window);
    window->showMaximized();
    QTRY_VERIFY(window->isMaximized());

    rig.guard.knock();

    QVERIFY(window->isMaximized());
    QVERIFY(window->isVisible());
}

// ---------------------------------------------------------------------------
// CLIENT_SELFTEST=1: windows exist and diag is written, nothing is shown (step5.md C).
void AppShellTest::neverShowsAWindowUnderSelftest()
{
    Rig withConfig(true);
    QVERIFY(withConfig.writeConfig(configJson(kOrigin)));
    withConfig.app->start();
    QVERIFY(withConfig.app->appWindow());
    QVERIFY(!withConfig.app->appWindow()->isVisible());
    QVERIFY(!withConfig.app->appWindowShown());

    Rig without(true);
    without.app->start();
    QVERIFY(without.app->setupScreen());
    QVERIFY(!without.app->setupScreen()->isVisible());
}

void AppShellTest::showsTheWindowOutsideSelftest()
{
    Rig withConfig(false);
    QVERIFY(withConfig.writeConfig(configJson(kOrigin)));
    withConfig.app->start();
    QVERIFY(withConfig.app->appWindow());
    QVERIFY(withConfig.app->appWindow()->isVisible());
    QVERIFY(withConfig.app->appWindowShown());

    Rig without(false);
    without.app->start();
    QVERIFY(without.app->setupScreen());
    QVERIFY(without.app->setupScreen()->isVisible());
}

// ---------------------------------------------------------------------------
// R8 (NEW coverage): created at the stored normal rectangle, maximized after creation - so the
// normal rectangle survives underneath the maximized window.
void AppShellTest::restoresTheStoredRectangleThenMaximizes()
{
    Rig rig(false);
    QVERIFY(rig.writeConfig(configJson(kOrigin, boundsJson(1200, 800, 30, 40, true))));
    rig.app->start();

    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window);
    QTRY_VERIFY(window->isMaximized());
    QCOMPARE(window->normalGeometry(), QRect(30, 40, 1200, 800));
}

// The restore path really consults the monitors (mutation M5-2 at the call site): stored bounds
// no work area holds are dropped as a whole - size included - and the window opens at the
// defaults, unmoved (client/lib/clientConfig.js:82 all-or-nothing).
void AppShellTest::opensAtTheDefaultsWhenNoWorkAreaHoldsTheStoredBounds()
{
    Rig offScreen(true);
    QVERIFY(offScreen.writeConfig(configJson(kOrigin, boundsJson(1200, 800, 5000, 5000, false))));
    offScreen.app->start();
    QVERIFY(!offScreen.app->savedBounds().valid);
    QVERIFY(offScreen.app->appWindow());
    QCOMPARE(offScreen.app->appWindow()->size(), QSize(1440, 900));
    QVERIFY(!offScreen.app->appWindow()->testAttribute(Qt::WA_Moved));

    // Control: the same kind of rectangle on a secondary monitor left of the primary is kept.
    Rig secondary(true);
    secondary.workAreas = {QRect(-1920, 0, 1920, 1080), QRect(0, 0, 1920, 1080)};
    QVERIFY(secondary.writeConfig(configJson(kOrigin, boundsJson(1024, 720, -1800, 100, false))));
    secondary.app->start();
    QVERIFY(secondary.app->savedBounds().valid);
    QVERIFY(secondary.app->appWindow());
    QCOMPARE(secondary.app->appWindow()->geometry(), QRect(-1800, 100, 1024, 720));
}

// W-N1 on the real boot path: 850x650 is valid (kept, positioned) and clamped to 1024x720.
void AppShellTest::clampsBandBoundsToTheWindowMinimumOnBoot()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin, boundsJson(850, 650, 10, 10, false))));
    rig.app->start();

    QVERIFY(rig.app->savedBounds().valid);
    QCOMPARE(rig.app->savedBounds().width, 850);
    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window);
    QCOMPARE(window->size(), QSize(1024, 720));
    QCOMPARE(window->geometry().topLeft(), QPoint(10, 10));
}

// R11 (NEW coverage): no resize/move hook - the one write of a window's life is its close.
void AppShellTest::savesBoundsOnceOnCloseAndNeverOnResize()
{
    Rig rig(false);
    rig.workAreas = {QRect(-4000, -4000, 12000, 12000)};
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window);
    QVERIFY(rig.app->appWindowShown());

    window->setGeometry(100, 100, 1100, 750);
    QCoreApplication::processEvents();
    window->move(150, 120);
    QCoreApplication::processEvents();
    window->resize(1300, 850);
    QCoreApplication::processEvents();
    QCOMPARE(rig.fs.count(QStringLiteral("writeFile")), 0);

    const QRect normal = window->normalGeometry();
    QVERIFY(window->close());

    QCOMPARE(rig.fs.count(QStringLiteral("writeFile")), 1);
    QCOMPARE(rig.fs.count(QStringLiteral("renameOver")), 1);
    const ClientConfig saved = rig.savedConfig();
    QCOMPARE(saved.serverUrl, kOrigin);
    QVERIFY(saved.bounds.valid);
    QCOMPARE(rectOf(saved.bounds), normal);
    QVERIFY(!saved.bounds.maximized);
    // Closing saves bounds; it is not a "config-saved" event (client/main.js logs that only when
    // an address is saved - saveBoundsFrom() writes silently).
    QVERIFY(!rig.eventNames().contains(QStringLiteral("config-saved")));
}

// R9 (NEW coverage) on the live path: a window closed while maximized stores its normal
// rectangle and the flag.
void AppShellTest::savesTheNormalRectangleOfAMaximizedWindow()
{
    Rig rig(false);
    rig.workAreas = {QRect(-4000, -4000, 12000, 12000)};
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window);

    window->setGeometry(100, 100, 1200, 800);
    QCoreApplication::processEvents();
    const QRect normal = window->geometry();
    window->showMaximized();
    QTRY_VERIFY(window->isMaximized());
    QTRY_VERIFY(window->geometry() != normal);  // non-vacuity: maximized is another rectangle

    QVERIFY(window->close());

    const ClientConfig saved = rig.savedConfig();
    QVERIFY(saved.bounds.valid);
    QCOMPARE(rectOf(saved.bounds), normal);
    QVERIFY(saved.bounds.maximized);
}

// R10 (NEW coverage): a window never shown (selftest) never overwrites the stored layout.
void AppShellTest::doesNotSaveBoundsForAWindowThatWasNeverShown()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin, boundsJson(1200, 800, 30, 40, false))));
    rig.app->start();
    QVERIFY(!rig.app->appWindowShown());
    QVERIFY(rig.app->appWindow());

    rig.app->appWindow()->close();

    QCOMPARE(rig.fs.count(QStringLiteral("writeFile")), 0);
    QCOMPARE(rectOf(rig.savedConfig().bounds), QRect(30, 40, 1200, 800));
}

// W-N2 (NEW coverage) on the live path: the monitor the window was on is gone by close time.
// The canonical keeps the previous known-good bounds and STILL writes (client/main.js:371-373).
void AppShellTest::keepsThePreviousBoundsWhenTheWindowClosesOffScreen()
{
    Rig rig(false);
    QVERIFY(rig.writeConfig(configJson(kOrigin, boundsJson(1200, 800, 30, 40, false))));
    rig.app->start();
    QVERIFY(rig.app->savedBounds().valid);

    rig.workAreas = {QRect(20000, 20000, 1920, 1080)};
    QVERIFY(rig.app->appWindow());
    QVERIFY(rig.app->appWindow()->close());

    QCOMPARE(rig.fs.count(QStringLiteral("writeFile")), 1);
    const ClientConfig saved = rig.savedConfig();
    QVERIFY2(saved.bounds.valid, "the previous bounds were reset instead of kept");
    QCOMPARE(rectOf(saved.bounds), QRect(30, 40, 1200, 800));
    QCOMPARE(saved.serverUrl, kOrigin);
}

// R12 (NEW coverage): a write that fails is swallowed - the window closes anyway.
void AppShellTest::closesEvenWhenTheConfigCannotBeWritten()
{
    Rig rig(false);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    rig.fs.failWrites = true;
    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window);

    QVERIFY2(window->close(), "a failed save refused the close");
    QVERIFY(!window->isVisible());
    QCOMPARE(rig.fs.count(QStringLiteral("writeFile")), 1);
    QVERIFY(!rig.eventNames().contains(QStringLiteral("config-saved")));
}

// ---------------------------------------------------------------------------
void AppShellTest::probesOnlyWhenTheUserAsks()
{
    Rig rig(true);
    rig.app->start();
    ui::SetupScreen *screen = rig.app->setupScreen();
    QVERIFY(screen);

    // An address that does not normalise is answered locally - no probe, no line.
    screen->setAddress(QStringLiteral("mailto:x@y"));
    rig.click("probeButton");
    QCOMPARE(rig.runner.callCount(), 0);
    QVERIFY(!rig.eventNames().contains(QStringLiteral("probe")));
    QVERIFY2(screen->statusText().contains(QStringLiteral("unsupported-scheme")),
             qPrintable(screen->statusText()));

    screen->setAddress(QStringLiteral(" 127.0.0.1:3001 "));
    rig.click("probeButton");
    QCOMPARE(rig.runner.callCount(), 1);
    QCOMPARE(rig.app->probeCount(), 1);

    const QJsonObject probe = rig.events().last();
    QCOMPARE(probe.value(QStringLiteral("event")).toString(), QStringLiteral("probe"));
    QCOMPARE(probe.value(QStringLiteral("origin")).toString(), kOrigin);
    QCOMPARE(probe.value(QStringLiteral("ok")).toBool(true), false);
    QCOMPARE(probe.value(QStringLiteral("reason")).toString(), QStringLiteral("unreachable"));
    QVERIFY2(screen->statusText().contains(QStringLiteral("unreachable")),
             qPrintable(screen->statusText()));
}

// step5.md A: the fact that the probe is a stand-in is on the screen, not only in a README.
void AppShellTest::showsTheStandInNoticeOnTheSetupScreen()
{
    Rig rig(true);
    rig.app->start();
    ui::SetupScreen *screen = rig.app->setupScreen();
    QVERIFY(screen);

    QVERIFY(!screen->noticeText().isEmpty());
    QCOMPARE(screen->noticeText(), rig.runner.limitationNotice());
    QLabel *label = screen->findChild<QLabel *>(QStringLiteral("noticeLabel"));
    QVERIFY(label);
    QVERIFY(!label->isHidden());
}

// Save = normalise, persist, config-saved{origin}, then the app window replaces the setup screen
// (client/main.js:129-142). In step5 saving does NOT probe first - see client-qt/README.md.
void AppShellTest::savesANormalisedAddressAndOpensTheAppWindow()
{
    Rig rig(true);
    rig.app->start();
    QVERIFY(rig.app->setupScreen());
    rig.app->setupScreen()->setAddress(QStringLiteral("  LOCALHOST:3001/list?x=1 "));

    rig.click("saveButton");

    const QString origin = QStringLiteral("http://localhost:3001");
    QCOMPARE(rig.savedConfig().serverUrl, origin);
    const QList<QJsonObject> events = rig.events();
    QCOMPARE(namesOf(events).mid(4), (QStringList{QStringLiteral("config-saved"), QStringLiteral("app-window")}));
    QCOMPARE(events.at(4).value(QStringLiteral("origin")).toString(), origin);
    QCOMPARE(events.at(5).value(QStringLiteral("origin")).toString(), origin);

    QVERIFY(!rig.app->setupScreen());
    QVERIFY(rig.app->appWindow());
    QCOMPARE(rig.app->serverOrigin(), origin);
    QCOMPARE(rig.runner.callCount(), 0);
}

void AppShellTest::refusesToSaveAnAddressThatDoesNotNormalise()
{
    Rig rig(true);
    rig.app->start();
    ui::SetupScreen *screen = rig.app->setupScreen();
    QVERIFY(screen);

    screen->setAddress(QStringLiteral("ftp://h"));
    rig.click("saveButton");
    QVERIFY2(screen->statusText().contains(QStringLiteral("unsupported-scheme")),
             qPrintable(screen->statusText()));

    screen->setAddress(QStringLiteral("   "));
    rig.click("saveButton");
    QVERIFY2(screen->statusText().contains(QStringLiteral("empty")), qPrintable(screen->statusText()));

    QCOMPARE(rig.fs.count(QStringLiteral("writeFile")), 0);
    QVERIFY(!rig.eventNames().contains(QStringLiteral("config-saved")));
    QVERIFY(rig.app->setupScreen());
    QVERIFY(!rig.app->appWindow());
}

// ---------------------------------------------------------------------------
void AppShellTest::selfTestPassesAfterACleanBoot()
{
    Rig withConfig(true);
    QVERIFY(withConfig.writeConfig(configJson(kOrigin)));
    withConfig.app->start();
    QVERIFY2(withConfig.app->selfTestFailures().isEmpty(),
             qPrintable(withConfig.app->selfTestFailures().join(QStringLiteral(" | "))));

    Rig without(true);
    without.app->start();
    QVERIFY2(without.app->selfTestFailures().isEmpty(),
             qPrintable(without.app->selfTestFailures().join(QStringLiteral(" | "))));
}

// Non-vacuity of --selftest: each invariant it claims to check can actually fail.
void AppShellTest::selfTestFailsWhenTheInvariantsDoNotHold()
{
    Rig notStarted(true);
    QVERIFY(!notStarted.app->selfTestFailures().isEmpty());

    Rig probed(true);
    probed.app->start();
    QVERIFY(probed.app->setupScreen());
    probed.app->setupScreen()->setAddress(kOrigin);
    probed.click("probeButton");
    QVERIFY(probed.app->selfTestFailures().join(QLatin1Char(' ')).contains(QStringLiteral("probe")));

    Rig foreignLock(true);
    foreignLock.guard.setNames(shell::instanceNamesFor(QStringLiteral("C:/somewhere/else")));
    foreignLock.app->start();
    QVERIFY(foreignLock.app->selfTestFailures().join(QLatin1Char(' ')).contains(QStringLiteral("R1")));

    Rig shownUnderSelftest(true);
    shownUnderSelftest.app->start();
    QVERIFY(shownUnderSelftest.app->setupScreen());
    shownUnderSelftest.app->setupScreen()->show();
    QVERIFY(shownUnderSelftest.app->selfTestFailures().join(QLatin1Char(' ')).contains(
        QStringLiteral("visible")));
}
