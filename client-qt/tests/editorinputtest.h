#ifndef CLIENT_QT_TESTS_EDITORINPUTTEST_H
#define CLIENT_QT_TESTS_EDITORINPUTTEST_H

// editor/editorinput.* (phase 78 step8) - the pure half of the text engine's input routing: the shortcut order, the
// Qt key event mapping, Qt's text-acceptance rule, the characters a document block cannot hold, the line join and
// the location of a native edit. Expected values come from the web canonical run under node 24 (the shortcut table),
// from live Qt objects (insertsText, isBlockBreakChar - the oracle is Qt itself) and from measurements on this machine
// (keyInputFromQt - the windows platform plugin's real key events, phase 78 step8 probe).

#include <QObject>

class EditorInputTest : public QObject
{
    Q_OBJECT

private slots:
    void shortcutOrderIsTheWebOnKeyDownOrder();
    void shortcutForFollowsTheWebOrder_data();
    void shortcutForFollowsTheWebOrder();
    void shortcutForIsTheFirstFiringPredicate();
    void mapsMeasuredQtKeyEventsToKeyInput_data();
    void mapsMeasuredQtKeyEventsToKeyInput();
    void insertsTextExactlyWhereQtTypes();
    void blockBreakCharsAreWhatQtSplitsOn();
    void displayLineKeepsTheLengthAndHidesBreaks_data();
    void displayLineKeepsTheLengthAndHidesBreaks();
    void joinsTwoTextLines_data();
    void joinsTwoTextLines();
    void joinEqualsTheRangeDeleteWhenNoMarkerLineTakesPart();
    void locatesANativeEditFromItsAnchor_data();
    void locatesANativeEditFromItsAnchor();
};

#endif // CLIENT_QT_TESTS_EDITORINPUTTEST_H
