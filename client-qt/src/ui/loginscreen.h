#ifndef CLIENT_QT_UI_LOGINSCREEN_H
#define CLIENT_QT_UI_LOGINSCREEN_H

// The login card (phase 77 step10 C) - one of the three P4 screens (login, list, setup). It lives in
// the main window's content area (ui::MainWindow).
//
// A view: it shows what it is given and emits what the user asked for. It holds no Model and no
// controller; the shell wires loginRequested to ui::LoginController::login. The password field is
// masked, the password is handed over once and the field is cleared right away - the screen keeps no
// credential and writes nothing anywhere (docs/UI_GUIDE.md login card: blue labels, a serif bold CTA,
// red for the error line only).

#include <QString>
#include <QWidget>

class QLabel;
class QLineEdit;
class QPushButton;

namespace ui {

class LoginScreen : public QWidget
{
    Q_OBJECT

public:
    explicit LoginScreen(QWidget *parent = nullptr);

    void showError(const QString &message);
    void clearError();
    QString errorText() const;

signals:
    void loginRequested(const QString &userId, const QString &password);

private:
    void submit();

    QLineEdit *m_userId = nullptr;
    QLineEdit *m_password = nullptr;
    QPushButton *m_submit = nullptr;
    QLabel *m_error = nullptr;
};

} // namespace ui

#endif // CLIENT_QT_UI_LOGINSCREEN_H
