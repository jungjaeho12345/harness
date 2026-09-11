#ifndef CLIENT_QT_UI_SETUPSCREEN_H
#define CLIENT_QT_UI_SETUPSCREEN_H

// The server address screen (phase 77 step5) - one of the three P4 screens (login, list, setup).
//
// A view: it shows what it is given and emits what the user asked for. Normalising the address,
// probing and saving are the shell's business (shell::AppShell); this widget holds no dependency.

#include <QString>
#include <QWidget>

class QLabel;
class QLineEdit;
class QPushButton;

namespace ui {

class SetupScreen : public QWidget
{
    Q_OBJECT

public:
    // notice: shown verbatim, in the alert colour, when non-empty (the stand-in probe runner's
    // warning in step5).
    explicit SetupScreen(const QString &notice, QWidget *parent = nullptr);

    QString address() const;
    void setAddress(const QString &address);
    void showStatus(const QString &text, bool isError);
    QString statusText() const;
    QString noticeText() const;

signals:
    void saveRequested(const QString &input);
    void probeRequested(const QString &input);

private:
    QLineEdit *m_address = nullptr;
    QPushButton *m_probeButton = nullptr;
    QPushButton *m_saveButton = nullptr;
    QLabel *m_status = nullptr;
    QLabel *m_notice = nullptr;
};

} // namespace ui

#endif // CLIENT_QT_UI_SETUPSCREEN_H
