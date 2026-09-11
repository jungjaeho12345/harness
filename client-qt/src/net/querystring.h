#ifndef CLIENT_QT_NET_QUERYSTRING_H
#define CLIENT_QT_NET_QUERYSTRING_H

// Query string serialisation - the Qt port of buildQuery (web/src/model/httpModel.js:70-79,
// phase 77 step7). It spells the list filter (GET /api/articles?status=RDS&status=DDH), so the
// P4 completion gate (step11) stands on it: a wrong array spelling yields a list that is empty
// and green at the same time.
//
// Rules - measured by running the canonical under node (tests/querystringtest.cpp holds the
// outputs verbatim):
//   - a null value (invalid QVariant / nullptr) drops the KEY - not even "key=" is sent
//   - a list repeats the key once per element (status=RDS&status=DDH): never comma-joined,
//     never a JSON array, never "status[]". An empty list emits nothing.
//   - a scalar is appended once; an empty string is kept as "key="
//   - an element is spelled like JS String(v): a null element is "null", a nested list is its
//     elements joined by "," (Array.prototype.join - null elements become "")
//   - empty result -> "" (no "?"), otherwise "?" + pairs joined by "&"
//   - encoding = URLSearchParams (application/x-www-form-urlencoded over UTF-8): space -> '+',
//     A-Z a-z 0-9 * - . _ kept, every other byte %XX (uppercase hex). QUrlQuery does NOT do this
//     (tests/querystringtest.cpp measures the difference), so it is not used.
//
// Divergence (client-qt/README.md): pairs come out in KEY order - QVariantMap is sorted - where
// the canonical keeps insertion order. The server reads parameters by name; the order carries
// nothing.
//
// Path parameters are NOT encoded here: a path segment is encodeURIComponent (step8 buildPath),
// a query value is URLSearchParams. The two rule sets differ; do not mix them.

#include <QString>
#include <QVariantMap>

namespace net {

// One component, spelled the way URLSearchParams spells it.
QString formUrlEncode(const QString &text);

// "" or "?k=v&k=v2..." - see the rules above.
QString buildQuery(const QVariantMap &params);

} // namespace net

#endif // CLIENT_QT_NET_QUERYSTRING_H
