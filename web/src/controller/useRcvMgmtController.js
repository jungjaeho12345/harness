// 수신 설정 CRUD 컨트롤러 (rcvMgmt.do, Z 전용 — 서버 게이트가 강제, rcv.md).
// 행 삭제는 설정만 지운다(이미 수집된 기사는 비파괴 — 서버가 보장).

import { useCallback, useState } from 'react';
import { useAppContext } from '../app/context.js';

export function useRcvMgmtController() {
  const { model } = useAppContext();
  const [configs, setConfigs] = useState([]);

  const refresh = useCallback(async () => {
    const r = await model.queryReceiverConfig();
    setConfigs((r && r.items) || []);
    return r;
  }, [model]);

  const createConfig = useCallback(async (entry) => {
    const r = await model.createReceiverConfig(entry);
    await refresh();
    return r;
  }, [model, refresh]);

  const deleteConfig = useCallback(async (id) => {
    const r = await model.deleteReceiverConfig(id);
    await refresh();
    return r;
  }, [model, refresh]);

  return { configs, refresh, createConfig, deleteConfig };
}
