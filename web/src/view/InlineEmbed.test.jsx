import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InlineEmbed } from './InlineEmbed.jsx';

describe('InlineEmbed', () => {
  it('renders an image embed with a remove (×) button at 612px', () => {
    render(<InlineEmbed embed={{ embedType: 'image', src: 'x.png', alt: '사진', figureWidthPx: 612 }} onRemove={() => {}} />);
    expect(screen.getByRole('img', { name: '사진' })).toBeInTheDocument();
    const fig = screen.getByRole('img', { name: '사진' }).closest('figure');
    expect(fig).toHaveStyle({ width: '612px' });
    expect(screen.getByRole('button', { name: '임베드 삭제' })).toBeInTheDocument();
  });

  it('calls onRemove when the × button is clicked', async () => {
    const onRemove = vi.fn();
    render(<InlineEmbed embed={{ embedType: 'image', src: 'x.png' }} onRemove={onRemove} />);
    await userEvent.click(screen.getByRole('button', { name: '임베드 삭제' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('renders an article reference card at 480px and hides × in readOnly', () => {
    render(<InlineEmbed embed={{ embedType: 'article', articleId: 'AKR1', title: '참조기사', widthPx: 480 }} readOnly />);
    const card = screen.getByText('참조기사').closest('figure');
    expect(card).toHaveStyle({ width: '480px' });
    expect(screen.queryByRole('button', { name: '임베드 삭제' })).toBeNull();
  });
});
