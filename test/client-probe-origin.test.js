// 프로브 최종 origin 승격 (phase 66 step4) — 302 리다이렉트를 추종한 프로브가 최종 도달 URL을
// 읽지 않아 실제 접속처와 다른 주소가 저장되던 하자(감사 E)의 잠금.
// 판정은 client/lib/serverUrl.js의 resolveFinalOrigin 순수 함수(Electron·네트워크 비의존),
// 결선(client/main.js)은 단위화 불가 결선 파일이라 텍스트 스캔으로 잠근다(권한 정책 결선 잠금 전례 동형).
// 재작업(코드리뷰 반려): Electron 43의 net.fetch는 번들이 응답을 재조립해 응답 객체 url이 항상 빈
//   문자열이다(리뷰어 실기 실측) — 관측은 net.request의 redirect 이벤트가 유일한 경로라 (ii)를 그 구조로
//   잠근다. 실기 재실증은 스크래치패드 Electron 러너(성공 승격·실패 keep·하향 keep)가 담당한다.
// CRITICAL: 이 스캔은 코드·주석을 구분하지 않는다 — (iii)의 needle 표현식을 main.js 주석에 쓰면
//   즉시 red가 된다(phase 65 실증). red가 나면 정규식을 풀지 말고 주석 쪽을 고쳐라.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveFinalOrigin } from '../client/lib/serverUrl.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
describe('resolveFinalOrigin — 승격(최종 URL의 origin 채택)', () => {
  test('다른 호스트로 리다이렉트된 최종 URL → 승격 + changed 참(경로·쿼리·해시는 버린다)', () => {
    assert.deepEqual(
      resolveFinalOrigin({ requestedOrigin: 'http://a:3001', responseUrl: 'http://b:4000/api/health?x=1#top' }),
      { origin: 'http://b:4000', changed: true },
    );
  });

  test('포트만 다른 최종 URL → 승격 + changed 참', () => {
    assert.deepEqual(
      resolveFinalOrigin({ requestedOrigin: 'http://h:3001', responseUrl: 'http://h:8080/api/health' }),
      { origin: 'http://h:8080', changed: true },
    );
  });

  test('http→https 스킴 상향 리다이렉트 → 승격 + changed 참', () => {
    assert.deepEqual(
      resolveFinalOrigin({ requestedOrigin: 'http://h:3001', responseUrl: 'https://h:3001/api/health' }),
      { origin: 'https://h:3001', changed: true },
    );
  });
});

// ---------------------------------------------------------------------------
describe('resolveFinalOrigin — 동일 origin이면 changed 거짓', () => {
  test('최종 URL이 요청 origin과 같은 경우(리다이렉트 없음 — health 경로) → changed 거짓', () => {
    assert.deepEqual(
      resolveFinalOrigin({ requestedOrigin: 'http://h:3001', responseUrl: 'http://h:3001/api/health' }),
      { origin: 'http://h:3001', changed: false },
    );
  });

  test('경로만 다른 최종 URL(같은 origin 내 리다이렉트) → changed 거짓', () => {
    assert.deepEqual(
      resolveFinalOrigin({ requestedOrigin: 'http://h:3001', responseUrl: 'http://h:3001/login.do?next=1' }),
      { origin: 'http://h:3001', changed: false },
    );
  });

  test('기본 포트 생략 표기 차이(:80·:443 명기)는 같은 origin이다 → changed 거짓', () => {
    assert.deepEqual(
      resolveFinalOrigin({ requestedOrigin: 'http://h', responseUrl: 'http://h:80/api/health' }),
      { origin: 'http://h', changed: false },
    );
    assert.deepEqual(
      resolveFinalOrigin({ requestedOrigin: 'https://h', responseUrl: 'https://h:443/api/health' }),
      { origin: 'https://h', changed: false },
    );
  });
});

// ---------------------------------------------------------------------------
describe('resolveFinalOrigin — fail-safe(요청 origin 유지 + changed 거짓)', () => {
  const REQ = 'http://h:3001';
  const KEEP = { origin: REQ, changed: false };

  test('최종 URL이 undefined·누락이면 요청 origin 유지', () => {
    assert.deepEqual(resolveFinalOrigin({ requestedOrigin: REQ, responseUrl: undefined }), KEEP);
    assert.deepEqual(resolveFinalOrigin({ requestedOrigin: REQ }), KEEP);
  });

  test('최종 URL이 문자열이 아니면 요청 origin 유지', () => {
    for (const responseUrl of [null, 123, {}, ['http://b:4000/']]) {
      assert.deepEqual(resolveFinalOrigin({ requestedOrigin: REQ, responseUrl }), KEEP, JSON.stringify(responseUrl));
    }
  });

  test('파싱 불가 문자열이면 요청 origin 유지', () => {
    for (const responseUrl of ['not a url', 'http://', '']) {
      assert.deepEqual(resolveFinalOrigin({ requestedOrigin: REQ, responseUrl }), KEEP, JSON.stringify(responseUrl));
    }
  });

  test('http/https 밖 스킴이면 요청 origin 유지(chrome-error·file·data 등)', () => {
    for (const responseUrl of ['chrome-error://chromewebdata/', 'file:///C:/x.html', 'data:text/html,x', 'ftp://h/x']) {
      assert.deepEqual(resolveFinalOrigin({ requestedOrigin: REQ, responseUrl }), KEEP, responseUrl);
    }
  });

  test('자격증명이 실린 최종 URL이면 요청 origin 유지(설정 파일 자격증명 표면 차단 — 정규화 계약 동형)', () => {
    assert.deepEqual(resolveFinalOrigin({ requestedOrigin: REQ, responseUrl: 'http://user:pass@evil:9/api/health' }), KEEP);
    assert.deepEqual(resolveFinalOrigin({ requestedOrigin: REQ, responseUrl: 'http://user@evil:9/' }), KEEP);
  });

  test('https 입력이 http 최종으로 하향되면 요청 origin 유지(사용자가 친 적 없는 평문 출처 승격 금지)', () => {
    // 승격되면 secure-origin 스위치가 평문 출처에 걸린다 — 상향(http→https)은 승격, 하향만 keep.
    assert.deepEqual(
      resolveFinalOrigin({ requestedOrigin: 'https://h:3001', responseUrl: 'http://h:3001/api/health' }),
      { origin: 'https://h:3001', changed: false },
    );
    assert.deepEqual(
      resolveFinalOrigin({ requestedOrigin: 'https://a', responseUrl: 'http://b:8080/api/health' }),
      { origin: 'https://a', changed: false },
    );
  });
});

// ---------------------------------------------------------------------------
// 결선 텍스트 잠금 — main.js는 Electron 의존 결선 파일이라 단위 테스트가 불가능하다(권한 정책 전례).
describe('main.js 결선 텍스트 잠금 — 프로브 최종 origin 승격', () => {
  const mainText = fs.readFileSync(path.join(REPO_ROOT, 'client', 'main.js'), 'utf8');
  const lines = mainText.split('\n');

  // (iii)의 needle — 이 표현식은 이 테스트 파일 안에서만 문자열로 쓴다(main.js 주석에 쓰면 즉시 red).
  const REQUESTED_ORIGIN_EXPR = 'norm.origin';

  // 구간 정의(phase 65 전례 — 모호한 스캐너 금지): "해당 핸들러 등록 줄부터 다음 핸들러 등록 줄 직전까지".
  // 구간을 못 찾으면 "검사 대상 없음"으로 조용히 통과하지 않고 실패시킨다.
  function sectionBetween(startNeedle, endNeedle) {
    const start = lines.findIndex((l) => l.includes(startNeedle));
    assert.ok(start >= 0, `구간 시작을 찾지 못했다 — 기대: "${startNeedle}"가 있는 핸들러 등록 줄`);
    const endRel = lines.slice(start + 1).findIndex((l) => l.includes(endNeedle));
    assert.ok(endRel >= 0, `구간 끝을 찾지 못했다 — 기대: "${startNeedle}" 등록 줄(${start + 1}행) 이후의 "${endNeedle}" 등록 줄`);
    const end = start + 1 + endRel;
    assert.ok(end > start, `구간이 비었다 — 시작 ${start + 1}행, 끝 ${end + 1}행`);
    return { start, end };
  }

  // 프로브 함수 본문 구간 추출 — (ii)와 동일 규칙("선언 줄부터 다음 최상위 함수 선언 직전까지"). 못 찾으면 실패.
  function probeBody() {
    const start = lines.findIndex((l) => l.includes('async function probeOrigin'));
    assert.ok(start >= 0, '프로브 함수 선언(async function probeOrigin)을 찾지 못했다');
    const endRel = lines.slice(start + 1).findIndex((l) => /^(async )?function /.test(l));
    assert.ok(endRel >= 0, '프로브 함수 다음의 최상위 함수 선언을 찾지 못했다(본문 구간 확정 불가)');
    const bodyLines = lines.slice(start, start + 1 + endRel);
    return { lines: bodyLines, text: bodyLines.join('\n'), startLine: start + 1 };
  }

  test('(i) main.js가 serverUrl 모듈에서 resolveFinalOrigin을 import한다(판정 단일 출처)', () => {
    const importLine = lines.find((l) => l.includes("from './lib/serverUrl.js'"));
    assert.ok(importLine !== undefined, "main.js에 './lib/serverUrl.js' import 줄이 있어야 한다");
    assert.ok(importLine.includes('resolveFinalOrigin'),
      `serverUrl import에 resolveFinalOrigin이 없다 — 실제 줄: "${importLine.trim()}"`);
  });

  // 관측기 본문 구간 — probeBody와 동일 규칙("선언 줄부터 다음 최상위 함수 선언 직전까지"). 못 찾으면 실패.
  function observerBody() {
    const start = lines.findIndex((l) => l.includes('function requestHealthViaNet'));
    assert.ok(start >= 0, '최종 URL 관측기 선언(function requestHealthViaNet)을 찾지 못했다 — net.fetch는 응답 url이 항상 빈 문자열이라(Electron 43 실측) 관측기 없이는 승격이 전멸한다');
    const endRel = lines.slice(start + 1).findIndex((l) => /^(async )?function /.test(l));
    assert.ok(endRel >= 0, '관측기 다음의 최상위 함수 선언을 찾지 못했다(본문 구간 확정 불가)');
    const bodyLines = lines.slice(start, start + 1 + endRel);
    return { lines: bodyLines, text: bodyLines.join('\n'), startLine: start + 1 };
  }

  test('(ii) 관측기가 redirect 이벤트의 redirectUrl을 수집·동기 followRedirect로 추종하고, 프로브가 그 최종 URL을 resolveFinalOrigin에 넘긴다', () => {
    const obs = observerBody();
    assert.ok(obs.text.includes("on('redirect'"),
      `관측기 본문(${obs.startLine}행~)에 redirect 이벤트 구독이 없다 — 최종 도달 URL을 관측할 수 없다(net.fetch의 응답 url은 항상 빈 문자열)`);
    assert.ok(obs.text.includes('redirectUrl'),
      `관측기 본문(${obs.startLine}행~)에 redirectUrl 수집이 없다 — 리다이렉트 도착지를 읽지 않으면 원 주소가 저장된다`);
    assert.ok(obs.text.includes('followRedirect()'),
      `관측기 본문(${obs.startLine}행~)에 followRedirect() 호출이 없다 — manual 모드에서 추종이 끊겨 정상 프록시 배치가 실패로 뒤집힌다`);
    const probe = probeBody();
    assert.ok(probe.text.includes('requestHealth = requestHealthViaNet'),
      `프로브 시그니처(${probe.startLine}행~)에 주입 가능한 관측기 기본값(requestHealth = requestHealthViaNet)이 없다 — seam 없이는 관측 경로를 갈아끼울 수 없다`);
    assert.ok(probe.text.includes('responseUrl: finalUrl'),
      `프로브 본문(${probe.startLine}행~)이 관측된 최종 URL(finalUrl)을 resolveFinalOrigin의 responseUrl로 넘기지 않는다`);
    assert.ok(probe.text.includes('resolveFinalOrigin('),
      `프로브 본문(${probe.startLine}행~)에 resolveFinalOrigin( 호출이 없다 — 승격 판정은 순수 모듈 단일 출처다`);
  });

  test('(iii) 두 IPC 핸들러는 프로브 호출 줄 이후로 요청 origin 표현식을 다시 쓰지 않는다(승격값만 소비)', () => {
    for (const [startNeedle, endNeedle] of [
      ["handleGuarded('probeServer'", "handleGuarded('saveServer'"],
      ["handleGuarded('saveServer'", "handleGuarded('getState'"],
    ]) {
      const { start, end } = sectionBetween(startNeedle, endNeedle);
      const section = lines.slice(start, end);
      const callRel = section.findIndex((l) => l.includes('probeOrigin('));
      assert.ok(callRel >= 0, `${startNeedle} 구간(${start + 1}~${end}행)에서 프로브 호출 줄(probeOrigin()을 찾지 못했다`);
      const offenders = [];
      for (let i = callRel + 1; i < section.length; i += 1) {
        if (section[i].includes(REQUESTED_ORIGIN_EXPR)) offenders.push({ line: start + i + 1, text: section[i].trim() });
      }
      assert.equal(offenders.length, 0,
        `${startNeedle} 구간에서 프로브 호출 이후 요청 origin 표현식(${REQUESTED_ORIGIN_EXPR})이 발견됐다 — `
        + '응답·저장·창 생성·재시작 판정은 전부 프로브가 돌려준 최종 origin만 소비해야 한다. 발견 위치: '
        + offenders.map((o) => `${o.line}행 "${o.text}"`).join(' | '));
    }
  });

  // (iv)·(v)는 ④ 테스트 게이트 보강(phase 66) — 변이 검증에서 "실패 시에도 승격" 변이가 (i)~(iii)을 전부
  // 통과함이 실증돼 추가했다. fail-safe 게이트는 순수 함수가 아니라 결선(프로브 본문)에만 있으므로
  // (serverUrl.js 계약 주석: "성공/실패 판정은 여기 없다") 결선 텍스트 잠금이 없으면 무방비다.
  test('(iv) 승격은 성공 판정(verdict.ok)일 때만 — 실패 경로는 요청 origin 유지(fail-safe 결선 잠금)', () => {
    const { text, startLine } = probeBody();
    assert.match(text, /verdict\.ok\s*\?\s*resolveFinalOrigin\(/,
      `프로브 본문(${startLine}행~)에서 resolveFinalOrigin 호출이 verdict.ok 조건 뒤에 있지 않다 — `
      + '오류 페이지·캡티브 포털로의 리다이렉트가 저장 주소를 바꾸면 접속 불능이 영구화된다(승격은 성공 판정일 때만)');
    assert.match(text, /:\s*\{ origin, changed: false \}/,
      `프로브 본문(${startLine}행~)에 실패 분기의 요청 origin 유지({ origin, changed: false })가 없다 — `
      + '실패 시 미승격 fail-safe(ADR-011)가 결선에서 사라졌다');
  });

  test('(v) probe 진단 페이로드는 승격 결과 origin 문자열·boolean만 싣는다 — 응답 URL 원문 미기록', () => {
    const body = probeBody();
    // 검사 구간: 페이로드 구성 줄부터 diag.log('probe') 기록 줄까지 — 못 찾으면 실패(조용한 통과 금지).
    const payloadRel = body.lines.findIndex((l) => l.includes('const payload ='));
    assert.ok(payloadRel >= 0, '프로브 본문에서 진단 페이로드 구성 줄(const payload =)을 찾지 못했다');
    const logRel = body.lines.findIndex((l) => l.includes("diag.log('probe'"));
    assert.ok(logRel > payloadRel, "프로브 본문에서 페이로드 구성 이후의 diag.log('probe') 기록 줄을 찾지 못했다");
    const sectionText = body.lines.slice(payloadRel, logRel + 1).join('\n');
    assert.ok(sectionText.includes('finalOrigin: resolved.origin'),
      '진단 페이로드에 승격 결과 origin(finalOrigin: resolved.origin)이 없다 — 승격 관측이 진단에서 사라진다');
    assert.ok(sectionText.includes('promoted: resolved.changed'),
      '진단 페이로드에 승격 여부 boolean(promoted: resolved.changed)이 없다');
    for (const rawNeedle of ['finalUrl', 'res.url', 'responseUrl']) {
      assert.ok(!sectionText.includes(rawNeedle),
        `진단 페이로드 구간에 응답 URL 원문 표현식(${rawNeedle})이 발견됐다 — origin류 키는 diag.js 축약기를 `
        + '타지 않으므로(키에 url 미포함) 원문 URL(경로·쿼리 포함 가능)을 진단 파일에 남기면 안 된다');
    }
  });
});
