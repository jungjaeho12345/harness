#include "ui/screens.h"

#include "ui/listscreen.h"
#include "ui/loginscreen.h"
#include "ui/mainwindow.h"
#include "ui/setupscreen.h"

#include <QMetaObject>

namespace ui {
namespace {

// The class name the compiler knows - a renamed or removed class does not build - without its
// namespace ("ui::LoginScreen" -> "LoginScreen"), which is how the source scan spells it.
QString bareName(const QMetaObject &meta)
{
    const QString name = QString::fromLatin1(meta.className());
    const qsizetype scope = name.lastIndexOf(QStringLiteral("::"));
    return scope < 0 ? name : name.mid(scope + 2);
}

} // namespace

const QList<ScreenEntry> &screenRegistry()
{
    static const QList<ScreenEntry> registry{{QStringLiteral("login"), bareName(LoginScreen::staticMetaObject)},
                                             {QStringLiteral("list"), bareName(ListScreen::staticMetaObject)},
                                             {QStringLiteral("setup"), bareName(SetupScreen::staticMetaObject)}};
    return registry;
}

QStringList windowShellClasses()
{
    return {bareName(MainWindow::staticMetaObject)};
}

} // namespace ui
