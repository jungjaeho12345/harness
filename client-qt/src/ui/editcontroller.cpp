#include "ui/editcontroller.h"

#include "editor/editorcontent.h"
#include "editor/writerbody.h"
#include "ui/logincontroller.h"

#include <QHash>
#include <QJsonValue>
#include <QLatin1Char>

#include <optional>
#include <utility>

namespace ui {
namespace {

const QString kBody = QStringLiteral("body");
const QString kTitle = QStringLiteral("title");

// lockMessages.js LOCK_FAIL_DEFAULT.
QString lockFailDefault()
{
    return QStringLiteral("편집 잠금을 얻지 못해 편집할 수 없습니다.");
}

// WriterPage.jsx's own sentences for File > Save and File > Recover.
QString savedMessage()
{
    return QStringLiteral("저장되었습니다.");
}

QString saveFailedMessage()
{
    return QStringLiteral("저장에 실패했습니다.");
}

QString noDraftMessage()
{
    return QStringLiteral("복구할 자동저장 내용이 없습니다.");
}

// The web asks "자동저장된 내용으로 복구하시겠습니까?" first. P5 has no dialog window (ScreenInventoryTest
// sourcesOpenNoDialogWindow), so the recovery happens at once - as ONE undo step - and the sentence says how to undo it.
QString recoveredMessage()
{
    return QStringLiteral("자동저장된 내용으로 복구했습니다. 되돌리기(Ctrl+Z)로 복구 전 본문으로 돌아갈 수 있습니다.");
}

// An article that could not be loaded: the list's sentence shape (listcontroller.cpp queryFailureMessage) - the three
// "no usable answer" kinds say why, anything else gives its HTTP status.
QString loadFailureMessage(const net::ModelResult &result)
{
    const LoginFailure failure = loginFailureFor(result.outcome);
    if (failure == LoginFailure::Unreachable || failure == LoginFailure::TimedOut
        || failure == LoginFailure::InvalidResponse)
        return QStringLiteral("기사를 불러오지 못했습니다. ") + loginFailureMessage(failure);
    return result.status >= 0 ? QStringLiteral("기사를 불러오지 못했습니다(HTTP %1).").arg(result.status)
                              : QStringLiteral("기사를 불러오지 못했습니다.");
}

// JS `a ?? b`: null and absent fall through, every other value (an empty string included) stops.
bool nullish(const QJsonValue &value)
{
    return value.isNull() || value.isUndefined();
}

// JS truthiness of a field value - WriterPage's !!(tab.fields.body || tab.fields.title).
bool truthy(const QJsonValue &value)
{
    switch (value.type()) {
    case QJsonValue::Bool: return value.toBool();
    case QJsonValue::Double: return value.toDouble() != 0 && value.toDouble() == value.toDouble();
    case QJsonValue::String: return !value.toString().isEmpty();
    case QJsonValue::Array:
    case QJsonValue::Object: return true;
    case QJsonValue::Null:
    case QJsonValue::Undefined: return false;
    }
    return false;
}

// useWriteController.js nextTabId - "tab-N" from a process counter. Only the draft key of a surface without an article
// reads it (editor::draftKeyFor); P5 opens none, so it never reaches a key here.
QString nextTabId()
{
    static int sequence = 0;
    return QStringLiteral("tab-%1").arg(++sequence);
}

} // namespace

QString editLockAction()
{
    return QStringLiteral("revise");
}

QString lockFailMessage(const QString &reason)
{
    // lockMessages.js: a reason that is not a non-empty string -> the default; an own key of the table -> its
    // sentence; anything else -> the default + " (reason)" (prototype names like toString are not own keys).
    if (reason.isEmpty())
        return lockFailDefault();
    static const QHash<QString, QString> messages{
        {QStringLiteral("locked"), QStringLiteral("편집중입니다.")},
        {QStringLiteral("network-error"),
         QStringLiteral("서버에 연결하지 못해 편집 잠금을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.")},
        {QStringLiteral("invalid-response"),
         QStringLiteral("서버에 연결하지 못해 편집 잠금을 얻지 못했습니다. 잠시 후 다시 시도해 주세요.")},
        {QStringLiteral("unauthenticated"), QStringLiteral("세션이 만료되었습니다. 다시 로그인한 뒤 편집해 주세요.")},
        {QStringLiteral("forbidden"), QStringLiteral("이 기사를 편집할 권한이 없습니다.")},
        {QStringLiteral("not-found"), QStringLiteral("기사를 찾을 수 없습니다.")}};
    const auto it = messages.constFind(reason);
    if (it != messages.constEnd())
        return *it;
    return lockFailDefault() + QStringLiteral(" (") + reason + QLatin1Char(')');
}

QJsonObject fieldsFromArticle(const QJsonObject &article)
{
    QJsonObject fields;
    for (const QString &key : editor::DRAFT_FIELDS) {
        const QJsonValue value = article.value(key);
        fields.insert(key, nullish(value) ? QJsonValue(QString()) : value);
    }
    // body = markupVersion ?? body ?? content ?? '' (the server keeps the text in markupVersion).
    QJsonValue body = article.value(QStringLiteral("markupVersion"));
    if (nullish(body))
        body = article.value(kBody);
    if (nullish(body))
        body = article.value(QStringLiteral("content"));
    fields.insert(kBody, nullish(body) ? QJsonValue(QString()) : body);
    return fields;
}

QJsonObject toSaveDto(const QJsonObject &fields, const QString &articleId)
{
    QJsonObject dto = fields;
    const QJsonValue body = dto.take(kBody);
    if (!body.isUndefined())
        dto.insert(QStringLiteral("markupVersion"), body);
    if (!articleId.isEmpty())
        dto.insert(QStringLiteral("articleId"), articleId);
    return dto;
}

editor::JsonValue draftDataFrom(const QJsonObject &fields)
{
    editor::JsonValue data = editor::JsonValue::makeObject();
    for (const QString &key : editor::DRAFT_FIELDS) {
        const QJsonValue value = fields.value(key);
        if (value.isString())
            data.insert(key, editor::JsonValue::makeString(value.toString()));
    }
    return data;
}

QString editStateName(EditState state)
{
    switch (state) {
    case EditState::Opening: return QStringLiteral("Opening");
    case EditState::Editing: return QStringLiteral("Editing");
    case EditState::LockRefused: return QStringLiteral("LockRefused");
    case EditState::LoadFailed: return QStringLiteral("LoadFailed");
    case EditState::SessionEnded: return QStringLiteral("SessionEnded");
    case EditState::Closed: return QStringLiteral("Closed");
    }
    return QStringLiteral("Closed");
}

EditController::EditController(net::INewsModel &model, editor::IDraftStore &drafts, Clock clock,
                               const QString &draftScope, QObject *parent)
    : QObject(parent), m_model(model), m_drafts(drafts), m_clock(std::move(clock)), m_draftScope(draftScope),
      m_tabId(nextTabId()), m_fields(fieldsFromArticle(QJsonObject()))
{
}

EditController::~EditController() = default;

EditState EditController::open(const QString &articleId)
{
    if (m_state != EditState::Opening || articleId.isEmpty())
        return m_state;
    m_articleId = articleId;

    // The full article first - a list row carries no body (useWriteController.js:268-274).
    const net::ModelResult got = m_model.getArticle(articleId);
    if (got.outcome == net::Outcome::Unauthenticated)
        return enter(EditState::SessionEnded, sessionEndedMessage());
    if (got.outcome != net::Outcome::Ok || !got.ok() || !got.body.value(QStringLiteral("article")).isObject())
        return enter(EditState::LoadFailed, loadFailureMessage(got));  // fail closed: nothing to lock, nothing to save
    // { ...r.article, ...r.contents } - the contents win.
    QJsonObject merged = got.body.value(QStringLiteral("article")).toObject();
    const QJsonObject contents = got.body.value(QStringLiteral("contents")).toObject();
    for (auto it = contents.begin(); it != contents.end(); ++it)
        merged.insert(it.key(), it.value());
    m_fields = fieldsFromArticle(merged);
    m_history = editor::createHistory(body());  // the baseline: the body exactly as loaded

    // The lock, with THIS surface's id. Success is ok === true and nothing less (useWriteController.js:287).
    const net::ModelResult lock = m_model.lockArticle(articleId, editLockAction(), m_clientId.value());
    if (lock.outcome == net::Outcome::Ok && lock.ok())
        return enter(EditState::Editing, QString());
    if (lock.outcome == net::Outcome::Unauthenticated)
        return enter(EditState::SessionEnded, lockFailMessage(lock.reason()));
    return enter(EditState::LockRefused, lockFailMessage(lock.reason()));
}

EditState EditController::state() const
{
    return m_state;
}

bool EditController::editable() const
{
    return m_state == EditState::Editing;
}

QString EditController::articleId() const
{
    return m_articleId;
}

QString EditController::body() const
{
    return m_fields.value(kBody).toString();
}

QString EditController::title() const
{
    return m_fields.value(kTitle).toString();
}

QJsonObject EditController::fields() const
{
    return m_fields;
}

QString EditController::notice() const
{
    return m_notice;
}

const editor::History &EditController::history() const
{
    return m_history;
}

bool EditController::commitEdit(const QString &body, editor::EditKind kind)
{
    if (m_state != EditState::Editing)
        return false;
    commitBody(body, kind == editor::EditKind::Typing);
    return true;
}

bool EditController::applyEdit(const QString &body, editor::EditKind kind)
{
    if (!commitEdit(body, kind))
        return false;
    emit bodyReplaced();
    return true;
}

bool EditController::undo()
{
    if (m_state != EditState::Editing)
        return false;
    const editor::HistoryMove move = editor::undo(m_history);
    if (!move.changed || !move.body)
        return false;  // at the baseline
    m_history = move.history;
    writeBody(*move.body);  // applied, not captured (WriterPage's applyingHistoryRef)
    emit bodyReplaced();
    return true;
}

bool EditController::redo()
{
    if (m_state != EditState::Editing)
        return false;
    const editor::HistoryMove move = editor::redo(m_history);
    if (!move.changed || !move.body)
        return false;  // at the top
    m_history = move.history;
    writeBody(*move.body);
    emit bodyReplaced();
    return true;
}

bool EditController::save()
{
    if (m_state != EditState::Editing)
        return false;  // rule 2: no lock, no PUT - and nothing is asked
    // articleId in the dto -> PUT articles-update with x-edit-client (net/httpnewsmodel.cpp); never an action here.
    const net::ModelResult result = m_model.saveArticle(toSaveDto(m_fields, m_articleId), m_clientId.value(), QString());
    if (endedBy(result))
        return false;
    const bool ok = result.outcome == net::Outcome::Ok && result.ok();
    setNotice(ok ? savedMessage() : saveFailedMessage());
    return ok;
}

bool EditController::recover()
{
    if (m_state != EditState::Editing)
        return false;
    const std::optional<editor::RecoveredDraft> found =
        editor::loadDraftForRecover(m_drafts, m_draftScope, m_articleId, m_tabId);
    if (!found) {
        setNotice(noDraftMessage());
        return false;
    }
    // WriterPage: body through commitBody (one undo step, no coalescing), the title re-derived from it (the stored
    // title is not written), the other editable fields as stored.
    for (const editor::JsonMember &member : found->data.members) {
        if (member.value.kind != editor::JsonValue::Kind::String)
            continue;
        if (member.key == kBody)
            commitBody(member.value.stringValue, false);
        else if (member.key != kTitle && editor::DRAFT_FIELDS.contains(member.key))
            m_fields.insert(member.key, member.value.stringValue);
    }
    editor::clearDraft(m_drafts, found->key);  // the key it was FOUND at - no second recovery of the same draft
    setNotice(recoveredMessage());
    emit bodyReplaced();
    return true;
}

bool EditController::autosave(int retentionDays)
{
    if (m_state != EditState::Editing)
        return false;
    if (!truthy(m_fields.value(kBody)) && !truthy(m_fields.value(kTitle)))
        return false;  // "빈 탭은 스냅샷 안 함"
    const qint64 now = m_clock ? m_clock() : 0;
    const QString key = editor::draftKeyFor(m_draftScope, m_articleId, m_tabId);
    editor::saveDraft(m_drafts, key, draftDataFrom(m_fields), now);
    editor::expireDrafts(m_drafts, retentionDays, now);  // the same now (the web reads its clock twice)
    return true;
}

void EditController::close()
{
    if (m_state == EditState::Closed)
        return;
    const bool held = m_state == EditState::Editing;
    m_state = EditState::Closed;  // first: nothing re-enters an editing surface while the unlock waits
    if (held)
        m_model.unlockArticle(m_articleId, m_clientId.value());  // the web's fire-and-forget - the answer changes nothing
    setNotice(QString());
    emit stateChanged();
}

EditState EditController::enter(EditState state, const QString &notice)
{
    m_state = state;
    setNotice(notice);
    emit stateChanged();
    return m_state;
}

void EditController::setNotice(const QString &notice)
{
    if (notice == m_notice)
        return;
    m_notice = notice;
    emit noticeChanged();
}

void EditController::commitBody(const QString &body, bool typing)
{
    // WriterPage.commitBody: the body, the title from it, then the capture.
    writeBody(body);
    const qint64 now = m_clock ? m_clock() : 0;
    const bool coalesce = typing && m_last.wasTyping && (now - m_last.at) < kCoalesceMs;
    m_history = editor::pushHistory(m_history, body, coalesce, kHistoryLimit);
    m_last = LastCommit{now, typing};  // moved on every commit, a no-op push included
}

void EditController::writeBody(const QString &body)
{
    m_fields.insert(kBody, body);
    m_fields.insert(kTitle, editor::bodyTitle(body));
}

bool EditController::endedBy(const net::ModelResult &result)
{
    if (result.outcome != net::Outcome::Unauthenticated)
        return false;
    enter(EditState::SessionEnded, sessionEndedMessage());  // obeyed, never papered over: read only from here
    return true;
}

} // namespace ui
