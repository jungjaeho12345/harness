// 계약 케이스: GET /api/health (인벤토리 id 'health') — default 프로파일.
// 계약: 인증 없이 200 · 본문 {ok:true} 고정 · content-type JSON (Electron 셸 프로브가 본문까지 판정).
// 규율: 서버 코드 import 금지(CONTRACT_BASE_URL로만 접근) · 리포트 기록은 record 한 곳으로만.

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';

// 케이스 오배치 방지 — 다른 프로파일에서 --files로 잘못 실행되면 로드 시점에 즉시 실패한다.
requireProfile('default');

test('GET /api/health — 인증 없이 200 {ok:true} JSON', async () => {
  const res = await api('GET', '/api/health');

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { ok: true }); // 본문 전체가 {ok:true} 고정 — 키 추가도 계약 위반.
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);

  record('health', 'success', {
    ...fromResponse(res, { values: { ok: res.json.ok }, headers: ['content-type'] }),
    caseId: 'ok',
  });
});
