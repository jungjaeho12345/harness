// 배부 대상 관리페이지(distMgmt.do, 권한 Z 전용) — 배부 수신처(언론사/비언론사) 조회/등록/수정/비활성 (ADR-008).
// 삭제 없음 — 비활성(soft delete)만 있다. 비활성 행도 목록에 남고, 수정 폼의 활성 select로 되돌린다(DB 비파괴).
// spoolDir는 문자열 저장일 뿐 — 이 화면은 폴더를 만들거나 파일을 다루지 않는다(스풀 쓰기는 phase 47 — ADR-008).
// 비-Z 접근은 App 라우트 가드가 list.do로 보내지만, 실제 인가 강제는 서버 Z 게이트다(ADR-004 — 프론트 가드는 UX).

import { useEffect, useState } from 'react';
import { useDistMgmtController } from '../controller/useDistMgmtController.js';

const BLANK = { name: '', kind: 'press', spoolDir: '', active: 'Y' };

// 유형 표시 라벨 — 미지의 값은 원문 그대로 보여준다(서버가 진실이고, 화면이 값을 숨기지 않는다).
const KIND_LABEL = { press: '언론사', nonpress: '비언론사' };

// 서버 거부 사유(distributionTargetService) → 사용자 문구. 검증의 진실은 서버이며 여기서는 안내만 한다.
const REASON_MESSAGE = {
  unauthenticated: '로그인이 필요합니다. 다시 로그인해 주세요.',
  forbidden: '권한이 없습니다. 배부 대상 관리는 관리자(Z) 전용입니다.',
  'not-found': '대상을 찾을 수 없습니다. 목록을 새로 조회해 주세요.',
  'invalid-name': '수신처명을 확인해 주세요(1~100자).',
  'invalid-kind': '유형은 언론사 또는 비언론사만 가능합니다.',
  'invalid-spool-dir': '스풀 폴더명을 확인해 주세요(소문자 영문·숫자로 시작, 영문·숫자와 - _ 만, 1~64자).',
  'duplicate-spool-dir': '이미 사용 중인 스풀 폴더명입니다. 다른 이름을 입력해 주세요.',
  'invalid-active': '활성 값은 Y 또는 N만 가능합니다.',
  // 전역 에러 핸들러·httpModel 정규화 토큰(step7) — 화면 공통 안내 문구.
  'internal-error': '서버 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
  'network-error': '서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  'invalid-response': '서버 응답을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
};

function reasonMessage(reason) {
  return REASON_MESSAGE[reason] ?? `요청을 처리하지 못했습니다 (${reason}).`;
}

export function DistMgmtPage() {
  const { targets, refresh, createTarget, updateTarget, deactivateTarget } = useDistMgmtController();
  const [form, setForm] = useState(BLANK);
  // 수정 대상 id — 폼 입력이 아니라 행 객체에서 받는다(문자열화 없이 숫자 그대로 서버·계약의 엄격 비교에 맞춘다).
  const [editingId, setEditingId] = useState(null);
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
  const editing = editingId !== null;

  const startEdit = (t) => {
    setEditingId(t.id);
    setForm({
      name: t.name ?? '', kind: t.kind ?? 'press', spoolDir: t.spoolDir ?? '', active: t.active ?? 'Y',
    });
    setError('');
  };

  const reset = () => { setForm(BLANK); setEditingId(null); setError(''); };

  const onSubmit = async (e) => {
    e.preventDefault();
    // id는 body에 싣지 않는다 — 대상 식별은 URL(PUT /:id)이 하고, 서버는 id를 수정 대상 필드로 받지 않는다.
    const r = editing ? await updateTarget(editingId, form) : await createTarget(form);
    if (r && r.ok) { reset(); return; }
    setError(reasonMessage(r && r.reason)); // 실패 시 입력값을 유지해 고쳐서 재제출할 수 있게 한다.
  };

  // 확인 대화상자를 두지 않는다 — 비활성은 되돌릴 수 있는 조작이다(행이 남고 '수정' 폼의 활성 select로 재활성화).
  const onDeactivate = async (t) => {
    const r = await deactivateTarget(t.id);
    setError(r && r.ok ? '' : reasonMessage(r && r.reason));
  };

  return (
    <main className="yh-page">
      <h1>배부 대상 관리</h1>

      <form className="yh-card" onSubmit={onSubmit} data-testid="dist-form">
        <div className="yh-field">
          <label htmlFor="dist-name">수신처명</label>
          <input id="dist-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="dist-kind">유형</label>
          <select id="dist-kind" value={form.kind} onChange={(e) => set('kind', e.target.value)}>
            <option value="press">언론사</option>
            <option value="nonpress">비언론사</option>
          </select>
        </div>
        <div className="yh-field">
          <label htmlFor="dist-spool">스풀 폴더</label>
          <input
            id="dist-spool"
            value={form.spoolDir}
            onChange={(e) => set('spoolDir', e.target.value)}
            placeholder="예: gana-ilbo"
          />
          <small>소문자 영문·숫자로 시작 · 영문·숫자와 - _ 만 · 1~64자 (배부 스풀 하위 폴더명)</small>
        </div>
        <div className="yh-field">
          <label htmlFor="dist-active">활성</label>
          <select id="dist-active" value={form.active} onChange={(e) => set('active', e.target.value)}>
            <option value="Y">Y</option>
            <option value="N">N</option>
          </select>
        </div>
        <button type="submit" className="yh-btn yh-btn--primary">{editing ? '수정' : '생성'}</button>
        {editing && (
          <button type="button" className="yh-btn" onClick={reset}>취소</button>
        )}
        {error && <p role="alert" data-testid="dist-error">{error}</p>}
      </form>

      <table className="yh-table">
        <thead>
          <tr><th>수신처명</th><th>유형</th><th>스풀 폴더</th><th>활성</th><th></th></tr>
        </thead>
        <tbody>
          {targets.map((t) => (
            <tr key={t.id} data-testid={`dist-row-${t.id}`}>
              <td>{t.name}</td>
              <td>{KIND_LABEL[t.kind] ?? t.kind}</td>
              <td>{t.spoolDir}</td>
              <td>{t.active}</td>
              <td>
                <button type="button" className="yh-btn" onClick={() => startEdit(t)}>수정</button>
                {t.active === 'Y' && (
                  <button type="button" className="yh-btn" onClick={() => onDeactivate(t)}>비활성</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

export default DistMgmtPage;
