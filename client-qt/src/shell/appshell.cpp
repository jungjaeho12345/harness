#include "shell/appshell.h"

#include "shell/configstore.h"
#include "shell/diag.h"
#include "shell/proberunner.h"
#include "shell/serverurl.h"
#include "shell/singleinstance.h"
#include "shell/windowpolicy.h"
#include "ui/listcontroller.h"
#include "ui/listscreen.h"
#include "ui/logincontroller.h"
#include "ui/loginscreen.h"
#include "ui/mainwindow.h"
#include "ui/setupscreen.h"

#include <QDir>
#include <QPointer>
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

    // step10: the window's Model - one per window, for the origin it serves (on the setup path that is
    // the origin the probe ENDED at) - and the login controller over it. Nothing is asked of the
    // server here: the window opens on its login page, logged out.
    if (m_options.modelFactory)
        m_model = m_options.modelFactory(m_serverOrigin);
    if (m_model) {
        m_login = std::make_unique<ui::LoginController>(*m_model, &m_diag);
        connect(m_appWindow->loginScreen(), &ui::LoginScreen::loginRequested, this, &AppShell::onLoginRequested);
        connect(m_login.get(), &ui::LoginController::loginSucceeded, this, &AppShell::onLoginSucceeded);
        connect(m_login.get(), &ui::LoginController::loginFailed, this, &AppShell::onLoginFailed);

        // step11: the list screen shows what the list controller holds (it pulls nothing itself); the
        // pager asks the controller; the stream's state drives the top bar's live indicator; a session
        // the list learns is over sends the window back to login. The list page's own entry/exit is
        // the list controller's enter()/leave().
        m_list = std::make_unique<ui::ListController>(*m_model, &m_diag);
        ui::ListController *list = m_list.get();
        ui::ListScreen *screen = m_appWindow->listScreen();
        connect(list, &ui::ListController::listChanged, screen, [screen, list] { screen->render(list->viewState()); });
        connect(list, &ui::ListController::liveChanged, m_appWindow.get(), &ui::MainWindow::setLiveStatus);
        connect(list, &ui::ListController::sessionEnded, this, &AppShell::returnToLogin);
        connect(screen, &ui::ListScreen::previousPageRequested, list, &ui::ListController::previousPage);
        connect(screen, &ui::ListScreen::nextPageRequested, list, &ui::ListController::nextPage);
        connect(m_appWindow.get(), &ui::MainWindow::listPageEntered, this, &AppShell::onListPageEntered);
        connect(m_appWindow.get(), &ui::MainWindow::listPageLeft, this, &AppShell::onListPageLeft);
    }

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
    // client/main.js:130-141 (restored in step7): normalise -> probe -> a failed probe saves
    // NOTHING, not even the typed address (an unreachable address would send the next boot
    // straight to a dead app window) -> a successful one saves the origin the probe ENDED at
    // (promoted on success only - R26), and config-saved / the app window carry that same value.
    ++m_probeCount;
    const ProbeOutcome outcome = probeOrigin(m_probeRunner, m_diag, normalized.origin);
    if (!outcome.ok) {
        if (m_setupScreen)
            m_setupScreen->showStatus(describeProbe(outcome), true);
        return;
    }
    m_serverOrigin = outcome.origin;
    persistConfig();
    m_diag.log(QStringLiteral("config-saved"), QVariantMap{{QStringLiteral("origin"), outcome.origin}});
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
    for (const QString &name : shellDiagEvents() + ui::loginControllerDiagEvents() + ui::listControllerDiagEvents()) {
        if (!isAllowedDiagEvent(name))
            failures << QStringLiteral("shell event outside the step4 set: ") + name;
    }

    const bool haveApp = m_appWindow != nullptr;
    const bool haveSetup = m_setupScreen != nullptr;
    if (haveApp == haveSetup)
        failures << QStringLiteral("exactly one screen must exist after boot");
    else if ((m_bootScreen == BootScreen::App) != haveApp)
        failures << QStringLiteral("the screen does not match the boot decision");
    if (haveApp && !m_login)
        failures << QStringLiteral("the app window has no login controller (no Model was injected)");
    if (haveApp && !m_list)
        failures << QStringLiteral("the app window has no list controller (no Model was injected)");
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

ui::LoginController *AppShell::loginController() const
{
    return m_login.get();
}

ui::ListController *AppShell::listController() const
{
    return m_list.get();
}

// ---------------------------------------------------------------------------------------------
// Login (step10).

bool AppShell::runLoginScenario(const QString &userId, const QString &password)
{
    // The hook's whole job: one controller call. What follows - the screen change, the identity
    // check - is the app's own path, reached through the controller's signals exactly as from the
    // button. No widget is touched (step10 A).
    if (!m_login)
        return false;
    m_login->login(userId, password);
    return true;
}

void AppShell::onLoginRequested(const QString &userId, const QString &password)
{
    if (m_login)
        m_login->login(userId, password);
}

void AppShell::onLoginSucceeded()
{
    enterList();
}

void AppShell::enterList()
{
    // decisions (7) 2: entering the post-login screen asks the server who we are - the login answer's
    // user is never kept. The list controller's entry is that question, then the query, then the stream
    // (step11). Nothing past the login page is shown before the answer (fail-closed): a session the
    // server does not confirm - or cannot be asked about - sends the window back.
    const ui::ListEntry entry = m_list->enter();
    if (!entry.ok) {
        returnToLogin(entry.message);
        return;
    }
    m_appWindow->setStatusText(entry.identityLabel);  // display only - never a permission
    m_appWindow->loginScreen()->clearError();
    m_appWindow->showListPage();
}

void AppShell::onListPageEntered()
{
    // However the list page became current, it is never on screen with a list that did not enter: a
    // switch that bypassed the door above (a failed login's, M10-2b's shape) meets the same identity
    // check here - and goes back to the login page when the server has no session for it.
    if (m_list && !m_list->isEntered())
        enterList();
}

void AppShell::onListPageLeft()
{
    if (m_list)
        m_list->leave();  // the stream closes and no row stays behind
}

void AppShell::onLoginFailed(const QString &message)
{
    // Never past the login page on a failure: the sentence is shown and nothing else happens (no
    // identity check, no list).
    m_appWindow->loginScreen()->showError(message);
}

void AppShell::returnToLogin(const QString &message)
{
    if (!m_appWindow)
        return;
    if (m_list)
        m_list->leave();  // whatever brought us here, the list's stream and rows go with the session
    m_appWindow->setStatusText(m_appWindow->idleStatusText());
    m_appWindow->showLoginPage();
    m_appWindow->loginScreen()->showError(message);
}

net::SessionEndHandler AppShell::sessionEndHandler()
{
    // step9: the stream already reported onStatus(false) and stopped for good. A handle kept past the
    // shell's life must not reach a dead object, hence the guarded pointer.
    const QPointer<AppShell> self(this);
    return [self] {
        if (self)
            self->returnToLogin(ui::sessionEndedMessage());
    };
}

} // namespace shell
