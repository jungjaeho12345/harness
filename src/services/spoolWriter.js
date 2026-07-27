// 배부(distribution) 스풀 writer — 배부 파일의 "포맷"과 "쓰기"만 담당하는 단일 출처다 (ADR-008).
// 앱은 수신처별 스풀 하위 폴더에 기사 JSON을 쓰기만 하고 실제 발송은 외부 전송기가 한다
// — 이 모듈에 네트워크 egress·타이머·재시도·전송 상태가 없는 이유다.
// 도메인 지식(대상 선택·DB 조회·Contents.distributedAt 갱신·ArticleHistory 기록)은 갖지 않는다: 상위 서비스 책임.
// 읽기·삭제·이동도 하지 않는다(쓰기 전용) — 스풀에 놓인 파일은 그 순간부터 외부 전송기의 소유다.

import { join } from 'node:path'; // 순수 경로 합성만 — IO 아님
import { sanitizeSpoolDir } from './spoolDir.js';

// 외부 전송기가 포맷을 식별하는 값 — 임의로 바꾸면 수신 측 파서가 깨진다.
const SCHEMA = 'yh-dist-article';
const VERSION = 1;

// Contents에서 그대로 복사할 필드 allowlist. 순서까지 계약이다(수신처가 보는 키 순서).
const ARTICLE_FIELDS = [
  'author', 'coAuthor', 'department', 'departmentCode', 'category', 'region',
  'attribute', 'keyword', 'externalComment', 'embargoAt', 'secondEmbargoAt',
  'createdAt', 'sentAt', 'status',
];

// 의도적으로 제외하는 Contents 컬럼과 그 이유 — 되살리지 마라:
// - internalComment                : 내부코멘트(사내 전용 메모). 외부 수신처로 나가면 정보 유출이다.
// - modifier, sender               : 내부 사용자 식별자(userId). 배부에 불필요 — 최소 노출 원칙.
// - lockYN/lockerUserId/lockerSessionId/lockerClientId/lockedAt
//                                  : 편집 잠금은 운영 내부 상태이며 세션 식별자를 포함한다.
// - content                        : 현재 미사용 평문 컬럼(SCHEMA.md) — 본문의 정본은 markupVersion이다.
// - editedAt                       : 내부 편집 시각. 수신처 판단에 쓰이지 않는다.
// - attachmentFile, referenceFile  : 첨부/자료 바이너리 동반 배부는 이번 범위 밖이다(파일 복사·전송 설계가 없다).
//                                    필요해지면 바이너리 동반 규칙과 함께 additive로 추가한다(키 추가는 하위호환).
//                                    참고: 본문 markupVersion 안의 /uploads/... 임베드 참조는 본문 원문이라
//                                    그대로 나간다 — 즉 "내부 경로 노출 금지"가 제외 근거가 아니다.

// 파일명에 합성되는 값의 심층 방어 정규식 — 서버 생성값이라도 조립 지점에서 한 번 더 막는다.
const ARTICLE_ID = /^[A-Za-z0-9_-]{1,64}$/;
// 'YYYYMMDDTHHMMSSmmmZ' — ISO-8601 UTC 문자열에서 '-' ':' '.'만 제거한 형태.
const COMPACT_TS = /^\d{8}T\d{9}Z$/;

// 스풀 파일 포맷의 단일 출처 — 순수 함수다(fs·시계·DB·env 접촉 없음).
// null-tolerant: article/contents/target이 없어도 throw하지 않고 키 집합이 같은 객체를 만든다.
// (articleModel.getById는 Article·Contents 중 하나만 있어도 행을 반환한다. 손상 행에서 나는 TypeError가
//  상위 catch-all에 삼켜지면 원인 불명 실패가 된다. 그런 행을 실제로 배부할지는 상위 서비스가 정한다.)
export function buildDistributionPayload({ article, contents, target, audience, distributedAt } = {}) {
  const fields = {};
  // 값이 없으면 null로 정규화하되 키는 항상 남긴다 — 수신처 파서가 키 유무로 분기하지 않게.
  for (const key of ARTICLE_FIELDS) fields[key] = contents?.[key] ?? null;

  return {
    schema: SCHEMA,
    version: VERSION,
    // 이 파일의 배부 지시 시각(호출자가 넘긴 값 그대로). 재배부 시 Contents.distributedAt(최초 배부)과 다를 수 있다.
    distributedAt: distributedAt ?? null,
    audience: audience ?? null,
    // 대상 행에서 4키만 복사한다 — active/타임스탬프는 수신처에 무의미하다.
    target: {
      id: target?.id ?? null,
      name: target?.name ?? null,
      kind: target?.kind ?? null,
      spoolDir: target?.spoolDir ?? null,
    },
    article: {
      // Article 행이 없는 손상 데이터를 대비해 Contents의 같은 값으로 폴백한다(둘은 articleId로 1:1).
      articleId: article?.articleId ?? contents?.articleId ?? null,
      // Contents가 목록의 정본이고, Article 제목은 레거시 행 보호용 폴백이다.
      title: contents?.title ?? article?.title ?? null,
      // 문자열 원문 그대로 — 파싱·재직렬화·평문 변환 금지(정보 손실·이스케이프 사고 방지).
      markupVersion: article?.markupVersion ?? null,
      ...fields,
    },
  };
}

// 스풀 파일을 쓰는 손. fs는 주입 전용이다(기본값 없음) — 기본값이 있으면 주입을 잊은 호출이 실디스크를
// 건드려 테스트가 비결정적이 되고 CI가 개발자 머신 상태에 의존한다. 실 fs 공급과 스풀 루트 env 판독은
// 합성 루트(부트스트랩)의 책임이며, 이 모듈은 rootDir를 인자로만 받는다.
// fs 계약: { mkdirSync(dir, { recursive: true }), writeFileSync(path, data, encoding) } — 동기 API만 쓴다
// (호출 체인이 전부 동기다. 비동기로 만들면 상위 반환 shape이 Promise로 바뀐다).
export function createSpoolWriter({ rootDir, fs } = {}) {
  // rootDir 미설정은 "배부 비활성"이지 에러가 아니다 — 수집 watcher가 RCV_SPOOL_DIR 미설정 시
  // 기동하지 않는 선례와 동형. 값을 trim·보정해서 통과시키지는 않는다(입력을 고쳐 쓰지 않는다).
  const enabled = typeof rootDir === 'string' && rootDir.trim() !== '' && fs !== undefined && fs !== null;

  // 어떤 입력에도 throw하지 않는다 — 실패는 전부 { ok: false, reason }이다.
  // 상위에서 스풀 실패가 송고를 롤백/실패시키면 안 된다(ADR-008 — 배부는 송고의 후처리다).
  function write({ target, payload } = {}) {
    if (!enabled) return { ok: false, reason: 'disabled' }; // fs 미접촉

    // 쓰기 직전 재검증 — "대상 관리가 이미 검증했으니 안전"에 기대지 않는다(DB 직접 수정·레거시 행·
    // 향후 규칙 변경으로 오염될 수 있고, 이 값은 실제 경로에 합성된다). 규칙은 재구현하지 않고
    // 단일 출처(sanitizeSpoolDir)에 위임한다 — 두 곳에 있으면 발산해 우회 벡터가 된다.
    const dir = sanitizeSpoolDir(target?.spoolDir);
    if (dir === '') return { ok: false, reason: 'invalid-spool-dir' };

    // 파일명 재료는 payload에서만 파생한다 — 별도 인자로 받으면 호출자가 다른 값을 넘겼을 때
    // 파일명과 파일 내용이 모순되는 버그 클래스가 생긴다(파일명은 09:00인데 내용은 08:59).
    // 타입 게이트가 먼저다: 강제변환하면 null·undefined·숫자가 문자열이 되어 아래 패턴을 통과하고
    // 'AKR...__null.json' 같은 파일이 만들어진다(spoolDir.js가 이미 금지한 안티패턴과 동형).
    const articleId = payload?.article?.articleId;
    if (typeof articleId !== 'string') return { ok: false, reason: 'invalid-article-id' };
    if (!ARTICLE_ID.test(articleId)) return { ok: false, reason: 'invalid-article-id' };

    const distributedAt = payload?.distributedAt;
    if (typeof distributedAt !== 'string') return { ok: false, reason: 'invalid-timestamp' };
    const compactTs = distributedAt.replace(/[-:.]/g, '');
    if (!COMPACT_TS.test(compactTs)) return { ok: false, reason: 'invalid-timestamp' };

    const dirPath = join(rootDir, dir);
    // 결정적 파일명: 같은 (articleId, distributedAt, spoolDir)이면 언제나 같은 경로다.
    // 시계·난수·카운터를 쓰지 않는다 — 결정성이 깨지면 재시도가 같은 기사 파일을 무한 증식시킨다.
    // 같은 키로 다시 쓰면 덮어쓴다(회피 접미사 없음): 정상 경로에서는 그때 payload가 동일해 멱등이다.
    // 알려진 한계 — "동일 키 = 동일 내용"은 같은 밀리초에 본문이 다른 두 배부가 없다는 전제 위에서만
    // 성립한다(고정 시계·저해상도 시계면 앞 파일이 유실된다). 회피 접미사는 결정성을 깨므로 더 나쁜
    // 트레이드오프라 보고, 이번 범위에서는 허용 가능한 한계로 둔다.
    const path = join(dirPath, `${articleId}__${compactTs}.json`);

    try {
      // 항상 mkdir -p(멱등) — 폴더는 외부 운영자가 미리 만들어 둘 수 있고 이미 있어도 실패하면 안 된다.
      // 존재 확인 후 조건부 생성 분기를 두지 않는다(TOCTOU 경합만 늘어난다).
      fs.mkdirSync(dirPath, { recursive: true });
      // 들여쓰기 2 + 끝 개행 = 사람이 읽고 diff 가능한 결정적 바이트. 인코딩은 명시적 utf8.
      fs.writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    } catch (err) {
      // 권한·디스크 오류·직렬화 실패(순환 참조)를 전부 여기서 흡수한다.
      return { ok: false, reason: 'write-failed', message: String(err?.message ?? err) };
    }
    return { ok: true, path };
  }

  return { enabled, write };
}
