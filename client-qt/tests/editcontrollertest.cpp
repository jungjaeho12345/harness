#include "editcontrollertest.h"

#include "editwire.h"
#include "loginwire.h"
#include "repofiles.h"
#include "stubhttpserver.h"

#include "editor/editorcontent.h"
#include "editor/editordraft.h"
#include "editor/editorroles.h"
#include "editor/writerbody.h"
#include "net/httpnewsmodel.h"
#include "net/httptransport.h"
#include "ui/editcontroller.h"
#include "ui/logincontroller.h"

#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSet>
#include <QSignalSpy>
#include <QStringList>
#include <QtTest>

#include <memory>
#include <type_traits>

using editwire::EditWireModel;
using editwire::MemoryDraftStore;
using ui::EditController;
using ui::EditState;

Q_DECLARE_METATYPE(ui::EditState)

namespace {

const QString kId = QStringLiteral("AKR20261101000100001");

QString markup(const QStringList &lines)
{
    QVector<editor::Block> blocks;
    for (const QString &line : lines)
        blocks << editor::textBlock(line);
    return editor::serialize(blocks);
}

// What the widget's typing commits for these lines (step8's mapping: serializeBodyFromBlocks).
QString typed(const QStringList &lines)
{
    QVector<editor::Block> blocks;
    for (const QString &line : lines)
        blocks << editor::textBlock(line);
    return editor::serializeBodyFromBlocks(blocks);
}

QString threeLineBody()
{
    return markup({QStringLiteral("Title one"), QStringLiteral("Body line"), editor::END_MARKER});
}

QJsonObject defaultArticle()
{
    QJsonObject row = editwire::articleRow(kId, QStringLiteral("Title one"), threeLineBody());
    row.insert(QStringLiteral("category"), QStringLiteral("politics"));
    row.insert(QStringLiteral("keyword"), QStringLiteral("k1"));
    return row;
}

// One test's world: the recording fake, an in-memory draft store and a clock the test moves.
struct Rig {
    EditWireModel model;
    MemoryDraftStore drafts;
    qint64 now = 1000000;

    explicit Rig(const QList<QJsonObject> &articles = {defaultArticle()}) : model(editwire::seedWith(articles)) {}

    std::unique_ptr<EditController> surface()
    {
        return std::make_unique<EditController>(model, drafts, [this] { return now; }, QStringLiteral("w-test-scope"));
    }
    QString lockId(int i = 0) const
    {
        const QList<editwire::ModelCall> locks = model.callsOf(QStringLiteral("lockArticle"));
        return i < locks.size() ? locks.at(i).clientId : QString();
    }
};

// net::issueEditClientId's format: "c-" + a lowercase random (version 4) UUID.
const QRegularExpression &clientIdFormat()
{
    static const QRegularExpression re(
        QStringLiteral("^c-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"));
    return re;
}

QString sourceText(const QString &relative)
{
    QByteArray bytes;
    QString error;
    if (!readRepoFile(relative, &bytes, &error))
        return QString();
    return QString::fromUtf8(bytes);
}

// The refused calls a read-only / ended / closed surface answers without asking anyone.
void verifyWritesRefused(EditController &surface, Rig &rig, const char *label)
{
    rig.model.calls.clear();
    const int draftOps = static_cast<int>(rig.drafts.log.size());
    const QString body = surface.body();
    QVERIFY2(!surface.commitEdit(typed({QStringLiteral("x")}), editor::EditKind::Typing), label);
    QVERIFY2(!surface.applyEdit(typed({QStringLiteral("y")}), editor::EditKind::Operation), label);
    QVERIFY2(!surface.undo(), label);
    QVERIFY2(!surface.redo(), label);
    QVERIFY2(!surface.save(), label);
    QVERIFY2(!surface.recover(), label);
    QVERIFY2(!surface.autosave(1), label);
    QVERIFY2(rig.model.calls.isEmpty(), qPrintable(QStringLiteral("%1: %2").arg(QLatin1String(label), rig.model.methods().join(QLatin1Char(',')))));
    QVERIFY2(rig.drafts.log.size() == draftOps, label);
    QCOMPARE(surface.body(), body);
}

QJsonObject jsonOf(const QByteArray &bytes)
{
    return QJsonDocument::fromJson(bytes).object();
}

} // namespace

// web/src/controller/lockMessages.js, run by node (scratchpad s9-gen-rows.mjs): the six tokens, the default for an
// empty / null reason, and the default + " (reason)" for anything else - prototype names included (hasOwn).
void EditControllerTest::lockFailMessageMatchesTheWeb_data()
{
    QTest::addColumn<QString>("reason");
    QTest::addColumn<QString>("expected");
    QTest::newRow("locked") << QStringView(u"locked").toString() << QStringView(u"편집중입니다.").toString();
    QTest::newRow("networkError") << QStringView(u"network-error").toString() << QStringView(u"서버에 연결하지 못해 편집 잠금을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.").toString();
    QTest::newRow("invalidResponse") << QStringView(u"invalid-response").toString() << QStringView(u"서버에 연결하지 못해 편집 잠금을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.").toString();
    QTest::newRow("unauthenticated") << QStringView(u"unauthenticated").toString() << QStringView(u"세션이 만료되었습니다. 다시 로그인한 뒤 편집해 주세요.").toString();
    QTest::newRow("forbidden") << QStringView(u"forbidden").toString() << QStringView(u"이 기사를 편집할 권한이 없습니다.").toString();
    QTest::newRow("notFound") << QStringView(u"not-found").toString() << QStringView(u"기사를 찾을 수 없습니다.").toString();
    QTest::newRow("emptyReason") << QStringView(u"").toString() << QStringView(u"편집 잠금을 얻지 못해 편집할 수 없습니다.").toString();
    QTest::newRow("unknownToken") << QStringView(u"not-holder").toString() << QStringView(u"편집 잠금을 얻지 못해 편집할 수 없습니다. (not-holder)").toString();
    QTest::newRow("protoToString") << QStringView(u"toString").toString() << QStringView(u"편집 잠금을 얻지 못해 편집할 수 없습니다. (toString)").toString();
    QTest::newRow("protoProto") << QStringView(u"__proto__").toString() << QStringView(u"편집 잠금을 얻지 못해 편집할 수 없습니다. (__proto__)").toString();
    QTest::newRow("nullReason") << QString() << QStringView(u"편집 잠금을 얻지 못해 편집할 수 없습니다.").toString();
}

void EditControllerTest::lockFailMessageMatchesTheWeb()
{
    QFETCH(QString, reason);
    QFETCH(QString, expected);
    QCOMPARE(ui::lockFailMessage(reason), expected);
}

// useWriteController.js:281 - an edit entry locks with 'revise' (portalRevise is the 고침 menu's - P7).
void EditControllerTest::entersAnEditWithTheReviseLock()
{
    QCOMPARE(ui::editLockAction(), QStringLiteral("revise"));
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QList<editwire::ModelCall> locks = rig.model.callsOf(QStringLiteral("lockArticle"));
    QCOMPARE(locks.size(), 1);
    QCOMPARE(locks.first().action, QStringLiteral("revise"));
}

// useWriteController.js fieldsFromArticle: the EDITABLE_FIELDS (= editor::DRAFT_FIELDS) only; "" for null / absent;
// body = markupVersion ?? body ?? content ?? ''; nothing else of the row (status, lock, modifier, a role) is taken.
void EditControllerTest::fieldsFromArticleMapsTheEditableFields()
{
    const QJsonObject article{{QStringLiteral("articleId"), kId},
                              {QStringLiteral("title"), QStringLiteral("T")},
                              {QStringLiteral("markupVersion"), QStringLiteral("M")},
                              {QStringLiteral("body"), QStringLiteral("B")},
                              {QStringLiteral("content"), QStringLiteral("C")},
                              {QStringLiteral("author"), QStringLiteral("A")},
                              {QStringLiteral("embargoAt"), QJsonValue(QJsonValue::Null)},
                              {QStringLiteral("category"), QStringLiteral("cat")},
                              {QStringLiteral("status"), QStringLiteral("RDS")},
                              {QStringLiteral("lockYN"), QStringLiteral("Y")},
                              {QStringLiteral("modifier"), QStringLiteral("m")},
                              {QStringLiteral("role"), QStringLiteral("D")}};
    const QJsonObject fields = ui::fieldsFromArticle(article);
    QStringList expectedKeys = editor::DRAFT_FIELDS;
    expectedKeys.sort();
    QCOMPARE(fields.keys(), expectedKeys);  // exactly the 14 editable keys
    QCOMPARE(fields.value(QStringLiteral("body")).toString(), QStringLiteral("M"));
    QCOMPARE(fields.value(QStringLiteral("title")).toString(), QStringLiteral("T"));
    QCOMPARE(fields.value(QStringLiteral("author")).toString(), QStringLiteral("A"));
    QCOMPARE(fields.value(QStringLiteral("embargoAt")), QJsonValue(QString()));
    QCOMPARE(fields.value(QStringLiteral("category")).toString(), QStringLiteral("cat"));
    QCOMPARE(fields.value(QStringLiteral("keyword")), QJsonValue(QString()));

    // the body's fallback chain is JS ?? - null and absent fall through, "" does not
    QCOMPARE(ui::fieldsFromArticle({{QStringLiteral("body"), QStringLiteral("B")}, {QStringLiteral("content"), QStringLiteral("C")}})
                 .value(QStringLiteral("body")).toString(), QStringLiteral("B"));
    QCOMPARE(ui::fieldsFromArticle({{QStringLiteral("content"), QStringLiteral("C")}}).value(QStringLiteral("body")).toString(),
             QStringLiteral("C"));
    QCOMPARE(ui::fieldsFromArticle({{QStringLiteral("markupVersion"), QJsonValue(QJsonValue::Null)}, {QStringLiteral("body"), QStringLiteral("B")}})
                 .value(QStringLiteral("body")).toString(), QStringLiteral("B"));
    QCOMPARE(ui::fieldsFromArticle({{QStringLiteral("markupVersion"), QString()}, {QStringLiteral("body"), QStringLiteral("B")}})
                 .value(QStringLiteral("body")), QJsonValue(QString()));
    QCOMPARE(ui::fieldsFromArticle(QJsonObject()).value(QStringLiteral("body")), QJsonValue(QString()));
    // the author has no identity fallback here: an article without one keeps ""
    QCOMPARE(ui::fieldsFromArticle(QJsonObject()).value(QStringLiteral("author")), QJsonValue(QString()));
    // a value is taken as the article holds it (the web copies article[k])
    QCOMPARE(ui::fieldsFromArticle({{QStringLiteral("keyword"), 7}}).value(QStringLiteral("keyword")), QJsonValue(7));
}

// useWriteController.js toSaveDto: no body key (the server keeps markupVersion only - a body key loses the text), the
// body as markupVersion, the articleId; never a role, a client id or a lock field.
void EditControllerTest::toSaveDtoSendsTheBodyAsMarkupVersion()
{
    const QJsonObject fields = ui::fieldsFromArticle(defaultArticle());
    const QJsonObject dto = ui::toSaveDto(fields, kId);
    QVERIFY(!dto.contains(QStringLiteral("body")));
    QCOMPARE(dto.value(QStringLiteral("markupVersion")), fields.value(QStringLiteral("body")));
    QCOMPARE(dto.value(QStringLiteral("articleId")).toString(), kId);
    for (const QString &key : editor::DRAFT_FIELDS) {
        if (key != QLatin1String("body"))
            QVERIFY2(dto.value(key) == fields.value(key), qPrintable(key));
    }
    QCOMPARE(dto.size(), static_cast<qsizetype>(editor::DRAFT_FIELDS.size() - 1 + 2));
    for (const QString &forbidden : {QStringLiteral("role"), QStringLiteral("clientId"), QStringLiteral("editClientId"),
                                     QStringLiteral("x-edit-client"), QStringLiteral("lockerSessionId"),
                                     QStringLiteral("lockerClientId"), QStringLiteral("sessionId"), QStringLiteral("status"),
                                     QStringLiteral("lockYN")})
        QVERIFY2(!dto.contains(forbidden), qPrintable(forbidden));
    QVERIFY(!ui::toSaveDto(fields, QString()).contains(QStringLiteral("articleId")));  // the web's if (tab.articleId)
}

// WriterPage's autosave stores {...tab.fields}; saveDraft keeps the DRAFT_FIELDS string values - in that order here,
// so the stored bytes are the web's.
void EditControllerTest::draftDataKeepsTheDraftFieldsInOrder()
{
    QJsonObject fields = ui::fieldsFromArticle(defaultArticle());
    const editor::JsonValue data = ui::draftDataFrom(fields);
    QCOMPARE(data.kind, editor::JsonValue::Kind::Object);
    QStringList keys;
    for (const editor::JsonMember &member : data.members) {
        keys << member.key;
        QCOMPARE(member.value.kind, editor::JsonValue::Kind::String);
        QCOMPARE(member.value.stringValue, fields.value(member.key).toString());
    }
    QCOMPARE(keys, editor::DRAFT_FIELDS);

    fields.insert(QStringLiteral("keyword"), 7);  // not a string: not a draft value
    keys.clear();
    for (const editor::JsonMember &member : ui::draftDataFrom(fields).members)
        keys << member.key;
    QStringList expected = editor::DRAFT_FIELDS;
    expected.removeAll(QStringLiteral("keyword"));
    QCOMPARE(keys, expected);
}

// useWriteController.js openArticle: the full article first (the list row has no body), then the lock with this
// surface's id; ok:true -> an editable surface holding the article's fields; the history starts at the loaded body.
void EditControllerTest::opensWithGetThenLockAndHoldsTheLock()
{
    Rig rig;
    auto surface = rig.surface();
    QSignalSpy changed(surface.get(), &EditController::stateChanged);
    QCOMPARE(surface->state(), EditState::Opening);
    QCOMPARE(surface->open(kId), EditState::Editing);
    QCOMPARE(rig.model.methods(), (QStringList{QStringLiteral("getArticle"), QStringLiteral("lockArticle")}));
    QCOMPARE(rig.model.calls.at(0).articleId, kId);
    QCOMPARE(rig.model.calls.at(1).articleId, kId);
    QVERIFY(!rig.lockId().isEmpty());
    QVERIFY(surface->editable());
    QCOMPARE(surface->state(), EditState::Editing);
    QCOMPARE(surface->articleId(), kId);
    QCOMPARE(surface->body(), threeLineBody());
    QCOMPARE(surface->title(), QStringLiteral("Title one"));
    QCOMPARE(surface->fields().value(QStringLiteral("category")).toString(), QStringLiteral("politics"));
    QVERIFY2(surface->notice().isEmpty(), qPrintable(surface->notice()));
    QCOMPARE(surface->history().entries, QStringList{threeLineBody()});
    QCOMPARE(surface->history().index, 0);
    QVERIFY(changed.count() >= 1);
    QCOMPARE(ui::editStateName(EditState::Editing), QStringLiteral("Editing"));
}

// One open per surface, and only of an article (P5 has no new-article surface - no POST path).
void EditControllerTest::opensOnlyOnceAndOnlyAnArticle()
{
    Rig rig;
    auto surface = rig.surface();
    QCOMPARE(surface->open(QString()), EditState::Opening);
    QVERIFY(rig.model.calls.isEmpty());
    QCOMPARE(surface->open(kId), EditState::Editing);
    rig.model.calls.clear();
    QCOMPARE(surface->open(kId), EditState::Editing);
    QCOMPARE(surface->open(QStringLiteral("AKR-other")), EditState::Editing);
    QVERIFY2(rig.model.calls.isEmpty(), qPrintable(rig.model.methods().join(QLatin1Char(','))));
    QCOMPARE(surface->articleId(), kId);
}

// WriterPage seeds the history with the body as rendered - the loaded string, not re-serialized (step6 O06/O07). A
// legacy plain-text body therefore makes the first edit its own step, and undo gives the original bytes back.
void EditControllerTest::keepsTheLoadedBodyAsTheBaseline()
{
    const QString legacy = QStringView(u"Legacy title\nlegacy body (끝)").toString();
    Rig rig({editwire::articleRow(kId, QStringLiteral("Legacy title"), legacy)});
    auto surface = rig.surface();
    QCOMPARE(surface->open(kId), EditState::Editing);
    QCOMPARE(surface->body(), legacy);
    QCOMPARE(surface->history().entries, QStringList{legacy});

    const QString normalized = editor::serializeBodyFromBlocks(editor::deserialize(legacy));
    QVERIFY(normalized != legacy);
    QVERIFY(surface->commitEdit(normalized, editor::EditKind::Typing));
    QCOMPARE(surface->history().entries, (QStringList{legacy, normalized}));
    QVERIFY(surface->undo());
    QCOMPARE(surface->body(), legacy);
}

// decisions (3): this surface's lock, save and unlock carry ONE id, in net::issueEditClientId's format, and it goes
// nowhere else - not the fields, the dto, a notice, the body or a draft.
void EditControllerTest::everyCallOfASurfaceCarriesItsOwnClientId()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    QVERIFY(surface->commitEdit(typed({QStringLiteral("Title two"), QStringLiteral("Body line"), editor::END_MARKER}),
                                editor::EditKind::Typing));
    QVERIFY(surface->save());
    QVERIFY(surface->autosave(1));
    surface->close();

    const QString id = rig.lockId();
    QVERIFY2(clientIdFormat().match(id).hasMatch(), qPrintable(id));
    QCOMPARE(rig.model.callsOf(QStringLiteral("saveArticle")).size(), 1);
    QCOMPARE(rig.model.callsOf(QStringLiteral("saveArticle")).first().clientId, id);
    QCOMPARE(rig.model.callsOf(QStringLiteral("unlockArticle")).size(), 1);
    QCOMPARE(rig.model.callsOf(QStringLiteral("unlockArticle")).first().clientId, id);

    QVERIFY(!QJsonDocument(surface->fields()).toJson().contains(id.toUtf8()));
    QVERIFY(!QJsonDocument(rig.model.callsOf(QStringLiteral("saveArticle")).first().dto).toJson().contains(id.toUtf8()));
    QVERIFY(!surface->notice().contains(id));
    QVERIFY(!surface->body().contains(id));
    QCOMPARE(rig.drafts.entries.size(), 1);
    QVERIFY(!editor::stringifyJson(rig.drafts.entries.first().data).contains(id));
}

// A surface's id is its own: two surfaces at once, or one made after another closed, never share one.
void EditControllerTest::twoSurfacesNeverShareAClientId()
{
    Rig rig({defaultArticle(), editwire::articleRow(QStringLiteral("AKR2"), QStringLiteral("Second"), threeLineBody())});
    auto first = rig.surface();
    auto second = rig.surface();
    QCOMPARE(first->open(kId), EditState::Editing);
    QCOMPARE(second->open(QStringLiteral("AKR2")), EditState::Editing);
    const QString a = rig.lockId(0);
    const QString b = rig.lockId(1);
    QVERIFY2(clientIdFormat().match(a).hasMatch() && clientIdFormat().match(b).hasMatch(), qPrintable(a + QLatin1Char(' ') + b));
    QVERIFY2(a != b, "two surfaces were handed the same EditClientId");

    first->close();
    auto third = rig.surface();
    QCOMPARE(third->open(kId), EditState::Editing);
    const QString c = rig.lockId(2);
    QVERIFY2(c != a && c != b, "a new surface reused an earlier surface's EditClientId");
}

// The collapse decisions (3) exists to prevent: a second surface on an article another surface holds is refused the
// lock ('편집중입니다.') - with a shared id the server (and the fake) would call it "the same tab re-acquiring" and both
// would hold it and both would PUT. The refused surface never PUTs and never unlocks; the holder keeps working.
void EditControllerTest::aSecondSurfaceOnTheSameArticleIsRefusedTheLock()
{
    Rig rig;
    auto holder = rig.surface();
    auto other = rig.surface();
    QCOMPARE(holder->open(kId), EditState::Editing);
    QCOMPARE(other->open(kId), EditState::LockRefused);
    QCOMPARE(other->notice(), ui::lockFailMessage(QStringLiteral("locked")));
    QVERIFY(!other->editable());
    QCOMPARE(other->body(), threeLineBody());  // shown read only
    verifyWritesRefused(*other, rig, "refused surface");
    other->close();
    QVERIFY2(rig.model.calls.isEmpty(), qPrintable(rig.model.methods().join(QLatin1Char(','))));

    QVERIFY(holder->commitEdit(typed({QStringLiteral("Held"), editor::END_MARKER}), editor::EditKind::Typing));
    QVERIFY(holder->save());
}

// useWriteController.js:285-291 (phase53 step5): any lock answer but ok:true is fail-closed - read only, the web's
// sentence. 401 'locked' is the edit-lock conflict (the session is fine); 401 'unauthenticated' ends the session.
void EditControllerTest::lockRefusalsAreFailClosed_data()
{
    QTest::addColumn<int>("status");      // -1 = no HTTP answer
    QTest::addColumn<int>("noAnswer");    // net::Outcome of a missing answer
    QTest::addColumn<QByteArray>("body");
    QTest::addColumn<EditState>("expectedState");
    QTest::addColumn<QString>("reason");  // lockFailMessage(reason) is the notice
    const int none = static_cast<int>(net::Outcome::NetworkError);
    QTest::newRow("conflict 401 locked") << 401 << none << QByteArray(R"({"ok":false,"reason":"locked"})") << EditState::LockRefused << QStringLiteral("locked");
    QTest::newRow("network error") << -1 << none << QByteArray() << EditState::LockRefused << QStringLiteral("network-error");
    QTest::newRow("timeout") << -1 << static_cast<int>(net::Outcome::Timeout) << QByteArray() << EditState::LockRefused << QStringLiteral("network-error");
    QTest::newRow("proxy page") << 502 << none << QByteArray("<html>bad gateway</html>") << EditState::LockRefused << QStringLiteral("invalid-response");
    QTest::newRow("forbidden 403") << 403 << none << QByteArray(R"({"ok":false,"reason":"forbidden"})") << EditState::LockRefused << QStringLiteral("forbidden");
    QTest::newRow("not found 404") << 404 << none << QByteArray(R"({"ok":false,"reason":"not-found"})") << EditState::LockRefused << QStringLiteral("not-found");
    QTest::newRow("unknown token") << 409 << none << QByteArray(R"({"ok":false,"reason":"conflict-x"})") << EditState::LockRefused << QStringLiteral("conflict-x");
    QTest::newRow("200 ok false") << 200 << none << QByteArray(R"({"ok":false})") << EditState::LockRefused << QString();
    QTest::newRow("200 ok not true") << 200 << none << QByteArray(R"({"ok":"yes"})") << EditState::LockRefused << QString();
    QTest::newRow("200 empty object") << 200 << none << QByteArray("{}") << EditState::LockRefused << QString();
    QTest::newRow("unauthenticated 401") << 401 << none << QByteArray(R"({"ok":false,"reason":"unauthenticated"})") << EditState::SessionEnded << QStringLiteral("unauthenticated");
}

void EditControllerTest::lockRefusalsAreFailClosed()
{
    QFETCH(int, status);
    QFETCH(int, noAnswer);
    QFETCH(QByteArray, body);
    QFETCH(EditState, expectedState);
    QFETCH(QString, reason);

    Rig rig;
    rig.model.scripted[QStringLiteral("lockArticle")] << (status < 0 ? loginwire::noAnswer(static_cast<net::Outcome>(noAnswer))
                                                                    : editwire::wire(QStringLiteral("articles-lock"), status, body));
    auto surface = rig.surface();
    QCOMPARE(surface->open(kId), expectedState);
    QVERIFY(!surface->editable());
    QCOMPARE(surface->notice(), ui::lockFailMessage(reason));
    verifyWritesRefused(*surface, rig, QTest::currentDataTag());
    surface->close();
    QVERIFY2(rig.model.calls.isEmpty(), "a surface without the lock unlocked");
    QCOMPARE(surface->state(), EditState::Closed);
}

// A body that could not be loaded is never locked (fail closed - the web would fall back to the list row, which has no
// body, and a save would write that empty body over the article).
void EditControllerTest::aBodyThatCannotBeLoadedIsNeverLocked_data()
{
    QTest::addColumn<int>("status");
    QTest::addColumn<QByteArray>("body");
    QTest::addColumn<EditState>("expectedState");
    QTest::addColumn<QString>("noticeHas");
    QTest::newRow("not found 404") << 404 << QByteArray(R"({"ok":false,"reason":"not-found"})") << EditState::LoadFailed << QStringLiteral("(HTTP 404)");
    QTest::newRow("network error") << -1 << QByteArray() << EditState::LoadFailed
                                   << ui::loginFailureMessage(ui::LoginFailure::Unreachable);
    QTest::newRow("proxy page") << 502 << QByteArray("<html/>") << EditState::LoadFailed
                                << ui::loginFailureMessage(ui::LoginFailure::InvalidResponse);
    QTest::newRow("200 ok false") << 200 << QByteArray(R"({"ok":false})") << EditState::LoadFailed << QStringLiteral("(HTTP 200)");
    QTest::newRow("unauthenticated 401") << 401 << QByteArray(R"({"ok":false,"reason":"unauthenticated"})") << EditState::SessionEnded
                                         << ui::sessionEndedMessage();
}

void EditControllerTest::aBodyThatCannotBeLoadedIsNeverLocked()
{
    QFETCH(int, status);
    QFETCH(QByteArray, body);
    QFETCH(EditState, expectedState);
    QFETCH(QString, noticeHas);

    Rig rig;
    rig.model.scripted[QStringLiteral("getArticle")] << (status < 0 ? loginwire::noAnswer(net::Outcome::NetworkError)
                                                                   : editwire::wire(QStringLiteral("articles-get"), status, body));
    auto surface = rig.surface();
    QCOMPARE(surface->open(kId), expectedState);
    QCOMPARE(rig.model.methods(), QStringList{QStringLiteral("getArticle")});  // no lock asked
    QVERIFY(!surface->editable());
    QVERIFY(surface->body().isEmpty());
    QVERIFY2(surface->notice().contains(noticeHas), qPrintable(surface->notice()));
    verifyWritesRefused(*surface, rig, QTest::currentDataTag());
    surface->close();
    QVERIFY(rig.model.calls.isEmpty());
}

// A surface another one holds: the article is shown, nothing writes - no PUT, no draft, no unlock (the web never even
// opens it; useViewController.js:177-179 "잠금 해제도 시도하지 않는다").
void EditControllerTest::readOnlySurfacesNeverWrite()
{
    QJsonObject held = defaultArticle();
    held.insert(QStringLiteral("lockYN"), QStringLiteral("Y"));
    held.insert(QStringLiteral("lockerClientId"), QStringLiteral("c-someone-else"));
    Rig rig({held});
    auto surface = rig.surface();
    QCOMPARE(surface->open(kId), EditState::LockRefused);
    QCOMPARE(surface->body(), threeLineBody());
    QCOMPARE(surface->title(), QStringLiteral("Title one"));
    verifyWritesRefused(*surface, rig, "held elsewhere");
    surface->close();
    QVERIFY(rig.model.calls.isEmpty());
    QVERIFY(rig.drafts.log.isEmpty());
}

// File > Save of an existing article (WriterPage saveDocument -> save): PUT with the surface's id, the body as
// markupVersion and the title the commit derived; the surface keeps editing (no unlock, no reset) and the draft stays.
void EditControllerTest::savePutsTheEditedBodyWithTheSurfaceId()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QString edited = typed({QStringLiteral("New title"), QStringLiteral("Body line"), editor::END_MARKER});
    QVERIFY(surface->commitEdit(edited, editor::EditKind::Typing));
    const QString lockId = rig.lockId();
    QVERIFY(!lockId.isEmpty());
    rig.model.calls.clear();

    QVERIFY(surface->save());
    QCOMPARE(rig.model.methods(), QStringList{QStringLiteral("saveArticle")});
    const editwire::ModelCall put = rig.model.calls.first();
    QCOMPARE(put.dto.value(QStringLiteral("articleId")).toString(), kId);
    QCOMPARE(put.dto.value(QStringLiteral("markupVersion")).toString(), edited);
    QCOMPARE(put.dto.value(QStringLiteral("title")).toString(), QStringLiteral("New title"));
    QVERIFY(!put.dto.contains(QStringLiteral("body")));
    QVERIFY(put.action.isEmpty());  // a PUT never carries an action
    QCOMPARE(put.clientId, lockId);
    QCOMPARE(surface->notice(), QStringView(u"저장되었습니다.").toString());
    QVERIFY(surface->editable());
    QVERIFY(rig.drafts.log.isEmpty());
    const net::ModelResult stored = rig.model.net::FakeNewsModel::getArticle(kId);
    QCOMPARE(stored.body.value(QStringLiteral("article")).toObject().value(QStringLiteral("markupVersion")).toString(), edited);
}

// A save the server refuses tells the user and changes nothing else: still editing, still holding (the web keeps the
// tab; its change-stream handler - P7 here - closes it on a takeover).
void EditControllerTest::aFailedSaveKeepsEditing_data()
{
    QTest::addColumn<int>("status");
    QTest::addColumn<QByteArray>("body");
    QTest::newRow("not holder 403") << 403 << QByteArray(R"({"ok":false,"reason":"not-holder"})");
    QTest::newRow("network error") << -1 << QByteArray();
    QTest::newRow("server error 500") << 500 << QByteArray(R"({"ok":false,"reason":"internal"})");
    QTest::newRow("200 ok false") << 200 << QByteArray(R"({"ok":false})");
}

void EditControllerTest::aFailedSaveKeepsEditing()
{
    QFETCH(int, status);
    QFETCH(QByteArray, body);
    Rig rig;
    rig.model.scripted[QStringLiteral("saveArticle")] << (status < 0 ? loginwire::noAnswer(net::Outcome::NetworkError)
                                                                    : editwire::wire(QStringLiteral("articles-update"), status, body));
    auto surface = rig.surface();
    surface->open(kId);
    QVERIFY(!surface->save());
    QCOMPARE(surface->notice(), QStringView(u"저장에 실패했습니다.").toString());
    QCOMPARE(surface->state(), EditState::Editing);
    QVERIFY(surface->editable());
}

// decisions (3) / mutation (c): the server's 401 is obeyed, never papered over by a remembered identity - the surface
// ends (read only, the session sentence), asks nothing more and does not even unlock.
void EditControllerTest::aSessionThatEndsOnSaveStopsTheSurface()
{
    Rig rig;
    rig.model.scripted[QStringLiteral("saveArticle")]
        << editwire::wire(QStringLiteral("articles-update"), 401, R"({"ok":false,"reason":"unauthenticated"})");
    auto surface = rig.surface();
    surface->open(kId);
    QVERIFY(surface->commitEdit(typed({QStringLiteral("Unsaved"), editor::END_MARKER}), editor::EditKind::Typing));
    QVERIFY(!surface->save());
    QCOMPARE(surface->state(), EditState::SessionEnded);
    QCOMPARE(surface->notice(), ui::sessionEndedMessage());
    QVERIFY(!surface->editable());
    verifyWritesRefused(*surface, rig, "session ended");
    surface->close();
    QVERIFY2(rig.model.calls.isEmpty(), "a surface whose session ended sent another request");
}

// override L123-128: no identity is asked for (no login, no session question, no user list) and no role is ever
// written; the controller's source names no lock-holder field (none is in any answer - L131).
void EditControllerTest::noIdentityIsAskedOrKept()
{
    Rig rig;
    rig.drafts.save(kId, editwire::draftObject({{QStringLiteral("body"), typed({QStringLiteral("Draft"), editor::END_MARKER})}}), 1);
    auto surface = rig.surface();
    surface->open(kId);
    surface->commitEdit(typed({QStringLiteral("A"), editor::END_MARKER}), editor::EditKind::Typing);
    surface->save();
    surface->autosave(1);
    surface->recover();
    surface->undo();
    surface->close();
    for (const QString &method : {QStringLiteral("login"), QStringLiteral("restoreSession"), QStringLiteral("queryUsers"),
                                  QStringLiteral("queryArticles"), QStringLiteral("forceUnlockArticle"),
                                  QStringLiteral("applyAction")})
        QVERIFY2(rig.model.count(method) == 0, qPrintable(method));
    for (const editwire::ModelCall &put : rig.model.callsOf(QStringLiteral("saveArticle")))
        QVERIFY(!put.dto.contains(QStringLiteral("role")));

    const QString source = sourceText(QStringLiteral("client-qt/src/ui/editcontroller.cpp"));
    QVERIFY2(source.size() > 1000, "editcontroller.cpp not found");
    for (const QString &token : {QStringLiteral("lockerSessionId"), QStringLiteral("lockerClientId"), QStringLiteral("lockerUserId"),
                                 QStringLiteral("restoreSession"), QStringLiteral("checkSession"), QStringLiteral("\"role\""),
                                 QStringLiteral("identity")})
        QVERIFY2(!source.contains(token), qPrintable(QStringLiteral("editcontroller.cpp names ") + token));
}

// closeTab (useWriteController.js:220-247): the surface holding the lock unlocks with its own id - once - and is over.
void EditControllerTest::closeUnlocksOnceWithTheSurfaceId()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QString id = rig.lockId();
    rig.model.calls.clear();
    surface->close();
    QCOMPARE(rig.model.methods(), QStringList{QStringLiteral("unlockArticle")});
    QCOMPARE(rig.model.calls.first().articleId, kId);
    QCOMPARE(rig.model.calls.first().clientId, id);
    QCOMPARE(surface->state(), EditState::Closed);
    surface->close();
    QCOMPARE(rig.model.calls.size(), 1);
    verifyWritesRefused(*surface, rig, "closed");

    auto next = rig.surface();  // the fake released it: a new surface gets the lock
    QCOMPARE(next->open(kId), EditState::Editing);
}

// WriterPage.commitBody: every commit re-derives the title from the body's first line (writerBody.bodyTitle) - the fix
// for the stale title of phase 28.
void EditControllerTest::commitRederivesTheTitle()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QString body = typed({QStringLiteral("  Spaced title  "), QStringLiteral("Body line"), editor::END_MARKER});
    QVERIFY(surface->commitEdit(body, editor::EditKind::Typing));
    QCOMPARE(surface->title(), QStringLiteral("Spaced title"));
    QCOMPARE(surface->fields().value(QStringLiteral("title")).toString(), QStringLiteral("Spaced title"));
    QCOMPARE(surface->fields().value(QStringLiteral("body")).toString(), body);
    QCOMPARE(surface->body(), body);
}

// WriterPage.commitBody coalescing: typing within 500 ms of the previous typing replaces the top; exactly 500 ms is a
// new step (the web's strict "<").
void EditControllerTest::typingCoalescesWithinTheWindow()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QString base = surface->body();
    const QString b1 = typed({QStringLiteral("Title oneA"), editor::END_MARKER});
    const QString b2 = typed({QStringLiteral("Title oneAB"), editor::END_MARKER});
    const QString b3 = typed({QStringLiteral("Title oneABC"), editor::END_MARKER});
    const QString b4 = typed({QStringLiteral("Title oneABCD"), editor::END_MARKER});
    rig.now = 10000;
    QVERIFY(surface->commitEdit(b1, editor::EditKind::Typing));
    rig.now = 10200;
    QVERIFY(surface->commitEdit(b2, editor::EditKind::Typing));
    QCOMPARE(surface->history().entries, (QStringList{base, b2}));
    rig.now = 10700;  // exactly COALESCE_MS later
    QVERIFY(surface->commitEdit(b3, editor::EditKind::Typing));
    QCOMPARE(surface->history().entries, (QStringList{base, b2, b3}));
    rig.now = 10750;
    QVERIFY(surface->commitEdit(b4, editor::EditKind::Typing));
    QCOMPARE(surface->history().entries, (QStringList{base, b2, b4}));
    QVERIFY(surface->undo());
    QCOMPARE(surface->body(), b2);
    QVERIFY(surface->undo());
    QCOMPARE(surface->body(), base);
    QVERIFY(!surface->undo());
}

// The coalescing boundary of WriterPage (wasTyping): an edit operation is its own step, and the first typing after it
// does not replace it even inside the window.
void EditControllerTest::anEditOperationIsAlwaysItsOwnStep()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QString base = surface->body();
    const QString b1 = typed({QStringLiteral("t1"), editor::END_MARKER});
    const QString b2 = editor::serialize({editor::textBlock(QStringLiteral("T1")), editor::textBlock(editor::END_MARKER)});
    const QString b3 = typed({QStringLiteral("T1x"), editor::END_MARKER});
    const QString b4 = typed({QStringLiteral("T1xy"), editor::END_MARKER});
    rig.now = 1000;
    surface->commitEdit(b1, editor::EditKind::Typing);
    rig.now = 1100;
    surface->commitEdit(b2, editor::EditKind::Operation);
    rig.now = 1150;
    surface->commitEdit(b3, editor::EditKind::Typing);
    rig.now = 1200;
    surface->commitEdit(b4, editor::EditKind::Typing);
    QCOMPARE(surface->history().entries, (QStringList{base, b1, b2, b4}));
}

// WriterPage sets lastCommitRef on every commit - a commit of the body it already holds (a no-op push) included. So
// the next typing measures its window from that no-op.
void EditControllerTest::aNoOpCommitStillMovesTheMark()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QString base = surface->body();
    const QString b1 = typed({QStringLiteral("same"), editor::END_MARKER});
    const QString b2 = typed({QStringLiteral("same!"), editor::END_MARKER});
    rig.now = 1000;
    surface->commitEdit(b1, editor::EditKind::Typing);
    rig.now = 1400;
    surface->commitEdit(b1, editor::EditKind::Typing);  // no-op push
    QCOMPARE(surface->history().entries, (QStringList{base, b1}));
    rig.now = 1800;  // 800 ms after the first typing, 400 ms after the no-op
    surface->commitEdit(b2, editor::EditKind::Typing);
    QCOMPARE(surface->history().entries, (QStringList{base, b2}));
}

// HISTORY_LIMIT 100 on every push: the oldest goes first - the baseline too.
void EditControllerTest::historyIsCappedAtOneHundred()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QString base = surface->body();
    for (int i = 1; i <= 150; ++i) {
        rig.now += 1000;
        QVERIFY(surface->commitEdit(markup({QStringLiteral("v%1").arg(i), editor::END_MARKER}), editor::EditKind::Operation));
    }
    QCOMPARE(surface->history().entries.size(), ui::kHistoryLimit);
    QCOMPARE(surface->history().entries.first(), markup({QStringLiteral("v51"), editor::END_MARKER}));
    QCOMPARE(surface->history().index, ui::kHistoryLimit - 1);
    QVERIFY(!surface->history().entries.contains(base));
}

// doUndo / doRedo: the snapshot is written back (body and title) WITHOUT a capture - the entries stay, the index moves -
// and the view is told (bodyReplaced). A new commit after an undo cuts the redo branch.
void EditControllerTest::undoAndRedoRestoreWithoutACapture()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QString base = surface->body();
    const QString b1 = markup({QStringLiteral("First"), editor::END_MARKER});
    const QString b2 = markup({QStringLiteral("Second"), editor::END_MARKER});
    const QString b3 = markup({QStringLiteral("Third"), editor::END_MARKER});
    surface->commitEdit(b1, editor::EditKind::Operation);
    surface->commitEdit(b2, editor::EditKind::Operation);
    QSignalSpy replaced(surface.get(), &EditController::bodyReplaced);

    QVERIFY(surface->undo());
    QCOMPARE(surface->body(), b1);
    QCOMPARE(surface->title(), QStringLiteral("First"));
    QCOMPARE(surface->history().entries, (QStringList{base, b1, b2}));
    QCOMPARE(surface->history().index, 1);
    QVERIFY(surface->undo());
    QCOMPARE(surface->body(), base);
    QCOMPARE(surface->title(), QStringLiteral("Title one"));
    QVERIFY(!surface->undo());
    QCOMPARE(replaced.count(), 2);
    QVERIFY(surface->redo());
    QVERIFY(surface->redo());
    QCOMPARE(surface->body(), b2);
    QVERIFY(!surface->redo());
    QCOMPARE(replaced.count(), 4);

    QVERIFY(surface->undo());
    surface->commitEdit(b3, editor::EditKind::Operation);
    QCOMPARE(surface->history().entries, (QStringList{base, b1, b3}));
    QVERIFY(!surface->redo());
}

// An edit made outside the view is committed like the view's and announced; the view's own edit is not echoed back.
void EditControllerTest::applyEditAnnouncesTheNewBody()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const QString base = surface->body();
    QSignalSpy replaced(surface.get(), &EditController::bodyReplaced);
    const QString b1 = typed({QStringLiteral("Applied"), editor::END_MARKER});
    QVERIFY(surface->applyEdit(b1, editor::EditKind::Typing));
    QCOMPARE(replaced.count(), 1);
    QCOMPARE(surface->body(), b1);
    QCOMPARE(surface->title(), QStringLiteral("Applied"));
    QCOMPARE(surface->history().entries, (QStringList{base, b1}));
    QVERIFY(surface->commitEdit(typed({QStringLiteral("Typed"), editor::END_MARKER}), editor::EditKind::Typing));
    QCOMPARE(replaced.count(), 1);
}

// WriterPage File > Recover (phase 54): the draft's body is ONE undo step (no coalescing with the typing just before),
// the title is re-derived from it (the stored title is not used), the other editable fields come back as stored, and
// the draft is cleared under the key it was found at. Undo goes back to before the recovery, redo re-applies it. No
// confirm dialog here - P5 has no dialog window; the undo step is the way back.
void EditControllerTest::recoverIsOneUndoStepAndClearsTheDraft()
{
    Rig rig;
    const QString draftBody = typed({QStringLiteral("Draft first line"), QStringLiteral("draft body"), editor::END_MARKER});
    rig.drafts.save(kId, editwire::draftObject({{QStringLiteral("title"), QStringLiteral("stale stored title")},
                                                {QStringLiteral("body"), draftBody},
                                                {QStringLiteral("keyword"), QStringLiteral("k-draft")},
                                                {QStringLiteral("author"), QStringLiteral("draft author")}}),
                    500);
    auto surface = rig.surface();
    surface->open(kId);
    const QString base = surface->body();
    const QString b1 = typed({QStringLiteral("Typed first"), editor::END_MARKER});
    rig.now = 2000;
    surface->commitEdit(b1, editor::EditKind::Typing);
    QSignalSpy replaced(surface.get(), &EditController::bodyReplaced);
    rig.now = 2100;
    QVERIFY(surface->recover());
    QCOMPARE(surface->body(), draftBody);
    QCOMPARE(surface->title(), QStringLiteral("Draft first line"));
    QCOMPARE(surface->fields().value(QStringLiteral("keyword")).toString(), QStringLiteral("k-draft"));
    QCOMPARE(surface->fields().value(QStringLiteral("author")).toString(), QStringLiteral("draft author"));
    QCOMPARE(surface->history().entries, (QStringList{base, b1, draftBody}));
    QCOMPARE(replaced.count(), 1);
    QVERIFY(rig.drafts.find(kId) == nullptr);
    QVERIFY(rig.drafts.log.contains(QStringLiteral("remove:") + kId));
    QVERIFY(!surface->notice().isEmpty());

    QVERIFY(surface->undo());
    QCOMPARE(surface->body(), b1);
    QVERIFY(surface->redo());
    QCOMPARE(surface->body(), draftBody);
    rig.now = 2150;  // a typing right after the recovery is its own step too (the recovery was not typing)
    const QString b5 = typed({QStringLiteral("after"), editor::END_MARKER});
    surface->commitEdit(b5, editor::EditKind::Typing);
    QCOMPARE(surface->history().entries, (QStringList{base, b1, draftBody, b5}));
}

void EditControllerTest::recoverWithoutADraftSaysSo()
{
    Rig rig;
    auto surface = rig.surface();
    surface->open(kId);
    const editor::History before = surface->history();
    QVERIFY(!surface->recover());
    QCOMPARE(surface->notice(), QStringView(u"복구할 자동저장 내용이 없습니다.").toString());
    QCOMPARE(surface->body(), threeLineBody());
    QVERIFY(surface->history() == before);
}

// WriterPage's autosave tick: draftKeyFor (an existing article's key is its id), the fields as they are now, the
// caller's now - then expireDrafts with that same now (a draft older than the retention goes, the boundary stays).
void EditControllerTest::autosaveStoresTheFieldsUnderTheArticleKey()
{
    Rig rig;
    const qint64 day = 86400000;
    rig.now = 5000000000;
    rig.drafts.save(QStringLiteral("OLD"), editwire::draftObject({{QStringLiteral("body"), QStringLiteral("old")}}), rig.now - 3 * day);
    rig.drafts.save(QStringLiteral("EDGE"), editwire::draftObject({{QStringLiteral("body"), QStringLiteral("edge")}}), rig.now - day);
    rig.drafts.save(QStringLiteral("FRESH"), editwire::draftObject({{QStringLiteral("body"), QStringLiteral("fresh")}}), rig.now - 3600000);
    rig.drafts.log.clear();
    auto surface = rig.surface();
    surface->open(kId);
    const QString b1 = typed({QStringLiteral("Autosaved title"), editor::END_MARKER});
    surface->commitEdit(b1, editor::EditKind::Typing);

    QVERIFY(surface->autosave(1));
    const MemoryDraftStore::Saved *saved = rig.drafts.find(kId);
    QVERIFY(saved);
    QCOMPARE(saved->savedAtMs, rig.now);
    QStringList keys;
    for (const editor::JsonMember &member : saved->data.members)
        keys << member.key;
    QCOMPARE(keys, editor::DRAFT_FIELDS);
    QCOMPARE(editwire::stringMember(saved->data, QStringLiteral("body")), b1);
    QCOMPARE(editwire::stringMember(saved->data, QStringLiteral("title")), QStringLiteral("Autosaved title"));
    QCOMPARE(editwire::stringMember(saved->data, QStringLiteral("category")), QStringLiteral("politics"));
    QVERIFY(rig.drafts.find(QStringLiteral("OLD")) == nullptr);
    QVERIFY(rig.drafts.find(QStringLiteral("EDGE")) != nullptr);  // savedAt == now - 1 day: not older than it
    QVERIFY(rig.drafts.find(QStringLiteral("FRESH")) != nullptr);
    QVERIFY(rig.drafts.log.indexOf(QStringLiteral("save:") + kId) < rig.drafts.log.indexOf(QStringLiteral("keys")));
}

// WriterPage: "빈 탭은 스냅샷 안 함" - body and title both empty, nothing is stored.
void EditControllerTest::autosaveSkipsAnEmptySurface()
{
    Rig rig({editwire::articleRow(kId, QString(), QString())});
    auto surface = rig.surface();
    QCOMPARE(surface->open(kId), EditState::Editing);
    QVERIFY(surface->body().isEmpty());
    QVERIFY(surface->title().isEmpty());
    QVERIFY(!surface->autosave(1));
    QVERIFY(rig.drafts.log.isEmpty());
}

// ADR-003 / decisions (7): the controller is the Model interface, the draft store and an injected clock - no widget,
// no transport, no timer, no wall clock of its own.
void EditControllerTest::dependsOnNoWidgetNoTimerAndNoTransport()
{
    static_assert(std::is_constructible_v<EditController, net::INewsModel &, editor::IDraftStore &, EditController::Clock,
                                          const QString &>,
                  "EditController(INewsModel&, IDraftStore&, Clock, scope) - step9");
    static_assert(!std::is_copy_constructible_v<EditController>, "one controller per surface");
    const QStringList forbidden{QStringLiteral("QWidget"),        QStringLiteral("QLabel"),
                                QStringLiteral("QPushButton"),    QStringLiteral("QApplication"),
                                QStringLiteral("ui/editorwidget.h"), QStringLiteral("ui/mainwindow.h"),
                                QStringLiteral("HttpTransport"),  QStringLiteral("HttpNewsModel"),
                                QStringLiteral("QTimer"),         QStringLiteral("startTimer"),
                                QStringLiteral("singleShot"),     QStringLiteral("QDateTime"),
                                QStringLiteral("currentMSecsSinceEpoch"), QStringLiteral("QSettings")};
    for (const QString &relative : {QStringLiteral("client-qt/src/ui/editcontroller.h"),
                                    QStringLiteral("client-qt/src/ui/editcontroller.cpp")}) {
        const QString text = sourceText(relative);
        QVERIFY2(text.size() > 1000, qPrintable(relative));
        for (const QString &token : forbidden)
            QVERIFY2(!text.contains(token), qPrintable(relative + QStringLiteral(" names ") + token));
    }
}

// The wire (decisions (3), the AC "x-edit-client on exactly three routes"): the controller over the production Model and
// transport against a loopback stub. Of the four requests of one surface's round trip, exactly the lock, the PUT and
// the unlock carry x-edit-client - one value, the surface's - and the GET carries none; the lock body is
// {"action":"revise"}, the PUT body has markupVersion and no body / role key, the unlock has no body. A second surface
// sends a different value.
void EditControllerTest::carriesXEditClientOnExactlyTheThreeEditRoutesOnTheWire()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    const QString wireBody = markup({QStringLiteral("Wire title"), QStringLiteral("wire body"), editor::END_MARKER});
    const QByteArray article = QJsonDocument(QJsonObject{
        {QStringLiteral("ok"), true},
        {QStringLiteral("article"), QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")},
                                                {QStringLiteral("title"), QStringLiteral("Wire title")},
                                                {QStringLiteral("markupVersion"), wireBody}}},
        {QStringLiteral("contents"), QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")},
                                                 {QStringLiteral("status"), QStringLiteral("RDS")},
                                                 {QStringLiteral("lockYN"), QStringLiteral("N")},
                                                 {QStringLiteral("author"), QStringLiteral("w")}}}}).toJson(QJsonDocument::Compact);
    stub.handle([article](const StubRequest &request) {
        if (request.method == "GET" && request.target == "/api/articles/AKR1")
            return StubReply::json(200, article);
        if (request.method == "POST" && request.target.endsWith("/lock"))
            return StubReply::json(200, R"({"ok":true})");
        if (request.method == "PUT" && request.target == "/api/articles/AKR1")
            return StubReply::json(200, R"({"ok":true,"changes":1})");
        if (request.method == "POST" && request.target.endsWith("/unlock"))
            return StubReply::json(200, R"({"ok":true})");
        return StubReply::json(404, R"({"ok":false,"reason":"not-found"})");
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel model(&transport);
    MemoryDraftStore drafts;
    qint64 now = 1000;
    const QString edited = typed({QStringLiteral("Wire title!"), QStringLiteral("wire body"), editor::END_MARKER});
    for (int run = 0; run < 2; ++run) {
        EditController surface(model, drafts, [&now] { return now; }, QStringLiteral("w-wire"));
        QCOMPARE(surface.open(QStringLiteral("AKR1")), EditState::Editing);
        QVERIFY(surface.commitEdit(edited, editor::EditKind::Typing));
        QVERIFY(surface.save());
        surface.close();
    }

    const QList<StubRequest> &requests = stub.requests();
    QCOMPARE(requests.size(), 8);
    QStringList values;
    for (int run = 0; run < 2; ++run) {
        const StubRequest &get = requests.at(run * 4);
        const StubRequest &lock = requests.at(run * 4 + 1);
        const StubRequest &put = requests.at(run * 4 + 2);
        const StubRequest &unlock = requests.at(run * 4 + 3);
        QCOMPARE(get.method, QByteArray("GET"));
        QCOMPARE(get.target, QByteArray("/api/articles/AKR1"));
        QVERIFY2(!get.hasHeader("x-edit-client"), "the article GET carried x-edit-client");
        QCOMPARE(lock.target, QByteArray("/api/articles/AKR1/lock"));
        QCOMPARE(jsonOf(lock.body), (QJsonObject{{QStringLiteral("action"), QStringLiteral("revise")}}));
        QCOMPARE(put.method, QByteArray("PUT"));
        const QJsonObject dto = jsonOf(put.body);
        QCOMPARE(dto.value(QStringLiteral("markupVersion")).toString(), edited);
        QCOMPARE(dto.value(QStringLiteral("articleId")).toString(), QStringLiteral("AKR1"));
        QCOMPARE(dto.value(QStringLiteral("title")).toString(), QStringLiteral("Wire title!"));
        QVERIFY(!dto.contains(QStringLiteral("body")) && !dto.contains(QStringLiteral("role")));
        QCOMPARE(unlock.target, QByteArray("/api/articles/AKR1/unlock"));
        QVERIFY(unlock.body.isEmpty());
        for (const StubRequest *carrier : {&lock, &put, &unlock}) {
            QCOMPARE(carrier->headerCount("x-edit-client"), 1);
            QCOMPARE(carrier->header("x-edit-client"), lock.header("x-edit-client"));
        }
        const QString value = QString::fromUtf8(lock.header("x-edit-client"));
        QVERIFY2(clientIdFormat().match(value).hasMatch(), qPrintable(value));
        values << value;
    }
    int carrying = 0;
    for (const StubRequest &request : requests)
        carrying += request.hasHeader("x-edit-client") ? 1 : 0;
    QCOMPARE(carrying, 6);  // 3 per surface
    QVERIFY2(values.at(0) != values.at(1), "two surfaces sent the same x-edit-client");
}

// A lock conflict is a 401 too - but 'locked', the transport's EditLockConflict: the surface is read only with
// '편집중입니다.' and the session (the cookie jar) is untouched; nothing is unlocked.
void EditControllerTest::aLockConflictOnTheWireKeepsTheSession()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    const QByteArray article = QJsonDocument(QJsonObject{
        {QStringLiteral("ok"), true},
        {QStringLiteral("article"), QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")},
                                                {QStringLiteral("markupVersion"), markup({QStringLiteral("x")})}}},
        {QStringLiteral("contents"), QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")}}}}).toJson(QJsonDocument::Compact);
    stub.handle([article](const StubRequest &request) {
        if (request.method == "GET") {
            StubReply reply = StubReply::json(200, article);
            reply.headers << qMakePair(QByteArray("Set-Cookie"), sessionCookieLine("wire-session"));
            return reply;
        }
        if (request.target.endsWith("/lock"))
            return StubReply::json(401, R"({"ok":false,"reason":"locked"})");
        return StubReply::json(200, R"({"ok":true})");
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel model(&transport);
    MemoryDraftStore drafts;
    EditController surface(model, drafts, [] { return qint64(1); }, QStringLiteral("w-wire"));
    QCOMPARE(surface.open(QStringLiteral("AKR1")), EditState::LockRefused);
    QCOMPARE(surface.notice(), ui::lockFailMessage(QStringLiteral("locked")));
    surface.close();
    QCOMPARE(stub.requests().size(), 2);  // GET + lock - no unlock

    model.getArticle(QStringLiteral("AKR1"));
    QVERIFY2(stub.requests().last().header("cookie").contains("sid=wire-session"),
             "the edit-lock 401 discarded the session");
}

// A 401 unauthenticated on the PUT ends the surface: no further request - not the unlock either.
void EditControllerTest::anUnauthenticatedSaveOnTheWireEndsTheSurface()
{
    StubHttpServer stub;
    QVERIFY(stub.listen());
    const QByteArray article = QJsonDocument(QJsonObject{
        {QStringLiteral("ok"), true},
        {QStringLiteral("article"), QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")},
                                                {QStringLiteral("markupVersion"), markup({QStringLiteral("x")})}}},
        {QStringLiteral("contents"), QJsonObject{{QStringLiteral("articleId"), QStringLiteral("AKR1")}}}}).toJson(QJsonDocument::Compact);
    stub.handle([article](const StubRequest &request) {
        if (request.method == "GET")
            return StubReply::json(200, article);
        if (request.method == "PUT")
            return StubReply::json(401, R"({"ok":false,"reason":"unauthenticated"})");
        return StubReply::json(200, R"({"ok":true})");
    });
    net::HttpTransport transport(stub.origin(), nullptr);
    net::HttpNewsModel model(&transport);
    MemoryDraftStore drafts;
    EditController surface(model, drafts, [] { return qint64(1); }, QStringLiteral("w-wire"));
    QCOMPARE(surface.open(QStringLiteral("AKR1")), EditState::Editing);
    QVERIFY(surface.commitEdit(typed({QStringLiteral("y")}), editor::EditKind::Typing));
    QVERIFY(!surface.save());
    QCOMPARE(surface.state(), EditState::SessionEnded);
    surface.close();
    QCOMPARE(stub.requests().size(), 3);  // GET, lock, PUT
}
