#include "configstoretest.h"

#include "shell/appidentity.h"
#include "shell/clientconfig.h"
#include "shell/configstore.h"

#include <QByteArray>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QList>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QtTest>

using shell::ClientConfig;

namespace {

// Records every filesystem call the store makes, in order, and can fail any one of them.
// This is the only way to observe *how* the file is replaced: a spy sees tmp -> rename,
// while an on-disk check only sees the result and cannot tell it from a direct overwrite.
class SpyFileSystem : public shell::ConfigFileSystem
{
public:
    struct Call {
        QString name;
        QString first;
        QString second;
        QByteArray data;
    };

    QList<Call> calls;
    int failAt = -1;              // index of the call that answers false
    QByteArray readable;          // what readFile hands back
    bool readableExists = false;  // whether readFile succeeds at all

    bool makeDirectory(const QString &dirPath) override
    {
        return record({QStringLiteral("makeDirectory"), dirPath, QString(), QByteArray()});
    }

    bool writeFile(const QString &filePath, const QByteArray &data) override
    {
        return record({QStringLiteral("writeFile"), filePath, QString(), data});
    }

    bool renameOver(const QString &fromPath, const QString &toPath) override
    {
        return record({QStringLiteral("renameOver"), fromPath, toPath, QByteArray()});
    }

    bool readFile(const QString &filePath, QByteArray *out) override
    {
        record({QStringLiteral("readFile"), filePath, QString(), QByteArray()});
        if (!readableExists)
            return false;
        if (out)
            *out = readable;
        return true;
    }

    QStringList names() const
    {
        QStringList result;
        for (const Call &call : calls)
            result << call.name;
        return result;
    }

private:
    bool record(const Call &call)
    {
        calls.append(call);
        return calls.size() - 1 != failAt;
    }
};

ClientConfig sampleConfig(const QString &serverUrl, int width = 1440, int height = 900)
{
    ClientConfig cfg;
    cfg.serverUrl = serverUrl;
    cfg.bounds.width = width;
    cfg.bounds.height = height;
    cfg.bounds.x = 12;
    cfg.bounds.y = 34;
    cfg.bounds.maximized = false;
    cfg.bounds.valid = true;
    return cfg;
}

bool writeRawFile(const QString &filePath, const QByteArray &content)
{
    QDir().mkpath(QFileInfo(filePath).absolutePath());
    QFile file(filePath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    const bool ok = file.write(content) == content.size();
    file.close();
    return ok;
}

} // namespace

void ConfigStoreTest::init()
{
    // Every test in this class runs with the environment it sets itself, and gets the real
    // one back in cleanup(): configDirPath() reads CLIENT_USER_DATA and APPDATA, and a
    // leaked value would send a later test at the real user's folder.
    m_hadUserDataEnv = qEnvironmentVariableIsSet("CLIENT_USER_DATA");
    m_savedUserDataEnv = qgetenv("CLIENT_USER_DATA");
    m_hadAppDataEnv = qEnvironmentVariableIsSet("APPDATA");
    m_savedAppDataEnv = qgetenv("APPDATA");
}

void ConfigStoreTest::cleanup()
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

// ---------------------------------------------------------------------------
// R11 / port spec X1: the OS-visible names are the Qt client's own.
void ConfigStoreTest::namesAreDistinctFromTheElectronShell()
{
    const QString qtFolder = shell::names::userDataFolder();
    const QString electronFolder = shell::names::electronUserDataFolder();

    QVERIFY(!qtFolder.isEmpty());
    QVERIFY2(qtFolder != electronFolder,
             "sharing the Electron shell's folder makes the two clients overwrite each "
             "other's config.json");
    QVERIFY(qtFolder.startsWith(electronFolder));
    QVERIFY(qtFolder.endsWith(QStringLiteral("-qt")));

    // The single instance names are ASCII (they end up in OS objects) and unrelated to the
    // folder name the Electron shell derives its own lock from.
    const QString mutexName = shell::names::singleInstanceMutex();
    const QString serverName = shell::names::singleInstanceLocalServer();
    QVERIFY(!mutexName.isEmpty());
    QVERIFY(!serverName.isEmpty());
    QVERIFY(mutexName != serverName);
    for (const QString &name : {mutexName, serverName}) {
        QVERIFY(!name.contains(electronFolder));
        for (const QChar ch : name)
            QVERIFY2(ch.unicode() < 128, qPrintable(name));
    }

    // The harness env name is inherited verbatim from the Electron shell.
    QCOMPARE(shell::names::userDataEnvVar(), QStringLiteral("CLIENT_USER_DATA"));
}

// ---------------------------------------------------------------------------
// R10: configPath is directory + filename. Nothing is checked, nothing exists yet.
void ConfigStoreTest::buildsTheConfigPath_data()
{
    QTest::addColumn<QString>("dirPath");
    QTest::addColumn<QString>("expected");

    QTest::newRow("plain directory") << QStringLiteral("C:/ud/x")
                                     << QStringLiteral("C:/ud/x/config.json");
    QTest::newRow("trailing separator") << QStringLiteral("C:/ud/x/")
                                        << QStringLiteral("C:/ud/x/config.json");
    QTest::newRow("native separators") << QStringLiteral("C:\\ud\\x")
                                       << QStringLiteral("C:/ud/x/config.json");

    // The canonical locks a Korean directory (client-shell-core:143-145) because that is
    // what %APPDATA% holds in production.
    const QString korean =
        QStringLiteral("C:/Users/x/AppData/Roaming/") + shell::names::userDataFolder();
    QTest::newRow("korean folder") << korean << (korean + QStringLiteral("/config.json"));

    // C-N4: the canonical configPath() is the one export that can throw (path.join on a
    // non-string). This port answers with an empty path, and the callers reject it.
    QTest::newRow("empty directory") << QString() << QString();
    QTest::newRow("whitespace directory") << QStringLiteral("   ") << QString();
}

void ConfigStoreTest::buildsTheConfigPath()
{
    QFETCH(QString, dirPath);
    QFETCH(QString, expected);

    QCOMPARE(shell::configFileName(), QStringLiteral("config.json"));
    QCOMPARE(shell::configFilePath(dirPath), expected);
}

// ---------------------------------------------------------------------------
// CLIENT_USER_DATA is the harness's only way to keep its hands off the real user folder.
void ConfigStoreTest::prefersTheInjectedUserDataDirectory()
{
    QTemporaryDir injected;
    QVERIFY(injected.isValid());

    qputenv("CLIENT_USER_DATA", injected.path().toLocal8Bit());
    QCOMPARE(shell::configDirPath(), QDir::cleanPath(injected.path()));

    // "as an absolute path": a relative value is resolved, never used as-is.
    qputenv("CLIENT_USER_DATA", QByteArray("relative-userdata-77"));
    const QString resolved = shell::configDirPath();
    QVERIFY(QDir::isAbsolutePath(resolved));
    QVERIFY(resolved.endsWith(QStringLiteral("relative-userdata-77")));

    // An empty or blank value is not a directory - fall back instead of writing to the
    // process working directory.
    qputenv("APPDATA", QByteArray("C:/fake-appdata-77"));
    for (const QByteArray &blank : {QByteArray(""), QByteArray("   ")}) {
        qputenv("CLIENT_USER_DATA", blank);
        QCOMPARE(shell::configDirPath(),
                 QStringLiteral("C:/fake-appdata-77/") + shell::names::userDataFolder());
    }
}

// ---------------------------------------------------------------------------
// R11: without the harness variable the folder is %APPDATA% + the Qt client's own name.
// This is a string computation - nothing is created, and the real folder is not read.
void ConfigStoreTest::fallsBackToItsOwnAppDataFolder()
{
    qunsetenv("CLIENT_USER_DATA");
    qputenv("APPDATA", QByteArray("C:/fake-appdata-77"));

    const QString dir = shell::configDirPath();
    QCOMPARE(dir, QStringLiteral("C:/fake-appdata-77/") + shell::names::userDataFolder());
    QVERIFY2(dir != QStringLiteral("C:/fake-appdata-77/") + shell::names::electronUserDataFolder(),
             "the Electron shell's user data folder must never be resolved");
    QCOMPARE(shell::configFilePath(dir),
             dir + QStringLiteral("/") + shell::configFileName());
    QVERIFY2(!QFileInfo::exists(dir), "resolving a path must not create anything");

    // Same answer with the machine's real APPDATA (still only a string).
    if (m_hadAppDataEnv) {
        qputenv("APPDATA", m_savedAppDataEnv);
        const QString realDir = shell::configDirPath();
        QCOMPARE(QFileInfo(realDir).fileName(), shell::names::userDataFolder());
        QVERIFY(QFileInfo(realDir).fileName() != shell::names::electronUserDataFolder());
    }
}

// ---------------------------------------------------------------------------
// R14: the write is serialize -> tmp next to the target -> rename over the target.
// Mutation M3-2 (direct overwrite) is red here and only here.
void ConfigStoreTest::writesThroughATemporaryFileAndRenames()
{
    SpyFileSystem fs;
    const QString dir = QStringLiteral("C:/ud/qt-client");
    const ClientConfig cfg = sampleConfig(QStringLiteral("http://h:3001"));

    QString error = QStringLiteral("untouched");
    QVERIFY(shell::saveConfigAtomically(dir, cfg, &error, fs));
    QVERIFY2(error.isEmpty(), qPrintable(error));

    QCOMPARE(fs.names(),
             QStringList({QStringLiteral("makeDirectory"), QStringLiteral("writeFile"),
                          QStringLiteral("renameOver")}));

    // (1) the directory is created first, and it is the target's directory.
    QCOMPARE(fs.calls.at(0).first, dir);

    // (2) the payload goes to a temporary file that is NOT the target and sits in the same
    // directory - rename is only atomic within one volume.
    const QString target = shell::configFilePath(dir);
    const QString tmpFile = fs.calls.at(1).first;
    QVERIFY2(tmpFile != target, "writing straight to config.json can leave half a JSON file");
    QCOMPARE(QFileInfo(tmpFile).path(), QFileInfo(target).path());
    QCOMPARE(fs.calls.at(1).data, shell::serializeConfig(cfg));
    QVERIFY(fs.calls.at(1).data.endsWith('\n'));

    // (3) the swap moves that same temporary file onto the target.
    QCOMPARE(fs.calls.at(2).first, tmpFile);
    QCOMPARE(fs.calls.at(2).second, target);
}

// ---------------------------------------------------------------------------
// A failing filesystem is a return value, never an exception, and never a partial write.
void ConfigStoreTest::reportsWriteFailuresAsAValue_data()
{
    QTest::addColumn<int>("failAt");
    QTest::addColumn<int>("expectedCalls");
    QTest::addColumn<QString>("lastCall");

    QTest::newRow("directory cannot be created") << 0 << 1 << QStringLiteral("makeDirectory");
    QTest::newRow("temporary file cannot be written") << 1 << 2 << QStringLiteral("writeFile");
    QTest::newRow("rename fails") << 2 << 3 << QStringLiteral("renameOver");
}

void ConfigStoreTest::reportsWriteFailuresAsAValue()
{
    QFETCH(int, failAt);
    QFETCH(int, expectedCalls);
    QFETCH(QString, lastCall);

    SpyFileSystem fs;
    fs.failAt = failAt;
    QString error;

    const bool ok = shell::saveConfigAtomically(QStringLiteral("C:/ud/qt-client"),
                                                sampleConfig(QStringLiteral("http://h:3001")),
                                                &error, fs);

    QVERIFY(!ok);
    QVERIFY2(!error.isEmpty(), "a failure has to say what failed");
    QCOMPARE(fs.calls.size(), expectedCalls);
    QCOMPARE(fs.calls.last().name, lastCall);

    // A caller that does not want the message must not crash either.
    SpyFileSystem quiet;
    quiet.failAt = failAt;
    QVERIFY(!shell::saveConfigAtomically(QStringLiteral("C:/ud/qt-client"),
                                         sampleConfig(QStringLiteral("http://h:3001")), nullptr,
                                         quiet));
}

// ---------------------------------------------------------------------------
// C-N4 continued: an empty directory is refused before anything is attempted.
void ConfigStoreTest::rejectsAnEmptyDirectoryWithoutTouchingTheFilesystem()
{
    for (const QString &dir : {QString(), QStringLiteral("   ")}) {
        SpyFileSystem fs;
        QString error;
        QVERIFY(!shell::saveConfigAtomically(dir, sampleConfig(QStringLiteral("http://h:3001")),
                                             &error, fs));
        QVERIFY(!error.isEmpty());
        QVERIFY2(fs.calls.isEmpty(), qPrintable(fs.names().join(QLatin1Char(','))));

        SpyFileSystem reader;
        QCOMPARE(shell::loadConfig(dir, reader), ClientConfig());
        QVERIFY(reader.calls.isEmpty());
    }
}

// ---------------------------------------------------------------------------
// Real filesystem: after a save the directory holds config.json and nothing else.
void ConfigStoreTest::leavesNoTemporaryFileBehind()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString dir = QDir(tmp.path()).filePath(QStringLiteral("userdata"));

    QString error;
    QVERIFY2(shell::saveConfigAtomically(dir, sampleConfig(QStringLiteral("http://h:3001")),
                                         &error),
             qPrintable(error));

    const QStringList entries =
        QDir(dir).entryList(QDir::Files | QDir::Hidden | QDir::System | QDir::NoDotAndDotDot);
    QCOMPARE(entries, QStringList({QStringLiteral("config.json")}));
}

// ---------------------------------------------------------------------------
// Real filesystem: replacing an existing file works. QFile::rename() refuses an existing
// target on Windows, so this row is what forces the replacing rename in the implementation.
void ConfigStoreTest::overwritesAnExistingConfigFile()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString dir = tmp.path();

    QString error;
    QVERIFY2(shell::saveConfigAtomically(dir, sampleConfig(QStringLiteral("http://first:3001")),
                                         &error),
             qPrintable(error));
    const ClientConfig second = sampleConfig(QStringLiteral("http://second:3001"), 1024, 720);
    QVERIFY2(shell::saveConfigAtomically(dir, second, &error), qPrintable(error));

    QCOMPARE(shell::loadConfig(dir), second);
    QCOMPARE(QDir(dir).entryList(QDir::Files | QDir::Hidden | QDir::NoDotAndDotDot),
             QStringList({QStringLiteral("config.json")}));
}

// ---------------------------------------------------------------------------
// Real filesystem: a missing directory (first run) is created, parents included.
void ConfigStoreTest::createsAMissingDirectory()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString dir = QDir(tmp.path()).filePath(QStringLiteral("nested/deeper/userdata"));
    QVERIFY(!QFileInfo::exists(dir));

    QString error;
    QVERIFY2(shell::saveConfigAtomically(dir, sampleConfig(QStringLiteral("http://h:3001")),
                                         &error),
             qPrintable(error));
    QVERIFY(QFileInfo::exists(shell::configFilePath(dir)));
}

// ---------------------------------------------------------------------------
// Real filesystem: an unusable path fails as a value. The directory here cannot be created
// because its parent is a file - deterministic, unlike guessing at a missing drive letter.
void ConfigStoreTest::failsWithoutThrowingOnAnUnusablePath()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString blocker = QDir(tmp.path()).filePath(QStringLiteral("blocker"));
    QVERIFY(writeRawFile(blocker, QByteArray("not a directory")));
    const QString dir = blocker + QStringLiteral("/sub");

    QString error;
    QVERIFY(!shell::saveConfigAtomically(dir, sampleConfig(QStringLiteral("http://h:3001")),
                                         &error));
    QVERIFY(!error.isEmpty());
    QVERIFY(!QFileInfo::exists(dir));

    // Reading the same path is equally quiet.
    QCOMPARE(shell::loadConfig(dir), ClientConfig());
}

// ---------------------------------------------------------------------------
// Real filesystem: the round trip through disk, and no secret on the way.
void ConfigStoreTest::loadsBackWhatItSaved()
{
    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    const QString dir = tmp.path();

    ClientConfig cfg = sampleConfig(QStringLiteral("http://192.168.0.10:3001"));
    cfg.bounds.maximized = true;

    QString error;
    QVERIFY2(shell::saveConfigAtomically(dir, cfg, &error), qPrintable(error));
    QCOMPARE(shell::loadConfig(dir), cfg);

    QFile file(shell::configFilePath(dir));
    QVERIFY(file.open(QIODevice::ReadOnly));
    const QByteArray onDisk = file.readAll();
    file.close();
    QVERIFY(onDisk.endsWith('\n'));
    QCOMPARE(onDisk, shell::serializeConfig(cfg));
    for (const char *forbidden : {"sessionId", "cookie", "password", "token"})
        QVERIFY(!onDisk.contains(forbidden));
}

// ---------------------------------------------------------------------------
// Reading never fails: a missing, empty or corrupt file is the default config.
void ConfigStoreTest::loadFallsBackToDefaults_data()
{
    QTest::addColumn<bool>("createFile");
    QTest::addColumn<QByteArray>("content");

    QTest::newRow("no file at all") << false << QByteArray();
    QTest::newRow("empty file") << true << QByteArray();
    QTest::newRow("broken JSON") << true << QByteArray("{oops");
    QTest::newRow("array") << true << QByteArray("[1,2]");
    QTest::newRow("secrets only") << true
                                  << QByteArray(R"({"sessionId":"abc","cookie":"sid=leak"})");
}

void ConfigStoreTest::loadFallsBackToDefaults()
{
    QFETCH(bool, createFile);
    QFETCH(QByteArray, content);

    QTemporaryDir tmp;
    QVERIFY(tmp.isValid());
    if (createFile)
        QVERIFY(writeRawFile(shell::configFilePath(tmp.path()), content));

    QCOMPARE(shell::loadConfig(tmp.path()), ClientConfig());
}
