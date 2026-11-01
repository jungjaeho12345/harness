#ifndef CLIENT_QT_UI_EDITSCENARIO_H
#define CLIENT_QT_UI_EDITSCENARIO_H

// The edit scenario of the automation hook (phase 78 step9 - `node scripts/verify-qt-client.mjs --scenario edit`).
//
// shell/scenario.h knows `login` and `list`, and it stays as it is (P4's net/shell are the regression base). An edit
// is the list scenario plus ONE editing round trip, so the composition root hands the shell's guard `--scenario edit`
// as `--scenario list` (editScenarioArgs) - every refusal rule of the guard applies unchanged, CLIENT_SELFTEST first -
// and runs the round trip once the login call has returned:
//   wait until the list is live (its stream's ready: nothing is in flight when the edit starts) -> the article the
//   harness made (CLIENT_SCENARIO_ARTICLE) must be a row of that list -> open it through the writer host (the
//   editor page first, then getArticle -> lockArticle) -> it must be editable -> ONE typing edit through the step3
//   gates (editScenarioEdit) committed like the widget's typing -> wait for one real autosave snapshot (the scenario
//   runs autosave on, 1 s) -> save (PUT) -> close (unlock; the shell re-enters the list on its own).
// Controllers and the writer host only - no widget is touched, as the login hook touches none.
//
// An accident guard, not a security boundary (shell/scenario.h): what keeps this path from running by mistake is the
// shell's CLIENT_SELFTEST guard. The failure sentences are fixed ASCII and never carry an article id, a title or text.

#include "editor/editorcontent.h"
#include "ui/editcontroller.h"

#include <QObject>
#include <QString>
#include <QStringList>
#include <QVector>

#include <functional>
#include <optional>

namespace ui {

class ListController;
class WriterHost;

struct EditScenarioArgs {
    QStringList shellArguments;  // what shell::scenarioRequestFromEnvironment() is handed
    bool requested = false;      // the two-argument spelling `--scenario edit` was there
};

// `--scenario edit` -> `--scenario list` for the shell's guard; every other argument (and every other spelling - the
// shell refuses those) passes through untouched.
EditScenarioArgs editScenarioArgs(const QStringList &arguments);

// The article the harness made for the round trip (an id - the harness owns the environment, as for the credentials).
QString editScenarioArticleEnvVar();  // CLIENT_SCENARIO_ARTICLE
// The refusal when it is missing (fixed ASCII, exit code shell::kScenarioRefusedExitCode).
QString editScenarioArticleRefusal();

// The autosave preferences of the scenario: on, every second (the production default stays the web's: off).
AutosaveConfig editScenarioAutosave();

// The text the scenario types - a fixed ASCII string the harness knows too (scripts/verify-qt-client.mjs).
QString editScenarioText();
// The scenario's one edit: editScenarioText() at the end of the first text line, through the gates the widget's
// typing uses (isInputBlocked at the caret, then insertTextIntoBlocks). nullopt: no text line, or the gate refuses
// there (the first line reaches the last "(끝)").
std::optional<QVector<editor::Block>> editScenarioEdit(const QVector<editor::Block> &blocks);

class EditScenario : public QObject
{
    Q_OBJECT

public:
    using Failure = std::function<void(const QString &why)>;

    // list, host: not owned, outlive the scenario. onFailure: called once, with a fixed ASCII sentence.
    EditScenario(ListController &list, WriterHost &host, const QString &articleId, Failure onFailure,
                 QObject *parent = nullptr);

    void start();
    bool done() const;    // the round trip completed: saved, surface closed
    bool failed() const;

signals:
    void finished();      // done or failed

private:
    void onLive(bool live);
    void run();
    void onAutosaved();
    void fail(const QString &why);

    ListController &m_list;
    WriterHost &m_host;
    const QString m_articleId;
    Failure m_onFailure;
    bool m_started = false;
    bool m_waitingForAutosave = false;
    bool m_done = false;
    bool m_failed = false;
};

} // namespace ui

#endif // CLIENT_QT_UI_EDITSCENARIO_H
