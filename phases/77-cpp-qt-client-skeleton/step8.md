# Step 8: integration-verify

## 읽어야 할 파일

- `/docs/porting-plan-cpp-spring.md` (§7 P4 완료 게이트 — "로그인→목록 SSE 실시간 갱신 실기 + diag 이벤트로 자동 검증(기존 verify 스크립트 계약 재사용)" · §8 검증 전략)
- `/docs/api-contract/sse.md` · `/docs/api-contract/endpoints.json` (와이어 계약)
- `/docs/news-md-overrides.md` (L80 무효화 · L131 투영 · L22 로그인 — 통합 시나리오 판정 기준)
- `scripts/verify-client.mjs` (있으면 — diag JSONL 계약 검증 스크립트. **이 계약을 재사용**한다. 읽기 전용)
- `phases/77-cpp-qt-client-skeleton/step2~7.md` (net · shell · login · list 산출물 전부)

## 작업

**P4 done-criteria를 자동 검증**하는 통합 하네스를 만든다 — 로그인→목록 진입 후 SSE 단일 무효화 신호에 목록이 전체 재조회되는 흐름과, 그 과정의 diag JSONL이 계약을 지키는지를 기계 판정한다.

1. **통합 시나리오 테스트(`client-cpp/tests/`)**: 프로브(step 4)→로그인(step 6)→목록(step 7)→SSE 무효화(step 3)→목록 전체 재조회 의 end-to-end 경로를 하나의 테스트로 엮는다. 서버는 **로컬 목 HTTP+SSE 서버**(`QTcpServer`)로 세운다 — health `{ok:true}` · login `sid` 쿠키 발급 · articles 목록 · `/api/stream`에서 `ready` 후 트리거로 `change` 프레임 방출. 실제 Spring/Node 서버 없이 결정적으로 돈다.
2. **판정 규율**(sse.md decisions (10)): `ready` 수신 **후** 트리거를 쏘고, "유한 시간 안에 무효화 시그널 도착 → 재조회 1회 발생"을 단언한다(정확 개수/순서 단언은 flake — 유한 시간 도달로 판정). 다른 kind가 섞여 와도 통과.
3. **diag 자동 검증**: 시나리오 동안 방출된 diag JSONL을 수집해 **`scripts/verify-client.mjs`가 검사하는 계약과 동일 규칙**(이벤트 이름·필드·금지 키 부재)으로 검증한다. 가능하면 그 스크립트를 직접 호출하거나, 스크립트가 소비하는 JSONL 형식을 그대로 생성해 계약 위반이 0임을 단언한다.
4. **unauthorized 종료 경로**도 시나리오에 포함: 목 서버가 `unauthorized` 프레임을 보내면 SSE가 close + 무재연결 + 세션 만료 UX로 전이하는지 단언한다(L80).
5. **문서화(코드 주석/테스트명)**: 이 테스트가 P4 완료 게이트임을 명시한다. 실기(육안) 항목(IME·인쇄 등)은 P4 범위 밖이므로 여기서 판정하지 않는다.

**핵심 규칙:**
- **정확 프레임 개수/순서를 단언하지 마라**(sse.md). 이유: SSE는 다른 신호가 섞일 수 있어 flake가 된다 — "유한 시간 내 조건 도달"로 판정한다.
- **실제 원격 서버에 의존하지 마라.** 이유: 통합 테스트는 결정적이어야 한다(로컬 목으로 자족).
- **diag 계약을 새로 정의하지 마라.** 이유: 기존 `verify-client.mjs` 계약을 재사용하는 것이 P4 게이트의 요구다 — 계약을 바꾸면 검증이 무의미해진다.

## Acceptance Criteria

```bash
cmake -S client-cpp -B client-cpp/build -DCMAKE_BUILD_TYPE=Debug
cmake --build client-cpp/build -j
ctest --test-dir client-cpp/build --output-on-failure
# diag JSONL 계약 재사용 검증(스크립트 계약이 요구하는 입력 형식으로):
node scripts/verify-client.mjs --help 2>/dev/null || echo "verify-client 계약 규칙을 테스트에 내재화했다면 ctest로 충분"
```
(node 라인은 스크립트 인터페이스에 맞춰 실제 호출 커맨드로 구체화하라 — diag JSONL 파일 경로 인자 등. 스크립트가 Qt 산출 JSONL을 직접 받지 못하는 형식이면, 같은 계약 규칙을 ctest 내부에서 단언하고 그 사실을 summary에 남겨라.)

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트: end-to-end 경로가 로컬 목으로 결정적인가? 무효화→전체 재조회 판정이 flake-free(유한 시간 도달)인가? diag 계약이 verify-client 규칙과 동일한가? unauthorized 종료 경로가 검증되는가?
3. porting-plan §7 P4 게이트 충족(로그인→목록 SSE 갱신 + diag 자동 검증) 확인.
4. 결과 반영: 성공 → completed + summary(통합 시나리오 · diag 재사용 방식 · P4 게이트 충족 명시). 실패 3회 → error. 실기(육안) 항목은 P4 밖임을 forward_notes로 정직히 기록.

## 금지사항

- SSE 프레임 개수/순서를 정확 단언하지 마라. 이유: flake의 원인이다.
- 실제 Spring/Node 서버를 통합 테스트 의존성으로 걸지 마라. 이유: 비결정성·환경 의존을 만든다.
- `scripts/verify-client.mjs`·`client/**`·계약(`docs/api-contract/**`)을 고치지 마라. 이유: 재사용 대상 계약은 정본이다.
- 에디터/인쇄/IME 실기 항목을 P4 게이트에 넣지 마라. 이유: P5~P6 범위다.
- 기존 테스트를 깨뜨리지 마라.
