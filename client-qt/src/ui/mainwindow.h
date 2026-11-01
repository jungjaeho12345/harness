#ifndef CLIENT_QT_UI_MAINWINDOW_H
#define CLIENT_QT_UI_MAINWINDOW_H

// The main window (phase 77 step5, content pages since step10, the list since step11) - a window SHELL,
// not a screen (client-qt/README.md 「화면」): a 48 px top bar and a content area whose pages are the
// login screen (step10), the list screen (step11) and - since phase 78 step9 - the editor screen (the text
// engine, ui::EditorWidget). Which page shows is the shell's decision (shell::AppShell for login / list,
// ui::WriterHost for the editor); this widget only switches and says so.
//
// The top bar (docs/UI_GUIDE.md .yh-topbar): the title on the left; on the right the user slot
// ("server - not logged in", then the server's display label - never a permission) and, on the list
// page only, the live indicator (the change stream's real state: connected / dropped). On the editor page
// only (step9): the surface's sentence and its three actions - [저장] [복구] [닫기] - in place of a menu bar
// (the editor's menus and dialogs are P6's; P5 has no dialog window at all).

#include <QString>
#include <QWidget>

class QCloseEvent;
class QLabel;
class QPushButton;
class QStackedWidget;

namespace ui {

class EditorWidget;
class ListScreen;
class LoginScreen;

class MainWindow : public QWidget
{
    Q_OBJECT

public:
    explicit MainWindow(const QString &serverOrigin, QWidget *parent = nullptr);
    ~MainWindow() override;

    QString statusText() const;
    // The top bar's right-hand slot: "server - not logged in" until the server confirms who we are,
    // then the display label (user - department - (role)). Display only - never a permission.
    void setStatusText(const QString &text);
    QString idleStatusText() const;

    // The live indicator: shown on the list page only.
    void setLiveStatus(bool connected);
    QString liveStatusText() const;
    bool liveStatusVisible() const;

    LoginScreen *loginScreen() const;
    ListScreen *listScreen() const;
    EditorWidget *editorWidget() const;
    void showLoginPage();
    void showListPage();
    void showEditorPage();
    bool loginPageShown() const;
    bool listPageShown() const;
    bool editorPageShown() const;

    // The editor page's part of the top bar (step9) - shown on the editor page only. The sentence is plain text (it
    // carries server wording); the two flags enable [저장] and [복구] ([닫기] is always there).
    void setEditorNotice(const QString &text);
    QString editorNoticeText() const;
    void setEditorActionsEnabled(bool canSave, bool canRecover);
    bool editorActionsVisible() const;

signals:
    // Emitted synchronously from closeEvent(), before the window goes away: the shell saves the
    // bounds here - the one and only write trigger of the window's life (no resize/move hook).
    void closing();
    // The list page became / stopped being the current page - however it happened. The shell enters
    // and leaves the list on these (the web's ListPage mount / unmount): the list page is never on
    // screen without the list controller having entered.
    void listPageEntered();
    void listPageLeft();
    // The editor page's three actions (step9) - the writer host acts on them.
    void editorSaveRequested();
    void editorRecoverRequested();
    void editorCloseRequested();

protected:
    void closeEvent(QCloseEvent *event) override;

private:
    QString m_idleStatus;
    QLabel *m_status = nullptr;
    QLabel *m_live = nullptr;
    QStackedWidget *m_pages = nullptr;
    LoginScreen *m_login = nullptr;
    ListScreen *m_list = nullptr;
    EditorWidget *m_editor = nullptr;
    QLabel *m_editorNotice = nullptr;
    QPushButton *m_save = nullptr;
    QPushButton *m_recover = nullptr;
    QPushButton *m_closeEditor = nullptr;
};

} // namespace ui

#endif // CLIENT_QT_UI_MAINWINDOW_H
