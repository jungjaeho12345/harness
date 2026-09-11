#ifndef CLIENT_QT_NET_ROUTETABLE_H
#define CLIENT_QT_NET_ROUTETABLE_H

// The route table - every REST/SSE route this client may call, as DATA (phase 77 step8).
//
// It is the single place a method, a path template, an auth class or an x-edit-client rule is
// written down. HttpNewsModel builds every request from it, the transport derives its
// x-edit-client set from it, HttpProbeRunner takes /api/health from it, and the contract test
// (tests/routecontracttest.cpp) diffs it at run time against the frozen
// docs/api-contract/endpoints.json - so a drift between the two turns red instead of rotting.
//
// Rules the table carries (decisions (3)(4), step8.md A):
//   - 37 rows = the contract's 39 minus the two client-forbidden collection routes, which live
//     in forbiddenRouteIds() and nowhere else (findRoute() answers nullptr for them).
//   - pathTemplate and auth are the contract's strings, character for character.
//   - consumer: the MODEL_KEYS method that sends the row, or "ProbeRunner" (health only). One
//     consumer per row; a method may own several rows - saveArticle owns articles-create AND
//     articles-update (35 methods cover 36 routes).
//   - sendsEditClient: exactly articles-lock, articles-unlock, articles-update (server/index.js
//     932 / 961 / 974). The transport enforces it by route - a value supplied anywhere else is
//     dropped. The web keeps the same wire traffic by caller data flow; here it is structural.
//   - hasBody: whether the request carries a JSON body (and Content-Type) at all. A row without
//     one never sends a body, even when a caller supplies it; articles-lock always has one
//     ({} without an action - httpModel.js:247-249).
//   - There is no roles column on purpose: the server derives the role from the session on
//     every request (ADR-004); a client-side role table would be a cache of authority.

#include <QSet>
#include <QString>
#include <QVariantMap>
#include <QVector>

namespace net {

struct RouteSpec {
    QString id;
    QString method;
    QString pathTemplate;
    QString auth;
    QString consumer;
    bool sendsEditClient = false;
    bool sse = false;
    bool hasBody = false;
};

// The consumer of the health route: not a Model method but the server-address probe.
QString probeRunnerConsumer();

const QVector<RouteSpec> &routeTable();
const QSet<QString> &forbiddenRouteIds();

// nullptr for an unknown id AND for a forbidden one - there is no way to spell a request to them.
const RouteSpec *findRoute(const QString &routeId);

// Every row a consumer sends, in table order (saveArticle -> 2 rows, the others -> 1).
QVector<RouteSpec> routesOf(const QString &consumer);

// encodeURIComponent: A-Z a-z 0-9 - _ . ! ~ * ' ( ) kept, every other UTF-8 byte %XX (uppercase).
// A path segment is NOT a query value - the query uses buildQuery() (URLSearchParams rules).
QString encodePathSegment(const QString &value);

// The route's path with every ":name" segment replaced by encodePathSegment(params[name]).
// Empty when the route is unknown/forbidden, or when a parameter is missing, empty, "." or ".."
// (each would put the request on another route - the caller must not send anything).
QString buildPath(const QString &routeId, const QVariantMap &params = QVariantMap());

} // namespace net

#endif // CLIENT_QT_NET_ROUTETABLE_H
