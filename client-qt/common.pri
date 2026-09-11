# Build settings shared by every client-qt target (app + tests).
#
# The toolkit combination is fixed (index.json open_questions (5), confirmed 2026-09-10):
# C++17 + widgets + testlib + network. Do not open a QML branch here - the P5 editor got
# its "go" verdict on a widgets-based spike (PR #108), so P5 has to stand on widgets.
CONFIG += c++17 release
QT += core gui widgets network

INCLUDEPATH += $$PWD/src

# Shared implementation sources. step2..step5 add src/shell/**, step7..step9 add src/net/**,
# src/ui/** holds the screens (step5: the setup screen + the empty main window; step10..step11:
# login and list). Every module lands here exactly once so that the app and the test runner
# compile the same code.
CLIENT_SOURCES = $$PWD/src/shell/serverurl.cpp \
                 $$PWD/src/shell/clientconfig.cpp \
                 $$PWD/src/shell/configstore.cpp \
                 $$PWD/src/shell/diag.cpp \
                 $$PWD/src/shell/windowpolicy.cpp \
                 $$PWD/src/shell/proberunner.cpp \
                 $$PWD/src/shell/singleinstance.cpp \
                 $$PWD/src/shell/appshell.cpp \
                 $$PWD/src/net/querystring.cpp \
                 $$PWD/src/net/httptransport.cpp \
                 $$PWD/src/net/editclientid.cpp \
                 $$PWD/src/net/httpproberunner.cpp \
                 $$PWD/src/net/routetable.cpp \
                 $$PWD/src/net/newsmodel.cpp \
                 $$PWD/src/net/httpnewsmodel.cpp \
                 $$PWD/src/net/fakenewsmodel.cpp \
                 $$PWD/src/ui/setupscreen.cpp \
                 $$PWD/src/ui/mainwindow.cpp
CLIENT_HEADERS = $$PWD/src/shell/serverurl.h \
                 $$PWD/src/shell/appidentity.h \
                 $$PWD/src/shell/clientconfig.h \
                 $$PWD/src/shell/configstore.h \
                 $$PWD/src/shell/diag.h \
                 $$PWD/src/shell/windowpolicy.h \
                 $$PWD/src/shell/proberunner.h \
                 $$PWD/src/shell/singleinstance.h \
                 $$PWD/src/shell/appshell.h \
                 $$PWD/src/net/querystring.h \
                 $$PWD/src/net/httptransport.h \
                 $$PWD/src/net/editclientid.h \
                 $$PWD/src/net/httpproberunner.h \
                 $$PWD/src/net/routetable.h \
                 $$PWD/src/net/newsmodel.h \
                 $$PWD/src/net/httpnewsmodel.h \
                 $$PWD/src/net/fakenewsmodel.h \
                 $$PWD/src/ui/theme.h \
                 $$PWD/src/ui/setupscreen.h \
                 $$PWD/src/ui/mainwindow.h

SOURCES += $$CLIENT_SOURCES
HEADERS += $$CLIENT_HEADERS
