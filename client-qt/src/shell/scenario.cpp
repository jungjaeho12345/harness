#include "shell/scenario.h"

#include "shell/appidentity.h"

#include <QByteArray>
#include <QLatin1String>

namespace shell {
namespace {

const QLatin1String kScenarioFlag("--scenario");
const QLatin1String kScenarioFlagEquals("--scenario=");
const QLatin1String kSelftestFlag("--selftest");
const QLatin1String kLoginName("login");
const QLatin1String kListName("list");

ScenarioRequest refuse(const char *why)
{
    ScenarioRequest request;
    request.refused = true;
    request.refusal = QLatin1String(why);  // fixed text only: never an argument, never a credential
    return request;
}

QString environmentValue(const QString &name)
{
    const QByteArray key = name.toLatin1();
    return qEnvironmentVariable(key.constData());
}

} // namespace

ScenarioRequest parseScenarioRequest(const QStringList &arguments, const QString &selftestValue,
                                     const QString &userId, const QString &password)
{
    // Anything that LOOKS like the hook counts - so a spelling this parser does not accept can never
    // be silently ignored into a normal boot (nor, worse, half-understood).
    int flags = 0;
    bool equalsSpelling = false;
    for (const QString &argument : arguments) {
        if (argument == kScenarioFlag)
            ++flags;
        else if (argument.startsWith(kScenarioFlagEquals))
            equalsSpelling = true;
    }
    if (flags == 0 && !equalsSpelling)
        return ScenarioRequest();  // no hook asked for

    // THE GUARD, first and alone: without CLIENT_SELFTEST exactly "1" nothing else is even looked at.
    // An accident guard, not a security boundary (scenario.h) - fail-closed is all it can promise.
    if (selftestValue != QLatin1String("1"))
        return refuse("--scenario is refused: CLIENT_SELFTEST=1 is not set (the scenario hook is a harness-only path)");

    if (equalsSpelling)
        return refuse("--scenario is refused: write it as two arguments, --scenario <name>");
    if (flags > 1)
        return refuse("--scenario is refused: it was given more than once");
    if (arguments.contains(kSelftestFlag))
        return refuse("--scenario is refused: --selftest exits before a scenario could run");

    const qsizetype at = arguments.indexOf(kScenarioFlag);
    if (at + 1 >= arguments.size())
        return refuse("--scenario is refused: the scenario name is missing");
    const QString name = arguments.at(at + 1);
    Scenario scenario = Scenario::None;
    if (name == kLoginName)
        scenario = Scenario::Login;
    else if (name == kListName)
        scenario = Scenario::List;
    else
        return refuse("--scenario is refused: unknown scenario name (known: login, list)");

    if (userId.isEmpty() || password.isEmpty())
        return refuse("--scenario is refused: CLIENT_SCENARIO_USER and CLIENT_SCENARIO_PASSWORD must both be set");

    ScenarioRequest request;
    request.scenario = scenario;
    request.userId = userId;
    request.password = password;
    return request;
}

ScenarioRequest scenarioRequestFromEnvironment(const QStringList &arguments)
{
    return parseScenarioRequest(arguments, environmentValue(names::selftestEnvVar()),
                                environmentValue(names::scenarioUserEnvVar()),
                                environmentValue(names::scenarioPasswordEnvVar()));
}

} // namespace shell
