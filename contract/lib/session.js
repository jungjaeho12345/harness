// 계약 스위트 세션/자격증명 접근 — 러너가 준비한 파일(CONTRACT_SESSIONS·CONTRACT_CREDENTIALS)만 읽는다.
// CRITICAL(decisions (22)): 케이스는 비밀번호를 모른다 — credentials(role)로 받은 값은 요청 body에만 쓰고
//   로그·리포트·에러 메시지 어디에도 넣지 마라(마스킹의 최종 방어는 record.js지만, 케이스 직접 출력도 금지).
// 로그인 예산(decisions (8)): actor/sid의 세션은 러너가 프로파일당 R/D/Z 3회 로그인으로 만든 것이다 —
//   케이스가 임의로 재로그인하면 15분/10회 레이트리밋이 무너져 다른 파일의 케이스가 429로 죽는다.

import fs from 'node:fs';

const ROLES = new Set(['R', 'D', 'Z']);
let sessionsCache;
let credentialsCache;

function assertRole(role) {
  if (!ROLES.has(role)) throw new Error(`알 수 없는 role: ${JSON.stringify(role)} — 'R'|'D'|'Z'만 유효하다.`);
}

// 러너가 세션을 준비하지 않는 프로파일(auth-negative·prod-cookie)에서 false.
export function hasSessions() {
  const file = process.env.CONTRACT_SESSIONS;
  return Boolean(file && fs.existsSync(file));
}

// 'R'|'D'|'Z' → { sid, userId, name, role, department, departmentCode } (러너 sessions.json shape).
export function actor(role) {
  assertRole(role);
  if (!hasSessions()) {
    throw new Error(
      `CONTRACT_SESSIONS가 없다 — 프로파일 '${process.env.CONTRACT_PROFILE ?? '(미설정)'}'은 러너가 세션을 준비하지 않는다. `
      + '이 프로파일의 케이스는 credentials(role)로 자격증명을 받아 POST /api/login으로 직접 세션을 얻어라(로그인 예산 규율 준수).',
    );
  }
  if (!sessionsCache) sessionsCache = JSON.parse(fs.readFileSync(process.env.CONTRACT_SESSIONS, 'utf8'));
  const session = sessionsCache[role];
  if (!session || typeof session.sid !== 'string') {
    throw new Error(`sessions 파일에 ${role} 세션이 없다 — 러너 세션 준비가 이 role을 건너뛰었는지 확인하라.`);
  }
  return session;
}

export function sid(role) {
  return actor(role).sid;
}

// 'R'|'D'|'Z' → { userId, password } (러너 credentials.json shape — 전 프로파일 공통 공급).
export function credentials(role) {
  assertRole(role);
  const file = process.env.CONTRACT_CREDENTIALS;
  if (!file || !fs.existsSync(file)) {
    throw new Error('CONTRACT_CREDENTIALS가 없다 — 케이스는 npm run test:contract(러너)로만 실행하라.');
  }
  if (!credentialsCache) credentialsCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cred = credentialsCache[role];
  if (!cred || typeof cred.userId !== 'string' || typeof cred.password !== 'string') {
    throw new Error(`credentials 파일에 ${role} 역할의 {userId, password}가 없다.`);
  }
  return { userId: cred.userId, password: cred.password };
}
