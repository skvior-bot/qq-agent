#!/usr/bin/env node
// tools/usage-report.mjs —— 用量账本：从会话日志里读**真实 provider usage**，回答"token 花在哪"。
//
// 为什么不用估算：token-meter 的字符估算法（4 字符/token）在带工具/中文/代码的上下文里偏差很大，
// 但它在拿到 provider 回传的 usage 后会**锚定到真实值**，而 `assistant/message` 事件里带的就是
// provider 的原始 usage —— 所以本工具直接读日志，数字就是账单口径。
//
// 用法:
//   node tools/usage-report.mjs                       # 全部会话汇总 + 排行榜（默认：官方价 + 按时段自动区分闲时/高峰）
//   node tools/usage-report.mjs --session 09caba98    # 只看某个会话（前缀匹配）
//   node tools/usage-report.mjs --session 09caba98 --recent 30   # 再打它最近 30 步的逐步用量
//   node tools/usage-report.mjs --latency [--session 09caba98]   # 每步真实耗时 vs 上下文大小（压缩阈值定标用）
//   node tools/usage-report.mjs --basis idle          # 全部按闲时价（= 理论下界）
//   node tools/usage-report.mjs --basis peak          # 全部按高峰价（= 理论上界）
//   node tools/usage-report.mjs --price-hit 0.05 --price-miss 0.5 --price-out 3   # 固定单价（自动切 --basis fixed）
//
// 价格（¥/百万 token）默认就是**官方真实价目的闲时价**（命中 0.02 / 未命中 1 / 输出 4，见下面口径块），
// 而且**按事件时间自动区分闲时与高峰** —— 所以本工具的输出可以直接当账单看，不再是"假设值折出来的量级"。
// 打印时会显式写出"本次用的是哪种口径"，别让人猜。
//
// 口径提醒:
//   * `assistant/message` = 一步一次请求；`stream.N.chunk.usage` 是同一份 usage 的重复副本，只取事件顶层对象。
//   * 压缩摘要是**另一次请求**（`compaction/summary`，带自己的 usage），别把它漏掉 —— 它是全价输入大户。
//   * `assistant/message` / `compaction/summary` / `session/title-llm-request` 三类带 usage 的事件**都带 `time`**
//     （epoch ms，UTC；本机实测 768/768 命中）⇒ 闲时/高峰可以**按事件时间**判，不必按步估。
//   * `--latency` 用的是另一组字段：每个事件都带 `time`（epoch ms），且有 `step/start` / `step/end` ——
//     所以"每步真实耗时"是量出来的、不是估的。**压缩机前先看这条曲线**（见 docs\优化清单.md 定标一节）。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
// 价格口径住在 tools\pricing.mjs（唯一一份）：账本与会话卫生（tools\sessions.mjs）共用，
// 免得两处各写一份价、迟早对不上。本文件的输出必须与抽出来之前**一字不变**。
import { DEFAULT_PRICE, PEAK_X, costT as costTWith, isPeakBj, CN_HOLIDAY_YEARS } from './pricing.mjs';

const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : dflt;
};
const ROOT = arg('root', path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh', 'sessions'));
const ONLY = arg('session', '');
const RECENT = Number(arg('recent', 0));
// ⚠ 计价口径（2026-09-25 起改用**官方真实价目**）：
//   出处 https://api-docs.deepseek.com/zh-cn/quick_start/pricing —— `deepseek-flash`（= DeepSeek-V4.1-Flash），
//   人民币 / 每 M token（新价 **2026-09-10 12:00 起生效**）：
//     │ 块             │ 闲时     │ 高峰     │
//     │ 缓存命中输入   │ ¥0.02/M  │ ¥0.04/M  │
//     │ 缓存未命中输入 │ ¥1/M     │ ¥2/M     │
//     │ 输出           │ ¥4/M     │ ¥8/M     │
//   **闲时 = 高峰的一半**；**高峰 = 北京时间 周一至周五 9:00–12:00 与 14:00–18:00**；
//   其余时段（夜间、周末、**中国法定节假日全天**）都是闲时（官方价目页注(2)）。
//   ✅ **法定节假日已识别（2026-09-25 12:xx 修）**：判据搬进 `tools\pricing.mjs`（唯一一份），带一张
//     **法定节假日表 + 调休上班表**（来源：国务院办公厅《关于2026年部分节假日安排的通知》2025-11-04）——
//     节假日全天算闲时，**调休上班的周六/周日反过来算高峰**（例：2026-10-10 周六上班 ⇒ 高峰）。
//   ⚠ **剩下的已知偏差**：表里目前只有 **2026** —— 落在**表外年份**的事件仍按「星期 + 钟点」判（偏高）。
//     加一年就往 `pricing.mjs` 的 `CN_HOLIDAYS` 里抄一年（报告会印出覆盖年份）。
//   默认三个 --price-* 就是**官方闲时价**（0.02 / 1 / 4）；一旦显式给了 --price-*，就默认切到 `--basis fixed`
//   （固定单价、不再分时段，便于与历史输出逐字对比）；想要"按时段自动"就用默认的 `--basis auto`。
//   历史口径（2026-09-25 之前）是 0.05 / 0.5 / 3 三个**假设值**，系统性高估约 28.6% —— 对账过程与算式见
//   docs\优化清单.md「📉 对账（2026-09-25 平台账单 vs 本地口径）」一节（该节原文保留，结论已由官方价目判定）。
const PRICE = {
  hit: Number(arg('price-hit', DEFAULT_PRICE.hit)),   // 官方闲时：缓存命中输入 ¥0.02/M（住在 tools\pricing.mjs）
  miss: Number(arg('price-miss', DEFAULT_PRICE.miss)), // 官方闲时：缓存未命中输入 ¥1/M
  out: Number(arg('price-out', DEFAULT_PRICE.out)),   // 官方闲时：输出（含推理）¥4/M
};
// PEAK_X（高峰倍率）与 costT（三块 token 折钱）都从 tools\pricing.mjs 来 —— 那里是唯一一份口径。
const GIVEN = ['price-hit', 'price-miss', 'price-out'].filter((n) => argv.includes('--' + n));
// 计价口径（**必须打印出来**，不许让人猜）：
//   auto  = 按每条事件的时间自动落 闲时/高峰（默认）
//   idle  = 全部按闲时（理论下界，最便宜）      peak = 全部按高峰（理论上界，最贵）
//   fixed = 全部按 --price-* 的固定单价（不分时段；显式给 --price-* 时的默认值）
const BASIS = String(arg('basis', GIVEN.length ? 'fixed' : 'auto')).toLowerCase();
const BASES = ['auto', 'idle', 'peak', 'fixed'];
const TOP = Number(arg('top', 6));
const LATENCY = argv.includes('--latency');

/** 会话日志是**多帧拼接**的 zstd：逐帧找魔数、各自解压，再拼成 JSONL 文本。 */
function decodeAll(file) {
  const buf = fs.readFileSync(file);
  let pos = 0, frames = 0, bad = 0;
  const chunks = [];
  while (pos < buf.length - 4) {
    let idx = -1;
    for (let i = pos; i < buf.length - 4; i++) {
      if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) { idx = i; break; }
    }
    if (idx < 0) break;
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(idx)).toString('utf8')); frames++; pos = idx + 4; }
    catch { bad++; pos = idx + 1; }
  }
  return { text: chunks.join(''), frames, bad, bytes: buf.length };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const ctxOf = (u) => num(u.inputTokens) + num(u.cacheReadTokens);
/** usage 可能在事件顶层，也可能嵌在 data 里；顶层优先（避免拿到 stream chunk 的重复副本）。 */
const usageOf = (o) => {
  for (const c of [o.usage, o.data && o.data.usage, o.data && o.data.message && o.data.message.usage]) {
    if (c && typeof c === 'object') return c;
  }
  return null;
};
/** 摘要正文的落点随版本变过（data.content / data.summary / message.content…）：递归找最长的那个字符串，别写死路径。 */
function longestString(v, depth = 4, best = '') {
  if (depth < 0 || v === null || v === undefined) return best;
  if (typeof v === 'string') return v.length > best.length ? v : best;
  if (Array.isArray(v)) { for (const x of v) best = longestString(x, depth - 1, best); return best; }
  if (typeof v === 'object') { for (const x of Object.values(v)) best = longestString(x, depth - 1, best); return best; }
  return best;
}

const zero = () => ({ n: 0, unc: 0, hit: 0, out: 0, reason: 0 });
const add = (a, u) => { a.n++; a.unc += num(u.inputTokens); a.hit += num(u.cacheReadTokens); a.out += num(u.outputTokens); a.reason += num(u.reasoningTokens); };
const sum = (a, b) => { for (const k of ['n', 'unc', 'hit', 'out', 'reason']) a[k] += b[k]; };

// ── 闲时 / 高峰（判据 = `tools\pricing.mjs` 的 `isPeakBj`，唯一一份；2026-09-25 起识别法定节假日）──
// 高峰 = **北京时间** 周一至周五 09:00–12:00 与 14:00–18:00；夜间 / 周末 / **法定节假日全天** = 闲时；
// **调休上班的周六/周日按工作日算**。`time` 字段是**真 UTC epoch ms**（本机实测：会话文件里最大
// time == 文件 mtime == Date.now()），判据内部 +8h 再读 UTC 系列 ⇒ 判出来的始终是"北京时间"。
// ⚠ 表外年份（表里只有 CN_HOLIDAY_YEARS）仍按星期+钟点判 —— 报告会把这个覆盖范围印出来。
/** 事件落哪一桶：idle / peak / unk（没有 time 的用量事件 —— 本机实测为 0，但兜住）。 */
const bucketOf = (t) => (typeof t === 'number' && Number.isFinite(t) ? (isPeakBj(t) ? 'peak' : 'idle') : 'unk');
const BUCKETS = ['idle', 'peak', 'unk'];
const newB = () => ({ idle: zero(), peak: zero(), unk: zero() });
const sumB = (dst, src) => { for (const b of BUCKETS) sum(dst[b], src[b]); };
const sumBk = (B) => { const t = zero(); for (const b of BUCKETS) sum(t, B[b]); return t; };

const M = (v) => (v / 1e6).toFixed(2) + 'M';
const k = (v) => (v / 1000).toFixed(v >= 100000 ? 0 : 1) + 'k';
const Y = (v) => '¥' + v.toFixed(v >= 10 ? 2 : 3);
// costT 的**算法**从 tools\pricing.mjs 来（唯一一份口径），但单价用本文件的 PRICE —— 这样 `--price-*`
// 的覆盖照样生效（显式给了 --price-* 会切 --basis fixed，输出必须与抽出来之前一字不变）。
const costT = (t, mult = 1) => costTWith(t, mult, PRICE);
/** 取某一块（命中 / 未命中 / 输出 / 推理）当"全部 token"，好复用 costT。 */
const BOX = {
  hit: (b) => ({ unc: 0, hit: b.hit, out: 0 }),
  miss: (b) => ({ unc: b.unc, hit: 0, out: 0 }),
  out: (b) => ({ unc: 0, hit: 0, out: b.out }),
  reason: (b) => ({ unc: 0, hit: 0, out: b.reason }),
};
const tokOf = (sel, B) => BUCKETS.reduce((t, b) => { const x = sel(B[b]); return t + x.unc + x.hit + x.out; }, 0);

// ── 扫全部会话 ──────────────────────────────────────────────────────────────
const sessions = [];
if (!fs.existsSync(ROOT)) {
  console.error(`找不到会话目录：${ROOT}`);
  process.exit(1);
}

/**
 * `--latency`：每步真实耗时 vs 上下文大小 + 压缩停顿。
 * 为什么需要它：抬/降压缩阈值是"速度 vs 记忆"的取舍，而"每步耗时"是唯一能量化速度的字段。
 * 归一化口径 = 每 1k 输出 token 的毫秒数（把"这一步字更多"的影响除掉），剩下的是随上下文增长的固定开销。
 * 实测（2026-09-24，开发会话 2465 步）：≤100k 6.2s / 100–150k 6.4s / 150–300k 6.5s / 300–400k 6.3s
 * / 400–600k 8.2s / 600k+ 12.3s ⇒ **到 400k 为止是平线、过 400k 才开始变贵**（开发侧取 0.40 的依据）。
 */
function latencyOf(file) {
  const { text } = decodeAll(file);
  const steps = [], comps = [];
  let cur = null, compT0 = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let o; try { o = JSON.parse(t); } catch { continue; }
    const u = (o.data && o.data.usage) || null;
    if (o.type === 'step/start') { cur = { t0: o.time, ctx: 0, out: 0 }; continue; }
    if (o.type === 'assistant/message' && cur && u) { cur.ctx = num(u.inputTokens) + num(u.cacheReadTokens); cur.out = num(u.outputTokens); continue; }
    if (o.type === 'step/end' && cur) { if (cur.ctx > 0) steps.push({ ctx: cur.ctx, out: cur.out, ms: o.time - cur.t0 }); cur = null; continue; }
    if (o.type === 'compaction/start') { compT0 = o.time; continue; }
    if (o.type === 'compaction/end') { if (compT0) comps.push(o.time - compT0); compT0 = 0; }
  }
  return { steps, comps };
}

const median = (a) => { if (!a.length) return 0; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const dur = (ms) => (ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's');

if (LATENCY) {
  const found = [];
  for (const ws of fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const wsDir = path.join(ROOT, ws.name);
    for (const sd of fs.readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const file = path.join(wsDir, sd.name, 'session.v3.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      const id = sd.name.replace(/^session-/, '').slice(0, 8);
      if (ONLY && !id.startsWith(ONLY)) continue;
      found.push({ id, file, at: fs.statSync(file).mtimeMs });
    }
  }
  const EDGES = [0, 50000, 100000, 150000, 200000, 250000, 300000, 400000, 600000, Infinity];
  for (const { id, file } of found.sort((a, b) => b.at - a.at).slice(0, ONLY ? 99 : 4)) {
    const { steps, comps } = latencyOf(file);
    if (!steps.length) continue;
    console.log(`\n===== ${id} 每步耗时 vs 上下文（${steps.length} 步）=====`);
    console.log('  上下文区间      步数   步耗时中位   输出中位   每1k输出耗时   上下文中位');
    for (let i = 0; i < EDGES.length - 1; i++) {
      const g = steps.filter((s) => s.ctx >= EDGES[i] && s.ctx < EDGES[i + 1]);
      if (!g.length) continue;
      const label = `${EDGES[i] / 1000}k-${EDGES[i + 1] === Infinity ? '∞' : EDGES[i + 1] / 1000 + 'k'}`;
      const per1k = median(g.map((s) => (s.out > 0 ? (s.ms / s.out) * 1000 : 0)));
      console.log(`  ${label.padEnd(14)}${String(g.length).padStart(5)}${dur(median(g.map((s) => s.ms))).padStart(12)}${String(median(g.map((s) => s.out))).padStart(11)}${(per1k / 1000).toFixed(2).padStart(14)}s${String(Math.round(median(g.map((s) => s.ctx)) / 1000)).padStart(12)}k`);
    }
    console.log(comps.length
      ? `  压缩停顿：${comps.length} 次，中位 ${dur(median(comps))}，最长 ${dur(Math.max(...comps))}，合计 ${dur(comps.reduce((a, b) => a + b, 0))}`
      : '  压缩停顿：（无压缩事件）');
  }
  console.log('  ★ 看「每1k输出耗时」那一列：平着 = 上下文还没开始拖慢单步；开始往上翘 = 阈值该停的地方。');
  process.exit(0);
}
for (const ws of fs.readdirSync(ROOT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const wsDir = path.join(ROOT, ws.name);
  for (const sd of fs.readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    const file = path.join(wsDir, sd.name, 'session.v3.jsonl.zstd');
    if (!fs.existsSync(file)) continue;
    const id = sd.name.replace(/^session-/, '').slice(0, 8);
    if (ONLY && !id.startsWith(ONLY)) continue;

    const { text, frames, bytes } = decodeAll(file);
    const s = {
      id, ws: ws.name, frames, kb: Math.round(bytes / 1024),
      turns: 0, steps: 0, usage: zero(), comp: zero(), pruneN: 0, title: zero(),
      first: 0, min: 0, max: 0, sumChars: [], events: [], series: [], warns: 0,
      B: newB(),   // 三类带 usage 的事件都按**自己的 time** 落 idle/peak/unk（见 bucketOf）
    };
    let step = 0, lastCtx = 0;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || t[0] !== '{') continue;
      let o; try { o = JSON.parse(t); } catch { continue; }
      const type = o.type;
      const u = usageOf(o);
      const bk = u ? bucketOf(o.time) : null;   // 该事件的时间桶（是否高峰）

      if (type === 'turn/start') s.turns++;
      else if (type === 'compaction/summary') {
        const chars = longestString(o.data).length;
        if (chars) s.sumChars.push(chars);
        if (o.usage || (o.data && o.data.usage)) { add(s.comp, usageOf(o)); add(s.B[bk], usageOf(o)); }
        s.events.push({ step, kind: 'summary', trigger: lastCtx, post: 0, unc: u ? num(u.inputTokens) : 0, hit: u ? num(u.cacheReadTokens) : 0, out: u ? num(u.outputTokens) : 0, chars });
      } else if (type === 'compaction/prune') {
        s.pruneN++;
        s.events.push({ step, kind: 'prune', trigger: lastCtx, post: 0 });
      } else if (/compaction.*(fail|error)/i.test(type || '')) {
        s.events.push({ step, kind: 'FAILED', trigger: lastCtx, post: 0 });
      }

      if (u && type === 'assistant/message') {
        const ctx = ctxOf(u);
        add(s.usage, u);
        add(s.B[bk], u);
        s.steps++;
        step++;
        if (ctx > 0) {
          if (!s.first) s.first = ctx;
          s.min = s.min ? Math.min(s.min, ctx) : ctx;
          s.max = Math.max(s.max, ctx);
          lastCtx = ctx;
          s.series.push({ step, ctx, unc: num(u.inputTokens), out: num(u.outputTokens), reason: num(u.reasoningTokens), peak: bk === 'peak' });
        }
      } else if (u && type === 'session/title-llm-request') { add(s.title, u); add(s.B[bk], u); }
      if (/estimated tokens >= threshold|not smaller than the shadowed|truncated at the token cap/.test(t)) s.warns++;
    }
    // 压缩点"压完之后的真实地板" = 该事件之后第一条 assistant/message 的上下文
    for (const e of s.events) {
      const after = s.series.find((x) => x.step > e.step);
      e.post = after ? after.ctx : 0;
    }
    const floors = s.events.filter((e) => e.post > 0).map((e) => e.post);
    s.floor = floors.length ? Math.min(...floors) : 0;
    sessions.push(s);
  }
}
if (!sessions.length) {
  console.error(ONLY ? `没有匹配 "${ONLY}" 的会话` : '一个会话都没扫到');
  process.exit(1);
}

const total = { usage: zero(), comp: zero(), title: zero(), steps: 0, turns: 0, compN: 0, pruneN: 0, warns: 0 };
const TB = newB();
for (const s of sessions) {
  sum(total.usage, s.usage); sum(total.comp, s.comp); sum(total.title, s.title);
  sumB(TB, s.B);
  total.steps += s.steps; total.turns += s.turns; total.compN += s.events.filter((e) => e.kind === 'summary').length;
  total.pruneN += s.pruneN; total.warns += s.warns;
}
const grand = zero();
for (const k of ['n', 'unc', 'hit', 'out', 'reason']) grand[k] = total.usage[k] + total.comp[k] + total.title[k];
const TB_ALL = sumBk(TB);   // 三桶并集 —— 应当与 grand 逐位相等（下面会自检）

/** 按**当前口径**把"每桶取哪一块"折成钱：auto = 闲时×1 + 高峰×2（未知桶按闲时并单独列出）。 */
function money(sel) {
  if (BASIS === 'peak') return costT(sel(TB_ALL), PEAK_X);
  if (BASIS === 'idle' || BASIS === 'fixed') return costT(sel(TB_ALL), 1);
  return costT(sel(TB.idle), 1) + costT(sel(TB.peak), PEAK_X) + costT(sel(TB.unk), 1);
}
const SUM = (f) => BUCKETS.reduce((t, b) => t + f(TB[b]), 0);
const splitOf = (sel) => BUCKETS.map((b) => `${b}=${M(sel(TB[b]).unc + sel(TB[b]).hit + sel(TB[b]).out)}`).join('  ');

const BASIS_LABEL = {
  auto: '★ **按事件时间自动区分 闲时 / 高峰**（--basis auto，默认）',
  idle: '★ **全部按闲时价**（--basis idle = 理论下界／最便宜）',
  peak: '★ **全部按高峰价**（--basis peak = 理论上界／最贵）',
  fixed: `★ **全部按固定单价**（--basis fixed${GIVEN.length ? '，来自 --' + GIVEN.join(' / --') : ''}；不区分时段）`,
}[BASIS];
if (!BASIS_LABEL) { console.error(`--basis 只认 ${BASES.join(' / ')}，收到 "${BASIS}"`); process.exit(1); }

console.log(`会话根目录: ${ROOT}`);
console.log(`命中 ${sessions.length} 个会话 / 工作区 ${new Set(sessions.map((s) => s.ws)).size} 个`);
console.log('价格口径：**官方真实价目** `deepseek-flash`（= DeepSeek-V4.1-Flash），人民币 / 每 M token（2026-09-10 12:00 起生效）');
console.log('  出处 https://api-docs.deepseek.com/zh-cn/quick_start/pricing');
console.log(`  闲时  缓存命中 ¥${PRICE.hit}/M   缓存未命中 ¥${PRICE.miss}/M   输出 ¥${PRICE.out}/M`);
console.log(`  高峰  缓存命中 ¥${PRICE.hit * PEAK_X}/M   缓存未命中 ¥${PRICE.miss * PEAK_X}/M   输出 ¥${PRICE.out * PEAK_X}/M   （= 闲时 ×${PEAK_X}）`);
console.log('  高峰时段 = 北京时间 周一至周五 09:00–12:00 与 14:00–18:00；其余（夜间 / 周末 / 法定节假日）= 闲时');
console.log(`  ✅ 已识别法定节假日 + 调休上班日（表覆盖：${CN_HOLIDAY_YEARS.join('、')}；来源：国务院办公厅《关于2026年部分节假日安排的通知》）`);
console.log(`  ⚠ 剩余偏差：表外年份（${CN_HOLIDAY_YEARS.join('、')} 之外）仍按「星期 + 钟点」判 ⇒ 那部分若落在节假日会被当成高峰、金额偏高（最多 ×2）`);
console.log(`  ${BASIS_LABEL}\n`);

console.log('===== 合计（= 每一步请求 + 压缩摘要 + 标题生成，都是真账单口径）=====');
console.log(`  请求步数      ${total.steps}   回合 ${total.turns}   平均 ${(total.steps / (total.turns || 1)).toFixed(1)} 步/回合`);
console.log(`  未缓存输入    ${M(grand.unc).padStart(8)}  ${(grand.unc / (grand.unc + grand.hit) * 100).toFixed(1)}% 全价   ${Y(money(BOX.miss))}`);
console.log(`  缓存命中输入  ${M(grand.hit).padStart(8)}  ${(grand.hit / (grand.unc + grand.hit) * 100).toFixed(1)}%       ${Y(money(BOX.hit))}`);
console.log(`  输出          ${M(grand.out).padStart(8)}  （推理 ${M(grand.reason)} = ${(grand.reason / (grand.out || 1) * 100).toFixed(0)}%）   ${Y(money(BOX.out))}（其中推理 ${Y(money(BOX.reason))}）`);
console.log(`  ─────────────────────────────────────────────────`);
console.log(`  合计约        ${Y(money((b) => b))}   （共 ${M(grand.unc + grand.hit + grand.out)} token；口径见上面那行 ★）`);
console.log(`  平均每次请求  ${Math.round((grand.unc + grand.hit) / (total.steps || 1)).toLocaleString()} token 上下文 + ${Math.round(grand.out / (total.steps || 1))} 输出`);
console.log(`  压缩摘要      ${total.compN} 次，占全价输入 ${(total.comp.unc / (grand.unc || 1) * 100).toFixed(0)}%（${M(total.comp.unc)} / ${M(grand.unc)}）、占总成本 ${(costT(total.comp, 1) / (costT(grand, 1) || 1) * 100).toFixed(0)}%`);
console.log(`  修剪事件      ${total.pruneN} 次   压缩告警行 ${total.warns}（>5 且集中在同一会话 ⇒ 疑似压缩风暴）`);

console.log(`\n===== 闲时 / 高峰 分时段账（北京时间，按**事件自己的 time** 判）=====`);
const w = (b) => `  ${b.padEnd(5)}请求${String(TB[b].n).padStart(6)}   未缓存 ${M(TB[b].unc).padStart(8)}   命中 ${M(TB[b].hit).padStart(9)}   输出 ${M(TB[b].out).padStart(7)}(推理 ${M(TB[b].reason)})   该桶折钱 ${Y(costT(TB[b], b === 'peak' ? PEAK_X : 1))}`;
console.log(w('idle')); console.log(w('peak')); console.log(w('unk'));
console.log(`  ─────────────────────────────────────────────────`);
const idleOnly = costT(TB_ALL, 1), peakOnly = costT(TB_ALL, PEAK_X);
console.log(`  本次口径合计  ${Y(money((b) => b))}   ← ${BASIS === 'auto' ? `闲时 ${Y(costT(TB.idle, 1))} + 高峰 ${Y(costT(TB.peak, PEAK_X))} + 未知时段 ${Y(costT(TB.unk, 1))}（未知桶按闲时价兜底）` : BASIS_LABEL.replace(/^★ \*\*|\*\*.*$/g, '')}`);
console.log(`  两种极端     全按闲时 ${Y(idleOnly)}（下界）  ／  全按高峰 ${Y(peakOnly)}（上界）   ⇒ 按时段自动的结果必然夹在两者之间`);
console.log(`  三块分桶     ${splitOf(BOX.hit)} ｜ 未命中 ${splitOf(BOX.miss)} ｜ 输出 ${splitOf(BOX.out)}`);
console.log(`  口径自检     ${['unc', 'hit', 'out', 'reason'].every((f) => Math.abs(TB_ALL[f] - grand[f]) < 1e-6) ? '✅ 分时段三桶合计 == 总账（逐位相等，没有漏桶/丢事件）' : `❌ 分桶合计与总账不符（unc ${TB_ALL.unc} vs ${grand.unc} / hit ${TB_ALL.hit} vs ${grand.hit} / out ${TB_ALL.out} vs ${grand.out}）`}`);
console.log(`  成本结构     命中 ${Y(money(BOX.hit))} = ${(money(BOX.hit) / (money((b) => b) || 1) * 100).toFixed(1)}% ｜ 未命中 ${Y(money(BOX.miss))} = ${(money(BOX.miss) / (money((b) => b) || 1) * 100).toFixed(1)}% ｜ 输出 ${Y(money(BOX.out))} = ${(money(BOX.out) / (money((b) => b) || 1) * 100).toFixed(1)}%（含推理）`);
console.log(`  ★ 单价之比（官方价）：输出 ÷ 命中 = ${PRICE.out} ÷ ${PRICE.hit} = ${(PRICE.out / PRICE.hit).toFixed(0)} 倍；旧假设价只有 3 ÷ 0.05 = 60 倍 ⇒ **输出的相对权重比旧口径更高**，"谁最贵"必须按本行的占比重排，别沿用旧结论。`);
console.log(`  ★ 未知时段（unk）非零 = 有带 usage 的事件没有 time 字段，那部分只能按闲时价兜底 ⇒ 会被低估。`);

const line = (s) => `  ${s.id}  ${String(s.ws).slice(0, 20).padEnd(20)} 步${String(s.steps).padStart(5)} 回合${String(s.turns).padStart(3)}  未缓存 ${M(s.usage.unc).padStart(8)}  缓存 ${M(s.usage.hit).padStart(8)}  输出 ${M(s.usage.out).padStart(7)}(推理${M(s.usage.reason)})  压缩${String(s.events.filter((e) => e.kind === 'summary').length).padStart(3)} 修剪${String(s.pruneN).padStart(3)}  高峰步${String(s.B.peak.n).padStart(4)}  该会话 ${Y(costT(s.B.idle, 1) + costT(s.B.peak, PEAK_X) + costT(s.B.unk, 1))}`;
const show = (title, rows) => {
  console.log(`\n===== ${title} =====`);
  rows.forEach((s) => console.log(line(s)));
};
show(`按「缓存命中输入」排前 ${TOP}（谁在反复重发上下文）`, [...sessions].sort((a, b) => b.usage.hit - a.usage.hit).slice(0, TOP));
show(`按「未缓存输入」排前 ${TOP}（全价输入 = 压缩重放 + 缓存失效）`, [...sessions].sort((a, b) => b.usage.unc - a.usage.unc).slice(0, TOP));
show(`按「输出」排前 ${TOP}（谁在生成，含推理）`, [...sessions].sort((a, b) => b.usage.out - a.usage.out).slice(0, TOP));

console.log(`\n===== 前缀与地板（真实 token）=====`);
console.log('  id        首请求(固定前缀+注入)   压缩后地板   中位上下文   最大上下文   摘要字符(均值)');
for (const s of [...sessions].sort((a, b) => b.steps - a.steps).slice(0, Math.max(TOP, 8))) {
  const avgChars = s.sumChars.length ? Math.round(s.sumChars.reduce((a, b) => a + b, 0) / s.sumChars.length) : 0;
  console.log(`  ${s.id}  ${k(s.first).padStart(17)}  ${k(s.floor).padStart(11)}  ${k(s.series.length ? [...s.series.map((x) => x.ctx)].sort((a, b) => a - b)[Math.floor(s.series.length / 2)] : 0).padStart(11)}  ${k(s.max).padStart(11)}  ${String(avgChars).padStart(12)}`);
}
console.log('  ★ 压缩阈值必须**高于**"压缩后地板"，否则每步都会重试一次压缩（风暴）。');

const big = [...sessions].sort((a, b) => b.steps - a.steps)[0];
console.log(`\n===== 最大会话 ${big.id} 的压缩时间线 =====`);
if (!big.events.length) console.log('  （无压缩事件）');
for (const e of big.events.slice(-40)) {
  const post = e.post ? `→ 压完 ${k(e.post)}（降 ${k(Math.max(0, e.trigger - e.post))}）` : '';
  console.log(e.kind === 'summary'
    ? `  第${String(e.step).padStart(5)}步  摘要  触发时 ${k(e.trigger)} ${post}｜该次调用 未缓存 ${k(e.unc)} + 缓存 ${k(e.hit)} → 输出 ${e.out}${e.chars ? `（摘要 ${e.chars} 字符）` : ''}`
    : `  第${String(e.step).padStart(5)}步  ${e.kind === 'prune' ? '修剪（只剪工具结果，不调模型）' : '压缩失败：' + e.kind}  当时 ${k(e.trigger)} ${post}`);
}
if (big.events.length > 40) console.log(`  …共 ${big.events.length} 条压缩事件`);

if (RECENT > 0) {
  console.log(`\n===== 最大会话 ${big.id} 最近 ${RECENT} 步 =====`);
  for (const x of big.series.slice(-RECENT)) {
    console.log(`  第${String(x.step).padStart(5)}步  上下文 ${k(x.ctx).padStart(8)}  未缓存 ${k(x.unc).padStart(7)}  输出 ${String(x.out).padStart(5)}（推理 ${String(x.reason).padStart(5)} = ${(x.reason / (x.out || 1) * 100).toFixed(0)}%）`);
  }
  const tail = big.series.slice(-RECENT);
  const a = (f) => Math.round(tail.reduce((t, x) => t + f(x), 0) / (tail.length || 1));
  console.log(`  → 均：上下文 ${a((x) => x.ctx).toLocaleString()}，未缓存 ${a((x) => x.unc).toLocaleString()}，输出 ${a((x) => x.out)}（推理 ${a((x) => x.reason)}）`);
}
