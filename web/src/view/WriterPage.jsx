// 기사 작성페이지(writer.do) — 좌 에디터 : 우 메타데이터 = 60:40.
// 메타 4탭(공통정보/이미지/영상/글기사), 탭 위 송고/보류/KILL 버튼(권한·상태·진입별 표시 규칙).
// 가드: 송고는 "(끝)" 필요, 송고/보류는 제목(첫 줄) 필요. 각 액션은 확인창 후에만 진행.
// 데이터는 useWriteController/useSearchController 경유(transport 직접 호출 금지, ADR-003).

import { useState } from 'react';
import { useAppContext } from '../app/context.js';
import { useWriteController } from '../controller/useWriteController.js';
import { useSearchController } from '../controller/useSearchController.js';
import { Editor, readCaret } from './Editor.jsx';
import { submitButtons, SUBMIT_LABELS } from './writerButtons.js';
import { deserialize, serialize, hasEndMarker, blocksToText } from './editorContent.js';
import { insertEndMarker, isInsertEndMarker, isDeleteLine, deleteLineAt } from './editorShortcuts.js';
import { lineAtOffset } from './editorCaret.js';
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

// 텍스트 라인 인덱스(라인 div 순서) → blocks 배열 인덱스. 텍스트 블록만 세어 환산한다(임베드 제외 — Editor의 textLine 카운팅과 동일 규칙).
function textLineToBlockIndex(blocks, textLineIndex) {
  let count = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i] && blocks[i].type === 'text') {
      count += 1;
      if (count === textLineIndex) return i;
    }
  }
  return -1;
}

export function WriterPage() {
  const { identity } = useAppContext();
  const {
    tabs, activeTabId, activeTab,
    addTab, closeTab, selectTab,
    updateField, submit, save,
  } = useWriteController();
  const search = useSearchController();

  const [metaTab, setMetaTab] = useState('common');
  const [spell, setSpell] = useState(false);

  // 매핑(mapping) — 임베드 전용 제한 편집. 본문 텍스트 비편집·공통정보 readOnly이되 임베드 추가/삭제는 허용(step11).
  const isMapping = activeTab.mode === 'mapping';

  const body = activeTab.fields.body;
  const blocks = deserialize(body);

  // 본문 타이핑 → 정규 순서로 재직렬화 + 제목(첫 줄) 동기화.
  const onTextChange = (text) => {
    const next = mergeTextIntoBody(body, text);
    updateField('body', next);
    updateField('title', bodyTitle(next));
  };

  // Alt+Y → "(끝)" 최종 블록 삽입 + 맞춤법 검사 on(중복이면 무삽입).
  // Ctrl+D / 빈 줄 Backspace·Delete → 활성 라인(+동반 임베드 1개) 삭제. 문자 삭제(비어 있지 않은 줄)는 기본 동작 유지.
  const onKeyDown = (e) => {
    if (isInsertEndMarker(e)) {
      e.preventDefault();
      const r = insertEndMarker(blocks);
      updateField('body', serialize(r.blocks));
      setSpell(true);
      return;
    }
    const ctrlD = isDeleteLine(e);
    if (!ctrlD && e.key !== 'Backspace' && e.key !== 'Delete') return;

    const text = blocksToText(blocks);
    const caret = readCaret(e.currentTarget);
    const textLineIndex = lineAtOffset(text, caret ? caret.offset : text.length).lineIndex;
    // Backspace/Delete는 빈 줄(라인 삭제)에만 개입한다 — 비어 있지 않은 줄의 문자 삭제는 막지 않는다.
    if (!ctrlD && (text.split('\n')[textLineIndex] ?? '') !== '') return;

    const blockIndex = textLineToBlockIndex(blocks, textLineIndex);
    if (blockIndex < 0) return;
    e.preventDefault();
    updateField('body', serialize(deleteLineAt(blocks, blockIndex).blocks));
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

  // 매핑 '저장' — 송고 가드(제목/"(끝)")·전이(applyAction) 없이 추가된 임베드만 PUT 저장한다.
  const onSaveMapping = async () => {
    if (!window.confirm('저장하시겠습니까?')) return;
    await saveMapping();
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
            textEditable={!isMapping}
            onKeyDown={isMapping ? undefined : onKeyDown}
            onTextChange={isMapping ? undefined : onTextChange}
            onRemoveEmbed={onRemoveEmbed}
          />
        </section>

        {/* 우측 40% — 메타데이터 */}
        <aside className="yh-writer__meta">
          {/* 4개 탭 위 송고/보류/KILL 버튼. 매핑은 전이 없음 → 저장 버튼만(임베드 변경을 PUT 저장). */}
          <div className="yh-actionbar" data-testid="action-bar">
            {isMapping ? (
              <button type="button" className="yh-btn yh-btn--primary" onClick={() => save()}>
                저장
              </button>
            ) : (
              buttons.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`yh-btn ${key === 'send' ? 'yh-btn--primary' : key === 'kill' ? 'yh-btn--danger' : ''}`}
                  onClick={() => onAction(key)}
                >
                  {SUBMIT_LABELS[key]}
                </button>
              ))
            )}
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
              <CommonInfo tab={activeTab} updateField={updateField} readOnly={isMapping} />
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
// 매핑 모드(readOnly)에서는 작성자/엠바고/2차엠바고 입력란도 readOnly다(임베드만 변경 — step11).
function CommonInfo({ tab, updateField, readOnly = false }) {
  const f = tab.fields;
  const ro = tab.readOnly || {};
  return (
    <div data-testid="meta-common">
      <div className="yh-field">
        <label htmlFor="meta-author">작성자</label>
        <input id="meta-author" value={f.author} readOnly={readOnly} onChange={(e) => updateField('author', e.target.value)} />
      </div>
      <div className="yh-field">
        <label htmlFor="meta-embargo">엠바고 시간</label>
        <input id="meta-embargo" value={f.embargoAt} readOnly={readOnly} onChange={(e) => updateField('embargoAt', e.target.value)} />
      </div>
      <div className="yh-field">
        <label htmlFor="meta-embargo2">2차 엠바고 시간</label>
        <input id="meta-embargo2" value={f.secondEmbargoAt} readOnly={readOnly} onChange={(e) => updateField('secondEmbargoAt', e.target.value)} />
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
