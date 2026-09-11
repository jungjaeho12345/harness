#include "ui/mainwindow.h"

#include "ui/listscreen.h"
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
    title->setTextFormat(Qt::PlainText);
    title->setStyleSheet(QStringLiteral("color: %1; font-size: 16px; font-weight: 700;")
                             .arg(QLatin1String(theme::kInk)));

    // The status slot: "user - department - (role)" once the server has confirmed the session.
    // PlainText, not the QLabel default Qt::AutoText: the line is assembled from the server's
    // userId/department/role (logincontroller.cpp identityLabelFrom), and AutoText would guess a
    // value that looks like markup into markup. It is text to read, never a document to render.
    m_status = new QLabel(m_idleStatus, topBar);
    m_status->setObjectName(QStringLiteral("statusLabel"));
    m_status->setTextFormat(Qt::PlainText);
    m_status->setStyleSheet(QStringLiteral("color: %1;").arg(QLatin1String(theme::kInk)));

    // The live indicator (.yh-live): red dot = the change stream is connected, grey = dropped.
    // The one rich-text label in the client - its markup is the colour constant written below,
    // and nothing from the network reaches it.
    m_live = new QLabel(topBar);
    m_live->setObjectName(QStringLiteral("liveLabel"));
    m_live->setTextFormat(Qt::RichText);
    m_live->setHidden(true);

    bar->addWidget(title);
    bar->addStretch(1);
    bar->addWidget(m_status);
    bar->addWidget(m_live);

    // The content pages. The login screen first - an app window always starts logged out (the cookie
    // jar is memory only: decisions (6)). The list screen is the page after login.
    m_pages = new QStackedWidget(this);
    m_pages->setObjectName(QStringLiteral("content"));
    m_login = new LoginScreen(m_pages);
    m_list = new ListScreen(m_pages);
    m_pages->addWidget(m_login);
    m_pages->addWidget(m_list);
    m_pages->setCurrentWidget(m_login);
    // Two pages: becoming current = the list page entered; any other change = it was left.
    connect(m_pages, &QStackedWidget::currentChanged, this, [this](int) {
        const bool onList = m_pages->currentWidget() == m_list;
        m_live->setHidden(!onList);
        if (onList)
            emit listPageEntered();
        else
            emit listPageLeft();
    });
    setLiveStatus(false);

    layout->addWidget(topBar);
    layout->addWidget(m_pages, 1);
}

MainWindow::~MainWindow()
{
    // The pages go with this window; their removal must not read as "the list page was left" to whoever
    // listens (the shell's controllers may be on their way out too).
    disconnect(m_pages, nullptr, this, nullptr);
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

void MainWindow::setLiveStatus(bool connected)
{
    // ListPage.jsx live-status: '실시간' / '연결 끊김', the same two titles.
    const QString dot = QLatin1String(connected ? theme::kRed : theme::kGrayMid);
    m_live->setText(QStringLiteral("<span style=\"color:%1\">&#9679;</span> %2")
                        .arg(dot, connected ? QStringLiteral("실시간") : QStringLiteral("연결 끊김")));
    m_live->setToolTip(connected ? QStringLiteral("실시간 연결됨") : QStringLiteral("실시간 연결 끊김 — 자동 재연결 시도 중"));
}

QString MainWindow::liveStatusText() const
{
    return m_live->text();
}

bool MainWindow::liveStatusVisible() const
{
    return !m_live->isHidden();
}

LoginScreen *MainWindow::loginScreen() const
{
    return m_login;
}

ListScreen *MainWindow::listScreen() const
{
    return m_list;
}

void MainWindow::showLoginPage()
{
    m_pages->setCurrentWidget(m_login);
}

void MainWindow::showListPage()
{
    m_pages->setCurrentWidget(m_list);
}

bool MainWindow::loginPageShown() const
{
    return m_pages->currentWidget() == m_login;
}

bool MainWindow::listPageShown() const
{
    return m_pages->currentWidget() == m_list;
}

void MainWindow::closeEvent(QCloseEvent *event)
{
    emit closing();   // synchronous: the shell saves the bounds before the window goes away
    event->accept();  // a failed save never keeps the window open (R12)
}

} // namespace ui
