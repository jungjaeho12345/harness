// 사용자 서비스 — 로그인/조회 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입(userModel).
// 비밀번호(평문/해시)는 어떤 반환값에도 포함하지 않는다(news.md 보안).
// 로그인은 사용자 존재 여부와 무관하게 항상 bcrypt 비교를 1회 수행해 타이밍 차이를 줄인다.
// now는 주입 가능한 시계(sessionService 패턴) — Date.now() 직접 호출 금지(테스트 결정성).

import bcrypt from 'bcryptjs';

// 응답에 노출 가능한 사용자 필드 — password·잠금 메타는 의도적으로 제외한다.
const SAFE_FIELDS = ['userId', 'name', 'role', 'department', 'departmentCode', 'active'];

// 사용자가 없을 때도 동일한 비용의 bcrypt 비교를 수행하기 위한 더미 해시(타이밍 공격 완화).
const DUMMY_HASH = bcrypt.hashSync('*timing-equalizer*', 10);

function sanitize(row = {}) {
  const out = {};
  for (const f of SAFE_FIELDS) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

export function createUserService({
  userModel,
  now = () => Date.now(),
  maxFailedAttempts = 5,
  lockDurationMs = 15 * 60 * 1000,
}) {
  // 아이디/비밀번호 대조 로그인. 비밀번호는 반환하지 않는다.
  // 존재하지 않는 사용자도 더미 해시로 비교해 성공/실패 경로의 소요 시간 차이를 최소화한다.
  async function login(userId, password) {
    const row = userModel.findById(userId);
    const hash = (row && row.password) || DUMMY_HASH;
    const passwordOk = await bcrypt.compare(String(password ?? ''), hash);

    if (!row) return { ok: false, reason: 'invalid-credentials' };

    // 잠금 우선 검사 — 유효한 잠금이면 비밀번호 결과와 무관하게 거부(잠금 연장 없음).
    if (row.lockedUntil && now() < new Date(row.lockedUntil).getTime()) {
      return { ok: false, reason: 'locked' };
    }

    // 비활성 계정 — passwordOk 분기 전에 배치하여 잠금 카운터를 쌓지 않는다.
    if (row.active === 'N') return { ok: false, reason: 'inactive' };

    if (!passwordOk) {
      const count = (parseInt(row.failedLoginCount, 10) || 0) + 1;
      const patch = {
        failedLoginCount: String(count),
        lastFailedLoginAt: new Date(now()).toISOString(),
      };
      if (count >= maxFailedAttempts) {
        patch.lockedUntil = new Date(now() + lockDurationMs).toISOString();
      }
      userModel.update(userId, patch);
      return { ok: false, reason: 'invalid-credentials' };
    }

    // 로그인 성공 — 잠금/카운터 리셋(행 삭제 없음, DB 비파괴).
    userModel.update(userId, { failedLoginCount: '0', lockedUntil: null });
    return { ok: true, user: sanitize(row) };
  }

  // 정제된 사용자 목록(비밀번호 제외).
  function query(filters) {
    return userModel.query(filters).map(sanitize);
  }

  // 사용자 생성 — 비밀번호는 bcrypt 해시로 저장하고, 반환값엔 비밀번호를 담지 않는다.
  function create(dto = {}) {
    const { password, ...rest } = dto;
    const row = {
      ...rest,
      password: bcrypt.hashSync(String(password ?? ''), 10),
      active: rest.active ?? 'Y',
    };
    userModel.insert(row);
    return { ok: true, user: sanitize(row) };
  }

  // 사용자 수정 — 비밀번호가 오면 해시로 저장한다(없으면 그대로 둠). 비밀번호는 반환하지 않는다.
  function update(userId, fields = {}) {
    const patch = { ...fields };
    if (patch.password !== undefined) patch.password = bcrypt.hashSync(String(patch.password), 10);
    const changes = userModel.update(userId, patch);
    return { ok: true, changes };
  }

  return { login, query, create, update };
}
