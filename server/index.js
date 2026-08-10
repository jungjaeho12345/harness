// 얇은 HTTP/SSE transport (ADR-006). 비즈니스 로직 없음 — 컨트롤러 위임 + 인가 게이트 + shape 매핑만.
// CRITICAL: acting role은 검증된 x-session-id 세션에서만 도출한다. req.body.role은 절대 신뢰하지 않는다 (ADR-004).
// 의존성(controllers)은 주입받는다 — 테스트는 in-memory db/서비스로 구동한다.
// 신원은 세션 스토어를 직접 만지지 않고 controllers.auth를 통해서만 얻는다(재검증 경로 단일화, ADR-004).
// SSE(/api/stream)는 행 데이터 없는 "무효화 신호"만 브로드캐스트한다 (ADR-005).

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import nodePath from 'node:path';
import crypto from 'node:crypto';
import { createLogService } from '../src/services/logService.js';

// 프로덕션 부트스트랩 전용 import — 테스트 import 시에는 사용되지 않는다(부트스트랩 가드).
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createSchema, backfillEmptyDepartments } from '../src/db/schema.js';
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

// CORS 옵션과 CSRF 가드가 같은 목록을 보도록 허용 출처를 단일 출처화한다 (ADR-009).
// 기본값은 오늘의 CORS allowlist와 동일하다 — dev 배선(Vite :5173)과 기존 preflight 테스트가 이 값에 묶여 있다.
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

// env.ALLOWED_ORIGINS(콤마 구분)가 있으면 트림·빈 값 제외 후 기본 목록 뒤에 append 한다.
// 별도 출처 SPA 배포/호스트 재작성 프록시는 이 변수로 명시 등록해야 한다(미설정 시 프로덕션 쓰기 403 — ADR-009).
// 프로덕션에서는 기본 loopback(:5173)을 제외한다 — 프로덕션 쿠키가 SameSite=None; Secure라 cross-site
// 요청에도 붙고, 이 목록은 CORS(응답 판독)와 CSRF 가드(쓰기 실행)가 공유한다. 그대로 두면 피해자 PC의
// http://localhost:5173으로 열린 임의의 로컬 페이지가 운영 API를 피해자 세션으로 호출·판독할 수 있다
// (Origin 위조가 필요 없다 — 브라우저가 진짜로 그 값을 보낸다). 프로덕션 정당 사용처는 없다.
// 판정은 인자로 받은 env만 본다(주입 seam 유지 — 함수 안에서 process.env를 따로 읽지 않는다).
export function allowedOrigins(env = process.env) {
  const extra = String(env?.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (env?.NODE_ENV === 'production') return extra;
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

// 부트 진단 — 프로덕션에서 허용 목록이 비면 자기 출처(리버스 프록시 동일 출처 배포) 외 모든 쓰기가
// 403 forbidden-origin이 된다(ADR-009 "가정과 실패 모드"). 이 실패는 조용하다: 로그인·조회는 되는데
// 저장/송고만 막혀 원인 추적이 어렵다. 동일 출처 배포는 정상 구성이므로 부팅을 막지 않고 경고만 남긴다.
// 반환값은 "경고를 남겼는가" — 테스트가 분기를 직접 확인하기 위한 것이고 호출부는 쓰지 않는다.
export function logOriginDiagnostics({ env = process.env, origins = allowedOrigins(env), logService }) {
  if (env?.NODE_ENV !== 'production') return false; // 비프로덕션 기본값은 공백이 아니다 — 경고가 소음이 된다.
  if (origins.length > 0) {
    // 출처 목록은 비밀이 아니다(브라우저가 그대로 보내는 값) — 실제 적용분을 남겨야 오탈자를 잡을 수 있다.
    logService.info(`allowed origins (CORS/CSRF): ${origins.join(', ')}`);
    return false;
  }
  logService.warn(
    'ALLOWED_ORIGINS is empty in production — every cross-origin write will be rejected with 403 forbidden-origin. '
    + 'This is expected for same-origin deployments (reverse proxy serving the SPA and /api together); '
    + 'set ALLOWED_ORIGINS only when the SPA is served from a different origin (ADR-009).',
  );
  return true;
}

// 비프로덕션 관용용 loopback 호스트(포트 무관). dev는 Vite 프록시로 동일 출처처럼 보이지만
// 브라우저가 보내는 Origin은 http://localhost:5173(포트가 밀리면 5174 등)이다.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopbackOrigin(origin) {
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return LOOPBACK_HOSTNAMES.has(u.hostname); // hostname은 포트를 제외한다(IPv6는 [::1] 형태).
  } catch {
    return false;
  }
}

// CSRF 방어 — 상태 변경 메서드(비 GET/HEAD/OPTIONS) 전용 Origin/Referer 게이트 (ADR-009).
// CORS는 simple request의 "실행"을 막지 않고 "응답 읽기"만 막는다 → 본문 없는 cross-site POST가
// 피해자 쿠키와 함께 실행되는 표면을 여기서 닫는다. 브라우저는 비-GET에 Origin을 항상 붙인다(Fetch 표준).
// CRITICAL: 자기 출처 판정에 X-Forwarded-Host(req.hostname)를 쓰지 않는다 — 스푸핑으로 게이트가 뚫린다.
//   호스트 재작성 배포는 origins(ALLOWED_ORIGINS)로 명시 등록한다.
// 라우트별 예외 목록은 두지 않는다 — 서버-서버 관용은 "Origin·Referer 부재" 단일 규칙으로만 표현한다.
export function csrfOriginGuard({ origins = [], isProd = false } = {}) {
  const allow = new Set(origins);
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    let claimed = req.get('origin');
    if (!claimed) {
      const referer = req.get('referer');
      // Origin·Referer 둘 다 없음 = 서버-서버/cron 클라이언트 → 통과(브라우저 공격 벡터가 아니다).
      if (!referer) return next();
      try {
        claimed = new URL(referer).origin;
      } catch {
        return res.status(403).json({ ok: false, reason: 'forbidden-origin' });
      }
    }

    if (claimed === `${req.protocol}://${req.get('host')}`) return next();
    if (allow.has(claimed)) return next();
    if (!isProd && isLoopbackOrigin(claimed)) return next();
    return res.status(403).json({ ok: false, reason: 'forbidden-origin' });
  };
}

const ACTION_SET = new Set(['send', 'hold', 'kill', 'approveDelete']);
const DERIVE_MODE_SET = new Set(['followUp', 'continue']);

// 업로드 확장자 화이트리스트(소문자 비교) + 디코드 크기 상한(5MB).
// 첨부/참고 파일은 Contents.attachmentFile / referenceFile(VARCHAR)에 path 문자열로 보관된다.
const UPLOAD_EXT_ALLOWLIST = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'txt', 'hwp', 'ppt', 'pptx',
]);
const UPLOAD_MAX_BYTES = 5 * 1024 * 1024; // 5MB — 디코드된 바이트 기준.

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
  // 배부 미설정(DIST_SPOOL_DIR 없음)은 클라이언트 잘못이 아니라 서버 기능 미가용이다.
  'spool-disabled': 503,
  // tick의 후보 조회 자체가 실패한 서버 장애 — 4xx(폴백 400)로 보고하면 운영 cron이 클라이언트 잘못으로 오인한다.
  'tick-failed': 500,
  // 배부 실패 재전송(ADR-008 MVP-4) — 재전송할 미해소 실패가 없다(대상 없음).
  'no-failure': 404,
  // 기사 상태가 배부 불가로 바뀐 상태 충돌.
  'status-changed': 409,
  // 수신처의 현재 kind가 실패 이력의 kind와 달라진 상태 충돌.
  'kind-changed': 409,
  // 재송고로 새 배부 사이클이 열려, 이전 사이클의 실패 행으로는 재전송할 수 없는 상태 충돌.
  'stale-cycle': 409,
  // 같은 수신처의 재전송이 이미 진행 중인 동시성 충돌.
  'retry-in-flight': 409,
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

// SSE 재인증 종료 계약 (phase 52 step3) — 클라이언트(step5)는 이 이벤트에서 EventSource를 닫는다.
// CRITICAL(프레임 종결): 끝의 빈 줄(\n\n)이 SSE 프레임 종결자다 — 마지막 \n을 빠뜨리면 브라우저가
//   이벤트를 디스패치하지 않아 클라이언트가 스트림을 닫지 못하고 무한 재연결이 남는다
//   (서버·클라이언트 테스트는 둘 다 green이라 실환경에서만 조용히 실패한다). ready 프레임과 같은 규율.
// 사유는 고정 토큰 하나만 싣는다 — 누가/왜(로그아웃·만료·강등·비활성)는 노출하지 않는다.
const UNAUTHORIZED_FRAME = 'event: unauthorized\ndata: {"ok":false,"reason":"unauthenticated"}\n\n';

// 두 SSE 라우트가 **같은 방식으로** 끝나게 하는 공통 종료기.
// close(): 구독 해제 → 종료 이벤트 1회 → res.end(). 중복 호출은 무시한다(플래그).
// 구독 해제를 먼저 하는 이유: 닫힌 응답에 write가 누적되면 리스너 누수와 예외가 된다.
// setUnsubscribe로 나중에 주입하는 이유: 구독 콜백이 종료기를 참조하고 종료기가 그 구독을 해제하는 순환 배선이다.
// 이미 200 헤더가 나간 뒤라 종료를 HTTP 상태로 표현할 수 없다 — 이벤트 + end()가 유일한 수단이다.
function createSseCloser(res) {
  let closed = false;
  let unsubscribe = () => {};
  return {
    setUnsubscribe(fn) { unsubscribe = fn; },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      res.write(UNAUTHORIZED_FRAME);
      res.end();
    },
  };
}

// env: 프로덕션 판별 기준(테스트에서 'production' 주입 가능). 미주입 시 process.env.NODE_ENV.
// cookieSecure: Secure 속성 토글. 미주입 시 isProd(프로덕션 HTTPS에서만 true). dev/test(HTTP)는 false여야 쿠키가 실린다.
// forceHttps: HTTPS 강제 토글. 미주입 시 isProd. true면 HSTS 적용 + 평문 HTTP를 https로 308 리다이렉트.
//   Secure 쿠키와 같은 환경(prod)을 전제로 한다 — HSTS/리다이렉트는 https 보장과 함께만 의미가 있다.
// logService: cross-cutting 인프라 — createApp에 직접 주입한다(컨트롤러 경유 금지).
//   기본값 제공으로 미주입 기존 테스트도 무회귀. 로그 message에는 식별용 최소 필드만 담는다
//   (비밀번호·세션 토큰·쿠키/Authorization 값·본문·payload 금지 — 마스킹 규율).
// origins: CORS allowlist와 CSRF 가드가 공유하는 허용 출처 목록(ADR-009). 미주입 시 allowedOrigins()
//   = 비프로덕션은 기본 두 항목 + process.env.ALLOWED_ORIGINS, 프로덕션은 ALLOWED_ORIGINS만(기본값 없음).
//   env(NODE_ENV 문자열)와는 별개 축이라 주입 seam을 따로 둔다.
// sessionService 파라미터는 두지 않는다 — 신원 도출 경로가 둘이면 한쪽만 재검증되는 구멍이 생긴다.
//   세션 스토어는 createControllers가 가드로 감싸 보유하고, transport는 controllers.auth로만 신원을 얻는다.
export function createApp({
  controllers,
  env = process.env.NODE_ENV,
  cookieSecure,
  forceHttps,
  uploadDir = 'uploads',
  logService = createLogService(),
  origins = allowedOrigins(),
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
    // 목록은 CSRF 가드와 공유한다(allowedOrigins 단일 출처, ADR-009).
    origin: origins,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-session-id', 'x-collection-token', 'x-edit-client'],
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

  // 전역 JSON 파서 — 기본 limit(~100kb)을 유지한다(로그인 등 일반 라우트의 보호 면적은 그대로).
  // 단 본문이 클 수 있는 라우트는 전역 파서를 건너뛰고 라우트 자체 파서(큰 limit)가 처리한다:
  //  - /api/upload: 첨부/자료 파일(base64)
  //  - 기사 생성(POST)/수정(PUT): 본문(markupVersion)에 인라인 이미지(base64)가 들어갈 수 있어
  //    기본 100kb를 쉽게 넘는다(넘으면 413→500으로 송고가 조용히 실패하던 버그).
  const globalJson = express.json();
  const articleJson = express.json({ limit: '10mb' });
  const isArticleWrite = (req) => (req.method === 'POST' && req.path === '/api/articles')
    || (req.method === 'PUT' && /^\/api\/articles\/[^/]+$/.test(req.path));
  app.use((req, res, next) => {
    if (req.path === '/api/upload' || isArticleWrite(req)) return next();
    return globalJson(req, res, next);
  });

  // 요청 로깅(INFO) — 완료 시점(finish)에 최종 status·소요시간을 기록한다.
  // CRITICAL(마스킹): req.path(쿼리 제외)만 담는다 — 전체 URL/쿼리스트링·헤더·쿠키·바디는 토큰 누출 표면.
  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logService.info(`${req.method} ${req.path} ${res.statusCode} ${Date.now() - startedAt}ms`);
    });
    next();
  });

  // CSRF Origin/Referer 게이트 (ADR-009) — 상태 변경 메서드만 본다.
  // 등록 위치: 요청 로거 다음(거부 403도 액세스 로그에 남는다), /uploads 정적 서빙·라우트보다 앞.
  // CORS preflight(OPTIONS)는 위 cors 미들웨어가 이미 응답을 끝내므로 여기 도달하지 않는다.
  app.use(csrfOriginGuard({ origins, isProd }));

  // 업로드 파일 정적 서빙 — uploadDir(기본 'uploads')를 /uploads 경로로 노출한다.
  // 저장 파일명은 서버가 발급한 <random-hex>.<ext>뿐이라 사용자 입력 경로가 끼어들지 않는다(경로 탐색 방지).
  app.use('/uploads', express.static(uploadDir));

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
  // controllers.auth.session은 매 호출 User 행을 재조회해 비활성/역할 변경을 즉시 반영한다(세션 가드).
  // 라우트 핸들러에 재검증을 개별 삽입하지 마라 — 누락된 라우트가 곧 권한 상승 구멍이다.
  function sessionOf(req) {
    const sid = readSessionToken(req);
    return { sid, me: sid ? controllers.auth.session(sid) : undefined };
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
      // 로그인 로깅 — userId(비밀 아님)와 reason만. password는 절대 담지 않는다(마스킹).
      if (r.ok) {
        logService.info(`login ok userId=${userId}`);
        // 세션 토큰을 쿠키로도 운반(헤더 응답 sessionId는 전환 기간 폴백으로 유지).
        setSessionCookie(res, r.sessionId);
        return res.json(r);
      }
      if (r.reason === 'locked') {
        logService.warn(`login locked userId=${userId}`);
        // 로그인 전용 매핑: 계정 잠금은 423 Locked. STATUS_BY_REASON.locked(409, 기사 편집 잠금)는 건드리지 않는다.
        return res.status(423).json(r);
      }
      logService.warn(`login failed userId=${userId} reason=${r.reason}`);
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
    const { me } = sessionOf(req);
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

  // --- 배부 대상 (Z 전용 — 게이트는 distributionTargetService가 강제, ADR-008) ---
  // 삭제 라우트는 두지 않는다: 대상 제거는 POST /:id/deactivate(active='N') soft delete가 유일 경로다.
  app.get('/api/distribution-targets', (req, res, next) => {
    try {
      const r = controllers.distributionTarget.query(readSessionToken(req), req.query);
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  app.post('/api/distribution-targets', (req, res, next) => {
    try {
      const r = controllers.distributionTarget.create(readSessionToken(req), req.body ?? {});
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  app.put('/api/distribution-targets/:id', (req, res, next) => {
    try {
      const r = controllers.distributionTarget.update(
        readSessionToken(req), Number(req.params.id), req.body ?? {},
      );
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  // PUT /:id(body active:'N')와 같은 상태 전이의 두 번째 진입점 — 서비스 내부에서 동일 헬퍼로 수렴한다.
  app.post('/api/distribution-targets/:id/deactivate', (req, res, next) => {
    try {
      const r = controllers.distributionTarget.deactivate(readSessionToken(req), Number(req.params.id));
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  // --- 엠바고 시점 배부 tick (Z 전용 — 게이트는 authorization.runDistributionTick, ADR-008 (3)) ---
  // 앱에 타이머를 두지 않는다: 외부 운영 cron이 **Z 세션의 x-session-id/쿠키**로 이 엔드포인트를 주기 호출한다(pull).
  // 부수효과(실제 배부)가 있으므로 GET으로는 열지 않는다 — 브라우저 프리페치/크롤러가 배부를 트리거하면 안 된다.
  // body는 읽지 않는다: 파라미터가 없고, role·시각·대상 목록을 클라이언트에서 받으면 엠바고가 무력화된다(ADR-004).
  app.post('/api/distribution/tick', async (req, res, next) => {
    try {
      const r = await controllers.distribution.tick(readSessionToken(req));
      if (!r.ok) return fail(res, r);
      // 실제 배부가 있었을 때만 무효화 신호 — 목록의 상태 배지가 갱신돼야 한다(변경 0건이면 재조회 낭비).
      if (Array.isArray(r.distributed) && r.distributed.length > 0) app.notifyChange('status');
      return res.json(r);
    } catch (e) { next(e); } // async 라우트의 rejection은 Express 4가 잡지 못한다 — 반드시 next로 넘긴다.
  });

  // --- 배부 실패 조회/재전송 (Z 전용 — 게이트는 authorization.manageDistributionFailure, ADR-008 MVP-4) ---
  // 조회는 부수효과가 없으므로 GET, 재전송은 스풀 파일을 쓰므로 POST다(프리페치 트리거 금지).
  // body에서 읽는 값은 historyId뿐이다 — role·kind·articleId·시각·경로를 받으면 인가가 무력화된다(ADR-004).
  // 판정(실패 존재·사이클·kind 일치·상태·활성)은 전부 서비스가 한다 — 라우트는 shape 매핑·게이트 위임뿐이다(ADR-006).
  app.get('/api/distribution/failures', (req, res, next) => {
    try {
      // 쿼리는 limit만 화이트리스트로 넘긴다(통짜 전달 금지). 정규화·클램프는 서비스 책임.
      const r = controllers.distribution.failures(readSessionToken(req), { limit: Number(req.query.limit) });
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  app.post('/api/distribution/retry', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const r = await controllers.distribution.retry(readSessionToken(req), {
        // 재전송 식별자는 목록의 키(historyId)뿐이다 — articleId/targetId/kind는 서버가
        // 그 실패 행에서 도출한다(ADR-004). 숫자 정규화(Number(req.params.id) 선례).
        historyId: Number(body.historyId),
      });
      if (!r.ok) {
        // 스풀 기록 실패는 클라이언트 잘못이 아니라 서버측 장애다(tick-failed:500 선례) —
        // 재전송 가능 사유 3종(spoolWriter 토큰) 전부: 저장된 spoolDir·articleId가 규칙 위반인 것도
        // 요청으로 고칠 수 있는 오류가 아니라 서버 데이터 문제다.
        // 전역 STATUS_BY_REASON에 넣지 않는 이유: invalid-spool-dir는 배부 대상 CRUD의 입력 검증
        // 거부(400)와 같은 토큰이라, 전역 매핑을 500으로 바꾸면 그쪽 계약이 깨진다(로그인 locked 423 선례).
        if (r.reason === 'spool-write-failed' || r.reason === 'invalid-spool-dir' || r.reason === 'invalid-article-id') {
          return res.status(500).json(r);
        }
        return fail(res, r);
      }
      // 재전송이 성공했을 때만 무효화 신호 — distributedAt이 바뀌어 목록 재조회가 필요하다.
      // 거부·실패에는 보내지 않는다(변경 0건 재조회 낭비 + 실패 오신호 방지).
      app.notifyChange('status');
      return res.json(r);
    } catch (e) { next(e); } // async 라우트의 rejection은 Express 4가 잡지 못한다 — 반드시 next로 넘긴다.
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

  // 단건 이력 스냅샷 조회 — 기사이력비교용 본문(markupVersion) 반환. 세션 게이트, 읽기 전용(DB 비파괴).
  // 목록(/history)은 blob 없이 hasSnapshot만 싣고, 본문은 이 라우트로 필요할 때만 조회한다.
  // controllers.article.getHistorySnapshot에 위임만 한다(ADR-006). articleId 스코프는 모델이 강제.
  app.get('/api/articles/:id/history/:historyId', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      const historyId = Number(req.params.historyId);
      if (!Number.isInteger(historyId)) return res.status(404).json({ ok: false, reason: 'not-found' });
      const r = controllers.article.getHistorySnapshot(req.params.id, historyId);
      if (!r.ok) return res.status(404).json(r);
      return res.json(r);
    } catch (e) { next(e); }
  });

  // 신규 저장 — R/D/Z. 부서가 비면 세션 부서를 stamp한다.
  // 초기 status는 세션 role + 의도 action으로 서버가 결정한다(기본 RDS, Z+hold만 DDH — initialStatus).
  app.post('/api/articles', articleJson, (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      if (!ROLES.has(me.role)) return res.status(403).json(FORBIDDEN);
      const dto = { ...(req.body ?? {}) };
      delete dto.role; // 클라 role 무시.
      if (!dto.department) { dto.department = me.department; dto.departmentCode = me.departmentCode; }
      // 작성자 미전송이면 세션 사용자로 보정한다(부서와 동일 정책 — 신규 기사가 작성자 없이 저장되지 않게).
      // 클라가 작성자를 명시하면(대필 등) 그대로 보존한다. 신원은 세션에서만 도출(ADR-004).
      if (!dto.author) dto.author = me.name || me.userId;
      // 의도 action(send/hold)만 전달 — status는 서버가 계산한다. body.status/role은 신뢰하지 않는다(ADR-004).
      const action = req.body?.action;
      const r = controllers.article.create(dto, { role: me.role, action });
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
  app.put('/api/articles/:id', articleJson, (req, res, next) => {
    try {
      const { sid, me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      // 편집 탭(clientId) 기준으로 보유자를 검증한다 — 같은 세션의 2번째 탭은 저장 차단.
      // 신원(userId/sessionId)은 오직 검증된 세션에서만 도출한다(ADR-004) — 헤더 clientId 하나로 인가하지 않는다.
      const clientId = req.get('x-edit-client');
      const hold = controllers.article.assertLockHolder(req.params.id, { clientId, userId: me.userId, sessionId: sid });
      if (!hold.ok) return fail(res, hold);
      const fields = { ...(req.body ?? {}), modifier: me.userId };
      delete fields.role;
      // 편집 저장 시에도 부서가 명시적으로 빈 값이면 세션 부서로 보정한다(신규 POST와 정합, news.md).
      // 부서 키가 아예 없으면(부분 수정) 건드리지 않아 기존 부서를 보존한다.
      if ('department' in fields && !fields.department) {
        fields.department = me.department;
        fields.departmentCode = me.departmentCode;
      }
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
      // 편집 탭(clientId)을 보유자 식별자로 함께 전달한다(같은 탭 재획득·재로그인 takeover·다른 탭 차단의 근거).
      const clientId = req.get('x-edit-client');
      const r = controllers.article.acquireEditLock(req.params.id, { userId: me.userId, sessionId: sid, clientId });
      if (r.ok) app.notifyChange('lock');
      return r.ok ? res.json(r) : fail(res, r);
    } catch (e) { next(e); }
  });

  app.post('/api/articles/:id/unlock', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      // 보유 탭(clientId) + 보유자 본인만 해제한다(비보유 탭·다른 사용자 → not-holder).
      // 신원(userId)은 오직 검증된 세션에서만 도출한다(ADR-004) — 헤더 clientId 하나로 인가하지 않는다.
      const clientId = req.get('x-edit-client');
      const r = controllers.article.releaseEditLock(req.params.id, { clientId, userId: me.userId });
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

  // --- 파일 업로드 (세션 게이트) ---
  // 얇은 transport(ADR-006): 세션 게이트 → 확장자/크기 검증 → 디스크 저장 → path 반환.
  // 외부 npm 의존 없이 Node 내장 fs/path/crypto만 쓴다(ADR 최소 의존성).
  // CRITICAL: 신원은 세션에서만 도출. 저장 파일명은 crypto 무작위 hex + 검증된 확장자로만 만든다
  //   (사용자 filename에 의존하지 않음 → 경로 탐색 차단). 기존 파일은 절대 덮어쓰거나 지우지 않는다.
  // 본문(base64) JSON은 클 수 있으므로 이 라우트에만 높은 limit을 적용한다(전역 limit은 올리지 않음).
  // 5MB 디코드 상한을 base64(약 4/3 팽창)로 환산하면 ~6.7MB + JSON 봉투다 → 5MB '초과' 본문이
  //   파서를 통과해 아래 too-large 검사에 도달하도록 10mb로 둔다(검증 책임은 라우트에 둔다).
  app.post('/api/upload', express.json({ limit: '10mb' }), (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);

      const { filename, contentBase64 } = req.body ?? {};
      if (typeof filename !== 'string' || typeof contentBase64 !== 'string') {
        return res.status(400).json({ ok: false, reason: 'invalid-file' });
      }

      // 확장자는 원본 파일명에서 도출 — 화이트리스트(소문자 비교)에 없으면 거부.
      const ext = nodePath.extname(filename).slice(1).toLowerCase();
      if (!ext || !UPLOAD_EXT_ALLOWLIST.has(ext)) {
        return res.status(400).json({ ok: false, reason: 'invalid-file' });
      }

      // raw base64 디코드(데이터 URI prefix 없음 가정) — 디코드 후 바이트 크기로 상한 검사.
      const buf = Buffer.from(contentBase64, 'base64');
      if (buf.length > UPLOAD_MAX_BYTES) {
        return res.status(400).json({ ok: false, reason: 'too-large' });
      }

      // 업로드 디렉터리는 첫 업로드 시 lazy 생성(recursive). DB/기존 파일은 손대지 않는다.
      fs.mkdirSync(uploadDir, { recursive: true });

      // 저장 파일명 = 무작위 hex + 검증된 확장자. 충돌은 사실상 없지만 wx 플래그로 덮어쓰기를 막는다.
      const safeName = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
      fs.writeFileSync(nodePath.join(uploadDir, safeName), buf, { flag: 'wx' });

      // path 문자열이 Contents.attachmentFile / referenceFile(VARCHAR)에 저장된다.
      return res.json({ ok: true, path: `/uploads/${safeName}`, filename });
    } catch (e) { next(e); }
  });

  // --- 사진DB (세션 게이트 — 이미지/글기사 검색과 동형, 역할 게이트 없음) ---
  // 등록은 append-only. 신원(registeredBy)은 세션에서만 도출한다(ADR-004) —
  // body의 registeredBy는 컨트롤러에 넘기지 않는다. src 검증(invalid-src)은 photoService 책임.
  app.post('/api/photos', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      const { src, caption, sourceArticleId } = req.body ?? {};
      const r = controllers.photo.register({ src, caption, sourceArticleId }, { userId: me.userId });
      if (!r.ok) return res.status(400).json(r); // invalid-src → 400
      return res.json(r); // { ok, id }
    } catch (e) { next(e); }
  });

  app.get('/api/photos/search', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      return res.json({ ok: true, items: controllers.photo.search(req.query.q ?? '') });
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
      // 수집 로깅 — sourceId + 결과만. payload(수집 본문)는 담지 않는다(마스킹).
      if (r.ok) {
        logService.info(`collection receive sourceId=${sourceId} ok`);
        app.notifyChange('create');
        return res.json(r);
      }
      logService.warn(`collection receive sourceId=${sourceId} reason=${r.reason}`);
      return fail(res, r);
    } catch (e) { next(e); }
  });

  // body { sourceId } → collection.pull. 등록된 활성 API 소스를 서버가 능동 호출해 응답을 등록한다(rcv.md).
  // /receive와 동일하게 127.0.0.1 바인딩 + 선택적 토큰(COLLECTION_TOKEN)으로 외부 노출을 좁힌다.
  app.post('/api/collection/pull', async (req, res, next) => {
    try {
      const required = process.env.COLLECTION_TOKEN;
      if (required && req.get('x-collection-token') !== required) {
        return res.status(401).json(UNAUTH);
      }
      const { sourceId } = req.body ?? {};
      const r = await controllers.collection.pull(sourceId);
      // 수집 로깅 — sourceId + 결과만(마스킹, receive와 동일).
      if (r.ok) {
        logService.info(`collection pull sourceId=${sourceId} ok`);
        app.notifyChange('create');
        return res.json(r);
      }
      logService.warn(`collection pull sourceId=${sourceId} reason=${r.reason}`);
      return fail(res, r);
    } catch (e) { next(e); }
  });

  // --- SSE: 무효화 신호 스트림 ---
  // 인증은 쿠키 우선(readSessionToken: 쿠키→x-session-id 헤더)만 허용한다.
  // 평문 ?session= 쿼리 폴백은 제거했다 — URL/프록시 로그 누출 표면이므로 쿠키·헤더만 신뢰한다.
  app.get('/api/stream', (req, res) => {
    const { sid, me } = sessionOf(req);
    if (!me) return res.status(401).json(UNAUTH);

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write('event: ready\ndata: {"ok":true}\n\n');

    // push 시점 재검증 — 접속 시점 인증만으로는 로그아웃·만료·강등·비활성 이후에도 신호가 계속 나간다.
    // 반드시 비연장 peek다: touch면 열린 SSE가 세션을 무한 연장해 1시간 유휴 만료가 무력화된다.
    // 주기 재검증 타이머는 두지 않는다(ADR-008) — 대가로 이벤트가 없으면 종료가 다음 이벤트까지 지연된다.
    const closer = createSseCloser(res);
    const onChange = (signal) => {
      // 재검증은 DB를 읽는다 — 이 콜백은 bus.emit('change') 위, 즉 라우트 핸들러의 스택에서 돈다.
      // 예외를 여기서 잡지 않으면 성공한 저장이 전역 에러 핸들러에 걸려 500으로 뒤집힌다(클라 재시도 → 중복 저장).
      // fail-closed: 재검증 불가는 "일단 전송"이 아니라 봉인이다(신호를 쓰지 않고 스트림을 끝낸다).
      // 잡는 위치는 여기(리스너 국소)여야 한다 — sessionGuard에서 잡으면 HTTP 라우트의 DB 예외가
      // 500 internal-error 대신 401로 바뀌는 광범위한 동작 변화가 생긴다.
      try {
        if (!controllers.auth.peek(sid)) return closer.close();
      } catch {
        return closer.close();
      }
      return res.write(`event: change\ndata: ${JSON.stringify(signal ?? {})}\n\n`);
    };
    bus.on('change', onChange);
    closer.setUnsubscribe(() => bus.off('change', onChange)); // 종료기도 같은 해제 함수를 쓴다(이중 해제 안전).
    req.on('close', () => bus.off('change', onChange));
  });

  // --- 로그 노출 (ADR-007 — ADR-005 "무효화 신호만" 원칙의 예외: 로그 라인 실데이터를 push) ---
  // CRITICAL: 둘 다 Z 전용이다. /api/stream(로그인만)과 달리 role 게이트가 있다 — 게이트를 빼면
  // R/D가 서버 로그(전 사용자 요청 흔적)를 본다. role은 검증 세션에서만 도출한다(ADR-004).
  // 읽기 전용: logService(in-memory 링 버퍼)에 위임만 한다 — DB/파일을 만들거나 건드리지 않는다.

  // 로그 다이제스트 — [전날 06:00, 당일 06:00) KST 창(LOGS.md). 매일 6시 전달은 앱 타이머가 아니라
  // 하네스 운영 루틴이 이 API를 pull해 수행한다.
  app.get('/api/logs/digest', (req, res, next) => {
    try {
      const { me } = sessionOf(req);
      if (!me) return res.status(401).json(UNAUTH);
      if (me.role !== 'Z') return res.status(403).json(FORBIDDEN);
      return res.json({ ok: true, items: logService.digest() });
    } catch (e) { next(e); }
  });

  // 실시간 로그 SSE — 접속마다 버퍼 최근 2000건을 replay한 뒤 실시간 push를 잇는다.
  // Last-Event-ID 프로토콜 없이 재연결 유실을 replay로 해소한다 — 중복 라인은 클라(step4)가 record.seq로 거른다.
  const LOG_REPLAY_MAX = 2000; // step4 클라 MAX_LINES와 정렬 — 전체 cap(10000) replay는 첫 렌더/대역폭 낭비.
  app.get('/api/logs/stream', (req, res) => {
    const { sid, me } = sessionOf(req);
    if (!me) return res.status(401).json(UNAUTH);
    if (me.role !== 'Z') return res.status(403).json(FORBIDDEN); // 비-Z 차단 — SSE 헤더를 열기 전에 끝낸다.

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write('event: ready\ndata: {"ok":true}\n\n');

    // 접속 직후 replay는 접속 시점 인증으로 충분하다(같은 tick — 아직 무효화될 틈이 없다).
    for (const rec of logService.snapshot().slice(-LOG_REPLAY_MAX)) {
      res.write(`event: log\ndata: ${JSON.stringify(rec)}\n\n`);
    }
    // live push 시점 재검증 — Z 전용 봉인(ADR-007)이 시간축에서도 유지돼야 한다.
    // 세션이 죽었거나 role이 Z가 아니게 되면 그 로그 라인은 쓰지 않고 스트림을 끝낸다(한 줄도 나가지 않는다).
    // 비연장 peek 필수(touch면 열린 스트림이 세션을 무한 연장한다). 캐시·타이머 없음(ADR-008).
    const closer = createSseCloser(res);
    const off = logService.subscribe((rec) => {
      // CRITICAL: 재검증은 DB를 읽는데 이 콜백은 logService.log가 try/catch 없이 동기 호출하고,
      // 그 호출자는 요청 로거의 res.on('finish')다. 예외를 여기서 잡지 않으면 finish 리스너 밖으로 새어
      // uncaughtException → 프로세스 종료가 된다(SQLITE_BUSY·디스크 I/O 등 DB 일시 장애로 서버 다운).
      // fail-closed: 재검증 불가는 봉인이다(그 로그 라인은 쓰지 않고 스트림을 끝낸다).
      let actor;
      try {
        actor = controllers.auth.peek(sid);
      } catch {
        return closer.close();
      }
      if (!actor || actor.role !== 'Z') return closer.close();
      return res.write(`event: log\ndata: ${JSON.stringify(rec)}\n\n`);
    });
    closer.setUnsubscribe(off); // 종료기도 같은 해제 함수를 쓴다(이중 해제 안전).
    req.on('close', () => off()); // 구독 해제 필수 — 누수 시 닫힌 응답에 write가 누적된다.
  });

  // 전역 에러 핸들러 — 내부 스택을 노출하지 않는다 (4-arg, 마지막 등록).
  // err는 in-memory 로그에만 남긴다 — HTTP 응답 바디는 internal-error 고정(ADR 보안 경계 불변).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logService.error(`${req.method} ${req.path} ${err?.message ?? err}`);
    res.status(500).json({ ok: false, reason: 'internal-error' });
  });

  return app;
}

// --- 프로덕션 부트스트랩 (직접 실행 시에만) ---
// 테스트가 createApp을 import할 때는 아래가 실행되지 않는다 → listen/watcher 미기동.
function bootstrap() {
  const db = new DatabaseSync('news.db');
  createSchema(db); // 비파괴 멱등 마이그레이션만 — DROP/DELETE 없음.
  backfillEmptyDepartments(db); // 예전 DB의 빈 부서 값을 작성자 User 부서로 자동 보정(비파괴, 멱등).

  const sessionService = createSessionService();
  // 로그 서비스는 HTTP 계층과 컨트롤러(배부 실패 표면화)가 같은 인스턴스를 공유한다.
  const logService = createLogService();
  const controllers = createControllers(db, { sessionService, logService });
  // HTTPS 강제는 운영 기준(NODE_ENV==='production')에서 켜되, FORCE_HTTPS로 명시 오버라이드 허용.
  // 앱은 TLS 종단을 하지 않는다(HSTS+리다이렉트만) — 인증서/HTTPS 서버는 외부 프록시 책임(범위 밖).
  const forceHttps = process.env.FORCE_HTTPS === 'true'
    || (process.env.FORCE_HTTPS !== 'false' && process.env.NODE_ENV === 'production');
  // 허용 출처는 여기서 한 번 계산해 앱과 진단이 같은 값을 보게 한다(경고가 실제 적용분과 어긋나지 않도록).
  const origins = allowedOrigins();
  // 세션 스토어는 createControllers에만 넘긴다 — transport는 controllers.auth로 신원을 얻는다(재검증 경로 단일화).
  const app = createApp({ controllers, logService, forceHttps, origins });
  logOriginDiagnostics({ origins, logService });

  const port = Number(process.env.PORT) || 3001;
  app.listen(port, '127.0.0.1', () => {
    logService.info(`API server on http://127.0.0.1:${port}`);
  });

  // 배부 스풀(ADR-008) — DIST_SPOOL_DIR 미설정 시 배부 비활성(createControllers가 판정).
  // 여기서 디렉토리를 미리 만들지 않는다: 생성은 실제 배부 시점의 spoolWriter 책임이다.
  // 시점 배부(tick)는 앱에 타이머/주기 실행을 두지 않는다(ADR-008 (3)) —
  // 외부 운영 cron이 Z 세션으로 POST /api/distribution/tick 을 주기 호출해 실행한다(pull).
  // setInterval/워커/스케줄러를 여기에 추가하지 마라: 다중 인스턴스에서 중복 배부가 된다.
  if (process.env.DIST_SPOOL_DIR) {
    logService.info(`distribution spool root ${process.env.DIST_SPOOL_DIR}`);
  }

  // 수집 FTP watcher — RCV_SPOOL_DIR 미설정 시 비활성.
  const spoolDir = process.env.RCV_SPOOL_DIR;
  if (spoolDir) {
    const watcher = createFtpWatcher({
      dir: spoolDir,
      onFile: ({ sourceId, payload }) => {
        const r = controllers.collection.receive(sourceId, payload);
        // 수집 로깅 — sourceId + 결과만. payload는 담지 않는다(마스킹).
        if (r && r.ok) {
          logService.info(`collection ftp received sourceId=${sourceId}`);
          app.notifyChange('create');
        } else {
          logService.warn(`collection ftp sourceId=${sourceId} reason=${r?.reason}`);
        }
      },
      // 파일 처리 실패를 무음 삼킴 대신 로그로 표면화한다 — watcher는 계속 산다.
      onError: (err) => logService.warn(`ftp watcher error: ${err?.message ?? err}`),
    });
    watcher.start();
    logService.info(`FTP watcher watching ${spoolDir}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrap();
}
