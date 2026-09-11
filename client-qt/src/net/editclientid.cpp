#include "net/editclientid.h"

#include <QUuid>

namespace net {

QString issueEditClientId()
{
    // QUuid::createUuid() is a random (version 4) UUID; toString() spells it in lowercase hex like
    // crypto.randomUUID(). The canonical's time+counter fallback exists only for browsers without
    // crypto - Qt always has a random source, so there is no second format.
    return QStringLiteral("c-") + QUuid::createUuid().toString(QUuid::WithoutBraces);
}

EditClientId::EditClientId() : m_value(issueEditClientId()) {}

QString EditClientId::value() const
{
    return m_value;
}

} // namespace net
