// 수집(자동기사) 서비스 — 수신 → 분석(parse) → 등록 파이프라인 (HTTP/FTP 비의존, ADR-006).
// 외부 FTP/네트워크는 직접 붙이지 않는다 — sourceId/payload는 호출자(watcher/HTTP)가 주입한다.
// CRITICAL: 등록되지 않은 sourceId는 수신하지 않는다(rcv.md 수신 명세).
// CRITICAL: 등록 기사는 Contents.attribute에 '자동기사'를 반드시 기록한다(rcv.md 규칙).

import { parse as defaultParse } from '../parsers/parser.js';

const AUTO_ATTRIBUTE = '자동기사';

// 분석된 제목/본문을 에디터 본문(markupVersion) 블록 JSON으로 만든다.
// 본문은 markupVersion에만 저장한다(PRD: 평문 content 컬럼 미사용). 첫 줄이 제목이다(에디터 규칙).
function toMarkup(title, content) {
  const body = [title, content].filter((s) => s !== undefined && s !== null && s !== '').join('\n');
  const blocks = body.split('\n').map((text) => ({ type: 'text', text }));
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

export function createCollectionService({ articleService, receiverConfigModel, parser = { parse: defaultParse } }) {
  // 수신 인제스트 — 등록·활성 sourceId만 받아 파싱 후 기사로 등록한다.
  function receive(sourceId, payload) {
    const configs = receiverConfigModel.query({ sourceId });
    if (!configs || configs.length === 0) return { ok: false, reason: 'unregistered' };
    const hasActive = configs.some((c) => (c.active ?? 'Y') !== 'N');
    if (!hasActive) return { ok: false, reason: 'inactive' };

    const { title, content } = parser.parse(payload);

    // 등록은 articleService.create 재사용 — status RDS, Article+Contents 트랜잭션 저장.
    return articleService.create({
      title,
      markupVersion: toMarkup(title, content),
      attribute: AUTO_ATTRIBUTE,
    });
  }

  return { receive };
}
