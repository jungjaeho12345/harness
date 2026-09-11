#ifndef CLIENT_QT_TESTS_DIAGTEST_H
#define CLIENT_QT_TESTS_DIAGTEST_H

#include <QByteArray>
#include <QObject>

// The diagnostic JSONL contract (phase 77 step4) - the verification spine of P4.
//
// Two kinds of case live here:
//   1. Ports of rules the canonical suite already locks (test/client-shell-main.test.js).
//   2. NEW coverage for rules the canonical suite never locked. The port spec counted 12
//      such rules in this module alone - "translate every existing test 1:1" would have let
//      all twelve through silently. Each of those cases names its rule id in a comment.
//
// Nothing here touches CLIENT_DIAG_FILE of the real process except through save/restore in
// init()/cleanup(), and every file this class writes lives in a QTemporaryDir.
class DiagTest : public QObject
{
    Q_OBJECT

private slots:
    void init();
    void cleanup();

    // --- line format -------------------------------------------------------------------
    void matchesTheCanonicalProbeLineByte();
    void matchesTheCanonicalRedaction_data();
    void matchesTheCanonicalRedaction();
    void endsWithExactlyOneNewlineAndNoCarriageReturn();
    void putsTsThenEventThenTheRestOfThePayload();
    void encodesNonAsciiTextAsUtf8();
    void letsThePayloadOverrideTsAndEvent();

    // --- forbidden keys ----------------------------------------------------------------
    void dropsEveryForbiddenKey_data();
    void dropsEveryForbiddenKey();
    void matchesForbiddenKeysCaseSensitively();

    // --- value whitelist ---------------------------------------------------------------
    void dropsObjectAndArrayValues();
    void dropsValuesOutsideTheScalarWhitelist_data();
    void dropsValuesOutsideTheScalarWhitelist();
    void keepsNullAndOmitsAbsentFields();
    void writesNonFiniteNumbersAsNull();

    // --- URL redaction -----------------------------------------------------------------
    void redactsUrlKeysToOriginAndPath_data();
    void redactsUrlKeysToOriginAndPath();
    void matchesUrlKeysBySubstringNotSuffix();
    void redactsOnlyStringUrlValues();

    // --- event catalogue ---------------------------------------------------------------
    void allowsExactlyTheDispositionTable();
    void keepsTheExtinctElectronEventsOut();
    void refusesToWriteAnEventOutsideTheAllowedSet();

    // --- P4 leak rules (step4.md C) -----------------------------------------------------
    void dropsRouteValuesThatCarryAConcreteId_data();
    void dropsRouteValuesThatCarryAConcreteId();
    void keepsOnlyTheContractedFieldsOfTheNewEvents();
    void keepsOnlyTheContractedFieldsOfTheSseEvents();
    void dropsArticleAndUserTextFields_data();
    void dropsArticleAndUserTextFields();

    // --- sink --------------------------------------------------------------------------
    void writesNothingWithoutADiagFile();
    void readsThePathFromClientDiagFile();
    void appendsEachLineBeforeLogReturns();
    void swallowsWriteFailuresOnAMissingDirectory();
    void writesLinesTheJudgeCanParse();

private:
    QByteArray m_savedDiagEnv;
    bool m_hadDiagEnv = false;
};

#endif // CLIENT_QT_TESTS_DIAGTEST_H
