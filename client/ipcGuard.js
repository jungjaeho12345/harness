// IPC sender 검증 (phase 62 step1) — 신뢰 경계는 셸 메인이다(ADR-004의 서버 규율과 같은 축).
// 로컬 창(file:// + 현재 로컬 창의 contents id)에서 온 요청만 신뢰한다. 창 구조가 바뀌어도
// 원격 페이지가 IPC를 잡을 수 없어야 한다 — 조건이 하나라도 어긋나면 false(fail-closed).

export function isTrustedSender({ senderUrl, senderContentsId, localContentsId } = {}) {
  if (typeof senderUrl !== 'string' || !senderUrl.startsWith('file://')) return false;
  if (localContentsId === null || localContentsId === undefined) return false; // 로컬 창 없음 = 신뢰 대상 없음.
  return senderContentsId === localContentsId;
}
