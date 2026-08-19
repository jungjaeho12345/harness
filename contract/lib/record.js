// 계약 리포트 기록 — 정규화·마스킹의 **유일한** 장소다(decisions (11), LOGS.md 마스킹 규율).
// 케이스가 각자 마스킹하면 언젠가 한 곳이 새어 토큰이 리포트(CI 로그·Slack 보고로 흘러나갈 수 있다)에 남는다.
// CONTRACT_REPORT_DIR에 케이스 파일당 1개의 JSONL로 append하고, 러너가 (profile, routeId, tag, caseId)로
// 정렬·병합한다 — 같은 서버 2회 실행 = 리포트 바이트 동일이 목표라, 여기 담는 값은 결정적이어야 한다.
// routeId 규칙(decisions (23)): endpoints.json의 id이거나 'x-' 접두사 — 위반은 즉시 throw한다
//   (러너 병합 단계의 어휘 검사보다 먼저, 케이스 실행 시점에 오타를 잡는다).

import fs from 'node:fs';
import nodePath from 'node:path';

// 인벤토리는 문서(JSON)라 읽어도 프레임워크 중립이 유지된다(서버 코드 import 아님).
const INVENTORY_URL = new URL('../../docs/api-contract/endpoints.json', import.meta.url);
const REDACTED = '<redacted>';

let inventoryIdsCache;
function inventoryIds() {
  if (!inventoryIdsCache) {
    const inv = JSON.parse(fs.readFileSync(INVENTORY_URL, 'utf8'));
    inventoryIdsCache = new Set((inv.routes ?? []).map((r) => r.id));
  }
  return inventoryIdsCache;
}

// 비밀번호 마스킹 대조용 — 값은 이 모듈 밖으로 절대 내보내지 않는다.
let passwordsCache;
function knownPasswords() {
  if (!passwordsCache) {
    passwordsCache = [];
    const file = process.env.CONTRACT_CREDENTIALS;
    if (file && fs.existsSync(file)) {
      try {
        for (const cred of Object.values(JSON.parse(fs.readFileSync(file, 'utf8')) ?? {})) {
          if (cred && typeof cred.password === 'string' && cred.password) passwordsCache.push(cred.password);
        }
      } catch { /* 파일 손상 — 마스킹 대조 없이 패턴 마스킹만 적용 */ }
    }
  }
  return passwordsCache;
}

// 휘발/비밀 값 마스킹 — 패턴에 하나라도 걸리면 값 전체를 '<redacted>'로 바꾼다(부분 치환보다 안전).
// 금지 목록(decisions (11)): 세션 토큰(64-hex)·업로드 hex 파일명(32-hex)·비밀번호·articleId(AKR…)·
// 타임스탬프·절대 경로·포트가 박힌 URL. 결정적인 값(불리언·상태 문자열·사유 토큰·개수)만 통과한다.
function maskValue(value) {
  if (typeof value === 'number') {
    // epoch 초/밀리초(ts·seq 계열) — 2^31 이상 정수는 휘발값으로 본다(개수·상태코드·포트 미만 값은 통과).
    return value >= 2147483648 ? REDACTED : value;
  }
  if (typeof value !== 'string') return value; // boolean·null 등은 그대로.
  for (const pw of knownPasswords()) {
    if (value.includes(pw)) return REDACTED;
  }
  if (/[0-9a-fA-F]{32}/.test(value)) return REDACTED; // 세션 토큰 64-hex·업로드 32-hex 파일명 포함 문자열.
  if (/AKR\d/.test(value)) return REDACTED; // articleId(AKR+YYYYMMDD+난수9)와 그것이 박힌 경로/문장.
  if (/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return REDACTED; // ISO/로그 타임스탬프.
  if (/^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) return REDACTED; // 절대 경로(Windows).
  if (/^https?:\/\//.test(value)) return REDACTED; // baseUrl — 포트가 박힌다.
  return value;
}

// 리포트에 실을 수 있는 응답 헤더 — 계약상 의미 있는 결정적 헤더만(decisions (11)).
// ratelimit-limit·-policy는 결정적(한도 선언)이지만 -remaining·-reset·retry-after는
// 창 잔여 시간(휘발)이라 허용하지 않는다 — 실으면 이중 실행 diff가 무의미해진다.
const ALLOWED_HEADERS = new Set([
  'content-type', 'set-cookie', 'access-control-allow-origin', 'access-control-allow-credentials',
  'cache-control', 'vary', 'ratelimit-limit', 'ratelimit-policy',
]);

// Set-Cookie 정규화 — 쿠키 값 원문은 절대 싣지 않는다(값은 '<redacted>', 빈 값 삭제 쿠키는 '이름=' 유지).
// Expires 속성은 절대 시각(휘발)이라 떨군다 — Max-Age가 같은 계약을 결정적으로 표현한다.
function normalizeSetCookie(cookieStr) {
  const [nameValue, ...attrs] = String(cookieStr).split(';').map((s) => s.trim());
  const eq = nameValue.indexOf('=');
  const name = eq === -1 ? nameValue : nameValue.slice(0, eq);
  const value = eq === -1 ? '' : nameValue.slice(eq + 1);
  const head = value === '' ? `${name}=` : `${name}=${REDACTED}`;
  const kept = attrs.filter((a) => !/^expires=/i.test(a));
  return [head, ...kept].join('; ');
}

function sortedEntries(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

// 케이스 파일명 기반 식별자 — JSONL 파일명과 caseId 접두사의 출처.
// node --test는 파일마다 자식 프로세스를 띄우므로 argv[1]이 케이스 파일 경로다(러너 --test-concurrency=1).
function caseFileBase() {
  const file = process.argv[1];
  return file ? nodePath.basename(file).replace(/\.contract\.js$/, '') : 'unknown';
}

// 응답(http.js api()의 반환) → 정규화 observation. 마스킹 규칙 내장 — 케이스는 이 함수 밖에서
// 리포트용 값을 만들지 마라. headers 옵션은 실을 헤더 이름 배열(기본 ['content-type']).
export function fromResponse(res, { values = {}, headers = ['content-type'] } = {}) {
  const body = res.json;
  const isPlainObject = body !== null && typeof body === 'object' && !Array.isArray(body);
  const observed = {};
  for (const rawName of headers) {
    const name = String(rawName).toLowerCase();
    if (!ALLOWED_HEADERS.has(name)) {
      throw new Error(`리포트에 실을 수 없는 헤더: ${name} — 허용 목록(${[...ALLOWED_HEADERS].join(', ')}) 밖이다(decisions (11)).`);
    }
    if (name === 'set-cookie') {
      const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
      observed[name] = cookies.length > 0 ? cookies.map(normalizeSetCookie).join(', ') : null;
    } else {
      observed[name] = res.headers.get(name);
    }
  }
  return {
    status: res.status,
    ok: isPlainObject && typeof body.ok === 'boolean' ? body.ok : res.ok === true,
    reason: isPlainObject && typeof body.reason === 'string' ? body.reason : null,
    bodyKeys: isPlainObject ? Object.keys(body).sort() : [],
    values,
    headers: observed,
  };
}

// observation: { status, ok, reason, bodyKeys, values, headers, caseId? } — caseId는 파일 내 로컬 라벨
// (미지정 시 tag). 최종 caseId는 '<케이스파일>/<라벨>'이다(스키마 B 예: 'health/ok').
export function record(routeId, tag, observation) {
  const reportDir = process.env.CONTRACT_REPORT_DIR;
  if (!reportDir) throw new Error('CONTRACT_REPORT_DIR이 설정되지 않았다 — 케이스는 npm run test:contract(러너)로만 실행하라.');
  if (typeof routeId !== 'string' || (!inventoryIds().has(routeId) && !routeId.startsWith('x-'))) {
    throw new Error(
      `routeId ${JSON.stringify(routeId)}는 인벤토리(docs/api-contract/endpoints.json) id도 'x-' 접두사도 아니다 `
      + '— 오타이거나 인벤토리 누락이다(오타가 커버리지를 비켜 가지 못하게 즉시 실패한다).',
    );
  }
  if (typeof tag !== 'string' || tag === '') throw new Error('tag는 비어 있지 않은 문자열이어야 한다.');
  const obs = observation ?? {};
  if (!Number.isInteger(obs.status)) throw new Error(`observation.status가 정수가 아니다: ${JSON.stringify(obs.status)}`);
  if (typeof obs.ok !== 'boolean') throw new Error(`observation.ok가 불리언이 아니다: ${JSON.stringify(obs.ok)}`);

  const base = caseFileBase();
  const label = obs.caseId === undefined ? tag : String(obs.caseId);
  const values = {};
  for (const [key, value] of Object.entries(sortedEntries(obs.values ?? {}))) values[key] = maskValue(value);
  const headersOut = {};
  for (const [key, value] of Object.entries(sortedEntries(obs.headers ?? {}))) headersOut[key] = maskValue(value);

  // 키 순서 고정(스키마 B) — 러너가 파싱한 순서 그대로 다시 직렬화하므로 여기 순서가 리포트 바이트를 정한다.
  const entry = {
    profile: process.env.CONTRACT_PROFILE ?? 'unknown',
    routeId,
    tag,
    caseId: `${base}/${label}`,
    status: obs.status,
    ok: obs.ok,
    reason: typeof obs.reason === 'string' ? obs.reason : null,
    bodyKeys: [...(obs.bodyKeys ?? [])].map(String).sort(),
    values,
    headers: headersOut,
  };
  fs.appendFileSync(nodePath.join(reportDir, `${base}.jsonl`), `${JSON.stringify(entry)}\n`);
}
