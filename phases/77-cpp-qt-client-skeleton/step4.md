# Step 4: shell-probe-config

## 읽어야 할 파일

- `/docs/ADR.md` (ADR-011 — 접속형 셸: 서버 주소 프로브 `GET /api/health` `{ok:true}` · 리다이렉트 최종 origin 승격 · fail-safe · config.json 화이트리스트 파싱 + tmp→rename 원자적 쓰기 · secure-origin 판정)
- `/docs/porting-plan-cpp-spring.md` (§6.2 "Electron 셸 계약의 처분" 표 — 이식 필수 항목: 프로브 · config 파일)
- `client/lib/secureOrigin.js` (있으면 — origin 판정 순수 모듈. 읽기 전용, C++ 이식 대상 명세)
- `client/lib/windowPolicy.js` · `client/main.js` (있으면 — health 프로브·config 흐름 정본. 읽기 전용)
- `phases/77-cpp-qt-client-skeleton/step0.md`(shell/ 디렉토리) · `step2.md`(HttpModel base URL 주입점)

## 작업

`client-cpp/shell/`에 **서버 주소 프로브 + config.json 관리**를 순수 로직 중심으로 만든다. 이 셸이 결정한 서버 origin을 step 2의 HttpModel에 주입한다.

1. **서버 주소 프로브(`shell/serverprobe`)**: 입력 주소로 `GET /api/health`를 호출해 **본문 `{ok:true}`까지 확인**한 뒤에만 승격한다. 확인 요청이 리다이렉트로 다른 출처에 도달했으면 저장/표시 대상은 입력 주소가 아니라 **리다이렉트를 따라간 최종 origin**이다. 확인 실패거나 최종 URL이 비정상(파싱 불가 · http/https 밖 스킴 · 자격증명 포함 · https 입력의 http 하향)이면 **승격하지 않고 입력 주소 유지**(fail-safe).
2. **origin 판정 순수 함수**: URL 정규화·http/https 검사·자격증명 포함 거부·하향 거부를 **Qt Widgets/Network에 의존하지 않는 순수 함수**로 뽑아 core 또는 shell에 두고 단위 테스트한다(`secureOrigin.js` 이식). 네트워크 왕복(health GET)만 Qt Network에 의존한다.
3. **config.json(`shell/config`)**: 경로는 OS 규약을 따르되 ADR-011의 `%APPDATA%\기사작성기\config.json`과 동형(`QStandardPaths::AppConfigLocation` 등). **화이트리스트 파싱**(세션·자격증명 필드 없음 — 서버 origin 등 허용 키만) + **tmp 파일 쓰기 후 원자적 rename**으로 저장(부분 쓰기 방지). 알 수 없는 키는 무시하고 스키마 밖 값은 채택하지 않는다.
4. **테스트**(TDD): 프로브 판정(정상 승격 · 리다이렉트 최종 origin 채택 · https→http 하향 거부 · 자격증명 포함 거부 · health 본문 불일치 거부)을 로컬 목 HTTP 서버로, config 파싱/쓰기(화이트리스트 필터 · 원자적 rename · 손상 파일 복원)를 tmp 디렉토리로 단언한다.

**핵심 규칙:**
- **config에 세션 토큰·자격증명·비밀번호를 저장하지 마라**(ADR-011 화이트리스트). 이유: 설정 파일은 서버 주소 등 비민감 값만 담는다.
- **health 본문 `{ok:true}` 확인 없이 주소를 승격하지 마라.** 이유: 아무 200 응답이나 서버로 오인하면 잘못된 origin에 붙는다.
- **fail-safe**: 판정 불가·비정상 URL은 승격이 아니라 입력 유지다. 이유: 하향/자격증명 URL 승격은 보안 회귀다.
- 원자적 쓰기(tmp→rename)를 지켜라. 이유: 쓰기 중 크래시가 config를 손상시키면 재기동이 막힌다.

## Acceptance Criteria

```bash
cmake -S client-cpp -B client-cpp/build -DCMAKE_BUILD_TYPE=Debug
cmake --build client-cpp/build -j
ctest --test-dir client-cpp/build --output-on-failure
```

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트: origin 판정이 순수 함수로 분리됐는가(Qt 비의존)? health 본문 확인이 승격 조건인가? config가 화이트리스트+원자적 쓰기인가? 자격증명 필드가 config에 없는가?
3. ADR-011 프로브/config 계약 반영 확인.
4. 결과 반영: 성공 → completed + summary(프로브 규칙 · config 경로/키 · 원자적 쓰기). 실패 3회 → error.

## 금지사항

- config에 세션/자격증명/비밀번호를 저장하지 마라. 이유: ADR-011 화이트리스트(비민감 값만).
- health 본문 확인을 생략하지 마라. 이유: 200만으로 서버를 판정하면 오접속한다.
- 비정상 URL(하향·자격증명 포함)을 승격하지 마라. 이유: 보안 회귀.
- 기존 테스트를 깨뜨리지 마라.
