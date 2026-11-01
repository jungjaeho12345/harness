#include "ui/mainwindow.h"

#include "ui/editorwidget.h"
#include "ui/listscreen.h"
#include "ui/loginscreen.h"
#include "ui/theme.h"

#include <QCloseEvent>
#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
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

    // The editor page's part of the bar (phase 78 step9): the surface's sentence and its three actions, in place of
    // the editor's menu bar (P6). Shown on the editor page only. PlainText: the sentence carries server wording.
    m_editorNotice = new QLabel(topBar);
    m_editorNotice->setObjectName(QStringLiteral("editorNotice"));
    m_editorNotice->setTextFormat(Qt::PlainText);
    m_editorNotice->setStyleSheet(QStringLiteral("color: %1;").arg(QLatin1String(theme::kInk)));
    m_save = new QPushButton(QStringLiteral("저장"), topBar);
    m_save->setObjectName(QStringLiteral("editorSaveButton"));
    m_recover = new QPushButton(QStringLiteral("복구"), topBar);
    m_recover->setObjectName(QStringLiteral("editorRecoverButton"));
    m_closeEditor = new QPushButton(QStringLiteral("닫기"), topBar);
    m_closeEditor->setObjectName(QStringLiteral("editorCloseButton"));
    connect(m_save, &QPushButton::clicked, this, &MainWindow::editorSaveRequested);
    connect(m_recover, &QPushButton::clicked, this, &MainWindow::editorRecoverRequested);
    connect(m_closeEditor, &QPushButton::clicked, this, &MainWindow::editorCloseRequested);
    m_editorNotice->setHidden(true);
    m_save->setHidden(true);
    m_recover->setHidden(true);
    m_closeEditor->setHidden(true);

    bar->addWidget(title);
    bar->addStretch(1);
    bar->addWidget(m_editorNotice);
    bar->addWidget(m_save);
    bar->addWidget(m_recover);
    bar->addWidget(m_closeEditor);
    bar->addWidget(m_status);
    bar->addWidget(m_live);

    // The content pages. The login screen first - an app window always starts logged out (the cookie
    // jar is memory only: decisions (6)). The list screen is the page after login; the editor screen (the text
    // engine) is the page an article is edited on (step9 - ui::WriterHost puts it there).
    m_pages = new QStackedWidget(this);
    m_pages->setObjectName(QStringLiteral("content"));
    m_login = new LoginScreen(m_pages);
    m_list = new ListScreen(m_pages);
    m_editor = new EditorWidget(m_pages);
    m_pages->addWidget(m_login);
    m_pages->addWidget(m_list);
    m_pages->addWidget(m_editor);
    m_pages->setCurrentWidget(m_login);
    // Becoming current = the list page entered; any other change (the login page, the editor page) = it was left.
    connect(m_pages, &QStackedWidget::currentChanged, this, [this](int) {
        const bool onList = m_pages->currentWidget() == m_list;
        const bool onEditor = m_pages->currentWidget() == m_editor;
        m_live->setHidden(!onList);
        m_editorNotice->setHidden(!onEditor);
        m_save->setHidden(!onEditor);
        m_recover->setHidden(!onEditor);
        m_closeEditor->setHidden(!onEditor);
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

EditorWidget *MainWindow::editorWidget() const
{
    return m_editor;
}

void MainWindow::showEditorPage()
{
    m_pages->setCurrentWidget(m_editor);
}

bool MainWindow::editorPageShown() const
{
    return m_pages->currentWidget() == m_editor;
}

void MainWindow::setEditorNotice(const QString &text)
{
    m_editorNotice->setText(text);
}

QString MainWindow::editorNoticeText() const
{
    return m_editorNotice->text();
}

void MainWindow::setEditorActionsEnabled(bool canSave, bool canRecover)
{
    m_save->setEnabled(canSave);
    m_recover->setEnabled(canRecover);
}

bool MainWindow::editorActionsVisible() const
{
    return !m_save->isHidden() && !m_recover->isHidden() && !m_closeEditor->isHidden();
}

void MainWindow::closeEvent(QCloseEvent *event)
{
    emit closing();   // synchronous: the shell saves the bounds before the window goes away
    event->accept();  // a failed save never keeps the window open (R12)
}

} // namespace ui
