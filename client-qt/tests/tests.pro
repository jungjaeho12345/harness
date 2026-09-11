TEMPLATE = app
TARGET = client-qt-tests

include(../common.pri)

QT += testlib
CONFIG += console
CONFIG -= app_bundle

DESTDIR = $$PWD/release

SOURCES += main.cpp \
           smoketest.cpp \
           serverurltest.cpp \
           clientconfigtest.cpp \
           configstoretest.cpp \
           diagtest.cpp \
           windowpolicytest.cpp \
           singleinstancetest.cpp \
           proberunnertest.cpp \
           appshelltest.cpp \
           stubhttpserver.cpp \
           querystringtest.cpp \
           netpolicytest.cpp \
           httptransporttest.cpp \
           httpproberunnertest.cpp \
           liveservertest.cpp

HEADERS += smoketest.h \
           serverurltest.h \
           clientconfigtest.h \
           configstoretest.h \
           diagtest.h \
           windowpolicytest.h \
           singleinstancetest.h \
           proberunnertest.h \
           appshelltest.h \
           stubhttpserver.h \
           querystringtest.h \
           netpolicytest.h \
           httptransporttest.h \
           httpproberunnertest.h \
           liveservertest.h
