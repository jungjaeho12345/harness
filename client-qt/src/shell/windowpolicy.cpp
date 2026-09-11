#include "shell/windowpolicy.h"

#include <QGuiApplication>
#include <QScreen>
#include <QWidget>

namespace shell {

WindowPlacement planAppWindow(const Bounds &restored)
{
    WindowPlacement plan;
    plan.minimumSize = QSize(kAppWindowMinWidth, kAppWindowMinHeight);
    plan.size = QSize(kAppWindowDefaultWidth, kAppWindowDefaultHeight);
    if (!restored.valid)
        return plan;  // no position: the platform places the window (R5 "key absent")

    // A valid Bounds always carries all four integers (sanitizeBoundsShape requires them), so
    // the canonical's "size without position" case cannot be expressed here - see README.
    plan.size = QSize(restored.width, restored.height);
    plan.position = QPoint(restored.x, restored.y);
    plan.startMaximized = restored.maximized;
    return plan;
}

void applyWindowPlacement(QWidget &window, const WindowPlacement &placement)
{
    // Minimum first: a stored size in the W-N1 band has to meet the window minimum, and it must
    // meet it at the moment the size is applied (step5.md C).
    window.setMinimumSize(placement.minimumSize);
    if (placement.position)
        window.setGeometry(QRect(*placement.position, placement.size));
    else
        window.resize(placement.size);
}

Bounds capturedBounds(const QRect &normalGeometry, bool maximized)
{
    Bounds bounds;
    if (!normalGeometry.isValid())
        return bounds;  // an empty rectangle is not a window layout; boundsToSave keeps the last one
    bounds.width = normalGeometry.width();
    bounds.height = normalGeometry.height();
    bounds.x = normalGeometry.x();
    bounds.y = normalGeometry.y();
    bounds.maximized = maximized;
    bounds.valid = true;
    return bounds;
}

Bounds captureBoundsFrom(const QWidget &window)
{
    // normalGeometry(), never geometry(): a maximized window's geometry() is the whole work area,
    // and storing that as the normal size would spoil every later restore (R9).
    return capturedBounds(window.normalGeometry(), window.isMaximized());
}

Bounds boundsToSave(const Bounds &previous, const Bounds &captured, const QList<QRect> &workAreas)
{
    const Bounds checked = sanitizeBounds(captured, workAreas);
    return checked.valid ? checked : previous;  // no else-reset: the canonical has none (W-N2)
}

bool shouldSaveBoundsOnClose(bool everShown)
{
    return everShown;
}

Activation planActivation(bool selftest, bool haveWindow, bool minimized)
{
    if (selftest || !haveWindow)
        return Activation::LogOnly;  // verification runs never take over the desktop
    return minimized ? Activation::RestoreThenShow : Activation::Show;
}

QList<QRect> screenWorkAreas()
{
    QList<QRect> areas;
    const QList<QScreen *> screens = QGuiApplication::screens();
    for (const QScreen *screen : screens)
        areas << screen->availableGeometry();
    return areas;
}

} // namespace shell
