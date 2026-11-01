#ifndef CLIENT_QT_TESTS_EDITORCARETTEST_H
#define CLIENT_QT_TESTS_EDITORCARETTEST_H

#include <QObject>

// editor/editorcaret.* (phase 78 step4) - the caret's line math.
//
// The first six functions are web/src/view/editorCaret.test.js, one per `it`, in the same order
// (describe "editorCaret — line math"). The last three are the port's own locks: lines() splits on "\n"
// alone, and lineAtOffset / removeLineFromText swept over every offset / line index of a few texts plus
// the int extremes (UTF-16 code units - Hangul and an astral character included).
//
// Every expected value was produced by running the canonical web module under node (2026-11-01).
class EditorCaretTest : public QObject
{
    Q_OBJECT

private slots:
    // editorCaret — line math
    void splitsTextIntoLines();
    void lineAtOffsetFindsTheLineIndexAndBounds();
    void clampsOutOfRangeOffsets();
    void removeLineRemovesTheTargetLineAndReturnsIt();
    void removeLinePutsTheCaretAtTheLineThatTookTheSlot();
    void removeLineIsANoOpOutOfRange();

    // Port locks
    void linesSplitsOnLineFeedOnly_data();
    void linesSplitsOnLineFeedOnly();
    void lineAtOffsetAtEveryOffset_data();
    void lineAtOffsetAtEveryOffset();
    void removeLineAtEveryIndex_data();
    void removeLineAtEveryIndex();
};

#endif // CLIENT_QT_TESTS_EDITORCARETTEST_H
