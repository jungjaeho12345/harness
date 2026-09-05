# Step 6: cutover-runbook-final

## 읽어야 할 파일

- `phases/76-server-cutover-ops/index.json` — scope·**decisions (1)(2)(4)** ·excluded (a)(b)(c)(d)(e)(f).
- `docs/ops-mysql.md` — **정본 런북**. 특히 §7(삭제 예외 grant) · §9(되돌리기) · §11(운영 컷오버 런북 — 0 체크리스트→1 사전→2 계정→3 migrate→4 verify→4-b grant→5 Spring 기동→6 Node 중단→7 롤백→8 실패 분기) · §12(명령별 실행 결과표 25행). 이 step은 이 문서를 **확장**한다(별도 문서 신설 금지 — 운영자가 한 곳을 본다).
- `phases/75-mysql-migration/index.json` `forward_notes` (2)(6)(7) — P2가 무엇을 실증했고 무엇을 P3에 넘겼는지, 특히 (7) GRANT 부재와 그 육안 판정 절차.
- `scripts/operation-scenario.mjs`(step1·2 산출물) — 컷오버 전 검증 게이트로 런북이 인용할 도구.
- `server/deprecationBanner.js`(step5) · `NODE_SERVER_DEPRECATED`(step5) · `NEWS_SERVER_URL`(step4) — 런북이 인용할 플래그.
- `docs/ADR.md` — ADR-008(운영 cron이 `POST /api/distribution/tick`을 pull) · ADR-016(병존 정상 상태).

## 배경

로드맵 P3의 사람 몫(정지 창·백업·승인·root)은 **실행하지 않고 절차로 정본화**한다. §11 런북은 이미 명령을 스테이징에서 실측했다. 이 step은 그 위에 **P3 컷오버 실행 체크리스트**와 이 phase가 새로 만든 도구/플래그를 엮어, 운영자가 한 문서만 따르면 되게 한다.

## 작업

`docs/ops-mysql.md`에 **P3 컷오버 실행 체크리스트** 절(예: §13)을 추가한다. 반드시 담을 항목:

1. **선결 조건 게이트(go/no-go).** 컷오버 시작 전 통과해야 하는 항목:
   - **[GRANT] `GRANT DELETE ON news.ReceiverConfig`** — 운영 `news`에 붙었는지 `SHOW GRANTS`로 **육안 판정**(계약 패리티·`--db mysql`은 `news_ct`=ALL로 돌아 이 부재를 못 본다 — decisions (2)). 없으면 `migrate`로 테이블이 생긴 뒤 root로 §7 절차(멱등 재실행 또는 한 줄 GRANT)를 적용한다. 부재 시 증상(`DELETE /api/receiver-config/:id`가 500 `internal-error`, Node는 200)을 명시. 자동 방어선(`NewsAppMysqlWireTest`·`MinimumPrivilegeBoundaryTest`)이 스테이징에서 무엇을 실증하는지 인용.
   - **[검증 게이트] 시나리오 하네스** — 컷오버 리허설로 `node scripts/operation-scenario.mjs --dual --db mysql`(ephemeral)이 **스풀 diff 0**임을 먼저 통과. 이 게이트가 "작성→송고→배부→수집 + 배부 스풀 바이트 대조"를 자동 판정한다.
   - **[대상 비어있음]** 운영 `news`가 테이블 0(또는 빈 스키마) — §11-0-6.
2. **정지 창 순서**(§11을 참조 링크 · 중복 금지): Node 정지 → 원본 사본 → `migrate` → `verify`(exit 0) → **GRANT 부착** → Spring `DB_KIND=mysql` 기동 → 육안 확인(마지막 항목=수집 설정 생성·삭제=GRANT 실사용) → **클라이언트 재지정** → Node 은퇴 표시.
3. **클라이언트 재지정 절차**(P3의 "clients at Spring"): 세 경로를 명시 — (a) **동일 host:port 교체**(Spring이 기존 주소를 승계 → 클라 무변경 · 강권장) (b) 병행 창에서 일부 클라만 Spring으로: 설정 화면에서 serverUrl 변경 또는 배포에 **`NEWS_SERVER_URL`**(step4) 주입 (c) 브라우저 SPA는 Spring 오리진 접속. 각 경로의 되돌림(주소 원복)도 적는다.
4. **운영 cron(tick) 전환**(ADR-008): 외부 cron이 Z 세션으로 `POST /api/distribution/tick`을 pull하는 대상을 Node→Spring으로 **재지정**하는 절차. 앱에 타이머를 두지 않음을 재확인하고, 병행 창에서 **두 서버가 동시에 tick pull되지 않도록**(중복 배부 방지) cron을 한쪽만 겨누게 하는 규율을 명시.
5. **Node 은퇴 표시**: 컷오버 확정 후 Node를 다시 띄울 경우 **`NODE_SERVER_DEPRECATED=1`**(step5)로 기동해 경고 배너를 남긴다. **sqlite 분기는 제거하지 않는다**(롤백 레버 · excluded (c)). "Node에 쓰기가 일어나면 두 저장소가 갈린다"(§11-6 경고) 재인용.
6. **롤백 포인터**: 문제 시 §9/§11-7 절차로(클라 무변경 복귀). 되돌린 뒤에도 MySQL·원본 `news.db`를 지우지 않는다.
7. **정직한 미실행 표시**: 운영 대상 명령(`migrate --target news` 등)은 이 phase에서 **미실행**이며 사람 몫임을 §12 표 규약(미실행/스테이징 구분)과 일관되게 남긴다.

문안은 §11/§12와 **모순되지 않게** 하고, 이미 있는 내용은 링크·참조로 재사용한다(중복 절차 작성 금지).

## Acceptance Criteria

```bash
# 문서 필수 토큰·참조 존재 확인(runnable 게이트)
grep -q "operation-scenario" docs/ops-mysql.md
grep -q "GRANT DELETE ON" docs/ops-mysql.md
grep -q "NODE_SERVER_DEPRECATED" docs/ops-mysql.md
grep -q "NEWS_SERVER_URL" docs/ops-mysql.md
grep -q "distribution/tick" docs/ops-mysql.md
grep -q "SHOW GRANTS" docs/ops-mysql.md
# 회귀(문서 변경이 코드 게이트를 깨지 않음)
npm run lint && npm test && node --test scripts/lib/spoolCanon.test.mjs
```

## 검증 절차

1. 위 grep 게이트와 회귀 AC를 실행한다.
2. 사람 리뷰 체크리스트(문서 품질):
   - GRANT 선결 조건이 **go/no-go 필수**로 박혔고 `SHOW GRANTS` 육안 판정이 명시됐는가(패리티가 못 봄을 적었는가)?
   - 시나리오 하네스가 컷오버 전 검증 게이트로 인용됐는가?
   - cron 전환이 ADR-008(외부 pull · 중복 방지)과 일관된가?
   - 클라 재지정 3경로와 각 되돌림이 있는가?
   - Node 은퇴가 sqlite 분기 유지·`NODE_SERVER_DEPRECATED`로 표현됐는가?
   - §11/§12와 모순·중복이 없는가?
3. step 6을 업데이트한다(completed→summary / error→error_message / blocked→blocked_reason).

## 금지사항

- 운영 대상 컷오버 명령을 "실행됨"으로 적지 마라. 이유: 이 phase는 운영 데이터를 옮기지 않는다 — 미실행·사람 몫으로 정직히 표시한다(§12 규약).
- GRANT를 하드닝 옵션으로 낮춰 적지 마라. 이유: 없으면 수집 설정 삭제가 계약 위반(500)이고 패리티가 그것을 덮는다 — **계약 필수 조건**이다.
- §11/§12와 모순되는 절차를 새로 쓰지 마라. 이유: 두 절차가 갈리면 운영자가 조용한 실패에 빠진다(§7 ParserError 선례).
- 앱에 cron/타이머를 넣는 절차를 적지 마라. 이유: ADR-008은 외부 pull만 허용한다.
- 코드·계약을 고치지 마라(이 step은 문서 전용).
- 기존 테스트를 깨뜨리지 마라.
