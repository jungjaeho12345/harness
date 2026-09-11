#include "routetabletest.h"

#include "net/querystring.h"
#include "net/routetable.h"

#include <QSet>
#include <QString>
#include <QStringList>
#include <QVariantMap>
#include <QtTest>

void RouteTableTest::encodesAPathSegmentLikeEncodeURIComponent_data()
{
    QTest::addColumn<QString>("value");
    QTest::addColumn<QString>("expected");

    // Every expected value is node's encodeURIComponent output (2026-09-12, recorded in README).
    QTest::newRow("plain id") << "AKR1" << "AKR1";
    QTest::newRow("space is %20 (the query's '+' is a different rule)") << "AKR 1" << "AKR%201";
    QTest::newRow("URL delimiters") << "a b/c?d#e&f=g+h" << "a%20b%2Fc%3Fd%23e%26f%3Dg%2Bh";
    QTest::newRow("the nine marks encodeURIComponent keeps") << "!'()*~-_." << "!'()*~-_.";
    QTest::newRow("hangul is UTF-8, uppercase hex") << QStringLiteral("한글") << "%ED%95%9C%EA%B8%80";
    QTest::newRow("percent itself") << "%" << "%25";
    QTest::newRow("a slash never splits the segment") << "../x" << "..%2Fx";
    QTest::newRow("sub-delims and ':' '@' encoded") << "a;b,c$d@e:f" << "a%3Bb%2Cc%24d%40e%3Af";
}

void RouteTableTest::encodesAPathSegmentLikeEncodeURIComponent()
{
    QFETCH(QString, value);
    QFETCH(QString, expected);
    QCOMPARE(net::encodePathSegment(value), expected);
}

void RouteTableTest::fillsThePathTemplate_data()
{
    QTest::addColumn<QString>("route");
    QTest::addColumn<QVariantMap>("params");
    QTest::addColumn<QString>("expected");

    QTest::newRow("no parameter") << "articles-list" << QVariantMap() << "/api/articles";
    QTest::newRow("one parameter") << "articles-get" << QVariantMap{{QStringLiteral("id"), QStringLiteral("AKR1")}}
                                   << "/api/articles/AKR1";
    QTest::newRow("two parameters") << "articles-history-snapshot"
                                    << QVariantMap{{QStringLiteral("id"), QStringLiteral("AKR1")},
                                                   {QStringLiteral("historyId"), 7}}
                                    << "/api/articles/AKR1/history/7";
    QTest::newRow("the value is encodeURIComponent-ed") << "users-update"
                                                        << QVariantMap{{QStringLiteral("id"), QStringLiteral("kim lee/x")}}
                                                        << "/api/users/kim%20lee%2Fx";
    QTest::newRow("a number parameter") << "distribution-targets-deactivate"
                                        << QVariantMap{{QStringLiteral("id"), 12}}
                                        << "/api/distribution-targets/12/deactivate";
    QTest::newRow("extra parameters are ignored") << "session" << QVariantMap{{QStringLiteral("id"), QStringLiteral("x")}}
                                                  << "/api/session";
}

void RouteTableTest::fillsThePathTemplate()
{
    QFETCH(QString, route);
    QFETCH(QVariantMap, params);
    QFETCH(QString, expected);
    QCOMPARE(net::buildPath(route, params), expected);
}

void RouteTableTest::refusesAPathThatWouldLandElsewhere_data()
{
    QTest::addColumn<QString>("route");
    QTest::addColumn<QVariantMap>("params");

    // encodeURIComponent('') is '' -> "/api/articles/" (the list route on a lenient router) and
    // '..' survives it -> "/api/articles/.." (dot-segment normalisation). The canonical sends those;
    // this port sends nothing (README 이탈).
    QTest::newRow("missing parameter") << "articles-get" << QVariantMap();
    QTest::newRow("empty parameter") << "articles-get" << QVariantMap{{QStringLiteral("id"), QString()}};
    QTest::newRow("'.' parameter") << "articles-get" << QVariantMap{{QStringLiteral("id"), QStringLiteral(".")}};
    QTest::newRow("'..' parameter") << "articles-update" << QVariantMap{{QStringLiteral("id"), QStringLiteral("..")}};
    QTest::newRow("one of two missing") << "articles-history-snapshot"
                                        << QVariantMap{{QStringLiteral("id"), QStringLiteral("AKR1")}};
    QTest::newRow("unknown route") << "articles-bulk-edit" << QVariantMap();
    QTest::newRow("forbidden route") << "collection-receive" << QVariantMap();
    QTest::newRow("forbidden route (pull)") << "collection-pull" << QVariantMap();
}

void RouteTableTest::refusesAPathThatWouldLandElsewhere()
{
    QFETCH(QString, route);
    QFETCH(QVariantMap, params);
    QVERIFY2(net::buildPath(route, params).isEmpty(), qPrintable(net::buildPath(route, params)));
}

void RouteTableTest::findsNoForbiddenOrUnknownRoute()
{
    QVERIFY(!net::routeTable().isEmpty());  // non-vacuity: the lookups below have rows to miss
    const net::RouteSpec *get = net::findRoute(QStringLiteral("articles-get"));
    QVERIFY(get != nullptr);
    QCOMPARE(get->pathTemplate, QStringLiteral("/api/articles/:id"));
    QCOMPARE(net::forbiddenRouteIds(),
             (QSet<QString>{QStringLiteral("collection-receive"), QStringLiteral("collection-pull")}));
    for (const QString &id : net::forbiddenRouteIds())
        QVERIFY2(net::findRoute(id) == nullptr, qPrintable(id));
    QVERIFY(net::findRoute(QStringLiteral("nope")) == nullptr);
    QVERIFY(net::findRoute(QString()) == nullptr);
    QVERIFY(net::findRoute(QStringLiteral("ARTICLES-GET")) == nullptr);
}

void RouteTableTest::listsTheRoutesOfAConsumer()
{
    QStringList save;
    for (const net::RouteSpec &row : net::routesOf(QStringLiteral("saveArticle")))
        save << row.id;
    save.sort();
    QCOMPARE(save, (QStringList{QStringLiteral("articles-create"), QStringLiteral("articles-update")}));

    const QVector<net::RouteSpec> list = net::routesOf(QStringLiteral("queryArticles"));
    QCOMPARE(list.size(), 1);
    QCOMPARE(list.first().id, QStringLiteral("articles-list"));

    const QVector<net::RouteSpec> probe = net::routesOf(net::probeRunnerConsumer());
    QCOMPARE(probe.size(), 1);
    QCOMPARE(probe.first().id, QStringLiteral("health"));
    QCOMPARE(net::probeRunnerConsumer(), QStringLiteral("ProbeRunner"));

    QVERIFY(net::routesOf(QStringLiteral("deleteUser")).isEmpty());
    QVERIFY(net::routesOf(QString()).isEmpty());
}

// hasBody mirrors the canonical calls (httpModel.js): the bodyless POSTs are logout (133),
// unlockArticle (252), forceUnlockArticle (255), deactivateDistributionTarget (284) and
// runDistributionTick (301); lockArticle always sends one (248); GET and DELETE never do.
void RouteTableTest::carriesABodyExactlyWhereTheCanonicalDoes()
{
    const QSet<QString> bodylessPosts{QStringLiteral("logout"), QStringLiteral("articles-unlock"),
                                      QStringLiteral("articles-force-unlock"),
                                      QStringLiteral("distribution-targets-deactivate"),
                                      QStringLiteral("distribution-tick")};
    int posts = 0;
    for (const net::RouteSpec &row : net::routeTable()) {
        if (row.method == QLatin1String("GET") || row.method == QLatin1String("DELETE")) {
            QVERIFY2(!row.hasBody, qPrintable(row.id));
        } else {
            ++posts;
            QCOMPARE(row.hasBody, !bodylessPosts.contains(row.id));
        }
    }
    QVERIFY(posts > bodylessPosts.size());
    const net::RouteSpec *lock = net::findRoute(QStringLiteral("articles-lock"));
    QVERIFY(lock != nullptr);
    QVERIFY(lock->hasBody);
}
