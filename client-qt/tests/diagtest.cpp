#include "diagtest.h"

#include "shell/appidentity.h"
#include "shell/diag.h"

#include <QByteArray>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QUrl>
#include <QVariant>
#include <QVariantList>
#include <QVariantMap>
#include <QtTest>

#include <cmath>
#include <limits>

using shell::Diag;
using shell::formatDiagLine;
using shell::redactDiagEvent;
using shell::redactUrl;

namespace {

// Every canonical reference value in this file was produced by running client/diag.js itself
// (node --input-type=module, 2026-09-10) - not read off the source. The exact command is in
// step4.md's acceptance criteria and the run is summarised in client-qt/README.md.
const char kCanonicalProbeLine[] =
    R"json({"ts":"1970-01-01T00:00:00.000Z","event":"probe","ok":true,"url":"http://h:3001/api/health"})json"
    "\n";

QJsonObject parseLine(const QByteArray &line)
{
    QJsonParseError error{};
    const QJsonDocument doc = QJsonDocument::fromJson(line, &error);
    if (error.error != QJsonParseError::NoError)
        return QJsonObject();
    return doc.object();
}

// The single URL value of a one-field payload, after redaction.
QString redactedUrlField(const QString &key, const QVariant &value)
{
    QVariantMap payload;
    payload[key] = value;
    return redactDiagEvent(QStringLiteral("probe"), payload).value(key).toString();
}

QByteArray readAll(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        return QByteArray();
    return file.readAll();
}

} // namespace

void DiagTest::init()
{
    m_hadDiagEnv = qEnvironmentVariableIsSet("CLIENT_DIAG_FILE");
    m_savedDiagEnv = qgetenv("CLIENT_DIAG_FILE");
    qunsetenv("CLIENT_DIAG_FILE");
}

void DiagTest::cleanup()
{
    if (m_hadDiagEnv)
        qputenv("CLIENT_DIAG_FILE", m_savedDiagEnv);
    else
        qunsetenv("CLIENT_DIAG_FILE");
}

// ---------------------------------------------------------------------------------------
// line format
// ---------------------------------------------------------------------------------------

// The acceptance criterion of step4: the same call has to produce the same bytes as
// client/diag.js. This is the one case that would catch a whole class of quiet drift
// (timestamp spelling, key order, port omission, query stripping) in a single comparison.
void DiagTest::matchesTheCanonicalProbeLineByte()
{
    QVariantMap payload;
    payload[QStringLiteral("ok")] = true;
    payload[QStringLiteral("url")] = QStringLiteral("http://h:3001/api/health?x=1");
    const QByteArray line = formatDiagLine(QStringLiteral("probe"), payload, 0);

    // Printed on every run so the side-by-side comparison lives in the build log itself and
    // an auditor never has to take this file's word for it.
    qInfo("canonical: %s", QByteArray(kCanonicalProbeLine).trimmed().constData());
    qInfo("qt       : %s", line.trimmed().constData());

    QCOMPARE(line, QByteArray(kCanonicalProbeLine));
}

void DiagTest::matchesTheCanonicalRedaction_data()
{
    QTest::addColumn<QString>("input");
    QTest::addColumn<QString>("expected");

    // Left column: what was fed to client/diag.js. Right column: what it answered (measured).
    QTest::newRow("query") << "http://h:3001/api/health?x=1" << "http://h:3001/api/health";
    QTest::newRow("no path") << "http://h" << "http://h/";
    QTest::newRow("root path") << "http://h/" << "http://h/";
    QTest::newRow("default port") << "http://h:80/api/health" << "http://h/api/health";
    QTest::newRow("fragment") << "https://h/a/b?q=1#frag" << "https://h/a/b";
    QTest::newRow("ipv6") << "http://[::1]:3001/a?b=1" << "http://[::1]:3001/a";
    QTest::newRow("case") << "HTTP://H:3001/A?b=1" << "http://h:3001/A";
    QTest::newRow("file") << "file:///C:/a/app.html" << "file:///app.html";
    QTest::newRow("file dir") << "file:///dir/" << "file:///";
    QTest::newRow("about blank") << "about:blank" << "about:blank";
    QTest::newRow("mailto") << "mailto:user@h" << "mailto:";  // R12: the colon is part of it
    QTest::newRow("ftp") << "ftp://h/x?y=1" << "ftp:";
    QTest::newRow("data") << "data:text/plain,hello" << "data:";
    QTest::newRow("chrome-error") << "chrome-error://x/y" << "chrome-error:";
    // R9 (fail-open) - the canonical suite locks none of these: a value that is not an
    // absolute URL comes back untouched, because a non-URL cannot carry a query string.
    QTest::newRow("not a url") << "not a url" << "not a url";
    QTest::newRow("relative") << "/api/articles/5?x=1" << "/api/articles/5?x=1";
    QTest::newRow("empty") << "" << "";
}

void DiagTest::matchesTheCanonicalRedaction()
{
    QFETCH(QString, input);
    QFETCH(QString, expected);

    QCOMPARE(redactUrl(input), expected);
    QCOMPARE(redactedUrlField(QStringLiteral("url"), input), expected);
}

void DiagTest::endsWithExactlyOneNewlineAndNoCarriageReturn()
{
    QVariantMap payload;
    payload[QStringLiteral("count")] = 3;
    const QByteArray line = formatDiagLine(QStringLiteral("list-loaded"), payload, 1757462400000LL);

    QVERIFY(line.endsWith('\n'));
    QVERIFY(!line.chopped(1).contains('\n'));  // exactly one, and it is the last byte
    QVERIFY(!line.contains('\r'));             // the judge splits on '\n' only
    QVERIFY(!parseLine(line).isEmpty());
    QCOMPARE(parseLine(line).value(QStringLiteral("ts")).toString(),
             QStringLiteral("2025-09-10T00:00:00.000Z"));
}

void DiagTest::putsTsThenEventThenTheRestOfThePayload()
{
    QVariantMap payload;
    payload[QStringLiteral("origin")] = QStringLiteral("http://h:3001");
    const QByteArray line = formatDiagLine(QStringLiteral("probe"), payload, 0);

    QVERIFY2(line.startsWith(R"json({"ts":"1970-01-01T00:00:00.000Z","event":"probe",)json"),
             line.constData());
}

void DiagTest::encodesNonAsciiTextAsUtf8()
{
    const QString menu = QString::fromUtf8("\xEB\x8D\xB0\xEC\x8A\xA4\xED\x81\xAC");  // "desk" in Hangul
    QVariantMap payload;
    payload[QStringLiteral("menu")] = menu;

    const QByteArray line = formatDiagLine(QStringLiteral("list-loaded"), payload, 0);
    // QJsonDocument::fromJson decodes UTF-8; a line written in any other encoding fails here.
    QCOMPARE(parseLine(line).value(QStringLiteral("menu")).toString(), menu);
}

// Canonical R2, locked by nothing today: the payload is spread AFTER ts/event, so a payload
// key of that name wins. Reproduced on purpose - see README ("정본과의 의도적 이탈").
void DiagTest::letsThePayloadOverrideTsAndEvent()
{
    QVariantMap payload;
    payload[QStringLiteral("ts")] = QStringLiteral("PAYLOAD-TS");
    payload[QStringLiteral("event")] = QStringLiteral("PAYLOAD-EVENT");
    payload[QStringLiteral("z")] = 1;

    QCOMPARE(formatDiagLine(QStringLiteral("probe"), payload, 0),
             QByteArray(R"json({"ts":"PAYLOAD-TS","event":"PAYLOAD-EVENT","z":1})json"
                        "\n"));
}

// ---------------------------------------------------------------------------------------
// forbidden keys
// ---------------------------------------------------------------------------------------

void DiagTest::dropsEveryForbiddenKey_data()
{
    QTest::addColumn<QString>("key");

    // All seven, one row each. The canonical JS suite covers five - "cookies" and "headers"
    // have never been exercised by any test or call site (rule R4), so a port that moved
    // only five keys would have looked green.
    QTest::newRow("body") << "body";
    QTest::newRow("sessionId") << "sessionId";
    QTest::newRow("cookie") << "cookie";
    QTest::newRow("cookies") << "cookies";
    QTest::newRow("password") << "password";
    QTest::newRow("token") << "token";
    QTest::newRow("headers") << "headers";
}

void DiagTest::dropsEveryForbiddenKey()
{
    QFETCH(QString, key);

    QVariantMap payload;
    payload[key] = QStringLiteral("SECRET");
    payload[QStringLiteral("keep")] = 1;

    const QVariantMap redacted = redactDiagEvent(QStringLiteral("probe"), payload);
    QVERIFY2(!redacted.contains(key), qPrintable(key));
    QCOMPARE(redacted.value(QStringLiteral("keep")).toInt(), 1);

    const QByteArray line = formatDiagLine(QStringLiteral("probe"), payload, 0);
    QVERIFY2(!line.contains("SECRET"), line.constData());
}

// Canonical R3: the set is matched with exact case, so "Token" and "Body" survive. Measured
// against client/diag.js, and kept on purpose - see README. The real invariant is not this
// filter but the caller discipline (D-N3): payloads are built from named literal fields.
void DiagTest::matchesForbiddenKeysCaseSensitively()
{
    QVariantMap payload;
    payload[QStringLiteral("Body")] = QStringLiteral("x");
    payload[QStringLiteral("SESSIONID")] = QStringLiteral("x");
    payload[QStringLiteral("Token")] = QStringLiteral("x");

    const QVariantMap redacted = redactDiagEvent(QStringLiteral("probe"), payload);
    QCOMPARE(int(redacted.size()), 3);
    QVERIFY(redacted.contains(QStringLiteral("Body")));
    QVERIFY(redacted.contains(QStringLiteral("SESSIONID")));
    QVERIFY(redacted.contains(QStringLiteral("Token")));
}

// ---------------------------------------------------------------------------------------
// value whitelist
// ---------------------------------------------------------------------------------------

void DiagTest::dropsObjectAndArrayValues()
{
    QVariantMap nested;
    nested[QStringLiteral("a")] = 1;
    QVariantList list;
    list << 1 << 2;

    QVariantMap payload;
    payload[QStringLiteral("obj")] = nested;
    payload[QStringLiteral("arr")] = list;
    payload[QStringLiteral("s")] = QStringLiteral("k");

    const QVariantMap redacted = redactDiagEvent(QStringLiteral("probe"), payload);
    QCOMPARE(redacted.keys(), QStringList{QStringLiteral("s")});
}

void DiagTest::dropsValuesOutsideTheScalarWhitelist_data()
{
    QTest::addColumn<QVariant>("value");
    QTest::addColumn<bool>("kept");

    QTest::newRow("string") << QVariant(QStringLiteral("x")) << true;
    QTest::newRow("bytes") << QVariant(QByteArray("x")) << true;  // the C++ spelling of a string
    QTest::newRow("int") << QVariant(42) << true;
    QTest::newRow("longlong") << QVariant(qint64(42)) << true;
    QTest::newRow("double") << QVariant(1.5) << true;
    QTest::newRow("bool") << QVariant(false) << true;
    QTest::newRow("null") << QVariant() << true;
    QTest::newRow("map") << QVariant(QVariantMap()) << false;
    QTest::newRow("list") << QVariant(QVariantList()) << false;
    QTest::newRow("stringlist") << QVariant(QStringList{QStringLiteral("a")}) << false;
    QTest::newRow("datetime") << QVariant(QDateTime::fromMSecsSinceEpoch(0)) << false;
    QTest::newRow("url") << QVariant(QUrl(QStringLiteral("http://h/"))) << false;
}

void DiagTest::dropsValuesOutsideTheScalarWhitelist()
{
    QFETCH(QVariant, value);
    QFETCH(bool, kept);

    QVariantMap payload;
    payload[QStringLiteral("v")] = value;

    QCOMPARE(redactDiagEvent(QStringLiteral("probe"), payload).contains(QStringLiteral("v")), kept);
}

// Canonical R6 (null passes the object check on purpose) - locked by no canonical test even
// though step4.md's AC names it. "undefined" has no C++ spelling: an absent field is the
// port's equivalent, and an invalid QVariant maps to JSON null.
void DiagTest::keepsNullAndOmitsAbsentFields()
{
    QVariantMap payload;
    payload[QStringLiteral("n")] = QVariant();

    QCOMPARE(formatDiagLine(QStringLiteral("probe"), payload, 0),
             QByteArray(R"json({"ts":"1970-01-01T00:00:00.000Z","event":"probe","n":null})json"
                        "\n"));

    const QJsonObject parsed = parseLine(formatDiagLine(QStringLiteral("probe"), payload, 0));
    QVERIFY(parsed.value(QStringLiteral("n")).isNull());
    QVERIFY(!parsed.contains(QStringLiteral("absent")));
}

// Canonical D-N2: NaN/Infinity pass the type whitelist but JSON.stringify writes them as
// null. Measured on client/diag.js; reproduced here rather than assumed.
void DiagTest::writesNonFiniteNumbersAsNull()
{
    QVariantMap payload;
    payload[QStringLiteral("a_nan")] = std::numeric_limits<double>::quiet_NaN();
    payload[QStringLiteral("b_inf")] = std::numeric_limits<double>::infinity();
    payload[QStringLiteral("c_ninf")] = -std::numeric_limits<double>::infinity();

    QCOMPARE(formatDiagLine(QStringLiteral("probe"), payload, 0),
             QByteArray(R"json({"ts":"1970-01-01T00:00:00.000Z","event":"probe",)json"
                        R"json("a_nan":null,"b_inf":null,"c_ninf":null})json"
                        "\n"));
}

// ---------------------------------------------------------------------------------------
// URL redaction
// ---------------------------------------------------------------------------------------

void DiagTest::redactsUrlKeysToOriginAndPath_data()
{
    QTest::addColumn<QString>("input");
    QTest::addColumn<QString>("expected");

    QTest::newRow("token in query") << "https://h/api/articles?token=abc#f" << "https://h/api/articles";
    QTest::newRow("article id in query") << "http://h:3001/api/articles?id=42" << "http://h:3001/api/articles";
    QTest::newRow("https default port") << "https://h:443/a?b=1" << "https://h/a";
    QTest::newRow("explicit port kept") << "https://h:8443/a?b=1" << "https://h:8443/a";
    // Port-level divergence (README): the canonical infers a host for "http:/x" (WHATWG folds
    // the slashes), QUrl does not. Answering with the scheme keeps the query off the log
    // either way - fail-open on a half-parsed URL would be the one place a query survives.
    QTest::newRow("hostless http") << "http:/x?secret=1" << "http:";
}

void DiagTest::redactsUrlKeysToOriginAndPath()
{
    QFETCH(QString, input);
    QFETCH(QString, expected);

    QCOMPARE(redactUrl(input), expected);
}

// Canonical R7 uses includes('url'), not endsWith - "hourly" matches too. A port written with
// QString::endsWith would redact a different set of fields; the canonical suite only ever
// used the key "url", so nothing locked this before.
void DiagTest::matchesUrlKeysBySubstringNotSuffix()
{
    const QString raw = QStringLiteral("http://h/a?b=1");
    QCOMPARE(redactedUrlField(QStringLiteral("hourly"), raw), QStringLiteral("http://h/a"));
    QCOMPARE(redactedUrlField(QStringLiteral("imageUrl"), raw), QStringLiteral("http://h/a"));
    QCOMPARE(redactedUrlField(QStringLiteral("URL"), raw), QStringLiteral("http://h/a"));
    QCOMPARE(redactedUrlField(QStringLiteral("origin"), raw), raw);  // no "url" in the name
}

void DiagTest::redactsOnlyStringUrlValues()
{
    QVariantMap payload;
    payload[QStringLiteral("url")] = 42;

    QCOMPARE(redactDiagEvent(QStringLiteral("probe"), payload).value(QStringLiteral("url")).toInt(),
             42);
}

// ---------------------------------------------------------------------------------------
// event catalogue
// ---------------------------------------------------------------------------------------

void DiagTest::allowsExactlyTheDispositionTable()
{
    QStringList expected{
        // inherited (8) - same name, same meaning as client/main.js
        QStringLiteral("app-ready"), QStringLiteral("config-loaded"), QStringLiteral("config-saved"),
        QStringLiteral("probe"), QStringLiteral("restart-required"), QStringLiteral("second-instance"),
        QStringLiteral("setup-shown"), QStringLiteral("window-open"),
        // remapped (4) - renderer concept -> native screen
        QStringLiteral("app-window"), QStringLiteral("did-finish-load"),
        QStringLiteral("load-failed"), QStringLiteral("local-window"),
        // new (9) - what the P4 gate needs to judge
        QStringLiteral("list-loaded"), QStringLiteral("login"), QStringLiteral("net-request"),
        QStringLiteral("session"), QStringLiteral("sse-change"), QStringLiteral("sse-closed"),
        QStringLiteral("sse-open"), QStringLiteral("sse-ready"), QStringLiteral("sse-unauthorized")};
    expected.sort();

    QStringList actual(shell::allowedDiagEvents().begin(), shell::allowedDiagEvents().end());
    actual.sort();

    QCOMPARE(actual, expected);
    QCOMPARE(int(actual.size()), 21);
}

// Canonical R19: six names describe a renderer process, a Chromium command-line switch or a
// contextBridge - none of which exists here. Emitting them would make the judge read a
// signal that never happened.
void DiagTest::keepsTheExtinctElectronEventsOut()
{
    const QStringList extinct{QStringLiteral("secure-origin-switch"), QStringLiteral("navigation"),
                              QStringLiteral("ipc"),      QStringLiteral("render-process-gone"),
                              QStringLiteral("unresponsive"), QStringLiteral("did-navigate")};
    for (const QString &name : extinct)
        QVERIFY2(!shell::isAllowedDiagEvent(name), qPrintable(name));
}

void DiagTest::refusesToWriteAnEventOutsideTheAllowedSet()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));

    Diag diag(path);
    diag.log(QStringLiteral("editor-opened"), {});  // a P5 name: outside P4's boundary
    diag.log(QStringLiteral("ipc"), {});            // an extinct Electron name

    QCOMPARE(diag.rejectedEventCount(), 2);
    QVERIFY2(!QFile::exists(path), "a refused event must not even create the file");

    diag.log(QStringLiteral("app-ready"), {});
    QCOMPARE(diag.rejectedEventCount(), 2);
    QCOMPARE(int(readAll(path).count('\n')), 1);
}

// ---------------------------------------------------------------------------------------
// P4 leak rules (step4.md C)
// ---------------------------------------------------------------------------------------

void DiagTest::dropsRouteValuesThatCarryAConcreteId_data()
{
    QTest::addColumn<QString>("route");
    QTest::addColumn<QString>("expected");

    const QString marker = QStringLiteral("<invalid-route>");
    QTest::newRow("route id") << "articles-list" << "articles-list";
    QTest::newRow("template") << "/api/articles/:id" << "/api/articles/:id";
    QTest::newRow("static") << "/api/articles" << "/api/articles";
    QTest::newRow("two params") << "/api/articles/:id/history/:historyId"
                                << "/api/articles/:id/history/:historyId";
    QTest::newRow("concrete id") << "/api/articles/42" << marker;
    QTest::newRow("concrete id mid") << "/api/articles/42/history" << marker;
    QTest::newRow("absolute url") << "http://h:3001/api/articles/42" << marker;
    QTest::newRow("empty") << "" << marker;
}

void DiagTest::dropsRouteValuesThatCarryAConcreteId()
{
    QFETCH(QString, route);
    QFETCH(QString, expected);

    QVariantMap payload;
    payload[QStringLiteral("route")] = route;
    payload[QStringLiteral("method")] = QStringLiteral("GET");
    payload[QStringLiteral("status")] = 200;
    payload[QStringLiteral("ms")] = 12;

    const QVariantMap redacted = redactDiagEvent(QStringLiteral("net-request"), payload);
    QCOMPARE(redacted.value(QStringLiteral("route")).toString(), expected);
}

void DiagTest::keepsOnlyTheContractedFieldsOfTheNewEvents()
{
    QVariantMap request;
    request[QStringLiteral("route")] = QStringLiteral("articles-list");
    request[QStringLiteral("method")] = QStringLiteral("GET");
    request[QStringLiteral("status")] = 200;
    request[QStringLiteral("ms")] = 12;
    request[QStringLiteral("note")] = QStringLiteral("free text");

    QStringList keys = redactDiagEvent(QStringLiteral("net-request"), request).keys();
    keys.sort();
    QCOMPARE(keys,
             (QStringList{QStringLiteral("method"), QStringLiteral("ms"), QStringLiteral("route"),
                          QStringLiteral("status")}));

    // login/session carry the HTTP status and nothing else - no role, no user id, no reason.
    QVariantMap login;
    login[QStringLiteral("status")] = 423;
    login[QStringLiteral("role")] = QStringLiteral("D");
    login[QStringLiteral("userId")] = 7;

    QCOMPARE(redactDiagEvent(QStringLiteral("login"), login).keys(),
             QStringList{QStringLiteral("status")});
    QCOMPARE(redactDiagEvent(QStringLiteral("session"), login).keys(),
             QStringList{QStringLiteral("status")});

    // The list reports a count, never a headline.
    QVariantMap list;
    list[QStringLiteral("menu")] = QStringLiteral("deskUnsent");
    list[QStringLiteral("count")] = 10;
    list[QStringLiteral("first")] = QStringLiteral("a headline");
    keys = redactDiagEvent(QStringLiteral("list-loaded"), list).keys();
    keys.sort();
    QCOMPARE(keys, (QStringList{QStringLiteral("count"), QStringLiteral("menu")}));
}

void DiagTest::dropsArticleAndUserTextFields_data()
{
    QTest::addColumn<QString>("key");

    // step4.md C: no article headline, no article body and no user name, in any event. The
    // match is case-insensitive because this set is this port's own rule, not the canonical's
    // (whose seven keys stay case-sensitive - see matchesForbiddenKeysCaseSensitively).
    QTest::newRow("title") << "title";
    QTest::newRow("Title") << "Title";
    QTest::newRow("content") << "content";
    QTest::newRow("TEXT") << "TEXT";
    QTest::newRow("name") << "name";
    QTest::newRow("username") << "username";
    QTest::newRow("userName") << "userName";
}

void DiagTest::dropsArticleAndUserTextFields()
{
    QFETCH(QString, key);

    QVariantMap payload;
    payload[key] = QStringLiteral("SECRET");
    payload[QStringLiteral("count")] = 1;

    const QVariantMap redacted = redactDiagEvent(QStringLiteral("probe"), payload);
    QVERIFY2(!redacted.contains(key), qPrintable(key));
    QCOMPARE(redacted.value(QStringLiteral("count")).toInt(), 1);
}

// ---------------------------------------------------------------------------------------
// sink
// ---------------------------------------------------------------------------------------

// step4.md AC: without CLIENT_DIAG_FILE the module is a complete no-op - it does not even
// create a file. init() has already removed the variable from this process.
void DiagTest::writesNothingWithoutADiagFile()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());

    Diag diag(shell::diagFilePathFromEnvironment());
    QVERIFY(!diag.isEnabled());
    diag.log(QStringLiteral("app-ready"), {});
    diag.log(QStringLiteral("probe"), {});

    QCOMPARE(int(QDir(dir.path()).entryList(QDir::AllEntries | QDir::NoDotAndDotDot).size()), 0);
    QCOMPARE(diag.rejectedEventCount(), 0);  // refusing to write is not "unknown event"
}

void DiagTest::readsThePathFromClientDiagFile()
{
    QCOMPARE(shell::diagFilePathFromEnvironment(), QString());

    qputenv("CLIENT_DIAG_FILE", QByteArray("C:/tmp/diag.jsonl"));
    QCOMPARE(shell::diagFilePathFromEnvironment(), QStringLiteral("C:/tmp/diag.jsonl"));

    qputenv("CLIENT_DIAG_FILE", QByteArray("   "));
    QCOMPARE(shell::diagFilePathFromEnvironment(), QString());
}

// Canonical R16, locked by nothing today: the append is synchronous. A queue or a debounce
// would leave a healthy app timing the driver out, because waitForSequence() polls the file
// for the LAST event of a sequence.
void DiagTest::appendsEachLineBeforeLogReturns()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));

    Diag diag(path);
    QVERIFY(diag.isEnabled());

    diag.log(QStringLiteral("app-ready"), {});
    QCOMPARE(int(readAll(path).count('\n')), 1);  // already on disk, before any destructor runs

    QVariantMap payload;
    payload[QStringLiteral("hasServerUrl")] = true;
    diag.log(QStringLiteral("config-loaded"), payload);
    QCOMPARE(int(readAll(path).count('\n')), 2);
    QVERIFY(readAll(path).contains(R"json("event":"config-loaded")json"));
}

// Canonical R17: the path comes from the environment and no directory is ever created, so a
// missing directory means the append fails and R15 swallows it - silently no lines at all.
void DiagTest::swallowsWriteFailuresOnAMissingDirectory()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = QDir(dir.path()).filePath(QStringLiteral("nope/deep/diag.jsonl"));

    Diag diag(path);
    diag.log(QStringLiteral("app-ready"), {});  // must not throw, abort or create anything

    QVERIFY(!QFile::exists(path));
    QCOMPARE(int(QDir(dir.path()).entryList(QDir::AllEntries | QDir::NoDotAndDotDot).size()), 0);
}

// Format interop: read the file back exactly the way scripts/verify-client.mjs does
// (readDiag, line 94: split on '\n', drop empties, JSON.parse each) and check every line
// parses and carries an "event" field.
void DiagTest::writesLinesTheJudgeCanParse()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = QDir(dir.path()).filePath(QStringLiteral("diag.jsonl"));

    Diag diag(path);
    diag.log(QStringLiteral("app-ready"), {});

    QVariantMap probe;
    probe[QStringLiteral("ok")] = true;
    probe[QStringLiteral("url")] = QStringLiteral("http://h:3001/api/health?x=1");
    diag.log(QStringLiteral("probe"), probe);

    QVariantMap request;
    request[QStringLiteral("route")] = QStringLiteral("articles-list");
    request[QStringLiteral("method")] = QStringLiteral("GET");
    request[QStringLiteral("status")] = 200;
    request[QStringLiteral("ms")] = 7;
    diag.log(QStringLiteral("net-request"), request);

    const QByteArray text = readAll(path);
    QVERIFY(!text.contains('\r'));

    QStringList events;
    const QList<QByteArray> lines = text.trimmed().split('\n');
    for (const QByteArray &line : lines) {
        if (line.isEmpty())
            continue;
        const QJsonObject object = parseLine(line);
        QVERIFY2(!object.isEmpty(), line.constData());
        QVERIFY2(object.contains(QStringLiteral("event")), line.constData());
        QVERIFY2(object.contains(QStringLiteral("ts")), line.constData());
        events << object.value(QStringLiteral("event")).toString();
    }

    QCOMPARE(events,
             (QStringList{QStringLiteral("app-ready"), QStringLiteral("probe"),
                          QStringLiteral("net-request")}));
}
