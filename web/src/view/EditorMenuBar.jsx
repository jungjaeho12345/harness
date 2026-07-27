// 에디터 상단 메뉴바 — 파일/편집/보기/맞춤법/표/도구/도움말 7개 메뉴 + 드롭다운.
// news.md "## 기사 상단 메뉴바"의 항목을 데이터 config(EDITOR_MENUS)로 둔다.
// 결선된 항목은 enabledIds로만 활성화된다(미전달 시 전부 비활성 — phase 8 쉘 하위호환). 그 외 항목은 placeholder.
// 순수 UI: model/fetch 없음. 활성 항목 클릭 시 onSelect(item.id)로 부모(WriterPage)에 위임한다.

import { useEffect, useRef, useState } from 'react';

// 7개 상단 메뉴와 항목 (news.md 그대로). 항목: {id(안정 키), label, shortcut?(표시용)}.
export const EDITOR_MENUS = Object.freeze([
  {
    id: 'file', label: '파일',
    items: [
      { id: 'file.new', label: '새문서' },
      { id: 'file.open', label: '문서열기' },
      { id: 'file.save', label: '저장' },
      { id: 'file.saveAs', label: '다른이름으로 저장' },
      { id: 'file.recover', label: '복구' },
      { id: 'file.print', label: '인쇄' },
      { id: 'file.printPreview', label: '인쇄미리보기' },
      { id: 'file.close', label: '닫기' },
    ],
  },
  {
    id: 'edit', label: '편집',
    items: [
      { id: 'edit.undo', label: '되돌리기' },
      { id: 'edit.redo', label: '다시실행' },
      { id: 'edit.cut', label: '잘라내기' },
      { id: 'edit.copy', label: '복사' },
      { id: 'edit.paste', label: '붙여넣기' },
      { id: 'edit.pasteOriginal', label: '원본 붙여넣기' },
      { id: 'edit.pasteText', label: '텍스트 붙여넣기' },
      { id: 'edit.findReplace', label: '찾기/바꾸기' },
      { id: 'edit.selectAll', label: '전체 선택' },
      { id: 'edit.selectParagraph', label: '문단 선택' },
      { id: 'edit.selectLine', label: '한줄 선택' },
      { id: 'edit.selectWord', label: '단어 선택' },
      { id: 'edit.sortDocument', label: '문서 정렬' },
      { id: 'edit.sortParagraph', label: '문단 정렬' },
      { id: 'edit.deleteLine', label: '한줄 지우기' },
      { id: 'edit.deleteWord', label: '단어 지우기' },
      { id: 'edit.insertEnd', label: '(끝)삽입', shortcut: 'Alt+Y' },
      { id: 'edit.insertContinue', label: '(계속)삽입', shortcut: 'Ctrl+Y' },
    ],
  },
  {
    id: 'view', label: '보기',
    items: [
      { id: 'view.toUpper', label: '대문자로 바꾸기' },
      { id: 'view.toLower', label: '소문자로 바꾸기' },
      { id: 'view.capitalize', label: '첫글자 대문자로' },
      { id: 'view.toggleCase', label: '대/소문자 전환' },
      { id: 'view.justify', label: '양쪽으로 정렬' },
      { id: 'view.alignLeft', label: '왼쪽으로 정렬' },
      { id: 'view.alignCenter', label: '가운데로 정렬' },
      { id: 'view.alignRight', label: '오른쪽으로 정렬' },
    ],
  },
  {
    id: 'spell', label: '맞춤법',
    items: [
      { id: 'spell.checkAll', label: '통합 맞춤법 검사' },
      { id: 'spell.checkParagraph', label: '문단식 검사' },
      { id: 'spell.checkToCaret', label: '현재위치까지 검사' },
      { id: 'spell.checkFromCaret', label: '현재위치부터 검사' },
      { id: 'spell.checkOff', label: '통합 맞춤법 검사 안함' },
    ],
  },
  {
    id: 'table', label: '표',
    items: [
      { id: 'table.insert', label: '표 삽입' },
      { id: 'table.delete', label: '표 삭제' },
      { id: 'table.copy', label: '표 복사' },
      { id: 'table.cut', label: '표 잘라내기' },
      { id: 'table.deleteRow', label: '행 삭제' },
      { id: 'table.deleteCol', label: '열 삭제' },
      { id: 'table.addRowAbove', label: '위에 행 추가' },
      { id: 'table.addRowBelow', label: '아래에 행 추가' },
      { id: 'table.addColLeft', label: '왼쪽에 열 추가' },
      { id: 'table.addColRight', label: '오른쪽에 열 추가' },
    ],
  },
  {
    id: 'tools', label: '도구',
    items: [
      { id: 'tools.abbrConvert', label: '약어변환' },
      { id: 'tools.abbrManage', label: '약어관리' },
      { id: 'tools.symbolInput', label: '약물 입력' },
      { id: 'tools.insertDate', label: '날짜 삽입' },
      { id: 'tools.fileInfo', label: '파일 정보' },
      { id: 'tools.insertImage', label: '그림 삽입' },
      { id: 'tools.insertLink', label: '링크 삽입' },
      { id: 'tools.insertYoutube', label: '유튜브 영상 삽입' },
      { id: 'tools.insertLocalVideo', label: '로컬영상 삽입' },
      { id: 'tools.insertAudio', label: '오디오 삽입' },
      { id: 'tools.publishPhoto', label: '사진발행/DB등록' },
      { id: 'tools.historyCompare', label: '기사이력비교' },
      { id: 'tools.simpTradConvert', label: '간체↔번체 변환' },
      { id: 'tools.memo', label: '메모장' },
      { id: 'tools.uiLanguage', label: 'UI 언어 설정' },
    ],
  },
  {
    id: 'help', label: '도움말',
    items: [
      { id: 'help.open', label: '도움말 열기' },
      { id: 'help.about', label: '에디터 정보' },
      { id: 'help.preferences', label: '환경설정' },
    ],
  },
]);

// t는 선택적 번역기 (key, fallback?) => string. Step 2(42-editor-ui-language)에서 라벨 국제화용으로 주입된다.
// t 미주입 시 fallback(=원문 label)을 그대로 반환 → 기존 호출부·테스트가 바이트 동일로 통과(phase 8 하위호환).
// t 주입 + lang='ko'면 반환값은 fallback이 아니라 카탈로그 값 MESSAGES.ko[id]인데, 이는 원문 label과 바이트 동일해야 하는
// 불변식(i18n.test.js 강제)이라 표시 텍스트가 동일하다.
export function EditorMenuBar({ onSelect, enabledIds, t }) {
  const [openId, setOpenId] = useState(null);
  const ref = useRef(null);

  // t 미전달 시 항등 폴백 — fallback(원문 라벨)을 그대로 반환한다. 표시 텍스트만 번역, testid/aria 키는 원문 불변.
  const tr = t || ((k, f) => f);

  // 활성 항목 id 집합 — 배열/Set 모두 허용. 미전달(undefined)이면 빈 집합 → 전 항목 비활성(phase 8 하위호환).
  const enabledSet = enabledIds instanceof Set ? enabledIds : new Set(enabledIds || []);

  // 메뉴가 열려 있을 때만 바깥 클릭·Esc 리스너를 단다(한 번에 하나만 열림).
  useEffect(() => {
    if (!openId) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpenId(null); };
    const onKey = (e) => { if (e.key === 'Escape') setOpenId(null); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openId]);

  return (
    <div className="yh-editor-menubar" role="menubar" data-testid="menubar" ref={ref}>
      {EDITOR_MENUS.map((menu) => {
        const open = openId === menu.id;
        return (
          <div key={menu.id} className="yh-editor-menubar__group">
            <button
              type="button"
              role="menuitem"
              className="yh-editor-menubar__top"
              aria-haspopup="true"
              aria-expanded={open}
              // 마우스 전용 — Tab 포커스 제외 + mousedown 기본동작(포커스 이동) 차단.
              // 키보드는 항상 본문 편집에 남고, 클릭해도 에디터 캐럿이 보존된다(캐럿 위치 삽입 기능의 전제).
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpenId((cur) => (cur === menu.id ? null : menu.id))}
            >
              {tr(menu.id, menu.label)}
            </button>
            {open && (
              // data-testid는 원문 label 기준 안정 키(예: menu-도구) — 언어 전환에도 불변. 표시 텍스트만 번역한다.
              <ul className="yh-editor-menubar__dropdown" role="menu" data-testid={`menu-${menu.label}`}>
                {menu.items.map((item) => (
                  <li key={item.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      className="yh-editor-menubar__item"
                      // 마우스 전용 — Tab 포커스 제외 + 포커스 이동 차단(상단 버튼과 동일).
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      // enabledIds에 든 항목만 활성. 그 외(미결선)는 비활성 placeholder.
                      disabled={!enabledSet.has(item.id)}
                      // 활성 항목만 onSelect 위임(disabled 항목은 호출되지 않음). 선택 즉시 드롭다운을 닫는다 —
                      // 항목 목록이 상단에 계속 떠 있지 않게 한다(표준 메뉴 UX, EditorContextMenu의 onSelect→onClose와 동형).
                      onClick={() => {
                        if (!enabledSet.has(item.id)) return;
                        if (onSelect) onSelect(item.id);
                        setOpenId(null);
                      }}
                    >
                      <span className="yh-editor-menubar__label">{tr(item.id, item.label)}</span>
                      {/* shortcut(키 표기)은 언어 무관 — 번역하지 않고 그대로 표시한다. */}
                      {item.shortcut && (
                        <span className="yh-editor-menubar__shortcut" aria-hidden="true">{item.shortcut}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default EditorMenuBar;
