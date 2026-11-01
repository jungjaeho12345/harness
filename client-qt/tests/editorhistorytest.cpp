#include "editorhistorytest.h"

#include "editor/editorhistory.h"

#include <QChar>
#include <QLatin1Char>
#include <QLatin1String>
#include <QString>
#include <QStringList>
#include <QtTest>

#include <initializer_list>
#include <optional>

using editor::History;
using editor::HistoryMove;

namespace {

// A string built code unit by code unit - for rows holding a lone surrogate, which no C++ literal can spell.
QString units(std::initializer_list<char16_t> codeUnits)
{
    QString s;
    for (const char16_t unit : codeUnits)
        s.append(QChar(unit));
    return s;
}

// The web's r.body when there is one (its null is std::nullopt).
std::optional<QString> restored(const QString &text)
{
    return text;
}

// Whether every function may take h (entries not empty, index inside them). A broken implementation has to turn a
// row red - not crash the runner by indexing past the end on a later op.
bool isWellFormed(const History &h)
{
    return !h.entries.isEmpty() && 0 <= h.index && h.index < h.entries.size();
}

// The replay trace, in the generator's format (s6-rows.mjs), built from the port's own state:
//   after a push       ['A','B']@1 new U-               entries @ index, same|new (the result equals the input),
//                                                       canUndo canRedo
//   after undo / redo  ['A','B']@0 new -R moved 'A'     ... then moved|stay (changed) and the body or null
QString quoted(const QString &s)
{
    return QLatin1Char('\'') + s + QLatin1Char('\'');
}

QString stateOf(const History &h)
{
    QStringList items;
    for (const QString &entry : h.entries)
        items << quoted(entry);
    return QLatin1Char('[') + items.join(QLatin1Char(',')) + QLatin1String("]@") + QString::number(h.index);
}

QString pushTrace(const History &before, const History &after)
{
    return stateOf(after) + (after == before ? QLatin1String(" same ") : QLatin1String(" new "))
        + QLatin1Char(editor::canUndo(after) ? 'U' : '-') + QLatin1Char(editor::canRedo(after) ? 'R' : '-');
}

QString moveTrace(const History &before, const HistoryMove &moved)
{
    return pushTrace(before, moved.history) + (moved.changed ? QLatin1String(" moved ") : QLatin1String(" stay "))
        + (moved.body ? quoted(*moved.body) : QStringLiteral("null"));
}

} // namespace

// ---- editorHistory — createHistory (베이스라인) ------------------------------------------------------------

// it: 'creates a single-entry baseline history (undo/redo 모두 불가)'
void EditorHistoryTest::createsASingleEntryBaseline()
{
    const History h = editor::createHistory(QStringLiteral("A"));
    QCOMPARE(h.entries, QStringList{QStringLiteral("A")});
    QCOMPARE(h.index, 0);
    QVERIFY(!editor::canUndo(h));
    QVERIFY(!editor::canRedo(h));
}

// it: 'coerces null/undefined initial body to empty string' - C++ has one null, QString(); the web's
// String(initialBody ?? '') makes it an empty string, which here is also not null.
void EditorHistoryTest::coercesANullInitialBodyToTheEmptyString()
{
    const History h = editor::createHistory(QString());
    QCOMPARE(h.entries, QStringList{QStringLiteral("")});
    QVERIFY(!h.entries.at(0).isNull());
    QCOMPARE(h.index, 0);
}

// ---- editorHistory — push/undo/redo 왕복 -----------------------------------------------------------------

// it: 'walks back to the baseline and forward to the top'
void EditorHistoryTest::walksBackToTheBaselineAndForwardToTheTop()
{
    History h = editor::createHistory(QStringLiteral("A"));
    h = editor::pushHistory(h, QStringLiteral("B"));
    h = editor::pushHistory(h, QStringLiteral("C"));
    QVERIFY(editor::canUndo(h));
    QVERIFY(!editor::canRedo(h));

    HistoryMove r = editor::undo(h);
    QVERIFY(r.changed);
    QCOMPARE(r.body, restored(QStringLiteral("B")));
    r = editor::undo(r.history);
    QVERIFY(r.changed);
    QCOMPARE(r.body, restored(QStringLiteral("A"))); // 베이스라인 도달
    QVERIFY(!editor::canUndo(r.history));

    const HistoryMove blocked = editor::undo(r.history);
    QVERIFY(!blocked.changed);
    QCOMPARE(blocked.body, std::optional<QString>());
    QVERIFY(blocked.history == r.history);

    r = editor::redo(r.history);
    QVERIFY(r.changed);
    QCOMPARE(r.body, restored(QStringLiteral("B")));
    r = editor::redo(r.history);
    QVERIFY(r.changed);
    QCOMPARE(r.body, restored(QStringLiteral("C")));
    QVERIFY(!editor::canRedo(r.history));

    const HistoryMove top = editor::redo(r.history);
    QVERIFY(!top.changed);
    QCOMPARE(top.body, std::optional<QString>());
    QVERIFY(top.history == r.history);
}

// ---- editorHistory — redo 분기 절단 ----------------------------------------------------------------------

// it: 'drops the future branch when pushing after undo'
void EditorHistoryTest::dropsTheFutureBranchWhenPushingAfterUndo()
{
    History h = editor::createHistory(QStringLiteral("A"));
    h = editor::pushHistory(h, QStringLiteral("B"));
    h = editor::pushHistory(h, QStringLiteral("C"));
    const HistoryMove back = editor::undo(h); // → 'B'
    h = editor::pushHistory(back.history, QStringLiteral("D")); // C 절단, 경로 A,B,D
    QVERIFY(!editor::canRedo(h));
    QCOMPARE(h.entries, (QStringList{QStringLiteral("A"), QStringLiteral("B"), QStringLiteral("D")}));

    HistoryMove r = editor::undo(h);
    QCOMPARE(r.body, restored(QStringLiteral("B")));
    r = editor::undo(r.history);
    QCOMPARE(r.body, restored(QStringLiteral("A")));
    QVERIFY(!editor::canUndo(r.history));
}

// it: 'cuts the redo branch even with coalesce:true when not at top (교체가 아니라 push)'
void EditorHistoryTest::cutsTheRedoBranchEvenWithCoalesceBelowTheTop()
{
    History h = editor::createHistory(QStringLiteral("A"));
    h = editor::pushHistory(h, QStringLiteral("B"));
    h = editor::pushHistory(h, QStringLiteral("C"));
    const HistoryMove back = editor::undo(h); // 현재 'B' (top 아님)
    h = editor::pushHistory(back.history, QStringLiteral("D"), true);
    QCOMPARE(h.entries, (QStringList{QStringLiteral("A"), QStringLiteral("B"), QStringLiteral("D")}));
    QVERIFY(!editor::canRedo(h));
}

// ---- editorHistory — 동일 body no-op ---------------------------------------------------------------------

// it: 'returns the same history when pushing the current body' - the web's same object is an equal value here.
void EditorHistoryTest::returnsTheSameHistoryForTheCurrentBody()
{
    History h = editor::createHistory(QStringLiteral("A"));
    h = editor::pushHistory(h, QStringLiteral("B"));
    const History same = editor::pushHistory(h, QStringLiteral("B"));
    QVERIFY(same == h);
    QCOMPARE(same.entries.size(), 2);
    QCOMPARE(same.index, 1);
}

// it: 'is a no-op even with coalesce:true (StrictMode 이중 호출 방어)'. At the top past the baseline a coalesced
// replace by the same body would also leave an equal value - the no-op is pinned where the two part (at the
// baseline, below the top) by the replay table (H04, H08, H09).
void EditorHistoryTest::isANoOpEvenWithCoalesce()
{
    History h = editor::createHistory(QStringLiteral("A"));
    h = editor::pushHistory(h, QStringLiteral("B"));
    const History same = editor::pushHistory(h, QStringLiteral("B"), true);
    QVERIFY(same == h);
}

// ---- editorHistory — 코얼레싱 (타이핑 연타) ----------------------------------------------------------------

// it: 'first typed snapshot after baseline is a push, later coalesced captures replace the top'
void EditorHistoryTest::coalescesLaterTypingIntoTheTop()
{
    History h = editor::createHistory(QStringLiteral(""));
    h = editor::pushHistory(h, QStringLiteral("a"), true); // 베이스라인 다음 첫 타이핑 → push
    QCOMPARE(h.entries, (QStringList{QStringLiteral(""), QStringLiteral("a")}));
    h = editor::pushHistory(h, QStringLiteral("ab"), true); // top 교체
    h = editor::pushHistory(h, QStringLiteral("abc"), true); // top 교체
    QCOMPARE(h.entries, (QStringList{QStringLiteral(""), QStringLiteral("abc")}));
    QCOMPARE(h.index, 1);

    const HistoryMove r = editor::undo(h);
    QCOMPARE(r.body, restored(QStringLiteral(""))); // 베이스라인 보존
    QVERIFY(!editor::canUndo(r.history));
}

// it: 'never replaces the baseline (베이스라인 불멸)'
void EditorHistoryTest::neverReplacesTheBaseline()
{
    const History base = editor::createHistory(QStringLiteral("base"));
    const History h = editor::pushHistory(base, QStringLiteral("x"), true);
    QCOMPARE(h.entries, (QStringList{QStringLiteral("base"), QStringLiteral("x")}));
    QCOMPARE(h.index, 1);
    const HistoryMove r = editor::undo(h);
    QCOMPARE(r.body, restored(QStringLiteral("base")));
}

// ---- editorHistory — 상한(limit) -------------------------------------------------------------------------

// it: 'drops the oldest entries beyond the limit and keeps index consistent'
void EditorHistoryTest::dropsTheOldestEntriesBeyondTheLimit()
{
    History h = editor::createHistory(QStringLiteral("A"));
    h = editor::pushHistory(h, QStringLiteral("B"), false, 3);
    h = editor::pushHistory(h, QStringLiteral("C"), false, 3);
    h = editor::pushHistory(h, QStringLiteral("D"), false, 3); // A 탈락
    QCOMPARE(h.entries, (QStringList{QStringLiteral("B"), QStringLiteral("C"), QStringLiteral("D")}));
    QCOMPARE(h.index, 2);
    QVERIFY(!editor::canRedo(h));
    QVERIFY(editor::canUndo(h));

    h = editor::pushHistory(h, QStringLiteral("E"), false, 3); // B 탈락
    QCOMPARE(h.entries, (QStringList{QStringLiteral("C"), QStringLiteral("D"), QStringLiteral("E")}));
    QCOMPARE(h.index, 2);

    HistoryMove r = editor::undo(h);
    QCOMPARE(r.body, restored(QStringLiteral("D")));
    r = editor::undo(r.history);
    QCOMPARE(r.body, restored(QStringLiteral("C")));
    QVERIFY(!editor::canUndo(r.history)); // 절단 후 남은 범위까지만 undo
}

// ---- editorHistory — 입력 불변 (mutate 금지) -------------------------------------------------------------

// it: 'pushHistory does not mutate the input history' - the web holds on to the entries array; here a copy of the
// value, which the input must still equal afterwards.
void EditorHistoryTest::pushDoesNotMutateTheInput()
{
    const History h = editor::createHistory(QStringLiteral("A"));
    const QStringList entriesBefore = h.entries;
    editor::pushHistory(h, QStringLiteral("B"));
    editor::pushHistory(h, QStringLiteral("C"), true, 2);
    QCOMPARE(h.entries, entriesBefore);
    QCOMPARE(h.entries, QStringList{QStringLiteral("A")});
    QCOMPARE(h.index, 0);
}

// it: 'coalescing replace does not mutate the input entries'
void EditorHistoryTest::coalescingDoesNotMutateTheInput()
{
    History h = editor::createHistory(QStringLiteral(""));
    h = editor::pushHistory(h, QStringLiteral("a"), true);
    const History &before = h; // the web's `before = h` - the same object
    const QStringList beforeEntries = h.entries;
    const History next = editor::pushHistory(h, QStringLiteral("ab"), true);
    QCOMPARE(before.entries, beforeEntries);
    QCOMPARE(before.index, 1);
    QVERIFY(next != before);
}

// it: 'undo/redo do not mutate the input history'
void EditorHistoryTest::undoAndRedoDoNotMutateTheInput()
{
    History h = editor::createHistory(QStringLiteral("A"));
    h = editor::pushHistory(h, QStringLiteral("B"));
    const HistoryMove r = editor::undo(h);
    QCOMPARE(h.entries, (QStringList{QStringLiteral("A"), QStringLiteral("B")}));
    QCOMPARE(h.index, 1);
    QVERIFY(r.history != h);
    const HistoryMove rr = editor::redo(r.history);
    QCOMPARE(r.history.index, 0);
    QCOMPARE(rr.history.index, 1);
}

// ---- editorHistory — body는 불투명 문자열 ----------------------------------------------------------------

// it: 'treats non-string bodies via String coercion and never parses content' - a C++ body is always a QString;
// the web's null is QString().
void EditorHistoryTest::treatsTheBodyAsAnOpaqueString()
{
    History h = editor::createHistory(QStringLiteral("{\"format\":\"yh-editor\"}"));
    // JSON처럼 보여도 파싱/정규화 없이 문자 그대로 비교·보관한다.
    const History sameJson = editor::pushHistory(h, QStringLiteral("{\"format\":\"yh-editor\"}"));
    QVERIFY(sameJson == h);
    h = editor::pushHistory(h, QStringLiteral("{\"format\":\"yh-editor\",\"version\":1}"));
    QCOMPARE(h.entries.size(), 2);
    QCOMPARE(h.entries.at(1), QStringLiteral("{\"format\":\"yh-editor\",\"version\":1}"));
    const History nulled = editor::pushHistory(h, QString()); // → '' push
    QVERIFY(isWellFormed(nulled));
    QCOMPARE(nulled.entries.at(nulled.index), QStringLiteral(""));
}

// ---- Port locks ------------------------------------------------------------------------------------------

// Op scripts replayed against the web module, the whole state compared after every op: the spec's own sequences
// (H01-H07), hand-picked branches (H08-H30: the no-op below the top keeps the redo branch, only the current entry
// counts, coalescing at the baseline / below the top is a push, empty and Hangul bodies, limit 1 / 2 / 3, a limit
// lowered between calls, a coalesced replace that never cuts, limit 0 and negative = no limit, the baseline dropped
// by the cut) and 16 seeded random scripts (R01-R16).
void EditorHistoryTest::replaysTheWebScripts_data()
{
    QTest::addColumn<QString>("initial");
    QTest::addColumn<QString>("script"); // ops by spaces: u = undo, r = redo, p[limit]:body, c[limit]:body = coalesce
    QTest::addColumn<QStringList>("trace"); // the web's state after each op

    QTest::newRow("H01 web walk to the baseline and back to the top")
        << QStringLiteral("A") << QStringLiteral("p:B p:C u u u r r r")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','C']@0 new -R moved 'A'"),
               QStringLiteral("['A','B','C']@0 same -R stay null"),
               QStringLiteral("['A','B','C']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','C']@2 new U- moved 'C'"),
               QStringLiteral("['A','B','C']@2 same U- stay null")};
    QTest::newRow("H02 web branch cut after undo")
        << QStringLiteral("A") << QStringLiteral("p:B p:C u p:D u u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','D']@2 new U-"),
               QStringLiteral("['A','B','D']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','D']@0 new -R moved 'A'")};
    QTest::newRow("H03 web coalesce below the top is a push")
        << QStringLiteral("A") << QStringLiteral("p:B p:C u c:D")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','D']@2 new U-")};
    QTest::newRow("H04 web same body push and coalesce")
        << QStringLiteral("A") << QStringLiteral("p:B p:B c:B")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B']@1 same U-"),
               QStringLiteral("['A','B']@1 same U-")};
    QTest::newRow("H05 web typing burst")
        << QStringLiteral("") << QStringLiteral("c:a c:ab c:abc u")
        << QStringList{
               QStringLiteral("['','a']@1 new U-"),
               QStringLiteral("['','ab']@1 new U-"),
               QStringLiteral("['','abc']@1 new U-"),
               QStringLiteral("['','abc']@0 new -R moved ''")};
    QTest::newRow("H06 web baseline never replaced")
        << QStringLiteral("base") << QStringLiteral("c:x u")
        << QStringList{
               QStringLiteral("['base','x']@1 new U-"),
               QStringLiteral("['base','x']@0 new -R moved 'base'")};
    QTest::newRow("H07 web limit 3")
        << QStringLiteral("A") << QStringLiteral("p3:B p3:C p3:D p3:E u u u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['B','C','D']@2 new U-"),
               QStringLiteral("['C','D','E']@2 new U-"),
               QStringLiteral("['C','D','E']@1 new UR moved 'D'"),
               QStringLiteral("['C','D','E']@0 new -R moved 'C'"),
               QStringLiteral("['C','D','E']@0 same -R stay null")};
    QTest::newRow("H08 same body at the baseline keeps redo")
        << QStringLiteral("A") << QStringLiteral("p:B u p:A c:A r")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B']@0 new -R moved 'A'"),
               QStringLiteral("['A','B']@0 same -R"),
               QStringLiteral("['A','B']@0 same -R"),
               QStringLiteral("['A','B']@1 new U- moved 'B'")};
    QTest::newRow("H09 same body mid stack keeps redo")
        << QStringLiteral("A") << QStringLiteral("p:B p:C u p:B c:B r")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','C']@1 same UR"),
               QStringLiteral("['A','B','C']@1 same UR"),
               QStringLiteral("['A','B','C']@2 new U- moved 'C'")};
    QTest::newRow("H10 baseline body pushed again")
        << QStringLiteral("A") << QStringLiteral("p:B p:A u u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','A']@2 new U-"),
               QStringLiteral("['A','B','A']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','A']@0 new -R moved 'A'")};
    QTest::newRow("H11 coalesce back to the baseline body")
        << QStringLiteral("A") << QStringLiteral("c:B c:A u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','A']@1 new U-"),
               QStringLiteral("['A','A']@0 new -R moved 'A'")};
    QTest::newRow("H12 coalesce at the baseline is a push")
        << QStringLiteral("A") << QStringLiteral("c:B c:C c:D")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','C']@1 new U-"),
               QStringLiteral("['A','D']@1 new U-")};
    QTest::newRow("H13 coalesce after undo to the baseline cuts")
        << QStringLiteral("A") << QStringLiteral("p:B u c:C c:D u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B']@0 new -R moved 'A'"),
               QStringLiteral("['A','C']@1 new U-"),
               QStringLiteral("['A','D']@1 new U-"),
               QStringLiteral("['A','D']@0 new -R moved 'A'")};
    QTest::newRow("H14 coalesce after a plain push replaces it")
        << QStringLiteral("A") << QStringLiteral("c:B p:C c:D u u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','D']@2 new U-"),
               QStringLiteral("['A','B','D']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','D']@0 new -R moved 'A'")};
    QTest::newRow("H15 coalesce mid stack cuts and pushes")
        << QStringLiteral("A") << QStringLiteral("p:B p:C p:D u u c:X c:Y u u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C','D']@3 new U-"),
               QStringLiteral("['A','B','C','D']@2 new UR moved 'C'"),
               QStringLiteral("['A','B','C','D']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','X']@2 new U-"),
               QStringLiteral("['A','B','Y']@2 new U-"),
               QStringLiteral("['A','B','Y']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','Y']@0 new -R moved 'A'")};
    QTest::newRow("H16 empty bodies")
        << QStringLiteral("") << QStringLiteral("p: c: p:A p: c: u r")
        << QStringList{
               QStringLiteral("['']@0 same --"),
               QStringLiteral("['']@0 same --"),
               QStringLiteral("['','A']@1 new U-"),
               QStringLiteral("['','A','']@2 new U-"),
               QStringLiteral("['','A','']@2 same U-"),
               QStringLiteral("['','A','']@1 new UR moved 'A'"),
               QStringLiteral("['','A','']@2 new U- moved ''")};
    QTest::newRow("H17 undo at the baseline and redo at the top")
        << QStringLiteral("A") << QStringLiteral("u r p:B r r u u u r")
        << QStringList{
               QStringLiteral("['A']@0 same -- stay null"),
               QStringLiteral("['A']@0 same -- stay null"),
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B']@1 same U- stay null"),
               QStringLiteral("['A','B']@1 same U- stay null"),
               QStringLiteral("['A','B']@0 new -R moved 'A'"),
               QStringLiteral("['A','B']@0 same -R stay null"),
               QStringLiteral("['A','B']@0 same -R stay null"),
               QStringLiteral("['A','B']@1 new U- moved 'B'")};
    QTest::newRow("H18 deep branch cut")
        << QStringLiteral("A") << QStringLiteral("p:B p:C p:D p:E u u u p:F r u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C','D']@3 new U-"),
               QStringLiteral("['A','B','C','D','E']@4 new U-"),
               QStringLiteral("['A','B','C','D','E']@3 new UR moved 'D'"),
               QStringLiteral("['A','B','C','D','E']@2 new UR moved 'C'"),
               QStringLiteral("['A','B','C','D','E']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','F']@2 new U-"),
               QStringLiteral("['A','B','F']@2 same U- stay null"),
               QStringLiteral("['A','B','F']@1 new UR moved 'B'")};
    QTest::newRow("H19 redo branch survives undo and redo")
        << QStringLiteral("A") << QStringLiteral("p:B p:C p:D u u r u r r r")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C','D']@3 new U-"),
               QStringLiteral("['A','B','C','D']@2 new UR moved 'C'"),
               QStringLiteral("['A','B','C','D']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','C','D']@2 new UR moved 'C'"),
               QStringLiteral("['A','B','C','D']@1 new UR moved 'B'"),
               QStringLiteral("['A','B','C','D']@2 new UR moved 'C'"),
               QStringLiteral("['A','B','C','D']@3 new U- moved 'D'"),
               QStringLiteral("['A','B','C','D']@3 same U- stay null")};
    QTest::newRow("H20 limit 1")
        << QStringLiteral("A") << QStringLiteral("p1:B c1:C u r p1:D")
        << QStringList{
               QStringLiteral("['B']@0 new --"),
               QStringLiteral("['C']@0 new --"),
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['D']@0 new --")};
    QTest::newRow("H21 limit 2 with coalesce")
        << QStringLiteral("A") << QStringLiteral("p2:B c2:C p2:D c2:E u c2:F")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','C']@1 new U-"),
               QStringLiteral("['C','D']@1 new U-"),
               QStringLiteral("['C','E']@1 new U-"),
               QStringLiteral("['C','E']@0 new -R moved 'C'"),
               QStringLiteral("['C','F']@1 new U-")};
    QTest::newRow("H22 limit exactly reached")
        << QStringLiteral("A") << QStringLiteral("p3:B p3:C p3:D u u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['B','C','D']@2 new U-"),
               QStringLiteral("['B','C','D']@1 new UR moved 'C'"),
               QStringLiteral("['B','C','D']@0 new -R moved 'B'")};
    QTest::newRow("H23 limit lowered")
        << QStringLiteral("A") << QStringLiteral("p:B p:C p:D p:E p2:F u u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C','D']@3 new U-"),
               QStringLiteral("['A','B','C','D','E']@4 new U-"),
               QStringLiteral("['E','F']@1 new U-"),
               QStringLiteral("['E','F']@0 new -R moved 'E'"),
               QStringLiteral("['E','F']@0 same -R stay null")};
    QTest::newRow("H24 limit lowered after undo")
        << QStringLiteral("A") << QStringLiteral("p:B p:C p:D u u p2:X u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C','D']@3 new U-"),
               QStringLiteral("['A','B','C','D']@2 new UR moved 'C'"),
               QStringLiteral("['A','B','C','D']@1 new UR moved 'B'"),
               QStringLiteral("['B','X']@1 new U-"),
               QStringLiteral("['B','X']@0 new -R moved 'B'")};
    QTest::newRow("H25 coalesce never applies the limit")
        << QStringLiteral("A") << QStringLiteral("p:B p:C p:D c2:E u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','C','D']@3 new U-"),
               QStringLiteral("['A','B','C','E']@3 new U-"),
               QStringLiteral("['A','B','C','E']@2 new UR moved 'C'")};
    QTest::newRow("H26 limit 0 and negative are no limit")
        << QStringLiteral("A") << QStringLiteral("p0:B p-1:C c-5:D p0:E")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['A','B','D']@2 new U-"),
               QStringLiteral("['A','B','D','E']@3 new U-")};
    QTest::newRow("H27 limit drops the baseline then coalesce")
        << QStringLiteral("A") << QStringLiteral("p2:B p2:C c2:D u c2:E")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['B','C']@1 new U-"),
               QStringLiteral("['B','D']@1 new U-"),
               QStringLiteral("['B','D']@0 new -R moved 'B'"),
               QStringLiteral("['B','E']@1 new U-")};
    QTest::newRow("H28 limit 3 deep undo then push")
        << QStringLiteral("A") << QStringLiteral("p3:B p3:C p3:D u u p3:E u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','B','C']@2 new U-"),
               QStringLiteral("['B','C','D']@2 new U-"),
               QStringLiteral("['B','C','D']@1 new UR moved 'C'"),
               QStringLiteral("['B','C','D']@0 new -R moved 'B'"),
               QStringLiteral("['B','E']@1 new U-"),
               QStringLiteral("['B','E']@0 new -R moved 'B'")};
    QTest::newRow("H29 Hangul typing")
        << QStringLiteral("가") << QStringLiteral("c:가나 c:가나다 p:가 u u r")
        << QStringList{
               QStringLiteral("['가','가나']@1 new U-"),
               QStringLiteral("['가','가나다']@1 new U-"),
               QStringLiteral("['가','가나다','가']@2 new U-"),
               QStringLiteral("['가','가나다','가']@1 new UR moved '가나다'"),
               QStringLiteral("['가','가나다','가']@0 new -R moved '가'"),
               QStringLiteral("['가','가나다','가']@1 new UR moved '가나다'")};
    QTest::newRow("H30 burst undo then type again")
        << QStringLiteral("A") << QStringLiteral("c:B c:BC c:BCD u c:X c:XY u")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['A','BC']@1 new U-"),
               QStringLiteral("['A','BCD']@1 new U-"),
               QStringLiteral("['A','BCD']@0 new -R moved 'A'"),
               QStringLiteral("['A','X']@1 new U-"),
               QStringLiteral("['A','XY']@1 new U-"),
               QStringLiteral("['A','XY']@0 new -R moved 'A'")};
    QTest::newRow("R01 random seed 20261101 limit 2")
        << QStringLiteral("B") << QStringLiteral("c2:C u c2:B p2:가나 p1:C c2: c2: c2:AB c2:가 u c2: u c2:가나 c2:가나 c2: c2:가나 p2:A c-1:AB p2:A r")
        << QStringList{
               QStringLiteral("['B','C']@1 new U-"),
               QStringLiteral("['B','C']@0 new -R moved 'B'"),
               QStringLiteral("['B','C']@0 same -R"),
               QStringLiteral("['B','가나']@1 new U-"),
               QStringLiteral("['C']@0 new --"),
               QStringLiteral("['C','']@1 new U-"),
               QStringLiteral("['C','']@1 same U-"),
               QStringLiteral("['C','AB']@1 new U-"),
               QStringLiteral("['C','가']@1 new U-"),
               QStringLiteral("['C','가']@0 new -R moved 'C'"),
               QStringLiteral("['C','']@1 new U-"),
               QStringLiteral("['C','']@0 new -R moved 'C'"),
               QStringLiteral("['C','가나']@1 new U-"),
               QStringLiteral("['C','가나']@1 same U-"),
               QStringLiteral("['C','']@1 new U-"),
               QStringLiteral("['C','가나']@1 new U-"),
               QStringLiteral("['가나','A']@1 new U-"),
               QStringLiteral("['가나','AB']@1 new U-"),
               QStringLiteral("['AB','A']@1 new U-"),
               QStringLiteral("['AB','A']@1 same U- stay null")};
    QTest::newRow("R02 random seed 20261101 limit 2")
        << QStringLiteral("가") << QStringLiteral("r p2:AB c2:B u c2: u r p2:C c2:AB p2:C c2:AB c2:A u u")
        << QStringList{
               QStringLiteral("['가']@0 same -- stay null"),
               QStringLiteral("['가','AB']@1 new U-"),
               QStringLiteral("['가','B']@1 new U-"),
               QStringLiteral("['가','B']@0 new -R moved '가'"),
               QStringLiteral("['가','']@1 new U-"),
               QStringLiteral("['가','']@0 new -R moved '가'"),
               QStringLiteral("['가','']@1 new U- moved ''"),
               QStringLiteral("['','C']@1 new U-"),
               QStringLiteral("['','AB']@1 new U-"),
               QStringLiteral("['AB','C']@1 new U-"),
               QStringLiteral("['AB','AB']@1 new U-"),
               QStringLiteral("['AB','A']@1 new U-"),
               QStringLiteral("['AB','A']@0 new -R moved 'AB'"),
               QStringLiteral("['AB','A']@0 same -R stay null")};
    QTest::newRow("R03 random seed 20261101 limit -1")
        << QStringLiteral("") << QStringLiteral("c-1:A c-1:B u c:가나 c-1: r p-1:AB p-1:가나 u p3:가나 u p-1:C u p-1:A c-1:C p-1:AB p-1:가")
        << QStringList{
               QStringLiteral("['','A']@1 new U-"),
               QStringLiteral("['','B']@1 new U-"),
               QStringLiteral("['','B']@0 new -R moved ''"),
               QStringLiteral("['','가나']@1 new U-"),
               QStringLiteral("['','']@1 new U-"),
               QStringLiteral("['','']@1 same U- stay null"),
               QStringLiteral("['','','AB']@2 new U-"),
               QStringLiteral("['','','AB','가나']@3 new U-"),
               QStringLiteral("['','','AB','가나']@2 new UR moved 'AB'"),
               QStringLiteral("['','AB','가나']@2 new U-"),
               QStringLiteral("['','AB','가나']@1 new UR moved 'AB'"),
               QStringLiteral("['','AB','C']@2 new U-"),
               QStringLiteral("['','AB','C']@1 new UR moved 'AB'"),
               QStringLiteral("['','AB','A']@2 new U-"),
               QStringLiteral("['','AB','C']@2 new U-"),
               QStringLiteral("['','AB','C','AB']@3 new U-"),
               QStringLiteral("['','AB','C','AB','가']@4 new U-")};
    QTest::newRow("R04 random seed 20261101 limit -1")
        << QStringLiteral("가") << QStringLiteral("p5: r c-1:가 c-1:A p1:C u p5:C c-1:가나 u c:가 u c-1:C c3:가나")
        << QStringList{
               QStringLiteral("['가','']@1 new U-"),
               QStringLiteral("['가','']@1 same U- stay null"),
               QStringLiteral("['가','가']@1 new U-"),
               QStringLiteral("['가','A']@1 new U-"),
               QStringLiteral("['C']@0 new --"),
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['C']@0 same --"),
               QStringLiteral("['C','가나']@1 new U-"),
               QStringLiteral("['C','가나']@0 new -R moved 'C'"),
               QStringLiteral("['C','가']@1 new U-"),
               QStringLiteral("['C','가']@0 new -R moved 'C'"),
               QStringLiteral("['C','가']@0 same -R"),
               QStringLiteral("['C','가나']@1 new U-")};
    QTest::newRow("R05 random seed 20261101 limit -1")
        << QStringLiteral("가") << QStringLiteral("c-1: r c-1:가 u u p-1: c-1:C c1:가 p-1:B r c-1:C c-1: u c3: r p-1:가나 r u c:")
        << QStringList{
               QStringLiteral("['가','']@1 new U-"),
               QStringLiteral("['가','']@1 same U- stay null"),
               QStringLiteral("['가','가']@1 new U-"),
               QStringLiteral("['가','가']@0 new -R moved '가'"),
               QStringLiteral("['가','가']@0 same -R stay null"),
               QStringLiteral("['가','']@1 new U-"),
               QStringLiteral("['가','C']@1 new U-"),
               QStringLiteral("['가','가']@1 new U-"),
               QStringLiteral("['가','가','B']@2 new U-"),
               QStringLiteral("['가','가','B']@2 same U- stay null"),
               QStringLiteral("['가','가','C']@2 new U-"),
               QStringLiteral("['가','가','']@2 new U-"),
               QStringLiteral("['가','가','']@1 new UR moved '가'"),
               QStringLiteral("['가','가','']@2 new U-"),
               QStringLiteral("['가','가','']@2 same U- stay null"),
               QStringLiteral("['가','가','','가나']@3 new U-"),
               QStringLiteral("['가','가','','가나']@3 same U- stay null"),
               QStringLiteral("['가','가','','가나']@2 new UR moved ''"),
               QStringLiteral("['가','가','','가나']@2 same UR")};
    QTest::newRow("R06 random seed 20261101 limit 2")
        << QStringLiteral("AB") << QStringLiteral("c2:가나 c2:B c2:가 c5:AB p2:가 c2:B p3: r c2:가나 u c2:C p: c2:A r p2:C c2:C c2:AB p2:가 u c2:AB")
        << QStringList{
               QStringLiteral("['AB','가나']@1 new U-"),
               QStringLiteral("['AB','B']@1 new U-"),
               QStringLiteral("['AB','가']@1 new U-"),
               QStringLiteral("['AB','AB']@1 new U-"),
               QStringLiteral("['AB','가']@1 new U-"),
               QStringLiteral("['AB','B']@1 new U-"),
               QStringLiteral("['AB','B','']@2 new U-"),
               QStringLiteral("['AB','B','']@2 same U- stay null"),
               QStringLiteral("['AB','B','가나']@2 new U-"),
               QStringLiteral("['AB','B','가나']@1 new UR moved 'B'"),
               QStringLiteral("['B','C']@1 new U-"),
               QStringLiteral("['B','C','']@2 new U-"),
               QStringLiteral("['B','C','A']@2 new U-"),
               QStringLiteral("['B','C','A']@2 same U- stay null"),
               QStringLiteral("['A','C']@1 new U-"),
               QStringLiteral("['A','C']@1 same U-"),
               QStringLiteral("['A','AB']@1 new U-"),
               QStringLiteral("['AB','가']@1 new U-"),
               QStringLiteral("['AB','가']@0 new -R moved 'AB'"),
               QStringLiteral("['AB','가']@0 same -R")};
    QTest::newRow("R07 random seed 20261101 limit 2")
        << QStringLiteral("가나") << QStringLiteral("u c2:AB c-1:C c2:A r p2:A p2:A u p5:AB c2: p2:A u")
        << QStringList{
               QStringLiteral("['가나']@0 same -- stay null"),
               QStringLiteral("['가나','AB']@1 new U-"),
               QStringLiteral("['가나','C']@1 new U-"),
               QStringLiteral("['가나','A']@1 new U-"),
               QStringLiteral("['가나','A']@1 same U- stay null"),
               QStringLiteral("['가나','A']@1 same U-"),
               QStringLiteral("['가나','A']@1 same U-"),
               QStringLiteral("['가나','A']@0 new -R moved '가나'"),
               QStringLiteral("['가나','AB']@1 new U-"),
               QStringLiteral("['가나','']@1 new U-"),
               QStringLiteral("['','A']@1 new U-"),
               QStringLiteral("['','A']@0 new -R moved ''")};
    QTest::newRow("R08 random seed 20261101 limit -1")
        << QStringLiteral("C") << QStringLiteral("c-1:A u c1:가나 r p-1:AB r r p-1:가나 p-1:B c-1:가 r p2:가나 c-1:가나 c-1:C p-1:AB c-1:C r")
        << QStringList{
               QStringLiteral("['C','A']@1 new U-"),
               QStringLiteral("['C','A']@0 new -R moved 'C'"),
               QStringLiteral("['가나']@0 new --"),
               QStringLiteral("['가나']@0 same -- stay null"),
               QStringLiteral("['가나','AB']@1 new U-"),
               QStringLiteral("['가나','AB']@1 same U- stay null"),
               QStringLiteral("['가나','AB']@1 same U- stay null"),
               QStringLiteral("['가나','AB','가나']@2 new U-"),
               QStringLiteral("['가나','AB','가나','B']@3 new U-"),
               QStringLiteral("['가나','AB','가나','가']@3 new U-"),
               QStringLiteral("['가나','AB','가나','가']@3 same U- stay null"),
               QStringLiteral("['가','가나']@1 new U-"),
               QStringLiteral("['가','가나']@1 same U-"),
               QStringLiteral("['가','C']@1 new U-"),
               QStringLiteral("['가','C','AB']@2 new U-"),
               QStringLiteral("['가','C','C']@2 new U-"),
               QStringLiteral("['가','C','C']@2 same U- stay null")};
    QTest::newRow("R09 random seed 20261101 limit none")
        << QStringLiteral("A") << QStringLiteral("c-1:B p2:가나 p:C p: r c:가 c:A p:C p:B c-1:C p:C p:가 r p:C u p:가나 c:C p:가")
        << QStringList{
               QStringLiteral("['A','B']@1 new U-"),
               QStringLiteral("['B','가나']@1 new U-"),
               QStringLiteral("['B','가나','C']@2 new U-"),
               QStringLiteral("['B','가나','C','']@3 new U-"),
               QStringLiteral("['B','가나','C','']@3 same U- stay null"),
               QStringLiteral("['B','가나','C','가']@3 new U-"),
               QStringLiteral("['B','가나','C','A']@3 new U-"),
               QStringLiteral("['B','가나','C','A','C']@4 new U-"),
               QStringLiteral("['B','가나','C','A','C','B']@5 new U-"),
               QStringLiteral("['B','가나','C','A','C','C']@5 new U-"),
               QStringLiteral("['B','가나','C','A','C','C']@5 same U-"),
               QStringLiteral("['B','가나','C','A','C','C','가']@6 new U-"),
               QStringLiteral("['B','가나','C','A','C','C','가']@6 same U- stay null"),
               QStringLiteral("['B','가나','C','A','C','C','가','C']@7 new U-"),
               QStringLiteral("['B','가나','C','A','C','C','가','C']@6 new UR moved '가'"),
               QStringLiteral("['B','가나','C','A','C','C','가','가나']@7 new U-"),
               QStringLiteral("['B','가나','C','A','C','C','가','C']@7 new U-"),
               QStringLiteral("['B','가나','C','A','C','C','가','C','가']@8 new U-")};
    QTest::newRow("R10 random seed 20261101 limit 1")
        << QStringLiteral("B") << QStringLiteral("r r p1:B p1:C r c1: c5: u p1:AB r u p1:B p1:가 p1:")
        << QStringList{
               QStringLiteral("['B']@0 same -- stay null"),
               QStringLiteral("['B']@0 same -- stay null"),
               QStringLiteral("['B']@0 same --"),
               QStringLiteral("['C']@0 new --"),
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['']@0 new --"),
               QStringLiteral("['']@0 same --"),
               QStringLiteral("['']@0 same -- stay null"),
               QStringLiteral("['AB']@0 new --"),
               QStringLiteral("['AB']@0 same -- stay null"),
               QStringLiteral("['AB']@0 same -- stay null"),
               QStringLiteral("['B']@0 new --"),
               QStringLiteral("['가']@0 new --"),
               QStringLiteral("['']@0 new --")};
    QTest::newRow("R11 random seed 20261101 limit 1")
        << QStringLiteral("A") << QStringLiteral("r c1:A r r u p1: c1:C p1:가나 p1:AB u u c: p1:AB u p1:가나")
        << QStringList{
               QStringLiteral("['A']@0 same -- stay null"),
               QStringLiteral("['A']@0 same --"),
               QStringLiteral("['A']@0 same -- stay null"),
               QStringLiteral("['A']@0 same -- stay null"),
               QStringLiteral("['A']@0 same -- stay null"),
               QStringLiteral("['']@0 new --"),
               QStringLiteral("['C']@0 new --"),
               QStringLiteral("['가나']@0 new --"),
               QStringLiteral("['AB']@0 new --"),
               QStringLiteral("['AB']@0 same -- stay null"),
               QStringLiteral("['AB']@0 same -- stay null"),
               QStringLiteral("['AB','']@1 new U-"),
               QStringLiteral("['AB']@0 new --"),
               QStringLiteral("['AB']@0 same -- stay null"),
               QStringLiteral("['가나']@0 new --")};
    QTest::newRow("R12 random seed 20261101 limit 1")
        << QStringLiteral("AB") << QStringLiteral("p1:AB u c1:C c1:A p1:가나 p1:가 c1:B p:가나 p1:B u c1:C u c1:A u u p1: r p1:AB")
        << QStringList{
               QStringLiteral("['AB']@0 same --"),
               QStringLiteral("['AB']@0 same -- stay null"),
               QStringLiteral("['C']@0 new --"),
               QStringLiteral("['A']@0 new --"),
               QStringLiteral("['가나']@0 new --"),
               QStringLiteral("['가']@0 new --"),
               QStringLiteral("['B']@0 new --"),
               QStringLiteral("['B','가나']@1 new U-"),
               QStringLiteral("['B']@0 new --"),
               QStringLiteral("['B']@0 same -- stay null"),
               QStringLiteral("['C']@0 new --"),
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['A']@0 new --"),
               QStringLiteral("['A']@0 same -- stay null"),
               QStringLiteral("['A']@0 same -- stay null"),
               QStringLiteral("['']@0 new --"),
               QStringLiteral("['']@0 same -- stay null"),
               QStringLiteral("['AB']@0 new --")};
    QTest::newRow("R13 random seed 20261101 limit none")
        << QStringLiteral("AB") << QStringLiteral("p:가 c: c:가 r c-1:가나 r c:가 u p:가 p:B p:C u p:B c:가나")
        << QStringList{
               QStringLiteral("['AB','가']@1 new U-"),
               QStringLiteral("['AB','']@1 new U-"),
               QStringLiteral("['AB','가']@1 new U-"),
               QStringLiteral("['AB','가']@1 same U- stay null"),
               QStringLiteral("['AB','가나']@1 new U-"),
               QStringLiteral("['AB','가나']@1 same U- stay null"),
               QStringLiteral("['AB','가']@1 new U-"),
               QStringLiteral("['AB','가']@0 new -R moved 'AB'"),
               QStringLiteral("['AB','가']@1 new U-"),
               QStringLiteral("['AB','가','B']@2 new U-"),
               QStringLiteral("['AB','가','B','C']@3 new U-"),
               QStringLiteral("['AB','가','B','C']@2 new UR moved 'B'"),
               QStringLiteral("['AB','가','B','C']@2 same UR"),
               QStringLiteral("['AB','가','B','가나']@3 new U-")};
    QTest::newRow("R14 random seed 20261101 limit none")
        << QStringLiteral("가나") << QStringLiteral("u p:B u p:AB u c:B p: c:A p:C r p:가나 p:C c:AB")
        << QStringList{
               QStringLiteral("['가나']@0 same -- stay null"),
               QStringLiteral("['가나','B']@1 new U-"),
               QStringLiteral("['가나','B']@0 new -R moved '가나'"),
               QStringLiteral("['가나','AB']@1 new U-"),
               QStringLiteral("['가나','AB']@0 new -R moved '가나'"),
               QStringLiteral("['가나','B']@1 new U-"),
               QStringLiteral("['가나','B','']@2 new U-"),
               QStringLiteral("['가나','B','A']@2 new U-"),
               QStringLiteral("['가나','B','A','C']@3 new U-"),
               QStringLiteral("['가나','B','A','C']@3 same U- stay null"),
               QStringLiteral("['가나','B','A','C','가나']@4 new U-"),
               QStringLiteral("['가나','B','A','C','가나','C']@5 new U-"),
               QStringLiteral("['가나','B','A','C','가나','AB']@5 new U-")};
    QTest::newRow("R15 random seed 20261101 limit 2")
        << QStringLiteral("C") << QStringLiteral("u r r r p2:C c5:C c2:C p2: c2:가나 p2:가 u c2: u c2: p2:가 c2:C c2:가 c2:C c2:A")
        << QStringList{
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['C']@0 same --"),
               QStringLiteral("['C']@0 same --"),
               QStringLiteral("['C']@0 same --"),
               QStringLiteral("['C','']@1 new U-"),
               QStringLiteral("['C','가나']@1 new U-"),
               QStringLiteral("['가나','가']@1 new U-"),
               QStringLiteral("['가나','가']@0 new -R moved '가나'"),
               QStringLiteral("['가나','']@1 new U-"),
               QStringLiteral("['가나','']@0 new -R moved '가나'"),
               QStringLiteral("['가나','']@1 new U-"),
               QStringLiteral("['','가']@1 new U-"),
               QStringLiteral("['','C']@1 new U-"),
               QStringLiteral("['','가']@1 new U-"),
               QStringLiteral("['','C']@1 new U-"),
               QStringLiteral("['','A']@1 new U-")};
    QTest::newRow("R16 random seed 20261101 limit none")
        << QStringLiteral("C") << QStringLiteral("u p:AB u r u c:가 p:A p-1:가나 c:B c5:가 r r p5: c-1:A c5:B p:")
        << QStringList{
               QStringLiteral("['C']@0 same -- stay null"),
               QStringLiteral("['C','AB']@1 new U-"),
               QStringLiteral("['C','AB']@0 new -R moved 'C'"),
               QStringLiteral("['C','AB']@1 new U- moved 'AB'"),
               QStringLiteral("['C','AB']@0 new -R moved 'C'"),
               QStringLiteral("['C','가']@1 new U-"),
               QStringLiteral("['C','가','A']@2 new U-"),
               QStringLiteral("['C','가','A','가나']@3 new U-"),
               QStringLiteral("['C','가','A','B']@3 new U-"),
               QStringLiteral("['C','가','A','가']@3 new U-"),
               QStringLiteral("['C','가','A','가']@3 same U- stay null"),
               QStringLiteral("['C','가','A','가']@3 same U- stay null"),
               QStringLiteral("['C','가','A','가','']@4 new U-"),
               QStringLiteral("['C','가','A','가','A']@4 new U-"),
               QStringLiteral("['C','가','A','가','B']@4 new U-"),
               QStringLiteral("['C','가','A','가','B','']@5 new U-")};
}

void EditorHistoryTest::replaysTheWebScripts()
{
    QFETCH(QString, initial);
    QFETCH(QString, script);
    QFETCH(QStringList, trace);
    const QStringList ops = script.split(QLatin1Char(' '));
    QCOMPARE(ops.size(), trace.size());

    History h = editor::createHistory(initial);
    for (qsizetype i = 0; i < ops.size(); ++i) {
        QVERIFY2(isWellFormed(h), qPrintable(QStringLiteral("before op %1: %2").arg(i).arg(stateOf(h))));
        const QString &op = ops.at(i);
        QString actual;
        if (op == QLatin1String("u") || op == QLatin1String("r")) {
            const HistoryMove moved = op == QLatin1String("u") ? editor::undo(h) : editor::redo(h);
            actual = moveTrace(h, moved);
            h = moved.history;
        } else {
            const qsizetype colon = op.indexOf(QLatin1Char(':'));
            QVERIFY2(colon >= 1 && (op.at(0) == QLatin1Char('p') || op.at(0) == QLatin1Char('c')), qPrintable(op));
            const QString limitText = op.mid(1, colon - 1);
            bool ok = true;
            const int limit = limitText.isEmpty() ? 0 : limitText.toInt(&ok); // no digits: no limit option
            QVERIFY2(ok, qPrintable(op));
            const History next = editor::pushHistory(h, op.mid(colon + 1), op.at(0) == QLatin1Char('c'), limit);
            actual = pushTrace(h, next);
            h = next;
        }
        QVERIFY2(actual == trace.at(i),
                 qPrintable(QStringLiteral("op %1 \"%2\": port %3 | web %4").arg(i).arg(op, actual, trace.at(i))));
    }
}

// The body is an opaque string. Bodies that differ in code units only - whitespace, key order or a \u escape in
// the markup, a legacy text and its markup ("(norm)": serialize(deserialize(x)) would make the two equal), CRLF,
// NFC / NFD, a leading U+FEFF, NBSP, U+200B, a lone surrogate against U+FFFD - are separate snapshots; equal bodies
// are a no-op; the null QString is the empty string. Asked on the push path and on the coalescing path, and undo /
// redo must hand back exactly the strings stored.
void EditorHistoryTest::neverNormalizesTheBody_data()
{
    QTest::addColumn<QString>("current");
    QTest::addColumn<QString>("next");
    QTest::addColumn<int>("currentUnits"); // UTF-16 lengths per node - the literals survived construction
    QTest::addColumn<int>("nextUnits");
    QTest::addColumn<bool>("noop"); // web: pushHistory(createHistory(current), next) is its input
    QTest::addColumn<QString>("stored"); // web: the current entry afterwards

    QTest::newRow("O01 markup identical")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 102 << 102
        << true << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("O02 markup with whitespace (norm)")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << QStringLiteral("{\n \"format\": \"yh-editor\",\n \"version\": 1,\n \"blocks\": [\n  {\n   \"type\": \"text\",\n   \"text\": \"본문\"\n  },\n  {\n   \"type\": \"text\",\n   \"text\": \"(끝)\"\n  }\n ]\n}") << 102 << 146
        << false << QStringLiteral("{\n \"format\": \"yh-editor\",\n \"version\": 1,\n \"blocks\": [\n  {\n   \"type\": \"text\",\n   \"text\": \"본문\"\n  },\n  {\n   \"type\": \"text\",\n   \"text\": \"(끝)\"\n  }\n ]\n}");
    QTest::newRow("O03 markup with another key order (norm)")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << QStringLiteral("{\"version\":1,\"format\":\"yh-editor\",\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 102 << 102
        << false << QStringLiteral("{\"version\":1,\"format\":\"yh-editor\",\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("O04 markup with a unicode escape (norm)")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\\ubcf8\\ubb38\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 102 << 112
        << false << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\\ubcf8\\ubb38\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}");
    QTest::newRow("O05 markup with trailing whitespace (norm)")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]} ") << 102 << 103
        << false << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]} ");
    QTest::newRow("O06 legacy text and its markup (norm)")
        << QStringLiteral("A\nB") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"A\"},{\"type\":\"text\",\"text\":\"B\"}]}") << 3 << 99
        << false << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"A\"},{\"type\":\"text\",\"text\":\"B\"}]}");
    QTest::newRow("O07 empty string and empty markup (norm)")
        << QStringLiteral("") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}") << 0 << 46
        << false << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[]}");
    QTest::newRow("O08 web yh-editor object identical")
        << QStringLiteral("{\"format\":\"yh-editor\"}") << QStringLiteral("{\"format\":\"yh-editor\"}") << 22 << 22
        << true << QStringLiteral("{\"format\":\"yh-editor\"}");
    QTest::newRow("O09 web yh-editor object with a version")
        << QStringLiteral("{\"format\":\"yh-editor\"}") << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1}") << 22 << 34
        << false << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1}");
    QTest::newRow("O10 CRLF and LF")
        << QStringLiteral("A\r\nB") << QStringLiteral("A\nB") << 4 << 3
        << false << QStringLiteral("A\nB");
    QTest::newRow("O11 NFC and NFD Hangul")
        << QStringLiteral("가") << QStringLiteral("\u1100\u1161") << 1 << 2
        << false << QStringLiteral("\u1100\u1161");
    QTest::newRow("O12 letter case")
        << QStringLiteral("a") << QStringLiteral("A") << 1 << 1
        << false << QStringLiteral("A");
    QTest::newRow("O13 trailing space")
        << QStringLiteral("A") << QStringLiteral("A ") << 1 << 2
        << false << QStringLiteral("A ");
    QTest::newRow("O14 trailing newline")
        << QStringLiteral("A") << QStringLiteral("A\n") << 1 << 2
        << false << QStringLiteral("A\n");
    QTest::newRow("O15 leading BOM")
        << QStringLiteral("A") << QStringLiteral("\uFEFFA") << 1 << 2
        << false << QStringLiteral("\uFEFFA");
    QTest::newRow("O16 marker with a trailing space")
        << QStringLiteral("본문\n(끝)") << QStringLiteral("본문\n(끝) ") << 6 << 7
        << false << QStringLiteral("본문\n(끝) ");
    QTest::newRow("O17 NBSP and space")
        << QStringLiteral("A B") << QStringLiteral("A\u00A0B") << 3 << 3
        << false << QStringLiteral("A\u00A0B");
    QTest::newRow("O18 zero width space")
        << QStringLiteral("AB") << QStringLiteral("A\u200BB") << 2 << 3
        << false << QStringLiteral("A\u200BB");
    QTest::newRow("O19 lone surrogate identical")
        << units({0xD800}) << units({0xD800}) << 1 << 1
        << true << units({0xD800});
    QTest::newRow("O20 lone surrogate and U+FFFD")
        << units({0xD800}) << QStringLiteral("\uFFFD") << 1 << 1
        << false << QStringLiteral("\uFFFD");
    QTest::newRow("O21 astral identical")
        << QStringLiteral("\U0001F600") << QStringLiteral("\U0001F600") << 2 << 2
        << true << QStringLiteral("\U0001F600");
    QTest::newRow("O22 empty and space")
        << QStringLiteral("") << QStringLiteral(" ") << 0 << 1
        << false << QStringLiteral(" ");
    QTest::newRow("O23 null onto empty")
        << QStringLiteral("") << QString() << 0 << 0
        << true << QStringLiteral("");
    QTest::newRow("O24 null onto text")
        << QStringLiteral("A") << QString() << 1 << 0
        << false << QStringLiteral("");
}

void EditorHistoryTest::neverNormalizesTheBody()
{
    QFETCH(QString, current);
    QFETCH(QString, next);
    QFETCH(int, currentUnits);
    QFETCH(int, nextUnits);
    QFETCH(bool, noop);
    QFETCH(QString, stored);
    QCOMPARE(current.size(), currentUnits);
    QCOMPARE(next.size(), nextUnits);

    const History h = editor::createHistory(current);
    QCOMPARE(h.entries, QStringList{current});

    const History pushed = editor::pushHistory(h, next);
    QCOMPARE(pushed == h, noop);
    QCOMPARE(pushed.entries.size(), noop ? 1 : 2);
    QCOMPARE(pushed.index, noop ? 0 : 1);
    QCOMPARE(pushed.entries.at(pushed.index), stored);
    QVERIFY(!pushed.entries.at(pushed.index).isNull()); // the web's String(body ?? '')

    // The coalescing path asks the same question, on top of [baseline, current].
    const History top = editor::pushHistory(editor::createHistory(QStringLiteral("baseline")), current);
    QCOMPARE(top.entries, (QStringList{QStringLiteral("baseline"), current}));
    const History coalesced = editor::pushHistory(top, next, true);
    QCOMPARE(coalesced == top, noop);
    QCOMPARE(coalesced.entries, (QStringList{QStringLiteral("baseline"), stored}));
    QCOMPARE(coalesced.index, 1);

    if (!noop) {
        const HistoryMove back = editor::undo(pushed);
        QCOMPARE(back.body, restored(current));
        const HistoryMove forward = editor::redo(back.history);
        QCOMPARE(forward.body, restored(stored));
    }
}

// The limit, swept up to the production value (WriterPage.jsx HISTORY_LIMIT = 100) and past it: b1..bn pushed onto
// createHistory("b0") with one limit. Only the oldest entries go - the baseline b0 survives 99 pushes under 100 and
// the 100th drops it; undo then reaches exactly the oldest entry kept; a coalesced push at the top never cuts (at
// the baseline it is a push, and under limit 1 that push is cut back to one entry). Limit 0 and -1 are no limit.
void EditorHistoryTest::limitDropsOnlyTheOldest_data()
{
    QTest::addColumn<int>("limit");
    QTest::addColumn<int>("pushes");
    QTest::addColumn<int>("length");
    QTest::addColumn<int>("index");
    QTest::addColumn<QString>("first");
    QTest::addColumn<QString>("last");
    QTest::addColumn<int>("undoDepth"); // undos until canUndo is false
    QTest::addColumn<int>("coalescedLength"); // then one coalesced push of "b<n>x"
    QTest::addColumn<int>("coalescedIndex");
    QTest::addColumn<QString>("coalescedFirst");
    QTest::addColumn<QString>("coalescedCurrent");

    QTest::newRow("limit -1 pushes 0")
        << -1 << 0 << 1 << 0 << QStringLiteral("b0") << QStringLiteral("b0") << 0
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b0x");
    QTest::newRow("limit -1 pushes 1")
        << -1 << 1 << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1") << 1
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1x");
    QTest::newRow("limit -1 pushes 2")
        << -1 << 2 << 3 << 2 << QStringLiteral("b0") << QStringLiteral("b2") << 2
        << 3 << 2 << QStringLiteral("b0") << QStringLiteral("b2x");
    QTest::newRow("limit -1 pushes 3")
        << -1 << 3 << 4 << 3 << QStringLiteral("b0") << QStringLiteral("b3") << 3
        << 4 << 3 << QStringLiteral("b0") << QStringLiteral("b3x");
    QTest::newRow("limit -1 pushes 4")
        << -1 << 4 << 5 << 4 << QStringLiteral("b0") << QStringLiteral("b4") << 4
        << 5 << 4 << QStringLiteral("b0") << QStringLiteral("b4x");
    QTest::newRow("limit -1 pushes 99")
        << -1 << 99 << 100 << 99 << QStringLiteral("b0") << QStringLiteral("b99") << 99
        << 100 << 99 << QStringLiteral("b0") << QStringLiteral("b99x");
    QTest::newRow("limit -1 pushes 100")
        << -1 << 100 << 101 << 100 << QStringLiteral("b0") << QStringLiteral("b100") << 100
        << 101 << 100 << QStringLiteral("b0") << QStringLiteral("b100x");
    QTest::newRow("limit -1 pushes 101")
        << -1 << 101 << 102 << 101 << QStringLiteral("b0") << QStringLiteral("b101") << 101
        << 102 << 101 << QStringLiteral("b0") << QStringLiteral("b101x");
    QTest::newRow("limit -1 pushes 150")
        << -1 << 150 << 151 << 150 << QStringLiteral("b0") << QStringLiteral("b150") << 150
        << 151 << 150 << QStringLiteral("b0") << QStringLiteral("b150x");
    QTest::newRow("limit 0 pushes 0")
        << 0 << 0 << 1 << 0 << QStringLiteral("b0") << QStringLiteral("b0") << 0
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b0x");
    QTest::newRow("limit 0 pushes 1")
        << 0 << 1 << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1") << 1
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1x");
    QTest::newRow("limit 0 pushes 2")
        << 0 << 2 << 3 << 2 << QStringLiteral("b0") << QStringLiteral("b2") << 2
        << 3 << 2 << QStringLiteral("b0") << QStringLiteral("b2x");
    QTest::newRow("limit 0 pushes 3")
        << 0 << 3 << 4 << 3 << QStringLiteral("b0") << QStringLiteral("b3") << 3
        << 4 << 3 << QStringLiteral("b0") << QStringLiteral("b3x");
    QTest::newRow("limit 0 pushes 4")
        << 0 << 4 << 5 << 4 << QStringLiteral("b0") << QStringLiteral("b4") << 4
        << 5 << 4 << QStringLiteral("b0") << QStringLiteral("b4x");
    QTest::newRow("limit 0 pushes 99")
        << 0 << 99 << 100 << 99 << QStringLiteral("b0") << QStringLiteral("b99") << 99
        << 100 << 99 << QStringLiteral("b0") << QStringLiteral("b99x");
    QTest::newRow("limit 0 pushes 100")
        << 0 << 100 << 101 << 100 << QStringLiteral("b0") << QStringLiteral("b100") << 100
        << 101 << 100 << QStringLiteral("b0") << QStringLiteral("b100x");
    QTest::newRow("limit 0 pushes 101")
        << 0 << 101 << 102 << 101 << QStringLiteral("b0") << QStringLiteral("b101") << 101
        << 102 << 101 << QStringLiteral("b0") << QStringLiteral("b101x");
    QTest::newRow("limit 0 pushes 150")
        << 0 << 150 << 151 << 150 << QStringLiteral("b0") << QStringLiteral("b150") << 150
        << 151 << 150 << QStringLiteral("b0") << QStringLiteral("b150x");
    QTest::newRow("limit 1 pushes 0")
        << 1 << 0 << 1 << 0 << QStringLiteral("b0") << QStringLiteral("b0") << 0
        << 1 << 0 << QStringLiteral("b0x") << QStringLiteral("b0x");
    QTest::newRow("limit 1 pushes 1")
        << 1 << 1 << 1 << 0 << QStringLiteral("b1") << QStringLiteral("b1") << 0
        << 1 << 0 << QStringLiteral("b1x") << QStringLiteral("b1x");
    QTest::newRow("limit 1 pushes 2")
        << 1 << 2 << 1 << 0 << QStringLiteral("b2") << QStringLiteral("b2") << 0
        << 1 << 0 << QStringLiteral("b2x") << QStringLiteral("b2x");
    QTest::newRow("limit 1 pushes 3")
        << 1 << 3 << 1 << 0 << QStringLiteral("b3") << QStringLiteral("b3") << 0
        << 1 << 0 << QStringLiteral("b3x") << QStringLiteral("b3x");
    QTest::newRow("limit 1 pushes 4")
        << 1 << 4 << 1 << 0 << QStringLiteral("b4") << QStringLiteral("b4") << 0
        << 1 << 0 << QStringLiteral("b4x") << QStringLiteral("b4x");
    QTest::newRow("limit 1 pushes 99")
        << 1 << 99 << 1 << 0 << QStringLiteral("b99") << QStringLiteral("b99") << 0
        << 1 << 0 << QStringLiteral("b99x") << QStringLiteral("b99x");
    QTest::newRow("limit 1 pushes 100")
        << 1 << 100 << 1 << 0 << QStringLiteral("b100") << QStringLiteral("b100") << 0
        << 1 << 0 << QStringLiteral("b100x") << QStringLiteral("b100x");
    QTest::newRow("limit 1 pushes 101")
        << 1 << 101 << 1 << 0 << QStringLiteral("b101") << QStringLiteral("b101") << 0
        << 1 << 0 << QStringLiteral("b101x") << QStringLiteral("b101x");
    QTest::newRow("limit 1 pushes 150")
        << 1 << 150 << 1 << 0 << QStringLiteral("b150") << QStringLiteral("b150") << 0
        << 1 << 0 << QStringLiteral("b150x") << QStringLiteral("b150x");
    QTest::newRow("limit 2 pushes 0")
        << 2 << 0 << 1 << 0 << QStringLiteral("b0") << QStringLiteral("b0") << 0
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b0x");
    QTest::newRow("limit 2 pushes 1")
        << 2 << 1 << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1") << 1
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1x");
    QTest::newRow("limit 2 pushes 2")
        << 2 << 2 << 2 << 1 << QStringLiteral("b1") << QStringLiteral("b2") << 1
        << 2 << 1 << QStringLiteral("b1") << QStringLiteral("b2x");
    QTest::newRow("limit 2 pushes 3")
        << 2 << 3 << 2 << 1 << QStringLiteral("b2") << QStringLiteral("b3") << 1
        << 2 << 1 << QStringLiteral("b2") << QStringLiteral("b3x");
    QTest::newRow("limit 2 pushes 4")
        << 2 << 4 << 2 << 1 << QStringLiteral("b3") << QStringLiteral("b4") << 1
        << 2 << 1 << QStringLiteral("b3") << QStringLiteral("b4x");
    QTest::newRow("limit 2 pushes 99")
        << 2 << 99 << 2 << 1 << QStringLiteral("b98") << QStringLiteral("b99") << 1
        << 2 << 1 << QStringLiteral("b98") << QStringLiteral("b99x");
    QTest::newRow("limit 2 pushes 100")
        << 2 << 100 << 2 << 1 << QStringLiteral("b99") << QStringLiteral("b100") << 1
        << 2 << 1 << QStringLiteral("b99") << QStringLiteral("b100x");
    QTest::newRow("limit 2 pushes 101")
        << 2 << 101 << 2 << 1 << QStringLiteral("b100") << QStringLiteral("b101") << 1
        << 2 << 1 << QStringLiteral("b100") << QStringLiteral("b101x");
    QTest::newRow("limit 2 pushes 150")
        << 2 << 150 << 2 << 1 << QStringLiteral("b149") << QStringLiteral("b150") << 1
        << 2 << 1 << QStringLiteral("b149") << QStringLiteral("b150x");
    QTest::newRow("limit 3 pushes 0")
        << 3 << 0 << 1 << 0 << QStringLiteral("b0") << QStringLiteral("b0") << 0
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b0x");
    QTest::newRow("limit 3 pushes 1")
        << 3 << 1 << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1") << 1
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1x");
    QTest::newRow("limit 3 pushes 2")
        << 3 << 2 << 3 << 2 << QStringLiteral("b0") << QStringLiteral("b2") << 2
        << 3 << 2 << QStringLiteral("b0") << QStringLiteral("b2x");
    QTest::newRow("limit 3 pushes 3")
        << 3 << 3 << 3 << 2 << QStringLiteral("b1") << QStringLiteral("b3") << 2
        << 3 << 2 << QStringLiteral("b1") << QStringLiteral("b3x");
    QTest::newRow("limit 3 pushes 4")
        << 3 << 4 << 3 << 2 << QStringLiteral("b2") << QStringLiteral("b4") << 2
        << 3 << 2 << QStringLiteral("b2") << QStringLiteral("b4x");
    QTest::newRow("limit 3 pushes 99")
        << 3 << 99 << 3 << 2 << QStringLiteral("b97") << QStringLiteral("b99") << 2
        << 3 << 2 << QStringLiteral("b97") << QStringLiteral("b99x");
    QTest::newRow("limit 3 pushes 100")
        << 3 << 100 << 3 << 2 << QStringLiteral("b98") << QStringLiteral("b100") << 2
        << 3 << 2 << QStringLiteral("b98") << QStringLiteral("b100x");
    QTest::newRow("limit 3 pushes 101")
        << 3 << 101 << 3 << 2 << QStringLiteral("b99") << QStringLiteral("b101") << 2
        << 3 << 2 << QStringLiteral("b99") << QStringLiteral("b101x");
    QTest::newRow("limit 3 pushes 150")
        << 3 << 150 << 3 << 2 << QStringLiteral("b148") << QStringLiteral("b150") << 2
        << 3 << 2 << QStringLiteral("b148") << QStringLiteral("b150x");
    QTest::newRow("limit 100 pushes 0")
        << 100 << 0 << 1 << 0 << QStringLiteral("b0") << QStringLiteral("b0") << 0
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b0x");
    QTest::newRow("limit 100 pushes 1")
        << 100 << 1 << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1") << 1
        << 2 << 1 << QStringLiteral("b0") << QStringLiteral("b1x");
    QTest::newRow("limit 100 pushes 2")
        << 100 << 2 << 3 << 2 << QStringLiteral("b0") << QStringLiteral("b2") << 2
        << 3 << 2 << QStringLiteral("b0") << QStringLiteral("b2x");
    QTest::newRow("limit 100 pushes 3")
        << 100 << 3 << 4 << 3 << QStringLiteral("b0") << QStringLiteral("b3") << 3
        << 4 << 3 << QStringLiteral("b0") << QStringLiteral("b3x");
    QTest::newRow("limit 100 pushes 4")
        << 100 << 4 << 5 << 4 << QStringLiteral("b0") << QStringLiteral("b4") << 4
        << 5 << 4 << QStringLiteral("b0") << QStringLiteral("b4x");
    QTest::newRow("limit 100 pushes 99")
        << 100 << 99 << 100 << 99 << QStringLiteral("b0") << QStringLiteral("b99") << 99
        << 100 << 99 << QStringLiteral("b0") << QStringLiteral("b99x");
    QTest::newRow("limit 100 pushes 100")
        << 100 << 100 << 100 << 99 << QStringLiteral("b1") << QStringLiteral("b100") << 99
        << 100 << 99 << QStringLiteral("b1") << QStringLiteral("b100x");
    QTest::newRow("limit 100 pushes 101")
        << 100 << 101 << 100 << 99 << QStringLiteral("b2") << QStringLiteral("b101") << 99
        << 100 << 99 << QStringLiteral("b2") << QStringLiteral("b101x");
    QTest::newRow("limit 100 pushes 150")
        << 100 << 150 << 100 << 99 << QStringLiteral("b51") << QStringLiteral("b150") << 99
        << 100 << 99 << QStringLiteral("b51") << QStringLiteral("b150x");
}

void EditorHistoryTest::limitDropsOnlyTheOldest()
{
    QFETCH(int, limit);
    QFETCH(int, pushes);
    QFETCH(int, length);
    QFETCH(int, index);
    QFETCH(QString, first);
    QFETCH(QString, last);
    QFETCH(int, undoDepth);
    QFETCH(int, coalescedLength);
    QFETCH(int, coalescedIndex);
    QFETCH(QString, coalescedFirst);
    QFETCH(QString, coalescedCurrent);

    History h = editor::createHistory(QStringLiteral("b0"));
    for (int i = 1; i <= pushes; ++i) {
        h = editor::pushHistory(h, QStringLiteral("b%1").arg(i), false, limit);
        QVERIFY2(isWellFormed(h), qPrintable(QStringLiteral("after push %1: %2 entries, index %3")
                                                 .arg(i).arg(h.entries.size()).arg(h.index)));
    }
    QCOMPARE(h.entries.size(), length);
    QCOMPARE(h.index, index);
    QCOMPARE(h.entries.first(), first);
    QCOMPARE(h.entries.last(), last);

    int depth = 0;
    History down = h;
    while (editor::canUndo(down) && depth <= pushes) { // bounded - a broken canUndo must not spin
        down = editor::undo(down).history;
        ++depth;
    }
    QCOMPARE(depth, undoDepth);
    QCOMPARE(down.index, 0);
    QCOMPARE(down.entries.first(), first);

    const History coalesced = editor::pushHistory(h, QStringLiteral("b%1x").arg(pushes), true, limit);
    QVERIFY(isWellFormed(coalesced));
    QCOMPARE(coalesced.entries.size(), coalescedLength);
    QCOMPARE(coalesced.index, coalescedIndex);
    QCOMPARE(coalesced.entries.first(), coalescedFirst);
    QCOMPARE(coalesced.entries.at(coalesced.index), coalescedCurrent);
}

// A default-constructed History is createHistory(QString()) - the baseline of an empty document - so a value that
// exists before any document is opened is already one every function accepts.
void EditorHistoryTest::aDefaultHistoryIsTheEmptyBaseline()
{
    const History h{};
    QVERIFY(h == editor::createHistory(QString()));
    QCOMPARE(h.entries, QStringList{QStringLiteral("")});
    QVERIFY(!h.entries.at(0).isNull());
    QCOMPARE(h.index, 0);
    QVERIFY(!editor::canUndo(h));
    QVERIFY(!editor::canRedo(h));
    const History typed = editor::pushHistory(h, QStringLiteral("A"), true);
    QCOMPARE(typed.entries, (QStringList{QStringLiteral(""), QStringLiteral("A")}));
    QCOMPARE(typed.index, 1);
}
