#include "ui/loginscreen.h"

#include "ui/theme.h"

#include <QFrame>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPushButton>
#include <QVBoxLayout>

namespace ui {
namespace {

// UI_GUIDE: field labels are blue, bold, slightly spaced (the printed-label look).
QLabel *fieldLabel(const QString &text, QWidget *parent)
{
    auto *label = new QLabel(text, parent);
    label->setTextFormat(Qt::PlainText);
    label->setStyleSheet(QStringLiteral("color: %1; font-weight: 700; letter-spacing: 1px;")
                             .arg(QLatin1String(theme::kBlue)));
    return label;
}

} // namespace

LoginScreen::LoginScreen(QWidget *parent) : QWidget(parent)
{
    setObjectName(QStringLiteral("loginScreen"));

    // .yh-card: white, a 1 px blue-tinted border, radius 6 px, padding 2 rem - centred in the page.
    auto *card = new QFrame(this);
    card->setObjectName(QStringLiteral("loginCard"));
    card->setFixedWidth(360);
    card->setStyleSheet(QStringLiteral("QFrame#loginCard { background: #ffffff; border: 1px solid rgba(10,77,166,0.15);"
                                       " border-radius: 6px; }"));

    auto *title = new QLabel(QStringLiteral("기사 작성기 로그인"), card);
    title->setObjectName(QStringLiteral("loginTitle"));
    title->setTextFormat(Qt::PlainText);
    title->setStyleSheet(QStringLiteral("color: %1; font-size: 18px; font-weight: 700; border-left: 3px solid %2;"
                                        " padding-left: %3px;")
                             .arg(QLatin1String(theme::kInk), QLatin1String(theme::kRed))
                             .arg(theme::kSpaceSm));

    m_userId = new QLineEdit(card);
    m_userId->setObjectName(QStringLiteral("userIdEdit"));
    m_userId->setPlaceholderText(QStringLiteral("아이디를 입력하세요"));
    QLabel *userLabel = fieldLabel(QStringLiteral("아이디"), card);
    userLabel->setBuddy(m_userId);

    // Masked. Password mode also turns the input method off for the field (Qt).
    m_password = new QLineEdit(card);
    m_password->setObjectName(QStringLiteral("passwordEdit"));
    m_password->setEchoMode(QLineEdit::Password);
    m_password->setPlaceholderText(QStringLiteral("암호를 입력하세요"));
    QLabel *passwordLabel = fieldLabel(QStringLiteral("암호"), card);
    passwordLabel->setBuddy(m_password);

    // The login CTA: the primary blue button with the serif bold headline look (UI_GUIDE).
    m_submit = new QPushButton(QStringLiteral("로그인"), card);
    m_submit->setObjectName(QStringLiteral("loginButton"));
    m_submit->setDefault(true);
    m_submit->setStyleSheet(QStringLiteral("QPushButton#loginButton { background: %1; color: #ffffff; border: none;"
                                           " border-radius: 3px; padding: %2px %3px;"
                                           " font-family: 'Nanum Myeongjo', 'Noto Serif KR', serif;"
                                           " font-weight: 700; letter-spacing: 1px; }")
                                .arg(QLatin1String(theme::kBlue))
                                .arg(theme::kSpaceSm)
                                .arg(theme::kSpaceMd));

    // The error line: red, the one alert colour (UI_GUIDE). Empty until a login fails.
    // PlainText, not the QLabel default Qt::AutoText: the wording can carry a server-supplied
    // fragment, and a value that looks like markup must be read, not rendered.
    m_error = new QLabel(card);
    m_error->setObjectName(QStringLiteral("loginError"));
    m_error->setTextFormat(Qt::PlainText);
    m_error->setWordWrap(true);
    m_error->setStyleSheet(QStringLiteral("color: %1;").arg(QLatin1String(theme::kRed)));
    m_error->setHidden(true);

    auto *form = new QVBoxLayout(card);
    form->setContentsMargins(theme::kSpaceXl, theme::kSpaceXl, theme::kSpaceXl, theme::kSpaceXl);
    form->setSpacing(theme::kSpaceSm);
    form->addWidget(title);
    form->addSpacing(theme::kSpaceSm);
    form->addWidget(userLabel);
    form->addWidget(m_userId);
    form->addWidget(passwordLabel);
    form->addWidget(m_password);
    form->addSpacing(theme::kSpaceSm);
    form->addWidget(m_submit);
    form->addWidget(m_error);

    auto *page = new QVBoxLayout(this);
    page->addStretch(1);
    auto *row = new QHBoxLayout();
    row->addStretch(1);
    row->addWidget(card);
    row->addStretch(1);
    page->addLayout(row);
    page->addStretch(2);

    connect(m_submit, &QPushButton::clicked, this, &LoginScreen::submit);
    connect(m_userId, &QLineEdit::returnPressed, this, &LoginScreen::submit);
    connect(m_password, &QLineEdit::returnPressed, this, &LoginScreen::submit);
}

void LoginScreen::submit()
{
    // Handed over once, then gone from the screen: nothing here keeps a credential.
    const QString password = m_password->text();
    m_password->clear();
    clearError();
    emit loginRequested(m_userId->text(), password);
}

void LoginScreen::showError(const QString &message)
{
    m_error->setText(message);
    m_error->setHidden(message.isEmpty());
}

void LoginScreen::clearError()
{
    showError(QString());
}

QString LoginScreen::errorText() const
{
    return m_error->text();
}

} // namespace ui
