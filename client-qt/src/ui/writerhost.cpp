#include "ui/writerhost.h"

#include "editor/editorcontent.h"
#include "editor/editornewline.h"
#include "editor/writerbody.h"
#include "ui/editorwidget.h"
#include "ui/listscreen.h"
#include "ui/mainwindow.h"

#include <QVector>
#include <QtGlobal>

#include <utility>

namespace ui {

WriterHost::WriterHost(net::INewsModel &model, editor::IDraftStore &drafts, MainWindow &window, Options options,
                       QObject *parent)
    : QObject(parent), m_model(model), m_drafts(drafts), m_window(&window), m_options(std::move(options))
{
    // One shot at a time, re-armed after each snapshot (WriterPage's setInterval, without a periodic timer).
    m_autosave.setSingleShot(true);
    connect(&m_autosave, &QTimer::timeout, this, &WriterHost::onAutosaveTimeout);

    connect(window.listScreen(), &ListScreen::articleOpenRequested, this,
            [this](const QString &articleId) { openArticle(articleId); });
    connect(&window, &MainWindow::editorSaveRequested, this, [this] {
        if (m_surface)
            m_surface->save();
    });
    connect(&window, &MainWindow::editorRecoverRequested, this, [this] {
        if (m_surface)
            m_surface->recover();
    });
    connect(&window, &MainWindow::editorCloseRequested, this, [this] { closeSurface(true); });
    // The web's pagehide: the window going away unlocks the open surface - and does not re-enter the list.
    connect(&window, &MainWindow::closing, this, [this] { closeSurface(false); });
    if (EditorWidget *widget = window.editorWidget()) {
        connect(widget, &EditorWidget::edited, this, &WriterHost::onEdited);
        connect(widget, &EditorWidget::shortcutTriggered, this, &WriterHost::onShortcut);
        widget->setReadOnly(true);  // nothing is editable until a surface holds a lock
    }
}

WriterHost::~WriterHost()
{
    m_autosave.stop();
    // No request (the header): a surface still open here is dropped as it is.
}

EditController *WriterHost::surface() const
{
    return m_surface.get();
}

EditController *WriterHost::openArticle(const QString &articleId)
{
    if (!m_window || articleId.isEmpty())
        return nullptr;
    if (m_surface) {
        if (m_surface->articleId() != articleId)
            return nullptr;  // one surface at a time
        m_window->showEditorPage();
        return m_surface.get();  // the same article: shown again, no second lock (useWriteController.js dedup)
    }

    m_surface = std::make_unique<EditController>(m_model, m_drafts, m_options.clock, m_options.draftScope);
    EditController *surface = m_surface.get();
    connect(surface, &EditController::stateChanged, this, &WriterHost::render);
    connect(surface, &EditController::noticeChanged, this, &WriterHost::render);
    connect(surface, &EditController::bodyReplaced, this, &WriterHost::showBody);

    // The editor page FIRST: the list is left - its stream closes - before anything is asked, as list.do unmounts
    // for writer.do. Until the controller has an answer the editor shows nothing and takes nothing.
    if (EditorWidget *widget = editorPage()) {
        widget->setReadOnly(true);
        widget->setBlocks({});
    }
    m_window->setEditorNotice(QString());
    m_window->setEditorActionsEnabled(false, false);
    m_window->showEditorPage();

    surface->open(articleId);  // getArticle -> lockArticle
    showBody();
    render();
    armAutosave();
    if (EditorWidget *widget = editorPage(); widget && surface->editable())
        widget->setFocus(Qt::OtherFocusReason);  // the keys go to the text, not to the list table left behind
    return surface;
}

void WriterHost::closeSurface(bool backToList)
{
    if (!m_surface)
        return;
    m_autosave.stop();
    std::unique_ptr<EditController> surface = std::move(m_surface);
    disconnect(surface.get(), nullptr, this, nullptr);
    surface->close();  // the unlock, when this surface holds the lock
    if (EditorWidget *widget = editorPage()) {
        widget->setReadOnly(true);
        widget->setBlocks({});  // no text of the closed article stays behind
    }
    if (m_window) {
        m_window->setEditorNotice(QString());
        m_window->setEditorActionsEnabled(false, false);
        if (backToList && m_window->editorPageShown())
            m_window->showListPage();  // the shell re-enters the list there (identity check, query, stream)
    }
    surface.reset();  // its EditClientId goes with it
    emit surfaceClosed();
}

bool WriterHost::autosaveArmed() const
{
    return m_autosave.isActive();
}

EditorWidget *WriterHost::editorPage() const
{
    return m_window ? m_window->editorWidget() : nullptr;
}

void WriterHost::render()
{
    if (!m_surface || !m_window)
        return;
    const bool editable = m_surface->editable();
    if (EditorWidget *widget = editorPage())
        widget->setReadOnly(!editable);
    m_window->setEditorNotice(m_surface->notice());
    m_window->setEditorActionsEnabled(editable, editable);
    if (!editable)
        m_autosave.stop();
}

void WriterHost::showBody()
{
    EditorWidget *widget = editorPage();
    if (widget && m_surface)
        widget->setBlocks(editor::deserialize(m_surface->body()));
}

void WriterHost::onEdited(editor::EditKind kind)
{
    EditorWidget *widget = editorPage();
    if (!m_surface || !widget)
        return;
    const QVector<editor::Block> shown = widget->blocks();
    if (kind != editor::EditKind::Typing) {
        m_surface->commitEdit(editor::serialize(shown), kind);  // an edit operation: its own blocks (WriterPage)
        return;
    }
    // Typing (step8 (b)(c)): saved as serializeBodyFromBlocks (the one spelling - the scenario edit uses it too); when its
    // renormalization moved a marker the widget is handed the renormalized blocks (the web's remount) - edited() is
    // never sent while composing, so this setBlocks cannot break a composition.
    m_surface->commitEdit(editor::serializeBodyFromBlocks(shown), kind);
    const QVector<editor::Block> fixed = editor::renormalizeEndMarker(shown);
    if (fixed != shown)
        widget->setBlocks(fixed);
}

void WriterHost::onShortcut(editor::Shortcut shortcut)
{
    if (!m_surface)
        return;
    // Undo / redo are the controller's (the widget only reports them); the others are the widget's own edits (they
    // come back as edited()) or P6 features.
    if (shortcut == editor::Shortcut::Undo)
        m_surface->undo();
    else if (shortcut == editor::Shortcut::Redo)
        m_surface->redo();
}

void WriterHost::armAutosave()
{
    const AutosaveConfig &config = m_options.autosave;
    if (m_surface && m_surface->editable() && config.enabled)
        m_autosave.start(qMax(1, config.intervalSec) * 1000);
    else
        m_autosave.stop();
}

void WriterHost::onAutosaveTimeout()
{
    if (!m_surface || !m_surface->editable())
        return;
    if (m_surface->autosave(m_options.autosave.retentionDays))
        emit autosaved();
    armAutosave();  // the next single shot (a slot of autosaved() may have closed the surface - then none)
}

} // namespace ui
