// 계약 케이스: 외부 프록시·파일·사진 5 라우트 — default 프로파일.
//   #26 POST /api/articles/:id/translate(articles-translate) · #31 GET /api/media/search(media-search)
//   #32 POST /api/upload(upload) · #33 POST /api/photos(photos-create) · #34 GET /api/photos/search(photos-search)
//
// 측정 조건(러너가 강제 — decisions (9)): 외부 API 키 4종(GOOGLE_API_KEY·GOOGLE_CSE_ID·YOUTUBE_API_KEY·
//   GOOGLE_TRANSLATE_API_KEY)이 자식 env에서 삭제된다 → 이 스위트가 동결하는 것은 **키 없는 서버의 계약**이다.
//   그래서 이 파일의 케이스는 외부 네트워크를 한 번도 때리지 않는다(미디어=결정적 데모 폴백,
//   번역=키 없음 graceful degrade — 두 서비스 모두 키가 없으면 fetch 호출 자체를 하지 않는다).
//   키가 설정된 서버의 동작(ok:true 번역·실 검색 결과)은 **미동결**이며 openapi.yaml에 미검증으로 기록한다.
//
// 계약의 축 3가지:
//  (1) **상태코드로 성공을 판정할 수 없다** — translate는 키가 없어도 200이고 본문만 ok:false다.
//      클라이언트(httpModel)는 상태코드를 해석하지 않고 JSON의 ok만 읽는다. 4xx/5xx로 바꾸면 조용히 깨진다.
//  (2) **업로드는 multipart가 아니라 base64 JSON**이다({filename, contentBase64}). 저장 파일명은 서버가
//      발급하고(사용자 filename은 확장자 판정에만 쓴다) 응답 path는 /uploads/<32-hex>.<ext>다.
//  (3) **사진 src는 업로드 상대경로 또는 https만**이고 registeredBy는 세션에서만 stamp된다(ADR-004).
//
// 규율: 서버 코드 import 금지 · 직접 로그인 금지(actor/sid 재사용 — 로그인 예산 decisions (8)) ·
//   절대 개수 단언 금지(자기 픽스처만) · 리포트에는 업로드 hex 파일명·경로·캡션·본문을 싣지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../../lib/http.js';
import { record, fromResponse } from '../../lib/record.js';
import { requireProfile } from '../../lib/profiles.js';
import { actor, sid } from '../../lib/session.js';
import { createArticle, unique } from '../../lib/fixtures.js';

requireProfile('default');

// 1x1 투명 PNG의 raw base64(데이터 URI prefix 없음 — 서버는 prefix를 벗기지 않는다).
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// UPLOAD_EXT_ALLOWLIST 14종(server/index.js) — 서버는 **확장자와 디코드 크기만** 본다(내용 검사 없음).
const UPLOAD_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'txt', 'hwp', 'ppt', 'pptx'];

// 저장 파일명 = crypto.randomBytes(16) hex(32자) + 검증된 소문자 확장자.
const UPLOAD_PATH_RE = /^\/uploads\/[0-9a-f]{32}\.[a-z]+$/;

// 미디어 데모 폴백은 질의 문자열을 시드로 쓴다 — ASCII 고정 질의로 결정성을 관측한다.
const MEDIA_Q = 'contract-media-q';

const keysOf = (obj) => Object.keys(obj).sort().join(',');
const extOf = (path) => String(path).slice(String(path).lastIndexOf('.') + 1);

// 업로드 픽스처(리포트 미기록) — 사진 등록에 쓸 유효한 /uploads 상대경로를 만든다.
async function uploadFixture(filename) {
  const res = await api('POST', '/api/upload', {
    sid: sid('R'), body: { filename, contentBase64: PNG_BASE64 },
  });
  if (res.status !== 200 || res.json?.ok !== true || typeof res.json.path !== 'string') {
    throw new Error(`픽스처 실패 upload: status=${res.status} reason=${res.json?.reason ?? '-'}`);
  }
  return res.json.path;
}

// --- 1. 인가: 5 라우트 전부 미인증 401 --------------------------------------------------------

test('media/upload/photos: 5 라우트 미인증 → 401 unauthenticated', async () => {
  const cases = [
    ['articles-translate', 'POST', `/api/articles/${unique('no-such-article')}/translate`, { body: {} }, 'unauth-translate'],
    ['media-search', 'GET', `/api/media/search?q=${MEDIA_Q}&type=image`, {}, 'unauth-media-search'],
    ['upload', 'POST', '/api/upload', { body: { filename: 'a.png', contentBase64: PNG_BASE64 } }, 'unauth-upload'],
    ['photos-create', 'POST', '/api/photos', { body: { src: '/uploads/a.png', caption: 'x' } }, 'unauth-photos-create'],
    ['photos-search', 'GET', `/api/photos/search?q=${MEDIA_Q}`, {}, 'unauth-photos-search'],
  ];
  for (const [routeId, method, path, opts, caseId] of cases) {
    const res = await api(method, path, opts); // sid 없음.
    assert.equal(res.status, 401, `${method} ${path} → 401`);
    assert.equal(res.json?.ok, false);
    assert.equal(res.json?.reason, 'unauthenticated');
    // 세션 게이트가 대상 존재 여부·본문 검증보다 **먼저** 돈다(없는 기사 id에도 404가 아니라 401).
    record(routeId, 'unauthenticated', { ...fromResponse(res), caseId });
  }
});

// --- 2. 미디어 검색: 키 없는 서버의 결정적 데모 폴백 -------------------------------------------

test('GET /api/media/search — type=image 200 {ok:true,items,error:false} · 원소 키 link,title', async () => {
  const res = await api('GET', '/api/media/search', { sid: sid('R'), query: { q: MEDIA_Q, type: 'image' } });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.items));
  assert.ok(res.json.items.length > 0, '키 없는 서버는 빈 배열이 아니라 데모 폴백을 준다');
  // error는 **불리언 플래그로 존재**한다(reason 토큰이 아니다) — 폴백/성공은 false, 외부 실패만 true.
  assert.equal(res.json.error, false);
  assert.deepEqual(Object.keys(res.json).sort(), ['error', 'items', 'ok'], '응답 키 3종 고정(서비스의 demo 플래그는 라우트가 떨군다)');
  for (const item of res.json.items) assert.equal(keysOf(item), 'link,title');

  record('media-search', 'success', {
    ...fromResponse(res, {
      values: {
        error: res.json.error,
        itemKeys: keysOf(res.json.items[0]),
        itemCount: res.json.items.length, // 데모 폴백의 결정적 개수(관측 기록 — 단언은 >0만).
      },
    }),
    caseId: 'image',
  });
});

test('GET /api/media/search — type=video/누락/이상값은 전부 video 폴백(원소 키 title,url,videoId)', async () => {
  const variants = [
    ['video', { q: MEDIA_Q, type: 'video' }],
    ['type-omitted', { q: MEDIA_Q }],
    ['type-unknown', { q: MEDIA_Q, type: 'audio' }],
  ];
  const seen = [];
  for (const [caseId, query] of variants) {
    const res = await api('GET', '/api/media/search', { sid: sid('R'), query });
    assert.equal(res.status, 200, `${caseId} → 200`);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.error, false);
    assert.ok(res.json.items.length > 0);
    for (const item of res.json.items) {
      assert.equal(keysOf(item), 'title,url,videoId', `${caseId}: video 원소 키`);
      assert.match(item.videoId, /^[\w-]{11}$/, `${caseId}: 임베드 가능한 11자 videoId`);
    }
    seen.push(res.json.items);
    record('media-search', 'success', {
      ...fromResponse(res, {
        values: { error: res.json.error, itemKeys: keysOf(res.json.items[0]), itemCount: res.json.items.length },
      }),
      caseId,
    });
  }
  // type 누락·이상값이 video와 **같은 결과**인지(정규화 규칙)까지 잠근다.
  assert.deepEqual(seen[1], seen[0], 'type 누락 = video');
  assert.deepEqual(seen[2], seen[0], '이상값 type = video');
});

test('GET /api/media/search — 같은 질의 2회 호출은 완전히 동일하다(데모 폴백 결정성)', async () => {
  const query = { q: MEDIA_Q, type: 'image' };
  const first = await api('GET', '/api/media/search', { sid: sid('R'), query });
  const second = await api('GET', '/api/media/search', { sid: sid('R'), query });

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  // 외부 호출이 없으므로(키 삭제) 결과는 질의만의 함수다 — 이 결정성이 스위트 재실행 안정성의 근거다.
  assert.deepEqual(second.json, first.json);

  record('media-search', 'success', {
    ...fromResponse(second, { values: { identicalOnRepeat: true } }),
    caseId: 'determinism',
  });
});

// --- 3. 번역: 200인데 ok:false(graceful degrade) ----------------------------------------------

test('POST /api/articles/:id/translate — 키 없는 서버는 **200 + ok:false + reason:no-key**(4xx 아님)', async () => {
  const { articleId } = await createArticle('D');

  const res = await api('POST', `/api/articles/${articleId}/translate`, { sid: sid('R'), body: {} });

  // CRITICAL: 상태코드는 200이다. 키 누락을 500/400으로 감싸면 클라이언트가 조용히 깨진다(reason-tokens.md 표3 #13).
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, 'no-key');
  // 원문 폴백 — 번역 대상 본문은 **서버 DB에서만** 취한다(요청 body의 text는 쓰지 않는다, ADR-004).
  assert.equal(typeof res.json.translatedText, 'string');
  assert.ok(res.json.translatedText.includes('(끝)'), '자기 픽스처 본문이 원문 그대로 돌아온다');
  assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'reason', 'translatedText']);

  record('articles-translate', 'graceful', {
    ...fromResponse(res, { values: { translatedTextIsOriginal: true } }),
    caseId: 'no-key',
  });

  // targetLang을 명시해도 키 없는 서버의 결과는 같다(외부 호출이 없어 targetLang 사용 여부는 관측 불가 — 미동결).
  const withLang = await api('POST', `/api/articles/${articleId}/translate`, {
    sid: sid('R'), body: { targetLang: 'en' },
  });
  assert.equal(withLang.status, 200);
  assert.equal(withLang.json.reason, 'no-key');
  record('articles-translate', 'graceful', {
    ...fromResponse(withLang, { values: { targetLangObservable: false } }),
    caseId: 'no-key-target-lang',
  });
});

test('POST /api/articles/:id/translate — 없는 articleId → 404 not-found', async () => {
  const res = await api('POST', `/api/articles/${unique('no-such-article')}/translate`, {
    sid: sid('R'), body: {},
  });

  assert.equal(res.status, 404);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, 'not-found');

  record('articles-translate', 'not-found', { ...fromResponse(res), caseId: 'missing-article' });
});

// --- 4. 업로드 성공 + 정적 서빙 ---------------------------------------------------------------

test('POST /api/upload — png 200 {ok,path,filename} · path=/uploads/<32hex>.png · GET path로 서빙', async () => {
  const filename = 'contract-upload.png';
  const res = await api('POST', '/api/upload', { sid: sid('R'), body: { filename, contentBase64: PNG_BASE64 } });

  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  // 저장 파일명은 **서버가 발급**한다 — 사용자 filename은 확장자 판정에만 쓰인다(경로 탐색 차단).
  assert.match(res.json.path, UPLOAD_PATH_RE);
  assert.equal(extOf(res.json.path), 'png');
  assert.ok(!res.json.path.includes(filename.replace('.png', '')), 'path에 사용자 파일명이 섞이지 않는다');
  // 응답 filename은 요청 filename 그대로다(클라가 표시용으로 쓴다).
  assert.equal(res.json.filename, filename);
  assert.deepEqual(Object.keys(res.json).sort(), ['filename', 'ok', 'path']);

  record('upload', 'success', {
    // 실제 path·hex 파일명은 휘발값이라 리포트에 싣지 않는다 — 패턴 일치 여부와 확장자만 남긴다.
    ...fromResponse(res, { values: { pathMatchesPattern: true, pathExt: extOf(res.json.path), filenameEchoed: true } }),
    caseId: 'png',
  });

  // 정적 서빙(/uploads)은 업로드 계약의 일부다 — 저장 직후 같은 경로로 읽힌다.
  // CRITICAL(실측): 이 GET에는 **세션을 붙이지 않는다** — express.static은 세션 게이트 앞에 마운트돼 있어
  //   업로드 파일은 미인증으로도 200이다. 비밀은 32-hex 파일명뿐인 capability URL 모델이며, 이식 시 이 성질을
  //   바꾸면(세션 요구) 발행 HTML에 재임베드된 이미지가 외부에서 깨진다.
  const served = await api('GET', res.json.path); // sid 없음 — 의도적이다.
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type') ?? '', /image\/png/);
  // 인벤토리 39 라우트 밖(정적 서빙)이라 x- 접두사로 남긴다 — 커버리지 집계 제외(decisions (23)).
  record('x-uploads-static', 'success', {
    ...fromResponse(served, { values: { servedAfterUpload: true, requiresSession: false }, headers: ['content-type'] }),
    caseId: 'get-uploaded-png',
  });
});

test('POST /api/upload — 확장자는 소문자로 정규화된다(.PNG → /uploads/<hex>.png)', async () => {
  const res = await api('POST', '/api/upload', {
    sid: sid('R'), body: { filename: 'contract-upload.PNG', contentBase64: PNG_BASE64 },
  });

  assert.equal(res.status, 200);
  assert.match(res.json.path, UPLOAD_PATH_RE); // 정규식이 소문자 확장자만 허용한다.
  assert.equal(extOf(res.json.path), 'png');
  assert.equal(res.json.filename, 'contract-upload.PNG', '응답 filename은 원본 대소문자를 보존한다');

  record('upload', 'success', {
    ...fromResponse(res, { values: { pathExt: extOf(res.json.path), requestExtWasUppercase: true } }),
    caseId: 'ext-uppercase',
  });
});

test('POST /api/upload — 확장자 화이트리스트 14종 전부 200(서버는 내용이 아니라 확장자·크기만 본다)', async () => {
  const accepted = [];
  for (const ext of UPLOAD_EXTS) {
    // 내용은 전부 같은 png 바이트다 — 서버가 내용을 검사하지 않는다는 사실 자체가 계약이다.
    const res = await api('POST', '/api/upload', {
      sid: sid('R'), body: { filename: `contract-allow.${ext}`, contentBase64: PNG_BASE64 },
    });
    assert.equal(res.status, 200, `.${ext} → 200`);
    assert.equal(res.json.ok, true, `.${ext} → ok:true`);
    assert.match(res.json.path, UPLOAD_PATH_RE);
    assert.equal(extOf(res.json.path), ext, `.${ext} 확장자가 저장명에 보존된다`);
    accepted.push(ext);
  }
  assert.deepEqual(accepted, UPLOAD_EXTS);

  // 14종 전수는 관측 1건으로 접는다(리포트 소음 방지) — 목록 자체가 계약이라 값으로 남긴다.
  record('upload', 'success', {
    status: 200,
    ok: true,
    reason: null,
    bodyKeys: ['filename', 'ok', 'path'],
    values: { acceptedExts: [...accepted].sort().join(','), acceptedExtCount: accepted.length },
    headers: {},
    caseId: 'ext-allowlist',
  });
});

// --- 5. 업로드 거부 ---------------------------------------------------------------------------

test('POST /api/upload — 형식/확장자 위반 → 400 invalid-file', async () => {
  const cases = [
    ['ext-denied', { filename: 'malware.exe', contentBase64: PNG_BASE64 }],
    ['ext-missing', { filename: 'noextension', contentBase64: PNG_BASE64 }],
    ['content-missing', { filename: 'a.png' }],
    ['content-not-string', { filename: 'a.png', contentBase64: 12345 }],
  ];
  for (const [caseId, body] of cases) {
    const res = await api('POST', '/api/upload', { sid: sid('R'), body });
    assert.equal(res.status, 400, `${caseId} → 400`);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.reason, 'invalid-file', `${caseId} → invalid-file`);
    assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'reason']);
    record('upload', 'validation', { ...fromResponse(res), caseId });
  }
});

test('POST /api/upload — 디코드 5MB 초과 → 400 too-large(경계값은 미동결, excluded (j))', async () => {
  // 여유 있게 초과(6MB)만 관측한다 — 정확 경계(5,242,880) 탐색은 실행 시간 대비 가치가 낮다.
  // base64 팽창(4/3)으로 본문은 약 8MB다 → 라우트 전용 파서(limit 10mb)를 통과해 크기 검사에 도달한다.
  const oversized = Buffer.alloc(6 * 1024 * 1024, 0x41).toString('base64');
  const res = await api('POST', '/api/upload', {
    sid: sid('R'), body: { filename: 'contract-big.pdf', contentBase64: oversized },
  });

  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.reason, 'too-large');

  record('upload', 'validation', { ...fromResponse(res), caseId: 'too-large' });
});

// --- 6. 사진 등록 + 검색 ----------------------------------------------------------------------

test('POST /api/photos + GET /api/photos/search — 업로드 경로·https src 등록 후 캡션으로 되읽는다', async () => {
  const token = unique('ctphoto');
  const uploadedPath = await uploadFixture('contract-photo.png');

  const fromUpload = await api('POST', '/api/photos', {
    sid: sid('R'), body: { src: uploadedPath, caption: `${token} upload` },
  });
  assert.equal(fromUpload.status, 200);
  assert.equal(fromUpload.json.ok, true);
  assert.equal(typeof fromUpload.json.id, 'number');
  assert.deepEqual(Object.keys(fromUpload.json).sort(), ['id', 'ok']);
  record('photos-create', 'success', {
    ...fromResponse(fromUpload, { values: { idIsInteger: Number.isInteger(fromUpload.json.id), srcKind: 'uploads-relative' } }),
    caseId: 'src-uploads',
  });

  const fromHttps = await api('POST', '/api/photos', {
    sid: sid('R'), body: { src: 'https://example.test/photo.png', caption: `${token} https` },
  });
  assert.equal(fromHttps.status, 200);
  assert.equal(fromHttps.json.ok, true);
  record('photos-create', 'success', {
    ...fromResponse(fromHttps, { values: { idIsInteger: Number.isInteger(fromHttps.json.id), srcKind: 'https' } }),
    caseId: 'src-https',
  });

  // 캡션 부분일치(LIKE) — 토큰이 이 실행 고유라 매칭되는 행은 전부 자기 픽스처다(절대 개수 단언 아님).
  const found = await api('GET', '/api/photos/search', { sid: sid('R'), query: { q: token } });
  assert.equal(found.status, 200);
  assert.equal(found.json.ok, true);
  assert.deepEqual(Object.keys(found.json).sort(), ['items', 'ok']);
  const mine = found.json.items;
  assert.deepEqual(mine.map((it) => it.id), [fromHttps.json.id, fromUpload.json.id], '최신 등록 우선(id DESC)');
  for (const item of mine) {
    assert.equal(keysOf(item), 'caption,createdAt,id,registeredBy,sourceArticleId,src', 'Photo 행 6컬럼 그대로(SELECT *)');
    assert.ok(item.caption.includes(token));
  }
  assert.equal(mine[1].src, uploadedPath, '업로드 상대경로가 그대로 보존된다');
  assert.equal(mine[0].src, 'https://example.test/photo.png');
  assert.equal(mine[0].sourceArticleId, '', 'sourceArticleId 생략 시 빈 문자열로 채워진다(null 아님)');

  record('photos-search', 'success', {
    ...fromResponse(found, {
      values: {
        itemKeys: keysOf(mine[0]),
        ownMatches: mine.length, // 자기 픽스처 2건 — 전체 개수가 아니다.
        newestFirst: true,
        srcPreserved: true,
        sourceArticleIdDefault: mine[0].sourceArticleId === '' ? 'empty-string' : 'other',
      },
    }),
    caseId: 'by-caption',
  });
});

test('POST /api/photos — 허용 밖 src → 400 invalid-src(javascript:/data:/http:/traversal)', async () => {
  const cases = [
    ['javascript', 'javascript:alert(1)'],
    ['data-uri', 'data:image/png;base64,AAA'],
    ['http', 'http://example.test/photo.png'],
    ['traversal', '/uploads/../secret.png'],
  ];
  const token = unique('ctphoto-bad');
  for (const [caseId, src] of cases) {
    const res = await api('POST', '/api/photos', { sid: sid('R'), body: { src, caption: `${token} ${caseId}` } });
    assert.equal(res.status, 400, `${caseId} → 400`);
    assert.equal(res.json.ok, false);
    assert.equal(res.json.reason, 'invalid-src', `${caseId} → invalid-src`);
    assert.deepEqual(Object.keys(res.json).sort(), ['ok', 'reason']);
    record('photos-create', 'validation', { ...fromResponse(res), caseId });
  }

  // 거부된 src는 저장되지 않는다(append-only 원장에 쓰레기 행이 남지 않는다).
  const found = await api('GET', '/api/photos/search', { sid: sid('R'), query: { q: token } });
  assert.equal(found.status, 200);
  assert.deepEqual(found.json.items, [], '거부 4건 모두 DB에 남지 않는다');
});

test('POST /api/photos — body의 registeredBy는 무시되고 세션 사용자로 stamp된다(ADR-004)', async () => {
  const token = unique('ctphoto-stamp');
  const forged = 'someone-else';

  const reg = await api('POST', '/api/photos', {
    sid: sid('R'),
    body: { src: 'https://example.test/forged.png', caption: `${token} forged`, registeredBy: forged },
  });
  assert.equal(reg.status, 200);
  assert.equal(reg.json.ok, true);

  // 등록 응답은 {ok,id}뿐이라 신뢰 경계는 **되읽기**로만 관측된다.
  const found = await api('GET', '/api/photos/search', { sid: sid('R'), query: { q: token } });
  assert.equal(found.status, 200);
  assert.equal(found.json.items.length, 1);
  const stamped = found.json.items[0].registeredBy;
  assert.notEqual(stamped, forged, '클라이언트가 보낸 registeredBy는 무시된다');
  assert.equal(stamped, actor('R').userId, '세션에서 도출한 userId로만 stamp한다');

  record('photos-create', 'success', {
    // userId 원문은 대상 서버마다 다를 수 있어 싣지 않는다 — 판정 결과(불리언)만 남긴다.
    ...fromResponse(reg, { values: { registeredByFromSession: true, registeredByFromBody: false } }),
    caseId: 'registered-by-session',
  });
});

test('GET /api/photos/search — 빈 q는 전체 목록(LIKE %%)이다 · 개수는 단언하지 않는다', async () => {
  const token = unique('ctphoto-all');
  const reg = await api('POST', '/api/photos', {
    sid: sid('R'), body: { src: 'https://example.test/all.png', caption: `${token} all` },
  });
  assert.equal(reg.status, 200);

  const empty = await api('GET', '/api/photos/search', { sid: sid('R'), query: { q: '' } });
  assert.equal(empty.status, 200);
  assert.equal(empty.json.ok, true);
  assert.ok(Array.isArray(empty.json.items));
  // 사전 존재 데이터에 강건해야 한다(decisions (6)) — 자기 행의 포함 여부만 본다.
  assert.ok(empty.json.items.some((it) => it.id === reg.json.id), '빈 q는 필터하지 않는다(자기 행 포함)');

  // q 파라미터 자체를 생략해도 같다(라우트가 req.query.q ?? ''로 정규화).
  const omitted = await api('GET', '/api/photos/search', { sid: sid('R') });
  assert.equal(omitted.status, 200);
  assert.ok(omitted.json.items.some((it) => it.id === reg.json.id));

  record('photos-search', 'success', {
    ...fromResponse(empty, { values: { emptyQueryFilters: false, ownRowIncluded: true, sameAsOmittedQ: true } }),
    caseId: 'empty-q',
  });
});
