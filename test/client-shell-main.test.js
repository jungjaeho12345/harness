// 셸 결선 보조 모듈 단위 테스트 (phase 62 step1) — menu·ipcGuard·diag를 Electron 없이 잠근다.
// CRITICAL: 메뉴에 단축키를 달지 않는다 — 메뉴 단축키는 렌더러 keydown보다 먼저 처리되어 SPA 에디터
// 단축키(Ctrl+B/D/F/Y/A, Alt+V/O/Y, Ctrl+X/C/V)를 조용히 삼킨다. 편집 계열 role도 같은 이유로 금지
// (role:'redo'=Ctrl+Y=(계속)삽입, role:'selectAll'=Ctrl+A와 정면 충돌). role 기본 키(reload=Ctrl+R·
// 확대/축소)는 SPA 예약키와 교집합이 없어 허용한다(게이트 ② 확정).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMenuTemplate } from '../client/menu.js';
import { isTrustedSender } from '../client/ipcGuard.js';
import { createDiag, redactDiagEvent, formatDiagLine } from '../client/diag.js';

// 템플릿 재귀 순회 — submenu를 포함한 모든 항목 객체를 평탄화한다.
function walkItems(template) {
  const out = [];
  for (const item of template) {
    out.push(item);
    if (Array.isArray(item.submenu)) out.push(...walkItems(item.submenu));
  }
  return out;
}

const EDIT_ROLES = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectall', 'pasteandmatchstyle', 'delete']);
const ALLOWED_ROLES = new Set(['reload', 'zoomin', 'zoomout', 'resetzoom', 'toggledevtools']);

describe('menu.buildMenuTemplate', () => {
  test('명시 단축키 지정 키가 템플릿 어디에도 없다(dev 모드 포함)', () => {
    for (const dev of [false, true]) {
      for (const item of walkItems(buildMenuTemplate({ dev }))) {
        assert.equal('accelerator' in item, false, `dev=${dev} label=${item.label ?? item.role ?? item.type}`);
      }
    }
  });

  test('편집 계열 role(undo/redo/cut/copy/paste/selectAll)이 0개다', () => {
    for (const dev of [false, true]) {
      for (const item of walkItems(buildMenuTemplate({ dev }))) {
        if (typeof item.role === 'string') {
          assert.equal(EDIT_ROLES.has(item.role.toLowerCase()), false, `dev=${dev} role=${item.role}`);
        }
      }
    }
  });

  test('사용하는 role은 허용 목록(reload·zoomIn·zoomOut·resetZoom·toggleDevTools) 안이다', () => {
    for (const item of walkItems(buildMenuTemplate({ dev: true }))) {
      if (typeof item.role === 'string') {
        assert.equal(ALLOWED_ROLES.has(item.role.toLowerCase()), true, `role=${item.role}`);
      }
    }
  });

  test('보기 메뉴에 새로고침·확대·축소·원래 크기 항목이 있다(커스텀 메뉴는 기본 role 항목을 대체해야 한다)', () => {
    const template = buildMenuTemplate();
    const view = template.find((t) => t.label === '보기');
    assert.notEqual(view, undefined);
    const roles = walkItems(view.submenu).map((i) => i.role).filter(Boolean);
    for (const role of ['reload', 'zoomIn', 'zoomOut', 'resetZoom']) {
      assert.equal(roles.includes(role), true, role);
    }
    const labels = walkItems(view.submenu).map((i) => i.label).filter(Boolean);
    assert.equal(labels.includes('새로고침'), true);
  });

  test('라벨에 mnemonic(&)이 없다(Alt 조합 충돌 표면 축소)', () => {
    for (const item of walkItems(buildMenuTemplate({ dev: true }))) {
      if (typeof item.label === 'string') assert.equal(item.label.includes('&'), false, item.label);
    }
  });

  test('파일 메뉴: 서버 주소 변경·다시 연결·종료가 주입된 handlers에 결선된다', () => {
    const calls = [];
    const handlers = {
      changeServer: () => calls.push('changeServer'),
      reconnect: () => calls.push('reconnect'),
      quit: () => calls.push('quit'),
      about: () => calls.push('about'),
    };
    const template = buildMenuTemplate({ handlers });
    const file = template.find((t) => t.label === '파일');
    assert.notEqual(file, undefined);
    const byLabel = (label) => walkItems(template).find((i) => i.label === label);
    for (const [label, expected] of [['서버 주소 변경', 'changeServer'], ['다시 연결', 'reconnect'], ['종료', 'quit'], ['정보', 'about']]) {
      const item = byLabel(label);
      assert.notEqual(item, undefined, label);
      assert.equal(typeof item.click, 'function', label);
      item.click();
      assert.equal(calls.at(-1), expected, label);
    }
  });

  test('dev:false면 개발자도구 항목이 없고 dev:true면 있다', () => {
    const prodRoles = walkItems(buildMenuTemplate({ dev: false })).map((i) => (i.role ?? '').toLowerCase());
    assert.equal(prodRoles.includes('toggledevtools'), false);
    const devRoles = walkItems(buildMenuTemplate({ dev: true })).map((i) => (i.role ?? '').toLowerCase());
    assert.equal(devRoles.includes('toggledevtools'), true);
  });
});

describe('ipcGuard.isTrustedSender', () => {
  test('file:// + 같은 contents id → true', () => {
    assert.equal(isTrustedSender({ senderUrl: 'file:///C:/app/pages/setup.html', senderContentsId: 7, localContentsId: 7 }), true);
  });

  test('원격 URL(http/https)은 id가 같아도 false', () => {
    assert.equal(isTrustedSender({ senderUrl: 'http://h:3001/list.do', senderContentsId: 7, localContentsId: 7 }), false);
    assert.equal(isTrustedSender({ senderUrl: 'https://h:3001/', senderContentsId: 7, localContentsId: 7 }), false);
  });

  test('file://이지만 다른 contents id → false(다른 창)', () => {
    assert.equal(isTrustedSender({ senderUrl: 'file:///C:/app/pages/setup.html', senderContentsId: 7, localContentsId: 8 }), false);
  });

  test('senderUrl 없음(null·undefined·비문자열) → false', () => {
    assert.equal(isTrustedSender({ senderUrl: null, senderContentsId: 7, localContentsId: 7 }), false);
    assert.equal(isTrustedSender({ senderUrl: undefined, senderContentsId: 7, localContentsId: 7 }), false);
    assert.equal(isTrustedSender({ senderUrl: 42, senderContentsId: 7, localContentsId: 7 }), false);
  });

  test('localContentsId 미지정(로컬 창 없음) → false(fail-closed)', () => {
    assert.equal(isTrustedSender({ senderUrl: 'file:///C:/x.html', senderContentsId: 7 }), false);
    assert.equal(isTrustedSender({ senderUrl: 'file:///C:/x.html', senderContentsId: 7, localContentsId: null }), false);
    assert.equal(isTrustedSender({ senderUrl: 'file:///C:/x.html', senderContentsId: undefined, localContentsId: undefined }), false);
  });
});

describe('diag', () => {
  test('createDiag({}) — filePath 없으면 완전 no-op(파일 함수 호출 0, 스파이 단언)', () => {
    const calls = [];
    const diag = createDiag({ appendFileSync: (...a) => calls.push(a) });
    diag.log('app-ready', {});
    diag.log('probe', { origin: 'http://h:3001', ok: true });
    assert.equal(calls.length, 0);
  });

  test('createDiag({filePath}) — formatDiagLine 결과를 append한다', () => {
    const calls = [];
    const diag = createDiag({ filePath: 'C:/tmp/diag.jsonl', appendFileSync: (...a) => calls.push(a) });
    diag.log('app-ready', {});
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'C:/tmp/diag.jsonl');
    const parsed = JSON.parse(calls[0][1]);
    assert.equal(parsed.event, 'app-ready');
    assert.equal(typeof parsed.ts, 'string');
  });

  test('diag 기록 실패는 앱을 죽이지 않는다(throw 삼킴)', () => {
    const diag = createDiag({ filePath: 'C:/tmp/diag.jsonl', appendFileSync: () => { throw new Error('disk full'); } });
    assert.doesNotThrow(() => diag.log('app-ready', {}));
  });

  test('redactDiagEvent: body·sessionId·cookie·password 키를 제거한다', () => {
    const out = redactDiagEvent('did-finish-load', {
      url: 'http://h:3001/list.do',
      title: 'AB1200123',
      body: '기사 본문 유출',
      sessionId: 'sid-leak',
      cookie: 'sid=abc',
      password: 'pw',
      token: 'tk',
    });
    for (const key of ['body', 'sessionId', 'cookie', 'password', 'token']) {
      assert.equal(key in out, false, key);
    }
    assert.equal(out.title, 'AB1200123');
  });

  test('redactDiagEvent: URL 값은 origin+pathname까지만(쿼리·해시 제거 — 기사아이디·토큰 표면 차단)', () => {
    const out = redactDiagEvent('navigation', { url: 'http://h:3001/list.do?articleId=AB12&sid=leak#top' });
    assert.equal(out.url, 'http://h:3001/list.do');
  });

  test('redactDiagEvent: file: 스킴은 스킴+파일명만 남긴다(로컬 절대 경로 비노출 — 게이트 ② 확정 예외)', () => {
    const out = redactDiagEvent('did-finish-load', { url: 'file:///D:/agents/harness/client/pages/setup.html' });
    assert.equal(out.url, 'file:///setup.html');
  });

  test('redactDiagEvent: about:blank·비URL 문자열은 그대로 둔다', () => {
    assert.equal(redactDiagEvent('window-open', { url: 'about:blank' }).url, 'about:blank');
    assert.equal(redactDiagEvent('probe', { reason: 'not-article-server' }).reason, 'not-article-server');
  });

  test('formatDiagLine: 개행 1개로 끝나는 유효 JSON이고 ts·event를 갖는다', () => {
    const line = formatDiagLine('probe', { origin: 'http://h:3001', ok: false, reason: 'unreachable' }, 1723500000000);
    assert.equal(line.endsWith('\n'), true);
    assert.equal(line.endsWith('\n\n'), false);
    const parsed = JSON.parse(line);
    assert.equal(parsed.ts, new Date(1723500000000).toISOString());
    assert.equal(parsed.event, 'probe');
    assert.equal(parsed.origin, 'http://h:3001');
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reason, 'unreachable');
  });

  test('formatDiagLine도 redact를 거친다(쿼리 제거)', () => {
    const parsed = JSON.parse(formatDiagLine('app-window', { url: 'http://h:3001/?token=leak' }, 0));
    assert.equal(parsed.url, 'http://h:3001/');
  });
});
