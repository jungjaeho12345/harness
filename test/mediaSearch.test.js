import test from 'node:test';
import assert from 'node:assert/strict';
import { createMediaSearch } from '../src/services/mediaSearch.js';

// 가짜 fetchFn — 호출 URL을 기록하고 주입한 응답을 돌려준다(실제 네트워크 없음).
function fakeFetch(response) {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (typeof response === 'function') return response(url);
    return response;
  };
  return { fetchFn, calls };
}

// fetch-like 응답 객체.
function ok(body) {
  return { ok: true, json: async () => body };
}

const FULL_ENV = {
  YOUTUBE_API_KEY: 'yt-key',
  GOOGLE_API_KEY: 'g-key',
  GOOGLE_CSE_ID: 'cse-id',
};

test('search: type=image면 Google 이미지 검색 엔드포인트를 호출한다', async () => {
  const { fetchFn, calls } = fakeFetch(ok({ items: [{ link: 'a.jpg' }] }));
  const media = createMediaSearch({ fetchFn, env: FULL_ENV });

  const r = await media.search('고양이', 'image');
  assert.equal(r.error, false);
  assert.deepEqual(r.items, [{ link: 'a.jpg' }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /customsearch/);
  assert.match(calls[0], /searchType=image/);
  assert.match(calls[0], /cse-id/);
  assert.match(calls[0], /%EA%B3%A0%EC%96%91%EC%9D%B4/); // 쿼리 인코딩
});

test('search: type=video면 YouTube 검색 엔드포인트를 호출한다', async () => {
  const { fetchFn, calls } = fakeFetch(ok({ items: [{ id: { videoId: 'x' } }] }));
  const media = createMediaSearch({ fetchFn, env: FULL_ENV });

  const r = await media.search('뉴스', 'video');
  assert.equal(r.error, false);
  assert.deepEqual(r.items, [{ id: { videoId: 'x' } }]);
  assert.match(calls[0], /youtube\/v3\/search/);
  assert.match(calls[0], /yt-key/);
});

test('search: 누락된 type은 video(YouTube)로 처리한다', async () => {
  const { fetchFn, calls } = fakeFetch(ok({ items: [] }));
  const media = createMediaSearch({ fetchFn, env: FULL_ENV });

  await media.search('뉴스');
  assert.match(calls[0], /youtube\/v3\/search/);
});

test('search: 알 수 없는 type도 video(YouTube)로 처리한다', async () => {
  const { fetchFn, calls } = fakeFetch(ok({ items: [] }));
  const media = createMediaSearch({ fetchFn, env: FULL_ENV });

  await media.search('뉴스', 'audio');
  assert.match(calls[0], /youtube\/v3\/search/);
});

test('search: 응답에 items가 없으면 빈 배열로 정규화한다', async () => {
  const { fetchFn } = fakeFetch(ok({})); // items 필드 없음
  const media = createMediaSearch({ fetchFn, env: FULL_ENV });

  const r = await media.search('없음', 'video');
  assert.deepEqual(r.items, []);
  assert.equal(r.error, false);
});

test('search: YouTube 키가 없으면 fetch 없이 데모 영상 샘플(error:false)을 반환한다', async () => {
  const { fetchFn, calls } = fakeFetch(ok({ items: [{}] }));
  const media = createMediaSearch({ fetchFn, env: { GOOGLE_API_KEY: 'g', GOOGLE_CSE_ID: 'c' } });

  const r = await media.search('뉴스', 'video');
  assert.equal(r.error, false);
  assert.equal(calls.length, 0, '키가 없으면 fetch를 부르지 않는다');
  assert.ok(r.items.length > 0, '데모 샘플이 비어 있지 않다');
  // 데모 영상 항목은 임베드 가능한 11자리 video id를 가진다.
  for (const it of r.items) assert.match(it.videoId, /^[\w-]{11}$/);
});

test('search: Google 키/CSE_ID가 없으면 fetch 없이 데모 이미지 샘플(error:false)을 반환한다', async () => {
  const { fetchFn, calls } = fakeFetch(ok({ items: [{}] }));
  const media = createMediaSearch({ fetchFn, env: { GOOGLE_API_KEY: 'g' } }); // CSE_ID 누락

  const r = await media.search('고양이', 'image');
  assert.equal(r.error, false);
  assert.equal(calls.length, 0);
  assert.ok(r.items.length > 0, '데모 샘플이 비어 있지 않다');
  for (const it of r.items) assert.ok(typeof it.link === 'string' && it.link.length > 0);
});

test('search: 네트워크 오류(fetch throw)는 예외 대신 빈 결과(error:true)로 처리한다', async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  const media = createMediaSearch({ fetchFn, env: FULL_ENV });

  const r = await media.search('뉴스', 'video');
  assert.deepEqual(r, { items: [], error: true });
});

test('search: 응답이 ok가 아니면(HTTP 오류) 빈 결과(error:true)로 처리한다', async () => {
  const fetchFn = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const media = createMediaSearch({ fetchFn, env: FULL_ENV });

  const r = await media.search('고양이', 'image');
  assert.deepEqual(r, { items: [], error: true });
});
