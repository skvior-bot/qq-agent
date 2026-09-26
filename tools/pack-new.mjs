#!/usr/bin/env node
// tools\pack-new.mjs —— 把「DSH × QQ 机器人」打成一个**可以交付给别人 / 搬到服务器**的包。
//
// 为什么要它：这个仓库里混着真凭据（QQ 登录态、SnowLuma OneBot accessToken、桥接控制台令牌、
// DPAPI 密文、画图密钥、DSH launch token），手工打 zip 时 `.gitignore` 帮不上忙 —— 一次
// `Compress-Archive -Path *` 就可能把 `qq-bridge\state\` 和 `qq-bridge\config.json` 一起发出去。
// 本脚本把「能发什么」写成白名单 + 黑名单两份表（口径 = docs\部署到服务器.md 的
// 「参数清单（换人即换）」D 节），打完包再对**产物**跑一次安全自检；命中疑似密钥就删掉产物、
// 打印告警并以非 0 退出 —— 宁可不交付，也不能泄露。
//
// 用法：
//   node tools\pack-new.mjs --list                # 只打印：将包含哪些 / 排除了哪些（带原因）+ 只读预检
//   node tools\pack-new.mjs --dry-run             # 同上（不写任何文件）
//   node tools\pack-new.mjs --out %TEMP%\pack-test\        # 打成目录
//   node tools\pack-new.mjs --out %TEMP%\pack.zip          # 打成 zip（走 PowerShell Compress-Archive）
//   node tools\pack-new.mjs --keep-temp           # 保留 %TEMP% 里的暂存/校验目录，便于排查
//   node tools\pack-new.mjs --no-precheck         # 跳过「只读预检」（真打包时的产物自检不受影响）
//   node tools\pack-new.mjs --profile friend --list   # ★「朋友试用包」档：**我们的内部台账不进包**（默认 full ＝ 现在这套）
//   node tools\pack-new.mjs --selftest            # ★ 判据自检（假仓库夹具，真仓库一个字节不动；四条判据一条不缺）
//   node tools\pack-new.mjs --allow-links         # ★ 显式放行"候选树里有链接"（默认 = 拒交付 exit 4，见下）
//
// ★★ 参数面是**封闭**的（就上面这些）：**不认识的参数 ⇒ 打印用法 ＋ 非零退出**，且跑在**任何动作之前**
//   （2026-09-26 22:xx 同族加固，与 `tools\export-a.mjs` 判据⑨ 同一口径）。立案现场在 export-a 那边：
//   `--list --no-files` 被 `has()` **静默忽略** ⇒ 以为是干跑、实际**照常写盘**、**exit 0**。
//   ⚠ 本工具的**参数面按这里的读法逐字枚举**（`hasFlag`/`opt` 两处调用点），别凭记忆加白名单。
//
// ★ 链接（symlink / Windows junction）⇒ **默认拒交付（exit 4）**，2026-09-26 21:5x 复核线打回 ＋ 协调线裁决：
//   它**仍然不跟进**（链接目标可能是被排除的路径或仓库之外），但**光"列出来"不够** ——
//   被 junction 顶掉的路径会让"该带的没带、该排除的没排除"，而**任何数量对账都看不出少了东西**
//   （那几份从**发现**这一层就不再被枚举）⇒ 必须**人看一眼**才放行。`--allow-links` 是那个显式出口；
//   不留出口的话，下一个人会把闸注释掉。同 `tools\export-a.mjs` 判据⑦（两个打包器同一口径）。
//
// ★ --profile friend（2026-09-26，优化线小锤；协调线批准）：B 档有两个用途 —— **朋友试用包**与**搬服务器**。
//   搬服务器要带全量（含我们的内部台账），朋友试用不需要那些记账 ⇒ 本档**只加一张排除表** `EXCLUDE_FRIEND`。
//   口径一句话：**"朋友想自己把这套装起来跑，需不需要它"** —— 需要就留，只是我们自己的记账就不留。
//   ★ 只加不减：`INCLUDE_DIRS` / `INCLUDE_FILES` / `EXCLUDE` **一个字都不动** ⇒ 不带 `--profile` 时读数**逐字不变**。
//   ⚠ 产物自检那一步**不因 profile 放宽**（同一套规则、同一处代码，只是喂给它的文件集少了台账）。
//
// 默认产物：%TEMP%\dsh-qq-bot-pack-<yyyyMMddHHmmss>.zip
// 退出码：0 成功；2 用法/IO 错误；3 **安全自检命中**（产物已删除）；4 **候选树里有链接**（拒交付、一个东西都不写）。
//
// 不改仓库里任何既有文件：只读源文件，产物一律落 %TEMP%（除非你显式 --out 到别处）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 端口单一来源（P2⑦）：默认值只在 qq-bridge\src\config-lib.js 定义一次。
// 包里的「部署说明.txt」教新用户把 SnowLuma 的 OneBot 配成哪个端口 —— 那必须是**内置默认表**
// 的值（交付包里**不含** agent.config.json，新机器用的就是这张表），以前这里抄了一份 3000/3001。
import { DEFAULT_PORTS } from '../qq-bridge/src/config-lib.js';

const ROOT = process.env.DSH_PACK_ROOT
  // ⚠ 覆盖位**只为测试**（照 tools\prune-upstream.mjs 的 `DSH_PRUNE_ROOT` 惯例）：`--selftest` 要拿**假仓库**
  //   跑打包规划与安全扫描 —— 真仓库一个字节都不能动。**别在生产里用它**：指错根 = 打错包。
  ? path.resolve(process.env.DSH_PACK_ROOT)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'pack-manifest.json';
const NOTICE = '部署说明.txt';
const FIRST_STEP = '解压后第一步：node tools\\setup-new.mjs';

// ── 命令行 ─────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes('--' + n);
const opt = (n, dflt = '') => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
};
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');

// ── ★★ 未知参数 ⇒ 打印用法 ＋ 非零退出（2026-09-26 22:xx，复核线 r3 §6-3 立的闸；`export-a` 判据⑨ 同族）──
//   参数面**封闭**：白名单就是下面两组（`hasFlag` 那批 ＋ `opt` 那两个带值的），别凭记忆加。
//   ★ 顺序：跑在**任何**动作之前（含 --help / --selftest / 打包本身）。
const KNOWN_FLAGS = new Set(['--help', '--h', '--selftest', '--list', '--dry-run', '--allow-links', '--no-files', '--keep-temp', '--no-precheck']);
const VALUED_FLAGS = new Set(['--profile', '--out']);
function unknownArgs(a) {
  const bad = [];
  for (let i = 0; i < a.length; i++) {
    const t = a[i];
    if (VALUED_FLAGS.has(t)) { const v = a[i + 1]; if (!v || v.startsWith('-')) bad.push(`${t}（缺值）`); i++; continue; }
    if (t.startsWith('-')) { if (!KNOWN_FLAGS.has(t)) bad.push(t); continue; }
    bad.push(t);   // 位置参数：本工具一个都不认（带值参数的值已在上一步吃掉）
  }
  return bad;
}
function printUsage() {
  // 直接把本文件顶部的注释块当帮助打印（--help 一直就是这个口径）
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const help = [];
  for (const l of lines.slice(1)) {
    if (!l.startsWith('//')) break;
    help.push(l.replace(/^\/\/ ?/, ''));
  }
  console.log(help.join('\n'));
}
{
  const bad = unknownArgs(argv);
  if (bad.length) {
    console.error(`❌ 不认识的参数：${bad.join('、')} ⇒ **拒跑：一个东西都没动**（本闸跑在任何动作之前）。`);
    printUsage();
    process.exit(2);
  }
}
if (hasFlag('help') || hasFlag('h')) {
  printUsage();
  process.exit(0);
}
if (hasFlag('selftest')) process.exit(runSelftest());

const TS = stamp();
const LIST = hasFlag('list');
// ── profile：full（默认，＝ 一直以来的口径，**逐字不变**）/ friend（内部台账不进包，见文件头说明）──
const PROFILE = String(opt('profile', 'full')).trim();
if (!['full', 'friend'].includes(PROFILE)) {
  console.error(`❌ --profile 只认 full / friend（收到：${PROFILE || '(空)'}）`);
  process.exit(2);
}
const DRY = hasFlag('dry-run');
// ★ 链接（symlink/junction）默认**硬闸**，这个开关是**显式出口**（2026-09-26 21:5x，同 export-a 判据⑦）。
const ALLOW_LINKS = hasFlag('allow-links');
const QUIET_FILES = hasFlag('no-files');
const KEEP_TEMP = hasFlag('keep-temp');
const NO_PRECHECK = hasFlag('no-precheck');
const OUT_RAW = opt('out');
// 不带 --out 时默认打成 zip（交付场景要的就是一个文件）；显式给目录就按目录复制
const DEFAULT_OUT = path.join(os.tmpdir(), `dsh-qq-bot-pack-${TS}.zip`);
const ZIP_MODE = OUT_RAW ? /\.zip$/i.test(OUT_RAW) : true;

const say = (s = '') => console.log(s);
const warn = (s) => console.error('⚠ ' + s);
// 临时目录登记簿：process.exit() 不会回卷调用栈（finally 不执行），所以 die() 里显式清
const TEMP_DIRS = [];
const rmRegistered = () => {
  if (KEEP_TEMP) return;
  for (const d of TEMP_DIRS.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
};
const die = (code, s) => { console.error('✗ ' + s); rmRegistered(); process.exit(code); };
// 被下游截断（node ... | Select-Object -First 3 / head）时 stdout 会 EPIPE：照样清干净临时目录
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (e) => { if (e && e.code === 'EPIPE') { rmRegistered(); process.exit(0); } });
}
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
const kb = (n) => (n / 1024).toFixed(1) + ' KB';

if (!fs.existsSync(path.join(ROOT, 'qq-bridge')) || !fs.existsSync(path.join(ROOT, 'tools'))) {
  die(2, `仓库根看着不对（${ROOT}）：找不到 qq-bridge\\ 或 tools\\`);
}
if (LIST && OUT_RAW) warn('--list 只打印，忽略 --out');
if (DRY && OUT_RAW) warn('--dry-run 只打印，忽略 --out');

// ── 政策表：白名单（能进包）+ 黑名单（绝不进包）────────────────────────────
// 口径来源：docs\部署到服务器.md「参数清单（换人即换）」D 节「绝对不能进包」。
// 白名单里每一条都要写清"为什么要发"；黑名单里每一条都要写清"为什么不能发"。
const INCLUDE_DIRS = [
  ['tools', '运维与自检脚本（含 setup-new.mjs 向导、pack-new.mjs 本脚本）'],
  ['docs', '文档：部署 / 启动 / 目录地图 / 文件清单'],
  ['qq-bridge/src', '桥接主程序与 5 个 MCP（内核）'],
  ['qq-bridge/scripts', '桥接工具与测试（npm test 入口 test-all.mjs）'],
  ['qq-bridge/public', '桥接控制台页面'],
  ['qq-bridge/docs', '桥接文档（DSH_SETUP.md = 安装唯一权威）'],
  ['qq-bridge/roles', '人设卡'],
  ['qq-bridge/dsh', 'agent preset 源（qq-chat-v2）'],
  ['qq-bridge/plugins', 'DSH GUI 插件 qq-mode-console'],
  ['qq-bridge/assets', '运行时素材（bridge.js 的 AI 形象图 assets\\deepseek娘.png）'],
];
const INCLUDE_FILES = [
  ['AGENTS.md', '工作区说明（接手第一份该读的东西）'],
  ['一键启动.cmd', '启动入口（= tools\\start-all.ps1）'],
  ['.gitignore', '兜底：防新用户 git add -A 时提交密钥'],
  ['agent.config.example.json', '环境层**模板**（纯占位 + 逐项注释、零个人信息）：新用户 copy 成 agent.config.json 再填自己的 QQ'],
  ['qq-bridge/package.json', '依赖与 npm test 入口'],
  ['qq-bridge/package-lock.json', '锁定依赖版本'],
  ['qq-bridge/config.example.json', '配置模板（setup-new.mjs 的数据源，必须随包）'],
  ['qq-bridge/start.bat', '桥接启动 + 守护'],
  ['qq-bridge/restart.bat', '桥接重启'],
  ['qq-bridge/README.md', '桥接说明'],
  ['qq-bridge/RULES.md', '权限唯一权威'],
  ['qq-bridge/.gitignore', '兜底：防误提交 state\\ 与 config.json'],
];

const EXCLUDE = [
  // ── 真凭据（部署到服务器.md §D）────────────────────────────────────────
  ['qq-bridge/state/**', '整目录：控制台令牌 console-token、SnowLuma DPAPI 密文 snowluma-credential.txt、会话映射 sessions.json、聊天上下文 social-v2.json、工具调用日志 tool-calls.jsonl（§D）'],
  ['qq-bridge/state/_tmp/**', '整目录：测试产物，同样落在 state\\ 里（§D 明列）'],
  ['qq-bridge/config.json', '含 dsh.authToken / snowluma.accessToken 真值（§D）'],
  // ── 个人信息（PII）：主人自己的 QQ / 群号 / Windows 用户名 ────────────────
  ['agent.config.json', '环境层**本机真值**：ownerQQ（主人的 QQ）/ botQQ / displayName / SnowLuma 绝对路径（含 Windows 用户名）。它已被 .gitignore 排除，这里再显式排一次 —— 手工打 zip 时 gitignore 帮不上忙。交付用 agent.config.example.json'],
  ['**/credentials.json', '画图/转写密钥（阿里云百炼）凭据文件（§D 明列 **/credentials.json）'],
  ['**/.credentials.yaml', 'DSH 的 API key / 浏览器会话 secret（§D）'],
  ['backups/**', '备份快照里含 config.json 副本 = 含 token（§D）'],
  ['SnowLuma/data/**', 'QQ 登录态（扫码产生）—— 自用迁移可带，给别人绝不能带（§D）'],
  ['SnowLuma/config/onebot_*.json', 'SnowLuma OneBot accessToken 真值（§D）'],
  ['SnowLuma/config/webui.json', 'SnowLuma 管理页口令哈希（§D）'],
  ['SnowLuma/config/consent.json', '本机同意记录（§D 明列）'],
  ['SnowLuma/**', '第三方 QQ 网关（~100 MB，自带 node.exe）：不进包，让用户自己去装（§D）'],
  ['.launcher-state.json', '启动器本地状态（§D 明列）'],
  ['**/.panels-*', '面板窗口状态 .panels-state.json 等（§D 明列）'],
  ['**/server-*-*.out.log', '~/.dsh/guard/logs 的 DSH 启动日志：里面是明文 launch token（§D）'],
  ['**/console-token', '桥接控制台令牌（首启自动生成，§D）'],
  ['**/snowluma-credential*', 'SnowLuma 管理页口令的 DPAPI 密文（绑 Windows 用户，换机解不开，§D）'],
  // ── 依赖 / 缓存 / 版本库 / 体积 ────────────────────────────────────────
  ['**/node_modules/**', '依赖（新机器 npm install；几十 MB 且平台相关）'],
  ['**/.npm-cache/**', 'npm 本地缓存（§D + 根 .gitignore）'],
  ['.git/**', '真仓库（含历史里的旧 blob）'],
  ['.dsh/**', '本机工作区技能目录（skills 下可能有 credentials.json）'],
  ['generated-images/**', '生成产物（可重画，根 .gitignore 已排）'],
  ['generated-audio/**', '生成产物（可重画，根 .gitignore 已排）'],
  // ── 仓库自己标记为"不发布"的东西 ───────────────────────────────────────
  ['qq-bridge/scripts/_archive/**', 'qq-bridge\\.gitignore 标注的一次性/归档开发脚本，且含探针日志 _auth-probe-*.log（里面可能带真 token）'],
  ['qq-bridge/scripts/_dev/**', 'qq-bridge\\.gitignore 标注的"在写"开发脚本（不发布）'],
  // 一次性收尾脚本（qq-bridge\.gitignore 就写着 `scripts/cleanup-*.mjs` = 不进版本控制）。
  // ★ 为什么这里必须显式排：它们在**白名单目录** qq-bridge/scripts/ 里，git 忽略管得住 git，
  //   管不住打包器 —— 而实测这两份里就带着真实的群号（group:<群B>）与本机绝对路径。
  //   这是"个人信息泄漏检查"第一次真跑就抓出来的那类洞（git grep 看不见未跟踪文件）。
  ['qq-bridge/scripts/cleanup-*.mjs', '一次性收尾脚本（git 已忽略）：里面带着真实群号与本机绝对路径，属"个人信息"那一类'],
  ['qq-bridge/.npmrc', '把 npm 缓存写死成本机路径 D:/hobby/DSH/.npm-cache（部署到服务器.md §E 待修项），换机只会添乱'],
  ['**/*.log', '一律不进包：日志可能带 token（根 .gitignore 也排了 *.log）'],
  ['**/*.bak', '备份文件一律不进包（qq-bridge\\.gitignore 已排）'],
  ['**/*.bak-*', '备份文件一律不进包（qq-bridge\\.gitignore 已排）'],
  ['Start-Process', '仓库根一个 0 字节的残留文件（某次 PowerShell 手滑产物），不是说明也不是启动脚本'],
];

// ── 「朋友试用包」档（--profile friend）**额外**排除的：我们自己的**内部台账** ────────────
// 判据一句话（协调线拍）：**"朋友想自己把这套装起来跑，需不需要它"** —— 需要就留，只是我们自己的记账就不留。
// ★ 只加不减：上面三张表（INCLUDE_DIRS / INCLUDE_FILES / EXCLUDE）一个字不动 ⇒ 搬服务器那条路逐字不变。
// ⚠ 每条都要写清"为什么不给朋友"（与 EXCLUDE 同规矩）。
const EXCLUDE_FRIEND = [
  ['docs/规则与踩坑日志.md', '内部过程流水（只追加、含历史真号）：对朋友零价值'],
  ['docs/HANDOFF-archive.md', '历史交接存档（含会话台账与花费数字）'],
  ['docs/优化清单-archive.md', '已闭的历史批次 = 我们自己的记账'],
  ['docs/变更日志.jsonl', '我们自己的改动账（机器可读）'],
  ['docs/文件清单.md', '逐文件用途 = 开发索引，朋友不需要'],
  ['docs/结构快照.md', '易过期数字（机器生成，出手即过期）'],
  ['docs/任务清单.md', '我们自己的待办'],
  ['docs/HANDOFF.md', '现状入口：含会话台账 / 花费 / 开放项 —— 我们的记账'],
  ['docs/优化清单.md', '待办唯一权威：同上'],
  ['docs/QQ消息可靠性-修复方案.md', '技术内容有价值，但**正文含真号** ⇒ 将来做正式对外版另说'],
];

// ── glob 匹配（只支持 * / **，够用且不会误伤）──────────────────────────────
function matches(pattern, rel) {
  const rx = new RegExp(
    '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '(?:.*/)?')
        .replace(/\/\*\*$/g, '(?:/.*)?')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*') +
      '$',
  );
  return rx.test(rel);
}

// ── --selftest：判据自检（**假仓库**夹具；真仓库一个字节不动）──────────────────────
// 为什么必须有：`--profile friend` 报"0 处"时，必须能证明**不是"扫描根本没跑"**（空过对照）——
//   而证明只能在**假仓库**上做 ⇒ 用 `DSH_PACK_ROOT` 指一棵 `qq-bridge\state\_tmp\` 里的夹具树
//   （`_tmp` 既被 `EXCLUDE` 整目录排掉、又在 .gitignore 里 ⇒ 绝不会混进真包，也不会进版本库）。
// 四条判据（协调线要求"缺一条不算完"）：
//   ① **空过对照**：夹具里放一个**必被点名**的文件 ⇒ friend 档**必须报红**（退出码 3）；
//   ② **不是恒红**：同一夹具把那个值换成占位 ⇒ friend 档 **0 处 / 退出码 0**；
//   ③ **反向对照**：把必红内容放进**被排除的台账文件名**里 ⇒ friend 档不报（被排除），
//      而同一夹具用 `full` **必须报红** ⇒ 证明它是**被排除**、不是被洗白；
//   ④ **默认档一致**：不加 `--profile`（默认 full）跑 ① 的夹具 ⇒ 与 ① 同结果。
//   ⑤ 非法 profile ⇒ 退 2（不静默退回全量）。
//   ⑥ ★ **PII 打印上限必须自曝**：造 >50 命中的夹具 ⇒ 那行 ⚠（含**真实数量**）必须出现，且打印条数仍 ≤51。
//   ⑥b ★ **已知密钥那一路同样要自曝**（A3 收条件 2026-09-26 21:xx）：同一个假令牌放 60 份 ⇒
//       ⚠ 必须出现、真实数量必须是 60（老代码这里报 51 且**一行 ⚠ 都没有**）。
function runSelftest() {
  const self = fileURLToPath(import.meta.url);
  const base = path.join(ROOT, 'qq-bridge', 'state', '_tmp', 'pack-selftest');
  const log = path.join(base, 'out.log');
  // ⚠ 夹具值/键名一律**运行期拼**（不落字面）：这个文件**自己也会进包**，会被本文的 `json-cred` 规则点名 ——
  //   守门人自己带禁形状，与 `tools\scan-secrets.cjs` 那条"夹具数字运行期拼"同族（同一天踩到两次）。
  //   ⚠ 只拆**值**不够：那条规则是 `"键": "值"` 形状，键名留在字面里照样能一路匹配到下一个引号
  //   （实测：拆值不拆键 ⇒ friend 档仍报 1 处）⇒ **键名也要拆**。
  const K = 'auth' + 'Token';
  const BAD = `{"${K}": "${['a1b2', 'c3d4', 'e5f6', 'g7h8'].join('')}"}`;   // ⇒ 必被点名
  const OK = `{"${K}": "<在这里填你自己的>"}`;                                // 占位 ⇒ 不该被点名
  let pass = 0; const fails = [];
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); return; }
    fails.push(name); console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  };
  // ★ "不适用"**显式记账**（2026-09-26 22:xx，复核线 r3 §3 洞③）：既不计通过、也不静默。
  //   为什么不能写成 `check(name, true)`：那样它**完全隐形**；而"跳过路径恰好不记账"只是约定、不是强制。
  let skipCount = 0; const skips = [];
  const skip = (name, why) => { skipCount++; skips.push(`${name}（${why}）`); console.log(`  ⏭ ${name} —— ${why}`); };
  const mkFixture = (name, files) => {
    const dir = path.join(base, name);
    fs.rmSync(dir, { recursive: true, force: true });
    // ⚠ 夹具根也必须过 pack-new 自己的那道**fail-closed 根闸**（"找不到 qq-bridge\ 或 tools\ ⇒ 退 2"）
    fs.mkdirSync(path.join(dir, 'qq-bridge'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    return dir;
  };
  const runList = (root, extra = []) => {
    const fd = fs.openSync(log, 'w');
    // ⚠ stdio 走**文件 fd**（不是管道）：受限沙箱里 pipe 会 EPERM（本族已知的坑）
    const r = spawnSync(process.execPath, [self, '--list', ...extra], {
      env: { ...process.env, DSH_PACK_ROOT: root }, stdio: ['ignore', fd, fd],
    });
    fs.closeSync(fd);
    return { code: r.status, text: fs.readFileSync(log, 'utf8') };
  };

  console.log('【判据自检】--selftest（假仓库夹具，真仓库不动；夹具落在 state\\_tmp\\pack-selftest\\）');
  try {
    const bad = mkFixture('fx-bad', { 'README.md': 'ok\n', 'docs/我的笔记.md': `值：${BAD}\n` });
    const clean = mkFixture('fx-clean', { 'README.md': 'ok\n', 'docs/我的笔记.md': `值：${OK}\n` });
    const ledger = mkFixture('fx-ledger', { 'README.md': 'ok\n', 'docs/规则与踩坑日志.md': `值：${BAD}\n` });

    const r1 = runList(bad, ['--profile', 'friend']);
    check('① 空过对照：friend 档对"必被点名的文件"仍报红（0 处 ≠ 扫描没跑）', r1.code === 3, `退出码 ${r1.code}`);
    check('① 命中确实发生在预检那一步', /预检命中/.test(r1.text));

    const r2 = runList(clean, ['--profile', 'friend']);
    check('② 不是恒红：占位夹具 ⇒ friend 档 0 处 / 退出码 0', r2.code === 0, `退出码 ${r2.code}`);

    const r3 = runList(ledger, ['--profile', 'friend']);
    check('③ 反向对照：被排除的台账在 friend 档里不报红', r3.code === 0, `退出码 ${r3.code}`);
    check('③ 且它确实被"排除"（出现在追加排除清单里），不是悄悄跳过', /profile=friend 追加排除/.test(r3.text) && /规则与踩坑日志\.md/.test(r3.text));
    const r4 = runList(ledger, ['--profile', 'full']);
    check('③ 同一夹具用 full 档**必须报红** ⇒ 它是被排除、不是被洗白', r4.code === 3, `退出码 ${r4.code}`);

    const r5 = runList(bad, []);
    check('④ 默认档（不加 --profile）与 full 同结果：报红', r5.code === 3, `退出码 ${r5.code}`);
    check('④ 默认档的表头写明 profile=full', /profile：full/.test(r5.text));

    const r6 = runList(bad, ['--profile', 'nonsense']);
    check('⑤ 非法 profile 直接退 2（不静默退回全量）', r6.code === 2, `退出码 ${r6.code}`);

    // ⑥ ★ PII 打印上限**必须自曝**：夹具故意造 >上限 命中 ⇒ 那行 ⚠ 必须出现，且**真实数量要数对**。
    //    ⚠ 上限 = 模块级 `PRINT_LIMIT`，**现值 51**（这里不直接引用那个常量：`runSelftest()` 在第 73 行就被
    //    调用了，那时顶层 `const PRINT_LIMIT` 还没初始化 ⇒ 引用会 TDZ 报错；照下面 ⑥b 的写法用字面 51）。
    //    （2026-09-26 21:5x 订正：这条注释原写"50 条"，与常量不符 —— 复核线点名的"注释过度声明"同族。）
    //    反过来说：没有这条断言，"上限截断"就会一直静默 —— 本族口径是"别静默截断"。
    //    ⚠ 夹具值**运行期拼**（且用假号）：这个文件自己也会进包，写死一个 12 位数字串会被自家扫描器点名。
    const FAKE_QQ = ['98765', '43210', '0'].join('');            // 12 位假号（不是任何真号）
    const capBody = Array.from({ length: 61 }, () => FAKE_QQ).join('  ');
    const cap = mkFixture('fx-pii-cap', {
      'README.md': 'ok\n',
      'agent.config.json': `{"ownerQQ": "${FAKE_QQ}", "botQQ": "${FAKE_QQ}"}\n`,
      'tools/pii-cap.md': `${capBody}\n`,
    });
    const r7 = runList(cap, ['--profile', 'friend']);
    check('⑥ PII 命中被打到打印上限时仍报红', r7.code === 3, `退出码 ${r7.code}`);
    check('⑥ 截断那行 ⚠ 必须出现（否则静默截断）', /个人信息命中已达打印上限 51/.test(r7.text) && /截断，别把/.test(r7.text));
    const mTotal = r7.text.match(/真实数量 (\d+)/);
    check('⑥ 且**真实数量数对了**（不是写死的字面）', !!mTotal && Number(mTotal[1]) > 50, `真实数量 ${mTotal ? mTotal[1] : '(没印)'}`);
    // ★ headline 必须报**真实数量**，且与那行 ⚠ 用**同一个计数器**（协调线 2026-09-26 20:3x 追加的口径）
    const mHead = r7.text.match(/预检命中 (\d+) 处/);
    check('⑥ headline（"预检命中 N 处"）报的是**真实数量**', !!mHead && !!mTotal && mHead[1] === mTotal[1], `headline ${mHead ? mHead[1] : '(没印)'} vs ⚠ 行 ${mTotal ? mTotal[1] : '(没印)'}`);
    // ★ 反向：**没发生截断**时 headline 必须与打印条数一致 ⇒ 那行"逐字不变"（fx-bad 夹具正好 1 处命中）
    check('⑥ 没截断时 headline 仍是打印条数（逐字不变的口径护栏）', /预检命中 1 处/.test(r1.text));
    const printed = (r7.text.match(/✗ \[个人信息\]/g) || []).length;
    check('⑥ 打印条数仍被压在上限内（上限没被放大）', printed > 0 && printed <= 51, `印了 ${printed} 条`);
    const r8 = runList(cap, []);
    check('⑥ 默认档同样自曝（不是只在某个 profile 下才响）', /个人信息命中已达打印上限 51/.test(r8.text));

    // ⑥b ★ **已知密钥那一路同样必须自曝**（A3 收条件，2026-09-26 21:xx）。复核线判词：老口径
    //     "headline 报真实数量" **只对 PII 那一路成立** —— 同一个假令牌放 60 份 ⇒ headline 报 51，且**没有 ⚠**。
    //     夹具做法：把假令牌写进**夹具自己的** qq-bridge\config.json（`collectKnownSecrets` 从 ROOT 收真值源 ⇒
    //     把 DSH_PACK_ROOT 指到夹具，这个假值就成了"本机已知密钥"），再把同一个值放 60 份进一个**会进包**的文件。
    //     ⚠ 值**运行期拼**（同 ⑥ 的理由）：这个文件自己也会进包，写死 token 形状会被自家扫描器点名。
    //     ⚠ 这里的字面 51 = 模块级 `PRINT_LIMIT`（**不能**直接引用那个常量：`runSelftest()` 在第 73 行就被调用了，
    //       那时模块顶层的 `const PRINT_LIMIT` 还没初始化 ⇒ 引用会 TDZ 报错）。
    const FAKE_TOKEN = ['f4k3', 's3cr3t', 't0k3n', 'abcdef'].join('');
    const capSecret = mkFixture('fx-secret-cap', {
      'README.md': 'ok\n',
      'qq-bridge/config.json': `{"${K}": "${FAKE_TOKEN}"}\n`,
      'tools/secret-cap.md': Array.from({ length: 60 }, () => FAKE_TOKEN).join('  ') + '\n',
    });
    const r9 = runList(capSecret, ['--profile', 'friend']);
    check('⑥b 已知密钥命中被打到打印上限时仍报红', r9.code === 3, `退出码 ${r9.code}`);
    check('⑥b 密钥那路的 ⚠ 必须出现（否则静默截断）', /已知密钥命中已达打印上限 51/.test(r9.text) && /截断，别把/.test(r9.text));
    const mSec = r9.text.match(/真实数量 (\d+)/);
    check('⑥b 且密钥**真实数量**数对了（60 份 ⇒ 不是被截断的 51）', !!mSec && Number(mSec[1]) >= 60, `真实数量 ${mSec ? mSec[1] : '(没印)'}`);
    const mHead9 = r9.text.match(/预检命中 (\d+) 处/);
    check('⑥b headline 报的是密钥真实数量（不是截断值 51）',
      !!mHead9 && !!mSec && mHead9[1] === mSec[1] && Number(mHead9[1]) > 51,
      `headline ${mHead9 ? mHead9[1] : '(没印)'} vs ⚠ 行 ${mSec ? mSec[1] : '(没印)'}`);
    const printedSec = (r9.text.match(/✗ \[已知密钥\]/g) || []).length;
    check('⑥b 密钥打印条数仍被压在上限内（上限没被放大）', printedSec > 0 && printedSec <= 51, `印了 ${printedSec} 条`);

    // ★ ⑦ 链接硬闸（2026-09-26 21:5x，复核线打回 ＋ 协调线裁决）：树里有 symlink/junction ⇒ **拒交付 exit 4**，
    //   `--allow-links` 才放行。为什么单立一条：junction 整棵顶掉一个路径时，"进包数 + 排除数"的算式
    //   **看不出**少了东西（那几份从"发现"这一层就没被枚举）⇒ 必须**人看一眼**才放行。
    //   ⚠ 夹具的链接目标**落在夹具内部**（清理时就算被跟进也只动夹具，永远不碰真仓库）。
    const lnk = mkFixture('fx-link', { 'README.md': 'ok\n', 'docs/笔记.md': 'ok\n' });
    let madeLink = false;
    try { fs.symlinkSync(path.join(lnk, 'docs'), path.join(lnk, 'tools', 'grp'), 'junction'); madeLink = true; } catch (e) {
      check('⑦ 夹具：junction 造得出来（造不出 = 这条判据根本没验到 ⇒ **不许静默跳过**）', false, e.message);
    }
    if (madeLink) {
      const r10 = runList(lnk, []);
      check('⑦ 链接硬闸：树里有 junction ⇒ **拒交付 exit 4**（旧行为是 exit 0 照打）', r10.code === 4, `退出码 ${r10.code}`);
      check('⑦ 链接**逐条点名**（不是静默拦下）', /符号链接 \/ junction/.test(r10.text) && /tools[\\/]grp/.test(r10.text));
      check('⑦ 理由写明"算式看不出少了东西"（不是光喊拒交付）', /看不出/.test(r10.text));
      const r11 = runList(lnk, ['--allow-links']);
      check('⑦b `--allow-links` 显式放行 ⇒ 不再拦（exit 0）', r11.code === 0, `退出码 ${r11.code}`);
      check('⑦b 放行时也要说清"仍然不跟进"', /已按/.test(r11.text) && /显式放行/.test(r11.text) && /1 个链接/.test(r11.text) && /不跟进/.test(r11.text));
      check('⑦c 反向对照：没有链接的夹具**不许**被这条闸误伤（exit 0）', runList(clean, []).code === 0);
    }
    // ★ ⑦d 硬链接（追加②，2026-09-26 21:5x）：`mklink /H` 造的硬链接 `isSymbolicLink()` 为 **false**
    //   ⇒ 上面那条 symlink/junction 判据抓不到它、清单里一个字都没有，**内容却和外部那个文件是同一份**。
    const fxH = mkFixture('fx-hardlink', { 'README.md': 'ok\n', 'docs/笔记.md': 'ok\n' });
    let madeHard = false;
    try { fs.linkSync(path.join(fxH, 'docs', '笔记.md'), path.join(fxH, 'tools', 'hard.md')); madeHard = true; } catch (e) {
      check('⑦d 夹具：硬链接造得出来（造不出 = 这条判据根本没验到 ⇒ **不许静默跳过**）', false, e.message);
    }
    if (madeHard) {
      check('⑦d 前提：硬链接在 Node 眼里**不是** symlink（所以老写法结构上看不见它）',
        !fs.lstatSync(path.join(fxH, 'tools', 'hard.md')).isSymbolicLink());
      const r13 = runList(fxH, []);
      check('⑦d 硬链接 ⇒ **拒交付 exit 4**（旧行为是照打进包）', r13.code === 4, `退出码 ${r13.code}`);
      check('⑦d 硬链接被**点名**（写明"硬链接 / nlink > 1"）', /硬链接/.test(r13.text) && /nlink/.test(r13.text));
      check('⑦e `--allow-links` 对硬链接同样放行（exit 0）', runList(fxH, ['--allow-links']).code === 0);
      check('⑦e 反向对照：干净夹具（无硬链接）不许被误报（exit 0）', runList(clean, []).code === 0);
    }
  } catch (e) {
    check('夹具准备 / 跑子进程', false, e.message);
  }
  // ══ ★ 2026-09-26 22:xx 新增（复核线 r3 §6-3 未知参数闸 ＋ §3 下限闸语义）══════════════════
  // ⑧ **未知参数 ⇒ 必须非零且不许写盘**（同族：`export-a` 判据⑨／自检 ⑪）。⑧a 纯函数 ＋ ⑧b 行为夹具。
  check('⑧a ★ 未知参数被识别出来（`has()` 那种"静默忽略"的老行为正是立案现场）',
    unknownArgs(['--list', '--no-files']).length === 0        // ★ 这两个在本工具里**都是合法的**（别照抄 export-a）
    && unknownArgs(['--list', '--no-such-flag']).length === 1
    && unknownArgs(['--out']).length === 1                    // --out 缺值
    && unknownArgs(['foo']).length === 1                      // 位置参数也不认
    && unknownArgs(['--list', '--out', 'x', '--profile', 'friend', '--dry-run']).length === 0,
    `--no-such-flag ⇒ ${JSON.stringify(unknownArgs(['--list', '--no-such-flag']))}`);
  {
    const outDir = path.join(os.tmpdir(), `pack-unknownarg-${process.pid}.zip`);
    const lg = path.join(base, 'unknownarg.log');
    fs.mkdirSync(base, { recursive: true });
    fs.rmSync(outDir, { force: true });
    const fdx = fs.openSync(lg, 'w');
    // ⚠ stdio 走**文件 fd**（受限沙箱里 pipe 会 EPERM —— 本族已知的坑）
    const rr = spawnSync(process.execPath, [self, '--list', '--no-such-flag', '--out', outDir], { stdio: ['ignore', fdx, fdx] });
    fs.closeSync(fdx);
    const txt = fs.readFileSync(lg, 'utf8');
    const wrote = fs.existsSync(outDir);
    fs.rmSync(outDir, { force: true });
    check('⑧b ★ **行为**夹具：真的跑一次未知参数 ⇒ 非零退出 ＋ 打印用法 ＋ **一个东西都不写**',
      rr.status !== 0 && !wrote && /不认识的参数/.test(txt) && /node tools\\pack-new\.mjs/.test(txt),
      `exit ${rr.status} · 写盘 ${wrote} · ${(txt.match(/不认识的参数[^\n]*/) || ['(没印)'])[0]}`);
  }
  fs.rmSync(base, { recursive: true, force: true });   // 自检不留痕（_tmp 只该留基线/回滚副本）
  // ── ★ 项数下限闸（2026-09-26 22:xx 补齐；复核线 r3 §3 洞⑥"`pack-new` 没有下限闸"）──────────
  //   口径与 `scan-secrets` / `export-a` / 棘轮三处**逐字一致**：治"**静默跳过一条判据**"这一整类。
  //   ★★ **比 `ran`（本轮实际跑了几条），不比 `pass`**：比 `pass` 时**真失败**也会触发它并给出
  //      **错误诊断**"有判据被静默跳过"（那是假话），而且跳过 1 条、别处 +1 条新判据 ⇒ `pass` 回填 ⇒ 看不见。
  //   ★ `ran` = pass ＋ fails ＋ skip；"不适用"**显式记一条 skip**（既不计 pass 也不静默）。
  //     ⚠ 如实交代：本套件**没有** skip 路径（夹具造不出来时一律 `check(…, false)` **记红**，见 ⑦/⑦d 的 catch）
  //       ⇒ `skip()` 现在是**记账入口**、`skipCount` 恒为 0；留着它是为了让人**有地方**记，
  //       而不是顺手写 `check(name, true)` 把它变得完全隐形。
  //   ⚠ 覆盖位 `DSH_SELFTEST_FLOOR` **只允许抬严**（`Math.max`）。
  //   ★ 下限数字**只写一处**（就这一行）；**来源** = 本批 `--selftest` 的实测项数。
  //     ★★ **改这一行 = 改判据**：动它必须走"守门人改动"纪律 —— **先自首 ＋ 给新旧对照读数**
  //     （`DSH_SELFTEST_FLOOR=<旧值>` 与默认值各跑一次，把两次输出贴在一起）。
  const SELFTEST_FLOOR = Math.max(34, Number(process.env.DSH_SELFTEST_FLOOR) || 0);
  const ran = pass + fails.length + skipCount;
  if (ran < SELFTEST_FLOOR) fails.push(`项数下限闸：本轮只跑了 ${ran} 项 < 下限 ${SELFTEST_FLOOR}（有判据被静默跳过 ⇒ 不许报绿）`);
  if (skipCount) console.log(`  ⏭ 本轮有 ${skipCount} 条"不适用"（已显式记账，既不计通过也不静默）：${skips.join('；')}`);
  console.log(fails.length
    ? `❌ 判据自检：${pass} 通过 / ${fails.length} 失败 —— ${fails.join('；')}`
    : `✅ 判据自检：${pass} 项全通过（本轮共跑 ${ran} 项；含空过对照与反向对照）`);
  return fails.length ? 1 : 0;
}

// ── 规划：走一遍仓库，分成"进包"与"排除（带原因）"──────────────────────────
function plan() {
  const included = [];
  const excluded = [];
  const includeFileRule = new Map(INCLUDE_FILES.map(([f, why]) => [f, why]));
  const ALL_INCLUDE_PATHS = [...INCLUDE_DIRS.map(([d]) => d), ...INCLUDE_FILES.map(([f]) => f)];
  const isIncludedDir = (rel) => INCLUDE_DIRS.some(([d]) => rel === d || rel.startsWith(d + '/'));
  // 目录要不要往下走：它本身是白名单目录，或者是某个白名单路径的祖先（例如 qq-bridge\）
  const mayDescend = (rel) => ALL_INCLUDE_PATHS.some((p) => p === rel || p.startsWith(rel + '/'));

  // ★ 符号链接 / junction 识别（2026-09-26 21:xx，A5）：先看 dirent（`mklink /J` 造的 junction 在 Windows 上
  //   被 Node 报成 symlink）；dirent 类型不明的其它 reparse point 再兜一次 lstat。
  const isLinkEntry = (e, abs) => {
    if (e.isSymbolicLink()) return true;
    if (e.isDirectory() || e.isFile()) return false;
    try { return fs.lstatSync(abs).isSymbolicLink(); } catch { return false; }
  };
  // ★ 硬链接识别（追加②，2026-09-26 21:5x）：`mklink /H` 造的硬链接**不是** symlink
  //   （`isSymbolicLink() === false`）⇒ 结构上完全不可见、清单里一个字都没有，可**内容就是同一个文件**
  //   （指向夹具外的 canary 时内容照进产物）。判据 = `statSync().nlink > 1`。
  const isHardLinkEntry = (e, abs) => {
    if (!e.isFile()) return false;
    try { return fs.statSync(abs).nlink > 1; } catch { return false; }
  };

  const walk = (absDir, relDir) => {
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = relDir ? relDir + '/' + e.name : e.name;
      const abs = path.join(absDir, e.name);
      // ★★ **顺序就是判据**（追加①，2026-09-26 21:5x 复核线实测打回）：链接/硬链接**必须在排除名单之前**判。
      //   为什么：名字正好命中排除表的链接（例如 `qq-bridge/state` 那个形状）会被下面的排除分支**先吃掉**
      //   ⇒ 它**以"某个普通排除项"的身份**混过去，两栏里都看不出它是链接（同 export-a 的 `WALK_SKIP` 那一例）。
      // ★ 符号链接 / junction **不许静默跳过**（2026-09-26 21:xx，A5；复核线实测）：
      //   Windows 上 `mklink /J` 造的 junction 被 Node 报成 **symlink**
      //   （实测 dirent：isDirectory=false / isSymbolicLink=true / isFile=false）⇒ 老代码
      //   `if (e.isDirectory())` 不成立、`if (!e.isFile()) continue` 把它**静默跳过**：
      //   **既不算进包、也不算排除**，两栏清单上都看不见它。
      //   口径**不放宽**：仍然"**不跟进**"（链接目标可能是被排除的路径或仓库之外，跟进 = 把不该带的带进包），
      //   但现在不只是"列出来"—— 下面那条**硬闸**会拒交付，要人显式 `--allow-links` 才放行。
      if (isLinkEntry(e, abs)) {
        excluded.push({ rel, why: '符号链接 / junction（**不跟进**：链接目标可能是排除路径或仓库之外，进包会把不该带的带出去；列出来是怕它把白名单 / 排除项悄悄换掉）', dir: false, profile: null, link: true });
        continue;
      }
      // ★ 硬链接（追加②）：`isSymbolicLink()` 为 false ⇒ 上面那条**抓不到它**，而内容就是同一个文件
      //   （复核线实测：指向夹具外 canary 的硬链接 ⇒ canary 命中 1、L1 = 0 照过）⇒ 收进同一个"链接"桶。
      if (isHardLinkEntry(e, abs)) {
        excluded.push({ rel, why: '硬链接（`mklink /H`：`isSymbolicLink()` 为 false ⇒ 结构上不可见，但内容与外部的那个文件是**同一份**；同名判据 = nlink > 1）', dir: false, profile: null, link: true });
        continue;
      }
      const hit = EXCLUDE.find(([pat]) => matches(pat, rel));
      // profile 档的**追加**排除表：只加不减（full 档时这一步根本不查 ⇒ 历史口径逐字不变）
      const hitFriend = !hit && PROFILE === 'friend' ? EXCLUDE_FRIEND.find(([pat]) => matches(pat, rel)) : null;
      if (hit || hitFriend) {
        excluded.push({ rel, why: (hit || hitFriend)[1], dir: e.isDirectory(), profile: hitFriend ? PROFILE : null });
        continue; // 命中黑名单 / profile 排除就不再往下走（整目录排除）
      }
      if (e.isDirectory()) {
        if (mayDescend(rel)) walk(abs, rel);
        continue;
      }
      if (!e.isFile()) {
        // 兜底（同一条不变量：**别静默跳过**）：既不是普通文件、也不是目录 / 链接的条目 —— 老代码在这里直接
        // `continue`。仓库里现在没有这种条目（⇒ 正常档读数不变），留着是防"以后冒出一个、两份清单都看不见"。
        excluded.push({ rel, why: '不是普通文件（也不是目录 / 链接）：本脚本未处理，列出来免得静默跳过', dir: false, profile: null });
        continue;
      }
      const why = includeFileRule.get(rel) || (isIncludedDir(relDir) ? INCLUDE_DIRS.find(([d]) => relDir === d || relDir.startsWith(d + '/'))?.[1] : null);
      if (!why) continue; // 既不在白名单也不在黑名单 → 不进包（默认拒绝）
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { continue; }
      included.push({ rel, abs, size, why });
    }
  };
  walk(ROOT, '');
  included.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return { included, excluded };
}

// ── 安全自检的规则表 ───────────────────────────────────────────────────────
const PATH_RULES = [
  [/(^|\/)qq-bridge\/state(\/|$)/, '桥接 state 目录（令牌 / DPAPI 密文 / 会话映射 / 工具日志）'],
  [/(^|\/)qq-bridge\/config\.json$/, '桥接配置真值（含 accessToken）'],
  [/(^|\/)(backups|node_modules|\.git|\.npm-cache)(\/|$)/, '不该进包的目录（备份 / 依赖 / 版本库 / 缓存）'],
  [/(^|\/)SnowLuma\//, 'SnowLuma（第三方网关 + 它 config 里的 OneBot token / webui 哈希 / QQ 登录态）'],
  [/(^|\/)credentials\.json$/, '凭据文件 credentials.json'],
  [/(^|\/)\.credentials\.yaml$/, 'DSH 凭据 .credentials.yaml'],
  [/(^|\/)\.launcher-state\.json$/, '启动器本地状态'],
  [/(^|\/)\.panels-[^/]*$/, '面板状态 .panels-*'],
  [/(^|\/)console-token$/, '桥接控制台令牌文件'],
  [/(^|\/)snowluma-credential[^/]*$/, 'SnowLuma DPAPI 密文文件'],
  [/(^|\/)server-\d{8}-\d{6}\.out\.log$/, 'DSH guard 日志（明文 launch token）'],
  [/\.(pem|key|pfx|p12)$/i, '私钥 / 证书文件'],
];

// 明显的占位值（测试夹具 / 示例），只用来给**启发式**规则去噪；
// 「已知密钥逐字比对」不看这个 —— 真凭据永远是硬命中。
const PLACEHOLDER = /fixture|example|placeholder|dummy|sample|changeme|redacted|your[-_]|<[^>]*>|xxx|\bfake\b|test[-_]?(only|token|key|value)/i;
const isPlaceholder = (s) => PLACEHOLDER.test(String(s));

const CONTENT_RULES = [
  {
    id: 'sk-key',
    re: /\bsk-[A-Za-z0-9_-]{16,}/g,
    why: 'sk- 开头的 API key（DeepSeek / 百炼 / OpenAI 风格）',
  },
  {
    id: 'json-cred',
    re: /"(?:accessToken|authToken|consoleToken|apiKey|api_key|secretKey|clientSecret|password)"\s*:\s*"([^"]{6,})"/g,
    why: 'JSON 里带非空值的凭据字段',
    allow: isPlaceholder,
  },
  {
    id: 'hash-field',
    re: /\b(?:passwordHash|passwordSalt)\b\s*[:=]\s*["']?([A-Za-z0-9+/=$._-]{12,})/g,
    why: '口令哈希 / 盐值字段带值',
    allow: isPlaceholder,
  },
  {
    id: 'private-key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
    why: 'PEM 私钥',
  },
  {
    id: 'token43',
    // 前后都必须"干净"：左右不能紧挨 base64/base64url 字符或 = + /
    // —— 否则 package-lock.json 里的 npm integrity（sha512-<86 位 base64>==）会被切出 43 字符窗口误报。
    re: /(?:^|[^A-Za-z0-9_+/=-])([A-Za-z0-9_-]{43})(?![A-Za-z0-9_+/=-])/g,
    why: '43 字符 base64url 形态的 token（本机 DSH launch token / SnowLuma accessToken / 控制台令牌都是这个长度）',
    // 真 token 是随机的：同时含大小写与数字。加这条过滤，避免中文文档里的长 ASCII 串误报。
    filter: (s) => /[a-z]/.test(s) && /[A-Z]/.test(s) && /\d/.test(s),
    allow: isPlaceholder,
  },
];

const isTextFile = (buf, rel) => {
  if (/\.(js|mjs|cjs|json|jsonl|md|txt|yml|yaml|ps1|cmd|bat|html|css|xml|ini|sh|ts|example|npmrc)$/i.test(rel)) return true;
  if (!/\./.test(path.basename(rel))) return true; // 无扩展名（console-token 之类）
  return !buf.subarray(0, 8192).includes(0);
};

const mask = (s) => `${String(s).slice(0, 4)}…（${String(s).length} 字符，已隐去）`;

// ── 已知密钥：从本机真凭据里取值，再拿去搜产物（最准的一条检查）────────────
function collectKnownSecrets() {
  const out = [];
  const seen = new Set();
  const add = (label, v) => {
    const s = String(v ?? '').trim();
    if (s.length < 12 || s.length > 4096) return;
    if (/^(https?|ws):\/\//i.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push({ label, value: s });
  };
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
  const walkKeys = (obj, label, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 6) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        if (/token|secret|passw|apikey|api_key|credential/i.test(k)) add(`${label}:${k}`, v);
      } else walkKeys(v, label, depth + 1);
    }
  };

  // 桥接：控制台令牌 + config.json 里的 authToken / accessToken
  try { add('qq-bridge/state/console-token', fs.readFileSync(path.join(ROOT, 'qq-bridge/state/console-token'), 'utf8')); } catch {}
  walkKeys(readJson(path.join(ROOT, 'qq-bridge/config.json')), 'qq-bridge/config.json');
  // SnowLuma：OneBot token / 管理页口令哈希
  try {
    for (const f of fs.readdirSync(path.join(ROOT, 'SnowLuma/config'))) {
      if (/^onebot_.*\.json$/.test(f) || f === 'webui.json') walkKeys(readJson(path.join(ROOT, 'SnowLuma/config', f)), 'SnowLuma/config/' + f);
    }
  } catch {}
  // DPAPI 密文（整段 base64；取一段够独特的即可）
  try {
    const t = fs.readFileSync(path.join(ROOT, 'qq-bridge/state/snowluma-credential.txt'), 'utf8').trim();
    if (t.length >= 40) add('snowluma-credential.txt(DPAPI)', t.slice(0, 64));
  } catch {}
  // DSH 侧：~\.dsh\.credentials.yaml 的值 + guard 日志里的 launch token
  const home = os.homedir();
  try {
    const y = fs.readFileSync(path.join(home, '.dsh/.credentials.yaml'), 'utf8');
    for (const line of y.split(/\r?\n/)) {
      const m = /^\s*[A-Za-z0-9_.-]+\s*:\s*(.+)$/.exec(line);
      if (m) {
        const v = m[1].trim().replace(/^["']|["']$/g, '');
        if (v.length >= 20 && /^[A-Za-z0-9_\-./+=]+$/.test(v)) add('~/.dsh/.credentials.yaml', v);
      }
    }
  } catch {}
  try {
    const dir = path.join(home, '.dsh/guard/logs');
    const logs = fs.readdirSync(dir).filter((f) => /^server-.*\.out\.log$/.test(f)).sort().slice(-2);
    const found = new Set();
    for (const f of logs) {
      const t = fs.readFileSync(path.join(dir, f), 'utf8');
      for (const m of t.matchAll(/(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g)) found.add(m[1]);
    }
    let i = 0;
    for (const v of found) if (++i <= 20) add('~/.dsh/guard/logs(launch token)', v);
  } catch {}
  return out;
}

// ── 个人信息（PII）：主人自己的 QQ / 群号 / Windows 用户名 ──────────────────
// 为什么要单独一类：密钥泄漏是"别人能登进来"，个人信息泄漏是"别人知道这包是谁的" ——
// 交付场景里后者同样不能接受（包会被解压、会被翻、可能进公开仓库）。
//
// ★ 判据：值**一律不写死在本文件里**，而是从本机的真值源现场收集 —— 换个人（换 ownerQQ /
//   换 Windows 用户名）这条检查照样准，不会变成"只有这台机器能用的硬编码"。
//   收集源：仓库根 agent.config.json（ownerQQ/botQQ/paths）、qq-bridge\config.json
//   （ownerQQ + 四个白名单）、本机 Windows 用户名与家目录。
//
// ⚠ 三条防误报（宁可漏报短号，也不要天天假红 —— 假红的检查等于没有检查）：
//   · 纯数字 ID 只收 **6 位及以上**（5 位以下跟版本号 / 行号 / 端口 / 哈希片段撞得太厉害）；
//   · 匹配时要求**前后都是"干净"边界**：数字串两侧不许再挨着 base64/哈希字符
//     （否则 package-lock.json 的 sha512 里切出来的 6 位数字会误报）；
//   · `paths.*` **只在它含本机用户名或在本机家目录下时**才算个人信息。
//     理由：`D:\hobby\DSH\SnowLuma` 这种路径不含主人身份（它只是"项目装在哪"，属于
//     docs\部署到服务器.md §E「硬编码路径」那一类，不是隐私）；而 `C:\Users\<真名>\…` 是。
//     不加这条限制，全仓几十处示例路径会天天假红。
function collectKnownPii() {
  const out = [];
  const seen = new Set();
  const home = os.homedir();
  const user = (() => { try { return os.userInfo().username; } catch { return ''; } })();
  const touchesHome = (s) => !!s && ((home && (s.startsWith(home) || s.startsWith(home.replace(/\\/g, '/')))) || (user.length >= 3 && s.includes(user)));
  const add = (label, v) => {
    const s = String(v ?? '').trim();
    if (!s) return;
    const numeric = /^\d+$/.test(s);
    if (numeric ? s.length < 6 : s.length < 3) return;   // 见上面三条防误报
    if (/^(https?|ws):\/\//i.test(s)) return;
    if (seen.has(s)) return;
    seen.add(s);
    out.push({ label, value: s });
  };
  const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };
  const num = (label, v) => { if (/^\d+$/.test(String(v ?? '').trim())) add(label, v); };
  const ids = (label, v) => { if (Array.isArray(v)) for (const x of v) num(label, x); };

  const agent = readJson(path.join(ROOT, 'agent.config.json'));
  if (agent) {
    num('agent.config.json 的 ownerQQ', agent.ownerQQ);
    num('agent.config.json 的 botQQ', agent.botQQ);
    if (agent.paths && typeof agent.paths === 'object') {
      for (const [k, v] of Object.entries(agent.paths)) if (typeof v === 'string' && touchesHome(v)) add(`agent.config.json 的 paths.${k}`, v);
    }
  }
  const bc = readJson(path.join(ROOT, 'qq-bridge/config.json'));
  if (bc) {
    num('qq-bridge/config.json 的 ownerQQ', bc.ownerQQ);
    for (const k of ['allow', 'deny']) {
      const seg = bc[k];
      if (!seg || typeof seg !== 'object') continue;
      ids(`qq-bridge/config.json 的 ${k}.private`, seg.private ?? seg.privates);
      ids(`qq-bridge/config.json 的 ${k}.groups`, seg.groups ?? seg.group);
    }
  }
  // Windows 用户名与家目录：文档/脚本里最容易漏的就是 `C:\Users\<真名>\…`
  add('本机 Windows 用户名', user);
  if (home) { add('本机家目录', home); add('本机家目录（正斜杠写法）', home.replace(/\\/g, '/')); }
  return out;
}

// ── 打印上限（**每个家族最多印多少条**）────────────────────────────────────
// ★ 文案差 1 的对齐（2026-09-26 21:xx，A3）：老代码的判断是 `hits.length <= 50` ⇒ 第 51 条**仍会 push**
//   ⇒ 实际印得出 **51** 条，而 ⚠ 文案却自称"打印上限 50"（自检与代码注释写的都是 ≤51）——三处不一致。
//   现在统一按这个常量说：**上限 = 51 条**。三处（代码 / 自检 / 文案）谁也不许再写 50。
//   ⚠ 这个常量**不是** `<= 50` 那个阈值：它的语义是"最多印几条"，所以用 `length < PRINT_LIMIT` 配合。
const PRINT_LIMIT = 51;

// ── 扫描一棵树（源目录做预检 / 产物目录做自检，同一套规则）────────────────
function scanTree(baseDir, items, { secrets = [], pii = [] } = {}) {
  const rels = items.map((i) => (typeof i === 'string' ? i : i.rel));
  const pathHits = [];
  const contentHits = [];
  const secretHits = [];
  const piiHits = [];
  let secretTotal = 0;   // ★ 与 `piiTotal` 同族：见下面密钥循环里的注释（**真实**命中数 vs 打印条数）
  let piiTotal = 0;   // 见下面循环里的注释：这条是**真实**命中数，与 `piiHits.length`（打印条数）分开
  const chunks = [];
  const offsets = [];
  let bytes = 0;
  let cursor = 0;

  for (const rel of rels) {
    for (const [re, why] of PATH_RULES) if (re.test(rel)) pathHits.push({ rel, why });
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); } catch { continue; }
    bytes += buf.length;
    if (isTextFile(buf, rel)) {
      const text = buf.toString('utf8');
      for (const rule of CONTENT_RULES) {
        for (const m of text.matchAll(rule.re)) {
          const val = m[1] ?? m[0];
          if (rule.filter && !rule.filter(val)) continue;
          if (rule.allow && rule.allow(val)) continue;
          const line = text.slice(0, m.index).split('\n').length;
          contentHits.push({ rel, why: rule.why, rule: rule.id, line, evidence: mask(val) });
        }
      }
    }
    const chunk = buf.toString('latin1'); // 二进制也照样搜 ASCII 密钥
    offsets.push({ start: cursor, end: cursor + chunk.length, rel });
    cursor += chunk.length;
    chunks.push(chunk);
  }

  if (secrets.length) {
    const hay = chunks.join('');
    for (const s of secrets) {
      let idx = hay.indexOf(s.value);
      while (idx >= 0) {
        // ★ 上限只压**打印条数**，**不压判据、也不许把数字说小** —— 与下面 PII 那一路同一个口径
        //   （2026-09-26 21:xx，A3 收条件）：老代码是 `while (idx >= 0 && secretHits.length <= 50)`，
        //   到上限就**停手** ⇒ 数量本身被截断，而 headline 用的就是 `secretHits.length` ⇒
        //   实测（复核线）：同一个假令牌放 60 份 ⇒ headline 报 **51**，而且**一行 ⚠ 都没有**。
        //   现在先数完（`secretTotal`），再决定印不印 ⇒ 截断由 `reportScan` 那行 ⚠ 自曝。
        secretTotal++;
        if (secretHits.length < PRINT_LIMIT) {
          const owner = offsets.find((o) => idx >= o.start && idx < o.end);
          secretHits.push({ rel: owner ? owner.rel : '(未知)', label: s.label, evidence: mask(s.value) });
        }
        idx = hay.indexOf(s.value, idx + 1);
      }
    }
  }

  // 个人信息：与密钥同一条路（本机真值源现场收集 → 在产物里逐字搜），但**边界更严**，
  // 因为 QQ 号是一串纯数字，随便搜会把 sha512 里的数字片段也算命中。
  if (pii.length) {
    const hay = chunks.join('');
    for (const p of pii) {
      const numeric = /^\d+$/.test(p.value);
      // 数字：两侧不许再挨着 base64/哈希字符；名字/路径：两侧不许再挨着字母数字下划线（躲开更长的标识符）
      const esc = p.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = numeric
        ? new RegExp(`(?:^|[^0-9A-Za-z_+/-])${esc}(?![0-9A-Za-z_+/-])`, 'g')
        : new RegExp(`(?:^|[^0-9A-Za-z_])${esc}(?![0-9A-Za-z_])`, 'g');
      for (const m of hay.matchAll(re)) {
        piiTotal++;
        // ★ 上限只压**打印条数**（别让报表失控），**不压判据、也不许把数字说小** ——
        //   所以这里用 `continue` 而不是 `break`：条不再收，但**继续数完** ⇒ `reportScan` 那行 ⚠ 能给出真实数量。
        //   起因（2026-09-26 20:0x，协调线裁决）：这个 `> 50` 让人把"51/52 处"当成精确值用过（连协调线都被绕过），
        //   实际那是**截断值**。上限不动，但**截断必须自曝**。
        //   （A3 收条件 2026-09-26 21:xx：写成 `length >= PRINT_LIMIT`，语义与老的 `> 50` **逐字等价**，只是把名字说清。）
        if (piiHits.length >= PRINT_LIMIT) continue;
        const at = m.index + (m[0].length - p.value.length);
        const owner = offsets.find((o) => at >= o.start && at < o.end);
        piiHits.push({ rel: owner ? owner.rel : '(未知)', label: p.label, evidence: mask(m[0].trim()) });
      }
    }
  }
  return { pathHits, contentHits, secretHits, secretTotal, secretTruncated: secretTotal > secretHits.length, piiHits, piiTotal, piiTruncated: piiTotal > piiHits.length, files: rels.length, bytes, secretsChecked: secrets.length, piiChecked: pii.length };
}

function reportScan(title, res) {
  // ★ 两个数**分开算**（2026-09-26 20:3x，协调线裁决）：
  //   · `hits`     = **打印条数**（受 `PRINT_LIMIT` 约束 ⇒ 可能少于真实）
  //   · `trueHits` = **真实数量**（每个家族用自己的计数器：`secretTotal` / `piiTotal`，都不受上限影响
  //                  —— 不是"打印条数 + 常量"）
  //   为什么：headline（"预检命中 N 处"）是被抄进文档、被当结论引用的那一行 ⇒ **假精确值不许留在 headline 上**；
  //   没发生截断时两者相等 ⇒ 那行**逐字不变**（别让"没截断"的场合也变样）。
  //   ★ A3 收条件（2026-09-26 21:xx，复核线判词：老口径**只对 PII 那一路成立**）：
  //   密钥那一路的 headline 里含的 `secretHits.length` 自己就被截断过（同一个假令牌放 60 份 ⇒ 报 51 且无 ⚠）
  //   ⇒ 现在两路**同一个口径**：计数器数与打印条数分开，headline 一律用计数器。
  const fixed = res.pathHits.length + res.contentHits.length + res.secretHits.length;
  const hits = fixed + res.piiHits.length;
  const trueHits = res.pathHits.length + res.contentHits.length + res.secretTotal + res.piiTotal;
  say(`【${title}】扫描 ${res.files} 个文件 / ${mb(res.bytes)}；已知密钥 ${res.secretsChecked} 条，本机个人信息 ${res.piiChecked} 条（QQ / 群号 / Windows 用户名）`);
  if (!hits) { say('  ✓ 0 处命中'); return 0; }
  for (const h of res.pathHits) say(`  ✗ [路径] ${h.rel} —— ${h.why}`);
  for (const h of res.contentHits) say(`  ✗ [内容:${h.rule}] ${h.rel}:${h.line} —— ${h.why}｜证据 ${h.evidence}`);
  for (const h of res.secretHits) say(`  ✗ [已知密钥] ${h.rel} —— 命中本机 ${h.label}（${h.evidence}）`);
  // ★ 个人信息命中：**点名文件 + 是哪个值**，但证据只给前 4 位（报告本身也可能被贴到群里）。
  //   提示里直接给出**占位写法**：这条检查最容易一批一批往外冒，写清"该写成什么样"比只说"不许出现"有用。
  for (const h of res.piiHits) {
    say(`  ✗ [个人信息] ${h.rel} —— 命中本机 ${h.label}（${h.evidence}）`
      + ` → 换成可读占位（路径写 \`C:\\Users\\<你>\\…\` / \`<仓库根>\\…\`；号写 \`<主人QQ>\` / \`<机器人QQ>\` / \`<群A>\`）`
      + `或一眼假的夹具值（10001 / 20002 / 900001）；确认它**确实该进包**就把它登记进 INCLUDE_FILES，别只是忍着红。`
      + `⚠ 往 docs\\规则与踩坑日志.md 追加内容时也照这条写 —— 那是各路最常追加的文件，也是这条规则最容易破的地方。`);
  }
  // ★ 截断必须**响亮**（2026-09-26 20:0x 加；协调线裁决："别静默截断"）：上限还在，但读数的人必须知道它不是精确值。
  //   ★ A3 收条件（2026-09-26 21:xx）：这一族口径对**两路都成立** —— 已知密钥那一路同样要自曝（以前只有 PII 有）。
  //   两条 ⚠ 各自点名家族，免得"到底是哪一路被截断了"还得猜。
  if (res.piiTruncated) {
    say(`  ⚠ 个人信息命中已达打印上限 ${PRINT_LIMIT}：**真实数量 ${res.piiTotal}**（上面只印了前 ${res.piiHits.length} 条；**headline 那个数已经是真实数量**）`
      + ` —— **截断，别把印出来的条数当精确值**；要精确就按文件看（同一份文件常被多条规则各点一次）。`);
  }
  if (res.secretTruncated) {
    say(`  ⚠ 已知密钥命中已达打印上限 ${PRINT_LIMIT}：**真实数量 ${res.secretTotal}**（上面只印了前 ${res.secretHits.length} 条；**headline 那个数已经是真实数量**）`
      + ` —— **截断，别把印出来的条数当精确值**；同一个密钥值在包里出现 N 次就会数出 N 处。`);
  }
  return trueHits;   // ★ headline（"预检命中 N 处"）报**真实数量**；没截断时与 `hits` 相等 ⇒ 那行逐字不变
}

// ── 包内附的部署说明 ───────────────────────────────────────────────────────
function noticeText(inc) {
  return `${FIRST_STEP}

DSH × QQ 机器人 · 部署包说明
生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}　生成脚本：tools\\pack-new.mjs
包内文件：${inc.length + 2} 个（源文件 ${inc.length} + 本说明 + ${MANIFEST}；逐文件清单见 ${MANIFEST}）

────────────────────────────────────────────────────────────
一、解压后第一步
    node tools\\setup-new.mjs

这个向导只问你 4 件事（其余原样用 config.example.json 的值）：
    1) 你的 QQ 号（管理员，唯一）
    2) 允许私聊机器人的 QQ 号（留空 = 跟管理员相同）
    3) 允许的群号（可留空，之后在控制台加）
    4) SnowLuma OneBot 的 accessToken（还没建就先回车留空）
它会写进 qq-bridge\\config.json（不存在就按模板新建）。
注意：白名单留空 + allowAllWhenEmpty=false ⇒ 谁都不回（新装最容易踩这条）。

    ★ 想把自己的**身份**也定死（推荐）：copy agent.config.example.json agent.config.json
      然后填 ownerQQ（你的 QQ，唯一管理员）/ botQQ（机器人 QQ，可留空=自动）/ displayName（机器人昵称，可留空=用网关昵称）。
      不填也能跑：ownerQQ 会退回 qq-bridge\\config.json 里那一份；两个地方都没有时启动会打一行 ✖ 并说清去哪儿填，
      同时管理命令、审批转达、入群审批全部不可用（fail-closed，不是静默）。
      模板 agent.config.json **不进包**（含主人的真值），进包的是 agent.config.example.json（纯占位）。

二、这个包里【故意没有】的东西（安全原因，别去找）
    ✗ qq-bridge\\state\\            —— 控制台令牌、聊天上下文、会话映射、工具日志
    ✗ qq-bridge\\config.json        —— 含 dsh.authToken / snowluma.accessToken 真值
    ✗ SnowLuma\\                    —— 第三方网关（约 100 MB，自带 node.exe），请自己去装
    ✗ SnowLuma 的 onebot_*.json / webui.json / consent.json / data\\
                                    —— OneBot token / 管理页口令哈希 / QQ 登录态（扫码产生）
    ✗ **\\credentials.json         —— 画图 / 语音转写密钥（阿里云百炼），自己申请
    ✗ backups\\、node_modules\\、.npm-cache\\、.git\\、*.log、.panels-*、.launcher-state.json
    ✗ ~\\.dsh\\.credentials.yaml、~\\.dsh\\guard\\logs\\（明文 DSH launch token）
    ✗ qq-bridge\\.npmrc             —— 原文件把 npm 缓存写死成本机路径，换机只会添乱
所以你**必须自己准备**的只有两样：
    · SnowLuma OneBot 的 accessToken（在 SnowLuma WebUI 的 OneBot 配置里生成，HTTP 与 WS 两端逐字相同）
    · 可选的画图 / 转写密钥（不配则画图与语音转写直接报缺凭据）
    DSH launch token、控制台令牌、机器人 QQ 号都是自动的，不用管。

三、接下来（完整步骤见 qq-bridge\\docs\\DSH_SETUP.md 与 docs\\部署到服务器.md）
    1) cd qq-bridge && npm install
    2) node scripts\\setup-dsh.mjs          # 装 preset + MCP + 控制台插件 + 页面面板（面板可选，装不上只警告），然后重启 DSH
    3) 起 SnowLuma：WebUI 扫码登录 QQ，建 OneBot（HTTP ${DEFAULT_PORTS.onebotHttp} / WS ${DEFAULT_PORTS.snowlumaWs}，两端 token 必须一致）
    4) node tools\\setup-new.mjs            # 拿到 token 后再跑一次，填进 config.json
    5) 一键启动.cmd                         # 家用；服务器常开见 docs\\部署到服务器.md
    6) node tools\\self-check.mjs --deep    # 验收：应 0 失败

四、已知注意点
    · 端口 / 路径 / ownerQQ / botQQ / displayName / browserMode 都在仓库根 agent.config.json 一处（P2⑦ 参数单一来源）：改端口只改它，脚本全部派生
    · 三样**身份**（ownerQQ / botQQ / displayName）没有硬编码默认值：ownerQQ 缺了会大声报错并说清填哪里；botQQ / displayName 缺了自动取（SnowLuma 的 onebot_<UIN>.json / 网关登录昵称）
    · 人设卡没有默认值：新装要自己写 qq-bridge\\roles\\<名字>.md，并在控制台角色面板里选中
    · 本包的排除口径写死在 tools\\pack-new.mjs 的白名单/黑名单里；想改就改那张表，别手工删文件
    · 交付前建议再跑一次：node tools\\pack-new.mjs --list（看将包含/排除什么）

五、安全声明
    生成时对本包产物跑过内置安全自检（路径黑名单 + sk- 密钥 / 非空 accessToken /
    passwordHash / 43 字符 base64url token / 本机真凭据逐字比对 +
    **个人信息**：本机的 QQ 号 / 群号 / Windows 用户名逐字比对），命中即删除产物并非 0 退出。
    个人信息那几条的值是**现场从本机真值源取的**（agent.config.json 的 ownerQQ/botQQ/paths、
    config.json 的 ownerQQ 与四个白名单、本机账户名与家目录），不是写死在脚本里的常量。
    自检通过 ≠ 包内绝对无敏感信息 —— 交付前请自己再翻一眼。
`;
}

// ── 打 zip / 校验 zip（走 PowerShell，PS 5.1 的路径与中文坑都在这里兜住）──
function runPs(body, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-new-ps-'));
  TEMP_DIRS.push(dir);
  const ps1 = path.join(dir, tag + '.ps1');
  const result = path.join(dir, 'result.txt');
  // PS 5.1 对无 BOM 的 UTF-8 按 ANSI 解码 → 脚本里有中文就会乱码，所以这里**必须**带 BOM
  fs.writeFileSync(ps1, '\uFEFF' + body.split('@@RESULT@@').join(q(result)) + '\n', 'utf8');
  const shell = process.env.DSH_PACK_PS || 'powershell.exe';
  let r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], {
    encoding: 'utf8', windowsHide: true,
  });
  // 受管沙箱下管道 stdio 可能 EPERM：退回 inherit（结果照样从 result.txt 读）
  if (r.error && /EPERM/i.test(String(r.error.message))) {
    r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: 'inherit', windowsHide: true });
  }
  let status = '';
  try { status = fs.readFileSync(result, 'utf8').trim(); } catch {}
  const stderr = (r.stderr || '').toString().trim();
  if (!KEEP_TEMP) fs.rmSync(dir, { recursive: true, force: true });
  TEMP_DIRS.splice(TEMP_DIRS.indexOf(dir), 1);
  if (!status) die(2, `PowerShell ${tag} 没有回执${r.error ? '（' + r.error.message + '）' : ''}${stderr ? '：' + stderr.split('\n')[0] : ''}`);
  if (!status.startsWith('OK')) die(2, `PowerShell ${tag} 失败：${status.slice(0, 300)}`);
  return status.slice(3).trim();
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function zipViaPs(stageDir, zipPath) {
  const body = [
    "$ErrorActionPreference = 'Stop'",
    `$stage = ${q(stageDir)}`,
    `$zip   = ${q(zipPath)}`,
    'try {',
    '  $parent = Split-Path -Parent $zip',
    "  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }",
    '  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }',
    '  Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal',
    '  if (-not (Test-Path -LiteralPath $zip)) { throw "zip 未生成" }',
    '  $n = (Get-Item -LiteralPath $zip).Length',
    '  [IO.File]::WriteAllText(@@RESULT@@, "OK $n")',
    '} catch {',
    '  [IO.File]::WriteAllText(@@RESULT@@, "FAIL " + $_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
  return Number(runPs(body, 'zip'));
}

function expandViaPs(zipPath, destDir) {
  const body = [
    "$ErrorActionPreference = 'Stop'",
    `$zip  = ${q(zipPath)}`,
    `$dest = ${q(destDir)}`,
    'try {',
    '  if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }',
    '  Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force',
    '  [IO.File]::WriteAllText(@@RESULT@@, "OK")',
    '} catch {',
    '  [IO.File]::WriteAllText(@@RESULT@@, "FAIL " + $_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
  return runPs(body, 'expand');
}

// PS 5.1 的 Compress-Archive（.NET Framework）把 zip 里的条目分隔符写成 `\`（ZIP 规范要求 `/`）：
// Windows 上解压看不出来，但 Linux/macOS 的 unzip 会解出 `deliver\docs\HANDOFF.md` 这种文件名。
// 这里把整包重写一遍，条目名统一成 `/`，顺便报出还剩几条没修好（>0 就拒绝交付）。
function normalizeZipViaPs(zipPath) {
  const body = [
    "$ErrorActionPreference = 'Stop'",
    `$zip = ${q(zipPath)}`,
    '$tmp = $zip + ".norm.tmp"',
    'try {',
    "  Add-Type -AssemblyName System.IO.Compression",
    "  Add-Type -AssemblyName System.IO.Compression.FileSystem",
    '  $src = [IO.Compression.ZipFile]::OpenRead($zip)',
    '  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force }',
    '  $fs  = [IO.File]::Open($tmp, [IO.FileMode]::Create)',
    '  $dst = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)',
    '  $renamed = 0',
    '  foreach ($e in $src.Entries) {',
    "    $name = $e.FullName.Replace([char]92, '/')",
    '    if ($name -ne $e.FullName) { $renamed++ }',
    '    $ne = $dst.CreateEntry($name, [IO.Compression.CompressionLevel]::Optimal)',
    '    $ne.LastWriteTime = $e.LastWriteTime',
    '    $s = $e.Open(); $d = $ne.Open()',
    '    $s.CopyTo($d); $d.Dispose(); $s.Dispose()',
    '  }',
    '  $dst.Dispose(); $fs.Dispose(); $src.Dispose()',
    '  Move-Item -LiteralPath $tmp -Destination $zip -Force',
    '  $chk = [IO.Compression.ZipFile]::OpenRead($zip)',
    "  $left = ($chk.Entries | Where-Object { $_.FullName.Contains([char]92) }).Count",
    '  $chk.Dispose()',
    '  [IO.File]::WriteAllText(@@RESULT@@, "OK $renamed $left")',
    '} catch {',
    '  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }',
    '  [IO.File]::WriteAllText(@@RESULT@@, "FAIL " + $_.Exception.Message)',
    '  exit 1',
    '}',
  ].join('\n');
  const [renamed, left] = runPs(body, 'zip-normalize').split(/\s+/);
  return { renamed: Number(renamed), left: Number(left) };
}

// ── 列目录（校验用，返回相对路径 + 大小）──────────────────────────────────
function listTree(baseDir, relPrefix = '') {
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const r = rel ? rel + '/' + e.name : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push({ rel: (relPrefix ? relPrefix + '/' : '') + r, abs, size: fs.statSync(abs).size });
    }
  };
  walk(baseDir, '');
  return out;
}

// ── 主流程 ─────────────────────────────────────────────────────────────────
const { included, excluded } = plan();
const totalBytes = included.reduce((a, f) => a + f.size, 0);

say('=== DSH × QQ 机器人 · 交付打包器（tools\\pack-new.mjs）===');
say(`仓库根：${ROOT}`);
say(`模式：${LIST || DRY ? (LIST ? '--list（只打印，不写任何文件）' : '--dry-run（只打印，不写任何文件）') : ZIP_MODE ? '打包 → zip' : '打包 → 目录'}　｜　profile：${PROFILE}${PROFILE === 'friend' ? '（★ 内部台账不进包；**搬服务器请用不带 --profile 的那次**）' : '（默认：全量，与历史口径逐字一致）'}`);
say('');

// —— 包含清单 ——
say(`【将包含】${included.length} 个文件，共 ${mb(totalBytes)}`);
const groups = new Map();
for (const f of included) {
  const top = INCLUDE_DIRS.find(([d]) => f.rel.startsWith(d + '/'))?.[0] || '(仓库根文件)';
  if (!groups.has(top)) groups.set(top, { n: 0, bytes: 0 });
  const g = groups.get(top);
  g.n++; g.bytes += f.size;
}
for (const [top, g] of groups) {
  const why = INCLUDE_DIRS.find(([d]) => d === top)?.[1] || '根目录的说明 / 启动脚本 / .gitignore';
  say(`  + ${top.padEnd(22)} ${String(g.n).padStart(4)} 个  ${mb(g.bytes).padStart(9)}   ← ${why}`);
}
if (!QUIET_FILES) {
  say('  —— 逐文件：');
  for (const f of included) say(`     ${f.rel}  (${kb(f.size)})`);
}
say('');

// —— 排除清单（按规则归并，带原因）——
say(`【已排除】${excluded.length} 项（目录按整目录计）—— 每条都带原因`);
const byRule = new Map();
for (const e of excluded) {
  if (!byRule.has(e.why)) byRule.set(e.why, []);
  byRule.get(e.why).push(e);
}
for (const [why, items] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
  const dirs = items.filter((i) => i.dir).length;
  const sample = items.slice(0, 3).map((i) => i.rel + (i.dir ? '/（整目录）' : '')).join('、');
  say(`  - ${items.length} 项${dirs ? `（其中 ${dirs} 个目录）` : ''}：${sample}${items.length > 3 ? ' …' : ''}`);
  say(`      原因：${why}`);
}
const byProfile = excluded.filter((e) => e.profile);
if (byProfile.length) {
  say(`  ★ 其中 ${byProfile.length} 项是 **profile=friend 追加排除**（默认 full 档**不会**排它们）：`);
  for (const e of byProfile) say(`      - ${e.rel}${e.dir ? '/（整目录）' : ''} —— ${e.why}`);
}
// ★ 链接**逐条列出**（2026-09-26 21:xx，A5）：上面按原因归并的那一栏每条原因最多只印 3 个样本（后面接"…"），
//   而"被 junction 顶掉的路径"恰恰是最不能漏的一条 —— 所以这里不采样，一条一条印。
const links = excluded.filter((e) => e.link);
if (links.length) {
  say(`  ★ 其中 ${links.length} 项是 **符号链接 / junction**（Windows 上 mklink /J 被 Node 报成 symlink、e.isDirectory() 为 false ⇒ 老代码会**静默跳过**它；这里逐条列出，别当没看见）：`);
  for (const e of links) say(`      - ${e.rel} —— ${e.why}`);
  // ★ 硬闸（2026-09-26 21:5x）：**列出来不够** —— 被 junction 顶掉的路径，其内容从"发现"这一层就没了，
  //   任何数量对账都看不出少了东西（同 export-a 判据⑧/⑦ 的分工）。⇒ 默认拒交付，`--allow-links` 才放行。
  if (!ALLOW_LINKS) {
    console.error(`✗ 候选树里有 ${links.length} 个链接（上面已逐条列出）⇒ **拒交付，未写任何文件**。`);
    console.error('  为什么是硬闸：junction 会整棵顶掉一个路径 —— 该带的没带、该排除的没排除，');
    console.error('  而"进包数 + 排除数"的算式**看不出**少了东西（那几份根本没被枚举到）。');
    die(4, '确认这些链接没顶掉该进包的路径、且确实不该跟进 ⇒ 用 --allow-links 显式放行');
  }
  say(`  ★ 已按**显式放行**处理 ${links.length} 个链接（--allow-links；仍然**不跟进**它们）。`);
}
say('  另有仓库里其它未列入白名单的路径（默认不进包，不逐一列出）。');
say('');

// —— 只读预检（源文件层面先扫一遍，和产物自检同一套规则）——
const secrets = collectKnownSecrets();
const pii = collectKnownPii();
let preHits = 0;
if (!NO_PRECHECK) {
  preHits = reportScan('预检（对将进包的源文件，只读）', scanTree(ROOT, included, { secrets, pii }));
  say('');
} else {
  say('【预检】已跳过（--no-precheck）\n');
}

if (LIST || DRY) {
  say(`（${LIST ? '--list' : '--dry-run'}：没有写任何文件。真打包：node tools\\pack-new.mjs --out %TEMP%\\pack-test\\）`);
  if (preHits) { warn(`预检命中 ${preHits} 处 —— 真打包会在产物自检阶段拒绝交付，先处理上面的命中项`); process.exit(3); }
  process.exit(0);
}

// —— 真打包 ——
const zipPath = ZIP_MODE ? path.resolve(OUT_RAW || DEFAULT_OUT) : '';
const outDir = ZIP_MODE ? '' : path.resolve(OUT_RAW);
const packRootName = ZIP_MODE ? path.basename(zipPath).replace(/\.zip$/i, '') : path.basename(outDir);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-new-'));
TEMP_DIRS.push(tmpRoot);
const stage = path.join(tmpRoot, 'stage', packRootName);

let artifact = ZIP_MODE ? zipPath : outDir;
let createdOutDir = false;
const fail = (msg) => { removeArtifact(); cleanup(); die(2, msg); };
function cleanup() {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
}
function removeArtifact() {
  try {
    if (ZIP_MODE) fs.rmSync(zipPath, { force: true });
    else if (createdOutDir) fs.rmSync(outDir, { recursive: true, force: true });
  } catch {}
}

try {
  if (outDir && path.resolve(outDir) === ROOT) fail('--out 不能是仓库根目录');
  if (outDir && !ZIP_MODE) {
    const parent = path.dirname(outDir);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    if (fs.existsSync(outDir)) {
      const entries = fs.readdirSync(outDir);
      if (fs.existsSync(path.join(outDir, MANIFEST))) {
        fs.rmSync(outDir, { recursive: true, force: true }); // 上一次的产物 → 整目录重建，保证幂等
      } else if (entries.length) {
        fail(`目标目录非空且不是上一次的打包产物（没有 ${MANIFEST}）：换个空目录，或先删掉 ${outDir}`);
      }
    }
    fs.mkdirSync(outDir, { recursive: true });
    createdOutDir = true;
  }

  // 1) 落暂存目录
  for (const f of included) {
    const dest = path.join(stage, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  fs.writeFileSync(path.join(stage, NOTICE), '\uFEFF' + noticeText(included), 'utf8'); // 中文 txt 给记事本留 BOM
  const manifest = {
    generator: 'tools/pack-new.mjs',
    generatedAt: new Date().toISOString(),
    root: ROOT,
    policy: 'docs/部署到服务器.md「参数清单（换人即换）」D 节',
    fileCount: 0, // 写完 files[] 立刻算（见下）——**必须在 writeFileSync 之前**，否则交付出去的那份永远是 0
    totalBytes: 0,
    files: [],
    note: 'files 列出除 pack-manifest.json 自身以外的每个文件（路径 / 大小 / sha256 前 16 位）；'
      + 'fileCount = files.length + 1（清单自身）；totalBytes = files[].bytes 之和',
  };
  for (const f of listTree(stage)) {
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(f.abs)).digest('hex').slice(0, 16);
    manifest.files.push({ path: f.rel, bytes: f.size, sha256 });
    manifest.totalBytes += f.size;
  }
  // ★ 这两个数必须在**落盘之前**算好。
  //   踩过的坑（2026-09-24，沙盒那路跑真打包实测）：原来这行写在 writeFileSync 之后 ——
  //   于是交付出去的 pack-manifest.json 里恒是 "fileCount": 0，而内存里那份是对的，
  //   下游"解压后文件数 ≠ 清单"的校验用的又是内存值 ⇒ 谁都没报错，交付的是一份假数据。
  //   症状是"字段在、但恒为 0"：这种字段比没有字段更坏（读的人会信它）。
  manifest.fileCount = manifest.files.length + 1; // + pack-manifest.json 自身（listTree 会数到它）
  fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  // 落盘后**读回来复算**（不是把上面的赋值再比一次 —— 那才是恒真）：
  // 这条断言真能红：fileCount 写晚了一行、files[] 被少算/多算、totalBytes 累加漏项，都会当场拦住。
  {
    const back = JSON.parse(fs.readFileSync(path.join(stage, MANIFEST), 'utf8'));
    const sum = back.files.reduce((a, x) => a + x.bytes, 0);
    if (!Number.isInteger(back.fileCount) || back.fileCount !== back.files.length + 1 || back.fileCount <= 0) {
      fail(`${MANIFEST} 的 fileCount 不自洽：写出去的是 ${back.fileCount}，files[] 有 ${back.files.length} 条`
        + `（应 = files.length + 1 = ${back.files.length + 1}，且必须 > 0）—— 八成是"算在写盘之后"那类错`);
    }
    if (back.totalBytes !== sum) fail(`${MANIFEST} 的 totalBytes 不自洽：写出去的是 ${back.totalBytes}，files[].bytes 之和是 ${sum}`);
    if (back.files.length === 0) fail(`${MANIFEST} 的 files[] 是空的（一个文件都没进去？）`);
  }

  // 2) 出产物
  say(`【打包】暂存 ${manifest.fileCount} 个文件 / ${mb(manifest.totalBytes)} → ${ZIP_MODE ? 'zip（PowerShell Compress-Archive）' : '目录'}`);
  if (ZIP_MODE) {
    const bytes = zipViaPs(stage, zipPath);
    say(`  产物：${zipPath}（${mb(bytes)}，PS 报告 ${bytes} 字节）`);
    const norm = normalizeZipViaPs(zipPath);
    if (norm.left) fail(`zip 里仍有 ${norm.left} 条目的路径分隔符是 \\（规范要求 /），拒绝交付`);
    if (norm.renamed) say(`  已规范化 ${norm.renamed} 个 zip 条目的路径分隔符（PS 5.1 的 Compress-Archive 会写成 \\，Linux 解压会踩坑）`);
  } else {
    for (const f of listTree(stage)) {
      const dest = path.join(outDir, f.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f.abs, dest);
    }
    artifact = outDir;
    say(`  产物：${outDir}`);
  }

  // 3) 扫描**产物**本身（zip 先解回来再扫，确保压缩没有骗我们）
  let scanBase = artifact;
  let verifyDir = '';
  if (ZIP_MODE) {
    verifyDir = path.join(tmpRoot, 'verify');
    expandViaPs(zipPath, verifyDir);
    const roots = fs.readdirSync(verifyDir).filter((n) => fs.statSync(path.join(verifyDir, n)).isDirectory());
    if (roots.length !== 1 || roots[0] !== packRootName) {
      fail(`zip 顶层结构不对：期望恰好一个顶层目录 ${packRootName}/，实际 ${JSON.stringify(fs.readdirSync(verifyDir))}`);
    }
    scanBase = path.join(verifyDir, packRootName);
    const notice = path.join(scanBase, NOTICE);
    if (!fs.existsSync(notice)) fail(`解压后找不到 ${NOTICE}`);
    const noticeTxt = fs.readFileSync(notice, 'utf8').replace(/^\uFEFF/, '');
    if (!noticeTxt.startsWith(FIRST_STEP)) fail(`${NOTICE} 开头不是「${FIRST_STEP}」`);
    if (!fs.existsSync(path.join(scanBase, MANIFEST))) fail(`解压后找不到 ${MANIFEST}`);
    const got = listTree(scanBase).length;
    if (got !== manifest.fileCount) fail(`解压后文件数 ${got} ≠ 清单 ${manifest.fileCount}（zip 可能吞了中文文件名）`);
    say(`【校验】zip 解回 ${got} 个文件，顶层目录 ${packRootName}/，${NOTICE} 与 ${MANIFEST} 都在，中文文件名完好`);
  }

  // ★ 对**交付出去的那份产物**再验一次清单（上面那次验的是暂存目录里的，这一步验的是客户拿到手的）。
  //   两种模式都过一遍：zip 解回来 / 目录直接读。判据三条，全部从产物**读回**、不是拿内存值比：
  //     ① fileCount === files.length + 1（含清单自身）且 > 0；
  //     ② fileCount === 产物里真实的文件数（"清单说几个"就必须"真有几个"）；
  //     ③ totalBytes === files[].bytes 之和。
  {
    const mf = path.join(scanBase, MANIFEST);
    if (!fs.existsSync(mf)) fail(`产物里没有 ${MANIFEST}`);
    let back = null;
    try { back = JSON.parse(fs.readFileSync(mf, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { fail(`${MANIFEST} 读不了：${e.message}`); }
    const real = listTree(scanBase).length;
    const sum = back.files.reduce((a, x) => a + x.bytes, 0);
    if (!Number.isInteger(back.fileCount) || back.fileCount !== back.files.length + 1 || back.fileCount <= 0) {
      fail(`产物 ${MANIFEST} 的 fileCount 不自洽：${back.fileCount} vs files[] ${back.files.length} 条（应 = 条数 + 1 且 > 0）`);
    }
    if (back.fileCount !== real) fail(`产物 ${MANIFEST} 说 ${back.fileCount} 个文件，实际数出来 ${real} 个`);
    if (back.totalBytes !== sum) fail(`产物 ${MANIFEST} 的 totalBytes ${back.totalBytes} ≠ files[].bytes 之和 ${sum}`);
    // 逐字段审"占位但恒空"（本次 fileCount 恒 0 就是这么来的）：每条都必须有真内容，且路径不许重复。
    // 这几条**不是**恒真断言 —— sha256 算错/漏写、path 为空、两条同路径，都会当场红。
    for (const [i, f] of back.files.entries()) {
      if (!f || typeof f.path !== 'string' || !f.path) fail(`${MANIFEST} 的 files[${i}] 没有 path`);
      if (!/^[0-9a-f]{16}$/.test(String(f.sha256 || ''))) fail(`${MANIFEST} 的 files[${i}]（${f.path}）sha256 不是 16 位十六进制：${JSON.stringify(f.sha256)}`);
      if (!Number.isInteger(f.bytes) || f.bytes <= 0) fail(`${MANIFEST} 的 files[${i}]（${f.path}）bytes 不是正整数：${JSON.stringify(f.bytes)}`);
    }
    if (new Set(back.files.map((f) => f.path)).size !== back.files.length) fail(`${MANIFEST} 的 files[] 里有重复路径`);
    for (const k of ['generator', 'generatedAt', 'policy', 'note']) {
      if (typeof back[k] !== 'string' || !back[k].trim()) fail(`${MANIFEST} 的 ${k} 是空的（占位但没内容）`);
    }
    say(`【清单校验】fileCount=${back.fileCount}（= files[] ${back.files.length} + 清单自身）、产物实有 ${real} 个文件、totalBytes ${back.totalBytes} 三者自洽；`
      + `${back.files.length} 条 path/sha256/bytes 逐条校验通过、无重复路径、generator/generatedAt/policy/note 都非空`);
  }

  say('');
  const hits = reportScan('安全自检（对产物）', scanTree(scanBase, listTree(scanBase), { secrets, pii }));

  if (hits) {
    say('');
    say('════════ 拒绝交付 ════════');
    warn(`安全自检命中 ${hits} 处疑似密钥 / 个人信息 —— 已删除产物 ${artifact}`);
    removeArtifact();
    cleanup();
    process.exit(3);
  }

  say('');
  say('✓ 自检通过：产物里没有本机已知凭据、没有 sk- 密钥、没有 43 字符 token、没有 state\\ / config.json / SnowLuma 任何东西');
  say('✓ 个人信息检查通过：产物里没有本机的 QQ 号 / 群号 / Windows 用户名（值取自 agent.config.json + config.json + 本机账户，不是写死的）');
  say(`✓ 可以交付：${artifact}`);
  say(`  包内含 ${NOTICE}（开头即「${FIRST_STEP}」）与 ${MANIFEST}（文件清单 + sha256 前 16 位）`);
  say('  再确认一次清单：node tools\\pack-new.mjs --list');
} finally {
  cleanup();
}
