// 사용자 서비스 — 로그인/조회 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입(userModel).
// 비밀번호(평문/해시)는 어떤 반환값에도 포함하지 않는다(news.md 보안).
// 로그인은 사용자 존재 여부와 무관하게 항상 bcrypt 비교를 1회 수행해 타이밍 차이를 줄인다.

import bcrypt from 'bcryptjs';

// 응답에 노출 가능한 사용자 필드 — password 및 잠금 상태(failedLoginCount/lockedUntil/
// lastFailedLoginAt)는 의도적으로 제외한다(계정 열거 단서 차단).
const SAFE_FIELDS = ['userId', 'name', 'role', 'department', 'departmentCode', 'active'];

// 계정 잠금 기본 정책 — IP 단위 레이트리밋과 보완 관계인 사용자 단위 누적 실패 잠금.
const DEFAULT_LOCKOUT_THRESHOLD = 5;
const DEFAULT_LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

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
  lockoutThreshold = DEFAULT_LOCKOUT_THRESHOLD,
  lockoutWindowMs = DEFAULT_LOCKOUT_WINDOW_MS,
}) {
  // 아이디/비밀번호 대조 로그인. 비밀번호는 반환하지 않는다.
  // 존재하지 않는 사용자도 더미 해시로 비교해 성공/실패 경로의 소요 시간 차이를 최소화한다.
  // 잠긴 계정도 비밀번호 비교를 1회 수행해 잠금/비잠금 간 소요 시간 차이를 만들지 않는다.
  async function login(userId, password) {
    const row = userModel.findById(userId);
    const hash = (row && row.password) || DUMMY_HASH;
    // 잠긴 경우에도 bcrypt 비교를 1회 수행해 성공/실패/잠금 경로의 소요 시간 차이를 줄인다.
    const passwordOk = await bcrypt.compare(String(password ?? ''), hash);

    // 비활성 거부는 잠금 판정·카운트보다 우선한다(비활성 계정에 카운트를 올리지 않는다).
    if (row && row.active === 'N') return { ok: false, reason: 'inactive' };

    // 자격이 틀리면 실패 카운트를 누적하고 임계치 도달 시 잠근다.
    if (!row || !passwordOk) {
      if (row) registerFailure(row);
      return { ok: false, reason: 'invalid-credentials' };
    }

    // 잠금 만료는 lockedUntil을 주입 시계와 비교해 판정한다(행 삭제 없음).
    if (isLocked(row)) return { ok: false, reason: 'locked' };

    // 성공 — 잠금 카운트/잠금 시각을 리셋해 영속한다.
    resetLockout(row);
    return { ok: true, user: sanitize(row) };
  }

  // lockedUntil이 현재 시각보다 미래이면 잠긴 것으로 본다.
  function isLocked(row) {
    const until = Number(row.lockedUntil);
    return Number.isFinite(until) && until > now();
  }

  // 실패 1회 누적 — 임계치 이상이면 lockedUntil을 설정한다.
  function registerFailure(row) {
    const next = (Number(row.failedLoginCount) || 0) + 1;
    const patch = { failedLoginCount: String(next), lastFailedLoginAt: String(now()) };
    if (next >= lockoutThreshold) patch.lockedUntil = String(now() + lockoutWindowMs);
    userModel.update(row.userId, patch);
  }

  // 성공/만료 시 카운트·잠금 상태를 초기화한다(비파괴: 행은 유지, 필드만 비움).
  function resetLockout(row) {
    userModel.update(row.userId, {
      failedLoginCount: '0', lockedUntil: '', lastFailedLoginAt: '',
    });
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
