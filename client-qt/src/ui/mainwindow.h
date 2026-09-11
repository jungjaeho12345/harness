#ifndef CLIENT_QT_UI_MAINWINDOW_H
#define CLIENT_QT_UI_MAINWINDOW_H

// The main window (phase 77 step5, content pages since step10) - a top bar and a content area with
// two pages: the login card (step10) and the list slot, which stays EMPTY until step11 puts the list
// screen in it. Which page shows is the shell's decision (shell::AppShell); this widget only switches.

#include <QString>
#include <QWidget>

class QCloseEvent;
class QLabel;
class QStackedWidget;

namespace ui {

class LoginScreen;

class MainWindow : public QWidget
{
    Q_OBJECT

public:
    explicit MainWindow(const QString &serverOrigin, QWidget *parent = nullptr);

    QString statusText() const;
    // The top bar's right-hand slot: "server - not logged in" until the server confirms who we are,
    // then the display label (user - department - (role)). Display only - never a permission.
    void setStatusText(const QString &text);
    QString idleStatusText() const;

    LoginScreen *loginScreen() const;
    void showLoginPage();
    void showListPage();  // the list slot - empty in step10, the list screen lands here in step11
    bool loginPageShown() const;
    bool listPageShown() const;

signals:
    // Emitted synchronously from closeEvent(), before the window goes away: the shell saves the
    // bounds here - the one and only write trigger of the window's life (no resize/move hook).
    void closing();

protected:
    void closeEvent(QCloseEvent *event) override;

private:
    QString m_idleStatus;
    QLabel *m_status = nullptr;
    QStackedWidget *m_pages = nullptr;
    LoginScreen *m_login = nullptr;
    QWidget *m_listSlot = nullptr;
};

} // namespace ui

#endif // CLIENT_QT_UI_MAINWINDOW_H
