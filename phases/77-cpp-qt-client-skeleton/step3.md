# Step 3: sse-client

## 읽어야 할 파일

- `/docs/api-contract/sse.md` (SSE 프레임 계약 — 바이트 수준 정본. 헤더 3종 · 프레임 문법 `\n\n` 종결 · 이벤트 어휘 4종 · unauthorized 종료 규약 · 무효화 신호 발생 라우트 표)
- `/docs/ADR.md` (ADR-005 SSE 무효화 신호 · ADR-007 로그 스트림 예외 + 비연장 peek)
- `/docs/news-md-overrides.md` (**L80 필독** — 단일 무효화 신호 + 전체 재조회 · unauthorized 수신 시 재연결 영구 중단 · L127 SSE는 세션 비연장)
- `web/src/model/httpModel.js` (있으면 — SSE 구독 배선 정본. 특히 unauthorized → close, error → 재연결 보존. 읽기 전용)
- `phases/77-cpp-qt-client-skeleton/step1.md`(계약 타입) · `step2.md`(HttpModel/쿠키 세션)

## 작업

`client-cpp/net/`에 **SSE 클라이언트(`SseClient`)**를 추가한다 — `GET /api/stream` 무효화 신호를 구독하고, 이후 목록 화면이 자기 필터로 전체 재조회하게 만드는 소스다.

1. **fetch 스트림 방식으로 프레임 파싱**(sse.md 판정 규율): `EventSource`가 아니라 `QNetworkReply` 스트리밍 응답을 읽어 **`\n\n` 경계로 프레임을 자른다**(쿠키 인증 겸용 — EventSource는 커스텀 헤더/쿠키 제약). 프레임 = `event: <이름>` + `data: <JSON 1줄>` + 빈 줄.
2. **이벤트 어휘 4종 처리**: `ready`(접속 직후 1회, 무시 가능) · `change`(payload `{kind:...}` — **kind는 무시**) · `log`(logs/stream 전용, 이 step은 `/api/stream`만) · `unauthorized`(종료 신호).
3. **단일 무효화 → 전체 재조회 신호**(L80 · ADR-005): `change`를 받으면 kind와 무관하게 "목록 무효화됨" 시그널 하나만 방출한다(부분 갱신·kind별 핸들러 금지). 실제 재조회는 구독자(list 컨트롤러, step 7)가 자기 권한/필터로 수행한다.
4. **unauthorized = 영구 종료**(L80): `unauthorized` 프레임을 받으면 스트림을 **명시적으로 close 하고 자동 재연결을 하지 않는다**(재연결 폭주 방지 + 세션 무효화 반영). 반면 **일시적 네트워크 오류**(연결 끊김)는 재연결을 보존한다 — 이 둘을 구분하라.
5. **세션 비연장 인식**(L127): SSE가 열려 있는 것을 "활동"으로 보고 클라이언트 유휴 타이머를 갱신하지 마라 — 서버는 SSE push로 세션을 연장하지 않는다(peek). 세션 만료 추적은 실제 사용자 REST 요청 기준이어야 한다.
6. **테스트**(TDD): 합성 프레임 바이트 스트림을 `SseClient`에 흘려 넣어 — `\n\n` 경계 분할 · change → 무효화 시그널 1회 · unauthorized → close + 재연결 안 함 · 네트워크 error → 재연결 보존 · 부분 프레임(청크 경계 중간) 재조립 을 단언한다. 실제 서버 불필요(로컬 `QTcpServer` 목 또는 주입형 바이트 소스).

**핵심 규칙:**
- **kind별 부분 갱신 핸들러를 만들지 마라**(L80). 단일 무효화 → 전체 재조회가 계약이다.
- **unauthorized 후 재연결하지 마라.** 이유: 무효화된 세션으로 무한 재연결이 발생한다.
- **끝 빈 줄(`\n\n`) 없는 프레임을 디스패치하지 마라**(sse.md CRITICAL): 종결자 누락은 무한 재연결 함정이다.

## Acceptance Criteria

```bash
cmake -S client-cpp -B client-cpp/build -DCMAKE_BUILD_TYPE=Debug
cmake --build client-cpp/build -j
ctest --test-dir client-cpp/build --output-on-failure
```

## 검증 절차

1. AC 실행.
2. 아키텍처 체크리스트: `\n\n` 프레임 파서가 청크 경계에 강인한가? change→무효화 시그널이 kind를 무시하는가? unauthorized→close+무재연결? 일시 error→재연결 보존?
3. news-md-overrides L80/L127 · sse.md 프레임 문법 반영 확인.
4. 결과 반영: 성공 → completed + summary. 실패 3회 → error.

## 금지사항

- kind별 부분 갱신을 구현하지 마라. 이유: 계약은 단일 무효화 신호 + 전체 재조회다.
- unauthorized 이후 자동 재연결을 하지 마라. 이유: 무효 세션으로의 재연결 폭주.
- SSE 열림을 세션 활동으로 취급해 유휴 타이머를 연장하지 마라. 이유: 서버는 SSE push로 세션을 연장하지 않는다(peek).
- 계약 명세(`docs/api-contract/sse.md`)를 고치지 마라.
- 기존 테스트를 깨뜨리지 마라.
