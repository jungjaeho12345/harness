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

#include "shell/clientconfig.h"

#include <QList>
#include <QObject>
#include <QRect>
#include <QString>
#include <QStringList>

#include <functional>
#include <memory>

namespace ui {
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

public slots:
    // The setup screen's two buttons.
    void requestSave(const QString &input);
    void requestProbe(const QString &input);

private slots:
    void onSecondInstance();
    void onAppWindowClosing();

private:
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
    std::unique_ptr<ui::MainWindow> m_appWindow;
    std::unique_ptr<ui::SetupScreen> m_setupScreen;
};

} // namespace shell

#endif // CLIENT_QT_SHELL_APPSHELL_H
