#include "scenariotest.h"

#include "shell/appidentity.h"
#include "shell/scenario.h"

#include <QByteArray>
#include <QString>
#include <QStringList>
#include <QtTest>

#include <optional>

using shell::Scenario;
using shell::ScenarioRequest;

Q_DECLARE_METATYPE(shell::Scenario)

namespace {

const QString kUser = QStringLiteral("desk");
const QString kPassword = QStringLiteral("desk123");
const QStringList kLogin{QStringLiteral("--scenario"), QStringLiteral("login")};
const QStringList kList{QStringLiteral("--scenario"), QStringLiteral("list")};

// Sets one environment variable for the life of the object, then puts the old value back.
class ScopedEnv
{
public:
    ScopedEnv(const QString &name, const std::optional<QByteArray> &value) : m_name(name.toLatin1())
    {
        if (qEnvironmentVariableIsSet(m_name.constData()))
            m_old = qgetenv(m_name.constData());
        if (value)
            qputenv(m_name.constData(), *value);
        else
            qunsetenv(m_name.constData());
    }
    ~ScopedEnv()
    {
        if (m_old)
            qputenv(m_name.constData(), *m_old);
        else
            qunsetenv(m_name.constData());
    }

private:
    QByteArray m_name;
    std::optional<QByteArray> m_old;
};

} // namespace

void ScenarioTest::parses_data()
{
    QTest::addColumn<QStringList>("arguments");
    QTest::addColumn<QString>("selftest");
    QTest::addColumn<QString>("user");
    QTest::addColumn<QString>("password");
    QTest::addColumn<Scenario>("scenario");
    QTest::addColumn<bool>("refused");

    // No hook asked for: nothing to refuse, whatever the environment says.
    QTest::newRow("no arguments") << QStringList() << QString() << QString() << QString() << Scenario::None << false;
    QTest::newRow("no arguments under selftest") << QStringList() << QStringLiteral("1") << kUser << kPassword
                                                 << Scenario::None << false;
    QTest::newRow("--selftest alone") << QStringList{QStringLiteral("--selftest")} << QString() << QString() << QString()
                                      << Scenario::None << false;
    QTest::newRow("an unrelated argument") << QStringList{QStringLiteral("--verbose")} << QString() << QString()
                                           << QString() << Scenario::None << false;

    // The one accepted form.
    QTest::newRow("login under the guard with both credentials") << kLogin << QStringLiteral("1") << kUser
                                                                 << kPassword << Scenario::Login << false;

    // Accepted guard, unusable request -> refused, never half-run.
    QTest::newRow("no user") << kLogin << QStringLiteral("1") << QString() << kPassword << Scenario::None << true;
    QTest::newRow("no password") << kLogin << QStringLiteral("1") << kUser << QString() << Scenario::None << true;
    QTest::newRow("no scenario name") << QStringList{QStringLiteral("--scenario")} << QStringLiteral("1") << kUser
                                      << kPassword << Scenario::None << true;
    // step11: list is the same single login call - the list follows from the app's own success path.
    QTest::newRow("list under the guard with both credentials") << kList << QStringLiteral("1") << kUser << kPassword
                                                                << Scenario::List << false;
    QTest::newRow("list without a password") << kList << QStringLiteral("1") << kUser << QString() << Scenario::None
                                             << true;
    QTest::newRow("unknown scenario (editor is P5's)")
        << QStringList{QStringLiteral("--scenario"), QStringLiteral("editor")} << QStringLiteral("1") << kUser << kPassword
        << Scenario::None << true;
    QTest::newRow("name is case sensitive") << QStringList{QStringLiteral("--scenario"), QStringLiteral("LOGIN")}
                                            << QStringLiteral("1") << kUser << kPassword << Scenario::None << true;
    QTest::newRow("the = spelling is not silently ignored")
        << QStringList{QStringLiteral("--scenario=login")} << QStringLiteral("1") << kUser << kPassword << Scenario::None
        << true;
    QTest::newRow("given twice") << (kLogin + kLogin) << QStringLiteral("1") << kUser << kPassword << Scenario::None
                                 << true;
    QTest::newRow("with --selftest (it exits before the hook would run)")
        << (QStringList{QStringLiteral("--selftest")} + kLogin) << QStringLiteral("1") << kUser << kPassword
        << Scenario::None << true;
}

void ScenarioTest::parses()
{
    QFETCH(QStringList, arguments);
    QFETCH(QString, selftest);
    QFETCH(QString, user);
    QFETCH(QString, password);
    QFETCH(Scenario, scenario);
    QFETCH(bool, refused);

    const ScenarioRequest request = shell::parseScenarioRequest(arguments, selftest, user, password);
    QCOMPARE(request.refused, refused);
    QCOMPARE(request.scenario, scenario);
    QCOMPARE(request.refusal.isEmpty(), !refused);  // a refusal always says why; an acceptance says nothing
    if (refused) {
        // Nothing usable leaks out of a refused request.
        QVERIFY(request.userId.isEmpty());
        QVERIFY(request.password.isEmpty());
    }
    if (scenario == Scenario::Login || scenario == Scenario::List) {
        QCOMPARE(request.userId, user);
        QCOMPARE(request.password, password);
    }
}

// THE GUARD. Without CLIENT_SELFTEST exactly "1", every spelling of --scenario is refused - and the
// refusal names the guard, so it is the guard (not a missing credential) that stopped it. This is the
// test mutation M10-3 (guard removed) has to turn red.
void ScenarioTest::refusesEveryScenarioWithoutTheSelftestGuard_data()
{
    QTest::addColumn<QStringList>("arguments");
    QTest::addColumn<QString>("selftest");

    const QList<QPair<QString, QString>> values{{QStringLiteral("unset"), QString()},
                                                {QStringLiteral("empty"), QStringLiteral("")},
                                                {QStringLiteral("0"), QStringLiteral("0")},
                                                {QStringLiteral("true"), QStringLiteral("true")},
                                                {QStringLiteral("yes"), QStringLiteral("yes")},
                                                {QStringLiteral("space-1"), QStringLiteral(" 1")},
                                                {QStringLiteral("1-space"), QStringLiteral("1 ")},
                                                {QStringLiteral("11"), QStringLiteral("11")}};
    const QList<QPair<QString, QStringList>> spellings{
        {QStringLiteral("login"), kLogin},
        {QStringLiteral("list"), kList},
        {QStringLiteral("unknown"), QStringList{QStringLiteral("--scenario"), QStringLiteral("editor")}},
        {QStringLiteral("bare"), QStringList{QStringLiteral("--scenario")}},
        {QStringLiteral("equals"), QStringList{QStringLiteral("--scenario=login")}}};
    for (const auto &spelling : spellings) {
        for (const auto &value : values) {
            const QByteArray name = (spelling.first + QStringLiteral(" / CLIENT_SELFTEST ") + value.first).toLatin1();
            QTest::newRow(name.constData()) << spelling.second << value.second;
        }
    }
}

void ScenarioTest::refusesEveryScenarioWithoutTheSelftestGuard()
{
    QFETCH(QStringList, arguments);
    QFETCH(QString, selftest);

    const ScenarioRequest request = shell::parseScenarioRequest(arguments, selftest, kUser, kPassword);
    QVERIFY(request.refused);
    QCOMPARE(request.scenario, Scenario::None);
    QVERIFY2(request.refusal.contains(QStringLiteral("CLIENT_SELFTEST=1")), qPrintable(request.refusal));
    QVERIFY(request.userId.isEmpty());
    QVERIFY(request.password.isEmpty());
    QCOMPARE(shell::kScenarioRefusedExitCode, 2);
}

// A refusal is printed to stderr. It must never repeat what it was given: an argument can be a
// password typed into the wrong place, and the credentials are the one thing this hook must not spill.
void ScenarioTest::neverEchoesAnArgumentOrACredential()
{
    const QString secretUser = QStringLiteral("user-q9x1");
    const QString secretPassword = QStringLiteral("pw-q9x1-secret");
    const QString strayArgument = QStringLiteral("pw-typed-here-7c2");
    const QList<QPair<QStringList, QString>> cases{
        {kLogin, QString()},                                                                // guard
        {kLogin + QStringList{strayArgument}, QString()},                                    // guard + stray
        {QStringList{QStringLiteral("--scenario"), strayArgument}, QStringLiteral("1")},     // unknown name
        {QStringList{QStringLiteral("--scenario=") + strayArgument}, QStringLiteral("1")},   // = spelling
        {kLogin + kLogin, QStringLiteral("1")},                                              // twice
    };
    for (const auto &c : cases) {
        const ScenarioRequest request = shell::parseScenarioRequest(c.first, c.second, secretUser, secretPassword);
        QVERIFY2(request.refused, qPrintable(c.first.join(QLatin1Char(' '))));
        for (const QString &secret : {secretUser, secretPassword, strayArgument})
            QVERIFY2(!request.refusal.contains(secret), qPrintable(request.refusal));
        for (const QChar ch : request.refusal)
            QVERIFY2(ch.unicode() < 0x80, "refusals are ASCII (stderr of a console app)");
    }
    const ScenarioRequest noPassword = shell::parseScenarioRequest(kLogin, QStringLiteral("1"), secretUser, QString());
    QVERIFY(noPassword.refused);
    QVERIFY(!noPassword.refusal.contains(secretUser));
}

// The environment reader uses the names in appidentity.h - the ones the driver sets.
void ScenarioTest::readsItsOwnEnvironmentNames()
{
    QCOMPARE(shell::names::selftestEnvVar(), QStringLiteral("CLIENT_SELFTEST"));
    QCOMPARE(shell::names::scenarioUserEnvVar(), QStringLiteral("CLIENT_SCENARIO_USER"));
    QCOMPARE(shell::names::scenarioPasswordEnvVar(), QStringLiteral("CLIENT_SCENARIO_PASSWORD"));

    {
        ScopedEnv selftest(shell::names::selftestEnvVar(), QByteArray("1"));
        ScopedEnv user(shell::names::scenarioUserEnvVar(), QByteArray("desk"));
        ScopedEnv password(shell::names::scenarioPasswordEnvVar(), QByteArray("desk123"));
        const ScenarioRequest request = shell::scenarioRequestFromEnvironment(kLogin);
        QVERIFY2(!request.refused, qPrintable(request.refusal));
        QCOMPARE(request.scenario, Scenario::Login);
        QCOMPARE(request.userId, QStringLiteral("desk"));
        QCOMPARE(request.password, QStringLiteral("desk123"));
    }
    {
        ScopedEnv selftest(shell::names::selftestEnvVar(), std::nullopt);
        ScopedEnv user(shell::names::scenarioUserEnvVar(), QByteArray("desk"));
        ScopedEnv password(shell::names::scenarioPasswordEnvVar(), QByteArray("desk123"));
        const ScenarioRequest request = shell::scenarioRequestFromEnvironment(kLogin);
        QVERIFY(request.refused);
        QVERIFY(request.password.isEmpty());
    }
}
