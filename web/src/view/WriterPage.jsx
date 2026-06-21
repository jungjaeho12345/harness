// 기사 작성페이지(writer.do) — 좌 에디터 : 우 메타데이터 = 60:40.
// 메타 4탭(공통정보/이미지/영상/글기사), 탭 위 송고/보류/KILL 버튼(권한·상태·진입별 표시 규칙).
// 가드: 송고는 "(끝)" 필요, 송고/보류는 제목(첫 줄) 필요. 각 액션은 확인창 후에만 진행.
// 데이터는 useWriteController/useSearchController 경유(transport 직접 호출 금지, ADR-003).

import { useState, useRef, useEffect } from 'react';
import { useAppContext } from '../app/context.js';
import { useWriteController } from '../controller/useWriteController.js';
import { useSearchController } from '../controller/useSearchController.js';
import { Editor, readCaret } from './Editor.jsx';
import { StatusBar } from './StatusBar.jsx';
import { EditorMenuBar } from './EditorMenuBar.jsx';
import { EditorToolBar } from './EditorToolBar.jsx';
import { submitButtons, SUBMIT_LABELS } from './writerButtons.js';
import { deserialize, serialize, hasEndMarker, blocksToText } from './editorContent.js';
import { insertEndMarker, isInsertEndMarker, isDeleteLine, deleteLineAt } from './editorShortcuts.js';
import { lineAtOffset } from './editorCaret.js';
import { makeImageEmbed, makeVideoEmbed, makeArticleEmbed } from './clipboardEmbed.js';
import {
  bodyTitle, appendEmbedToBody, insertEmbedAfterLine, serializeBodyFromBlocks, textLineToBlockIndex,
} from './writerBody.js';

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
  const { identity, model } = useAppContext();
  const {
    tabs, activeTabId, activeTab,
    addTab, closeTab, selectTab,
    updateField, submit, saveMapping,
  } = useWriteController();
  const search = useSearchController();

  const [metaTab, setMetaTab] = useState('common');
  const [spell, setSpell] = useState(false);

  // 에디터 크롬(메뉴바·툴바·상태표시줄) — Step 3 배치.
  // statusCaret: 상태표시줄 '행/열' 표시용 마지막 캐럿({lineIndex, offset}). 캐럿 이동마다 갱신(가산적 결선).
  // showMenuBar/showToolBar: 메뉴바/툴바 보이기 토글(레이아웃 토글 — placeholder 아님).
  const [statusCaret, setStatusCaret] = useState(null);
  const [showMenuBar, setShowMenuBar] = useState(true);
  const [showToolBar, setShowToolBar] = useState(true);

  // 매핑(mapping) — 임베드 전용 제한 편집. 본문 텍스트 비편집·공통정보 readOnly이되 임베드 추가/삭제는 허용(step11).
  const isMapping = activeTab.mode === 'mapping';

  const body = activeTab.fields.body;
  const blocks = deserialize(body);

  // 마지막 에디터 캐럿(텍스트-줄) — 검색패널 클릭 시 에디터 포커스가 빠져 라이브 readCaret이 null이므로 여기 보관(Editor onCaretChange).
  const lastCaretRef = useRef(null);
  // 임베드 삽입 후 커서를 옮길 빈 줄(텍스트-줄 인덱스). Editor가 소비(focus)하면 비워, 같은 줄 연속 삽입도 매번 커서를 옮긴다.
  const [pendingCaretLine, setPendingCaretLine] = useState(null);
  useEffect(() => {
    if (pendingCaretLine !== null) setPendingCaretLine(null);
  }, [pendingCaretLine]);

  // 본문 타이핑 → 에디터가 읽은 블록(텍스트 + 임베드, 커서 위치 보존)을 직렬화 + 제목(첫 줄) 동기화.
  // 임베드는 "(끝)"만 최종 블록으로 보낼 뿐 위치를 옮기지 않는다(news.md 156·167행 — 커서 위치/블록 순서 보존).
  const onTextChange = (text, editedBlocks) => {
    const next = serializeBodyFromBlocks(editedBlocks);
    updateField('body', next);
    updateField('title', (String(text ?? '').split('\n')[0] ?? '').trim());
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
    // Ctrl+D는 삭제 가능 여부와 무관하게 브라우저 기본동작(북마크 추가)을 막는다.
    // (삭제할 라인이 없을 때 preventDefault를 빼먹으면 두 번째 Ctrl+D에서 북마크 창이 뜬다.)
    if (ctrlD) e.preventDefault();

    const text = blocksToText(blocks);
    const caret = readCaret(e.currentTarget);
    const textLineIndex = lineAtOffset(text, caret ? caret.offset : text.length).lineIndex;
    // Backspace/Delete는 빈 줄(라인 삭제)에만 개입한다 — 비어 있지 않은 줄의 문자 삭제는 막지 않는다.
    if (!ctrlD && (text.split('\n')[textLineIndex] ?? '') !== '') return;

    const blockIndex = textLineToBlockIndex(blocks, textLineIndex);
    if (blockIndex < 0) return;
    if (!ctrlD) e.preventDefault(); // Backspace/Delete는 실제 라인 삭제가 확정될 때만 기본동작을 막는다.
    updateField('body', serialize(deleteLineAt(blocks, blockIndex).blocks));
  };

  const onRemoveEmbed = (blockIndex) => {
    if (blockIndex < 0 || blockIndex >= blocks.length) return;
    const next = blocks.slice();
    next.splice(blockIndex, 1);
    updateField('body', serialize(next));
  };

  // 임베드를 커서 텍스트 줄 "다음"에 삽입하고, 그 뒤 빈 줄을 만들어 커서를 그 줄로 옮긴다(news.md 156행 — 커서 위치 임베딩).
  // 캐럿이 없거나(한 번도 포커스 안 함) 매핑 모드(텍스트 잠금)면 끝("(끝)" 앞)에만 추가한다(빈 줄/커서 이동 없음 — 매핑 본문 불변식).
  const insertEmbedAtLine = (embed, caretLine) => {
    if (!embed) return;
    if (isMapping || caretLine == null) {
      updateField('body', appendEmbedToBody(body, embed));
      return;
    }
    const r = insertEmbedAfterLine(body, embed, caretLine);
    updateField('body', r.body);
    if (typeof r.caretTextLine === 'number') setPendingCaretLine(r.caretTextLine);
  };

  // 검색패널(이미지/영상/글기사) 픽 — 마지막 에디터 캐럿 줄에 삽입(클릭으로 포커스가 빠지므로 lastCaretRef 사용, 라이브 readCaret 금지).
  const insertEmbed = (embed) => insertEmbedAtLine(embed, lastCaretRef.current ? lastCaretRef.current.lineIndex : null);

  // Ctrl+V 이미지 붙여넣기 — 동기로 확보한 캐럿 줄에 삽입(텍스트 직렬화 없이 — news.md 156행).
  const pasteEmbedAtCaret = (embed, caret) => insertEmbedAtLine(embed, caret ? caret.lineIndex : null);

  // 송고/보류/KILL — 가드 후 확인창, 확인 시에만 진행.
  const onAction = async (action) => {
    // 제목은 본문 첫 줄(bodyTitle) 또는 제목 FIELD 둘 중 하나라도 있으면 인정한다.
    // (둘 다 본문 첫 줄만 보던 버그로 제목 필드만 있을 때 송고/보류가 모두 잘못 차단됐다.)
    const title = bodyTitle(body) || (activeTab.fields.title || '').trim();
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
      <div className="yh-tabs yh-tabs--docs" data-testid="writer-tabs">
        {tabs.map((t) => (
          <span key={t.id} className={`yh-tab ${t.id === activeTabId ? 'yh-tab--active' : ''}`}>
            <button type="button" className="yh-tab__label" onClick={() => selectTab(t.id)}>
              {t.fields.title || t.articleId || '새 기사'}
            </button>
            <button type="button" className="yh-tab__close" aria-label="탭 닫기" onClick={() => closeTab(t.id)}>×</button>
          </span>
        ))}
        <button type="button" aria-label="새 작성 탭" className="yh-tab__add" onClick={() => addTab()}>＋</button>
      </div>

      <div className="yh-writer">
        {/* 좌측 60% — 에디터 크롬(메뉴바·툴바) → 에디터 → 상태표시줄 순으로 쌓는다. */}
        <section className="yh-writer__editor">
          {/* 메뉴바/툴바 보이기 토글 — 전용 버튼(항상 보임). EditorMenuBar '보기' 항목은 비활성(쉘)이라 결선하지 않는다.
              (news.md L173은 우클릭 컨텍스트 메뉴 항목으로도 규정하나 ContextMenu 이동은 후속 phase로 연기 — 이번엔 전용 버튼만.) */}
          <div className="yh-editor-chrome-bar">
            <button
              type="button"
              className="yh-editor-chrome-bar__toggle"
              data-testid="toggle-menubar"
              aria-pressed={showMenuBar}
              onClick={() => setShowMenuBar((v) => !v)}
            >
              메뉴바
            </button>
            <button
              type="button"
              className="yh-editor-chrome-bar__toggle"
              data-testid="toggle-toolbar"
              aria-pressed={showToolBar}
              onClick={() => setShowToolBar((v) => !v)}
            >
              툴바
            </button>
          </div>
          {showMenuBar && <EditorMenuBar />}
          {showToolBar && <EditorToolBar />}
          <Editor
            key={activeTabId}
            blocks={blocks}
            spellcheck={spell}
            textEditable={!isMapping}
            onKeyDown={isMapping ? undefined : onKeyDown}
            onTextChange={isMapping ? undefined : onTextChange}
            onRemoveEmbed={onRemoveEmbed}
            onPasteEmbed={pasteEmbedAtCaret}
            // 가산적 결선 — lastCaretRef(검색패널 임베드 삽입 위치)는 유지하고 상태표시줄용 statusCaret만 추가한다.
            onCaretChange={(c) => { lastCaretRef.current = c; setStatusCaret(c); }}
            pendingCaretLine={pendingCaretLine}
          />
          {/* 상태표시줄 — 본문 텍스트(임베드 제외)·캐럿만 결선. overwrite/language는 기본값(placeholder) 유지. */}
          <StatusBar text={blocksToText(blocks)} caret={statusCaret} />
        </section>

        {/* 우측 40% — 메타데이터 */}
        <aside className="yh-writer__meta">
          {/* 4개 탭 위 송고/보류/KILL 버튼. 매핑은 전이 없음 → 저장 버튼만(임베드 변경을 PUT 저장). */}
          <div className="yh-actionbar" data-testid="action-bar">
            {isMapping ? (
              <button type="button" className="yh-btn yh-btn--primary" onClick={onSaveMapping}>
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
              <CommonInfo tab={activeTab} updateField={updateField} model={model} readOnly={isMapping} />
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

// 공통정보 — 편집 가능(작성자/엠바고/2차엠바고/공동작성/지역/속성/키워드/내부·외부코멘트 + 첨부/자료파일)
//   + 읽기전용 매핑 필드. 본문(내용)은 좌측 에디터가 담당하므로 별도 내용 입력란은 두지 않는다.
// 매핑 모드(readOnly)에서는 모든 공통정보 입력란을 readOnly/disabled로 잠근다(임베드만 변경 — step11, 본문-only 불변식).
// 파일 업로드는 ADR-003에 따라 view에서 직접 fetch하지 않고 model.uploadFile(file)로만 처리한다.
function CommonInfo({ tab, updateField, model, readOnly = false }) {
  const f = tab.fields;
  const ro = tab.readOnly || {};

  // 첨부/자료파일 — 선택 즉시 업로드(model.uploadFile) → 성공 시 반환 path를 해당 필드에 보관.
  const onFileChange = async (field, e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const r = await model.uploadFile(file);
    if (r && r.ok && r.path) updateField(field, r.path);
  };

  return (
    <div data-testid="meta-common">
      <div className="yh-meta-grid">
        <div className="yh-field">
          <label htmlFor="meta-author">작성자</label>
          <input id="meta-author" value={f.author} readOnly={readOnly} onChange={(e) => updateField('author', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-coauthor">공동작성</label>
          <input id="meta-coauthor" value={f.coAuthor} readOnly={readOnly} onChange={(e) => updateField('coAuthor', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-region">지역</label>
          <input id="meta-region" value={f.region} readOnly={readOnly} onChange={(e) => updateField('region', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-attribute">속성</label>
          <input id="meta-attribute" value={f.attribute} readOnly={readOnly} onChange={(e) => updateField('attribute', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-embargo">엠바고 시간</label>
          <input id="meta-embargo" value={f.embargoAt} readOnly={readOnly} onChange={(e) => updateField('embargoAt', e.target.value)} />
        </div>
        <div className="yh-field">
          <label htmlFor="meta-embargo2">2차 엠바고 시간</label>
          <input id="meta-embargo2" value={f.secondEmbargoAt} readOnly={readOnly} onChange={(e) => updateField('secondEmbargoAt', e.target.value)} />
        </div>
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-keyword">키워드</label>
          <input id="meta-keyword" value={f.keyword} readOnly={readOnly} onChange={(e) => updateField('keyword', e.target.value)} />
        </div>
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-internal-comment">내부코멘트</label>
          <textarea id="meta-internal-comment" value={f.internalComment} readOnly={readOnly} onChange={(e) => updateField('internalComment', e.target.value)} />
        </div>
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-external-comment">외부코멘트</label>
          <textarea id="meta-external-comment" value={f.externalComment} readOnly={readOnly} onChange={(e) => updateField('externalComment', e.target.value)} />
        </div>

        {/* 첨부파일/자료파일 — 실제 업로드. 저장된 path는 링크로 보여주고 지우기 버튼을 제공한다. */}
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-attachment">첨부파일</label>
          <input id="meta-attachment" type="file" disabled={readOnly} onChange={(e) => onFileChange('attachmentFile', e)} />
          {f.attachmentFile && (
            <span className="yh-file-saved">
              <a href={f.attachmentFile}>{f.attachmentFile}</a>
              {!readOnly && (
                <button type="button" aria-label="첨부파일 지우기" onClick={() => updateField('attachmentFile', '')}>×</button>
              )}
            </span>
          )}
        </div>
        <div className="yh-field yh-field--wide">
          <label htmlFor="meta-reference">자료파일</label>
          <input id="meta-reference" type="file" disabled={readOnly} onChange={(e) => onFileChange('referenceFile', e)} />
          {f.referenceFile && (
            <span className="yh-file-saved">
              <a href={f.referenceFile}>{f.referenceFile}</a>
              {!readOnly && (
                <button type="button" aria-label="자료파일 지우기" onClick={() => updateField('referenceFile', '')}>×</button>
              )}
            </span>
          )}
        </div>
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

// 유튜브 video id로 썸네일 URL을 만든다(없으면 null).
function youtubeThumb(item) {
  const id = item.videoId ?? (item.id && item.id.videoId);
  return id ? `https://img.youtube.com/vi/${id}/mqdefault.jpg` : null;
}

// 이미지(Google)/영상(YouTube)/글기사(내부 DB) 검색 패널 — 결과 선택 시 본문에 임베드.
// 이미지·영상은 썸네일 카드(클릭 시 삽입), 글기사는 제목 + '삽입' 버튼 행으로 깔끔하게 표시한다.
function SearchPanel({ kind, results, onSearch, onPick }) {
  const [q, setQ] = useState('');
  const submit = () => onSearch(q);
  return (
    <div data-testid={`meta-${kind}`}>
      <div className="yh-search-bar">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          placeholder="검색어를 입력하세요"
          aria-label={`${kind} 검색어`}
        />
        <button type="button" className="yh-btn" onClick={submit}>검색</button>
      </div>

      {kind === 'article' ? (
        <ul className="yh-article-results">
          {results.map((item, i) => (
            <li className="yh-article-result" key={item.articleId ?? i}>
              <span className="yh-article-result__title" title={item.title}>
                {item.title || item.articleId || '(제목 없음)'}
              </span>
              <button
                type="button"
                className="yh-btn yh-btn--sm"
                onClick={() => onPick(item)}
              >
                삽입
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="yh-search-results">
          {results.map((item, i) => {
            const thumb = kind === 'image' ? (item.src ?? item.link) : youtubeThumb(item);
            return (
              <button
                type="button"
                className="yh-media-result"
                key={item.videoId ?? item.src ?? item.link ?? i}
                onClick={() => onPick(item)}
              >
                {thumb
                  ? <img src={thumb} alt={item.title ?? ''} />
                  : (item.title || item.url || '결과')}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default WriterPage;
