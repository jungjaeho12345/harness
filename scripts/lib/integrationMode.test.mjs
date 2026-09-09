// scripts/lib/integrationMode.mjs 의 순수 판정부 자기검사 (phase 76 step4).
//
// 왜 여기에 있고 npm test 가 돌지 않는가: package.json·test/** 은 이 step 의 무접촉 목록이고 `npm test` 는
// "test/**/*.test.js" 만 훑는다(spaParity.self-test.mjs·mysqlHarness.test.mjs 선례).
// 실행: node --test scripts/lib/integrationMode.test.mjs
//
// 무엇을 잠그는가(각각 step4 변이의 방어선이다):
//   · --server 허용값이 정확히 exe|spring 이고 그 밖은 판정 실패다(P4 — 조용한 기본값 폴백 금지)
//   · spring 자식 env 는 OS 허용목록 + 5키뿐이다 — 부모의 APP_ENV·NODE_ENV·COLLECTION_TOKEN·stale SPA_DIR/DIST_SPOOL_DIR·
//     NEWS_DB_*·JAVA_HOME 이 새지 않는다(P5) · 5키 중 하나라도 비면 조립 자체를 거부한다(P1·P2)
//   · 스풀 파일명 판정은 <articleId>_<YYYYMMDDTHHMMSSmmmZ>.json 정확 일치다(임시 파일·다른 기사·소수부 없는 stamp 거부)
//   · 배부 관측 판정은 DIST_SPOOL_DIR 미주입·0건을 **명시 실패**로 돌린다(조용한 skip 금지)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';

import {
  SERVER_MODES, SPRING_ENV_KEYS, isSpoolFileName, judgeSpool, listFilesRecursive, osEnvAllowlist, parseServerMode,
  springServerEnv,
} from './integrationMode.mjs';

// --- --server 허용값 ---

test('--server 허용값은 정확히 exe·spring 두 개다', () => {
  assert.deepEqual([...SERVER_MODES], ['exe', 'spring']);
});

test('parseServerMode 는 허용값이면 ok, 그 밖(대소문자 포함)·비문자열은 실패 메시지를 돌려준다', () => {
  assert.deepEqual(parseServerMode('exe'), { ok: true, mode: 'exe' });
  assert.deepEqual(parseServerMode('spring'), { ok: true, mode: 'spring' });
  for (const bad of ['foo', 'EXE', 'Spring', '', ' spring', undefined, null, 1]) {
    const r = parseServerMode(bad);
    assert.equal(r.ok, false, `허용값 밖인데 ok: ${JSON.stringify(bad)}`);
    assert.match(r.message, /exe\|spring/, '메시지가 허용값을 지목해야 한다');
  }
});

// --- spring 자식 env 조립 (허용목록) ---

const WIN_PARENT = {
  SystemRoot: 'C:\\Windows', windir: 'C:\\Windows', TEMP: 'C:\\t', PATH: 'C:\\bin', PATHEXT: '.EXE',
  APP_ENV: 'production', NODE_ENV: 'production', COLLECTION_TOKEN: 'leak', SPA_DIR: 'C:\\stale-spa',
  DIST_SPOOL_DIR: 'C:\\stale-spool', DATA_DIR: 'C:\\stale-data', PORT: '1', HOST: '0.0.0.0',
  NEWS_DB_URL: 'jdbc:mysql://x/y', NEWS_DB_PASSWORD: 'leak', JAVA_HOME: 'C:\\jdk', SPRING_JAVA_HOME: 'C:\\jdk',
  NODE_OPTIONS: '--require x', ELECTRON_RUN_AS_NODE: '1',
};
const GIVEN = { dataDir: 'D:\\tmp\\data', port: 23456, host: '127.0.0.1', spaDir: 'D:\\repo\\web\\dist', spoolDir: 'D:\\tmp\\spool' };

test('win32 허용목록에는 PATH 가 없고 posix 허용목록에는 있다(spa-parity·spring-contract 동형)', () => {
  assert.deepEqual(osEnvAllowlist('win32'), [
    'SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  ]);
  assert.deepEqual(osEnvAllowlist('linux'), ['PATH', 'HOME', 'LANG', 'TZ']);
});

test('spring 자식 env = 허용목록 통과분 + 5키뿐 — 부모의 APP_ENV·NODE_ENV·토큰·stale 경로·NEWS_DB_*·JAVA_HOME 이 새지 않는다', () => {
  const env = springServerEnv({ parentEnv: WIN_PARENT, platform: 'win32', ...GIVEN });
  assert.deepEqual(Object.keys(env).sort(), ['DATA_DIR', 'DIST_SPOOL_DIR', 'HOST', 'PATHEXT', 'PORT', 'SPA_DIR', 'SystemRoot', 'TEMP', 'windir']);
  assert.equal(env.DATA_DIR, GIVEN.dataDir);
  assert.equal(env.PORT, '23456', 'PORT 는 문자열로 실린다');
  assert.equal(env.HOST, '127.0.0.1');
  assert.equal(env.SPA_DIR, GIVEN.spaDir, 'stale SPA_DIR 이 아니라 준 값');
  assert.equal(env.DIST_SPOOL_DIR, GIVEN.spoolDir, 'stale DIST_SPOOL_DIR 이 아니라 준 값');
  for (const leaked of ['APP_ENV', 'NODE_ENV', 'COLLECTION_TOKEN', 'NEWS_DB_URL', 'NEWS_DB_PASSWORD', 'JAVA_HOME', 'SPRING_JAVA_HOME', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PATH']) {
    assert.equal(leaked in env, false, `${leaked} 가 새어 들어왔다`);
  }
  assert.deepEqual([...SPRING_ENV_KEYS], ['DATA_DIR', 'PORT', 'HOST', 'SPA_DIR', 'DIST_SPOOL_DIR']);
});

test('5키 중 하나라도 비면 조립을 거부한다 — 키 이름을 지목한다(조용한 기본값 폴백 금지)', () => {
  for (const [key, patch] of [
    ['DATA_DIR', { dataDir: '' }], ['PORT', { port: undefined }], ['HOST', { host: '  ' }],
    ['SPA_DIR', { spaDir: null }], ['DIST_SPOOL_DIR', { spoolDir: undefined }],
  ]) {
    assert.throws(
      () => springServerEnv({ parentEnv: WIN_PARENT, platform: 'win32', ...GIVEN, ...patch }),
      (err) => err instanceof Error && err.message.includes(key),
      `${key} 누락이 거부되지 않았다`,
    );
  }
  assert.throws(() => springServerEnv({ parentEnv: {}, platform: 'win32', ...GIVEN, port: 70000 }), /PORT/);
  assert.throws(() => springServerEnv({ parentEnv: {}, platform: 'win32', ...GIVEN, port: 'abc' }), /PORT/);
});

test('부모 env 가 비어 있어도 5키는 실린다(허용목록은 있으면 통과, 없으면 생략)', () => {
  const env = springServerEnv({ parentEnv: {}, platform: 'win32', ...GIVEN });
  assert.deepEqual(Object.keys(env).sort(), ['DATA_DIR', 'DIST_SPOOL_DIR', 'HOST', 'PORT', 'SPA_DIR']);
});

// --- 스풀 파일명 판정 (<articleId>_<compactStamp>.json — spoolWriter.js:69 · SpoolWriter.java:148 동형) ---

const ID = 'AKR20260907123456789';

test('스풀 파일명은 <articleId>_<YYYYMMDDTHHMMSSmmmZ>.json 정확 일치만 통과한다', () => {
  assert.equal(isSpoolFileName(`${ID}_20260907T010203456Z.json`, ID), true);
  assert.equal(isSpoolFileName(`${ID}_20260907T010203Z.json`, ID), false, '소수부 없는 stamp(Instant.toString 형태)는 거부');
  assert.equal(isSpoolFileName(`.${ID}_20260907T010203456Z.json.tmp`, ID), false, '원자적 게시 전 임시 파일은 거부');
  assert.equal(isSpoolFileName(`${ID}_20260907T010203456Z.txt`, ID), false);
  assert.equal(isSpoolFileName(`${ID}1_20260907T010203456Z.json`, ID), false, '접두사만 같은 다른 기사는 거부');
  assert.equal(isSpoolFileName(`OTHER_20260907T010203456Z.json`, ID), false);
  assert.equal(isSpoolFileName(`${ID}_2026-09-07T01:02:03.456Z.json`, ID), false, 'compact 가 아닌 ISO 원문은 거부');
  assert.equal(isSpoolFileName(undefined, ID), false);
  assert.equal(isSpoolFileName(`${ID}_20260907T010203456Z.json`, ''), false, 'articleId 가 없으면 아무것도 통과하지 않는다');
});

test('judgeSpool — DIST_SPOOL_DIR 미주입·디렉토리 읽기 실패·0건은 전부 명시 실패이고, 하위 폴더의 1건이면 ok', () => {
  const files = [`press-x/${ID}_20260907T010203456Z.json`, `press-x/.${ID}_20260907T010203457Z.json.tmp`, 'nonpress-y/OTHER_20260907T010203456Z.json'];
  const none = judgeSpool({ spoolDir: '', articleId: ID, files });
  assert.equal(none.ok, false);
  assert.match(none.reason, /DIST_SPOOL_DIR/);
  const unreadable = judgeSpool({ spoolDir: 'D:\\x', articleId: ID, files: null });
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.reason, /읽지 못했다/);
  const empty = judgeSpool({ spoolDir: 'D:\\x', articleId: ID, files: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /0건/);
  const noId = judgeSpool({ spoolDir: 'D:\\x', articleId: undefined, files });
  assert.equal(noId.ok, false);
  assert.match(noId.reason, /articleId/);
  const other = judgeSpool({ spoolDir: 'D:\\x', articleId: 'AKR1', files });
  assert.equal(other.ok, false, '다른 기사의 파일만 있으면 실패');
  const hit = judgeSpool({ spoolDir: 'D:\\x', articleId: ID, files });
  assert.deepEqual(hit, { ok: true, matched: [`press-x/${ID}_20260907T010203456Z.json`] });
});

test('listFilesRecursive — 하위 폴더까지 상대 경로(슬래시)로 정렬해 돌려주고, 루트가 없으면 null', () => {
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'integ-mode-test-'));
  try {
    fs.mkdirSync(nodePath.join(root, 'b', 'deep'), { recursive: true });
    fs.writeFileSync(nodePath.join(root, 'b', 'deep', 'z.json'), '');
    fs.writeFileSync(nodePath.join(root, 'a.json'), '');
    assert.deepEqual(listFilesRecursive(root), ['a.json', 'b/deep/z.json']);
    assert.equal(listFilesRecursive(nodePath.join(root, 'missing')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
