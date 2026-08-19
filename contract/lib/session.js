// 계약 스위트 세션/자격증명 접근 — 러너가 준비한 파일(CONTRACT_SESSIONS·CONTRACT_CREDENTIALS)을 읽고,
//   케이스가 파괴한 공용 세션을 republish로 되돌린다.
// CRITICAL(decisions (22)): 케이스는 비밀번호를 모른다 — credentials(role)로 받은 값은 요청 body에만 쓰고
//   로그·리포트·에러 메시지 어디에도 넣지 마라(마스킹의 최종 방어는 record.js지만, 케이스 직접 출력도 금지).
// 로그인 예산(decisions (8)): actor/sid의 세션은 러너가 프로파일당 R/D/Z 3회 로그인으로 만든 것이다 —
//   케이스가 임의로 재로그인하면 15분/10회 레이트리밋이 무너져 다른 파일의 케이스가 429로 죽는다.
// CRITICAL(공용 세션 복구 규약 — 단일 세션 정책): 서버는 로그인 시 같은 userId의 기존 세션을 전부 무효화한다.
//   그래서 **로그인하는 케이스는 그 역할의 공용 세션을 반드시 복구한다** — 검증을 다 마친 뒤 마지막에
//   재로그인하고 republish(role, { sid, user })로 세션 파일을 갱신하라. 복구하지 않으면 뒤에 정렬되는
//   케이스 파일(별도 프로세스)이 죽은 토큰을 읽어 401로 무더기 실패한다.

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

// 러너 sessions.json의 role 항목을 새 세션으로 교체한다(로그인한 케이스의 복구 의무 — 위 CRITICAL).
//  - session: { sid, user? } — user는 로그인 응답의 user 객체(생략하면 기존 정체성 필드를 보존한다).
//  - 파일은 tmp→rename으로 원자 교체한다(뒤 파일의 다른 프로세스가 반쯤 쓰인 JSON을 읽지 않게).
//  - 프로세스 내 캐시도 함께 갱신한다(같은 파일의 뒤 케이스가 새 세션을 본다).
//  - 반환값은 없다: 토큰을 호출부로 흘리지 않는다(로그·리포트 유출 표면 제거).
export function republish(role, session = {}) {
  assertRole(role);
  const file = process.env.CONTRACT_SESSIONS;
  if (!hasSessions()) {
    throw new Error(
      `CONTRACT_SESSIONS가 없다 — 프로파일 '${process.env.CONTRACT_PROFILE ?? '(미설정)'}'은 러너가 세션을 준비하지 않는다. `
      + '공용 세션이 없으므로 복구할 것도 없다(republish는 러너가 세션을 공급하는 프로파일 전용이다).',
    );
  }
  const nextSid = session.sid;
  // 값은 절대 메시지에 담지 않는다 — 타입/공백 여부만 말한다.
  if (typeof nextSid !== 'string' || nextSid.trim() === '') {
    throw new Error(`republish(${role})에는 새 세션 토큰 { sid: string }이 필요하다(받은 타입: ${typeof nextSid}).`);
  }
  if (!sessionsCache) sessionsCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  const prev = sessionsCache[role] ?? {};
  const user = session.user ?? {};
  const next = {
    sid: nextSid,
    userId: user.userId ?? prev.userId,
    name: user.name ?? prev.name,
    role: user.role ?? prev.role ?? role,
    department: user.department ?? prev.department,
    departmentCode: user.departmentCode ?? prev.departmentCode,
  };
  const merged = { ...sessionsCache, [role]: next };
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  fs.renameSync(tmp, file); // 원자 교체(Windows도 기존 파일을 덮어쓴다).
  sessionsCache = merged;
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
