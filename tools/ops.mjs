#!/usr/bin/env node
// 工作区运维小工具（ASCII 命令 + UTF-8 输出）。
//   node tools/ops.mjs status              # 端口 / QQ 在线 / 令牌是否同步
//   node tools/ops.mjs status --json      # 同上，但输出机器可读 JSON（令牌照旧打码）——
//                                         # tools\control.ps1 status 消费它，保证两边同一口径；
//                                         # 另含 `starting` = 已知启动窗口的判定（见 tools\starting-window.mjs）
//   node tools/ops.mjs logs [dsh|bridge|snowluma] [行数]
//   node tools/ops.mjs token               # 比对 config.json 与最新 guard 日志里的 DSH token
//   node tools/ops.mjs token --write       # 把最新 token 写回 config.json
//   node tools/ops.mjs note "内容"          # 追加一条规则/踩坑到 docs/规则与踩坑日志.md
//   node tools/ops.mjs note --stdin         # ← 内容从标准输入读；--file <路径> 从文件读
//   node tools/ops.mjs note --dry-run "内容" # ← 只打印将要落盘的那一行，不写盘
//   node tools/ops.mjs restart-bridge      # 调桥接控制台接口重启桥接
//   node tools/ops.mjs help                # 全部命令与用法
//
//   node tools/ops.mjs notify <group:群号|private:QQ号> "内容"   # 给该会话投后台提醒（UTF-8 安全）
//   node tools/ops.mjs relay  <private:主人QQ> "要问主人的事"     # 同上，但允许她译成人话转告主人
//
// ⚠ 内容里有**双引号 / 反斜杠 / 换行**时，别用位置参数，用 `--stdin` 或 `--file`：
//   Windows PowerShell 5.1 把参数交给原生 exe 时**不给内嵌 `"` 加转义**，子进程按「引号开关」
//   解析 ⇒ 双引号被吃掉（末尾反斜杠还会多冒一个 `"`）。这是 PS 传参层的锅，不是本文件的：
//   实测同一条串在 PS 变量里 len=7、进 node 的 argv 只剩 5（见 docs/规则与踩坑日志.md 2026-09-24 条）。
//   `--stdin` / `--file` 绕开命令行，只做两条归一：**去掉开头 BOM（U+FEFF）与末尾一个换行**
//   （PS 5.1 灌 stdin 会塞这两样；文本文件末尾那个换行也不是内容）。除此之外一个字节都不动 ——
//   内部换行、双引号、单引号、反斜杠、中文、首尾空格全部原样落盘。
//
// ⏱ 时间戳：note 写进日志的一律是 **UTC**，从 2026-09-24 起显式带 `UTC` 标记
//   （`- YYYY-MM-DD HH:mm UTC 内容`）。别改成本地时间 —— 日志里 237 条历史条目同样是 UTC
//   （当时没标注），改了会造成同一天前后差 8 小时的断层（主人 2026-09-24 拍板：只标注、不回改）。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// 已知启动窗口（"刚发起启动/重启，桥接还没监听不算问题"）：判定只有那一份实现，这里只是**读**它，
// 再把结果挂到 status --json 的 `starting` 字段上（两个渲染方：control.ps1 / control-driver.mjs）。
import { readStarting } from './starting-window.mjs';
// 端口单一来源（P2⑦）：默认值只在 `qq-bridge\src\config-lib.js` 定义一次，生效值由仓库根
// `agent.config.json` 决定 —— 本文件一个端口数字都不抄（为什么这么绕见 `tools\env-config.ps1` 文件头）。
// 这里用 `resolvePorts()`（**容错版**：`qq-bridge\config.json` 读不了就退回环境层/默认值并出声），
// 所以"配置坏了也得能看端口"这条对 status 依然成立。改前本文件自己抄了一张表
// （3080/3001/3000/5099/3100）—— 改端口时那张表**不会**跟着变，status 会报错的端口。
import { resolvePorts } from '../qq-bridge/src/config-lib.js';

// Windows 控制台默认 GBK，Node 写 UTF-8 会显示成乱码；切到 65001 只影响这个窗口。
if (process.platform === 'win32') {
  try { spawnSync('chcp.com', ['65001'], { stdio: 'ignore' }); } catch { /* 非控制台环境忽略 */ }
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const GUARD_LOGS = path.join(HOME, 'guard', 'logs');
const CONFIG = path.join(ROOT, 'qq-bridge', 'config.json');
const LOG = (p, n) => path.join(ROOT, 'qq-bridge', 'state', p);
const NOTES = path.join(ROOT, 'docs', '规则与踩坑日志.md');
// 生效端口：唯一来源算出来的那六个（环境层缺席时就是默认表的值 —— 与改前本文件写死的
// 3080/3001/3000/5099/3100 逐字相同，见 qq-bridge\scripts\test-env-config.mjs 的等价断言）。
const PORTS = resolvePorts();

const argv = process.argv.slice(2);
const cmd = argv[0] || 'status';

function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

function readJson(file) {
  // 注意：config.json 由 PS 5.1 的 Set-Content -Encoding UTF8 写成「带 BOM」，
  // 直接 JSON.parse 会抛错；必须先剥掉 BOM，且失败要出声，别静默返回 null。
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    console.log(`[warn] 读不了 ${path.relative(ROOT, file)}: ${e.message}`);
    return null;
  }
}

function latestLogToken() {
  let files = [];
  try {
    files = fs.readdirSync(GUARD_LOGS)
      .filter((n) => /^server-.*\.out\.log$/.test(n))
      .map((n) => ({ n, m: fs.statSync(path.join(GUARD_LOGS, n)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
  } catch { return { token: '', file: '' }; }
  for (const { n } of files) {
    try {
      const m = fs.readFileSync(path.join(GUARD_LOGS, n), 'utf8').match(/[?&]token=([A-Za-z0-9_-]{20,})/);
      if (m) return { token: m[1], file: n };
    } catch { /* 日志正被占用/轮转，继续看更早的 */ }
  }
  return { token: '', file: '' };
}

function tail(file, lines, maxCols = 240) {
  if (!fs.existsSync(file)) return `(没有这个文件: ${file})`;
  const text = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const sliced = text.slice(-lines);
  if (argv.includes('--full')) return sliced.join('\n');
  // 默认把超长行截断：DSH 日志里有单行几 KB 的告警，tail 一下就能吃掉大量上下文。
  return sliced
    .map((l) => (l.length > maxCols ? `${l.slice(0, maxCols)}… (+${l.length - maxCols} 字符，需要全文加 --full)` : l))
    .join('\n');
}

const mask = (t) => (t ? `${t.slice(0, 8)}…(${t.length})` : '(空)');

// status 的判定口径（端口表 / 令牌比对 / QQ 在线 / 全绿）**只有这一份实现**，两种输出：
//   · 人看的文本（默认，与以前逐字节一致）
//   · 机器看的 JSON（`status --json`）：给 tools\control.ps1 status 消费（唯一动作源 +
//     docs\qq-agent-产品设计.md §10.3 的"五灯 + 下一动作"）⇒ 两边永远同口径，不会各写一套。
// ⚠ JSON 里的令牌**照样打码**（只给前 8 位与长度）——它会流向页面/日志，别把密钥泄出去。
async function cmdStatus() {
  const json = argv.includes('--json');
  const ports = [
    ['DSH Web      ', 'dsh', PORTS.dshWeb],
    ['SnowLuma WS  ', 'snowluma', PORTS.snowlumaWs],
    ['OneBot HTTP  ', 'onebot', PORTS.onebotHttp],
    ['SnowLuma 管理', 'snowlumaWeb', PORTS.snowlumaWeb],
    ['桥接控制台   ', 'bridge', PORTS.bridgeConsole],
  ];
  const portStates = [];
  for (const [label, key, p] of ports) {
    const open = await portOpen(p);
    portStates.push({ key, label: label.trim(), port: p, open });
    if (!json) console.log(`${label} : ${open ? 'OK  ' : 'DOWN'}  127.0.0.1:${p}`);
  }
  const cfg = readJson(CONFIG);
  const { token, file } = latestLogToken();
  const cfgTok = cfg?.dsh?.authToken || '';
  const synced = Boolean(token) && token === cfgTok;
  const portUp = (key) => Boolean(portStates.find((p) => p.key === key)?.open);

  let qq = null;
  let qqLine = null;   // 文本模式下这行要**最后**打（保持与改动前逐行同一个顺序）
  if (cfg?.snowluma?.httpUrl) {
    try {
      const url = `${cfg.snowluma.httpUrl}/get_login_info?access_token=${encodeURIComponent(cfg.snowluma.accessToken || '')}`;
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const body = await res.json();
      const online = body?.status === 'ok';
      qq = online
        ? { state: 'online', nickname: body.data?.nickname ?? '', userId: body.data?.user_id ?? '', raw: '' }
        : { state: 'not-ready', nickname: '', userId: '', raw: JSON.stringify(body).slice(0, 200) };
      qqLine = online
        ? `QQ 账号           : 在线 ${body.data?.nickname} (${body.data?.user_id})`
        : `QQ 账号           : 未就绪 ${JSON.stringify(body)}`;
    } catch (e) {
      qq = { state: 'error', nickname: '', userId: '', message: e.message };
      qqLine = `QQ 账号           : 查询失败 ${e.message}`;
    }
  }

  if (json) {
    const allGreen = portUp('dsh') && portUp('bridge') && portUp('snowluma') && synced && qq?.state === 'online';
    console.log(JSON.stringify({
      allGreen,
      ports: portStates,
      token: { configMasked: mask(cfgTok), latestMasked: mask(token), logFile: file || '', synced },
      qq: qq ?? { state: 'unknown', nickname: '', userId: '' },
      // ★ 已知启动窗口（2026-09-24 晚）：`{ active, action, what, ageSec, graceSec, graceLeftSec, at }`。
      //   发起启动/重启的那一处盖章（tools\starting-window.mjs），判定（剩几秒 / 算不算在窗口里）
      //   也只有那一份实现 —— 渲染方（control.ps1 / control-driver.mjs）**只读这个字段**，
      //   各自只决定文案与 action（宽限期内 = "⏳ 正在起…" + none；过期 = 原样"⚠ 桥接断了" + restart）。
      starting: readStarting(ROOT),
      generatedAt: new Date().toISOString(),
    }, null, 2));
    return;
  }

  console.log('');
  console.log(`config.json token : ${mask(cfgTok)}`);
  console.log(`最新 guard 日志   : ${file || '(无)'} → ${mask(token)}`);
  console.log(`令牌是否同步      : ${synced ? '是 ✅' : '否 ❌（跑 start-all.ps1 或 node tools/ops.mjs token --write）'}`);
  if (qqLine) console.log(qqLine);
}

function cmdLogs() {
  const which = (argv[1] || 'dsh').toLowerCase();
  const lines = Number(argv[2] || 40);
  if (which === 'dsh') {
    const files = fs.existsSync(GUARD_LOGS)
      ? fs.readdirSync(GUARD_LOGS).filter((n) => /^server-.*\.out\.log$/.test(n))
        .map((n) => ({ n, m: fs.statSync(path.join(GUARD_LOGS, n)).mtimeMs })).sort((a, b) => b.m - a.m)
      : [];
    if (!files.length) return console.log('(guard 日志目录为空)');
    console.log(`== ${files[0].n} (最后 ${lines} 行) ==`);
    return console.log(tail(path.join(GUARD_LOGS, files[0].n), lines));
  }
  const file = which === 'bridge' ? LOG('bridge.log') : path.join(ROOT, 'SnowLuma', 'logs');
  if (which === 'snowluma') {
    try {
      const f = fs.readdirSync(file).map((n) => ({ n, m: fs.statSync(path.join(file, n)).mtimeMs })).sort((a, b) => b.m - a.m)[0];
      console.log(`== SnowLuma/${f.n} (最后 ${lines} 行) ==`);
      return console.log(tail(path.join(file, f.n), lines));
    } catch { return console.log('(SnowLuma 日志目录读不到)'); }
  }
  console.log(`== qq-bridge/state/bridge.log (最后 ${lines} 行) ==`);
  console.log(tail(file, lines));
}

function cmdToken() {
  const { token, file } = latestLogToken();
  const cfg = readJson(CONFIG);
  if (!token) return console.log('没在 guard 日志里找到 token（DSH 是刚重启的吗？）');
  console.log(`最新日志 ${file} → ${token}`);
  console.log(`config.json     → ${mask(cfg?.dsh?.authToken || '')}`);
  if (!argv.includes('--write')) return;
  if (cfg?.dsh?.authToken === token) return console.log('已是最新，无需改写');
  cfg.dsh.authToken = token;
  fs.writeFileSync(CONFIG, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  console.log('已写回 config.json（桥接下次启动/重启生效）');
}

const USAGE = `用法：node tools/ops.mjs <命令> [参数]

  status [--json]                   端口 / QQ 在线 / 令牌是否同步（--json 给程序读）
  logs [dsh|bridge|snowluma] [行数] [--full]
  token [--write]                   比对（或写回）config.json 里的 DSH token
  note "内容"                        追加一条到 docs/规则与踩坑日志.md（只追加）
  note --stdin                      内容从**标准输入**读
  note --file <路径>                 内容从**文件**读（零 shell 参与，最稳）
  note --dry-run <同上三种任一>       只打印将要落盘的那一行，不写盘
  notify <group:群号|private:QQ号> "内容" [--relay]
  relay  <private:主人QQ> "内容"
  restart-bridge                    调桥接控制台接口重启桥接
  help                              本帮助

⚠ 内容里有**双引号 / 反斜杠 / 换行**时，别用位置参数（PowerShell 5.1 会把内嵌 " 吃掉）：
    '规则含 {generatedAt:"…"} 与路径 D:\\a\\b' | node tools\\ops.mjs note --stdin
    node tools\\ops.mjs note --file state\\_tmp\\note.txt
  --stdin / --file 只归一两条：去掉开头 BOM（U+FEFF）与末尾一个换行；其余字节原样
  （内部换行、引号、反斜杠、中文、首尾空格都保留）。多行内容原样写入（日志里占多行，首行带时间戳）。
  时间戳一律 UTC 且带 UTC 字样标注（历史条目同样是 UTC，只是当年没标注）；changelog.mjs 那边是当地时间带 +08:00。`;

/** 打印帮助（`help` 命令或 `--help` / `-h`）。 */
function printUsage() {
  console.log(USAGE);
}

/** 读标准输入的全部内容。只做两条归一，其余字节原样（见文件头）。 */
async function readStdinText() {
  const fail = (m) => { console.log(`读标准输入失败：${m}`); process.exit(2); };
  if (process.stdin.isTTY) fail('--stdin 要从管道/重定向拿内容，例如 `... | node tools\\ops.mjs note --stdin`');
  const chunks = [];
  const reading = (async () => { for await (const c of process.stdin) chunks.push(c); return true; })();
  // 给了 --stdin 却没有管道时别挂死（DSH 的 pwsh 工具下 stdin 可能是个不关的管道）：3 秒没数据就报用法。
  // ⚠ 毫秒数写成 `3_000` 是**故意的**（不是排版）：写成 3000 会被自检 5.13 的端口棘轮误判成端口字面量。
  let timer;
  const idle = new Promise((resolve) => { timer = setTimeout(() => resolve(false), 3_000); timer.unref(); });
  const finished = await Promise.race([reading, idle]);
  clearTimeout(timer);
  if (!finished || !chunks.length) fail('标准输入没有内容（--stdin 要配管道或重定向，如 `node tools\\ops.mjs note --stdin < note.txt`）');
  // PowerShell 5.1 把字符串灌进原生进程 stdin 时会塞一个 UTF-8 BOM 并补一个行尾；真字节管道没有这两样。
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
}

async function cmdNote() {
  const dry = argv.includes('--dry-run');
  const useStdin = argv.includes('--stdin');
  const fi = argv.indexOf('--file');
  const fileArg = fi >= 0 ? argv[fi + 1] : '';
  const argErr = (m) => { console.log(m); process.exit(2); };   // 新入口的参数错一律非零退出（脚本能判）
  if (useStdin && fi >= 0) return argErr('--stdin 与 --file 只能给一个（别猜）；node tools/ops.mjs help');
  let text = '';
  if (fi >= 0) {
    if (!fileArg || fileArg.startsWith('--')) return argErr('用法: node tools/ops.mjs note --file <路径>');
    const p = path.isAbsolute(fileArg) ? fileArg : path.resolve(process.cwd(), fileArg);
    if (!fs.existsSync(p)) return argErr(`读不到文件：${p}`);
    // 与 --stdin 同一条归一（文本文件末尾那个换行不是内容）。
    text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r?\n$/, '');
  } else if (useStdin) {
    text = await readStdinText();
  } else {
    // 位置参数：向后兼容，但 PS 5.1 会吃掉内嵌双引号 ⇒ 有引号请走 --stdin / --file。
    const rest = [];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--stdin' || argv[i] === '--dry-run') continue;
      if (argv[i] === '--file') { i++; continue; }
      rest.push(argv[i]);
    }
    text = rest.join(' ').trim();
  }
  // 只有位置参数分支 trim（那是老的宽松行为）；--stdin / --file 的内容连首尾空格都照原样留。
  if (!text) return console.log('用法: node tools/ops.mjs note "内容" | note --stdin | note --file <路径>（见 node tools/ops.mjs help）');
  // ★ 时间戳一律 **UTC，且显式标注**（2026-09-24 主会话拍板）。
  //   为什么不是改成当地时间：本文件历史 237 条都是 UTC，改成当地时间会让同一天前后差 8 小时、
  //   比现在更难查；真正的病根是**没标注** —— `2026-09-24 12:08` 看着像本地时间，实际是 UTC，
  //   正是本项目吃过的那类坑（`state\bridge.log` 的"UTC 且不带日期"）。所以保持 UTC，只补标注。
  //   对比：`tools\changelog.mjs` 用当地时间且自带 `+08:00` 偏移 —— 两边都"显式"，格式不同无妨。
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const line = `- ${stamp} ${text}`;
  if (dry) {
    console.log('[dry-run] 不写盘。将要追加到 docs/规则与踩坑日志.md 的这一行 ↓');
    console.log(line);
    console.log(`[dry-run] 内容 ${text.length} 字符 / ${Buffer.byteLength(text, 'utf8')} 字节（UTF-8）`);
    return;
  }
  if (!fs.existsSync(NOTES)) {
    fs.mkdirSync(path.dirname(NOTES), { recursive: true });
    // 新工作区首次运行才走这里：落一份与 docs\规则与踩坑日志.md 现行文件头一致的手册
    // （别退回简版 —— 那会丢掉"时间戳一律 UTC"这条，而它正是最容易误读的地方）。
    fs.writeFileSync(NOTES, '# 规则与踩坑日志\n\n'
      + '> **本文负责**：坑与决定的**流水与原文** —— 只追加、不重写；每条一行，格式 `- YYYY-MM-DD HH:mm UTC 内容`。\n'
      + '> **⏱ 时间戳一律 UTC**（行尾那个 `UTC` 是标记、不是内容）：**2026-09-24 之前的历史条目同样是 UTC**，只是当时没标注 —— 要换算本地时间请 +8 小时，别把它当本地时间读。机器可查的改动记录另在 `docs\\变更日志.jsonl`（那里是本地时间、自带 `+08:00` 偏移）。\n'
      + '> **不负责**：长期生效的规则已提炼进根 `AGENTS.md`（原文仍留在本文件）；按需求查文档请看 `AGENTS.md` §3 路由表。\n'
      + '> **怎么用**：文件很长，别整读 —— 用 grep 搜关键词（症状 / 文件名 / 工具名），或从末尾往前读最后 20 条看最新结论。\n\n', 'utf8');
  }
  fs.appendFileSync(NOTES, `${line}\n`, 'utf8');
  console.log(`已记录到 docs/规则与踩坑日志.md: ${text}`);
}

async function cmdRestartBridge() {
  const tokenFile = LOG('console-token');
  const ct = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8').trim() : '';
  if (!ct) return console.log('读不到 state/console-token，跳过');
  const port = PORTS.bridgeConsole;   // 控制台端口：与 bridge.js 的 `Number(cfg.consolePort) || DEFAULT_PORTS.bridgeConsole` 同口径
  try {
    await fetch(`http://127.0.0.1:${port}/api/restart?token=${encodeURIComponent(ct)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    console.log('已触发桥接重启（守护会在几秒后拉起）');
  } catch (e) {
    console.log(`重启请求失败：${e.message}`);
  }
}

// 给某个 QQ 会话投一条"后台提醒"（走桥接 /api/console/notify-ai）。
// 用 Node 的 fetch + JSON.stringify 是刻意的：PS 5.1 的 Invoke-RestMethod 默认按非 UTF-8
// 发 JSON body，中文会变成一串 '?'（实测踩过，见 docs/规则与踩坑日志.md）。
//
// --relay（或用 `relay` 命令）：这条提醒**允许她译成人话转告主人**（主人的诉求：只通过 QQ 私聊
// 操作整套系统）。默认不带 = 老行为（她只能内部看，不许转述）。
async function cmdNotify() {
  const key = argv[1];
  const relay = argv.includes('--relay');
  const message = argv.slice(2).filter((a) => a !== '--relay').join(' ').trim();
  if (!key || !message) return console.log('用法: node tools/ops.mjs notify <group:群号|private:QQ号> "内容" [--relay]');
  const cfg = readJson(CONFIG);
  const ct = fs.existsSync(LOG('console-token'))
    ? fs.readFileSync(LOG('console-token'), 'utf8').trim()
    : String(cfg?.consoleToken ?? '');
  if (!ct) return console.log('读不到控制台令牌（state/console-token 或 config.consoleToken）');
  const port = PORTS.bridgeConsole;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/console/notify-ai?token=${encodeURIComponent(ct)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key, message, relay }),
    });
    const text = await res.text();
    console.log(res.ok ? `已投递后台提醒给 ${key}${relay ? '（可转告主人）' : ''}：${text}` : `投递失败 HTTP ${res.status}：${text.slice(0, 200)}`);
  } catch (e) {
    console.log(`投递请求失败：${e.message}`);
  }
}

/** 与 notify 同一条路，只是显式打开"可转告主人"（省得每次记 --relay）。 */
async function cmdRelay() {
  if (!argv.includes('--relay')) argv.splice(2, 0, '--relay');
  return cmdNotify();
}

const table = { status: cmdStatus, logs: cmdLogs, token: cmdToken, note: cmdNote, 'restart-bridge': cmdRestartBridge, notify: cmdNotify, relay: cmdRelay, help: printUsage };
// `--help` / `-h` 出现在任何位置都打帮助（`node tools/ops.mjs note --help` 也管用）。
const run = argv.includes('--help') || argv.includes('-h') ? printUsage : table[cmd];
if (!run) {
  console.log(`未知命令 ${cmd}；可用：${Object.keys(table).join(' | ')}`);
  printUsage();
  process.exit(2);
}
await run();
