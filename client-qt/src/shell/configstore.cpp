#include "shell/configstore.h"

#include "shell/appidentity.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QIODevice>
#include <QStandardPaths>

#ifdef Q_OS_WIN
#  ifndef NOMINMAX
#    define NOMINMAX
#  endif
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
#else
#  include <cstdio>
#endif

namespace shell {
namespace {

const char kTempSuffix[] = ".tmp";

class RealFileSystem : public ConfigFileSystem
{
public:
    bool makeDirectory(const QString &dirPath) override
    {
        if (dirPath.trimmed().isEmpty())
            return false;
        return QDir().mkpath(dirPath);  // true when it already exists
    }

    bool writeFile(const QString &filePath, const QByteArray &data) override
    {
        QFile file(filePath);
        if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate))
            return false;
        const bool written = file.write(data) == static_cast<qint64>(data.size());
        // flush() before close() so that a write error is seen here and not swallowed.
        const bool flushed = file.flush();
        file.close();
        return written && flushed && file.error() == QFileDevice::NoError;
    }

    bool renameOver(const QString &fromPath, const QString &toPath) override
    {
        // QFile::rename() refuses an existing target, which would turn the second save of
        // the session into a failure. The platform call replaces in one step - that
        // replacement IS the atomicity this module promises.
#ifdef Q_OS_WIN
        return MoveFileExW(reinterpret_cast<const wchar_t *>(fromPath.utf16()),
                           reinterpret_cast<const wchar_t *>(toPath.utf16()),
                           MOVEFILE_REPLACE_EXISTING)
            != 0;
#else
        return std::rename(QFile::encodeName(fromPath).constData(),
                           QFile::encodeName(toPath).constData())
            == 0;
#endif
    }

    bool readFile(const QString &filePath, QByteArray *out) override
    {
        QFile file(filePath);
        if (!file.open(QIODevice::ReadOnly))
            return false;
        const QByteArray content = file.readAll();
        const bool ok = file.error() == QFileDevice::NoError;
        file.close();
        if (ok && out)
            *out = content;
        return ok;
    }
};

QString cleanDirectory(const QString &dirPath)
{
    const QString trimmed = dirPath.trimmed();
    if (trimmed.isEmpty())
        return QString();
    return QDir::cleanPath(trimmed);
}

} // namespace

ConfigFileSystem::~ConfigFileSystem() = default;

ConfigFileSystem &realFileSystem()
{
    static RealFileSystem fs;
    return fs;
}

QString configFileName()
{
    return QStringLiteral("config.json");
}

QString configDirPath()
{
    // The harness (and every test) points this at a temporary folder: it is the only way to
    // keep automated runs away from the real user's settings.
    const QByteArray envName = names::userDataEnvVar().toLatin1();
    const QString injected = qEnvironmentVariable(envName.constData()).trimmed();
    if (!injected.isEmpty())
        return QDir::cleanPath(QDir(injected).absolutePath());

    // %APPDATA% is what the Electron shell's app.getPath('userData') resolves to on Windows
    // before it appends the product name; this client appends its own name instead - never
    // names::electronUserDataFolder(), or the two clients erase each other's settings.
    QString roaming = qEnvironmentVariable("APPDATA").trimmed();
    if (roaming.isEmpty())
        roaming = QStandardPaths::writableLocation(QStandardPaths::GenericConfigLocation);
    return QDir::cleanPath(QDir(roaming).filePath(names::userDataFolder()));
}

QString configFilePath(const QString &dirPath)
{
    const QString dir = cleanDirectory(dirPath);
    if (dir.isEmpty())
        return QString();  // C-N4: a value, not an exception
    return QDir::cleanPath(QDir(dir).filePath(configFileName()));
}

ClientConfig loadConfig(const QString &dirPath, ConfigFileSystem &fs)
{
    const QString filePath = configFilePath(dirPath);
    if (filePath.isEmpty())
        return ClientConfig();

    QByteArray raw;
    if (!fs.readFile(filePath, &raw))
        return ClientConfig();  // missing, locked, unreadable - all the same answer
    return parseConfig(raw);
}

bool saveConfigAtomically(const QString &dirPath, const ClientConfig &config, QString *error,
                          ConfigFileSystem &fs)
{
    const auto fail = [error](const QString &message) {
        if (error)
            *error = message;
        return false;
    };

    const QString dir = cleanDirectory(dirPath);
    if (dir.isEmpty())
        return fail(QStringLiteral("config directory is empty"));

    const QString target = configFilePath(dir);
    const QString tempFile = target + QLatin1String(kTempSuffix);

    if (!fs.makeDirectory(dir))
        return fail(QStringLiteral("cannot create the config directory: %1").arg(dir));
    // The payload lands next to the target, never on it: a crash in the middle leaves the
    // previous config.json untouched instead of half a JSON document. rename is only atomic
    // within one volume, which is why the temporary file shares the directory.
    if (!fs.writeFile(tempFile, serializeConfig(config)))
        return fail(QStringLiteral("cannot write the temporary config file: %1").arg(tempFile));
    if (!fs.renameOver(tempFile, target))
        return fail(QStringLiteral("cannot replace the config file: %1").arg(target));

    if (error)
        error->clear();
    return true;
}

} // namespace shell
