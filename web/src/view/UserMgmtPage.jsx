// 사용자 관리페이지(userMgmt.do, 권한 Z 전용) — USER 입력/수정/조회 (news.md 사용자 관리).
// CRITICAL: 비밀번호는 어떤 응답에도 없다 → 폼은 빈칸으로 두고, 빈 비밀번호는 "변경 안 함"(컨트롤러가 처리).
// 응답·표에 비밀번호(평문·해시)를 절대 표시/보관하지 않는다. 데이터는 useUserMgmtController 경유.

import { useEffect, useState } from 'react';
import { useUserMgmtController } from '../controller/useUserMgmtController.js';

const BLANK = {
  userId: '', name: '', password: '', role: 'R', department: '', departmentCode: '', active: 'Y',
};

// 서버 거부 사유(Z 게이트·전역 에러 핸들러·httpModel 정규화 토큰) → 사용자 문구 (DistMgmtPage 동형).
// CRITICAL: 사유 토큰만 문구로 매핑한다 — 비밀번호·서버 응답의 임의 필드는 절대 렌더하지 않는다.
const REASON_MESSAGE = {
  unauthenticated: '로그인이 필요합니다. 다시 로그인해 주세요.',
  forbidden: '권한이 없습니다. 사용자 관리는 관리자(Z) 전용입니다.',
  'internal-error': '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  'network-error': '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'invalid-response': '서버 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

function reasonMessage(reason) {
  return REASON_MESSAGE[reason] ?? `요청을 처리하지 못했습니다 (${reason}).`;
}

export function UserMgmtPage() {
  const { users, refresh, createUser, updateUser } = useUserMgmtController();
  const [form, setForm] = useState(BLANK);
  const [editing, setEditing] = useState(false);
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

  // 수정 진입 — 비밀번호는 응답에 없으므로 항상 빈칸으로 둔다(빈칸 = 변경 안 함).
  const startEdit = (u) => {
    setEditing(true);
    setForm({
      userId: u.userId ?? '', name: u.name ?? '', password: '',
      role: u.role ?? 'R', department: u.department ?? '',
      departmentCode: u.departmentCode ?? '', active: u.active ?? 'Y',
    });
    setError('');
  };

  const reset = () => { setForm(BLANK); setEditing(false); setError(''); };

  const onSubmit = async (e) => {
    e.preventDefault();
    let r;
    if (editing) {
      const { userId, ...fields } = form;
      r = await updateUser(userId, fields); // 빈 비밀번호는 컨트롤러가 제거.
    } else {
      r = await createUser(form);
    }
    if (r && r.ok) { reset(); return; }
    // 실패 시 폼·편집 상태를 유지한다(고쳐서 재제출). 문구는 사유 토큰 매핑뿐 — 입력값 미포함.
    setError(reasonMessage(r && r.reason));
  };

  return (
    <main className="yh-page">
      <h1>사용자 관리</h1>

      <form className="yh-card" onSubmit={onSubmit} data-testid="user-form">
        <div className="yh-field">
          <label htmlFor="u-id">유저아이디</label>
          <input id="u-id" value={form.userId} onChange={(e) => set('userId', e.target.value)} readOnly={editing} />
        </div>
        <div className="yh-field">
          <label htmlFor="u-name">이름</label>
          <input id="u-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="u-pw">비밀번호{editing ? ' (빈칸이면 변경 안 함)' : ''}</label>
          <input
            id="u-pw"
            type="password"
            value={form.password}
            onChange={(e) => set('password', e.target.value)}
            placeholder={editing ? '변경하려면 입력' : '비밀번호'}
            autoComplete="new-password"
          />
        </div>
        <div className="yh-field">
          <label htmlFor="u-role">권한</label>
          <select id="u-role" value={form.role} onChange={(e) => set('role', e.target.value)}>
            <option value="R">R (기자)</option>
            <option value="D">D (데스크)</option>
            <option value="Z">Z (관리자)</option>
          </select>
        </div>
        <div className="yh-field">
          <label htmlFor="u-dept">부서</label>
          <input id="u-dept" value={form.department} onChange={(e) => set('department', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="u-deptcode">부서코드</label>
          <input id="u-deptcode" value={form.departmentCode} onChange={(e) => set('departmentCode', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="u-active">활성</label>
          <select id="u-active" value={form.active} onChange={(e) => set('active', e.target.value)}>
            <option value="Y">Y</option>
            <option value="N">N</option>
          </select>
        </div>
        <button type="submit" className="yh-btn yh-btn--primary">{editing ? '수정' : '생성'}</button>
        {editing && (
          <button type="button" className="yh-btn" onClick={reset}>취소</button>
        )}
        {error && <p role="alert" data-testid="user-error">{error}</p>}
      </form>

      <table className="yh-table">
        <thead>
          <tr><th>유저아이디</th><th>이름</th><th>권한</th><th>부서</th><th>부서코드</th><th>활성</th><th></th></tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.userId}>
              <td>{u.userId}</td>
              <td>{u.name}</td>
              <td>{u.role}</td>
              <td>{u.department}</td>
              <td>{u.departmentCode}</td>
              <td>{u.active}</td>
              <td><button type="button" className="yh-btn" onClick={() => startEdit(u)}>수정</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

export default UserMgmtPage;
