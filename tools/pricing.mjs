// tools\pricing.mjs —— DSH 计价的**唯一一份**口径（账本工具 `tools\usage-report.mjs` 与会话卫生工具
// `tools\sessions.mjs` 共用同一份）。
//
// 为什么单独抽出来（2026-09-25 主人加的需求）：会话卫生要给"每个对话花了多少钱"定档
// （`cost >= 2.5` 先提醒 / `cost >= 8` 强提醒），而账本工具早就在按官方价折算。
// 两个工具各写一份价格**迟早对不上**（账单口径错了会误导主人）⇒ 抽成这一个文件，
// 账本工具改成 import（输出必须一字不变），会话卫生也 import 它。
//
// 官方价（¥/百万 token，闲时）：缓存命中输入 **0.02**、缓存未命中输入 **1**、输出（含推理）**4**；
// 高峰 = 闲时 × 2（官方规则「闲时 = 高峰的一半」，三块同倍率，见 docs\优化清单.md 的对账一节）。
// `mult`：1 = 闲时（会话卫生用的就是它，口径最保守/最便宜），2 = 高峰。

/** 官方**闲时**价（¥/M）：hit = 缓存命中输入、miss = 缓存未命中输入、out = 输出（含推理）。 */
export const DEFAULT_PRICE = { hit: 0.02, miss: 1, out: 4 };

/** 官方规则「闲时 = 高峰的一半」⇒ 高峰 = 闲时 × 2（三块同倍率）。 */
export const PEAK_X = 2;

// ── 闲时 / 高峰的**时段判据**（2026-09-25 从 usage-report.mjs 搬进来：口径只留这一份）──────────
// 官方规则：高峰 = **北京时间** 周一至周五 09:00–12:00 与 14:00–18:00；其余（夜间 / 周末 /
// **法定节假日全天**）= 闲时。⚠ **调休上班的周六/周日要反过来算高峰**（官方通知点名的那几天）。
// 数据来源：国务院办公厅《关于2026年部分节假日安排的通知》（2025-11-04，受权发布）——
//   元旦 1/1–1/3（1/4 周日上班）· 春节 2/15–2/23（2/14、2/28 周六上班）· 清明 4/4–4/6 ·
//   劳动节 5/1–5/5（5/9 周六上班）· 端午 6/19–6/21 · 中秋 9/25–9/27 · 国庆 10/1–10/7（9/20 周日、10/10 周六上班）
// ⚠ **维护**：每年国务院办公厅发通知后，往下面这张表加一年（照抄 off/work 两个数组）；**表外的年份**
//   会回落到"只看星期+钟点"（= 老口径，节假日会被算成高峰、金额偏高）—— 那才是已知偏差。
export const CN_HOLIDAYS = Object.freeze({
  2026: Object.freeze({
    off: Object.freeze([
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07',
    ]),
    work: Object.freeze(['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']),
  }),
});

/** 有节假日表的年份（升序）。表外年份按老口径判 —— 报告里会点名。 */
export const CN_HOLIDAY_YEARS = Object.freeze(Object.keys(CN_HOLIDAYS).map(Number).sort((a, b) => a - b));

const BJ_OFFSET_MS = 8 * 3600e3;
/** 北京时间的那一天（'YYYY-MM-DD'）。time 字段是真 UTC epoch ms ⇒ +8h 再用 UTC 取值就是北京时间。 */
function bjDayKey(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** 工作日的高峰钟点（左闭右开）：09:00–12:00 与 14:00–18:00。 */
function inPeakHours(ms) {
  const d = new Date(ms + BJ_OFFSET_MS);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return (m >= 9 * 60 && m < 12 * 60) || (m >= 14 * 60 && m < 18 * 60);
}

/** 这张表覆盖这一年吗（没有表 = 只能按星期+钟点判）。 */
export function holidayTableCovers(year) { return Object.prototype.hasOwnProperty.call(CN_HOLIDAYS, String(year)); }

/**
 * 某个时刻在不在**高峰**（北京时间）：
 *   ① 表里点名"上班"的周六/周日 ⇒ 按工作日算（调休）；
 *   ② 表里的法定节假日 ⇒ **全天闲时**；
 *   ③ 其余按星期 + 钟点（周末闲时；工作日只算 09:00–12:00 / 14:00–18:00）。
 * 表外年份直接落到 ③（= 老口径，如实偏高）。
 */
export function isPeakBj(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return false;
  const key = bjDayKey(ms);
  const year = Number(key.slice(0, 4));
  const table = CN_HOLIDAYS[year];
  if (table) {
    if (table.work.includes(key)) return inPeakHours(ms);   // 调休上班 —— 反过来算高峰
    if (table.off.includes(key)) return false;              // 法定节假日全天 = 闲时
  }
  const wd = new Date(ms + BJ_OFFSET_MS).getUTCDay();       // 0=周日 6=周六
  if (wd === 0 || wd === 6) return false;
  return inPeakHours(ms);
}


/** 账本里 token 的形状就是这个（usage-report 的 BUCKETS：unc/hit/out）。 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * 三块 token 折钱。`t` 用 `{unc, hit, out}` 命名（账本就是这个形状）；`mult` = 1 闲时 / 2 高峰。
 * ⚠ 运算顺序与 `tools\usage-report.mjs` 原实现**逐字一致**（那是账单工具，输出必须一个字节都不变）。
 */
export function costT(t, mult = 1, price = DEFAULT_PRICE) {
  return (num(t?.unc) * price.miss + num(t?.hit) * price.hit + num(t?.out) * price.out) * mult / 1e6;
}

/**
 * `session/list` 的 `projections.values.tokenUsage` 形状 ⇒ 账本的 `{unc, hit, out}`。
 * 字段名：`uncachedInputTokens` / `cacheReadTokens` / `cacheWriteTokens` / `outputTokens`。
 * `cacheWriteTokens` 本机一直是 0；**按未命中价（miss）算**（写缓存的那部分输入本来就是全价输入）。
 */
export function bucketsOf(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const uncached = num(tokens.uncachedInputTokens);
  const cacheRead = num(tokens.cacheReadTokens);
  const cacheWrite = num(tokens.cacheWriteTokens);
  const output = num(tokens.outputTokens);
  return { unc: uncached + cacheWrite, hit: cacheRead, out: output };
}

/** 四个桶的原始值 + 总量（GUI 右上「Token 用量 N tok」= 未命中 + 命中 + 写缓存 + 输出）。 */
export function tokensOf(tokens) {
  if (!tokens || typeof tokens !== 'object') return null;
  const uncached = num(tokens.uncachedInputTokens);
  const cacheRead = num(tokens.cacheReadTokens);
  const cacheWrite = num(tokens.cacheWriteTokens);
  const output = num(tokens.outputTokens);
  return { uncached, cacheRead, cacheWrite, output, total: uncached + cacheWrite + cacheRead + output };
}

/** `tokenUsage` 投影 ⇒ 花费（¥）；投影缺失 ⇒ **null**（不许当 0：那会把"没数据"说成"不花钱"）。 */
export function costOfTokens(tokens, { mult = 1, price = DEFAULT_PRICE } = {}) {
  const b = bucketsOf(tokens);
  return b === null ? null : costT(b, mult, price);
}

/** 人话金额：¥2.8 / ¥10.12（会话卫生的文案用）。 */
export function yuan(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  return `¥${n >= 10 ? n.toFixed(2) : n.toFixed(1)}`;
}

/** 人话 token 量：63.9M / 512k。 */
export function humanTokens(v) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1000) return Math.round(n / 1000) + 'k';
  return String(n);
}
