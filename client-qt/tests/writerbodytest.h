#ifndef CLIENT_QT_TESTS_WRITERBODYTEST_H
#define CLIENT_QT_TESTS_WRITERBODYTEST_H

// The writer page's body helpers (phase 78 step9 - editor/writerbody.h): bodyTitle against the web function run by
// node, and serializeBodyFromBlocks as the one spelling of serialize(renormalizeEndMarker(...)).

#include <QObject>

class WriterBodyTest : public QObject
{
    Q_OBJECT

private slots:
    void bodyTitleMatchesTheWeb_data();
    void bodyTitleMatchesTheWeb();
    void serializeBodyFromBlocksRenormalizesTheMarker();
};

#endif // CLIENT_QT_TESTS_WRITERBODYTEST_H
