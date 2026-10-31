#ifndef CLIENT_QT_TESTS_EDITOREDITOPSTEST_H
#define CLIENT_QT_TESTS_EDITOREDITOPSTEST_H

#include <QObject>

// editor/editoreditops.* (phase 78 step5) - the word delete.
//
// The first nine functions are the word-delete half of web/src/view/editorEditOps.test.js, one per `it`, in
// the same order: describe "deleteWordAt" (8) and the deleteWordAt part of "input immutability" (1). The
// sortDocument / sortParagraph cases are the 보기 정렬 menu - P6, not ported here. The last two are the port's
// own locks:
//   - deleteWordAt over a sweep of lines and columns byte for byte against the web (serialize), marker lines
//     (JS trim - U+FEFF strips, U+0085 does not), glued / quoted / doubled "(끝)" and embeds included, with
//     the marker contract checked on every row: the deleted span never cuts into a "(끝)"
//   - the input is normalized the way the web normalizes it (an align outside ALIGN_VALUES is dropped)
//
// Every expected value of a data table was produced by running the canonical web modules under node
// (2026-11-01).
class EditorEditOpsTest : public QObject
{
    Q_OBJECT

private slots:
    // editorEditOps — deleteWordAt (단어 지우기)
    void deletesOnlyTheWordAtTheCaret();
    void isANoOpOnTheMarkerLine();
    void isANoOpWithoutAWord();
    void deletesAWordOnTheFirstLine();
    void keepsEmbedCountAndPosition();
    void isANoOpForAnOutOfRangeLine();
    void keepsTheLineAlign();
    void addsNoAlignKey();

    // editorEditOps — input immutability (the deleteWordAt part)
    void doesNotMutateTheInput();

    // Port locks
    void deleteWordAtMatchesTheWebBytes_data();
    void deleteWordAtMatchesTheWebBytes();
    void normalizesItsInputLikeTheWeb();
};

#endif // CLIENT_QT_TESTS_EDITOREDITOPSTEST_H
