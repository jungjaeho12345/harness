// verify-integration 모드 분기의 순수 판정부 (phase 76 step4 — scripts/lib/integrationMode.mjs)를
// **기본 스위트**로 잠근다. (④ 테스트 게이트 · 2026-09-09)
//
// 왜 이 파일이 필요한가 — 그 모듈에는 자동 게이트가 없었다:
//   · `npm test` 는 `test/**/*.test.js` 만 돈다 → `scripts/lib/integrationMode.test.mjs`(9항)는 잡히지 않는다.
//   · 이 phase 의 다른 드라이버는 전부 자기검사를 **스스로** 돌린다
//     (spring-contract·spool-parity·spa-parity·tick-cutover-probe·pool-ceiling-probe·load-rehearsal
//      → `runSelfTest(...)`). `scripts/verify-integration.mjs` 만 그 호출이 없다.
//   · `scripts/**` 는 eslint ignore 대상이라 정적 검사도 닿지 않는다(cli-args.test.js·exe-branding.test.js 와 같은 사정).
//   ⇒ 결과적으로 `integrationMode.mjs` 를 고쳐도 **어떤 커맨드도 red 가 되지 않는 상태**였다.
//     여기서는 그 모듈의 계약을 다시 잠그고, 자기검사가 재지 않던 경계(PORT 범위 양끝 · stamp 자릿수 ·
//     articleId 길이 상한 · files 가 배열이 아닌 경우)를 더한다.
//
// 규율: 순수 함수만 부른다(서버·포트·DB 없음). listFilesRecursive 만 OS 임시 디렉토리를 쓰고 반드시 지운다.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SERVER_MODES, SPRING_ENV_KEYS, isSpoolFileName, judgeSpool, listFilesRecursive,
  osEnvAllowlist, parseServerMode, springServerEnv,
} from '../scripts/lib/integrationMode.mjs';

const REPO_ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
const ID = 'AKR20260907123456789';
const GIVEN = { dataDir: 'D:\\tmp\\data', port: 23456, host: '127.0.0.1', spaDir: 'D:\\repo\\web\\dist', spoolDir: 'D:\\tmp\\spool' };

describe('integrationMode — --server 허용값', () => {
  test('허용값은 정확히 exe·spring 두 개다(집합이 아니라 순서까지)', () => {
    assert.deepEqual([...SERVER_MODES], ['exe', 'spring']);
  });

  test('허용값 밖·대소문자 변형·비문자열은 전부 거부하고 메시지가 허용값을 지목한다', () => {
    assert.deepEqual(parseServerMode('exe'), { ok: true, mode: 'exe' });
    assert.deepEqual(parseServerMode('spring'), { ok: true, mode: 'spring' });
    for (const bad of ['foo', 'EXE', 'Spring', 'spring ', '', undefined, null, 1, {}, ['spring']]) {
      const r = parseServerMode(bad);
      assert.equal(r.ok, false, `허용값 밖인데 ok: ${JSON.stringify(bad)}`);
      assert.match(r.message, /exe\|spring/);
    }
  });
});

describe('integrationMode — spring 자식 env 허용목록', () => {
  const WIN_PARENT = {
    SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', TEMP: 'C:\\t', PATH: 'C:\\bin', PATHEXT: '.EXE',
    APP_ENV: 'production', NODE_ENV: 'production', COLLECTION_TOKEN: 'leak', SPA_DIR: 'C:\\stale-spa',
    DIST_SPOOL_DIR: 'C:\\stale-spool', DATA_DIR: 'C:\\stale-data', PORT: '1', HOST: '0.0.0.0',
    NEWS_DB_URL: 'jdbc:mysql://x/y', NEWS_DB_PASSWORD: 'leak', NEWS_CT_MYSQL_PASSWORD: 'leak',
    JAVA_HOME: 'C:\\jdk', SPRING_JAVA_HOME: 'C:\\jdk', NODE_OPTIONS: '--require x', ELECTRON_RUN_AS_NODE: '1',
    DB_KIND: 'mysql',
  };

  test('허용목록은 win32/posix 로 갈리고 win32 에는 PATH 가 없다(시스템 java 폴백 금지의 env 판)', () => {
    assert.deepEqual(osEnvAllowlist('win32'), [
      'SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
      'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
    ]);
    assert.deepEqual(osEnvAllowlist('linux'), ['PATH', 'HOME', 'LANG', 'TZ']);
    assert.deepEqual([...SPRING_ENV_KEYS], ['DATA_DIR', 'PORT', 'HOST', 'SPA_DIR', 'DIST_SPOOL_DIR']);
  });

  test('OS 허용목록과 명시 주입 5키는 서로소다 — 부모 값이 주입 키의 자리를 차지할 수 없다', () => {
    for (const platform of ['win32', 'linux']) {
      for (const key of osEnvAllowlist(platform)) {
        assert.equal(SPRING_ENV_KEYS.includes(key), false, `${platform} 허용목록이 주입 키를 겸한다: ${key}`);
      }
    }
  });

  test('부모의 APP_ENV·NODE_ENV·토큰·stale 경로·NEWS_* 비밀·DB_KIND 는 한 키도 실리지 않는다', () => {
    const env = springServerEnv({ parentEnv: WIN_PARENT, platform: 'win32', ...GIVEN });
    assert.deepEqual(Object.keys(env).sort(),
      ['DATA_DIR', 'DIST_SPOOL_DIR', 'HOST', 'PATHEXT', 'PORT', 'SPA_DIR', 'SystemRoot', 'TEMP', 'windir']);
    for (const leaked of ['APP_ENV', 'NODE_ENV', 'COLLECTION_TOKEN', 'NEWS_DB_URL', 'NEWS_DB_PASSWORD',
      'NEWS_CT_MYSQL_PASSWORD', 'JAVA_HOME', 'SPRING_JAVA_HOME', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PATH', 'DB_KIND']) {
      assert.equal(leaked in env, false, `${leaked} 가 새어 들어왔다`);
    }
    // 부모에 같은 이름의 stale 값이 있어도 **준 값**이 이긴다.
    assert.equal(env.SPA_DIR, GIVEN.spaDir);
    assert.equal(env.DIST_SPOOL_DIR, GIVEN.spoolDir);
    assert.equal(env.DATA_DIR, GIVEN.dataDir);
    assert.equal(env.PORT, '23456', 'PORT 는 문자열로 실린다');
    // 어떤 값도 부모의 비밀 문자열과 같지 않다.
    for (const value of Object.values(env)) assert.notEqual(value, 'leak');
  });

  test('5키 중 하나라도 비면 키 이름을 지목하며 거부한다(조용한 기본값 폴백 금지)', () => {
    for (const [key, patch] of [
      ['DATA_DIR', { dataDir: '' }], ['DATA_DIR', { dataDir: '   ' }], ['PORT', { port: undefined }],
      ['HOST', { host: null }], ['SPA_DIR', { spaDir: '' }], ['DIST_SPOOL_DIR', { spoolDir: undefined }],
    ]) {
      assert.throws(
        () => springServerEnv({ parentEnv: {}, platform: 'win32', ...GIVEN, ...patch }),
        (err) => err instanceof Error && err.message.includes(key),
        `${key} 누락이 거부되지 않았다`,
      );
    }
  });

  test('PORT 는 1~65535 정수만 — 양끝은 통과하고 0·65536·소수·비수치는 거부한다(자기검사가 재지 않던 경계)', () => {
    for (const port of [1, 65535, '8080']) {
      assert.equal(springServerEnv({ parentEnv: {}, platform: 'win32', ...GIVEN, port }).PORT, String(port));
    }
    for (const port of [0, -1, 65536, 1.5, '80.5', 'abc', '8080abc', Number.NaN, Infinity]) {
      assert.throws(() => springServerEnv({ parentEnv: {}, platform: 'win32', ...GIVEN, port }), /PORT/,
        `PORT=${String(port)} 가 통과했다`);
    }
  });

  test('부모 env 를 주지 않아도 5키만으로 조립된다(허용목록은 있으면 통과, 없으면 생략)', () => {
    assert.deepEqual(Object.keys(springServerEnv({ platform: 'win32', ...GIVEN })).sort(),
      ['DATA_DIR', 'DIST_SPOOL_DIR', 'HOST', 'PORT', 'SPA_DIR']);
  });
});

describe('integrationMode — 스풀 파일명 판정', () => {
  test('<articleId>_<YYYYMMDDTHHMMSSmmmZ>.json 정확 일치만 통과한다', () => {
    assert.equal(isSpoolFileName(`${ID}_20260907T010203456Z.json`, ID), true);
    assert.equal(isSpoolFileName(`${ID}_20260907T010203Z.json`, ID), false, '소수부 없는 stamp 는 거부');
    assert.equal(isSpoolFileName(`.${ID}_20260907T010203456Z.json.tmp`, ID), false, '원자적 게시 전 임시 파일은 거부');
    assert.equal(isSpoolFileName(`${ID}1_20260907T010203456Z.json`, ID), false, '접두사만 같은 다른 기사는 거부');
    assert.equal(isSpoolFileName(`${ID}_2026-09-07T01:02:03.456Z.json`, ID), false, 'compact 가 아닌 ISO 원문은 거부');
  });

  test('stamp 자릿수는 8+9 고정이다 — 한 자리 모자라거나 남으면 거부(경계)', () => {
    assert.equal(isSpoolFileName(`${ID}_2026090T010203456Z.json`, ID), false, '날짜 7자리');
    assert.equal(isSpoolFileName(`${ID}_202609070T010203456Z.json`, ID), false, '날짜 9자리');
    assert.equal(isSpoolFileName(`${ID}_20260907T01020345Z.json`, ID), false, '시각 8자리');
    assert.equal(isSpoolFileName(`${ID}_20260907T0102034567Z.json`, ID), false, '시각 10자리');
    assert.equal(isSpoolFileName(`${ID}_20260907t010203456Z.json`, ID), false, '소문자 t 는 거부');
    assert.equal(isSpoolFileName(`${ID}_20260907T010203456z.json`, ID), false, '소문자 z 는 거부');
    assert.equal(isSpoolFileName(` ${ID}_20260907T010203456Z.json`, ID), false, '선행 공백은 거부');
    assert.equal(isSpoolFileName(`${ID}_20260907T010203456Z.json\n`, ID), false, '뒤 개행은 거부');
  });

  test('articleId 는 [A-Za-z0-9_-] 1~64자만 — 정규식 메타문자·상한 초과·빈 값은 어떤 파일명도 통과시키지 않는다', () => {
    const dashed = 'a-b_c-1';
    assert.equal(isSpoolFileName(`${dashed}_20260907T010203456Z.json`, dashed), true, '하이픈은 정당한 id 이고 이스케이프돼야 한다');
    assert.equal(isSpoolFileName(`aXb_20260907T010203456Z.json`, 'a.b'), false, "'.' 는 id 가 아니다 — 와일드카드로 새면 안 된다");
    const max = 'A'.repeat(64);
    assert.equal(isSpoolFileName(`${max}_20260907T010203456Z.json`, max), true, '64자는 상한 안이다');
    const over = 'A'.repeat(65);
    assert.equal(isSpoolFileName(`${over}_20260907T010203456Z.json`, over), false, '65자는 거부');
    assert.equal(isSpoolFileName(`${ID}_20260907T010203456Z.json`, ''), false);
    assert.equal(isSpoolFileName(undefined, ID), false);
  });
});

describe('integrationMode — 배부 관측 판정(judgeSpool)', () => {
  const files = [
    `press-x/${ID}_20260907T010203456Z.json`,
    `press-x/.${ID}_20260907T010203457Z.json.tmp`,
    'nonpress-y/OTHER_20260907T010203456Z.json',
  ];

  test('전제가 없으면 조용한 skip 이 아니라 명시 실패이고 사유가 자리를 지목한다', () => {
    const cases = [
      [{ spoolDir: '', articleId: ID, files }, /DIST_SPOOL_DIR/],
      [{ spoolDir: '   ', articleId: ID, files }, /DIST_SPOOL_DIR/],
      [{ spoolDir: undefined, articleId: ID, files }, /DIST_SPOOL_DIR/],
      [{ spoolDir: 'D:\\x', articleId: undefined, files }, /articleId/],
      [{ spoolDir: 'D:\\x', articleId: '', files }, /articleId/],
      [{ spoolDir: 'D:\\x', articleId: ID, files: null }, /읽지 못했다/],
      [{ spoolDir: 'D:\\x', articleId: ID, files: undefined }, /읽지 못했다/],
      [{ spoolDir: 'D:\\x', articleId: ID, files: {} }, /읽지 못했다/],
      [{ spoolDir: 'D:\\x', articleId: ID, files: [] }, /0건/],
    ];
    for (const [input, pattern] of cases) {
      const r = judgeSpool(input);
      assert.equal(r.ok, false, `공허 통과: ${JSON.stringify(input)}`);
      assert.match(r.reason, pattern);
    }
    assert.equal(judgeSpool().ok, false, '인자 없이 불러도 통과가 아니다');
  });

  test('임시 파일·다른 기사만 있으면 실패 · 하위 폴더의 정식 파일 1건이면 ok(매칭 목록을 돌려준다)', () => {
    const other = judgeSpool({ spoolDir: 'D:\\x', articleId: 'AKR1', files });
    assert.equal(other.ok, false, '다른 기사의 파일만 있으면 실패다');
    assert.match(other.reason, /0건/);
    const tmpOnly = judgeSpool({ spoolDir: 'D:\\x', articleId: ID, files: [files[1]] });
    assert.equal(tmpOnly.ok, false, '.tmp 만 있으면 배부가 끝난 것이 아니다');
    assert.deepEqual(judgeSpool({ spoolDir: 'D:\\x', articleId: ID, files }), { ok: true, matched: [files[0]] });
  });
});

describe('integrationMode — listFilesRecursive', () => {
  test('하위 폴더까지 상대 경로(슬래시 정규화·정렬)로 돌려주고, 루트가 없으면 0건이 아니라 null 이다', () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'integ-mode-judgment-'));
    try {
      fs.mkdirSync(nodePath.join(root, 'b', 'deep'), { recursive: true });
      fs.writeFileSync(nodePath.join(root, 'b', 'deep', 'z.json'), '');
      fs.writeFileSync(nodePath.join(root, 'a.json'), '');
      fs.mkdirSync(nodePath.join(root, 'empty-dir'));
      assert.deepEqual(listFilesRecursive(root), ['a.json', 'b/deep/z.json'], '빈 폴더는 파일이 아니다');
      assert.equal(listFilesRecursive(nodePath.join(root, 'missing')), null, '읽지 못한 것과 0건을 구분한다');
      assert.equal(listFilesRecursive(''), null);
      assert.equal(listFilesRecursive(undefined), null);
    }
    finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('integrationMode — 드라이버 결선(판정부를 실제로 쓰는가)', () => {
  test('verify-integration.mjs 는 판정 4종을 이 모듈에서 import 한다(인라인 재구현 금지)', () => {
    const source = fs.readFileSync(nodePath.join(REPO_ROOT, 'scripts', 'verify-integration.mjs'), 'utf8');
    const importLine = /import\s*\{([^}]*)\}\s*from\s*'\.\/lib\/integrationMode\.mjs'/.exec(source);
    assert.ok(importLine, 'verify-integration.mjs 가 integrationMode.mjs 를 import 하지 않는다');
    const imported = importLine[1].split(',').map((s) => s.trim()).filter(Boolean).sort();
    assert.deepEqual(imported, ['judgeSpool', 'listFilesRecursive', 'parseServerMode', 'springServerEnv']);
  });
});
