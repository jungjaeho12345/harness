# Step 1: requirements-reconciliation

**선행 게이트 ①** — `docs/news.md`를 포팅 요구사항 정본으로 쓰기 전에, ADR이 news.md를 덮어쓴 지점을 확정해 **「ADR-overrode-news.md」 목록**을 만든다. 그리고 이 phase의 **전환 아키텍처를 ADR로 신설**한다(코드 0줄 — DOCS/ADR만).

## 읽어야 할 파일
- `docs/news.md` 특히 **174행 부근**(Alt+Y `spellcheck=true, lang=ko`) · **301행 부근**(`CORS는 개발 클라이언트(localhost:5173)만 허용한다`)
- `docs/ADR.md` — **ADR-011**(셸 `spellcheck:false` 확정 · 맞춤법은 SPA 메뉴) · **ADR-004/009**(CORS·CSRF는 `ALLOWED_ORIGINS` 체계) · **ADR-013/016/017**(Spring 포팅·MySQL·전환 아키텍처의 선례 서술 방식)
- `docs/ARCHITECTURE.md` 「보안 경계」(allowlist·`ALLOWED_ORIGINS`·프로덕션 규율)
- `docs/porting-plan-cpp-spring.md` §10 열린 질문 8(news.md 드리프트 2건) · §6.2(클라이언트 매핑 · 렌더러 4이벤트 재매핑)
- `phases/77-cpp-client-skeleton/index.json` (decisions 전부 — 이 step이 ADR로 굳힐 내용)
- `phases/76-spring-cutover/index.json` (ADR-017을 어떻게 서술했는지 — 실측 좌표·조건절 남기기 스타일 참조)

## 작업
1. **「ADR-overrode-news.md」 목록 확정**(문서에 표로). 최소 2건:
   - news.md ~174행 `spellcheck=true, lang=ko` → **ADR-011이 셸 한정 무효화**(`spellcheck:false` 확정 · 맞춤법은 SPA/앱 메뉴 책임). 포팅 요구로 읽을 때 "Alt+Y가 브라우저 맞춤법을 켠다"는 서술은 **네이티브에 그대로 이식하지 않는다**(P6 앱 맞춤법으로 대체)임을 명시.
   - news.md ~301행 `CORS는 개발 클라이언트(localhost:5173)만 허용` → **현행은 `ALLOWED_ORIGINS` 체계**(비프로덕션 기본 localhost:5173 · 프로덕션은 명시 출처만 · 동일 출처 배포는 빈 목록이 정상 — ADR-017). 포팅 요구로 읽을 때 이 한 줄을 문자 그대로 이식하지 않는다.
   - 조사 중 추가로 발견되는 드리프트가 있으면 같은 형식으로 추가한다(발견 없음도 사실로 기록).
2. **news.md는 수정하지 않는다** — 원문은 사료로 보존한다. 목록은 **`docs/cutover-p4.md` §1**(step0이 자리표시자로 만들어 둔 정본 앵커)에 둔다(대안 문서 없음). "정본을 고치는 것이 아니라, 정본을 읽는 렌즈를 명문화"하는 것이다.
3. **전환 아키텍처 ADR 신설**(순수 추가 — 기존 ADR 본문 삭제·수정 0줄). 다음 결정을 `docs/ADR.md`에 새 번호(ADR-018 등, 현재 최대 번호 +1)로 못박는다(index.json decisions (1)~(9)를 근거와 함께):
   - UI 툴킷 Qt 6 확정 · **빌드 CMake** · 클라이언트 모듈 `client-qt/` 위치와 레이아웃
   - net 계약 정본 = `MODEL_KEYS` 35 · REST 동일 출처 상대 경로 · 헤더 4종
   - 세션 쿠키 인증 · SSE 쿠키 전용·`event: unauthorized` 처리 · `?session=` 금지
   - diag JSONL 계약 미러링(셸 계열 유지 · 렌더러 4이벤트 재매핑/생략은 step5 확정)
   - config.json 화이트리스트(세션·자격증명 0) · 단일 인스턴스(클라 축 · ADR-012와 별개) · `spellcheck` off
4. `docs/porting-plan-cpp-spring.md` §10 열린 질문 8을 **닫힘([step1 확정 · 날짜])** 으로 갱신하고, 열린 질문 7(ContentsVO.md)은 **P4 범위 밖 + 사용자 소유 blocker**로 상태를 조정한다(내용 삭제 금지 — 상태 주석만 추가).

## Acceptance Criteria
```
cd /home/user/harness && git diff --stat        # docs/** 만 바뀐다(news.md·소스 코드 무접촉)
cd /home/user/harness && git diff docs/news.md   # 무출력(원문 보존)
cd /home/user/harness && npm test                # 1328 pass · 0 fail(문서 변경이 코드 회귀를 부르지 않음 확인)
```
- 「ADR-overrode-news.md」 목록이 최소 2건(spellcheck · CORS)을 근거 ADR과 함께 담는다.
- 새 ADR이 **순수 추가**다: `git diff docs/ADR.md`가 기존 ADR 라인 삭제 0(추가 블록만).

## 검증 절차
1. `git diff docs/news.md`가 무출력임을 확인(정본 불변).
2. 새 ADR 번호가 현재 최대 +1이고 기존 ADR 본문이 한 줄도 지워지지 않았는지 `git diff docs/ADR.md`로 확인.
3. 목록의 각 항목이 "news.md 문장 → 그것을 덮은 ADR → 포팅 시 처분"을 다 담는지 확인.

## 금지사항
- `docs/news.md`를 수정하지 마라. 이유: 요구사항 정본은 사료다 — 드리프트는 news.md를 고쳐서가 아니라 별도 렌즈 문서로 정리한다(§10-8의 지시).
- 기존 ADR 본문을 고쳐 쓰지 마라(순수 추가만). 이유: ADR은 시점 기록이라 소급 수정하면 결정 이력이 위조된다.
- 코드(소스·테스트·스크립트)를 건드리지 마라. 이유: 이 step은 게이트 ①(요구 정리)이며 구현이 아니다.
