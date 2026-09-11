#ifndef CLIENT_QT_TESTS_REPOFILES_H
#define CLIENT_QT_TESTS_REPOFILES_H

// Reading repository files from a test (phase 77 step8).
//
// The contract tests read docs/api-contract/endpoints.json and web/src/model/contract.js at run
// time, so a drift is caught without anyone copying the lists. The files are found by their path
// RELATIVE TO THE REPOSITORY ROOT: walking up from the test binary's directory, then from the
// working directory, until "<dir>/<relativePath>" is a file. Wherever the build directory is
// (client-qt/tests/release today), the walk reaches the repo root.
//
// Not finding a file is a FAILURE, never a skip: the callers QVERIFY2 the result, so a test
// binary run outside the repository goes red on every contract check instead of reporting a
// green it never earned.

#include <QByteArray>
#include <QString>
#include <QStringList>

// Absolute path of the first "<ancestor>/<relativePath>" that is a file; empty when none is.
// searched (optional) receives every directory that was tried - for the failure message.
QString findRepoFile(const QString &relativePath, QStringList *searched = nullptr);

// The file's bytes; false (and a message naming what was searched) when it cannot be found/read.
bool readRepoFile(const QString &relativePath, QByteArray *bytes, QString *error);

#endif // CLIENT_QT_TESTS_REPOFILES_H
