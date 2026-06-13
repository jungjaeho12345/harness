// 수신 설정 관리페이지(rcvMgmt.do, 권한 Z 전용) — 자동기사 수신 설정 조회/생성/삭제 (rcv.md).
// 비-Z 접근은 App 라우트 가드가 list.do로 보내고, 서버 Z 게이트가 실제 강제한다.
// 삭제는 설정 행만 지운다(이미 수집된 기사는 비파괴 — 서버 보장). 데이터는 useRcvMgmtController 경유.

import { useEffect, useState } from 'react';
import { useRcvMgmtController } from '../controller/useRcvMgmtController.js';

const BLANK = {
  sourceId: '', type: 'FTP', name: '', host: '', port: '',
  username: '', password: '', apiEndpoint: '', apiKey: '', active: 'Y',
};

export function RcvMgmtPage() {
  const { configs, refresh, createConfig, deleteConfig } = useRcvMgmtController();
  const [form, setForm] = useState(BLANK);

  useEffect(() => { refresh(); }, [refresh]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onCreate = async (e) => {
    e.preventDefault();
    await createConfig(form);
    setForm(BLANK);
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
        <button type="submit" className="yh-btn yh-btn--primary">설정 생성</button>
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
                  onClick={() => deleteConfig(c.id)}
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
