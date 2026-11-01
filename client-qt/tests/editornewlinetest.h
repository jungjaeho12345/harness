#ifndef CLIENT_QT_TESTS_EDITORNEWLINETEST_H
#define CLIENT_QT_TESTS_EDITORNEWLINETEST_H

#include <QObject>

// editor/editornewline.* (phase 78 step3) - the "(끝)" marker gate, newline insertion and the marker
// renormalization.
//
// The first 55 functions are web/src/view/editorNewline.test.js, one per `it`, in the same order
// (describe "placement & input blocking" 6 · shouldOverwriteNextChar 7 · overwriteExtendLength 4 ·
// surrogate interior 6 · insertTextIntoBlocks 6 · replaceRangeInBlocks 26). Where the web passes a
// value C++ cannot hold (an offset of null / undefined / 1.5 / NaN / '1'), the port keeps the rows the
// int signature can express and says so in the function. The web round trip
// deserialize(serializeBodyFromBlocks(blocks)) is deserialize(serialize(renormalizeEndMarker(blocks))).
//
// The last five are the port's own locks: the input gate's boundary (at or after the LAST marker, UTF-16
// code units - not bytes), the marker-line judgement (JS trim, embeds never), two byte-parity tables
// (renormalization against writerBody.serializeBodyFromBlocks · replaceRangeInBlocks against the web)
// and the line-merge gate - the one deliberate divergence (pre-decision 1: Backspace/Delete across a
// line boundary passes the gate; the web merges with no guard and can ship "본문(끝)").
//
// Every expected value was produced by running the canonical web modules under node (2026-11-01).
class EditorNewlineTest : public QObject
{
    Q_OBJECT

private slots:
    // editorNewline — "(끝)" placement & input blocking
    void appendsTheMarkerOnItsOwnLineAfterTheBody();
    void addsNoDoubleNewlineWhenTheBodyEndsWithOneOrIsEmpty();
    void doesNotInsertTheMarkerAgain();
    void hasEndMarkerReflectsPresence();
    void blocksInputAtOrAfterTheMarkerAllowsItBefore();
    void neverBlocksWithoutAMarker();

    // editorNewline — shouldOverwriteNextChar (수정 모드 덮어쓰기 경계)
    void overwriteReplacesAnOrdinaryCharacterAtEachOffset();
    void overwriteFallsBackToInsertAtTheEndAndOutOfRange();
    void overwriteNeverEatsTheNextLine();
    void overwriteIsOffFromTheMarkerStartOn();
    void overwriteSeesAnEmbedBoundaryAsALineEnd();
    void overwriteRejectsInvalidOffsets();
    void overwriteRejectsEmptyOrMissingText();

    // editorNewline — overwriteExtendLength (서로게이트-safe 확장 길이)
    void extendLengthIsOneForABmpCharacter();
    void extendLengthIsTwoForAnAstralCharacter();
    void extendLengthIsOneForALoneHighSurrogate();
    void extendLengthIsOneAtBoundariesAndInvalidOffsets();

    // editorNewline — shouldOverwriteNextChar (서로게이트 페어 내부 차단)
    void overwriteRefusesTheInsideOfASurrogatePair();
    void overwriteAtAPairStartExtendsTwoUnits();
    void overwriteAfterAPairIsAllowed();
    void overwriteAllowsALoneLowSurrogate();
    void overwriteAllowsALoneHighSurrogateWithOneUnit();
    void overwriteBmpVerdictsAreUnchanged();

    // editorNewline — insertTextIntoBlocks (Enter 분할 / 여러 줄 삽입)
    void enterSplitsTheCaretLineIntoHeadAndTail();
    void enterAtALineEndAddsAnEmptyLine();
    void unknownCaretAppendsAnEmptyLineAtTheLastLine();
    void enterInAnEmptyBodyGivesTwoEmptyLines();
    void multiLineInsertKeepsHeadFirstLineLastLineTail();
    void insertKeepsEmbedsInPlaceAndSplitsOnlyText();

    // editorNewline — replaceRangeInBlocks (선택 범위 삭제 + 삽입)
    void replaceDeletesTheSelectionAndInsertsMultiLineText();
    void enterOverASelectionDeletesItThenSplits();
    void multiLineSelectionDropsMiddleLinesAndMergesHeadAndTail();
    void collapsedRangeMatchesInsertTextIntoBlocks();
    void collapsedResultsAreTodaysExpectedValues();
    void unknownEndsFallBackLikeAnUnknownOrCollapsedCaret();
    void reversedSelectionIsNormalized();
    void embedInsideTheRangeSurvivesAfterTheMergedLine();
    void severalEmbedsInsideTheRangeKeepCountAndOrder();
    void deleteEndIsClampedBeforeTheMarkerLine();
    void markerLineNeverGetsOtherCharactersGlued();
    void deletingLinesBeforeTheMarkerWorksNormally();
    void replacingAllOfAMarkerFirstDocumentInsertsBeforeTheMarker();
    void replacingOnlyTheMarkerLineInsertsAtTheLineBeforeIt();
    void collapsedCaretOnTheMarkerLineMovesBeforeTheMarker();
    void replacementStartingAfterTheMarkerLeavesItAndTheTailUntouched();
    void wholeDocumentSelectionReplacesTheTextAndKeepsEmbeds();
    void unknownCaretInsertsBeforeTheMarkerLine();
    void unknownCaretWithOnlyTheMarkerMakesANewLineBeforeIt();
    void unknownCaretWithoutAMarkerAppendsAtTheLastLine();
    void noTextLineAppendsAfterTheEmbeds();
    void firstOfTwoMarkersIsTheClampPoint();
    void collapsedEnterGivesBothLinesTheOriginalAlign();
    void mergedLinesTakeTheStartAndEndAlign();
    void invalidAlignNeverBecomesAKey();
    void inputBlocksAreNeverMutated();

    // Port locks
    void inputGateBoundaries_data();
    void inputGateBoundaries();
    void markerBlockIsTheJsTrimmedLine_data();
    void markerBlockIsTheJsTrimmedLine();
    void renormalizationMatchesTheWebBytes_data();
    void renormalizationMatchesTheWebBytes();
    void rangeReplacementMatchesTheWebBytes_data();
    void rangeReplacementMatchesTheWebBytes();
    void lineMergeGate_data();
    void lineMergeGate();
};

#endif // CLIENT_QT_TESTS_EDITORNEWLINETEST_H
