#ifndef CLIENT_QT_TESTS_EDITORSHORTCUTSTEST_H
#define CLIENT_QT_TESTS_EDITORSHORTCUTSTEST_H

#include <QObject>

// editor/editorshortcuts.* (phase 78 step5) - the shortcuts: key recognition and the block transforms.
//
// The first 28 functions are web/src/view/editorShortcuts.test.js, one per `it`, in the same order (describe
// "key recognition" 7 · "insert (끝) (Alt+Y)" 2 · "delete line" 4 · "insert (계속) (Ctrl+Y)" 7 · "기업코드변환
// (Ctrl+B)" 2 · "case transforms" 6). The rest are the port's own locks:
//   - every predicate against every modifier combination and every key form (the letter in both cases, the
//     physical code under Hangul input, Insert) - a letter is read from key OR code, never from key alone
//   - layouts whose typed character and physical key disagree, where two predicates claim one press
//   - RESERVED_COMBOS is exactly the web's 13, in order, and each is claimed by the predicate that owns it
//     (Ctrl+A / C / X / V by none - they are the text engine's native editing keys)
//   - textLineToBlockIndex and the four transforms byte for byte against the web (serialize), with the marker
//     contract checked on every row: Alt+Y refuses exactly where the step3 gate closes the document end, "(끝)"
//     stays last after Ctrl+Y, a case transform never changes a marker line
//   - the case transforms against JS: equal rows, the measured divergences (Final_Sigma, Unicode 17.0
//     letters), and a hash over every other code point
//
// Every expected value of a data table was produced by running the canonical web modules under node
// (2026-11-01, node 24.16 / ICU 78.3 / Unicode 17.0).
class EditorShortcutsTest : public QObject
{
    Q_OBJECT

private slots:
    // editorShortcuts — key recognition
    void recognizesAltY();
    void recognizesCtrlD();
    void recognizesAltOButNotAltYOrCtrlO();
    void recognizesAltVButNotCtrlVOrPlainV();
    void recognizesCtrlZWithoutShift();
    void recognizesInsertWithoutModifiers();
    void recognizesCtrlShiftZWithoutTouchingCtrlY();

    // editorShortcuts — insert "(끝)" (Alt+Y)
    void endMarkerGoesLastAfterEmbedsWithSpellcheckOn();
    void endMarkerIsNotDuplicated();

    // editorShortcuts — delete line (Ctrl+D / Backspace / Delete)
    void deleteLineTakesItsCompanionEmbed();
    void deleteLineWithoutCompanionEmbed();
    void deleteLineOnAnEmbedRemovesOnlyThatEmbed();
    void deleteLineOutOfRangeIsANoOp();

    // editorShortcuts — insert "(계속)" (Ctrl+Y)
    void recognizesCtrlYButNotAltY();
    void continueMarkerGoesAfterTheLine();
    void continueMarkerFallbackKeepsTheEndMarkerLast();
    void continueMarkerKeepsEmbedOrderAndTheInput();
    void continueMarkerIsNotIdempotent();
    void continueMarkerKeepsTheEndMarkerAlign();
    void continueMarkerAddsNoAlignKey();

    // editorShortcuts — 기업코드변환 (Ctrl+B)
    void recognizesCtrlBButNotPlainOrAltB();
    void companyCodeIgnoresShiftAndMeta();

    // editorShortcuts — case transforms (보기 메뉴)
    void stringTransformsArePure();
    void transformTextLineTouchesTheTargetLineOnly();
    void transformTextLineCountsTextLinesOnly();
    void transformTextLineOutOfRangeIsANoOp();
    void transformTextLineKeepsAlign();
    void transformTextLineAddsNoAlignKey();

    // Port locks
    void predicatesMatchTheWebTruthTable_data();
    void predicatesMatchTheWebTruthTable();
    void keyAndCodeAreBothRead_data();
    void keyAndCodeAreBothRead();
    void thereAreExactlyThirteenReservedShortcuts();
    void reservedCombosMatchTheWeb_data();
    void reservedCombosMatchTheWeb();
    void textLineToBlockIndexCountsTextBlocksOnly_data();
    void textLineToBlockIndexCountsTextBlocksOnly();
    void insertEndMarkerMatchesTheWebBytes_data();
    void insertEndMarkerMatchesTheWebBytes();
    void deleteLineAtMatchesTheWebBytes_data();
    void deleteLineAtMatchesTheWebBytes();
    void insertContinueMarkerMatchesTheWebBytes_data();
    void insertContinueMarkerMatchesTheWebBytes();
    void transformTextLineMatchesTheWebBytes_data();
    void transformTextLineMatchesTheWebBytes();
    void caseTransformsMatchTheWeb_data();
    void caseTransformsMatchTheWeb();
    void caseTransformDivergencesAreTheMeasuredOnes_data();
    void caseTransformDivergencesAreTheMeasuredOnes();
    void unicode17LettersAreLeftAsTheyAre_data();
    void unicode17LettersAreLeftAsTheyAre();
    void caseMappingMatchesJsForEveryOtherCodePoint();
    void caseTransformsLeaveMarkerLinesIntact_data();
    void caseTransformsLeaveMarkerLinesIntact();
    void transformsNormalizeTheirInputLikeTheWeb();
    void transformsNeverMutateTheirInput();
};

#endif // CLIENT_QT_TESTS_EDITORSHORTCUTSTEST_H
