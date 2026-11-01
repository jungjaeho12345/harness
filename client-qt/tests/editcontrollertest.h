#ifndef CLIENT_QT_TESTS_EDITCONTROLLERTEST_H
#define CLIENT_QT_TESTS_EDITCONTROLLERTEST_H

// The edit state machine of one surface (phase 78 step9 - ui::EditController): useWriteController.js's edit-tab cases
// (open / lock / save / close, the fail-closed lock table, the per-tab clientId) and WriterPage.jsx's body state
// (commitBody coalescing, undo / redo, File > Recover, the autosave snapshot) on FakeNewsModel, plus the wire: the
// same controller over the real HttpNewsModel and transport against a loopback stub - x-edit-client on exactly the
// three edit routes.

#include <QObject>

class EditControllerTest : public QObject
{
    Q_OBJECT

private slots:
    void lockFailMessageMatchesTheWeb_data();
    void lockFailMessageMatchesTheWeb();
    void entersAnEditWithTheReviseLock();
    void fieldsFromArticleMapsTheEditableFields();
    void toSaveDtoSendsTheBodyAsMarkupVersion();
    void draftDataKeepsTheDraftFieldsInOrder();
    void opensWithGetThenLockAndHoldsTheLock();
    void opensOnlyOnceAndOnlyAnArticle();
    void keepsTheLoadedBodyAsTheBaseline();
    void everyCallOfASurfaceCarriesItsOwnClientId();
    void twoSurfacesNeverShareAClientId();
    void aSecondSurfaceOnTheSameArticleIsRefusedTheLock();
    void lockRefusalsAreFailClosed_data();
    void lockRefusalsAreFailClosed();
    void aBodyThatCannotBeLoadedIsNeverLocked_data();
    void aBodyThatCannotBeLoadedIsNeverLocked();
    void readOnlySurfacesNeverWrite();
    void savePutsTheEditedBodyWithTheSurfaceId();
    void aFailedSaveKeepsEditing_data();
    void aFailedSaveKeepsEditing();
    void aSessionThatEndsOnSaveStopsTheSurface();
    void noIdentityIsAskedOrKept();
    void closeUnlocksOnceWithTheSurfaceId();
    void commitRederivesTheTitle();
    void typingCoalescesWithinTheWindow();
    void anEditOperationIsAlwaysItsOwnStep();
    void aNoOpCommitStillMovesTheMark();
    void historyIsCappedAtOneHundred();
    void undoAndRedoRestoreWithoutACapture();
    void applyEditAnnouncesTheNewBody();
    void recoverIsOneUndoStepAndClearsTheDraft();
    void recoverWithoutADraftSaysSo();
    void autosaveStoresTheFieldsUnderTheArticleKey();
    void autosaveSkipsAnEmptySurface();
    void dependsOnNoWidgetNoTimerAndNoTransport();
    void carriesXEditClientOnExactlyTheThreeEditRoutesOnTheWire();
    void aLockConflictOnTheWireKeepsTheSession();
    void anUnauthenticatedSaveOnTheWireEndsTheSurface();
};

#endif // CLIENT_QT_TESTS_EDITCONTROLLERTEST_H
