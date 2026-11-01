#ifndef CLIENT_QT_UI_WRITERHOST_H
#define CLIENT_QT_UI_WRITERHOST_H

// The writer of one app window (phase 78 step9): it opens an article from the list on the window's editor page and
// binds that page - the text engine (ui::EditorWidget) and the top bar's editor actions - to the article's edit
// controller (ui::EditController). Not a controller: it makes the controller and drives the widgets, as
// shell::AppShell does for the login and the list. The composition root (app/main.cpp) makes one per app window,
// over that window's own Model - the same transport and cookie jar the login and the list use (a second transport
// would hold no session: every edit request would be a 401).
//
// The flow (useWriteController.js openArticle / closeTab, WriterPage.jsx):
//   a double-click on a list row (or the scenario hook) -> openArticle(id): the editor page becomes current FIRST, so
//     the list is left (its stream closes - list.do unmounting for writer.do) before anything is asked; then the
//     controller's open() (getArticle -> lockArticle) and the widget shows the body, read only unless the lock was
//     granted
//   the widget's edits -> commitEdit: typing as serializeBodyFromBlocks (coalescing), an edit operation as serialize;
//     when the renormalized body differs from what the widget shows (two markers, text after the marker) it is pushed
//     back with setBlocks (the web's remount)
//   Ctrl+Z / Ctrl+Shift+Z -> undo / redo; the top bar's [저장] -> save (PUT), [복구] -> recover, [닫기] -> close (unlock)
//     and back to the list page, where the shell re-enters the list (identity check, query, stream)
//   the main window closing -> the surface is closed (unlock - the web's pagehide), without going back to the list
//   autosave -> a single-shot timer, re-armed after every snapshot (never a periodic one - TimerPolicyTest), armed only
//     while the surface is editable and only when the preferences enable it (the web default: off)
// One surface at a time (P5): the list is not on screen while an article is being edited, and a second article is not
// opened over the first.

#include "editor/editordraft.h"
#include "net/newsmodel.h"
#include "ui/editcontroller.h"

#include <QObject>
#include <QPointer>
#include <QString>
#include <QTimer>

#include <memory>

namespace ui {

class EditorWidget;
class MainWindow;

class WriterHost : public QObject
{
    Q_OBJECT

public:
    struct Options {
        AutosaveConfig autosave;          // the web defaults (off) unless the caller says otherwise
        EditController::Clock clock;      // the commit / autosave time
        QString draftScope;               // this process's draft key scope
    };

    // model, drafts: not owned, outlive the host. window: the app window whose editor page and list this host drives;
    // the host is usually its child (destroyed with it, before the Model it talks through).
    WriterHost(net::INewsModel &model, editor::IDraftStore &drafts, MainWindow &window, Options options,
               QObject *parent = nullptr);
    // No request from here (a surface still open is dropped - its lock goes stale on the server): the window's
    // closing, earlier, is the unlock.
    ~WriterHost() override;

    // The surface being edited; null when none is open.
    EditController *surface() const;
    // Opens articleId on the editor page (see the flow above). The surface that is already open is shown again when
    // it is the same article (no second lock - the web's dedup); another article is refused while one is open (null).
    EditController *openArticle(const QString &articleId);
    // Closes the open surface (unlock when it holds the lock) and empties the editor; backToList shows the list page
    // (the shell then re-enters the list). No-op without a surface.
    void closeSurface(bool backToList = true);
    bool autosaveArmed() const;

signals:
    void autosaved();      // an autosave snapshot was written
    void surfaceClosed();

private:
    EditorWidget *editorPage() const;
    void render();
    void showBody();
    void onEdited(editor::EditKind kind);
    void onShortcut(editor::Shortcut shortcut);
    void armAutosave();
    void onAutosaveTimeout();

    net::INewsModel &m_model;
    editor::IDraftStore &m_drafts;
    QPointer<MainWindow> m_window;
    Options m_options;
    std::unique_ptr<EditController> m_surface;
    QTimer m_autosave;
};

} // namespace ui

#endif // CLIENT_QT_UI_WRITERHOST_H
