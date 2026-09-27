#!/usr/bin/env node
// 工作区自检：一条命令跑完全部静态 + 运行时检查（不 spawn 子进程、默认不烧模型 token）。
//   node tools/self-check.mjs          # 常规自检
//   node tools/self-check.mjs --deep   # 额外做一次端到端回合（建 qq-chat-v2 会话问一句，消耗 API token）
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// 「QQ 已迁服务器」三态判据的唯一口径（与 tools\dsh-prompt.ps1 的 Test-QqNotLocal 同路径同语义）
import { qqMovedToServer, judgeQqPort, judgeTokenSync, QQ_MOVED_REL } from './qq-moved.mjs';
import { countTopLevelEntries } from './top-level-transient.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const GUARD = path.join(HOME, 'guard', 'logs');
const CONFIG = path.join(ROOT, 'qq-bridge', 'config.json');
const DEEP = process.argv.includes('--deep');
// --fix-bom：只补 .ps1 的 UTF-8 BOM（见下面 5.10）。为什么值得有一条命令：
// 编辑工具（write/edit）每次都会剥掉 BOM，而 PS 5.1 读无 BOM 的 UTF-8 会按 ANSI 解析 ⇒ 满屏假语法错；
// 这个坑 2026-09-23~24 已经有 5 批人各踩过一次，每次都要手写一遍 PowerShell 才知道怎么补。
const FIX_BOM = process.argv.includes('--fix-bom');
// --update-port-baseline：把"当前还在硬编码端口"的那批**存量**重新登记进棘轮基线
// （只该在"迁掉一批"或"确认新增是合理的"之后跑；见下面 5.13）。
const UPDATE_FLAG = process.argv.includes('--update-port-baseline');
// ★ 镜像 ROOT 容错（2026-09-26 21:5x，复核线实测；协调线"第 4 条"的前置）：`createRequire` 只吃**绝对路径**，
//   而"镜像夹具法"会把 ROOT 指到别处（甚至 cwd 相对）⇒ 老写法**当场抛 ERR_INVALID_ARG_VALUE** ⇒
//   一次**正当的复核操作**变成一台**假红发生器**（崩不是判据）。⇒ 缺 `qq-bridge\package.json`（镜像常见）
//   就**明确跳过**依赖它的判据并说明原因，**不崩**。
const REPO_PKG = path.resolve(ROOT, 'qq-bridge', 'package.json');
const requireFromRepo = fs.existsSync(REPO_PKG) ? createRequire(REPO_PKG) : null;
const requireOrSkip = (id) => { if (!requireFromRepo) return null; try { return requireFromRepo(id); } catch { return null; } };

// ── 环境层（agent.config.json）在这里也是唯一来源：端口一律从 config-lib 派生 ──────────
// 自检自己不能抄一份端口（否则"改一个端口只需改一处"当场失效，而且这条自检恰恰要抓这个）。
// ★ 同一条容错：镜像 ROOT 里没有 `qq-bridge\src\`（或依赖装不全）⇒ **跳过端口类判据**，
//   并说清"跳过 ≠ 通过"，**不崩**（理由同上：复核镜像法是正当操作，崩就是假红发生器）。
let envMod = null; let bridgeCfg = null; let PORTS = {};
try {
  envMod = await import(new URL('../qq-bridge/src/config-lib.js', import.meta.url).href);
  try { bridgeCfg = envMod.loadConfig(); }
  catch (e) { console.log(`  ⚠️  qq-bridge/config.json 读不了（端口退回环境层/默认值）：${e.message}`); }
  PORTS = envMod.effectivePorts(bridgeCfg ?? {}, envMod.loadEnvConfig({ announce: 'none' }));
} catch (e) {
  console.log(`  ⚠️  qq-bridge/src/config-lib.js 加载不了（镜像 ROOT 里没有它／依赖装不全）：${e.message}`);
  console.log('  ⚠️  ⇒ **端口类判据本次跳过**（跳过 ≠ 通过；这条只影响端口，不影响 tools\\ 形状网）');
}


let fails = 0, warns = 0;
const ok = (t) => console.log(`  ✅ ${t}`);
const warn = (t) => { warns++; console.log(`  ⚠️  ${t}`); };
const bad = (t) => { fails++; console.log(`  ❌ ${t}`); };
const head = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 46 - t.length))}`);

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const hasBom = (f) => { const b = fs.readFileSync(f); return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf; };
// 注意：判"纯 ASCII"要先剥掉 BOM——BOM 本身是 U+FEFF，会让 naive 检查误报（踩过）。
const isAscii = (f) => !/[^\x00-\x7F]/.test(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const portOpen = (port, timeout = 800) => new Promise((res) => {
  const s = net.connect({ port, host: '127.0.0.1' });
  const done = (v) => { s.destroy(); res(v); };
  s.setTimeout(timeout);
  s.once('connect', () => done(true));
  s.once('timeout', () => done(false));
  s.once('error', () => done(false));
});

// ── 1. 运行时端口 / 令牌 / QQ ────────────────────────────────────────────────
head('运行时');
// ★ 「QQ 已迁服务器」第三态（2026-09-26）：主人把 QQ 那套搬到服务器之后，本地这只 SnowLuma
//   **故意不跑**（起了会抢号，见 docs\HANDOFF.md §服务器）⇒ 那三个端口"没在监听"从**红**变成**预期**。
//   判据 = 标记文件 qq-bridge\qq-moved-to-server，与 tools\dsh-prompt.ps1 的 Test-QqNotLocal
//   同路径、同读法（口径只写在 tools\qq-moved.mjs 一处）。
//   为什么这不是"把红改绿"：**标记在 + 端口在听 = 本机在抢号**，那一支仍然是 ❌ ——
//   第三态是把一个真问题从噪声红里捞出来，不是把红刷成绿。
//   反向对照（"指着不存在的标记文件 ⇒ 真停摆照样红"）在 tools\test-self-check-qq-moved.mjs。
const qqMoved = qqMovedToServer();
// ★ 镜像容错（2026-09-26 21:5x）：envMod 加载不了 ⇒ 端口表是空的 ⇒ 拿 `undefined` 去 connect **当场崩**
//   （实测 `ERR_MISSING_ARGS`）。⇒ 明确跳过并说清"跳过 ≠ 通过"，**不崩**（复核镜像法是正当操作）。
if (!envMod) {
  warn('运行时端口判据**本次跳过**（config-lib 加载不了 ⇒ 没有端口表可比；**跳过 ≠ 通过**）');
} else for (const [name, p, qqSide] of [
  ['DSH Web', PORTS.dshWeb, false],
  ['SnowLuma WS', PORTS.snowlumaWs, true],
  ['OneBot HTTP', PORTS.onebotHttp, true],
  ['SnowLuma 管理页', PORTS.snowlumaWeb, true],
  ['桥接控制台', PORTS.bridgeConsole, false],
]) {
  const verdict = judgeQqPort({ name, port: p, open: await portOpen(p), qqSide, moved: qqMoved });
  verdict.ok ? ok(verdict.text) : bad(verdict.text);
}

let cfg = null;
try { cfg = readJson(CONFIG); ok('qq-bridge/config.json 可解析（已剥 BOM）'); }
catch (e) { bad(`qq-bridge/config.json 读不了：${e.message}`); }

let files = [];
try {
  files = fs.readdirSync(GUARD).filter((n) => /^server-.*\.out\.log$/.test(n))
    .map((n) => ({ n, m: fs.statSync(path.join(GUARD, n)).mtimeMs })).sort((a, b) => b.m - a.m);
} catch { /* 目录不存在 */ }
const latestToken = files.length
  ? (fs.readFileSync(path.join(GUARD, files[0].n), 'utf8').match(/[?&]token=([A-Za-z0-9_-]{20,})/)?.[1] ?? '')
  : '';
if (!latestToken) bad('最新 guard 日志里没有启动令牌（DSH 是刚起的吗？）');
else {
  // ★ 第二处同族第三态（2026-09-26）：token 同步本来是 tools\start-all.ps1 的活，而「只开 DSH」入口
  //   故意不跑它 ⇒ 本地 QQ 已迁服务器时"日志新 token ≠ config.json 旧 token"是**预期**。
  //   判据同样只在 tools\qq-moved.mjs 一处（judgeTokenSync）；标记不在时它仍然是真红。
  const tokenVerdict = judgeTokenSync({
    synced: Boolean(cfg) && latestToken === cfg.dsh?.authToken,
    moved: qqMoved,
    sourceLabel: files[0].n,
    latestLabel: latestToken.slice(0, 8),
    cfgLabel: String(cfg?.dsh?.authToken ?? '').slice(0, 8),
  });
  tokenVerdict.ok ? ok(tokenVerdict.text) : bad(tokenVerdict.text);
}

if (qqMoved) {
  // 同族假红（一起收）：搬走之后本地**没有 OneBot 网关** ⇒ 这个探针恒 `fetch failed`
  // （原来每次一条 ⚠️，一天一条躺在日志里，读的人会以为"QQ 出问题了"）。
  // 不是把警告藏起来：本机真要判 QQ 死活，走服务器侧那一路（qq-login-alert / tools\watch-qq-login.mjs）。
  ok(`QQ 状态查询跳过（QQ 已迁服务器 ${QQ_MOVED_REL}，本地无网关；判 QQ 死活走服务器侧）`);
} else if (cfg?.snowluma?.httpUrl) {
  try {
    const r = await fetch(`${cfg.snowluma.httpUrl}/get_login_info?access_token=${encodeURIComponent(cfg.snowluma.accessToken || '')}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const j = await r.json();
    j?.status === 'ok' ? ok(`QQ 在线：${j.data?.nickname} (${j.data?.user_id})`) : warn(`QQ 未就绪：${JSON.stringify(j).slice(0, 120)}`);
  } catch (e) { warn(`QQ 状态查询失败：${e.message}`); }
}

// ── 2. 启动链静态校验（路径、BOM、ASCII）────────────────────────────────────
head('启动链');
// ★ 入口路径可被**测试覆盖**（`DSH_SELFCHECK_ENTRY_CMD`）：反向对照要在**夹具**上跑判据，
//   而不是去动主人那个真文件（与 `DSH_SELFCHECK_QQ_MOVED_FILE` 同一惯例；生产上没人设它 ⇒ 就是真入口）。
const entry = process.env.DSH_SELFCHECK_ENTRY_CMD
  ? path.resolve(process.env.DSH_SELFCHECK_ENTRY_CMD)
  : path.join(ROOT, '一键启动.cmd');
const startAll = path.join(ROOT, 'tools', 'start-all.ps1');
const logRun = path.join(ROOT, 'tools', 'log-run.ps1');
const marker = path.join(ROOT, '.git');
for (const [label, f] of [['一键启动.cmd', entry], ['tools/start-all.ps1', startAll], ['tools/log-run.ps1', logRun]]) {
  fs.existsSync(f) ? ok(`${label} 存在`) : bad(`${label} 缺失：${f}`);
}
if (fs.existsSync(entry)) {
  const t = fs.readFileSync(entry, 'utf8');
  t.includes('tools\\start-all.ps1') ? ok('入口 cmd 指向 tools\\start-all.ps1') : bad('入口 cmd 没有指向 tools\\start-all.ps1');
  isAscii(entry) ? ok('入口 cmd 是纯 ASCII（cmd 解析安全）') : bad('入口 cmd 含非 ASCII 字符');
  // ★ .cmd 三条硬判：**纯 ASCII** ＋ **无 BOM** ＋ **全 CRLF**（2026-09-26 定稿）。
  //   为什么 CRLF：cmd.exe 逐行解析裸 LF 的批处理时，`goto :label` 这类跳转是**已知会出怪事**的地方
  //   （而"编辑工具写出来是 LF"这条我自己刚踩过：新写的 tools\push-to-server.cmd 全是裸 LF）。
  //   ★ 2026-09-26 收成 **`tools\*.cmd` 全扫**（原来是**写死 3 个文件名**的名单 —— 硬编码名单的失效方式
  //   就是"新文件默认没人看"：实测 `tools\dsh-window.cmd`（128 行）与 `tools\sandbox-check.cmd`（48 行）
  //   **全裸 LF，却从来没有判据看过**）。全扫本身就是棘轮：以后任何新加的 `tools\*.cmd` 自动进判据。
  {
    // ★ 全扫范围 = **`tools\*.cmd` ＋ 根目录 `*.cmd`**（2026-09-26 两次收口）：
    //   ① 原来写死 3 个文件名 ⇒ 硬编码名单的失效方式就是"新文件默认没人看"：实测 `tools\dsh-window.cmd`（128 行）
    //      与 `tools\sandbox-check.cmd`（48 行）**全裸 LF，却从来没有判据看过**；
    //   ② 收成 `tools\*.cmd` 之后，根目录又剩一处真空：**`只开DSH.cmd`（当时新加的"只开 DSH"入口，`d7a191e`）
    //      一条判据都没有** —— 而它是主人当时每天要双击的那个文件。⇒ 根目录一并纳入。
    //      ★ 2026-09-27：该入口已按主人要求**撤除**（`git rm 只开DSH.cmd`，改走命令行 `tools\dsh-only.ps1`）
    //      —— 但**根目录全扫这条判据保留**：根目录还有 `一键启动.cmd` / `起控制面.cmd`，
    //      而且它就是"以后任何新加的 `.cmd` 自动进判据"这条棘轮的覆盖面。
    //   全扫本身就是棘轮：以后任何新加的 `.cmd`（无论放 tools\ 还是根目录）**自动进判据**。
    const cmdDirs = [path.join(ROOT, 'tools'), ROOT];
    const cmds = cmdDirs
      .filter((d) => fs.existsSync(d))
      // ⚠ **已知边界（不是漏判据，是刻意没扩）**：`readdirSync` **不递归** ⇒ `tools\` **子目录**里的
      //   `.cmd` 不在判据内（2026-09-26 小镜全仓扫过：当天除 `tools\` 与根目录外**没有任何真 `.cmd`**）。
      //   裁决 = 这次**不递归**（递归会把夹具/第三方目录里的 `.cmd` 拉进来造假红）；**以后真出现再扩**。
      //   边界同时写在 `docs\启动与踩坑.md` 的「.cmd 规矩」那条 —— 别让它变成**静默**缺口。
      .flatMap((d) => fs.readdirSync(d).filter((n) => /\.cmd$/i.test(n)).map((n) => path.join(d, n)))
      .sort();
    // ★ **显式例外（不是漏）**：根目录 `一键启动.cmd` = **主人的入口**，它归主人、改它要点头
    //   ⇒ 它的 ASCII 在上面单独硬判、CRLF **只 warn**（见下面那段）。**不把它丢进这里的硬判**，
    //   是为了别让"他双击的那个文件"变成每天的硬红、再经 `tools\daily-check.mjs` 推到他手机上。
    //   除它以外（含 `只开DSH.cmd` 与 tools\ 下全部）**一律硬判**。
    const exempt = (f) => path.dirname(f) === ROOT && path.basename(f) === path.basename(entry);
    const judged = cmds.filter((f) => !exempt(f));
    // ⚠ 行尾判据必须用 `latin1` 读，**别用 `ascii`**：Node 的 `'ascii'` 解码会**把最高位清 0**
    //   ⇒ `0x8A` 解出来就是 `\n`（小镜实测 `Buffer.from([0x8a]).toString('ascii') === "\n"`）
    //   ⇒ 非 ASCII 的 `.cmd` 会**同时**拿到"含非 ASCII"红 **＋ 一条假的"裸 LF"红**，还附上误导性的修法提示。
    const lf = (f) => /(?<!\r)\n/.test(fs.readFileSync(f, 'latin1'));
    const hasBom = (f) => { const b = fs.readFileSync(f); return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf; };
    const rel = (list) => list.map((f) => path.relative(ROOT, f)).join('、');
    const short = (list) => list.map((f) => path.relative(ROOT, f)).join('、');
    if (!judged.length) {
      bad('一个 .cmd 都没扫到（tools\\ ＋ 根目录）—— 全扫的判据可能取错了目录，别让它静默变绿');
    } else {
      const lfOnes = judged.filter(lf);
      const nonAscii = judged.filter((f) => !isAscii(f));
      const bomOnes = judged.filter(hasBom);
      lfOnes.length === 0
        ? ok(`${judged.length} 个 .cmd（tools\\ ＋ 根目录，除主人入口）全是 CRLF 行尾（${short(judged)}）`)
        : bad(`${lfOnes.length} 个 .cmd 是裸 LF 行尾（cmd.exe 解析不安全）：${rel(lfOnes)}（修：node tools\\cmd-bytes.mjs <文件> --fix）`);
      nonAscii.length === 0
        ? ok(`${judged.length} 个 .cmd 都是纯 ASCII（cmd 按 OEM 码页解析，中文会炸）`)
        : bad(`.cmd 含非 ASCII 字符：${rel(nonAscii)}`);
      bomOnes.length === 0
        ? ok(`${judged.length} 个 .cmd 都没有 BOM（cmd 会把 BOM 当命令解析）`)
        : bad(`.cmd 带了 BOM（cmd 会把 BOM 当命令解析）：${rel(bomOnes)}`);
    }
    // 主人的入口（根目录 `一键启动.cmd`）：**ASCII 在上面硬判、BOM 在下面单独硬判** ⇒ 这里只管 CRLF，且**只 warn**。
    // ⚠ 文案里**不写行数/goto 处数**：写死的数一定会过期（原来写"88 行 + 6 处 goto"，
    //   2026-09-26 实测是 **11 处 goto / 4 个标签**），要说过期不了的，就只说"这是已知隐患"。
    if (lf(entry)) warn('一键启动.cmd 是裸 LF 行尾 —— 历史遗留、今天能用，但这是已知隐患；要改成 CRLF 请先经主人/协调线点头（别擅自改主人的入口文件）');
    else ok('一键启动.cmd 是 CRLF 行尾（主人入口，单独判：ASCII/BOM 硬判 + CRLF 只 warn）');
    // ★ 入口的 **BOM 单独硬判**（2026-09-26 补；小镜按提交字节复核 + 替身仓库真跑抓到的洞）：
    //   上面那个"例外"把入口摘出了 `judged` ⇒ 批量那条 BOM 硬判**够不着它**；而 ASCII 那条用的
    //   `isAscii()` 是"**先剥 BOM 再判**" ⇒ **BOM 正好从两侧漏过**（实测：给入口加上 `EF BB BF`，
    //   整份自检输出与基线**逐行对照 0 处不同** —— 那是"**不判**"，不是"少红一条"）。
    //   ⇒ 例外只该豁免**口径**（CRLF 只 warn），**绝不该豁免判据**：这里只判字节，不动 CRLF 的口径。
    hasBom(entry)
      ? bad('一键启动.cmd 带了 BOM（cmd 会把 BOM 当命令解析）')
      : ok('一键启动.cmd 没有 BOM（主人入口：单独判字节）');
  }
}
if (fs.existsSync(startAll)) {
  const t = fs.readFileSync(startAll, 'utf8');
  hasBom(startAll) ? ok('start-all.ps1 带 UTF-8 BOM（PS 5.1 中文不乱码）') : bad('start-all.ps1 丢了 BOM，中文会乱码');
  // 三个面板页（DSH / 控制台 / SnowLuma）由 tools\panels.ps1 统一开关；启动器必须真的调它，
  // 否则又回到"每次重启叠三个标签页、只能手动关"（主人 2026-09-23 专门提过这件事）。
  const panelsScript = path.join(ROOT, 'tools', 'panels.ps1');
  if (fs.existsSync(panelsScript)) {
    ok('tools/panels.ps1 存在（面板开关）');
    hasBom(panelsScript) ? ok('panels.ps1 带 UTF-8 BOM') : bad('panels.ps1 丢了 BOM，中文注释会乱码');
    t.includes('panels.ps1') ? ok('start-all.ps1 会调用 panels.ps1 管面板') : bad('start-all.ps1 没有调用 panels.ps1，重启会继续叠标签页');
  } else {
    warn('找不到 tools/panels.ps1（面板自动开关）；启动器会退回旧方式打开页面');
  }
  t.includes('$Root\\tools\\log-run.ps1') ? ok('start-all.ps1 调用 tools\\log-run.ps1') : bad('start-all.ps1 里的 log-run 路径不对');
  /DSH\\start-all\.ps1|DSH\\log-run\.ps1|\$Root\\log-run\.ps1/.test(t) ? bad('start-all.ps1 里还残留旧的根目录路径') : ok('没有残留旧路径');
}
// ★ 点名那个"主人的窗口脚本"（2026-09-25 晚加）：它丢了 BOM 的代价跟别的脚本不一样 ——
//   `dsh-prompt.ps1` 是常驻窗口的守窗器，PS 5.1 会把无 BOM 的 UTF-8 按 ANSI 读 ⇒ **332 处解析错误**
//   ⇒ 窗口整条坏掉（当晚真实事故：编辑工具剥了 BOM，桥接与控制面跟着全断）。5.10 其实已按"所有 .ps1"
//   扫，但那条只在**总量**上说话；这里点名 + 写清后果，免得下次失败信息里看不出是谁。
{
  const dshPrompt = path.join(ROOT, 'tools', 'dsh-prompt.ps1');
  if (fs.existsSync(dshPrompt)) {
    hasBom(dshPrompt)
      ? ok('tools/dsh-prompt.ps1 带 UTF-8 BOM（守窗器；丢了 PS 5.1 会按 ANSI 读 ⇒ 满屏假语法错、窗口整条坏）')
      : bad('tools/dsh-prompt.ps1 丢了 BOM ⇒ PS 5.1 按 ANSI 读 ⇒ 窗口守窗器整条坏掉（2026-09-25 真实事故）。一条命令补回：node tools\\self-check.mjs --fix-bom');
  } else {
    warn('找不到 tools/dsh-prompt.ps1（窗口守窗器被改名/挪走了？）');
  }
}
if (fs.existsSync(logRun)) {
  isAscii(logRun) ? ok('log-run.ps1 是纯 ASCII（管道 + PS 5.1 安全）') : bad('log-run.ps1 含非 ASCII 字符');
  fs.readFileSync(logRun, 'utf8').includes('Out-File -Encoding utf8') ? ok('log-run.ps1 仍用 Out-File -Encoding utf8') : bad('log-run.ps1 的写入方式被改了（桥接会抓不到令牌）');
}
fs.existsSync(marker) ? ok('.git 项目根标记存在（子目录会话也加载 AGENTS.md）') : warn('.git 标记不存在：子目录会话不会加载根 AGENTS.md');

// ── 3. preset（YAML + agent-instructions + DSH 名单）────────────────────────
head('preset');
const yaml = requireOrSkip('js-yaml');
if (!yaml) {
  warn('preset 的 YAML 判据**本次跳过**（镜像 ROOT 缺 qq-bridge\\node_modules ⇒ 没有 js-yaml）—— **跳过 ≠ 通过**');
} else for (const [label, dir] of [['源', path.join(ROOT, 'qq-bridge', 'dsh', 'agent-presets')], ['已安装', path.join(HOME, '.agent-presets')]]) {
  for (const name of ['qq-chat-v2']) {
    const f = path.join(dir, name, 'agent.cordis.yml');
    if (!fs.existsSync(f)) { bad(`${label} ${name}: 文件缺失`); continue; }
    try {
      const doc = yaml.load(fs.readFileSync(f, 'utf8'));
      const ids = Array.isArray(doc) ? doc.map((r) => r?.id) : [];
      ids.includes('agent-instructions') ? ok(`${label} ${name}: YAML OK，含 agent-instructions`) : bad(`${label} ${name}: 缺少 agent-instructions`);
    } catch (e) { bad(`${label} ${name}: YAML 解析失败 ${e.message}`); }
  }
}
let api;
try {
  const { NodeApiClient, unwrap, discoverDshLaunchToken } = await import(new URL('../qq-bridge/src/dsh-client.js', import.meta.url).href);
  api = new NodeApiClient(cfg?.dsh?.baseUrl ?? envMod.loopbackHttp(PORTS.dshWeb), undefined,
    { token: cfg?.dsh?.authToken || discoverDshLaunchToken(), header: cfg?.dsh?.authHeader, prefix: cfg?.dsh?.authPrefix });
  const list = unwrap(await api.agentPresets.list({}), 'agentPresets/list');
  const ids = (Array.isArray(list) ? list : (list?.presets ?? [])).map((p) => p.id ?? p.presetId ?? p.name);
  ['qq-chat-v2'].every((n) => ids.includes(n))
    ? ok(`DSH 名单含 qq-chat-v2（共 ${ids.length} 个 preset）`)
    : bad(`DSH 名单缺 preset：${ids.join(', ')}`);
} catch (e) { bad(`DSH API 连接失败：${e.message}`); }

// ── 4. 文档与状态 ───────────────────────────────────────────────────────────
head('文档与状态');
for (const f of ['AGENTS.md', 'docs/文件清单.md', 'docs/启动与踩坑.md', 'docs/规则与踩坑日志.md', path.join(HOME, 'AGENTS.md')]) {
  const p = path.isAbsolute(f) ? f : path.join(ROOT, f);
  fs.existsSync(p) ? ok(`${path.relative(ROOT, p)} 存在（${fs.statSync(p).size} B）`) : warn(`${p} 不存在`);
}
try {
  const notes = fs.readFileSync(path.join(ROOT, 'docs', '规则与踩坑日志.md'), 'utf8').split('\n').filter((l) => l.startsWith('- '));
  ok(`规则与踩坑日志 ${notes.length} 条（最新：${notes.at(-1)?.slice(2, 40)}…）`);
} catch { warn('读不到 docs/规则与踩坑日志.md'); }
try {
  const s = readJson(path.join(ROOT, 'qq-bridge', 'state', 'sessions.json'));
  ok(`桥接现有 QQ 会话映射 ${Object.keys(s.sessions ?? s).length} 个`);
} catch { warn('读不到 qq-bridge/state/sessions.json'); }
try {
  const mode = readJson(path.join(ROOT, 'qq-bridge', 'state', 'mode.json'));
  ok(`桥接当前模式 ${mode.mode}${mode.closedAgentPreset ? `（closedAgentPreset=${mode.closedAgentPreset}）` : ''}`);
} catch { warn('读不到 qq-bridge/state/mode.json'); }

// 4.5 生效配置摘要：把「文档/控制台说的」与「config.json 里真正生效的」摆在一起。
// 动机：agentPreset 有两条来源且是「优先 + 回退」关系（reserved2 用 socialV2.agentPreset，
// 为空才回退顶层 agentPreset），只改一个却以为改了另一个是很容易犯的错。
try {
  const cfg = readJson(path.join(ROOT, 'qq-bridge', 'config.json'));
  const v2 = cfg.socialV2 ?? {};
  const tools = (v2.tools && typeof v2.tools === 'object') ? v2.tools : {};
  const on = Object.entries(tools).filter(([, v]) => v === true).map(([k]) => k);
  const off = Object.entries(tools).filter(([, v]) => v === false).map(([k]) => k);
  const groups = (cfg.allow?.groups ?? []).length;
  const priv = (cfg.allow?.private ?? []).length;
  ok(`生效 preset：顶层 ${cfg.agentPreset || '(空)'} → reserved2 用 ${v2.agentPreset || '(回退顶层)'} · owner=${cfg.ownerQQ || '(未设)'}`);
  ok(`白名单：群 ${groups} / 私聊 ${priv}（allowAllWhenEmpty=${cfg.allowAllWhenEmpty === true}）· 工具开关 开 ${on.length} / 关 ${off.length}`);
  if (off.length) ok(`已关工具：${off.join(', ')}`);
  if (groups === 0 && priv === 0 && cfg.allowAllWhenEmpty !== true) warn('白名单为空且 allowAllWhenEmpty=false —— 所有 QQ 会话都会被拒（fail-closed）');
  if (!cfg.ownerQQ) warn('ownerQQ 未设置 —— 管理命令与审批挂起无人可处理');
} catch (e) { warn(`读不到 qq-bridge/config.json：${e.message}`); }

// ── 5. 结构不变量（防文档漂移 / 防测试残留堆积）──────────────────────────────
// 把「只写在文档里的约定」变成可执行断言。踩过的坑：AGENTS.md / 文件清单.md 里硬编码
// 的行数、文件数、MCP 数全部过期，新会话一读就被误导；state\ 下 6 类测试残留越堆越多；
// assets\deepseek娘.png 丢了没人发现，qq_get_self_image 一直 404。
head('结构不变量');

// 5.1 结构快照是否新鲜
// 判据是「快照里记的数字」，不是 mtime：任何编辑都会动 mtime，但只要数字没变，快照就没过期。
// （改一个错别字也报"过期"，只会让人学会忽略警告 —— 那才是假警告真正的危害。）
// 数字来自快照自己写进 docs/结构快照.md **末尾**的 `<!-- snapshot-digest {…} -->`：
// 同一个值只有一处实现（structure-snapshot.mjs 算，这里只负责复算比对）。
// 兼容：没有 digest 行的老快照 ⇒ 退回 mtime 判据；digest 行存在但解析不了（被手改坏）⇒ 出声警告。
const snapKb = (bytes) => (bytes / 1024).toFixed(1); // 与快照 kb() 同口径：体积类数字按**它的显示精度**比，
//   否则"改一个错别字"就会因 1 字节差异报过期 —— 那正是要消灭的假警告。
const SNAP_LABELS = {
  topLevelEntries: '顶层条目数',
  toolsFiles: 'tools 递归文件数',
  agentsMdBytes: 'AGENTS.md 体积',
  srcFiles: 'qq-bridge/src 文件数',
  srcLines: 'qq-bridge/src 总行数（按 LF）',
  bridgeLines: 'bridge.js 行数（按 LF）',
  scriptFiles: 'qq-bridge/scripts 顶层文件数',
  scriptFilesRecursive: 'qq-bridge/scripts 递归文件数',
};
const snapFmt = (k, v) => (k === 'agentsMdBytes' ? `${snapKb(v)} KB` : String(v));
// 复算 digest 里的同一批数字。口径必须与 structure-snapshot.mjs 严格一致：
// src / scripts 顶层只数 isFile（不含子目录）；tools / scripts 递归不跟随符号链接、
// 跳过 node_modules 这类被排除目录；行数一律按 LF(0x0A) 计。
function currentSnapNumbers() {
  const countFiles = (dir, skip) => {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) n++;
      else if (e.isDirectory() && !skip.has(e.name)) n += countFiles(path.join(dir, e.name), skip);
    }
    return n;
  };
  const lf = (f) => { const b = fs.readFileSync(f); let n = 0; for (const c of b) if (c === 0x0a) n++; return n; };
  const topNames = (dir) => fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  const srcDir = path.join(ROOT, 'qq-bridge', 'src');
  const scriptsDir = path.join(ROOT, 'qq-bridge', 'scripts');
  const srcNames = topNames(srcDir);
  return {
    // ★ 顶层条目数**不算瞬态条目**（`.launcher-state.json` / `.panels-state.json`：工具在根目录建的本地一次性状态、
    //   用完即删 ⇒ 数进去这条判据会自己红绿）。名单与理由的唯一口径 = `tools\top-level-transient.mjs`，
    //   生成器（structure-snapshot.mjs）调的是同一个函数 —— 只改一边会在两种状态下各红一次。
    topLevelEntries: countTopLevelEntries(ROOT),
    toolsFiles: countFiles(path.join(ROOT, 'tools'), new Set(['node_modules', '.npm-cache', 'SnowLuma'])),
    agentsMdBytes: fs.statSync(path.join(ROOT, 'AGENTS.md')).size,
    srcFiles: srcNames.length,
    srcLines: srcNames.reduce((a, n) => a + lf(path.join(srcDir, n)), 0),
    bridgeLines: lf(path.join(srcDir, 'bridge.js')),
    scriptFiles: topNames(scriptsDir).length,
    scriptFilesRecursive: countFiles(scriptsDir, new Set()),
  };
}
try {
  const snapPath = path.join(ROOT, 'docs', '结构快照.md');
  const snapMs = fs.statSync(snapPath).mtimeMs;
  const snapText = fs.readFileSync(snapPath, 'utf8');
  // 老格式的 mtime 判据：只在快照没有 digest 行时用（兼容旧文件，别删）
  const byMtime = () => {
    const watched = ['AGENTS.md', 'qq-bridge/src', 'qq-bridge/scripts', 'tools'].flatMap((p) => {
      const abs = path.join(ROOT, p);
      try { return fs.statSync(abs).isDirectory() ? fs.readdirSync(abs).map((n) => path.join(abs, n)) : [abs]; }
      catch { return []; }
    }).filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    const newest = watched.map((p) => ({ p, m: fs.statSync(p).mtimeMs })).sort((a, b) => b.m - a.m)[0];
    if (!newest || newest.m <= snapMs) ok('docs/结构快照.md 是最新的（老格式无 digest 行，按 mtime 判）');
    else warn(`结构快照已过期：${path.relative(ROOT, newest.p)} 比它新 —— 跑 node tools\\structure-snapshot.mjs`);
  };
  // 定位 digest：认 `<!-- snapshot-digest` 这个**开场标记**，取最后一处（digest 恒在文件末尾，
  // 正文里提这个名字不算）。开场标记在、里面的数字对象坏了 ⇒ **出声**——绝不能因为"解析不了"
  // 就退回 mtime：那等于把被手改坏的文件静默当成新鲜（只有整行都没了，才算老格式）。
  const openers = [...snapText.matchAll(/<!--\s*snapshot-digest/g)];
  const digTail = openers.length ? snapText.slice(openers[openers.length - 1].index) : null;
  const payload = digTail ? (digTail.match(/\{[^\n]*\}/)?.[0] ?? null) : null;
  let digest = null;
  let digestErr = null;
  if (payload) { try { digest = JSON.parse(payload); } catch (e) { digestErr = e.message; } }
  if (!digTail) {
    byMtime();
  } else if (!digest || typeof digest !== 'object' || !digest.numbers || typeof digest.numbers !== 'object') {
    warn(`docs/结构快照.md 末尾的数字指纹解析不了（${digestErr ?? '那一行没找到 {…} 数字对象'}）—— 文件可能被手改坏，跑 node tools\\structure-snapshot.mjs 重生成`);
  } else {
    let cur = null;
    try { cur = currentSnapNumbers(); } catch (e) { warn(`复算结构数字失败：${e.message}（无法判断快照是否新鲜）`); }
    if (cur) {
      const diffs = [];
      let compared = 0;
      for (const [k, now] of Object.entries(cur)) {
        const was = digest.numbers[k];
        if (was === undefined || was === null) continue; // 快照那次该段不可用：不把"未知"当"过期"
        compared++;
        if (k === 'agentsMdBytes' ? snapKb(was) !== snapKb(now) : was !== now) {
          diffs.push(`${SNAP_LABELS[k] ?? k} ${snapFmt(k, was)} → ${snapFmt(k, now)}`);
        }
      }
      if (diffs.length) warn(`结构快照已过期：${diffs.join('；')} —— 跑 node tools\\structure-snapshot.mjs`);
      else ok(`docs/结构快照.md 数字与工作区一致（比了 ${compared} 个数字，不看 mtime）`);
    }
  }
} catch (e) { warn(`docs/结构快照.md 读不了：${e.message} —— 跑 node tools\\structure-snapshot.mjs 生成`); }

// 5.2 MCP 挂载：cordis.patch.yml 指向的入口文件必须都存在（改文件名/挪目录最容易漏）
try {
  const patch = fs.readFileSync(path.join(HOME, 'profiles', 'web', 'cordis.patch.yml'), 'utf8');
  const problems = []; let mounts = 0;
  for (const block of patch.split('- insert:').slice(1)) {
    const id = block.match(/id:\s*([\w-]+)/)?.[1] ?? '?';
    const entry = block.match(/args:[\s\S]*?'([^']+\.js)'/)?.[1];
    if (!entry) { problems.push(`${id} 没解析出入口路径`); continue; }
    mounts++;
    if (!fs.existsSync(entry)) problems.push(`${id} → ${entry} 不存在`);
  }
  problems.length ? bad(`MCP 挂载有问题：${problems.join('；')}`) : ok(`${mounts} 个 MCP 挂载的入口文件都在`);
} catch (e) { warn(`读不到 cordis.patch.yml：${e.message}`); }

// 5.3 AGENTS.md 是每会话固定成本，超预算就该把长细节挪进 docs/
// ⚠ 预算 2026-09-25 由 8192 → **9216 B（9 KB）**，理由（不许悄悄改，写在这里）：同一天加了下面 5.3b 那条
//   「大文档先拿目录再读一节 + 各文件整读代价」的硬规则（约 0.9 KB）—— 它挡的是**整读 334 KB 日志 = 107k token**
//   这类错误，实测比这 1 KB 的注入成本值钱得多。**9 KB 是新的上限**：再涨就得先按 §5 把长细节下沉 `docs\`。
try {
  const size = fs.statSync(path.join(ROOT, 'AGENTS.md')).size;
  size <= 9216 ? ok(`AGENTS.md ${size} B（预算 9 KB）`) : warn(`AGENTS.md 已 ${size} B，超过 9 KB 预算 ⇒ 把长细节挪进 docs/（§5 维护约定）`);
} catch { bad('AGENTS.md 不存在（每会话自动注入的索引，不能删）'); }

// 5.3b **入口文档体积棘轮**（2026-09-25 加）：这两份是"每会话都要读"的活文档，
//   涨过触发线就不能当入口用了（读过的人只会去追流水、不会读待办）⇒ **出声**并指到下沉办法。
//   为什么只 warn 不 bad：真的在做大活时它们会合法地涨；但**出声**是必须的，别让人无声无息地把入口撑爆。
//   阈值依据（2026-09-25 实测）：HANDOFF 在 71 KB 时已明显不能当入口（它自己的维护须知也这么写）；
//   优化清单 200 KB 里已有 122 KB 是"已闭的历史批次"（那批已搬去 优化清单-archive.md）。
try {
  const entryDocs = [
    ['docs/HANDOFF.md', 50 * 1024, '按它自己「维护」那段的方案 A 下沉（做法见 规则与踩坑日志.md 的「HANDOFF 下沉的做法」那条）'],
    ['docs/优化清单.md', 90 * 1024, '把「✅ 已完成」那类已闭批次搬去 docs\\优化清单-archive.md（同一条做法）'],
  ];
  const sizes = [];
  for (const [rel, limit, how] of entryDocs) {
    const bytes = fs.statSync(path.join(ROOT, rel)).size;
    sizes.push(`${path.basename(rel)} ${(bytes / 1024).toFixed(1)} KB`);
    if (bytes > limit) warn(`入口文档该瘦身了：${rel} 已 ${(bytes / 1024).toFixed(1)} KB（触发线 ${limit / 1024} KB）⇒ ${how}`);
  }
  ok(`入口文档体积：${sizes.join(' ｜ ')}（触发线 HANDOFF 50 KB / 优化清单 90 KB）`);
} catch (e) { warn(`入口文档体积检查失败：${e.message}`); }

// 5.4 自画像资源：bridge.js:3964 硬编码读这个路径，没有就 404
const selfImg = path.join(ROOT, 'qq-bridge', 'assets', 'deepseek娘.png');
fs.existsSync(selfImg)
  ? ok('qq-bridge/assets/deepseek娘.png 存在（qq_get_self_image 可用）')
  : bad('缺 qq-bridge/assets/deepseek娘.png —— qq_get_self_image 会 404');

// 5.9 文档里的限额数字必须等于 config（2026-09-23 踩过：config 改成 6 次/30 分钟，
// RULES.md 还写着"2 次/24 小时、≥2 小时"，而 RULES 自称冲突时以它为准 → 操作员按错的规划）
//
// 2026-09-23 二次审查：这条原来**只读 RULES.md**，而同一个数字在 HANDOFF 与角色卡里也各写了一份
// —— 实测 HANDOFF §4 表写着旧的"2 次/24h、间隔 ≥2h"，同文另一处却是"6 次/24h、30min"，
// 自己跟自己矛盾，而自检报"一致"。现在改成扫全部"陈述现状"的文档。
// 注意**不扫** `规则与踩坑日志.md`（只追加的历史记录，里面的旧数字是史实）与 `优化清单.md`
// （审查记录，会引用当时的错值）。
try {
  let cfgRaw = fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8');
  if (cfgRaw.charCodeAt(0) === 0xfeff) cfgRaw = cfgRaw.slice(1);
  const cfg = JSON.parse(cfgRaw);
  const avatar = cfg?.socialV2?.avatar ?? {};
  const expectedHours = Number(avatar.minIntervalMs) > 0 ? Number(avatar.minIntervalMs) / 3600000 : null;
  const DOCS = [
    ['qq-bridge/RULES.md', 'RULES.md'],
    ['docs/HANDOFF.md', 'docs/HANDOFF.md'],
    ['qq-bridge/roles/小鲸鱼.md', 'roles/小鲸鱼.md'],
  ];
  const drift = [];
  let scanned = 0;
  for (const [rel, label] of DOCS) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) continue;
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      // 只认**提到头像**的行：限额数字散落在别名/签名等别的桶上，全扫会大量误报
      if (!line.includes('头像')) return;
      scanned += 1;
      const perDay = line.match(/(\d+)\s*次\s*\/\s*24\s*(?:小时|h)/i);
      if (perDay && Number(perDay[1]) !== Number(avatar.maxPerDay)) {
        drift.push(`${label}:${index + 1} 写 ${perDay[1]} 次/24h，config 是 ${avatar.maxPerDay}`);
      }
      if (expectedHours === null) return;
      const interval = line.match(/(?:≥|间隔)\s*≥?\s*(\d+(?:\.\d+)?)\s*(小时|h|分钟|min)(?![0-9a-zA-Z])/i);
      if (!interval) return;
      const unit = interval[2].toLowerCase();
      const got = unit.startsWith('分') || unit === 'min' ? Number(interval[1]) / 60 : Number(interval[1]);
      if (Math.abs(got - expectedHours) > 0.01) {
        drift.push(`${label}:${index + 1} 写间隔 ${interval[1]}${interval[2]}，config 是 ${expectedHours} 小时`);
      }
    });
  }
  drift.length
    ? warn(`文档限额与 config 漂移：${drift.join('；')}（改文档或改 config，别让两边说法不一致）`)
    : ok(`文档里的头像限额与 config 一致（扫了 ${DOCS.length} 份文档 ${scanned} 行含"头像"的行）`);
} catch (e) { warn(`限额一致性检查失败：${e.message}`); }

// 5.10 所有 .ps1 必须是 UTF-8 **带 BOM**：PowerShell 5.1 对无 BOM 脚本按 ANSI 解码，
// 中文注释会乱码并把后面的字符串吃掉，报出 "Unexpected token ')'" 这类完全找不到北的
// 解析错误。2026-09-23 踩过：用编辑工具改 start-all.ps1（红线：必须带 BOM）会**把 BOM
// 剥掉**，而且改的当下不报错 —— 属于"改的时候没事、下次启动才炸"的雷，所以放进自检。
// ── 「正在飞的工件」年龄门槛（2026-09-26 加，优化线小锤）─────────────────────────
// 为什么：同一仓库里**多条线并发跑**（今天四条），任何"按文件存在与否判红"的判据都会撞上兄弟线
//   **正在飞的探针** —— 实测（2026-09-26 18:1x）：小镜的手工夹具 `qq-bridge\state\_tmp\.fx8f-parse2.ps1`
//   让下面 5.10（缺 BOM）与 5.12c（`_tmp` 里的可复用脚本）**同时红 2 条**，一分钟后它自己消失、复跑又全绿。
//   假红会经 `tools\daily-check.mjs`（每天 09:00）推到主人手机 ⇒ 白叫醒他一次。
// 口径：`_tmp\` 里的这两条判据**只对存在超过 TMP_GRACE_MINUTES 分钟的条目出声**。
//   代理指标 = **mtime**：Windows 的 birthtime 复制/移动后不可靠，而 mtime 探针自己也能设 ⇒ 才能被反向对照精确构造。
//   ⚠ **门槛不会把真残留一起放过**：真残留会一直在 ⇒ 过了门槛**照样红**（代价 = 晚 10 分钟，远小于每天推一条假警告）。
//   ⚠ 顺带避开一个更糟的动作：`--fix-bom` 也跳过"在飞"的文件 —— 去改兄弟线正拿在手里的夹具，比不改更坏。
//   ⚠ 这条门槛只管 `_tmp\`：`tools\` / `qq-bridge\src\` 这些**要发出去**的脚本照旧**当场判**（它们不"飞"）。
//   `DSH_SELFCHECK_TMP_GRACE_MIN=0` ⇒ 关掉门槛（退回"不看年龄"的旧口径；诊断与反向对照用）。
const TMP_GRACE_MINUTES = (() => {
  const raw = process.env.DSH_SELFCHECK_TMP_GRACE_MIN;
  if (raw === undefined || raw.trim() === '') return 10;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 10;
})();
const TMP_DIR = path.join(ROOT, 'qq-bridge', 'state', '_tmp');
const relInTmp = (p) => {
  const r = path.relative(TMP_DIR, p);
  return r && !r.startsWith('..') && !path.isAbsolute(r) ? r : null;
};
// 「在飞」= 在 `_tmp\` 里、且 mtime 距今不到门槛（读不到 mtime ⇒ 不当作在飞 = 照旧判，宁严勿松）
const flyingInTmp = (p) => {
  if (relInTmp(p) === null) return false;
  try { return (Date.now() - fs.statSync(p).mtimeMs) / 60000 < TMP_GRACE_MINUTES; } catch { return false; }
};

// ★ 口径（2026-09-25 晚明确）：**凡 `.ps1` 一律要求 BOM**（含纯 ASCII 的 —— 比"只要求含非 ASCII 的"
//   更严，代价为零，而且省掉"这个文件要不要 BOM"的判断）；这条网覆盖 `tools\` 下每一个脚本，
//   包括**主人的窗口守窗器 `tools\dsh-prompt.ps1`**（它被剥 BOM 那晚，窗口整条坏掉 —— 正是这条网
//   该提前抓住的事故）。覆盖面另有一条棘轮（`qq-bridge\scripts\test-control-restart-stack.mjs` ⑧：
//   本检查自报的 .ps1 数量必须等于测试自己独立走一遍树数出来的数量）。
// ── `.ps1` 覆盖面：**唯一一条走法**，5.10（BOM 网）与 5.10b（真解析）共用 ─────────────
//   判据集 = **活代码**（任意深度）；★ **记录 / 草稿区不判、也不修**（协调线 2026-09-26 21:0x 裁决 ⓑ）——
//   范围 = `**\archive\**` · `**\_archive\**` · `**\_tmp\**`；理由一句话：
//   **`--fix-bom` 去"修"一份归档的坏副本 = 把物证洗了**，而记录区本来就不该被任何工具改写。
//   ⚠ 只限**这条 BOM 网**：5.12c（`_tmp` 里可复用的脚本该挪走）是另一条判据，不受影响。
//   ⚠ 不静默：下面每次都会印一行"记录区另有 N 个 .ps1 有意不判不修" —— 让人看得见它们不在网里。
const PS1_SKIP = /[\\/](node_modules|SnowLuma|\.npm-cache|backups|\.git)[\\/]/;
const PS1_RECORD = /[\\/](archive|_archive|_tmp)[\\/]/i;
function collectPs1() {
  const live = []; const record = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (PS1_SKIP.test(p)) continue;
      if (e.isDirectory()) walk(p);
      else if (e.name.toLowerCase().endsWith('.ps1')) (PS1_RECORD.test(p + path.sep) ? record : live).push(p);
    }
  };
  walk(ROOT);
  return { live, record };
}
try {
  const skip = PS1_SKIP;
  const { live: scripts, record: recordScripts } = collectPs1();
  // ★ 2026-09-26 20:5x：**去掉了深度上限**（原来是「深度超过 3 就整枝返回」）。
  //   ⚠ 注释里**故意不写出那段代码的字面**：`test-control-restart-stack.mjs` ⑧ 有一条静态断言
  //     「源码里不许再出现深度上限」——写出来会把那条断言自己弄红（踩过一次的同类坑）。
  //   起因（协调线 ③）：执行线实测 `tools\panels-check.ps1` 被剥 BOM ⇒ 376 行语法错，怀疑 `--fix-bom` 没覆盖它。
  //   实测真相：**深度 ≤3 的都覆盖**（拿"故意剥掉 BOM 的 `tools\` 副本"验过：补回了 `EF BB BF`）；
  //   但 **depth >3 的 .ps1 一个都不在网里** —— 同一个探针放进 `qq-bridge\state\_archive\tmp-2026…\`（depth 4）
  //   就**补不回来**。深层脚本可以是真脚本（插件子目录、部署子目录）⇒ 这条网不该有深度上限。
  //   代价实测为零：去掉上限后 coverage 28 → 29，多出来那个本来也带 BOM 且能解析 ⇒ 一个都不变红。
  //   ★ 21:0x 再按 ⓑ 把**记录区**从判据集里摘出去（只数不判）⇒ 判据集回到 **28 个活代码** ＋ 记录区若干。
  //   （外部还有一条棘轮：`qq-bridge\scripts\test-control-restart-stack.mjs` ⑧ —— 它是**独立副本 ＋ 数量对撞
  //     ＋ 源码文本对钉**（**不是**共享同一个函数：说法别写成"共用一处规则"；复核线实测过"两边一起窄时
  //     数量照样相等"，所以对撞之外还得钉源码字面）。）
  const noBomAll = scripts.filter((p) => {
    const b = fs.readFileSync(p);
    return !(b.length > 2 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf);
  });
  // ⚠ 年龄门槛（`flyingInTmp`）在这条网里**已成空转**：`_tmp\` 现在整个在判据集之外（见上面 ⓑ 那段），
  //   所以 `noBom` 里不会再有 `_tmp` 的路径。这里保留一次过滤只为"万一哪天又把 `_tmp` 放回来"时不出事。
  const noBom = scripts.filter((p) => {
    const b = fs.readFileSync(p);
    return !(b.length > 2 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) && !flyingInTmp(p);
  });
  // ★ 不静默（协调线 ⓑ 判据③）：把"记录/草稿区里有几个 .ps1 是**有意不判不修**的"印出来 ——
  //   让人看得见它们不在网里，而不是以为网很大。
  if (recordScripts.length) {
    ok(`记录/草稿区另有 ${recordScripts.length} 个 .ps1 **有意不判不修**（物证/半成品，改了会让人对不上账）：${recordScripts.map((p) => path.relative(ROOT, p)).join('、')}`);
  }
  if (!noBom.length) {
    ok(`${scripts.length} 个 .ps1 都带 UTF-8 BOM`);
  } else if (!FIX_BOM) {
    bad(`${noBom.length} 个 .ps1 缺 UTF-8 BOM（PS 5.1 会按 ANSI 读 → 中文注释炸解析）：${noBom.map((p) => path.relative(ROOT, p)).join('、')} —— 一条命令补回：node tools\\self-check.mjs --fix-bom`);
  } else {
    // ★ --fix-bom 只做一件事：在文件最前面补上 EF BB BF，**文件内容一个字节都不改**。
    //   不做语法检查、不做格式化 —— 补完请复跑一次自检确认（那时 5.10 与 5.10b 会同时给出结论）。
    //   ⚠ 记录/草稿区**根本不进 `scripts`** ⇒ 归档的坏副本不会被"修"（那是物证）。
    const fixed = [];
    for (const p of noBom) {
      try {
        const b = fs.readFileSync(p);
        fs.writeFileSync(p, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), b]));
        fixed.push(path.relative(ROOT, p));
      } catch (e) { warn(`补 BOM 失败：${path.relative(ROOT, p)} —— ${e.message}`); }
    }
    if (fixed.length) warn(`已补 UTF-8 BOM：${fixed.join('、')}（只在最前面加了 3 字节，内容没动）—— **请复跑一次自检**确认`);
  }
} catch (e) { warn(`.ps1 BOM 检查失败：${e.message}`); }

// 5.10b ★ 补 BOM「之后」还要**真解析一遍**（2026-09-26 20:5x 加；协调线 ③ 判据②：`[scriptblock]::Create((Get-Content -Raw <f>))`）。
//   为什么 5.10 不够：它只看**前三个字节** ⇒ 管不住两种情况 ——
//     ① BOM 明明在、**内容被编辑器搞坏**（那天 `panels-check.ps1` 的症状就是"376 行语法全错"）；
//     ② 补 BOM 这个动作**成功**了，但脚本本来就解析不过。
//   实测（本机 PS 5.1，把 `tools\panels-check.ps1` 的 BOM 剥掉当副本）：
//     · 无 BOM ⇒ `[scriptblock]::Create((Get-Content -Raw …))` **抛错**、引擎解析错误 **75 条**；
//     · `--fix-bom` 补回 `EF BB BF` ⇒ **CREATE_OK / 0 条**。
//   ⚠ 必须用 **powershell.exe（5.1）**：无 BOM 时 5.1 按 ANSI 解码才会炸；`pwsh`（7）默认 UTF-8，抓不到这一类。
//   ⚠ 起不来（沙箱/换机器/没有 Windows PowerShell）⇒ 只 warn **不红** —— 别把"环境缺 PowerShell"报成"脚本坏了"。
try {
  const { live: psScripts } = collectPs1();   // ★ 与 5.10 **同一条走法**（记录/草稿区同样不判）
  if (psScripts.length) {
    const q = (s) => `'${s.replace(/'/g, "''")}'`;
    const cmd = `$bad=@(); foreach($f in @(${psScripts.map(q).join(',')})){ try { [void][scriptblock]::Create((Get-Content -Raw -LiteralPath $f)) } catch { $bad += ($f + ' :: ' + ($_.Exception.Message -split [char]10)[0]) } }; if($bad.Count){ 'PARSEFAIL'; $bad } else { 'PARSEOK' }`;
    const log = path.join(ROOT, 'qq-bridge', 'state', '_tmp', 'self-check-parse.log');
    let out = '', code = null, spawnErr = '';
    try {
      fs.mkdirSync(path.dirname(log), { recursive: true });
      const fd = fs.openSync(log, 'w');   // ⚠ stdio 走文件 fd（受限沙箱里管道路由会 EPERM，本族已知坑）
      const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', cmd], { cwd: ROOT, stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      out = fs.readFileSync(log, 'utf8');
      code = r.status;
      if (r.error) spawnErr = String(r.error.code || r.error.message);
    } catch (e) { spawnErr = e.message; }
    if (spawnErr) warn(`.ps1 解析检查跳过：起不来 powershell.exe（${spawnErr}）—— 这不是"脚本坏了"，是有环境没有 Windows PowerShell`);
    else if (/PARSEFAIL/.test(out)) {
      const items = out.split('\n').filter((l) => l.includes(' :: ')).map((l) => l.trim());
      bad(`${items.length} 个 .ps1 **解析不过**（PS 5.1 按当前编码读不了 ⇒ 窗口/启动链会整条坏）：`
        + items.slice(0, 3).join(' ｜ ') + `${items.length > 3 ? ` ｜ …共 ${items.length} 个` : ''}`
        + ` —— 常见原因 = 编辑工具剥了 BOM（先 ` + '`node tools\\self-check.mjs --fix-bom`' + `）或写坏了编码`);
    } else if (/PARSEOK/.test(out)) {
      ok(`${psScripts.length} 个 .ps1 用 PS 5.1 真解析全过（\`[scriptblock]::Create\`，补 BOM 之后的有效性判据）`);
    } else {
      warn(`.ps1 解析检查没拿到结论（退出码 ${code}）—— 请看 ${path.relative(ROOT, log)}`);
    }
  }
} catch (e) { warn(`.ps1 解析检查失败：${e.message}`); }

// 5.11 SnowLuma 窗口噪音治理（2026-09-23）：它把「群/私聊撤回」「read ECONNRESET」按
// WARN 写出去，每次桥接重启/每次撤回都刷屏。做法是两条独立级别里只压"窗口"那条：
// start-all.ps1 启动前设 SNOWLUMA_LOG_LEVEL=error（文件那条保持 debug，排查不受影响），
// 另有 tools\snowluma-log-level.ps1 可运行时查/改。这里守住这三处别被改回去。
try {
  const startAll = fs.readFileSync(path.join(ROOT, 'tools', 'start-all.ps1'), 'utf8');
  const envSet = /SNOWLUMA_LOG_LEVEL\s*=\s*'error'/.test(startAll);
  const fileDebug = /SNOWLUMA_LOG_FILE_LEVEL\s*=\s*'debug'/.test(startAll);
  const helper = fs.existsSync(path.join(ROOT, 'tools', 'snowluma-log-level.ps1'));
  // 已在运行的 SnowLuma 吃不到新环境变量，所以 start-all 还得在「端口已监听」分支里
  // 调一次运行时接口对齐（否则手动重启过 SnowLuma 之后窗口又开始刷 WARN）。
  const runtimeAlign = /snowluma-log-level\.ps1/.test(startAll);
  let uiLevels = null;
  try { uiLevels = readJson(path.join(ROOT, 'SnowLuma', 'config', 'ui.json'))?.pages?.logs?.visibleLevels ?? null; } catch { /* 第三方配置读不到不算错 */ }
  const uiNoWarn = uiLevels === null ? null : !uiLevels.includes('warn');
  const drift = [];
  if (!envSet) drift.push('start-all.ps1 没设 SNOWLUMA_LOG_LEVEL=error（重启 SnowLuma 后窗口又开始刷 WARN）');
  if (!fileDebug) drift.push('start-all.ps1 没显式 SNOWLUMA_LOG_FILE_LEVEL=debug（日志文件该保持完整）');
  if (!helper) drift.push('tools\\snowluma-log-level.ps1 不见了（运行时查/改级别要靠它）');
  if (!runtimeAlign) drift.push('start-all.ps1 没在「SnowLuma 已在运行」分支里调用 snowluma-log-level.ps1（手动重启过 SnowLuma 后窗口又会刷 WARN）');
  if (uiNoWarn === false) drift.push('SnowLuma\\config\\ui.json 的 visibleLevels 又把 warn 放回来了');
  drift.length
    ? warn(`SnowLuma 窗口噪音治理漂移：${drift.join('；')}`)
    : ok(`SnowLuma 窗口只留 error（环境变量 + ${uiLevels === null ? 'ui.json 读不到' : 'ui.json 不含 warn'}）`);
} catch (e) { warn(`SnowLuma 日志级别检查失败：${e.message}`); }

// 5.12 测试脚本不许"只写不删"地动生产图库 state\draws（2026-09-23 拆批次 4 时补的静态不变量）。
// 这个坑踩过三次：渲染类测试、梗图底图、test-avatar —— 最后一次每次 `npm test` 往图库漏 2 张，
// 累积到 18 张（与测试生成图 sha256 逐字节相同的孤儿图）才被人肉发现。运行时守卫在
// `qq-bridge/scripts/test-all.mjs`（逐套件比对图库文件集合），这里补的是**静态**那一半：
// 任何写 DRAWS_DIR 的测试脚本，必须同时出现清理调用。
try {
  const dir = path.join(ROOT, 'qq-bridge', 'scripts');
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!text.includes('DRAWS_DIR')) continue;
    const writes = /(?:writeFileSync|copyFileSync)\([^)]*DRAWS_DIR/.test(text);
    if (!writes) continue;
    // 光有清理调用不够（随便一个 rmSync 就能骗过）：必须注册**退出兜底**，
    // 否则断言失败/抛异常的半路退出照样把孤儿图留在图库里 —— test-avatar 就是这么漏的。
    const cleans = /(?:unlinkSync|rmSync)/.test(text);
    const exitHook = /process\.on\('exit'/.test(text);
    if (!cleans) offenders.push(`${name}（没有清理调用）`);
    else if (!exitHook) offenders.push(`${name}（缺退出兜底 process.on('exit')）`);
  }
  offenders.length
    ? bad(`这些测试往 state\\draws 写文件却没有清理（测试产物该写 state\\_tmp）：${offenders.join(', ')}`)
    : ok('写图库的测试脚本都带清理调用');
} catch (e) { warn(`扫描测试脚本失败：${e.message}`); }

// 5.12b 测试脚本也不许"只写不删"地往 state\_tmp 里堆产物（2026-09-24 补，和 5.12 是同一个坑的另一半）。
// 图库那半边修好之后，`_tmp` 这半边又长回来了：手工清到 12 个文件，跑一遍 npm test 又冒出 30 个 /
// 1.73 MB —— test-tts-lib / test-tts-tone / test-board-lib / test-diagram-lib / test-meme-lib
// 各写各的产物、谁也不删，而"忘了清"在单测全绿时完全看不出来。
// 规矩：产物写 `state\_tmp\` 没问题，但必须交给 `scripts/tmp-dir.mjs` 托管（退出兜底只留一份），
// 或者自己带清理调用 **加** `process.on('exit')` —— 只写不删、或者清理只在正常路径上，都算不合格。
try {
  const dir = path.join(ROOT, 'qq-bridge', 'scripts');
  const offenders = [];
  for (const name of fs.readdirSync(dir).filter((n) => /^test-.*\.mjs$/.test(n))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!/['"]_tmp['"]/.test(text)) continue;
    const writes = /(?:writeFileSync|appendFileSync|copyFileSync|openSync)\s*\(/.test(text);
    if (!writes) continue;
    const viaHelper = /from '\.\/tmp-dir\.mjs'/.test(text) && /(?:testTmpDir|tmpCleanup)\s*\(/.test(text);
    if (viaHelper) continue;
    const cleans = /(?:unlinkSync|rmSync)/.test(text);
    const exitHook = /process\.on\('exit'/.test(text);
    if (!cleans) offenders.push(`${name}（没有清理调用）`);
    else if (!exitHook) offenders.push(`${name}（缺退出兜底 process.on('exit')）`);
  }
  offenders.length
    ? bad(`这些测试往 state\\_tmp 写文件却不清理（改法：用 scripts/tmp-dir.mjs 的 testTmpDir/tmpCleanup）：${offenders.join(', ')}`)
    : ok('写 _tmp 的测试脚本都会自己清干净（tmp-dir 托管或自带退出兜底）');
} catch (e) { warn(`扫描 _tmp 写入者失败：${e.message}`); }

// 5.12c `_tmp` 里只许有产物，不许有可复用脚本（2026-09-24 补；小鲸鱼 01:34 同意"收编 live 脚本"时提的）。
// 为什么：`_tmp` 是"随时可清"的目录，脚本放这儿等于下次清理就没了 —— 实测留给"下次复现用"的控制台
// 双写探针就是这么被清掉的，只能重写一遍。规矩：代码进 `scripts\`（仓库工具 / 活体验证）或
// `tools\`（运维与自检探针）；`_tmp` 只留产物：日志、txt、png、备份 md、状态 json。
try {
  const tmp = path.join(ROOT, 'qq-bridge', 'state', '_tmp');
  const CODE_EXT = /\.(mjs|js|cjs|ps1|cmd|bat)$/i;
  const strayAll = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (CODE_EXT.test(e.name)) strayAll.push(p);
    }
  };
  if (fs.existsSync(tmp)) walk(tmp);
  // ★ 年龄门槛：只对**存在超过 TMP_GRACE_MINUTES 分钟**的出声（"在飞"的多半是兄弟线的探针，见文件上方那段口径）
  const stray = strayAll.filter((p) => !flyingInTmp(p)).map((p) => path.relative(tmp, p));
  const flying = strayAll.filter((p) => flyingInTmp(p)).map((p) => path.relative(tmp, p));
  const flyNote = flying.length ? `（另有 ${flying.length} 个 <${TMP_GRACE_MINUTES} 分钟的"在飞"脚本本轮不判：${flying.join(', ')}）` : '';
  if (!stray.length && !flying.length) {
    ok('state\\_tmp 里只有产物、没有可复用脚本（代码都在 scripts\\ / tools\\）');
  } else if (!stray.length) {
    ok(`state\\_tmp 里没有陈旧的脚本；${flying.length} 个是 <${TMP_GRACE_MINUTES} 分钟的"在飞"文件、按门槛本轮不判：${flying.join(', ')}`);
  } else {
    bad(`state\\_tmp 里有 ${stray.length} 个可复用脚本（该进 scripts\\ 或 tools\\；_tmp 只留产物）：${stray.join(', ')}${flyNote}`);
  }
} catch (e) { warn(`扫描 _tmp 里的脚本失败：${e.message}`); }

// 5.13 端口单一来源（P2⑦）—— **棘轮**：只拦新增，不拦存量。
// 为什么要有：`3080/3100/3101/3000/3001/5099` 原来散在十几个脚本里，改一个端口要满仓库找；
// 漏掉一个的症状是"某个脚本连不上 / 杀不掉 / 探错端口"，跟配置写错长得一模一样，极难定位。
// 现在端口只有两处**定义**（都不是脚本）：仓库根 `agent.config.json` + `config-lib.js` 里那份
// 唯一默认表；其余全部派生（.mjs 用 `config-lib` 的 loadConfig()/effectivePorts()，
// .ps1 用 `tools\env-config.ps1` 的 Get-AgentPorts）。
//
// 为什么是棘轮而不是"一次清零"：迁移要跨好几轮，而**一个长期红着、谁也清不掉的自检，
// 正是这个项目一直在消灭的东西**（假警告真正的危害是让人学会忽略警告）。所以：
//   · 新增硬编码 ⇒ **失败**（点名文件:行 + 正确做法）；
//   · 存量被迁掉 ⇒ 只是一句**正向**提示（"又少了几处"）；
//   · 存量原样不动 ⇒ 通过。
// 存量基线：`tools\port-literal-baseline.json`（由 `--update-port-baseline` 生成）。
//
// **为什么按"行内容指纹"而不是行号匹配**：行号会因为任何一次编辑（哪怕在上面加一行注释）
// 整体漂移 ⇒ 天天误报"新增硬编码"，那种假警告比不检查更坏。所以指纹 = 该行 trim 后把端口
// 数字统一替换成 `#port#` 的文本，并按文件分组计数：编辑别处不影响，而"同一行多写了一个端口"
// 仍然会因为计数变大被拦下。代价：**同一行内容被改写**（哪怕只是挪了位置）会被当成新的一处 ——
// 这条我们认：那一行确实动了，值得看一眼，要么按提示派生、要么 `--update-port-baseline` 收下。
const PORT_ALLOW_FILE = new Map([
  // `tools/ops.mjs` 原来在这张白名单里（理由："归另一个 agent，等它解锁后再收敛"）—— 2026-09-24 晚
  // 它那张端口表（3080/3001/3000/5099/3100）与两处 `|| 3100` 兜底已经改成 `resolvePorts()`，
  // 于是**撤掉白名单**：这个文件现在被棘轮正常盯着（白名单每撤一个，棘轮就多守一处）。
  ['qq-bridge/scripts/test-env-config.mjs', '这一份就是"钉默认值"的回归测试：里面的端口字面量**正是被测对象**（改前实测值），派生掉就等于什么都没测']
]);
const PORT_BASELINE_FILE = path.join(ROOT, 'tools', 'port-literal-baseline.json');
try {
  // ★ 镜像容错（2026-09-26 21:5x）：config-lib 加载不了 ⇒ 拿不到默认端口表 ⇒ 这条判据**没法判**：
  //   明确写成"跳过 ≠ 通过"（让它走本节的 catch 说清楚），**不崩**。
  if (!envMod) throw new Error('config-lib 加载不了 ⇒ 硬编码端口棘轮**本次跳过**（跳过 ≠ 通过）');
  const roots = [path.join(ROOT, 'tools'), path.join(ROOT, 'qq-bridge', 'scripts')];
  // `_archive` 是**冻结的历史脚本**（含 2026-09-23 编码损坏的那批），跟 docs\HANDOFF-archive.md 同类：
  // 不再维护、也不会有人跑，翻新它们没有收益只会制造 diff。
  const SKIP_DIR = new Set(['node_modules', '.npm-cache', 'SnowLuma', 'backups', '.git', 'state', '_tmp', '_archive']);
  const CODE_EXT = /\.(mjs|cjs|js|ps1|cmd|bat)$/i;
  // 扫哪些数字**从默认表/生效端口派生**，本文件一个端口字面量都不抄：
  // 默认六个 + 当前生效的六个（万一有人把端口改成 4000，脚本里写死 4000 同样要抓）。
  const WANTED = [...new Set([...Object.values(envMod.DEFAULT_PORTS), ...Object.values(PORTS)])].map(String);
  const portRe = new RegExp(`(?<![\\d\\w.])(?:${WANTED.join('|')})(?![\\d\\w])`);
  const portReG = new RegExp(portRe.source, 'g');
  // ── 判据：这批数字里既可能是**端口**，也可能是**毫秒** ─────────────────────────────
  // `3000` 出现在 `setTimeout(fn, 3000)` / `sleep(3000)` / `AbortSignal.timeout(3000)` /
  // `cfg.timeoutMs || 3000` / `3000 * 2 ** n` 里都不是端口。只看数字会把这些全判成
  // "新增硬编码端口"（**假阳性**），而假阳性的代价是实测过的：2026-09-24 晚有人为了让它闭嘴，
  // 把 `AbortSignal.timeout(3000)` 改写成 `3 * 1000` —— 检查器看不见了，下一个写 `timeout(3000)`
  // 的人还会撞上、还会学同样的绕法。**所以修判据，不修被检查的代码**。
  // 三条"不是端口"的上下文，都能一句话解释，也各有反例/正例（回归网 scripts\test-port-literal-judge.mjs）：
  //   ① 取时长的调用实参：`setTimeout/setInterval(fn, <数字>)`、`sleep/delay/wait/AbortSignal.timeout(<数字>)`
  //   ② 毫秒字段/变量之后（可带 ) | & + - * / < > = ! , : 等）：`cfg.longGapMaxMs) || 3000`
  //   ③ 乘除运算的操作数：`3000 * 2`、`3 * 1000`（端口永远不会被乘除）
  // 真正的端口写法（`?? 3100`、`listen(3100)`、`'…:3100'`、`= 3080`、`port: 3100`）三条都不沾 ⇒ 照抓。
  const DURATION_ARG_BEFORE = /(?:\b(?:set|clear)?Timeout|\b(?:set|clear)Interval)\s*\(.*,\s*$|(?:\bsleep|\bdelay|\bwait|\.timeout)\s*\(\s*$/i;
  const MS_FIELD_BEFORE = /[A-Za-z_$][\w$]*[Mm]s\b[\s)]*(?:[|&+\-*/<>!=]=?|[,:])*\s*$/;
  const isPortLiteralAt = (line, index, text) => {
    const before = line.slice(0, index);
    const after = line.slice(index + text.length);
    if (DURATION_ARG_BEFORE.test(before)) return false;
    if (MS_FIELD_BEFORE.test(before)) return false;
    if (/^\s*[*/]/.test(after) || /[*/]\s*$/.test(before)) return false;
    return true;
  };
  const hasPortLiteral = (line) => {
    const re = new RegExp(portRe.source, 'g');
    let m;
    while ((m = re.exec(line))) { if (isPortLiteralAt(line, m.index, m[0])) return true; }
    return false;
  };
  const fingerprint = (line) => line.trim().replace(/port-literal-ok\s*:.*$/, 'port-literal-ok: #why#').replace(portReG, '#port#');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIR.has(e.name)) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (CODE_EXT.test(e.name)) files.push(p);
    }
  };
  for (const r of roots) walk(r);

  // 当前存量：key = 文件 + 行指纹 → { file, fp, n, firstLine }
  const current = new Map();
  const shortWhy = [];   // 写了 port-literal-ok 却没写理由：**每次都报**（白名单必须说明为什么）
  for (const f of files) {
    const rel = path.relative(ROOT, f).split(path.sep).join('/');
    if (PORT_ALLOW_FILE.has(rel)) continue;
    fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim();
      if (/^(#|\/\/|\*|REM\b|::)/i.test(line)) return;          // 注释：说明性文字里提数字不算
      if (!portRe.test(line)) return;
      if (!hasPortLiteral(line)) return;        // 时长上下文（见上面三条判据）不算端口
      const ok = line.match(/port-literal-ok\s*:\s*(.+)$/);
      if (ok) {
        if (ok[1].trim().length >= 4) return;                   // 行内白名单（理由必须写够）
        shortWhy.push(`${rel}:${i + 1}`);
      }
      const fp = fingerprint(line);
      const key = `${rel}\u0000${fp}`;
      const hit = current.get(key);
      if (hit) hit.n += 1;
      else current.set(key, { file: rel, fp, n: 1, firstLine: i + 1 });
    });
  }

  const readBaseline = () => {
    if (!fs.existsSync(PORT_BASELINE_FILE)) return null;
    const doc = readJson(PORT_BASELINE_FILE);
    const m = new Map();
    for (const e of (doc?.entries ?? [])) m.set(`${e.file}\u0000${e.line}`, Number(e.n) || 1);
    return m;
  };
  if (UPDATE_FLAG) {
    const entries = [...current.values()].sort((a, b) => (a.file === b.file ? a.fp.localeCompare(b.fp) : a.file.localeCompare(b.file)))
      .map((e) => ({ file: e.file, line: e.fp, n: e.n }));
    fs.writeFileSync(PORT_BASELINE_FILE, `${JSON.stringify({
      _note: '端口字面量棘轮基线（P2⑦ 参数单一来源）：这里每一行都是**已登记、待逐项迁掉**的硬编码端口。',
      _howto: '新增字面量会被自检拦下；把存量迁掉不会失败，只会提示更新这份基线。',
      _update: 'node tools\\self-check.mjs --update-port-baseline',
      _why_fingerprint: 'line 是"该行 trim 后把端口数字换成 #port#"的指纹，不是行号 —— 行号会被任何一次编辑冲掉，指纹不会。',
      portKeys: WANTED,
      total: entries.reduce((a, e) => a + e.n, 0),
      entries
    }, null, 2)}\n`, 'utf8');
    ok(`端口字面量基线已更新：${entries.length} 行 / ${entries.reduce((a, e) => a + e.n, 0)} 处 → tools\\port-literal-baseline.json`);
  } else {
    const base = readBaseline();
    const totalCur = [...current.values()].reduce((a, e) => a + e.n, 0);
    const totalBase = base ? [...base.values()].reduce((a, b) => a + b, 0) : null;
    const added = [];
    for (const [key, e] of current) {
      const was = base?.get(key) ?? 0;
      for (let k = was; k < e.n; k++) added.push(`${e.file}:${e.firstLine}`);
    }
    const gone = base ? [...base].reduce((a, [k, n]) => a + Math.max(0, n - (current.get(k)?.n ?? 0)), 0) : 0;
    if (base === null) {
      bad(`端口字面量基线不见了（${path.relative(ROOT, PORT_BASELINE_FILE)}）—— 先跑 node tools\\self-check.mjs --update-port-baseline 认一次存量，再逐项迁（棘轮：只拦新增，不拦存量）`);
    } else if (added.length || shortWhy.length) {
      const parts = [];
      if (added.length) parts.push(`新增了硬编码端口（${WANTED.join('/')}）：${added.slice(0, 10).join('、')}${added.length > 10 ? ` …共 ${added.length} 处` : ''}`);
      if (shortWhy.length) parts.push(`port-literal-ok 没写理由：${shortWhy.slice(0, 6).join('、')}`);
      bad(`${parts.join('；')} —— 派生：.mjs 用 qq-bridge\\src\\config-lib.js 的 loadConfig()/effectivePorts()；.ps1 用 tools\\env-config.ps1 的 Get-AgentPorts；确实该写死的写行内 port-literal-ok: <理由≥4字>；若是无意的可跑 --update-port-baseline 收进存量`);
    } else if (gone > 0) {
      ok(`端口字面量又迁掉 ${gone} 处，基线里还剩 ${totalCur} 处（本轮无新增）—— 顺手更新基线：node tools\\self-check.mjs --update-port-baseline`);
    } else {
      ok(`端口字面量：基线 ${totalCur} 处存量待迁、本轮无新增（棘轮只拦新增；扫了 ${files.length} 个脚本，白名单 ${PORT_ALLOW_FILE.size} 个文件）`);
    }
    if (totalBase !== null) console.log(`  ℹ️  存量口径：基线 ${totalBase} 处 / 现在 ${totalCur} 处（迁掉 ${gone} 处）`);
  }
} catch (e) { warn(`端口字面量检查失败：${e.message}`); }

// 5.14 控制面动作目录的**单一来源**（2026-09-24，为"搬去 Linux 服务器"铺路那一批）。
// 为什么要有：动作白名单原来是**两处定义** —— tools\control-server.mjs 的 `const VERBS`
// 与 tools\control.ps1 的 ValidateSet + switch 分支（正是本项目一直在消灭的『同一个值两处定义』）。
// 现在唯一来源是 tools\control-actions.json（数据）+ tools\control-actions.mjs（读取器/校验器），
// 这条断言负责让它**不会再长出第二份**，并且目录本身必须是"说得清每个动作各平台能不能跑"的。
//
// 判据分四块：
//   (a) 目录结构校验（validateCatalog：id / 中文显示名 / 一句话说明 / 参数枚举 / confirm / 各平台那一格）
//       —— 特别是"**没实现的平台必须显式 null + 原因**"（绝不许假装能用）；
//   (b) 执行体存在性（checkScripts：目录说会调的那些 .ps1/.mjs 一个都不能少）+ 两个消费方**确实读目录**；
//   (c) 契约断言（模块里的 runSelfTest：动作表 / 参数枚举 / confirm 规则 / argv 形状 / 用法那两行）
//       —— 那是**测试预言**，与端口棘轮给 test-env-config.mjs 开白名单同一个道理（见下面 ALLOW 注释）；
//   (d) **静态扒"第二份动作清单"**：源码里出现"只由动作 id + 列表分隔符交替组成、且含 ≥3 个不同 id"
//       的连续文本 ⇒ 报失败（点名文件与片段）。这是这条不变量真正的价值：光有目录挡不住有人再抄一份。
//
// 为什么判据要这么窄（而不是"文件里出现动作名就报"）：本仓库里 `control.ps1` 的动作名天然会出现在
// switch 分支、argv、`nextAction` 的枚举、文案里 —— 一律报就是天天误报，而假警告会让人学会忽略警告
// （5.13 端口棘轮的注释里写过同一条理由）。所以只认"长得就像一份清单"的那种形状。
const CONTROL_SCAN = [
  ['tools/control-server.mjs', 'mjs', 'HTTP 载波（动作白名单与子参数枚举都必须来自目录）'],
  ['tools/control.ps1', 'ps1', '外观（动作清单/参数枚举/用法两行都必须来自目录）'],
  ['tools/control-driver.mjs', 'mjs', '平台驱动缝合层（按 process.platform 选驱动，不该认识具体动作清单）'],
];
// 白名单（学 5.13 的 PORT_ALLOW_FILE）：只有"那份清单就是被测对象"的文件才登记。
const CONTROL_ALLOW_FILE = new Map([
  ['tools/control-actions.mjs', 'runSelfTest 里写死的期望值**正是被测对象**（测试预言/oracle）：它们的存在就是为了在目录被改动时当场叫出来，不是给别人 import 的数据源'],
  ['tools/control-actions.json', '它**就是**那份唯一来源：动作清单与参数枚举本来就该写在这里'],
]);
// 剥注释：注释里描述"有哪些动作"是文档，不是第二份定义（但代码里的清单不行）。
function stripComments(text, kind) {
  let t = text;
  if (kind === 'ps1') t = t.replace(/<#[\s\S]*?#>/g, ' ');
  t = t.replace(/\/\*[\s\S]*?\*\//g, ' ');
  return t.split(/\r?\n/).map((l) => l.replace(/(^|\s)(#|\/\/).*$/, '$1')).join('\n');
}
// "像一份清单"的连续文本：动作 id 与列表分隔符（逗号/竖线/引号/空白）交替，≥3 个不同 id。
function findActionLists(text, ids) {
  const alt = ids.map((i) => i.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`(?:\\b(?:${alt})\\b[\\s,'"|]*){3,}`, 'g');
  const hits = [];
  for (const m of text.matchAll(re)) {
    const found = ids.filter((id) => new RegExp(`\\b${id}\\b`).test(m[0]));
    if (found.length >= 3) hits.push(`${found.length} 个动作 id 连成一串「${m[0].replace(/\s+/g, ' ').trim().slice(0, 70)}」`);
  }
  return hits;
}
try {
  const actMod = await import(new URL('../tools/control-actions.mjs', import.meta.url).href);
  let doc = null;
  try { doc = actMod.loadCatalog(path.join(ROOT, 'tools', 'control-actions.json')); }
  catch (e) { bad(`控制面动作目录读不了/校验不过（它是白名单唯一来源，坏了控制面就得拒绝启动）：${e.message}`); }

  if (doc) {
    const ids = actMod.actionIds(doc);
    const structErrs = [...actMod.validateCatalog(doc), ...actMod.checkScripts(doc)];
    structErrs.length
      ? bad(`控制面动作目录有问题：${structErrs.slice(0, 4).join('；')}${structErrs.length > 4 ? ` …共 ${structErrs.length} 条` : ''}`)
      : ok(`控制面动作目录 OK：${ids.length} 个动作（${ids.join('/')}）；每个已实现平台（win32 / linux）都写清了"这个动作跑什么"，未实现的平台是显式 null + 原因，执行体与 deploy\\linux\\ 的单元文件都在`);

    const st = actMod.runSelfTest(doc);
    st.passed
      ? ok('控制面动作目录契约断言全过（动作表 / 四个参数枚举 / confirm 规则 / argv 形状 / 用法那两行 / 未实现平台必须 null / linux 逐动作执行体）')
      : bad(`控制面动作目录契约断言不过：${st.fails.slice(0, 3).join('；')}${st.fails.length > 3 ? ` …共 ${st.fails.length} 条` : ''}`);

    // 两个消费方**确实从目录读**（而不是又抄了一份）
    const wiring = [
      ['tools/control-server.mjs', /from '\.\/control-actions\.mjs'/, '从动作目录读白名单'],
      ['tools/control-server.mjs', /from '\.\/control-driver\.mjs'/, '执行交给平台驱动层'],
      ['tools/control.ps1', /control-actions\.json/, '从动作目录读清单与枚举'],
    ];
    const notWired = [];
    for (const [rel, re, what] of wiring) {
      let t = '';
      try { t = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { /* 下面统一报 */ }
      if (!re.test(t)) notWired.push(`${rel} 没有${what}`);
    }
    notWired.length
      ? bad(`控制面消费方没有接上动作目录：${notWired.join('；')}`)
      : ok('控制面两个消费方（control-server.mjs / control.ps1）与驱动层都从动作目录读，没有各写一份');

    // (d) 静态扒第二份清单
    const offenders = [];
    for (const [rel, kind, why] of CONTROL_SCAN) {
      if (CONTROL_ALLOW_FILE.has(rel)) continue;
      let text = '';
      try { text = fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { warn(`读不到 ${rel}（${why}）`); continue; }
      for (const hit of findActionLists(stripComments(text, kind), ids)) offenders.push(`${rel}（${hit}）`);
    }
    offenders.length
      ? bad(`控制面又长出"第二份动作清单"了：${offenders.join('；')} —— 动作清单/参数枚举只许在 tools\\control-actions.json 里定义一处；要新增动作请改目录（别在消费方加数组/ValidateSet）`)
      : ok(`控制面没有第二份动作清单（静态扫了 ${CONTROL_SCAN.length} 个消费方：${CONTROL_SCAN.map((s) => path.basename(s[0])).join('、')}；白名单 ${CONTROL_ALLOW_FILE.size} 个文件 = 那份数据自己 + 测试预言）`);
  }
} catch (e) { warn(`控制面动作目录检查失败：${e.message}`); }

// 5.5 state\ 白名单：生产状态文件之外的一律应待在 _tmp\（测试产物可随时清）
const STATE_ALLOW = new Set([
  '_tmp', 'agents', 'audio', 'draws', 'files', 'slang-agent',
  'avatar.json', 'bridge.lock', 'bridge.log', 'bridge-runtime.json', 'console-token', 'current-role.json',
  // 2026-09-24：panel-token = tools\control-server.mjs（页面总控面板的控制面）的调用凭据 ——
  // 首次启动自动生成、用户零手工。**这是设计出来的正经状态文件，不是 _tmp 残留**：
  // 不登记的话它一落盘，这条检查就会报"白名单外的条目（测试残留？）"，
  // 后来的人很可能据此把**正经状态文件**删掉（这正是最坏的一种误导）。
  // （控制面本身只监听 127.0.0.1，见设计文档 §3.1。）
  'panel-token',
  // 2026-09-25：restart-stack（受令重启入口）的**盘上并发闸标记**。控制面自己会被这次重启杀掉 ⇒
  //   它的 lastAction 记账跟着没 ⇒ single-flight 只能落在盘上。与 panel-token 同类：**设计出来的
  //   正经状态文件**，不是 _tmp 残留（路径与过期口径只在 tools\control-actions.json 的 http.busyGuard
  //   一处定义；写它的是 control.ps1，撤它的是启动器收尾，读它的是 control-server.mjs）。
  'restart-stack.json',
  'feedback.json', 'mode.json', 'panel-presence.json', 'panel-snapshot.json', 'panel-opened.json', 'profile-limits.json', 'qq-activity.log', 'qq-mode-plugin.log',
  'dev-relay.json', 'dev-reply-wake.json', 'sessions.json', 'slang.json', 'slang-session.json', 'snowluma-credential.txt', 'social-v2.json', 'stickers.json',
  'tool-calls.jsonl',
  // 2026-09-24：控制台布局模板存服务端（主人批准）⇒ 这是正经状态文件，不是 _tmp 残留；
  // daily-stats.json / outbound-audit.jsonl 是同一批（今日战报 / 出站对账）的文件，先一起登记，
  // 免得它们刚被写出来就先报一次"白名单外"。
  'console-layout-template.json', 'daily-stats.json', 'outbound-audit.jsonl',
  // 2026-09-24：引导完成态（由 tools\onboard.ps1 落盘）。**务必登记** ——
  // 不登记的话它一落盘，这条检查就会报"白名单外的条目（测试残留？）"，
  // 而后来的人很可能据此把**正经状态文件**删掉（这正是最坏的一种误导）。
  // 2026-09-24：suggest-push.json = 小鲸鱼「建议闭环」（src\suggest-lib.js）推过哪批建议的状态文件。
  // 同样**务必登记**：它是正经状态文件，不登记就会被报成「测试残留」，后来的人可能把它删掉。
  'suggest-push.json',
  // 2026-09-25：「会话卫生」（设计文档 §12 / tools\sessions.mjs + src\session-guard.js）的两个正经状态文件 ——
  // session-nudge.json = 哪个会话哪一档提醒已经发过（删了会重发，这是设计出来的）、
  // archived-sessions.json = 谁归档谁登记的本地名单（「归档即只读历史」护栏的本地那一半）。
  // **务必登记**：不登记它们一落盘就会报「白名单外的条目（测试残留？）」，
  // 后来的人很可能据此把正经状态文件删掉（那正是最坏的一种误导）。
  'session-nudge.json', 'archived-sessions.json',
  // 2026-09-25：archive-ask.json = 「归档确认」那张**待确认单**（桥接自持 pending，src\archive-lib.js 的
  // ARCHIVE_ASK_FILE_NAME；主人回「归档 / 归档 <短id> / 取消」之前它一直在盘上，12 小时 TTL）。
  // **务必登记**（同上一条理由）：它是正经状态文件，不登记就会被报成「测试残留」—— 删掉它等于
  // 把主人已经收到的【归档确认】作废（他回了关键词也不会再归档），这是最坏的一种误导。
  'archive-ask.json',
  // 2026-09-25（执行线 5758ba91，批次 2b）：gateway-watch.json = 网关看门狗的**两个正经状态** ——
  // ① `lastTickAt`（上一拍墙钟基线，落盘是为了让"重启造成的停摆"第一拍就能判出断档）；
  // ② 断线提醒的记账（`lastAlertAt` / 当日已发次数）。**务必登记**（同上一条理由）：
  // 不登记它一落盘就报「测试残留」，后来的人很可能把正经状态文件删掉 ⇒ 提醒会重复发。
  'gateway-watch.json',
  'onboarded.json',
  // 2026-09-26（优化线小锤）：`_archive\` = 「`_tmp` 里只许有产物」那条（5.12c）的**出口**。
  //   为什么需要出口：`_tmp` 是"随时可清"的目录，脚本放那儿等于下次清理就没；而那一批一次性脚本
  //   当年**没进版本控制**（`qq-bridge\state\` 整个在 `.gitignore` 里）⇒ 直接删 = 永久丢。
  //   所以做法是**先搬不删**：搬进 `_archive\tmp-20260926\`，逐条结论（是什么 / 被谁取代 / 能不能删）
  //   写在该目录的 `README.md` 里。**务必登记**：不登记的话它一转绿就换来一条"白名单外条目"警告，
  //   而那条警告的文案（"测试残留？"）会让后来的人真的把里面的东西删掉 —— 正是 5.5 注释里最怕的误导。
  '_archive',
  // 2026-09-26：`dsh-autorestart-evidence.log` = **自动拉起（auto-restart）的证据账**，由
  //   `tools\dsh-prompt.ps1` 的判死分支**只追加**写（见该文件 L984 / L1002），记的是"窗口那次自动修
  //   到底判了什么、拉没拉"的现场 —— **设计出来的正经状态文件**，不是测试残留。
  //   （它一直躺在 `state\` 根上，5.5 从加进来那天起就把它报成"残留"，只是没人收这一条。）
  'dsh-autorestart-evidence.log',
  // 2026-09-27（协调线小舵）：`launcher-repair.log` = **同一个写入者**（`tools\dsh-prompt.ps1` L1245）按设计写
  //   的**修复动作账** —— 只记"失败"与"判不准"（那正是要人动手的时候），并且有测试钉着它的路径与写法
  //   （`tools\test-dsh-stop-autorestart.mjs` L557-558）⇒ **设计出来的正经状态文件，不是测试残留**。
  //   ★ 自首：这一条**放宽**了 5.5 的判据（把一个原来会报警的名字加进白名单）⇒ 依据是"写入者按设计写它 ＋
  //   有测试钉着"两条硬证据；加完做过**反向对照**（故意造一个白名单外的临时条目 ⇒ 仍然报警且点名它）。
  //   与上面那条同族：也是"加进来那天起就被报成残留、一直没人收"，直到 2026-09-27 由留言板转来的自检结果才收掉。
  'launcher-repair.log',
  // 2026-09-26（优化线小锤）：`scan-secrets-identity.json` = **发布前扫描器**（`tools\scan-secrets.cjs`）的
  //   「本地身份字面量」（主人号 / 群号 / 服务器地址前缀 / 服务器账号）。为什么真值不在判据文件里：那个文件
  //   **要进公开仓库**（见 `docs\对外发布清单.md` §2）⇒ 真值必须出库，脚本缺失时**响亮报「未配置」**、不静默降级。
  //   为什么放在 `state\`：结构性的 —— 该目录已被 `.gitignore` **整体忽略**、且 `qq-bridge\` 本来就不进公开档
  //   ⇒ 整目录复制也带不出去。**务必登记**（同 5.5 各条的理由）：它是正经状态文件，不登记就会被报成
  //   「测试残留」而被人删掉 —— 删了以后扫描器的字面判据那一轮就**静默变弱**（只剩通用形状判据）。
  'scan-secrets-identity.json',
]);
try {
  const stray = fs.readdirSync(path.join(ROOT, 'qq-bridge', 'state')).filter((n) => !STATE_ALLOW.has(n));
  stray.length
    ? warn(`state\\ 有 ${stray.length} 个白名单外的条目（测试残留？应收进 state\\_tmp\\）：${stray.join('、')}`)
    : ok('state\\ 没有白名单外的残留');
} catch { warn('读不到 qq-bridge/state 目录'); }

// 5.5b 工作区根不该出现 state\：几个探针/测试用 process.cwd() 定位 state，
// 从工作区根跑就会在这里凭空造一个（产物本该在 qq-bridge\state\_tmp\）。
if (fs.existsSync(path.join(ROOT, 'state'))) {
  warn('工作区根出现了 state\\ —— 多半是从根目录跑了按 cwd 定位 state 的探针/测试；产物应在 qq-bridge\\state\\_tmp\\');
}

// 5.5c `tools\` 子树不该出现 qq-bridge\ / state\ 形状树（2026-09-26 加，优化线小锤；协调线 20:5x 批准）
//   由来：守窗器三处用 `Split-Path $Tools -Parent` 推仓库根，而启动器 `tools\dsh-window.cmd` 传的是
//     `-Tools "…\tools\."` ⇒ `Split-Path` 只退到 `…\tools`（不是仓库根）⇒ 那三处的日志与重定向全落进
//     `tools\qq-bridge\state\`（根因已由 `0db4741` 修掉；**本条是回归网**，不是修法）。
//   为什么 5.5 / 5.5b 管不到：那棵树不在 `qq-bridge\state\` 的**顶层**（5.5 只看顶层白名单），
//     也不在**工作区根**（5.5b 只管根）—— 它长在第三处：`tools\` 下面。
//   为什么值得单列：`tools\` 是 **A 档候选目录**（要发出去），当年那棵树里实测含主人 QQ ＋ 本机用户名。
//   ★ 立案依据（**不许删**）：加这条之前量过空过对照 —— 注入 `tools\qq-bridge\state\x.log` 时，
//     自检仍报 **0 个失败**，唯一反应是"结构快照已过期"（那是**任何**新文件都会触发的通用警告）。
//   判据：`tools\` **子树**（深度不限）里出现**名为 `qq-bridge` 或 `state` 的目录** ⇒ 红。
//     · 只认**精确名**（`statex` 不算）＋ 只认**目录**（同名文件不算）；
//     · 排除表**复用**上面那两份模块级常量（`PS1_SKIP` / `PS1_RECORD`），另显式放行 `tools\_tmp\`（正当飞行区）；
//     · **域只到 `tools\` 子树**：不做全仓版 —— 实测全仓今天有 9 个**正当**命中（复核线的夹具树），
//       域一放大就得开始写豁免，**豁免越多网越假**（协调线 20:5x 同此裁决）。
//   ★★ 本网**不跟随链接**（2026-09-26 21:1x 协调线 A6-1 要求写明）：`withFileTypes` 的 `isDirectory()` 对
//     symlink / Windows junction 恒为 **false** ⇒ 名字就叫 `qq-bridge` 的 junction **不在网内**（它是盲区，
//     不是被放行）。⇒ "要发出去的目录不藏生产状态"这句话**对链接是假保证**，别当成链接也管住了。
//     外带这条路的**真实防线**是三样，不是本网：① 遍历惯用法（`isDirectory()` 对链接为 false ⇒ 不下钻）；
//     ② `tools\export-a.mjs` 的候选遍历里**显式**收集并打印 `isSymbolicLink()`（判据⑦："不进 A 档"）；
//     ③ 就算退回无守卫版，`readFileSync(<junction>)` 会 **EISDIR 当场崩** —— 是**响的失败**，不是静默带走。
//   ★★ 两个**有意不报**的位置（2026-09-26 21:1x 点名，免得后人以为漏了）：
//     · `tools\_tmp\qq-bridge\state\`（真目录）—— **有意放行**（正当飞行区，产物可随时清）；
//     · `tools\archive\qq-bridge`（真目录）—— 被 `PS1_RECORD` 吃掉，**也不报**（记录/草稿区的统一裁决）。
//   ⚠⚠ 红了怎么处置（协调线 20:5x 追加的条件，**按这个顺序**）：
//     ① **先去看那棵树**（是谁按相对路径／cwd 写盘了？多半又是某处"仓库根从哪推"的老写法）；
//     ② **不要**把它当"新状态文件"登记进白名单 —— 它永远不是；登记一次就等于把这条网的假阴性做成默认；
//     ③ 白名单每加一条**必须写日期 ＋ 一句为什么**；没有这两样的条目视为"**正在变假**"，后来人可以直接删。
//   （它会经 `tools\daily-check.mjs` 每天 09:00 推到主人手机 —— 那是它的价值，也是它的风险。）
const TOOLS_SHAPE_ALLOW = new Set([
  // 白名单（初始为空）。加条目**必须带日期 ＋ 为什么**（见上面 ⚠⚠ 第 ③ 条）。
]);
const TOOLS_SHAPE_NAMES = new Set(['qq-bridge', 'state']);
try {
  const TOOLS_DIR = path.join(ROOT, 'tools');
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (PS1_SKIP.test(p) || PS1_RECORD.test(p + path.sep)) continue;
      const rel = path.relative(TOOLS_DIR, p);
      // ⚠ 这一行是**冗余**的（`PS1_RECORD` 已经先命中过 `_tmp`）—— 保留只是让"放行飞行区"这层意思在代码里看得见；
      //   哪天 `PS1_RECORD` 被改窄，这里仍按批准口径放行 `tools\_tmp\`（协调线 20:5x 裁决）。
      if (rel === '_tmp' || rel.startsWith('_tmp' + path.sep)) continue;   // 正当飞行区（见上一行）
      if (!e.isDirectory()) continue;   // ★ 链接也走这一支（不跟随、不判 —— 见上面 ★★ 盲区那段）
      // ★ 命中只报**最外层**（同一棵树不刷 N 条）：命中即记账并**不再往下走**。
      if (TOOLS_SHAPE_NAMES.has(e.name)) {
        if (!TOOLS_SHAPE_ALLOW.has(rel)) hits.push(path.relative(ROOT, p));
        continue;
      }
      walk(p);
    }
  };
  // ★★ fail-loud（2026-09-26 21:1x 协调线 A6-2）：`PS1_RECORD` 吃的是**绝对路径** ⇒ 若 ROOT 自身就落在
  //    `archive` / `_archive` / `_tmp` 这类路径里（复核线的"镜像夹具法"正是这样），**每个条目都会被跳过**
  //    ⇒ 明明有命中树也会报绿。生产 ROOT（`D:\hobby\DSH`）不受影响，但这种"绿灯"必须响亮地说出它不算数。
  if (PS1_RECORD.test(TOOLS_DIR + path.sep)) {
    warn(`tools\\ 子树形状网：**本次没有判据力** —— ROOT（${ROOT}）自身落在记录/草稿区路径里（archive ／ _archive ／ _tmp）⇒ 每个条目都会被那张排除表跳过，**报绿也不算数**。★ 复核同族网时：镜像法必须让 ROOT 走 **cwd 相对路径**，**绝对路径 ROOT 一律不可信（会假绿）**。`);
  } else {
    walk(TOOLS_DIR);
    hits.length
      ? bad(`tools\\ 子树里出现了 ${hits.length} 个 qq-bridge\\ / state\\ 形状目录（多半是谁按相对路径／cwd 写盘了 —— 先去看那棵树，别登记白名单）：${hits.join('、')}`)
      : ok('tools\\ 子树里没有 qq-bridge\\ / state\\ 形状**目录**（要发出去的目录不藏生产状态；⚠ 链接不在本网内，见本节注释）');
  }
} catch (e) { warn(`tools\\ 子树形状检查失败：${e.message}`); }

// 5.6 根 .gitignore 兜底：根 .git 只是「工作区标记」空目录，但一次 git init + add -A 的代价是密钥
try {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  const miss = ['.npm-cache/', 'SnowLuma/', 'qq-bridge/state/', 'backups/', 'credentials.json'].filter((k) => !gi.includes(k));
  miss.length
    ? bad(`根 .gitignore 缺关键规则：${miss.join('、')}`)
    : ok('根 .gitignore 覆盖缓存 / 第三方 / 状态 / 备份 / 密钥');
} catch { bad('根 .gitignore 不存在（红线 3：密钥别外传）'); }

// ── 6. 日志健康 ─────────────────────────────────────────────────────────────
head('日志健康');
// DSH 的启动时刻来自 guard 日志**文件名**（server-YYYYMMDD-HHmmss），不是文件 mtime：
// mtime 只是"最后写日志的时间"，会随运行不断前移，拿它当起点会把老记录误判成新故障（踩过）。
const startMs = (() => {
  const m = files[0]?.n.match(/^server-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.out\.log$/);
  if (!m) return Date.now();
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
})();
console.log(`  ℹ️  本次 DSH 启动于 ${new Date(startMs).toLocaleString()}（据 ${files[0]?.n ?? '无日志'}）`);
const nowMs = Date.now();
const lineTime = (l) => {
  const m = l.match(/(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return nowMs;                                    // 无时间戳的按当前时刻算
  const d = new Date(nowMs); d.setHours(+m[1], +m[2], +m[3], 0);
  if (d.getTime() > nowMs) d.setDate(d.getDate() - 1);      // 跨零点：把"未来"时刻算作昨天
  return d.getTime();
};
const scan = (file, label, n = 400) => {
  if (!fs.existsSync(file)) return warn(`${label} 不存在`);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const tail = lines.slice(-n);
  const suspect = tail.filter((l) => /(^|\s)(ERROR|FATAL)|401|Unauthorized|ECONNREFUSED|未授权/i.test(l));
  const fresh = suspect.filter((l) => lineTime(l) >= startMs - 60_000);
  if (suspect.length === 0) ok(`${label} 尾部 ${tail.length} 行无错误特征`);
  else if (fresh.length === 0) ok(`${label} 尾部 ${tail.length} 行有 ${suspect.length} 行历史可疑（早于本次启动，例如换令牌前的 401）`);
  else warn(`${label} 有 ${fresh.length} 行本次启动后的可疑记录：${fresh.at(-1).slice(0, 110)}`);
};
scan(path.join(ROOT, 'qq-bridge', 'state', 'bridge.log'), 'bridge.log');
if (files.length) scan(path.join(GUARD, files[0].n), files[0].n, 200);

// SnowLuma 侧：桥接若硬退出（裸 process.exit 或强杀），对端会记 read ECONNRESET +
// StreamTransportClosedError。**以当前桥接实例的启动时刻为界**：之后再有就是回归，
// 之前的是修复前的历史噪音（不重复报警）。修法见 qq-bridge\src\bridge.js 的 exitGracefully()。
try {
  const bridgeStartMs = fs.statSync(path.join(ROOT, 'qq-bridge', 'state', 'bridge.lock')).mtimeMs;
  const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
  const slFile = path.join(ROOT, 'SnowLuma', 'logs', `snowluma-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}.log`);
  const hits = fs.readFileSync(slFile, 'utf8').split(/\r?\n/).filter((l) => /ECONNRESET|inbound action failed/i.test(l));
  // 宽限放在**启动之后**（2026-09-24 修）：桥接刚起来时 SnowLuma 那条 WS 还在重连（它自己的状态提示
  // 原话就是"刚重启过（不到 2 分钟）：网络类报错稍等再试"），这几行断开是**重启本身**造成的、不是回归。
  // 原来写的是 `>= 启动 - 60_000`（往启动前宽限）—— 方向反了，等于专门把这 60 秒噪音圈进来，
  // 每次重启都留一条假警告（假警告真正的危害是让人学会忽略警告）。
  const GRACE_MS = 120_000;
  const fresh = hits.filter((l) => lineTime(l) >= bridgeStartMs + GRACE_MS);
  if (!hits.length) ok('SnowLuma 日志今天没有 ECONNRESET / inbound action failed');
  else if (!fresh.length) ok(`SnowLuma 今天有 ${hits.length} 行历史 ECONNRESET/断开错误，都在本次桥接启动（${new Date(bridgeStartMs).toLocaleTimeString()}）之前`);
  else warn(`SnowLuma 在本次桥接启动 2 分钟后仍有 ${fresh.length} 行 ECONNRESET/断开错误：${fresh.at(-1).trim().slice(0, 110)}`);
} catch (e) { warn(`SnowLuma 日志没查成：${e.message}`); }

// ── 7. --deep：端到端回合 ───────────────────────────────────────────────────
if (DEEP && api) {
  head('端到端（--deep）');
  const { unwrap, createTurnCollector } = await import(new URL('../qq-bridge/src/dsh-client.js', import.meta.url).href);
  const dir = cfg?.sessionCwd ? String(cfg.sessionCwd) : path.join(ROOT, 'qq-bridge', 'state', 'agents');
  fs.mkdirSync(dir, { recursive: true });
  let sid = '';
  try {
    const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace/create');
    sid = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: 'qq-chat-v2' }), 'session/create').sessionId;
    ok(`已建 qq-chat-v2 测试会话 ${sid}`);
    const collector = createTurnCollector();
    let opened; const ready = new Promise((r) => { opened = r; });
    const stream = api.events.mux({}, undefined, () => opened());
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('回合超时 120s')), 120_000);
      (async () => {
        for await (const env of stream) {
          const f = env.payload;
          if (f.type === 'session/event' && f.sessionId === sid) { const e = collector.push(f.event); if (e) { clearTimeout(t); resolve(e); return; } }
          if (f.type === 'stream/error') { clearTimeout(t); reject(new Error(JSON.stringify(f.error))); return; }
        }
      })().catch((e) => { clearTimeout(t); reject(e); });
    });
    await ready; stream.follow(sid);
    unwrap(await api.sessions.prompt({ sessionId: sid, mode: 'queue', content: [{ type: 'text', text: '不要调用任何工具，只回一行：如果你能看到标题含「D:\\hobby\\DSH」的工作区指令就回答 OK-WORKSPACE，否则回答 NO' }] }), 'session/prompt');
    const ended = await done;
    /OK-WORKSPACE/.test(ended.text || '') ? ok(`QQ preset 会话确实收到工作区指令（回复：${(ended.text || '').trim().slice(0, 60)}）`)
      : bad(`QQ preset 会话没确认收到指令，回复：${(ended.text || '').trim().slice(0, 120)}`);
  } catch (e) { bad(`端到端失败：${e.message}`); }
  finally { if (sid) { try { await api.workspace.archiveSession({ sessionId: sid }); ok('测试会话已归档'); } catch { warn('测试会话归档失败，请在 GUI 里手动删'); } } }
} else if (DEEP) warn('跳过端到端（DSH API 不可用）');

console.log(`\n${'='.repeat(52)}\n自检结果：${fails} 个失败，${warns} 个警告${DEEP ? '（含端到端）' : '（未含端到端，加 --deep）'}`);
process.exitCode = fails ? 1 : 0;
