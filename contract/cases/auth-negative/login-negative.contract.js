// 계약 케이스: POST /api/login 음성 경로(인벤토리 id 'login') — auth-negative 전용 프로파일.
// 동결 축: invalid-credentials 401(사용자 열거 방지) · 계정 잠금 423 locked · IP 레이트리밋 429.
//
// CRITICAL(순서가 계약이다): 이 파일은 위에서 아래로 실행돼야 한다 — 계정 잠금 카운터와 IP 레이트리밋
//   카운터를 의도적으로 소진하기 때문이다. 429가 뜨는 순간 이 프로파일의 남은 로그인은 전부 429가 되므로
//   레이트리밋 케이스는 **반드시 마지막**이다. 이 프로파일은 전용 서버 프로세스라(러너 PROFILES 표,
//   sessions:false) 카운터가 다른 프로파일·다른 파일과 격리된다 — 러너는 여기서 로그인하지 않는다.
// CRITICAL(로그인 예산): C-1 2회 + C-2 6회 = 8회를 쓰고, C-3이 남은 예산을 소진해 429를 관측한다(상한 20회).
// 규율: 비밀번호는 credentials(role)로만 받고, 틀린 비밀번호는 그 값에 접미사를 붙여 만든다(하드코딩 금지).
//   잠금 대상 계정은 R 하나로 고정한다(다른 계정을 잠그지 않는다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { credentials } from '../../lib/session.js';
import { unique } from '../../lib/fixtures.js';

requireProfile('auth-negative');

// 계약값 — 추측 금지, 코드에서 읽은 값만 적는다.
//  근거: src/services/userService.js 14행 `export const LOCKOUT_THRESHOLD = 5`(무옵션 기본값이고
//  createControllers는 lockoutPolicy를 주입하지 않는다 — src/controllers/index.js 98행).
const LOCKOUT_THRESHOLD = 5;
//  근거: server/index.js 609~614행 loginLimiter { windowMs: 15분, limit: 10 } — IP 단위.
const RATE_LIMIT = 10;
// 429 관측 상한 — 예산을 넘겨도 무한 반복하지 않는다(상한 안에서 429가 없으면 실패다).
const RATE_LIMIT_PROBE_CAP = 20;

// 잠금 대상 계정(이 파일이 잠그는 유일한 계정).
const LOCK_TARGET_ROLE = 'R';

let attempts = 0;
async function login(userId, password) {
  attempts += 1;
  return api('POST', '/api/login', { body: { userId, password } });
}

// 틀린 비밀번호 — 올바른 값에 접미사를 붙여 만든다(케이스는 비밀번호를 알지 못하고, 리포트에도 담지 않는다).
function wrong(password) {
  return `${password}-contract-wrong`;
}

test('C-1 invalid-credentials: 존재 계정의 틀린 비밀번호와 미존재 계정이 같은 401·같은 토큰이다', async () => {
  const desk = credentials('D');

  const existing = await login(desk.userId, wrong(desk.password));
  assert.equal(existing.status, 401);
  assert.deepEqual(existing.json, { ok: false, reason: 'invalid-credentials' });

  // 사용자 열거 방지 계약 — 미존재 계정도 상태·본문이 완전히 같아야 한다(응답으로 계정 존재를 알 수 없다).
  const unknown = await login(unique('ct-nouser'), wrong(desk.password));
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.json, existing.json);

  assert.equal(attempts, 2, '로그인 예산: C-1은 2회다');

  record('login', 'unauthenticated', {
    ...fromResponse(existing, { values: { account: 'existing' } }),
    caseId: 'invalid-credentials-existing-account',
  });
  record('login', 'unauthenticated', {
    ...fromResponse(unknown, { values: { account: 'unknown' } }),
    caseId: 'invalid-credentials-unknown-account',
  });
});

test('C-2 locked 423: 임계값만큼 실패하면 잠기고, 올바른 비밀번호로도 거부된다', async () => {
  const target = credentials(LOCK_TARGET_ROLE);

  // 임계값 회 실패 — 마지막(임계값째) 시도도 아직 invalid-credentials다(잠금은 그 시도에서 설정된다).
  for (let i = 1; i <= LOCKOUT_THRESHOLD; i += 1) {
    const res = await login(target.userId, wrong(target.password));
    assert.equal(res.status, 401, `${i}번째 실패는 401이어야 한다`);
    assert.equal(res.json?.reason, 'invalid-credentials', `${i}번째 실패 토큰`);
  }

  // 잠긴 계정은 **올바른 비밀번호로도** 423이다(자격 판정보다 잠금 판정이 우선).
  const locked = await login(target.userId, target.password);
  assert.equal(locked.status, 423);
  assert.deepEqual(locked.json, { ok: false, reason: 'locked' });

  assert.equal(attempts, 2 + LOCKOUT_THRESHOLD + 1, '로그인 예산: C-2까지 누적 8회다');

  record('login', 'locked', {
    ...fromResponse(locked, { values: { lockoutThreshold: LOCKOUT_THRESHOLD, withCorrectPassword: true } }),
    caseId: 'locked-after-threshold-failures',
  });
});

test('C-3 rate-limited 429: IP 한도를 넘기면 429다 (이 파일의 마지막 케이스)', async () => {
  const target = credentials(LOCK_TARGET_ROLE); // 이미 잠긴 계정 — 429 전까지는 423이라 추가 상태 변화가 없다.
  let res;
  let probes = 0;

  while (probes < RATE_LIMIT_PROBE_CAP) {
    probes += 1;
    res = await login(target.userId, wrong(target.password));
    if (res.status === 429) break;
    assert.equal(res.status, 423, `한도 이전 응답은 423이어야 한다(실제 ${res.status})`);
  }

  assert.equal(res.status, 429, `상한 ${RATE_LIMIT_PROBE_CAP}회 안에 429가 관측돼야 한다`);
  // 한도 계산 실증: 창 안에서 RATE_LIMIT회까지는 라우트가 처리하고 **그 다음 요청**이 거부된다.
  // (이 파일의 로그인 예산 표와 같은 수식이라 예산이 어긋나면 여기서 먼저 깨진다.)
  assert.equal(attempts, RATE_LIMIT + 1, `429는 창 안 ${RATE_LIMIT + 1}번째 로그인에서 나야 한다`);
  // 한도 초과는 라우트가 아니라 레이트리밋 미들웨어가 응답한다 — **본문이 JSON이 아니다**(실측).
  // "모든 거부는 {ok:false, reason}" 규칙의 유일한 예외이며, 그 예외 자체가 계약이다(클라이언트는 파싱 실패에 관대해야 한다).
  assert.equal(res.json, undefined);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  assert.equal(res.headers.get('ratelimit-limit'), String(RATE_LIMIT));

  record('login', 'rate-limited', {
    ...fromResponse(res, {
      values: { bodyIsJson: false, limit: RATE_LIMIT },
      headers: ['content-type', 'ratelimit-limit'],
    }),
    caseId: 'rate-limited-after-ip-limit',
  });
});
