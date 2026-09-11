#include "querystringtest.h"

#include "net/querystring.h"

#include <QString>
#include <QStringList>
#include <QUrl>
#include <QUrlQuery>
#include <QVariant>
#include <QVariantList>
#include <QVariantMap>
#include <QtTest>

void QueryStringTest::matchesTheCanonicalSerialisation_data()
{
    QTest::addColumn<QVariantMap>("params");
    QTest::addColumn<QString>("expected");

    // Row names carry the rule, so a red line says which rule broke.
    QTest::newRow("deskUnsent filter: a list repeats its key (step11 gate)")
        << QVariantMap{{QStringLiteral("status"), QStringList{QStringLiteral("RDS"), QStringLiteral("DDH")}}}
        << QStringLiteral("?status=RDS&status=DDH");
    QTest::newRow("canonical row 197-202: hangul list + scalar")
        << QVariantMap{{QStringLiteral("departments"), QStringList{QStringLiteral("정치"), QStringLiteral("경제")}},
                       {QStringLiteral("status"), QStringLiteral("DPS")}}
        << QStringLiteral("?departments=%EC%A0%95%EC%B9%98&departments=%EA%B2%BD%EC%A0%9C&status=DPS");
    QTest::newRow("null value drops the key - no 'a='")
        << QVariantMap{{QStringLiteral("a"), QVariant()}, {QStringLiteral("b"), QStringLiteral("x")}}
        << QStringLiteral("?b=x");
    QTest::newRow("nullptr value drops the key too")
        << QVariantMap{{QStringLiteral("a"), QVariant::fromValue(nullptr)}, {QStringLiteral("b"), QStringLiteral("x")}}
        << QStringLiteral("?b=x");
    QTest::newRow("only null values -> empty, no '?'")
        << QVariantMap{{QStringLiteral("a"), QVariant()}} << QString();
    QTest::newRow("empty list emits nothing")
        << QVariantMap{{QStringLiteral("a"), QStringList()}, {QStringLiteral("b"), QStringLiteral("x")}}
        << QStringLiteral("?b=x");
    QTest::newRow("empty variant list emits nothing")
        << QVariantMap{{QStringLiteral("a"), QVariantList()}} << QString();
    QTest::newRow("empty string is kept as 'a='")
        << QVariantMap{{QStringLiteral("a"), QString()}} << QStringLiteral("?a=");
    QTest::newRow("list of one empty string -> 'a='")
        << QVariantMap{{QStringLiteral("a"), QStringList{QString()}}} << QStringLiteral("?a=");
    QTest::newRow("empty map -> empty, no '?'") << QVariantMap() << QString();
    QTest::newRow("space is '+'") << QVariantMap{{QStringLiteral("q"), QStringLiteral("a b")}}
                                  << QStringLiteral("?q=a+b");
    QTest::newRow("'&' is %26") << QVariantMap{{QStringLiteral("q"), QStringLiteral("a&b")}}
                                << QStringLiteral("?q=a%26b");
    QTest::newRow("'=' is %3D") << QVariantMap{{QStringLiteral("q"), QStringLiteral("a=b")}}
                                << QStringLiteral("?q=a%3Db");
    QTest::newRow("'+' is %2B (a bare '+' would read back as a space)")
        << QVariantMap{{QStringLiteral("q"), QStringLiteral("a+b")}} << QStringLiteral("?q=a%2Bb");
    QTest::newRow("all four at once") << QVariantMap{{QStringLiteral("q"), QStringLiteral("a+b&c=d e")}}
                                      << QStringLiteral("?q=a%2Bb%26c%3Dd+e");
    QTest::newRow("hangul is UTF-8 percent-encoded, uppercase hex")
        << QVariantMap{{QStringLiteral("q"), QStringLiteral("한글")}}
        << QStringLiteral("?q=%ED%95%9C%EA%B8%80");
    QTest::newRow("~ ! ' ( ) encoded, * - . _ kept")
        << QVariantMap{{QStringLiteral("q"), QStringLiteral("~!'()*-._")}}
        << QStringLiteral("?q=%7E%21%27%28%29*-._");
    QTest::newRow("URL delimiters all encoded")
        << QVariantMap{{QStringLiteral("q"), QStringLiteral("/?#[]@$,;:%")}}
        << QStringLiteral("?q=%2F%3F%23%5B%5D%40%24%2C%3B%3A%25");
    QTest::newRow("control characters") << QVariantMap{{QStringLiteral("q"), QStringLiteral("a\tb\nc")}}
                                        << QStringLiteral("?q=a%09b%0Ac");
    QTest::newRow("astral plane (4 UTF-8 bytes)")
        << QVariantMap{{QStringLiteral("q"), QString::fromUtf8("\xF0\x9F\x98\x80")}}
        << QStringLiteral("?q=%F0%9F%98%80");
    QTest::newRow("the key is encoded with the same rules")
        << QVariantMap{{QStringLiteral("a b&"), QStringLiteral("v")}} << QStringLiteral("?a+b%26=v");
    QTest::newRow("integer (queryHistory sendOnly=1)")
        << QVariantMap{{QStringLiteral("sendOnly"), 1}} << QStringLiteral("?sendOnly=1");
    QTest::newRow("integral double from JSON is spelled like a JS number")
        << QVariantMap{{QStringLiteral("limit"), 50.0}} << QStringLiteral("?limit=50");
    QTest::newRow("booleans are 'true' / 'false'")
        << QVariantMap{{QStringLiteral("flag"), true}, {QStringLiteral("off"), false}}
        << QStringLiteral("?flag=true&off=false");
    QTest::newRow("a null ELEMENT is the string 'null' (JS String(null))")
        << QVariantMap{{QStringLiteral("a"), QVariantList{QStringLiteral("x"), QVariant()}}}
        << QStringLiteral("?a=x&a=null");
    QTest::newRow("a nested list element is comma-joined (Array.join) then encoded")
        << QVariantMap{{QStringLiteral("a"), QVariantList{QVariantList{QStringLiteral("x"), QStringLiteral("y")},
                                                          QStringLiteral("z")}}}
        << QStringLiteral("?a=x%2Cy&a=z");
    // DIVERGENCE (README): QVariantMap is key-sorted; the canonical keeps insertion order and would
    // write ?z=1&a=2 for {z:'1', a:'2'}. The server reads by name, so nothing depends on it.
    QTest::newRow("DIVERGENCE: pairs come out in key order")
        << QVariantMap{{QStringLiteral("z"), QStringLiteral("1")}, {QStringLiteral("a"), QStringLiteral("2")}}
        << QStringLiteral("?a=2&z=1");
}

void QueryStringTest::matchesTheCanonicalSerialisation()
{
    QFETCH(QVariantMap, params);
    QFETCH(QString, expected);
    QCOMPARE(net::buildQuery(params), expected);
}

// httpModel.test.js:197-202 in its own words: the URL parsed back gives both departments values
// under ONE repeated key, and status once.
void QueryStringTest::keepsTheCanonicalRepeatedKeyRow()
{
    const QString qs = net::buildQuery(
        QVariantMap{{QStringLiteral("departments"), QStringList{QStringLiteral("정치"), QStringLiteral("경제")}},
                    {QStringLiteral("status"), QStringLiteral("DPS")}});
    QVERIFY(qs.startsWith(QLatin1Char('?')));
    const QUrlQuery parsed(qs.mid(1));
    QCOMPARE(parsed.allQueryItemValues(QStringLiteral("departments"), QUrl::FullyDecoded),
             (QStringList{QStringLiteral("정치"), QStringLiteral("경제")}));
    QCOMPARE(parsed.allQueryItemValues(QStringLiteral("status")), QStringList{QStringLiteral("DPS")});
}

// Characterisation, measured on Qt 6.8.3: QUrlQuery spells a space "%20" and leaves '+' bare.
// A bare '+' in a query is read back as a SPACE by the server's parser, so a search for "a+b"
// would silently become "a b". That is why the encoder is hand-written.
void QueryStringTest::documentsWhyQUrlQueryIsNotUsed()
{
    QUrlQuery viaQt;
    viaQt.addQueryItem(QStringLiteral("q"), QStringLiteral("a b"));
    viaQt.addQueryItem(QStringLiteral("p"), QStringLiteral("a+b"));
    const QString spelled = viaQt.toString(QUrl::FullyEncoded);
    qInfo("QUrlQuery spells {q:'a b', p:'a+b'} as: %s", qPrintable(spelled));
    QVERIFY2(spelled != QStringLiteral("q=a+b&p=a%2Bb"),
             "QUrlQuery now matches URLSearchParams - the hand-written encoder could be revisited");

    QCOMPARE(net::buildQuery(QVariantMap{{QStringLiteral("p"), QStringLiteral("a+b")},
                                         {QStringLiteral("q"), QStringLiteral("a b")}}),
             QStringLiteral("?p=a%2Bb&q=a+b"));
}
