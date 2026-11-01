#include "editorshortcutstest.h"

#include "editor/editorcontent.h"
#include "editor/editornewline.h"
#include "editor/editorroles.h"
#include "editor/editorshortcuts.h"

#include <QChar>
#include <QLatin1Char>
#include <QLatin1String>
#include <QString>
#include <QStringList>
#include <QVector>
#include <QtTest>

#include <climits>
#include <functional>
#include <initializer_list>
#include <optional>
#include <utility>

using editor::Block;
using editor::JsonValue;
using editor::KeyInput;

namespace {

// A string built code unit by code unit - the only way to spell a lone surrogate (no C++ literal can).
QString units(std::initializer_list<char16_t> codeUnits)
{
    QString out;
    for (const char16_t unit : codeUnits)
        out.append(QChar(unit));
    return out;
}

JsonValue str(const QString &value)
{
    return JsonValue::makeString(value);
}

// embedBlock({ embedType, <key>: value }) - the two embed shapes the web fixtures use.
Block embed(const QString &embedType, const QString &key, const QString &value)
{
    JsonValue fields = JsonValue::makeObject();
    fields.insert(QStringLiteral("embedType"), str(embedType));
    fields.insert(key, str(value));
    return editor::embedBlock(fields);
}

Block image(const QString &src)
{
    return embed(QStringLiteral("image"), QStringLiteral("src"), src);
}

Block video(const QString &videoId)
{
    return embed(QStringLiteral("video"), QStringLiteral("videoId"), videoId);
}

Block text(const QString &line, const QString &align = QString())
{
    return editor::textBlock(line, align);
}

// Comparisons go through the step1 serializer (byte-identical with the web's JSON.stringify), so a failure
// prints readable blocks - text, align and embed payload included.
QString bytes(const QVector<Block> &blocks)
{
    return editor::serialize(blocks);
}

QStringList textLines(const QVector<Block> &blocks)
{
    return editor::blocksToText(blocks).split(QLatin1Char('\n')); // JS split('\n')
}

// A modifier spec "CASM" - Ctrl, Alt, Shift, Meta, '-' for an absent flag.
Qt::KeyboardModifiers modifiers(const QString &spec)
{
    Qt::KeyboardModifiers out = Qt::NoModifier;
    if (spec.contains(QLatin1Char('C')))
        out |= Qt::ControlModifier;
    if (spec.contains(QLatin1Char('A')))
        out |= Qt::AltModifier;
    if (spec.contains(QLatin1Char('S')))
        out |= Qt::ShiftModifier;
    if (spec.contains(QLatin1Char('M')))
        out |= Qt::MetaModifier;
    return out;
}

// The web test's event literal: press("-A--", "y") is { altKey: true, key: 'y' }, press("-A--", "", "KeyY")
// is { altKey: true, code: 'KeyY' }.
KeyInput press(const char *mods, const char *key, const char *code = "")
{
    return KeyInput{modifiers(QLatin1String(mods)), QString::fromUtf8(key), QString::fromUtf8(code)};
}

// Every predicate, in the order the web's WriterPage.onKeyDown asks them - so the first name of a list is the
// shortcut the web runs for that press.
struct NamedPredicate {
    const char *name;
    bool (*test)(const KeyInput &);
};
const NamedPredicate PREDICATES[] = {
    {"isToggleOverwrite", editor::isToggleOverwrite},
    {"isCompanyCode", editor::isCompanyCode},
    {"isFindReplace", editor::isFindReplace},
    {"isGlyphInput", editor::isGlyphInput},
    {"isPasteOriginal", editor::isPasteOriginal},
    {"isInsertEndMarker", editor::isInsertEndMarker},
    {"isInsertContinueMarker", editor::isInsertContinueMarker},
    {"isUndo", editor::isUndo},
    {"isRedo", editor::isRedo},
    {"isDeleteLine", editor::isDeleteLine},
};

QStringList firingPredicates(const KeyInput &e)
{
    QStringList out;
    for (const NamedPredicate &p : PREDICATES) {
        if (p.test(e))
            out.append(QLatin1String(p.name));
    }
    return out;
}

// A reserved combo pressed on a QWERTY layout: its exact modifiers, its key, and the physical key of that letter.
KeyInput qwertyPress(const editor::KeyCombo &combo)
{
    Qt::KeyboardModifiers mods = Qt::NoModifier;
    if (combo.ctrl)
        mods |= Qt::ControlModifier;
    if (combo.alt)
        mods |= Qt::AltModifier;
    if (combo.shift)
        mods |= Qt::ShiftModifier;
    if (combo.meta)
        mods |= Qt::MetaModifier;
    return KeyInput{mods, combo.key, QStringLiteral("Key") + combo.key.toUpper()};
}

std::function<QString(const QString &)> caseTransform(const QString &name)
{
    if (name == QLatin1String("toUpper"))
        return editor::toUpper;
    if (name == QLatin1String("toLower"))
        return editor::toLower;
    if (name == QLatin1String("capitalizeFirst"))
        return editor::capitalizeFirst;
    if (name == QLatin1String("toggleCase"))
        return editor::toggleCase;
    return {};
}

// One code point as a string, unit for unit - a surrogate code point as its lone unit. Not QString::fromUcs4:
// that one takes a leading U+FEFF for a byte order mark and drops it (the step1 fromUtf16 trap).
QString codePointString(char32_t cp)
{
    if (!QChar::requiresSurrogates(cp))
        return QString(QChar(char16_t(cp)));
    const QChar pair[2] = {QChar(QChar::highSurrogate(cp)), QChar(QChar::lowSurrogate(cp))};
    return QString(pair, 2);
}

bool isMarkerLine(const Block &block)
{
    return editor::isTextBlock(block) && editor::isEndLine(block.text);
}

int markerLineCount(const QVector<Block> &blocks)
{
    int count = 0;
    for (const Block &block : blocks) {
        if (isMarkerLine(block))
            ++count;
    }
    return count;
}

} // namespace

// ---- editorShortcuts — key recognition -------------------------------------------------------------

// it: 'recognizes Alt+Y (insert end marker)'
void EditorShortcutsTest::recognizesAltY()
{
    QVERIFY(editor::isInsertEndMarker(press("-A--", "y")));
    QVERIFY(editor::isInsertEndMarker(press("-A--", "", "KeyY")));
    QVERIFY(!editor::isInsertEndMarker(press("CA--", "y")));
    QVERIFY(!editor::isInsertEndMarker(press("----", "y")));
}

// it: 'recognizes Ctrl+D (delete line)'
void EditorShortcutsTest::recognizesCtrlD()
{
    QVERIFY(editor::isDeleteLine(press("C---", "d")));
    QVERIFY(editor::isDeleteLine(press("C---", "", "KeyD")));
    QVERIFY(!editor::isDeleteLine(press("----", "d")));
}

// it: 'recognizes Alt+O (glyph input), and not Alt+Y / Ctrl+O'
void EditorShortcutsTest::recognizesAltOButNotAltYOrCtrlO()
{
    QVERIFY(editor::isGlyphInput(press("-A--", "o")));
    QVERIFY(editor::isGlyphInput(press("-A--", "O")));
    QVERIFY(editor::isGlyphInput(press("-A--", "", "KeyO")));
    QVERIFY(!editor::isGlyphInput(press("CA--", "o"))); // ctrl 동반은 인식하지 않는다
    QVERIFY(!editor::isGlyphInput(press("----", "o")));
    QVERIFY(!editor::isGlyphInput(press("-A--", "y")));
    QVERIFY(!editor::isGlyphInput(KeyInput{})); // web null
}

// it: 'recognizes Alt+V (원본 붙여넣기), and not Ctrl+V / plain v'
void EditorShortcutsTest::recognizesAltVButNotCtrlVOrPlainV()
{
    QVERIFY(editor::isPasteOriginal(press("-A--", "v")));
    QVERIFY(editor::isPasteOriginal(press("-A--", "V")));
    QVERIFY(editor::isPasteOriginal(press("-A--", "", "KeyV")));
    QVERIFY(!editor::isPasteOriginal(press("C---", "v")));
    QVERIFY(!editor::isPasteOriginal(press("CA--", "v")));
    QVERIFY(!editor::isPasteOriginal(press("----", "v")));
    QVERIFY(!editor::isPasteOriginal(KeyInput{})); // web null
}

// it: 'recognizes Ctrl+Z (되돌리기) — Shift 없이, Ctrl+Shift+Z와 상호 배타'
void EditorShortcutsTest::recognizesCtrlZWithoutShift()
{
    QVERIFY(editor::isUndo(press("C---", "z")));
    QVERIFY(editor::isUndo(press("---M", "z"))); // Cmd+Z
    QVERIFY(editor::isUndo(press("C---", "", "KeyZ")));
    QVERIFY(!editor::isUndo(press("C-S-", "Z"))); // Shift 동반은 redo
    QVERIFY(!editor::isRedo(press("C---", "z")));
    QVERIFY(!editor::isUndo(press("CA--", "z")));
    QVERIFY(!editor::isUndo(press("----", "z")));
    QVERIFY(!editor::isUndo(press("C---", "y")));
    QVERIFY(!editor::isUndo(KeyInput{})); // web null
}

// it: 'recognizes Insert (삽입/수정 토글) — 수식어 없는 Insert만, Shift/Ctrl/Alt/Meta 동반 제외'
void EditorShortcutsTest::recognizesInsertWithoutModifiers()
{
    QVERIFY(editor::isToggleOverwrite(press("----", "Insert")));
    QVERIFY(editor::isToggleOverwrite(press("----", "", "Insert")));
    QVERIFY(!editor::isToggleOverwrite(press("--S-", "Insert")));
    QVERIFY(!editor::isToggleOverwrite(press("C---", "Insert")));
    QVERIFY(!editor::isToggleOverwrite(press("-A--", "Insert")));
    QVERIFY(!editor::isToggleOverwrite(press("---M", "Insert")));
    QVERIFY(!editor::isToggleOverwrite(press("----", "a")));
    QVERIFY(!editor::isToggleOverwrite(press("----", "Delete")));
    QVERIFY(!editor::isToggleOverwrite(KeyInput{})); // web null and undefined - one spelling in C++
}

// it: 'recognizes Ctrl+Shift+Z (다시실행) — Ctrl+Y("(계속)삽입")와 불간섭'
void EditorShortcutsTest::recognizesCtrlShiftZWithoutTouchingCtrlY()
{
    QVERIFY(editor::isRedo(press("C-S-", "z")));
    QVERIFY(editor::isRedo(press("C-S-", "Z")));
    QVERIFY(editor::isRedo(press("--SM", "Z"))); // Cmd+Shift+Z
    QVERIFY(editor::isRedo(press("C-S-", "", "KeyZ")));
    QVERIFY(!editor::isRedo(press("CAS-", "z")));
    QVERIFY(!editor::isRedo(press("--S-", "Z"))); // 그냥 Shift+Z(타이핑)
    QVERIFY(!editor::isRedo(press("C---", "y"))); // Ctrl+Y는 "(계속)삽입" 점유
    QVERIFY(!editor::isUndo(press("C---", "", "KeyY")));
    QVERIFY(!editor::isRedo(KeyInput{})); // web null
}

// ---- editorShortcuts — insert "(끝)" (Alt+Y) ------------------------------------------------------

// it: 'appends "(끝)" as the final block after embeds, and turns spellcheck on'
void EditorShortcutsTest::endMarkerGoesLastAfterEmbedsWithSpellcheckOn()
{
    const QVector<Block> blocks{text(QStringLiteral("본문")), image(QStringLiteral("x"))};
    const editor::EndMarkerInsertion r = editor::insertEndMarker(blocks);
    QVERIFY(r.inserted);
    QVERIFY(r.spellcheck);
    QVERIFY(!r.blocks.isEmpty());
    QCOMPARE(bytes({r.blocks.last()}), bytes({text(editor::END_MARKER)}));
}

// it: 'does not insert a duplicate "(끝)"'
void EditorShortcutsTest::endMarkerIsNotDuplicated()
{
    const QVector<Block> blocks{text(QStringLiteral("본문")), text(editor::END_MARKER)};
    const editor::EndMarkerInsertion r = editor::insertEndMarker(blocks);
    QVERIFY(!r.inserted);
    QCOMPARE(bytes(r.blocks), bytes(blocks));
    QVERIFY(r.spellcheck);
}

// ---- editorShortcuts — delete line (Ctrl+D / Backspace / Delete) -----------------------------------

// it: 'removes the text line and its companion embed (one at a time)'
void EditorShortcutsTest::deleteLineTakesItsCompanionEmbed()
{
    const QVector<Block> blocks{text(QStringLiteral("제목")), text(QStringLiteral("본문")), image(QStringLiteral("x")),
                                text(QStringLiteral("다음"))};
    const editor::LineDeletion r = editor::deleteLineAt(blocks, 1); // "본문" 라인 + 바로 뒤 임베드 동반 삭제
    QVERIFY(r.removedEmbed);
    QCOMPARE(bytes(r.blocks), bytes({text(QStringLiteral("제목")), text(QStringLiteral("다음"))}));
}

// it: 'removes only the line when it has no companion embed'
void EditorShortcutsTest::deleteLineWithoutCompanionEmbed()
{
    const QVector<Block> blocks{text(QStringLiteral("제목")), text(QStringLiteral("본문"))};
    const editor::LineDeletion r = editor::deleteLineAt(blocks, 0);
    QVERIFY(!r.removedEmbed);
    QCOMPARE(bytes(r.blocks), bytes({text(QStringLiteral("본문"))}));
}

// it: 'removes a single embed when the embed line itself is targeted'
void EditorShortcutsTest::deleteLineOnAnEmbedRemovesOnlyThatEmbed()
{
    const QVector<Block> blocks{text(QStringLiteral("제목")), video(QStringLiteral("a")), text(QStringLiteral("끝줄"))};
    const editor::LineDeletion r = editor::deleteLineAt(blocks, 1);
    QVERIFY(!r.removedEmbed);
    QCOMPARE(bytes(r.blocks), bytes({text(QStringLiteral("제목")), text(QStringLiteral("끝줄"))}));
}

// it: 'is a no-op for out-of-range indexes'
void EditorShortcutsTest::deleteLineOutOfRangeIsANoOp()
{
    const QVector<Block> blocks{text(QStringLiteral("x"))};
    const editor::LineDeletion r = editor::deleteLineAt(blocks, 5);
    QCOMPARE(bytes(r.blocks), bytes(blocks));
    QVERIFY(r.blocks == blocks);
    QVERIFY(!r.removed.has_value()); // web null
    QVERIFY(!r.removedEmbed);
}

// ---- editorShortcuts — insert "(계속)" (Ctrl+Y) ----------------------------------------------------

// it: 'recognizes Ctrl+Y, and not Alt+Y'
void EditorShortcutsTest::recognizesCtrlYButNotAltY()
{
    QVERIFY(editor::isInsertContinueMarker(press("C---", "y")));
    QVERIFY(editor::isInsertContinueMarker(press("C---", "", "KeyY")));
    QVERIFY(!editor::isInsertContinueMarker(press("-A--", "y")));
    QVERIFY(!editor::isInsertContinueMarker(press("CA--", "y")));
    QVERIFY(!editor::isInsertContinueMarker(press("----", "y")));
    QCOMPARE(editor::CONTINUE_MARKER, QStringLiteral("(계속)"));
}

// it: 'inserts "(계속)" after the given text line (no blank line), caret on it'
void EditorShortcutsTest::continueMarkerGoesAfterTheLine()
{
    const editor::ContinueMarkerInsertion r =
        editor::insertContinueMarker({text(QStringLiteral("a")), text(QStringLiteral("b"))}, 0);
    QCOMPARE(textLines(r.blocks), (QStringList{QStringLiteral("a"), QStringLiteral("(계속)"), QStringLiteral("b")}));
    QCOMPARE(r.caretTextLine, 1);
}

// it: 'keeps "(끝)" as the final block when textLineIndex is null (fallback)'
void EditorShortcutsTest::continueMarkerFallbackKeepsTheEndMarkerLast()
{
    const editor::ContinueMarkerInsertion r =
        editor::insertContinueMarker({text(QStringLiteral("a")), text(editor::END_MARKER)}, std::nullopt);
    QCOMPARE(textLines(r.blocks), (QStringList{QStringLiteral("a"), QStringLiteral("(계속)"), QStringLiteral("(끝)")}));
    QCOMPARE(r.caretTextLine, 1);
}

// it: 'preserves embed order and does not mutate the input'
void EditorShortcutsTest::continueMarkerKeepsEmbedOrderAndTheInput()
{
    const QVector<Block> input{text(QStringLiteral("a")), image(QStringLiteral("x")), text(QStringLiteral("b"))};
    const QString snapshot = bytes(input);
    const editor::ContinueMarkerInsertion r = editor::insertContinueMarker(input, 0); // 'a', '(계속)', embed, 'b'
    QCOMPARE(bytes(r.blocks), bytes({text(QStringLiteral("a")), text(editor::CONTINUE_MARKER), image(QStringLiteral("x")),
                                     text(QStringLiteral("b"))}));
    QCOMPARE(textLines(r.blocks), (QStringList{QStringLiteral("a"), QStringLiteral("(계속)"), QStringLiteral("b")}));
    QCOMPARE(bytes(input), snapshot); // 입력 불변
}

// it: 'is not idempotent — inserting twice yields two markers'
void EditorShortcutsTest::continueMarkerIsNotIdempotent()
{
    const editor::ContinueMarkerInsertion once = editor::insertContinueMarker({text(QStringLiteral("a"))}, 0);
    const editor::ContinueMarkerInsertion twice = editor::insertContinueMarker(once.blocks, 0);
    QCOMPARE(textLines(twice.blocks),
             (QStringList{QStringLiteral("a"), QStringLiteral("(계속)"), QStringLiteral("(계속)")}));
}

// it: '마커 재생성 시 "(끝)" 줄의 정렬(align)을 승계한다'
void EditorShortcutsTest::continueMarkerKeepsTheEndMarkerAlign()
{
    const editor::ContinueMarkerInsertion r = editor::insertContinueMarker(
        {text(QStringLiteral("a")), text(editor::END_MARKER, QStringLiteral("center"))}, 0);
    QVERIFY(!r.blocks.isEmpty());
    const Block &last = r.blocks.last();
    QCOMPARE(last.text, editor::END_MARKER);
    QCOMPARE(last.align, QStringLiteral("center"));
    QCOMPARE(r.caretTextLine, 1); // 회귀: 삽입된 '(계속)' 줄 인덱스 불변
}

// it: '삽입된 "(계속)" 줄에는 align 키가 없고, 미정렬 마커에도 생기지 않는다'
void EditorShortcutsTest::continueMarkerAddsNoAlignKey()
{
    const editor::ContinueMarkerInsertion r =
        editor::insertContinueMarker({text(QStringLiteral("a")), text(editor::END_MARKER)}, 0);
    QCOMPARE(r.blocks.size(), 3);
    QVERIFY(!bytes({r.blocks.at(1)}).contains(QLatin1String("align"))); // 새로 만든 '(계속)' 줄
    QVERIFY(!bytes({r.blocks.last()}).contains(QLatin1String("align"))); // 미정렬 마커
}

// ---- editorShortcuts — 기업코드변환 (Ctrl+B) -----------------------------------------------------

// it: 'recognizes Ctrl+B (key/code), and not plain b / Alt+B / Ctrl+Alt+B'
void EditorShortcutsTest::recognizesCtrlBButNotPlainOrAltB()
{
    QVERIFY(editor::isCompanyCode(press("C---", "b")));
    QVERIFY(editor::isCompanyCode(press("C---", "B")));
    QVERIFY(editor::isCompanyCode(press("C---", "", "KeyB")));
    QVERIFY(!editor::isCompanyCode(press("----", "b")));
    QVERIFY(!editor::isCompanyCode(press("-A--", "b")));
    QVERIFY(!editor::isCompanyCode(press("CA--", "b")));
}

// it: 'ignores shift/meta (family와 동형 — Ctrl+Shift+B도 인식)'
void EditorShortcutsTest::companyCodeIgnoresShiftAndMeta()
{
    QVERIFY(editor::isCompanyCode(press("C-S-", "b")));
    QVERIFY(editor::isCompanyCode(press("C--M", "b")));
}

// ---- editorShortcuts — case transforms (보기 메뉴) ------------------------------------------------

// it: 'string transforms are pure'
void EditorShortcutsTest::stringTransformsArePure()
{
    QCOMPARE(editor::toUpper(QStringLiteral("aB")), QStringLiteral("AB"));
    QCOMPARE(editor::toLower(QStringLiteral("aB")), QStringLiteral("ab"));
    QCOMPARE(editor::capitalizeFirst(QStringLiteral("aBC")), QStringLiteral("Abc"));
    QCOMPARE(editor::toggleCase(QStringLiteral("aBc")), QStringLiteral("AbC"));
}

// it: 'transformTextLine applies fn to the targeted text line only'
void EditorShortcutsTest::transformTextLineTouchesTheTargetLineOnly()
{
    const QVector<Block> r =
        editor::transformTextLine({text(QStringLiteral("abc")), text(QStringLiteral("def"))}, 1, editor::toUpper);
    QCOMPARE(textLines(r), (QStringList{QStringLiteral("abc"), QStringLiteral("DEF")}));
}

// it: 'leaves embeds and other lines untouched (text-line index, not absolute)'
void EditorShortcutsTest::transformTextLineCountsTextLinesOnly()
{
    const QVector<Block> blocks{text(QStringLiteral("a")), image(QStringLiteral("x")), text(QStringLiteral("b"))};
    const QVector<Block> r = editor::transformTextLine(blocks, 1, editor::toUpper); // 텍스트-줄 1 = 'b'
    QCOMPARE(r.size(), 3);
    QCOMPARE(bytes({r.at(1)}), bytes({image(QStringLiteral("x"))}));
    QCOMPARE(textLines(r), (QStringList{QStringLiteral("a"), QStringLiteral("B")}));
}

// it: 'is a no-op for out-of-range text-line index'
void EditorShortcutsTest::transformTextLineOutOfRangeIsANoOp()
{
    const QVector<Block> blocks{text(QStringLiteral("a"))};
    QCOMPARE(bytes(editor::transformTextLine(blocks, 5, editor::toUpper)), bytes(blocks));
}

// it: 'preserves the align field of the transformed line (승계)'
void EditorShortcutsTest::transformTextLineKeepsAlign()
{
    const QVector<Block> r =
        editor::transformTextLine({text(QStringLiteral("hello"), QStringLiteral("center"))}, 0, editor::toUpper);
    QCOMPARE(r.size(), 1);
    QCOMPARE(bytes({r.at(0)}), bytes({text(QStringLiteral("HELLO"), QStringLiteral("center"))}));
    QCOMPARE(r.at(0).align, QStringLiteral("center"));
}

// it: 'does not add a spurious align key to an unaligned line'
void EditorShortcutsTest::transformTextLineAddsNoAlignKey()
{
    const QVector<Block> r = editor::transformTextLine({text(QStringLiteral("hello"))}, 0, editor::toUpper);
    QCOMPARE(r.size(), 1);
    QCOMPARE(r.at(0).text, QStringLiteral("HELLO"));
    QVERIFY(r.at(0).align.isEmpty());
    QVERIFY(!bytes({r.at(0)}).contains(QLatin1String("align")));
}

// ---- Port locks -----------------------------------------------------------------------------------

// Every predicate against all 16 modifier combinations for each key form - the predicate letter in lower and
// upper case, its physical code under Hangul input (the key then types a jamo), and Insert by key and by code.
// The expected list is the web predicates' own answer, in WriterPage.onKeyDown order. Qt's keypad and
// group-switch flags are no web modifier and must change nothing.
void EditorShortcutsTest::predicatesMatchTheWebTruthTable_data()
{
    QTest::addColumn<QString>("mods");
    QTest::addColumn<QString>("key");
    QTest::addColumn<QString>("code");
    QTest::addColumn<QStringList>("firing");

    QTest::newRow("---- key=y") << QStringLiteral("----") << QStringLiteral("y") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=y") << QStringLiteral("C---") << QStringLiteral("y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-A-- key=y") << QStringLiteral("-A--") << QStringLiteral("y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CA-- key=y") << QStringLiteral("CA--") << QStringLiteral("y") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=y") << QStringLiteral("--S-") << QStringLiteral("y") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=y") << QStringLiteral("C-S-") << QStringLiteral("y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-AS- key=y") << QStringLiteral("-AS-") << QStringLiteral("y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CAS- key=y") << QStringLiteral("CAS-") << QStringLiteral("y") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=y") << QStringLiteral("---M") << QStringLiteral("y") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=y") << QStringLiteral("C--M") << QStringLiteral("y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-A-M key=y") << QStringLiteral("-A-M") << QStringLiteral("y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CA-M key=y") << QStringLiteral("CA-M") << QStringLiteral("y") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=y") << QStringLiteral("--SM") << QStringLiteral("y") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=y") << QStringLiteral("C-SM") << QStringLiteral("y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-ASM key=y") << QStringLiteral("-ASM") << QStringLiteral("y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CASM key=y") << QStringLiteral("CASM") << QStringLiteral("y") << QStringLiteral("") << QStringList();
    QTest::newRow("---- key=Y") << QStringLiteral("----") << QStringLiteral("Y") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=Y") << QStringLiteral("C---") << QStringLiteral("Y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-A-- key=Y") << QStringLiteral("-A--") << QStringLiteral("Y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CA-- key=Y") << QStringLiteral("CA--") << QStringLiteral("Y") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=Y") << QStringLiteral("--S-") << QStringLiteral("Y") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=Y") << QStringLiteral("C-S-") << QStringLiteral("Y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-AS- key=Y") << QStringLiteral("-AS-") << QStringLiteral("Y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CAS- key=Y") << QStringLiteral("CAS-") << QStringLiteral("Y") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=Y") << QStringLiteral("---M") << QStringLiteral("Y") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=Y") << QStringLiteral("C--M") << QStringLiteral("Y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-A-M key=Y") << QStringLiteral("-A-M") << QStringLiteral("Y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CA-M key=Y") << QStringLiteral("CA-M") << QStringLiteral("Y") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=Y") << QStringLiteral("--SM") << QStringLiteral("Y") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=Y") << QStringLiteral("C-SM") << QStringLiteral("Y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-ASM key=Y") << QStringLiteral("-ASM") << QStringLiteral("Y") << QStringLiteral("") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CASM key=Y") << QStringLiteral("CASM") << QStringLiteral("Y") << QStringLiteral("") << QStringList();
    QTest::newRow("---- code=KeyY key=jamo") << QStringLiteral("----") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList();
    QTest::newRow("C--- code=KeyY key=jamo") << QStringLiteral("C---") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-A-- code=KeyY key=jamo") << QStringLiteral("-A--") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CA-- code=KeyY key=jamo") << QStringLiteral("CA--") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList();
    QTest::newRow("--S- code=KeyY key=jamo") << QStringLiteral("--S-") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList();
    QTest::newRow("C-S- code=KeyY key=jamo") << QStringLiteral("C-S-") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-AS- code=KeyY key=jamo") << QStringLiteral("-AS-") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CAS- code=KeyY key=jamo") << QStringLiteral("CAS-") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList();
    QTest::newRow("---M code=KeyY key=jamo") << QStringLiteral("---M") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList();
    QTest::newRow("C--M code=KeyY key=jamo") << QStringLiteral("C--M") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-A-M code=KeyY key=jamo") << QStringLiteral("-A-M") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CA-M code=KeyY key=jamo") << QStringLiteral("CA-M") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList();
    QTest::newRow("--SM code=KeyY key=jamo") << QStringLiteral("--SM") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList();
    QTest::newRow("C-SM code=KeyY key=jamo") << QStringLiteral("C-SM") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("-ASM code=KeyY key=jamo") << QStringLiteral("-ASM") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("CASM code=KeyY key=jamo") << QStringLiteral("CASM") << QStringLiteral("\u315B") << QStringLiteral("KeyY") << QStringList();
    QTest::newRow("---- key=d") << QStringLiteral("----") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=d") << QStringLiteral("C---") << QStringLiteral("d") << QStringLiteral("") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-A-- key=d") << QStringLiteral("-A--") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-- key=d") << QStringLiteral("CA--") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=d") << QStringLiteral("--S-") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=d") << QStringLiteral("C-S-") << QStringLiteral("d") << QStringLiteral("") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-AS- key=d") << QStringLiteral("-AS-") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("CAS- key=d") << QStringLiteral("CAS-") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=d") << QStringLiteral("---M") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=d") << QStringLiteral("C--M") << QStringLiteral("d") << QStringLiteral("") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-A-M key=d") << QStringLiteral("-A-M") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-M key=d") << QStringLiteral("CA-M") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=d") << QStringLiteral("--SM") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=d") << QStringLiteral("C-SM") << QStringLiteral("d") << QStringLiteral("") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-ASM key=d") << QStringLiteral("-ASM") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("CASM key=d") << QStringLiteral("CASM") << QStringLiteral("d") << QStringLiteral("") << QStringList();
    QTest::newRow("---- key=D") << QStringLiteral("----") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=D") << QStringLiteral("C---") << QStringLiteral("D") << QStringLiteral("") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-A-- key=D") << QStringLiteral("-A--") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-- key=D") << QStringLiteral("CA--") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=D") << QStringLiteral("--S-") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=D") << QStringLiteral("C-S-") << QStringLiteral("D") << QStringLiteral("") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-AS- key=D") << QStringLiteral("-AS-") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("CAS- key=D") << QStringLiteral("CAS-") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=D") << QStringLiteral("---M") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=D") << QStringLiteral("C--M") << QStringLiteral("D") << QStringLiteral("") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-A-M key=D") << QStringLiteral("-A-M") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-M key=D") << QStringLiteral("CA-M") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=D") << QStringLiteral("--SM") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=D") << QStringLiteral("C-SM") << QStringLiteral("D") << QStringLiteral("") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-ASM key=D") << QStringLiteral("-ASM") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("CASM key=D") << QStringLiteral("CASM") << QStringLiteral("D") << QStringLiteral("") << QStringList();
    QTest::newRow("---- code=KeyD key=jamo") << QStringLiteral("----") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("C--- code=KeyD key=jamo") << QStringLiteral("C---") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-A-- code=KeyD key=jamo") << QStringLiteral("-A--") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("CA-- code=KeyD key=jamo") << QStringLiteral("CA--") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("--S- code=KeyD key=jamo") << QStringLiteral("--S-") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("C-S- code=KeyD key=jamo") << QStringLiteral("C-S-") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-AS- code=KeyD key=jamo") << QStringLiteral("-AS-") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("CAS- code=KeyD key=jamo") << QStringLiteral("CAS-") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("---M code=KeyD key=jamo") << QStringLiteral("---M") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("C--M code=KeyD key=jamo") << QStringLiteral("C--M") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-A-M code=KeyD key=jamo") << QStringLiteral("-A-M") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("CA-M code=KeyD key=jamo") << QStringLiteral("CA-M") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("--SM code=KeyD key=jamo") << QStringLiteral("--SM") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("C-SM code=KeyD key=jamo") << QStringLiteral("C-SM") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("-ASM code=KeyD key=jamo") << QStringLiteral("-ASM") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("CASM code=KeyD key=jamo") << QStringLiteral("CASM") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList();
    QTest::newRow("---- key=b") << QStringLiteral("----") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=b") << QStringLiteral("C---") << QStringLiteral("b") << QStringLiteral("") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-A-- key=b") << QStringLiteral("-A--") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-- key=b") << QStringLiteral("CA--") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=b") << QStringLiteral("--S-") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=b") << QStringLiteral("C-S-") << QStringLiteral("b") << QStringLiteral("") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-AS- key=b") << QStringLiteral("-AS-") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("CAS- key=b") << QStringLiteral("CAS-") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=b") << QStringLiteral("---M") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=b") << QStringLiteral("C--M") << QStringLiteral("b") << QStringLiteral("") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-A-M key=b") << QStringLiteral("-A-M") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-M key=b") << QStringLiteral("CA-M") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=b") << QStringLiteral("--SM") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=b") << QStringLiteral("C-SM") << QStringLiteral("b") << QStringLiteral("") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-ASM key=b") << QStringLiteral("-ASM") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("CASM key=b") << QStringLiteral("CASM") << QStringLiteral("b") << QStringLiteral("") << QStringList();
    QTest::newRow("---- key=B") << QStringLiteral("----") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=B") << QStringLiteral("C---") << QStringLiteral("B") << QStringLiteral("") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-A-- key=B") << QStringLiteral("-A--") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-- key=B") << QStringLiteral("CA--") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=B") << QStringLiteral("--S-") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=B") << QStringLiteral("C-S-") << QStringLiteral("B") << QStringLiteral("") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-AS- key=B") << QStringLiteral("-AS-") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("CAS- key=B") << QStringLiteral("CAS-") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=B") << QStringLiteral("---M") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=B") << QStringLiteral("C--M") << QStringLiteral("B") << QStringLiteral("") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-A-M key=B") << QStringLiteral("-A-M") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-M key=B") << QStringLiteral("CA-M") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=B") << QStringLiteral("--SM") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=B") << QStringLiteral("C-SM") << QStringLiteral("B") << QStringLiteral("") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-ASM key=B") << QStringLiteral("-ASM") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("CASM key=B") << QStringLiteral("CASM") << QStringLiteral("B") << QStringLiteral("") << QStringList();
    QTest::newRow("---- code=KeyB key=jamo") << QStringLiteral("----") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("C--- code=KeyB key=jamo") << QStringLiteral("C---") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-A-- code=KeyB key=jamo") << QStringLiteral("-A--") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("CA-- code=KeyB key=jamo") << QStringLiteral("CA--") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("--S- code=KeyB key=jamo") << QStringLiteral("--S-") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("C-S- code=KeyB key=jamo") << QStringLiteral("C-S-") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-AS- code=KeyB key=jamo") << QStringLiteral("-AS-") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("CAS- code=KeyB key=jamo") << QStringLiteral("CAS-") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("---M code=KeyB key=jamo") << QStringLiteral("---M") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("C--M code=KeyB key=jamo") << QStringLiteral("C--M") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-A-M code=KeyB key=jamo") << QStringLiteral("-A-M") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("CA-M code=KeyB key=jamo") << QStringLiteral("CA-M") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("--SM code=KeyB key=jamo") << QStringLiteral("--SM") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("C-SM code=KeyB key=jamo") << QStringLiteral("C-SM") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("-ASM code=KeyB key=jamo") << QStringLiteral("-ASM") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("CASM code=KeyB key=jamo") << QStringLiteral("CASM") << QStringLiteral("\u3160") << QStringLiteral("KeyB") << QStringList();
    QTest::newRow("---- key=z") << QStringLiteral("----") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=z") << QStringLiteral("C---") << QStringLiteral("z") << QStringLiteral("") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("-A-- key=z") << QStringLiteral("-A--") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-- key=z") << QStringLiteral("CA--") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=z") << QStringLiteral("--S-") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=z") << QStringLiteral("C-S-") << QStringLiteral("z") << QStringLiteral("") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("-AS- key=z") << QStringLiteral("-AS-") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("CAS- key=z") << QStringLiteral("CAS-") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=z") << QStringLiteral("---M") << QStringLiteral("z") << QStringLiteral("") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("C--M key=z") << QStringLiteral("C--M") << QStringLiteral("z") << QStringLiteral("") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("-A-M key=z") << QStringLiteral("-A-M") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-M key=z") << QStringLiteral("CA-M") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=z") << QStringLiteral("--SM") << QStringLiteral("z") << QStringLiteral("") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("C-SM key=z") << QStringLiteral("C-SM") << QStringLiteral("z") << QStringLiteral("") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("-ASM key=z") << QStringLiteral("-ASM") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("CASM key=z") << QStringLiteral("CASM") << QStringLiteral("z") << QStringLiteral("") << QStringList();
    QTest::newRow("---- key=Z") << QStringLiteral("----") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=Z") << QStringLiteral("C---") << QStringLiteral("Z") << QStringLiteral("") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("-A-- key=Z") << QStringLiteral("-A--") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-- key=Z") << QStringLiteral("CA--") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=Z") << QStringLiteral("--S-") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=Z") << QStringLiteral("C-S-") << QStringLiteral("Z") << QStringLiteral("") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("-AS- key=Z") << QStringLiteral("-AS-") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("CAS- key=Z") << QStringLiteral("CAS-") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=Z") << QStringLiteral("---M") << QStringLiteral("Z") << QStringLiteral("") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("C--M key=Z") << QStringLiteral("C--M") << QStringLiteral("Z") << QStringLiteral("") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("-A-M key=Z") << QStringLiteral("-A-M") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-M key=Z") << QStringLiteral("CA-M") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=Z") << QStringLiteral("--SM") << QStringLiteral("Z") << QStringLiteral("") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("C-SM key=Z") << QStringLiteral("C-SM") << QStringLiteral("Z") << QStringLiteral("") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("-ASM key=Z") << QStringLiteral("-ASM") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("CASM key=Z") << QStringLiteral("CASM") << QStringLiteral("Z") << QStringLiteral("") << QStringList();
    QTest::newRow("---- code=KeyZ key=jamo") << QStringLiteral("----") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("C--- code=KeyZ key=jamo") << QStringLiteral("C---") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("-A-- code=KeyZ key=jamo") << QStringLiteral("-A--") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("CA-- code=KeyZ key=jamo") << QStringLiteral("CA--") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("--S- code=KeyZ key=jamo") << QStringLiteral("--S-") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("C-S- code=KeyZ key=jamo") << QStringLiteral("C-S-") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("-AS- code=KeyZ key=jamo") << QStringLiteral("-AS-") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("CAS- code=KeyZ key=jamo") << QStringLiteral("CAS-") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("---M code=KeyZ key=jamo") << QStringLiteral("---M") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("C--M code=KeyZ key=jamo") << QStringLiteral("C--M") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("-A-M code=KeyZ key=jamo") << QStringLiteral("-A-M") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("CA-M code=KeyZ key=jamo") << QStringLiteral("CA-M") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("--SM code=KeyZ key=jamo") << QStringLiteral("--SM") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("C-SM code=KeyZ key=jamo") << QStringLiteral("C-SM") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("-ASM code=KeyZ key=jamo") << QStringLiteral("-ASM") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("CASM code=KeyZ key=jamo") << QStringLiteral("CASM") << QStringLiteral("\u314B") << QStringLiteral("KeyZ") << QStringList();
    QTest::newRow("---- key=o") << QStringLiteral("----") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=o") << QStringLiteral("C---") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-- key=o") << QStringLiteral("-A--") << QStringLiteral("o") << QStringLiteral("") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CA-- key=o") << QStringLiteral("CA--") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=o") << QStringLiteral("--S-") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=o") << QStringLiteral("C-S-") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("-AS- key=o") << QStringLiteral("-AS-") << QStringLiteral("o") << QStringLiteral("") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CAS- key=o") << QStringLiteral("CAS-") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=o") << QStringLiteral("---M") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=o") << QStringLiteral("C--M") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-M key=o") << QStringLiteral("-A-M") << QStringLiteral("o") << QStringLiteral("") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CA-M key=o") << QStringLiteral("CA-M") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=o") << QStringLiteral("--SM") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=o") << QStringLiteral("C-SM") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("-ASM key=o") << QStringLiteral("-ASM") << QStringLiteral("o") << QStringLiteral("") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CASM key=o") << QStringLiteral("CASM") << QStringLiteral("o") << QStringLiteral("") << QStringList();
    QTest::newRow("---- key=O") << QStringLiteral("----") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=O") << QStringLiteral("C---") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-- key=O") << QStringLiteral("-A--") << QStringLiteral("O") << QStringLiteral("") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CA-- key=O") << QStringLiteral("CA--") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=O") << QStringLiteral("--S-") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=O") << QStringLiteral("C-S-") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("-AS- key=O") << QStringLiteral("-AS-") << QStringLiteral("O") << QStringLiteral("") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CAS- key=O") << QStringLiteral("CAS-") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=O") << QStringLiteral("---M") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=O") << QStringLiteral("C--M") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-M key=O") << QStringLiteral("-A-M") << QStringLiteral("O") << QStringLiteral("") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CA-M key=O") << QStringLiteral("CA-M") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=O") << QStringLiteral("--SM") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=O") << QStringLiteral("C-SM") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("-ASM key=O") << QStringLiteral("-ASM") << QStringLiteral("O") << QStringLiteral("") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CASM key=O") << QStringLiteral("CASM") << QStringLiteral("O") << QStringLiteral("") << QStringList();
    QTest::newRow("---- code=KeyO key=jamo") << QStringLiteral("----") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("C--- code=KeyO key=jamo") << QStringLiteral("C---") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("-A-- code=KeyO key=jamo") << QStringLiteral("-A--") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CA-- code=KeyO key=jamo") << QStringLiteral("CA--") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("--S- code=KeyO key=jamo") << QStringLiteral("--S-") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("C-S- code=KeyO key=jamo") << QStringLiteral("C-S-") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("-AS- code=KeyO key=jamo") << QStringLiteral("-AS-") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CAS- code=KeyO key=jamo") << QStringLiteral("CAS-") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("---M code=KeyO key=jamo") << QStringLiteral("---M") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("C--M code=KeyO key=jamo") << QStringLiteral("C--M") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("-A-M code=KeyO key=jamo") << QStringLiteral("-A-M") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CA-M code=KeyO key=jamo") << QStringLiteral("CA-M") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("--SM code=KeyO key=jamo") << QStringLiteral("--SM") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("C-SM code=KeyO key=jamo") << QStringLiteral("C-SM") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("-ASM code=KeyO key=jamo") << QStringLiteral("-ASM") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("CASM code=KeyO key=jamo") << QStringLiteral("CASM") << QStringLiteral("\u3150") << QStringLiteral("KeyO") << QStringList();
    QTest::newRow("---- key=v") << QStringLiteral("----") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=v") << QStringLiteral("C---") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-- key=v") << QStringLiteral("-A--") << QStringLiteral("v") << QStringLiteral("") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CA-- key=v") << QStringLiteral("CA--") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=v") << QStringLiteral("--S-") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=v") << QStringLiteral("C-S-") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("-AS- key=v") << QStringLiteral("-AS-") << QStringLiteral("v") << QStringLiteral("") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CAS- key=v") << QStringLiteral("CAS-") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=v") << QStringLiteral("---M") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=v") << QStringLiteral("C--M") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-M key=v") << QStringLiteral("-A-M") << QStringLiteral("v") << QStringLiteral("") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CA-M key=v") << QStringLiteral("CA-M") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=v") << QStringLiteral("--SM") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=v") << QStringLiteral("C-SM") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("-ASM key=v") << QStringLiteral("-ASM") << QStringLiteral("v") << QStringLiteral("") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CASM key=v") << QStringLiteral("CASM") << QStringLiteral("v") << QStringLiteral("") << QStringList();
    QTest::newRow("---- key=V") << QStringLiteral("----") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=V") << QStringLiteral("C---") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-- key=V") << QStringLiteral("-A--") << QStringLiteral("V") << QStringLiteral("") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CA-- key=V") << QStringLiteral("CA--") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=V") << QStringLiteral("--S-") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=V") << QStringLiteral("C-S-") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("-AS- key=V") << QStringLiteral("-AS-") << QStringLiteral("V") << QStringLiteral("") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CAS- key=V") << QStringLiteral("CAS-") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=V") << QStringLiteral("---M") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=V") << QStringLiteral("C--M") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-M key=V") << QStringLiteral("-A-M") << QStringLiteral("V") << QStringLiteral("") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CA-M key=V") << QStringLiteral("CA-M") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=V") << QStringLiteral("--SM") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=V") << QStringLiteral("C-SM") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("-ASM key=V") << QStringLiteral("-ASM") << QStringLiteral("V") << QStringLiteral("") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CASM key=V") << QStringLiteral("CASM") << QStringLiteral("V") << QStringLiteral("") << QStringList();
    QTest::newRow("---- code=KeyV key=jamo") << QStringLiteral("----") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("C--- code=KeyV key=jamo") << QStringLiteral("C---") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("-A-- code=KeyV key=jamo") << QStringLiteral("-A--") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CA-- code=KeyV key=jamo") << QStringLiteral("CA--") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("--S- code=KeyV key=jamo") << QStringLiteral("--S-") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("C-S- code=KeyV key=jamo") << QStringLiteral("C-S-") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("-AS- code=KeyV key=jamo") << QStringLiteral("-AS-") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CAS- code=KeyV key=jamo") << QStringLiteral("CAS-") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("---M code=KeyV key=jamo") << QStringLiteral("---M") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("C--M code=KeyV key=jamo") << QStringLiteral("C--M") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("-A-M code=KeyV key=jamo") << QStringLiteral("-A-M") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CA-M code=KeyV key=jamo") << QStringLiteral("CA-M") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("--SM code=KeyV key=jamo") << QStringLiteral("--SM") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("C-SM code=KeyV key=jamo") << QStringLiteral("C-SM") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("-ASM code=KeyV key=jamo") << QStringLiteral("-ASM") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("CASM code=KeyV key=jamo") << QStringLiteral("CASM") << QStringLiteral("\u314D") << QStringLiteral("KeyV") << QStringList();
    QTest::newRow("---- key=f") << QStringLiteral("----") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=f") << QStringLiteral("C---") << QStringLiteral("f") << QStringLiteral("") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-A-- key=f") << QStringLiteral("-A--") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-- key=f") << QStringLiteral("CA--") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=f") << QStringLiteral("--S-") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=f") << QStringLiteral("C-S-") << QStringLiteral("f") << QStringLiteral("") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-AS- key=f") << QStringLiteral("-AS-") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("CAS- key=f") << QStringLiteral("CAS-") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=f") << QStringLiteral("---M") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=f") << QStringLiteral("C--M") << QStringLiteral("f") << QStringLiteral("") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-A-M key=f") << QStringLiteral("-A-M") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-M key=f") << QStringLiteral("CA-M") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=f") << QStringLiteral("--SM") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=f") << QStringLiteral("C-SM") << QStringLiteral("f") << QStringLiteral("") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-ASM key=f") << QStringLiteral("-ASM") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("CASM key=f") << QStringLiteral("CASM") << QStringLiteral("f") << QStringLiteral("") << QStringList();
    QTest::newRow("---- key=F") << QStringLiteral("----") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("C--- key=F") << QStringLiteral("C---") << QStringLiteral("F") << QStringLiteral("") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-A-- key=F") << QStringLiteral("-A--") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-- key=F") << QStringLiteral("CA--") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=F") << QStringLiteral("--S-") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=F") << QStringLiteral("C-S-") << QStringLiteral("F") << QStringLiteral("") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-AS- key=F") << QStringLiteral("-AS-") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("CAS- key=F") << QStringLiteral("CAS-") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=F") << QStringLiteral("---M") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=F") << QStringLiteral("C--M") << QStringLiteral("F") << QStringLiteral("") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-A-M key=F") << QStringLiteral("-A-M") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-M key=F") << QStringLiteral("CA-M") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=F") << QStringLiteral("--SM") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=F") << QStringLiteral("C-SM") << QStringLiteral("F") << QStringLiteral("") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-ASM key=F") << QStringLiteral("-ASM") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("CASM key=F") << QStringLiteral("CASM") << QStringLiteral("F") << QStringLiteral("") << QStringList();
    QTest::newRow("---- code=KeyF key=jamo") << QStringLiteral("----") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("C--- code=KeyF key=jamo") << QStringLiteral("C---") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-A-- code=KeyF key=jamo") << QStringLiteral("-A--") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("CA-- code=KeyF key=jamo") << QStringLiteral("CA--") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("--S- code=KeyF key=jamo") << QStringLiteral("--S-") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("C-S- code=KeyF key=jamo") << QStringLiteral("C-S-") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-AS- code=KeyF key=jamo") << QStringLiteral("-AS-") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("CAS- code=KeyF key=jamo") << QStringLiteral("CAS-") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("---M code=KeyF key=jamo") << QStringLiteral("---M") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("C--M code=KeyF key=jamo") << QStringLiteral("C--M") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-A-M code=KeyF key=jamo") << QStringLiteral("-A-M") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("CA-M code=KeyF key=jamo") << QStringLiteral("CA-M") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("--SM code=KeyF key=jamo") << QStringLiteral("--SM") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("C-SM code=KeyF key=jamo") << QStringLiteral("C-SM") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("-ASM code=KeyF key=jamo") << QStringLiteral("-ASM") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("CASM code=KeyF key=jamo") << QStringLiteral("CASM") << QStringLiteral("\u3139") << QStringLiteral("KeyF") << QStringList();
    QTest::newRow("---- key=Insert") << QStringLiteral("----") << QStringLiteral("Insert") << QStringLiteral("") << QStringList{QStringLiteral("isToggleOverwrite")};
    QTest::newRow("C--- key=Insert") << QStringLiteral("C---") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-- key=Insert") << QStringLiteral("-A--") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-- key=Insert") << QStringLiteral("CA--") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("--S- key=Insert") << QStringLiteral("--S-") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("C-S- key=Insert") << QStringLiteral("C-S-") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("-AS- key=Insert") << QStringLiteral("-AS-") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("CAS- key=Insert") << QStringLiteral("CAS-") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("---M key=Insert") << QStringLiteral("---M") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("C--M key=Insert") << QStringLiteral("C--M") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("-A-M key=Insert") << QStringLiteral("-A-M") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("CA-M key=Insert") << QStringLiteral("CA-M") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("--SM key=Insert") << QStringLiteral("--SM") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("C-SM key=Insert") << QStringLiteral("C-SM") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("-ASM key=Insert") << QStringLiteral("-ASM") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("CASM key=Insert") << QStringLiteral("CASM") << QStringLiteral("Insert") << QStringLiteral("") << QStringList();
    QTest::newRow("---- code=Insert") << QStringLiteral("----") << QStringLiteral("") << QStringLiteral("Insert") << QStringList{QStringLiteral("isToggleOverwrite")};
    QTest::newRow("C--- code=Insert") << QStringLiteral("C---") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("-A-- code=Insert") << QStringLiteral("-A--") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("CA-- code=Insert") << QStringLiteral("CA--") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("--S- code=Insert") << QStringLiteral("--S-") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("C-S- code=Insert") << QStringLiteral("C-S-") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("-AS- code=Insert") << QStringLiteral("-AS-") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("CAS- code=Insert") << QStringLiteral("CAS-") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("---M code=Insert") << QStringLiteral("---M") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("C--M code=Insert") << QStringLiteral("C--M") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("-A-M code=Insert") << QStringLiteral("-A-M") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("CA-M code=Insert") << QStringLiteral("CA-M") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("--SM code=Insert") << QStringLiteral("--SM") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("C-SM code=Insert") << QStringLiteral("C-SM") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("-ASM code=Insert") << QStringLiteral("-ASM") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("CASM code=Insert") << QStringLiteral("CASM") << QStringLiteral("") << QStringLiteral("Insert") << QStringList();
    QTest::newRow("---- key=Delete") << QStringLiteral("----") << QStringLiteral("Delete") << QStringLiteral("") << QStringList();
    QTest::newRow("---- key=Backspace") << QStringLiteral("----") << QStringLiteral("Backspace") << QStringLiteral("") << QStringList();
    QTest::newRow("---- key=a") << QStringLiteral("----") << QStringLiteral("a") << QStringLiteral("") << QStringList();
    QTest::newRow("empty event") << QStringLiteral("----") << QString() << QString() << QStringList();
}

void EditorShortcutsTest::predicatesMatchTheWebTruthTable()
{
    QFETCH(QString, mods);
    QFETCH(QString, key);
    QFETCH(QString, code);
    QFETCH(QStringList, firing);
    QCOMPARE(firingPredicates(KeyInput{modifiers(mods), key, code}), firing);
    const Qt::KeyboardModifiers withQtOnlyFlags = modifiers(mods) | Qt::KeypadModifier | Qt::GroupSwitchModifier;
    QCOMPARE(firingPredicates(KeyInput{withQtOnlyFlags, key, code}), firing);
}

// The web reads the typed character OR the physical key. Where a layout makes them name different letters
// (Dvorak, QWERTZ, AZERTY), two predicates can claim one press - the web runs the first of the list.
void EditorShortcutsTest::keyAndCodeAreBothRead_data()
{
    QTest::addColumn<QString>("mods");
    QTest::addColumn<QString>("key");
    QTest::addColumn<QString>("code");
    QTest::addColumn<QStringList>("firing");

    QTest::newRow("dvorak ctrl phys-Y types f") << QStringLiteral("C---") << QStringLiteral("f") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isFindReplace"), QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("dvorak ctrl phys-F types u") << QStringLiteral("C---") << QStringLiteral("u") << QStringLiteral("KeyF") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("dvorak ctrl phys-B types x") << QStringLiteral("C---") << QStringLiteral("x") << QStringLiteral("KeyB") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("dvorak ctrl phys-D types e") << QStringLiteral("C---") << QStringLiteral("e") << QStringLiteral("KeyD") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("dvorak alt phys-O types r") << QStringLiteral("-A--") << QStringLiteral("r") << QStringLiteral("KeyO") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("dvorak alt phys-V types k") << QStringLiteral("-A--") << QStringLiteral("k") << QStringLiteral("KeyV") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("dvorak ctrl phys-Z types ;") << QStringLiteral("C---") << QStringLiteral(";") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("dvorak alt phys-T types y") << QStringLiteral("-A--") << QStringLiteral("y") << QStringLiteral("KeyT") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("qwertz ctrl phys-Y types z") << QStringLiteral("C---") << QStringLiteral("z") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertContinueMarker"), QStringLiteral("isUndo")};
    QTest::newRow("qwertz ctrl phys-Z types y") << QStringLiteral("C---") << QStringLiteral("y") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isInsertContinueMarker"), QStringLiteral("isUndo")};
    QTest::newRow("qwertz ctrl+shift phys-Y types Z") << QStringLiteral("C-S-") << QStringLiteral("Z") << QStringLiteral("KeyY") << QStringList{QStringLiteral("isInsertContinueMarker"), QStringLiteral("isRedo")};
    QTest::newRow("qwertz alt phys-Z types y") << QStringLiteral("-A--") << QStringLiteral("y") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isInsertEndMarker")};
    QTest::newRow("azerty ctrl phys-Q types a") << QStringLiteral("C---") << QStringLiteral("a") << QStringLiteral("KeyQ") << QStringList();
    QTest::newRow("azerty ctrl phys-W types z") << QStringLiteral("C---") << QStringLiteral("z") << QStringLiteral("KeyW") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("azerty ctrl phys-Z types w") << QStringLiteral("C---") << QStringLiteral("w") << QStringLiteral("KeyZ") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("hangul ctrl phys-D types jamo") << QStringLiteral("C---") << QStringLiteral("\u3147") << QStringLiteral("KeyD") << QStringList{QStringLiteral("isDeleteLine")};
}

void EditorShortcutsTest::keyAndCodeAreBothRead()
{
    QFETCH(QString, mods);
    QFETCH(QString, key);
    QFETCH(QString, code);
    QFETCH(QStringList, firing);
    QCOMPARE(firingPredicates(KeyInput{modifiers(mods), key, code}), firing);
}

// "단축키 13종": exactly 13 reserved combos, none twice, each with a real modifier (the web's parseKeyCombo
// refuses a combo without one) and a one-letter lower-case key. Nine of them belong to one predicate each, the
// four editing keys Ctrl+A / C / X / V to none (the text engine handles them natively), and Insert - the tenth
// predicate - owns no reserved combo.
void EditorShortcutsTest::thereAreExactlyThirteenReservedShortcuts()
{
    QCOMPARE(editor::RESERVED_COMBOS.size(), 13);
    for (qsizetype i = 0; i < editor::RESERVED_COMBOS.size(); ++i) {
        const editor::KeyCombo &c = editor::RESERVED_COMBOS.at(i);
        QVERIFY2(c.ctrl || c.alt || c.meta, qPrintable(QStringLiteral("entry %1 has no real modifier").arg(i)));
        QCOMPARE(c.key.size(), 1);
        QCOMPARE(c.key, c.key.toLower());
        for (qsizetype j = i + 1; j < editor::RESERVED_COMBOS.size(); ++j)
            QVERIFY2(c != editor::RESERVED_COMBOS.at(j), qPrintable(QStringLiteral("entries %1 and %2 are equal").arg(i).arg(j)));
    }
    int owned = 0;
    int native = 0;
    QStringList owners;
    for (const editor::KeyCombo &c : editor::RESERVED_COMBOS) {
        const QStringList firing = firingPredicates(qwertyPress(c));
        QVERIFY(firing.size() <= 1);
        if (firing.isEmpty()) {
            ++native;
        } else {
            ++owned;
            owners.append(firing.first());
        }
    }
    QCOMPARE(owned, 9);
    QCOMPARE(native, 4);
    owners.removeDuplicates();
    QCOMPARE(owners.size(), 9); // nine different predicates
    QVERIFY(!owners.contains(QStringLiteral("isToggleOverwrite")));
}

void EditorShortcutsTest::reservedCombosMatchTheWeb_data()
{
    QTest::addColumn<int>("index");
    QTest::addColumn<bool>("ctrl");
    QTest::addColumn<bool>("alt");
    QTest::addColumn<bool>("shift");
    QTest::addColumn<bool>("meta");
    QTest::addColumn<QString>("key");
    QTest::addColumn<QStringList>("firing"); // the predicates its QWERTY press fires

    QTest::newRow("0 Ctrl+B") << 0 << true << false << false << false << QStringLiteral("b") << QStringList{QStringLiteral("isCompanyCode")};
    QTest::newRow("1 Ctrl+X") << 1 << true << false << false << false << QStringLiteral("x") << QStringList();
    QTest::newRow("2 Ctrl+C") << 2 << true << false << false << false << QStringLiteral("c") << QStringList();
    QTest::newRow("3 Ctrl+V") << 3 << true << false << false << false << QStringLiteral("v") << QStringList();
    QTest::newRow("4 Alt+V") << 4 << false << true << false << false << QStringLiteral("v") << QStringList{QStringLiteral("isPasteOriginal")};
    QTest::newRow("5 Alt+O") << 5 << false << true << false << false << QStringLiteral("o") << QStringList{QStringLiteral("isGlyphInput")};
    QTest::newRow("6 Ctrl+F") << 6 << true << false << false << false << QStringLiteral("f") << QStringList{QStringLiteral("isFindReplace")};
    QTest::newRow("7 Ctrl+A") << 7 << true << false << false << false << QStringLiteral("a") << QStringList();
    QTest::newRow("8 Ctrl+Y") << 8 << true << false << false << false << QStringLiteral("y") << QStringList{QStringLiteral("isInsertContinueMarker")};
    QTest::newRow("9 Ctrl+Z") << 9 << true << false << false << false << QStringLiteral("z") << QStringList{QStringLiteral("isUndo")};
    QTest::newRow("10 Ctrl+Shift+Z") << 10 << true << false << true << false << QStringLiteral("z") << QStringList{QStringLiteral("isRedo")};
    QTest::newRow("11 Ctrl+D") << 11 << true << false << false << false << QStringLiteral("d") << QStringList{QStringLiteral("isDeleteLine")};
    QTest::newRow("12 Alt+Y") << 12 << false << true << false << false << QStringLiteral("y") << QStringList{QStringLiteral("isInsertEndMarker")};
}

void EditorShortcutsTest::reservedCombosMatchTheWeb()
{
    QFETCH(int, index);
    QFETCH(bool, ctrl);
    QFETCH(bool, alt);
    QFETCH(bool, shift);
    QFETCH(bool, meta);
    QFETCH(QString, key);
    QFETCH(QStringList, firing);
    QVERIFY2(index < editor::RESERVED_COMBOS.size(), "RESERVED_COMBOS is shorter than the web's list");
    const editor::KeyCombo &c = editor::RESERVED_COMBOS.at(index);
    QCOMPARE(c.ctrl, ctrl);
    QCOMPARE(c.alt, alt);
    QCOMPARE(c.shift, shift);
    QCOMPARE(c.meta, meta);
    QCOMPARE(c.key, key);
    QCOMPARE(firingPredicates(qwertyPress(c)), firing);
}

void EditorShortcutsTest::textLineToBlockIndexCountsTextBlocksOnly_data()
{
    QTest::addColumn<QString>("input"); // web serialize(blocks)
    QTest::addColumn<int>("line");
    QTest::addColumn<int>("expected");

    QTest::newRow("F1 a,E,b,END line INT_MIN") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << INT_MIN << -1;
    QTest::newRow("F1 a,E,b,END line -1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << -1 << -1;
    QTest::newRow("F1 a,E,b,END line 0") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0 << 0;
    QTest::newRow("F1 a,E,b,END line 1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1 << 2;
    QTest::newRow("F1 a,E,b,END line 2") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 2 << 3;
    QTest::newRow("F1 a,E,b,END line 3") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 3 << -1;
    QTest::newRow("F1 a,E,b,END line 4") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 4 << -1;
    QTest::newRow("F1 a,E,b,END line INT_MAX") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << INT_MAX << -1;
    QTest::newRow("F2 empty line INT_MIN") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << INT_MIN << -1;
    QTest::newRow("F2 empty line -1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << -1 << -1;
    QTest::newRow("F2 empty line 0") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << 0 << -1;
    QTest::newRow("F2 empty line 1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << 1 << -1;
    QTest::newRow("F2 empty line 2") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << 2 << -1;
    QTest::newRow("F2 empty line 3") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << 3 << -1;
    QTest::newRow("F2 empty line 4") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << 4 << -1;
    QTest::newRow("F2 empty line INT_MAX") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << INT_MAX << -1;
    QTest::newRow("F3 E,E line INT_MIN") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"}]}") << INT_MIN << -1;
    QTest::newRow("F3 E,E line -1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"}]}") << -1 << -1;
    QTest::newRow("F3 E,E line 0") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"}]}") << 0 << -1;
    QTest::newRow("F3 E,E line 1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"}]}") << 1 << -1;
    QTest::newRow("F3 E,E line 2") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"}]}") << 2 << -1;
    QTest::newRow("F3 E,E line 3") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"}]}") << 3 << -1;
    QTest::newRow("F3 E,E line 4") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"}]}") << 4 << -1;
    QTest::newRow("F3 E,E line INT_MAX") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"}]}") << INT_MAX << -1;
    QTest::newRow("F4 E,a,E,E,b line INT_MIN") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << INT_MIN << -1;
    QTest::newRow("F4 E,a,E,E,b line -1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << -1 << -1;
    QTest::newRow("F4 E,a,E,E,b line 0") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 0 << 1;
    QTest::newRow("F4 E,a,E,E,b line 1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 1 << 4;
    QTest::newRow("F4 E,a,E,E,b line 2") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 2 << -1;
    QTest::newRow("F4 E,a,E,E,b line 3") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 3 << -1;
    QTest::newRow("F4 E,a,E,E,b line 4") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 4 << -1;
    QTest::newRow("F4 E,a,E,E,b line INT_MAX") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << INT_MAX << -1;
    QTest::newRow("F5 one empty line line INT_MIN") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << INT_MIN << -1;
    QTest::newRow("F5 one empty line line -1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << -1 << -1;
    QTest::newRow("F5 one empty line line 0") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << 0 << 0;
    QTest::newRow("F5 one empty line line 1") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << 1 << -1;
    QTest::newRow("F5 one empty line line 2") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << 2 << -1;
    QTest::newRow("F5 one empty line line 3") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << 3 << -1;
    QTest::newRow("F5 one empty line line 4") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << 4 << -1;
    QTest::newRow("F5 one empty line line INT_MAX") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << INT_MAX << -1;
}

void EditorShortcutsTest::textLineToBlockIndexCountsTextBlocksOnly()
{
    QFETCH(QString, input);
    QFETCH(int, line);
    QFETCH(int, expected);
    QCOMPARE(editor::textLineToBlockIndex(editor::deserialize(input), line), expected);
}

// Alt+Y byte for byte, and the marker contract on every row: inserted exactly where the step3 input gate is
// open at the end of the document (no "(끝)" anywhere), the new marker the canonical final block.
void EditorShortcutsTest::insertEndMarkerMatchesTheWebBytes_data()
{
    QTest::addColumn<QString>("input");    // web serialize(blocks)
    QTest::addColumn<bool>("inserted");
    QTest::addColumn<bool>("spellcheck");
    QTest::addColumn<QString>("expected"); // web serialize(result.blocks)

    QTest::newRow("empty document")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("one line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"}]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("line then embed")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("marker line already")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << false << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("marker glued to text")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문(끝)\"}]}")
        << false << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문(끝)\"}]}");
    QTest::newRow("marker quoted mid-line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"인용 \\\"(끝)\\\" 문장\"},{\"type\":\"text\",\"text\":\"다음\"}]}")
        << false << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"인용 \\\"(끝)\\\" 문장\"},{\"type\":\"text\",\"text\":\"다음\"}]}");
    QTest::newRow("marker line with spaces")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}")
        << false << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\" (끝) \"}]}");
    QTest::newRow("marker line mid-document")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"더\"}]}")
        << false << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"더\"}]}");
    QTest::newRow("aligned marker kept")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}")
        << false << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}");
    QTest::newRow("BOM marker line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}")
        << false << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"}]}");
    QTest::newRow("marker then embed")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}")
        << false << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}");
    QTest::newRow("only the syllable")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"끝\"}]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"끝\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("open paren only")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝\"}]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("close paren only")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"끝)\"}]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"끝)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("full-width parens")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFF08끝\uFF09\"}]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFF08끝\uFF09\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("marker inside an embed payload only")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"(끝)\",\"type\":\"embed\"}]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"(끝)\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("embeds only")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"}]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("aligned text line")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\",\"align\":\"right\"}]}")
        << true << true
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\",\"align\":\"right\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
}

void EditorShortcutsTest::insertEndMarkerMatchesTheWebBytes()
{
    QFETCH(QString, input);
    QFETCH(bool, inserted);
    QFETCH(bool, spellcheck);
    QFETCH(QString, expected);
    const QVector<Block> blocks = editor::deserialize(input);
    const editor::EndMarkerInsertion r = editor::insertEndMarker(blocks);
    QCOMPARE(r.inserted, inserted);
    QCOMPARE(r.spellcheck, spellcheck);
    QCOMPARE(bytes(r.blocks), expected);

    const QString body = editor::blocksToText(blocks);
    QCOMPARE(r.inserted, !editor::isInputBlocked(body, int(body.size())));
    if (r.inserted) {
        QCOMPARE(r.blocks.size(), blocks.size() + 1);
        QCOMPARE(bytes({r.blocks.last()}), bytes({text(editor::END_MARKER)}));
        QCOMPARE(markerLineCount(r.blocks), 1);
    } else {
        QVERIFY(r.blocks == editor::normalizeBlocks(blocks));
    }
}

// Ctrl+D byte for byte; the removed block and the companion embed account for the whole size change.
void EditorShortcutsTest::deleteLineAtMatchesTheWebBytes_data()
{
    QTest::addColumn<QString>("input");    // web serialize(blocks)
    QTest::addColumn<int>("index");
    QTest::addColumn<QString>("expected"); // web serialize(result.blocks)
    QTest::addColumn<QString>("removed");  // web serialize([result.removed]); a null QString = null
    QTest::addColumn<bool>("removedEmbed");

    QTest::newRow("G1 title,body,E,next at INT_MIN")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}") << INT_MIN
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}")
        << QString() << false;
    QTest::newRow("G1 title,body,E,next at -1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}") << -1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}")
        << QString() << false;
    QTest::newRow("G1 title,body,E,next at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}") << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"}]}") << false;
    QTest::newRow("G1 title,body,E,next at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}") << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"다음\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"}]}") << true;
    QTest::newRow("G1 title,body,E,next at 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}") << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"다음\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << false;
    QTest::newRow("G1 title,body,E,next at 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}") << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"다음\"}]}") << false;
    QTest::newRow("G1 title,body,E,next at 4")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}") << 4
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}")
        << QString() << false;
    QTest::newRow("G1 title,body,E,next at INT_MAX")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}") << INT_MAX
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"제목\"},{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"다음\"}]}")
        << QString() << false;
    QTest::newRow("G2 a,E,E,b at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"}]}") << true;
    QTest::newRow("G2 a,E,E,b at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << false;
    QTest::newRow("G2 a,E,E,b at 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"}]}") << false;
    QTest::newRow("G2 a,E,E,b at 3")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 3
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"embedType\":\"image\",\"src\":\"y\",\"type\":\"embed\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"b\"}]}") << false;
    QTest::newRow("G3 E,a at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"}]}") << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << false;
    QTest::newRow("G3 E,a at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"a\"}]}") << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"}]}") << false;
    QTest::newRow("G4 body,END at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"}]}") << false;
    QTest::newRow("G4 body,END at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}") << false;
    QTest::newRow("G5 body,E,END at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"}]}") << true;
    QTest::newRow("G5 body,E,END at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << false;
    QTest::newRow("G5 body,E,END at 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}") << false;
    QTest::newRow("G6 only at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"only\"}]}") << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"only\"}]}") << false;
    QTest::newRow("G6 only at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"only\"}]}") << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"only\"}]}")
        << QString() << false;
    QTest::newRow("G7 empty at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << QString() << false;
    QTest::newRow("G7 empty at -1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << -1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}")
        << QString() << false;
    QTest::newRow("G8 a,END,E at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"}]}") << true;
    QTest::newRow("G8 a,END,E at 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << false;
    QTest::newRow("G9 a,b-center,E at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\",\"align\":\"center\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"b\",\"align\":\"center\"}]}") << true;
    QTest::newRow("G10 empty line,E at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"},{\"embedType\":\"video\",\"videoId\":\"a\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"x\"}]}") << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"x\"}]}")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\"}]}") << true;
}

void EditorShortcutsTest::deleteLineAtMatchesTheWebBytes()
{
    QFETCH(QString, input);
    QFETCH(int, index);
    QFETCH(QString, expected);
    QFETCH(QString, removed);
    QFETCH(bool, removedEmbed);
    const QVector<Block> blocks = editor::deserialize(input);
    const editor::LineDeletion r = editor::deleteLineAt(blocks, index);
    QCOMPARE(bytes(r.blocks), expected);
    QCOMPARE(r.removed.has_value(), !removed.isNull());
    if (r.removed)
        QCOMPARE(bytes({*r.removed}), removed);
    QCOMPARE(r.removedEmbed, removedEmbed);
    QCOMPARE(r.blocks.size(), blocks.size() - (r.removed ? 1 : 0) - (r.removedEmbed ? 1 : 0));
}

// Ctrl+Y byte for byte; on every row the caret line is the new "(계속)", and a marker line in the input comes
// out as exactly one canonical final block.
void EditorShortcutsTest::insertContinueMarkerMatchesTheWebBytes_data()
{
    QTest::addColumn<QString>("input"); // web serialize(blocks)
    QTest::addColumn<bool>("known");    // false = textLineIndex null
    QTest::addColumn<int>("line");
    QTest::addColumn<QString>("expected"); // web serialize(result.blocks)
    QTest::addColumn<int>("caretTextLine");

    QTest::newRow("H1 a,b at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H1 a,b at -1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"}]}") << true << -1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H1 a,b at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 1;
    QTest::newRow("H1 a,b at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"}]}") << true << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H1 a,b at 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"}]}") << true << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H1 a,b at INT_MIN")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"}]}") << true << INT_MIN
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H1 a,b at INT_MAX")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"}]}") << true << INT_MAX
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H2 a,END at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H2 a,END at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H2 a,END at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << true << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H2 a,END at 5")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << true << 5
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H3 a,E,b at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H3 a,E,b at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 1;
    QTest::newRow("H3 a,E,b at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << true << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H4 empty at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 0;
    QTest::newRow("H4 empty at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 0;
    QTest::newRow("H5 E at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 0;
    QTest::newRow("H5 E at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 0;
    QTest::newRow("H6 END,a at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"a\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H6 END,a at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"a\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0;
    QTest::newRow("H6 END,a at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(끝)\"},{\"type\":\"text\",\"text\":\"a\"}]}") << true << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H7 a,END-center,END-right at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"},{\"type\":\"text\",\"text\":\" (끝) \",\"align\":\"right\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}") << 1;
    QTest::newRow("H7 a,END-center,END-right at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"},{\"type\":\"text\",\"text\":\" (끝) \",\"align\":\"right\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}") << 1;
    QTest::newRow("H7 a,END-center,END-right at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"},{\"type\":\"text\",\"text\":\" (끝) \",\"align\":\"right\"}]}") << true << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}") << 1;
    QTest::newRow("H7 a,END-center,END-right at 2")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"},{\"type\":\"text\",\"text\":\" (끝) \",\"align\":\"right\"}]}") << true << 2
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\",\"align\":\"center\"}]}") << 1;
    QTest::newRow("H8 a,glued at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"본문(끝)\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"본문(끝)\"}]}") << 1;
    QTest::newRow("H8 a,glued at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"본문(끝)\"}]}") << true << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"본문(끝)\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H8 a,glued at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"본문(끝)\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"본문(끝)\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H9 continue at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(계속)\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 1;
    QTest::newRow("H10 BOM marker,a at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"},{\"type\":\"text\",\"text\":\"a\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H10 BOM marker,a at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\uFEFF(끝)\"},{\"type\":\"text\",\"text\":\"a\"}]}") << true << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H11 a,NEL marker at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"\u0085(끝)\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"\u0085(끝)\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H11 a,NEL marker at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"\u0085(끝)\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"\u0085(끝)\"}]}") << 1;
    QTest::newRow("H11 a,NEL marker at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"\u0085(끝)\"}]}") << true << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"\u0085(끝)\"},{\"type\":\"text\",\"text\":\"(계속)\"}]}") << 2;
    QTest::newRow("H12 a,END,E at null")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << false << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H12 a,END,E at 0")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << true << 0
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
    QTest::newRow("H12 a,END,E at 1")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"}]}") << true << 1
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1;
}

void EditorShortcutsTest::insertContinueMarkerMatchesTheWebBytes()
{
    QFETCH(QString, input);
    QFETCH(bool, known);
    QFETCH(int, line);
    QFETCH(QString, expected);
    QFETCH(int, caretTextLine);
    const QVector<Block> blocks = editor::deserialize(input);
    const editor::ContinueMarkerInsertion r =
        editor::insertContinueMarker(blocks, known ? std::optional<int>(line) : std::nullopt);
    QCOMPARE(bytes(r.blocks), expected);
    QCOMPARE(r.caretTextLine, caretTextLine);

    const QStringList lines = textLines(r.blocks);
    QVERIFY(caretTextLine >= 0 && caretTextLine < lines.size());
    QCOMPARE(lines.at(caretTextLine), editor::CONTINUE_MARKER);
    if (markerLineCount(blocks) > 0) {
        QCOMPARE(markerLineCount(r.blocks), 1);
        QVERIFY(!r.blocks.isEmpty());
        QVERIFY(isMarkerLine(r.blocks.last()));
        QCOMPARE(r.blocks.last().text, editor::END_MARKER);
    } else {
        QCOMPARE(markerLineCount(r.blocks), 0);
    }
}

void EditorShortcutsTest::transformTextLineMatchesTheWebBytes_data()
{
    QTest::addColumn<QString>("input"); // web serialize(blocks)
    QTest::addColumn<int>("line");
    QTest::addColumn<QString>("fn");
    QTest::addColumn<QString>("expected"); // web serialize(result.blocks)

    QTest::newRow("T1 abc,def line -1 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << -1 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line -1 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << -1 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line -1 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << -1 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line -1 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << -1 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line 0 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 0 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ABC\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line 0 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 0 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line 0 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 0 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line 0 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 0 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"ABC\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line 1 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 1 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"DEF\"}]}");
    QTest::newRow("T1 abc,def line 1 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 1 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line 1 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 1 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"Def\"}]}");
    QTest::newRow("T1 abc,def line 1 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 1 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"DEF\"}]}");
    QTest::newRow("T1 abc,def line 2 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 2 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line 2 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 2 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line 2 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 2 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T1 abc,def line 2 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}") << 2 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"abc\"},{\"type\":\"text\",\"text\":\"def\"}]}");
    QTest::newRow("T2 a,E,b line 0 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 0 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"A\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}");
    QTest::newRow("T2 a,E,b line 0 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 0 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}");
    QTest::newRow("T2 a,E,b line 0 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 0 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"A\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}");
    QTest::newRow("T2 a,E,b line 0 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 0 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"A\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}");
    QTest::newRow("T2 a,E,b line 1 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 1 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"B\"}]}");
    QTest::newRow("T2 a,E,b line 1 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 1 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}");
    QTest::newRow("T2 a,E,b line 1 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 1 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"B\"}]}");
    QTest::newRow("T2 a,E,b line 1 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 1 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"B\"}]}");
    QTest::newRow("T2 a,E,b line 2 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 2 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}");
    QTest::newRow("T2 a,E,b line 2 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 2 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}");
    QTest::newRow("T2 a,E,b line 2 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 2 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}");
    QTest::newRow("T2 a,E,b line 2 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}") << 2 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"embedType\":\"image\",\"src\":\"x\",\"type\":\"embed\"},{\"type\":\"text\",\"text\":\"b\"}]}");
    QTest::newRow("T3 hello-center line 0 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello\",\"align\":\"center\"}]}") << 0 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"HELLO\",\"align\":\"center\"}]}");
    QTest::newRow("T3 hello-center line 0 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello\",\"align\":\"center\"}]}") << 0 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello\",\"align\":\"center\"}]}");
    QTest::newRow("T3 hello-center line 0 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello\",\"align\":\"center\"}]}") << 0 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello\",\"align\":\"center\"}]}");
    QTest::newRow("T3 hello-center line 0 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello\",\"align\":\"center\"}]}") << 0 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"HELLO\",\"align\":\"center\"}]}");
    QTest::newRow("T4 mixed,END line 0 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"HELLO WORLD\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("T4 mixed,END line 0 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hello world\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("T4 mixed,END line 0 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello world\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("T4 mixed,END line 0 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 0 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"hELLO wORLD\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("T4 mixed,END line 1 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("T4 mixed,END line 1 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("T4 mixed,END line 1 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("T4 mixed,END line 1 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 1 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Hello World\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("T5 sharp-s dotted-I line 0 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"mIxEd \u00DF \u0130\"}]}") << 0 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"MIXED SS \u0130\"}]}");
    QTest::newRow("T5 sharp-s dotted-I line 0 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"mIxEd \u00DF \u0130\"}]}") << 0 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"mixed \u00DF i\u0307\"}]}");
    QTest::newRow("T5 sharp-s dotted-I line 0 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"mIxEd \u00DF \u0130\"}]}") << 0 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Mixed \u00DF i\u0307\"}]}");
    QTest::newRow("T5 sharp-s dotted-I line 0 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"mIxEd \u00DF \u0130\"}]}") << 0 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"MiXeD SS i\u0307\"}]}");
    QTest::newRow("T6 quoted marker line 0 toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Stra\u00DFe (끝) end\"}]}") << 0 << QStringLiteral("toUpper")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"STRASSE (끝) END\"}]}");
    QTest::newRow("T6 quoted marker line 0 toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Stra\u00DFe (끝) end\"}]}") << 0 << QStringLiteral("toLower")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"stra\u00DFe (끝) end\"}]}");
    QTest::newRow("T6 quoted marker line 0 capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Stra\u00DFe (끝) end\"}]}") << 0 << QStringLiteral("capitalizeFirst")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Stra\u00DFe (끝) end\"}]}");
    QTest::newRow("T6 quoted marker line 0 toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"Stra\u00DFe (끝) end\"}]}") << 0 << QStringLiteral("toggleCase")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"sTRASSE (끝) END\"}]}");
}

void EditorShortcutsTest::transformTextLineMatchesTheWebBytes()
{
    QFETCH(QString, input);
    QFETCH(int, line);
    QFETCH(QString, fn);
    QFETCH(QString, expected);
    const QVector<Block> r = editor::transformTextLine(editor::deserialize(input), line, caseTransform(fn));
    QCOMPARE(bytes(r), expected);
}

// The four transforms where the port and JS agree (expected = the web's own output). "(끝)" has no case, so
// whether a string holds the marker never changes.
void EditorShortcutsTest::caseTransformsMatchTheWeb_data()
{
    QTest::addColumn<QString>("fn");
    QTest::addColumn<QString>("input");
    QTest::addColumn<QString>("expected");

    QTest::newRow("toUpper web aB") << QStringLiteral("toUpper") << QStringLiteral("aB") << QStringLiteral("AB");
    QTest::newRow("toLower web aB") << QStringLiteral("toLower") << QStringLiteral("aB") << QStringLiteral("ab");
    QTest::newRow("capitalizeFirst web aB") << QStringLiteral("capitalizeFirst") << QStringLiteral("aB") << QStringLiteral("Ab");
    QTest::newRow("toggleCase web aB") << QStringLiteral("toggleCase") << QStringLiteral("aB") << QStringLiteral("Ab");
    QTest::newRow("toUpper web aBC") << QStringLiteral("toUpper") << QStringLiteral("aBC") << QStringLiteral("ABC");
    QTest::newRow("toLower web aBC") << QStringLiteral("toLower") << QStringLiteral("aBC") << QStringLiteral("abc");
    QTest::newRow("capitalizeFirst web aBC") << QStringLiteral("capitalizeFirst") << QStringLiteral("aBC") << QStringLiteral("Abc");
    QTest::newRow("toggleCase web aBC") << QStringLiteral("toggleCase") << QStringLiteral("aBC") << QStringLiteral("Abc");
    QTest::newRow("toUpper web aBc") << QStringLiteral("toUpper") << QStringLiteral("aBc") << QStringLiteral("ABC");
    QTest::newRow("toLower web aBc") << QStringLiteral("toLower") << QStringLiteral("aBc") << QStringLiteral("abc");
    QTest::newRow("capitalizeFirst web aBc") << QStringLiteral("capitalizeFirst") << QStringLiteral("aBc") << QStringLiteral("Abc");
    QTest::newRow("toggleCase web aBc") << QStringLiteral("toggleCase") << QStringLiteral("aBc") << QStringLiteral("AbC");
    QTest::newRow("toUpper empty") << QStringLiteral("toUpper") << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("toLower empty") << QStringLiteral("toLower") << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("capitalizeFirst empty") << QStringLiteral("capitalizeFirst") << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("toggleCase empty") << QStringLiteral("toggleCase") << QStringLiteral("") << QStringLiteral("");
    QTest::newRow("toUpper hello world") << QStringLiteral("toUpper") << QStringLiteral("Hello World") << QStringLiteral("HELLO WORLD");
    QTest::newRow("toLower hello world") << QStringLiteral("toLower") << QStringLiteral("Hello World") << QStringLiteral("hello world");
    QTest::newRow("capitalizeFirst hello world") << QStringLiteral("capitalizeFirst") << QStringLiteral("Hello World") << QStringLiteral("Hello world");
    QTest::newRow("toggleCase hello world") << QStringLiteral("toggleCase") << QStringLiteral("Hello World") << QStringLiteral("hELLO wORLD");
    QTest::newRow("toUpper hangul mixed") << QStringLiteral("toUpper") << QStringLiteral("한글 English 혼합") << QStringLiteral("한글 ENGLISH 혼합");
    QTest::newRow("toLower hangul mixed") << QStringLiteral("toLower") << QStringLiteral("한글 English 혼합") << QStringLiteral("한글 english 혼합");
    QTest::newRow("capitalizeFirst hangul mixed") << QStringLiteral("capitalizeFirst") << QStringLiteral("한글 English 혼합") << QStringLiteral("한글 english 혼합");
    QTest::newRow("toggleCase hangul mixed") << QStringLiteral("toggleCase") << QStringLiteral("한글 English 혼합") << QStringLiteral("한글 eNGLISH 혼합");
    QTest::newRow("toUpper hangul only") << QStringLiteral("toUpper") << QStringLiteral("본문 기사") << QStringLiteral("본문 기사");
    QTest::newRow("toLower hangul only") << QStringLiteral("toLower") << QStringLiteral("본문 기사") << QStringLiteral("본문 기사");
    QTest::newRow("capitalizeFirst hangul only") << QStringLiteral("capitalizeFirst") << QStringLiteral("본문 기사") << QStringLiteral("본문 기사");
    QTest::newRow("toggleCase hangul only") << QStringLiteral("toggleCase") << QStringLiteral("본문 기사") << QStringLiteral("본문 기사");
    QTest::newRow("toUpper digits and punctuation") << QStringLiteral("toUpper") << QStringLiteral("1a2B-3c.") << QStringLiteral("1A2B-3C.");
    QTest::newRow("toLower digits and punctuation") << QStringLiteral("toLower") << QStringLiteral("1a2B-3c.") << QStringLiteral("1a2b-3c.");
    QTest::newRow("capitalizeFirst digits and punctuation") << QStringLiteral("capitalizeFirst") << QStringLiteral("1a2B-3c.") << QStringLiteral("1a2b-3c.");
    QTest::newRow("toggleCase digits and punctuation") << QStringLiteral("toggleCase") << QStringLiteral("1a2B-3c.") << QStringLiteral("1A2b-3C.");
    QTest::newRow("toUpper sharp s") << QStringLiteral("toUpper") << QStringLiteral("\u00DF") << QStringLiteral("SS");
    QTest::newRow("toLower sharp s") << QStringLiteral("toLower") << QStringLiteral("\u00DF") << QStringLiteral("\u00DF");
    QTest::newRow("capitalizeFirst sharp s") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u00DF") << QStringLiteral("SS");
    QTest::newRow("toggleCase sharp s") << QStringLiteral("toggleCase") << QStringLiteral("\u00DF") << QStringLiteral("SS");
    QTest::newRow("toUpper strasse") << QStringLiteral("toUpper") << QStringLiteral("stra\u00DFe") << QStringLiteral("STRASSE");
    QTest::newRow("toLower strasse") << QStringLiteral("toLower") << QStringLiteral("stra\u00DFe") << QStringLiteral("stra\u00DFe");
    QTest::newRow("capitalizeFirst strasse") << QStringLiteral("capitalizeFirst") << QStringLiteral("stra\u00DFe") << QStringLiteral("Stra\u00DFe");
    QTest::newRow("toggleCase strasse") << QStringLiteral("toggleCase") << QStringLiteral("stra\u00DFe") << QStringLiteral("STRASSE");
    QTest::newRow("toUpper capital sharp s") << QStringLiteral("toUpper") << QStringLiteral("\u1E9E") << QStringLiteral("\u1E9E");
    QTest::newRow("toLower capital sharp s") << QStringLiteral("toLower") << QStringLiteral("\u1E9E") << QStringLiteral("\u00DF");
    QTest::newRow("capitalizeFirst capital sharp s") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u1E9E") << QStringLiteral("\u1E9E");
    QTest::newRow("toggleCase capital sharp s") << QStringLiteral("toggleCase") << QStringLiteral("\u1E9E") << QStringLiteral("\u00DF");
    QTest::newRow("toUpper dotted capital I") << QStringLiteral("toUpper") << QStringLiteral("\u0130stanbul") << QStringLiteral("\u0130STANBUL");
    QTest::newRow("toLower dotted capital I") << QStringLiteral("toLower") << QStringLiteral("\u0130stanbul") << QStringLiteral("i\u0307stanbul");
    QTest::newRow("capitalizeFirst dotted capital I") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u0130stanbul") << QStringLiteral("\u0130stanbul");
    QTest::newRow("toggleCase dotted capital I") << QStringLiteral("toggleCase") << QStringLiteral("\u0130stanbul") << QStringLiteral("i\u0307STANBUL");
    QTest::newRow("toUpper dotless i") << QStringLiteral("toUpper") << QStringLiteral("\u0131") << QStringLiteral("I");
    QTest::newRow("toLower dotless i") << QStringLiteral("toLower") << QStringLiteral("\u0131") << QStringLiteral("\u0131");
    QTest::newRow("capitalizeFirst dotless i") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u0131") << QStringLiteral("I");
    QTest::newRow("toggleCase dotless i") << QStringLiteral("toggleCase") << QStringLiteral("\u0131") << QStringLiteral("I");
    QTest::newRow("toUpper ffi ligature") << QStringLiteral("toUpper") << QStringLiteral("\uFB03x") << QStringLiteral("FFIX");
    QTest::newRow("toLower ffi ligature") << QStringLiteral("toLower") << QStringLiteral("\uFB03x") << QStringLiteral("\uFB03x");
    QTest::newRow("capitalizeFirst ffi ligature") << QStringLiteral("capitalizeFirst") << QStringLiteral("\uFB03x") << QStringLiteral("FFIx");
    QTest::newRow("toggleCase ffi ligature") << QStringLiteral("toggleCase") << QStringLiteral("\uFB03x") << QStringLiteral("FFIX");
    QTest::newRow("toUpper n preceded by apostrophe") << QStringLiteral("toUpper") << QStringLiteral("\u0149abc") << QStringLiteral("\u02BCNABC");
    QTest::newRow("toLower n preceded by apostrophe") << QStringLiteral("toLower") << QStringLiteral("\u0149abc") << QStringLiteral("\u0149abc");
    QTest::newRow("capitalizeFirst n preceded by apostrophe") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u0149abc") << QStringLiteral("\u02BCNabc");
    QTest::newRow("toggleCase n preceded by apostrophe") << QStringLiteral("toggleCase") << QStringLiteral("\u0149abc") << QStringLiteral("\u02BCNABC");
    QTest::newRow("toUpper j with caron") << QStringLiteral("toUpper") << QStringLiteral("\u01F0") << QStringLiteral("J\u030C");
    QTest::newRow("toLower j with caron") << QStringLiteral("toLower") << QStringLiteral("\u01F0") << QStringLiteral("\u01F0");
    QTest::newRow("capitalizeFirst j with caron") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u01F0") << QStringLiteral("J\u030C");
    QTest::newRow("toggleCase j with caron") << QStringLiteral("toggleCase") << QStringLiteral("\u01F0") << QStringLiteral("J\u030C");
    QTest::newRow("toUpper iota with dialytika and tonos") << QStringLiteral("toUpper") << QStringLiteral("\u0390") << QStringLiteral("\u0399\u0308\u0301");
    QTest::newRow("toLower iota with dialytika and tonos") << QStringLiteral("toLower") << QStringLiteral("\u0390") << QStringLiteral("\u0390");
    QTest::newRow("capitalizeFirst iota with dialytika and tonos") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u0390") << QStringLiteral("\u0399\u0308\u0301");
    QTest::newRow("toggleCase iota with dialytika and tonos") << QStringLiteral("toggleCase") << QStringLiteral("\u0390") << QStringLiteral("\u0399\u0308\u0301");
    QTest::newRow("toUpper alpha with ypogegrammeni") << QStringLiteral("toUpper") << QStringLiteral("\u1FB3") << QStringLiteral("\u0391\u0399");
    QTest::newRow("toLower alpha with ypogegrammeni") << QStringLiteral("toLower") << QStringLiteral("\u1FB3") << QStringLiteral("\u1FB3");
    QTest::newRow("capitalizeFirst alpha with ypogegrammeni") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u1FB3") << QStringLiteral("\u0391\u0399");
    QTest::newRow("toggleCase alpha with ypogegrammeni") << QStringLiteral("toggleCase") << QStringLiteral("\u1FB3") << QStringLiteral("\u0391\u0399");
    QTest::newRow("toUpper titlecase dz") << QStringLiteral("toUpper") << QStringLiteral("\u01C5ungla") << QStringLiteral("\u01C4UNGLA");
    QTest::newRow("toLower titlecase dz") << QStringLiteral("toLower") << QStringLiteral("\u01C5ungla") << QStringLiteral("\u01C6ungla");
    QTest::newRow("capitalizeFirst titlecase dz") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u01C5ungla") << QStringLiteral("\u01C4ungla");
    QTest::newRow("toggleCase titlecase dz") << QStringLiteral("toggleCase") << QStringLiteral("\u01C5ungla") << QStringLiteral("\u01C5UNGLA");
    QTest::newRow("toUpper dz lower") << QStringLiteral("toUpper") << QStringLiteral("\u01C6") << QStringLiteral("\u01C4");
    QTest::newRow("toLower dz lower") << QStringLiteral("toLower") << QStringLiteral("\u01C6") << QStringLiteral("\u01C6");
    QTest::newRow("capitalizeFirst dz lower") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u01C6") << QStringLiteral("\u01C4");
    QTest::newRow("toggleCase dz lower") << QStringLiteral("toggleCase") << QStringLiteral("\u01C6") << QStringLiteral("\u01C4");
    QTest::newRow("toUpper armenian ligature") << QStringLiteral("toUpper") << QStringLiteral("\uFB13") << QStringLiteral("\u0544\u0546");
    QTest::newRow("toLower armenian ligature") << QStringLiteral("toLower") << QStringLiteral("\uFB13") << QStringLiteral("\uFB13");
    QTest::newRow("capitalizeFirst armenian ligature") << QStringLiteral("capitalizeFirst") << QStringLiteral("\uFB13") << QStringLiteral("\u0544\u0546");
    QTest::newRow("toggleCase armenian ligature") << QStringLiteral("toggleCase") << QStringLiteral("\uFB13") << QStringLiteral("\u0544\u0546");
    QTest::newRow("toUpper deseret pair") << QStringLiteral("toUpper") << QStringLiteral("\U00010400\U00010428") << QStringLiteral("\U00010400\U00010400");
    QTest::newRow("toLower deseret pair") << QStringLiteral("toLower") << QStringLiteral("\U00010400\U00010428") << QStringLiteral("\U00010428\U00010428");
    QTest::newRow("capitalizeFirst deseret pair") << QStringLiteral("capitalizeFirst") << QStringLiteral("\U00010400\U00010428") << QStringLiteral("\U00010400\U00010428");
    QTest::newRow("toggleCase deseret pair") << QStringLiteral("toggleCase") << QStringLiteral("\U00010400\U00010428") << QStringLiteral("\U00010428\U00010400");
    QTest::newRow("toUpper deseret first") << QStringLiteral("toUpper") << QStringLiteral("\U00010400bc") << QStringLiteral("\U00010400BC");
    QTest::newRow("toLower deseret first") << QStringLiteral("toLower") << QStringLiteral("\U00010400bc") << QStringLiteral("\U00010428bc");
    QTest::newRow("capitalizeFirst deseret first") << QStringLiteral("capitalizeFirst") << QStringLiteral("\U00010400bc") << QStringLiteral("\U00010400bc");
    QTest::newRow("toggleCase deseret first") << QStringLiteral("toggleCase") << QStringLiteral("\U00010400bc") << QStringLiteral("\U00010428BC");
    QTest::newRow("toUpper lone high surrogate mid") << QStringLiteral("toUpper") << units({0x0061, 0xD801, 0x0062}) << units({0x0041, 0xD801, 0x0042});
    QTest::newRow("toLower lone high surrogate mid") << QStringLiteral("toLower") << units({0x0061, 0xD801, 0x0062}) << units({0x0061, 0xD801, 0x0062});
    QTest::newRow("capitalizeFirst lone high surrogate mid") << QStringLiteral("capitalizeFirst") << units({0x0061, 0xD801, 0x0062}) << units({0x0041, 0xD801, 0x0062});
    QTest::newRow("toggleCase lone high surrogate mid") << QStringLiteral("toggleCase") << units({0x0061, 0xD801, 0x0062}) << units({0x0041, 0xD801, 0x0042});
    QTest::newRow("toUpper lone low surrogate mid") << QStringLiteral("toUpper") << units({0x0041, 0xDC00, 0x0042}) << units({0x0041, 0xDC00, 0x0042});
    QTest::newRow("toLower lone low surrogate mid") << QStringLiteral("toLower") << units({0x0041, 0xDC00, 0x0042}) << units({0x0061, 0xDC00, 0x0062});
    QTest::newRow("capitalizeFirst lone low surrogate mid") << QStringLiteral("capitalizeFirst") << units({0x0041, 0xDC00, 0x0042}) << units({0x0041, 0xDC00, 0x0062});
    QTest::newRow("toggleCase lone low surrogate mid") << QStringLiteral("toggleCase") << units({0x0041, 0xDC00, 0x0042}) << units({0x0061, 0xDC00, 0x0062});
    QTest::newRow("toUpper lone high surrogate first") << QStringLiteral("toUpper") << units({0xD801, 0x0061, 0x0042}) << units({0xD801, 0x0041, 0x0042});
    QTest::newRow("toLower lone high surrogate first") << QStringLiteral("toLower") << units({0xD801, 0x0061, 0x0042}) << units({0xD801, 0x0061, 0x0062});
    QTest::newRow("capitalizeFirst lone high surrogate first") << QStringLiteral("capitalizeFirst") << units({0xD801, 0x0061, 0x0042}) << units({0xD801, 0x0061, 0x0062});
    QTest::newRow("toggleCase lone high surrogate first") << QStringLiteral("toggleCase") << units({0xD801, 0x0061, 0x0042}) << units({0xD801, 0x0041, 0x0062});
    QTest::newRow("toUpper lone low surrogate last") << QStringLiteral("toUpper") << units({0x0061, 0x0042, 0xDC00}) << units({0x0041, 0x0042, 0xDC00});
    QTest::newRow("toLower lone low surrogate last") << QStringLiteral("toLower") << units({0x0061, 0x0042, 0xDC00}) << units({0x0061, 0x0062, 0xDC00});
    QTest::newRow("capitalizeFirst lone low surrogate last") << QStringLiteral("capitalizeFirst") << units({0x0061, 0x0042, 0xDC00}) << units({0x0041, 0x0062, 0xDC00});
    QTest::newRow("toggleCase lone low surrogate last") << QStringLiteral("toggleCase") << units({0x0061, 0x0042, 0xDC00}) << units({0x0041, 0x0062, 0xDC00});
    QTest::newRow("toUpper lone surrogate after a change") << QStringLiteral("toUpper") << units({0x03B1, 0x00B5, 0xD801, 0x003A}) << units({0x0391, 0x039C, 0xD801, 0x003A});
    QTest::newRow("toLower lone surrogate after a change") << QStringLiteral("toLower") << units({0x03B1, 0x00B5, 0xD801, 0x003A}) << units({0x03B1, 0x00B5, 0xD801, 0x003A});
    QTest::newRow("capitalizeFirst lone surrogate after a change") << QStringLiteral("capitalizeFirst") << units({0x03B1, 0x00B5, 0xD801, 0x003A}) << units({0x0391, 0x00B5, 0xD801, 0x003A});
    QTest::newRow("toggleCase lone surrogate after a change") << QStringLiteral("toggleCase") << units({0x03B1, 0x00B5, 0xD801, 0x003A}) << units({0x0391, 0x039C, 0xD801, 0x003A});
    QTest::newRow("toUpper greek sigma alone") << QStringLiteral("toUpper") << QStringLiteral("\u03A3") << QStringLiteral("\u03A3");
    QTest::newRow("toLower greek sigma alone") << QStringLiteral("toLower") << QStringLiteral("\u03A3") << QStringLiteral("\u03C3");
    QTest::newRow("capitalizeFirst greek sigma alone") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u03A3") << QStringLiteral("\u03A3");
    QTest::newRow("toggleCase greek sigma alone") << QStringLiteral("toggleCase") << QStringLiteral("\u03A3") << QStringLiteral("\u03C3");
    QTest::newRow("toUpper greek sigma first") << QStringLiteral("toUpper") << QStringLiteral("\u03A3\u0391") << QStringLiteral("\u03A3\u0391");
    QTest::newRow("toLower greek sigma first") << QStringLiteral("toLower") << QStringLiteral("\u03A3\u0391") << QStringLiteral("\u03C3\u03B1");
    QTest::newRow("capitalizeFirst greek sigma first") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u03A3\u0391") << QStringLiteral("\u03A3\u03B1");
    QTest::newRow("toggleCase greek sigma first") << QStringLiteral("toggleCase") << QStringLiteral("\u03A3\u0391") << QStringLiteral("\u03C3\u03B1");
    QTest::newRow("toUpper greek final sigma word") << QStringLiteral("toUpper") << QStringLiteral("\u039F\u0394\u03A5\u03A3\u03A3\u0395\u03A5\u03A3") << QStringLiteral("\u039F\u0394\u03A5\u03A3\u03A3\u0395\u03A5\u03A3");
    QTest::newRow("toggleCase greek final sigma word") << QStringLiteral("toggleCase") << QStringLiteral("\u039F\u0394\u03A5\u03A3\u03A3\u0395\u03A5\u03A3") << QStringLiteral("\u03BF\u03B4\u03C5\u03C3\u03C3\u03B5\u03C5\u03C3");
    QTest::newRow("toUpper greek sigma before space") << QStringLiteral("toUpper") << QStringLiteral("\u0391\u03A3 \u0391") << QStringLiteral("\u0391\u03A3 \u0391");
    QTest::newRow("capitalizeFirst greek sigma before space") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u0391\u03A3 \u0391") << QStringLiteral("\u0391\u03C3 \u03B1");
    QTest::newRow("toggleCase greek sigma before space") << QStringLiteral("toggleCase") << QStringLiteral("\u0391\u03A3 \u0391") << QStringLiteral("\u03B1\u03C3 \u03B1");
    QTest::newRow("toUpper greek sigma after apostrophe") << QStringLiteral("toUpper") << QStringLiteral("\u0391'\u03A3") << QStringLiteral("\u0391'\u03A3");
    QTest::newRow("capitalizeFirst greek sigma after apostrophe") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u0391'\u03A3") << QStringLiteral("\u0391'\u03C3");
    QTest::newRow("toggleCase greek sigma after apostrophe") << QStringLiteral("toggleCase") << QStringLiteral("\u0391'\u03A3") << QStringLiteral("\u03B1'\u03C3");
    QTest::newRow("toUpper greek small final sigma") << QStringLiteral("toUpper") << QStringLiteral("\u03C2") << QStringLiteral("\u03A3");
    QTest::newRow("toLower greek small final sigma") << QStringLiteral("toLower") << QStringLiteral("\u03C2") << QStringLiteral("\u03C2");
    QTest::newRow("capitalizeFirst greek small final sigma") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u03C2") << QStringLiteral("\u03A3");
    QTest::newRow("toggleCase greek small final sigma") << QStringLiteral("toggleCase") << QStringLiteral("\u03C2") << QStringLiteral("\u03A3");
    QTest::newRow("toUpper cherokee") << QStringLiteral("toUpper") << QStringLiteral("\u13A0\uAB70") << QStringLiteral("\u13A0\u13A0");
    QTest::newRow("toLower cherokee") << QStringLiteral("toLower") << QStringLiteral("\u13A0\uAB70") << QStringLiteral("\uAB70\uAB70");
    QTest::newRow("capitalizeFirst cherokee") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u13A0\uAB70") << QStringLiteral("\u13A0\uAB70");
    QTest::newRow("toggleCase cherokee") << QStringLiteral("toggleCase") << QStringLiteral("\u13A0\uAB70") << QStringLiteral("\uAB70\u13A0");
    QTest::newRow("toUpper georgian") << QStringLiteral("toUpper") << QStringLiteral("\u10D0\u1C90") << QStringLiteral("\u1C90\u1C90");
    QTest::newRow("toLower georgian") << QStringLiteral("toLower") << QStringLiteral("\u10D0\u1C90") << QStringLiteral("\u10D0\u10D0");
    QTest::newRow("capitalizeFirst georgian") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u10D0\u1C90") << QStringLiteral("\u1C90\u10D0");
    QTest::newRow("toggleCase georgian") << QStringLiteral("toggleCase") << QStringLiteral("\u10D0\u1C90") << QStringLiteral("\u1C90\u10D0");
    QTest::newRow("toUpper full width") << QStringLiteral("toUpper") << QStringLiteral("\uFF41\uFF22") << QStringLiteral("\uFF21\uFF22");
    QTest::newRow("toLower full width") << QStringLiteral("toLower") << QStringLiteral("\uFF41\uFF22") << QStringLiteral("\uFF41\uFF42");
    QTest::newRow("capitalizeFirst full width") << QStringLiteral("capitalizeFirst") << QStringLiteral("\uFF41\uFF22") << QStringLiteral("\uFF21\uFF42");
    QTest::newRow("toggleCase full width") << QStringLiteral("toggleCase") << QStringLiteral("\uFF41\uFF22") << QStringLiteral("\uFF21\uFF42");
    QTest::newRow("toUpper combining acute") << QStringLiteral("toUpper") << QStringLiteral("e\u0301E\u0301") << QStringLiteral("E\u0301E\u0301");
    QTest::newRow("toLower combining acute") << QStringLiteral("toLower") << QStringLiteral("e\u0301E\u0301") << QStringLiteral("e\u0301e\u0301");
    QTest::newRow("capitalizeFirst combining acute") << QStringLiteral("capitalizeFirst") << QStringLiteral("e\u0301E\u0301") << QStringLiteral("E\u0301e\u0301");
    QTest::newRow("toggleCase combining acute") << QStringLiteral("toggleCase") << QStringLiteral("e\u0301E\u0301") << QStringLiteral("E\u0301e\u0301");
    QTest::newRow("toUpper micro sign") << QStringLiteral("toUpper") << QStringLiteral("\u00B5") << QStringLiteral("\u039C");
    QTest::newRow("toLower micro sign") << QStringLiteral("toLower") << QStringLiteral("\u00B5") << QStringLiteral("\u00B5");
    QTest::newRow("capitalizeFirst micro sign") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u00B5") << QStringLiteral("\u039C");
    QTest::newRow("toggleCase micro sign") << QStringLiteral("toggleCase") << QStringLiteral("\u00B5") << QStringLiteral("\u039C");
    QTest::newRow("toUpper controls kept") << QStringLiteral("toUpper") << QStringLiteral("a\tB\rc\u0000D") << QStringLiteral("A\tB\rC\u0000D");
    QTest::newRow("toLower controls kept") << QStringLiteral("toLower") << QStringLiteral("a\tB\rc\u0000D") << QStringLiteral("a\tb\rc\u0000d");
    QTest::newRow("capitalizeFirst controls kept") << QStringLiteral("capitalizeFirst") << QStringLiteral("a\tB\rc\u0000D") << QStringLiteral("A\tb\rc\u0000d");
    QTest::newRow("toggleCase controls kept") << QStringLiteral("toggleCase") << QStringLiteral("a\tB\rc\u0000D") << QStringLiteral("A\tb\rC\u0000d");
    QTest::newRow("capitalizeFirst unicode 17 latin") << QStringLiteral("capitalizeFirst") << QStringLiteral("\uA7CEa\uA7CF") << QStringLiteral("\uA7CEa\uA7CF");
    QTest::newRow("capitalizeFirst unicode 17 beria erfe") << QStringLiteral("capitalizeFirst") << QStringLiteral("\U00016EA0\U00016EBB") << QStringLiteral("\U00016EA0\U00016EBB");
}

void EditorShortcutsTest::caseTransformsMatchTheWeb()
{
    QFETCH(QString, fn);
    QFETCH(QString, input);
    QFETCH(QString, expected);
    const QString out = caseTransform(fn)(input);
    QCOMPARE(out, expected);
    QCOMPARE(out.contains(editor::END_MARKER), input.contains(editor::END_MARKER));
}

// The measured divergences the port keeps (editorshortcuts.h): JS Final_Sigma (a word-final capital sigma
// lower-cases to U+03C2 in JS, to U+03C3 here) and the Unicode 17.0 letters Qt 6.8.3 does not know. port = the
// web's own per-code-point mapping with those letters left as they are.
void EditorShortcutsTest::caseTransformDivergencesAreTheMeasuredOnes_data()
{
    QTest::addColumn<QString>("fn");
    QTest::addColumn<QString>("input");
    QTest::addColumn<QString>("web");
    QTest::addColumn<QString>("port");

    QTest::newRow("toLower greek final sigma word") << QStringLiteral("toLower") << QStringLiteral("\u039F\u0394\u03A5\u03A3\u03A3\u0395\u03A5\u03A3")
        << QStringLiteral("\u03BF\u03B4\u03C5\u03C3\u03C3\u03B5\u03C5\u03C2") << QStringLiteral("\u03BF\u03B4\u03C5\u03C3\u03C3\u03B5\u03C5\u03C3");
    QTest::newRow("capitalizeFirst greek final sigma word") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u039F\u0394\u03A5\u03A3\u03A3\u0395\u03A5\u03A3")
        << QStringLiteral("\u039F\u03B4\u03C5\u03C3\u03C3\u03B5\u03C5\u03C2") << QStringLiteral("\u039F\u03B4\u03C5\u03C3\u03C3\u03B5\u03C5\u03C3");
    QTest::newRow("toLower greek sigma before space") << QStringLiteral("toLower") << QStringLiteral("\u0391\u03A3 \u0391")
        << QStringLiteral("\u03B1\u03C2 \u03B1") << QStringLiteral("\u03B1\u03C3 \u03B1");
    QTest::newRow("toLower greek sigma after apostrophe") << QStringLiteral("toLower") << QStringLiteral("\u0391'\u03A3")
        << QStringLiteral("\u03B1'\u03C2") << QStringLiteral("\u03B1'\u03C3");
    QTest::newRow("toUpper unicode 17 latin") << QStringLiteral("toUpper") << QStringLiteral("\uA7CEa\uA7CF")
        << QStringLiteral("\uA7CEA\uA7CE") << QStringLiteral("\uA7CEA\uA7CF");
    QTest::newRow("toLower unicode 17 latin") << QStringLiteral("toLower") << QStringLiteral("\uA7CEa\uA7CF")
        << QStringLiteral("\uA7CFa\uA7CF") << QStringLiteral("\uA7CEa\uA7CF");
    QTest::newRow("toggleCase unicode 17 latin") << QStringLiteral("toggleCase") << QStringLiteral("\uA7CEa\uA7CF")
        << QStringLiteral("\uA7CFA\uA7CE") << QStringLiteral("\uA7CEA\uA7CF");
    QTest::newRow("toUpper unicode 17 beria erfe") << QStringLiteral("toUpper") << QStringLiteral("\U00016EA0\U00016EBB")
        << QStringLiteral("\U00016EA0\U00016EA0") << QStringLiteral("\U00016EA0\U00016EBB");
    QTest::newRow("toLower unicode 17 beria erfe") << QStringLiteral("toLower") << QStringLiteral("\U00016EA0\U00016EBB")
        << QStringLiteral("\U00016EBB\U00016EBB") << QStringLiteral("\U00016EA0\U00016EBB");
    QTest::newRow("toggleCase unicode 17 beria erfe") << QStringLiteral("toggleCase") << QStringLiteral("\U00016EA0\U00016EBB")
        << QStringLiteral("\U00016EBB\U00016EA0") << QStringLiteral("\U00016EA0\U00016EBB");
}

void EditorShortcutsTest::caseTransformDivergencesAreTheMeasuredOnes()
{
    QFETCH(QString, fn);
    QFETCH(QString, input);
    QFETCH(QString, web);
    QFETCH(QString, port);
    QVERIFY(web != port);
    QCOMPARE(caseTransform(fn)(input), port);
}

// The 56 code points where QString's case mapping and JS's differ: case pairs Unicode 17.0 made. 54 are letters
// 17.0 added (unassigned in Qt 6.8.3's Unicode 16.0 tables); U+A7D3 / U+A7D5 are Unicode 14.0 letters whose
// capitals U+A7D2 / U+A7D4 came in 17.0 - so for each row the code point or its case partner is unknown to Qt,
// and the port leaves it while the web (node 24 / ICU 78.3) maps it. When Qt's tables move on, these rows go red
// - then the divergence is gone and editorshortcuts.h has to say so.
void EditorShortcutsTest::unicode17LettersAreLeftAsTheyAre_data()
{
    QTest::addColumn<uint>("codePoint");
    QTest::addColumn<QString>("webUpper");
    QTest::addColumn<QString>("webLower");

    QTest::newRow("U+A7CE") << 0xA7CEu << QStringLiteral("\uA7CE") << QStringLiteral("\uA7CF");
    QTest::newRow("U+A7CF") << 0xA7CFu << QStringLiteral("\uA7CE") << QStringLiteral("\uA7CF");
    QTest::newRow("U+A7D2") << 0xA7D2u << QStringLiteral("\uA7D2") << QStringLiteral("\uA7D3");
    QTest::newRow("U+A7D3") << 0xA7D3u << QStringLiteral("\uA7D2") << QStringLiteral("\uA7D3");
    QTest::newRow("U+A7D4") << 0xA7D4u << QStringLiteral("\uA7D4") << QStringLiteral("\uA7D5");
    QTest::newRow("U+A7D5") << 0xA7D5u << QStringLiteral("\uA7D4") << QStringLiteral("\uA7D5");
    QTest::newRow("U+16EA0") << 0x16EA0u << QStringLiteral("\U00016EA0") << QStringLiteral("\U00016EBB");
    QTest::newRow("U+16EA1") << 0x16EA1u << QStringLiteral("\U00016EA1") << QStringLiteral("\U00016EBC");
    QTest::newRow("U+16EA2") << 0x16EA2u << QStringLiteral("\U00016EA2") << QStringLiteral("\U00016EBD");
    QTest::newRow("U+16EA3") << 0x16EA3u << QStringLiteral("\U00016EA3") << QStringLiteral("\U00016EBE");
    QTest::newRow("U+16EA4") << 0x16EA4u << QStringLiteral("\U00016EA4") << QStringLiteral("\U00016EBF");
    QTest::newRow("U+16EA5") << 0x16EA5u << QStringLiteral("\U00016EA5") << QStringLiteral("\U00016EC0");
    QTest::newRow("U+16EA6") << 0x16EA6u << QStringLiteral("\U00016EA6") << QStringLiteral("\U00016EC1");
    QTest::newRow("U+16EA7") << 0x16EA7u << QStringLiteral("\U00016EA7") << QStringLiteral("\U00016EC2");
    QTest::newRow("U+16EA8") << 0x16EA8u << QStringLiteral("\U00016EA8") << QStringLiteral("\U00016EC3");
    QTest::newRow("U+16EA9") << 0x16EA9u << QStringLiteral("\U00016EA9") << QStringLiteral("\U00016EC4");
    QTest::newRow("U+16EAA") << 0x16EAAu << QStringLiteral("\U00016EAA") << QStringLiteral("\U00016EC5");
    QTest::newRow("U+16EAB") << 0x16EABu << QStringLiteral("\U00016EAB") << QStringLiteral("\U00016EC6");
    QTest::newRow("U+16EAC") << 0x16EACu << QStringLiteral("\U00016EAC") << QStringLiteral("\U00016EC7");
    QTest::newRow("U+16EAD") << 0x16EADu << QStringLiteral("\U00016EAD") << QStringLiteral("\U00016EC8");
    QTest::newRow("U+16EAE") << 0x16EAEu << QStringLiteral("\U00016EAE") << QStringLiteral("\U00016EC9");
    QTest::newRow("U+16EAF") << 0x16EAFu << QStringLiteral("\U00016EAF") << QStringLiteral("\U00016ECA");
    QTest::newRow("U+16EB0") << 0x16EB0u << QStringLiteral("\U00016EB0") << QStringLiteral("\U00016ECB");
    QTest::newRow("U+16EB1") << 0x16EB1u << QStringLiteral("\U00016EB1") << QStringLiteral("\U00016ECC");
    QTest::newRow("U+16EB2") << 0x16EB2u << QStringLiteral("\U00016EB2") << QStringLiteral("\U00016ECD");
    QTest::newRow("U+16EB3") << 0x16EB3u << QStringLiteral("\U00016EB3") << QStringLiteral("\U00016ECE");
    QTest::newRow("U+16EB4") << 0x16EB4u << QStringLiteral("\U00016EB4") << QStringLiteral("\U00016ECF");
    QTest::newRow("U+16EB5") << 0x16EB5u << QStringLiteral("\U00016EB5") << QStringLiteral("\U00016ED0");
    QTest::newRow("U+16EB6") << 0x16EB6u << QStringLiteral("\U00016EB6") << QStringLiteral("\U00016ED1");
    QTest::newRow("U+16EB7") << 0x16EB7u << QStringLiteral("\U00016EB7") << QStringLiteral("\U00016ED2");
    QTest::newRow("U+16EB8") << 0x16EB8u << QStringLiteral("\U00016EB8") << QStringLiteral("\U00016ED3");
    QTest::newRow("U+16EBB") << 0x16EBBu << QStringLiteral("\U00016EA0") << QStringLiteral("\U00016EBB");
    QTest::newRow("U+16EBC") << 0x16EBCu << QStringLiteral("\U00016EA1") << QStringLiteral("\U00016EBC");
    QTest::newRow("U+16EBD") << 0x16EBDu << QStringLiteral("\U00016EA2") << QStringLiteral("\U00016EBD");
    QTest::newRow("U+16EBE") << 0x16EBEu << QStringLiteral("\U00016EA3") << QStringLiteral("\U00016EBE");
    QTest::newRow("U+16EBF") << 0x16EBFu << QStringLiteral("\U00016EA4") << QStringLiteral("\U00016EBF");
    QTest::newRow("U+16EC0") << 0x16EC0u << QStringLiteral("\U00016EA5") << QStringLiteral("\U00016EC0");
    QTest::newRow("U+16EC1") << 0x16EC1u << QStringLiteral("\U00016EA6") << QStringLiteral("\U00016EC1");
    QTest::newRow("U+16EC2") << 0x16EC2u << QStringLiteral("\U00016EA7") << QStringLiteral("\U00016EC2");
    QTest::newRow("U+16EC3") << 0x16EC3u << QStringLiteral("\U00016EA8") << QStringLiteral("\U00016EC3");
    QTest::newRow("U+16EC4") << 0x16EC4u << QStringLiteral("\U00016EA9") << QStringLiteral("\U00016EC4");
    QTest::newRow("U+16EC5") << 0x16EC5u << QStringLiteral("\U00016EAA") << QStringLiteral("\U00016EC5");
    QTest::newRow("U+16EC6") << 0x16EC6u << QStringLiteral("\U00016EAB") << QStringLiteral("\U00016EC6");
    QTest::newRow("U+16EC7") << 0x16EC7u << QStringLiteral("\U00016EAC") << QStringLiteral("\U00016EC7");
    QTest::newRow("U+16EC8") << 0x16EC8u << QStringLiteral("\U00016EAD") << QStringLiteral("\U00016EC8");
    QTest::newRow("U+16EC9") << 0x16EC9u << QStringLiteral("\U00016EAE") << QStringLiteral("\U00016EC9");
    QTest::newRow("U+16ECA") << 0x16ECAu << QStringLiteral("\U00016EAF") << QStringLiteral("\U00016ECA");
    QTest::newRow("U+16ECB") << 0x16ECBu << QStringLiteral("\U00016EB0") << QStringLiteral("\U00016ECB");
    QTest::newRow("U+16ECC") << 0x16ECCu << QStringLiteral("\U00016EB1") << QStringLiteral("\U00016ECC");
    QTest::newRow("U+16ECD") << 0x16ECDu << QStringLiteral("\U00016EB2") << QStringLiteral("\U00016ECD");
    QTest::newRow("U+16ECE") << 0x16ECEu << QStringLiteral("\U00016EB3") << QStringLiteral("\U00016ECE");
    QTest::newRow("U+16ECF") << 0x16ECFu << QStringLiteral("\U00016EB4") << QStringLiteral("\U00016ECF");
    QTest::newRow("U+16ED0") << 0x16ED0u << QStringLiteral("\U00016EB5") << QStringLiteral("\U00016ED0");
    QTest::newRow("U+16ED1") << 0x16ED1u << QStringLiteral("\U00016EB6") << QStringLiteral("\U00016ED1");
    QTest::newRow("U+16ED2") << 0x16ED2u << QStringLiteral("\U00016EB7") << QStringLiteral("\U00016ED2");
    QTest::newRow("U+16ED3") << 0x16ED3u << QStringLiteral("\U00016EB8") << QStringLiteral("\U00016ED3");
}

void EditorShortcutsTest::unicode17LettersAreLeftAsTheyAre()
{
    QFETCH(uint, codePoint);
    QFETCH(QString, webUpper);
    QFETCH(QString, webLower);
    const char32_t cp = codePoint;
    const QString s = codePointString(cp);
    QVERIFY(webUpper != s || webLower != s);
    const QList<uint> partner = (webUpper != s ? webUpper : webLower).toUcs4();
    QCOMPARE(partner.size(), qsizetype(1));
    QVERIFY(QChar::unicodeVersion(cp) == QChar::Unicode_Unassigned
            || QChar::unicodeVersion(char32_t(partner.first())) == QChar::Unicode_Unassigned);
    QCOMPARE(editor::toUpper(s), s);
    QCOMPARE(editor::toLower(s), s);
}

// Every other code unit sequence 0..0x10FFFF (a surrogate code point as its lone unit) upper- and lower-cases
// exactly as JS does. The web side is a hash node computed (node 24.16, Unicode 17.0): FNV-1a 32-bit, one step
// per UTF-16 code unit, over - for each code point in order, the 56 above skipped - the length of
// String(s).toUpperCase(), its units, the length of toLowerCase(), its units. A failure here means the case
// tables moved: re-measure (dump both sides per code point and diff) before touching anything.
void EditorShortcutsTest::caseMappingMatchesJsForEveryOtherCodePoint()
{
    constexpr quint32 kWebCaseHash = 0x907E398Cu;
    constexpr int kWebCaseHashed = 1114056;
    const std::pair<char32_t, char32_t> kDivergent[] = {{0xA7CE, 0xA7CF}, {0xA7D2, 0xA7D5}, {0x16EA0, 0x16EB8}, {0x16EBB, 0x16ED3}};
    QCOMPARE(QChar::currentUnicodeVersion(), QChar::Unicode_16_0);
    const auto divergent = [&](char32_t cp) {
        for (const auto &range : kDivergent) {
            if (cp >= range.first && cp <= range.second)
                return true;
        }
        return false;
    };
    quint32 hash = 0x811C9DC5u;
    const auto feed = [&hash](quint32 unit) { hash = (hash ^ unit) * 0x01000193u; };
    int hashed = 0;
    for (char32_t cp = 0; cp <= 0x10FFFF; ++cp) {
        if (divergent(cp))
            continue;
        const QString s = codePointString(cp);
        if (s.size() != (QChar::requiresSurrogates(cp) ? 2 : 1))
            QFAIL(qPrintable(QStringLiteral("the input of U+%1 was not built unit for unit").arg(uint(cp), 4, 16, QLatin1Char('0'))));
        for (const QString &out : {editor::toUpper(s), editor::toLower(s)}) {
            feed(quint32(out.size()));
            for (const QChar c : out)
                feed(c.unicode());
        }
        ++hashed;
    }
    QCOMPARE(hashed, kWebCaseHashed);
    QCOMPARE(hash, kWebCaseHash);
}

// A marker line - "(끝)" with whitespace around it, JS trim - is a fixed point of every case transform, alone and
// through transformTextLine, so a case change can never break the marker or move it off its line.
void EditorShortcutsTest::caseTransformsLeaveMarkerLinesIntact_data()
{
    QTest::addColumn<QString>("fn");
    QTest::addColumn<QString>("line");

    QTest::newRow("toUpper plain") << QStringLiteral("toUpper") << QStringLiteral("(끝)");
    QTest::newRow("toLower plain") << QStringLiteral("toLower") << QStringLiteral("(끝)");
    QTest::newRow("capitalizeFirst plain") << QStringLiteral("capitalizeFirst") << QStringLiteral("(끝)");
    QTest::newRow("toggleCase plain") << QStringLiteral("toggleCase") << QStringLiteral("(끝)");
    QTest::newRow("toUpper spaces") << QStringLiteral("toUpper") << QStringLiteral(" (끝) ");
    QTest::newRow("toLower spaces") << QStringLiteral("toLower") << QStringLiteral(" (끝) ");
    QTest::newRow("capitalizeFirst spaces") << QStringLiteral("capitalizeFirst") << QStringLiteral(" (끝) ");
    QTest::newRow("toggleCase spaces") << QStringLiteral("toggleCase") << QStringLiteral(" (끝) ");
    QTest::newRow("toUpper tab") << QStringLiteral("toUpper") << QStringLiteral("\t(끝)");
    QTest::newRow("toLower tab") << QStringLiteral("toLower") << QStringLiteral("\t(끝)");
    QTest::newRow("capitalizeFirst tab") << QStringLiteral("capitalizeFirst") << QStringLiteral("\t(끝)");
    QTest::newRow("toggleCase tab") << QStringLiteral("toggleCase") << QStringLiteral("\t(끝)");
    QTest::newRow("toUpper ideographic spaces") << QStringLiteral("toUpper") << QStringLiteral("\u3000(끝)\u3000");
    QTest::newRow("toLower ideographic spaces") << QStringLiteral("toLower") << QStringLiteral("\u3000(끝)\u3000");
    QTest::newRow("capitalizeFirst ideographic spaces") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u3000(끝)\u3000");
    QTest::newRow("toggleCase ideographic spaces") << QStringLiteral("toggleCase") << QStringLiteral("\u3000(끝)\u3000");
    QTest::newRow("toUpper BOM") << QStringLiteral("toUpper") << QStringLiteral("\uFEFF(끝)");
    QTest::newRow("toLower BOM") << QStringLiteral("toLower") << QStringLiteral("\uFEFF(끝)");
    QTest::newRow("capitalizeFirst BOM") << QStringLiteral("capitalizeFirst") << QStringLiteral("\uFEFF(끝)");
    QTest::newRow("toggleCase BOM") << QStringLiteral("toggleCase") << QStringLiteral("\uFEFF(끝)");
    QTest::newRow("toUpper NBSP") << QStringLiteral("toUpper") << QStringLiteral("\u00A0(끝)\u00A0");
    QTest::newRow("toLower NBSP") << QStringLiteral("toLower") << QStringLiteral("\u00A0(끝)\u00A0");
    QTest::newRow("capitalizeFirst NBSP") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u00A0(끝)\u00A0");
    QTest::newRow("toggleCase NBSP") << QStringLiteral("toggleCase") << QStringLiteral("\u00A0(끝)\u00A0");
    QTest::newRow("toUpper line separator") << QStringLiteral("toUpper") << QStringLiteral("\u2028(끝)");
    QTest::newRow("toLower line separator") << QStringLiteral("toLower") << QStringLiteral("\u2028(끝)");
    QTest::newRow("capitalizeFirst line separator") << QStringLiteral("capitalizeFirst") << QStringLiteral("\u2028(끝)");
    QTest::newRow("toggleCase line separator") << QStringLiteral("toggleCase") << QStringLiteral("\u2028(끝)");
}

void EditorShortcutsTest::caseTransformsLeaveMarkerLinesIntact()
{
    QFETCH(QString, fn);
    QFETCH(QString, line);
    QVERIFY(editor::isEndLine(line));
    QCOMPARE(caseTransform(fn)(line), line);
    const QVector<Block> blocks{text(QStringLiteral("본문")), text(line, QStringLiteral("center"))};
    const QVector<Block> r = editor::transformTextLine(blocks, 1, caseTransform(fn));
    QCOMPARE(bytes(r), bytes(blocks));
    QCOMPARE(markerLineCount(r), 1);
}

// The web normalizes its input first (normalizeBlocks): an align outside ALIGN_VALUES is dropped. Such a block
// only exists here when built field by field, so the expected blocks are compared field by field too (serialize
// would normalize the actual result as well and hide a missing normalization).
void EditorShortcutsTest::transformsNormalizeTheirInputLikeTheWeb()
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

    const QString wantEnd = QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    const QString wantDelete = QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    const QString wantContinue = QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"a\"},{\"type\":\"text\",\"text\":\"(계속)\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    const QString wantTransform = QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"A\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");

    QVERIFY(editor::insertEndMarker(raw).blocks == editor::deserialize(wantEnd));
    QVERIFY(editor::deleteLineAt(raw, 5).blocks == editor::deserialize(wantDelete));
    QVERIFY(editor::insertContinueMarker(raw, 0).blocks == editor::deserialize(wantContinue));
    QVERIFY(editor::transformTextLine(raw, 0, editor::toUpper) == editor::deserialize(wantTransform));
}

// The web's "input immutability" for the shortcut transforms: every call leaves its input as it was.
void EditorShortcutsTest::transformsNeverMutateTheirInput()
{
    const auto make = [] {
        return QVector<Block>{text(QStringLiteral("나")), image(QStringLiteral("x")), text(QStringLiteral("가")),
                              text(editor::END_MARKER, QStringLiteral("center"))};
    };
    const QVector<Block> input = make();
    const QString before = bytes(input);
    editor::insertEndMarker(input);
    editor::deleteLineAt(input, 0);
    editor::deleteLineAt(input, 1);
    editor::insertContinueMarker(input, 0);
    editor::insertContinueMarker(input, std::nullopt);
    for (const char *fn : {"toUpper", "toLower", "capitalizeFirst", "toggleCase"})
        editor::transformTextLine(input, 0, caseTransform(QLatin1String(fn)));
    QVERIFY(input == make());
    QCOMPARE(bytes(input), before);
}
