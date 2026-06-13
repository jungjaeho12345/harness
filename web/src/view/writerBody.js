// 작성 페이지 본문(markupVersion) 편집 헬퍼 — transport 비의존 순수 함수.
// 에디터에서 타이핑된 텍스트와 기존 임베드를 합쳐 정규 순서(본문 텍스트 → 임베드 → "(끝)")로 직렬화한다.
// 이미지/영상/글기사 검색 결과를 본문에 임베드로 덧붙이는 것도 같은 정규 순서를 유지한다.

import {
  deserialize, serialize, textBlock,
  isEmbedBlock, blocksToText, END_MARKER,
} from './editorContent.js';

// 본문 문자열에서 첫 줄(=제목)을 도출한다(블록 → 텍스트 → 첫 줄).
export function bodyTitle(body) {
  const text = blocksToText(deserialize(body));
  return (text.split('\n')[0] ?? '').trim();
}

// 타이핑된 텍스트 + 기존 본문의 임베드 → 정규 순서 본문 문자열.
// "(끝)" 마커는 텍스트 중 어디에 있든 항상 임베드 뒤 최종 블록으로 보낸다(news.md 최종 시각 순서).
export function mergeTextIntoBody(currentBody, newText) {
  const embeds = deserialize(currentBody).filter(isEmbedBlock);
  const lines = String(newText ?? '').split('\n');
  const hasEnd = lines.some((l) => l.trim() === END_MARKER);
  const textLines = lines.filter((l) => l.trim() !== END_MARKER);
  const out = textLines.map((l) => textBlock(l));
  out.push(...embeds);
  if (hasEnd) out.push(textBlock(END_MARKER));
  return serialize(out);
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
