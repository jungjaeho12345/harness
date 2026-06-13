// 사용자 관리페이지(userMgmt.do, 권한 Z 전용) — USER 입력/수정/조회 (news.md 사용자 관리).
// CRITICAL: 비밀번호는 어떤 응답에도 없다 → 폼은 빈칸으로 두고, 빈 비밀번호는 "변경 안 함"(컨트롤러가 처리).
// 응답·표에 비밀번호(평문·해시)를 절대 표시/보관하지 않는다. 데이터는 useUserMgmtController 경유.

import { useEffect, useState } from 'react';
import { useUserMgmtController } from '../controller/useUserMgmtController.js';

const BLANK = {
  userId: '', name: '', password: '', role: 'R', department: '', departmentCode: '', active: 'Y',
};

export function UserMgmtPage() {
  const { users, refresh, createUser, updateUser } = useUserMgmtController();
  const [form, setForm] = useState(BLANK);
  const [editing, setEditing] = useState(false);

  useEffect(() => { refresh(); }, [refresh]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // 수정 진입 — 비밀번호는 응답에 없으므로 항상 빈칸으로 둔다(빈칸 = 변경 안 함).
  const startEdit = (u) => {
    setEditing(true);
    setForm({
      userId: u.userId ?? '', name: u.name ?? '', password: '',
      role: u.role ?? 'R', department: u.department ?? '',
      departmentCode: u.departmentCode ?? '', active: u.active ?? 'Y',
    });
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (editing) {
      const { userId, ...fields } = form;
      await updateUser(userId, fields); // 빈 비밀번호는 컨트롤러가 제거.
    } else {
      await createUser(form);
    }
    setForm(BLANK);
    setEditing(false);
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
          <button type="button" className="yh-btn" onClick={() => { setForm(BLANK); setEditing(false); }}>취소</button>
        )}
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
