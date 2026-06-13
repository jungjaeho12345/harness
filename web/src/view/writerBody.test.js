import { describe, it, expect } from 'vitest';
import { bodyTitle, mergeTextIntoBody, appendEmbedToBody } from './writerBody.js';
import { deserialize, isEmbedBlock, blocksToText, END_MARKER } from './editorContent.js';
import { makeImageEmbed } from './clipboardEmbed.js';

describe('bodyTitle — 첫 줄(=제목)', () => {
  it('본문 첫 줄을 trim해서 제목으로 도출', () => {
    expect(bodyTitle('헤드라인\n본문내용')).toBe('헤드라인');
    expect(bodyTitle('  \n본문')).toBe(''); // 첫 줄 비면 제목 없음
    expect(bodyTitle('')).toBe('');
  });
});

describe('mergeTextIntoBody — 정규 순서(본문 텍스트 → 임베드 → "(끝)")', () => {
  it('기존 임베드를 보존하고 텍스트 뒤로 보낸다', () => {
    const start = appendEmbedToBody('제목\n본문', makeImageEmbed('data:img'));
    const merged = mergeTextIntoBody(start, '제목\n본문 수정');
    const blocks = deserialize(merged);
    expect(blocksToText(blocks)).toBe('제목\n본문 수정');
    expect(blocks.filter(isEmbedBlock)).toHaveLength(1);
    // "(끝)" 없는 본문 — 임베드가 모든 텍스트 블록 뒤(마지막)에 온다.
    const embedIdx = blocks.findIndex(isEmbedBlock);
    const lastTextIdx = blocks.map((b) => b.type).lastIndexOf('text');
    expect(embedIdx).toBeGreaterThan(lastTextIdx);
    expect(embedIdx).toBe(blocks.length - 1);
  });

  it('"(끝)"은 텍스트 중 어디 있든 임베드 뒤 최종 블록으로 보낸다', () => {
    const start = appendEmbedToBody('제목\n본문', makeImageEmbed('data:img'));
    const merged = mergeTextIntoBody(start, `제목\n본문\n${END_MARKER}`);
    const blocks = deserialize(merged);
    const last = blocks[blocks.length - 1];
    expect(last.type).toBe('text');
    expect(last.text).toBe(END_MARKER);
  });
});

describe('appendEmbedToBody', () => {
  it('임베드를 본문 끝에 덧붙인다', () => {
    const out = appendEmbedToBody('제목\n본문', makeImageEmbed('data:img'));
    expect(deserialize(out).filter(isEmbedBlock)).toHaveLength(1);
  });
  it('"(끝)"이 있으면 그 앞에 삽입한다', () => {
    const withEnd = mergeTextIntoBody('', `제목\n${END_MARKER}`);
    const out = appendEmbedToBody(withEnd, makeImageEmbed('data:img'));
    const blocks = deserialize(out);
    expect(blocks[blocks.length - 1].text).toBe(END_MARKER); // 여전히 마지막
    expect(blocks.filter(isEmbedBlock)).toHaveLength(1);
  });
  it('embed가 없으면 본문 그대로', () => {
    expect(appendEmbedToBody('본문', null)).toBe('본문');
  });
});
