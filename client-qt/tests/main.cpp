// phase 77 (P4) step0 - console test runner for client-qt.
//
// Runs every registered QtTest class in sequence, sums the failures and prints one totals
// line that build.bat greps. Two rules this runner exists to enforce:
//   1. Reporting a green while executing zero test functions is a hard error (exit 2).
//   2. A failure has to say which test failed. Measured on this machine (Qt 6.8.3 / MSVC,
//      2026-09-10): QtTest's own plain logger writes nothing to a *redirected* stdout -
//      neither by default nor with "-o -,txt" - while plain printf from this file lands
//      normally. build.bat redirects, so each class logs to a temp file that we echo
//      ourselves; otherwise the log would show a failure count and no diagnosis.
#include "smoketest.h"

#include <QApplication>
#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QMetaMethod>
#include <QMetaObject>
#include <QObject>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QtTest>

#include <cstdio>

namespace {

// How many QtTest test functions a class declares: private slots with no parameters,
// excluding QtTest's fixture hooks and the _data providers.
int countTestFunctions(const QObject *object)
{
    const QMetaObject *mo = object->metaObject();
    int count = 0;
    for (int i = mo->methodOffset(); i < mo->methodCount(); ++i) {
        const QMetaMethod method = mo->method(i);
        if (method.methodType() != QMetaMethod::Slot)
            continue;
        if (method.access() != QMetaMethod::Private)
            continue;
        if (method.parameterCount() != 0)
            continue;
        const QByteArray name = method.name();
        if (name == "initTestCase" || name == "initTestCase_data" || name == "cleanupTestCase"
            || name == "init" || name == "cleanup")
            continue;
        if (name.endsWith("_data"))
            continue;
        ++count;
    }
    return count;
}

void echoFile(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        std::fprintf(stderr, "WARN: per-class test log is missing: %s\n", qPrintable(path));
        std::fflush(stderr);
        return;
    }
    const QByteArray text = file.readAll();
    std::fwrite(text.constData(), 1, static_cast<size_t>(text.size()), stdout);
    std::fflush(stdout);
}

struct RunTotals {
    int classes = 0;
    int tests = 0;
    int failed = 0;
};

// Runs one QtTest class and folds its result into the totals. step2+ adds one call per
// new test class in main() below.
template <typename TestClass>
void runTestClass(const QStringList &baseArgs, const QString &logDirPath, RunTotals &totals)
{
    TestClass testCase;
    const QString className = QString::fromLatin1(testCase.metaObject()->className());
    const QString logPath = QDir(logDirPath).filePath(className + QStringLiteral(".txt"));

    QStringList args = baseArgs;
    args << QStringLiteral("-o") << (logPath + QStringLiteral(",txt"));

    totals.tests += countTestFunctions(&testCase);
    ++totals.classes;
    totals.failed += QTest::qExec(&testCase, args);
    echoFile(logPath);
}

} // namespace

int main(int argc, char **argv)
{
    // Deterministic without a desktop session; widgets tests still need QApplication.
    if (!qEnvironmentVariableIsSet("QT_QPA_PLATFORM"))
        qputenv("QT_QPA_PLATFORM", "offscreen");
    QApplication app(argc, argv);

    // Per-class logs live in the OS temp directory, never inside the repository.
    QTemporaryDir logDir;
    if (!logDir.isValid()) {
        std::fprintf(stderr, "FATAL: could not create a temp directory for test logs\n");
        return 2;
    }

    const QStringList baseArgs = QCoreApplication::arguments();
    RunTotals totals;

    // Register every test class here as it lands (step2+).
    runTestClass<SmokeTest>(baseArgs, logDir.path(), totals);

    if (totals.classes == 0 || totals.tests == 0) {
        std::fprintf(stderr,
                     "FATAL: the runner executed 0 test functions - refusing to report green\n");
        std::fflush(stderr);
        return 2;
    }

    std::printf("Totals: %d passed, %d failed (classes: %d)\n", totals.tests - totals.failed,
                totals.failed, totals.classes);
    std::fflush(stdout);
    return totals.failed == 0 ? 0 : 1;
}
