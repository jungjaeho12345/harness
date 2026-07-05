// Slack 다이제스트 전송 어댑터 테스트 (26-realtime-log-viewer step3).
// 주입한 가짜 fetch로 실제 네트워크 없이 검증한다.
//   - webhookUrl 미설정 → no-op(fetch 미호출, throw 없음).
//   - webhookUrl 설정 → 주입 fetch로 Incoming Webhook POST(요청 shape 단언).
//   - fetch 실패를 삼킨다(스케줄러 방해 금지).
//   - formatDigest 순수 함수: 날짜/total/byLevel 요약 텍스트.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSlackDigestSender, formatDigest } from '../src/services/slackDigestSender.js';

const sampleDigest = {
  date: '2026-07-05',
  window: { start: 0, end: 0 },
  total: 3,
  byLevel: { INFO: 2, ERROR: 1 },
  lines: ['[2026-07-04 10:00:00] [INFO] a', '[2026-07-04 11:00:00] [ERROR] b'],
};

test('formatDigest: 날짜/total/byLevel 요약을 포함한다', () => {
  const text = formatDigest(sampleDigest);
  assert.match(text, /2026-07-05/);
  assert.match(text, /3/); // total
  assert.match(text, /INFO/);
  assert.match(text, /ERROR/);
});

test('formatDigest: 문자열을 반환한다(빈 다이제스트도 안전)', () => {
  const text = formatDigest({ date: '2026-07-05', total: 0, byLevel: {}, lines: [] });
  assert.equal(typeof text, 'string');
  assert.ok(text.length > 0);
});

test('webhookUrl 미설정이면 fetch를 호출하지 않는다(no-op)', async () => {
  let called = 0;
  const sendDigest = createSlackDigestSender({ fetchFn: async () => { called++; } });
  const r = await sendDigest(sampleDigest);
  assert.equal(called, 0);
  assert.equal(r.ok, false);
});

test('webhookUrl 설정 시 주입 fetch로 Incoming Webhook에 POST한다', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push({ url, opts }); return { ok: true }; };
  const sendDigest = createSlackDigestSender({ webhookUrl: 'https://hooks.slack.test/xyz', fetchFn });
  const r = await sendDigest(sampleDigest);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://hooks.slack.test/xyz');
  assert.equal(calls[0].opts.method, 'POST');
  assert.match(calls[0].opts.headers['Content-Type'], /application\/json/);
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(typeof body.text, 'string');
  assert.match(body.text, /2026-07-05/);
  assert.equal(r.ok, true);
});

test('fetch 실패를 삼킨다(throw 없이 실패 반환)', async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  const sendDigest = createSlackDigestSender({ webhookUrl: 'https://hooks.slack.test/xyz', fetchFn });
  let r;
  await assert.doesNotReject(async () => { r = await sendDigest(sampleDigest); });
  assert.equal(r.ok, false);
});

test('custom formatDigest 주입 시 그 결과를 text로 보낸다', async () => {
  const calls = [];
  const fetchFn = async (url, opts) => { calls.push(opts); return { ok: true }; };
  const sendDigest = createSlackDigestSender({
    webhookUrl: 'https://hooks.slack.test/xyz',
    fetchFn,
    formatDigest: () => 'CUSTOM',
  });
  await sendDigest(sampleDigest);
  assert.equal(JSON.parse(calls[0].body).text, 'CUSTOM');
});
