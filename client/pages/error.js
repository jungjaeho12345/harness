// 연결 오류 페이지 (phase 62 step1) — 실패 원인(describeLoadFailure/describeHttpFailure 결과)을 보여주고
// [다시 연결]·[서버 주소 변경]·[종료]를 제공한다. 주소 변경은 이 페이지 안의 폼으로 한다 —
// 브리지 5함수(probeServer·saveServer·getState·retry·quit) 계약 안에서 저장 성공 시 메인이 앱 창으로 전환한다.
// CRITICAL: 사용자 입력·서버 유래 문자열은 textContent로만 그린다(innerHTML 금지).

const bridge = window.shellBridge;

const REASON_MESSAGES = {
  empty: '서버 주소를 입력하세요.',
  invalid: '주소 형식이 올바르지 않습니다 — 예: 192.168.0.10:3001',
  'unsupported-scheme': 'http:// 또는 https:// 주소만 사용할 수 있습니다.',
  credentials: '주소에 아이디·비밀번호를 넣을 수 없습니다.',
  'no-host': '주소에 서버 이름이 없습니다.',
  unreachable: '서버에 연결할 수 없습니다 — 주소·포트·서버 실행 여부를 확인하세요.',
  'http-status': '서버가 정상 응답하지 않습니다 — 주소를 확인하세요.',
  'not-article-server': '기사작성기 서버가 아닙니다 — 주소를 확인하세요.',
  forbidden: '요청이 거부되었습니다 — 프로그램을 다시 실행하세요.',
};

function reasonText(reason) {
  return REASON_MESSAGES[reason] || '알 수 없는 오류가 발생했습니다.';
}

const titleEl = document.getElementById('failure-title');
const messageBodyEl = document.getElementById('failure-message');
const hintEl = document.getElementById('failure-hint');
const currentEl = document.getElementById('current');
const changeSection = document.getElementById('change-section');
const addressInput = document.getElementById('address');
const messageEl = document.getElementById('message');
const retryBtn = document.getElementById('retry');
const changeBtn = document.getElementById('change');
const quitBtn = document.getElementById('quit');
const probeBtn = document.getElementById('probe');
const saveBtn = document.getElementById('save');

function setMessage(text, ok) {
  messageEl.textContent = text;
  messageEl.className = `shell-message ${ok ? 'shell-message--ok' : 'shell-message--error'}`;
}

function setBusy(busy) {
  probeBtn.disabled = busy;
  saveBtn.disabled = busy;
  retryBtn.disabled = busy;
}

async function init() {
  const state = await bridge.getState();
  const failure = (state && state.failure) || null;
  if (failure) {
    titleEl.textContent = failure.title || '서버에 연결할 수 없습니다';
    messageBodyEl.textContent = failure.message || '';
    hintEl.textContent = failure.hint || '';
  } else {
    messageBodyEl.textContent = '서버와의 연결이 끊어졌습니다.';
    hintEl.textContent = '다시 연결하거나 서버 주소를 확인하세요.';
  }
  if (state && state.serverUrl) {
    currentEl.textContent = `현재 서버 주소: ${state.serverUrl}`;
    addressInput.value = state.serverUrl;
  } else {
    currentEl.textContent = '저장된 서버 주소가 없습니다.';
  }
}

retryBtn.addEventListener('click', () => {
  bridge.retry(); // 메인이 앱 창을 새로 만든다 — 실패하면 이 창이 다시 뜬다(사용자 액션당 1회).
});

changeBtn.addEventListener('click', () => {
  changeSection.hidden = !changeSection.hidden;
  if (!changeSection.hidden) addressInput.focus();
});

quitBtn.addEventListener('click', () => {
  bridge.quit();
});

probeBtn.addEventListener('click', async () => {
  setBusy(true);
  setMessage('연결 확인 중…', true);
  const result = await bridge.probeServer(addressInput.value);
  setBusy(false);
  if (result && result.ok) setMessage(`연결 확인됨: ${result.origin}`, true);
  else setMessage(reasonText(result && result.reason), false);
});

saveBtn.addEventListener('click', async () => {
  setBusy(true);
  setMessage('연결 확인 후 저장 중…', true);
  const result = await bridge.saveServer(addressInput.value);
  if (!result || !result.ok) {
    setBusy(false);
    setMessage(reasonText(result && result.reason), false);
  }
});

init();
