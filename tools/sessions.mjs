#!/usr/bin/env node
// tools\sessions.mjs —— 「会话卫生」CLI：status / nudge / archive / new（设计文档 §12）。
//
// 它解决的三件事：
//   ① **步数提醒**：DSH 的 `session/list` 每行都带 `projections.values.sessionStats.steps`（16 张通路都拿不到
//      步数 —— 窗口五灯、控制面板、ops relay 都没有），所以步数只能由这个工具自己读、自己按档产文案。
//      两档阈值：**≥200 先提醒**（越过 p90/贴近 p95），**≥400 强提醒**（样本里这 2 条吃掉全库 22% 的钱）。
//   ② **归档顺手**：`workspace/archiveSession` 语义 = 只隐藏、不删数据（§12.1 实测）。归档只由主人显式触发，
//      永远不自动归档、永远不删。归档后登记本地名单，供「归档即只读历史」护栏（src\session-guard.js）用。
//   ③ **新建顺手**：`workspace/create({path})` → `session/create({workspaceId})` —— **不给 --preset 就不传
//      agentPreset**（GUI 会话该用 DSH 默认 preset；传了反而套上 QQ 的 qq-chat-v2）。
//
// ⚠ 护栏不在这里：**任何"往会话里发消息"的通路都必须先过 `src\session-guard.js` 的
//   `resolveDelivery`/`guardedPrompt`**（DSH 本体不拦归档会话：`session/list` 仍列出它、`session/prompt`
//   照收、而且**没有 unarchive**）。本文件只**产出文案**（`nudge` 不自己投递），并且 `nudge` 跳过已归档会话。
//
// 用法：
//   node tools\sessions.mjs status [--json]
//   node tools\sessions.mjs nudge [--json] [--dry-run] [--ask-owner]
//   node tools\sessions.mjs archive <会话id|唯一前缀> [--yes]
//   node tools\sessions.mjs new [--preset <名字>] [--cwd <路径>]
//   node tools\sessions.mjs rename <会话id|唯一前缀> <新标题|--title-file <路径>>
//        ★ 换线标准动作（主人 2026-09-25：「新开对话记得名字和id都要更新对齐」）：
//        new --preset standard --cwd D:\hobby\DSH →（本命令）改名成该线名字 → 灌交接种子
//        → 台账记「新 id + 名字」→ 通知各线 → 归档旧线。中文标题建议用 --title-file（避免命令行转义踩坑）。
//
// 判据（2026-09-25 主人拍板：「以新开对话的花费和执行任务的花费结合来判断」）：
//   · **相对**：这条"因为长"多付的钱 ÷ 重开一条的实测代价（¥0.031）＝ 够重开几次 ⇒ ≥15 先提醒、≥30 强提醒
//   · **绝对（兜底）**：≥200/≥400 步、≥¥2.5/≥¥8 花费
//   文案把两组数都摆出来，让主人自己判定（谁触发的也写清楚）。
//
// `--ask-owner`：把到档的会话**逐条问给主人**（QQ 私聊确认；他回「归档」后由桥接自动归档 + 开新会话 + 投接续句）。
//
// 测试：`node tools\test-sessions.mjs`（离线：假 api + 临时目录，不连 DSH、不写生产 state）。
// 为此：逻辑全在导出的函数里，**连 DSH 只发生在被直接执行时**（import 本文件不连 DSH、不读 config）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

// 顶部就静态加载共享模块（纯函数库，import 它们不产生副作用、不连 DSH）：
// 这样 CLI 与测试用的是**同一份**判定（护栏绝不能有两份实现）。
const guard = await import(new URL('../qq-bridge/src/session-guard.js', import.meta.url).href);
const stateLib = await import(new URL('../qq-bridge/src/state-lib.js', import.meta.url).href);
// 价格口径的**唯一一份**在 tools\pricing.mjs（与账本工具 tools\usage-report.mjs 共用同一份，免得两处对不上）。
const pricing = await import(new URL('./pricing.mjs', import.meta.url).href);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CFG_FILE = path.join(ROOT, 'qq-bridge', 'config.json');
export const BRIDGE_SESSIONS_FILE = path.join(ROOT, 'qq-bridge', 'state', 'sessions.json');
export const NUDGE_FILE = path.join(ROOT, 'qq-bridge', 'state', 'session-nudge.json');

// ── 阈值与冷却（§12.2 / §12.4 第 10 条；花费口径 2026-09-25 主人加的需求）──────
// 定标数据（2026-09-25 真跑 94 条有步数的会话，官方**闲时**价折算）：
//   花费：中位 ¥0.44 / p75 0.77 / **p90 1.79** / **p95 2.75** / max ¥10.12；全库合计 ≈ ¥72.5
//   步数：中位 56 / p90 186 / p95 243 / max 801
//   两个榜 Top10 重合 9/10 —— 高度重合但彼此补漏：`session-aab1`「小助手」**166 步就 ¥1.92**（步数榜之外），
//   而 200 步那档约合 ¥2.0~2.5 ⇒ 只看步数会漏掉"步数不多但很贵"的对话。
// ⇒ 两档都改成"**步数 或 花费**"任一命中即算（花费阈值取 p95 与"目前唯一那条超"）：
export const TIER1_STEPS = 200;   // 先提醒：步数（越过 p90、贴近 p95）
export const TIER2_STEPS = 400;   // 强提醒：步数（样本里 ≥400 极少）
export const TIER1_COST = 2.5;    // 先提醒：花费 ≈ 全库 p95（¥2.75）
export const TIER2_COST = 8;      // 强提醒：花费（目前只有那条 801 步 / ¥10.12 的会话够）
export const COST_MULT = 1;       // 折钱一律按**闲时**价（最保守/最便宜的一侧；多时段口径见 tools\pricing.mjs）
export const NUDGE_COOLDOWN_MS = 300000; // 同一会话两次提醒之间至少 5 分钟（先例 WatchCooldownMs）

// ── 相对判据：跟"新开一条要多少钱"比（2026-09-25 03:2x 主人拍板）────────────
// 主人原话：「你们归档步数的依据要**以新开对话的花费和执行任务的花费结合来判断**，不能只是以自身为基准」。
//
// ★ `freshCost` = **实测中位 ¥0.031**（不是估的）：由协调会话从 **91 条会话（步数 ≥10）的逐步 usage** 里量出，
//   口径 = 官方**闲时**价 / K = 5 步 / 2026-09-25 03:3x。原始量测（写在这里备查，别再用最早的粗估 ¥0.03）：
//     第一步（纯冷启动，没有缓存可读）        中位 ¥0.0067  区间 ¥0.0054 ~ ¥0.0124
//     前 5 步（新开一条 → 重建上下文 + 把活干起来）中位 **¥0.0308**  区间 ¥0.0137 ~ ¥0.1603  ← **freshCost 就是它**
//     最后 5 步（现在继续往下干）              中位 ¥0.0506  区间 ¥0.0125 ~ ¥0.1745
//     倍率（最后 5 步 ÷ 前 5 步）              中位 1.69×  p90 2.73×  ⇒ "现在继续干"比"重开再干"单步更贵
//   注意：主人专门要这一项（「新开对话之后执行任务的开销也要计算一下」）⇒ 文案里必须把它摆出来。
//
// 其余定标（同一批实测）：继续这条每步（≥50 步会话）命中读取中位 135.4k ⇒ "因为长"¥0.00271/步（p90 ¥0.00459）；
//   真干活（未命中×¥1 + 输出×¥4）中位 ¥0.00484/步。
//   实例：`session-ef4e6b98` 801 步 ¥10.12（因为长 ¥3.86 / 干活 ¥6.25）；本会话 337 步 ¥3.46（¥1.59 / ¥1.86）。
// ratio 阈值：**≥20 先提醒 / ≥45 强提醒**（2026-09-25 二次定标，主人拍板；改的就是这两个常量）。
//   为什么不是 15/30：2026-09-25 真数据里 186~199 步的会话 ratio 已经 26~33（它们的 perStepCtx ≈ ¥0.004~0.005，
//   是 p90 量级而非中位 ¥0.0027）⇒ 15/30 会把"200 步那一批"直接判成**强提醒**，打乱主人已习惯的"先/强"节奏。
//   取 20/45 ≈ 200 步 / 400 步的实测落点 ⇒ 与绝对口径（200/400 步）**大致同批**。
export const FRESH_COST = 0.031;          // 新开一条并重建到能干同样活的实测中位（¥）：91 条 / K=5 / 闲时价
export const FRESH_COST_SOURCE = '实测中位：91 条会话（步数≥10）前 5 步 usage 折闲时价，K=5，2026-09-25 03:3x';
export const COLD_FIRST_STEP_COST = 0.0067; // 第一步（纯冷启动、无缓存可读）实测中位（¥），区间 0.0054~0.0124
export const LAST_FIVE_STEPS_COST = 0.0506; // 最后 5 步（继续往下干）实测中位（¥）——比"重开"贵，主人判定的依据之一
export const REBUILD_RATIO_MEDIAN = 1.69;   // 最后 5 步 ÷ 前 5 步 的实测中位倍率（p90 2.73×）
// ratio 阈值：**≥20 先提醒 / ≥45 强提醒**（2026-09-25 二次定标，主人拍板；要改就改这两个常量）。
//   为什么不是 15/30：2026-09-25 真数据里 186~199 步的会话 ratio 已经 26~33（它们的 perStepCtx ≈ ¥0.004~0.005，
//   是 p90 量级而非中位 ¥0.0027）⇒ 15/30 会把"200 步那一批"直接判成**强提醒**，打乱主人已习惯的"先/强"节奏。
//   取 20/45 ≈ 200 步 / 400 步的实测落点 ⇒ 与绝对口径（200/400 步）**大致同批**。
export const TIER1_RATIO = 20;            // 先提醒：已经够重开 20 次（≈200 步）
export const TIER2_RATIO = 45;            // 强提醒：已经够重开 45 次（≈400 步）

// ── 纯函数：相对判据的四个数 ────────────────────────────────────────────────

/**
 * 相对判据用的"重开代价" —— **实测常量**，不再从清单里估。
 * 为什么不再估：最早用"步数 ≤3 的两条会话"凑出过 ¥0.03，但第一步真值只有 ¥0.0067；协调会话已从 91 条会话的
 * 逐步 usage 量出实测中位（前 5 步 ¥0.0308）⇒ 直接用它，别拿小样本冒充。
 * 仍然把**本地清单里的年轻会话**数出来做交叉核对（`localYoungSample`），但**不**用它改 freshCost。
 * @returns {{freshCost:number, source:string, coldFirstStep:number, lastFiveSteps:number, rebuildRatioMedian:number, localYoungSample:number}}
 */
export function estimateFleet(rows, { youngMax = 5 } = {}) {
  const localYoungSample = (rows ?? []).filter((r) => r && !r.blank && Number.isFinite(r.steps)
    && r.steps >= 1 && r.steps <= youngMax && r.tokens && r.tokens.total > 0).length;
  return {
    freshCost: FRESH_COST,
    source: FRESH_COST_SOURCE,
    coldFirstStep: COLD_FIRST_STEP_COST,
    lastFiveSteps: LAST_FIVE_STEPS_COST,
    rebuildRatioMedian: REBUILD_RATIO_MEDIAN,
    localYoungSample,
  };
}

/**
 * 给一条会话行补上四个数（+ ratio）+ 这条工作线的钱。**缺数据一律 null，绝不当 0**：
 *   `perStepCtx`     继续一步"因为长"的钱 = 命中读取/步 × ¥0.02/M
 *   `perStepTask`    继续一步真干活的钱 = (未命中+写缓存)×¥1/M + 输出×¥4/M，再除以步数
 *   `paidForLength`  这条对话至今**纯粹因为长**多付的钱 = 命中读取总量 × ¥0.02/M
 *   `freshCost`      新开一条并重建到能干同样活的实测中位（常量 ¥0.031）
 *   `ratio`          已经够重开几次 = paidForLength ÷ freshCost
 *   `childCount` / `childCost` / `lineCost`  「这条工作线」：子任务数 / 子任务的钱合计 / 自己 + 子任务
 * 没有 tokenUsage ⇒ 前三个与 ratio 都是 null（判档退回绝对口径；文案里不许出现"重开"）。
 * ⚠ `childCost` **不混进** `paidForLength` 或 `ratio`（语义不同：后者是"纯因为长而付的拥挤开销"），
 *   这一轮也**不加**任何以 `lineCost` 为条件的判档线 —— 主人要的是"看数再判定"。
 */
export function enrichRow(row, fleet, { costById = new Map() } = {}) {
  const steps = Number.isFinite(row?.steps) && row.steps > 0 ? row.steps : null;
  const t = row?.tokens ?? null;
  const p = pricing.DEFAULT_PRICE;
  const perStepCtx = steps && t ? (t.cacheRead / steps) * p.hit / 1e6 : null;
  const perStepTask = steps && t ? ((t.uncached + t.cacheWrite) * p.miss + t.output * p.out) / steps / 1e6 : null;
  const paidForLength = t ? t.cacheRead * p.hit / 1e6 : null;
  const freshCost = fleet?.freshCost ?? FRESH_COST;
  const ratio = paidForLength !== null && freshCost > 0 ? paidForLength / freshCost : null;
  // 子任务：catalog 里的 id 到同一份清单里找行取钱；**找不到的如实跳过**（还没落盘/已清理），不整条 null
  const childIds = Array.isArray(row?.childIds) ? row.childIds : [];
  let childCost = 0;
  let childMissing = 0;
  for (const id of childIds) {
    const c = costById.get(id);
    if (Number.isFinite(c)) childCost += c;
    else childMissing += 1;
  }
  const childCount = childIds.length;
  const lineCost = row?.cost === null || row?.cost === undefined ? null : row.cost + childCost;
  return { ...row, perStepCtx, perStepTask, paidForLength, freshCost, ratio, childCount, childCost, childMissing, lineCost };
}

/** 整份清单一次算齐：先估 fleet（重建代价），再逐行补四个数 + 这条线的钱（子任务要回查同一份清单）。 */
export function enrichRows(rows, opts = {}) {
  const fleet = estimateFleet(rows, opts);
  const costById = new Map();
  for (const r of rows ?? []) if (r?.id && Number.isFinite(r.cost)) costById.set(r.id, r.cost);
  return { rows: (rows ?? []).map((r) => enrichRow(r, fleet, { costById })), fleet };
}

/**
 * 完整判档（**相对判据优先并列**：ratio / 步数 / 花费，任一命中即算）。
 * @returns {{tier:'nudge'|'strong'|null, trigger:string|null, triggers:string[]}}
 *   `trigger` 是命中的判据用 `+` 连起来（`ratio` / `steps` / `cost` 及其组合）—— 文案与 `--json` 靠它说清是哪条。
 */
export function judgeTier({ steps = null, cost = null, ratio = null } = {}, {
  t1 = TIER1_STEPS, t2 = TIER2_STEPS, c1 = TIER1_COST, c2 = TIER2_COST, r1 = TIER1_RATIO, r2 = TIER2_RATIO,
} = {}) {
  const s = Number.isFinite(Number(steps)) && steps !== null ? Number(steps) : null;
  const c = Number.isFinite(Number(cost)) && cost !== null ? Number(cost) : null; // 投影缺失 = null，**不当 0**
  const r = Number.isFinite(Number(ratio)) && ratio !== null ? Number(ratio) : null;
  const bySteps = pickTier(s, { t1, t2 });
  const byCost = c === null ? null : (c >= c2 ? 'strong' : c >= c1 ? 'nudge' : null);
  const byRatio = r === null ? null : (r >= r2 ? 'strong' : r >= r1 ? 'nudge' : null);
  const triggers = [];
  if (byRatio) triggers.push('ratio');
  if (bySteps) triggers.push('steps');
  if (byCost) triggers.push('cost');
  if (!triggers.length) return { tier: null, trigger: null, triggers: [] };
  const strong = [bySteps, byCost, byRatio].includes('strong');
  return { tier: strong ? 'strong' : 'nudge', trigger: triggers.join('+'), triggers };
}

// ── 纯函数：判档与文案 ──────────────────────────────────────────────────────

/** 步数 ⇒ 档位（null = 不发）。读不到步数（null）一律不发。**只看步数**的那一半判据。 */
export function pickTier(steps, { t1 = TIER1_STEPS, t2 = TIER2_STEPS } = {}) {
  const n = Number(steps);
  if (steps === null || steps === undefined || !Number.isFinite(n) || n < 0) return null;
  if (n >= t2) return 'strong';
  if (n >= t1) return 'nudge';
  return null;
}

export function tierLabel(tier) {
  return tier === 'strong' ? '强提醒' : tier === 'nudge' ? '先提醒' : '不提醒';
}
const money4 = (v) => '¥' + Number(v).toFixed(Number(v) < 0.01 ? 4 : 3);
/** 重开一条的实测中位 ¥0.031 —— 3 位小数才看得出量级。 */
const money3 = (v) => '¥' + Number(v).toFixed(Number(v) < 0.1 ? 3 : 2);

/**
 * 说清**是哪条判据**触发的（主人要靠这些数判定，别让他猜）。
 * 相对判据在前（新口径），绝对口径在后（兜底）。
 */
export function triggerNote({ triggers = [], steps = null, cost = null, ratio = null } = {}) {
  if (!triggers.length) return '';
  const bits = [];
  // ★ 每条判据引用**它自己跨过的那条线**（不能都套总档位的线）：例：ratio 54 把总档位抬成强提醒，
  //   但步数 354 只跨过了 200 —— 写成"步数 354 ≥ 400"就是假话。
  if (triggers.includes('ratio') && ratio !== null) bits.push(`够重开 ${Math.floor(ratio)} 次 ≥ ${ratio >= TIER2_RATIO ? TIER2_RATIO : TIER1_RATIO}`);
  if (triggers.includes('steps') && steps !== null) bits.push(`步数 ${steps} ≥ ${steps >= TIER2_STEPS ? TIER2_STEPS : TIER1_STEPS}`);
  if (triggers.includes('cost') && cost !== null) bits.push(`花费 ${pricing.yuan(cost)} ≥ ${cost >= TIER2_COST ? TIER2_COST : TIER1_COST}`);
  return bits.length ? `［触发：${bits.join('＋')}］` : '';
}

/**
 * 人话文案。⚠ `running=true` 时**不许**说"已结束/可以归档了"（§12.4 第 7 条：步数已经在那了，照发）。
 * 轮数（`turns`）只用来**帮主人和 GUI 那行「N 轮 M 步」对上**：读不到就不显示（不猜、不显示 0 轮）。
 * 金额（`cost`）/ token 量（`tokens.total`）/ 相对数（`paidForLength`/`ratio`/`freshCost`）同理：
 *   **缺一个就整段不显示**，绝不出现"¥0"、"0 tok"、"重开 0 次"。
 * 文案里的"继续每步"用的是**这条会话自己的** `perStepCtx`（拥挤那部分），不拿全局中位冒充。
 */
export function nudgeText({
  steps, turns = null, cost = null, tokens = null, tier, trigger = 'steps', triggers = null,
  running = false, title = '', perStepCtx = null, perStepTask = null, paidForLength = null, freshCost = null, ratio = null,
  childCount = 0, childCost = null, lineCost = null, childRunning = 0,
} = {}) {
  const n = Number(steps) || 0;
  const t = Number.isFinite(Number(turns)) && turns !== null && turns !== undefined ? Number(turns) : null;
  const head = title ? `「${title}」` : '这条对话';
  const tail = running ? '它现在还在跑，等这一轮完了再归档也行。' : '';
  // ★ 「这条线还有子在跑」那半句（2026-09-25 追加）：只在**真有子任务在跑**时出现。
  //   它说的是"别现在动手"，**不是**"可以归档了" —— 与上一行那段 running 的话并存（一个是自己，一个是子任务）。
  const kids = Number(childRunning) > 0 ? Number(childRunning) : 0;
  const kidTail = kids > 0
    ? `${running ? '另外' : '它自己空着，但'}这条线还有 ${kids} 个子任务在跑，等它们也完了再归档 —— `
      + '现在动手会把在飞的活掐掉，新对话还得从头重来一遍（那份 token 白付）。'
    : '';
  const len = t === null ? `${n} 步` : `${n} 步 / ${t} 轮`;
  const money = cost === null || cost === undefined || !Number.isFinite(Number(cost))
    ? ''
    : `约 ${pricing.yuan(Number(cost))}${tokens?.total ? `（${pricing.humanTokens(tokens.total)} tok）` : ''}`;
  const strong = tier === 'strong';
  const why = strong ? '全库最长的那 2%' : '比 90% 的对话都长';
  const whyCost = strong ? '全库最贵的那些' : '比 90% 的对话都贵';
  const advice = strong
    ? '建议现在就按 a 归档它、开一条新的；历史会留着，一个字都不会丢。'
    : '按 a 归档它、开一条新的；历史会留着。';
  // 相对数（主人要判定的那组）：四个数齐了才显示；缺一个就整段不显示
  const hasRel = paidForLength !== null && Number.isFinite(Number(paidForLength))
    && ratio !== null && Number.isFinite(Number(ratio))
    && perStepCtx !== null && Number.isFinite(Number(perStepCtx))
    && freshCost !== null && Number.isFinite(Number(freshCost));
  const rel = hasRel
    ? ` —— 其中"因为长"多付 ${pricing.yuan(Number(paidForLength))}（≈ 重开 ${Math.floor(Number(ratio))} 次）；`
      + `继续每步约 ${money4(Number(perStepCtx))}${perStepTask !== null && Number.isFinite(Number(perStepTask)) ? `（长）+ ${money4(Number(perStepTask))}（干活）` : ''}，`
      + `而重开一条（含把活重新干起来）实测约 ${money3(Number(freshCost))}`
    : '';
  const note = triggerNote({ triggers: triggers ?? String(trigger ?? '').split('+').filter(Boolean), tier, steps: n, cost, ratio });
  // 「这条工作线」的半句：**只在真有子任务时出现**（childCount=0 ⇒ 整段不出现；数缺了也不出现）
  const line = (Number(childCount) > 0 && Number.isFinite(Number(childCost)) && Number.isFinite(Number(lineCost)))
    ? `；这条线一共约 ${pricing.yuan(Number(lineCost))}（自己 ${money ? pricing.yuan(Number(cost)) : '—'} + ${Number(childCount)} 个子任务 ${pricing.yuan(Number(childCost))}）`
    : '';
  // 只有花费/相对判据触发：步数不多但不便宜 —— 必须把这一点说出来（不然主人会以为判错了）
  const costish = trigger === 'cost' || (triggers ?? []).includes('cost');
  if (costish && money && !(triggers ?? []).includes('steps')) {
    return `${head}虽然只有 ${len}，但已经花了 ${money}了（${whyCost}）${rel}${line} —— ${advice}${note}${tail}${kidTail}`;
  }
  if (money) {
    return `${head}已经 ${len}、${money}了（${why}）${rel}${line} —— ${advice}${note}${tail}${kidTail}`;
  }
  return `${head}已经 ${len}了（${why}）${rel}${line} —— ${advice}${note}${tail}${kidTail}`;
}

// ── 纯函数：会话行 ──────────────────────────────────────────────────────────

function parseAt(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return 0;
}

/**
 * `session/list` 的返回 ⇒ 规范化行（步数读不到记 null，**不猜 0**）。
 * ★ **幂等**：喂进来的如果已经是"规范化行"（有 `id`、没有 `sessionId`/`projections`），就只做一次字段归一 ——
 *   2026-09-25 踩过的坑：CLI 的 `listSessions()` 返回的是**已 parse 的行**，`runNudge` 里又 parse 一次 ⇒
 *   那些行没有 `projections.values` ⇒ 步数全 null ⇒ **nudge 永远不触发，而离线测试还是全绿**
 *   （测试喂的是原始信封，真实路径喂的是已 parse 的行 —— 两条路契约不一致）。
 *   现在两种输入都必须能工作，测试两侧都钉住。
 */
export function parseSessionRows(listed) {
  const items = Array.isArray(listed) ? listed : (listed?.items ?? listed?.sessions ?? []);
  if (!Array.isArray(items)) return [];
  const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
  const rows = items.map((s) => {
    // 已经是规范化行 ⇒ 原样归一（别再往下找 projections）
    if (s && typeof s === 'object' && typeof s.id === 'string' && s.sessionId === undefined && s.projections === undefined) {
      return {
        id: s.id,
        steps: num(s.steps),
        turns: num(s.turns ?? null),
        tokens: s.tokens ?? null,
        cost: s.cost ?? null,
        childIds: Array.isArray(s.childIds) ? s.childIds : [],
        running: s.running === true,
        blank: s.blank === true,
        cwd: String(s.cwd ?? ''),
        at: parseAt(s.at),
        title: String(s.title ?? '') || '',
        preset: String(s.preset ?? '') || '',
        subagent: s.subagent ?? null,
      };
    }
    const values = s?.projections?.values ?? {};
    const stats = values?.sessionStats ?? s?.sessionStats ?? {};
    const steps = num(stats?.steps);
    // 轮数（turns）：**只用于显示**，不参与判档 —— 每轮步数中位 40、p10 6.9、p90 96（min 1 / max 180），
    // 子代理 2 轮 237 步 = 118 步/轮、QQ 会话 38 轮 203 步 = 5.3 步/轮 ⇒ 两者都真、但**不能互相换算**。
    // 读不到就 null ⇒ 文案里不显示轮数（不猜、不显示"0 轮"）。
    const turns = num(stats?.turns ?? stats?.rounds ?? values?.turns ?? null);
    // token 用量 / 花费：`projections.values.tokenUsage` **本来就在这一行里**（不多一次 HTTP、不读会话文件），
    // 与 GUI 右上「Token 用量 N tok / 缓存命中 x%」是同一份数据。四个桶 = 未命中 / 命中 / 写缓存 / 输出，
    // total = 四者之和；花费 = (未命中+写缓存)×miss + 命中×hit + 输出×out（写缓存按 miss 价；本机一直是 0），
    // 按**闲时**价折（COST_MULT=1，口径见 tools\pricing.mjs）。
    // ★ 投影缺失 ⇒ `tokens = null` / `cost = null`，**绝不当 0**（那会把"没数据"说成"不花钱"，
    //   进而把一条贵会话判成不贵）。缺了它判档就退回只看步数，文案里也不许出现金额。
    const usage = values?.tokenUsage ?? s?.tokenUsage ?? null;
    const tokens = pricing.tokensOf(usage);
    const cost = pricing.costOfTokens(usage, { mult: COST_MULT });
    // ★ 子任务（"这条工作线"的钱）：父子关系**只在父会话这一行的 `subagentCatalog` 里**
    //   （`[{mode,label,id,createdAt}, …]`，`id` = 子会话 id）。子行自己的 `subagent` 投影**没有父 id**
    //   （只有 mode/label/seq）⇒ 别往那个方向找父子关系。子任务的钱**这一轮只显示、不进判档**
    //   （语义不同：`paidForLength` 是"纯因为长而付的拥挤开销"，子任务的钱多半是"干活"）。
    const catalog = values?.subagentCatalog ?? s?.subagentCatalog ?? null;
    const childIds = Array.isArray(catalog)
      ? catalog.map((c) => String(c?.id ?? '')).filter(Boolean)
      : [];
    // ★ `subagent` 非 null = 这一行是**子代理会话**（harness 建的，title 常常是提示词原文）。
    //   2026-09-25 实测：只按 `updatedAt` 取最新会选中正在跑的子代理会话（差点让主人按 a 归档掉它），
    //   所以挑"当前会话"时必须**第一步**就把它排掉；nudge 的候选集也一律排除它。
    const subagent = values?.subagent ?? s?.subagent ?? null;
    return {
      id: String(s?.sessionId ?? s?.id ?? ''),
      steps,
      turns,
      tokens,
      cost,
      childIds,
      running: s?.running === true,
      blank: s?.blank === true,
      cwd: String(s?.cwd ?? ''),
      at: parseAt(s?.updatedAt ?? s?.lastActivityAt),
      title: String(values?.title ?? s?.title ?? '') || '',
      preset: String(values?.agentPreset ?? s?.agentPreset ?? '') || '',
      subagent: subagent && typeof subagent === 'object' ? subagent : null,
    };
  }).filter((s) => s.id);
  return withLineBusy(rows);
}

/**
 * 「这条工作线忙不忙」（2026-09-25 追加；主人原话：「归档请求感觉可以等子进程结束再发，不然新对话还要
 * 重新弄，应该会更耗 token 吧」）—— **只从这份清单里已有的行数据派生**：
 *   · 顶层 `running` 每一行都有，而且**随回合结束清掉**（实测同一分钟内 true→false）；
 *   · 父子关系在父行的 `childIds`（= `projections.values.subagentCatalog` 的 id），
 *     子任务会话**就是同一份清单里的行**（带 `subagent` 标记），各自也带 `running`。
 *   ⇒ 「还有没有在跑」= `自己.running || 任一子行.running`，**不需要额外 HTTP、不读会话文件**。
 *
 * 读不到怎么办（**明确写死，别猜**）：
 *   · `childIds` 为空 ⇒ `childRunning = 0`（没有子任务，就没有"子任务在跑"这回事）；
 *   · catalog 给了 id 但**清单里没有这一行** ⇒ **不计入在跑**（清单里没有 = 这条会话已经不在了，
 *     不可能还在跑），但如实记进 `childRunningUnknown`（`--json` 里看得见，不静默吞掉）。
 * 派生字段：`childRunning`（在跑的子任务**条数**）、`childRunningUnknown`、`lineRunning`（自己或子任务在跑）。
 * ★ 幂等：整份清单一起算，喂原始信封或已 parse 的行结果一致（parseSessionRows 的幂等契约不变）。
 */
export function withLineBusy(rows = []) {
  const runningById = new Map();
  for (const r of rows) runningById.set(r.id, r.running === true);
  for (const r of rows) {
    let childRunning = 0;
    let childRunningUnknown = 0;
    for (const id of Array.isArray(r.childIds) ? r.childIds : []) {
      if (!runningById.has(id)) childRunningUnknown += 1;
      else if (runningById.get(id)) childRunning += 1;
    }
    r.childRunning = childRunning;
    r.childRunningUnknown = childRunningUnknown;
    // 「自己空着、但子任务还在跑」也算忙 —— 掐掉它同样是白付一遍在飞的 token
    r.lineRunning = r.running === true || childRunning > 0;
  }
  return rows;
}

export function shortId(id, n = 8) {
  return String(id ?? '').replace(/^session-/, '').slice(0, n);
}

/** 桥接自己建的会话（QQ 会话）：这些不是"主人在 GUI 里正在用的那条"。 */
export function loadBridgeSessionIds({ stateFile = BRIDGE_SESSIONS_FILE, cfgFile = CFG_FILE } = {}) {
  const ids = new Set();
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
    for (const v of Object.values(state?.sessions ?? {})) if (typeof v === 'string' && v) ids.add(v);
  } catch { /* 读不到就少排一类，不影响主判据 */ }
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''));
    const relay = cfg?.socialV2?.devRelay?.sessionId;
    if (typeof relay === 'string' && relay) ids.add(relay);
  } catch { /* 同上 */ }
  return ids;
}

/**
 * 当前会话判据（**三步，顺序有含义**，2026-09-25 实测修正）：
 *   ① 排掉**子代理会话**（`projections.values.subagent` 非 null）—— 它们由 harness 建、`updatedAt` 常常最新，
 *      先按时间取最新会把正在跑的子代理会话选中（真发生过：一个子代理会话被标成"当前会话"）；
 *   ② 排掉桥接自己建的会话（`state\sessions.json` 的映射值 + `socialV2.devRelay.sessionId`）——
 *      devRelay 那条的 cwd 就是工作区根，**光看 cwd 认不出来**，只有 id 排除是权威；
 *   ③ 其余取 `updatedAt` 最大的一条（空会话、已归档的也排掉）。
 * 顺带把"谁被排掉了、为什么"带回去（`--json` 用来一眼看清判据吃了谁）。
 * @returns {{current:object|null, excluded:Array<{id:string, why:string}>, candidates:number, excludedIds:Set<string>}}
 */
export function rankCurrentSession(rows, { excludeIds = new Set(), archivedIds = null } = {}) {
  const excluded = [];
  const cands = [];
  for (const r of rows ?? []) {
    if (r.subagent) { excluded.push({ id: r.id, why: 'subagent' }); continue; }   // ① 最前
    if (excludeIds.has(r.id)) { excluded.push({ id: r.id, why: 'bridge' }); continue; } // ②
    if (r.blank) { excluded.push({ id: r.id, why: 'blank' }); continue; }
    if (archivedIds && guard.isArchived(r.id, archivedIds)) { excluded.push({ id: r.id, why: 'archived' }); continue; }
    cands.push(r);
  }
  cands.sort((a, b) => b.at - a.at);
  return { current: cands[0] ?? null, excluded, candidates: cands.length, excludedIds: new Set(excluded.map((e) => e.id)) };
}

/** 只要那一条（`rankCurrentSession` 的薄封装）。 */
export function findCurrentSession(rows, opts = {}) {
  return rankCurrentSession(rows, opts).current;
}

/** 目标解析：全 id 精确优先，其次唯一前缀（`session-` 前缀可有可无）。**绝不猜**。 */
export function resolveTarget(input, rows) {
  const want = String(input ?? '').trim();
  const list = (rows ?? []).map((r) => ({ ...r, id: String(r?.id ?? r?.sessionId ?? '') }));
  if (!want) return { ok: false, error: '必须显式给会话 id（或唯一前缀）', matches: [] };
  const exact = list.filter((r) => r.id === want);
  if (exact.length === 1) return { ok: true, row: exact[0], matches: exact };
  const bare = want.replace(/^session-/, '');
  const hits = list.filter((r) => r.id.startsWith(want) || r.id.replace(/^session-/, '').startsWith(bare));
  if (hits.length === 1) return { ok: true, row: hits[0], matches: hits };
  if (!hits.length) return { ok: false, error: `找不到会话「${want}」（本机共 ${list.length} 条；可能已被归档/删除）`, matches: [] };
  return { ok: false, error: `前缀「${want}」不唯一，命中 ${hits.length} 条，请写全`, matches: hits };
}

// ── 提醒状态（落盘 = 跨重启不重发；删掉文件 = 会重发，证明真读了盘）──────────

export function loadNudgeState(file = NUDGE_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    const sessions = j?.sessions && typeof j.sessions === 'object' ? j.sessions : {};
    const asks = j?.asks && typeof j.asks === 'object' ? j.asks : {};
    return { version: 1, sessions, asks };
  } catch {
    return { version: 1, sessions: {}, asks: {} };
  }
}

export function saveNudgeState(state, file = NUDGE_FILE) {
  stateLib.atomicWriteJson(file, state);
  return file;
}

function cloneSessions(state) {
  return JSON.parse(JSON.stringify(state?.sessions ?? {}));
}

/** `asks`（归档确认的"问过没"）与 `sessions` 住在同一个状态文件里 —— 改一边时**必须**把另一边带上。 */
function cloneAsks(state) {
  return JSON.parse(JSON.stringify(state?.asks ?? {}));
}

function entryOf(state, id) {
  if (!state.sessions[id] || typeof state.sessions[id] !== 'object') state.sessions[id] = { tiers: {} };
  const e = state.sessions[id];
  if (!e.tiers || typeof e.tiers !== 'object') e.tiers = {};
  return e;
}

function ageOf(iso, now) {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? now - t : Infinity;
}

/**
 * 规划本轮该发什么（**纯函数，不写盘、不投递**）。
 * 候选集（2026-09-25 主人拍板收窄 —— 原来 6 条到档**全是错的目标**：5 条子代理 + 1 条 QQ 侧私聊）：
 *   `非子代理`（`subagent` 非 null 一律排除）+ `非桥接建的会话`（`excludeIds`）+ `非空` + `非归档`
 *   —— 步数阈值对 QQ 会话不合身（QQ 那条 203 步只有 38 轮 / 5.3 步每轮，而中位 40 步/轮），
 *      子代理会话更不是主人能归档的东西（提醒了也没用）。
 * 其余规则：
 * · 同会话同档只发一次（`tiers[tier]` 已存在 ⇒ 跳过；强提醒已发过 ⇒ 什么都不发）；
 * · 先提醒已发、现在 ≥400 ⇒ 强提醒是**升级 = 第 2 条**（唯一允许的第二条）；
 * · 已归档 ⇒ 退役（退出候选，不回写 tiers）；
 * · 读不到步数（null）⇒ 不发（不猜）。
 * ★ **提问闸**（2026-09-25 追加）：`lineRunning`（自己或任一子任务在跑）的会话**这一轮不排它** ——
 *   不进 `sends`（⇒ `commitNudges` 不会写 `tiers`、`runAskOwner` 也不会问 ⇒ **一点额度都不消耗**），
 *   改记进 `deferred`（如实报"还在跑、跑完再问"，**不许静默吞掉**）。这正是主人要的
 *   「等子进程结束再发，不然新对话还要重新弄、更耗 token」：空闲下来的下一个慢节拍会自然重排它。
 *   ⚠ 只影响"提不提醒/问不问"，**不影响窗口状态行那一格**（那一格读的是 `status --json` 的 current）。
 * ★ **已武装**（2026-09-25 晚，新语义）：`armedIds` 里的会话是"主人已经回过「归档」= 已经授权、
 *   桥接那半的轻节拍会在它空闲时**自动归档**"的 —— 这一轮**什么都不做**（不问第二次），只记进 `skipped`
 *   并如实说明原因（主人原话：「我只要说了归档，你完成任务后自动归档就可以不用再问一次了」）。
 *   ⚠ 它**不是**"绕过某道去重"：上一版那条 `refusedBusyIds`（被忙拒 ⇒ 绕过 24h 去重再 POST 一次）
 *   已随"再问一次"整条删除；其余去重（24 小时内不重复打扰、同会话同档只发一次）一个字都没放宽。
 * @returns {{sends:Array, skipped:Array, retired:Array, deferred:Array, excluded:Object}}
 */
export function planNudges({ rows, state, now = Date.now(), cooldownMs = NUDGE_COOLDOWN_MS, thresholds = {}, archivedIds = null, excludeIds = new Set(), armedIds = new Set() } = {}) {
  const sends = [];
  const skipped = [];
  const retired = [];
  const deferred = [];
  const excluded = { subagent: 0, bridge: 0, blank: 0, archived: 0 };
  const seen = new Set();
  // 相对判据要的四个数是**整份清单一起算**的（重开代价是常量，但逐行数要一起补）
  const { rows: enriched, fleet } = enrichRows(rows ?? [], thresholds);
  for (const row of enriched) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    // ① 子代理会话（harness 建的）——主人没法归档它，提醒没意义
    if (row.subagent) { excluded.subagent += 1; continue; }
    // ② 桥接自己建的会话（QQ 群/私聊 + devRelay 绑定那条）——步数阈值对它们不合身
    if (excludeIds.has(row.id)) { excluded.bridge += 1; continue; }
    if (row.blank) { excluded.blank += 1; continue; }
    // ⑥ 已归档/已删 ⇒ 退役、退出候选（只在**本轮真的把它退役**时报一次，避免每轮都重写状态文件）
    if (archivedIds && guard.isArchived(row.id, archivedIds)) {
      excluded.archived += 1;
      if (state?.sessions?.[row.id]?.retiredAt) skipped.push({ sessionId: row.id, reason: '已归档（条目已退役）' });
      else retired.push(row.id);
      continue;
    }
    // 判档 = **相对（够重开几次）／步数／花费** 任一命中，并记下是哪几条触发的
    const { tier, trigger, triggers } = judgeTier({ steps: row.steps, cost: row.cost, ratio: row.ratio }, thresholds);
    if (!tier) {
      if (row.steps === null) skipped.push({ sessionId: row.id, reason: 'steps-unknown（读不到步数，不猜）' });
      continue;
    }
    // ★ 提问闸（在"发过没有"之前判）：这条线还在跑 ⇒ 这一轮**不排它**，但**如实报出来**。
    //   放在 dedup 之前是有意的：忙是**当下的事实**，比"上一档发过没有"更该让人看见；
    //   而它在这里 return 掉 ⇒ 不会写任何戳 ⇒ 空闲下来一定还能再排上（这就是"等跑完再发"）。
    //   `text` = 给窗口/人看的那句人话（走 nudgeText，忙的文案由它补）—— "不许静默吞掉"要有个落点。
    if (row.lineRunning === true) {
      deferred.push({
        sessionId: row.id, shortId: shortId(row.id), why: 'busy',
        selfRunning: row.running === true, childRunning: row.childRunning ?? 0,
        childRunningUnknown: row.childRunningUnknown ?? 0, lineRunning: true,
        steps: row.steps ?? null, tier,
        text: nudgeText({
          steps: row.steps, turns: row.turns ?? null, cost: row.cost ?? null, tokens: row.tokens ?? null,
          tier, trigger, triggers, running: row.running === true, title: row.title,
          perStepCtx: row.perStepCtx, perStepTask: row.perStepTask,
          paidForLength: row.paidForLength, freshCost: row.freshCost, ratio: row.ratio,
          childCount: row.childCount ?? 0, childCost: row.childCost ?? 0, lineCost: row.lineCost ?? null,
          childRunning: row.childRunning ?? 0,
        }),
      });
      continue;
    }
    const rec = state?.sessions?.[row.id];
    // ★ **已武装 ⇒ 这一轮什么都不做**（2026-09-25 晚）：他回过一次「归档」就是一次授权，
    //   桥接那半的轻节拍会在它空闲时自动归档 —— 再问一次纯属重复打扰（他明确「只要一次提示」）。
    //   放在 dedup 之前判是有意的：**已经授权**这个事实比"上一档发过没有"更该让人看见（跳过的理由要说得清）。
    //   ⚠ 只跳"问话"这一个动作：不写任何戳、也不影响别的会话的判定。
    if (armedIds.has(row.id)) {
      skipped.push({ sessionId: row.id, reason: '已授权归档（主人回过「归档」）⇒ 桥接会在它空闲时自动归档，不再重复问' });
      continue;
    }
    if (rec?.tiers?.strong) { skipped.push({ sessionId: row.id, reason: '强提醒已发过' }); continue; }
    if (rec?.tiers?.[tier]) { skipped.push({ sessionId: row.id, reason: `${tierLabel(tier)}已发过` }); continue; }
    // ⑩ 同一会话两次提醒之间至少 cooldownMs（只卡"真发出去过"的；投递失败要下一轮马上重试）
    if (rec?.lastAt && ageOf(rec.lastAt, now) < cooldownMs) {
      skipped.push({ sessionId: row.id, reason: `冷却中（${Math.ceil((cooldownMs - ageOf(rec.lastAt, now)) / 1000)}s 后可发）` });
      continue;
    }
    sends.push({
      sessionId: row.id,
      short: shortId(row.id),
      steps: row.steps,
      turns: row.turns ?? null,
      cost: row.cost ?? null,
      tokens: row.tokens ?? null,
      // ── 相对判据的四个数（+ ratio）：主人要拿它们判定，`--json` 与文案都靠它们 ──
      perStepCtx: row.perStepCtx,
      perStepTask: row.perStepTask,
      paidForLength: row.paidForLength,
      freshCost: row.freshCost,
      ratio: row.ratio,
      // 「这条工作线」：子任务数 / 子任务的钱 / 自己 + 子任务（**只显示，不进判档**）
      childCount: row.childCount ?? 0,
      childCost: row.childCost ?? 0,
      childMissing: row.childMissing ?? 0,
      lineCost: row.lineCost ?? null,
      tier,
      trigger,
      triggers,
      upgrade: tier === 'strong' && Boolean(rec?.tiers?.nudge),
      running: row.running === true,
      // 「这条线忙不忙」的三个字段（2026-09-25 追加，只增不删）：忙的**不该**出现在这里，
      // 带上是为了让人在 JSON 里一眼看出"这一条是空闲着被排上的"，并给下游（窗口）备用。
      childRunning: row.childRunning ?? 0,
      childRunningUnknown: row.childRunningUnknown ?? 0,
      lineRunning: row.lineRunning === true,
      title: row.title,
      text: nudgeText({
        steps: row.steps, turns: row.turns ?? null, cost: row.cost ?? null, tokens: row.tokens ?? null,
        tier, trigger, triggers, running: row.running === true, title: row.title,
        perStepCtx: row.perStepCtx, perStepTask: row.perStepTask,
        paidForLength: row.paidForLength, freshCost: row.freshCost, ratio: row.ratio,
        childCount: row.childCount ?? 0, childCost: row.childCost ?? 0, lineCost: row.lineCost ?? null,
        childRunning: row.childRunning ?? 0,
      }),
    });
  }
  return { sends, skipped, retired, deferred, excluded, fleet };
}

/**
 * 把**投递结果**写进状态（纯函数）。只记真发出去的（`delivered: true`）：
 *   · `delivered:false` ⇒ 只落一条"没发出去"的痕迹（`lastFail`），**不写 tiers**、不加冷却 ⇒ 下一轮重试（第 9 条）。
 */
export function commitNudges(state, results = [], now = Date.now()) {
  const next = { version: 1, sessions: cloneSessions(state), asks: cloneAsks(state) };
  for (const r of results) {
    if (!r?.sessionId) continue;
    const e = entryOf(next, r.sessionId);
    const at = new Date(now).toISOString();
    e.lastAttemptAt = at;
    if (r.delivered) {
      e.tiers[r.tier] = { at, steps: r.steps ?? null, via: r.via ?? 'cli-emit' };
      e.lastAt = at;
      e.lastSteps = r.steps ?? null;
      delete e.lastFail;
    } else {
      e.lastFail = { at, tier: r.tier ?? null, steps: r.steps ?? null, error: String(r.error ?? '投递失败') };
    }
  }
  return next;
}

/** 退役：把已归档的条目在状态里标掉（保留痕迹，别让它们再冒出来）。 */
export function retireInState(state, ids = [], now = Date.now()) {
  if (!ids.length) return state;
  const next = { version: 1, sessions: cloneSessions(state), asks: cloneAsks(state) };
  for (const id of ids) {
    const e = entryOf(next, id);
    e.retiredAt = new Date(now).toISOString();
    e.retiredReason = 'archived';
  }
  return next;
}

/**
 * 跑一轮提醒。
 * @param list    async () => **原始清单**（未 parse 的信封或数组；parseSessionRows 幂等，喂已 parse 的行也行）。
 *                抛错 = **读不到数据**。
 * @param deliver 可选 async (send) => boolean|{delivered}；不传 = 本进程就是"产出方"，产出即视为已送达
 * @param dryRun  true ⇒ 只产文案、**不写盘**（也就不会记"已提醒"）
 * @param write   false ⇒ 不写盘（测试用）
 */
export async function runNudge({
  list,
  stateFile = NUDGE_FILE,
  now = Date.now(),
  cooldownMs = NUDGE_COOLDOWN_MS,
  thresholds = {},
  archivedIds = null,
  excludeIds = new Set(),
  armedIds = new Set(),
  deliver,
  dryRun = false,
  write = true,
  via = 'cli-emit',
} = {}) {
  const state = loadNudgeState(stateFile);
  // ⑧ 读不到数据（DSH 不在线 / list 报错）⇒ 不发、也不记"已提醒"
  let rows;
  try {
    rows = parseSessionRows(await list());
  } catch (error) {
    return {
      ok: false, sends: [], results: [], skipped: [], retired: [], deferred: [], state, wrote: false, dryRun,
      total: 0, stepsKnown: 0, stepsUnknown: 0, excluded: { subagent: 0, bridge: 0, blank: 0, archived: 0 },
      fleet: null, due: false, listError: String(error?.message ?? error),
    };
  }
  const plan = planNudges({ rows, state, now, cooldownMs, thresholds, archivedIds, excludeIds, armedIds });

  // 退役要先落盘（即使本轮没有提醒），否则归档过的旧条目会一直留在状态里
  let next = retireInState(state, plan.retired, now);
  const results = [];
  for (const send of plan.sends) {
    let delivered = true;
    let error = '';
    if (deliver) {
      try {
        const r = await deliver(send);
        delivered = r === true || r?.delivered === true;
        if (!delivered) error = String(r?.error ?? '投递方回报没发出去');
      } catch (e) {
        delivered = false;
        error = String(e?.message ?? e);
      }
    }
    results.push({ sessionId: send.sessionId, tier: send.tier, steps: send.steps, delivered, error, via });
  }
  next = commitNudges(next, results, now);

  const changed = results.length > 0 || plan.retired.length > 0;
  const wrote = Boolean(write && !dryRun && changed);
  if (wrote) saveNudgeState(next, stateFile);
  const stepsUnknown = plan.skipped.filter((s) => s.reason.startsWith('steps-unknown')).length;
  return {
    ok: true,
    // `due` + `sends[i]` 的字段是**给窗口/面板那路消费的契约**（tools\dsh-prompt.ps1）：别改名、别删
    due: plan.sends.length > 0,
    sends: plan.sends.map((s) => ({ ...s, tierLabel: tierLabel(s.tier), shortId: s.short })),
    // ★ 提问闸的产物（只增不删）：这一轮**因为还在跑**而没排上的会话 —— 如实报出来，绝不静默吞掉。
    deferred: plan.deferred,
    results, skipped: plan.skipped, retired: plan.retired, excluded: plan.excluded, fleet: plan.fleet,
    state: wrote ? next : state, wrote, dryRun, listError: null,
    total: rows.length, stepsKnown: rows.length - stepsUnknown, stepsUnknown,
  };
}

// ── 归档 / 新建（可注入假 api，测试用）──────────────────────────────────────

/** 归档前置检查：已归档就别再调 API（幂等），并把原因说清楚。
 *  `ttlMs = 0`（默认）：**每次都读盘** —— Windows 上同毫秒写入的 mtimeMs 不变，时间戳缓存会让"刚归档"被放过。 */
export function archivePrecheck(sessionId, { archivedFile, workspaceFile, ttlMs = 0, now = Date.now() } = {}) {
  const map = guard.loadArchived(archivedFile ?? guard.ARCHIVED_FILE);
  const local = guard.isArchived(sessionId, map);
  const ws = guard.readWorkspaceArchived({ file: workspaceFile ?? guard.WORKSPACE_FILE, ttlMs, now });
  const inWorkspace = guard.isArchived(sessionId, ws.ids);
  return {
    local, inWorkspace, archivedSetFresh: ws.fresh,
    entry: local ? (map.get(sessionId) ?? null) : null,
    alreadyArchived: local || inWorkspace,
  };
}

/** 真归档：`api.workspace.archiveSession` + 登记本地名单。**只由显式指名触发**。 */
export async function runArchive({
  api, sessionId, unwrap = (v) => v, title = '', by = 'tools/sessions.mjs',
  archivedFile, workspaceFile, ttlMs = 0, now = Date.now(),
} = {}) {
  const pre = archivePrecheck(sessionId, { archivedFile, workspaceFile, ttlMs, now });
  if (pre.alreadyArchived) return { archived: false, alreadyArchived: true, sessionId, pre };
  const value = unwrap(await api.workspace.archiveSession({ sessionId }), 'workspace.archiveSession');
  const entry = guard.markArchived(sessionId, { title, by }, archivedFile ?? guard.ARCHIVED_FILE);
  guard.resetGuardCache(); // 下一轮判定必须重新读盘（DSH 刚把 id 写进 archivedSessionIds）
  return { archived: true, alreadyArchived: false, sessionId, entry, value, pre };
}

/** 新建：`workspace/create({path})` → `session/create({workspaceId[, agentPreset]})`。 */
export async function runNew({ api, cwd, preset = null, unwrap = (v) => v } = {}) {
  const wsValue = unwrap(await api.workspace.create({ path: cwd }), 'workspace.create');
  const workspaceId = wsValue?.workspace?.workspaceId ?? wsValue?.workspaceId;
  if (!workspaceId) throw new Error('workspace/create 没返回 workspaceId');
  const params = { workspaceId };
  // ★ 不给 --preset 就**不传** agentPreset：GUI 会话该用 DSH 默认 preset
  if (preset) params.agentPreset = preset;
  const value = unwrap(await api.sessions.create(params), 'session.create');
  const sessionId = value?.sessionId;
  if (!sessionId) throw new Error('session/create 没返回 sessionId');
  return { sessionId, workspaceId, preset: preset ?? null, params };
}

// ── 归档确认（QQ 链路）：把"要不要归档"问给主人 ─────────────────────────────
// 主人选的方案（原话）：「如果要归档可以**通过 QQ 发消息给我，我来确认**；你们自动归档和发送关键词给下一个对话」。
// 契约由协调会话定死（桥接那半另一个代理在做）：
//   POST http://127.0.0.1:3100/api/dev/archive-ask
//   header x-console-token: <qq-bridge\state\console-token 内容，trim 过>
//   body   { sessionId, askText, continuationText, title }
//   回执   { ok:true, askId, shortId, expiresAt } ／ 失败 { ok:false, error }
// 端点会：记一条待确认（TTL 12h）+ 把 askText 发进主人 QQ 私聊；他回「归档」/「归档 <短id>」/「取消」后，
// 桥接自动归档 + 开新对话 + 把 continuationText 投进新会话 + 换 QQ 侧映射 + 回他一句。
// ⚠ 我们**不**自己发 QQ 消息、也不自己归档：只发这一条"请求确认"。
export const ASK_ENDPOINT = 'http://127.0.0.1:3100/api/dev/archive-ask';
export const CONSOLE_TOKEN_FILE = path.join(ROOT, 'qq-bridge', 'state', 'console-token');
export const ASK_TTL_MS = 12 * 3600 * 1000; // 端点侧的待确认 TTL 也是 12h；同一会话在这个窗口内只问一次
/** 桥接那张**待确认单**（`src\archive-lib.js` 的 ARCHIVE_ASK_FILE_NAME）。本文件**只读**它：
 *  看哪几条待确认是"**已武装**"的（主人回过「归档」= 一次授权 ⇒ 桥接会在它空闲时自动归档、不再重问）
 *  —— 那种会话这一轮什么都不做，见 readArmedIds 与 planNudges 里的 armedIds 闸。 */
export const BRIDGE_ASK_FILE = path.join(ROOT, 'qq-bridge', 'state', 'archive-ask.json');

/** 控制台令牌（读不到就空串 ⇒ 调用方**拒发**，如实报错，不猜）。 */
export function readConsoleToken(file = CONSOLE_TOKEN_FILE) {
  try { return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { return ''; }
}

/** 已问过且**还没答复**（TTL 内）⇒ 不重复问；过期或只有失败痕迹 ⇒ 允许再问。 */
export function pendingAsk(state, sessionId, { now = Date.now(), ttlMs = ASK_TTL_MS } = {}) {
  const e = state?.asks?.[sessionId];
  if (!e || e.status !== 'pending' || !Number.isFinite(e.at)) return null;
  return now - e.at < ttlMs ? e : null;
}

/**
 * 桥接那张待确认单里**已武装**（主人回过「归档」= 已经授权、桥接会在它空闲时自动归档）的会话。
 * **只读** `qq-bridge\state\archive-ask.json`。
 *
 * 为什么要有这个读取（2026-09-25 晚，新语义）：主人原话「我只要说了归档，你完成任务后自动归档
 * 就可以不用再问一次了」⇒ 已经武装的会话**这一轮什么都不该做**（别拿"提醒/问话"再去打扰他一次）。
 * 判据与桥接同源：`armedAt`（新字段）或 `refusedBusyAt`（老字段，桥接那半会把它一次性迁进 `armedAt`；
 * 这里两个都认，免得迁移前后行为不一致）。
 * 读不到 / 认不出 ⇒ **空集**（只是不跳过任何会话，绝不误报"已授权"）。
 */
export function readArmedIds({ file = BRIDGE_ASK_FILE, now = Date.now() } = {}) {
  const ids = new Set();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return ids; }
  const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.asks) ? raw.asks : []);
  for (const a of list) {
    const id = String(a?.sessionId ?? '').trim();
    if (!id) continue;
    if (!(Number(a?.armedAt) > 0 || Number(a?.refusedBusyAt) > 0)) continue;
    // 过期的那条桥接会当没发生过（丢弃记录）⇒ 这里也不当它"已授权"。
    const exp = Number(a?.expiresAt) || 0;
    if (exp && exp <= now) continue;
    ids.add(id);
  }
  return ids;
}

/** 记录一次"问过/没问成"（纯函数）。失败**不写 pending** ⇒ 下一轮还会再问。 */
export function markAskResult(state, { sessionId, at = Date.now(), ok, askId = null, shortId = null, title = null, error = null } = {}) {
  const asks = { ...(state?.asks ?? {}) };
  const atIso = new Date(at).toISOString();
  if (ok) asks[sessionId] = { status: 'pending', at, atIso, askId, shortId, title };
  else asks[sessionId] = { ...(asks[sessionId] ?? {}), lastFail: { at, atIso, error: String(error ?? '没发出去') } };
  return { version: 1, sessions: cloneSessions(state), asks };
}

/** 「问话」文案（**要摆数**：主人靠这些数判定）。数缺了就不显示那一段。 */
export function askOwnerText(send = {}) {
  const t = Number.isFinite(Number(send.turns)) && send.turns !== null ? ` / ${Number(send.turns)} 轮` : '';
  const money = send.cost === null || send.cost === undefined ? '' : ` · ${pricing.yuan(send.cost)}`;
  const head = `【归档确认】${send.title ? `「${send.title}」` : '这条对话'}已经 ${send.steps ?? '?'} 步${t}${money}`;
  const rel = (send.paidForLength !== null && send.paidForLength !== undefined && send.ratio !== null && send.ratio !== undefined
    && send.perStepCtx !== null && send.perStepCtx !== undefined && send.freshCost !== null && send.freshCost !== undefined)
    ? `，其中"因为长"多付 ${pricing.yuan(send.paidForLength)}（≈ 够重开 ${Math.floor(Number(send.ratio))} 次）；`
      + `继续每步约 ${money4(Number(send.perStepCtx))}，而重开一条（含把活重新干起来）实测约 ${money3(Number(send.freshCost))}`
    : '';
  return `${head}${rel}。回「归档」我就归档它并开一条新的（回「取消」就这次不动）。`;
}

/** 自动接续句（主人选的）：标题 + 他最后一条消息 + HANDOFF 指针；取不到那句就**整段省略**。 */
export function continuationText({ title = '', lastMessage = null } = {}) {
  const head = `接续「${title || '(无标题)'}」`;
  const quoted = lastMessage ? `：${lastMessage}` : '';
  return `${head}${quoted}；现状与交接见 docs\\HANDOFF.md`;
}

/** DSH 会话日志根（`DSH_HOME` 或 `~\.dsh`，与护栏同一套取法）。 */
export function dshSessionsRoot() {
  return path.join(guard.dshHome(), 'sessions');
}

/**
 * 找某会话的日志文件。**不猜目录命名规则**（实测 `<id>` 与 `session-<id>` 两种都出现过）：
 * 在会话根下两跳查找，两种目录名都试。
 */
export function findSessionLog(sessionId, root = dshSessionsRoot()) {
  const id = String(sessionId ?? '').trim();
  if (!id) return null;
  const bare = id.replace(/^session-/, '');
  const names = id.startsWith('session-') ? [id, bare] : [`session-${id}`, id];
  let workspaces = [];
  try { workspaces = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return null; }
  for (const ws of workspaces) {
    for (const n of names) {
      const p = path.join(root, ws, n, 'session.v3.jsonl.zstd');
      try { if (fs.statSync(p).isFile()) return p; } catch { /* 继续找 */ }
    }
  }
  return null;
}

/** 会话日志是**多帧拼接**的 zstd：逐帧找魔数、各自解压再拼成 JSONL（写法照 tools\usage-report.mjs 的 decodeAll）。 */
export function decodeSessionLog(file, { maxBytes = 32 * 1024 * 1024 } = {}) {
  if (!file) return null;
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.length > maxBytes) buf = buf.subarray(buf.length - maxBytes); // 只要"最后一条消息"，从尾部读就够
  let pos = 0; const chunks = []; let frames = 0;
  while (pos < buf.length - 4) {
    let idx = -1;
    for (let i = pos; i < buf.length - 4; i++) {
      if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) { idx = i; break; }
    }
    if (idx < 0) break;
    try { chunks.push(zlib.zstdDecompressSync(buf.subarray(idx)).toString('utf8')); frames++; pos = idx + 4; }
    catch { pos = idx + 1; }
  }
  return frames ? chunks.join('') : null;
}

/**
 * 会话日志里**主人自己发的**最后一条消息（`user/message` 且 `data.source.kind === 'user'`），截断 200 字。
 * 取不到（日志缺失/解不开/他没有user消息）⇒ **null**，调用方据此省略那句 —— **绝不编**。
 */
export function lastOwnerMessage(file, { maxChars = 200 } = {}) {
  const text = decodeSessionLog(file);
  if (!text) return null;
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== 'user/message') continue;
    if (o?.data?.source?.kind !== 'user') continue; // 注入的（子代理回执/系统提示）不算"他发的"
    const parts = Array.isArray(o.data?.content) ? o.data.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text) : [];
    const s = parts.join('\n').replace(/\s+/g, ' ').trim();
    if (s) found = s;
  }
  if (!found) return null;
  const chars = [...found];
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') + '…' : found;
}

/** 真发：POST 到桥接控制面。**令牌读不到就不发**；连不上/非 2xx ⇒ `{ok:false,error}`（调用方非 0 退出）。 */
export async function postArchiveAsk({
  sessionId, askText, continuationText: cont, title = '', endpoint = ASK_ENDPOINT,
  token, tokenFile = CONSOLE_TOKEN_FILE, timeoutMs = 8000,
} = {}) {
  const tk = token ?? readConsoleToken(tokenFile);
  if (!tk) return { ok: false, error: '读不到控制台令牌（qq-bridge\\state\\console-token）—— 没有发出去。' };
  const body = JSON.stringify({ sessionId, askText, continuationText: cont, title });
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-console-token': tk },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const raw = await res.text();
    let json = null; try { json = JSON.parse(raw); } catch { /* 端点可能回纯文本 */ }
    if (!res.ok) return { ok: false, error: `端点回了 ${res.status}：${raw.slice(0, 200)}（桥接没在跑，或这个端点还没上线）` };
    if (json && json.ok === false) return { ok: false, error: String(json.error ?? '端点回报失败') };
    return { ok: true, receipt: json ?? raw.slice(0, 200) };
  } catch (error) {
    return { ok: false, error: `连不上端点（${endpoint}）：${error?.message ?? error} —— 桥接没在跑，或这个端点还没上线。` };
  }
}

/**
 * 逐条问主人（对本轮到档的会话）。**防重复**：同一会话在 TTL 内已问过且没答复 ⇒ 跳过。
 * ★ 2026-09-25 晚起**没有任何例外**：上一版那条"被忙拒过 ⇒ 绕过这里再问一次"已随"再问一次"整条删除 ——
 *   新语义是"他回过一次「归档」= 一次授权，桥接空闲时自动归档"，**不需要第二次问话**。
 * 失败**不写 pending**（下一轮会再问），并把错误原样带回去（调用方非 0 退出）。
 * @param post 注入点（测试用假 POST）；默认走真 HTTP
 */
export async function runAskOwner({
  sends = [], stateFile = NUDGE_FILE, now = Date.now(), dryRun = false, write = true,
  endpoint = ASK_ENDPOINT, token, tokenFile = CONSOLE_TOKEN_FILE, logRoot = dshSessionsRoot(),
  post = postArchiveAsk, ttlMs = ASK_TTL_MS,
} = {}) {
  let state = loadNudgeState(stateFile);
  const asks = [];
  const skips = [];
  const results = [];
  let wrote = false;
  for (const send of sends) {
    const pending = pendingAsk(state, send.sessionId, { now, ttlMs });
    const logFile = findSessionLog(send.sessionId, logRoot);
    const lastMessage = lastOwnerMessage(logFile);
    const text = askOwnerText(send);
    const cont = continuationText({ title: send.title, lastMessage });
    if (pending) {
      skips.push({ sessionId: send.sessionId, shortId: send.short, reason: `已经问过、还在等他答复（${pending.atIso}，TTL ${Math.round(ttlMs / 3600000)}h）` });
      continue;
    }
    const item = { sessionId: send.sessionId, shortId: send.short, title: send.title ?? '', askText: text, continuationText: cont, lastMessage, logFile };
    if (dryRun) { asks.push({ ...item, dryRun: true }); continue; }
    const r = await post({ sessionId: send.sessionId, askText: text, continuationText: cont, title: send.title ?? '', endpoint, token, tokenFile });
    const ok = r?.ok === true;
    results.push({ sessionId: send.sessionId, shortId: send.short, ok, error: ok ? '' : String(r?.error ?? '没发出去'), receipt: r?.receipt ?? null });
    state = markAskResult(state, { sessionId: send.sessionId, at: now, ok, askId: r?.receipt?.askId ?? null, shortId: send.short, title: send.title ?? null, error: r?.error ?? null });
    asks.push({ ...item, ok, error: ok ? '' : String(r?.error ?? '') });
  }
  // 只有"真问成了/真失败了"才落盘；dry-run 一个字都不写（保持 --dry-run 的语义）
  if (write && !dryRun && results.length > 0) { saveNudgeState(state, stateFile); wrote = true; }
  return { ok: results.every((r) => r.ok), asks, results, skips, wrote, dryRun, failed: results.filter((r) => !r.ok).length };
}

// ── CLI（只在被直接执行时连 DSH）────────────────────────────────────────────

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] ?? d) : d; };
const VALUE_FLAGS = new Set(['--preset', '--cwd']);
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('-')) { if (VALUE_FLAGS.has(a)) i++; continue; }
  positional.push(a);
}
const JSON_OUT = has('--json');
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

function usage(code = 0) {
  console.log(`用法（会话卫生）：
  node tools\\sessions.mjs status [--json]                       列会话：花费 / 步数 / 轮数 / "因为长多付" / 够重开几次（按花费降序）
  node tools\\sessions.mjs nudge [--json] [--dry-run] [--ask-owner]
                                                                按 相对(够重开≥15/≥30) 或 绝对(≥200/≥400 步、≥¥2.5/≥¥8) 产提醒文案
                                                                （不自己投递；--dry-run 不写状态；--ask-owner = 再给主人 QQ 发"归档确认"问话）
  node tools\\sessions.mjs archive <会话id|唯一前缀> [--yes]      归档（只是收起来、不删数据）；**必须显式给 id**
  node tools\\sessions.mjs new [--preset <名字>] [--cwd <路径>]   新建会话（默认不传 agentPreset = 用 DSH 默认 preset）

--ask-owner 走桥接控制面（POST ${ASK_ENDPOINT}，令牌取 qq-bridge\\state\\console-token）：
  端点把问话发进主人 QQ 私聊，他回「归档」/「归档 <短id>」/「取消」后由**桥接**自动归档 + 开新会话 + 投接续句。
  ★ 忙的时候**不问**（2026-09-25 追加）：这条线还有在跑的东西（自己 running，或任一子任务 running）⇒
    这一轮**不进 sends、也不写任何戳**，只记进 --json 的 deferred[]（"还在跑，跑完再问"）；
    空闲下来的下一个慢节拍会自然重排它 —— 这就是"等子进程结束再发"。
  ★ 主人回过「归档」之后**不再问第二次**（2026-09-25 晚，主人："我只要说了归档，你完成任务后自动归档
    就可以不用再问一次了"）：那种会话在桥接那张待确认单上带着 \`armedAt\` = **已武装**，桥接的轻节拍会在它
    空闲时**自动归档**（默认不等静默窗口）⇒ 这一轮把它记进 skipped（理由写明"已授权归档"），一个字都不做。
  ★ 窗口状态行那一格（"本对话 N 步 / ¥N · 建议归档（按 a）"）**不受这些闸影响**：那一格读的是 status
    （带 \`current.armed\` 这个只增不删的字段）。
  同一会话在 12h 内问过且没答复 ⇒ 不重复问；端点连不上/令牌读不到 ⇒ **非 0 退出**，且不写"已问"状态。

归档 = 只读历史：归档后任何通路都不许再往它发消息（护栏见 qq-bridge\\src\\session-guard.js）。`);
  process.exit(code);
}

if (isMain) {
  // 管道被下游提前关掉（`… | Select-Object -First 3`、head 之类）时不要让 node 抛 EPIPE 变成"失败"：
  // 那是**消费者**不看了，不是我们出错（2026-09-25 实测：退出码会变 1，调我们的脚本会误判）。
  process.stdout.on('error', (e) => { if (e?.code === 'EPIPE') process.exit(0); });
  if (has('--help') || has('-h') || argv.length === 0) usage(0);
  const { NodeApiClient, unwrap } = await import(new URL('../qq-bridge/src/dsh-client.js', import.meta.url).href);
  const cfg = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8').replace(/^\uFEFF/, ''));
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken, header: cfg.dsh.authHeader, prefix: cfg.dsh.authPrefix,
  });
  // ★ 退出纪律（照 tools\notify-session.mjs:72-77）：客户端有 WebSocket/keep-alive 句柄，
  //   用过它之后直接 process.exit() 会在 Windows 上打 libuv 断言并把退出码变成 1 ⇒ 只设 exitCode，
  //   让事件循环自己排干；真赖着不走再用【不保活】的兜底定时器强退。
  const done = (code = 0) => { process.exitCode = code; };
  setTimeout(() => process.exit(process.exitCode ?? 0), 4000).unref();

  // ⚠ 这两个名字别混（2026-09-25 的坑）：`fetchSessionList()` 给**原始清单**（喂 runNudge 的 `list`），
  //   `listSessions()` 给**已 parse 的行**（status 直接渲染）。以前 nudge 传的是后者、runNudge 又 parse 一次 ⇒
  //   步数全读不到、永远不触发（离线测试还全绿）。`parseSessionRows` 现在幂等，两路都不会再错配。
  async function fetchSessionList() {
    let listed;
    try { listed = unwrap(await api.sessions.list({}), 'session.list'); } catch (e) {
      listed = await api.sessions.list({}); // 退路：形状偶尔是裸信封
      if (!listed) throw e;
    }
    return listed;
  }
  const listSessions = async () => parseSessionRows(await fetchSessionList());

  /** 归档名单 = DSH 侧（workspace.json 的 archivedSessionIds）∪ 本地名单 */
  function archivedIdSet() {
    const ws = guard.readWorkspaceArchived({});
    return { set: new Set([...ws.raw, ...guard.loadArchived().keys()]), ws };
  }

  const cmd = positional[0] ?? 'status';

  // ★ rename：把某条会话的**标题**改成该工作线的名字。
  //   主人 2026-09-25 定：「新开对话记得名字和 id 都要更新对齐」⇒ 换线时改名与台账同步更新，缺一不可。
  //   中文标题走 `--title-file <路径>`（读 UTF-8 文件），避免命令行把中文转义搞坏（红线 4 同族）。
  if (cmd === 'rename') {
   await (async () => {   // ⚠ 顶层不能 `return`（今天在 .mjs 严格路线下当场抓到）⇒ 包一层 IIFE
    const target = positional[1] ?? '';
    const rest = positional.slice(2);
    let title = '';
    // ⚠ flag 用 val() 读：`positional` 已把 `--xxx` 剥掉，靠 rest[0] 判会拿不到（2026-09-25 实测踩过 ⇒ 标题被设成路径）
    const titleFile = val('--title-file');
    if (titleFile) {
      const p = titleFile;
      if (!p || !fs.existsSync(p)) {
        console.log(`❌ 读不到标题文件：${p ?? '(没给路径)'}`);
        process.exitCode = 1;
        return;
      }
      title = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').trim();
    } else {
      title = rest.join(' ').trim();
    }
    if (!target || !title) {
      console.log('用法：node tools\\sessions.mjs rename <会话id|唯一前缀> <新标题|--title-file <路径>>');
      process.exitCode = 1;
      return;
    }
    const rows = await listSessions();
    const hit = rows.filter((r) => r.id === target || r.id === `session-${target}` || r.id.startsWith(target) || r.id.startsWith(`session-${target}`));
    if (hit.length !== 1) {
      console.log(hit.length === 0 ? `❌ 找不到会话：${target}` : `⚠ 前缀不唯一（${hit.length} 条），请给更长的前缀：${hit.map((r) => r.id.slice(0, 14)).join(' / ')}`);
      process.exitCode = 1;
      return;
    }
    const value = unwrap(await api.sessions.rename({ sessionId: hit[0].id, title }), 'session.rename');
    console.log(`✅ 已改名：${hit[0].id} → 「${title}」`);
    if (value && typeof value === 'object' && 'title' in value) console.log(`   DSH 回执 title=${value.title}`);
    return;
   })();
  }

  if (cmd === 'status') {
    const rows = await listSessions();
    const bridgeIds = loadBridgeSessionIds();
    // ★ **已武装**（2026-09-25 晚）：主人回过「归档」= 一次授权，桥接那半会在它空闲时自动归档、不再重问。
    //   只读那张待确认单（桥接是唯一的写入方），读不到 = 空集 ⇒ 只是少说一句，绝不误报"已授权"。
    const armedIds = readArmedIds();
    const { set: archived, ws } = archivedIdSet();
    const rank = rankCurrentSession(rows, { excludeIds: bridgeIds, archivedIds: archived });
    // 相对判据的四个数要**整份清单一起算**（重开代价是实测常量，但逐行的数在这里补齐）
    const { rows: enriched, fleet } = enrichRows(rows);
    const byId = new Map(enriched.map((r) => [r.id, r]));
    const current = rank.current ? (byId.get(rank.current.id) ?? rank.current) : null;
    // 排序 = **花费降序（同额按步数降序）**（2026-09-25 主人需求）：
    // 这张表要看的是"谁最花钱"；花费读不到的排在最后（不当 0 排前面）。
    const sorted = [...enriched].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || (b.steps ?? -1) - (a.steps ?? -1) || b.at - a.at);
    const costCell = (r) => (r.cost === null || r.cost === undefined ? '      —' : `${pricing.yuan(r.cost).padStart(6)}${r.tokens ? ` / ${pricing.humanTokens(r.tokens.total)} tok` : ''}`);
    // "因为长多付了多少 / 够重开几次 / 继续每步多少钱"：缺数就整格不显示（绝不写 ¥0 或 0 次）
    const relCell = (r) => (r.paidForLength === null || r.paidForLength === undefined
      ? ''
      : `  长付 ${pricing.yuan(r.paidForLength)}${r.ratio === null || r.ratio === undefined ? '' : `（重开 ${r.ratio.toFixed(1)} 次）`}`
        + `${r.perStepCtx === null || r.perStepCtx === undefined ? '' : `  每步 ${money4(r.perStepCtx)}`}`);
    // 「这条工作线」：只在真有子任务时显示（父子关系来自父行的 subagentCatalog）
    const lineCell = (r) => (r.childCount > 0 && Number.isFinite(r.lineCost)
      ? `  这条线 ${pricing.yuan(r.lineCost)}（+${r.childCount} 子 ${pricing.yuan(r.childCost)}${r.childMissing ? `，${r.childMissing} 条找不到` : ''}）`
      : '');
    if (JSON_OUT) {
      // ★ `--json` 契约（tools\dsh-prompt.ps1 那路按它取字段）：**只增不删**。
      //   `ok` / `current` 是给消费方用的稳定字段；`total` / `currentSessionId` / `sessions[]` 保持不动。
      //   每行与 current 都带 `tokens`（四桶 + total）、`cost`（¥，闲时价）与相对判据四个数
      //   （`perStepCtx` / `perStepTask` / `paidForLength` / `freshCost` / `ratio`）；读不到 = null，**不是 0**。
      console.log(JSON.stringify({
        ok: true,
        total: rows.length, currentSessionId: current?.id ?? null, candidates: rank.candidates,
        // current：认不出就是 null（认它要三层排除都过；`turns` 读不到给 null，**不许填 0**）
        current: current ? {
          id: current.id, shortId: shortId(current.id), steps: current.steps, turns: current.turns ?? null,
          tokens: current.tokens ?? null, cost: current.cost ?? null,
          perStepCtx: current.perStepCtx ?? null, perStepTask: current.perStepTask ?? null,
          paidForLength: current.paidForLength ?? null, freshCost: current.freshCost ?? null, ratio: current.ratio ?? null,
          childCount: current.childCount ?? 0, childCost: current.childCost ?? 0, childMissing: current.childMissing ?? 0, lineCost: current.lineCost ?? null,
          running: current.running === true, title: current.title ?? '', preset: current.preset ?? '',
          // ★ 「这条线忙不忙」（2026-09-25 追加，只增不删）：窗口 a 键的软闸按这三个字段判，
          //   **不在 ps1 里另写一套判据**。`childRunningUnknown` = catalog 里的子任务在清单里找不到几条
          //   （读不到 ⇒ 不计入在跑，但要能看见）。
          childRunning: current.childRunning ?? 0, childRunningUnknown: current.childRunningUnknown ?? 0,
          lineRunning: current.lineRunning === true,
          // ★ 「已授权归档」（2026-09-25 晚追加，只增不删）：主人回过「归档」⇒ 桥接空闲时自动归档。
          //   窗口那一格按它写"已授权归档：跑完自动归档"；**判据不在这里算**（判据 = archive-lib 的
          //   isArmedAsk，读的是 qq-bridge\state\archive-ask.json），ps1 里只搬运这个布尔。
          armed: armedIds.has(current.id) === true,
        } : null,
        sort: 'cost-desc,steps-desc',
        freshCostSource: fleet.source,
        freshMeasure: { coldFirstStep: fleet.coldFirstStep, lastFiveSteps: fleet.lastFiveSteps, rebuildRatioMedian: fleet.rebuildRatioMedian, localYoungSample: fleet.localYoungSample },
        archivedCount: ws.raw.length, archivedSetFresh: ws.fresh,
        // 判据吃了谁：why ∈ subagent | bridge | blank | archived（顺序即判据顺序）
        excluded: rank.excluded.map((e) => ({ id: e.id, why: e.why })),
        excludedCounts: rank.excluded.reduce((acc, e) => ({ ...acc, [e.why]: (acc[e.why] ?? 0) + 1 }), {}),
        sessions: sorted.map((r) => ({
          ...r,
          current: r.id === current?.id,
          archived: guard.isArchived(r.id, archived),
          bridge: bridgeIds.has(r.id),
          // 「已授权归档」也逐行给（`current` 那一份是窗口要的；这里给全表，便于人/程序排查）
          armed: armedIds.has(r.id) === true,
        })),
      }, null, 2));
    } else {
      console.log(`共 ${rows.length} 条会话（DSH 归档名单 ${ws.raw.length} 条${ws.fresh ? '' : '，⚠ 读不到 workspace.json'}）｜按**花费降序**排（同额按步数；花费读不到的排最后）：`);
      console.log(`重开一条（含把活重新干起来）实测中位 ${money3(fleet.freshCost)}（${fleet.source}）｜"重开 N 次" = 这条"因为长"多付的钱 ÷ 它\n`);
      for (const r of sorted) {
        const tags = [
          r.id === current?.id ? '← 当前会话' : '',
          guard.isArchived(r.id, archived) ? '已归档' : '',
          r.subagent ? '子代理' : '',
          bridgeIds.has(r.id) ? 'QQ会话' : '',
          r.blank ? '空' : '',
        ].filter(Boolean).join('  ');
        const when = r.at ? new Date(r.at).toLocaleString('zh-CN', { hour12: false }) : '—';
        const steps = r.steps === null ? '   ?' : String(r.steps).padStart(4);
        const turns = r.turns === null || r.turns === undefined ? '' : ` / ${r.turns} 轮`;
        // 忙不忙（2026-09-25 追加）：自己跑着 / 子任务跑着 / 空闲 —— 只在真有子任务在跑时多说那半句。
        const busyCell = r.running ? '跑着' : (r.childRunning > 0 ? `子任务跑着(${r.childRunning})` : '空闲');
        console.log(`  ${shortId(r.id)}  ${steps} 步${turns}  ${costCell(r)}${relCell(r)}${lineCell(r)}  ${busyCell}  ${when}  ${r.title || '(无标题)'}  ${tags}`);
        console.log(`      ${r.id}${r.preset ? '  preset=' + r.preset : ''}`);
      }
      const counts = rank.excluded.reduce((acc, e) => ({ ...acc, [e.why]: (acc[e.why] ?? 0) + 1 }), {});
      console.log(`\n当前会话候选 ${rank.candidates} 条（已排掉：${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('、') || '无'}）`);
      console.log('归档：node tools\\sessions.mjs archive <上面那个 id 或唯一前缀> --yes');
    }
    done(0);
  } else if (cmd === 'nudge') {
    const { set: archived } = archivedIdSet();
    const askOwner = has('--ask-owner');
    // ★ **已武装**（主人回过「归档」= 已经授权、桥接会在它空闲时自动归档）的那几条：这一轮什么都不做，
    //   只在 skipped 里如实说明（新语义下不再"重新 POST 一次去问他"）。只读那张待确认单，读不到就是空集。
    const armedIds = readArmedIds();
    const res = await runNudge({
      list: fetchSessionList, // ★ 原始清单（不能传 listSessions：那是已 parse 的行）
      stateFile: NUDGE_FILE,
      archivedIds: archived,
      excludeIds: loadBridgeSessionIds(), // ★ 候选集收窄：QQ 侧/桥接建的会话不发（步数阈值对它们不合身）
      armedIds,
      dryRun: has('--dry-run'),
    });
    if (res.listError) {
      // ⑧ 读不到数据：不发、也不记"已提醒"
      console.error(`❌ 读不到会话清单（DSH 在不在？${cfg.dsh.baseUrl}）：${res.listError}`);
      console.error('   按纪律：这一轮不发、也不记"已提醒"（一次读失败不能永久静音）。');
      if (JSON_OUT) console.log(JSON.stringify({ ok: false, due: false, error: res.listError, sends: [], total: 0, listError: res.listError, wrote: false }, null, 2));
      done(1);
    } else {
      // ── `--ask-owner`：把到档的会话逐条问给主人（QQ 私聊确认，桥接自动归档+接续）──
      const ask = askOwner
        ? await runAskOwner({ sends: res.sends, stateFile: NUDGE_FILE, dryRun: has('--dry-run') })
        : null;
      const skippedCounts = res.skipped.reduce((acc, s) => ({ ...acc, [s.reason]: (acc[s.reason] ?? 0) + 1 }), {});
      if (JSON_OUT) {
        // skipped 只留**有信息量**的明细（100 条 steps-unknown 倒出来只会刷屏），汇总进 skippedCounts
        console.log(JSON.stringify({
          ...res,
          skipped: res.skipped.filter((s) => !s.reason.startsWith('steps-unknown')),
          skippedCounts,
          ...(ask ? { askOwner: ask, ok: res.ok } : {}),
        }, null, 2));
      } else {
        const ex = res.excluded ?? {};
        console.log(`本轮提醒 ${res.sends.length} 条${res.dryRun ? '（--dry-run：没写状态）' : `（状态：${NUDGE_FILE}）`}｜延后 ${(res.deferred ?? []).length} 条（还在跑）｜退役 ${res.retired.length} 条｜跳过 ${res.skipped.length} 条｜读到步数 ${res.stepsKnown}/${res.total}`);
        console.log(`候选集已排掉：子代理 ${ex.subagent ?? 0}｜QQ/桥接建的 ${ex.bridge ?? 0}｜空 ${ex.blank ?? 0}｜已归档 ${ex.archived ?? 0}`);
        for (const s of res.sends) {
          const why = s.triggers?.length ? `/${s.triggers.join('+')}` : '';
          console.log(`  📣 [${tierLabel(s.tier)}${s.upgrade ? '/升级' : ''}${why}] ${s.short} — ${s.text}`);
        }
        if (!res.sends.length) console.log('  （没有到档的会话）');
        // ★ 提问闸的产物：**如实报出来**（绝不静默吞掉）——"还在跑，跑完再问"。
        for (const d of res.deferred ?? []) {
          const what = d.selfRunning
            ? (d.childRunning > 0 ? `它自己还在跑、还有 ${d.childRunning} 个子任务在跑` : '它自己还在跑')
            : `它自己空着、但还有 ${d.childRunning} 个子任务在跑`;
          console.log(`  ⏸ 延后 ${d.shortId}：${what} ⇒ 这一轮不提醒、也不问主人（不盖章）；跑完了自然再判${d.childRunningUnknown > 0 ? `（另有 ${d.childRunningUnknown} 个子任务在清单里找不到，按不在跑算）` : ''}`);
          if (d.text) console.log(`     到时候会说的话：${d.text}`);
        }
        for (const s of res.skipped) if (!s.reason.startsWith('steps-unknown')) console.log(`  · 跳过 ${shortId(s.sessionId)}：${s.reason}`);
        for (const [reason, n] of Object.entries(skippedCounts)) if (reason.startsWith('steps-unknown')) console.log(`  · 另有 ${n} 条读不到步数（不猜、不发）`);
        if (ask) {
          console.log(`\n── 问主人（QQ 确认链路，端点 ${ASK_ENDPOINT}）──`);
          for (const s of ask.skips) console.log(`  ⏭ 跳过 ${s.shortId}：${s.reason}`);
          for (const a of ask.asks) {
            console.log(`  ${a.dryRun ? '（--dry-run：只打印、没 POST）' : a.ok ? '✅ 已发出问话' : '❌ 没发出去'} ${a.shortId}`);
            console.log(`     问话：${a.askText}`);
            console.log(`     接续句：${a.continuationText}`);
            if (!a.dryRun && !a.ok) console.log(`     原因：${a.error}`);
          }
          if (!ask.asks.length && !ask.skips.length) console.log('  （没有要到档的会话，没发任何问话）');
        }
      }
      // 端点连不上/令牌读不到 ⇒ **非 0 退出**（不许静默当成功）
      if (ask && ask.failed > 0) {
        console.error(`❌ 有 ${ask.failed} 条问话没发出去（桥接没在跑，或 /api/dev/archive-ask 还没上线）—— 没有写"已问"状态，下一轮会重试。`);
        done(1);
      } else {
        done(0);
      }
    }
  } else if (cmd === 'archive') {
    const target = positional[1];
    if (!target) {
      console.error('❌ archive 必须显式给会话 id 或唯一前缀 —— 绝不猜、绝不批量。');
      if (JSON_OUT) console.log(JSON.stringify({ ok: false, archived: null, error: '必须显式给会话 id（或用唯一前缀）' }, null, 2));
      usage(2);
    }
    const rows = await listSessions();
    const hit = resolveTarget(target, rows);
    if (!hit.ok) {
      console.error(`❌ ${hit.error}`);
      for (const m of hit.matches) console.error(`   ${m.id}`);
      if (JSON_OUT) console.log(JSON.stringify({ ok: false, archived: null, error: hit.error, matches: hit.matches.map((m) => m.id) }, null, 2));
      done(1);
    } else {
      const pre = archivePrecheck(hit.row.id);
      if (pre.alreadyArchived) {
        console.log(`这条对话已经归档过了（${pre.local ? '本地名单' : 'DSH 归档名单'}）：${hit.row.id}`);
        console.log('归档即只读历史 —— 要接着聊就用 `node tools\\sessions.mjs new` 开一条新的。');
        if (JSON_OUT) console.log(JSON.stringify({ ok: true, archived: null, shortId: shortId(hit.row.id), steps: hit.row.steps, alreadyArchived: true, sessionId: hit.row.id }, null, 2));
        done(0);
      } else if (!has('--yes')) {
        console.log(`将要归档：${hit.row.id}  ${hit.row.steps ?? '?'} 步  ${hit.row.title || '(无标题)'}`);
        console.log('没有真归档 —— 确认要动手请加 --yes（这条命令只归档你指名的这一条，不自动、不批量）。');
        if (JSON_OUT) console.log(JSON.stringify({ ok: true, archived: null, shortId: shortId(hit.row.id), steps: hit.row.steps, alreadyArchived: false, preview: true, sessionId: hit.row.id }, null, 2));
        done(0);
      } else {
        try {
          const res = await runArchive({ api, sessionId: hit.row.id, unwrap, title: hit.row.title });
          console.log(`✅ 已归档 ${res.sessionId}`);
          console.log('   已归档（只是从列表里收起来，数据没删，也不会再往里面发消息）');
          console.log(`   DSH 侧已登记（workspace.json 的 archivedSessionIds）；本地名单 ${guard.ARCHIVED_FILE}`);
          console.log('   下一步：node tools\\sessions.mjs new   （开一条新的继续聊；历史留着随时能翻）');
          if (JSON_OUT) console.log(JSON.stringify({ ok: true, archived: res.sessionId, shortId: shortId(res.sessionId), steps: hit.row.steps, alreadyArchived: false }, null, 2));
          done(0);
        } catch (error) {
          console.error(`❌ 归档失败：${error?.message ?? error}`);
          if (JSON_OUT) console.log(JSON.stringify({ ok: false, archived: null, error: String(error?.message ?? error), sessionId: hit.row.id }, null, 2));
          done(1);
        }
      }
    }
  } else if (cmd === 'new') {
    const cwd = path.resolve(val('--cwd', ROOT));
    const preset = val('--preset', null);
    try {
      const res = await runNew({ api, cwd, preset, unwrap });
      if (JSON_OUT) console.log(JSON.stringify({ ok: true, ...res, shortId: shortId(res.sessionId) }, null, 2));
      else {
        console.log(`✅ 新会话：${res.sessionId}`);
        console.log(`   工作区：${res.workspaceId}（${cwd}）${preset ? `  preset=${preset}` : '  preset=DSH 默认（没传 agentPreset）'}`);
        console.log('   在页面上按 F5 就能看到它。');
      }
      done(0);
    } catch (error) {
      console.error(`❌ 新建失败：${error?.message ?? error}`);
      if (JSON_OUT) console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }, null, 2));
      done(1);
    }
  } else if (cmd !== 'rename') {   // rename 已在上面那段处理（顶层不能 return ⇒ 走到这里不该再报"不认识"）
    console.error(`❌ 不认识的子命令：${cmd}`);
    usage(2);
  }
}
