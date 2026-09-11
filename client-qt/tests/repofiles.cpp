#include "repofiles.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>

namespace {

QString walkUp(const QString &start, const QString &relativePath, QStringList *searched)
{
    QDir dir(start);
    while (true) {
        const QString candidate = dir.filePath(relativePath);
        if (searched)
            searched->append(QDir::toNativeSeparators(dir.absolutePath()));
        if (QFileInfo(candidate).isFile())
            return QFileInfo(candidate).absoluteFilePath();
        if (!dir.cdUp())
            return QString();
    }
}

} // namespace

QString findRepoFile(const QString &relativePath, QStringList *searched)
{
    const QStringList starts{QCoreApplication::applicationDirPath(), QDir::currentPath()};
    for (const QString &start : starts) {
        const QString found = walkUp(start, relativePath, searched);
        if (!found.isEmpty())
            return found;
    }
    return QString();
}

bool readRepoFile(const QString &relativePath, QByteArray *bytes, QString *error)
{
    QStringList searched;
    const QString path = findRepoFile(relativePath, &searched);
    if (path.isEmpty()) {
        if (error)
            *error = QStringLiteral("%1 not found walking up from: %2")
                         .arg(relativePath, searched.join(QStringLiteral(" | ")));
        return false;
    }
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        if (error)
            *error = QStringLiteral("%1 found at %2 but could not be read").arg(relativePath, path);
        return false;
    }
    if (bytes)
        *bytes = file.readAll();
    return true;
}
