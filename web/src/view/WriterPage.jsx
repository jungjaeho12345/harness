// 기사 작성페이지(writer.do) — 좌 에디터 : 우 메타데이터 = 60:40.
// 메타 4탭(공통정보/이미지/영상/글기사), 탭 위 송고/보류/KILL 버튼(권한·상태·진입별 표시 규칙).
// 가드: 송고는 "(끝)" 필요, 송고/보류는 제목(첫 줄) 필요. 각 액션은 확인창 후에만 진행.
// 데이터는 useWriteController/useSearchController 경유(transport 직접 호출 금지, ADR-003).

import { useState } from 'react';
import { useAppContext } from '../app/context.js';
import { useWriteController } from '../controller/useWriteController.js';
import { useSearchController } from '../controller/useSearchController.js';
import { Editor } from './Editor.jsx';
import { submitButtons, SUBMIT_LABELS } from './writerButtons.js';
import { deserialize, serialize, hasEndMarker } from './editorContent.js';
import { insertEndMarker, isInsertEndMarker } from './editorShortcuts.js';
import { makeImageEmbed, makeVideoEmbed, makeArticleEmbed } from './clipboardEmbed.js';
import { bodyTitle, mergeTextIntoBody, appendEmbedToBody } from './writerBody.js';

const META_TABS = [
  { key: 'common', label: '공통정보' },
  { key: 'image', label: '이미지' },
  { key: 'video', label: '영상' },
  { key: 'article', label: '글기사' },
];

// 매핑 — 편집 진입 시 읽기전용으로 보여주는 메타 필드(news.md 기사 편집 기능).
const READONLY_LABELS = [
  ['articleId', '기사아이디'],
  ['modifier', '수정자'],
  ['sender', '송고자'],
  ['department', '부서'],
  ['departmentCode', '부서코드'],
  ['createdAt', '작성시간'],
  ['editedAt', '편집시간'],
  ['sentAt', '송고시간'],
];

const ACTION_VERB = { send: '송고', hold: '보류', kill: 'KILL' };

export function WriterPage() {
  const { identity } = useAppContext();
  const {
    tabs, activeTabId, activeTab,
    addTab, closeTab, selectTab,
    updateField, submit,
  } = useWriteController();
  const search = useSearchController();

  const [metaTab, setMetaTab] = useState('common');
  const [spell, setSpell] = useState(false);

  const body = activeTab.fields.body;
  const blocks = deserialize(body);

  // 본문 타이핑 → 정규 순서로 재직렬화 + 제목(첫 줄) 동기화.
  const onTextChange = (text) => {
    const next = mergeTextIntoBody(body, text);
    updateField('body', next);
    updateField('title', bodyTitle(next));
  };

  // Alt+Y → "(끝)" 최종 블록 삽입 + 맞춤법 검사 on(중복이면 무삽입).
  const onKeyDown = (e) => {
    if (isInsertEndMarker(e)) {
      e.preventDefault();
      const r = insertEndMarker(blocks);
      updateField('body', serialize(r.blocks));
      setSpell(true);
    }
  };

  const onRemoveEmbed = (blockIndex) => {
    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const next = blocks.slice();
    next.splice(blockIndex, 1);
    updateField('body', serialize(next));
  };

  const insertEmbed = (embed) => {
    if (!embed) return;
    updateField('body', appendEmbedToBody(body, embed));
  };

  // 송고/보류/KILL — 가드 후 확인창, 확인 시에만 진행.
  const onAction = async (action) => {
    const title = bodyTitle(body);
    if ((action === 'send' || action === 'hold') && !title) {
      window.alert(`제목이 없어 ${ACTION_VERB[action]}할 수 없습니다`);
      return;
    }
    if (action === 'send' && !hasEndMarker(blocks)) {
      window.alert('본문에 "(끝)" 표시가 없어 송고할 수 없습니다');
      return;
    }
    if (!window.confirm(`${ACTION_VERB[action]}하시겠습니까?`)) return;
    await submit(action);
  };

  const buttons = submitButtons({
    mode: activeTab.mode,
    status: activeTab.status,
    role: identity && identity.role,
    articleId: activeTab.articleId,
  });

  return (
    <main className="yh-page">
      {/* 작성 탭 스트립 — ＋로 새 탭, ×로 닫기, 클릭으로 전환 */}
      <div className="yh-tabs" data-testid="writer-tabs">
        {tabs.map((t) => (
          <span key={t.id} className={`yh-tab ${t.id === activeTabId ? 'yh-tab--active' : ''}`}>
            <button type="button" className="yh-tab__label" onClick={() => selectTab(t.id)}>
              {t.fields.title || t.articleId || '새 기사'}
            </button>
            <button type="button" aria-label="탭 닫기" onClick={() => closeTab(t.id)}>×</button>
          </span>
        ))}
        <button type="button" aria-label="새 작성 탭" className="yh-btn" onClick={() => addTab()}>＋</button>
      </div>

      <div className="yh-writer">
        {/* 좌측 60% — 에디터 */}
        <section className="yh-writer__editor">
          <Editor
            key={activeTabId}
            blocks={blocks}
            spellcheck={spell}
            onKeyDown={onKeyDown}
            onTextChange={onTextChange}
            onRemoveEmbed={onRemoveEmbed}
          />
        </section>

        {/* 우측 40% — 메타데이터 */}
        <aside className="yh-writer__meta">
          {/* 4개 탭 위 송고/보류/KILL 버튼 */}
          <div className="yh-actionbar" data-testid="action-bar">
            {buttons.map((key) => (
              <button
                key={key}
                type="button"
                className={`yh-btn ${key === 'send' ? 'yh-btn--primary' : key === 'kill' ? 'yh-btn--danger' : ''}`}
                onClick={() => onAction(key)}
              >
                {SUBMIT_LABELS[key]}
              </button>
            ))}
          </div>

          <div className="yh-tabs">
            {META_TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`yh-tab ${metaTab === t.key ? 'yh-tab--active' : ''}`}
                onClick={() => setMetaTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="yh-meta-panel">
            {metaTab === 'common' && (
              <CommonInfo tab={activeTab} updateField={updateField} />
            )}
            {metaTab === 'image' && (
              <SearchPanel
                kind="image"
                results={search.imageResults}
                onSearch={search.searchImages}
                onPick={(item) => insertEmbed(makeImageEmbed(item.src ?? item.link ?? item.url ?? '', { alt: item.title ?? '' }))}
              />
            )}
            {metaTab === 'video' && (
              <SearchPanel
                kind="video"
                results={search.videoResults}
                onSearch={search.searchVideos}
                onPick={(item) => insertEmbed(makeVideoEmbed(item.url ?? item.src ?? `https://www.youtube.com/watch?v=${item.videoId ?? (item.id && item.id.videoId) ?? ''}`, { title: item.title ?? '' }))}
              />
            )}
            {metaTab === 'article' && (
              <SearchPanel
                kind="article"
                results={search.articleResults}
                onSearch={search.searchArticles}
                onPick={(item) => insertEmbed(makeArticleEmbed(item))}
              />
            )}
          </div>
        </aside>
      </div>
    </main>
  );
}

// 공통정보 — 편집 가능(작성자/엠바고/2차엠바고) + 읽기전용 매핑 필드.
function CommonInfo({ tab, updateField }) {
  const f = tab.fields;
  const ro = tab.readOnly || {};
  return (
    <div data-testid="meta-common">
      <div className="yh-field">
        <label htmlFor="meta-author">작성자</label>
        <input id="meta-author" value={f.author} onChange={(e) => updateField('author', e.target.value)} />
      </div>
      <div className="yh-field">
        <label htmlFor="meta-embargo">엠바고 시간</label>
        <input id="meta-embargo" value={f.embargoAt} onChange={(e) => updateField('embargoAt', e.target.value)} />
      </div>
      <div className="yh-field">
        <label htmlFor="meta-embargo2">2차 엠바고 시간</label>
        <input id="meta-embargo2" value={f.secondEmbargoAt} onChange={(e) => updateField('secondEmbargoAt', e.target.value)} />
      </div>

      {READONLY_LABELS.some(([k]) => ro[k] != null) && (
        <div className="yh-readonly-meta" data-testid="readonly-meta">
          {READONLY_LABELS.filter(([k]) => ro[k] != null).map(([k, label]) => (
            <div className="yh-field" key={k}>
              <label>{label}</label>
              <input value={String(ro[k])} readOnly />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// 이미지(Google)/영상(YouTube)/글기사(내부 DB) 검색 패널 — 결과 클릭 시 본문에 임베드.
function SearchPanel({ kind, results, onSearch, onPick }) {
  const [q, setQ] = useState('');
  return (
    <div data-testid={`meta-${kind}`}>
      <div className="yh-field">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="검색어를 입력하세요"
          aria-label={`${kind} 검색어`}
        />
      </div>
      <button type="button" className="yh-btn" onClick={() => onSearch(q)}>검색</button>
      <div className="yh-search-results">
        {results.map((item, i) => (
          <button
            type="button"
            key={item.articleId ?? item.videoId ?? item.src ?? item.link ?? i}
            onClick={() => onPick(item)}
          >
            {kind === 'image' && (item.src || item.link)
              ? <img src={item.src ?? item.link} alt={item.title ?? ''} />
              : (item.title || item.articleId || item.url || '결과')}
          </button>
        ))}
      </div>
    </div>
  );
}

export default WriterPage;
