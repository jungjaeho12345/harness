#ifndef CLIENT_QT_SHELL_APPSHELL_H
#define CLIENT_QT_SHELL_APPSHELL_H

// The app shell (phase 77 step5) - the Qt counterpart of the wiring in client/main.js. It owns the
// four things the shell is responsible for: single instance, config load -> app window or setup
// screen, app window bounds, and the diag events of that boot.
//
// Everything it needs is INJECTED (ADR-003 spirit): the instance guard, the diag sink, the config
// filesystem, the probe runner and the work-area source. The screens receive data and emit
// signals; they pull nothing from globals. That is what lets the boot branches, the
// second-instance handler and the close-time save be driven by tests with fakes - the canonical
// could not test any of them (they needed a live BrowserWindow).
//
// Boot order (client/main.js:55-63, 152-181):
//   (0) the user data folder is resolved by the caller BEFORE the guard exists (R1 - the lock
//       names are derived from it)
//   (1) the guard: secondary -> knock on the primary, return. NOTHING else runs (R2): no folder,
//       no config read, no diag line, no window.
//   (2) app-ready -> read config -> config-loaded{hasServerUrl}
//   (3) serverUrl ? app-window : local-window{page:setup} + setup-shown{reason:no-config}
// No probe on this path - probes are user actions only.
//
// Login (step10) and the list (step11). An app window gets ONE Model (Options::modelFactory, called with
// the origin the window serves - main.cpp builds an HttpNewsModel over its own transport = its own
// cookie jar), and a ui::LoginController and a ui::ListController over it. The window opens on the login
// page; the screen changes are:
//   loginSucceeded  -> the list's entry: GET /api/session (decisions (7) 2) -> ok: the query and the
//                      stream, THEN the list page + the display label / not ok: back to the login page
//   loginFailed     -> stay on the login page with the message (never past it)
//   the list page becomes current by any other way -> the same entry (the web's ListPage mount): the list
//                      page is never on screen with a list that was not entered
//   the session ends (a 401 on the check or a query, the stream's unauthorized frame) -> the list is
//                      left (stream closed, rows gone) and the window is back on the login page
// The scenario hook (shell/scenario.h) only calls the controller's login(); everything above follows
// from that one call exactly as it does from the button.

#include "net/newsmodel.h"
#include "shell/clientconfig.h"

#include <QList>
#include <QObject>
#include <QRect>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>

namespace ui {
class ListController;
class LoginController;
class MainWindow;
class SetupScreen;
} // namespace ui

namespace shell {

class ConfigFileSystem;
class Diag;
class InstanceGuard;
class ProbeRunner;

enum class BootScreen { App, Setup };

// Pure boot branch: a stored (and re-validated) server origin opens the app window, anything
// else the setup screen.
BootScreen decideBootScreen(const ClientConfig &config);

// Every event name this shell can emit. Each one has to be inside allowedDiagEvents() (the
// step4 gate) - the test and --selftest both check it.
QStringList shellDiagEvents();

class AppShell : public QObject
{
    Q_OBJECT

public:
    enum class StartResult { Primary, Secondary };

    struct Options {
        // CLIENT_SELFTEST=1 (or --selftest): windows are created and every event is written,
        // but nothing is ever shown.
        bool selftest = false;
        // Work areas of the monitors right now. Called at boot (restore) and at close (save).
        std::function<QList<QRect>()> workAreas;
        // The Model of an app window (step10), made once per window with the origin it serves. An
        // app window without one has no login controller - --selftest reports that as a failure.
        std::function<std::unique_ptr<net::INewsModel>(const QString &origin)> modelFactory;
    };

    AppShell(const QString &userDataDir, InstanceGuard &guard, Diag &diag, ConfigFileSystem &fs,
             ProbeRunner &probeRunner, Options options, QObject *parent = nullptr);
    ~AppShell() override;

    StartResult start();

    // The invariants --selftest checks after a boot. Empty = healthy.
    QStringList selfTestFailures() const;

    // Observation points for tests and --selftest.
    ui::MainWindow *appWindow() const;
    ui::SetupScreen *setupScreen() const;
    QString serverOrigin() const;
    Bounds savedBounds() const;
    bool appWindowShown() const;
    int probeCount() const;
    ui::LoginController *loginController() const;
    ui::ListController *listController() const;

    // The scenario hook's one action (step10 A): call the login controller - never a widget. false
    // (and nothing called) when there is no app window to log in from (no server configured).
    bool runLoginScenario(const QString &userId, const QString &password);

    // What a change stream is handed as onSessionEnd (step9 - net::INewsModel::subscribe): the
    // stream already reported onStatus(false); this takes the window back to the login page. Safe to
    // call after the shell is gone (it then does nothing).
    net::SessionEndHandler sessionEndHandler();

public slots:
    // The setup screen's two buttons.
    void requestSave(const QString &input);
    void requestProbe(const QString &input);
    // Back to the login page with a sentence (the session is over, or it could not be confirmed).
    void returnToLogin(const QString &message);

private slots:
    void onSecondInstance();
    void onAppWindowClosing();
    void onLoginRequested(const QString &userId, const QString &password);
    void onLoginSucceeded();
    void onLoginFailed(const QString &message);
    void onListPageEntered();
    void onListPageLeft();

private:
    // The list's one door (step11): the list controller enters (identity check -> query -> stream), and
    // only a confirmed entry puts the list page on screen.
    void enterList();
    void createAppWindow();
    void showSetupScreen(const QString &reason);
    void closeSetupScreen();
    void persistConfig();

    QString m_userDataDir;
    InstanceGuard &m_guard;
    Diag &m_diag;
    ConfigFileSystem &m_fs;
    ProbeRunner &m_probeRunner;
    Options m_options;

    bool m_started = false;
    BootScreen m_bootScreen = BootScreen::Setup;
    QString m_serverOrigin;
    Bounds m_savedBounds;
    bool m_appWindowShown = false;
    int m_probeCount = 0;
    // Declared before the windows: destroyed after them (a window's widgets never outlive the
    // controller they signal), and the controller before the Model it holds a reference to.
    std::unique_ptr<net::INewsModel> m_model;
    std::unique_ptr<ui::LoginController> m_login;
    std::unique_ptr<ui::ListController> m_list;
    std::unique_ptr<ui::MainWindow> m_appWindow;
    std::unique_ptr<ui::SetupScreen> m_setupScreen;
};

} // namespace shell

#endif // CLIENT_QT_SHELL_APPSHELL_H
