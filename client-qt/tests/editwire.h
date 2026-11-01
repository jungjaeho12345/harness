#ifndef CLIENT_QT_TESTS_EDITWIRE_H
#define CLIENT_QT_TESTS_EDITWIRE_H

// Edit-path test doubles shared by EditControllerTest, WriterHostTest and EditScenarioTest (phase 78 step9).
//
// EditWireModel is FakeNewsModel with every call the edit path makes RECORDED (method, article id, the client id it
// was handed, the lock action, the save dto) and with any of them SCRIPTABLE as a wire answer - turned into a
// ModelResult by the production normalisation (net::modelResultFrom over net::classifyResponse, loginwire.h), so a
// controller sees exactly what HttpNewsModel would hand it: a 401 "locked" on the lock is EditLockConflict, a 401
// "unauthenticated" is Unauthenticated, a proxy page is InvalidResponse. Unscripted calls go to the fake.
// MemoryDraftStore is an in-memory editor::IDraftStore that keeps the storage order (as the file store does).
// Test doubles: tests/tests.pro only - never common.pri (FakeNewsModelTest rule7).

#include "loginwire.h"

#include "editor/editorcontent.h"
#include "editor/editordraft.h"
#include "net/fakenewsmodel.h"
#include "net/newsmodel.h"

#include <QByteArray>
#include <QHash>
#include <QJsonObject>
#include <QList>
#include <QPair>
#include <QString>
#include <QStringList>
#include <QVariantMap>

#include <functional>
#include <memory>
#include <optional>
#include <utility>

namespace editwire {

struct ModelCall {
    QString method;
    QString articleId;
    QString clientId;
    QString action;
    QJsonObject dto;
};

// A list row / article as the fake stores it (flat: getArticle answers it as both article and contents).
inline QJsonObject articleRow(const QString &articleId, const QString &title, const QString &markupVersion)
{
    return QJsonObject{{QStringLiteral("articleId"), articleId},
                       {QStringLiteral("title"), title},
                       {QStringLiteral("status"), QStringLiteral("RDS")},
                       {QStringLiteral("lockYN"), QStringLiteral("N")},
                       {QStringLiteral("author"), QStringLiteral("reporter-name")},
                       {QStringLiteral("createdAt"), QStringLiteral("2026-11-01T00:00:00.000Z")},
                       {QStringLiteral("markupVersion"), markupVersion}};
}

// The seeded desk account plus the given articles.
inline net::FakeSeed seedWith(const QList<QJsonObject> &articles)
{
    net::FakeSeed seed = loginwire::deskSeed();
    seed.articles = articles;
    return seed;
}

class EditWireModel : public net::FakeNewsModel
{
public:
    explicit EditWireModel(const net::FakeSeed &seed = loginwire::deskSeed()) : net::FakeNewsModel(seed) {}

    QList<ModelCall> calls;
    // method name -> answers to give, in order (each used once); empty = the fake answers.
    QHash<QString, QList<net::HttpResponse>> scripted;
    // Called before each recorded call - lets a test interleave its own observations (event order).
    std::function<void(const QString &method)> onCall;

    QStringList methods() const
    {
        QStringList names;
        for (const ModelCall &call : calls)
            names << call.method;
        return names;
    }
    int count(const QString &method) const
    {
        int n = 0;
        for (const ModelCall &call : calls)
            n += call.method == method ? 1 : 0;
        return n;
    }
    QList<ModelCall> callsOf(const QString &method) const
    {
        QList<ModelCall> out;
        for (const ModelCall &call : calls) {
            if (call.method == method)
                out << call;
        }
        return out;
    }

    net::ModelResult login(const QString &userId, const QString &password) override
    {
        record({QStringLiteral("login"), {}, {}, {}, {}});
        return net::FakeNewsModel::login(userId, password);
    }
    net::ModelResult restoreSession() override
    {
        record({QStringLiteral("restoreSession"), {}, {}, {}, {}});
        if (std::optional<net::ModelResult> wire = take(QStringLiteral("restoreSession")))
            return *wire;
        return net::FakeNewsModel::restoreSession();
    }
    net::ModelResult queryArticles(const QVariantMap &filters) override
    {
        record({QStringLiteral("queryArticles"), {}, {}, {}, {}});
        return net::FakeNewsModel::queryArticles(filters);
    }
    net::ModelResult getArticle(const QString &articleId) override
    {
        record({QStringLiteral("getArticle"), articleId, {}, {}, {}});
        if (std::optional<net::ModelResult> wire = take(QStringLiteral("getArticle")))
            return *wire;
        return net::FakeNewsModel::getArticle(articleId);
    }
    net::ModelResult saveArticle(const QJsonObject &dto, const QString &clientId, const QString &action) override
    {
        record({QStringLiteral("saveArticle"), dto.value(QStringLiteral("articleId")).toString(), clientId, action, dto});
        if (std::optional<net::ModelResult> wire = take(QStringLiteral("saveArticle")))
            return *wire;
        return net::FakeNewsModel::saveArticle(dto, clientId, action);
    }
    net::ModelResult lockArticle(const QString &articleId, const QString &action, const QString &clientId) override
    {
        record({QStringLiteral("lockArticle"), articleId, clientId, action, {}});
        if (std::optional<net::ModelResult> wire = take(QStringLiteral("lockArticle")))
            return *wire;
        return net::FakeNewsModel::lockArticle(articleId, action, clientId);
    }
    net::ModelResult unlockArticle(const QString &articleId, const QString &clientId) override
    {
        record({QStringLiteral("unlockArticle"), articleId, clientId, {}, {}});
        if (std::optional<net::ModelResult> wire = take(QStringLiteral("unlockArticle")))
            return *wire;
        return net::FakeNewsModel::unlockArticle(articleId, clientId);
    }
    net::ModelResult forceUnlockArticle(const QString &articleId) override
    {
        record({QStringLiteral("forceUnlockArticle"), articleId, {}, {}, {}});
        return net::FakeNewsModel::forceUnlockArticle(articleId);
    }
    net::ModelResult applyAction(const QString &articleId, const QString &action) override
    {
        record({QStringLiteral("applyAction"), articleId, {}, action, {}});
        return net::FakeNewsModel::applyAction(articleId, action);
    }
    net::ModelResult queryUsers(const QVariantMap &filters) override
    {
        record({QStringLiteral("queryUsers"), {}, {}, {}, {}});
        return net::FakeNewsModel::queryUsers(filters);
    }

    // deferReady: the change stream reports its ready only when reportReady() says so (the fake's own stream is
    // ready at once) - a list that is entered but not live yet.
    bool deferReady = false;
    std::unique_ptr<net::Subscription> subscribe(const QVariantMap &filter, net::ChangeHandler onChange,
                                                 net::StatusHandler onStatus, net::SessionEndHandler onSessionEnd) override
    {
        if (!deferReady)
            return net::FakeNewsModel::subscribe(filter, std::move(onChange), std::move(onStatus), std::move(onSessionEnd));
        m_pendingStatus = onStatus;
        return net::FakeNewsModel::subscribe(filter, std::move(onChange), [](bool) {}, std::move(onSessionEnd));
    }
    void reportReady()
    {
        if (m_pendingStatus)
            m_pendingStatus(true);
    }

private:
    net::StatusHandler m_pendingStatus;

    void record(const ModelCall &call)
    {
        if (onCall)
            onCall(call.method);
        calls << call;
    }
    std::optional<net::ModelResult> take(const QString &method)
    {
        auto it = scripted.find(method);
        if (it == scripted.end() || it->isEmpty())
            return std::nullopt;
        return net::modelResultFrom(it->takeFirst());
    }
};

// A JSON answer of `routeId` as the transport reports it (production classification).
inline net::HttpResponse wire(const QString &routeId, int status, const QByteArray &json)
{
    return loginwire::wireAnswer(routeId, status, json);
}

class MemoryDraftStore : public editor::IDraftStore
{
public:
    struct Saved {
        QString key;
        editor::JsonValue data;
        qint64 savedAtMs = 0;
    };
    QList<Saved> entries;
    QStringList log;  // "save:<key>" / "remove:<key>" / "keys"

    void save(const QString &key, const editor::JsonValue &data, qint64 savedAtMs) override
    {
        log << QStringLiteral("save:") + key;
        for (Saved &entry : entries) {
            if (entry.key == key) {
                entry.data = data;
                entry.savedAtMs = savedAtMs;
                return;
            }
        }
        entries << Saved{key, data, savedAtMs};
    }
    std::optional<editor::DraftEntry> load(const QString &key) override
    {
        for (const Saved &entry : entries) {
            if (entry.key == key)
                return editor::DraftEntry{entry.data, static_cast<double>(entry.savedAtMs)};
        }
        return std::nullopt;
    }
    void remove(const QString &key) override
    {
        log << QStringLiteral("remove:") + key;
        for (qsizetype i = 0; i < entries.size(); ++i) {
            if (entries.at(i).key == key) {
                entries.removeAt(i);
                return;
            }
        }
    }
    QStringList keys() override
    {
        log << QStringLiteral("keys");
        QStringList out;
        for (const Saved &entry : entries)
            out << entry.key;
        return out;
    }

    const Saved *find(const QString &key) const
    {
        for (const Saved &entry : entries) {
            if (entry.key == key)
                return &entry;
        }
        return nullptr;
    }
};

// A JS-object draft value of string members (in the order given).
inline editor::JsonValue draftObject(const QList<QPair<QString, QString>> &members)
{
    editor::JsonValue out = editor::JsonValue::makeObject();
    for (const auto &member : members)
        out.insert(member.first, editor::JsonValue::makeString(member.second));
    return out;
}

inline QString stringMember(const editor::JsonValue &object, const QString &key)
{
    const editor::JsonValue *value = object.find(key);
    return value && value->kind == editor::JsonValue::Kind::String ? value->stringValue : QString();
}

} // namespace editwire

#endif // CLIENT_QT_TESTS_EDITWIRE_H
