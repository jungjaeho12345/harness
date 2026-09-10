#ifndef CLIENT_QT_SHELL_APPIDENTITY_H
#define CLIENT_QT_SHELL_APPIDENTITY_H

// Every OS-visible name this client claims, in ONE named-constant block (phase 77 step3,
// port spec X1). Keep it that way: an audit has to be able to answer "did the Qt client
// re-use an Electron name?" with a single grep on this file.
//
// Why the names must differ from the Electron shell (client/**):
//   - user data folder: both clients replace config.json with an atomic tmp->rename. Sharing
//     the folder means the last writer wins and the two clients erase each other's serverUrl
//     and bounds (index.json decisions (11)).
//   - single instance name: running both clients side by side to compare screens is the
//     basic development mode of P4~P7. A shared lock name makes that impossible.
// The Electron client derives its own single-instance key from its user data folder, so the
// two axes are separate mechanisms following the same rule.

#include <QString>

namespace shell {
namespace names {

// The Qt client's user data folder: the Korean product name plus a "-qt" suffix.
//
// Spelled with universal character names on purpose - this file stays ASCII so that no tool
// in the chain (cmd parses batch files as cp949; MSVC decodes sources with the system code
// page unless a BOM or /utf-8 says otherwise) can silently mangle the one literal that
// decides which folder we write into. QStringLiteral compiles the escapes into UTF-16, so
// the value is exact regardless of the execution character set.
//
//   userDataFolder()         == 기사작성기-qt
//   electronUserDataFolder() == 기사작성기
inline QString userDataFolder()
{
    return QStringLiteral("\uAE30\uC0AC\uC791\uC131\uAE30-qt");
}

// The Electron shell's folder (client/package.json productName). It exists here only so
// tests can assert that we never resolve to it. Nothing in this app writes there - the
// Electron client stays the fallback product until P8.
inline QString electronUserDataFolder()
{
    return QStringLiteral("\uAE30\uC0AC\uC791\uC131\uAE30");
}

// Single instance guard (step5 wires these; the names live here). ASCII, and deliberately
// unlike anything the Electron shell can derive from its own folder name.
inline QString singleInstanceMutex()
{
    return QStringLiteral("ArticleClientQt-SingleInstance");
}

inline QString singleInstanceLocalServer()
{
    return QStringLiteral("ArticleClientQt-Shell");
}

// Harness environment variable, inherited verbatim from the Electron shell: it is the only
// way for a test or a driver to keep its hands off the real user's folder.
inline QString userDataEnvVar()
{
    return QStringLiteral("CLIENT_USER_DATA");
}

} // namespace names
} // namespace shell

#endif // CLIENT_QT_SHELL_APPIDENTITY_H
