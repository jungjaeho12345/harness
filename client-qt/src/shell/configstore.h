#ifndef CLIENT_QT_SHELL_CONFIGSTORE_H
#define CLIENT_QT_SHELL_CONFIGSTORE_H

// The filesystem half of the config port (phase 77 step3): where config.json lives and how
// it is replaced. Everything that decides *what* the file may contain is in clientconfig.h.
//
// Two rules this file exists to enforce:
//   1. The write is atomic: serialize -> write "config.json.tmp" next to the target ->
//      rename over the target. A crash in the middle must never leave half a JSON document
//      behind, and rename is only atomic within the same volume, hence "next to".
//   2. Failure is a return value, not an exception. A shell that cannot save its settings
//      still has to run.

#include "shell/clientconfig.h"

#include <QByteArray>
#include <QString>

namespace shell {

// The seam. The production implementation is realFileSystem(); tests inject a spy to
// observe that the write path really is tmp->rename (a test that only checks "no leftover
// temp file" stays green when the write degrades to a direct overwrite).
class ConfigFileSystem
{
public:
    virtual ~ConfigFileSystem();

    // Creates dirPath and any missing parent. True when the directory exists afterwards.
    virtual bool makeDirectory(const QString &dirPath) = 0;
    // Writes data to filePath, truncating an existing file.
    virtual bool writeFile(const QString &filePath, const QByteArray &data) = 0;
    // Renames fromPath onto toPath, replacing an existing target.
    virtual bool renameOver(const QString &fromPath, const QString &toPath) = 0;
    // Reads filePath. False when it cannot be read at all (missing, locked, no permission).
    virtual bool readFile(const QString &filePath, QByteArray *out) = 0;
};

ConfigFileSystem &realFileSystem();

QString configFileName();

// CLIENT_USER_DATA (absolute, harness-injected) wins; otherwise %APPDATA% plus the Qt
// client's own folder name - never the Electron shell's folder (appidentity.h).
QString configDirPath();

// dirPath + "/config.json". An empty directory yields an empty path instead of throwing:
// the canonical configPath() is the one export in its module that CAN throw (path.join on
// a non-string), and CLIENT_USER_DATA resolving to an empty string is a real way to get
// there, so this port answers with a value that the callers below reject.
QString configFilePath(const QString &dirPath);

// Reads dirPath/config.json. Any failure - missing file, unreadable, broken JSON - is the
// default config. Never throws, never reports.
ClientConfig loadConfig(const QString &dirPath, ConfigFileSystem &fs = realFileSystem());

// Atomic save. Returns false and fills *error (when non-null) instead of throwing.
bool saveConfigAtomically(const QString &dirPath, const ClientConfig &config, QString *error,
                          ConfigFileSystem &fs = realFileSystem());

} // namespace shell

#endif // CLIENT_QT_SHELL_CONFIGSTORE_H
