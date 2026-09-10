# Build settings shared by every client-qt target (app + tests).
#
# The toolkit combination is fixed (index.json open_questions (5), confirmed 2026-09-10):
# C++17 + widgets + testlib + network. Do not open a QML branch here - the P5 editor got
# its "go" verdict on a widgets-based spike (PR #108), so P5 has to stand on widgets.
CONFIG += c++17 release
QT += core gui widgets network

INCLUDEPATH += $$PWD/src

# Shared implementation sources. Empty in step0 (this is a skeleton): step2..step5 add
# src/shell/**, step7..step9 add src/net/**, step10..step11 add src/ui/**. Every module
# lands here exactly once so that the app and the test runner compile the same code.
CLIENT_SOURCES =
CLIENT_HEADERS =

SOURCES += $$CLIENT_SOURCES
HEADERS += $$CLIENT_HEADERS
