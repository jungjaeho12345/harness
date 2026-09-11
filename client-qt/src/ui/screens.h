#ifndef CLIENT_QT_UI_SCREENS_H
#define CLIENT_QT_UI_SCREENS_H

// The screen inventory of P4 (phase 77 step11 B · decisions (5)). What a "screen" is, is defined in
// client-qt/README.md (「화면」): a top-level window the user sees, or the one main content panel of
// such a window. The main window itself is a window SHELL (the frame the login and list screens take
// turns in), not a screen.
//
// This registry is a self-declaration - so it is cross-checked against the sources: a test scans
// client-qt/src and client-qt/app for every widget class and requires that set to be exactly the
// registered screens plus the window shell (tests/screeninventorytest.cpp). Building one more screen
// (P7's menus, P5's editor) turns that test red - scope does not grow quietly.

#include <QList>
#include <QString>
#include <QStringList>

namespace ui {

struct ScreenEntry {
    QString id;         // login | list | setup
    QString className;  // the widget class, without its namespace
};

const QList<ScreenEntry> &screenRegistry();
QStringList windowShellClasses();

} // namespace ui

#endif // CLIENT_QT_UI_SCREENS_H
