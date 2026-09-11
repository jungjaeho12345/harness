#ifndef CLIENT_QT_SHELL_WINDOWPOLICY_H
#define CLIENT_QT_SHELL_WINDOWPOLICY_H

// App window geometry decisions (phase 77 step5) - the Qt counterpart of the live-window half of
// the bounds contract (client/main.js:263-277, 295-296, 367-377) plus the window constants of
// client/lib/windowPolicy.js:39-42 and 61-62.
//
// Everything that can be a pure decision is one here, on purpose: the canonical never tested its
// live-window half (createAppWindow / saveBoundsFrom / the second-instance handler need a real
// BrowserWindow), so eleven of its rules ship without a safety net (port spec section 6). Pulling
// the decisions out is what lets this port lock them.
//
// The workArea overlap test itself is NOT here - it lives in clientconfig.h (sanitizeBounds),
// exactly where the canonical keeps it (clientConfig.js:73-83). windowPolicy.js never had it.

#include "shell/clientconfig.h"

#include <QList>
#include <QPoint>
#include <QRect>
#include <QSize>

#include <optional>

class QWidget;

namespace shell {

// windowPolicy.js:39-42. The minimum is a different constant from kMinStoredWidth/Height
// (800x600, the lower bound a STORED rectangle may have): two numbers for two jobs, never merged
// (port spec X5). A stored 850x650 passes validation and is then clamped to 1024x720 by the
// window minimum - the band W-N1 describes, reproduced rather than "fixed".
inline constexpr int kAppWindowDefaultWidth = 1440;
inline constexpr int kAppWindowDefaultHeight = 900;
inline constexpr int kAppWindowMinWidth = 1024;
inline constexpr int kAppWindowMinHeight = 720;

// windowPolicy.js:61-62 - the local window, here the server address screen.
inline constexpr int kSetupWindowWidth = 560;
inline constexpr int kSetupWindowHeight = 420;

struct WindowPlacement {
    QSize minimumSize;
    QSize size;
    // Absent = the platform places the window. Never spelled as move(0,0) or any other sentinel
    // (canonical R5: the x/y keys are left OUT of the options object, not set to 0).
    std::optional<QPoint> position;
    // R8: the window is created at its normal rectangle and maximized AFTER creation.
    bool startMaximized = false;
};

// Restored bounds (already through sanitizeBounds) -> how to open the app window.
// Invalid bounds = the defaults (1440x900, no position, not maximized).
WindowPlacement planAppWindow(const Bounds &restored);

// Applies a plan to a not-yet-shown window: minimum size FIRST, then the size (and the position
// only when the plan has one). Showing - and maximizing - stays the caller's job (R8 order).
//
// Position + size go through setGeometry(), whose rectangle excludes the window frame, because
// the rectangle we save comes from normalGeometry(), which excludes it too. resize()+move() would
// mix a client rectangle with a frame position and walk the window down by one title bar per
// restart (see client-qt/README.md).
void applyWindowPlacement(QWidget &window, const WindowPlacement &placement);

// R9: what a closing window should persist - its NORMAL rectangle, even when it is maximized
// (client/main.js:370 uses getNormalBounds(), not getBounds()), plus the maximized flag.
// An empty/invalid normal rectangle yields invalid bounds.
Bounds capturedBounds(const QRect &normalGeometry, bool maximized);
Bounds captureBoundsFrom(const QWidget &window);

// W-N2 (canonical main.js:371-372 has no else branch): the captured rectangle replaces the
// previous value only when it passes sanitizeBounds against the current monitors. Otherwise the
// previous known-good value is kept - and still written to disk by the caller. Never reset.
Bounds boundsToSave(const Bounds &previous, const Bounds &captured, const QList<QRect> &workAreas);

// R10: a window that was never on screen never persists its bounds (a selftest run, or a window
// destroyed before its first paint, must not overwrite the real user's layout).
bool shouldSaveBoundsOnClose(bool everShown);

// R3: what the running instance does when a second instance knocks.
enum class Activation {
    LogOnly,          // selftest, or no window to bring forward
    Show,             // show + raise + activate, leaving the window state alone
    RestoreThenShow,  // un-minimize first (minimized only - restoring a maximized window un-maximizes it)
};
Activation planActivation(bool selftest, bool haveWindow, bool minimized);

// The work area of every screen right now (QGuiApplication::screens() -> availableGeometry()),
// the input of sanitizeBounds at boot and at close.
QList<QRect> screenWorkAreas();

} // namespace shell

#endif // CLIENT_QT_SHELL_WINDOWPOLICY_H
