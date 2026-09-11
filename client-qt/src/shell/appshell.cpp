#include "shell/appshell.h"

#include "shell/configstore.h"
#include "shell/diag.h"
#include "shell/proberunner.h"
#include "shell/serverurl.h"
#include "shell/singleinstance.h"
#include "shell/windowpolicy.h"
#include "ui/mainwindow.h"
#include "ui/setupscreen.h"

#include <QDir>
#include <QVariantMap>
#include <QWidget>

#include <QtDebug>

#include <utility>

namespace shell {
namespace {

// X5 at compile time: the stored-rectangle lower bound stays below the window minimum.
static_assert(kMinStoredWidth < kAppWindowMinWidth && kMinStoredHeight < kAppWindowMinHeight,
              "two minimum sizes for two jobs - never merge them (port spec X5)");

QString describeAddressProblem(const QString &reason)
{
    QString text;
    if (reason == QLatin1String("empty"))
        text = QStringLiteral("서버 주소를 입력해 주세요.");
    else if (reason == QLatin1String("unsupported-scheme"))
        text = QStringLiteral("http 또는 https 주소만 쓸 수 있습니다.");
    else if (reason == QLatin1String("credentials"))
        text = QStringLiteral("주소에 사용자 이름·비밀번호를 넣을 수 없습니다.");
    else if (reason == QLatin1String("no-host"))
        text = QStringLiteral("호스트가 없는 주소입니다.");
    else
        text = QStringLiteral("주소 형식이 올바르지 않습니다.");
    return text + QStringLiteral(" (") + reason + QLatin1Char(')');
}

QString describeProbe(const ProbeOutcome &outcome)
{
    if (outcome.ok)
        return QStringLiteral("연결 확인: 기사 서버입니다 — ") + outcome.origin;
    QString text;
    if (outcome.reason == QLatin1String("http-status"))
        text = QStringLiteral("연결 확인 실패: 서버가 오류 상태를 돌려주었습니다.");
    else if (outcome.reason == QLatin1String("not-article-server"))
        text = QStringLiteral("연결 확인 실패: 기사 서버가 아닙니다.");
    else
        text = QStringLiteral("연결 확인 실패: 서버에 닿지 못했습니다.");
    return text + QStringLiteral(" (") + outcome.reason + QLatin1Char(')');
}

} // namespace

BootScreen decideBootScreen(const ClientConfig &config)
{
    // parseConfig already re-validated the stored address (clientConfig R4): anything that
    // survived it is an origin, anything that did not is "no config".
    return config.serverUrl.isEmpty() ? BootScreen::Setup : BootScreen::App;
}

QStringList shellDiagEvents()
{
    return {QStringLiteral("app-ready"),       QStringLiteral("config-loaded"),
            QStringLiteral("config-saved"),    QStringLiteral("probe"),
            QStringLiteral("second-instance"), QStringLiteral("local-window"),
            QStringLiteral("setup-shown"),     QStringLiteral("app-window")};
}

AppShell::AppShell(const QString &userDataDir, InstanceGuard &guard, Diag &diag, ConfigFileSystem &fs,
                   ProbeRunner &probeRunner, Options options, QObject *parent)
    : QObject(parent), m_userDataDir(userDataDir), m_guard(guard), m_diag(diag), m_fs(fs),
      m_probeRunner(probeRunner), m_options(std::move(options))
{
    if (!m_options.workAreas)
        m_options.workAreas = &screenWorkAreas;  // the production source
}

AppShell::~AppShell() = default;

AppShell::StartResult AppShell::start()
{
    // R2: a later launch knocks on the running instance and does NOTHING else - no folder, no
    // config read, no diag line, no window (every diag call of the canonical lives inside
    // wireApp(), which a second instance never reaches).
    if (!m_guard.tryBecomePrimary()) {
        m_guard.notifyPrimary();
        return StartResult::Secondary;
    }
    connect(&m_guard, &InstanceGuard::activationRequested, this, &AppShell::onSecondInstance,
            Qt::UniqueConnection);
    m_started = true;

    // Chromium creates the Electron shell's userData folder at startup; this is that moment for
    // the Qt client. A harness puts the diag file inside it (verify-client.mjs:208-209).
    m_fs.makeDirectory(m_userDataDir);

    m_diag.log(QStringLiteral("app-ready"));
    const ClientConfig config = loadConfig(m_userDataDir, m_fs);  // one read per boot
    m_diag.log(QStringLiteral("config-loaded"),
               QVariantMap{{QStringLiteral("hasServerUrl"), !config.serverUrl.isEmpty()}});

    // A layout no monitor holds any more is dropped as a whole - size included
    // (clientConfig.js:82, all-or-nothing).
    m_savedBounds = sanitizeBounds(config.bounds, m_options.workAreas());
    m_bootScreen = decideBootScreen(config);
    if (m_bootScreen == BootScreen::App) {
        m_serverOrigin = config.serverUrl;
        createAppWindow();
    } else {
        showSetupScreen(QStringLiteral("no-config"));
    }
    return StartResult::Primary;
}

void AppShell::createAppWindow()
{
    // At most one app window. The canonical replaces a live one (create-then-close) for its
    // "reconnect" menu; step5 has no menu and no path back here while one exists.
    if (m_appWindow)
        return;

    m_appWindow = std::make_unique<ui::MainWindow>(m_serverOrigin);
    connect(m_appWindow.get(), &ui::MainWindow::closing, this, &AppShell::onAppWindowClosing);
    const WindowPlacement plan = planAppWindow(m_savedBounds);
    applyWindowPlacement(*m_appWindow, plan);
    if (!m_options.selftest) {
        // R8: created at its normal rectangle, maximized after creation.
        if (plan.startMaximized)
            m_appWindow->showMaximized();
        else
            m_appWindow->show();
        m_appWindowShown = true;  // R10: only a window that was on screen may save its bounds
    }
    // Only now, with the app window up: closing the last visible window ends the application.
    closeSetupScreen();
    m_diag.log(QStringLiteral("app-window"), QVariantMap{{QStringLiteral("origin"), m_serverOrigin}});
}

void AppShell::showSetupScreen(const QString &reason)
{
    // client/main.js:338-339 - local-window, then setup-shown.
    m_diag.log(QStringLiteral("local-window"), QVariantMap{{QStringLiteral("page"), QStringLiteral("setup")}});
    m_diag.log(QStringLiteral("setup-shown"), QVariantMap{{QStringLiteral("reason"), reason}});

    if (!m_setupScreen) {
        m_setupScreen = std::make_unique<ui::SetupScreen>(m_probeRunner.limitationNotice());
        m_setupScreen->resize(kSetupWindowWidth, kSetupWindowHeight);
        connect(m_setupScreen.get(), &ui::SetupScreen::saveRequested, this, &AppShell::requestSave);
        connect(m_setupScreen.get(), &ui::SetupScreen::probeRequested, this, &AppShell::requestProbe);
    }
    if (!m_options.selftest) {
        m_setupScreen->show();
        m_setupScreen->raise();
        m_setupScreen->activateWindow();
    }
}

void AppShell::closeSetupScreen()
{
    if (!m_setupScreen)
        return;
    ui::SetupScreen *screen = m_setupScreen.release();
    screen->close();
    // Later, not now: on the save path this runs inside the screen's own button signal.
    screen->deleteLater();
}

void AppShell::requestSave(const QString &input)
{
    const NormalizedUrl normalized = normalizeServerUrl(input);
    if (!normalized.ok) {
        if (m_setupScreen)
            m_setupScreen->showStatus(describeAddressProblem(normalized.reason), true);
        return;  // nothing saved, nothing logged (the canonical returns before any diag line)
    }
    // step5 saves what normalises (step5.md D). The canonical probes first and saves only the
    // final origin of a SUCCESSFUL probe (client/main.js:129-134); that order returns with the
    // real transport in step7 - client-qt/README.md.
    m_serverOrigin = normalized.origin;
    persistConfig();
    m_diag.log(QStringLiteral("config-saved"), QVariantMap{{QStringLiteral("origin"), normalized.origin}});
    createAppWindow();
}

void AppShell::requestProbe(const QString &input)
{
    const NormalizedUrl normalized = normalizeServerUrl(input);
    if (!normalized.ok) {
        if (m_setupScreen)
            m_setupScreen->showStatus(describeAddressProblem(normalized.reason), true);
        return;
    }
    ++m_probeCount;
    const ProbeOutcome outcome = probeOrigin(m_probeRunner, m_diag, normalized.origin);
    if (m_setupScreen)
        m_setupScreen->showStatus(describeProbe(outcome), !outcome.ok);
}

void AppShell::onSecondInstance()
{
    m_diag.log(QStringLiteral("second-instance"));

    // client/main.js:84 - the app window first, then the local one.
    QWidget *window = m_appWindow ? static_cast<QWidget *>(m_appWindow.get())
                                  : static_cast<QWidget *>(m_setupScreen.get());
    const Activation activation =
        planActivation(m_options.selftest, window != nullptr, window && window->isMinimized());
    if (activation == Activation::LogOnly)
        return;
    if (activation == Activation::RestoreThenShow) {
        // Electron's restore() returns to the state before minimizing. QWidget::showNormal()
        // would drop a maximized state as well, so only the minimized bit is cleared.
        window->setWindowState(window->windowState() & ~Qt::WindowMinimized);
    }
    window->show();
    window->raise();
    window->activateWindow();
}

void AppShell::onAppWindowClosing()
{
    // The one write of the window's life (R11 - no resize/move hook anywhere).
    if (!m_appWindow || !shouldSaveBoundsOnClose(m_appWindowShown))
        return;  // R10
    const Bounds captured = captureBoundsFrom(*m_appWindow);                       // R9
    m_savedBounds = boundsToSave(m_savedBounds, captured, m_options.workAreas());  // W-N2
    persistConfig();  // unconditional, like client/main.js:373 - and never blocks the close (R12)
}

void AppShell::persistConfig()
{
    ClientConfig config;
    config.serverUrl = m_serverOrigin;
    config.bounds = m_savedBounds;
    QString error;
    if (!saveConfigAtomically(m_userDataDir, config, &error, m_fs))
        qWarning("config: save failed, continuing - %s", qPrintable(error));  // main.js:382 swallows
}

QStringList AppShell::selfTestFailures() const
{
    QStringList failures;
    if (!m_started) {
        failures << QStringLiteral("start() did not run as the primary instance");
        return failures;
    }
    if (m_userDataDir.trimmed().isEmpty() || !QDir::isAbsolutePath(m_userDataDir))
        failures << QStringLiteral("the user data folder is not an absolute path");
    if (!m_guard.isPrimary())
        failures << QStringLiteral("the single instance lock is not held");
    if (m_guard.names() != instanceNamesFor(m_userDataDir))
        failures << QStringLiteral("the lock names are not derived from the user data folder (R1)");
    if (m_probeCount != 0)
        failures << QStringLiteral("a probe ran during boot - probes are user actions only");
    if (m_diag.rejectedEventCount() != 0)
        failures << QStringLiteral("diag refused an event name outside the allowed set");
    for (const QString &name : shellDiagEvents()) {
        if (!isAllowedDiagEvent(name))
            failures << QStringLiteral("shell event outside the step4 set: ") + name;
    }

    const bool haveApp = m_appWindow != nullptr;
    const bool haveSetup = m_setupScreen != nullptr;
    if (haveApp == haveSetup)
        failures << QStringLiteral("exactly one screen must exist after boot");
    else if ((m_bootScreen == BootScreen::App) != haveApp)
        failures << QStringLiteral("the screen does not match the boot decision");
    if (m_options.selftest
        && ((haveApp && m_appWindow->isVisible()) || (haveSetup && m_setupScreen->isVisible())))
        failures << QStringLiteral("a window is visible under selftest");
    return failures;
}

ui::MainWindow *AppShell::appWindow() const
{
    return m_appWindow.get();
}

ui::SetupScreen *AppShell::setupScreen() const
{
    return m_setupScreen.get();
}

QString AppShell::serverOrigin() const
{
    return m_serverOrigin;
}

Bounds AppShell::savedBounds() const
{
    return m_savedBounds;
}

bool AppShell::appWindowShown() const
{
    return m_appWindowShown;
}

int AppShell::probeCount() const
{
    return m_probeCount;
}

} // namespace shell
