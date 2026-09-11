#ifndef CLIENT_QT_TESTS_ROUTETABLETEST_H
#define CLIENT_QT_TESTS_ROUTETABLETEST_H

#include <QObject>

// The route table's own functions, without any file (phase 77 step8 A): path-segment encoding
// (encodeURIComponent - never the query's URLSearchParams rules), template filling, the refusal
// to spell a path that would land on another route, lookups, and the body column.
class RouteTableTest : public QObject
{
    Q_OBJECT

private slots:
    void encodesAPathSegmentLikeEncodeURIComponent_data();
    void encodesAPathSegmentLikeEncodeURIComponent();
    void fillsThePathTemplate_data();
    void fillsThePathTemplate();
    void refusesAPathThatWouldLandElsewhere_data();
    void refusesAPathThatWouldLandElsewhere();
    void findsNoForbiddenOrUnknownRoute();
    void listsTheRoutesOfAConsumer();
    void carriesABodyExactlyWhereTheCanonicalDoes();
};

#endif // CLIENT_QT_TESTS_ROUTETABLETEST_H
