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
           configstoretest.cpp

HEADERS += smoketest.h \
           serverurltest.h \
           clientconfigtest.h \
           configstoretest.h
