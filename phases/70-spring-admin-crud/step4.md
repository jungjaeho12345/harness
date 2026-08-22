# Step 4: distribution-target-service

배부 수신처 서비스(게이트·검증·soft delete·투영)를 이식한다. HTTP·파일시스템 비의존. 라우트를 늘리지 않으므로 계약 scope는 그대로.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — 전체(특히 decisions **(2)(3)(4)(5)(6)(7)(8)(10)** · excluded (a))
- `src/services/distributionTargetService.js` — 이식 정본(query·create·update·deactivate · 검증 순서 · self-exclusion · applyPatch 단일 경로 · normalizeId)
- `src/services/spoolDir.js` — 슬러그 규칙(step0이 `SpoolDir.java`로 이식)
- `src/services/authorization.js` — `manageDistributionTarget`(Z 전용)
- `server-spring/src/main/java/harness/news/service/Authorization.java` — 확장 대상(CAPABILITIES 행 추가)
- `server-spring/src/main/java/harness/news/service/Iso8601.java` — 시각 문자열(밀리초 3자리 + Z) · 주입 `Clock` 빈 패턴(`AppConfig`·`DbConfig` 참고)
- **step0·2에서 만든 파일**: `service/SpoolDir.java` · `model/DistributionTargetRepository.java`

## 작업 (테스트 먼저)

1. **테스트 먼저** — `DistributionTargetServiceTest` 신설. 덮을 계약(Node 대조 — **작업 A로 실측**):
   - **인가**(모든 op): 미인증 401 · 비-Z(R/D) → `forbidden` · Z 통과.
   - `create`: **검증 순서 = name → kind → spoolDir → active**(순서 고정). 사유: `invalid-name`(비문자열·빈 문자열·trim 후 빈·100자 초과) · `invalid-kind`(`press`/`nonpress` 밖 · 대소문자 보정 없음 — `PRESS` 거부) · `invalid-spool-dir`(`SpoolDir.sanitize`가 `''` 반환 시) · `duplicate-spool-dir`(비활성 행 포함 유일성 — 다른 행이 같은 slug를 쓰면) · `invalid-active`(`Y`/`N` 밖). 성공 → `{ok:true, id}` · active 미지정 기본 `'Y'` · **createdAt·updatedAt을 `now()`로 stamp**(decisions (6)) · id·createdAt·updatedAt은 서버가 정한다(entry 동명 필드 무시).
   - `update`: **present-only**(전달 필드만 검증·반영) · **존재 확인이 검증보다 먼저**(없는 id → `not-found`, 없는 id가 검증 사유로 둔갑 금지) · 하나라도 규칙 위반이면 아무것도 저장 안 함 · `spoolDir` 중복 검사에서 **자기 자신 제외**(`normalizeId`로 엄격 정수 비교 — 문자열 `'1'`은 자기를 못 거른다) · 성공 → `{ok:true, changes}` + updatedAt 갱신.
   - `deactivate`: `applyPatch(id, {active:'N'})`로 update와 **같은 헬퍼로 수렴**(감사 기록이 진입점마다 달라지지 않게) · soft delete(행 안 지움) · 성공 `{ok:true, changes:1}` · 없는 id → `not-found`.
   - **NaN id**(update·deactivate): `normalizeId(Number(id))` → NaN → `findById` 매치 없음 → `not-found` **404**(500 아님 — decisions (7), 작업 A로 확정).
   - **주입 Clock**: `now()`는 주입 `Clock` 빈에서만(테스트 결정성 · `System.currentTimeMillis()` 금지).
2. 구현 전 red 관측·기록.
3. `Authorization.CAPABILITIES`에 `MANAGE_DISTRIBUTION_TARGET = "manageDistributionTarget" → [Z]` 행 추가. `service/DistributionTargetService.java` 구현(생성자 주입 · SAFE_FIELDS 7키 allowlist · `applyPatch` 단일 상태 변경 경로 · `normalizeId` 엄격 비교 · `SpoolDir.sanitize` 재사용). green 확인.

## Acceptance Criteria

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B verify
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 sh ./mvnw -B -q package -DskipTests
cd /home/user/harness && node scripts/spring-contract.mjs --parity
cd /home/user/harness && npm test
```

- 1번: failures/errors 0. 테스트 수 증가.
- 3번: exit 0 · 전 프로파일 `diffs=0`.
- 4번: **1328/1328**.

## 검증 절차

1. **작업 A(Node 대조)**: `src/services/distributionTargetService.js`를 직접 관측 — 검증 순서·self-exclusion·NaN→not-found·present-only·stamp·soft delete 실측. Java 1:1.
2. **변이 실증**(원복 · 2종): (a) 검증 순서를 kind→name으로 바꾸면 순서 테스트가 red인지(같은 입력이 다른 사유를 받는다) (b) self-exclusion을 `Objects.equals(String)` 느슨 비교로 바꾸면 자기 slug 재저장 시 duplicate로 오판하는지.
3. **applyPatch 단일 경로 확인**: update와 deactivate가 같은 헬퍼로 수렴(updatedAt stamp가 한 곳)임을 확인.
4. `Authorization`에 이 step 전에 없던 `manageDistributionTarget` 행이 이 step에서 추가됐는지 확인(step3에서 미리 넣지 않았어야 함).

## 금지사항

- 검증 순서를 바꾸지 마라(name→kind→spoolDir→active). 이유: 같은 입력이 다른 400 사유를 받아 계약이 갈린다.
- self-exclusion을 문자열/느슨 비교로 하지 마라. 이유: 문자열 `'1'`은 자기 자신을 중복 검사에서 못 걸러 자기 slug 재저장이 `duplicate-spool-dir`로 오판된다(`normalizeId` 엄격 정수 비교).
- `kind`/`active`를 대소문자 보정하지 마라. 이유: 정본은 집합 검사라 `PRESS`·`y`를 거부한다 — 보정하면 계약이 갈린다.
- 스풀 디렉토리를 만들거나 파일을 쓰지 마라. 이유: spoolDir는 저장만 하는 문자열이고 실제 스풀 쓰기는 배부 실행 phase(ADR-008)다.
- `System.currentTimeMillis()`/`new Date()`를 직접 부르지 마라. 이유: 시각은 주입 `Clock` 빈에서만(테스트 결정성·ADR-013).
- createdAt을 update에서 바꾸지 마라. 이유: createdAt은 서버 소유이고 수정으로 바뀌지 않는다(계약 `createdAtStable`).
