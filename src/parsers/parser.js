// 수집(자동기사) 파서 진입점 — 수신 payload에서 제목·본문을 추출한다.
// 결과 계약: parse(payload) -> { title, content }.
// 현재는 기본 포맷만 처리한다(defaultParser). 포맷별 분기가 필요해지면 이 계층에서 선택한다.

import { parse as defaultParse } from './defaultParser.js';

export function parse(payload) {
  return defaultParse(payload);
}
