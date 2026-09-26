# SnowLuma 窗口日志级别开关（查 / 改，运行时生效，不用重启 SnowLuma）。
#
# 为什么需要它：SnowLuma 把「群撤回 / 私聊撤回」「[OneBot.WS-Server] read ECONNRESET」
# 这类事件按 WARN 级别写出去，桥接每重启一次、群里每撤回一条，窗口就多一行黄字。
# logger 有两条互相独立的级别（SnowLuma\logger-BAozzyTt.js）：
#   SNOWLUMA_LOG_LEVEL       → 控制台窗口 + WebUI 的日志环形缓冲（默认 info）
#   SNOWLUMA_LOG_FILE_LEVEL  → 落盘日志文件（默认 debug）
# 所以「窗口干净」和「日志完整」可以同时要：窗口 error，文件留 debug。
#   - 持久化：tools\start-all.ps1 启动 SnowLuma 前会设 SNOWLUMA_LOG_LEVEL=error
#   - 运行时改（本脚本）：走 WebUI 的 POST /api/logs/level，改的是内存里的级别，
#     SnowLuma 一重启就回到启动时的级别（也就是 start-all 设的 error）。
#   - WebUI 的「设置 → 日志」里也能选级别，效果等价，且同样只在本次运行有效。
#
# 用法：
#   .\tools\snowluma-log-level.ps1            # 查当前级别
#   .\tools\snowluma-log-level.ps1 error      # 只看错误（推荐，日常）
#   .\tools\snowluma-log-level.ps1 info       # 临时放开，排查连接/事件问题时用
#   .\tools\snowluma-log-level.ps1 debug      # 最啰嗦
#
# 密码来自 qq-bridge\state\snowluma-credential.txt（DPAPI 加密，仅当前 Windows 用户可解）；
# 没存过就先跑一次 .\tools\snowluma-login.ps1 -SavePassword。
param(
  [Parameter(Position = 0)][string]$Level,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$CredFile = Join-Path $Root 'qq-bridge\state\snowluma-credential.txt'
# 管理页端口从唯一来源派生（agent.config.json → tools\env-config.ps1 问 Node 要）；这里不写数字。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$WebPort = (Get-AgentPorts).snowlumaWeb
$Base = "http://127.0.0.1:$WebPort"

function Say($msg, $color = 'Gray') { if (-not $Quiet) { Write-Host $msg -ForegroundColor $color } }

if (-not (Test-Path $CredFile)) {
  Say '还没保存过 SnowLuma 密码，拿不到 WebUI 令牌。先执行一次：' 'Yellow'
  Say '  .\tools\snowluma-login.ps1 -SavePassword' 'Yellow'
  exit 2
}

# ── 解密密码 + 登录换令牌 ─────────────────────────────────────────────────
$secure = ConvertTo-SecureString (Get-Content -LiteralPath $CredFile -Raw).Trim()
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::FreeBSTR($bstr) }

try {
  $body = @{ password = $plain } | ConvertTo-Json -Compress
  $resp = Invoke-RestMethod -Uri "$Base/api/login" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15
} catch {
  $status = $null
  try { $status = [int]$_.Exception.Response.StatusCode } catch {}
  if ($status -eq 401) { Say '密码被拒绝（401）：SnowLuma 里改过密码？重跑 .\tools\snowluma-login.ps1 -SavePassword' 'Red'; exit 3 }
  Say "连不上 SnowLuma（$Base）：$($_.Exception.Message)" 'Red'
  Say '  SnowLuma 没在运行？先跑 一键启动.cmd。' 'Yellow'
  exit 4
} finally {
  $plain = $null
  $body = $null
}

$token = [string]$resp.token
if (-not $token) { Say '登录接口没返回令牌（可能开了两步验证 TOTP，本脚本帮不上忙）。' 'Red'; exit 5 }

$headers = @{ Authorization = "Bearer $token" }

# ── 查 / 改 ───────────────────────────────────────────────────────────────
try {
  if (-not $Level) {
    $cur = Invoke-RestMethod -Uri "$Base/api/logs/level" -Headers $headers -Method Get -TimeoutSec 15
    Say "当前日志级别（窗口+WebUI）：$($cur.level)" 'Green'
    Say "可选：$($cur.levels -join ' / ')"
    exit 0
  }
  $payload = @{ level = $Level.Trim().ToLower() } | ConvertTo-Json -Compress
  $set = Invoke-RestMethod -Uri "$Base/api/logs/level" -Headers $headers -Method Post -ContentType 'application/json' -Body $payload -TimeoutSec 15
  Say "已把窗口日志级别设为：$($set.level)" 'Green'
  if ($set.level -eq 'error') { Say '（WARN 不再进窗口/WebUI；日志文件仍是 debug，排查用 SnowLuma\logs\ 或 tools\self-check.mjs）' }
  exit 0
} catch {
  $status = $null
  try { $status = [int]$_.Exception.Response.StatusCode } catch {}
  Say "设置失败（HTTP $status）：$($_.Exception.Message)" 'Red'
  exit 6
}
