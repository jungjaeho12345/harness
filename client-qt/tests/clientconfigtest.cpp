#include "clientconfigtest.h"

#include "shell/clientconfig.h"

#include <QByteArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QList>
#include <QRect>
#include <QString>
#include <QStringList>
#include <QtTest>

using shell::Bounds;
using shell::ClientConfig;

namespace {

QString describe(const Bounds &b)
{
    if (!b.valid)
        return QStringLiteral("<no bounds>");
    return QStringLiteral("%1x%2+%3+%4 maximized=%5")
        .arg(b.width)
        .arg(b.height)
        .arg(b.x)
        .arg(b.y)
        .arg(b.maximized ? QStringLiteral("true") : QStringLiteral("false"));
}

Bounds makeBounds(int width, int height, int x, int y, bool maximized = false)
{
    Bounds b;
    b.width = width;
    b.height = height;
    b.x = x;
    b.y = y;
    b.maximized = maximized;
    b.valid = true;
    return b;
}

// A whole config file built around one "bounds" value, so a row only has to spell the part
// it is about.
QByteArray fileWithBounds(const QByteArray &boundsJson)
{
    return QByteArray(R"({"schemaVersion":1,"serverUrl":"http://h:3001","bounds":)")
        + boundsJson + QByteArray("}");
}

QStringList sortedKeys(const QJsonObject &object)
{
    QStringList keys = object.keys();
    keys.sort();
    return keys;
}

QJsonObject reparse(const QByteArray &serialized)
{
    QJsonParseError error{};
    const QJsonDocument doc = QJsonDocument::fromJson(serialized, &error);
    if (error.error != QJsonParseError::NoError || !doc.isObject())
        return QJsonObject();
    return doc.object();
}

} // namespace

namespace QTest {
template<>
char *toString(const Bounds &bounds)
{
    return qstrdup(describe(bounds).toUtf8().constData());
}
} // namespace QTest

// ---------------------------------------------------------------------------
// R3: parseConfig never fails. Everything unusable converges on the defaults.
void ClientConfigTest::parsesUnusableInputIntoDefaults_data()
{
    QTest::addColumn<QByteArray>("raw");

    // --- lifted from test/client-shell-core.test.js:147-151 ---
    QTest::newRow("empty") << QByteArray("");
    QTest::newRow("broken JSON") << QByteArray("{oops");
    QTest::newRow("array") << QByteArray("[1,2]");
    QTest::newRow("number") << QByteArray("42");
    QTest::newRow("null literal") << QByteArray("null");
    QTest::newRow("bare string") << QByteArray("\"str\"");
    // The canonical also feeds null/undefined; the closest reachable member of that class
    // through a QByteArray signature is a null QByteArray.
    QTest::newRow("null QByteArray") << QByteArray();
    QTest::newRow("whitespace only") << QByteArray("   \r\n\t ");

    // --- Qt-only rows ---
    // QJsonDocument::fromJson takes bytes, not an already decoded string: a file with
    // broken UTF-8 reaches the parser as garbage bytes and must not crash it.
    QTest::newRow("[qt] invalid UTF-8 bytes") << QByteArray("\xff\xfe{\"serverUrl\":\"http://h\"}");
    QTest::newRow("[qt] boolean literal") << QByteArray("true");
    QTest::newRow("[qt] truncated object") << QByteArray("{\"serverUrl\":");
}

void ClientConfigTest::parsesUnusableInputIntoDefaults()
{
    QFETCH(QByteArray, raw);

    const ClientConfig cfg = shell::parseConfig(raw);

    QCOMPARE(cfg.schemaVersion, shell::kConfigSchemaVersion);
    QVERIFY2(cfg.serverUrl.isEmpty(), qPrintable(cfg.serverUrl));
    QCOMPARE(cfg.bounds, Bounds());
    QCOMPARE(cfg, ClientConfig());
}

// ---------------------------------------------------------------------------
// R1/R2/C-N2 (security CRITICAL): the whitelist, top level and inside "bounds".
void ClientConfigTest::dropsEveryKeyOutsideTheWhitelist()
{
    const QByteArray raw = R"({
      "schemaVersion": 1,
      "serverUrl": "http://h:3001",
      "sessionId": "abc",
      "password": "pw-leak",
      "cookie": "x",
      "token": "t-leak",
      "junk": 1,
      "bounds": { "width": 1440, "height": 900, "x": 0, "y": 0, "maximized": false,
                  "secret": "secret-leak" }
    })";

    const ClientConfig parsed = shell::parseConfig(raw);
    QCOMPARE(parsed.serverUrl, QStringLiteral("http://h:3001"));
    QCOMPARE(parsed.bounds, makeBounds(1440, 900, 0, 0, false));

    // The struct has no room for an unknown key, so the observable proof is what comes back
    // out: re-serialising the parse result must not carry a single foreign key or value.
    const QByteArray out = shell::serializeConfig(parsed);
    const QJsonObject object = reparse(out);
    QCOMPARE(sortedKeys(object),
             QStringList({QStringLiteral("bounds"), QStringLiteral("schemaVersion"),
                          QStringLiteral("serverUrl")}));
    QCOMPARE(sortedKeys(object.value(QStringLiteral("bounds")).toObject()),
             QStringList({QStringLiteral("height"), QStringLiteral("maximized"),
                          QStringLiteral("width"), QStringLiteral("x"), QStringLiteral("y")}));
    for (const char *forbidden : {"sessionId", "password", "cookie", "token", "junk", "secret",
                                  "abc", "leak"}) {
        QVERIFY2(!out.contains(forbidden),
                 qPrintable(QStringLiteral("serialized config still carries %1")
                                .arg(QLatin1String(forbidden))));
    }
}

// ---------------------------------------------------------------------------
// R4: serverUrl is re-validated on read (a hand-edited file is not trusted) and stored
// re-normalised through step2's normalizeServerUrl.
void ClientConfigTest::revalidatesServerUrlWhenReading_data()
{
    QTest::addColumn<QByteArray>("raw");
    QTest::addColumn<QString>("serverUrl");

    // --- lifted from test/client-shell-core.test.js:169-179 ---
    QTest::newRow("re-normalised to an origin")
        << QByteArray(R"({"schemaVersion":1,"serverUrl":"HTTP://H:3001/login.do?x=1"})")
        << QStringLiteral("http://h:3001");
    QTest::newRow("unsupported scheme is dropped")
        << QByteArray(R"json({"schemaVersion":1,"serverUrl":"javascript:alert(1)"})json")
        << QString();
    QTest::newRow("garbage string is dropped")
        << QByteArray(R"({"schemaVersion":1,"serverUrl":"not a url"})") << QString();
    QTest::newRow("number is dropped without calling the normaliser")
        << QByteArray(R"({"schemaVersion":1,"serverUrl":42})") << QString();
    QTest::newRow("object is dropped")
        << QByteArray(R"({"schemaVersion":1,"serverUrl":{"origin":"http://h"}})") << QString();

    // --- Qt-only rows ---
    QTest::newRow("[qt] JSON null is dropped")
        << QByteArray(R"({"schemaVersion":1,"serverUrl":null})") << QString();
    QTest::newRow("[qt] absent key stays empty") << QByteArray(R"({"schemaVersion":1})")
                                                 << QString();
    QTest::newRow("[qt] bare IP:port gets its scheme")
        << QByteArray(R"({"schemaVersion":1,"serverUrl":"192.168.0.10:3001"})")
        << QStringLiteral("http://192.168.0.10:3001");
    QTest::newRow("[qt] surrounding spaces are trimmed by the normaliser")
        << QByteArray(R"({"schemaVersion":1,"serverUrl":"  http://h:3001  "})")
        << QStringLiteral("http://h:3001");
    QTest::newRow("[qt] credentials in the stored value are refused")
        << QByteArray(R"({"schemaVersion":1,"serverUrl":"http://u:p@h:3001"})") << QString();
}

void ClientConfigTest::revalidatesServerUrlWhenReading()
{
    QFETCH(QByteArray, raw);
    QFETCH(QString, serverUrl);

    QCOMPARE(shell::parseConfig(raw).serverUrl, serverUrl);
}

// ---------------------------------------------------------------------------
// R6: a broken field does not kill the rest of the file.
void ClientConfigTest::scopesParseFailuresPerField_data()
{
    QTest::addColumn<QByteArray>("boundsJson");

    // --- lifted from test/client-shell-core.test.js:181-187 ---
    QTest::newRow("string") << QByteArray("\"big\"");
    QTest::newRow("array") << QByteArray("[1]");
    QTest::newRow("non-integer width") << QByteArray(R"({"width":"x","height":900,"x":0,"y":0})");
    QTest::newRow("missing keys") << QByteArray(R"({"width":1440})");
}

void ClientConfigTest::scopesParseFailuresPerField()
{
    QFETCH(QByteArray, boundsJson);

    const ClientConfig parsed = shell::parseConfig(fileWithBounds(boundsJson));

    QCOMPARE(parsed.bounds, Bounds());
    QCOMPARE(parsed.serverUrl, QStringLiteral("http://h:3001"));
}

// ---------------------------------------------------------------------------
// R5: accepted rectangles. Structure only - no monitor is consulted here.
void ClientConfigTest::acceptsStoredBoundsShape_data()
{
    QTest::addColumn<QByteArray>("boundsJson");
    QTest::addColumn<int>("width");
    QTest::addColumn<int>("height");
    QTest::addColumn<int>("x");
    QTest::addColumn<int>("y");
    QTest::addColumn<bool>("maximized");

    QTest::newRow("ordinary rectangle")
        << QByteArray(R"({"width":1440,"height":900,"x":12,"y":34,"maximized":false})") << 1440
        << 900 << 12 << 34 << false;
    QTest::newRow("maximized is a strict boolean true")
        << QByteArray(R"({"width":1440,"height":900,"x":0,"y":0,"maximized":true})") << 1440 << 900
        << 0 << 0 << true;
    QTest::newRow("string \"true\" is not true")
        << QByteArray(R"({"width":1440,"height":900,"x":0,"y":0,"maximized":"true"})") << 1440
        << 900 << 0 << 0 << false;
    QTest::newRow("number 1 is not true")
        << QByteArray(R"({"width":1440,"height":900,"x":0,"y":0,"maximized":1})") << 1440 << 900
        << 0 << 0 << false;
    QTest::newRow("absent maximized is false")
        << QByteArray(R"({"width":1440,"height":900,"x":0,"y":0})") << 1440 << 900 << 0 << 0
        << false;
    QTest::newRow("negative coordinates (secondary monitor)")
        << QByteArray(R"({"width":1024,"height":720,"x":-1800,"y":100,"maximized":false})") << 1024
        << 720 << -1800 << 100 << false;
    // Port spec X5: 800x600 is the *storage* lower bound (clientConfig.js:14-15). The window
    // minimum is 1024x720 (windowPolicy.js:41-42) and belongs to step5 - the two constants
    // stay separate, so a stored 850x650 passing here is the correct answer, not a bug.
    QTest::newRow("850x650 passes the storage bound (window minimum is step5's)")
        << QByteArray(R"({"width":850,"height":650,"x":0,"y":0})") << 850 << 650 << 0 << 0 << false;
    QTest::newRow("exactly at the storage bound")
        << QByteArray(R"({"width":800,"height":600,"x":0,"y":0})") << 800 << 600 << 0 << 0 << false;
    // [qt] JSON has one number type: 1440.0 is the integer 1440, unlike 1440.5 below.
    QTest::newRow("[qt] whole number written with a fraction part")
        << QByteArray(R"({"width":1440.0,"height":900.0,"x":0.0,"y":0.0})") << 1440 << 900 << 0 << 0
        << false;
    QTest::newRow("[qt] negative zero coordinates")
        << QByteArray(R"({"width":1440,"height":900,"x":-0,"y":0})") << 1440 << 900 << 0 << 0
        << false;
}

void ClientConfigTest::acceptsStoredBoundsShape()
{
    QFETCH(QByteArray, boundsJson);
    QFETCH(int, width);
    QFETCH(int, height);
    QFETCH(int, x);
    QFETCH(int, y);
    QFETCH(bool, maximized);

    const ClientConfig parsed = shell::parseConfig(fileWithBounds(boundsJson));
    QCOMPARE(parsed.bounds, makeBounds(width, height, x, y, maximized));
}

// ---------------------------------------------------------------------------
// R5: rejected rectangles. One failure drops the whole rectangle - never a partial fill.
void ClientConfigTest::rejectsStoredBoundsShape_data()
{
    QTest::addColumn<QByteArray>("boundsJson");

    // --- lifted from test/client-shell-core.test.js:246-252 ---
    QTest::newRow("width below the storage bound")
        << QByteArray(R"({"width":799,"height":900,"x":0,"y":0,"maximized":false})");
    QTest::newRow("height below the storage bound")
        << QByteArray(R"({"width":1440,"height":599,"x":0,"y":0,"maximized":false})");
    QTest::newRow("fractional width")
        << QByteArray(R"({"width":1440.5,"height":900,"x":0,"y":0,"maximized":false})");
    QTest::newRow("fractional x")
        << QByteArray(R"({"width":1440,"height":900,"x":0.1,"y":0,"maximized":false})");

    // --- Qt-only rows ---
    // QJsonValue::toInt() truncates silently and returns 0 for a wrong type: every one of
    // these rows is green in a port that trusts it.
    QTest::newRow("[qt] boolean width") << QByteArray(R"({"width":true,"height":900,"x":0,"y":0})");
    QTest::newRow("[qt] null height")
        << QByteArray(R"({"width":1440,"height":null,"x":0,"y":0})");
    QTest::newRow("[qt] numeric string width")
        << QByteArray(R"({"width":"1440","height":900,"x":0,"y":0})");
    QTest::newRow("[qt] missing y") << QByteArray(R"({"width":1440,"height":900,"x":0})");
    QTest::newRow("[qt] out of int range")
        << QByteArray(R"({"width":1e12,"height":900,"x":0,"y":0})");
    QTest::newRow("[qt] nested object as width")
        << QByteArray(R"({"width":{"v":1440},"height":900,"x":0,"y":0})");
    QTest::newRow("[qt] JSON null bounds") << QByteArray("null");
    QTest::newRow("[qt] number as bounds") << QByteArray("42");
    QTest::newRow("[qt] negative width") << QByteArray(R"({"width":-1440,"height":900,"x":0,"y":0})");
}

void ClientConfigTest::rejectsStoredBoundsShape()
{
    QFETCH(QByteArray, boundsJson);

    QCOMPARE(shell::parseConfig(fileWithBounds(boundsJson)).bounds, Bounds());
}

// ---------------------------------------------------------------------------
// C-N1: the stored schemaVersion is never read. No version check, no migration, no refusal
// of a future schema - there is none in the canonical (clientConfig.js:50 overwrites it
// with the current constant), so there is none here. Locking it keeps a later "helpful"
// migration from appearing without a decision.
void ClientConfigTest::ignoresTheStoredSchemaVersion()
{
    const QByteArray body = R"("serverUrl":"http://h:3001","bounds":{"width":1440,"height":900,"x":0,"y":0}})";

    const ClientConfig current = shell::parseConfig(QByteArray(R"({"schemaVersion":1,)") + body);
    const ClientConfig future = shell::parseConfig(QByteArray(R"({"schemaVersion":99,)") + body);
    const ClientConfig corrupt =
        shell::parseConfig(QByteArray(R"({"schemaVersion":"corrupt",)") + body);
    const ClientConfig absent = shell::parseConfig(QByteArray("{") + body);

    QCOMPARE(future, current);
    QCOMPARE(corrupt, current);
    QCOMPARE(absent, current);
    QCOMPARE(future.schemaVersion, shell::kConfigSchemaVersion);
    QCOMPARE(shell::serializeConfig(future), shell::serializeConfig(current));
}

// ---------------------------------------------------------------------------
// R7/R8: the whitelist applies on the way out as well, the version is forced, the payload
// ends with exactly one newline.
void ClientConfigTest::serializesTheWhitelistOnly()
{
    ClientConfig cfg;
    cfg.schemaVersion = 99;  // a caller carrying a foreign version must not reach the file
    cfg.serverUrl = QStringLiteral("http://h:3001");
    cfg.bounds = makeBounds(1440, 900, 12, 34, true);

    const QByteArray out = shell::serializeConfig(cfg);

    QVERIFY2(out.endsWith('\n'), "the trailing newline is a tested contract, not an accident");
    QVERIFY2(!out.endsWith("\n\n"), "exactly one trailing newline");
    const QJsonObject object = reparse(out);
    QCOMPARE(sortedKeys(object),
             QStringList({QStringLiteral("bounds"), QStringLiteral("schemaVersion"),
                          QStringLiteral("serverUrl")}));
    QCOMPARE(object.value(QStringLiteral("schemaVersion")).toInt(), shell::kConfigSchemaVersion);
    QCOMPARE(object.value(QStringLiteral("serverUrl")).toString(), QStringLiteral("http://h:3001"));

    // The absent serverUrl is spelled as JSON null, like the canonical - not as "".
    ClientConfig blank;
    const QJsonObject blankObject = reparse(shell::serializeConfig(blank));
    QVERIFY(blankObject.value(QStringLiteral("serverUrl")).isNull());
    QVERIFY(blankObject.value(QStringLiteral("bounds")).isNull());

    // R7: writing runs the same shape check as reading, so an undersized rectangle handed
    // over by a caller becomes null instead of landing in the file.
    ClientConfig tooSmall;
    tooSmall.bounds = makeBounds(700, 500, 0, 0);
    QVERIFY(reparse(shell::serializeConfig(tooSmall)).value(QStringLiteral("bounds")).isNull());
}

// ---------------------------------------------------------------------------
// C-N3: serializeConfig degrades junk into the default shape instead of failing. In the
// canonical that means a non-object argument; here it means a default-constructed or
// half-filled struct, which is what a caller that never loaded a config hands over.
void ClientConfigTest::serializesDegradedInputWithoutFailing()
{
    const QJsonObject fromDefault = reparse(shell::serializeConfig(ClientConfig()));
    QCOMPARE(sortedKeys(fromDefault),
             QStringList({QStringLiteral("bounds"), QStringLiteral("schemaVersion"),
                          QStringLiteral("serverUrl")}));
    QCOMPARE(fromDefault.value(QStringLiteral("schemaVersion")).toInt(),
             shell::kConfigSchemaVersion);

    // Numbers set while valid == false are not "half bounds": the flag decides.
    ClientConfig halfFilled;
    halfFilled.bounds.width = 1440;
    halfFilled.bounds.height = 900;
    QVERIFY(reparse(shell::serializeConfig(halfFilled)).value(QStringLiteral("bounds")).isNull());
    QCOMPARE(shell::serializeConfig(halfFilled), shell::serializeConfig(ClientConfig()));
}

// ---------------------------------------------------------------------------
// R9: serialize -> parse comes back with the same value.
void ClientConfigTest::roundTripsThroughParse()
{
    ClientConfig full;
    full.serverUrl = QStringLiteral("http://192.168.0.10:3001");
    full.bounds = makeBounds(1440, 900, 12, 34, false);
    QCOMPARE(shell::parseConfig(shell::serializeConfig(full)), full);

    ClientConfig maximized;
    maximized.serverUrl = QStringLiteral("https://news.example.com");
    maximized.bounds = makeBounds(1024, 720, -1800, 100, true);
    QCOMPARE(shell::parseConfig(shell::serializeConfig(maximized)), maximized);

    QCOMPARE(shell::parseConfig(shell::serializeConfig(ClientConfig())), ClientConfig());
}

// ---------------------------------------------------------------------------
// R16: the structural check and the screen check are two functions on purpose - at parse
// time the monitor layout is unknown, so a rectangle that is off-screen today still parses.
// Nothing in the canonical asserts this separation; this row does.
void ClientConfigTest::separatesTheShapeCheckFromTheScreenCheck()
{
    const Bounds offScreen = makeBounds(1024, 720, 5000, 5000);
    const QList<QRect> workAreas{QRect(0, 0, 1920, 1080)};

    QCOMPARE(shell::sanitizeBoundsShape(offScreen), offScreen);
    QCOMPARE(shell::sanitizeBounds(offScreen, workAreas), Bounds());

    // ... and parsing keeps it, because parseConfig must not consult monitors.
    const ClientConfig parsed = shell::parseConfig(
        fileWithBounds(R"({"width":1024,"height":720,"x":5000,"y":5000})"));
    QCOMPARE(parsed.bounds, offScreen);
}

// ---------------------------------------------------------------------------
// R15: structure first, then overlap with at least one work area. Strict inequalities -
// a rectangle that only touches an edge is not visible.
void ClientConfigTest::sanitizesBoundsAgainstWorkAreas()
{
    const QList<QRect> single{QRect(0, 0, 1920, 1080)};
    const QList<QRect> dual{QRect(-1920, 0, 1920, 1080), QRect(0, 0, 1920, 1080)};

    // --- lifted from test/client-shell-core.test.js:240-264 ---
    const Bounds visible = makeBounds(1440, 900, 100, 50, true);
    QCOMPARE(shell::sanitizeBounds(visible, single), visible);
    QCOMPARE(shell::sanitizeBounds(makeBounds(1024, 720, 5000, 5000), single), Bounds());
    QCOMPARE(shell::sanitizeBounds(makeBounds(1024, 720, 0, 0), QList<QRect>()), Bounds());
    QCOMPARE(shell::sanitizeBounds(Bounds(), single), Bounds());
    const Bounds onSecondary = makeBounds(1024, 720, -1800, 100);
    QCOMPARE(shell::sanitizeBounds(onSecondary, dual), onSecondary);

    // Structure is checked first: an undersized rectangle is rejected even though it sits
    // in the middle of the screen.
    QCOMPARE(shell::sanitizeBounds(makeBounds(799, 900, 0, 0), single), Bounds());

    // --- Qt-only rows ---
    // Touching edges only. QRect::intersects() uses the x+width-1 convention, so an
    // implementation that reaches for it instead of the four canonical inequalities answers
    // differently on exactly these rectangles.
    QCOMPARE(shell::sanitizeBounds(makeBounds(1024, 720, 1920, 0), single), Bounds());
    QCOMPARE(shell::sanitizeBounds(makeBounds(1024, 720, 0, 1080), single), Bounds());
    QCOMPARE(shell::sanitizeBounds(makeBounds(1024, 720, -1024, 0), single), Bounds());
    // One pixel of overlap is enough.
    const Bounds barelyVisible = makeBounds(1024, 720, 1919, 0);
    QCOMPARE(shell::sanitizeBounds(barelyVisible, single), barelyVisible);
    // An empty work area rectangle (a monitor reported with zero size) overlaps nothing.
    QCOMPARE(shell::sanitizeBounds(visible, QList<QRect>{QRect(0, 0, 0, 0)}), Bounds());
}
