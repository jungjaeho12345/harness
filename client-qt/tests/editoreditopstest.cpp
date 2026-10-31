#include "editoreditopstest.h"

#include "editor/editorcontent.h"
#include "editor/editoreditops.h"
#include "editor/editorroles.h"

#include <QChar>
#include <QLatin1String>
#include <QString>
#include <QVector>
#include <QtTest>

#include <climits>

using editor::Block;
using editor::JsonValue;
using editor::WordDeletion;

namespace {

Block text(const QString &line, const QString &align = QString())
{
    return editor::textBlock(line, align);
}

// embedBlock({ embedType: 'image', src }) - the embed the web fixtures use.
Block image(const QString &src)
{
    JsonValue fields = JsonValue::makeObject();
    fields.insert(QStringLiteral("embedType"), JsonValue::makeString(QStringLiteral("image")));
    fields.insert(QStringLiteral("src"), JsonValue::makeString(src));
    return editor::embedBlock(fields);
}

// Comparisons go through the step1 serializer (byte-identical with the web's JSON.stringify).
QString bytes(const QVector<Block> &blocks)
{
    return editor::serialize(blocks);
}

} // namespace

// ---- editorEditOps — deleteWordAt (단어 지우기) ---------------------------------------------------

// it: 'deletes only the word at the caret column (주변 공백 유지)'
void EditorEditOpsTest::deletesOnlyTheWordAtTheCaret()
{
    const QVector<Block> blocks{text(QStringLiteral("안녕 세상 테스트")), text(QStringLiteral("둘째"))};
    const WordDeletion r = editor::deleteWordAt(blocks, 0, 4);
    QVERIFY(r.changed);
    QCOMPARE(r.blocks.size(), 2);
    QCOMPARE(bytes({r.blocks.at(0)}), bytes({text(QStringLiteral("안녕  테스트"))}));
    QCOMPARE(bytes({r.blocks.at(1)}), bytes({text(QStringLiteral("둘째"))}));
    QCOMPARE(r.caretColumn, std::optional<int>(3));
}

// it: 'is a no-op on the "(끝)" marker line (마커 보존)'
void EditorEditOpsTest::isANoOpOnTheMarkerLine()
{
    const QVector<Block> blocks{text(QStringLiteral("본문")), text(editor::END_MARKER)};
    const WordDeletion r = editor::deleteWordAt(blocks, 1, 1);
    QVERIFY(!r.changed);
    QCOMPARE(bytes(r.blocks), bytes(blocks));
}

// it: 'is a no-op when the line has no word (공백만)'
void EditorEditOpsTest::isANoOpWithoutAWord()
{
    const QVector<Block> blocks{text(QStringLiteral("   "))};
    const WordDeletion r = editor::deleteWordAt(blocks, 0, 1);
    QVERIFY(!r.changed);
    QCOMPARE(bytes(r.blocks), bytes(blocks));
}

// it: 'deletes a word on the first line (제목 줄 텍스트 변경 — 재동기화는 step 4)'
void EditorEditOpsTest::deletesAWordOnTheFirstLine()
{
    const QVector<Block> blocks{text(QStringLiteral("제목 기사")), text(QStringLiteral("본문"))};
    const WordDeletion r = editor::deleteWordAt(blocks, 0, 0);
    QVERIFY(r.changed);
    QVERIFY(!r.blocks.isEmpty());
    QCOMPARE(bytes({r.blocks.at(0)}), bytes({text(QStringLiteral(" 기사"))}));
    QCOMPARE(r.caretColumn, std::optional<int>(0));
}

// it: 'keeps embed count/position unchanged'
void EditorEditOpsTest::keepsEmbedCountAndPosition()
{
    const QVector<Block> blocks{text(QStringLiteral("가나 다라")), image(QStringLiteral("x")), text(QStringLiteral("마바 사아"))};
    const WordDeletion r = editor::deleteWordAt(blocks, 1, 0); // 텍스트-줄 1 = 블록 인덱스 2
    QCOMPARE(r.blocks.size(), 3);
    QCOMPARE(bytes({r.blocks.at(1)}), bytes({image(QStringLiteral("x"))}));
    QCOMPARE(bytes({r.blocks.at(2)}), bytes({text(QStringLiteral(" 사아"))}));
}

// it: 'is a no-op for an out-of-range text line index'
void EditorEditOpsTest::isANoOpForAnOutOfRangeLine()
{
    const QVector<Block> blocks{text(QStringLiteral("가"))};
    const WordDeletion r = editor::deleteWordAt(blocks, 5, 0);
    QVERIFY(!r.changed);
    QCOMPARE(bytes(r.blocks), bytes(blocks));
}

// it: 'preserves the align field of the line a word is deleted from (승계)'
void EditorEditOpsTest::keepsTheLineAlign()
{
    const WordDeletion r = editor::deleteWordAt({text(QStringLiteral("hello world"), QStringLiteral("center"))}, 0, 0);
    QVERIFY(r.changed);
    QCOMPARE(r.blocks.size(), 1);
    QCOMPARE(bytes({r.blocks.at(0)}), bytes({text(QStringLiteral(" world"), QStringLiteral("center"))}));
    QCOMPARE(r.blocks.at(0).align, QStringLiteral("center"));
}

// it: 'does not add a spurious align key to an unaligned line'
void EditorEditOpsTest::addsNoAlignKey()
{
    const WordDeletion r = editor::deleteWordAt({text(QStringLiteral("hello world"))}, 0, 0);
    QVERIFY(r.changed);
    QCOMPARE(r.blocks.size(), 1);
    QCOMPARE(r.blocks.at(0).text, QStringLiteral(" world"));
    QVERIFY(r.blocks.at(0).align.isEmpty());
    QVERIFY(!bytes({r.blocks.at(0)}).contains(QLatin1String("align")));
}

// ---- editorEditOps — input immutability (입력 blocks 불변) -----------------------------------------

// it: 'does not mutate the input blocks array in any function' - the deleteWordAt part (sortDocument /
// sortParagraph are P6).
void EditorEditOpsTest::doesNotMutateTheInput()
{
    const auto make = [] {
        return QVector<Block>{text(QStringLiteral("나")), image(QStringLiteral("x")), text(QStringLiteral("가")),
                              text(editor::END_MARKER)};
    };
    const QVector<Block> b3 = make();
    editor::deleteWordAt(b3, 0, 0);
    QVERIFY(b3 == make());
    QCOMPARE(bytes(b3), bytes(make()));
}

// ---- Port locks -----------------------------------------------------------------------------------

// deleteWordAt over lines x columns, byte for byte. On every row the marker contract holds: a no-op returns the
// normalized blocks with no caret; a delete removes one whitespace-free run from a non-marker line, nothing else,
// and never cuts into a "(끝)" - every marker occurrence is taken whole or left whole.
void EditorEditOpsTest::deleteWordAtMatchesTheWebBytes_data()
{
    QTest::addColumn<QString>("input"); // web serialize(blocks)
    QTest::addColumn<int>("line");
    QTest::addColumn<int>("column");
    QTest::addColumn<QString>("expected"); // web serialize(result.blocks)
    QTest::addColumn<bool>("changed");
    QTest::addColumn<int>("caretColumn"); // -1 = null

    QTest::newRow("W1 three words line 0 col -1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << -1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 0;
    QTest::newRow("W1 three words line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 0;
    QTest::newRow("W1 three words line 0 col 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 0;
    QTest::newRow("W1 three words line 0 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 0;
    QTest::newRow("W1 three words line 0 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕  테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 3;
    QTest::newRow("W1 three words line 0 col 4")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 4
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕  테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 3;
    QTest::newRow("W1 three words line 0 col 5")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 5
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕  테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 3;
    QTest::newRow("W1 three words line 0 col 6")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 6
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 \"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 6;
    QTest::newRow("W1 three words line 0 col 7")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 7
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 \"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 6;
    QTest::newRow("W1 three words line 0 col 8")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 8
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 \"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 6;
    QTest::newRow("W1 three words line 0 col 9")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 9
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 \"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 6;
    QTest::newRow("W1 three words line 0 col 10")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 테스트\"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << 0 << 10
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"안녕 세상 \"},{\"type\":\"text\",\"text\":\"둘째\"}]}") << true << 6;
    QTest::newRow("W2 body,END line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << true << 0;
    QTest::newRow("W2 body,END line 0 col 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0 << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << true << 0;
    QTest::newRow("W2 body,END line 0 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << true << 0;
    QTest::newRow("W2 body,END line 0 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << true << 0;
    QTest::newRow("W2 body,END line 1 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << false << -1;
    QTest::newRow("W2 body,END line 1 col 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1 << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << false << -1;
    QTest::newRow("W2 body,END line 1 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << false << -1;
    QTest::newRow("W2 body,END line 1 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << false << -1;
    QTest::newRow("W3 spaces only line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"   \"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"   \"}]}") << false << -1;
    QTest::newRow("W3 spaces only line 0 col 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"   \"}]}") << 0 << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"   \"}]}") << false << -1;
    QTest::newRow("W3 spaces only line 0 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"   \"}]}") << 0 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"   \"}]}") << false << -1;
    QTest::newRow("W3 spaces only line 0 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"   \"}]}") << 0 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"   \"}]}") << false << -1;
    QTest::newRow("W4 a,E,bb cc line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << true << 0;
    QTest::newRow("W4 a,E,bb cc line 0 col 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 0 << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << true << 0;
    QTest::newRow("W4 a,E,bb cc line 0 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 0 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << true << 0;
    QTest::newRow("W4 a,E,bb cc line 0 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 0 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << true << 0;
    QTest::newRow("W4 a,E,bb cc line 0 col 4")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 0 << 4
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << true << 0;
    QTest::newRow("W4 a,E,bb cc line 0 col 5")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 0 << 5
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << true << 0;
    QTest::newRow("W4 a,E,bb cc line 1 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 1 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\" cc\"}]}") << true << 0;
    QTest::newRow("W4 a,E,bb cc line 1 col 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 1 << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\" cc\"}]}") << true << 0;
    QTest::newRow("W4 a,E,bb cc line 1 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 1 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\" cc\"}]}") << true << 0;
    QTest::newRow("W4 a,E,bb cc line 1 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 1 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb \"}]}") << true << 3;
    QTest::newRow("W4 a,E,bb cc line 1 col 4")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 1 << 4
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb \"}]}") << true << 3;
    QTest::newRow("W4 a,E,bb cc line 1 col 5")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb cc\"}]}") << 1 << 5
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"bb \"}]}") << true << 3;
    QTest::newRow("W5 spaced marker line line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << false << -1;
    QTest::newRow("W5 spaced marker line line 0 col 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << 0 << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << false << -1;
    QTest::newRow("W5 spaced marker line line 0 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << 0 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << false << -1;
    QTest::newRow("W5 spaced marker line line 0 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << 0 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << false << -1;
    QTest::newRow("W5 spaced marker line line 0 col 4")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << 0 << 4
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << false << -1;
    QTest::newRow("W5 spaced marker line line 0 col 5")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << 0 << 5
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}") << false << -1;
    QTest::newRow("W6 glued marker line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문(끝)\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << true << 0;
    QTest::newRow("W6 glued marker line 0 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문(끝)\"}]}") << 0 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << true << 0;
    QTest::newRow("W6 glued marker line 0 col 6")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문(끝)\"}]}") << 0 << 6
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << true << 0;
    QTest::newRow("W7 quoted marker word line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) b\"}]}") << true << 0;
    QTest::newRow("W7 quoted marker word line 0 col 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"}]}") << 0 << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) b\"}]}") << true << 0;
    QTest::newRow("W7 quoted marker word line 0 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"}]}") << 0 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a  b\"}]}") << true << 2;
    QTest::newRow("W7 quoted marker word line 0 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"}]}") << 0 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a  b\"}]}") << true << 2;
    QTest::newRow("W7 quoted marker word line 0 col 4")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"}]}") << 0 << 4
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a  b\"}]}") << true << 2;
    QTest::newRow("W7 quoted marker word line 0 col 5")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"}]}") << 0 << 5
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a  b\"}]}") << true << 2;
    QTest::newRow("W7 quoted marker word line 0 col 6")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"}]}") << 0 << 6
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) \"}]}") << true << 6;
    QTest::newRow("W7 quoted marker word line 0 col 7")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"}]}") << 0 << 7
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) \"}]}") << true << 6;
    QTest::newRow("W7 quoted marker word line 0 col 8")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) b\"}]}") << 0 << 8
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a (끝) \"}]}") << true << 6;
    QTest::newRow("W8 BOM marker line line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}") << false << -1;
    QTest::newRow("W8 BOM marker line line 0 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}") << 0 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}") << false << -1;
    QTest::newRow("W8 BOM marker line line 0 col 4")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}") << 0 << 4
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}") << false << -1;
    QTest::newRow("W9 NEL marker line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\u0085(끝)\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << true << 0;
    QTest::newRow("W9 NEL marker line 0 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\u0085(끝)\"}]}") << 0 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << true << 0;
    QTest::newRow("W9 NEL marker line 0 col 4")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\u0085(끝)\"}]}") << 0 << 4
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << true << 0;
    QTest::newRow("W10 aligned line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello world\",\"align\":\"center\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" world\",\"align\":\"center\"}]}") << true << 0;
    QTest::newRow("W10 aligned line 0 col 6")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello world\",\"align\":\"center\"}]}") << 0 << 6
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello \",\"align\":\"center\"}]}") << true << 6;
    QTest::newRow("W10 aligned line 0 col 11")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello world\",\"align\":\"center\"}]}") << 0 << 11
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello \",\"align\":\"center\"}]}") << true << 6;
    QTest::newRow("W11 out of range line -1 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << -1 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << false << -1;
    QTest::newRow("W11 out of range line 1 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << 1 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << false << -1;
    QTest::newRow("W11 out of range line 5 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << 5 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << false << -1;
    QTest::newRow("W11 out of range line INT_MIN col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << INT_MIN << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << false << -1;
    QTest::newRow("W11 out of range line INT_MAX col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << INT_MAX << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"가 나\"}]}") << false << -1;
    QTest::newRow("W12 empty document line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << false << -1;
    QTest::newRow("W13 embed only line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << false << -1;
    QTest::newRow("W14 marker inside two words line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"x(끝)y z\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" z\"}]}") << true << 0;
    QTest::newRow("W14 marker inside two words line 0 col 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"x(끝)y z\"}]}") << 0 << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" z\"}]}") << true << 0;
    QTest::newRow("W14 marker inside two words line 0 col 5")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"x(끝)y z\"}]}") << 0 << 5
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" z\"}]}") << true << 0;
    QTest::newRow("W14 marker inside two words line 0 col 6")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"x(끝)y z\"}]}") << 0 << 6
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"x(끝)y \"}]}") << true << 6;
    QTest::newRow("W15 doubled parens line 0 col 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"((끝)) w\"}]}") << 0 << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" w\"}]}") << true << 0;
    QTest::newRow("W15 doubled parens line 0 col 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"((끝)) w\"}]}") << 0 << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" w\"}]}") << true << 0;
    QTest::newRow("W15 doubled parens line 0 col 6")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"((끝)) w\"}]}") << 0 << 6
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"((끝)) \"}]}") << true << 6;
    QTest::newRow("W15 doubled parens line 0 col 7")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"((끝)) w\"}]}") << 0 << 7
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"((끝)) \"}]}") << true << 6;
}

void EditorEditOpsTest::deleteWordAtMatchesTheWebBytes()
{
    QFETCH(QString, input);
    QFETCH(int, line);
    QFETCH(int, column);
    QFETCH(QString, expected);
    QFETCH(bool, changed);
    QFETCH(int, caretColumn);
    const QVector<Block> blocks = editor::deserialize(input);
    const WordDeletion r = editor::deleteWordAt(blocks, line, column);
    QCOMPARE(bytes(r.blocks), expected);
    QCOMPARE(r.changed, changed);
    QCOMPARE(r.caretColumn, caretColumn < 0 ? std::nullopt : std::optional<int>(caretColumn));

    if (!r.changed) {
        QVERIFY(r.blocks == editor::normalizeBlocks(blocks));
        return;
    }
    const int index = editor::textLineToBlockIndex(blocks, line);
    QVERIFY(index >= 0 && index < r.blocks.size());
    const QString before = blocks.at(index).text;
    const QString after = r.blocks.at(index).text;
    QVERIFY(!editor::isEndLine(before));
    QVERIFY(r.caretColumn.has_value());
    const qsizetype start = *r.caretColumn;
    const qsizetype length = before.size() - after.size();
    QVERIFY(length > 0);
    QCOMPARE(after, before.left(start) + before.mid(start + length));
    for (qsizetype k = start; k < start + length; ++k)
        QVERIFY(!editor::isJsWhitespace(before.at(k)));
    const qsizetype end = start + length;
    const qsizetype markerLength = editor::END_MARKER.size();
    for (qsizetype p = before.indexOf(editor::END_MARKER); p >= 0; p = before.indexOf(editor::END_MARKER, p + 1)) {
        QVERIFY2(!(p < start && start < p + markerLength), "the delete starts inside a (끝)");
        QVERIFY2(!(p < end && end < p + markerLength), "the delete ends inside a (끝)");
    }
}

// The web normalizes its input first: an align outside ALIGN_VALUES is dropped - on a delete and on the marker
// no-op alike. Such a block only exists here when built field by field, so the result is compared field by field.
void EditorEditOpsTest::normalizesItsInputLikeTheWeb()
{
    Block plain;
    plain.type = Block::Type::Text;
    plain.text = QStringLiteral("a");
    plain.align = QStringLiteral("bogus");
    Block marker;
    marker.type = Block::Type::Text;
    marker.text = editor::END_MARKER;
    marker.align = QStringLiteral("nope");
    const QVector<Block> raw{plain, marker};

    const QString wantWord = QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    const QString wantMarkerNoOp = QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");

    QVERIFY(editor::deleteWordAt(raw, 0, 0).blocks == editor::deserialize(wantWord));
    QVERIFY(editor::deleteWordAt(raw, 1, 0).blocks == editor::deserialize(wantMarkerNoOp));
}
