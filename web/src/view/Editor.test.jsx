import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Editor } from './Editor.jsx';
import { textBlock, embedBlock } from './editorContent.js';
import { COLORS } from './editorColoring.js';

describe('Editor', () => {
  it('exposes aria-label="본문" but shows no visible "본문" label text', () => {
    render(<Editor blocks={[textBlock('제목')]} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    expect(box).toBeInTheDocument();
    // 본문 영역 위에 '본문' 라벨 텍스트는 없다(접근성 aria-label만 유지).
    expect(screen.queryByText('본문')).toBeNull();
  });

  it('colors title/subtitle/body lines per the structure rule', () => {
    render(<Editor blocks={[textBlock('제목'), textBlock('부제'), textBlock('본문1'), textBlock('본문2'), textBlock('본문3'), textBlock('본문4'), textBlock('본문5')]} />);
    expect(screen.getByText('제목')).toHaveStyle({ color: COLORS.title });
    expect(screen.getByText('부제')).toHaveStyle({ color: COLORS.subtitle });
    expect(screen.getByText('본문5')).toHaveStyle({ color: COLORS.body });
  });

  it('renders embeds and wires the × button to onRemoveEmbed with the block index', async () => {
    const onRemoveEmbed = vi.fn();
    render(
      <Editor
        blocks={[textBlock('제목'), embedBlock({ embedType: 'image', src: 'x.png' })]}
        onRemoveEmbed={onRemoveEmbed}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: '임베드 삭제' }));
    expect(onRemoveEmbed).toHaveBeenCalledWith(1);
  });

  it('reflects the spellcheck prop and forwards keydown', async () => {
    const onKeyDown = vi.fn();
    render(<Editor blocks={[textBlock('x')]} spellcheck onKeyDown={onKeyDown} />);
    const box = screen.getByRole('textbox', { name: '본문' });
    expect(box).toHaveAttribute('spellcheck', 'true');
    box.focus();
    await userEvent.keyboard('a');
    expect(onKeyDown).toHaveBeenCalled();
  });
});
