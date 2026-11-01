#include "editornewlinetest.h"

#include "editor/editorcontent.h"
#include "editor/editornewline.h"
#include "editor/editorroles.h"

#include <QByteArray>
#include <QChar>
#include <QLatin1Char>
#include <QString>
#include <QStringList>
#include <QVector>
#include <QtTest>

#include <climits>
#include <initializer_list>
#include <optional>
#include <utility>
#include <vector>

using editor::Block;
using editor::InsertResult;
using editor::JsonValue;
using editor::TextPoint;
using editor::TextRange;

namespace {

JsonValue str(const QString &value)
{
    return JsonValue::makeString(value);
}

// A JS object literal, keys applied in the order written.
JsonValue object(std::initializer_list<std::pair<QString, JsonValue>> members)
{
    JsonValue out = JsonValue::makeObject();
    for (const auto &member : members)
        out.insert(member.first, member.second);
    return out;
}

// embedBlock({ embedType, src }) - the embed every web fixture uses.
Block embed(const QString &embedType, const QString &src)
{
    return editor::embedBlock(object({{QStringLiteral("embedType"), str(embedType)}, {QStringLiteral("src"), str(src)}}));
}

Block image(const QString &src)
{
    return embed(QStringLiteral("image"), src);
}

// Comparisons go through the step1 serializer (byte-identical with the web's JSON.stringify), so a
// failure prints readable blocks - text, align and embed payload included.
QString bytes(const QVector<Block> &blocks)
{
    return editor::serialize(blocks);
}

// The web test's caretAt: line lineIndex of the text blocks, inLine units into it, as an absolute
// blocksToText offset.
TextPoint caretAt(const QVector<Block> &blocks, int lineIndex, int inLine)
{
    int offset = 0;
    int line = 0;
    for (const Block &block : blocks) {
        if (!editor::isTextBlock(block))
            continue;
        if (line == lineIndex)
            break;
        offset += int(block.text.size()) + 1;
        ++line;
    }
    return TextPoint{lineIndex, offset + inLine};
}

TextRange rangeAt(const QVector<Block> &blocks, int startLine, int startInLine, int endLine, int endInLine)
{
    return TextRange{caretAt(blocks, startLine, startInLine), caretAt(blocks, endLine, endInLine)};
}

QStringList typesOf(const QVector<Block> &blocks)
{
    QStringList out;
    for (const Block &block : blocks)
        out.append(editor::isTextBlock(block) ? QStringLiteral("text") : QStringLiteral("embed"));
    return out;
}

QVector<Block> embedsOf(const QVector<Block> &blocks)
{
    QVector<Block> out;
    for (const Block &block : blocks) {
        if (editor::isEmbedBlock(block))
            out.append(block);
    }
    return out;
}

// The web test file's own isMarkerBlock (b.type === 'text' && String(b.text).trim() === END_MARKER),
// spelled with step2's isEndLine - deliberately not editor::isMarkerBlock, the function under test.
bool isMarkerLine(const Block &block)
{
    return editor::isTextBlock(block) && editor::isEndLine(block.text);
}

QVector<Block> markerBlocks(const QVector<Block> &blocks)
{
    QVector<Block> out;
    for (const Block &block : blocks) {
        if (isMarkerLine(block))
            out.append(block);
    }
    return out;
}

// The web round trip deserialize(serializeBodyFromBlocks(blocks)): save (renormalize + serialize),
// then load.
QVector<Block> savedAndReloaded(const QVector<Block> &blocks)
{
    return editor::deserialize(editor::serialize(editor::renormalizeEndMarker(blocks)));
}

// The data tables spell a point "lineIndex:offset"; "" is an unknown end.
std::optional<TextPoint> point(const QString &spec)
{
    if (spec.isEmpty())
        return std::nullopt;
    const QStringList parts = spec.split(QLatin1Char(':'));
    return TextPoint{parts.at(0).toInt(), parts.at(1).toInt()};
}

// One UTF-16 code unit as a string - the only way to spell a lone surrogate (no C++ literal can).
QString unit(char16_t value)
{
    return QString(QChar(value));
}

// The fixtures of the web's collapsed-equivalence tests (equivFixtures), with the Enter result the
// web expects today.
struct EquivFixture {
    const char *name;
    QVector<Block> blocks;
    std::optional<TextPoint> caret;
    QString enterText;
    int enterCaretLineIndex;
};

std::vector<EquivFixture> equivFixtures()
{
    std::vector<EquivFixture> out;
    {
        const QVector<Block> b{editor::textBlock(QStringLiteral("AB CD"))};
        out.push_back({"mid line", b, caretAt(b, 0, 2), QStringLiteral("AB\n CD"), 1});
    }
    {
        const QVector<Block> b{editor::textBlock(QStringLiteral("줄1")), editor::textBlock(QStringLiteral("줄2"))};
        out.push_back({"line end (last line)", b, caretAt(b, 1, 2), QStringLiteral("줄1\n줄2\n"), 2});
    }
    {
        const QVector<Block> b{editor::textBlock(QStringLiteral("가")), editor::textBlock(QStringLiteral("나"))};
        out.push_back({"first line start", b, caretAt(b, 0, 0), QStringLiteral("\n가\n나"), 1});
    }
    {
        const QVector<Block> b{editor::textBlock(QStringLiteral("제목")), image(QStringLiteral("x.png")),
                               editor::textBlock(QStringLiteral("본문"))};
        out.push_back({"with embed", b, caretAt(b, 1, 2), QStringLiteral("제목\n본문\n"), 2});
    }
    out.push_back({"null caret (no marker)", {editor::textBlock(QStringLiteral("줄1"))}, std::nullopt,
                   QStringLiteral("줄1\n"), 1});
    out.push_back({"empty body", {}, std::nullopt, QStringLiteral("\n"), 1});
    return out;
}

} // namespace

// ---- editorNewline — "(끝)" placement & input blocking ----------------------------------------

// it: 'appends "(끝)" on its own line after the body'
void EditorNewlineTest::appendsTheMarkerOnItsOwnLineAfterTheBody()
{
    QCOMPARE(editor::appendEndMarker(QStringLiteral("본문")), QStringLiteral("본문\n(끝)"));
}

// it: 'does not add a double newline when body already ends with newline or is empty'
void EditorNewlineTest::addsNoDoubleNewlineWhenTheBodyEndsWithOneOrIsEmpty()
{
    QCOMPARE(editor::appendEndMarker(QStringLiteral("본문\n")), QStringLiteral("본문\n(끝)"));
    QCOMPARE(editor::appendEndMarker(QStringLiteral("")), QStringLiteral("(끝)"));
    QCOMPARE(editor::appendEndMarker(QString()), QStringLiteral("(끝)")); // web String(text ?? '')
}

// it: 'does not insert "(끝)" again if it already exists (no duplicate)'
void EditorNewlineTest::doesNotInsertTheMarkerAgain()
{
    QCOMPARE(editor::appendEndMarker(QStringLiteral("본문\n(끝)")), QStringLiteral("본문\n(끝)"));
}

// it: 'hasEndMarker reflects presence'
void EditorNewlineTest::hasEndMarkerReflectsPresence()
{
    QVERIFY(editor::hasEndMarker(QStringLiteral("본문\n(끝)")));
    QVERIFY(!editor::hasEndMarker(QStringLiteral("본문")));
}

// it: 'blocks input at or after the marker, allows input before it'
void EditorNewlineTest::blocksInputAtOrAfterTheMarkerAllowsItBefore()
{
    const QString text = QStringLiteral("본문\n(끝)");
    const int markerStart = int(text.indexOf(QStringLiteral("(끝)")));
    QCOMPARE(markerStart, 3);
    QVERIFY(editor::isInputBlocked(text, markerStart));        // 마커 시작
    QVERIFY(editor::isInputBlocked(text, int(text.size())));   // 마커 뒤
    QVERIFY(!editor::isInputBlocked(text, markerStart - 1));   // 앞 줄(개행 위치)
    QVERIFY(!editor::isInputBlocked(text, 0));
}

// it: 'never blocks when there is no marker'
void EditorNewlineTest::neverBlocksWithoutAMarker()
{
    QVERIFY(!editor::isInputBlocked(QStringLiteral("본문"), 0));
    QVERIFY(!editor::isInputBlocked(QStringLiteral("본문"), 2));
}

// ---- editorNewline — shouldOverwriteNextChar (수정 모드 덮어쓰기 경계) ---------------------------

// it: '줄 중간: 캐럿 뒤에 같은 줄 일반 글자가 있으면 true(각 오프셋)'
void EditorNewlineTest::overwriteReplacesAnOrdinaryCharacterAtEachOffset()
{
    QVERIFY(editor::shouldOverwriteNextChar(QStringLiteral("abc"), 0));
    QVERIFY(editor::shouldOverwriteNextChar(QStringLiteral("abc"), 1));
    QVERIFY(editor::shouldOverwriteNextChar(QStringLiteral("abc"), 2));
}

// it: '문서 끝(offset===length)·범위 밖은 false(삽입 폴백)'
void EditorNewlineTest::overwriteFallsBackToInsertAtTheEndAndOutOfRange()
{
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("abc"), 3));  // 문서 끝
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("abc"), 99)); // 범위 밖
}

// it: '줄 끝(뒤가 "\n")은 false(다음 줄 침범 금지), 다음 줄 첫 글자는 true'
void EditorNewlineTest::overwriteNeverEatsTheNextLine()
{
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("ab\ncd"), 2)); // text[2] = '\n'
    QVERIFY(editor::shouldOverwriteNextChar(QStringLiteral("ab\ncd"), 3));  // 다음 줄 첫 글자
}

// it: '"(끝)" 마커 시작 이상 오프셋은 전부 false(입력 차단 계약 재사용), 마커 앞 본문은 정상 판정'
void EditorNewlineTest::overwriteIsOffFromTheMarkerStartOn()
{
    const QString text = QStringLiteral("본문\n(끝)");
    const int markerStart = int(text.indexOf(QStringLiteral("(끝)")));
    QVERIFY(!editor::shouldOverwriteNextChar(text, markerStart)); // 마커 첫 글자 '('
    for (int i = markerStart; i <= int(text.size()); ++i)
        QVERIFY2(!editor::shouldOverwriteNextChar(text, i), qPrintable(QStringLiteral("offset %1").arg(i)));
    QVERIFY(editor::shouldOverwriteNextChar(text, 0));  // '본'
    QVERIFY(editor::shouldOverwriteNextChar(text, 1));  // '문'
    QVERIFY(!editor::shouldOverwriteNextChar(text, 2)); // 마커 직전 '\n'
}

// it: '임베드 경계는 blocksToText에서 "\n"/문서 끝으로 나타나 자동 false'
void EditorNewlineTest::overwriteSeesAnEmbedBoundaryAsALineEnd()
{
    const QString text = editor::blocksToText(
        {editor::textBlock(QStringLiteral("앞")), image(QStringLiteral("x.png")), editor::textBlock(QStringLiteral("뒤"))});
    QCOMPARE(text, QStringLiteral("앞\n뒤")); // 임베드 제외
    QVERIFY(!editor::shouldOverwriteNextChar(text, 1));
    QVERIFY(!editor::shouldOverwriteNextChar(text, int(text.size())));
}

// it: '무효 오프셋(null/undefined/음수/비정수/NaN)은 false'. The int signature cannot hold null,
// undefined, 1.5, NaN or '1' (all false on the web too - node 2026-11-01); a negative offset it can.
void EditorNewlineTest::overwriteRejectsInvalidOffsets()
{
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("abc"), -1));
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("abc"), INT_MIN));
}

// it: '빈 문자열·무효 text는 false' - null / undefined text is a null QString here.
void EditorNewlineTest::overwriteRejectsEmptyOrMissingText()
{
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral(""), 0));
    QVERIFY(!editor::shouldOverwriteNextChar(QString(), 0));
}

// ---- editorNewline — overwriteExtendLength (서로게이트-safe 확장 길이) ----------------------------

// it: 'BMP 문자는 1 코드유닛'
void EditorNewlineTest::extendLengthIsOneForABmpCharacter()
{
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("abc"), 1), 1);
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("가나"), 1), 1);
}

// it: 'astral 문자(이모지=서로게이트 페어)는 2 코드유닛'
void EditorNewlineTest::extendLengthIsTwoForAnAstralCharacter()
{
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("a\U0001F600b"), 1), 2); // 이모지 시작(high)
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("\U0001F600"), 0), 2);    // 문자열 시작
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("a\U0001F600"), 1), 2);   // 문자열 끝
}

// it: 'lone high 서로게이트는 1(짝 없으면 안전 폴백)'
void EditorNewlineTest::extendLengthIsOneForALoneHighSurrogate()
{
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("a") + unit(0xD83D) + QStringLiteral("b"), 1), 1);
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("a") + unit(0xD83D), 1), 1); // 문자열 끝
}

// it: '경계/무효 오프셋은 1(안전 기본)' - 1.5 and NaN are not ints (both 1 on the web).
void EditorNewlineTest::extendLengthIsOneAtBoundariesAndInvalidOffsets()
{
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("abc"), 3), 1);  // 문서 끝
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("abc"), -1), 1); // 음수
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral(""), 0), 1);     // 빈 문자열
    QCOMPARE(editor::overwriteExtendLength(QString(), 0), 1);              // 무효 text (null)
}

// ---- editorNewline — shouldOverwriteNextChar (서로게이트 페어 내부 차단) ---------------------------

// it: '페어 내부(offset=low 서로게이트, 직전=high)는 false — 반쪽 대체 방지(핵심)'
void EditorNewlineTest::overwriteRefusesTheInsideOfASurrogatePair()
{
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("a\U0001F600b"), 2));
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("\U0001F600b"), 1));
}

// it: '페어 앞(offset=high 시작)은 기존대로 true이고 확장 길이는 2(회귀 가드)'
void EditorNewlineTest::overwriteAtAPairStartExtendsTwoUnits()
{
    QVERIFY(editor::shouldOverwriteNextChar(QStringLiteral("a\U0001F600b"), 1));
    QCOMPARE(editor::overwriteExtendLength(QStringLiteral("a\U0001F600b"), 1), 2);
}

// it: '페어 뒤(일반 글자)는 true'
void EditorNewlineTest::overwriteAfterAPairIsAllowed()
{
    QVERIFY(editor::shouldOverwriteNextChar(QStringLiteral("a\U0001F600b"), 3));
}

// it: 'lone low 서로게이트(직전이 high 아님)는 기존대로 true'
void EditorNewlineTest::overwriteAllowsALoneLowSurrogate()
{
    QVERIFY(editor::shouldOverwriteNextChar(QStringLiteral("a") + unit(0xDC00) + QStringLiteral("b"), 1));
    QVERIFY(editor::shouldOverwriteNextChar(unit(0xDC00) + QStringLiteral("b"), 0));
}

// it: 'lone high 서로게이트 위치도 기존대로 true(확장 1 — 안전 폴백 유지)'
void EditorNewlineTest::overwriteAllowsALoneHighSurrogateWithOneUnit()
{
    const QString text = QStringLiteral("a") + unit(0xD83D) + QStringLiteral("b");
    QVERIFY(editor::shouldOverwriteNextChar(text, 1));
    QCOMPARE(editor::overwriteExtendLength(text, 1), 1);
}

// it: 'BMP 회귀 — 한글·영문·기호에서 기존 true/false 판정 불변' (1.5 is not an int).
void EditorNewlineTest::overwriteBmpVerdictsAreUnchanged()
{
    QVERIFY(editor::shouldOverwriteNextChar(QStringLiteral("가나다"), 1));
    QVERIFY(editor::shouldOverwriteNextChar(QStringLiteral("a!b"), 1));
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("ab\ncd"), 2));
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("abc"), 3));
    const QString text = QStringLiteral("본문\n(끝)");
    QVERIFY(!editor::shouldOverwriteNextChar(text, int(text.indexOf(QStringLiteral("(끝)")))));
    QVERIFY(!editor::shouldOverwriteNextChar(QStringLiteral("abc"), -1));
}

// ---- editorNewline — insertTextIntoBlocks (Enter 분할 / 여러 줄 삽입) ------------------------------

// it: 'Enter("\n")는 캐럿이 속한 줄을 head/tail 두 줄로 분할한다'
void EditorNewlineTest::enterSplitsTheCaretLineIntoHeadAndTail()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("AB CD"))};
    const InsertResult r = editor::insertTextIntoBlocks(blocks, caretAt(blocks, 0, 2), QStringLiteral("\n"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("AB\n CD"));
    QCOMPARE(r.caretLineIndex, 1); // 새 줄(tail)에 캐럿
}

// it: '줄 끝에서 Enter는 뒤에 빈 줄을 추가한다'
void EditorNewlineTest::enterAtALineEndAddsAnEmptyLine()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("줄1")), editor::textBlock(QStringLiteral("줄2"))};
    const InsertResult r = editor::insertTextIntoBlocks(blocks, caretAt(blocks, 1, 2), QStringLiteral("\n"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("줄1\n줄2\n"));
    QCOMPARE(r.caretLineIndex, 2);
}

// it: '캐럿이 null이면(라인 래퍼 없음) 마지막 텍스트 줄 끝에 빈 줄을 붙인다'
void EditorNewlineTest::unknownCaretAppendsAnEmptyLineAtTheLastLine()
{
    const InsertResult r =
        editor::insertTextIntoBlocks({editor::textBlock(QStringLiteral("줄1"))}, std::nullopt, QStringLiteral("\n"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("줄1\n"));
    QCOMPARE(r.caretLineIndex, 1);
}

// it: '완전히 빈 본문([])에서 Enter는 빈 줄 두 개가 된다'
void EditorNewlineTest::enterInAnEmptyBodyGivesTwoEmptyLines()
{
    const InsertResult r = editor::insertTextIntoBlocks({}, std::nullopt, QStringLiteral("\n"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("\n"));
    QCOMPARE(r.caretLineIndex, 1);
}

// it: '여러 줄 텍스트 삽입은 head+첫줄 … 끝줄+tail로 개행을 보존한다'
void EditorNewlineTest::multiLineInsertKeepsHeadFirstLineLastLineTail()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("AB CD"))};
    const InsertResult r = editor::insertTextIntoBlocks(blocks, caretAt(blocks, 0, 2), QStringLiteral("x\ny"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("ABx\ny CD"));
    QCOMPARE(r.caretLineIndex, 1);
}

// it: '임베드는 위치를 보존하고 텍스트 블록만 분할한다'
void EditorNewlineTest::insertKeepsEmbedsInPlaceAndSplitsOnlyText()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("제목")), image(QStringLiteral("x.png")),
                                editor::textBlock(QStringLiteral("본문"))};
    const InsertResult r = editor::insertTextIntoBlocks(blocks, caretAt(blocks, 1, 2), QStringLiteral("\n"));
    QCOMPARE(typesOf(r.blocks), (QStringList{QStringLiteral("text"), QStringLiteral("embed"), QStringLiteral("text"),
                                             QStringLiteral("text")}));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("제목\n본문\n"));
    QCOMPARE(r.caretLineIndex, 2);
}

// ---- editorNewline — replaceRangeInBlocks (선택 범위 삭제 + 삽입) ---------------------------------

// it: '선택 범위 텍스트를 지우고 그 자리에 삽입한다(결함 재현 — 여러 줄 붙여넣기)'
void EditorNewlineTest::replaceDeletesTheSelectionAndInsertsMultiLineText()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("hello world"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 6, 0, 11), QStringLiteral("A\nB"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("hello A\nB")); // 'world' 소멸
    QCOMPARE(r.caretLineIndex, 1);
}

// it: '선택 범위에서 Enter는 선택을 지운 뒤 줄을 분할한다(결함 재현)'
void EditorNewlineTest::enterOverASelectionDeletesItThenSplits()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("hello world"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 6, 0, 11), QStringLiteral("\n"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("hello \n"));
    QCOMPARE(r.caretLineIndex, 1);
}

// it: '여러 줄에 걸친 선택은 중간 줄을 제거하고 head/tail을 한 줄로 병합한다'
void EditorNewlineTest::multiLineSelectionDropsMiddleLinesAndMergesHeadAndTail()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("ab")), editor::textBlock(QStringLiteral("cd")),
                                editor::textBlock(QStringLiteral("ef"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 2, 1), QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("aXf"));
    QCOMPARE(r.blocks.size(), 1);
    QCOMPARE(r.caretLineIndex, 0);
}

// it: 'collapsed(같은 start/end)는 insertTextIntoBlocks와 텍스트·caretLineIndex가 동일하다'
void EditorNewlineTest::collapsedRangeMatchesInsertTextIntoBlocks()
{
    for (const EquivFixture &f : equivFixtures()) {
        for (const QString &text : {QStringLiteral("\n"), QStringLiteral("x\ny"), QStringLiteral("Z")}) {
            const InsertResult a = editor::replaceRangeInBlocks(f.blocks, TextRange{f.caret, f.caret}, text);
            const InsertResult b = editor::insertTextIntoBlocks(f.blocks, f.caret, text);
            const QByteArray where = QByteArray(f.name) + " / " + text.toUtf8().toPercentEncoding();
            QVERIFY2(editor::blocksToText(a.blocks) == editor::blocksToText(b.blocks), where.constData());
            QVERIFY2(a.caretLineIndex == b.caretLineIndex, where.constData());
        }
    }
}

// it: 'collapsed 결과는 오늘의 기대값 그대로다(동치성 자체를 잠그는 명시 단언)'
void EditorNewlineTest::collapsedResultsAreTodaysExpectedValues()
{
    for (const EquivFixture &f : equivFixtures()) {
        const InsertResult r = editor::replaceRangeInBlocks(f.blocks, TextRange{f.caret, f.caret}, QStringLiteral("\n"));
        QVERIFY2(editor::blocksToText(r.blocks) == f.enterText, f.name);
        QVERIFY2(r.caretLineIndex == f.enterCaretLineIndex, f.name);
    }
}

// it: 'range:null·{start:null,end:null}·한쪽만 null 은 캐럿 미상/collapsed 폴백과 같다'. The web's
// range = null and {start: null, end: null} are one C++ value: TextRange{} (both ends unknown).
void EditorNewlineTest::unknownEndsFallBackLikeAnUnknownOrCollapsedCaret()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("줄1"))};
    const InsertResult viaNull = editor::replaceRangeInBlocks(blocks, TextRange{}, QStringLiteral("x\ny"));
    const InsertResult viaBothNull =
        editor::replaceRangeInBlocks(blocks, TextRange{std::nullopt, std::nullopt}, QStringLiteral("x\ny"));
    const InsertResult legacy = editor::insertTextIntoBlocks(blocks, std::nullopt, QStringLiteral("x\ny"));
    QCOMPARE(editor::blocksToText(viaNull.blocks), editor::blocksToText(legacy.blocks));
    QCOMPARE(editor::blocksToText(viaBothNull.blocks), editor::blocksToText(legacy.blocks));
    QCOMPARE(viaNull.caretLineIndex, legacy.caretLineIndex);
    QCOMPARE(viaBothNull.caretLineIndex, legacy.caretLineIndex);
    QCOMPARE(editor::blocksToText(legacy.blocks), QStringLiteral("줄1x\ny")); // node: the value itself
    QCOMPARE(legacy.caretLineIndex, 1);
    // 한쪽만 있으면 있는 쪽으로 collapsed 취급(규칙 1-a).
    const TextPoint caret = caretAt(blocks, 0, 1);
    const InsertResult onlyEnd = editor::replaceRangeInBlocks(blocks, TextRange{std::nullopt, caret}, QStringLiteral("X"));
    const InsertResult onlyStart = editor::replaceRangeInBlocks(blocks, TextRange{caret, std::nullopt}, QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(onlyEnd.blocks), QStringLiteral("줄X1"));
    QCOMPARE(editor::blocksToText(onlyStart.blocks), QStringLiteral("줄X1"));
}

// it: '역방향 선택(start > end)도 정규화되어 같은 결과를 낸다'
void EditorNewlineTest::reversedSelectionIsNormalized()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("hello world"))};
    const InsertResult fwd = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 6, 0, 11), QStringLiteral("A\nB"));
    const InsertResult rev = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 11, 0, 6), QStringLiteral("A\nB"));
    QCOMPARE(editor::blocksToText(rev.blocks), QStringLiteral("hello A\nB"));
    QCOMPARE(editor::blocksToText(rev.blocks), editor::blocksToText(fwd.blocks));
    QCOMPARE(rev.caretLineIndex, fwd.caretLineIndex);
    // 여러 줄 역방향.
    const QVector<Block> multi{editor::textBlock(QStringLiteral("ab")), editor::textBlock(QStringLiteral("cd")),
                               editor::textBlock(QStringLiteral("ef"))};
    const InsertResult r = editor::replaceRangeInBlocks(multi, rangeAt(multi, 2, 1, 0, 1), QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("aXf"));
    QCOMPARE(r.caretLineIndex, 0);
}

// it: '범위 안의 임베드는 삭제되지 않고 병합된 줄 뒤에 원래 상대 순서로 남는다'
void EditorNewlineTest::embedInsideTheRangeSurvivesAfterTheMergedLine()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("ab")), image(QStringLiteral("x.png")),
                                editor::textBlock(QStringLiteral("cd"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 1, 1), QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("aXd"));
    QCOMPARE(typesOf(r.blocks), (QStringList{QStringLiteral("text"), QStringLiteral("embed")}));
    const QVector<Block> embeds = embedsOf(r.blocks);
    QCOMPARE(embeds.size(), 1);
    QVERIFY(embeds.at(0).embed == object({{QStringLiteral("embedType"), str(QStringLiteral("image"))},
                                          {QStringLiteral("src"), str(QStringLiteral("x.png"))},
                                          {QStringLiteral("type"), str(QStringLiteral("embed"))}}));
}

// it: '범위 안 임베드가 여러 개면 개수·상대 순서가 그대로 보존된다'
void EditorNewlineTest::severalEmbedsInsideTheRangeKeepCountAndOrder()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("ab")), image(QStringLiteral("1.png")),
                                editor::textBlock(QStringLiteral("cd")),
                                embed(QStringLiteral("video"), QStringLiteral("2.mp4")),
                                editor::textBlock(QStringLiteral("ef"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 2, 1), QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("aXf"));
    QCOMPARE(typesOf(r.blocks), (QStringList{QStringLiteral("text"), QStringLiteral("embed"), QStringLiteral("embed")}));
    QStringList sources;
    for (const Block &b : embedsOf(r.blocks))
        sources.append(b.embed.find(QStringLiteral("src"))->stringValue);
    QCOMPARE(sources, (QStringList{QStringLiteral("1.png"), QStringLiteral("2.mp4")}));
}

// it: '삭제 end는 "(끝)" 줄 시작 이전으로 clamp된다 — 마커 블록이 변형되지 않는다'
void EditorNewlineTest::deleteEndIsClampedBeforeTheMarkerLine()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("본문")), editor::textBlock(QStringLiteral("꼬리")),
                                editor::textBlock(QStringLiteral("(끝)"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 2, 3), QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("본X\n(끝)"));
    QCOMPARE(bytes(markerBlocks(r.blocks)), bytes({editor::textBlock(QStringLiteral("(끝)"))}));
    // 재정규화 라운드트립 — 마커가 여전히 정확히 하나·최종 블록.
    const QVector<Block> round = savedAndReloaded(r.blocks);
    QCOMPARE(markerBlocks(round).size(), 1);
    QVERIFY(isMarkerLine(round.last()));
}

// it: '마커 줄 텍스트에 다른 문자가 붙지 않는다(오염 "(끝)X"·"X(끝)" 금지)'
void EditorNewlineTest::markerLineNeverGetsOtherCharactersGlued()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("본문")), editor::textBlock(QStringLiteral("(끝)"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 0, 1, 3), QStringLiteral("X"));
    const QString text = editor::blocksToText(r.blocks);
    QVERIFY(text.contains(QStringLiteral("(끝)")));
    QVERIFY(!text.contains(QStringLiteral("(끝)X")));
    QVERIFY(!text.contains(QStringLiteral("X(끝)")));
    QCOMPARE(bytes(markerBlocks(r.blocks)), bytes({editor::textBlock(QStringLiteral("(끝)"))}));
}

// it: '마커 앞 줄들의 선택 삭제는 정상 동작하고 마커는 온전하다'
void EditorNewlineTest::deletingLinesBeforeTheMarkerWorksNormally()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("본문")), editor::textBlock(QStringLiteral("꼬리")),
                                editor::textBlock(QStringLiteral("(끝)"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 1, 2), QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("본X\n(끝)"));
    QCOMPARE(markerBlocks(r.blocks).size(), 1);
}

// it: '마커가 첫 텍스트 줄인 문서(빈 문서 Alt+Y 직후)의 전 범위 대체는 마커 앞에 삽입한다(결함 재현)'
void EditorNewlineTest::replacingAllOfAMarkerFirstDocumentInsertsBeforeTheMarker()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("(끝)"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 0, 0, 3), QStringLiteral("X\nY"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("X\nY\n(끝)")); // clamp 없으면 'X\nY(끝)'
    QCOMPARE(bytes(markerBlocks(r.blocks)), bytes({editor::textBlock(QStringLiteral("(끝)"))}));
    QCOMPARE(r.caretLineIndex, 1);
    const QVector<Block> round = savedAndReloaded(r.blocks);
    QCOMPARE(markerBlocks(round).size(), 1);
    QVERIFY(isMarkerLine(round.last()));
}

// it: '마커 줄만 선택한 대체(문단 선택)는 마커 직전 줄 끝에 삽입한다(결함 재현)'
void EditorNewlineTest::replacingOnlyTheMarkerLineInsertsAtTheLineBeforeIt()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("AAA")), editor::textBlock(QStringLiteral("(끝)"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 1, 0, 1, 3), QStringLiteral("X\nY"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("AAAX\nY\n(끝)")); // clamp 없으면 'AAA\nX\nY(끝)'
    QVERIFY(!editor::blocksToText(r.blocks).contains(QStringLiteral("Y(끝)")));
    QCOMPARE(bytes(markerBlocks(r.blocks)), bytes({editor::textBlock(QStringLiteral("(끝)"))}));
    QCOMPARE(r.caretLineIndex, 1);
}

// it: '마커 줄 collapsed 캐럿의 삽입도 마커 앞으로 내려간다(규칙 1-b와 같은 지점)'
void EditorNewlineTest::collapsedCaretOnTheMarkerLineMovesBeforeTheMarker()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("본문")), editor::textBlock(QStringLiteral("(끝)"))};
    const TextPoint caret = caretAt(blocks, 1, 3); // 마커 줄 끝
    const InsertResult r = editor::replaceRangeInBlocks(blocks, TextRange{caret, caret}, QStringLiteral("A\nB"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("본문A\nB\n(끝)"));
    QCOMPARE(bytes(markerBlocks(r.blocks)), bytes({editor::textBlock(QStringLiteral("(끝)"))}));
    // 캐럿 미상 폴백(규칙 1-b)과 같은 결과 — 마커 보호 지점은 단일 출처다.
    QCOMPARE(editor::blocksToText(r.blocks),
             editor::blocksToText(editor::replaceRangeInBlocks(blocks, TextRange{}, QStringLiteral("A\nB")).blocks));
}

// it: '마커 뒤 블록에서 시작하는 대체도 마커와 그 뒤 블록을 전혀 바꾸지 않는다'
void EditorNewlineTest::replacementStartingAfterTheMarkerLeavesItAndTheTailUntouched()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("(끝)")), editor::textBlock(QStringLiteral("꼬리"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 1, 0, 1, 2), QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("X\n(끝)\n꼬리"));
    QCOMPARE(bytes(r.blocks.mid(1)), bytes(blocks)); // 마커 줄·그 뒤 블록 무변경(규칙 3 불변식)
}

// it: '문서 전 범위 선택은 본문을 통째로 대체한다(임베드는 남는다)'
void EditorNewlineTest::wholeDocumentSelectionReplacesTheTextAndKeepsEmbeds()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("ab")), editor::textBlock(QStringLiteral("cd")),
                                editor::textBlock(QStringLiteral("ef"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 0, 2, 2), QStringLiteral("A\nB"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("A\nB"));
    QCOMPARE(r.caretLineIndex, 1);
    const QVector<Block> withEmbed{editor::textBlock(QStringLiteral("ab")), image(QStringLiteral("x.png")),
                                   editor::textBlock(QStringLiteral("cd"))};
    const InsertResult r2 =
        editor::replaceRangeInBlocks(withEmbed, rangeAt(withEmbed, 0, 0, 1, 2), QStringLiteral("A\nB"));
    QCOMPARE(editor::blocksToText(r2.blocks), QStringLiteral("A\nB"));
    QCOMPARE(embedsOf(r2.blocks).size(), 1);
}

// it: '캐럿 미상 폴백은 "마커 줄 직전"에 삽입한다 — "(끝)A" 오염 금지(결함 재현)'
void EditorNewlineTest::unknownCaretInsertsBeforeTheMarkerLine()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("본문")), editor::textBlock(QStringLiteral("(끝)"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, TextRange{}, QStringLiteral("A\nB"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("본문A\nB\n(끝)"));
    QVERIFY(!editor::blocksToText(r.blocks).contains(QStringLiteral("(끝)A")));
    QCOMPARE(bytes(markerBlocks(r.blocks)), bytes({editor::textBlock(QStringLiteral("(끝)"))}));
    QCOMPARE(r.caretLineIndex, 1); // 삽입 대상 줄(0) + 삽입 줄 수-1 — 마커 줄이 아니다
    const QVector<Block> round = savedAndReloaded(r.blocks);
    QCOMPARE(markerBlocks(round).size(), 1);
    QVERIFY(isMarkerLine(round.last()));
}

// it: '마커 앞에 텍스트 줄이 없으면 마커 바로 앞에 새 텍스트 줄을 만들어 삽입한다(빈 문서 Alt+Y 상태)'
void EditorNewlineTest::unknownCaretWithOnlyTheMarkerMakesANewLineBeforeIt()
{
    const InsertResult r =
        editor::replaceRangeInBlocks({editor::textBlock(QStringLiteral("(끝)"))}, TextRange{}, QStringLiteral("A\nB"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("A\nB\n(끝)"));
    QCOMPARE(bytes(markerBlocks(r.blocks)), bytes({editor::textBlock(QStringLiteral("(끝)"))}));
    QCOMPARE(r.caretLineIndex, 1);
}

// it: '마커 없는 문서의 캐럿 미상 폴백은 오늘과 동일하다(마지막 텍스트 줄 끝)'
void EditorNewlineTest::unknownCaretWithoutAMarkerAppendsAtTheLastLine()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("가")), editor::textBlock(QStringLiteral("나"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, TextRange{}, QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("가\n나X"));
    QCOMPARE(r.caretLineIndex, 1);
    QCOMPARE(editor::blocksToText(r.blocks),
             editor::blocksToText(editor::insertTextIntoBlocks(blocks, std::nullopt, QStringLiteral("X")).blocks));
}

// it: '텍스트 줄이 하나도 없으면 블록 배열 끝(임베드 뒤)에 덧붙인다(오늘 동작 보존)'
void EditorNewlineTest::noTextLineAppendsAfterTheEmbeds()
{
    const QVector<Block> blocks{image(QStringLiteral("x.png"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, TextRange{}, QStringLiteral("A\nB"));
    QCOMPARE(typesOf(r.blocks), (QStringList{QStringLiteral("embed"), QStringLiteral("text"), QStringLiteral("text")}));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("A\nB"));
    QCOMPARE(r.caretLineIndex, 1);
    QCOMPARE(editor::blocksToText(r.blocks),
             editor::blocksToText(editor::insertTextIntoBlocks(blocks, std::nullopt, QStringLiteral("A\nB")).blocks));
}

// it: '마커가 둘이면 첫 번째 마커가 clamp 기준이고 그 뒤 블록은 전혀 바뀌지 않는다'
void EditorNewlineTest::firstOfTwoMarkersIsTheClampPoint()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("본문")), editor::textBlock(QStringLiteral("(끝)")),
                                editor::textBlock(QStringLiteral("꼬리")), editor::textBlock(QStringLiteral("(끝)"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 3, 3), QStringLiteral("X"));
    QCOMPARE(editor::blocksToText(r.blocks), QStringLiteral("본X\n(끝)\n꼬리\n(끝)"));
    QCOMPARE(bytes(r.blocks.mid(1)), bytes(blocks.mid(1)));
}

// it: 'collapsed Enter는 두 결과 줄 모두 원본 줄의 align을 승계한다'
void EditorNewlineTest::collapsedEnterGivesBothLinesTheOriginalAlign()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("가운데정렬"), QStringLiteral("center"))};
    const TextPoint caret = caretAt(blocks, 0, 3);
    const InsertResult r = editor::replaceRangeInBlocks(blocks, TextRange{caret, caret}, QStringLiteral("\n"));
    QCOMPARE(bytes(r.blocks), bytes({editor::textBlock(QStringLiteral("가운데"), QStringLiteral("center")),
                                     editor::textBlock(QStringLiteral("정렬"), QStringLiteral("center"))}));
}

// it: '비-collapsed 병합은 첫 줄이 start 줄 align, 마지막 줄이 end 줄 align을 갖는다'
void EditorNewlineTest::mergedLinesTakeTheStartAndEndAlign()
{
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("ab"), QStringLiteral("center")),
                                editor::textBlock(QStringLiteral("cd"), QStringLiteral("right"))};
    const InsertResult r = editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 1, 1), QStringLiteral("X\nY\nZ"));
    QCOMPARE(bytes(r.blocks), bytes({editor::textBlock(QStringLiteral("aX"), QStringLiteral("center")),
                                     editor::textBlock(QStringLiteral("Y"), QStringLiteral("center")), // 중간 새 줄 = start 줄 align
                                     editor::textBlock(QStringLiteral("Zd"), QStringLiteral("right"))}));
}

// it: '무효 align은 키 자체가 생기지 않는다(isValidAlign 필터)' - the block is built raw, bypassing
// textBlock, like the web's object literal.
void EditorNewlineTest::invalidAlignNeverBecomesAKey()
{
    Block raw;
    raw.type = Block::Type::Text;
    raw.text = QStringLiteral("ab");
    raw.align = QStringLiteral("middle");
    const QVector<Block> blocks{raw};
    const TextPoint caret = caretAt(blocks, 0, 1);
    const InsertResult r = editor::replaceRangeInBlocks(blocks, TextRange{caret, caret}, QStringLiteral("\n"));
    QCOMPARE(bytes(r.blocks), bytes({editor::textBlock(QStringLiteral("a")), editor::textBlock(QStringLiteral("b"))}));
    for (const Block &b : r.blocks)
        QVERIFY(b.align.isEmpty()); // 'align' in b === false
}

// it: '입력 blocks 배열과 원소를 mutate하지 않는다'. The const& signature already forbids it; this keeps
// the promise if that ever changes. (The web's identity check blocks[1] === embed is value equality here.)
void EditorNewlineTest::inputBlocksAreNeverMutated()
{
    const Block theEmbed = image(QStringLiteral("x.png"));
    const QVector<Block> blocks{editor::textBlock(QStringLiteral("ab"), QStringLiteral("center")), theEmbed,
                                editor::textBlock(QStringLiteral("cd")), editor::textBlock(QStringLiteral("(끝)"))};
    const QVector<Block> before = blocks;
    editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 0, 1, 2, 1), QStringLiteral("X\nY"));
    editor::replaceRangeInBlocks(blocks, TextRange{}, QStringLiteral("Z"));
    editor::replaceRangeInBlocks(blocks, rangeAt(blocks, 2, 1, 0, 0), QStringLiteral("\n"));
    QVERIFY(blocks == before);
    QCOMPARE(bytes(blocks), bytes(before));
    QVERIFY(blocks.at(1) == theEmbed);
}

// ---- Port locks ------------------------------------------------------------------------------

// The input gate's boundary beyond the two web cases: at or after the LAST marker (>=, lastIndexOf),
// UTF-16 code units and not bytes, negative / huge carets.
void EditorNewlineTest::inputGateBoundaries_data()
{
    QTest::addColumn<QString>("text");
    QTest::addColumn<int>("caret");
    QTest::addColumn<bool>("blocked");

    // "가나다\n(끝)": the marker starts at unit 4 but at UTF-8 byte 10 - a byte reading opens 4..9.
    const QString hangul = QStringLiteral("가나다\n(끝)");
    QTest::newRow("hangul: one unit before the marker") << hangul << 3 << false;
    QTest::newRow("hangul: at the marker (unit 4, byte 10)") << hangul << 4 << true;
    QTest::newRow("hangul: inside the marker (a byte reading opens it)") << hangul << 5 << true;
    QTest::newRow("hangul: at the end (a byte reading opens it)") << hangul << 7 << true;

    const QString three = QStringLiteral("(끝)a(끝)b(끝)"); // markers at 0, 4, 8
    QTest::newRow("three markers: one before the last") << three << 7 << false;
    QTest::newRow("three markers: at the last") << three << 8 << true;
    QTest::newRow("three markers: at the first is open (only the last closes)") << three << 0 << false;

    const QString glued = QStringLiteral("본문(끝)"); // marker at 2
    QTest::newRow("glued marker: before") << glued << 1 << false;
    QTest::newRow("glued marker: at") << glued << 2 << true;
    QTest::newRow("glued marker: past the end") << glued << 5 << true;

    QTest::newRow("marker only: at 0") << QStringLiteral("(끝)") << 0 << true;
    QTest::newRow("marker only: negative caret") << QStringLiteral("(끝)") << -1 << false;
    QTest::newRow("empty text") << QString() << 0 << false;
    QTest::newRow("caret far past the end") << QStringLiteral("본문\n(끝)") << 100 << true;
    QTest::newRow("int max") << QStringLiteral("본문\n(끝)") << INT_MAX << true;
    QTest::newRow("int min") << QStringLiteral("본문\n(끝)") << INT_MIN << false;
    QTest::newRow("partial marker is no marker") << QStringLiteral("본문\n(끝") << 5 << false;
    QTest::newRow("marker split by a newline is no marker") << QStringLiteral("(끝\n)") << 3 << false;
}

void EditorNewlineTest::inputGateBoundaries()
{
    QFETCH(QString, text);
    QFETCH(int, caret);
    QFETCH(bool, blocked);
    QCOMPARE(editor::isInputBlocked(text, caret), blocked);
}

// isMarkerBlock = a text block whose text is "(끝)" after JS trim() (step2 isEndLine) - not
// QString::trimmed(), not a substring, never an embed.
void EditorNewlineTest::markerBlockIsTheJsTrimmedLine_data()
{
    QTest::addColumn<QString>("text");
    QTest::addColumn<QString>("align");
    QTest::addColumn<bool>("isEmbed");
    QTest::addColumn<bool>("marker");

    QTest::newRow("exact") << QStringLiteral("(끝)") << QString() << false << true;
    QTest::newRow("spaces around") << QStringLiteral(" (끝) ") << QString() << false << true;
    QTest::newRow("tab and CR around") << QStringLiteral("\t(끝)\r") << QString() << false << true;
    QTest::newRow("U+FEFF before (JS trim strips it)") << QStringLiteral("﻿(끝)") << QString() << false << true;
    QTest::newRow("U+0085 before (JS trim keeps it)") << QStringLiteral("\u0085(끝)") << QString() << false << false;
    QTest::newRow("U+3000 before, NBSP after") << QStringLiteral("　(끝) ") << QString() << false << true;
    QTest::newRow("glued after") << QStringLiteral("(끝)x") << QString() << false << false;
    QTest::newRow("glued before") << QStringLiteral("x(끝)") << QString() << false << false;
    QTest::newRow("empty") << QString() << QString() << false << false;
    QTest::newRow("half") << QStringLiteral("(끝") << QString() << false << false;
    QTest::newRow("space inside") << QStringLiteral("( 끝)") << QString() << false << false;
    QTest::newRow("quoted mid-line") << QStringLiteral("본문 (끝) 인용") << QString() << false << false;
    QTest::newRow("aligned marker") << QStringLiteral("(끝)") << QStringLiteral("center") << false << true;
    QTest::newRow("embed whose payload says (end)") << QStringLiteral("(끝)") << QString() << true << false;
}

void EditorNewlineTest::markerBlockIsTheJsTrimmedLine()
{
    QFETCH(QString, text);
    QFETCH(QString, align);
    QFETCH(bool, isEmbed);
    QFETCH(bool, marker);
    const Block block = isEmbed ? editor::embedBlock(object({{QStringLiteral("embedType"), str(QStringLiteral("x"))},
                                                             {QStringLiteral("text"), str(text)}}))
                                : editor::textBlock(text, align);
    QCOMPARE(editor::isMarkerBlock(block), marker);
}

// renormalizeEndMarker + serialize == writerBody.serializeBodyFromBlocks, byte for byte: the seven
// serializeBodyFromBlocks specs (writerBody.test.js) and the marker-line edges. Rows generated by
// running the web modules under node.
void EditorNewlineTest::renormalizationMatchesTheWebBytes_data()
{
    QTest::addColumn<QString>("input");    // web serialize(blocks)
    QTest::addColumn<QString>("expected"); // web serializeBodyFromBlocks(blocks)

    QTest::newRow("wb1 embed between texts stays")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"embedType\":\"image\",\"src\":\"data:img\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"본문\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"embedType\":\"image\",\"src\":\"data:img\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"본문\"}]}");
    QTest::newRow("wb2 marker anywhere goes last")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"data:img\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"본문\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"embedType\":\"image\",\"src\":\"data:img\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("wb3 marker align carried")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}");
    QTest::newRow("wb4 unaligned marker has no align key")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("wb5 several markers merge, first align wins")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"right\"},{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"right\"}]}");
    QTest::newRow("wb6 no marker, none made")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"}]}");
    QTest::newRow("wb7 spaced marker rewritten, align carried")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\" (끝) \",\"align\":\"justify\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"justify\"}]}");
    QTest::newRow("U+FEFF marker is canonicalized")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"},{\"type\":\"text\",\"text\":\"본문\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("U+0085 marker is not a marker")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\u0085(끝)\"},{\"type\":\"text\",\"text\":\"본문\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\u0085(끝)\"},{\"type\":\"text\",\"text\":\"본문\"}]}");
    QTest::newRow("quoted marker stays in place")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문 (끝) 인용\"},{\"type\":\"text\",\"text\":\"꼬리\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문 (끝) 인용\"},{\"type\":\"text\",\"text\":\"꼬리\"}]}");
    QTest::newRow("marker text inside an embed is not a marker")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"article\",\"title\":\"(끝)\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"본문\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"article\",\"title\":\"(끝)\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"본문\"}]}");
    QTest::newRow("empty list")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}");
    QTest::newRow("marker only")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("marker before embeds goes after them")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"a.png\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"b.png\",\"type\":\"embed\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"a.png\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"b.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("glued marker is not renormalized")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문(끝)\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문(끝)\"}]}");
    QTest::newRow("first marker aligned, later unaligned")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"left\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"left\"}]}");
    QTest::newRow("first marker unaligned, later aligned")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"right\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}");
}

void EditorNewlineTest::renormalizationMatchesTheWebBytes()
{
    QFETCH(QString, input);
    QFETCH(QString, expected);
    QCOMPARE(editor::serialize(editor::renormalizeEndMarker(editor::deserialize(input))), expected);
}

// replaceRangeInBlocks against the web, byte for byte, on the cases the 26 web specs leave implicit:
// point resolution (missing lines, offsets clamped into the line), the marker-line criterion (quoted /
// whitespace / U+FEFF / U+0085), "\r", empty insertions, surrogate halves, two markers, embeds around
// the marker. Rows generated by running the web module under node.
void EditorNewlineTest::rangeReplacementMatchesTheWebBytes_data()
{
    QTest::addColumn<QString>("input");    // web serialize(blocks)
    QTest::addColumn<QString>("start");    // "lineIndex:offset", "" = unknown
    QTest::addColumn<QString>("end");
    QTest::addColumn<QString>("text");
    QTest::addColumn<QString>("expected"); // web serialize(result.blocks)
    QTest::addColumn<int>("caretLineIndex");

    QTest::newRow("out-of-range line falls back to the last line end")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가\"},{\"type\":\"text\",\"text\":\"나\"}]}")
        << QStringLiteral("5:0") << QStringLiteral("5:0") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가\"},{\"type\":\"text\",\"text\":\"나X\"}]}")
        << 1;
    QTest::newRow("negative line falls back")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가\"},{\"type\":\"text\",\"text\":\"나\"}]}")
        << QStringLiteral("-1:0") << QStringLiteral("-1:0") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가\"},{\"type\":\"text\",\"text\":\"나X\"}]}")
        << 1;
    QTest::newRow("offset past the line end clamps to the line end")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ab\"},{\"type\":\"text\",\"text\":\"cd\"}]}")
        << QStringLiteral("0:99") << QStringLiteral("0:99") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abX\"},{\"type\":\"text\",\"text\":\"cd\"}]}")
        << 0;
    QTest::newRow("negative offset clamps to the line start")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ab\"},{\"type\":\"text\",\"text\":\"cd\"}]}")
        << QStringLiteral("1:-5") << QStringLiteral("1:-5") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ab\"},{\"type\":\"text\",\"text\":\"Xcd\"}]}")
        << 1;
    QTest::newRow("offset of another line clamps inside the given line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ab\"},{\"type\":\"text\",\"text\":\"cd\"}]}")
        << QStringLiteral("0:4") << QStringLiteral("0:4") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abX\"},{\"type\":\"text\",\"text\":\"cd\"}]}")
        << 0;
    QTest::newRow("marker first with an embed before it")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"e.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("") << QStringLiteral("") << QStringLiteral("A\nB")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"e.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"A\"},{\"type\":\"text\",\"text\":\"B\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << 1;
    QTest::newRow("marker first, start on the line after it")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"꼬리\"}]}")
        << QStringLiteral("1:4") << QStringLiteral("1:6") << QStringLiteral("X\nY")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"X\"},{\"type\":\"text\",\"text\":\"Y\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"꼬리\"}]}")
        << 1;
    QTest::newRow("quoted marker mid-line is not a clamp point")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"},{\"type\":\"text\",\"text\":\"c\"}]}")
        << QStringLiteral("0:2") << QStringLiteral("1:8") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a Xc\"}]}")
        << 0;
    QTest::newRow("whitespace marker line is a clamp point")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\" (끝) \"}]}")
        << QStringLiteral("0:1") << QStringLiteral("1:8") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본X\"},{\"type\":\"text\",\"text\":\" (끝) \"}]}")
        << 0;
    QTest::newRow("U+FEFF marker line is a clamp point (JS trim strips it)")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}")
        << QStringLiteral("0:1") << QStringLiteral("1:7") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본X\"},{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}")
        << 0;
    QTest::newRow("U+0085 marker line is not a clamp point (JS trim keeps it)")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"\u0085(끝)\"}]}")
        << QStringLiteral("0:1") << QStringLiteral("1:7") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본X\"}]}")
        << 0;
    QTest::newRow("aligned marker keeps its align")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}")
        << QStringLiteral("") << QStringLiteral("") << QStringLiteral("A")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문A\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}")
        << 0;
    QTest::newRow("CR stays in the inserted text (split on LF only)")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ab\"}]}")
        << QStringLiteral("0:1") << QStringLiteral("0:1") << QStringLiteral("x\r\ny")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ax\\r\"},{\"type\":\"text\",\"text\":\"yb\"}]}")
        << 1;
    QTest::newRow("empty insertion deletes the selection")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello world\"}]}")
        << QStringLiteral("0:5") << QStringLiteral("0:11") << QStringLiteral("")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello\"}]}")
        << 0;
    QTest::newRow("empty insertion on a marker-first document adds an empty line (web quirk)")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"꼬리\"}]}")
        << QStringLiteral("1:4") << QStringLiteral("1:6") << QStringLiteral("")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"꼬리\"}]}")
        << 0;
    QTest::newRow("empty insertion over the line before the marker keeps the marker")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("0:1") << QStringLiteral("1:3") << QStringLiteral("")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << 0;
    QTest::newRow("offset inside a surrogate pair slices code units")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\U0001F600b\"}]}")
        << QStringLiteral("0:2") << QStringLiteral("0:2") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\\ud83dX\\ude00b\"}]}")
        << 0;
    QTest::newRow("two markers, first at line 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"꼬리\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("2:8") << QStringLiteral("2:8") << QStringLiteral("Z")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Z\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"꼬리\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << 0;
    QTest::newRow("embed inside a selection that ends on the marker line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ab\"},{\"embedType\":\"image\",\"src\":\"m.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"cd\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("0:1") << QStringLiteral("2:9") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"aX\"},{\"embedType\":\"image\",\"src\":\"m.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << 0;
    QTest::newRow("embed after the marker stays after it")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"t.png\",\"type\":\"embed\"}]}")
        << QStringLiteral("") << QStringLiteral("") << QStringLiteral("A")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문A\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"t.png\",\"type\":\"embed\"}]}")
        << 0;
    QTest::newRow("only embeds, caret given")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"a.png\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"b.png\",\"type\":\"embed\"}]}")
        << QStringLiteral("0:0") << QStringLiteral("0:0") << QStringLiteral("Z")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"a.png\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"b.png\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"Z\"}]}")
        << 0;
    QTest::newRow("empty document, collapsed caret at line 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << QStringLiteral("0:0") << QStringLiteral("0:0") << QStringLiteral("Z")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Z\"}]}")
        << 0;
    QTest::newRow("empty text line only")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}")
        << QStringLiteral("") << QStringLiteral("") << QStringLiteral("Z")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Z\"}]}")
        << 0;
    QTest::newRow("multi-line insert into an aligned middle line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"bc\",\"align\":\"right\"},{\"type\":\"text\",\"text\":\"d\"}]}")
        << QStringLiteral("1:3") << QStringLiteral("1:3") << QStringLiteral("1\n2\n3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b1\",\"align\":\"right\"},{\"type\":\"text\",\"text\":\"2\",\"align\":\"right\"},{\"type\":\"text\",\"text\":\"3c\",\"align\":\"right\"},{\"type\":\"text\",\"text\":\"d\"}]}")
        << 3;
    QTest::newRow("reverse range across the marker line clamps")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ab\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("1:6") << QStringLiteral("0:1") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"aX\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << 0;
    QTest::newRow("start known, end on a missing line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ab\"},{\"type\":\"text\",\"text\":\"cd\"}]}")
        << QStringLiteral("0:1") << QStringLiteral("9:0") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"aXb\"},{\"type\":\"text\",\"text\":\"cd\"}]}")
        << 0;
    QTest::newRow("marker line in the middle, selection inside the tail after it")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"꼬리\"}]}")
        << QStringLiteral("2:7") << QStringLiteral("2:9") << QStringLiteral("X")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문X\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"꼬리\"}]}")
        << 0;
}

void EditorNewlineTest::rangeReplacementMatchesTheWebBytes()
{
    QFETCH(QString, input);
    QFETCH(QString, start);
    QFETCH(QString, end);
    QFETCH(QString, text);
    QFETCH(QString, expected);
    QFETCH(int, caretLineIndex);
    const InsertResult r = editor::replaceRangeInBlocks(editor::deserialize(input), TextRange{point(start), point(end)}, text);
    QCOMPARE(editor::serialize(r.blocks), expected);
    QCOMPARE(r.caretLineIndex, caretLineIndex);
}

// Pre-decision 1 - Backspace/Delete across a line boundary passes the gate. The web merges natively
// with no guard (node, 2026-11-01: "본문" + "(끝)" -> "본문(끝)" passes the substring send guard and
// serializeBodyFromBlocks leaves it in place). Expected values: the adopted rule evaluated with JS
// String.prototype.trim() under node.
void EditorNewlineTest::lineMergeGate_data()
{
    QTest::addColumn<QString>("upper");
    QTest::addColumn<QString>("lower");
    QTest::addColumn<bool>("blocked");

    QTest::newRow("line before + marker (BS at the marker start / Del before it)")
        << QStringLiteral("본문") << QStringLiteral("(끝)") << true;
    QTest::newRow("marker + line after") << QStringLiteral("(끝)") << QStringLiteral("꼬리") << true;
    QTest::newRow("marker + marker") << QStringLiteral("(끝)") << QStringLiteral("(끝)") << true;
    QTest::newRow("spaced marker + text") << QStringLiteral(" (끝) ") << QStringLiteral("x") << true;
    QTest::newRow("U+0085 line + marker (JS trim keeps U+0085)") << QStringLiteral("\u0085") << QStringLiteral("(끝)") << true;
    QTest::newRow("empty line + marker keeps the marker line") << QString() << QStringLiteral("(끝)") << false;
    QTest::newRow("marker + empty line keeps the marker line") << QStringLiteral("(끝)") << QString() << false;
    QTest::newRow("spaces + marker keeps the marker line") << QStringLiteral("   ") << QStringLiteral("(끝)") << false;
    QTest::newRow("tab + spaced marker keeps the marker line") << QStringLiteral("\t") << QStringLiteral(" (끝) ") << false;
    QTest::newRow("U+FEFF line + marker keeps the marker line (JS trim strips U+FEFF)")
        << QStringLiteral("﻿") << QStringLiteral("(끝)") << false;
    QTest::newRow("no marker") << QStringLiteral("본문") << QStringLiteral("꼬리") << false;
    QTest::newRow("quoted marker is not a marker line") << QStringLiteral("인용 (끝) 문장") << QStringLiteral("다음") << false;
    QTest::newRow("two halves forming a marker line") << QStringLiteral("(끝") << QStringLiteral(")") << false;
    QTest::newRow("two halves forming a glued marker (no marker line existed)")
        << QStringLiteral("x(끝") << QStringLiteral(")") << false;
}

void EditorNewlineTest::lineMergeGate()
{
    QFETCH(QString, upper);
    QFETCH(QString, lower);
    QFETCH(bool, blocked);
    QCOMPARE(editor::isLineMergeBlocked(upper, lower), blocked);

    // Why the refused merges are the dangerous ones: the joined line still passes the substring send
    // guard but is no longer a marker line, so the save-time renormalization leaves it where it is.
    const QString merged = upper + lower;
    if (blocked) {
        QVERIFY(editor::hasEndMarker(merged));
        QVERIFY(!editor::isEndLine(merged));
        QCOMPARE(bytes(editor::renormalizeEndMarker({editor::textBlock(merged)})), bytes({editor::textBlock(merged)}));
    } else if (editor::isEndLine(upper) || editor::isEndLine(lower)) {
        QVERIFY(editor::isEndLine(merged)); // an allowed merge keeps the marker line whole
    }
}
