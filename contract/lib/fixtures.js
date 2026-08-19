// 계약 스위트 픽스처 — 전부 **API로만** 만든다(대상 서버 DB에 직접 쓰지 않는다 — decisions (5),
// Spring/MariaDB 대상에서도 같은 스위트가 돌아야 한다). 실패는 명확한 메시지로 throw한다
// (픽스처 실패를 계약 실패로 오인하지 않게 — 케이스의 단언과 실패 층이 다르다).
// 사전 존재 데이터 강건성(decisions (6)): unique() 토큰이 박힌 제목/슬러그로 자기 픽스처만 격리·단언한다.
// 에러 메시지 규율: status·reason 토큰만 담는다 — articleId·세션 토큰·비밀번호는 담지 않는다(LOGS.md).

import crypto from 'node:crypto';
import { api } from './http.js';
import { sid } from './session.js';

// 실행(프로세스)마다 새 토큰 — 같은 대상 서버에 반복 실행해도 이전 실행의 데이터와 충돌하지 않는다.
const RUN_TOKEN = crypto.randomBytes(4).toString('hex');
let seq = 0;

// 충돌 없는 고유 토큰. prefix는 소문자 슬러그([a-z0-9][a-z0-9_-]*)여야 한다 —
// 결과가 spoolDir 슬러그 규칙(소문자 영숫자 시작, 영숫자/-/_ 총 64자 이내)을 통과해야 하기 때문이다.
export function unique(prefix = 'ct') {
  seq += 1;
  return `${prefix}-${RUN_TOKEN}-${seq}`;
}

function failFixture(what, res) {
  throw new Error(
    `픽스처 실패 ${what}: status=${res.status} reason=${res.json?.reason ?? '-'} error=${res.error ?? '-'}`,
  );
}

// POST /api/articles → { articleId, title }. overrides.endMarker(기본 true)로 본문 "(끝)" 마커를 제어한다
// (송고 가드 케이스가 양쪽을 다 쓴다). 나머지 overrides는 요청 body에 그대로 얹는다(markupVersion 직접 지정 가능).
export async function createArticle(role, overrides = {}) {
  const { endMarker = true, ...fields } = overrides;
  const title = fields.title ?? unique('contract-title');
  const blocks = [{ text: '계약 스위트 픽스처 본문.' }];
  if (endMarker) blocks.push({ text: '(끝)' });
  const body = { title, markupVersion: JSON.stringify({ blocks }), ...fields };
  const res = await api('POST', '/api/articles', { sid: sid(role), body });
  if (res.status !== 200 || res.json?.ok !== true || typeof res.json.articleId !== 'string') {
    failFixture('createArticle', res);
  }
  return { articleId: res.json.articleId, title };
}

// D로 create(끝 마커 포함) 후 POST action send → { articleId, status }(무엠바고면 DPS).
export async function createSentArticle(overrides = {}) {
  const { articleId } = await createArticle('D', { endMarker: true, ...overrides });
  const res = await api('POST', `/api/articles/${articleId}/action`, {
    sid: sid('D'), body: { action: 'send' },
  });
  if (res.status !== 200 || res.json?.ok !== true) failFixture('createSentArticle(send)', res);
  return { articleId, status: res.json.status };
}

// Z로 POST /api/distribution-targets → { id, spoolDir }. kind: 'press'|'nonpress'.
// spoolDir는 unique 슬러그(사전 존재 대상의 duplicate-spool-dir와 충돌하지 않는다).
export async function createTarget(kind, overrides = {}) {
  const spoolDir = overrides.spoolDir ?? unique('ct-spool');
  const body = { name: unique('contract-target'), kind, spoolDir, ...overrides };
  const res = await api('POST', '/api/distribution-targets', { sid: sid('Z'), body });
  if (res.status !== 200 || res.json?.ok !== true || !Number.isInteger(res.json.id)) {
    failFixture('createTarget', res);
  }
  return { id: res.json.id, spoolDir };
}

// Z로 POST /api/receiver-config → { id, sourceId }. 입력 검증 없는 라우트라 최소 필드만 채운다.
// 삭제 케이스는 반드시 이 함수로 만든 자기 행만 지운다(기존 행 금지 — decisions (14)).
export async function createReceiverConfig(overrides = {}) {
  const sourceId = overrides.sourceId ?? unique('ct-source');
  const body = { sourceId, type: 'API', name: unique('contract-receiver'), active: 'Y', ...overrides };
  const res = await api('POST', '/api/receiver-config', { sid: sid('Z'), body });
  if (res.status !== 200 || res.json?.ok !== true || !Number.isInteger(res.json.id)) {
    failFixture('createReceiverConfig', res);
  }
  return { id: res.json.id, sourceId };
}

// POST /api/articles/:id/lock — clientId(x-edit-client)가 보유 탭 식별자다. 성공 응답 json을 반환한다.
export async function acquireLock(articleId, role, clientId) {
  const res = await api('POST', `/api/articles/${articleId}/lock`, {
    sid: sid(role), headers: { 'x-edit-client': clientId }, body: {},
  });
  if (res.status !== 200 || res.json?.ok !== true) failFixture('acquireLock', res);
  return res.json;
}
