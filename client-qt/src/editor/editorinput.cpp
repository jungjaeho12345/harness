#include "editor/editorinput.h"

#include "editor/editorshortcuts.h"

#include <QLatin1Char>
#include <QLatin1String>

#include <algorithm>

namespace editor {

// web/src/view/WriterPage.jsx onKeyDown, in its order (EditorInputTest reads the file and compares).
const QStringList SHORTCUT_ORDER{QStringLiteral("isToggleOverwrite"),      QStringLiteral("isCompanyCode"),
                                 QStringLiteral("isFindReplace"),          QStringLiteral("isGlyphInput"),
                                 QStringLiteral("isPasteOriginal"),        QStringLiteral("isInsertEndMarker"),
                                 QStringLiteral("isInsertContinueMarker"), QStringLiteral("isUndo"),
                                 QStringLiteral("isRedo"),                 QStringLiteral("isDeleteLine")};

std::optional<Shortcut> shortcutFor(const KeyInput &e)
{
    // The same order as SHORTCUT_ORDER - the first predicate that fires wins (where a layout makes two fire).
    if (isToggleOverwrite(e))
        return Shortcut::ToggleOverwrite;
    if (isCompanyCode(e))
        return Shortcut::CompanyCode;
    if (isFindReplace(e))
        return Shortcut::FindReplace;
    if (isGlyphInput(e))
        return Shortcut::GlyphInput;
    if (isPasteOriginal(e))
        return Shortcut::PasteOriginal;
    if (isInsertEndMarker(e))
        return Shortcut::InsertEndMarker;
    if (isInsertContinueMarker(e))
        return Shortcut::InsertContinueMarker;
    if (isUndo(e))
        return Shortcut::Undo;
    if (isRedo(e))
        return Shortcut::Redo;
    if (isDeleteLine(e))
        return Shortcut::DeleteLine;
    return std::nullopt;
}

namespace {

// The web KeyboardEvent.code of a Windows set-1 scan code as Qt 6.8.3 reports it (nativeScanCode(): the make code,
// 0xE000 | code for an extended key - measured). Only the physical keys the predicates and the widget can name.
QString codeForScanCode(quint32 scan)
{
    static const char row1[] = "QWERTYUIOP"; // 0x10..0x19
    static const char row2[] = "ASDFGHJKL";  // 0x1E..0x26
    static const char row3[] = "ZXCVBNM";    // 0x2C..0x32
    if (scan >= 0x10 && scan <= 0x19)
        return QStringLiteral("Key") + QLatin1Char(row1[scan - 0x10]);
    if (scan >= 0x1E && scan <= 0x26)
        return QStringLiteral("Key") + QLatin1Char(row2[scan - 0x1E]);
    if (scan >= 0x2C && scan <= 0x32)
        return QStringLiteral("Key") + QLatin1Char(row3[scan - 0x2C]);
    switch (scan) {
    case 0xE052: return QStringLiteral("Insert");
    case 0x52: return QStringLiteral("Numpad0");
    case 0xE053: return QStringLiteral("Delete");
    case 0x53: return QStringLiteral("NumpadDecimal");
    case 0x0E: return QStringLiteral("Backspace");
    case 0x1C: return QStringLiteral("Enter");
    case 0xE01C: return QStringLiteral("NumpadEnter");
    default: return QString();
    }
}

} // namespace

KeyInput keyInputFromQt(int qtKey, Qt::KeyboardModifiers modifiers, quint32 nativeScanCode)
{
    QString key;
    switch (qtKey) {
    case Qt::Key_Insert: key = QStringLiteral("Insert"); break;
    case Qt::Key_Delete: key = QStringLiteral("Delete"); break;
    case Qt::Key_Backspace: key = QStringLiteral("Backspace"); break;
    case Qt::Key_Return:
    case Qt::Key_Enter: key = QStringLiteral("Enter"); break;
    case Qt::Key_Tab: key = QStringLiteral("Tab"); break;
    case Qt::Key_Escape: key = QStringLiteral("Escape"); break;
    default:
        // A printable key: Qt names it by its (upper-case) code point; the web's key is what it types - lower case
        // unless Shift is down. Qt's own keys (>= 0x01000000) are not characters.
        if (qtKey > 0x1F && qtKey <= 0x10FFFF && !(qtKey >= 0xD800 && qtKey <= 0xDFFF)) {
            const char32_t ucs = char32_t(qtKey);
            const QString ch = QChar::requiresSurrogates(ucs)
                                   ? QString(QChar(QChar::highSurrogate(ucs))) + QChar(QChar::lowSurrogate(ucs))
                                   : QString(QChar(char16_t(ucs)));
            if (QChar::isPrint(ucs))
                key = modifiers.testFlag(Qt::ShiftModifier) ? ch.toUpper() : ch.toLower();
        }
        break;
    }
    return KeyInput{modifiers, key, codeForScanCode(nativeScanCode)};
}

bool insertsText(Qt::KeyboardModifiers modifiers, const QString &text)
{
    if (text.isEmpty())
        return false;
    const QChar c = text.at(0);
    if (c.category() == QChar::Other_Format)
        return true; // ZWNJ, ZWJ, RLM... (Windows sometimes types them under Ctrl+Shift)
    if (modifiers == Qt::ControlModifier || modifiers == (Qt::ShiftModifier | Qt::ControlModifier))
        return false; // Ctrl / Ctrl+Shift combinations type nothing (AltGr = Ctrl+Alt does)
    if (c.isPrint())
        return true;
    if (c.category() == QChar::Other_PrivateUse)
        return true;
    if (c.isHighSurrogate() && text.size() > 1 && text.at(1).isLowSurrogate())
        return true;
    return c == QLatin1Char('\t');
}

bool isBlockBreakChar(QChar c)
{
    switch (c.unicode()) {
    case 0x000A: // LF
    case 0x000D: // CR
    case 0x2029: // PARAGRAPH SEPARATOR
    case 0xFDD0: // QTextBeginningOfFrame
    case 0xFDD1: // QTextEndOfFrame
        return true;
    default:
        return false;
    }
}

QString displayLine(const QString &line)
{
    QString out = line;
    for (QChar &c : out) {
        if (!isBlockBreakChar(c))
            continue;
        c = (c.unicode() == 0xFDD0 || c.unicode() == 0xFDD1) ? QChar(QChar::ReplacementCharacter) : QChar(QLatin1Char(' '));
    }
    return out;
}

QVector<Block> joinTextLines(const QVector<Block> &blocks, int upperTextLine)
{
    const QVector<Block> list = normalizeBlocks(blocks);
    const int upper = textLineToBlockIndex(list, upperTextLine);
    const int lower = upperTextLine < 0 ? -1 : textLineToBlockIndex(list, upperTextLine + 1);
    if (upper < 0 || lower < 0)
        return list;
    QVector<Block> out = list.mid(0, upper);
    out.append(textBlock(list.at(upper).text + list.at(lower).text, list.at(upper).align));
    out += list.mid(upper + 1, lower - upper - 1); // the embeds between the two (only embeds lie there)
    out += list.mid(lower + 1);
    return out;
}

std::optional<TextEdit> nativeEditBetween(const QString &before, const QString &after, int selStart, int selEnd,
                                          bool backward)
{
    const qsizetype nb = before.size();
    const qsizetype na = after.size();
    const qsizetype from = std::clamp<qsizetype>(qsizetype(std::min(selStart, selEnd)), 0, nb);
    const qsizetype to = std::clamp<qsizetype>(qsizetype(std::max(selStart, selEnd)), from, nb);
    qsizetype p = 0;
    qsizetype s = 0;
    const auto prefix = [&](qsizetype cap) {
        p = 0;
        while (p < cap && before.at(p) == after.at(p))
            ++p;
    };
    const auto suffix = [&](qsizetype cap) {
        s = 0;
        while (s < cap && before.at(nb - 1 - s) == after.at(na - 1 - s))
            ++s;
    };
    if (!backward) {
        prefix(std::min({from, nb, na})); // the edit starts at the selection start
        if (p != from)
            return std::nullopt;
        suffix(std::min({nb - to, nb - p, na - p}));
    } else {
        suffix(std::min({nb - to, nb, na})); // the edit ends at the cursor
        if (s != nb - to)
            return std::nullopt;
        prefix(std::min({from, nb - s, na - s}));
    }
    return TextEdit{int(p), int(nb - s - p), after.mid(p, na - s - p)};
}

} // namespace editor
