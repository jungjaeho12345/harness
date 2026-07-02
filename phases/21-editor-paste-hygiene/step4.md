# Step 4: phase-index-newline-hygiene — phases/**/index.json 개행 위생 정규화 (데이터 정리)

## 배경 / 요구사항

`phases/**/index.json` 파일 14개(`phases/index.json`(top-level)과 `phases/20-editor-image-upload-embed/index.json` 포함)가 **파일 끝 개행(trailing newline)이 없다**. 이는 POSIX 텍스트 파일 관례 위반이며, git diff 노이즈(`\ No newline at end of file`)와 도구 처리 불일치를 유발한다.

이 step은 해당 index.json 파일들을 **정확히 하나의 `\n`으로 끝나도록** 정규화한다. **순수 데이터 정리**이며 JSON 내용(키·값·구조)은 바꾸지 않는다. 커밋 타입: **chore:**.

이 step은 **`phases/**/index.json` 데이터 파일만** 다룬다. 프로덕션 코드(`web/`, `server/`)·DB·스키마는 일절 건드리지 않는다.

## 읽어야 할 파일

- `/CLAUDE.md`(DB 비파괴·UTF-8).
- 대상 파일 목록 확인(선행): 아래 커맨드로 개행 누락 파일을 나열한다.
  ```bash
  for f in $(find phases -name index.json | sort); do \
    [ -n "$(tail -c1 "$f")" ] && echo "MISSING: $f"; done
  ```
  기대: 14개 파일(`phases/index.json`·`phases/0-mvp/index.json`·`5·6·7·8·9·10·11·12·13·14·15·20`의 index.json)이 나온다. 계획 작성 시점 기준이며, 이 step 실행 시점에는 앞선 step들이 이미 완료돼 있으므로 **step 실행 시 실제 목록을 다시 확인**해 그 파일들을 대상으로 삼는다.

## 작업

이것은 데이터 정리다. TDD 관점의 "테스트"는 **정규화 후 개행 누락 파일이 0건임을 셸 체크로 검증**하는 것이다(아래 AC).

1. 위 선행 커맨드로 개행이 없는 `phases/**/index.json`을 나열한다.
2. 각 파일의 끝에 **정확히 하나의 `\n`**을 추가한다. 이미 개행으로 끝나는 파일은 건드리지 않는다(이중 개행 추가 금지). JSON 내용(공백/들여쓰기/키·값 순서)은 변경하지 마라 — **끝 개행만** 추가한다.
3. 이 phase의 `phases/21-editor-paste-hygiene/index.json`도 끝 개행으로 끝나는지 확인한다(생성 시 이미 개행으로 끝나야 하지만, 앞선 step들이 status를 갱신하며 재저장했을 수 있으므로 재확인).
4. `phases/index.json`(top-level, phase 21 등록 포함)도 대상에 포함된다.

권장: 파일 내용을 읽어 끝이 `\n`이 아니면 `\n` 하나를 append하는 방식(예: 각 파일에 대해 `printf '%s' "$(cat "$f")"; printf '\n'` 형태로 재기록하거나, 스크립트로 처리). 단, **JSON 파싱→재직렬화로 포맷을 바꾸지 마라**(들여쓰기/키 순서가 바뀌어 불필요한 diff가 생긴다). 순수하게 끝 개행만 보정한다.

## 핵심 규칙 (반드시 준수 — 위반 시 반려)

1. **끝 개행만 변경**: JSON의 키·값·구조·들여쓰기·공백을 바꾸지 마라. 오직 파일 끝에 없는 `\n` 하나를 추가한다. 이유: 내용 변경은 리뷰·실행 상태를 오염시킨다.
2. **이중 개행 금지**: 이미 `\n`으로 끝나는 파일은 그대로 둔다(빈 줄 추가 금지). 이유: 목표는 "정확히 하나의 `\n`".
3. **DB/코드 미변경**: `web/`·`server/`·DB·스키마를 건드리지 마라. 이유: 이 step은 phase-doc 데이터 위생 전용.
4. **JSON 유효성 유지**: 변경 후에도 모든 대상 파일이 유효한 JSON이어야 한다.

## Acceptance Criteria

```bash
# (1) 개행 누락 index.json 0건 (권위 있는 게이트)
missing=$(for f in $(find phases -name index.json); do [ -n "$(tail -c1 "$f")" ] && echo "$f"; done); \
  if [ -z "$missing" ]; then echo "OK: all index.json end with newline"; \
  else echo "MISSING:"; echo "$missing"; false; fi

# (2) 모든 대상 파일이 여전히 유효 JSON
for f in $(find phases -name index.json); do node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "INVALID: $f"; done

# (3) 프로덕션 회귀 없음(데이터 정리가 코드에 영향 없음 확인)
npm run test:web
npm test
npm run build
npm run lint
```

- (1)은 개행 누락 파일이 하나도 없으면 `OK` 출력.
- (2)는 `INVALID:` 출력이 없어야 한다.
- (3)은 데이터 정리이므로 통과해야 한다(코드 무변경).

## 검증 절차

1. 위 AC 커맨드를 실행한다.
2. 아키텍처 체크리스트:
   - `phases/**/index.json`만 변경(끝 개행), 코드/DB/스키마 미변경.
   - `git diff`가 각 대상 파일에서 오직 "끝 개행 추가"만 보여준다(내용 변경 없음).
   - CLAUDE.md 규칙(DB 비파괴·UTF-8) 준수.
3. 결과에 따라 `phases/21-editor-paste-hygiene/index.json`의 step 4를 갱신한다(completed+summary / error / blocked). **주의:** step 4 status를 갱신해 저장한 뒤에도 이 파일이 끝 개행으로 끝나는지 마지막으로 확인한다.

## 금지사항

- JSON 내용(키·값·들여쓰기·키 순서)을 바꾸지 마라. 이유: 순수 개행 위생이 목적 — 내용 변경은 실행/리뷰 상태를 오염시킨다.
- JSON 파싱 후 재직렬화(re-serialize)로 파일을 다시 쓰지 마라. 이유: 포맷(들여쓰기/순서)이 바뀌어 대규모 무의미 diff가 생긴다 — 끝 개행만 보정한다.
- 이미 개행으로 끝나는 파일에 빈 줄을 더 추가하지 마라. 이유: 목표는 정확히 하나의 `\n`.
- `web/`·`server/`·DB·스키마를 건드리지 마라. 이유: 이 step 범위는 phase-doc 데이터 위생 한 건.
