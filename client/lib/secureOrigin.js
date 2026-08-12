// LAN secure-context 스위치 판정 (phase 63 step0) — Electron·전역·파일시스템 비의존 순수 모듈.
// 스위치 적용 여부·이름·값·재시작 필요 여부의 단일 출처다 — main.js는 여기 결과를 append만 한다(재구현 금지).
// CRITICAL: 스위치 값은 new URL(입력).origin이 만든 정규화 origin "정확히 하나"다. Chromium은 이 값을
//   origin 문자열로 정확 비교하므로 비정규화 값은 조용히 매칭 실패하고, 콤마 목록·와일드카드는
//   손편집된 config 한 줄이 임의 사이트에 secure context를 부여하는 표면이라 fail-closed로 막는다.
// 적용 조건은 http + 비-loopback뿐이다 — https는 이미 secure context, loopback은 Chromium 기본 신뢰.
// enable-features는 덮어쓰지 않고 병합한다(mergeFeatureValue) — 덮어쓰면 기존 기능 플래그가 사라진다.

export const SECURE_ORIGIN_SWITCH = 'unsafely-treat-insecure-origin-as-secure';
export const FEATURE_SWITCH = 'enable-features';
export const SECURE_ORIGIN_FEATURE = 'OverrideSecurityRestrictionsOnInsecureOrigin';

// 콤마(목록)·공백(구분자)·별표(와일드카드) — 어느 하나라도 섞이면 "출처 하나" 계약 위반이다.
const UNSAFE_VALUE_RE = /[,\s*]/;

// 점4자리 127.x.x.x — startsWith('127.') 금지 규율(server/index.js isLoopbackHost와 동형):
// 127.0.0.1.evil.com 같은 접두 위장 호스트가 loopback으로 새면 스위치가 조용히 비적용된다.
const DOTTED_127_RE = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (hostname === '[::1]') return true; // URL.hostname은 IPv6를 대괄호 포함으로 준다.
  const m = DOTTED_127_RE.exec(hostname);
  if (m) return m.slice(1).every((oct) => Number(oct) <= 255);
  return false;
}

// origin이 Chromium 기본 신뢰(loopback) 대상인가 — 파싱 실패는 false(fail-closed: 모르는 값은 신뢰 아님).
export function isTrustedLocalOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return isLoopbackHostname(url.hostname);
}

// enable-features 병합 — 콤마 결합·중복 제거·빈 토큰 정리. 결선부는 이 결과 문자열을 그대로 append한다.
export function mergeFeatureValue(existingFeatures, feature) {
  const tokens = typeof existingFeatures === 'string'
    ? existingFeatures.split(',').map((t) => t.trim()).filter(Boolean)
    : [];
  if (!tokens.includes(feature)) tokens.push(feature);
  return tokens.join(',');
}

// 부팅 시 1회 판정의 단일 진입점.
// → { apply:false, reason:'no-origin'|'unsafe-value'|'invalid'|'already-secure'|'unsupported-scheme'|'loopback' }
// → { apply:true, origin, switches:[{name,value},{name,value}] } — origin과 첫 스위치 value는 같은 문자열이다.
export function decideSecureOriginSwitches(origin, { existingFeatures = '' } = {}) {
  if (typeof origin !== 'string' || !origin.trim()) return { apply: false, reason: 'no-origin' };
  if (UNSAFE_VALUE_RE.test(origin)) return { apply: false, reason: 'unsafe-value' };
  let url;
  try {
    url = new URL(origin); // origin 해석은 new URL()만 — 문자열 자르기·정규식 조립 금지(serverUrl.js 규율).
  } catch {
    return { apply: false, reason: 'invalid' };
  }
  if (url.protocol === 'https:') return { apply: false, reason: 'already-secure' };
  if (url.protocol !== 'http:') return { apply: false, reason: 'unsupported-scheme' };
  if (isLoopbackHostname(url.hostname)) return { apply: false, reason: 'loopback' };
  const normalized = url.origin; // 호스트 소문자화·기본 포트 생략·경로 제거가 적용된 값 하나.
  return {
    apply: true,
    origin: normalized,
    switches: [
      { name: SECURE_ORIGIN_SWITCH, value: normalized },
      { name: FEATURE_SWITCH, value: mergeFeatureValue(existingFeatures, SECURE_ORIGIN_FEATURE) },
    ],
  };
}

// 새 출처가 스위치를 요구하는데 부팅 때 적용한 값(appliedOrigin, 미적용은 null)과 다를 때만 true.
// appendSwitch는 ready 전 1회뿐이라 이때는 수동 재시작 안내가 유일한 경로다(자동 재시작 금지).
export function requiresRestartForOrigin(appliedOrigin, nextOrigin) {
  const next = decideSecureOriginSwitches(nextOrigin);
  return next.apply === true && next.origin !== appliedOrigin;
}
