#ifndef CLIENT_QT_TESTS_EDITORDRAFTSTORETEST_H
#define CLIENT_QT_TESTS_EDITORDRAFTSTORETEST_H

#include <QObject>

// editor/editordraftstore.* (phase 78 step7) - the drafts file: the production IDraftStore, driven through the
// editordraft.h functions the state machine will call.
//
// Two kinds of evidence. On a real file in a QTemporaryDir (the test removes it itself): after every operation the
// file holds byte for byte the value the web keeps in localStorage for the same operations, broken files read as an
// empty store, every string survives, a missing file stays missing until the first save, and config.json in the
// same folder is never touched. Through a spy on the shell::ConfigFileSystem seam (the config store's - reused, not
// changed): the write path really is "<file>.tmp" -> rename, a file that is there but cannot be read is never
// written over, and a failing write is silence.
//
// Every expected value of a data table was produced by running the canonical web module under node 24
// (2026-11-01, s7-rows.mjs) - tables spliced in as generated, never typed by hand.
class EditorDraftStoreTest : public QObject
{
    Q_OBJECT

private slots:
    void writesTheWebsStorageValue_data();
    void writesTheWebsStorageValue();
    void readsABrokenFileAsAnEmptyStore_data();
    void readsABrokenFileAsAnEmptyStore();
    void keepsEveryStringExactly_data();
    void keepsEveryStringExactly();
    void replacesTheFileThroughATemporaryFile();
    void writesNothingOverAFileItCannotRead();
    void survivesAFailingWrite_data();
    void survivesAFailingWrite();
    void createsNothingUntilTheFirstSave();
    void livesBesideTheConfigAndApartFromIt();
    void survivesADirectoryWhereTheFileShouldBe();
};

#endif // CLIENT_QT_TESTS_EDITORDRAFTSTORETEST_H
