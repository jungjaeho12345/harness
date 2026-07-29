// embargoSchedule 순수 규칙 모듈 테스트 — "지금 이 기사에 어떤 배부가 도래했는가 / 무엇이 남았는가".
// CRITICAL: 시각 비교는 epoch(Date.parse) 기반으로만 한다. 문자열 사전식 비교는 포맷/오프셋이 섞이면
// 엠바고 시각 '전'에 도래로 판정되어 조기 반출(되돌릴 수 없는 사고)을 일으킨다 — 회귀로 잠근다.
// 존재 판정은 관대하게, 시각 파싱은 엄격하게: 쓰레기 값은 required이되 영원히 due 아님(fail-safe).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseInstant,
  isDue,
  requiredKinds,
  dueKinds,
  missingKinds,
  isComplete,
} from '../src/services/embargoSchedule.js';

test('parseInstant: 오프셋 있는 ISO는 epoch(ms number)로 파싱한다', () => {
  const z = parseInstant('2026-07-30T00:00:00.000Z');
  assert.equal(typeof z, 'number');
  assert.equal(Number.isFinite(z), true);
  assert.equal(z, Date.parse('2026-07-30T00:00:00.000Z'));
});

test('parseInstant: 같은 순간을 가리키는 다른 오프셋 표기는 같은 수를 낸다', () => {
  // +09:00 09:00 == 00:00Z — epoch로 환산하면 동일. 사전식이라면 문자열이 달라 다르게 판정된다.
  assert.equal(
    parseInstant('2026-07-30T09:00:00+09:00'),
    parseInstant('2026-07-30T00:00:00Z'),
  );
});

test('parseInstant: 오프셋 없는 값은 null(로컬 해석 방지)', () => {
  for (const bad of [
    '2026-07-30T09:00:00',
    '2026-07-30 09:00',
    '2026-07-30T09:00:00.000',
    '2026-07-30',
  ]) {
    assert.equal(parseInstant(bad), null, `null이어야 함: ${bad}`);
  }
});

test('parseInstant: 다양한 유효 오프셋 표기(z/+HHMM/-HH:MM)를 허용한다', () => {
  for (const ok of [
    '2026-07-30T00:00:00z',
    '2026-07-30T09:00:00+0900',
    '2026-07-30T00:00:00-00:00',
    '2026-07-29T19:00:00-05:00',
  ]) {
    const v = parseInstant(ok);
    assert.equal(typeof v, 'number', `number여야 함: ${ok}`);
    assert.equal(Number.isFinite(v), true, `finite여야 함: ${ok}`);
  }
});

test('parseInstant: 비문자열은 강제변환 없이 null', () => {
  for (const bad of [123, 0, null, undefined, true, false, {}, [], new Date(), Symbol('x'), 1n]) {
    assert.equal(parseInstant(bad), null, `null이어야 함: ${String(typeof bad)}`);
  }
  assert.equal(parseInstant(), null);
});

test('parseInstant: 빈 문자열/공백/쓰레기는 null', () => {
  for (const bad of ['', '   ', '\t', '내일 오후 2시', '곧', 'not-a-date', 'ZZZ']) {
    assert.equal(parseInstant(bad), null, `null이어야 함: ${JSON.stringify(bad)}`);
  }
});

test('parseInstant: 오프셋이 있어도 Date.parse가 NaN이면 null', () => {
  for (const bad of ['2026-13-40T00:00:00Z', 'foo+09:00', '+09:00']) {
    assert.equal(parseInstant(bad), null, `null이어야 함: ${bad}`);
  }
});

test('isDue: 도래 전 false, 동시각 true, 지난 시각 true', () => {
  const at = '2026-07-30T00:00:00Z';
  const t = Date.parse(at);
  assert.equal(isDue(at, t - 1), false, '1ms 전은 도래 아님');
  assert.equal(isDue(at, t), true, '동시각은 도래');
  assert.equal(isDue(at, t + 1), true, '지난 시각은 도래');
});

test('isDue: 파싱 불가 값은 false', () => {
  const now = Date.parse('2027-01-01T00:00:00Z');
  for (const bad of ['2026-07-30T09:00:00', '곧', '', 123, null, undefined, {}]) {
    assert.equal(isDue(bad, now), false, `false여야 함: ${JSON.stringify(bad)}`);
  }
});

test('isDue: nowMs가 NaN/비수면 false(도래로 흡수 금지)', () => {
  const at = '2020-01-01T00:00:00Z'; // 과거라도
  for (const badNow of [NaN, Infinity, -Infinity, '123', null, undefined, {}]) {
    assert.equal(isDue(at, badNow), false, `false여야 함: ${String(badNow)}`);
  }
});

test('사전식 함정 회귀: +09:00 09:00(=00:00Z)이고 now가 23:59:59Z(전날)이면 dueKinds는 []', () => {
  // 문자열 비교였다면 '2026-07-30T09:00:00+09:00' > '2026-07-29T23:59:59Z' 로 뒤집혀 조기 반출됐을 케이스.
  const contents = { embargoAt: '2026-07-30T09:00:00+09:00' };
  const now = Date.parse('2026-07-29T23:59:59Z');
  assert.deepEqual(dueKinds(contents, now), []);
  // 1ms 뒤(=00:00:00Z) 정확히 도래.
  assert.deepEqual(dueKinds(contents, now + 1000), ['press']);
});

test('requiredKinds: 1차만 → [press], 2차만 → [nonpress], 1+2차 → [press,nonpress]', () => {
  assert.deepEqual(requiredKinds({ embargoAt: '2026-07-30T00:00:00Z' }), ['press']);
  assert.deepEqual(requiredKinds({ secondEmbargoAt: '2026-07-30T00:00:00Z' }), ['nonpress']);
  assert.deepEqual(
    requiredKinds({ embargoAt: '2026-07-30T00:00:00Z', secondEmbargoAt: '2026-07-31T00:00:00Z' }),
    ['press', 'nonpress'],
  );
});

test('requiredKinds: 2차만 설정 기사는 press를 절대 포함하지 않는다(송고 훅이 이미 즉시 배부)', () => {
  const contents = { secondEmbargoAt: '2026-07-30T00:00:00Z' };
  assert.equal(requiredKinds(contents).includes('press'), false);
});

test('requiredKinds: 둘 다 미설정/빈문자열/공백/null/undefined → []', () => {
  for (const contents of [
    {},
    { embargoAt: null, secondEmbargoAt: undefined },
    { embargoAt: '', secondEmbargoAt: '' },
    { embargoAt: '   ', secondEmbargoAt: '\t' },
  ]) {
    assert.deepEqual(requiredKinds(contents), [], JSON.stringify(contents));
  }
});

test('requiredKinds: 관대한 존재 판정 — 쓰레기 값도 설정으로 본다(fail-safe)', () => {
  // 오프셋 없는/파싱 불가 값도 '설정됨'으로 required에 포함 → 배부 없이 완결되는 것을 막는다.
  assert.deepEqual(requiredKinds({ embargoAt: '곧' }), ['press']);
  assert.deepEqual(requiredKinds({ secondEmbargoAt: '2026-07-30T09:00:00' }), ['nonpress']);
});

test('requiredKinds: contents가 객체가 아니어도 throw 없이 []', () => {
  for (const bad of [null, undefined, 123, 'x', []]) {
    assert.deepEqual(requiredKinds(bad), [], String(bad));
  }
});

test('dueKinds: 1+2차에서 1차만 도래 → [press]', () => {
  const contents = {
    embargoAt: '2026-07-30T00:00:00Z',
    secondEmbargoAt: '2026-07-31T00:00:00Z',
  };
  const now = Date.parse('2026-07-30T12:00:00Z');
  assert.deepEqual(dueKinds(contents, now), ['press']);
});

test('dueKinds: 둘 다 도래 → [press,nonpress]', () => {
  const contents = {
    embargoAt: '2026-07-30T00:00:00Z',
    secondEmbargoAt: '2026-07-31T00:00:00Z',
  };
  const now = Date.parse('2026-08-01T00:00:00Z');
  assert.deepEqual(dueKinds(contents, now), ['press', 'nonpress']);
});

test('dueKinds: 2차만 설정 기사에서 2차 도래 → [nonpress](press 절대 미포함)', () => {
  const contents = { secondEmbargoAt: '2026-07-30T00:00:00Z' };
  const now = Date.parse('2026-08-01T00:00:00Z');
  assert.deepEqual(dueKinds(contents, now), ['nonpress']);
});

test('dueKinds: 쓰레기 엠바고 값은 required이되 절대 due 아님(fail-safe)', () => {
  const contents = { embargoAt: '곧' };
  const now = Date.parse('2030-01-01T00:00:00Z');
  assert.deepEqual(requiredKinds(contents), ['press']);
  assert.deepEqual(dueKinds(contents, now), []);
});

test('missingKinds: 배열·Set 입력 모두 동작, 순서 유지', () => {
  const contents = {
    embargoAt: '2026-07-30T00:00:00Z',
    secondEmbargoAt: '2026-07-31T00:00:00Z',
  };
  assert.deepEqual(missingKinds(contents, []), ['press', 'nonpress']);
  assert.deepEqual(missingKinds(contents, ['press']), ['nonpress']);
  assert.deepEqual(missingKinds(contents, new Set(['press'])), ['nonpress']);
  assert.deepEqual(missingKinds(contents, ['nonpress', 'press']), []);
  assert.deepEqual(missingKinds(contents, new Set(['press', 'nonpress'])), []);
});

test('missingKinds: distributedKinds가 배열/Set이 아니면 전부 미충족으로 본다', () => {
  const contents = { embargoAt: '2026-07-30T00:00:00Z' };
  for (const bad of [null, undefined, 'press', 123, {}]) {
    assert.deepEqual(missingKinds(contents, bad), ['press'], String(bad));
  }
});

test('isComplete: 전량 배부 true, 부분 배부 false', () => {
  const contents = {
    embargoAt: '2026-07-30T00:00:00Z',
    secondEmbargoAt: '2026-07-31T00:00:00Z',
  };
  assert.equal(isComplete(contents, ['press', 'nonpress']), true);
  assert.equal(isComplete(contents, new Set(['press', 'nonpress'])), true);
  assert.equal(isComplete(contents, ['press']), false);
  assert.equal(isComplete(contents, []), false);
});

test('isComplete: requiredKinds가 []면 항상 false(엠바고 컬럼 둘 다 빈 EPS는 손대지 않는다)', () => {
  assert.equal(isComplete({}, []), false);
  assert.equal(isComplete({}, ['press', 'nonpress']), false);
  assert.equal(isComplete({ embargoAt: '' }, ['press']), false);
});

test('isComplete: 쓰레기 엠바고 값은 required이되 배부 불가라 완결 false(stuck-EPS, fail-safe)', () => {
  const contents = { embargoAt: '곧' };
  assert.equal(isComplete(contents, []), false);
  // 설령 어떤 이유로 press가 배부 이력에 있어도 required는 press뿐이므로 complete가 될 수는 있으나,
  // due가 나지 않으므로 tick은 배부를 시도하지 않는다(실제 완결은 발생하지 않음). 여기선 규칙만 검증.
});

test('입력 불변성: 호출 후 contents/distributedKinds 인자가 변형되지 않는다', () => {
  const contents = Object.freeze({
    embargoAt: '2026-07-30T00:00:00Z',
    secondEmbargoAt: '2026-07-31T00:00:00Z',
  });
  const dist = ['press'];
  const distCopy = [...dist];
  const now = Date.parse('2026-08-01T00:00:00Z');
  requiredKinds(contents);
  dueKinds(contents, now);
  missingKinds(contents, dist);
  isComplete(contents, dist);
  assert.deepEqual(dist, distCopy, 'distributedKinds 배열이 변형되면 안 된다');
  // contents가 Object.freeze였으므로 쓰기가 있었다면 throw했을 것 — 통과 자체가 불변성 증거.
});
