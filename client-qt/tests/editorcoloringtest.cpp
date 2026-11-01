#include "editorcoloringtest.h"

#include "editor/editorroles.h"

#include <QColor>
#include <QString>
#include <QStringList>
#include <QStringView>
#include <QVector>
#include <QtTest>

namespace {

// One letter per role, so a row reads like the web output ("TSSSSBB").
QString spell(const QVector<editor::Role> &roles)
{
    QString out;
    for (const editor::Role role : roles) {
        switch (role) {
        case editor::Role::Title:
            out += QLatin1Char('T');
            break;
        case editor::Role::Subtitle:
            out += QLatin1Char('S');
            break;
        case editor::Role::Body:
            out += QLatin1Char('B');
            break;
        case editor::Role::End:
            out += QLatin1Char('E');
            break;
        }
    }
    return out;
}

QVector<editor::Role> rolesOf(const QVector<editor::ColoredLine> &lines)
{
    QVector<editor::Role> roles;
    roles.reserve(lines.size());
    for (const editor::ColoredLine &line : lines)
        roles.append(line.role);
    return roles;
}

// A copy of the literal as written - QString::fromUtf16 would swallow a leading U+FEFF as a BOM
// (step1 lesson), QStringView does not.
QString verbatim(QStringView view)
{
    return view.toString();
}

const QString kBlue = QStringLiteral("#0a4da6");
const QString kRed = QStringLiteral("#c8102e");
const QString kInk = QStringLiteral("#1a1a1a");
const QString kGold = QStringLiteral("#d4af37");

} // namespace

// it 1: 'first line is title, lines 2-5 subtitle, 6+ body'
void EditorColoringTest::firstLineTitleLines2to5SubtitleThenBody()
{
    const QStringList lines{QStringLiteral("제목"),  QStringLiteral("부제1"), QStringLiteral("부제2"), QStringLiteral("부제3"),
                            QStringLiteral("부제4"), QStringLiteral("본문1"), QStringLiteral("본문2")};
    QCOMPARE(spell(editor::classifyLines(lines)), QStringLiteral("TSSSSBB"));
}

// it 2: 'a blank line in the subtitle region (2+ newlines) makes body start at line 2'
void EditorColoringTest::blankLineInSubtitleRegionMakesBodyStartAtLine2()
{
    QCOMPARE(spell(editor::classifyLines({QStringLiteral("제목"), QString(), QStringLiteral("본문")})),
             QStringLiteral("TBB"));
    QCOMPARE(spell(editor::classifyLines(
                 {QStringLiteral("제목"), QStringLiteral("부제"), QString(), QStringLiteral("본문")})),
             QStringLiteral("TBBB"));
}

// it 3: '"(끝)" line is always the end role regardless of position'
void EditorColoringTest::endMarkerLineIsEndRegardlessOfPosition()
{
    QCOMPARE(spell(editor::classifyLines({QStringLiteral("제목"), QStringLiteral("(끝)")})), QStringLiteral("TE"));
    const QVector<editor::Role> roles = editor::classifyLines(
        {QStringLiteral("제목"), QStringLiteral("부제"), QStringLiteral("본문"), QStringLiteral("(끝)")});
    QCOMPARE(roles.size(), 4);
    QCOMPARE(roles.at(3), editor::Role::End);
}

// it 4: 'colors map title=blue, subtitle=red, body=ink, end=gold' (+ unknown role -> body)
void EditorColoringTest::colorsMapTitleBlueSubtitleRedBodyInkEndGold()
{
    QCOMPARE(editor::colorForRole(editor::Role::Title), editor::COLORS.title);
    QCOMPARE(editor::COLORS.title.name(), kBlue);
    QCOMPARE(editor::COLORS.subtitle.name(), kRed);
    QCOMPARE(editor::COLORS.end.name(), kGold);
    // colorForRole('unknown') is body on the web; the C++ twin is a value outside the enumerators
    // (well-defined for a scoped enum - the underlying type is int).
    QCOMPARE(editor::colorForRole(static_cast<editor::Role>(99)), editor::COLORS.body);
    QCOMPARE(editor::colorForRole(static_cast<editor::Role>(99)).name(), kInk);
}

// it 5: 'colorLines returns text/role/color per line'
void EditorColoringTest::colorLinesReturnsTextRoleColorPerLine()
{
    const QVector<editor::ColoredLine> out = editor::colorLines(QStringLiteral("제목\n부제"));
    QCOMPARE(out.size(), 2);
    QCOMPARE(out.at(0).text, QStringLiteral("제목"));
    QCOMPARE(out.at(0).role, editor::Role::Title);
    QCOMPARE(out.at(0).color, editor::COLORS.title);
    QCOMPARE(out.at(1).text, QStringLiteral("부제"));
    QCOMPARE(out.at(1).role, editor::Role::Subtitle);
    QCOMPARE(out.at(1).color, editor::COLORS.subtitle);
}

// it 6: 'does not recolor during IME composition; recolors on compositionend/blur/load'
void EditorColoringTest::doesNotRecolorDuringCompositionRecolorsOnEndBlurLoad()
{
    QCOMPARE(editor::shouldRecolor(QStringLiteral("compositionend"), true), false);
    QCOMPARE(editor::shouldRecolor(QStringLiteral("compositionend"), false), true);
    QCOMPARE(editor::shouldRecolor(QStringLiteral("blur")), true);
    QCOMPARE(editor::shouldRecolor(QStringLiteral("load")), true);
    QCOMPARE(editor::shouldRecolor(QStringLiteral("input")), false);
    QCOMPARE(editor::RECOLOR_TRIGGERS,
             (QStringList{QStringLiteral("compositionend"), QStringLiteral("blur"), QStringLiteral("load")}));
}

// it 7: 'defaults are unchanged when setEditorColors is not called' - and the defaults half of
// it 8-10 (title/body are the defaults, "(끝)" is gold, COLORS is the single source colorForRole
// reads). The setter itself is P6.
void EditorColoringTest::defaultsAreTheWebColorsWithoutAnyOverride()
{
    QCOMPARE(editor::colorForRole(editor::Role::Subtitle).name(), kRed);
    QCOMPARE(editor::colorForRole(editor::Role::Title).name(), kBlue);
    QCOMPARE(editor::colorForRole(editor::Role::Body).name(), kInk);
    QCOMPARE(editor::colorForRole(editor::Role::End).name(), kGold);

    QCOMPARE(editor::COLORS.title.name(), kBlue);
    QCOMPARE(editor::COLORS.subtitle.name(), kRed);
    QCOMPARE(editor::COLORS.body.name(), kInk);
    QCOMPARE(editor::COLORS.end.name(), kGold);
    QCOMPARE(editor::colorForRole(editor::Role::Title), editor::COLORS.title);
    QCOMPARE(editor::colorForRole(editor::Role::Subtitle), editor::COLORS.subtitle);
    QCOMPARE(editor::colorForRole(editor::Role::Body), editor::COLORS.body);
    QCOMPARE(editor::colorForRole(editor::Role::End), editor::COLORS.end);
    static_assert(std::is_const<decltype(editor::COLORS)>::value, "COLORS is a constant");
}

void EditorColoringTest::subtitleRegionBoundaries_data()
{
    QTest::addColumn<QStringList>("lines");
    QTest::addColumn<QString>("roles");

    const QString t = QStringLiteral("t");
    const QString a = QStringLiteral("a");
    const QString b = QStringLiteral("b");
    const QString c = QStringLiteral("c");
    const QString d = QStringLiteral("d");
    const QString e = QStringLiteral("e");
    const QString f = QStringLiteral("f");
    const QString end = QStringLiteral("(끝)");
    const QString blank;

    // Index 4 is the last subtitle slot; index 5 is already body.
    QTest::newRow("blank at 4 is inside the region") << QStringList{t, a, b, c, blank, e} << QStringLiteral("TBBBBB");
    QTest::newRow("blank at 5 is outside the region")
        << QStringList{t, a, b, c, d, blank, f} << QStringLiteral("TSSSSBB");
    QTest::newRow("title + 4 subtitles exactly") << QStringList{t, a, b, c, d} << QStringLiteral("TSSSS");
    QTest::newRow("title + 5 lines: index 5 is body") << QStringList{t, a, b, c, d, e} << QStringLiteral("TSSSSB");
    QTest::newRow("only a title") << QStringList{t} << QStringLiteral("T");

    // The region is slice(1, 5): a blank title does not count.
    QTest::newRow("blank at 0 only") << QStringList{blank, a, b} << QStringLiteral("TSS");
    QTest::newRow("blank at 0 and 5") << QStringList{blank, a, b, c, d, blank, f} << QStringLiteral("TSSSSBB");
    QTest::newRow("single empty line is a title") << QStringList{blank} << QStringLiteral("T");

    // "blank" is exactly the empty string (web l === ''): whitespace-only lines are subtitles.
    QTest::newRow("space-only at 1 is not blank") << QStringList{t, QStringLiteral(" "), b} << QStringLiteral("TSS");
    QTest::newRow("tab-only at 2 is not blank") << QStringList{t, a, QStringLiteral("\t"), c} << QStringLiteral("TSSS");

    // The fallback applies to every non-end line from index 1; end lines stay end.
    QTest::newRow("blank at 1 then end") << QStringList{t, blank, end} << QStringLiteral("TBE");
    QTest::newRow("blank at 1, end at 3 stays end, 4 is body")
        << QStringList{t, blank, b, end, c} << QStringLiteral("TBBEB");
    QTest::newRow("blank at 4 with end at 2") << QStringList{t, a, end, c, blank, e} << QStringLiteral("TBEBBB");
    QTest::newRow("two blanks") << QStringList{t, blank, blank, b} << QStringLiteral("TBBB");
    QTest::newRow("all blank") << QStringList{blank, blank, blank, blank, blank, blank} << QStringLiteral("TBBBBB");

    // An end line in the region is not a blank: subtitles continue around it.
    QTest::newRow("end at 1 is not blank") << QStringList{t, end, b, c} << QStringLiteral("TESS");
    QTest::newRow("end at 2, subtitles continue to 4") << QStringList{t, a, end, c, d, e, f} << QStringLiteral("TSESSBB");

    QTest::newRow("marker at 0") << QStringList{end} << QStringLiteral("E");
    QTest::newRow("marker twice") << QStringList{end, end} << QStringLiteral("EE");
    QTest::newRow("empty list") << QStringList() << QString();
}

void EditorColoringTest::subtitleRegionBoundaries()
{
    QFETCH(QStringList, lines);
    QFETCH(QString, roles);
    QCOMPARE(spell(editor::classifyLines(lines)), roles);
}

// The web judges the "(끝)" line with String.prototype.trim(): ECMAScript WhiteSpace + LineTerminator
// (U+0009-U+000D, U+0020, U+00A0, U+FEFF, U+2028, U+2029 and Unicode Zs). QString::trimmed() uses
// QChar::isSpace(), which also strips U+0085 and does not strip U+FEFF - so the two disagree on
// exactly those two code points. Each row was run under node.
void EditorColoringTest::endLineIsJudgedWithJsTrim_data()
{
    QTest::addColumn<QString>("line");
    QTest::addColumn<bool>("isEnd");

    const QString marker = QStringLiteral("(끝)");
    struct CodePoint {
        const char *name;
        char16_t unit;
        bool stripped;
    };
    const CodePoint units[] = {
        {"U+0009 tab", u'\u0009', true},         {"U+000A lf", u'\u000A', true},
        {"U+000B vt", u'\u000B', true},          {"U+000C ff", u'\u000C', true},
        {"U+000D cr", u'\u000D', true},          {"U+0020 space", u' ', true},
        {"U+0085 nel (Qt strips, JS not)", u'\u0085', false},
        {"U+00A0 nbsp", u' ', true},        {"U+1680 ogham", u' ', true},
        {"U+180E mongolian vs", u'᠎', false}, {"U+2000 en quad", u' ', true},
        {"U+2005 four-per-em", u' ', true}, {"U+200A hair", u' ', true},
        {"U+200B zwsp", u'​', false},       {"U+200E lrm", u'‎', false},
        {"U+2028 ls", u' ', true},          {"U+2029 ps", u' ', true},
        {"U+202F nnbsp", u' ', true},       {"U+205F mmsp", u' ', true},
        {"U+3000 ideographic", u'　', true}, {"U+3164 hangul filler", u'ㅤ', false},
        {"U+FEFF bom (JS strips, Qt not)", u'﻿', true},
    };
    for (const CodePoint &cp : units) {
        const QString ch(QChar(cp.unit));
        QTest::newRow(QByteArray(cp.name) + " both") << (ch + marker + ch) << cp.stripped;
        QTest::newRow(QByteArray(cp.name) + " lead") << (ch + marker) << cp.stripped;
        QTest::newRow(QByteArray(cp.name) + " trail") << (marker + ch) << cp.stripped;
    }

    QTest::newRow("exact") << marker << true;
    QTest::newRow("mixed ws both sides") << verbatim(u" \t ﻿(끝)　\r") << true;
    QTest::newRow("bom then nel") << verbatim(u"﻿(끝)\u0085") << false;
    QTest::newRow("inner space after paren") << QStringLiteral("( 끝)") << false;
    QTest::newRow("inner space before paren") << QStringLiteral("(끝 )") << false;
    QTest::newRow("nbsp inside") << verbatim(u"( 끝)") << false;
    QTest::newRow("suffix x") << QStringLiteral("(끝)x") << false;
    QTest::newRow("prefix x") << QStringLiteral("x(끝)") << false;
    QTest::newRow("twice on a line") << QStringLiteral("(끝)(끝)") << false;
    QTest::newRow("fullwidth parens") << QStringLiteral("（끝）") << false;
    QTest::newRow("hangul only") << QStringLiteral("끝") << false;
    QTest::newRow("empty") << QString() << false;
}

void EditorColoringTest::endLineIsJudgedWithJsTrim()
{
    QFETCH(QString, line);
    QFETCH(bool, isEnd);
    QCOMPARE(editor::isEndLine(line), isEnd);
    // Through classifyLines too: at index 1 a non-end line is a subtitle (or body when empty).
    const QString roles = spell(editor::classifyLines({QStringLiteral("t"), line}));
    QCOMPARE(roles.at(1) == QLatin1Char('E'), isEnd);
}

// colorLines splits on "\n" only (web String.prototype.split('\n')): "" is one line, "\r" stays
// in the text, a trailing "\n" yields a trailing empty line.
void EditorColoringTest::colorLinesSplitsOnLineFeedOnly_data()
{
    QTest::addColumn<QString>("text");
    QTest::addColumn<QStringList>("texts");
    QTest::addColumn<QString>("roles");

    QTest::newRow("empty text is one title line") << QString() << QStringList{QString()} << QStringLiteral("T");
    QTest::newRow("single lf is two lines") << QStringLiteral("\n") << QStringList{QString(), QString()}
                                            << QStringLiteral("TB");
    QTest::newRow("crlf keeps the cr in the text")
        << QStringLiteral("제목\r\n부제") << QStringList{QStringLiteral("제목\r"), QStringLiteral("부제")}
        << QStringLiteral("TS");
    QTest::newRow("trailing lf yields a trailing empty body line")
        << QStringLiteral("제목\n") << QStringList{QStringLiteral("제목"), QString()} << QStringLiteral("TB");
    QTest::newRow("two lfs") << QStringLiteral("\n\n") << QStringList{QString(), QString(), QString()}
                             << QStringLiteral("TBB");
    QTest::newRow("blank fallback then end")
        << QStringLiteral("t\n\nb\n(끝)")
        << QStringList{QStringLiteral("t"), QString(), QStringLiteral("b"), QStringLiteral("(끝)")}
        << QStringLiteral("TBBE");
    QTest::newRow("full document, text after the marker is body")
        << QStringLiteral("t\na\nb\nc\nd\ne\n(끝)\nafter")
        << QStringList{QStringLiteral("t"), QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c"),
                       QStringLiteral("d"), QStringLiteral("e"), QStringLiteral("(끝)"), QStringLiteral("after")}
        << QStringLiteral("TSSSSBEB");
    QTest::newRow("marker alone") << QStringLiteral("(끝)") << QStringList{QStringLiteral("(끝)")} << QStringLiteral("E");
}

void EditorColoringTest::colorLinesSplitsOnLineFeedOnly()
{
    QFETCH(QString, text);
    QFETCH(QStringList, texts);
    QFETCH(QString, roles);

    const QVector<editor::ColoredLine> out = editor::colorLines(text);
    QStringList gotTexts;
    for (const editor::ColoredLine &line : out) {
        gotTexts << line.text;
        // Every line carries exactly the colour of its role.
        QCOMPARE(line.color, editor::colorForRole(line.role));
    }
    QCOMPARE(gotTexts, texts);
    QCOMPARE(spell(rolesOf(out)), roles);
}

// shouldRecolor(trigger, composing): never while composing; otherwise only the three triggers,
// compared exactly (case-sensitive).
void EditorColoringTest::recolorTriggerTable_data()
{
    QTest::addColumn<QString>("trigger");
    QTest::addColumn<bool>("idle");

    QTest::newRow("compositionend") << QStringLiteral("compositionend") << true;
    QTest::newRow("blur") << QStringLiteral("blur") << true;
    QTest::newRow("load") << QStringLiteral("load") << true;
    QTest::newRow("input") << QStringLiteral("input") << false;
    QTest::newRow("compositionstart") << QStringLiteral("compositionstart") << false;
    QTest::newRow("focus") << QStringLiteral("focus") << false;
    QTest::newRow("empty") << QString() << false;
    QTest::newRow("Load (case)") << QStringLiteral("Load") << false;
    QTest::newRow("BLUR (case)") << QStringLiteral("BLUR") << false;
}

void EditorColoringTest::recolorTriggerTable()
{
    QFETCH(QString, trigger);
    QFETCH(bool, idle);
    QCOMPARE(editor::shouldRecolor(trigger, true), false);
    QCOMPARE(editor::shouldRecolor(trigger, false), idle);
    QCOMPARE(editor::shouldRecolor(trigger), idle);
}
