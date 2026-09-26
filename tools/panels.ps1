<#
panels.ps1 — 面板页（DSH / 桥接控制台 / SnowLuma 管理页）的开与关。

主人七次调整后的现状（2026-09-23 第六版）：
  ① **三个页面都开**（第四版起；原话："所以的网站都打开吧 不用只开dsh了"）；
  ② ★ **开进"他正在用的那个浏览器窗口"当新标签页**（第六版，原话："重启了这个网站不会出现在
     我正在用的浏览器 而是会重开一个 我想要她出现在我正在开着的浏览器上"）—— 第五版曾默认
     "另开我们自己的一个窗口"（好处是"关闭全部"能把它一起收掉），现在那是**可选的 -OwnWindow**；
  ③ **已经挂着就不重复开**（原话："如果挂着就不用重新打开网站的 也就是不要让两个相同的
     网站运行"）—— 打开前先扫一遍可见的浏览器窗口，标题命中我们三个页面名就跳过，
     并把当前地址打出来；要强开用 `-Force`。②+③ 合起来才不会越堆越多；
  ④ 只要 DSH 一页：`-DshOnly`；启动器侧一个都不开：`-NoOpen`。

做法（默认路径，第六版 = 第三/四版老行为）：
  · 不加 `--new-window`：Chromium 把 URL 塞进**最近活动的那个窗口**（= 他正在用的那个），
    于是页面以新标签页的形式出现在他眼前，cookie/登录态也共用，不新开窗口；
  · **代价（老实说）**：这些标签页**我们关不掉**（浏览器不允许脚本关别人的标签页）；
    靠 ③ 那条"挂着就不重复开"保证它们不会越堆越多，DSH 停掉后标签失效、Ctrl+W 关掉即可。

 -OwnWindow（第五版行为，可选）：
  · `--new-window` + 一次传多个 URL → Chromium 把它们开成**同一个窗口里的多个标签页**；
  · 开完**记下这个窗口的句柄（HWND）**（`Find-NewPanelWindow`：启动前后对比窗口列表），
    "关闭全部"时只对它发 WM_CLOSE（只关这一个窗口，主人别的浏览器窗口一个都不碰）；
  · 复用优先：上一轮那个窗口还活着、还是我们的页面 → 直接叫到前台，不新开也不关。

★ 2026-09-24（P0 收口，见 docs\qq-agent-产品设计.md §3.3）：**本脚本是唯一的"开页面者"**。
  `tools\snowluma-login.ps1` 只拿令牌（-NoOpen），不再自己 `Start-Process` 开页 —— 以前它和本脚本
  各开一次，这就是"SnowLuma 双开 / 组合里那个没登录"的直接原因。谁要开页，都调这里。

用法：
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 open                 # 默认：三个页面开进他正在用的窗口当新标签页（已经挂着就不重复开）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 open -Pages none      # **一个页面都不开**（挂机模式；= 启动器的 -NoOpen 语义）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 open -Pages all       # 显式说"三页都要"（关键字，不抄名单）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 open -Pages dsh,console   # **按页控制**：只要这两页
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 open -Pages snowluma -ForcePage snowluma   # 这页必须重开（SnowLuma 重启后令牌失效，只有重载 autologin 页才认）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 open -OwnWindow      # 可选：另开"我们自己的窗口"（关闭全部时能一起收掉）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 open -DshOnly        # 只要 DSH 那一页（= -Pages dsh 的旧写法）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 open -Force          # 已经有挂着的也再开一份
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 open -DryRun         # 只打印会做什么，不动手
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 close                # 关掉 -OwnWindow 开出来的那个窗口（"关闭全部"也会调它）
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 status               # 那个窗口还在吗
  powershell -NoProfile -ExecutionPolicy Bypass -File tools\panels.ps1 wake                 # 把已有窗口叫到前台（**不开任何页**；做不到"选中某个标签"，见下）
参数：
  -Browser <msedge.exe 路径>   指定浏览器（默认 Edge，其次 Chrome）
  -Pages <all|none|dsh,console,snowluma>  **这次要开哪几页**（只对列出的页面做"已开着就不重复开"）：
                               · `all`  = 三个都要（= 缺省值 $DefaultPages，见脚本前部那句注释）
                               · `none` = **一个页面都不开**（"挂机模式"：不用 web / 只用 DSH 页的人
                                          明确说"别的都别开"；与启动器的 `-NoOpen` 同一语义）
                               · 逗号子集，如 `dsh` / `dsh,console`（旧开关 -DshOnly 等价 -Pages dsh）
                               ★ 页列表只有 $PageKeys / $DefaultPages 这一份来源，别在调用方抄名单
  -ForcePage <name[,name]>     这几页**必须重开**（跳过"已开着"判断；调用方明确说"这页的登录态已经过期了"；
                               与 -Pages none 一起用是矛盾的 → 当场报错）
  -DshOnly                     只要 DSH 页（= -Pages dsh；否则三个页面都开）
  -All / -Tabs                 旧开关，现在这就是默认行为（保留只为兼容旧命令行）
  -OwnWindow / -NewWindow      另开"我们自己的窗口"（记句柄，"关闭全部"时收得掉）
  -Force                       已经有页面挂着也再开一份
  -NoClose                     -OwnWindow 时：open 不先复用/作废旧记录
  -DryRun                      不真的开窗（只做解析与打印）
  -Quiet                       少说话

wake 的能力边界（老实说）：浏览器不给外部脚本"选中某个标签页"的 API，所以 wake 只能（a）把
-OwnWindow 记下的那个窗口 SetForegroundWindow 叫到前台；（b）否则把他的浏览器窗口整个叫到前台。
它**永远不会开页、不会关窗**——"那个标签是不是还活着/是不是登录态"我们管不了，那是 §3.3 里
CDP 档（L2）才能做到的事。

实现要点（踩过的坑，别改回去）：
  1. **不能靠 Start-Process -PassThru 的 PID**：浏览器第二次启动会把请求"交接"给已经在跑的进程、
     启动器秒退，记下的 PID 是死的（2026-09-23 实测：close 报"关了 0 个"，窗口全留着）。
     → 改成"启动前后对比顶层窗口列表，找出新出现的那一个"（默认路径就靠它认窗口）。
  2. **不能杀进程**：跟他共用浏览器进程，杀了会把他自己的窗口一起关掉。→ 只对记下的 HWND 发 WM_CLOSE。
  3. **不要用 `--app` 开独立小窗**（第一版就是这么干的，主人当场否了）。
  4. 关窗之前**核对句柄仍然有效 + 标题仍是我们的页面之一**，防止句柄被复用后误关别人的窗口。
  5. **"页面还开着"这件事，清完场就测不出来了**：认页面靠的是"桥接控制台的心跳文件 / 浏览器到
     DSH 页与管理页的活连接"，而一键启动的第 0 段正是把 DSH 与桥接杀掉 —— 等他回头问"这页开着吗"，
     能作证的进程已经没了，于是把他明明还挂着的标签页又开了一遍（主人 2026-09-23 第二次反馈
     "重启之后还是会打开新的网站，不会用之前的"）。→ 加 `snapshot` 动作：**清场之前**先把
     "现在哪几页开着"写进 state\panel-snapshot.json，open 时取"快照 ∪ 实时检测"的并集。
     快照只对**重启后还能用**的页面生效（控制台令牌在 state\console-token 里、SnowLuma 压根不重启）
     —— **DSH 页不认快照**：它每次重启换一个启动令牌，旧标签连刷新都救不回来，照常开一张新的才对。
     快照用完即删，最多认 30 分钟（超时当没拍过），想无视它硬开一份仍然用 -Force。

注意：本文件必须保持 **UTF-8 带 BOM**（PS 5.1 读无 BOM 的 UTF-8 会按 ANSI 解码，中文注释会乱、
极端情况下连引号都被吃掉）。tools\self-check.mjs 会查这一条。
#>
param(
  # snapshot = **只记录、不开页**：给"清场之前"用（见文件头第 5 条坑），一键启动会自己调。
  # wake     = **不开任何页**，只把已有窗口叫到前台（见文件头"wake 的能力边界"）。
  [Parameter(Position = 0)][ValidateSet('open', 'close', 'status', 'snapshot', 'wake', 'selfcheck')][string]$Action = 'open',
  [string]$Browser = '',
  # **明确这次开哪几页**（2026-09-24 加，P0 收口）：值域 dsh / console / snowluma。
  # 不传 = 老行为（三个都要）。调用方（start-all / control.ps1 / DSH 窗口的 w）显式说清楚，
  # 就不再靠"猜默认值 + 猜心跳时序"决定开不开（见 docs\qq-agent-产品设计.md §3.3）。
  [string[]]$Pages = @(),
  # **哪页必须重开**（跳过"已开着"判断）。典型用法：SnowLuma 刚重启过 ⇒ 旧标签里的令牌已失效
  # （它的令牌表在内存里），必须重新加载 snowluma-autologin.html 才能把新令牌写进浏览器。
  [string[]]$ForcePage = @(),
  # 默认：**三个页面都开**，开进"**他正在用的那个浏览器窗口**"当新标签页（不新开窗口）——
  # 主人 2026-09-23 第六次调整："重启了这个网站不会出现在我正在用的浏览器 而是会重开一个
  # 我想要她出现在我正在开着的浏览器上"。配合下面的"已经挂着就不重复开"，就不会越堆越多。
  #   -DshOnly  只要 DSH 那一页
  #   -All      旧开关，现在这就是默认行为（保留只为兼容旧命令行）
  [switch]$DshOnly,
  [switch]$All,
  # 旧开关名（= 默认行为），保留只为兼容旧命令行。
  [switch]$Tabs,
  # **可选**：另开一个"我们自己的窗口"装这三个页面并记下句柄 —— 好处是"关闭全部"能把它一起收掉
  # （代价：多一个窗口、不跟你现有的窗口共用）。旧名 -NewWindow 仍然认。
  [Alias('NewWindow')][switch]$OwnWindow,
  # 已经挂着就不重复开（主人 2026-09-23："不要让两个相同的网站运行"）；-Force = 仍然再开一份。
  [switch]$Force,
  # ── 真刷新（2026-09-26 主人："刷新一下重置页面"）──────────────────────────────
  # 判定"这一页还开着吗"靠 socket 层证据，而**重启之后的旧标签 socket 早没了** ⇒ 看不见 ⇒ 被判缺页
  # ⇒ 又开一张（他今早看到 DSH ×2 / SnowLuma ×2 就是这么来的）。真刷新只有 CDP 一条路：
  #   `panels-refresh.mjs` 拿 `/json/list`（挂起/失联的旧标签也列得出来）⇒ 存在就 `Page.reload`。
  # -CdpPort：调试口端口（默认 9223；唯一来源就是这里，起浏览器与连它用的是同一个值）。
  # -CdpMode：auto（默认）= **不主动加旗子**，但那端口本来就在听就用它（行为与加这个功能之前一致）；
  #           on  = 我们自己起浏览器时带上 `--remote-debugging-port`（⇒ 刷新真能做）；
  #           off = 完全不碰 CDP（判据退回 socket 层 + 台账）。
  # ⚠ auto/on 的取舍（加旗子 = 那个 profile 对本机进程开放调试口）由协调线拍，别自己改默认。
  [int]$CdpPort = 9223,
  [ValidateSet('auto', 'on', 'off')][string]$CdpMode = 'auto',
  # **只给检查器注入用**（离线验"有浏览器 + 有 CDP ⇒ 刷新 / 缺页 ⇒ 开"这两条分支）：
  # 传了就当"这些 pid 是浏览器进程"，不再真去查进程表。日常别用。
  [int[]]$AssumeBrowserPids = @(),
  # **只给检查器注入用**（2026-09-26 加）：接管端口判定 —— 见 `Test-Port-Local`。
  # 起因：本地 SnowLuma 按交接待办停着 ⇒ 5099 没在听 ⇒ 那一页进不了候选 ⇒ "缺页 ⇒ 开"那半条
  # 分支**根本跑不出来**（检查器 `[5]` 3 条红全是这么来的**假红**，功能没坏）。
  # **白名单语义**：传了就**只有**这些端口算在听（其余一律当作没在听）—— 必须是白名单，
  # 因为夹具要能**确定地**造出"这一页不在候选里"那个反向场景（"额外当成在听"的加法语义做不到：
  # 真端口在听时反向场景又没了）。日常别用、真跑永远不传。
  # ⚠ 逗号分隔的**字符串**（不是 `[int[]]`）：实测 `-File` 传参时 PowerShell **不会**按逗号拆成
  #   int[]，而是当"带千位分隔符的数字"解析 —— `"3080,3100"` → **30803100**（一个荒唐的端口）、
  #   `"3080,3100,5099"` → 直接绑错报错。所以这里收字符串、下面**显式解析**成 int[]（这个坑正是
  #   夹具那一行 `[注入·检查器专用]` 的自证抓出来的：它把真到手的值打出来了）。
  [string]$AssumePortsListening = '',
  # ── 到达判据注入（2026-09-26，**只给检查器/自检用**；日常真跑永远不传）────────────────────
  # -PanelArrivalShortCircuit：★ **故意短路**到达判据那一步，让它**恒返回 arrived**。
  #   存在的唯一理由 = **空过对照**（自检判据③）：短路之后，"真的没到"的场景**必须**被判红
  #   —— 证明收据里的 `arrived` 不是"我们发起了"换了个说法（这正是"假成功"的病根）。
  #   别拿它当"跳过验收"的快捷方式用。
  [switch]$PanelArrivalShortCircuit,
  # -DeadPorts：把**这些端口**当成"调试口不在听"（逗号分隔字符串，理由同 -AssumePortsListening）。
  #   为什么要有它：夹具要能**确定地**造出"连不上调试口"那个场景，而不是去宿主机上找（或关）
  #   一个真在听的调试口 —— 那可能是主人正在用的浏览器（2026-09-26 小舵划的红线）。
  [string]$DeadPorts = '',
  # ★★ 台账路径可注入（2026-09-26，**只给自测/夹具用**）：给了就**只写这个文件**，一个字节都不碰
  #   生产台账 `qq-bridge\state\panel-opened.json` —— 旧写法是"写完再按字节还原"，那太脆
  #   （中途失败就留脏数据，而且"内容没变"只能靠自证）。自测一律指向 %TEMP%。
  [string]$LedgerFile = '',
  # ★★ 回退闸（2026-09-26，**给自测/无浏览器环境用**）：`Resolve-Browser` 找不到浏览器时，
  #   原来会 `Start-Process <url>` 把开页请求**交给系统默认浏览器**（= 主人正在用的那个）。
  #   自测/夹具**必须**带这个闸：带了就**一次都不许走回退路**，并且**出声**说明"被闸住"
  #   （证明"我的自测没有能力碰真浏览器"）⇒ 收据写 failed，退出码非 0。
  [Alias('NoSystemOpen')][switch]$NoOpenFallback,
  # ★ 空过对照注入（只给自检用）：把"闸"的判定**短路成恒假**（= 假装没这个闸）。
  #   用途只有一个：证明上面那条闸**真的是那行判据在起作用** —— 短路之后，
  #   "闸住"那行就不该再出现（自检据此判红）。真跑永远不传。
  [switch]$PanelGateShortCircuit,
  # ★ 浏览器替身（2026-09-26，**只给自测/夹具用**）：给了就用它当浏览器可执行文件
  #   （自测指向 node.exe 这类**没有任何副作用**的替身）⇒ "起浏览器"这一步**在证据链里被替换**，
  #   代价必须写进报告：这一跑**没有起任何真浏览器**（真到达由同端口那个 headless 实例的清单来证）。
  # ★ 哨兵 `none`（只给自测/夹具用）：**当"这台机器上没找到浏览器"** —— 专门用来造出
  #   "回退路被 -NoOpenFallback 闸住"那个场景（否则本机有 Edge，那条闸根本拉不下去、也就验不了）。
  #   真跑永远不传它（传了不会起任何浏览器，页面自然开不出来）。
  [string]$FakeBrowser = '',
  [switch]$NoClose,
  [switch]$DryRun,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
# ── 端口唯一来源（P2⑦ 参数单一来源）────────────────────────────────────────
# 默认值表只有一处（qq-bridge\src\config-lib.js 的 DEFAULT_PORTS），生效值由仓库根的
# agent.config.json 决定 —— 这里问 Node 要（为什么这么绕，tools\env-config.ps1 文件头写了）。
. (Join-Path $PSScriptRoot 'env-config.ps1')
$Ports = Get-AgentPorts
$BridgeDir = Join-Path $Root 'qq-bridge'
$StateFile = Join-Path $Root '.panels-state.json'
# 清场前拍的"哪几页开着"快照（见文件头第 5 条坑）；跟 panel-presence.json 同一个目录，自检放行
$SnapshotFile = Join-Path $BridgeDir 'state\panel-snapshot.json'
$SnapshotMaxAgeSec = 1800
# ★ 2026-09-25 00:2x（主人原话："程序启动之后可以先打开浏览器，如果有进程就不用打开了；
#   如果是检查标签页面是否已经有三个网站，**没有的话就弹出、有的话就不弹，每个都检测一下**"）
#   ⇒ 快照**三页都认**（原来把 DSH 页排除在外，理由是"它每次重启换启动令牌、旧标签刷了也是 401"）。
#   现在按主人的规矩来：**只要那张标签还在，就不许再弹一张**；旧 DSH 标签的令牌可能已失效 ——
#   这一点由 start-all.ps1 用一句人话告诉他（"连不上就按 F5，或显式 -ForcePage dsh 重开"），
#   而不是拿"再开一张"当默认动作（那正是"每重启一次多一份"的来源）。
$SnapshotPages = @('console', 'snowluma', 'dsh')
# 三个页面各自的端口**不写死**：一律从 $Ports（agent.config.json 派生的生效端口）取。
$DsPort = $Ports.dshWeb
$BridgePort = $Ports.bridgeConsole
$SnowLumaWebPort = $Ports.snowlumaWeb
# :3101 控制面（tools\control-server.mjs，只听回环）：DSH 页里的 qq-control-panel 插件每 5 秒拉一次
# ⇒ 浏览器连着它 = **DSH 页开着**的第二个实测信号（2026-09-25 实测：msedge pid=15124 连 :3101）。
# ⚠ 它不是控制台页的信号：console.html 里根本没有 3101 / 控制面（grep 过），别搞混。
$ControlPort = 0
try { $ControlPort = [int]$Ports.bridgeControl } catch { $ControlPort = 0 }
# ── 检查器注入：`-AssumePortsListening` 的**显式解析**（不靠隐式转换，坑见 param 注释）──────────────
# 空串 = 什么都没注入（**真跑走这条**）⇒ `Test-Port-Local` 照常真去连。
$AssumePorts = @()
if ($AssumePortsListening.Trim()) {
  $AssumePorts = @($AssumePortsListening -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } | ForEach-Object { [int]$_ })
}
# 空串 = 没注入（真跑走这条）⇒ 到达判据照常真去连调试口。
$DeadPorts = @()
if ($DeadPorts -and "$DeadPorts".Trim()) {
  $DeadPorts = @("$DeadPorts" -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ } | ForEach-Object { [int]$_ })
}
# 判断"这一行 netstat 是不是浏览器"必须查**进程名**：桥接自己（node）长期连着 DSH 的 :3080，
# 只看端口会恒真（实测：pid=3032 node 对 :3080 有 2 条 ESTABLISHED）。认的就是 Resolve-Browser 找的那两个。
$BrowserProcNames = @('msedge', 'chrome')
# 控制台页心跳的"新鲜"窗口（秒）。**实测校正**（2026-09-25 深夜）：心跳不是注释里说的"每 10 秒"——
# 后台标签页的定时器会被浏览器节流，实测落盘间隔 ≈60 秒、偶尔 120 秒（01:59:54 → 02:00:54 → 02:02:54 → 02:03:54）。
# 原来的窗口正好 60 秒 = 心跳周期 ⇒ 有一半时间把**活着的**控制台判成"没开着" ⇒ 又开一张
# （主人实测到的"页面多开了三个"里，控制台这一页就是这么来的）。取 3×实测最坏周期。
$PresenceFreshSec = 180
# 我们三个页面的标题特征（= 页面标题），用来核对"这个窗口是不是我们的"
$PanelTitles = @('QQ 桥接控制台', 'SnowLuma 控制台', 'DeepSeek Harness')
# 页面 key → 人看的名字（快照 / 跳过提示都用它，所以定义在脚本前部）
$PageLabels = @{ dsh = 'DSH 页'; console = '桥接控制台'; snowluma = 'SnowLuma 管理页' }

# ── -Pages / -ForcePage：这次开哪几页（**白名单**，写错当场报错，不静默忽略）──────────
# 2026-09-24 加（P0 收口）：以前开哪几页是脚本内部按 -DshOnly 猜的，配合"猜心跳"就长出
# "重复开 / 该开的没开"。现在由调用方明确说，脚本只负责执行 + 去重。
# ★ 页列表**只有这一个来源**（2026-09-24 主人要求："默认值集中在一处、能被显式覆盖即可"）：
#   · $PageKeys   = 合法名字（白名单，写错当场报错）
#   · $DefaultPages = **不传 -Pages 时开哪几页**（关键字 all / none，或 'a,b' 逗号列表）。
#     将来要按配置项（例如 browserMode）派生"挂机模式"，**只改这一行**（或让它读配置），
#     别在别的地方再造一份默认页列表（start-all / dsh-prompt 也都用关键字覆盖，不抄具体名单）。
$PageKeys = @('dsh', 'console', 'snowluma')
$DefaultPages = 'all'
function Resolve-PageList([string[]]$values, [string]$what) {
  $pieces = New-Object System.Collections.ArrayList
  foreach ($v in @($values)) {
    if (-not $v) { continue }
    foreach ($piece in ($v -split ',')) {
      $k = $piece.Trim().ToLowerInvariant()
      if ($k) { [void]$pieces.Add($k) }
    }
  }
  # 关键字 all / none 只能**单独**出现（'none,dsh' 是自相矛盾的，别猜、当场报错）
  $keywords = @('all', 'none')
  if ($pieces.Count -gt 1) {
    foreach ($kw in $keywords) {
      if ($pieces -contains $kw) { throw "$what 里「$kw」只能单独用，不能和别的名字混着写（收到：$($pieces -join ',')）" }
    }
  }
  if ($pieces.Count -eq 1 -and $pieces[0] -eq 'none') { return (New-Object System.Collections.ArrayList) }   # 一个页面都不开
  if ($pieces.Count -eq 1 -and $pieces[0] -eq 'all') { $out = New-Object System.Collections.ArrayList; foreach ($k in $PageKeys) { [void]$out.Add($k) }; return $out }

  $out = New-Object System.Collections.ArrayList
  foreach ($k in $pieces) {
    switch ($k) {                       # 顺手认几个别名，省得调用方记错名字
      'web'     { $k = 'dsh' }
      'bridge'  { $k = 'console' }
      'webui'   { $k = 'console' }
      'qq'      { $k = 'snowluma' }
    }
    if ($PageKeys -notcontains $k) { throw "$what 里有不认识的名字「$k」；只认：all / none / $($PageKeys -join ' / ')" }
    if (-not $out.Contains($k)) { [void]$out.Add($k) }
  }
  return $out
}

$wantPages = @{}
$forcePages = @{}
try {
  # 页列表的唯一来源：不传 -Pages 就用 $DefaultPages；-DshOnly 是"只要 DSH"的旧写法（等价 -Pages dsh）。
  $requestedRaw = if (@($Pages).Count -gt 0) { @($Pages) } elseif ($DshOnly) { @('dsh') } else { @($DefaultPages) }
  $requested = @(Resolve-PageList $requestedRaw '-Pages')
  foreach ($k in $requested) { $wantPages[$k] = $true }
  foreach ($k in @(Resolve-PageList $ForcePage '-ForcePage')) { $forcePages[$k] = $true }
  if ($wantPages.Count -eq 0 -and $forcePages.Count -gt 0) {
    throw "-Pages none（一个页面都不开）和 -ForcePage 是矛盾的，别一起用"
  }
} catch {
  Write-Host "  [错误] $($_.Exception.Message)"
  Write-Host '         用法：panels.ps1 open -Pages all|none|dsh,console,snowluma [-ForcePage snowluma]'
  exit 2
}

# ★ 2026-09-25（执行线 5758ba91）：**凭据打码**（纯函数，收据写盘前一律过它）。
#   为什么要有它：收据是"新落盘的一条内容"⇒ 新开一条泄漏面（坑表那条）。第一次真重启就漏了 12 行
#   SnowLuma 令牌；我第一版判据是"像不像十六进制（≥24 位连续 hex）"⇒ 第二次真重启又漏了 **DSH 令牌**
#   （**43 位 base64url**：大小写 + `-` + `_`，形状完全不同）—— **按"形状"判永远会漏下一种**。
#   ⇒ 改成**按语义判**：只要键名是 token / secret / password / authorization 之类，**值一律打码，
#   不看形状、不看长度**（`token=abc` 这种短值也打码 —— 宁可多打）。
#   ⚠ 只对**写盘**生效；控制台输出保持原样（人要看真东西）。
function Mask-Secrets([string]$text) {
  if ([string]::IsNullOrEmpty($text)) { return $text }
  $t = $text
  # ① **先**处理 `Bearer xxx` / `Basic xxx`（HTTP 头那种没有等号）—— 顺序有讲究：若先跑下面那条
  #    键值对规则，`Authorization: Bearer xxx` 会被它把**值**当成 `Bearer` 打掉、把真令牌**留下**
  #    （我第一版正是这样，用例当场抓住 ⇒ 这条必须排在前面）。
  $t = [regex]::Replace($t, '(?i)\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]{4,}', '$1 <已打码>')
  # ② 键值对形态：`token=…` / `?token=…` / `&access_token=…` / `"token": "…"` / `password: …`（值吃到
  #    空白、`&`、引号为止）。保留键名与分隔符，只换值；**不看形状、不看长度**。
  #    负向先行断言：值正好是 `Bearer`/`Basic` 时跳过（那已被 ① 处理，别再套一层）。
  $t = [regex]::Replace($t,
    '(?i)((?:[?&;]|["''])?(?:access_token|api_token|auth_token|refresh_token|token|secret|password|passwd|authorization)["'']?\s*[:=]\s*["'']?)(?!(?:Bearer|Basic)\b)([^\s&;"'']{1,})',
    '$1<已打码>')
  return $t
}

function Say([string]$msg) {
  if (-not $Quiet) { Write-Host $msg }
  # ★ 2026-09-25（执行线 5758ba91，**重启前置**）：**可核收据** —— 关键行同时追加到
  #   `qq-bridge\state\_tmp\panels.log`。以前全走 Write-Host、不落盘 ⇒ 每次重启
  #   "重开了哪几页 / 跳过了哪几页"事后无法复核（18:33:47 那次全量重启其实已经跑过新代码，
  #   却没留下任何可核收据 ⇒ 判据 1 只能靠源码推）。
  #   边界：① `-DryRun` 不记账（那是预演）② 写盘任何失败都吞掉（收据绝不能让启动器挂掉）
  #   ③ `-Quiet` 只静音控制台、**照样记账**（收据的意义就是留给事后核）。
  if ($DryRun) { return }
  try {
    $logDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'qq-bridge\state\_tmp'
    if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
    $logFile = Join-Path $logDir 'panels.log'
    # ★ 2026-09-25（第一版在这里就翻过车，留痕）：第一版判据是"≥24 位连续十六进制" ⇒ 只挡得住
    #   控制台令牌（hex），**第二次真重启就漏了 DSH 令牌（43 位 base64url）** ⇒ 已改成 `Mask-Secrets`
    #   按**语义**打码（键名是 token/secret/password/authorization 就一律打码，不看形状与长度）。
    #   ⚠ **今后所有"把控制台输出落盘"的地方都要过 `Mask-Secrets`**（别再各写一份形状判据）。
    $safeMsg = Mask-Secrets $msg
    Add-Content -LiteralPath $logFile -Encoding UTF8 -Value ('{0} [pid {1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $PID, $safeMsg)
    # 有界：超过 1 MB 只留最后 500 行（重启很多次也不至于堆成一座山）。
    if ((Get-Item -LiteralPath $logFile).Length -gt 1MB) {
      $keep = Get-Content -LiteralPath $logFile -Encoding UTF8 -Tail 500
      Set-Content -LiteralPath $logFile -Value $keep -Encoding UTF8
    }
  } catch { }
}

function Test-Port-Local([int]$port) {
  # ★ 检查器注入（见 param 里 `-AssumePortsListening` 的注释；白名单语义）：
  #   传了就**一律不真连** —— 离线夹具不该依赖本机真端口状态（这正是 2026-09-26 那次假红的根因）。
  if ($AssumePorts.Count -gt 0) { return ($AssumePorts -contains $port) }
  try {
    $client = New-Object Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $port)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

# ── user32：枚举顶层窗口 / 读标题 / 关窗口 ────────────────────────────────────
function Initialize-Win32 {
  if ('W.Panels' -as [type]) { return }
  Add-Type -Namespace W -Name Panels -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, System.IntPtr lParam);
public delegate bool EnumWindowsProc(System.IntPtr hWnd, System.IntPtr lParam);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
public static extern int GetWindowTextW(System.IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindowVisible(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool IsWindow(System.IntPtr hWnd);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool PostMessageW(System.IntPtr hWnd, uint Msg, System.IntPtr wParam, System.IntPtr lParam);
'@
}

function Get-TopLevelWindows {
  Initialize-Win32
  $list = New-Object System.Collections.ArrayList
  $callback = [W.Panels+EnumWindowsProc] {
    param([System.IntPtr]$hWnd, [System.IntPtr]$lParam)
    try {
      if ([W.Panels]::IsWindowVisible($hWnd)) {
        $sb = New-Object System.Text.StringBuilder 512
        [void][W.Panels]::GetWindowTextW($hWnd, $sb, $sb.Capacity)
        $title = $sb.ToString()
        if ($title) {
          $ownerPid = 0
          [void][W.Panels]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
          [void]$list.Add([pscustomobject]@{ Handle = $hWnd; Title = $title; OwnerPid = $ownerPid })
        }
      }
    } catch {}
    return $true
  }
  [void][W.Panels]::EnumWindows($callback, [System.IntPtr]::Zero)
  return $list
}

# SetForegroundWindow：wake 动作用它把已有窗口叫到前台（只叫前台，不开页、不关窗）。
function Initialize-ForeWin32 {
  if ('W.Fore' -as [type]) { return }
  Add-Type -Namespace W -Name Fore -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
}

function Get-WindowTitle([System.IntPtr]$hWnd) {
  Initialize-Win32
  $sb = New-Object System.Text.StringBuilder 512
  [void][W.Panels]::GetWindowTextW($hWnd, $sb, $sb.Capacity)
  return $sb.ToString()
}

function Test-IsPanelTitle([string]$title) {
  if (-not $title) { return $false }
  foreach ($t in $PanelTitles) { if ($title -like "*$t*") { return $true } }
  return $false
}

function Test-IsBrowserWindow([System.IntPtr]$hWnd) {
  $ownerPid = 0
  [void][W.Panels]::GetWindowThreadProcessId($hWnd, [ref]$ownerPid)
  $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
  return ($proc -and @('msedge', 'chrome') -contains $proc.ProcessName)
}

# 启动前后对比窗口列表：新出现的、标题命中我们页面的那种顶层窗口 = 我们的面板窗口
function Find-NewPanelWindow($beforeHandles, [int]$timeoutMs = 15000) {
  Initialize-Win32
  $deadline = (Get-Date).AddMilliseconds($timeoutMs)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
    foreach ($win in Get-TopLevelWindows) {
      if ($beforeHandles -contains $win.Handle) { continue }
      if (Test-IsPanelTitle $win.Title) { return $win }
    }
  }
  return $null
}

# ── 判据（**全项目唯一一份**）：这个页面现在开着吗？──────────────────────────────
# 三态，三页**各自独立**判（一张在、另一张不在 ⇒ 只开缺的那张）：
#   'open'    = **实测**到它还活着（下面每条判据都是测出来的信号，没有一条是猜、也不是"我们记的账"）
#   'absent'   = **实测**到它不在（可证不在）
#   'unknown' = 判不准 ⇒ 调用方按**宁可不开**处理（主人 2026-09-25 原话："检测不准宁可不开"）
#
# 认哪几条实测信号（2026-09-25 深夜逐条实测校正过）：
#   ① `netstat -ano` 的 ESTABLISHED 行：**远端端口 = 我们的端口** ⇒ 这一行就是"某个客户端连上我们"，
#      最后一列 PID 就是那个客户端；再看这个 PID 的进程名是不是浏览器。
#      ⚠ 端口一律从 $Ports（agent.config.json 派生）取，不写死数字。
#      ⚠ 为什么不用 Get-NetTCPConnection：这台机器上它不可信（实测 `-State Listen` 返回 0 条）；
#        `netstat -ano` 最后一列 PID 才可信（实测：msedge pid=15124 连 :3080 / :5099 / :3101）。
#   ② 控制台页（:$BridgePort）**没有**浏览器长连接 —— 实测 `:3100` 只有 TIME_WAIT、没有一条
#      ESTABLISHED（它是每 N 秒 fetch 一次的短连接）⇒ 只能看**心跳**：控制台页 ping 桥接
#      `GET /api/panel/ping`（bridge.js:2613）落盘的 state\panel-presence.json，那是页面自己报的活。
#      ⚠ 实测校正：心跳周期 ≈60 秒（不是注释里说的 10 秒），窗口见 $PresenceFreshSec。
#   ③ 桥接进程的启动时间（netstat 的 LISTENING 行 → PID → StartTime）：用来分辨"心跳静默"到底是
#      "页面没了"还是"桥接刚重启、那段时间它本来 ping 不进来"。
#   ④ 有没有浏览器进程在跑：一个都没有 ⇒ 三页**可证不在**（标签页必须有浏览器进程）⇒ 缺的照开。
#   ⑤ 兜底（只作补充、绝不推翻上面）：**可见的浏览器窗口标题**里出现对应页名 —— 只看得见"当前那一页"，
#      但它能补上"标签页还在、连接却断了/还没加载"这种 socket 层看不见的情况。
#
# 这条判据的两个**已知盲区**（如实写在这里，别假装它万能）：
#   · 标签页在、但令牌失效/被浏览器挂起（休眠标签页、重启后恢复的未加载标签页）⇒ socket 层看不见它，
#     会被判成 absent ⇒ 又想开一张。这是"清场前快照"存在的唯一理由（见文件头第 5 条坑），
#     也是本判据**改不掉**的（浏览器不给外部脚本读标签页）。
#   · 用 msedge/chrome 之外的浏览器时（-Browser 指定别的）这里认不出 ⇒ 会漏判成 absent。
function Get-BrowserPids {
  $pids = New-Object System.Collections.ArrayList
  foreach ($n in $BrowserProcNames) {
    foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) { [void]$pids.Add([int]$p.Id) }
  }
  return @($pids.ToArray())
}

# 从一份 netstat 文本里取"连到 $Port 的客户端 PID"（= 远端端口是它的那些 ESTABLISHED 行，最后一列 PID）
# 行样例：  TCP    127.0.0.1:4036         127.0.0.1:3080         ESTABLISHED     15124
function Get-PortClientPids {
  param([string[]]$Lines, [int]$Port)
  $out = New-Object System.Collections.ArrayList
  if ($Port -le 0) { return @() }
  foreach ($line in @($Lines)) {
    if ($line -notmatch '^\s*TCP\s+(\S+)\s+(\S+)\s+ESTABLISHED\s+(\d+)\s*$') { continue }
    $remote = [string]$Matches[2]
    $owner = [int]$Matches[3]
    if ($remote -match (':{0}$' -f $Port)) { [void]$out.Add($owner) }
  }
  return @($out.ToArray())
}

# 从一份 netstat 文本里取"监听 $Port 的进程 PID"（LISTENING 行的最后一列）
function Get-PortListenPid {
  param([string[]]$Lines, [int]$Port)
  if ($Port -le 0) { return 0 }
  foreach ($line in @($Lines)) {
    if ($line -notmatch '^\s*TCP\s+(\S+)\s+(\S+)\s+LISTENING\s+(\d+)\s*$') { continue }
    # ★ 先把两个组取出来再比：`-match` 会**覆盖 $Matches** —— 写成 `[string]$Matches[1] -match … { return $Matches[3] }`
    #   的话，第二个 $Matches[3] 取的是**内层**匹配的组（内层没有组 3）⇒ 永远返回 0（这条我自己踩过，
    #   症状 = 控制台页永远"查不到桥接进程启动时间"）。
    $local = [string]$Matches[1]
    $owner = [int]$Matches[3]
    if ($local -match (':{0}$' -f $Port)) { return $owner }
  }
  return 0
}

# ★★ 这一个函数就是"这页开着吗"的**唯一**判据来源（三页共用；start-all 不另写一份）。
#    `-Offline` + 注入参数 = 回归测试拿**假 netstat** 驱动它，不碰浏览器、不碰服务（见 selfcheck）。
function Get-PanelVerdicts {
  param(
    [string[]]$NetstatLines,      # $null = 真去跑一次 netstat -ano
    [object[]]$BrowserPids,       # $null = 真去查进程；@() = 明确"一个浏览器都没跑"
    [string]$PresenceText,        # $null = 真去读 panel-presence.json
    $ListenStart,                 # $null = 真去查 :$BridgePort 监听进程的启动时间
    [string[]]$WindowTitles,      # $null = 真去枚举可见浏览器窗口标题
    [datetime]$Now = (Get-Date),
    [switch]$Offline
  )
  $PresenceReadError = ''
  if (-not $Offline) {
    if ($null -eq $NetstatLines) { $NetstatLines = @(netstat -ano) }
    if ($null -eq $BrowserPids) { $BrowserPids = @(Get-BrowserPids) }
    # ⚠ 这里必须问 $PSBoundParameters，**不能**写 `if ($null -eq $PresenceText)`：
    #   PS 5.1 里**没传的 [string] 参数是空串、不是 $null**（实测：f1 打 EMPTY、[string[]] 打 NULL）
    #   ⇒ 那样写会静默跳过读文件，活着的控制台页永远被判成"读不到心跳"（这一脚我自己踩过，2026-09-25）。
    if (-not $PSBoundParameters.ContainsKey('PresenceText')) {
      $PresenceText = ''
      try {
        $pf = Join-Path $Root 'qq-bridge\state\panel-presence.json'
        if (Test-Path -LiteralPath $pf) {
          $PresenceText = [string](Get-Content -LiteralPath $pf -Raw -Encoding UTF8)
          if (-not $PresenceText) { $PresenceReadError = "$pf 是空文件" }
        } else {
          $PresenceReadError = "没有 $pf"
        }
      } catch {
        $PresenceText = ''
        $PresenceReadError = "读 $pf 失败：$($_.Exception.Message)"
      }
    }
    if ($null -eq $ListenStart) {
      $listenPid = Get-PortListenPid -Lines $NetstatLines -Port $BridgePort
      if ($listenPid -gt 0) {
        $listenProc = Get-Process -Id $listenPid -ErrorAction SilentlyContinue
        if ($listenProc) { $ListenStart = $listenProc.StartTime }
      }
    }
    if ($null -eq $WindowTitles) {
      $WindowTitles = @()
      try {
        Initialize-Win32
        foreach ($win in Get-TopLevelWindows) {
          if (Test-IsBrowserWindow $win.Handle) { $WindowTitles += [string]$win.Title }
        }
      } catch { $WindowTitles = @() }
    }
  }
  $bp = @($BrowserPids | ForEach-Object { [int]$_ })
  $titles = @($WindowTitles)
  $verdict = @{}
  foreach ($k in $PageKeys) { $verdict[$k] = @{ State = 'unknown'; Reason = '没测到任何信号' } }
  # ⓪ 浏览器一个都没跑 ⇒ 三页**可证不在**（标签页必须有浏览器进程）
  if ($bp.Count -eq 0) {
    foreach ($k in $PageKeys) {
      $verdict[$k] = @{ State = 'absent'; Reason = '实测：一个浏览器进程都没在跑（标签页不可能存在）' }
    }
    return $verdict
  }
  # ① dsh：:$DsPort 上的浏览器长连接（GUI 事件流），或 :$ControlPort（DSH 页里的控制面板插件每 5 秒拉）
  $dshOwners = @()
  foreach ($cand in (@(Get-PortClientPids -Lines $NetstatLines -Port $DsPort) + @(Get-PortClientPids -Lines $NetstatLines -Port $ControlPort))) {
    if ($bp -contains [int]$cand) { $dshOwners += [int]$cand }
  }
  if ($dshOwners.Count -gt 0) {
    $verdict['dsh'] = @{ State = 'open'; Reason = "浏览器还连着 :$DsPort / :$ControlPort（netstat ESTABLISHED，pid $((@($dshOwners | Select-Object -Unique)) -join ',')）" }
  } else {
    $verdict['dsh'] = @{ State = 'absent'; Reason = "netstat 里没有浏览器连着 :$DsPort（也没有 :$ControlPort）" }
  }
  # ② snowluma：:$SnowLumaWebPort 上的浏览器长连接（管理页的日志流）
  $slOwners = @()
  foreach ($cand in @(Get-PortClientPids -Lines $NetstatLines -Port $SnowLumaWebPort)) {
    if ($bp -contains [int]$cand) { $slOwners += [int]$cand }
  }
  if ($slOwners.Count -gt 0) {
    $verdict['snowluma'] = @{ State = 'open'; Reason = "浏览器还连着 :$SnowLumaWebPort（netstat ESTABLISHED）" }
  } else {
    $verdict['snowluma'] = @{ State = 'absent'; Reason = "netstat 里没有浏览器连着 :$SnowLumaWebPort" }
  }
  # ③ console：心跳（页面自己报的活）+ 桥接进程启动时间（分辨"静默"的来路）
  $hb = $null
  $hbErr = ''
  if ($PresenceText) {
    try {
      $ts = [string](($PresenceText | ConvertFrom-Json).console)
      if ($ts) { $hb = [datetime]::Parse($ts) }
      else { $hbErr = '文件里没有 console 这个键' }
    } catch { $hb = $null; $hbErr = $_.Exception.Message }
  } elseif ($PresenceReadError) {
    $hbErr = $PresenceReadError
  } else {
    $hbErr = '这次既没去读文件、也没注入心跳（-Offline 用法不对）'
  }
  if ($null -eq $hb) {
    # ★ 判不准就照实说**为什么**（别只给一句"没有/坏了"：2026-09-25 实测遇到过一次读不到，
    #   只有把真实原因带出来才查得动 —— 这条消息本身就是排查用的证据）
    $verdict['console'] = @{ State = 'unknown'; Reason = "读不到心跳（$hbErr）—— 判不准" }
  } else {
    $age = [int]($Now - $hb).TotalSeconds
    $upSec = -1
    if ($ListenStart) { $upSec = [int]($Now - [datetime]$ListenStart).TotalSeconds }
    $restartedSinceBeat = ($upSec -ge 0 -and $upSec -lt $age)   # 桥接进程比最后一次心跳还新 ⇒ 那次心跳是"上一个桥接"记的
    if ($age -ge -5 -and $age -lt $PresenceFreshSec) {
      if ($restartedSinceBeat) {
        $verdict['console'] = @{ State = 'unknown'; Reason = "心跳 $age 秒前，但桥接 $upSec 秒前才起来（那次心跳是上一个桥接记的）—— 说不清" }
      } else {
        $verdict['console'] = @{ State = 'open'; Reason = "心跳 $age 秒前（页面自己在报活）" }
      }
    } elseif ($restartedSinceBeat) {
      $verdict['console'] = @{ State = 'unknown'; Reason = "心跳已经 $age 秒没更新，而这期间桥接重启过 —— 说不清是页面没了还是它 ping 不进来" }
    } elseif ($upSec -lt 0) {
      $verdict['console'] = @{ State = 'unknown'; Reason = "心跳 $age 秒没更新，且查不到桥接进程的启动时间 —— 判不准" }
    } elseif ($upSec -le $PresenceFreshSec) {
      $verdict['console'] = @{ State = 'unknown'; Reason = "桥接才起来 $upSec 秒，还没到能断言'页面没了'的时间 —— 判不准" }
    } else {
      $verdict['console'] = @{ State = 'absent'; Reason = "桥接一直在跑（$upSec 秒），这 $age 秒里一次心跳都没有 ⇒ 这页确实没开着" }
    }
  }
  # ④ 窗口标题兜底：只把非 open 的抬成 open
  foreach ($t in $titles) {
    if (-not $t) { continue }
    if ($t -like '*QQ 桥接控制台*' -and [string]$verdict['console'].State -ne 'open') {
      $verdict['console'] = @{ State = 'open'; Reason = '可见的浏览器窗口标题里有"QQ 桥接控制台"' }
    }
    if ($t -like '*DeepSeek Harness*' -and [string]$verdict['dsh'].State -ne 'open') {
      $verdict['dsh'] = @{ State = 'open'; Reason = '可见的浏览器窗口标题里有"DeepSeek Harness"' }
    }
    if ($t -like '*SnowLuma 控制台*' -and [string]$verdict['snowluma'].State -ne 'open') {
      $verdict['snowluma'] = @{ State = 'open'; Reason = '可见的浏览器窗口标题里有"SnowLuma 控制台"' }
    }
  }
  return $verdict
}

# 薄适配层（**快照**在用）：返回"清场前**实测开着**的页 → 理由"。
# 只收 'open'：快照的含义是"清场前测到它活着"，'unknown' 不算证据（清场后自然会被重新判一次）。
# 返回 @{ dsh = '理由'; … }，键只在"实测开着"时出现。
function Get-OpenPanelPages {
  $out = @{}
  $v = Get-PanelVerdicts          # ★ 只调一次：判一次就是一次 netstat，不许判两回（两回还可能不一致）
  foreach ($k in @($v.Keys)) {
    if ([string]$v[$k].State -eq 'open') { $out[$k] = [string]$v[$k].Reason }
  }
  return $out
}

# ★★ 这一个函数就是"这次到底开哪几页"的**唯一**判定（open 用它；selfcheck 拿假判据驱动它）。
#    Force（-ForcePage 点名）> 快照（清场前实测开着）> unknown（判不准 ⇒ 不开）> open（实测开着 ⇒ 不开）
#    > absent（实测不在 ⇒ 开）。**三页各自独立**，互不影响。
function Resolve-PagesToOpen {
  param($Verdict, [string[]]$Want, [string[]]$Force, $Snapshot)
  $open = @(); $skip = @(); $unsure = @()
  foreach ($k in @($Want)) {
    if (@($Force) -contains $k) { $open += $k; continue }
    if ($Snapshot -and $Snapshot.ContainsKey($k)) { $skip += $k; continue }
    if ($Verdict -and $Verdict.ContainsKey($k) -and [string]$Verdict[$k].State -eq 'unknown') { $unsure += $k; continue }
    if ($Verdict -and $Verdict.ContainsKey($k) -and [string]$Verdict[$k].State -eq 'open') { $skip += $k; continue }
    $open += $k
  }
  return [pscustomobject]@{ Open = @($open); Skip = @($skip); Unsure = @($unsure) }
}

# ── 快照（清场之前拍，清场之后用；见文件头第 5 条坑）────────────────────────────
# ── 页名渲染（**null 安全的唯一一份**）────────────────────────────────────────
# ★★ 2026-09-24 深夜（主人截图：`panels.ps1:485` 喷红字
#    `Index operation failed; the array index evaluated to null.`）——
#    根因不在"有没有 null 键"，而在这里**直接把猜来的东西当字典用**：
#      `$pages.Keys | ForEach-Object { $PageLabels[$_] }`
#    只要 `$pages` 不是字典（本次实测：`Save-PanelSnapshot` 的返回值是一条
#    `System.Collections.Hashtable` 的**字符串**、被包成 `String[]`），`.Keys` 就是 `$null`，
#    而 **`$null | ForEach-Object { … }` 在 PS 5.1 里会执行一次、`$_` = `$null`**
#    ⇒ `$PageLabels[$null]` ⇒ 红字（不是"无害"，它把一次真故障伪装成噪音）。
#    规矩：**渲染页名一律走这里** —— 认得的键给中文名，认不得的键**如实报出来**（不吞、不装正常）。
function Get-PageNameList {
  param($Pages)
  $known = @()
  $odd = @()
  if ($null -eq $Pages) {
    return [pscustomobject]@{ Known = @(); Odd = @('(空值)'); KeyCount = 0; IsDict = $false }
  }
  $isDict = ($Pages -is [System.Collections.IDictionary])
  # `.Keys` 取不到（String[] / 普通对象…）⇒ 如实说"不是字典"，**绝不**去数它有几个键
  # （`$null | ForEach-Object` 会跑一次、`$_` = $null —— 那正是 485 行那次红字的来路）。
  $rawKeys = $null
  try { $rawKeys = $Pages.Keys } catch { $rawKeys = $null }
  if ($null -eq $rawKeys) {
    return [pscustomobject]@{ Known = @(); Odd = @("(不是字典：$($Pages.GetType().Name))"); KeyCount = 0; IsDict = $isDict }
  }
  foreach ($k in @($rawKeys)) {
    if ($null -eq $k -or "$k" -eq '') { $odd += '(空键)'; continue }
    if ($PageLabels.ContainsKey([string]$k)) { $known += $PageLabels[[string]$k] } else { $odd += [string]$k }
  }
  # 有 `.Keys` 但不是字典（模拟 null 键那一档就是）：照常渲染，同时**如实标注**它不是字典
  if (-not $isDict) { $odd += "(不是字典：$($Pages.GetType().Name))" }
  return [pscustomobject]@{ Known = $known; Odd = $odd; KeyCount = @($rawKeys).Count; IsDict = $isDict }
}

function Save-PanelSnapshot {
  # ★ 根因层（2026-09-24 深夜）：这个函数的返回值**必须**是字典，否则调用方（下面 snapshot 那一段）
  #   拿到一条字符串就会喷红字。实测到过 `String[]`（内容是 `System.Collections.Hashtable`）——
  #   也就是说"取开着哪几页"这条路的**成功流被污染过**。这里**不许把不是字典的东西往下传**：
  #   校验、如实报（带上真实类型，别静默吞），并按"这次没测到页面"处理（宁可少跳过一页，
  #   也不能拿一条字符串去当页面清单）。
  $raw = Get-OpenPanelPages
  $pages = $raw
  if ($raw -isnot [System.Collections.IDictionary]) {
    $t = if ($null -eq $raw) { 'NULL' } else { $raw.GetType().FullName }
    $sample = ''
    try { $sample = (($raw | Select-Object -First 3) -join ' / ') } catch { }
    Say ("  [警告] 快照源的返回值不是字典（拿到了 {0}）—— 按'这次没测到页面'处理。" -f $t)
    if ($sample) { Say ("         实际拿到：{0}" -f $sample) }
    Say '         这是真 bug（别再往下传），请把这一行连同上面那行一起报出来。'
    $pages = @{}
  }
  $dir = Split-Path -Parent $SnapshotFile
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  @{ capturedAt = (Get-Date).ToString('o'); pages = $pages } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $SnapshotFile -Encoding UTF8
  return $pages
}

function Remove-PanelSnapshot {
  Remove-Item -LiteralPath $SnapshotFile -Force -ErrorAction SilentlyContinue
}

# 读快照：过期（默认 30 分钟）/ 时间戳不合理 / 文件坏了 → 一律当"没拍过"（返回空表）。
function Read-PanelSnapshot {
  if (-not (Test-Path -LiteralPath $SnapshotFile)) { return @{} }
  try {
    $raw = Get-Content -LiteralPath $SnapshotFile -Raw -Encoding UTF8
    $o = $raw | ConvertFrom-Json
    $age = [int]((Get-Date) - [datetime]::Parse($o.capturedAt)).TotalSeconds
    if ($age -lt -5 -or $age -gt $SnapshotMaxAgeSec) { return @{} }
    $open = @{}
    foreach ($prop in $o.pages.PSObject.Properties) {
      if ($SnapshotPages -notcontains $prop.Name) { continue }   # DSH 页不认快照
      $open[$prop.Name] = "$($prop.Value)，清场前 $age 秒拍的快照"
    }
    return $open
  } catch {
    Say "  [提示] 面板快照读不了（$($_.Exception.Message)）→ 按没拍过处理"
    return @{}
  }
}

# ── 真刷新（CDP，2026-09-26）：权威标签页清单 + Page.reload ─────────────────────────────
# 没有调试口时 CLI 退 2 ⇒ 这里返回 $null，调用方**如实退回**"提示按 F5"，绝不假装刷过。
# ⚠ 变量名别叫 `$args`（PowerShell 自动变量，2026-09-25 那枚炸弹就是这么来的）⇒ 叫 $cliArgs。
function Get-CdpTargets {
  param([int]$Port)
  $cli = Join-Path $PSScriptRoot 'panels-refresh.mjs'
  if (-not (Test-Path -LiteralPath $cli)) { return $null }
  try {
    $raw = & node $cli 'list' '--port' ([string]$Port) 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { return $null }
    $line = ($raw.Trim() -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if (-not $line) { return $null }
    $o = $line | ConvertFrom-Json
    if (-not $o.ok) { return $null }
    return $o
  } catch { return $null }
}
# ── ★ 到达判据（2026-09-26，执行线 30721fa8）：**"页面到了"的唯一一份判据** ────────────────
# 病根（主人 2026-09-26 18:59 第二次被坑）：开页动作 `Start-Process … | Out-Null` **发完就当成功**，
#   `Save-PanelLedger` 照样写时间戳 ⇒ ★ **收据记的是"我发起了"，不是"页面到了"**（他实况是
#   "页面还是没出来，我手动点出来的"）。修法不是"再发一次"，而是**把到达验出来**：
#   `Get-CdpTargets` 拿到的 `/json/list` 本来就是标签页的**权威清单**，只是从没被用在验收上。
# ⚠ 判据**只覆盖"页面真的到了"**，不假装能验渲染完成：标题里有 `ERR_*` = 浏览器自己的错误页
#   （连通失败/域名解析失败…），那是**到了但没成** ⇒ 照样算没到（`failed`）。判不准一律当**没到**。
function Test-CdpPageArrived {
  param([int]$Port, [string]$Url)
  # ★ 空过对照的注入点（只给自检用）：短路时**恒返回 arrived**，用来证明"真的没到"仍会被判红。
  #   这个开关**永远不会**改变真跑的结论（真跑不传它）。
  if ($PanelArrivalShortCircuit) {
    return [pscustomobject]@{ Ok = $true; Why = '到达到位（判据被短路注入，恒真：只给空过对照用）'; Title = '' }
  }
  $u = "$Url"
  if (-not $u) { return [pscustomobject]@{ Ok = $false; Why = '地址是空的（构造失败）'; Title = '' } }
  if ($DeadPorts -contains $Port) { return [pscustomobject]@{ Ok = $false; Why = "调试口 :$Port 连不上（夹具注入：当它不在听）"; Title = '' } }
  $m = ''
  try { $m = ([uri]$u).Authority } catch { }
  if (-not $m) { $m = [regex]::Replace($u, '^(?i)https?://', '') -replace '[/?].*$', '' }
  if (-not $m) { return [pscustomobject]@{ Ok = $false; Why = '地址里认不出主机端口，没法核对'; Title = '' } }
  $t = Get-CdpTargets -Port $Port
  if (-not $t) { return [pscustomobject]@{ Ok = $false; Why = "调试口 :$Port 连不上（CLI 退 2）：**无法确认到达**"; Title = '' } }
  $hit = @($t.targets | Where-Object { $_.url -like "*$m*" })
  if ($hit.Count -eq 0) { return [pscustomobject]@{ Ok = $false; Why = "清单里没有 $m 这个标签（浏览器到是起来了、这一页没成）"; Title = '' } }
  $title = [string]$hit[0].title
  if ($title -match '^(?i)ERR_') { return [pscustomobject]@{ Ok = $false; Why = "清单里有 $m，但标题是 $title（浏览器错误页 ⇒ 页面没成）"; Title = $title } }
  # ★ 权威信号：探针看到的 `location.href` **还是不是 http(s)**。
  #   打不开的地址在 Chromium 里 href 会变成 `chrome-error://chromewebdata/` ⇒ 这就是"到了但没成"。
  #   （不拿"标题为空"当判据 —— 实测真页面的 document.title 也可能是空的。）
  #   探针只能证伪：明确说"不是 http"才判没到；探不到（WebSocket 被拒等）就退回清单层结论、如实标注。
  $probe = Get-CdpPageProbe -Port $Port -Url $u
  if ($probe) {
    $href = "$($probe.href)"
    if ($href -and $href -notmatch '^(?i)https?:') {
      return [pscustomobject]@{ Ok = $false; Why = "清单里有 $m，但它已经变成浏览器错误页（location.href=$href ⇒ 打不开）"; Title = $title }
    }
    if ($probe.title) { $title = "$($probe.title)" }
    $note = if ($probe.err) { "；探针没回话（$($probe.err)）" } else { '' }
    return [pscustomobject]@{ Ok = $true; Why = "清单里确认有 $m（探针：href 仍是 http、document.title「$title」）$note"; Title = $title }
  }
  return [pscustomobject]@{ Ok = $true; Why = "清单里确认有 $m（标题「$title」；探针没回话，只验到清单这一层）"; Title = $title }
}

# 等到达：`Start-Process` 派出去之后，浏览器**不是立刻**就有那个标签（实测要几百毫秒）——
# 所以"到达"要**轮询**判据若干次，而不是发完马上问一次（那样会把"还没到"误判成"没到"）。
# 只读探针：那个 target **真到了没有** —— 取 `location.href` ＋ `document.title`（见 panels-refresh.mjs 头注）。
# ★ 判据是 **href 还是不是 http(s)**：打不开的地址在 Chromium 里 href 会变成 `chrome-error://…`；
#   而 `document.title` 空**不能**当判据（实测：主人那个真的 DSH 页 title 也是空的）。
# 走 `panels-refresh.mjs probe`（窄命令：只取两个字面量，不是通用 eval）；探不到就返回 $null。
function Get-CdpPageProbe {
  param([int]$Port, [string]$Url)
  $cli = Join-Path $PSScriptRoot 'panels-refresh.mjs'
  if (-not (Test-Path -LiteralPath $cli)) { return $null }
  $m = ''
  try { $m = ([uri]$Url).Authority } catch { }
  if (-not $m) { return $null }
  try {
    $raw = & node $cli 'probe' '--port' ([string]$Port) '--match' $m 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { return $null }
    $line = ($raw.Trim() -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    if (-not $line) { return $null }
    $o = $line | ConvertFrom-Json
    if (-not $o.ok) { return $null }
    $hit = @($o.probed | Where-Object { $_.url -like "*$m*" }) | Select-Object -First 1
    if (-not $hit) { return $null }
    return $hit
  } catch { return $null }
}

function Wait-PanelArrival {
  param([string]$Url, [int]$Tries = 12, [int]$SleepMs = 500)
  $last = $null
  for ($i = 0; $i -lt [Math]::Max(1, $Tries); $i++) {
    $r = Test-CdpPageArrived -Port $CdpPort -Url $Url
    if ($r.Ok) { return $r }
    $last = $r
    # 一眼就知道**永远**不会到了：调试口本身就是死的 ⇒ 别白等（initiated 是终态）。
    if ("$($r.Why)" -like '*调试口*连不上*') { return $r }
    if ($i -lt $Tries - 1) { Start-Sleep -Milliseconds $SleepMs }
  }
  return $last
}

function Invoke-CdpReload {
  param([int]$Port, [string[]]$Match)
  $cli = Join-Path $PSScriptRoot 'panels-refresh.mjs'
  $cliArgs = @('reload', '--port', [string]$Port)
  foreach ($m in $Match) { $cliArgs += @('--match', $m) }
  try {
    $raw = & node $cli @cliArgs 2>&1 | Out-String
    $line = ($raw.Trim() -split "`r?`n" | Where-Object { $_.Trim().StartsWith('{') } | Select-Object -Last 1)
    $o = if ($line) { $line | ConvertFrom-Json } else { $null }
    return [pscustomobject]@{
      Code = $LASTEXITCODE; Ok = [bool]($o -and $o.ok)
      Reloaded = @(if ($o) { $o.reloaded }); Failed = @(if ($o) { $o.failed })
    }
  } catch { return [pscustomobject]@{ Code = -1; Ok = $false; Reloaded = @(); Failed = @() } }
}

# ── 常驻台账（2026-09-26）：记"我们什么时候开过哪几页"，**读不消费** ──────────────────────
# 为什么要有它：`panel-snapshot.json` 是"清场前拍一张、open 完就删"（一次性）。第二次 open 或下一次
# 启动就**没有任何证据**，而失联的旧标签在 socket 层又看不见 ⇒ 被判缺页 ⇒ **又开一张** —— 这正是主人
# 看到 "DSH ×2 + SnowLuma ×2" 的来源。台账活得久（默认 24 小时），但**只在"有浏览器在跑"时才算证据**
# （浏览器都没了，页面当然也没了）。
$LedgerFile = if ($LedgerFile) { $LedgerFile } else { Join-Path $BridgeDir 'state\panel-opened.json' }
$LedgerMaxAgeSec = 24 * 3600
# ── ★ 三态收据（2026-09-26）：`pages` 记的是"**我们什么时候开过**"，`states` 记的是
#   "**这一次开页动作到底成没成**"。两个键名都**一个字不改**（别的脚本/自检在读 pages），
#   只**新增** `states`。三态由开页处如实填（`initiated` / `arrived` / `failed`），
#   ⚠ **没验到就说没验到**：不许出现"没验到却写 arrived"（这正是老 bug 的病根）。
$PanelStates = @{}
function Set-PanelState {
  param([string]$Key, [string]$State, [string]$Why, [switch]$QuietOnConsole)
  if (-not $Key) { return }
  if (@('initiated', 'arrived', 'failed') -notcontains $State) { return }
  $entry = [ordered]@{ state = $State; at = (Get-Date).ToString('o'); why = "$Why" }
  $PanelStates[$Key] = $entry
  if (-not $QuietOnConsole) {
    $label = if ($PageLabels.ContainsKey($Key)) { $PageLabels[$Key] } else { $Key }
    $zh = switch ($State) { 'arrived' { '已到达' } 'initiated' { '已发起（**没验到到达**）' } default { '**失败**' } }
    Say "  [开页收据] $label ⇒ $zh：$Why"
  }
}
function Save-PanelLedger {
  param([string[]]$Keys)
  if (-not $Keys -or @($Keys).Count -eq 0) { return }
  try {
    $all = @{}
    if (Test-Path -LiteralPath $LedgerFile) {
      $o = (Get-Content -LiteralPath $LedgerFile -Raw -Encoding UTF8) | ConvertFrom-Json
      foreach ($p in $o.pages.PSObject.Properties) { $all[$p.Name] = [string]$p.Value }
    }
    foreach ($k in $Keys) { if ($SnapshotPages -contains $k) { $all[$k] = (Get-Date).ToString('o') } }
    # ★ 三态：**只写这一次动作涉及到的页**（不沿用上一次的旧状态 —— 陈旧的状态比没有状态更误导）。
    $st = [ordered]@{}
    foreach ($k in $Keys) { if ($PanelStates.ContainsKey($k)) { $st[$k] = $PanelStates[$k] } }
    $doc = [ordered]@{ updatedAt = (Get-Date).ToString('o'); pages = $all }
    if ($st.Count -gt 0) { $doc['states'] = $st }
    $doc | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $LedgerFile -Encoding UTF8
  } catch { Say "  [提示] 台账没写上（不影响开页）：$($_.Exception.Message)" }
}
function Read-PanelLedger {
  if (-not (Test-Path -LiteralPath $LedgerFile)) { return @{} }
  try {
    $o = (Get-Content -LiteralPath $LedgerFile -Raw -Encoding UTF8) | ConvertFrom-Json
    $open = @{}
    foreach ($p in $o.pages.PSObject.Properties) {
      if ($SnapshotPages -notcontains $p.Name) { continue }
      $age = [int]((Get-Date) - [datetime]::Parse([string]$p.Value)).TotalSeconds
      if ($age -lt -5 -or $age -gt $LedgerMaxAgeSec) { continue }
      $open[$p.Name] = "我们 $([int]($age / 60)) 分钟前开过它（台账），之后没见它关掉"
    }
    return $open
  } catch { return @{} }
}
function Remove-PanelLedger { Remove-Item -LiteralPath $LedgerFile -Force -ErrorAction SilentlyContinue }

function Resolve-Browser {
  if ($Browser) { if (Test-Path $Browser) { return $Browser } else { Say "  [警告] 指定的浏览器不存在：$Browser"; return $null } }
  if ($env:DSH_PANELS_BROWSER -and (Test-Path $env:DSH_PANELS_BROWSER)) { return $env:DSH_PANELS_BROWSER }
  foreach ($candidate in @(
      (Join-Path ${env:ProgramFiles} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
      (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'))) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }
  return $null
}

function Read-State {
  if (-not (Test-Path $StateFile)) { return $null }
  try { return (Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# 这个窗口看起来"被人当日常浏览器用了"吗？
# 2026-09-23 主人反馈："网站没有结束掉进程" —— 旧规则太保守：**我们自己那个面板窗口**开了三个
# 标签页时标题就是 "SnowLuma 控制台 和另外 2 个页面"，旧规则一看带"和另外/个页面"就判成
# "他的窗口、绝不关"，于是连自己的面板窗口也关不掉了 ✗。
# 新规则（主人选的方案 B：继续用他默认的浏览器，放宽判据）：
#   · 带"和另外 N 个页面"这种多标签标记 **且标题里一个我们的页面名都没有** → 才算他的窗口，不关；
#   · 只要标题里还有我们的页面名（QQ 桥接控制台 / SnowLuma 控制台 / DeepSeek Harness），
#     而且**句柄就是记录里那个**（说明这窗口是我们开的），就认它、照关。
#   残余风险（他知情并接受）：他自己的窗口如果正好停在这几个页面上、而记录又被搞错成那个窗口，
#   会被关掉 —— 所以下面两句仍然要求"先对句柄、再对标题"，两道都要过。
$UserWindowMarkers = @('和另外', '个页面')
function Test-LooksLikeUserWindow([string]$title) {
  $hasMultiTabMarker = $false
  foreach ($m in $UserWindowMarkers) { if ($title -like "*$m*") { $hasMultiTabMarker = $true; break } }
  if (-not $hasMultiTabMarker) { return $false }
  foreach ($t in $PanelTitles) { if ($title -like "*$t*") { return $false } }
  return $true
}

# 记下的那个面板窗口现在还活着、而且没被当日常窗口用吗？活着就返回它的句柄（复用），否则 $null
function Get-ReusablePanelWindow {
  $state = Read-State
  if (-not $state) { return $null }
  Initialize-Win32
  $hWnd = [System.IntPtr][int64]$state.hwnd
  if (-not $hWnd -or -not [W.Panels]::IsWindow($hWnd)) { return $null }
  $title = Get-WindowTitle $hWnd
  if (-not (Test-IsPanelTitle $title) -or -not (Test-IsBrowserWindow $hWnd)) { return $null }
  if (Test-LooksLikeUserWindow $title) { return $null }
  return [pscustomobject]@{ Handle = $hWnd; Title = $title; OwnerPid = $state.pid }
}

function Close-PanelWindow {
  $state = Read-State
  if (-not $state) { return @{ closed = $false; reason = '没有记录（还没开过面板）' } }
  Initialize-Win32
  $hWnd = [System.IntPtr][int64]$state.hwnd
  if (-not $hWnd -or -not [W.Panels]::IsWindow($hWnd)) {
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    return @{ closed = $false; reason = '那个窗口已经关了（或句柄失效）' }
  }
  $title = Get-WindowTitle $hWnd
  if (-not (Test-IsPanelTitle $title) -or -not (Test-IsBrowserWindow $hWnd)) {
    return @{ closed = $false; reason = "句柄现在指向的不是我们的面板窗口（标题：$title），没动它" }
  }
  if (Test-LooksLikeUserWindow $title) {
    # 他后来拿这个窗口上网了（标题里带了"和另外 N 个页面"）→ **绝不动它**，只把记录清掉
    Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
    return @{ closed = $false; reason = "那个窗口现在装着别的标签页（$title），没动它；下次会另开一个面板窗口" }
  }
  [void][W.Panels]::PostMessageW($hWnd, 0x0010, [System.IntPtr]::Zero, [System.IntPtr]::Zero)  # WM_CLOSE
  Start-Sleep -Milliseconds 1200
  if ([W.Panels]::IsWindow($hWnd)) { Stop-Process -Id $state.pid -Force -ErrorAction SilentlyContinue }
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
  return @{ closed = $true; reason = "已关掉面板窗口（$title）" }
}

# ── 令牌 / 地址 ───────────────────────────────────────────────────────────────
function Get-ConsoleToken {
  $p = Join-Path $BridgeDir 'state\console-token'
  if (Test-Path $p) { return (Get-Content -LiteralPath $p -Raw -ErrorAction Stop).Trim() }
  try {
    $cfg = Get-Content -LiteralPath (Join-Path $BridgeDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return ([string]$cfg.consoleToken).Trim()
  } catch { return '' }
}

function Get-DshToken {
  try {
    $cfg = Get-Content -LiteralPath (Join-Path $BridgeDir 'config.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    return ([string]$cfg.dsh.authToken).Trim()
  } catch { return '' }
}

function Get-SnowLumaUrl {
  # 端口只是"注入假设在听"的（离线夹具）⇒ 直接给裸地址：**不去叫 `snowluma-login.ps1`**
  # （不该为了跑一次夹具真去登录一回；那还会往检查器输出里塞几条假 ⚠）
  if ($AssumePorts -contains $SnowLumaWebPort) { return "http://127.0.0.1:$SnowLumaWebPort" }
  $loginScript = Join-Path $Root 'tools\snowluma-login.ps1'
  if (-not (Test-Path $loginScript)) {
    Say "  ⚠ 找不到 tools\snowluma-login.ps1 —— SnowLuma 管理页这次只能开**裸地址**（进去可能要手动登录）"
    return "http://127.0.0.1:$SnowLumaWebPort"
  }
  try {
    $out = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $loginScript -NoOpen 2>&1
    $m = [regex]::Match(($out -join "`n"), 'https?://[^\s"'']+')
    # ★ 2026-09-25（独立验收抓到）：判据不能只看"抓到一个 http 串"——**必须校验里面真有 token=**。
    #   原来只要正则命中就 return，于是"登录脚本没能换到令牌、却在报错文案里带了半个 URL"时会被当成有效地址
    #   ⇒ 静默开出一张没带令牌的登录页，谁都不知道。现在：**命中但没 token= 也要出声**，且如实说明退回了裸地址。
    if ($m.Success -and $m.Value -match '[?&]token=') { return $m.Value }
    if ($m.Success) {
      Say "  ⚠ SnowLuma 登录脚本没给出带令牌的地址（抓到的第一条 URL 里没有 token=：$($m.Value)）"
    } else {
      Say "  ⚠ SnowLuma 登录脚本没输出任何地址（多半是没存密码 / 401 / 要 TOTP）—— 原因见它自己的输出："
      foreach ($line in @($out | Select-Object -Last 3)) { Say "      $line" }
    }
  } catch {
    Say "  ⚠ SnowLuma 登录脚本执行失败：$($_.Exception.Message)"
  }
  Say "  → 本次退回裸地址 http://127.0.0.1:$SnowLumaWebPort （进去可能要手动登录一次）"
  return "http://127.0.0.1:$SnowLumaWebPort"
}

# ── snapshot：只记录、不开页（一键启动在"清场之前"调它）────────────────────────
if ($Action -eq 'snapshot') {
  # ★ 2026-09-25：这个局部变量**不能**叫 `$pages` —— PowerShell 变量名**大小写不敏感**，而本脚本的
  #   `-Pages` 参数就是 `[string[]]$Pages`（第 93 行）⇒ `$pages = <哈希表>` 会被**强制转成 string[]**，
  #   于是快照打印变成"一页都没开着"+"1 个不认识的键（不是字典：String[]）"，实际拿到的是**一条字符串**
  #   `System.Collections.Hashtable`（本次实测复现：类型 String[]、内容就这一条）。
  #   ⚠ 只有**这句话**在骗人：写进 state\panel-snapshot.json 的内容一直是对的（文件在 return 之前就写完了）。
  $snapNow = Save-PanelSnapshot
  $info = Get-PageNameList $snapNow
  if ($info.KeyCount -eq 0) {
    Say '  · 快照：现在一页都没开着（清场后照常开新的）'
  } else {
    Say "  · 快照：记下现在开着的 $($info.KeyCount) 页（$($info.Known -join '、')）—— 重启后这几页不再重复开"
  }
  # 认不得的键**如实说出来**（原来是直接拿它去查字典 ⇒ 红字；现在不炸，但也不许装正常）
  if ($info.Odd.Count -gt 0) {
    Say ("  [警告] 快照里有 $($info.Odd.Count) 个不认识的键（$($info.Odd -join '、')）—— 已忽略，但这是 bug 现场")
    # ★ 把**真实类型 + 实际内容**照实打出来（排查要证据，别只留一句"这是 bug 现场"）
    $ptype = if ($null -eq $snapNow) { 'NULL' } else { $snapNow.GetType().FullName }
    $psample = ''
    try { $psample = (@($snapNow | Select-Object -First 3) -join ' / ') } catch { $psample = "(取不出来：$($_.Exception.Message))" }
    Say ("         实际拿到 $ptype ：$psample")
  }
  exit 0
}

# ── selfcheck：**给回归测试用的**（tools\panels-check.ps1 调它）─────────────────
# 为什么要有：`snapshot` 那次红字的根因是"把不是字典的东西当字典用"，
# 而那种输入**只在特定机器/特定时刻才自然出现**（本次实测是 String[]）。回归测试不能靠"等它复现"，
# 所以这里把几种**恶意输入**固定下来，逐条走同一个渲染函数 + 同一条"没有页面"的分支：
#   · 含空键的字典（原来是它引爆的）      · 值不是字典（String[] / PSCustomObject / $null）
# 判据只有两条：① **不许抛/不许红字**；② **不许假装正常**（恶意输入必须能被说出来）。
if ($Action -eq 'selfcheck') {
  $fails = @()
  # ★ 恶意输入**直接传值**，不走 `$cases[$name]` 那种字典查找 —— 排查时实测到：
  #   在 `foreach ($name in $cases.Keys)` 里用 `$cases[$name]` 取出来的东西**被本文件的
  #   某个作用域污染过**（同一个键，直接写 `$cases['正常一页']` 是 Hashtable，经过循环变量
  #   取就变成一条 String[] —— 与 `Save-PanelSnapshot` 那次被污染是同一类现象）。
  #   回归测试不该把"被测对象"和"取参数的管道"绑在一起，所以这里一个一个字面量传进去。
  function Test-PageNameCase([string]$Label, $Value, [bool]$ExpectOdd) {
    $err = ''
    $info = $null
    try { $info = Get-PageNameList $Value } catch { $err = $_.Exception.Message }
    if ($err) { return [pscustomobject]@{ Ok = $false; Line = "$Label ：渲染时抛了（$err）" } }
    $known = @($info.Known); $odd = @($info.Odd); $count = $info.KeyCount
    if ($ExpectOdd -and $odd.Count -eq 0 -and $count -gt 0) {
      return [pscustomobject]@{ Ok = $false; Line = "$Label ：没炸，却把脏输入当成了正常页（假装正常）" }
    }
    if ($ExpectOdd -and $odd.Count -eq 0) {
      return [pscustomobject]@{ Ok = $false; Line = "$Label ：没炸，但一个字都没报出来（脏输入被静默吞掉）" }
    }
    if (-not $ExpectOdd -and $known.Count -eq 0) {
      return [pscustomobject]@{ Ok = $false; Line = "$Label ：正常输入反而没被认出来" }
    }
    return [pscustomobject]@{ Ok = $true; Line = "$Label ：没炸；认得 [$($known -join '、')]；报出 [$($odd -join '、')]" }
  }
  $checks = @(
    (Test-PageNameCase '正常一页' @{ console = '心跳 3 秒前' } $false),
    (Test-PageNameCase '含空键' @{ '' = '坏键'; dsh = '窗口标题' } $true),
    # 模拟 null 键：PS 的哈希表/泛型字典**都不允许** null 键（一写就抛同一个红字，
    # 我第一版 selfcheck 就是这么把自己炸掉的）⇒ 只能拿"带 Keys 属性的对象"模拟；
    # 渲染函数只读 `.Keys`，所以这一档与"字典里真有 null 键"等价。
    (Test-PageNameCase '模拟 null 键' ([pscustomobject]@{ Keys = @($null, 'dsh') }) $true),
    (Test-PageNameCase 'String[]（本次实测）' @('System.Collections.Hashtable') $true),
    (Test-PageNameCase 'PSCustomObject' ([pscustomobject]@{ dsh = '窗口标题' }) $true),
    (Test-PageNameCase 'null' $null $true)
  )
  foreach ($c in $checks) {
    if ($c.Ok) { Say "  ✓ $($c.Line)" } else { $fails += $c.Line; Say "  ✗ $($c.Line)" }
  }
  # 防止"把什么都报成脏键"这种假修复
  $ok = Get-PageNameList @{ dsh = 'x'; console = 'y'; snowluma = 'z' }
  if ($ok.Known.Count -eq 3 -and $ok.Odd.Count -eq 0) { Say '  ✓ 三页齐全时三个都认得（没把正常值误报成脏键）' }
  else { $fails += '正常三页没被认全'; Say "  ✗ 正常三页没被认全（认到 $($ok.Known.Count) 个）" }

  # ── ⑵ 逐页判定（2026-09-25 深夜加）：拿**假 netstat / 假心跳**驱动唯一那份判据 ───────────────
  # 为什么不真开浏览器：主人正在用，一根手指都不碰。判据是**纯函数**（Get-PanelVerdicts -Offline：
  # 注进去什么就判什么）—— 于是"页面开着 ⇒ 不开新页"这件事是**可证**的，不是嘴上说的。
  # 每条都配反例，防恒真/恒假：② 是 ① 的反例（全开 ↔ 全不开），④ 是 ③ 的反例（判不准 ≠ 已开），
  # ⑤ 是"控制台这条路仍然活着"的灵敏度对照（否则"跳过控制台"可能只是判据坏了）。
  Say ''
  Say '  ── 逐页判定（假 netstat 驱动；真去开浏览器是禁止的）'
  $now = Get-Date
  $beatFresh = (@{ console = $now.AddSeconds(-5).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)
  $beatStale = (@{ console = $now.AddSeconds(-900).ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress)
  $lsOld = $now.AddMinutes(-30)     # 桥接一直在跑（1800 秒）
  $lsNew = $now.AddSeconds(-5)      # 桥接 5 秒前刚重启
  # 假 netstat（**照抄真机 2026-09-25 实测的格式**：loopback 两行、最后一列是 PID）：
  #   端口全部用变量拼（**不写死数字**：self-check 的"硬编码端口"检查会抓）；本地随机端口照抄实测值。
  #   msedge pid=15124 是浏览器；:$DsPort 上还有桥接自己（node pid=13468）的连接 —— 那一行不算"浏览器开着"。
  $netAll = @(
    "  TCP    127.0.0.1:4036         127.0.0.1:$DsPort         ESTABLISHED     15124",
    "  TCP    127.0.0.1:$DsPort         127.0.0.1:4036         ESTABLISHED     13468",
    "  TCP    127.0.0.1:10491        127.0.0.1:$ControlPort         ESTABLISHED     15124",
    "  TCP    127.0.0.1:5646         127.0.0.1:$SnowLumaWebPort         ESTABLISHED     15124",
    "  TCP    127.0.0.1:$BridgePort         0.0.0.0:0              LISTENING       3032",
    "  TCP    127.0.0.1:$BridgePort         127.0.0.1:1770         TIME_WAIT       0"
  )
  $netIdle = @(
    "  TCP    127.0.0.1:$BridgePort         0.0.0.0:0              LISTENING       3032"
  )
  # 判据本身的可信度：只认"远端端口 = 我们端口"且**进程名是浏览器**的那一行
  $cp = @(Get-PortClientPids -Lines $netAll -Port $DsPort)
  $nodeRows = @(Get-PortClientPids -Lines $netAll -Port $DsPort | Where-Object { $_ -eq 13468 })
  if ($cp.Count -eq 1 -and $cp[0] -eq 15124 -and $nodeRows.Count -eq 0) {
    Say "  ✓ 假 netstat 只认出浏览器那一行（:$DsPort → pid 15124）；桥接自己（node pid 13468）没被算成浏览器"
  } else {
    $fails += 'netstat 解析没按预期只认浏览器那一行'
    Say "  ✗ netstat 解析不对：:$DsPort 认到 [$($cp -join ',')]（应当只有 15124）"
  }
  function Test-PageDecision([string]$Label, $Verdict, [string[]]$ExpectOpen, [string[]]$ExpectSkip, [string[]]$ExpectUnsure) {
    $want = @('dsh', 'console', 'snowluma')
    $d = Resolve-PagesToOpen -Verdict $Verdict -Want $want -Force @() -Snapshot @{}
    $gOpen = (@($d.Open) | Sort-Object) -join ','
    $gSkip = (@($d.Skip) | Sort-Object) -join ','
    $gUn = (@($d.Unsure) | Sort-Object) -join ','
    $wOpen = (@($ExpectOpen) | Sort-Object) -join ','
    $wSkip = (@($ExpectSkip) | Sort-Object) -join ','
    $wUn = (@($ExpectUnsure) | Sort-Object) -join ','
    $line = "$Label ：要开 [$gOpen]｜跳过 [$gSkip]｜判不准 [$gUn]"
    if ($gOpen -eq $wOpen -and $gSkip -eq $wSkip -and $gUn -eq $wUn) { return [pscustomobject]@{ Ok = $true; Line = $line } }
    return [pscustomobject]@{ Ok = $false; Line = "$line（期望 要开 [$wOpen]｜跳过 [$wSkip]｜判不准 [$wUn]）" }
  }
  $vAll = Get-PanelVerdicts -Offline -NetstatLines $netAll -BrowserPids @(15124) -PresenceText $beatFresh -ListenStart $lsOld -WindowTitles @() -Now $now
  $vNone = Get-PanelVerdicts -Offline -NetstatLines $netIdle -BrowserPids @() -PresenceText $beatFresh -ListenStart $lsOld -WindowTitles @() -Now $now
  $vConsoleOnly = Get-PanelVerdicts -Offline -NetstatLines $netIdle -BrowserPids @(15124) -PresenceText $beatFresh -ListenStart $lsOld -WindowTitles @() -Now $now
  $vUnsure = Get-PanelVerdicts -Offline -NetstatLines $netIdle -BrowserPids @(15124) -PresenceText $beatStale -ListenStart $lsNew -WindowTitles @() -Now $now
  $vConsoleGone = Get-PanelVerdicts -Offline -NetstatLines $netIdle -BrowserPids @(15124) -PresenceText $beatStale -ListenStart $lsOld -WindowTitles @() -Now $now
  $checks2 = @(
    (Test-PageDecision '① 三页都实测开着 ⇒ 一个都不开（即"不调 Start-Process"）' $vAll @() @('dsh', 'console', 'snowluma') @()),
    (Test-PageDecision '② 反例：一个浏览器进程都没有 ⇒ 三页都可证不在、三页全开' $vNone @('dsh', 'console', 'snowluma') @() @()),
    (Test-PageDecision '③ 组合：只有控制台在（另两张缺）⇒ 只开 dsh 与 snowluma' $vConsoleOnly @('dsh', 'snowluma') @('console') @()),
    (Test-PageDecision '④ 反例：心跳过期 + 桥接刚重启（说不清）⇒ 判不准、不开' $vUnsure @('dsh', 'snowluma') @() @('console')),
    (Test-PageDecision '⑤ 灵敏度：桥接一直在跑而心跳全无 ⇒ 控制台确实缺 ⇒ 开' $vConsoleGone @('dsh', 'console', 'snowluma') @() @())
  )
  foreach ($c in $checks2) {
    if ($c.Ok) { Say "  ✓ $($c.Line)" } else { $fails += $c.Line; Say "  ✗ $($c.Line)" }
  }
  # 判据不许"永远说开着/永远说没开"：同一份代码对两种输入必须给出不同答案
  if ([string]$vAll['dsh'].State -eq 'open' -and [string]$vNone['dsh'].State -eq 'absent') {
    Say '  ✓ 判据三态真的会变（实测有连接 → open；无浏览器进程 → absent）—— 不是恒真/恒假'
  } else {
    $fails += '判据疑似恒真或恒假'
    Say '  ✗ 判据在同一份代码里既不肯说 open 也不肯说 absent（恒真/恒假）'
  }
  Say ''
  if ($fails.Count -eq 0) { Say 'selfcheck：全过（恶意输入不炸、且都被如实报出来）'; exit 0 }
  foreach ($f in $fails) { Say "  ✗ $f" }
  Say "selfcheck：$($fails.Count) 条失败"
  exit 1
}

if ($Action -eq 'close') {
  $r = Close-PanelWindow
  Say $r.reason
  exit 0
}

if ($Action -eq 'status') {
  $state = Read-State
  if (-not $state) { Say '  · 没有记录（还没开过面板）' }
  else {
    Initialize-Win32
    $hWnd = [System.IntPtr][int64]$state.hwnd
    if ([W.Panels]::IsWindow($hWnd)) { Say "  · 面板窗口还在：$((Get-WindowTitle $hWnd))（hwnd=$($state.hwnd)）" }
    else { Say "  · 记下的面板窗口已经不在了（hwnd=$($state.hwnd)）" }
  }
  foreach ($win in Get-TopLevelWindows) {
    if (Test-IsPanelTitle $win.Title) {
      $kind = if (Test-LooksLikeUserWindow $win.Title) { '你自己的浏览器窗口（不会被动）' } else { '面板窗口' }
      Say "  · 含面板标题的窗口：$($win.Title)（pid=$($win.OwnerPid)，判定为$kind）"
    }
  }
  exit 0
}

# ── wake：把已有窗口叫到前台（**只叫前台，不开页、不关窗**；见文件头"wake 的能力边界"）────
if ($Action -eq 'wake') {
  Initialize-Win32
  Initialize-ForeWin32
  # ① 优先 -OwnWindow 记过句柄的那个面板窗口（判据是"窗口还在不在"，跟 Edge 休眠无关）
  $reusable = Get-ReusablePanelWindow
  if ($reusable) {
    $ok = [W.Fore]::SetForegroundWindow($reusable.Handle)
    if ($ok) { Say "  已把面板窗口叫到前台：$($reusable.Title)" }
    else { Say "  [提示] 面板窗口「$($reusable.Title)」还在，但 Windows 不让后台进程抢前台 —— 点一下任务栏里那个窗口就行。" }
    exit 0
  }
  # ② 否则把他的浏览器窗口整个叫到前台（标题里带我们的页面名的那种）
  foreach ($win in Get-TopLevelWindows) {
    if (-not (Test-IsPanelTitle $win.Title)) { continue }
    if (-not (Test-IsBrowserWindow $win.Handle)) { continue }
    $ok = [W.Fore]::SetForegroundWindow($win.Handle)
    if ($ok) { Say "  已把浏览器窗口叫到前台：$($win.Title)" }
    else { Say "  [提示] 找到浏览器窗口「$($win.Title)」，但 Windows 不让后台进程抢前台 —— 点一下任务栏就行。" }
    Say '  [说明] 只能叫到窗口这一层，具体哪个标签要你自己点 —— 浏览器不给外部脚本切标签的 API。'
    exit 0
  }
  Say '  [提示] 没有能叫到前台的面板窗口（没开过 -OwnWindow，也没有含我们页面名的浏览器窗口）。'
  Say '         要开页面：tools\panels.ps1 open -Pages dsh,console,snowluma'
  exit 0
}

# ── -Pages none：一个页面都不开（主人 2026-09-24 要的"挂机模式"；与启动器的 -NoOpen 同一语义）
#    ★ 注意这不是"跳过重复的"，而是"这次什么都不开"：
#      · 不做任何检测、不消费清场前的快照（那份快照留给**下一次真正的 open** 去重，见文件头第 5 条坑）；
#      · 所以"不用 web 的人"可以明确说 -Pages none，而不用担心被开一堆标签页。
if ($wantPages.Count -eq 0) {
  Say '  -Pages none：这次一个页面都不开（挂机模式）。'
  Say "  要开页面时：panels.ps1 open（默认 = $DefaultPages）｜ panels.ps1 open -Pages dsh（只要 DSH 一页）"
  exit 0
}

# ── open ─────────────────────────────────────────────────────────────────────
# ★ 三态收据的**写盘点**（2026-09-26）：挪到"开页动作做完之后"—— 三个出口（默认浏览器回退 /
#   -OwnWindow / 默认路径）各自在收尾时 Save-PanelLedger 一次，**包括失败退出前那次**：
#   失败也要留收据（`failed`），否则"没开成"又变成无痕（老 bug 的另一半）。
# ★★ 闸：**无条件**禁止"把开页请求交给系统/真浏览器"（2026-09-26 协调线把语义改死）。
#   之前那版是错的（我写错、协调线抓出来的）：`-FakeBrowser` 只在"**找不到浏览器**"时才生效
#   ⇒ 本机有 Edge 时**照样真开页**（实测：自测那一跑 `panels.log` 里出现了 `已把 1 个页面开进…`，
#   而同一跑我还传了 `-FakeBrowser`）。现在：**闸一开，开页动作一次都不许走系统那条路** ——
#   有浏览器也不许用它；并且**出声**说明被闸住（日志要能一眼看到，且**不再出现**"已把 N 个页面开进…"）。
$gateTripped = $false
if ($NoOpenFallback -and -not $PanelGateShortCircuit) {
  $gateTripped = $true
  Say '  [闸住] -NoSystemOpen（旧名 -NoOpenFallback）：**这次不会把任何开页请求交给系统/真浏览器**'
  Say '         （夹具/自测专用：证明"这一跑没有能力碰真浏览器"；要真开页就别带这个闸）'
  if ($FakeBrowser) { Say "  [注入·夹具专用] 另注入了浏览器替身：$FakeBrowser（本条只记账，闸住时不再使用）" }
}
$browser = if ($gateTripped) {
  $null
} elseif ($FakeBrowser -eq 'none') {
  Say '  [注入·夹具专用] 浏览器可执行文件被注入成"**找不到**"（哨兵 none）：用来验回退闸'
  $null
} elseif ($FakeBrowser) {
  Say "  [注入·夹具专用] 浏览器可执行文件被替身接管：$FakeBrowser（**这一跑不会起真浏览器**）"
  $FakeBrowser
} else { Resolve-Browser }
if (-not $browser) {
  if ($gateTripped) {
    # 闸住 = **失败态**（不是静默跳过、也不是"没找到浏览器"那种退化）：出声 ＋ 记账 ＋ 非 0 退出。
    $fb = [ordered]@{ dsh = "http://127.0.0.1:$DsPort"; console = "http://127.0.0.1:$BridgePort"; snowluma = (Get-SnowLumaUrl) }
    foreach ($k in @('dsh', 'console', 'snowluma')) {
      if (-not $wantPages.Contains($k)) { continue }
      Set-PanelState -Key $k -State 'failed' -Why '开页被 -NoSystemOpen / -NoOpenFallback 闸住：不许交给系统或真浏览器'
    }
    Save-PanelLedger -Keys (@($fb.Keys | Where-Object { $wantPages.Contains($_) }))
    Say '  [结论] 开页动作被闸住 ⇒ 这次**没有任何页面被打开**（按失败记；摘掉闸才能真开）'
    exit 1
  }
  Say '  [提示] 没找到 Edge/Chrome：退化成用默认浏览器打开（那样就没法自动关，重启后会叠标签页）'
  if (-not $DryRun) {
    $fb = [ordered]@{ dsh = "http://127.0.0.1:$DsPort"; console = "http://127.0.0.1:$BridgePort"; snowluma = (Get-SnowLumaUrl) }
    foreach ($k in @('dsh', 'console', 'snowluma')) {
      if (-not $wantPages.Contains($k)) { continue }
      try {
        Start-Process -FilePath $fb[$k] -ErrorAction Stop | Out-Null
        # 默认浏览器这条路**没有**调试口 ⇒ 我们**验不到**到达（不许猜成 arrived）。
        Set-PanelState -Key $k -State 'initiated' -Why '已交给默认浏览器，没有调试口 ⇒ **无法确认到达**'
      } catch {
        Set-PanelState -Key $k -State 'failed' -Why "交给默认浏览器时抛错：$($_.Exception.Message)"
      }
    }
    Save-PanelLedger -Keys (@($fb.Keys | Where-Object { $wantPages.Contains($_) }))
  } else {
    Say "  [DryRun] 没找到 Edge/Chrome，真跑时会用默认浏览器开这些页：$((Get-PageNameList $wantPages).Known -join '、')"
  }
  exit 0
}

# 复用/作废旧记录这条路只属于 -OwnWindow（默认那条"开进他自己正在用的窗口"不记句柄、也不碰记录）。
if ($OwnWindow -and -not $NoClose -and -not $DryRun) {
  # 先看上一轮那个窗口还在不在：**在就复用**（把它叫到前台，不关也不新开）——
  # 复用比"关了再开"更稳：既不会误关他后来拿去上网的那个窗口，也少一次开窗动作。
  # 只有"记录失效 / 那个窗口已经关了 / 它被当日常窗口用了"才走后面"另开一个"的路。
  $reusable = Get-ReusablePanelWindow
  if ($reusable) {
    Say "  复用上一轮的面板窗口：$($reusable.Title)"
    try {
      Add-Type -Namespace W -Name Fore -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);' -ErrorAction SilentlyContinue
      [void][W.Fore]::SetForegroundWindow($reusable.Handle)
    } catch {}
    exit 0
  }
  # 记录不可复用（窗口关了 / 句柄失效 / 它被当日常窗口用了）→ **只把记录作废，不关任何窗口**，
  # 然后另开一个。自动关窗这条路彻底去掉了：观感上最多多一个窗口，但绝不会误关他正在用的浏览器
  # （要关请显式跑 `panels.ps1 close`，那条路有三道护栏）。
  if (Read-State) { Say '  上一轮的面板窗口已不可复用（关了或已作它用）→ 作废记录，另开一个' }
  Remove-Item -LiteralPath $StateFile -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 300
}

# 地址：**这次开哪几页由调用方说了算**（-Pages；不传=三页都要，-DshOnly = -Pages dsh 的旧写法）。
# 每一页先问一句"是不是已经开着了"—— 已经在的**不重复开**，只补缺的那几页
# （主人 2026-09-23："不要让两个相同的网站运行" + "qq桥接的网站没打开"）。
$candidates = [ordered]@{}
# 页名渲染走**唯一那一份**（null 安全；认不得的键会被报出来，见 Get-PageNameList）
$wantInfo = Get-PageNameList $wantPages
$wantLabels = $wantInfo.Known -join '、'
if ($wantInfo.Odd.Count -gt 0) { Say ("  [警告] -Pages 里有不认识的页（$($wantInfo.Odd -join '、')）—— 已忽略") }
Say "  这次要开：$wantLabels"
# ★ 打一行"注入生效"的自证（只有检查器传了才出现）：夹具靠它证明**注入值真到了**、且是白名单语义 ——
#   `-File` 传进来的逗号串若没被绑成 int[]，这一行就会少端口，检查器当场判红（不靠"应该能绑上"）。
if ($AssumePorts.Count -gt 0) {
  Say ("  [注入·检查器专用] 端口判定被夹具接管：**只有** {0} 算在听（其余一律当作没在听）" -f (($AssumePorts | ForEach-Object { ":$($_)" }) -join ' '))
}
if ($wantPages.Contains('dsh')) {
  if (Test-Port-Local $DsPort) {
    $u = "http://127.0.0.1:$DsPort/"
    $dshToken = Get-DshToken
    if ($dshToken) { $u += "?token=$([uri]::EscapeDataString($dshToken))" }
    $candidates['dsh'] = $u
  } else { Say "  [跳过] DSH 没在 $DsPort 上监听" }
}
if ($wantPages.Contains('console')) {
  if (Test-Port-Local $BridgePort) {
    $u = "http://127.0.0.1:$BridgePort/"
    $consoleToken = Get-ConsoleToken
    if ($consoleToken) { $u += "?token=$([uri]::EscapeDataString($consoleToken))" }
    $candidates['console'] = $u
  } else { Say "  [跳过] 桥接控制台没在 $BridgePort 上监听" }
}
if ($wantPages.Contains('snowluma')) {
  if (Test-Port-Local $SnowLumaWebPort) { $candidates['snowluma'] = (Get-SnowLumaUrl) }
  else { Say "  [跳过] SnowLuma 管理页没在 $SnowLumaWebPort 上监听" }
}

# "已经开着"= **实测判据 ∪ 清场前的快照**：清场会把 DSH/桥接杀掉，那之后 socket 层就测不出旧标签了，
# 快照补的正是这段空档（见文件头第 5 条坑，也见 Get-PanelVerdicts 里写明的两个已知盲区）。
# -Force = 两个都不看，照开一份。
# ★ 2026-09-25 深夜（主人："网站页面多开了三个"）：判定改成**三态 + 宁可不开**，判据全部走
#   Get-PanelVerdicts（唯一一份，含实测的 netstat ESTABLISHED / 心跳 / 桥接进程启动时间 / 浏览器进程）。
#   不再有任何"靠猜/靠记账"的信号；**说不清的那一页宁可这次不开**（并把地址打出来让他自己点）。
$verdicts = @{}
$snapPages = @{}
$ledgerPages = @{}
$needRefresh = @()
$refreshed = @()
$unsureLabels = @()
# ── ★ 五步流程（主人 2026-09-26 早上亲口给的顺序）────────────────────────────────────────
#   ① 检查无浏览器运行 → ② 打开浏览器 → ③ 检查是否存在页面 → ④ 打开不存在的页面 → ⑤ 刷新一下重置页面
# 判"存在"的**最优证据 = CDP 的 /json/list**（挂起/失联的旧标签也列得出来）；没有调试口时才退回
# socket 层三态判据 + 清场前快照 + **常驻台账**（后两者都是"记账"，只在"有浏览器在跑"时算数）。
$browserPids = if ($AssumeBrowserPids.Count -gt 0) { @($AssumeBrowserPids) } else { @(Get-BrowserPids) }
$browserRunning = (@($browserPids).Count -gt 0)
$cdp = $null
if ($CdpMode -ne 'off' -and -not $Force) { $cdp = Get-CdpTargets -Port $CdpPort }
if ($Force) {
  Say '  [计划] -Force：已经有挂着的也照开一份（不看去重信号）'
} elseif (-not $browserRunning) {
  Say '  [计划] ① 现在**一个浏览器进程都没有** ⇒ ② 先把浏览器起起来，再把要的页面开进去'
} elseif ($cdp) {
  Say ("  [计划] ③ 有浏览器在跑，调试口 :{0} 也在听 ⇒ 用它的**权威标签页清单**判'这一页存不存在'（{1} 个标签）" -f $CdpPort, $cdp.count)
} else {
  Say ("  [计划] ③ 有浏览器在跑，但没有调试口 :{0} ⇒ 退回 socket 层判据 + 清场前快照 + 常驻台账" -f $CdpPort)
}
if (-not $Force) {
  $verdicts = Get-PanelVerdicts
  $snapPages = Read-PanelSnapshot
  if ($browserRunning) { $ledgerPages = Read-PanelLedger }   # 浏览器都没了 ⇒ 台账不算证据（页面当然也没了）
}
# ★ 要不要开 = **唯一一份**判定（Resolve-PagesToOpen）：
#   -ForcePage 点名 > 快照（清场前实测开着）> unknown（判不准 ⇒ 不开）> open（实测开着 ⇒ 不开）> absent ⇒ 开
$decision = Resolve-PagesToOpen -Verdict $verdicts -Want @($candidates.Keys) -Force @($forcePages.Keys) -Snapshot $snapPages
$presentKeys = @()
$openedKeys = @()

$urls = @()
foreach ($k in $candidates.Keys) {
  # ① -ForcePage 点名的页面：**必须重开**，不看去重信号（调用方明确知道它的登录态已经过期）。
  if ($decision.Open -contains $k -and $forcePages.ContainsKey($k)) {
    Say "  [重开] $($PageLabels[$k])：调用方用 -ForcePage 指名这一页必须重开"
    $urls += $candidates[$k]
    # ★ 2026-09-26（自测抓到的真 bug）：这条分支原来**不填 `$openedKeys`** ⇒ 走 -ForcePage 时
    #   到达验收与三态收据**一次都不执行**（"我们真开了它"这件事在收据里根本不存在）。
    #   它是"这次动作真开出去的页"，和下面 ④ 分支同一语义 ⇒ 一起记账。
    $openedKeys += $k
    continue
  }
  # ①.5 ★ CDP 权威清单（五步的 ③）：按"这一页的端口"认（令牌每次都可能变，别拿整条 URL 比）
  if ($cdp) {
    $portOfPage = 0
    try { $portOfPage = ([uri]$candidates[$k]).Port } catch { }
    $hit = @($cdp.targets | Where-Object { $_.url -match (":$portOfPage(?:/|$)") })
    if ($hit.Count -gt 0) {
      # ⑤ 存在 ⇒ **刷新一下重置页面**（顺带把令牌过期的旧标签救回来 —— 以前靠 -ForcePage 重开一张）
      $presentKeys += $k
      if ($DryRun) {
        Say ("  [刷新·DryRun] ⑤ {0} 已经开着（{1}）⇒ 会刷新它一次（不发新标签页）" -f $PageLabels[$k], $hit[0].url)
      } else {
        $r = Invoke-CdpReload -Port $CdpPort -Match (":$portOfPage")
        if ($r.Reloaded.Count -gt 0) {
          Say ("  [刷新] ⑤ {0} 已经开着 ⇒ 已刷新一次（Page.reload，重置这个标签页）" -f $PageLabels[$k])
          $refreshed += $PageLabels[$k]
        } else {
          Say ("  [刷新失败] {0} 在清单里，但刷新没成功（{1}）—— 没假装刷过，请手动 F5" -f $PageLabels[$k], ($r.Failed | ConvertTo-Json -Compress))
        }
      }
      continue
    }
    # ④ 清单里没有 ⇒ 真缺页 ⇒ 开一份
    Say "  [开] ④ $($PageLabels[$k]) 不在标签页清单里（真缺页）⇒ 开一份"
    $urls += $candidates[$k]
    $openedKeys += $k
    continue
  }
  # ② 实测到还活着（或清场前的快照 / 常驻台账记着它）⇒ 跳过，不重复开。
  if ($decision.Skip -contains $k -or $ledgerPages.ContainsKey($k)) {
    $why = ''
    if ($verdicts.ContainsKey($k) -and [string]$verdicts[$k].State -eq 'open') { $why = [string]$verdicts[$k].Reason }
    elseif ($snapPages.ContainsKey($k)) { $why = [string]$snapPages[$k] }
    elseif ($ledgerPages.ContainsKey($k)) { $why = [string]$ledgerPages[$k] }
    Say "  [跳过] $($PageLabels[$k]) 已经开着了（$why）—— 不重复开"
    $presentKeys += $k
    if (-not ($verdicts.ContainsKey($k) -and [string]$verdicts[$k].State -eq 'open')) { $needRefresh += $PageLabels[$k] }
    continue
  }
  # ③ 判不准 ⇒ **宁可不开**（主人原话）。地址照样打出来，他想开自己点，或用 -ForcePage 点名重开。
  if ($decision.Unsure -contains $k) {
    $why = ''
    if ($verdicts.ContainsKey($k)) { $why = [string]$verdicts[$k].Reason }
    Say "  [不开] $($PageLabels[$k]) **判不准**（$why）—— 按'宁可不开'处理，不重复开"
    $unsureLabels += $PageLabels[$k]
    continue
  }
  $urls += $candidates[$k]
}

# 只有快照/台账说"开着"、而 socket 层看不到的页面：标签页还在、服务刚重启过，它自己连不回去。
# ★ 2026-09-26：这条从"提示他按 F5"升级成"能刷就真刷"（CDP 那条路在循环里已经刷了）；刷不了才退回这句话。
if ($needRefresh.Count -gt 0) {
  Say "  [提示] $($needRefresh -join '、') 用的是重启前那个标签页（没再开新的）：切过去按一下 F5 就能连上。"
  Say '         （想让它们原地重置：把浏览器用调试口起一次 —— panels.ps1 open -CdpMode on，之后就能自动刷新）'
}
if ($refreshed.Count -gt 0) { Say "  [小结] ⑤ 已原地刷新（重置）：$($refreshed -join '、')" }

if ($urls.Count -eq 0) {
  if ($unsureLabels.Count -gt 0) {
    # 不许把"判不准所以没开"说成"都已经开着"（项目最忌说的和做的不一致）
    Say "  [结论] 有 $($unsureLabels.Count) 页**判不准**（$($unsureLabels -join '、')）—— 按'宁可不开'这次都没开。"
    Say '         确认缺页就显式开：tools\panels.ps1 open -ForcePage <dsh|console|snowluma>（或 -Force 全开一份）'
  } else {
    Say '  [结论] 要开的页面都已经开着，这次什么都不用开。'
    Say '         想让某一页重开：加 -ForcePage <dsh|console|snowluma>（不必先 Ctrl+W）；想全开一份：-Force'
  }
  Say '         当前地址（需要时手动打开；带令牌）：'
  foreach ($k in $candidates.Keys) { Say "           - $($candidates[$k])" }
  if (-not $DryRun) {
    Remove-PanelSnapshot
    Save-PanelLedger -Keys $presentKeys   # ⑤ 确认还开着的页 ⇒ 台账刷新一下时间戳（下次不重复开）
  }
  exit 0
}

$masked = $urls | ForEach-Object { $_ -replace '([?&])token=[^&]*', '$1token=***' }

if ($DryRun) {
  if ($OwnWindow) { Say "  [DryRun] 会用 $browser 另开一个窗口，里面是这些标签页（关闭全部时会一起收掉；令牌已打码）：" }
  else { Say "  [DryRun] 会用 $browser 把页面开进你正在用的那个窗口的新标签页（令牌已打码）：" }
  $masked | ForEach-Object { Say "    - $_" }
  exit 0
}

# 快照用完即删（-DryRun 上面已经退了，不删）：它是"清场前那一张"的一次性证据；长期记忆由台账承担。
Remove-PanelSnapshot
# 台账由三个开页出口各自 Save（见 open 段开头那段注释）—— 这里不再提前写：
#   ★ 提前写的后果就是"页面还没到、收据已经记成开过"（老 bug 的写法），所以写盘点必须**在开页动作之后**。

# ── -OwnWindow（可选）：另开"我们自己的一个窗口" + 记句柄，"关闭全部"时收得掉 ──────────
# ★ -CdpMode on ⇒ 起浏览器时带上调试口（"刷新一下重置页面"那一步靠它；旗子加不加由协调线拍）。
$cdpArgs = if ($CdpMode -eq 'on') { @("--remote-debugging-port=$CdpPort") } else { @() }
if ($OwnWindow) {
  $before = @(Get-TopLevelWindows | ForEach-Object { $_.Handle })
  # **一次启动传多个 URL** = 同一个窗口里的多个标签页
  $browserArgs = @('--new-window', '--no-first-run', '--no-default-browser-check') + $cdpArgs + $urls
  try {
    Start-Process -FilePath $browser -ArgumentList $browserArgs -ErrorAction Stop | Out-Null
    Say "  已请求另开一个窗口，里面放 $($urls.Count) 个标签页"
  } catch {
    # ★ 失败**必须出声**（不许再吞）＋ 记账写失败态：主人 18:59 那次就是"哄好了调用方，页面没事"。
    Say "  [失败] 起 $browser 时抛错，**一个页面都没开**：$($_.Exception.Message)"
    foreach ($k in @($openedKeys)) { Set-PanelState -Key $k -State 'failed' -Why "起浏览器抛错：$($_.Exception.Message)" }
    Save-PanelLedger -Keys (@($presentKeys) + @($openedKeys))
    exit 1
  }
  # 到达验收：标签页清单里**真有**我们开的这几页才算 arrived（没验到就如实说没验到）
  foreach ($k in @($openedKeys)) {
    $r = Wait-PanelArrival -Url $candidates[$k]
    if ($r.Ok) { Set-PanelState -Key $k -State 'arrived' -Why $r.Why }
    else { Set-PanelState -Key $k -State 'initiated' -Why $r.Why }
  }
  Save-PanelLedger -Keys (@($presentKeys) + @($openedKeys))
  $win = Find-NewPanelWindow -beforeHandles $before -timeoutMs 15000
  if (-not $win) {
    Say '  [提示] 15 秒内没抓到新窗口的句柄：下次可能关不掉它（可手动关一次，或重跑一次 open）'
    # 句柄抓不到 = 这轮**确认失败**（页面到底到没到另说，至少"我们收不掉它"是事实）⇒ 收据如实写。
    foreach ($k in @($openedKeys)) {
      if (-not $PanelStates.ContainsKey($k)) { Set-PanelState -Key $k -State 'failed' -Why '起了浏览器但 15 秒内没抓到窗口句柄' }
    }
    Save-PanelLedger -Keys (@($presentKeys) + @($openedKeys))
    exit 1
  }
  $state = [pscustomobject]@{
    openedAt = (Get-Date).ToString('o')
    browser  = $browser
    hwnd     = [int64]$win.Handle
    pid      = $win.OwnerPid
    title    = $win.Title
    urls     = $masked
  }
  $state | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $StateFile -Encoding UTF8
  Say "  面板窗口就绪：$($win.Title)（hwnd=$($win.Handle)）；关闭全部时会按句柄收掉它"
  exit 0
}

# ── 默认路径（第六版起）：开进"你正在用的那个浏览器窗口"的新标签页 ────────────────────
# 不加 --new-window → Chromium 把 URL 塞进**最近活动的那个窗口**（= 他正在用的那个），
# 不新开窗口 —— 这正是主人要的（原话："我想要她出现在我正在开着的浏览器上"）。
# 代价（老实说）：这些标签页**我们关不掉**（浏览器不允许脚本关别人的标签页）；不过配合上面
# 那条"已经挂着就不重复开"，它们不会越堆越多；DSH 停掉后标签会失效，Ctrl+W 关掉即可。
# 想要"关闭全部时能一起收掉的独立窗口"就用 -OwnWindow。
$browserArgs = @('--no-first-run', '--no-default-browser-check') + $cdpArgs + $urls
try {
  Start-Process -FilePath $browser -ArgumentList $browserArgs -ErrorAction Stop | Out-Null
  Say "  已把 $($urls.Count) 个页面开进你正在用的那个浏览器窗口（新标签页，没有新开窗口）"
} catch {
  Say "  [失败] 起 $browser 时抛错，**一个页面都没开**：$($_.Exception.Message)"
  foreach ($k in @($openedKeys)) { Set-PanelState -Key $k -State 'failed' -Why "起浏览器抛错：$($_.Exception.Message)" }
  Save-PanelLedger -Keys (@($presentKeys) + @($openedKeys))
  exit 1
}
# ★ 到达验收（2026-09-26）：把"发起了"升级成"到了"才算成功 —— 见 Test-CdpPageArrived 的文件头。
foreach ($k in @($openedKeys)) {
  $r = Wait-PanelArrival -Url $candidates[$k]
  if ($r.Ok) { Set-PanelState -Key $k -State 'arrived' -Why $r.Why }
  else { Set-PanelState -Key $k -State 'initiated' -Why $r.Why }
}
Save-PanelLedger -Keys (@($presentKeys) + @($openedKeys))
if ($CdpMode -eq 'on') { Say "  [调试口] 这次带上了 --remote-debugging-port=$CdpPort ⇒ 下一次启动就能'原地刷新'这些页面（不再开第二张）" }
Say '  [说明] 这些标签页我们关不掉（浏览器不允许脚本关别人的标签页），Ctrl+W 自己关就行；'
Say '         想要"关闭全部时能一起收掉的独立窗口"：tools\panels.ps1 open -OwnWindow'
exit 0
