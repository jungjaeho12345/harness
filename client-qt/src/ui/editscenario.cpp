#include "ui/editscenario.h"

#include "editor/editorcaret.h"
#include "editor/editornewline.h"
#include "editor/writerbody.h"
#include "ui/listcontroller.h"
#include "ui/writerhost.h"

#include <QJsonObject>
#include <QLatin1String>

#include <utility>

namespace ui {
namespace {

const QLatin1String kScenarioFlag("--scenario");
const QLatin1String kEditName("edit");
const QLatin1String kListName("list");

} // namespace

EditScenarioArgs editScenarioArgs(const QStringList &arguments)
{
    // Only the two-argument spelling the shell accepts: "--scenario" then "edit". The shell's guard then sees "list"
    // and applies every rule of its own - CLIENT_SELFTEST first, then the spelling, the duplicates, the credentials.
    EditScenarioArgs args;
    args.shellArguments = arguments;
    for (qsizetype i = 0; i + 1 < args.shellArguments.size(); ++i) {
        if (args.shellArguments.at(i) == kScenarioFlag && args.shellArguments.at(i + 1) == kEditName) {
            args.shellArguments[i + 1] = kListName;
            args.requested = true;
        }
    }
    return args;
}

QString editScenarioArticleEnvVar()
{
    return QStringLiteral("CLIENT_SCENARIO_ARTICLE");
}

QString editScenarioArticleRefusal()
{
    return QStringLiteral("--scenario edit is refused: CLIENT_SCENARIO_ARTICLE must name the article to edit");
}

AutosaveConfig editScenarioAutosave()
{
    return AutosaveConfig{true, 1, 1};
}

QString editScenarioText()
{
    return QStringLiteral(" [qt-edit]");
}

std::optional<QVector<editor::Block>> editScenarioEdit(const QVector<editor::Block> &blocks)
{
    bool hasTextLine = false;
    for (const editor::Block &block : blocks)
        hasTextLine = hasTextLine || editor::isTextBlock(block);
    if (!hasTextLine)
        return std::nullopt;
    // The caret at the end of the first text line - and the gates typing goes through there.
    const QString text = editor::blocksToText(blocks);
    const int offset = static_cast<int>(editor::lines(text).first().size());
    if (editor::isInputBlocked(text, offset))
        return std::nullopt;
    return editor::insertTextIntoBlocks(blocks, editor::TextPoint{0, offset}, editScenarioText()).blocks;
}

EditScenario::EditScenario(ListController &list, WriterHost &host, const QString &articleId, Failure onFailure,
                           QObject *parent)
    : QObject(parent), m_list(list), m_host(host), m_articleId(articleId), m_onFailure(std::move(onFailure))
{
}

void EditScenario::start()
{
    if (m_started || m_done || m_failed)
        return;
    if (!m_list.isEntered()) {
        fail(QStringLiteral("the list was not entered (the login did not reach it)"));
        return;
    }
    if (m_list.live()) {
        run();
        return;
    }
    // The stream's ready: from here no request of the list is in flight, and nothing changes before the edit starts.
    connect(&m_list, &ListController::liveChanged, this, &EditScenario::onLive);
}

bool EditScenario::done() const
{
    return m_done;
}

bool EditScenario::failed() const
{
    return m_failed;
}

void EditScenario::onLive(bool live)
{
    if (live && !m_started && !m_done && !m_failed)
        run();
}

void EditScenario::run()
{
    m_started = true;
    disconnect(&m_list, &ListController::liveChanged, this, &EditScenario::onLive);

    // What a double-click could open: a row of the list on screen.
    bool listed = false;
    for (const QJsonObject &row : m_list.items())
        listed = listed || row.value(QStringLiteral("articleId")).toString() == m_articleId;
    if (!listed) {
        fail(QStringLiteral("the article the harness made is not a row of the list"));
        return;
    }
    EditController *surface = m_host.openArticle(m_articleId);
    if (!surface) {
        fail(QStringLiteral("the writer did not open the article"));
        return;
    }
    if (surface->state() != EditState::Editing) {
        fail(QStringLiteral("the article did not open for editing (state %1)").arg(editStateName(surface->state())));
        return;
    }
    const std::optional<QVector<editor::Block>> edited = editScenarioEdit(editor::deserialize(surface->body()));
    if (!edited) {
        fail(QStringLiteral("the scenario edit is refused by the end-marker gate"));
        return;
    }
    if (!surface->applyEdit(editor::serializeBodyFromBlocks(*edited), editor::EditKind::Typing)) {
        fail(QStringLiteral("the edit was refused"));
        return;
    }
    if (!m_host.autosaveArmed()) {
        fail(QStringLiteral("autosave is not armed - the round trip waits for one snapshot"));
        return;
    }
    m_waitingForAutosave = true;
    connect(&m_host, &WriterHost::autosaved, this, &EditScenario::onAutosaved);
}

void EditScenario::onAutosaved()
{
    if (!m_waitingForAutosave)
        return;
    m_waitingForAutosave = false;
    disconnect(&m_host, &WriterHost::autosaved, this, &EditScenario::onAutosaved);
    EditController *surface = m_host.surface();
    if (!surface || !surface->save()) {
        fail(QStringLiteral("the save was not accepted"));
        return;
    }
    m_host.closeSurface(true);  // the unlock; the shell re-enters the list on its own
    m_done = true;
    emit finished();
}

void EditScenario::fail(const QString &why)
{
    if (m_failed || m_done)
        return;
    m_failed = true;
    disconnect(&m_list, nullptr, this, nullptr);
    disconnect(&m_host, nullptr, this, nullptr);
    if (m_onFailure)
        m_onFailure(why);
    emit finished();
}

} // namespace ui
