// 약어 치환 순수 계산 — 등록된 약어(짧은형→확장형)를 텍스트에서 확장한다. DOM/window/transport/React/localStorage 비의존.
// CRITICAL: 부분문자열 오확장을 막는 "단어경계 가드 + 최장일치 우선 + 단일 좌→우 스캔 + case-sensitive" 의미론을 지킨다.
//
// 의도된 보수성(트레이드오프): 이 규칙은 오확장(false positive)을 확실히 막는 대신, 조사·접미가 붙은 형태는
// 확장하지 않는다. 예) short '정부' → '행정부'(앞이 단어문자) 미확장(정확), '정부가'(뒤가 단어문자) 미확장(보수적).
// 뉴스 편집에서 본문 파손(오확장)이 미확장보다 위험하므로 안전 우선을 택한다. 조사 결합 확장이 필요하면
// 사용자가 해당 형태를 별도 등록하거나 조사 앞에서 변환한다.

import {
  textBlock, isTextBlock, normalizeBlocks, END_MARKER,
} from './editorContent.js';

// 유니코드 단어문자(문자/숫자/밑줄) — 단어경계 판정 기준.
const WORD_CHAR = /[\p{L}\p{N}_]/u;

function isWordChar(ch) {
  return typeof ch === 'string' && WORD_CHAR.test(ch);
}

// 문자열 text 안의 약어를 확장한 새 문자열을 반환. pairs: { short, long }[].
export function expandAbbrev(text, pairs) {
  const src = String(text ?? '');
  if (!Array.isArray(pairs)) return src;

  // 후보 목록: short 빈값 제외(방어), short.length 내림차순 안정 정렬(최장일치 우선, tie는 원순서 유지).
  const candidates = pairs
    .map((p) => ({ short: String(p?.short ?? ''), long: String(p?.long ?? '') }))
    .filter((c) => c.short !== '')
    .sort((a, b) => b.short.length - a.short.length);
  if (candidates.length === 0) return src;

  let out = '';
  let i = 0;
  while (i < src.length) {
    let matched = false;
    for (const { short, long } of candidates) {
      if (!src.startsWith(short, i)) continue;
      const j = i + short.length;
      const leftOk = i === 0 || !isWordChar(src[i - 1]) || !isWordChar(short[0]);
      const rightOk = j === src.length || !isWordChar(src[j]) || !isWordChar(short[short.length - 1]);
      if (leftOk && rightOk) {
        out += long; // 치환 결과는 재스캔하지 않는다(anti-cascade).
        i = j;
        matched = true;
        break;
      }
    }
    if (!matched) {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

// 블록 배열의 각 "텍스트 블록"에 expandAbbrev를 적용한 새 블록 배열을 반환. 임베드·"(끝)" 블록은 불변.
// 반환: { blocks, changed } — changed는 어느 블록이라도 text가 바뀌었는지(부모 no-op 판정용).
// 확장된 줄의 정렬(align) 필드는 승계한다(무 align 블록은 키 미생성 — textBlock 계약).
export function expandAbbrevInBlocks(blocks, pairs) {
  const list = normalizeBlocks(blocks); // 새 배열/새 객체 — 입력 mutate 금지.
  let changed = false;
  const out = list.map((block) => {
    if (!isTextBlock(block) || String(block.text).trim() === END_MARKER) return block;
    const next = expandAbbrev(block.text, pairs);
    if (next === block.text) return block;
    changed = true;
    return textBlock(next, block.align);
  });
  return { blocks: out, changed };
}
