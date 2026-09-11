#include "timerpolicytest.h"

#include "repofiles.h"

#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QIODevice>
#include <QMap>
#include <QRegularExpression>
#include <QRegularExpressionMatchIterator>
#include <QString>
#include <QStringList>
#include <QtTest>

namespace {

// --- the scanner (pure) -------------------------------------------------------------------------

// Comments out; everything else (string literals included) is kept. Keeping literals means a source
// that merely spells "setInterval" inside a string is flagged too - fail-closed on purpose: a
// periodic timer assembled from a string is exactly the evasion this scan is for.
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
        out += c;
        ++i;
    }
    return out;
}

// The spellings that make a timer repeat (or that start one outside QTimer altogether).
const QStringList &periodicSpellings()
{
    static const QStringList spellings{QStringLiteral("setInterval("), QStringLiteral("startTimer("),
                                       QStringLiteral("setSingleShot(false)"), QStringLiteral("QBasicTimer"),
                                       QStringLiteral("timerEvent(")};
    return spellings;
}

// "QTimer m_reconnectTimer;" / "QTimer *poll = new QTimer(this);" - a declaration of a timer OBJECT.
// "QTimer::singleShot(...)", "&QTimer::timeout" and "#include <QTimer>" are not declarations.
int timerObjectCount(const QString &code)
{
    static const QRegularExpression re(QStringLiteral("\\bQTimer\\s*\\*?\\s*[A-Za-z_]\\w*\\s*[;=({,)]"));
    int count = 0;
    QRegularExpressionMatchIterator it = re.globalMatch(code);
    while (it.hasNext()) {
        it.next();
        ++count;
    }
    return count;
}

int occurrences(const QString &code, const QString &needle)
{
    int count = 0;
    for (qsizetype at = code.indexOf(needle); at >= 0; at = code.indexOf(needle, at + 1))
        ++count;
    return count;
}

// Every reason this module breaks the rule, in sentences that name the module and the count.
QStringList timerFindings(const QString &label, const QString &source)
{
    const QString code = stripComments(source);
    QStringList findings;
    for (const QString &spelling : periodicSpellings()) {
        const int n = occurrences(code, spelling);
        if (n > 0)
            findings << QStringLiteral("%1: %2 appears %3 time(s) - the app runs no periodic timer").arg(label, spelling).arg(n);
    }
    const int declared = timerObjectCount(code);
    const int singleShot = occurrences(code, QStringLiteral("setSingleShot(true)"));
    if (declared > singleShot) {
        findings << QStringLiteral("%1: declares %2 QTimer object(s) but calls setSingleShot(true) %3 time(s)")
                        .arg(label)
                        .arg(declared)
                        .arg(singleShot);
    }
    return findings;
}

// client-qt/src/** and client-qt/app/**, grouped by module (path without extension) so that a QTimer
// member declared in the header pairs with the setSingleShot(true) written in the .cpp.
QMap<QString, QString> clientModules(QString *error)
{
    QMap<QString, QString> modules;
    const QString anchor = findRepoFile(QStringLiteral("client-qt/common.pri"));
    if (anchor.isEmpty()) {
        *error = QStringLiteral("client-qt/common.pri not found from the test binary or the working directory");
        return modules;
    }
    const QDir root = QFileInfo(anchor).dir();
    for (const QString &sub : {QStringLiteral("src"), QStringLiteral("app")}) {
        QDirIterator it(root.filePath(sub), {QStringLiteral("*.h"), QStringLiteral("*.cpp")}, QDir::Files,
                        QDirIterator::Subdirectories);
        while (it.hasNext()) {
            const QString path = it.next();
            QFile file(path);
            if (!file.open(QIODevice::ReadOnly))
                continue;
            const QString relative = root.relativeFilePath(path);
            const QString module = relative.left(relative.lastIndexOf(QLatin1Char('.')));
            modules[module] += QString::fromUtf8(file.readAll()) + QLatin1Char('\n');
        }
    }
    return modules;
}

} // namespace

// The predicate itself is not vacuous: it flags each periodic spelling and an unguarded timer, it
// stays quiet on a single-shot one, and a commented-out period is not a finding.
void TimerPolicyTest::scannerFlagsPeriodicTimersAndAcceptsSingleShotOnes()
{
    const QString label = QStringLiteral("fixture");

    QVERIFY2(timerFindings(label, QStringLiteral("QTimer t; t.setSingleShot(true); t.start(50);")).isEmpty(),
             "a single-shot timer is allowed");
    QVERIFY2(timerFindings(label, QStringLiteral("QTimer::singleShot(0, this, [] {});")).isEmpty(),
             "QTimer::singleShot fires once - allowed, and it is not an object declaration");
    QVERIFY2(timerFindings(label, QStringLiteral("#include <QTimer>\nconnect(&t, &QTimer::timeout, this, &X::y);")).isEmpty(),
             "an include and a &QTimer::timeout connection declare no timer");
    QVERIFY2(timerFindings(label, QStringLiteral("// poll: t.setInterval(30000);\n/* startTimer(1000); */")).isEmpty(),
             "a commented-out period is not a finding");

    for (const QString &spelling : periodicSpellings()) {
        const QStringList found = timerFindings(label, QStringLiteral("void f() { x.%1); }").arg(spelling));
        QVERIFY2(!found.isEmpty(), qPrintable(QStringLiteral("the scanner missed %1").arg(spelling)));
    }

    const QStringList unguarded = timerFindings(label, QStringLiteral("class A { QTimer m_poll; };\nvoid A::f() { m_poll.start(30000); }"));
    QCOMPARE(unguarded.size(), 1);
    QVERIFY2(unguarded.first().contains(QStringLiteral("setSingleShot(true)")),
             qPrintable(unguarded.join(QStringLiteral(" | "))));

    const QStringList two = timerFindings(label, QStringLiteral("QTimer a; QTimer *b = new QTimer(this); a.setSingleShot(true);"));
    QCOMPARE(two.size(), 1);  // two objects, one guarded
}

// The real sources: no finding anywhere, and the scan is not looking at an empty tree.
void TimerPolicyTest::clientSourcesDeclareNoPeriodicTimer()
{
    QString error;
    const QMap<QString, QString> modules = clientModules(&error);
    QVERIFY2(error.isEmpty(), qPrintable(error));
    QVERIFY2(modules.size() >= 20, qPrintable(QStringLiteral("only %1 modules scanned - the walk lost the tree").arg(modules.size())));

    QStringList findings;
    QStringList withTimers;
    for (auto it = modules.constBegin(); it != modules.constEnd(); ++it) {
        findings << timerFindings(it.key(), it.value());
        if (timerObjectCount(stripComments(it.value())) > 0)
            withTimers << it.key();
    }
    QVERIFY2(findings.isEmpty(), qPrintable(findings.join(QStringLiteral("\n"))));

    // Non-vacuity: at least one module really declares a QTimer, so "no finding" is a judgement about
    // guarded timers and not about a tree that happens to hold none.
    QVERIFY2(!withTimers.isEmpty(), "no module declares a QTimer - this scan proved nothing");
    QVERIFY2(withTimers.contains(QStringLiteral("src/net/changestream")),
             qPrintable(QStringLiteral("the SSE reconnect timer moved or vanished; modules with timers: %1")
                            .arg(withTimers.join(QStringLiteral(", ")))));
}
