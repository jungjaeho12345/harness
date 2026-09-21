#ifndef CLIENT_QT_TESTS_EDITORROLESTEST_H
#define CLIENT_QT_TESTS_EDITORROLESTEST_H

#include <QObject>

// editor::classifyLines / colorForRole / isInputBlocked / END_MARKER (phase 78 step0) - the P0
// spike's pure logic moved into the production editor layer.
//
// Cases come from three places: the spike self-test (spikes/p0-qt-editor/selftest.cpp T1/T2 - its
// pure half), the web specs (editorColoring.test.js "structure & colors" 1-4, editorNewline.test.js
// the two isInputBlocked cases) and region boundaries. Every expected value was produced by running
// the canonical web functions under node (2026-09-22), not by reading their source.
//
// Not here (owned by later steps): colorLines / shouldRecolor / user colour preferences (step2 · P6),
// the exhaustive trim comparison of the "(끝)" line (step2), the rest of editorNewline.js (step3).
class EditorRolesTest : public QObject
{
    Q_OBJECT

private slots:
    void endMarkerIsTheCanonicalLiteral();
    void classifiesLines_data();
    void classifiesLines();
    void colorsMatchTheWebDefaults();
    void gatesInputAtTheLastMarker_data();
    void gatesInputAtTheLastMarker();
};

#endif // CLIENT_QT_TESTS_EDITORROLESTEST_H
