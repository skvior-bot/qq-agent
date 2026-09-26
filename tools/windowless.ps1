# ============================================================================
#  无窗口启动小库（2026-09-24，P1④：qq-bridge / SnowLuma "不创建窗口"）
#
#  由 tools\start-all.ps1 与 tools\ensure-bridge.ps1 **点源**（dot-source）——
#  两个入口共用这一份实现，"救桥接"与"启动器"不会各自长出一套。
#
#  目标形态（docs\qq-agent-产品设计.md §3.2）：桌面**只留 DSH-Web 一个可见窗口**。
#    · 被否掉的老办法：守窗器（全桌面扫荡着藏窗口）—— 会把主人自己开的窗口一起藏。
#    · 铁律：**全屏扫荡式的自动动作，必须限定在自己创建的对象上**；
#      不创建窗口 = 零误伤，所以选它。
#
#  ★★ 2026-09-24 深夜（第二版，实机测出来的）：这台机器的默认终端宿主是 Windows Terminal，
#     判定链条与"怎么才算真的没有窗口"如下 —— 改这里之前**先读完**：
#
#  ① **机器事实**：系统是 Windows 11（`HKLM\...\CurrentVersion` 的 `ProductName` 仍写
#     "Windows 10 Pro"，但 build 26200 / 25H2 ⇒ **别信 ProductName，看 CurrentBuild**）。
#     `HKCU\Console\%%Startup` 这个键**存在但没有任何值**（用 .NET RegistryKey 复核：
#     `ValueCount=0`）⇒ 没显式配过 DelegationConsole/DelegationTerminal，走的是系统默认，
#     而 25H2 的默认就是 **Windows Terminal**。实测后果：**可见的**控制台进程会被 WT 托管
#     （窗口 owner = `WindowsTerminal.exe`，类名 `CASCADIA_HOSTING_WINDOW_CLASS`，
#     窗口标题 = 我们在命令行里 `title` 的那个名字）—— `DSH-Web` 与 `SnowLuma` 两个窗口就是这么来的。
#
#  ② `Start-Process -WindowStyle Hidden`（本文件第一版的实现）在这台机器上的实测：
#     **不会**被 WT 托管，但会创建一个**隐藏的 conhost 窗口对象**
#     （`ConsoleWindowClass`，owner = cmd，`IsWindowVisible=False`，EnumWindows 查得到）。
#     ⇒ 它做到了"看不见"，但没做到"不存在"；而且它**挡不住回退**：一旦端口没按时就绪，
#     调用方会回退到"开一个可见窗口"那条路，而可见控制台在这台机器上就是**一个 WT 窗口/标签页**
#     —— 主人 2026-09-24 报的"多出来的标签页"正是这么来的（`.launcher-state.json` 里
#     `mode` 写的是「visible（无窗口那条没起来，已自动回退）」）。
#
#  ③ **本文件现在的实现 = 直接调 Win32 `CreateProcess`**，两个标志一起给：
#       · `CREATE_NO_WINDOW` (0x08000000) —— 进程照样有控制台（`chcp` / `timeout` / cmd 的
#         `> log 2>&1` 全部照常），但**不创建任何窗口对象**（连隐藏的都没有）；
#       · `bInheritHandles = FALSE` —— **绝不继承调用者的标准句柄**。
#     实测（本机，探针 `tools\windowless-check.ps1`）：起一个睡觉进程后
#     EnumWindows 前后对比**新增 0 个窗口**（连隐藏窗口都没有）。
#
#  ④ ★ 为什么不用 `System.Diagnostics.ProcessStartInfo.CreateNoWindow`（**尽管它就是那个真标志**）：
#     实测它同样不建窗口（探针里名为 psi 的那一档，新增 0 个窗口），但 .NET Framework 的
#     `Process.Start` 内部把 `bInheritHandles` **写死成 true** ⇒ 子进程会**攥住调用者的 stdout 管道**
#     不放 ⇒ PowerShell 的 `& exe | Out-Host` 永远等不到 EOF ⇒ `control.ps1 up` / `restart *`
#     会**卡死**（第一版探针实测：命令 120 秒不返回；同一份探针换成 ③ 的起法 3.5 秒就返回了）。
#     所以"要哪两个性质"必须自己拿 `CreateProcess` 点名要 —— 这也是**唯一**能同时拿到
#     "不建窗口" + "不继承句柄"的写法。
#     ⚠ 反过来也别把 `bInheritHandles` 改成 true 再配 `STARTF_USESTDHANDLES`：那会把调用者
#       所有可继承句柄（含它的 stdout 管道）一起塞给子进程，等于把上面那个死等重新埋回来。
#
#  ⑤ **为什么输出要"交给 cmd 重定向到文件"，而不是用 RedirectStandardOutput**：
#    · `RedirectStandard*` 是**管道**，读端是调用者（启动器 / control.ps1 / 本脚本）。
#      调用者一退出，管道读端就没了，子进程再往 stdout 写就是**断管**（EPIPE）⇒
#      桥接/网关当场死，而守护看着还在跑（最难查的一种）。这与 `log-run.ps1` 那条红线是同一个坑
#      （删掉它 → `dsh web` 写断管直接退出）。2026-09-24 中午那次"无窗口化把桥接弄死"，
#      就是 `-WindowStyle Hidden` **配** `-RedirectStandardOutput` 干的（见 ensure-bridge.ps1 旧注释）。
#    · 交给 cmd `> log 2>&1` 就没有这个问题：文件句柄是子进程自己的，调用者退出后照样有效，
#      顺带留下一份崩溃现场（桥接真日志仍是 state\bridge.log，这里只是兜底）。
#    · 命令行前面加 `chcp 65001 >nul`：cmd 的重定向按**控制台输出代码页**落盘，
#      不钉 UTF-8 就是 OEM(936) ⇒ 中文日志变乱码。（`CREATE_NO_WINDOW` 下控制台仍在，所以这条照旧有效。）
#
#  ⑥ ⚠ **"起来了没有"的判据必须挑对端口**（2026-09-24 深夜踩的第二个坑）：
#     `CREATE_NO_WINDOW` 起 SnowLuma 完全成功，但调用方原来拿 **3001（OneBot WS）** 当就绪信号，
#     而 3001 要等 QQ 客户端登录/hook 接上才绑（实测 17 秒~几分钟）⇒ 45 秒超时被误判成"没起来"
#     ⇒ 白白杀掉一个好好的无窗口实例、再开一个**可见窗口** ⇒ 主人看到的又是多一个 WT 窗口。
#     **判据要用"进程自己起来了"的信号（SnowLuma 的 WebUI 5099 / 桥接的 3100）**，
#     别拿"外部依赖就绪"（QQ 登录）当判据。
#
#  用法：
#    . (Join-Path $PSScriptRoot 'windowless.ps1')
#    $p = Start-WindowlessProcess -FilePath 'cmd.exe' -WorkingDirectory $dir `
#           -Arguments (New-CmdRedirectLine -Command 'start.bat' -StdOutLog $out -StdErrLog $err)
#    if (-not $p) { 回退到可见窗口 }
#    ... 端口超时没通 → Stop-WindowlessProcess -Process $p（只收自己创建的那一棵）+ 回退
#
#  注意：本文件必须存成「UTF-8 带 BOM」（PS 5.1 否则按 ANSI 解码，中文全乱）。
# ============================================================================

# Win32 CreateProcess 的最小封装（只做一件事：给两个标志点名）。
# 编译一次、整个会话复用（Add-Type 失败时 $script:DshWinlessOk = $false，调用方回退老形态）。
$script:DshWinlessOk = $false
if (-not ('DshWinlessNative' -as [type])) {
    try {
        Add-Type -Namespace DshWinless -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public System.IntPtr lpReserved2;
    public System.IntPtr hStdInput; public System.IntPtr hStdOutput; public System.IntPtr hStdError;
}
[System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
public struct PROCESS_INFORMATION {
    public System.IntPtr hProcess; public System.IntPtr hThread;
    public int dwProcessId; public int dwThreadId;
}
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern bool CreateProcess(string lpApplicationName, System.Text.StringBuilder lpCommandLine,
    System.IntPtr lpProcessAttributes, System.IntPtr lpThreadAttributes, bool bInheritHandles,
    uint dwCreationFlags, System.IntPtr lpEnvironment, string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(System.IntPtr hObject);

// 返回新进程 pid；失败返回 -1（调用方会把 GetLastError 打出来）。
// ★ inherit 永远是 false —— 见文件头 ④，这是"不攥调用者管道"的唯一保证。
public static int Start(string commandLine, string workingDirectory) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = System.Runtime.InteropServices.Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    System.Text.StringBuilder sb = new System.Text.StringBuilder(commandLine);
    // 0x08000000 = CREATE_NO_WINDOW（有控制台、没有窗口对象）；0x00000400 = CREATE_UNICODE_ENVIRONMENT
    uint flags = 0x08000000u | 0x00000400u;
    bool ok = CreateProcess(null, sb, System.IntPtr.Zero, System.IntPtr.Zero, false, flags,
        System.IntPtr.Zero, workingDirectory, ref si, out pi);
    if (!ok) return -1;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);   // 句柄关掉不影响子进程继续活；我们只要 pid
    return pi.dwProcessId;
}
'@ -ErrorAction Stop
        $script:DshWinlessOk = $true
    } catch {
        $script:DshWinlessOk = $false
        Write-Host ('      [警告] CreateProcess 封装编译失败（{0}）—— 退回"隐藏窗口"老形态。' -f $_.Exception.Message)
    }
}

# 组一条"交给 cmd 跑"的命令行（cmd.exe /c "…"）。被 Start-WindowlessProcess 拼进整条命令行。
function New-WindowlessCommandLine {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string]$Arguments = '',
        [string]$WorkingDirectory = ''
    )
    # 文件路径**必须加引号**（Program Files 那种带空格的路径），CreateProcess 的 lpApplicationName 传 null
    # ⇒ 由命令行第一段决定可执行文件，所以它得是一个完整带引号的路径。
    $line = '"' + $FilePath + '"'
    if ($Arguments) { $line += ' ' + $Arguments }
    return $line
}

# 以"桌面上不会出现窗口"的方式起一个进程。成功返回 Process 对象，失败返回 $null（调用方负责回退）。
function Start-WindowlessProcess {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        # 整条参数**作为一个字符串**传（内含 `/c "…"` 的引号，见 New-CmdRedirectLine）。
        [string]$Arguments = '',
        [string]$WorkingDirectory = ''
    )
    # ★ CreateProcess 的 lpCurrentDirectory **必须是绝对路径**（相对路径会被当成"调用者的当前目录"，
    #   于是 cmd 里的相对重定向会落到别处 —— 实测踩过：相对工作目录 + 相对日志路径 ⇒ 日志找不到）。
    $cwd = (Get-Location).Path
    if ($WorkingDirectory) {
        try { $cwd = (Resolve-Path -LiteralPath $WorkingDirectory -ErrorAction Stop).Path }
        catch { $cwd = $WorkingDirectory }
    }

    if ($script:DshWinlessOk) {
        $cmdline = New-WindowlessCommandLine -FilePath $FilePath -Arguments $Arguments -WorkingDirectory $cwd
        $procId = -1
        try { $procId = [DshWinless.Native]::Start($cmdline, $cwd) } catch { $procId = -1 }
        if ($procId -gt 0) {
            try { return (Get-Process -Id $procId -ErrorAction Stop) } catch { }
            # 进程起来又立刻没了（命令行本身错了）：这也算"没起来"，交给调用方回退
            Write-Host '      [警告] 无窗口进程起来后立刻退出（命令行有问题？）。'
            return $null
        }
        Write-Host ('      [警告] 无窗口启动失败（CreateProcess 拒绝：{0}）。' -f $FilePath)
        return $null
    }

    # 兜底：CreateProcess 封装没能编译出来（受限语言模式 / 系统不认）时，退回"隐藏窗口"老形态。
    # ⚠ 这一档做不到"零窗口对象"，也挡不住调用方回退到可见窗口 —— 所以**必须留一句人话**。
    Write-Host '      [警告] 无窗口方式不可用，这次用"隐藏窗口"顶替（桌面上可能多出一个隐藏窗口对象）。'
    $sp = @{ FilePath = $FilePath; WindowStyle = 'Hidden'; PassThru = $true }
    if ($Arguments) { $sp['ArgumentList'] = @($Arguments) }
    if ($WorkingDirectory) { $sp['WorkingDirectory'] = $WorkingDirectory }
    try {
        return (Start-Process @sp)
    } catch {
        Write-Host ("      [警告] 无窗口启动失败：{0}" -f $_.Exception.Message)
        return $null
    }
}

# 组一条"交给 cmd 跑"的命令行（cmd /c "…"），顺带把 stdout/stderr 落到文件。
# · 外层那对引号是 cmd /c 的规矩：首字符是引号时它会剥掉**首尾各一个**引号，
#   所以整条命令必须再包一层（`> "out" 2> "err"` 里的引号因此不会被吃掉）。实测通过。
# · 只给 StdOutLog 时用 `2>&1` 合并，崩溃信息不会丢。
function New-CmdRedirectLine {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [string]$StdOutLog = '',
        [string]$StdErrLog = ''
    )
    $line = 'chcp 65001 >nul & ' + $Command
    if ($StdOutLog) { $line += ' > "' + $StdOutLog + '"' }
    if ($StdErrLog) { $line += ' 2> "' + $StdErrLog + '"' } elseif ($StdOutLog) { $line += ' 2>&1' }
    return ('/c "' + $line + '"')
}

# 收掉**我们自己创建的那一棵**进程树（自动回退前先把失败的尝试收干净，免得留半死不活的实例）。
# ★ 只按手里这个 pid 收（taskkill /T）—— 不做任何"按名字扫荡"，那正是守窗器被否掉的那条路。
function Stop-WindowlessProcess {
    param([System.Diagnostics.Process]$Process)
    if (-not $Process) { return $false }
    $procId = 0
    try { $procId = [int]$Process.Id } catch { return $false }
    if ($procId -le 0) { return $false }
    try {
        if ($Process.HasExited) { return $true }
    } catch { }
    try { & taskkill.exe /PID $procId /T /F 2>&1 | Out-Null } catch { return $false }
    # 复查"真没了没有"：taskkill 是异步生效的，而 Process 对象的 HasExited 有时要先 Refresh
    # 才更新（实测：进程其实已经被收掉，HasExited 仍报 False）⇒ 直接问系统，最多等 3 秒。
    foreach ($i in 1..6) {
        Start-Sleep -Milliseconds 500
        if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { return $true }
    }
    return $false
}

# 自动回退时的那句"人话"（**只有这一份文案**：启动器与 ensure-bridge 都用它）。
# 规矩：不许静默失败、不许留半死不活的状态 —— 说清楚"后台方式没起来""已经换回窗口方式"。
function Write-WindowlessFallback {
    param([string]$What = '后台方式')
    Write-Host ('      [回退] {0}没起来，已经换回窗口方式 —— 有事看那个窗口。' -f $What)
}
