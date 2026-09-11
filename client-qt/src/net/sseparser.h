#ifndef CLIENT_QT_NET_SSEPARSER_H
#define CLIENT_QT_NET_SSEPARSER_H

// The SSE frame parser - bytes in, events out (phase 77 step9 A). Pure: no network, no event loop,
// no knowledge of the vocabulary. ChangeStream feeds it and decides what an event means.
//
// The wire contract is docs/api-contract/sse.md 32-36: a frame is "event: <name>" + "data: <json>"
// + a BLANK LINE, LF line ends, no id:/retry:. The canonical client has no parser of its own - the
// browser's EventSource did this work invisibly (net port spec sse R10) - so the rules below are the
// WHATWG event-stream rules that EventSource applied for it:
//   - incremental: a read may end anywhere (mid-line, mid-frame, between a CR and its LF); one read
//     may carry half a frame or three and a half. Nothing here assumes one frame per read.
//   - an event goes out only at its blank line; a frame cut off before it is never dispatched
//     (sse.md 35 CRITICAL - and at the end of a stream the unfinished frame is dropped, not flushed)
//   - no event line -> "message"; several data lines join with LF; one space after ':' is dropped
//   - a frame without a data line dispatches nothing and forgets its event name
//   - comments (':'), id:, retry: and unknown fields are ignored
//   - CRLF and a lone CR are accepted as line ends. The contract says LF; accepting the other two is
//     what the browser does, and being stricter would swallow every frame behind a proxy that
//     rewrites line ends - the unauthorized frame included, which is sse.md 35's failure mode.
// Not handled: a leading UTF-8 BOM (the server never writes one).

#include <QByteArray>
#include <QString>
#include <QVector>

namespace net {

struct SseEvent {
    QString name;     // "message" when the frame had no event line
    QByteArray data;  // the data lines joined with '\n', UTF-8 bytes, no trailing '\n'
};

class SseParser
{
public:
    // Every event completed by these bytes, in order. An unfinished line or frame is kept.
    QVector<SseEvent> feed(const QByteArray &chunk);
    // Forget everything unfinished (a new connection starts clean).
    void reset();

private:
    void takeLine(QVector<SseEvent> *out);
    void dispatch(QVector<SseEvent> *out);

    QByteArray m_line;         // the current line, without its line end
    bool m_pendingCr = false;  // the last byte was a CR: an LF right after it ends no new line
    QByteArray m_eventName;
    QByteArray m_data;         // every data value + '\n'
};

} // namespace net

#endif // CLIENT_QT_NET_SSEPARSER_H
