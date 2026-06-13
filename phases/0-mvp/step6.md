# Step 6: media-search-service

## 읽어야 할 파일

- `/news.md` — **기사 작성페이지 미디어 탭**(이미지=Google 이미지, 영상=YouTube, 서버 프록시, API 키는 서버 환경변수, 외부 실패 시 빈 결과) 섹션
- `/docs/ADR.md` — ADR-005 주변(서버 프록시 원칙), ADR 보안
- `/docs/ARCHITECTURE.md` — `src/services/` 위치

## 작업

미디어 검색 서버 프록시 서비스를 구현한다. **실제 외부 API 호출은 주입된 fetch로 추상화**(테스트에서 가짜 사용). TDD.

1. `src/services/mediaSearch.js` — `export function createMediaSearch({ fetchFn, env })`:
   - `search(query, type)` — `type==='image'` → Google 이미지 검색, 그 외(`'video'` 포함/누락) → YouTube 검색. API 키는 `env`(서버 환경변수)에서 읽는다.
   - 반환: `{ items: Array, error: boolean }`. 외부 호출이 실패하거나 키가 없으면 **throw 하지 말고** `{ items: [], error: true }` 반환.
   - 정규화: 알 수 없거나 누락된 type은 `'video'`로 처리.
2. 테스트(`test/mediaSearch.test.js`): 주입한 가짜 `fetchFn`으로 image→Google/ video→YouTube 분기, 키 누락·네트워크 실패 시 빈 결과(error:true), 결과 정규화 검증. **실제 네트워크 호출 없음.**

## Acceptance Criteria

```bash
npm run lint
npm run build
npm test
```

## 검증 절차

1. AC 실행.
2. 체크리스트: type 분기가 정확한가? 키 누락/실패가 throw가 아니라 빈 결과인가? fetch가 주입되어 테스트가 네트워크 없이 도는가?
3. step 6 업데이트(completed + summary: search 시그니처와 분기/실패 처리).

## 금지사항

- 외부 호출 실패를 예외로 전파하지 마라. 이유: news.md — 실패 시 오류 대신 빈 결과.
- API 키를 소스에 하드코딩하지 마라. 이유: 키는 서버 환경변수.
- 모듈 안에서 `globalThis.fetch`를 직접 부르지 마라(주입). 이유: 테스트 결정성. 기존 테스트를 깨뜨리지 마라.
