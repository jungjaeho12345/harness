# tick-distribution-spring.ps1 — Spring 서버 대상 배부 tick 호출 (phase 76 step7 · docs/cutover-p3.md §6 · README-배포.md §6-1)
#
# 형태는 README-배포.md §6 의 Node 예시와 같다: POST /api/login → 응답 본문 sessionId → POST /api/distribution/tick (x-session-id 헤더).
# Spring 은 쿠키 우선·x-session-id 헤더 폴백(SessionTokens)이고 Origin·Referer 가 둘 다 없는 서버-서버 요청은 CSRF 게이트를
# 통과한다(ADR-009 관용). Invoke-WebRequest 는 그 두 헤더를 붙이지 않는다 — 여기에 Origin 을 흉내내 넣지 마라.
#
# 자격: 스크립트·인자에 평문으로 두지 않는다. **작업 실행 계정의 환경변수** NEWS_TICK_USER / NEWS_TICK_PASSWORD 에서만 읽는다.
#   선택 근거 — (a) 사용자 환경변수는 그 계정으로만 읽히고 argv·스케줄러 이력·프로세스 목록에 남지 않는다.
#   (b) Windows 자격 증명 관리자는 Windows PowerShell 5.1 에 표준 cmdlet 이 없어 모듈 의존이 생긴다.
#   (c) 리포 밖 파일은 ACL 을 하나 더 관리해야 하고 백업본에 딸려 나간다. 세 후보 중 관리 표면이 가장 작은 (a) 를 택했다.
#   대상 주소는 NEWS_TICK_BASE(없으면 http://127.0.0.1:3001) 또는 -BaseUrl.
#
# 종료코드: 0 성공 · 2 설정 오류(환경변수 없음) · 3 로그인 실패(401/423/429 등) · 4 tick 비-200(403/503 등) ·
#           5 네트워크/응답 파싱 실패 · 6 이중 실행(락 점유 중 — 실패가 아니라 스킵이지만 비0 으로 보인다).
#           작업 스케줄러의 "마지막 실행 결과" 가 이 값이다 — 0 이 아니면 경보를 건다.
# 로그: 한 줄 — 시각(UTC) · 결과 · distributed/scanned/failed/invalid 건수 · 실패 단계와 사유 토큰.
#       **세션 토큰·자격·스풀 경로는 절대 쓰지 않는다**(tick 응답에 경로가 없는 것이 계약이고, 로그가 그 계약을 밖에서 깨면 안 된다).
#       -LogFile 을 주면 같은 줄을 그 파일에 append 한다(stdout 은 스케줄러가 버린다).
# 이중 실행 방지: 락 파일을 FileShare None 으로 독점 열어 둔다 — 프로세스가 죽으면 OS 가 푼다(잔류 없음 · PID 파일 아님 · ADR-012 와 같은 원리).
#   스케줄러 쪽에서도 "이미 실행 중이면 새 인스턴스를 시작하지 않음" 을 켜라(두 겹).
# 세션 재사용 없음: 호출마다 로그인한다. 로그인 한도는 같은 IP 기준 15분/10회 고정 창 → 주기는 **90초 이상**(권장 5분).
#   세션(1시간 슬라이딩)을 파일에 저장해 재사용하면 한도 문제는 사라지지만 그 파일이 Z 토큰 유출 표면이 된다 — 택하지 않았다.
# 상주 루프·타이머 없음: 1회 실행 = 로그인 1회 + tick 1회. 주기는 스케줄러가 정한다(ADR-008 (3)).

param(
  [string]$BaseUrl = $(if ($env:NEWS_TICK_BASE) { $env:NEWS_TICK_BASE } else { 'http://127.0.0.1:3001' }),
  [string]$LockFile = $(Join-Path $env:TEMP 'tick-distribution-spring.lock'),
  [string]$LogFile = '',
  [int]$TimeoutSec = 30
)

$ErrorActionPreference = 'Stop'
$script:lock = $null

# 로그 쓰기는 실패해도 종료코드·락 해제를 삼키지 않는다: $ErrorActionPreference='Stop' 아래에서 Add-Content 가 던지면
# (백신·인덱서가 로그 파일을 잠깐 쥔 회차) Finish 의 Dispose·exit 에 도달하지 못해, 문서화된 종료코드 대신 PowerShell
# 예외 코드가 스케줄러에 남는다. 로그 실패는 삼키되 stderr 한 줄로 알린다(내용은 단계 라벨뿐 — 값 0).
function Write-Line([string]$text) {
  $line = "$([DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ')) $text"
  try {
    Write-Output $line
    if ($LogFile) { Add-Content -Path $LogFile -Value $line -Encoding UTF8 }
  } catch {
    [Console]::Error.WriteLine('tick WARN stage=log reason=log-write-failed')
  }
}

function Finish([int]$code, [string]$text) {
  Write-Line $text
  if ($script:lock) { try { $script:lock.Dispose() } catch { } }
  exit $code
}

# 비-2xx 는 WebException 으로 오므로 status 와 본문을 꺼내 돌려준다. 본문은 UTF-8 바이트로 보낸다(5.1 의 기본 인코딩 함정).
function Invoke-Json([string]$Method, [string]$Url, $Body, $Headers) {
  $call = @{ Method = $Method; Uri = $Url; UseBasicParsing = $true; TimeoutSec = $TimeoutSec; Headers = $Headers }
  if ($null -ne $Body) {
    $call.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Compress))
    $call.ContentType = 'application/json; charset=utf-8'
  }
  try {
    $res = Invoke-WebRequest @call
    $json = $null
    try { $json = $res.Content | ConvertFrom-Json } catch { $json = $null }
    return @{ status = [int]$res.StatusCode; json = $json }
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if ($null -eq $resp) { return @{ status = 0; json = $null } }
    $reader = New-Object IO.StreamReader($resp.GetResponseStream())
    $text = $reader.ReadToEnd()
    $json = $null
    try { $json = $text | ConvertFrom-Json } catch { $json = $null }
    return @{ status = [int]$resp.StatusCode; json = $json }
  }
}

function Reason($json) {
  if ($null -ne $json -and $null -ne $json.reason) { return [string]$json.reason }
  return 'no-json'
}

# 1. 락 — 겹치면 6 으로 끝난다. 열기는 1초 안에 5회만 재시도한다(백신·인덱서가 파일을 잠깐 쥔 순간에 거짓 6 을 내지 않기 위해 —
#    상주 루프가 아니다. 진짜 다른 실행이 쥐고 있으면 1초 뒤 6).
for ($try = 0; $try -lt 5 -and $null -eq $script:lock; $try++) {
  try {
    $script:lock = [System.IO.File]::Open($LockFile, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  } catch {
    Start-Sleep -Milliseconds 200
  }
}
if ($null -eq $script:lock) {
  Finish 6 'tick skipped stage=lock reason=already-running'
}

# 2. 자격 — 환경변수에서만.
$user = $env:NEWS_TICK_USER
$secret = $env:NEWS_TICK_PASSWORD
if (-not $user -or -not $secret) {
  Finish 2 'tick FAIL stage=config reason=missing-env NEWS_TICK_USER,NEWS_TICK_PASSWORD'
}

# 3. 로그인 → sessionId(본문 필드 — Node·Spring 동일).
$login = Invoke-Json 'POST' "$BaseUrl/api/login" @{ userId = $user; password = $secret } @{}
if ($login.status -eq 0) { Finish 5 'tick FAIL stage=network reason=unreachable' }
$loginStatus = $login.status
$loginReason = Reason $login.json
if ($login.status -ne 200 -or $null -eq $login.json -or -not $login.json.sessionId) {
  Finish 3 "tick FAIL stage=login status=$loginStatus reason=$loginReason"
}

# 4. tick — 본문 없음 · 헤더 x-session-id 만.
$tick = Invoke-Json 'POST' "$BaseUrl/api/distribution/tick" $null @{ 'x-session-id' = $login.json.sessionId }
if ($tick.status -eq 0) { Finish 5 'tick FAIL stage=network reason=unreachable' }
$tickStatus = $tick.status
$tickReason = Reason $tick.json
if ($tick.status -ne 200 -or $null -eq $tick.json -or $tick.json.ok -ne $true) {
  Finish 4 "tick FAIL stage=tick status=$tickStatus reason=$tickReason"
}

$distributed = @($tick.json.distributed).Count
$failed = @($tick.json.failed).Count
$invalid = @($tick.json.invalid).Count
$scanned = [int]$tick.json.scanned
$skipped = if ($null -ne $tick.json.skipped) { " skipped=$($tick.json.skipped)" } else { '' }
Finish 0 "tick ok distributed=$distributed scanned=$scanned failed=$failed invalid=$invalid$skipped"
