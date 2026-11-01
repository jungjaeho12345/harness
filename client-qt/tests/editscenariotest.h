#ifndef CLIENT_QT_TESTS_EDITSCENARIOTEST_H
#define CLIENT_QT_TESTS_EDITSCENARIOTEST_H

// The edit scenario of the automation hook (phase 78 step9 - ui/editscenario.h): `--scenario edit` reaching the shell's
// unchanged guard as `list`, the article variable, the scenario's one gated edit, and the round trip itself driven
// through the list controller and the writer host on FakeNewsModel - plus the ways it stops (with fixed sentences
// that carry no article data).

#include <QObject>

class EditScenarioTest : public QObject
{
    Q_OBJECT

private slots:
    void initTestCase();
    void cleanupTestCase();
    void rewritesOnlyTheTwoArgumentEditSpelling_data();
    void rewritesOnlyTheTwoArgumentEditSpelling();
    void theShellGuardStillDecides();
    void namesTheArticleVariableAndRefusesWithoutIt();
    void runsAutosaveOnEverySecondInTheScenarioOnly();
    void theEditGoesThroughTheGates();
    void runsTheRoundTripThroughTheControllers();
    void waitsForTheListToBeLive();
    void stopsWhenTheArticleIsNotInTheList();
    void stopsWhenTheArticleDoesNotOpenForEditing();
    void stopsWhenAutosaveIsOff();

private:
    bool m_savedQuitOnLastWindowClosed = true;
};

#endif // CLIENT_QT_TESTS_EDITSCENARIOTEST_H
