#ifndef CLIENT_QT_TESTS_SCREENINVENTORYTEST_H
#define CLIENT_QT_TESTS_SCREENINVENTORYTEST_H

// The P4 screen inventory (phase 77 step11 B · decisions (5)): the registry says login, list, setup -
// and a text scan of the sources must find exactly those widget classes plus the window shell.

#include <QObject>

class ScreenInventoryTest : public QObject
{
    Q_OBJECT

private slots:
    void registersExactlyTheThreeP4Screens();
    void scannerFindsWidgetClassesAndOnlyThose();
    void sourcesHoldNoUnregisteredWidgetClass();
    void sourcesOpenNoDialogWindow();
};

#endif // CLIENT_QT_TESTS_SCREENINVENTORYTEST_H
