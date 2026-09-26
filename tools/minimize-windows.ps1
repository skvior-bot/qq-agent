# ============================================================================
#  控制台窗口小库：认窗口 / 最小化窗口（给 tools\start-all.ps1 收尾用）
#
#  由 tools\start-all.ps1 点源（dot-source）；单独测试见
#  qq-bridge\state\_tmp\probe-minimize.ps1。
#
#  为什么要"先正常开窗、最后再一起最小化"（主人 2026-09-23："最好 cmd 的最小化，
#  还是这个形式，可以全部启动完一起最小化"）：
#    · 正常创建的控制台窗口由 **Windows Terminal** 托管，任务栏图标才正常；
#      `Start-Process -WindowStyle Minimized` / `start /min` 这类"以最小化状态创建"
#      会让窗口落到老式 conhost，任务栏变成一块没图标的黑方块（实测踩过）。
#    · 窗口刚出现那 1~2 秒，WT 会把自己的窗口顶回正常状态，所以按下最小化后要复查。
#    · 一起收（不是启动时逐个收）：不会看到窗口一个个蹦出来又被压下去。
#
#  ★ 为什么还要"记录句柄"：**标题不可靠**。实测 `dsh web` 跑起来后，那个窗口的标题会
#    变回 cmd 的默认值 `C:\Windows\system32\cmd.exe`（SnowLuma 旧版 `start` 另开的外层
#    窗口也是），按标题根本认不出来 → 收尾最小化和"一键关闭"都会漏掉它。
#    所以启动前先给所有控制台窗口拍个快照，跑完再比一次，**新出现的那些就是我们的**，
#    连同句柄一起记进 `.launcher-state.json`，供 stop-all.ps1 精确关闭。
#
#  用法：
#    $before = Get-ConsoleWindows
#    ... 启动三件套 ...
#    $new = Get-NewConsoleWindows -Before $before
#    Minimize-WindowHandles -Handles (@($new.Hwnd) + @($titled.Hwnd))
#    # 判据说"这次留桌面"时，别只是"不缩"，要**主动放回桌面**（WT 会复用缩着的窗口）：
#    Restore-WindowHandles -Handles (@(Get-DshConsoleWindows).Hwnd)
#
#  ★ P1④（2026-09-24）之后：qq-bridge 与 SnowLuma **不创建窗口** ⇒ 这里"要最小化的窗口"
#    通常只剩 DSH-Web（而它按规矩**不**最小化），句柄表可能是空的、也可能已经失效。
#    所以本文件的函数对"句柄不存在/已销毁/没有窗口"必须是**优雅跳过**（Set-WindowMinimized
#    先 IsWindow 判一下），绝不能报错、也绝不能干等。
#
#  注意：本文件必须存成「UTF-8 带 BOM」（PS 5.1 否则按 ANSI 解码，中文全乱）。
# ============================================================================

# 哪些进程算"控制台类"（它们的顶层窗口才可能是我们的 cmd/node 窗口）
$script:ConsoleOwnerNames = @('cmd', 'node', 'conhost', 'WindowsTerminal', 'OpenConsole', 'powershell', 'pwsh')

# "哪个窗口算 DSH-Web" —— **标题通配符只有这一份定义**。
# 为什么要单独列出来：除了启动器收尾，dsh-prompt.ps1 判断"窗口是不是缩着的"也要按标题找它
# （GetConsoleWindow 在 Windows Terminal 下不可靠，见 dsh-prompt.ps1 的 Test-ConsoleMinimized）。
# 两处各写一遍 = 迟早只有一处被改对，所以这里定义、两边都取它。
# 通配符不是精确串：cmd 会把当前命令续在标题后面（`DSH-Web - ...`），也可能被程序改回 cmd 默认值。
$script:DshWindowTitlePatterns = @('DSH-Web*', '*dsh web*')

if (-not ('StartAll.Win' -as [type])) {
    Add-Type -Namespace StartAll -Name Win -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr p);
public delegate bool EnumProc(System.IntPtr h, System.IntPtr p);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetWindowTextW(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
'@
}

# 当前所有"可见 + 控制台类"的顶层窗口：@{ Hwnd; Title; Pid; Owner }
function Get-ConsoleWindows {
    $script:__cwRows = New-Object System.Collections.ArrayList
    $cb = [StartAll.Win+EnumProc]{
        param($h, $l)
        if (-not [StartAll.Win]::IsWindowVisible($h)) { return $true }
        $wpid = 0
        [StartAll.Win]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null
        $proc = Get-Process -Id ([int]$wpid) -ErrorAction SilentlyContinue
        $owner = $(if ($proc) { $proc.ProcessName } else { '?' })
        if ($script:ConsoleOwnerNames -notcontains $owner) { return $true }
        $sb = New-Object System.Text.StringBuilder 512
        [StartAll.Win]::GetWindowTextW($h, $sb, 512) | Out-Null
        [void]$script:__cwRows.Add([pscustomobject]@{
            Hwnd  = $h
            Title = $sb.ToString()
            Pid   = [int]$wpid
            Owner = $owner
        })
        return $true
    }
    [StartAll.Win]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
    return $script:__cwRows
}

# 比快照多出来的窗口 = 这次启动产生的（标题会被程序改掉，所以只比句柄）
function Get-NewConsoleWindows($Before) {
    $old = @()
    if ($Before) { $old = @($Before | ForEach-Object { [Int64]$_.Hwnd }) }
    return @(Get-ConsoleWindows | Where-Object { $old -notcontains [Int64]$_.Hwnd })
}

# 按标题挑窗口（"本来就在跑的"要靠它兜；新窗口则靠句柄）
function Get-TitledConsoleWindows([string[]]$Patterns) {
    $rows = @(Get-ConsoleWindows | Where-Object { $_.Title })
    $hit = New-Object System.Collections.ArrayList
    foreach ($r in $rows) {
        foreach ($pat in $Patterns) {
            if ($r.Title -like $pat) { [void]$hit.Add($r); break }
        }
    }
    return $hit
}

# 按标题挑 DSH-Web 那个窗口（标题模式只有 $script:DshWindowTitlePatterns 一份）。
# ⚠ 注意它返回的是**所有**标题命中的窗口，可能不止一个（Windows Terminal 会复用同一个窗口：
#   同一个 pid 上能看到多个 HWND/标题；也可能有别的 WT 窗口开着 DSH-Web 标签）。
#   调用方按自己的语义决定"任一命中就算"还是"逐条处理"。
function Get-DshConsoleWindows {
    return @(Get-TitledConsoleWindows -Patterns $script:DshWindowTitlePatterns)
}

# 最小化并"按住"：WT 刚起来那 1~2 秒会把自己的窗口顶回正常，所以要复查；
# 连续 800ms 保持最小化即认定成功（正常约 1 秒返回）。
# ★ 句柄可能**已经不存在**（2026-09-24 P1④ 无窗口化之后这成了常态：qq-bridge / SnowLuma
#   不再有窗口，.launcher-state.json 里只剩 DSH-Web，甚至一条都没有）。
#   所以先 IsWindow 判一下：句柄失效就**立刻优雅跳过**（返回 false），不要去 ShowWindow 干等 4 秒。
function Set-WindowMinimized([IntPtr]$Handle, [int]$VerifyMs = 4000) {
    if ($Handle -eq [IntPtr]::Zero) { return $false }
    if (-not [StartAll.Win]::IsWindow($Handle)) { return $false }   # 窗口早就没了：跳过，不报错
    [StartAll.Win]::ShowWindow($Handle, 6) | Out-Null   # 6 = SW_MINIMIZE
    $deadline = (Get-Date).AddMilliseconds($VerifyMs)
    $stableSince = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 200
        if (-not [StartAll.Win]::IsWindow($Handle)) { return $false }   # 等的过程里被关掉了
        if ([StartAll.Win]::IsIconic($Handle)) {
            if (-not $stableSince) { $stableSince = Get-Date }
            elseif (((Get-Date) - $stableSince).TotalMilliseconds -ge 800) { return $true }
        } else {
            $stableSince = $null
            [StartAll.Win]::ShowWindow($Handle, 6) | Out-Null
        }
    }
    return [StartAll.Win]::IsIconic($Handle)
}

# 按句柄最小化（去重）；返回确实收起来的 @{ Hwnd; Title }
function Minimize-WindowHandles($Handles) {
    $seen = @{}
    $done = New-Object System.Collections.ArrayList
    $all = @(Get-ConsoleWindows)
    foreach ($h in @($Handles)) {
        $key = [Int64]$h
        if ($key -eq 0 -or $seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $title = ''
        foreach ($w in $all) { if ([Int64]$w.Hwnd -eq $key) { $title = $w.Title; break } }
        if (Set-WindowMinimized -Handle ([IntPtr]$key)) {
            [void]$done.Add([pscustomobject]@{ Hwnd = [IntPtr]$key; Title = $title })
        }
    }
    return $done
}

# 标题匹配的一键最小化（兜底：本来就在跑的窗口）
function Minimize-ConsoleWindows([string[]]$Patterns) {
    return Minimize-WindowHandles -Handles (@(Get-TitledConsoleWindows -Patterns $Patterns | ForEach-Object { $_.Hwnd }))
}

# ── 还原（把它放回桌面）──────────────────────────────────────────────────────
# ★ 为什么必须有这一半（2026-09-24，主人双击 一键启动.cmd 后 DSH-Web 自己缩进了任务栏）：
#   **"不缩窗口"不等于"窗口在桌面上"**。DSH-Web 跑在 **Windows Terminal** 里，而 WT **复用同一个窗口**
#   （同一个 pid 上能看到多个 HWND/标题，见 launcher-windows.log 的 1199x616 与 159x27 两条）——
#   **在一个已经缩着的 WT 窗口里开新标签，那个新窗口生下来就是缩着的**。
#   于是启动器收尾"判据说留桌面 ⇒ 什么都不做"的写法会落空：引导载体（三步走 + 扫码 + 那一行
#   "下一动作" + 那句一次性告知）被藏进任务栏，正是 §10.1-5 要避免的事。
#   ⇒ 判据为 keep 的那条路上，收尾要**主动确认并放回桌面**，而不是"不缩就不管"。
# 9 = SW_RESTORE（不是 SW_SHOW(5)：缩着的窗口要用 RESTORE 才会回到原来的大小）。
# 与 Set-WindowMinimized 对称：句柄失效**立刻优雅跳过**，不报错、不干等。
function Set-WindowRestored([IntPtr]$Handle, [int]$VerifyMs = 2500) {
    if ($Handle -eq [IntPtr]::Zero) { return $false }
    if (-not [StartAll.Win]::IsWindow($Handle)) { return $false }   # 窗口早就没了：跳过，不报错
    [StartAll.Win]::ShowWindow($Handle, 9) | Out-Null
    $deadline = (Get-Date).AddMilliseconds($VerifyMs)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 150
        if (-not [StartAll.Win]::IsWindow($Handle)) { return $false }
        if (-not [StartAll.Win]::IsIconic($Handle)) { return $true }
        [StartAll.Win]::ShowWindow($Handle, 9) | Out-Null     # WT 偶尔吃掉一次，再试
    }
    return (-not [StartAll.Win]::IsIconic($Handle))
}

# 按句柄还原（去重）；**逐条如实回报**（去重后每个句柄都有一条，包含"本来就在桌面上"的）：
#   @{ Hwnd; Title; Exists; WasIconic; Ok }
#     Exists    = 还找得到这个窗口吗（false = 句柄已经失效，什么都说明不了）
#     WasIconic = 动手**之前**它是不是缩着的（false = 本来就在桌面上，我们没碰它）
#     Ok        = 收尾复查时它确实不在最小化状态（false = 试了没成 / 窗口已经没了）
# 调用方**必须**按这几个字段说话（"本来就缩着，我放回桌面了" / "本来就在桌面上" / "试了没成"），
# 不许在 Ok=$false 时印"已放回桌面"。
function Restore-WindowHandles($Handles) {
    $seen = @{}
    $done = New-Object System.Collections.ArrayList
    $all = @(Get-ConsoleWindows)
    foreach ($h in @($Handles)) {
        $key = [Int64]$h
        if ($key -eq 0 -or $seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $title = ''
        foreach ($w in $all) { if ([Int64]$w.Hwnd -eq $key) { $title = $w.Title; break } }
        $exists = [StartAll.Win]::IsWindow([IntPtr]$key)
        if (-not $exists) {
            [void]$done.Add([pscustomobject]@{ Hwnd = [IntPtr]$key; Title = $title; Exists = $false; WasIconic = $false; Ok = $false })
            continue
        }
        $iconic = [StartAll.Win]::IsIconic([IntPtr]$key)
        $ok = if ($iconic) { Set-WindowRestored -Handle ([IntPtr]$key) } else { $true }
        [void]$done.Add([pscustomobject]@{ Hwnd = [IntPtr]$key; Title = $title; Exists = $true; WasIconic = [bool]$iconic; Ok = [bool]$ok })
    }
    return $done
}
