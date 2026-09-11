#include "ui/mainwindow.h"

#include "ui/loginscreen.h"
#include "ui/theme.h"

#include <QCloseEvent>
#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QStackedWidget>
#include <QVBoxLayout>

namespace ui {

MainWindow::MainWindow(const QString &serverOrigin, QWidget *parent)
    : QWidget(parent), m_idleStatus(QStringLiteral("서버 %1 · 로그인 전").arg(serverOrigin))
{
    setWindowTitle(QStringLiteral("기사작성기"));

    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->setSpacing(0);

    // .yh-topbar: 48 px, title on the left, the user/status slot on the right, a blue rule below.
    auto *topBar = new QFrame(this);
    topBar->setObjectName(QStringLiteral("topBar"));
    topBar->setFixedHeight(theme::kTopBarHeight);
    topBar->setStyleSheet(QStringLiteral("QFrame#topBar { background: #ffffff; border-bottom: 2px solid %1; }")
                              .arg(QLatin1String(theme::kBlue)));
    auto *bar = new QHBoxLayout(topBar);
    bar->setContentsMargins(theme::kSpaceLg, 0, theme::kSpaceLg, 0);
    bar->setSpacing(theme::kSpaceMd);

    auto *title = new QLabel(QStringLiteral("기사작성기"), topBar);
    title->setObjectName(QStringLiteral("titleLabel"));
    title->setStyleSheet(QStringLiteral("color: %1; font-size: 16px; font-weight: 700;")
                             .arg(QLatin1String(theme::kInk)));

    // The status slot: "user - department - (role)" once the server has confirmed the session.
    m_status = new QLabel(m_idleStatus, topBar);
    m_status->setObjectName(QStringLiteral("statusLabel"));
    m_status->setStyleSheet(QStringLiteral("color: %1;").arg(QLatin1String(theme::kInk)));

    bar->addWidget(title);
    bar->addStretch(1);
    bar->addWidget(m_status);

    // The content pages. The login card first - an app window always starts logged out (the cookie
    // jar is memory only: decisions (6)).
    m_pages = new QStackedWidget(this);
    m_pages->setObjectName(QStringLiteral("content"));
    m_login = new LoginScreen(m_pages);
    m_listSlot = new QWidget(m_pages);
    m_listSlot->setObjectName(QStringLiteral("listSlot"));  // empty on purpose until step11
    m_pages->addWidget(m_login);
    m_pages->addWidget(m_listSlot);
    m_pages->setCurrentWidget(m_login);

    layout->addWidget(topBar);
    layout->addWidget(m_pages, 1);
}

QString MainWindow::statusText() const
{
    return m_status->text();
}

void MainWindow::setStatusText(const QString &text)
{
    m_status->setText(text);
}

QString MainWindow::idleStatusText() const
{
    return m_idleStatus;
}

LoginScreen *MainWindow::loginScreen() const
{
    return m_login;
}

void MainWindow::showLoginPage()
{
    m_pages->setCurrentWidget(m_login);
}

void MainWindow::showListPage()
{
    m_pages->setCurrentWidget(m_listSlot);
}

bool MainWindow::loginPageShown() const
{
    return m_pages->currentWidget() == m_login;
}

bool MainWindow::listPageShown() const
{
    return m_pages->currentWidget() == m_listSlot;
}

void MainWindow::closeEvent(QCloseEvent *event)
{
    emit closing();   // synchronous: the shell saves the bounds before the window goes away
    event->accept();  // a failed save never keeps the window open (R12)
}

} // namespace ui
