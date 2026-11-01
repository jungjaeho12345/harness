#include "editordrafttest.h"

#include "editor/editorcontent.h"
#include "editor/editordraft.h"
#include "repofiles.h"

#include <QByteArray>
#include <QChar>
#include <QHash>
#include <QLatin1Char>
#include <QList>
#include <QRegularExpression>
#include <QRegularExpressionMatch>
#include <QRegularExpressionMatchIterator>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QtTest>

#include <initializer_list>
#include <limits>
#include <optional>
#include <stdexcept>
#include <utility>

using editor::DraftEntry;
using editor::JsonValue;
using editor::RecoveredDraft;

namespace {

constexpr qint64 DAY = 86400000;

// The window scope this test's caller holds (the web's draftScopeId() - here simply a value the caller passes).
const QString kScope = QStringLiteral("w-test-scope");
// The scope s7-rows.mjs fixed in the web's sessionStorage before generating the recovery table.
const QString kWebScope = QStringLiteral("w-fixed");

// A string built code unit by code unit - for rows holding a lone surrogate or a NUL, which no C++ literal spells.
QString units(std::initializer_list<char16_t> codeUnits)
{
    QString s;
    for (const char16_t unit : codeUnits)
        s.append(QChar(unit));
    return s;
}

JsonValue str(const QString &value)
{
    return JsonValue::makeString(value);
}

// {"name": "value", ...} - a fields object, in the given order.
JsonValue fields(std::initializer_list<std::pair<QString, QString>> members)
{
    JsonValue object = JsonValue::makeObject();
    for (const auto &member : members)
        object.insert(member.first, str(member.second));
    return object;
}

// The web's JSON.stringify(loadDraft(key)) - "null" for no draft.
QString shown(const std::optional<JsonValue> &data)
{
    return data ? editor::stringifyJson(*data) : QStringLiteral("null");
}

// A recovery result as "<key> => <data>", "null" for none.
QString shown(const std::optional<RecoveredDraft> &found)
{
    return found ? found->key + QStringLiteral(" => ") + editor::stringifyJson(found->data) : QStringLiteral("null");
}

// Whether calling fn lets an exception out - the web's expect(() => ...).not.toThrow(), inverted. Catching here keeps
// a broken implementation a red row instead of an exception that takes the whole runner down.
template <typename Fn>
bool escapes(Fn &&fn)
{
    try {
        fn();
        return false;
    } catch (...) {
        return true;
    }
}

// The in-memory IDraftStore: items in insertion order (a JS object's for these keys); a save on a present key
// replaces it in place. Every call is logged. arm() makes operations throw std::runtime_error - the web's
// localStorage getter that throws. A comma-separated list of rules, counted from arm():
//   "load"    every load throws
//   "load@2"  from the second load on
//   "load#1"  only the first load
class MemoryStore : public editor::IDraftStore
{
public:
    struct Item {
        QString key;
        JsonValue data;
        qint64 savedAtMs = 0;
    };

    QList<Item> items;
    QStringList calls; // "save <key>", "load <key>", "remove <key>", "keys" - in order

    void arm(const QString &spec)
    {
        m_counts.clear();
        m_rules.clear();
        for (const QString &part : spec.split(QLatin1Char(','), Qt::SkipEmptyParts)) {
            const qsizetype at = part.indexOf(QLatin1Char('@'));
            const qsizetype hash = part.indexOf(QLatin1Char('#'));
            if (at > 0)
                m_rules.insert(part.left(at), Rule{part.mid(at + 1).toInt(), 0});
            else if (hash > 0)
                m_rules.insert(part.left(hash), Rule{0, part.mid(hash + 1).toInt()});
            else
                m_rules.insert(part, Rule{1, 0});
        }
    }

    void save(const QString &key, const JsonValue &data, qint64 savedAtMs) override
    {
        enter(QStringLiteral("save"), key);
        for (Item &item : items) {
            if (item.key == key) {
                item.data = data;
                item.savedAtMs = savedAtMs;
                return;
            }
        }
        items.append(Item{key, data, savedAtMs});
    }

    std::optional<DraftEntry> load(const QString &key) override
    {
        enter(QStringLiteral("load"), key);
        for (const Item &item : items) {
            if (item.key == key)
                return DraftEntry{item.data, double(item.savedAtMs)};
        }
        return std::nullopt;
    }

    void remove(const QString &key) override
    {
        enter(QStringLiteral("remove"), key);
        for (qsizetype i = 0; i < items.size(); ++i) {
            if (items.at(i).key == key) {
                items.removeAt(i);
                return;
            }
        }
    }

    QStringList keys() override
    {
        enter(QStringLiteral("keys"), QString());
        QStringList out;
        for (const Item &item : items)
            out << item.key;
        return out;
    }

    // The keys held, comma-joined - the "after" column of the failure table.
    QString keyList() const
    {
        QStringList out;
        for (const Item &item : items)
            out << item.key;
        return out.join(QLatin1Char(','));
    }

    // Everything held, one line per item: what a read-only call must leave exactly as it was.
    QString dump() const
    {
        QStringList out;
        for (const Item &item : items)
            out << item.key + QStringLiteral(" = ") + editor::stringifyJson(item.data) + QStringLiteral(" @ ")
                       + QString::number(item.savedAtMs);
        return out.join(QLatin1Char('\n'));
    }

    // How many calls could have changed the store (saves and removes), counted from the start.
    int writes() const
    {
        int n = 0;
        for (const QString &call : calls) {
            if (call.startsWith(QLatin1String("save")) || call.startsWith(QLatin1String("remove")))
                ++n;
        }
        return n;
    }

private:
    struct Rule {
        int from = 0; // throws from this call on (1-based); 0 = no such rule
        int only = 0; // throws on exactly this call; 0 = no such rule
    };

    void enter(const QString &op, const QString &key)
    {
        calls << (key.isNull() ? op : op + QLatin1Char(' ') + key);
        const int n = ++m_counts[op];
        const auto rule = m_rules.constFind(op);
        if (rule == m_rules.constEnd())
            return;
        if ((rule->from > 0 && n >= rule->from) || (rule->only > 0 && n == rule->only))
            throw std::runtime_error(op.toStdString() + " blocked");
    }

    QHash<QString, int> m_counts;
    QHash<QString, Rule> m_rules;
};

// Two drafts every failure row starts from: an article's and an old new-tab one.
void seed(MemoryStore &store)
{
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("A")}}), 1000);
    editor::saveDraft(store, QStringLiteral("tab-1"), fields({{QStringLiteral("title"), QStringLiteral("L")}}), 1000);
}

// ---- the source scan (pure) ------------------------------------------------------------------------------------

// Comments out; string literals kept - a clock call spelled inside a string is flagged too (fail-closed, as
// TimerPolicyTest does).
QString stripComments(const QString &text)
{
    QString out;
    out.reserve(text.size());
    const qsizetype n = text.size();
    qsizetype i = 0;
    while (i < n) {
        const QChar c = text.at(i);
        const QChar next = i + 1 < n ? text.at(i + 1) : QChar();
        if (c == QLatin1Char('/') && next == QLatin1Char('/')) {
            while (i < n && text.at(i) != QLatin1Char('\n'))
                ++i;
            continue;
        }
        if (c == QLatin1Char('/') && next == QLatin1Char('*')) {
            const qsizetype end = text.indexOf(QStringLiteral("*/"), i + 2);
            i = end < 0 ? n : end + 2;
            out += QLatin1Char(' ');
            continue;
        }
        out += c;
        ++i;
    }
    return out;
}

// Reading the time - Qt's, the standard library's, Win32's.
const QStringList &clockSpellings()
{
    static const QStringList spellings{
        QStringLiteral("QDateTime"),       QStringLiteral("QDate"),          QStringLiteral("QTime"),
        QStringLiteral("QElapsedTimer"),   QStringLiteral("QDeadlineTimer"), QStringLiteral("currentMSecsSinceEpoch"),
        QStringLiteral("currentSecsSinceEpoch"), QStringLiteral("currentDateTime"), QStringLiteral("chrono"),
        QStringLiteral("ctime"),           QStringLiteral("time.h"),         QStringLiteral("std::time"),
        QStringLiteral("time(nullptr)"),   QStringLiteral("time(NULL)"),     QStringLiteral("GetTickCount"),
        QStringLiteral("QueryPerformanceCounter"), QStringLiteral("GetSystemTime"), QStringLiteral("clock_gettime"),
        QStringLiteral("gettimeofday")};
    return spellings;
}

// Running a timer (TimerPolicyTest forbids the periodic ones everywhere; this module has no use even for one shot).
const QStringList &timerSpellings()
{
    static const QStringList spellings{QStringLiteral("QTimer"), QStringLiteral("startTimer"),
                                       QStringLiteral("singleShot"), QStringLiteral("QBasicTimer"),
                                       QStringLiteral("timerEvent")};
    return spellings;
}

// Making up ids - the scope is the caller's.
const QStringList &randomSpellings()
{
    static const QStringList spellings{QStringLiteral("QUuid"), QStringLiteral("QRandomGenerator"),
                                       QStringLiteral("std::rand"), QStringLiteral("random_device"),
                                       QStringLiteral("srand")};
    return spellings;
}

// Touching a medium or another layer - that is the store's job (editordraftstore.*), not the pure module's.
const QStringList &storageSpellings()
{
    static const QStringList spellings{QStringLiteral("QFile"),          QStringLiteral("QSaveFile"),
                                       QStringLiteral("QSettings"),      QStringLiteral("QDir"),
                                       QStringLiteral("QStandardPaths"), QStringLiteral("QTemporary"),
                                       QStringLiteral("fopen"),          QStringLiteral("fstream"),
                                       QStringLiteral("shell/"),         QStringLiteral("net/"),
                                       QStringLiteral("ui/"),            QStringLiteral("editordraftstore")};
    return spellings;
}

QStringList findingsIn(const QString &label, const QString &source, const QStringList &spellings)
{
    const QString code = stripComments(source);
    QStringList findings;
    for (const QString &spelling : spellings) {
        if (code.contains(spelling))
            findings << QStringLiteral("%1 spells %2").arg(label, spelling);
    }
    return findings;
}

QString sourceText(const QString &relative)
{
    QByteArray bytes;
    QString error;
    if (!readRepoFile(relative, &bytes, &error))
        return QString();
    return QString::fromUtf8(bytes);
}

} // namespace

// ---- editorDraft — 초안 자동저장 저장소 --------------------------------------------------------------------------

// it: 'saveDraft 후 loadDraft가 같은 data를 반환한다(없는 key는 null)'
void EditorDraftTest::loadsWhatWasSaved()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}), 1000);
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("a"))), QStringLiteral("{\"title\":\"t\"}"));
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("none"))), QStringLiteral("null"));
}

// it: '여러 key의 초안을 독립적으로 보존한다'
void EditorDraftTest::keepsSeveralKeysApart()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("A")}}), 1000);
    editor::saveDraft(store, QStringLiteral("b"), fields({{QStringLiteral("title"), QStringLiteral("B")}}), 2000);
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("a"))), QStringLiteral("{\"title\":\"A\"}"));
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("b"))), QStringLiteral("{\"title\":\"B\"}"));
}

// it: '같은 key를 다시 저장하면 최신 data로 덮어쓴다'
void EditorDraftTest::overwritesAKeyWithTheLatestData()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("old")}}), 1000);
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("new")}}), 2000);
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("a"))), QStringLiteral("{\"title\":\"new\"}"));
}

// it: 'clearDraft 후 그 key는 null(다른 key는 보존)'
void EditorDraftTest::clearsOneKeyAndKeepsTheOthers()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}), 1000);
    editor::saveDraft(store, QStringLiteral("b"), fields({{QStringLiteral("title"), QStringLiteral("u")}}), 1000);
    editor::clearDraft(store, QStringLiteral("a"));
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("a"))), QStringLiteral("null"));
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("b"))), QStringLiteral("{\"title\":\"u\"}"));
}

// it: 'expireDrafts는 보존 기한이 지난 초안만 제거한다'
void EditorDraftTest::expiresOnlyDraftsPastTheRetention()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("old"), fields({{QStringLiteral("title"), QStringLiteral("O")}}), 1000);
    editor::saveDraft(store, QStringLiteral("fresh"), fields({{QStringLiteral("title"), QStringLiteral("F")}}),
                      1000 + DAY); // 1일 뒤 저장
    // 기준 시각: old 저장 후 2일. 보존 1일 → old(2일 경과)는 제거, fresh(1일 경과)는 유지.
    editor::expireDrafts(store, 1, 1000 + 2 * DAY);
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("old"))), QStringLiteral("null"));
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("fresh"))), QStringLiteral("{\"title\":\"F\"}"));
}

// it: 'expireDrafts 경계: 정확히 보존 기한이면 유지한다(< nowMs - retention만 제거)'
void EditorDraftTest::keepsADraftExactlyAtTheRetentionLimit()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("edge"), fields({{QStringLiteral("title"), QStringLiteral("E")}}), 1000);
    editor::expireDrafts(store, 1, 1000 + DAY); // 경과 == 보존 → 제거 안 함
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("edge"))), QStringLiteral("{\"title\":\"E\"}"));
}

// it: 'localStorage가 막혀도(throw) save/load/clear/expire가 예외 없이 동작한다' - the web swaps localStorage for a
// getter that throws; here the store itself throws on every operation.
void EditorDraftTest::survivesAStoreThatThrows()
{
    MemoryStore store;
    store.arm(QStringLiteral("save,load,remove,keys")); // the whole medium is blocked
    QVERIFY2(!escapes([&] {
                 editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}),
                                   1000);
             }),
             "saveDraft let the store's exception out");
    std::optional<JsonValue> loaded = fields({{QStringLiteral("title"), QStringLiteral("sentinel")}});
    QVERIFY2(!escapes([&] { loaded = editor::loadDraft(store, QStringLiteral("a")); }),
             "loadDraft let the store's exception out");
    QCOMPARE(shown(loaded), QStringLiteral("null"));
    QVERIFY2(!escapes([&] { editor::clearDraft(store, QStringLiteral("a")); }), "clearDraft let the store's exception out");
    QVERIFY2(!escapes([&] { editor::expireDrafts(store, 1, qint64(9999999999LL)); }),
             "expireDrafts let the store's exception out");
    QVERIFY2(store.calls.size() == 4, qPrintable(store.calls.join(QStringLiteral(", ")))); // each really reached it
}

// ---- editorDraft — 초안 키 스코프(draftScopeId/draftKeyFor) ----------------------------------------------------

// it: '기존 기사(articleId)는 접두사 없이 그대로 키가 된다(창을 옮겨도 같은 초안을 찾는다)'
void EditorDraftTest::keysAnExistingArticleByItsId()
{
    QCOMPARE(editor::draftKeyFor(kScope, QStringLiteral("AKR1"), QStringLiteral("tab-1")), QStringLiteral("AKR1"));
}

// it: '신규 탭(articleId 없음)은 "<스코프>:<tabId>" 키가 되고 tabId 자체와 다르다' - the web's null / '' / undefined are
// C++'s null and empty QString.
void EditorDraftTest::keysANewTabByScopeAndTab()
{
    for (const QString &empty : {QString(), QStringLiteral("")}) {
        const QString key = editor::draftKeyFor(kScope, empty, QStringLiteral("tab-1"));
        QVERIFY(key != QStringLiteral("tab-1"));
        QCOMPARE(key, kScope + QStringLiteral(":tab-1"));
        QVERIFY(key.endsWith(QStringLiteral(":tab-1")));
    }
}

// it: '같은 로드 안에서는 여러 번 불러도 스코프가 동일하다(키 안정성)' - the scope is the caller's value, so the key is a
// function of its three inputs.
void EditorDraftTest::keepsTheKeyStableWithinOneScope()
{
    QCOMPARE(editor::draftKeyFor(kScope, QString(), QStringLiteral("tab-1")),
             editor::draftKeyFor(kScope, QString(), QStringLiteral("tab-1")));
}

// it: 'sessionStorage가 비면(=다른 창) 스코프가 달라지고, 값이 남아 있으면(F5) 같은 키가 나온다' - the scope the caller
// kept (the web's reload keeps sessionStorage) gives the same key; another window's scope gives another.
void EditorDraftTest::anotherScopeGetsAnotherKey()
{
    const QString first = editor::draftKeyFor(kScope, QString(), QStringLiteral("tab-1"));
    const QString kept = QString(kScope);
    QCOMPARE(editor::draftKeyFor(kept, QString(), QStringLiteral("tab-1")), first);
    QVERIFY(editor::draftKeyFor(QStringLiteral("w-another-window"), QString(), QStringLiteral("tab-1")) != first);
}

// it: 'sessionStorage 접근이 throw해도 예외 없이 안정된 문자열 키를 돌려준다(graceful)' - the key needs no store at all;
// even a caller with no scope (empty) gets a stable key that is not the bare tab id, and an article's key ignores the
// scope.
void EditorDraftTest::derivesTheKeyWithoutAnyStore()
{
    QString key;
    QVERIFY(!escapes([&] { key = editor::draftKeyFor(QString(), QString(), QStringLiteral("tab-1")); }));
    QVERIFY(key.endsWith(QStringLiteral(":tab-1")));
    QVERIFY(key != QStringLiteral("tab-1"));
    QCOMPARE(editor::draftKeyFor(QString(), QString(), QStringLiteral("tab-1")), key); // 안정
    QCOMPARE(editor::draftKeyFor(QString(), QStringLiteral("AKR1"), QStringLiteral("tab-1")), QStringLiteral("AKR1"));
}

// it: '키 규약만 바뀐다 — saveDraft/loadDraft/clearDraft는 그 키로 그대로 동작한다(저장 shape 불변)'
void EditorDraftTest::storesUnderTheDerivedKeyUnchanged()
{
    MemoryStore store;
    const QString key = editor::draftKeyFor(kScope, QString(), QStringLiteral("tab-1"));
    editor::saveDraft(store, key, fields({{QStringLiteral("title"), QStringLiteral("N")}}), 1000);
    editor::saveDraft(store, QStringLiteral("AKR1"), fields({{QStringLiteral("title"), QStringLiteral("A")}}), 1000);
    QCOMPARE(shown(editor::loadDraft(store, key)), QStringLiteral("{\"title\":\"N\"}"));
    editor::clearDraft(store, key);
    QCOMPARE(shown(editor::loadDraft(store, key)), QStringLiteral("null"));
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("AKR1"))), QStringLiteral("{\"title\":\"A\"}")); // 다른 키는 보존
}

// ---- editorDraft — 복구 읽기 폴백(loadDraftForRecover) -----------------------------------------------------------

// it: '새 키에 초안이 있으면 그 키/데이터를 반환한다(옛 키는 보지 않는다 — 새 키 우선)' - and the old key is not even read.
void EditorDraftTest::recoversFromTheNewKeyFirst()
{
    MemoryStore store;
    const QString key = editor::draftKeyFor(kScope, QString(), QStringLiteral("tab-1"));
    editor::saveDraft(store, key, fields({{QStringLiteral("title"), QStringLiteral("새초안")}}), 1000);
    editor::saveDraft(store, QStringLiteral("tab-1"), fields({{QStringLiteral("title"), QStringLiteral("옛초안")}}), 1000);
    store.calls.clear();

    QCOMPARE(shown(editor::loadDraftForRecover(store, kScope, QString(), QStringLiteral("tab-1"))),
             key + QStringLiteral(" => {\"title\":\"새초안\"}"));
    QVERIFY2(!store.calls.contains(QStringLiteral("load tab-1")), qPrintable(store.calls.join(QStringLiteral(", "))));
}

// it: '새 키가 비어 있고 옛 키(tab-N)에만 있으면 옛 초안을 찾아 그 키와 함께 반환한다'
void EditorDraftTest::fallsBackToTheLegacyTabKey()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("tab-1"), fields({{QStringLiteral("title"), QStringLiteral("옛초안")}}), 1000);

    QCOMPARE(shown(editor::loadDraftForRecover(store, kScope, QString(), QStringLiteral("tab-1"))),
             QStringLiteral("tab-1 => {\"title\":\"옛초안\"}"));
}

// it: '기존 기사(articleId)에는 폴백하지 않는다 — 같은 탭의 tab-N 초안(다른 문서)을 되살리지 않는다'
void EditorDraftTest::neverFallsBackForAnExistingArticle()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("tab-1"), fields({{QStringLiteral("title"), QStringLiteral("남의초안")}}), 1000);
    QCOMPARE(shown(editor::loadDraftForRecover(store, kScope, QStringLiteral("AKR1"), QStringLiteral("tab-1"))),
             QStringLiteral("null"));

    editor::saveDraft(store, QStringLiteral("AKR1"), fields({{QStringLiteral("title"), QStringLiteral("내초안")}}), 1000);
    QCOMPARE(shown(editor::loadDraftForRecover(store, kScope, QStringLiteral("AKR1"), QStringLiteral("tab-1"))),
             QStringLiteral("AKR1 => {\"title\":\"내초안\"}"));
}

// it: '새 키·옛 키 어디에도 없으면 null이다(기존 "없습니다" 안내 경로 유지)'
void EditorDraftTest::recoversNothingWhenNoKeyHoldsADraft()
{
    MemoryStore store;
    QCOMPARE(shown(editor::loadDraftForRecover(store, kScope, QString(), QStringLiteral("tab-1"))), QStringLiteral("null"));
    QCOMPARE(shown(editor::loadDraftForRecover(store, kScope, QStringLiteral("AKR1"), QStringLiteral("tab-1"))),
             QStringLiteral("null"));
}

// it: '반환된 key는 clearDraft로 그대로 지울 수 있다(복구 후 재부활 방지 — 찾은 키를 지운다)'
void EditorDraftTest::theFoundKeyClearsTheRecoveredDraft()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("tab-1"), fields({{QStringLiteral("title"), QStringLiteral("옛초안")}}), 1000);
    const std::optional<RecoveredDraft> found =
        editor::loadDraftForRecover(store, kScope, QString(), QStringLiteral("tab-1"));
    QVERIFY(found);

    editor::clearDraft(store, found->key);
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("tab-1"))), QStringLiteral("null"));
    QCOMPARE(shown(editor::loadDraftForRecover(store, kScope, QString(), QStringLiteral("tab-1"))), QStringLiteral("null"));
}

// it: '읽기 전용이다 — 조회만으로 저장소가 바뀌지 않는다(옛 키 재기록·이관 0건)'
void EditorDraftTest::recoveryIsReadOnly()
{
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("tab-1"), fields({{QStringLiteral("title"), QStringLiteral("옛초안")}}), 1000);
    const QString before = store.dump();
    const int writesBefore = store.writes();

    editor::loadDraftForRecover(store, kScope, QString(), QStringLiteral("tab-1"));

    QCOMPARE(store.dump(), before);
    QCOMPARE(store.writes(), writesBefore);
    QCOMPARE(shown(editor::loadDraft(store, editor::draftKeyFor(kScope, QString(), QStringLiteral("tab-1")))),
             QStringLiteral("null")); // 새 키로 복사하지 않는다
}

// ---- port locks ------------------------------------------------------------------------------------------------

// The time a draft carries is the caller's, exactly - a module that asked the clock would store its own, and an
// expiry at the caller's instant keeps the draft just saved there whatever the real date is.
void EditorDraftTest::passesTheInjectedTimeThrough_data()
{
    QTest::addColumn<qint64>("nowMs");

    QTest::newRow("zero") << qint64(0);
    QTest::newRow("one") << qint64(1);
    QTest::newRow("minus one") << qint64(-1);
    QTest::newRow("web 1000") << qint64(1000);
    QTest::newRow("one day") << DAY;
    QTest::newRow("a 2024 clock") << qint64(1730000000000LL);
    QTest::newRow("2^53 - 1") << qint64(9007199254740991LL);
    QTest::newRow("int64 max") << std::numeric_limits<qint64>::max();
    QTest::newRow("int64 min") << std::numeric_limits<qint64>::min();
}

void EditorDraftTest::passesTheInjectedTimeThrough()
{
    QFETCH(qint64, nowMs);

    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}), nowMs);
    QCOMPARE(store.items.size(), 1);
    QCOMPARE(store.items.at(0).savedAtMs, nowMs);

    editor::expireDrafts(store, 1, nowMs);
    QCOMPARE(editor::listDrafts(store), QStringList{QStringLiteral("a")});
}

// expireDrafts against the web on the same drafts, retention and clock: saved = "key=savedAt ..." in insertion order,
// kept = the keys left, in order.
void EditorDraftTest::expiresByTheInjectedClock_data()
{
    QTest::addColumn<int>("retentionDays");
    QTest::addColumn<qint64>("nowMs");
    QTest::addColumn<QString>("saved");
    QTest::addColumn<QStringList>("kept");

    QTest::newRow("E01 web it: only the draft past the retention goes")
        << 1 << qint64(172801000LL) << QStringLiteral("old=1000 fresh=86401000") << QStringList{QStringLiteral("fresh")};
    QTest::newRow("E02 web it: exactly at the retention limit stays")
        << 1 << qint64(86401000LL) << QStringLiteral("edge=1000") << QStringList{QStringLiteral("edge")};
    QTest::newRow("E03 one day: cutoff - 1, cutoff, cutoff + 1, now, future")
        << 1 << qint64(172801000LL) << QStringLiteral("a=86400999 b=86401000 c=86401001 d=172801000 e=172801001") << QStringList{QStringLiteral("b"), QStringLiteral("c"), QStringLiteral("d"), QStringLiteral("e")};
    QTest::newRow("E04 seven days at a 2024 clock")
        << 7 << qint64(1730000000000LL) << QStringLiteral("a=1729395199999 b=1729395200000 c=1729913600000 d=1730000000000") << QStringList{QStringLiteral("b"), QStringLiteral("c"), QStringLiteral("d")};
    QTest::newRow("E05 zero days: anything older than now goes")
        << 0 << qint64(5000LL) << QStringLiteral("a=4999 b=5000 c=5001") << QStringList{QStringLiteral("b"), QStringLiteral("c")};
    QTest::newRow("E06 negative days: the cutoff is in the future")
        << -1 << qint64(5000LL) << QStringLiteral("a=5000 b=86404999 c=86405000") << QStringList{QStringLiteral("c")};
    QTest::newRow("E07 now 0 keeps drafts saved at 1000")
        << 1 << qint64(0LL) << QStringLiteral("a=1000 b=-86400000 c=-86400001") << QStringList{QStringLiteral("a"), QStringLiteral("b")};
    QTest::newRow("E08 web it 7 clock 9999999999")
        << 1 << qint64(9999999999LL) << QStringLiteral("a=1000 b=9913599999 c=9999999999") << QStringList{QStringLiteral("b"), QStringLiteral("c")};
    QTest::newRow("E09 empty store")
        << 1 << qint64(172801000LL) << QStringLiteral("") << QStringList();
    QTest::newRow("E10 every draft goes")
        << 1 << qint64(432001000LL) << QStringLiteral("a=1000 b=2000 c=86401000") << QStringList();
    QTest::newRow("E11 no draft goes")
        << 3 << qint64(86401000LL) << QStringLiteral("a=1000 b=2000") << QStringList{QStringLiteral("a"), QStringLiteral("b")};
    QTest::newRow("E12 near 2^53")
        << 1 << qint64(9007199254740991LL) << QStringLiteral("a=9007199168340990 b=9007199168340991 c=9007199254740991") << QStringList{QStringLiteral("b"), QStringLiteral("c")};
    QTest::newRow("E13 negative saved times")
        << 1 << qint64(-86400000LL) << QStringLiteral("a=-172800001 b=-172800000 c=-86400000") << QStringList{QStringLiteral("b"), QStringLiteral("c")};
    QTest::newRow("E14 order of the survivors is kept")
        << 2 << qint64(864000000LL) << QStringLiteral("z=777600000 y=86400000 x=691200000 w=604800000") << QStringList{QStringLiteral("z"), QStringLiteral("x")};
}

void EditorDraftTest::expiresByTheInjectedClock()
{
    QFETCH(int, retentionDays);
    QFETCH(qint64, nowMs);
    QFETCH(QString, saved);
    QFETCH(QStringList, kept);

    MemoryStore store;
    for (const QString &item : saved.split(QLatin1Char(' '), Qt::SkipEmptyParts)) {
        const qsizetype eq = item.indexOf(QLatin1Char('='));
        bool ok = false;
        const qint64 at = item.mid(eq + 1).toLongLong(&ok);
        QVERIFY2(eq > 0 && ok, qPrintable(item));
        const QString key = item.left(eq);
        editor::saveDraft(store, key, fields({{QStringLiteral("title"), key}}), at);
    }

    editor::expireDrafts(store, retentionDays, nowMs);

    QCOMPARE(editor::listDrafts(store), kept);
    for (const QString &key : kept)
        QCOMPARE(shown(editor::loadDraft(store, key)), QStringLiteral("{\"title\":\"%1\"}").arg(key));
}

// loadDraftForRecover against the web: stored = "key=title|..." (saved in that order), found = the key found or "-".
// The scope is the one the generator fixed in sessionStorage.
void EditorDraftTest::recoversLikeTheWeb_data()
{
    QTest::addColumn<QString>("articleId");
    QTest::addColumn<QString>("tabId");
    QTest::addColumn<QString>("stored");
    QTest::addColumn<QString>("found");
    QTest::addColumn<QString>("title");

    QTest::newRow("R null id: nothing stored")
        << QString() << QStringLiteral("tab-1") << QStringLiteral("") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R null id: new key only")
        << QString() << QStringLiteral("tab-1") << QStringLiteral("w-fixed:tab-1=new") << QStringLiteral("w-fixed:tab-1") << QStringLiteral("new");
    QTest::newRow("R null id: legacy key only")
        << QString() << QStringLiteral("tab-1") << QStringLiteral("tab-1=old") << QStringLiteral("tab-1") << QStringLiteral("old");
    QTest::newRow("R null id: both - the new key wins")
        << QString() << QStringLiteral("tab-1") << QStringLiteral("tab-1=old|w-fixed:tab-1=new") << QStringLiteral("w-fixed:tab-1") << QStringLiteral("new");
    QTest::newRow("R null id: another tab only")
        << QString() << QStringLiteral("tab-1") << QStringLiteral("w-fixed:tab-2=other|tab-2=other-old") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R null id: an article key is not a tab key")
        << QString() << QStringLiteral("tab-1") << QStringLiteral("AKR1=article") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R null id: another scope is not ours")
        << QString() << QStringLiteral("tab-1") << QStringLiteral("w-other:tab-1=theirs") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R empty id: nothing stored")
        << QStringLiteral("") << QStringLiteral("tab-1") << QStringLiteral("") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R empty id: new key only")
        << QStringLiteral("") << QStringLiteral("tab-1") << QStringLiteral("w-fixed:tab-1=new") << QStringLiteral("w-fixed:tab-1") << QStringLiteral("new");
    QTest::newRow("R empty id: legacy key only")
        << QStringLiteral("") << QStringLiteral("tab-1") << QStringLiteral("tab-1=old") << QStringLiteral("tab-1") << QStringLiteral("old");
    QTest::newRow("R empty id: both - the new key wins")
        << QStringLiteral("") << QStringLiteral("tab-1") << QStringLiteral("tab-1=old|w-fixed:tab-1=new") << QStringLiteral("w-fixed:tab-1") << QStringLiteral("new");
    QTest::newRow("R empty id: another tab only")
        << QStringLiteral("") << QStringLiteral("tab-1") << QStringLiteral("w-fixed:tab-2=other|tab-2=other-old") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R empty id: an article key is not a tab key")
        << QStringLiteral("") << QStringLiteral("tab-1") << QStringLiteral("AKR1=article") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R empty id: another scope is not ours")
        << QStringLiteral("") << QStringLiteral("tab-1") << QStringLiteral("w-other:tab-1=theirs") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R article: nothing stored")
        << QStringLiteral("AKR1") << QStringLiteral("tab-1") << QStringLiteral("") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R article: its own key")
        << QStringLiteral("AKR1") << QStringLiteral("tab-1") << QStringLiteral("AKR1=mine") << QStringLiteral("AKR1") << QStringLiteral("mine");
    QTest::newRow("R article: never the legacy tab key")
        << QStringLiteral("AKR1") << QStringLiteral("tab-1") << QStringLiteral("tab-1=someone-else") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R article: never the new tab key")
        << QStringLiteral("AKR1") << QStringLiteral("tab-1") << QStringLiteral("w-fixed:tab-1=new-tab") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R article: own key with both tab keys around")
        << QStringLiteral("AKR1") << QStringLiteral("tab-1") << QStringLiteral("tab-1=old|w-fixed:tab-1=new|AKR1=mine") << QStringLiteral("AKR1") << QStringLiteral("mine");
    QTest::newRow("R article: another article only")
        << QStringLiteral("AKR1") << QStringLiteral("tab-1") << QStringLiteral("AKR2=other") << QStringLiteral("-") << QStringLiteral("");
    QTest::newRow("R empty tab id: the legacy key is the empty key")
        << QString() << QStringLiteral("") << QStringLiteral("=blank") << QStringLiteral("") << QStringLiteral("blank");
    QTest::newRow("R empty tab id: the new key ends with a colon")
        << QString() << QStringLiteral("") << QStringLiteral("w-fixed:=blank-new|=blank") << QStringLiteral("w-fixed:") << QStringLiteral("blank-new");
    QTest::newRow("R tab id with a colon")
        << QString() << QStringLiteral("a:b") << QStringLiteral("a:b=legacy") << QStringLiteral("a:b") << QStringLiteral("legacy");
}

void EditorDraftTest::recoversLikeTheWeb()
{
    QFETCH(QString, articleId);
    QFETCH(QString, tabId);
    QFETCH(QString, stored);
    QFETCH(QString, found);
    QFETCH(QString, title);

    MemoryStore store;
    for (const QString &item : stored.split(QLatin1Char('|'), Qt::SkipEmptyParts)) {
        const qsizetype eq = item.indexOf(QLatin1Char('='));
        QVERIFY2(eq >= 0, qPrintable(item));
        editor::saveDraft(store, item.left(eq), fields({{QStringLiteral("title"), item.mid(eq + 1)}}), 1000);
    }
    const QString before = store.dump();

    const std::optional<RecoveredDraft> result = editor::loadDraftForRecover(store, kWebScope, articleId, tabId);

    QCOMPARE(store.dump(), before); // read only
    if (found == QStringLiteral("-")) {
        QCOMPARE(shown(result), QStringLiteral("null"));
    } else {
        QCOMPARE(shown(result), found + QStringLiteral(" => ") + editor::stringifyJson(fields({{QStringLiteral("title"), title}})));
    }
}

// Each store operation failing on its own, under each function: nothing escapes, the answer is the "no storage"
// default, and the store keeps what it had (or what the operations that did succeed made of it). failing: "op" =
// every call, "op@n" = from the n-th call, "op#n" = only the n-th (counted after the two seed drafts are in).
void EditorDraftTest::swallowsEveryStoreFailure_data()
{
    QTest::addColumn<QString>("failing");
    QTest::addColumn<QString>("call");
    QTest::addColumn<QString>("result"); // what the call answered ("-" for a void call)
    QTest::addColumn<QString>("after");  // the keys held afterwards

    QTest::newRow("save fails: saveDraft") << QStringLiteral("save") << QStringLiteral("saveDraft") << QStringLiteral("-")
                                           << QStringLiteral("a,tab-1");
    QTest::newRow("load fails: loadDraft") << QStringLiteral("load") << QStringLiteral("loadDraft")
                                           << QStringLiteral("null") << QStringLiteral("a,tab-1");
    QTest::newRow("remove fails: clearDraft") << QStringLiteral("remove") << QStringLiteral("clearDraft")
                                              << QStringLiteral("-") << QStringLiteral("a,tab-1");
    QTest::newRow("keys fails: listDrafts") << QStringLiteral("keys") << QStringLiteral("listDrafts") << QStringLiteral("")
                                            << QStringLiteral("a,tab-1");
    QTest::newRow("keys fails: expireDrafts") << QStringLiteral("keys") << QStringLiteral("expireDrafts")
                                              << QStringLiteral("-") << QStringLiteral("a,tab-1");
    QTest::newRow("load fails: expireDrafts") << QStringLiteral("load") << QStringLiteral("expireDrafts")
                                              << QStringLiteral("-") << QStringLiteral("a,tab-1");
    QTest::newRow("remove fails: expireDrafts") << QStringLiteral("remove") << QStringLiteral("expireDrafts")
                                                << QStringLiteral("-") << QStringLiteral("a,tab-1");
    QTest::newRow("second remove fails: expireDrafts stops there")
        << QStringLiteral("remove@2") << QStringLiteral("expireDrafts") << QStringLiteral("-") << QStringLiteral("tab-1");
    QTest::newRow("load fails: loadDraftForRecover") << QStringLiteral("load") << QStringLiteral("loadDraftForRecover")
                                                     << QStringLiteral("null") << QStringLiteral("a,tab-1");
    QTest::newRow("first load fails: recovery still reads the old key")
        << QStringLiteral("load#1") << QStringLiteral("loadDraftForRecover")
        << QStringLiteral("tab-1 => {\"title\":\"L\"}") << QStringLiteral("a,tab-1");
    QTest::newRow("second load fails: recovery answers null")
        << QStringLiteral("load#2") << QStringLiteral("loadDraftForRecover") << QStringLiteral("null")
        << QStringLiteral("a,tab-1");
    QTest::newRow("save fails: listDrafts still answers") << QStringLiteral("save") << QStringLiteral("listDrafts")
                                                          << QStringLiteral("a,tab-1") << QStringLiteral("a,tab-1");
    QTest::newRow("keys fails: loadDraft still answers") << QStringLiteral("keys") << QStringLiteral("loadDraft")
                                                         << QStringLiteral("{\"title\":\"A\"}") << QStringLiteral("a,tab-1");
    QTest::newRow("remove fails: saveDraft still saves") << QStringLiteral("remove") << QStringLiteral("saveDraft")
                                                         << QStringLiteral("-") << QStringLiteral("a,tab-1,n");
    QTest::newRow("save fails: clearDraft still clears") << QStringLiteral("save") << QStringLiteral("clearDraft")
                                                         << QStringLiteral("-") << QStringLiteral("tab-1");
    QTest::newRow("nothing fails: expireDrafts removes both") << QString() << QStringLiteral("expireDrafts")
                                                              << QStringLiteral("-") << QStringLiteral("");
}

void EditorDraftTest::swallowsEveryStoreFailure()
{
    QFETCH(QString, failing);
    QFETCH(QString, call);
    QFETCH(QString, result);
    QFETCH(QString, after);

    MemoryStore store;
    seed(store);
    store.arm(failing);

    QString answer = QStringLiteral("-");
    const bool escaped = escapes([&] {
        if (call == QLatin1String("saveDraft"))
            editor::saveDraft(store, QStringLiteral("n"), fields({{QStringLiteral("title"), QStringLiteral("N")}}), 5);
        else if (call == QLatin1String("loadDraft"))
            answer = shown(editor::loadDraft(store, QStringLiteral("a")));
        else if (call == QLatin1String("clearDraft"))
            editor::clearDraft(store, QStringLiteral("a"));
        else if (call == QLatin1String("listDrafts"))
            answer = editor::listDrafts(store).join(QLatin1Char(','));
        else if (call == QLatin1String("expireDrafts"))
            editor::expireDrafts(store, 1, 1000 + 2 * DAY); // both seeds are past the retention
        else if (call == QLatin1String("loadDraftForRecover"))
            answer = shown(editor::loadDraftForRecover(store, kScope, QString(), QStringLiteral("tab-1")));
        else
            answer = QStringLiteral("unknown call ") + call;
    });

    QVERIFY2(!escaped, qPrintable(call + QStringLiteral(" let the store's exception out")));
    QCOMPARE(answer, result);
    QCOMPARE(store.keyList(), after);
}

// CRITICAL (shell/clientconfig.h, inherited): no session id, password, cookie or token - nor the edit client id -
// ever reaches the store, and one planted in the stored data never reaches the caller. Only the DRAFT_FIELDS with a
// string value pass, in the caller's order.
void EditorDraftTest::keepsOnlyTheDraftFields()
{
    const QStringList secrets{QStringLiteral("sessionId"),       QStringLiteral("sid"),
                              QStringLiteral("password"),        QStringLiteral("cookie"),
                              QStringLiteral("token"),           QStringLiteral("accessToken"),
                              QStringLiteral("authorization"),   QStringLiteral("x-session-id"),
                              QStringLiteral("x-edit-client"),   QStringLiteral("clientId"),
                              QStringLiteral("editClientId"),    QStringLiteral("lockerSessionId"),
                              QStringLiteral("lockerClientId"),  QStringLiteral("role")};

    // Guards first: a broken whitelist has to turn this red, not index an empty list.
    QVERIFY(editor::DRAFT_FIELDS.contains(QStringLiteral("category")));
    QVERIFY(editor::DRAFT_FIELDS.contains(QStringLiteral("region")));
    QCOMPARE(editor::DRAFT_FIELDS.value(0), QStringLiteral("title"));

    // In: every draft field, each preceded by a secret; one field (category) carries a number, one (region) null.
    JsonValue data = JsonValue::makeObject();
    for (qsizetype i = 0; i < editor::DRAFT_FIELDS.size(); ++i) {
        const QString &field = editor::DRAFT_FIELDS.at(i);
        const QString &secret = secrets.at(i % secrets.size());
        data.insert(secret, str(QStringLiteral("secret-") + secret));
        if (field == QLatin1String("category"))
            data.insert(field, JsonValue::makeNumber(7));
        else if (field == QLatin1String("region"))
            data.insert(field, JsonValue::makeNull());
        else
            data.insert(field, str(QStringLiteral("v-") + field));
    }
    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("a"), data, 1000);
    QCOMPARE(store.items.size(), 1);

    JsonValue expected = JsonValue::makeObject();
    for (const QString &field : editor::DRAFT_FIELDS) {
        if (field != QLatin1String("category") && field != QLatin1String("region"))
            expected.insert(field, str(QStringLiteral("v-") + field));
    }
    QCOMPARE(editor::stringifyJson(store.items.at(0).data), editor::stringifyJson(expected));
    const QString written = editor::stringifyJson(store.items.at(0).data);
    for (const QString &secret : secrets)
        QVERIFY2(!written.contains(QStringLiteral("secret-") + secret), qPrintable(secret + QStringLiteral(" reached the store")));
    QCOMPARE(editor::stringifyJson(editor::sanitizeDraftData(data)), editor::stringifyJson(expected));

    // Out: a key planted in the stored data (a hand-edited file) stays in the store and out of the answer.
    store.items[0].data.insert(QStringLiteral("password"), str(QStringLiteral("pw")));
    store.items[0].data.insert(QStringLiteral("title"), JsonValue::makeBool(true)); // and a non-string draft field
    JsonValue expectedOut = expected;
    QVERIFY(!expectedOut.members.empty() && expectedOut.members.front().key == QLatin1String("title"));
    expectedOut.members.erase(expectedOut.members.begin()); // "title" is the first draft field and no longer a string
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("a"))), editor::stringifyJson(expectedOut));
    const std::optional<RecoveredDraft> recovered = editor::loadDraftForRecover(store, kScope, QStringLiteral("a"),
                                                                                QStringLiteral("tab-1"));
    QVERIFY(recovered);
    QVERIFY(!editor::stringifyJson(recovered->data).contains(QStringLiteral("pw")));

    // A non-object is not a draft: not saved (the previous draft stays) ...
    MemoryStore kept;
    editor::saveDraft(kept, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("good")}}), 1000);
    QCOMPARE(kept.items.size(), 1);
    for (const JsonValue &notObject : {JsonValue::makeNull(), JsonValue::makeString(QStringLiteral("sessionId=s-1")),
                                       JsonValue::makeNumber(1), JsonValue::makeBool(true), JsonValue::makeArray()}) {
        editor::saveDraft(kept, QStringLiteral("a"), notObject, 2000);
        QCOMPARE(shown(editor::loadDraft(kept, QStringLiteral("a"))), QStringLiteral("{\"title\":\"good\"}"));
        QCOMPARE(kept.items.at(0).savedAtMs, qint64(1000));
        QCOMPARE(editor::stringifyJson(editor::sanitizeDraftData(notObject)), QStringLiteral("{}"));
    }
    // ... and a stored non-object reads as no draft, so recovery passes it by.
    kept.items[0].data = JsonValue::makeString(QStringLiteral("x"));
    QCOMPARE(shown(editor::loadDraft(kept, QStringLiteral("a"))), QStringLiteral("null"));
    QCOMPARE(shown(editor::loadDraftForRecover(kept, kScope, QStringLiteral("a"), QStringLiteral("tab-1"))),
             QStringLiteral("null"));

    // An object without a single draft field is still a draft - an empty one (the web's {} is truthy too).
    editor::saveDraft(kept, QStringLiteral("e"), fields({{QStringLiteral("sessionId"), QStringLiteral("s-1")}}), 3000);
    QCOMPARE(shown(editor::loadDraft(kept, QStringLiteral("e"))), QStringLiteral("{}"));

    // And the whitelist itself names no secret.
    static const QRegularExpression secretLike(
        QStringLiteral("session|passw|cookie|token|secret|client|authoriz|^sid$|role|locker"),
        QRegularExpression::CaseInsensitiveOption);
    for (const QString &field : editor::DRAFT_FIELDS)
        QVERIFY2(!secretLike.match(field).hasMatch(), qPrintable(field + QStringLiteral(" looks like a secret")));
}

// DRAFT_FIELDS is the web's EDITABLE_FIELDS, read from the canonical source at run time - a field added there (or
// here) without the other turns this red.
void EditorDraftTest::draftFieldsAreTheWebsEditableFields()
{
    QByteArray bytes;
    QString error;
    QVERIFY2(readRepoFile(QStringLiteral("web/src/controller/useWriteController.js"), &bytes, &error), qPrintable(error));
    const QString source = QString::fromUtf8(bytes);

    static const QRegularExpression declaration(QStringLiteral("const\\s+EDITABLE_FIELDS\\s*=\\s*\\[([^\\]]*)\\]"));
    const QRegularExpressionMatch match = declaration.match(source);
    QVERIFY2(match.hasMatch(), "const EDITABLE_FIELDS = [...] not found in web/src/controller/useWriteController.js");

    static const QRegularExpression item(QStringLiteral("'([^']*)'"));
    QStringList web;
    for (QRegularExpressionMatchIterator it = item.globalMatch(match.captured(1)); it.hasNext();)
        web << it.next().captured(1);

    QCOMPARE(web.size(), 14);
    QCOMPARE(editor::DRAFT_FIELDS, web);
}

// A key is an opaque string: whatever the caller derives reaches the store as it is and comes back. webKeeps is the
// web module's own round trip - false only where the web loses the key (its "__proto__" prototype setter).
void EditorDraftTest::treatsTheKeyAsOpaque_data()
{
    QTest::addColumn<QString>("key");
    QTest::addColumn<int>("units");
    QTest::addColumn<bool>("webKeeps");

    QTest::newRow("K01 empty key")
        << QStringLiteral("") << 0 << true;
    QTest::newRow("K02 colon only")
        << QStringLiteral(":") << 1 << true;
    QTest::newRow("K03 scope and tab")
        << QStringLiteral("w-fixed:tab-1") << 13 << true;
    QTest::newRow("K04 article id")
        << QStringLiteral("AKR20261101000100017") << 20 << true;
    QTest::newRow("K05 numeric")
        << QStringLiteral("123") << 3 << true;
    QTest::newRow("K06 zero")
        << QStringLiteral("0") << 1 << true;
    QTest::newRow("K07 toString")
        << QStringLiteral("toString") << 8 << true;
    QTest::newRow("K08 constructor")
        << QStringLiteral("constructor") << 11 << true;
    QTest::newRow("K09 __proto__ (web drops it)")
        << QStringLiteral("__proto__") << 9 << false;
    QTest::newRow("K10 Hangul")
        << QStringLiteral("기사-초안") << 5 << true;
    QTest::newRow("K11 astral")
        << QStringLiteral("a\U0001F600b") << 4 << true;
    QTest::newRow("K12 lone surrogate")
        << units({0x0061, 0xD800, 0x0062}) << 3 << true;
    QTest::newRow("K13 slashes and dots")
        << QStringLiteral("a/b\\c.d") << 7 << true;
    QTest::newRow("K14 spaces and tab")
        << QStringLiteral(" a\tb ") << 5 << true;
    QTest::newRow("K15 quote and newline")
        << QStringLiteral("a\"b\nc") << 5 << true;
    QTest::newRow("K16 NUL")
        << units({0x0061, 0x0000, 0x0062}) << 3 << true;
    QTest::newRow("K17 long")
        << QStringLiteral("kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk") << 1000 << true;
}

void EditorDraftTest::treatsTheKeyAsOpaque()
{
    QFETCH(QString, key);
    QFETCH(int, units);
    QFETCH(bool, webKeeps);

    QCOMPARE(int(key.size()), units); // the literal survived construction
    QVERIFY2(webKeeps || key == QStringLiteral("__proto__"),
             "the web loses a key other than __proto__ - a divergence the header does not list");

    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("other"), fields({{QStringLiteral("title"), QStringLiteral("O")}}), 1);
    editor::saveDraft(store, key, fields({{QStringLiteral("title"), QStringLiteral("T")}}), 1000);
    QCOMPARE(store.items.size(), 2);
    QVERIFY(store.items.at(1).key == key); // exactly this key, code unit for code unit
    QCOMPARE(shown(editor::loadDraft(store, key)), QStringLiteral("{\"title\":\"T\"}"));
    QCOMPARE(editor::listDrafts(store), (QStringList{QStringLiteral("other"), key}));

    editor::clearDraft(store, key);
    QCOMPARE(shown(editor::loadDraft(store, key)), QStringLiteral("null"));
    QCOMPARE(editor::listDrafts(store), QStringList{QStringLiteral("other")});
}

// The body is the opaque saved markup: it reaches the store and comes back code unit for code unit - including
// strings that serialize(deserialize(x)) would change, lone surrogates and NULs.
void EditorDraftTest::neverNormalizesTheBody_data()
{
    QTest::addColumn<QString>("body");
    QTest::addColumn<int>("units"); // UTF-16 length per node - the literal survived construction

    QTest::newRow("S01 empty")
        << QStringLiteral("") << 0;
    QTest::newRow("S02 canonical markup")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 102;
    QTest::newRow("S03 markup with whitespace")
        << QStringLiteral("{ \"format\": \"yh-editor\", \"version\": 1, \"blocks\": [ {\"type\": \"text\", \"text\": \"본문\"} ] }") << 85;
    QTest::newRow("S04 markup with a unicode escape")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\\ubcf8\\ubb38\"}]}") << 83;
    QTest::newRow("S05 legacy plain text")
        << QStringLiteral("제목\n부제\n본문\n(끝)") << 12;
    QTest::newRow("S06 CRLF")
        << QStringLiteral("A\r\nB\r\n") << 6;
    QTest::newRow("S07 leading BOM")
        << QStringLiteral("\uFEFFA") << 2;
    QTest::newRow("S08 line and paragraph separators")
        << QStringLiteral("A\u2028B\u2029C") << 5;
    QTest::newRow("S09 NUL and C0 controls")
        << units({0x0061, 0x0000, 0x0062, 0x0001, 0x0063, 0x001F, 0x0064}) << 7;
    QTest::newRow("S10 DEL and C1")
        << QStringLiteral("a\u007Fb\u0085c") << 5;
    QTest::newRow("S11 lone high surrogate")
        << units({0x0061, 0xD800, 0x0062}) << 3;
    QTest::newRow("S12 lone low surrogate")
        << units({0x0061, 0xDC00, 0x0062}) << 3;
    QTest::newRow("S13 reversed pair")
        << units({0xDC00, 0xD800}) << 2;
    QTest::newRow("S14 astral pair")
        << QStringLiteral("\U0001F600\U00020BB7") << 4;
    QTest::newRow("S15 quotes backslashes slash")
        << QStringLiteral("say \"hi\" \\ / \\n") << 15;
    QTest::newRow("S16 script close tag")
        << QStringLiteral("</script><!--") << 13;
    QTest::newRow("S17 NFD Hangul")
        << QStringLiteral("\u1100\u1161\u11A8") << 3;
    QTest::newRow("S18 replacement char")
        << QStringLiteral("\uFFFD") << 1;
    QTest::newRow("S19 trailing spaces and NBSP")
        << QStringLiteral("A \u00A0 ") << 4;
    QTest::newRow("S20 long")
        << QStringLiteral("가나다라").repeated(2500) << 10000;
}

void EditorDraftTest::neverNormalizesTheBody()
{
    QFETCH(QString, body);
    QFETCH(int, units);

    QCOMPARE(int(body.size()), units);
    JsonValue data = fields({{QStringLiteral("title"), QStringLiteral("t")}});
    data.insert(QStringLiteral("body"), str(body));

    MemoryStore store;
    editor::saveDraft(store, QStringLiteral("a"), data, 1000);
    QCOMPARE(store.items.size(), 1);
    const JsonValue *stored = store.items.at(0).data.find(QStringLiteral("body"));
    QVERIFY(stored && stored->kind == JsonValue::Kind::String);
    QVERIFY2(stored->stringValue == body, "the body reached the store changed");

    const std::optional<JsonValue> back = editor::loadDraft(store, QStringLiteral("a"));
    QVERIFY(back);
    const JsonValue *loaded = back->find(QStringLiteral("body"));
    QVERIFY(loaded && loaded->kind == JsonValue::Kind::String);
    QCOMPARE(int(loaded->stringValue.size()), units);
    QVERIFY2(loaded->stringValue == body, "the body came back changed");
}

// The pure module reads no clock, runs no timer, makes up no id and touches no file or other layer - and the file
// store reads no clock either (savedAt is always the caller's). Comments are not code; string literals are.
void EditorDraftTest::readsNoClockAndTouchesNoFile()
{
    // The scanner is not vacuous: it flags a clock call and a file, and ignores both inside comments.
    const QString label = QStringLiteral("fixture");
    QVERIFY(!findingsIn(label, QStringLiteral("const qint64 now = QDateTime::currentMSecsSinceEpoch();"),
                        clockSpellings())
                 .isEmpty());
    QVERIFY(!findingsIn(label, QStringLiteral("QFile f(path);"), storageSpellings()).isEmpty());
    QVERIFY(findingsIn(label, QStringLiteral("// QDateTime::currentMSecsSinceEpoch()\n/* QTimer t; QFile f; */ int x;"),
                       clockSpellings() + timerSpellings() + storageSpellings())
                .isEmpty());

    const QStringList pure = clockSpellings() + timerSpellings() + randomSpellings() + storageSpellings();
    for (const QString &relative : {QStringLiteral("client-qt/src/editor/editordraft.h"),
                                    QStringLiteral("client-qt/src/editor/editordraft.cpp")}) {
        const QString text = sourceText(relative);
        QVERIFY2(text.size() > 1000, qPrintable(relative + QStringLiteral(" could not be read")));
        const QStringList findings = findingsIn(relative, text, pure);
        QVERIFY2(findings.isEmpty(), qPrintable(findings.join(QStringLiteral("\n"))));
    }

    const QStringList store = clockSpellings() + timerSpellings() + randomSpellings();
    for (const QString &relative : {QStringLiteral("client-qt/src/editor/editordraftstore.h"),
                                    QStringLiteral("client-qt/src/editor/editordraftstore.cpp")}) {
        const QString text = sourceText(relative);
        QVERIFY2(text.size() > 1000, qPrintable(relative + QStringLiteral(" could not be read")));
        const QStringList findings = findingsIn(relative, text, store);
        QVERIFY2(findings.isEmpty(), qPrintable(findings.join(QStringLiteral("\n"))));
    }
}
