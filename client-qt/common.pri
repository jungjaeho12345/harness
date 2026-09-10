# Build settings shared by every client-qt target (app + tests).
#
# The toolkit combination is fixed (index.json open_questions (5), confirmed 2026-09-10):
# C++17 + widgets + testlib + network. Do not open a QML branch here - the P5 editor got
# its "go" verdict on a widgets-based spike (PR #108), so P5 has to stand on widgets.
CONFIG += c++17 release
QT += core gui widgets network

INCLUDEPATH += $$PWD/src

# Shared implementation sources. step2..step5 add src/shell/**, step7..step9 add src/net/**,
# step10..step11 add src/ui/**. Every module lands here exactly once so that the app and the
# test runner compile the same code.
CLIENT_SOURCES = $$PWD/src/shell/serverurl.cpp \
                 $$PWD/src/shell/clientconfig.cpp \
                 $$PWD/src/shell/configstore.cpp \
                 $$PWD/src/shell/diag.cpp
CLIENT_HEADERS = $$PWD/src/shell/serverurl.h \
                 $$PWD/src/shell/appidentity.h \
                 $$PWD/src/shell/clientconfig.h \
                 $$PWD/src/shell/configstore.h \
                 $$PWD/src/shell/diag.h

SOURCES += $$CLIENT_SOURCES
HEADERS += $$CLIENT_HEADERS
