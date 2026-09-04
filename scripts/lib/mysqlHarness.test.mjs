// scripts/lib/mysqlHarness.mjs 의 순수 판정부 단위 테스트 (phase 75 step7).
//
// 왜 여기에 있고 npm test 가 돌지 않는가:
//   package.json 은 무수정 목록이고 `npm test` 는 "test/**/*.test.js" 만 훑는다(1328건 고정).
//   그리고 scripts/spring-contract.mjs 는 import 시점에 main() 을 실행하므로 그 파일에서 함수를
//   가져다 시험할 수 없다(contract-run.mjs 를 import 하지 않는 이유와 같다).
//   ⇒ 이름 규약·URL 조립·자격 판정·비밀 가리기 같은 **순수 판정**만 이 모듈로 빼서 여기서 잠근다.
//
// 실행: node --test scripts/lib/mysqlHarness.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CT_KEY_SET,
  PASS_KEY_SET,
  EPHEMERAL_DB_NAME,
  MIN_REDACTED_LENGTH,
  MIN_PASSWORD_LENGTH,
  ephemeralDbName,
  requireEphemeralDbName,
  urlForDatabase,
  missingMysqlKeys,
  readMysqlCredentials,
  migratorChildEnv,
  springMysqlEnv,
  SPRING_DB_KEYS,
  redactSecrets,
} from './mysqlHarness.mjs';

const CREDENTIALS = {
  url: 'jdbc:mysql://127.0.0.1:3306/?useSSL=false&allowPublicKeyRetrieval=true',
  username: 'news_ct',
  password: 'p@ss w0rd',
};

// --- 이름 규약 (마이그레이터 EphemeralDatabase.EPHEMERAL_NAME 과 같은 형태여야 한다) ---

test('ephemeralDbName 은 규약을 만족하고 호출마다 다르다', () => {
  const a = ephemeralDbName();
  const b = ephemeralDbName();
  assert.match(a, EPHEMERAL_DB_NAME);
  assert.match(b, EPHEMERAL_DB_NAME);
  assert.notEqual(a, b);
});

test('규약 밖 이름은 만들지도 지우지도 않는다', () => {
  for (const bad of [
    null, '', 'news', 'news_stage', 'harness_ct_', 'harness_ct_0123456789abcde',
    'harness_ct_0123456789abcdef0', 'harness_ct_0123456789ABCDEF',
    'harness_ct_0123456789abcdef; DROP DATABASE news', 'harness_ct_0123456789abcdeg',
    ' harness_ct_0123456789abcdef', 'xharness_ct_0123456789abcdef',
  ]) {
    assert.throws(() => requireEphemeralDbName(bad), /임시 DB 규약/, `통과하면 안 된다: ${bad}`);
  }
});

test('규약을 만족하는 이름은 그대로 돌려준다', () => {
  assert.equal(requireEphemeralDbName('harness_ct_0123456789abcdef'), 'harness_ct_0123456789abcdef');
});

// --- URL 조립 (틀리면 측정이 엉뚱한 DB 에서 돈다) ---

test('urlForDatabase 는 경로만 바꾸고 질의 문자열을 보존한다', () => {
  assert.equal(
    urlForDatabase('jdbc:mysql://127.0.0.1:3306/?useSSL=false&x=1', 'harness_ct_0123456789abcdef'),
    'jdbc:mysql://127.0.0.1:3306/harness_ct_0123456789abcdef?useSSL=false&x=1',
  );
  assert.equal(
    urlForDatabase('jdbc:mysql://127.0.0.1:3306/news_stage?useSSL=false', 'harness_ct_0123456789abcdef'),
    'jdbc:mysql://127.0.0.1:3306/harness_ct_0123456789abcdef?useSSL=false',
  );
  assert.equal(
    urlForDatabase('jdbc:mysql://127.0.0.1:3306', 'harness_ct_0123456789abcdef'),
    'jdbc:mysql://127.0.0.1:3306/harness_ct_0123456789abcdef',
  );
});

test('urlForDatabase 는 규약 밖 이름도 형태 불명 URL 도 거부한다', () => {
  assert.throws(() => urlForDatabase('jdbc:mysql://h:3306/', 'news'), /임시 DB 규약/);
  assert.throws(() => urlForDatabase('127.0.0.1:3306/x', 'harness_ct_0123456789abcdef'), /접속 URL 형태/);
});

// --- 자격 판정 (조용한 sqlite 폴백 금지) ---

test('missingMysqlKeys 는 빠진 키를 순서대로 지목한다', () => {
  assert.deepEqual(missingMysqlKeys({}), [
    `${CT_KEY_SET}_URL`, `${CT_KEY_SET}_USERNAME`, `${CT_KEY_SET}_PASSWORD`,
  ]);
  assert.deepEqual(missingMysqlKeys({
    [`${CT_KEY_SET}_URL`]: 'jdbc:mysql://h/', [`${CT_KEY_SET}_USERNAME`]: '   ',
    [`${CT_KEY_SET}_PASSWORD`]: 'x',
  }), [`${CT_KEY_SET}_USERNAME`]);
  assert.deepEqual(missingMysqlKeys({
    [`${CT_KEY_SET}_URL`]: 'jdbc:mysql://h/', [`${CT_KEY_SET}_USERNAME`]: 'u',
    [`${CT_KEY_SET}_PASSWORD`]: 'p',
  }), []);
});

test('readMysqlCredentials 는 값을 다듬어 돌려주고 없으면 던진다', () => {
  const creds = readMysqlCredentials({
    [`${CT_KEY_SET}_URL`]: ' jdbc:mysql://h:3306/ ',
    [`${CT_KEY_SET}_USERNAME`]: ' news_ct ',
    [`${CT_KEY_SET}_PASSWORD`]: ' pw ',
  });
  assert.equal(creds.url, 'jdbc:mysql://h:3306/');
  assert.equal(creds.username, 'news_ct');
  assert.equal(creds.password, ' pw '); // 비밀번호는 다듬지 않는다(공백도 값이다).
  assert.throws(() => readMysqlCredentials({}), new RegExp(`${CT_KEY_SET}_URL`));
});

// --- 비밀 길이 하한 (양방향으로 닫는다) ---
//
// 이 축은 두 개의 서로 다른 하한을 가진다. 하나로 뭉치면 반드시 한쪽이 깨진다.
//   ① MIN_REDACTED_LENGTH — **가릴 수 있는가**의 하한. 이보다 짧으면 redactSecrets 가 지우지 못하고,
//      종전에는 그 사실을 **아무에게도 알리지 않고** 건너뛰었다(조용히 꺼지는 보안 통제).
//      이제 그런 값은 아예 실행 전에 거부한다 — 가릴 수 없는 비밀로는 하네스를 돌리지 않는다.
//   ② MIN_PASSWORD_LENGTH — **정책** 하한(docs/ops-mysql.md §3). 짧은 비밀은 가릴 수는 있어도
//      우연히 자식 출력(md5·16진수 DB 이름)에 나타나 **거짓 leak FAIL** 을 만든다. 그래서 거부가
//      아니라 경고로 알리고 실행은 계속한다 — 게이트를 멈추는 것과 위생을 알리는 것은 다른 일이다.

const ENV_WITH_PASSWORD = (password) => ({
  [`${CT_KEY_SET}_URL`]: 'jdbc:mysql://127.0.0.1:3306/',
  [`${CT_KEY_SET}_USERNAME`]: 'news_ct',
  [`${CT_KEY_SET}_PASSWORD`]: password,
});

test('두 하한은 서로 다른 것을 재고 정책 하한이 더 크다', () => {
  assert.ok(MIN_PASSWORD_LENGTH > MIN_REDACTED_LENGTH,
    '정책 하한이 가림 하한보다 작거나 같으면 경고 구간이 사라진다');
  assert.ok(MIN_PASSWORD_LENGTH >= 8, '정책 하한은 8자 이상이다');
});

test('readMysqlCredentials 는 가릴 수 없을 만큼 짧은 비밀번호로는 아예 돌지 않는다', () => {
  for (let length = 1; length < MIN_REDACTED_LENGTH; length += 1) {
    const password = 'z'.repeat(length);
    assert.throws(() => readMysqlCredentials(ENV_WITH_PASSWORD(password)),
      new RegExp(`${CT_KEY_SET}_PASSWORD`), `통과하면 안 된다(길이 ${length})`);
  }
});

test('거부 메시지에 비밀 값도 그 길이도 실리지 않는다', () => {
  assert.throws(() => readMysqlCredentials(ENV_WITH_PASSWORD('q7')), (err) => {
    assert.ok(!err.message.includes('q7'), `값이 실렸다: ${err.message}`);
    assert.match(err.message, new RegExp(String(MIN_PASSWORD_LENGTH)), '무엇을 만족해야 하는지 알려야 한다');
    assert.match(err.message, /ops-mysql/, '어디를 보라고 알려야 한다');
    return true;
  });
});

test('정책 하한 미만이면 경고를 달고 통과시킨다(실행을 막지 않는다)', () => {
  const creds = readMysqlCredentials(ENV_WITH_PASSWORD('a1b2'));

  assert.equal(creds.password, 'a1b2');
  assert.equal(creds.warnings.length, 1);
  assert.ok(!creds.warnings[0].includes('a1b2'), `경고에 값이 실렸다: ${creds.warnings[0]}`);
  assert.match(creds.warnings[0], new RegExp(String(MIN_PASSWORD_LENGTH)));
  assert.match(creds.warnings[0], /ops-mysql/);
});

test('정책 하한 이상이면 경고가 없다', () => {
  assert.deepEqual(readMysqlCredentials(ENV_WITH_PASSWORD('p@ss w0rd!')).warnings, []);
});

// --- 자식 env 는 명시 대입만 (부모 env 통째 상속 금지 · NEWS_DB_* 유입 금지) ---

test('migratorChildEnv 는 필요한 키만 얹고 다른 키를 만들지 않는다', () => {
  const base = { SystemRoot: 'C:/Windows' };
  const env = migratorChildEnv(base, CREDENTIALS, 'jdbc:mysql://127.0.0.1:3306/harness_ct_0123456789abcdef');
  assert.deepEqual(Object.keys(env).sort(), [
    `${CT_KEY_SET}_PASSWORD`, `${CT_KEY_SET}_URL`, `${CT_KEY_SET}_USERNAME`,
    `${PASS_KEY_SET}_PASSWORD`, `${PASS_KEY_SET}_URL`, `${PASS_KEY_SET}_USERNAME`,
    'SystemRoot',
  ].sort());
  assert.equal(env[`${CT_KEY_SET}_URL`], CREDENTIALS.url); // 서버 자리(임시 DB 생성·삭제용)
  assert.equal(env[`${PASS_KEY_SET}_URL`], 'jdbc:mysql://127.0.0.1:3306/harness_ct_0123456789abcdef');
  assert.equal(env.NEWS_DB_URL, undefined);
  assert.notEqual(env, base); // 원본을 더럽히지 않는다
  assert.deepEqual(Object.keys(base), ['SystemRoot']);
});

test('migratorChildEnv 는 패스 URL 없이도 부를 수 있다(임시 DB 생성·삭제 전용)', () => {
  const env = migratorChildEnv({}, CREDENTIALS, null);
  assert.deepEqual(Object.keys(env).sort(), [
    `${CT_KEY_SET}_PASSWORD`, `${CT_KEY_SET}_URL`, `${CT_KEY_SET}_USERNAME`,
  ].sort());
});

test('springMysqlEnv 는 DB_KIND 를 명시하고 그 패스의 DB 를 가리킨다', () => {
  const passUrl = 'jdbc:mysql://127.0.0.1:3306/harness_ct_0123456789abcdef?useSSL=false';
  const env = springMysqlEnv(CREDENTIALS, passUrl);
  assert.deepEqual(Object.keys(env).sort(), [
    SPRING_DB_KEYS.kind, SPRING_DB_KEYS.url, SPRING_DB_KEYS.username, SPRING_DB_KEYS.password,
  ].sort());
  assert.equal(env[SPRING_DB_KEYS.kind], 'mysql'); // 빼면 kind/URL 모순으로 기동 거부다(M1a)
  assert.equal(env[SPRING_DB_KEYS.url], passUrl); // 고정 URL 이면 dual-run 두 패스가 DB 를 공유한다
  assert.equal(env[SPRING_DB_KEYS.username], CREDENTIALS.username);
  assert.equal(env[SPRING_DB_KEYS.password], CREDENTIALS.password);
});

test('springMysqlEnv 는 패스 URL 없이는 만들지 않는다', () => {
  assert.throws(() => springMysqlEnv(CREDENTIALS, ''), /패스 전용 URL/);
});

// --- 비밀 가리기 (M7: 자식이 비밀을 찍으면 하네스 출력으로 나가지 않는다) ---

test('redactSecrets 는 값을 지우고 몇 번 지웠는지 센다', () => {
  const r = redactSecrets('user=news_ct pw=p@ss w0rd again p@ss w0rd', [CREDENTIALS.password]);
  assert.equal(r.hits, 2);
  assert.equal(r.text, 'user=news_ct pw=<redacted> again <redacted>');
  assert.ok(!r.text.includes(CREDENTIALS.password));
});

test('redactSecrets 는 비밀이 없으면 원문 그대로다', () => {
  const r = redactSecrets('아무 일도 없다', [CREDENTIALS.password]);
  assert.equal(r.hits, 0);
  assert.equal(r.text, '아무 일도 없다');
});

test('redactSecrets 는 가릴 수 없는 짧은 비밀을 조용히 건너뛰지 않고 센다', () => {
  // 종전에는 그냥 continue 였다 — 가리지도, 알리지도 않는 상태가 조용히 만들어졌다.
  // 지우지 않는 것 자체는 옳다(짧은 토막을 지우면 오탐으로 진단 출력을 통째로 뭉갠다).
  // 옳지 않은 것은 **아무도 모르게** 그렇게 되는 것이다.
  const short = 'a'.repeat(MIN_REDACTED_LENGTH - 1);
  const r = redactSecrets(`x${short}y`, [short, '', null, undefined]);
  assert.equal(r.hits, 0);
  assert.equal(r.text, `x${short}y`);
  assert.equal(r.unredactable, 1, '빈 값·null 은 비밀이 아니므로 세지 않고, 짧은 비밀만 센다');
});

test('redactSecrets 는 가릴 수 있는 비밀에는 unredactable 을 세지 않는다', () => {
  assert.equal(redactSecrets('pw=p@ss w0rd', [CREDENTIALS.password]).unredactable, 0);
  assert.equal(redactSecrets('아무 일도 없다', [CREDENTIALS.password]).unredactable, 0);
});

test('redactSecrets 는 정규식 특수문자가 든 비밀도 문자 그대로 지운다', () => {
  const r = redactSecrets('pw=a.b*c$', ['a.b*c$']);
  assert.equal(r.hits, 1);
  assert.equal(r.text, 'pw=<redacted>');
  assert.equal(redactSecrets('pw=axbyc$', ['a.b*c$']).hits, 0); // 정규식으로 해석되지 않는다
});
