// 애플리케이션 메뉴 템플릿 (phase 62 step1) — 평문 객체만 만든다(Electron 비의존, 단위 테스트 대상).
// CRITICAL: 어떤 항목에도 명시 단축키 키를 넣지 않고, 편집 계열 role(undo·redo·cut·copy·paste·selectAll)도
// 넣지 않는다 — 메뉴 단축키는 렌더러 keydown보다 먼저 처리되어 SPA 에디터 단축키(Ctrl+B/D/F/Y/A,
// Alt+V/O/Y, Ctrl+X/C/V)를 조용히 삼킨다(news.md 181·185행). role:'redo'는 Windows에서 Ctrl+Y(=(계속)삽입),
// role:'selectAll'은 Ctrl+A와 정면 충돌한다. 텍스트 편집 키는 렌더러 편집기가 메뉴 없이 처리한다.
// role 기본 키(reload=Ctrl+R, zoomIn/zoomOut/resetZoom=Ctrl+±/0)는 SPA 예약키와 교집합이 0이라 허용한다
// (게이트 ② 확정 — 필요해지면 registerAccelerator:false만 쓴다. 명시 키 지정은 금지 유지).
// 라벨에 mnemonic(&)을 넣지 않는다 — Alt 조합 충돌 표면 축소(step2 D-8 실측 대상).

export function buildMenuTemplate({ dev = false, handlers = {} } = {}) {
  const viewItems = [
    { label: '새로고침', role: 'reload' }, // news.md 125행 F5 세션 유지 계약 — 커스텀 메뉴에선 이 항목이 유일한 새로고침 진입점이다.
    { type: 'separator' },
    { label: '확대', role: 'zoomIn' },
    { label: '축소', role: 'zoomOut' },
    { label: '원래 크기', role: 'resetZoom' },
  ];
  if (dev) {
    viewItems.push({ type: 'separator' }, { label: '개발자도구', role: 'toggleDevTools' });
  }
  return [
    {
      label: '파일',
      submenu: [
        { label: '서버 주소 변경', click: handlers.changeServer },
        { label: '다시 연결', click: handlers.reconnect },
        { type: 'separator' },
        { label: '종료', click: handlers.quit },
      ],
    },
    { label: '보기', submenu: viewItems },
    {
      label: '도움말',
      submenu: [
        { label: '정보', click: handlers.about },
      ],
    },
  ];
}
