#include "ui/setupscreen.h"

#include "ui/theme.h"

#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QVBoxLayout>

namespace ui {

SetupScreen::SetupScreen(const QString &notice, QWidget *parent) : QWidget(parent)
{
    setWindowTitle(QStringLiteral("기사작성기 — 서버 주소"));

    auto *layout = new QVBoxLayout(this);
    layout->setContentsMargins(theme::kSpaceXl, theme::kSpaceXl, theme::kSpaceXl, theme::kSpaceXl);
    layout->setSpacing(theme::kSpaceSm);

    auto *title = new QLabel(QStringLiteral("서버 주소 설정"), this);
    title->setObjectName(QStringLiteral("titleLabel"));
    title->setTextFormat(Qt::PlainText);
    title->setStyleSheet(QStringLiteral("color: %1; font-size: 16px; font-weight: 700;").arg(QLatin1String(theme::kInk)));

    // UI_GUIDE: field labels are blue, bold, slightly spaced (the printed-label look).
    auto *label = new QLabel(QStringLiteral("서버 주소"), this);
    label->setTextFormat(Qt::PlainText);
    label->setStyleSheet(QStringLiteral("color: %1; font-weight: 700; letter-spacing: 1px;")
                             .arg(QLatin1String(theme::kBlue)));

    m_address = new QLineEdit(this);
    m_address->setObjectName(QStringLiteral("addressEdit"));
    m_address->setPlaceholderText(QStringLiteral("예: 192.168.0.10:3001"));
    label->setBuddy(m_address);

    m_probeButton = new QPushButton(QStringLiteral("연결 확인"), this);
    m_probeButton->setObjectName(QStringLiteral("probeButton"));
    m_saveButton = new QPushButton(QStringLiteral("저장"), this);
    m_saveButton->setObjectName(QStringLiteral("saveButton"));
    auto *buttons = new QHBoxLayout();
    buttons->setSpacing(theme::kSpaceSm);
    buttons->addWidget(m_probeButton);
    buttons->addWidget(m_saveButton);
    buttons->addStretch(1);

    // PlainText, not the QLabel default Qt::AutoText: the status line repeats the address the
    // user typed and what the probe found, so a value that looks like markup is shown as typed.
    m_status = new QLabel(this);
    m_status->setObjectName(QStringLiteral("statusLabel"));
    m_status->setTextFormat(Qt::PlainText);
    m_status->setWordWrap(true);

    // The stand-in warning sits on the screen itself, in the alert colour, for as long as the
    // injected runner reports one (step5.md A - never pretend the check happened).
    m_notice = new QLabel(notice, this);
    m_notice->setObjectName(QStringLiteral("noticeLabel"));
    m_notice->setTextFormat(Qt::PlainText);
    m_notice->setWordWrap(true);
    m_notice->setStyleSheet(QStringLiteral("color: %1; border-left: 3px solid %1; padding-left: %2px;")
                                .arg(QLatin1String(theme::kRed))
                                .arg(theme::kSpaceSm));
    m_notice->setHidden(notice.isEmpty());

    layout->addWidget(title);
    layout->addSpacing(theme::kSpaceSm);
    layout->addWidget(label);
    layout->addWidget(m_address);
    layout->addLayout(buttons);
    layout->addWidget(m_status);
    layout->addStretch(1);
    layout->addWidget(m_notice);

    connect(m_probeButton, &QPushButton::clicked, this, [this] { emit probeRequested(m_address->text()); });
    connect(m_saveButton, &QPushButton::clicked, this, [this] { emit saveRequested(m_address->text()); });
}

QString SetupScreen::address() const
{
    return m_address->text();
}

void SetupScreen::setAddress(const QString &address)
{
    m_address->setText(address);
}

void SetupScreen::showStatus(const QString &text, bool isError)
{
    m_status->setText(text);
    m_status->setStyleSheet(QStringLiteral("color: %1;")
                                .arg(QLatin1String(isError ? theme::kRed : theme::kInk)));
}

QString SetupScreen::statusText() const
{
    return m_status->text();
}

QString SetupScreen::noticeText() const
{
    return m_notice->text();
}

} // namespace ui
