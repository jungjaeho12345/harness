// 사용자 관리 컨트롤러 (userMgmt.do, Z 전용 — 서버 게이트가 강제).
// 비밀번호는 어떤 응답에도 없으므로 폼은 빈칸으로 둔다 → 빈 비밀번호는 "변경 안 함"으로 처리한다(news.md).

import { useCallback, useState } from 'react';
import { useAppContext } from '../app/context.js';

export function useUserMgmtController() {
  const { model } = useAppContext();
  const [users, setUsers] = useState([]);

  const refresh = useCallback(async () => {
    const r = await model.queryUsers();
    setUsers((r && r.items) || []);
    return r;
  }, [model]);

  const createUser = useCallback(async (payload) => {
    const r = await model.createUser(payload);
    await refresh();
    return r;
  }, [model, refresh]);

  // 빈 비밀번호는 변경하지 않는다 — payload에서 제거(비밀번호 미노출 정책과 정합).
  const updateUser = useCallback(async (userId, fields = {}) => {
    const patch = { ...fields };
    if (patch.password === '' || patch.password == null) delete patch.password;
    const r = await model.updateUser(userId, patch);
    await refresh();
    return r;
  }, [model, refresh]);

  return { users, refresh, createUser, updateUser };
}
