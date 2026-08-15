// Electron 메인 프로세스 (phase 62 step1) — 결선만 한다. 정책 판단은 client/lib(step0),
// 메뉴 구성·sender 검증·진단 직렬화는 client/{menu,ipcGuard,diag}.js가 단일 출처다(재구현 금지).
// 창은 두 종류뿐이다: 앱 창(원격 서버 페이지 loadURL, 브리지 없음) · 로컬 창(pages/ loadFile, 브리지 있음).
// CRITICAL(최상위 불변식): 브리지가 붙은 webContents는 원격 URL을 절대 로드하지 않는다 — 로컬 창의
//   렌더러 내비게이션은 decideNavigation('local')이 전량 block한다.
// CRITICAL(부팅 순서, decisions (11)): userData 지정 → 단일 인스턴스 잠금 요청 순서 고정 —
//   잠금 키가 userData 경로에서 파생되므로 뒤집으면 실사용자 프로필 오염 + 스모크 거짓 통과.
// 셸에는 타이머·주기 통신이 없다(ADR-008) — 서버 프로브는 사용자 액션당 net.fetch 1회뿐이다.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Menu, dialog, ipcMain, net, screen, session, shell } from 'electron';
import { normalizeServerUrl, healthUrl, appUrl, interpretHealthResponse, resolveFinalOrigin } from './lib/serverUrl.js';
import { configPath, readConfigFileSync, writeConfigFile, sanitizeBounds } from './lib/clientConfig.js';
import { FEATURE_SWITCH, decideSecureOriginSwitches, requiresRestartForOrigin } from './lib/secureOrigin.js';
import {
  APP_WINDOW, LOCAL_WINDOW, buildWindowOptions, decideWindowOpen, decideNavigation, isExternallyOpenable,
} from './lib/windowPolicy.js';
import { isAllowedPermission } from './lib/permissionPolicy.js';
import { describeLoadFailure, describeHttpFailure } from './lib/loadFailure.js';
import { buildMenuTemplate } from './menu.js';
import { isTrustedSender } from './ipcGuard.js';
import { createDiag } from './diag.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD_PATH = path.join(moduleDir, 'preload.cjs'); // 로컬 창 전용 — 앱 창 옵션에는 이 값이 아예 없다.
const SELFTEST = process.env.CLIENT_SELFTEST === '1';
const diag = createDiag({ filePath: process.env.CLIENT_DIAG_FILE, appendFileSync: fs.appendFileSync });

// 설정 파일 접근 — client/lib/clientConfig.js는 순수 모듈이라 fs를 주입받는다.
// close 훅에서도 확실히 완결되도록 동기 fs를 async 시그니처로 감싼다(마이크로태스크 내 완결).
// 읽기는 부팅 시 readConfigFileSync 1회뿐이다(phase 63 step0 decisions (3)) — 비동기 읽기 의존성은 없다.
const fsDeps = {
  mkdir: async (dir, opts) => fs.mkdirSync(dir, opts),
  writeFile: async (file, data) => fs.writeFileSync(file, data),
  rename: async (from, to) => fs.renameSync(from, to),
};

// webContents → 창 kind 매핑 (decisions (16)) — 미등록은 LOCAL(가장 제한적) 취급: 등록 누락이
// "허용"으로 새지 않는다(local은 새 창·내비게이션 전량 차단).
const kindByContents = new WeakMap();
const kindOf = (contents) => kindByContents.get(contents) ?? LOCAL_WINDOW;

let serverOrigin = null;
let savedBounds = null;
let appWindow = null;
let localWindow = null;
let localContentsId = null;
let localMode = 'setup';
let lastFailure = null;
let configFile = null;
let appliedSecureOrigin = null; // 부팅 시 secure-origin 스위치를 적용한 origin(미적용은 null) — 재시작 안내 판정 입력.

// --- 부팅 순서 계약: userData 지정이 반드시 단일 인스턴스 잠금보다 먼저다 ---
if (process.env.CLIENT_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.CLIENT_USER_DATA));
}
if (!app.requestSingleInstanceLock()) {
  app.quit(); // 창을 만들지 않고 즉시 종료 — 기존 인스턴스가 second-instance로 전면에 나온다.
} else {
  wireApp();
}

function wireApp() {
  configFile = configPath(app.getPath('userData'));

  // --- secure-origin 스위치 (phase 63 step0) — 반드시 app ready "전" 1회다. ready 이후의 appendSwitch는
  // Chromium에 반영되지 않아 조용히 무효가 된다. 판정은 secureOrigin.js 단일 출처 — 여기서는 append만 한다.
  // 설정도 여기서 동기로 1회만 읽고(whenReady가 재사용) 같은 부팅에서 두 번 읽어 갈라지는 경로를 만들지 않는다.
  const bootConfig = readConfigFileSync(configFile, { readFileSync: (f, enc) => fs.readFileSync(f, enc) });
  const secureDecision = decideSecureOriginSwitches(bootConfig.serverUrl, {
    existingFeatures: app.commandLine.getSwitchValue(FEATURE_SWITCH), // 덮어쓰기 금지 — 병합은 순수 모듈이 했다.
  });
  if (secureDecision.apply) {
    for (const sw of secureDecision.switches) app.commandLine.appendSwitch(sw.name, sw.value);
    appliedSecureOrigin = secureDecision.origin;
    diag.log('secure-origin-switch', { origin: secureDecision.origin, count: secureDecision.switches.length });
  } // 미적용이면 이벤트를 남기지 않는다 — 부재가 loopback 검증의 음성 증거다.

  app.on('second-instance', () => {
    diag.log('second-instance', {});
    if (SELFTEST) return; // 검증 중 데스크톱 점유 금지 — 이벤트 기록만 한다.
    const win = [appWindow, localWindow].find((w) => w && !w.isDestroyed());
    if (!win) return;
    if (win.isMinimized()) win.restore(); // restore()를 항상 부르면 최대화가 풀린다 — 최소화일 때만.
    win.show();
    win.focus();
  });

  // 전역 가드 — 어떤 경로로 webContents가 생겨도 새 창·내비게이션 정책이 걸린다.
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() !== 'window') return; // devtools 등 비창 contents는 정책 평가 대상이 아니다(게이트 ② 확정).
    contents.setWindowOpenHandler(({ url }) => {
      const decision = decideWindowOpen({ url, serverOrigin, kind: kindOf(contents) });
      diag.log('window-open', { url, action: decision.action });
      if (decision.action === 'allow') {
        const allow = { action: 'allow', overrideBrowserWindowOptions: decision.overrideBrowserWindowOptions };
        if (decision.outlivesOpener === true) allow.outlivesOpener = true;
        return allow;
      }
      if (decision.openExternal && isExternallyOpenable(decision.openExternal)) {
        shell.openExternal(decision.openExternal); // 외부 링크는 기본 브라우저로 — 앱 창에 남기지 않는다.
      }
      return { action: 'deny' };
    });
    contents.on('did-create-window', (child) => {
      kindByContents.set(child.webContents, kindOf(contents)); // 자식(about:blank 상세보기·인쇄)은 부모 kind 상속.
    });
    contents.on('will-navigate', (event, url) => {
      const decision = decideNavigation({ url, serverOrigin, kind: kindOf(contents) });
      diag.log('navigation', { url, decision });
      if (decision !== 'allow') event.preventDefault();
      if (decision === 'external' && isExternallyOpenable(url)) shell.openExternal(url);
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  // IPC — 모든 핸들러는 sender(file:// + 현재 로컬 창 contents id)를 검증한다. 신뢰 경계는 셸 메인이다.
  // 프로브 이후의 소비(응답·저장·창 생성·재시작 판정)는 전부 프로브가 돌려준 최종 origin 하나만 본다
  // (phase 66 step4 — 302 승격값과 저장값이 갈라지면 secure-origin 스위치가 엉뚱한 출처에 걸린다).
  handleGuarded('probeServer', async (input) => {
    const norm = normalizeServerUrl(input);
    if (!norm.ok) return { ok: false, reason: norm.reason };
    const verdict = await probeOrigin(norm.origin);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, origin: verdict.origin };
    return { ok: true, origin: verdict.origin };
  });
  handleGuarded('saveServer', async (input) => {
    const norm = normalizeServerUrl(input);
    if (!norm.ok) return { ok: false, reason: norm.reason };
    const verdict = await probeOrigin(norm.origin);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, origin: verdict.origin }; // 실패한 주소는 저장하지 않는다.
    serverOrigin = verdict.origin;
    lastFailure = null;
    await persistConfig();
    diag.log('config-saved', { origin: verdict.origin });
    // 새 출처가 스위치를 요구하는데 부팅 때 적용한 값과 다르면 재시작 안내 — 가장 흔한 경로는 "최초 설정"이다
    // (설정 없는 첫 실행은 appliedSecureOrigin === null이라 LAN 주소를 처음 저장하는 순간 참이 된다).
    if (requiresRestartForOrigin(appliedSecureOrigin, verdict.origin)) notifyRestartRequired(verdict.origin);
    createAppWindow(verdict.origin, savedBounds);
    return { ok: true, origin: verdict.origin };
  });
  handleGuarded('getState', async () => ({ mode: localMode, serverUrl: serverOrigin, failure: lastFailure }));
  handleGuarded('retry', async () => { retryConnect(); return { ok: true }; });
  handleGuarded('quit', async () => { app.quit(); return { ok: true }; });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.whenReady().then(() => {
    diag.log('app-ready', {});
    // 권한은 클립보드 2종만 — WriterPage 붙여넣기 경로(navigator.clipboard.read)가 쓴다. 나머지는 전부 거부.
    // request(비동기 요청)와 check(동기 확인 — navigator.permissions.query 등)가 같은 정책을 공유한다.
    // 판정 단일 출처는 client/lib/permissionPolicy.js다(phase 64 step3 — Electron 보안 체크리스트 대칭 권고).
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(isAllowedPermission(permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => isAllowedPermission(permission)); // 동기 boolean 반환(콜백 아님).
    Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({
      dev: process.env.CLIENT_DEV === '1',
      handlers: {
        changeServer: () => { showLocalWindow('setup', 'menu'); closeAppWindow(); },
        reconnect: () => retryConnect(),
        quit: () => app.quit(),
        about: () => showAbout(),
      },
    })));

    const cfg = bootConfig; // 부팅 시 동기 1회 읽은 결과 재사용 — 스위치 판정과 화면 상태가 갈라지지 않는다.
    diag.log('config-loaded', { hasServerUrl: cfg.serverUrl !== null });
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    savedBounds = sanitizeBounds(cfg.bounds, workAreas); // 모니터가 떨어진 배치는 기본 배치로.
    if (cfg.serverUrl) {
      serverOrigin = cfg.serverUrl;
      createAppWindow(serverOrigin, savedBounds);
    } else {
      showLocalWindow('setup', 'no-config');
    }
  });
}

// 사용자 액션당 1회 프로브 — 재시도·백오프·주기 확인 금지(ADR-008). 판정은 interpretHealthResponse 단일 출처.
// 리다이렉트는 기본 추종을 유지하고(끄지 않는다 — 정상 프록시 배치 보호) 도착지만 읽는다: 반환 계약은
// 성공/실패 무관 항상 최종 origin을 함께 돌려주되, 승격은 성공 판정일 때만 한다(오류 페이지·캡티브 포털로의
// 리다이렉트가 저장 주소를 바꾸면 접속 불능이 영구화된다). 승격 규칙은 순수 모듈 단일 출처(서두 계약).
async function probeOrigin(origin) {
  let verdict;
  let finalUrl = null;
  try {
    const res = await net.fetch(healthUrl(origin), { signal: AbortSignal.timeout(5000) });
    finalUrl = res.url; // 리다이렉트 추종 후 도착지 — 승격 판정 입력.
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    verdict = interpretHealthResponse({ status: res.status, body });
  } catch {
    verdict = interpretHealthResponse({ status: null, body: null }); // 네트워크 실패 = unreachable.
  }
  const resolved = verdict.ok
    ? resolveFinalOrigin({ requestedOrigin: origin, responseUrl: finalUrl })
    : { origin, changed: false }; // 실패 시 승격 금지 — 요청 origin 유지.
  // 진단은 기존 필드 유지 + 추가만(diag.js 계약). 응답 URL 원문은 절대 싣지 않는다 — origin류 키는
  // 축약기를 타지 않으므로(키에 url 미포함) 승격 결과 origin 문자열과 boolean만 남긴다.
  const payload = { origin, ok: verdict.ok, finalOrigin: resolved.origin, promoted: resolved.changed };
  if (!verdict.ok) payload.reason = verdict.reason;
  diag.log('probe', payload);
  return { ...verdict, origin: resolved.origin };
}

function handleGuarded(channel, handler) {
  ipcMain.handle(channel, async (event, ...args) => {
    const trusted = isTrustedSender({
      senderUrl: event.senderFrame?.url,
      senderContentsId: event.sender.id,
      localContentsId,
    });
    diag.log('ipc', { channel, trusted });
    if (!trusted) return { ok: false, reason: 'forbidden' }; // 처리 금지 — 원격·타 창은 여기서 끝.
    return handler(...args);
  });
}

function createAppWindow(origin, bounds) {
  // 앱 창도 항상 최대 1개다 — 메뉴 [다시 연결]처럼 앱 창이 살아 있는 채로 재진입하면 이전 창이
  // 추적(appWindow)에서 빠진 고아로 화면에 남는다(창 수명 계약 위반). 새 창을 먼저 세운 뒤 닫는다
  // (create-then-close — 먼저 닫으면 window-all-closed 공백으로 앱이 종료된다).
  const prev = appWindow;
  const win = new BrowserWindow(buildWindowOptions(APP_WINDOW, { bounds }));
  appWindow = win;
  kindByContents.set(win.webContents, APP_WINDOW);
  let shown = false;
  win.once('ready-to-show', () => {
    if (SELFTEST) return; // 검증 모드 — 창을 화면에 올리지 않는다.
    if (bounds && bounds.maximized) win.maximize();
    win.show();
    shown = true;
  });
  const contents = win.webContents;
  contents.on('did-finish-load', () => {
    diag.log('did-finish-load', { url: contents.getURL(), title: contents.getTitle() });
  });
  contents.on('did-navigate', (_e, url, httpResponseCode) => {
    diag.log('did-navigate', { url, httpResponseCode });
    const failure = describeHttpFailure({ httpResponseCode, url }); // 404 = 서버는 살았는데 SPA 미서빙 배치.
    if (failure && appWindow === win) transitionToFailure(failure);
  });
  contents.on('did-fail-load', (_e, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    diag.log('load-failed', { errorCode, url: validatedUrl });
    const failure = describeLoadFailure({ errorCode, errorDescription, validatedUrl, isMainFrame });
    if (failure && appWindow === win) transitionToFailure(failure);
  });
  // 렌더러 이상은 진단만 — 창을 죽이지 않는다(계획 5절).
  contents.on('render-process-gone', (_e, details) => diag.log('render-process-gone', { reason: details && details.reason }));
  contents.on('unresponsive', () => diag.log('unresponsive', {}));
  // 창 크기 저장은 close 1회뿐(resize 디바운스 타이머 금지 — ADR-008). 화면에 뜬 적 없는 창은 저장하지 않는다.
  win.on('close', () => { if (shown) saveBoundsFrom(win); });
  win.on('closed', () => { if (appWindow === win) appWindow = null; });
  closeLocalWindow(); // 로컬 창은 항상 최대 1개 — 앱 창이 서면 닫는다(앱 창 생성 후라 window-all-closed 공백 없음).
  if (prev && !prev.isDestroyed()) prev.close(); // 이전 앱 창 정리(위 create-then-close). closed 핸들러는 appWindow===win 가드라 새 창 추적을 건드리지 않는다.
  diag.log('app-window', { url: appUrl(origin) });
  // 로드 실패의 판정 단일 출처는 did-fail-load/did-navigate다 — 여기의 reject는 같은 실패의 중복 표면이라
  // 삼킨다(미처리 거절로 남기면 Electron/Node 정책 변화에 노출).
  win.loadURL(appUrl(origin)).catch(() => {});
  return win;
}

// 오류 전환(좀비 창 금지 — decisions (12)): 로컬 오류 창을 먼저 세우고 앱 창을 close()로 없앤다.
// hide() 금지 — 숨은 창이 남으면 window-all-closed가 오지 않아 프로세스가 좀비로 남는다.
function transitionToFailure(failure) {
  lastFailure = failure;
  showLocalWindow('error');
  closeAppWindow();
}

function closeAppWindow() {
  const win = appWindow;
  appWindow = null;
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isCrashed()) {
    win.destroy(); // 렌더러가 죽어 close에 응답할 수 없는 경우만 강제 파괴.
    return;
  }
  win.close(); // 정상 경로 — close 훅(bounds 저장)·렌더러 언로드 기회를 유지한다.
}

function closeLocalWindow() {
  const win = localWindow;
  localWindow = null;
  localContentsId = null;
  if (win && !win.isDestroyed()) win.close();
}

// 로컬 창은 항상 최대 1개 — 있으면 재사용해 모드만 갱신한다(2개가 되면 isTrustedSender의 단일 id와
// 어긋나 먼저 뜬 창의 버튼이 조용히 forbidden이 된다 — 금지된 "조용한 반쪽 상태").
function showLocalWindow(mode, reason) {
  localMode = mode;
  const pageFile = path.join(moduleDir, 'pages', mode === 'error' ? 'error.html' : 'setup.html');
  diag.log('local-window', { page: mode });
  if (mode === 'setup') diag.log('setup-shown', { reason: reason ?? 'error-recovery' });
  if (localWindow && !localWindow.isDestroyed()) {
    localWindow.loadFile(pageFile);
    if (!SELFTEST) { localWindow.show(); localWindow.focus(); }
    return;
  }
  const win = new BrowserWindow(buildWindowOptions(LOCAL_WINDOW, { preloadPath: PRELOAD_PATH }));
  localWindow = win;
  localContentsId = win.webContents.id;
  kindByContents.set(win.webContents, LOCAL_WINDOW);
  win.webContents.on('did-finish-load', () => {
    diag.log('did-finish-load', { url: win.webContents.getURL(), title: win.webContents.getTitle() });
  });
  win.once('ready-to-show', () => { if (!SELFTEST) win.show(); });
  win.on('closed', () => {
    if (localWindow === win) { localWindow = null; localContentsId = null; }
  });
  win.loadFile(pageFile);
}

function retryConnect() {
  if (serverOrigin) {
    createAppWindow(serverOrigin, savedBounds); // 앱 창은 재사용하지 않고 새로 만든다(계획 5절 상태 전이).
  } else {
    showLocalWindow('setup', 'no-config');
  }
}

function saveBoundsFrom(win) {
  try {
    const workAreas = screen.getAllDisplays().map((d) => d.workArea);
    const normal = win.getNormalBounds(); // 최대화 상태여도 복원 크기를 저장한다.
    const bounds = sanitizeBounds({ ...normal, maximized: win.isMaximized() }, workAreas);
    if (bounds) savedBounds = bounds;
    persistConfig();
  } catch {
    // 저장 실패로 종료를 막지 않는다.
  }
}

function persistConfig() {
  // serializeConfig가 화이트리스트를 강제한다 — 세션·자격증명이 실릴 자리가 없다.
  return writeConfigFile(configFile, { serverUrl: serverOrigin, bounds: savedBounds }, fsDeps)
    .catch(() => {});
}

// 재시작 안내 (phase 63 step0) — 스위치는 부팅 1회뿐이라 저장만으로는 클립보드 완화가 적용되지 않는다.
// await 금지: IPC 응답을 다이얼로그로 막으면 설정 화면이 멈춘 것처럼 보인다. SELFTEST에서는 diag만 남긴다.
// app.relaunch() 자동 재시작 금지 — 포터블 폴더 + 단일 인스턴스 잠금 재획득의 재기동 루프 위험.
function notifyRestartRequired(origin) {
  diag.log('restart-required', { origin });
  if (SELFTEST) return;
  dialog.showMessageBox({
    type: 'info',
    title: '재시작 안내',
    message: '서버 주소를 저장했습니다.',
    detail: '복사·붙여넣기 기능을 사용하려면 프로그램을 한 번 껐다 켜 주세요.\n저장된 주소는 프로그램을 켤 때 적용됩니다.',
  });
}

function showAbout() {
  const win = BrowserWindow.getFocusedWindow() ?? appWindow ?? localWindow;
  const opts = {
    type: 'info',
    title: '정보',
    message: '기사작성기 클라이언트',
    detail: [
      `버전 ${app.getVersion()}`,
      `Electron ${process.versions.electron} / Chromium ${process.versions.chrome}`,
      `서버: ${serverOrigin ?? '(미설정)'}`,
    ].join('\n'),
  };
  if (win && !win.isDestroyed()) dialog.showMessageBox(win, opts);
  else dialog.showMessageBox(opts);
}
