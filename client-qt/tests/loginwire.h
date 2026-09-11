#ifndef CLIENT_QT_TESTS_LOGINWIRE_H
#define CLIENT_QT_TESTS_LOGINWIRE_H

// Login test doubles shared by LoginControllerTest and AppShellTest (phase 77 step10).
//
// FakeNewsModel answers login with 200 or 401 (and 403 for a deactivated account) - it does not
// simulate the server's account lock (423), its IP rate limit (429) or a server that never answers.
// WireScriptedModel scripts those as WIRE answers (an HttpResponse the transport would have produced)
// and turns them into a ModelResult with the PRODUCTION normalisation - net::modelResultFrom() over
// net::classifyResponse() - so a controller sees exactly what HttpNewsModel would hand it. In
// particular a 429 arrives as {ok:false, reason:"invalid-response"} with outcome RateLimited: the
// text/html body of express-rate-limit (step8), which is what makes "branch on the reason" wrong.

#include "net/fakenewsmodel.h"
#include "net/httptransport.h"
#include "net/newsmodel.h"

#include <QByteArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonParseError>
#include <QString>

#include <optional>

namespace loginwire {

inline const QString kUser = QStringLiteral("desk");
inline const QString kPassword = QStringLiteral("desk123");

// The seeded desk account (src/db/seed.js SAMPLE_USERS).
inline net::FakeSeed deskSeed()
{
    net::FakeSeed seed;
    seed.users << QJsonObject{{QStringLiteral("userId"), kUser},
                              {QStringLiteral("password"), kPassword},
                              {QStringLiteral("name"), QStringLiteral("박데스크")},
                              {QStringLiteral("role"), QStringLiteral("D")},
                              {QStringLiteral("department"), QStringLiteral("편집부")},
                              {QStringLiteral("departmentCode"), QStringLiteral("EDT")},
                              {QStringLiteral("active"), QStringLiteral("Y")}};
    return seed;
}

// One HTTP answer as HttpTransport::send() would report it.
inline net::HttpResponse wireAnswer(const QString &routeId, int status, const QByteArray &body)
{
    net::HttpResponse response;
    response.status = status;
    response.body = body;
    QJsonParseError error;
    const QJsonDocument document = QJsonDocument::fromJson(body, &error);
    response.jsonOk = error.error == QJsonParseError::NoError && document.isObject();
    if (response.jsonOk) {
        response.json = document.object();
        response.reason = response.json.value(QStringLiteral("reason")).toString();
    }
    response.outcome = net::classifyResponse(routeId, status, response.jsonOk, response.reason);
    return response;
}

// No HTTP answer at all (NetworkError or Timeout).
inline net::HttpResponse noAnswer(net::Outcome outcome)
{
    net::HttpResponse response;
    response.status = -1;
    response.outcome = outcome;
    return response;
}

// express-rate-limit's default 429 answer (no custom handler on loginLimiter - server/index.js 609-614).
inline net::HttpResponse rateLimited()
{
    return wireAnswer(QStringLiteral("login"), 429, QByteArrayLiteral("Too many requests, please try again later."));
}

// server/index.js 627-630: the login route's own 423 for a locked account.
inline net::HttpResponse accountLocked()
{
    return wireAnswer(QStringLiteral("login"), 423, QByteArrayLiteral(R"json({"ok":false,"reason":"locked"})json"));
}

// FakeNewsModel with login's (and the identity check's) wire answer scriptable; unscripted calls go to
// the fake itself. Counts the calls so a test can say "never asked the server".
class WireScriptedModel : public net::FakeNewsModel
{
public:
    explicit WireScriptedModel(const net::FakeSeed &seed = deskSeed()) : net::FakeNewsModel(seed) {}

    std::optional<net::HttpResponse> loginWire;
    std::optional<net::HttpResponse> sessionWire;
    int loginCalls = 0;
    int sessionCalls = 0;

    net::ModelResult login(const QString &userId, const QString &password) override
    {
        ++loginCalls;
        if (loginWire)
            return net::modelResultFrom(*loginWire);
        return net::FakeNewsModel::login(userId, password);
    }

    net::ModelResult restoreSession() override
    {
        ++sessionCalls;
        if (sessionWire)
            return net::modelResultFrom(*sessionWire);
        return net::FakeNewsModel::restoreSession();
    }
};

} // namespace loginwire

#endif // CLIENT_QT_TESTS_LOGINWIRE_H
