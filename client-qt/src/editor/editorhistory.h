#ifndef CLIENT_QT_EDITOR_EDITORHISTORY_H
#define CLIENT_QT_EDITOR_EDITORHISTORY_H

// Undo / redo history of one document's body (phase 78 step6): a 1:1 port of web/src/view/editorHistory.js - its
// spec, editorHistory.test.js, lives on as tests/editorhistorytest.cpp.
//
// A pure data structure: snapshots of the body string - past, present, future. What it deliberately does not do
// (the web module draws the same lines):
//   - read a clock or run a timer. Coalescing arrives as a bool. The web caller (WriterPage.commitBody) coalesces
//     when this commit is typing AND the previous commit was typing, on the same tab, less than COALESCE_MS = 500 ms
//     ago, and passes limit HISTORY_LIMIT = 100 on every push. That decision, its clock and both constants belong
//     to the state machine (step9), which injects the time.
//   - know keys. Undo / redo are isUndo (Ctrl/Meta+Z) / isRedo (Ctrl/Meta+Shift+Z) of editorshortcuts.h - Ctrl+Y
//     is "(계속)", not redo.
//   - interpret the body. It is an opaque string (the saved markup, serialize's output): no deserialize, no JSON
//     parse, no normalization - two bodies are the same snapshot exactly when their UTF-16 code units are equal
//     (QString ==). Normalizing here would make the same-body test disagree with the bytes that get saved and
//     leave phantom snapshots (the web module's CRITICAL note). The one conversion is the web's
//     String(body ?? ''): the null QString - C++'s null - is stored as the empty string.
//
// Shape { entries, index }: entries[index] is the current body. Invariant: entries[0] - the baseline, the body when
// the document was opened - is never replaced by coalescing; only the limit cut drops it. Every function takes its
// input by const reference and returns a new value. Where the web returns the same object (a no-op), this port
// returns a value equal to its input - and only a no-op does.
//
// One History per open document. It is the only undo stack: the text engine's own (QTextDocument's) stays off
// (step8).

#include <QString>
#include <QStringList>

#include <optional>

namespace editor {

// Made by createHistory / pushHistory / undo / redo, a History always has entries and 0 <= index < entries.size();
// the functions assume that, as the web does. A default-constructed History equals createHistory(QString()) - the
// baseline of an empty document.
struct History {
    QStringList entries{QStringLiteral("")};
    int index = 0;
};

bool operator==(const History &a, const History &b);
inline bool operator!=(const History &a, const History &b) { return !(a == b); }

// The web's { history, body, changed } from undo / redo: body is the body to restore. Nothing to undo / redo is
// { the input, std::nullopt (the web's null), false }.
struct HistoryMove {
    History history;
    std::optional<QString> body;
    bool changed = false;
};

// A one-entry history at the baseline (editorHistory.createHistory) - undo and redo both impossible.
History createHistory(const QString &initialBody);

// The history with nextBody as its current body (editorHistory.pushHistory):
//   - nextBody is the current body: a no-op, the input back (the web's same object - its guard against StrictMode
//     calling twice). Only the current entry counts; a body equal to some other entry is a new snapshot, and the
//     no-op cuts nothing, the redo branch included.
//   - coalesce, at the top (no redo branch) and past the baseline (index > 0): the top is replaced - no growth.
//   - otherwise the redo branch (everything after index) is cut and nextBody pushed. Then, when limit > 0 and the
//     entries exceed it, the oldest go - the baseline first - and index follows them.
// limit <= 0 is no limit (the web's undefined / 0 / negative; its non-integer limits cannot be spelled as an int).
// The limit is applied on the push path only: a coalesced replace does not grow the history, so it never cuts.
History pushHistory(const History &history, const QString &nextBody, bool coalesce = false, int limit = 0);

// One snapshot back / forward (editorHistory.undo / redo).
HistoryMove undo(const History &history);
HistoryMove redo(const History &history);

bool canUndo(const History &history); // index > 0
bool canRedo(const History &history); // index < entries.size() - 1

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORHISTORY_H
