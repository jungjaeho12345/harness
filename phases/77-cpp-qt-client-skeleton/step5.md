# Step 5: shell-instance-diag

## 읽어야 할 파일

- `/docs/ADR.md` (ADR-011 — 단일 인스턴스(잠금) · 창 bounds 저장(close 시 1회 · workArea 교차) · diag JSONL 이벤트/필드/금지 키 · userData→단일 인스턴스 잠금 순서)
- `/docs/porting-plan-cpp-spring.md` (§6.2 "Electron 셸 계약의 처분" — 이식 필수: 단일 인스턴스(named mutex) · 창 bounds · diag JSONL 이벤트/필드/금지 키 7종(렌더러 계열 4이벤트만 재매핑))
- `client/diag.js` (있으면 — diag JSONL 이벤트 이름·필드·금지 키의 정본. 읽기 전용, 이식 명세)
- `scripts/verify-client.mjs` (있으면 — diag JSONL 계약을 검증하는 기존 스크립트. **P4 done-criteria가 이 계약을 재사용**한다. 읽기 전용)
- `phases/77-cpp-qt-client-skeleton/step0.md`(shell/) · `step4.md`(config 경로/userData)

## 작업

`client-cpp/shell/`에 **단일 인스턴스 잠금 · 창 bounds 저장 · diag JSONL 방출**을 추가한다. diag는 step 8의 자동 검증(P4 완료 게이트)이 소비하는 산출물이다.

1. **단일 인스턴스**: `QLockFile`(또는 OS named mutex 등가)로 데이터 폴더당 1 인스턴스만 뜨게 한다. 부팅 순서는 ADR-011대로 **userData(config 경로) 확정 → 잠금** 순이다(잠금 키가 userData에서 파생). 두 번째 인스턴스는 조용히 종료(또는 기존 창 포커스).
2. **창 bounds 저장**: 창을 **닫을 때 1회** 현재 geometry를 저장하고, 다음 기동에 복원한다. 복원 시 **workArea(가용 화면 영역)와 교차 판정**해 화면 밖으로 사라진 창을 보정한다. 저장은 config(step 4)의 화이트리스트 스키마에 bounds 키를 additive로 추가하거나 별도 상태 파일로 둔다(원자적 쓰기 유지).
3. **diag JSONL 방출(`shell/diag`)**: `client/diag.js`의 **이벤트 이름·필드·금지 키 7종**을 이식한다. Electron의 렌더러 계열 4이벤트는 Qt 네이티브 대응으로 **재매핑**한다(프로세스 경계/preload 개념은 소멸 — §6.2). JSONL 라인마다 스키마를 지키고, 금지 키(세션 토큰·자격증명 등)를 **절대 싣지 마라**(LOGS.md 마스킹 규율과 동형).
4. **테스트**(TDD): 단일 인스턴스(두 번째 잠금 실패) · bounds 저장/복원 + workArea 밖 보정 · diag JSONL 각 이벤트의 필드 스키마 준수 + 금지 키 부재 를 단언한다. diag 스키마 단언은 `scripts/verify-client.mjs`가 검사하는 계약과 동일 규칙이어야 한다(step 8이 그 스크립트 계약으로 재검증).

**핵심 규칙:**
- **diag JSONL에 금지 키(세션/자격증명/비밀번호)를 싣지 마라.** 이유: 진단 로그가 민감정보 유출 경로가 된다(LOGS.md 마스킹).
- **부팅 순서(userData→잠금)를 지켜라.** 이유: 잠금 키가 userData에서 파생되므로 순서가 뒤바뀌면 잠금이 무의미해진다.
- **bounds 복원 시 workArea 교차 판정을 생략하지 마라.** 이유: 모니터 구성이 바뀌면 창이 화면 밖에 복원돼 조작 불가가 된다.

## Acceptance Criteria

```bash
cmake -S client-cpp -B client-cpp/build -DCMAKE_BUILD_TYPE=Debug
cmake --build client-cpp/build -j
ctest --test-dir client-cpp/build --output-on-failure
```

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트: 단일 인스턴스 잠금이 userData 파생인가? bounds가 close 시 1회 저장 + workArea 교차 복원인가? diag JSONL이 이벤트/필드/금지 키 계약을 지키는가?
3. ADR-011 · §6.2 셸 계약 · `client/diag.js` 스키마 반영 확인. 금지 키 부재를 명시 테스트로 잠갔는가?
4. 결과 반영: 성공 → completed + summary(잠금 방식 · bounds 규칙 · diag 이벤트 목록/재매핑). 실패 3회 → error.

## 금지사항

- diag JSONL에 세션/자격증명/비밀번호를 싣지 마라. 이유: 진단 로그가 유출 경로가 된다.
- 창 bounds를 매 이동마다 저장하지 마라. 이유: 계약은 close 시 1회다(잦은 디스크 쓰기·경합 방지).
- 잠금을 userData 확정 전에 걸지 마라. 이유: 잠금 키가 userData에서 파생된다.
- `scripts/verify-client.mjs`·`client/**`를 고치지 마라. 이유: diag 계약은 재사용 대상(정본)이며 Electron 클라는 보존한다.
- 기존 테스트를 깨뜨리지 마라.
