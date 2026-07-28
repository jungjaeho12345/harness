// 시점 배부 판정 순수 함수 테스트 — ADR-008 (3)(5), news.md "엠바고 규칙".
// 순수 모듈이라 DB/FS/타이머 없이 값만 검증한다. now는 항상 주입(벽시계 비의존).
// 규칙: press required ⇔ embargoAt 설정, nonpress required ⇔ secondEmbargoAt 설정.
//   2차만 기사의 press는 송고 즉시 배부분이라 required가 아니다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { dueDistributionKinds, isEmbargoComplete } from '../src/services/embargoTick.js';

const T1 = '2026-07-28T09:00:00.000Z'; // 1차 엠바고
const T2 = '2026-07-28T18:00:00.000Z'; // 2차 엠바고
const BEFORE = '2026-07-28T08:00:00.000Z';
const BETWEEN = '2026-07-28T12:00:00.000Z';
const AFTER = '2026-07-28T20:00:00.000Z';

// --- dueDistributionKinds ---

test('1차만: now < embargoAt → due 없음', () => {
  assert.deepEqual(dueDistributionKinds({ embargoAt: T1 }, [], BEFORE), []);
});

test('1차만: now >= embargoAt, 미배부 → [press]', () => {
  assert.deepEqual(dueDistributionKinds({ embargoAt: T1 }, [], BETWEEN), ['press']);
});

test('1차만: 이미 press 배부됨 → due 없음', () => {
  assert.deepEqual(dueDistributionKinds({ embargoAt: T1 }, ['press'], BETWEEN), []);
});

test('2차만: nonpress는 secondEmbargoAt 도래 시 due, press는 due가 아니다', () => {
  assert.deepEqual(dueDistributionKinds({ secondEmbargoAt: T2 }, [], BETWEEN), []);
  assert.deepEqual(dueDistributionKinds({ secondEmbargoAt: T2 }, [], AFTER), ['nonpress']);
});

test('2차만: 송고 시 press 이력이 있어도 nonpress만 due', () => {
  assert.deepEqual(dueDistributionKinds({ secondEmbargoAt: T2 }, ['press'], AFTER), ['nonpress']);
});

test('1+2차: now가 1차만 지남 → [press]', () => {
  assert.deepEqual(dueDistributionKinds({ embargoAt: T1, secondEmbargoAt: T2 }, [], BETWEEN), ['press']);
});

test('1+2차: now가 2차까지 지남, 미배부 → [press, nonpress] (순서 유지)', () => {
  assert.deepEqual(dueDistributionKinds({ embargoAt: T1, secondEmbargoAt: T2 }, [], AFTER), ['press', 'nonpress']);
});

test('1+2차: press 배부됨, 2차 도래 → [nonpress]만', () => {
  assert.deepEqual(dueDistributionKinds({ embargoAt: T1, secondEmbargoAt: T2 }, ['press'], AFTER), ['nonpress']);
});

test('빈값/미설정/비ISO 시각은 due가 아니다(NaN 방어)', () => {
  assert.deepEqual(dueDistributionKinds({ embargoAt: '' }, [], AFTER), []);
  assert.deepEqual(dueDistributionKinds({ embargoAt: 'not-a-date' }, [], AFTER), []);
  assert.deepEqual(dueDistributionKinds({}, [], AFTER), []);
});

test('distributedKinds를 Set으로도 받는다', () => {
  assert.deepEqual(dueDistributionKinds({ embargoAt: T1 }, new Set(['press']), BETWEEN), []);
  assert.deepEqual(dueDistributionKinds({ embargoAt: T1, secondEmbargoAt: T2 }, new Set(['press']), AFTER), ['nonpress']);
});

// --- isEmbargoComplete ---

test('1차만: press 배부되면 완결', () => {
  assert.equal(isEmbargoComplete({ embargoAt: T1 }, []), false);
  assert.equal(isEmbargoComplete({ embargoAt: T1 }, ['press']), true);
});

test('2차만: nonpress 배부되면 완결(press 유무 무관)', () => {
  assert.equal(isEmbargoComplete({ secondEmbargoAt: T2 }, ['press']), false);
  assert.equal(isEmbargoComplete({ secondEmbargoAt: T2 }, ['nonpress']), true);
  assert.equal(isEmbargoComplete({ secondEmbargoAt: T2 }, ['press', 'nonpress']), true);
});

test('1+2차: press와 nonpress 둘 다 배부돼야 완결', () => {
  assert.equal(isEmbargoComplete({ embargoAt: T1, secondEmbargoAt: T2 }, ['press']), false);
  assert.equal(isEmbargoComplete({ embargoAt: T1, secondEmbargoAt: T2 }, ['nonpress']), false);
  assert.equal(isEmbargoComplete({ embargoAt: T1, secondEmbargoAt: T2 }, ['press', 'nonpress']), true);
});

test('비-엠바고(둘 다 미설정)는 완결이 아니다(전이 대상 아님)', () => {
  assert.equal(isEmbargoComplete({}, ['press', 'nonpress']), false);
  assert.equal(isEmbargoComplete({ embargoAt: '', secondEmbargoAt: '' }, ['press', 'nonpress']), false);
});

test('isEmbargoComplete도 Set을 받는다', () => {
  assert.equal(isEmbargoComplete({ embargoAt: T1, secondEmbargoAt: T2 }, new Set(['press', 'nonpress'])), true);
});
