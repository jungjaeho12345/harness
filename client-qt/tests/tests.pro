TEMPLATE = app
TARGET = client-qt-tests

include(../common.pri)

QT += testlib
CONFIG += console
CONFIG -= app_bundle

DESTDIR = $$PWD/release

# The in-memory Model is a test double: it is compiled by THIS target only, never by the app
# (gate review 2026-09-12 - it used to sit in common.pri and shipped inside news-client.exe).
# The file stays under src/net/ so that "net/fakenewsmodel.h" keeps resolving through INCLUDEPATH.
SOURCES += $$PWD/../src/net/fakenewsmodel.cpp \
           main.cpp \
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
           screeninventorytest.cpp \
           timerpolicytest.cpp

HEADERS += $$PWD/../src/net/fakenewsmodel.h \
           smoketest.h \
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
           screeninventorytest.h \
           timerpolicytest.h
