// control-driver.mjs —— **平台驱动缝合层**：把"控制面动作"接到"这个平台上真正能执行它的东西"。
//
// 为什么要有这一层（2026-09-24，主人要买服务器、正在 Windows 与 Linux 之间选）：
//   平台核实（docs\部署到服务器.md §10）的结论是：**唯一不兼容的是我们自己的 tools\*.ps1 运维层**——
//     · 判定  = node tools\ops.mjs status --json      → 本来就是跨平台 ✅
//     · 目录  = tools\control-actions.json            → 数据，平台中立 ✅
//     · 载波  = tools\control-server.mjs              → node ✅
//     · 面板  = qq-bridge\plugins\qq-control-panel    → 浏览器 ✅
//     · 执行  = 这一层。win32 = tools\*.ps1（user32 + cmd + 计划任务那一套）
//               linux = systemctl / docker compose / journalctl（unit 与 compose 在 deploy\linux\）
//   本轮（2026-09-24 第二批）把 linux 那一栏从"显式 null"填成真的：
//     · 目录里 `platform.linux` 每个动作逐条写明"在 Linux 上跑哪几条命令"（数据，不是代码）；
//     · 本文件按目录的 steps 拼命令、执行、并把结果整理成与 win32 **同形状**的输出；
//     · ★ 预检诚实：systemctl 在不在、systemd 是不是 PID 1、docker / docker compose 在不在、
//       仓库里的单元文件在不在 —— 缺什么就报一条能照着做的错，**绝不假装能用、绝不静默降级**；
//     · ★ `--print` 只打印命令、不执行 —— 这是"没有真服务器也能核"的唯一手段（可在 Windows 上
//       用 `--platform linux` 核 Linux 侧会跑什么）。
//   darwin 仍然是 `platforms.darwin.supported=false` + 人话原因：本文件在这里当场抛错。
//
// ⚠ 关于 §3.1 契约（status 的 JSON）在 Linux 上怎么来：win32 那半是 control.ps1 拼的（纯 PowerShell）。
//   Linux 上没有 control.ps1（也不需要 pwsh），所以**契约的拼装在 Linux 上由本文件用 node 再做一次**
//   （shapeStatusContract）。这是全项目唯一一处"跨语言重复"，理由与自检办法写在 docs\部署到服务器.md
//   §10.11；`node tools\control-driver.mjs --contract-check`（win32 上）就是钉住两份不漂移的对照。
//   ★ 2026-09-24 晚起这份契约多一个字段 `starting`（已知启动窗口：刚发起启动/重启的几十秒里
//     桥接没监听不算问题）—— 与 nextAction 一样是**逐字对齐**的：判定在 tools\starting-window.mjs
//     一处算，两边都只透传；`--contract-check` 照旧把这两份比出来。
//
// 用法：
//   node tools\control-driver.mjs --check                  # 这个平台上哪些动作能跑、缺什么
//   node tools\control-driver.mjs --json                   # 同上，机器可读
//   node tools\control-driver.mjs --print                  # ★ 只打印每个动作会跑的命令，不执行
//   node tools\control-driver.mjs --print --platform linux  # 在 Windows 上核 Linux 侧（--platform 只改"按哪个平台算"）
//   node tools\control-driver.mjs --self-test              # 离线断言 + 执行体往返（0 = 全过）
//   node tools\control-driver.mjs --contract-check         # win32：node 版 §3.1 契约 vs control.ps1 status -Json
//   node tools\control-driver.mjs --print-env              # deploy\linux\.env 那三个宿主端口（从配置层派生）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadCatalog, findAction, actionIds, controlArgs, paramValues, unsupportedReason, describeCatalog } from './control-actions.mjs';
// ★ 已知启动窗口（"刚发起启动/重启 ⇒ 桥接还没监听不算问题"）：盖章 / 判定 / 那个 45 秒数字
//   全部只有 tools\starting-window.mjs 一份实现（win32 侧对应物是 control.ps1 的 Set-StartingStamp）。
import { isStartingAction, markStarting } from './starting-window.mjs';
// 端口唯一来源（默认表在 config-lib 一处，生效值由仓库根 agent.config.json 决定）。
// 本文件**一个端口字面量都不写**：目录里也写 `{port:bridgeConsole}` 这种占位符，两边都从这里派生。
import { resolvePorts, botDisplayName } from '../qq-bridge/src/config-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
const CONTROL = path.join(__dirname, 'control.ps1');
const TMP_DIR = path.join(ROOT, 'qq-bridge', 'state', '_tmp');

export const PLATFORM = process.platform;

// ── 平台 → 驱动名 ─────────────────────────────────────────────────────────────
// 这一张表是"哪些平台真的有驱动"的**唯一**判据（目录里的 platforms.<名>.supported 与它一一对应，
// 自检 5.14 会同时看两边）。
const DRIVERS = { win32: 'control-ps1', linux: 'control-linux' };

export function driverFor(platform = PLATFORM) {
  return DRIVERS[platform] ?? null;
}
export function isSupported(platform = PLATFORM) {
  return driverFor(platform) !== null;
}

export class ControlPlatformError extends Error {
  constructor(message, platform = PLATFORM) {
    super(message);
    this.name = 'ControlPlatformError';
    this.platform = platform;
  }
}

// 那条"人话错误"：说清**为什么**没有、**要做什么**、**去哪看**。只有这一份文案（异常与 CLI 共用）。
export function platformGapMessage(platform = PLATFORM, doc = null) {
  let reason = '未实现：这个平台还没有驱动';
  try { reason = unsupportedReason(doc ?? loadCatalog(), platform) || reason; } catch { /* 目录坏了也照样报平台这件事 */ }
  return [
    `[控制面] 这个平台还没有驱动：${platform} —— ${reason}`,
    '  · 现在能跑的驱动有两个：win32（tools\\start-all.ps1 / stop-all.ps1 / ensure-bridge.ps1 / panels.ps1 / snowluma-login.ps1）与 linux（systemctl + docker compose + journalctl，单元文件在 deploy\\linux\\）',
    '  · 判定（tools\\ops.mjs status --json）、动作目录（tools\\control-actions.json）、HTTP 载波（tools\\control-server.mjs）、页面面板**都已经跨平台**，不用重写',
    '  · 逐文件清单与工作量：docs\\部署到服务器.md §10.5；跨平台落地状态：同文件 §10.11',
  ].join('\n');
}

export function assertSupported(platform = PLATFORM) {
  if (isSupported(platform)) return true;
  throw new ControlPlatformError(platformGapMessage(platform), platform);
}

// 把目录里的 argv 模板拼出来（**服务端没有任何『用户输入直接进命令行』的路**：占位符只许是参数名）。
export function buildArgs(action, { target = '', tail = null, json = false } = {}) {
  return controlArgs(action, { target, tail, json });
}
export function buildArgsFor(doc, actionId, params) {
  const action = findAction(doc, actionId);
  if (!action) throw new Error(`动作目录里没有「${actionId}」`);
  return buildArgs(action, params);
}

// ── 通用：跑一个子进程并把 stdout/stderr 收回来 ────────────────────────────────
// ⚠ 已知坑（前三批踩过，两个平台都适用）：
//   ① 某些受限环境下 node 的 `stdio:'pipe'` 直接 EPERM（本仓库实测过一次）；
//   ② 控制动作会拉起孙子进程，孙子攥住 stdout 管道 ⇒ 'close' 永远不来、调用方卡死。
//   所以**一律文件重定向**（与 tools\windowless.ps1"cmd 级文件重定向"同一思路）：进程退出一结算就读文件，
//   孙子还攥着也不影响我们已经拿到的内容。win32 那半原来就是这么做的，这里把同一套做法复用给 linux。
function spawnCapture(cmd, args, { timeoutMs = 30000, cwd = ROOT, env = process.env } = {}) {
  return new Promise((resolve) => {
    let outPath;
    let errPath;
    let outFd;
    let errFd;
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const stamp = `${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      outPath = path.join(TMP_DIR, `control-driver-${stamp}.out`);
      errPath = path.join(TMP_DIR, `control-driver-${stamp}.err`);
      outFd = fs.openSync(outPath, 'w');
      errFd = fs.openSync(errPath, 'w');
    } catch (e) {
      resolve({ exitCode: -1, stdout: '', stderr: `[控制面] 建临时文件失败：${e.message}` });
      return;
    }

    let child;
    try {
      child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', outFd, errFd] });
    } catch (e) {
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* 无所谓 */ }
      resolve({ exitCode: -1, stdout: '', stderr: `[控制面] 起不来 ${cmd}：${e.message}` });
      return;
    }

    let settled = false;
    let exitCode = null;
    const cleanup = () => {
      try { fs.closeSync(outFd); } catch { /* 已经关了 */ }
      try { fs.closeSync(errFd); } catch { /* 已经关了 */ }
    };
    const readBack = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
    const finish = (note = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      cleanup();
      resolve({ exitCode: exitCode === null ? -1 : exitCode, stdout: readBack(outPath), stderr: readBack(errPath) + note });
      try { fs.unlinkSync(outPath); } catch { /* 被孙子攥着就下次再说 */ }
      try { fs.unlinkSync(errPath); } catch { /* 同上 */ }
    };
    let grace = null;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经没了 */ }
      finish(`\n[控制面] 超时 ${timeoutMs}ms，已放弃等待\n`);
    }, timeoutMs);

    child.on('error', (e) => { finish(`\n[控制面] 子进程错误：${e.message}\n`); });
    child.on('exit', (code) => { exitCode = code; grace = setTimeout(finish, 500); });
  });
}

// 探针（预检用）：只问"这个命令在不在、能不能跑"，**绝不改任何状态**。
function probeVersion(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 10000 });
    if (r.error) return { ok: false, detail: r.error.code === 'ENOENT' ? '不在 PATH 上' : String(r.error.message || r.error.code) };
    return { ok: r.status === 0, detail: r.status === 0 ? '' : `退出码 ${r.status}` };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

// ── Linux 预检（★ 诚实：缺什么就说什么，绝不"试一下看看"）─────────────────────
// 判据全部是**只读**的：命令在不在 + `/run/systemd/system` 在不在（systemd 以 PID 1 跑起来的标志）。
// `/run/systemd/system` 为什么是权威判据：tmpfiles 只在 systemd 作为系统 init 运行时才建它 ——
// 容器里没开 systemd、WSL 没开 systemd=true、或者用 sysvinit/openrc 的机器，这个目录都不存在。
const PREFLIGHT_ITEMS = [
  {
    key: 'systemd',
    label: 'systemd（systemctl / journalctl）',
    need: 'DSH Web / qq-bridge / 控制面都是 systemd 管的服务；日志尾也走 journalctl',
    fix: '装 systemd：Debian/Ubuntu `apt install systemd`；RHEL 系 `dnf install systemd`（一般自带）',
    probe: () => {
      const sctl = probeVersion('systemctl');
      const jctl = probeVersion('journalctl');
      if (!sctl.ok && !jctl.ok) return { ok: false, detail: `systemctl ${sctl.detail || '缺'}；journalctl ${jctl.detail || '缺'}` };
      return { ok: true, detail: '' };
    },
  },
  {
    key: 'systemd-pid1',
    label: 'systemd 是 PID 1',
    need: '不是 PID 1 就没法用它托管服务（容器里默认没有、WSL 默认也没有）',
    fix: '容器：换带 systemd 的镜像，或直接在宿主机上跑；WSL：`/etc/wsl.conf` 写 `[boot]\\nsystemd=true` 后 `wsl --shutdown` 再进',
    probe: () => {
      if (fs.existsSync('/run/systemd/system')) return { ok: true, detail: '' };
      let pid1 = '';
      try { pid1 = fs.readFileSync('/proc/1/comm', 'utf8').trim(); } catch { /* 读不到就算了 */ }
      return { ok: false, detail: pid1 ? `/run/systemd/system 不存在（PID 1 现在是 ${pid1}）` : '/run/systemd/system 不存在' };
    },
  },
  {
    key: 'docker',
    label: 'docker',
    need: 'SnowLuma 走官方 Docker 路线（镜像里带 Linux QQ + Xvfb + noVNC）',
    fix: '装 Docker Engine：见 deploy/linux/README.md「装 docker」（别用 snap 的 docker，ptrace 权限会被 AppArmor 挡）',
    probe: () => probeVersion('docker'),
  },
  {
    key: 'docker-compose',
    label: 'docker compose（v2 插件）',
    need: '起停 QQ 网关容器（`docker compose -f deploy/linux/docker-compose.yml ...`）',
    fix: '装 compose v2 插件：`apt install docker-compose-v2`（Debian/Ubuntu）或按 docs.docker.com 的 compose 插件安装页；老的 `docker-compose`（v1 脚本）本驱动不认',
    probe: () => probeVersion('docker', ['compose', 'version']),
  },
];

// 仓库里"驱动要用的文件"在不在（docker 的 compose/.env、三个 unit）。
function fileItems(doc, root = ROOT) {
  const spec = doc.platforms?.linux ?? {};
  const rel = [];
  if (spec.compose) rel.push([spec.compose, 'docker 步骤要用它起容器']);
  if (spec.envFile) rel.push([spec.envFile, 'compose 的端口/令牌都从这里来（别把值写进 compose）']);
  for (const u of Object.values(spec.units ?? {})) if (u?.file) rel.push([u.file, `systemd 单元（装到 /etc/systemd/system/${u.name}）`]);
  const out = [];
  for (const [f, why] of rel) {
    const abs = path.join(root, String(f).replace(/\\/g, '/'));
    out.push({
      key: `file:${f}`,
      label: f,
      need: why,
      fix: f === spec.envFile
        ? '`cp deploy/linux/.env.example deploy/linux/.env && chmod 600 deploy/linux/.env`，端口那几行用 `node tools/control-driver.mjs --print-env` 生成'
        : '仓库里少了这个文件 —— `git status` 看一眼是不是没同步全（deploy/linux/ 是新目录）',
      ok: fs.existsSync(abs),
      missingDetail: fs.existsSync(abs) ? '' : '仓库里找不到这个文件',
    });
  }
  return out;
}

// 预检结果按进程缓存（载波的 /api/control/actions 每次请求都会问一次平台报告，别每次都 spawn 一遍）。
let _pfCache = new Map();
export function linuxPreflight(doc = null, { platform = 'linux', root = ROOT, cache = true, includeFiles = true } = {}) {
  const key = `${platform}:${root}`;
  if (cache && _pfCache.has(key)) return _pfCache.get(key);
  const catalog = doc ?? loadCatalog();
  const items = [];
  for (const it of PREFLIGHT_ITEMS) {
    const r = it.probe();
    items.push({ key: it.key, label: it.label, need: it.need, fix: it.fix, ok: r.ok, detail: r.ok ? '' : (r.detail || '') });
  }
  if (includeFiles) items.push(...fileItems(catalog, root));
  const missing = items.filter((i) => !i.ok);
  const result = { platform, ok: missing.length === 0, items, missing };
  if (cache) _pfCache.set(key, result);
  return result;
}
export function resetPreflightCache() { _pfCache = new Map(); }

// 一个动作的 steps 各自需要什么工具（**由 runner 推导**，不是另写一张表）。
const RUNNER_NEEDS = {
  systemctl: ['systemd', 'systemd-pid1'],
  journalctl: ['systemd', 'systemd-pid1'],
  docker: ['docker', 'docker-compose'],
  node: [],
  print: [],
};

// 这个动作在这个平台上"缺什么才跑不了"（空数组 = 能跑）。给预检错误与平台报告共用。
export function actionBlockers(doc, action, pf, platform = 'linux', root = ROOT) {
  const entry = action?.platform?.[platform];
  if (entry === null || entry === undefined) return [{ key: 'no-driver', label: '这个动作在这个平台上还没有执行体', need: '', fix: '见 docs\\部署到服务器.md §10.11' }];
  if (entry.applicable === false) return [];   // 不适用 ≠ 缺东西：它本来就什么都不做（驱动会打印原因并拒绝）
  const spec = doc.platforms?.[platform] ?? {};
  const needs = new Set();
  for (const s of entry.steps ?? []) for (const n of (RUNNER_NEEDS[s.runner] ?? [])) needs.add(n);
  // docker 步骤还要 compose 文件与 .env 真的在（否则命令一定失败）
  if ([...(entry.steps ?? [])].some((s) => s.runner === 'docker')) {
    for (const f of [spec.compose, spec.envFile]) if (f) needs.add(`file:${f}`);
  }
  const byKey = new Map((pf?.items ?? []).map((i) => [i.key, i]));
  return [...needs].map((k) => byKey.get(k)).filter((i) => i && !i.ok);
}

// 那条"预检不过"的人话错误：缺哪个、怎么装、以及"现在这个平台能跑 X/N 个动作"。
export function linuxGateMessage(doc, platform = 'linux', pf = null, { items = true } = {}) {
  const pre = pf ?? linuxPreflight(doc, { platform });
  const acts = doc.actions ?? [];
  const runnable = acts.filter((a) => {
    const entry = a.platform?.[platform];
    if (!entry || entry.applicable === false) return false;
    return actionBlockers(doc, a, pre, platform).length === 0;
  });
  const lines = [
    `[控制面] Linux 驱动预检不过 —— 这个平台上控制面现在能跑 ${runnable.length}/${acts.length} 个动作`,
  ];
  if (items) {
    for (const m of pre.missing) {
      const isFile = String(m.key).startsWith('file:');
      lines.push(`  ❌ 缺 ${m.label}${m.detail ? `（${m.detail}）` : ''}`);
      if (!isFile && m.need) lines.push(`        它管什么：${m.need}`);
      lines.push(`        怎么办：${m.fix}`);
    }
  }
  const okItems = pre.items.filter((i) => i.ok);
  if (okItems.length) lines.push(`  已经有：${okItems.map((i) => `✅ ${i.label}`).join(' · ')}`);
  lines.push(`  · 还能跑的动作：${runnable.length ? runnable.map((a) => a.id).join(' / ') : '（一个都没有）'} —— 它们不需要上面缺的那些工具`);
  lines.push('  · 缺东西**不会**被降级或跳过：真跑这个动作会以退出码 3 拒绝（绝不假装成功）');
  lines.push('  · 逐条看：node tools\\control-driver.mjs --check --platform linux');
  return lines.join('\n');
}
export function assertLinuxReady(doc = null, platform = 'linux') {
  const pre = linuxPreflight(doc ?? loadCatalog(), { platform });
  if (pre.ok) return true;
  throw new ControlPlatformError(linuxGateMessage(doc ?? loadCatalog(), platform, pre), platform);
}

// ── Linux：把目录里的 steps 拼成**真命令** ────────────────────────────────────
// 占位符（目录里写，这里替换；**占位符只许来自这几类**，绝不接受自由输入）：
//   {target} / {tail}     → 动作自己的参数（validateCatalog 已保证名字对得上）
//   {port:<key>}          → 配置层的端口（resolvePorts()；novnc 例外，见下）
//   {unit:<key>}          → platforms.linux.units[key].name（单元名只有一处定义）
//   {compose} / {envfile} → platforms.linux.compose / envFile（相对仓库根）
export function linuxContext(doc, { target = '', tail = null, root = ROOT, ports = null, display = 'absolute' } = {}) {
  const spec = doc.platforms?.linux ?? {};
  const p = ports ?? resolvePorts();
  return {
    root,
    display,
    target: String(target ?? ''),
    tail: tail === null || tail === undefined ? '' : String(tail),
    ports: p,
    units: spec.units ?? {},
    compose: String(spec.compose ?? ''),
    envFile: String(spec.envFile ?? ''),
    envExample: String(spec.envExample ?? ''),
  };
}
// noVNC 端口不在配置层（它是上游镜像自己的端口）⇒ 从 deploy/linux/.env 里读，读不到就**原样留占位符**
// 让打印出来的人自己看见"这个值还没定"，而不是我们编一个数字。
function novncPort(ctx) {
  try {
    const text = fs.readFileSync(path.join(ctx.root, ctx.envFile.replace(/\\/g, '/')), 'utf8');
    const m = text.match(/^\s*NOVNC_PORT\s*=\s*(\d+)\s*$/m);
    if (m) return m[1];
  } catch { /* 没配就是没配 */ }
  return '${NOVNC_PORT}';
}
export function fillLinuxPlaceholders(text, ctx) {
  return String(text)
    .replace(/\{target\}/g, ctx.target)
    .replace(/\{tail\}/g, ctx.tail)
    .replace(/\{compose\}/g, ctx.compose)
    .replace(/\{envfile\}/g, ctx.envFile)
    .replace(/\{unit:([a-z][a-z0-9-]*)\}/g, (_m, k) => ctx.units?.[k]?.name ?? `{unit:${k}}`)
    .replace(/\{port:([a-zA-Z][a-zA-Z0-9]*)\}/g, (_m, k) => (k === 'novnc' ? novncPort(ctx) : String(ctx.ports?.[k] ?? `{port:${k}}`)));
}

// 一条 step → "要跑的命令"（print 类没有命令，返回 null）。
// `ctx.display==='relative'` 时路径按**仓库根相对**渲染（`--print` 用：在 Windows 上核 Linux 计划时，
// 屏幕上是 `deploy/linux/docker-compose.yml` 而不是 `D:\hobby\DSH\...`，也不会把本机的 node 绝对路径
// 混进一份"Linux 计划"里）。真执行时一律用绝对路径（WorkingDirectory 不依赖调用方 cwd）。
function relFor(p, ctx) {
  const abs = path.join(ctx.root, String(p).replace(/\\/g, '/'));
  return ctx.display === 'relative' ? path.relative(ctx.root, abs).split(path.sep).join('/') : abs;
}
export function renderLinuxStep(step, ctx) {
  const args = (step.args ?? []).map((a) => fillLinuxPlaceholders(a, ctx));
  switch (step.runner) {
    case 'systemctl': return { cmd: 'systemctl', args };
    case 'journalctl': return { cmd: 'journalctl', args };
    case 'node': return { cmd: ctx.display === 'relative' ? 'node' : process.execPath, args: [relFor(step.script, ctx), ...args] };
    case 'docker': return {
      cmd: 'docker',
      args: ['compose', '-f', relFor(ctx.compose, ctx), '--env-file', relFor(ctx.envFile, ctx), ...args],
    };
    case 'print': return null;
    default: return null;
  }
}
// 给 `--print` / 错误信息看的一行（带引号，能直接复制去跑）
export function shellQuote(a) {
  const s = String(a);
  return /[\s"'$`\\|&;<>()*?]/.test(s) ? `'${s.replace(/'/g, `'\\''`)}'` : s;
}
export function formatCommand(cmd, args) {
  return [cmd, ...args].map(shellQuote).join(' ');
}
// 一个动作在这个平台上的命令清单（`--print` 与执行**共用同一份**命令渲染，所以打印出来的就是真会跑的）。
export function linuxCommands(action, ctx, { target = '' } = {}) {
  const entry = action.platform?.linux;
  if (!entry || entry.applicable === false) return [];
  const steps = (entry.steps ?? []).filter((s) => !s.when || s.when.includes(String(target ?? '')));
  const out = [];
  for (const s of steps) {
    const r = renderLinuxStep(s, ctx);
    if (r) out.push({ step: s, cmd: r.cmd, args: r.args, line: formatCommand(r.cmd, r.args) });
    else out.push({ step: s, cmd: null, args: [], line: null, text: (s.lines ?? []).map((l) => fillLinuxPlaceholders(l, ctx)).join('\n') });
  }
  return out;
}
// 某个动作在某个平台上的**逐步命令清单**（给 `--print` 与 /api/control/actions 用）。
// linux：按 target 的每个取值各展开一遍（带 when 的 step 只出现在它那一组）；
// win32：先给外观那一条（control.ps1 的 argv），再给 steps（when 是给人看的条件描述）。
export function platformStepsFor(action, doc, platform, { display = 'relative' } = {}) {
  const out = [];
  if (platform !== 'linux') {
    const w = action.platform?.[platform];
    if (!w) return out;
    if (typeof w.script === 'string') {
      out.push({ when: '', label: '外观（唯一动作源）', cmd: `powershell -NoProfile -ExecutionPolicy Bypass -File ${w.script} ${(w.args ?? []).join(' ')}`.trim(), text: '' });
    }
    for (const s of w.steps ?? []) {
      // cmd：启动器这类 .cmd 入口（restart-stack 的真工人）—— 别说成 node/powershell，那是假话。
      const head = s.runner === 'ps1' ? `powershell -File ${s.script}`
        : s.runner === 'cmd' ? `cmd /d /c ${s.script}`
          : `node ${s.script}`;
      out.push({ when: s.when ?? '', label: s.label, cmd: `${head}${(s.args ?? []).length ? ` ${s.args.join(' ')}` : ''}`, text: '' });
    }
    return out;
  }
  const entry = action.platform?.linux;
  if (!entry || entry.applicable === false) return out;
  const tailSpec = (action.params ?? []).find((p) => p.name === 'tail');
  const ctx = linuxContext(doc, { tail: tailSpec ? tailSpec.default : null, display });
  const values = (paramValues(action, 'target') ?? []).length ? paramValues(action, 'target') : [''];
  for (const v of values) {
    for (const s of entry.steps ?? []) {
      if (s.when && !s.when.includes(v)) continue;
      const c = renderLinuxStep(s, { ...ctx, target: v });
      out.push({
        when: v,
        label: s.label,
        cmd: c ? formatCommand(c.cmd, c.args) : '',
        text: c ? '' : (s.lines ?? []).map((l) => fillLinuxPlaceholders(l, { ...ctx, target: v })).join('\n'),
      });
    }
  }
  return out;
}

// ── Linux：跑一个动作 ────────────────────────────────────────────────────────
// 输入形状与 win32 那半**逐字相同**：args = 目录里 `platform.win32.args` 拼出来的外观 argv
// （control-server.mjs 就是这么调的）。Linux 上没有 control.ps1 这层外观，所以这里把 argv
// **反解**回"动作 + 参数"，再去执行 linux 的 steps —— 这就是"外观"在 Linux 上的等价物。
export function parseFacadeArgs(doc, args) {
  const list = (args ?? []).map(String);
  const action = findAction(doc, list[0] ?? '');
  if (!action) throw new Error(`动作目录里没有「${list[0] ?? ''}」`);
  const rest = list.slice(1);
  const values = paramValues(action, 'target') ?? [];
  const target = rest.find((a) => !a.startsWith('-') && values.includes(a.toLowerCase())) ?? '';
  const ti = rest.indexOf('-Tail');
  const rawTail = ti >= 0 ? Number(rest[ti + 1]) : null;
  const spec = (action.params ?? []).find((p) => p.name === 'tail');
  let tail = Number.isFinite(rawTail) ? Math.trunc(rawTail) : (spec ? spec.default : null);
  if (spec && tail !== null) tail = Math.max(spec.min, Math.min(spec.max, tail));
  return { action, verb: action.id, target: String(target).toLowerCase(), tail, json: rest.includes('-Json') };
}

function selectLinuxSteps(entry, target) {
  return (entry.steps ?? []).filter((s) => !s.when || s.when.includes(String(target ?? '')));
}

async function runLinuxSteps(entry, ctx, { target = '', timeoutMs = 60000, echo = false } = {}) {
  const runs = [];
  let code = 0;
  for (const s of selectLinuxSteps(entry, target)) {
    const r = renderLinuxStep(s, ctx);
    if (!r) {
      const text = (s.lines ?? []).map((l) => fillLinuxPlaceholders(l, ctx)).join('\n');
      runs.push({ step: s, line: null, text, exitCode: 0, stdout: '', stderr: '' });
      continue;
    }
    const line = formatCommand(r.cmd, r.args);
    if (echo) process.stdout.write(`  $ ${line}\n`);
    const res = await spawnCapture(r.cmd, r.args, { timeoutMs, cwd: ctx.root });
    runs.push({ step: s, line, text: '', exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr });
    // 一条失败就继续跑剩下的（拆服务时"停一半"比"什么都不停"更容易收拾），但退出码取第一个非 0。
    if (res.exitCode !== 0 && code === 0) code = res.exitCode;
  }
  return { code, runs };
}

export async function runLinuxControl(args, { timeoutMs = 60000, doc = null, ctxPorts = null } = {}) {
  const catalog = doc ?? loadCatalog();
  const { action, verb, target, tail, json } = parseFacadeArgs(catalog, args);
  const entry = action.platform?.linux;
  if (!entry) return { exitCode: 3, stdout: '', stderr: `[控制面] 动作「${verb}」在 Linux 上没有执行体（目录里是 null）\n` };
  if (entry.applicable === false) {
    return {
      exitCode: 2,
      stdout: '',
      stderr: [
        `[控制面] 动作「${verb}」在 Linux 上**整段不适用**（不是没实现）：`,
        `  ${entry.notApplicableReason ?? '（目录里没写原因）'}`,
        '  · 在服务器上看那三个页面的正确做法：SSH 隧道 + 你自己电脑上的浏览器（`node tools\\control-driver.mjs --check` 里有地址）',
      ].join('\n') + '\n',
    };
  }

  const pf = linuxPreflight(catalog, { platform: 'linux' });
  const blockers = actionBlockers(catalog, action, pf, 'linux');
  if (blockers.length) {
    return {
      exitCode: 3,
      stdout: '',
      stderr: `${[
        `[控制面] Linux 上跑不了「${verb}」：缺 ${blockers.length} 样东西`,
        ...blockers.map((b) => `  ❌ 缺 ${b.label}${b.detail ? `（${b.detail}）` : ''}\n        怎么办：${b.fix}`),
      ].join('\n')}\n${linuxGateMessage(catalog, 'linux', pf, { items: false })}\n`,
    };
  }

  const ctx = linuxContext(catalog, { target, tail, ports: ctxPorts });
  const shape = entry.shape ?? null;

  // guard=all-green（目录里写的）：五灯全绿就**一条命令都不跑** —— 与 win32 的 up 同一口径，
  // 免得"确保在跑"这件事把主人正在用的会话白掐断一次。
  if (entry.guard === 'all-green') {
    const st = await spawnCapture(process.execPath, [path.join(ROOT, 'tools', 'ops.mjs'), 'status', '--json'], { timeoutMs });
    let green = false;
    try {
      const j = JSON.parse(st.stdout.slice(st.stdout.indexOf('{'), st.stdout.lastIndexOf('}') + 1));
      green = !!j.allGreen;
    } catch { /* 读不到就当没全绿，照常往下走（宁可多跑一次幂等的 start） */ }
    if (green) return { exitCode: 0, stdout: '  五灯全绿 —— 什么都没做（幂等：up 的口径与 win32 一致）\n', stderr: '' };
  }

  // ① 只打印型（login）：不执行任何东西，输出就是目录里那份文字。
  //    ⚠ 判据要带 `steps.length`：空数组的 `.every()` 也返回 true —— 不加这一条，help（steps 空）
  //    会走进这个分支打出一片空白，而不是下面那段"用法屏"。
  if ((entry.steps ?? []).length > 0 && (entry.steps ?? []).every((s) => s.runner === 'print')) {
    const { runs } = await runLinuxSteps(entry, ctx, { target, timeoutMs });
    const text = runs.map((r) => r.text).filter(Boolean).join('\n');
    return { exitCode: 0, stdout: `${text}\n`, stderr: '' };
  }
  if ((entry.steps ?? []).length === 0) {
    // 没有执行体（help）：用法屏由**动作目录**现场渲染（同一份数据，不抄第二份）。
    return { exitCode: 0, stdout: `${usageScreen(catalog)}\n`, stderr: '' };
  }

  // ★ 已知启动窗口：Linux 上"**真正发起启动/重启**"就是这里（win32 那半是 control.ps1 的 up /
  //   restart 动作分支），两边盖的是**同一个文件**、同一个形状；"多久算正在起"那个数字不在这儿
  //   （tools\starting-window.mjs 一处）。判定哪些动作用 `isStartingAction`（与 control.ps1 的分支
  //   一一对应：up / restart all|dsh|bridge 会把桥接带下去；snowluma / control 不碰它）。
  if (isStartingAction(verb, target)) markStarting(ROOT, verb, { by: 'control-driver.mjs' });

  const { code, runs } = await runLinuxSteps(entry, ctx, { target, timeoutMs });

  if (shape === 'status-contract') {
    const raw = runs.map((r) => r.stdout).join('\n');
    let ops = null;
    try {
      const a = raw.indexOf('{');
      const b = raw.lastIndexOf('}');
      if (a >= 0 && b > a) ops = JSON.parse(raw.slice(a, b + 1));
    } catch { /* 下面按失败报 */ }
    if (!ops) {
      return { exitCode: code || 4, stdout: '', stderr: `[控制面] 取不到状态：node tools/ops.mjs status --json 的输出解析不了\n${runs.map((r) => r.stderr).join('')}` };
    }
    const payload = shapeStatusContract(ops, ctx.ports, ctx.root);
    return { exitCode: 0, stdout: json ? `${JSON.stringify(payload, null, 2)}\n` : `${renderStatusText(payload)}\n`, stderr: '' };
  }
  if (shape === 'logs-tail') {
    const text = runs.map((r) => r.stdout).filter((s) => s !== '').join('\n').replace(/\r\n/g, '\n').trimEnd();
    const source = runs.filter((r) => r.line).map((r) => r.line).join(' && ') || 'journalctl';
    if (!json) return { exitCode: code, stdout: `${text}\n`, stderr: runs.map((r) => r.stderr).join('') };
    const payload = { action: 'logs', source, ok: code === 0, which: ctx.target, tail: Number(ctx.tail) || null, text };
    if (code !== 0) payload.error = runs.map((r) => r.stderr).join('').trim();
    return { exitCode: code, stdout: `${JSON.stringify(payload, null, 2)}\n`, stderr: '' };
  }

  // ② 其余动作：把每条命令与它的输出都交出去（CLI 上直接看得见"跑了什么"）。
  const lines = [];
  for (const r of runs) {
    if (r.line) lines.push(`$ ${r.line}`);
    if (r.stdout) lines.push(r.stdout.replace(/\s+$/, ''));
    if (r.stderr) lines.push(r.stderr.replace(/\s+$/, ''));
  }
  return { exitCode: code, stdout: `${lines.join('\n')}\n`, stderr: '' };
}

// ── §3.1 契约（Linux 侧拼装；win32 侧由 control.ps1 拼 —— 见文件头那条说明）──────────
function localParts(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return {
    iso: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`,
    clock: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
  };
}
function lightsOf(status) {
  const up = new Map((status.ports ?? []).map((p) => [String(p.key), !!p.open]));
  return {
    dsh: !!up.get('dsh'),
    bridge: !!up.get('bridge'),
    snowluma: !!up.get('snowluma'),
    qq: String(status.qq?.state ?? '') === 'online',
    token: !!(status.token && status.token.synced),
  };
}
function lastEventOf(root) {
  const file = path.join(root, 'qq-bridge', 'state', 'bridge.log');
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  if (!stat.size) return null;
  const take = Math.min(8192, stat.size);
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(take);
      const read = fs.readSync(fd, buf, 0, take, stat.size - take);
      text = buf.subarray(0, read).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return null; }
  let lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > 1) lines = lines.slice(1);   // 第一行多半是从中间切进去的半截行
  if (!lines.length) return null;
  let line = lines[lines.length - 1].trim();
  if (!line) return null;
  let lineUtc = '';
  const m = line.match(/^(\d{2}:\d{2}:\d{2})\s+(.*)$/);
  if (m) { lineUtc = m[1]; line = m[2].trim(); }
  if (line.length > 160) line = `${line.slice(0, 160)}…`;
  const at = localParts(new Date(stat.mtimeMs));
  return { text: line, at: at.iso, atClock: at.clock, lineUtc, source: 'bridge' };
}
function onboardedOf(lights, root) {
  const file = path.join(root, 'qq-bridge', 'state', 'onboarded.json');
  if (fs.existsSync(file)) {
    try {
      const o = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
      if (o.completedAt) return { done: true, source: 'state\\onboarded.json' };
      return { done: false, source: 'state\\onboarded.json（还没走完）' };
    } catch { return { done: false, source: 'state\\onboarded.json（读不了）' }; }
  }
  if (lights.qq && lights.token && lights.bridge) return { done: true, source: '推断：QQ 在线且链路通（没有 state\\onboarded.json）' };
  return { done: false, source: '没有 state\\onboarded.json' };
}
// ★ 这几句中文与 control.ps1 的 Get-NextAction / Get-Onboarded / Get-DiagnosticCode **逐字一致**：
//   面板按 action 渲染按钮、按 text 显示一句话；两份文案一旦漂移，两个平台的引导就不是同一句了。
//   `--contract-check`（win32 上）会把这两份直接对照出来。
// ★ 已知启动窗口（2026-09-24 晚，主人实拍那屏"上一行说不用按 b、下一行却叫你按 r"）：
//   `starting` 是 node tools\ops.mjs status --json 给的**判定结果**（tools\starting-window.mjs 一处算的），
//   这里只决定文案与 action。宽限期一过 `starting.active` 就是 false ⇒ 下一行**原样**回到
//   `⚠ 桥接断了` + restart —— 真故障一个字都不许吞。
function nextActionOf(lights, onboarded, starting = null, displayName = botDisplayName('')) {
  if (!lights.dsh) return { text: '⚠ DSH 没在跑', action: 'up' };
  if (!lights.qq) return { text: '⚠ QQ 没登录', action: 'login' };
  if (!lights.bridge && starting && starting.active) return { text: '⏳ 正在起（桥接还在启动，不用管）', action: 'none' };
  if (!lights.bridge) return { text: '⚠ 桥接断了', action: 'restart' };
  if (!lights.token) return { text: '⚠ 登录态过期', action: 'restart' };
  if (!lights.snowluma) return { text: '⚠ SnowLuma 没起来', action: 'restart' };
  if (!onboarded.done) return { text: '第一次用：① 扫码登录 QQ ② 在 QQ 里发一句「你好」', action: 'login' };
  return { text: `一切正常 · 在 QQ 里跟「${displayName}」说话就行（这个窗口没事不用管）`, action: 'none' };
}
function diagnosticCodeOf(lights) {
  return `CTL-${['dsh', 'bridge', 'snowluma', 'qq', 'token'].map((k) => (lights[k] ? '1' : '0')).join('')}`;
}
// "判定来源"那一行（§3.1 契约里的 source）：路径分隔符按**目标平台**走 ——
// win32 上 control.ps1 写的是 `node tools\ops.mjs status --json`，Linux 上写正斜杠才跑得起来。
// `--contract-check` 就是拿这条当"两份契约是否一致"的探针之一（第一版这里差了一个反斜杠，它当场抓到了）。
function opsSourceLine(args = []) {
  const sep = PLATFORM === 'win32' ? '\\' : '/';
  return `node tools${sep}ops.mjs${args.length ? ` ${args.join(' ')}` : ''}`;
}
// 已知启动窗口的判定（由 node tools\ops.mjs status --json 的 `starting` 字段带来）。
// 只在**一处**读它：没有这个字段（老 JSON / 手写的测试钩子）一律当"不在启动窗口里"——
// 宁可多报一次真故障，也不假装正常。
function opsStarting(status) {
  return status && typeof status === 'object' && status.starting ? status.starting : null;
}
export function shapeStatusContract(status, ports, root = ROOT) {
  const lights = lightsOf(status);
  const onboarded = onboardedOf(lights, root);
  const lightList = [
    ['dsh', 'DSH', `DSH Web :${ports.dshWeb}`],
    ['bridge', '桥接', `桥接控制台 :${ports.bridgeConsole}`],
    ['snowluma', 'SnowLuma', `SnowLuma WS :${ports.snowlumaWs}（含 OneBot :${ports.onebotHttp} / 管理页 :${ports.snowlumaWeb}）`],
    ['qq', 'QQ', `QQ 账号 ${status.qq?.state ?? ''}`],
    ['token', '令牌', 'config.json 与最新 guard 日志同一令牌'],
  ].map(([key, label, detail]) => ({ key, label, on: !!lights[key], detail }));
  return {
    action: 'status',
    source: opsSourceLine(['status', '--json']),
    ok: true,
    allGreen: !!status.allGreen,
    lights: { dsh: lights.dsh, bridge: lights.bridge, snowluma: lights.snowluma, qq: lights.qq, token: lights.token },
    lightList,
    // ★ 那句话里的机器人名字**不许硬编码**（原来写着「小懒鲸」—— 交付给别人就指向别人的机器人）：
    //   环境层 displayName > 网关登录昵称（status.qq.nickname）> 「你的机器人」。
    nextAction: nextActionOf(lights, onboarded, opsStarting(status), botDisplayName(status?.qq?.nickname)),
    // ★ 已知启动窗口的判定结果：原样透传 ops.mjs 的 `starting`（**这里不算秒数**，只搬字段 ——
    //   与 control.ps1 的 `starting = $status.starting` 一一对应，--contract-check 会比这两份）。
    starting: opsStarting(status),
    diagnosticCode: diagnosticCodeOf(lights),
    lastEvent: lastEventOf(root),
    onboarded: { done: !!onboarded.done, source: onboarded.source },
    ports: status.ports,
    token: status.token,
    qq: status.qq,
    generatedAt: status.generatedAt,
  };
}
// 显示宽度（中文按 2 算）—— control.ps1 的 Pad-Display 同一口径，让两个平台的端口表**逐列对齐**。
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if ((c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) ||
        (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe6f) || (c >= 0xff00 && c <= 0xff60) ||
        (c >= 0xffe0 && c <= 0xffe6)) w += 2; else w += 1;
  }
  return w;
}
function padDisplay(s, width) {
  const pad = Math.max(0, width - displayWidth(s));
  return String(s) + ' '.repeat(pad);
}
export function renderStatusText(payload) {
  const out = ['── 控制面 status（Linux；判定＝node tools/ops.mjs status --json，同一口径）──'];
  for (const p of payload.ports ?? []) {
    out.push(`  ${padDisplay(p.label, 13)} : ${p.open ? 'OK  ' : 'DOWN'}  127.0.0.1:${Number(p.port)}`);
  }
  const lamp = (b) => (b ? '✓' : '✗');
  const l = payload.lights;
  const on = Object.values(l).filter(Boolean).length;
  out.push(`  五灯：DSH ${lamp(l.dsh)} ｜ 桥接 ${lamp(l.bridge)} ｜ SnowLuma ${lamp(l.snowluma)} ｜ QQ ${lamp(l.qq)} ｜ 令牌 ${lamp(l.token)}   （${on}/5）`);
  if (l.qq) out.push(`  QQ  ：在线 ${payload.qq?.nickname ?? ''} (${payload.qq?.userId ?? ''})`);
  else out.push(`  QQ  ：${payload.qq?.state ?? ''} ${payload.qq?.raw ?? ''}${payload.qq?.message ?? ''}`);
  out.push(`  令牌：${payload.token?.configMasked ?? ''} / 日志 ${payload.token?.logFile ?? ''}（同步：${payload.token?.synced}）`);
  out.push(`  引导：${payload.onboarded?.done ? '已完成' : '未完成'}（${payload.onboarded?.source ?? ''}）`);
  out.push(`  下一动作：${payload.nextAction?.text ?? ''}`);
  if (!payload.allGreen) out.push(`  诊断码：${payload.diagnosticCode}（修不好时把这行发我）`);
  out.push('  （JSON 版：页面面板走载波 /api/control/status —— 那条路拿到的就是本驱动拼的 §3.1 契约）');
  return out.join('\n');
}
// 用法屏：**从动作目录现场渲染**（usage / usageRow / params 都在目录里，这里不抄第二份）。
export function usageScreen(doc) {
  const rows = [1, 2].map((r) => doc.actions.filter((a) => typeof a.usage === 'string' && a.usage && a.usageRow === r).map((a) => a.usage));
  const out = [
    'control-driver.mjs —— Linux 上的控制面（动作清单与参数枚举来自 tools\\control-actions.json）',
  ];
  for (const parts of rows) if (parts.length) out.push(`  ${parts.join(' | ')}`);
  out.push('  用法：node tools\\control-driver.mjs --check ｜ --print [动作] ｜ --json ｜ --self-test');
  out.push('  （Windows 那半的外观是 tools\\control.ps1；两个平台的动作清单是同一份数据）');
  return out.join('\n');
}

// ── win32：跑外观脚本（**唯一动作源**）────────────────────────────────────────
// ⚠ 已知坑（前三批踩过）：PS 5.1 抓子进程 stdout 时，子进程按 OEM(936) 写中文 ⇒ 乱码。
//   这里用 `-EncodedCommand`（免引号转义）+ 子进程**先显式把 [Console]::OutputEncoding 钉成 UTF-8**，
//   与 tools\dsh-prompt.ps1 的 Get-ControlStatus 同一套做法。
// ★ 为什么**不用管道**：① 控制动作会拉起孙子进程（start-all.ps1 → cmd → node），
//   孙子会攥住 stdout 管道 ⇒ 'close' 永远不来、调用方卡死（项目里已经为此弃用过
//   ProcessStartInfo.CreateNoWindow，同一个病）；② 某些受限环境下 node 的 pipe stdio 直接 EPERM。
//   所以改成**文件重定向**（与 tools\windowless.ps1"cmd 级文件重定向"同一思路）：
//   进程退出一结算就读文件，孙子还攥着也不影响我们已经拿到的内容。
function encodePsCommand(cmd) {
  return Buffer.from(cmd, 'utf16le').toString('base64');
}

export function runControlPs1(args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const inner = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${CONTROL.replace(/'/g, "''")}' ${args.join(' ')}`;
    let outPath;
    let errPath;
    let outFd;
    let errFd;
    try {
      fs.mkdirSync(TMP_DIR, { recursive: true });
      const stamp = `${process.pid}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      outPath = path.join(TMP_DIR, `control-server-${stamp}.out`);
      errPath = path.join(TMP_DIR, `control-server-${stamp}.err`);
      outFd = fs.openSync(outPath, 'w');
      errFd = fs.openSync(errPath, 'w');
    } catch (e) {
      resolve({ exitCode: -1, stdout: '', stderr: `[control-server] 建临时文件失败：${e.message}` });
      return;
    }

    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodePsCommand(inner),
      ], {
        cwd: ROOT,
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
      });
    } catch (e) {
      try { fs.closeSync(outFd); fs.closeSync(errFd); } catch { /* 无所谓 */ }
      resolve({ exitCode: -1, stdout: '', stderr: `[control-server] 起不来 powershell：${e.message}` });
      return;
    }

    let settled = false;
    let exitCode = null;
    const cleanup = () => {
      try { fs.closeSync(outFd); } catch { /* 已经关了 */ }
      try { fs.closeSync(errFd); } catch { /* 已经关了 */ }
    };
    const readBack = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
    const finish = (note = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      cleanup();
      const stderr = readBack(errPath) + note;
      resolve({
        exitCode: exitCode === null ? -1 : exitCode,
        stdout: readBack(outPath),
        stderr,
      });
      // 临时文件用完就删（_tmp 只该留产物，不该被这里灌满）
      try { fs.unlinkSync(outPath); } catch { /* 被孙子攥着就下次再说 */ }
      try { fs.unlinkSync(errPath); } catch { /* 同上 */ }
    };
    let grace = null;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已经没了 */ }
      finish(`\n[control-server] 超时 ${timeoutMs}ms，已放弃等待\n`);
    }, timeoutMs);

    child.on('error', (e) => {
      finish(`\n[control-server] 子进程错误：${e.message}\n`);
    });
    child.on('exit', (code) => {
      exitCode = code;
      grace = setTimeout(finish, 500);  // 给它一点时间把最后几行刷进文件
    });
  });
}

// ── 驱动入口（平台闸门 + 分派）────────────────────────────────────────────────
export function runControl(args, opts = {}) {
  assertSupported();   // ★ 平台闸门：没驱动的平台在这里抛人话错误，绝不"试一下 powershell.exe 看看"
  return PLATFORM === 'win32' ? runControlPs1(args, opts) : runLinuxControl(args, opts);
}

// 这个平台上"每个动作能不能跑、为什么"（给人也给程序看；面板的 /api/control/actions 用它）。
export function platformReport(doc = loadCatalog(), platform = PLATFORM) {
  const driver = driverFor(platform);
  // 预检只在真有 linux 驱动时做（win32 那半一个探针都不加，行为与上一批逐字相同）。
  const pre = driver === 'control-linux' ? linuxPreflight(doc, { platform }) : null;
  return {
    platform,
    driver,
    supported: driver !== null,
    reason: driver === null ? unsupportedReason(doc, platform) : null,
    implementedPlatforms: Object.entries(doc.platforms ?? {}).filter(([, v]) => v.supported === true).map(([k]) => k),
    preflight: pre ? { ok: pre.ok, missing: pre.missing.map((m) => ({ key: m.key, label: m.label, fix: m.fix, detail: m.detail })) } : null,
    actions: doc.actions.map((a) => {
      const entry = a.platform?.[platform] ?? null;
      const blockers = driver === 'control-linux' ? actionBlockers(doc, a, pre, platform) : [];
      const applicable = entry !== null && entry !== undefined && entry.applicable !== false;
      return {
        id: a.id,
        label: a.label,
        runnable: driver !== null && applicable && blockers.length === 0,
        args: driver === 'control-ps1' ? (entry?.args ?? null) : null,
        why: entry === null || entry === undefined
          ? (unsupportedReason(doc, platform) ?? '未实现')
          : (entry.applicable === false ? (entry.notApplicableReason ?? '不适用') : (blockers.length ? blockers.map((b) => `缺 ${b.label}`).join('；') : null)),
        windowsSteps: (a.platform?.win32?.steps ?? []).map((s) => `${s.when ? `${s.when} → ` : ''}${s.runner === 'ps1' ? 'powershell -File ' : 'node '}${s.script}${(s.args ?? []).length ? ` ${s.args.join(' ')}` : ''}`),
        // 本平台要跑的命令（追加字段；上面的字段一个都没动，老消费方不受影响）
        applicable,
        platformSteps: platformStepsFor(a, doc, platform),
      };
    }),
  };
}

// ── --print-env：compose 那三个宿主端口**从配置层派生**（别手改 .env 里的数字）────────
// 端口名 → compose 变量名的对应关系只有这一处（另一半在 deploy/linux/docker-compose.yml 的
// `127.0.0.1:${VAR}:容器内端口` 里）。这里顺手核一遍那条 compose 里真有这些变量名 —— 名字改了
// 而这边没跟上，就会当场说出来，而不是等到服务器上 compose 报 "variable is not set"。
const COMPOSE_PORT_VARS = [
  ['onebotHttp', 'ONEBOT_HTTP_PORT', 'OneBot HTTP（桥接 snowluma.httpUrl 指它）'],
  ['snowlumaWs', 'SNOWLUMA_WS_PORT', 'OneBot WebSocket（桥接 snowluma.wsUrl 指它）'],
  ['snowlumaWeb', 'SNOWLUMA_WEBUI_PORT', 'SnowLuma 管理页'],
];
export function printEnv(doc = null) {
  const catalog = doc ?? loadCatalog();
  const ports = resolvePorts();
  const composeRel = catalog.platforms?.linux?.compose ?? '';
  let composeText = '';
  try { composeText = fs.readFileSync(path.join(ROOT, String(composeRel).replace(/\\/g, '/')), 'utf8'); } catch { /* 下面会说 */ }
  const out = [
    '# deploy/linux/.env 里那三个宿主端口 —— **由仓库配置层派生**，别手改：',
    '#   改端口请改仓库根 agent.config.json，然后重跑：node tools\\control-driver.mjs --print-env',
    '# （NOVNC_PORT 不在这里：它是上游镜像自己的 noVNC 端口，照 deploy/linux/.env.example 保留）',
  ];
  const warn = [];
  for (const [key, varName, what] of COMPOSE_PORT_VARS) {
    out.push(`${varName}=${ports[key]}   # ${what}`);
    if (composeText && !composeText.includes(varName)) warn.push(`${composeRel} 里找不到变量名 ${varName}`);
  }
  if (!composeText) warn.push(`读不到 ${composeRel}（端口变量名没法与它对账）`);
  if (warn.length) out.push(`# ⚠ ${warn.join('；')}`, '#   ⇒ compose 与本命令的变量名对不上，先改一致再起容器（否则 compose 会报 variable is not set）');
  return out.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function printPlan(doc, platform, only = '') {
  const rep = platformReport(doc, platform);
  const out = [];
  out.push('控制面平台驱动 --print（**只打印命令，不执行任何东西**）');
  out.push(`  目标平台：${platform}（process.platform=${PLATFORM}${platform === PLATFORM ? '' : '；由 --platform 注入，本机不是这个平台'}）`);
  out.push(`  驱动：${rep.driver ?? '(没有)'}`);
  out.push('  路径按**仓库根相对**渲染（真机上仓库根就是 systemd 的 WorkingDirectory；本机的 D:\\... 不会混进来）');
  if (rep.preflight) {
    out.push(`  预检：${rep.preflight.ok ? '✅ 全过' : `❌ 缺 ${rep.preflight.missing.length} 样 —— 真跑相关动作会以退出码 3 拒绝（这里照样打印，因为 --print 不执行）`}`);
    for (const m of rep.preflight.missing) out.push(`  ❌ ${m.label}${m.detail ? `（${m.detail}）` : ''} → ${m.fix}`);
  }
  out.push(`  ${'─'.repeat(60)}`);
  for (const a of rep.actions) {
    if (only && a.id !== only) continue;
    const flag = a.runnable ? '能跑' : (a.applicable ? `跑不了：${a.why}` : '不适用');
    out.push(`  ${a.id.padEnd(8)} ${a.label}   [${flag}]`);
    if (!a.applicable) {
      out.push(`      ⛔ ${a.why}`);
      out.push('      （不适用 ⇒ 没有执行体；驱动收到它会打印这段原因并以退出码 2 拒绝）');
      continue;
    }
    const steps = a.platformSteps ?? [];
    if (!steps.length) { out.push('      （没有执行体：见目录里的 stepsNote）'); continue; }
    for (const s of steps) {
      if (s.cmd) {
        out.push(`      # ${s.when ? `[${s.when}] ` : ''}${s.label}`);
        out.push(`      $ ${s.cmd}`);
      } else if (s.text) {
        for (const line of s.text.split('\n')) out.push(`      ${line}`);
      }
    }
  }
  return out.join('\n');
}

export function main(argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(n);
  const argOf = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
  let doc;
  try { doc = loadCatalog(); } catch (e) { process.stderr.write(`${e.message}\n`); return 1; }

  // --platform：**只改"按哪个平台算"**，绝不改 process.platform（那会把 win32 那半的闸门也一起改掉）。
  const rawPlatform = argOf('--platform');
  const platform = rawPlatform ? String(rawPlatform).toLowerCase() : PLATFORM;
  if (!doc.platforms?.[platform]) {
    process.stderr.write(`[控制面] 目录里没有平台「${platform}」—— 有的是：${Object.keys(doc.platforms ?? {}).join(' / ')}\n`);
    return 2;
  }
  const injected = platform !== PLATFORM;

  if (flag('--self-test')) return selfTest(doc);
  if (flag('--contract-check')) return contractCheck(doc);
  if (flag('--print-env')) {
    process.stdout.write(`${printEnv(doc)}\n`);
    return 0;
  }

  if (flag('--print')) {
    const only = argv.filter((a) => !a.startsWith('-') && a !== rawPlatform && actionIds(doc).includes(a))[0] ?? '';
    process.stdout.write(`${printPlan(doc, platform, only)}\n`);
    return 0;
  }

  const rep = platformReport(doc, platform);
  if (flag('--json')) {
    process.stdout.write(`${JSON.stringify({ ...rep, catalog: describeCatalog(doc), injected }, null, 2)}\n`);
    return rep.supported && (!rep.preflight || rep.preflight.ok) ? 0 : 3;
  }
  process.stdout.write(`控制面平台驱动：目标平台=${rep.platform} 驱动=${rep.driver ?? '(没有)'}${injected ? `（--platform 注入；真实 process.platform=${PLATFORM}）` : ''}\n`);
  if (!rep.supported) process.stdout.write(`${platformGapMessage(rep.platform, doc)}\n`);
  if (rep.preflight && !rep.preflight.ok) process.stdout.write(`${linuxGateMessage(doc, platform)}\n`);
  for (const a of rep.actions) {
    const mark = a.runnable ? '✅' : (a.applicable ? '❌' : '⛔');
    process.stdout.write(`  ${mark} ${a.id.padEnd(8)} ${a.label}${a.runnable ? '' : `  —— ${a.why}`}\n`);
    for (const s of a.windowsSteps) process.stdout.write(`        · (Windows) ${s}\n`);
    if (rep.platform !== 'win32') {
      for (const s of a.platformSteps ?? []) {
        const text = s.cmd ? `${s.when ? `[${s.when}] ` : ''}${s.cmd}` : (s.text || '').split('\n')[0];
        process.stdout.write(`        · (${rep.platform}) ${text}\n`);
      }
    }
  }
  if (!rep.supported) {
    process.stdout.write('  ❌ 这个平台上控制面**跑不了**：要补的就是一层平台驱动（见上面那几行），别去改判定/目录/载波\n');
    return 3;
  }
  if (rep.preflight && !rep.preflight.ok) {
    process.stdout.write(`  ❌ 驱动在，但这个平台**还没装齐**它要用的工具 —— 上面 ❌ 那几条就是缺的\n`);
    return 3;
  }
  process.stdout.write(rep.platform === 'win32'
    ? '  ✅ 这个平台上控制面能跑（判定/目录/载波/面板 都跨平台；执行靠上面的 .ps1）\n'
    : '  ✅ 这个平台上控制面能跑（判定/目录/载波/面板 都跨平台；执行靠 systemctl / docker compose / journalctl，单元在 deploy\\linux\\）\n');
  return 0;
}

// ── --self-test：离线断言（不起任何会改状态的东西）──────────────────────────────
export async function selfTest(doc = null) {
  const fails = [];
  const eq = (label, got, want) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) fails.push(`${label}：期望 ${w}，实际 ${g}`);
  };
  const catalog = doc ?? loadCatalog();
  const ok = (m) => process.stdout.write(`  ✅ ${m}\n`);

  // ① 执行体往返：真的起一个子进程（用 node 自己，纯只读），证明"文件重定向"这条路在本机可用。
  const r = await spawnCapture(process.execPath, ['--version'], { timeoutMs: 15000 });
  eq('跑子进程的退出码', r.exitCode, 0);
  eq('跑子进程拿得到 stdout', /^v\d+\./.test(r.stdout.trim()), true);
  ok(`执行体往返 OK（node --version → ${r.stdout.trim()}；用的是文件重定向，不是管道）`);

  // ② 目录 → argv → 反解 的往返（每个带参数的动作都走一遍；期望值来自目录自己，不另写一份清单）
  for (const a of catalog.actions) {
    const values = paramValues(a, 'target') ?? [];
    const target = values[0] ?? '';
    const argv = controlArgs(a, { target, tail: 20, json: a.supportsJson === true });
    const back = parseFacadeArgs(catalog, argv);
    if (back.verb !== a.id) fails.push(`argv 反解：${a.id} → ${back.verb}`);
    if (values.length && back.target !== target) fails.push(`argv 反解 target：${a.id} → ${back.target}（期望 ${target}）`);
  }
  ok(`argv 反解往返 OK（${catalog.actions.length} 个动作；外观 argv → 动作+参数）`);

  // ③ Linux 侧每个动作都要有执行体，且占位符全能解析（typo 的 {port:xxx} / {unit:xxx} 当场抓）
  const spec = catalog.platforms?.linux ?? {};
  const ctx = linuxContext(catalog, { target: 'all', tail: 20, ports: { dshWeb: 1, bridgeConsole: 2, bridgeControl: 3, snowlumaWs: 4, onebotHttp: 5, snowlumaWeb: 6 } });
  for (const a of catalog.actions) {
    const entry = a.platform?.linux;
    if (!entry || typeof entry !== 'object') { fails.push(`动作 ${a.id} 在 linux 上没有执行体（必须是对象）`); continue; }
    if (entry.driver !== spec.driver) fails.push(`动作 ${a.id} 的 linux 驱动名不是 ${spec.driver}`);
    if (entry.applicable === false) {
      if (!(entry.notApplicableReason ?? '').trim()) fails.push(`动作 ${a.id} 标了不适用却没写原因`);
      continue;
    }
    if (!(entry.steps ?? []).length && !(entry.stepsNote ?? '').trim()) fails.push(`动作 ${a.id} 的 linux 步骤是空的、也没写 stepsNote、也没标不适用`);
    for (const s of entry.steps ?? []) {
      for (const text of [...(s.args ?? []), ...(s.lines ?? [])]) {
        const filled = fillLinuxPlaceholders(text, ctx);
        if (/\{(port|unit):[^}]+\}/.test(filled) || filled.includes('{compose}') || filled.includes('{envfile}')) {
          fails.push(`动作 ${a.id} 的占位符解析不了：${text} → ${filled}`);
        }
      }
    }
  }
  ok(`Linux 执行体齐（${catalog.actions.length} 个动作都有 platform.linux；占位符全解析）`);

  // ④ 每个"能跑的动作"都要打印得出命令（--print 是这轮的验收手段，不能有空表）
  const printed = printPlan(catalog, 'linux');
  for (const a of catalog.actions) {
    const entry = a.platform?.linux;
    if (!entry || entry.applicable === false) continue;
    if (!printed.includes(a.id)) fails.push(`--print 漏了动作 ${a.id}`);
  }
  ok('--print 对每个适用动作都渲染出了命令');

  // ⑤ 预检的形状（本机是什么结果不算断言对象 —— 只钉住"必须能算出 X/N 与缺项清单"）
  const pf = linuxPreflight(catalog, { platform: 'linux', cache: false });
  if (typeof pf.ok !== 'boolean' || !Array.isArray(pf.items) || !Array.isArray(pf.missing)) fails.push('预检结果形状不对');
  const msg = linuxGateMessage(catalog, 'linux', pf);
  if (!/能跑 \d+\/\d+ 个动作/.test(msg)) fails.push('预检错误的文案里没有"能跑 X/N 个动作"');
  if (!msg.includes('怎么办：')) fails.push('预检错误的文案里没有"怎么办"');
  ok(`预检文案形状 OK（本机现在是 ${pf.ok ? '全过' : `缺 ${pf.missing.length} 样`}；${msg.split('\n')[0]}）`);

  for (const f of fails) process.stdout.write(`  ❌ ${f}\n`);
  process.stdout.write(fails.length ? `  ❌ ${fails.length} 项不过\n` : '  ✅ 平台驱动自检全过\n');
  return fails.length ? 1 : 0;
}

// ── --contract-check：win32 上把 node 版 §3.1 契约与 control.ps1 status -Json 对照 ──────
// 为什么要有：Linux 侧必须自己拼 §3.1 契约（那边没有 pwsh），这是全项目唯一一处跨语言重复。
// 与其"相信两份不会漂移"，不如每次改完都在 win32 上把两份拉出来比一次（非易变字段必须 0 处不同）。
export async function contractCheck(doc = null) {
  if (PLATFORM !== 'win32') {
    process.stdout.write('  ℹ️  --contract-check 只能在 win32 上做（那边才有 control.ps1 这份"参照物"）\n');
    return 0;
  }
  const catalog = doc ?? loadCatalog();
  const ps = await runControlPs1(controlArgs(findAction(catalog, 'status'), { json: true }), { timeoutMs: 30000 });
  const ops = await spawnCapture(process.execPath, [path.join(ROOT, 'tools', 'ops.mjs'), 'status', '--json'], { timeoutMs: 30000 });
  let a = null;
  let b = null;
  try { a = JSON.parse(ps.stdout.slice(ps.stdout.indexOf('{'), ps.stdout.lastIndexOf('}') + 1)); } catch { /* 下面报 */ }
  try { b = JSON.parse(ops.stdout.slice(ops.stdout.indexOf('{'), ops.stdout.lastIndexOf('}') + 1)); } catch { /* 下面报 */ }
  if (!a || !b) {
    process.stdout.write(`  ❌ 取不到可比的两份 JSON（control.ps1 退出码 ${ps.exitCode} / ops.mjs 退出码 ${ops.exitCode}）\n`);
    return 1;
  }
  const mine = shapeStatusContract(b, resolvePorts(), ROOT);
  // 易变字段（时间戳 / 日志尾 / 掩码令牌）不比内容，只比"两边都有这个字段"。
  const VOLATILE = new Set(['generatedAt', 'lastEvent', 'at', 'atClock', 'lineUtc', 'configMasked', 'latestMasked', 'text']);
  const diffs = [];
  const walk = (x, y, p) => {
    const key = p.split('.').pop();
    if (VOLATILE.has(key)) { if ((x === null) !== (y === null)) diffs.push(`${p}: 一边有值一边是 null`); return; }
    if (Array.isArray(x) || Array.isArray(y)) {
      if (!Array.isArray(x) || !Array.isArray(y)) { diffs.push(`${p}: 一边是数组一边不是`); return; }
      if (x.length !== y.length) { diffs.push(`${p}: 长度 ${x.length} vs ${y.length}`); return; }
      x.forEach((v, i) => walk(v, y[i], `${p}[${i}]`));
      return;
    }
    if (x && y && typeof x === 'object' && typeof y === 'object') {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) walk(x[k], y[k], p ? `${p}.${k}` : k);
      return;
    }
    if (JSON.stringify(x) !== JSON.stringify(y)) diffs.push(`${p}: control.ps1=${JSON.stringify(x)} / node 版=${JSON.stringify(y)}`);
  };
  walk(a, mine, '');
  for (const d of diffs) process.stdout.write(`  ❌ ${d}\n`);
  process.stdout.write(diffs.length
    ? `  ❌ §3.1 契约两份不一致：${diffs.length} 处（control.ps1 与 control-driver.mjs 的 shapeStatusContract 必须同步改）\n`
    : '  ✅ §3.1 契约两份一致（非易变字段 0 处不同；时间戳/日志尾那些只比了字段存在性）\n');
  return diffs.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // main 大多数分支是同步的（返回退出码），只有 --self-test / --contract-check 是 async（要起子进程）——
  // Promise.resolve 把两种都接住（直接 .then 会在同步分支上炸 "is not a function"）。
  Promise.resolve(main()).then((c) => process.exit(c));
}
