#include "singleinstancetest.h"

#include "shell/appidentity.h"
#include "shell/configstore.h"
#include "shell/singleinstance.h"

#include <QDir>
#include <QElapsedTimer>
#include <QSignalSpy>
#include <QString>
#include <QTemporaryDir>
#include <QtTest>

using shell::InstanceGuard;
using shell::InstanceNames;
using shell::SingleInstanceGuard;

namespace {

bool isAscii(const QString &text)
{
    for (const QChar c : text) {
        if (c.unicode() > 0x7f)
            return false;
    }
    return true;
}

} // namespace

void SingleInstanceTest::init()
{
    m_hadUserDataEnv = qEnvironmentVariableIsSet("CLIENT_USER_DATA");
    m_savedUserDataEnv = qgetenv("CLIENT_USER_DATA");
    m_hadAppDataEnv = qEnvironmentVariableIsSet("APPDATA");
    m_savedAppDataEnv = qgetenv("APPDATA");
}

void SingleInstanceTest::cleanup()
{
    if (m_hadUserDataEnv)
        qputenv("CLIENT_USER_DATA", m_savedUserDataEnv);
    else
        qunsetenv("CLIENT_USER_DATA");
    if (m_hadAppDataEnv)
        qputenv("APPDATA", m_savedAppDataEnv);
    else
        qunsetenv("APPDATA");
}

// R1 + R13: the names are the Qt client's own base names plus a digest of the folder, so the
// lock is scoped to the user data folder exactly like the canonical's.
void SingleInstanceTest::derivesTheNamesFromTheUserDataFolder()
{
    const InstanceNames a = shell::instanceNamesFor(QStringLiteral("C:/tmp/qt-client-a"));
    const InstanceNames b = shell::instanceNamesFor(QStringLiteral("C:/tmp/qt-client-b"));

    QVERIFY2(a != b, "two user data folders must never share one lock");
    QVERIFY(a.mutex != a.server);

    const QString mutexPrefix =
        QStringLiteral("Local\\") + shell::names::singleInstanceMutex() + QLatin1Char('-');
    const QString serverPrefix = shell::names::singleInstanceLocalServer() + QLatin1Char('-');
    QVERIFY2(a.mutex.startsWith(mutexPrefix), qPrintable(a.mutex));
    QVERIFY2(a.server.startsWith(serverPrefix), qPrintable(a.server));
    // The same digest scopes both objects.
    QCOMPARE(a.mutex.mid(mutexPrefix.size()), a.server.mid(serverPrefix.size()));
    QVERIFY(a.mutex.size() > mutexPrefix.size());

    // OS object names: ASCII, and nothing of the Electron shell's (its lock is derived from its
    // own folder - see appidentity.h).
    for (const QString &name : {a.mutex, a.server}) {
        QVERIFY2(isAscii(name), qPrintable(name));
        QVERIFY(!name.contains(shell::names::electronUserDataFolder()));
    }
    QVERIFY(!a.server.contains(QLatin1Char('\\')));  // the pipe name is a single segment
}

// Windows paths are case-insensitive and have two separators: every spelling of one folder has
// to land on one lock, otherwise "the same profile" could be opened twice.
void SingleInstanceTest::treatsSpellingsOfOneFolderAsOneInstance_data()
{
    QTest::addColumn<QString>("spelling");
    QTest::addColumn<bool>("sameInstance");

    QTest::newRow("identical") << QStringLiteral("C:/Users/u/AppData/Roaming/app-qt") << true;
    QTest::newRow("backslashes") << QStringLiteral("C:\\Users\\u\\AppData\\Roaming\\app-qt") << true;
    QTest::newRow("trailing slash") << QStringLiteral("C:/Users/u/AppData/Roaming/app-qt/") << true;
    QTest::newRow("dot segment") << QStringLiteral("C:/Users/u/AppData/./Roaming/app-qt") << true;
    QTest::newRow("letter case") << QStringLiteral("c:/USERS/u/appdata/roaming/APP-QT") << true;
    QTest::newRow("another folder") << QStringLiteral("C:/Users/u/AppData/Roaming/app") << false;
    QTest::newRow("a subfolder") << QStringLiteral("C:/Users/u/AppData/Roaming/app-qt/x") << false;
}

void SingleInstanceTest::treatsSpellingsOfOneFolderAsOneInstance()
{
    QFETCH(QString, spelling);
    QFETCH(bool, sameInstance);

    const InstanceNames reference =
        shell::instanceNamesFor(QStringLiteral("C:/Users/u/AppData/Roaming/app-qt"));
    QCOMPARE(shell::instanceNamesFor(spelling) == reference, sameInstance);
}

// W-N3 (NEW coverage): CLIENT_USER_DATA is conditional - set, it decides the folder and hence
// the lock; unset, the client's own %APPDATA% folder does. Only strings are computed here.
void SingleInstanceTest::followsTheResolvedUserDataFolder()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());

    qputenv("CLIENT_USER_DATA", QDir::toNativeSeparators(tmp.path()).toLocal8Bit());
    const InstanceNames injected = shell::instanceNamesFor(shell::configDirPath());
    QCOMPARE(injected, shell::instanceNamesFor(tmp.path()));

    qunsetenv("CLIENT_USER_DATA");
    const QString roaming = QDir(tmp.path()).filePath(QStringLiteral("roaming"));
    qputenv("APPDATA", QDir::toNativeSeparators(roaming).toLocal8Bit());
    const InstanceNames fallback = shell::instanceNamesFor(shell::configDirPath());
    QCOMPARE(fallback, shell::instanceNamesFor(QDir(roaming).filePath(shell::names::userDataFolder())));
    QVERIFY(fallback != injected);
    QVERIFY(fallback
            != shell::instanceNamesFor(QDir(roaming).filePath(shell::names::electronUserDataFolder())));
}

// R-instance-ipc, half one: the exclusive lock.
void SingleInstanceTest::grantsTheLockToExactlyOneGuard()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const InstanceNames names = shell::instanceNamesFor(tmp.path());

    SingleInstanceGuard first(names);
    SingleInstanceGuard second(names);
    QVERIFY(!first.isPrimary());

    QVERIFY(first.tryBecomePrimary());
    QVERIFY(first.isPrimary());
    QVERIFY2(!second.tryBecomePrimary(), "a second holder of the same lock means no lock at all");
    QVERIFY(!second.isPrimary());
    QVERIFY(!second.tryBecomePrimary());  // asking again changes nothing
    QCOMPARE(first.names(), names);
}

// A named mutex dies with its last handle - a crashed client leaves nothing stale behind.
void SingleInstanceTest::releasesTheLockWithItsHolder()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const InstanceNames names = shell::instanceNamesFor(tmp.path());

    {
        SingleInstanceGuard holder(names);
        QVERIFY(holder.tryBecomePrimary());
        SingleInstanceGuard blocked(names);
        QVERIFY(!blocked.tryBecomePrimary());
    }
    SingleInstanceGuard next(names);
    QVERIFY2(next.tryBecomePrimary(), "the lock outlived its holder");
}

// R-instance-ipc, half two: the notice. The lock alone would tell a second launch nothing about
// the first; the local server is what carries "come forward".
void SingleInstanceTest::carriesASecondLaunchToThePrimary()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const InstanceNames names = shell::instanceNamesFor(tmp.path());

    SingleInstanceGuard primary(names);
    QVERIFY(primary.tryBecomePrimary());
    QSignalSpy knocks(&primary, &InstanceGuard::activationRequested);

    SingleInstanceGuard secondary(names);
    QVERIFY(!secondary.tryBecomePrimary());
    QVERIFY(secondary.notifyPrimary());
    QTRY_COMPARE_WITH_TIMEOUT(knocks.count(), 1, 5000);

    SingleInstanceGuard third(names);
    QVERIFY(!third.tryBecomePrimary());
    QVERIFY(third.notifyPrimary());
    QTRY_COMPARE_WITH_TIMEOUT(knocks.count(), 2, 5000);
}

void SingleInstanceTest::failsQuietlyWhenNobodyListens()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    SingleInstanceGuard orphan(shell::instanceNamesFor(tmp.path()));

    QElapsedTimer timer;
    timer.start();
    QVERIFY(!orphan.notifyPrimary());
    QVERIFY2(timer.elapsed() < 5000, "a second launch must not hang when nobody answers");
}
