// 계약 스위트 Spring 대상 하네스 (phase 68 step1) — "Spring 서버를 어떻게 띄우는가"를 아는 코드는
// 이 파일뿐이다(decisions (6) — scripts/contract-run.mjs가 Node 서버에 대해 갖는 소유 경계와 동형).
// 프로파일마다 임시 DATA_DIR 시드 → 빈 포트 프로브 → java -jar 기동 → /api/health 왕복 →
// targets.json·creds.json(0600) → contract-run.mjs를 외부 대상 모드로 실행 → 종료·정리한다.
// 사용: node scripts/spring-contract.mjs [--profile <name>]... [--files <path>[,<path>]...]
//                                       [--jar <path>] [--java-home <path>] [--out-dir <dir>]
//                                       [--boot-check] [--parity] [--dual-run] [--keep] [--timeout <ms>]
//
// CRITICAL(DB 비파괴): 리포 news.db·uploads/에 절대 바인딩하지 않는다 — 프로파일(패스)마다 임시 DATA_DIR을
//   새로 만들고 java 자식의 cwd도 그 임시 루트다(상대 경로 쓰기가 리포에 닿는 경로 원천 차단).
//   실행 전후 리포 news.db·uploads/ 스냅샷을 떠 무변을 단언한다(러너도 하지만 여기서도 한다 —
//   잘못 설정된 Spring이 리포 DB를 여는 유일한 위험 지점이 이 스크립트다).
// CRITICAL(--dual-run은 이 하네스가 소유한다 — 러너에 전달하지 않는다, decisions (6-a)):
//   ① 러너 118행이 --dual-run과 --out의 병용을 거부하는데 여기서는 프로파일별 리포트를 모아야 해 --out이 필수다.
//   ② 가드를 피해도 러너의 runDualRun은 **같은 base URL로 2패스**를 도는데, 외부 대상은 서버가 계속 떠 있어
//      로그인 IP 레이트리밋 카운터가 누적된다(15분/10회) — default는 12회 > 10, auth-negative는 패스 1이
//      정확히 11회를 소진하므로 패스 2가 첫 케이스부터 429다. 둘 다 확정 red다.
//   → 자기 결정성은 **새 DATA_DIR + 새 프로세스 2회**로만 판정한다. "같은 인스턴스에 2회"는 상태를 갖는
//      대상(레이트리밋·계정 잠금·세션 스토어)에서 성립하지 않는다.
// CRITICAL(결정성): java 자식 env는 허용 목록으로 명시 조립한다 — 부모 env를 통째로 넘기면 .env 잔재·
//   외부 키·NODE_OPTIONS가 대상 서버 동작을 바꾼다. 러너 자식 env에서도 CONTRACT_* 잔재를 지운다
//   (스테일 CONTRACT_SESSIONS가 남아 있으면 세션 미준비 프로파일의 케이스가 죽은 토큰을 읽는다).
// 로그 규율: 비밀번호·세션 토큰·쿠키 값을 stdout/stderr/파일 어디에도 쓰지 않는다. 자식 env를 덤프하지 않는다.
// 비밀 파일 수명: creds.json·targets.json은 성패·--keep과 무관하게 finally에서 **항상** 삭제한다.
// 주의: scripts/**는 eslint ignore 대상이다 — 인자 가드(scripts/lib/cliArgs.mjs)가 유일한 정적 안전망이다.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import nodePath from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { createSchema } from '../src/db/schema.js';
import { seedUsers, SAMPLE_USERS } from '../src/db/seed.js';
import { flagValue } from './lib/cliArgs.mjs';
// 비교 규칙은 재구현하지 않는다 — CLI diff와 이 하네스의 판정이 갈라지면 패리티 판정이 두 벌이 된다.
import { compareReports, formatDiffLines } from './contract-diff.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = nodePath.resolve(nodePath.dirname(SCRIPT_PATH), '..');
const RUNNER = nodePath.join(REPO_ROOT, 'scripts', 'contract-run.mjs');
const SPRING_TARGET_DIR = nodePath.join(REPO_ROOT, 'server-spring', 'target');
const ROLES = ['R', 'D', 'Z'];
// 접속 주소는 **언제나 127.0.0.1**이다 — 바인드 주소는 프로파일의 host 축이 정한다(failclosed는 0.0.0.0으로
// 바인드하지만 접속은 여기로 한다. 러너 325행과 동형: 접속 주소가 갈리면 BASE_URL 기반 계약이 갈린다).
const CONNECT_HOST = '127.0.0.1';
const DEFAULT_BIND_HOST = '127.0.0.1';

// Spring 인스턴스 포트 [15000, 20000) — 러너 [45000,49152)·verify-integration 서버 [20000,35000)·
// CDP [35000,45000)와 서로소다(decisions (16)). --parity는 Node 서버를 동시에 띄우므로 겹치면 안 된다.
const PORT_BASE = 15000;
const PORT_SPAN = 5000;

const JDK_HINT = 'D:/agents/tools/jdk-21.0.12+8';
const BUILD_HINT = `cd server-spring && JAVA_HOME="${JDK_HINT}" ./mvnw -B -q package -DskipTests`;

// scope 표(phase 68 소유 — 후속 phase는 행만 추가한다). 파일 목록은 **알파벳 정렬 순서 그대로**여야
// 러너가 디렉토리 스캔으로 도는 순서와 같고, auth.contract.js의 공용 세션 복구 규약이 뒤 파일에 이어진다.
//
// 구성 축 host·spool·token(phase 71 step0) — 값은 scripts/contract-run.mjs의 PROFILES와 **반드시 일치**한다.
// 갈리면 두 대상이 서로 다른 서버 구성을 측정하게 되고(예: Node만 COLLECTION_TOKEN이 설정된 상태),
// 그 구성 차이가 "계약 차이"로 위장된다. 축의 의미:
//   host  = 바인드 주소(접속은 언제나 127.0.0.1). 비-loopback이면 수집이 fail-closed로 잠긴다.
//   spool = DIST_SPOOL_DIR(패스 임시 루트 아래 새 디렉토리)를 주는가.
//   token = COLLECTION_TOKEN(러너 소스에서 읽은 고정 테스트 토큰)을 주는가.
// SCOPE 이름이 러너 PROFILES에 있는지 · bootOnly가 아닌 행의 files가 비지 않았는지는 실행 초반에 검사한다.
const SCOPE = [
  {
    name: 'default',
    host: DEFAULT_BIND_HOST,
    spool: true,
    token: true,
    files: [
      // phase 69 step11 — 목록·검색·이력이 붙으면서 green이 됐다(읽기 5라우트 전수 관측).
      'contract/cases/default/articles-read.contract.js',
      // phase 69 step10 — 송고(action)가 붙으면서 green이 됐다(그 전에는 DPS 잠금 픽스처가 404였다).
      'contract/cases/default/articles-write.contract.js',
      'contract/cases/default/auth.contract.js',
      // phase 71 step5 — 수집 인제스트 2라우트가 붙으면서 green이 됐다(토큰 401 → 서비스 403/400/200).
      'contract/cases/default/collection.contract.js',
      'contract/cases/default/crosscutting.contract.js',
      // phase 70 step6 — 배부 대상 4라우트가 붙으면서 green이 됐다(Z 게이트·SAFE_FIELDS 7키·soft delete·검증 5토큰).
      'contract/cases/default/distribution-targets.contract.js',
      // phase 72 step9 — 배부 실행 3라우트가 붙으면서 green이 됐다(Z 게이트·6키 요약·body 미판독·실배부·멱등).
      'contract/cases/default/distribution-tick.contract.js',
      'contract/cases/default/health.contract.js',
      // phase 74 step5 — GET /api/logs/stream이 붙으면서 green이 됐다(Z 전용 게이트 · 접속 replay · live push · logs-digest 3관측 동반).
      'contract/cases/default/logs.contract.js',
      // phase 73 step9 — 미디어·업로드·사진·번역 5라우트가 붙으면서 green이 됐다(키 없는 서버의 데모 폴백·base64 JSON 업로드·사진 append-only·번역 200 graceful degrade).
      'contract/cases/default/media-upload.contract.js',
      // phase 70 step3 — 수집 수신 설정 3라우트가 붙으면서 green이 됐다(Z 게이트·SAFE_FIELDS 10키·유일 행 삭제).
      'contract/cases/default/receiver-config.contract.js',
      'contract/cases/default/session-guard.contract.js',
      // phase 74 step4 — GET /api/stream이 붙으면서 green이 됐다(무효화 신호 · 프레임 원문 바이트 · 쿠키 인증 · 동시 2연결 · 봉인).
      'contract/cases/default/sse-stream.contract.js',
      'contract/cases/default/users.contract.js',
    ],
    extraEnv: {},
  },
  {
    // phase 69 step11이 올린 4번째 프로파일. 러너 프리셋은 `spool:false, token:false`이고 **env를 주지
    // 않는 것**이 프로파일의 정의다(스풀·수집 토큰 미설정 → 배부 결선 자체가 없어 송고 훅이
    // 발화하지 않는다 = 전이 관측이 결정적이다). phase 72 step9가 배부를 구현한 뒤에도 **추가 env가
    // 필요 없다**: 두 서버 모두 스풀 루트가 없으면 배부가 전면 비활성이고(실행 계열 503), 그 상태를
    // distribution-disabled 케이스가 직접 관측한다(index.json decisions (2)·72 decisions (3)).
    // files는 **반드시 명시**한다 — 비우면 러너가 디렉토리를 스캔해 아직 구현하지 않은
    // 배부(distribution-disabled) 케이스까지 돌린다(설정 실수가 계약 실패로 위장된다).
    name: 'minimal',
    host: DEFAULT_BIND_HOST,
    spool: false,
    token: false,
    files: [
      // phase 71 step5 — 토큰 미설정 서버의 개방 계약(헤더를 아예 읽지 않는다)이 green이 됐다.
      'contract/cases/minimal/collection-open.contract.js',
      // phase 72 step9 — 스풀 미설정 서버의 배부 계약이 green이 됐다(실행 503 · 인가가 설정보다 먼저 · 조회 200).
      'contract/cases/minimal/distribution-disabled.contract.js',
      'contract/cases/minimal/transitions.contract.js',
    ],
    extraEnv: {},
  },
  {
    name: 'auth-negative',
    host: DEFAULT_BIND_HOST,
    spool: true,
    token: true,
    files: ['contract/cases/auth-negative/login-negative.contract.js'],
    extraEnv: {}, // 전용 인스턴스 = 잠금·레이트리밋 카운터 격리(구성은 default와 같다).
  },
  {
    // phase 71 step0이 올린 5번째 프로파일 — 수집 fail-closed 구성 축(비-loopback 바인딩 + 토큰 미설정).
    // step5에서 수집 2라우트가 붙어 케이스가 green이 됐고 그때 bootOnly 플래그를 제거했다(그전에는
    // 케이스 디렉토리 스캔이 확정 red라 기동 전용이었다). 이 프로파일의 케이스 파일은 **하나뿐**이다 —
    // 다른 도메인을 여기에 넣지 마라(비-loopback 바인딩은 환경(방화벽)에 영향을 받는다: 그 환경 문제로
    // 무관한 계약이 함께 무너지면 안 된다 — 케이스 파일 머리말과 같은 규율).
    name: 'failclosed',
    host: '0.0.0.0',
    spool: false,
    token: false,
    files: ['contract/cases/failclosed/collection-disabled.contract.js'],
    extraEnv: {},
  },
  {
    name: 'prod-cookie',
    host: DEFAULT_BIND_HOST,
    spool: false,
    token: false,
    files: ['contract/cases/prod-cookie/cookie-prod.contract.js'],
    extraEnv: { APP_ENV: 'production' }, // Node의 NODE_ENV는 Node 런타임 관용이라 Java에 재사용하지 않는다.
  },
];
const SCOPE_NAMES = SCOPE.map((p) => p.name);
// bootOnly 행은 --profile 미지정(다중 프로파일 실행)에서 제외된다 — 조용히 빠뜨리지 않고 skip을 한 줄 보고한다.
const BOOT_ONLY_NAMES = SCOPE.filter((p) => p.bootOnly).map((p) => p.name);
const MULTI_RUN_NAMES = SCOPE.filter((p) => !p.bootOnly).map((p) => p.name);

// bootOnly 안내 — 표에서 파생한다(플래그를 지우면 이 줄도 함께 사라진다. phase 71 step5에서 실제로
// 사라졌고, 새 구성 축을 케이스보다 먼저 세우는 후속 phase가 같은 방식으로 다시 쓴다).
const BOOT_ONLY_USAGE = BOOT_ONLY_NAMES.length === 0 ? '' : `
                     ${BOOT_ONLY_NAMES.join('|')}=bootOnly(기동 전용 — --profile <name> --boot-check로만 실행. 케이스는 아직 미편입).`;

const USAGE = `사용법: node scripts/spring-contract.mjs [--profile <name>]... [--files <path>[,<path>]...]
                                      [--jar <path>] [--java-home <path>] [--out-dir <dir>]
                                      [--boot-check] [--parity] [--dual-run] [--keep] [--timeout <ms>]
  --profile <name>   실행할 프로파일(반복 가능). 미지정=scope 표에서 bootOnly가 아닌 전부(${MULTI_RUN_NAMES.join('|')}).${BOOT_ONLY_USAGE}
  --files <p>[,<p>]  케이스 파일을 scope 표 대신 쓴다. **단일 프로파일 실행 전용**(케이스가 requireProfile로 죽는다).
  --jar <path>       Spring 실행 jar. 미지정=server-spring/target/*.jar 자동 탐색(자동 빌드는 하지 않는다).
  --java-home <path> JDK 홈. 미지정=SPRING_JAVA_HOME → JAVA_HOME 순으로 읽는다(시스템 java 폴백 금지).
  --out-dir <dir>    리포트 디렉토리. 미지정=OS 임시 디렉토리(mkdtemp). **리포 안에는 쓰지 않는다.**
  --boot-check       케이스 없이 기동→health→세션 준비까지만(러너에 그대로 전달).
  --parity           같은 파티션으로 Node 대상 리포트도 뽑아 프로파일 쌍마다 contract-diff로 비교한다.
  --dual-run         프로파일마다 **새 DATA_DIR + 새 프로세스로 2패스**를 돌려 A/B 리포트를 비교한다(자기 결정성).
  --keep             임시 디렉토리를 지우지 않는다(실패 시에는 항상 보존 — 비밀 파일은 그래도 지운다).
  --timeout <ms>     health 대기·러너 단계 한도(기본 45000, 1000 이상 정수).`;

function usageDie(msg) {
  process.stderr.write(`${msg}\n${USAGE}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const take = (i, flag) => {
    const v = flagValue(argv, i, flag);
    if (!v.ok) usageDie(v.message);
    return v.value;
  };
  const opts = {
    profiles: [], files: [], bootCheck: false, parity: false, dualRun: false, keep: false, timeout: 45000,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--profile') { opts.profiles.push(take(i, '--profile')); i += 1; }
    else if (a === '--files') { opts.files.push(...take(i, '--files').split(',').map((s) => s.trim()).filter(Boolean)); i += 1; }
    else if (a === '--jar') { opts.jar = take(i, '--jar'); i += 1; }
    else if (a === '--java-home') { opts.javaHome = take(i, '--java-home'); i += 1; }
    else if (a === '--out-dir') { opts.outDir = take(i, '--out-dir'); i += 1; }
    else if (a === '--boot-check') opts.bootCheck = true;
    else if (a === '--parity') opts.parity = true;
    else if (a === '--dual-run') opts.dualRun = true;
    else if (a === '--keep') opts.keep = true;
    else if (a === '--timeout') { opts.timeout = Number(take(i, '--timeout')); i += 1; }
    else usageDie(`알 수 없는 인자: ${a}`);
  }
  for (const p of opts.profiles) {
    if (!SCOPE_NAMES.includes(p)) usageDie(`--profile 값이 scope 표에 없다(${SCOPE_NAMES.join('|')}): ${p}`);
  }
  // bootOnly 프로파일 명시 실행은 --boot-check일 때만 허용한다. 케이스 목록이 비어 있어 러너가
  // contract/cases/<name>/를 디렉토리 스캔하고, 아직 구현되지 않은 라우트의 케이스가 확정 red가 되기 때문이다
  // (설정 실수가 계약 실패로 위장되는 경로 — SCOPE의 failclosed 주석 참조).
  for (const name of opts.profiles) {
    const row = SCOPE.find((p) => p.name === name);
    if (row && row.bootOnly && !opts.bootCheck) {
      usageDie(`--profile ${name}은 bootOnly 프로파일이라 --boot-check 없이는 실행할 수 없다`
        + `(케이스 목록이 비어 있어 러너가 contract/cases/${name}/를 디렉토리 스캔하고 그 결과가 확정 red다).`
        + ` 사용: node scripts/spring-contract.mjs --profile ${name} --boot-check`);
    }
  }
  if (!Number.isInteger(opts.timeout) || opts.timeout < 1000) {
    usageDie(`--timeout 값이 유효하지 않다(ms, 1000 이상 정수): ${opts.timeout}`);
  }
  // 관측 0건끼리의 비교는 차이 0을 보장할 뿐 계약 판정이 아니다(러너 119행과 같은 근거).
  if (opts.dualRun && opts.bootCheck) usageDie('--dual-run은 --boot-check와 함께 쓸 수 없다 — 관측 0건끼리의 비교는 계약 판정이 아니다.');
  if (opts.parity && opts.bootCheck) usageDie('--parity는 --boot-check와 함께 쓸 수 없다 — 관측 0건끼리의 비교는 계약 판정이 아니다.');
  return opts;
}

// --- 러너 소스 파생(단일 출처) ---
// 러너를 import하지 않는다: contract-run.mjs는 import 시점에 main()을 실행해 서버를 띄운다.
// 하드코딩하지도 않는다: 값이 갈리면 수집 케이스가 전부 401이 되는데 그 원인이 "계약 실패"로 위장된다.
function readRunnerSource() {
  try {
    return fs.readFileSync(RUNNER, 'utf8');
  } catch (err) {
    usageDie(`계약 러너 소스를 읽지 못했다: ${RUNNER} (${err && err.code})`);
    return '';
  }
}

// COLLECTION_TOKEN 값의 단일 출처 = 러너의 COLLECTION_TEST_TOKEN 리터럴. 실패하면 즉사한다
// (조용히 빈 토큰으로 진행하면 default 프로파일의 수집 케이스가 401이 된다). **값은 메시지에 담지 않는다.**
function readRunnerCollectionToken(src) {
  const m = /const\s+COLLECTION_TEST_TOKEN\s*=\s*'([^']+)'/.exec(src);
  if (!m) {
    usageDie('계약 러너에서 COLLECTION_TEST_TOKEN 리터럴을 찾지 못했다'
      + `(${RUNNER}) — 러너가 바뀌었으면 이 하네스의 추출 규칙을 함께 고쳐라(값은 이 메시지에 담지 않는다).`);
  }
  return m[1];
}

// 러너 PROFILES의 이름 목록 — SCOPE 이름이 러너에 없으면 러너가 프로파일을 못 찾아 죽는다(설정 실수).
function readRunnerProfileNames(src) {
  const block = /const\s+PROFILES\s*=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!block) usageDie(`계약 러너에서 PROFILES 표를 찾지 못했다(${RUNNER}) — 추출 규칙을 함께 고쳐라.`);
  const names = [...block[1].matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1]);
  if (names.length === 0) usageDie(`계약 러너 PROFILES에서 프로파일 이름을 하나도 읽지 못했다(${RUNNER}).`);
  return names;
}

// --- 스크립트 자기 검사 --- scripts/**는 eslint ignore 대상이라 이 검사가 유일한 정적 안전망이다.
function assertScopeSane(runnerProfileNames) {
  for (const p of SCOPE) {
    if (!runnerProfileNames.includes(p.name)) {
      usageDie(`SCOPE 프로파일 '${p.name}'이 러너 PROFILES에 없다(${runnerProfileNames.join('|')})`
        + ' — 두 대상이 서로 다른 프로파일 표를 쓰면 구성 차이가 계약 차이로 위장된다.');
    }
    if (!p.bootOnly && p.files.length === 0) {
      usageDie(`SCOPE 프로파일 '${p.name}'의 files가 비어 있다 — 러너가 contract/cases/${p.name}/를 디렉토리 스캔해`
        + ' 설정 실수가 계약 실패로 위장된다. 케이스를 명시하거나 bootOnly:true로 표시하라.');
    }
  }
}

// --- 환경 조립 ---

// java 자식 env — 허용 목록만 통과시킨다(부모 env 통째 상속 금지). win32의 SystemRoot/windir·TEMP는
// JVM·내장 Tomcat이 실제로 요구한다(빼면 소켓 초기화·임시 디렉토리 생성이 실패한다).
const OS_ENV_ALLOWLIST = process.platform === 'win32'
  ? ['SystemRoot', 'windir', 'SystemDrive', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS']
  : ['PATH', 'HOME', 'LANG', 'TZ'];

function javaChildEnv() {
  const env = {};
  for (const key of OS_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

// 러너 자식 env — 러너는 자기 자식(서버·케이스)의 env를 스스로 정리하지만 CONTRACT_* 잔재는 지우지 않는다.
// 스테일 CONTRACT_SESSIONS가 남아 있으면 세션 미준비 프로파일(auth-negative·prod-cookie)의 케이스가
// 죽은 토큰 파일을 읽어 계약이 아니라 환경을 측정하게 된다.
function runnerChildEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CONTRACT_')) delete env[key];
  }
  for (const key of ['NODE_ENV', 'DATA_DIR', 'PORT', 'HOST', 'SPA_DIR', 'NODE_OPTIONS']) delete env[key];
  return env;
}

// --- 자식 프로세스 유틸 (러너 동형) ---

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const childDead = (child) => child.exitCode !== null || child.signalCode !== null;

function waitExit(child, ms) {
  return new Promise((resolve) => {
    if (childDead(child)) return resolve(true);
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off('exit', onExit); resolve(false); }, ms);
    child.once('exit', onExit);
  });
}

// kill → 확인 → SIGKILL 폴백. 남기면 다음 패스가 같은 DATA_DIR 계열·포트 오염으로 무너진다.
async function killChild(child) {
  if (!child || childDead(child)) return true;
  child.kill();
  if (await waitExit(child, 2000)) return true;
  child.kill('SIGKILL');
  return waitExit(child, 3000);
}

function collectOutput(child) {
  const buf = { out: '', err: '' };
  child.stdout.on('data', (c) => { buf.out += c; });
  child.stderr.on('data', (c) => { buf.err += c; });
  return buf;
}

// 빈 포트 확정 — 후보를 **그 바인드 host로** 실제 listen해 본다(추측 금지 — contract-run pickFreePort 동형).
// host를 고정하면 0.0.0.0 바인딩 프로파일에서 "127.0.0.1은 비었지만 다른 인터페이스가 점유" 경우를 놓친다.
async function pickFreePort(host) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = PORT_BASE + Math.floor(Math.random() * PORT_SPAN);
    const free = await new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.listen(candidate, host, () => srv.close(() => resolve(true)));
    });
    if (free) return candidate;
  }
  throw new Error(`빈 포트를 찾지 못했다(host=${host}, [${PORT_BASE}, ${PORT_BASE + PORT_SPAN}) 20회 시도) — 환경 이상`);
}

async function waitHealthy(baseUrl, timeoutMs, child) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child && childDead(child)) return false; // 자식이 죽었으면 즉시 실패 — 대기 낭비 금지.
    try {
      const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.status === 200 && (await res.json()).ok === true) return true;
    } catch { /* 기동 전/도달 불가 — 재시도 */ }
    await sleep(200);
  }
  return false;
}

// --- 리포 데이터 안전 스냅샷 (contract-run repoDataSnapshot 동형) ---
function repoDataSnapshot() {
  const dbFile = nodePath.join(REPO_ROOT, 'news.db');
  const uploadsDir = nodePath.join(REPO_ROOT, 'uploads');
  const st = fs.existsSync(dbFile) ? fs.statSync(dbFile) : null;
  return {
    db: st ? { size: st.size, mtimeMs: st.mtimeMs } : null,
    uploads: fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir).length : null,
  };
}

// --- 실행 자산 해석(jar·JDK·리포트 디렉토리) ---

// jar는 **자동 빌드하지 않는다**(금지사항) — Maven 실행이 계약 실패와 섞이면 진단이 무너진다.
function resolveJar(given) {
  if (given) {
    const abs = nodePath.resolve(given);
    if (!fs.existsSync(abs)) usageDie(`--jar 파일이 존재하지 않는다: ${abs}`);
    return abs;
  }
  if (!fs.existsSync(SPRING_TARGET_DIR)) {
    usageDie(`Spring 실행 jar가 없다(${SPRING_TARGET_DIR} 없음). 먼저 빌드하라:\n  ${BUILD_HINT}`);
  }
  const candidates = fs.readdirSync(SPRING_TARGET_DIR)
    .filter((f) => f.endsWith('.jar') && !/-(sources|javadoc|tests)\.jar$/.test(f))
    .sort();
  if (candidates.length === 0) {
    usageDie(`Spring 실행 jar가 없다(${SPRING_TARGET_DIR}). 먼저 빌드하라:\n  ${BUILD_HINT}`);
  }
  if (candidates.length > 1) {
    usageDie(`Spring 실행 jar 후보가 여럿이다 — --jar로 지정하라: ${candidates.join(', ')}`);
  }
  return nodePath.join(SPRING_TARGET_DIR, candidates[0]);
}

// 시스템 java(1.8)로 떨어지면 원인 불명 기동 실패가 된다 — 명시 JDK만 쓴다.
function resolveJavaBin(given) {
  const home = given || process.env.SPRING_JAVA_HOME || process.env.JAVA_HOME;
  if (!home || String(home).trim() === '') {
    usageDie('JDK 홈을 찾지 못했다 — --java-home <path> 또는 SPRING_JAVA_HOME/JAVA_HOME을 설정하라'
      + `(포터블 JDK 21 예: ${JDK_HINT}). 시스템 java로 폴백하지 않는다.`);
  }
  const bin = nodePath.join(nodePath.resolve(home), 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!fs.existsSync(bin)) usageDie(`JDK 홈에 java 실행 파일이 없다: ${bin}`);
  return bin;
}

function assertOutsideRepo(dir, label) {
  const abs = nodePath.resolve(dir);
  if (abs === REPO_ROOT || abs.startsWith(REPO_ROOT + nodePath.sep)) {
    usageDie(`${label}는 리포 안에 둘 수 없다(리포트·비밀 파일은 리포를 오염시키지 않는다): ${abs}`);
  }
  return abs;
}

// 자격증명 조립 — 스키마·시드의 단일 출처는 Node의 src/db/seed.js다(decisions (5)).
function buildCredentials() {
  const byRole = {};
  for (const u of SAMPLE_USERS) byRole[u.role] = { userId: u.userId, password: u.password };
  for (const role of ROLES) {
    if (!byRole[role]) usageDie(`SAMPLE_USERS에 ${role} 역할 계정이 없다 — src/db/seed.js 확인`);
  }
  return { R: byRole.R, D: byRole.D, Z: byRole.Z };
}

function spawnRunner(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, ...args], {
      cwd: REPO_ROOT, env: runnerChildEnv(), stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.once('close', (code) => resolve(code === null ? 1 : code));
  });
}

// --- 패스 1회(= 프로파일 1개 × Spring 인스턴스 1개) ---
// 반환 { ok, reportFile, diagnostics[] }. 순서가 계약이다: 시드 → 포트 → 기동 → health → 비밀 파일 → 러너 → 정리.
async function runSpringPass(profile, opts, ctx, label) {
  const suffix = label ? `-${label}` : '';
  const tag = `${profile.name}${suffix}`;
  const reportFile = nodePath.join(ctx.outDir, `${tag}.json`);
  const root = ctx.mkTmp(`spring-contract-${tag}-`);
  const diagnostics = [];

  let javaChild = null;
  let javaBuf = { out: '', err: '' };
  // 비밀 파일 2종 — finally에서 **항상** 지운다(성패·--keep 무관).
  let credentialsFile = null;
  let targetsFile = null;

  try {
    // 1. 임시 DATA_DIR 시드 — 리포 news.db는 절대 열지 않는다.
    const dataDir = nodePath.join(root, 'data');
    fs.mkdirSync(dataDir);
    const db = new DatabaseSync(nodePath.join(dataDir, 'news.db'));
    createSchema(db);
    seedUsers(db);
    db.close();

    // 2. 빈 포트 확보(실제 listen) → 3. 명시 env로 기동. cwd도 임시 루트다(상대 경로 쓰기 격리).
    const port = await pickFreePort(profile.host);
    const env = javaChildEnv();
    env.DATA_DIR = dataDir;
    env.PORT = String(port);
    env.HOST = profile.host;
    // 구성 축 주입(러너 305~322행과 같은 값·같은 순서). 스풀은 **패스마다 새 디렉토리**다 —
    // --dual-run의 두 패스가 같은 스풀을 공유하면 자기 결정성 판정이 오염된다. 리포 안에는 절대 만들지 않는다.
    let spoolDir = null;
    if (profile.spool) {
      spoolDir = nodePath.join(root, 'spool');
      fs.mkdirSync(spoolDir);
      env.DIST_SPOOL_DIR = spoolDir;
    }
    if (profile.token) env.COLLECTION_TOKEN = ctx.collectionToken; // 값은 로그·리포트에 남기지 않는다.
    Object.assign(env, profile.extraEnv);

    javaChild = spawn(ctx.javaBin, ['-jar', ctx.jar], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    ctx.children.add(javaChild);
    javaBuf = collectOutput(javaChild);
    // 접속은 언제나 127.0.0.1이다(바인드가 0.0.0.0이어도 — 금지사항: 0.0.0.0으로 접속하지 마라).
    const baseUrl = `http://${CONNECT_HOST}:${port}`;
    // pid·dataDir·구성 축을 남긴다 — --dual-run의 두 패스가 정말 다른 프로세스·다른 데이터·다른 스풀로
    // 도는지 눈으로 확인한다. 토큰은 **불리언만** 남긴다(값 출력 금지).
    process.stdout.write(
      `  [${tag}] spring 기동 pid=${javaChild.pid ?? '-'} port=${port} host=${profile.host}`
      + ` spool=${profile.spool ? 'yes' : 'no'} token=${profile.token ? 'yes' : 'no'} dataDir=${dataDir}`
      + `${spoolDir ? ` spoolDir=${spoolDir}` : ''}\n`,
    );

    // 4. health 왕복 대기 — 자식이 죽으면 즉시 실패하고 stdout/stderr를 진단에 첨부한다.
    const bootStart = Date.now();
    if (!await waitHealthy(baseUrl, opts.timeout, javaChild)) {
      diagnostics.push(
        `[${tag}] spring 기동/health 실패(${Date.now() - bootStart}ms, exit=${javaChild.exitCode}, signal=${javaChild.signalCode}) ${baseUrl}/api/health\n`
        + `--- java stdout ---\n${javaBuf.out}\n--- java stderr ---\n${javaBuf.err}`,
      );
      return { ok: false, reportFile, diagnostics };
    }
    process.stdout.write(`  [${tag}] health ok ${Date.now() - bootStart}ms\n`);

    // 5. targets.json·creds.json(0600) — 리포 밖 임시 디렉토리에만 쓴다.
    targetsFile = nodePath.join(root, 'targets.json');
    credentialsFile = nodePath.join(root, 'creds.json');
    ctx.secretFiles.add(targetsFile);
    ctx.secretFiles.add(credentialsFile);
    fs.writeFileSync(targetsFile, `${JSON.stringify({ [profile.name]: baseUrl }, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(credentialsFile, `${JSON.stringify(buildCredentials(), null, 2)}\n`, { mode: 0o600 });

    // 6. 러너를 외부 대상 모드로 실행한다. --dual-run은 절대 전달하지 않는다(위 CRITICAL).
    const args = [
      '--profile', profile.name,
      '--base-url-map', targetsFile,
      '--credentials', credentialsFile,
      '--out', reportFile,
      '--timeout', String(opts.timeout),
    ];
    for (const f of profile.absFiles) args.push('--files', f);
    if (opts.bootCheck) args.push('--boot-check');
    const code = await spawnRunner(args);
    if (code !== 0) {
      diagnostics.push(`[${tag}] 계약 러너 실패(exit=${code}) — 위 러너 출력의 FAIL 사유가 원인이다. report=${reportFile}`);
      return { ok: false, reportFile, diagnostics };
    }
    return { ok: true, reportFile, diagnostics };
  } catch (err) {
    diagnostics.push(`[${tag}] ${err && err.stack ? err.stack : err}`);
    return { ok: false, reportFile, diagnostics };
  } finally {
    // 7-a. java 자식 종료 — 실패해도 반드시 시도한다(잔존 = 다음 패스 오염).
    if (javaChild) {
      const killed = await killChild(javaChild);
      ctx.children.delete(javaChild);
      if (!killed) diagnostics.push(`[${tag}] java 프로세스 종료 실패(SIGKILL 후에도 잔존) pid=${javaChild.pid ?? '-'}`);
    }
    // 7-b. 비밀 파일 삭제 — 성패·--keep 무관. 실패 시 임시 루트는 진단용으로 남지만 비밀은 남기지 않는다.
    for (const secretFile of [credentialsFile, targetsFile]) {
      if (!secretFile) continue;
      try {
        fs.rmSync(secretFile, { force: true, maxRetries: 5, retryDelay: 200 });
        ctx.secretFiles.delete(secretFile);
      } catch (err) {
        // 경로만 알린다(내용은 절대 싣지 않는다).
        process.stderr.write(`warn 비밀 파일 삭제 실패(직접 삭제하라): ${secretFile} (${err && err.code})\n`);
      }
    }
  }
}

// --- Node 대조 리포트(--parity) — 같은 파티션을 러너의 Node 대상 모드로 뽑는다 ---
async function runNodePass(profile, opts, ctx) {
  const reportFile = nodePath.join(ctx.outDir, `${profile.name}-node.json`);
  const args = ['--profile', profile.name, '--out', reportFile, '--timeout', String(opts.timeout)];
  for (const f of profile.absFiles) args.push('--files', f);
  const code = await spawnRunner(args);
  if (code !== 0) {
    return { ok: false, reportFile, diagnostics: [`[${profile.name}-node] Node 대조 실행 실패(exit=${code}) report=${reportFile}`] };
  }
  return { ok: true, reportFile, diagnostics: [] };
}

function readReport(file, label, failures) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    failures.push(`${label} 리포트를 읽지 못했다(${file}): ${e.message}`);
    return null;
  }
}

// 두 리포트 비교 — 규칙은 contract-diff.mjs가 소유한다. 반환: 차이 개수(비교 불가면 null).
function diffReports(labelA, fileA, labelB, fileB, failures) {
  const a = readReport(fileA, labelA, failures);
  const b = readReport(fileB, labelB, failures);
  if (!a || !b) return null;
  const result = compareReports(a, b);
  const lines = formatDiffLines(result);
  process.stdout.write(`  [diff] A=${labelA} B=${labelB} observations=${result.observationCount} diffs=${result.diffCount}\n`);
  if (lines.length > 0) process.stdout.write(`${lines.join('\n')}\n`);
  if (result.diffCount > 0) {
    failures.push(`리포트 차이 ${result.diffCount}건 (A=${labelA} B=${labelB}) — 위 차이 목록 참조.`);
  }
  return result.diffCount;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  // 자기 검사 + 러너 파생값 — 어떤 실행이든 가장 먼저 한다(설정 실수를 계약 실패보다 먼저 드러낸다).
  const runnerSrc = readRunnerSource();
  assertScopeSane(readRunnerProfileNames(runnerSrc));
  const collectionToken = SCOPE.some((p) => p.token) ? readRunnerCollectionToken(runnerSrc) : null;

  // --profile 미지정(다중 프로파일 실행)에서는 bootOnly 행을 제외한다 — 케이스 목록이 비어 있어
  // 러너 디렉토리 스캔이 확정 red가 되기 때문이다(SCOPE의 failclosed 주석 참조). 명시하면 실행한다.
  const explicit = opts.profiles.length > 0;
  const selected = SCOPE.filter((p) => (explicit ? opts.profiles.includes(p.name) : !p.bootOnly));
  const skippedBootOnly = explicit ? [] : SCOPE.filter((p) => p.bootOnly).map((p) => p.name);
  if (selected.length === 0) usageDie('실행할 프로파일이 없다 — --profile 값을 확인하라.');
  // 여러 프로파일 + --files는 금지다: 케이스가 requireProfile로 로드 시점에 throw해
  // "설정 실수"가 "계약 실패"처럼 보인다(금지사항).
  if (opts.files.length > 0 && selected.length !== 1) {
    usageDie(`--files는 단일 프로파일 실행 전용이다(선택된 프로파일 ${selected.length}개: ${selected.map((p) => p.name).join(',')}) — --profile 하나만 지정하라.`);
  }
  // 케이스 파일 절대경로 확정 + 존재 확인(파일명이 바뀌면 "계약 실패"가 아니라 설정 실패로 즉시 드러낸다).
  const profiles = selected.map((p) => {
    const files = (opts.files.length > 0 ? opts.files : p.files).map((f) => nodePath.resolve(REPO_ROOT, f));
    for (const f of files) {
      if (!fs.existsSync(f)) usageDie(`케이스 파일이 존재하지 않는다: ${f}`);
    }
    return { ...p, absFiles: files };
  });

  const jar = resolveJar(opts.jar);
  const javaBin = resolveJavaBin(opts.javaHome);

  const tmpDirs = [];
  const ctx = {
    jar,
    javaBin,
    collectionToken,
    children: new Set(),
    secretFiles: new Set(),
    mkTmp(prefix) {
      const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), prefix));
      tmpDirs.push(dir);
      return dir;
    },
  };
  // 리포트 디렉토리 — 미지정이면 mkdtemp(성공 + !--keep이면 정리). 리포 안에는 어떤 경우에도 쓰지 않는다.
  const ownsOutDir = !opts.outDir;
  ctx.outDir = opts.outDir
    ? assertOutsideRepo(opts.outDir, '--out-dir')
    : ctx.mkTmp('spring-contract-reports-');
  if (opts.outDir) fs.mkdirSync(ctx.outDir, { recursive: true });

  // SIGINT — java 자식과 비밀 파일만 최선 노력으로 정리한다(finally가 돌지 않는 유일한 경로).
  // 임시 디렉토리는 남긴다: 중단은 실패 계열이라 진단 자산이 필요하고, 보존 디렉토리에 비밀은 없다.
  let interrupted = false;
  process.on('SIGINT', () => {
    if (interrupted) return;
    interrupted = true;
    for (const child of ctx.children) { try { child.kill('SIGKILL'); } catch { /* 이미 죽음 */ } }
    for (const f of ctx.secretFiles) { try { fs.rmSync(f, { force: true }); } catch { /* 최선 노력 */ } }
    process.exit(130);
  });

  process.stdout.write(`spring-contract 시작 jar=${jar}\n  outDir=${ctx.outDir}\n`);
  // 사라진 프로파일은 "통과"로 오독된다 — skip을 반드시 한 줄로 보고한다.
  for (const name of skippedBootOnly) {
    process.stdout.write(`[${name}] skipped — bootOnly(케이스 미편입. 단독 실행: --profile ${name} --boot-check)\n`);
  }

  // 데이터 안전 — before 스냅샷(리포 news.db·uploads/)이 종료 후 무변 단언의 기준점이다.
  const repoBefore = repoDataSnapshot();

  const failures = [];
  const reportFiles = [];
  let diffTotal = null;
  const addDiff = (n) => { if (n !== null) diffTotal = (diffTotal ?? 0) + n; };

  for (const profile of profiles) {
    process.stdout.write(`[${profile.name}] 시작 files=${profile.absFiles.length}\n`);
    // --dual-run: 같은 프로파일을 **새 DATA_DIR + 새 프로세스**로 두 번 돌린다(위 CRITICAL).
    const labels = opts.dualRun ? ['a', 'b'] : [''];
    const passes = [];
    for (const label of labels) {
      const pass = await runSpringPass(profile, opts, ctx, label);
      passes.push(pass);
      reportFiles.push(pass.reportFile);
      failures.push(...pass.diagnostics);
      // 러너는 케이스가 실패해도 리포트를 쓴다 — 그래서 **케이스 red는 다음 패스를 막지 않는다**(red끼리도
      // "같은 입력이면 같은 리포트"여야 자기 결정성이 성립한다). 리포트가 아예 없으면 기동 실패이고,
      // 그때는 같은 원인이 반복될 뿐이라 다음 패스를 돌리지 않는다(타임아웃 낭비).
      if (!fs.existsSync(pass.reportFile)) break;
    }
    // 실패한 프로파일을 조용히 skip하지는 않는다(위에서 진단을 이미 기록했다) — 다만 비교는 리포트가
    // 양쪽 다 있을 때만 한다. 없는 리포트를 비교하면 진짜 실패 위에 읽기 실패 잡음이 얹힌다.
    const springReport = passes[0].reportFile;
    if (opts.dualRun && passes.length === 2 && passes.every((p) => fs.existsSync(p.reportFile))) {
      addDiff(diffReports(`${profile.name}-a`, passes[0].reportFile, `${profile.name}-b`, passes[1].reportFile, failures));
    }
    if (opts.parity) {
      process.stdout.write(`[${profile.name}] Node 대조 실행\n`);
      const nodePass = await runNodePass(profile, opts, ctx);
      reportFiles.push(nodePass.reportFile);
      failures.push(...nodePass.diagnostics);
      if (fs.existsSync(nodePass.reportFile) && fs.existsSync(springReport)) {
        addDiff(diffReports(`${profile.name}-node`, nodePass.reportFile, `${profile.name}-spring`, springReport, failures));
      }
    }
  }

  // 데이터 안전 단언 — 리포 news.db/uploads가 변했으면 실패다(무엇이 열렸든 되돌릴 수 없다).
  const repoAfter = repoDataSnapshot();
  if (JSON.stringify(repoBefore) !== JSON.stringify(repoAfter)) {
    failures.push(`리포 news.db/uploads 변동: before=${JSON.stringify(repoBefore)} after=${JSON.stringify(repoAfter)}`);
  }

  // 정리 — 성공 + !--keep일 때만 지운다(실패·--keep이면 진단 자산으로 보존). 비밀 파일은 이미 지워졌다.
  const ok = failures.length === 0;
  if (ok && !opts.keep) {
    for (const dir of tmpDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (err) {
        process.stderr.write(`warn 임시 디렉토리 정리 실패(무해 — Windows 파일 잠금): ${dir} (${err && err.code})\n`);
      }
    }
    if (ownsOutDir) process.stdout.write('  (--out-dir 미지정 — 임시 리포트를 정리했다. 보존하려면 --out-dir <dir> 또는 --keep)\n');
  } else if (tmpDirs.length > 0) {
    process.stdout.write(`keep 임시 디렉토리 보존(${ok ? '--keep' : '실패 진단용'} — 확인 후 삭제하라):\n${tmpDirs.map((d) => `  ${d}`).join('\n')}\n`);
  }

  if (!ok) process.stderr.write(`${failures.map((f) => `FAIL ${f}`).join('\n')}\n`);
  process.stdout.write(
    `spring-contract ${ok ? 'ok' : 'FAILED'} profiles=${profiles.length} `
    + `reports=${reportFiles.join(',') || '-'} diffs=${diffTotal ?? '-'}\n`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`spring-contract 실패: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
