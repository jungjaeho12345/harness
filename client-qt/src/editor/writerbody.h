#ifndef CLIENT_QT_EDITOR_WRITERBODY_H
#define CLIENT_QT_EDITOR_WRITERBODY_H

// The writer page's body helpers (phase 78 step9) - the part of web/src/view/writerBody.js the edit state machine
// needs: the title a body's first line gives (bodyTitle) and the bytes an edited body is saved as
// (serializeBodyFromBlocks). Its spec, the web functions themselves run by node, lives on as tests/writerbodytest.cpp.
// The same web module's embed placement (insertEmbedAfterLine, appendEmbedToBody) is P6's (embeds), and
// textLineToBlockIndex already lives in editorcontent.h (step5).
//
// Pure: QString + the step1 block model + the step3 renormalization - no widget, no state, nothing mutates its input.

#include "editor/editorcontent.h"

#include <QString>
#include <QVector>

namespace editor {

// The title a body gives (writerBody.bodyTitle): the first line of blocksToText(deserialize(body)) with JS trim() -
// editorroles.h isJsWhitespace, the one whitespace set of the editor layer (QString::trimmed differs on U+0085 and
// U+FEFF). Embeds never count; a body without a text line gives "". Only "\n" ends a line ("\r" is whitespace).
QString bodyTitle(const QString &body);

// The bytes an edited body is saved as (writerBody.serializeBodyFromBlocks): serialize(renormalizeEndMarker(blocks)),
// every "(끝)" marker line folded into one canonical last block. step3's P3 table locks the byte equality with the web
// function; this is its one name, so the typing commit and the scenario edit cannot spell it two ways.
QString serializeBodyFromBlocks(const QVector<Block> &blocks);

} // namespace editor

#endif // CLIENT_QT_EDITOR_WRITERBODY_H
