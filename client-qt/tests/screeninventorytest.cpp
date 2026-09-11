#include "screeninventorytest.h"

#include "repofiles.h"

#include "ui/screens.h"

#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QHash>
#include <QList>
#include <QMap>
#include <QRegularExpression>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QtTest>

namespace {

// --- the scanner (pure) -------------------------------------------------------------------------
// Rule (client-qt/README.md 「화면」): a widget class is a class/struct whose base list names a Qt widget
// class, or another widget class found by the same scan (transitively). Comments are removed first so a
// commented-out declaration does not count. What it cannot see is written in the README next to the rule.

// Comments out, string and character literals (raw ones too) kept whole - so a "//" inside a URL string
// does not eat the line, and a comment never hides or invents a declaration.
QString stripComments(const QString &text)
{
    QString out;
    out.reserve(text.size());
    const qsizetype n = text.size();
    qsizetype i = 0;
    while (i < n) {
        const QChar c = text.at(i);
        const QChar next = i + 1 < n ? text.at(i + 1) : QChar();
        if (c == QLatin1Char('/') && next == QLatin1Char('/')) {
            while (i < n && text.at(i) != QLatin1Char('\n'))
                ++i;
            continue;
        }
        if (c == QLatin1Char('/') && next == QLatin1Char('*')) {
            const qsizetype end = text.indexOf(QStringLiteral("*/"), i + 2);
            i = end < 0 ? n : end + 2;
            out += QLatin1Char(' ');
            continue;
        }
        if (c == QLatin1Char('R') && next == QLatin1Char('"')) {
            const qsizetype open = text.indexOf(QLatin1Char('('), i + 2);
            if (open > 0) {
                const QString closing = QLatin1Char(')') + text.mid(i + 2, open - i - 2) + QLatin1Char('"');
                const qsizetype end = text.indexOf(closing, open + 1);
                const qsizetype stop = end < 0 ? n : end + closing.size();
                out += text.mid(i, stop - i);
                i = stop;
                continue;
            }
        }
        if (c == QLatin1Char('"') || c == QLatin1Char('\'')) {
            const QChar quote = c;
            out += c;
            ++i;
            while (i < n && text.at(i) != quote && text.at(i) != QLatin1Char('\n')) {
                if (text.at(i) == QLatin1Char('\\') && i + 1 < n) {
                    out += text.at(i);
                    ++i;
                }
                out += text.at(i);
                ++i;
            }
            if (i < n) {
                out += text.at(i);
                ++i;
            }
            continue;
        }
        out += c;
        ++i;
    }
    return out;
}

bool isQtWidgetBase(const QString &name)
{
    static const QRegularExpression re(QStringLiteral(
        "^Q[A-Za-z]*(Widget|Window|Dialog|Frame|View|Area|Edit|Box|Label|Button|Bar|Splitter|Wizard|Page|MessageBox)$"));
    return re.match(name).hasMatch();
}

// class/struct <Name> [final] : <bases> {   ->   Name -> [base names without access words or namespaces]
QHash<QString, QStringList> classDeclarations(const QString &source)
{
    static const QRegularExpression decl(
        QStringLiteral(R"re(\b(?:class|struct)\s+([A-Za-z_]\w*)\s*(?:final\s*)?:\s*([^{;]+)\{)re"));
    QHash<QString, QStringList> out;
    const QString text = stripComments(source);
    for (auto it = decl.globalMatch(text); it.hasNext();) {
        const QRegularExpressionMatch m = it.next();
        QStringList bases;
        for (QString base : m.captured(2).split(QLatin1Char(','))) {
            base.remove(QRegularExpression(QStringLiteral(R"(\b(public|protected|private|virtual)\b)")));
            base = base.trimmed();
            const qsizetype template_ = base.indexOf(QLatin1Char('<'));
            if (template_ >= 0)
                base = base.left(template_).trimmed();
            const qsizetype scope = base.lastIndexOf(QStringLiteral("::"));
            if (scope >= 0)
                base = base.mid(scope + 2);
            if (!base.isEmpty())
                bases << base;
        }
        out.insert(m.captured(1), bases);
    }
    return out;
}

// Every widget class among the declarations of all files (fixpoint: a class deriving from one found
// widget class is one too).
QSet<QString> widgetClasses(const QMap<QString, QString> &files)
{
    QHash<QString, QStringList> all;
    for (auto it = files.constBegin(); it != files.constEnd(); ++it) {
        const QHash<QString, QStringList> decls = classDeclarations(it.value());
        for (auto d = decls.constBegin(); d != decls.constEnd(); ++d)
            all.insert(d.key(), d.value());
    }
    QSet<QString> found;
    bool grew = true;
    while (grew) {
        grew = false;
        for (auto it = all.constBegin(); it != all.constEnd(); ++it) {
            if (found.contains(it.key()))
                continue;
            for (const QString &base : it.value()) {
                if (isQtWidgetBase(base) || found.contains(base)) {
                    found.insert(it.key());
                    grew = true;
                    break;
                }
            }
        }
    }
    return found;
}

// client-qt/src/** and client-qt/app/** - every .h and .cpp, compiled or not (a file that is not in the
// .pro is still a screen someone started).
QMap<QString, QString> clientSources(QString *error)
{
    QMap<QString, QString> files;
    const QString anchor = findRepoFile(QStringLiteral("client-qt/common.pri"));
    if (anchor.isEmpty()) {
        *error = QStringLiteral("client-qt/common.pri not found from the test binary or the working directory");
        return files;
    }
    const QDir root = QFileInfo(anchor).dir();
    for (const QString &sub : {QStringLiteral("src"), QStringLiteral("app")}) {
        QDirIterator it(root.filePath(sub), {QStringLiteral("*.h"), QStringLiteral("*.cpp")}, QDir::Files,
                        QDirIterator::Subdirectories);
        while (it.hasNext()) {
            const QString path = it.next();
            QFile file(path);
            if (file.open(QIODevice::ReadOnly))
                files.insert(root.relativeFilePath(path), QString::fromUtf8(file.readAll()));
        }
    }
    return files;
}

QSet<QString> registryClasses()
{
    QSet<QString> out;
    for (const ui::ScreenEntry &entry : ui::screenRegistry())
        out.insert(entry.className);
    return out;
}

QString sorted(const QSet<QString> &set)
{
    QStringList list(set.begin(), set.end());
    list.sort();
    return list.join(QStringLiteral(", "));
}

} // namespace

// The registry: exactly login, list, setup (M11-4 - registering a fourth turns this red), each bound to
// a real widget class, and the main window is declared as the window shell, not a screen.
void ScreenInventoryTest::registersExactlyTheThreeP4Screens()
{
    const QList<ui::ScreenEntry> &registry = ui::screenRegistry();
    QSet<QString> ids;
    for (const ui::ScreenEntry &entry : registry)
        ids.insert(entry.id);
    QCOMPARE(registry.size(), 3);
    QCOMPARE(ids, (QSet<QString>{QStringLiteral("login"), QStringLiteral("list"), QStringLiteral("setup")}));
    QCOMPARE(registryClasses(),
             (QSet<QString>{QStringLiteral("LoginScreen"), QStringLiteral("ListScreen"), QStringLiteral("SetupScreen")}));
    QCOMPARE(ui::windowShellClasses(), QStringList{QStringLiteral("MainWindow")});
}

// The scanner on known input - what it must find and what it must not.
void ScreenInventoryTest::scannerFindsWidgetClassesAndOnlyThose()
{
    QMap<QString, QString> files;
    files.insert(QStringLiteral("a.h"), QStringLiteral(
        "class Plain : public QWidget\n{\n    Q_OBJECT\n};\n"
        "class Derived : public Plain {};\n"
        "// class Commented : public QDialog {};\n"
        "/* class Blocked : public QWidget {}; */\n"
        "class Sealed final : public QMainWindow {};\n"
        "class Mixed : public QObject,\n              public QFrame\n{\n};\n"
        "class Model : public QObject {};\n"
        "class Painter : public QStyledItemDelegate {};\n"
        "class Forward;\n"
        "enum class Kind { A, B };\n"
        "const char *url = \"http://x/y\"; class AfterUrl : public QWidget {};\n"
        "const char *raw = R\"json({\"a\":\"// not a comment\"})json\"; class AfterRaw : public QDialog {};\n"));
    files.insert(QStringLiteral("b.cpp"), QStringLiteral(
        "namespace { struct Qualified : ui::Plain { }; }\n"
        "class Popup : private QMessageBox {};\n"));

    const QSet<QString> found = widgetClasses(files);
    const QSet<QString> expected{QStringLiteral("Plain"),   QStringLiteral("Derived"),  QStringLiteral("Sealed"),
                                 QStringLiteral("Mixed"),   QStringLiteral("AfterUrl"), QStringLiteral("AfterRaw"),
                                 QStringLiteral("Qualified"), QStringLiteral("Popup")};
    QVERIFY2(found == expected, qPrintable(QStringLiteral("found: ") + sorted(found)));
}

// The cross-check (M11-5 - a screen class nobody registered turns this red): the widget classes in the
// sources are exactly the registered screens plus the window shell.
void ScreenInventoryTest::sourcesHoldNoUnregisteredWidgetClass()
{
    QString error;
    const QMap<QString, QString> files = clientSources(&error);
    QVERIFY2(!files.isEmpty(), qPrintable(error));
    QVERIFY2(files.size() >= 40, qPrintable(QStringLiteral("non-vacuity: only %1 files scanned").arg(files.size())));
    QVERIFY2(files.contains(QStringLiteral("src/ui/listscreen.h")), "the scan did not reach src/ui");
    QVERIFY2(files.contains(QStringLiteral("app/main.cpp")), "the scan did not reach app/");

    const QSet<QString> found = widgetClasses(files);
    QSet<QString> declared = registryClasses();
    for (const QString &shell : ui::windowShellClasses())
        declared.insert(shell);

    const QSet<QString> unregistered = found - declared;
    const QSet<QString> missing = declared - found;
    QVERIFY2(unregistered.isEmpty(), qPrintable(QStringLiteral("widget classes nobody registered: ") + sorted(unregistered)));
    QVERIFY2(missing.isEmpty(), qPrintable(QStringLiteral("registered but not found by the scan: ") + sorted(missing)));
}

// What the class scan cannot see - a window made without a subclass - is closed for the dialog kinds:
// P4 has no dialog at all, so none of their names may appear outside a comment.
void ScreenInventoryTest::sourcesOpenNoDialogWindow()
{
    QString error;
    const QMap<QString, QString> files = clientSources(&error);
    QVERIFY2(!files.isEmpty(), qPrintable(error));
    static const QRegularExpression dialog(QStringLiteral(
        R"re(\b(QDialog|QMainWindow|QMessageBox|QFileDialog|QInputDialog|QWizard|QProgressDialog|QColorDialog|QFontDialog|QErrorMessage)\b)re"));
    QStringList hits;
    for (auto it = files.constBegin(); it != files.constEnd(); ++it) {
        const QRegularExpressionMatch m = dialog.match(stripComments(it.value()));
        if (m.hasMatch())
            hits << it.key() + QLatin1Char(':') + m.captured(1);
    }
    QVERIFY2(hits.isEmpty(), qPrintable(hits.join(QStringLiteral(" | "))));
}
