#include "net/querystring.h"

#include <QByteArray>
#include <QLatin1Char>
#include <QLocale>
#include <QMetaType>
#include <QStringList>
#include <QVariant>
#include <QVariantList>

#include <cmath>

namespace net {
namespace {

// The application/x-www-form-urlencoded percent-encode set keeps exactly these bytes
// (URL Standard; measured on node: '*' kept, '~' encoded).
bool keptAsIs(uchar c)
{
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '*'
        || c == '-' || c == '.' || c == '_';
}

bool isNullish(const QVariant &value)
{
    // JS null/undefined. A QVariant holding an empty QString is NOT null (Qt 6 semantics) - it is
    // the canonical's empty string, which is kept as "key=".
    return value.typeId() == QMetaType::UnknownType || value.typeId() == QMetaType::Nullptr;
}

bool isList(const QVariant &value)
{
    return value.typeId() == QMetaType::QVariantList || value.typeId() == QMetaType::QStringList;
}

// JS Number#toString for the numbers a filter can hold. Integral values print without a
// fraction (a JSON number arrives as a double: 50.0 must read "50").
QString jsNumber(double number)
{
    if (std::isnan(number))
        return QStringLiteral("NaN");
    if (std::isinf(number))
        return number > 0 ? QStringLiteral("Infinity") : QStringLiteral("-Infinity");
    if (number == std::trunc(number) && std::fabs(number) < 1e21)
        return QString::number(static_cast<qint64>(number));
    return QString::number(number, 'g', QLocale::FloatingPointShortest);
}

QString jsString(const QVariant &value);

// Array.prototype.join(","): null elements become the empty string.
QString joined(const QVariant &list)
{
    QStringList parts;
    for (const QVariant &element : list.toList())
        parts << (isNullish(element) ? QString() : jsString(element));
    return parts.join(QLatin1Char(','));
}

// JS String(v) - what URLSearchParams.append() does to a value.
QString jsString(const QVariant &value)
{
    if (isNullish(value))
        return QStringLiteral("null");
    if (isList(value))
        return joined(value);
    switch (value.typeId()) {
    case QMetaType::QString:
        return value.toString();
    case QMetaType::QByteArray:
        return QString::fromUtf8(value.toByteArray());
    case QMetaType::Bool:
        return value.toBool() ? QStringLiteral("true") : QStringLiteral("false");
    case QMetaType::Int:
    case QMetaType::UInt:
    case QMetaType::LongLong:
        return QString::number(value.toLongLong());
    case QMetaType::ULongLong:
        return QString::number(value.toULongLong());
    case QMetaType::Double:
    case QMetaType::Float:
        return jsNumber(value.toDouble());
    default:
        return value.toString();
    }
}

} // namespace

QString formUrlEncode(const QString &text)
{
    static const char hex[] = "0123456789ABCDEF";
    const QByteArray utf8 = text.toUtf8();
    QString out;
    out.reserve(utf8.size() * 3);
    for (const char ch : utf8) {
        const uchar c = static_cast<uchar>(ch);
        if (c == ' ') {
            out += QLatin1Char('+');
        } else if (keptAsIs(c)) {
            out += QLatin1Char(static_cast<char>(c));
        } else {
            out += QLatin1Char('%');
            out += QLatin1Char(hex[c >> 4]);
            out += QLatin1Char(hex[c & 0x0F]);
        }
    }
    return out;
}

QString buildQuery(const QVariantMap &params)
{
    QStringList pairs;
    for (auto it = params.constBegin(); it != params.constEnd(); ++it) {
        const QVariant &value = it.value();
        if (isNullish(value))
            continue;  // httpModel.js:73 - the key itself is dropped
        const QString key = formUrlEncode(it.key());
        if (isList(value)) {
            // httpModel.js:74 - the same key once per element; an empty list emits nothing
            for (const QVariant &element : value.toList())
                pairs << key + QLatin1Char('=') + formUrlEncode(jsString(element));
        } else {
            pairs << key + QLatin1Char('=') + formUrlEncode(jsString(value));
        }
    }
    if (pairs.isEmpty())
        return QString();  // httpModel.js:78 - no "?" for an empty query
    return QLatin1Char('?') + pairs.join(QLatin1Char('&'));
}

} // namespace net
