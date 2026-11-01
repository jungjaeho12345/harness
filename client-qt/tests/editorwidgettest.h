#ifndef CLIENT_QT_TESTS_EDITORWIDGETTEST_H
#define CLIENT_QT_TESTS_EDITORWIDGETTEST_H

// ui/editorwidget.* (phase 78 step8) - the text engine, driven offscreen through its real event handlers (key events,
// input-method events, the clipboard routes, focus and mouse events). What this proves: every input path asks the
// step3 marker gate and leaves the body unchanged where input is blocked; the style runs are the role colours; the
// shortcuts run in the web's order and only outside a composition; nothing recolours while composing; edits are
// reported with their undo class. What it cannot prove: how a real MS-IME composition looks and whether the caret
// stays still on screen - a synthetic QInputMethodEvent is not an IME. That is the step10 eye check.

#include <QObject>

class EditorWidgetTest : public QObject
{
    Q_OBJECT

private slots:
    void rendersOneDocumentBlockPerTextLine();
    void styleRunsMatchTheRoleColours();
    void recolorsOnTheTriggersOnly();
    void neverRecolorsWhileComposing();
    void typingIsGatedAtTheMarker();
    void enterIsGatedAndGoesThroughReplaceRange();
    void pasteIsGatedOnEveryRoute();
    void imeCommitIsGatedAndThePreeditStaysOutOfTheDocument();
    void imeCommitsThatCannotGoNativelyAreRouted();
    void shortcutsAreNeverInterceptedWhileComposing();
    void shortcutsRunInTheWebOrder_data();
    void shortcutsRunInTheWebOrder();
    void shortcutsKeepTheMarkerContract();
    void emptyLineBackspaceAndDeleteDeleteTheLine();
    void lineJoinsGoThroughTheMergeGate();
    void multiLineSelectionDeletesGoThroughReplaceRange();
    void nativeEditsAreMirroredExactly();
    void outOfBandDocumentChangesAreUndone();
    void dropsContextMenuAndTextDragsAreClosed();
    void documentUndoIsOffAndUndoKeysAreReported();
    void editsAreReportedWithTheirKind();
    void conversionIsGatedAtTheMarker();
    void overwriteModeReplacesWithinTheLineOnly();
    void altLettersDoNotTypeButAltGrDoes();
    void readOnlyRefusesEveryEdit();
    void caretIsTheStep4TextPoint();
    void copyCarriesTheRealText();
};

#endif // CLIENT_QT_TESTS_EDITORWIDGETTEST_H
