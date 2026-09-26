// ============================================================================
// tools/watch-qq-login.mjs —— 服务器侧「QQ 掉线 / 没登录」告警（2026-09-26 主人选 A：Bark / Server酱）
//
// 为什么是**独立常驻进程**（而不是挂在桥接或 DSH 里）：
//   **告警不能和被监控对象共命运** —— 它要活到"三件套（DSH / 桥接 / SnowLuma）任何一个都起不来"的时候。
//   桥接有守护、DSH 会换代，都不适合当"最后一道通知"。
//
// ★★ 硬约束：**这一路绝不许走 QQ**（QQ 掉线时它正是发不出去的那条路）——
//    所以它只用 Bark / Server酱 这类**站外**通道。源码棘轮盯着这条（test-watch-qq-login.mjs §5）。
//
// 判据（与本地那盏灯同一个来源，不另算一套）：
//   直接问 SnowLuma 的 OneBot HTTP「get_login_info」（`loadConfig()` 的 snowluma.httpUrl + accessToken）；
//   `status==='ok' && retcode===0` ⇒ 在线，其余（含连不上 / 超时 / 非 2xx）⇒ 异常。
//   连续 N 次（默认 2）异常才算"掉线"，连续 N 次正常才算"恢复" ⇒ 抖一下不报。
//
// 送达口径（能做/不能做，别自欺）：
//   **能**确认"通道受理"（Bark 2xx / Server酱 code=0）⇒ 每次尝试都落一行 jsonl；
//   **不能**确认"他真的看到了"（这两家都没有已读回执）⇒ 文案里**不许**写"已通知到你"。
//   发不出去 ⇒ 记 failed + **有限次**退避重试（默认 3 次），**不无限重试、也绝不静默吞**。
//
// 用法（服务器上由 deploy/linux/systemd/qq-login-alert.service 常驻；也可手工跑）：
//   node tools/watch-qq-login.mjs                     # 常驻
//   WATCH_QQ_ONCE=1 node tools/watch-qq-login.mjs     # 只采一次样就退（探针 / 手工核对）
//   环境变量（都可不设，key 一律走环境变量、不进仓库）：
//     WATCH_QQ_CHANNEL=bark|serverchan   缺省：看哪个 key 在（都没有 ⇒ 只记日志不发通知）
//     WATCH_QQ_BARK_KEY / BARK_KEY       Bark 的 key（https://api.day.app/<key>/...）
//     WATCH_QQ_SERVERCHAN_KEY / SERVERCHAN_KEY   Server酱的 SendKey（https://sctapi.ftqq.com/<key>.send）
//     WATCH_QQ_INTERVAL_MS=30000         采样间隔
//     WATCH_QQ_CONFIRM_N=2               连续几次才翻状态
//     WATCH_QQ_RETRY_N=3                 发送失败最多再试几次（总共 1+RETRY_N 次）
//     WATCH_QQ_RETRY_DELAY_MS=2000       重试基础间隔（第 n 次 = delay * n，简单退避）
//     WATCH_QQ_TIMEOUT_MS=5000           单次 OneBot 查询超时
//     WATCH_QQ_LOG=<路径>                默认 <repo>/qq-bridge/state/_tmp/qq-login-alert.jsonl
//     WATCH_QQ_STATE=<路径>              默认 <repo>/qq-bridge/state/_tmp/qq-login-alert.state.json
//     WATCH_QQ_DRY_RUN=1                 只记日志、**不真发**（服务器上第一次装完想先看看用它）
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadConfig } from '../qq-bridge/src/config-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = Object.freeze({
  intervalMs: 30000,
  confirmN: 2,
  retryN: 3,
  retryDelayMs: 2000,
  timeoutMs: 5000,
  maxFieldLen: 512,
});

// ★★ 两条通知地址的 host = **字面量常量**（2026-09-26 小镜复核后加的**肯定式**约束）：
//    写成常量 + 字符串拼接（而不是把 host 塞进变量或模板）⇒ 谁把它改成 `process.env.…`、
//    或换成别家，`test-watch-qq-login.mjs` §⑤b/⑤c/⑤d 会**立刻红**。
//    运行时今天是安全的；这一层防的是**退化**（"防退化不是救火"）。
export const BARK_HOST = 'https://api.day.app/';
export const SERVERCHAN_HOST = 'https://sctapi.ftqq.com/';

const int = (v, d) => { const n = Number.parseInt(String(v ?? ''), 10); return Number.isFinite(n) && n >= 0 ? n : d; };

// ── 配置（全部从环境来；key 绝不写进仓库）────────────────────────────────────
export function resolveChannel(env = process.env) {
  const want = String(env.WATCH_QQ_CHANNEL ?? '').trim().toLowerCase();
  const bark = String(env.WATCH_QQ_BARK_KEY ?? env.BARK_KEY ?? '').trim();
  const sc = String(env.WATCH_QQ_SERVERCHAN_KEY ?? env.SERVERCHAN_KEY ?? '').trim();
  if (want === 'bark') return bark ? { channel: 'bark', key: bark } : { channel: 'none', key: '', why: '选了 bark 但没给 WATCH_QQ_BARK_KEY/BARK_KEY' };
  if (want === 'serverchan') return sc ? { channel: 'serverchan', key: sc } : { channel: 'none', key: '', why: '选了 serverchan 但没给 WATCH_QQ_SERVERCHAN_KEY/SERVERCHAN_KEY' };
  if (want) return { channel: 'none', key: '', why: `WATCH_QQ_CHANNEL=${want} 不认识（只认 bark / serverchan）` };
  if (bark) return { channel: 'bark', key: bark };
  if (sc) return { channel: 'serverchan', key: sc };
  return { channel: 'none', key: '', why: '没配任何一个 key（BARK_KEY / SERVERCHAN_KEY）⇒ 只记日志不发通知' };
}

export function resolvePaths(env = process.env) {
  const dir = path.join(ROOT, 'qq-bridge', 'state', '_tmp');
  return {
    log: String(env.WATCH_QQ_LOG ?? '').trim() || path.join(dir, 'qq-login-alert.jsonl'),
    state: String(env.WATCH_QQ_STATE ?? '').trim() || path.join(dir, 'qq-login-alert.state.json'),
  };
}

export function resolveApi(env = process.env, cfg = null) {
  const c = cfg ?? loadConfig();
  const base = String(c?.snowluma?.httpUrl ?? '').replace(/\/+$/, '');
  return { baseHttp: base, accessToken: String(c?.snowluma?.accessToken ?? ''), timeoutMs: int(env.WATCH_QQ_TIMEOUT_MS, DEFAULTS.timeoutMs) };
}

// ── 一次采样：问 OneBot「登录了吗」──────────────────────────────────────────
export async function sampleOnce({ api, fetchImpl = fetch }) {
  const url = `${api.baseHttp}/get_login_info?access_token=${encodeURIComponent(api.accessToken || '')}`;
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: api.accessToken ? { authorization: `Bearer ${api.accessToken}` } : {},
      signal: AbortSignal.timeout(api.timeoutMs),
    });
    if (!res.ok) return { online: false, reason: `HTTP ${res.status}`, nickname: '' };
    const body = await res.json();
    const online = body?.status === 'ok' && body?.retcode === 0;
    return { online, reason: online ? 'ok' : `网关答：${JSON.stringify(body).slice(0, 120)}`, nickname: online ? String(body?.data?.nickname ?? '') : '' };
  } catch (e) {
    return { online: false, reason: `连不上或超时：${e?.message ?? e}`, nickname: '' };
  }
}

// ── 纯函数：连续 N 次才翻状态（抖一下不报）──────────────────────────────────
/**
 * @param prev  {state:'online'|'offline'|null, badStreak:number, goodStreak:number}
 * @param sample {online:boolean}
 * @param confirmN 连续几次才算数
 * @returns {{state:'online'|'offline'|null, badStreak:number, goodStreak:number, flip:boolean}}
 */
export function nextState(prev, sample, confirmN = DEFAULTS.confirmN) {
  const n = Math.max(1, confirmN);
  const bad = sample.online ? 0 : (prev.badStreak || 0) + 1;
  const good = sample.online ? (prev.goodStreak || 0) + 1 : 0;
  let state = prev.state ?? null;
  let flip = false;
  if (!sample.online && bad >= n && state !== 'offline') { state = 'offline'; flip = true; }
  else if (sample.online && good >= n && state !== 'online') { state = 'online'; flip = true; }
  return { state, badStreak: bad, goodStreak: good, flip };
}

// ── 文案：不编因果、不编耗时、不声称"他看到了"────────────────────────────────
export function buildMessage(state, { nickname = '', reason = '', at = new Date() }) {
  const who = nickname ? `${nickname} ` : '';
  if (state === 'offline') {
    return {
      title: '⚠ QQ 掉线了',
      body: `${who}这台机器上问不到 QQ 登录状态（${reason}）。\n` +
        '大概率是 QQ 没登录 / 没注入（比如重启之后要重新扫码），也可能是网关没起来。\n' +
        '去 SnowLuma 管理页看一眼、必要时重新扫码；恢复后我会再发一条。\n' +
        `（这条是机器人在服务器上自己发的；我没有"你已读"的回执，所以别把它当成"我一定还在线"。）时间：${at.toISOString()}`,
    };
  }
  return {
    title: '✅ QQ 已恢复',
    body: `${who}QQ 登录状态已经正常（${reason}）。\n之前的掉线告警到此为止。时间：${at.toISOString()}`,
  };
}

// ── 发送：抽一层，两个实现（Bark / Server酱）────────────────────────────────
/**
 * @returns {Promise<{ok:boolean, channel:string, code:string, detail:string, attempts:number}>}
 */
export async function notify(state, msg, { channel, key, fetchImpl = fetch, retryN = DEFAULTS.retryN, retryDelayMs = DEFAULTS.retryDelayMs, maxFieldLen = DEFAULTS.maxFieldLen, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {}, dryRun = false } = {}) {
  if (channel === 'none' || !key) return { ok: false, channel: 'none', code: 'no-channel', detail: '没配通道 key', attempts: 0 };
  if (dryRun) return { ok: false, channel, code: 'dry-run', detail: 'DRY_RUN：只记日志，没真发', attempts: 0 };
  // ★ 字段长度上限（2026-09-26 小镜复核后加）：key / title / body 各 ≤ maxFieldLen，
  //   超了 **截断 + 记一行** —— 不静默（静默截断 = 偷偷改内容）。5 万字符的 URL 打不穿主机，
  //   但两家必然拒收、失败还得照实记 ⇒ 不如在本地先拦。
  const clamp = (v) => { const s = String(v ?? ''); return s.length <= maxFieldLen ? s : s.slice(0, maxFieldLen); };
  const key2 = clamp(key);
  const msg2 = { title: clamp(msg?.title), body: clamp(msg?.body) };
  if (key2 !== String(key ?? '') || msg2.title !== String(msg?.title ?? '') || msg2.body !== String(msg?.body ?? '')) {
    log({ kind: 'truncated', maxFieldLen, keyLen: String(key ?? '').length, titleLen: String(msg?.title ?? '').length, bodyLen: String(msg?.body ?? '').length });
  }
  const attemptsMax = 1 + Math.max(0, retryN);
  let last = { ok: false, code: '', detail: '' };
  for (let i = 1; i <= attemptsMax; i++) {
    last = await sendOnce(state, msg2, { channel, key: key2, fetchImpl });
    log({ kind: 'notify', state, channel, attempt: i, attemptsMax, ok: last.ok, code: last.code, detail: last.detail });
    if (last.ok) return { ...last, attempts: i };
    if (i < attemptsMax) await sleep(retryDelayMs * i);   // 简单退避：2s / 4s / 6s；**有限次**
  }
  return { ...last, attempts: attemptsMax };
}

async function sendOnce(state, msg, { channel, key, fetchImpl }) {
  try {
    if (channel === 'bark') {
      // Bark：GET https://api.day.app/<key>/<title>/<body>，2xx 即受理
      // ★ host 是**字面量常量**（见文件上方的 BARK_HOST 注释）：只拼路径与查询，绝不从环境取 host。
      const url = BARK_HOST + encodeURIComponent(key) + '/' + encodeURIComponent(msg.title) + '/' + encodeURIComponent(msg.body);
      const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      return { ok: res.ok, channel, code: String(res.status), detail: res.ok ? '受理' : `HTTP ${res.status}` };
    }
    if (channel === 'serverchan') {
      // Server酱：GET https://sctapi.ftqq.com/<SendKey>.send?title=&desp= ，受理判据是响应体 code=0
      const url = SERVERCHAN_HOST + encodeURIComponent(key) + '.send?title=' + encodeURIComponent(msg.title) + '&desp=' + encodeURIComponent(msg.body);
      const res = await fetchImpl(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      let code = `HTTP ${res.status}`;
      try { const j = await res.json(); code = String(j?.code ?? code); if (Number(j?.code) === 0) return { ok: true, channel, code, detail: '受理' }; }
      catch { /* 响应不是 JSON ⇒ 下面按失败处理 */ }
      return { ok: false, channel, code, detail: `未受理（HTTP ${res.status}）` };
    }
    return { ok: false, channel: String(channel), code: 'unknown-channel', detail: `不认识的通道 ${channel}` };
  } catch (e) {
    return { ok: false, channel: String(channel), code: 'exception', detail: String(e?.message ?? e) };
  }
}

// ── 落盘：一行一条 JSON（**发没发出去都记**，绝不静默吞）──────────────────────
export function makeLogger(logPath) {
  return (obj) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line + '\n', 'utf8');
    } catch (e) {
      console.error(`[watch-qq-login] 日志写不进去（${logPath}）：${e?.message ?? e}`);
    }
    console.log(`[watch-qq-login] ${line}`);
  };
}

export function readState(statePath) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { state: null, badStreak: 0, goodStreak: 0 }; }
}

export function writeState(statePath, st) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(st), 'utf8');
  } catch (e) {
    console.error(`[watch-qq-login] 状态写不进去（${statePath}）：${e?.message ?? e}`);
  }
}

// ── 一个回合（**测试就驱动它**：注入 fetch / env / 时钟 ⇒ 不真发、不联网也能验全流程）────
export async function runOnce(opts = {}) {
  const env = opts.env ?? process.env;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const paths = opts.paths ?? resolvePaths(env);
  const log = opts.log ?? makeLogger(paths.log);
  const ch = opts.channel ?? resolveChannel(env);
  const api = opts.api ?? resolveApi(env, opts.cfg ?? null);
  const confirmN = int(env.WATCH_QQ_CONFIRM_N, DEFAULTS.confirmN);
  const dryRun = String(env.WATCH_QQ_DRY_RUN ?? '') === '1';

  const prev = readState(paths.state);
  // ★ snowluma.httpUrl 无效 ⇒ **这一轮直接跳过**（2026-09-26 小镜复核后加）：
  //   原来取不到时是空串 ⇒ 采样必然异常 ⇒ 连击 2 次后发一条"掉线"**假警报**。
  //   **假警报比漏报更坏**（会训练主人无视告警）⇒ 记一行 skipped，状态不翻、通知不发。
  if (!/^https?:\/\//i.test(String(api.baseHttp ?? ''))) {
    log({ kind: 'skipped', reason: `snowluma.httpUrl 无效（${api.baseHttp ? api.baseHttp : '空'}）⇒ 这轮不采样、不翻状态、不发通知（假警报比漏报更坏）` });
    return { skipped: true, reason: 'bad-base-http', state: prev.state ?? null, flip: false, notified: null, channel: ch.channel };
  }
  const sample = await sampleOnce({ api, fetchImpl });
  const st = nextState(prev, sample, confirmN);
  log({ kind: 'sample', online: sample.online, reason: sample.reason, state: st.state, badStreak: st.badStreak, goodStreak: st.goodStreak, flip: st.flip });

  let notified = null;
  // 边沿触发：**只有状态真的翻了才发**；同一个状态不重复发（免得变成骚扰）。
  //   首次运行（prev.state=null）时：只有"确认掉线"才发（那本身就是新闻）；确认在线不发（没什么可说的）。
  const shouldNotify = st.flip && (st.state === 'offline' || prev.state === 'offline');
  if (shouldNotify) {
    const msg = buildMessage(st.state, { nickname: sample.nickname, reason: sample.reason, at: now() });
    notified = await notify(st.state, msg, { ...ch, fetchImpl, retryN: int(env.WATCH_QQ_RETRY_N, DEFAULTS.retryN), retryDelayMs: int(env.WATCH_QQ_RETRY_DELAY_MS, DEFAULTS.retryDelayMs), sleep, log, dryRun });
    log({ kind: 'alert', state: st.state, ok: notified.ok, code: notified.code, detail: notified.detail, attempts: notified.attempts, via: notified.channel });
  }
  writeState(paths.state, { state: st.state, badStreak: st.badStreak, goodStreak: st.goodStreak, at: now().toISOString() });
  return { sample, state: st.state, flip: st.flip, notified, channel: ch.channel };
}

// ── 常驻循环 ────────────────────────────────────────────────────────────────
export async function main(env = process.env) {
  const paths = resolvePaths(env);
  const ch = resolveChannel(env);
  const intervalMs = int(env.WATCH_QQ_INTERVAL_MS, DEFAULTS.intervalMs);
  const log = makeLogger(paths.log);
  log({ kind: 'boot', intervalMs, confirmN: int(env.WATCH_QQ_CONFIRM_N, DEFAULTS.confirmN), channel: ch.channel, channelWhy: ch.why ?? 'ok', log: paths.log, pid: process.pid });
  if (ch.channel === 'none') log({ kind: 'warn', msg: '没有可用通道 ⇒ 只记状态日志、不会通知主人（配好 key 后重启本服务即可）' });
  let stopping = false;
  const stop = (sig) => { stopping = true; log({ kind: 'stop', signal: sig }); };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
  while (!stopping) {
    try { await runOnce({ env }); } catch (e) { log({ kind: 'error', msg: String(e?.message ?? e) }); }
    if (String(env.WATCH_QQ_ONCE ?? '') === '1') break;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  log({ kind: 'bye' });
}

// 只有"直接被跑"才进循环（被 import 时（测试）什么都不做）
const direct = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (direct) await main();
