// 배부 실행 서비스 — 도메인 로직 (전송 계층 비의존, ADR-006). 의존성은 전부 주입한다.
// 책임은 정확히 셋이다: (1) 대상 선택, (2) 스풀 기록(포맷·쓰기는 spoolWriter에 위임),
// (3) DB 기록(Contents.distributedAt 최초 1회 stamp + ArticleHistory 1행 append).
//
// 이 서비스는 "누가 언제 배부를 트리거하는지" 모른다 — 송고 후처리 결선과 시각 도래 배부(tick)는
// 상위(결선 계층)의 책임이다. 그래서 여기에는 타이머·네트워크 egress·env 판독·라우트가 없다(ADR-008).
// 스풀 기록 시각 = distributedAt = "배부 지시 완료"이지 발송 완료가 아니다(ADR-008 트레이드오프).
//
// 계약(깨면 상위가 무너진다):
//  - distribute는 동기다. Promise를 반환하면 동기 호출 체인(전이→라우트) 전체의 반환 shape이 바뀐다.
//  - distribute는 어떤 입력에도 throw하지 않는다. 배부는 송고의 후처리이며, 배부 실패가 송고를
//    롤백/실패시키면 안 된다(ADR-008).
//  - 스풀 파일이 하나도 나가지 않았으면 DB를 건드리지 않는다. 배부되지 않은 기사가 배부시간 조회에
//    잡히면 그 자체가 거짓 데이터다(news.md의 배부시간 조회).

import { buildDistributionPayload } from './spoolWriter.js';

// audience → 배부할 대상 kind 화이트리스트.
// 평범한 객체가 아니라 Map이다: 객체면 '__proto__'/'constructor'/'toString' 같은 프로토타입 키가
// 조회를 통과해 알 수 없는 audience가 대상군을 얻는다(= 오발송).
// 'nonpress'(비언론사 시각 배부)는 아직 없다 — 추가는 그 기능을 구현하는 phase에서 additive로 한다.
// 느슨하게 받아들이면 잘못된 수신처군으로 나간다.
const AUDIENCE_KINDS = new Map([
  ['press', ['press']], // 언론사만 — 2차 엠바고 기사는 송고 시 언론사에 즉시 배부된다(news.md).
  ['all', ['press', 'nonpress']], // 전체 — 엠바고 없는 일반 기사는 송고 즉시 전체 배부(ADR-008 (4)).
]);

// "아무것도 하지 않음"은 에러가 아니다(배부 비활성·대상 0건). 매번 새 배열을 만들어 반환한다
// — 공유 객체를 돌려주면 호출자가 failures를 변형했을 때 다음 호출이 오염된다.
function nothing() {
  return { ok: true, attempted: 0, written: 0, failures: [], distributedAt: null };
}

export function createDistributionService({
  articleModel, // getById / update(present-only)
  distributionTargetModel, // query(filters)
  historyModel = null, // 미주입이면 이력 생략(기사 서비스의 record 헬퍼와 동일한 선례)
  spoolWriter = null, // { enabled, write({ target, payload }) } — 미주입/비활성이면 배부 비활성
  now = () => new Date().toISOString(), // 주입 시계(테스트 결정성). 반드시 ISO-8601 UTC 문자열이다.
  logger = null, // { debug, info, warn, error } — 미주입이면 무로그
} = {}) {
  // 로깅은 부가 기능이다 — 미주입·부분 구현·예외 어느 쪽도 배부를 막지 않는다.
  function log(level, message) {
    try { logger?.[level]?.(message); } catch { /* 로깅 실패는 배부를 막지 않는다 */ }
  }

  // 기사 1건을 audience에 해당하는 활성 수신처들에 배부한다.
  // 반환: { ok:true, attempted, written, failures:[{ targetId, spoolDir, reason }], distributedAt }
  //     | { ok:false, reason:'invalid-audience' | 'not-found' | 'error' }
  // options는 구조분해하지 않고 옵셔널 체이닝으로 읽는다 — 파라미터 기본값 분해는 호출자가 null을
  // 넘겼을 때 try 바깥에서 TypeError를 던져 "throw하지 않는다"는 계약을 깬다.
  function distribute(articleId, audience, options) {
    const actorUserId = options?.actorUserId ?? null;
    try {
      // 1) audience 검증 — 실패 시 DB·fs 접촉 0.
      const kinds = AUDIENCE_KINDS.get(audience);
      if (!kinds) return { ok: false, reason: 'invalid-audience' };

      // 2) 기사 조회. getById는 Article·Contents 중 하나만 있어도 행을 반환하므로 둘 다 요구한다.
      //    본문(Article) 없는 기사를 외부 수신처로 내보내는 것은 되돌릴 수 없다 — outbound는 fail-safe로 간다.
      //    (정상 생성 경로는 두 행을 한 트랜잭션에 넣으므로 이 분기는 손상 데이터에서만 발생한다.)
      const row = articleModel.getById(articleId);
      if (!row || !row.article || !row.contents) {
        if (row) {
          log('warn', `distribution skipped (broken row) articleId=${articleId}`
            + ` hasArticle=${!!row.article} hasContents=${!!row.contents}`);
        }
        return { ok: false, reason: 'not-found' };
      }

      // 3) 배부 비활성(스풀 루트 미설정 등)은 에러가 아니다. DB를 건드리지 않는다.
      if (!spoolWriter || !spoolWriter.enabled) {
        log('debug', `distribution disabled articleId=${articleId} audience=${audience}`);
        return nothing();
      }

      // 4) 대상 선택 — active는 정확히 'Y'인 행만 본다(엄격 판정).
      //    근거: DistributionTarget.active는 VARCHAR DEFAULT 'Y'이고 대상 관리 서비스가 항상 'Y'/'N'을
      //    stamp하므로 엄격 판정이 정상 행을 누락시키지 않는다. 직접 SQL로 NULL/이표기가 들어간 행만
      //    제외되며, outbound에서 "알 수 없는 활성 상태"를 배부하지 않는 쪽이 fail-safe다
      //    (오발송 피해는 미발송보다 비대칭적으로 크다 — 수집 쪽의 관대 판정을 여기로 "통일"하지 마라).
      //    kind도 화이트리스트 매칭이라 알 수 없는 값은 어떤 audience에도 포함되지 않는다.
      //    정렬은 모델의 ORDER BY id를 그대로 쓴다(결정적 순회).
      const targets = distributionTargetModel.query({ active: 'Y' }).filter((t) => kinds.includes(t?.kind));
      if (targets.length === 0) {
        log('debug', `distribution no targets articleId=${articleId} audience=${audience}`);
        return nothing();
      }

      // 5) 시계는 한 번만 읽는다 — 모든 대상 파일이 같은 타임스탬프(파일명·payload)를 쓰게 한다.
      const distributedAt = now();
      const failures = [];
      const doneDirs = new Set(); // 이번 호출에서 "성공적으로" 쓴 spoolDir 집합
      let written = 0;

      // 6) 대상마다 순서대로. 한 대상의 실패가 나머지를 중단시키지 않는다.
      for (const target of targets) {
        // 중복 spoolDir 방어: 유일성은 대상 관리 서비스(앱 계층)에서만 강제되므로 직접 SQL로 같은
        // 폴더를 가진 활성 대상 2건이 존재할 수 있다. 그대로 두면 뒤 대상이 앞 대상의 파일을
        // 덮어쓰면서 written만 2로 과대 보고된다(배부되지 않은 수신처가 배부된 것으로 기록된다).
        // 집합에는 성공한 것만 넣는다 — "시도" 기준이면 앞 대상이 실패했을 때 뒤 대상까지 skip되어
        // 실제로 배부 가능한 수신처를 놓친다.
        if (doneDirs.has(target.spoolDir)) {
          failures.push({ targetId: target.id, spoolDir: target.spoolDir, reason: 'duplicate-spool-dir' });
          log('warn', `distribution spool skipped articleId=${articleId} targetId=${target.id}`
            + ` spoolDir=${target.spoolDir} reason=duplicate-spool-dir`);
          continue;
        }

        const payload = buildDistributionPayload({
          article: row.article, contents: row.contents, target, audience, distributedAt,
        });

        let result;
        try {
          // 인자는 { target, payload } 둘뿐이다 — 파일명 재료(articleId·distributedAt)는 writer가
          // payload에서 파생한다(파일명과 내용이 어긋나는 버그 클래스를 구조적으로 제거).
          result = spoolWriter.write({ target, payload });
        } catch (err) {
          // writer 계약상 도달 불가(어떤 입력에도 throw하지 않는다). 계약이 깨지더라도 한 대상의
          // 예외가 나머지 수신처의 배부를 통째로 취소하면 안 되므로 실패 1건으로 흡수한다.
          result = { ok: false, reason: 'write-failed', message: String(err?.message ?? err) };
        }

        if (result?.ok) {
          written += 1;
          doneDirs.add(target.spoolDir);
          // 로그에는 식별자만 남긴다 — 기사 제목·본문·payload는 담지 않는다(로그 뷰어는 실데이터를
          // push하므로 노출 표면을 늘리지 않는다). 수집 로깅 관례와 동형.
          log('info', `distribution spool write articleId=${articleId} targetId=${target.id}`
            + ` spoolDir=${target.spoolDir} audience=${audience}`);
        } else {
          const reason = result?.reason ?? 'write-failed';
          failures.push({ targetId: target.id, spoolDir: target.spoolDir, reason });
          log('warn', `distribution spool failed articleId=${articleId} targetId=${target.id}`
            + ` spoolDir=${target.spoolDir} reason=${reason}`);
        }
      }

      // 7) 파일이 하나도 나가지 않았으면 DB를 건드리지 않는다(배부시간·이력 모두 없음).
      //    실패는 이력 행으로 남기지 않는다 — 이력에 성공/실패 구분 컬럼이 없어 "배부됨"으로 오독된다.
      //    실패 가시성은 로그가 담당한다.
      if (written === 0) {
        return { ok: true, attempted: targets.length, written, failures, distributedAt: null };
      }

      // 8-a) 배부시간 stamp는 최초 1회뿐이다. 이미 값이 있으면 갱신하지 않는다 —
      //      2차 엠바고 기사는 언론사 즉시배부 → 비언론사 시각배부로 두 번 배부되는 것이 정상인데
      //      매번 갱신하면 "언제 배부가 시작됐는가"를 영영 알 수 없게 된다(ADR-008 (4)).
      //      present-only update이므로 Contents의 다른 컬럼은 건드리지 않는다.
      if (!row.contents.distributedAt) {
        try {
          articleModel.update(articleId, { contents: { distributedAt } });
        } catch (err) {
          // 파일은 이미 나갔다 — 여기서 실패해도 결과는 ok:true여야 한다(배부는 되돌릴 수 없다).
          log('warn', `distribution stamp failed articleId=${articleId} message=${String(err?.message ?? err)}`);
        }
      }

      // 8-b) 이력은 배부 1회당 1행이다(수신처별 1행이 아니다 — 이력 모달이 수신처 목록으로 도배되면
      //      기사 생애주기 이력이라는 화면 의미가 무너진다. 대상별 상세는 스풀 파일과 로그가 증거다).
      //      eventType 'distribute'는 기존 'edit'/'status'에 값만 추가하는 additive 확장이다(스키마 무변경).
      //      action에 대상군을 담아 "언론사 배부가 끝났는가"를 후속 기능이 이력으로 판정할 수 있게 한다.
      //      fromStatus/toStatus/markupVersion은 전달하지 않는다(present-only insert → NULL).
      if (historyModel) {
        try {
          historyModel.insert({
            articleId,
            eventType: 'distribute',
            action: audience,
            actorUserId,
            createdAt: distributedAt,
          });
        } catch { /* 이력 기록 실패는 배부를 실패시키지 않는다(부가 기록) */ }
      }

      return { ok: true, attempted: targets.length, written, failures, distributedAt };
    } catch (err) {
      // 최후 안전망 — 주입된 의존성이 계약을 어기고 throw해도 상위(송고)로 예외를 전파하지 않는다.
      // 여기에 도달하는 경로는 전부 파일 기록 이전 단계다(기록 이후 단계는 각자 격리돼 있다).
      log('error', `distribution error articleId=${articleId} audience=${audience}`
        + ` message=${String(err?.message ?? err)}`);
      return { ok: false, reason: 'error' };
    }
  }

  return { distribute };
}
