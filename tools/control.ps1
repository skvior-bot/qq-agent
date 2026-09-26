<#
control.ps1 —— **唯一动作源**（facade）。所有"启停 / 页面 / 登录 / 日志 / 自检"动作都从这里进来，
它只负责**翻译成一个动作**，真正的执行永远是现成的那些脚本（本文件里**没有第二份实现**）。

为什么要有它（docs\qq-agent-产品设计.md §3.1 主线 A）：
  同一个动作以前有多份实现 —— cmd 按键一套、start-all.ps1 一套、panels.ps1 一套、桥接 API 一套
  —— 于是"SnowLuma 开两份""组合里那个没登录"这类毛病反复复发。收成一个入口之后，
  cmd 面板与 DSH 页面面板都调这里，两边再也不可能各写一套。

动作白名单**不在本文件里**（2026-09-24 改动）：唯一来源 = `tools\control-actions.json`（数据）
+ `tools\control-actions.mjs`（读取器/校验器）。本文件从目录读：动作清单、每个动作的参数枚举、
哪些动作支持 -Json、-Tail 的上下限、用法那两行怎么排。
  （为什么拆出去：白名单原来是**两处定义** —— 本文件的 ValidateSet/switch 与 tools\control-server.mjs
   的 const VERBS，正是本项目一直在消灭的『同一个值两处定义』；self-check 5.14 会静态拦第二份。
   这也是为"搬去 Linux 服务器"铺路：判定/目录/载波/面板都已经跨平台，只剩"谁来执行"是 Windows 专属，
   那一层叫 tools\control-driver.mjs。）

★ 想看"有哪些动作、每个在当前平台上跑什么、别的平台为什么还不能跑"：
    node tools\control-actions.mjs --json      # 动作目录（含每个动作在 Windows 上跑哪些脚本）
    node tools\control-driver.mjs --check      # 这个平台上哪些动作能跑、少了什么

本文件只做两件事：① 把动作翻译成"调用哪个现成脚本"（改行为请改那些脚本，别在这里加逻辑）；
② 把 status 的判定整理成 §3.1 契约。动作 → 执行体那张表**不再抄在这里** —— 它是动作目录里
platform.win32.steps 的活儿（一处定义，`node tools\control-actions.mjs --json` 就能看全）。

用法示例：
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 status
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 status -Json     # 给页面/程序读
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 up -DryRun       # 只看会做什么
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 restart dsh
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 pages open -Pages dsh,console
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 pages open -Pages none   # 一个页面都不开（挂机模式）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 login qq
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 logs bridge -Tail 50
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 down              # 会问一句
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 down -Yes         # 不问（脚本用）
  （动作清单与参数枚举：node tools\control-actions.mjs --json；用法屏：control.ps1 help）

-DryRun 的准确语义（**比"先看再跑"更强**）：
  ① 只读动作（status / logs / doctor）照常执行 —— 它们不看不动任何状态；
  ② 会改状态的动作（up / down / restart / pages / login）**只打印将要执行的命令行，连子进程都不拉**。
     为什么这么定：2026-09-24 踩过"PowerShell 对未声明的参数只是当多余参数忽略掉" ⇒ 干跑变成了
     完整启动一遍（详见 docs\启动与踩坑.md）。本脚本的 DryRun 不让任何子脚本去解释这个开关，
     所以不存在"某个脚本没声明 -DryRun"的风险。

退出码：0 = 成功（status 的"灯不绿"不算失败，去读输出/JSON）；1 = 动作失败；2 = 用法/白名单错误；
        4 = 执行体缺失或取不到状态。（3 = 该动作**已知未实现**，是留给"有动作但没执行体"那种情况的
        位置 —— 2026-09-24 P1④ 之后 `restart snowluma` 已经有执行体（stop-all.ps1 -OnlySnowLuma），
        所以现在**没有任何动作用到 3**；这条留着不删，免得以后有人以为该复用它。）
        5 = **被并发闸拒了**（2026-09-25 加，只有 restart-stack 用）：已经有一次同样的动作在飞，
        这一次**没做**（不是失败）—— 想要就来 `-Force` 越过那道闸。HTTP 面上同一个条件在发起前
        就变成 409（见动作目录的 http.busyGuard），到不了这里。

注意：本文件必须存成 **UTF-8 带 BOM**（PS 5.1 对无 BOM 的 UTF-8 按 ANSI 解码，中文注释会炸解析，
而且"改的时候没事、下次运行才炸"）。tools\self-check.mjs 的不变量 5.10 会查这一条。
#>
[CmdletBinding()]
param(
  # 动作名。缺省 = status（最安全的那一个）。
  # ⚠ 这里**故意没有 ValidateSet**：动作白名单的唯一来源是 tools\control-actions.json，
  #   而 PowerShell 的 ValidateSet 只能写常量（没法从文件读）—— 写一份常量就等于把白名单
  #   又抄了一遍（正是本轮要消灭的东西）。改成读目录后当场校验，不认识的动作走 [用法错误] + 退出码 2
  #   （与文件头写的"2 = 用法/白名单错误"一致；以前 ValidateSet 会让它变成 PS 参数绑定错误 + 退出码 1）。
  [Parameter(Position = 0)]
  [string]$Action = 'status',
  # 第二个词（子动作 / 目标）：restart、pages、login、logs 用它。
  [Parameter(Position = 1)][string]$Target = '',
  [Parameter(Position = 2)][string]$Target2 = '',
  # logs 的行数（透传给 node tools\ops.mjs logs <x> <N>）。
  [int]$Tail = 40,
  # pages open 用：这次开哪几页（**原样透传给 panels.ps1**，本脚本不校验、也不存名单）：
  #   all / none / dsh,console,snowluma 的子集。不传 = 用 panels.ps1 里那一份默认值（$DefaultPages）。
  #   ⚠ 页列表**只有 panels.ps1 那一份来源**（将来按配置派生"挂机模式"也只改那一处）。
  [string[]]$Pages = @(),
  # pages open 用：这几页必须重开（跳过"已开着就不重复开"判断）。
  [string[]]$ForcePage = @(),
  # pages open 用：开进"我们自己的一个窗口"（"关闭全部"时能一起收掉）。
  [switch]$OwnWindow,
  # status 用：输出机器可读 JSON（五灯 + 下一动作 + 诊断码 + ops.mjs 的原始判定）。
  # nextAction 是结构 { text, action }：text 只说什么缺，"怎么做"由载体渲染（设计文档 §3.1）。
  [switch]$Json,
  # 只打印将要执行的命令行，绝不改状态（见文件头"-DryRun 的准确语义"）。
  [switch]$DryRun,
  # down 用：不再问那一句（给脚本/页面调用）。
  [switch]$Yes,
  # up 用：五灯全绿也照样全量重起（= restart all）。
  # restart-stack 用（2026-09-25 加）：**越过盘上的 single-flight 闸**（已经有一次在飞也照样再发起一次）。
  #   只给"主人亲手按"的兜底路（tools\restart-stack-now.cmd）用：HTTP 面**拿不到**这个开关
  #   （动作目录给的 argv 是死的），所以网上来的请求永远越不过闸。
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Tools = $PSScriptRoot
# ── 端口唯一来源（P2⑦ 参数单一来源）────────────────────────────────────────
# 默认值表只有一处（qq-bridge\src\config-lib.js 的 DEFAULT_PORTS），生效值由仓库根的
# agent.config.json 决定 —— 这里问 Node 要（为什么这么绕，tools\env-config.ps1 文件头写了）。
# 本脚本**一个端口字面量都不抄**：下面打印的地址、-Json 契约里的 detail 全从 $Ports 派生。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$Ports = Get-AgentPorts
$DshPort = $Ports.dshWeb              # DSH Web
$BridgePort = $Ports.bridgeConsole    # 桥接控制台
$SnowLumaPort = $Ports.snowlumaWs     # SnowLuma 的 OneBot WS
$SnowLumaWebPort = $Ports.snowlumaWeb # SnowLuma 管理页
$OneBotHttpPort = $Ports.onebotHttp   # OneBot HTTP
$ControlPort = $Ports.bridgeControl   # 控制面（页面总控面板的 HTTP 载波，独立进程）
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$NodeExe = 'node'
try { $found = Get-Command node -ErrorAction SilentlyContinue; if ($found) { $NodeExe = $found.Source } } catch { }
$ExitCode = 0

# ── 动作目录（唯一一处定义）────────────────────────────────────────────────────
# 动作清单 / 参数枚举 / 哪些动作支持 -Json / -Tail 上下限 / 用法那两行 —— 全部来自
# tools\control-actions.json（读取器与校验器是 tools\control-actions.mjs；self-check 5.14 会
# 静态拦"第二份动作清单"）。本脚本**不再自己写一份**，也**不做"读不到就退回内置默认"的兜底** ——
# 那种兜底正是"同一个值两处定义"的温床，而且它会让"目录改坏了"表现成"改了没生效"（最难查的一类）。
$CatalogFile = Join-Path $Tools 'control-actions.json'
function Get-ActionCatalog {
  if (-not (Test-Path -LiteralPath $CatalogFile)) { throw "找不到动作目录：$CatalogFile（动作清单的唯一来源，不能少）" }
  try { $doc = Get-Content -LiteralPath $CatalogFile -Raw -Encoding UTF8 | ConvertFrom-Json }
  catch { throw "动作目录读不了（$CatalogFile）：$($_.Exception.Message)" }
  if (-not $doc.actions -or @($doc.actions).Count -eq 0) { throw "动作目录里没有 actions：$CatalogFile" }
  return $doc
}
$Catalog = $null
try { $Catalog = Get-ActionCatalog } catch { Say "  [错误] $($_.Exception.Message)"; exit 4 }
$Actions = @($Catalog.actions)

# 按 id 找动作（**大小写不敏感** —— 与原来的 ValidateSet / 哈希表同一口径，`STATUS` 照旧能用）。
function Find-Action([string]$id) {
  foreach ($a in $Actions) { if ([string]$a.id -ieq $id) { return $a } }
  return $null
}
# 取某个动作的某个参数声明（没有就 $null）。
function Get-ParamSpec($act, [string]$name) {
  foreach ($p in @($act.params)) { if ($p -and [string]$p.name -ieq $name) { return $p } }
  return $null
}
# 用法清单那两行（第 1 行 / 第 2 行）：排版信息也在目录里（usage / usageRow），本脚本不排第二遍。
function Get-UsageParts([int]$row = 0) {
  $parts = @()
  foreach ($a in $Actions) {
    if (-not $a.usage) { continue }
    if ($row -gt 0 -and [int]$a.usageRow -ne $row) { continue }
    $parts += [string]$a.usage
  }
  return $parts
}
# 支持 -Json 的动作（报错文案里要用它们的名字）。
function Get-JsonActionNames { return @($Actions | Where-Object { [bool]$_.supportsJson } | ForEach-Object { [string]$_.id }) }

function Say([string]$msg = '') { Write-Host $msg }

# 中文是双宽字符：`'{0,-14}' -f` 按**字符数**补齐 ⇒ 中文标签会歪。这里按"显示宽度"补齐，
# 让本脚本打印的端口行与 node tools\ops.mjs status 的那五行**逐列对齐**（同一张表，别两种排版）。
function Get-DisplayWidth([string]$s) {
  $w = 0
  foreach ($ch in $s.ToCharArray()) {
    $code = [int][char]$ch
    if (($code -ge 0x1100 -and $code -le 0x115F) -or ($code -ge 0x2E80 -and $code -le 0xA4CF) -or
        ($code -ge 0xAC00 -and $code -le 0xD7A3) -or ($code -ge 0xF900 -and $code -le 0xFAFF) -or
        ($code -ge 0xFE30 -and $code -le 0xFE6F) -or ($code -ge 0xFF00 -and $code -le 0xFF60) -or
        ($code -ge 0xFFE0 -and $code -le 0xFFE6)) { $w += 2 } else { $w += 1 }
  }
  return $w
}
function Pad-Display([string]$s, [int]$width) {
  $pad = $width - (Get-DisplayWidth $s)
  if ($pad -lt 0) { $pad = 0 }   # 正好等宽就不补（再补就比 ops.mjs 那张表多一格）
  return $s + (' ' * $pad)
}

# 命令行原样打出来（带空格的参数加引号），DryRun 时用户看到的就是"真跑会长什么样"。
function Format-Cmd([string]$exe, [string[]]$cmdArgs) {
  $parts = @($exe)
  foreach ($a in @($cmdArgs)) {
    if ($null -eq $a) { continue }
    if ($a -match '[\s"]') { $parts += '"' + ($a -replace '"', '\"') + '"' } else { $parts += $a }
  }
  return ($parts -join ' ')
}

# 跑一个子进程：输出实时进控制台（Out-Host，不污染返回值），返回退出码。
# ★ $DryRun 时**一个子进程都不拉** —— 只打印命令行（见文件头）。
function Invoke-Step {
  param([string]$Label, [string]$Exe, [string[]]$CmdArgs)
  Say "  · $Label"
  Say "    > $(Format-Cmd $Exe $CmdArgs)"
  if ($DryRun) { Say '      [DryRun] 没执行（只打印这一行）'; return 0 }
  $code = 0
  Push-Location $Root
  try { & $Exe @CmdArgs | Out-Host } catch { Say "    [错误] $($_.Exception.Message)"; Pop-Location; return 1 }
  Pop-Location
  try { $code = [int]$LASTEXITCODE } catch { $code = 0 }
  if ($null -eq $code) { $code = 0 }
  Say "    退出码：$code"
  return $code
}
# ★ 2026-09-26（P1：「面板上那三个按钮还通着抢号那条路」）：**QQ 那套在不在本机** —— 决定
#   「重起」类动作该碰什么。搬家（qq-bridge\qq-moved-to-server）之后，凡是经过 start-all 的「起服务」
#   动作都会把 SnowLuma 与桥接起出来 ⇒ **抢号**（服务器上那只被顶下线）⇒ 那几条路一律改走「只碰该碰的」。
#   口径与 DSH-Web 窗口那份 Test-QqNotLocal **完全一致**（同一份输入：标记文件 / DSH_WINDOW_NO_SERVICES /
#   DSH_WINDOW_QQ_MOVED_FILE）。这里必须自己判一次：本脚本是**独立进程**，点源不了那个 3000 行的窗口脚本。
function Test-QqServicesNotLocal {
    if ($env:DSH_WINDOW_NO_SERVICES -eq '1') { return $true }
    $marker = [string]$env:DSH_WINDOW_QQ_MOVED_FILE
    if (-not $marker) { $marker = Join-Path (Split-Path $PSScriptRoot -Parent) 'qq-bridge\qq-moved-to-server' }
    try { return (Test-Path -LiteralPath $marker) } catch { return $false }
}

function Invoke-Ps1([string]$ScriptName, [string[]]$Extra = @()) {
  $path = Join-Path $Tools $ScriptName
  if (-not (Test-Path $path)) { Say "  [错误] 找不到执行体：$path"; return 4 }
  return (Invoke-Step $ScriptName 'powershell.exe' (@('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $path) + @($Extra)))
}
function Invoke-Node([string]$ScriptName, [string[]]$Extra = @()) {
  $path = Join-Path $Tools $ScriptName
  if (-not (Test-Path $path)) { Say "  [错误] 找不到执行体：$path"; return 4 }
  return (Invoke-Step $ScriptName $NodeExe (@($path) + @($Extra)))
}

# ── 已知启动窗口：**盖章**（"刚发起启动/重启"的时间戳）──────────────────────────────
# 只有"真正发起启动/重启"的那几个动作分支才调它（up / restart all / restart dsh / restart bridge）——
# 那几个动作都会把桥接带下去，随后的几秒里"桥接没在监听"是**预期内**的，不该弹"⚠ 桥接断了 → 按 r"。
# ⚠ 这里**只写时间戳**，不写"多久算正在起"：那个数字（45 秒）与判定算法只在 tools\starting-window.mjs
#   一处（node 侧同一份形状、同一个文件）；本脚本读的 `$status.starting` 就是它的判定结果。
# ⚠ -DryRun 承诺"一个字节都不写" ⇒ 干跑只打印一句、不落盘。
# ⚠ 盖不上章（目录没了 / 权限不行）**绝不让整个动作失败**：它只是个给提示用的时间戳。
function Set-StartingStamp([string]$Action) {
  if ($DryRun) { Say "  [DryRun] 会盖一个启动窗口时间戳（$Action）—— 干跑不写任何文件。"; return }
  try {
    $tmp = Join-Path $Root 'qq-bridge\state\_tmp'
    if (-not (Test-Path $tmp)) { New-Item -ItemType Directory -Path $tmp -Force | Out-Null }
    $now = [System.DateTimeOffset]::Now
    $rec = [ordered]@{
      at     = $now.ToString('yyyy-MM-ddTHH:mm:sszzz')   # 本地带偏移（与项目里其它时间戳一个口径）
      atMs   = $now.ToUnixTimeMilliseconds()
      action = $Action
      what   = $(if ($Action -eq 'restart') { '重启' } else { '启动' })
      by     = 'control.ps1'
    }
    # 幂等覆盖（同一个动作再发起一次就写成新时间戳）；_tmp 随时可清 ⇒ 不需要清理逻辑。
    [System.IO.File]::WriteAllText((Join-Path $tmp 'starting.json'), (ConvertTo-Json $rec -Compress), $Utf8NoBom)
  } catch {
    Say "  [提示] 启动窗口时间戳没盖上（不影响这次启动）：$($_.Exception.Message)"
  }
}

# ── 触发者是谁（★ 2026-09-25 协调线硬要求）──────────────────────────────────────
# 今晚那场"DSH 反复换代"卡住的就这一格：`state\_tmp\launcher-windows.log` 与 `.launcher-state.json`
# 能证明"启动器在哪几秒跑过"，但**查不出是谁触发的** —— 启动器从来不记调用者。所以两处都补：
#   ① 本脚本（= 唯一动作源）在 restart-stack 的**每条出口**上往 `qq-bridge\state\_tmp\restart-stack.jsonl`
#      追加一行（时间 / 事件 / 走哪条路 / 触发者进程链 / 结果 / requestId）；
#   ② tools\start-all.ps1 开头补一行"我是被谁调起来的"（父进程命令行 + ppid）。
# 取不到就**如实留空**（CIM 在受限沙箱里会拒绝访问），绝不猜。
function Get-TriggerChain {
  $chain = New-Object System.Collections.ArrayList
  try {
    $me = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $PID) -ErrorAction Stop
    $cur = [int]$me.ParentProcessId
    $depth = 0
    while ($cur -gt 0 -and $depth -lt 4) {
      $p = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $cur) -ErrorAction Stop
      if (-not $p) { break }
      $line = [string]$p.CommandLine
      if ($line.Length -gt 300) { $line = $line.Substring(0, 300) + '…' }
      [void]$chain.Add(('{0}({1}) {2}' -f $p.Name, $p.ProcessId, $line))
      $cur = [int]$p.ParentProcessId
      $depth++
    }
  } catch { }
  return @($chain)
}

# 走的是哪条路：父进程链里出现控制面的驱动/服务 = HTTP 那条；否则是命令行/双击那条。
function Get-TriggerPath($chain) {
  $joined = ($chain -join ' ')
  if ($joined -match 'control-server|control-driver') { return ('http（控制面 :{0}）' -f $ControlPort) }
  if ($joined -match 'restart-stack-now') { return 'cmd（tools\restart-stack-now.cmd）' }
  return 'cli（命令行 control.ps1 restart-stack）'
}

function Write-RestartLedger($rec) {
  try {
    $dir = Join-Path $Root 'qq-bridge\state\_tmp'
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $line = ConvertTo-Json $rec -Compress -Depth 6
    [System.IO.File]::AppendAllText((Join-Path $dir 'restart-stack.jsonl'), ($line + "`r`n"), $Utf8NoBom)
  } catch {
    Say "  [提示] 触发记录没进账本（不影响这次重启）：$($_.Exception.Message)"
  }
}

# 抓 ops.mjs 的 UTF-8 输出（**不碰控制台代码页**：用 .NET 进程 + StandardOutputEncoding，
# 免得 PS 5.1 按 GBK 解码 UTF-8 变成乱码 —— 那种乱码不可恢复）。
function Invoke-CaptureUtf8([string]$Exe, [string[]]$CmdArgs) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Exe
  $psi.Arguments = (Format-Cmd '' $CmdArgs).Trim()
  $psi.WorkingDirectory = $Root
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = $Utf8NoBom
  $psi.StandardErrorEncoding = $Utf8NoBom
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $p = [System.Diagnostics.Process]::Start($psi)
  $out = $p.StandardOutput.ReadToEnd()
  $err = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  return [pscustomobject]@{ ExitCode = $p.ExitCode; StdOut = $out; StdErr = $err }
}

# ── status 的唯一判定来源 ─────────────────────────────────────────────────────
# 只用 node tools\ops.mjs status --json（端口表 / 令牌比对 / QQ 在线 / 全绿都在那边算），
# 本脚本**不自己探测端口**、不自己发明口径 —— 这样"与 ops.mjs status 一致"是结构上成立的。
function Get-OpsStatus {
  # ★ 只读测试钩子（与 tools\dsh-prompt.ps1 的 DSH_WINDOW_STATUS_JSON 同名同义；正常流程不设它）：
  #   给一份假的 status JSON 顶替真实探测 ⇒ "已知启动窗口内 / 宽限期外"这类分支能**离线**验一遍，
  #   一个字节都不写、不碰任何服务（回归网 qq-bridge\scripts\test-control-starting-window.mjs 用它）。
  $hook = [string]$env:DSH_CONTROL_STATUS_JSON
  if ($hook) {
    if (-not (Test-Path -LiteralPath $hook)) { throw "测试钩子 DSH_CONTROL_STATUS_JSON 指向的文件不存在：$hook" }
    return (Get-Content -LiteralPath $hook -Raw -Encoding UTF8 | ConvertFrom-Json)
  }
  $r = Invoke-CaptureUtf8 $NodeExe @((Join-Path $Tools 'ops.mjs'), 'status', '--json')
  if ($r.ExitCode -ne 0 -or -not $r.StdOut.Trim()) {
    throw "取不到状态：node tools\ops.mjs status --json 退出码 $($r.ExitCode) $($r.StdErr.Trim())"
  }
  return ($r.StdOut | ConvertFrom-Json)
}

# 状态条那行"上次事件"（docs\qq-agent-产品设计.md §4.1：「几点、发生了什么」）。
# ★ 必须来自**真实来源**、不许编：取 state\bridge.log 最后一条有意义的行（桥接是"发生了什么"的
#   第一现场：谁发了消息、模式切换、工具调用、守护拉起……都记在那里）。取不到就返回 $null，
#   让载体自己退回 generatedAt + nextAction.text —— 面板宁可少一行，也不能显示假事件。
# ⚠ 时间口径（本项目踩过两次的坑）：bridge.log 的行首时间戳是 **UTC 且不带日期**，
#   只有文件的 LastWriteTime 是本地且带日期的。所以：at 用文件 mtime（本地、带偏移），
#   行首那个 UTC 时刻另存成 lineUtc **原样交代**，绝不把它当本地时间显示出去。
function Get-LastEvent {
  $f = Join-Path $Root 'qq-bridge\state\bridge.log'
  if (-not (Test-Path $f)) { return $null }
  try {
    $fi = Get-Item -LiteralPath $f
    if ($fi.Length -le 0) { return $null }
    $take = [Math]::Min(8192, [int]$fi.Length)
    $fs = [System.IO.File]::Open($fi.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      [void]$fs.Seek(-$take, [System.IO.SeekOrigin]::End)
      $buf = New-Object byte[] $take
      $read = $fs.Read($buf, 0, $take)
    } finally { $fs.Close() }
    $text = [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
    $lines = @($text -split "`r?`n" | Where-Object { $_.Trim() })
    # 第一行多半是从中间切进去的半截行，丢掉
    if ($lines.Count -gt 1) { $lines = @($lines[1..($lines.Count - 1)]) }
    if ($lines.Count -eq 0) { return $null }
    $line = $lines[$lines.Count - 1].Trim()
    if (-not $line) { return $null }
    $lineUtc = ''
    if ($line -match '^(\d{2}:\d{2}:\d{2})\s+(.*)$') { $lineUtc = $Matches[1]; $line = $Matches[2].Trim() }
    if ($line.Length -gt 160) { $line = $line.Substring(0, 160) + '…' }
    $mtime = [System.DateTimeOffset]$fi.LastWriteTime
    return [ordered]@{
      text    = $line
      at      = $mtime.ToString('yyyy-MM-ddTHH:mm:sszzz')   # 本地时间，带偏移
      atClock = $mtime.ToString('HH:mm:ss')                 # 本地时刻，直接可显示
      lineUtc = $lineUtc                                    # 行首那个 UTC 时刻（原样，别混用）
      source  = 'bridge'
    }
  } catch { return $null }
}

function Get-Lights($status) {
  $up = @{}
  foreach ($p in @($status.ports)) { $up[[string]$p.key] = [bool]$p.open }
  $lights = [ordered]@{
    dsh      = [bool]$up['dsh']
    bridge   = [bool]$up['bridge']
    snowluma = [bool]$up['snowluma']
    qq       = ([string]$status.qq.state -eq 'online')
    token    = [bool]$status.token.synced
  }
  return $lights
}

# 首启引导的完成态（docs\qq-agent-产品设计.md §10.2 落在 state\onboarded.json）。
# 文件还没有时（P1 才落地）**不硬说"第一次用"**：老用户每天在用，天天被念"第一次用"就是骚扰
# （§10.1 第 4 条）⇒ 用"QQ 在线 + 链路通"当"这人明显已经在用了"的证据。
function Get-Onboarded($lights) {
  $f = Join-Path $Root 'qq-bridge\state\onboarded.json'
  if (Test-Path $f) {
    try {
      $o = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($o.completedAt) { return @{ done = $true; source = 'state\onboarded.json' } }
      return @{ done = $false; source = 'state\onboarded.json（还没走完）' }
    } catch { return @{ done = $false; source = 'state\onboarded.json（读不了）' } }
  }
  if ($lights['qq'] -and $lights['token'] -and $lights['bridge']) { return @{ done = $true; source = '推断：QQ 在线且链路通（没有 state\onboarded.json）' } }
  return @{ done = $false; source = '没有 state\onboarded.json' }
}

# 一行"下一动作"（docs\qq-agent-产品设计.md §10.3 + §3.1 的契约；每句话都必须是**一个动作**）。
# ★ 返回的是**结构**（2026-09-24 改，§3.1"下一动作要带动作 id"）：给人看的 text + 给机器读的 action。
#   为什么：同一句话在两个载体上"怎么按"不一样 —— cmd 窗口说"按 r"，页面面板得说"点启动"
#   ⇒ **"怎么做"由载体自己渲染，控制面只负责说"现在缺什么"**。
#   ⚠ 反面教材（已修）：这里原来有一句 `跑 tools\control.ps1 up（或双击 一键启动.cmd）` ——
#     既违反 §10.1-2（引导语不许出现脚本路径），在页面面板上又没法用（那里没有键可按）。
#   因此 text 里**只许说缺什么**：不许出现脚本路径 / 端口 / 令牌 / 键位。
#   动作枚举（白名单，别加自由字符串）：up | restart | login | pages | none
# ★ 已知启动窗口（2026-09-24 晚，主人实拍那屏）：刚发起过启动/重启的 45 秒内，桥接还没监听是
#   **预期内**的 ⇒ 不算问题、不叫他按 r（那一下会把正在用的会话白掐断）。判定**不在这里**：
#   `$starting` 原样来自 node tools\ops.mjs status --json 的 `starting` 字段（数字与算法只在
#   tools\starting-window.mjs 一处），本函数只决定文案与 action。
#   ⚠ 宽限期一过 `$starting.active` 就是 false ⇒ 下面那行**原样**回到"⚠ 桥接断了 + restart"，
#     真故障一个字都不许吞（这是这条改动的底线）。
function Get-NextAction($lights, $onboarded, $starting, $displayName = '你的机器人') {
  if (-not $lights['dsh']) { return [pscustomobject]@{ text = '⚠ DSH 没在跑'; action = 'up' } }
  if (-not $lights['qq']) { return [pscustomobject]@{ text = '⚠ QQ 没登录'; action = 'login' } }
  if (-not $lights['bridge'] -and $starting.active) {
    return [pscustomobject]@{ text = '⏳ 正在起（桥接还在启动，不用管）'; action = 'none' }
  }
  if (-not $lights['bridge']) { return [pscustomobject]@{ text = '⚠ 桥接断了'; action = 'restart' } }
  if (-not $lights['token']) { return [pscustomobject]@{ text = '⚠ 登录态过期'; action = 'restart' } }
  if (-not $lights['snowluma']) { return [pscustomobject]@{ text = '⚠ SnowLuma 没起来'; action = 'restart' } }
  if (-not $onboarded.done) { return [pscustomobject]@{ text = '第一次用：① 扫码登录 QQ ② 在 QQ 里发一句「你好」'; action = 'login' } }
  # ★ 机器人名字**不许硬编码**（原来是「小懒鲸」—— 交付给别人就指向别人的机器人）。
  #   值由调用方给：环境层 displayName > 网关登录昵称 > 「你的机器人」（见 env-config.ps1 的 Get-AgentBotName）。
  return [pscustomobject]@{ text = "一切正常 · 在 QQ 里跟「$displayName」说话就行（这个窗口没事不用管）"; action = 'none' }
}

# "怎么做"的**本载体**渲染（本脚本是 cmd 面板/终端这一路的载体；页面面板有它自己的一份）。
# 依旧是 §10.1-2 允许的"一句人话"：只说按哪个键，**绝不带脚本路径 / 端口 / 令牌**。
function Format-NextActionText($next) {
  $suffix = switch ([string]$next.action) {
    'up' { ' → 按 r 起它' }
    'restart' { ' → 按 r（会自动修）' }
    'login' { ' → 按 s' }
    'pages' { ' → 按 w' }
    default { '' }
  }
  return ([string]$next.text + $suffix)
}

# 排障信息：这个动作等价的**命令行** —— 只印在引导语**下面单独一行**（§10.1-2：引导语里不许有路径）。
# 返回空串表示"这个动作不需要命令行"（none / 未知）。
function Get-NextActionRunbook($next) {
  switch ([string]$next.action) {
    'up' { return '起三件套：control.ps1 up（= tools\start-all.ps1，或双击 一键启动.cmd）' }
    'restart' { return '自愈：DSH-Web 窗口里按 r（= 只重起 DSH，缺的服务一起补起）；只救桥接：tools\ensure-bridge.ps1' }
    'login' { return '登录 QQ：control.ps1 login qq' }
    'pages' { return '开页面：control.ps1 pages open' }
    default { return '' }
  }
}

function Get-DiagnosticCode($lights) {
  $bits = ''
  foreach ($k in @('dsh', 'bridge', 'snowluma', 'qq', 'token')) { $bits += $(if ($lights[$k]) { '1' } else { '0' }) }
  return "CTL-$bits"
}

function Show-Usage {
  Say 'control.ps1 —— 唯一动作源（用法见文件头，这里只列动作白名单）'
  # 用法清单来自动作目录（usage / usageRow）——本脚本不排第二遍，改动作只改目录那一个文件。
  foreach ($row in @(1, 2)) {
    $parts = @(Get-UsageParts $row)
    if ($parts.Count -gt 0) { Say ('  ' + ($parts -join ' | ')) }
  }
  Say '  通用开关：-DryRun（只打印不动作） -Yes（down 不问） -Json（status 输出 JSON）'
  Say '  例：powershell -NoProfile -ExecutionPolicy Bypass -File tools\control.ps1 status -Json'
}

function Fail-Usage([string]$msg) {
  Say "  [用法错误] $msg"
  Say ('  可用动作：' + ((Get-UsageParts 0) -join ' | '))
  exit 2
}

# 动作与子参数的白名单校验（枚举，不是自由参数）—— 枚举全部来自动作目录。
# ★ 这里就是原来 ValidateSet 的位置：不认识的动作当场报用法错误（退出码 2，与文件头一致）。
$t = $Target.Trim().ToLowerInvariant()
$act = Find-Action ([string]$Action)
if (-not $act) { Fail-Usage "不认识的动作「$Action」" }
$targetSpec = Get-ParamSpec $act 'target'
if ($targetSpec) {
  $allowed = @($targetSpec.values)
  if (-not $t) { Fail-Usage "$Action 后面还要一个词：$($allowed -join ' | ')" }
  if ($allowed -notcontains $t) { Fail-Usage "$Action 的参数「$Target」不在白名单里：$($allowed -join ' | ')" }
}
if (-not $targetSpec -and $Target2) { Fail-Usage "多出来的参数「$Target2」" }
$tailSpec = Get-ParamSpec $act 'tail'
if ($tailSpec -and ($Tail -lt [int]$tailSpec.min -or $Tail -gt [int]$tailSpec.max)) {
  Fail-Usage "-Tail 只能是 $([int]$tailSpec.min)~$([int]$tailSpec.max)"
}
if ($Json -and -not [bool]$act.supportsJson) {
  Fail-Usage "-Json 目前只有 $((Get-JsonActionNames) -join ' 与 ') 支持"
}

if ($DryRun) { Say '[DryRun] 只打印会做什么；会改状态的动作连子进程都不会拉。' }

switch ($Action) {
  'help' { Show-Usage; exit 0 }

  # ── status：五灯 + 一行"下一动作"（判定全在 node tools\ops.mjs status --json 里）────────
  'status' {
    try { $status = Get-OpsStatus } catch {
      if ($Json) { Write-Output (ConvertTo-Json @{ ok = $false; error = $_.Exception.Message } -Depth 4) } else { Say "  [错误] $($_.Exception.Message)" }
      exit 4
    }
    $lights = Get-Lights $status
    $onboarded = Get-Onboarded $lights
    $next = Get-NextAction $lights $onboarded $status.starting (Get-AgentBotName $status)
    $diag = Get-DiagnosticCode $lights
    $lastEvent = Get-LastEvent
    $onCount = 0; foreach ($k in $lights.Keys) { if ($lights[$k]) { $onCount++ } }

    if ($Json) {
      $lightList = @()
      foreach ($k in @(
          @{ key = 'dsh'; label = 'DSH' }, @{ key = 'bridge'; label = '桥接' },
          @{ key = 'snowluma'; label = 'SnowLuma' }, @{ key = 'qq'; label = 'QQ' },
          @{ key = 'token'; label = '令牌' })) {
        $detail = switch ($k.key) {
          'dsh' { "DSH Web :$DshPort" }
          'bridge' { "桥接控制台 :$BridgePort" }
          'snowluma' { "SnowLuma WS :$SnowLumaPort（含 OneBot :$OneBotHttpPort / 管理页 :$SnowLumaWebPort）" }
          'qq' { "QQ 账号 $($status.qq.state)" }
          'token' { 'config.json 与最新 guard 日志同一令牌' }
        }
        $lightList += [ordered]@{ key = $k.key; label = $k.label; on = [bool]$lights[$k.key]; detail = $detail }
      }
      $payload = [ordered]@{
        action         = 'status'
        source         = 'node tools\ops.mjs status --json'
        ok             = $true
        allGreen       = [bool]$status.allGreen
        lights         = [ordered]@{
          dsh = [bool]$lights['dsh']; bridge = [bool]$lights['bridge']; snowluma = [bool]$lights['snowluma']
          qq = [bool]$lights['qq']; token = [bool]$lights['token']
        }
        lightList      = $lightList
        # ★ §3.1 契约：给人看的 text + 给机器读的 action（枚举 up|restart|login|pages|none）。
        #   "怎么做"由载体渲染：cmd 窗口 → "按 r"，页面面板 → "[启动]"。
        nextAction     = [ordered]@{ text = [string]$next.text; action = [string]$next.action }
        # ★ 已知启动窗口的**判定结果**（原样透传 node tools\ops.mjs status --json 的 `starting`）：
        #   渲染方（横幅/面板）读它就知道"桥接没监听"是刚发起启动（宽限期内，不算问题）
        #   还是真故障。⚠ 它只是**透传**：数字与算法不在这里（tools\starting-window.mjs 一处）。
        starting       = $status.starting
        diagnosticCode = $diag
        # §4.1 状态条的"上次事件"（真实日志尾部；取不到就是 null，载体自己退让）
        lastEvent      = $lastEvent
        onboarded      = [ordered]@{ done = [bool]$onboarded.done; source = $onboarded.source }
        ports          = $status.ports
        token          = $status.token
        qq             = $status.qq
        generatedAt    = $status.generatedAt
      }
      Write-Output (ConvertTo-Json $payload -Depth 6)
      exit 0
    }

    Say '── control.ps1 status（判定＝node tools\ops.mjs status --json，同一口径）──'
    foreach ($p in @($status.ports)) {
      $state = if ($p.open) { 'OK  ' } else { 'DOWN' }
      Say ("  " + (Pad-Display ([string]$p.label) 13) + " : $state  127.0.0.1:$([int]$p.port)")
    }
    $lampOf = { param($b) if ($b) { '✓' } else { '✗' } }
    Say ("  五灯：DSH $(& $lampOf $lights['dsh']) ｜ 桥接 $(& $lampOf $lights['bridge']) ｜ SnowLuma $(& $lampOf $lights['snowluma']) ｜ QQ $(& $lampOf $lights['qq']) ｜ 令牌 $(& $lampOf $lights['token'])   （$onCount/5）")
    if ($lights['qq']) { Say "  QQ  ：在线 $($status.qq.nickname) ($($status.qq.userId))" }
    else { Say "  QQ  ：$($status.qq.state) $($status.qq.raw)$($status.qq.message)" }
    Say "  令牌：$($status.token.configMasked) / 日志 $($status.token.logFile)（同步：$($status.token.synced)）"
    Say "  引导：$(if ($onboarded.done) { '已完成' } else { '未完成' })（$($onboarded.source)）"
    Say ("  下一动作：{0}" -f (Format-NextActionText $next))
    $runbook = Get-NextActionRunbook $next
    if ($runbook) { Say ("  [排障] {0}" -f $runbook) }
    if (-not $status.allGreen) { Say "  诊断码：$diag（修不好时把这行发我）" }
    Say '  （JSON 版：control.ps1 status -Json）'
    exit 0
  }

  # ── up：幂等"确保在跑"（全绿就什么都不做 —— 免得白掐断主人正在用的会话）──────────────
  'up' {
    try { $status = Get-OpsStatus } catch { Say "  [错误] $($_.Exception.Message)"; exit 4 }
    if ($status.allGreen -and -not $Force) {
      Say '  五灯全绿，已经在跑 —— 什么都不用做（要重起：control.ps1 restart all）。'
      exit 0
    }
    if ($Force -and $status.allGreen) { Say '  -Force：即使全绿也照样全量重起（= restart all）。' }
    else { Say '  五灯没全绿 → 全量启动（start-all.ps1 会先清场，再干净起三件套）。' }
    Set-StartingStamp 'up'   # ★ 真发起启动之前盖章：接下来这几秒桥接没监听是预期内的
    $rc = Invoke-Ps1 'start-all.ps1'
    if ($rc -ne 0) { Say "  [失败] start-all.ps1 退出码 $rc"; exit 1 }
    Say '  完成。接着看：control.ps1 status'
    exit 0
  }

  # ── down：停全部（**二次确认**；非交互 stdin 一律当"取消"）──────────────────────────
  'down' {
    Say '  这会停掉 DSH Web + SnowLuma + qq-bridge（QQ 机器人下线、正在用的会话会断）。'
    if ($DryRun) {
      Invoke-Ps1 'stop-all.ps1' | Out-Null
      Say '  [DryRun] 结束（上面就是真跑时会执行的那一条）。'
      exit 0
    }
    if (-not $Yes) {
      $ans = ''
      try { $ans = [string](Read-Host '  确认关闭全部？输入 yes 继续（其它任何输入 = 取消，什么都不做）') } catch { $ans = '' }
      if ($ans -notmatch '^\s*(?i:y|yes|是|确定|确认)\s*$') { Say '  已取消（什么都没做）。'; exit 0 }
    }
    $rc = Invoke-Ps1 'stop-all.ps1'
    if ($rc -ne 0) { Say "  [失败] stop-all.ps1 退出码 $rc"; exit 1 }
    Say '  已关闭全部。'
    exit 0
  }

  # ── restart ──────────────────────────────────────────────────────────────────
  # ★ 下列会**把桥接带下去**的分支在真跑之前都盖一次"已知启动窗口"的章（all / dsh / bridge）：
  #   随后的几秒里桥接没在监听是预期内的 —— 与 tools\starting-window.mjs 的 BRIDGE_DOWN_TARGETS
  #   一一对应（跨语言对不上的话，那边也有回归网）。`restart snowluma` / `restart control`
  #   全程不碰桥接 ⇒ 不盖章（它们本来就不该让桥接的灯灭一下）。
  'restart' {
    # ★★ 2026-09-26（P1，小舵拍板走"分离进程 ＋ 立刻回执"）：**QQ 不在本机时的"重起 DSH"** ——
    #   restart dsh 与 restart all 共用**这一份**（不在这里各写一遍，更不另写起法）。
    #   · 为什么必须分离：这一按会把**面板所在的 DSH** 一起停掉（控制面活着，但页面会断）⇒ 同步跑，回执
    #     就发不出去 —— 与 restart-stack 那条同一个理由。
    #   · 两个动作**都不另写**：停 = 现成的 tools\stop-all.ps1 -OnlyDsh；起 = 现成的 tools\dsh-only.ps1。
    #   · 它**绝不会**碰 SnowLuma / 桥接（判据：:3000 / :3001 按下去前后仍不在听、:3100 的 pid 不变）。
    $dshRestartNotLocal = {
      $exe = 'powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File'
      $inner = $exe + ' "' + (Join-Path $Root 'tools\stop-all.ps1') + '" -OnlyDsh & ' + $exe + ' "' + (Join-Path $Root 'tools\dsh-only.ps1') + '"'
      Say '  这一代 = 分离进程跑：tools\stop-all.ps1 -OnlyDsh → tools\dsh-only.ps1（**只重起 DSH**；桥接 / SnowLuma / 控制面一律不碰）。'
      Say '  ⚠ 会断开正在用的 DSH 会话（新一代起来时窗口自己会补控制面）。'
      if ($DryRun) { Say ('  [DryRun] 只打印，不会真拉：cmd.exe /d /c ' + $inner); return 0 }
      Set-StartingStamp 'restart'
      $p = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $inner) -WindowStyle Hidden -PassThru
      Say ('  [回执] 已发起（pid {0}，{1}）—— 本进程立刻返回，DSH 会在十几秒内换一代。' -f $p.Id, [DateTime]::Now.ToString('HH:mm:ss'))
      return 0
    }
    switch ($t) {
      'all' {
        # ★ 2026-09-26：QQ 不在本机 ⇒ 本机「全部」就只剩 DSH ⇒ 走**只开 DSH 那个入口**（绝不经过 start-all）。
        if (Test-QqServicesNotLocal) {
          # QQ 不在本机 ⇒ 本机"全部"就只剩 DSH ⇒ 与 restart dsh **同一条**（共用上面那一份，不写第二遍）。
          Say '  restart all = 本机只有 DSH（QQ 那套不在本机）⇒ 与 restart dsh 同一条。'
          $rc = & $dshRestartNotLocal
        } else {
          Say '  restart all = tools\start-all.ps1（先清场，再起三件套；DSH 正在用的会话会断）。'
          Set-StartingStamp 'restart'
          $rc = Invoke-Ps1 'start-all.ps1'
        }
      }
      'dsh' {
        # ★ 2026-09-26：`-NoClean` 只是「不清场」，它照样会把**没在听**的 SnowLuma / 桥接起出来 ⇒
        #   QQ 不在本机时禁用（那就是抢号）。改走只开 DSH 那个入口。
        if (Test-QqServicesNotLocal) {
          $rc = & $dshRestartNotLocal
        } else {
          Say '  restart dsh = tools\start-all.ps1 -NoClean（只重启 DSH，SnowLuma 与桥接留着不动）。'
          Set-StartingStamp 'restart'
          $rc = Invoke-Ps1 'start-all.ps1' @('-NoClean')
        }
      }
      'bridge' {
        try { $status = Get-OpsStatus } catch { Say "  [错误] $($_.Exception.Message)"; exit 4 }
        $bridgeUp = $false
        foreach ($p in @($status.ports)) { if ($p.key -eq 'bridge') { $bridgeUp = [bool]$p.open } }
        Set-StartingStamp 'restart'
        if ($bridgeUp) {
          Say '  桥接在跑 → 走它的重启接口（node tools\ops.mjs restart-bridge；守护会把它拉回来）。'
          $rc = Invoke-Node 'ops.mjs' @('restart-bridge')
        } else {
          Say '  桥接不在跑 → tools\ensure-bridge.ps1（先同步 DSH 令牌，再照启动器的方式拉起来）。'
          $rc = Invoke-Ps1 'ensure-bridge.ps1'
        }
      }
      'snowluma' {
        # 2026-09-24（P1④ 那批）：stop-all.ps1 补了 -OnlySnowLuma（复用它的端口→进程识别与自保），
        # 这里于是有了现成执行体 —— 一行"只杀 SnowLuma"的新识别逻辑都不用写（§3.1 的硬约束）。
        Say '  restart snowluma = 先 tools\stop-all.ps1 -OnlySnowLuma，再 tools\start-all.ps1 -NoRestart（只把它起回来）。'
        Say '  ⚠ 它的 WebUI 登录令牌只存在内存里：重起之后管理页那个标签会失效、要重新登录（随后会自动重载自动登录页）。'
        $rc = Invoke-Ps1 'stop-all.ps1' @('-OnlySnowLuma')
        if ($rc -eq 0) {
          Say '  已停（DSH 与桥接没动）→ 现在只把 QQ 网关起回来。'
          $rc = Invoke-Ps1 'start-all.ps1' @('-NoRestart')
        }
      }
      'control' {
        # 2026-09-24（主人实测发现的缺口）：控制面 = tools\control-server.mjs 的**独立进程**（:3101）：
        # 由 start-all.ps1 起、stop-all.ps1 的清理表里也有它，但**重起桥接不会重起它**
        # （两者没有任何父子/守护关系）。于是改完控制面代码（比如动作目录）以前只能全量重启、
        # 把正在用的 DSH 会话一起打断 —— 这个 target 就是补那个缺口。
        # ★ 启动命令**不在这里另写一份**：**唯一起法**是 tools\control-plane.ps1（2026-09-26 收口）——
        #   QQ 不在本机时走它（只起控制面，绝不碰 SnowLuma / 桥接）；QQ 在本机时仍走 start-all -NoRestart
        #   ⇒ 那也还是启动器里那**同一条**。
        $ctlNotLocal = Test-QqServicesNotLocal
        if ($ctlNotLocal) {
          Say '  restart control = 先 tools\stop-all.ps1 -OnlyControl，再 tools\control-plane.ps1 -CpEnsure（**只把控制面起回来**）。'
        } else {
          Say '  restart control = 先 tools\stop-all.ps1 -OnlyControl，再 tools\start-all.ps1 -NoRestart -NoOpen（只把控制面起回来）。'
        }
        Say '  ⚠ 它跟三件套没有父子/守护关系：重起它只让页面面板灰十几秒，QQ 链路与 DSH 会话都不受影响。'
        $rc = Invoke-Ps1 'stop-all.ps1' @('-OnlyControl')
        if ($rc -eq 0) {
          Say '  已停（DSH / 桥接 / SnowLuma 全程没动）→ 现在只把控制面起回来。'
          if ($ctlNotLocal) {
            $rc = Invoke-Ps1 'control-plane.ps1' @('-CpEnsure')
          } else {
            $rc = Invoke-Ps1 'start-all.ps1' @('-NoRestart', '-NoOpen')
          }
        }
      }
    }
    if ($rc -ne 0) { Say "  [失败] 退出码 $rc"; exit 1 }
    Say '  完成。接着看：control.ps1 status'
    exit 0
  }

  # ── restart-stack：受令全量重启（"一条 HTTP 就能让整套停机再全量起来"）───────────────────
  # 主人 2026-09-25 原话：「首先是全量启动你们要能自己来做」—— 开发会话的沙箱**起不了全量重启**
  # （Start-Process 派出去的进程活不过那次工具调用）⇒ 让**控制面**（它不在沙箱里）去当那只手。
  # ★ 为什么必须"分离进程 + 立刻回执"：本分支的调用链是 control-server.mjs → 驱动 → 本进程，
  #   而启动器的第一步就是 stop-all.ps1 —— **它会把 control-server.mjs 一起关掉**。同步跑 = 发起
  #   的那个进程死在半路：回执永远发不出去，也没人知道重启到底有没有开始。
  # ★ single-flight：控制面会被这次重启杀掉 ⇒ 它的 lastAction 记账跟着没 ⇒ 闸只能落在**盘上**；
  #   标记的路径与过期口径来自动作目录的 http.busyGuard，本脚本**不另写一份**。
  'restart-stack' {
    $guard = $null
    if ($act.http -and $act.http.busyGuard) { $guard = $act.http.busyGuard }
    $markerRel = ''
    if ($guard -and $guard.marker) { $markerRel = [string]$guard.marker }
    $markerFile = ''
    if ($markerRel) { $markerFile = Join-Path $Root $markerRel }
    $maxAgeMs = 300000
    if ($guard -and [int]$guard.maxAgeMs -gt 0) { $maxAgeMs = [int]$guard.maxAgeMs }
    $plan = 'stop-all → start-all'
    if ($act.http -and $act.http.receipt -and $act.http.receipt.plan) { $plan = [string]$act.http.receipt.plan }
    # ★ 2026-09-26（P1）：QQ 那套不在本机 ⇒ 本机**没有「全量」可重启**（本机只剩 DSH），而 一键启动.cmd
    #   会把 SnowLuma 与桥接起出来 ⇒ **抢号** ⇒ 这里 fail-closed 拒绝（退出码 6），并把该走的路说清楚。
    #   为什么不是「改成跑只开DSH.cmd」：那条入口见 DSH 在跑就退出（不先停）⇒ 会变成**假重启**（比拒绝更坏）。
    if (Test-QqServicesNotLocal) {
      Say '  [拒绝] QQ 那套不在本机（搬家之后 / 只开 DSH 模式）⇒ 本机没有「全量」可重启，而 一键启动.cmd 会把'
      Say '         SnowLuma 与桥接起出来 ⇒ **抢号**（服务器上那只会被顶下线）。这一步不做（退出码 6）。'
      Say '  该走的路：① 面板「重起控制面」（只动 :3101）② DSH-Web 窗口里按 r（重起 DSH，那一代会自动补控制面）'  # port-literal-ok: 拒绝理由的文案里提到面板端口，不是配置来源（端口一律走 env-config.ps1）
      Say '           ③ DSH 没在跑时双击 只开DSH.cmd。'
      exit 6
    }
    $launcher = Join-Path $Root '一键启动.cmd'

    # 触发者身份：★ 2026-09-25 协调线硬要求 —— 今晚那场"DSH 反复换代"卡住的就这一格
    # （`launcher-windows.log` / `.launcher-state.json` 只证明"启动器哪几秒跑过"，查不出是谁触发的）。
    $chain = @(Get-TriggerChain)
    $viaPath = Get-TriggerPath $chain
    # HTTP 那一侧是谁在敲门（控制面在 spawn 前塞进环境变量；命令行那条路没有 ⇒ 留空，不猜）
    $httpCaller = ''
    try { if ($env:DSH_CONTROL_TRIGGER) { $httpCaller = [string]$env:DSH_CONTROL_TRIGGER } } catch { }

    # 闸现在的状态：干跑也要如实说，但**干跑不被它拦住**（干跑的用处是"看清会做什么"）。
    $heldAgeMs = $null
    if ($markerFile -and (Test-Path -LiteralPath $markerFile)) {
      try { $heldAgeMs = [int]([DateTime]::UtcNow - (Get-Item -LiteralPath $markerFile).LastWriteTimeUtc).TotalMilliseconds } catch { $heldAgeMs = $null }
      # ⚠ 负龄当 0（**不是**当"没有"）：Windows 的 mtime 有 tick 粒度，刚写出来的标记可能比"现在"
      #   还新几毫秒 —— 严格判 `-ge 0` 会把刚发起的那一次放过去（2026-09-25 HTTP 面实测漏过一次 409）。
      if ($null -ne $heldAgeMs -and $heldAgeMs -lt 0) { $heldAgeMs = 0 }
    }
    $heldFresh = ($null -ne $heldAgeMs -and $heldAgeMs -le $maxAgeMs)

    if ($DryRun -and $heldFresh) {
      Say ('  [DryRun 提示] 盘上有个**新鲜**的闸标记（{0} 秒前）⇒ 真跑这一次会被拒（退出码 5）。' -f [int]($heldAgeMs / 1000))
    }

    # 闸：标记还在窗口内 ⇒ 这一次**不做**（退出码 5 = 被闸拒，不是失败）；-Force 越过它。
    if (-not $DryRun -and $markerFile -and -not $Force -and $heldFresh) {
      $ageMs = $heldAgeMs
      $rid = ''
      try { $rid = [string](Get-Content -LiteralPath $markerFile -Raw -Encoding UTF8 | ConvertFrom-Json).requestId } catch { }
      $extra = ''
      if ($rid) { $extra = "，requestId $rid" }
      Say ('  [没做] 已经有一次全量重启在飞：标记 {0}（{1} 秒前发起{2}）' -f $markerRel, [int]($ageMs / 1000), $extra)
      Say '         发起即返回 ⇒ 它跑完（启动器把三件套起齐后会删掉这个标记）或过了窗口才放行第二次。'
      Say '         确实要现在再来一次：加 -Force（或双击 tools\restart-stack-now.cmd —— 它就是干这个的）。'
      Write-RestartLedger ([ordered]@{
        at = [System.DateTimeOffset]::Now.ToString('yyyy-MM-ddTHH:mm:sszzz'); event = 'refused-busy'
        action = 'restart-stack'; path = $viaPath; caller = $chain; httpCaller = $httpCaller; force = [bool]$Force
        heldRequestId = $rid; heldAgeMs = [int]$ageMs
      })
      exit 5
    }
    if ($null -ne $heldAgeMs -and -not $heldFresh) {
      Say ('  [提示] 盘上那个标记已经过期（{0} 秒前）—— 当没有，继续。' -f [int]($heldAgeMs / 1000))
    }

    Say ('  restart-stack = 分离进程跑 {0}（{1}）—— 发起即返回，本进程不跟着一起等。' -f $launcher, $plan)
    Say '  ⚠ 它把 DSH / 桥接 / SnowLuma 全量重起：正在用的 DSH 会话会断（起来后启动器会自己唤醒各条线）。'
    if ($DryRun) { Say '  [DryRun] 只打印：不会写标记、不会拉启动器。'; exit 0 }
    if (-not $markerFile) { Say '  [错误] 动作目录没给 http.busyGuard.marker —— 没有它就谈不上 single-flight'; exit 4 }
    if (-not (Test-Path -LiteralPath $launcher)) { Say "  [错误] 找不到启动器：$launcher"; exit 4 }

    $requestId = 'rs-' + [DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '-' + (Get-Random -Minimum 1000 -Maximum 9999)
    # 先落标记、再拉启动器：**顺序不能反** —— 回执发出去之前标记必须已经在盘上，否则第二次请求会从窗口里溜进来。
    try {
      $dir = Split-Path -Parent $markerFile
      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
      $rec = [ordered]@{
        acceptedAt = [System.DateTimeOffset]::Now.ToString('yyyy-MM-ddTHH:mm:sszzz')
        requestId  = $requestId
        plan       = $plan
        by         = 'control.ps1 restart-stack'
        launcher   = '一键启动.cmd'
        force      = [bool]$Force
      }
      [System.IO.File]::WriteAllText($markerFile, (ConvertTo-Json $rec -Compress), $Utf8NoBom)
    } catch {
      Say "  [错误] 写不了并发闸标记（$markerFile）：$($_.Exception.Message)"
      Say '         没有它就没有 single-flight —— 宁可这次不做，也不放一个闸坏掉的重启入口出去。'
      exit 4
    }

    # ★ 调用方标签（2026-09-25 晚加，治"账本里 `caller:[]` ⇒ 谁也查不出是谁起的"）：受认可的调用方
    #   **显式带值**，启动器把它连同父进程链一起写进 `launcher-boot.jsonl`；读不到就记 `unattributed`。
    #   ⚠ 已经有人设过就**不覆盖**：`tools\restart-stack-now.cmd`（主人亲手按的那条兜底路）会先设
    #     `owner-dblclick`，它比这里推断得准。
    try {
      if (-not $env:DSH_LAUNCHER_CALLER) {
        $tag = ''
        if ($httpCaller) {
          $who = ''
          try { $who = [string](($httpCaller | ConvertFrom-Json).session) } catch { }
          if (-not $who) { try { $who = [string](($httpCaller | ConvertFrom-Json).origin) } catch { } }
          if (-not $who) { $who = 'unknown' }
          $tag = 'control-http:' + $who
        } elseif ($viaPath -match 'restart-stack-now') {
          $tag = 'owner-dblclick'
        } else {
          $tag = 'cli:' + [string]$env:USERNAME
        }
        $env:DSH_LAUNCHER_CALLER = $tag
        Say ("  [标签] 这次是谁在敲：{0}" -f $tag)
      }
    } catch { }

    # 分离进程：cmd /d /c "<启动器>" 1（1 = 菜单里的"全部启动"，与主人双击选 1 是同一条路）
    $proc = $null
    try {
      $proc = Start-Process -FilePath $env:ComSpec -ArgumentList @('/d', '/c', $launcher, '1') -WorkingDirectory $Root -PassThru
    } catch {
      Say "  [错误] 拉启动器失败：$($_.Exception.Message)"
    }
    if (-not $proc) {
      # 没拉起来就把标记撤掉：闸是为"真在飞"设的，一个没生效的标记会把入口白锁 5 分钟。
      try { Remove-Item -LiteralPath $markerFile -Force -ErrorAction SilentlyContinue } catch { }
      Say '  [错误] 启动器没拉起来（标记已撤，可以直接重试）。'
      Write-RestartLedger ([ordered]@{
        at = [System.DateTimeOffset]::Now.ToString('yyyy-MM-ddTHH:mm:sszzz'); event = 'spawn-failed'
        action = 'restart-stack'; path = $viaPath; caller = $chain; httpCaller = $httpCaller; requestId = $requestId; plan = $plan
      })
      exit 1
    }

    # ★ 触发账本：谁、什么时候、走哪条路、结果（协调线 2026-09-25 硬要求；与上面 ① 那行配对）。
    Write-RestartLedger ([ordered]@{
      at = [System.DateTimeOffset]::Now.ToString('yyyy-MM-ddTHH:mm:sszzz'); event = 'accepted'
      action = 'restart-stack'; path = $viaPath; caller = $chain; httpCaller = $httpCaller
      requestId = $requestId; plan = $plan; force = [bool]$Force
      launcherPid = $proc.Id; marker = $markerRel
    })

    $receipt = [ordered]@{
      ok          = $true
      accepted    = $true
      action      = 'restart-stack'
      requestId   = $requestId
      plan        = $plan
      launcherPid = $proc.Id
      marker      = $markerRel
      at          = [System.DateTimeOffset]::Now.ToString('yyyy-MM-ddTHH:mm:sszzz')
    }
    if ($Json) {
      Write-Output (ConvertTo-Json $receipt -Compress)
    } else {
      Say ('  回执：已受理 requestId={0}（启动器进程 {1}）—— 接着它自己跑：先清场，再起三件套。' -f $requestId, $proc.Id)
      Say ('         看进度：control.ps1 status；并发闸标记：{0}（起齐后启动器会删掉它）' -f $markerRel)
    }
    exit 0
  }

  # ── pages：唯一的"开页面者"是 panels.ps1（本脚本只传话）────────────────────────────
  'pages' {
    switch ($t) {
      'open' {
        $extra = @()
        if (@($Pages).Count -gt 0) { $extra += @('-Pages', (@($Pages) -join ',')) }
        if (@($ForcePage).Count -gt 0) { $extra += @('-ForcePage', (@($ForcePage) -join ',')) }
        if ($OwnWindow) { $extra += '-OwnWindow' }
        $rc = Invoke-Ps1 'panels.ps1' (@('open') + $extra)
      }
      'close' { $rc = Invoke-Ps1 'panels.ps1' @('close') }
      'wake' {
        Say '  wake = 把已有窗口叫到前台（**不开页、不关窗**；浏览器不给外部脚本切标签的 API）。'
        $rc = Invoke-Ps1 'panels.ps1' @('wake')
      }
    }
    if ($rc -ne 0) { Say "  [失败] 退出码 $rc"; exit 1 }
    exit 0
  }

  # ── login ────────────────────────────────────────────────────────────────────
  'login' {
    switch ($t) {
      'qq' {
        # ① 换令牌：登录脚本只拿令牌、不开页面（-NoOpen），页面统一由 panels.ps1 开。
        $rc = Invoke-Ps1 'snowluma-login.ps1' @('-NoOpen')
        if ($rc -ne 0) {
          Say "  [失败] 换令牌没成功（snowluma-login.ps1 退出码 $rc）："
          switch ($rc) {
            2 { Say '         还没存过 SnowLuma 密码 → 先跑一次：powershell -File tools\snowluma-login.ps1 -SavePassword' }
            3 { Say '         密码被拒绝（SnowLuma 里改过密码？）→ 重新存一次：-SavePassword' }
            4 { Say "        连不上 SnowLuma（$SnowLumaWebPort 没在监听）→ 先起服务：control.ps1 up（或 一键启动.cmd）" }
            5 { Say '         登录接口没返回令牌（可能开了两步验证 TOTP，只能手动登录）。' }
            default { Say '         细节看上面那几行输出。' }
          }
          exit 1
        }
        # ② 把页面开出来。**必须 -ForcePage**：SnowLuma 的令牌表在内存里，旧标签里的令牌已经失效，
        #    只有重新加载 snowluma-autologin.html 才能把新令牌写进浏览器（否则页面一直问密码）。
        $rc = Invoke-Ps1 'panels.ps1' @('open', '-Pages', 'snowluma', '-ForcePage', 'snowluma')
        if ($rc -ne 0) { Say "  [提示] 页面没开成（panels.ps1 退出码 $rc）；可以手动开 http://127.0.0.1:$SnowLumaWebPort"; exit 1 }
        Say '  完成：令牌已换、管理页已开（浏览器里不该再问密码了）。'
      }
      'console' {
        # 控制台令牌是**持久**的（Cookie 一年），所以不强制重开：检测到已开着就跳过、由主人 F5。
        try { $status = Get-OpsStatus } catch { Say "  [错误] $($_.Exception.Message)"; exit 4 }
        $bridgeUp = $false
        foreach ($p in @($status.ports)) { if ($p.key -eq 'bridge') { $bridgeUp = [bool]$p.open } }
        if (-not $bridgeUp) {
          Say '  桥接不在跑 → 先 tools\ensure-bridge.ps1（同步令牌 + 拉起来），否则控制台页打不开。'
          $rc = Invoke-Ps1 'ensure-bridge.ps1'
          if ($rc -ne 0) { Say "  [失败] ensure-bridge.ps1 退出码 $rc"; exit 1 }
        }
        $rc = Invoke-Ps1 'panels.ps1' @('open', '-Pages', 'console')
        if ($rc -ne 0) { Say "  [提示] 页面没开成（panels.ps1 退出码 $rc）；可以手动开 http://127.0.0.1:$BridgePort"; exit 1 }
        Say '  完成：控制台页已带令牌开出来（刷新也不用再输令牌）。'
      }
    }
    exit 0
  }

  # ── logs：只读，直接走 ops.mjs 的 tail（它自己会做行长截断）──────────────────────────
  # -Json 版给页面面板用：包的还是 node tools\ops.mjs logs（同一份来源），只是把
  # Invoke-Step 那圈"命令行回显 + 退出码"的包装去掉，免得面板的"最近 20 行"被吃掉 3 行。
  'logs' {
    if ($Json) {
      $r = Invoke-CaptureUtf8 $NodeExe @((Join-Path $Tools 'ops.mjs'), 'logs', $t, [string]$Tail)
      $text = ($r.StdOut -replace "`r`n", "`n").TrimEnd()
      $payload = [ordered]@{
        action = 'logs'
        source = "node tools\ops.mjs logs $t $Tail"
        ok     = ($r.ExitCode -eq 0)
        which  = $t
        tail   = $Tail
        text   = $text
      }
      if ($r.ExitCode -ne 0) { $payload['error'] = $r.StdErr.Trim() }
      Write-Output (ConvertTo-Json $payload -Depth 4)
      exit $(if ($r.ExitCode -eq 0) { 0 } else { 1 })
    }
    $rc = Invoke-Node 'ops.mjs' @('logs', $t, [string]$Tail)
    if ($rc -ne 0) { exit 1 }
    exit 0
  }

  # ── doctor：精简自检（= self-check，只读）───────────────────────────────────────────
  'doctor' {
    Say '  doctor = node tools\self-check.mjs（运行时 / 启动链 / preset / 文档 / 结构不变量 / 日志健康）'
    $rc = Invoke-Node 'self-check.mjs'
    if ($rc -ne 0) { Say "  [注意] 自检退出码 $rc：有失败项，看上面的 ❌"; exit 1 }
    Say '  自检通过（0 失败；警告项看上面）。'
    exit 0
  }
}

Fail-Usage "不认识的动作用法"
