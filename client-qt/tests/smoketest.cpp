#include "smoketest.h"

#include <QString>
#include <QStringList>
#include <QtTest>

void SmokeTest::toolchainIsCpp17And64Bit()
{
    // "if constexpr" is C++17 - this file does not compile under /std:c++14, so the
    // CONFIG += c++17 line in common.pri is locked by compilation itself.
    if constexpr (sizeof(void *) == 8) {
        QVERIFY(true);
    } else {
        QFAIL("expected a 64-bit build (HostX64/x64 toolchain)");
    }
}

void SmokeTest::qtRuntimeIsUsable()
{
    const QString target = QStringLiteral("news-client");
    QCOMPARE(target.size(), 11);
    QVERIFY(target.startsWith(QStringLiteral("news")));
    QCOMPARE(target.split(QLatin1Char('-')).size(), 2);
}
