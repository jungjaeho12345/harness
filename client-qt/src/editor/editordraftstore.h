#ifndef CLIENT_QT_EDITOR_EDITORDRAFTSTORE_H
#define CLIENT_QT_EDITOR_EDITORDRAFTSTORE_H

// The production IDraftStore (phase 78 step7): the drafts in one JSON file of their own, beside config.json and
// apart from it - drafts are for recovery, config is the server address and the window (decisions (5)). The
// filesystem half of editordraft.h, the way configstore is the filesystem half of clientconfig.
//
// The file holds exactly what the web keeps in localStorage under 'yh.editorDrafts': JSON.stringify of
// { [key]: { data, savedAt } } - compact, UTF-8, no trailing newline - written by the block model's JSON.stringify
// port (stringifyJson), so a lone surrogate in a body comes back as itself and the bytes match the web's value for
// the same operations. Every call reads the file, changes one key and writes it back (the web's readAll/writeAll):
//   - missing file: an empty store. A file that is not a JSON object (broken JSON, not UTF-8, null, an array ...):
//     also an empty store - reading finds nothing, clearing writes nothing, and the next save replaces it with a
//     fresh object, as the web replaces a storage value it cannot parse. (The web lets a JSON array through and
//     then silently loses the save; here an array is broken like anything else.)
//   - a file that is there but cannot be read (locked, a directory in its place): nothing loads and NOTHING IS
//     WRITTEN. Writing after a failed read would replace every other draft with the one being saved - the web never
//     meets this case, because a storage it cannot read is one it cannot write either.
//   - entries this module did not write (a hand-edited file) are carried through: only an object with a "data"
//     member is a draft (load/keys); anything else under a key keeps its value until that key is saved or removed.
//     As on the web, a write re-serializes the whole object the JSON.stringify way (spacing and escapes normalized).
// The write is the config store's: serialize -> "<file>.tmp" next to the target -> rename over the target, through
// the same shell::ConfigFileSystem seam (shell/configstore.h - used, not changed), so a crash in the middle leaves
// the previous file whole and tests can watch the write path. Failure is silence, never an exception.
//
// Where the file lives is the caller's: draftFilePath(shell::configDirPath()) puts it in the Qt client's own user
// data folder - CLIENT_USER_DATA in harness runs and tests, never the real user's folder there.

#include "editor/editordraft.h"
#include "shell/configstore.h"

#include <QString>
#include <QStringList>

#include <optional>

namespace editor {

QString draftFileName(); // "editor-drafts.json"

// dirPath + "/editor-drafts.json"; an empty (or blank) dirPath is an empty path - a store on it holds nothing and
// writes nowhere.
QString draftFilePath(const QString &dirPath);

class DraftFileStore : public IDraftStore
{
public:
    explicit DraftFileStore(const QString &filePath, shell::ConfigFileSystem &fs = shell::realFileSystem());

    void save(const QString &key, const JsonValue &data, qint64 savedAtMs) override;
    std::optional<DraftEntry> load(const QString &key) override;
    void remove(const QString &key) override;
    QStringList keys() override;

    QString filePath() const;

private:
    // The stored object (empty for a missing or broken file). False when the file is there but cannot be read -
    // the one case where no write may follow.
    bool readAll(JsonValue *all) const;
    void writeAll(const JsonValue &all);

    QString m_filePath;
    shell::ConfigFileSystem &m_fs;
};

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORDRAFTSTORE_H
