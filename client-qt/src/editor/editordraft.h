#ifndef CLIENT_QT_EDITOR_EDITORDRAFT_H
#define CLIENT_QT_EDITOR_EDITORDRAFT_H

// Draft (autosave) store of the editor (phase 78 step7): a 1:1 port of web/src/view/editorDraft.js - its spec,
// editorDraft.test.js, lives on as tests/editordrafttest.cpp.
//
// A draft is a snapshot of one editing surface's fields kept under a key - { [key]: { data, savedAt } }, the shape
// of the web's localStorage value 'yh.editorDrafts' - so that 파일 > 복구 can bring back what was never saved
// (news.md "# 에디터 환경설정 > 자동저장", "파일 > 복구").
//
// Pure: everything the web module reads from its environment arrives as an argument here.
//   - the storage medium is an IDraftStore (the web's localStorage). DraftFileStore (editordraftstore.h) is the
//     production one - a JSON file of its own next to config.json, never config.json itself; tests use an
//     in-memory one.
//   - the time is nowMs (the web's own rule: savedAt is injected, the module never asks the clock).
//   - the window scope of a new tab's key is scopeId (the web's draftScopeId(), a per-browser-tab id kept in
//     sessionStorage). Issuing that id is the caller's job - see draftKeyFor.
// What it deliberately does not do (the web module draws the same lines):
//   - run a timer. When to take a snapshot is the state machine's decision (step9 - the web's WriterPage
//     autosave interval), and TimerPolicyTest forbids a periodic timer anywhere in the client.
//   - interpret the fields. body is the opaque saved markup (serialize(renormalizeEndMarker(blocks))'s output):
//     stored and handed back code unit for code unit - never deserialized, never normalized.
//
// Graceful, like the web's localStorage handling: a store that throws is a store that is not there - saving and
// clearing become no-ops and reading answers "no draft". Nothing here throws.
//
// CRITICAL (inherited from shell/clientconfig.h): a draft never holds a session id, a password, a cookie or a token
// - nor the edit client id (decisions (3)). The draft file is outside the trust boundary like config.json, so the
// fields are a whitelist, DRAFT_FIELDS, applied on the way in and on the way out: any other key never reaches the
// store, and a key planted in the file never reaches the caller. The web stores whatever object it is handed; its
// only producer hands it exactly these fields ({ ...tab.fields }), so the whitelist changes nothing for a real
// draft.
//
// Deliberate divergences from the web module, all on inputs no producer makes:
//   - a draft's data is a JSON object of string fields. A non-object handed to saveDraft is not saved (the previous
//     draft stays), a stored non-object reads as no draft, and a field whose value is not a string is dropped.
//   - keys are plain strings: "__proto__" is a key like any other (the web loses it to the prototype setter), and
//     clearing an absent "toString" writes nothing (the web's `key in all` sees the prototype and rewrites).
//   - expireDrafts works through IDraftStore one key at a time, so a store that fails half way leaves the expiry
//     half done (the web writes once, all or nothing). Expiry is best effort - the next one finishes it.

#include "editor/editorcontent.h"

#include <QString>
#include <QStringList>
#include <QtGlobal>

#include <optional>

namespace editor {

// The fields a draft may hold - the web's EDITABLE_FIELDS (web/src/controller/useWriteController.js), same order.
// A draft is { ...tab.fields } there and tab.fields holds exactly these. Never add a secret here (see above).
extern const QStringList DRAFT_FIELDS;

// One stored draft as a store hands it back.
struct DraftEntry {
    JsonValue data;        // as stored - loadDraft keeps the DRAFT_FIELDS of an object and rejects anything else
    double savedAtMs = 0;  // the caller's clock at the save; NaN when the stored value is not a number (never expires)
};

// The storage medium (the web's localStorage). Any member may throw - every function below swallows it.
class IDraftStore
{
public:
    virtual ~IDraftStore();

    // Stores { data, savedAt: savedAtMs } under key: a new key goes last, a present one is replaced in place.
    virtual void save(const QString &key, const JsonValue &data, qint64 savedAtMs) = 0;
    // The draft under key; std::nullopt when there is none.
    virtual std::optional<DraftEntry> load(const QString &key) = 0;
    // Removes the draft under key; an absent key is not an error.
    virtual void remove(const QString &key) = 0;
    // Every key load() answers for, in storage order.
    virtual QStringList keys() = 0;
};

// data reduced to the DRAFT_FIELDS whose value is a string, in data's own order; the empty object for a non-object.
JsonValue sanitizeDraftData(const JsonValue &data);

// Saves data under key with savedAt = nowMs (editorDraft.saveDraft) - the same key is overwritten. Only an object
// is saved, and only its DRAFT_FIELDS.
void saveDraft(IDraftStore &store, const QString &key, const JsonValue &data, qint64 nowMs);

// The draft data under key - its DRAFT_FIELDS (editorDraft.loadDraft). std::nullopt (the web's null) when there is
// none, when the stored data is not an object, or when the store fails.
std::optional<JsonValue> loadDraft(IDraftStore &store, const QString &key);

// Removes the draft under key; every other key stays (editorDraft.clearDraft).
void clearDraft(IDraftStore &store, const QString &key);

// The keys holding a draft, in storage order; empty when the store fails. The web has no such export - this is the
// enumeration its expireDrafts does inline (Object.keys of the stored value), named.
QStringList listDrafts(IDraftStore &store);

// Removes every draft saved before nowMs - retentionDays days: savedAt < nowMs - retentionDays * 86400000
// (editorDraft.expireDrafts). Exactly at the limit stays. JavaScript arithmetic: the cutoff is a double.
void expireDrafts(IDraftStore &store, int retentionDays, qint64 nowMs);

// The one rule for a draft's key (editorDraft.draftKeyFor): an existing article is its articleId - globally unique,
// so the same draft is found from any window - and a new tab is "<scopeId>:<tabId>". Every write uses this key.
//
// scopeId is the web's draftScopeId(): one id per browser tab, kept in sessionStorage so that a reload keeps it
// and another window gets its own (the storage is shared by every window, and new-tab ids "tab-1".. are not). The
// caller issues and keeps it - this module does not generate ids. A null or empty articleId is a new tab.
QString draftKeyFor(const QString &scopeId, const QString &articleId, const QString &tabId);

struct RecoveredDraft {
    QString key;     // the key the draft was found under - the one to clearDraft after restoring it
    JsonValue data;
};

// 파일 > 복구's lookup (editorDraft.loadDraftForRecover): the draftKeyFor key first; for a new tab only, then the
// tab id alone - the key new-tab drafts had before the scope prefix existed, so they stay reachable. Read only:
// nothing is written, moved or migrated. An existing article never falls back (that would bring back another
// document saved in the same tab slot). std::nullopt when neither key holds a draft.
std::optional<RecoveredDraft> loadDraftForRecover(IDraftStore &store, const QString &scopeId, const QString &articleId,
                                                  const QString &tabId);

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORDRAFT_H
