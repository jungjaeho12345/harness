---
name: claude-code-test-harness
description: claude code 하네스에서 코드 변경사항을 안전하게 테스트하고, 실패를 재현·분석·보고할 때 사용한다. 사용자가 테스트 실행, 테스트 실패 원인 분석, 회귀 테스트 작성, lint/typecheck/build 검증, ci 실패 재현, 변경 범위 기반 테스트 선택, 테스트 커버리지 확인을 요청할 때 이 스킬을 사용한다. 코드 리뷰나 설계 평가는 별도 리뷰 스킬을 우선 사용하고, 이 스킬은 검증 명령 실행과 테스트 결과 해석에 집중한다.
---

# Claude Code 테스트 하네스

## 목표

코드 변경사항을 안전하게 검증하고, 테스트 실패를 재현 가능한 방식으로 분석하며, 사용자가 바로 조치할 수 있는 테스트 보고서를 작성한다.

이 스킬은 다음 작업에 집중한다.

- 변경된 코드와 관련 테스트 범위 파악
- 프로젝트별 테스트, lint, typecheck, build 명령 추론 및 실행
- 실패 로그 요약과 원인 후보 분석
- 최소 재현 조건 정리
- 필요한 경우 회귀 테스트 제안 또는 작성
- 검증한 사실과 추정한 내용을 분리한 최종 보고

## 기본 원칙

1. 파괴적 명령을 실행하지 않는다.
   - 금지 예: `rm -rf`, `git reset --hard`, `git clean -fd`, DB 삭제·마이그레이션 강제 실행, 프로덕션 배포 명령
   - 사용자가 명시적으로 요청해도 위험도가 높으면 먼저 대안을 제시한다.
2. 테스트 전 현재 작업 상태를 확인한다.
   - `git status --short`
   - `git diff --stat`
   - 필요 시 `git diff -- <file>`
3. 사용자의 미완성 변경사항을 보존한다.
   - 자동 포맷, 자동 수정, 의존성 설치, lockfile 변경은 사전에 이유를 설명한다.
4. 테스트 결과는 “실행한 명령”, “결과”, “근거 로그”, “다음 조치”로 보고한다.
5. 실패가 발생해도 성급히 수정하지 말고 먼저 재현성과 범위를 확인한다.

## 작업 흐름

### 1. 프로젝트 구조 파악

먼저 루트 파일을 확인해 기술 스택과 명령어를 추론한다.

확인 대상 예시:

- JavaScript/TypeScript: `package.json`, `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `tsconfig.json`, `vite.config.*`, `jest.config.*`, `vitest.config.*`
- Python: `pyproject.toml`, `requirements.txt`, `tox.ini`, `pytest.ini`, `setup.cfg`, `poetry.lock`
- Go: `go.mod`, `go.sum`
- Rust: `Cargo.toml`, `Cargo.lock`
- Java/Kotlin: `pom.xml`, `build.gradle`, `build.gradle.kts`, `settings.gradle*`
- Ruby: `Gemfile`, `Rakefile`

가능하면 프로젝트에 이미 정의된 명령을 우선 사용한다.

### 2. 변경 범위 확인

다음을 확인한다.

```bash
git status --short
git diff --stat
```

필요하면 변경된 파일별 diff를 살펴본다.

```bash
git diff -- path/to/file
```

변경 범위에 따라 테스트 전략을 선택한다.

- 작은 변경: 관련 단위 테스트 먼저 실행
- 핵심 로직 변경: 관련 단위 테스트 + 통합 테스트
- 타입/인터페이스 변경: typecheck 또는 compile 필수
- 빌드 설정 변경: build 필수
- 의존성 변경: install 상태와 lockfile 변경 확인
- 테스트 코드 변경: 해당 테스트가 실제로 실패를 잡을 수 있는지 확인

### 3. 테스트 명령 선택

프로젝트에 명령이 정의되어 있으면 그 명령을 우선한다.

#### JavaScript/TypeScript

1. 패키지 매니저 감지
   - `pnpm-lock.yaml` → `pnpm`
   - `yarn.lock` → `yarn`
   - `package-lock.json` → `npm`
2. `package.json` scripts 확인
3. 우선순위 예시

```bash
pnpm test
pnpm lint
pnpm typecheck
pnpm build
```

관련 테스트만 실행할 수 있으면 먼저 좁게 실행한다.

```bash
pnpm test path/to/test
pnpm vitest path/to/test
pnpm jest path/to/test
```

#### Python

우선순위 예시:

```bash
pytest
ruff check .
mypy .
python -m pytest path/to/test_file.py
```

`pyproject.toml`, `tox.ini`, `noxfile.py`가 있으면 프로젝트 표준 명령을 우선한다.

#### Go

```bash
go test ./...
go test ./path/to/package

go vet ./...
```

#### Rust

```bash
cargo test
cargo clippy --all-targets --all-features
cargo build
```

#### Java/Kotlin

Gradle:

```bash
./gradlew test
./gradlew build
```

Maven:

```bash
mvn test
mvn verify
```

### 4. 실패 분석

테스트가 실패하면 다음 순서로 분석한다.

1. 첫 번째 실패와 대표 실패를 구분한다.
2. 에러 메시지, stack trace, assertion diff를 확인한다.
3. 실패가 환경 문제인지 코드 문제인지 분리한다.
4. 동일 실패가 반복 재현되는지 확인한다.
5. 변경된 코드와 실패 지점의 연결고리를 설명한다.

실패 원인 분류:

- 코드 로직 오류
- 테스트 기대값 오류
- mock/stub 불일치
- 타입 또는 인터페이스 변경 누락
- 비동기/타이밍 문제
- 환경 변수 또는 외부 서비스 의존 문제
- 의존성/버전 문제
- flaky test 가능성

### 5. 회귀 테스트 작성 기준

버그 수정이 포함된 경우, 가능하면 회귀 테스트를 제안하거나 작성한다.

좋은 회귀 테스트 조건:

- 기존 버그에서 실패하고 수정 후 통과해야 한다.
- 구현 세부사항보다 observable behavior를 검증한다.
- 불필요한 snapshot 남용을 피한다.
- 시간, 랜덤, 네트워크 의존성을 통제한다.
- 테스트 이름에 조건과 기대 결과가 드러난다.

테스트를 추가한 경우 반드시 새 테스트가 실제로 실행되는지 확인한다.

### 6. 자동 수정 여부

테스트 실패 원인이 명확하고 수정 범위가 작으면 수정할 수 있다.

수정 전 확인할 것:

- 실패 원인을 로그와 코드로 설명할 수 있는가
- 수정이 사용자의 의도와 충돌하지 않는가
- 관련 테스트를 다시 실행할 수 있는가

자동 수정 후에는 최소한 다음을 다시 실행한다.

- 실패했던 테스트
- 관련 테스트
- 필요 시 lint/typecheck/build

## 보고 형식

최종 답변은 다음 형식을 따른다.

```markdown
## 테스트 결과

### 실행한 명령
- `<command>`: 성공/실패
- `<command>`: 성공/실패

### 확인한 내용
- 변경 범위:
- 통과한 검증:
- 실패한 검증:

### 실패 원인
- 원인:
- 근거:
- 영향 범위:

### 수정/제안
- 적용한 수정:
- 추가 제안:

### 남은 리스크
- 실행하지 못한 테스트:
- 환경상 확인하지 못한 부분:
```

성공한 경우에도 실행한 명령과 확인 범위를 반드시 적는다.

## 부분 검증 보고 규칙

모든 테스트를 실행하지 못했다면 명확히 말한다.

예시:

- “전체 테스트는 실행하지 못했고, 변경 파일과 직접 관련된 단위 테스트만 실행했다.”
- “typecheck는 통과했지만 build는 프로젝트 의존성 문제로 실행하지 못했다.”
- “실패 로그상 환경 변수 누락 가능성이 높지만, 실제 서비스 연결은 확인하지 않았다.”

## 금지 사항

- 테스트를 실행하지 않았는데 “검증 완료”라고 말하지 않는다.
- 로그를 보지 않고 실패 원인을 단정하지 않는다.
- 사용자의 변경사항을 임의로 되돌리지 않는다.
- 테스트 통과를 위해 테스트 기대값만 무리하게 낮추지 않는다.
- flaky test를 근거 없이 코드 문제로 단정하지 않는다.
