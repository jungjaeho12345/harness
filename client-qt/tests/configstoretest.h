#ifndef CLIENT_QT_TESTS_CONFIGSTORETEST_H
#define CLIENT_QT_TESTS_CONFIGSTORETEST_H

#include <QByteArray>
#include <QObject>
#include <QString>

// The filesystem half of the config port (phase 77 step3): where config.json is resolved
// and how it is replaced. Two things this class exists to prove and nothing in the
// canonical test suite could:
//   1. The Qt client resolves a *different* user data folder than the Electron shell
//      (canonical rule R11 - the highest-risk adaptation of this module, and the canonical
//      tests only ever checked join arithmetic on a directory handed to them).
//   2. The write path really is tmp -> rename. "No leftover temp file" alone stays green
//      when the write degrades into a direct overwrite (mutation M3-2), so the order of the
//      filesystem calls is asserted through an injected spy.
//
// No test in this file ever touches the real user's %APPDATA%: every write goes to a
// QTemporaryDir, and the two tests about the real folder only compute strings.
class ConfigStoreTest : public QObject
{
    Q_OBJECT

private slots:
    void init();
    void cleanup();

    void namesAreDistinctFromTheElectronShell();
    void buildsTheConfigPath_data();
    void buildsTheConfigPath();
    void prefersTheInjectedUserDataDirectory();
    void fallsBackToItsOwnAppDataFolder();
    void writesThroughATemporaryFileAndRenames();
    void reportsWriteFailuresAsAValue_data();
    void reportsWriteFailuresAsAValue();
    void rejectsAnEmptyDirectoryWithoutTouchingTheFilesystem();
    void leavesNoTemporaryFileBehind();
    void overwritesAnExistingConfigFile();
    void createsAMissingDirectory();
    void failsWithoutThrowingOnAnUnusablePath();
    void loadsBackWhatItSaved();
    void loadFallsBackToDefaults_data();
    void loadFallsBackToDefaults();

private:
    QByteArray m_savedUserDataEnv;
    bool m_hadUserDataEnv = false;
    QByteArray m_savedAppDataEnv;
    bool m_hadAppDataEnv = false;
};

#endif // CLIENT_QT_TESTS_CONFIGSTORETEST_H
