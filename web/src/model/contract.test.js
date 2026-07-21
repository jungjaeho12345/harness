import { describe, it, expect, vi } from 'vitest';
import { MODEL_KEYS, assertModel } from './contract.js';
import { createFakeModel } from '../test/fakeModel.js';

describe('MODEL_KEYS', () => {
  it('is frozen and lists the 28 contract methods', () => {
    expect(Object.isFrozen(MODEL_KEYS)).toBe(true);
    expect(MODEL_KEYS).toHaveLength(28);
    // step9가 보장해야 하는 핵심 키들 + step14가 추가하는 getArticle(단건 조회).
    for (const key of ['login', 'logout', 'restoreSession', 'createUser', 'updateUser', 'saveArticle', 'getArticle', 'subscribe']) {
      expect(MODEL_KEYS).toContain(key);
    }
  });

  it('includes the step7 history/derive/translate keys', () => {
    for (const key of ['queryHistory', 'deriveArticle', 'translate']) {
      expect(MODEL_KEYS).toContain(key);
    }
  });

  it('includes the file-upload key (uploadFile)', () => {
    expect(MODEL_KEYS).toContain('uploadFile');
  });

  it('includes the history-snapshot key (getHistorySnapshot)', () => {
    expect(MODEL_KEYS).toContain('getHistorySnapshot');
  });

  it('includes the log-viewer keys (subscribeLogs, getLogsDigest)', () => {
    for (const key of ['subscribeLogs', 'getLogsDigest']) {
      expect(MODEL_KEYS).toContain(key);
    }
  });

  it('includes the photo-db keys (publishPhoto, searchPhotos)', () => {
    for (const key of ['publishPhoto', 'searchPhotos']) {
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

  it('queryHistory returns seeded items and filters sendOnly', async () => {
    const fake = createFakeModel({
      histories: {
        AKR1: [
          { id: 2, articleId: 'AKR1', eventType: 'status', action: 'send' },
          { id: 1, articleId: 'AKR1', eventType: 'edit', action: null },
        ],
      },
    });
    const all = await fake.queryHistory('AKR1');
    expect(all.ok).toBe(true);
    expect(all.items).toHaveLength(2);

    const sent = await fake.queryHistory('AKR1', { sendOnly: true });
    expect(sent.ok).toBe(true);
    expect(sent.items).toHaveLength(1);
    expect(sent.items[0].action).toBe('send');

    const none = await fake.queryHistory('NOPE');
    expect(none.ok).toBe(true);
    expect(none.items).toEqual([]);
  });

  it('getHistorySnapshot returns the seeded snapshot item without mutating the seed', async () => {
    const seed = {
      histories: {
        AKR1: [
          { id: 2, articleId: 'AKR1', eventType: 'edit', actorUserId: 'lee', createdAt: '2026-06-14T02:00:00Z', hasSnapshot: 1, markupVersion: '{"format":"yh-editor","version":1,"blocks":[]}' },
        ],
      },
    };
    const fake = createFakeModel(seed);

    const r = await fake.getHistorySnapshot('AKR1', 2);
    expect(r.ok).toBe(true);
    expect(r.item.markupVersion).toBe('{"format":"yh-editor","version":1,"blocks":[]}');

    // 원본 seed는 변경되지 않는다(읽기 전용 모사) — 반환 item을 고쳐도 다음 조회는 그대로다.
    r.item.markupVersion = 'tampered';
    expect((await fake.getHistorySnapshot('AKR1', 2)).item.markupVersion)
      .toBe('{"format":"yh-editor","version":1,"blocks":[]}');

    // 없는 historyId/타 기사 스코프는 not-found.
    expect(await fake.getHistorySnapshot('AKR1', 999)).toEqual({ ok: false, reason: 'not-found' });
    expect(await fake.getHistorySnapshot('NOPE', 2)).toEqual({ ok: false, reason: 'not-found' });
  });

  it('deriveArticle creates a new article without mutating the source', async () => {
    const fake = createFakeModel({ articles: [{ articleId: 'AKR1', title: '원본', status: 'DPS' }] });
    const onChange = vi.fn();
    fake.subscribe({}, onChange);

    const r = await fake.deriveArticle('AKR1', 'continue');
    expect(r.ok).toBe(true);
    expect(r.articleId).toBeTruthy();
    expect(r.articleId).not.toBe('AKR1');
    expect(onChange).toHaveBeenCalled();

    // 원본은 변경되지 않는다(비파괴).
    const src = (await fake.getArticle('AKR1')).article;
    expect(src.title).toBe('원본');
    expect(src.status).toBe('DPS');
  });

  it('publishPhoto→searchPhotos round-trips a caption search with registeredBy stamped from the session', async () => {
    const fake = createFakeModel({ users: [{ userId: 'kim', password: 'pw', name: '김기자', role: 'R' }] });
    await fake.login('kim', 'pw');

    const r = await fake.publishPhoto({ src: '/uploads/a.png', caption: '현장 사진', sourceArticleId: 'AKR1' });
    expect(r.ok).toBe(true);
    expect(r.id).toBeTruthy();

    const s = await fake.searchPhotos('현장');
    expect(s.ok).toBe(true);
    expect(s.items).toHaveLength(1);
    expect(s.items[0]).toMatchObject({
      id: r.id,
      src: '/uploads/a.png',
      caption: '현장 사진',
      sourceArticleId: 'AKR1',
      registeredBy: 'kim', // 세션 사용자로 stamp(서버 동형)
    });
    expect(s.items[0].createdAt).toBeTruthy();

    // 캡션 불일치는 빈 결과, 반환 items는 복사본이라 고쳐도 스토어는 불변.
    expect((await fake.searchPhotos('없는캡션')).items).toEqual([]);
    s.items[0].caption = 'tampered';
    expect((await fake.searchPhotos('현장')).items[0].caption).toBe('현장 사진');
  });

  it('publishPhoto ignores a client-sent registeredBy and stamps the session user (trust boundary)', async () => {
    const fake = createFakeModel({ users: [{ userId: 'kim', password: 'pw' }] });
    await fake.login('kim', 'pw');

    const r = await fake.publishPhoto({ src: '/x.png', caption: '캡션', registeredBy: 'attacker' });
    expect(r.ok).toBe(true);

    const { items } = await fake.searchPhotos('캡션');
    expect(items[0].registeredBy).toBe('kim');
  });

  it('translate returns translated text and is graceful when seeded without one', async () => {
    const seeded = createFakeModel({ translations: { AKR1: '번역문' } });
    const r = await seeded.translate('AKR1', 'ko');
    expect(r.ok).toBe(true);
    expect(r.translatedText).toBe('번역문');

    const fallback = createFakeModel({ articles: [{ articleId: 'AKR2', title: '원문' }] });
    const g = await fallback.translate('AKR2');
    expect(g.translatedText).toBeTruthy();
  });
});
