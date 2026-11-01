#include "editorrangetest.h"

#include "editor/editorcaret.h"
#include "editor/editorcontent.h"
#include "editor/editornewline.h"
#include "editor/editorrange.h"

#include <QChar>
#include <QLatin1Char>
#include <QLatin1String>
#include <QString>
#include <QStringList>
#include <QVector>
#include <QtTest>

#include <climits>
#include <initializer_list>

namespace {

// A string built code unit by code unit - the only way to spell a lone surrogate (no C++ literal can).
QString units(std::initializer_list<char16_t> codeUnits)
{
    QString out;
    for (const char16_t unit : codeUnits)
        out.append(QChar(unit));
    return out;
}

// The data tables spell a point "lineIndex:offset".
editor::TextPoint point(const QString &spec)
{
    const QStringList parts = spec.split(QLatin1Char(':'));
    return editor::TextPoint{parts.at(0).toInt(), parts.at(1).toInt()};
}

QString spec(const editor::TextPoint &p)
{
    return QStringLiteral("%1:%2").arg(p.lineIndex).arg(p.offset);
}

// The absolute offset where text line `line` starts (the lines before it plus one "\n" each).
int lineStartOf(const QStringList &textLines, int line)
{
    int offset = 0;
    for (int i = 0; i < line; ++i)
        offset += int(textLines.at(i).size()) + 1;
    return offset;
}

} // namespace

// ---- editorRange — wordBoundsAt ---------------------------------------------------------------

// it: '단어 중간이면 그 단어 전체 범위를 반환한다'
void EditorRangeTest::midWordReturnsTheWholeWord()
{
    const editor::WordBounds b = editor::wordBoundsAt(QStringLiteral("foo bar"), 1);
    QCOMPARE(b.start, 0);
    QCOMPARE(b.end, 3);
}

// it: '단어 시작 경계면 그 단어를 반환한다'
void EditorRangeTest::wordStartEdgeReturnsThatWord()
{
    const editor::WordBounds b = editor::wordBoundsAt(QStringLiteral("foo bar"), 4);
    QCOMPARE(b.start, 4);
    QCOMPARE(b.end, 7);
}

// it: '단어 끝 경계(오른쪽이 공백)면 그 단어를 반환한다'
void EditorRangeTest::wordEndEdgeReturnsThatWord()
{
    const editor::WordBounds b = editor::wordBoundsAt(QStringLiteral("foo bar"), 3);
    QCOMPARE(b.start, 0);
    QCOMPARE(b.end, 3);
}

// it: '두 단어 사이 공백 위면 캐럿 왼쪽 단어를 반환한다'
void EditorRangeTest::whitespaceBetweenWordsTakesTheLeftWord()
{
    const editor::WordBounds b = editor::wordBoundsAt(QStringLiteral("foo   bar"), 5);
    QCOMPARE(b.start, 0);
    QCOMPARE(b.end, 3);
}

// it: '선행 공백 위(왼쪽에 단어 없음)면 오른쪽 단어를 반환한다'
void EditorRangeTest::leadingWhitespaceTakesTheRightWord()
{
    const editor::WordBounds b = editor::wordBoundsAt(QStringLiteral("   foo"), 1);
    QCOMPARE(b.start, 3);
    QCOMPARE(b.end, 6);
}

// it: '전부 공백인 줄이면 빈 범위(start === end)를 반환한다'
void EditorRangeTest::whitespaceOnlyLineGivesTheEmptyRange()
{
    const editor::WordBounds b = editor::wordBoundsAt(QStringLiteral("    "), 2);
    QCOMPARE(b.start, 2);
    QCOMPARE(b.end, 2);
}

// it: '빈 문자열이면 빈 범위를 반환한다'
void EditorRangeTest::emptyLineGivesTheEmptyRange()
{
    const editor::WordBounds b = editor::wordBoundsAt(QStringLiteral(""), 0);
    QCOMPARE(b.start, 0);
    QCOMPARE(b.end, 0);
    const editor::WordBounds null = editor::wordBoundsAt(QString(), 0); // web String(lineText ?? '')
    QCOMPARE(null.start, 0);
    QCOMPARE(null.end, 0);
}

// it: 'column을 [0, length]로 clamp한다'
void EditorRangeTest::columnIsClampedIntoTheLine()
{
    const editor::WordBounds past = editor::wordBoundsAt(QStringLiteral("foo"), 999);
    QCOMPARE(past.start, 0);
    QCOMPARE(past.end, 3);
    const editor::WordBounds before = editor::wordBoundsAt(QStringLiteral("foo"), -5);
    QCOMPARE(before.start, 0);
    QCOMPARE(before.end, 3);
}

// it: '한글/혼합 텍스트에서도 \S 런 단위로 잡는다'
void EditorRangeTest::hangulAndMixedTextUseNonSpaceRuns()
{
    const editor::WordBounds hangul = editor::wordBoundsAt(QStringLiteral("안녕하세요 세계"), 2);
    QCOMPARE(hangul.start, 0);
    QCOMPARE(hangul.end, 5);
    const editor::WordBounds mixed = editor::wordBoundsAt(QStringLiteral("한글 English 혼합"), 7);
    QCOMPARE(mixed.start, 3);
    QCOMPARE(mixed.end, 10);
}

// ---- editorRange — paragraphBoundsAt ----------------------------------------------------------

// it: '단일 문단이면 전체 줄 범위를 반환한다'
void EditorRangeTest::singleParagraphSpansEveryLine()
{
    const editor::ParagraphBounds p =
        editor::paragraphBoundsAt({QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")}, 1);
    QCOMPARE(p.startLine, 0);
    QCOMPARE(p.endLine, 2);
}

// it: '빈 줄로 나뉜 2문단에서 지정한 줄의 문단만 반환한다'
void EditorRangeTest::twoParagraphsSplitByABlankLine()
{
    const QStringList arr{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral(""), QStringLiteral("c"),
                          QStringLiteral("d")};
    const editor::ParagraphBounds first = editor::paragraphBoundsAt(arr, 0);
    QCOMPARE(first.startLine, 0);
    QCOMPARE(first.endLine, 1);
    const editor::ParagraphBounds second = editor::paragraphBoundsAt(arr, 3);
    QCOMPARE(second.startLine, 3);
    QCOMPARE(second.endLine, 4);
}

// it: '빈 줄을 지정하면 그 빈 줄 하나만 반환한다'
void EditorRangeTest::blankLineIsItsOwnParagraph()
{
    const editor::ParagraphBounds p = editor::paragraphBoundsAt(
        {QStringLiteral("a"), QStringLiteral("b"), QStringLiteral(""), QStringLiteral("c")}, 2);
    QCOMPARE(p.startLine, 2);
    QCOMPARE(p.endLine, 2);
}

// it: '연속 빈 줄은 각각 자기 자신만 반환한다'
void EditorRangeTest::consecutiveBlankLinesAreEachTheirOwn()
{
    const QStringList arr{QStringLiteral("a"), QStringLiteral(""), QStringLiteral(""), QStringLiteral("b")};
    const editor::ParagraphBounds one = editor::paragraphBoundsAt(arr, 1);
    QCOMPARE(one.startLine, 1);
    QCOMPARE(one.endLine, 1);
    const editor::ParagraphBounds two = editor::paragraphBoundsAt(arr, 2);
    QCOMPARE(two.startLine, 2);
    QCOMPARE(two.endLine, 2);
}

// it: '공백만 있는 줄은 비-빈 줄로 취급한다 (editorStats.paragraphIndex와 동일 정의)'
void EditorRangeTest::whitespaceOnlyLineIsNotBlank()
{
    const editor::ParagraphBounds p =
        editor::paragraphBoundsAt({QStringLiteral("a"), QStringLiteral(" "), QStringLiteral("b")}, 0);
    QCOMPARE(p.startLine, 0);
    QCOMPARE(p.endLine, 2);
}

// it: 'lineIndex가 범위 밖이면 clamp한다'
void EditorRangeTest::lineIndexIsClamped()
{
    const QStringList arr{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral(""), QStringLiteral("c")};
    const editor::ParagraphBounds before = editor::paragraphBoundsAt(arr, -5);
    QCOMPARE(before.startLine, 0);
    QCOMPARE(before.endLine, 1);
    const editor::ParagraphBounds past = editor::paragraphBoundsAt(arr, 999);
    QCOMPARE(past.startLine, 3);
    QCOMPARE(past.endLine, 3);
}

// it: '한글 문단에서도 동일하게 동작한다'
void EditorRangeTest::hangulParagraphs()
{
    const QStringList arr{QStringLiteral("제목입니다"), QStringLiteral("부제목"), QStringLiteral(""),
                          QStringLiteral("본문 내용입니다")};
    const editor::ParagraphBounds head = editor::paragraphBoundsAt(arr, 1);
    QCOMPARE(head.startLine, 0);
    QCOMPARE(head.endLine, 1);
    const editor::ParagraphBounds body = editor::paragraphBoundsAt(arr, 3);
    QCOMPARE(body.startLine, 3);
    QCOMPARE(body.endLine, 3);
}

// it: '입력 배열을 변형하지 않는다' - const& already forbids it; the list is compared anyway, as the web does.
void EditorRangeTest::inputListIsNotMutated()
{
    const QStringList arr{QStringLiteral("a"), QStringLiteral(""), QStringLiteral("b")};
    editor::paragraphBoundsAt(arr, 2);
    QCOMPARE(arr, (QStringList{QStringLiteral("a"), QStringLiteral(""), QStringLiteral("b")}));
}

// ---- Port locks ------------------------------------------------------------------------------

// wordBoundsAt at every column of a few lines, one past each end and the int extremes: on a word unit
// (that word), on whitespace or the line end (the LEFT word first, the right one only when there is none
// on the left), no word at all (start == end at the clamped column - the empty range). end is exclusive
// in every row. Units are UTF-16 code units: an astral character is two word units, a lone surrogate is
// one.
void EditorRangeTest::wordBoundsAtEveryColumn_data()
{
    QTest::addColumn<QString>("line");
    QTest::addColumn<int>("column");
    QTest::addColumn<int>("start");
    QTest::addColumn<int>("end");

    QTest::newRow("foo bar @-1") << QStringLiteral("foo bar") << -1 << 0 << 3;
    QTest::newRow("foo bar @0") << QStringLiteral("foo bar") << 0 << 0 << 3;
    QTest::newRow("foo bar @1") << QStringLiteral("foo bar") << 1 << 0 << 3;
    QTest::newRow("foo bar @2") << QStringLiteral("foo bar") << 2 << 0 << 3;
    QTest::newRow("foo bar @3") << QStringLiteral("foo bar") << 3 << 0 << 3;
    QTest::newRow("foo bar @4") << QStringLiteral("foo bar") << 4 << 4 << 7;
    QTest::newRow("foo bar @5") << QStringLiteral("foo bar") << 5 << 4 << 7;
    QTest::newRow("foo bar @6") << QStringLiteral("foo bar") << 6 << 4 << 7;
    QTest::newRow("foo bar @7") << QStringLiteral("foo bar") << 7 << 4 << 7;
    QTest::newRow("foo bar @8") << QStringLiteral("foo bar") << 8 << 4 << 7;
    QTest::newRow("foo bar @INT_MIN") << QStringLiteral("foo bar") << INT_MIN << 0 << 3;
    QTest::newRow("foo bar @INT_MAX") << QStringLiteral("foo bar") << INT_MAX << 4 << 7;
    QTest::newRow("foo3bar @0") << QStringLiteral("foo   bar") << 0 << 0 << 3;
    QTest::newRow("foo3bar @1") << QStringLiteral("foo   bar") << 1 << 0 << 3;
    QTest::newRow("foo3bar @2") << QStringLiteral("foo   bar") << 2 << 0 << 3;
    QTest::newRow("foo3bar @3") << QStringLiteral("foo   bar") << 3 << 0 << 3;
    QTest::newRow("foo3bar @4") << QStringLiteral("foo   bar") << 4 << 0 << 3;
    QTest::newRow("foo3bar @5") << QStringLiteral("foo   bar") << 5 << 0 << 3;
    QTest::newRow("foo3bar @6") << QStringLiteral("foo   bar") << 6 << 6 << 9;
    QTest::newRow("foo3bar @7") << QStringLiteral("foo   bar") << 7 << 6 << 9;
    QTest::newRow("foo3bar @8") << QStringLiteral("foo   bar") << 8 << 6 << 9;
    QTest::newRow("foo3bar @9") << QStringLiteral("foo   bar") << 9 << 6 << 9;
    QTest::newRow("3foo @0") << QStringLiteral("   foo") << 0 << 3 << 6;
    QTest::newRow("3foo @1") << QStringLiteral("   foo") << 1 << 3 << 6;
    QTest::newRow("3foo @2") << QStringLiteral("   foo") << 2 << 3 << 6;
    QTest::newRow("3foo @3") << QStringLiteral("   foo") << 3 << 3 << 6;
    QTest::newRow("3foo @4") << QStringLiteral("   foo") << 4 << 3 << 6;
    QTest::newRow("3foo @5") << QStringLiteral("   foo") << 5 << 3 << 6;
    QTest::newRow("3foo @6") << QStringLiteral("   foo") << 6 << 3 << 6;
    QTest::newRow("sp ab sp2 cd sp @0") << QStringLiteral(" ab  cd ") << 0 << 1 << 3;
    QTest::newRow("sp ab sp2 cd sp @1") << QStringLiteral(" ab  cd ") << 1 << 1 << 3;
    QTest::newRow("sp ab sp2 cd sp @2") << QStringLiteral(" ab  cd ") << 2 << 1 << 3;
    QTest::newRow("sp ab sp2 cd sp @3") << QStringLiteral(" ab  cd ") << 3 << 1 << 3;
    QTest::newRow("sp ab sp2 cd sp @4") << QStringLiteral(" ab  cd ") << 4 << 1 << 3;
    QTest::newRow("sp ab sp2 cd sp @5") << QStringLiteral(" ab  cd ") << 5 << 5 << 7;
    QTest::newRow("sp ab sp2 cd sp @6") << QStringLiteral(" ab  cd ") << 6 << 5 << 7;
    QTest::newRow("sp ab sp2 cd sp @7") << QStringLiteral(" ab  cd ") << 7 << 5 << 7;
    QTest::newRow("sp ab sp2 cd sp @8") << QStringLiteral(" ab  cd ") << 8 << 5 << 7;
    QTest::newRow("4 spaces @-1") << QStringLiteral("    ") << -1 << 0 << 0;
    QTest::newRow("4 spaces @0") << QStringLiteral("    ") << 0 << 0 << 0;
    QTest::newRow("4 spaces @1") << QStringLiteral("    ") << 1 << 1 << 1;
    QTest::newRow("4 spaces @2") << QStringLiteral("    ") << 2 << 2 << 2;
    QTest::newRow("4 spaces @3") << QStringLiteral("    ") << 3 << 3 << 3;
    QTest::newRow("4 spaces @4") << QStringLiteral("    ") << 4 << 4 << 4;
    QTest::newRow("4 spaces @5") << QStringLiteral("    ") << 5 << 4 << 4;
    QTest::newRow("empty @-1") << QStringLiteral("") << -1 << 0 << 0;
    QTest::newRow("empty @0") << QStringLiteral("") << 0 << 0 << 0;
    QTest::newRow("empty @1") << QStringLiteral("") << 1 << 0 << 0;
    QTest::newRow("hangul @0") << QStringLiteral("안녕하세요 세계") << 0 << 0 << 5;
    QTest::newRow("hangul @1") << QStringLiteral("안녕하세요 세계") << 1 << 0 << 5;
    QTest::newRow("hangul @2") << QStringLiteral("안녕하세요 세계") << 2 << 0 << 5;
    QTest::newRow("hangul @3") << QStringLiteral("안녕하세요 세계") << 3 << 0 << 5;
    QTest::newRow("hangul @4") << QStringLiteral("안녕하세요 세계") << 4 << 0 << 5;
    QTest::newRow("hangul @5") << QStringLiteral("안녕하세요 세계") << 5 << 0 << 5;
    QTest::newRow("hangul @6") << QStringLiteral("안녕하세요 세계") << 6 << 6 << 8;
    QTest::newRow("hangul @7") << QStringLiteral("안녕하세요 세계") << 7 << 6 << 8;
    QTest::newRow("hangul @8") << QStringLiteral("안녕하세요 세계") << 8 << 6 << 8;
    QTest::newRow("mixed @0") << QStringLiteral("한글 English 혼합") << 0 << 0 << 2;
    QTest::newRow("mixed @2") << QStringLiteral("한글 English 혼합") << 2 << 0 << 2;
    QTest::newRow("mixed @3") << QStringLiteral("한글 English 혼합") << 3 << 3 << 10;
    QTest::newRow("mixed @7") << QStringLiteral("한글 English 혼합") << 7 << 3 << 10;
    QTest::newRow("mixed @10") << QStringLiteral("한글 English 혼합") << 10 << 3 << 10;
    QTest::newRow("mixed @11") << QStringLiteral("한글 English 혼합") << 11 << 11 << 13;
    QTest::newRow("mixed @13") << QStringLiteral("한글 English 혼합") << 13 << 11 << 13;
    QTest::newRow("mixed @14") << QStringLiteral("한글 English 혼합") << 14 << 11 << 13;
    QTest::newRow("tab @0") << QStringLiteral("a\tb") << 0 << 0 << 1;
    QTest::newRow("tab @1") << QStringLiteral("a\tb") << 1 << 0 << 1;
    QTest::newRow("tab @2") << QStringLiteral("a\tb") << 2 << 2 << 3;
    QTest::newRow("tab @3") << QStringLiteral("a\tb") << 3 << 2 << 3;
    QTest::newRow("astral @0") << QStringLiteral("x\U0001F600 y") << 0 << 0 << 3;
    QTest::newRow("astral @1") << QStringLiteral("x\U0001F600 y") << 1 << 0 << 3;
    QTest::newRow("astral @2") << QStringLiteral("x\U0001F600 y") << 2 << 0 << 3;
    QTest::newRow("astral @3") << QStringLiteral("x\U0001F600 y") << 3 << 0 << 3;
    QTest::newRow("astral @4") << QStringLiteral("x\U0001F600 y") << 4 << 4 << 5;
    QTest::newRow("astral @5") << QStringLiteral("x\U0001F600 y") << 5 << 4 << 5;
    QTest::newRow("lone high surrogate @0") << units({0x0061, 0x0020, 0xD83D, 0x0020, 0x0062}) << 0 << 0 << 1;
    QTest::newRow("lone high surrogate @1") << units({0x0061, 0x0020, 0xD83D, 0x0020, 0x0062}) << 1 << 0 << 1;
    QTest::newRow("lone high surrogate @2") << units({0x0061, 0x0020, 0xD83D, 0x0020, 0x0062}) << 2 << 2 << 3;
    QTest::newRow("lone high surrogate @3") << units({0x0061, 0x0020, 0xD83D, 0x0020, 0x0062}) << 3 << 2 << 3;
    QTest::newRow("lone high surrogate @4") << units({0x0061, 0x0020, 0xD83D, 0x0020, 0x0062}) << 4 << 4 << 5;
    QTest::newRow("lone high surrogate @5") << units({0x0061, 0x0020, 0xD83D, 0x0020, 0x0062}) << 5 << 4 << 5;
    QTest::newRow("lone low surrogate @0") << units({0xDE00, 0x0020, 0x0061}) << 0 << 0 << 1;
    QTest::newRow("lone low surrogate @1") << units({0xDE00, 0x0020, 0x0061}) << 1 << 0 << 1;
    QTest::newRow("lone low surrogate @2") << units({0xDE00, 0x0020, 0x0061}) << 2 << 2 << 3;
    QTest::newRow("lone low surrogate @3") << units({0xDE00, 0x0020, 0x0061}) << 3 << 2 << 3;
}

void EditorRangeTest::wordBoundsAtEveryColumn()
{
    QFETCH(QString, line);
    QFETCH(int, column);
    QFETCH(int, start);
    QFETCH(int, end);
    const editor::WordBounds b = editor::wordBoundsAt(line, column);
    QCOMPARE(b.start, start);
    QCOMPARE(b.end, end);
}

// The word splitter is JS /\S/ per code unit - the whitespace set String.prototype.trim() strips (node
// checked the two are the same set before emitting a row). Each row is "a" + one unit + "b" with the caret
// on that unit: whitespace -> the left word "a" = [0, 1); anything else -> one word [0, 3). U+0085 (a word
// unit) and U+FEFF (whitespace) are the two rows QChar::isSpace() gets wrong.
void EditorRangeTest::wordsSplitOnTheJsWhitespaceSet_data()
{
    QTest::addColumn<QString>("line");
    QTest::addColumn<int>("column");
    QTest::addColumn<int>("start");
    QTest::addColumn<int>("end");

    QTest::newRow("U+0009 splits words") << QStringLiteral("a\tb") << 1 << 0 << 1;
    QTest::newRow("U+000A splits words") << QStringLiteral("a\nb") << 1 << 0 << 1;
    QTest::newRow("U+000B splits words") << QStringLiteral("a\u000Bb") << 1 << 0 << 1;
    QTest::newRow("U+000C splits words") << QStringLiteral("a\u000Cb") << 1 << 0 << 1;
    QTest::newRow("U+000D splits words") << QStringLiteral("a\rb") << 1 << 0 << 1;
    QTest::newRow("U+0020 splits words") << QStringLiteral("a b") << 1 << 0 << 1;
    QTest::newRow("U+0085 is a word unit") << QStringLiteral("a\u0085b") << 1 << 0 << 3;
    QTest::newRow("U+00A0 splits words") << QStringLiteral("a\u00A0b") << 1 << 0 << 1;
    QTest::newRow("U+00AD is a word unit") << QStringLiteral("a\u00ADb") << 1 << 0 << 3;
    QTest::newRow("U+1680 splits words") << QStringLiteral("a\u1680b") << 1 << 0 << 1;
    QTest::newRow("U+180E is a word unit") << QStringLiteral("a\u180Eb") << 1 << 0 << 3;
    QTest::newRow("U+2000 splits words") << QStringLiteral("a\u2000b") << 1 << 0 << 1;
    QTest::newRow("U+2001 splits words") << QStringLiteral("a\u2001b") << 1 << 0 << 1;
    QTest::newRow("U+2002 splits words") << QStringLiteral("a\u2002b") << 1 << 0 << 1;
    QTest::newRow("U+2003 splits words") << QStringLiteral("a\u2003b") << 1 << 0 << 1;
    QTest::newRow("U+2004 splits words") << QStringLiteral("a\u2004b") << 1 << 0 << 1;
    QTest::newRow("U+2005 splits words") << QStringLiteral("a\u2005b") << 1 << 0 << 1;
    QTest::newRow("U+2006 splits words") << QStringLiteral("a\u2006b") << 1 << 0 << 1;
    QTest::newRow("U+2007 splits words") << QStringLiteral("a\u2007b") << 1 << 0 << 1;
    QTest::newRow("U+2008 splits words") << QStringLiteral("a\u2008b") << 1 << 0 << 1;
    QTest::newRow("U+2009 splits words") << QStringLiteral("a\u2009b") << 1 << 0 << 1;
    QTest::newRow("U+200A splits words") << QStringLiteral("a\u200Ab") << 1 << 0 << 1;
    QTest::newRow("U+200B is a word unit") << QStringLiteral("a\u200Bb") << 1 << 0 << 3;
    QTest::newRow("U+2028 splits words") << QStringLiteral("a\u2028b") << 1 << 0 << 1;
    QTest::newRow("U+2029 splits words") << QStringLiteral("a\u2029b") << 1 << 0 << 1;
    QTest::newRow("U+202F splits words") << QStringLiteral("a\u202Fb") << 1 << 0 << 1;
    QTest::newRow("U+205F splits words") << QStringLiteral("a\u205Fb") << 1 << 0 << 1;
    QTest::newRow("U+2060 is a word unit") << QStringLiteral("a\u2060b") << 1 << 0 << 3;
    QTest::newRow("U+3000 splits words") << QStringLiteral("a\u3000b") << 1 << 0 << 1;
    QTest::newRow("U+3164 is a word unit") << QStringLiteral("a\u3164b") << 1 << 0 << 3;
    QTest::newRow("U+FEFF splits words") << QStringLiteral("a\uFEFFb") << 1 << 0 << 1;
}

void EditorRangeTest::wordsSplitOnTheJsWhitespaceSet()
{
    QFETCH(QString, line);
    QFETCH(int, column);
    QFETCH(int, start);
    QFETCH(int, end);
    const editor::WordBounds b = editor::wordBoundsAt(line, column);
    QCOMPARE(b.start, start);
    QCOMPARE(b.end, end);
}

// paragraphBoundsAt at every line of a few lists, one past each end and the int extremes: blank means
// exactly "" (a tab, U+FEFF or "\r" line is text), an empty list gives {0, 0}, a "(끝)" line is an
// ordinary non-blank line here (the marker is judged elsewhere).
void EditorRangeTest::paragraphBoundsAtEveryLine_data()
{
    QTest::addColumn<QStringList>("lines");
    QTest::addColumn<int>("lineIndex");
    QTest::addColumn<int>("startLine");
    QTest::addColumn<int>("endLine");

    QTest::newRow("abc #-1") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")} << -1 << 0 << 2;
    QTest::newRow("abc #0") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")} << 0 << 0 << 2;
    QTest::newRow("abc #1") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")} << 1 << 0 << 2;
    QTest::newRow("abc #2") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")} << 2 << 0 << 2;
    QTest::newRow("abc #3") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")} << 3 << 0 << 2;
    QTest::newRow("abc #INT_MIN") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")} << INT_MIN << 0 << 2;
    QTest::newRow("abc #INT_MAX") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c")} << INT_MAX << 0 << 2;
    QTest::newRow("two paragraphs #0") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral(""), QStringLiteral("c"), QStringLiteral("d")} << 0 << 0 << 1;
    QTest::newRow("two paragraphs #1") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral(""), QStringLiteral("c"), QStringLiteral("d")} << 1 << 0 << 1;
    QTest::newRow("two paragraphs #2") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral(""), QStringLiteral("c"), QStringLiteral("d")} << 2 << 2 << 2;
    QTest::newRow("two paragraphs #3") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral(""), QStringLiteral("c"), QStringLiteral("d")} << 3 << 3 << 4;
    QTest::newRow("two paragraphs #4") << QStringList{QStringLiteral("a"), QStringLiteral("b"), QStringLiteral(""), QStringLiteral("c"), QStringLiteral("d")} << 4 << 3 << 4;
    QTest::newRow("two blanks #0") << QStringList{QStringLiteral("a"), QStringLiteral(""), QStringLiteral(""), QStringLiteral("b")} << 0 << 0 << 0;
    QTest::newRow("two blanks #1") << QStringList{QStringLiteral("a"), QStringLiteral(""), QStringLiteral(""), QStringLiteral("b")} << 1 << 1 << 1;
    QTest::newRow("two blanks #2") << QStringList{QStringLiteral("a"), QStringLiteral(""), QStringLiteral(""), QStringLiteral("b")} << 2 << 2 << 2;
    QTest::newRow("two blanks #3") << QStringList{QStringLiteral("a"), QStringLiteral(""), QStringLiteral(""), QStringLiteral("b")} << 3 << 3 << 3;
    QTest::newRow("space line #0") << QStringList{QStringLiteral("a"), QStringLiteral(" "), QStringLiteral("b")} << 0 << 0 << 2;
    QTest::newRow("space line #1") << QStringList{QStringLiteral("a"), QStringLiteral(" "), QStringLiteral("b")} << 1 << 0 << 2;
    QTest::newRow("space line #2") << QStringList{QStringLiteral("a"), QStringLiteral(" "), QStringLiteral("b")} << 2 << 0 << 2;
    QTest::newRow("empty list #-1") << QStringList{} << -1 << 0 << 0;
    QTest::newRow("empty list #0") << QStringList{} << 0 << 0 << 0;
    QTest::newRow("empty list #5") << QStringList{} << 5 << 0 << 0;
    QTest::newRow("one empty line #0") << QStringList{QStringLiteral("")} << 0 << 0 << 0;
    QTest::newRow("one empty line #3") << QStringList{QStringLiteral("")} << 3 << 0 << 0;
    QTest::newRow("all blank #0") << QStringList{QStringLiteral(""), QStringLiteral(""), QStringLiteral("")} << 0 << 0 << 0;
    QTest::newRow("all blank #1") << QStringList{QStringLiteral(""), QStringLiteral(""), QStringLiteral("")} << 1 << 1 << 1;
    QTest::newRow("all blank #2") << QStringList{QStringLiteral(""), QStringLiteral(""), QStringLiteral("")} << 2 << 2 << 2;
    QTest::newRow("whitespace kinds #0") << QStringList{QStringLiteral("a"), QStringLiteral("\t"), QStringLiteral(""), QStringLiteral("\uFEFF"), QStringLiteral("b")} << 0 << 0 << 1;
    QTest::newRow("whitespace kinds #1") << QStringList{QStringLiteral("a"), QStringLiteral("\t"), QStringLiteral(""), QStringLiteral("\uFEFF"), QStringLiteral("b")} << 1 << 0 << 1;
    QTest::newRow("whitespace kinds #2") << QStringList{QStringLiteral("a"), QStringLiteral("\t"), QStringLiteral(""), QStringLiteral("\uFEFF"), QStringLiteral("b")} << 2 << 2 << 2;
    QTest::newRow("whitespace kinds #3") << QStringList{QStringLiteral("a"), QStringLiteral("\t"), QStringLiteral(""), QStringLiteral("\uFEFF"), QStringLiteral("b")} << 3 << 3 << 4;
    QTest::newRow("whitespace kinds #4") << QStringList{QStringLiteral("a"), QStringLiteral("\t"), QStringLiteral(""), QStringLiteral("\uFEFF"), QStringLiteral("b")} << 4 << 3 << 4;
    QTest::newRow("CR line #0") << QStringList{QStringLiteral("\r"), QStringLiteral("x"), QStringLiteral(""), QStringLiteral("y")} << 0 << 0 << 1;
    QTest::newRow("CR line #1") << QStringList{QStringLiteral("\r"), QStringLiteral("x"), QStringLiteral(""), QStringLiteral("y")} << 1 << 0 << 1;
    QTest::newRow("CR line #2") << QStringList{QStringLiteral("\r"), QStringLiteral("x"), QStringLiteral(""), QStringLiteral("y")} << 2 << 2 << 2;
    QTest::newRow("CR line #3") << QStringList{QStringLiteral("\r"), QStringLiteral("x"), QStringLiteral(""), QStringLiteral("y")} << 3 << 3 << 3;
    QTest::newRow("blank edges #0") << QStringList{QStringLiteral(""), QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("")} << 0 << 0 << 0;
    QTest::newRow("blank edges #1") << QStringList{QStringLiteral(""), QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("")} << 1 << 1 << 2;
    QTest::newRow("blank edges #2") << QStringList{QStringLiteral(""), QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("")} << 2 << 1 << 2;
    QTest::newRow("blank edges #3") << QStringList{QStringLiteral(""), QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("")} << 3 << 3 << 3;
    QTest::newRow("hangul #0") << QStringList{QStringLiteral("제목입니다"), QStringLiteral("부제목"), QStringLiteral(""), QStringLiteral("본문 내용입니다")} << 0 << 0 << 1;
    QTest::newRow("hangul #1") << QStringList{QStringLiteral("제목입니다"), QStringLiteral("부제목"), QStringLiteral(""), QStringLiteral("본문 내용입니다")} << 1 << 0 << 1;
    QTest::newRow("hangul #2") << QStringList{QStringLiteral("제목입니다"), QStringLiteral("부제목"), QStringLiteral(""), QStringLiteral("본문 내용입니다")} << 2 << 2 << 2;
    QTest::newRow("hangul #3") << QStringList{QStringLiteral("제목입니다"), QStringLiteral("부제목"), QStringLiteral(""), QStringLiteral("본문 내용입니다")} << 3 << 3 << 3;
    QTest::newRow("marker line #0") << QStringList{QStringLiteral("본문"), QStringLiteral("(끝)")} << 0 << 0 << 1;
    QTest::newRow("marker line #1") << QStringList{QStringLiteral("본문"), QStringLiteral("(끝)")} << 1 << 0 << 1;
}

void EditorRangeTest::paragraphBoundsAtEveryLine()
{
    QFETCH(QStringList, lines);
    QFETCH(int, lineIndex);
    QFETCH(int, startLine);
    QFETCH(int, endLine);
    const editor::ParagraphBounds p = editor::paragraphBoundsAt(lines, lineIndex);
    QCOMPARE(p.startLine, startLine);
    QCOMPARE(p.endLine, endLine);
}

// One paragraph definition (step4.md 금지사항 - editorRange and the status bar must not each have their
// own). node asked both web readers per row - editorRange.paragraphBoundsAt(['p', x, 'q'], 0) and
// editorStats.caretPosition('p\n' + x + '\nq', line 2).paragraph - and emitted the row only when they
// agreed. The C++ predicate has to give that answer, and paragraphBoundsAt has to read it.
void EditorRangeTest::paragraphBoundaryIsTheStatusBarDefinition_data()
{
    QTest::addColumn<QString>("line");
    QTest::addColumn<bool>("isBoundary");

    QTest::newRow("empty is a boundary") << QStringLiteral("") << true;
    QTest::newRow("space is not a boundary") << QStringLiteral(" ") << false;
    QTest::newRow("tab is not a boundary") << QStringLiteral("\t") << false;
    QTest::newRow("CR is not a boundary") << QStringLiteral("\r") << false;
    QTest::newRow("NBSP is not a boundary") << QStringLiteral("\u00A0") << false;
    QTest::newRow("ideographic space is not a boundary") << QStringLiteral("\u3000") << false;
    QTest::newRow("U+FEFF is not a boundary") << QStringLiteral("\uFEFF") << false;
    QTest::newRow("NEL U+0085 is not a boundary") << QStringLiteral("\u0085") << false;
    QTest::newRow("letter is not a boundary") << QStringLiteral("a") << false;
    QTest::newRow("marker is not a boundary") << QStringLiteral("(끝)") << false;
}

void EditorRangeTest::paragraphBoundaryIsTheStatusBarDefinition()
{
    QFETCH(QString, line);
    QFETCH(bool, isBoundary);
    QCOMPARE(editor::isParagraphBoundary(line), isBoundary);
    const editor::ParagraphBounds p =
        editor::paragraphBoundsAt({QStringLiteral("p"), line, QStringLiteral("q")}, 0);
    QCOMPARE(p.endLine == 0, isBoundary);
}

// The coordinate contract with step3: a caret in the readCaret shape (TextPoint - text-line ordinal +
// absolute blocksToText offset) -> word / paragraph bounds -> a TextRange that replaceRangeInBlocks takes
// unconverted. Word mode is the web's edit.selectWord wiring verbatim (WriterPage.jsx: column = offset -
// lineAtOffset(text, offset).start, line text = text.split('\n')[lineIndex] ?? ''); paragraph mode spans
// the start of startLine to the end of endLine. Rows: node ran the same composition on the web modules and
// recorded the range and the replaced blocks byte for byte - an embed between the text lines, the marker
// clamp on a paragraph that runs into "(끝)", and the empty range as a no-op.
void EditorRangeTest::boundsComposeIntoAReplaceRange_data()
{
    QTest::addColumn<QString>("input");      // web serialize(blocks)
    QTest::addColumn<QString>("caret");      // "lineIndex:offset"
    QTest::addColumn<QString>("mode");       // "word" | "paragraph"
    QTest::addColumn<QString>("text");       // the replacement
    QTest::addColumn<QString>("rangeStart"); // the web's range, "lineIndex:offset"
    QTest::addColumn<QString>("rangeEnd");
    QTest::addColumn<QString>("expected");   // web serialize(replaceRangeInBlocks(...).blocks)
    QTest::addColumn<int>("caretLineIndex");

    QTest::newRow("word in the first line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"foo bar\"},{\"type\":\"text\",\"text\":\"baz\"}]}")
        << QStringLiteral("0:1") << QStringLiteral("word") << QStringLiteral("X")
        << QStringLiteral("0:0") << QStringLiteral("0:3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"X bar\"},{\"type\":\"text\",\"text\":\"baz\"}]}")
        << 0;
    QTest::newRow("word after an embed (the embed is not a text line)")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"embedType\":\"image\",\"src\":\"a.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"가나 다라\"}]}")
        << QStringLiteral("1:6") << QStringLiteral("word") << QStringLiteral("X")
        << QStringLiteral("1:6") << QStringLiteral("1:8")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"embedType\":\"image\",\"src\":\"a.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"가나 X\"}]}")
        << 1;
    QTest::newRow("caret on whitespace takes the left word")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ab   cd\"}]}")
        << QStringLiteral("0:3") << QStringLiteral("word") << QStringLiteral("")
        << QStringLiteral("0:0") << QStringLiteral("0:2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"   cd\"}]}")
        << 0;
    QTest::newRow("leading whitespace takes the right word")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"   cd\"}]}")
        << QStringLiteral("1:3") << QStringLiteral("word") << QStringLiteral("Y")
        << QStringLiteral("1:5") << QStringLiteral("1:7")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"   Y\"}]}")
        << 1;
    QTest::newRow("whitespace-only line: empty range, no-op")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"   \"},{\"type\":\"text\",\"text\":\"b\"}]}")
        << QStringLiteral("1:3") << QStringLiteral("word") << QStringLiteral("")
        << QStringLiteral("1:3") << QStringLiteral("1:3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"   \"},{\"type\":\"text\",\"text\":\"b\"}]}")
        << 1;
    QTest::newRow("empty line: empty range, no-op")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"b\"}]}")
        << QStringLiteral("1:2") << QStringLiteral("word") << QStringLiteral("")
        << QStringLiteral("1:2") << QStringLiteral("1:2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"b\"}]}")
        << 1;
    QTest::newRow("word right before the marker line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문 끝\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("0:4") << QStringLiteral("word") << QStringLiteral("X")
        << QStringLiteral("0:3") << QStringLiteral("0:4")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문 X\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << 0;
    QTest::newRow("paragraph replaced whole")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"c\"}]}")
        << QStringLiteral("1:2") << QStringLiteral("paragraph") << QStringLiteral("Z")
        << QStringLiteral("0:0") << QStringLiteral("1:3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Z\"},{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"c\"}]}")
        << 0;
    QTest::newRow("paragraph keeps the embed inside it")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"m.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"c\"}]}")
        << QStringLiteral("0:0") << QStringLiteral("paragraph") << QStringLiteral("Z")
        << QStringLiteral("0:0") << QStringLiteral("1:3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Z\"},{\"embedType\":\"image\",\"src\":\"m.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"c\"}]}")
        << 0;
    QTest::newRow("paragraph running into the marker line is clamped before it")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("0:1") << QStringLiteral("paragraph") << QStringLiteral("Z")
        << QStringLiteral("0:0") << QStringLiteral("2:7")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Z\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << 0;
    QTest::newRow("blank line is its own paragraph")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"b\"}]}")
        << QStringLiteral("1:2") << QStringLiteral("paragraph") << QStringLiteral("Z")
        << QStringLiteral("1:2") << QStringLiteral("1:2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"Z\"},{\"type\":\"text\",\"text\":\"b\"}]}")
        << 1;
}

void EditorRangeTest::boundsComposeIntoAReplaceRange()
{
    QFETCH(QString, input);
    QFETCH(QString, caret);
    QFETCH(QString, mode);
    QFETCH(QString, text);
    QFETCH(QString, rangeStart);
    QFETCH(QString, rangeEnd);
    QFETCH(QString, expected);
    QFETCH(int, caretLineIndex);

    const QVector<editor::Block> blocks = editor::deserialize(input);
    const QString body = editor::blocksToText(blocks);
    const QStringList bodyLines = editor::lines(body);
    const editor::TextPoint at = point(caret);
    // readCaret-shaped: the two fields name one position.
    QCOMPARE(editor::lineAtOffset(body, at.offset).lineIndex, at.lineIndex);

    editor::TextRange range;
    if (mode == QLatin1String("word")) {
        const int lineStart = editor::lineAtOffset(body, at.offset).start;
        const editor::WordBounds b = editor::wordBoundsAt(bodyLines.value(at.lineIndex), at.offset - lineStart);
        range = editor::TextRange{editor::TextPoint{at.lineIndex, lineStart + b.start},
                                  editor::TextPoint{at.lineIndex, lineStart + b.end}};
    } else {
        const editor::ParagraphBounds p = editor::paragraphBoundsAt(bodyLines, at.lineIndex);
        // A broken implementation has to fail this row, not crash the runner on an index.
        QVERIFY2(0 <= p.startLine && p.startLine <= p.endLine && p.endLine < bodyLines.size(),
                 qPrintable(QStringLiteral("paragraph [%1, %2] outside %3 text lines")
                                .arg(p.startLine)
                                .arg(p.endLine)
                                .arg(bodyLines.size())));
        range = editor::TextRange{
            editor::TextPoint{p.startLine, lineStartOf(bodyLines, p.startLine)},
            editor::TextPoint{p.endLine, lineStartOf(bodyLines, p.endLine) + int(bodyLines.at(p.endLine).size())}};
    }
    QCOMPARE(spec(*range.start), rangeStart);
    QCOMPARE(spec(*range.end), rangeEnd);

    const editor::InsertResult result = editor::replaceRangeInBlocks(blocks, range, text);
    QCOMPARE(editor::serialize(result.blocks), expected);
    QCOMPARE(result.caretLineIndex, caretLineIndex);
    // The empty range is the no-op signal: putting nothing in its place changes nothing.
    if (range.start->offset == range.end->offset && text.isEmpty())
        QCOMPARE(editor::serialize(result.blocks), input);
}
