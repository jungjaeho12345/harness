#include "ui/mainwindow.h"

#include "ui/theme.h"

#include <QCloseEvent>
#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QVBoxLayout>

namespace ui {

MainWindow::MainWindow(const QString &serverOrigin, QWidget *parent) : QWidget(parent)
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

    // The status slot. step10 puts "user - department - (role)" and the live state here.
    m_status = new QLabel(QStringLiteral("서버 %1 · 로그인 전").arg(serverOrigin), topBar);
    m_status->setObjectName(QStringLiteral("statusLabel"));
    m_status->setStyleSheet(QStringLiteral("color: %1;").arg(QLatin1String(theme::kInk)));

    bar->addWidget(title);
    bar->addStretch(1);
    bar->addWidget(m_status);

    // Empty on purpose: the login (step10) and list (step11) screens land here.
    auto *content = new QWidget(this);
    content->setObjectName(QStringLiteral("content"));

    layout->addWidget(topBar);
    layout->addWidget(content, 1);
}

QString MainWindow::statusText() const
{
    return m_status->text();
}

void MainWindow::closeEvent(QCloseEvent *event)
{
    emit closing();   // synchronous: the shell saves the bounds before the window goes away
    event->accept();  // a failed save never keeps the window open (R12)
}

} // namespace ui
