// SSE 판정 헬퍼 — fetch 스트림을 읽어 '\n\n' 경계로 프레임을 자른다(decisions (10) — EventSource가 아니라
// fetch: 쿠키·헤더 인증을 그대로 쓸 수 있고 Node 버전 의존이 없다). 프레임 계약은 docs/api-contract/sse.md.
// 케이스 규율:
//  - **`ready` 프레임 수신 전에는 어떤 트리거(POST)도 쏘지 마라** — 구독 등록 전 신호는 유실된다(레이스).
//  - 모든 대기는 타임아웃으로 끝나고, 타임아웃은 null 반환(throw 아님) — 실패는 케이스의 단언이 표현한다.
//  - close()는 finally에서 반드시 호출하라 — 안 하면 커넥션이 남아 테스트 프로세스가 끝나지 않는다.
//  - 판정은 "유한 시간 안에 조건 프레임 도착"으로만 한다(정확 개수·순서 단언은 flake — sse.md).

import { BASE_URL } from './http.js';

// event:/data: 줄만 읽는다(id:·retry:는 서버가 쓰지 않는다 — sse.md). data 여러 줄은 '\n'으로 잇는다.
function parseFrame(text) {
  let event = 'message';
  const data = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  if (event === 'message' && data.length === 0) return null; // 주석(:)·빈 프레임 — 이벤트 아님.
  const dataStr = data.join('\n');
  let json;
  try { json = JSON.parse(dataStr); } catch { json = undefined; }
  return { event, data: dataStr, json };
}

// 반환: { status, headers, json, frames, waitFor(predicate, timeoutMs) -> frame|null, close() }.
//  - 401/403 등 스트림을 열기 전 JSON 거부(content-type이 SSE가 아님)면 본문을 다 읽어 json에 담고
//    frames는 영원히 비어 있다(waitFor는 즉시 null) — 케이스는 status·json으로 거부를 단언한다.
//  - waitFor는 순차 소비 커서를 쓴다: 매 호출은 직전 매치 다음 프레임부터 스캔한다
//    (ready 대기 → 트리거 → change 대기 순서가 자연스럽게 성립).
export async function openStream(path, { sid, headers = {}, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const h = { accept: 'text/event-stream', ...headers };
  if (sid) h['x-session-id'] = sid;

  // 접속(헤더 수신)만 타임아웃을 건다 — 스트림 수명 전체에 걸면 열린 스트림이 중간에 끊긴다.
  let settled = false;
  const headerTimer = setTimeout(() => { if (!settled) controller.abort(); }, timeoutMs);
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, { headers: h, signal: controller.signal });
  } catch (err) {
    clearTimeout(headerTimer);
    return {
      status: 0, headers: new Headers(), json: undefined, frames: [],
      error: err?.message ?? String(err),
      waitFor: async () => null,
      close() { /* 열린 커넥션 없음 */ },
    };
  } finally {
    settled = true;
  }
  clearTimeout(headerTimer);

  const frames = [];
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    // 스트림 전 거부(401/403 JSON 등) — 유한 본문이므로 끝까지 읽는다.
    let json;
    try { json = JSON.parse(await res.text()); } catch { json = undefined; }
    return {
      status: res.status, headers: res.headers, json, frames,
      waitFor: async () => null,
      close() { try { controller.abort(); } catch { /* 이미 종료 */ } },
    };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const waiters = new Set();
  let buffer = '';
  let ended = false;
  const notify = () => { for (const wake of [...waiters]) wake(); };

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = parseFrame(buffer.slice(0, idx));
          buffer = buffer.slice(idx + 2);
          if (frame) frames.push(frame);
        }
        notify();
      }
    } catch { /* close()의 abort 또는 서버 종료 — waitFor가 null로 끝난다 */ }
    finally { ended = true; notify(); }
  })();

  let cursor = 0;
  async function waitFor(predicate, ms = timeoutMs) {
    const deadline = Date.now() + ms;
    for (;;) {
      while (cursor < frames.length) {
        const frame = frames[cursor];
        cursor += 1;
        if (predicate(frame)) return frame;
      }
      const remain = deadline - Date.now();
      if (ended || remain <= 0) return null; // 타임아웃/종료는 null — throw 아님(케이스가 단언으로 표현).
      await new Promise((resolve) => {
        const wake = () => { waiters.delete(wake); clearTimeout(timer); resolve(); };
        const timer = setTimeout(wake, Math.min(remain, 250)); // 조건 폴링 상한 — 고정 sleep 금지 규율.
        waiters.add(wake);
      });
    }
  }

  function close() {
    try { controller.abort(); } catch { /* 이미 종료 */ }
    reader.cancel().catch(() => { /* 취소 경합 — 무해 */ });
  }

  return { status: res.status, headers: res.headers, json: undefined, frames, waitFor, close };
}
