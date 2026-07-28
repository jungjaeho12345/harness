# Step 1: distribute-notify

배부가 **실제로 일어났음**을 배부 서비스가 외부에 알릴 수 있게 선택적 콜백 `onDistributed`를 추가한다.
이 신호가 phase 48의 3번째 요구사항("배부 완료 후 SSE 무효화 신호 재발행 — 목록의 배부시간 즉시 갱신")의 근원이다.

**왜 여기인가**: 배부 경로는 둘(송고 훅 fire-and-forget · tick pull)이지만 둘 다 `distributionService.distribute()`를 통과한다.
송고 훅은 `Promise` 반환값을 버리므로(articleService 174~186행) 라우트가 `distributedAt` 갱신 시점을 알 수 없다 —
그래서 라우트에서 SSE를 한 번 더 쏘는 방식으로는 해결되지 않는다. 알림의 단일 지점은 배부 서비스뿐이다.

이 step은 파일 1개(`src/services/distributionService.js`)만 수정한다. 결선(SSE로 잇기)은 step3/step4다.

## 읽어야 할 파일

- `src/services/distributionService.js` — 전체. 특히 `onFailure` 콜백(17~31행, `notifyFailure`)의 **격리 관례**: 콜백이 throw해도 배부를 깨뜨리지 않는다. `onDistributed`도 똑같이 만든다.
- `src/services/articleService.js` 174~186행 — 송고 훅의 fire-and-forget 호출부(반환값을 보지 않는다).
- `test/distributionService.test.js` — 기존 12건. 가짜 spoolWriter/in-memory DB 주입 관례. **기존 단언을 깨지 마라.**
- `docs/ADR.md` ADR-005(SSE는 행 데이터 없는 무효화 신호), ADR-008.

## 작업

**TDD: 테스트를 먼저 쓰고 red를 확인한 뒤 구현한다.**

### 1) 테스트 (`test/distributionService.test.js`에 추가)

- 배부 성공 1건 이상이면 `onDistributed`가 **정확히 1회** 호출된다(수신처 N곳이어도 배부 호출당 1회 — SSE는 무효화 신호이므로 폭주시키지 않는다).
- 호출 인자는 `{ articleId, kinds, count }` 형태의 요약이다 — **기사 본문·수신처 경로·페이로드를 담지 않는다**(ADR-005: 신호에 행 데이터 없음).
- 전량 실패(스풀 쓰기 실패)면 `onDistributed`는 호출되지 않는다(`distributedAt`도 갱신되지 않으므로 알릴 변경이 없다).
- `kinds`가 빈 배열/미지 값이라 아무 것도 하지 않은 경우, 기사 없음(`not-found`), `spool-disabled`인 경우 호출 0회.
- `onDistributed`가 throw해도 `distribute()`는 정상 결과(`{ ok:true, distributed, failed }`)를 반환한다(격리 — `onFailure`와 동형).
- `onDistributed` 미주입이어도 기존 동작이 그대로다(하위호환 — 기존 12건이 그대로 통과).

### 2) `src/services/distributionService.js`

- `createDistributionService({ ..., onFailure, onDistributed })` — 선택 의존성 1개 추가.
- 호출 시점: `distributed.length > 0`이라 `articleModel.update(..., { contents: { distributedAt: now() } })`를 실행한 **직후** 1회.
  이유: SSE 신호를 받은 클라이언트가 재조회했을 때 `distributedAt`이 이미 DB에 있어야 한다(신호가 쓰기보다 빠르면 옛 값이 다시 그려진다).
- `notifyFailure`와 같은 try/catch 격리 헬퍼로 감싼다. 콜백 실패가 배부 결과를 바꾸지 않는다.
- 반환 계약(`{ ok, distributed, failed }` / `{ ok:false, reason }`)을 바꾸지 마라 — 호출자(articleService·step2 tick)가 의존한다.

## Acceptance Criteria

```bash
npm test && npm run lint
```

- 백엔드 테스트 전량 green(step0 결과 대비 신규분만 증가, 회귀 0), lint 경고 0.

## 검증 절차

1. 구현 전 신규 단언에서 red를 확인한다.
2. `grep -nE "setInterval|setTimeout|fetch\(|node:fs" src/services/distributionService.js` → 0건 유지.
3. `git diff --stat` — `src/services/distributionService.js`와 `test/distributionService.test.js` 2개만 변경됐는지 확인한다.

## 금지사항

- 콜백 payload에 기사 본문(`markupVersion`)·`contents` 전체·스풀 파일 경로를 담지 마라. 이유: 이 값은 SSE로 전 구독자에게 브로드캐스트된다(ADR-005는 역할별 노출을 피하려고 신호에 행 데이터를 담지 않는다).
- 수신처마다 콜백을 호출하지 마라. 이유: 수신처 N곳이면 SSE 신호 N개 → 클라이언트 재조회 N회. 무효화 신호는 한 번이면 충분하다.
- 콜백 예외를 밖으로 전파시키지 마라. 이유: 송고 훅은 `.catch(() => {})`로 삼키므로, 여기서 새면 배부 실패인지 알림 실패인지 구분할 수 없는 무음 오류가 된다.
- `articleService.js`·컨트롤러·라우트를 이 step에서 건드리지 마라. 이유: 결선은 step3/step4의 책임이며, 계층을 섞으면 실패 원인 격리가 불가능해진다.
