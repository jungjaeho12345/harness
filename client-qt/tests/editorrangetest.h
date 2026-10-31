#ifndef CLIENT_QT_TESTS_EDITORRANGETEST_H
#define CLIENT_QT_TESTS_EDITORRANGETEST_H

#include <QObject>

// editor/editorrange.* (phase 78 step4) - word and paragraph bounds.
//
// The first 17 functions are web/src/view/editorRange.test.js, one per `it`, in the same order (describe
// "wordBoundsAt" 9 · "paragraphBoundsAt" 8). The last five are the port's own locks:
//   - wordBoundsAt at every column of a few lines (on a word / whitespace with the LEFT word first and the
//     right one as the fallback / no word = the empty range start == end, end exclusive throughout)
//   - the word splitter is the JS \s set per UTF-16 code unit (editor::isJsWhitespace - not
//     QChar::isSpace(), which differs on U+0085 and U+FEFF)
//   - paragraphBoundsAt at every line of a few lists (blank = exactly "", whitespace-only lines are not)
//   - isParagraphBoundary is the definition the web status bar uses too (editorStats.paragraphIndex - P6)
//   - the bounds compose with step3: a readCaret-shaped TextPoint -> bounds -> a TextRange that
//     replaceRangeInBlocks takes as is, embeds and the marker clamp included, and the empty range is a no-op
//
// Every expected value was produced by running the canonical web modules under node (2026-11-01).
class EditorRangeTest : public QObject
{
    Q_OBJECT

private slots:
    // editorRange — wordBoundsAt
    void midWordReturnsTheWholeWord();
    void wordStartEdgeReturnsThatWord();
    void wordEndEdgeReturnsThatWord();
    void whitespaceBetweenWordsTakesTheLeftWord();
    void leadingWhitespaceTakesTheRightWord();
    void whitespaceOnlyLineGivesTheEmptyRange();
    void emptyLineGivesTheEmptyRange();
    void columnIsClampedIntoTheLine();
    void hangulAndMixedTextUseNonSpaceRuns();

    // editorRange — paragraphBoundsAt
    void singleParagraphSpansEveryLine();
    void twoParagraphsSplitByABlankLine();
    void blankLineIsItsOwnParagraph();
    void consecutiveBlankLinesAreEachTheirOwn();
    void whitespaceOnlyLineIsNotBlank();
    void lineIndexIsClamped();
    void hangulParagraphs();
    void inputListIsNotMutated();

    // Port locks
    void wordBoundsAtEveryColumn_data();
    void wordBoundsAtEveryColumn();
    void wordsSplitOnTheJsWhitespaceSet_data();
    void wordsSplitOnTheJsWhitespaceSet();
    void paragraphBoundsAtEveryLine_data();
    void paragraphBoundsAtEveryLine();
    void paragraphBoundaryIsTheStatusBarDefinition_data();
    void paragraphBoundaryIsTheStatusBarDefinition();
    void boundsComposeIntoAReplaceRange_data();
    void boundsComposeIntoAReplaceRange();
};

#endif // CLIENT_QT_TESTS_EDITORRANGETEST_H
