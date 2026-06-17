import { describe, it, expect } from 'vitest';
import {
  bodyTitle, appendEmbedToBody, insertEmbedIntoBody, serializeBodyFromBlocks,
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

describe('insertEmbedIntoBody — 캐럿(blockIndex) 위치에 임베드 삽입', () => {
  it('지정한 blockIndex에 임베드를 삽입한다(앞 텍스트 보존)', () => {
    const body = serialize([textBlock('제목'), textBlock('본문')]);
    const out = deserialize(insertEmbedIntoBody(body, makeImageEmbed('data:img'), 1));
    expect(out.map((b) => b.type)).toEqual(['text', 'embed', 'text']);
    expect(out[0].text).toBe('제목');
    expect(out[2].text).toBe('본문');
  });

  it('"(끝)"이 있으면 임베드를 삽입해도 "(끝)"은 최종 블록으로 유지된다', () => {
    const body = serialize([textBlock('제목'), textBlock('본문'), textBlock(END_MARKER)]);
    const out = deserialize(insertEmbedIntoBody(body, makeImageEmbed('data:img'), 1));
    expect(out[out.length - 1].text).toBe(END_MARKER);
    expect(out.filter(isEmbedBlock)).toHaveLength(1);
  });

  it('blockIndex가 범위 밖이면 끝에 덧붙인다(appendEmbedToBody 폴백)', () => {
    const body = serialize([textBlock('제목'), textBlock('본문')]);
    const out = deserialize(insertEmbedIntoBody(body, makeImageEmbed('data:img'), -1));
    expect(out.filter(isEmbedBlock)).toHaveLength(1);
    expect(out[out.length - 1].type).toBe('embed');
  });

  it('embed가 없으면 본문 그대로', () => {
    const body = serialize([textBlock('제목')]);
    expect(insertEmbedIntoBody(body, null, 0)).toBe(body);
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
