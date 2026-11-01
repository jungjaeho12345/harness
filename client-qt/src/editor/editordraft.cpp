#include "editor/editordraft.h"

#include <QLatin1Char>

#include <utility>

namespace editor {

const QStringList DRAFT_FIELDS = {
    QStringLiteral("title"),           QStringLiteral("body"),           QStringLiteral("author"),
    QStringLiteral("embargoAt"),       QStringLiteral("secondEmbargoAt"), QStringLiteral("coAuthor"),
    QStringLiteral("region"),          QStringLiteral("category"),        QStringLiteral("attribute"),
    QStringLiteral("keyword"),         QStringLiteral("internalComment"), QStringLiteral("externalComment"),
    QStringLiteral("attachmentFile"),  QStringLiteral("referenceFile")};

namespace {

// One day in milliseconds - the web's literal 86400000.
constexpr double kDayMs = 86400000.0;

// The web's try { ... } catch { } around every storage access: a store that throws is a store that is not there.
template <typename Fn>
void quietly(Fn &&fn)
{
    try {
        std::forward<Fn>(fn)();
    } catch (...) {
        // the medium is unavailable - this call goes without it (no-op / "no draft")
    }
}

} // namespace

IDraftStore::~IDraftStore() = default;

JsonValue sanitizeDraftData(const JsonValue &data)
{
    JsonValue out = JsonValue::makeObject();
    if (data.kind != JsonValue::Kind::Object)
        return out;
    for (const JsonMember &member : data.members) {
        if (member.value.kind == JsonValue::Kind::String && DRAFT_FIELDS.contains(member.key))
            out.insert(member.key, member.value);
    }
    return out;
}

void saveDraft(IDraftStore &store, const QString &key, const JsonValue &data, qint64 nowMs)
{
    if (data.kind != JsonValue::Kind::Object)
        return; // not a fields object - nothing to save, and the previous draft stays
    const JsonValue fields = sanitizeDraftData(data);
    quietly([&] { store.save(key, fields, nowMs); });
}

std::optional<JsonValue> loadDraft(IDraftStore &store, const QString &key)
{
    std::optional<DraftEntry> entry;
    quietly([&] { entry = store.load(key); });
    if (!entry || entry->data.kind != JsonValue::Kind::Object)
        return std::nullopt;
    return sanitizeDraftData(entry->data);
}

void clearDraft(IDraftStore &store, const QString &key)
{
    quietly([&] { store.remove(key); });
}

QStringList listDrafts(IDraftStore &store)
{
    QStringList keys;
    quietly([&] { keys = store.keys(); });
    return keys;
}

void expireDrafts(IDraftStore &store, int retentionDays, qint64 nowMs)
{
    // JavaScript arithmetic, as the web computes it: nowMs - retentionDays * 86400000 in doubles.
    const double cutoff = double(nowMs) - double(retentionDays) * kDayMs;
    quietly([&] {
        const QStringList keys = store.keys();
        for (const QString &key : keys) {
            const std::optional<DraftEntry> entry = store.load(key);
            if (entry && entry->savedAtMs < cutoff) // NaN (a savedAt that is not a number) is never below
                store.remove(key);
        }
    });
}

QString draftKeyFor(const QString &scopeId, const QString &articleId, const QString &tabId)
{
    if (!articleId.isEmpty())
        return articleId;
    return scopeId + QLatin1Char(':') + tabId;
}

std::optional<RecoveredDraft> loadDraftForRecover(IDraftStore &store, const QString &scopeId, const QString &articleId,
                                                  const QString &tabId)
{
    const QString key = draftKeyFor(scopeId, articleId, tabId);
    if (const std::optional<JsonValue> data = loadDraft(store, key))
        return RecoveredDraft{key, *data};
    if (key == articleId)
        return std::nullopt; // an existing article's key - no fallback (the rule comes from draftKeyFor, not a copy)
    if (const std::optional<JsonValue> legacy = loadDraft(store, tabId))
        return RecoveredDraft{tabId, *legacy};
    return std::nullopt;
}

} // namespace editor
