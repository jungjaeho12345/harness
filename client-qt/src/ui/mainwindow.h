#ifndef CLIENT_QT_UI_MAINWINDOW_H
#define CLIENT_QT_UI_MAINWINDOW_H

// The main window (phase 77 step5) - an empty frame: a top bar slot and a status slot. The login
// and list screens are step10/step11's and land in the content area; nothing is drawn there yet.

#include <QString>
#include <QWidget>

class QCloseEvent;
class QLabel;

namespace ui {

class MainWindow : public QWidget
{
    Q_OBJECT

public:
    explicit MainWindow(const QString &serverOrigin, QWidget *parent = nullptr);

    QString statusText() const;

signals:
    // Emitted synchronously from closeEvent(), before the window goes away: the shell saves the
    // bounds here - the one and only write trigger of the window's life (no resize/move hook).
    void closing();

protected:
    void closeEvent(QCloseEvent *event) override;

private:
    QLabel *m_status = nullptr;
};

} // namespace ui

#endif // CLIENT_QT_UI_MAINWINDOW_H
