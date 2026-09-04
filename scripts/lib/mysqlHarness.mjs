// 계약 하네스의 MySQL 모드(`--db mysql`) 순수 판정부 — phase 75 step7.
//
// 왜 별도 모듈인가: scripts/spring-contract.mjs 는 import 시점에 main() 을 실행하므로(contract-run.mjs 와
// 같은 이유로) 그 안의 함수를 가져다 시험할 수 없다. 이름 규약·URL 조립·자격 판정·비밀 가리기는
// **틀리면 조용히 엉뚱한 DB 를 지우거나 비밀을 흘리는** 종류의 코드라 DB 없이 잠글 수 있어야 한다.
// 잠금은 scripts/lib/mysqlHarness.test.mjs 가 한다(`node --test scripts/lib/mysqlHarness.test.mjs`).
// 부수효과(spawn·fs·env 읽기)는 여기 두지 않는다 — 전부 호출자(spring-contract.mjs)의 몫이다.
//
// CRITICAL: 이 파일의 어떤 함수도 비밀번호를 로그·리포트·예외 메시지에 싣지 않는다.
//   진단에 실을 수 있는 것은 **키 이름·DB 이름·URL(자격이 박히지 않은 것)** 뿐이다.

import crypto from 'node:crypto';

/** 하네스가 쓰는 자격의 환경변수 키 집합 — 값의 출처는 리포 밖 env 파일 하나다(docs/ops-mysql.md §3). */
export const CT_KEY_SET = 'NEWS_CT_MYSQL';

/**
 * 마이그레이터에게 "이번 패스의 DB"를 가리켜 주는 키 집합.
 * CT_KEY_SET 의 URL 은 **서버까지만** 가리키므로(임시 DB 를 스스로 만든다) 적재 대상은 별도 이름으로 준다 —
 * 같은 키 이름이 호출마다 다른 DB 를 뜻하면 사람이 읽을 수 없다.
 */
export const PASS_KEY_SET = 'NEWS_CT_PASS';

/** 키 순서는 고정이다(진단 메시지가 흔들리지 않게). */
export const CT_KEYS = [`${CT_KEY_SET}_URL`, `${CT_KEY_SET}_USERNAME`, `${CT_KEY_SET}_PASSWORD`];

/**
 * 만들고 버리는 것이 허용되는 **유일한** DB 이름 형태.
 * 마이그레이터의 EphemeralDatabase.EPHEMERAL_NAME · 서버 테스트의 EphemeralMysqlDb.EPHEMERAL_NAME 과
 * **같은 형태**여야 한다(이중 가드 — 한쪽이 뚫려도 다른 쪽이 막고, 그 위에 news_ct 의 grant 경계가 있다).
 */
export const EPHEMERAL_DB_NAME = /^harness_ct_[0-9a-f]{16}$/;

/** 이름 접두사 — 부트스트랩의 GRANT 패턴(`harness\_ct\_%`)과 같은 문자열이어야 한다. */
export const EPHEMERAL_PREFIX = 'harness_ct_';

/** 이보다 짧은 값은 가리지 않는다 — 짧은 토막을 지우면 오탐으로 진단 출력을 통째로 뭉갠다. */
export const MIN_REDACTED_LENGTH = 4;

const SCHEME_SEPARATOR = '://';

/** 규약을 만족하는 새 임시 DB 이름(패스마다 다르다 — --dual-run 의 두 패스가 DB 를 공유하면 안 된다). */
export function ephemeralDbName() {
  return EPHEMERAL_PREFIX + crypto.randomBytes(8).toString('hex');
}

/**
 * 규약을 만족하는 이름만 통과시킨다 — **접속하기 전에** 부른다.
 * 그래야 규약 밖 이름(운영 `news`·`news_stage`)은 서버에 닿지도 못한다.
 */
export function requireEphemeralDbName(database) {
  if (typeof database !== 'string' || !EPHEMERAL_DB_NAME.test(database)) {
    throw new Error(`임시 DB 규약(${EPHEMERAL_DB_NAME.source})을 벗어난 이름은 만들지도 버리지도 않는다: ${database}`);
  }
  return database;
}

/**
 * 서버 URL 의 경로를 임시 DB 이름으로 바꾼다(질의 문자열은 보존).
 * 조립이 틀리면 측정이 **엉뚱한 DB** 에서 돈다 — 그래서 순수 함수로 두고 단위 테스트로 잠근다.
 * (server-spring 의 EphemeralMysqlDb.urlForDatabase 와 같은 규칙이다.)
 */
export function urlForDatabase(baseUrl, database) {
  requireEphemeralDbName(database);
  const url = String(baseUrl ?? '');
  const question = url.indexOf('?');
  const head = question < 0 ? url : url.slice(0, question);
  const query = question < 0 ? '' : url.slice(question);
  const scheme = head.indexOf(SCHEME_SEPARATOR);
  if (scheme < 0) throw new Error(`접속 URL 형태를 알 수 없다(${CT_KEY_SET}_URL) — 조용히 고쳐 엉뚱한 DB 를 가리키지 않는다`);
  const path = head.indexOf('/', scheme + SCHEME_SEPARATOR.length);
  const authority = path < 0 ? head : head.slice(0, path);
  return `${authority}/${database}${query}`;
}

/** 비어 있는 환경변수 키 목록(순서 고정). 값은 담지 않는다. */
export function missingMysqlKeys(env) {
  return CT_KEYS.filter((key) => {
    const value = env?.[key];
    return value === undefined || value === null || String(value).trim() === '';
  });
}

/**
 * 자격 한 벌을 읽는다. 하나라도 없으면 **던진다** — `--db mysql` 이 조용히 sqlite 로 폴백하면
 * 이 게이트가 통째로 공허해진다(계획 금지사항).
 * 비밀번호는 다듬지 않는다(앞뒤 공백도 값일 수 있다).
 */
export function readMysqlCredentials(env) {
  const missing = missingMysqlKeys(env);
  if (missing.length > 0) {
    throw new Error(`--db mysql: 접속 환경변수가 없다: ${missing.join(', ')}`
      + ' — docs/ops-mysql.md §3 절차로 리포 밖 env 파일의 NEWS_CT_MYSQL_* 만 셸에 실은 뒤 다시 실행하라.'
      + ' (sqlite 로 조용히 폴백하지 않는다.)');
  }
  return {
    url: String(env[CT_KEYS[0]]).trim(),
    username: String(env[CT_KEYS[1]]).trim(),
    password: env[CT_KEYS[2]],
  };
}

/**
 * 마이그레이터 자식의 env — **명시 대입만** 한다(부모 env 통째 상속 금지).
 * NEWS_DB_* 는 절대 만들지 않는다: 그 이름이 자식 환경에 남으면 서버 쪽 모순 거부와 얽힌다(step5 실측).
 *
 * @param base OS 허용 목록만 담긴 기본 env
 * @param credentials readMysqlCredentials 의 결과
 * @param passUrl 이번 패스 DB 를 가리키는 URL(임시 DB 생성·삭제만 할 때는 null)
 */
export function migratorChildEnv(base, credentials, passUrl) {
  const env = { ...base };
  env[CT_KEYS[0]] = credentials.url; // 서버까지만 가리킨다 = ephemeral-create/drop 의 접속 자리
  env[CT_KEYS[1]] = credentials.username;
  env[CT_KEYS[2]] = credentials.password;
  if (passUrl) {
    env[`${PASS_KEY_SET}_URL`] = passUrl; // 이번 패스 DB = migrate 의 적재 대상
    env[`${PASS_KEY_SET}_USERNAME`] = credentials.username;
    env[`${PASS_KEY_SET}_PASSWORD`] = credentials.password;
  }
  return env;
}

/**
 * Spring 이 읽는 저장소 설정 키 — 값은 여기 없고 **이름만** 있다(`app.db.*` 바인딩 · phase 75 step5).
 * 이름을 상수 표로 두는 이유는 둘이다: ① 대입을 손으로 쓰지 않으므로 리포 텍스트에 `키=값` 형태가
 * 생기지 않는다(`SecretHygieneTest` ②가 금지하는 형태이고, 그 금지는 옳다 — 값은 리포 밖에만 있다)
 * ② 서버 쪽 키 이름이 바뀌면 고칠 자리가 한 곳이다.
 */
export const SPRING_DB_KEYS = Object.freeze({
  kind: 'DB_KIND', url: 'NEWS_DB_URL', username: 'NEWS_DB_USERNAME', password: 'NEWS_DB_PASSWORD',
});

/**
 * Spring 자식에게 얹을 mysql 축 — **필요한 키만 명시 대입**한다(env 파일을 통째로 싣지 않는다).
 * `kind` 를 빼면 기본값 sqlite 와 URL 이 모순이라 서버가 **기동을 거부**한다(step5 A).
 *
 * @param passUrl 이 패스 전용 DB 를 가리키는 URL — 고정값을 쓰면 --dual-run 의 두 패스가 DB 를 공유한다
 */
export function springMysqlEnv(credentials, passUrl) {
  if (!passUrl) throw new Error('패스 전용 URL 없이 mysql 축을 만들지 않는다(두 패스가 같은 DB 를 쓰게 된다)');
  return {
    [SPRING_DB_KEYS.kind]: 'mysql',
    [SPRING_DB_KEYS.url]: passUrl,
    [SPRING_DB_KEYS.username]: credentials.username,
    [SPRING_DB_KEYS.password]: credentials.password,
  };
}

/**
 * 자식이 뱉은 글에서 비밀 값을 지운다(M7 의 답).
 * 하네스 자신은 값을 찍지 않지만 **자식의 출력은 우리 통제 밖**이다 — 진단으로 붙는 순간 파일로 남는다.
 * 정규식으로 해석하지 않고 문자 그대로 찾는다(비밀번호에 특수문자가 흔하다).
 *
 * @returns {{ text: string, hits: number }}
 */
export function redactSecrets(text, secrets) {
  let out = String(text ?? '');
  let hits = 0;
  for (const secret of secrets ?? []) {
    if (typeof secret !== 'string' || secret.length < MIN_REDACTED_LENGTH) continue;
    let index = out.indexOf(secret);
    while (index >= 0) {
      out = out.slice(0, index) + '<redacted>' + out.slice(index + secret.length);
      hits += 1;
      index = out.indexOf(secret, index + '<redacted>'.length);
    }
  }
  return { text: out, hits };
}
