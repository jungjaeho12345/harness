#ifndef CLIENT_QT_SHELL_SINGLEINSTANCE_H
#define CLIENT_QT_SHELL_SINGLEINSTANCE_H

// Single instance (phase 77 step5).
//
// Electron's app.requestSingleInstanceLock() hands out TWO things at once: an exclusive lock and
// a channel on which a second launch tells the first one "I was started" (the 'second-instance'
// event). Qt has neither (port spec R-instance-ipc), so this file builds them separately:
//   1. the lock   - a Windows named mutex. The OS drops it when the holder dies, so a crash
//                   leaves nothing stale behind (unlike a lock file).
//   2. the notice - a QLocalServer owned by the holder. A second launch connects with a
//                   QLocalSocket; the connection itself is the message.
//
// Both names are derived from the resolved user data folder (instanceNamesFor), mirroring the
// canonical, whose lock key comes from userData (client/main.js:6-7, 56-63). That is why the
// folder is resolved FIRST and the lock taken SECOND: flip the order and a harness run on a
// temporary CLIENT_USER_DATA would contend for - and activate - the real user's running client.
// The base names live in appidentity.h and are not the Electron shell's.

#include <QObject>
#include <QString>

class QLocalServer;

namespace shell {

struct InstanceNames {
    QString mutex;   // "Local\\" + base + "-" + digest
    QString server;  // base + "-" + digest (a named pipe on Windows)
};

bool operator==(const InstanceNames &lhs, const InstanceNames &rhs);
bool operator!=(const InstanceNames &lhs, const InstanceNames &rhs);

// Pure. Two spellings of the same folder (separators, a trailing slash, letter case - Windows
// paths are case-insensitive) give the same names; two folders give different names.
InstanceNames instanceNamesFor(const QString &userDataDir);

// The seam the shell talks to. The production implementation is SingleInstanceGuard; tests
// inject fakes to drive the boot branches without OS objects.
class InstanceGuard : public QObject
{
    Q_OBJECT

public:
    using QObject::QObject;
    ~InstanceGuard() override;

    // Claims the exclusive lock and starts listening for later launches. false = another
    // process (or another guard in this process) already holds it.
    virtual bool tryBecomePrimary() = 0;
    // Secondary only: tells the holder to come forward. Best effort - false when nobody answered.
    virtual bool notifyPrimary() = 0;
    virtual bool isPrimary() const = 0;
    virtual InstanceNames names() const = 0;

signals:
    // Emitted on the primary each time a later launch knocks.
    void activationRequested();
};

class SingleInstanceGuard : public InstanceGuard
{
    Q_OBJECT

public:
    explicit SingleInstanceGuard(const InstanceNames &names, QObject *parent = nullptr);
    // Releases the lock. In the app the guard lives in main() for the whole process lifetime:
    // a lock held by an object that can be dropped early is released early (the GC trap of
    // phase 65, port spec section 6 trap 10).
    ~SingleInstanceGuard() override;

    bool tryBecomePrimary() override;
    bool notifyPrimary() override;
    bool isPrimary() const override;
    InstanceNames names() const override;

private:
    void onNewConnection();

    InstanceNames m_names;
    void *m_mutex = nullptr;  // HANDLE
    QLocalServer *m_server = nullptr;
    bool m_primary = false;
};

} // namespace shell

#endif // CLIENT_QT_SHELL_SINGLEINSTANCE_H
