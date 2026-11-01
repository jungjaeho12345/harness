#include "editor/editordraftstore.h"

#include <QByteArray>
#include <QDir>
#include <QFileInfo>
#include <QLatin1String>
#include <QStringDecoder>

#include <limits>

namespace editor {
namespace {

const char kTempSuffix[] = ".tmp";

// The web's JSON.parse of its storage value - anything that is not a JSON object is the empty object. Strictly:
// bytes that are not UTF-8 are as broken as text that is not JSON (localStorage holds UTF-16 - it has no such case),
// and a lenient decode would hand back drafts with U+FFFD where the text was.
JsonValue parseStored(const QByteArray &raw)
{
    QStringDecoder decoder(QStringDecoder::Utf8);
    const QString text = decoder(raw);
    JsonValue parsed;
    if (decoder.hasError() || !parseJson(text, &parsed) || parsed.kind != JsonValue::Kind::Object)
        return JsonValue::makeObject();
    return parsed;
}

// The draft data of a stored entry - an object with a "data" member (the web's typeof entry === 'object' &&
// 'data' in entry) - or nullptr for anything else stored under a key.
const JsonValue *draftData(const JsonValue &entry)
{
    if (entry.kind != JsonValue::Kind::Object)
        return nullptr;
    return entry.find(QStringLiteral("data"));
}

} // namespace

QString draftFileName()
{
    return QStringLiteral("editor-drafts.json");
}

QString draftFilePath(const QString &dirPath)
{
    const QString dir = dirPath.trimmed();
    if (dir.isEmpty())
        return QString(); // a value, not an exception - the store on it holds nothing
    return QDir::cleanPath(QDir(QDir::cleanPath(dir)).filePath(draftFileName()));
}

DraftFileStore::DraftFileStore(const QString &filePath, shell::ConfigFileSystem &fs) : m_filePath(filePath), m_fs(fs) {}

void DraftFileStore::save(const QString &key, const JsonValue &data, qint64 savedAtMs)
{
    JsonValue all;
    if (!readAll(&all))
        return; // unreadable: writing now would replace every other draft
    JsonValue entry = JsonValue::makeObject();
    entry.insert(QStringLiteral("data"), data);
    entry.insert(QStringLiteral("savedAt"), JsonValue::makeNumber(double(savedAtMs)));
    all.insert(key, entry); // all[key] = ... : a present key keeps its place
    writeAll(all);
}

std::optional<DraftEntry> DraftFileStore::load(const QString &key)
{
    JsonValue all;
    if (!readAll(&all))
        return std::nullopt;
    const JsonValue *entry = all.find(key);
    const JsonValue *data = entry ? draftData(*entry) : nullptr;
    if (!data)
        return std::nullopt;
    const JsonValue *savedAt = entry->find(QStringLiteral("savedAt"));
    const double at = savedAt && savedAt->kind == JsonValue::Kind::Number ? savedAt->numberValue
                                                                          : std::numeric_limits<double>::quiet_NaN();
    return DraftEntry{*data, at};
}

void DraftFileStore::remove(const QString &key)
{
    JsonValue all;
    if (!readAll(&all))
        return;
    for (auto it = all.members.begin(); it != all.members.end(); ++it) {
        if (it->key == key) { // whatever is stored under it, draft or not (the web's delete all[key])
            all.members.erase(it);
            writeAll(all);
            return;
        }
    }
    // absent: nothing to write
}

QStringList DraftFileStore::keys()
{
    QStringList out;
    JsonValue all;
    if (!readAll(&all))
        return out;
    for (const JsonMember &member : all.members) {
        if (draftData(member.value))
            out << member.key;
    }
    return out;
}

QString DraftFileStore::filePath() const
{
    return m_filePath;
}

bool DraftFileStore::readAll(JsonValue *all) const
{
    *all = JsonValue::makeObject();
    if (m_filePath.isEmpty())
        return false; // nowhere to read from - and so nowhere to write to
    QByteArray raw;
    if (!m_fs.readFile(m_filePath, &raw))
        return !QFileInfo::exists(m_filePath); // missing: an empty store; there but unreadable: no write may follow
    *all = parseStored(raw);
    return true;
}

void DraftFileStore::writeAll(const JsonValue &all)
{
    // The config store's write: the payload lands next to the target and is renamed over it, so a crash in the
    // middle leaves the previous file whole (rename is atomic within one volume - hence "next to").
    const QString temp = m_filePath + QLatin1String(kTempSuffix);
    if (!m_fs.makeDirectory(QFileInfo(m_filePath).absolutePath()))
        return;
    if (!m_fs.writeFile(temp, stringifyJson(all).toUtf8()))
        return;
    m_fs.renameOver(temp, m_filePath);
}

} // namespace editor
