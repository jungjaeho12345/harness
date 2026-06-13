// 얇은 HTTP/SSE transport (ADR-006). 비즈니스 로직 없음 — 컨트롤러 위임 + 인가 게이트 + shape 매핑만.
// CRITICAL: acting role은 검증된 x-session-id 세션에서만 도출한다. req.body.role은 절대 신뢰하지 않는다 (ADR-004).
// 의존성(controllers, sessionService)은 주입받는다 — 테스트는 in-memory db/서비스로 구동한다.
// SSE(/api/stream)는 행 데이터 없는 "무효화 신호"만 브로드캐스트한다 (ADR-005).

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { EventEmitter } from 'node:events';

// 프로덕션 부트스트랩 전용 import — 테스트 import 시에는 사용되지 않는다(부트스트랩 가드).
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSchema } from '../src/db/schema.js';
import { createSessionService } from '../src/services/sessionService.js';
import { createControllers } from '../src/controllers/index.js';
import { createFtpWatcher } from './ftpWatcher.js';

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const ROLES = new Set(['R', 'D', 'Z']);
const ACTION_SET = new Set(['send', 'hold', 'kill', 'approveDelete']);

const UNAUTH = { ok: false, reason: 'unauthenticated' };
const FORBIDDEN = { ok: false, reason: 'forbidden' };

// 컨트롤러/서비스가 돌려주는 거부 reason → HTTP 상태 코드. 미정의는 fallback.
const STATUS_BY_REASON = {
  unauthenticated: 401,
  'invalid-credentials': 401,
  inactive: 403,
  forbidden: 403,
  'not-holder': 403,
  'not-dps': 403,
  'not-found': 404,
  locked: 409,
  'forbidden-transition': 409,
  'unknown-role': 403,
  'no-end-marker': 400,
  'unknown-action': 400,
  'unknown-capability': 400,
  unregistered: 403,
};

function fail(res, result, fallback = 400) {
  return res.status(STATUS_BY_REASON[result.reason] ?? fallback).json(result);
}

// GET /api/articles 에서 허용하는 조회 필터 — 화이트리스트만 모델로 전달한다.
// (Express는 ?status=A&status=B 같은 반복 파라미터를 배열로 파싱 → status IN / departments IN.)
const FILTER_KEYS = [
  'articleId', 'author', 'sender', 'status', 'excludeStatus',
  'department', 'departments',
  'createdAtFrom', 'createdAtTo', 'sentAtFrom', 'sentAtTo', 'distributedAtFrom', 'distributedAtTo',
];

function pickFilters(query = {}) {
  const f = {};
  for (const k of FILTER_KEYS) if (query[k] !== undefined) f[k] = query[k];
  return f;
}

export function createApp({ controllers, sessionService }) {
  const app = express();

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // 외부 썸네일(Google 이미지/YouTube)·data URI 미리보기 허용.
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        // 본문 임베드(YouTube iframe) 허용. 그 외 프레임 삽입은 자기 출처만.
        frameSrc: ["'self'", 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
        frameAncestors: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  }));
  app.use(cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-session-id', 'x-collection-token'],
  }));
  app.use(express.json());

  // SSE 무효화 버스 — 기사 create/update/status/lock 변경 시 신호만 브로드캐스트한다(행 데이터 없음).
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // 동시 SSE 구독자 수 제한 경고 방지.
  // 부트스트랩(watcher 등 HTTP 밖 경로)에서도 무효화를 알릴 수 있도록 노출한다.
  app.notifyChange = (kind) => bus.emit('change', { kind });

  // x-session-id → 검증된 신원. req.body.role은 절대 쓰지 않는다.
  function sessionOf(req) {
    const sid = req.get('x-session-id');
    return { sid, me: sid ? sessionService.touchSession(sid) : undefined };
  }

  // --- health ---
  app.get('/api/health', (_req, res) => res.json({ ok: true }));

  // --- 인증 / 세션 ---
  const loginLimiter = rateLimit({
    windowMs: FIFTEEN_MIN_MS,
    limit: 10, // 15분/10회 (news.md 로그인 워크플로우)
    standardHeaders: true,
    legacyHeaders: false,
  });

  app.post('/api/login', loginLimiter, async (req, res, next) => {
    try {
      const { userId, password } = req.body ?? {};
      const r = await controllers.auth.login(userId, password);
      return r.ok ? res.json(r) : fail(res, r, 401);
    } catch (e) { next(e); }
  });

  app.post('/api/logout', (req, res) => {
    const sid = req.get('x-session-id') || req.body?.sessionId;
    controllers.auth.logout(sid);
    return res.json({ ok: true });
  });

  // F5 복원 — 재인증 없이 세션으로 신원을 돌려준다(EventSource 폴백 호환 위해 ?session= 도 허용).
  app.get('/api/session', (req, res) => {
    const sid = req.get('x-session-id') || req.query.session;
    const me = sid ? sessionService.touchSession(sid) : undefined;
    if (!me) return res.status(401).json(UNAUTH);
    return res.json({ ok: true, user: me });
  });

  // --- 사용자 관리 ---
  // GET: Z=전체 명단(비밀번호 제외), 그 외=부서 등 최소 필드.
  app.get('/api/users', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      if (me.role === 'Z') return res.json({ ok: true, items: controllers.user.query({}) });
      const items = controllers.user.query({}).map((u) => ({
        userId: u.userId, name: u.name, department: u.department, departmentCode: u.departmentCode,
      }));
      return res.json({ ok: true, items });
    } catch (e) { next(e); }
  });

  // POST/PUT: Z 전용(authorization 게이트). 실제 영속은 controllers.user에 위임(비밀번호는 응답에 없음).
  app.post('/api/users', (req, res, next) => {
    try {
      const { sid } = sessionOf(req);
      const gate = controllers.auth.manageUsers(sid, 'create', req.body ?? {});
      if (!gate.ok) return fail(res, gate);
      return res.json(controllers.user.create(req.body ?? {}));
    } catch (e) { next(e); }
  });

  app.put('/api/users/:id', (req, res, next) => {
    try {
      const { sid } = sessionOf(req);
      const gate = controllers.auth.manageUsers(sid, 'update', req.body ?? {});
      if (!gate.ok) return fail(res, gate);
      return res.json(controllers.user.update(req.params.id, req.body ?? {}));
    } catch (e) { next(e); }
  });

  // --- 수신 설정 (Z 전용 — 게이트는 receiverConfigService가 강제) ---
  app.get('/api/receiver-config', (req, res, next) => {
    try {
      const r = controllers.receiverConfig.query(req.get('x-session-id'), req.query);
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  app.post('/api/receiver-config', (req, res, next) => {
    try {
      const r = controllers.receiverConfig.create(req.get('x-session-id'), req.body ?? {});
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  app.delete('/api/receiver-config/:id', (req, res, next) => {
    try {
      const r = controllers.receiverConfig.remove(req.get('x-session-id'), Number(req.params.id));
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  // --- 기사 조회/검색 ---
  app.get('/api/articles/search', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      return res.json({ ok: true, items: controllers.article.search(req.query.q ?? '') });
    } catch (e) { next(e); }
  });

  app.get('/api/articles', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      return res.json({ ok: true, items: controllers.article.query(pickFilters(req.query)) });
    } catch (e) { next(e); }
  });

  // 신규 저장 — R/D/Z. 부서가 비면 세션 부서를 stamp한다. 신규는 항상 RDS로 저장(서비스).
  app.post('/api/articles', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      if (!ROLES.has(me.role)) return res.status(403).json(FORBIDDEN);
      const dto = { ...(req.body ?? {}) };
      delete dto.role; // 클라 role 무시.
      if (!dto.department) { dto.department = me.department; dto.departmentCode = me.departmentCode; }
      const r = controllers.article.create(dto);
      if (r.ok) app.notifyChange('create');
      return res.json(r);
    } catch (e) { next(e); }
  });

  // 송고/보류/KILL/삭제승인 — role은 세션에서만 도출(req.body.role 무시).
  // capability 게이트(미인증/정의 외 권한 거부)만 하고, (상태,권한,액션) 유효성은 applyAction/lifecycle이 강제한다.
  app.post('/api/articles/:id/action', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      if (!ROLES.has(me.role)) return res.status(403).json(FORBIDDEN);
      const action = req.body?.action;
      if (!ACTION_SET.has(action)) return res.status(400).json({ ok: false, reason: 'unknown-action' });
      const r = controllers.article.applyAction(req.params.id, me.role, action, { userId: me.userId });
      if (!r.ok) return fail(res, r, 409);
      app.notifyChange('status');
      return res.json(r);
    } catch (e) { next(e); }
  });

  // 부분 수정 — 편집 잠금 보유자(세션)만 가능.
  app.put('/api/articles/:id', (req, res, next) => {
    try {
      const { sid, me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      const hold = controllers.article.assertLockHolder(req.params.id, { sessionId: sid });
      if (!hold.ok) return fail(res, hold);
      const fields = { ...(req.body ?? {}), modifier: me.userId };
      delete fields.role;
      const r = controllers.article.update(req.params.id, fields);
      if (r.ok) app.notifyChange('update');
      return res.json(r);
    } catch (e) { next(e); }
  });

  // 편집 잠금 획득 — 단순 획득은 상태 전이를 일으키지 않는다.
  // DPS 기사의 편집 진입(고침/포털고침)은 D만 허용한다(authorization.editDps 게이트).
  // 비-DPS 기사는 인증된 R/D/Z가 획득할 수 있다(editDps가 not-dps를 돌려주면 통과).
  app.post('/api/articles/:id/lock', (req, res, next) => {
    try {
      const { sid, me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      const action = req.body?.action === 'portalRevise' ? 'portalRevise' : 'revise';
      const probe = controllers.auth.editDps(sid, req.params.id, action);
      if (probe.reason === 'not-found') return res.status(404).json(probe);
      if (!probe.ok && probe.reason !== 'not-dps') return fail(res, probe); // DPS인데 비-D 등 → forbidden
      const r = controllers.article.acquireEditLock(req.params.id, { userId: me.userId, sessionId: sid });
      if (r.ok) app.notifyChange('lock');
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  app.post('/api/articles/:id/unlock', (req, res, next) => {
    try {
      const { sid, me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      const r = controllers.article.releaseEditLock(req.params.id, { sessionId: sid });
      if (r.ok) app.notifyChange('lock');
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  // 강제 해제 — D/Z 전용.
  app.post('/api/articles/:id/force-unlock', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      if (me.role !== 'D' && me.role !== 'Z') return res.status(403).json(FORBIDDEN);
      const r = controllers.article.forceReleaseEditLock(req.params.id);
      if (r.ok) app.notifyChange('lock');
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  // --- 미디어 검색 프록시 (세션 게이트) ---
  app.get('/api/media/search', async (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      const r = await controllers.media.search(req.query.q ?? '', req.query.type);
      return res.json({ ok: true, items: r.items, error: r.error });
    } catch (e) { next(e); }
  });

  // --- 수집 인제스트 (사용자 세션 라우트 아님) ---
  // body { sourceId, payload } → collection.receive. 미등록 sourceId는 거부(collectionService 판정).
  // 외부 노출은 부트스트랩의 127.0.0.1 바인딩 + 선택적 토큰(COLLECTION_TOKEN)으로 좁힌다.
  app.post('/api/collection/receive', (req, res, next) => {
    try {
      const required = process.env.COLLECTION_TOKEN;
      if (required && req.get('x-collection-token') !== required) {
        return res.status(401).json(UNAUTH);
      }
      const { sourceId, payload } = req.body ?? {};
      const r = controllers.collection.receive(sourceId, payload);
      if (r.ok) { app.notifyChange('create'); return res.json(r); }
      return fail(res, r);
    } catch (e) { next(e); }
  });

  // --- SSE: 무효화 신호 스트림 ---
  // EventSource가 헤더를 못 보내므로 이 라우트 한정으로 ?session= 쿼리 인증 폴백을 허용한다.
  app.get('/api/stream', (req, res) => {
    const sid = req.get('x-session-id') || req.query.session;
    const me = sid ? sessionService.touchSession(sid) : undefined;
    if (!me) return res.status(401).json(UNAUTH);

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write('event: ready\ndata: {"ok":true}\n\n');

    const onChange = (signal) => res.write(`event: change\ndata: ${JSON.stringify(signal ?? {})}\n\n`);
    bus.on('change', onChange);
    req.on('close', () => bus.off('change', onChange));
  });

  // 전역 에러 핸들러 — 내부 스택을 노출하지 않는다 (4-arg, 마지막 등록).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    res.status(500).json({ ok: false, reason: 'internal-error' });
  });

  return app;
}

// --- 프로덕션 부트스트랩 (직접 실행 시에만) ---
// 테스트가 createApp을 import할 때는 아래가 실행되지 않는다 → listen/watcher 미기동.
function bootstrap() {
  const db = new DatabaseSync('news.db');
  createSchema(db); // 비파괴 멱등 마이그레이션만 — DROP/DELETE 없음.

  const sessionService = createSessionService();
  const controllers = createControllers(db, { sessionService });
  const app = createApp({ controllers, sessionService });

  const port = Number(process.env.PORT) || 3001;
  app.listen(port, '127.0.0.1', () => {
    console.log(`API server on http://127.0.0.1:${port}`);
  });

  // 수집 FTP watcher — RCV_SPOOL_DIR 미설정 시 비활성.
  const spoolDir = process.env.RCV_SPOOL_DIR;
  if (spoolDir) {
    const watcher = createFtpWatcher({
      dir: spoolDir,
      onFile: ({ sourceId, payload }) => {
        const r = controllers.collection.receive(sourceId, payload);
        if (r && r.ok) app.notifyChange('create');
      },
    });
    watcher.start();
    console.log(`FTP watcher watching ${spoolDir}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap();
}
