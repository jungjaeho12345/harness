// 임베딩 검색 컨트롤러 — 이미지(Google)/영상(YouTube)은 searchMedia, 글기사는 searchArticles.
// 외부 검색이 실패해도 throw 없이 빈 결과를 보여준다(Model이 {items,error}로 정규화 — news.md).

import { useCallback, useState } from 'react';
import { useAppContext } from '../app/context.js';

export function useSearchController() {
  const { model } = useAppContext();
  const [imageResults, setImageResults] = useState([]);
  const [videoResults, setVideoResults] = useState([]);
  const [articleResults, setArticleResults] = useState([]);

  const searchImages = useCallback(async (q) => {
    const r = await model.searchMedia(q, 'image');
    const items = (r && r.items) || [];
    setImageResults(items);
    return items;
  }, [model]);

  const searchVideos = useCallback(async (q) => {
    const r = await model.searchMedia(q, 'video');
    const items = (r && r.items) || [];
    setVideoResults(items);
    return items;
  }, [model]);

  const searchArticles = useCallback(async (q) => {
    const r = await model.searchArticles(q);
    const items = (r && r.items) || [];
    setArticleResults(items);
    return items;
  }, [model]);

  return { imageResults, videoResults, articleResults, searchImages, searchVideos, searchArticles };
}
