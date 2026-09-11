// phase 77 (P4) step5 - the composition root of the Qt native client.
//
// Thin on purpose: it builds the dependencies, injects them into the shell and runs the event
// loop. Every decision - boot branch, single instance, window bounds, diag events - lives in
// src/shell, where the tests can drive it with fakes. Nothing below may reach for a global.
#include "net/httpproberunner.h"
#include "shell/appidentity.h"
#include "shell/appshell.h"
#include "shell/configstore.h"
#include "shell/diag.h"
#include "shell/singleinstance.h"
#include "shell/windowpolicy.h"

#include <QApplication>
#include <QByteArray>
#include <QString>
#include <QStringList>

#include <cstdio>
#include <cstring>

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

} // namespace

int main(int argc, char **argv)
{
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

    return app.exec();
}
