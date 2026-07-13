// 공통정보 지역/내용/속성 선택 다이얼로그 — 순수 표시/폼 컴포넌트(ADR-003). 그룹 체크박스 선택 UI만 담당한다.
// 지역/내용/속성 3용도를 한 컴포넌트가 처리한다 — 차이는 주입되는 groups/limit/title뿐이다.
// 택소노미 데이터(REGION_GROUPS 등)·필드값 반영은 부모(Step 3 WriterPage)가 metaTaxonomy.metaFieldConfig로
//   뽑아 주입한다 — 여기서는 parseTokens/joinTokens(값 문자열 ↔ 토큰 배열)만 쓰고 '적용' 시 onSubmit(조인 문자열)로 위임한다.
// selected는 순서 보존 배열(Set 아님) — 제출 시 기존 토큰의 상대 순서가 유지되고 신규 선택은 뒤에 붙는다(무의미한 diff 방지).
// value의 미등재(레거시 자유입력) 토큰은 '기존 값' 섹션에 체크 상태로 노출하고 사용자가 해제할 때만 제거한다 —
//   조용한 소실 금지(DB 비파괴 정신의 UI판). 한도 초과 상태 그대로의 제출도 허용한다(기존 데이터 강제 삭감 금지).
// 한도는 '추가'만 막는다 — 미체크 항목만 disabled, 체크된 항목·레거시는 항상 해제 가능(교체 허용).
// model/fetch/localStorage/window/document 호출 없음. 다른 다이얼로그(yh-table-dialog/yh-glyph-input/yh-url-embed/
//   yh-find-replace)와 충돌하지 않게 전용 클래스(yh-meta-dialog)·testid(meta-dialog)를 쓴다.

import { useEffect, useRef, useState } from 'react';
import { useFocusOnOpen } from './useFocusOnOpen.js';
import { parseTokens, joinTokens } from './metaTaxonomy.js';

export function MetaSelectDialog({
  open,
  title, // string — 다이얼로그 제목/aria-label ('지역'|'내용'|'속성')
  groups = [], // [{ label, items }] — 헤더+항목(속성은 단일 그룹)
  limit, // number — 최대 선택 수(지역/내용 5, 속성 3)
  value, // string — 현재 필드값(콤마 조인). 레거시 자유입력 토큰 포함 가능
  onSubmit, // (joined: string) => void — '적용' 시 조인 문자열 위임
  onClose, // () => void — 닫기/Esc(제출 없이 폐기)
}) {
  // 로컬 선택 state — 순서 보존 배열. 토글은 없으면 끝에 push, 있으면 remove.
  const [selected, setSelected] = useState(() => parseTokens(value));

  // open false→true 전환 시에만 parseTokens(value)로 재초기화한다 — 재오픈 시 이전 편집 잔존 금지.
  // 열려 있는 동안 value가 바뀌어도 편집 중인 선택을 리셋하지 않는다(wasOpen 가드 — TableEditDialog 계약).
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setSelected(parseTokens(value));
    wasOpen.current = open;
  }, [open, value]);

  // 열림 시 포커스를 첫 focusable(첫 체크박스, 항목이 없으면 '닫기' 버튼)로 이전 — 포커스가 에디터 본문에
  // 남으면 타이핑이 기사 본문에 삽입되고 Esc 닫기가 발화하지 않는다(27-editor-critical-fixes).
  const focusRef = useRef(null);
  useFocusOnOpen(focusRef, open);

  if (!open) return null;

  // 레거시(어느 그룹 items에도 없는) 토큰 — selected에서 파생하므로 한도 카운트에 자동 포함되고,
  // 해제하면 selected에서 빠져 섹션에서도 사라진다(추가 개념 없음).
  const knownItems = new Set(groups.flatMap((group) => group.items ?? []));
  const legacy = selected.filter((token) => !knownItems.has(token));

  const atLimit = selected.length >= limit;
  const toggle = (token) =>
    setSelected((prev) =>
      prev.includes(token) ? prev.filter((t) => t !== token) : [...prev, token],
    );

  // 포커스 대상 판정 — 첫 항목이 있는 그룹의 첫 체크박스 > 첫 레거시 체크박스 > 닫기 버튼.
  const firstGroupIdx = groups.findIndex((group) => (group.items ?? []).length > 0);
  const focusOnClose = firstGroupIdx === -1 && legacy.length === 0;

  // 닫기는 부모에 맡긴다(onSubmit 후 부모가 open을 내린다 — TableEditDialog submit 정책과 동형).
  const submit = () => {
    if (onSubmit) onSubmit(joinTokens(selected));
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) onClose();
  };

  return (
    <div
      className="yh-editor-dialog yh-meta-dialog"
      role="dialog"
      aria-label={title}
      data-testid="meta-dialog"
      onKeyDown={handleKeyDown}
    >
      <h2 className="yh-meta-dialog__title">{title}</h2>

      <div className="yh-meta-dialog__counter" data-testid="meta-dialog-counter">
        {selected.length}/{limit}
      </div>

      <div className="yh-meta-dialog__scroll">
        {groups.map((group, gi) => (
          <div className="yh-meta-dialog__group" key={`${group.label}-${gi}`}>
            <div className="yh-meta-dialog__group-label">{group.label}</div>
            <div className="yh-meta-dialog__items">
              {(group.items ?? []).map((token, ii) => {
                const checked = selected.includes(token);
                return (
                  // 항목 표기는 그룹 간 중복 가능성이 있어 key는 인덱스를 포함해 안정화한다(GlyphInputDialog 동일).
                  <label className="yh-meta-dialog__item" key={`${token}-${ii}`}>
                    <input
                      type="checkbox"
                      ref={gi === firstGroupIdx && ii === 0 ? focusRef : undefined}
                      data-testid={`meta-dialog-item-${gi}-${ii}`}
                      checked={checked}
                      disabled={!checked && atLimit}
                      onChange={() => toggle(token)}
                    />
                    {token}
                  </label>
                );
              })}
            </div>
          </div>
        ))}

        {legacy.length > 0 && (
          <div className="yh-meta-dialog__group" data-testid="meta-dialog-legacy">
            <div className="yh-meta-dialog__group-label">기존 값</div>
            <div className="yh-meta-dialog__items">
              {legacy.map((token, i) => (
                <label className="yh-meta-dialog__item" key={`${token}-${i}`}>
                  <input
                    type="checkbox"
                    ref={firstGroupIdx === -1 && i === 0 ? focusRef : undefined}
                    data-testid={`meta-dialog-legacy-item-${i}`}
                    checked
                    onChange={() => toggle(token)}
                  />
                  {token}
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="yh-meta-dialog__actions">
        <button
          type="button"
          className="yh-btn yh-btn--primary"
          data-testid="meta-dialog-submit"
          onClick={submit}
        >
          적용
        </button>
        <button
          type="button"
          className="yh-btn"
          data-testid="meta-dialog-close"
          ref={focusOnClose ? focusRef : undefined}
          onClick={() => onClose && onClose()}
        >
          닫기
        </button>
      </div>
    </div>
  );
}

export default MetaSelectDialog;
