#ifndef CLIENT_QT_SHELL_CLIENTCONFIG_H
#define CLIENT_QT_SHELL_CLIENTCONFIG_H

// Persisted shell settings (last server origin + window bounds) - the Qt port of
// client/lib/clientConfig.js (phase 77 step3). Pure module: no filesystem, no globals, no
// network. The filesystem boundary lives in configstore.{h,cpp}.
//
// CRITICAL (security, inherited verbatim from the canonical module header): no field for a
// session id, a password, a cookie or a token is ever added to this schema. The file is
// outside the trust boundary - it is not encrypted and can be hand-edited - so parseConfig
// keeps a whitelist and drops every other key: a secret written into the file is absent
// from the parse result and from anything we write back (index.json decisions (6)).
//
// parseConfig never fails: any input - garbage bytes, broken JSON, an array, a number -
// converges on the defaults. A corrupt config must not stop the app from starting,
// otherwise the user has no way back to the address screen.

#include <QByteArray>
#include <QList>
#include <QRect>
#include <QString>

namespace shell {

// Written on save, ignored on load. See parseConfig() below and client-qt/README.md
// ("설정 파일에 마이그레이션 경로가 없다").
inline constexpr int kConfigSchemaVersion = 1;

// Structural lower bound for a *stored* rectangle (canonical clientConfig.js:14-15).
// Do NOT merge these with the minimum *window* size (1024x720, windowPolicy.js:41-42,
// step5): two different constants for two different jobs (port spec X5). A stored 850x650
// passing this check while being smaller than the window minimum is correct behaviour.
inline constexpr int kMinStoredWidth = 800;
inline constexpr int kMinStoredHeight = 600;

// The canonical `bounds: null` is spelled `valid == false` here.
struct Bounds {
    int width = 0;
    int height = 0;
    int x = 0;
    int y = 0;
    bool maximized = false;
    bool valid = false;
};

// The whole schema. The struct IS the whitelist: there is no place to put an unknown key.
// The canonical `serverUrl: null` is spelled as an empty QString.
struct ClientConfig {
    int schemaVersion = kConfigSchemaVersion;
    QString serverUrl;
    Bounds bounds;
};

bool operator==(const Bounds &lhs, const Bounds &rhs);
bool operator!=(const Bounds &lhs, const Bounds &rhs);
bool operator==(const ClientConfig &lhs, const ClientConfig &rhs);
bool operator!=(const ClientConfig &lhs, const ClientConfig &rhs);

// Never throws, never reports an error: every unusable input becomes the default config.
// serverUrl is re-validated through normalizeServerUrl() even when reading (defence against
// a hand-edited file) and is stored re-normalised. Failures are scoped per field: broken
// bounds leave serverUrl alone.
//
// The stored schemaVersion is deliberately NOT read (canonical rule C-N1): there is no
// version check, no migration and no rejection of a future schema anywhere in this port,
// because there is none in the canonical either.
ClientConfig parseConfig(const QByteArray &rawJson);

// Whitelist on the way out too - a caller that hands over junk cannot get it into the file.
// The schema version is always the current constant, never whatever the caller carried.
// Ends with exactly one newline (that trailing byte is an explicit, tested contract).
QByteArray serializeConfig(const ClientConfig &config);

// Structural check only (5 keys, integers, minimum size). It knows nothing about monitors.
Bounds sanitizeBoundsShape(const Bounds &bounds);

// Structure first, then screen layout: the rectangle has to overlap at least one work area
// (strict inequalities - touching edges do not count). An empty list of work areas (all
// monitors detached) rejects. Deliberately separate from sanitizeBoundsShape because at
// parse time the monitor layout is unknown; the window restore path (step5) calls this one.
Bounds sanitizeBounds(const Bounds &bounds, const QList<QRect> &workAreas);

} // namespace shell

#endif // CLIENT_QT_SHELL_CLIENTCONFIG_H
