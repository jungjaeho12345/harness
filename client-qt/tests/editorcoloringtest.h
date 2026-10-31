#ifndef CLIENT_QT_TESTS_EDITORCOLORINGTEST_H
#define CLIENT_QT_TESTS_EDITORCOLORINGTEST_H

#include <QObject>

// editor/editorroles.* against web/src/view/editorColoring.js rule by rule (phase 78 step2).
//
// The first seven functions are editorColoring.test.js in its order: "structure & colors" 1-6 and
// "user-configurable active colors" 7 (defaults). Web 8-10 exercise setEditorColors /
// resetEditorColors, the override mechanism - that is P6 (index.json excluded (a) · step2.md 작업 2:
// defaults only); the half of those three that holds without a setter (title/body stay the
// defaults, "(끝)" stays gold, COLORS is a constant) is locked by function 7.
//
// The remaining functions are boundaries the web file leaves implicit: the subtitle region
// (indices 1..4, "blank" = exactly empty), the "(끝)" line judged by JS String.prototype.trim()
// (NOT QString::trimmed() - U+0085 / U+FEFF differ), colorLines splitting on "\n" alone, and the
// recolor trigger table. Every expected value was produced by running the canonical web module
// under node (2026-11-01), not by reading its source.
class EditorColoringTest : public QObject
{
    Q_OBJECT

private slots:
    // editorColoring.test.js, in order.
    void firstLineTitleLines2to5SubtitleThenBody();
    void blankLineInSubtitleRegionMakesBodyStartAtLine2();
    void endMarkerLineIsEndRegardlessOfPosition();
    void colorsMapTitleBlueSubtitleRedBodyInkEndGold();
    void colorLinesReturnsTextRoleColorPerLine();
    void doesNotRecolorDuringCompositionRecolorsOnEndBlurLoad();
    void defaultsAreTheWebColorsWithoutAnyOverride();

    // Boundaries.
    void subtitleRegionBoundaries_data();
    void subtitleRegionBoundaries();
    void endLineIsJudgedWithJsTrim_data();
    void endLineIsJudgedWithJsTrim();
    void colorLinesSplitsOnLineFeedOnly_data();
    void colorLinesSplitsOnLineFeedOnly();
    void recolorTriggerTable_data();
    void recolorTriggerTable();
};

#endif // CLIENT_QT_TESTS_EDITORCOLORINGTEST_H
