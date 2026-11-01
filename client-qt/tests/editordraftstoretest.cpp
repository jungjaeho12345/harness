#include "editordraftstoretest.h"

#include "editor/editorcontent.h"
#include "editor/editordraft.h"
#include "editor/editordraftstore.h"
#include "shell/clientconfig.h"
#include "shell/configstore.h"

#include <QByteArray>
#include <QChar>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QIODevice>
#include <QLatin1Char>
#include <QList>
#include <QSet>
#include <QString>
#include <QStringList>
#include <QTemporaryDir>
#include <QtTest>

#include <initializer_list>
#include <optional>
#include <utility>

using editor::JsonValue;

namespace {

constexpr qint64 DAY = 86400000;

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

JsonValue fields(std::initializer_list<std::pair<QString, QString>> members)
{
    JsonValue object = JsonValue::makeObject();
    for (const auto &member : members)
        object.insert(member.first, str(member.second));
    return object;
}

QString shown(const std::optional<JsonValue> &data)
{
    return data ? editor::stringifyJson(*data) : QStringLiteral("null");
}

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

QByteArray readBytes(const QString &path)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly))
        return QByteArray("<unreadable>");
    return file.readAll();
}

bool writeBytes(const QString &path, const QByteArray &bytes)
{
    if (!QDir().mkpath(QFileInfo(path).absolutePath()))
        return false;
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate))
        return false;
    return file.write(bytes) == bytes.size();
}

// The stored value as the web's localStorage.getItem would show it: the file's text, or <none> when there is no file.
QString fileText(const QString &path)
{
    if (!QFileInfo::exists(path))
        return QStringLiteral("<none>");
    return QString::fromUtf8(readBytes(path));
}

// Records every filesystem call the store makes, in order (configstoretest.cpp's spy, for the drafts file), and can
// fail any kind of call. readFile hands back `content` when readOk, and fails otherwise.
class SpyFileSystem : public shell::ConfigFileSystem
{
public:
    struct Call {
        QString name;
        QString first;
        QString second;
        QByteArray data;
    };

    QList<Call> calls;
    bool readOk = true;
    QByteArray content;
    QSet<QString> failing;

    bool makeDirectory(const QString &dirPath) override
    {
        return record({QStringLiteral("makeDirectory"), dirPath, QString(), QByteArray()});
    }

    bool writeFile(const QString &filePath, const QByteArray &data) override
    {
        return record({QStringLiteral("writeFile"), filePath, QString(), data});
    }

    bool renameOver(const QString &fromPath, const QString &toPath) override
    {
        return record({QStringLiteral("renameOver"), fromPath, toPath, QByteArray()});
    }

    bool readFile(const QString &filePath, QByteArray *out) override
    {
        calls.append({QStringLiteral("readFile"), filePath, QString(), QByteArray()});
        if (!readOk)
            return false;
        if (out)
            *out = content;
        return true;
    }

    QStringList names() const
    {
        QStringList result;
        for (const Call &call : calls)
            result << call.name;
        return result;
    }

    // Whether any write named this path as its target (the real file must only ever be renamed onto).
    bool wroteTo(const QString &path) const
    {
        for (const Call &call : calls) {
            if (call.name == QLatin1String("writeFile") && call.first == path)
                return true;
        }
        return false;
    }

private:
    bool record(const Call &call)
    {
        calls.append(call);
        return !failing.contains(call.name);
    }
};

} // namespace

// After every operation the file holds exactly what the web's localStorage holds under 'yh.editorDrafts' for the
// same operations (seed = what is in the file first, null = no file). ops: "s key data now" | "c key" | "e days now" |
// "l key" (tab-separated). The trace after s / c / e is the stored value (<none> = no file); after l, the loaded data.
void EditorDraftStoreTest::writesTheWebsStorageValue_data()
{
    QTest::addColumn<QString>("seed");
    QTest::addColumn<QStringList>("ops");
    QTest::addColumn<QStringList>("trace");

    QTest::newRow("B01 web it: save then load (missing key is null)")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"t\"}\t1000"), QStringLiteral("l\ta"), QStringLiteral("l\tnone")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}"), QStringLiteral("=> {\"title\":\"t\"}"), QStringLiteral("=> null")};
    QTest::newRow("B02 web it: several keys apart")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"A\"}\t1000"), QStringLiteral("s\tb\t{\"title\":\"B\"}\t2000"), QStringLiteral("l\ta"), QStringLiteral("l\tb")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"A\"},\"savedAt\":1000}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"A\"},\"savedAt\":1000},\"b\":{\"data\":{\"title\":\"B\"},\"savedAt\":2000}}"), QStringLiteral("=> {\"title\":\"A\"}"), QStringLiteral("=> {\"title\":\"B\"}")};
    QTest::newRow("B03 web it: overwrite keeps the position")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"old\"}\t1000"), QStringLiteral("s\tb\t{\"title\":\"B\"}\t1500"), QStringLiteral("s\ta\t{\"title\":\"new\"}\t2000"), QStringLiteral("l\ta")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"old\"},\"savedAt\":1000}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"old\"},\"savedAt\":1000},\"b\":{\"data\":{\"title\":\"B\"},\"savedAt\":1500}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"new\"},\"savedAt\":2000},\"b\":{\"data\":{\"title\":\"B\"},\"savedAt\":1500}}"), QStringLiteral("=> {\"title\":\"new\"}")};
    QTest::newRow("B04 web it: clear one key")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"t\"}\t1000"), QStringLiteral("s\tb\t{\"title\":\"u\"}\t1000"), QStringLiteral("c\ta"), QStringLiteral("l\ta"), QStringLiteral("l\tb")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000},\"b\":{\"data\":{\"title\":\"u\"},\"savedAt\":1000}}"), QStringLiteral("{\"b\":{\"data\":{\"title\":\"u\"},\"savedAt\":1000}}"), QStringLiteral("=> null"), QStringLiteral("=> {\"title\":\"u\"}")};
    QTest::newRow("B05 web it: expire past the retention")
        << QString()
        << QStringList{QStringLiteral("s\told\t{\"title\":\"O\"}\t1000"), QStringLiteral("s\tfresh\t{\"title\":\"F\"}\t86401000"), QStringLiteral("e\t1\t172801000"), QStringLiteral("l\told"), QStringLiteral("l\tfresh")}
        << QStringList{QStringLiteral("{\"old\":{\"data\":{\"title\":\"O\"},\"savedAt\":1000}}"), QStringLiteral("{\"old\":{\"data\":{\"title\":\"O\"},\"savedAt\":1000},\"fresh\":{\"data\":{\"title\":\"F\"},\"savedAt\":86401000}}"), QStringLiteral("{\"fresh\":{\"data\":{\"title\":\"F\"},\"savedAt\":86401000}}"), QStringLiteral("=> null"), QStringLiteral("=> {\"title\":\"F\"}")};
    QTest::newRow("B06 web it: expire boundary keeps")
        << QString()
        << QStringList{QStringLiteral("s\tedge\t{\"title\":\"E\"}\t1000"), QStringLiteral("e\t1\t86401000"), QStringLiteral("l\tedge")}
        << QStringList{QStringLiteral("{\"edge\":{\"data\":{\"title\":\"E\"},\"savedAt\":1000}}"), QStringLiteral("{\"edge\":{\"data\":{\"title\":\"E\"},\"savedAt\":1000}}"), QStringLiteral("=> {\"title\":\"E\"}")};
    QTest::newRow("B07 clear on an empty store writes nothing")
        << QString()
        << QStringList{QStringLiteral("c\ta"), QStringLiteral("l\ta")}
        << QStringList{QStringLiteral("<none>"), QStringLiteral("=> null")};
    QTest::newRow("B08 expire on an empty store writes nothing")
        << QString()
        << QStringList{QStringLiteral("e\t1\t172801000")}
        << QStringList{QStringLiteral("<none>")};
    QTest::newRow("B09 clear of an absent key writes nothing")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"t\"}\t1000"), QStringLiteral("c\tb"), QStringLiteral("l\ta")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}"), QStringLiteral("=> {\"title\":\"t\"}")};
    QTest::newRow("B10 expire that removes nothing writes nothing")
        << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}")
        << QStringList{QStringLiteral("e\t1\t1000")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}")};
    QTest::newRow("B11 seeded entries: add, overwrite, clear the middle")
        << QStringLiteral("{\"a\":{\"data\":{\"title\":\"A\"},\"savedAt\":1},\"b\":{\"data\":{\"title\":\"B\"},\"savedAt\":2}}")
        << QStringList{QStringLiteral("s\tc\t{\"title\":\"C\"}\t3"), QStringLiteral("s\ta\t{\"title\":\"A2\"}\t4"), QStringLiteral("c\tb"), QStringLiteral("l\ta"), QStringLiteral("l\tc")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"A\"},\"savedAt\":1},\"b\":{\"data\":{\"title\":\"B\"},\"savedAt\":2},\"c\":{\"data\":{\"title\":\"C\"},\"savedAt\":3}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"A2\"},\"savedAt\":4},\"b\":{\"data\":{\"title\":\"B\"},\"savedAt\":2},\"c\":{\"data\":{\"title\":\"C\"},\"savedAt\":3}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"A2\"},\"savedAt\":4},\"c\":{\"data\":{\"title\":\"C\"},\"savedAt\":3}}"), QStringLiteral("=> {\"title\":\"A2\"}"), QStringLiteral("=> {\"title\":\"C\"}")};
    QTest::newRow("B12 array-index keys come first ascending")
        << QString()
        << QStringList{QStringLiteral("s\tb\t{\"title\":\"b\"}\t1"), QStringLiteral("s\t10\t{\"title\":\"10\"}\t2"), QStringLiteral("s\t2\t{\"title\":\"2\"}\t3"), QStringLiteral("s\ta\t{\"title\":\"a\"}\t4"), QStringLiteral("l\t10")}
        << QStringList{QStringLiteral("{\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":1}}"), QStringLiteral("{\"10\":{\"data\":{\"title\":\"10\"},\"savedAt\":2},\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":1}}"), QStringLiteral("{\"2\":{\"data\":{\"title\":\"2\"},\"savedAt\":3},\"10\":{\"data\":{\"title\":\"10\"},\"savedAt\":2},\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":1}}"), QStringLiteral("{\"2\":{\"data\":{\"title\":\"2\"},\"savedAt\":3},\"10\":{\"data\":{\"title\":\"10\"},\"savedAt\":2},\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":1},\"a\":{\"data\":{\"title\":\"a\"},\"savedAt\":4}}"), QStringLiteral("=> {\"title\":\"10\"}")};
    QTest::newRow("B13 junk entries are kept verbatim")
        << QStringLiteral("{\"x\":5,\"y\":{\"savedAt\":9000000000000000},\"z\":null,\"w\":{\"data\":\"str\",\"savedAt\":1000},\"q\":{\"data\":{\"title\":\"Q\"}}}")
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"A\"}\t172801000"), QStringLiteral("l\tq"), QStringLiteral("l\ty"), QStringLiteral("l\tz"), QStringLiteral("l\tx"), QStringLiteral("c\tx"), QStringLiteral("e\t1\t172801000"), QStringLiteral("l\tq")}
        << QStringList{QStringLiteral("{\"x\":5,\"y\":{\"savedAt\":9000000000000000},\"z\":null,\"w\":{\"data\":\"str\",\"savedAt\":1000},\"q\":{\"data\":{\"title\":\"Q\"}},\"a\":{\"data\":{\"title\":\"A\"},\"savedAt\":172801000}}"), QStringLiteral("=> {\"title\":\"Q\"}"), QStringLiteral("=> null"), QStringLiteral("=> null"), QStringLiteral("=> null"), QStringLiteral("{\"y\":{\"savedAt\":9000000000000000},\"z\":null,\"w\":{\"data\":\"str\",\"savedAt\":1000},\"q\":{\"data\":{\"title\":\"Q\"}},\"a\":{\"data\":{\"title\":\"A\"},\"savedAt\":172801000}}"), QStringLiteral("{\"y\":{\"savedAt\":9000000000000000},\"z\":null,\"q\":{\"data\":{\"title\":\"Q\"}},\"a\":{\"data\":{\"title\":\"A\"},\"savedAt\":172801000}}"), QStringLiteral("=> {\"title\":\"Q\"}")};
    QTest::newRow("B14 saved times as numbers")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"a\"}\t0"), QStringLiteral("s\tb\t{\"title\":\"b\"}\t-1"), QStringLiteral("s\tc\t{\"title\":\"c\"}\t1730000000000"), QStringLiteral("s\td\t{\"title\":\"d\"}\t9007199254740991")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"a\"},\"savedAt\":0}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"a\"},\"savedAt\":0},\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":-1}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"a\"},\"savedAt\":0},\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":-1},\"c\":{\"data\":{\"title\":\"c\"},\"savedAt\":1730000000000}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"a\"},\"savedAt\":0},\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":-1},\"c\":{\"data\":{\"title\":\"c\"},\"savedAt\":1730000000000},\"d\":{\"data\":{\"title\":\"d\"},\"savedAt\":9007199254740991}}")};
    QTest::newRow("B15 all fourteen fields in the web order")
        << QString()
        << QStringList{QStringLiteral("s\tAKR1\t{\"title\":\"제목\",\"body\":\"{\\\"format\\\":\\\"yh-editor\\\",\\\"version\\\":1,\\\"blocks\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"제목\\\"},{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"(끝)\\\"}]}\",\"author\":\"홍길동\",\"embargoAt\":\"2026-11-01T09:00\",\"secondEmbargoAt\":\"\",\"coAuthor\":\"김기자\",\"region\":\"서울\",\"category\":\"정치\",\"attribute\":\"일반\",\"keyword\":\"선거,투표\",\"internalComment\":\"내부\",\"externalComment\":\"외부\",\"attachmentFile\":\"/uploads/a.png\",\"referenceFile\":\"/uploads/b.pdf\"}\t1730000000000"), QStringLiteral("l\tAKR1")}
        << QStringList{QStringLiteral("{\"AKR1\":{\"data\":{\"title\":\"제목\",\"body\":\"{\\\"format\\\":\\\"yh-editor\\\",\\\"version\\\":1,\\\"blocks\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"제목\\\"},{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"(끝)\\\"}]}\",\"author\":\"홍길동\",\"embargoAt\":\"2026-11-01T09:00\",\"secondEmbargoAt\":\"\",\"coAuthor\":\"김기자\",\"region\":\"서울\",\"category\":\"정치\",\"attribute\":\"일반\",\"keyword\":\"선거,투표\",\"internalComment\":\"내부\",\"externalComment\":\"외부\",\"attachmentFile\":\"/uploads/a.png\",\"referenceFile\":\"/uploads/b.pdf\"},\"savedAt\":1730000000000}}"), QStringLiteral("=> {\"title\":\"제목\",\"body\":\"{\\\"format\\\":\\\"yh-editor\\\",\\\"version\\\":1,\\\"blocks\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"제목\\\"},{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"(끝)\\\"}]}\",\"author\":\"홍길동\",\"embargoAt\":\"2026-11-01T09:00\",\"secondEmbargoAt\":\"\",\"coAuthor\":\"김기자\",\"region\":\"서울\",\"category\":\"정치\",\"attribute\":\"일반\",\"keyword\":\"선거,투표\",\"internalComment\":\"내부\",\"externalComment\":\"외부\",\"attachmentFile\":\"/uploads/a.png\",\"referenceFile\":\"/uploads/b.pdf\"}")};
    QTest::newRow("B16 non-ASCII and escapes in the data")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"한글 \U0001F600\",\"body\":\"line1\\r\\nline2\\t\\\"q\\\"\\\\ \u2028 \\u0001 a\\ud800b\"}\t1000"), QStringLiteral("l\ta")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"한글 \U0001F600\",\"body\":\"line1\\r\\nline2\\t\\\"q\\\"\\\\ \u2028 \\u0001 a\\ud800b\"},\"savedAt\":1000}}"), QStringLiteral("=> {\"title\":\"한글 \U0001F600\",\"body\":\"line1\\r\\nline2\\t\\\"q\\\"\\\\ \u2028 \\u0001 a\\ud800b\"}")};
    QTest::newRow("B17 the new tab key and the legacy key")
        << QString()
        << QStringList{QStringLiteral("s\tw-fixed:tab-1\t{\"title\":\"N\"}\t1000"), QStringLiteral("s\ttab-1\t{\"title\":\"O\"}\t1000"), QStringLiteral("c\tw-fixed:tab-1"), QStringLiteral("l\ttab-1")}
        << QStringList{QStringLiteral("{\"w-fixed:tab-1\":{\"data\":{\"title\":\"N\"},\"savedAt\":1000}}"), QStringLiteral("{\"w-fixed:tab-1\":{\"data\":{\"title\":\"N\"},\"savedAt\":1000},\"tab-1\":{\"data\":{\"title\":\"O\"},\"savedAt\":1000}}"), QStringLiteral("{\"tab-1\":{\"data\":{\"title\":\"O\"},\"savedAt\":1000}}"), QStringLiteral("=> {\"title\":\"O\"}")};
    QTest::newRow("B18 duplicate keys: the last value at the first position")
        << QStringLiteral("{\"a\":{\"data\":{\"title\":\"1\"},\"savedAt\":1},\"b\":{\"data\":{\"title\":\"B\"},\"savedAt\":1},\"a\":{\"data\":{\"title\":\"2\"},\"savedAt\":2}}")
        << QStringList{QStringLiteral("l\ta"), QStringLiteral("s\tc\t{\"title\":\"C\"}\t3"), QStringLiteral("l\ta")}
        << QStringList{QStringLiteral("=> {\"title\":\"2\"}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"2\"},\"savedAt\":2},\"b\":{\"data\":{\"title\":\"B\"},\"savedAt\":1},\"c\":{\"data\":{\"title\":\"C\"},\"savedAt\":3}}"), QStringLiteral("=> {\"title\":\"2\"}")};
    QTest::newRow("B19 pretty-printed seed is untouched until a write")
        << QStringLiteral("{\n  \"a\": {\n    \"data\": {\"title\": \"\\uD55C\"},\n    \"savedAt\": 1000\n  }\n}")
        << QStringList{QStringLiteral("c\tnone"), QStringLiteral("l\ta"), QStringLiteral("s\tb\t{\"title\":\"B\"}\t2000")}
        << QStringList{QStringLiteral("{\n  \"a\": {\n    \"data\": {\"title\": \"\\uD55C\"},\n    \"savedAt\": 1000\n  }\n}"), QStringLiteral("=> {\"title\":\"한\"}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"한\"},\"savedAt\":1000},\"b\":{\"data\":{\"title\":\"B\"},\"savedAt\":2000}}")};
    QTest::newRow("B20 zero and negative retention")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"a\"}\t4999"), QStringLiteral("s\tb\t{\"title\":\"b\"}\t5000"), QStringLiteral("s\tc\t{\"title\":\"c\"}\t86405000"), QStringLiteral("e\t0\t5000"), QStringLiteral("e\t-1\t5000")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"a\"},\"savedAt\":4999}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"a\"},\"savedAt\":4999},\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":5000}}"), QStringLiteral("{\"a\":{\"data\":{\"title\":\"a\"},\"savedAt\":4999},\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":5000},\"c\":{\"data\":{\"title\":\"c\"},\"savedAt\":86405000}}"), QStringLiteral("{\"b\":{\"data\":{\"title\":\"b\"},\"savedAt\":5000},\"c\":{\"data\":{\"title\":\"c\"},\"savedAt\":86405000}}"), QStringLiteral("{\"c\":{\"data\":{\"title\":\"c\"},\"savedAt\":86405000}}")};
    QTest::newRow("B21 toString and constructor are plain keys once stored")
        << QString()
        << QStringList{QStringLiteral("s\ttoString\t{\"title\":\"x\"}\t1"), QStringLiteral("s\tconstructor\t{\"title\":\"y\"}\t2"), QStringLiteral("l\ttoString"), QStringLiteral("c\ttoString"), QStringLiteral("l\tconstructor")}
        << QStringList{QStringLiteral("{\"toString\":{\"data\":{\"title\":\"x\"},\"savedAt\":1}}"), QStringLiteral("{\"toString\":{\"data\":{\"title\":\"x\"},\"savedAt\":1},\"constructor\":{\"data\":{\"title\":\"y\"},\"savedAt\":2}}"), QStringLiteral("=> {\"title\":\"x\"}"), QStringLiteral("{\"constructor\":{\"data\":{\"title\":\"y\"},\"savedAt\":2}}"), QStringLiteral("=> {\"title\":\"y\"}")};
    QTest::newRow("B22 empty data object")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{}\t1000"), QStringLiteral("l\ta")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{},\"savedAt\":1000}}"), QStringLiteral("=> {}")};
    QTest::newRow("B23 the last clear leaves an empty object")
        << QString()
        << QStringList{QStringLiteral("s\ta\t{\"title\":\"t\"}\t1000"), QStringLiteral("c\ta"), QStringLiteral("l\ta")}
        << QStringList{QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}"), QStringLiteral("{}"), QStringLiteral("=> null")};
}

void EditorDraftStoreTest::writesTheWebsStorageValue()
{
    QFETCH(QString, seed);
    QFETCH(QStringList, ops);
    QFETCH(QStringList, trace);
    QCOMPARE(ops.size(), trace.size());

    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = editor::draftFilePath(dir.path());
    if (!seed.isNull())
        QVERIFY(writeBytes(path, seed.toUtf8()));
    editor::DraftFileStore store(path);

    for (qsizetype i = 0; i < ops.size(); ++i) {
        const QStringList f = ops.at(i).split(QLatin1Char('\t'));
        QString actual;
        if (f.at(0) == QLatin1String("s") && f.size() == 4) {
            JsonValue data;
            QVERIFY2(editor::parseJson(f.at(2), &data), qPrintable(f.at(2)));
            editor::saveDraft(store, f.at(1), data, f.at(3).toLongLong());
            actual = fileText(path);
        } else if (f.at(0) == QLatin1String("c") && f.size() == 2) {
            editor::clearDraft(store, f.at(1));
            actual = fileText(path);
        } else if (f.at(0) == QLatin1String("e") && f.size() == 3) {
            editor::expireDrafts(store, f.at(1).toInt(), f.at(2).toLongLong());
            actual = fileText(path);
        } else if (f.at(0) == QLatin1String("l") && f.size() == 2) {
            actual = QStringLiteral("=> ") + shown(editor::loadDraft(store, f.at(1)));
        } else {
            QFAIL(qPrintable(QStringLiteral("bad op: ") + ops.at(i)));
        }
        if (actual != trace.at(i)) {
            QFAIL(qPrintable(QStringLiteral("op %1 (%2)\n   actual: %3\n expected: %4")
                                 .arg(i)
                                 .arg(QString(ops.at(i)).replace(QLatin1Char('\t'), QLatin1Char(' ')), actual, trace.at(i))));
        }
    }
    QVERIFY2(!QFileInfo::exists(path + QStringLiteral(".tmp")), "a temporary file was left behind");
}

// Whatever the file holds, if it is not a JSON object it is an empty store: nothing loads or lists, a clear or an
// expiry leaves the bytes alone, and the first save replaces it with a fresh object (saved = the web's result on an
// empty store - see the divergence rows).
void EditorDraftStoreTest::readsABrokenFileAsAnEmptyStore_data()
{
    QTest::addColumn<QByteArray>("seed");
    QTest::addColumn<QString>("saved");

    QTest::newRow("C01 empty file")
        << QByteArray("", 0) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C02 not JSON")
        << QByteArray("not json", 8) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C03 truncated object")
        << QByteArray("{\"a\":{\"data\":{\"title\":\"t\"}", 26) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C04 null")
        << QByteArray("null", 4) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C05 number")
        << QByteArray("5", 1) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C06 string")
        << QByteArray("\"s\"", 3) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C07 true")
        << QByteArray("true", 4) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C08 trailing garbage")
        << QByteArray("{\"a\":1} x", 9) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C09 trailing comma")
        << QByteArray("{\"a\":1,}", 8) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C10 single quotes")
        << QByteArray("{'a':1}", 7) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    // C11 empty array (divergence: the web loses the save): the web leaves "[]" - the draft is lost there
    QTest::newRow("C11 empty array (divergence: the web loses the save)")
        << QByteArray("[]", 2) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    // C12 array of numbers (divergence: the web loses the save): the web leaves "[1,2]" - the draft is lost there
    QTest::newRow("C12 array of numbers (divergence: the web loses the save)")
        << QByteArray("[1,2]", 5) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C13 invalid UTF-8 (no web analog)")
        << QByteArray("\xff""\xfe""{}", 4) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C14 lone continuation byte inside a string (no web analog)")
        << QByteArray("{\"a\":{\"data\":{\"title\":\"\x80""\"},\"savedAt\":1}}", 40) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C15 CESU-8 surrogate bytes (no web analog)")
        << QByteArray("{\"\xed""\xa0""\x80""\":1}", 9) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
    QTest::newRow("C16 empty object (control: valid and empty)")
        << QByteArray("{}", 2) << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\"},\"savedAt\":1000}}");
}

void EditorDraftStoreTest::readsABrokenFileAsAnEmptyStore()
{
    QFETCH(QByteArray, seed);
    QFETCH(QString, saved);

    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = editor::draftFilePath(dir.path());
    QVERIFY(writeBytes(path, seed));
    editor::DraftFileStore store(path);

    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("a"))), QStringLiteral("null"));
    QCOMPARE(editor::listDrafts(store), QStringList());
    editor::clearDraft(store, QStringLiteral("a"));
    QVERIFY2(readBytes(path) == seed, "a clear rewrote a file it could not read as drafts");
    editor::expireDrafts(store, 1, qint64(9999999999LL));
    QVERIFY2(readBytes(path) == seed, "an expiry rewrote a file it could not read as drafts");

    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}), 1000);
    QCOMPARE(fileText(path), saved);
    QVERIFY(readBytes(path) == saved.toUtf8());
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("a"))), QStringLiteral("{\"title\":\"t\"}"));
}

// Every string survives the file: the bytes are the web's stored value (lone surrogates escaped the way
// JSON.stringify escapes them, everything else raw UTF-8), and a fresh store - the next run of the app - reads the
// body back code unit for code unit.
void EditorDraftStoreTest::keepsEveryStringExactly_data()
{
    QTest::addColumn<QString>("body");
    QTest::addColumn<int>("units");
    QTest::addColumn<QString>("stored");

    QTest::newRow("S01 empty")
        << QStringLiteral("") << 0 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"\"},\"savedAt\":1000}}");
    QTest::newRow("S02 canonical markup")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"본문\"},{\"type\":\"text\",\"text\":\"(끝)\"}]}") << 102 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"{\\\"format\\\":\\\"yh-editor\\\",\\\"version\\\":1,\\\"blocks\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"본문\\\"},{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"(끝)\\\"}]}\"},\"savedAt\":1000}}");
    QTest::newRow("S03 markup with whitespace")
        << QStringLiteral("{ \"format\": \"yh-editor\", \"version\": 1, \"blocks\": [ {\"type\": \"text\", \"text\": \"본문\"} ] }") << 85 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"{ \\\"format\\\": \\\"yh-editor\\\", \\\"version\\\": 1, \\\"blocks\\\": [ {\\\"type\\\": \\\"text\\\", \\\"text\\\": \\\"본문\\\"} ] }\"},\"savedAt\":1000}}");
    QTest::newRow("S04 markup with a unicode escape")
        << QStringLiteral("{\"format\":\"yh-editor\",\"version\":1,\"blocks\":[{\"type\":\"text\",\"text\":\"\\ubcf8\\ubb38\"}]}") << 83 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"{\\\"format\\\":\\\"yh-editor\\\",\\\"version\\\":1,\\\"blocks\\\":[{\\\"type\\\":\\\"text\\\",\\\"text\\\":\\\"\\\\ubcf8\\\\ubb38\\\"}]}\"},\"savedAt\":1000}}");
    QTest::newRow("S05 legacy plain text")
        << QStringLiteral("제목\n부제\n본문\n(끝)") << 12 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"제목\\n부제\\n본문\\n(끝)\"},\"savedAt\":1000}}");
    QTest::newRow("S06 CRLF")
        << QStringLiteral("A\r\nB\r\n") << 6 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"A\\r\\nB\\r\\n\"},\"savedAt\":1000}}");
    QTest::newRow("S07 leading BOM")
        << QStringLiteral("\uFEFFA") << 2 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"\uFEFFA\"},\"savedAt\":1000}}");
    QTest::newRow("S08 line and paragraph separators")
        << QStringLiteral("A\u2028B\u2029C") << 5 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"A\u2028B\u2029C\"},\"savedAt\":1000}}");
    QTest::newRow("S09 NUL and C0 controls")
        << units({0x0061, 0x0000, 0x0062, 0x0001, 0x0063, 0x001F, 0x0064}) << 7 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"a\\u0000b\\u0001c\\u001fd\"},\"savedAt\":1000}}");
    QTest::newRow("S10 DEL and C1")
        << QStringLiteral("a\u007Fb\u0085c") << 5 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"a\u007Fb\u0085c\"},\"savedAt\":1000}}");
    QTest::newRow("S11 lone high surrogate")
        << units({0x0061, 0xD800, 0x0062}) << 3 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"a\\ud800b\"},\"savedAt\":1000}}");
    QTest::newRow("S12 lone low surrogate")
        << units({0x0061, 0xDC00, 0x0062}) << 3 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"a\\udc00b\"},\"savedAt\":1000}}");
    QTest::newRow("S13 reversed pair")
        << units({0xDC00, 0xD800}) << 2 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"\\udc00\\ud800\"},\"savedAt\":1000}}");
    QTest::newRow("S14 astral pair")
        << QStringLiteral("\U0001F600\U00020BB7") << 4 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"\U0001F600\U00020BB7\"},\"savedAt\":1000}}");
    QTest::newRow("S15 quotes backslashes slash")
        << QStringLiteral("say \"hi\" \\ / \\n") << 15 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"say \\\"hi\\\" \\\\ / \\\\n\"},\"savedAt\":1000}}");
    QTest::newRow("S16 script close tag")
        << QStringLiteral("</script><!--") << 13 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"</script><!--\"},\"savedAt\":1000}}");
    QTest::newRow("S17 NFD Hangul")
        << QStringLiteral("\u1100\u1161\u11A8") << 3 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"\u1100\u1161\u11A8\"},\"savedAt\":1000}}");
    QTest::newRow("S18 replacement char")
        << QStringLiteral("\uFFFD") << 1 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"\uFFFD\"},\"savedAt\":1000}}");
    QTest::newRow("S19 trailing spaces and NBSP")
        << QStringLiteral("A \u00A0 ") << 4 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"A \u00A0 \"},\"savedAt\":1000}}");
    QTest::newRow("S20 long")
        << QStringLiteral("가나다라").repeated(2500) << 10000 << QStringLiteral("{\"a\":{\"data\":{\"title\":\"t\",\"body\":\"") + QStringLiteral("가나다라").repeated(2500) + QStringLiteral("\"},\"savedAt\":1000}}");
}

void EditorDraftStoreTest::keepsEveryStringExactly()
{
    QFETCH(QString, body);
    QFETCH(int, units);
    QFETCH(QString, stored);
    QCOMPARE(int(body.size()), units);

    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = editor::draftFilePath(dir.path());
    JsonValue data = fields({{QStringLiteral("title"), QStringLiteral("t")}});
    data.insert(QStringLiteral("body"), str(body));
    {
        editor::DraftFileStore store(path);
        editor::saveDraft(store, QStringLiteral("a"), data, 1000);
    }

    const QByteArray bytes = readBytes(path);
    QCOMPARE(QString::fromUtf8(bytes), stored);
    QVERIFY2(bytes == stored.toUtf8(), "the file is not the stored value's UTF-8");

    editor::DraftFileStore again(path);
    const std::optional<JsonValue> back = editor::loadDraft(again, QStringLiteral("a"));
    QVERIFY(back);
    const JsonValue *loaded = back->find(QStringLiteral("body"));
    QVERIFY(loaded && loaded->kind == JsonValue::Kind::String);
    QCOMPARE(int(loaded->stringValue.size()), units);
    QVERIFY2(loaded->stringValue == body, "the body came back changed");
}

// The write path is the config store's: read, make the folder, write "<file>.tmp", rename it over the file. A spy
// sees that order - an on-disk check alone could not tell it from a direct overwrite - and the bytes are the ones the
// real file system ends up with.
void EditorDraftStoreTest::replacesTheFileThroughATemporaryFile()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString folder = dir.filePath(QStringLiteral("user-data"));
    const QString path = editor::draftFilePath(folder);
    const QString temp = path + QStringLiteral(".tmp");

    SpyFileSystem fs;
    fs.readOk = false; // nothing there yet - and nothing on disk either, so it is a missing file
    editor::DraftFileStore store(path, fs);
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}), 1000);

    QCOMPARE(fs.names(), (QStringList{QStringLiteral("readFile"), QStringLiteral("makeDirectory"),
                                      QStringLiteral("writeFile"), QStringLiteral("renameOver")}));
    QCOMPARE(fs.calls.at(0).first, path);
    QCOMPARE(fs.calls.at(1).first, QDir::cleanPath(folder));
    QCOMPARE(fs.calls.at(2).first, temp);
    QCOMPARE(fs.calls.at(3).first, temp);
    QCOMPARE(fs.calls.at(3).second, path);
    QVERIFY(!fs.wroteTo(path));

    QTemporaryDir realDir;
    QVERIFY(realDir.isValid());
    const QString realPath = editor::draftFilePath(realDir.path());
    editor::DraftFileStore onDisk(realPath);
    editor::saveDraft(onDisk, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}), 1000);
    QCOMPARE(fs.calls.at(2).data, readBytes(realPath));

    // A clear of a present key goes the same way ...
    fs.calls.clear();
    fs.readOk = true;
    fs.content = readBytes(realPath);
    editor::clearDraft(store, QStringLiteral("a"));
    editor::clearDraft(onDisk, QStringLiteral("a"));
    QCOMPARE(fs.names(), (QStringList{QStringLiteral("readFile"), QStringLiteral("makeDirectory"),
                                      QStringLiteral("writeFile"), QStringLiteral("renameOver")}));
    QCOMPARE(fs.calls.at(2).first, temp);
    QCOMPARE(fs.calls.at(2).data, readBytes(realPath));
    QVERIFY(!fs.wroteTo(path));

    // ... and a clear of a key that is not there only reads.
    fs.calls.clear();
    fs.content = readBytes(realPath);
    editor::clearDraft(store, QStringLiteral("zzz"));
    QCOMPARE(fs.names(), QStringList{QStringLiteral("readFile")});
}

// A file that is there but cannot be read (locked, no permission) is never written over: a save would otherwise
// replace every other draft with the one being saved. Nothing loads, nothing lists, and the bytes stay.
void EditorDraftStoreTest::writesNothingOverAFileItCannotRead()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = editor::draftFilePath(dir.path());
    const QByteArray original = QByteArrayLiteral("{\"a\":{\"data\":{\"title\":\"A\"},\"savedAt\":1000}}");
    QVERIFY(writeBytes(path, original));

    SpyFileSystem fs;
    fs.readOk = false; // the file is there; reading it fails
    editor::DraftFileStore store(path, fs);
    editor::saveDraft(store, QStringLiteral("b"), fields({{QStringLiteral("title"), QStringLiteral("B")}}), 2000);
    editor::clearDraft(store, QStringLiteral("a"));
    editor::expireDrafts(store, 1, 1000 + 2 * DAY);
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("a"))), QStringLiteral("null"));
    QCOMPARE(editor::listDrafts(store), QStringList());

    QVERIFY(!fs.calls.isEmpty());
    for (const SpyFileSystem::Call &call : fs.calls)
        QCOMPARE(call.name, QStringLiteral("readFile"));
    QVERIFY(readBytes(path) == original);
}

// A write that fails at any step is silence: nothing escapes - the store itself or the functions above it - the
// steps after the failing one never run, and the file itself is never the target of a write.
void EditorDraftStoreTest::survivesAFailingWrite_data()
{
    QTest::addColumn<QString>("failing");
    QTest::addColumn<QStringList>("calls");

    QTest::newRow("makeDirectory fails") << QStringLiteral("makeDirectory")
                                         << QStringList{QStringLiteral("readFile"), QStringLiteral("makeDirectory")};
    QTest::newRow("writeFile fails") << QStringLiteral("writeFile")
                                     << QStringList{QStringLiteral("readFile"), QStringLiteral("makeDirectory"),
                                                    QStringLiteral("writeFile")};
    QTest::newRow("renameOver fails") << QStringLiteral("renameOver")
                                      << QStringList{QStringLiteral("readFile"), QStringLiteral("makeDirectory"),
                                                     QStringLiteral("writeFile"), QStringLiteral("renameOver")};
}

void EditorDraftStoreTest::survivesAFailingWrite()
{
    QFETCH(QString, failing);
    QFETCH(QStringList, calls);

    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = editor::draftFilePath(dir.path());
    SpyFileSystem fs;
    fs.readOk = true;
    fs.content = QByteArrayLiteral("{}");
    fs.failing.insert(failing);
    editor::DraftFileStore store(path, fs);

    QVERIFY2(!escapes([&] { store.save(QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}), 1000); }),
             "DraftFileStore::save threw");
    QCOMPARE(fs.names(), calls);
    fs.calls.clear();
    QVERIFY2(!escapes([&] {
                 editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}),
                                   1000);
             }),
             "saveDraft threw");
    QCOMPARE(fs.names(), calls);
    QVERIFY(!fs.wroteTo(path));
    QVERIFY2(!QFileInfo::exists(path), "the spy wrote nothing - neither may anything else");
}

// No file is an empty store, and reading, clearing or expiring creates nothing - not the file, not its folder. The
// first save creates both, leaves no temporary file behind, and a second store on the path (the next run of the
// app) finds the draft.
void EditorDraftStoreTest::createsNothingUntilTheFirstSave()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString folder = dir.filePath(QStringLiteral("a/b"));
    const QString path = editor::draftFilePath(folder);
    editor::DraftFileStore store(path);
    QCOMPARE(store.filePath(), path);

    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("x"))), QStringLiteral("null"));
    QCOMPARE(editor::listDrafts(store), QStringList());
    editor::clearDraft(store, QStringLiteral("x"));
    editor::expireDrafts(store, 1, 1000 + 2 * DAY);
    QVERIFY2(!QFileInfo::exists(dir.filePath(QStringLiteral("a"))), "reading, clearing and expiring created something");

    editor::saveDraft(store, QStringLiteral("x"), fields({{QStringLiteral("title"), QStringLiteral("X")}}), 1000);
    QVERIFY(QFileInfo(path).isFile());
    QCOMPARE(QDir(folder).entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System),
             QStringList{editor::draftFileName()});

    editor::DraftFileStore again(path);
    QCOMPARE(shown(editor::loadDraft(again, QStringLiteral("x"))), QStringLiteral("{\"title\":\"X\"}"));
    QCOMPARE(editor::listDrafts(again), QStringList{QStringLiteral("x")});
}

// The drafts have a file of their own in the config's folder (decisions (5)): drafting never touches config.json,
// saving the config never touches the drafts, and an empty folder path is a store that holds nothing and writes
// nowhere.
void EditorDraftStoreTest::livesBesideTheConfigAndApartFromIt()
{
    QCOMPARE(editor::draftFileName(), QStringLiteral("editor-drafts.json"));
    QVERIFY(editor::draftFileName() != shell::configFileName());

    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString folder = dir.path();
    const QString path = editor::draftFilePath(folder);
    QCOMPARE(path, QDir::cleanPath(folder + QStringLiteral("/editor-drafts.json")));
    QCOMPARE(QFileInfo(path).absolutePath(), QFileInfo(shell::configFilePath(folder)).absolutePath());
    QCOMPARE(editor::draftFilePath(QString()), QString());
    QCOMPARE(editor::draftFilePath(QStringLiteral("   ")), QString());

    shell::ClientConfig config;
    config.serverUrl = QStringLiteral("http://127.0.0.1:3000");
    QString error;
    QVERIFY2(shell::saveConfigAtomically(folder, config, &error), qPrintable(error));
    const QByteArray configBytes = readBytes(shell::configFilePath(folder));
    const shell::ClientConfig loaded = shell::loadConfig(folder);

    editor::DraftFileStore store(path);
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("A")}}), 1000);
    editor::saveDraft(store, QStringLiteral("b"), fields({{QStringLiteral("title"), QStringLiteral("B")}}), 2000);
    editor::clearDraft(store, QStringLiteral("a"));
    editor::expireDrafts(store, 1, 1000 + DAY);
    QVERIFY2(readBytes(shell::configFilePath(folder)) == configBytes, "drafting changed config.json");
    QVERIFY(shell::loadConfig(folder) == loaded);
    QCOMPARE(QDir(folder).entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System, QDir::Name),
             (QStringList{shell::configFileName(), editor::draftFileName()}));

    const QByteArray draftBytes = readBytes(path);
    QVERIFY2(shell::saveConfigAtomically(folder, config, &error), qPrintable(error));
    QVERIFY2(readBytes(path) == draftBytes, "saving the config changed the drafts");
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("b"))), QStringLiteral("{\"title\":\"B\"}"));

    SpyFileSystem fs;
    editor::DraftFileStore nowhere(editor::draftFilePath(QString()), fs);
    editor::saveDraft(nowhere, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("A")}}), 1000);
    editor::clearDraft(nowhere, QStringLiteral("a"));
    QCOMPARE(shown(editor::loadDraft(nowhere, QStringLiteral("a"))), QStringLiteral("null"));
    QCOMPARE(editor::listDrafts(nowhere), QStringList());
    QVERIFY2(fs.calls.isEmpty(), qPrintable(fs.names().join(QStringLiteral(", "))));
}

// A directory where the file should be cannot be read, so it is never written over: every call is quiet - the store's
// own members included - nothing loads, and nothing new appears next to it.
void EditorDraftStoreTest::survivesADirectoryWhereTheFileShouldBe()
{
    QTemporaryDir dir;
    QVERIFY(dir.isValid());
    const QString path = editor::draftFilePath(dir.path());
    QVERIFY(QDir().mkpath(path));
    editor::DraftFileStore store(path);

    QVERIFY(!escapes([&] { store.save(QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}), 1); }));
    QVERIFY(!escapes([&] { (void)store.load(QStringLiteral("a")); }));
    QVERIFY(!escapes([&] { store.remove(QStringLiteral("a")); }));
    QVERIFY(!escapes([&] { (void)store.keys(); }));
    editor::saveDraft(store, QStringLiteral("a"), fields({{QStringLiteral("title"), QStringLiteral("t")}}), 1000);
    editor::expireDrafts(store, 1, 1000 + 2 * DAY);
    QCOMPARE(shown(editor::loadDraft(store, QStringLiteral("a"))), QStringLiteral("null"));
    QCOMPARE(editor::listDrafts(store), QStringList());

    QVERIFY(QFileInfo(path).isDir());
    QCOMPARE(QDir(dir.path()).entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System),
             QStringList{editor::draftFileName()});
    QCOMPARE(QDir(path).entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System), QStringList());
}
