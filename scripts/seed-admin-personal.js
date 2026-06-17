// 개인별 수정(personal) 메뉴 데모 시드 — admin(관리자) 작성 기사를 10건까지 채운다.
// 개인별 수정 필터(useViewController.buildMenuFilter): author = 로그인 이름('관리자') AND status ∈ {RDS, RRK}.
// 신규 작성은 항상 status RDS이므로(create) 그대로 개인별 수정에 노출된다.
// 비파괴(CLAUDE.md/ADR): INSERT만 한다 — 기존 행을 삭제/수정하지 않는다. 부족분만 채우는 멱등 러너.
// 실행: node scripts/seed-admin-personal.js

import { DatabaseSync } from 'node:sqlite';
import { createSchema } from '../src/db/schema.js';
import { createArticleModel } from '../src/models/articleModel.js';
import { createArticleService } from '../src/services/articleService.js';

const TARGET = 10;
const AUTHOR = '관리자';        // admin.name — 개인별 수정 필터가 이름으로 매칭한다.
const DEPT = '운영부';
const DEPT_CODE = 'ADM';

// "(끝)" 마커까지 포함한 yh-editor 블록 본문(현실적인 데모 — 송고도 가능).
function markup(title, body) {
  return JSON.stringify({
    format: 'yh-editor', version: 1,
    blocks: [
      { type: 'text', text: title },
      { type: 'text', text: body },
      { type: 'text', text: '(끝)' },
    ],
  });
}

const TITLES = [
  '정부, 디지털 행정 혁신안 발표',
  '시민 안전 강화 위한 예산 확대 추진',
  '지역 균형 발전 종합계획 공개',
  '공공데이터 개방 확대 방안 마련',
  '청년 일자리 지원 사업 본격 시행',
  '재난 대응 체계 전면 개편',
  '친환경 에너지 전환 로드맵 제시',
  '복지 사각지대 해소 대책 추진',
  '교통 인프라 확충 계획 확정',
  '문화예술 지원 정책 강화',
  '중소기업 디지털 전환 지원 확대',
  '공정거래 질서 확립 방안 발표',
];

const db = new DatabaseSync('news.db');
createSchema(db); // 멱등 비파괴 마이그레이션만.
const articleModel = createArticleModel(db);
const service = createArticleService({ articleModel, db });

const countPersonal = () => db
  .prepare("SELECT COUNT(*) AS n FROM Contents WHERE author = ? AND status IN ('RDS', 'RRK')")
  .get(AUTHOR).n;

const have = countPersonal();
const need = Math.max(0, TARGET - have);
console.log(`기존 '관리자' 개인별(RDS/RRK) 기사: ${have}건 — 목표 ${TARGET}건 → ${need}건 추가`);

let made = 0;
for (let i = 0; i < need; i += 1) {
  const title = TITLES[(have + i) % TITLES.length];
  const r = service.create({
    title,
    markupVersion: markup(title, `${title} 관련 상세 내용입니다. (개인별 수정 데모 시드)`),
    author: AUTHOR,
    modifier: AUTHOR,
    department: DEPT,
    departmentCode: DEPT_CODE,
  });
  if (r.ok) {
    made += 1;
    console.log(`  + ${r.articleId}  ${title}`);
  } else {
    console.log(`  ! 실패: ${JSON.stringify(r)}`);
  }
}

console.log(`완료: ${made}건 추가 — 현재 '관리자' 개인별 기사 총 ${countPersonal()}건`);
