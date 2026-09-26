# 环境层读取（仓库根 `agent.config.json`）—— **.ps1 侧的唯一入口**。
#
# 为什么要有它：端口 / 路径 / browserMode 这些"换台机器就不一样"的值原来散在十几个脚本里，
# 改一个端口要满仓库找（P2⑦）。**默认值表不在这里** —— 它只有一处：
# `qq-bridge\src\config-lib.js` 的 `DEFAULT_PORTS` / `loadEnvConfig()`。这个文件只做一件事：
# 问 Node 要"生效端口 + browserMode/headless"，供各 .ps1 读，谁也不再抄一份字面量。
#
# 用法（放在脚本靠前、$Root 之前也行）：
#   . (Join-Path $PSScriptRoot 'env-config.ps1')
#   $Ports = Get-AgentPorts
#   $DshPort = $Ports.dshWeb              # DSH Web 的生效端口（值来自 agent.config.json，别在这里写死数字）
#   if (Get-AgentFlag 'headless') { ... } # §6.2 无头开关（默认 false）
#
# 三条纪律：
#   1. 生效端口 = **从 URL 投影回来**（URL 是权威值）⇒ 永远不会和 bridge 真正监听的端口漂移；
#      即使 agent.config.json 被删掉、值退回 qq-bridge\config.json，这里也跟着变。
#   2. 缺字段/文件不在由 Node 那侧出声（`[env] …` 走 stderr，不污染 stdout）；
#      这里只在**读失败**时抛错 —— 静默退回默认端口是最难查的一类问题。
#   3. 本文件必须 UTF-8 **带 BOM**（PS 5.1 读无 BOM 的中文会按 ANSI 解码 → 解析炸；
#      编辑工具会剥 BOM，补回：`node tools\self-check.mjs --fix-bom`）。

$script:AgentEnvCache = $null

function Get-AgentEnv {
    if ($script:AgentEnvCache) { return $script:AgentEnvCache }
    $root = Split-Path -Parent $PSScriptRoot
    $lib = Join-Path $root 'qq-bridge\src\config-lib.js'
    if (-not (Test-Path $lib)) { throw "环境层读取器不见了：$lib（端口/路径的唯一来源）" }
    # 一段**只用单引号**的 JS：PS 5.1 把参数交给原生程序时不会转义内层双引号（会被吃掉），
    # 所以这里刻意不出现双引号 —— 这是踩过的坑，别"顺手美化"成双引号。
    $js = 'const u=await import(''node:url'');const m=await import(u.pathToFileURL(process.argv[1]).href);const ev=m.loadEnvConfig({announce:''none''}).values;let ports,mode,head,owner;try{const c=m.loadConfig();ports=m.effectivePorts(c);mode=c.env.browserMode;head=c.env.headless;owner=c.ownerQQ||'''';}catch(e){console.error(''[env] qq-bridge/config.json 读不了，退回环境层：''+e.message);ports=ev.ports;mode=ev.browserMode;head=ev.headless;owner=ev.ownerQQ||'''';}console.log(JSON.stringify({ports:ports,browserMode:mode,headless:head,displayName:ev.displayName||'''',botQQ:ev.botQQ||'''',ownerQQ:owner}));'
    $json = & node --input-type=module -e $js $lib
    if ($LASTEXITCODE -ne 0 -or -not $json) {
        throw "读环境层失败（node 退出码 $LASTEXITCODE）：$lib —— 先跑 node tools\self-check.mjs 看配置是不是坏了"
    }
    $script:AgentEnvCache = $json | ConvertFrom-Json
    return $script:AgentEnvCache
}

# 生效端口表：dshWeb / onebotHttp / snowlumaWs / snowlumaWeb / bridgeConsole / bridgeControl
function Get-AgentPorts { return (Get-AgentEnv).ports }

# 环境层开关：headless（§6.2）。browserMode 用 Get-AgentBrowserMode。
function Get-AgentFlag([string]$Name) { return [bool](Get-AgentEnv).$Name }

# §3.3 浏览器三档：lazy（省心，默认）/ dev（开进你自己的浏览器）/ idle（挂机，不开页）
function Get-AgentBrowserMode { return [string](Get-AgentEnv).browserMode }

# ── 身份（identity）：换个人就完全不同的那几个值 ──────────────────────────────
# 为什么要有这三条：引导语里原来硬写着「小懒鲸」（机器人昵称）与主人的号 —— 交付给别人时
# 那句话就指向了**别人的**机器人。身份的默认值表同样只有一处（config-lib.js 的 ENV_IDENTITY_KEYS），
# 这里只做"问 Node 要"，一个真值都不抄。
#
# 机器人显示名（环境层 displayName）。空串 = 没填 ⇒ **调用方自己退到网关登录昵称**；
# 这里绝不塞一个兜底人名 —— 那就是第二份身份来源（也正是这次要清掉的东西）。
function Get-AgentDisplayName { return [string](Get-AgentEnv).displayName }

# 机器人 QQ（环境层 botQQ）。空串 = 没填 ⇒ 调用方自己从 SnowLuma 的 onebot_<UIN>.json 推（排除 ownerQQ）。
function Get-AgentBotQQ { return [string](Get-AgentEnv).botQQ }

# 主人 QQ（**生效值**：环境层 agent.config.json > qq-bridge\config.json，与 config-lib.js 同一优先级链）。
# 空串 = 两处都没配 ⇒ 管理命令 / 审批转达 / 入群审批不可用；桥接启动时会打一行 ✖ 并说清去哪儿填。
function Get-AgentOwnerQQ { return [string](Get-AgentEnv).ownerQQ }

# 引导语里"去 QQ 里找「X」"那个 X：环境层填了就用它 → 否则用网关登录昵称（QQ 在线时自动）
# → 都没有才退到「你的机器人」（中性词，不是某个人设的名字）。
function Get-AgentBotName([object]$Status) {
    $n = Get-AgentDisplayName
    if (-not $n -and $Status -and $Status.qq -and $Status.qq.nickname) { $n = [string]$Status.qq.nickname }
    if (-not $n) { $n = '你的机器人' }
    return $n
}
