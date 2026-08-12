// 서버 주소 설정 페이지 (phase 62 step1) — 모든 동작은 preload 브리지(shellBridge) 경유.
// CRITICAL: 사용자 입력을 다시 그릴 때 textContent만 쓴다(innerHTML 금지). 프로브는 버튼 클릭당 1회다
// (자동 재시도·폴링 금지 — ADR-008). 실패 사유는 메인의 reason 코드를 한국어로 번역해 보여준다.

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

const addressInput = document.getElementById('address');
const messageEl = document.getElementById('message');
const currentEl = document.getElementById('current');
const probeBtn = document.getElementById('probe');
const saveBtn = document.getElementById('save');

function setMessage(text, ok) {
  messageEl.textContent = text;
  messageEl.className = `shell-message ${ok ? 'shell-message--ok' : 'shell-message--error'}`;
}

function setBusy(busy) {
  probeBtn.disabled = busy;
  saveBtn.disabled = busy;
}

async function init() {
  const state = await bridge.getState();
  if (state && state.serverUrl) {
    currentEl.textContent = `현재 저장된 주소: ${state.serverUrl}`;
    addressInput.value = state.serverUrl;
  } else {
    currentEl.textContent = '저장된 서버 주소가 없습니다.';
  }
  addressInput.focus();
}

probeBtn.addEventListener('click', async () => {
  setBusy(true);
  setMessage('연결 확인 중…', true);
  let result;
  try {
    result = await bridge.probeServer(addressInput.value);
  } finally {
    setBusy(false); // invoke reject에도 버튼이 영구 비활성으로 남지 않게(조용한 반쪽 상태 금지).
  }
  if (result && result.ok) setMessage(`연결 확인됨: ${result.origin}`, true);
  else setMessage(reasonText(result && result.reason), false);
});

saveBtn.addEventListener('click', async () => {
  setBusy(true);
  setMessage('연결 확인 후 저장 중…', true);
  let result;
  try {
    result = await bridge.saveServer(addressInput.value);
  } catch {
    result = undefined; // 아래 실패 표시로 수렴.
  }
  // 성공하면 메인이 이 창을 닫고 앱 창을 연다 — 여기서는 실패만 표시한다.
  if (!result || !result.ok) {
    setBusy(false);
    setMessage(reasonText(result && result.reason), false);
  }
});

init();
