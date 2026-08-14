// exe 버전·문자열 메타 (phase 63 step1) — fs·전역 비의존 순수 모듈. 값의 단일 출처는 package.json이다
// (호출부가 version을 읽어 넘긴다 — 여기와 호출부 어디에도 버전 문자열을 하드코딩하지 않는다).
// CompanyName은 사명 미확정(open (a))이라 제품명과 같은 '기사작성기'로 둔다 — Electron 기본값
// 'GitHub, Inc.' 잔류만은 반드시 피한다. 사명 확정 시 이 파일의 COMPANY_NAME 1줄만 바꾸면 된다.

const PRODUCT_NAME = '기사작성기'; // client/package.json productName과 같은 값(테스트가 잠근다).
const COMPANY_NAME = '기사작성기';

// '1.0.0' → [1, 0, 0, 0]. PE VS_FIXEDFILEINFO는 16비트 4조각이다 — 형식 위반은 throw(fail-fast:
// 조용히 0.0.0.0으로 배포되는 것이 최악이다).
export function toVersionQuad(version) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`version은 'major.minor.patch' 형식이어야 한다: ${JSON.stringify(version)}`);
  }
  const parts = version.split('.').map(Number);
  if (parts.some((n) => n > 65535)) {
    throw new Error(`version 조각은 65535 이하여야 한다(PE 16비트): ${version}`);
  }
  return [...parts, 0];
}

const quadString = (version) => toVersionQuad(version).join('.');

// 클라이언트 exe 문자열 집합 — setStringValues에 그대로 넘긴다. OriginalFilename은 실제 파일명이다
// (한글 rename 실패 시 ASCII 폴백 이름이 온다).
export function buildClientVersionStrings({ version, exeName }) {
  return {
    ProductName: PRODUCT_NAME,
    FileDescription: '기사작성기 클라이언트',
    CompanyName: COMPANY_NAME,
    FileVersion: quadString(version),
    ProductVersion: quadString(version),
    OriginalFilename: exeName,
    InternalName: 'article-client',
    LegalCopyright: `Copyright (c) ${COMPANY_NAME}`,
  };
}

// 서버 SEA exe 문자열 집합(선택 항목 D용) — FileDescription으로 서버를 구분한다.
export function buildServerVersionStrings({ version, exeName }) {
  return {
    ProductName: PRODUCT_NAME,
    FileDescription: '기사작성기 서버',
    CompanyName: COMPANY_NAME,
    FileVersion: quadString(version),
    ProductVersion: quadString(version),
    OriginalFilename: exeName,
    InternalName: 'article-server',
    LegalCopyright: `Copyright (c) ${COMPANY_NAME}`,
  };
}

// PE 리소스 편집 — resedit 모듈 네임스페이스를 주입받는 순수 변환(빌드 스크립트 2곳이 공유한다.
// 판정·호출 순서가 여기 한 곳에 있어야 dist-client와 sea-build가 갈라지지 않는다).
// 주의: NtExecutable 재생성은 Authenticode 서명을 제거한다 — 이 프로젝트는 미서명 배포라 손실이 없다.
export function applyPeMeta({ resedit, exeBuffer, icoBuffer, version, strings, lang = 1033 }) {
  const { NtExecutable, NtExecutableResource, Resource, Data } = resedit;
  const exe = NtExecutable.from(exeBuffer, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);

  const icons = Data.IconFile.from(icoBuffer).icons;
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, lang, icons.map((i) => i.data));

  const viList = Resource.VersionInfo.fromEntries(res.entries);
  if (viList.length === 0) throw new Error('VersionInfo 리소스가 없다 — 대상 exe가 예상과 다르다.');
  const vi = viList[0];
  const [major, minor, micro, revision] = toVersionQuad(version);
  vi.setFileVersion(major, minor, micro, revision, lang);
  vi.setProductVersion(major, minor, micro, revision, lang);
  vi.setStringValues({ lang, codepage: 1200 }, strings);
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  return { buffer: Buffer.from(exe.generate()), iconCount: icons.length };
}

// read-back 검증 — 같은 바이트를 다시 파싱해 아이콘 항목 수·FileVersion·ProductName을 읽는다.
// 적용 직후 이 값이 기대와 다르면 빌드를 실패시켜라(조용한 기본 메타 배포 금지).
export function readPeMeta({ resedit, exeBuffer, lang = 1033 }) {
  const { NtExecutable, NtExecutableResource, Resource } = resedit;
  const exe = NtExecutable.from(exeBuffer, { ignoreCert: true });
  const res = NtExecutableResource.from(exe);
  const group = Resource.IconGroupEntry.fromEntries(res.entries).find((g) => g.id === 1);
  const viList = Resource.VersionInfo.fromEntries(res.entries);
  const values = viList.length > 0 ? viList[0].getStringValues({ lang, codepage: 1200 }) : {};
  return {
    iconEntries: group ? group.icons.length : 0,
    fileVersion: values.FileVersion ?? null,
    productName: values.ProductName ?? null,
    companyName: values.CompanyName ?? null,
    fileDescription: values.FileDescription ?? null,
  };
}
