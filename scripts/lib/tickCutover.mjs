// 운영 tick 전환 프로브의 순수 판정부 (phase 76 step7 — tick-cutover). fs·net·process·타이머 비의존.
// scripts/tick-cutover-probe.mjs 가 서버를 띄워 관측을 모으고, 판정·표 조립은 전부 여기서 한다(자기검사:
// scripts/lib/tickCutover.self-test.mjs — 프로브는 이것이 빨간 채로는 서버를 띄우지 않는다).
//
// 무엇을 판정하는가:
//   (1) 왕복 표 — README-배포 §6 의 운영 스크립트 형태(POST /api/login → sessionId → POST /api/distribution/tick + x-session-id)를
//       Node·Spring 에 같은 순서로 재현한 관측을 행 id 별 문자열로 받아, **기대치**(계약이 동결한 값)와 **Node=Spring** 두 축으로 판정한다.
//       측정이 빠진 행은 'not-measured' 로 red — "안 재고 통과" 를 구조적으로 막는다.
//   (2) A-2 다중 인스턴스 표 — Spring 2번째 기동(뜬다) · Node 2번째 기동(ADR-012 잠금에 막혀 exit 1) · 교차 세션(401) ·
//       순차 tick(파일 1→1) · 동시 tick(파일 수를 **기록** — 중복 회차 수·최대 파일 수는 판정이 아니라 수치다).
//   (3) 레이트리밋 산술 — 로그인 한도 10회/15분 고정 창(server/index.js 609~614 · LoginRateLimit.java)에서 주기 p초의 호출 수.
//   (4) ps1 정적 검사 — packaging/server/tick-distribution-spring.ps1 이 자격을 env 에서만 읽고 · 토큰·자격을 로그하지 않고 ·
//       Origin/Referer 를 흉내내지 않고 · 상주 루프가 없고 · 락이 있고 · 비0 종료코드가 있는지(S4·S5 의 리포 안 방어선).
//
// 규율: 이 모듈의 어떤 메시지에도 비밀·토큰·경로 값을 싣지 않는다(라벨과 개수만).

import { SPOOL_FILE } from './spoolParity.mjs';

/** 계약 distribution-tick 이 동결한 성공 응답 6키(정렬). */
export const TICK_KEYS = Object.freeze(['at', 'distributed', 'failed', 'invalid', 'ok', 'scanned']);

/** distributed 원소 3키(정렬). */
export const DISTRIBUTED_ITEM_KEYS = Object.freeze(['articleId', 'kinds', 'status']);

/** 로그인 레이트리밋 계약값 — 코드에서 읽었다(추측 금지): limit 10 · 15분 고정 창 · 클라이언트(IP)별. */
export const LOGIN_RATE_LIMIT = Object.freeze({ limit: 10, windowMs: 15 * 60 * 1000 });

/** ps1 이 자격·대상을 읽는 환경변수 이름(값은 어디에도 없다). */
export const PS1_ENV = Object.freeze({ base: 'NEWS_TICK_BASE', user: 'NEWS_TICK_USER', password: 'NEWS_TICK_PASSWORD' });

/** ps1 종료코드 규약 — 0 만 성공. 스케줄러는 비0 을 경보로 건다. */
export const PS1_EXIT = Object.freeze({ ok: 0, config: 2, login: 3, tick: 4, network: 5, lock: 6 });

// --- (3) 레이트리밋 산술 ---

/** 주기 p초로 부르면 15분 고정 창 하나에 몇 번 로그인하는가 = ceil(창/주기). 창의 첫 호출이 창을 연다. */
export function loginsPerWindow(periodSec, windowMs = LOGIN_RATE_LIMIT.windowMs) {
  if (typeof periodSec !== 'number' || !Number.isFinite(periodSec) || periodSec <= 0) {
    throw new Error('주기(초)는 양의 유한수여야 한다');
  }
  return Math.ceil((windowMs / 1000) / periodSec);
}

/** 한도를 넘지 않는 최소 주기(초) = 창/한도 = 90. 이보다 짧으면 창 안 11번째 로그인이 429 다. */
export function criticalPeriodSec({ limit, windowMs } = LOGIN_RATE_LIMIT) {
  return (windowMs / 1000) / limit;
}

export function rateLimitTable(periods = [30, 60, 89, 90, 120, 180, 300, 600, 900], limits = LOGIN_RATE_LIMIT) {
  return periods.map((periodSec) => {
    const callsPerWindow = loginsPerWindow(periodSec, limits.windowMs);
    return { periodSec, callsPerWindow, exceeds: callsPerWindow > limits.limit };
  });
}

export function formatRateLimitTable(rows, limits = LOGIN_RATE_LIMIT) {
  const lines = [
    `| 주기(초) | 15분 창 안 로그인 수 = ceil(900/주기) | 한도 ${limits.limit} 대비 |`,
    '|---|---|---|',
  ];
  for (const r of rows) {
    lines.push(`| ${r.periodSec} | ${r.callsPerWindow} | ${r.exceeds ? `**초과 → 11번째부터 429**` : '통과'} |`);
  }
  return lines;
}

// --- (1) 왕복 표 ---

/** 행 id 순서 = 표 순서. 값은 관측을 describe* 로 정규화한 문자열이며 기대치와 **문자열 동일**이어야 한다. */
export const ROUNDTRIP_ROW_IDS = Object.freeze([
  'login-z', 'tick-header', 'tick-shape', 'tick-no-path', 'tick-idempotent-files', 'tick-no-origin',
  'tick-non-z', 'tick-no-session', 'tick-spool-disabled', 'login-11th',
  'ps1-ok', 'ps1-rerun', 'ps1-bad-password', 'ps1-non-z', 'ps1-no-env', 'ps1-locked', 'ps1-unreachable',
]);

export const EXPECTED_ROUNDTRIP = Object.freeze({
  'login-z': '200 sessionId=string',
  'tick-header': '200 ok=true',
  'tick-shape': `keys=${TICK_KEYS.join(',')} item=${DISTRIBUTED_ITEM_KEYS.join(',')} kinds=press status=DPS`,
  'tick-no-path': 'leaks=0',
  'tick-idempotent-files': 'tick1=distributed tick2=not-distributed files=1/1',
  'tick-no-origin': 'none=200 evil=403:forbidden-origin',
  'tick-non-z': 'R=403:forbidden D=403:forbidden',
  'tick-no-session': '401:unauthenticated',
  'tick-spool-disabled': '503:spool-disabled',
  'login-11th': '429@11',
  'ps1-ok': `exit=${PS1_EXIT.ok} distributed=1 files=1 leaks=0`,
  'ps1-rerun': `exit=${PS1_EXIT.ok} distributed=0 files=1 leaks=0`,
  'ps1-bad-password': `exit=${PS1_EXIT.login} stage=login`,
  'ps1-non-z': `exit=${PS1_EXIT.tick} stage=tick status=403`,
  'ps1-no-env': `exit=${PS1_EXIT.config} stage=config`,
  'ps1-locked': `exit=${PS1_EXIT.lock}`,
  'ps1-unreachable': `exit=${PS1_EXIT.network} stage=network`,
});

/** 행 설명(표의 사람용 열). */
export const ROUNDTRIP_LABELS = Object.freeze({
  'login-z': 'POST /api/login (Z) — 응답 본문 sessionId 필드',
  'tick-header': 'POST /api/distribution/tick + x-session-id 헤더(쿠키 없음)',
  'tick-shape': '응답 shape(6키 · distributed 원소 3키 · press/DPS)',
  'tick-no-path': '응답에 스풀 경로 비노출(spoolDir·슬러그·.json·구분자)',
  'tick-idempotent-files': '같은 tick 2회 — 스풀 파일 수로 멱등(기사 1건의 파일 수 tick1/tick2)',
  'tick-no-origin': 'Origin·Referer 없이 통과(ADR-009) · 대조: 타 출처 Origin 은 403',
  'tick-non-z': '비-Z 세션(R·D) → 403 forbidden',
  'tick-no-session': '무세션 → 401 unauthenticated',
  'tick-spool-disabled': 'DIST_SPOOL_DIR 미설정 인스턴스 → 503 spool-disabled',
  'login-11th': '같은 IP 연속 로그인 — 몇 번째가 429 인가(한도 10)',
  'ps1-ok': 'tick-distribution-spring.ps1 정상(도래 기사 1건) — exit·distributed·파일 수·출력 위생',
  'ps1-rerun': '같은 ps1 재실행 — 재배부 0 · 파일 수 유지',
  'ps1-bad-password': 'ps1 자격 오류 → exit 3',
  'ps1-non-z': 'ps1 비-Z 자격 → exit 4 (tick 403)',
  'ps1-no-env': 'ps1 환경변수 없음 → exit 2',
  'ps1-locked': 'ps1 락 점유 중 → exit 6 (이중 실행 방지)',
  'ps1-unreachable': 'ps1 서버 미도달 → exit 5',
});

const NOT_MEASURED = 'not-measured';

/**
 * @param observed { node: {rowId: string}, spring: {rowId: string} }
 * @returns { ok, rows:[{id,label,expected,node,spring,same,nodeOk,springOk}], failures:[] }
 */
export function judgeRoundtrip(observed) {
  const failures = [];
  const rows = ROUNDTRIP_ROW_IDS.map((id) => {
    const expected = EXPECTED_ROUNDTRIP[id];
    const node = observed?.node?.[id] ?? NOT_MEASURED;
    const spring = observed?.spring?.[id] ?? NOT_MEASURED;
    const nodeOk = node === expected;
    const springOk = spring === expected;
    const same = node === spring;
    if (!nodeOk) failures.push(`[node] ${id}: 기대 "${expected}" 실제 "${node}"`);
    if (!springOk) failures.push(`[spring] ${id}: 기대 "${expected}" 실제 "${spring}"`);
    if (!same) failures.push(`[diff] ${id}: node "${node}" ≠ spring "${spring}" — Node 와 다르면 그것이 발견이다`);
    return { id, label: ROUNDTRIP_LABELS[id], expected, node, spring, same, nodeOk, springOk };
  });
  return { ok: failures.length === 0, rows, failures };
}

export function formatSideBySide(rows) {
  const lines = ['| 축 | 기대 | node | spring | 판정 |', '|---|---|---|---|---|'];
  for (const r of rows) {
    const verdict = r.nodeOk && r.springOk ? 'same' : (r.same ? '**같이 틀림**' : '**diff**');
    lines.push(`| ${r.label} | \`${r.expected}\` | \`${r.node}\` | \`${r.spring}\` | ${verdict} |`);
  }
  return lines;
}

// --- 관측 정규화(HTTP 응답 → 문자열) ---

export function describeLogin(res) {
  return `${res.status} sessionId=${typeof res?.json?.sessionId}`;
}

/** tick 응답의 shape 을 한 줄로 — articleId 의 원소가 있으면 그 원소의 키·kinds·status 까지. */
export function describeTick(res, articleId) {
  const json = res?.json ?? {};
  const keys = Object.keys(json).sort().join(',');
  const item = Array.isArray(json.distributed) ? json.distributed.find((d) => d && d.articleId === articleId) : undefined;
  if (!item) return `keys=${keys} item=absent`;
  return `keys=${keys} item=${Object.keys(item).sort().join(',')} kinds=${Array.isArray(item.kinds) ? item.kinds.join('+') : String(item.kinds)} status=${item.status}`;
}

/** 계약 assertNoSpoolPath 동형 — 응답 전체 문자열에서 4축을 본다. 라벨만 돌려준다. */
export function spoolPathLeaks(json, slugs = []) {
  const raw = JSON.stringify(json ?? null);
  const leaks = [];
  if (raw.includes('spoolDir')) leaks.push('spoolDir');
  if (slugs.some((s) => s && raw.includes(s))) leaks.push('slug');
  if (raw.includes('.json')) leaks.push('.json');
  if (/[\\/]/.test(raw)) leaks.push('separator');
  return leaks;
}

// --- 스풀 파일 수(디렉토리 listing → 순수) ---

export function countSpoolFiles(names, articleId) {
  let n = 0;
  for (const name of names) {
    const m = SPOOL_FILE.exec(name);
    if (m && m[1] === articleId) n += 1;
  }
  return n;
}

export function duplicateArticles(names) {
  const counts = {};
  for (const name of names) {
    const m = SPOOL_FILE.exec(name);
    if (m) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  }
  const dup = {};
  for (const [id, c] of Object.entries(counts)) if (c > 1) dup[id] = c;
  return dup;
}

// --- (2) A-2 다중 인스턴스 표 ---

/**
 * @param obs {
 *   springSecondBoot: 'health-ok' | string,
 *   nodeSecondBoot: { exitCode, elapsedMs, hint, firstStillHealthy },
 *   crossSession: { aTokenOnB, bOwnToken },
 *   sequential: { tickA, tickB, filesAfterA, filesAfterB },
 *   concurrent: [{ round, files, inA, inB }],
 * }
 */
export function judgeMultiInstance(obs) {
  const failures = [];
  const o = obs ?? {};
  if (o.springSecondBoot !== 'health-ok') failures.push(`Spring 2번째 인스턴스가 뜨지 않았다(${o.springSecondBoot ?? NOT_MEASURED}) — 측정이 성립하지 않는다`);
  const nb = o.nodeSecondBoot ?? {};
  if (nb.exitCode !== 1 || !nb.hint) failures.push(`Node 2번째 인스턴스(같은 DATA_DIR)가 ADR-012 잠금에 막히지 않았다: exit=${nb.exitCode ?? NOT_MEASURED} hint=${Boolean(nb.hint)}`);
  if (!nb.firstStillHealthy) failures.push('Node 첫 인스턴스가 2번째 기동 시도 뒤 health 를 잃었다');
  const cs = o.crossSession ?? {};
  if (cs.aTokenOnB !== '401:unauthenticated') failures.push(`교차 세션(A 로그인 → B 요청)이 401 이 아니다: ${cs.aTokenOnB ?? NOT_MEASURED}`);
  if (cs.bOwnToken !== '200') failures.push(`B 자기 세션 tick 이 200 이 아니다: ${cs.bOwnToken ?? NOT_MEASURED}`);
  const sq = o.sequential ?? {};
  if (sq.tickA !== 'distributed' || sq.tickB !== 'not-distributed' || sq.filesAfterA !== 1 || sq.filesAfterB !== 1) {
    failures.push(`순차 tick(A → B)이 이력 기준 멱등이 아니다: tickA=${sq.tickA} tickB=${sq.tickB} files=${sq.filesAfterA}/${sq.filesAfterB}`);
  }
  const cc = Array.isArray(o.concurrent) ? o.concurrent : [];
  if (cc.length === 0) failures.push('동시 tick 회차가 0 — 중복 배부 크기를 재지 않았다');
  for (const r of cc) {
    if (!(Number.isInteger(r.files) && r.files >= 1)) failures.push(`동시 tick 회차 ${r.round}: 파일 수가 정수 ≥1 이 아니다(${r.files})`);
    // 「양쪽이 실제로 tick 했는가」를 보지 않으면, 한쪽이 401/500 으로 죽고 다른 한쪽만 배부한 회차도 정상 관측으로 통과한다
    // (§6-9 (1) 의 1차 실패 — 세션 단일 정책으로 A 가 전부 401 이었는데 「중복 0」처럼 보였다). 그 회차는 무효다.
    if (!concurrentRoundValid(r)) {
      failures.push(`동시 tick 회차 ${r.round}: 양쪽이 200 으로 tick 하지 않았다(A=${r.statusA ?? NOT_MEASURED} B=${r.statusB ?? NOT_MEASURED}) — 한쪽만 성공한 회차는 중복 배부 크기의 증거가 아니다`);
    }
  }
  const valid = cc.filter(concurrentRoundValid);
  const duplicateRounds = valid.filter((r) => r.files > 1).length;
  const maxFiles = valid.reduce((m, r) => Math.max(m, Number(r.files) || 0), 0);
  return {
    ok: failures.length === 0, failures, duplicateRounds, maxFiles,
    rounds: cc.length, validRounds: valid.length, invalidRounds: cc.length - valid.length, obs: o,
  };
}

/** 동시 라운드는 A·B 가 **둘 다 200 으로 tick 에 도달**했을 때만 중복 배부 크기의 증거가 된다. */
function concurrentRoundValid(r) {
  return r?.statusA === 200 && r?.statusB === 200;
}

export function formatMultiInstance(result) {
  const o = result.obs ?? {};
  const nb = o.nodeSecondBoot ?? {};
  const cs = o.crossSession ?? {};
  const sq = o.sequential ?? {};
  const cc = Array.isArray(o.concurrent) ? o.concurrent : [];
  const lines = ['| 축 | Node (같은 DATA_DIR · 다른 포트) | Spring (같은 MySQL · 같은 DIST_SPOOL_DIR · 같은 DATA_DIR · 다른 포트) |', '|---|---|---|'];
  lines.push(`| 2번째 인스턴스 기동 | **exit=${nb.exitCode ?? NOT_MEASURED}** ${nb.elapsedMs ?? '?'}ms (ADR-012 잠금 안내 ${nb.hint ? '있음' : '없음'} · 첫 인스턴스 health ${nb.firstStillHealthy ? '유지' : '상실'}) | **${o.springSecondBoot ?? NOT_MEASURED}** — 둘 다 뜬다 |`);
  lines.push(`| 교차 세션(A 로그인 → B 에 tick) | (2번째가 뜨지 않아 성립 불가) | ${cs.aTokenOnB ?? NOT_MEASURED} · B 자기 세션 ${cs.bOwnToken ?? NOT_MEASURED} |`);
  lines.push(`| 순차 tick(A 먼저 → B) | (성립 불가) | A ${sq.tickA ?? NOT_MEASURED} · B ${sq.tickB ?? NOT_MEASURED} · 파일 ${sq.filesAfterA ?? '?'} → ${sq.filesAfterB ?? '?'} |`);
  const detail = cc.map((r) => (concurrentRoundValid(r)
    ? `${r.round}:${r.files}${r.inA && r.inB ? '(A+B)' : r.inA ? '(A)' : r.inB ? '(B)' : '(-)'}`
    : `${r.round}:무효(A=${r.statusA ?? NOT_MEASURED} B=${r.statusB ?? NOT_MEASURED})`)).join(' ');
  const invalid = result.invalidRounds ? ` · **무효 회차 ${result.invalidRounds}**(한쪽이 200 이 아니다 — 수치에서 제외)` : '';
  lines.push(`| 동시 tick(A·B 동시 발화 · ${cc.length}회) | (성립 불가) | **중복 회차 ${result.duplicateRounds}/${result.validRounds ?? cc.length} · 기사당 최대 파일 ${result.maxFiles}**${invalid} — 회차:파일수 ${detail || '-'} |`);
  return lines;
}

// --- (4) ps1 정적 검사 ---

const PS1_ENV_USER = `$env:${PS1_ENV.user}`;
const PS1_ENV_PASSWORD = `$env:${PS1_ENV.password}`;

/** 코멘트(#…)를 뗀 코드 줄만 본다 — 주석의 설명 문구가 검사에 걸리면 문서화를 벌하는 셈이다. */
function codeLines(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.replace(/#.*$/, '')).filter((l) => l.trim() !== '');
}

export function ps1StaticFindings(text) {
  const findings = [];
  const lines = codeLines(text);
  const code = lines.join('\n');
  if (!code.includes(PS1_ENV_USER)) findings.push('user-not-from-env');
  if (!code.includes(PS1_ENV_PASSWORD)) findings.push('password-not-from-env');
  // 자격 평문: $secret/$password/$pwd/$user/$userId 에 리터럴 대입(플레이스홀더 <…>·$ 전개·빈 문자열 제외).
  if (/\$(secret|password|pwd|pass)\s*=\s*['"](?![<$])[^'"]+['"]/i.test(code)) findings.push('literal-password');
  if (/\$(user|userId|username)\s*=\s*['"](?![<$])[^'"]+['"]/i.test(code)) findings.push('literal-user');
  if (/password\s*=\s*['"](?![<$])[^'"]+['"]/i.test(code)) findings.push('literal-password-in-body');
  // 등호+따옴표가 아닌 흔한 두 형태(리뷰 후속 (5)) — 종전 세 패턴은 둘 다 놓쳤다.
  // (가) ConvertTo-SecureString 에 평문 리터럴(인자 순서 3형). 값이 $변수·<자리표시자> 면 평문 상수가 아니다.
  if (/ConvertTo-SecureString\b[^\n]*-AsPlainText/i.test(code)
    && lines.some((l) => /ConvertTo-SecureString/i.test(l) && /-AsPlainText/i.test(l) && /['"](?![<$])[^'"]+['"]/.test(l))) {
    findings.push('literal-secure-string');
  }
  // (나) 콜론 구문 — JSON·here-string 리터럴의 "password": "<값>"
  if (/['"]?(password|secret|pwd|pass)['"]?\s*:\s*['"](?![<$])[^'"]+['"]/i.test(code)) findings.push('literal-password-json');
  // 비0 종료코드: exit 뒤에 0 이 아닌 리터럴이나 변수가 최소 1곳 있어야 한다 — 전부 exit 0 이면 실패가 스케줄러에 보이지 않는다(S4).
  const exits = [...code.matchAll(/\bexit\s+([^\s;)]+)/gi)].map((m) => m[1]);
  if (!exits.some((v) => v !== '0')) findings.push('no-nonzero-exit');
  // 로그 줄: 로그인 응답 통째 · 세션 토큰 · 자격 값을 출력하면 계약을 밖에서 깬다.
  for (const line of lines) {
    if (!/\b(Write-Output|Write-Host|Write-Information|Write-Warning|Write-Error|Add-Content|Set-Content|Out-File|Write-Line|Finish)\b/i.test(line)) continue;
    if (/\$login\b(?!\.status\b)(?!\.json\.reason\b)/.test(line)) findings.push('login-response-logged');
    if (/sessionId|\$sid\b|\$token\b/i.test(line)) findings.push('token-logged');
    if (/\$secret\b|\$password\b|\$pwd\b|\$env:NEWS_TICK_PASSWORD/i.test(line)) findings.push('credential-logged');
  }
  if (/['"](Origin|Referer)['"]\s*=/i.test(code)) findings.push('browser-origin-header');
  // 상주 루프·초 단위 대기·타이머 금지. 밀리초 단위(≤ 4자리) Start-Sleep 은 락 열기 재시도(1초 안 5회)에만 허용한다.
  if (/while\s*\(\s*\$true\s*\)|Start-Sleep\s+(-Seconds\s+)?\d|Start-Sleep\s+-Milliseconds\s+\d{5,}|Register-ScheduledJob|New-Timer|Timers\.Timer/i.test(code)) findings.push('resident-loop');
  if (!/\[IO\.FileShare\]::None|\[System\.IO\.FileShare\]::None|FileShare\]::None/.test(code)) findings.push('no-lock');
  return [...new Set(findings)];
}

/** 비ASCII 가 있는데 UTF-8 BOM 이 없으면 Windows PowerShell 5.1 이 ANSI 로 읽어 문자열이 깨진다. */
export function ps1EncodingFinding(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? '');
  const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
  const nonAscii = buf.some((b) => b > 0x7F);
  return nonAscii && !hasBom ? 'missing-utf8-bom' : null;
}

// --- 출력 위생 ---

/**
 * 리포트(tables.md)·stdout 으로 **나가는** 줄에서 비밀·토큰·경로 값을 라벨로 치환한다.
 * outputLeaks 가 「섞였다」를 알리는 검출기라면 이쪽은 그래도 값이 새어 나가지 않게 하는 방어선이다 —
 * 검출은 실행을 실패로 만들 뿐 이미 리포트에 박힌 토큰을 지워 주지 않는다(리뷰 후속 (1)).
 * secrets 는 outputLeaks 와 같은 { label, value } 모양이다.
 */
export function maskSample(text, secrets) {
  let out = String(text ?? '');
  for (const s of secrets ?? []) {
    if (!s || typeof s.value !== 'string' || s.value.length === 0) continue;
    out = out.split(s.value).join(`<${s.label}>`);
  }
  return out;
}

/** ps1 로그 한 줄의 **허용 필드**(§6-3 이 문서화한 형식) — 값의 형태까지 제한한다. */
const PS1_SAMPLE_FIELDS = Object.freeze({
  stage: /^[a-z]+$/,
  status: /^\d{3}$/,
  reason: /^[a-z][a-z0-9-]*$/i,
  distributed: /^\d+$/, scanned: /^\d+$/, failed: /^\d+$/, invalid: /^\d+$/, skipped: /^\d+$/,
});
const PS1_SAMPLE_HEAD = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PS1_SAMPLE_WORDS = new Set(['tick', 'ok', 'FAIL', 'skipped']);
const OUT_OF_FORM = '<형식 밖>';

/**
 * 리포트·stdout 으로 나가는 ps1 표본 줄을 **allowlist** 로 자른다.
 *
 * 왜 maskSample 만으로는 부족한가(실측): ps1 은 호출마다 **자기 세션을 스스로 발급**하므로 그 토큰 값은 하네스가
 * 모른다(단일 세션 정책 · §6-9 (1)). 값을 아는 비밀만 가리면 「ps1 이 자기 sessionId 를 찍는」 바로 그 사고를 못 막는다 —
 * 변이 실측에서 `x=<64hex>` 가 tables.md 에 그대로 실렸다. 그래서 **아는 형식만 싣고 나머지는 값째로 지운다**.
 */
export function sanitizePs1Sample(text, secrets) {
  const masked = maskSample(text, secrets);
  const tokens = masked.split(/\s+/).filter((t) => t !== '');
  return tokens.map((token, index) => {
    if (index === 0) return PS1_SAMPLE_HEAD.test(token) ? token : OUT_OF_FORM;
    if (PS1_SAMPLE_WORDS.has(token)) return token;
    const m = /^([a-zA-Z]+)=(.*)$/.exec(token);
    if (m && Object.hasOwn(PS1_SAMPLE_FIELDS, m[1]) && PS1_SAMPLE_FIELDS[m[1]].test(m[2])) return token;
    return OUT_OF_FORM;
  }).join(' ');
}

/** 값을 몰라도 **형태**로 잡는다 — 32자 이상 연속 16진수는 세션 토큰·해시다(sessionId 는 64자). 라벨만 돌려준다. */
export function tokenShapeLeaks(text) {
  return /[0-9a-fA-F]{32,}/.test(String(text ?? '')) ? ['hex-token'] : [];
}

/** 자식 출력에 비밀·토큰·경로 값이 섞였는지 — 라벨만 돌려준다(값은 어디에도 싣지 않는다). */
export function outputLeaks(text, secrets) {
  const out = String(text ?? '');
  const labels = [];
  for (const s of secrets ?? []) {
    if (!s || typeof s.value !== 'string' || s.value.length === 0) continue;
    if (out.includes(s.value)) labels.push(s.label);
  }
  return labels;
}
