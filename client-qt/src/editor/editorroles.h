#ifndef CLIENT_QT_EDITOR_EDITORROLES_H
#define CLIENT_QT_EDITOR_EDITORROLES_H

// Line roles and role colours - the first production module of the editor layer (phase 78 step0,
// completed against the web canonical in step2). Ported from the P0 spike's pure logic
// (spikes/p0-qt-editor/editorlogic.*, frozen - read, never edited), which is itself the Qt twin of
// web pure modules:
//   classifyLines / colorForRole / COLORS / colorLines / shouldRecolor / RECOLOR_TRIGGERS
//                                 <-> web/src/view/editorColoring.js
//   END_MARKER                    <-> web/src/view/editorContent.js (the same literal)
// The spike's third function, the "(끝)" input gate isInputBlocked (web editorNewline.js), moved to
// editor/editornewline.h in step3, next to the rest of the newline / marker rules.
//
// Widget-independent on purpose (decisions (1)): QString / QColor only, so every rule is locked by
// QtTest without a window. The text engine (step8) calls these; it never re-decides a role or the
// marker itself. Recolouring happens only after an IME commit (decisions (4)) - shouldRecolor is
// the pure half of that rule.
//
// step2 compared this module with editorColoring.js rule by rule (tests/editorcoloringtest.*):
//   - the "(끝)" line is judged with JS String.prototype.trim(), not QString::trimmed() - the two
//     whitespace sets differ on U+0085 (Qt strips, JS does not) and U+FEFF (JS strips, Qt does not)
//   - "blank" in the subtitle region means exactly the empty string (web l === '')
//   - the colour defaults live in COLORS, the single source every colour reader uses
// Not here: the user colour override (web setEditorColors / resetEditorColors) - that is the
// preferences wiring, P6 (index.json excluded (a)).

#include <QColor>
#include <QString>
#include <QStringList>
#include <QVector>

namespace editor {

// "(끝)" - the end-of-article marker (editorContent.js END_MARKER, same literal). The single source
// for the whole editor layer: later modules reuse this, they do not spell the literal again.
extern const QString END_MARKER;

enum class Role { Title, Subtitle, Body, End };

// The default role colours (editorColoring.COLORS): Title #0a4da6 / Subtitle #c8102e /
// Body #1a1a1a / End #d4af37. The single source - colorForRole reads these. User colour
// preferences (title/subtitle/body are overridable on the web, end is not) are P6.
struct EditorColors {
    QColor title;
    QColor subtitle;
    QColor body;
    QColor end;
};
extern const EditorColors COLORS;

// Whether a line is the "(끝)" marker line: its text trimmed the way JS String.prototype.trim()
// trims (ECMAScript WhiteSpace + LineTerminator) equals END_MARKER exactly. The same judgement
// the web applies to marker blocks in editorNewline.js / editorShortcuts.js / editorEditOps.js -
// later steps call this instead of QString::trimmed().
bool isEndLine(const QString &line);

// Lines -> one role per line (editorColoring.classifyLines):
//   - a line that isEndLine is End, wherever it sits
//   - line 0 is Title
//   - if the subtitle region (indices 1..4 = web slice(1, 5)) holds an exactly-empty line, there
//     is no subtitle: every line from index 1 on is Body (End lines stay End)
//   - otherwise indices 1..4 are Subtitle and 5.. are Body
QVector<Role> classifyLines(const QStringList &lines);

// Role -> colour from COLORS; a value outside the enumerators maps to body (web: unknown -> body).
QColor colorForRole(Role role);

// Body text -> one {text, role, color} per line (editorColoring.colorLines). The text is split on
// "\n" alone, like JS split('\n'): "" is one line, "\r" stays in the text, a trailing "\n" yields a
// trailing empty line.
struct ColoredLine {
    QString text;
    Role role;
    QColor color;
};
QVector<ColoredLine> colorLines(const QString &text);

// When recolouring is allowed (editorColoring.shouldRecolor): never while an IME composition is in
// progress; otherwise only on one of RECOLOR_TRIGGERS ("compositionend", "blur", "load"), compared
// exactly. The widget (step8) maps its events onto these names.
extern const QStringList RECOLOR_TRIGGERS;
bool shouldRecolor(const QString &trigger, bool composing = false);

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORROLES_H
