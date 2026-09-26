// starting-window.mjs —— **已知启动窗口**的唯一定义处：「刚发起过启动/重启 ⇒ 桥接还没监听不算问题」。
//
// 为什么要有它（2026-09-24 22:19 主人实拍，2026-09-24 晚修）：重启桥接只要 **6 秒**，而 DSH-Web
// 窗口/页面面板在这 6 秒里查一次状态就会看到"桥接控制台没在监听" ⇒ 同一屏上一行还写着
// "3100 掉了会自动拉起来 —— 不用再按 b"，下一行就报"⚠ 桥接断了 ⇒ 按 r（会自动修）"。
// 项目自己的判据：**假警告真正的危害，是让人学会忽略警告。**
//
// 两条硬规矩（改这里之前先读）：
//   ① **"多久算正在起"这个数字只许写在下面这一处**（STARTING_GRACE_SEC）。谁写时间戳谁说了算：
//      发起启动/重启的那两处（win32 = `tools\control.ps1` 的 up / restart 动作分支；linux =
//      `tools\control-driver.mjs` 的执行体）只**盖章**（写一个时间戳），**判定**（算剩几秒、
//      算不算在启动窗口里）只在本文件做 ⇒ 渲染方没有第二份数字。
//   ② 宽限期一过**必须原样回到真故障**（`⚠ 桥接断了` + action=restart）—— 真故障一个字都不许吞。
//      所以判定只看"时间差"，**不加任何"桥接起来了吗"的条件**：起没起来是五灯说了算，不是这里猜。
//
// 盖章文件：`qq-bridge\state\_tmp\starting.json`（`_tmp` = 随时可清 ⇒ **不需要清理逻辑**：
//   文件不在 / 读不了 / 时间戳是脏的，一律当"不在启动窗口里"—— 宁可多报一次真故障，也不假装正常）。
//   幂等覆盖：同一个动作再发起一次就覆盖成新时间戳。形状：
//     { "at": "<本地带偏移的 ISO>", "atMs": <epoch 毫秒>, "action": "up|restart", "what": "启动|重启", "by": "谁盖的" }
//   PS 侧（control.ps1）与 node 侧（本文件、control-driver.mjs）写的是**同一份形状**；
//   读的一侧对缺字段是容错的（atMs 缺失就退回解析 at；都没有 = 不在窗口里）。
//
// 谁读它：`node tools\ops.mjs status --json` 的 `starting` 字段（= 判定结果：active / what /
//   graceLeftSec…），然后 tools\control.ps1（横幅/cmd）与 tools\control-driver.mjs（页面/linux）
//   两个渲染方只读字段、各自只决定文案与 action。
//
// 谁盖这个章（**只有真正发起启动/重启的那几处**，一处都不多）：
//   · win32 控制面：tools\control.ps1 的 up / restart all|dsh|bridge 分支（自己写同一份形状）
//   · win32 主力路径：tools\start-all.ps1（= 一键启动.cmd；清场之后、即将开始起的那一刻）——
//     它**走本文件的 CLI**（`node tools\starting-window.mjs mark up --by=start-all.ps1`），
//     所以 .ps1 侧一个字都不重写形状或秒数
//   · 控制台那个老按钮：qq-bridge\src\bridge.js 的 POST /api/restart（自己写同一份形状）
//   · linux 控制面：tools\control-driver.mjs 跑执行体之前
//   不盖的：restart snowluma / control（不碰桥接）、任何 -DryRun（承诺一个字节都不写）。
//
// CLI（给 .ps1 / 排障用；正常流程里只有 start-all.ps1 调它）：
//   node tools\starting-window.mjs mark <up|restart> [--by=<谁盖的>]   # 盖章（幂等覆盖），0 = 盖上了
//   node tools\starting-window.mjs show                                # 只读：现在算不算在启动窗口里
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** ★★ "多久算正在起"= 45 秒，全项目只写这一处 ★★ */
export const STARTING_GRACE_SEC = 45;

// 会**把桥接带下去**的动作（= 该盖章的那些）：up（start-all.ps1 先清场，桥接要重起一遍）、
// restart（all / dsh 都会掐桥接；bridge 就是它自己）。restart snowluma / control 不碰桥接 ⇒ 不盖。
// ⚠ 这张表与 tools\control.ps1 里那几行 Set-StartingStamp、tools\start-all.ps1 那一处、
//   qq-bridge\src\bridge.js 的 /api/restart **一一对应**（跨语言，没法共享代码）：
//   动一边就动另一边，别只改一处。
const BRIDGE_DOWN_TARGETS = { up: [''], restart: ['', 'all', 'dsh', 'bridge'] };

const ACTION_WORD = { up: '启动', restart: '重启' };

/** 这个动作（+ 子目标）会不会把桥接带下去 ⇒ 发起前该不该盖章。 */
export function isStartingAction(verb, target = '') {
  const list = BRIDGE_DOWN_TARGETS[String(verb ?? '').toLowerCase()];
  if (!list) return false;
  return list.includes(String(target ?? '').toLowerCase());
}

/** 盖章文件（唯一一处拼这个路径）。 */
export function startingFile(root) {
  return path.join(root, 'qq-bridge', 'state', '_tmp', 'starting.json');
}

/** 动作 → 给人看的词（启动 / 重启）；认不出来的一律"启动"（宁可含糊，也不编一个动作名）。 */
export function startingActionWord(action) {
  return ACTION_WORD[String(action ?? '').toLowerCase()] ?? '启动';
}

function localIso(d) {
  // 本地时间 + 偏移（与项目里其它时间戳一个口径：给人看的是本地时间，不是 UTC）
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? '-' : '+';
  const oh = p(Math.floor(Math.abs(off) / 60));
  const om = p(Math.abs(off) % 60);
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${sign}${oh}:${om}`;
}

/**
 * 盖一个启动窗口的章（幂等覆盖）。**只写时间戳，不写宽限期秒数** —— 那个数字是上面那个常量的事。
 * 盖不上章（目录没权限 / 磁盘满）**绝不抛**：它只是个提示用的时间戳，不许拖垮启动本身。
 */
export function markStarting(root, action, { now = Date.now(), by = 'starting-window.mjs' } = {}) {
  const verb = String(action ?? '').toLowerCase();
  const rec = { at: localIso(new Date(now)), atMs: now, action: verb, what: startingActionWord(verb), by: String(by) };
  try {
    const file = startingFile(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
    return rec;
  } catch { return null; }
}

/** 判定结果（**恒定形状**，渲染方只读它）：不在启动窗口里时 active=false、其余为空/0。 */
function inactive(extra = {}) {
  return { active: false, action: '', what: '', at: null, ageSec: null, graceSec: STARTING_GRACE_SEC, graceLeftSec: 0, ...extra };
}

/**
 * 读章并算判定：在宽限期内 ⇒ active=true + graceLeftSec；过期 / 没章 / 脏章 ⇒ active=false。
 * ⚠ 过期**不是错误**，是"该当真故障了"的信号 —— 调用方原样走 `⚠ 桥接断了 + restart`。
 */
export function readStarting(root, now = Date.now()) {
  let rec = null;
  try {
    rec = JSON.parse(fs.readFileSync(startingFile(root), 'utf8').replace(/^\uFEFF/, ''));
  } catch { return inactive(); }
  const raw = rec?.atMs ?? Date.parse(String(rec?.at ?? ''));
  const atMs = Number(raw);
  if (!Number.isFinite(atMs)) return inactive();
  const ageMs = now - atMs;
  const at = typeof rec?.at === 'string' ? rec.at : null;
  // 未来时间戳（时钟回拨 / 手工写错）也当"正在起"：它的 age 是负的，落在窗口内，无害方向。
  if (ageMs >= STARTING_GRACE_SEC * 1000) {
    return inactive({ at, action: String(rec?.action ?? ''), what: startingActionWord(rec?.action), ageSec: Math.floor(ageMs / 1000) });
  }
  return {
    active: true,
    action: String(rec?.action ?? ''),
    what: startingActionWord(rec?.action),
    at,
    ageSec: Math.max(0, Math.floor(ageMs / 1000)),
    graceSec: STARTING_GRACE_SEC,
    graceLeftSec: Math.max(0, Math.ceil((STARTING_GRACE_SEC * 1000 - ageMs) / 1000)),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
// 为什么要有 `mark`：`tools\start-all.ps1`（= 一键启动.cmd，主人的主力路径）也要盖章，而它**不许**
// 在 ps1 里重写形状或那个 45 秒 —— 所以给它一个现成入口（.ps1 只管 `node … mark up --by=…`）。
const USAGE = '用法：node tools\\starting-window.mjs mark <up|restart> [--by=<谁盖的>] ｜ show';

function main(argv) {
  const [sub, ...rest] = argv;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (sub === 'mark') {
    const action = String(rest.find((a) => !a.startsWith('-')) ?? '').toLowerCase();
    const byArg = rest.find((a) => a.startsWith('--by='));
    const by = byArg ? byArg.slice('--by='.length) || 'starting-window.mjs' : 'starting-window.mjs';
    // 动作是**枚举**：认不出来就退出码 2（别默默盖一个"启动"章，那会让排障时看不出是谁盖的）
    if (!Object.prototype.hasOwnProperty.call(ACTION_WORD, action)) {
      process.stderr.write(`[starting-window] 不认识的动作「${action}」（只认 ${Object.keys(ACTION_WORD).join(' | ')}）—— 没盖章\n${USAGE}\n`);
      return 2;
    }
    const rec = markStarting(root, action, { by });
    if (!rec) {
      process.stderr.write(`[starting-window] 盖不上章（_tmp 建不了 / 写不进去）：${startingFile(root)} —— 不影响启动本身\n`);
      return 1;
    }
    process.stdout.write(`已盖启动窗口时间戳：${rec.what}（action=${rec.action}，by=${rec.by}）→ ${startingFile(root)}\n`);
    return 0;
  }
  if (sub === 'show') {
    const s = readStarting(root);
    process.stdout.write(`${JSON.stringify(s)}\n`);
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
