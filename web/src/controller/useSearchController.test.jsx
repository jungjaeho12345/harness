import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AppContext } from '../app/context.js';
import { useSearchController } from './useSearchController.js';
import { createFakeModel } from '../test/fakeModel.js';

function setup() {
  const model = createFakeModel({
    mediaItems: [
      { id: 'i1', type: 'image' }, { id: 'v1', type: 'video' },
    ],
    articles: [{ articleId: 'AKR1', title: '경제 기사', status: 'RDS' }],
  });
  const spyMedia = vi.spyOn(model, 'searchMedia');
  const wrapper = ({ children }) => (
    <AppContext.Provider value={{ model, identity: null, navigate: vi.fn(), replace: vi.fn(), setSession: vi.fn() }}>
      {children}
    </AppContext.Provider>
  );
  const { result } = renderHook(() => useSearchController(), { wrapper });
  return { result, model, spyMedia };
}

describe('useSearchController', () => {
  it('searchImages queries media with type=image', async () => {
    const { result, spyMedia } = setup();
    await act(async () => { await result.current.searchImages('cat'); });
    expect(spyMedia).toHaveBeenCalledWith('cat', 'image');
    expect(result.current.imageResults).toEqual([{ id: 'i1', type: 'image' }]);
  });

  it('searchVideos queries media with type=video', async () => {
    const { result, spyMedia } = setup();
    await act(async () => { await result.current.searchVideos('dog'); });
    expect(spyMedia).toHaveBeenCalledWith('dog', 'video');
    expect(result.current.videoResults).toEqual([{ id: 'v1', type: 'video' }]);
  });

  it('searchArticles queries the internal article DB', async () => {
    const { result } = setup();
    await act(async () => { await result.current.searchArticles('경제'); });
    expect(result.current.articleResults).toHaveLength(1);
    expect(result.current.articleResults[0].articleId).toBe('AKR1');
  });
});
