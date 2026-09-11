#include "net/sseparser.h"

namespace net {

QVector<SseEvent> SseParser::feed(const QByteArray &chunk)
{
    QVector<SseEvent> out;
    for (const char c : chunk) {
        if (m_pendingCr) {
            m_pendingCr = false;
            if (c == '\n')
                continue;  // the LF of a CRLF whose CR ended the previous read (or byte)
        }
        if (c == '\r') {
            takeLine(&out);
            m_pendingCr = true;
        } else if (c == '\n') {
            takeLine(&out);
        } else {
            m_line.append(c);
        }
    }
    return out;
}

void SseParser::reset()
{
    m_line.clear();
    m_pendingCr = false;
    m_eventName.clear();
    m_data.clear();
}

void SseParser::takeLine(QVector<SseEvent> *out)
{
    const QByteArray line = m_line;
    m_line.clear();

    if (line.isEmpty()) {  // the blank line: the frame is complete
        dispatch(out);
        return;
    }
    if (line.startsWith(':'))
        return;  // a comment

    const qsizetype colon = line.indexOf(':');
    const QByteArray field = colon < 0 ? line : line.left(colon);
    QByteArray value = colon < 0 ? QByteArray() : line.mid(colon + 1);
    if (value.startsWith(' '))
        value.remove(0, 1);

    if (field == "event") {
        m_eventName = value;
    } else if (field == "data") {
        m_data += value;
        m_data += '\n';
    }
    // id, retry and anything else: ignored (sse.md 36 - never sent).
}

void SseParser::dispatch(QVector<SseEvent> *out)
{
    if (m_data.isEmpty()) {  // no data line: nothing goes out, and the name does not carry over
        m_eventName.clear();
        return;
    }
    SseEvent event;
    event.name = m_eventName.isEmpty() ? QStringLiteral("message") : QString::fromUtf8(m_eventName);
    event.data = m_data.left(m_data.size() - 1);  // drop the last '\n'
    out->append(event);
    m_eventName.clear();
    m_data.clear();
}

} // namespace net
