// 데모/샘플 기사 시드 러너 — 루트 news.db에 "송고된 기사(DPS) 30건"과 "데스크 미송고(RDS/DDH) 20건"을
// 랜덤 생성한다. 메타데이터(작성자/수정자/송고자/부서/작성·편집·송고시간/공통정보)를 명세서(SCHEMA.md·news.md)대로
// 누락 없이 채운다. 직접 실행 전용: node scripts/seed-articles.js
//
// 비파괴 원칙(CLAUDE.md/ADR): createSchema는 additive 멱등 마이그레이션만, 기존 행은 절대 삭제/수정하지 않고
// 새 articleId(AKR+YYYYMMDD+난수9)로 INSERT만 한다. 부서별 기자 계정은 없는 것만 멱등 insert(덮어쓰기 없음).
//
// 상태값 근거(news.md 기사 생애주기):
//  - 송고된 기사 = DPS(데스크 송고완료, 부서별 송고 페이지 대상) → sender·sentAt 채움, 본문 마지막에 "(끝)" 블록.
//  - 데스크 미송고 = RDS/DDH(news.md L90: 데스크 미송고 페이지는 RDS, DDH만 나열) → 송고 전이므로 sender·sentAt 비움.

import bcrypt from 'bcryptjs';
import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createUserModel } from '../src/models/userModel.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { generateArticleId } from '../src/db/articleId.js';

const SENT_COUNT = 30; // 송고된 기사(DPS)
const UNSENT_COUNT = 20; // 데스크 미송고(RDS/DDH)

// ── 랜덤 헬퍼 ────────────────────────────────────────────────────────────────
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// 부서별 기자 계정 풀 — author가 실제 User를 참조하도록(부서/부서코드 정합) 멱등 insert한다.
// 비밀번호는 평문(시드 시점만)이며 저장은 bcrypt 해시로 한다.
const REPORTERS = [
  { userId: 'kim.sw', name: '김선우', department: '정치부', departmentCode: 'POL' },
  { userId: 'lee.jm', name: '이정민', department: '경제부', departmentCode: 'ECO' },
  { userId: 'park.hn', name: '박하늘', department: '사회부', departmentCode: 'SOC' },
  { userId: 'choi.yj', name: '최유진', department: '국제부', departmentCode: 'INT' },
  { userId: 'jung.ws', name: '정원석', department: '문화부', departmentCode: 'CUL' },
  { userId: 'kang.mh', name: '강민호', department: '스포츠부', departmentCode: 'SPO' },
  { userId: 'yoon.ar', name: '윤아름', department: 'IT과학부', departmentCode: 'SCI' },
  { userId: 'seo.dh', name: '서동현', department: '산업부', departmentCode: 'IND' },
];
// 송고자(데스크) 풀 — DPS 전이는 D/Z 권한이 수행한다.
const SENDERS = ['desk', 'admin'];

// 부서별 제목 템플릿 — {n}은 난수 치환.
const TITLE_BANK = {
  POL: ['여야 예산안 협상 막판 진통…처리 시한 {n}일 앞으로', '국회 본회의 {n}건 법안 일괄 처리', '대통령실 "민생 회복이 최우선" 강조'],
  ECO: ['코스피 {n}포인트 등락…환율 변동성 확대', '한은 기준금리 동결…"물가 안정 지켜볼 것"', '수출 {n}개월 만에 반등…반도체가 견인'],
  SOC: ['수도권 집중호우…일부 도로 통제', '학교폭력 대책 강화…현장 {n}곳 점검', '의료 공백 우려에 응급실 운영 점검'],
  INT: ['미·중 정상회담 {n}일 개최 합의', 'EU, 새 제재안 발표…파장 주목', '국제유가 배럴당 {n}달러 선 등락'],
  CUL: ['국내 영화 박스오피스 {n}만 관객 돌파', '대형 미술전 개막…관람객 줄이어', '국립극장 가을 시즌 {n}편 공연 라인업'],
  SPO: ['프로야구 가을야구 {n}경기 매진 행렬', '손흥민, 리그 {n}호골 폭발', '국가대표팀 평가전 {n}연승 질주'],
  SCI: ['국산 AI 모델 공개…성능 {n}% 향상', '차세대 반도체 양산 {n}분기 돌입', '우주발사체 {n}차 시험 발사 성공'],
  IND: ['완성차 업계 전기차 {n}종 출시 예고', '조선업 수주 {n}억 달러 돌파', '배터리 3사 증설 경쟁 가속'],
};

const REGIONS = ['서울', '경기', '부산', '대구', '광주', '대전', '세종', '전국'];
const ATTRIBUTES = ['일반', '속보', '단독', '기획', '해설'];
const KEYWORD_BANK = ['정치', '경제', '사회', '국제', '문화', '스포츠', '과학', '산업', '속보', '단독', '분석'];

function nowMs() {
  return Date.parse(new Date().toISOString());
}

// 과거 N일 이내 임의의 시각(ISO-8601 UTC).
function isoDaysAgo(maxDays) {
  const ms = nowMs() - randInt(0, maxDays) * 86400000 - randInt(0, 86399) * 1000;
  return new Date(ms).toISOString();
}

// base 이후 0~maxHours 사이의 시각(ISO-8601 UTC).
function isoAfter(baseIso, maxHours) {
  const ms = Date.parse(baseIso) + randInt(5, maxHours * 60) * 60000;
  return new Date(Math.min(ms, nowMs())).toISOString();
}

// 본문 블록 JSON(markupVersion) — 송고건(withEnd)은 마지막에 "(끝)" 블록을 둔다(SCHEMA.md L39).
function buildMarkup(title, dept, withEnd) {
  const blocks = [
    { type: 'text', text: title },
    { type: 'text', text: `[${dept}] 기사 본문 첫 문단입니다. 이것은 데모용 자동 생성 기사입니다.` },
    { type: 'text', text: `세부 내용은 추후 보강됩니다. 관련 취재 결과를 종합하면 다음과 같다.` },
  ];
  if (withEnd) blocks.push({ type: 'text', text: '(끝)' });
  return JSON.stringify({ format: 'yh-editor', version: 1, blocks });
}

function makeTitle(deptCode) {
  const t = pick(TITLE_BANK[deptCode] ?? TITLE_BANK.SOC);
  return t.replace('{n}', String(randInt(2, 99)));
}

// 키워드 1~3개를 콤마로 결합.
function makeKeywords() {
  const n = randInt(1, 3);
  const set = new Set();
  while (set.size < n) set.add(pick(KEYWORD_BANK));
  return [...set].join(',');
}

// 한 건의 Article+Contents 레코드를 만든다. status에 따라 송고 메타를 채운다.
function buildRecord(db, status) {
  const articleId = generateArticleId(db);
  const author = pick(REPORTERS);
  const title = makeTitle(author.departmentCode);
  const isSent = status === 'DPS';
  const markupVersion = buildMarkup(title, author.department, isSent);

  const createdAt = isoDaysAgo(30);
  // 편집시간: 일부는 미편집(null), 나머지는 작성 이후.
  const editedAt = chance(0.7) ? isoAfter(createdAt, 48) : null;
  const editBase = editedAt ?? createdAt;
  // 수정자: 편집됐으면 데스크/작성자 중 하나, 아니면 작성자.
  const modifier = editedAt ? pick([author.userId, ...SENDERS]) : author.userId;

  const contents = {
    articleId,
    title,
    content: null, // 평문 본문 컬럼은 미사용(SCHEMA.md L40/L51) — 본문은 markupVersion에 저장.
    author: author.userId,
    modifier,
    sender: isSent ? pick(SENDERS) : null, // 송고자는 송고(send) 액션에서만 채워진다.
    department: author.department,
    departmentCode: author.departmentCode,
    createdAt,
    editedAt,
    sentAt: isSent ? isoAfter(editBase, 24) : null, // 송고시간 — DPS만.
    distributedAt: null, // 배부 시스템은 현 구현 범위 밖.
    embargoAt: chance(0.25) ? isoAfter(editBase, 72) : '',
    secondEmbargoAt: '',
    status,
    lockYN: 'N',
    lockerUserId: null,
    lockerSessionId: null,
    lockedAt: null,
    coAuthor: chance(0.2) ? pick(REPORTERS).name : null,
    region: pick(REGIONS),
    attribute: pick(ATTRIBUTES),
    keyword: makeKeywords(),
    internalComment: chance(0.3) ? '데스크 확인 요망' : null,
    externalComment: chance(0.15) ? '제휴사 송출용' : null,
    attachmentFile: null,
    referenceFile: null,
  };
  const article = { articleId, title, content: null, markupVersion, modifier };
  return { article, contents };
}

// ── 실행 ─────────────────────────────────────────────────────────────────────
const db = new DatabaseSync('news.db');
createSchema(db);

// 1) 부서별 기자 계정 멱등 시드(없는 것만).
const userModel = createUserModel(db);
const newUsers = [];
for (const r of REPORTERS) {
  if (userModel.findById(r.userId)) continue;
  userModel.insert({
    ...r,
    password: bcrypt.hashSync('demo1234', 10),
    role: 'R',
    active: 'Y',
  });
  newUsers.push(r.userId);
}

// 2) 기사 생성. 데스크 미송고 20건은 RDS 위주 + DDH 일부로 구성한다.
const articleModel = createArticleModel(db);
const plan = [];
for (let i = 0; i < SENT_COUNT; i++) plan.push('DPS');
for (let i = 0; i < UNSENT_COUNT; i++) plan.push(chance(0.3) ? 'DDH' : 'RDS');

const inserted = { DPS: 0, RDS: 0, DDH: 0 };
for (const status of plan) {
  const rec = buildRecord(db, status);
  articleModel.insert(rec);
  inserted[status]++;
}

console.log(`기자 계정 신규 시드: ${newUsers.length ? newUsers.join(', ') : '없음(이미 존재 — 멱등 skip)'}`);
console.log(`기사 생성 완료 — 송고됨(DPS) ${inserted.DPS}건, 데스크 미송고 RDS ${inserted.RDS}건/DDH ${inserted.DDH}건 (총 ${plan.length}건)`);
