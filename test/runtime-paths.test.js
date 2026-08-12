// 런타임 경로 단일 출처 resolveRuntimePaths + resolveSpaDir 신계약 (phase 61 step0).
// SEA/CJS 번들에서는 모듈 위치(import.meta.url)가 존재하지 않는다 — 경로 계산은 주입 인자만으로
// 동작해야 하며(packaged/execDir/moduleDir/cwd), 어떤 미주입 조합에서도 throw 없이 수렴해야 한다.
// bootstrap()은 여기서 실행하지 않는다(listen·DB 생성 부수효과) — export 존재만 확인한다.
// CRITICAL(무회귀): packaged:false 기본값은 오늘과 같은 파일을 가리켜야 한다
//   (<cwd>/news.db, <cwd>/uploads, <서버 모듈>/../web/dist) — 기존 스위트·T4 E2E가 이 위에 서 있다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveRuntimePaths, resolveSpaDir, bootstrap, createApp } from '../server/index.js';

const CWD = process.cwd();
const MODULE_DIR = path.join(CWD, 'server'); // 실존 여부 무관 — 함수는 파일시스템을 읽지 않는다.
const EXEC_DIR = path.join('C:', 'deploy', 'app'); // 임의 문자열 — 순수 계산만 검증한다.

// --- A. 비패키지(dev) 기본값 — 오늘과 같은 파일 ---

test('R1: 비패키지 기본 — dataDir=cwd, dbFile=<cwd>/news.db, uploadDir=<cwd>/uploads, spaDir=<moduleDir>/../web/dist', () => {
  const p = resolveRuntimePaths({ env: {}, moduleDir: MODULE_DIR });
  assert.equal(p.dataDir, CWD);
  assert.equal(p.dbFile, path.join(CWD, 'news.db'));
  assert.equal(p.uploadDir, path.join(CWD, 'uploads'));
  assert.equal(p.spaDir, path.join(MODULE_DIR, '..', 'web', 'dist'));
});

test('R2: cwd 주입 seam — 비패키지 기준 디렉토리는 인자 cwd를 따른다', () => {
  const other = path.join(CWD, 'elsewhere');
  const p = resolveRuntimePaths({ env: {}, moduleDir: MODULE_DIR, cwd: other });
  assert.equal(p.dataDir, other);
  assert.equal(p.dbFile, path.join(other, 'news.db'));
  assert.equal(p.uploadDir, path.join(other, 'uploads'));
});

test('R3: 비패키지 + moduleDir 미주입 → throw 없이 spaDir=undefined(SPA 비활성), 데이터 경로는 cwd 기준 그대로', () => {
  let p;
  assert.doesNotThrow(() => { p = resolveRuntimePaths({ env: {} }); });
  assert.equal(p.spaDir, undefined);
  assert.equal(p.dataDir, CWD);
  assert.equal(p.dbFile, path.join(CWD, 'news.db'));
});

// --- B. 패키지(SEA/exe) 기본값 — exe 옆 data/·web/, cwd·모듈 위치 비의존 ---

test('R4: 패키지 기본 — dataDir=<execDir>/data, dbFile/uploadDir는 그 아래, spaDir=<execDir>/web', () => {
  const p = resolveRuntimePaths({ env: {}, packaged: true, execDir: EXEC_DIR });
  assert.equal(p.dataDir, path.join(EXEC_DIR, 'data'));
  assert.equal(p.dbFile, path.join(EXEC_DIR, 'data', 'news.db'));
  assert.equal(p.uploadDir, path.join(EXEC_DIR, 'data', 'uploads'));
  assert.equal(p.spaDir, path.join(EXEC_DIR, 'web'));
});

test('R5: 패키지 + moduleDir 미주입이어도 throw 없이 R4와 같은 값(SEA에는 모듈 위치가 없다는 사실의 모사)', () => {
  let p;
  assert.doesNotThrow(() => {
    p = resolveRuntimePaths({ env: {}, packaged: true, execDir: EXEC_DIR, moduleDir: undefined });
  });
  assert.equal(p.dataDir, path.join(EXEC_DIR, 'data'));
  assert.equal(p.spaDir, path.join(EXEC_DIR, 'web'));
});

test('R6: 패키지 + execDir 미주입/빈 문자열 → throw 없이 dataDir=cwd 폴백, spaDir=undefined(부팅을 죽이지 않는 계약)', () => {
  for (const execDir of [undefined, '']) {
    let p;
    assert.doesNotThrow(() => { p = resolveRuntimePaths({ env: {}, packaged: true, execDir }); }, String(execDir));
    assert.equal(p.dataDir, CWD, String(execDir));
    assert.equal(p.dbFile, path.join(CWD, 'news.db'), String(execDir));
    assert.equal(p.spaDir, undefined, String(execDir));
  }
});

// --- C. DATA_DIR 오버라이드 (신설 env — 두 배치 모두에서 이긴다) ---

test('R7: DATA_DIR 절대 경로 — 비패키지·패키지 모두 그 값이 이긴다', () => {
  const dir = path.join(CWD, 'custom-data');
  for (const base of [{ moduleDir: MODULE_DIR }, { packaged: true, execDir: EXEC_DIR }]) {
    const p = resolveRuntimePaths({ env: { DATA_DIR: dir }, ...base });
    assert.equal(p.dataDir, path.resolve(dir));
    assert.equal(p.dbFile, path.join(path.resolve(dir), 'news.db'));
    assert.equal(p.uploadDir, path.join(path.resolve(dir), 'uploads'));
  }
});

test('R8: DATA_DIR 상대 경로는 절대화한다', () => {
  const p = resolveRuntimePaths({ env: { DATA_DIR: 'rel/data' }, moduleDir: MODULE_DIR });
  assert.equal(p.dataDir, path.resolve('rel/data'));
});

test('R9: DATA_DIR 공백/빈 값은 무시하고 기본값으로 수렴한다(resolveHost의 빈 값 정책과 동형)', () => {
  for (const v of ['', '   ']) {
    const nonPkg = resolveRuntimePaths({ env: { DATA_DIR: v }, moduleDir: MODULE_DIR });
    assert.equal(nonPkg.dataDir, CWD, JSON.stringify(v));
    const pkg = resolveRuntimePaths({ env: { DATA_DIR: v }, packaged: true, execDir: EXEC_DIR });
    assert.equal(pkg.dataDir, path.join(EXEC_DIR, 'data'), JSON.stringify(v));
  }
});

test('R10: DATA_DIR 앞뒤 공백은 트림 후 해석한다', () => {
  const dir = path.join(CWD, 'trimmed-data');
  const p = resolveRuntimePaths({ env: { DATA_DIR: `  ${dir}  ` }, moduleDir: MODULE_DIR });
  assert.equal(p.dataDir, path.resolve(dir));
});

// --- D. SPA_DIR 오버라이드 — 두 배치 모두에서 이기고, 빈 값은 off 스위치 ---

test('R11: SPA_DIR 설정 시 두 배치 모두 그 값(절대화)이 이긴다', () => {
  const dir = path.join(CWD, 'my-spa');
  for (const base of [{ moduleDir: MODULE_DIR }, { packaged: true, execDir: EXEC_DIR }]) {
    const p = resolveRuntimePaths({ env: { SPA_DIR: dir }, ...base });
    assert.equal(p.spaDir, path.resolve(dir));
  }
});

test('R12: SPA_DIR 빈 값/공백 → spaDir=undefined(off 스위치 — 두 배치 동일)', () => {
  for (const v of ['', '   ']) {
    for (const base of [{ moduleDir: MODULE_DIR }, { packaged: true, execDir: EXEC_DIR }]) {
      const p = resolveRuntimePaths({ env: { SPA_DIR: v }, ...base });
      assert.equal(p.spaDir, undefined, JSON.stringify(v));
    }
  }
});

// --- E. 반환 계약 — 4키 고정, 스풀 경로 미포함(ADR-008: 미설정 = 비활성) ---

test('R13: 반환 객체는 dataDir/dbFile/uploadDir/spaDir 4키뿐이다(DIST_SPOOL_DIR·RCV_SPOOL_DIR 기본값 금지)', () => {
  const p = resolveRuntimePaths({ env: {}, packaged: true, execDir: EXEC_DIR });
  assert.deepEqual(Object.keys(p).sort(), ['dataDir', 'dbFile', 'spaDir', 'uploadDir']);
});

// --- F. resolveSpaDir 신계약 단독 (env 오버라이드만 해석 — 기본 경로 계산은 호출부 책임) ---

test('R14: resolveSpaDir — SPA_DIR 미정의면 defaultDir를 그대로 돌려준다', () => {
  const dir = path.join(CWD, 'given-default');
  assert.equal(resolveSpaDir({}, dir), dir);
});

test('R15: resolveSpaDir — defaultDir 미주입 + SPA_DIR 미정의 → undefined(비활성), throw 없음', () => {
  assert.doesNotThrow(() => resolveSpaDir({}));
  assert.equal(resolveSpaDir({}), undefined);
});

test('R16: resolveSpaDir — SPA_DIR가 defaultDir를 이기고 상대 경로는 절대화한다', () => {
  assert.equal(resolveSpaDir({ SPA_DIR: 'rel/dist' }, path.join(CWD, 'ignored')), path.resolve('rel/dist'));
});

test('R17: resolveSpaDir — 빈 값/공백은 off 스위치(undefined) — defaultDir가 있어도 무시', () => {
  for (const v of ['', '   ']) {
    assert.equal(resolveSpaDir({ SPA_DIR: v }, path.join(CWD, 'ignored')), undefined, JSON.stringify(v));
  }
});

// --- G. export 표면 — SEA 엔트리(step1)가 의존하는 계약 ---

test('R18: bootstrap·createApp이 함수로 export된다(호출은 하지 않는다 — listen 부수효과)', () => {
  assert.equal(typeof bootstrap, 'function');
  assert.equal(typeof createApp, 'function');
});
