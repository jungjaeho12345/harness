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
const ONE_HOUR_MS = 60 * 60 * 1000;
const ROLES = new Set(['R', 'D', 'Z']);

// 세션 쿠키 transport (security-hardening step0).
// 외부 의존성 최소화(ADR 철학) — cookie-parser 추가 대신 Cookie 헤더를 직접 파싱한다.
// 토큰은 무작위 64-hex이며 권한/역할 정보를 담지 않는다(news.md, ADR-004).
export const SESSION_COOKIE_NAME = 'sid';
const SESSION_COOKIE_MAX_AGE_MS = ONE_HOUR_MS; // 1시간 — 슬라이딩 만료 권위는 sessionService(쿠키는 보조).

// 쿠키 옵션 빌더 — sameSite/secure는 env로 분기한다.
// CRITICAL(cross-site): SPA(:5173)와 API(:3001)는 다른 origin = cross-site다(ADR-001).
// 브라우저는 SameSite=Strict/Lax 쿠키를 cross-site fetch/EventSource에 첨부하지 않으므로,
// 프로덕션(https)은 SameSite=None+Secure로 cross-site 전송을 허용한다.
// 로컬/테스트(http)는 Secure를 켤 수 없고 SameSite=None은 Secure 없이 브라우저가 거부하므로
// SameSite=Lax(Secure 없음)로 둔다(로컬은 동일 머신/프록시 운용·서버 테스트는 직접 Cookie 헤더).
// 만료의 단일 진실은 서버 세션 스토어(sessionService)이며 maxAge는 보조일 뿐이다.
export function sessionCookieOptions(env = process.env.NODE_ENV) {
  const isProd = env === 'production';
  return {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'none' : 'lax',
    maxAge: ONE_HOUR_MS,
    path: '/',
  };
}

// HTTPS 강제 미들웨어 빌더 (security-hardening step1).
// env로 분기한다 — 프로덕션이 아니면 no-op(로컬/테스트는 http로 띄우므로 강제가 꺼져야 한다).
// 프로덕션: TLS 종단(리버스 프록시) 뒤에서 X-Forwarded-Proto/req.secure로 평문 여부를 판정해
//   동일 경로의 https로 308 리다이렉트한다. 308은 메서드·바디를 보존하므로 GET/비-GET 모두 안전하다
//   (301/302는 POST를 GET으로 바꿔 바디를 잃을 수 있다). trust proxy=1 신뢰는 createApp에서 설정한다.
export function enforceHttps(env = process.env.NODE_ENV) {
  if (env !== 'production') {
    return (_req, _res, next) => next();
  }
  return (req, res, next) => {
    // trust proxy 설정 시 req.secure는 X-Forwarded-Proto를 반영한다(직접 헤더 신뢰는 스푸핑 위험).
    const proto = req.secure ? 'https' : req.get('x-forwarded-proto');
    if (proto === 'https') return next();
    const host = req.get('host');
    return res.redirect(308, `https://${host}${req.originalUrl}`);
  };
}
const ACTION_SET = new Set(['send', 'hold', 'kill', 'approveDelete']);
const DERIVE_MODE_SET = new Set(['followUp', 'continue']);

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
  locked: 401,
  'forbidden-transition': 409,
  'unknown-role': 403,
  'no-end-marker': 400,
  'unknown-action': 400,
  'unknown-mode': 400,
  'unknown-capability': 400,
  unregistered: 403,
};

function fail(res, result, fallback = 400) {
  return res.status(STATUS_BY_REASON[result.reason] ?? fallback).json(result);
}

// Cookie 헤더에서 단일 쿠키 값을 파싱한다. 외부 의존성(cookie-parser) 없이 처리(ADR 최소 의존성).
// 잘못된 퍼센트 인코딩(예: %zz)이면 decodeURIComponent가 URIError를 던진다 — 클라 제어 입력이므로
// 500이 아니라 원본값으로 폴백한다(세션 sid는 hex라 디코딩 불필요, 인증 실패는 401로 수렴).
function parseCookie(header, name) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      const raw = part.slice(eq + 1).trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
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

// 번역 대상 본문 추출 — getById가 돌려주는 { article, contents }에서 본문 텍스트를 만든다.
// 본문은 Article.markupVersion에 블록 JSON({...,"blocks":[{text}...]})으로 저장된다 →
// 블록 text를 \n으로 잇는다(articleService.hasEndMarker와 동일 규칙). 파싱 실패/빈 본문이면
// contents.title → article.title → '' 순으로 폴백한다. CRITICAL: 본문은 서버 DB에서만 취한다(ADR-004).
function articleToText(found = {}) {
  const article = found.article ?? {};
  const raw = article.markupVersion;
  if (raw) {
    try {
      const doc = JSON.parse(raw);
      if (doc && Array.isArray(doc.blocks)) {
        const text = doc.blocks
          .map((b) => (b && typeof b.text === 'string' ? b.text : ''))
          .join('\n')
          .trim();
        if (text) return text;
      }
    } catch {
      // 평문 레거시 본문 — 그대로 사용한다.
      const text = String(raw).trim();
      if (text) return text;
    }
  }
  return found.contents?.title ?? article.title ?? '';
}

// env: 프로덕션 판별 기준(테스트에서 'production' 주입 가능). 미주입 시 process.env.NODE_ENV.
// cookieSecure: Secure 속성 토글. 미주입 시 isProd(프로덕션 HTTPS에서만 true). dev/test(HTTP)는 false여야 쿠키가 실린다.
// forceHttps: HTTPS 강제 토글. 미주입 시 isProd. true면 HSTS 적용 + 평문 HTTP를 https로 308 리다이렉트.
//   Secure 쿠키와 같은 환경(prod)을 전제로 한다 — HSTS/리다이렉트는 https 보장과 함께만 의미가 있다.
export function createApp({
  controllers,
  sessionService,
  env = process.env.NODE_ENV,
  cookieSecure,
  forceHttps,
}) {
  const app = express();

  // 프로덕션 판별 — env로 HSTS·Secure 쿠키·HTTPS 강제 등 프로덕션 전용 보안 설정을 분기한다.
  const isProd = env === 'production';
  // Secure 쿠키 토글: 명시 주입 우선, 없으면 프로덕션에서만 켠다(로컬 http에서 쿠키 전송이 막히지 않도록).
  const secure = cookieSecure ?? isProd;
  // HTTPS 강제 토글: 명시 주입 우선, 없으면 프로덕션에서만 켠다(forceHttps:true 또는 env==='production' 둘 다 강제).
  const httpsEnforced = forceHttps ?? isProd;

  // TLS 종단 리버스 프록시 뒤에서만, 첫 프록시(1홉)의 X-Forwarded-Proto/IP를 신뢰한다.
  // 'true'(무제한 신뢰)는 X-Forwarded-* 스푸핑으로 https 강제·레이트리밋이 우회되므로 쓰지 않는다.
  // 비프로덕션은 프록시가 없으므로 미설정(기본 false) — 로컬/테스트 무영향.
  if (httpsEnforced) app.set('trust proxy', 1);

  app.use(helmet({
    // HSTS는 HTTPS 응답에서만 의미가 있다 — HTTP dev에 보내면 이후 접속이 깨질 수 있으므로 토글로 끈다(httpsEnforced).
    // 운영(prod) 적합값: max-age 6개월 + includeSubDomains. preload는 무분별 등록 방지차 비활성.
    strictTransportSecurity: httpsEnforced
      ? { maxAge: 15552000, includeSubDomains: true, preload: false }
      : false,
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
  // credentials:true — 쿠키를 cross-origin으로 주고받기 위함. allowlist 유지(origin:* 금지: 브라우저가 credentials와 함께 거부).
  app.use(cors({
    // credentials 모드에서는 와일드카드 origin 금지 → 명시 allowlist가 필수.
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-session-id', 'x-collection-token'],
    credentials: true,
  }));

  // HTTP→HTTPS 리다이렉트 — helmet/CORS 다음, 라우트보다 앞. 토글 OFF면 no-op(HTTP 그대로 통과).
  // X-Forwarded-Proto가 https가 아니면 동일 host/경로의 https로 308(메서드·본문 보존) 리다이렉트한다.
  // CRITICAL: cors 미들웨어보다 뒤에 둬야 CORS preflight(OPTIONS)가 먼저 응답을 끝내고 여기 도달하지 않는다.
  if (httpsEnforced) {
    app.use((req, res, next) => {
      // trust proxy 설정 시 req.secure는 X-Forwarded-Proto를 반영한다(직접 헤더 신뢰는 스푸핑 위험).
      if (req.secure || req.get('x-forwarded-proto') === 'https') return next();
      const host = req.get('host');
      if (!host) return next(); // host 없는 비정상 요청은 강제 대상 외 — 라우트가 처리.
      return res.redirect(308, `https://${host}${req.originalUrl}`);
    });
  }

  app.use(express.json());

  // 세션 쿠키 발급 — HttpOnly(XSS 토큰 탈취 차단), Path=/, 슬라이딩 만료 정합 Max-Age.
  // SameSite: Secure일 때(prod) None으로 cross-origin 허용, 아닐 때(dev/test) Lax(None은 Secure 필수라 거부됨 → dev는 헤더 폴백).
  function setSessionCookie(res, sessionId) {
    res.cookie(SESSION_COOKIE_NAME, sessionId, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/',
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });
  }

  function clearSessionCookie(res) {
    res.cookie(SESSION_COOKIE_NAME, '', {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/',
      maxAge: 0,
    });
  }

  // 요청에서 세션 토큰 판독 — 쿠키 우선, x-session-id 헤더 폴백(전환 기간 무회귀).
  function readSessionToken(req) {
    return parseCookie(req.get('cookie'), SESSION_COOKIE_NAME) || req.get('x-session-id');
  }

  // SSE 무효화 버스 — 기사 create/update/status/lock 변경 시 신호만 브로드캐스트한다(행 데이터 없음).
  const bus = new EventEmitter();
  bus.setMaxListeners(0); // 동시 SSE 구독자 수 제한 경고 방지.
  // 부트스트랩(watcher 등 HTTP 밖 경로)에서도 무효화를 알릴 수 있도록 노출한다.
  app.notifyChange = (kind) => bus.emit('change', { kind });

  // 쿠키(우선) 또는 x-session-id 헤더(폴백) → 검증된 신원. req.body.role은 절대 쓰지 않는다.
  function sessionOf(req) {
    const sid = readSessionToken(req);
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
      if (r.ok) {
        // 세션 토큰을 쿠키로도 운반(헤더 응답 sessionId는 전환 기간 폴백으로 유지).
        setSessionCookie(res, r.sessionId);
        return res.json(r);
      }
      // 로그인 전용 매핑: 계정 잠금은 423 Locked. STATUS_BY_REASON.locked(409, 기사 편집 잠금)는 건드리지 않는다.
      if (r.reason === 'locked') return res.status(423).json(r);
      return fail(res, r, 401);
    } catch (e) { next(e); }
  });

  app.post('/api/logout', (req, res) => {
    const sid = readSessionToken(req) || req.body?.sessionId;
    controllers.auth.logout(sid);
    clearSessionCookie(res); // 세션 쿠키 만료(Max-Age=0).
    return res.json({ ok: true });
  });

  // F5 복원 — 재인증 없이 세션으로 신원을 돌려준다(쿠키 우선, x-session-id 헤더 폴백).
  // 평문 ?session= 쿼리 폴백은 제거했다 — URL/로그 누출 표면이므로 쿠키·헤더만 허용한다.
  app.get('/api/session', (req, res) => {
    const sid = readSessionToken(req);
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
      const r = controllers.receiverConfig.query(readSessionToken(req), req.query);
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  app.post('/api/receiver-config', (req, res, next) => {
    try {
      const r = controllers.receiverConfig.create(readSessionToken(req), req.body ?? {});
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  app.delete('/api/receiver-config/:id', (req, res, next) => {
    try {
      const r = controllers.receiverConfig.remove(readSessionToken(req), Number(req.params.id));
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

  // 단건 조회 — 본문(Article.markupVersion)을 포함한 전체 기사. 읽기 전용(DB 비파괴).
  // 편집 진입 시 목록행(Contents)에 없는 본문을 채우는 데 쓴다. /search 보다 뒤에 등록해 :id 충돌을 피한다.
  app.get('/api/articles/:id', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      const r = controllers.article.getById(req.params.id);
      if (!r) return res.status(404).json({ ok: false, reason: 'not-found' });
      return res.json({ ok: true, article: r.article, contents: r.contents });
    } catch (e) { next(e); }
  });

  // 이력 조회 — 편집/생애주기 이벤트 로그. 인증 세션 게이트, 읽기 전용(DB 비파괴).
  // sendOnly(=1/type=send)면 송고 이력만(필터는 step1 서비스가 강제). 이력 없음은 빈 배열(404 아님).
  // controllers.article.queryHistory에 위임만 한다(ADR-006). /search·:id 뒤, 하위 라우트 그룹.
  app.get('/api/articles/:id/history', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      const flag = req.query.sendOnly;
      const sendOnly = (flag !== undefined && flag !== '0' && flag !== 'false')
        || req.query.type === 'send';
      const items = controllers.article.queryHistory(req.params.id, { sendOnly });
      return res.json({ ok: true, items });
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

  // 후속/계속기사작성 — 원본을 바탕으로 "새 기사"를 만든다(신규 작성과 동일 권한 R/D/Z).
  // 얇은 transport(ADR-006): 세션 게이트 → author를 세션 사용자로 stamp → controllers.article.derive 위임 → shape 매핑.
  // 파생 로직(필드 복사·articleId 발급·원본 비변경)은 step3 서비스가 강제한다 — 여기서 재구현하지 않는다.
  // CRITICAL(ADR-004): author는 세션에서 stamp하고 클라가 보낸 author/role/status/articleId는 무시한다.
  app.post('/api/articles/:id/derive', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      if (!ROLES.has(me.role)) return res.status(403).json(FORBIDDEN);
      const mode = req.body?.mode;
      if (!DERIVE_MODE_SET.has(mode)) return res.status(400).json({ ok: false, reason: 'unknown-mode' });
      // author는 세션 사용자(부서 등 나머지 공통정보는 서비스가 원본에서 복사). 클라 author/role/status/articleId 무시.
      const r = controllers.article.derive(req.params.id, mode, { author: me.name ?? me.userId });
      if (!r.ok) return fail(res, r);
      app.notifyChange('create');
      return res.json(r);
    } catch (e) { next(e); }
  });

  // 번역 — 기사 본문을 외부 번역 API로 번역한다(형태 (A) 확정, ADR-004 신뢰 경계).
  // 얇은 transport(ADR-006): 세션 게이트 → 서버가 DB에서 본문 조회 → controllers.translation.run 위임 → graceful 객체 그대로 반환.
  // CRITICAL: 번역 대상 본문은 서버 DB에서만 조회한다 — 클라가 보낸 text는 신뢰하지 않는다.
  // graceful degrade(news.md): 키 누락/외부 실패는 500으로 감싸지 않고 서비스가 준 객체를 그대로 내려준다.
  // 읽기 전용 — DB를 변경하지 않는다. /search·:id 뒤, 하위 라우트 그룹.
  app.post('/api/articles/:id/translate', async (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      const found = controllers.article.getById(req.params.id);
      if (!found) return res.status(404).json({ ok: false, reason: 'not-found' });
      const text = articleToText(found);
      const targetLang = req.body?.targetLang ?? 'ko';
      const r = await controllers.translation.run(text, targetLang);
      return res.json(r); // graceful 객체 그대로(키 누락/실패도 500 아님).
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
  // 인증은 쿠키 우선(readSessionToken: 쿠키→x-session-id 헤더)만 허용한다.
  // 평문 ?session= 쿼리 폴백은 제거했다 — URL/프록시 로그 누출 표면이므로 쿠키·헤더만 신뢰한다.
  app.get('/api/stream', (req, res) => {
    const sid = readSessionToken(req);
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
  // HTTPS 강제는 운영 기준(NODE_ENV==='production')에서 켜되, FORCE_HTTPS로 명시 오버라이드 허용.
  // 앱은 TLS 종단을 하지 않는다(HSTS+리다이렉트만) — 인증서/HTTPS 서버는 외부 프록시 책임(범위 밖).
  const forceHttps = process.env.FORCE_HTTPS === 'true'
    || (process.env.FORCE_HTTPS !== 'false' && process.env.NODE_ENV === 'production');
  const app = createApp({ controllers, sessionService, forceHttps });

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
