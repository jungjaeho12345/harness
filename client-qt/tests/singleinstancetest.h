#ifndef CLIENT_QT_TESTS_SINGLEINSTANCETEST_H
#define CLIENT_QT_TESTS_SINGLEINSTANCETEST_H

#include <QByteArray>
#include <QObject>

// Single instance (phase 77 step5). The canonical gets lock + second-launch notice from one
// Electron call and never unit-tested either (port spec R-instance-ipc, R13, W-N3, and R1 only
// as a text-position grep gate). These cases drive the real Windows named mutex and the real
// QLocalServer inside this process; every name is derived from a QTemporaryDir so no case can
// touch - or be blocked by - a client the user is running.
class SingleInstanceTest : public QObject
{
    Q_OBJECT

private slots:
    void init();
    void cleanup();

    void derivesTheNamesFromTheUserDataFolder();
    void treatsSpellingsOfOneFolderAsOneInstance_data();
    void treatsSpellingsOfOneFolderAsOneInstance();
    void followsTheResolvedUserDataFolder();
    void grantsTheLockToExactlyOneGuard();
    void releasesTheLockWithItsHolder();
    void carriesASecondLaunchToThePrimary();
    void failsQuietlyWhenNobodyListens();

private:
    QByteArray m_savedUserDataEnv;
    bool m_hadUserDataEnv = false;
    QByteArray m_savedAppDataEnv;
    bool m_hadAppDataEnv = false;
};

#endif // CLIENT_QT_TESTS_SINGLEINSTANCETEST_H
