import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHttpModel } from './httpModel.js';

const BASE = 'http://api.test';

function jsonResponse(body) {
  return { ok: true, status: 200, json: async () => body };
}

describe('createHttpModel', () => {
  let fetchMock;
  const realFetch = globalThis.fetch;
  const realEventSource = globalThis.EventSource;

  beforeEach(() => {
    sessionStorage.clear();
    fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    globalThis.EventSource = realEventSource;
  });

  const callAt = (i) => fetchMock.mock.calls[i];

  it('login POSTs credentials and stores the session id for later requests', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-1', user: { userId: 'kim' } }));
    const model = createHttpModel({ base: BASE });

    const r = await model.login('kim', 'pw');
    expect(r.sessionId).toBe('sid-1');

    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/login`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ userId: 'kim', password: 'pw' });
    expect(init.headers['x-session-id']).toBeUndefined(); // 로그인 시점엔 아직 토큰 없음

    // 이후 요청에는 보관된 토큰이 자동 첨부된다.
    await model.queryArticles();
    expect(callAt(1)[1].headers['x-session-id']).toBe('sid-1');
  });

  it('logout POSTs then clears the stored session id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-2', user: {} }));
    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b');

    await model.logout();
    expect(callAt(1)[0]).toBe(`${BASE}/api/logout`);
    expect(callAt(1)[1].method).toBe('POST');
    expect(callAt(1)[1].headers['x-session-id']).toBe('sid-2'); // 무효화 대상 토큰을 보낸다

    // 토큰이 제거되어 다음 요청엔 헤더가 없다.
    await model.queryArticles();
    expect(callAt(2)[1].headers['x-session-id']).toBeUndefined();
  });

  it('restoreSession GETs /api/session carrying the stored session id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-7', user: {} }));
    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b');

    await model.restoreSession();
    const [url, init] = callAt(1);
    expect(url).toBe(`${BASE}/api/session`);
    expect(init.method).toBe('GET');
    expect(init.headers['x-session-id']).toBe('sid-7');
    expect(init.body).toBeUndefined();
  });

  it('restoreSession returns the (non-throwing) unauthenticated body when there is no session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: false, reason: 'unauthenticated' }));
    const model = createHttpModel({ base: BASE });
    const r = await model.restoreSession();
    expect(r).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  it('saveArticle POSTs when no articleId and PUTs /:id when present', async () => {
    const model = createHttpModel({ base: BASE });

    await model.saveArticle({ title: 'new' });
    expect(callAt(0)[0]).toBe(`${BASE}/api/articles`);
    expect(callAt(0)[1].method).toBe('POST');

    await model.saveArticle({ articleId: 'AKR1', title: 'edit' });
    expect(callAt(1)[0]).toBe(`${BASE}/api/articles/AKR1`);
    expect(callAt(1)[1].method).toBe('PUT');
  });

  it('createUser POSTs /api/users and updateUser PUTs /api/users/:id', async () => {
    const model = createHttpModel({ base: BASE });

    await model.createUser({ userId: 'kim', password: 'x' });
    expect(callAt(0)[0]).toBe(`${BASE}/api/users`);
    expect(callAt(0)[1].method).toBe('POST');

    await model.updateUser('kim', { name: 'Kim' });
    expect(callAt(1)[0]).toBe(`${BASE}/api/users/kim`);
    expect(callAt(1)[1].method).toBe('PUT');
    expect(JSON.parse(callAt(1)[1].body)).toEqual({ name: 'Kim' });
  });

  it('applyAction POSTs the action without sending role in the body', async () => {
    const model = createHttpModel({ base: BASE });
    await model.applyAction('AKR1', 'send');
    const [url, init] = callAt(0);
    expect(url).toBe(`${BASE}/api/articles/AKR1/action`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ action: 'send' });
    expect(body.role).toBeUndefined();
  });

  it('queryArticles serializes array filters as repeated query params', async () => {
    const model = createHttpModel({ base: BASE });
    await model.queryArticles({ departments: ['정치', '경제'], status: 'DPS' });
    const url = new URL(callAt(0)[0]);
    expect(url.pathname).toBe('/api/articles');
    expect(url.searchParams.getAll('departments')).toEqual(['정치', '경제']);
    expect(url.searchParams.get('status')).toBe('DPS');
  });

  it('lock/unlock/force-unlock map to their POST routes', async () => {
    const model = createHttpModel({ base: BASE });
    await model.lockArticle('AKR1', 'portalRevise');
    expect(callAt(0)[0]).toBe(`${BASE}/api/articles/AKR1/lock`);
    expect(JSON.parse(callAt(0)[1].body)).toEqual({ action: 'portalRevise' });

    await model.unlockArticle('AKR1');
    expect(callAt(1)[0]).toBe(`${BASE}/api/articles/AKR1/unlock`);

    await model.forceUnlockArticle('AKR1');
    expect(callAt(2)[0]).toBe(`${BASE}/api/articles/AKR1/force-unlock`);
  });

  it('subscribe opens EventSource with the session query and routes change signals', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, sessionId: 'sid-5', user: {} }));
    const instances = [];
    class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = {};
        this.closed = false;
        instances.push(this);
      }
      addEventListener(type, cb) { (this.listeners[type] ??= []).push(cb); }
      close() { this.closed = true; }
      emit(type, data) { (this.listeners[type] ?? []).forEach((cb) => cb({ data })); }
    }
    globalThis.EventSource = FakeEventSource;

    const model = createHttpModel({ base: BASE });
    await model.login('a', 'b'); // stores sid-5

    const onChange = vi.fn();
    const sub = model.subscribe({ menu: 'desk' }, onChange);

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toBe(`${BASE}/api/stream?session=sid-5`);
    expect(sub.connected()).toBe(false);

    instances[0].emit('ready', '{"ok":true}');
    expect(sub.connected()).toBe(true);

    instances[0].emit('change', '{"kind":"status"}');
    expect(onChange).toHaveBeenCalledWith({ kind: 'status' }, { menu: 'desk' });

    sub.unsubscribe();
    expect(instances[0].closed).toBe(true);
  });
});
