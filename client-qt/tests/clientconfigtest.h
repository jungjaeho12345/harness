#ifndef CLIENT_QT_TESTS_CLIENTCONFIGTEST_H
#define CLIENT_QT_TESTS_CLIENTCONFIGTEST_H

#include <QObject>

// Port of the clientConfig half of test/client-shell-core.test.js (phase 77 step3). That
// file is the specification: every row below is either lifted from it or added because the
// port spec named a canonical rule that nothing locks today (C-N1..C-N4, R16) or because
// QJsonValue and JSON.parse disagree. Rows that document a deliberate divergence say so.
//
// This class is pure - it never touches the filesystem. The store half (paths, atomic
// write) lives in configstoretest.{h,cpp}.
class ClientConfigTest : public QObject
{
    Q_OBJECT

private slots:
    void parsesUnusableInputIntoDefaults_data();
    void parsesUnusableInputIntoDefaults();
    void dropsEveryKeyOutsideTheWhitelist();
    void revalidatesServerUrlWhenReading_data();
    void revalidatesServerUrlWhenReading();
    void scopesParseFailuresPerField_data();
    void scopesParseFailuresPerField();
    void acceptsStoredBoundsShape_data();
    void acceptsStoredBoundsShape();
    void rejectsStoredBoundsShape_data();
    void rejectsStoredBoundsShape();
    void ignoresTheStoredSchemaVersion();
    void serializesTheWhitelistOnly();
    void serializesDegradedInputWithoutFailing();
    void roundTripsThroughParse();
    void separatesTheShapeCheckFromTheScreenCheck();
    void sanitizesBoundsAgainstWorkAreas();
    void keepsBoundsArithmeticWithinRange();
};

#endif // CLIENT_QT_TESTS_CLIENTCONFIGTEST_H
