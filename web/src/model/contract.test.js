import { describe, it, expect, vi } from 'vitest';
import { MODEL_KEYS, assertModel } from './contract.js';
import { createFakeModel } from '../test/fakeModel.js';

describe('MODEL_KEYS', () => {
  it('is frozen and lists the 21 contract methods', () => {
    expect(Object.isFrozen(MODEL_KEYS)).toBe(true);
    expect(MODEL_KEYS).toHaveLength(21);
    // step9가 보장해야 하는 핵심 키들 + step14가 추가하는 getArticle(단건 조회) + step1-history가 추가하는 이력 조회 2개.
    for (const key of ['login', 'logout', 'restoreSession', 'createUser', 'updateUser', 'saveArticle', 'getArticle', 'getArticleHistory', 'getSendHistory', 'subscribe']) {
      expect(MODEL_KEYS).toContain(key);
    }
  });
});

describe('assertModel', () => {
  function fullStub() {
    const stub = {};
    for (const key of MODEL_KEYS) stub[key] = () => {};
    return stub;
  }

  it('passes for a model implementing every key', () => {
    expect(() => assertModel(fullStub())).not.toThrow();
  });

  it('throws naming the missing method', () => {
    const partial = fullStub();
    delete partial.subscribe;
    expect(() => assertModel(partial)).toThrow(/subscribe/);
  });

  it('throws when a key is not a function', () => {
    const bad = fullStub();
    bad.login = 'nope';
    expect(() => assertModel(bad)).toThrow(/login/);
  });

  it('throws for non-objects', () => {
    expect(() => assertModel(null)).toThrow();
    expect(() => assertModel(undefined)).toThrow();
  });
});

describe('createFakeModel', () => {
  it('satisfies the full contract (incl. restoreSession/createUser/updateUser)', () => {
    const fake = createFakeModel();
    expect(() => assertModel(fake)).not.toThrow();
    for (const key of MODEL_KEYS) expect(typeof fake[key]).toBe('function');
  });

  it('login/restoreSession round-trip a seeded user without leaking the password', async () => {
    const fake = createFakeModel({ users: [{ userId: 'kim', password: 'pw', name: '김기자', role: 'R' }] });
    const r = await fake.login('kim', 'pw');
    expect(r.ok).toBe(true);
    expect(r.user.password).toBeUndefined();
    const restored = await fake.restoreSession();
    expect(restored.ok).toBe(true);
    expect(restored.user.userId).toBe('kim');
    await fake.logout();
    expect((await fake.restoreSession()).ok).toBe(false);
  });

  it('saveArticle assigns an id when missing and notifies subscribers', async () => {
    const fake = createFakeModel();
    const onChange = vi.fn();
    fake.subscribe({}, onChange);
    const r = await fake.saveArticle({ title: '새 기사' });
    expect(r.ok).toBe(true);
    expect(r.articleId).toBeTruthy();
    expect(onChange).toHaveBeenCalled();
  });

  it('queryUsers never exposes passwords', async () => {
    const fake = createFakeModel({ users: [{ userId: 'a', password: 'secret' }] });
    const { items } = await fake.queryUsers();
    expect(items[0].password).toBeUndefined();
  });

  it('getArticleHistory returns the seeded history for an article in { ok, items } shape', async () => {
    const fake = createFakeModel({
      histories: [
        { articleId: 'AKR1', eventType: 'create', toStatus: 'RDS' },
        { articleId: 'AKR1', eventType: 'send', actorRole: 'D' },
        { articleId: 'AKR2', eventType: 'edit' },
      ],
    });
    const r = await fake.getArticleHistory('AKR1');
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
    expect(r.items.map((h) => h.eventType)).toEqual(['create', 'send']);
  });

  it('getArticleHistory returns an empty list when no history is seeded', async () => {
    const fake = createFakeModel();
    const r = await fake.getArticleHistory('AKRX');
    expect(r).toEqual({ ok: true, items: [] });
  });

  it('getSendHistory returns only send events for the article', async () => {
    const fake = createFakeModel({
      histories: [
        { articleId: 'AKR1', eventType: 'create' },
        { articleId: 'AKR1', eventType: 'send' },
        { articleId: 'AKR1', eventType: 'edit' },
        { articleId: 'AKR1', eventType: 'send' },
        { articleId: 'AKR2', eventType: 'send' },
      ],
    });
    const r = await fake.getSendHistory('AKR1');
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
    expect(r.items.every((h) => h.eventType === 'send')).toBe(true);
  });
});
