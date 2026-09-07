// scripts/verify-integration.mjs 의 순수 판정부 (phase 76 step4 — --server exe|spring 모드 분기).
// fs·process 전역에 기대지 않는다(listFilesRecursive 만 fs 를 쓰되 인자로 받은 루트 아래만 읽는다).
// 자기검사: node --test scripts/lib/integrationMode.test.mjs
//
// 왜 분리했나: verify-integration.mjs 는 export 0 · import 시 즉시 실행이라 그 안의 함수는 단위 테스트가
// 불가능하다(decisions (9) — 739줄 복제 금지). 모드 분기의 **순수한 부분**(인자 허용값 · env 허용목록 조립 ·
// 스풀 파일명 판정)만 여기 두고 본체는 서버 기동부 분기 + 배부 관측 1단계만 바꾼다.

import fs from 'node:fs';
import nodePath from 'node:path';

// --- --server 허용값 ---
export const SERVER_MODES = Object.freeze(['exe', 'spring']);

export function parseServerMode(value) {
  if (typeof value !== 'string' || !SERVER_MODES.includes(value)) {
    return { ok: false, message: `--server 값이 유효하지 않다(exe|spring): ${JSON.stringify(value)}` };
  }
  return { ok: true, mode: value };
}

// --- spring 자식 env — 허용목록 조립(spring-contract.mjs javaChildEnv · spa-parity.mjs childEnv 동형) ---
// win32 의 SystemRoot/windir·TEMP 는 JVM·내장 Tomcat 이 실제로 요구한다. PATH 는 win32 에서 넘기지 않는다
// (java -jar 는 자기 홈으로 뜬다 — 시스템 java 폴백 금지 규율의 env 판).
export function osEnvAllowlist(platform) {
  return platform === 'win32'
    ? ['SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
    : ['PATH', 'HOME', 'LANG', 'TZ'];
}

// 이 5키 **전부** 명시 주입이다. APP_ENV 는 어떤 경로로도 실리지 않는다(허용목록에 없다 — production 이면
// 쿠키 Secure 가 켜져 평문 HTTP 로그인이 조용히 죽는다). DB 축은 sqlite 기본(DB_KIND 미주입 = DATA_DIR/news.db).
export const SPRING_ENV_KEYS = Object.freeze(['DATA_DIR', 'PORT', 'HOST', 'SPA_DIR', 'DIST_SPOOL_DIR']);

export function springServerEnv({ parentEnv = {}, platform, dataDir, port, host, spaDir, spoolDir } = {}) {
  const given = { DATA_DIR: dataDir, PORT: port, HOST: host, SPA_DIR: spaDir, DIST_SPOOL_DIR: spoolDir };
  for (const key of SPRING_ENV_KEYS) {
    const v = given[key];
    if (v === undefined || v === null || String(v).trim() === '') {
      throw new Error(`spring 자식 env 조립 거부: ${key} 미주입 — 조용한 기본값 폴백은 없다(verify-integration --server spring).`);
    }
  }
  const portNum = Number(port);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new Error(`spring 자식 env 조립 거부: PORT 가 유효하지 않다(1~65535 정수): ${JSON.stringify(port)}`);
  }
  const env = {};
  for (const key of osEnvAllowlist(platform)) if (parentEnv[key] !== undefined) env[key] = parentEnv[key];
  for (const key of SPRING_ENV_KEYS) env[key] = String(given[key]);
  return env;
}

// --- 배부 스풀 파일명 판정 ---
// <articleId>_<compactStamp>.json — Node spoolWriter.js:69 `${articleId}_${compactStamp(stamp)}.json` ·
// Spring SpoolWriter.java:148 동형. compactStamp = ISO 8601(소수 3자리 고정 · Z)에서 [-:.] 제거 →
// YYYYMMDDTHHMMSSmmmZ (8자리 T 9자리 Z). 임시 파일(.<name>.tmp)·다른 기사·소수부 없는 stamp 는 거부.
const STAMP = '\\d{8}T\\d{9}Z';
const ARTICLE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function isSpoolFileName(name, articleId) {
  if (typeof name !== 'string' || typeof articleId !== 'string' || !ARTICLE_ID.test(articleId)) return false;
  const escaped = articleId.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  return new RegExp(`^${escaped}_${STAMP}\\.json$`).test(name);
}

// 루트 아래 파일 전부를 상대 경로(항상 '/' 구분)로 정렬해 돌려준다. 루트가 없으면 null(읽지 못했다 — 0건과 구분).
export function listFilesRecursive(rootDir) {
  if (typeof rootDir !== 'string' || rootDir === '' || !fs.existsSync(rootDir)) return null;
  const out = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = nodePath.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      if (fs.statSync(abs).isDirectory()) walk(abs, relPath);
      else out.push(relPath);
    }
  };
  walk(rootDir, '');
  return out;
}

// 배부 관측 1단계 판정 — "배부가 실제로 일어났다"만 본다(바이트 대조는 step5). 전제가 없으면 **명시 실패**다.
export function judgeSpool({ spoolDir, articleId, files } = {}) {
  if (typeof spoolDir !== 'string' || spoolDir.trim() === '') {
    return { ok: false, reason: 'DIST_SPOOL_DIR 미주입 — 배부 관측 불가(조용한 skip 금지: 서버 기동 env 를 확인하라)' };
  }
  if (typeof articleId !== 'string' || articleId === '') {
    return { ok: false, reason: 'articleId 없음 — 기사 작성 단계가 실패했거나 응답에 articleId 가 없다' };
  }
  if (!Array.isArray(files)) {
    return { ok: false, reason: `스풀 디렉토리를 읽지 못했다: ${spoolDir}` };
  }
  const matched = files.filter((f) => isSpoolFileName(f.split('/').pop(), articleId));
  if (matched.length === 0) {
    return { ok: false, reason: `스풀 파일 0건(<articleId>_<stamp>.json 형태 · 디렉토리 내 파일 ${files.length}건) — 활성 DistributionTarget 이 없거나 송고 훅이 결선되지 않았다` };
  }
  return { ok: true, matched };
}
