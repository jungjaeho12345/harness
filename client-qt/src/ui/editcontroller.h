#ifndef CLIENT_QT_UI_EDITCONTROLLER_H
#define CLIENT_QT_UI_EDITCONTROLLER_H

// The edit state machine of ONE editing surface (phase 78 step9) - the Qt counterpart of the edit-tab half of
// web/src/controller/useWriteController.js (openArticle, save, closeTab) and of the body state WriterPage.jsx keeps
// for a tab (commitBody, undo / redo, File > Recover, the autosave snapshot). ADR-003 / decisions (7): it knows the
// Model interface, the draft store and an injected clock - no widget type, no transport, no timer - so every rule
// below is tested on FakeNewsModel without a server or a window (tests/editcontrollertest.cpp).
//
// The rules this file exists for:
//   1. ONE SURFACE = ONE EditClientId (decisions (3)). The id is a member: issued when the controller is made, gone
//      with it. This surface's lock, save and unlock carry it (the Model's clientId argument - the transport puts it
//      in x-edit-client on exactly those three routes, routetable.cpp), and nothing else ever sees it: not the
//      fields, not a draft, not a notice, not a log. Two surfaces never share one - the server keys the lock by
//      (userId, clientId), so a shared id lets two surfaces on one article both hold the lock and both PUT.
//   2. NO EDITING WITHOUT THE LOCK (fail closed - useWriteController.js:285-291). open() is getArticle THEN
//      lockArticle, and only a lock answer that is ok:true makes the surface editable. Any other answer leaves it
//      read only with the web's sentence (lockMessages.js); a read-only surface never PUTs and never unlocks. A body
//      that could not be loaded is never locked: the web falls back to the list row there (which carries no body),
//      so a save would write an empty body over the article - not ported.
//   3. THE SERVER SAYS WHO WE ARE (decisions (3), override L123-128). No role, no identity, no user name is read or
//      kept here. A 401 unauthenticated on any call ends this surface's session: read only, no further request (not
//      even the unlock); closing it sends the user back through the list's identity check. A 401 "locked" on the
//      lock is an edit-lock conflict (the transport's EditLockConflict) - the session is fine.
//   4. ONE CAPTURE POINT FOR THE BODY (WriterPage.commitBody). A commit sets the body, re-derives the title
//      (writerbody.h bodyTitle) and pushes the history with coalesce = typing && the previous commit was typing &&
//      now - its time < 500 ms (COALESCE_MS), limit 100 (HISTORY_LIMIT). The last-commit mark moves on every commit,
//      a no-op push included. Undo / redo write the body WITHOUT a capture (the web's applyingHistoryRef). The
//      baseline is the body exactly as loaded (the web's lazy seed) - not re-serialized: a legacy plain-text body
//      makes the first edit its own undo step.
//
// Left out on purpose (index.json excluded / step9 scope): surfaces without an article (new articles - so there is
// no POST path at all), the mapping mode, submit (send / hold / KILL, and with it the draft clear on success), the
// writer's change-stream subscription that closes a surface on a force-unlock or when another user takes the lock
// over (P7), the identity fallback for an article without an author (it needs the user's name, which is not kept
// here - see fieldsFromArticle).

#include "editor/editordraft.h"
#include "editor/editorhistory.h"
#include "editor/editorinput.h"
#include "net/editclientid.h"
#include "net/newsmodel.h"

#include <QJsonObject>
#include <QObject>
#include <QString>
#include <QtGlobal>

#include <functional>

namespace ui {

// WriterPage.jsx COALESCE_MS / HISTORY_LIMIT.
inline constexpr qint64 kCoalesceMs = 500;
inline constexpr int kHistoryLimit = 100;

// The lock action of an edit entry (useWriteController.js:281 - 'revise' unless portalRevise; P5 opens edits only).
QString editLockAction();

// The autosave preferences (web/src/view/editorPrefs.js DEFAULT_EDITOR_PREFS.autosave). The preferences dialog that
// changes them is P6's - P5 runs the web defaults: off.
struct AutosaveConfig {
    bool enabled = false;
    int intervalSec = 60;
    int retentionDays = 1;
};

// The sentence for a lock that was not granted (web/src/controller/lockMessages.js lockFailMessage): six known tokens,
// the default sentence for an empty / null reason, and the default + " (<reason>)" for any other token.
QString lockFailMessage(const QString &reason);

// The editable fields of a surface (useWriteController.js fieldsFromArticle): every EDITABLE_FIELDS key
// (= editor::DRAFT_FIELDS) as the article holds it - "" where it holds null or nothing - and body = markupVersion ??
// body ?? content ?? "". `article` is the getArticle answer's article merged with its contents (contents winning, as
// the web's spread does). The web's author fallback (the logged-in user's name) is not ported: no identity is kept
// here, so an article without an author keeps "" (index.json step9 summary).
QJsonObject fieldsFromArticle(const QJsonObject &article);

// The PUT dto (useWriteController.js toSaveDto): the fields without body, the body as markupVersion - the key the
// server stores (a body key is dropped there and the text lost) - and the articleId. Never a role, never a client id
// (it rides in the header), never a lock field.
QJsonObject toSaveDto(const QJsonObject &fields, const QString &articleId);

// What an autosave stores (WriterPage's {...tab.fields}): the string values of editor::DRAFT_FIELDS, in that order.
editor::JsonValue draftDataFrom(const QJsonObject &fields);

enum class EditState {
    Opening,      // made; open() has not run
    Editing,      // the body is loaded and this surface holds the lock
    LockRefused,  // the body is loaded, the lock was not granted: read only, with the reason's sentence
    LoadFailed,   // the article could not be loaded: nothing to show, no lock asked
    SessionEnded, // a 401 unauthenticated: read only, no further request
    Closed        // close() ran
};
QString editStateName(EditState state);  // ASCII - safe for a log line

class EditController : public QObject
{
    Q_OBJECT

public:
    using Clock = std::function<qint64()>;

    // model, drafts: not owned, outlive the controller. clock: the time of a commit and of an autosave (ms since the
    // epoch). draftScope: this process's draft key scope (editor::draftKeyFor - it only matters for a surface
    // without an article, which P5 never opens).
    EditController(net::INewsModel &model, editor::IDraftStore &drafts, Clock clock, const QString &draftScope,
                   QObject *parent = nullptr);
    // No request from here: a surface that was never closed keeps its lock until the server finds it stale (the
    // writer host closes every surface it opens - close() is the one unlock).
    ~EditController() override;

    // getArticle, then lockArticle(articleId, 'revise', this surface's id). Runs once; an empty articleId is refused
    // (P5 opens existing articles only). Returns the state it reached.
    EditState open(const QString &articleId);

    EditState state() const;
    bool editable() const;  // state() == Editing
    QString articleId() const;
    QString body() const;   // the saved-markup string the surface holds now
    QString title() const;
    QJsonObject fields() const;
    QString notice() const;  // the sentence the screen shows; empty when there is nothing to say
    const editor::History &history() const;

    // An edit the view already shows (EditorWidget::edited): body = what it saves as (typing: serializeBodyFromBlocks,
    // an edit operation: serialize). Typing may coalesce. false = refused (not editing). No bodyReplaced.
    bool commitEdit(const QString &body, editor::EditKind kind);
    // An edit made outside the view (the scenario hook): committed exactly like commitEdit, then bodyReplaced so the
    // view shows it.
    bool applyEdit(const QString &body, editor::EditKind kind);
    // One snapshot back / forward, applied without a capture. false = nothing to do or not editing.
    bool undo();
    bool redo();
    // File > Save of an existing article: PUT through the Model with this surface's id - only while editing (no
    // request otherwise). true = the server said ok. The draft stays (the web clears it on submit only).
    bool save();
    // File > Recover (WriterPage.jsx): the latest draft back - body as ONE undo step, title re-derived from it, the
    // other editable fields as stored - and that draft cleared under the key it was found at. false = not editing or
    // nothing to recover (the notice says which).
    bool recover();
    // One autosave snapshot (the writer host's timer calls it): the fields under draftKeyFor, then expireDrafts with
    // the same now. Skipped when the body and the title are both empty, and when not editing. true = a draft written.
    bool autosave(int retentionDays);
    // The surface is over: unlockArticle with this surface's id when it holds the lock (the answer is not waited on
    // for anything - the web's fire-and-forget), nothing otherwise. Idempotent.
    void close();

signals:
    void stateChanged();
    void bodyReplaced();  // undo / redo / recover / applyEdit wrote body() - the view shows it again
    void noticeChanged();

private:
    struct LastCommit {
        qint64 at = 0;
        bool wasTyping = false;
    };

    EditState enter(EditState state, const QString &notice);
    void setNotice(const QString &notice);
    void commitBody(const QString &body, bool typing);
    void writeBody(const QString &body);
    bool endedBy(const net::ModelResult &result);

    net::INewsModel &m_model;
    editor::IDraftStore &m_drafts;
    Clock m_clock;
    const QString m_draftScope;
    const QString m_tabId;
    const net::EditClientId m_clientId;  // THIS surface's - issued with it, gone with it
    EditState m_state = EditState::Opening;
    QString m_articleId;
    QJsonObject m_fields;
    editor::History m_history;
    LastCommit m_last;
    QString m_notice;
};

} // namespace ui

#endif // CLIENT_QT_UI_EDITCONTROLLER_H
