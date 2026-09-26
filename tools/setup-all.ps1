# 一键安装（从零到能跑）—— 给"拿到这个部署包的人"用（2026-09-24，可交付部署包 Goal round 3）。
#
# 依次做五步：环境检查 → 装依赖 → 装 DSH 端（preset / MCP / 控制台插件）→ 配置向导 → 打印下一步。
# 每一步都会检查上一步的结果，出错就停下并说清怎么办（不要让人猜）。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\setup-all.ps1                 # 交互式（推荐）
#   powershell -ExecutionPolicy Bypass -File tools\setup-all.ps1 -DryRun         # 只打印计划，什么都不做
#   powershell -ExecutionPolicy Bypass -File tools\setup-all.ps1 -Yes -Owner 123456 -Groups 111111 -Token xxxx
#   powershell -ExecutionPolicy Bypass -File tools\setup-all.ps1 -SkipInstall    # 依赖已装过
# 退出码：0 成功；2 环境不满足；3 某一步失败。
param(
    [switch]$DryRun,
    [switch]$Yes,
    [switch]$SkipInstall,
    [string]$Owner = '',
    [string]$Groups = '',
    [string]$Token = ''
)
$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Bridge = Join-Path $Root 'qq-bridge'

function Step([string]$n, [string]$s) { Write-Host ''; Write-Host "[$n] $s" }
function Run([string]$what, [scriptblock]$body) {
    if ($DryRun) { Write-Host "    （-DryRun：本该执行 → $what）"; return $true }
    Write-Host "    → $what"
    & $body
    if ($LASTEXITCODE -ne 0 -and $null -ne $LASTEXITCODE) { Write-Host "    ✗ 这一步失败（退出码 $LASTEXITCODE）"; return $false }
    return $true
}

Write-Host '========================================='
Write-Host ' DSH x QQ 机器人：一键安装'
Write-Host " 仓库根：$Root"
if ($DryRun) { Write-Host ' 模式：-DryRun（只看计划，什么都不做）' }
Write-Host '========================================='

# ── [1/5] 环境检查 ──────────────────────────────────────────────────────────
Step '1/5' '环境检查'
$fail = $false
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Host '    ✗ 找不到 node —— 先装 Node 22 或更高：https://nodejs.org'; $fail = $true }
else {
    $v = (& node -v) 2>$null
    Write-Host "    ✓ node $v"
    $major = [int](($v -replace '^v', '') -split '\.')[0]
    if ($major -lt 22) { Write-Host "    ⚠ Node $v 偏旧，建议 22+（DSH 要求）" }
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Write-Host '    ✗ 找不到 npm（通常随 Node 一起装）'; $fail = $true } else { Write-Host '    ✓ npm' }
if (-not (Test-Path (Join-Path $Bridge 'package.json'))) { Write-Host "    ✗ 找不到 $Bridge\package.json —— 你是不是没在仓库根跑这个脚本？"; $fail = $true } else { Write-Host '    ✓ qq-bridge\package.json' }
$snow = Join-Path $Root 'SnowLuma'
if (Test-Path $snow) { Write-Host '    ✓ SnowLuma\（QQ 网关）' }
else { Write-Host '    ⚠ 没有 SnowLuma\ —— 它是第三方网关，得自己下载解压到仓库根（见 qq-bridge\docs\DSH_SETUP.md）' }
if ($fail) { Write-Host ''; Write-Host '环境不满足，先解决上面 ✗ 的项再跑。'; exit 2 }

# ── [2/5] 装依赖 ────────────────────────────────────────────────────────────
Step '2/5' '装 qq-bridge 的依赖（npm install）'
if ($SkipInstall) { Write-Host '    （-SkipInstall：跳过）' }
else {
    Push-Location $Bridge
    $ok = Run 'npm install' { npm install }
    Pop-Location
    if (-not $ok) { Write-Host '    装依赖失败：常见原因是网络/代理，或 DSH 沙箱不让写 npm 缓存（加 --cache .npm-cache 重试）'; exit 3 }
}

# ── [3/5] 装 DSH 端 ────────────────────────────────────────────────────────
Step '3/5' '装 DSH 端：preset + MCP + 控制台插件'
Push-Location $Bridge
$ok = Run 'node scripts\setup-dsh.mjs' { node scripts\setup-dsh.mjs }
Pop-Location
if (-not $ok) { Write-Host '    装 DSH 端失败：看 qq-bridge\docs\DSH_SETUP.md 的「常见问题」；装完要重启 DSH'; exit 3 }

# ── [4/5] 配置向导 ─────────────────────────────────────────────────────────
Step '4/5' '写配置（只问 4 件事）'
$wizArgs = @('tools\setup-new.mjs')
if ($Yes) { $wizArgs += '--yes' }
if ($Owner) { $wizArgs += @('--owner', $Owner) }
if ($Groups) { $wizArgs += @('--groups', $Groups) }
if ($Token) { $wizArgs += @('--token', $Token) }
Push-Location $Root
$ok = Run ("node " + ($wizArgs -join ' ')) { & node @wizArgs }
Pop-Location
if (-not $ok) { Write-Host '    配置没写成：按它打印的原因改（QQ 号格式 / 两个白名单不能都为空）'; exit 3 }

# ── [5/5] 下一步 ───────────────────────────────────────────────────────────
Step '5/5' '接下来要做的（按顺序）'
# 端口从唯一来源派生（问 Node 要；为什么不在这里写数字见 tools\env-config.ps1 文件头）。
# 位置有讲究：放在 [5/5]（= 依赖已装完）而不是脚本开头 —— 本脚本的前两步要在 **npm install 之前**
# 也能跑（那时 qq-bridge\node_modules 还没有，config-lib.js 的依赖链 import 不进来）。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$Ports = Get-AgentPorts
Write-Host "    1) 起 SnowLuma：双击 SnowLuma\launcher.bat，打开 http://127.0.0.1:$($Ports.snowlumaWeb)"
Write-Host '       · 用首次启动日志里的初始密码登录'
Write-Host '       · 扫码登录你的机器人 QQ'
Write-Host "       · 在 OneBot 配置里开 HTTP($($Ports.onebotHttp)) 与 WebSocket($($Ports.snowlumaWs))，两端 accessToken 设成同一个值"
Write-Host '       · 把那个 accessToken 填进 qq-bridge\config.json 的 snowluma.accessToken'
Write-Host '    2) 重启 DSH（preset / MCP 才生效）'
Write-Host '    3) 一键启动.cmd（家用）；服务器别用它，见 docs\部署到服务器.md'
Write-Host '    4) 验收：node tools\self-check.mjs --deep   —— 应 0 失败'
Write-Host ''
Write-Host '    可选：画图/语音转写密钥填 ~\.dsh\skills\draw-image\credentials.json（不填则这两个工具报缺凭据）'
Write-Host '    完整排查手册：qq-bridge\docs\DSH_SETUP.md ｜ 交付给别人：node tools\pack-new.mjs'
exit 0
