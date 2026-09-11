#include "shell/clientconfig.h"

#include "shell/serverurl.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QString>

#include <cmath>
#include <limits>

namespace shell {
namespace {

// JSON has one number type, so "is it an integer" has to be asked explicitly:
// QJsonValue::toInt() truncates 1440.5 to 1440 in silence and answers 0 for a wrong type,
// which would let this port store rectangles the canonical rejects (Number.isInteger).
//
// The int range check is a deliberate, documented divergence: JS accepts 1e12 as an
// integer, Qt geometry is int, and a value that cannot be represented is not a rectangle.
bool wholeNumber(const QJsonValue &value, int *out)
{
    if (!value.isDouble())
        return false;  // strings, booleans, null, objects, arrays and absent keys
    const double raw = value.toDouble();
    if (!std::isfinite(raw) || raw != std::trunc(raw))
        return false;
    if (raw < static_cast<double>(std::numeric_limits<int>::min())
        || raw > static_cast<double>(std::numeric_limits<int>::max()))
        return false;
    *out = static_cast<int>(raw);
    return true;
}

// The nested whitelist (C-N2): exactly five keys are read out of the object, everything
// else inside "bounds" disappears with the QJsonObject it came in.
Bounds boundsFromJson(const QJsonValue &value)
{
    if (!value.isObject())
        return Bounds();
    const QJsonObject object = value.toObject();

    Bounds bounds;
    if (!wholeNumber(object.value(QStringLiteral("width")), &bounds.width)
        || !wholeNumber(object.value(QStringLiteral("height")), &bounds.height)
        || !wholeNumber(object.value(QStringLiteral("x")), &bounds.x)
        || !wholeNumber(object.value(QStringLiteral("y")), &bounds.y))
        return Bounds();  // one bad number drops the whole rectangle - never a partial fill

    // Strict boolean: the string "true" and the number 1 are not true.
    const QJsonValue maximized = object.value(QStringLiteral("maximized"));
    bounds.maximized = maximized.isBool() && maximized.toBool();
    bounds.valid = true;
    return sanitizeBoundsShape(bounds);
}

QJsonObject boundsToJson(const Bounds &bounds)
{
    QJsonObject object;
    object.insert(QStringLiteral("width"), bounds.width);
    object.insert(QStringLiteral("height"), bounds.height);
    object.insert(QStringLiteral("x"), bounds.x);
    object.insert(QStringLiteral("y"), bounds.y);
    object.insert(QStringLiteral("maximized"), bounds.maximized);
    return object;
}

} // namespace

bool operator==(const Bounds &lhs, const Bounds &rhs)
{
    if (lhs.valid != rhs.valid)
        return false;
    if (!lhs.valid)
        return true;  // every "no bounds" is the same "no bounds"
    return lhs.width == rhs.width && lhs.height == rhs.height && lhs.x == rhs.x && lhs.y == rhs.y
        && lhs.maximized == rhs.maximized;
}

bool operator!=(const Bounds &lhs, const Bounds &rhs)
{
    return !(lhs == rhs);
}

bool operator==(const ClientConfig &lhs, const ClientConfig &rhs)
{
    return lhs.schemaVersion == rhs.schemaVersion && lhs.serverUrl == rhs.serverUrl
        && lhs.bounds == rhs.bounds;
}

bool operator!=(const ClientConfig &lhs, const ClientConfig &rhs)
{
    return !(lhs == rhs);
}

ClientConfig parseConfig(const QByteArray &rawJson)
{
    ClientConfig config;  // the defaults are also the answer to every failure below
    if (rawJson.trimmed().isEmpty())
        return config;

    QJsonParseError error{};
    const QJsonDocument document = QJsonDocument::fromJson(rawJson, &error);
    if (error.error != QJsonParseError::NoError)
        return config;  // broken JSON, invalid UTF-8, a bare scalar
    if (!document.isObject())
        return config;  // arrays and anything else that is not a plain object

    const QJsonObject object = document.object();

    // C-N1: parsed.schemaVersion is deliberately never read. The canonical overwrites it
    // with the current constant (clientConfig.js:50) and has no migration anywhere, so a
    // file that says 99 or "corrupt" parses exactly like a current one. Adding a version
    // check here would be a divergence, not a fix.

    // The stored address is not trusted even though it was normalised before it was
    // written: the file can be hand-edited.
    const QJsonValue serverUrl = object.value(QStringLiteral("serverUrl"));
    if (serverUrl.isString()) {
        const NormalizedUrl normalized = normalizeServerUrl(serverUrl.toString());
        if (normalized.ok)
            config.serverUrl = normalized.origin;
    }

    // Field-scoped failure: broken bounds do not take the address down with them.
    config.bounds = boundsFromJson(object.value(QStringLiteral("bounds")));
    return config;
}

QByteArray serializeConfig(const ClientConfig &config)
{
    // Built as a fresh object, so a caller carrying extra data has nowhere to put it, and
    // the schema version is ours rather than whatever was loaded (R7).
    QJsonObject out;
    out.insert(QStringLiteral("schemaVersion"), kConfigSchemaVersion);
    out.insert(QStringLiteral("serverUrl"),
               config.serverUrl.isEmpty() ? QJsonValue(QJsonValue::Null)
                                          : QJsonValue(config.serverUrl));
    // The same shape check as reading: an undersized rectangle handed over by a caller is
    // not written. No re-normalisation of serverUrl here - like the canonical, the caller
    // has already passed it through normalizeServerUrl, and reading re-validates anyway.
    const Bounds shaped = sanitizeBoundsShape(config.bounds);
    out.insert(QStringLiteral("bounds"),
               shaped.valid ? QJsonValue(boundsToJson(shaped)) : QJsonValue(QJsonValue::Null));

    // Exactly one trailing newline. QJsonDocument's own newline handling is a Qt detail, so
    // the byte the contract talks about is appended here on purpose.
    QByteArray json = QJsonDocument(out).toJson(QJsonDocument::Indented);
    while (json.endsWith('\n'))
        json.chop(1);
    json.append('\n');
    return json;
}

Bounds sanitizeBoundsShape(const Bounds &bounds)
{
    if (!bounds.valid)
        return Bounds();
    if (bounds.width < kMinStoredWidth || bounds.height < kMinStoredHeight)
        return Bounds();
    return bounds;
}

Bounds sanitizeBounds(const Bounds &bounds, const QList<QRect> &workAreas)
{
    const Bounds shaped = sanitizeBoundsShape(bounds);
    if (!shaped.valid)
        return Bounds();

    for (const QRect &area : workAreas) {
        // The four canonical inequalities, spelled out. QRect::intersects() works on the
        // x + width - 1 convention and answers differently where rectangles share an edge;
        // touching is not overlapping here.
        //
        // qint64 on purpose: every term is an int, wholeNumber() accepts the whole int range and
        // the file can be hand-edited, so x + width may leave the int range. Signed overflow is
        // undefined behaviour - not a wrap this may lean on - and the observed effect was a
        // negative sum reading as "on no monitor". Widening costs nothing and is total.
        const qint64 left = shaped.x;
        const qint64 top = shaped.y;
        const qint64 right = left + shaped.width;
        const qint64 bottom = top + shaped.height;
        const qint64 areaLeft = area.x();
        const qint64 areaTop = area.y();
        const qint64 areaRight = areaLeft + area.width();
        const qint64 areaBottom = areaTop + area.height();

        const bool overlaps =
            left < areaRight && right > areaLeft && top < areaBottom && bottom > areaTop;
        if (overlaps)
            return shaped;
    }
    return Bounds();  // no monitor holds it (an unplugged screen) - the caller centres it
}

} // namespace shell
