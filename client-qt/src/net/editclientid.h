#ifndef CLIENT_QT_NET_EDITCLIENTID_H
#define CLIENT_QT_NET_EDITCLIENTID_H

// Edit-lock identity - "c-<uuid-v4>", one per EDITOR SURFACE (ADR-018 ③, phase 77 step7).
//
// The server keys a lock by (userId, clientId) and never looks at the session id
// (docs/news-md-overrides.md L131-132·154). One id per process - or per session, or per window -
// would make two surfaces that open the same article "the same tab re-acquiring" to the server:
// both would hold the lock and both could PUT. So the id belongs to a surface and to nothing
// wider.
//
// P4 has no editor: this step only issues ids and carries them (RequestSpec::editClientId, sent
// on exactly three routes by the transport). P5 gives each surface one EditClientId.

#include <QString>

namespace net {

// "c-" + a random (version 4) UUID, lowercase - the canonical format
// (web/src/controller/useWriteController.js:44-51, crypto.randomUUID()).
QString issueEditClientId();

// The id of one surface: issued when constructed, unchanged for its whole life. Not copyable and
// not movable - handing a copy to a second surface is exactly the collapse described above.
class EditClientId
{
public:
    EditClientId();
    EditClientId(const EditClientId &) = delete;
    EditClientId &operator=(const EditClientId &) = delete;
    EditClientId(EditClientId &&) = delete;
    EditClientId &operator=(EditClientId &&) = delete;

    QString value() const;

private:
    const QString m_value;
};

} // namespace net

#endif // CLIENT_QT_NET_EDITCLIENTID_H
