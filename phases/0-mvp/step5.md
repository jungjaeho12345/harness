# Step 5: collection-services

## 읽어야 할 파일

- `/docs/RCV.md` — **수집(자동기사) 기술 명세서 (이 step의 1차 기준)**. 수신(FTP 이벤트/API) → 분석(제목·본문) → 등록(Article/Contents), 속성 '자동기사' 필수, 미등록 ID 차단, rcvMgmt.do 설정 CRUD.
- `/docs/SCHEMA.md` — Article/Contents, `attribute` 컬럼
- `src/models/articleModel.js`, `src/models/receiverConfigModel.js` (step2)
- `src/services/articleService.js` (step3 — create 재사용), `src/services/authorization.js` (step4 — Z 게이트)

## 작업

수집 파이프라인과 수신 설정 서비스를 구현한다. 외부 FTP/네트워크는 직접 붙이지 말고 **주입된 어댑터/페이로드**로 추상화한다(테스트 가능성). TDD.

1. `src/parsers/parser.js` + `src/parsers/defaultParser.js`:
   - `export function parse(payload)` → `{ title, content }`. FTP 파일/ API 응답 데이터에서 제목·본문을 추출. defaultParser는 기본 포맷 처리.
2. `src/services/collectionService.js` — `export function createCollectionService({ articleService, receiverConfigModel, parser })`:
   - `receive(sourceId, payload)` — **등록되지 않은 sourceId면 수신 거부**(`{ ok:false, reason:'unregistered' }`). 등록된 경우 parse 후 Article/Contents로 등록하되 **Contents.attribute(속성)에 '자동기사'를 반드시 기록**한다. 등록은 articleService.create 재사용(상태 RDS, 트랜잭션).
3. `src/services/receiverConfigService.js` — `export function createReceiverConfigService({ receiverConfigModel, authorization })`:
   - `query(sessionId, filters)`, `create(sessionId, entry)`, `remove(sessionId, id)` — **모두 Z 전용**(authorization 게이트). 미인증/비-Z는 `{ ok:false, reason }`. remove는 설정 행만 제거(수집된 기사 보존).
4. 테스트: 미등록 ID 차단, '자동기사' 속성 기록, 파싱, Z 게이트, 설정 CRUD. 가짜 payload/주입 어댑터로 네트워크 없이.

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. AC 실행.
2. 체크리스트: 미등록 sourceId를 거부하는가? 등록 기사에 attribute='자동기사'가 들어가는가? 설정 CRUD가 Z 전용인가? 실제 FTP/네트워크에 의존하지 않는가?
3. step 5 업데이트(completed + summary: receive/CRUD 시그니처, parser 계약).

## 금지사항

- 미등록 ID의 데이터를 등록하지 마라. 이유: rcv.md 수신 명세.
- attribute='자동기사'를 누락하지 마라. 이유: rcv.md 규칙(자동기사는 속성에 '자동기사' 필수).
- 이미 수집된 Article/Contents를 삭제하지 마라(설정 행만 삭제). 이유: DB 비파괴.
- 실제 FTP 서버/외부 HTTP를 코드에 하드코딩하지 마라(주입). 기존 테스트를 깨뜨리지 마라.
