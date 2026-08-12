// 서버 주소 정규화 + health 응답 판정 (phase 62 step0) — Electron·전역·파일시스템 비의존 순수 모듈.
// CRITICAL: 문자열 자르기·정규식으로 origin을 직접 조립하지 않는다 — 포트 생략·IPv6·유니코드 호스트에서
// 조용히 틀린 origin이 나오고, 그 값이 동일 출처 판정(= 새 창 허용 정책)의 입력이 된다. new URL()만 쓴다.
// 네트워크 호출은 이 모듈에 없다 — 프로브 실행은 step1 메인 프로세스 책임이고, 여기는 판정만 한다.

const SCHEME_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;
const ALLOWED_SCHEMES = new Set(['http', 'https']);

// 스킴 보정 — 운영자는 "192.168.0.10:3001"처럼 IP:포트만 친다.
// "localhost:3001"은 URL 문법상 스킴처럼 보이지만, 콜론 뒤가 포트 숫자(+경로/쿼리)면 host:port로 해석한다.
// 반환: 보정된 문자열 | null(허용 밖 스킴 — unsupported-scheme).
function ensureScheme(input) {
  const m = SCHEME_RE.exec(input);
  if (!m) return `http://${input}`;
  const scheme = m[1].toLowerCase();
  if (ALLOWED_SCHEMES.has(scheme)) return input;
  const rest = input.slice(m[0].length);
  if (/^\d+([/?#]|$)/.test(rest)) return `http://${input}`; // host:port 오인 케이스.
  return null;
}

export function normalizeServerUrl(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'empty' };
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  const withScheme = ensureScheme(trimmed);
  if (withScheme === null) return { ok: false, reason: 'unsupported-scheme' };
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!ALLOWED_SCHEMES.has(url.protocol.replace(/:$/, ''))) return { ok: false, reason: 'unsupported-scheme' };
  // 자격증명이 설정 파일에 남는 표면을 만들지 않는다 — user@·user:pass@ 전부 거부.
  if (url.username || url.password) return { ok: false, reason: 'credentials' };
  if (!url.hostname) return { ok: false, reason: 'no-host' };
  // 경로·쿼리·해시는 버리고 origin만 — SPA 라우팅(/ → login.do)은 서버가 서빙하는 SPA 책임이다.
  return { ok: true, origin: url.origin };
}

export function healthUrl(origin) {
  return `${origin}/api/health`;
}

export function appUrl(origin) {
  return `${origin}/`;
}

export function isSameOrigin(url, origin) {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false; // 파싱 실패 = 동일 출처 아님(fail-closed).
  }
}

// 프로브 판정의 단일 출처(decisions (14)) — 200이라는 사실만으로는 부족하다.
// 임의의 웹 서버·사내 프록시·캡티브 포털도 200을 주므로, 본문이 { ok: true } JSON일 때만 인정한다.
// status가 null/undefined면 네트워크 자체가 실패한 경우다(호출부가 status를 못 얻음) → unreachable.
export function interpretHealthResponse({ status, body } = {}) {
  if (status === null || status === undefined) return { ok: false, reason: 'unreachable' };
  if (status !== 200) return { ok: false, reason: 'http-status' };
  const isPlainObject = typeof body === 'object' && body !== null && !Array.isArray(body);
  if (isPlainObject && body.ok === true) return { ok: true };
  return { ok: false, reason: 'not-article-server' };
}
