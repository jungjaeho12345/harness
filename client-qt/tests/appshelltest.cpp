#include "appshelltest.h"

#include "loginwire.h"
#include "stubhttpserver.h"

#include "net/httpproberunner.h"
#include "shell/appshell.h"
#include "shell/clientconfig.h"
#include "shell/configstore.h"
#include "shell/diag.h"
#include "shell/proberunner.h"
#include "shell/serverurl.h"
#include "shell/singleinstance.h"
#include "ui/listcontroller.h"
#include "ui/listscreen.h"
#include "ui/logincontroller.h"
#include "ui/loginscreen.h"
#include "ui/mainwindow.h"
#include "ui/setupscreen.h"

#include <QApplication>
#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QLabel>
#include <QLineEdit>
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

// A transport double for the save-order cases: a fixed verdict and a fixed "final URL".
class ScriptedRunner : public shell::ProbeRunner
{
public:
    shell::HealthVerdict verdict;
    QString finalUrl;  // null QString = nothing observed
    int calls = 0;

    shell::HealthVerdict probe(const QString &, QString *reached) override
    {
        ++calls;
        if (reached)
            *reached = finalUrl;
        return verdict;
    }
};

// Which probe runner the shell gets: step5's stand-in (always unreachable), the scripted double,
// or the real HTTP runner (step7) aimed at loopback stubs.
enum class Runner { StandIn, Scripted, Http };

// Whether the shell gets a Model factory (step10). Every rig gets one - as main.cpp always does -
// except the --selftest case that proves a missing one is reported.
enum class ModelWiring { Fake, None };

// One test's world: a temporary user data folder with the diag file inside it (the harness
// layout), the fakes, and the shell under test.
struct Rig {
    QTemporaryDir dir;
    RecordingFileSystem fs;
    shell::Diag diag;
    FakeGuard guard;
    shell::UnimplementedProbeRunner runner;
    ScriptedRunner scripted;
    std::unique_ptr<net::HttpProbeRunner> http;
    QList<QRect> workAreas{QRect(0, 0, 1920, 1080)};
    // The app window's Model (owned by the shell; this is a view of it) and what the factory saw.
    // seed = what that Model starts with (step11's list tests put articles in it before start()).
    net::FakeSeed seed = loginwire::deskSeed();
    loginwire::WireScriptedModel *model = nullptr;
    int modelsMade = 0;
    QString modelOrigin;
    std::unique_ptr<AppShell> app;

    explicit Rig(bool selftest, bool primary = true, Runner kind = Runner::StandIn,
                 ModelWiring wiring = ModelWiring::Fake)
        : diag(QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"))),
          guard(shell::instanceNamesFor(dir.path()), primary)
    {
        if (kind == Runner::Http)
            http = std::make_unique<net::HttpProbeRunner>(&diag, 3000);
        shell::ProbeRunner &injected = kind == Runner::Scripted ? static_cast<shell::ProbeRunner &>(scripted)
                                       : kind == Runner::Http   ? static_cast<shell::ProbeRunner &>(*http)
                                                                : static_cast<shell::ProbeRunner &>(runner);
        AppShell::Options options;
        options.selftest = selftest;
        options.workAreas = [this] { return workAreas; };
        if (wiring == ModelWiring::Fake) {
            options.modelFactory = [this](const QString &origin) -> std::unique_ptr<net::INewsModel> {
                auto made = std::make_unique<loginwire::WireScriptedModel>(seed);
                model = made.get();
                ++modelsMade;
                modelOrigin = origin;
                return made;
            };
        }
        app = std::make_unique<AppShell>(dir.path(), guard, diag, fs, injected, options);
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

    QByteArray diagRaw() const
    {
        QFile file(diagPath());
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray();
    }

    ui::LoginScreen *loginScreen() const { return app->appWindow() ? app->appWindow()->loginScreen() : nullptr; }

    QLineEdit *field(const char *name) const
    {
        return loginScreen() ? loginScreen()->findChild<QLineEdit *>(QLatin1String(name)) : nullptr;
    }

    // The user's path: type into the two fields and press the login button.
    void submitLogin(const QString &user, const QString &password) const
    {
        QVERIFY2(loginScreen(), "no login screen to type into");
        QLineEdit *userField = field("userIdEdit");
        QLineEdit *passwordField = field("passwordEdit");
        QVERIFY2(userField && passwordField, "the login fields are missing");
        userField->setText(user);
        passwordField->setText(password);
        QPushButton *button = loginScreen()->findChild<QPushButton *>(QStringLiteral("loginButton"));
        QVERIFY2(button, "loginButton");
        button->click();
    }
};

QJsonObject lastEvent(const QList<QJsonObject> &events, const QString &name)
{
    for (int i = events.size() - 1; i >= 0; --i) {
        if (events.at(i).value(QStringLiteral("event")).toString() == name)
            return events.at(i);
    }
    return QJsonObject();
}

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

    Rig rig(true, true, Runner::Scripted);
    rig.scripted.verdict.ok = true;
    rig.app->start();
    QVERIFY(rig.app->setupScreen());
    rig.app->setupScreen()->setAddress(QStringLiteral("127.0.0.1:3001"));
    rig.click("probeButton");
    rig.click("saveButton");
    rig.guard.knock();

    const QStringList written = rig.eventNames();
    // boot 4 + probe (button) + probe (save probes first, step7) + config-saved + app-window
    // + second-instance
    QCOMPARE(written.size(), 9);
    QCOMPARE(written.count(QStringLiteral("probe")), 2);
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

// step5 put the stand-in's warning on the runner; with the real runner injected (step7) the
// setup screen has nothing to confess and the label stays hidden.
void AppShellTest::showsNoNoticeOnceTheRealRunnerIsInjected()
{
    Rig rig(true, true, Runner::Http);
    rig.app->start();
    ui::SetupScreen *screen = rig.app->setupScreen();
    QVERIFY(screen);

    QVERIFY(screen->noticeText().isEmpty());
    QLabel *label = screen->findChild<QLabel *>(QStringLiteral("noticeLabel"));
    QVERIFY(label);
    QVERIFY(label->isHidden());
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

    QCOMPARE(rig.runner.callCount(), 0);  // an address that does not normalise is never probed
    QCOMPARE(rig.fs.count(QStringLiteral("writeFile")), 0);
    QVERIFY(!rig.eventNames().contains(QStringLiteral("config-saved")));
    QVERIFY(rig.app->setupScreen());
    QVERIFY(!rig.app->appWindow());
}

// ---------------------------------------------------------------------------
// client/main.js:132-133 - "실패한 주소는 저장하지 않는다": normalise -> probe -> a failed probe
// saves NOTHING (not even the typed address), writes no config-saved and keeps the setup screen.
// Saving first (the step5 order) would store an address the next boot cannot reach.
void AppShellTest::savesNothingWhenTheProbeFails()
{
    Rig rig(true);  // the stand-in: every probe is unreachable
    rig.app->start();
    ui::SetupScreen *screen = rig.app->setupScreen();
    QVERIFY(screen);
    screen->setAddress(QStringLiteral("127.0.0.1:3001"));

    rig.click("saveButton");

    QCOMPARE(rig.runner.callCount(), 1);
    QCOMPARE(rig.fs.count(QStringLiteral("writeFile")), 0);
    QCOMPARE(rig.fs.count(QStringLiteral("renameOver")), 0);
    QVERIFY(rig.savedConfig().serverUrl.isEmpty());
    const QList<QJsonObject> events = rig.events();
    QCOMPARE(namesOf(events).mid(4), QStringList{QStringLiteral("probe")});
    QCOMPARE(events.at(4).value(QStringLiteral("ok")).toBool(true), false);
    QCOMPARE(events.at(4).value(QStringLiteral("reason")).toString(), QStringLiteral("unreachable"));
    QVERIFY(rig.app->setupScreen());
    QVERIFY(!rig.app->appWindow());
    QVERIFY(rig.app->serverOrigin().isEmpty());
    QVERIFY2(screen->statusText().contains(QStringLiteral("unreachable")), qPrintable(screen->statusText()));
}

// client/main.js:132-137: a successful probe saves the origin the probe ENDED at (the promoted
// one - R26), not the address that was typed; config-saved and the app window carry it too.
void AppShellTest::savesTheProbedFinalOriginAndOpensTheAppWindow()
{
    Rig rig(true, true, Runner::Scripted);
    rig.scripted.verdict.ok = true;
    rig.scripted.finalUrl = QStringLiteral("https://news.example/api/health");
    rig.app->start();
    QVERIFY(rig.app->setupScreen());
    rig.app->setupScreen()->setAddress(QStringLiteral("  LOCALHOST:3001/list?x=1 "));

    rig.click("saveButton");

    const QString typed = QStringLiteral("http://localhost:3001");
    const QString promoted = QStringLiteral("https://news.example");
    QCOMPARE(rig.scripted.calls, 1);
    QCOMPARE(rig.savedConfig().serverUrl, promoted);
    const QList<QJsonObject> events = rig.events();
    QCOMPARE(namesOf(events).mid(4), (QStringList{QStringLiteral("probe"), QStringLiteral("config-saved"),
                                                 QStringLiteral("app-window")}));
    QCOMPARE(events.at(4).value(QStringLiteral("origin")).toString(), typed);
    QCOMPARE(events.at(4).value(QStringLiteral("finalOrigin")).toString(), promoted);
    QCOMPARE(events.at(4).value(QStringLiteral("promoted")).toBool(false), true);
    QCOMPARE(events.at(5).value(QStringLiteral("origin")).toString(), promoted);
    QCOMPARE(events.at(6).value(QStringLiteral("origin")).toString(), promoted);

    QVERIFY(!rig.app->setupScreen());
    QVERIFY(rig.app->appWindow());
    QCOMPARE(rig.app->serverOrigin(), promoted);
}

// The same, end to end over real HTTP: the typed server answers 302 to another origin whose
// /api/health is the article server - that other origin is what gets saved.
void AppShellTest::savesTheRedirectedOriginOfARealProbe()
{
    StubHttpServer typed;
    StubHttpServer real;
    QVERIFY(typed.listen());
    QVERIFY(real.listen());
    typed.always(StubReply::redirect(shell::healthUrl(real.origin()).toUtf8()));
    real.always(StubReply::json(200, R"json({"ok":true})json"));

    Rig rig(true, true, Runner::Http);
    rig.app->start();
    QVERIFY(rig.app->setupScreen());
    rig.app->setupScreen()->setAddress(typed.origin());

    rig.click("saveButton");

    QCOMPARE(rig.savedConfig().serverUrl, real.origin());
    QCOMPARE(rig.app->serverOrigin(), real.origin());
    const QList<QJsonObject> events = rig.events();
    QCOMPARE(namesOf(events).mid(4), (QStringList{QStringLiteral("net-request"), QStringLiteral("probe"),
                                                 QStringLiteral("config-saved"), QStringLiteral("app-window")}));
    QCOMPARE(events.at(4).value(QStringLiteral("route")).toString(), QStringLiteral("health"));
    QCOMPARE(events.at(5).value(QStringLiteral("origin")).toString(), typed.origin());
    QCOMPARE(events.at(5).value(QStringLiteral("finalOrigin")).toString(), real.origin());
    QCOMPARE(events.at(5).value(QStringLiteral("promoted")).toBool(false), true);
    QCOMPARE(events.at(6).value(QStringLiteral("origin")).toString(), real.origin());
    QCOMPARE(typed.requests().size(), 1);
    QCOMPARE(real.requests().size(), 1);
}

// A captive portal answers 200 with a page: not the article server -> nothing saved.
void AppShellTest::savesNothingWhenARealProbeMeetsAPortal()
{
    StubHttpServer portal;
    QVERIFY(portal.listen());
    portal.always(StubReply::html(200, "<html>Sign in to the Wi-Fi</html>"));

    Rig rig(true, true, Runner::Http);
    rig.app->start();
    QVERIFY(rig.app->setupScreen());
    rig.app->setupScreen()->setAddress(portal.origin());

    rig.click("saveButton");

    QCOMPARE(rig.fs.count(QStringLiteral("writeFile")), 0);
    QVERIFY(!rig.eventNames().contains(QStringLiteral("config-saved")));
    const QJsonObject probe = rig.events().last();
    QCOMPARE(probe.value(QStringLiteral("event")).toString(), QStringLiteral("probe"));
    QCOMPARE(probe.value(QStringLiteral("ok")).toBool(true), false);
    QCOMPARE(probe.value(QStringLiteral("reason")).toString(), QStringLiteral("not-article-server"));
    QCOMPARE(probe.value(QStringLiteral("finalOrigin")).toString(), portal.origin());
    QCOMPARE(probe.value(QStringLiteral("promoted")).toBool(true), false);
    QVERIFY(rig.app->setupScreen());
    QVERIFY(!rig.app->appWindow());
}

// ---------------------------------------------------------------------------
// Login (step10). The app window opens logged out (the cookie jar is memory only - decisions (6))
// and asks the server nothing by itself: its Model is made once, for the origin it serves, and not
// called until someone logs in. On the setup path the Model is made when - and only when - the app
// window opens, for the PROMOTED origin the probe ended at.
void AppShellTest::opensTheAppWindowOnTheLoginPageWithoutAskingTheServer()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();

    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window);
    QVERIFY(window->loginPageShown());
    QVERIFY(!window->listPageShown());
    QCOMPARE(window->statusText(), window->idleStatusText());
    QVERIFY(rig.app->loginController());
    QCOMPARE(rig.modelsMade, 1);
    QCOMPARE(rig.modelOrigin, kOrigin);
    QVERIFY(rig.model);
    QCOMPARE(rig.model->loginCalls, 0);
    QCOMPARE(rig.model->sessionCalls, 0);
    QVERIFY(!rig.eventNames().contains(QStringLiteral("login")));
    QVERIFY(!rig.eventNames().contains(QStringLiteral("session")));

    Rig setup(true, true, Runner::Scripted);
    setup.scripted.verdict.ok = true;
    setup.scripted.finalUrl = QStringLiteral("https://news.example/api/health");
    setup.app->start();
    QCOMPARE(setup.modelsMade, 0);
    QVERIFY(!setup.app->loginController());
    setup.app->setupScreen()->setAddress(kOrigin);
    setup.click("saveButton");
    QCOMPARE(setup.modelsMade, 1);
    QCOMPARE(setup.modelOrigin, QStringLiteral("https://news.example"));
    QVERIFY(setup.app->appWindow()->loginPageShown());
}

// The password field is masked, and the password leaves the screen the moment it is submitted (the
// id stays, for the retry). Nothing typed reaches the diag.
void AppShellTest::masksThePasswordAndLetsGoOfItOnSubmit()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    QVERIFY(rig.model);
    QLineEdit *password = rig.field("passwordEdit");
    QVERIFY(password);
    QCOMPARE(password->echoMode(), QLineEdit::Password);

    rig.submitLogin(loginwire::kUser, QStringLiteral("pw-typed-4d2a"));

    QVERIFY(password->text().isEmpty());
    QCOMPARE(rig.field("userIdEdit")->text(), loginwire::kUser);
    QCOMPARE(rig.model->loginCalls, 1);
    QVERIFY(!rig.diagRaw().contains("pw-typed-4d2a"));
}

// Success = login{200}, then the identity asked of the server (session{200} - the list's entry, step11),
// THEN the list slot with the server's display label and the list (list-loaded). Nothing past the login
// page before that answer.
void AppShellTest::entersTheListSlotOnlyAfterTheServerConfirmsTheIdentity()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    QVERIFY(rig.model);

    rig.submitLogin(loginwire::kUser, loginwire::kPassword);

    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window->listPageShown());
    QVERIFY(!window->loginPageShown());
    QCOMPARE(rig.model->loginCalls, 1);
    QCOMPARE(rig.model->sessionCalls, 1);
    QCOMPARE(window->statusText(), QStringLiteral("desk · 편집부 · (D)"));
    QVERIFY(rig.loginScreen()->errorText().isEmpty());
    const QList<QJsonObject> events = rig.events();
    QCOMPARE(namesOf(events), (QStringList{QStringLiteral("app-ready"), QStringLiteral("config-loaded"),
                                           QStringLiteral("app-window"), QStringLiteral("login"),
                                           QStringLiteral("session"), QStringLiteral("list-loaded")}));
    QCOMPARE(events.at(3).value(QStringLiteral("status")).toInt(), 200);
    QCOMPARE(events.at(4).value(QStringLiteral("status")).toInt(), 200);
}

// A failed login never gets past the login page: the sentence is shown, the server is NOT asked who
// we are, and the list slot stays closed (mutation M10-2 must turn this red). The account lock and the
// IP limit say different things on the same screen.
void AppShellTest::staysOnTheLoginPageWhenLoginFails()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    QVERIFY(rig.model);
    ui::MainWindow *window = rig.app->appWindow();

    rig.submitLogin(loginwire::kUser, QStringLiteral("not-the-password"));
    QVERIFY(window->loginPageShown());
    QVERIFY(!window->listPageShown());
    QCOMPARE(rig.loginScreen()->errorText(), ui::loginFailureMessage(ui::LoginFailure::InvalidCredentials));
    QCOMPARE(rig.model->sessionCalls, 0);
    QCOMPARE(window->statusText(), window->idleStatusText());
    QVERIFY(!rig.eventNames().contains(QStringLiteral("session")));
    QCOMPARE(lastEvent(rig.events(), QStringLiteral("login")).value(QStringLiteral("status")).toInt(), 401);

    rig.model->loginWire = loginwire::accountLocked();
    rig.submitLogin(loginwire::kUser, loginwire::kPassword);
    QVERIFY(window->loginPageShown());
    QCOMPARE(rig.loginScreen()->errorText(), ui::loginFailureMessage(ui::LoginFailure::AccountLocked));

    rig.model->loginWire = loginwire::rateLimited();
    rig.submitLogin(loginwire::kUser, loginwire::kPassword);
    QVERIFY(window->loginPageShown());
    QCOMPARE(rig.loginScreen()->errorText(), ui::loginFailureMessage(ui::LoginFailure::RateLimited));
    QCOMPARE(rig.model->sessionCalls, 0);
    QVERIFY(!rig.eventNames().contains(QStringLiteral("session")));
    QVERIFY(!rig.eventNames().contains(QStringLiteral("list-loaded")));  // step11: the list never entered
    QVERIFY(!rig.app->listController()->isEntered());
}

// The identity check says "no session" (or cannot be answered): back to the login page with the
// reason - never an unconfirmed list.
void AppShellTest::goesBackToLoginWhenTheIdentityCheckFails()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    QVERIFY(rig.model);
    ui::MainWindow *window = rig.app->appWindow();

    rig.model->sessionWire = loginwire::wireAnswer(QStringLiteral("session"), 401,
                                                   QByteArrayLiteral(R"json({"ok":false,"reason":"unauthenticated"})json"));
    rig.submitLogin(loginwire::kUser, loginwire::kPassword);
    QVERIFY(window->loginPageShown());
    QVERIFY(!window->listPageShown());
    QCOMPARE(rig.loginScreen()->errorText(), ui::sessionEndedMessage());
    QCOMPARE(window->statusText(), window->idleStatusText());
    QCOMPARE(lastEvent(rig.events(), QStringLiteral("session")).value(QStringLiteral("status")).toInt(), 401);

    rig.model->sessionWire = loginwire::noAnswer(net::Outcome::NetworkError);
    rig.submitLogin(loginwire::kUser, loginwire::kPassword);
    QVERIFY(window->loginPageShown());
    QCOMPARE(rig.loginScreen()->errorText(), ui::loginFailureMessage(ui::LoginFailure::Unreachable));
}

// step9's onSessionEnd, now on the list's own stream (step11): the stream that ends the session says
// onStatus(false) first - the live indicator drops while the list is still on screen - then the session
// end takes the window back to the login page. The shell's sessionEndHandler() does the same for any
// other stream, and a handler kept past the shell's life does nothing.
void AppShellTest::goesBackToLoginWhenTheStreamEndsTheSession()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    QVERIFY(rig.model);
    rig.submitLogin(loginwire::kUser, loginwire::kPassword);
    ui::MainWindow *window = rig.app->appWindow();
    QVERIFY(window->listPageShown());
    QVERIFY(window->liveStatusVisible());

    QStringList order;
    connect(rig.app->listController(), &ui::ListController::liveChanged, this, [&order, window](bool live) {
        if (!live)
            order << (window->listPageShown() ? QStringLiteral("status-false-on-list") : QStringLiteral("status-false-elsewhere"));
    });
    connect(rig.app->listController(), &ui::ListController::sessionEnded, this,
            [&order] { order << QStringLiteral("session-ended"); });

    rig.model->endStreamSession();

    QCOMPARE(order.mid(0, 2), (QStringList{QStringLiteral("status-false-on-list"), QStringLiteral("session-ended")}));
    QVERIFY(window->loginPageShown());
    QCOMPARE(rig.loginScreen()->errorText(), ui::sessionEndedMessage());
    QCOMPARE(window->statusText(), window->idleStatusText());
    QVERIFY(!window->liveStatusVisible());
    QVERIFY(!rig.app->listController()->isEntered());

    // The shell's own handler: back on the list, then called directly.
    rig.submitLogin(loginwire::kUser, loginwire::kPassword);
    QVERIFY(window->listPageShown());
    const net::SessionEndHandler toLogin = rig.app->sessionEndHandler();
    QVERIFY(toLogin);
    toLogin();
    QVERIFY(window->loginPageShown());
    QCOMPARE(rig.loginScreen()->errorText(), ui::sessionEndedMessage());
    QVERIFY(!rig.app->listController()->isEntered());

    rig.app.reset();
    toLogin();  // the shell is gone: nothing to do, nothing to crash on
}

// The hook's one action is the controller call. The fields stay empty (no widget was touched) and
// the app's own path does the rest: login{200}, session{200}, the list slot. A failing scenario stays
// on the login page exactly like the button does - it is the same path.
void AppShellTest::runsTheLoginScenarioThroughTheControllerNotTheWidgets()
{
    Rig rig(true);
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    QVERIFY(rig.model);

    QVERIFY(rig.app->runLoginScenario(loginwire::kUser, loginwire::kPassword));

    QVERIFY(rig.field("userIdEdit")->text().isEmpty());
    QVERIFY(rig.field("passwordEdit")->text().isEmpty());
    QVERIFY(rig.app->appWindow()->listPageShown());
    QCOMPARE(rig.model->loginCalls, 1);
    QCOMPARE(rig.eventNames(), (QStringList{QStringLiteral("app-ready"), QStringLiteral("config-loaded"),
                                            QStringLiteral("app-window"), QStringLiteral("login"),
                                            QStringLiteral("session"), QStringLiteral("list-loaded")}));

    Rig wrong(true);
    QVERIFY(wrong.writeConfig(configJson(kOrigin)));
    wrong.app->start();
    QVERIFY(wrong.model);
    QVERIFY(wrong.app->runLoginScenario(loginwire::kUser, QStringLiteral("not-the-password")));
    QVERIFY(wrong.app->appWindow()->loginPageShown());
    QCOMPARE(wrong.loginScreen()->errorText(), ui::loginFailureMessage(ui::LoginFailure::InvalidCredentials));
    QCOMPARE(wrong.model->sessionCalls, 0);
}

// No app window (no server configured) or no Model: nothing to call - the hook reports it (main.cpp
// exits non-zero) instead of pretending it ran.
void AppShellTest::cannotRunTheLoginScenarioWithoutAnAppWindow()
{
    Rig rig(true);
    rig.app->start();
    QVERIFY(rig.app->setupScreen());
    QVERIFY(!rig.app->runLoginScenario(loginwire::kUser, loginwire::kPassword));
    QCOMPARE(rig.modelsMade, 0);
    QVERIFY(!rig.eventNames().contains(QStringLiteral("login")));

    Rig noModel(true, true, Runner::StandIn, ModelWiring::None);
    QVERIFY(noModel.writeConfig(configJson(kOrigin)));
    noModel.app->start();
    QVERIFY(noModel.app->appWindow());
    QVERIFY(!noModel.app->loginController());
    QVERIFY(!noModel.app->runLoginScenario(loginwire::kUser, loginwire::kPassword));
}

// ---------------------------------------------------------------------------
// List (step11).
namespace {

QJsonObject listRow(const QString &id, const QString &status, const QString &createdAt)
{
    return QJsonObject{{QStringLiteral("articleId"), id},
                       {QStringLiteral("status"), status},
                       {QStringLiteral("title"), QStringLiteral("제목 ") + id},
                       {QStringLiteral("createdAt"), createdAt},
                       {QStringLiteral("lockYN"), QStringLiteral("N")}};
}

int countOf(const QStringList &names, const QString &name)
{
    return static_cast<int>(names.count(name));
}

} // namespace

// After login the list slot holds the list screen: the deskUnsent rows only, newest first, the live
// indicator on. A change re-queries AND re-renders the screen - the driver's diag cannot see pixels
// (M11-2: a re-query that never reaches the screen stays green there), so the screen's half is locked
// here. Paging goes from the screen's buttons to the controller, and is not a query.
void AppShellTest::showsTheListAndRefreshesTheScreenOnAChange()
{
    Rig rig(true);
    rig.seed.articles = {listRow(QStringLiteral("A1"), QStringLiteral("RDS"), QStringLiteral("2026-09-12T01:00:00.000Z")),
                         listRow(QStringLiteral("A2"), QStringLiteral("DDH"), QStringLiteral("2026-09-12T02:00:00.000Z")),
                         listRow(QStringLiteral("A3"), QStringLiteral("DPS"), QStringLiteral("2026-09-12T03:00:00.000Z"))};
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    rig.submitLogin(loginwire::kUser, loginwire::kPassword);

    ui::MainWindow *window = rig.app->appWindow();
    ui::ListScreen *screen = window->listScreen();
    QVERIFY(window->listPageShown());
    QCOMPARE(screen->rowCount(), 2);
    QCOMPARE(screen->cellText(0, 0), QStringLiteral("A2"));  // newest first
    QVERIFY(window->liveStatusVisible());
    QVERIFY2(window->liveStatusText().contains(QStringLiteral("실시간")), qPrintable(window->liveStatusText()));
    QCOMPARE(lastEvent(rig.events(), QStringLiteral("list-loaded")).value(QStringLiteral("count")).toInt(), 2);

    // Through the interface: the interface holds the default arguments (step8 - an override hides them).
    net::INewsModel &model = *rig.model;
    const QString created = model
                                .saveArticle(QJsonObject{{QStringLiteral("title"), QStringLiteral("새 기사")},
                                                         {QStringLiteral("createdAt"), QStringLiteral("2026-09-12T09:00:00.000Z")}})
                                .body.value(QStringLiteral("articleId"))
                                .toString();
    QVERIFY(!created.isEmpty());

    QCOMPARE(screen->rowCount(), 3);
    QCOMPARE(screen->cellText(0, 0), created);
    QCOMPARE(lastEvent(rig.events(), QStringLiteral("list-loaded")).value(QStringLiteral("count")).toInt(), 3);
    QCOMPARE(countOf(rig.eventNames(), QStringLiteral("list-loaded")), 2);

    Rig paged(true);
    for (int i = 0; i < 12; ++i)
        paged.seed.articles << listRow(QStringLiteral("P%1").arg(i, 2, 10, QLatin1Char('0')), QStringLiteral("RDS"),
                                       QStringLiteral("2026-09-12T00:%1:00.000Z").arg(i, 2, 10, QLatin1Char('0')));
    QVERIFY(paged.writeConfig(configJson(kOrigin)));
    paged.app->start();
    paged.submitLogin(loginwire::kUser, loginwire::kPassword);
    ui::ListScreen *pagedScreen = paged.app->appWindow()->listScreen();
    QCOMPARE(pagedScreen->rowCount(), 10);
    QPushButton *next = pagedScreen->findChild<QPushButton *>(QStringLiteral("nextPageButton"));
    QVERIFY(next);
    next->click();
    QCOMPARE(pagedScreen->rowCount(), 2);
    QVERIFY2(pagedScreen->pageText().contains(QStringLiteral("2 / 2")), qPrintable(pagedScreen->pageText()));
    QCOMPARE(countOf(paged.eventNames(), QStringLiteral("list-loaded")), 1);  // paging is not a query
}

// A page switch that bypasses the login - M10-2b's shape - still goes through the list's entry: the
// identity check runs, the server has no session, the window is back on the login page. The list page
// is never on screen with a list that was not entered.
void AppShellTest::neverShowsTheListPageWithoutEnteringTheList()
{
    Rig rig(true);
    rig.seed.articles = {listRow(QStringLiteral("A1"), QStringLiteral("RDS"), QStringLiteral("2026-09-12T01:00:00.000Z"))};
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    ui::MainWindow *window = rig.app->appWindow();

    window->showListPage();  // no login happened

    QVERIFY(window->loginPageShown());
    QCOMPARE(rig.model->sessionCalls, 1);
    QCOMPARE(rig.loginScreen()->errorText(), ui::sessionEndedMessage());
    QVERIFY(!rig.eventNames().contains(QStringLiteral("list-loaded")));
    QCOMPARE(window->listScreen()->rowCount(), 0);
    QVERIFY(!rig.app->listController()->isEntered());
    QCOMPARE(window->statusText(), window->idleStatusText());
}

// Back to the login page: the list is left - stream closed, rows gone from the screen, the live
// indicator hidden - and a later change reaches nothing.
void AppShellTest::leavesTheListWhenGoingBackToLogin()
{
    Rig rig(true);
    rig.seed.articles = {listRow(QStringLiteral("A1"), QStringLiteral("RDS"), QStringLiteral("2026-09-12T01:00:00.000Z"))};
    QVERIFY(rig.writeConfig(configJson(kOrigin)));
    rig.app->start();
    rig.submitLogin(loginwire::kUser, loginwire::kPassword);
    ui::MainWindow *window = rig.app->appWindow();
    QCOMPARE(window->listScreen()->rowCount(), 1);

    rig.app->returnToLogin(ui::sessionEndedMessage());

    QVERIFY(window->loginPageShown());
    QVERIFY(!rig.app->listController()->isEntered());
    QCOMPARE(window->listScreen()->rowCount(), 0);
    QVERIFY(!window->liveStatusVisible());
    const int loaded = countOf(rig.eventNames(), QStringLiteral("list-loaded"));
    static_cast<net::INewsModel &>(*rig.model).saveArticle(QJsonObject{{QStringLiteral("title"), QStringLiteral("늦은 기사")}});
    QCOMPARE(countOf(rig.eventNames(), QStringLiteral("list-loaded")), loaded);
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

    // step10: an app window that got no Model has no login controller - a composition root that
    // forgot the factory is caught by --selftest, not by the first user.
    Rig noModel(true, true, Runner::StandIn, ModelWiring::None);
    QVERIFY(noModel.writeConfig(configJson(kOrigin)));
    noModel.app->start();
    QVERIFY(noModel.app->selfTestFailures().join(QLatin1Char(' ')).contains(QStringLiteral("login controller")));
}
