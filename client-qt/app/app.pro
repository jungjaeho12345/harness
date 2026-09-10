TEMPLATE = app
TARGET = news-client

include(../common.pri)

# Console subsystem, same as the P0 spike (spikes/p0-qt-editor/spike.pro): --selftest has
# to be able to print to the shell that launched it. The shipped subsystem/product name
# (and the Korean product exe, icon, windeployqt) is a P8 packaging decision, not P4.
CONFIG += console

DESTDIR = $$PWD/../release

SOURCES += main.cpp
