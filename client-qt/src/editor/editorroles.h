#ifndef CLIENT_QT_EDITOR_EDITORROLES_H
#define CLIENT_QT_EDITOR_EDITORROLES_H

// Line roles, role colours and the "(끝)" input gate - the first production module of the editor
// layer (phase 78 step0). Ported from the P0 spike's pure logic (spikes/p0-qt-editor/editorlogic.*,
// frozen - read, never edited), which is itself the Qt twin of two web pure modules:
//   classifyLines / colorForRole  <-> web/src/view/editorColoring.js
//   isInputBlocked                <-> web/src/view/editorNewline.js
//   END_MARKER                    <-> web/src/view/editorContent.js (the same literal)
//
// Widget-independent on purpose (decisions (1)): QString / QColor only, so every rule is locked by
// QtTest without a window. The text engine (step8) calls these; it never re-decides a role or the
// marker itself.
//
// Scope of this step: the spike's rules as they are. step2 compares classifyLines / colorForRole with
// editorColoring.js rule by rule (including how "(끝)" is trimmed - the spike uses QString::trimmed(),
// the canonical uses JS String.prototype.trim(); the two sets of whitespace are not identical), and
// step3 moves isInputBlocked next to the rest of the newline/marker rules.

#include <QColor>
#include <QString>
#include <QStringList>
#include <QVector>

namespace editor {

// "(끝)" - the end-of-article marker (editorContent.js END_MARKER, same literal). The single source
// for the whole editor layer: later modules reuse this, they do not spell the literal again.
extern const QString END_MARKER;

enum class Role { Title, Subtitle, Body, End };

// Lines -> one role per line (editorColoring.classifyLines):
//   - a line whose trimmed text is "(끝)" is End, wherever it sits
//   - line 0 is Title
//   - if the subtitle region (indices 1..4 = web slice(1, 5)) holds an empty line, there is no
//     subtitle: every line from index 1 on is Body (End lines stay End)
//   - otherwise indices 1..4 are Subtitle and 5.. are Body
QVector<Role> classifyLines(const QStringList &lines);

// Role -> colour: Title #0a4da6 / Subtitle #c8102e / Body #1a1a1a / End #d4af37
// (editorColoring.COLORS defaults - user colour preferences are P6).
QColor colorForRole(Role role);

// Whether inserting at caretOffset is refused: blocked when the caret sits at or after the start of
// the LAST "(끝)" marker (lastIndexOf), allowed before it (editorNewline.isInputBlocked). Offsets are
// UTF-16 code units, the same unit as a JS string index (a surrogate pair counts 2). Deleting, moving
// and selecting are never gated by this - removing the marker re-opens input everywhere.
bool isInputBlocked(const QString &text, int caretOffset);

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORROLES_H
