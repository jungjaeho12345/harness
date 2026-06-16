// 기사 목록 우클릭 컨텍스트 메뉴 (news.md 기사 조회페이지). 메뉴별 항목 구성 + 활성 조건(권한·상태).
// transport 비의존 — 선택은 onSelect(key, article)로만 전달한다. 확인창/실제 동작은 컨트롤러(useViewController)가 한다.
//
// 활성 조건:
//  - 고침(포털제외)/포털고침: 상태 DPS + 권한 D만 활성(writer.do 편집 진입).
//  - 삭제요청: 상태 DPS + 권한 D/Z만 활성(approveDelete).
//  - Lock해제: 잠긴 행(LockYN='Y')에만 나타나고 권한 D/Z만 활성(R은 비활성).
//  - 이력보기/송고이력보기: 읽기 전용 — 모든 기사에서 활성(권한/상태 게이트 없음, 서버가 세션 인증). (step8)
//  - 후속/계속기사작성: 작성 권한(R/D/Z)에서 활성 — 파생은 새 기사 작성, 상태 게이트 없음. (step9)
//  - 재송(resend): DPS 기사 + D/Z에서만 활성 — 재송고=데스크 송고 행위, 서버 applyAction이 최종 강제. (step9)
//    (news.md 명세 부재 — 도출: followUp/continue=R/D/Z, resend=DPS+D/Z. 서버가 최종 권한 게이트.)
//  - 번역(translate): 세션만 있으면 활성 — 권한/상태 게이트 없음, 서버가 세션 인증·graceful degrade. (step10)
//  - 매핑(mapping): 표시만(아직 비활성 — step11에서 활성화).

// 활성(읽기 전용) 항목 — 이력은 모든 기사에서 볼 수 있다(서버가 세션 인증 게이트). (step8)
const HISTORY = Object.freeze({ key: 'history', label: '이력보기', enabled: true });
const SEND_HISTORY = Object.freeze({ key: 'sendHistory', label: '송고이력보기', enabled: true });
// 번역 — 세션만 있으면 활성(권한/상태 게이트 없음, 서버가 인증·외부 실패 graceful degrade). (step10)
const TRANSLATE = Object.freeze({ key: 'translate', label: '번역', enabled: true });

// 비활성(표시만) 항목 — 동작하지 않는다(각 후속 step이 자기 항목만 활성화).
const INACTIVE_ITEMS = Object.freeze([
  { key: 'mapping', label: '매핑' },
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
  // news.md 명세 부재 — 도출: 후속/계속기사작성은 작성 권한(R/D/Z)에서 활성(파생=새 기사 작성, 상태 게이트 없음).
  const canWrite = role === 'R' || role === 'D' || role === 'Z';
  // news.md 명세 부재 — 도출: 재송은 DPS + D/Z에서만 활성(재송고=데스크 송고). 서버 applyAction이 최종 강제.
  const canResend = isDPS && (role === 'D' || role === 'Z');

  const detail = { key: 'detail', label: '상세보기', enabled: true };
  const copyBody = { key: 'copyBody', label: '본문복사', enabled: true };
  const copyTitle = { key: 'copyTitle', label: '제목만복사', enabled: true };
  const edit = { key: 'edit', label: '편집', enabled: true };

  let items;
  if (menu === 'deskUnsent') {
    // 데스크 미송고: 편집 / 상세보기 / 이력보기 / 본문복사 / 제목만복사.
    items = [edit, detail, HISTORY, copyBody, copyTitle];
  } else {
    // 부서별 작성·개인별 수정·부서별 송고 공통 항목.
    items = [
      detail,
      HISTORY,
      SEND_HISTORY,
      copyBody,
      copyTitle,
      TRANSLATE,
      inactive('mapping'),
      { key: 'followUp', label: '후속기사작성', enabled: canWrite },
      { key: 'continue', label: '계속기사작성', enabled: canWrite },
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
