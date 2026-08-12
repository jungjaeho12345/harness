// 임시 앱 아이콘 생성기 (phase 63 step1) — fs·전역·난수 비의존 순수 모듈. 같은 입력 → 바이트 동일(결정론).
// 전용 디자인 파일이 없어 도형만 그린다: 파란 라운드 판 + 기사 줄을 뜻하는 흰 가로 막대(제목 1 + 본문 3).
// 정식 아이콘이 생기면 packaging/icon/app.ico 파일만 교체하면 된다(빌드는 커밋된 파일만 읽는다).
// ICO 규약: ICONDIR(6B) + ICONDIRENTRY(16B×N) + [BITMAPINFOHEADER(40B, biHeight=size*2) +
//   BGRA bottom-up 픽셀 + AND 마스크(1bpp, 행 4바이트 정렬)]×N. 256 항목은 디렉토리에 폭·높이 0으로 기록.

export const DEFAULT_ICON_SIZES = [16, 32, 48, 64, 128, 256];

// 색상(RGB) — 판은 진청, 제목 막대는 밝은 하늘, 본문 막대는 흰색. 값 변경은 결정론 게이트(--check)와
// 커밋본 동시 갱신을 요구한다(테스트가 커밋본과 재생성 결과의 바이트 동일을 잠근다).
const PLATE = { r: 30, g: 90, b: 168 };
const TITLE = { r: 255, g: 214, b: 92 };
const BODY = { r: 255, g: 255, b: 255 };

const maskRowBytes = (size) => (Math.ceil(size / 8) + 3) & ~3;

// 픽셀 (x, y)의 색을 결정한다(y는 top-down 좌표) — null이면 투명.
// 모든 좌표는 size 비율로 계산해 어떤 크기에서도 같은 그림이 나온다(정수 반올림만 사용).
function pixelAt(x, y, size) {
  const margin = Math.max(1, Math.round(size / 16)); // 판 밖 여백 — 투명.
  const radius = Math.max(1, Math.round(size / 8)); // 판 모서리 라운드.
  const lo = margin;
  const hi = size - 1 - margin;
  if (x < lo || x > hi || y < lo || y > hi) return null;
  // 라운드 모서리 — 모서리 사각형 안에서는 원호 밖이면 투명.
  const cx = x < lo + radius ? lo + radius : (x > hi - radius ? hi - radius : x);
  const cy = y < lo + radius ? lo + radius : (y > hi - radius ? hi - radius : y);
  const dx = x - cx;
  const dy = y - cy;
  if (dx * dx + dy * dy > radius * radius) return null;
  // 기사 줄 막대 — 제목(굵고 짧은 노랑) 1개 + 본문(흰색) 3개.
  const bar = (x0, x1, y0, y1) => (
    x >= Math.round(x0 * size) && x < Math.round(x1 * size)
    && y >= Math.round(y0 * size) && y < Math.round(y1 * size)
  );
  if (bar(0.22, 0.62, 0.22, 0.32)) return TITLE;
  if (bar(0.22, 0.78, 0.42, 0.50)) return BODY;
  if (bar(0.22, 0.78, 0.56, 0.64)) return BODY;
  if (bar(0.22, 0.66, 0.70, 0.78)) return BODY;
  return PLATE;
}

// 한 크기의 이미지 데이터(BITMAPINFOHEADER + BGRA bottom-up + AND 마스크)를 만든다.
function buildImage(size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(size, 4); // biWidth
  header.writeInt32LE(size * 2, 8); // biHeight — XOR + AND 겹높이.
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(32, 14); // biBitCount
  header.writeUInt32LE(0, 16); // biCompression = BI_RGB
  header.writeUInt32LE(size * size * 4 + maskRowBytes(size) * size, 20); // biSizeImage

  const pixels = Buffer.alloc(size * size * 4);
  const rowBytes = maskRowBytes(size);
  const mask = Buffer.alloc(rowBytes * size); // AND 마스크 — 불투명은 0, 투명은 1.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const color = pixelAt(x, y, size);
      const row = size - 1 - y; // bottom-up.
      const at = (row * size + x) * 4;
      if (color) {
        pixels[at] = color.b;
        pixels[at + 1] = color.g;
        pixels[at + 2] = color.r;
        pixels[at + 3] = 255;
      } else {
        mask[row * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  return Buffer.concat([header, pixels, mask]);
}

// ICO 컨테이너 조립 — Buffer 반환. 난수·타임스탬프·Date 금지(결정론).
export function buildIcoBuffer({ sizes = DEFAULT_ICON_SIZES } = {}) {
  if (!Array.isArray(sizes) || sizes.length === 0
    || sizes.some((s) => !Number.isInteger(s) || s < 1 || s > 256)) {
    throw new Error(`sizes는 1~256 정수 배열이어야 한다: ${JSON.stringify(sizes)}`);
  }
  const images = sizes.map((s) => buildImage(s));
  const dir = Buffer.alloc(6 + 16 * sizes.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // type = icon
  dir.writeUInt16LE(sizes.length, 4);
  let offset = dir.length;
  sizes.forEach((size, i) => {
    const at = 6 + 16 * i;
    const dirByte = size === 256 ? 0 : size; // 256은 규약상 0으로 기록한다.
    dir.writeUInt8(dirByte, at);
    dir.writeUInt8(dirByte, at + 1);
    dir.writeUInt8(0, at + 2); // colorCount — 32bpp는 0.
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // planes
    dir.writeUInt16LE(32, at + 6); // bitCount
    dir.writeUInt32LE(images[i].length, at + 8); // bytesInRes
    dir.writeUInt32LE(offset, at + 12); // imageOffset
    offset += images[i].length;
  });
  return Buffer.concat([dir, ...images]);
}
