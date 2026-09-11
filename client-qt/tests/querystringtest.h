#ifndef CLIENT_QT_TESTS_QUERYSTRINGTEST_H
#define CLIENT_QT_TESTS_QUERYSTRINGTEST_H

#include <QObject>

// buildQuery (phase 77 step7) - the port of web/src/model/httpModel.js:70-79.
//
// Every expected string below was produced by running the canonical function under node
// (2026-09-11), not by reading its source: URLSearchParams' encoder is exactly the kind of rule
// that is easy to misremember (it encodes '~', keeps '*', writes a space as '+').
// The canonical suite locks one row of this (httpModel.test.js:197-202 - repeated keys); the
// rest is NEW coverage.
class QueryStringTest : public QObject
{
    Q_OBJECT

private slots:
    void matchesTheCanonicalSerialisation_data();
    void matchesTheCanonicalSerialisation();
    void keepsTheCanonicalRepeatedKeyRow();
    void documentsWhyQUrlQueryIsNotUsed();
};

#endif // CLIENT_QT_TESTS_QUERYSTRINGTEST_H
