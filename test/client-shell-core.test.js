// 클라이언트 셸 순수 정책 모듈 (phase 62 step0) — Electron 없이 node:test로 잠근다.
// 4모듈: serverUrl(주소 정규화·health 판정) · clientConfig(설정 화이트리스트·원자적 쓰기) ·
// windowPolicy(창 옵션·window.open·내비게이션 fail-closed) · loadFailure(로드 실패 안내).
// CRITICAL: 이 테스트는 파일시스템·네트워크·Electron에 절대 바인딩하지 않는다 — 의존성은 전부 주입 스파이다.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  normalizeServerUrl, healthUrl, appUrl, isSameOrigin, interpretHealthResponse,
} from '../client/lib/serverUrl.js';
import {
  CONFIG_FILENAME, CONFIG_SCHEMA_VERSION, configPath, parseConfig, serializeConfig,
  sanitizeBounds, readConfigFile, writeConfigFile,
} from '../client/lib/clientConfig.js';
import {
  APP_WINDOW, LOCAL_WINDOW, buildWindowOptions, decideWindowOpen, decideNavigation, isExternallyOpenable,
} from '../client/lib/windowPolicy.js';
import { describeLoadFailure, describeHttpFailure } from '../client/lib/loadFailure.js';

// ---------------------------------------------------------------------------
describe('serverUrl', () => {
  test('스킴 없는 IP:포트는 http://를 보충한다(운영자는 IP만 친다)', () => {
    assert.deepEqual(normalizeServerUrl('192.168.0.10:3001'), { ok: true, origin: 'http://192.168.0.10:3001' });
  });

  test('localhost:포트 — 스킴처럼 보이는 호스트도 host:port로 해석한다', () => {
    assert.deepEqual(normalizeServerUrl('localhost:3001'), { ok: true, origin: 'http://localhost:3001' });
  });

  test('https는 그대로 유지한다', () => {
    assert.deepEqual(normalizeServerUrl('https://news.example.com'), { ok: true, origin: 'https://news.example.com' });
  });

  test('경로·쿼리·해시는 버리고 origin만 남긴다', () => {
    assert.deepEqual(normalizeServerUrl('http://h:3001/login.do?x=1#top'), { ok: true, origin: 'http://h:3001' });
  });

  test('후행 슬래시는 남기지 않는다', () => {
    assert.deepEqual(normalizeServerUrl('http://h:3001/'), { ok: true, origin: 'http://h:3001' });
  });

  test('대문자 호스트·스킴은 URL 표준대로 소문자화된다', () => {
    assert.deepEqual(normalizeServerUrl('HTTP://MyServer:3001'), { ok: true, origin: 'http://myserver:3001' });
  });

  test('IPv6 대괄호는 URL origin 표현을 그대로 따른다', () => {
    assert.deepEqual(normalizeServerUrl('http://[::1]:3001'), { ok: true, origin: 'http://[::1]:3001' });
  });

  test('기본 포트(80/443)는 origin 표현에서 생략된다', () => {
    assert.deepEqual(normalizeServerUrl('http://h:80'), { ok: true, origin: 'http://h' });
    assert.deepEqual(normalizeServerUrl('https://h:443'), { ok: true, origin: 'https://h' });
  });

  test('앞뒤 공백은 트림한다', () => {
    assert.deepEqual(normalizeServerUrl('  http://h:3001  '), { ok: true, origin: 'http://h:3001' });
  });

  test('빈 값·공백만·비문자열 → empty', () => {
    for (const input of ['', '   ', null, undefined, 123, {}]) {
      assert.deepEqual(normalizeServerUrl(input), { ok: false, reason: 'empty' }, JSON.stringify(input));
    }
  });

  test('javascript:·file:·data:·ws: 스킴은 unsupported-scheme으로 거부한다', () => {
    for (const input of ['javascript:alert(1)', 'file:///C:/x', 'data:text/html,x', 'ws://h:3001', 'app://x']) {
      assert.deepEqual(normalizeServerUrl(input), { ok: false, reason: 'unsupported-scheme' }, input);
    }
  });

  test('user:pass@host는 credentials로 거부한다(설정 파일에 자격증명이 남는 표면 차단)', () => {
    assert.deepEqual(normalizeServerUrl('http://user:pass@h:3001'), { ok: false, reason: 'credentials' });
    assert.deepEqual(normalizeServerUrl('http://user@h:3001'), { ok: false, reason: 'credentials' });
  });

  test('파싱 불가 입력 → invalid', () => {
    assert.deepEqual(normalizeServerUrl('http://'), { ok: false, reason: 'invalid' });
    assert.deepEqual(normalizeServerUrl('http://h:port'), { ok: false, reason: 'invalid' });
  });

  test('호스트 내부 공백은 invalid — 스킴 유무 무관(보강: 오타 입력이 이상한 origin으로 새지 않는다)', () => {
    assert.deepEqual(normalizeServerUrl('http://my server:3001'), { ok: false, reason: 'invalid' });
    assert.deepEqual(normalizeServerUrl('192.168. 0.10:3001'), { ok: false, reason: 'invalid' });
  });

  test('스킴 없는 IPv6 대괄호도 http://를 보충한다(보강)', () => {
    assert.deepEqual(normalizeServerUrl('[::1]:3001'), { ok: true, origin: 'http://[::1]:3001' });
  });

  test('스킴 오인 호스트(localhost:포트) 뒤에 경로·쿼리가 붙어도 origin만 남는다(보강)', () => {
    assert.deepEqual(normalizeServerUrl('localhost:3001/list.do?x=1'), { ok: true, origin: 'http://localhost:3001' });
  });

  test('mailto: 등 비숫자 나머지를 가진 스킴은 unsupported-scheme(보강 — host:port 오인 휴리스틱의 경계)', () => {
    assert.deepEqual(normalizeServerUrl('mailto:user@h'), { ok: false, reason: 'unsupported-scheme' });
  });

  test('healthUrl/appUrl 조립', () => {
    assert.equal(healthUrl('http://h:3001'), 'http://h:3001/api/health');
    assert.equal(appUrl('http://h:3001'), 'http://h:3001/');
  });

  test('isSameOrigin — 참/거짓/파싱 실패', () => {
    assert.equal(isSameOrigin('http://h:3001/list.do?p=1', 'http://h:3001'), true);
    assert.equal(isSameOrigin('http://h:3002/list.do', 'http://h:3001'), false);
    assert.equal(isSameOrigin('https://h:3001/', 'http://h:3001'), false);
    assert.equal(isSameOrigin('not a url', 'http://h:3001'), false);
    assert.equal(isSameOrigin('http://h:3001/', 'garbage'), false);
  });

  test('interpretHealthResponse: 200 + {ok:true}만 통과한다', () => {
    assert.deepEqual(interpretHealthResponse({ status: 200, body: { ok: true } }), { ok: true });
  });

  test('interpretHealthResponse: 200이어도 본문이 다르면 not-article-server(사내 프록시·다른 웹서버 거절)', () => {
    for (const body of [{}, { ok: false }, '<html>portal</html>', null, undefined, [1], 'ok', { ok: 'true' }]) {
      assert.deepEqual(
        interpretHealthResponse({ status: 200, body }),
        { ok: false, reason: 'not-article-server' },
        JSON.stringify(body),
      );
    }
  });

  test('interpretHealthResponse: 200이 아니면 http-status', () => {
    for (const status of [401, 404, 500, 302]) {
      assert.deepEqual(interpretHealthResponse({ status, body: { ok: true } }), { ok: false, reason: 'http-status' }, String(status));
    }
  });

  test('interpretHealthResponse: status 없음(네트워크 실패) → unreachable', () => {
    assert.deepEqual(interpretHealthResponse({ status: null, body: undefined }), { ok: false, reason: 'unreachable' });
    assert.deepEqual(interpretHealthResponse({ status: undefined, body: undefined }), { ok: false, reason: 'unreachable' });
  });
});

// ---------------------------------------------------------------------------
describe('clientConfig', () => {
  const DEFAULT = { schemaVersion: CONFIG_SCHEMA_VERSION, serverUrl: null, bounds: null };

  test('configPath 조립', () => {
    assert.equal(configPath('C:/Users/x/AppData/Roaming/기사작성기'), path.join('C:/Users/x/AppData/Roaming/기사작성기', CONFIG_FILENAME));
  });

  test('parseConfig: null·깨진 JSON·배열·숫자·null 리터럴 → 기본값(throw 금지)', () => {
    for (const raw of [null, undefined, '{oops', '[1,2]', '42', 'null', '"str"', '']) {
      assert.deepEqual(parseConfig(raw), DEFAULT, JSON.stringify(raw));
    }
  });

  test('parseConfig: 비밀 키(sessionId·password·cookie·token)는 파일에 있어도 버린다(CRITICAL 보안)', () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      serverUrl: 'http://h:3001',
      sessionId: 'sid-leak',
      password: 'pw-leak',
      cookie: 'sid=abc',
      token: 't',
      bounds: { width: 1440, height: 900, x: 0, y: 0, maximized: false, secret: 'x' },
    });
    const parsed = parseConfig(raw);
    assert.deepEqual(Object.keys(parsed).sort(), ['bounds', 'schemaVersion', 'serverUrl']);
    assert.deepEqual(Object.keys(parsed.bounds).sort(), ['height', 'maximized', 'width', 'x', 'y']);
    assert.equal(JSON.stringify(parsed).includes('leak'), false);
  });

  test('parseConfig: 유효하지 않은 serverUrl 문자열은 읽을 때 버려진다(손편집 파일 방어)', () => {
    for (const bad of ['javascript:alert(1)', 'not a url', 42, { origin: 'http://h' }]) {
      const parsed = parseConfig(JSON.stringify({ schemaVersion: 1, serverUrl: bad }));
      assert.equal(parsed.serverUrl, null, JSON.stringify(bad));
    }
  });

  test('parseConfig: serverUrl은 재정규화된다(origin만 남는다)', () => {
    const parsed = parseConfig(JSON.stringify({ schemaVersion: 1, serverUrl: 'HTTP://H:3001/login.do?x=1' }));
    assert.equal(parsed.serverUrl, 'http://h:3001');
  });

  test('parseConfig: bounds 구조가 깨져 있으면 bounds만 null(전체를 죽이지 않는다)', () => {
    for (const bad of ['big', [1], { width: 'x', height: 900, x: 0, y: 0 }, { width: 1440 }]) {
      const parsed = parseConfig(JSON.stringify({ schemaVersion: 1, serverUrl: 'http://h:3001', bounds: bad }));
      assert.equal(parsed.bounds, null, JSON.stringify(bad));
      assert.equal(parsed.serverUrl, 'http://h:3001', JSON.stringify(bad));
    }
  });

  test('왕복 동등성: serialize → parse가 같은 값으로 돌아온다', () => {
    const cfg = {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      serverUrl: 'http://192.168.0.10:3001',
      bounds: { width: 1440, height: 900, x: 12, y: 34, maximized: false },
    };
    assert.deepEqual(parseConfig(serializeConfig(cfg)), cfg);
  });

  test('serializeConfig: 개행으로 끝나는 JSON 문자열이고 화이트리스트 밖 키를 쓰지 않는다', () => {
    const out = serializeConfig({ schemaVersion: 1, serverUrl: 'http://h:3001', bounds: null, sessionId: 'leak' });
    assert.equal(out.endsWith('\n'), true);
    assert.equal(out.includes('leak'), false);
    assert.deepEqual(Object.keys(JSON.parse(out)).sort(), ['bounds', 'schemaVersion', 'serverUrl']);
  });

  test('readConfigFile: 파일 없음(ENOENT)·읽기 실패 → 기본값(throw 금지)', async () => {
    const enoent = async () => { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; };
    assert.deepEqual(await readConfigFile('C:/nowhere/config.json', { readFile: enoent }), DEFAULT);
  });

  test('readConfigFile: 파일 내용이 깨진 JSON이어도 기본값으로 수렴한다(보강 — 손상 config 복구 경로)', async () => {
    const cfg = await readConfigFile('C:/x/config.json', { readFile: async () => '{broken json' });
    assert.deepEqual(cfg, DEFAULT); // serverUrl null → 셸은 설정 화면으로 간다(주소 재입력 복구).
  });

  test('readConfigFile: 파일 내용이 있으면 parseConfig를 거친다', async () => {
    const readFile = async () => JSON.stringify({ schemaVersion: 1, serverUrl: 'http://h:3001', junk: true });
    const cfg = await readConfigFile('C:/x/config.json', { readFile });
    assert.equal(cfg.serverUrl, 'http://h:3001');
    assert.equal('junk' in cfg, false);
  });

  test('writeConfigFile: 같은 디렉토리 tmp에 먼저 쓰고 rename한다(원자적 — 호출 순서 스파이 단언)', async () => {
    const calls = [];
    const target = path.join('C:', 'ud', '기사작성기', 'config.json');
    await writeConfigFile(target, { schemaVersion: 1, serverUrl: 'http://h:3001', bounds: null }, {
      mkdir: async (dir, opts) => { calls.push(['mkdir', dir, opts]); },
      writeFile: async (file, data) => { calls.push(['writeFile', file, data]); },
      rename: async (from, to) => { calls.push(['rename', from, to]); },
    });
    assert.deepEqual(calls.map((c) => c[0]), ['mkdir', 'writeFile', 'rename']);
    assert.equal(calls[0][1], path.dirname(target));
    assert.deepEqual(calls[0][2], { recursive: true });
    const tmpFile = calls[1][1];
    assert.notEqual(tmpFile, target); // 반쪽 JSON 방지 — 본 파일에 직접 쓰지 않는다.
    assert.equal(path.dirname(tmpFile), path.dirname(target)); // rename 원자성 = 같은 디렉토리.
    assert.equal(calls[1][2].endsWith('\n'), true);
    assert.deepEqual(calls[2].slice(1), [tmpFile, target]);
  });

  test('sanitizeBounds: 작업영역과 겹치는 정상 bounds는 유지된다', () => {
    const wa = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    const b = { width: 1440, height: 900, x: 100, y: 50, maximized: true };
    assert.deepEqual(sanitizeBounds(b, wa), b);
  });

  test('sanitizeBounds: 최소치(800×600) 미만·비정수 → null', () => {
    const wa = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    assert.equal(sanitizeBounds({ width: 799, height: 900, x: 0, y: 0, maximized: false }, wa), null);
    assert.equal(sanitizeBounds({ width: 1440, height: 599, x: 0, y: 0, maximized: false }, wa), null);
    assert.equal(sanitizeBounds({ width: 1440.5, height: 900, x: 0, y: 0, maximized: false }, wa), null);
    assert.equal(sanitizeBounds({ width: 1440, height: 900, x: 0.1, y: 0, maximized: false }, wa), null);
  });

  test('sanitizeBounds: 화면 밖(어느 작업영역과도 안 겹침)·모니터 제거(workAreas 빈 배열) → null', () => {
    const wa = [{ x: 0, y: 0, width: 1920, height: 1080 }];
    assert.equal(sanitizeBounds({ width: 1024, height: 720, x: 5000, y: 5000, maximized: false }, wa), null);
    assert.equal(sanitizeBounds({ width: 1024, height: 720, x: 0, y: 0, maximized: false }, []), null);
    assert.equal(sanitizeBounds(null, wa), null);
  });

  test('sanitizeBounds: 보조 모니터(음수 좌표 작업영역)와 겹치면 유지된다', () => {
    const wa = [{ x: -1920, y: 0, width: 1920, height: 1080 }, { x: 0, y: 0, width: 1920, height: 1080 }];
    const b = { width: 1024, height: 720, x: -1800, y: 100, maximized: false };
    assert.deepEqual(sanitizeBounds(b, wa), b);
  });
});

// ---------------------------------------------------------------------------
describe('windowPolicy', () => {
  const ORIGIN = 'http://192.168.0.10:3001';
  const PRELOAD = 'C:/app/resources/app/preload.cjs';

  test('상수 계약', () => {
    assert.equal(APP_WINDOW, 'app');
    assert.equal(LOCAL_WINDOW, 'local');
  });

  test('app 창 옵션: preload 키가 아예 없다(값 undefined도 금지 — 객체 수준 증명)', () => {
    const opts = buildWindowOptions('app');
    assert.equal('preload' in opts.webPreferences, false);
  });

  test('app 창 옵션: 보안 플래그 6종 + spellcheck:false(ADR-008 egress 0 — 사전 다운로드 차단)', () => {
    const wp = buildWindowOptions('app').webPreferences;
    assert.equal(wp.contextIsolation, true);
    assert.equal(wp.nodeIntegration, false);
    assert.equal(wp.nodeIntegrationInWorker, false);
    assert.equal(wp.nodeIntegrationInSubFrames, false);
    assert.equal(wp.sandbox, true);
    assert.equal(wp.webviewTag, false);
    assert.equal(wp.spellcheck, false);
  });

  test('local 창 옵션: 같은 보안값 + preload가 있다', () => {
    const opts = buildWindowOptions('local', { preloadPath: PRELOAD });
    assert.equal(opts.webPreferences.preload, PRELOAD);
    assert.equal(opts.webPreferences.sandbox, true);
    assert.equal(opts.webPreferences.contextIsolation, true);
    assert.equal(opts.webPreferences.spellcheck, false);
  });

  test('local 창은 preloadPath 없이 만들 수 없다(throw — 조용한 반쪽 상태 금지)', () => {
    assert.throws(() => buildWindowOptions('local'));
    assert.throws(() => buildWindowOptions('local', {}));
  });

  test('알 수 없는 kind는 throw한다(fail-closed)', () => {
    assert.throws(() => buildWindowOptions('remote'));
    assert.throws(() => buildWindowOptions());
  });

  test('공통 옵션: show 기본 false·autoHideMenuBar·흰 배경·기본 크기(app 1440×900/min 1024×720, local 560×420)', () => {
    const app = buildWindowOptions('app');
    assert.equal(app.show, false);
    assert.equal(app.autoHideMenuBar, true);
    assert.equal(app.backgroundColor, '#ffffff');
    assert.equal(app.width, 1440);
    assert.equal(app.height, 900);
    assert.equal(app.minWidth, 1024);
    assert.equal(app.minHeight, 720);
    const local = buildWindowOptions('local', { preloadPath: PRELOAD });
    assert.equal(local.width, 560);
    assert.equal(local.height, 420);
    assert.equal(local.show, false);
  });

  test('app 창 옵션: 저장된 bounds가 있으면 크기·좌표로 쓴다 / show 지정 가능', () => {
    const opts = buildWindowOptions('app', { bounds: { width: 1200, height: 800, x: 30, y: 40, maximized: false }, show: true });
    assert.equal(opts.width, 1200);
    assert.equal(opts.height, 800);
    assert.equal(opts.x, 30);
    assert.equal(opts.y, 40);
    assert.equal(opts.show, true);
  });

  test('app 창 옵션: bounds에 x/y가 없으면 좌표 키를 넣지 않는다(보강 — OS 기본 배치에 맡긴다)', () => {
    const opts = buildWindowOptions('app', { bounds: { width: 1200, height: 800, maximized: false } });
    assert.equal(opts.width, 1200);
    assert.equal(opts.height, 800);
    assert.equal('x' in opts, false);
    assert.equal('y' in opts, false);
  });

  test('decideWindowOpen: 대문자 스킴·호스트의 동일 출처 URL도 allow(보강 — 문자열 비교가 아니라 URL 정규화 위임 증명)', () => {
    const d = decideWindowOpen({ url: 'HTTP://192.168.0.10:3001/list.do', serverOrigin: ORIGIN, kind: 'app' });
    assert.equal(d.action, 'allow');
  });

  test('decideWindowOpen: kind=local은 무엇이든 deny(about:blank 자식이 preload를 상속하기 때문)', () => {
    for (const url of ['about:blank', `${ORIGIN}/list.do`, 'https://www.youtube.com/watch?v=x', 'file:///C:/x']) {
      assert.deepEqual(decideWindowOpen({ url, serverOrigin: ORIGIN, kind: 'local' }), { action: 'deny' }, url);
    }
  });

  test('decideWindowOpen: app의 about:blank는 720×800 + outlivesOpener:true로 허용(상세보기·인쇄 창)', () => {
    const d = decideWindowOpen({ url: 'about:blank', serverOrigin: ORIGIN, kind: 'app' });
    assert.equal(d.action, 'allow');
    assert.equal(d.outlivesOpener, true);
    assert.equal(d.overrideBrowserWindowOptions.width, 720);
    assert.equal(d.overrideBrowserWindowOptions.height, 800);
    assert.equal(d.overrideBrowserWindowOptions.autoHideMenuBar, true);
    // about:blank는 webPreferences override가 무시된다 — "적용된다"는 착각을 코드에 남기지 않는다.
    assert.equal('webPreferences' in d.overrideBrowserWindowOptions, false);
  });

  test('decideWindowOpen: app의 동일 출처 http(s)는 허용', () => {
    const d = decideWindowOpen({ url: `${ORIGIN}/list.do`, serverOrigin: ORIGIN, kind: 'app' });
    assert.equal(d.action, 'allow');
    assert.equal(d.overrideBrowserWindowOptions.autoHideMenuBar, true);
  });

  test('decideWindowOpen: app의 외부 http(s)는 deny + openExternal(기본 브라우저로)', () => {
    const url = 'https://www.youtube.com/watch?v=abc';
    assert.deepEqual(decideWindowOpen({ url, serverOrigin: ORIGIN, kind: 'app' }), { action: 'deny', openExternal: url });
  });

  test('decideWindowOpen: javascript:·file:·custom 스킴은 deny이고 openExternal이 없다', () => {
    for (const url of ['javascript:alert(1)', 'file:///C:/x', 'myapp://go']) {
      const d = decideWindowOpen({ url, serverOrigin: ORIGIN, kind: 'app' });
      assert.equal(d.action, 'deny', url);
      assert.equal('openExternal' in d, false, url);
    }
  });

  test('decideWindowOpen: kind 미지정·알 수 없는 값·serverOrigin 없음·파싱 실패 → deny(fail-closed)', () => {
    assert.deepEqual(decideWindowOpen({ url: 'about:blank', serverOrigin: ORIGIN }), { action: 'deny' });
    assert.deepEqual(decideWindowOpen({ url: 'about:blank', serverOrigin: ORIGIN, kind: 'zzz' }), { action: 'deny' });
    assert.deepEqual(decideWindowOpen({ url: 'about:blank', kind: 'app' }), { action: 'deny' });
    assert.deepEqual(decideWindowOpen({ url: 'not a url', serverOrigin: ORIGIN, kind: 'app' }), { action: 'deny' });
  });

  test('decideNavigation: kind=local은 전량 block(preload가 붙은 webContents는 어디로도 안 간다 — 최상위 불변식)', () => {
    for (const url of [`${ORIGIN}/`, 'file:///C:/app/pages/setup.html', 'https://evil.example.com/', 'about:blank']) {
      assert.equal(decideNavigation({ url, serverOrigin: ORIGIN, kind: 'local' }), 'block', url);
    }
  });

  test('decideNavigation: app은 동일 출처 allow / 외부 http(s) external / 그 외 스킴 block', () => {
    assert.equal(decideNavigation({ url: `${ORIGIN}/list.do`, serverOrigin: ORIGIN, kind: 'app' }), 'allow');
    assert.equal(decideNavigation({ url: 'https://example.com/', serverOrigin: ORIGIN, kind: 'app' }), 'external');
    assert.equal(decideNavigation({ url: 'file:///C:/x', serverOrigin: ORIGIN, kind: 'app' }), 'block');
    assert.equal(decideNavigation({ url: 'javascript:alert(1)', serverOrigin: ORIGIN, kind: 'app' }), 'block');
  });

  test('decideNavigation: kind 미지정·serverOrigin 없음·파싱 실패 → block(fail-closed — 미등록 webContents가 탄다)', () => {
    assert.equal(decideNavigation({ url: `${ORIGIN}/` }), 'block');
    assert.equal(decideNavigation({ url: `${ORIGIN}/`, serverOrigin: ORIGIN, kind: 'zzz' }), 'block');
    assert.equal(decideNavigation({ url: `${ORIGIN}/`, kind: 'app' }), 'block');
    assert.equal(decideNavigation({ url: '::::', serverOrigin: ORIGIN, kind: 'app' }), 'block');
  });

  test('isExternallyOpenable: http(s)만 true(shell.openExternal에 임의 스킴 금지)', () => {
    assert.equal(isExternallyOpenable('http://example.com/'), true);
    assert.equal(isExternallyOpenable('https://example.com/'), true);
    assert.equal(isExternallyOpenable('file:///C:/x'), false);
    assert.equal(isExternallyOpenable('javascript:alert(1)'), false);
    assert.equal(isExternallyOpenable('myapp://x'), false);
    assert.equal(isExternallyOpenable('not a url'), false);
  });
});

// ---------------------------------------------------------------------------
describe('loadFailure', () => {
  test('서브프레임 실패는 무시한다(null — 정상 사용 중 화면을 날리지 않는다)', () => {
    assert.equal(describeLoadFailure({ errorCode: -105, errorDescription: 'ERR_NAME_NOT_RESOLVED', validatedUrl: 'http://h:3001/', isMainFrame: false }), null);
  });

  test('-3(ERR_ABORTED)은 정상 취소 — 무시한다', () => {
    assert.equal(describeLoadFailure({ errorCode: -3, errorDescription: 'ERR_ABORTED', validatedUrl: 'http://h:3001/', isMainFrame: true }), null);
  });

  test('주요 errorCode 4종은 서로 다른 한국어 문구를 준다', () => {
    const codes = [-105, -102, -109, -118];
    const results = codes.map((errorCode) => describeLoadFailure({
      errorCode, errorDescription: 'x', validatedUrl: 'http://h:3001/list.do?q=1', isMainFrame: true,
    }));
    for (const r of results) {
      assert.notEqual(r, null);
      assert.equal(typeof r.title, 'string');
      assert.equal(typeof r.message, 'string');
      assert.equal(typeof r.hint, 'string');
      assert.equal(r.canRetry, true);
    }
    const messages = results.map((r) => r.message + r.hint);
    assert.equal(new Set(messages).size, codes.length, '4종 문구가 서로 달라야 한다');
  });

  test('문구에 URL 전체(경로·쿼리)를 노출하지 않는다 — origin까지만', () => {
    const r = describeLoadFailure({ errorCode: -102, errorDescription: 'ERR_CONNECTION_REFUSED', validatedUrl: 'http://h:3001/list.do?secret=1', isMainFrame: true });
    const all = `${r.title} ${r.message} ${r.hint}`;
    assert.equal(all.includes('list.do'), false);
    assert.equal(all.includes('secret'), false);
  });

  test('알 수 없는 코드는 일반 문구 + errorDescription 병기', () => {
    const r = describeLoadFailure({ errorCode: -999, errorDescription: 'ERR_SOMETHING_ODD', validatedUrl: 'http://h:3001/', isMainFrame: true });
    assert.notEqual(r, null);
    assert.equal(r.canRetry, true);
    assert.equal(`${r.message} ${r.hint}`.includes('ERR_SOMETHING_ODD'), true);
  });

  test('describeHttpFailure: 2xx/3xx는 null', () => {
    assert.equal(describeHttpFailure({ httpResponseCode: 200, url: 'http://h:3001/' }), null);
    assert.equal(describeHttpFailure({ httpResponseCode: 302, url: 'http://h:3001/' }), null);
  });

  test('describeHttpFailure: 404는 "서버는 응답하지만 SPA 미서빙(web/ 확인)"으로 특화한다', () => {
    const r = describeHttpFailure({ httpResponseCode: 404, url: 'http://h:3001/login.do' });
    assert.notEqual(r, null);
    assert.equal(r.canRetry, true);
    assert.equal(`${r.message} ${r.hint}`.includes('web/'), true);
  });

  test('describeHttpFailure: 그 외 4xx/5xx는 상태코드를 병기한 일반 안내', () => {
    const r = describeHttpFailure({ httpResponseCode: 503, url: 'http://h:3001/' });
    assert.notEqual(r, null);
    assert.equal(`${r.title} ${r.message} ${r.hint}`.includes('503'), true);
    const r404 = describeHttpFailure({ httpResponseCode: 404, url: 'http://h:3001/' });
    assert.notEqual(`${r.message}${r.hint}`, `${r404.message}${r404.hint}`);
  });
});
