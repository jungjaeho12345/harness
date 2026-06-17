import { describe, it, expect } from 'vitest';
import {
  bodyTitle, appendEmbedToBody, insertEmbedAfterLine, serializeBodyFromBlocks,
} from './writerBody.js';
import {
  deserialize, serialize, textBlock, embedBlock, isEmbedBlock, blocksToText, END_MARKER,
} from './editorContent.js';
import { makeImageEmbed } from './clipboardEmbed.js';

describe('bodyTitle — 첫 줄(=제목)', () => {
  it('본문 첫 줄을 trim해서 제목으로 도출', () => {
    expect(bodyTitle('헤드라인\n본문내용')).toBe('헤드라인');
    expect(bodyTitle('  \n본문')).toBe(''); // 첫 줄 비면 제목 없음
    expect(bodyTitle('')).toBe('');
  });
});

describe('serializeBodyFromBlocks — 커서 위치/블록 순서 보존(임베드는 그대로, "(끝)"만 최종 블록)', () => {
  it('텍스트 사이의 임베드 위치를 보존한다(끝으로 옮기지 않는다 — news.md 156·167행)', () => {
    const blocks = [
      textBlock('제목'),
      embedBlock({ embedType: 'image', src: 'data:img' }),
      textBlock('본문'),
    ];
    const out = deserialize(serializeBodyFromBlocks(blocks));
    expect(out.map((b) => b.type)).toEqual(['text', 'embed', 'text']);
    expect(blocksToText(out)).toBe('제목\n본문');
  });

  it('"(끝)"은 텍스트/임베드 중 어디 있든 항상 최종 블록으로 보낸다', () => {
    const blocks = [
      textBlock('제목'),
      textBlock(END_MARKER),
      embedBlock({ embedType: 'image', src: 'data:img' }),
      textBlock('본문'),
    ];
    const out = deserialize(serializeBodyFromBlocks(blocks));
    const last = out[out.length - 1];
    expect(last.type).toBe('text');
    expect(last.text).toBe(END_MARKER);
    // 끝은 한 개만 — 임베드는 보존.
    expect(out.filter((b) => b.type === 'text' && b.text === END_MARKER)).toHaveLength(1);
    expect(out.filter(isEmbedBlock)).toHaveLength(1);
  });
});

describe('insertEmbedAfterLine — 텍스트 줄 뒤 임베드 + 빈 줄 + 캐럿 줄 반환', () => {
  it('지정한 텍스트 줄(0) 뒤에 임베드와 빈 줄을 넣고 caretTextLine을 그 빈 줄로 반환', () => {
    const body = serialize([textBlock('제목'), textBlock('본문')]);
    const { body: out, caretTextLine } = insertEmbedAfterLine(body, makeImageEmbed('data:img'), 0);
    const blocks = deserialize(out);
    expect(blocks.map((b) => b.type).slice(0, 3)).toEqual(['text', 'embed', 'text']);
    expect(blocks[0].text).toBe('제목');
    expect(blocks[2].text).toBe(''); // 임베드 뒤 빈 줄
    expect(caretTextLine).toBe(1); // textLineIndex(0) + 1
  });

  it('"(끝)"이 있어도 마지막은 "(끝)"이고 임베드 1개·빈 줄은 "(끝)" 앞', () => {
    const body = serialize([textBlock('제목'), textBlock('본문'), textBlock(END_MARKER)]);
    const { body: out, caretTextLine } = insertEmbedAfterLine(body, makeImageEmbed('data:img'), 0);
    const blocks = deserialize(out);
    expect(blocks[blocks.length - 1].text).toBe(END_MARKER);
    expect(blocks.filter(isEmbedBlock)).toHaveLength(1);
    // 빈 줄은 "(끝)" 앞에 위치한다.
    const emptyIdx = blocks.findIndex((b) => b.type === 'text' && b.text === '');
    const endIdx = blocks.findIndex((b) => b.type === 'text' && b.text === END_MARKER);
    expect(emptyIdx).toBeGreaterThanOrEqual(0);
    expect(emptyIdx).toBeLessThan(endIdx);
    expect(caretTextLine).toBe(1);
  });

  it('textLineIndex가 범위 밖이면 끝("(끝)" 앞)에 임베드 + 빈 줄을 추가하고 caretTextLine을 정확히 반환', () => {
    const body = serialize([textBlock('제목'), textBlock('본문')]);
    const { body: out, caretTextLine } = insertEmbedAfterLine(body, makeImageEmbed('data:img'), 5);
    const blocks = deserialize(out);
    expect(blocks.filter(isEmbedBlock)).toHaveLength(1);
    expect(blocks[blocks.length - 1].text).toBe(''); // 끝에 빈 줄
    expect(blocks[blocks.length - 2].type).toBe('embed'); // 그 앞이 임베드
    expect(caretTextLine).toBe(2); // 제목(0) 본문(1) 빈줄(2)
  });

  it('embed-only 본문(텍스트 줄 0개)에 삽입하면 새 빈 줄이 유일한 텍스트 줄이고 caretTextLine === 0', () => {
    const body = serialize([embedBlock({ embedType: 'image', src: 'data:img' })]);
    const { body: out, caretTextLine } = insertEmbedAfterLine(body, makeImageEmbed('data:img2'), 0);
    const blocks = deserialize(out);
    expect(blocks.filter((b) => b.type === 'text')).toHaveLength(1);
    expect(blocks.find((b) => b.type === 'text').text).toBe('');
    expect(blocks.filter(isEmbedBlock)).toHaveLength(2); // 기존 + 신규
    expect(caretTextLine).toBe(0);
  });

  it('임베드가 텍스트 줄 사이에 있어도 textLineIndex는 텍스트 줄만 세어 환산한다(임베드 건너뜀)', () => {
    const body = serialize([
      textBlock('제목'),
      embedBlock({ embedType: 'image', src: 'data:img' }),
      textBlock('본문'),
    ]);
    // textLineIndex 1 = 두 번째 텍스트 줄('본문') — 임베드를 건너뛰고 '본문' 뒤에 삽입돼야 한다.
    const { body: out, caretTextLine } = insertEmbedAfterLine(body, makeImageEmbed('data:img2'), 1);
    const blocks = deserialize(out);
    expect(blocks.map((b) => b.type)).toEqual(['text', 'embed', 'text', 'embed', 'text']);
    expect(blocks[2].text).toBe('본문'); // 삽입 임베드는 '본문' 뒤
    expect(blocks[4].text).toBe(''); // 그 뒤 빈 줄
    expect(caretTextLine).toBe(2); // 제목(0) 본문(1) 빈줄(2)
  });

  it('embed가 없으면 본문 불변, caretTextLine은 null', () => {
    const body = serialize([textBlock('제목')]);
    expect(insertEmbedAfterLine(body, null, 0)).toEqual({ body, caretTextLine: null });
  });
});

describe('appendEmbedToBody', () => {
  it('임베드를 본문 끝에 덧붙인다', () => {
    const out = appendEmbedToBody('제목\n본문', makeImageEmbed('data:img'));
    expect(deserialize(out).filter(isEmbedBlock)).toHaveLength(1);
  });
  it('"(끝)"이 있으면 그 앞에 삽입한다', () => {
    const withEnd = serialize([textBlock('제목'), textBlock(END_MARKER)]);
    const out = appendEmbedToBody(withEnd, makeImageEmbed('data:img'));
    const blocks = deserialize(out);
    expect(blocks[blocks.length - 1].text).toBe(END_MARKER); // 여전히 마지막
    expect(blocks.filter(isEmbedBlock)).toHaveLength(1);
  });
  it('embed가 없으면 본문 그대로', () => {
    expect(appendEmbedToBody('본문', null)).toBe('본문');
  });
});
