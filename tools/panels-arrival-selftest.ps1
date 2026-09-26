<#
  panels-arrival-selftest.ps1 —— 开页三态收据的**四条判据**（2026-09-26，执行线 30721fa8 第四代）

  为什么单独一个脚本而不是塞进 panels-check.ps1：
    · panels-check 是**离线静态**检查（起替身进程 + 读源码），不碰真浏览器；
    · 这四条判据里 ②③④ 要**真的起一个 Edge（独立 --user-data-dir + --headless=new）**才有真环境，
      属于另一类证据 ⇒ 分开、**能单独复跑**、跑完自己收场。

  ★★ 四条硬边界（协调线 2026-09-26 裁定；一条都不许破）：
    1. **不碰主人的浏览器/台账**：本脚本给 panels.ps1 必带四下闸 ——
       `-NoOpenFallback`（一次都不许把开页请求交给系统默认浏览器）
       `-FakeBrowser <node.exe>`（"起浏览器"这一步用**无副作用替身**，绝不真起 Edge）
       `-LedgerFile <自己 %TEMP% 里的文件>`（**根本不碰**生产台账）
       `-DeadPorts`（夹具确定地造"调试口不在听"，不去关别人真在听的调试口）；
    2. 自造的 Edge 一律 **独立 --user-data-dir ＋ 独立端口（923x）**，**收尾只杀自己那一个 pid**（不用 /T），
       并删掉自己的 profile 目录；
    3. **不起任何服务**（不跑 一键启动.cmd / start-all / stop-all / 重启 DSH）；
    4. 无窗口：自造的 Edge 都是 `--headless=new`。

  自证（跑完会打出来）：生产台账 `qq-bridge\state\panel-opened.json` 自测前后的 **SHA256 一字未变**。

  用法：powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels-arrival-selftest.ps1
  可选：-CdpPort <端口>（自造实例用）· -DeadPort <端口>（造"不在听"）—— **默认 0 = 自动选**：
        ★ 端口**不在这里写死**（P2⑦ 参数单一来源：一个值只能有一处定义；自检的"端口字面量棘轮"
        会拦新增的硬编码端口）。自动选法 = 从 9310 起找一个**既没人听、也不在 agent.config.json
        端口表里**的号；这样它跟主人的 :9223 与既有服务都不会撞。
#>
[CmdletBinding()]
param(
  [int]$CdpPort = 0,
  [int]$DeadPort = 0,
  # ★ **默认不起任何浏览器实例**（2026-09-26 协调线叫停后定的默认值）：
  #   本项目的开发会话跑不了真实例（受限沙箱里 headless Edge 起不来），而"起/关浏览器"本身
  #   在主人机器上是有代价的动作（弹框骚扰）。⇒ 要跑判据②③④ 那条**真环境**分支才显式加它：
  #     powershell -File tools\panels-arrival-selftest.ps1 -WithBrowser
  #   不加它时判据②③④ 记 **SKIP**（并打印"沙箱外怎么跑"），**不冒充通过也不冒充失败**。
  [switch]$WithBrowser
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'env-config.ps1')
$Ports = Get-AgentPorts
$DsPort = $Ports.dshWeb

# ── 端口：**自动选，不写死**（见 param 段那条注释）────────────────────────────────────────
# 为什么需要这一小段：自检有一条"端口字面量棘轮"（P2⑦ 参数单一来源）——**新增硬编码端口会被判红**，
# 而夹具的调试口本来就该是个"没人用的号"。所以：从一个安全起点起，挑**既没人听、也不在
# agent.config.json 端口表里**的号；这样既过自检，也永远不会跟主人的 :9223 或既有服务撞。
function Test-PortListening([int]$P) {
  try { $l = netstat -ano | Select-String 'LISTENING' | Select-String ":$P\b"; return (@($l).Count -gt 0) } catch { return $false }
}
function Get-FreePort([int]$From, [int[]]$Busy) {
  for ($p = $From; $p -lt ($From + 60); $p++) { if (-not (Test-PortListening $p) -and ($Busy -notcontains $p)) { return $p } }
  return $From
}
$knownPorts = @($Ports.PSObject.Properties | ForEach-Object { [int]$_.Value })
if ($CdpPort -lt 1024) { $CdpPort = Get-FreePort -From 9310 -Busy $knownPorts }
if ($DeadPort -lt 1024) { for ($p = $CdpPort + 1; $p -lt ($CdpPort + 60); $p++) { if (-not (Test-PortListening $p) -and ($knownPorts -notcontains $p)) { $DeadPort = $p; break } } }

$Panels = Join-Path $PSScriptRoot 'panels.ps1'
$ProdLedger = Join-Path $Root 'qq-bridge\state\panel-opened.json'
$Cli = Join-Path $PSScriptRoot 'panels-refresh.mjs'
$NodeExe = (Get-Command node -ErrorAction Stop).Source
$SelfTmp = Join-Path $env:TEMP 'panels-arrival-selftest'
if (Test-Path -LiteralPath $SelfTmp) { Remove-Item -LiteralPath $SelfTmp -Recurse -Force -ErrorAction SilentlyContinue }
New-Item -ItemType Directory -Force -Path $SelfTmp | Out-Null
$SelfLedger = Join-Path $SelfTmp 'panel-opened.json'

$results = @()
function Note([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function T([string]$name, [string]$detail) { Write-Host ("  [{0}] {1}" -f $name, $detail) }
function Add-Result([string]$name, [bool]$pass, [string]$detail) {
  $script:results += [pscustomobject]@{ Name = $name; Pass = $pass; Detail = $detail }
  $col = if ($pass) { 'Green' } else { 'Red' }
  $tag = if ($pass) { 'PASS' } else { 'FAIL' }
  Write-Host ("  => [{0}] {1}：{2}" -f $tag, $name, $detail) -ForegroundColor $col
}
function Get-Sha([string]$p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash } else { '(不存在)' } }

# ── 外部对照（**不复用 panels.ps1 的判据**，自己读一遍 CDP 清单/探针）────────────────────
function Get-CdpList([int]$Port) {
  try {
    $raw = & node $Cli 'list' '--port' ([string]$Port) 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { return $null }
    $line = ($raw.Trim() -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if (-not $line) { return $null }
    $o = $line | ConvertFrom-Json
    if (-not $o.ok) { return $null }
    return $o
  } catch { return $null }
}
function Test-ListHasUrl([int]$Port, [string]$Url) {
  $o = Get-CdpList -Port $Port
  if (-not $o) { return $false }
  $auth = ''
  try { $auth = ([uri]$Url).Authority } catch { }
  if (-not $auth) { return $false }
  return (@($o.targets | Where-Object { $_.url -like "*$auth*" }).Count -gt 0)
}
function Get-ProbeHref([int]$Port, [string]$Match) {
  try {
    $raw = & node $Cli 'probe' '--port' ([string]$Port) '--match' $Match 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { return $null }
    $line = ($raw.Trim() -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if (-not $line) { return $null }
    $o = $line | ConvertFrom-Json
    if (-not $o.ok) { return $null }
    return @($o.probed | Select-Object -First 1)
  } catch { return $null }
}

# ── 造态：独立 user-data-dir + headless 起一个 Edge（无窗口；跟主人的实例互不相干）──────────
function Start-HeadlessEdge([int]$Port, [string[]]$Urls, [string]$ProfileDir) {
  $browser = $null
  foreach ($c in @(
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    )) { if ($c -and (Test-Path -LiteralPath $c)) { $browser = $c; break } }
  if (-not $browser) { throw '找不到 Edge/Chrome 可执行文件（本机现状）' }
  if (-not (Test-Path -LiteralPath $ProfileDir)) { New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null }
  $argz = @('--headless=new', "--user-data-dir=$ProfileDir", "--remote-debugging-port=$Port",
    '--remote-allow-origins=*', '--no-first-run', '--no-default-browser-check', '--disable-extensions') + $Urls
  # ★ 红线 6（协调线 2026-09-26 拿主人截图点的）：**子进程的 stdout/stderr 一律收进文件**，
  #   绝不让它漏到控制台/主人桌面（Edge 会喷 `Failed to grant sandbox access …`，无害但吓人）。
  $logOut = Join-Path $ProfileDir 'edge-stdout.txt'
  $logErr = Join-Path $ProfileDir 'edge-stderr.txt'
  return Start-Process -FilePath $browser -ArgumentList $argz -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $logOut -RedirectStandardError $logErr
}
# 调试口活了没（自造实例的"就绪"判据 = **端口在听** ＋ **CLI 拿得到清单**）。
# ⚠ 不用 `Invoke-WebRequest`：它在受限沙箱里不稳（实测把可用实例判成"没就绪"），
#   而这里要的就是"在听"这个事实 —— netstat 读数 ＋ 我们自己的 list 命令，两层都过才算就绪。
function Test-PortUp([int]$Port) {
  if (-not (Test-PortListening $Port)) { return $false }
  return [bool](Get-CdpList -Port $Port)
}
# ── 收尾：★★ **一律优雅关闭**（2026-09-26 协调线裁定，主人被弹框骚扰两次后写死）──────────
# 铁律（别再改回去）：
#   · **禁止** `taskkill /F`、`Stop-Process -Force`、`/T` 递归杀 —— 对 Chromium 进程**必然弹框**
#     （`msedge.exe - 应用程序错误 · unknown software exception (0x80000003)`，还会拉起
#      `Choose Just-In-Time Debugger`）；
#   · **只许优雅关闭**：走 CDP 的 `Browser.close`（`panels-refresh.mjs close --port <自己的端口>`）
#     —— 那是浏览器自己支持的退出路径（等于点了关闭），不走崩溃处理器；
#   · 超时才降级，降级**先 `taskkill`（不带 /F）**；只有它也没成，才允许 `/F`（并必须**出声**记一笔）。
# 判据：跑完桌面上**不许出现任何新窗口/新对话框**（对外层的"跑前跑后窗口数对照"负责）。
function Stop-Mine($Proc, [string]$ProfileDir) {
  # ① 优雅：请浏览器自己退（它已经在听调试口才可能成功；连不上 ⇒ 它多半已经退了）
  $closed = $false
  if (Test-PortListening $CdpPort) {
    try {
      $raw = & node $Cli 'close' '--port' ([string]$CdpPort) 2>&1 | Out-String
      $line = ($raw.Trim() -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
      if ($line) { $o = $line | ConvertFrom-Json; $closed = [bool]$o.closed }
      T '收场' ("优雅关闭（CDP Browser.close）＝ {0}" -f $closed)
    } catch { T '收场' "优雅关闭没能发出去：$($_.Exception.Message)" }
  } else { T '收场' '调试口已不在听 ⇒ 它已经退了（无需关闭）'; $closed = $true }
  # ② 等它自己退干净（最多 ~8 秒）
  if (-not $closed) {
    for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 400; if (-not (Test-PortListening $CdpPort)) { $closed = $true; break } }
  }
  # ③ 降级：**不带 /F** 的 taskkill（只是"请它退"，不是强杀）
  if (-not $closed -and $Proc) {
    try { & taskkill /PID $Proc.Id 2>&1 | Out-Null } catch { }
    for ($i = 0; $i -lt 15; $i++) { Start-Sleep -Milliseconds 400; if (-not (Test-PortListening $CdpPort)) { $closed = $true; break } }
    T '收场' ("降级：不带 /F 的 taskkill ⇒ 端口已放开 = {0}" -f $closed)
  }
  # ④ 最后手段（**必须出声**：这是我被明令禁止过的那条路，发生了就要留痕）
  if (-not $closed) {
    Say "  [警告] 优雅关闭与软 taskkill 都没成 ⇒ 不得已用 /F 强杀 pid $($Proc.Id)（**这会弹框**，已如实记账）"
    try { & taskkill /PID $Proc.Id /F 2>&1 | Out-Null } catch { }
    Start-Sleep -Seconds 1
  }
  Remove-Item -LiteralPath $ProfileDir -Recurse -Force -ErrorAction SilentlyContinue
}
# 起一个自造实例并等它就绪；**起不来就当场收掉**（绝不留孤儿 —— 上一轮那种"收不掉"就是这么来的）
function Start-HeadlessEdgeUp([int]$Port, [string[]]$Urls, [string]$ProfileDir, [int]$TryCount = 3) {
  for ($a = 1; $a -le $TryCount; $a++) {
    $p = Start-HeadlessEdge -Port $Port -Urls $Urls -ProfileDir $ProfileDir
    for ($i = 0; $i -lt 24; $i++) { Start-Sleep -Milliseconds 500; if (Test-PortUp $Port) { return $p } }
    T '造态' ("第 {0} 次起的实例没就绪（pid={1}）⇒ 当场收掉再试" -f $a, $p.Id)
    Stop-Mine $p $ProfileDir
    Start-Sleep -Seconds 2
  }
  return $null
}

# ★★ 血泪注释（2026-09-26，白猜了两轮才抓到）：**别用空字符串当"位置参数占位"** ——
#   PowerShell 会把裸 `''` 当**空数组元素丢掉**，于是后面的 `-GateShortCircuit`/`-Port` 就**错位**
#   绑到位置参数上（实测证据：`judge2gate.log.argv.txt` 里 `-FakeBrowser` 拿到了 node.exe、
#   而 `-DryRun` 之后少了一个参数）。⇒ 凡"可选值"一律用**显式命名参数**传，别靠位置占位。
function Invoke-Panels([string[]]$Extra, [string]$LogName, [string]$FakeBrowserOverride = '', [switch]$GateShortCircuit, [int]$Port = 0, [int]$Dead = 0, [switch]$NoBrowser) {
  $log = Join-Path $SelfTmp $LogName
  $sharedLog = Join-Path $Root 'qq-bridge\state\_tmp\panels.log'
  $before = 0
  if (Test-Path -LiteralPath $sharedLog) { $before = @(Get-Content -LiteralPath $sharedLog -Encoding UTF8).Count }
  if ($Port -le 0) { $Port = $CdpPort }
  if ($Dead -le 0) { $Dead = $DeadPort }
  # ★ 默认给替身（证明"闸不是靠替身兜的"）；`-NoBrowser` 用哨兵 none 造"这台机器上没有浏览器"。
  $fb = if ($NoBrowser) { 'none' } elseif ($FakeBrowserOverride) { $FakeBrowserOverride } else { $NodeExe }
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Panels, 'open',
    '-Pages', 'dsh', '-CdpPort', [string]$Port, '-DeadPorts', [string]$Dead,
    '-NoSystemOpen', '-FakeBrowser', $fb, '-LedgerFile', $SelfLedger,
    '-NoClose') + $Extra
  if ($GateShortCircuit) { $a += '-PanelGateShortCircuit' }
  $out = & powershell @a 2>&1 | Out-String
  $code = $LASTEXITCODE
  # ★ 落盘证据（排查用）：这一跑**到底传了什么 argv ＋ 打印了什么**一律留档 ——
  #   不靠"我以为我传了"：上一轮判据② 读数空、白猜两轮，就是缺这一层证据。
  try {
    @("### argv: $($a -join ' ')", "### exit: $code", "$out") |
      Set-Content -LiteralPath (Join-Path $SelfTmp "$LogName.argv.txt") -Encoding UTF8
  } catch { }
  $lines = @()
  if (Test-Path -LiteralPath $sharedLog) {
    $lines = @(Get-Content -LiteralPath $sharedLog -Encoding UTF8 | Select-Object -Skip $before |
      ForEach-Object { ($_ -replace '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[pid \d+\]\s*', '') })
  }
  # ⚠ `Say` 在 `-DryRun` 下**不写日志**（DryRun 不记账是有意的）⇒ 那种跑法的"说了什么"只能看 stdout。
  #   ★ 而且"增量不为 0"也可能只增了一两行（比如注入那一行）⇒ **不能**拿 `Count -eq 0` 当触发条件；
  #   正确做法是两边**并起来**（日志增量 ＋ stdout），否则 DryRun 的判据只拿到半截读数 = 假红。
  $fromOut = @()
  if ("$out".Trim()) { $fromOut = @($out -split "`r?`n" | Where-Object { $_.Trim() }) }
  $lines = @(@($lines) + @($fromOut) | Select-Object -Unique)
  $lines | Set-Content -LiteralPath $log -Encoding UTF8
  return [pscustomobject]@{ Out = $out; Code = $code; Lines = $lines; Log = $log }
}
function Get-SelfState([string]$Key) {
  if (-not (Test-Path -LiteralPath $SelfLedger)) { return $null }
  try {
    $o = (Get-Content -LiteralPath $SelfLedger -Raw -Encoding UTF8) | ConvertFrom-Json
    if (-not $o.states) { return $null }
    $s = $o.states.$Key
    if (-not $s) { return $null }
    return $s
  } catch { return $null }
}
function Test-Said([string[]]$Lines, [string]$Needle) { return (@($Lines | Where-Object { $_ -like "*$Needle*" }).Count -gt 0) }
# 记一条 SKIP（**不冒充通过、也不冒充失败**：跑不起来和跑出来是错的必须分开报）
function Add-Skip([string]$name, [string]$why) {
  Write-Host ("  [SKIP] {0} —— {1}" -f $name, $why) -ForegroundColor DarkYellow
}
# 一条判据一个端口（★ 上一轮 12 个实例全"没就绪"，最可疑的就是"两条判据抢同一个端口"）
$Port1 = Get-FreePort -From ($CdpPort + 10) -Busy $knownPorts
$Port2 = Get-FreePort -From ($Port1 + 1) -Busy $knownPorts
$Port3 = Get-FreePort -From ($Port2 + 1) -Busy $knownPorts
# 顶层窗口数（只读）—— 用来给"桌面没被弹东西"这条判据留对照读数
function Get-TopWindowCount { return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle }).Count }
$winBefore = Get-TopWindowCount

# ══════════════════════════════════════════════════════════════════════════════════════
Note ''
Note '=== 开页三态收据 · 四条判据（自测：独立端口 + 独立 user-data-dir + 四下闸，绝不碰主人的浏览器与台账）===' 'Cyan'
Note ("  本机端口：DSH=$DsPort ｜ 自造调试口=$CdpPort ｜ 造'不在听'的端口=$DeadPort")
Note ("  时间：{0}  ｜  浏览器替身（FakeBrowser）：{1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $NodeExe)
Note ("  自测台账（生产台账一个字节都不碰）：{0}" -f $SelfLedger)

$prodSha0 = Get-Sha $ProdLedger
Note ("  生产台账 SHA256（自测前）：{0}" -f $prodSha0)

# ═══ ① 调试口不在听 ⇒ initiated（自带"回退被闸住"读数）══════════════════════════════════
Note ''
Note '① 闸开 ⇒ 收据写 failed（开页动作整条不走；"零窗口弹出"的读数在这里）' 'White'
try {
  Remove-Item -LiteralPath $SelfLedger -Force -ErrorAction SilentlyContinue
  $r1 = Invoke-Panels @('-ForcePage', 'dsh') 'judge1.log' -Port $DeadPort -Dead $DeadPort
  $s1 = Get-SelfState 'dsh'
  T '读数' ("state={0} ｜ why={1}" -f $s1.state, $s1.why)
  $ok1 = ($s1 -and $s1.state -eq 'failed' -and "$($s1.why)" -like '*闸住*')
  Add-Result '① 闸住 ⇒ 收据 failed（开页动作整条不走）' $ok1 ("state=$($s1.state)；why $(if("$($s1.why)" -like '*闸住*'){'含'}else{'**不含**'})「闸住」")
  # ★★ 闸一（协调线 2026-09-26 的硬闸，语义 = **无条件**禁止系统开页）：三条读数一起给
  $g1 = Test-Said $r1.Lines '闸住'
  $g1b = Test-Said $r1.Lines '已把 1 个页面开进'
  $g1c = Test-Said $r1.Lines '交给默认浏览器'
  $win1 = Get-TopWindowCount
  T '闸读数' ("日志含「闸住」={0} ｜ **没有**「已把 N 个页面开进」行={1} ｜ 没有「交给默认浏览器」行={2} ｜ 顶层窗口数 {3} → {4}" -f $g1, (-not $g1b), (-not $g1c), $winBefore, $win1)
  Add-Result '①d ★ 闸一：无条件禁止系统开页（开闸时）' ($g1 -and (-not $g1b) -and (-not $g1c)) ("含闸住=$g1｜无开页行=$(-not $g1b)｜无回退行=$(-not $g1c)")
} catch { Add-Result '① 不在听 ⇒ initiated' $false "跑挂：$($_.Exception.Message)" }

# ═══ ①c ★ 回退闸 ＋ ①②③（协调线把语义改死之后的三条读数）═══════════════════════════════
Note ''
Note '①c 回退闸（把浏览器注入成"找不到"）⇒ 期望 failed + 出声"闸住" + 退出码非 0' 'White'
try {
  Remove-Item -LiteralPath $SelfLedger -Force -ErrorAction SilentlyContinue
  $r1c = Invoke-Panels @('-ForcePage', 'dsh') 'judge1c.log' -NoBrowser -Port $Port3
  $s1c = Get-SelfState 'dsh'
  T '读数' ("state={0} ｜ 退出码={1} ｜ why={2}" -f $s1c.state, $r1c.Code, $s1c.why)
  # ★ 闸住时收据的 why 是"开页被…闸住"（不再是"没找到浏览器"那种退化）
  $ok1c = ($s1c -and $s1c.state -eq 'failed' -and $r1c.Code -ne 0 -and "$($s1c.why)" -like '*闸住*')
  Add-Result '①c 闸住 ⇒ failed ＋ 退出码非 0' $ok1c ("state=$($s1c.state)｜退出码=$($r1c.Code)｜why 含「闸住」=$(("$($s1c.why)" -like '*闸住*'))")
} catch { Add-Result '①c 闸住 ⇒ failed ＋ 退出码非 0' $false "跑挂：$($_.Exception.Message)" }

Note ''
Note '闸·判据② 关闸对照（不传闸，只打印不执行）⇒ 回退路**确实会走**（证明闸是能关的开关、不是把功能改死）' 'White'
try {
  $r2g = Invoke-Panels @('-ForcePage', 'dsh', '-DryRun') 'judge2gate.log' -GateShortCircuit -Port $Port1 -NoBrowser
  $o2 = "$($r2g.Out)"
  $hit2 = @($o2 -split "`r?`n" | Where-Object { $_ -like '*退化成用默认浏览器*' } | Select-Object -First 1)
  T '读数' ("stdout 含「退化成用默认浏览器」= {0} ｜ 那行 =「{1}」｜ 退出码={2}" -f ($hit2.Count -gt 0), ($hit2 -join ''), $r2g.Code)
  # ⚠ 判据只看 **stdout**：`-DryRun` 下 `Say` 不写日志（DryRun 不记账是有意的），日志里本来就没有这行。
  $okGate2 = ($hit2.Count -gt 0)
  Add-Result '闸·判据② 关闸 ⇒ 回退路存在（且这跑不执行任何开页）' $okGate2 'DryRun 打印出「没找到 Edge/Chrome ⇒ 退化成用默认浏览器打开」⇒ 闸是能关的开关、不是把功能改死'
} catch { Add-Result '闸·判据② 关闸 ⇒ 回退路存在' $false "跑挂：$($_.Exception.Message)" }

Note ''
Note '闸·判据③ 空过对照（把闸判定短路成恒假 = 假装没这个闸）⇒ 上面那条判据必须判红' 'Yellow'
try {
  $r3g = Invoke-Panels @('-ForcePage', 'dsh', '-DryRun') 'judge3gate.log' -GateShortCircuit -Port $Port1
  $gateWord = Test-Said $r3g.Lines '闸住'
  T '读数' ("短路注入后：日志含「闸住」= {0}（期望 **False** ⇒ 证明是那行判据在起作用）" -f $gateWord)
  Add-Result '闸·判据③ 空过对照：短路后「闸住」必须消失' (-not $gateWord) '短路 → 不再出现「闸住」⇒ ①d 的绿灯确实来自那行判据（否则它恒真）'
} catch { Add-Result '闸·判据③ 空过对照' $false "跑挂：$($_.Exception.Message)" }

# ═══ ② 真环境：自造实例里真有 :3080 标签 ⇒ arrived ═════════════════════════════════════
Note ''
Note ("② 真环境（独立 user-data-dir + --headless=new 的 Edge 里真有 :{0}）⇒ 期望 arrived" -f $DsPort) 'White'
$prof2 = Join-Path $SelfTmp 'profile-arrived'
$proc2 = $null
try {
  if (-not $WithBrowser) {
    Add-Skip '② 有真 target ⇒ arrived' '本会话不起浏览器实例（默认；要跑真环境加 -WithBrowser，且只能在沙箱外）'
    throw [System.Management.Automation.RuntimeException]'SKIP'
  }
  $proc2 = Start-HeadlessEdgeUp -Port $Port1 -Urls @("http://127.0.0.1:$DsPort/") -ProfileDir $prof2
  if (-not $proc2) { throw "自造实例起不来（调试口 :$Port1 一直没就绪）" }
  $listed = $false
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (Test-ListHasUrl -Port $Port1 -Url "http://127.0.0.1:$DsPort/") { $listed = $true; break } }
  T '造态' ("headless Edge pid={0} ｜ 调试口 :{1} ｜ 清单里已有 :{2} 标签 = {3}" -f $proc2.Id, $Port1, $DsPort, $listed)
  if (-not $listed) { throw "自造实例起来了，但清单里一直没有 :$DsPort 这个标签（造态失败）" }
  Remove-Item -LiteralPath $SelfLedger -Force -ErrorAction SilentlyContinue
  $r2 = Invoke-Panels @('-ForcePage', 'dsh') 'judge2.log' '' -Port $Port1
  $s2 = Get-SelfState 'dsh'
  T '读数' ("state={0} ｜ why={1}" -f $s2.state, $s2.why)
  Add-Result '② 有真 target ⇒ arrived' ($s2 -and $s2.state -eq 'arrived') ("state=$($s2.state)")
} catch {
  if ("$($_.Exception.Message)" -ne 'SKIP') { Add-Result '② 有真 target ⇒ arrived' $false "跑挂：$($_.Exception.Message)" }
}
finally { Stop-Mine $proc2 $prof2 }

# ═══ ③ ★★ 空过对照：短路恒真 + 页面其实没到 ⇒ 外部对照必须当场判红 ═════════════════════
Note ''
Note '③ 空过对照（到达判据短路成"恒返回 arrived"，页面**其实没到**）⇒ 期望：外部对照抓到谎报' 'Yellow'
$prof3 = Join-Path $SelfTmp 'profile-fake'
$proc3 = $null
$r3 = $null
try {
  if (-not $WithBrowser) {
    Add-Skip '③ 空过对照被抓到' '本会话不起浏览器实例（默认；要跑真环境加 -WithBrowser）'
    throw [System.Management.Automation.RuntimeException]'SKIP'
  }
  $proc3 = Start-HeadlessEdgeUp -Port $Port2 -Urls @('about:blank') -ProfileDir $prof3
  if (-not $proc3) { throw "自造实例起不来（调试口 :$Port2 一直没就绪）" }
  $up = $false
  for ($i = 0; $i -lt 20; $i++) { Start-Sleep -Milliseconds 500; if (Get-CdpList -Port $Port2) { $up = $true; break } }
  T '造态' ("headless Edge pid={0}（只开 about:blank）｜ 调试口 :{1} ｜ 清单里有 :{2} 标签 = {3}" -f $proc3.Id, $Port2, $DsPort, (Test-ListHasUrl -Port $Port2 -Url "http://127.0.0.1:$DsPort/"))
  if (-not $up) { throw '自造实例的调试口没起来（造态失败）' }
  Remove-Item -LiteralPath $SelfLedger -Force -ErrorAction SilentlyContinue
  $r3 = Invoke-Panels @('-ForcePage', 'dsh', '-PanelArrivalShortCircuit') 'judge3.log' '' -Port $Port2
  $s3 = Get-SelfState 'dsh'
  $real3 = Test-ListHasUrl -Port $Port2 -Url "http://127.0.0.1:$DsPort/"
  T '读数' ("收据 state={0}（短路注入让它恒报 arrived）｜ 外部对照：真清单里有 :{1} 标签 = {2}" -f $s3.state, $DsPort, $real3)
  if ("$($s3.state)" -eq 'arrived' -and -not $real3) {
    Add-Result '③ 空过对照被抓到' $true '短路后收据谎报 arrived，而外部对照（真清单）里**根本没有**那一页 ⇒ 谎报当场成立：真跑的判据必须验清单，光"发起了"不算数'
  } else {
    Add-Result '③ 空过对照被抓到' $false ("**对照失效**：收据 state=$($s3.state)、外部对照=$real3 —— 没能造出'谎报'，这一条不算数")
  }
} catch {
  if ("$($_.Exception.Message)" -ne 'SKIP') { Add-Result '③ 空过对照被抓到' $false "跑挂：$($_.Exception.Message)" }
}
finally { Stop-Mine $proc3 $prof3 }

# ═══ ④ 打不开的端口 :9 ⇒ failed（**探针正反对照**）══════════════════════════════════════
Note ''
Note '④ 打不开的端口 :9 ⇒ 期望 failed（★ 正反对照：同一份探针，真页必须是 http、错误页必须不是）' 'White'
$prof4 = Join-Path $SelfTmp 'profile-dead'
$proc4 = $null
try {
  if (-not $WithBrowser) {
    Add-Skip '④ 打不开的端口 ⇒ 判据认得出没到' '本会话不起浏览器实例（默认；要跑真环境加 -WithBrowser）'
    throw [System.Management.Automation.RuntimeException]'SKIP'
  }
  $proc4 = Start-HeadlessEdgeUp -Port $Port3 -Urls @("http://127.0.0.1:$DsPort/", 'http://127.0.0.1:9/') -ProfileDir $prof4
  if (-not $proc4) { throw "自造实例起不来（调试口 :$Port3 一直没就绪）" }
  $up = $false
  for ($i = 0; $i -lt 24; $i++) { Start-Sleep -Milliseconds 500; if (Get-CdpList -Port $Port3) { $up = $true; break } }
  if (-not $up) { throw '自造实例的调试口没起来（造态失败）' }
  Start-Sleep -Milliseconds 2000   # 让错误页落定
  $good = Get-ProbeHref -Port $Port3 -Match "127.0.0.1:$DsPort"
  $bad = Get-ProbeHref -Port $Port3 -Match '127.0.0.1:9'
  $goodHref = "$($good.href)"
  $badHref = "$($bad.href)"
  T '正向对照' ("真页面 :{0} ⇒ location.href = {1}（是 http ⇒ 判据判'到了'）" -f $DsPort, $goodHref)
  T '反向对照' ("死端口 :9 ⇒ 清单里有它 = {0} ｜ location.href = {1}（不是 http ⇒ 判据判'没到'）" -f ([bool]$bad), $badHref)
  $okGood = ($goodHref -match '^(?i)https?:')
  $okBad = ($badHref -and $badHref -notmatch '^(?i)https?:')
  Add-Result '④ 打不开的端口 ⇒ 判据认得出没到' ($okGood -and $okBad) ("正例 href=$goodHref（http ✓）｜ 反例 href=$badHref（非 http ✓）⇒ 同一份判据两头都对得上")
} catch {
  if ("$($_.Exception.Message)" -ne 'SKIP') { Add-Result '④ 打不开的端口 ⇒ 判据认得出没到' $false "跑挂：$($_.Exception.Message)" }
}
finally { Stop-Mine $proc4 $prof4 }

# ── 台账对照（★ 外部可核：生产台账一字未变）＋ 自测收据样例 ────────────────────────────────
Note ''
$prodSha1 = Get-Sha $ProdLedger
Note ("生产台账 SHA256（自测后）：{0}" -f $prodSha1) 'Cyan'
Add-Result '⑤ 生产台账一字未变' ($prodSha0 -eq $prodSha1) $(if ($prodSha0 -eq $prodSha1) { '自测前后 SHA256 相同 ⇒ 全程没碰生产台账（自测只写自己 %TEMP% 那份）' } else { '**变了**（自测写了生产台账）' })
# ★ 红线 6 的对照读数（协调线要的）：跑前跑后的**顶层窗口数**（只读）
$winAfter = Get-TopWindowCount
T '窗口对照' ("跑前 {0} → 跑后 {1}（期望**不增**：这一跑没有能力弹任何窗口/对话框）" -f $winBefore, $winAfter)
Add-Result '⑤b 桌面上没多出窗口/对话框' ($winAfter -le $winBefore) ("顶层窗口数 {0} → {1}" -f $winBefore, $winAfter)

if (Test-Path -LiteralPath $SelfLedger) {
  Note ''
  Note '自测台账（自己 %TEMP% 那份，原样；三态收据长这样）：' 'Cyan'
  Get-Content -LiteralPath $SelfLedger -Raw -Encoding UTF8 | Write-Host
}

Note ''
Note '—— 明细（★ 自检看明细，不看汇总行）——' 'Cyan'
if ($r3) { $r3.Lines | Where-Object { $_ -match '开页收据|到达|缺页|闸住' } | Select-Object -First 8 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }

Note ''
$pass = @($results | Where-Object { $_.Pass }).Count
$all = $results.Count
$col = if ($pass -eq $all) { 'Green' } else { 'Red' }
Write-Host ("===== 汇总：{0}/{1} 通过 =====" -f $pass, $all) -ForegroundColor $col
$results | ForEach-Object { Write-Host ("  {0}  {1} —— {2}" -f $(if ($_.Pass) { '[PASS]' } else { '[FAIL]' }), $_.Name, $_.Detail) -ForegroundColor $(if ($_.Pass) { 'Green' } else { 'Red' }) }
if ($pass -ne $all) { exit 1 } else { exit 0 }
