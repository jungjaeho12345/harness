// 간↔번 변환 순수 계산 — 본문 텍스트의 중국어를 문자단위로 치환한다. DOM/window/transport/React/localStorage 비의존.
// direction: 'toTrad'(간체→번체) | 'toSimp'(번체→간체). 그 외 값은 원문 그대로 반환(방어).
// 미매핑 문자는 원문 유지(pass-through). 표는 완전하지 않다(simpTradTable 주석 참조).

import {
  textBlock, isTextBlock, normalizeBlocks, END_MARKER,
} from './editorContent.js';
import { SIMP_TRAD_PAIRS } from './simpTradTable.js';

export const DIRECTIONS = Object.freeze({ TO_TRAD: 'toTrad', TO_SIMP: 'toSimp' });

// 모듈 로드 시 1회 두 방향 Map을 만든다(매 호출 재구성 금지). 1:多는 먼저 나열된 것 우선(first-wins).
const SIMP_TO_TRAD = new Map();
const TRAD_TO_SIMP = new Map();
for (const pair of SIMP_TRAD_PAIRS) {
  const simp = pair && pair[0];
  const trad = pair && pair[1];
  if (typeof simp !== 'string' || typeof trad !== 'string') continue;
  if (!SIMP_TO_TRAD.has(simp)) SIMP_TO_TRAD.set(simp, trad); // first-wins(최빈 우선)
  if (!TRAD_TO_SIMP.has(trad)) TRAD_TO_SIMP.set(trad, simp);
}

// 문자열 text를 direction 방향으로 변환한 새 문자열을 반환.
export function convertSimpTrad(text, direction) {
  const src = String(text ?? '');
  let map;
  if (direction === DIRECTIONS.TO_TRAD) map = SIMP_TO_TRAD;
  else if (direction === DIRECTIONS.TO_SIMP) map = TRAD_TO_SIMP;
  else return src; // 방향 방어 — 죽지 않고 원문 반환.

  let out = '';
  // 코드포인트 단위 순회(surrogate-safe) — 미매핑은 원문 유지.
  for (const ch of src) {
    out += map.get(ch) ?? ch;
  }
  return out;
}

// 블록 배열의 각 "텍스트 블록"에 convertSimpTrad를 적용한 새 블록 배열을 반환. 임베드·"(끝)" 블록은 불변.
// 반환: { blocks, changed } — changed는 어느 블록이라도 text가 바뀌었는지(부모가 no-op 판정에 사용).
export function convertSimpTradInBlocks(blocks, direction) {
  const list = normalizeBlocks(blocks); // 새 배열/새 객체 — 입력 mutate 금지.
  let changed = false;
  const out = list.map((block) => {
    if (!isTextBlock(block) || String(block.text).trim() === END_MARKER) return block;
    const next = convertSimpTrad(block.text, direction);
    if (next === block.text) return block;
    changed = true;
    return textBlock(next);
  });
  return { blocks: out, changed };
}
