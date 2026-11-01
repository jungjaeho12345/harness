#ifndef CLIENT_QT_TESTS_EDITORDRAFTTEST_H
#define CLIENT_QT_TESTS_EDITORDRAFTTEST_H

#include <QObject>

// editor/editordraft.* (phase 78 step7) - the draft (autosave) store, run against an in-memory IDraftStore so that
// every case is deterministic: no file, no clock, no timer.
//
// The first nineteen functions are web/src/view/editorDraft.test.js, one per `it`, in the same order. Where the web
// swaps globalThis.localStorage / sessionStorage for a throwing getter, the port hands the functions a store that
// throws (the storage seam is an argument here); where the web reads its window scope from sessionStorage, the port
// passes the scope in. The rest are the port's own locks:
//   - the injected time reaches the store untouched, and expiry uses nothing else
//   - expiry, recovery, opaque keys and opaque bodies as tables
//   - every store failure is swallowed, one operation at a time
//   - the whitelist: secrets never reach the store, a planted key never reaches the caller, and DRAFT_FIELDS is the
//     web's EDITABLE_FIELDS (read from web/src/controller/useWriteController.js at run time)
//   - a source scan: the module reads no clock, runs no timer, touches no file
//
// Every expected value of a data table was produced by running the canonical web module under node 24
// (2026-11-01, s7-rows.mjs) - tables spliced in as generated, never typed by hand.
class EditorDraftTest : public QObject
{
    Q_OBJECT

private slots:
    // editorDraft — 초안 자동저장 저장소
    void loadsWhatWasSaved();
    void keepsSeveralKeysApart();
    void overwritesAKeyWithTheLatestData();
    void clearsOneKeyAndKeepsTheOthers();
    void expiresOnlyDraftsPastTheRetention();
    void keepsADraftExactlyAtTheRetentionLimit();
    void survivesAStoreThatThrows();

    // editorDraft — 초안 키 스코프(draftScopeId/draftKeyFor)
    void keysAnExistingArticleByItsId();
    void keysANewTabByScopeAndTab();
    void keepsTheKeyStableWithinOneScope();
    void anotherScopeGetsAnotherKey();
    void derivesTheKeyWithoutAnyStore();
    void storesUnderTheDerivedKeyUnchanged();

    // editorDraft — 복구 읽기 폴백(loadDraftForRecover)
    void recoversFromTheNewKeyFirst();
    void fallsBackToTheLegacyTabKey();
    void neverFallsBackForAnExistingArticle();
    void recoversNothingWhenNoKeyHoldsADraft();
    void theFoundKeyClearsTheRecoveredDraft();
    void recoveryIsReadOnly();

    // Port locks
    void passesTheInjectedTimeThrough_data();
    void passesTheInjectedTimeThrough();
    void expiresByTheInjectedClock_data();
    void expiresByTheInjectedClock();
    void recoversLikeTheWeb_data();
    void recoversLikeTheWeb();
    void swallowsEveryStoreFailure_data();
    void swallowsEveryStoreFailure();
    void keepsOnlyTheDraftFields();
    void draftFieldsAreTheWebsEditableFields();
    void treatsTheKeyAsOpaque_data();
    void treatsTheKeyAsOpaque();
    void neverNormalizesTheBody_data();
    void neverNormalizesTheBody();
    void readsNoClockAndTouchesNoFile();
};

#endif // CLIENT_QT_TESTS_EDITORDRAFTTEST_H
