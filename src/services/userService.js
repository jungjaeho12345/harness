// 사용자 서비스 — 로그인/조회 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입(userModel).
// 비밀번호(평문/해시)는 어떤 반환값에도 포함하지 않는다(news.md 보안).
// 로그인은 사용자 존재 여부와 무관하게 항상 bcrypt 비교를 1회 수행해 타이밍 차이를 줄인다.

import bcrypt from 'bcryptjs';

// 응답에 노출 가능한 사용자 필드 — password는 의도적으로 제외한다.
const SAFE_FIELDS = ['userId', 'name', 'role', 'department', 'departmentCode', 'active'];

// 사용자가 없을 때도 동일한 비용의 bcrypt 비교를 수행하기 위한 더미 해시(타이밍 공격 완화).
const DUMMY_HASH = bcrypt.hashSync('*timing-equalizer*', 10);

function sanitize(row = {}) {
  const out = {};
  for (const f of SAFE_FIELDS) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

export function createUserService({ userModel }) {
  // 아이디/비밀번호 대조 로그인. 비밀번호는 반환하지 않는다.
  // 존재하지 않는 사용자도 더미 해시로 비교해 성공/실패 경로의 소요 시간 차이를 최소화한다.
  async function login(userId, password) {
    const row = userModel.findById(userId);
    const hash = (row && row.password) || DUMMY_HASH;
    const passwordOk = await bcrypt.compare(String(password ?? ''), hash);

    if (!row || !passwordOk) return { ok: false, reason: 'invalid-credentials' };
    if (row.active === 'N') return { ok: false, reason: 'inactive' };

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
