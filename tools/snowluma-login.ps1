# SnowLuma 自动登录：向本机 WebUI 换取会话令牌，再打开同源自动登录页，省掉每次手输密码。
#
# 背景（逆向出来的机制，别再猜）：
#   - WebUI 登录接口是 POST http://127.0.0.1:5099/api/login  {"password":"..."} → {"token":"..."}
#   - 前端把令牌存进 **localStorage 的 `snowluma_token` 键**，之后请求带 `Authorization: Bearer <token>`
#   - 服务端令牌表是**内存里的 Map** → SnowLuma 一重启，旧令牌全部失效，这就是"每次都要重输"的原因
#   - 外部脚本写不了浏览器的 localStorage，所以借同源页 SnowLuma\client\snowluma-autologin.html 代写
#
# 密码怎么存：用 Windows DPAPI（ConvertFrom-SecureString）加密后落在
#   qq-bridge\state\snowluma-credential.txt
# 只有**当前 Windows 用户**能解密，拷到别的机器/别的账户都解不开，不是明文。
#
# 用法（日常入口就是根目录的 一键启动.cmd，不用记这个长路径）：
#   双击 一键启动.cmd 后 4 秒内按 2   # = 只登录 SnowLuma（登录完由 panels.ps1 把页面开出来）
#   一键启动.cmd login               # 同上，命令行写法
#   .\tools\snowluma-login.ps1 -SavePassword          # 首次：提示输入一次密码并存起来
#   .\tools\snowluma-login.ps1                        # 以后：换到新令牌并打印 autologin URL
#   .\tools\snowluma-login.ps1 -NoOpen                # 同上的旧写法（现在它已经不会开页面了）
#   .\tools\snowluma-login.ps1 -Forget                # 删掉已存的密码
#
# ★ 2026-09-24（P0 收口，docs\qq-agent-产品设计.md §3.3）：**本脚本不再自己开页面**。
#   它只做两件事：拿令牌 / 校验会话，并把 `snowluma-autologin.html?token=…` 打到 stdout。
#   页面统一由 tools\panels.ps1 开（它是唯一的"开页面者"）—— 以前这里还有一句
#   `Start-Process $url`，于是同一个页面有**两个开启者**（这里 + panels.ps1），
#   这正是"SnowLuma 重复标签 / 组合里那个没登录 / 桌面多出白窗"三件事共同的根。
#   要让人看到页面：tools\panels.ps1 open -Pages snowluma -ForcePage snowluma
#   （-ForcePage 是必要的：SnowLuma 的令牌表在内存里，重启后旧标签里的令牌已失效，
#     只有重新加载 autologin 页才能把新令牌写进浏览器 localStorage。）
param(
  [switch]$SavePassword,
  [string]$Password,
  [switch]$NoOpen,
  [switch]$Quiet,
  [switch]$Forget
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$CredFile = Join-Path $Root 'qq-bridge\state\snowluma-credential.txt'
# 管理页端口从唯一来源派生（agent.config.json → tools\env-config.ps1 问 Node 要）；这里不写数字。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$WebPort = (Get-AgentPorts).snowlumaWeb
$Base = "http://127.0.0.1:$WebPort"

function Say($msg, $color = 'Gray') { if (-not $Quiet) { Write-Host $msg -ForegroundColor $color } }

if ($Forget) {
  if (Test-Path $CredFile) { Remove-Item $CredFile -Force; Say "已删除保存的 SnowLuma 密码：$CredFile" 'Yellow' }
  else { Say '本来就没有保存过密码。' }
  exit 0
}

# ── 存密码 ────────────────────────────────────────────────────────────────
if ($SavePassword -or $Password) {
  $secure = if ($Password) {
    ConvertTo-SecureString -String $Password -AsPlainText -Force
  } else {
    Read-Host -AsSecureString -Prompt '请输入 SnowLuma 管理页密码（只会以 DPAPI 加密形式存本机）'
  }
  $blob = ConvertFrom-SecureString -SecureString $secure
  $dir = Split-Path -Parent $CredFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  Set-Content -LiteralPath $CredFile -Value $blob -Encoding ASCII
  Say "已保存密码（DPAPI 加密，仅当前 Windows 用户可解密）：$CredFile" 'Green'
  if (-not $Password) { exit 0 }
}

# ── 取密码 ────────────────────────────────────────────────────────────────
if (-not (Test-Path $CredFile)) {
  Say '还没保存过 SnowLuma 密码。先执行一次：' 'Yellow'
  Say '  .\tools\snowluma-login.ps1 -SavePassword' 'Yellow'
  exit 2
}
$secure = ConvertTo-SecureString (Get-Content -LiteralPath $CredFile -Raw).Trim()
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }

# ── 登录 ──────────────────────────────────────────────────────────────────
$body = @{ password = $plain } | ConvertTo-Json -Compress
$resp = $null
try {
  $resp = Invoke-RestMethod -Uri "$Base/api/login" -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 15
} catch {
  $status = $null
  try { $status = [int]$_.Exception.Response.StatusCode } catch {}
  if ($status -eq 401) {
    Say '密码被拒绝（401）。可能你在 SnowLuma 里改过密码，请重新执行：' 'Red'
    Say '  .\tools\snowluma-login.ps1 -SavePassword' 'Red'
    exit 3
  }
  Say "连不上 SnowLuma（$Base）：$($_.Exception.Message)" 'Red'
  Say '  SnowLuma 没在运行？先跑 一键启动.cmd，或单独启动 SnowLuma 窗口。' 'Yellow'
  exit 4
} finally {
  $plain = $null
  $body = $null
}

$token = [string]$resp.token
if (-not $token) {
  if ($resp.needsTotp) { Say 'SnowLuma 开了两步验证（TOTP），自动登录帮不上忙，请手动登录。' 'Yellow' }
  else { Say "登录接口没有返回令牌：$($resp | ConvertTo-Json -Compress)" 'Red' }
  exit 5
}

# ── 打印带令牌的 URL（**本脚本不再自己开页面**，见文件头）────────────────────
# 这一行是令牌链的一部分，别删：panels.ps1 的 Get-SnowLumaUrl 就是抓 stdout 里第一个 http(s) URL。
$url = "$Base/snowluma-autologin.html?token=$([uri]::EscapeDataString($token))"
Write-Host $url
Say '已用保存的密码换到新令牌（**没有**打开浏览器）。' 'Green'
if ($PSBoundParameters.ContainsKey('NoOpen')) { Say '（-NoOpen 是兼容开关：本脚本从 2026-09-24 起就不开页面了，有没有它都一样）' 'DarkGray' }
Say '开页面走工具里那一个入口：tools\panels.ps1 open -Pages snowluma -ForcePage snowluma' 'DarkGray'
Say '（这行 URL 里的令牌约等于登录态，别外传。）' 'Yellow'
if ($resp.mustChangePassword) { Say '注意：SnowLuma 仍标记着"必须改密码"。' 'Yellow' }
# 显式 exit 0：调用方（start-all.ps1）用 $LASTEXITCODE 判断成功与否，
# 不写 exit 的话会读到上游残留的退出码，可能误判成失败。
exit 0
