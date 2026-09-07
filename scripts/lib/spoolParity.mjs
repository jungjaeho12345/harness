// 배부 스풀 산출물 바이트 대조의 **순수 판정부** (phase 76 step5 — decisions (8)).
// fs·process·fetch 에 기대지 않는다. 자기검사: node --test scripts/lib/spoolParity.self-test.mjs
//
// 무엇을 대조하는가: Node(src/services/spoolWriter.js)와 Spring(SpoolWriter.java)이 **같은 시나리오**에서 쓴
// <DIST_SPOOL_DIR>/<slug>/<articleId>_<stamp>.json 파일들을 (수신처 폴더 집합 · 폴더별 파일 수 · 정규화 후 전 바이트)로 비교한다.
// 계약 스위트는 응답에 스풀 경로가 **없음**을 단언하고(distribution-tick.contract.js assertNoSpoolPath) --parity 는 HTTP 만
// 본다 — 이 파일들의 바이트를 보는 자리는 여기뿐이다.
//
// 비결정 요소는 서버가 찍는 것뿐이다. 그래서 자리표시자는 PLACEHOLDER_KEYS **한 곳**이 소유하고 자기검사가 그 **집합**을
// 잠근다(개수가 아니다 — Q6: 여기에 title 을 넣는 순간 제목의 모든 차이가 조용히 통과한다). 눈감는 대신 **단언**한다:
//   ① distributedAt · createdAt · sentAt 은 ISO-8601 밀리초 UTC(YYYY-MM-DDTHH:MM:SS.sssZ)다
//   ② 파일명 stamp == distributedAt 에서 [-:.] 를 제거한 값(같은 stamp 에서 나왔다 — Q7)
//   ③ createdAt ≤ sentAt ≤ distributedAt(문자열 비교 — 고정 폭 형식이라 사전순 = 시간순)
//   ④ 파일명의 articleId == 페이로드의 articleId
// 치환은 **최상위 키의 값만** 바꾼다(제목 본문에 같은 글자가 있어도 손대지 않는다 — 스캐너가 값 자리를 정확히 가리킨다).
//
// 짝짓기는 **정렬이 아니라 시나리오 순번**이다: 양쪽 articleId 가 다르고 파일명이 시각을 담아 정렬이 우연히 맞을 뿐이다.
// 재생기가 (순번 → articleId) 표를 양쪽 각각 만들어 넘기고, 판정부는 (폴더, 순번) 키로 대응한다. 표에 없는 articleId 의
// 파일은 실패다(두 서버가 같은 스풀 루트를 쓰면 여기서 즉시 드러난다 — Q8).

// --- 상수(단일 출처) ---

/**
 * 눈감는 최상위 키 — **이 목록이 전부다.** 늘리려면 "왜·대신 무엇을 단언하는가"를 docs/cutover-p3.md §4 에 적어라.
 * 계획은 3종(distributedAt·파일명 stamp·articleId)이었고 첫 실측에서 createdAt·sentAt(서버 시각 stamp — articleService)이
 * 갈려 둘을 더했다. 그 대신 ①③의 형식·단조성 단언이 붙는다(자기검사 '정합 3겹').
 */
export const PLACEHOLDER_KEYS = Object.freeze(['articleId', 'createdAt', 'sentAt', 'distributedAt']);

/** 단조성 사슬 — 이 순서로 커져야 한다(같은 값 허용). */
export const STAMP_ORDER = Object.freeze(['createdAt', 'sentAt', 'distributedAt']);

/** Node `new Date().toISOString()` = Spring `Iso8601.now` 형식. 소수 3자리 고정 · 항상 Z. */
export const ISO_MILLIS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `<articleId>_<compactStamp>.json` — spoolWriter.js:69 · SpoolWriter.java:148. */
export const SPOOL_FILE = /^([A-Za-z0-9_-]{1,64})_(\d{8}T\d{9}Z)\.json$/;

/** 시나리오가 만드는 수신처 슬러그 3종(두 서버 각각 빈 DB 에서 출발하므로 고정 이름이 결정적이다). */
export const SPOOL_FOLDERS = Object.freeze({ press: 'sp-press', nonpress: 'sp-nonpress', retry: 'sp-retry' });

/**
 * Jackson 기본값이 대문자 `\u00XX` 를 쓰는 9자 — Spring `LowercaseHexEscapes` 가 소문자로 바꾸는 자리다.
 * 시나리오 (마)가 이 중 하나를 **최상위 문자열 값**에 담지 않으면 변이 Q3 가 무해해진다(자기검사가 표본을 강제한다).
 */
export const LOWERCASE_HEX_CHARS = Object.freeze([0x0B, 0x0E, 0x0F, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F]);

export function compactStamp(iso) {
  return String(iso).replace(/[-:.]/g, '');
}

export function parseSpoolFileName(name) {
  const m = typeof name === 'string' ? SPOOL_FILE.exec(name) : null;
  return m ? { articleId: m[1], stamp: m[2] } : null;
}

// --- 최상위 JSON 스캐너 — 값의 **바이트 자리**를 알아야 치환할 수 있다(JSON.parse 는 자리를 잃는다) ---

function isWs(ch) {
  return ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t';
}

// 문자열 리터럴의 닫는 따옴표 다음 인덱스. start 는 여는 따옴표 자리.
function scanString(text, start) {
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"') return i + 1;
    i += 1;
  }
  throw new Error('문자열이 끝나지 않았다(malformed JSON)');
}

// 중첩 객체/배열의 끝 다음 인덱스(문자열 안의 괄호는 세지 않는다).
function scanNested(text, start) {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') { i = scanString(text, i); continue; }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  throw new Error('객체/배열이 끝나지 않았다(malformed JSON)');
}

/**
 * 최상위 객체의 키 순서와 값 자리를 돌려준다. 값의 kind 는 'string' | 'other'(숫자·리터럴·중첩).
 * @returns {{ keys: string[], values: Array<{ key: string, start: number, end: number, kind: 'string'|'other' }> }}
 */
export function scanTopLevel(text) {
  if (typeof text !== 'string') throw new Error('문자열이 아니다');
  let i = 0;
  while (i < text.length && isWs(text[i])) i += 1;
  if (text[i] !== '{') throw new Error('최상위가 객체가 아니다');
  i += 1;
  const keys = [];
  const values = [];
  for (;;) {
    while (i < text.length && isWs(text[i])) i += 1;
    if (i >= text.length) throw new Error('객체가 끝나지 않았다(malformed JSON)');
    if (text[i] === '}') { i += 1; break; }
    if (text[i] !== '"') throw new Error(`키 자리에 문자열이 아닌 것이 있다(offset ${i})`);
    const keyEnd = scanString(text, i);
    const key = JSON.parse(text.slice(i, keyEnd));
    i = keyEnd;
    while (i < text.length && isWs(text[i])) i += 1;
    if (text[i] !== ':') throw new Error(`키 뒤에 ':' 가 없다(offset ${i})`);
    i += 1;
    while (i < text.length && isWs(text[i])) i += 1;
    if (i >= text.length) throw new Error('값이 없다(malformed JSON)');
    const start = i;
    let kind;
    if (text[i] === '"') { i = scanString(text, i); kind = 'string'; }
    else if (text[i] === '{' || text[i] === '[') { i = scanNested(text, i); kind = 'other'; }
    else {
      while (i < text.length && text[i] !== ',' && text[i] !== '}' && !isWs(text[i])) i += 1;
      kind = 'other';
    }
    keys.push(key);
    values.push({ key, start, end: i, kind });
    while (i < text.length && isWs(text[i])) i += 1;
    if (i >= text.length) throw new Error('객체가 끝나지 않았다(malformed JSON)');
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === '}') { i += 1; break; }
    throw new Error(`값 뒤에 ',' 나 '}' 가 없다(offset ${i})`);
  }
  while (i < text.length && isWs(text[i])) i += 1;
  if (i !== text.length) throw new Error('객체 뒤에 내용이 더 있다(malformed JSON)');
  return { keys, values };
}

// --- 파일 1개 정규화 + 정합 단언 ---

/**
 * @param {string} name 파일명(폴더 제외)
 * @param {string} text 파일 내용(UTF-8 디코드)
 * @returns {{ ok: boolean, errors: string[], keys: string[], articleId: string|null, stamp: string|null,
 *            normalizedName: string, normalizedText: string, blinded: number }}
 */
export function normalizeFile(name, text) {
  const errors = [];
  const parsedName = parseSpoolFileName(name);
  if (!parsedName) errors.push(`파일명이 <articleId>_<stamp>.json 형태가 아니다: ${name}`);

  let scan = null;
  let payload = null;
  try {
    scan = scanTopLevel(text);
    payload = JSON.parse(text);
  } catch (err) {
    errors.push(`JSON 형식 오류: ${err.message}`);
  }
  if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) {
    errors.push('최상위가 객체가 아니다');
    payload = null;
  }
  if (scan) {
    const seen = new Set();
    for (const key of scan.keys) {
      if (seen.has(key)) errors.push(`중복 키: ${key}`);
      seen.add(key);
    }
  }

  let blinded = 0;
  let normalizedText = text;
  if (payload && scan) {
    // ① 형식 · ④ 파일명 articleId == 페이로드 articleId
    const dist = payload.distributedAt;
    if (typeof dist !== 'string' || !ISO_MILLIS_Z.test(dist)) errors.push(`distributedAt 이 ISO-8601 밀리초 Z 형식이 아니다: ${JSON.stringify(dist)}`);
    for (const key of STAMP_ORDER) {
      if (key === 'distributedAt' || payload[key] === undefined) continue;
      if (typeof payload[key] !== 'string' || !ISO_MILLIS_Z.test(payload[key])) errors.push(`${key} 가 ISO-8601 밀리초 Z 형식이 아니다: ${JSON.stringify(payload[key])}`);
    }
    if (parsedName && payload.articleId !== parsedName.articleId) {
      errors.push(`파일명 articleId(${parsedName.articleId})와 페이로드 articleId(${JSON.stringify(payload.articleId)})가 다르다`);
    }
    // ② 파일명 stamp == compactStamp(distributedAt)
    if (parsedName && typeof dist === 'string' && compactStamp(dist) !== parsedName.stamp) {
      errors.push(`파일명 stamp(${parsedName.stamp})가 distributedAt(${dist} → ${compactStamp(dist)})와 정합하지 않는다`);
    }
    // ③ 단조성 — 있는 것끼리 순서대로.
    const chain = STAMP_ORDER.filter((k) => typeof payload[k] === 'string' && ISO_MILLIS_Z.test(payload[k]));
    for (let i = 1; i < chain.length; i += 1) {
      const prev = chain[i - 1];
      const cur = chain[i];
      if (payload[prev] > payload[cur]) errors.push(`단조성 위반: ${prev}(${payload[prev]}) > ${cur}(${payload[cur]})`);
    }
    // 치환 — 최상위 문자열 값만, 뒤에서부터(앞 자리가 밀리지 않게).
    const targets = scan.values.filter((v) => PLACEHOLDER_KEYS.includes(v.key) && v.kind === 'string').sort((x, y) => y.start - x.start);
    for (const v of targets) {
      normalizedText = `${normalizedText.slice(0, v.start)}"<${v.key}>"${normalizedText.slice(v.end)}`;
      blinded += 1;
    }
  }
  if (parsedName) blinded += 2;

  return {
    ok: errors.length === 0,
    errors,
    keys: scan ? scan.keys : [],
    articleId: parsedName ? parsedName.articleId : null,
    stamp: parsedName ? parsedName.stamp : null,
    normalizedName: '<articleId>_<stamp>.json',
    normalizedText,
    blinded,
  };
}

// --- 시나리오 계획(입력은 한 번 만들어 두 서버에 **같은 값**으로 재생한다) ---

const END_MARKER = '(끝)';

function markup(...texts) {
  return JSON.stringify({ blocks: [...texts.map((text) => ({ text })), { text: END_MARKER }] });
}

/**
 * 5축 시나리오. 기사 1건씩 순차로 만들고 송고·tick·재전송한다(짝짓기 결정성).
 * (가) 엠바고 없음 → 즉시 press+nonpress → DPS · (나) 2차만(과거) → press 즉시 → EPS → tick nonpress → DPS ·
 * (다) 1차만(과거) → DES → tick press → DPS · (라) 재전송 — sp-retry 자리에 일반 파일을 놓아 mkdir 을 막고 송고 →
 * spool-write-failed → 파일 제거 → retry → 파일 생성 · (마) 이스케이프 축 표본 + 비어 있지 않은 internalComment → DPS.
 * @param {number} nowMs 계획 시각(엠바고 과거 시각의 기준)
 */
export function buildScenarioPlan(nowMs) {
  const hourAgo = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const halfHourAgo = new Date(nowMs - 30 * 60 * 1000).toISOString();
  const hostile = 'ESC:\u001b VT:\u000b US:\u001f 한글 😀 "따옴표" \\백슬래시 \n개행 \t탭 <>&/ 줄분리:\u2028 DEL:\u007f 끝';
  return {
    targets: [
      { name: 'press-target', kind: 'press', spoolDir: SPOOL_FOLDERS.press },
      { name: 'nonpress-target', kind: 'nonpress', spoolDir: SPOOL_FOLDERS.nonpress },
    ],
    retryTarget: { name: 'retry-target', kind: 'press', spoolDir: SPOOL_FOLDERS.retry },
    steps: [
      {
        id: 'ga', label: '(가) 엠바고 없음 → 즉시 배부 DPS',
        body: { title: '일반 기사 (가)', markupVersion: markup('엠바고 없는 본문.'), category: 'politics', keyword: '가,나', externalComment: '외부 코멘트 가', internalComment: '내부 코멘트 가' },
        afterSend: 'DPS', settled: 'DPS', tickKinds: null, retry: false, roundTrip: [],
      },
      {
        id: 'na', label: '(나) 2차 엠바고만(과거) → press 즉시 EPS → tick nonpress → DPS',
        body: { title: '2차 엠바고 기사 (나)', markupVersion: markup('2차 엠바고 본문.'), secondEmbargoAt: halfHourAgo, coAuthor: '공동' },
        afterSend: 'DES', settled: 'EPS', tickKinds: ['nonpress'], retry: false, roundTrip: [],
      },
      {
        id: 'da', label: '(다) 1차 엠바고(과거) → DES → tick press → DPS',
        body: { title: '1차 엠바고 기사 (다)', markupVersion: markup('1차 엠바고 본문.'), embargoAt: hourAgo, region: 'seoul', attribute: 'attr' },
        afterSend: 'DES', settled: null, tickKinds: ['press'], retry: false, roundTrip: [],
      },
      {
        id: 'ra', label: '(라) 재전송 — sp-retry mkdir 실패 유도 → failures → retry',
        body: { title: '재전송 기사 (라)', markupVersion: markup('재전송 본문.'), keyword: '재전송' },
        afterSend: 'DPS', settled: 'DPS', tickKinds: null, retry: true, roundTrip: [],
      },
      {
        id: 'ma', label: '(마) 이스케이프 축 표본 + internalComment',
        body: {
          title: hostile,
          markupVersion: markup(`본문 ${hostile}`, '두 번째 문단 \u001a\u001c\u001d\u001e'),
          keyword: '키워드\u001a,분리\u001c',
          externalComment: '외부 \u000e\u000f 코멘트 \u001d\u001e',
          internalComment: '내부 코멘트 — 외부 수신처로 나가면 안 된다 \u001b 😀',
          category: 'society',
        },
        afterSend: 'DPS', settled: 'DPS', tickKinds: null, retry: false, roundTrip: ['title', 'keyword', 'externalComment', 'internalComment'],
      },
    ],
  };
}

/** 계획이 수신처 폴더마다 남겨야 하는 파일 수 — 재생 결과가 이것과 다르면 구현 차이 전에 시나리오를 의심하라. */
export function expectedFolderCounts(plan) {
  const counts = { [SPOOL_FOLDERS.press]: 0, [SPOOL_FOLDERS.nonpress]: 0, [SPOOL_FOLDERS.retry]: 0 };
  let retryExists = false;
  for (const step of plan.steps) {
    if (step.retry) retryExists = true;
    const press = !step.body.embargoAt; // 1차 엠바고가 없으면 송고 즉시(가·나·라·마) 또는 tick 으로(다) press 가 나간다
    const nonpress = !step.body.embargoAt && !step.body.secondEmbargoAt ? true : Boolean(step.body.secondEmbargoAt);
    const pressNow = press || step.tickKinds?.includes('press');
    if (pressNow) counts[SPOOL_FOLDERS.press] += 1;
    if (pressNow && retryExists) counts[SPOOL_FOLDERS.retry] += 1;
    if (nonpress) counts[SPOOL_FOLDERS.nonpress] += 1;
  }
  return counts;
}

/** { 순번: articleId } → { articleId: 순번 } (재생기가 양쪽 각각 만든다). */
export function stepsByArticle(articlesByStep) {
  const out = {};
  for (const [step, articleId] of Object.entries(articlesByStep ?? {})) {
    if (typeof articleId === 'string' && articleId !== '') out[articleId] = step;
  }
  return out;
}

// --- 비교 ---

function groupSide(sideInput, label, failures) {
  const groups = new Map(); // `${folder}/${step}` → [{ folder, name, norm }]
  const folders = new Map(); // folder → count
  let blinded = 0;
  let count = 0;
  for (const file of sideInput.files ?? []) {
    count += 1;
    folders.set(file.folder, (folders.get(file.folder) ?? 0) + 1);
    const norm = normalizeFile(file.name, file.text);
    for (const err of norm.errors) failures.push(`[${label}] ${file.folder}/${file.name}: ${err}`);
    blinded += norm.blinded;
    if (!norm.articleId) continue;
    const step = sideInput.steps?.[norm.articleId];
    if (!step) {
      failures.push(`[${label}] ${file.folder}/${file.name}: 시나리오 순번 표에 없는 articleId 다 — 이 서버가 만든 기사가 아니거나 두 서버가 같은 스풀 루트를 쓴다`);
      continue;
    }
    const key = `${file.folder}/${step}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ folder: file.folder, name: file.name, norm });
  }
  // 같은 (폴더, 순번)에 파일이 둘 이상이면 같은 기사의 연속 쓰기다 — 그 안의 순서만 stamp 로 정한다(서버 안의 쓰기 순서).
  for (const list of groups.values()) list.sort((x, y) => (x.norm.stamp < y.norm.stamp ? -1 : x.norm.stamp > y.norm.stamp ? 1 : 0));
  return { groups, folders, blinded, count };
}

function firstDiffOffset(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function snippet(buf, at) {
  const start = Math.max(0, at - 24);
  return JSON.stringify(buf.subarray(start, Math.min(buf.length, at + 40)).toString('utf8'));
}

/**
 * @param {{ label: string, files: Array<{folder:string,name:string,text:string}>, steps: Record<string,string> }} a
 * @param {{ label: string, files: Array<{folder:string,name:string,text:string}>, steps: Record<string,string> }} b
 * @returns {{ ok: boolean, failures: string[], diffs: Array<object>, fileCount: number, folderCount: number,
 *            blinded: { a: number, b: number }, counts: { a: Record<string,number>, b: Record<string,number> } }}
 */
export function compareSpools(a, b) {
  const failures = [];
  const labelA = a.label ?? 'A';
  const labelB = b.label ?? 'B';
  const sa = groupSide(a, labelA, failures);
  const sb = groupSide(b, labelB, failures);
  const countsA = Object.fromEntries([...sa.folders.entries()].sort());
  const countsB = Object.fromEntries([...sb.folders.entries()].sort());
  const result = {
    ok: false, failures, diffs: [], fileCount: 0, folderCount: 0,
    blinded: { a: sa.blinded, b: sb.blinded }, counts: { a: countsA, b: countsB },
  };

  const foldersA = Object.keys(countsA);
  const foldersB = Object.keys(countsB);
  if (JSON.stringify(foldersA) !== JSON.stringify(foldersB)) {
    failures.push(`수신처 폴더 집합이 다르다: ${labelA}=${JSON.stringify(foldersA)} ${labelB}=${JSON.stringify(foldersB)}`);
  }
  if (sa.count !== sb.count) {
    failures.push(`파일 수가 다르다(즉시 실패 — 바이트 비교 전): ${labelA}=${sa.count} ${labelB}=${sb.count} · 폴더별 ${labelA}=${JSON.stringify(countsA)} ${labelB}=${JSON.stringify(countsB)}`);
  } else {
    for (const folder of foldersA) {
      if (countsA[folder] !== countsB[folder]) failures.push(`폴더 ${folder} 의 파일 수가 다르다: ${labelA}=${countsA[folder]} ${labelB}=${countsB[folder] ?? 0}`);
    }
  }
  if (failures.length > 0) return result;

  const keys = [...new Set([...sa.groups.keys(), ...sb.groups.keys()])].sort();
  for (const key of keys) {
    const ga = sa.groups.get(key) ?? [];
    const gb = sb.groups.get(key) ?? [];
    if (ga.length !== gb.length) {
      failures.push(`(폴더, 순번)=${key} 에 한쪽만 파일이 있거나 수가 다르다: ${labelA}=${ga.length} ${labelB}=${gb.length}`);
      continue;
    }
    for (let i = 0; i < ga.length; i += 1) {
      const bytesA = Buffer.from(ga[i].norm.normalizedText, 'utf8');
      const bytesB = Buffer.from(gb[i].norm.normalizedText, 'utf8');
      result.fileCount += 1;
      const at = firstDiffOffset(bytesA, bytesB);
      if (ga[i].norm.normalizedName !== gb[i].norm.normalizedName) {
        result.diffs.push({ key, ordinal: i, field: 'name', a: ga[i].norm.normalizedName, b: gb[i].norm.normalizedName });
      }
      if (at >= 0) {
        result.diffs.push({
          key, ordinal: i, field: 'bytes', offset: at, lengthA: bytesA.length, lengthB: bytesB.length,
          a: snippet(bytesA, at), b: snippet(bytesB, at),
          keysA: ga[i].norm.keys, keysB: gb[i].norm.keys,
        });
      }
    }
  }
  result.folderCount = foldersA.length;
  result.ok = failures.length === 0 && result.diffs.length === 0;
  return result;
}

export function formatSummary(result, labelA = 'node', labelB = 'spring') {
  return `spool-parity A=${labelA} B=${labelB} 폴더 ${result.folderCount} · 파일 ${result.fileCount} · diffs ${result.diffs.length}`
    + ` · 눈감은 자리 A=${result.blinded.a} B=${result.blinded.b} → ${result.ok ? 'ok' : 'FAILED'}`;
}

export function formatDiffLines(result) {
  const lines = [];
  for (const d of result.diffs) {
    if (d.field === 'name') lines.push(`DIFF ${d.key}#${d.ordinal} name: A=${d.a} B=${d.b}`);
    else {
      lines.push(`DIFF ${d.key}#${d.ordinal} bytes@${d.offset} (len A=${d.lengthA} B=${d.lengthB}): A=${d.a} B=${d.b}`);
      if (JSON.stringify(d.keysA) !== JSON.stringify(d.keysB)) {
        const onlyA = d.keysA.filter((k) => !d.keysB.includes(k));
        const onlyB = d.keysB.filter((k) => !d.keysA.includes(k));
        lines.push(`     keys A=[${d.keysA.join(',')}]`);
        lines.push(`     keys B=[${d.keysB.join(',')}]${onlyA.length ? ` only-in-A=[${onlyA.join(',')}]` : ''}${onlyB.length ? ` only-in-B=[${onlyB.join(',')}]` : ''}`);
      }
    }
  }
  return lines;
}
