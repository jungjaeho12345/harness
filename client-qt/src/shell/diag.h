#ifndef CLIENT_QT_SHELL_DIAG_H
#define CLIENT_QT_SHELL_DIAG_H

// Diagnostic JSONL - the Qt port of client/diag.js (phase 77 step4).
//
// WHY THIS FILE IS THE SPINE OF THIS PHASE: the Electron client is driven by CDP, a native
// app is not. This log is the only machine-readable account of "what did the app do", and
// every automated verdict from step6 on is built on the event contract below.
//
// CRITICAL (inherited verbatim from the canonical module header): article text, session ids,
// cookies and passwords are never written. URL values keep origin+pathname only (query and
// fragment are dropped - that is where article ids and tokens ride). A "file:" URL keeps the
// scheme and the file name only (no local absolute path).
//
// THE INVARIANT THAT MATTERS MOST IS NOT THE KEY FILTER (canonical comment, diag.js:7-8):
// the forbidden-key set is a net, not the rule. The rule is that every caller builds its
// payload out of named, known-safe fields. Never hand a whole response/request object to
// log() - fields outside the forbidden set would carry the article body straight through.
//
// Failure policy: writing is best effort and synchronous. Errors are swallowed (a diagnostic
// that kills the app defeats its purpose) and nothing is buffered (the driver polls for the
// LAST event of a sequence - buffering makes a healthy app time the gate out).

#include <QByteArray>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QVariantMap>

#include <QtGlobal>

namespace shell {

// ---------------------------------------------------------------------------------------
// Event catalogue. The allowed set IS the P4 boundary: log() refuses anything outside it,
// so widening the scope has to be a deliberate edit here (see client-qt/README.md for the
// disposition table of the 18 canonical names).
// ---------------------------------------------------------------------------------------
const QSet<QString> &allowedDiagEvents();
bool isAllowedDiagEvent(const QString &event);

// Pure formatter. UTF-8, one JSON object, terminated by exactly one '\n' (never CRLF: the
// judge splits on '\n' and JSON.parse's each line).
QByteArray formatDiagLine(const QString &event, const QVariantMap &payload, qint64 epochMs);

// Pure leak filter. Exposed so the rules can be tested without touching the filesystem.
QVariantMap redactDiagEvent(const QString &event, const QVariantMap &payload);

// Pure URL redaction. fail-open: a value that is not an absolute URL is returned unchanged
// (a non-URL cannot carry a query string).
QString redactUrl(const QString &value);

// "route" values may only be a route id (articles-get) or a path template (/api/articles/:id).
// A concrete article id in the path is exactly what redactUrl() strips out of query strings.
bool isSafeRouteValue(const QString &value);

// The diag path comes from CLIENT_DIAG_FILE and nowhere else. Empty (= no-op) when unset or
// blank. No directory is created here or anywhere in this module - that stays the caller's
// business, same as the canonical (client/main.js:29).
QString diagFilePathFromEnvironment();

class Diag
{
public:
    // An empty path yields a complete no-op: no file is created and nothing is ever written.
    explicit Diag(const QString &filePath = QString());

    bool isEnabled() const;
    QString filePath() const;

    // Appends one line, synchronously. Unknown event names are refused (and counted).
    void log(const QString &event, const QVariantMap &payload = QVariantMap());

    // Same, with an injected clock - the seam the tests use for byte-exact comparisons.
    void logAt(const QString &event, const QVariantMap &payload, qint64 epochMs);

    // How many log() calls were refused because the name is outside allowedDiagEvents().
    int rejectedEventCount() const;

private:
    QString m_filePath;
    int m_rejectedEvents = 0;
};

} // namespace shell

#endif // CLIENT_QT_SHELL_DIAG_H
