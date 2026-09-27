<#
dsh-prompt.ps1 —— DSH 窗口（tools\dsh-window.cmd）里的中文提示 / 后台看守 DSH / 读一行决定去留。

为什么中文不写在 .cmd 里：cmd 按 OEM 码页解析 .cmd，中文会把批处理解析搞崩 —— 项目红线是
`.cmd` / `.bat` 纯 ASCII。所以中文一律收在这个脚本里，由窗口脚本调用。
本文件必须存成 UTF-8 **带 BOM**（PS 5.1 读无 BOM 的 UTF-8 会按 GBK 解码：中文全乱，极端
情况下连引号都被吃掉）；tools\self-check.mjs 会查这一条。

用法（都由 tools\dsh-window.cmd 调）：
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File tools\dsh-prompt.ps1 -Mode run    -Node <node.exe> -Bin <dsh\lib\bin.js> -Tools <tools目录> -Log <日志>
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File tools\dsh-prompt.ps1 -Mode start  -Log <日志>
  powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File tools\dsh-prompt.ps1 -Mode prompt -Log <日志>

只打印、不交互（验收与回归用；**不进交互、不拉起 DSH、不碰任何服务**，跑完立即 exit 0）：
  ... -File tools\dsh-prompt.ps1 -PrintBanner           # 打印真横幅（与交互模式同一个渲染函数）
  ... -File tools\dsh-prompt.ps1 -Help                  # 打印 "?" 那一屏（全部键位 + 高级信息）
  ... -File tools\dsh-prompt.ps1 -WatchOnce             # 只跑一次"出事自己跳出来"的判定并打印结论（**不碰任何窗口**）

窗口看守（§10.1-5「出事自己跳出来」，2026-09-24 第五批）：
  · 引导做完以后 DSH-Web 会**缩进任务栏**（缩不缩由 tools\start-all.ps1 按 tools\onboard.ps1 的判据决定），
    于是 `e`（关闭全部）/ `r`（重起+自动修）这两个**出事时最需要的键**就被藏起来了 ⇒ 五灯不绿时
    **窗口自己 restore + 置前 + 把那一行"下一动作"打出来**；绿灯时安静缩着。
  · 四条硬规矩（少一条就会变成骚扰）：① **边沿触发**（只在"从绿变红的那一次"跳，红了就一直弹 = 骚扰）；
    ② **尊重主人意图**（他刚自己缩下去的一段时间内不弹回去，冷却默认 5 分钟，弹是被**推迟**不是取消）；
    ③ **探活廉价**（每 15 秒一次 TCP 探活当**触发器**；给人看的那句话仍**只来自** control.ps1 status
    —— 探测是触发器、**不是第二份判定**）；④ **抢不到前台要如实说**（Windows 不让后台进程抢，就照实讲）。
  · `-NoWatch` 可以整个关掉它（逃生阀）。
  · ★ **已知启动窗口不弹**（2026-09-24 晚，主人实拍那屏"上一行说桥接掉了会自动拉起来、不用再按 b，
    下一行却叫你按 r"）：control 层给的 `status.starting.active` 为真（刚发起启动/重启的 45 秒内，判定在
    tools\starting-window.mjs 一处）⇒ 桥接这几秒没监听是预期内的，**不 restore、不置前、不印"按 r"**；
    宽限期一过（active=false）照旧跳出来 —— 判据本身**没有变松**，只是"正在起"这一段不当作红。
  · ★ **WT 坑（2026-09-24 查实）**：`GetConsoleWindow()` 在 **Windows Terminal** 里拿到的是**伪控制台
    窗口**，它的 `IsIconic` **不跟随 WT 主窗口** —— "窗口缩着没有"与"把窗口叫回来"这两件事都不能只靠它。
    所以两处都加了按**窗口标题**（DSH-Web / dsh web，模式取自 tools\minimize-windows.ps1）找真窗口的
    那一半：判断缩没缩 = **两个判据取更保守的**（任一缩着就算缩着 ⇒ 那句一次性告知不记账，下次再说）；
    叫回窗口 = **先对真窗口 SW_RESTORE 再置前**，没还原成 / 抢不到前台都**如实说**。
  · 一次性告知（**只说一次**，§10.1-5）：引导完成后的第一次启动，补一句
    `以后我会缩到任务栏，出问题了它自己会跳出来` —— 记账在 state\onboarded.json 的 noticeShownAt，
    由 tools\onboard.ps1 落盘（本文件只消费它的结论）。

横幅规则（docs\qq-agent-产品设计.md §10.3 / §10.4 / §10.5，2026-09-24 立）：
  · 全绿且引导做完 = **3 行**：状态行（= control.ps1 那行"下一动作"，原样印）/ 地址行 / 按 ? 看全部；
  · 任何时候都有一句"你现在该做什么"（§10.1-1），来源只有 tools\control.ps1 status（§3.1：
    同一个动作只有一份实现）—— 本文件**不探端口、不拼判定**；
  · 引导语里不出现端口 / 令牌 / preset / MCP / session / 日志路径（§10.1-2），这些只在 `?` 后面；
  · 首启没走完时印"三步走"并把当前进度标出来（§10.2；步骤表是可扩展结构，将来 §10.6 选模式、
    §10.7 白名单就是往表里加项）。

-Mode run（2026-09-23 第五版；主人原话："把窗口改成'后台跑 DSH + 前台守输入'的形态"）：
  · 把 DSH 起成**同一个窗口里的后台进程**：
      cmd /c "node <bin.js> web --no-open 2>&1 | powershell -File log-run.ps1 <日志>"
    —— 输出照旧落 guard 日志；**这条不能改**：qq-bridge 就是从那本日志里发现启动令牌的。
  · 前台循环一边等它、一边收键盘：**DSH 正在跑的时候也能随时输 e（或 exit）回车 = 关闭全部**，
    输 r 回车 = 重起 DSH（先把现在这个收掉，外层会换一本新日志再起）；
  · DSH 自己停了（Ctrl+C / 崩了）→ 出"接下来做什么"的提示，也就是 -Mode prompt 那套；
  · 键盘我们是**自己回显**的（ReadKey 拦截模式），中文输入法打的字回显不出，请用 e / r 这种 ASCII。

退出码（dsh-window.cmd 只看这个；三个模式口径一致）：
  0 = 关闭全部（DSH + SnowLuma + qq-bridge）  ← 输入 e / exit / close / quit / q / 退出
  1 = 只重新启动 DSH                          ← 直接回车 / r / restart / dsh / 重起
  2 = 输入已结束（没有控制台、脚本化运行）    ← 按"关闭全部"处理，避免无限重启
  9 = 本脚本自己出错（罕见）                  ← 也按"关闭全部"处理，绝不空转重起
#>
param(
    [ValidateSet('prompt', 'start', 'run')][string]$Mode = 'prompt',
    [string]$Log = '',
    [string]$Node = '',
    [string]$Bin = '',
    [string]$Tools = '',
    # 只给探针用：当作"已经敲了这些键"（沙箱里没法真敲键盘；\r 或 \n 代表回车）
    [string]$AutoType = '',
    # ★ 只打印横幅：不进交互、不拉起 DSH、不碰任何服务，跑完 exit 0（验收与回归的一条命令）
    [switch]$PrintBanner,
    # 只打印 `?` 那一屏（全部键位 + 端口 / 令牌 / 日志路径等高级信息）
    [switch]$Help,
    # ★ 只跑一次窗口看守的判定并打印结论（**不碰任何窗口**、不进交互、跑完 exit 0）——
    #   "出事自己跳出来"这件事的只读验收入口；配合下面三个钩子能验出三态（见 Get-WatchOnceState）。
    [switch]$WatchOnce,
    # ★ 只跑一次"DSH 到底停了没有"的判定并打印结论（**不碰任何窗口、不拉任何进程**、跑完 exit 0）——
    #   主人 2026-09-24 那两次"已停止"里，一次是真掉线、一次是**假警报**（详见 Resolve-DshStop）。
    #   两个注入值在下面（DSH_WINDOW_CHILD_EXITED / DSH_WINDOW_DSH_ALIVE），正常流程一律不设。
    [switch]$CheckStopOnce,
    # ★ 只跑一次"判死之后到底动不动手"的**全表**（纯函数 + 注入式验收；**不探真端口、不碰窗口、不拉进程、
    #   不发 QQ**、跑完 exit 0）—— 主人 2026-09-25 20:1x 定的两条硬判据各占一行：
    #     ① **有会话在跑 ⇒ 宁可不拉**（绝不许把正在跑的回合连人带活杀掉）：注入 DSH_WINDOW_SESSIONS_BUSY=1
    #     ② **真死也要给他一条 QQ**（自动修关着时那是他唯一的告警）：开关关着 / 记账写不进 / 到上限
    #   注入：DSH_WINDOW_SESSIONS_BUSY=1|0、DSH_WINDOW_AUTORESTART_OFF_FILE（指到临时文件）等。
    [switch]$CheckDeathGate,
    # ★ 只跑一次"QQ 没登录要不要提示"的**两态表**（纯函数 + 注入式验收；**不碰窗口、不碰服务、不发 QQ**、
    #   跑完 exit 0）—— 主人 2026-09-26 原话：「qq 我之前忘记登录了 … 这个没有自动登陆的功能 要加个提示才行」。
    #   事实经过：他昨晚扫码后以为好了、实际没登录，只从窗口里那行红字才看出来 —— **而那行他没看见**。
    #     ① QQ ✗ ⇒ 标题必须带 ⚠（`⚠QQ 未登录 — DSH-Web`）
    #     ② QQ ✓（恢复）⇒ 标题必须回到**无 ⚠ 的基线** `DSH-Web`
    #   两条都要看得见：只做"出现"不做"消失"，就是新的狼来了。
    [switch]$CheckQqAlert,
    # ★ 只跑一次"状态变了要不要重印那几行"的判定（**不碰任何窗口**、跑完 exit 0）。
    #   不注入 = 拿当前真实状态当"刚印过的那份" ⇒ 应当**不重印**（稳态不刷屏的证明）；
    #   想验"变了会重印"就注入 `$env:DSH_WINDOW_STATUS_JSON_PREV`（上一份状态的 JSON 文件）。
    [switch]$StatusOnce,
    # ★ 只跑一次"频率告警要不要报"（**不碰任何窗口**、跑完 exit 0）：短时间连着自动拉起好几次 ⇒
    #   主动报错（主通道 QQ + 次通道窗口红字）。注入：DSH_WINDOW_AUTORESTART_FILE（账本指到临时文件）+
    #   DSH_WINDOW_CONSOLE_MINIMIZED（1/0 顶替"窗口缩着没有"）。计数器与上限共用同一套数。
    [switch]$FlapOnce,
    # ★ 只跑一次"这一代是谁拉起来的"判定（**不碰任何窗口**、跑完 exit 0）：主人手动按 r 之后**不许**印
    #   "我已经把它拉回来了"（2026-09-25 修的 bug），而且手动重起**不计入自动拉起次数**。
    #   注入：DSH_WINDOW_AUTORESTART_FILE（账本指到临时文件）；`DSH_WINDOW_RECORD_MANUAL=1` 时**真记一次**
    #   manual 事件（验"记了来源、但计数不动"）。
    [switch]$RestartSourceOnce,
    # ★ 只跑一次"r 之后缺的服务怎么补"的判定（**不碰任何窗口、不起任何服务**、跑完 exit 0）——
    #   控制面（:3101）是裸 cmd 起的、没有守护，见 Resolve-MissingServices 的注释。
    #   两个注入值：DSH_WINDOW_DSH_ALIVE / DSH_WINDOW_CONTROL_ALIVE（正常流程一律不设）。
    [switch]$EnsureOnce,
    # 逃生阀：整个关掉窗口看守（缩进任务栏后不想让它自己冒出来的人用）
    [switch]$NoWatch
)

$CloseWords = @('e', 'exit', 'close', 'quit', 'q', '退出', '关')
$RestartWords = @('', 'r', 'restart', 'dsh', '重起', '重启')
# DSH 正在跑的时候，"直接回车"没有意义（不重起），所以那份词表不带空串：
$RestartWordsRunning = @('r', 'restart', 'dsh', '重起', '重启')

# 只给探针用：沙箱里没法真敲键盘，所以允许从环境变量喂"已经敲了的键"
# （和 DSH_WINDOW_STOPALL 一样是测试钩子，正常启动流程不会设它）。
if (-not $AutoType) { $AutoType = [string]$env:DSH_WINDOW_AUTOTYPE }

# 路径消毒：.cmd 那边可能传来"以反斜杠结尾"的值（`-Tools "D:\...\tools\"` 里的结尾引号会被
# cmd 吃掉，值里就混进一个引号）→ Join-Path 报 "Illegal characters in path"（实测踩过）。
foreach ($name in @('Log', 'Node', 'Bin', 'Tools')) {
    $v = [string](Get-Variable -Name $name -ValueOnly)
    if ($v) { Set-Variable -Name $name -Value ($v.Trim().TrimEnd('\', '"')) }
}

$logText = if ($Log) { $Log } else { '（本窗口的 guard 日志）' }

# ── 端口唯一来源（P2⑦ 参数单一来源）────────────────────────────────────────
# 默认值表只有一处（qq-bridge\src\config-lib.js 的 DEFAULT_PORTS），生效值由仓库根的
# agent.config.json 决定 —— 这里问 Node 要（为什么这么绕，tools\env-config.ps1 文件头写了）。
# 本文件里的地址行 / 探活触发器 / 提示文本全部从 $Ports 派生，一个字面量都不抄。
. (Join-Path $PSScriptRoot 'env-config.ps1')
# ★ 控制面的**唯一一份起法**（2026-09-26）：补缺那只手要用它 —— QQ 不在本机时**只补控制面**，
#   绝不走启动器（那会把 SnowLuma / 桥接起出来抢号），也绝不另写第二份起法。
. (Join-Path $PSScriptRoot 'control-plane.ps1')
$Ports = Get-AgentPorts
$DshPort = $Ports.dshWeb              # DSH Web
$BridgePort = $Ports.bridgeConsole    # 桥接控制台
$SnowLumaPort = $Ports.snowlumaWs     # SnowLuma 的 OneBot WS（探活触发器用它）
$SnowLumaWebPort = $Ports.snowlumaWeb # SnowLuma 管理页
# 控制面（页面总控面板的载波，tools\control-server.mjs）—— 它**不在控制台那五个端口里**
# （ops.mjs status 的端口表没有它），所以这里单独拿一份：r 之后"缺的服务一起补起"要判它。
$ControlPort = $Ports.bridgeControl   # 页面面板控制面（载波；它不在控制台那五个端口里，所以单独拿一份）

function Initialize-ConsoleUtf8 {
    # 打印任何中文之前，先把控制台输出码页钉成 65001 并等它生效（重定向时不动，免得改变抓取口径）。
    # 为什么自己做：`cmd` 里那句 `chcp 65001` 在**窗口刚创建**时可能没生效。实测（2026-09-24，
    # 读屏幕缓冲区）"中文双写"只出现在**子进程起来之前**打的那两行上 —— 同一个窗口里那两行是
    # `6B63 6B63 5728 5728 …`（每个汉字占两格），之后打的（含按 r 重起后重打的横幅）都是干净单字。
    # 唯一被证据支持的不变量是"打印时码页必须是 65001"，所以这里把它钉住并轮询确认。
    # ⚠ 机制还没钉死（为什么码页没切过去时汉字会占两格）—— 下次复现请用
    # tools\console-screen-dump.ps1 读现场，并顺手记下窗口"属性 → 字体"里的字体名。
    # 2026-09-23 那次"重启后不复现"疑与码页/字体按控制台缓存有关（同一窗口第二次打印就正常）。
    if ([Console]::IsOutputRedirected) { return }
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    for ($i = 0; $i -lt 10; $i++) {
        $cp = 0
        try { $cp = [int]((& chcp.com) -replace '\D', '') } catch { $cp = 0 }
        if ($cp -eq 65001) { return }
        Start-Sleep -Milliseconds 200
    }
    # 钉不上（字体真的不支持）也别卡住：照常打印，最坏就是回到"双写"的老样子。
}
Initialize-ConsoleUtf8

# ── 横幅（docs\qq-agent-产品设计.md §10.3 / §10.4 / §10.5）──────────────────────
# 三条硬规矩：
#   ① 状态与"下一动作"**只来自** tools\control.ps1 status -Json（§3.1：同一个动作只有一份实现）
#      —— 本文件不探端口、不拼判定；control 跑不起来就照实说"读不到状态"。
#   ② 引导语里不许出现端口 / 令牌 / preset / MCP / session / 日志路径（§10.1-2），
#      这些只在 `?` 那一屏（Show-Banner -Help）。
#   ③ 任何时候都有一句"你现在该做什么"（§10.1-1）= control 那行 nextAction，**原样印**。
#
# 测试钩子（和 DSH_WINDOW_AUTOTYPE 一个路子；正常启动流程不设它）：
#   $env:DSH_WINDOW_STATUS_JSON = <一份 control.ps1 status -Json 形状的 JSON 文件路径>
#   —— 用它顶替真实状态，"引导未完成""桥接断了"这类态就能**不碰真实状态文件**地验一遍。
function Get-ControlStatus {
    $hook = [string]$env:DSH_WINDOW_STATUS_JSON
    if ($hook) {
        try { return ([System.IO.File]::ReadAllText($hook, [System.Text.Encoding]::UTF8) | ConvertFrom-Json) }
        catch { return $null }
    }
    $ctl = Join-Path $PSScriptRoot 'control.ps1'
    if (-not (Test-Path $ctl)) { return $null }
    try {
        # 照抄 control.ps1 的 Invoke-CaptureUtf8 思路，但多一道保险（2026-09-24 实测的坑）：
        # 子进程用 `-File` 起、stdout 又被重定向时，PS 5.1 会按 **OEM 码页(936)** 写中文 ⇒ 我们这边
        # 按 UTF-8 解码就得到"һ������"这种不可恢复的乱码（横幅第一行当场花掉）。
        # 所以子进程里**先显式把输出编码钉成 UTF-8**，命令行用 -EncodedCommand 传（顺带免掉引号转义）。
        $cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & ' + "'" + $ctl + "'" + ' status -Json'
        $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $enc
        $psi.WorkingDirectory = (Split-Path $PSScriptRoot -Parent)
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = (New-Object System.Text.UTF8Encoding($false))
        $psi.StandardErrorEncoding = (New-Object System.Text.UTF8Encoding($false))
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEnd()
        $p.WaitForExit()
        if (-not $out.Trim()) { return $null }
        # 只取最外那对花括号：万一有额外输出混进来，也不至于整个 JSON 解析失败
        $a = $out.IndexOf('{'); $b = $out.LastIndexOf('}')
        if ($a -lt 0 -or $b -le $a) { return $null }
        return ($out.Substring($a, $b - $a + 1) | ConvertFrom-Json)
    } catch { return $null }
}

# 首启第 ③ 步（"在 QQ 里发过话"）有没有验过：§10.2 的 state\onboarded.json —— **容错读**。
# 文件不在 / 读不了 → 一律沿用 control.ps1 的推断（$status.onboarded.done），
# **绝不自己发明第二套判定**。（完成态的**写**归 tools\onboard.ps1，本文件只读。）
function Get-HelloVerified($status) {
    $inferred = [bool]$status.onboarded.done
    $f = Join-Path (Split-Path $PSScriptRoot -Parent) 'qq-bridge\state\onboarded.json'
    if ($env:DSH_ONBOARD_FILE) { $f = [string]$env:DSH_ONBOARD_FILE }   # 测试钩子（与 onboard.ps1 同名同义）
    if (-not (Test-Path $f)) { return $inferred }
    try {
        $o = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if (@($o.PSObject.Properties.Name) -contains 'firstMessageVerified') { return [bool]$o.firstMessageVerified }
        return [bool]$o.completedAt
    } catch { return $inferred }
}

# ── 「引导做完没有」与一次性告知：判定/落盘都在 tools\onboard.ps1（§10.1-5）────────
# 本文件只**消费**：拿它给的 notice（那句话的文案只有一份）、done、decision。
# 抓法与 Get-ControlStatus 同一套（子进程 -File + stdout 被重定向时 PS 5.1 会按 OEM 码页写中文）。
function Get-OnboardState([switch]$ReadOnly) {
    $ob = Join-Path $PSScriptRoot 'onboard.ps1'
    if (-not (Test-Path $ob)) { return $null }
    try {
        $extra = if ($ReadOnly) { ' -DryRun' } else { '' }
        $cmd = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & ' + "'" + $ob + "'" + ' -Json' + $extra
        $enc = [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($cmd))
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = 'powershell.exe'
        $psi.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ' + $enc
        $psi.WorkingDirectory = (Split-Path $PSScriptRoot -Parent)
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = (New-Object System.Text.UTF8Encoding($false))
        $psi.StandardErrorEncoding = (New-Object System.Text.UTF8Encoding($false))
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        $out = $p.StandardOutput.ReadToEnd()
        $p.WaitForExit()
        if (-not $out.Trim()) { return $null }
        $a = $out.IndexOf('{'); $b = $out.LastIndexOf('}')
        if ($a -lt 0 -or $b -le $a) { return $null }
        return ($out.Substring($a, $b - $a + 1) | ConvertFrom-Json)
    } catch { return $null }
}

# 便宜闸门：**只读** state\onboarded.json 的两个字段，判断"值不值得去问 onboard.ps1 一趟"。
# 为什么要这个闸门：交互横幅每开一次窗就跑一次，而 onboard.ps1 要问 control.ps1（约 2~4 秒）——
# 而"有没有那句话要说"只取决于这两个字段。**判定本身仍在 onboard.ps1**（这里只是"要不要去问"）。
# ★ 文件**还不在**时也返回 $true：那意味着这一轮可能正好把完成态落下来（onboard.ps1 会顺手 latch），
#   而落下来的那一轮正是"第一次要说那句告知"的一轮 —— 别因为"文件还没有"就把那句话漏掉一轮。
function Test-OnboardNoticeCheap {
    $f = Join-Path (Split-Path $PSScriptRoot -Parent) 'qq-bridge\state\onboarded.json'
    if ($env:DSH_ONBOARD_FILE) { $f = [string]$env:DSH_ONBOARD_FILE }   # 测试钩子（与 onboard.ps1 同名同义）
    if (-not (Test-Path $f)) { return $true }
    try {
        $o = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        if (-not [string]$o.completedAt) { return $false }
        if ([string]$o.noticeShownAt) { return $false }
        return $true
    } catch { return $false }
}

# 按**窗口标题**找"我们这个控制台窗口"的句柄 —— 不依赖 GetConsoleWindow 的那条兜底。
# 复用启动器那套窗口库（tools\minimize-windows.ps1：认窗口 / 枚举 / 最小化 / 还原**只有那一份实现**），
# 连"哪个标题算 DSH-Web"也取它的 $script:DshWindowTitlePatterns（别在两处各写一遍通配符）。
# ⚠ 为什么是"每次调用都点源一次"：`.` 在**函数里**点源，定义只落进这个函数的**局部**作用域
#   （出了函数就没了）⇒ 没法"进一次就常驻"；而小库自己对 Add-Type 做了**类型判重**，
#   第二次起点源只花几毫秒，所以这个写法既不拖慢开窗、也不会在热路径上编译 C#。
function Get-DshConsoleWindowHandles {
    try {
        $lib = Join-Path $PSScriptRoot 'minimize-windows.ps1'
        if (-not (Test-Path $lib)) { return @() }
        . $lib
        return @(Get-DshConsoleWindows | ForEach-Object { $_.Hwnd })
    } catch { return @() }
}

# 窗口是不是缩着的（一次性告知只在**看得见**的时候才算"说过了"）。
# ★ 2026-09-24（主人双击 一键启动.cmd 后 DSH-Web 自己缩进了任务栏，那句告知却被记了账）：
#   `GetConsoleWindow()` 在 **Windows Terminal** 里拿到的是**伪控制台窗口**（tools\list-windows.ps1
#   里能看到的 PseudoConsoleWindow），它的 IsIconic **不跟随 WT 主窗口** —— 窗口明明缩着却判成
#   "看得见" ⇒ 那句一次性告知照样记账，而人根本没看见（正是这套机制要防的事）。
#   ⇒ 加一条按**窗口标题**找真窗口的兜底，两个判据**取更保守的那个**：任一认为缩着 ⇒ 当作缩着
#     （⇒ 不记账，下次开窗再说）。方向是"宁可下次再说，也不能让人没看见"。
#   ⚠ 标题命中的窗口**可能不止一个**（WT 复用窗口 / 另有 WT 窗口开着 DSH-Web 标签）：任一缩着
#     就算缩着 —— 这个方向的误判代价只是"告知晚一次再说"，是我们要的那一侧。
function Test-ConsoleMinimized {
    if (-not (Initialize-WindowWatchType)) { return $false }
    try {
        $h = [DshWin.W]::GetConsoleWindow()
        if ($h -ne [IntPtr]::Zero -and [DshWin.W]::IsIconic($h)) { return $true }
    } catch { }
    foreach ($h in @(Get-DshConsoleWindowHandles)) {
        try {
            if ($h -and $h -ne [IntPtr]::Zero -and [DshWin.W]::IsIconic([IntPtr]$h)) { return $true }
        } catch { }
    }
    return $false
}

# 把"一次性告知"打出来，并记账（记账走 onboard.ps1 -NoticeShown，本文件不自己写状态文件）。
# $Probe = 只读探针（-PrintBanner / -WatchOnce）：只预览，**不记账**。
function Show-OnboardNotice {
    param([switch]$Probe, $Onboard)
    $st = $Onboard
    if (-not $st) { $st = Get-OnboardState }
    if (-not $st) { return }
    if (-not [bool]$st.noticePending) { return }
    Write-Host ('   ★ ' + [string]$st.notice)
    if ($Probe) { return }
    if (Test-ConsoleMinimized) {
        # 窗口是缩着的 ⇒ 这句话主人其实**没看见** ⇒ 不记账，下次开窗再说
        return
    }
    $ob = Join-Path $PSScriptRoot 'onboard.ps1'
    if (Test-Path $ob) {
        try { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $ob -NoticeShown | Out-Null } catch { }
    }
}

# 首启引导的步骤表（§10.2）。★ 故意做成**可扩展的小结构**、不写死 3 个字面量：
# 将来 §10.6「选模式」是第 0 步（插到最前）、§10.7「加白名单」紧跟其后（只在模式②出现）——
# 都只是往这个数组里加一项，下面的渲染与编号不用改。
function Get-OnboardSteps($status) {
    $L = $status.lights
    $steps = @()
    $steps += @{
        key    = 'start'
        text   = '正在启动…'
        who    = '机器'
        # 三个勾逐个亮（DSH ✓ 桥接 ✓ SnowLuma ✓）
        checks = @(
            @{ label = 'DSH';      on = [bool]$L.dsh },
            @{ label = '桥接';     on = [bool]$L.bridge },
            @{ label = 'SnowLuma'; on = [bool]$L.snowluma }
        )
        done   = ([bool]$L.dsh -and [bool]$L.bridge -and [bool]$L.snowluma)
    }
    $steps += @{
        key  = 'login'
        text = '用手机 QQ 扫这个码（按 s，扫码页会自己开出来）'
        who  = '人'
        done = [bool]$L.qq
    }
    $steps += @{
        key  = 'hello'
        # ★ 2026-09-24 晚（脱敏那路报的交付缺陷）：这里原来**硬写着「小懒鲸」** ✗ —— 新用户跑第一遍
        #   引导时，屏幕上会出现**别人的机器人名字**。改成走环境层的现成入口 `Get-AgentBotName`
        #   （环境层 displayName → 网关登录昵称 → 最后才退到中性的「你的机器人」）——
        #   **复用它，不再抄第二份判据**（那个函数在 tools\env-config.ps1 里，唯一入口）。
        text = ('在 QQ 里找到「{0}」，发一句"你好"' -f (Get-AgentBotName $status))
        who  = '人'
        done = (Get-HelloVerified $status)
    }
    return $steps
}

# "下一动作"在**本载体**（DSH-Web 窗口：手上有几个键可按）上怎么按 —— 只说按哪个键，
# 绝不出现端口 / 令牌 / 脚本路径（§10.1-2）。control 给的 action 是**枚举**：
#   up | restart | login | pages | none（认不出来的值一律**不补**"怎么做"那一截，绝不瞎猜）。
# 兼容老形态：nextAction 是**字符串**时（旧 JSON / 手写的测试钩子）原样返回。
function Format-NextActionLine($next) {
    if (-not $next) { return '' }
    if ($next -is [string]) { return [string]$next }
    $text = [string]$next.text
    if (-not $text) { return '' }
    $how = switch ([string]$next.action) {
        'up'      { '按 r 起它' }
        'restart' { '按 r（会自动修）' }
        'login'   { '按 s' }
        'pages'   { '按 w' }
        default   { '' }
    }
    if (-not $how) { return $text }
    return ($text + ' → ' + $how)
}

function Show-BannerCore {
    param([switch]$Help, $Status)
    $rule    = '  ' + ('─' * 62)
    $keyLine = '   按键  e 关闭全部 ｜ r 重起+自动修 ｜ s 登录 QQ ｜ 按 ? 看全部键位与高级信息'
    $status  = if ($Status) { $Status } else { Get-ControlStatus }

    if ($Help) {
        # `?` 那一屏：全部键位 + 高级信息（端口 / 令牌 / 日志路径）—— 给排障的人，不给普通用户。
        Write-Host ''
        Write-Host '  ── 全部键位（在这个窗口里输入 + 回车）──────────────────────────'
        Write-Host '   e   关闭全部（DSH + SnowLuma + qq-bridge）'
        Write-Host '   r   重起 DSH（顺带自动同步令牌；桥接掉了会自动拉起）'
        Write-Host '   s   登录 QQ（扫码；换了浏览器 / 页面问密钥时按它）'
        Write-Host '   a   归档当前对话 + 开一条新的（步数多了就按它；归档 = 进历史、只读、不删数据）'
        Write-Host '   ?   这一屏'
        Write-Host '   b   手动再救一次桥接（平时不用按：r 之后会自动做）'
        Write-Host '   w   把三个页面开进你正在用的浏览器'
        Write-Host '   l   看 SnowLuma 日志尾巴'
        Write-Host '   u   再打一遍三个地址'
        # ★ 2026-09-24（主人："重启之后浏览器里的标签页要刷新不然不显示，然后是 snowluma 刷新后没用、
        #   会新开一个"）：这两件事各只有**一个**正确动作，所以写在键位表下面（普通人会看的那半屏），
        #   不塞进「高级」。两句话都要说人话 + 给动作：
        #   · 页面空着 = 那张页是在服务起来之前加载的、没加载成功 ⇒ F5 一次就回来
        #     （DSH 认的是登录 Cookie，不吃地址栏里那个启动令牌 —— 所以刷新**真有用**）。
        #   · SnowLuma 那页正好相反：令牌只能由同源的自动登录页写进浏览器，旧页面自己拿不到 ⇒
        #     刷新一辈子没用，必须**重开一张**（按 s = 换令牌 + 重开；这不是毛病，是它的机制）。
        Write-Host '  ── 本对话的步数 / 什么时候该归档 ────────────────────────────'
        Write-Host '   状态行**平时不带**"本对话 N 步 / M 轮 · ¥花费"（2026-09-25 主人嫌啰嗦 ⇒ 只在"到档（≥200 步）/ 已授权归档"时才冒出那一格，且不带精确数；精确值看本屏上面那几行或页面右上）'
        Write-Host '   那个 ¥ 是官方闲时价折算的参考值（不是账单，账单看 tools\usage-report.mjs）；读不到就不显示'
        Write-Host '   到 200 步会提醒一次、到 400 步再提醒一次（同一个对话同一档只说一次；读不到就不说）'
        Write-Host '   要换新对话就按 a：这条归档进历史（只读、不再收消息、不删），并开一条新的；然后页面上按 F5'
        Write-Host '   到档时也会给你 QQ 私聊发一条确认问话（回「归档」就归档并开新的、回「取消」这次不动）—— 人不在电脑前也能办。'
        Write-Host '   回过一次「归档」就够了：那条线还在跑的话，它**跑完会自动归档**（不再问你第二次）；想反悔回「取消」。'
        Write-Host '   只有你按 a（或在 QQ 里回「归档」）才会动；永远不会自动删 —— 归档只是收起来，数据不删、你随时能捞回来'
        Write-Host '  ── 补缺（"控制面没在监听 ⇒ 只补起缺的服务"那一套）────────────────'
        Write-Host '   **默认不打屏**了（2026-09-25 主人：这个补缺可以去掉不显示吧）——成功/无事可做的流水静默，细节全落'
        Write-Host '   `qq-bridge\state\launcher-repair.log`（排查看它）；只有**失败**与**判不准**才打一行（那正是要你动手的时候）'
        Write-Host '   想看全部流水：启动前 `set DSH_WINDOW_REPAIR_VERBOSE=1`'
        Write-Host '   那条补缺路**不再强制窗口留桌面**：正常启动 / 掉线自愈 / 补缺，一律按引导判据最小化'
        Write-Host '  ── 刚重启完电脑，页面不对劲时 ──────────────────────────────'
        Write-Host '   网页空白 / 什么都没有  →  在那张页面上按 F5，一次就回来'
        Write-Host '   SnowLuma 那页刷新没用（旧页面拿不到新令牌）→ 按 s 重开一张，旧的关掉就行'
        # ★ DSH 停了会怎样（2026-09-24 晚）：这一段是给"他不在旁边、回来看到一屏东西"时看的 ——
        #   说清"它自己会做什么"比让他记住机制重要。
        Write-Host '  ── DSH 停了会怎样（不用你记着）─────────────────────────────'
        Write-Host '   它自己会先重起一次（10 分钟内最多 3 次），拉回来了会告诉你"刚才掉过"'
        Write-Host '   连着 3 次都没起来 → 这个窗口会**红着跳出来**（那是此刻唯一还能用的通道）'
        Write-Host '   缺的服务（页面面板那条）按 r 之后会一起补起；补不起来会如实说'
        Write-Host '  ── 高级（排障用，平时不用看）──────────────────────────────────'
        Write-Host "   地址   DSH http://127.0.0.1:$DshPort ｜ 桥接控制台 http://127.0.0.1:$BridgePort ｜ SnowLuma http://127.0.0.1:$SnowLumaWebPort"
        Write-Host ('   日志   {0}' -f $logText)
        if (-not $status) {
            Write-Host '   状态   读不到（tools\control.ps1 status 没跑起来）'
        } else {
            $ports = @()
            foreach ($p in @($status.ports)) {
                $ports += ('{0}:{1} {2}' -f $p.label, [int]$p.port, $(if ($p.open) { 'OK' } else { 'DOWN' }))
            }
            Write-Host ('   端口   ' + ($ports -join ' ｜ '))
            Write-Host ('   令牌   {0} / 日志 {1}（同步：{2}）' -f $status.token.configMasked, $status.token.logFile, $status.token.synced)
            Write-Host ('   引导   {0}（{1}）' -f $(if ($status.onboarded.done) { '已完成' } else { '未完成' }), $status.onboarded.source)
            Write-Host ('   诊断码 {0}（修不好时把这行发我）' -f $status.diagnosticCode)
            Write-Host ('   判定源 {0}' -f $status.source)
        }
        Write-Host ''
        return
    }

    if (-not $status) {
        # control.ps1 跑不起来（缺文件 / node 挂了）：照实说 + 给一个动作，绝不假装"一切正常"。
        Write-Host $rule
        Write-Host '   状态  ⚠ 读不到状态 → 按 r 重起一遍看看（还不行就双击 一键启动.cmd）'
        Write-Host "   地址  http://127.0.0.1:$DshPort"
        Write-Host $keyLine
        Write-Host $rule
        return
    }

    $green = [bool]$status.allGreen
    $done  = [bool]$status.onboarded.done
    # ★ 2026-09-24（§3.1"下一动作要带动作 id"）：control.ps1 的 nextAction 现在是**结构**
    #   `{ text, action }` —— text 只说"缺什么"，**"怎么做"由本载体渲染**（cmd 窗口说"按 r"，
    #   页面面板说"点启动"）。老形态（一个字符串）仍然认，免得测试钩子/旧 JSON 立刻失效。
    $next  = Format-NextActionLine $status.nextAction

    Write-Host $rule

    if ($green -and $done) {
        # §10.4：全绿 + 引导做完 = 就这 3 行（状态 / 地址 / 按 ?）—— 老用户不骚扰（§10.1-4）。
        Write-Host ('   ✓ ' + $next)
        Write-Host "   地址  http://127.0.0.1:$DshPort"
        Write-Host $keyLine
        Write-Host $rule
        $script:banner.last = Get-StatusSnapshot $status   # 记下"她刚看到的那份"（变了才重印）
        return
    }

    # 没全绿 / 引导没做完：多给信息（首启三步走 + 五灯），但那句"下一动作"照样必须在。
    if (-not $done) {
        $steps = Get-OnboardSteps $status
        $marks = @('①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩')
        $now = -1
        for ($i = 0; $i -lt $steps.Count; $i++) { if (-not $steps[$i].done) { $now = $i; break } }
        Write-Host '   看起来是第一次用 —— 三步就好（★ 只有第 ② 步要你动手）：'
        for ($i = 0; $i -lt $steps.Count; $i++) {
            $mark = if ($steps[$i].done) { '✓' } elseif ($i -eq $now) { '▶' } else { ' ' }
            $num = if ($i -lt $marks.Count) { $marks[$i] } else { ('({0})' -f ($i + 1)) }
            $tail = ''
            if ($steps[$i].checks) {
                $bits = @()
                foreach ($c in $steps[$i].checks) { $bits += ($c.label + $(if ($c.on) { ' ✓' } else { ' ✗' })) }
                $tail = '    ' + ($bits -join '  ')
            }
            Write-Host ('   {0} {1} {2}{3}' -f $mark, $num, $steps[$i].text, $tail)
        }
    }
    Write-Host ('   状态  {0}{1}' -f $(if ($green) { '✓ ' } else { '' }), $next)
    if (-not $green) {
        $L = $status.lights
        Write-Host ('   灯    DSH {0} ｜ 桥接 {1} ｜ SnowLuma {2} ｜ QQ {3} ｜ 令牌 {4}' -f `
            $(if ($L.dsh) { '✓' } else { '✗' }), $(if ($L.bridge) { '✓' } else { '✗' }), `
            $(if ($L.snowluma) { '✓' } else { '✗' }), $(if ($L.qq) { '✓' } else { '✗' }), `
            $(if ($L.token) { '✓' } else { '✗' }))
    }
    Write-Host "   地址  http://127.0.0.1:$DshPort"
    Write-Host $keyLine
    Write-Host $rule
    # ★ 记下"刚刚印给主人看的那份状态" —— 看守循环之后就拿它当基准，只有**真的变了**才重印
    #   （判据/比较都在 Get-StatusSnapshot / Compare-StatusSnapshot，见下面那一节）。
    $script:banner.last = Get-StatusSnapshot $status
}

# 横幅 = 真横幅 + 两句"窗口自己的话"（§10.1-5）：
#   ① 一次性告知（引导完成后的第一次启动，**只说一次**）；
#   ② `-PrintBanner`（探针）时多打一行 `[窗口] 完成态=… 决定=…` —— 让"这次启动窗口会缩还是留"
#      成为一个**看得见的决定**，不用读代码相信我。
# status 由调用方给（Wait-LinkUp 已经拿到一份）时不重复问 control.ps1。
function Show-Banner {
    param([switch]$Help, $Status, [switch]$Probe)
    if ($PSBoundParameters.ContainsKey('Status')) { Show-BannerCore -Help:$Help -Status $Status }
    else { Show-BannerCore -Help:$Help }
    if ($Help) { return }   # `?` 那一屏（排障用）不加这两句

    $onboard = $null
    if ($Probe) {
        # 探针：只读（-DryRun，不落盘），拿全量结论来打印"决定"
        $onboard = Get-OnboardState -ReadOnly
    } elseif (Test-OnboardNoticeCheap) {
        # 交互：只有"确实有那句话要说"时才多跑一趟（见 Test-OnboardNoticeCheap 的注释）
        $onboard = Get-OnboardState
    }
    if ($onboard) { Show-OnboardNotice -Probe:$Probe -Onboard $onboard }

    if ($Probe) {
        if ($onboard) {
            $word = if ([string]$onboard.decision -eq 'minimize') { '最小化' } else { '留桌面' }
            Write-Host ('   [窗口] 完成态={0} 决定={1} ｜ 依据：{2}' -f `
                $(if ($onboard.done) { '已完成' } else { '未完成' }), $word, $onboard.decisionWhy)
            Write-Host ('   [窗口] 真实信号：{0}' -f $onboard.evidence)
        } else {
            Write-Host '   [窗口] 读不到 tools\onboard.ps1 的结论 —— 那就按"留桌面"处理（窗口不会乱缩）'
        }
    }
}

# ── 窗口看守：出事自己跳出来（§10.1-5）───────────────────────────────────────
# 为什么要有它：引导做完以后 DSH-Web 会缩进任务栏，而 `e`（关闭全部）/ `r`（重起+自动修）恰恰是
# **出事时最需要的两个键** —— 缩起来就得先点任务栏才能按。所以：五灯不绿 → 自己 restore + 置前 +
# 把那一行"下一动作"打出来；绿灯 → 安静缩着。
#
# ★ 四条硬规矩（少一条就会变成骚扰）：
#   ① **边沿触发**：只在"从绿变红的那一次"跳；红了就一直弹 = 骚扰。
#   ② **尊重主人意图**：他刚自己缩下去（默认 5 分钟内）不弹回去 —— 但**只是推迟，不是取消**
#      （冷却一过、还是红的，照样跳）。"他刚缩的"怎么认：看守自己盯着窗口的"可见→最小化"跳变
#      ——不是我们主动缩的，那就是他缩的（start-all 收尾那次缩窗口也会被算进来，代价是启动后
#      安静 5 分钟，正好）。
#   ③ **探活廉价**：每 15 秒做一次 TCP 探活当**触发器**；给人看的那句话**只来自** control.ps1 status
#      —— 探测是触发器，**不是第二份判定**（端口通不通说明不了 QQ 在线、令牌同步这些事）。
#      绿灯时每 60 秒才去问一次 control.ps1（QQ / 令牌这类灯只有它看得见）。
#   ④ **抢不到前台要如实说**：Windows 不让后台进程抢前台，SetForegroundWindow 会失败 ——
#      照 tools\panels.ps1 的 wake 那样**如实报**，绝不假装成功。
$script:WatchEnabled  = -not $NoWatch
$script:WatchProbe    = [bool]$WatchOnce      # 只读探针：一次判定，不碰窗口
# ★ "DSH 停了没有"的两个**只读注入值**（`-CheckStopOnce` 用；正常启动流程一律不设）：
#   $env:DSH_WINDOW_CHILD_EXITED = 1      假装"它自己 spawn 的那个子进程已经退了"
#   $env:DSH_WINDOW_DSH_ALIVE    = 1 | 0  顶替"DSH 真实状态"（不设 = 真探：端口 + control.ps1 status）
#   为什么要有它们：真停这一态**没法在主人机器上造**（那要求真把 3080 停了 ✗），
#   而"不弹"这一态的证法恰恰相反（假停）—— 两个方向都要能证，见 Resolve-DshStop。
$script:ChildExitedProbe = ([string]$env:DSH_WINDOW_CHILD_EXITED -eq '1')
$script:DshAliveProbe = $null
$aliveRaw = [string]$env:DSH_WINDOW_DSH_ALIVE
if ($aliveRaw -eq '1') { $script:DshAliveProbe = $true }
elseif ($aliveRaw -eq '0') { $script:DshAliveProbe = $false }
# 控制面（:3101）在不在的注入值：`-EnsureOnce` 用（正常流程不设）。
# 为什么要有它："控制面不在"这一态**不许真去杀主人的进程**造 ⇒ 只能在只读钩子里注入。
$script:ControlAliveProbe = $null
$ctlAliveRaw = [string]$env:DSH_WINDOW_CONTROL_ALIVE
if ($ctlAliveRaw -eq '1') { $script:ControlAliveProbe = $true }
elseif ($ctlAliveRaw -eq '0') { $script:ControlAliveProbe = $false }
# 自动重起的注入值（`-CheckStopOnce` 用）：假装"这 10 分钟里已经自动拉过几次"。
# 为什么要有它：要验"拉到第 4 次会停手并转红"就必须能造出计数，而**不许真的去拉 3 次** ✗。
$script:AutoRestartAttemptsProbe = $null
$arRaw = [string]$env:DSH_WINDOW_AUTORESTART_ATTEMPTS
if ($arRaw -ne '') { try { $script:AutoRestartAttemptsProbe = [int]$arRaw } catch { $script:AutoRestartAttemptsProbe = $null } }
# ★ `DSH_WINDOW_AUTORESTART_RECORD=1` ⇒ **真的记一次账**（配 `DSH_WINDOW_AUTORESTART_FILE` 指到 %TEMP% 的临时文件）。
#   为什么要有它：主人 2026-09-25 的要求 —— 光证明"判定会说 restart"不够，还得证明**这条路真写得进、
#   下代真读得到**（真机那次连文件都没生成，正是"记账"这一环最需要被证明 ✗ 不能只靠推理）。
$script:AutoRestartRecordProbe = ([string]$env:DSH_WINDOW_AUTORESTART_RECORD -eq '1')
# ★ 「有会话在跑」的只读注入值（`-CheckDeathGate` 用；正常流程一律不设）：1=有、0=没有。
#   判据①的靶子就是它 —— 只有注入才验得了"忙的时候宁可不拉"（真机上不许去杀一个真在跑的回合 ✗）。
$script:SessionBusyProbe = $null
$busyRaw = [string]$env:DSH_WINDOW_SESSIONS_BUSY
if ($busyRaw -eq '1') { $script:SessionBusyProbe = $true }
elseif ($busyRaw -eq '0') { $script:SessionBusyProbe = $false }
# ★ QQ 通报在**只读探针里一律只印不真发**（探针不许打扰主人）—— 两条探针入口共用这一个开关。
$script:QqNoticeProbe = ([bool]$CheckStopOnce -or [bool]$CheckDeathGate)
# 升级成红色告警时那句话（窗口真停那一路会填；为空 = 没升级）
$script:StopEscalated = ''
$script:WatchIntervalMs = 15000               # ④：探活间隔（要求 ≥ 15 秒）
$script:WatchFullMs     = 60000               # 绿灯时多久问一次 control.ps1（唯一判定源）
$script:WatchCooldownMs = 300000              # ②：主人刚缩下去后的冷却（5 分钟）
$script:watch = @{
    lastProbeAt   = [datetime]::MinValue
    lastFullAt    = [datetime]::MinValue
    green         = $true        # 上一次的灯态（边沿判定就看它）
    redPending    = $false       # 红着、还没跳过
    poppedThisRed = $false
    minSince      = $null        # 窗口"被缩着"是从什么时候开始的（用来算"主人刚缩过"和冷却）
    minimized     = $false
    lastKeyAt     = [datetime]::MinValue
    graceSaidFor  = ''      # "已知启动窗口"那句话已经为哪个窗口说过了（同一个窗口只印一次，不刷屏）
    qqAlert       = $false  # 上一轮是不是"QQ 未登录"提示态（边沿：出现要写标题、恢复要**改回来**）
    qqPopped      = $false  # 这一轮 QQ 提示已经跳过一次了（一个提示期只打扰一次；恢复时归零）
    qqNotLocal    = $false  # 上一轮是不是"QQ 不在本机"说明态（搬家之后 / 只开 DSH；边沿：只印一次）
}

# ★ 「QQ 那套不在本机」的**唯一开关**（2026-09-26 主人把 QQ 搬到服务器之后加的）：
#   两种打开方式、效果完全相同 —— ① **标记文件在**（= 搬家已完成，本机不再登 QQ）；
#   ② `DSH_WINDOW_NO_SERVICES=1`（"只开 DSH"那个入口用它：QQ 那套压根不该起）。
#   打开之后：不再报「⚠ QQ 未登录」、不劝他按 s、**也不补缺 QQ 那两只**（那条走 start-all -NoRestart，
#   会把 SnowLuma 与桥接一起起出来 ✗ —— 搬家之后那两只在本机是故意不跑的，起了会抢号）；
#   ★ 2026-09-26 修：**控制面 :3101 照补**（走 tools\control-plane.ps1 那一份唯一起法；它与 QQ 无关）。
#   原来这里是"整段跳过补缺"⇒ 按一次 r，:3101 死了就**没人管**，主人看到的就是
#   "总控的灯不见了，我刷新了没用"（面板每 5 秒拉一次 :3101，服务不存在的话重试也救不回来）。
#   改成一句**说明**：QQ 在服务器上跑、掉线会推手机（Server酱）。
$script:QqMovedFile = [string]$env:DSH_WINDOW_QQ_MOVED_FILE
# ★ 根目录一律用 $PSScriptRoot 推（**别用 $Tools**）：探针入口（-CheckQqAlert 之类）不带 -Tools，
#   那时 $Tools 是空串 ⇒ Split-Path 会报 "Path 为空"（2026-09-26 实测踩到，安静地刷了一行 stderr）。
# ★ 标记文件的位置：**仓库里、但不在 `state\` 下** —— 两条理由都是实测来的：
#   ① 不放 `~\.dsh\`（更"机器级"）：那在工作区外，沙箱不许写（2026-09-26 试过，被拒）；
#   ② 不放 `qq-bridge\state\`：那里有白名单，tools\self-check.mjs 的 5.5 会把白名单外的条目
#      报成"测试残留？"（`tools\self-check.mjs` 那会儿正被别的线改着，别去动它的白名单）。
if (-not $script:QqMovedFile) { $script:QqMovedFile = Join-Path (Split-Path $PSScriptRoot -Parent) 'qq-bridge\qq-moved-to-server' }
function Test-QqNotLocal {
    if ($env:DSH_WINDOW_NO_SERVICES -eq '1') { return $true }
    try { return (Test-Path -LiteralPath $script:QqMovedFile) } catch { return $false }
}

# P/Invoke：只用这几个（不点源 minimize-windows.ps1 —— 那是启动器的收尾库，这里少耦合一份更稳）。
# 懒加载：真要看守的时候才 Add-Type（编一次要几百毫秒，别拖慢开窗）。
function Initialize-WindowWatchType {
    if ('DshWin.W' -as [type]) { return $true }
    try {
        Add-Type -Namespace DshWin -Name W -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindow(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int c);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@
        return $true
    } catch { return $false }
}

# ④ 廉价探活：一个 TCP 连接试一下（不拉任何子进程）。超时给得很短 —— 它只是**触发器**。
function Test-PortQuick([int]$Port, [int]$TimeoutMs = 250) {
    $c = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $c.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $c.EndConnect($iar)
        return $true
    } catch { return $false } finally { try { $c.Close() } catch { } }
}

# 触发器：三个关键端口（DSH / 桥接控制台 / SnowLuma，端口值取自仓库根 agent.config.json）
# 有一个不通 → 值得去问 control.ps1。
# ⚠ 它**只决定"要不要问"**，绝不决定"是不是真的坏了"（QQ 没登录、令牌过期这些它根本看不见）。
function Test-CheapTriggerAllUp {
    foreach ($p in @($DshPort, $BridgePort, $SnowLumaPort)) {
        if (-not (Test-PortQuick $p)) { return $false }
    }
    return $true
}

# ── "DSH 到底还在不在"（2026-09-24 晚，主人实测两次"DSH 又停了"）──────────────────
# ★ 为什么必须换判据：这个窗口原来只看 `$script:child.HasExited`（它自己 spawn 的那个 cmd）——
#   而 DSH 完全可能是**另一个进程**在跑（守护 / `r` 的自动修 / 别处重起过），
#   子进程一退它就喊"DSH 已停止"，**同一屏上的灯却还亮着 `DSH ✓`** ⇒ 自相矛盾（主人亲眼见过）。
#   两种"已停止"要分清：① 真掉线（真的没了 ⇒ 必须弹窗叫她）；② 假警报（换了个进程还在跑 ⇒ 什么都不许说）。
function Test-DshAlive {
    # 只读探针的注入值优先（正常流程不设）：真停那一态没法在真机上造，只能注入。
    if ($null -ne $script:DshAliveProbe) { return [bool]$script:DshAliveProbe }
    # ① 端口探活最便宜，也最先反应"真的没了"。
    if (Test-PortQuick $DshPort) { return $true }
    # ② 端口不通也别急着宣布死亡：问一次**唯一判定源**（可能是刚好在换进程 / 刚刚才起来）。
    try {
        $st = Get-ControlStatus
        if ($st -and $st.lights -and [bool]$st.lights.dsh) { return $true }
    } catch { }
    return $false
}

# ── 判死之前"多问几拍" + "有没有会话在跑"（2026-09-25 判据①的两半）────────────────────
# 病根（协调线口径）：判死只靠**一次**探活（端口 :3080 超时 + 控制面恰巧也问不到）⇒ **忙着的 DSH 会误判死**。
# 修法：判死这一路改成「**连续 N 次都问不到**才算死」（每次给足超时），并且**先看有没有会话在跑**。
# ⚠ 只用在判死这条路上：`Test-DshAlive` 原位不动（补缺等别的判定要的是"便宜、快"，口径不变）。
function Test-DshAliveSettled {
    param([int]$Tries = 3, [int]$TimeoutMs = 1500, [int]$GapMs = 2000)
    if ($null -ne $script:DshAliveProbe) { return [bool]$script:DshAliveProbe }   # 注入优先（探针用）
    for ($i = 1; $i -le $Tries; $i++) {
        if (Test-PortQuick $DshPort $TimeoutMs) { return $true }
        try {
            $st = Get-ControlStatus
            if ($st -and $st.lights -and [bool]$st.lights.dsh) { return $true }
        } catch { }
        if ($i -lt $Tries) { Start-Sleep -Milliseconds $GapMs }
    }
    return $false
}
# 「有没有会话在跑」的**只读旁证**（判据①；不依赖 DSH 的响应 —— 忙着的 DSH 恰恰不响应）：
#   看 `~\.dsh\sessions` 下最近 $WindowSec 秒内**会话流水文件的 mtime**；读到就当作"有会话在跑"。
#   ⚠ 三条已知边界（如实写清，别当它万能）：① 它只是旁证 —— 长工具调用期间流水可能好几分钟不落盘
#     ⇒ 窗口给到 180 秒；② 读不到 / 目录不在 ⇒ **返回 $false**（"读失败不拦"，与项目纪律一致：
#     不能因为读不到就永远不修）；③ 它**只用来否决**（busy ⇒ 宁可不拉），从不拿来肯定"它死了"。
function Get-SessionBusyHint {
    param([int]$WindowSec = 180)
    if ($null -ne $script:SessionBusyProbe) { return [bool]$script:SessionBusyProbe }
    try {
        $root = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh\sessions'
        if (-not (Test-Path $root)) { return $false }
        $cut = (Get-Date).AddSeconds(-1 * $WindowSec)
        $hit = Get-ChildItem -Path $root -Recurse -Depth 3 -File -ErrorAction SilentlyContinue |
            Where-Object { $_.LastWriteTime -gt $cut -and $_.Name -like 'session*' } | Select-Object -First 1
        return [bool]$hit
    } catch { return $false }
}

# ★ 判定的**纯函数**（run 循环与 -CheckStopOnce 共用同一份 —— 验收看到的就是真跑的那套）：
#   run     = 子进程还在 ⇒ 照常守着
#   adopt   = 子进程退了、但 DSH 真的还在跑 ⇒ **不喊"已停止"、不弹窗**，改成按真实状态继续守
#   stopped = 子进程退了、DSH 也真的没了 ⇒ 弹窗 + 问一句（真掉线才走这里）
function Resolve-DshStop {
    param([bool]$ChildExited, [bool]$DshAlive)
    if (-not $ChildExited) { return @{ act = 'run'; why = '它起的那个子进程还在跑 —— 照常守着' } }
    if ($DshAlive) {
        return @{ act = 'adopt'; why = '子进程退了，但 DSH 真的还在跑（守护/自动修换了进程）⇒ 不喊"已停止"、不弹窗，改成按真实状态继续守' }
    }
    return @{ act = 'stopped'; why = '子进程退了，DSH 也真的没了 ⇒ 弹窗 + 问一句' }
}

# ── DSH 真没了 ⇒ **自动把它拉回来**（有次数上限 + 退避；2026-09-24 晚）────────────────────
# 为什么必须有这条：DSH 一死，QQ 侧就**彻底离线**，直到有人敲 r ✗ —— 而这个项目的目标是
#   「搬到服务器常开跑」，服务器旁边**没有人**（Linux 那条有 systemd 的 Restart= 兜着；
#   Windows 这条路的兜底只有本窗口）。实测：01:00:5x DSH 掉，桥接重试 6 次全 `fetch failed`
#   （01:01:01–01:01:19），**没有任何东西试图拉起它**，01:01:21 才恢复 ⇒ 那 20~30 秒机器人是下线的。
# 走哪条路：**外层那条现成的重起路** = 本脚本 `exit 1` ⇒ tools\dsh-window.cmd 的 `:decide` 认 1 =
#   `:restart`（换新日志、在**同一个窗口**里重跑本脚本）—— 这正是主人按 r 时走的那条 ✓，不另写第二份。
#   ⚠ 为什么**不**拿 start-all.ps1 来重起 DSH：它起 DSH 的方式是**再开一个 DSH-Web 窗口**
#     （start-all.ps1:471 那条 cmd /k），会多出一个窗口、老窗口还在 ✗ ⇒ 补别的服务用它、重起 DSH 用 exit 1。
# 上限与退避：**10 分钟内最多自动拉 3 次**（计数落 state\_tmp，跨代际活着）。第 4 次起停手 ⇒
#   升级成红色告警叫人（主人要的那条）—— **绝不无限重启**（那会变成每几秒弹一次窗口的灾难）。
$script:AutoRestartMax = 3
$script:AutoRestartWindowSec = 600
function Get-AutoRestartFile {
    # 只读探针可以指到别处（正常流程不设）
    $f = [string]$env:DSH_WINDOW_AUTORESTART_FILE
    if ($f) { return $f }
    return (Join-Path (Split-Path $PSScriptRoot -Parent) 'qq-bridge\state\_tmp\dsh-autorestart.json')
}
# 时间窗内**自动拉起**的次数。读不到 / 文件不在 / 坏了 ⇒ 0（**绝不抛**：这条路上出错就等于不救了）。
# ★ 只数 `by='auto'`（主人手动按 r 的那个不算 —— 见 Read-AutoRestartLedger 顶上的 bug 说明）。
function Read-AutoRestartAttempts {
    if ($null -ne $script:AutoRestartAttemptsProbe) { return [int]$script:AutoRestartAttemptsProbe }
    try {
        return @(Read-RestartEvents -WithinSec $script:AutoRestartWindowSec | Where-Object { $_.by -eq 'auto' }).Count
    } catch { return 0 }
}
# 账本读/写**只有这一份**（字段必须一起保住：写一个不能把别的抹掉）。
#   ev     = 重起事件数组，每条 `{ t = 时刻, by = 'auto' | 'manual' }`
#            ★ 2026-09-25 修 bug：**必须区分是谁发起的** —— 主人手动按 r（很正常的操作）原来也会进这个账本，
#            新一代还照样说"我已经把它拉回来了" ✗（假信息）而且次数被算进去 ⇒ 3 次手动重起就会收到
#            假的"连续 3 次自己起来"报警 ✗。**只有 by='auto' 才算自动拉起**（频率告警也只数这一种）。
#            旧格式（`at` = 纯时刻字符串数组，没有来源）一律当成 `auto` 读 —— 向后兼容，不炸。
#   popAt  = 上一次"**打扰过他**"的时刻（弹窗 或 发 QQ 都算；同一个 5 分钟冷却用；缺 = 从没打扰过）
function Read-AutoRestartLedger {
    $empty = @{ ev = @(); popAt = $null }
    try {
        $f = Get-AutoRestartFile
        if (-not (Test-Path $f)) { return $empty }
        $o = [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $pop = $null
        if ($o.PSObject.Properties['popAt'] -and $o.popAt) {
            $d = [datetime]::MinValue
            if ([datetime]::TryParse([string]$o.popAt, [ref]$d)) { $pop = $d }
        }
        $ev = @()
        if ($o.PSObject.Properties['ev']) {
            foreach ($e in @($o.ev)) {
                if ($null -eq $e) { continue }
                $t = ''; $by = 'auto'
                if ($e.PSObject -and $e.PSObject.Properties['t']) {
                    $t = [string]$e.t
                    if ($e.PSObject.Properties['by'] -and [string]$e.by) { $by = [string]$e.by }
                } else { $t = [string]$e }     # 旧格式：裸时刻字符串 ⇒ 当 auto
                if ($t) { $ev += @{ t = $t; by = $by } }
            }
        } elseif ($o.PSObject.Properties['at']) {
            foreach ($t in @($o.at)) { if ([string]$t) { $ev += @{ t = [string]$t; by = 'auto' } } }
        }
        return @{ ev = $ev; popAt = $pop }
    } catch { return $empty }
}
function Write-AutoRestartLedger {
    param($Events, $PopAt)
    $f = Get-AutoRestartFile
    $dir = Split-Path -Parent $f
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $body = [ordered]@{ ev = @($Events | ForEach-Object { [ordered]@{ t = [string]$_.t; by = [string]$_.by } }) }
    if ($PopAt -is [datetime]) { $body['popAt'] = $PopAt.ToString('o') }
    # 写 JSON **不带 BOM**（PS 5.1 的 Set-Content -Encoding UTF8 会加 BOM，严格读取者会炸）
    $json = ($body | ConvertTo-Json -Depth 3)
    [System.IO.File]::WriteAllText($f, $json, (New-Object System.Text.UTF8Encoding($false)))
}
# 窗口期内的**重起事件**（可按时限过滤；不传 $WithinSec 就是全部）
function Read-RestartEvents {
    param([int]$WithinSec = 0)
    $l = Read-AutoRestartLedger
    $out = @()
    $cut = if ($WithinSec -gt 0) { (Get-Date).AddSeconds(-$WithinSec) } else { [datetime]::MinValue }
    foreach ($e in @($l.ev)) {
        $d = [datetime]::MinValue
        if ([datetime]::TryParse([string]$e.t, [ref]$d) -and $d -gt $cut) {
            $out += @{ t = [string]$e.t; at = $d; by = [string]$e.by }
        }
    }
    return $out
}
# 上一次"**打扰过他**"的时刻（弹窗 或 发 QQ 都算一次；没打扰过 / 读不到 ⇒ MinValue = 可以打扰）。
# ⚠ 账本里的字段名沿用 `popAt`（历史原因，不改格式）：语义已经是"上次打扰"。
function Read-AutoRestartToldAt {
    $l = Read-AutoRestartLedger
    if ($l.popAt -is [datetime]) { return $l.popAt }
    return [datetime]::MinValue
}
# 记一次"打扰过了"（与重起记账同一个文件 —— 跨代际活着，"同一轮只打扰一次"才做得到）
function Add-AutoRestartTold {
    try {
        $keep = @(Read-RestartEvents -WithinSec $script:AutoRestartWindowSec | ForEach-Object { @{ t = $_.t; by = $_.by } })
        Write-AutoRestartLedger -Events $keep -PopAt (Get-Date)
        return 0
    } catch {
        Write-Host ('   [自动修] ⚠ 弹窗记账写不进去（{0}）—— 不影响这次拉起，只影响"5 分钟只弹一次"' -f $_.Exception.Message) -ForegroundColor Yellow
        return -1
    }
}
# ★ 记一次重起（**先记账再动手**：万一这一代自己崩了，计数不会丢、不会变成无限重启）。
#   `-By` 决定它算不算"自动拉起"：**auto** = 看守自己拉的（算次数、会被频率告警数）；**manual** = 主人按 r
#   （只记下来当"最近一次是谁发起的"，**绝不算次数** —— 见 Read-AutoRestartLedger 顶上那段 bug 说明）。
#   返回 = 窗口期内 **auto** 的条数（供"第 N 次"与上限用）；失败返回 -1（调用方据此不敢自动重试）。
function Add-RestartEvent {
    param([ValidateSet('auto', 'manual')][string]$By = 'auto')
    try {
        $keep = @()
        foreach ($e in @(Read-RestartEvents -WithinSec $script:AutoRestartWindowSec)) {
            $keep += @{ t = $e.t; by = $e.by }
        }
        $keep += @{ t = (Get-Date).ToString('o'); by = $By }
        $l = Read-AutoRestartLedger
        Write-AutoRestartLedger -Events $keep -PopAt $l.popAt   # ⚠ popAt 必须一起保住
        return @($keep | Where-Object { $_.by -eq 'auto' }).Count
    } catch {
        # ⚠ **绝不静默**：记不上账 ⇒ 真循环会因此**不敢自动重试**（宁可叫人，也不冒"无限重启"的风险）
        Write-Host ('   [自动修] ⚠ 记账写不进去（{0}）' -f $_.Exception.Message) -ForegroundColor Yellow
        return -1
    }
}
# 兼容旧名（自动拉起那条路用它；语义 = 记一次 auto）——只此一处转调，不复制逻辑。
function Add-AutoRestartAttempt { return (Add-RestartEvent -By 'auto') }
# ★ 纯函数：**这一代是不是"看守自己拉起来"的**（决定要不要印那句"我已经把它拉回来了"）。
#   判据：最近一次重起事件 by='auto' **且** 它离这一代开始不超过 $WithinSec 秒（= 就是它把我这代拉起来的）。
#   手动按 r ⇒ 最近一次是 manual ⇒ 不印那句（他清楚是自己在重起，再说"我拉回来的"就是**假信息** ✗）。
function Test-AutoRestartGeneration {
    param($LastEvent, $NowAt, [int]$WithinSec = 180)
    if (-not $LastEvent) { return @{ yes = $false; why = '账本里没有任何重起事件（这一代是正常启动 / 首次启动）' } }
    if ([string]$LastEvent.by -ne 'auto') {
        return @{ yes = $false; why = ('最近一次重起是**你按 r 发起的**（{0}）⇒ 不算自动拉起、也不印那句' -f [string]$LastEvent.t) }
    }
    $t = [datetime]::MinValue
    if (-not [datetime]::TryParse([string]$LastEvent.t, [ref]$t)) { return @{ yes = $false; why = '账本里那条时刻读不出来 ⇒ 不认' } }
    $nowT = $NowAt
    if ($nowT -isnot [datetime]) { $nowT = Get-Date }
    $ago = ($nowT - $t).TotalSeconds
    if ($ago -gt $WithinSec) { return @{ yes = $false; why = ('最近一次自动拉起是 {0} 秒前（> {1} 秒）⇒ 不是它拉起的这一代' -f [int]$ago, $WithinSec) } }
    return @{ yes = $true; why = ('{0} 秒前那次自动拉起就是这一代的来源 ⇒ 该如实告诉他"我把它拉回来了"' -f [int]$ago) }
}
# ★ 频率告警的**主通道**：走桥接把 QQ 私聊发出去（2026-09-25 协调会话更正：**桥接是独立进程、有自己
#   的守护** ⇒ DSH 停着它照样能把消息发出去 ✓ —— 这正是"服务器上没人看屏幕"时要用的通道）。
#   纪律：① QQ 号**从环境层读**（Get-AgentOwnerQQ / agent.config.json 的 ownerQQ），**绝不写死** ✗
#         ② 只发一句人话，**不提令牌 / 路径 / 端口 / 内部黑话** ✗
#         ③ 发不出去**如实返回失败**（绝不假装发出去了 ✗），由调用方记在窗口里
#         ④ "同一轮只发一条"由调用方的冷却保证（见 Add-AutoRestartTold / Read-AutoRestartToldAt）
#   测试钩子 `DSH_WINDOW_RELAY_HOOK` = 一个假的 relay 脚本（正常流程一律不设）⇒ 测试能证明"真的调了、
#   内容对"，而**不会真发 QQ** ✓。
function Invoke-FlapRelay {
    param([string]$Text, [switch]$Probe)
    $owner = ''
    try { $owner = [string](Get-AgentOwnerQQ) } catch { $owner = '' }
    if (-not $owner) {
        return @{ ok = $false; target = ''; why = '环境层里没有 ownerQQ（agent.config.json）⇒ 这条发不出去，只能靠窗口红字' }
    }
    $target = 'private:' + $owner
    $hook = [string]$env:DSH_WINDOW_RELAY_HOOK
    $ops = Join-Path $PSScriptRoot 'ops.mjs'
    if ($hook) {
        if ($Probe) { return @{ ok = $true; target = $target; why = ('[只读探针] 本来会调假 relay（{0}）+ 那两个参数' -f $hook) } }
        try {
            $o = & $hook $target $Text 2>&1 | Out-String
            $code = $LASTEXITCODE
            return @{ ok = ($code -eq 0); target = $target; why = $(if ($code -eq 0) { '已经用 QQ 私聊告诉你了（测试钩子：没真发）' } else { ('假 relay 返回 {0}：{1}' -f $code, $o.Trim()) }) }
        } catch {
            return @{ ok = $false; target = $target; why = ('调假 relay 出错：' + $_.Exception.Message) }
        }
    }
    if (-not (Test-Path $ops)) { return @{ ok = $false; target = $target; why = '找不到 tools\ops.mjs ⇒ 发不出去' } }
    if ($Probe) { return @{ ok = $true; target = $target; why = ('[只读探针] 本来会：node tools\ops.mjs relay {0} "…"' -f $target) } }
    try {
        # ⚠ 捕获输出但**不截断活着的子进程**（2026-09-25 的坑：Select-Object -First 会掐死上游）。
        #   $Node 是启动器传进来的 node 路径（没传就退回 PATH 里的 node —— 与文件别处同一个写法）。
        $exe = if ($Node) { $Node } else { 'node' }
        $o = & $exe $ops 'relay' $target $Text 2>&1 | Out-String
        $code = $LASTEXITCODE
        if ($code -eq 0) { return @{ ok = $true; target = $target; why = '已经用 QQ 私聊告诉你了' } }
        return @{ ok = $false; target = $target; why = ('relay 返回 {0}（{1}）⇒ 这条**没发出去**' -f $code, $o.Trim()) }
    } catch {
        return @{ ok = $false; target = $target; why = ('调 relay 出错（{0}）⇒ 这条**没发出去**' -f $_.Exception.Message) }
    }
}
# 频率告警的**那句话**（只有这一份：窗口红字与 QQ 消息共用，措辞一致；里面**不提**令牌/路径/端口）。
function Get-FlapAlarmText {
    param([int]$Attempts, [int]$WindowSec = 600)
    $mins = [int]($WindowSec / 60)
    return ('DSH 在 {0} 分钟里自己起来 {1} 次了 —— 这不太正常，可能不是一次偶然掉线；我已经不再自动重试，' +
        '麻烦你看一眼电脑上那个黑窗口（里面写了原因和下一步）。') -f $mins, $Attempts
}
# ★ 频率告警（纯函数，真流程与 -FlapOnce 共用）：**短时间连着拉起好几次 ⇒ 主动报错**。
#   阈值与"自动拉起的上限"**是同一套数**（Max / WindowSec）—— 不另立一套，避免"两套数打架"。
#   判据可证伪：1 次 ⇒ 不报（正常的一次抖动）；到 Max 次 ⇒ 报；窗口外的旧记录不算数 ⇒ 计数会自己归零。
function Resolve-FlapAlarm {
    param([int]$Attempts, [int]$Max = 3, [int]$WindowSec = 600)
    $mins = [int]($WindowSec / 60)
    if ($Attempts -lt $Max) {
        return @{ alarm = $false; lines = @(); nextLine = ''; why = ('{0} 分钟里自己起来过 {1} 次（没到 {2} 次）⇒ 一次抖动而已，不打扰他' -f $mins, $Attempts, $Max) }
    }
    $lines = @(
        ('⚠ {0} 分钟里它已经**自己起来 {1} 次**了 —— 这不是"一次抖动"，像是系统层面有问题（不是你没操作对）。' -f $mins, $Attempts),
        ('   我从现在起**停手**：下次再掉，我不再自己拉，会红字叫你按 r（免得它一直起→掉→起）。'),
        '   你可以做的：① 按 r 手动重起一次试试 ② 想想是不是有别的东西在吃资源/跑沙箱/装驱动 ③ 按 ? 看全部键位。'
    )
    return @{ alarm = $true; lines = $lines; nextLine = ('DSH 在 {0} 分钟里自己起来 {1} 次了 —— 这不太正常，我在这个窗口里写了原因和下一步，你看一眼。' -f $mins, $Attempts); why = ('连着 {0} 次 ⇒ 主动报错（红字 + 弹一次）' -f $Attempts) }
}
# ★ 要不要**弹窗打扰他**（纯函数，频率告警那条路与 -FlapOnce 共用）：
#   主人的设计（2026-09-25）：**单次自动修复不弹**（留日志就行），只有"短时间连着好几次"才值得打扰；
#   那种情况弹出来也要有分寸 —— 窗口本来就在他眼前时**不抢前台**（红字他自己看得见），而且
#   5 分钟冷却（同一轮别反复弹）。
function Test-ShouldPopOnRestart {
    param([bool]$Minimized, $LastPopAt, $Now, [int]$CooldownSec = 300)
    if (-not $Minimized) {
        return @{ pop = $false; why = '窗口你看得见（没缩着）⇒ 不抢你的前台，只把 ⚠ 写进窗口标题、并在窗口里留一句' }
    }
    $last = $LastPopAt
    if ($last -isnot [datetime]) { $last = [datetime]::MinValue }
    $nowT = $Now
    if ($nowT -isnot [datetime]) { $nowT = Get-Date }
    $ago = ($nowT - $last).TotalSeconds
    if ($last -ne [datetime]::MinValue -and $ago -lt $CooldownSec) {
        return @{ pop = $false; why = ('{0} 秒前刚为你弹过一次（{1} 分钟冷却）⇒ 这一轮不再抢前台，只留标题和那句记录' -f [int]$ago, [int]($CooldownSec / 60)) }
    }
    return @{ pop = $true; why = '窗口缩着你看不见 ⇒ 还原 + 试着置前一次（只这一次；为什么弹，看下面打出的那一行）' }
}
# ★ 纯函数（循环与 -CheckStopOnce 共用同一份）：act = none | restart | escalate
# ★★ 止血三件（2026-09-25 19:4x，主人现场报「又掉了」+ 协调线急件）：
#   ① **判死之前先记一行证据**（探的哪个端口 / 通不通 / 控制面问不问得到 / 当时有没有会话在跑 / 这一窗口内第几次）
#      —— 落 `qq-bridge\state\dsh-autorestart-evidence.log`（只追加、只读现场，不改任何状态）；
#   ② **文件开关**：`qq-bridge\state\dsh-autorestart-off` **存在** ⇒ 判死也**不自动重起**，改红字叫人按 r
#      （主人/协调线可即时创建/删除，不用碰窗口；⚠ 正在跑的那一代用的是旧代码 —— 本文件每代都会被重新加载，
#        所以下一次判定就生效）；
#   ③ 取证与开关都**只在这条判定路上**发生（不碰 `Resolve-*` 那几个纯函数，验收口径不变）。
function Get-AutoRestartOffFile {
    # 只读探针可以指到别处（正常流程不设）—— 与账本那条 `DSH_WINDOW_AUTORESTART_FILE` 同一套纪律：
    #   "开关关着"这一态要有可注入的靶子，否则验不了"关着也不许静默"（真死那条 QQ 通报就挂在这条路上）。
    $f = [string]$env:DSH_WINDOW_AUTORESTART_OFF_FILE
    if ($f) { return $f }
    return (Join-Path (Split-Path $PSScriptRoot -Parent) 'qq-bridge\state\dsh-autorestart-off')
}
function Test-AutoRestartDisabled {
    try { return (Test-Path (Get-AutoRestartOffFile)) } catch { return $false }
}
function Write-AutoRestartEvidence {
    param([string]$Text)
    try {
        $f = Join-Path (Split-Path $PSScriptRoot -Parent) 'qq-bridge\state\dsh-autorestart-evidence.log'
        Add-Content -Path $f -Encoding UTF8 -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text)
    } catch { }
}
# 现场证据（全部容错：取证本身绝不许把这条判定路搞崩）
function Get-AutoRestartEvidence {
    param($Handling)
    $portOk = ''; $ctlOk = ''; $lights = ''; $busy = ''
    try { $portOk = $(if (Test-PortQuick $DshPort) { '通' } else { '不通' }) } catch { $portOk = '探不了' }
    $st = $null
    try { $st = Get-ControlStatus } catch { }
    if ($st) {
        $ctlOk = '是'
        try { $lights = [string]$st.lights.dsh } catch { $lights = '?' }
        try {
            $cur = Get-SessionsCurrent $st
            if ($cur -and $cur.shortId) { $busy = [string]$cur.shortId }
        } catch { }
    } else { $ctlOk = '否' }
    return ('端口 :{0} 探活={1} ｜ 控制面问得到={2}（lights.dsh={3}）｜ 当时会话={4} ｜ 判定={5}（{6}）｜ 本窗口已自动拉起 {7}/{8} ｜ 文件开关={9}' -f `
        $DshPort, $portOk, $ctlOk, $(if ($lights -ne '') { $lights } else { '?' }), $(if ($busy -ne '') { $busy } else { '没读到' }), `
        $Handling.act, $Handling.why, (Read-AutoRestartAttempts), $script:AutoRestartMax, `
        $(if (Test-AutoRestartDisabled) { '关闭（存在 dsh-autorestart-off）' } else { '开' }))
}
function Resolve-AutoRestart {
    param([bool]$DshAlive, [int]$Attempts, [int]$Max = 3)
    if ($DshAlive) { return @{ act = 'none'; why = 'DSH 还活着（换代 / 刚换令牌都算活着）⇒ **一次都不拉**' } }
    if ($Attempts -ge $Max) {
        return @{ act = 'escalate'; why = ('{0} 分钟内已经自动拉过 {1} 次都没起来 ⇒ **停手**，转红色告警叫人按 r' -f [int]($script:AutoRestartWindowSec / 60), $Attempts) }
    }
    return @{ act = 'restart'; why = ('DSH 真没了 ⇒ 自动拉起第 {0} 次（{1} 分钟内上限 {2} 次）' -f ($Attempts + 1), [int]($script:AutoRestartWindowSec / 60), $Max) }
}
# ── 「真死也要给他一条 QQ」（2026-09-25 判据② / 主人今晚的原话）──────────────────────────
# 为什么必须有：**自动修关掉之后，"判死也不拉"那条路原来是静默的** —— 红字只印在那个（按设计缩着的）
#   窗口里 ⇒ 主人最后一个知道。而这一刻 DSH 已经死了，他在页面上没法给我下指令 ⇒ **QQ 是唯一还通的告警通道**。
# 走哪条路：**复用 2026-09-25 那支现成的 `tools\qq-notify.mjs`**（OneBot HTTP 直连、**不经桥接** ——
#   DSH 死时桥接可能也半死不活；失败不重试、永远退 0），**绝不另写第二份发法**（那个文件归执行线，本批不碰）。
# 四条边界：① 只在这条判死路上发、**一次判死只发一条**（不重试、不轮询）；② 最多等 8 秒，等不到就走；
#   ③ 失败一律**不抛**（告警发不出去也绝不能让看守链崩）；④ 只读探针里**只印不真发**（不许打扰主人）。
function Send-OwnerQqNotice {
    param([string]$Text, [string]$Tag = 'dsh-dead', [switch]$Probe)
    if ($Probe -or $script:QqNoticeProbe) {
        Write-Host ('   [QQ 通报] [只读探针] 本来会给他发一条 QQ 私聊（tag={0}）：{1}' -f $Tag, $Text)
        return $true
    }
    try {
        $js = Join-Path $PSScriptRoot 'qq-notify.mjs'
        if (-not (Test-Path $js)) { return $false }
        $exe = $(if ($Node) { $Node } else { 'node' })
        $p = Start-Process -FilePath $exe -ArgumentList @($js, $Text, '--tag', $Tag) -NoNewWindow -PassThru -ErrorAction Stop
        [void]$p.WaitForExit(8000)
        return $true
    } catch { return $false }
}
# ★ 「判死之后到底动不动手 / 要不要发 QQ」的**唯一一份**判据（纯函数：真循环与 -CheckDeathGate 共用）——
#   把 Resolve-StopHandling 的结论与运行时那两个否决（**文件开关** / **记账写不进**）合成最终动作：
#     pull         = 真去拉（exit 1 ⇒ 外层 .cmd 的 :restart，**同一个窗口**，不用他敲任何键）
#     hold         = 判不死（有会话在跑）⇒ 什么都不做，下一拍再看
#     escalate-*   = **不拉**（开关关着 / 记账失败 / 到上限）⇒ 红字 + **发 QQ**（不许静默停摆）
#   notify=true 的三种正是"他没法从页面上知道"的情形；pull / hold 都不打扰他（自愈留日志就行 —— 主人原话）。
function Resolve-DeathAction {
    param([string]$Act, [bool]$SwitchOff = $false, [bool]$LedgerOk = $true)
    if ($Act -eq 'auto-restart') {
        if ($SwitchOff) { return @{ act = 'escalate-switch-off'; pull = $false; notify = $true; why = '判死也不拉：自动修被文件开关关着（qq-bridge\state\dsh-autorestart-off）' } }
        if (-not $LedgerOk) { return @{ act = 'escalate-ledger'; pull = $false; notify = $true; why = '判死也不拉：自动拉起的账记不上（state\_tmp 写不进去）⇒ 不敢自动重试（怕变成无限重启）' } }
        return @{ act = 'pull'; pull = $true; notify = $false; why = 'DSH 真没了 ⇒ 拉一次（同一个窗口里重起，走的是按 r 那条现成的路）' }
    }
    if ($Act -eq 'alarm') { return @{ act = 'escalate-max'; pull = $false; notify = $true; why = '连着拉了好几次都没起来 ⇒ 停手叫人（绝不在这一代里无限重试）' } }
    if ($Act -eq 'hold') { return @{ act = 'hold'; pull = $false; notify = $false; why = '有会话在跑 ⇒ 宁可不拉（这一拍什么都不做）' } }
    return @{ act = $Act; pull = $false; notify = $false; why = '' }
}

# ★ 真停时**整条处置**（唯一一份）：真循环与 -CheckStopOnce 都走这个函数 ——
#   返回 act = keep-running | adopt | hold | auto-restart | alarm，字段：
#     why      人话原因（黄字/红字直接用）
#     records  true ⇒ 执行前**必须先记账**（Add-AutoRestartAttempt）
#     alarm    true ⇒ 打印红色告警并等输入（与 auto-restart **互斥**：一次掉线只走一条）
#   ★ hold（2026-09-25 判据①）= "这一拍判死，但有会话在跑 ⇒ **宁可不拉**"：不记账、不告警、下一拍再看。
function Resolve-StopHandling {
    param([bool]$ChildExited, [bool]$DshAlive, [int]$Attempts, [int]$Max = 3, [bool]$SessionsBusy = $false)
    $d = Resolve-DshStop -ChildExited $ChildExited -DshAlive $DshAlive
    if ($d.act -eq 'run') { return @{ act = 'keep-running'; why = $d.why; records = $false; alarm = $false } }
    if ($d.act -ne 'stopped') { return @{ act = $d.act; why = $d.why; records = $false; alarm = $false } }
    # ★ 判据①（主人 2026-09-25 20:1x 定 / 协调线裁决）：**有会话还在跑 ⇒ 宁可不拉**。
    #   为什么排在"拉"之前：判死靠的是探活（端口 :3080 + 控制面 lights.dsh），而**忙着的 DSH 本来就会探活超时**
    #   ⇒ 那一刻拉一次 = 把正在跑的回合连人带活一起杀掉。宁可这一拍什么都不做，下一拍再看。
    #   旁证 = Get-SessionBusyHint（只读 ~\.dsh\sessions 的会话流水 mtime，不依赖 DSH 响应）。
    if ($SessionsBusy) {
        return @{ act = 'hold'; why = '有会话还在跑（最近几分钟里会话流水还在长）⇒ **宁可不拉**：这一刻判死/重起会杀掉正在跑的回合；我什么都不做，下一拍再看'; records = $false; alarm = $false }
    }
    $ar = Resolve-AutoRestart -DshAlive $false -Attempts $Attempts -Max $Max
    if ($ar.act -eq 'restart') { return @{ act = 'auto-restart'; why = $ar.why; records = $true; alarm = $false } }
    return @{ act = 'alarm'; why = $ar.why; records = $false; alarm = $true }
}

# 真停时那两句话**只有这一份**（弹窗那一行与"接下来做什么"横幅共用）：
# 说清 发生了什么 / **不指认任何原因**（人话、不指责任何人）/ 按什么键。
# ★ 这里**只写确知的**（2026-09-25 主人用任务管理器反驳了原来那句"常见原因：内存吃紧"：内存 62%、
#   大头是 Edge 1.4G + Node 507M + QQ 608M ⇒ **没有内存压力**）—— 假原因和假告警一样有害：
#   他会照着去查内存、白查一场。将来真要写原因，判据必须是**实测的**（本次掉线时的内存实测占比、
#   或"是否有别的进程同时消失"）；拿不到就照实说"不知道"。
function Get-DshStopWhy {
    return 'DSH 停了（什么原因我还不知道 —— 不是你按错了；怎么处理看下面这一行）'
}
function Get-DshStopAction {
    return '要接着用：直接回车（重起 DSH）｜ 要全关：输入 e 再回车'
}

# ── DSH 真停了 = **他唯一的通道**，窗口必须**红着跳出来**（主人 2026-09-24 原话）───────────
# 他的理由（比什么提示都硬）：**DSH 一停，他就没法在网页里给我下指令了** —— 那一刻唯一还能跟他
#   说话的通道就是这个 `DSH-Web` cmd 窗口（独立进程、不随 DSH 死）。所以这不是"提示"，是**求救信号**。
# 为什么以前他没看到：窗口**按设计缩在任务栏里**（引导做完 + 五灯全绿 ⇒ 启动器收尾把它缩掉），
#   而原来那句"DSH 已停止"是**印在一个最小化的窗口里**的 ✗；更糟的是老代码在子进程退出时
#   **直接 break 出看守循环** ⇒ 循环里那套"自己跳回来"根本没机会跑 ✗。
# 现在三件事一起做：① 先还原 + 置前（复用 Invoke-WindowPop，不另写）；② 打一段**红色**告警
#   （Red 在默认深色与浅色主题下都看得清）；③ 把告警写进**窗口标题**（缩着/被别的窗口盖住时，
#   任务栏那一行仍然写着它 —— 这是"持续可见"而不刷屏的那一半）。
# ⚠ 红色与抢焦点**只给这一种情形**（DSH 真停）：看守那套"五灯不绿"的防骚扰冷却一个字都不动。
$script:StopColor = 'Red'
$script:StopTitle = '⚠ DSH 已停 —— 输入 r 回车重起（e = 关掉全部）'
function Get-DshStopAlarmLines {
    param($Status, [string]$Reason = '')
    $out = @()
    $out += ''
    $out += '  ══════════════════════════════════════════════════════════════'
    $out += '   ⛔ DSH 已停 —— 你现在没法在页面上给我下指令了'
    $out += ''
    if ($Reason) { $out += ('      {0}' -f $Reason) }
    $out += '      这个窗口是现在唯一还能用的通道：'
    $out += '        输入 r 回车（或直接回车）  =  重起 DSH'
    $out += '        输入 e 回车                =  关掉全部（DSH + SnowLuma + qq-bridge）'
    # 灯行也一起红（他要的是"一眼看出是 DSH 的事"）；灯仍然来自**唯一判定源**
    $lamps = @()
    if ($Status -and $Status.lights) {
        foreach ($k in @($script:LightLabels.Keys)) {
            $on = $false
            try { $on = [bool]$Status.lights.$k } catch { $on = $false }
            $lamps += ('{0} {1}' -f $script:LightLabels[$k], $(if ($on) { '✓' } else { '✗' }))
        }
    }
    if ($lamps.Count -gt 0) { $out += ('      灯    ' + ($lamps -join ' ｜ ')) }
    $out += ('      （{0}）' -f (Get-DshStopWhy))
    $out += '  ══════════════════════════════════════════════════════════════'
    return $out
}
# 打那段红告警。$Probe = 只读探针：把"本来会印什么、什么颜色"如实打出来，**不碰窗口、不改标题**。
function Write-DshStopAlarm {
    param($Status, [switch]$Probe, [string]$Reason = '')
    if (-not $Reason) { $Reason = $script:StopEscalated }
    if ($Probe) {
        Write-Host ('   [告警] [只读探针] 本来会用 **-ForegroundColor {0}** 打出下面这几行（并把这句写进窗口标题：{1}）：' -f $script:StopColor, $script:StopTitle)
        foreach ($l in (Get-DshStopAlarmLines -Status $Status -Reason $Reason)) { Write-Host ('      ' + $l) }
        return
    }
    foreach ($l in (Get-DshStopAlarmLines -Status $Status -Reason $Reason)) { Write-Host $l -ForegroundColor $script:StopColor }
    try { [Console]::Title = ('DSH-Web ' + $script:StopTitle) } catch { }
}

# ── r 之后"缺的服务一起补起"（2026-09-24 晚实测缺口，与上面那条同一类："说了但没做"）──────
# 承诺在哪：`?` 里写着 r = "重起 DSH（顺带自动同步令牌；桥接掉了会自动拉起）"，control.ps1 的
#   帮助里写着"缺的服务一起补起" —— 对**桥接**是真的（每次 r 都拉 ensure-bridge.ps1），
#   对**控制面**（tools\control-server.mjs，:3101）是空话 ✗：它由 start-all.ps1 用一条**裸的**
#   `cmd /c … node tools\control-server.mjs` 起，**没有任何守护**（桥接有 start.bat 守）。
#   实测：00:38:10 一键启动 ⇒ :3101 在（PID 20368）；00:51:34 窗口按 r ⇒ 00:51:37 :3101 死，
#   它的日志最后一行停在那一刻、全文没有报错 ⇒ **是被收掉的、不是崩的**；此后没人管它，
#   页面面板就一直"读不到状态"。
# 修法：**复用已有的那一条路** —— start-all.ps1 -NoRestart -NoOpen（"在跑的一律不动、只补起缺的
#   服务"，control.ps1 的 restart control 跑的就是这一条）⇒ **绝不在这里另写第二份起法**。
#   ⚠ 上面那串 `-NoRestart -NoOpen` 是**当时的**写法（历史文本，别照抄）——此后 `-NoOpen` 改成
#     **按账本判定**决定加不加：判定唯一一份 = `Resolve-MissingServiceOpenDecision`（真路径与只读入口共用），
#     2026-09-25 小镜复核 nit①（本条注释与现值不一致）由优化线 `63889df1` 订正。
#   两条硬约束：
#     ① **等 DSH 真的在监听之后**才调 —— `-NoRestart` 把"端口没在听"当成"DSH 缺了"，那时它会去起
#        第二个 DSH（start-all.ps1:415-419 的语义）。所以放在 Wait-LinkUp 之后、DSH 灯不亮就不做；
#     ② **不再带 `-KeepWindow`**（2026-09-25 主人亲口：「这个窗口没最小化」）：原来那句「不许把主人正看着的
#        窗口收进任务栏」是**当时的**取舍；现在的口径 = **正常启动 / 掉线自愈 / 补缺一律最小化**，
#        只有主人显式要看（`-KeepWindow` 那条手动退路）才留桌面 ⇒ 交给 tools\start-all.ps1 的引导判据自己判。
function Test-ControlAlive {
    if ($null -ne $script:ControlAliveProbe) { return [bool]$script:ControlAliveProbe }
    return (Test-PortQuick $ControlPort)
}
# ★ 纯函数（run 循环与 -EnsureOnce 共用同一份）：act = skip | none | repair
function Resolve-MissingServices {
    param([bool]$DshAlive, [bool]$ControlAlive, [bool]$QqNotLocal)
    if (-not $DshAlive) { return @{ act = 'skip'; mode = 'none'; why = 'DSH 还没在监听 —— 这时调"只补缺的服务"会被当成"DSH 缺了"、反而起出第二个 DSH ⇒ 这一步不做' } }
    if ($ControlAlive) { return @{ act = 'none'; mode = 'none'; why = '控制面已经在监听 ⇒ 什么都不做（启动器那一条自己也会跳过它，不会起第二个）' } }
    if ($QqNotLocal) {
        # ★ 2026-09-26（主人报「总控的灯不见了」的根因）：QQ 那套不在本机时**不能**走启动器那条
        #   （-NoRestart 会把 SnowLuma 与桥接一起起出来 ⇒ 抢号）—— 但也**不能**因此连控制面都不补：
        #   控制面与 QQ 毫无关系（它就是页面面板的载波）⇒ 只补它，走 tools\control-plane.ps1 那一份。
        return @{ act = 'repair'; mode = 'control-only'; why = '控制面没在监听，而 QQ 那套不在本机 ⇒ **只补控制面**（tools\control-plane.ps1 那一份唯一起法；不走启动器 ⇒ 绝不起 SnowLuma / 桥接）' }
    }
    # ★ 2026-09-25 20:0x：这句**不再写死 -NoOpen** —— 真路径会不会带它，取决于重启账本（见下一行 [补缺] 页面）。
    #   原来这里声称恒带 -NoOpen，主人自己按 r 时会与实际参数**自相矛盾**（行为探针的源码棘轮逮到的）。
    return @{ act = 'repair'; mode = 'launcher'; why = '控制面没在监听 ⇒ 走启动器那一条"只补起缺的服务"（start-all.ps1 -NoRestart [-NoOpen]；**最小化与否交给 start-all 的引导判据**，本处不再强制留桌面）' }
}
# ★ 纯函数（静态棘轮 + 复核直接看这一处）：补缺那条路要不要**带开页那一步**。
#   为什么分流（2026-09-25 主人报「重起后页面没刷新 + SnowLuma 令牌没更新」的**另一半**）：
#     · 主人**自己按 r** ⇒ 他就坐在机器前 ⇒ 页面这一环必须一起做（开页；本轮新起的 SnowLuma
#       由启动器自己带 -ForcePage snowluma —— 那一页 F5 救不回来，见 docs\启动与踩坑.md）；
#     · **自动拉起**（夜里没人看屏幕）⇒ 保持 -NoOpen：绝不弹他一脸页面 ✗。
#   判据 = 重启账本最后一条事件的 by（manual / auto，见 Add-RestartEvent）；**没有账本 ⇒ 按自动处理**（保守）。
function Resolve-MissingServiceOpenFlag {
    param($LastEvent)
    if ($LastEvent -and [string]$LastEvent.by -eq 'manual') {
        return @{ noOpen = $false; why = '这一代是**主人自己按 r** 发起的 ⇒ 页面那一步一起做（开页；本轮新起的页由启动器带 -ForcePage）' }
    }
    return @{ noOpen = $true; why = '自动拉起 / 没有重启账本 ⇒ 保持 -NoOpen（不弹主人一脸页面）' }
}
# ★ 唯一一份「读账本 → 判 manual/auto」：run 循环（Invoke-MissingServices）与只读验收入口（-EnsureOnce）共用。
#   为什么单独抽出来（2026-09-25 20:0x 行为探针那一批）：-EnsureOnce 原来**印的是写死的那条命令行**（恒带 -NoOpen），
#   与真路径已经分叉成两份口径 —— 主人自己按 r 的场景它照样印 -NoOpen ⇒ 拿它当验收证据会**假阴性**。
#   抽成一份之后，「验收看到的」必然等于「真跑的那套」；读账本失败 ⇒ 按 auto 保守处理（不弹页面）并如实说原因。
function Resolve-MissingServiceOpenDecision {
    try {
        $evs = @(Read-RestartEvents -WithinSec $script:AutoRestartWindowSec)
        $lastEv = $(if ($evs.Count) { $evs[$evs.Count - 1] } else { $null })
        return Resolve-MissingServiceOpenFlag -LastEvent $lastEv
    } catch {
        return @{ noOpen = $true; why = ('读重启账本失败（{0}）⇒ 保守按自动处理、不弹页面' -f $_.Exception.Message) }
    }
}
# ★ 补缺流水**默认不打屏**（2026-09-25 主人亲口提：「这个补缺可以去掉不显示吧」）：
#   成功 / 无事可做的流水一律静默，**细节仍落日志**（排查靠它，别丢）；
#   只有「**失败**」与「**判不准**」照打一行（`-Always`）—— 那正是需要他动手的两种情况；
#   要看全部流水：`$env:DSH_WINDOW_REPAIR_VERBOSE = '1'`（帮助里也写了那条）。
$script:RepairQuiet = -not ($env:DSH_WINDOW_REPAIR_VERBOSE -eq '1')
function Write-RepairNote {
    param([string]$Text, [switch]$Always)
    try {
        # ★ 根目录一律用 $PSScriptRoot 推（**别用 $Tools**）：dsh-window.cmd 传的是 `…\tools\.`，
        #   `Split-Path '…\tools\.' -Parent` 只退到 `…\tools`（不是仓库根）⇒ 日志落进 `tools\qq-bridge\state\`
        #   —— 2026-09-26 清掉的那棵残留树正是这个形状（真因不是"空串"，空串在 PS 5.1 下是抛错被吞）。
        $root = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { '' }
        # ★ fail-closed（自首 ⑥ 的第二条判据）：推不出真仓库根（脚本被搬出仓库 / 没有脚本文件）⇒
        #   **不写盘**，只打一行 —— 宁可少一条补缺日志，也不在别处造一棵 `qq-bridge\state\`。
        if (-not $root -or -not (Test-Path (Join-Path $root 'qq-bridge'))) { Write-Host ('   [补缺] ⚠ 推不出仓库根（$PSScriptRoot={0}）⇒ 本次不落日志' -f $PSScriptRoot); return }
        $log = Join-Path $root 'qq-bridge\state\launcher-repair.log'
        Add-Content -Path $log -Encoding UTF8 -Value ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text)
    } catch { }
    if ($Always -or -not $script:RepairQuiet) { Write-Host ('   [补缺] ' + $Text) }
}
function Invoke-MissingServices {
    # ★ 「QQ 那套不在本机」（搬家之后 / 只开 DSH 的入口）：**不走启动器那条补缺**（它会把 SnowLuma 与
    #   桥接一起起出来 ⇒ 抢号），但**控制面照补** —— 见 Resolve-MissingServices 的 control-only 那一支。
    #   （2026-09-26 修：这里原来是"整段跳过"，于是按 r 之后 :3101 死了没人管 ⇒ 主人看到"总控的灯不见了"。）
    # ★ "DSH 在不在"这里用**端口真实状态**（Test-DshAlive），不用状态里的灯 —— 更便宜、也是同一条判据：
    #   本函数只该在"DSH 真的在监听"时动手（否则会被当成"DSH 缺了"而起出第二个）。
    $notLocal = Test-QqNotLocal
    $plan = Resolve-MissingServices -DshAlive (Test-DshAlive) -ControlAlive (Test-ControlAlive) -QqNotLocal $notLocal
    if ($plan.act -ne 'repair') {
        if ($plan.act -eq 'skip') { Write-RepairNote $plan.why }
        return $plan
    }
    Write-RepairNote $plan.why
    # ★ control-only：**不另写起法**，就地调那一份唯一起法（本窗口跑在生产上下文里 ⇒ 它起的进程活得下来；
    #   开发会话里起常驻进程会随作业被回收，见 tools\control.ps1 里那条实测记录）。
    if ($plan.mode -eq 'control-only') {
        $cr = Start-ControlPlane -Port $ControlPort -WaitSec 15 -Quiet
        if ($cr.ok -and $cr.act -eq 'started') {
            Write-RepairNote ('控制面已经起来了 ✓（{0} 秒，pid {1}；页面面板马上就有数据）' -f $cr.secs, $cr.pid)
        } elseif ($cr.ok) {
            Write-RepairNote '控制面本来就在监听 ⇒ 什么都没做（不会起第二个）。'
        } else {
            Write-RepairNote ('⚠ 控制面**还是没起来**（{0}）—— 页面面板会显示"读不到状态"（三件套不受影响）。' -f $cr.why) -Always
            Write-RepairNote '下一步：跑一次 tools\dsh-only.ps1（或再按一次 r）。' -Always
        }
        return @{ act = $(if ($cr.ok) { 'repaired' } else { 'failed' }); mode = 'control-only'; why = $cr.why }
    }
    # ★ 页面那一步要不要做（2026-09-25 修；判据见 Resolve-MissingServiceOpenFlag 的注释）
    # ★★ 2026-09-25 20:0x：读账本 + 判定抽成 Resolve-MissingServiceOpenDecision，与 -EnsureOnce 共用（消灭第二份口径）。
    $missingSvcArgs = @()
    $openPlan = Resolve-MissingServiceOpenDecision
    if ($openPlan.noOpen) { $missingSvcArgs += '-NoOpen' }
    Write-RepairNote ('页面：' + $openPlan.why)
    $sa = Join-Path $Tools 'start-all.ps1'
    if (-not (Test-Path $sa)) {
        Write-RepairNote '⚠ 找不到 tools\start-all.ps1 —— 控制面没补起来；页面面板会显示"读不到状态"。重跑一次 一键启动.cmd 就行。' -Always
        return @{ act = 'failed'; why = '找不到启动器' }
    }
    try {
        # ★ 根目录一律用 $PSScriptRoot 推（别用 $Tools —— 它带 `\.` 尾巴，见 Write-RepairNote 那条）。
        $root = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { '' }
        if (-not $root -or -not (Test-Path (Join-Path $root 'qq-bridge'))) {
            Write-Host ('   [补缺] ⚠ 推不出仓库根（$PSScriptRoot={0}）⇒ 本次不补缺、不写盘' -f $PSScriptRoot)
            return @{ act = 'failed'; why = '推不出仓库根（不写盘、不补缺）' }
        }
        $tmp = Join-Path $root 'qq-bridge\state\_tmp'
        if (-not (Test-Path $tmp)) { New-Item -ItemType Directory -Path $tmp -Force | Out-Null }
        # ★ 2026-09-25：这里**不再带 `-KeepWindow`** —— 那等于强制"留桌面"（start-all.ps1 L870-871 那条判据），
        #   正是主人这次看到"窗口没最小化"的原因。去掉它 ⇒ 由 start-all 的引导判据决定（引导做完就一并缩进任务栏）。
        Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden `
            -RedirectStandardOutput (Join-Path $tmp 'ensure-services.out.log') `
            -RedirectStandardError  (Join-Path $tmp 'ensure-services.err.log') `
            -ArgumentList (@('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $sa, '-NoRestart') + $missingSvcArgs) | Out-Null
    } catch {
        Write-RepairNote ('⚠ 拉启动器失败（{0}）—— 页面面板会显示"读不到状态"。重跑一次 一键启动.cmd 就行。' -f $_.Exception.Message) -Always
        return @{ act = 'failed'; why = $_.Exception.Message }
    }
    # 等它把控制面拉起来（启动器内部等 15 秒），**如实报**结果 —— 绝不跟着横幅一起说"一切正常"。
    $ok = $false
    for ($i = 0; $i -lt 25; $i++) {
        Start-Sleep -Milliseconds 1000
        if (Test-PortQuick $ControlPort) { $ok = $true; break }
    }
    if ($ok) {
        Write-RepairNote '控制面已经起来了 ✓（页面面板马上就有数据）'
        Write-RepairNote '（启动器那一条是 -NoRestart：连清场都跳过；在跑的 DSH / 桥接 / SnowLuma 一律不动，只补没在监听的那几样）'
        return @{ act = 'repaired'; why = '控制面已补起' }
    }
    Write-RepairNote '⚠ 控制面**还是没起来** —— 页面面板会显示"读不到状态"（三件套不受影响）。' -Always
    Write-RepairNote '下一步：双击一次 一键启动.cmd（或按 r 再试一次）。' -Always
    return @{ act = 'failed'; why = '控制面没起来' }
}

# ★ 「QQ 没登录 / 没注入」这一格的**唯一判据**（纯函数：真循环与 -CheckQqAlert 共用同一份）——
#   主人 2026-09-26 原话：「qq 我之前忘记登录了 … 这个没有自动登陆的功能 要加个提示才行」。
#   ① 判据只有一条：control.ps1 的 `lights.qq`（唯一判定源；本文件不另算一套、不新增探针）。
#   ② 通道：**窗口标题**（一直挂在任务栏上 —— 那行红字他就是没看见）+ 复用现成的"跳出来"
#      （`Invoke-WindowPop`：SW_RESTORE + 试着置前，抢不到前台会如实说）。
#   ③ ⚠ **这一路绝不能依赖 QQ 通道**：QQ 没登录时 QQ 私聊根本发不出去（对着空气喊）
#      ⇒ 下一个人别"顺手"把它改成 `Send-OwnerQqNotice` / 走桥接。
#   ④ 文案**不编因果、不编耗时**：扫码 → QQ 客户端登录完成那一段我们没有任何日志
#      （SnowLuma 只在 `[Hook] login detected` 之后才说话；`qrcode` 在它 bundle 里 0 命中）
#      ⇒ 只说"约 1–2 分钟、属正常"，不写"因为桥接/窗口慢"这种没证据的因果。
#   ⑤ 红色与抢焦点**照旧只给"DSH 真停"**（那是主人指定的唯一一种打扰）—— 这一格只用标题 + 一次跳出来。
function Resolve-QqAlert([bool]$QqOnline, [bool]$NotLocal = $false) {
    # ★ 第三态（2026-09-26 搬家之后 / 只开 DSH）：**QQ 不在本机** ⇒ 既不是⚠（本机没坏），
    #   也不是"一切正常"（本机确实没有它）—— 是一句**说明**，而且**不弹窗、不改红字**。
    #   保留"服务器那边掉线会推他手机"这句：他得知道去哪看（Server酱）。
    if ($NotLocal) {
        return @{
            alert = $false; notLocal = $true
            title = 'QQ 已迁至服务器 — DSH-Web'
            line  = 'QQ 现在跑在服务器上（本机不再登录、也不起 SnowLuma）。它掉线会推你手机（Server酱），本机窗口不再看守 QQ。'
        }
    }
    if ($QqOnline) { return @{ alert = $false; notLocal = $false; title = 'DSH-Web'; line = '' } }
    return @{
        alert = $true; notLocal = $false
        title = '⚠QQ 未登录 — DSH-Web'
        line  = '⚠ QQ 没登录（没注入）⇒ 在这个窗口里按 s 登录；登录后约 1–2 分钟才恢复，属正常。'
    }
}

# ★ 判定的**纯函数**（循环与 -WatchOnce 共用同一份 —— 验收看到的就是真跑的那套）：
#   输入：这次灯态 / 上次灯态 / 窗口缩着没有 / 缩了多久 / 这轮红灯跳过没有
#   输出：act = 'pop'（去还原+置前）| 'wait'（冷却中，等）| 'quiet'（安静）
function Resolve-WatchDecision {
    param(
        [bool]$Green,
        [bool]$PrevGreen,
        [bool]$Minimized,
        [double]$MinimizedAgeMs,
        [bool]$PoppedThisRed,
        [int]$CooldownMs = 300000
    )
    if ($Green) {
        return @{ act = 'quiet'; why = '全绿：安静缩着（老用户不骚扰，§10.1-4）' }
    }
    if ($PoppedThisRed) {
        return @{ act = 'quiet'; why = '这一轮红灯已经跳过一次了（红了就一直弹 = 骚扰）' }
    }
    if ($Minimized -and $MinimizedAgeMs -ge 0 -and $MinimizedAgeMs -lt $CooldownMs) {
        $sec = [int]($MinimizedAgeMs / 1000)
        $cd = [int]($CooldownMs / 1000)
        return @{ act = 'wait'; why = ('他没缩多久（{0} 秒前缩的，冷却 {1} 秒）—— 推迟到冷却过再跳，不是取消' -f $sec, $cd) }
    }
    $edge = if ($PrevGreen) { '边沿：刚由绿变红' } else { '还红着（上一轮就该跳了，现在补上）' }
    return @{ act = 'pop'; why = ($edge + ' → 还原窗口 + 置前 + 打出那一行"下一动作"') }
}

# 真的去把窗口叫回来。抢不到前台**如实说**（照 panels.ps1 的 wake 的先例）。
# $Minimized 由调用方给（探针模式下是**注入值** —— 探针绝不碰真窗口）。
function Invoke-WindowPop {
    param([string]$NextLine, [switch]$Probe, [bool]$Minimized = $false)
    if ($Probe) {
        $what = if ($Minimized) { '还原窗口（SW_RESTORE）+ 试着置前 + 打出那一行"下一动作"' }
                else { '窗口本来就在桌面上（不动它），只在窗口里打出那一行"下一动作"' }
        Write-Host ('   [看守] [只读探针] 窗口现在{0} —— 本来会做：{1}' -f $(if ($Minimized) { '是缩着的' } else { '就在桌面上' }), $what)
        if ($NextLine) { Write-Host ('   [看守] [只读探针] 本来会打出：' + $NextLine) }
        return
    }
    if (-not (Initialize-WindowWatchType)) {
        Write-Host '   [看守] 调不到 Windows 的窗口接口 —— 没法自己跳出来，请点任务栏那个窗口。'
        return
    }
    # 候选句柄：**先**按标题找到的真窗口，再捎上 GetConsoleWindow。
    # ★ 为什么要换顺序（2026-09-24，与上面 Test-ConsoleMinimized 同一个坑）：WT 下
    #   `GetConsoleWindow()` 给的是**伪控制台窗口**，对它 ShowWindow / SetForegroundWindow 都不管事
    #   ⇒ 以前"出事自己跳出来"在 WT 里其实**没把窗口叫回来**，却还印着"窗口已经还原了"。
    $handles = New-Object System.Collections.ArrayList
    foreach ($h in @(Get-DshConsoleWindowHandles)) {
        if ($h -and $h -ne [IntPtr]::Zero) { [void]$handles.Add([IntPtr]$h) }
    }
    try {
        $ch = [DshWin.W]::GetConsoleWindow()
        if ($ch -ne [IntPtr]::Zero -and -not ($handles | Where-Object { $_ -eq $ch })) { [void]$handles.Add($ch) }
    } catch { }
    if ($handles.Count -eq 0) {
        Write-Host '   [看守] 拿不到本窗口的句柄（可能是没有控制台的运行方式）—— 请点任务栏那个窗口。'
        return
    }
    $wasMin = $false
    $restoredAny = $false
    foreach ($h in $handles) {
        $iconic = $false
        try { $iconic = [DshWin.W]::IsIconic($h) } catch { }
        if ($iconic) {
            $wasMin = $true
            # 9 = SW_RESTORE（不是 SW_SHOW：缩着的时候要用 RESTORE 才会回到原来的大小）
            try { [void][DshWin.W]::ShowWindow($h, 9) } catch { }
        }
    }
    if ($wasMin) {
        Start-Sleep -Milliseconds 250
        foreach ($h in $handles) {
            try { if (-not [DshWin.W]::IsIconic($h)) { $restoredAny = $true } } catch { }
        }
    }
    # 置前只对**第一个**候选（= 按标题找到的真窗口）做：置前一个伪控制台窗口没有意义。
    $ok = $false
    try { $ok = [DshWin.W]::SetForegroundWindow([IntPtr]$handles[0]) } catch { $ok = $false }
    Write-Host ''
    Write-Host '  ══════════════════════════════════════════════════════════════'
    Write-Host '   ⚠ 出问题了 —— 我把这个窗口自己叫回来了（这就是"出事自己跳出来"）'
    if ($NextLine) { Write-Host ('   ' + $NextLine) }
    if ($wasMin -and -not $restoredAny) {
        Write-Host '   （窗口本来是缩着的，我试着还原但系统没让 —— 点一下任务栏里那个窗口就行）'
    } elseif ($ok) {
        Write-Host '   （处理办法就在上面这一行；处理完按 e 关全部、按 r 重起+自动修）'
    } elseif ($wasMin) {
        Write-Host '   （窗口已经还原了，但 Windows 不让后台进程抢前台 —— 点一下任务栏里那个窗口就行）'
    } else {
        Write-Host '   （窗口本来就在桌面上，但 Windows 不让后台进程抢前台 —— 点一下任务栏里那个窗口就行）'
    }
    Write-Host '  ══════════════════════════════════════════════════════════════'
}

# ── 状态变了就重印那几行（2026-09-24 晚，主人："状态变绿了屏幕上还挂着红的，我只能靠再按一次 ?"）──
# 三条规矩（少一条就是新毛病）：
#   ① 判据**只用现成的唯一判定源**（Get-ControlStatus → control.ps1 status → ops.mjs status --json）——
#      这里只做"跟**上一次印过的**那份比一比"，绝不自己判灯（两处实现是本项目最忌的）✗；
#   ② 一模一样 ⇒ **一声不吭**（主人刚因为"等待提示刷了十几行"提过意见）；
#   ③ 变了 ⇒ 只说**变的是哪一样**（"刚才：令牌 ✗ → 现在 ✓"）+ 重印状态那两行，不把整屏又打一遍。
# 触发时机：看守循环本来就在定时问状态（15 秒触发器 / 绿灯 60 秒）⇒ 就在拿到状态那一处顺带比一下，
# 不新增任何轮询、不新增任何进程。
$script:banner = @{ last = $null; lastPrintAt = [datetime]::MinValue }   # "上一次印过的那份状态" + "上次印是什么时候"（"别刷屏"的合并窗口用）
# 显示用的灯名（**只是文案**，不是判定；判定一律来自 $Status）
$script:LightLabels = [ordered]@{ dsh = 'DSH'; bridge = '桥接'; snowluma = 'SnowLuma'; qq = 'QQ'; token = '令牌' }

# ── 会话卫生（设计 §12）：那一格"本对话 N 步 / M 轮" + 单独一条慢节拍 + 一次性提醒 ─────────
# 口径（唯一权威：docs\qq-agent-产品设计.md §12；判据 / 冷却 / 落盘**全在 tools\sessions.mjs 一处**）：
#   · 本文件**只显示**：那一格取 `status --json`；提醒**原样**印 `nudge --json` 的 text ——
#     **不自己判阈值、不自己节流**（第二份阈值/节流会让"同会话同档只响一次"失效）；
#   · 读不到数据（工具不在 / 超时 / ok:false / 没给 current）⇒ **什么都不显示、一个字都不说**，
#     绝不因此报红（唯一例外：主人按 a 那一次必须如实报错，见 Invoke-SessionArchiveAndNew）；
#   · 慢节拍**单独一条**（60 秒），刻意不与 15 秒探活同频；每条 node 调用都有硬超时，
#     一轮里的总预算也有上限 —— 窗口循环宁可少显示一格，也**不许**被 node 卡住。
# ★ 那一格为什么有两个数（步数 + 轮数）——免得下一个人又想拿它们互相换算：
#   **轮数与步数不能互相换算**：每轮步数中位 40 / p10 6.9 / p90 96 / min 1 / max 180
#   （实测：某子代理 2 轮 237 步 = 118 步/轮；她的 QQ 会话 38 轮 203 步 = 5.3 步/轮）
#   ⇒ **两档阈值只看步数**（§12.2，200/400）；轮数纯粹是给主人对 GUI 右上那行「N 轮 M 步」的参考，
#     读不到就整个不显示轮数（**绝不显示 0 轮**）。
# ★ 那一格里的「¥花费」是什么钱：**官方闲时价折算**（未命中 ¥1/M、命中 ¥0.02/M、输出 ¥4/M），
#   用来一眼看出"这条对话贵不贵"——**它不是账单**（账单口径看 tools\usage-report.mjs 的账本）。
#   判档那件事（金额进不进判据）**不在本文件**：这边只显示 tools\sessions.mjs 给的 cost，
#   读不到就整个不显示金额（**绝不显示 ¥0**）；带不带"建议归档"**仍然只看步数**。
$script:StepsIntervalMs = 60000          # 慢节拍：多久去问一次
$script:StepsTimeoutMs  = 6000           # 单条 node 调用的硬超时（超了就杀进程、当"读不到"）
$script:StepsBudgetMs   = 9000           # 一轮慢节拍里所有 node 调用的总预算
$script:StepsWarnAt     = 200            # §12.2 先提醒档（**只看步数**）：≥200 步那一格才带"建议归档（按 a）"
$script:steps = @{
    known   = $false                 # 有没有拿到过一份**可信的**数（没有 ⇒ 那一格整个不显示）
    n       = 0
    turns   = $null                  # 轮数：**只用于显示**（$null = 读不到 ⇒ 不显示轮数，绝不显示 0 轮）
    cost    = $null                  # 花费（元，官方闲时价折算）：$null = 读不到 ⇒ 不显示金额，绝不显示 ¥0
    id      = ''                     # a 键要归档的那条（= status 里的 current.id）
    shortId = ''
    at      = [datetime]::MinValue   # 上次真去问是什么时候（慢节拍靠它）
    armed   = $false                 # 「已授权归档」：主人回过「归档」⇒ 桥接空闲时会**自动归档**（§12.7 新语义）
                                     # 判据**不在这里**：只搬 status --json 的 current.armed（桥接/工具那边算好的）
}

# ── a 键的**忙时二次确认**（2026-09-25 追加；主人："归档请求感觉可以等子进程结束再发"）──────────
# 主人人在键盘前、按 a 是**显式动作** ⇒ 这里**不做硬闸**（硬闸在桥接那半的 runArchiveConfirm：
# 忙的时候它一个字都不动）。这里只做"第一次按先解释、短窗口内再按一次才真动手"。
# 判据**不在这里**：只搬 tools\sessions.mjs `status --json` 的 lineRunning / childRunning / running
# （那份判据住在 tools\sessions.mjs 的 withLineBusy；ps1 里另写一套就会两边打架）。
# ⚠ 读不到 ⇒ 当"不知道"，**照旧允许归档**（手动路径不能被读不到卡死），但要在屏幕上说清判不出来。
$script:ArchiveBusyConfirmSec = 60
$script:archiveBusyArmed = @{ id = ''; at = [datetime]::MinValue }

function Get-SessionLineBusy($cur) {
    if (-not $cur) { return @{ state = 'unknown'; why = '工具没给出当前对话' } }
    $names = @()
    try { $names = @($cur.PSObject.Properties.Name) } catch { $names = @() }
    if ($names -contains 'lineRunning') {
        $busy = $false
        try { $busy = [bool]$cur.lineRunning } catch { return @{ state = 'unknown'; why = 'lineRunning 读不出来' } }
        if (-not $busy) { return @{ state = 'idle'; why = '' } }
        $self = $false; $kids = 0
        try { $self = [bool]$cur.running } catch { $self = $false }
        try { $kids = [int]$cur.childRunning } catch { $kids = 0 }
        if ($self -and $kids -gt 0) { return @{ state = 'busy'; why = ('它自己还在跑，另外还有 {0} 个子任务在跑' -f $kids) } }
        if ($self) { return @{ state = 'busy'; why = '它自己还在跑' } }
        if ($kids -gt 0) { return @{ state = 'busy'; why = ('它自己空着，但还有 {0} 个子任务在跑' -f $kids) } }
        # lineRunning=true 但两个明细都读不出来 ⇒ 照工具给的结论（判定权在工具那边）
        return @{ state = 'busy'; why = '工具说这条线还在跑' }
    }
    if ($names -contains 'running') {
        $busy = $false
        try { $busy = [bool]$cur.running } catch { return @{ state = 'unknown'; why = 'running 读不出来' } }
        if ($busy) { return @{ state = 'busy'; why = '它自己还在跑（这个版本的会话工具还没给"子任务在不在跑"）' } }
        # 只给了自己那一半 ⇒ 子任务在不在跑判不出来 ⇒ 当"不知道"（照旧允许）
        return @{ state = 'unknown'; why = '工具只给了"自己"那一半（没有 lineRunning），子任务在不在跑判不出来' }
    }
    return @{ state = 'unknown'; why = '这个版本的会话工具没给"忙不忙"的字段（没有 lineRunning）' }
}

# tools\sessions.mjs 的路径。测试钩子（正常启动流程一律不设；与 DSH_WINDOW_STATUS_JSON 一个路子）：
#   $env:DSH_WINDOW_SESSIONS_CLI = <一份假 CLI 的路径> —— 用来在不碰真工具的前提下验成功/失败两条路。
function Get-SessionsCliPath {
    $hook = [string]$env:DSH_WINDOW_SESSIONS_CLI
    if ($hook -and (Test-Path $hook)) { return $hook }
    return (Join-Path $PSScriptRoot 'sessions.mjs')
}

# 工具给的原因（error / message / reason / why / detail，哪个有就用哪个）—— 只给 a 键报错用。
function Get-SessionsCliReason($data) {
    if ($data) {
        foreach ($k in @('error', 'message', 'reason', 'why', 'detail')) {
            try { $v = [string]$data.$k; if ($v) { return $v } } catch { }
        }
    }
    return '工具没给出原因'
}

# 把工具的一段输出压成"能直接接在 `✗ …：` 后面"的一句话（去掉它自己的 ❌ 和重复的"归档失败："前缀）。
function Format-SessionsSnippet([string]$s) {
    $t = (($s -replace '\s+', ' ').Trim())
    $t = ($t -replace '^[❌\s:：]+', '')
    foreach ($p in @('归档失败：', '归档失败:', '新建失败：', '新建失败:')) {
        if ($t.StartsWith($p)) { $t = $t.Substring($p.Length) }
    }
    if ($t.Length -gt 100) { $t = $t.Substring(0, 100) + '…' }
    return $t
}

# ── 认工具的两种 JSON 形态（**只搬显示用的字段，判定一个都不自己算**）──────────────────
# 为什么要有这一层：接口契约形态是 `{ current: { id, shortId, steps, … } }`，而**现网** status --json 是
#   `{ currentSessionId, sessions: [ { id, steps, …, current: true } ] }` —— 两种都得认，否则这一格
#   在真机上会一直空着（"读不到就不显示"会退化成"永远不显示"）。
# ⚠ 不管哪种形态：**当前对话是谁 / 该不该提醒 / 发过没有**都是工具算的，这里只做字段搬运。
function Get-SessionsCurrent($data) {
    if (-not $data) { return $null }
    $cur = $null
    try { $cur = $data.current } catch { $cur = $null }
    if ($cur) { return $cur }
    $cid = ''
    try { $cid = [string]$data.currentSessionId } catch { $cid = '' }
    $rows = @()
    try { $rows = @($data.sessions) } catch { $rows = @() }
    if ($rows.Count -eq 0) { return $null }
    $row = $null
    if ($cid) { $row = @($rows | Where-Object { [string]$_.id -eq $cid }) | Select-Object -First 1 }
    if (-not $row) { $row = @($rows | Where-Object { $_.current }) | Select-Object -First 1 }
    if (-not $row) { return $null }
    $id = [string]$row.id
    if (-not $id) { return $null }
    $sid = ''
    try { $sid = [string]$row.shortId } catch { $sid = '' }
    if (-not $sid) { $sid = $id.Substring(0, [Math]::Min(8, $id.Length)) }
    # ⚠ 这个**兜底形状**（现网 status --json 是 `{currentSessionId, sessions[]}` 那种）也必须带上
    #   `armed`：漏了它 ⇒ "已授权归档"那一格在这条路上永远显示不出来（Update-SessionSteps 只认这个字段）。
    $armed = $false
    try { $names = @($row.PSObject.Properties.Name); if ($names -contains 'armed') { $armed = [bool]$row.armed } } catch { $armed = $false }
    return [pscustomobject]@{ id = $id; shortId = $sid; steps = $row.steps; turns = $row.turns; cost = $row.cost; title = [string]$row.title; armed = $armed }
}

# 轮数：**只用于显示**（跟 GUI 那行「N 轮 M 步」对得上）。读不到 / 不是数 ⇒ $null ⇒ 那一格不显示轮数，
# **绝不显示 0 轮**（0 轮是个真值，猜出来的 0 会骗人）；阈值一个都不看它。
function Get-SessionsTurns($cur) {
    $raw = $null
    try { $raw = $cur.turns } catch { $raw = $null }
    if (($null -eq $raw) -or ([string]$raw).Trim() -eq '') { return $null }
    $t = 0
    try { $t = [int]$raw } catch { return $null }
    if ($t -lt 0) { return $null }
    return $t
}

# 花费（元）：**只用于显示**（官方闲时价折算的口径注释见上面那段）。读不到 / 不是数 ⇒ $null ⇒
# 那一格不显示金额（**绝不显示 ¥0**）；0 元是个真值（新对话），只有真读到 0 才显示 ¥0.0。
function Get-SessionsCost($cur) {
    $raw = $null
    try { $raw = $cur.cost } catch { $raw = $null }
    if (($null -eq $raw) -or ([string]$raw).Trim() -eq '') { return $null }
    $c = 0.0
    try { $c = [double]$raw } catch { return $null }
    if ([double]::IsNaN($c) -or [double]::IsInfinity($c) -or $c -lt 0) { return $null }
    return $c
}

# nudge 的那句话：契约形态 `{ due, text }`；现网形态 `{ sends: [ { text, … } ] }`（这一轮真该发的都在里面）。
# ★ 这里**只取 text**：档位、冷却、"同会话同档只响一次"全在工具里（本文件不加第二份节流）。
function Get-SessionsNudgeTexts($data) {
    $texts = @()
    if (-not $data) { return $texts }
    if (@($data.PSObject.Properties.Name) -contains 'due') {
        $due = $false
        try { $due = [bool]$data.due } catch { $due = $false }
        $t = ''
        try { $t = [string]$data.text } catch { $t = '' }
        if ($due -and $t) { return @($t) }
        return $texts          # 契约形态：due:false ⇒ 一条都不印
    }
    try { foreach ($s in @($data.sends)) { $x = [string]$s.text; if ($x) { $texts += $x } } } catch { }
    return $texts
}

# ── 调 tools\sessions.mjs（本文件**不碰** DSH 的 RPC，一切走这一条 CLI）──────────────────
# 返回 @{ ok = <bool>; data = <JSON 对象或 $null>; why = '失败原因（人话）'; exit = <退出码>; out = <stdout>; err = <stderr> }。
# 失败一律兑现成 ok=$false：工具不在 / 起不来 / **超时** / 输出不是 JSON / 显式 ok:false。
# -Lenient：输出**不是 JSON** 时不当失败，改看退出码 —— 给 `archive` 用（它现在只打人话，退出码才是真结论）。
# ⚠ 超时只能靠 WaitForExit(毫秒)：同步 ReadToEnd() 会把"超时"变成"永远等下去"
#   （Get-ControlStatus 那种写法在这里不能用 —— 它没有超时需求，这里必须有）。
function Invoke-SessionsCli {
    param([string[]]$CliArgs, [int]$TimeoutMs = 6000, [switch]$Lenient)
    $cli = Get-SessionsCliPath
    if (-not (Test-Path $cli)) {
        return @{ ok = $false; data = $null; why = '找不到 tools\sessions.mjs'; exit = -1; out = ''; err = '' }
    }
    $p = $null
    try {
        # 路径里有空格要自己加引号（真机上 -Node 就是 'C:\Program Files\nodejs\node.exe'）。
        $exe = if ($Node) { [string]$Node } else { 'node' }
        if ($exe -match '\s') { $exe = '"' + $exe + '"' }
        $argLine = ('"{0}"' -f $cli)
        if ($CliArgs -and $CliArgs.Count -gt 0) { $argLine += ' ' + (@($CliArgs) -join ' ') }
        $psi = New-Object System.Diagnostics.ProcessStartInfo
        $psi.FileName = $exe
        $psi.Arguments = $argLine
        $psi.WorkingDirectory = (Split-Path $PSScriptRoot -Parent)
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = (New-Object System.Text.UTF8Encoding($false))
        $psi.StandardErrorEncoding = (New-Object System.Text.UTF8Encoding($false))
        $psi.UseShellExecute = $false
        $psi.CreateNoWindow = $true
        $p = [System.Diagnostics.Process]::Start($psi)
        # 先**两条都异步收**、再带超时等：这样"超时"才真的能超时，
        # 而且只收 stdout 会让写满 stderr 管道的子进程卡死（两件事都得防）。
        $tOut = $p.StandardOutput.ReadToEndAsync()
        $tErr = $p.StandardError.ReadToEndAsync()
        if (-not $p.WaitForExit($TimeoutMs)) {
            try { $p.Kill() } catch { }
            return @{ ok = $false; data = $null; why = ('超过 {0} 秒没返回' -f [int]($TimeoutMs / 1000)); exit = -1; out = ''; err = '' }
        }
        $out = ''; $err = ''
        try { $out = [string]$tOut.GetAwaiter().GetResult() } catch { $out = '' }
        try { $err = [string]$tErr.GetAwaiter().GetResult() } catch { $err = '' }
        $exit = -1
        try { $exit = [int]$p.ExitCode } catch { $exit = -1 }
        $a = $out.IndexOf('{'); $b = $out.LastIndexOf('}')
        $hasJson = ($a -ge 0 -and $b -gt $a)
        $data = $null
        if ($hasJson) { try { $data = ($out.Substring($a, $b - $a + 1) | ConvertFrom-Json) } catch { $data = $null } }
        if ($null -eq $data) {
            if ($Lenient -and $exit -eq 0) { return @{ ok = $true; data = $null; why = ''; exit = $exit; out = $out; err = $err } }
            # 工具自己说的那句话（stderr 优先）就是最好的原因；它什么都没说时才报"没给出结果"。
            $detail = if ($err.Trim()) { Format-SessionsSnippet $err }
                elseif ($out.Trim()) { Format-SessionsSnippet $out }
                else { ('没给出结果（退出码 {0}）' -f $exit) }
            return @{ ok = $false; data = $null; why = $detail; exit = $exit; out = $out; err = $err }
        }
        # ⚠ 只有**显式** ok:false 才算失败（现网形态没有 ok 字段 ⇒ 不误判）。
        if ((@($data.PSObject.Properties.Name) -contains 'ok') -and (-not [bool]$data.ok)) {
            return @{ ok = $false; data = $data; why = (Get-SessionsCliReason $data); exit = $exit; out = $out; err = $err }
        }
        return @{ ok = $true; data = $data; why = ''; exit = $exit; out = $out; err = $err }
    } catch {
        return @{ ok = $false; data = $null; why = $_.Exception.Message; exit = -1; out = ''; err = '' }
    } finally {
        if ($p) { try { $p.Dispose() } catch { } }
    }
}

# ── 60 秒慢节拍：读那一格 + 顺带问一次"该不该提醒" ───────────────────────────────
# $Probe   = 只读探针（-WatchOnce）：**不跑 nudge** —— 它会写"已提醒"状态、还可能往 QQ 发消息，
#            探针不许有副作用（status 是纯读，探针里照跑，好让"那一格会打成什么样"看得见）。
# $NoNudge = 只刷新那一格（a 键跑完顺手重读），**不碰提醒** —— 刚归档完不该马上又弹一条提醒。
function Update-SessionSteps {
    param([switch]$Force, [switch]$Probe, [switch]$NoNudge)
    $now = Get-Date
    if (-not $Force) {
        if (($now - $script:steps.at).TotalMilliseconds -lt $script:StepsIntervalMs) { return }
    }
    $script:steps.at = $now
    $t0 = Get-Date
    $r = Invoke-SessionsCli -CliArgs @('status', '--json') -TimeoutMs $script:StepsTimeoutMs
    if (-not $r.ok) {
        # 读不到 ⇒ 那一格不显示、不报错、不留痕（§12.4 第 8 条：读失败不算"已经提醒过"）。
        if ($Probe) { Write-Host ('   [会话卫生] 步数：读不到（{0}）—— 那一格不显示，也不出声。' -f $r.why) }
        return
    }
    $cur = Get-SessionsCurrent $r.data
    if (-not $cur) {
        $script:steps.known = $false
        if ($Probe) { Write-Host '   [会话卫生] 步数：工具没认出当前对话 ⇒ 那一格不显示（也绝不拿它当 a 键的目标）。' }
        return
    }
    $raw = $null
    try { $raw = $cur.steps } catch { $raw = $null }
    if (($null -eq $raw) -or ([string]$raw).Trim() -eq '') {
        $script:steps.known = $false
        if ($Probe) { Write-Host '   [会话卫生] 步数：当前对话没有 steps ⇒ 那一格不显示（绝不显示猜的数）。' }
        return
    }
    $n = 0
    try { $n = [int]$raw } catch { $script:steps.known = $false; return }
    $script:steps.known = $true
    $script:steps.n = $n
    $script:steps.turns = Get-SessionsTurns $cur
    $script:steps.cost = Get-SessionsCost $cur
    $script:steps.id = [string]$cur.id
    $script:steps.shortId = [string]$cur.shortId
    # ★ 「已授权归档」（2026-09-25 晚）：主人回过「归档」⇒ 桥接会在它空闲时**自动归档**、不再重问。
    #   只搬 `status --json` 的 current.armed（判据在 qq-bridge 的 archive-lib.isArmedAsk，本文件一个字都不自己算）。
    #   这个字段是**只增不删**的新字段；老版本工具没给 ⇒ 当 false（也就少说那一句，绝不影响 a 键与软闸）。
    $script:steps.armed = $false
    try {
        $names = @($cur.PSObject.Properties.Name)
        if ($names -contains 'armed') { $script:steps.armed = [bool]$cur.armed }
    } catch { $script:steps.armed = $false }
    if ($Probe) {
        $turnsTxt = if ($null -eq $script:steps.turns) { '（轮数读不到 ⇒ 不显示轮数）' } else { (' / {0} 轮' -f $script:steps.turns) }
        $costTxt = if ($null -eq $script:steps.cost) { '（花费读不到 ⇒ 不显示金额）' } else { (' · ¥{0}' -f (Format-Cost $script:steps.cost)) }
        Write-Host ('   [会话卫生] 慢节拍每 {0} 秒一次（与 15 秒探活分开）：本对话 {1} 步{2}{3}{4}{5}' -f `
            [int]($script:StepsIntervalMs / 1000), $n, $turnsTxt, $costTxt, `
            $(if ($script:steps.armed) { ' ⇒ 那一格会写"已授权归档：跑完自动归档"' } elseif ($n -ge $script:StepsWarnAt) { ' ⇒ 那一格会带"建议归档（按 a）"' } else { '' }), `
            $(if ($script:steps.armed) { '（工具说这条已经授权归档了 ⇒ 桥接空闲时自动归档，不再问）' } else { '' }))
        Write-Host '   [会话卫生] 一次性提醒：只读探针**不跑 nudge**（它会写"已提醒"状态、还可能发消息）。'
        return
    }
    if ($NoNudge) { return }   # 只刷新那一格：**不碰提醒**（a 键刚归档完，不该马上又提醒一次）
    # ★ 提醒：**原样印工具的 text**。档位、冷却、"同会话同档只响一次"全在工具里（这里不加节流）。
    #   `--ask-owner` = 顺带请桥接把一条确认问话发进主人的 QQ 私聊（他回「归档」才归档）。
    #   ★ 它的失败语义与别人不一样（桥接没在跑 / 那个接口还没上线 / 令牌读不到 ⇒ **非 0 退出、且不写"已提醒"**）：
    #     ① 只要 stdout 里**拿得到 JSON**，就照旧按它给的文案显示 —— **不因为退出码非 0 就把文案丢掉**
    #        （该不该说、说过没有全在工具里，两边判据别打架）；
    #     ② 拿不到 JSON ⇒ **静默**（不打错误、不刷屏）；工具没写状态 ⇒ **下一个慢节拍自然重试**（这是对的）；
    #     ③ 本文件**不**自己去调那个接口、不读令牌文件、不做重试补齐 —— 这里只当调用方。
    $left = $script:StepsBudgetMs - [int]((Get-Date) - $t0).TotalMilliseconds
    if ($left -lt 1500) { $left = 1500 }
    $nd = Invoke-SessionsCli -CliArgs @('nudge', '--json', '--ask-owner') -TimeoutMs $left
    if (-not $nd.data) { return }
    foreach ($text in @(Get-SessionsNudgeTexts $nd.data)) {
        if ($text) { Write-Host ('   ' + $text) }
    }
}

# a 键跑完（归档 + 开了新的）之后调用：**先清成"不知道"**（宁可那一格空着，也绝不显示旧对话的数），
# 再立刻重读一次；读不到就空着，等下一个慢节拍。
function Reset-SessionSteps {
    $script:steps.known = $false
    $script:steps.turns = $null
    $script:steps.cost = $null
    $script:steps.id = ''
    $script:steps.shortId = ''
    $script:steps.armed = $false
    $script:steps.at = [datetime]::MinValue
    Update-SessionSteps -Force -NoNudge
}

# ── a 键：归档当前对话 + 开一条新的（§12.5）────────────────────────────────────
# ★ 窗口里 `archive` **只在这里**被调用：主人按 a 才会走这一条路（"人手动归档"那条）。
#   ⚠ 2026-09-25 晚起还有**一条自动路**：他回过「归档」= 一次授权 ⇒ 桥接那半的轻节拍会在那条线空闲时
#   自动归档（§12.7；判据与执行都在桥接，不在本文件）。两条路互不干扰：这条路照旧要他按 a、忙时照旧软闸。
#   两步依次来：archive <current.id> --yes → new；失败**如实打印**、绝不静默、绝不假装成功。
function Invoke-SessionArchiveAndNew {
    try {
        Write-Host '  正在归档当前对话、并开一条新的…'
        $r = Invoke-SessionsCli -CliArgs @('status', '--json') -TimeoutMs $script:StepsTimeoutMs
        $cur = Get-SessionsCurrent $r.data
        if ((-not $r.ok) -or (-not $cur) -or (-not [string]$cur.id)) {
            # 拿不到目标就**什么都不做**（宁可不归档，也绝不猜一条去归档）。
            $why = if ($r.why) { ('（原因：{0}）' -f (Format-SessionsSnippet $r.why)) } else { '（工具没给出当前对话）' }
            Write-Host ('  没认出当前对话，先别按 a{0}' -f $why)
            return
        }
        $id = [string]$cur.id
        $short = [string]$cur.shortId
        if (-not $short) { $short = $id.Substring(0, [Math]::Min(8, $id.Length)) }
        $stepsTxt = ''
        $rawSteps = $null
        try { $rawSteps = $cur.steps } catch { $rawSteps = $null }
        if (($null -ne $rawSteps) -and ([string]$rawSteps).Trim() -ne '') { $stepsTxt = ('（{0} 步）' -f [int]$rawSteps) }

        # ★ 忙时二次确认（2026-09-25）：这条线还在跑 ⇒ 第一次按 a **只解释不动手**，
        #   短窗口内再按一次才真归档（同"重起 DSH"那种二次确认的路子）。
        #   判据来自 status --json 的 lineRunning/childRunning（见 Get-SessionLineBusy），本文件不另算一份。
        $busyInfo = Get-SessionLineBusy $cur
        if ($busyInfo.state -eq 'busy') {
            $nowAt = Get-Date
            $armed = $false
            if ($script:archiveBusyArmed.id -eq $id) {
                $ageSec = ($nowAt - $script:archiveBusyArmed.at).TotalSeconds
                if ($ageSec -ge 0 -and $ageSec -le $script:ArchiveBusyConfirmSec) { $armed = $true }
            }
            if (-not $armed) {
                $script:archiveBusyArmed = @{ id = $id; at = $nowAt }
                Write-Host ('  ⏸ 先别急：{0}。' -f $busyInfo.why)
                Write-Host '     现在归档会**掐掉在飞的那一轮**，新对话还得从头重来一遍（那份 token 就白付了）。'
                Write-Host ('     真要现在归档：{0} 秒内**再按一次 a**；愿意等它跑完就什么都别按（你要是已经在 QQ 里回过「归档」，它跑完会**自动归档**，不用再管）。' -f $script:ArchiveBusyConfirmSec)
                return
            }
            Write-Host '  （你按了第二次）那就按你说的归档 —— 这条线还在跑，掐掉的那一轮不补。'
        } elseif ($busyInfo.state -eq 'unknown') {
            Write-Host ('  （这条线忙不忙**判不出来**：{0} ⇒ 照旧允许归档，你自己拿主意。）' -f $busyInfo.why)
        }
        $script:archiveBusyArmed = @{ id = ''; at = [datetime]::MinValue }

        # ★ 全文件里唯一一处 archive：给了明确的 id + --yes（工具自己也拒绝"不指名"的归档）。
        #   加 -Lenient：现网的 archive 只打人话、靠退出码表态（契约形态会回 { ok, archived }）—— 两种都认。
        $ar = Invoke-SessionsCli -CliArgs @('archive', $id, '--yes') -TimeoutMs $script:StepsTimeoutMs -Lenient
        if (-not $ar.ok) {
            Write-Host ('  ✗ 归档失败：{0}' -f (Format-SessionsSnippet $ar.why))
            Write-Host '  （**什么都没变**：这条对话还在原处，新对话也没开 —— 要再试一次就再按 a。）'
            return
        }
        $archived = ''
        try { $archived = [string]$ar.data.archived } catch { $archived = '' }
        $archShort = if ($archived -and $archived -ne $id) { $archived.Substring(0, [Math]::Min(8, $archived.Length)) } else { $short }
        Write-Host ('  ✓ 已归档：{0}{1} —— 它进历史了（只读：不再收消息，数据不删）' -f $archShort, $stepsTxt)

        # new 带 --json：契约形态与现网形态都会回 JSON（现网回的是 { sessionId, workspaceId }）。
        $nw = Invoke-SessionsCli -CliArgs @('new', '--json') -TimeoutMs $script:StepsTimeoutMs -Lenient
        if (-not $nw.ok) {
            Write-Host ('  ✗ 新对话没开成：{0}' -f (Format-SessionsSnippet $nw.why))
            Write-Host '  （上面那条**已经归档**了 —— 页面上按 F5，或"新建会话"，就有新对话。）'
        } else {
            $nid = ''
            try {
                $nid = [string]$nw.data.shortId
                if (-not $nid) { $nid = [string]$nw.data.sessionId }
            } catch { $nid = '' }
            if ((-not $nid) -and $nw.out) {
                # 兜底：只打人话时从输出里认一个 sessionId（只用于显示，认不出就说"没给 id"）
                $m = [regex]::Match([string]$nw.out, '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}')
                if ($m.Success) { $nid = $m.Value }
            }
            if ($nid.Length -gt 8) { $nid = $nid.Substring(0, 8) }
            Write-Host ('  ✓ 新对话：{0}' -f $(if ($nid) { $nid } else { '（开好了，工具没给 id）' }))
            Write-Host '  在页面上按 F5 就能看到新对话。'
        }
        # 那一格（步数 / 短 id）指向的已经是**新**对话了 ⇒ 先清空再重读（绝不把旧对话的数留在屏幕上）。
        Reset-SessionSteps
    } catch {
        Write-Host ('  ✗ 归档失败：{0}' -f $_.Exception.Message)
    }
}

# 把一份 status 压成"可比的小快照"；没有 lights 就返回 $null（读不到 ⇒ 不比较、不出声）
function Get-StatusSnapshot {
    param($Status)
    if (-not $Status) { return $null }
    if ($null -eq $Status.lights) { return $null }
    $lights = [ordered]@{}
    foreach ($k in @($script:LightLabels.Keys)) {
        $v = $false
        try { $v = [bool]$Status.lights.$k } catch { $v = $false }
        $lights[$k] = $v
    }
    $text = ''
    try { $text = [string]$Status.nextAction.text } catch { $text = '' }
    # ★ 2026-09-25 精简（主人："状态行太啰嗦"）：签名里**只放档位**，不放精确步数/轮数/金额。
    #   原来三个精确值都在签名里 ⇒ 每涨一步签名就变 ⇒ 重印一行（一次长对话能刷几十行）。
    #   档位 = Get-StepsTier（0 / 1 / '-'），只有**跨档**（到 200 步那档）才算"变了"。
    # ★ 步数/轮数/花费/armed 现在**从传进来的那份状态里取**（原来是读 $script:steps 那个节流态）：
    #   ① 纯 —— 同一个输入永远同一个签名，不再受"上次刷新是什么时候"影响；
    #   ② 可注入 —— 只读入口 -StatusOnce 能拿两份**不同的**状态 JSON 验档位变化（否则两份快照共用
    #      同一个节流态、永远一样 ⇒ 档位改动根本测不出来）。判据与 Get-SessionsCurrent 同一套。
    $steps = $null; $turns = $null; $cost = $null; $armed = $false
    try {
        $cur = Get-SessionsCurrent $Status
        if ($cur) {
            if ($null -ne $cur.steps -and ([string]$cur.steps).Trim() -ne '') { try { $steps = [int]$cur.steps } catch { $steps = $null } }
            if ($null -ne $cur.turns) { $turns = $cur.turns }
            if ($null -ne $cur.cost) { $cost = $cur.cost }
            $armed = [bool]$cur.armed
        }
    } catch { $steps = $null; $turns = $null; $cost = $null; $armed = $false }
    $tier = Get-StepsTier $steps
    # ★ 「已授权归档」也进签名（2026-09-25 晚）：授权那一刻那一格的话会翻 ⇒ 必须能重印一次
    #   （否则他会一直看着旧的那句）。
    $sig = (($lights.GetEnumerator() | ForEach-Object { '{0}={1}' -f $_.Key, [int]$_.Value }) -join '|') + '#' + $text +
        '#tier=' + $tier +
        '#armed=' + $(if ($armed) { '1' } else { '0' })
    return @{ signature = $sig; lights = $lights; text = $text; allGreen = [bool]$Status.allGreen; steps = $steps; turns = $turns; cost = $cost; armed = $armed; tier = $tier }
}

# ★ 纯函数：两份快照比一比 ⇒ 变没变 / 变了哪几样（人话）。
#   返回 @{ changed = <bool>; bits = @(…); why = '…' }
function Compare-StatusSnapshot {
    param($Prev, $Now)
    if (-not $Now) { return @{ changed = $false; bits = @(); why = '这一次没拿到状态（读不到就不出声，绝不乱报变化）' } }
    if (-not $Prev) { return @{ changed = $true; bits = @('第一次拿到状态'); why = '还没印过状态' } }
    if ([string]$Prev.signature -eq [string]$Now.signature) { return @{ changed = $false; bits = @(); why = '和上次印过的一模一样' } }
    $bits = @()
    foreach ($k in @($script:LightLabels.Keys)) {
        $a = [bool]$Prev.lights[$k]; $b = [bool]$Now.lights[$k]
        if ($a -ne $b) {
            $bits += ('{0} {1} → {2}' -f $script:LightLabels[$k], $(if ($a) { '✓' } else { '✗' }), $(if ($b) { '✓' } else { '✗' }))
        }
    }
    if ([string]$Prev.text -ne [string]$Now.text) {
        $bits += ('那句话：「{0}」→「{1}」' -f [string]$Prev.text, [string]$Now.text)
    }
    # §12（2026-09-25 精简）：只有**档位**或**已授权归档**变了才算"这一格变了" —— 步数每涨一步不再报一次。
    #   文案用**那一格自己长什么样**来说（人话对得上他屏幕上看到的），而不是报一串数字。
    if (([string]$Prev.tier -ne [string]$Now.tier) -or ([bool]$Prev.armed -ne [bool]$Now.armed)) {
        $was = Format-StepsField $Prev.steps $Prev.turns $Prev.cost $Prev.armed
        $nowTxt = Format-StepsField $Now.steps $Now.turns $Now.cost $Now.armed
        $bits += ('本对话那一格：{0} → {1}' -f $(if ($was) { $was } else { '（不显示）' }), $(if ($nowTxt) { $nowTxt } else { '（不显示）' }))
    }
    if ($bits.Count -eq 0) { $bits += '灯和那句话都不一样了（细节没认出来）' }
    return @{ changed = $true; bits = $bits; why = '和上次印过的不一样' }
}

# 那几行**长什么样**（只拼字符串，不打印）—— 探针与真打印共用同一份，验收看到的就是真会印的。
# ★ 2026-09-25 主人报"窗口等待时会刷屏、一直弹消息" ⇒ 原来一变就印 **6 行**（框 + 状态 + 灯 + 刚才 + 框 + 空行），
#   一次启动能变好几次 ⇒ 几十行 ✗。现在压成**一行**（灯和"刚才变了什么"都在同一行里），并且
#   不是每次变化都印（见 Resolve-StatusPrint）：只有"能不能用"的变化才立刻印，其余的攒着合并成一次。
# §12：那一格"本对话 N 步 / M 轮 · ¥花费"长什么样（只拼字符串）。没有可信的数 ⇒ 返回 ''（整格不显示，绝不显示猜的数）。
# ★ 三个数的拼法**只有这一处**（状态行与"刚才：…"共用）—— 轮数/步数不能互相换算、金额也不参与任何判档。
# 金额一位小数就够（¥2.8 / ¥0.4 / ¥10.1）；位数用 InvariantCulture 钉死，免得跟系统区域的小数点跑偏。
function Format-Cost($Cost, [int]$Digits = 1) {
    $fmt = '0.' + ('0' * [Math]::Max(1, $Digits))
    try { return ([double]$Cost).ToString($fmt, [System.Globalization.CultureInfo]::InvariantCulture) }
    catch { return '' }
}

function Format-StepsCounts($Steps, $Turns, $Cost) {
    if ($null -eq $Steps) { return '' }
    $text = ('{0} 步' -f [int]$Steps)
    if ($null -ne $Turns) { $text += (' / {0} 轮' -f [int]$Turns) }        # 轮数读不到 ⇒ 整个不显示（不显示 0 轮）
    if ($null -ne $Cost) {
        $money = Format-Cost $Cost 1
        if ($money) { $text += (' · ¥{0}' -f $money) }                     # 花费读不到 ⇒ 整个不显示（不显示 ¥0）
    }
    return $text
}

# ★ 步数**档位**（2026-09-25，主人嫌状态行啰嗦的根因修法）：签名里只放档位、不放精确数
#   ⇒ 每涨一步**不再**重印（原来 #steps / #turns / #cost 三个精确值都在签名里 ⇒ 一步一变、一行一行刷屏）。
#   档位只看 §12.2 的 200 档（与「建议归档」同一个判据，不另算一套）；读不到 ⇒ '-'（不猜数）。
function Get-StepsTier($Steps) {
    if ($null -eq $Steps) { return '-' }
    if ([int]$Steps -ge $script:StepsWarnAt) { return '1' }
    return '0'
}

function Format-StepsField($Steps, $Turns, $Cost, $Armed = $false) {
    # ★ 2026-09-25 精简（主人："状态行太啰嗦"）：**平时不显示这一格** —— 只有「到档 / 已授权」这种
    #   **要你动手**的时候才出现，而且文案**不带精确数**（带了就又变成一步一变、每变一次重印一行）。
    #   精确的 N 步 / M 轮 / ¥花费在**页面右上那行**、以及按 ? 的说明里都能看到 ⇒ 状态行不必常驻它。
    # ★ 「已授权归档」优先（2026-09-25 晚，主人："我只要说了归档，你完成任务后自动归档就可以不用再问一次了"）：
    #   他回过「归档」⇒ 桥接空闲时会自动归档，这一格就**不该**再劝他"按 a"（那会让他以为还得自己动手）。
    #   判据是**搬过来的** current.armed（工具那边的 isArmedAsk），本文件不另算一套。
    # ⚠ **不声称**「已到建议归档档」：armed 与档位是**两回事**（步数很低也能已授权）⇒ 声称了就是假读数。
    if ([bool]$Armed) { return '本对话已授权归档：跑完自动归档' }
    # ⚠ 带不带「建议归档」**只看步数**（§12.2 的 200 档）；轮数与金额一个判据都不参与。
    if ($null -ne $Steps -and [int]$Steps -ge $script:StepsWarnAt) { return ('本对话已到建议归档档（≥{0} 步）· 按 a 归档' -f $script:StepsWarnAt) }
    return ''
}

function Format-StatusLines {
    param($Snap, $Bits)
    $lamps = @()
    foreach ($k in @($script:LightLabels.Keys)) {
        $lamps += ('{0} {1}' -f $script:LightLabels[$k], $(if ($Snap.lights[$k]) { '✓' } else { '✗' }))
    }
    $head = if ($Snap.allGreen) { '✓ ' } else { '' }
    # 那一格是**一个字段**（不是新的一行）：没有可信的数就整个不出现 —— 原来那一行的形状一个字都不变。
    $segs = @($head + $Snap.text)
    $stepField = Format-StepsField $Snap.steps $Snap.turns $Snap.cost $Snap.armed
    if ($stepField) { $segs += $stepField }
    $segs += ('灯 ' + ($lamps -join ' '))
    return @(('   {0} ｜ （刚才：{1}）' -f ($segs -join ' ｜ '), ($Bits -join '；')))
}

# ★ 纯函数：这一份状态**要不要印**（2026-09-25 主人的"别刷屏"要求）。
#   规则（三条，都可证伪）：
#     ① **灯 dsh 翻了**（✗→✓ 或 ✓→✗）⇒ 立刻印（"能不能用"变了，这是唯一值得打断他的事）
#     ② **变成全绿**（刚从"没全绿"过来）⇒ 立刻印（"可以用了"这一刻）
#     ③ 其余变化 ⇒ **攒着**：距今不到 MergeSec 就一声不吭（多次变化合并成下一次那一行里的"刚才：…"）
#   返回 @{ print = <bool>; urgent = <bool>; why = '…' }
function Resolve-StatusPrint {
    param($Prev, $Now, $Cmp, $LastPrintAt, $NowAt, [int]$MergeSec = 60)
    if (-not $Now) { return @{ print = $false; urgent = $false; why = '这一次没拿到状态（读不到就不出声，绝不乱报变化）' } }
    if (-not $Cmp.changed) { return @{ print = $false; urgent = $false; why = '和上次印过的一模一样' } }
    $dshA = $true; $dshB = $true
    try { $dshA = [bool]$Prev.lights['dsh'] } catch { $dshA = $true }
    try { $dshB = [bool]$Now.lights['dsh'] } catch { $dshB = $true }
    if ($null -eq $Prev) { return @{ print = $true; urgent = $false; why = '第一次拿到状态（先印一行，之后才有"变了"可比）' } }
    if ($dshA -ne $dshB) {
        return @{ print = $true; urgent = $true; why = ('DSH 那一盏 {0} → {1}（"能不能用"变了）⇒ 立刻印' -f $(if ($dshA) { '✓' } else { '✗' }), $(if ($dshB) { '✓' } else { '✗' })) }
    }
    $greenA = $false
    try { $greenA = [bool]$Prev.allGreen } catch { $greenA = $false }
    if ($Now.allGreen -and -not $greenA) { return @{ print = $true; urgent = $true; why = '从"没全绿"变成**全绿**（可以用了）⇒ 立刻印' } }
    $last = $LastPrintAt
    if ($last -isnot [datetime]) { $last = [datetime]::MinValue }
    $nowT = $NowAt
    if ($nowT -isnot [datetime]) { $nowT = Get-Date }
    $ago = if ($last -eq [datetime]::MinValue) { [double]::MaxValue } else { ($nowT - $last).TotalSeconds }
    if ($ago -lt $MergeSec) {
        return @{ print = $false; urgent = $false; why = ('和上次印只差 {0} 秒（<{1} 秒）⇒ 攒着，跟后面的变化合并成一行' -f [int]$ago, $MergeSec) }
    }
    return @{ print = $true; urgent = $false; why = ('距上次印已 {0} 秒 ⇒ 印一次（把攒下的变化一次说完）' -f [int]$ago) }
}

# 变了就印、没变就闭嘴；"要不要印"由 Resolve-StatusPrint 决定（不是一变就印 —— 见那里的三条规则）。
# 返回 $true = 印了（调用方要把 'DSH> ' 重新打出来）。
# $Probe = 只读探针：只打印"本来会印什么"，**不改** $script:banner.last（探针一个字节都不写）。
function Show-StatusIfChanged {
    param($Status, [switch]$Probe, $NowAt)
    $snap = Get-StatusSnapshot $Status
    $cmp = Compare-StatusSnapshot -Prev $script:banner.last -Now $snap
    $nowT = $NowAt
    if ($nowT -isnot [datetime]) { $nowT = Get-Date }
    $plan = Resolve-StatusPrint -Prev $script:banner.last -Now $snap -Cmp $cmp -LastPrintAt $script:banner.lastPrintAt -NowAt $nowT
    if (-not $snap) {
        if ($Probe) { Write-Host ('   [状态行] 不重印：' + $plan.why) }
        return $false
    }
    if (-not $plan.print) {
        if ($Probe) { Write-Host ('   [状态行] **不重印**（' + $plan.why + '）') }
        return $false
    }
    # ★ DSH 那一盏灭 = **他没法在页面上给我下指令了** ⇒ 这一行也用红印（和"DSH 已停"那段一个道理）；
    #   其余情况照旧默认色（红只留给"通道断了"这一件事，别把红色用贬值）。
    $color = ''
    try { if (-not [bool]$snap.lights['dsh']) { $color = $script:StopColor } } catch { $color = '' }
    if ($Probe) {
        Write-Host ('   [状态行] [只读探针] 会重印这 {0} 行（真跑时就地打出来，颜色 = {1}，**不碰窗口**）；理由：{2}' -f `
            (Format-StatusLines $snap $cmp.bits).Count, $(if ($color) { $color } else { '默认' }), $plan.why)
        foreach ($l in (Format-StatusLines $snap $cmp.bits)) { Write-Host ('      ' + $l) }
        return $true
    }
    Write-Host ''
    foreach ($l in (Format-StatusLines $snap $cmp.bits)) {
        if ($color) { Write-Host $l -ForegroundColor $color } else { Write-Host $l }
    }
    $script:banner.last = $snap
    $script:banner.lastPrintAt = $nowT
    return $true
}

# 循环里每 tick 叫一次；到点才真的动作（其余 tick 是一次 [datetime] 比较的成本）。
# $Status 给的是"这次的 control.ps1 status"（可能为 $null = 读不到）。
function Invoke-WatchTick([switch]$Probe, $Status, [switch]$Typing) {
    if (-not $script:WatchEnabled) { return }
    # 他正敲着半条命令：这一轮什么都不做（红着也先不跳）—— 免得把那一行回显撕开。
    # ⚠ 只是**推迟**：redPending 还留着，缓冲区一清就跳。
    if ($Typing -and -not $Probe) { return }
    $w = $script:watch
    $now = Get-Date
    if (-not $Probe -and ($now - $w.lastProbeAt).TotalMilliseconds -lt $script:WatchIntervalMs) { return }
    $w.lastProbeAt = $now

    # ①b 会话卫生的**单独一条慢节拍**（60 秒一次；刻意不与上面那条 15 秒探活同频 —— 两件事节奏不同）：
    #     它只更新状态行里那一格的值、并顺带印一次工具说该印的提醒（§12.2/§12.4 的判据都在工具里）。
    #     放在这个函数的开头而不是循环里：主人在敲字时本函数会提前 return ⇒ 提醒不会撕开他正在敲的那一行。
    try { Update-SessionSteps -Probe:$Probe } catch { }

    # ② 先看窗口缩着没有（顺带维护"他什么时候缩的"）。
    #    探针模式**绝不碰真窗口**：缩没缩、缩了多久一律用注入值（见 Start-WatchOnce）。
    if ($Probe) {
        $min = [bool]$w.minimized
    } else {
        $min = Test-ConsoleMinimized
        if ($min) {
            if (-not $w.minimized) { $w.minSince = $now }   # 刚被缩下去（我们没缩过 ⇒ 是他缩的）
        } else {
            $w.minSince = $null
        }
        $w.minimized = $min
    }
    $ageMs = if ($min -and $w.minSince) { ($now - $w.minSince).TotalMilliseconds } else { -1 }

    # ③ 触发器：绿灯时每 WatchFullMs 才问一次 control.ps1；触发器说"有端口不通"就立刻问。
    #    读不到状态时**不当作红**（避免因为自己读不到就乱弹窗），但记着、下一次再问。
    # ★ 提示态期间问得更勤（15 秒那档）：提示不仅要"出现快"，更要**消失快** —— 否则恢复之后
    #   标题还挂着 ⚠ 60 秒，就是第二次假警告（协调线 2026-09-26 的判据：两头都 ≤15 秒）。
    $fullMs = if ($w.qqAlert) { $script:WatchIntervalMs } else { $script:WatchFullMs }
    $due = ($now - $w.lastFullAt).TotalMilliseconds -ge $fullMs
    # ★ 「QQ 那套不在本机」时触发器**只看 DSH 端口**：否则那三个端口的触发器永远"不通"
    #   ⇒ 每 15 秒就去问一次 control.ps1（白烧子进程），而且判出来的红也全是假的。
    $cheapUp = if (Test-QqNotLocal) { Test-PortQuick $DshPort } else { Test-CheapTriggerAllUp }
    if (-not $cheapUp -or $due -or $Probe) {
        # 用户正在敲字（缓冲区里有半条命令）就先别拉子进程，免得卡住回显；15 秒后自然会再试
        if (-not $Probe -and $w.lastKeyAt -and ($now - $w.lastKeyAt).TotalSeconds -lt 10) { return }
        $w.lastFullAt = $now
        if (-not $Status) { $Status = Get-ControlStatus }
        if ($Status) {
            # ★ 「QQ 那套不在本机」时**只认 DSH 那盏灯**：桥接 / SnowLuma / QQ 本来就不该亮，
            #   拿 allGreen 判红会把这个窗口变成"永远在报警"（假警报比漏报更坏）。
            $notLocalNow = Test-QqNotLocal
            $dshLamp = $true
            try { $dshLamp = [bool]$Status.lights.dsh } catch { $dshLamp = $true }
            $green = if ($notLocalNow) { $dshLamp } else { [bool]$Status.allGreen }
            # ★ 已知启动窗口（2026-09-24 晚，主人实拍那一屏）：刚发起过启动/重启（= control 层的
            #   `status.starting.active`，判定在 tools\starting-window.mjs 一处）⇒ 桥接这几秒没在监听
            #   是**预期内**的 —— 这时把窗口叫回来、还印"处理完…按 r"，就是那条假警告本身。
            #   与"读不到状态时不当作红、不会乱弹窗"同一个原则：不确定/预期内的事，别弹。
            #   ⚠ 这一次**不清 redPending**：宽限期一过还是没起来，下一轮照旧跳出来叫她 ——
            #     真故障一个字都不许吞（这是这条改动的底线）。
            $starting = $false
            try { $starting = [bool]$Status.starting.active } catch { $starting = $false }
            $d = Resolve-WatchDecision -Green $green -PrevGreen $w.green -Minimized $min `
                -MinimizedAgeMs $ageMs -PoppedThisRed $w.poppedThisRed -CooldownMs $script:WatchCooldownMs
            if ($green) {
                $w.green = $true; $w.redPending = $false; $w.poppedThisRed = $false
            } else {
                if ($w.green) { $w.redPending = $true }   # ★ 边沿：就是"从绿变红的那一次"
                $w.green = $false
            }
            $poppedNow = $false   # 这一轮已经跳过窗口了（DSH 红那条路与 QQ 提示那条路共用这一个额度）
            if ($d.act -eq 'pop' -and $w.redPending -and -not $starting) {
                $line = Format-NextActionLine $Status.nextAction
                if (-not $line) { $line = '（control.ps1 没给出"下一动作"，就照上面的灯看）' }
                Invoke-WindowPop -NextLine $line -Probe:$Probe -Minimized $min
                $poppedNow = $true
                if (-not $Probe) { $w.poppedThisRed = $true; $w.redPending = $false }
            } elseif ($starting -and -not $green) {
                # ★ 只印**一次**（2026-09-25 主人："等待的时间会刷屏、一直弹消息" —— 协调会话定位到
                #   这里：`graceLeftSec` 那个倒数原来**每轮都印** ✗）。同一个启动窗口只印一遍，
                #   剩多少秒只在那一遍里说；之后要嘛变绿（状态行会印）、要嘛进红（告警那条路），
                #   都不需要再重复这句"预期内、不用按 r"。
                $what = [string]$Status.starting.what
                if ($script:watch.graceSaidFor -ne $what) {
                    $script:watch.graceSaidFor = $what
                    $left = ''
                    try { if ($null -ne $Status.starting.graceLeftSec) { $left = ('，还剩 {0} 秒' -f [int]$Status.starting.graceLeftSec) } } catch { }
                    Write-Host ('   [看守] 已知启动窗口内（{0}{1}）—— 桥接还没监听是预期内的，这次不叫窗口、也不用按 r。' -f $what, $left)
                    Write-Host '   [看守] （这句同一个启动窗口只说一遍；好了会印一行状态，出问题会红字叫你。）'
                } elseif ($Probe) {
                    Write-Host ('   [看守] 已知启动窗口内（{0}）—— **这句已经说过了，不再重复**（不刷屏）' -f $what)
                }
            } elseif ($Probe) {
                Write-Host ('   [看守] {0} ｜ 判定：{1}' -f $(if ($green) { '灯态=全绿' } else { '灯态=有灯不绿' }), $d.why)
            }

            # ── QQ 未登录 / 没注入的提示（2026-09-26 主人点名要的那条）────────────────────────────
            #   判据 = control.ps1 的 lights.qq（唯一判定源）；通道 = 窗口标题 + 复用 Invoke-WindowPop。
            #   ⚠ **不走 QQ**：QQ 没登录时 QQ 私聊根本发不出去（见 Resolve-QqAlert 的注释③，别改）。
            #   读不到状态 / 正在"已知启动窗口"里 ⇒ **不提示**（同"读不到状态不当作红"的原则：不确定的
            #   事别弹 —— 刚起服务那几十秒 SnowLuma 还没起来是预期内的；宽限期一过照旧提示，一个字不吞）。
            #   ★ 第三态「**QQ 不在本机**」（搬家之后 / 只开 DSH 的入口）⇒ 不是⚠，是一句**说明**：
            #     它跑在服务器上、掉线会推手机（Server酱），本机窗口不再看守 QQ —— 不弹窗、也不改红字。
            $dshOn = $dshLamp
            $qqOnline = $true
            try { $qqOnline = [bool]$Status.lights.qq } catch { $qqOnline = $true }
            $qa = Resolve-QqAlert -QqOnline $qqOnline -NotLocal $notLocalNow
            if ($qa.notLocal) {
                if (-not $w.qqNotLocal) {
                    $w.qqNotLocal = $true
                    try { [Console]::Title = $qa.title } catch { }
                    Write-Host ('   [QQ] ' + $qa.line) -ForegroundColor DarkGray
                }
                # 从"⚠ 未登录"切到"已迁走"：提示态归零（标题已经被上面那句覆盖成"已迁至服务器"）
                if ($w.qqAlert) { $w.qqAlert = $false; $w.qqPopped = $false }
            } elseif ($w.qqNotLocal) {
                # 搬回来了（标记文件被删 / 不再只开 DSH）⇒ 标题回基线，后面按正常两态判
                $w.qqNotLocal = $false
                try { [Console]::Title = $qa.title } catch { }
                Write-Host '   [QQ] （本机又开始自己登 QQ 了 —— 标题改回基线，后面按"未登录 / 在线"两态判。）' -ForegroundColor DarkGray
            }
            if ($qa.alert -and -not $starting -and $dshOn) {
                if (-not $w.qqAlert) {
                    $w.qqAlert = $true
                    try { [Console]::Title = $qa.title } catch { }
                    Write-Host ('   [QQ] ' + $qa.line) -ForegroundColor Yellow
                    Write-Host '   [QQ] （标题也改了 —— 缩在任务栏里也看得见；登录回来我会自动撤掉。）' -ForegroundColor DarkGray
                }
                if (-not $w.qqPopped -and -not $poppedNow) {
                    Invoke-WindowPop -NextLine $qa.line -Probe:$Probe -Minimized $min
                    if (-not $Probe) { $w.qqPopped = $true }
                }
            } elseif ($w.qqAlert -and $dshOn) {
                # ★ 恢复即撤（判据的另一半）：标题改回**无 ⚠ 的基线**，并且下次再掉还能再提醒一次。
                $w.qqAlert = $false
                $w.qqPopped = $false
                try { [Console]::Title = $qa.title } catch { }   # 在线 ⇒ $qa.title = 'DSH-Web'（基线）
                Write-Host '   [QQ] QQ 回来了（灯已绿）—— 标题也改回来了。' -ForegroundColor DarkGray
            }
            # ★ 状态变了就**就地重印**那两行（2026-09-24 晚，主人："变绿了屏幕上还挂着红的"）。
            #   一模一样 ⇒ 什么都不打（不刷屏）。真打印时补一个 'DSH> ' —— 这里只在"他没在敲字"
            #   的时候才走到（缓冲区非空的话 Invoke-WatchTick 早就 return 了）。
            try {
                if (Show-StatusIfChanged -Status $Status -Probe:$Probe) {
                    if (-not $Probe) { Write-Host -NoNewline 'DSH> ' }
                }
            } catch { }
        } elseif ($Probe) {
            Write-Host '   [看守] 读不到状态（control.ps1 status 没跑起来）—— 不当作红，不会乱弹窗。'
        }
    } elseif ($Probe) {
        Write-Host '   [看守] 触发器：三个关键端口都通（这只说明"值得信"，判定仍要问 control.ps1）。'
    }
}

# 窗口启动时 DSH 是**我们马上要起的那个**（此刻当然没在跑）—— 这时候把 control 那行
# "⚠ DSH 没在跑" 打出来就是吓人且没用。所以横幅**等它亮起来再打**：轮询 control.ps1 status
# （还是唯一判定源）直到 DSH 与桥接都在，最多 20 秒；超时就照实打当时的真相。
function Wait-LinkUp([int]$TimeoutSec = 20) {
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $st = $null
    while ((Get-Date) -lt $deadline) {
        # ★ 不再只看自己的子进程（见 Resolve-DshStop）：子进程换了、而 DSH 还活着时，
        #   原来那句 `break` 会让横幅立刻照"DSH 没在跑"打 —— 假的。
        $childGone = $false
        if ($script:child) {
            try { $childGone = [bool]$script:child.HasExited } catch { $childGone = $true }
        }
        if ($childGone -and -not (Test-DshAlive)) { break }
        $st = Get-ControlStatus
        if ($st -and [bool]$st.lights.dsh -and [bool]$st.lights.bridge) { return $st }
        Start-Sleep -Milliseconds 1500
    }
    if ($st) { return $st }
    return (Get-ControlStatus)
}

function Show-StartBanner {
    # 一行就够：具体状态由下面 Show-Banner 打（等 DSH 起来后）；日志路径只在 `?` 里（§10.1-2）。
    Write-Host ''
    Write-Host '  ------------------------------------------------------------'
    Write-Host '   DSH 正在启动 …'
    Write-Host '  ------------------------------------------------------------'
}

function Show-AskBanner {
    Write-Host ''
    Write-Host '  ============================================================'
    # ★ 这一屏只在"真掉线"时才该出现（判据见 Resolve-DshStop）：说清原因，别让她以为是自己点错了。
    Write-Host ('   {0}。' -f (Get-DshStopWhy))
    Write-Host ''
    Write-Host '     输入 e（或 exit）再回车  =  关闭全部（DSH + SnowLuma + qq-bridge）'
    Write-Host '     直接回车（或输入 r）      =  只重新启动 DSH'
    Write-Host '  ============================================================'
    Write-Host -NoNewline 'DSH> '
}

# 把一行输入翻成结论：返回 0（关闭全部）或 1（只重起 DSH）
function Resolve-Answer([string]$line) {
    $ans = $line.Trim().ToLowerInvariant()
    if ($CloseWords -contains $ans) {
        Write-Host ''
        Write-Host '  好，正在关闭全部（DSH + SnowLuma + qq-bridge）…'
        return 0
    }
    if ($RestartWords -contains $ans) {
        Write-Host ''
        Write-Host '  好，只重新启动 DSH。'
        return 1
    }
    Write-Host ''
    Write-Host ('  没认出「{0}」—— 按"只重新启动 DSH"处理（要关闭全部请输入 e）。' -f $line.Trim())
    return 1
}

# 问一句（DSH 已经停了的时候用）：读一行，返回 0/1/2
function Ask-WhatToDo {
    Show-AskBanner
    # 直接读控制台（不是 Read-Host：不重复打印提示，stdin 枯竭时稳稳返回 $null）
    $line = [Console]::ReadLine()
    if ($null -eq $line) {
        Write-Host ''
        Write-Host '  输入已结束（没有控制台 / 脚本化运行）—— 按"关闭全部"处理。'
        return 2
    }
    return (Resolve-Answer $line)
}

if ($PrintBanner -or $Help) {
    # ★ 只打印横幅：不进交互、不拉起 DSH、不碰任何服务，跑完立即 exit 0。
    #   打的就是**真横幅** —— 用的是交互模式同一个 Show-Banner，文案只有这一份（不复制）；
    #   多打的那行 `[窗口] 完成态=… 决定=…` 也是**真判据**（-DryRun 只读，一个字节都不写）。
    Show-Banner -Help:$Help -Probe
    exit 0
}

if ($WatchOnce) {
    # ★ "出事自己跳出来"的只读入口：跑**一次**真判定并打印结论，**不碰任何窗口**、不进交互、exit 0。
    #   想让三态都能看见，用这几个钩子（和 DSH_WINDOW_STATUS_JSON 一个路子，正常流程不设）：
    #     $env:DSH_WINDOW_STATUS_JSON        = <control.ps1 status -Json 形状的假 JSON>
    #     $env:DSH_WINDOW_PREV               = green | red   （上一轮的灯态；默认 green = 验"边沿"）
    #     $env:DSH_WINDOW_MINIMIZED_AGO_MS   = 窗口缩了多久（毫秒；不给 = 没缩着）
    #     $env:DSH_WINDOW_POPPED             = 1             （这一轮红灯已经跳过一次了）
    Write-Host ''
    Write-Host '  ── 窗口看守 · 只读判定（不碰任何窗口）────────────────────────────'
    Write-Host ('   探活触发器：每 {0} 秒一次 TCP（{1}/{2}/{3}）｜ 判定源：tools\control.ps1 status（唯一）' -f [int]($script:WatchIntervalMs / 1000), $DshPort, $BridgePort, $SnowLumaPort)
    Write-Host ('   边沿触发：只在"从绿变红的那一次"跳 ｜ 主人刚缩过：冷却 {0} 秒（推迟，不取消）' -f [int]($script:WatchCooldownMs / 1000))
    $prev = [string]$env:DSH_WINDOW_PREV
    if ($prev -eq 'red') { $script:watch.green = $false }
    $agoMs = -1
    # ⚠ 别写成 `[double][string]$env:X`：环境变量没设时它是空串，而 **[double]'' 在 PS 里是 0、不报错**
    #   ⇒ 会得到"缩了 0 秒"这种假注入（实测踩过）。
    $agoRaw = [string]$env:DSH_WINDOW_MINIMIZED_AGO_MS
    if ($agoRaw -ne '') { try { $agoMs = [double]$agoRaw } catch { $agoMs = -1 } }
    if ($agoMs -ge 0) {
        $script:watch.minimized = $true
        $script:watch.minSince = (Get-Date).AddMilliseconds(-$agoMs)
    }
    if ([string]$env:DSH_WINDOW_POPPED -eq '1') { $script:watch.poppedThisRed = $true }
    $script:watch.redPending = ($prev -eq 'red')
    Write-Host ('   注入：上次灯态={0} ｜ 窗口={1} ｜ 这轮已跳过={2}' -f `
        $(if ($prev -eq 'red') { '有灯不绿' } else { '全绿' }), `
        $(if ($agoMs -ge 0) { ('缩着（{0} 秒前缩的）' -f [int]($agoMs / 1000)) } else { '没缩着/在桌面上' }), `
        $(if ([string]$env:DSH_WINDOW_POPPED -eq '1') { '是' } else { '否' }))
    if (-not $script:WatchEnabled) {
        Write-Host '   [看守] -NoWatch：看守已经关掉了（谁也不会自己跳出来）—— 这次判定什么都不做。'
    } else {
        Invoke-WatchTick -Probe
    }
    Write-Host ''
    exit 0
}

if ($CheckDeathGate) {
    # ★ 判死闸的**注入式验收**（2026-09-25 判据①②）：只跑纯函数 + 打印全表，
    #   **不探真端口、不碰窗口、不拉进程、不发 QQ**（Send-OwnerQqNotice 走 $script:QqNoticeProbe 只印）。
    Write-Host ''
    Write-Host '  ── 判死闸 · 注入式验收（两条硬判据各占一行；只读，跑完 exit 0）────────────'
    $rows = @(
        @{ n = 'A 子进程还在';         child = $false; alive = $true;  busy = $true;  att = 0; off = $false },
        @{ n = 'B 判死 + 有会话在跑';   child = $true;  alive = $false; busy = $true;  att = 0; off = $false },
        @{ n = 'C 判死 + 没会话在跑';   child = $true;  alive = $false; busy = $false; att = 0; off = $false },
        @{ n = 'D 判死 + 开关关着';     child = $true;  alive = $false; busy = $false; att = 0; off = $true },
        @{ n = 'E 判死 + 已到上限';     child = $true;  alive = $false; busy = $false; att = $script:AutoRestartMax; off = $false }
    )
    foreach ($r in $rows) {
        $h = Resolve-StopHandling -ChildExited $r.child -DshAlive $r.alive -Attempts $r.att -Max $script:AutoRestartMax -SessionsBusy $r.busy
        $p = Resolve-DeathAction -Act $h.act -SwitchOff $r.off
        Write-Host ('   {0} ⇒ 判定={1} ｜ 最终动作={2} ｜ 拉={3} ｜ 发QQ={4}' -f `
            $r.n, $h.act, $p.act, $(if ($p.pull) { '是' } else { '否' }), $(if ($p.notify -or $p.pull) { '是' } else { '否' }))
        if ($p.notify) { [void](Send-OwnerQqNotice -Text ('【自动提示】（判死闸探针 {0}）DSH 真没了 ⇒ 请在 DSH-Web 窗口按 r。' -f $p.act) -Tag 'dsh-dead') }
        # ★ C 格（pull）的 QQ 跟那三条"不拉的路"不是一处发的：Resolve-DeathAction 只管后者；
        #   拉起那条由 run 循环在 `Stop-DshChild` **之前**发（tag=dsh-restart）—— 这里照着**真文案**印一条，
        #   让全表不至于漏说"拉起也会通知"（主人今晚最气的就是"它被拉回来了、我一个字没收到"）。
        elseif ($p.pull) { [void](Send-OwnerQqNotice -Text ('【自动提示】DSH 刚才没了，我正在自动把它拉回来（第 {0} 次，同一个窗口里重起）。' -f 1) -Tag 'dsh-restart') }
    }
    Write-Host '   注：C 那格的 QQ **不在** Resolve-DeathAction 里（它只管"三条不拉的路"）—— run 循环在 `Stop-DshChild` 之前发（tag=dsh-restart）；A/B 两格不发。'
    Write-Host ''
    exit 0
}

if ($CheckQqAlert) {
    # ★ 「QQ 没登录要不要提示」的注入式验收（只跑纯函数 + 打印两态；**不碰窗口、不碰服务、不发 QQ**、exit 0）。
    #   判据① QQ ✗ ⇒ 标题带 ⚠；判据② QQ ✓（恢复）⇒ 标题回到**无 ⚠ 的基线** `DSH-Web`。两条都要看得见。
    Write-Host ''
    Write-Host '  ── QQ 未登录提示 · 注入式验收（只读；跑完 exit 0）──────────────────'
    foreach ($on in @($false, $true)) {
        $a = Resolve-QqAlert -QqOnline $on
        Write-Host ('   QQ{0} ⇒ 提示={1} ｜ 标题="{2}" ｜ 带⚠={3}' -f `
            $(if ($on) { '在线' } else { '未登录' }), $(if ($a.alert) { '要' } else { '不要' }), `
            $a.title, $(if ($a.title -like '*⚠*') { '是' } else { '否' }))
        if ($a.alert) { Write-Host ('             （跳出来那一行：{0}）' -f $a.line) }
    }
    # ★ 第三态（2026-09-26 加）：QQ 已迁走 / 只开 DSH ⇒ 说明态，**不弹窗也不改红字**
    $mv = Resolve-QqAlert -QqOnline $false -NotLocal $true
    Write-Host ('   QQ已迁走 ⇒ 提示={0} ｜ 标题="{1}" ｜ 带⚠={2}' -f `
        $(if ($mv.alert) { '要' } else { '不要' }), $mv.title, $(if ($mv.title -like '*⚠*') { '是' } else { '否' }))
    Write-Host ('             （说明那一行：{0}）' -f $mv.line)
    # ★ 判据**实读**（不是复述源码）：开关=环境变量、标记文件在不在、以及 Test-QqNotLocal 的结论。
    #   这样"只开 DSH 入口"（环境变量）与"搬家标记"（文件）两条路都能被注入式验收真跑一遍
    #   （见 tools\test-dsh-stop-autorestart.mjs 的 ⑪b）。
    $swOn = if ($env:DSH_WINDOW_NO_SERVICES -eq '1') { '开' } else { '关' }
    $mkOn = if (Test-Path -LiteralPath $script:QqMovedFile) { '在' } else { '不在' }
    $conc = if (Test-QqNotLocal) { 'QQ 不在本机' } else { 'QQ 在本机' }
    Write-Host ('   「QQ 不在本机」判据实读：NO_SERVICES 开关={0} ｜ 标记文件={1} ｜ 结论={2}' -f $swOn, $mkOn, $conc)
    Write-Host ('             （标记文件路径：{0}）' -f $script:QqMovedFile)
    Write-Host '   注：这一路**不走 QQ 通道**（QQ 没登录时 QQ 私聊发不出去）——只用窗口标题 + 跳出来；'
    Write-Host '       第三态**不弹窗、不改红字**，也**不补缺**（补缺会把 SnowLuma/桥接一起起出来 ⇒ 抢号）。'
    Write-Host ''
    exit 0
}

if ($CheckStopOnce) {
    # ★ "DSH 停了没有"的只读入口：跑**一次**真判定并打印结论，**不碰任何窗口、不拉任何进程**、exit 0。
    #   与 run 循环**共用同一份判定**（Resolve-DshStop + Test-DshAlive）—— 验收看到的就是真跑的那套。
    #   两个注入值（正常流程不设）：
    #     $env:DSH_WINDOW_CHILD_EXITED = 1      子进程已退出（主人遇到的真实情形）
    #     $env:DSH_WINDOW_DSH_ALIVE    = 1 | 0  顶替真实状态（不设 = 真探端口 + control.ps1 status）
    #     $env:DSH_WINDOW_CONSOLE_MINIMIZED = 1 | 0  顶替"窗口缩着没有"（不设 = 真探本窗口）
    $childExited = $script:ChildExitedProbe
    # ★ 判死用的探针与真循环**同一份**（耐心的那版：连续 N 次都问不到才算死，见 Test-DshAliveSettled）——
    #   探针若走另一条路，验收证明的就不是真跑的那套（"探针过了 ≠ 真机过了"那次教训）。
    $alive = Test-DshAliveSettled
    $sessionsBusy = Get-SessionBusyHint
    $d = Resolve-DshStop -ChildExited $childExited -DshAlive $alive
    # ★ 真停之后"先自动拉一次"的判定：走**循环用的同一个** Resolve-StopHandling（含记账要求与互斥关系）
    $arAttempts = Read-AutoRestartAttempts
    $h = Resolve-StopHandling -ChildExited $childExited -DshAlive $alive -Attempts $arAttempts -Max $script:AutoRestartMax -SessionsBusy $sessionsBusy
    # ★ "动不动手 / 要不要发 QQ"：与真循环共用**同一个**纯函数（开关也在里面）
    $plan = Resolve-DeathAction -Act $h.act -SwitchOff (Test-AutoRestartDisabled)
    Write-Host ''
    Write-Host '  ── "DSH 停了没有" · 只读判定（不碰任何窗口、不拉任何进程）──────'
    Write-Host ('   判据：子进程退没退（本次：{0}）＋ DSH 真实状态（{1}）—— **不看子进程句柄就下结论**' -f `
        $(if ($childExited) { '退了' } else { '还在跑' }), `
        $(if ($null -ne $script:DshAliveProbe) { ('注入值 = ' + $(if ($alive) { '活着' } else { '没了' })) } else { ('真探 :{0} + control.ps1 status = ' -f $DshPort) + $(if ($alive) { '活着' } else { '没了' }) }))
    Write-Host ('   判定：{0} —— {1}' -f $d.act, $d.why)
    Write-Host ('   自动拉起：{0} —— {1}（本窗口里已记 {2} 次）' -f $h.act, $h.why, $arAttempts)
    Write-Host ('   有会话在跑：{0}（判据①：有 ⇒ 宁可不拉）｜ 最终动作：{1} —— {2}' -f `
        $(if ($sessionsBusy) { '是' } else { '否' }), $plan.act, $plan.why)
    if ($plan.notify) {
        # ★ 判据②的注入式验收：探针里**只印不真发**（$script:QqNoticeProbe），断言就钉在这一行上。
        [void](Send-OwnerQqNotice -Text ('【自动提示】DSH 真没了（最终动作 {0}）⇒ 请在 DSH-Web 窗口按 r。' -f $plan.act) -Tag 'dsh-dead')
    }
    if ($h.act -eq 'auto-restart') {
        Write-Host '   [自动修] [只读探针] 本来会：**先记账** → 打印"正在把它拉回来（第 N 次）" → **exit 1**（外层 dsh-window.cmd 的 :restart，同一个窗口重起、**不用他敲任何键**）'
        Write-Host '   [自动修] [只读探针] **不弹窗**（主人的设计 2026-09-25：单次自动修复留日志就行；只有"短时间连着拉了好几次"才红字报错 + 弹出来）'
        # ★ 记账这件事**真的做一次**（写的是注入的临时文件，见 DSH_WINDOW_AUTORESTART_FILE）——
        #   光证明"判定会说 restart"不够，还得证明"这条路真写得进、下代真读得到"（主人 2026-09-25 要求）。
        if ($script:AutoRestartRecordProbe) {
            $tmp = Get-AutoRestartFile
            $n1 = Add-AutoRestartAttempt
            $back = Read-AutoRestartAttempts
            Write-Host ('   [自动修] [真做一次] 记账写入 {0} ⇒ 返回 {1}；同一份再读回 = {2} 次（先记账再动手，下代就靠这个数封顶）' -f $tmp, $n1, $back)
            Write-Host ('   [自动修] [真做一次] 文件内容：{0}' -f $(if (Test-Path $tmp) { ([System.IO.File]::ReadAllText($tmp, [System.Text.Encoding]::UTF8)).Trim() } else { '（没写出来 ✗）' }))
        }
    } elseif ($h.act -eq 'alarm') {
        Write-Host '   [自动修] [只读探针] 到上限 ⇒ **不再自动拉**，转下面那段红色告警叫人（不许无限重启）。'
    }
    if ($d.act -eq 'stopped') {
        # 真停：**本来会做的事**（探针只打印，绝不碰真窗口）—— 主人要的"跳出来 + 红色警告"。
        # 到上限时（$h.act='alarm'）那段告警里会多一行"我试了 N 次都没起来"。
        $line = ((Get-DshStopWhy) + '。' + (Get-DshStopAction))
        Invoke-WindowPop -NextLine $line -Probe -Minimized $true
        Write-DshStopAlarm -Status (Get-ControlStatus) -Probe -Reason $(if ($h.act -eq 'alarm') { $h.why } else { '' })
    } elseif ($d.act -eq 'adopt') {
        Write-Host '   [看守] 什么都不做：不说"已停止"、不弹窗、不退出 —— 改成按真实状态继续守输入。'
    } else {
        Write-Host '   [看守] 什么都不做：子进程还在，照常守着输入。'
    }
    Write-Host ''
    exit 0
}

if ($RestartSourceOnce) {
    # ★ "这一代是谁拉起来的"只读入口（不碰窗口、不起进程、exit 0）。走的是**真流程同一个**
    #   Test-AutoRestartGeneration + Read-RestartEvents + Read-AutoRestartAttempts。
    $evs = @(Read-RestartEvents | Sort-Object { $_.at })
    $last = if ($evs.Count) { $evs[-1] } else { $null }
    $src = Test-AutoRestartGeneration -LastEvent $last
    $autoN = Read-AutoRestartAttempts
    Write-Host ''
    Write-Host '  ── "这一代是谁拉起来的" · 只读判定（不碰任何窗口）──────────────'
    Write-Host ('   账本里最近的事件：{0}' -f $(if ($last) { ('{0}（来源={1}）' -f $last.t, $last.by) } else { '（没有）' }))
    Write-Host ('   账本里 10 分钟内的**自动拉起**次数：{0}（手动按 r 一次都不算）' -f $autoN)
    Write-Host ('   判定：{0} —— {1}' -f $(if ($src.yes) { '**是它拉起来的这一代**（会印"我已经把它拉回来了"）' } else { '**不是自动拉起**（不印那句）' }), $src.why)
    if (-not $src.yes -and $last) {
        Write-Host ('   [来源] 本来会印：`   [看守] 这一次是你自己按 r 重起的（没算进自动拉起次数 —— 10 分钟里自动拉起过 {0} 次）。`' -f $autoN)
    }
    if ([string]$env:DSH_WINDOW_RECORD_MANUAL -eq '1') {
        $before = $autoN
        $after = Add-RestartEvent -By 'manual'
        Write-Host ('   [真做一次] 记了一条 manual 事件：账本里 auto 条数 {0} → {1}（**必须不变** —— 这就是修的那个 bug）' -f $before, $after)
        $evs2 = @(Read-RestartEvents | Sort-Object { $_.at })
        Write-Host ('   [真做一次] 记完最近一条 = {0}（来源={1}）' -f $evs2[-1].t, $evs2[-1].by)
    }
    Write-Host ''
    exit 0
}

if ($FlapOnce) {
    # ★ 频率告警的只读入口（不碰窗口、不弹、不起进程、exit 0）。走的是**真流程同一个** Resolve-FlapAlarm
    #   + Test-ShouldPopOnRestart + Read-AutoRestartAttempts（账本可注入到临时文件）。
    $n = Read-AutoRestartAttempts
    $flap = Resolve-FlapAlarm -Attempts $n -Max $script:AutoRestartMax -WindowSec $script:AutoRestartWindowSec
    $minRaw = [string]$env:DSH_WINDOW_CONSOLE_MINIMIZED
    $min = Test-ConsoleMinimized
    $minSrc = '真探本窗口'
    if ($minRaw -eq '1') { $min = $true; $minSrc = '注入值 = 缩着' }
    elseif ($minRaw -eq '0') { $min = $false; $minSrc = '注入值 = 没缩着（就在桌面上）' }
    $popPlan = Test-ShouldPopOnRestart -Minimized $min -LastPopAt (Read-AutoRestartToldAt)
    Write-Host ''
    Write-Host '  ── 频率告警 · 只读判定（不碰任何窗口、不弹、不起进程）──────────────'
    Write-Host ('   判据：{0} 分钟（{1} 秒）窗口内的自动拉起次数（本次读到 {2} 次；上限 {3} 次 —— **与自动拉起上限同一套数**）' -f `
        [int]($script:AutoRestartWindowSec / 60), $script:AutoRestartWindowSec, $n, $script:AutoRestartMax)
    Write-Host ('   决定：{0} —— {1}' -f $(if ($flap.alarm) { '**报错**（QQ 私聊 + 窗口红字）' } else { '不报' }), $flap.why)
    if ($flap.alarm) {
        Write-Host '   [频率告警] [只读探针] 本来会用红色打出这几行：'
        foreach ($ln in $flap.lines) { Write-Host ('      ' + $ln) }
        Write-Host ('   [频率告警] [只读探针] 窗口状态：{0}' -f $minSrc)
        Write-Host ('   [频率告警] [只读探针] 打扰不打扰他：{0} —— {1}' -f $(if ($popPlan.pop) { '打扰一次（发 QQ + 弹窗）' } else { '不打扰' }), $popPlan.why)
        $relay = Invoke-FlapRelay -Text (Get-FlapAlarmText -Attempts $n -WindowSec $script:AutoRestartWindowSec) -Probe
        Write-Host ('   [频率告警] [只读探针] 主通道（QQ）：{0}' -f $relay.why)
        # ★ `DSH_WINDOW_FLAP_SEND=1` ⇒ **真的调一次**（只允许在设了假 relay 钩子时用；见下）。
        #   为什么：光证明"判定会报错"不够 —— 得证明"这条真会去调 relay、内容对、失败会如实记"。
        if ([string]$env:DSH_WINDOW_FLAP_SEND -eq '1') {
            if (-not [string]$env:DSH_WINDOW_RELAY_HOOK) {
                Write-Host '   [频率告警] [真做一次] 拒绝：没设 DSH_WINDOW_RELAY_HOOK ⇒ 探针**绝不真发 QQ**（要验就挂假钩子）'
            } else {
                $real = Invoke-FlapRelay -Text (Get-FlapAlarmText -Attempts $n -WindowSec $script:AutoRestartWindowSec)
                Write-Host ('   [频率告警] [真做一次] 结果：ok={0} —— {1}' -f $real.ok, $real.why)
            }
        }
        Write-Host ('   [频率告警] [只读探针] 要发的那句话（**不提令牌/路径/端口**）：{0}' -f (Get-FlapAlarmText -Attempts $n -WindowSec $script:AutoRestartWindowSec))
        Write-Host ('   [频率告警] [只读探针] 弹的时候会打这一行：{0}' -f $flap.nextLine)
        Write-Host '   [频率告警] [只读探针] 这一代起来后**不会再自动拉**（下次掉线 = 红字叫你按 r）'
        Write-Host '   [频率告警] [只读探针] 发不出去时：窗口里会写"⚠ 主通道没成 + 原因"，**绝不假装发出去了** ✗'
    }
    Write-Host '   [渠道] 主通道 = 桥接转 QQ 私聊（桥接是**独立进程 + 有自己的守护** ⇒ DSH 停着它照样能发；收信人 QQ 号从环境层读，不写死）；次通道 = 这个窗口的红字 + 标题。**不做** toast（免得多一个"看起来会响其实不会"的东西）。'
    Write-Host ''
    exit 0
}

if ($EnsureOnce) {
    # ★ "r 之后缺的服务怎么补"的只读入口：跑**一次**真判定、打印结论，**不碰窗口、不起任何服务**、exit 0。
    #   与 run 循环**共用同一份判定**（Resolve-MissingServices）—— 验收看到的就是真跑的那套。
    #   两个注入值（正常流程不设；"控制面不在"这一态**不许真去杀主人的进程**造）：
    #     $env:DSH_WINDOW_DSH_ALIVE     = 1 | 0   DSH 真实状态（不设 = 真探 :3080 + control.ps1 status）
    #     $env:DSH_WINDOW_CONTROL_ALIVE = 1 | 0   控制面 :3101（不设 = 真探端口）
    $dshAlive = Test-DshAlive
    $ctlAlive = Test-ControlAlive
    # ★ QQ 在不在本机也决定这一支走哪条路（标记文件 / DSH_WINDOW_QQ_MOVED_FILE / DSH_WINDOW_NO_SERVICES）
    $qqNotLocal = Test-QqNotLocal
    $plan = Resolve-MissingServices -DshAlive $dshAlive -ControlAlive $ctlAlive -QqNotLocal $qqNotLocal
    Write-Host ''
    Write-Host '  ── "r 之后缺的服务一起补起" · 只读判定（不碰窗口、不起服务）────'
    Write-Host ('   判据：DSH {0} ｜ 控制面 :{1} {2}（{3}）' -f `
        $(if ($dshAlive) { '在跑' } else { '没在跑' }), $ControlPort, `
        $(if ($ctlAlive) { '在跑' } else { '没在跑' }), `
        $(if (($null -ne $script:DshAliveProbe) -or ($null -ne $script:ControlAliveProbe)) { '含注入值' } else { '真探' }))
    Write-Host ('   判定：{0} —— {1}' -f $plan.act, $plan.why)
    if ($plan.act -eq 'repair' -and $plan.mode -eq 'control-only') {
        # ★ QQ 不在本机（搬家 / 只开 DSH）：只补控制面 —— 起法仍是**那一份**，只是不起 SnowLuma / 桥接。
        Write-Host '   [补缺] [只读探针] 本来会**在本窗口内**直接调那一份唯一起法（不另起 powershell、不经过启动器）：'
        Write-Host '      tools\control-plane.ps1 的 Start-ControlPlane（只起 tools\control-server.mjs，:3101）'  # port-literal-ok: 只读探针的文案里提到端口，不是配置来源
        Write-Host '   [补缺] 为什么不走启动器：QQ 那套不在本机，启动器 -NoRestart 会把 SnowLuma 与桥接一起起出来 ⇒ 抢号。'
        Write-Host '   然后最多等 15 秒复查端口：起来了就报 ✓，没起来**如实说**（页面面板会是"读不到状态"）。'
    } elseif ($plan.act -eq 'repair') {
        # 复用的是**已有的那一条路**：control.ps1 的 restart control 跑的就是这一条。
        Write-Host '   [补缺] [只读探针] 本来会**后台无窗口**跑：'
        # ★ 参数**算出来**，不许写死（2026-09-25 20:0x 行为探针那一批）：原来这里恒印 -NoOpen ⇒ 主人自己按 r
        #   的场景会假阴性（验收的人以为修没生效）。现在与 Invoke-MissingServices 共用同一个判定函数 ⇒
        #   「只读入口看到的」= 「真路径会跑的」。参数**集合**与真路径一致（真路径是 `-NoRestart [-NoOpen]`，
        #   顺序与这里不同；PowerShell 具名参数与顺序无关 ⇒ 只保证集合相同，**不声明顺序**）。
        #   （2026-09-25 小镜复核 nit②：原注释写「顺序一致」而真路径 L1064 的顺序确实不同 ⇒ 订正为集合口径。）
        #   （2026-09-25 晚：`-KeepWindow` **两边一起去掉** —— 主人提「窗口没最小化」，根因就是补缺那条强制留桌面。）
        $svcArgs = @('-NoRestart')
        $openPlan = Resolve-MissingServiceOpenDecision
        if ($openPlan.noOpen) { $svcArgs += '-NoOpen' }
        Write-Host ('      powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File tools\start-all.ps1 ' + ($svcArgs -join ' '))
        Write-Host ('   [补缺] 页面：' + $openPlan.why)
        $ctl = Join-Path $PSScriptRoot 'control.ps1'
        if (Test-Path $ctl) {
            $has = (Select-String -Path $ctl -Pattern "start-all\.ps1' @\('-NoRestart', '-NoOpen'\)" -Quiet)
            if ($has) { Write-Host '   [补缺] 与 tools\control.ps1 里 restart control 用的那一条**同一条** ✓（没有第二份实现）' }
            else { Write-Host '   [补缺] ⚠ 没在 control.ps1 里找到那一条（它可能刚被改过）—— 以本文件为准再核一次。' }
        }
        Write-Host '   然后最多等 25 秒复查端口：起来了就报 ✓，没起来**如实说**（页面面板会是"读不到状态"）。'
    } elseif ($plan.act -eq 'none') {
        Write-Host '   [补缺] 什么都不做 ⇒ **不会起第二个**（启动器那一条自己也会跳过已在监听的端口）。'
    } else {
        Write-Host '   [补缺] 这一步**故意不做**：这时补缺会被当成"DSH 缺了"，反而起出第二个 DSH。'
    }
    Write-Host ''
    exit 0
}

if ($StatusOnce) {
    # ★ "状态变了才重印"的只读入口：跑**一次**真判定并打印结论，**不碰任何窗口**、exit 0。
    #   与看守循环**共用同一份比较**（Get-StatusSnapshot / Compare-StatusSnapshot / Show-StatusIfChanged）
    #   —— 验收看到的就是真跑的那套。注入值（正常流程不设）：
    #     $env:DSH_WINDOW_STATUS_JSON_PREV = <上一份状态的 JSON 文件>（= "她刚才看到的那份"）
    #   不注入 ⇒ 基准就是**当前真实状态** ⇒ 判定必然是"不重印"（稳态不刷屏的证明）。
    #     $env:DSH_WINDOW_STATUS_LAST_PRINT_MS = 上次印距今多少毫秒（验"<60 秒就攒着、不刷屏"）
    #     $env:DSH_WINDOW_STATUS_JSON_NOW       = <"现在这份"状态的 JSON 文件>（不设 = 真状态）
    #       —— 有了它就能把**一次启动的真实序列**逐帧走一遍，数清"他到底会看到几行"。
    Write-Host ''
    Write-Host '  ── 状态行"变了才重印" · 只读判定（不碰任何窗口）──────────────'
    $prevHook = [string]$env:DSH_WINDOW_STATUS_JSON_PREV
    # ⚠ 与 -WatchOnce 同一个坑：别写 [double][string]$env:X —— 空串在 PS 里是 0、不报错（会造假注入）。
    $lpRaw = [string]$env:DSH_WINDOW_STATUS_LAST_PRINT_MS
    if ($lpRaw -ne '') {
        try { $script:banner.lastPrintAt = (Get-Date).AddMilliseconds(-[double]$lpRaw) } catch { $script:banner.lastPrintAt = [datetime]::MinValue }
        Write-Host ('   注入：上次印状态是 {0} 毫秒前（合并窗口 60 秒：小于它就攒着不印）' -f $lpRaw)
    }
    $nowStatus = Get-ControlStatus
    $nowHook = [string]$env:DSH_WINDOW_STATUS_JSON_NOW
    if ($nowHook) {
        try {
            $nowStatus = [System.IO.File]::ReadAllText($nowHook, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            Write-Host ('   注入："现在这份"状态来自 {0}' -f $nowHook)
        } catch {
            Write-Host ('   [状态行] 注入的"现在这份"读不了（{0}）⇒ 用真实状态' -f $_.Exception.Message)
        }
    }
    if (-not $nowStatus) {
        Write-Host '   [状态行] 读不到状态（control.ps1 status 没跑起来）—— 不出声、不重印（读不到就不乱报变化）'
        Write-Host ''
        exit 0
    }
    if ($prevHook) {
        try {
            $prevStatus = [System.IO.File]::ReadAllText($prevHook, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
            $script:banner.last = Get-StatusSnapshot $prevStatus
            Write-Host ('   注入：上一份状态来自 {0}（= "她刚才看到的那份"）' -f $prevHook)
        } catch {
            Write-Host ('   [状态行] 上一份状态读不了（{0}）⇒ 按"还没印过"处理' -f $_.Exception.Message)
        }
    } else {
        $script:banner.last = Get-StatusSnapshot $nowStatus
        Write-Host '   没注入上一份状态 ⇒ 拿**当前真实状态**当"刚印过的那份"（这种情况应当**不重印**）'
    }
    [void](Show-StatusIfChanged -Status $nowStatus -Probe)
    Write-Host ''
    exit 0
}

if ($Mode -eq 'start') {
    Show-StartBanner
    exit 0
}

if ($Mode -eq 'prompt') {
    exit (Ask-WhatToDo)
}

# ── 房子里的杂活（2026-09-24 新增）─────────────────────────────────────────────
# 主人原话："把这个 web 的 cmd 隐藏，用 dsh 的 cmd 代替，然后把功能移到 dsh 的 cmd 上"。
# 于是 SnowLuma 的窗口藏起来了（见 tools\start-all.ps1），它原来在启动器菜单里的功能搬到这里：
#   s = 登录 SnowLuma（注入 WebUI 会话）   w = 把三个页面开进正在用的浏览器
#   l = 看 SnowLuma 日志尾巴              u = 再打一遍三个地址
# （下面这行原来漏了注释符、会当场打出来 —— 2026-09-24 收横幅时顺手补上）
#   b = 桥接没起来（控制台端口不通）时按它：自动同步令牌并拉起来
# 返回 $true = 这条输入被吃掉了（不算"没认出的命令"）。
function Invoke-HouseCommand([string]$ans) {
    $tools = $PSScriptRoot
    switch ($ans) {
        'a' {
            # §12.5 会话卫生：**只有主人按这个键**才会归档 —— 全文件里 `archive` 只在这一条路上被调用
            # （见 Invoke-SessionArchiveAndNew），任何时候都不会自动归档；步数提醒与阈值在 tools\sessions.mjs。
            Invoke-SessionArchiveAndNew
            return $true
        }
        { $_ -eq '?' -or $_ -eq 'help' } {
            # §10.5：主横幅只留 e / r / s / ?，其余（b w l u）收进这一屏 —— 排障入口。
            Show-Banner -Help
            return $true
        }
        's' {
            # 2026-09-24（P0 收口）：登录 = 换令牌 + 把页面开出来，两件事都走**唯一的动作源**
            # tools\control.ps1（它内部：snowluma-login.ps1 -NoOpen 只换令牌，开页面归 panels.ps1）。
            # 以前这里直接调登录脚本，而那个脚本自己也开一个页 ⇒ 和 panels 撞成两个标签。
            Write-Host '  正在登录 SnowLuma（换令牌 + 把管理页开出来）…'
            $ctl = Join-Path $tools 'control.ps1'
            if (Test-Path $ctl) {
                & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $ctl login qq | Out-Host
            } else {
                Write-Host '  [警告] 找不到 tools\control.ps1，退回老两步…'
                $login = Join-Path $tools 'snowluma-login.ps1'
                if (Test-Path $login) { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $login -NoOpen | Out-Host }
                $panels = Join-Path $tools 'panels.ps1'
                if (Test-Path $panels) { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $panels open -Pages snowluma -ForcePage snowluma | Out-Host }
            }
            return $true
        }
        'w' {
            Write-Host '  正在把三个页面开进你正在用的浏览器…'
            $panels = Join-Path $tools 'panels.ps1'
            if (Test-Path $panels) {
                # 显式说这次开哪几页（2026-09-24）——用关键字 `all`，**不抄具体名单**：
                # 页列表只有 panels.ps1 里那一份来源（$PageKeys / $DefaultPages）
                & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $panels open -Pages all | Out-Host
            } else { Write-Host '  [错误] 找不到 tools\panels.ps1' }
            return $true
        }
        'u' {
            Write-Host "    DSH Web          http://127.0.0.1:$DshPort"
            Write-Host "    桥接控制台        http://127.0.0.1:$BridgePort"
            Write-Host "    SnowLuma 管理页   http://127.0.0.1:$SnowLumaWebPort"
            return $true
        }
        'b' {
            Write-Host "  桥接体检：同步 DSH 令牌 + $BridgePort 不通就拉起来…"
            $eb = Join-Path $tools 'ensure-bridge.ps1'
            if (Test-Path $eb) { & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $eb | Out-Host }
            else { Write-Host '  [错误] 找不到 tools\ensure-bridge.ps1' }
            return $true
        }
        'l' {
            # 2026-09-24 主人反馈："这个 snowluma 日志功能是不是很没用" —— 原来它挑最新那个 .log 打 15 行，
            # 而 SnowLuma 平时**根本不写**那个文件（0 字节），于是只打出一个空标题。现在先报
            # 文件名/大小/时间/行数，空的就自动往后找下一个（最多 3 个），全空就把原因说清楚。
            $logDir = Join-Path (Split-Path $tools -Parent) 'SnowLuma\logs'
            if (-not (Test-Path $logDir)) { Write-Host "  [错误] 找不到 $logDir"; return $true }
            $all = @(Get-ChildItem $logDir -Filter *.log -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
            if ($all.Count -eq 0) { Write-Host '  （SnowLuma\logs 里还没有 .log 文件）'; return $true }
            $shown = $false
            foreach ($f in ($all | Select-Object -First 3)) {
                $rows = @(Get-Content -LiteralPath $f.FullName -Encoding UTF8 -ErrorAction SilentlyContinue)
                Write-Host ('  ' + $f.Name + '   ' + $f.Length + 'B   ' + $f.LastWriteTime.ToString('MM-dd HH:mm') + '   ' + $rows.Count + ' 行')
                if ($rows.Count -gt 0) {
                    $rows | Select-Object -Last 15 | ForEach-Object { '    ' + $_ }
                    $shown = $true
                    break
                }
            }
            if (-not $shown) {
                Write-Host '  ↑ 这几个日志都是空的 —— SnowLuma 平时不写文件，出问题才写。'
                Write-Host "    想看它现在的状态：浏览器开 http://127.0.0.1:$SnowLumaWebPort（管理页）。"
            }
            return $true
        }
    }
    return $false
}

# ── -Mode run：后台跑 DSH + 前台守输入 ────────────────────────────────────────
$ErrorActionPreference = 'Stop'
$script:child = $null

function Stop-DshChild {
    $c = $script:child
    if (-not $c) { return }
    $alive = $false
    try { $alive = -not $c.HasExited } catch { $alive = $false }
    if (-not $alive) { return }
    # 用 cmd 自己重定向：PS 5.1 里 `native 2>&1` 会把 stderr 变成 ErrorRecord，撞上
    # $ErrorActionPreference='Stop' 就是终止性异常 —— 实测'关全部'时脚本反而崩成 exit 1，
    # 外层把 1 当'重起'，于是无限重起循环（P4 探针就是这么挂住的）。
    try { Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('taskkill /PID ' + $c.Id + ' /T /F >nul 2>&1') -NoNewWindow -Wait } catch { }
    Start-Sleep -Milliseconds 400
    try { if (-not $c.HasExited) { Stop-Process -Id $c.Id -Force -ErrorAction SilentlyContinue } } catch {}
}

function Read-Key {
    # 返回 @{ Char = <char>; Kind = 'char' | 'enter' | 'back' | '' }
    $k = [Console]::ReadKey($true)
    if ($k.Key -eq [ConsoleKey]::Enter) { return @{ Char = ''; Kind = 'enter' } }
    if ($k.Key -eq [ConsoleKey]::Backspace) { return @{ Char = ''; Kind = 'back' } }
    $c = $k.KeyChar
    if ([int]$c -lt 32) { return @{ Char = ''; Kind = '' } }
    return @{ Char = [string]$c; Kind = 'char' }
}

try {
    if (-not $Tools -or -not (Test-Path (Join-Path $Tools 'log-run.ps1'))) { throw "找不到 log-run.ps1（-Tools='$Tools'）" }
    if (-not $Node -or -not $Bin) { throw '-Mode run 需要 -Node 与 -Bin' }

    # Ctrl+C：DSH（还有 log-run / 外层 cmd）照旧收信号去死 —— 但别让本脚本跟着死，
    # 死了窗口就没人收输入了。装不上也不要紧：外层看到"控制台中断"的退出码会退回"问一句"。
    try {
        $handler = [ConsoleCancelEventHandler] {
            param($sender, $e)
            $e.Cancel = $true
        }
        [Console]::add_CancelKeyPress($handler)
    } catch { }

    Show-StartBanner

    # ★ 这一代窗口起来了 ⇒ 把上一代可能写进标题的那句"DSH 已停"抹掉，同时**保住 `DSH-Web` 前缀**
    #   （stop-all.ps1 与看守都按 `DSH-Web*` 这个模式找窗口；标题把前缀改掉就找不到了）。
    try { [Console]::Title = 'DSH-Web' } catch { }

    # ★ 如果这一代是"上一代自动拉回来"的：**如实说一句**（一次，不刷屏）—— 主人要知道"它刚才掉过"。
    #   并且：**短时间连着拉了好几次 ⇒ 主动报错**（主人的设计 2026-09-25 原话：
    #   「如果是自动重启修复的话只要有日志就行了；弹不弹出主要看频率 —— 如果一段时间内连续重启了
    #     很多次，说明系统可能出问题了，就可以给我发消息报错」）⇒ 频率告警就落在**这一代刚起来**时：
    #   此刻 DSH 是活的（所以弹出来不会像"出事了"那么吓人），而"连着好几次"这个事实只有这里知道得最全。
    #   ⚠ 阈值**与自动拉起的上限是同一套数**（$script:AutoRestartMax / AutoRestartWindowSec），不另立一套。
    try {
        $arN = Read-AutoRestartAttempts
        # ★★ 2026-09-25 修的 bug：**先分清这一代是谁拉起来的** —— 主人手动按 r 之后，原来这一代照样
        #   会说"我已经把它拉回来了" ✗（假信息：他清楚是自己在重起）而且次数也跟着冒出来 ✗。
        #   现在只有"最近一次重起 = auto 且就在刚刚"才印那句；手动按 r 时改印一句中性的说明
        #   （顺带告诉他**没算进自动拉起次数**，免得他以为自己在制造报警）。
        $lastEv = @(Read-RestartEvents | Sort-Object { $_.at } | Select-Object -Last 1)
        $src = Test-AutoRestartGeneration -LastEvent $(if ($lastEv.Count) { $lastEv[0] } else { $null })
        if ($src.yes -and $arN -ge 1) {
            Write-Host ('   [自动修] DSH 刚才掉过 —— 我已经把它拉回来了（{0} 分钟内的第 {1} 次；再超过 {2} 次我就停手、改成红字叫你按 r）。' -f `
                [int]($script:AutoRestartWindowSec / 60), $arN, $script:AutoRestartMax) -ForegroundColor Yellow
            $flap = Resolve-FlapAlarm -Attempts $arN -Max $script:AutoRestartMax -WindowSec $script:AutoRestartWindowSec
            if ($flap.alarm) {
                foreach ($ln in $flap.lines) { Write-Host ('   ' + $ln) -ForegroundColor $script:StopColor }
                # ★ 打扰他**一次**（弹窗 或 发 QQ 都算这一次；5 分钟冷却靠账本里的时刻跨代际生效）——
                #   同一轮绝不重复发（那会变成骚扰）。
                $popPlan = Test-ShouldPopOnRestart -Minimized (Test-ConsoleMinimized) -LastPopAt (Read-AutoRestartToldAt)
                if ($popPlan.pop) {
                    [void](Add-AutoRestartTold)
                    # 主通道：QQ 私聊（桥接是独立进程 + 有自己的守护 ⇒ DSH 停着也能发出去）
                    $relay = Invoke-FlapRelay -Text (Get-FlapAlarmText -Attempts $arN -WindowSec $script:AutoRestartWindowSec)
                    if ($relay.ok) {
                        Write-Host ('   [频率告警] 主通道：{0}' -f $relay.why) -ForegroundColor $script:StopColor
                    } else {
                        Write-Host ('   [频率告警] ⚠ 主通道没成：{0}' -f $relay.why) -ForegroundColor $script:StopColor
                        Write-Host '   [频率告警] （这条**没有**发出去，别以为他知道 —— 下面这次弹窗就是退路。）' -ForegroundColor $script:StopColor
                    }
                    try { [Console]::Title = ('DSH-Web ' + $script:StopTitle) } catch { }
                    Invoke-WindowPop -NextLine $flap.nextLine
                } else {
                    Write-Host ('   [自动修] ' + $popPlan.why) -ForegroundColor DarkGray
                    Write-Host '   [自动修] （QQ 那条也一起跳过：同一轮只打扰你一次。）' -ForegroundColor DarkGray
                }
            }
        } elseif ($lastEv.Count -and -not $src.yes) {
            # 手动按 r（或别的路径）拉起来的这一代：**不印**"我已经把它拉回来了"（假信息 ✗），
            # 改印一句中性说明 + 明确"没算进自动拉起次数"（他手动重起 3 次也不会被误报警 ✓）。
            Write-Host ('   [看守] 这一次是你自己按 r 重起的（没算进自动拉起次数 —— 10 分钟里自动拉起过 {0} 次）。' -f $arN) -ForegroundColor DarkGray
            Write-Host ('   [看守] （{0}）' -f $src.why) -ForegroundColor DarkGray
        }
    } catch { }

    $logRun = Join-Path $Tools 'log-run.ps1'
    $inner = '"' + $Node + '" "' + $Bin + '" web --no-open 2>&1 | powershell.exe -NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $logRun + '" "' + $Log + '"'
    # ★ cmd /c 的老坑（2026-09-23 实测）：命令行**以引号开头、又以引号结尾**时，cmd 会把最外
    #   那对引号吃掉 —— `"C:\Program Files\nodejs\node.exe" …` 就只剩 `C:\Program`，报
    #   "'C:\Program' is not recognized as an internal or external command"。
    #   所以这里再**套一对引号**：cmd 吃掉外层，里面原样交给它自己的解析器。
    $startedAt = Get-Date
    $script:child = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', ('"' + $inner + '"') -NoNewWindow -PassThru
    # 2026-09-24（主人："r 和 b 可以同步在一起吗 —— 我按完 r 之后窗口最小化了，没有提示要我去按 b"）
    # ⇒ r 之后自动把桥接带回正轨，不用他记着按 b。后台跑（不等它）+ 无窗口（Hidden + 重定向），
    #   它内部会等 DSH 写出新令牌（最多 25 秒），所以这里可以立刻发起。
    try {
        $ensure = Join-Path $Tools 'ensure-bridge.ps1'
        # ★ 根目录一律用 $PSScriptRoot 推（别用 $Tools —— 它带 `\.` 尾巴，见 Write-RepairNote 那条）。
        #   这里是**主脚本体**：不许用 return 跳过（那会把整条 run 路径带走）⇒ 用 elseif 只跳过这一支。
        $root = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { '' }
        if (-not $root -or -not (Test-Path (Join-Path $root 'qq-bridge'))) {
            Write-Host ('   ⚠ 推不出仓库根（$PSScriptRoot={0}）⇒ 本次不叫桥接、不写盘' -f $PSScriptRoot)
        } elseif (Test-Path $ensure) {
            $tmp = Join-Path $root 'qq-bridge\state\_tmp'
            if (-not (Test-Path $tmp)) { New-Item -ItemType Directory -Path $tmp -Force | Out-Null }
            # ★ 已知启动窗口（2026-09-24 晚）：这一代窗口正要**重起 DSH + 把桥接带回来**（下面那条
            #   ensure-bridge 会同步新令牌并重起桥接）⇒ 先盖一个章。否则接下来那几秒"桥接没在监听"会被
            #   本窗口自己的横幅/看守（以及页面面板）报成"⚠ 桥接断了 → 按 r"，正好跟**下一行**那句
            #   "3100 掉了会自动拉起来 —— 不用再按 b"打架 —— 主人 2026-09-24 22:19 实拍的那一屏
            #   就是这个组合。形状 / 判定 / 那个 45 秒都在 tools\starting-window.mjs 一处（这里只调 CLI）。
            #   ⚠ 盖不上绝不许影响重起。
            try {
                $stampScript = Join-Path $Tools 'starting-window.mjs'
                if (Test-Path $stampScript) {
                    $stampNode = if ($Node) { $Node } else { 'node' }
                    & $stampNode $stampScript mark restart '--by=dsh-prompt.ps1' | Out-Null
                }
            } catch { }
            Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden `
                -RedirectStandardOutput (Join-Path $tmp 'ensure-bridge.out.log') `
                -RedirectStandardError  (Join-Path $tmp 'ensure-bridge.err.log') `
                -ArgumentList '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ensure, '-Quiet' | Out-Null
            Write-Host "   （后台已开始同步桥接令牌；$BridgePort 掉了会自动拉起来 —— 不用再按 b）"
        }
    } catch { }

    # ★ 真横幅：等 DSH 与桥接亮起来再打（此刻 DSH 是我们刚起的那个，还没监听 ⇒ 直接打会把
    #   "⚠ DSH 没在跑" 印出来，既吓人又没用）。Wait-LinkUp 还是问 control.ps1 status，最多 20 秒。
    Show-Banner -Status (Wait-LinkUp)

    # ★ r 的承诺之一：**缺的服务一起补起**（控制面是裸 cmd 起的、没有守护，见 Invoke-MissingServices）。
    #   放在这里而不是更早：必须等 DSH 真的在监听（否则"只补缺的服务"会把它当成 DSH 缺了、起出第二个）。
    try { [void](Invoke-MissingServices) } catch { Write-RepairNote ('出错了（{0}）—— 页面面板可能显示"读不到状态"。' -f $_.Exception.Message) -Always }

    $interactive = $false
    try { $interactive = -not [Console]::IsInputRedirected } catch { $interactive = $false }
    if (-not $interactive -and -not $AutoType) {
        Write-Host '   （这个控制台不能交互收键盘 —— 只等 DSH 退出，然后问一句。）'
    }
    Write-Host -NoNewline 'DSH> '

    $buffer = ''
    $pending = $AutoType
    # ★ 子进程句柄作废之后（ADR：DSH 换了进程还在跑）⇒ 改成**按真实状态**守着：
    #   $adopted 一置上，就不再依赖 $script:child，每 5 秒探一次 3080（见下面那段）。
    $adopted = $false
    $lastAliveAt = [datetime]::MinValue
    while ($true) {
        # ★ 判"还要不要守着"：**不只看自己 spawn 的子进程**（见 Resolve-DshStop）。
        #   主人 2026-09-24 两次"DSH 已停止"里有一次就是这里误报的（灯还亮着 DSH ✓ 呢）。
        $childExited = $adopted
        if (-not $childExited) {
            try { if ($script:child) { $childExited = [bool]$script:child.HasExited } } catch { $childExited = $true }
        }
        if ($childExited) {
            $nowTick = Get-Date
            # 换了进程之后每 tick 都探端口没必要（还平白多出一堆回环连接）⇒ 5 秒一次。
            if ((-not $adopted) -or (($nowTick - $lastAliveAt).TotalSeconds -ge 5)) {
                $lastAliveAt = $nowTick
                # ★ 整条处置只用**一个**判定函数（循环与 -CheckStopOnce 共用；接线断言也钉它）：
                #   keep-running / adopt / auto-restart / alarm —— 见 Resolve-StopHandling。
                # ★ 判死这一路（2026-09-25 判据①）：探针换成"**连续 N 次都问不到才算死**"的耐心版，
                #   并把"有没有会话在跑"喂给判定（有 ⇒ hold = **宁可不拉**，绝不杀正在跑的回合）。
                $sessionsBusy = Get-SessionBusyHint
                $h = Resolve-StopHandling -ChildExited $true -DshAlive (Test-DshAliveSettled) `
                    -Attempts (Read-AutoRestartAttempts) -Max $script:AutoRestartMax -SessionsBusy $sessionsBusy
                # ★ "到底动不动手 / 要不要发 QQ"由**纯函数**合成一次（开关与记账两个否决都在它里面）——
                #   与 -CheckDeathGate / -CheckStopOnce 共用同一份，验收看到的就是真跑的那套。
                $plan = Resolve-DeathAction -Act $h.act -SwitchOff (Test-AutoRestartDisabled)
                if ($h.act -eq 'auto-restart') {
                    # ★★ 真停 ⇒ **先自动拉一次**（主人 2026-09-24："DSH 死了没有任何东西自动把它拉回来"）。
                    #   走**外层那条现成的重起路**（exit 1 ⇒ dsh-window.cmd 的 :restart，同一个窗口，
                    #   **不需要他敲任何键**）—— 他按 r 时走的就是这一条，不另写第二份实现。
                    # ★★ 2026-09-25 19:4x 止血：**先记证据**（只读现场），再问**文件开关** ——
                    #   开关存在就**不拉**、转红字叫人（宁可让他按一次 r，也别把正在干活的回合反复杀掉）。
                    Write-AutoRestartEvidence (Get-AutoRestartEvidence $h)
                    if ($plan.act -eq 'escalate-switch-off') {
                        $script:StopEscalated = ('自动重起已被文件开关关掉（存在 {0}）⇒ **判死也不拉**。要恢复自动修就删掉那个文件；这次请你按 r。证据已落 state\dsh-autorestart-evidence.log' -f (Get-AutoRestartOffFile))
                        Write-Host ''
                        Write-Host ('   [自动修] ' + $script:StopEscalated) -ForegroundColor Red
                        # ★ 判据②（2026-09-25 主人令）：自动修关着 ⇒ **必须出一条 QQ** —— 否则就是"静默停摆"：
                        #   DSH 死了他在页面上没法下指令，又没人告诉他（他最后一个知道）。一次判死只发一条。
                        if ($plan.notify) { [void](Send-OwnerQqNotice -Text '【自动提示】DSH 真没了，而且自动修是关着的（这一代不会替你拉）⇒ 请在 DSH-Web 窗口按 r。' -Tag 'dsh-dead') }
                        break
                    }
                    $rec = Add-AutoRestartAttempt      # ★ **先记账再动手**（跨代际的计数，见函数注释）
                    if ($rec -lt 1) {
                        # 记不上账 ⇒ **不敢**自动重试（那会变成无限重启）⇒ 转红色告警并如实说清原因。
                        $script:StopEscalated = '自动拉起没能记账（state\_tmp 写不进去）⇒ 我不敢自动重试（怕变成无限重启），需要你按 r'
                        Write-Host ''
                        Write-Host ('   [自动修] ' + $script:StopEscalated) -ForegroundColor Red
                        # ★ 判据②：这也是"不拉"的一种（原来同样是静默的）⇒ 一样要出一条 QQ。
                        [void](Send-OwnerQqNotice -Text '【自动提示】DSH 真没了，我想自动拉它、可是账记不上（我不敢无限重试）⇒ 请在 DSH-Web 窗口按 r。' -Tag 'dsh-dead')
                        break
                    }
                    Write-Host ''
                    Write-Host ('   [自动修] ' + $h.why) -ForegroundColor Yellow
                    Write-Host ('   [自动修] 正在把它拉回来（同一个窗口里重起，走的是按 r 那条现成的路；第 {0} 次）…' -f $rec) -ForegroundColor Yellow
                    Write-Host '   [自动修] （这一次**不弹窗**、也不抢前台 —— 主人的设计：单次自动修复留日志就行，' -ForegroundColor DarkGray
                    Write-Host '             只有"短时间连着拉了好几次"才值得弹窗打扰你；**QQ 那边每次自动拉起都会给你一条**。）' -ForegroundColor DarkGray
                    # ★ 判据②之补（协调线 2026-09-25 20:4x 追加，插在最前）：**每一次自动拉起都给他一条 QQ**，
                    #   不只"短时间连拉好几次"才发。今晚两次全量启动把 DSH 杀了、自动修确实把它拉回来了，
                    #   而他**一个字都没收到**、是自己进 DSH 才发现的 —— 那就是缺这条的代价。
                    #   必须发在 Stop-DshChild / exit 1 **之前**（这一代 exit 之后就没机会再发了）；
                    #   内容人话、无路径/配置/令牌，失败不重试（Send-OwnerQqNotice 自吞异常）。
                    [void](Send-OwnerQqNotice -Text ('【自动提示】DSH 刚才没了，我正在自动把它拉回来（第 {0} 次，同一个窗口里重起）。' -f $rec) -Tag 'dsh-restart')
                    Stop-DshChild
                    exit 1
                }
                if ($h.act -eq 'alarm') {
                    # 到上限了 ⇒ 停手、升级成红色告警叫人（绝不在这一代里继续无限重试）
                    $script:StopEscalated = $h.why
                    # ★ 判据②：连着拉不起来 = 他必须知道（这条原来也是静默的）。
                    if ($plan.notify) { [void](Send-OwnerQqNotice -Text ('【自动提示】DSH 真没了，我连着拉了 {0} 次都没起来 ⇒ 我停手了，请按 r。' -f (Read-AutoRestartAttempts)) -Tag 'dsh-dead') }
                    break
                }
                if ($h.act -eq 'hold') {
                    # ★ 判据①（2026-09-25）：有会话在跑 ⇒ **宁可不拉**。灰字留一行痕：不弹窗、不告警、不记账、
                    #   不打扰任何人 —— 下一拍（≈5 秒后）会重新判定。
                    Write-Host ('   [看守] ' + $h.why) -ForegroundColor DarkGray
                }
                if (-not $adopted) {
                    Write-Host ''
                    Write-Host ('   [看守] ' + $h.why)
                    Write-Host -NoNewline 'DSH> '
                    $adopted = $true
                    $script:child = $null      # 句柄作废：别再每 tick 判一次它
                }
            }
        }

        $key = $null
        if ($pending.Length -gt 0) {
            $c0 = [string]$pending[0]
            $pending = $pending.Substring(1)
            if ($c0 -eq "`r" -or $c0 -eq "`n") { $key = @{ Char = ''; Kind = 'enter' } }
            else { $key = @{ Char = $c0; Kind = 'char' } }
        } elseif ($interactive) {
            try { if ([Console]::KeyAvailable) { $key = Read-Key } } catch { $interactive = $false }
        }

        if ($key) {
            if ($key.Kind -ne '') { $script:watch.lastKeyAt = Get-Date }   # 看守避开"他正在敲字"的时刻
            switch ($key.Kind) {
                'enter' {
                    $ans = $buffer.Trim().ToLowerInvariant()
                    $buffer = ''
                    Write-Host ''
                    if ($CloseWords -contains $ans) {
                        Write-Host '  好，正在关闭全部（DSH + SnowLuma + qq-bridge）…'
                        Stop-DshChild
                        exit 0
                    }
                    if ($RestartWordsRunning -contains $ans) {
                        Write-Host '  好，重起 DSH（先把现在这个收掉）…'
                        # ★ 记来源 = manual（2026-09-25 修的 bug：手动按 r 原来会被新一代当成"我拉回来的"✗）。
                        #   只记"最近一次是谁发起的"，**不计入自动拉起次数**（Read-AutoRestartAttempts 只数 auto）。
                        [void](Add-RestartEvent -By 'manual')
                        Stop-DshChild
                        exit 1
                    }
                    elseif (Invoke-HouseCommand $ans) {
                        Write-Host -NoNewline 'DSH> '
                    } else {
                        # §10.5：没认出的输入，只回主键位这一行（其余都在 `?` 里）。
                        Write-Host '  （DSH 正在运行 —— 这个窗口随时能按键：）'
                        Write-Host '     e=关闭全部   r=重起 DSH（自动修）   s=登录 QQ   ?=看全部键位与高级信息'
                        Write-Host -NoNewline 'DSH> '
                    }
                }
                'back' {
                    if ($buffer.Length -gt 0) {
                        $buffer = $buffer.Substring(0, $buffer.Length - 1)
                        Write-Host -NoNewline "`b `b"
                    }
                }
                'char' {
                    $buffer += $key.Char
                    Write-Host -NoNewline $key.Char
                }
                default { }
            }
        }
        # ── 窗口看守（§10.1-5）：缩进任务栏之后，五灯不绿要自己跳回来 ──────────────
        # 平时这一次调用只是一次 [datetime] 比较（到点才真的探活），不影响键盘读取与回显；
        # 用户在敲字（半条命令挂在缓冲区里）时连"问 control.ps1"那一步都会让路（见 Invoke-WatchTick）。
        try { Invoke-WatchTick -Status $null -Typing:($buffer.Length -gt 0) } catch { }
        Start-Sleep -Milliseconds 120
    }

    # DSH 自己停了 —— ★ 走到这里只有一种情形：**子进程没了 + DSH 真的没了**（见 Resolve-DshStop）；
    #   "换了进程还在跑"那种在上面就已经转成"继续守"了，不会掉到这儿。
    $ran = (New-TimeSpan -Start $startedAt -End (Get-Date)).TotalSeconds
    Write-Host ''
    if ($ran -lt 8) {
        Write-Host ('  [提示] DSH 只活了 {0:N1} 秒就退出了 —— 多半没起来，看日志：{1}' -f $ran, $logText)
    }
    # ★★ DSH 真停 = **他唯一的通道**（主人 2026-09-24："如果 dsh 停了就发送不了指令给你了"）：
    #   网页那条路已经断了 ⇒ 这一刻唯一能跟他说话的就是这个窗口，所以它必须**红着跳出来**：
    #     ① 先还原 + 置前（复用 Invoke-WindowPop，不另写窗口代码；抢不到前台它会如实说）；
    #     ② 再打那段**红色**告警（含他要的那句话 + 下一步一个动作 + 灯行）；
    #     ③ 把告警写进窗口标题（缩着/被盖住时任务栏那一行仍然写着它 = 持续可见而不刷屏）。
    #   ⚠ 这一路**不受看守那 5 分钟防骚扰冷却的约束** —— 那是给"五灯不绿"用的；"他没法下指令了"不算骚扰。
    try { Invoke-WindowPop -NextLine ((Get-DshStopWhy) + '。' + (Get-DshStopAction)) -Minimized (Test-ConsoleMinimized) } catch { }
    try { Write-DshStopAlarm -Status (Get-ControlStatus) -Reason $script:StopEscalated } catch { Write-DshStopAlarm -Reason $script:StopEscalated }
    exit (Ask-WhatToDo)
} catch {
    Write-Host ''
    Write-Host ('  [错误] 看守脚本内部异常：{0}' -f $_.Exception.Message)
    Stop-DshChild
    exit 9
}
