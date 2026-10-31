#include "editor/editorshortcuts.h"

#include "editor/editornewline.h" // isMarkerBlock, renormalizeEndMarker - the step3 marker rules
#include "editor/editorroles.h"   // END_MARKER

#include <QChar>
#include <QLatin1String>

namespace editor {

const QString CONTINUE_MARKER = QStringLiteral("(계속)");

namespace {

bool ctrl(const KeyInput &e) { return e.modifiers.testFlag(Qt::ControlModifier); }
bool alt(const KeyInput &e) { return e.modifiers.testFlag(Qt::AltModifier); }
bool shift(const KeyInput &e) { return e.modifiers.testFlag(Qt::ShiftModifier); }
bool meta(const KeyInput &e) { return e.modifiers.testFlag(Qt::MetaModifier); }

// The web predicates' key test: (e.key === 'y' || e.key === 'Y' || e.code === 'KeyY') - the typed letter in
// either case, or the physical key. The code half is what still recognises the key under Hangul input.
bool isLetter(const KeyInput &e, char lower)
{
    const QChar lo = QLatin1Char(lower);
    const QChar up = lo.toUpper();
    return e.key == QString(lo) || e.key == QString(up) || e.code == QStringLiteral("Key") + up;
}

// QString::toUpper / toLower turn an unpaired surrogate that follows the first changed character into U+FFFD
// (Qt 6.8.3 walks the rest of the string with QStringIterator::next() - measured); JS keeps it. So convert the
// runs between lone surrogates and copy each lone surrogate as it is. A run holds whole code points only, and
// QString's mapping is per code point, so converting runs apart changes nothing else.
template <typename Convert>
QString convertKeepingLoneSurrogates(const QString &s, Convert convert)
{
    QString out;
    qsizetype runStart = 0;
    for (qsizetype i = 0; i < s.size(); ++i) {
        const QChar c = s.at(i);
        if (c.isHighSurrogate() && i + 1 < s.size() && s.at(i + 1).isLowSurrogate()) {
            ++i; // a pair - part of the run
            continue;
        }
        if (!c.isSurrogate())
            continue;
        out += convert(s.mid(runStart, i - runStart));
        out += c; // the lone surrogate, unchanged
        runStart = i + 1;
    }
    out += convert(s.mid(runStart));
    return out;
}

} // namespace

bool operator==(const KeyCombo &a, const KeyCombo &b)
{
    return a.ctrl == b.ctrl && a.alt == b.alt && a.shift == b.shift && a.meta == b.meta && a.key == b.key;
}

// web RESERVED_COMBOS = ['Ctrl+B', 'Ctrl+X', 'Ctrl+C', 'Ctrl+V', 'Alt+V', 'Alt+O', 'Ctrl+F', 'Ctrl+A', 'Ctrl+Y',
// 'Ctrl+Z', 'Ctrl+Shift+Z', 'Ctrl+D', 'Alt+Y'].map(parseKeyCombo) - {ctrl, alt, shift, meta, key}.
const QVector<KeyCombo> RESERVED_COMBOS = {
    {true, false, false, false, QStringLiteral("b")},
    {true, false, false, false, QStringLiteral("x")},
    {true, false, false, false, QStringLiteral("c")},
    {true, false, false, false, QStringLiteral("v")},
    {false, true, false, false, QStringLiteral("v")},
    {false, true, false, false, QStringLiteral("o")},
    {true, false, false, false, QStringLiteral("f")},
    {true, false, false, false, QStringLiteral("a")},
    {true, false, false, false, QStringLiteral("y")},
    {true, false, false, false, QStringLiteral("z")},
    {true, false, true, false, QStringLiteral("z")},
    {true, false, false, false, QStringLiteral("d")},
    {false, true, false, false, QStringLiteral("y")},
};

bool isInsertEndMarker(const KeyInput &e)
{
    return alt(e) && !ctrl(e) && isLetter(e, 'y');
}

bool isDeleteLine(const KeyInput &e)
{
    return ctrl(e) && !alt(e) && isLetter(e, 'd');
}

bool isInsertContinueMarker(const KeyInput &e)
{
    return ctrl(e) && !alt(e) && isLetter(e, 'y');
}

bool isCompanyCode(const KeyInput &e)
{
    return ctrl(e) && !alt(e) && isLetter(e, 'b');
}

bool isToggleOverwrite(const KeyInput &e)
{
    return !ctrl(e) && !alt(e) && !shift(e) && !meta(e)
           && (e.key == QLatin1String("Insert") || e.code == QLatin1String("Insert"));
}

bool isUndo(const KeyInput &e)
{
    return (ctrl(e) || meta(e)) && !alt(e) && !shift(e) && isLetter(e, 'z');
}

bool isRedo(const KeyInput &e)
{
    return (ctrl(e) || meta(e)) && !alt(e) && shift(e) && isLetter(e, 'z');
}

bool isGlyphInput(const KeyInput &e)
{
    return alt(e) && !ctrl(e) && isLetter(e, 'o');
}

bool isPasteOriginal(const KeyInput &e)
{
    return alt(e) && !ctrl(e) && isLetter(e, 'v');
}

bool isFindReplace(const KeyInput &e)
{
    return ctrl(e) && !alt(e) && isLetter(e, 'f');
}

EndMarkerInsertion insertEndMarker(const QVector<Block> &blocks)
{
    const QVector<Block> list = normalizeBlocks(blocks);
    // The step3 substring criterion: any "(끝)" in the text blocks - the input gate is closed at the document
    // end, where the new marker would go.
    if (hasEndMarker(list))
        return EndMarkerInsertion{list, false, true};
    QVector<Block> next = list;
    next.append(textBlock(END_MARKER));
    return EndMarkerInsertion{next, true, true};
}

LineDeletion deleteLineAt(const QVector<Block> &blocks, int index)
{
    const QVector<Block> list = normalizeBlocks(blocks);
    if (index < 0 || index >= list.size())
        return LineDeletion{list, std::nullopt, false};
    const Block removed = list.at(index);
    QVector<Block> next = list;
    next.removeAt(index);
    bool removedEmbed = false;
    // A text line's embed is the embed block right after it - one at a time.
    if (isTextBlock(removed) && index < next.size() && isEmbedBlock(next.at(index))) {
        next.removeAt(index);
        removedEmbed = true;
    }
    return LineDeletion{next, removed, removedEmbed};
}

ContinueMarkerInsertion insertContinueMarker(const QVector<Block> &blocks, std::optional<int> textLineIndex)
{
    const QVector<Block> list = normalizeBlocks(blocks);
    const int blockIndex = textLineIndex ? textLineToBlockIndex(list, *textLineIndex) : -1;
    const qsizetype at = blockIndex < 0 ? list.size() : blockIndex + 1; // fallback: the end
    QVector<Block> next = list;
    next.insert(at, textBlock(CONTINUE_MARKER));
    // renormalizeEndMarker keeps every other block in order and moves the marker lines last, so the new line
    // lands on the text line counted by the non-marker text blocks before it.
    int caretTextLine = 0;
    for (qsizetype i = 0; i < at; ++i) {
        if (isTextBlock(next.at(i)) && !isMarkerBlock(next.at(i)))
            ++caretTextLine;
    }
    return ContinueMarkerInsertion{renormalizeEndMarker(next), caretTextLine};
}

QVector<Block> transformTextLine(const QVector<Block> &blocks, int textLineIndex,
                                 const std::function<QString(const QString &)> &fn)
{
    const QVector<Block> list = normalizeBlocks(blocks);
    const int blockIndex = textLineToBlockIndex(list, textLineIndex);
    if (blockIndex < 0)
        return list;
    QVector<Block> next = list;
    next[blockIndex] = textBlock(fn(list.at(blockIndex).text), list.at(blockIndex).align);
    return next;
}

QString toUpper(const QString &s)
{
    return convertKeepingLoneSurrogates(s, [](const QString &run) { return run.toUpper(); });
}

QString toLower(const QString &s)
{
    return convertKeepingLoneSurrogates(s, [](const QString &run) { return run.toLower(); });
}

QString capitalizeFirst(const QString &s)
{
    return toUpper(s.left(1)) + toLower(s.mid(1)); // JS charAt(0) / slice(1) - code units
}

QString toggleCase(const QString &s)
{
    QString out;
    out.reserve(s.size());
    for (qsizetype i = 0; i < s.size();) {
        // One code point, as JS Array.from yields it: a surrogate pair, or a single unit (a lone surrogate too).
        const qsizetype n = s.at(i).isHighSurrogate() && i + 1 < s.size() && s.at(i + 1).isLowSurrogate() ? 2 : 1;
        const QString ch = s.mid(i, n);
        const QString up = toUpper(ch);
        const QString lo = toLower(ch);
        if (ch == lo && ch != up)
            out += up; // lower -> upper
        else if (ch == up && ch != lo)
            out += lo; // upper -> lower
        else
            out += ch; // no case, or both (title case)
        i += n;
    }
    return out;
}

} // namespace editor
