// 창 옵션·window.open·내비게이션 정책 (phase 62 step0) — Electron 비의존 순수 모듈.
// 창은 두 종류뿐이다: app(원격 서버 페이지, preload 없음) · local(셸 설정/오류 페이지, preload 있음).
// CRITICAL(최상위 불변식): preload가 붙은 webContents는 원격 URL을 절대 로드하지 않는다 —
//   local kind는 새 창·내비게이션을 전량 차단한다. about:blank 자식 창의 webPreferences는 부모에서
//   복사되며 override 불가(Electron v43 window-open 문서)라, local이 자식을 열면 preload가 상속된다.
// kind 미지정·파싱 실패는 전부 fail-closed(deny/block) — 등록 누락이 "허용"으로 새지 않는다.

import { isSameOrigin } from './serverUrl.js';

export const APP_WINDOW = 'app';
export const LOCAL_WINDOW = 'local';

const HTTP_SCHEMES = new Set(['http:', 'https:']);

// 공통 보안값 — 원격 페이지를 여는 셸에서 이 값이 무너지면 곧바로 RCE 경로가 된다.
// spellcheck:false는 확정 결정(decisions (13)): Chromium 맞춤법 검사는 사전 다운로드 등 앱 밖 통신을
// 유발할 수 있어 ADR-008(egress 0)·폐쇄망 배치와 맞지 않는다. 맞춤법은 SPA 자체 메뉴(phase 30)가 담당.
function baseWebPreferences() {
  return {
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,
    webviewTag: false,
    spellcheck: false,
  };
}

export function buildWindowOptions(kind, { preloadPath, bounds, show } = {}) {
  const common = {
    show: show === true, // 기본 false — step1이 ready-to-show에서 띄운다(흰 깜빡임 방지).
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
  };
  if (kind === APP_WINDOW) {
    const opts = {
      ...common,
      width: 1440,
      height: 900,
      minWidth: 1024,
      minHeight: 720,
      // preload 키 자체를 두지 않는다(undefined 값도 금지) — "원격 창엔 preload가 없다"의 객체 수준 증명.
      webPreferences: baseWebPreferences(),
    };
    if (bounds && Number.isInteger(bounds.width) && Number.isInteger(bounds.height)) {
      opts.width = bounds.width;
      opts.height = bounds.height;
      if (Number.isInteger(bounds.x) && Number.isInteger(bounds.y)) {
        opts.x = bounds.x;
        opts.y = bounds.y;
      }
    }
    return opts;
  }
  if (kind === LOCAL_WINDOW) {
    // 로컬 창은 브리지가 없으면 아무것도 못 한다 — 조용한 반쪽 상태 금지, 즉시 throw.
    if (!preloadPath) throw new Error('local 창은 preloadPath가 필수다');
    return {
      ...common,
      width: 560,
      height: 420,
      webPreferences: { ...baseWebPreferences(), preload: preloadPath },
    };
  }
  throw new Error(`알 수 없는 창 kind: ${String(kind)}`);
}

// setWindowOpenHandler 판정 — 반환 객체를 결선부(step1)가 그대로 쓴다.
// openExternal 필드는 "deny하되 기본 브라우저로 넘겨라"는 지시다(결선부가 isExternallyOpenable 재확인).
export function decideWindowOpen({ url, serverOrigin, kind } = {}) {
  if (kind !== APP_WINDOW) return { action: 'deny' }; // local·미지정·알 수 없는 값 전부(fail-closed).
  if (!serverOrigin) return { action: 'deny' };
  if (url === 'about:blank') {
    // SPA의 상세보기·인쇄 창(window.open('', '_blank', 'width=720,height=800')).
    // overrideBrowserWindowOptions.webPreferences는 about:blank에서 무시된다(부모 복사) — 넣지 않는다.
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { width: 720, height: 800, autoHideMenuBar: true },
      outlivesOpener: true,
    };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { action: 'deny' };
  }
  if (!HTTP_SCHEMES.has(parsed.protocol)) return { action: 'deny' }; // openExternal 없음 — OS 핸들러 실행 차단.
  if (isSameOrigin(url, serverOrigin)) {
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true } };
  }
  return { action: 'deny', openExternal: url };
}

// will-navigate 판정 — 'allow' | 'block' | 'external'.
export function decideNavigation({ url, serverOrigin, kind } = {}) {
  if (kind !== APP_WINDOW) return 'block'; // local은 최초 loadFile 외 어떤 내비게이션도 없다(불변식).
  if (!serverOrigin) return 'block';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return 'block';
  }
  if (!HTTP_SCHEMES.has(parsed.protocol)) return 'block';
  return isSameOrigin(url, serverOrigin) ? 'allow' : 'external';
}

// shell.openExternal에 넘겨도 되는 URL 판정 — 임의 스킴을 넘기면 OS 핸들러가 실행된다.
export function isExternallyOpenable(url) {
  try {
    return HTTP_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
