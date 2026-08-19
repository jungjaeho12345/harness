// 계약 스위트 공용 HTTP 헬퍼 — 서버는 CONTRACT_BASE_URL 하나로만 접근한다(프레임워크 중립, decisions (4)).
// CRITICAL: server/**·src/**·web/** 어떤 모듈도 import하지 않는다 — Spring 대상에서도 그대로 돌아야 한다.
// api()는 절대 throw하지 않는다(네트워크 오류도 { status: 0, error }로 정규화) — 실패는 케이스의 단언이 표현한다.
// 주의: api()는 응답 본문을 끝까지 읽는다 — SSE 라우트(GET /api/stream·/api/logs/stream)에는 쓰지 마라
//   (무한 스트림이라 영원히 끝나지 않는다). SSE는 sse.js(openStream)가 소유한다.

const raw = process.env.CONTRACT_BASE_URL;
if (!raw) {
  // 오구성 조용한 통과 금지 — 이 모듈은 계약 러너(scripts/contract-run.mjs)가 넘긴 env 아래에서만 실행된다.
  throw new Error('CONTRACT_BASE_URL이 설정되지 않았다 — 케이스는 npm run test:contract(러너)로만 실행하라.');
}
export const BASE_URL = raw.replace(/\/+$/, '');

// 반복 키 지원 쿼리 빌더: { status: ['RDS','DDH'] } → '?status=RDS&status=DDH'. 빈 입력이면 ''.
export function q(params = {}) {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) for (const item of value) sp.append(key, String(item));
    else sp.append(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

// opts: { sid, headers, body, query, raw, signal }
//  - sid: x-session-id 헤더로 보낸다(쿠키 경로는 step3의 쿠키 계약 케이스가 별도 검증).
//  - body: 기본은 JSON.stringify + content-type application/json. raw=true면 준 그대로 보낸다
//    (망가진 JSON 등 음성 케이스용 — content-type은 headers로 직접 지정하라).
// 반환: { status, ok(res.ok), json(파싱 실패 시 undefined), text(json이 없을 때만), headers(Headers) }.
export async function api(method, path, opts = {}) {
  const { sid, headers = {}, body, query, raw: rawBody = false, signal } = opts;
  const h = { ...headers };
  if (sid) h['x-session-id'] = sid;
  let payload;
  if (body !== undefined) {
    if (rawBody) payload = body;
    else {
      payload = JSON.stringify(body);
      if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) h['content-type'] = 'application/json';
    }
  }
  try {
    const res = await fetch(`${BASE_URL}${path}${query ? q(query) : ''}`, {
      method,
      headers: h,
      body: payload,
      signal: signal ?? AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    return {
      status: res.status,
      ok: res.ok,
      json,
      text: json === undefined ? text : undefined,
      headers: res.headers,
    };
  } catch (err) {
    return {
      status: 0,
      ok: false,
      json: undefined,
      text: undefined,
      headers: new Headers(),
      error: err?.message ?? String(err),
    };
  }
}
