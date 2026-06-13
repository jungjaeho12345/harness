import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/parsers/parser.js';

test('parse: FTP 파일 문자열은 첫 줄이 제목, 나머지가 본문', () => {
  const { title, content } = parse('헤드라인\n본문 1\n본문 2');
  assert.equal(title, '헤드라인');
  assert.equal(content, '본문 1\n본문 2');
});

test('parse: 선행 빈 줄/CRLF를 정규화한다', () => {
  const { title, content } = parse('\r\n\r\n헤드라인\r\n본문');
  assert.equal(title, '헤드라인');
  assert.equal(content, '본문');
});

test('parse: 한 줄짜리 문자열은 제목만, 본문은 빈 문자열', () => {
  assert.deepEqual(parse('제목만'), { title: '제목만', content: '' });
});

test('parse: API 응답 객체 {title, content}를 그대로 추출한다', () => {
  assert.deepEqual(parse({ title: 'T', content: 'C' }), { title: 'T', content: 'C' });
});

test('parse: API 응답이 body 필드를 쓰면 content로 매핑한다', () => {
  assert.deepEqual(parse({ title: 'T', body: 'B' }), { title: 'T', content: 'B' });
});

test('parse: title 없는 객체는 본문 첫 줄을 제목으로 승격한다', () => {
  assert.deepEqual(parse({ content: '첫 줄\n둘째 줄' }), { title: '첫 줄', content: '둘째 줄' });
});

test('parse: null/빈 입력은 빈 제목/본문', () => {
  assert.deepEqual(parse(null), { title: '', content: '' });
  assert.deepEqual(parse(''), { title: '', content: '' });
});
