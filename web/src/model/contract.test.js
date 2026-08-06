import { describe, it, expect, vi } from 'vitest';
import { MODEL_KEYS, assertModel } from './contract.js';
import { createFakeModel } from '../test/fakeModel.js';

describe('MODEL_KEYS', () => {
  it('is frozen, duplicate-free, and lists the 35 contract methods', () => {
    expect(Object.isFrozen(MODEL_KEYS)).toBe(true);
    expect(MODEL_KEYS).toHaveLength(35);
    expect(new Set(MODEL_KEYS).size).toBe(MODEL_KEYS.length); // 중복 키 없음.
    // step9가 보장해야 하는 핵심 키들 + step14가 추가하는 getArticle(단건 조회).
    for (const key of ['login', 'logout', 'restoreSession', 'createUser', 'updateUser', 'saveArticle', 'getArticle', 'subscribe']) {
      expect(MODEL_KEYS).toContain(key);
    }
  });

  it('includes the distribution failure/tick keys (phase 57 MVP-4)', () => {
    for (const key of ['queryDistributionFailures', 'retryDistribution', 'runDistributionTick']) {
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

  it('includes the distribution-target keys (phase 46) and no delete key', () => {
    for (const key of [
      'queryDistributionTargets',
      'createDistributionTarget',
      'updateDistributionTarget',
      'deactivateDistributionTarget',
    ]) {
      expect(MODEL_KEYS).toContain(key);
    }
    // 삭제 라우트는 존재하지 않는다(비활성=soft delete가 유일 경로, ADR-008).
    expect(MODEL_KEYS).not.toContain('deleteDistributionTarget');
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

  // --- /history 경량 목록 계약(phase 56 step5) — 서버는 목록에 blob을 싣지 않고 title/version/status를 파생해 준다 ---
  it('queryHistory omits markupVersion from list items (sendOnly 경로 포함 — blob 없는 경량 계약)', async () => {
    const fake = createFakeModel({
      histories: {
        AKR1: [
          {
            id: 3, articleId: 'AKR1', eventType: 'status', action: 'send',
            fromStatus: 'RDS', toStatus: 'DPS', actorUserId: 'kim', createdAt: '2026-06-14T03:00:00Z',
            hasSnapshot: 0, title: '헤드라인', version: 3, status: 'DPS',
            markupVersion: 'blob-should-not-leak',
          },
          {
            id: 2, articleId: 'AKR1', eventType: 'edit', action: null,
            actorUserId: 'lee', createdAt: '2026-06-14T02:00:00Z',
            hasSnapshot: 1, title: '헤드라인', version: 3, status: 'RDS',
            markupVersion: '{"format":"yh-editor","version":1,"blocks":[]}',
          },
        ],
      },
    });

    const all = await fake.queryHistory('AKR1');
    expect(all.ok).toBe(true);
    expect(all.items).toHaveLength(2);
    for (const item of all.items) expect('markupVersion' in item).toBe(false);

    const sent = await fake.queryHistory('AKR1', { sendOnly: true });
    expect(sent.items).toHaveLength(1);
    for (const item of sent.items) expect('markupVersion' in item).toBe(false);
  });

  it('queryHistory passes through server-derived title/version/status and preserves the 9 base fields', async () => {
    const fake = createFakeModel({
      histories: {
        AKR1: [
          {
            id: 3, articleId: 'AKR1', eventType: 'status', action: 'send',
            fromStatus: 'RDS', toStatus: 'DPS', actorUserId: 'kim', createdAt: '2026-06-14T03:00:00Z',
            hasSnapshot: 0, title: '헤드라인', version: 3, status: 'DPS',
            markupVersion: 'blob',
          },
        ],
      },
    });

    const { items } = await fake.queryHistory('AKR1');
    // 파생 필드는 fake가 계산하지 않고 시드 값 그대로(파생 규칙의 진실은 백엔드 historyMeta) +
    // 기존 9필드(id/articleId/eventType/action/fromStatus/toStatus/actorUserId/createdAt/hasSnapshot) 보존.
    expect(items[0]).toEqual({
      id: 3, articleId: 'AKR1', eventType: 'status', action: 'send',
      fromStatus: 'RDS', toStatus: 'DPS', actorUserId: 'kim', createdAt: '2026-06-14T03:00:00Z',
      hasSnapshot: 0, title: '헤드라인', version: 3, status: 'DPS',
    });
  });

  it('queryHistory leaves the seed blob intact so getHistorySnapshot still returns the body (같은 배열 공유)', async () => {
    const BODY = '{"format":"yh-editor","version":1,"blocks":[{"type":"text","text":"옛본문"}]}';
    const seed = {
      histories: {
        AKR1: [
          { id: 2, articleId: 'AKR1', eventType: 'edit', action: null, actorUserId: 'lee', createdAt: '2026-06-14T02:00:00Z', hasSnapshot: 1, markupVersion: BODY },
        ],
      },
    };
    const fake = createFakeModel(seed);

    await fake.queryHistory('AKR1');
    // 원본 시드 객체는 변형되지 않는다(목록 반환에서만 blob 제외 — delete/대입 금지).
    expect(seed.histories.AKR1[0].markupVersion).toBe(BODY);

    // 이어서 같은 배열을 읽는 단건 스냅샷 조회가 본문을 정상 반환한다(기사이력비교 경로).
    const snap = await fake.getHistorySnapshot('AKR1', 2);
    expect(snap.ok).toBe(true);
    expect(snap.item.markupVersion).toBe(BODY);
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

  // --- 배부 대상(phase 46) — 서버 계약(/api/distribution-targets)과 같은 shape을 in-memory로 모사 ---
  it('createDistributionTarget→queryDistributionTargets round-trips with active defaulted to Y', async () => {
    const fake = createFakeModel();

    const r = await fake.createDistributionTarget({ name: 'KBS', kind: 'press', spoolDir: 'kbs' });
    expect(r.ok).toBe(true);
    expect(r.id).toBeTruthy();

    const q = await fake.queryDistributionTargets();
    expect(q.ok).toBe(true);
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({
      id: r.id, name: 'KBS', kind: 'press', spoolDir: 'kbs', active: 'Y', // active 미지정 → 서버와 동형으로 'Y'
    });
    expect(q.items[0].createdAt).toBeTruthy();

    // 반환 items는 복사본이라 고쳐도 스토어는 불변.
    q.items[0].name = 'tampered';
    expect((await fake.queryDistributionTargets()).items[0].name).toBe('KBS');
  });

  it('createDistributionTarget ignores client-sent id/createdAt and stamps its own (server 동형)', async () => {
    const fake = createFakeModel();

    const r = await fake.createDistributionTarget({
      id: 999, name: 'MBC', kind: 'nonpress', spoolDir: 'mbc', active: 'N', createdAt: '1999-01-01T00:00:00Z',
    });
    const { items } = await fake.queryDistributionTargets();
    expect(items[0].id).toBe(r.id);
    expect(items[0].id).not.toBe(999);
    expect(items[0].createdAt).not.toBe('1999-01-01T00:00:00Z');
    // active는 클라 지정값을 존중한다(서버는 Y|N만 허용 — 검증의 진실은 서버).
    expect(items[0].active).toBe('N');
  });

  it('deactivateDistributionTarget keeps the row and flips active to N (soft delete, 행 삭제 없음)', async () => {
    const fake = createFakeModel();
    const { id } = await fake.createDistributionTarget({ name: 'SBS', kind: 'press', spoolDir: 'sbs' });

    const d = await fake.deactivateDistributionTarget(id);
    expect(d).toEqual({ ok: true, changes: 1 });

    const { items } = await fake.queryDistributionTargets();
    expect(items).toHaveLength(1); // 목록에서 사라지지 않는다.
    expect(items[0]).toMatchObject({ id, name: 'SBS', active: 'N' });
  });

  it('updateDistributionTarget merges present-only fields and 404s on an unknown id (deactivate도 동형)', async () => {
    const fake = createFakeModel();
    const { id } = await fake.createDistributionTarget({ name: 'KBS', kind: 'press', spoolDir: 'kbs' });

    const u = await fake.updateDistributionTarget(id, { name: '한국방송', kind: undefined, id: 42, createdAt: 'x' });
    expect(u).toEqual({ ok: true, changes: 1 });

    const { items } = await fake.queryDistributionTargets();
    // 전달한 필드만 반영 — 나머지(kind/spoolDir/active)와 서버 소유 필드(id/createdAt)는 불변.
    expect(items[0]).toMatchObject({ id, name: '한국방송', kind: 'press', spoolDir: 'kbs', active: 'Y' });
    expect(items[0].createdAt).not.toBe('x');

    expect(await fake.updateDistributionTarget(9999, { name: 'x' })).toEqual({ ok: false, reason: 'not-found' });
    expect(await fake.deactivateDistributionTarget(9999)).toEqual({ ok: false, reason: 'not-found' });
  });

  // --- 배부 실패 복구/실행(phase 57 MVP-4) — 서버 계약(/api/distribution/{failures,retry,tick})과 같은 shape 모사 ---
  it('queryDistributionFailures returns seeded items as copies (원본 불변) and honors limit', async () => {
    const seedItems = [
      {
        articleId: 'AKR1', targetId: 3, kind: 'press', reason: 'spool-write-failed',
        failedAt: '2026-08-01T00:00:00.000Z', historyId: 11,
        targetName: 'KBS', targetActive: 'Y', targetKind: 'press', kindDistributed: true,
      },
      {
        articleId: 'AKR2', targetId: 4, kind: 'nonpress', reason: 'invalid-spool-dir',
        failedAt: '2026-08-02T00:00:00.000Z', historyId: 12,
        targetName: '사내망', targetActive: 'N', targetKind: 'nonpress', kindDistributed: false,
      },
    ];
    const fake = createFakeModel({ distributionFailures: seedItems });

    const r = await fake.queryDistributionFailures();
    expect(r.ok).toBe(true);
    expect(r.items).toHaveLength(2);
    expect(r.items[0]).toEqual(seedItems[0]);

    // 반환 배열/항목을 변형해도 seed는 안 바뀐다(복사본 계약).
    r.items[0].reason = 'tampered';
    r.items.length = 0;
    expect((await fake.queryDistributionFailures()).items[0].reason).toBe('spool-write-failed');

    // limit이 있으면 앞에서 잘라 준다.
    expect((await fake.queryDistributionFailures({ limit: 1 })).items).toHaveLength(1);
  });

  it('queryDistributionFailures passes through the full server shape (targetKind/kindDistributed 그대로 — 기본값 조작 없음)', async () => {
    const fake = createFakeModel({
      distributionFailures: [{
        articleId: 'AKR9', targetId: 8, kind: 'press', reason: 'invalid-article-id',
        failedAt: '2026-08-03T00:00:00.000Z', historyId: 21,
        targetName: 'MBC', targetActive: 'Y', targetKind: 'nonpress', kindDistributed: false,
      }],
    });
    const { items } = await fake.queryDistributionFailures();
    expect(items[0].targetKind).toBe('nonpress');
    expect(items[0].kindDistributed).toBe(false);
  });

  it('retryDistribution resolves the matching failure so it disappears from the list', async () => {
    const fake = createFakeModel({
      distributionFailures: [
        { articleId: 'AKR1', targetId: 3, kind: 'press', reason: 'spool-write-failed', failedAt: '2026-08-01T00:00:00.000Z', historyId: 11, targetName: 'KBS', targetActive: 'Y', targetKind: 'press', kindDistributed: true },
        { articleId: 'AKR2', targetId: 4, kind: 'nonpress', reason: 'spool-write-failed', failedAt: '2026-08-02T00:00:00.000Z', historyId: 12, targetName: '사내망', targetActive: 'Y', targetKind: 'nonpress', kindDistributed: true },
      ],
    });

    const r = await fake.retryDistribution('AKR1', 3);
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ articleId: 'AKR1', targetId: 3, kind: 'press' });
    expect(r.at).toBeTruthy();

    const { items } = await fake.queryDistributionFailures();
    expect(items).toHaveLength(1);
    expect(items[0].articleId).toBe('AKR2');
  });

  it('retryDistribution returns no-failure for an unknown pair (서버 어휘 동형)', async () => {
    const fake = createFakeModel({
      distributionFailures: [
        { articleId: 'AKR1', targetId: 3, kind: 'press', reason: 'spool-write-failed', failedAt: '2026-08-01T00:00:00.000Z', historyId: 11, targetName: 'KBS', targetActive: 'Y', targetKind: 'press', kindDistributed: true },
      ],
    });
    expect(await fake.retryDistribution('AKR1', 999)).toEqual({ ok: false, reason: 'no-failure' });
    expect(await fake.retryDistribution('NOPE', 3)).toEqual({ ok: false, reason: 'no-failure' });
    // 미해소 목록은 그대로다(거부는 무부수효과).
    expect((await fake.queryDistributionFailures()).items).toHaveLength(1);
  });

  it('runDistributionTick returns the tick summary shape (seed 주입 가능, 기본값 제공)', async () => {
    const fake = createFakeModel();
    const r = await fake.runDistributionTick();
    expect(r.ok).toBe(true);
    expect(r.at).toBeTruthy();
    expect(typeof r.scanned).toBe('number');
    expect(Array.isArray(r.distributed)).toBe(true);
    expect(Array.isArray(r.failed)).toBe(true);
    expect(Array.isArray(r.invalid)).toBe(true);

    const seeded = createFakeModel({
      tickResult: {
        ok: true, at: '2026-08-06T00:00:00.000Z', scanned: 2,
        distributed: [{ articleId: 'AKR1', kinds: ['press'], status: 'DPS' }],
        failed: [], invalid: [],
      },
    });
    const s = await seeded.runDistributionTick();
    expect(s.scanned).toBe(2);
    expect(s.distributed).toHaveLength(1);
  });

  it('queryDistributionTargets applies equality filters (active/kind) over the allowed keys', async () => {
    const fake = createFakeModel();
    const a = await fake.createDistributionTarget({ name: 'KBS', kind: 'press', spoolDir: 'kbs' });
    await fake.createDistributionTarget({ name: '사내망', kind: 'nonpress', spoolDir: 'intra' });
    await fake.deactivateDistributionTarget(a.id);

    const active = await fake.queryDistributionTargets({ active: 'Y' });
    expect(active.items.map((t) => t.spoolDir)).toEqual(['intra']);

    const press = await fake.queryDistributionTargets({ kind: 'press' });
    expect(press.items.map((t) => t.spoolDir)).toEqual(['kbs']);

    const byDir = await fake.queryDistributionTargets({ spoolDir: 'intra' });
    expect(byDir.items).toHaveLength(1);

    // 허용 목록 밖 키는 무시된다(서버 pickFilters와 동형).
    expect((await fake.queryDistributionTargets({ nope: 'zzz' })).items).toHaveLength(2);
  });
});
