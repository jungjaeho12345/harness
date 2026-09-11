// phase 77 (P4) step5 - the composition root of the Qt native client.
//
// Thin on purpose: it builds the dependencies, injects them into the shell and runs the event
// loop. Every decision - boot branch, single instance, window bounds, diag events, the login
// screen changes - lives in src/shell and src/ui, where the tests can drive it with fakes. Nothing
// below may reach for a global.
#include "net/httpnewsmodel.h"
#include "net/httpproberunner.h"
#include "net/httptransport.h"
#include "shell/appidentity.h"
#include "shell/appshell.h"
#include "shell/configstore.h"
#include "shell/diag.h"
#include "shell/scenario.h"
#include "shell/singleinstance.h"
#include "shell/windowpolicy.h"

#include <QApplication>
#include <QByteArray>
#include <QCoreApplication>
#include <QLatin1Char>
#include <QString>
#include <QStringList>
#include <QTimer>

#include <cstdio>
#include <cstring>
#include <memory>

namespace {

bool hasArg(int argc, char **argv, const char *name)
{
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], name) == 0)
            return true;
    }
    return false;
}

bool selftestEnvironment()
{
    const QByteArray name = shell::names::selftestEnvVar().toLatin1();
    return qEnvironmentVariable(name.constData()) == QLatin1String("1");  // exactly "1", main.js:28
}

// The Model of one app window (step10): HttpNewsModel over a transport of its own - its own cookie jar,
// i.e. its own session. HttpNewsModel does not own its transport; this does, and builds it first
// (base-from-member: the owner base is constructed before the model base receives its address, and
// destroyed after it).
struct TransportOwner {
    TransportOwner(const QString &origin, shell::Diag *diag) : transport(origin, diag) {}
    net::HttpTransport transport;
};

class WindowModel : private TransportOwner, public net::HttpNewsModel
{
public:
    WindowModel(const QString &origin, shell::Diag *diag) : TransportOwner(origin, diag), net::HttpNewsModel(&transport) {}
};

} // namespace

int main(int argc, char **argv)
{
    // (-1) The scenario hook's guard (step10 A), before ANYTHING else: a refused request touches no
    //      lock, no folder, no diag file, no window and no network, and the process exits non-zero.
    //      An accident guard, not a security boundary (shell/scenario.h).
    QStringList arguments;
    for (int i = 1; i < argc; ++i)
        arguments << QString::fromLocal8Bit(argv[i]);
    shell::ScenarioRequest scenario = shell::scenarioRequestFromEnvironment(arguments);
    if (scenario.refused) {
        std::fprintf(stderr, "news-client: %s\n", qPrintable(scenario.refusal));
        std::fflush(stderr);
        return shell::kScenarioRefusedExitCode;
    }

    // --selftest: boot exactly like CLIENT_SELFTEST=1 (windows created, nothing shown, every diag
    // event written), check the shell's invariants, exit - never entering the event loop. The
    // offscreen platform keeps it deterministic without a desktop session.
    const bool selftestArg = hasArg(argc, argv, "--selftest");
    if (selftestArg && !qEnvironmentVariableIsSet("QT_QPA_PLATFORM"))
        qputenv("QT_QPA_PLATFORM", "offscreen");

    QApplication app(argc, argv);

    // (0) R1: the user data folder FIRST - the lock names are derived from it, so a harness run on
    //     a temporary CLIENT_USER_DATA never contends with the real user's client (W-N3: the env
    //     variable decides only when it is set).
    const QString userDataDir = shell::configDirPath();

    // (1) The guard lives here, in main(), for the whole process: a lock held by an object that
    //     can be dropped early is released early.
    shell::SingleInstanceGuard guard(shell::instanceNamesFor(userDataDir));
    shell::Diag diag(shell::diagFilePathFromEnvironment());
    // The real probe (step7): GET <origin>/api/health through the net transport, on user actions
    // only - [연결 확인] and [저장] (which probes first and saves only a success). Nothing on the
    // boot path calls it, and it builds no network object until it runs.
    net::HttpProbeRunner probeRunner(&diag);

    shell::AppShell::Options options;
    options.selftest = selftestArg || selftestEnvironment();
    options.workAreas = &shell::screenWorkAreas;
    // step10: each app window talks through its own HttpNewsModel. Building it sends nothing - the
    // window opens logged out (no cookie is ever read from disk: decisions (6)).
    options.modelFactory = [&diag](const QString &origin) -> std::unique_ptr<net::INewsModel> {
        return std::make_unique<WindowModel>(origin, &diag);
    };

    shell::AppShell appShell(userDataDir, guard, diag, shell::realFileSystem(), probeRunner, options);
    if (appShell.start() == shell::AppShell::StartResult::Secondary) {
        if (selftestArg) {
            // A self-test that did not run must not report success.
            std::fprintf(stderr,
                         "news-client selftest FAIL: another instance holds the lock of this user "
                         "data folder\n");
            return 1;
        }
        return 0;  // R2: the running instance comes forward; this process leaves without a window
    }

    if (selftestArg) {
        const QStringList failures = appShell.selfTestFailures();
        for (const QString &failure : failures)
            std::fprintf(stderr, "news-client selftest FAIL: %s\n", qPrintable(failure));
        if (!failures.isEmpty())
            return 1;
        std::printf("news-client selftest ok\n");
        std::fflush(stdout);
        return 0;
    }

    if (scenario.scenario == shell::Scenario::Login) {
        // The hook, once the event loop runs: ONE call of the login controller (never a widget), over
        // the real HTTP transport. What follows is the app's normal path. The credentials are dropped
        // from this process's copy right after the call (best effort - the environment still holds
        // them for the life of the process; the harness owns that).
        QTimer::singleShot(0, &appShell, [&appShell, &scenario] {
            const bool ran = appShell.runLoginScenario(scenario.userId, scenario.password);
            scenario.password.fill(QLatin1Char('\0'));
            scenario.password.clear();
            if (!ran) {
                std::fprintf(stderr, "news-client: scenario login could not run - no app window "
                                     "(no server address is configured)\n");
                std::fflush(stderr);
                QCoreApplication::exit(3);
            }
        });
    }

    return app.exec();
}
