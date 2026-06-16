import test from 'node:test';
import assert from 'node:assert/strict';
import { createTranslate } from '../src/services/translate.js';

// 가짜 fetchFn — 호출 URL/옵션을 기록하고 주입한 응답을 돌려준다(실제 네트워크 없음).
function fakeFetch(response) {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    if (typeof response === 'function') return response(url, opts);
    return response;
  };
  return { fetchFn, calls };
}

// fetch-like 응답 객체.
function ok(body) {
  return { ok: true, json: async () => body };
}

// Google Cloud Translation v2 정상 응답 shape.
function googleBody(translatedText, detectedSourceLanguage) {
  return { data: { translations: [{ translatedText, detectedSourceLanguage }] } };
}

const FULL_ENV = { GOOGLE_TRANSLATE_API_KEY: 'tr-key' };

test('translate: 키 주입+정상 응답이면 번역 결과를 반환한다', async () => {
  const { fetchFn, calls } = fakeFetch(ok(googleBody('hello', 'ko')));
  const t = createTranslate({ fetchFn, env: FULL_ENV });

  const r = await t.translate('안녕', 'en');
  assert.equal(r.ok, true);
  assert.equal(r.translatedText, 'hello');
  assert.equal(r.sourceLang, 'ko');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /translation\.googleapis\.com\/language\/translate\/v2/);
  assert.match(calls[0].url, /key=tr-key/); // 키는 쿼리파라미터로 전달
});

test('translate: 키 누락 시 fetch 미호출·원문 그대로 graceful degrade', async () => {
  const { fetchFn, calls } = fakeFetch(ok(googleBody('hello', 'ko')));
  const t = createTranslate({ fetchFn, env: {} }); // 키 없음

  const r = await t.translate('안녕', 'en');
  assert.deepEqual(r, { ok: false, reason: 'no-key', translatedText: '안녕' });
  assert.equal(calls.length, 0, '키가 없으면 fetch를 부르지 않는다');
});

test('translate: 네트워크 throw는 예외 대신 원문 폴백', async () => {
  const fetchFn = async () => { throw new Error('network down'); };
  const t = createTranslate({ fetchFn, env: FULL_ENV });

  const r = await t.translate('안녕', 'en');
  assert.deepEqual(r, { ok: false, reason: 'error', translatedText: '안녕' });
});

test('translate: HTTP non-ok는 예외 대신 원문 폴백', async () => {
  const fetchFn = async () => ({ ok: false, status: 403, json: async () => ({}) });
  const t = createTranslate({ fetchFn, env: FULL_ENV });

  const r = await t.translate('안녕', 'en');
  assert.deepEqual(r, { ok: false, reason: 'error', translatedText: '안녕' });
});

test('translate: API 키는 주입 env에서만 읽힌다(다른 키→다른 요청)', async () => {
  const { fetchFn: f1, calls: c1 } = fakeFetch(ok(googleBody('x', 'ko')));
  const { fetchFn: f2, calls: c2 } = fakeFetch(ok(googleBody('x', 'ko')));
  await createTranslate({ fetchFn: f1, env: { GOOGLE_TRANSLATE_API_KEY: 'AAA' } }).translate('안녕', 'en');
  await createTranslate({ fetchFn: f2, env: { GOOGLE_TRANSLATE_API_KEY: 'BBB' } }).translate('안녕', 'en');

  assert.match(c1[0].url, /key=AAA/);
  assert.match(c2[0].url, /key=BBB/);
  assert.doesNotMatch(c1[0].url, /BBB/);
});

test('translate: 키가 URL/특수문자를 포함하면 인코딩된다', async () => {
  const { fetchFn, calls } = fakeFetch(ok(googleBody('x', 'ko')));
  const t = createTranslate({ fetchFn, env: { GOOGLE_TRANSLATE_API_KEY: 'a b&c' } });
  await t.translate('안녕', 'en');
  // URLSearchParams는 공백을 +로, &를 %26으로 인코딩한다(원시 키 노출 방지).
  assert.match(calls[0].url, /key=a\+b%26c/);
  assert.doesNotMatch(calls[0].url, /key=a b&c/);
});

test('translate: 빈/누락 text는 빈 결과(ok:true, translatedText:"")', async () => {
  const { fetchFn, calls } = fakeFetch(ok(googleBody('hello', 'ko')));
  const t = createTranslate({ fetchFn, env: FULL_ENV });

  const r = await t.translate('', 'en');
  assert.deepEqual(r, { ok: true, translatedText: '' });
  assert.equal(calls.length, 0, '빈 text면 fetch를 부르지 않는다');

  const r2 = await t.translate(undefined, 'en');
  assert.deepEqual(r2, { ok: true, translatedText: '' });
});

test('translate: targetLang 기본값은 ko', async () => {
  const { fetchFn, calls } = fakeFetch(ok(googleBody('번역', 'en')));
  const t = createTranslate({ fetchFn, env: FULL_ENV });

  await t.translate('hello');
  assert.match(calls[0].url, /target=ko/);
});

test('translate: 텍스트는 q 파라미터로 인코딩 전달된다', async () => {
  const { fetchFn, calls } = fakeFetch(ok(googleBody('hi', 'ko')));
  const t = createTranslate({ fetchFn, env: FULL_ENV });

  await t.translate('고양이', 'en');
  assert.match(calls[0].url, /q=%EA%B3%A0%EC%96%91%EC%9D%B4/);
});

test('translate: detectedSourceLanguage 누락 시 sourceLang은 undefined', async () => {
  const { fetchFn } = fakeFetch(ok({ data: { translations: [{ translatedText: 'hi' }] } }));
  const t = createTranslate({ fetchFn, env: FULL_ENV });

  const r = await t.translate('안녕', 'en');
  assert.equal(r.ok, true);
  assert.equal(r.translatedText, 'hi');
  assert.equal(r.sourceLang, undefined);
});

test('translate: 응답 본문이 비정상이면 원문 폴백(error)', async () => {
  const { fetchFn } = fakeFetch(ok({})); // data.translations 없음
  const t = createTranslate({ fetchFn, env: FULL_ENV });

  const r = await t.translate('안녕', 'en');
  assert.deepEqual(r, { ok: false, reason: 'error', translatedText: '안녕' });
});
