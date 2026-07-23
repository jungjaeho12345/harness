// 기업코드 변환 순수 계산 — 본문 텍스트의 종목명을 "종목명(코드)"로 태깅한다(append-only).
// DOM/window/transport/React/localStorage 비의존(simpTradConvert와 동일한 오프라인 순수 엔진).
//
// CRITICAL — 재실행 멱등성: 자동 모드가 저장·송고마다 변환하므로, 이미 "종목명(코드)"인 텍스트를 다시 변환해도
//   "종목명(코드)(코드)"로 이중 감싸지면 안 된다. 종목명 매칭 시 "바로 뒤가 이미 (자기코드)이면 태깅하지 않는" 우측
//   lookahead 가드가 그 핵심이다. expandAbbrev에는 이 lookahead가 없어 그대로 재사용하면 이중 감싸진다(전용 모듈 이유).
//
// 규칙: 최장일치 우선(긴 종목명 먼저) · 좌→우 단일 스캔 · anti-cascade(주입한 (코드)는 재스캔 안 함) ·
//   미등록 종목명 pass-through(안전측). 단어경계 요건은 두지 않는다(뉴스 관용상 조사가 붙어도 태깅).

import {
  textBlock, isTextBlock, normalizeBlocks, END_MARKER,
} from './editorContent.js';
import { COMPANY_CODES } from './companyCodeTable.js';

// 모듈 로드 시 1회: name.length 내림차순 정렬(최장일치 우선). 빈 name/code 방어 제외.
const CANDIDATES = COMPANY_CODES
  .map((c) => ({ name: String(c?.name ?? ''), code: String(c?.code ?? '') }))
  .filter((c) => c.name !== '' && c.code !== '')
  .sort((a, b) => b.name.length - a.name.length);

// 문자열의 종목명을 "종목명(코드)"로 태깅한 새 문자열을 반환.
export function convertCompanyCode(text) {
  const src = String(text ?? '');
  if (CANDIDATES.length === 0) return src;

  let out = '';
  let i = 0;
  while (i < src.length) {
    let matched = false;
    for (const { name, code } of CANDIDATES) {
      if (!src.startsWith(name, i)) continue;
      const tag = `(${code})`;
      if (src.startsWith(tag, i + name.length)) {
        // 멱등 lookahead — 이미 (자기코드)로 태깅됨. 재태깅하지 않고 종목명만 통과시킨다.
        // i는 name.length만 전진(뒤의 "(코드)"는 다음 루프에서 pass-through로 그대로 출력됨).
        out += name;
      } else {
        // 태깅: 종목명 → 종목명(코드). anti-cascade — 주입한 (코드)는 재스캔하지 않는다(SRC 기준 i 전진).
        out += name + tag;
      }
      i += name.length;
      matched = true;
      break; // 최장일치(정렬상 첫 매칭)만 취한다.
    }
    if (!matched) {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

// 블록 배열의 각 "텍스트 블록"에 convertCompanyCode를 적용한 새 블록 배열을 반환. 임베드·"(끝)" 블록은 불변.
// 반환: { blocks, changed } — changed는 어느 블록이라도 text가 바뀌었는지(부모가 no-op 판정에 사용).
export function convertCompanyCodeInBlocks(blocks) {
  const list = normalizeBlocks(blocks); // 새 배열/새 객체 — 입력 mutate 금지.
  let changed = false;
  const out = list.map((block) => {
    if (!isTextBlock(block) || String(block.text).trim() === END_MARKER) return block;
    const next = convertCompanyCode(block.text);
    if (next === block.text) return block;
    changed = true;
    return textBlock(next);
  });
  return { blocks: out, changed };
}
