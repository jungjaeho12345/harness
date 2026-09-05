// 부팅 실효 서버 주소 리졸버 (phase 76 step4) — Electron·파일시스템·네트워크 비의존 순수 모듈을 node:test로 잠근다.
// 대상: client/lib/clientConfig.js의 resolveBootServerUrl(저장값 우선 · 없으면 배포 env 기본값을 기존
//   normalizeServerUrl 경로로만 적용). decisions (6): NEWS_SERVER_URL은 저장된 serverUrl이 없을 때만
//   적용되고 자격 포함·미허용 스킴은 거부(null)해 잘못된 배포값이 조용히 접속불능을 만들지 않는다.
// CRITICAL: 저장값이 있으면 env를 보지 않는다(사용자·이전 설정 우선) — 신뢰 경계·권한 모델 무변경.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBootServerUrl } from '../client/lib/clientConfig.js';

describe('resolveBootServerUrl — 저장값 우선', () => {
  test('저장값이 있으면 env가 있어도 저장값을 돌려준다', () => {
    assert.equal(
      resolveBootServerUrl({ savedServerUrl: 'http://saved.example.com:3001', envServerUrl: 'http://env.example.com:9000' }),
      'http://saved.example.com:3001',
    );
  });

  test('저장값이 있으면 env가 자격·미허용 스킴이어도 저장값을 그대로 돌려준다(env 미참조)', () => {
    assert.equal(
      resolveBootServerUrl({ savedServerUrl: 'https://news.example.com', envServerUrl: 'ftp://bad' }),
      'https://news.example.com',
    );
  });
});

describe('resolveBootServerUrl — env 기본값(저장값 없음)', () => {
  test('저장값이 없고 env가 유효하면 정규화된 origin을 돌려준다', () => {
    assert.equal(
      resolveBootServerUrl({ savedServerUrl: null, envServerUrl: '192.168.0.10:3001' }),
      'http://192.168.0.10:3001',
    );
  });

  test('env는 반드시 normalizeServerUrl을 경유한다 — 경로·쿼리·해시는 버리고 origin만', () => {
    assert.equal(
      resolveBootServerUrl({ savedServerUrl: null, envServerUrl: 'https://news.example.com/login.do?x=1' }),
      'https://news.example.com',
    );
  });
});

describe('resolveBootServerUrl — null 수렴', () => {
  test('저장값·env 둘 다 없으면 null', () => {
    assert.equal(resolveBootServerUrl({ savedServerUrl: null, envServerUrl: undefined }), null);
    assert.equal(resolveBootServerUrl({ savedServerUrl: null, envServerUrl: '' }), null);
    assert.equal(resolveBootServerUrl({}), null);
  });

  test('저장값이 없고 env에 자격(user:pass@)이 있으면 null(정규화 거부)', () => {
    assert.equal(
      resolveBootServerUrl({ savedServerUrl: null, envServerUrl: 'http://user:pass@news.example.com' }),
      null,
    );
  });

  test('저장값이 없고 env가 미허용 스킴이면 null(정규화 거부)', () => {
    assert.equal(resolveBootServerUrl({ savedServerUrl: null, envServerUrl: 'ftp://news.example.com' }), null);
    assert.equal(resolveBootServerUrl({ savedServerUrl: null, envServerUrl: 'file:///etc/passwd' }), null);
  });

  test('env가 공백·비문자열이면 null', () => {
    assert.equal(resolveBootServerUrl({ savedServerUrl: null, envServerUrl: '   ' }), null);
    assert.equal(resolveBootServerUrl({ savedServerUrl: null, envServerUrl: 123 }), null);
  });
});
