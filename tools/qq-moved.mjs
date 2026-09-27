#!/usr/bin/env node
// ============================================================================
// tools/qq-moved.mjs —— 「QQ 那套不在本机」的 **Node 侧唯一口径**（2026-09-26）
//
// 为什么单独一个文件：这条判据现在有**两个** Node 侧用处 ——
//   ① `tools\self-check.mjs`：本地 SnowLuma 那三个端口本来就该是关的（第三态）；
//   ② `tools\test-self-check-qq-moved.mjs`：反向对照（指着"不存在的标记文件"证明
//      第三态**不会把真停摆一起吞掉**）。
// 口径写两份 ⇒ 迟早一边改一边没改，而这条判据的失效方式恰好是"静默变绿"。
//
// ★ 与 PowerShell 侧**同路径、同语义**：`tools\dsh-prompt.ps1` 的 `Test-QqNotLocal`
//   （`$script:QqMovedFile`，见该文件 L630-647 的注释）。两个"打开方式"里，
//   自检只认 ①（标记文件在）—— 自检答的是"这台机器现在**该**是什么样"，
//   不该跟着某一次启动方式（`DSH_WINDOW_NO_SERVICES=1` 的"只开 DSH"入口）走。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 与 `tools\dsh-prompt.ps1` 里那句 `'qq-bridge\qq-moved-to-server'` **逐字同路径**。 */
export const QQ_MOVED_REL = path.join('qq-bridge', 'qq-moved-to-server');
export const QQ_MOVED_FILE_DEFAULT = path.join(ROOT, QQ_MOVED_REL);

/**
 * 覆盖位**只为可测**而存在（回归网要能指着"不存在的文件"做反向对照）。
 * 生产上没人设它 ⇒ 就是那个标记文件本身；与 PS 侧的 `DSH_WINDOW_QQ_MOVED_FILE` 同惯例。
 */
export function qqMovedFile(env = process.env) {
  const v = env?.DSH_SELFCHECK_QQ_MOVED_FILE;
  return v ? path.resolve(String(v)) : QQ_MOVED_FILE_DEFAULT;
}

/** 标记文件在不在 —— 读不到（权限/竞态）**按"不在"**处理：宁可报红让人来看，也不静默放过。 */
export function qqMovedToServer(env = process.env) {
  try { return fs.existsSync(qqMovedFile(env)); } catch { return false; }
}

/**
 * 端口三态的唯一一处判据。
 *   标记在 + 端口**没听** ⇒ ✅ 预期（本地这只 SnowLuma 是故意不跑的）
 *   标记在 + 端口**在听** ⇒ ❌ **抢号**（2026-09-26 主人把 QQ 搬到服务器；本机起了会抢号）
 *   标记不在             ⇒ 原来的判据（没听就是红）—— 一字不改
 * 为什么第三态不是"把红改绿"：搬走之后**还在听**才是真问题，那一支仍然是 ❌，
 * 只是把"该关的关了"从噪声红里摘出来，让真红显形。
 */
export function judgeQqPort({ name, port, open, qqSide = false, moved = false }) {
  if (qqSide && moved) {
    return open
      ? { ok: false, text: `${name} :${port} 在监听 —— 但标记文件 ${QQ_MOVED_REL} 说 QQ 已迁服务器 ⇒ 本机这只在**抢号**，关掉它（tools\\stop-all.ps1 -OnlySnowLuma）` }
      : { ok: true, text: `${name} :${port} 未监听（QQ 已迁服务器 ${QQ_MOVED_REL}，预期）` };
  }
  return open
    ? { ok: true, text: `${name} :${port} 在监听` }
    : { ok: false, text: `${name} :${port} 没在监听` };
}

/**
 * 第二处同族第三态：「guard 日志里的启动令牌 vs `config.json` 的 `dsh.authToken`」。
 *
 * 为什么会不同步（2026-09-26 协调线判的根因，我按代码复核）：DSH **每次启动都会生成新 token**，
 * 把它同步进 `qq-bridge\config.json` 的 `dsh.authToken` 是 **`tools\start-all.ps1` 的活**；
 * 而「只开 DSH」这条路（`tools\dsh-only.ps1`；原根目录 `只开DSH.cmd` 入口 2026-09-27 已撤除）**故意不跑 start-all**
 * ⇒ 日志里是新 token、`config.json` 里还是上一代的。
 *
 * 本地 QQ 已迁服务器时这**不是故障**：QQ 那套在服务器上跑，本地桥接**不是活路径**
 * （GUI 面板走的是 `state\panel-token`，不是这个 token）⇒ 报 ✅ 并说清为什么。
 * 但**标记不在**时它是真红（那时 devRelay / 审批链就靠 `config.json` 里那个 token，不同步 = 401）。
 *
 * ⚠ 别用"把 token 同步进 config.json"来消这条红：那是往配置里写密钥，而且本地这条路本来就不走
 * （协调线 2026-09-26 明确否掉的做法）。
 */
export function judgeTokenSync({ synced, moved, sourceLabel = '', latestLabel = '', cfgLabel = '' }) {
  if (synced) return { ok: true, text: `令牌同步（${sourceLabel} = config.json）` };
  const detail = `日志 ${latestLabel}… ≠ config.json ${cfgLabel}…`;
  return moved
    ? { ok: true, text: `令牌不同步（**预期**：QQ 已迁服务器 ${QQ_MOVED_REL} ⇒ 本地桥接不是活路径；同步 token 是 tools\\start-all.ps1 的活，而「只开 DSH」入口故意不跑它）—— ${detail}` }
    : { ok: false, text: `令牌不同步：${detail}（跑 tools\\start-all.ps1）` };
}
