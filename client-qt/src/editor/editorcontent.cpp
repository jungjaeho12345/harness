#include "editor/editorcontent.h"

#include "editor/editorroles.h"

#include <QChar>
#include <QLatin1Char>
#include <QLocale>

#include <cmath>

namespace editor {

const QString EDITOR_FORMAT = QStringLiteral("yh-editor");
const QStringList ALIGN_VALUES = {QStringLiteral("left"), QStringLiteral("center"), QStringLiteral("right"),
                                  QStringLiteral("justify")};

namespace {

// Deeper JSON is treated as "not JSON" (header note) - a recursion bound for server-supplied bodies.
constexpr int kMaxDepth = 512;

// ECMA-262 array index: the canonical decimal string of an integer 0 <= n < 2^32 - 1. Such keys come
// first in a JS object's own-property order, ascending.
bool arrayIndexOf(const QString &key, quint32 *index)
{
    if (key.isEmpty() || key.size() > 10)
        return false;
    if (key.size() > 1 && key.at(0) == QLatin1Char('0'))
        return false;
    quint64 value = 0;
    for (const QChar c : key) {
        if (c < QLatin1Char('0') || c > QLatin1Char('9'))
            return false;
        value = value * 10 + quint64(c.unicode() - u'0');
    }
    if (value >= 4294967295ull)
        return false;
    *index = quint32(value);
    return true;
}

// Number.prototype.toString(10) (ECMA-262 Number::toString): the shortest round-trip digits, laid out
// in fixed notation when the decimal exponent is in [-6, 21) and in exponent notation otherwise.
QString jsNumberToString(double value)
{
    if (std::isnan(value))
        return QStringLiteral("NaN");
    if (value == 0)
        return QStringLiteral("0"); // -0 too
    if (std::isinf(value))
        return value < 0 ? QStringLiteral("-Infinity") : QStringLiteral("Infinity");

    // "d.ddde+XX" - the shortest digits that round-trip, which is what JS prints.
    const QString scientific = QString::number(std::fabs(value), 'e', QLocale::FloatingPointShortest);
    const qsizetype ePos = scientific.indexOf(QLatin1Char('e'));
    QString digits = scientific.left(ePos);
    digits.remove(QLatin1Char('.'));
    const int k = int(digits.size());
    const int n = scientific.mid(ePos + 1).toInt() + 1; // position of the decimal point

    QString out;
    if (k <= n && n <= 21) {
        out = digits + QString(n - k, QLatin1Char('0'));
    } else if (0 < n && n <= 21) {
        out = digits.left(n) + QLatin1Char('.') + digits.mid(n);
    } else if (-6 < n && n <= 0) {
        out = QStringLiteral("0.") + QString(-n, QLatin1Char('0')) + digits;
    } else {
        const int exponent = n - 1;
        const QString suffix = (exponent < 0 ? QStringLiteral("e-") : QStringLiteral("e+"))
                               + QString::number(std::abs(exponent));
        out = k == 1 ? digits + suffix : digits.left(1) + QLatin1Char('.') + digits.mid(1) + suffix;
    }
    return value < 0 ? QLatin1Char('-') + out : out;
}

// String(x) for the value of `b.text ?? ''`: null / missing -> "", arrays join with "," (null
// elements -> ""), objects -> "[object Object]".
QString jsToString(const JsonValue *value)
{
    if (!value)
        return QString();
    switch (value->kind) {
    case JsonValue::Kind::Null:
        return QString();
    case JsonValue::Kind::Bool:
        return value->boolValue ? QStringLiteral("true") : QStringLiteral("false");
    case JsonValue::Kind::Number:
        return jsNumberToString(value->numberValue);
    case JsonValue::Kind::String:
        return value->stringValue;
    case JsonValue::Kind::Array: {
        QStringList parts;
        for (const JsonValue &item : value->items)
            parts.append(jsToString(&item));
        return parts.join(QLatin1Char(','));
    }
    case JsonValue::Kind::Object:
        break;
    }
    return QStringLiteral("[object Object]");
}

// ---- JSON.parse -------------------------------------------------------------------------------
// Accepts exactly the JSON grammar (ECMA-404) that JSON.parse accepts: whitespace is space / tab /
// LF / CR only, strings may not hold a raw control character, numbers have no leading zero, no
// trailing commas. Anything else is "not JSON" and the caller falls back to plain text, as the web does.

class Parser
{
public:
    explicit Parser(const QString &source) : m_source(source) {}

    bool parse(JsonValue *out)
    {
        skipWhitespace();
        if (!parseValue(out, 0))
            return false;
        skipWhitespace();
        return m_pos == m_source.size();
    }

private:
    bool atEnd() const { return m_pos >= m_source.size(); }
    char16_t peek() const { return m_source.at(m_pos).unicode(); }
    bool isDigit() const { return !atEnd() && peek() >= u'0' && peek() <= u'9'; }

    void skipWhitespace()
    {
        while (!atEnd() && (peek() == u' ' || peek() == u'\t' || peek() == u'\n' || peek() == u'\r'))
            ++m_pos;
    }

    bool parseLiteral(const QString &word)
    {
        if (m_source.mid(m_pos, word.size()) != word)
            return false;
        m_pos += word.size();
        return true;
    }

    bool parseValue(JsonValue *out, int depth)
    {
        if (depth > kMaxDepth || atEnd())
            return false;
        switch (peek()) {
        case u'{':
            return parseObject(out, depth);
        case u'[':
            return parseArray(out, depth);
        case u'"':
            *out = JsonValue::makeString(QString());
            return parseString(&out->stringValue);
        case u't':
            *out = JsonValue::makeBool(true);
            return parseLiteral(QStringLiteral("true"));
        case u'f':
            *out = JsonValue::makeBool(false);
            return parseLiteral(QStringLiteral("false"));
        case u'n':
            *out = JsonValue::makeNull();
            return parseLiteral(QStringLiteral("null"));
        default:
            return parseNumber(out);
        }
    }

    bool parseObject(JsonValue *out, int depth)
    {
        ++m_pos; // {
        *out = JsonValue::makeObject();
        skipWhitespace();
        if (!atEnd() && peek() == u'}') {
            ++m_pos;
            return true;
        }
        while (true) {
            skipWhitespace();
            if (atEnd() || peek() != u'"')
                return false;
            QString key;
            if (!parseString(&key))
                return false;
            skipWhitespace();
            if (atEnd() || peek() != u':')
                return false;
            ++m_pos;
            skipWhitespace();
            JsonValue value;
            if (!parseValue(&value, depth + 1))
                return false;
            out->insert(key, value); // duplicate key: last value wins, first position stays
            skipWhitespace();
            if (atEnd())
                return false;
            if (peek() == u',') {
                ++m_pos;
                continue;
            }
            if (peek() == u'}') {
                ++m_pos;
                return true;
            }
            return false;
        }
    }

    bool parseArray(JsonValue *out, int depth)
    {
        ++m_pos; // [
        *out = JsonValue::makeArray();
        skipWhitespace();
        if (!atEnd() && peek() == u']') {
            ++m_pos;
            return true;
        }
        while (true) {
            skipWhitespace();
            JsonValue item;
            if (!parseValue(&item, depth + 1))
                return false;
            out->items.push_back(item);
            skipWhitespace();
            if (atEnd())
                return false;
            if (peek() == u',') {
                ++m_pos;
                continue;
            }
            if (peek() == u']') {
                ++m_pos;
                return true;
            }
            return false;
        }
    }

    bool parseString(QString *out)
    {
        ++m_pos; // opening quote
        QString result;
        while (true) {
            if (atEnd())
                return false;
            const char16_t c = m_source.at(m_pos++).unicode();
            if (c == u'"')
                break;
            if (c < 0x20)
                return false;
            if (c != u'\\') {
                result.append(QChar(c));
                continue;
            }
            if (atEnd())
                return false;
            const char16_t escape = m_source.at(m_pos++).unicode();
            switch (escape) {
            case u'"':
            case u'\\':
            case u'/':
                result.append(QChar(escape));
                break;
            case u'b':
                result.append(QChar(0x08));
                break;
            case u'f':
                result.append(QChar(0x0C));
                break;
            case u'n':
                result.append(QChar(0x0A));
                break;
            case u'r':
                result.append(QChar(0x0D));
                break;
            case u't':
                result.append(QChar(0x09));
                break;
            case u'u': {
                // Exactly four hex digits (toUInt alone would also take a sign, spaces or "0x").
                if (m_pos + 4 > m_source.size())
                    return false;
                for (qsizetype i = m_pos; i < m_pos + 4; ++i) {
                    if (!isHexDigit(m_source.at(i).unicode()))
                        return false;
                }
                const uint unit = m_source.mid(m_pos, 4).toUInt(nullptr, 16);
                m_pos += 4;
                result.append(QChar(char16_t(unit))); // a lone surrogate stays a lone surrogate, as in JS
                break;
            }
            default:
                return false;
            }
        }
        *out = result;
        return true;
    }

    static bool isHexDigit(char16_t c)
    {
        return (c >= u'0' && c <= u'9') || (c >= u'a' && c <= u'f') || (c >= u'A' && c <= u'F');
    }

    bool parseNumber(JsonValue *out)
    {
        const qsizetype start = m_pos;
        if (!atEnd() && peek() == u'-')
            ++m_pos;
        if (atEnd())
            return false;
        if (peek() == u'0') {
            ++m_pos;
        } else if (isDigit()) {
            while (isDigit())
                ++m_pos;
        } else {
            return false;
        }
        if (!atEnd() && peek() == u'.') {
            ++m_pos;
            if (!isDigit())
                return false;
            while (isDigit())
                ++m_pos;
        }
        if (!atEnd() && (peek() == u'e' || peek() == u'E')) {
            ++m_pos;
            if (!atEnd() && (peek() == u'+' || peek() == u'-'))
                ++m_pos;
            if (!isDigit())
                return false;
            while (isDigit())
                ++m_pos;
        }
        // The grammar is already checked, so the C-locale conversion cannot reject the token; an
        // overflow comes back as an infinity (JS: Infinity) and an underflow as 0 (JS: 0).
        *out = JsonValue::makeNumber(m_source.mid(start, m_pos - start).toDouble());
        return true;
    }

    const QString &m_source;
    qsizetype m_pos = 0;
};

// ---- JSON.stringify ---------------------------------------------------------------------------

void writeString(QString &out, const QString &text)
{
    out += QLatin1Char('"');
    for (qsizetype i = 0; i < text.size(); ++i) {
        const char16_t c = text.at(i).unicode();
        switch (c) {
        case u'"':
            out += QStringLiteral("\\\"");
            continue;
        case u'\\':
            out += QStringLiteral("\\\\");
            continue;
        case 0x08:
            out += QStringLiteral("\\b");
            continue;
        case 0x0C:
            out += QStringLiteral("\\f");
            continue;
        case 0x0A:
            out += QStringLiteral("\\n");
            continue;
        case 0x0D:
            out += QStringLiteral("\\r");
            continue;
        case 0x09:
            out += QStringLiteral("\\t");
            continue;
        default:
            break;
        }
        const bool pairedHigh = QChar::isHighSurrogate(c) && i + 1 < text.size()
                                && QChar::isLowSurrogate(text.at(i + 1).unicode());
        if (pairedHigh) {
            out += text.at(i);
            out += text.at(++i);
        } else if (c < 0x20 || QChar::isSurrogate(c)) {
            // Lowercase hex, as JSON.stringify writes it (well-formed JSON.stringify, ES2019).
            out += QStringLiteral("\\u%1").arg(uint(c), 4, 16, QLatin1Char('0'));
        } else {
            out += QChar(c);
        }
    }
    out += QLatin1Char('"');
}

void writeValue(QString &out, const JsonValue &value)
{
    switch (value.kind) {
    case JsonValue::Kind::Null:
        out += QStringLiteral("null");
        return;
    case JsonValue::Kind::Bool:
        out += value.boolValue ? QStringLiteral("true") : QStringLiteral("false");
        return;
    case JsonValue::Kind::Number:
        // A non-finite number (1e400 parses to Infinity) is written as null, like JSON.stringify.
        out += std::isfinite(value.numberValue) ? jsNumberToString(value.numberValue) : QStringLiteral("null");
        return;
    case JsonValue::Kind::String:
        writeString(out, value.stringValue);
        return;
    case JsonValue::Kind::Array:
        out += QLatin1Char('[');
        for (size_t i = 0; i < value.items.size(); ++i) {
            if (i > 0)
                out += QLatin1Char(',');
            writeValue(out, value.items[i]);
        }
        out += QLatin1Char(']');
        return;
    case JsonValue::Kind::Object:
        out += QLatin1Char('{');
        for (size_t i = 0; i < value.members.size(); ++i) {
            if (i > 0)
                out += QLatin1Char(',');
            writeString(out, value.members[i].key);
            out += QLatin1Char(':');
            writeValue(out, value.members[i].value);
        }
        out += QLatin1Char('}');
        return;
    }
}

// One element of a stored block list -> a block, or nothing (isTextBlock / isEmbedBlock on the web:
// an object whose "type" is exactly the string "text" / "embed").
bool blockFromJson(const JsonValue &element, Block *out)
{
    if (element.kind != JsonValue::Kind::Object)
        return false;
    const JsonValue *type = element.find(QStringLiteral("type"));
    if (!type || type->kind != JsonValue::Kind::String)
        return false;
    if (type->stringValue == QLatin1String("text")) {
        const JsonValue *align = element.find(QStringLiteral("align"));
        *out = textBlock(jsToString(element.find(QStringLiteral("text"))),
                         align && align->kind == JsonValue::Kind::String ? align->stringValue : QString());
        return true;
    }
    if (type->stringValue == QLatin1String("embed")) {
        *out = embedBlock(element);
        return true;
    }
    return false;
}

JsonValue textBlockJson(const Block &block)
{
    JsonValue object = JsonValue::makeObject();
    object.insert(QStringLiteral("type"), JsonValue::makeString(QStringLiteral("text")));
    object.insert(QStringLiteral("text"), JsonValue::makeString(block.text));
    if (!block.align.isEmpty())
        object.insert(QStringLiteral("align"), JsonValue::makeString(block.align));
    return object;
}

} // namespace

// ---- JsonValue --------------------------------------------------------------------------------

JsonValue JsonValue::makeNull()
{
    return JsonValue();
}

JsonValue JsonValue::makeBool(bool value)
{
    JsonValue out;
    out.kind = Kind::Bool;
    out.boolValue = value;
    return out;
}

JsonValue JsonValue::makeNumber(double value)
{
    JsonValue out;
    out.kind = Kind::Number;
    out.numberValue = value;
    return out;
}

JsonValue JsonValue::makeString(const QString &value)
{
    JsonValue out;
    out.kind = Kind::String;
    out.stringValue = value;
    return out;
}

JsonValue JsonValue::makeArray(const std::vector<JsonValue> &items)
{
    JsonValue out;
    out.kind = Kind::Array;
    out.items = items;
    return out;
}

JsonValue JsonValue::makeObject()
{
    JsonValue out;
    out.kind = Kind::Object;
    return out;
}

const JsonValue *JsonValue::find(const QString &key) const
{
    if (kind != Kind::Object)
        return nullptr;
    for (const JsonMember &member : members) {
        if (member.key == key)
            return &member.value;
    }
    return nullptr;
}

void JsonValue::insert(const QString &key, const JsonValue &value)
{
    for (JsonMember &member : members) {
        if (member.key == key) {
            member.value = value;
            return;
        }
    }
    quint32 index = 0;
    if (arrayIndexOf(key, &index)) {
        auto it = members.begin();
        quint32 other = 0;
        while (it != members.end() && arrayIndexOf(it->key, &other) && other < index)
            ++it;
        members.insert(it, JsonMember{key, value});
        return;
    }
    members.push_back(JsonMember{key, value});
}

bool operator==(const JsonValue &a, const JsonValue &b)
{
    if (a.kind != b.kind)
        return false;
    switch (a.kind) {
    case JsonValue::Kind::Null:
        return true;
    case JsonValue::Kind::Bool:
        return a.boolValue == b.boolValue;
    case JsonValue::Kind::Number:
        return a.numberValue == b.numberValue;
    case JsonValue::Kind::String:
        return a.stringValue == b.stringValue;
    case JsonValue::Kind::Array:
        return a.items == b.items;
    case JsonValue::Kind::Object:
        if (a.members.size() != b.members.size())
            return false;
        for (size_t i = 0; i < a.members.size(); ++i) {
            if (a.members[i].key != b.members[i].key || a.members[i].value != b.members[i].value)
                return false;
        }
        return true;
    }
    return false;
}

// ---- blocks -----------------------------------------------------------------------------------

bool operator==(const Block &a, const Block &b)
{
    if (a.type != b.type)
        return false;
    if (a.type == Block::Type::Text)
        return a.text == b.text && a.align == b.align;
    return a.embed == b.embed;
}

bool isValidAlign(const QString &value)
{
    return ALIGN_VALUES.contains(value);
}

Block textBlock(const QString &text, const QString &align)
{
    Block block;
    block.type = Block::Type::Text;
    block.text = text;
    if (isValidAlign(align))
        block.align = align;
    return block;
}

Block embedBlock(const JsonValue &fields)
{
    Block block;
    block.type = Block::Type::Embed;
    block.embed = fields.kind == JsonValue::Kind::Object ? fields : JsonValue::makeObject();
    block.embed.insert(QStringLiteral("type"), JsonValue::makeString(QStringLiteral("embed")));
    return block;
}

bool isTextBlock(const Block &block)
{
    return block.type == Block::Type::Text;
}

bool isEmbedBlock(const Block &block)
{
    return block.type == Block::Type::Embed;
}

QVector<Block> normalizeBlocks(const QVector<Block> &blocks)
{
    QVector<Block> out;
    out.reserve(blocks.size());
    for (const Block &block : blocks)
        out.append(isTextBlock(block) ? textBlock(block.text, block.align) : embedBlock(block.embed));
    return out;
}

QString serialize(const QVector<Block> &blocks)
{
    JsonValue list = JsonValue::makeArray();
    for (const Block &block : normalizeBlocks(blocks))
        list.items.push_back(isTextBlock(block) ? textBlockJson(block) : block.embed);

    JsonValue document = JsonValue::makeObject();
    document.insert(QStringLiteral("format"), JsonValue::makeString(EDITOR_FORMAT));
    document.insert(QStringLiteral("version"), JsonValue::makeNumber(EDITOR_VERSION));
    document.insert(QStringLiteral("blocks"), list);

    QString out;
    writeValue(out, document);
    return out;
}

QVector<Block> deserialize(const QString &raw)
{
    if (raw.isEmpty())
        return {};

    // First as a JSON document: a block array, or an object whose "blocks" is one.
    JsonValue document;
    if (Parser(raw).parse(&document)) {
        const JsonValue *source = nullptr;
        if (document.kind == JsonValue::Kind::Array) {
            source = &document;
        } else {
            const JsonValue *blocks = document.find(QStringLiteral("blocks"));
            if (blocks && blocks->kind == JsonValue::Kind::Array)
                source = blocks;
        }
        if (source) {
            QVector<Block> out;
            for (const JsonValue &element : source->items) {
                Block block;
                if (blockFromJson(element, &block))
                    out.append(block);
            }
            // An empty list stays empty; a list that normalization emptied completely falls through to
            // the plain-text path below so the original text is not lost.
            if (!out.isEmpty() || source->items.empty())
                return out;
        }
    }

    // Not JSON, other JSON, or a fully dropped list: a legacy plain-text body, one block per line.
    return textToBlocks(raw);
}

QString blocksToText(const QVector<Block> &blocks)
{
    QStringList lines;
    for (const Block &block : blocks) {
        if (isTextBlock(block))
            lines.append(block.text);
    }
    return lines.join(QLatin1Char('\n'));
}

QVector<Block> textToBlocks(const QString &text)
{
    QVector<Block> out;
    for (const QString &line : text.split(QLatin1Char('\n')))
        out.append(textBlock(line));
    return out;
}

bool hasEndMarker(const QVector<Block> &blocks)
{
    return blocksToText(blocks).contains(END_MARKER);
}

} // namespace editor
