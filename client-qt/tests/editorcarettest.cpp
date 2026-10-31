#include "editorcarettest.h"

#include "editor/editorcaret.h"

#include <QString>
#include <QStringList>
#include <QtTest>

#include <climits>

// ---- editorCaret — line math ------------------------------------------------------------------

// it: 'splits text into lines'
void EditorCaretTest::splitsTextIntoLines()
{
    QCOMPARE(editor::lines(QStringLiteral("a\nb\nc")),
             (QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")}));
}

// it: 'lineAtOffset finds the line index and bounds for a caret'
void EditorCaretTest::lineAtOffsetFindsTheLineIndexAndBounds()
{
    const QString text = QStringLiteral("aa\nbbb\nc");

    const editor::LineBounds first = editor::lineAtOffset(text, 0);
    QCOMPARE(first.lineIndex, 0);
    QCOMPARE(first.start, 0);
    QCOMPARE(first.end, 2);

    const editor::LineBounds within = editor::lineAtOffset(text, 4); // within "bbb"
    QCOMPARE(within.lineIndex, 1);
    QCOMPARE(within.start, 3);
    QCOMPARE(within.end, 6);

    const editor::LineBounds atEnd = editor::lineAtOffset(text, int(text.size()));
    QCOMPARE(atEnd.lineIndex, 2);
    QCOMPARE(atEnd.start, 7);
    QCOMPARE(atEnd.end, 8);
}

// it: 'clamps out-of-range offsets'
void EditorCaretTest::clampsOutOfRangeOffsets()
{
    QCOMPARE(editor::lineAtOffset(QStringLiteral("abc"), -5).lineIndex, 0);
    QCOMPARE(editor::lineAtOffset(QStringLiteral("abc"), 999).lineIndex, 0);
}

// it: 'removeLineFromText removes the target line and returns the removed text'
void EditorCaretTest::removeLineRemovesTheTargetLineAndReturnsIt()
{
    const editor::LineRemoval r = editor::removeLineFromText(QStringLiteral("a\nb\nc"), 1);
    QCOMPARE(r.text, QStringLiteral("a\nc"));
    QVERIFY(r.removed.has_value());
    QCOMPARE(*r.removed, QStringLiteral("b"));
}

// it: 'removeLineFromText positions caret at the line that took the slot'
void EditorCaretTest::removeLinePutsTheCaretAtTheLineThatTookTheSlot()
{
    const editor::LineRemoval r = editor::removeLineFromText(QStringLiteral("a\nb\nc"), 1);
    // 남은 텍스트 "a\nc" 에서 인덱스 1 자리(=c)의 시작 오프셋 2.
    QCOMPARE(r.caret, 2);
}

// it: 'removeLineFromText is a no-op for out-of-range indexes'
void EditorCaretTest::removeLineIsANoOpOutOfRange()
{
    const editor::LineRemoval r = editor::removeLineFromText(QStringLiteral("a\nb"), 5);
    QCOMPARE(r.text, QStringLiteral("a\nb"));
    QVERIFY(!r.removed.has_value()); // the web's removed: null
    QCOMPARE(r.caret, 0);
}

// ---- Port locks ------------------------------------------------------------------------------

// lines() is JS split('\n'): only LF separates - CR, LS, PS and NEL stay inside a line.
void EditorCaretTest::linesSplitsOnLineFeedOnly_data()
{
    QTest::addColumn<QString>("text");
    QTest::addColumn<QStringList>("expected");

    QTest::newRow("empty text is one empty line") << QStringLiteral("") << QStringList{QStringLiteral("")};
    QTest::newRow("no newline is one line") << QStringLiteral("abc") << QStringList{QStringLiteral("abc")};
    QTest::newRow("a lone LF is two empty lines") << QStringLiteral("\n") << QStringList{QStringLiteral(""), QStringLiteral("")};
    QTest::newRow("trailing LF leaves a trailing empty line") << QStringLiteral("a\n") << QStringList{QStringLiteral("a"), QStringLiteral("")};
    QTest::newRow("leading LF leaves a leading empty line") << QStringLiteral("\na") << QStringList{QStringLiteral(""), QStringLiteral("a")};
    QTest::newRow("three lines") << QStringLiteral("a\nb\nc") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")};
    QTest::newRow("two LFs are three empty lines") << QStringLiteral("\n\n") << QStringList{QStringLiteral(""), QStringLiteral(""), QStringLiteral("")};
    QTest::newRow("CR of CRLF stays in the line") << QStringLiteral("a\r\nb") << QStringList{QStringLiteral("a\r"), QStringLiteral("b")};
    QTest::newRow("lone CR does not split") << QStringLiteral("a\rb") << QStringList{QStringLiteral("a\rb")};
    QTest::newRow("LS U+2028 does not split") << QStringLiteral("a\u2028b") << QStringList{QStringLiteral("a\u2028b")};
    QTest::newRow("PS U+2029 does not split") << QStringLiteral("a\u2029b") << QStringList{QStringLiteral("a\u2029b")};
    QTest::newRow("NEL U+0085 does not split") << QStringLiteral("a\u0085b") << QStringList{QStringLiteral("a\u0085b")};
    QTest::newRow("hangul lines") << QStringLiteral("가나\n다라마") << QStringList{QStringLiteral("가나"), QStringLiteral("다라마")};
}

void EditorCaretTest::linesSplitsOnLineFeedOnly()
{
    QFETCH(QString, text);
    QFETCH(QStringList, expected);
    QCOMPARE(editor::lines(text), expected);
}

// lineAtOffset at every offset of a few texts, one past each end and the int extremes: the clamp, an
// offset on a "\n" (it belongs to the line the "\n" ends), CRLF, Hangul and an offset inside a surrogate
// pair - all in UTF-16 code units.
void EditorCaretTest::lineAtOffsetAtEveryOffset_data()
{
    QTest::addColumn<QString>("text");
    QTest::addColumn<int>("offset");
    QTest::addColumn<int>("lineIndex");
    QTest::addColumn<int>("start");
    QTest::addColumn<int>("end");

    QTest::newRow("web text @-1") << QStringLiteral("aa\nbbb\nc") << -1 << 0 << 0 << 2;
    QTest::newRow("web text @0") << QStringLiteral("aa\nbbb\nc") << 0 << 0 << 0 << 2;
    QTest::newRow("web text @1") << QStringLiteral("aa\nbbb\nc") << 1 << 0 << 0 << 2;
    QTest::newRow("web text @2") << QStringLiteral("aa\nbbb\nc") << 2 << 0 << 0 << 2;
    QTest::newRow("web text @3") << QStringLiteral("aa\nbbb\nc") << 3 << 1 << 3 << 6;
    QTest::newRow("web text @4") << QStringLiteral("aa\nbbb\nc") << 4 << 1 << 3 << 6;
    QTest::newRow("web text @5") << QStringLiteral("aa\nbbb\nc") << 5 << 1 << 3 << 6;
    QTest::newRow("web text @6") << QStringLiteral("aa\nbbb\nc") << 6 << 1 << 3 << 6;
    QTest::newRow("web text @7") << QStringLiteral("aa\nbbb\nc") << 7 << 2 << 7 << 8;
    QTest::newRow("web text @8") << QStringLiteral("aa\nbbb\nc") << 8 << 2 << 7 << 8;
    QTest::newRow("web text @9") << QStringLiteral("aa\nbbb\nc") << 9 << 2 << 7 << 8;
    QTest::newRow("web text @INT_MIN") << QStringLiteral("aa\nbbb\nc") << INT_MIN << 0 << 0 << 2;
    QTest::newRow("web text @INT_MAX") << QStringLiteral("aa\nbbb\nc") << INT_MAX << 2 << 7 << 8;
    QTest::newRow("empty @-1") << QStringLiteral("") << -1 << 0 << 0 << 0;
    QTest::newRow("empty @0") << QStringLiteral("") << 0 << 0 << 0 << 0;
    QTest::newRow("empty @1") << QStringLiteral("") << 1 << 0 << 0 << 0;
    QTest::newRow("two LFs @-1") << QStringLiteral("\n\n") << -1 << 0 << 0 << 0;
    QTest::newRow("two LFs @0") << QStringLiteral("\n\n") << 0 << 0 << 0 << 0;
    QTest::newRow("two LFs @1") << QStringLiteral("\n\n") << 1 << 1 << 1 << 1;
    QTest::newRow("two LFs @2") << QStringLiteral("\n\n") << 2 << 2 << 2 << 2;
    QTest::newRow("two LFs @3") << QStringLiteral("\n\n") << 3 << 2 << 2 << 2;
    QTest::newRow("trailing LF @2") << QStringLiteral("ab\n") << 2 << 0 << 0 << 2;
    QTest::newRow("trailing LF @3") << QStringLiteral("ab\n") << 3 << 1 << 3 << 3;
    QTest::newRow("trailing LF @4") << QStringLiteral("ab\n") << 4 << 1 << 3 << 3;
    QTest::newRow("CRLF @0") << QStringLiteral("a\r\nb") << 0 << 0 << 0 << 2;
    QTest::newRow("CRLF @1") << QStringLiteral("a\r\nb") << 1 << 0 << 0 << 2;
    QTest::newRow("CRLF @2") << QStringLiteral("a\r\nb") << 2 << 0 << 0 << 2;
    QTest::newRow("CRLF @3") << QStringLiteral("a\r\nb") << 3 << 1 << 3 << 4;
    QTest::newRow("CRLF @4") << QStringLiteral("a\r\nb") << 4 << 1 << 3 << 4;
    QTest::newRow("hangul @0") << QStringLiteral("가나\n다") << 0 << 0 << 0 << 2;
    QTest::newRow("hangul @1") << QStringLiteral("가나\n다") << 1 << 0 << 0 << 2;
    QTest::newRow("hangul @2") << QStringLiteral("가나\n다") << 2 << 0 << 0 << 2;
    QTest::newRow("hangul @3") << QStringLiteral("가나\n다") << 3 << 1 << 3 << 4;
    QTest::newRow("hangul @4") << QStringLiteral("가나\n다") << 4 << 1 << 3 << 4;
    QTest::newRow("hangul @5") << QStringLiteral("가나\n다") << 5 << 1 << 3 << 4;
    QTest::newRow("astral @0") << QStringLiteral("x\U0001F600\ny") << 0 << 0 << 0 << 3;
    QTest::newRow("astral @1") << QStringLiteral("x\U0001F600\ny") << 1 << 0 << 0 << 3;
    QTest::newRow("astral @2") << QStringLiteral("x\U0001F600\ny") << 2 << 0 << 0 << 3;
    QTest::newRow("astral @3") << QStringLiteral("x\U0001F600\ny") << 3 << 0 << 0 << 3;
    QTest::newRow("astral @4") << QStringLiteral("x\U0001F600\ny") << 4 << 1 << 4 << 5;
    QTest::newRow("astral @5") << QStringLiteral("x\U0001F600\ny") << 5 << 1 << 4 << 5;
}

void EditorCaretTest::lineAtOffsetAtEveryOffset()
{
    QFETCH(QString, text);
    QFETCH(int, offset);
    QFETCH(int, lineIndex);
    QFETCH(int, start);
    QFETCH(int, end);
    const editor::LineBounds bounds = editor::lineAtOffset(text, offset);
    QCOMPARE(bounds.lineIndex, lineIndex);
    QCOMPARE(bounds.start, start);
    QCOMPARE(bounds.end, end);
}

// removeLineFromText at every line index of a few texts, one past each end and the int extremes: the
// removed line (an empty line is "" - not the out-of-range "nothing"), the joined rest and the caret.
void EditorCaretTest::removeLineAtEveryIndex_data()
{
    QTest::addColumn<QString>("text");
    QTest::addColumn<int>("lineIndex");
    QTest::addColumn<QString>("newText");
    QTest::addColumn<bool>("removedSome");
    QTest::addColumn<QString>("removed");
    QTest::addColumn<int>("caret");

    QTest::newRow("three lines #-1") << QStringLiteral("a\nb\nc") << -1 << QStringLiteral("a\nb\nc") << false << QString() << 0;
    QTest::newRow("three lines #0") << QStringLiteral("a\nb\nc") << 0 << QStringLiteral("b\nc") << true << QStringLiteral("a") << 0;
    QTest::newRow("three lines #1") << QStringLiteral("a\nb\nc") << 1 << QStringLiteral("a\nc") << true << QStringLiteral("b") << 2;
    QTest::newRow("three lines #2") << QStringLiteral("a\nb\nc") << 2 << QStringLiteral("a\nb") << true << QStringLiteral("c") << 2;
    QTest::newRow("three lines #3") << QStringLiteral("a\nb\nc") << 3 << QStringLiteral("a\nb\nc") << false << QString() << 0;
    QTest::newRow("three lines #INT_MIN") << QStringLiteral("a\nb\nc") << INT_MIN << QStringLiteral("a\nb\nc") << false << QString() << 0;
    QTest::newRow("three lines #INT_MAX") << QStringLiteral("a\nb\nc") << INT_MAX << QStringLiteral("a\nb\nc") << false << QString() << 0;
    QTest::newRow("empty text #-1") << QStringLiteral("") << -1 << QStringLiteral("") << false << QString() << 0;
    QTest::newRow("empty text #0") << QStringLiteral("") << 0 << QStringLiteral("") << true << QStringLiteral("") << 0;
    QTest::newRow("empty text #1") << QStringLiteral("") << 1 << QStringLiteral("") << false << QString() << 0;
    QTest::newRow("one line #0") << QStringLiteral("abc") << 0 << QStringLiteral("") << true << QStringLiteral("abc") << 0;
    QTest::newRow("one line #1") << QStringLiteral("abc") << 1 << QStringLiteral("abc") << false << QString() << 0;
    QTest::newRow("trailing LF #0") << QStringLiteral("a\n") << 0 << QStringLiteral("") << true << QStringLiteral("a") << 0;
    QTest::newRow("trailing LF #1") << QStringLiteral("a\n") << 1 << QStringLiteral("a") << true << QStringLiteral("") << 0;
    QTest::newRow("trailing LF #2") << QStringLiteral("a\n") << 2 << QStringLiteral("a\n") << false << QString() << 0;
    QTest::newRow("lone LF #0") << QStringLiteral("\n") << 0 << QStringLiteral("") << true << QStringLiteral("") << 0;
    QTest::newRow("lone LF #1") << QStringLiteral("\n") << 1 << QStringLiteral("") << true << QStringLiteral("") << 0;
    QTest::newRow("empty middle line #0") << QStringLiteral("a\n\nb") << 0 << QStringLiteral("\nb") << true << QStringLiteral("a") << 0;
    QTest::newRow("empty middle line #1") << QStringLiteral("a\n\nb") << 1 << QStringLiteral("a\nb") << true << QStringLiteral("") << 2;
    QTest::newRow("empty middle line #2") << QStringLiteral("a\n\nb") << 2 << QStringLiteral("a\n") << true << QStringLiteral("b") << 2;
    QTest::newRow("hangul #0") << QStringLiteral("가\n나다\n라") << 0 << QStringLiteral("나다\n라") << true << QStringLiteral("가") << 0;
    QTest::newRow("hangul #1") << QStringLiteral("가\n나다\n라") << 1 << QStringLiteral("가\n라") << true << QStringLiteral("나다") << 2;
    QTest::newRow("hangul #2") << QStringLiteral("가\n나다\n라") << 2 << QStringLiteral("가\n나다") << true << QStringLiteral("라") << 2;
    QTest::newRow("CRLF #0") << QStringLiteral("x\r\ny") << 0 << QStringLiteral("y") << true << QStringLiteral("x\r") << 0;
    QTest::newRow("CRLF #1") << QStringLiteral("x\r\ny") << 1 << QStringLiteral("x\r") << true << QStringLiteral("y") << 0;
}

void EditorCaretTest::removeLineAtEveryIndex()
{
    QFETCH(QString, text);
    QFETCH(int, lineIndex);
    QFETCH(QString, newText);
    QFETCH(bool, removedSome);
    QFETCH(QString, removed);
    QFETCH(int, caret);
    const editor::LineRemoval r = editor::removeLineFromText(text, lineIndex);
    QCOMPARE(r.text, newText);
    QCOMPARE(r.removed.has_value(), removedSome);
    if (removedSome)
        QCOMPARE(*r.removed, removed);
    QCOMPARE(r.caret, caret);
}
