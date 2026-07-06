// 다이얼로그 열림(open falsy→truthy) 시 지정 요소로 포커스를 이전하는 view 유틸 훅(ADR-003 — React/DOM 표준만, transport 무관).
// 에디터 다이얼로그들은 <Editor>(contentEditable)와 형제로 인라인 렌더되어 열려도 Editor가 DOM 포커스를 계속 쥔다 —
// 그 상태로 타이핑하면 입력이 기사 본문에 삽입되고(오염), 다이얼로그 루트 onKeyDown(Escape 닫기)도 발화하지 않는다.
// ref는 항상 실재하는 focusable 요소에 달아라: 논리적 첫 텍스트 입력(input/textarea), 없으면 '닫기' 버튼.
// 본문/설정을 바꾸는 액션 버튼(포커스 상태 Space/Enter로 우발 실행)·bare div(focus()가 activeElement를 못 바꿈)는 금지.
import { useEffect } from 'react';

export function useFocusOnOpen(ref, open) {
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [ref, open]);
}

export default useFocusOnOpen;
