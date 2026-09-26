#!/usr/bin/env node
/**
 * tools\stall-audit.mjs —— 「睡眠 / 冻结审计器」（2026-09-25 立，执行线 `5758ba91` 提法、优化线 `63889df1` 实现）
 *
 * 为什么需要它（主人 2026-09-25 那两条消息丢在哪，查了一整天才查清）：
 *   那两条**不是**被谁丢了 —— 09:44:06 这台机器**睡着了 11 分 50 秒**，整机没有任何收件方，
 *   而 QQ 侧**不会**给睡眠窗口里的消息补发。更麻烦的是：**在线告警盖不住这一类**
 *   （睡眠期间看门狗的 tick 根本不跑 ⇒ 醒后第一拍探针直接成功 ⇒ 不进 degraded、不发提醒），
 *   所以「他真丢消息的那一类恰好不响」。在线那半由执行线的「断档判据补丁」补；
 *   这个工具补的是**离线那半**：事后**可查、可留痕、可量化**（"这台机器到底多久睡一次、睡多久"）。
 *
 * 两个来源，一主一辅（互相独立）：
 *   ① **Windows 电源事件 = 权威**：`Microsoft-Windows-Power-Troubleshooter` 事件 1 的原文里
 *      直接带 `Sleep Time` / `Wake Time`（UTC）⇒ 每个睡眠窗口的起止都拿得到，不用推断。
 *   ② **网关活动心跳缺口 = 交叉验证**：SnowLuma 日志里**桥接自己的** `[Bridge.Action] …` 行
 *      （看门狗每 60s 一拉，还有别的调用）—— 整机冻结时这些行会整段消失。
 *      ⚠ 它是**活动**不是**心跳**（安静时段本来就可能稀疏），所以缺口**只报"未解释"、不单独定罪**：
 *      要么落在某个睡眠窗口里（✓ 已解释），要么落在已知重启点附近（✓ 重启），要么标"需人工看一眼"。
 *
 * 用法：
 *   node tools\stall-audit.mjs                    # 默认看过去 7 天：睡眠窗口 + 心跳缺口
 *   node tools\stall-audit.mjs --days 2           # 只看过去 2 天
 *   node tools\stall-audit.mjs --min 10           # 缺口判据改成 10 分钟（默认 5）
 *   node tools\stall-audit.mjs --line             # 只打一行摘要（给 daily-check 用）
 *   node tools\stall-audit.mjs --json             # 机器可读
 *   node tools\stall-audit.mjs --selftest         # 自检（合成数据，不碰真实日志/事件）
 *
 * 退出码：0 = 没有"未解释"的缺口；1 = 有未解释缺口（值得人工看一眼）；2 = 读不到电源事件（审计是瞎的）。
 * ⚠ 只读：不写 state、不发 QQ、不碰桥接。唯一的外部动作是问 Windows 要电源事件（只读查询）。
 * ⚠ 沙箱注意：Node 的 `spawnSync` + 管道在受限沙箱里会撞 EPERM ⇒ 这里照 `daily-check.mjs` 的做法，
 *   用**文件重定向**接 PowerShell 的输出（沙箱内外都能跑）。在 PowerShell 里手跑没问题，别用管道形式。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'qq-bridge', 'state', '_tmp');
const GW_LOG_DIR = path.join(ROOT, 'SnowLuma', 'logs');
const RUNTIME = path.join(ROOT, 'qq-bridge', 'state', 'bridge-runtime.json');

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) return true;
  return v;
};
const DAYS = Math.max(1, Number(flag('days', 7)) || 7);
const MIN_GAP_MS = Math.max(1, Number(flag('min', 5)) || 5) * 60000;
const LINE_ONLY = argv.includes('--line');
const AS_JSON = argv.includes('--json');
const SELFTEST = argv.includes('--selftest');

const pad = (n) => String(n).padStart(2, '0');
const fmtLocal = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const human = (ms) => {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h${pad(m)}m`;
  if (m) return `${m}m${pad(s % 60)}s`;
  return `${s}s`;
};
/** 活跃时段 = 每天 08:00~24:00（本地）：主人醒着、最该"能收到消息"的时段。 */
const ACTIVE_FROM_HOUR = 8;
/**
 * 纯函数：睡眠窗口与「活跃时段」的重叠毫秒数。
 * 为什么不用"起睡时刻算白天/夜里"这种粗判（第一版就是这么写的，被自己否掉）：
 *   一夜 02:56→10:34 的睡眠里，**真正让他收不到消息的是 08:00–10:34 那 2h34m**，不是整段 7h38m
 *   ⇒ 这个数才是主人那条「自动睡眠要不要关」的决策依据（也是 `daily-check` 里最该报的那个数）。
 * 活跃时段按**每天 08:00–24:00** 算（跨天窗口会自动切分；中国无夏令时，不用管 DST）。
 */
export function activeOverlapMs(from, to, activeFromHour = ACTIVE_FROM_HOUR) {
  let sum = 0;
  const day = new Date(from);
  day.setHours(0, 0, 0, 0);
  for (let t = day.getTime(); t < to; t += 86400000) {
    const a = Math.max(from, t + activeFromHour * 3600000);
    const b = Math.min(to, t + 86400000);
    if (b > a) sum += b - a;
  }
  return sum;
}

// ── ① 电源事件（权威来源）──────────────────────────────────────────────────
/**
 * 问 Windows 要 Power-Troubleshooter 事件 1（每个睡眠周期一条，原文含 Sleep/Wake Time）。
 * 用文件重定向接输出（沙箱内不能走管道），UTF-8 显式设一次，失败就返回空数组（调用方会判"瞎"）。
 */
function readPowerWindows(days) {
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    "$ErrorActionPreference='SilentlyContinue'",
    `$since=(Get-Date).AddDays(-${days})`,
    "$ev=Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Microsoft-Windows-Power-Troubleshooter';Id=1;StartTime=$since}",
    '$o=@()',
    "foreach($e in $ev){$o+=[pscustomobject]@{t=$e.TimeCreated.ToString('o');m=($e.Message -replace '\\r?\\n',' ')}}",
    'ConvertTo-Json -InputObject $o -Compress -Depth 4'
  ].join('; ');
  fs.mkdirSync(TMP, { recursive: true });
  const outFile = path.join(TMP, `stall-audit-ps-${Date.now()}.json`);
  const fd = fs.openSync(outFile, 'w');
  let run;
  try {
    run = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['ignore', fd, 'ignore'], windowsHide: true, timeout: 90000, cwd: ROOT });
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
  let raw = '';
  try { raw = fs.readFileSync(outFile, 'utf8'); } catch {}
  try { fs.unlinkSync(outFile); } catch {}
  if (run?.error) return { ok: false, why: run.error.message, windows: [], unparsed: 0 };
  return parsePowerJson(raw, run?.status ?? 0);
}

/** 纯函数（自检直接喂字符串）：把 Get-WinEvent 的 JSON 变成睡眠窗口列表。 */
export function parsePowerJson(raw, status = 0) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return { ok: status === 0, why: status === 0 ? '（过去 N 天没有电源事件记录）' : `powershell 退出码 ${status}`, windows: [], unparsed: 0 };
  let data;
  try { data = JSON.parse(text); } catch (error) { return { ok: false, why: `电源事件 JSON 解析失败：${error.message}`, windows: [], unparsed: 0 }; }
  const rows = Array.isArray(data) ? data : [data];
  const windows = [];
  let unparsed = 0;
  for (const row of rows) {
    // 事件原文形如：`Sleep Time: ‎2026‎-‎09‎-‎25T01:44:06.046Z ；Wake Time: …`（中间混着 U+200E 之类不可见标记）
    const msg = String(row?.m ?? '').replace(/[\u200e\u200f\u202a-\u202e]/g, '');
    const sleep = /Sleep Time:\s*([0-9T:\-./]+Z?)/.exec(msg);
    const wake = /Wake Time:\s*([0-9T:\-./]+Z?)/.exec(msg);
    const from = sleep ? Date.parse(sleep[1]) : NaN;
    const to = wake ? Date.parse(wake[1]) : NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) { unparsed += 1; continue; }
    windows.push({ from, to, ms: to - from, eventAt: Date.parse(String(row?.t ?? '')) || 0 });
  }
  windows.sort((a, b) => a.from - b.from);
  return { ok: true, why: '', windows, unparsed };
}

// ── ② 网关活动心跳（交叉验证）───────────────────────────────────────────────
/** 收集过去 N 天的 `[Bridge.Action]` 时间戳（SnowLuma 日志按**本地日期**分文件）。 */
export function collectHeartbeat(days, nowMs = Date.now(), logDir = GW_LOG_DIR) {
  const stamps = [];
  for (let back = 0; back <= days; back += 1) {
    const d = new Date(nowMs - back * 86400000);
    const file = path.join(logDir, `snowluma-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.log`);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    stamps.push(...parseHeartbeatLines(text, new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()));
  }
  return stamps.sort((a, b) => a - b);
}

/** 纯函数：从一天的日志文本里取时间戳（`HH:MM:SS … [Bridge.Action] …`）。 */
export function parseHeartbeatLines(text, dayStartMs) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('[Bridge.Action]')) continue;
    const m = /^(\d{2}):(\d{2}):(\d{2})\b/.exec(line);
    if (!m) continue;
    out.push(dayStartMs + (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
  }
  return out;
}

/** 纯函数：相邻时间戳差 > 阈值 ⇒ 一个缺口。 */
export function computeGaps(stamps, minGapMs) {
  const gaps = [];
  for (let i = 1; i < stamps.length; i += 1) {
    const ms = stamps[i] - stamps[i - 1];
    if (ms >= minGapMs) gaps.push({ from: stamps[i - 1], to: stamps[i], ms });
  }
  return gaps;
}

/**
 * 纯函数：给缺口定性。
 * 判据顺序：落在睡眠窗口里 ⇒ sleep；与已知重启点吻合（±90s）⇒ restart；否则 unexplained。
 * ⚠ 有意**不**把"未解释"直接叫"冻结" —— 心跳是"活动"不是"心跳"，安静时段会自然稀疏。
 */
export function attributeGap(gap, windows, boots = [], slackMs = 90000) {
  for (const w of windows) {
    const overlap = Math.min(gap.to, w.to) - Math.max(gap.from, w.from);
    if (overlap >= Math.min(gap.ms, w.ms) * 0.5) return { kind: 'sleep', window: w };
  }
  for (const b of boots) if (Math.abs(gap.to - b) <= slackMs) return { kind: 'restart', bootAt: b };
  return { kind: 'unexplained' };
}

/** 已知重启点（只有最近两次：runtime 文件就记这么多 ⇒ 老的重启点只能靠"未解释"兜着）。 */
function readBoots() {
  try {
    const j = JSON.parse(fs.readFileSync(RUNTIME, 'utf8').replace(/^\uFEFF/, ''));
    return [Date.parse(j.lastBootAt), Date.parse(j.previousBootAt)].filter(Number.isFinite);
  } catch { return []; }
}

// ── 渲染 ───────────────────────────────────────────────────────────────────
function run() {
  const now = Date.now();
  const power = readPowerWindows(DAYS);
  const windows = power.windows.filter((w) => w.to >= now - DAYS * 86400000);
  const stamps = collectHeartbeat(DAYS, now);
  const gaps = computeGaps(stamps, MIN_GAP_MS);
  const boots = readBoots();
  const judged = gaps.map((g) => ({ ...g, verdict: attributeGap(g, windows, boots) }));
  const unexplained = judged.filter((g) => g.verdict.kind === 'unexplained');
  const totalSleep = windows.reduce((a, w) => a + w.ms, 0);
  const activeSleep = windows.reduce((a, w) => a + activeOverlapMs(w.from, w.to), 0);
  const activeCount = windows.filter((w) => activeOverlapMs(w.from, w.to) > 0).length;
  // 退出码：**只看电源事件读没读到**（权威那一半）。缺口是「活动稀疏」不是证据 ⇒ 默认不影响退出码，
  // 想要"有未解释缺口就非零"的人显式加 --strict（给将来的自动化留口子，但不拿它当默认）。
  const code = argv.includes('--strict') && unexplained.length ? 1 : (power.ok ? 0 : 2);

  if (AS_JSON) {
    console.log(JSON.stringify({
      days: DAYS, minGapMs: MIN_GAP_MS, powerOk: power.ok, powerWhy: power.why, unparsedEvents: power.unparsed,
      sleep: {
        count: windows.length, totalMs: totalSleep, activeMs: activeSleep, activeCount,
        windows: windows.map((w) => ({ from: new Date(w.from).toISOString(), to: new Date(w.to).toISOString(), ms: w.ms, activeMs: activeOverlapMs(w.from, w.to) }))
      },
      gaps: {
        note: '缺口 = 网关活动稀疏段，**只作展示**：安静时段本来就会稀疏，只有电源事件能定罪',
        samples: stamps.length,
        rows: judged.map((g) => ({ from: new Date(g.from).toISOString(), to: new Date(g.to).toISOString(), ms: g.ms, verdict: g.verdict.kind }))
      },
      unexplained: unexplained.length
    }, null, 2));
    return code;
  }

  const line = `[stall-audit] 过去 ${DAYS} 天：睡眠 ${windows.length} 次合计 ${human(totalSleep)}，**落在活跃时段（每天 08:00–24:00）${human(activeSleep)}**（${activeCount} 次与活跃时段重叠）`
    + `；网关活动缺口 >${Math.round(MIN_GAP_MS / 60000)}min 共 ${judged.length} 处（仅供参考，不当证据）`
    + (power.ok ? '' : `；⚠ 读不到电源事件（${power.why}）`);
  if (LINE_ONLY) { console.log(line); return code; }

  console.log(`睡眠/冻结审计（过去 ${DAYS} 天；阈值 ${Math.round(MIN_GAP_MS / 60000)} 分钟）`);
  console.log('来源：① Windows 电源事件（权威，含 Sleep/Wake 原文） ② SnowLuma 日志里桥接自己的 [Bridge.Action] 行（交叉验证）');
  console.log('');
  if (!power.ok) console.log(`⚠ 电源事件读不到（${power.why}）⇒ 这一半是瞎的（心跳那半照常）`);
  console.log(`■ 睡眠窗口：${windows.length} 次，合计 ${human(totalSleep)}；**其中落在活跃时段（每天 08:00–24:00）${human(activeSleep)}**（${activeCount} 次与活跃时段重叠）`);
  for (const w of windows) {
    const act = activeOverlapMs(w.from, w.to);
    console.log(`   ${fmtLocal(w.from)} → ${fmtLocal(w.to)}  ${human(w.ms)}${act ? `（落在活跃时段 ${human(act)}）` : '（整段都在 00:00–08:00）'}`);
  }
  if (power.unparsed) console.log(`   （另有 ${power.unparsed} 条事件解析不了，未计入）`);
  if (windows.length) {
    console.log('   ⚠ 睡眠期间整机不在跑 ⇒ 这期间到达的消息**不会被 QQ 补发**（09-25 09:47/09:48 两条已实测证实）；');
    console.log('     现有对账只捞得回"醒来前约 35 分钟"（count 上限 50 条 ≈ 35 分钟，私聊历史翻不到更早）。');
  }
  console.log('');
  const TOP = Math.max(1, Number(flag('top', 8)) || 8);
  const shown = [...judged].sort((a, b) => b.ms - a.ms).slice(0, TOP);
  console.log(`■ 网关活动缺口（> ${Math.round(MIN_GAP_MS / 60000)} 分钟）：${judged.length} 处（样本 ${stamps.length} 个时间戳）`);
  console.log('   ⚠ **只作展示、不当证据**：`[Bridge.Action]` 是「活动」不是「心跳」——安静时段本来就稀疏，');
  console.log('     第一版拿它当"冻结证据"，7 天窗口报了 83 处"未解释"，全是噪声（已按协调线口径改掉）。');
  for (const g of shown) {
    const tag = g.verdict.kind === 'sleep' ? '✓ 落在睡眠窗口' : g.verdict.kind === 'restart' ? '✓ 重启点' : '· 安静/未解释（不必理会）';
    console.log(`   ${fmtLocal(g.from)} → ${fmtLocal(g.to)}  ${human(g.ms)}  ${tag}`);
  }
  if (judged.length > shown.length) console.log(`   （只列最长的 ${shown.length} 处；全量用 --json）`);
  if (!judged.length) console.log('   （没有超过阈值的缺口）');
  console.log('');
  console.log(`结论：${windows.length ? `本机在审计窗口里睡了 ${windows.length} 次（合计 ${human(totalSleep)}，其中他醒着的时段 ${human(activeSleep)}）` : '审计窗口里没有睡眠记录'}`
    + `；缺口那半只作参考（${unexplained.length} 处未解释，多数是安静时段）`);
  return code;
}

// ── 自检（合成数据，不碰真实日志/事件）────────────────────────────────────────
function selftest() {
  let pass = 0; let fail = 0;
  const ok = (cond, name) => { if (cond) { pass += 1; console.log(`  ✓ ${name}`); } else { fail += 1; console.log(`  ❌ ${name}`); } };
  console.log('[stall-audit --selftest]');
  // ① 电源事件解析（含 U+200E 干扰字符，与真实原文同形）
  const raw = JSON.stringify([{ t: '2026-09-25T09:55:57.0000000+08:00', m: 'Sleep Time: \u200e2026\u200e-\u200e09\u200e-\u200e25T01:44:06.046Z Wake Time: \u200e2026\u200e-\u200e09\u200e-\u200e25T01:55:56.817Z Wake Source: Device - USB Composite Device' }]);
  const parsed = parsePowerJson(raw);
  ok(parsed.windows.length === 1 && parsed.windows[0].ms === 710771, '电源事件：U+200E 干扰下仍解析出 11m50.771s 窗口（01:44:06.046Z → 01:55:56.817Z）');
  ok(parsePowerJson('') .ok === true && parsePowerJson('').windows.length === 0, '空输出 ⇒ 正常返回 0 个窗口');
  ok(parsePowerJson('not json').ok === false, '坏 JSON ⇒ ok=false（调用方据此判"瞎"）');
  ok(parsePowerJson(JSON.stringify([{ t: '', m: '没有时间戳' }])).unparsed === 1, '解析不了的事件计入 unparsed');
  // ② 心跳解析：只认 [Bridge.Action] 且行首要带时间戳
  const day0 = new Date(2026, 8, 25).getTime();
  const lines = '10:00:00 DEBUG [1] [Bridge.Action] get_login_info params=x\n10:00:30 INFO 别的行\n10:01:00 DEBUG [1] [Bridge.Action] get_friend_msg_history params=y\n';
  ok(parseHeartbeatLines(lines, day0).length === 2, '心跳解析：2 行 [Bridge.Action]（无关行不计）');
  // ③ 缺口计算 + 定性
  const stamps = [0, 60000, 60000 + 12 * 60000].map((d) => day0 + d);
  const gaps = computeGaps(stamps, 5 * 60000);
  ok(gaps.length === 1 && gaps[0].ms === 12 * 60000, '缺口：只报 > 阈值的那个（12 分钟）');
  const win = [{ from: day0 + 30000, to: day0 + 13 * 60000, ms: 12.5 * 60000 }];
  ok(attributeGap(gaps[0], win, []).kind === 'sleep', '定性：落在睡眠窗口 ⇒ sleep');
  ok(attributeGap(gaps[0], [], [gaps[0].to]).kind === 'restart', '定性：落在重启点 ±90s ⇒ restart');
  ok(attributeGap(gaps[0], [], [gaps[0].to + 10 * 60000]).kind === 'unexplained', '定性：都不匹配 ⇒ unexplained');
  ok(attributeGap(gaps[0], [], []).kind === 'unexplained', '定性：无窗口无重启 ⇒ unexplained（不硬说"冻结"）');
  // ②b 活跃时段重叠：一夜 02:56→10:34 只该算 08:00–10:34 那 2h34m（决策依据就是这个数）
  const night = [new Date(2026, 8, 24, 2, 56, 26).getTime(), new Date(2026, 8, 24, 10, 34, 35).getTime()];
  ok(activeOverlapMs(night[0], night[1]) === (2 * 3600 + 34 * 60 + 35) * 1000, '活跃时段：02:56:26→10:34:35 只算 08:00–10:34:35 = 2h34m35s（不是整段 7h38m）');
  ok(activeOverlapMs(new Date(2026, 8, 25, 1, 0, 0).getTime(), new Date(2026, 8, 25, 3, 0, 0).getTime()) === 0, '活跃时段：整段落在 00:00–08:00 ⇒ 0');
  ok(activeOverlapMs(new Date(2026, 8, 25, 21, 0, 0).getTime(), new Date(2026, 8, 26, 9, 0, 0).getTime()) === 4 * 3600 * 1000, '活跃时段：跨天窗口会切分（21:00→09:00 = 3h + 1h）');
  console.log(fail ? `\n${fail} 失败 / ${pass} 通过` : `\nALL OK：${pass} 通过 / 0 失败`);
  return fail ? 1 : 0;
}

if (SELFTEST) process.exit(selftest());
else process.exit(run());
