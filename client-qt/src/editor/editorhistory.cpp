#include "editor/editorhistory.h"

#include <algorithm>

namespace editor {

namespace {

// The web's String(body ?? ''): the null QString becomes the empty string. Every other body is kept code unit for
// code unit - there is no other conversion (the body is opaque).
QString coerced(const QString &body)
{
    return body.isNull() ? QStringLiteral("") : body;
}

} // namespace

bool operator==(const History &a, const History &b)
{
    return a.index == b.index && a.entries == b.entries;
}

History createHistory(const QString &initialBody)
{
    return History{QStringList{coerced(initialBody)}, 0};
}

History pushHistory(const History &history, const QString &nextBody, bool coalesce, int limit)
{
    const QString next = coerced(nextBody);
    if (next == history.entries.at(history.index))
        return history; // the current body again - no snapshot
    const bool atTop = history.index == history.entries.size() - 1;
    if (coalesce && atTop && history.index > 0) {
        History replaced = history;
        replaced.entries[replaced.index] = next; // detaches - the input keeps its entries
        return replaced;
    }
    QStringList entries = history.entries.mid(0, history.index + 1); // the redo branch is cut
    entries.append(next);
    int index = static_cast<int>(entries.size()) - 1;
    if (limit > 0 && entries.size() > limit) {
        const int drop = static_cast<int>(entries.size()) - limit;
        entries = entries.mid(drop); // the oldest go - the baseline first
        index = std::max(0, index - drop);
    }
    return History{entries, index};
}

HistoryMove undo(const History &history)
{
    if (!canUndo(history))
        return HistoryMove{history, std::nullopt, false};
    const History moved{history.entries, history.index - 1};
    return HistoryMove{moved, moved.entries.at(moved.index), true};
}

HistoryMove redo(const History &history)
{
    if (!canRedo(history))
        return HistoryMove{history, std::nullopt, false};
    const History moved{history.entries, history.index + 1};
    return HistoryMove{moved, moved.entries.at(moved.index), true};
}

bool canUndo(const History &history)
{
    return history.index > 0;
}

bool canRedo(const History &history)
{
    return history.index < history.entries.size() - 1;
}

} // namespace editor
