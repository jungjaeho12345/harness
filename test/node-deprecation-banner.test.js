// step5(76-server-cutover-ops): Node 은퇴 예고 배너 순수 헬퍼 테스트.
// deprecationBanner(env)는 앱 동작·응답과 무관한 순수 함수다:
//   NODE_SERVER_DEPRECATED === '1' 일 때만 배너 문자열을 돌려주고, 그 외에는 null(기본 침묵).
import test from 'node:test';
import assert from 'node:assert/strict';
import { deprecationBanner } from '../server/deprecationBanner.js';

test('NODE_SERVER_DEPRECATED=1이면 비어있지 않은 배너 문자열을 반환한다', () => {
  const banner = deprecationBanner({ NODE_SERVER_DEPRECATED: '1' });
  assert.equal(typeof banner, 'string');
  assert.ok(banner.length > 0);
});

test('배너는 정본이 Spring임을 언급한다', () => {
  const banner = deprecationBanner({ NODE_SERVER_DEPRECATED: '1' });
  assert.match(banner, /Spring/);
});

test('미설정이면 null(기본 침묵)', () => {
  assert.equal(deprecationBanner({}), null);
});

test("'0'이면 null(기본 침묵)", () => {
  assert.equal(deprecationBanner({ NODE_SERVER_DEPRECATED: '0' }), null);
});

test('기타 값(truthy 아님 판정)이면 null — 오직 정확히 \'1\'만 opt-in', () => {
  assert.equal(deprecationBanner({ NODE_SERVER_DEPRECATED: 'true' }), null);
  assert.equal(deprecationBanner({ NODE_SERVER_DEPRECATED: 'yes' }), null);
  assert.equal(deprecationBanner({ NODE_SERVER_DEPRECATED: ' 1' }), null);
});

test('undefined env를 안전하게 처리한다', () => {
  assert.equal(deprecationBanner(undefined), null);
});

test('배너에 세션·토큰·비밀번호·절대경로가 없다(로그 위생)', () => {
  const banner = deprecationBanner({ NODE_SERVER_DEPRECATED: '1' });
  assert.doesNotMatch(banner, /session|token|password|passwd|secret/i);
  // 절대경로(POSIX / Windows) 원문이 없어야 한다.
  assert.doesNotMatch(banner, /(^|\s)\//); // 선두 슬래시 경로
  assert.doesNotMatch(banner, /[A-Za-z]:\\/); // 윈도우 드라이브 경로
});
