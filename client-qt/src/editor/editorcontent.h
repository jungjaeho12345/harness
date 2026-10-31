#ifndef CLIENT_QT_EDITOR_EDITORCONTENT_H
#define CLIENT_QT_EDITOR_EDITORCONTENT_H

// The article body block model - markupVersion "yh-editor" v1 (phase 78 step1). A 1:1 port of
// web/src/view/editorContent.js; its spec (editorContent.test.js) lives on as
// tests/editorcontenttest.cpp. Plus, since step5, the text-line -> block index bridge of
// web/src/view/writerBody.js (textLineToBlockIndex), which every block-level edit shares.
//
// CRITICAL (carried over from the web module): the body is ALWAYS handled as blocks, never stored as
// a plain string (news.md / SCHEMA.md). A block is text {type:'text', text[, align]} or an embed
// {type:'embed', embedType, ...}. The stored document is {format:'yh-editor', version:1, blocks:[...]}
// - the shape the backend writes (src/services/collectionService.js toMarkup) and the frozen
// contract describes (docs/api-contract/openapi.yaml, Article.markupVersion). A legacy plain-text body
// still loads: one text block per line.
//
// Byte parity with the web serializer. serialize() writes exactly what JSON.stringify writes for the
// same blocks: the fixed key order of a text block, JavaScript's own-property order for an embed
// object (array-index keys ascending first, then insertion order), JSON.stringify's string escapes
// (\" \\ \b \f \n \r \t; every other control character and every lone surrogate as a lowercase
// \u00xx; everything else raw) and Number.prototype.toString for numbers. So serialize(deserialize(x))
// == x for any body the web editor saved, and a body saved here is byte-identical to the one the web
// would save for the same blocks. That is why an embed travels as an order-preserving JsonValue and
// not as a QJsonObject (which sorts keys). P5 only carries embeds through - rendering and inserting
// them is P6.
//
// One deliberate divergence: JSON nested deeper than 512 levels is treated as "not JSON" (the plain
// text fallback) instead of being parsed - a recursion bound, since a body comes from the server.
// No editor ever writes such a body.
//
// Widget-independent (decisions (1)). Nothing here mutates its input: every function takes const
// references and returns new values.

#include <QString>
#include <QStringList>
#include <QVector>

#include <vector>

namespace editor {

// The document header. Both are part of the stored bytes - changing either breaks every body.
extern const QString EDITOR_FORMAT; // "yh-editor"
constexpr int EDITOR_VERSION = 1;

// The four text alignments a text block may carry (web ALIGN_VALUES, same order).
extern const QStringList ALIGN_VALUES;

struct JsonMember;

// A JSON value that keeps object keys in JavaScript's own-property order. Only embed payloads use it.
struct JsonValue {
    enum class Kind { Null, Bool, Number, String, Array, Object };

    Kind kind = Kind::Null;
    bool boolValue = false;
    double numberValue = 0;
    QString stringValue;
    std::vector<JsonValue> items;    // Array
    std::vector<JsonMember> members; // Object - kept in JS order by insert(); do not push_back

    static JsonValue makeNull();
    static JsonValue makeBool(bool value);
    static JsonValue makeNumber(double value);
    static JsonValue makeString(const QString &value);
    static JsonValue makeArray(const std::vector<JsonValue> &items = {});
    static JsonValue makeObject();

    // The member's value, or nullptr when the key is absent (or this is not an object).
    const JsonValue *find(const QString &key) const;
    // obj[key] = value on a plain JS object: an existing key keeps its position and takes the new
    // value; a new array-index key ("0".."4294967294") goes among the index keys in ascending order;
    // any other new key goes last.
    void insert(const QString &key, const JsonValue &value);
};

struct JsonMember {
    QString key;
    JsonValue value;
};

bool operator==(const JsonValue &a, const JsonValue &b);
inline bool operator!=(const JsonValue &a, const JsonValue &b) { return !(a == b); }

struct Block {
    enum class Type { Text, Embed };

    Type type = Type::Text;
    QString text;    // Text only
    QString align;   // Text only; empty = no "align" key (normalizeBlocks keeps ALIGN_VALUES only)
    JsonValue embed; // Embed only: the whole embed object, "type":"embed" included, in JS key order
};

// A text block compares text + align, an embed block compares its object.
bool operator==(const Block &a, const Block &b);
inline bool operator!=(const Block &a, const Block &b) { return !(a == b); }

bool isValidAlign(const QString &value);

// {type:'text', text[, align]} - align is attached only when it is one of ALIGN_VALUES.
Block textBlock(const QString &text = QString(), const QString &align = QString());
// {...fields, type:'embed'} - "type" set in place when present, appended last otherwise. A non-object
// argument counts as {}.
Block embedBlock(const JsonValue &fields = JsonValue::makeObject());

bool isTextBlock(const Block &block);
bool isEmbedBlock(const Block &block);

// Safe form: text blocks lose an invalid align, embed blocks get "type":"embed".
QVector<Block> normalizeBlocks(const QVector<Block> &blocks);

// Blocks -> markupVersion ({"format":"yh-editor","version":1,"blocks":[...]}, normalized blocks).
QString serialize(const QVector<Block> &blocks);

// markupVersion -> blocks. Empty -> []. A JSON array, or an object whose "blocks" is an array, is read
// as blocks (unknown elements dropped; a text block's "text" coerced with JS String(), missing/null ->
// ""). Anything else - not JSON, other JSON, or a non-empty block list that normalization empties
// completely - is a legacy plain-text body: one text block per line, so the original text survives.
// An intentionally empty list ([] / blocks:[]) stays empty.
QVector<Block> deserialize(const QString &raw);

// The text blocks joined with '\n' - embeds excluded. The base text of structure, colour and the
// "(끝)" marker rules.
QString blocksToText(const QVector<Block> &blocks);

// Plain text -> one text block per line.
QVector<Block> textToBlocks(const QString &text);

// Whether the text blocks hold "(끝)" (editor::END_MARKER - the backend's hasEndMarker criterion).
bool hasEndMarker(const QVector<Block> &blocks);

// The index into blocks of text line textLineIndex - the textLineIndex-th text block, embeds not counted
// (web writerBody.textLineToBlockIndex, step5: the bridge from a caret's TextPoint.lineIndex to the block a
// shortcut or the word delete edits; P6's find and embed insertion use it too). -1 when there is no such line
// (negative, or past the last text line).
int textLineToBlockIndex(const QVector<Block> &blocks, int textLineIndex);

} // namespace editor

#endif // CLIENT_QT_EDITOR_EDITORCONTENT_H
