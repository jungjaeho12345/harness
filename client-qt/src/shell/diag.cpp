#include "shell/diag.h"

#include "shell/appidentity.h"
#include "shell/serverurl.h"

#include <QDateTime>
#include <QFile>
#include <QHash>
#include <QIODevice>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonValue>
#include <QLatin1Char>
#include <QLatin1String>
#include <QMetaType>
#include <QRegularExpression>
#include <QTimeZone>
#include <QVariant>

#include <QtDebug>

#include <cmath>

namespace shell {
namespace {

// client/diag.js:9 - the canonical seven, matched with EXACT case (Set.has). "Body" and
// "Token" therefore survive, exactly as they do in the canonical; making the comparison
// case-insensitive here would produce a different filtering result than the module this port
// has to stay byte-compatible with. See client-qt/README.md for why that is acceptable and
// what actually carries the guarantee (the caller discipline of diag.js:7-8).
const QSet<QString> &forbiddenKeys()
{
    static const QSet<QString> keys{
        QStringLiteral("body"),     QStringLiteral("sessionId"), QStringLiteral("cookie"),
        QStringLiteral("cookies"),  QStringLiteral("password"),  QStringLiteral("token"),
        QStringLiteral("headers")};
    return keys;
}

// step4.md C - this port's own extension, matched case-insensitively (it is a new rule, not
// a port of an existing one): no article headline, no article text and no user name may
// appear in any event. The canonical logs a page title on did-finish-load; this port does not.
const QSet<QString> &humanTextKeysLower()
{
    static const QSet<QString> keys{QStringLiteral("title"), QStringLiteral("content"),
                                    QStringLiteral("text"), QStringLiteral("name"),
                                    QStringLiteral("username")};
    return keys;
}

// The nine events P4 adds carry a fixed field list (step4.md C). Anything else is dropped, so
// "just add one more field" is a deliberate edit here rather than an accident at a call site.
// The twelve inherited/remapped events keep the canonical's open payload.
const QHash<QString, QStringList> &contractedFields()
{
    static const QHash<QString, QStringList> table{
        {QStringLiteral("net-request"),
         {QStringLiteral("route"), QStringLiteral("method"), QStringLiteral("status"),
          QStringLiteral("ms")}},
        {QStringLiteral("login"), {QStringLiteral("status")}},
        {QStringLiteral("session"), {QStringLiteral("status")}},
        {QStringLiteral("sse-open"), {}},
        {QStringLiteral("sse-ready"), {}},
        {QStringLiteral("sse-change"), {QStringLiteral("kind")}},
        {QStringLiteral("sse-unauthorized"), {}},
        // step9: reason is one of the four CloseReason names; status only for pre-open-rejected.
        {QStringLiteral("sse-closed"), {QStringLiteral("reason"), QStringLiteral("status")}},
        {QStringLiteral("list-loaded"), {QStringLiteral("menu"), QStringLiteral("count")}}};
    return table;
}

bool fieldAllowedForEvent(const QString &event, const QString &key)
{
    const auto it = contractedFields().constFind(event);
    if (it == contractedFields().constEnd())
        return true;
    return it->contains(key);
}

// A route id (articles-get) or a path template (/api/articles/:id/history/:historyId).
const QRegularExpression &routeIdRe()
{
    static const QRegularExpression re(QStringLiteral("^[a-z][a-z0-9-]*$"));
    return re;
}

const QRegularExpression &routeSegmentRe()
{
    static const QRegularExpression re(QStringLiteral("^(?::[A-Za-z][A-Za-z0-9]*|[a-z][a-z0-9.-]*)$"));
    return re;
}

// client/diag.js:34-36 - the value whitelist. Returns false for anything that is not a plain
// scalar, which is what keeps the line serialisable and keeps whole objects out of the log.
// null (an invalid QVariant) is deliberately inside the whitelist: canonical R6.
bool toJsonScalar(const QVariant &value, QJsonValue *out)
{
    switch (value.typeId()) {
    case QMetaType::UnknownType:  // default-constructed QVariant = this port's spelling of null
    case QMetaType::Nullptr:
        *out = QJsonValue(QJsonValue::Null);
        return true;
    case QMetaType::QString:
        *out = QJsonValue(value.toString());
        return true;
    case QMetaType::QByteArray:  // the C++ spelling of a string literal; decoded as UTF-8
        *out = QJsonValue(QString::fromUtf8(value.toByteArray()));
        return true;
    case QMetaType::Bool:
        *out = QJsonValue(value.toBool());
        return true;
    case QMetaType::Int:
    case QMetaType::UInt:
    case QMetaType::LongLong:
    case QMetaType::ULongLong:
        *out = QJsonValue(value.toLongLong());
        return true;
    case QMetaType::Double:
    case QMetaType::Float: {
        const double number = value.toDouble();
        // D-N2: JSON has no NaN/Infinity and JSON.stringify writes null for them. Measured on
        // the canonical, reproduced here instead of trusting Qt's serialiser to agree.
        *out = std::isfinite(number) ? QJsonValue(number) : QJsonValue(QJsonValue::Null);
        return true;
    }
    default:
        return false;
    }
}

bool isTextual(const QVariant &value)
{
    return value.typeId() == QMetaType::QString || value.typeId() == QMetaType::QByteArray;
}

QString textOf(const QVariant &value)
{
    return value.typeId() == QMetaType::QByteArray ? QString::fromUtf8(value.toByteArray())
                                                   : value.toString();
}

// One JSON value, spelled by Qt's own serialiser (so escaping and number formatting are not
// re-invented here) but emitted outside a document, because the key order of this line is part
// of the contract and QJsonObject sorts its keys.
QByteArray jsonText(const QJsonValue &value)
{
    QJsonArray wrapper;
    wrapper.append(value);
    const QByteArray text = QJsonDocument(wrapper).toJson(QJsonDocument::Compact).trimmed();
    return text.mid(1, text.size() - 2);  // strip the "[" and "]"
}

QByteArray jsonPair(const QString &key, const QJsonValue &value)
{
    return jsonText(QJsonValue(key)) + ':' + jsonText(value);
}

// client/diag.js:43 - new Date(now).toISOString(): UTC, milliseconds, trailing "Z". Spelled
// out rather than delegated to Qt::ISODateWithMs so the format cannot drift with the locale
// or with a Qt release.
QString isoTimestamp(qint64 epochMs)
{
    return QDateTime::fromMSecsSinceEpoch(epochMs, QTimeZone::UTC)
        .toString(QStringLiteral("yyyy-MM-dd'T'HH:mm:ss.zzz'Z'"));
}

} // namespace

const QSet<QString> &allowedDiagEvents()
{
    // The disposition of the canonical's 18 names plus the 9 P4 needs. This set IS the P4
    // boundary: the six extinct Electron names are absent on purpose (R19 - a native app has
    // no renderer process, no navigation and no contextBridge, and emitting those names would
    // make the driver read a signal that never happened).
    static const QSet<QString> events{
        // inherited (8)
        QStringLiteral("app-ready"), QStringLiteral("config-loaded"), QStringLiteral("config-saved"),
        QStringLiteral("probe"), QStringLiteral("second-instance"), QStringLiteral("setup-shown"),
        QStringLiteral("restart-required"), QStringLiteral("window-open"),
        // remapped (4)
        QStringLiteral("app-window"), QStringLiteral("local-window"),
        QStringLiteral("did-finish-load"), QStringLiteral("load-failed"),
        // new (9)
        QStringLiteral("net-request"), QStringLiteral("login"), QStringLiteral("session"),
        QStringLiteral("sse-open"), QStringLiteral("sse-ready"), QStringLiteral("sse-change"),
        QStringLiteral("sse-unauthorized"), QStringLiteral("sse-closed"),
        QStringLiteral("list-loaded")};
    return events;
}

bool isAllowedDiagEvent(const QString &event)
{
    return allowedDiagEvents().contains(event);
}

bool isSafeRouteValue(const QString &value)
{
    if (routeIdRe().match(value).hasMatch())
        return true;
    if (!value.startsWith(QLatin1Char('/')))
        return false;
    const QStringList segments = value.mid(1).split(QLatin1Char('/'));
    for (const QString &segment : segments) {
        if (!routeSegmentRe().match(segment).hasMatch())
            return false;
    }
    return !segments.isEmpty();
}

QString redactUrl(const QString &value)
{
    if (value == QLatin1String("about:blank"))
        return value;  // client/diag.js:12 - a harmless fixed string, kept verbatim

    const UrlParts parts = parseUrlParts(value);
    if (!parts.ok)
        return value;  // fail-open: not an absolute URL, so it cannot carry a query string

    if (parts.scheme == QLatin1String("file")) {
        // Local absolute paths never reach the log: scheme + file name only.
        const int slash = parts.path.lastIndexOf(QLatin1Char('/'));
        const QString name = slash < 0 ? parts.path : parts.path.mid(slash + 1);
        return QStringLiteral("file:///") + name;
    }

    if (parts.scheme == QLatin1String("http") || parts.scheme == QLatin1String("https")) {
        // A host-less http URL ("http:/x") is where the canonical and QUrl disagree: WHATWG
        // folds the slashes and infers a host, QUrl does not. Answering with the scheme keeps
        // the query out of the log either way - falling open here would be the one path on
        // which a query string survives.
        if (!parts.hasHost)
            return parts.scheme + QLatin1Char(':');
        // origin + pathname, so query and fragment (article ids, tokens) are gone.
        return parts.origin + (parts.path.isEmpty() ? QStringLiteral("/") : parts.path);
    }

    return parts.scheme + QLatin1Char(':');  // other schemes: the scheme alone, no content
}

QVariantMap redactDiagEvent(const QString &event, const QVariantMap &payload)
{
    QVariantMap out;
    for (auto it = payload.constBegin(); it != payload.constEnd(); ++it) {
        const QString &key = it.key();
        if (forbiddenKeys().contains(key))
            continue;
        if (humanTextKeysLower().contains(key.toLower()))
            continue;
        if (!fieldAllowedForEvent(event, key))
            continue;

        QJsonValue serialisable;
        if (!toJsonScalar(it.value(), &serialisable))
            continue;  // objects, arrays and every other non-scalar are dropped

        if (!isTextual(it.value())) {
            out.insert(key, it.value());
            continue;
        }

        const QString text = textOf(it.value());
        if (key.toLower().contains(QLatin1String("url"))) {
            // includes(), not endsWith() - "hourly" matches too (canonical R7).
            out.insert(key, redactUrl(text));
        } else if (key.compare(QLatin1String("route"), Qt::CaseInsensitive) == 0
                   && !isSafeRouteValue(text)) {
            // A concrete article id in a route is the same leak the query stripping prevents.
            out.insert(key, QStringLiteral("<invalid-route>"));
        } else {
            out.insert(key, text);
        }
    }
    return out;
}

QByteArray formatDiagLine(const QString &event, const QVariantMap &payload, qint64 epochMs)
{
    QVariantMap redacted = redactDiagEvent(event, payload);

    // client/diag.js:43 spreads the payload AFTER ts/event, so a payload field of that name
    // wins while the key keeps its leading position. Reproduced rather than defended against
    // (README) - none of the 21 payload contracts uses those names.
    QJsonValue tsValue(isoTimestamp(epochMs));
    if (redacted.contains(QStringLiteral("ts")))
        toJsonScalar(redacted.take(QStringLiteral("ts")), &tsValue);
    QJsonValue eventValue(event);
    if (redacted.contains(QStringLiteral("event")))
        toJsonScalar(redacted.take(QStringLiteral("event")), &eventValue);

    QByteArray line = "{";
    line += jsonPair(QStringLiteral("ts"), tsValue);
    line += ',';
    line += jsonPair(QStringLiteral("event"), eventValue);
    for (auto it = redacted.constBegin(); it != redacted.constEnd(); ++it) {
        QJsonValue value;
        if (!toJsonScalar(it.value(), &value))
            continue;
        line += ',';
        line += jsonPair(it.key(), value);
    }
    line += "}\n";  // exactly one LF: the judge splits on it and JSON.parse's each line
    return line;
}

QString diagFilePathFromEnvironment()
{
    const QByteArray envName = names::diagFileEnvVar().toLatin1();
    return qEnvironmentVariable(envName.constData()).trimmed();
}

Diag::Diag(const QString &filePath) : m_filePath(filePath.trimmed()) {}

bool Diag::isEnabled() const
{
    return !m_filePath.isEmpty();
}

QString Diag::filePath() const
{
    return m_filePath;
}

int Diag::rejectedEventCount() const
{
    return m_rejectedEvents;
}

void Diag::log(const QString &event, const QVariantMap &payload)
{
    logAt(event, payload, QDateTime::currentMSecsSinceEpoch());
}

void Diag::logAt(const QString &event, const QVariantMap &payload, qint64 epochMs)
{
    if (!isAllowedDiagEvent(event)) {
        // The allowed set is the phase boundary. Refuse loudly, write nothing: a name the
        // judge does not know is worse than a missing line.
        ++m_rejectedEvents;
        qWarning("diag: refusing an event outside the allowed set: %s", qPrintable(event));
        return;
    }
    if (m_filePath.isEmpty())
        return;  // no CLIENT_DIAG_FILE: complete no-op, not even an empty file

    // Synchronous by contract: the driver polls this file for the LAST event of a sequence,
    // so a queue or a debounce would time the gate out while the app is perfectly healthy.
    // No directory is created (canonical R17) - that stays the composition root's business.
    QFile file(m_filePath);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Append))
        return;  // swallowed: a diagnostic that kills the app defeats its purpose

    const QByteArray line = formatDiagLine(event, payload, epochMs);
    if (file.write(line) == line.size())
        file.flush();
    file.close();
}

} // namespace shell
