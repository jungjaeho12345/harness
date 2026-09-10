// phase 77 (P4) step0 - skeleton entry point of the Qt native client.
//
// Deliberately empty: the shell contract (server probe / config / diag / single instance /
// window bounds) lands in step2..step5, the net layer in step7..step9 and the login+list
// screens in step10..step11. Writing any of that here would make those steps unable to
// show their own red.
#include <QApplication>
#include <QLabel>
#include <QString>
#include <QWidget>

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

} // namespace

int main(int argc, char **argv)
{
    // --selftest must stay deterministic when a runner starts it without a desktop
    // session, so force the offscreen platform unless the caller picked one.
    const bool selftest = hasArg(argc, argv, "--selftest");
    if (selftest && !qEnvironmentVariableIsSet("QT_QPA_PLATFORM"))
        qputenv("QT_QPA_PLATFORM", "offscreen");

    QApplication app(argc, argv);

    if (selftest) {
        // Liveness only: proves the Qt runtime resolved (i.e. the Qt DLLs were found on
        // PATH - see run.bat) and that QApplication can be constructed. No window.
        std::printf("news-client selftest ok\n");
        std::fflush(stdout);
        return 0;
    }

    QWidget window;
    window.setWindowTitle(QStringLiteral("news-client"));
    window.resize(960, 640);
    QLabel placeholder(QStringLiteral("P4 skeleton - screens land in step10/step11."),
                       &window);
    placeholder.move(24, 24);
    window.show();
    return app.exec();
}
