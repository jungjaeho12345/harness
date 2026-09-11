#include "shell/singleinstance.h"

#include "shell/appidentity.h"

#include <QByteArray>
#include <QCryptographicHash>
#include <QDir>
#include <QLatin1Char>
#include <QLocalServer>
#include <QLocalSocket>

#include <QtDebug>

#ifndef Q_OS_WIN
#  error "client-qt single instance: P4 builds on Windows only (ADR-018 (1))"
#endif

#ifndef NOMINMAX
#  define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#  define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>

namespace shell {
namespace {

// A later launch gives up on the knock after this long; the lock already proved that a
// primary exists, so a missed knock costs a window that stays in the background, nothing more.
constexpr int kConnectTimeoutMs = 2000;

// One folder, one spelling: separators, "." segments and a trailing slash are normalised, and
// the case is folded because Windows paths are case-insensitive.
QString normalisedFolder(const QString &userDataDir)
{
    const QString trimmed = userDataDir.trimmed();
    if (trimmed.isEmpty())
        return QString();
    return QDir::cleanPath(QDir(QDir::fromNativeSeparators(trimmed)).absolutePath()).toCaseFolded();
}

// 64 bits of SHA-256 in hex: ASCII, fixed length, and no path characters in an OS object name.
QString digestOf(const QString &folder)
{
    return QString::fromLatin1(
        QCryptographicHash::hash(folder.toUtf8(), QCryptographicHash::Sha256).toHex().left(16));
}

} // namespace

bool operator==(const InstanceNames &lhs, const InstanceNames &rhs)
{
    return lhs.mutex == rhs.mutex && lhs.server == rhs.server;
}

bool operator!=(const InstanceNames &lhs, const InstanceNames &rhs)
{
    return !(lhs == rhs);
}

InstanceNames instanceNamesFor(const QString &userDataDir)
{
    const QString digest = digestOf(normalisedFolder(userDataDir));
    InstanceNames result;
    // "Local\" = this logon session only - the same scope Electron's lock has.
    result.mutex = QStringLiteral("Local\\") + names::singleInstanceMutex() + QLatin1Char('-') + digest;
    result.server = names::singleInstanceLocalServer() + QLatin1Char('-') + digest;
    return result;
}

InstanceGuard::~InstanceGuard() = default;

SingleInstanceGuard::SingleInstanceGuard(const InstanceNames &names, QObject *parent)
    : InstanceGuard(parent), m_names(names)
{
}

SingleInstanceGuard::~SingleInstanceGuard()
{
    if (m_server)
        m_server->close();
    if (m_mutex)
        CloseHandle(static_cast<HANDLE>(m_mutex));
}

bool SingleInstanceGuard::tryBecomePrimary()
{
    if (m_primary)
        return true;

    // The named object's existence IS the lock: whoever created it holds it for as long as its
    // handle lives. The kernel settles two simultaneous launches - exactly one creates it.
    HANDLE handle = CreateMutexW(nullptr, FALSE, reinterpret_cast<const wchar_t *>(m_names.mutex.utf16()));
    const DWORD error = GetLastError();
    if (handle && error == ERROR_ALREADY_EXISTS) {
        CloseHandle(handle);  // do not keep the holder's object alive past its own exit
        return false;
    }
    if (!handle) {
        // Neither created nor proven held by someone else (e.g. the name taken by an object of
        // another type). Starting unguarded beats refusing to start - the choice ADR-012 made for
        // the server lock. Said out loud, not silent.
        qWarning("single instance: CreateMutexW failed (error %lu) - starting without the guard",
                 static_cast<unsigned long>(error));
    }
    m_mutex = handle;
    m_primary = true;

    m_server = new QLocalServer(this);
    m_server->setSocketOptions(QLocalServer::UserAccessOption);
    // A dead holder's leftover endpoint would make listen() fail (port spec R-instance-ipc). On
    // Windows a named pipe dies with its process and this is a no-op; either way nobody alive
    // owns the name - we hold the lock.
    QLocalServer::removeServer(m_names.server);
    connect(m_server, &QLocalServer::newConnection, this, &SingleInstanceGuard::onNewConnection);
    if (!m_server->listen(m_names.server)) {
        qWarning("single instance: cannot listen on %s (%s) - later launches will not bring this "
                 "window forward",
                 qPrintable(m_names.server), qPrintable(m_server->errorString()));
    }
    return true;
}

bool SingleInstanceGuard::notifyPrimary()
{
    QLocalSocket socket;
    socket.connectToServer(m_names.server);
    if (!socket.waitForConnected(kConnectTimeoutMs))
        return false;
    // The connection is the whole message: a later launch has nothing else to say (the
    // canonical ignores the argv/cwd Electron forwards with 'second-instance').
    socket.disconnectFromServer();
    return true;
}

bool SingleInstanceGuard::isPrimary() const
{
    return m_primary;
}

InstanceNames SingleInstanceGuard::names() const
{
    return m_names;
}

void SingleInstanceGuard::onNewConnection()
{
    while (QLocalSocket *socket = m_server->nextPendingConnection()) {
        socket->abort();  // nothing is read from it - see notifyPrimary()
        socket->deleteLater();
        emit activationRequested();
    }
}

} // namespace shell
