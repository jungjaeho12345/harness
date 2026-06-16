// 기사 목록 우클릭 컨텍스트 메뉴 (news.md 기사 조회페이지). 메뉴별 항목 구성 + 활성 조건(권한·상태).
// transport 비의존 — 선택은 onSelect(key, article)로만 전달한다. 확인창/실제 동작은 컨트롤러(useViewController)가 한다.
//
// 활성 조건:
//  - 고침(포털제외)/포털고침: 상태 DPS + 권한 D만 활성(writer.do 편집 진입).
//  - 삭제요청: 상태 DPS + 권한 D/Z만 활성(approveDelete).
//  - Lock해제: 잠긴 행(LockYN='Y')에만 나타나고 권한 D/Z만 활성(R은 비활성).
//  - 이력보기/송고이력보기: 활성(새 창에 이력 표시 — phase 1-history).
//  - 후속기사작성/계속기사작성: 항상 활성(일반 신규 작성 진입 — 권한·상태 제한 없음).
//  - 재송: 상태 DPS + 권한 D/Z만 활성(DPS 재송고=send 전이는 D/Z만 통과, R 거부).
//  - 매핑: 항상 활성(일반 편집 진입 — 권한·상태 제한 없음, 후속/계속과 동일. 잠금·권한은 서버 lock/PUT이 강제).
//  - 번역: 표시만(항상 비활성, provider 미결정 — 다음 과제).

// 비활성(표시만) 항목 — 동작하지 않는다(번역: provider 미결정, 다음 과제 소관).
const INACTIVE_ITEMS = Object.freeze([
  { key: 'translate', label: '번역' },
]);

function inactive(key) {
  const it = INACTIVE_ITEMS.find((x) => x.key === key);
  return { key, label: it.label, enabled: false };
}

// 메뉴별 항목 구성. 각 항목 {key, label, enabled}.
export function buildContextMenuItems(menu, article = {}, identity = {}) {
  const role = identity && identity.role;
  const isDPS = article && article.status === 'DPS';
  const isLocked = article && article.lockYN === 'Y';
  const canRevise = isDPS && role === 'D'; // 고침/포털고침: DPS + D
  const canDelete = isDPS && (role === 'D' || role === 'Z'); // 삭제요청: DPS + D/Z
  const canUnlock = role === 'D' || role === 'Z'; // Lock해제: D/Z
  const canResend = isDPS && (role === 'D' || role === 'Z'); // 재송(DPS 재송고): DPS + D/Z

  const detail = { key: 'detail', label: '상세보기', enabled: true };
  const copyBody = { key: 'copyBody', label: '본문복사', enabled: true };
  const copyTitle = { key: 'copyTitle', label: '제목만복사', enabled: true };
  const edit = { key: 'edit', label: '편집', enabled: true };
  const history = { key: 'history', label: '이력보기', enabled: true };
  const sendHistory = { key: 'sendHistory', label: '송고이력보기', enabled: true };

  let items;
  if (menu === 'deskUnsent') {
    // 데스크 미송고: 편집 / 상세보기 / 이력보기 / 본문복사 / 제목만복사.
    items = [edit, detail, history, copyBody, copyTitle];
  } else {
    // 부서별 작성·개인별 수정·부서별 송고 공통 항목.
    items = [
      detail,
      history,
      sendHistory,
      copyBody,
      copyTitle,
      inactive('translate'),
      { key: 'mapping', label: '매핑', enabled: true },
      { key: 'followUp', label: '후속기사작성', enabled: true },
      { key: 'continue', label: '계속기사작성', enabled: true },
      { key: 'reviseNoPortal', label: '고침(포털제외)', enabled: canRevise },
      { key: 'revisePortal', label: '포털고침', enabled: canRevise },
      { key: 'requestDelete', label: '삭제요청', enabled: canDelete },
      { key: 'resend', label: '재송', enabled: canResend },
    ];
    // 부서별 송고에는 편집 항목이 추가된다(news.md).
    if (menu === 'deptSend') items.push(edit);
  }

  // 잠긴 기사에는 Lock해제 항목이 나타난다(D/Z 활성, R 비활성).
  if (isLocked) {
    items = [...items, { key: 'releaseLock', label: 'Lock해제', enabled: canUnlock }];
  }
  return items;
}

export function ContextMenu({ menu, article, identity, position = {}, onSelect, onClose }) {
  const items = buildContextMenuItems(menu, article, identity);
  const style = { position: 'absolute', left: position.x ?? 0, top: position.y ?? 0 };

  return (
    <ul className="yh-context-menu" role="menu" style={style} onMouseLeave={onClose}>
      {items.map((it) => (
        <li key={it.key} role="none">
          <button
            type="button"
            role="menuitem"
            className="yh-context-menu__item"
            disabled={!it.enabled}
            onClick={() => {
              if (!it.enabled) return;
              if (onSelect) onSelect(it.key, article);
              if (onClose) onClose();
            }}
          >
            {it.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

export default ContextMenu;
