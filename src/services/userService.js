// 사용자 서비스 — 로그인/조회 도메인 로직 (HTTP 비의존, ADR-006). 의존성은 주입(userModel).
// 비밀번호(평문/해시)는 어떤 반환값에도 포함하지 않는다(news.md 보안).
// 로그인은 사용자 존재 여부와 무관하게 항상 bcrypt 비교를 1회 수행해 타이밍 차이를 줄인다.

import bcrypt from 'bcryptjs';

// 응답에 노출 가능한 사용자 필드 — password 및 계정잠금 내부필드(failedLoginCount/lockedUntil)는
// 의도적으로 제외한다(정보 누출 방지 — 계정 존재/잠금 임박 여부를 노출하지 않는다).
const SAFE_FIELDS = ['userId', 'name', 'role', 'department', 'departmentCode', 'active'];

// 계정 잠금 정책 (account-lockout).
// news.md에 계정 단위 구체 수치가 없어 보수적 기본값을 한 곳에 상수로 둔다:
//   연속 실패 5회 → 15분 자동 해제. 영구 잠금(관리자 해제)은 별도 해제 경로가 필요해 범위를 키우므로
//   시간 경과 자동 해제를 채택한다(lockedUntil 한 컬럼으로 단순화 — 별도 플래그 불요).
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

// 사용자가 없을 때도 동일한 비용의 bcrypt 비교를 수행하기 위한 더미 해시(타이밍 공격 완화).
const DUMMY_HASH = bcrypt.hashSync('*timing-equalizer*', 10);

function sanitize(row = {}) {
  const out = {};
  for (const f of SAFE_FIELDS) if (row[f] !== undefined) out[f] = row[f];
  return out;
}

export function createUserService({ userModel, now = () => Date.now() }) {
  // 아이디/비밀번호 대조 로그인. 비밀번호는 반환하지 않는다.
  // 존재하지 않는 사용자도 더미 해시로 비교해 성공/실패 경로의 소요 시간 차이를 최소화한다.
  // 계정 잠금: 연속 실패가 임계치에 도달하면 lockedUntil을 stamp하고, 그 시각까지 거부한다.
  //   잠금 판정/만료는 주입된 시계(now)로 결정적으로 한다(Date.now() 직접 호출 금지).
  async function login(userId, password) {
    const row = userModel.findById(userId);
    const hash = (row && row.password) || DUMMY_HASH;
    // 잠긴 경우에도 bcrypt 비교를 1회 수행해 성공/실패/잠금 경로의 소요 시간 차이를 줄인다.
    const passwordOk = await bcrypt.compare(String(password ?? ''), hash);

    // 잠금 검사 — 행이 있고 lockedUntil이 미래면 비밀번호 일치 여부와 무관하게 거부한다.
    if (row && row.lockedUntil && now() < Date.parse(row.lockedUntil)) {
      return { ok: false, reason: 'locked' };
    }

    if (!row || !passwordOk) {
      // 실패 시 카운터를 증가시키고 임계치 도달 시 잠근다.
      // 응답 reason은 invalid-credentials로 일관(계정 존재/잠금 임박 노출 금지 — 사용자 열거 방어).
      if (row) {
        const n = Number(row.failedLoginCount ?? '0') + 1;
        const patch = { failedLoginCount: String(n) };
        if (n >= LOCKOUT_THRESHOLD) {
          patch.lockedUntil = new Date(now() + LOCKOUT_DURATION_MS).toISOString();
        }
        userModel.update(userId, patch);
      }
      return { ok: false, reason: 'invalid-credentials' };
    }

    if (row.active === 'N') return { ok: false, reason: 'inactive' };

    // 성공: 실패 카운터를 0으로 리셋하고 잠금을 해제한다.
    if (row.failedLoginCount !== '0' || row.lockedUntil) {
      userModel.update(userId, { failedLoginCount: '0', lockedUntil: null });
    }
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
