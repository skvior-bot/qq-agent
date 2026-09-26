#!/usr/bin/env node
// qq-notify —— 给**主人 QQ 私聊**发一条机器提示（OneBot HTTP 直连 SnowLuma，**不经桥接**）。
//
// 为什么不经桥接（qq-bridge）：这条通道的两个用处都在"桥接正要被关掉/刚起来"的窗口里 ——
//   停机前那句只有几百毫秒的机会，走桥接等于把通知交给一个正在关门的进程；
//   而 OneBot HTTP（SnowLuma）在启动器的清场里是**留着不动**的（start-all.ps1 清场带 -KeepSnowLuma），
//   所以它是那两个窗口里唯一还站着的通道。SnowLuma 没起来时它就发不出去 —— 那也没关系：
//   这条通知是**旁路**，永远不许把启动/停机那件事本身带崩。
//
// 用法：
//   node tools\qq-notify.mjs "内容"
//   node tools\qq-notify.mjs "内容" --dry-run        只打印"要发给谁、多长"，一个字节都不发
//   node tools\qq-notify.mjs "内容" --tag boot-up    日志里那一行的标签（默认 notify）
//
// 纪律：
//   ① **文案只许在源码里写死**（调用方传字面量）：红线 3 —— 机器提示里不许出现本地路径 /
//      配置内容 / 令牌。本文件**不做任何格式化、不拼任何路径进正文**，只负责发。
//   ② **失败不重试**（停机窗口里重试只会拖时间），只往 state\_tmp\qq-notify.log 记一行。
//   ③ **永远退 0**：它是旁路通知，它失败不算启动/停机失败。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'qq-bridge', 'config.json');
const LOG = path.join(ROOT, 'qq-bridge', 'state', '_tmp', 'qq-notify.log');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };

function usage(code = 1) {
  process.stdout.write(`用法：
  node tools\\qq-notify.mjs "内容" [--dry-run] [--tag boot-up]

给主人 QQ 私聊发一条**机器提示**（OneBot HTTP 直连 SnowLuma）。失败不重试、只记一行、永远退 0。
红线 3：正文里不许出现本地路径 / 配置内容 / 令牌 —— 文案由调用方在源码里写死。
`);
  return code;
}

function logLine(tag, text) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, `${new Date().toISOString()} [${tag}] ${text}\n`, 'utf8');
  } catch { /* 记不上就算了：这条通道本身就不许出错 */ }
}

const tag = val('--tag', 'notify');
// 只把「位置参数」挑出来：带值的开关要连它的值一起跳过，否则那个值会被当成正文的一部分。
const VALUE_FLAGS = new Set(['--tag', '--dedupe', '--window-min']);
const parts = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i++; continue; }
  parts.push(a);
}
const message = parts.join(' ').trim();

if (!message) { process.exit(usage(1)); }

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

const cfg = readJson(CFG) ?? {};
const ownerQQ = Number(cfg.ownerQQ ?? 0);

// 端口/地址的唯一来源：config.json 的 snowluma.httpUrl（缺了才问 config-lib 的默认表，
// 与 control-server.mjs / mcp-snowluma-host.js 同一口径）。
let httpUrl = String(cfg.snowluma?.httpUrl ?? '').trim();
if (!httpUrl) {
  try {
    const { resolvePorts, loopbackHttp } = await import('../qq-bridge/src/config-lib.js');
    httpUrl = loopbackHttp(resolvePorts().onebotHttp);
  } catch { httpUrl = ''; }
}
httpUrl = httpUrl.replace(/\/+$/, '');
const token = String(cfg.snowluma?.accessToken ?? '').trim();

if (!ownerQQ || !httpUrl) {
  process.stdout.write(`  [跳过] 发不了（ownerQQ=${ownerQQ ? '有' : '缺'}、OneBot HTTP 地址=${httpUrl ? '有' : '缺'}）—— 旁路通知，不算失败\n`);
  logLine(tag, `skip: ownerQQ=${ownerQQ ? 'ok' : 'missing'} httpUrl=${httpUrl ? 'ok' : 'missing'}`);
  process.exit(0);
}

// ── 去重（2026-09-25 加：主人截图来问"停机通知连发 4 条"）────────────────────────
// 同一个 `--dedupe <key>` 在窗口内只发一条；判据 = `state\_tmp\.notify-<key>` 的 mtime。
// ⚠ 两个方向都要选对：① **窗口过期 / 读不到 ⇒ 当没发过**（宁可多发一条，也不能把通知永久吞掉）；
//   ② **mtime 比现在还新几毫秒**（Windows 的 mtime 有 tick 粒度）⇒ 当"刚发过"—— 与 restart-stack
//      那道闸是同一条教训（那边判反过一次的代价是真重启了一次）。
const dedupeKey = String(val('--dedupe', '') || '').trim();
const windowMinRaw = Number(val('--window-min', '10'));
const windowMin = Number.isFinite(windowMinRaw) && windowMinRaw > 0 ? windowMinRaw : 10;
const dedupePath = dedupeKey ? path.join(ROOT, 'qq-bridge', 'state', '_tmp', `.notify-${dedupeKey}`) : '';
if (dedupeKey) {
  let ageMs = null;
  try { ageMs = Math.max(0, Date.now() - fs.statSync(dedupePath).mtimeMs); } catch { ageMs = null; }
  if (ageMs !== null && ageMs <= windowMin * 60000) {
    const secs = Math.round(ageMs / 1000);
    process.stdout.write(`  [QQ 提示] 去重跳过：${dedupeKey} 在 ${secs} 秒前刚发过（窗口 ${windowMin} 分钟）\n`);
    logLine(tag, `skip-dedupe: ${dedupeKey} 上次 ${secs}s 前（窗口内）`);
    process.exit(0);
  }
}

if (has('--dry-run')) {
  process.stdout.write(`  [DryRun] 会发给主人私聊（${String(ownerQQ).slice(0, 2)}****${String(ownerQQ).slice(-2)}），正文 ${message.length} 字：${message}\n`);
  if (dedupeKey) process.stdout.write(`  [DryRun] 发成功后才会写去重标记：state\\_tmp\\.notify-${dedupeKey}（窗口 ${windowMin} 分钟）\n`);
  process.exit(0);
}

const body = { user_id: ownerQQ, message: [{ type: 'text', data: { text: message } }] };
let ok = false;
let detail = '';
try {
  const res = await fetch(`${httpUrl}/send_private_msg`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const j = await res.json().catch(() => ({}));
  ok = res.ok && j?.status === 'ok' && j?.retcode === 0;
  detail = ok ? 'ok' : `HTTP ${res.status} ${j?.wording ?? j?.retcode ?? ''}`.trim();
} catch (e) {
  detail = `fetch 失败：${e?.name === 'TimeoutError' ? '超时（8 秒）' : String(e?.message ?? e)}`;
}

process.stdout.write(ok
  ? `  [QQ 提示] 已发主人私聊（${message.length} 字，tag=${tag}${dedupeKey ? `，去重键 ${dedupeKey}` : ''}）\n`
  : `  [QQ 提示] 没发出去（${detail}）—— 旁路通知，不重试、不算失败\n`);
logLine(tag, ok ? `sent ${message.length} chars${dedupeKey ? ` dedupe=${dedupeKey}` : ''}` : `failed: ${detail}`);
// 去重标记**只在真发成功时**才落（失败不落 ⇒ 下一轮还能再试；这条通道本来就不许因为记不上而吞掉通知）。
if (ok && dedupeKey) {
  try { fs.writeFileSync(dedupePath, `${new Date().toISOString()} ${tag}\n`, 'utf8'); } catch { }
}
process.exit(0);
