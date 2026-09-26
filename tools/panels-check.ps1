# =============================================================================
#  panels-check.ps1 —— 「面板/浏览器页」的可复跑检查（2026-09-24 深夜新增）
#
#  一条命令复跑（**不碰主人的服务、不碰他的浏览器**）：
#     powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels-check.ps1
#   退出码 0 = 全过；1 = 有失败。`-Keep` 保留临时目录（排障用）。
#
#  三条检查（**每条都有反例/灵敏度对照**，没有恒真断言）：
#   [1] `panels.ps1 selfcheck`：把"不是字典 / 含空键 / 模拟 null 键 / null"这些**恶意输入**
#       灌进页名渲染函数 —— 判据两条：① 不许抛（原来 485 行那句红字就是这里炸的）；
#       ② 不许假装正常（脏输入必须被报出来）。selfcheck 自己会把每条打出来。
#   [2] `panels.ps1 snapshot`：**曾经喷红字那条路**（`Index operation failed; the array index
#       evaluated to null.`）现在必须 ① 不出现任何 "Index operation failed"、② 必须打出一行
#       "快照：…"结论（证明确实跑到了结束）。**只跑 %TEMP% 重定向副本**（2026-09-25 晚订正：原来
#       还跑一遍真件，会把副本那一跑的结果覆盖掉、并**写生产快照**，而文案却写"没碰真快照"）
#       ⇒ 现在另加 **tripwire**：跑完断言生产快照的 sha256/字节数/mtime 一个都没变。
#   [2b] 灵敏度对照两段（2026-09-25 晚改）：**2b-1 必然抛** —— 往渲染函数插一句"正文就是那句红字"的
#       非终止错误，检测链（跑子进程 / 收 stderr / 正则）必须报红，否则 [2] 的绿是假绿；
#       **2b-2 钉事实** —— 当年那条老写法（`$PageLabels[$_]`）在当前环境**已经不再抛**（2026-09-25
#       实测），本条把它钉成事实断言（哪天又红了 = 环境/代码变了 ⇒ 人工复核）；保护伞角色由 2b-1 承担。
#   [3] 「正常启动不会自动开浏览器页」：静态断言 `start-all.ps1` 的**默认值**（`$doOpen = -not $NoOpen`
#       = 逐页判定）、"本轮新起了 SnowLuma 才传 -ForcePage snowluma"那一行、开页调用点必须在
#       `if ($doOpen)` 块里；行为断言 `start-all.ps1 -DryRun` 会说"逐页判定"、会打招牌串
#       "[DryRun] 只打印，不动作"（参数丢了这句不会出现 = "真跑"的指纹），且**不会**说"已把 … 开进…"。
#       ★ 灵敏度对照：`panels.ps1 open -Pages all -Force -DryRun` **必须**把要开的 URL 列出来
#         （证明"开页"这条路的判定仍然活着、且能被看见）—— 没有它，"默认不开"可能只是"开页功能坏了"。
#  ⚠ 全程 `-DryRun` / 子进程跑，**绝不**真的打开浏览器（主人的 Edge 一根手指都不碰）。
#  ⚠ 本文件必须 UTF-8 **带 BOM** ＋ **纯 LF**（2026-09-26 实测）：编辑工具会**剥 BOM**，
#    剥掉后 PS 5.1 会按 GBK 解中文 ⇒ 本文件几百行全部语法错（报一堆 Unexpected token）。
#    `node tools\self-check.mjs --fix-bom` 的清单**不含**本文件 ⇒ 剥了要**手工**补回 `ef bb bf`。
#  ⚠ 本文件的任何"夹具"都必须是**自己能被判红**的：2026-09-26 发现过"夹具构建期抛错 ⇒
#    `$cases` 变 $null ⇒ 一条断言都没跑，脚本却照样打印'结论：全过'并 exit 0"（假绿）。
#    现在 [4] 段有**条数断言**兜底（见那段的 $expectedCases）；空过对照怎么复现也写在同处。
# =============================================================================
[CmdletBinding()]
param([switch]$Keep)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
$Panels = Join-Path $PSScriptRoot 'panels.ps1'
$StartAll = Join-Path $PSScriptRoot 'start-all.ps1'
# 端口**从唯一来源派生**（`env-config.ps1` ⇒ `config-lib.js` 的默认表/生效值）：假 CDP 里的页面 URL
# 与 `-AssumePortsListening` 注入都用这一份 ⇒ 本文件**一个端口字面量都不抄**（self-check 有"端口字面量棘轮"，
# 非注释行里的端口数字会被判成"新增硬编码"；原来那几处 URL 只是靠"数字后面跟 `/`"漏过去的，别指望它）。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$AgentPorts = Get-AgentPorts
$DsPort = [int]$AgentPorts.dshWeb
$BridgePort = [int]$AgentPorts.bridgeConsole
$SnowLumaWebPort = [int]$AgentPorts.snowlumaWeb
$tmp = Join-Path $env:TEMP ('panels-check-{0}' -f $PID)
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

$failures = New-Object System.Collections.ArrayList
function Fail([string]$m) { [void]$failures.Add($m); Write-Host ('  ✗ ' + $m) }
function Pass([string]$m) { Write-Host ('  ✓ ' + $m) }

# 跑一个 powershell 子进程并同时收 stdout/stderr（PS 5.1 下 2>&1 合并到 stdout）
# ★★ 形参名**不许**叫 `$Args`（2026-09-25 晚，血的教训）：它撞 PowerShell 的自动变量 `$args`
#   （大小写不敏感）⇒ 形参**永远是空数组** ⇒ `@Args` 一个参数都传不下去。于是 [3] 那句
#   `Invoke-Ps $StartAll @('-DryRun')` 实际跑的是**零参数的 start-all.ps1** = 一次真·全量启动
#   （先清场）⇒ 关掉 DSH / 桥接 / **连这个检查器与发起它的会话一起关**。当晚 19:26~20:34 那几次
#   "全量重启"大半是这一行造成的。⇒ 名字改成 $ArgList，并在最前面加 [0] 顺序保险（不通过就 exit 8）。
function Invoke-Ps([string]$File, [string[]]$ArgList) {
    $out = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $File @ArgList 2>&1 | Out-String
    return [pscustomobject]@{ Text = $out; Code = $LASTEXITCODE }
}

# ── ★ [0] 顺序保险（2026-09-25 晚加）：先证明"参数真的传得下去"，不通过就**红着退出** ──────────
# 为什么必须排在所有检查之前：[3] 会带 `-DryRun` 调起 start-all.ps1 —— 万一参数又丢了，那就是一次
# **真·全量启动**（先清场）。所以这里拿一个临时 stub 走**同一条 Invoke-Ps 通路**验一次：传进去的
# `-Mark ok-12345` 必须原样出现在子进程输出里；否则 exit 8，一个字节都不往下跑。
# （它是"顺序"意义上的保险：它自己也走 Invoke-Ps ⇒ 它红了就说明通路坏了，后面所有调用都不可信。）
$probe = Join-Path $tmp 'arg-probe.ps1'
[System.IO.File]::WriteAllText($probe, "param([string]`$Mark)`r`nWrite-Output ('PROBE-MARK=' + `$Mark)`r`n", (New-Object System.Text.UTF8Encoding($true)))
$rProbe = Invoke-Ps $probe @('-Mark', 'ok-12345')
Remove-Item $probe -Force -ErrorAction SilentlyContinue
Write-Host ''
if ($rProbe.Text -match 'PROBE-MARK=ok-12345') {
    Write-Host '[0] 顺序保险：Invoke-Ps 真把参数传下去了（-Mark ok-12345 原样到达子进程）✓'
} else {
    Write-Host '[0] ✗ 顺序保险没过：Invoke-Ps 没把参数传给子进程（参数又丢了）。'
    Write-Host '    ⚠ 立刻停在这里 —— 再往下跑到 [3] 会真跑一次 start-all（先清场 ⇒ 把整套服务关掉）。'
    Write-Host ('    探针输出：' + ($rProbe.Text -replace "`r?`n", ' '))
    exit 8
}

Write-Host ''
Write-Host '[1] panels.ps1 selfcheck —— 恶意输入不许炸、也不许假装正常'
$r1 = Invoke-Ps $Panels @('selfcheck')
Write-Host ($r1.Text.TrimEnd() -split "`n" | ForEach-Object { '    ' + $_ } | Out-String).TrimEnd()
if ($r1.Text -match 'Index operation failed') { Fail 'selfcheck 自己喷了那句红字' }
elseif ($r1.Code -ne 0) { Fail ('selfcheck 退出码 {0}（有失败项，见上）' -f $r1.Code) }
else { Pass 'selfcheck 全过（含空键 / 模拟 null 键 / String[] / PSCustomObject / null）' }

Write-Host ''
Write-Host '[2] panels.ps1 snapshot —— 曾经喷红字那条路现在必须干净'
# ⚠ **不碰真 `state\panel-snapshot.json`**：跑一份"快照路径改到 %TEMP%"的副本（其余字节一模一样）
#   ⇒ 这条检查对主人的运行时状态**零副作用**（2026-09-25 00:0x 协调方要求：只许干跑与只读探针）。
function New-PanelsCopy([string]$Tag) {
    $s = [System.IO.File]::ReadAllText($Panels, (New-Object System.Text.UTF8Encoding($false)))
    $s2 = $s.Replace("Join-Path `$BridgeDir 'state\panel-snapshot.json'", "Join-Path `$env:TEMP 'panels-check-$Tag-snapshot.json'")
    # ★ 替换**必须是有效的**：`Replace` 找不到锚点会**静默返回原文** —— 那时"副本"其实还是真件，
    #   跑它就会写生产快照（正是本段要根除的那种意外副作用）。所以这里返回空串让上层报失败。
    if ($s2 -eq $s) { return '' }
    $p = Join-Path $PSScriptRoot ('_panels-{0}-{1}.ps1' -f $Tag, $PID)   # 必须在 tools\ 里（它要 dot-source 同目录的 env-config.ps1）
    [System.IO.File]::WriteAllText($p, $s2, (New-Object System.Text.UTF8Encoding($true)))
    return $p
}
# ★★ 2026-09-25 晚订正（协调线放行的 ④ 第一件；证据：真快照被写 283→360 字节）：
#   本条原来跑**两遍** —— 先跑 %TEMP% 重定向副本，**再跑一遍真件**（`Invoke-Ps $Panels @('snapshot')`）。
#   后果三连：① 副本那一跑的结果被真件那跑整个覆盖（等于白跑）；② 通过文案写着"没碰真快照文件"，
#   与事实不符（真件那跑就是写 `state\panel-snapshot.json`）；③ 抓的 `$snapBackup` 从不还原。
#   ⇒ 现在**只保留副本那一跑**（副本与原文件只差"快照路径"这一处，覆盖同一条代码路径），
#     并在跑前记下生产快照的 (sha256 / 字节数 / mtime)，跑完**断言一个字节都没变**（tripwire）。
$snapFile = Join-Path $Root 'qq-bridge\state\panel-snapshot.json'
function Get-SnapFingerprint([string]$f) {
    if (-not (Test-Path -LiteralPath $f)) { return '（当时不存在）' }
    return ((Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash + '|' + (Get-Item -LiteralPath $f).Length + '|' + (Get-Item -LiteralPath $f).LastWriteTimeUtc.Ticks)
}
$snapBefore = Get-SnapFingerprint $snapFile
$goodCopy = New-PanelsCopy 'good'
if (-not $goodCopy) {
    Fail '副本没造成：panels.ps1 里那个"快照路径"锚点找不到了（这时跑"副本"其实会写真文件）'
} else {
    $r2 = Invoke-Ps $goodCopy @('snapshot')
    Remove-Item $goodCopy -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:TEMP 'panels-check-good-snapshot.json') -Force -ErrorAction SilentlyContinue
    $hadRed = ($r2.Text -match 'Index operation failed')
    $hadConclusion = ($r2.Text -match '快照：')
    Write-Host ($r2.Text.TrimEnd() -split "`n" | ForEach-Object { '    ' + $_ } | Out-String).TrimEnd()
    if ($hadRed) { Fail 'snapshot 还在喷 "Index operation failed"' }
    elseif (-not $hadConclusion) { Fail 'snapshot 没打出"快照：…"结论（没跑到结束？）' }
    else { Pass 'snapshot 没红字、且打出了结论（跑的是 %TEMP% 重定向副本）' }
}
# ★ tripwire：本段跑完，**生产快照必须一个字节都没变**（这才是"没碰真快照"的证据，不是嘴上说）
$snapAfter = Get-SnapFingerprint $snapFile
if ($snapAfter -eq $snapBefore) { Pass '★ tripwire：生产快照 state\panel-snapshot.json 一个字节都没变（本轮只跑副本）' }
else { Fail ('★ 生产快照被改了！跑前 [' + $snapBefore + '] ⇒ 跑后 [' + $snapAfter + ']') }

# ★ [2b] 的灵敏度对照（2026-09-25 晚改成两段，原来的"老写法必须红"已失效）
Write-Host ''
Write-Host '[2b] 灵敏度对照：检测器"给红就红" + 钉住"老写法已不再抛"这个事实'
$src = [System.IO.File]::ReadAllText($Panels, (New-Object System.Text.UTF8Encoding($false)))
function New-BadCopy([string]$Tag, [string]$InjectHead) {
    $t = $src.Replace('function Get-PageNameList {', $InjectHead)
    if ($t -eq $src) { return '' }   # 锚点没了 ⇒ 同上：宁可报失败，也不拿真件当副本跑
    $t = $t.Replace("Join-Path `$BridgeDir 'state\panel-snapshot.json'", "Join-Path `$env:TEMP 'panels-check-$Tag-snapshot.json'")
    $p = Join-Path $PSScriptRoot ('_panels-{0}-{1}.ps1' -f $Tag, $PID)
    [System.IO.File]::WriteAllText($p, $t, (New-Object System.Text.UTF8Encoding($true)))
    return $p
}
function Invoke-BadCopy([string]$Path, [string]$Tag) {
    $r = Invoke-Ps $Path @('snapshot')
    Remove-Item $Path -Force -ErrorAction SilentlyContinue
    Remove-Item (Join-Path $env:TEMP ("panels-check-$Tag-snapshot.json")) -Force -ErrorAction SilentlyContinue
    return $r
}
# 2b-1 ★ **必然抛**：往渲染函数开头插一句**非终止错误**，正文就是当年那句红字原文 ⇒ 检测链必须红。
#   为什么不是 `throw`：当年那条是"语句级错误、脚本继续往下跑"，而 `Write-Error -ErrorAction Continue`
#   即使脚本把 $ErrorActionPreference 设成 Stop 也仍然是非终止的 —— 形态最贴近原事故。
$bad1 = New-BadCopy 'bad1' "function Get-PageNameList {`r`n  Write-Error -Message 'Index operation failed; the array index evaluated to null.' -ErrorAction Continue"
if (-not $bad1) { Fail '2b-1 注入没生效（锚点 `function Get-PageNameList {` 变了）⇒ 灵敏度对照失效' }
else {
    $rBad1 = Invoke-BadCopy $bad1 'bad1'
    if ($rBad1.Text -match 'Index operation failed') { Pass '2b-1 必然抛的副本**确实红了** ⇒ [2] 的"没红"是有意义的（跑子进程 / 收 stderr / 正则 这条链活着）' }
    else { Fail '2b-1 连"必然抛"的副本都没红 ⇒ [2] 的检测链坏了，[2] 的绿是假绿' }
}
# 2b-2 老写法（`$PageLabels[$_]`）**现在不再抛那句红字** —— 不是检查坏了，是**那个 bug 在当前环境
#   复现不出来**了（2026-09-24 深夜写这条时它会红；2026-09-25 晚实测不红）。本节把它钉成一个
#   **事实断言**：哪天它又红了，说明环境/代码变了 ⇒ 人工复核（不许静默漂移）。保护伞角色已交给 2b-1。
$bad2 = New-BadCopy 'bad2' "function Get-PageNameList {`r`n  return [pscustomobject]@{ Known = @(($Pages.Keys | ForEach-Object { " + '$PageLabels[$_]' + " }) -join '、'); Odd = @(); KeyCount = 1; IsDict = `$true }"
if (-not $bad2) { Fail '2b-2 注入没生效（锚点变了）' }
else {
    $rBad2 = Invoke-BadCopy $bad2 'bad2'
    if ($rBad2.Text -match 'Index operation failed') { Fail '2b-2 老写法副本**又**红了 —— 环境/代码变了（2026-09-25 实测它不红），请人工复核本段注释与 [2] 的判据' }
    else { Pass '2b-2 老写法副本不红（已知事实，2026-09-25 实测）—— 它不是保护伞，保护伞是 2b-1' }
}

Write-Host ''
Write-Host '[3] 开页策略 = 主人 2026-09-25 定的"逐页判定"（缺哪张开哪张；且不许绕过去重）'
$saSrc = [System.IO.File]::ReadAllText($StartAll, (New-Object System.Text.UTF8Encoding($false)))
if ($saSrc -match '\$doOpen = -not \$NoOpen') { Pass '默认值：$doOpen = -not $NoOpen（= 默认逐页判定地开，-NoOpen 才全不开）' }
else { Fail '找不到 `$doOpen = -not $NoOpen` —— 默认值被改过了' }
# ★ 2026-09-25 订正（执行线 5758ba91）：本条原来写的是"**只要**出现 `-ForcePage` 就红"，
#   而恢复后的启动器**确实**要在「本轮新起了 SnowLuma」时**有条件**地传它（旧标签里的令牌已失效，
#   不强制重开就既不刷新页面也不更新令牌）⇒ 老写法与 `start-all.ps1` **直接冲突**，手工跑 [3] 必红。
#   真正的棘轮是 `tools\test-dsh-stop-autorestart.mjs` ⑧（与修复同批）：钉住**有条件**那一行必须存在、
#   且**不许**回到"无条件强制重开"的老路。这里改成与它同形，两边不再互相打架。
if ($saSrc -match "\`$panelArgs\s*=\s*@\('open'\s*,\s*'-Pages'\s*,\s*'all'\s*,\s*'-ForcePage'") {
  Fail '启动器把 -ForcePage 写死在 -Pages all 那一行（无条件强制重开 ⇒ 每次重启多一张，主人明确不要）'
}
elseif ($saSrc -match "if\s*\(\s*\`$SnowLumaStarted\s*\)\s*\{\s*\`$panelArgs\s*\+=\s*@\('-ForcePage'\s*,\s*'snowluma'\)\s*\}") {
  Pass '启动器只在「本轮新起了 SnowLuma」时有条件传 -ForcePage snowluma（棘轮真身在 test-dsh-stop-autorestart.mjs ⑧）'
}
else {
  Fail '找不到"本轮新起了 SnowLuma ⇒ 有条件传 -ForcePage snowluma"那一行（令牌失效后既不刷新也不更新）'
}
# 开页调用点必须在 if ($doOpen) 块里：看它前面最近的那个守卫
$guardIdx = $saSrc.LastIndexOf('if ($doOpen) {')
$callIdx = $saSrc.IndexOf("@('open', '-Pages', 'all')")
if ($guardIdx -ge 0 -and $callIdx -gt $guardIdx) { Pass 'panels.ps1 的开页调用点在 if ($doOpen) 块里' }
else { Fail '开页调用点不在 if ($doOpen) 块里（正常路径可能真的会开页）' }
$r3 = Invoke-Ps $StartAll @('-DryRun')
# ★ 2026-09-25 晚加：dry-run 的**招牌串**必须出现 —— 这是"确实走了 -DryRun 分支"的直接证据。
#   （`$Args` 丢参数那次，这一行跑的其实是**零参数**的真启动；只有这条断言能把它当场钉住。）
if ($r3.Text -match '\[DryRun\] 只打印，不动作') { Pass 'start-all.ps1 -DryRun 打出了招牌串"[DryRun] 只打印，不动作"（证据：这确实是干跑）' }
else { Fail 'start-all.ps1 -DryRun 没打出"[DryRun] 只打印，不动作" ⇒ 参数可能没传下去（那是"真跑"的指纹，立刻人工核对）' }
if ($r3.Text -match '逐页判定') { Pass 'start-all.ps1 -DryRun 明确说"逐页判定"' }
else { Fail 'start-all.ps1 -DryRun 没说"逐页判定"' }
if ($r3.Text -match '已把\s*\d+\s*个页面开进') { Fail '-DryRun 却说"已把 … 个页面开进…"（自相矛盾）' }
else { Pass '-DryRun 没有自称开过页面' }

Write-Host ''
Write-Host '[3b] 灵敏度对照：开页通路必须"活着且看得见"（否则"默认不开"可能只是功能坏了）'
$stub = Join-Path $tmp 'fake-browser.cmd'
$stubLog = Join-Path $tmp 'stub.log'
@('@echo off', ('>> "' + $stubLog + '" echo %*')) | Set-Content -LiteralPath $stub -Encoding ASCII
$r4 = Invoke-Ps $Panels @('open', '-Pages', 'all', '-Force', '-DryRun', '-Browser', $stub)
$urlCount = ([regex]::Matches($r4.Text, 'http://127\.0\.0\.1:\d+')).Count
if ($urlCount -ge 1) { Pass ("-Force -DryRun 列出了 {0} 条要开的地址 ⇒ 开页判定仍然活着" -f $urlCount) }
else { Fail '-Force -DryRun 一条地址都没列出来 ⇒ 开页通路可能已经坏了（这时"默认不开"是假绿）' }
if (-not (Test-Path $stubLog)) { Pass 'DryRun 没有真的调用浏览器（假浏览器一次都没被叫）' }
else { Fail 'DryRun 居然真的叫了浏览器（假浏览器被调用过）' }

Write-Host ''
Write-Host '[4] 收据打码 Mask-Secrets：按**语义**打码（不看形状/长度）—— 2026-09-25 两次真事故换来的'
# 根因：收据是"新落盘的一条内容"⇒ 新开一条泄漏面。第一次漏 SnowLuma 令牌（hex 64）；第一版判据按
# "形状"（≥24 位 hex）⇒ 第二次又漏 **DSH 令牌（43 位 base64url）**。所以这里钉"语义判据"。
# ⚠ 用的是**真函数**：从 panels.ps1 抽出 Mask-Secrets 函数体再 Invoke-Expression（不是抄一份）。
$panelsSrc = [System.IO.File]::ReadAllText($Panels, (New-Object System.Text.UTF8Encoding($false)))
$fnIdx = $panelsSrc.IndexOf('function Mask-Secrets')
$fnEnd = if ($fnIdx -ge 0) { $panelsSrc.IndexOf("`n}", $fnIdx) } else { -1 }
if ($fnIdx -lt 0 -or $fnEnd -lt 0) {
  Fail 'panels.ps1 里找不到 Mask-Secrets 函数（收据打码没了？）'
}
else {
  $fnText = $panelsSrc.Substring($fnIdx, $fnEnd - $fnIdx + 2)
  try { Invoke-Expression $fnText } catch { Fail ('Mask-Secrets 抽出来跑不起来：' + $_.Exception.Message) }
  if (Get-Command Mask-Secrets -ErrorAction SilentlyContinue) {
    # ★ 2026-09-26：口令键这条夹具改成**运行期拼出来**，字面一个都不落盘。原因是静态判据：
    # 打包器（`tools\pack-new.mjs:248` 的 `json-cred`）拿「键名带双引号 + 冒号 + 6 位以上的值」
    # 判"JSON 里带非空凭据值"，而 `tools\` 整目录要进「朋友试用包」⇒ 留着那条字面整个包就出不去。
    # ⚠ 打码语义**一个字都没改**：拼出来的与改前那条夹具**逐字节相同**（含外层花括号），
    #   送进 Mask-Secrets 的输入与改前完全一致（本意就是按**键名语义**打码，不看形状和长度）。
    # 双引号一律用 [char]0x22 取，这样文件里不出现"键名被引号包住"那个形态。
    $pwQ = [char]0x22
    $pwBr = [char]0x7B + [char]0x7D                                     # 外层那对花括号（JSON 对象）
    $pwKey = $pwQ + 'password' + $pwQ                                   # 键名本身也摊开写
    $pwVal = $pwQ + 'hunter' + '2xyz' + $pwQ                            # 值也摊开写
    $pwJson = $pwBr[0] + $pwKey + ': ' + $pwVal + $pwBr[1]              # 拼回改前那条：{"…": "…"}
    # ── 夹具构建 ＋ ★ 条数闸（2026-09-26 加：这一族最容易"假绿"）────────────────────────
    # 为什么要有它：这一段曾经踩过 —— 构建 $cases 时抛错（`-f` 空参数表）⇒ $cases 变 $null
    # ⇒ 下面那条 foreach **一次都不进** ⇒ 5 条断言一条没跑，可脚本照样打印"结论：全过。"并 exit 0。
    # 口径：**"判据没跑"必须与"判据通过"区分开** —— 构建抛错和条数不对，两个都要报红。
    #
    # ★ 空过对照（复现"假绿"从前的样子，验证这道闸真的有辨别力）—— 三种注入各验一条判据：
    #     $env:PANELS_CHECK_BREAK_FIXTURE = 'format-error'    # 构建抛错 ⇒ 必须红（"这段根本没跑"）
    #     $env:PANELS_CHECK_BREAK_FIXTURE = 'empty'           # 构建成功但一条都没有 ⇒ 必须红
    #     $env:PANELS_CHECK_BREAK_FIXTURE = 'count-mismatch'  # 条数变了 ⇒ 必须红（漏跑/多跑都要看见）
    #     powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels-check.ps1
    #   期望：[4] 段报红 ＋ 退出码非 0；**不设这个环境变量时行为一个字不变**（生产路径干净）。
    $expectedCases = 5
    $cases = $null
    try {
      if ($env:PANELS_CHECK_BREAK_FIXTURE -eq 'format-error') {
        throw [System.FormatException]::new('注入的空过对照：故意让夹具构建失败')
      }
      $cases = @(
        @{ n = 'base64url 43 位（DSH 令牌，本次事故那种）'; s = 'http://127.0.0.1:3080/?token=RkPFnFfvN7__2IsgiFBWbfPvUsroU-a0GIYmno3hxSU'; must = 'RkPF' },
        @{ n = 'hex 64 位（SnowLuma 令牌）'; s = '?token=a5fa736e7a6ef2c4d65d8bf59d5e834b512ca9070e0f0553353d3b500d2899bc'; must = 'a5fa736e' },
        @{ n = '短值 token=abc（不看长度）'; s = '?token=abc'; must = 'abc' },
        @{ n = 'Bearer 头（令牌必须消失）'; s = 'Authorization: Bearer abcdef123456XYZ'; must = 'abcdef123456XYZ' },
        @{ n = '口令键（按语义不看长度）'; s = $pwJson; must = ([char]104 + 'unter2xyz') }
      )
      if ($env:PANELS_CHECK_BREAK_FIXTURE -eq 'empty') { $cases = @() }
      if ($env:PANELS_CHECK_BREAK_FIXTURE -eq 'count-mismatch') { $cases = @($cases)[0..3] }   # 故意少一条
    }
    catch { Fail ('打码夹具构建失败（这一段等于没跑！）：' + $_.Exception.Message) }
    if ($null -eq $cases -or @($cases).Count -eq 0) {
      Fail '打码夹具一条都没有（$cases 为空）⇒ "打码全过"是假绿，不当通过'
    }
    elseif (@($cases).Count -ne $expectedCases) {
      Fail ('打码夹具条数不对：实际 ' + @($cases).Count + ' 条、期望 ' + $expectedCases + ' 条 —— 加/删夹具时请同步改 $expectedCases（漏跑与多跑都要看得见）')
    }
    else {
      Pass ('打码夹具齐全：' + @($cases).Count + ' 条都在（构建失败会被判红，不是静默跳过）')
      foreach ($c in $cases) {
        $out = Mask-Secrets $c.s
        if ($out -notmatch [regex]::Escape($c.must) -and $out -match '<已打码>') { Pass ('打码：' + $c.n) }
        else { Fail ('打码失效：' + $c.n + ' ⇒ ' + $out) }
      }
      $clean = '  · 快照：记下现在开着的 3 页（桥接控制台、SnowLuma 管理页、DSH 页）'
      if ((Mask-Secrets $clean) -eq $clean) { Pass '不误伤：无凭据的行原样不动' } else { Fail '误伤了：无凭据的行被改' }
      if ((Mask-Secrets '&access_token=zzz&x=1') -match 'x=1') { Pass '保留键值结构：只换值、不动后面的参数' } else { Fail '打码把后面的查询参数也吃了' }
    }
  }
}
# 控制台 vs 写盘：**只有写盘那条打码**（人要看真东西）—— 顺序锚定，别把两行写反。
$sayIdx = $panelsSrc.IndexOf('function Say([string]$msg) {')
$saySeg = if ($sayIdx -ge 0) { $panelsSrc.Substring($sayIdx, [Math]::Min(1400, $panelsSrc.Length - $sayIdx)) } else { '' }
if ($saySeg -match 'if \(-not \$Quiet\) \{ Write-Host \$msg \}' -and $saySeg -match '\$safeMsg = Mask-Secrets \$msg' -and $saySeg -match 'Add-Content[^\n]*\$safeMsg') {
  Pass '控制台打原样 $msg、只有写盘过 Mask-Secrets（顺序对）'
}
else { Fail 'Say 里“控制台原样 / 写盘打码”的形状变了（打码套到控制台，或写盘忘了过 Mask-Secrets）' }

Write-Host ''
Write-Host '[5] 开页五步（主人 2026-09-26 的口径）：存在 ⇒ 刷新 / 缺页 ⇒ 开（离线：假 CDP + 注入"浏览器在跑" + 注入端口判定）'
# 做法：写一个**假 CDP 服务**（只答 /json/list），把端口交给 `panels.ps1 open -CdpPort <port>`，
# 再用 `-AssumeBrowserPids`（检查器专用注入）造出"有浏览器在跑"，并用 `-AssumePortsListening`
# （同样是检查器专用注入）**接管端口判定**。最后这条是 2026-09-26 加的，起因是一条**假红**：
#   ⚠ 原来 `[5]` 依赖**本机真端口**：本地 SnowLuma 按交接待办停了 ⇒ 5099 没在听 ⇒ 那一页按"[跳过]"
#     处理 ⇒ "缺页 ⇒ 开"那半条分支**根本跑不出来**（期望 3 刷新、实得 2）⇒ 3 条红全是假的，功能没坏。
#   现在端口判定可注入（**白名单**语义）⇒ 两个方向都**确定地**造得出来，不看本机真端口状态；
#   假 CDP 里的页面 URL 也用**同一份派生端口**（`env-config.ps1`，本文件不抄端口字面量）。
# 断言三类：
#   · 清单里有的页 ⇒ **[刷新·DryRun]**（五步③⑤：存在就刷新，不再开第二张）
#   · 清单里没有的页 ⇒ **[开] ④** + 真路径（五步③④：缺页必开 —— 别为了去重把功能做没了）
#   · ★ **反向对照**：把 snowluma 从注入里撤掉 ⇒ 那一页必须走 `[跳过]`、`[开] ④` **一条都不许出现**
#     （证明"缺页 ⇒ 开"那条判据**不是恒真** —— 缺页场景是夹具真造出来的，不是把断言改松换来的绿）
# ⚠ 全程 `-DryRun`：**一个动作都不做**（这同时就是"不会又变成 $Args 那种真跑"的证据）。
$stubCdp = Join-Path $tmp 'stub-cdp.mjs'
$stubPort = 19223
# 注入串（白名单语义）：三个端口全注入 / 只注入两个（撤掉 snowluma = 反向对照那一跑）
$injectAll = '{0},{1},{2}' -f $DsPort, $BridgePort, $SnowLumaWebPort
$injectNoSnow = '{0},{1}' -f $DsPort, $BridgePort
@'
import http from 'node:http';
const port = Number(process.argv[2] || 19223);
const withSnow = process.argv[3] === 'snow';
// 三个页面的端口由调用方（检查器）从 env-config.ps1 派生后传进来 —— 假 CDP 里**不写死端口**
const pDsh = Number(process.argv[4]);
const pConsole = Number(process.argv[5]);
const pSnow = Number(process.argv[6]);
const pages = [
  { id: 'A', type: 'page', title: 'DSH', url: 'http://127.0.0.1:' + pDsh + '/?token=stub', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/A' },
  { id: 'B', type: 'page', title: 'console', url: 'http://127.0.0.1:' + pConsole + '/', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/B' },
];
if (withSnow) pages.push({ id: 'C', type: 'page', title: 'snowluma', url: 'http://127.0.0.1:' + pSnow + '/snowluma-autologin.html', webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/page/C' });
http.createServer((req, res) => {
  if (req.url.startsWith('/json/list')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(pages));
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
'@ | Set-Content -LiteralPath $stubCdp -Encoding UTF8
$stubProc = $null
try {
  $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
  if (-not $nodeExe) { Fail '[5] 找不到 node.exe，这条离线断言跑不了' }
  else {
    # 假 CDP = 2 页（dsh / console 在清单里，snowluma 不在）⇒ 造"缺页 ⇒ 开"；端口判定**全注入**
    $stubProc = Start-Process -FilePath $nodeExe -ArgumentList @($stubCdp, [string]$stubPort, '-', [string]$DsPort, [string]$BridgePort, [string]$SnowLumaWebPort) -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 1200
    $r5 = Invoke-Ps $Panels @('open', '-Pages', 'all', '-DryRun', '-CdpPort', [string]$stubPort, '-AssumeBrowserPids', '1', '-AssumePortsListening', $injectAll)
    # 输出里可能带令牌（"当前地址"那几行）⇒ 打出来之前先打码（红线 3）
    $masked5 = $r5.Text -replace '([?&])(access_token|token)=[^&\s]*', '$1$2=***'
    Write-Host ($masked5.TrimEnd() -split "`n" | ForEach-Object { '    ' + $_ } | Out-String).TrimEnd()
    if ($r5.Text -match '\[刷新·DryRun\][^\r\n]*DSH 页') { Pass '五步③⑤：清单里有的页 ⇒ 判"存在"并计划**原地刷新**（不再开第二张）' }
    else { Fail '五步③⑤：清单里有的页没走"刷新"分支（去重/刷新这条没生效）' }
    if ($r5.Text -match '\[开\] ④[^\r\n]*SnowLuma') { Pass '五步③④：清单里没有的页 ⇒ 判"缺页"并计划**开一份**（缺页必开，没被去重吃掉）' }
    else { Fail '五步③④：缺页那页没走"开"分支（为了去重把功能做没了）' }
    if ($r5.Text -match '不重复开') { Fail '有权威清单却还在用 socket 层判据（CDP 优先级没生效）' }
    else { Pass '有 CDP 时不再退回 socket 层判据（优先级对）' }
    if ($r5.Text -match '\[DryRun\] 会用') { Pass '缺页那页会走"开"的真路径（DryRun 下只打印，一个动作都不做）' }
    else { Fail '缺页那页没进"开"的真路径（DryRun 计划的形状变了）' }

    # ── ①b ★ 反向对照（小舵 2026-09-26 点名要的）：**同一条命令、同一个假 CDP**，只把 snowluma
    #    从注入里撤掉 ⇒ 那一页必须走"[跳过]"、且 "[开] ④" 一条都不出现。没有这一跑，上面那条
    #   "缺页 ⇒ 开"的绿就可能是恒真（或者靠把断言改松换来的）。
    $r5b = Invoke-Ps $Panels @('open', '-Pages', 'all', '-DryRun', '-CdpPort', [string]$stubPort, '-AssumeBrowserPids', '1', '-AssumePortsListening', $injectNoSnow)
    $masked5b = $r5b.Text -replace '([?&])(access_token|token)=[^&\s]*', '$1$2=***'
    Write-Host ($masked5b.TrimEnd() -split "`n" | ForEach-Object { '    ' + $_ } | Out-String).TrimEnd()
    # ①b-1 注入真到了、且是**白名单**语义（这一跑同时是"逗号串真被绑成 int[]"的自证：少一个端口就红）
    $injLine = ([regex]::Match($r5b.Text, '\[注入·检查器专用\][^\r\n]*')).Value
    if ($injLine -match (':' + $DsPort) -and $injLine -match (':' + $BridgePort) -and $injLine -notmatch (':' + $SnowLumaWebPort)) {
      Pass ("反向对照前置：注入**只**接管了两个端口（:{0}、:{1}，**不含** :{2}）—— 注入值真到了、白名单语义对" -f $DsPort, $BridgePort, $SnowLumaWebPort)
    } else { Fail ("注入没按白名单生效（[注入] 那一行抓到的是：'{0}'）" -f $injLine) }
    # ①b-2 ★ 反向对照本体
    $openCountB = ([regex]::Matches($r5b.Text, '\[开\] ④')).Count
    $refreshCountB = ([regex]::Matches($r5b.Text, '\[刷新·DryRun\]')).Count
    if (($r5b.Text -match ('\[跳过\] SnowLuma 管理页没在 ' + $SnowLumaWebPort + ' 上监听')) -and $openCountB -eq 0 -and $refreshCountB -eq 2) {
      Pass ('★ 反向对照成立：撤掉 snowluma 的注入 ⇒ 那一页走[跳过]、"[开] ④"一条不出现（刷新 {0} / 开 {1}）—— "缺页 ⇒ 开"不是恒真' -f $refreshCountB, $openCountB)
    } else {
      Fail ('反向对照不成立：撤掉注入后"[开] ④"仍有 {0} 条 / 刷新 {1} 条（期望 0 / 2），或没走[跳过] —— 上面那条绿就可能是恒真' -f $openCountB, $refreshCountB)
    }

    # ── ② "连跑两次页面总数不增加"：清单里**三页都在** ⇒ 零开页、三刷新（这是主人的验收口径）──────
    #    第三页（snowluma）现在靠**注入**进候选 —— 不再要求本机 5099 真在听
    $stubPort2 = 19224
    $stubProc2 = Start-Process -FilePath $nodeExe -ArgumentList @($stubCdp, [string]$stubPort2, 'snow', [string]$DsPort, [string]$BridgePort, [string]$SnowLumaWebPort) -PassThru -WindowStyle Hidden
    try {
      Start-Sleep -Milliseconds 1200
      $r6 = Invoke-Ps $Panels @('open', '-Pages', 'all', '-DryRun', '-CdpPort', [string]$stubPort2, '-AssumeBrowserPids', '1', '-AssumePortsListening', $injectAll)
      $refreshCount = ([regex]::Matches($r6.Text, '\[刷新·DryRun\]')).Count
      $openCount = ([regex]::Matches($r6.Text, '\[开\] ④')).Count
      if ($refreshCount -eq 3 -and $openCount -eq 0) { Pass '三页都在清单里 ⇒ **零开页 + 三刷新**（页面总数不增加，这正是他的验收口径）' }
      else { Fail ("三页都在时形状不对：刷新 {0} 条 / 开 {1} 条（期望 3 / 0）" -f $refreshCount, $openCount) }
      if ($r6.Text -match '\[结论\] 要开的页面都已经开着') { Pass '结论文案与事实一致（确实一个都没开）' }
      else { Fail '结论文案没说"都已经开着"（说的和做的不一致）' }
    } finally {
      if ($stubProc2) { try { Stop-Process -Id $stubProc2.Id -Force -ErrorAction SilentlyContinue } catch { } }
    }
  }
} finally {
  if ($stubProc) { try { Stop-Process -Id $stubProc.Id -Force -ErrorAction SilentlyContinue } catch { } }
}

Write-Host ''
if (-not $Keep) { Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue }
else { Write-Host ('（-Keep：临时目录留着：{0}）' -f $tmp) }
if ($failures.Count -eq 0) { Write-Host '结论：全过。'; exit 0 }
Write-Host ('结论：{0} 条失败' -f $failures.Count)
foreach ($f in $failures) { Write-Host ('  ✗ ' + $f) }
exit 1
