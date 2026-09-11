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
           liveservertest.cpp \
           repofiles.cpp \
           routetabletest.cpp \
           routecontracttest.cpp \
           httpnewsmodeltest.cpp \
           fakenewsmodeltest.cpp \
           ssestubserver.cpp \
           sseparsertest.cpp \
           changestreamtest.cpp \
           livestreamtest.cpp \
           scenariotest.cpp \
           logincontrollertest.cpp \
           listcontrollertest.cpp \
           listscreentest.cpp \
           screeninventorytest.cpp

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
           liveservertest.h \
           repofiles.h \
           routetabletest.h \
           routecontracttest.h \
           httpnewsmodeltest.h \
           fakenewsmodeltest.h \
           ssestubserver.h \
           sseparsertest.h \
           changestreamtest.h \
           livestreamtest.h \
           loginwire.h \
           scenariotest.h \
           logincontrollertest.h \
           listcontrollertest.h \
           listscreentest.h \
           screeninventorytest.h
