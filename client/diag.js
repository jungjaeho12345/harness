// 진단 JSONL 기록 (phase 62 step1) — CLIENT_DIAG_FILE이 있을 때만 append하는 검증 자동화의 단일 출처.
// 이벤트 이름·필드는 step2 verify-client.mjs의 단언 대상이다(step1 계획 8절 계약 — 바꾸지 말고 추가만).
// CRITICAL(유출 차단): 기사 본문·세션ID·쿠키·비밀번호를 절대 기록하지 않는다. URL 값은 origin+pathname
// 까지만 남긴다(쿼리·해시 제거 — 기사아이디·토큰 표면 차단). file: 스킴은 스킴+파일명만 남긴다
// (로컬 절대 경로 비노출 — 게이트 ② 확정 예외). 파일 접근은 주입 의존성(appendFileSync)뿐이다.

const FORBIDDEN_KEYS = new Set(['body', 'sessionId', 'cookie', 'cookies', 'password', 'token', 'markupVersion', 'headers']);

function redactUrl(value) {
  if (value === 'about:blank') return value; // 무해한 고정 문자열 — SPA 새 창의 정체다.
  let url;
  try {
    url = new URL(value);
  } catch {
    return value; // URL이 아니면 쿼리가 실릴 수 없다 — 그대로 둔다.
  }
  if (url.protocol === 'file:') {
    const name = url.pathname.split('/').pop();
    return `file:///${name}`;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') {
    return `${url.origin}${url.pathname}`;
  }
  return url.protocol; // 기타 스킴은 스킴만 — 내용 비노출.
}

export function redactDiagEvent(event, payload) {
  const out = {};
  if (payload === null || typeof payload !== 'object') return out;
  for (const [key, value] of Object.entries(payload)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value === undefined) continue;
    const type = typeof value;
    if (type !== 'string' && type !== 'number' && type !== 'boolean' && value !== null) continue; // 평문 필드만 — 직렬화 보장.
    out[key] = type === 'string' && key.toLowerCase().includes('url') ? redactUrl(value) : value;
  }
  return out;
}

export function formatDiagLine(event, payload, now) {
  return `${JSON.stringify({ ts: new Date(now).toISOString(), event, ...redactDiagEvent(event, payload) })}\n`;
}

// filePath가 없으면 완전 no-op — 파일을 만들지도, 주입 함수를 부르지도 않는다.
// 기록 실패(디스크 풀·권한)는 삼킨다 — 진단이 앱을 죽이면 본말전도다.
export function createDiag({ filePath, appendFileSync } = {}) {
  if (!filePath || typeof appendFileSync !== 'function') {
    return { log() {} };
  }
  return {
    log(event, payload) {
      try {
        appendFileSync(filePath, formatDiagLine(event, payload, Date.now()));
      } catch {
        // 무시 — 진단은 최선 노력이다.
      }
    },
  };
}
