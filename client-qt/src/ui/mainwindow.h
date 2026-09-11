#ifndef CLIENT_QT_UI_MAINWINDOW_H
#define CLIENT_QT_UI_MAINWINDOW_H

// The main window (phase 77 step5, content pages since step10, the list since step11) - a window SHELL,
// not a screen (client-qt/README.md 「화면」): a 48 px top bar and a content area whose two pages are the
// login screen (step10) and the list screen (step11). Which page shows is the shell's decision
// (shell::AppShell); this widget only switches and says so.
//
// The top bar (docs/UI_GUIDE.md .yh-topbar): the title on the left; on the right the user slot
// ("server - not logged in", then the server's display label - never a permission) and, on the list
// page only, the live indicator (the change stream's real state: connected / dropped).

#include <QString>
#include <QWidget>

class QCloseEvent;
class QLabel;
class QStackedWidget;

namespace ui {

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
    void showLoginPage();
    void showListPage();
    bool loginPageShown() const;
    bool listPageShown() const;

signals:
    // Emitted synchronously from closeEvent(), before the window goes away: the shell saves the
    // bounds here - the one and only write trigger of the window's life (no resize/move hook).
    void closing();
    // The list page became / stopped being the current page - however it happened. The shell enters
    // and leaves the list on these (the web's ListPage mount / unmount): the list page is never on
    // screen without the list controller having entered.
    void listPageEntered();
    void listPageLeft();

protected:
    void closeEvent(QCloseEvent *event) override;

private:
    QString m_idleStatus;
    QLabel *m_status = nullptr;
    QLabel *m_live = nullptr;
    QStackedWidget *m_pages = nullptr;
    LoginScreen *m_login = nullptr;
    ListScreen *m_list = nullptr;
};

} // namespace ui

#endif // CLIENT_QT_UI_MAINWINDOW_H
