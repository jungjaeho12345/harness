#include "editorrolestest.h"

#include "editor/editornewline.h" // isInputBlocked has lived here since step3
#include "editor/editorroles.h"

#include <QColor>
#include <QString>
#include <QStringList>
#include <QVector>
#include <QtTest>

namespace {

// One letter per role, so a data row reads like the web output ("TSSSSBB").
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

} // namespace

// The literal every editor module shares. Compared by code unit as well, so a source-charset slip
// (the file is UTF-8, cl.exe reads it with /utf-8) shows up here and not as a gate that never fires.
void EditorRolesTest::endMarkerIsTheCanonicalLiteral()
{
    QCOMPARE(editor::END_MARKER, QStringLiteral("(끝)"));
    QCOMPARE(editor::END_MARKER.size(), 3);
    QCOMPARE(editor::END_MARKER.at(0).unicode(), char16_t(0x0028));
    QCOMPARE(editor::END_MARKER.at(1).unicode(), char16_t(0xB05D));
    QCOMPARE(editor::END_MARKER.at(2).unicode(), char16_t(0x0029));
}

void EditorRolesTest::classifiesLines_data()
{
    QTest::addColumn<QStringList>("lines");
    QTest::addColumn<QString>("roles");

    // editorColoring.test.js "structure & colors" 1-3.
    QTest::newRow("web: first line title, lines 2-5 subtitle, 6+ body")
        << QStringList{QStringLiteral("제목"), QStringLiteral("부제1"), QStringLiteral("부제2"), QStringLiteral("부제3"),
                       QStringLiteral("부제4"), QStringLiteral("본문1"), QStringLiteral("본문2")}
        << QStringLiteral("TSSSSBB");
    QTest::newRow("web: blank at index 1 -> body from line 2")
        << QStringList{QStringLiteral("제목"), QString(), QStringLiteral("본문")} << QStringLiteral("TBB");
    QTest::newRow("web: blank at index 2 -> body from line 2 (the subtitle before it too)")
        << QStringList{QStringLiteral("제목"), QStringLiteral("부제"), QString(), QStringLiteral("본문")}
        << QStringLiteral("TBBB");
    QTest::newRow("web: marker line right after the title")
        << QStringList{QStringLiteral("제목"), QStringLiteral("(끝)")} << QStringLiteral("TE");
    QTest::newRow("web: marker line at index 3")
        << QStringList{QStringLiteral("제목"), QStringLiteral("부제"), QStringLiteral("본문"), QStringLiteral("(끝)")}
        << QStringLiteral("TSSE");

    // spikes/p0-qt-editor/selftest.cpp T1 - sample7 / sampleBlank.
    QTest::newRow("spike sample7: 0 title, 1-4 subtitle, 5 body, 6 end")
        << QStringList{QStringLiteral("제목 줄"), QStringLiteral("부제1"), QStringLiteral("부제2"), QStringLiteral("부제3"),
                       QStringLiteral("부제4"), QStringLiteral("본문 첫 줄입니다."), QStringLiteral("(끝)")}
        << QStringLiteral("TSSSSBE");
    QTest::newRow("spike sampleBlank: blank at index 2, end stays end")
        << QStringList{QStringLiteral("제목 줄"), QStringLiteral("부제1"), QString(), QStringLiteral("셋째 줄"),
                       QStringLiteral("(끝)")}
        << QStringLiteral("TBBBE");

    // Region boundaries: index 4 is the last subtitle slot, index 5 is already body.
    QTest::newRow("blank at index 4 is inside the subtitle region")
        << QStringList{QStringLiteral("t"), QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c"), QString(),
                       QStringLiteral("e")}
        << QStringLiteral("TBBBBB");
    QTest::newRow("blank at index 5 is outside the subtitle region")
        << QStringList{QStringLiteral("t"), QStringLiteral("a"), QStringLiteral("b"), QStringLiteral("c"),
                       QStringLiteral("d"), QString(), QStringLiteral("f")}
        << QStringLiteral("TSSSSBB");

    // The role rule compares the trimmed line; the input gate (below) does not.
    QTest::newRow("marker line with surrounding spaces is end")
        << QStringList{QStringLiteral("t"), QStringLiteral("  (끝)  ")} << QStringLiteral("TE");
    QTest::newRow("marker quoted inside a line is not end")
        << QStringList{QStringLiteral("t"), QStringLiteral("본문 (끝) 인용")} << QStringLiteral("TS");
    QTest::newRow("marker as line 0 is end, not title") << QStringList{QStringLiteral("(끝)")} << QStringLiteral("E");
    QTest::newRow("no lines") << QStringList() << QString();
}

void EditorRolesTest::classifiesLines()
{
    QFETCH(QStringList, lines);
    QFETCH(QString, roles);
    QCOMPARE(spell(editor::classifyLines(lines)), roles);
}

// editorColoring.test.js "structure & colors" 4 - the COLORS defaults.
void EditorRolesTest::colorsMatchTheWebDefaults()
{
    QCOMPARE(editor::colorForRole(editor::Role::Title).name(), QStringLiteral("#0a4da6"));
    QCOMPARE(editor::colorForRole(editor::Role::Subtitle).name(), QStringLiteral("#c8102e"));
    QCOMPARE(editor::colorForRole(editor::Role::Body).name(), QStringLiteral("#1a1a1a"));
    QCOMPARE(editor::colorForRole(editor::Role::End).name(), QStringLiteral("#d4af37"));
}

void EditorRolesTest::gatesInputAtTheLastMarker_data()
{
    QTest::addColumn<QString>("text");
    QTest::addColumn<int>("caret");
    QTest::addColumn<bool>("blocked");

    // editorNewline.test.js "blocks input at or after the marker" / "never blocks when there is no marker".
    const QString body = QStringLiteral("본문\n(끝)"); // marker starts at 3
    QTest::newRow("web: at the marker start") << body << 3 << true;
    QTest::newRow("web: after the marker") << body << 6 << true;
    QTest::newRow("web: the line before (newline position)") << body << 2 << false;
    QTest::newRow("web: document start") << body << 0 << false;
    QTest::newRow("web: no marker, start") << QStringLiteral("본문") << 0 << false;
    QTest::newRow("web: no marker, end") << QStringLiteral("본문") << 2 << false;

    // spikes/p0-qt-editor/selftest.cpp T2 - the pure boundary half.
    const QString spike = QStringLiteral("AB\n(끝)"); // marker starts at 3
    QTest::newRow("spike: before the marker") << spike << 2 << false;
    QTest::newRow("spike: at the marker start (the boundary)") << spike << 3 << true;
    QTest::newRow("spike: end of document") << spike << 6 << true;
    QTest::newRow("spike: no marker") << QStringLiteral("AB") << 2 << false;

    // lastIndexOf: only the LAST marker closes the document.
    const QString twice = QStringLiteral("(끝)\nX\n(끝)"); // markers at 0 and 6
    QTest::newRow("between two markers is open") << twice << 4 << false;
    QTest::newRow("at the last marker is closed") << twice << 6 << true;

    // Offsets are UTF-16 code units, like a JS string index: the emoji counts 2.
    const QString astral = QString::fromUtf8("\xF0\x9F\x98\x80") + QStringLiteral("\n(끝)"); // marker at 3
    QTest::newRow("surrogate pair counts two units: before") << astral << 2 << false;
    QTest::newRow("surrogate pair counts two units: at") << astral << 3 << true;

    // The gate is a substring rule - a quoted "(끝)" closes the text after it (unlike the role rule).
    const QString quoted = QStringLiteral("인용 (끝) 문장"); // marker at 3
    QTest::newRow("quoted marker: before") << quoted << 2 << false;
    QTest::newRow("quoted marker: at") << quoted << 3 << true;
}

void EditorRolesTest::gatesInputAtTheLastMarker()
{
    QFETCH(QString, text);
    QFETCH(int, caret);
    QFETCH(bool, blocked);
    QCOMPARE(editor::isInputBlocked(text, caret), blocked);
}
