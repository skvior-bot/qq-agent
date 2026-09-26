// control-server.mjs —— 控制面的**载波**（HTTP），唯一动作源是 tools\control.ps1。
//
// 为什么要有它（docs\qq-agent-产品设计.md §3.1 主线 A + §4.1）：
//   cmd 面板与 DSH 页面面板必须是**同一个控制面的两个等价入口**。cmd 那半已经是
//   tools\control.ps1；页面那半需要一条 HTTP 通道，这个文件就是那条通道 ——
//   它**只做搬运**：每个请求翻译成一次 control.ps1 调用，**本文件里没有第二份判定**
//   （端口判活 / 五灯 / 令牌比对 / 下一动作全在 ops.mjs + control.ps1 里）。
//
// ★ 动作白名单**不在本文件里**（2026-09-24 改动）：唯一来源是 tools\control-actions.json
//   （数据）+ tools\control-actions.mjs（读取器/校验器）。以前这里有一份 `const VERBS`，
//   与 control.ps1 里的 ValidateSet 是**同一个值两处定义** —— 正是本项目一直在消灭的东西。
//   现在：本文件只问目录"有哪些动作、每个动作的子参数枚举是什么、要不要 {confirm:true}"，
//   "这个平台上谁来执行"则交给平台驱动 tools\control-driver.mjs（win32 = 调 tools\control.ps1；
//   其它平台当场抛人话错误 —— Linux 驱动还没写，见 docs\部署到服务器.md §10.5/§10.11）。
//
// ★ 为什么是**独立进程**，而不是挂在 DSH 自己的 web server（:3080）上：
//   「控制面必须独立于它所控制的东西」。页面上的"重起 DSH"如果走 DSH 自己的 HTTP 服务，
//   那就是**一个会杀掉自己所在服务器的请求** —— 只有独立进程才能活着看它重启完、
//   才能在 DSH 不在的时候照样回答 status。这条是设计决定，不是实现偏好。
//   （机制可行性侦察结论：DSH 的 webServer.register 确实能挂路由，但那正是要避开的那条路。）
//
// 通道（动作白名单是**枚举**，不是自由参数 —— 写错当场 4xx，绝不静默忽略；枚举全部来自动作目录）：
//   GET  /api/control/status                          只读，= control.ps1 status -Json
//   GET  /api/control/logs?which=&tail=                只读，= control.ps1 logs <which> -Tail N
//   GET  /api/control/actions                          只读：动作目录（有哪些动作、参数枚举、各平台能不能跑）
//   GET  /api/control/token                            把令牌交给**同源页面**（见下"令牌"）
//   POST /api/control/up                               = control.ps1 up
//   POST /api/control/down       {confirm:true}        = control.ps1 down -Yes
//   POST /api/control/restart    {target,confirm?}     target ∈ all|dsh|bridge|snowluma
//   POST /api/control/pages      {target}              target ∈ open|close|wake
//   POST /api/control/login      {target}              target ∈ qq|console
//   POST /api/control/doctor                           = control.ps1 doctor
//   ⚠ 会改状态的动作用**发起即返回**（202 + lastAction 记账），不让页面挂几十秒等 start-all.ps1。
//     页面接着轮询 status，从 server.lastAction 上看"执行中 / 完成 / 失败"。
//   ⚠ 上面这份清单是**注释**：真正生效的是 PUT/POST 那一支从目录里 filter 出来的 postActionIds()
//     （self-check 5.14 会静态确认本文件里没有第二份动作数组）。
//
// 安全（红线，§3.1）：控制面 = 能启停进程的本地 HTTP 端点 = **本地 RCE 面**。
//   ① 只监听 127.0.0.1（绝不对外；服务器上要远程走 SSH 隧道）
//   ② 令牌校验（本文件生成、落 qq-bridge\state\panel-token，用户零手工）
//   ③ 动作白名单枚举 + 子参数枚举，没有任何自由参数拼进命令行
//   ④ down / restart dsh / restart all 要 {confirm:true}（自毁按钮，二次确认）
//   ⑤ CORS 只放 DSH 页那一个源（http://127.0.0.1:<ports.dshWeb>，来自 agent.config.json），绝不用 *；Host 必须是我们自己的，防 DNS rebinding
//
// ★ 令牌的**诚实威胁模型**（别把它说大了）：
//   防得住：· 别的网页的 CSRF —— 跨源读 /api/control/token 会被 CORS 拦住（我们只给 3080
//             发 Access-Control-Allow-Origin），拿不到令牌就调不动任何动作；
//           · 没有令牌的随手脚本/误连（一个裸 curl 打进来是 401）；
//           · 令牌可轮换（删了 panel-token 重启本服务即换新）。
//   防不住：· **同机同用户的本地进程** —— 它能直接读 panel-token，也能伪造 Origin 头。
//             这不是设计缺陷，是"同用户"这个边界的定义：那个进程本来就能直接跑 control.ps1。
//           · 同机**其他用户**也不是靠令牌挡的，是靠 ② 的 loopback 绑定 + 工作区目录的
//             文件 ACL（别人的账户读不到 panel-token，也连不上 127.0.0.1 上属于你的端口……
//             严格说连得上，所以那层靠 ACL）。
//   ⇒ 一句话：令牌负责"让调用变得刻意且可撤回"，真正的边界是"只监听回环 + 同用户"。
//
// 挂了不许影响三件套：本进程与 DSH / 桥接 / SnowLuma **没有任何父子或守护关系**，
//   它死了只是页面面板变灰（面板会自己说"控制服务没在跑"），QQ 链路照跑。
//
// 用法：
//   node tools\control-server.mjs                 # 起（127.0.0.1:<ports.bridgeControl>，见 agent.config.json）
//   node tools\control-server.mjs --print-token   # 只打印当前令牌（排障/脚本用）
//   node tools\control-server.mjs --port 3102     # 换端口（调试用）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
// 端口/源白名单**不在这里写死**：唯一来源是仓库根 `agent.config.json`（默认表在 config-lib 一处）。
// 这一层坏掉时 resolvePorts 会退回环境层并出声，所以工具不会因为配置读不了就整个不可用。
import { resolvePorts, loopbackHttp } from '../qq-bridge/src/config-lib.js';
// 动作目录（唯一一处定义）+ 平台驱动（win32 调 .ps1；别的平台抛人话错误）。
import { loadCatalog, findAction, postActionIds, paramValues, needsConfirm, describeCatalog, receiptPlan, busyGuardSpec } from './control-actions.mjs';
import { ROOT as DRIVER_ROOT, PLATFORM, runControl, buildArgsFor, platformReport, isSupported, platformGapMessage } from './control-driver.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = DRIVER_ROOT;
const TOKEN_FILE = path.join(ROOT, 'qq-bridge', 'state', 'panel-token');

const HOST = '127.0.0.1';
const PORTS = resolvePorts();
const DEFAULT_PORT = PORTS.bridgeControl;
// CORS / Origin 白名单：**只有 DSH 页面这一个源**（§3.1 红线，绝不放 *）。
const ALLOWED_ORIGINS = new Set([loopbackHttp(PORTS.dshWeb)]);
const SELF_HOSTS = new Set([`127.0.0.1:${DEFAULT_PORT}`, `localhost:${DEFAULT_PORT}`]);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

// ── 令牌：本服务生成、落盘、用户零手工 ────────────────────────────────────────
function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (/^[0-9a-f]{16,}$/i.test(t)) return t;
  } catch { /* 还没有 */ }
  const t = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${t}\n`, { encoding: 'utf8', mode: 0o600 });
  return t;
}

if (flag('--print-token')) {
  process.stdout.write(`${readToken()}\n`);
  process.exit(0);
}

// ── 动作目录：**唯一一处定义**，本文件不抄第二份 ───────────────────────────────
// 放在 --print-token 之后：令牌工具是排障入口，目录坏了也应该还能用（它不依赖任何白名单）。
// 目录读不了/校验不过 ⇒ **拒绝启动**（宁可当场不可用，也不按一份猜的白名单收请求 —— 这一层是本地 RCE 面）。
let CATALOG;
try {
  CATALOG = loadCatalog();
} catch (e) {
  process.stderr.write(`[control-server] 动作目录读不了/校验不过，控制面拒绝启动：\n${e.message}\n`);
  process.exit(1);
}
// HTTP POST 动作表（= 上面注释里那份清单，顺序也来自目录：403 的 allowed 数组就是它）。
const POST_VERBS = postActionIds(CATALOG);

const PORT = Number(opt('--port', process.env.CONTROL_PORT || DEFAULT_PORT)) || DEFAULT_PORT;
const TOKEN = readToken();

// ── 本地时间：★ 全项目踩过两次的坑（bridge.log / qq-activity.log 的时间戳是 UTC 不带日期；
//    ops.mjs 的 generatedAt 也是 UTC）。"转成本地"这件事**只在本文件做一次**，
//    页面拿到的每个时间字段都已经是可以直接显示的本地时间/本地 ISO（带偏移）。
function localIso(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}:${p(a % 60)}`;
}
function localClock(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
// 把 UTC 的 ISO（ops.mjs 的 generatedAt）转成**本地时刻文本**；转不了就老实留空。
function utcIsoToLocalClock(iso) {
  const t = Date.parse(String(iso || ''));
  return Number.isFinite(t) ? localClock(new Date(t)) : '';
}

// ── 跑外观脚本：**已搬到平台驱动层**（2026-09-24）──────────────────────────────
// `runControl` 原来在这里（powershell.exe -EncodedCommand + 文件重定向那一套）。它天生是
// **平台相关**的（powershell.exe / windowsHide / -EncodedCommand 全是 Windows 的东西），
// 所以整段搬进了 tools\control-driver.mjs：win32 走原来那一套（实现逐字未动），
// 其它平台**当场抛人话错误**（Linux 驱动还没写）—— 而不是在这里"试着起个 powershell 看看"。
// 为什么不用管道 / 为什么用文件重定向：那段注释跟着实现一起搬过去了（别在这儿补一份）。

// PowerShell 在 stderr 尾巴上会吐一段 CLIXML（进度记录），对用户是纯噪声 —— 剪掉。
function stripClixml(s) {
  const i = s.indexOf('#< CLIXML');
  const cut = i >= 0 ? s.slice(0, i) : s;
  return cut.split(/\r?\n/).filter((l) => !/<Objs Version=/.test(l)).join('\n');
}

// ── 盘上 single-flight 标记（http.busyGuard）──────────────────────────────────
// 形状与过期口径都来自目录；本文件只负责"读一眼"。**读不动 / 过期一律当没有** ——
// 宁可放行一次（真重复了也只是白重启一次），也不能因为一份坏标记把重启入口永久锁死。
function readBusyMarker(guard) {
  try {
    const file = path.join(ROOT, guard.marker);
    const st = fs.statSync(file);
    // ⚠ **负龄要当 0，不能当"没有"**（2026-09-25 实测踩到，代价 = 漏掉一次 409）：Windows 的
    //    mtime 有 tick 粒度，刚写出来的文件 mtime 可能比 Date.now() 还新几毫秒 ⇒ 严格判 `ageMs < 0`
    //    会把**刚刚发起的那一次**当成"没人在飞"放过去。方向要选对：看着像刚写 = 有人在飞 ⇒ 拦。
    const ageMs = Date.now() - st.mtimeMs;
    if (!Number.isFinite(ageMs) || ageMs > guard.maxAgeMs) return null;
    let doc = {};
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { /* 内容坏了：按"有人在飞"处理（mtime 还新） */ }
    return { ...doc, ageMs: Math.max(0, Math.round(ageMs)) };
  } catch { return null; }
}

// ── 动作记账：发起即返回，页面轮询 status 看结果（§4.1「动作永远一步」，不让页面挂着等）──
let lastAction = null;
function startAction(verb, target, args, timeoutMs) {
  const rec = {
    verb,
    target: target || '',
    state: 'running',
    startedAt: localIso(),
    startedAtClock: localClock(),
    finishedAt: '',
    exitCode: null,
    tail: '',
  };
  lastAction = rec;
  runControl(args, { timeoutMs })
    .then((r) => {
      rec.state = r.exitCode === 0 ? 'done' : 'failed';
      rec.exitCode = r.exitCode;
      rec.finishedAt = localIso();
      // 只留最后几行给人看（动作的输出可能很长）—— 真要看全的走 logs。
      const lines = stripClixml(`${r.stdout}\n${r.stderr}`).trim().split(/\r?\n/).filter((l) => l.trim());
      rec.tail = lines.slice(-6).join('\n');
    })
    .catch((e) => {
      rec.state = 'failed';
      rec.exitCode = -1;
      rec.finishedAt = localIso();
      rec.tail = String(e?.message || e);
    });
  return rec;
}

// ── HTTP 小工具 ──────────────────────────────────────────────────────────────
function send(res, code, body, headers = {}) {
  const text = JSON.stringify(body ?? {}, null, 2);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function originOf(req) {
  const o = req.headers.origin;
  return typeof o === 'string' ? o : '';
}

// CORS：只给白名单里的源发 ACAO（并且回 Vary: Origin，免得被缓存串味）。
function corsHeaders(req) {
  const o = originOf(req);
  if (!ALLOWED_ORIGINS.has(o)) return { vary: 'Origin' };
  return {
    vary: 'Origin',
    'access-control-allow-origin': o,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-control-token',
    'access-control-max-age': '600',
  };
}

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function presentedToken(req) {
  const h = req.headers['x-control-token'];
  if (typeof h === 'string' && h) return h.trim();
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return '';
}

// 鉴权顺序：Host（防 DNS rebinding）→ Origin（有就必须在白名单）→ 令牌。
function authorize(req, res) {
  const host = String(req.headers.host || '');
  const hostOk = SELF_HOSTS.has(host) || host === `127.0.0.1:${PORT}` || host === `localhost:${PORT}`;
  if (!hostOk) {
    send(res, 403, { ok: false, error: 'host-not-allowed', hint: '只接受 127.0.0.1 上的请求' }, corsHeaders(req));
    return false;
  }
  const o = originOf(req);
  if (o && !ALLOWED_ORIGINS.has(o)) {
    send(res, 403, { ok: false, error: 'origin-not-allowed', origin: o }, corsHeaders(req));
    return false;
  }
  const got = presentedToken(req);
  if (!got || !timingSafeEq(got, TOKEN)) {
    send(res, 401, {
      ok: false,
      error: 'token-required',
      hint: '缺 x-control-token（页面用 GET /api/control/token 取，脚本用 node tools\\control-server.mjs --print-token）',
    }, corsHeaders(req));
    return false;
  }
  return true;
}

function readJsonBody(req, limit = 8192) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { req.destroy(); resolve(null); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

function serverBlock(extra = {}) {
  return {
    now: localIso(),
    nowClock: localClock(),
    port: PORT,
    lastAction,
    ...extra,
  };
}

// ── 路由 ─────────────────────────────────────────────────────────────────────
async function handle(req, res) {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const cors = corsHeaders(req);

  if (req.method === 'OPTIONS') {
    res.writeHead(ALLOWED_ORIGINS.has(originOf(req)) ? 204 : 403, cors);
    res.end();
    return;
  }

  // 健康探针：**故意不需要令牌**，只回答"我在不在"（不泄露任何状态）。
  // 页面靠它区分"控制服务没在跑"和"令牌不对"，这两种提示文案完全不同。
  if (route === '/api/control/ping') {
    send(res, 200, { ok: true, service: 'control-server', now: localIso(), nowClock: localClock() }, cors);
    return;
  }

  if (!route.startsWith('/api/control/')) {
    send(res, 404, { ok: false, error: 'not-found' }, cors);
    return;
  }

  // GET /api/control/token —— 把令牌交给**同源页面**（Origin 必须正好是 DSH 页面那个源）。
  // ⚠ 这一条必须在 authorize 之前：它的凭据是 Origin 本身（令牌不能用来换令牌）。
  // 没有 Origin 的（curl）不给：那种调用者请自己用 --print-token 取，别把令牌端点变成公开的。
  if (route === '/api/control/token' && req.method === 'GET') {
    if (!ALLOWED_ORIGINS.has(originOf(req))) {
      send(res, 403, { ok: false, error: 'origin-required', hint: '令牌只发给 DSH 页面那个源' }, cors);
      return;
    }
    send(res, 200, { ok: true, token: TOKEN }, cors);
    return;
  }

  if (!authorize(req, res)) return;

  // ── 只读：status ──
  if (route === '/api/control/status' && req.method === 'GET') {
    const r = await runControl(buildArgsFor(CATALOG, 'status', { json: true }), { timeoutMs: 30000 });
    let status = null;
    try {
      const a = r.stdout.indexOf('{');
      const b = r.stdout.lastIndexOf('}');
      if (a >= 0 && b > a) status = JSON.parse(r.stdout.slice(a, b + 1));
    } catch { /* 下面统一报错 */ }
    if (!status) {
      send(res, 502, {
        ok: false,
        error: 'control-status-failed',
        exitCode: r.exitCode,
        detail: (r.stderr || r.stdout || '').trim().slice(-400),
        server: serverBlock(),
      }, cors);
      return;
    }
    // ★ 时间统一在这里转好：控制面给的是 UTC，页面要的是本地（踩过两次的坑）。
    send(res, 200, {
      ok: true,
      server: serverBlock({ generatedAtLocalClock: utcIsoToLocalClock(status.generatedAt) }),
      status,
    }, cors);
    return;
  }

  // ── 只读：日志尾 ──
  if (route === '/api/control/logs' && req.method === 'GET') {
    const which = String(url.searchParams.get('which') || 'bridge').toLowerCase();
    const LOGS = findAction(CATALOG, 'logs');
    const allowed = paramValues(LOGS, 'target');
    if (!allowed.includes(which)) {
      send(res, 403, { ok: false, error: 'not-in-whitelist', allowed }, cors);
      return;
    }
    // ⚠ 这两个数字**故意与 CLI 不同**（CLI 是 1~2000）：HTTP 面自己夹得更紧，两者都在动作目录的
    //   logs.http.tailClamp 里写着（一处定义），面板要"最近 20 行"就不会被一次拉 2000 行。
    const clamp = LOGS.http.tailClamp;
    let tail = Number(url.searchParams.get('tail') || clamp.default);
    if (!Number.isFinite(tail)) tail = clamp.default;
    tail = Math.max(clamp.min, Math.min(clamp.max, Math.trunc(tail)));
    // logs -Json：control.ps1 那边把 Invoke-Step 的"命令行回显 + 退出码"包装去掉，
    // 否则面板要的"最近 20 行"会被那三行占掉（来源没变，还是 node tools\ops.mjs logs）。
    const r = await runControl(buildArgsFor(CATALOG, 'logs', { target: which, tail, json: true }), { timeoutMs: 20000 });
    let data = null;
    try {
      const a = r.stdout.indexOf('{');
      const b = r.stdout.lastIndexOf('}');
      if (a >= 0 && b > a) data = JSON.parse(r.stdout.slice(a, b + 1));
    } catch { /* 下面统一报错 */ }
    if (!data) {
      send(res, 502, {
        ok: false,
        error: 'control-logs-failed',
        exitCode: r.exitCode,
        detail: (r.stderr || r.stdout || '').trim().slice(-400),
        server: serverBlock(),
      }, cors);
      return;
    }
    send(res, data.ok ? 200 : 502, { ...data, server: serverBlock() }, cors);
    return;
  }

  // ── 只读：动作目录（2026-09-24 新增）──
  // 让面板 / 别的载体 / 未来平台自己问"有哪些动作、每个动作的子参数枚举、这个平台上能不能跑"——
  // 它们就不用各自抄一份清单（这正是本轮要消灭的东西）。**要令牌**：它虽然只读，但会把
  // "这台机器上控制面能干什么"完整说一遍，没必要白送。
  if (route === '/api/control/actions' && req.method === 'GET') {
    send(res, 200, {
      ok: true,
      platform: platformReport(CATALOG),
      catalog: describeCatalog(CATALOG),
      server: serverBlock(),
    }, cors);
    return;
  }

  if (req.method !== 'POST') {
    send(res, 405, { ok: false, error: 'method-not-allowed' }, cors);
    return;
  }

  const verb = route.slice('/api/control/'.length);
  if (!POST_VERBS.includes(verb)) {
    send(res, 403, { ok: false, error: 'not-in-whitelist', verb, allowed: POST_VERBS }, cors);
    return;
  }
  const action = findAction(CATALOG, verb);

  const body = await readJsonBody(req);
  if (body === null) {
    send(res, 400, { ok: false, error: 'bad-json-body' }, cors);
    return;
  }
  const target = String(body.target || '').toLowerCase();
  const targetValues = paramValues(action, 'target');
  if (targetValues) {
    if (!target) {
      send(res, 400, { ok: false, error: 'target-required', allowed: targetValues }, cors);
      return;
    }
    if (!targetValues.includes(target)) {
      send(res, 403, { ok: false, error: 'target-not-in-whitelist', target, allowed: targetValues }, cors);
      return;
    }
  } else if (target) {
    send(res, 403, { ok: false, error: 'target-not-allowed', verb }, cors);
    return;
  }

  // 自毁按钮：down / restart dsh / restart all 必须显式二次确认（§3.1 红线）。
  // "哪些动作/哪些目标要确认"由动作目录说（http.confirm），本文件不自己判断。
  if (needsConfirm(action, target) && body.confirm !== true) {
    send(res, 428, {
      ok: false,
      error: 'confirm-required',
      verb,
      target,
      hint: '这个动作会断掉正在用的东西，要 {confirm:true} 再发一次',
    }, cors);
    return;
  }

  // single-flight（**盘上**那一道）：restart-stack 会把控制面自己一起重启掉 ⇒ 它的 running 记账
  // （lastAction）跟着消失，光靠上面那条 409 拦不住"控制面重起之后又来一发"。
  // 闸的形状写在目录里（http.busyGuard），这里只按它读标记 —— 本文件不自己编路径、不自己定过期。
  const guard = busyGuardSpec(action);
  if (guard) {
    const held = readBusyMarker(guard);
    if (held) {
      send(res, 409, {
        ok: false,
        error: 'busy',
        verb,
        guard: { marker: guard.marker, since: held.acceptedAt ?? null, ageMs: held.ageMs, requestId: held.requestId ?? null, plan: held.plan ?? null },
        hint: '已经有一次重启在飞（发起即返回：它跑完或过了窗口才会放行第二次）。要立刻重来就先删掉那个标记文件。',
      }, cors);
      return;
    }
  }

  if (lastAction && lastAction.state === 'running') {
    send(res, 409, { ok: false, error: 'busy', running: lastAction }, cors);
    return;
  }

  const args = buildArgsFor(CATALOG, verb, { target });
  const timeoutMs = verb === 'down' || verb === 'restart' || verb === 'up' ? 300000 : 60000;
  // 把"HTTP 这一侧是谁在敲门"传给工人（control.ps1 的触发账本要记）：子进程在 spawn 那一刻
  // 继承环境快照，所以设 → 发起 → 立刻删是安全的。会话 id 只有调用方**自愿**带 x-dsh-session 时才有
  // （没带就留空，不猜）。
  process.env.DSH_CONTROL_TRIGGER = JSON.stringify({
    origin: originOf(req),
    session: String(req.headers['x-dsh-session'] ?? ''),
    ua: String(req.headers['user-agent'] ?? '').slice(0, 120),
  });
  let rec;
  try {
    rec = startAction(verb, target, args, timeoutMs);
  } finally {
    delete process.env.DSH_CONTROL_TRIGGER;
  }
  // accepted + plan：发起即返回的那种动作（restart-stack）的回执 —— 计划那句话来自目录，本文件不编。
  send(res, 202, { ok: true, started: true, accepted: true, verb, target, plan: receiptPlan(action), at: rec.startedAt, server: serverBlock() }, cors);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    try { send(res, 500, { ok: false, error: 'internal', detail: String(e?.message || e) }); } catch { /* 头都发出去了 */ }
  });
});

server.on('error', (e) => {
  process.stderr.write(`[control-server] 起不来：${e.code || ''} ${e.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`[control-server] http://${HOST}:${PORT} 就绪（唯一动作源 tools\\control.ps1；动作目录 tools\\control-actions.json；令牌文件 qq-bridge\\state\\panel-token）\n`);
  // 没有驱动的平台：照实说清楚（status 会 500、POST 会 500 —— 而不是假装"服务正常"）。
  // win32 上这一行**不会出现**（= 主人的那台机器上输出与第六批逐字相同）。
  if (!isSupported()) {
    process.stdout.write(`${platformGapMessage(PLATFORM, CATALOG)}\n`);
    process.stdout.write(`[control-server] 本平台（${PLATFORM}）只有只读的 /ping 与 /token 与 /api/control/actions 可用；其余请求会老实报错。\n`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
