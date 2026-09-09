# Step 12: docs-and-residual

P4 골격의 산출물을 문서화하고, **미검증 항목을 정직하게 기록**하며(게이트 문화 §8), 후속 phase(P5 에디터 코어)로의 인계를 남긴다. 코드 변경은 없다(DOCS + `index.json` forward_notes만).

## 읽어야 할 파일
- `phases/77-cpp-client-skeleton/index.json` (scope·decisions·excluded·open_questions — 마감 시점 사실과 대조)
- `docs/porting-plan-cpp-spring.md` §7 P4 행 · §9 규모 감각 · §10 열린 질문(닫힌 것·남은 것)
- `docs/cutover-p4.md`(step0~11이 채운 §0~§5) · `client-qt/README.md`(step3~)
- `phases/76-spring-cutover/index.json` forward_notes (스타일 참조 — 마감 실측 전문·인계 항목·미검증 정직 기록)
- step0~11의 산출(빌드·ctest·verify 결과)

## 작업
1. `docs/porting-plan-cpp-spring.md` §7 P4 행에 **[P4 완결 · 날짜]** 마감 주석을 순수 추가한다 — 산출물(shell 계약·net 35·로그인/목록·통합 verify)과 AC ①② 충족 근거. §10 열린 질문 중 이 phase가 닫은 것(빌드 시스템·go/no-go)은 상태 갱신, 남긴 것(ContentsVO.md=P5 blocker)은 그대로 표시.
2. `client-qt/README.md` 완성 — 빌드·테스트 커맨드(step0 실측 툴체인) · 모듈 레이아웃 · net 계약 정본(`MODEL_KEYS` 35) · diag 계약 미러링 · 통합 verify 커맨드 · **미구현/후속(에디터 P5 · 나머지 5화면 P6~P7 · 배포 P8)**.
3. `phases/77-cpp-client-skeleton/index.json`의 **forward_notes**에 인계 항목을 적는다(배열 채움):
   - 마감 실측 전문(ctest 수치·verify exit·`npm test` 무회귀·리포 news.db 무변)
   - **go/no-go 판정**(step2 결과 · evidence)
   - **P5 인계**: ContentsVO.md가 P5 착수 전 필요(사용자 소유) · 에디터 순수 로직은 스파이크 `editorlogic.*`에 있음 · net은 본문을 불투명 blob으로 나름
   - **미검증 정직 기록**: 자동 오프스크린으로 못 잡는 것(한글 IME 실기 체감·인쇄·클립보드 실사용 = P5~P6 육안 게이트) · diag 재매핑으로 생략한 렌더러 이벤트가 verify에서 검증되지 않는 축
   - diag 유지/재매핑 목록의 위치(`docs/cutover-p4.md` §5)
4. **DB 비파괴 전건 확인** 문구를 마감에 남긴다(이 phase는 DDL 0·행 삭제 0·리포 news.db md5 무변).

## Acceptance Criteria
```
cd /home/user/harness && git diff --stat        # docs/** + phases/77-*/index.json 만 · 소스 코드 무접촉
cd /home/user/harness && git diff docs/news.md   # 무출력(정본 불변)
cd /home/user/harness && npm test                # 1328 pass(문서 변경이 회귀 없음)
```
- `porting-plan` P4 행 마감 주석이 순수 추가(삭제 0줄)이고 AC ①② 충족 근거를 담는다.
- `index.json` forward_notes가 채워졌고(go/no-go·P5 인계·미검증 항목 포함), `client-qt/README.md`가 빌드·테스트·미구현을 담는다.

## 검증 절차
1. `git diff`로 이 step이 소스(`client-qt/**` 코드·`server-spring`·`web`·`client`)를 건드리지 않았는지 확인.
2. forward_notes가 "무엇을 검증했나/못했나"를 정직히 나누는지 확인(§8 게이트 문화).
3. 마감 수치가 step0 기준선과 대조되어 무회귀를 보이는지 확인.

## 금지사항
- 소스 코드를 수정하지 마라. 이유: 이 step은 문서·인계 전용이다 — 코드 변경은 앞 step에서 끝났어야 한다.
- 미검증을 "검증됨"으로 적지 마라. 이유: 게이트 문화의 핵심은 미검증의 정직한 기록이다(§8) — 특히 IME 실기 체감은 자동 검증이 못 잡는다.
- `docs/news.md`를 고치지 마라. 이유: 요구 정본은 사료다(step1과 같은 규율).
