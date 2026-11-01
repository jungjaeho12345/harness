#ifndef CLIENT_QT_TESTS_EDITORHISTORYTEST_H
#define CLIENT_QT_TESTS_EDITORHISTORYTEST_H

#include <QObject>

// editor/editorhistory.* (phase 78 step6) - the undo / redo history.
//
// The first fourteen functions are web/src/view/editorHistory.test.js, one per `it`, in the same order. The web
// asserts reference identity in places (`toBe(h)` - "the same object back"); the C++ port is a value type, so
// identity reads as value equality there (operator==) - a no-op returns a value equal to its input, and only a
// no-op does (the generator checks that the two notions agree on every traced op). The last four are the port's
// own locks:
//   - op scripts (the spec's own sequences, hand-picked branches, seeded random scripts) replayed against the web
//     module, the whole state compared after every op
//   - the body is opaque: bodies that differ only in code units - including pairs that serialize(deserialize(x))
//     would make equal - are separate snapshots; equal ones are a no-op, on the push and the coalescing path
//   - the limit swept up to the production value (WriterPage.jsx HISTORY_LIMIT = 100): only the oldest entries
//     go, the baseline last; a coalesced replace never cuts
//   - a default-constructed History is the empty document's baseline
//
// Every expected value of a data table was produced by running the canonical web module under node 24
// (2026-11-01) - tables spliced in as generated, never typed by hand.
class EditorHistoryTest : public QObject
{
    Q_OBJECT

private slots:
    // editorHistory — createHistory (베이스라인)
    void createsASingleEntryBaseline();
    void coercesANullInitialBodyToTheEmptyString();

    // editorHistory — push/undo/redo 왕복
    void walksBackToTheBaselineAndForwardToTheTop();

    // editorHistory — redo 분기 절단
    void dropsTheFutureBranchWhenPushingAfterUndo();
    void cutsTheRedoBranchEvenWithCoalesceBelowTheTop();

    // editorHistory — 동일 body no-op
    void returnsTheSameHistoryForTheCurrentBody();
    void isANoOpEvenWithCoalesce();

    // editorHistory — 코얼레싱 (타이핑 연타)
    void coalescesLaterTypingIntoTheTop();
    void neverReplacesTheBaseline();

    // editorHistory — 상한(limit)
    void dropsTheOldestEntriesBeyondTheLimit();

    // editorHistory — 입력 불변 (mutate 금지)
    void pushDoesNotMutateTheInput();
    void coalescingDoesNotMutateTheInput();
    void undoAndRedoDoNotMutateTheInput();

    // editorHistory — body는 불투명 문자열
    void treatsTheBodyAsAnOpaqueString();

    // Port locks
    void replaysTheWebScripts_data();
    void replaysTheWebScripts();
    void neverNormalizesTheBody_data();
    void neverNormalizesTheBody();
    void limitDropsOnlyTheOldest_data();
    void limitDropsOnlyTheOldest();
    void aDefaultHistoryIsTheEmptyBaseline();
};

#endif // CLIENT_QT_TESTS_EDITORHISTORYTEST_H
