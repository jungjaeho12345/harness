// exe 브랜딩 (phase 63 step1) — 아이콘 생성기(icoBuilder)·버전 메타(exeMeta) 순수 모듈을 node:test로 잠근다.
// CRITICAL: buildIcoBuffer는 결정론이다(같은 입력 → 바이트 동일) — 난수·타임스탬프가 섞이면
//   make-icon --check(커밋본 sha256 대조) 게이트가 무의미해진다. 버전은 package.json 단일 출처이고
//   루트/클라이언트 version이 갈라지면 정보 대화상자와 exe 메타가 어긋난다(동일성 잠금).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ICON_SIZES, buildIcoBuffer } from '../scripts/lib/icoBuilder.mjs';
import { toVersionQuad, buildClientVersionStrings, buildServerVersionStrings } from '../scripts/lib/exeMeta.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// AND 마스크 1bpp 행은 4바이트 정렬이다 — 이미지 바이트 수 계산의 단일 출처(테스트 측 독립 계산).
const maskRowBytes = (size) => (Math.ceil(size / 8) + 3) & ~3;
const imageBytes = (size) => 40 + size * size * 4 + maskRowBytes(size) * size;

// ---------------------------------------------------------------------------
describe('icoBuilder — ICO 컨테이너 구조', () => {
  test('기본 크기 집합은 16/32/48/64/128/256', () => {
    assert.deepEqual(DEFAULT_ICON_SIZES, [16, 32, 48, 64, 128, 256]);
  });

  test('ICONDIR 헤더: reserved=0, type=1, count=크기 수', () => {
    const buf = buildIcoBuffer();
    assert.equal(buf.readUInt16LE(0), 0);
    assert.equal(buf.readUInt16LE(2), 1);
    assert.equal(buf.readUInt16LE(4), DEFAULT_ICON_SIZES.length);
  });

  test('디렉토리 항목: width/height(256은 0)·planes=1·bitCount=32·bytesInRes·offset 연쇄', () => {
    const buf = buildIcoBuffer();
    let expectedOffset = 6 + 16 * DEFAULT_ICON_SIZES.length;
    DEFAULT_ICON_SIZES.forEach((size, i) => {
      const at = 6 + 16 * i;
      const dirByte = size === 256 ? 0 : size; // ICO 디렉토리 규약 — 256은 폭·높이 0으로 기록한다.
      assert.equal(buf.readUInt8(at), dirByte, `width[${size}]`);
      assert.equal(buf.readUInt8(at + 1), dirByte, `height[${size}]`);
      assert.equal(buf.readUInt8(at + 2), 0, `colorCount[${size}]`);
      assert.equal(buf.readUInt8(at + 3), 0, `reserved[${size}]`);
      assert.equal(buf.readUInt16LE(at + 4), 1, `planes[${size}]`);
      assert.equal(buf.readUInt16LE(at + 6), 32, `bitCount[${size}]`);
      assert.equal(buf.readUInt32LE(at + 8), imageBytes(size), `bytesInRes[${size}]`);
      assert.equal(buf.readUInt32LE(at + 12), expectedOffset, `offset[${size}]`);
      expectedOffset += imageBytes(size);
    });
    assert.equal(buf.length, expectedOffset, '총 길이 = 마지막 offset + 마지막 bytesInRes');
  });

  test('각 항목의 BITMAPINFOHEADER: biSize=40·biWidth=size·biHeight=size*2·biPlanes=1·biBitCount=32·biCompression=0', () => {
    const buf = buildIcoBuffer();
    for (let i = 0; i < DEFAULT_ICON_SIZES.length; i += 1) {
      const size = DEFAULT_ICON_SIZES[i];
      const off = buf.readUInt32LE(6 + 16 * i + 12);
      assert.equal(buf.readUInt32LE(off), 40, `biSize[${size}]`);
      assert.equal(buf.readInt32LE(off + 4), size, `biWidth[${size}]`);
      assert.equal(buf.readInt32LE(off + 8), size * 2, `biHeight[${size}] (XOR+AND)`);
      assert.equal(buf.readUInt16LE(off + 12), 1, `biPlanes[${size}]`);
      assert.equal(buf.readUInt16LE(off + 14), 32, `biBitCount[${size}]`);
      assert.equal(buf.readUInt32LE(off + 16), 0, `biCompression[${size}]`);
    }
  });

  test('그림이 실제로 그려져 있다 — 불투명 픽셀과 투명 픽셀이 공존한다(전면 0/전면 채움 방지)', () => {
    const buf = buildIcoBuffer({ sizes: [32] });
    const off = buf.readUInt32LE(6 + 16 * 0 + 12) + 40;
    let opaque = 0;
    let transparent = 0;
    const colors = new Set();
    for (let p = 0; p < 32 * 32; p += 1) {
      const a = buf.readUInt8(off + p * 4 + 3);
      if (a === 255) { opaque += 1; colors.add(buf.readUInt32LE(off + p * 4) >>> 8); } else transparent += 1;
    }
    assert.ok(opaque > 100, `불투명 픽셀 ${opaque}`);
    assert.ok(transparent > 10, `투명 픽셀 ${transparent}`);
    assert.ok(colors.size >= 2, `색상 종류 ${colors.size} — 판 + 기사 막대 최소 2색`);
  });

  test('결정론: 두 번 생성한 버퍼는 바이트 동일하다', () => {
    assert.ok(buildIcoBuffer().equals(buildIcoBuffer()));
    assert.ok(buildIcoBuffer({ sizes: [16, 48] }).equals(buildIcoBuffer({ sizes: [16, 48] })));
  });

  test('사용자 지정 크기 부분집합도 유효한 컨테이너다', () => {
    const buf = buildIcoBuffer({ sizes: [16] });
    assert.equal(buf.readUInt16LE(4), 1);
    assert.equal(buf.length, 6 + 16 + imageBytes(16));
  });

  test('커밋된 packaging/icon/app.ico는 재생성 결과와 바이트 동일하다(드리프트 잠금)', () => {
    const committed = fs.readFileSync(path.join(REPO_ROOT, 'packaging', 'icon', 'app.ico'));
    assert.ok(committed.equals(buildIcoBuffer()), '커밋본과 재생성 결과가 다르다 — node scripts/make-icon.mjs로 갱신하라');
  });
});

// ---------------------------------------------------------------------------
describe('exeMeta — 버전 quad', () => {
  test("'1.0.0' → [1,0,0,0]", () => {
    assert.deepEqual(toVersionQuad('1.0.0'), [1, 0, 0, 0]);
  });

  test("'2.14.3' → [2,14,3,0]", () => {
    assert.deepEqual(toVersionQuad('2.14.3'), [2, 14, 3, 0]);
  });

  test('형식 위반은 throw — 2조각·4조각·비숫자·빈 값·비문자열', () => {
    for (const bad of ['1.0', '1.0.0.0', '1.0.x', 'v1.0.0', '', '1..0', null, undefined, 100]) {
      assert.throws(() => toVersionQuad(bad), `${JSON.stringify(bad)}는 throw해야 한다`);
    }
  });

  test('65535 초과 조각은 throw(PE quad는 16비트다)', () => {
    assert.throws(() => toVersionQuad('70000.0.0'));
  });
});

// ---------------------------------------------------------------------------
describe('exeMeta — 버전 문자열 집합', () => {
  test('클라이언트: 제품명·회사명은 기사작성기, FileVersion은 1.0.0.0 형식, OriginalFilename은 실제 exe명', () => {
    const s = buildClientVersionStrings({ version: '1.0.0', exeName: '기사작성기.exe' });
    assert.equal(s.ProductName, '기사작성기');
    assert.equal(s.CompanyName, '기사작성기'); // Electron 기본값 'GitHub, Inc.' 잔류 금지(open (a)).
    assert.equal(s.FileVersion, '1.0.0.0');
    assert.equal(s.ProductVersion, '1.0.0.0');
    assert.equal(s.OriginalFilename, '기사작성기.exe');
    assert.ok(s.FileDescription.includes('클라이언트'), `FileDescription=${s.FileDescription}`);
    assert.ok(!Object.values(s).some((v) => String(v).includes('GitHub')), 'GitHub 문자열 잔류 금지');
  });

  test('클라이언트: ASCII 폴백 exe명도 OriginalFilename에 그대로 반영된다', () => {
    const s = buildClientVersionStrings({ version: '1.0.0', exeName: 'article-client.exe' });
    assert.equal(s.OriginalFilename, 'article-client.exe');
  });

  test('서버: FileDescription이 서버를 구분한다(클라이언트와 다른 한 줄)', () => {
    const c = buildClientVersionStrings({ version: '1.0.0', exeName: '기사작성기.exe' });
    const s = buildServerVersionStrings({ version: '1.0.0', exeName: '기사작성기-server.exe' });
    assert.equal(s.ProductName, '기사작성기');
    assert.equal(s.CompanyName, '기사작성기');
    assert.equal(s.FileVersion, '1.0.0.0');
    assert.equal(s.OriginalFilename, '기사작성기-server.exe');
    assert.ok(s.FileDescription.includes('서버'), `FileDescription=${s.FileDescription}`);
    assert.notEqual(s.FileDescription, c.FileDescription);
  });

  test('버전 형식 위반은 문자열 집합 생성도 throw다(toVersionQuad 공유)', () => {
    assert.throws(() => buildClientVersionStrings({ version: '1.0', exeName: 'x.exe' }));
    assert.throws(() => buildServerVersionStrings({ version: 'bad', exeName: 'x.exe' }));
  });
});

// ---------------------------------------------------------------------------
describe('버전 단일 출처', () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const clientPkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'client', 'package.json'), 'utf8'));

  test('루트 package.json.version === client/package.json.version (갈라지면 정보 대화상자와 exe 메타 불일치)', () => {
    assert.equal(rootPkg.version, clientPkg.version);
  });

  test('version은 toVersionQuad가 받는 3조각 형식이다', () => {
    assert.match(clientPkg.version, /^\d+\.\d+\.\d+$/);
    assert.doesNotThrow(() => toVersionQuad(clientPkg.version));
  });
});
