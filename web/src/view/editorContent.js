// 에디터 본문 블록 모델 (markupVersion) — 텍스트/임베드 블록의 직렬화/역직렬화.
// CRITICAL: 본문은 항상 블록 구조로 다룬다(평문 문자열로만 저장 금지 — news.md/schema.md).
// 저장 포맷은 백엔드(src/services)와 동일하다: {format:'yh-editor',version:1,blocks:[...]}.
// 블록은 {type:'text',text} 또는 {type:'embed',embedType,...}. 평문(레거시)도 역호환 로드한다.

export const EDITOR_FORMAT = 'yh-editor';
export const EDITOR_VERSION = 1;
export const END_MARKER = '(끝)';

export function textBlock(text = '') {
  return { type: 'text', text: String(text ?? '') };
}

export function embedBlock(embed = {}) {
  return { ...embed, type: 'embed' };
}

export function isTextBlock(block) {
  return !!block && block.type === 'text';
}

export function isEmbedBlock(block) {
  return !!block && block.type === 'embed';
}

// 블록 배열을 안전한 형태로 정규화한다(알 수 없는 타입 제거, text는 문자열 강제).
export function normalizeBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  const out = [];
  for (const b of blocks) {
    if (isTextBlock(b)) out.push({ type: 'text', text: String(b.text ?? '') });
    else if (isEmbedBlock(b)) out.push({ ...b, type: 'embed' });
  }
  return out;
}

// 블록 배열 → markupVersion 문자열.
export function serialize(blocks) {
  return JSON.stringify({ format: EDITOR_FORMAT, version: EDITOR_VERSION, blocks: normalizeBlocks(blocks) });
}

// markupVersion(문자열/객체/블록배열) → 블록 배열. 평문(레거시)은 한 줄씩 텍스트 블록으로 역호환 로드.
export function deserialize(raw) {
  if (raw === null || raw === undefined || raw === '') return [];
  if (Array.isArray(raw)) return normalizeBlocks(raw);
  if (typeof raw === 'object') {
    if (Array.isArray(raw.blocks)) return normalizeBlocks(raw.blocks);
    return [];
  }
  // 문자열 — 먼저 JSON 도큐먼트로 시도.
  try {
    const doc = JSON.parse(raw);
    if (Array.isArray(doc)) return normalizeBlocks(doc);
    if (doc && Array.isArray(doc.blocks)) return normalizeBlocks(doc.blocks);
  } catch {
    // JSON 아님 — 평문 본문으로 취급.
  }
  return String(raw).split('\n').map((line) => textBlock(line));
}

// 텍스트 블록만 모아 개행으로 잇는다(구조/색상/"(끝)" 마커 판정의 기준 텍스트 — 임베드는 제외).
export function blocksToText(blocks) {
  return normalizeBlocks(blocks).filter(isTextBlock).map((b) => b.text).join('\n');
}

// 평문 텍스트 → 한 줄씩 텍스트 블록.
export function textToBlocks(text) {
  return String(text ?? '').split('\n').map((line) => textBlock(line));
}

// 본문 블록에 "(끝)" 마커가 있는지(백엔드 hasEndMarker와 동일 기준 — 텍스트 블록 기준).
export function hasEndMarker(blocks) {
  return blocksToText(blocks).includes(END_MARKER);
}
