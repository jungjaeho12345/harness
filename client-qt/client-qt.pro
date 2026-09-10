# phase 77 (roadmap P4) - Qt native client, root project.
#
# Two targets, built in order by build.bat:
#   app   -> client-qt/release/news-client.exe        (GUI entry point)
#   tests -> client-qt/tests/release/client-qt-tests.exe (console QtTest runner)
#
# open_questions (1): qmake "subdirs" with multiple targets had never been proven on this
# machine. step0 tries it first; the fallback (build.bat calling the two .pro files in
# sequence) needs no change to app.pro / tests.pro because both set their own DESTDIR.
TEMPLATE = subdirs
CONFIG += ordered
SUBDIRS = app tests
