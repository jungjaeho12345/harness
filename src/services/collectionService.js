// 수집(자동기사) 서비스 — 수신 → 분석(parse) → 등록 파이프라인 (HTTP/FTP 비의존, ADR-006).
// 두 수집 경로: (1) receive — FTP watcher/HTTP가 payload를 밀어넣는 push, (2) pull — 등록된 API 소스를
// 서버가 능동 호출해 응답을 가져오는 방식(rcv.md "API 호출 후 응답 분석"). fetchFn은 주입형(테스트는 네트워크 없이).
// CRITICAL: 등록되지 않은 sourceId는 수신하지 않는다(rcv.md 수신 명세).
// CRITICAL: 등록 기사는 Contents.attribute에 '자동기사'를 반드시 기록한다(rcv.md 규칙).

import { parse as defaultParse } from '../parsers/parser.js';

const AUTO_ATTRIBUTE = '자동기사';

// API 응답 본문을 파서가 처리할 형태로 만든다 — JSON이면 객체로, 아니면 평문 그대로(parser가 양쪽 처리).
function decodeBody(text) {
  if (typeof text !== 'string') return text;
  try { return JSON.parse(text); } catch { return text; }
}

// 분석된 제목/본문을 에디터 본문(markupVersion) 블록 JSON으로 만든다.
// 본문은 markupVersion에만 저장한다(PRD: 평문 content 컬럼 미사용). 첫 줄이 제목이다(에디터 규칙).
function toMarkup(title, content) {
  const body = [title, content].filter((s) => s !== undefined && s !== null && s !== '').join('\n');
  const blocks = body.split('\n').map((text) => ({ type: 'text', text }));
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

export function createCollectionService({
  articleService, receiverConfigModel, parser = { parse: defaultParse }, fetchFn = globalThis.fetch,
}) {
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

  // 능동 수집(pull) — 등록된 활성 API 소스(apiEndpoint)를 호출해 응답을 분석·등록한다(rcv.md).
  // 외부 호출은 주입된 fetchFn으로 한다(테스트는 가짜 주입). 실패는 throw 없이 graceful 거부한다(news.md).
  async function pull(sourceId) {
    const configs = receiverConfigModel.query({ sourceId });
    if (!configs || configs.length === 0) return { ok: false, reason: 'unregistered' };
    const cfg = configs.find(
      (c) => (c.active ?? 'Y') !== 'N' && c.type === 'API' && c.apiEndpoint,
    );
    if (!cfg) return { ok: false, reason: 'no-active-api-source' };

    let payload;
    try {
      const init = cfg.apiKey ? { headers: { Authorization: `Bearer ${cfg.apiKey}` } } : undefined;
      const res = await fetchFn(cfg.apiEndpoint, init);
      if (!res || !res.ok) return { ok: false, reason: 'fetch-failed' };
      payload = decodeBody(await res.text());
    } catch {
      return { ok: false, reason: 'fetch-failed' };
    }
    // 분석·등록은 receive 재사용(등록·활성 재확인 → 파싱 → attribute=자동기사로 create).
    return receive(sourceId, payload);
  }

  return { receive, pull };
}
