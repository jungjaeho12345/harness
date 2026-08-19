// 계약 케이스: GET /api/logs/digest(인벤토리 id 'logs-digest') · GET /api/logs/stream(id 'logs-stream')
// — default 프로파일.
// 동결 축(step11 B):
//   (1) 둘 다 **Z 전용**이다 — 미인증 401 · 비-Z 403 · Z 200. /api/stream(로그인만)과 다른 role 게이트다(ADR-007).
//   (2) 403/401은 **스트림을 열기 전** JSON으로 끝난다(SSE 헤더가 나가지 않는다).
//   (3) digest 응답 shape은 `{ok, items}`이고 items 원소는 로그 record다.
//   (4) logs/stream은 `ready` 후 접속 시점 버퍼를 `event: log`로 replay하고 실시간 push를 잇는다.
// 규율: 서버 코드 import 금지 · 고정 sleep 금지(ready 선행 + 조건 대기) · 프레임 개수/순서 단언 금지 ·
//   스트림은 finally에서 반드시 close.
//
// CRITICAL(마스킹 — LOGS.md): 로그 라인 **실값**(경로·userId·메시지)은 단언하지도, 리포트·실패 메시지에
//   담지도 않는다. 스위트 자신의 요청도 요청 로거를 통해 로그로 흘러들어오므로 내용은 비결정적이기도 하다.
//   여기서 보는 것은 **키 집합·타입·줄 포맷**뿐이다(정규식 판정은 assert.ok로 해서 실값이 출력되지 않게 한다).
// 역할 축: 비-Z 403은 **sid('D')**로 관측한다 — 계약은 "Z가 아니면 403"이고 D가 그 대표다.
//   (이 주석은 예전에 "auth.contract.js가 공용 R 세션을 소실시켜 sid('R')은 401"이라고 적혀 있었으나,
//    이제 로그인하는 케이스가 공용 세션을 복구하는 것이 스위트 규약이라 그 전제는 성립하지 않는다.
//    D 관측을 R로 교체하지는 마라 — 관측의 역할 축을 바꾸면 동결된 계약이 달라진다.)

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { openStream } from '../../lib/sse.js';
import { sid } from '../../lib/session.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';

requireProfile('default');

const WAIT_MS = 10000;

// 로그 record 계약(src/services/logService.js) — 키 집합만 동결한다(값은 로그 내용이라 보지 않는다).
const LOG_RECORD_KEYS = ['level', 'line', 'message', 'seq', 'ts'];
const LOG_LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);
// '[YYYY-MM-DD HH:MM:SS] [LEVEL] <메시지>' — 접두 포맷만 본다(메시지 부분은 판정 대상이 아니다).
const LINE_PREFIX_RE = /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[(DEBUG|INFO|WARN|ERROR)\] /;

// 실패 메시지에 로그 실값이 새지 않도록 assert.ok + 고정 문구만 쓴다.
function assertLogRecord(rec) {
  assert.ok(rec && typeof rec === 'object' && !Array.isArray(rec), '로그 record는 객체여야 한다');
  assert.deepEqual(Object.keys(rec).sort(), LOG_RECORD_KEYS);
  assert.equal(typeof rec.seq, 'number');
  assert.equal(typeof rec.ts, 'number');
  assert.ok(LOG_LEVELS.has(rec.level), `level은 ${[...LOG_LEVELS].join('|')} 중 하나여야 한다`);
  assert.equal(typeof rec.message, 'string');
  assert.equal(typeof rec.line, 'string');
  assert.ok(LINE_PREFIX_RE.test(rec.line), 'line은 [YYYY-MM-DD HH:MM:SS] [LEVEL] 접두로 시작해야 한다(실값 미출력)');
}

const asResponse = (s) => ({ status: s.status, ok: s.status >= 200 && s.status < 300, json: s.json, headers: s.headers });
const maxLogSeq = (frames) => frames.reduce(
  (m, f) => ((f.event === 'log' && typeof f.json?.seq === 'number' && f.json.seq > m) ? f.json.seq : m),
  0,
);

// --- B-1/B-2 digest 인가 + shape ---

test('GET /api/logs/digest — 미인증 401', async () => {
  const res = await api('GET', '/api/logs/digest');

  assert.equal(res.status, 401);
  assert.deepEqual(res.json, { ok: false, reason: 'unauthenticated' });

  record('logs-digest', 'unauthenticated', { ...fromResponse(res), caseId: 'no-session' });
});

test('GET /api/logs/digest — 비-Z(D) 세션은 403 forbidden(핵심 보안 단언 — 200이 아니다)', async () => {
  const res = await api('GET', '/api/logs/digest', { sid: sid('D') });

  assert.equal(res.status, 403);
  assert.deepEqual(res.json, { ok: false, reason: 'forbidden' });

  record('logs-digest', 'forbidden', {
    ...fromResponse(res, { values: { role: 'D' } }),
    caseId: 'role-d', // 라벨에 계정 id(seed userId)를 쓰지 않는다 — 역할 문자만 쓴다.
  });
});

test('GET /api/logs/digest — Z 세션은 200 {ok, items} + items 원소는 로그 record', async () => {
  const res = await api('GET', '/api/logs/digest', { sid: sid('Z') });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(Object.keys(res.json).sort(), ['items', 'ok']);
  assert.ok(Array.isArray(res.json.items), 'items는 배열이어야 한다');
  // 개수는 단언하지 않는다(24h 창 경계는 미동결 — excluded (i)). 원소가 있으면 record 계약을 지켜야 한다.
  for (const item of res.json.items) assertLogRecord(item);

  record('logs-digest', 'success', {
    ...fromResponse(res, { values: { itemsIsArray: true, role: 'Z' } }),
    caseId: 'role-z',
  });
});

// --- B-1/B-5 logs/stream 인가(스트림 열기 전 종료) ---

test('GET /api/logs/stream — 미인증 401 JSON(스트림을 열지 않는다)', async () => {
  const s = await openStream('/api/logs/stream');
  try {
    assert.equal(s.status, 401);
    const ct = s.headers.get('content-type') ?? '';
    assert.match(ct, /application\/json/);
    assert.doesNotMatch(ct, /text\/event-stream/);
    assert.deepEqual(s.json, { ok: false, reason: 'unauthenticated' });

    record('logs-stream', 'unauthenticated', {
      ...fromResponse(asResponse(s), { values: { streamOpened: false } }),
      caseId: 'no-session',
    });
  } finally {
    s.close();
  }
});

test('GET /api/logs/stream — 비-Z(D)는 403이며 스트림 헤더 없이 끝난다', async () => {
  const s = await openStream('/api/logs/stream', { sid: sid('D') });
  try {
    assert.equal(s.status, 403);
    const ct = s.headers.get('content-type') ?? '';
    assert.match(ct, /application\/json/);
    assert.doesNotMatch(ct, /text\/event-stream/); // 열고 나서 거부 프레임을 보내는 구현은 위반이다.
    assert.deepEqual(s.json, { ok: false, reason: 'forbidden' });

    record('logs-stream', 'forbidden', {
      ...fromResponse(asResponse(s), { values: { role: 'D', streamOpened: false } }),
      caseId: 'role-d',
    });
  } finally {
    s.close();
  }
});

// --- B-3 ready + replay ---

test('GET /api/logs/stream — Z는 200 event-stream + ready 후 접속 시점 버퍼를 log로 replay한다', async () => {
  const s = await openStream('/api/logs/stream', { sid: sid('Z') });
  try {
    assert.equal(s.status, 200);
    assert.equal(s.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(s.headers.get('cache-control'), 'no-cache');

    const ready = await s.waitFor((f) => f.event === 'ready', WAIT_MS);
    assert.ok(ready, `ready 프레임이 ${WAIT_MS}ms 안에 도착해야 한다`);
    assert.deepEqual(ready.json, { ok: true }); // ready payload는 두 스트림 공통이다.

    // 트리거 없이 도착하는 log 프레임 = 접속 시점 replay(요청 로거가 이미 남긴 라인들).
    const replayed = await s.waitFor((f) => f.event === 'log', WAIT_MS);
    assert.ok(replayed, `replay log 프레임이 ${WAIT_MS}ms 안에 도착해야 한다`);
    assert.ok(replayed.json !== undefined, 'log 프레임의 data는 JSON이어야 한다');
    assertLogRecord(replayed.json);

    record('logs-stream', 'success', {
      ...fromResponse(asResponse(s), {
        values: { firstEvent: 'ready', replayEvent: 'log', recordKeys: LOG_RECORD_KEYS.join(',') },
        headers: ['content-type', 'cache-control'],
      }),
      caseId: 'ready-replay',
    });
  } finally {
    s.close();
  }
});

// --- B-4 live push ---

test('GET /api/logs/stream — 스트림을 연 채 요청 1건을 보내면 새 log 프레임이 push된다', async () => {
  const s = await openStream('/api/logs/stream', { sid: sid('Z') });
  try {
    assert.ok(await s.waitFor((f) => f.event === 'ready', WAIT_MS), 'ready 선행');

    // 트리거 직전까지 관측한 최대 seq — 이보다 큰 seq의 프레임이 오면 접속 이후 생성된 라인이다
    // (seq는 프로세스 수명 단조 증가). replay 잔여가 늦게 도착할 수 있어 "새 라인 도착"의 하한만 본다.
    const seqBefore = maxLogSeq(s.frames);

    const ping = await api('GET', '/api/health'); // 요청 로거가 매 요청 완료마다 INFO 1줄을 남긴다.
    assert.equal(ping.status, 200);

    const live = await s.waitFor(
      (f) => f.event === 'log' && typeof f.json?.seq === 'number' && f.json.seq > seqBefore,
      WAIT_MS,
    );
    assert.ok(live, `live log 프레임이 ${WAIT_MS}ms 안에 도착해야 한다`);
    assertLogRecord(live.json);

    record('logs-stream', 'live-push', {
      status: s.status,
      ok: true,
      reason: null,
      bodyKeys: LOG_RECORD_KEYS,
      values: { event: 'log', newSeqAfterTrigger: true, recordKeys: LOG_RECORD_KEYS.join(',') },
      caseId: 'live-after-request',
    });
  } finally {
    s.close();
  }
});
