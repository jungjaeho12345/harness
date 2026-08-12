// 클라이언트 설정 파일 입출력 정책 (phase 62 step0) — Electron·전역·파일시스템 비의존 순수 모듈.
// 설정 shape은 화이트리스트 { schemaVersion, serverUrl, bounds:{width,height,x,y,maximized} } 하나뿐이다.
// CRITICAL(보안): 세션ID·비밀번호·쿠키·토큰을 설정에 담는 필드를 만들지 않는다 — 파일은 신뢰 경계
// 밖이므로 parseConfig는 화이트리스트 밖 키를 전부 버린다(파일에 있어도 결과에 없다).
// parseConfig는 어떤 입력에도 throw하지 않는다 — 설정이 깨졌다고 앱이 못 뜨면 사용자는 복구 수단이
// 없다(주소 재입력 화면으로 가야 한다). 파일 접근은 전부 주입 의존성(readFile/mkdir/writeFile/rename)이다.

import path from 'node:path';
import { normalizeServerUrl } from './serverUrl.js';

export const CONFIG_FILENAME = 'config.json';
export const CONFIG_SCHEMA_VERSION = 1;

const MIN_WIDTH = 800;
const MIN_HEIGHT = 600;

export function configPath(userDataDir) {
  return path.join(userDataDir, CONFIG_FILENAME);
}

function defaultConfig() {
  return { schemaVersion: CONFIG_SCHEMA_VERSION, serverUrl: null, bounds: null };
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// bounds 구조 검증(화이트리스트 5키·정수·최소 크기) — 화면 배치(workAreas) 검증은 sanitizeBounds가
// 별도로 한다(파싱 시점에는 모니터 구성을 모른다).
function sanitizeBoundsShape(bounds) {
  if (!isPlainObject(bounds)) return null;
  const { width, height, x, y, maximized } = bounds;
  for (const n of [width, height, x, y]) {
    if (!Number.isInteger(n)) return null;
  }
  if (width < MIN_WIDTH || height < MIN_HEIGHT) return null;
  return { width, height, x, y, maximized: maximized === true };
}

export function parseConfig(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return defaultConfig();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultConfig();
  }
  if (!isPlainObject(parsed)) return defaultConfig();
  const cfg = defaultConfig();
  // serverUrl은 저장 전에도 정규화를 통과한 값만 쓰지만, 읽을 때도 재검증한다(손으로 편집된 파일 방어).
  if (typeof parsed.serverUrl === 'string') {
    const norm = normalizeServerUrl(parsed.serverUrl);
    if (norm.ok) cfg.serverUrl = norm.origin;
  }
  cfg.bounds = sanitizeBoundsShape(parsed.bounds);
  return cfg;
}

// 직렬화도 화이트리스트를 지난다 — 호출부가 실수로 여분 키를 넘겨도 파일에 남지 않는다.
export function serializeConfig(config) {
  const src = isPlainObject(config) ? config : {};
  const out = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    serverUrl: typeof src.serverUrl === 'string' ? src.serverUrl : null,
    bounds: sanitizeBoundsShape(src.bounds),
  };
  return `${JSON.stringify(out, null, 2)}\n`;
}

// 저장된 창 배치가 현재 모니터 구성에서 유효한지 판정한다. workAreas는 화면 작업영역 사각형 배열
// ({x,y,width,height})이며, 하나와도 겹치지 않으면(모니터를 뗀 경우) null → 호출부가 기본 배치를 쓴다.
export function sanitizeBounds(bounds, workAreas) {
  const shaped = sanitizeBoundsShape(bounds);
  if (!shaped) return null;
  if (!Array.isArray(workAreas)) return null;
  const visible = workAreas.some((wa) => (
    isPlainObject(wa)
    && shaped.x < wa.x + wa.width && shaped.x + shaped.width > wa.x
    && shaped.y < wa.y + wa.height && shaped.y + shaped.height > wa.y
  ));
  return visible ? shaped : null;
}

// 읽기 실패(ENOENT·권한·깨진 파일)는 전부 기본값으로 수렴한다 — throw 금지.
export async function readConfigFile(filePath, { readFile }) {
  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return defaultConfig();
  }
  return parseConfig(raw);
}

// ready 전 동기 1회 읽기 (phase 63 step0) — appendSwitch가 app ready 전이어야 하므로 부팅 판정은
// 이 함수로 읽고, whenReady는 같은 결과를 재사용한다(같은 부팅에서 두 번 읽어 갈라지는 경로 금지).
// 파싱은 parseConfig 공유 — 실패는 전부 기본값으로 수렴한다(throw 금지).
export function readConfigFileSync(filePath, { readFileSync }) {
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return defaultConfig();
  }
  return parseConfig(raw);
}

// 같은 디렉토리의 임시 파일에 쓴 뒤 rename한다 — 중간에 죽어도 반쪽 JSON이 남지 않는다(원자적).
// rename의 원자성은 같은 볼륨(같은 디렉토리)일 때만 성립하므로 tmp는 반드시 대상 옆에 만든다.
export async function writeConfigFile(filePath, config, { mkdir, writeFile, rename }) {
  const dir = path.dirname(filePath);
  const tmpFile = path.join(dir, `${CONFIG_FILENAME}.tmp`);
  await mkdir(dir, { recursive: true });
  await writeFile(tmpFile, serializeConfig(config));
  await rename(tmpFile, filePath);
}
