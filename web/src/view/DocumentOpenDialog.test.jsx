import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DocumentOpenDialog } from './DocumentOpenDialog.jsx';

// 파일>문서열기 DB 기사 피커 다이얼로그 — 순수·controlled(ADR-003). model/fetch/window/document 미접근 —
//   표시와 이벤트 위임(onSearch/onPick/onClose)만 단언한다. articles는 부모가 채운다(passthrough 결과).
// noop 콜백 묶음 — 각 테스트가 관심 있는 콜백만 vi.fn()으로 덮어쓴다(MetaSelectDialog 컨벤션).
function noopProps(overrides = {}) {
  return {
    open: true,
    articles: [
      { articleId: 'AKR1', title: '첫 기사', status: 'RDS' },
      { articleId: 'AKR2', title: '둘째 기사', status: 'DPS' },
    ],
    onSearch: vi.fn(),
    onPick: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

describe('DocumentOpenDialog — 렌더/목록', () => {
  it('open=false면 렌더하지 않는다(null)', () => {
    render(<DocumentOpenDialog {...noopProps({ open: false })} />);
    expect(screen.queryByTestId('doc-open-dialog')).toBeNull();
  });

  it('열리면 dialog(aria-label=문서열기)와 각 기사 행(articleId·제목)이 렌더된다', () => {
    render(<DocumentOpenDialog {...noopProps()} />);
    expect(screen.getByRole('dialog', { name: '문서열기' })).toBeInTheDocument();
    expect(screen.getByText('AKR1')).toBeInTheDocument();
    expect(screen.getByText('첫 기사')).toBeInTheDocument();
    expect(screen.getByText('AKR2')).toBeInTheDocument();
    expect(screen.getByText('둘째 기사')).toBeInTheDocument();
  });

  it('빈 목록이면 빈 상태 문구를 보여준다', () => {
    render(<DocumentOpenDialog {...noopProps({ articles: [] })} />);
    expect(screen.getByTestId('doc-open-empty')).toHaveTextContent('기사가 없습니다.');
  });

  it('필드가 없는 행은 —로 방어적 렌더한다(제목/상태 누락)', () => {
    render(<DocumentOpenDialog {...noopProps({ articles: [{ articleId: 'AKR9' }] })} />);
    const row = screen.getByTestId('doc-open-row-0');
    expect(row).toHaveTextContent('AKR9');
    // 제목·상태가 없으면 '—'로 표시(없는 필드로 죽지 않음).
    expect(row.querySelectorAll('span')[1].textContent).toBe('—');
    expect(row.querySelectorAll('span')[2].textContent).toBe('—');
  });
});

describe('DocumentOpenDialog — 검색 위임', () => {
  it('검색어 입력 후 검색 버튼 클릭 시 onSearch(query)가 호출된다', () => {
    const onSearch = vi.fn();
    render(<DocumentOpenDialog {...noopProps({ onSearch })} />);
    fireEvent.change(screen.getByTestId('doc-open-search'), { target: { value: '올림픽' } });
    fireEvent.click(screen.getByTestId('doc-open-search-btn'));
    expect(onSearch).toHaveBeenCalledWith('올림픽');
  });

  it('검색 입력에서 Enter 제출 시 onSearch(query)가 호출된다', () => {
    const onSearch = vi.fn();
    render(<DocumentOpenDialog {...noopProps({ onSearch })} />);
    const input = screen.getByTestId('doc-open-search');
    fireEvent.change(input, { target: { value: '선거' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSearch).toHaveBeenCalledWith('선거');
  });
});

describe('DocumentOpenDialog — 선택/닫기 위임', () => {
  it('행 클릭 시 onPick이 그 기사로 호출된다', () => {
    const onPick = vi.fn();
    const props = noopProps({ onPick });
    render(<DocumentOpenDialog {...props} />);
    fireEvent.click(screen.getByTestId('doc-open-row-1'));
    expect(onPick).toHaveBeenCalledWith(props.articles[1]);
  });

  it("닫기 버튼 또는 Esc로 onClose가 호출되고 onPick은 호출되지 않는다", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<DocumentOpenDialog {...noopProps({ onPick, onClose })} />);
    fireEvent.click(screen.getByTestId('doc-open-close'));
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('onSearch/onPick/onClose 미전달 시 검색/선택/닫기/Esc가 예외를 던지지 않는다', () => {
    render(<DocumentOpenDialog open articles={[{ articleId: 'AKR1', title: '제목', status: 'RDS' }]} />);
    expect(() => fireEvent.click(screen.getByTestId('doc-open-search-btn'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('doc-open-row-0'))).not.toThrow();
    expect(() => fireEvent.click(screen.getByTestId('doc-open-close'))).not.toThrow();
    expect(() => fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })).not.toThrow();
  });
});

// 27-editor-critical-fixes: 열림 시 포커스 이전 — 포커스가 에디터 본문(contentEditable)에 남으면
// 타이핑이 기사 본문에 삽입되고 Esc 닫기도 발화하지 않는다(MetaSelectDialog 계약과 동형).
describe('DocumentOpenDialog — 열림 시 포커스 이전', () => {
  it('open=true로 렌더된 직후 document.activeElement가 검색 입력이다', () => {
    render(<DocumentOpenDialog {...noopProps()} />);
    expect(document.activeElement).toBe(screen.getByTestId('doc-open-search'));
  });

  it('닫힘→열림(open false→true) 전이에서도 포커스가 검색 입력으로 이동한다', () => {
    const { rerender } = render(<DocumentOpenDialog {...noopProps({ open: false })} />);
    rerender(<DocumentOpenDialog {...noopProps({ open: true })} />);
    expect(document.activeElement).toBe(screen.getByTestId('doc-open-search'));
  });
});

// 도구 메뉴 팝업 공통 — 화면 중앙 모달 스타일(yh-editor-dialog 공용 클래스) + 전용 클래스(yh-doc-open-dialog).
describe('DocumentOpenDialog — 중앙 모달 공통 스타일', () => {
  it('루트가 yh-editor-dialog 공용 + yh-doc-open-dialog 전용 클래스를 가진다', () => {
    render(<DocumentOpenDialog {...noopProps()} />);
    const root = screen.getByTestId('doc-open-dialog');
    expect(root).toHaveClass('yh-editor-dialog');
    expect(root).toHaveClass('yh-doc-open-dialog');
  });
});
