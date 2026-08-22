# Step 5: distribution-target-service

배부 대상 서비스를 만든다 — `DistributionTargetService`(Z 게이트 → 조회 시 SAFE_FIELDS 7키 투영 · **검증 후** 생성 · present-only 수정 · deactivate). 검증에 쓰는 spoolDir 슬러그 규칙은 순수 헬퍼(`SpoolDir`)로 단일 출처 이식한다. 인가는 `Authorization`에 `MANAGE_DISTRIBUTION_TARGET` capability를 추가해 재사용한다.

이 step은 **service 계층만** 건드린다. 컨트롤러가 없어 `distribution-targets.contract.js`는 아직 green이 될 수 없다 — 판정은 Java 서비스/헬퍼 단위 테스트 + 이미 green인 scope 무회귀다.

## 읽어야 할 파일

- `phases/70-spring-admin-crud/index.json` — decisions **(3)(4)(5)(6)(7)(8)(9)(10)(12)(14)** · forward_notes (3)②③④⑤
- `src/services/distributionTargetService.js` — **이식 원본**(SAFE_FIELDS 7키 · FILTER_KEYS · pickFilters · checkName/checkKind/checkActive/checkSpoolDir · normalizeId · applyPatch · query/create/update/deactivate). 읽기 전용 참조
- `src/services/spoolDir.js` — **이식 원본**(`sanitizeSpoolDir`: 정규식 `^[a-z0-9][a-z0-9_-]{0,63}$` + Windows 예약 장치명 거부 + 타입 게이트, 유효하면 원문 그대로/아니면 '')
- `src/services/authorization.js` 9행·61~68행 — `manageDistributionTarget: ['Z']`
- `server-spring/src/main/java/harness/news/service/Authorization.java` — capability 맵(이 step에서 capability 1개 추가)
- `server-spring/src/main/java/harness/news/service/ReceiverConfigService.java` — step2가 세운 같은 도메인 형태의 서비스(게이트·투영 패턴 재사용)
- `server-spring/src/main/java/harness/news/service/Iso8601.java` · `Clock` 빈(`config/AppConfig.java`) — 주입 시계로 createdAt/updatedAt stamp
- `server-spring/src/main/java/harness/news/model/DistributionTargetRepository.java` — step4가 만든 리포지토리

## 배경 (동결된 계약 사실)

- **4 op 전부 Z 전용**: 미인증 401 · 비-Z 403(R도 D도 안 된다).
- **SAFE_FIELDS 7키(정렬)**: `active,createdAt,id,kind,name,spoolDir,updatedAt`. 투영은 allowlist. 목록 원소는 항상 정확 7키(NULL 키 보존).
- **create 검증 순서 = name → kind → spoolDir → active**(decisions (6)):
  - name: 비문자열·공백·>100자 → `invalid-name`(강제변환 금지 — `String(undefined)`가 통과하는 결함 차단).
  - kind: `press`|`nonpress` 아니면 `invalid-kind`(비문자열 자연 거부).
  - spoolDir: 슬러그 실패 → `invalid-spool-dir` · **사용 중이면** `duplicate-spool-dir`(유일성은 **비활성 행까지 포함**해 따진다).
  - active: 미지정이면 'Y', 그 외 Y/N 아니면 `invalid-active`.
  - 검증 5토큰은 전부 fail fallback **400**(ReasonStatus 전역 표에 없음 — 추가 금지, decisions (7)).
- **update는 present-only**: 전달 필드만 검증·반영, 하나라도 위반이면 아무것도 저장 안 함. **존재 확인(not-found)을 검증보다 먼저**(없는 id·NaN id → 404 not-found, decisions (10)(11)).
- **update와 deactivate는 같은 `applyPatch`로 수렴**하고 `updatedAt`을 stamp한다(감사 기록이 진입점에 따라 갈리지 않게 — decisions (5)).
- id는 `normalizeId(id)=Number(id)`로 정규화(엄격 비교 — 문자열 '1'은 자기 자신을 못 거른다). 비수치 id는 NaN → 어떤 행에도 매치 안 됨 → not-found.
- createdAt/updatedAt은 주입 시계로 ISO-8601 UTC 밀리초 3자리(decisions (12)).

## 작업

### A. `Authorization`에 capability 추가

- `MANAGE_DISTRIBUTION_TARGET = "manageDistributionTarget"` 상수 + capability 맵 `→ List.of("Z")`. `authorize(token, MANAGE_DISTRIBUTION_TARGET)` → 미인증 unauthenticated · 비-Z forbidden.

### B. 순수 헬퍼 — `SpoolDir`

- `sanitizeSpoolDir(String value)`: 타입 게이트(비문자열 → '') → 슬러그 정규식(`^[a-z0-9][a-z0-9_-]{0,63}$`) → Windows 예약 장치명 거부(`con`,`prn`,`aux`,`nul`,`com1..9`,`lpt1..9` — 소문자만 통과하므로 소문자 비교) → 통과면 **원문 그대로**(정규화·소문자 변환·trim 금지). 부수효과 0(디렉토리 생성·존재 확인 금지 — ADR-008).

### C. `service` 계층 — `DistributionTargetService`

- 생성자 주입(`DistributionTargetRepository`, `Authorization`, `Clock`/`now`). 시그니처(구현 재량, Node 결과 객체 동형):
  - `Result query(token, filters)` — 게이트 → `pickFilters`(허용 키의 문자열/숫자만) → repo.query → 행마다 sanitize(7키).
  - `Result create(token, entry)` — 게이트 → checkName → checkKind → checkSpoolDir → checkActive → repo.insert(stamp createdAt=updatedAt=now()) → id. **id·createdAt·updatedAt은 서버가 정한다**(entry의 동명 필드 무시).
  - `Result update(token, id, fields)` — 게이트 → normalizeId → **findById로 존재 확인(없으면 not-found)** → present-only 검증(전달 필드만) → applyPatch.
  - `Result deactivate(token, id)` — 게이트 → applyPatch(normalizeId(id), {active:'N'}).
  - `applyPatch(id, patch)` — findById 없으면 not-found, 있으면 repo.update(id, patch + updatedAt=now()) → changes.
- `checkSpoolDir(value, selfId)` — `SpoolDir.sanitizeSpoolDir` 결과가 ''면 invalid-spool-dir, 아니면 repo.query({spoolDir})에서 **selfId 아닌 행이 있으면** duplicate-spool-dir(자기 자신은 제외 — 엄격 비교, selfId는 정규화된 id).
- 투영 sanitize는 SAFE_FIELDS allowlist 순서 `LinkedHashMap`(NULL 키 보존).

### D. 테스트 (먼저 쓴다 — 서비스/헬퍼 단위)

1. `SpoolDirTest`: 유효 슬러그 통과 · 대문자·`..`·`/`·공백·빈 문자열·비문자열·예약 장치명(`con`) 거부.
2. create 검증 순서: name·kind·spoolDir·active를 **동시에** 틀리게 보내고 첫 실패 토큰이 name→kind→spoolDir→active 순서로 나오는지(순서 변이로 실증).
3. duplicate-spool-dir: 같은 spoolDir로 두 번 create → 두 번째 400 duplicate. **비활성 대상의 spoolDir도 duplicate로 걸리는지**(유일성이 비활성 포함).
4. update present-only: 한 필드만 보내면 그것만 바뀌고 나머지 불변 · 전달 필드 하나 위반이면 아무것도 저장 안 됨 · 없는 id/NaN id → not-found(검증보다 존재 확인 먼저).
5. update와 deactivate 둘 다 updatedAt을 stamp(같은 applyPatch 수렴 실증) · deactivate 후 행 존재(active='N', 삭제 아님).
6. 비-Z 403 · 미인증 401(4 op 동형) · 거부 시 리포지토리 호출 0.
7. 투영 7키 · 시크릿/미허용 키 부재 · NULL 키 보존.

## Acceptance Criteria

프레시 체크아웃이면 먼저: `cd /home/user/harness && npm ci`

```bash
cd /home/user/harness/server-spring && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 ./mvnw -B verify
cd /home/user/harness && JAVA_HOME=/usr/lib/jvm/java-21-openjdk-amd64 node scripts/spring-contract.mjs --parity
cd /home/user/harness && git status --porcelain
```

- 1번: exit 0 · failures/errors 0 · 테스트 수 증가. 실측치를 요약에 적는다.
- 2번: exit 0 · 4 프로파일 diffs 0 · 관측 수 불변(HTTP 없음).
- 3번 증분 = `.../service/DistributionTargetService.java` · `.../service/SpoolDir.java` · `.../service/Authorization.java`(capability 1개) · `server-spring/src/test/java/harness/news/service/*` · `phases/70-spring-admin-crud/index.json`.

## 검증 절차

1. **red 먼저**: 서비스/헬퍼 단위 테스트를 구현 전에 돌려 실패 실측.
2. **검증 순서 변이 실증(원복)**: 검증을 kind→name 순으로 바꾸면 2번 테스트가 red인가 — 확인 후 원복.
3. **유일성 범위 변이 실증(원복)**: duplicate 검사를 active='Y'만 보도록 좁히면 3번(비활성 포함) 테스트가 red인가 — 확인 후 원복.
4. **존재-먼저 변이 실증(원복)**: update에서 검증을 존재 확인보다 앞에 두면 4번(없는 id + 잘못된 필드)에서 not-found 대신 검증 토큰이 나와 red인가 — 확인 후 원복.
5. AC 실행. `--parity` 관측 수 불변.
6. index.json step5 갱신.

## 금지사항

- spoolDir을 강제변환·trim·소문자화해서 통과시키지 마라. 이유: 입력을 고쳐 통과시키면 경로 조작 방어가 무너진다(원문 그대로 또는 '').
- 스풀 디렉토리를 만들거나 파일을 쓰지 마라. 이유: 스풀 쓰기는 배부 실행 phase 소유다(ADR-008 — 이 phase는 검증·저장만).
- 검증을 존재 확인보다 먼저 하지 마라. 이유: 없는 id가 검증 reason으로 둔갑한다(계약: 없는 id는 not-found).
- 검증 5토큰을 `ReasonStatus`에 넣지 마라. 이유: fail fallback 400이 계약이다 — 전역 표에 없어야 400이 나간다.
- role을 본문·헤더·쿼리에서 읽지 마라. 이유: acting role은 검증된 세션에서만(ADR-004).
- 컨트롤러를 만들거나 scope 표를 늘리지 마라. 이유: 이 step은 service 계층 전용.
