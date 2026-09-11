#ifndef CLIENT_QT_SHELL_SCENARIO_H
#define CLIENT_QT_SHELL_SCENARIO_H

// The automation hook's front door (phase 77 step10 A - ADR-018 (2), index.json open_questions (8)).
//
// A native app has no CDP, so the harness (scripts/verify-qt-client.mjs) drives the UI through a
// scenario hook: `--scenario login` makes the app call its login CONTROLLER once - never a widget -
// over the real HTTP transport, with the credentials the harness injects through
// CLIENT_SCENARIO_USER / CLIENT_SCENARIO_PASSWORD. Everything after that one call (the screen
// change, the identity re-check) is the app's normal path.
//
// THE GUARD IS AN ACCIDENT GUARD, NOT A SECURITY BOUNDARY. Anyone can set CLIENT_SELFTEST=1. What
// the guard stops is an automatic login path running BY MISTAKE (a stray argument in a shortcut, a
// copied command line) - not a person who means to run it. Therefore:
//   - it fails CLOSED: anything that even looks like --scenario without CLIENT_SELFTEST=1 is
//     refused, and main() exits non-zero BEFORE it touches anything (no lock, no folder, no diag
//     line, no window, no request)
//   - the app never stores, remembers or logs the credentials it is handed
//   - taking the hook out of production builds at compile time is P8's (packaging) - until then the
//     hook ships in the binary. Never read "there is a guard" as "it is safe".

#include <QString>
#include <QStringList>

namespace shell {

enum class Scenario { None, Login };

// The exit code of a refused request - distinct from a crash, a missing DLL (0xC0000135) and the
// self-test's 1, so a harness can tell "refused" from "broke".
inline constexpr int kScenarioRefusedExitCode = 2;

struct ScenarioRequest {
    Scenario scenario = Scenario::None;
    bool refused = false;
    // A fixed ASCII sentence for stderr. It never echoes an argument or a credential: an argument
    // may be a password typed in the wrong place.
    QString refusal;
    QString userId;
    QString password;  // handed to the controller once - never logged, never stored
};

// Pure. arguments = the process arguments without argv[0]; selftestValue = CLIENT_SELFTEST as read
// (it enables the hook only when it is exactly "1", like client/main.js:28); userId / password =
// CLIENT_SCENARIO_USER / CLIENT_SCENARIO_PASSWORD as read.
ScenarioRequest parseScenarioRequest(const QStringList &arguments, const QString &selftestValue,
                                     const QString &userId, const QString &password);

// The same, reading the three variables from the environment (the names live in appidentity.h).
ScenarioRequest scenarioRequestFromEnvironment(const QStringList &arguments);

} // namespace shell

#endif // CLIENT_QT_SHELL_SCENARIO_H
