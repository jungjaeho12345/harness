// 작성 페이지 본문(markupVersion) 편집 헬퍼 — transport 비의존 순수 함수.
// 에디터에서 타이핑된 텍스트와 기존 임베드를 합쳐 정규 순서(본문 텍스트 → 임베드 → "(끝)")로 직렬화한다.
// 이미지/영상/글기사 검색 결과를 본문에 임베드로 덧붙이는 것도 같은 정규 순서를 유지한다.

import {
  deserialize, serialize, textBlock,
  blocksToText, END_MARKER,
} from './editorContent.js';

// 본문 문자열에서 첫 줄(=제목)을 도출한다(블록 → 텍스트 → 첫 줄).
export function bodyTitle(body) {
  const text = blocksToText(deserialize(body));
  return (text.split('\n')[0] ?? '').trim();
}

// 에디터가 읽어 보낸 블록(텍스트 + 임베드)을 본문 문자열로 직렬화한다.
// 임베드는 커서/DOM 순서를 그대로 보존하고(news.md 156·167행), "(끝)" 마커만 항상 최종 블록으로 보낸다(news.md 159행).
export function serializeBodyFromBlocks(blocks) {
  const list = deserialize(blocks); // 배열/문자열/객체 모두 정규화
  const isEnd = (b) => b.type === 'text' && String(b.text).trim() === END_MARKER;
  const hasEnd = list.some(isEnd);
  const rest = list.filter((b) => !isEnd(b));
  if (hasEnd) rest.push(textBlock(END_MARKER));
  return serialize(rest);
}

// 임베드를 본문 블록 배열의 blockIndex 위치에 삽입한다(커서 위치 임베딩 — news.md 156행).
// blockIndex가 유효 범위를 벗어나면 끝(끝 마커 앞)에 덧붙인다. "(끝)"은 항상 최종 블록으로 유지.
export function insertEmbedIntoBody(currentBody, embed, blockIndex) {
  if (!embed) return currentBody;
  const blocks = deserialize(currentBody);
  if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex > blocks.length) {
    return appendEmbedToBody(currentBody, embed);
  }
  const next = blocks.slice();
  next.splice(blockIndex, 0, embed);
  return serializeBodyFromBlocks(next);
}

// 검색 결과 임베드를 본문에 덧붙인다(텍스트 뒤, "(끝)" 앞). embed가 없으면 본문 그대로.
export function appendEmbedToBody(currentBody, embed) {
  if (!embed) return currentBody;
  const blocks = deserialize(currentBody);
  const endIdx = blocks.findIndex((b) => b.type === 'text' && String(b.text).trim() === END_MARKER);
  if (endIdx >= 0) {
    const next = blocks.slice();
    next.splice(endIdx, 0, embed); // "(끝)" 앞에 삽입.
    return serialize(next);
  }
  return serialize([...blocks, embed]);
}
