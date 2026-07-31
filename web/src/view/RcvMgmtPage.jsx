// 수신 설정 관리페이지(rcvMgmt.do, 권한 Z 전용) — 자동기사 수신 설정 조회/생성/삭제 (rcv.md).
// 비-Z 접근은 App 라우트 가드가 list.do로 보내고, 서버 Z 게이트가 실제 강제한다.
// 삭제는 설정 행만 지운다(이미 수집된 기사는 비파괴 — 서버 보장). 데이터는 useRcvMgmtController 경유.

import { useEffect, useState } from 'react';
import { useRcvMgmtController } from '../controller/useRcvMgmtController.js';

const BLANK = {
  sourceId: '', type: 'FTP', name: '', host: '', port: '',
  username: '', password: '', apiEndpoint: '', apiKey: '', active: 'Y',
};

// 서버 거부 사유(Z 게이트·전역 에러 핸들러·httpModel 정규화 토큰) → 사용자 문구 (DistMgmtPage 동형).
// 검증·인가의 진실은 서버이며 여기서는 안내만 한다(ADR-004).
const REASON_MESSAGE = {
  unauthenticated: '로그인이 필요합니다. 다시 로그인해 주세요.',
  forbidden: '권한이 없습니다. 수신 설정 관리는 관리자(Z) 전용입니다.',
  'internal-error': '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  'network-error': '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'invalid-response': '서버 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

function reasonMessage(reason) {
  return REASON_MESSAGE[reason] ?? `요청을 처리하지 못했습니다 (${reason}).`;
}

export function RcvMgmtPage() {
  const { configs, refresh, createConfig, deleteConfig } = useRcvMgmtController();
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState('');

  // 진입 시 조회 실패도 표시한다 — 이 refresh만 조회 실패 메시지를 띄운다. 쓰기 핸들러의 내부
  // 재조회 결과는 관찰하지 않는다(관찰하면 성공한 재조회가 쓰기 실패 메시지를 지우는 회귀가 생긴다).
  useEffect(() => {
    let alive = true; // 언마운트(cleanup) 후 setState 금지.
    (async () => {
      const r = await refresh();
      if (alive && (!r || r.ok !== true)) setError(reasonMessage(r && r.reason));
    })();
    return () => { alive = false; };
  }, [refresh]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onCreate = async (e) => {
    e.preventDefault();
    const r = await createConfig(form);
    if (r && r.ok) { setForm(BLANK); setError(''); return; }
    setError(reasonMessage(r && r.reason)); // 실패 시 입력값을 유지해 고쳐서 재제출할 수 있게 한다.
  };

  const onDelete = async (c) => {
    const r = await deleteConfig(c.id);
    setError(r && r.ok ? '' : reasonMessage(r && r.reason));
  };

  return (
    <main className="yh-page">
      <h1>수신 설정 관리</h1>

      <form className="yh-card" onSubmit={onCreate} data-testid="rcv-form">
        <div className="yh-field">
          <label htmlFor="rcv-source">소스아이디</label>
          <input id="rcv-source" value={form.sourceId} onChange={(e) => set('sourceId', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="rcv-type">유형</label>
          <select id="rcv-type" value={form.type} onChange={(e) => set('type', e.target.value)}>
            <option value="FTP">FTP</option>
            <option value="API">API</option>
          </select>
        </div>
        <div className="yh-field">
          <label htmlFor="rcv-name">이름</label>
          <input id="rcv-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="rcv-host">호스트</label>
          <input id="rcv-host" value={form.host} onChange={(e) => set('host', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="rcv-port">포트</label>
          <input id="rcv-port" value={form.port} onChange={(e) => set('port', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="rcv-endpoint">API 엔드포인트</label>
          <input id="rcv-endpoint" value={form.apiEndpoint} onChange={(e) => set('apiEndpoint', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="rcv-username">사용자명</label>
          <input id="rcv-username" value={form.username} onChange={(e) => set('username', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="rcv-password">비밀번호</label>
          <input id="rcv-password" type="password" value={form.password} onChange={(e) => set('password', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="rcv-apikey">API 키</label>
          <input id="rcv-apikey" type="password" value={form.apiKey} onChange={(e) => set('apiKey', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="rcv-active">활성</label>
          <select id="rcv-active" value={form.active} onChange={(e) => set('active', e.target.value)}>
            <option value="Y">Y</option>
            <option value="N">N</option>
          </select>
        </div>
        <button type="submit" className="yh-btn yh-btn--primary">설정 생성</button>
        {error && <p role="alert" data-testid="rcv-error">{error}</p>}
      </form>

      <table className="yh-table">
        <thead>
          <tr>
            <th>소스아이디</th><th>유형</th><th>이름</th><th>호스트</th><th>포트</th><th>활성</th><th></th>
          </tr>
        </thead>
        <tbody>
          {configs.map((c) => (
            <tr key={c.id}>
              <td>{c.sourceId}</td>
              <td>{c.type}</td>
              <td>{c.name}</td>
              <td>{c.host}</td>
              <td>{c.port}</td>
              <td>{c.active}</td>
              <td>
                <button
                  type="button"
                  className="yh-btn yh-btn--danger"
                  onClick={() => onDelete(c)}
                >
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

export default RcvMgmtPage;
