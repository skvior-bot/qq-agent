#!/usr/bin/env node
// ============================================================================
// tools/prune-upstream.mjs —— 把本工作区裁剪回「主人现状」的那一步（2026-09-26）
//
// 做什么（范围**只有一条**，故意收得很窄）：
//   删掉**一代扮演模式的 preset 目录** `qq-bridge\dsh\agent-presets\qq-chat\`
//   —— 主人自述里"删掉一代扮演模式"落到的就是这一个目录（`git log` 里那 3 个文件已删，有据）。
//
// ★ 不做什么（同样是硬约束，别扩）：
//   · **不碰 `qq-bridge\public\console.html`** —— 主人说的"页面 UI"是**改**不是删（他改成深色
//     面板式，作者原版浅色五面板，2026-09-26 澄清）；而且删它会**连带打断 4~6 个脚本/回归**
//     （`console-live.mjs` / `test-console.mjs` / `test-console-layout.mjs` /
//     `test-agent-console-gate.mjs` / `tools\bake-layout-template.mjs` / `test-optim-batch.mjs`）。
//   · **不碰 `bridge.js` / `mcp-snowluma-safe.js` / 任何生产代码**。上游代码里**仍保留**一代模式
//     的分支，而本工作区**未使用** —— 主人的现状就是"**preset 没了、代码还在**"，本工具照他
//     现在的样子复现即可，**不去把那 10 处引用清掉**。那 10 处（口径见
//     `qq-bridge\state\_archive\tmp-20260926\report-hammer-prune-inventory.md`，那位已对过账）是：
//       `qq-bridge\src\bridge.js`            9 处（L1886-1887, 1946, 1955, 7617, 7954, 8107, 8937, 12839）
//       `qq-bridge\src\mcp-snowluma-safe.js` 1 处（L530）
//     ⚠ 顺带记住那次对账的教训：`reserved` 的 159 是**行数**（出现 180 次）且**混着 `reserved2`**，
//       真·一代（`\breserved\b`）**只有这 10 处** —— 别拿 159 去估这件事的规模。
//
// 安全设计（四条，都是"改坏了会很难看"的地方）：
//   ① **默认干跑**：不带 `--go` 只打印会删什么，一个字节都不动。
//   ② **改动前备份**：`--go` 先把整棵目录拷到 `backups\pre-prune-upstream-<时间戳>\`（`backups\`
//      已在 `.gitignore`，且本工具**只报数量与字节、绝不回显文件内容**）。
//   ③ **幂等**：目标不在 ⇒ 直接报"已经是目标状态"，退出码 0（**不是**错误）。
//   ④ ★ **fail-closed 护栏**：二代 preset `qq-chat-v2\` **必须在**，否则拒绝动手 —— 因为目标名
//      只差一个 `-v2`，一旦指错目录（或根被指错）就会把**现役** preset 删掉。判据是"精确路径
//      相等"，不做前缀/通配匹配（前缀匹配恰好会把 `qq-chat-v2` 一起吃进去）。
//
// 用法：
//   node tools\prune-upstream.mjs          # 干跑（默认）
//   node tools\prune-upstream.mjs --go     # 真删（先备份）
// 覆盖位（**只为可测**，与 `tools\qq-moved.mjs` 的 `DSH_SELFCHECK_QQ_MOVED_FILE` 同惯例）：
//   DSH_PRUNE_ROOT=<目录>   把"仓库根"换成一个夹具目录 ⇒ 回归网才能造"目标还在"的态。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_ROOT = path.resolve(HERE, '..');

/** 仓库根（覆盖位只为可测；生产上没人设它）。 */
export function pruneRoot(env = process.env) {
  const v = env?.DSH_PRUNE_ROOT;
  return v ? path.resolve(String(v)) : REAL_ROOT;
}

/** 目标 = 一代 preset 目录。**逐字一处**，别在别处再拼一遍。 */
export const TARGET_REL = path.join('qq-bridge', 'dsh', 'agent-presets', 'qq-chat');
/** 现役 preset 目录 —— 它的存在是本工具的 fail-closed 前提。 */
export const KEEP_REL = path.join('qq-bridge', 'dsh', 'agent-presets', 'qq-chat-v2');

/** 递归列出文件（相对路径 + 字节），只读；用于干跑预览与备份核对。 */
export function listTree(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const a = path.join(abs, ent.name);
      const r = rel ? path.join(rel, ent.name) : ent.name;
      if (ent.isDirectory()) walk(a, r);
      else if (ent.isFile()) out.push({ rel: r, size: fs.statSync(a).size });
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return out;
}

export function decide({ root = pruneRoot(), go = false, now = new Date() } = {}) {
  const target = path.join(root, TARGET_REL);
  const keep = path.join(root, KEEP_REL);

  // ★ 护栏 A：不许把现役那棵删掉（目标名只差一个 -v2）。
  if (path.basename(target) !== 'qq-chat' || target === keep) {
    return { action: 'refuse', code: 4, reason: `内部判据异常：目标路径不是一代 preset（${TARGET_REL}）` };
  }
  // ★ 护栏 B：fail-closed —— 现役 preset 不在 ⇒ 多半是根指错了，拒绝动手。
  if (!fs.existsSync(keep)) {
    return {
      action: 'refuse', code: 3, target, keep,
      reason: `二代 preset 不在（${KEEP_REL}）⇒ 拒绝动手：目标名只差一个 "-v2"，指错目录就会删掉**现役** preset`,
    };
  }
  // ③ 幂等：目标本来就不在 ⇒ 已经是目标状态。
  if (!fs.existsSync(target)) {
    return { action: 'noop', code: 0, target, keep };
  }
  const files = listTree(target);
  const bytes = files.reduce((n, f) => n + f.size, 0);
  if (!go) return { action: 'dry-run', code: 0, target, keep, files, bytes };
  return { action: 'prune', code: 0, target, keep, files, bytes, backupDir: backupDirFor(root, now) };
}

/** 备份目录名照 `backups\` 里既有的 `pre-<事>-<YYYYMMDD-HHMMSS>` 惯例。 */
export function backupDirFor(root, now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return path.join(root, 'backups', `pre-prune-upstream-${stamp}`);
}

/** 真删：先备份、再删、再核对。返回收据。 */
export function prune(d) {
  fs.mkdirSync(d.backupDir, { recursive: true });
  const dest = path.join(d.backupDir, path.basename(TARGET_REL));
  fs.cpSync(d.target, dest, { recursive: true });
  const backed = listTree(dest);
  // ★ 备份核对：数量与总字节都要对得上，对不上就不删（宁可留着让人来看）。
  const backedBytes = backed.reduce((n, f) => n + f.size, 0);
  if (backed.length !== d.files.length || backedBytes !== d.bytes) {
    return { ok: false, reason: `备份核对不过：原 ${d.files.length} 文件/${d.bytes} B，备份 ${backed.length} 文件/${backedBytes} B ⇒ 未删除` };
  }
  fs.rmSync(d.target, { recursive: true, force: true });
  if (fs.existsSync(d.target)) return { ok: false, reason: `删除后目标仍在：${d.target}` };
  if (!fs.existsSync(d.keep)) return { ok: false, reason: `⚠ 删完发现现役 preset 不见了：${d.keep}（立即从备份恢复）` };
  return { ok: true, backedCount: backed.length, backedBytes, backupDir: d.backupDir };
}

function main(argv) {
  const go = argv.includes('--go');
  const d = decide({ go });
  const rel = (p) => (p ? path.relative(pruneRoot(), p) || '.' : '');

  console.log('裁剪上游副本 → 复现「主人现状」（只动一代 preset 目录，不碰任何生产代码）');
  console.log(`  目标：${TARGET_REL}${go ? '' : '   【干跑：不带 --go，一个字节都不会动】'}`);

  if (d.action === 'refuse') { console.error(`\n✗ 拒绝执行：${d.reason}`); return d.code; }

  if (d.action === 'noop') {
    console.log('\n✓ 已经是目标状态（一代 preset 目录不在）—— 幂等，什么都不用做。');
    console.log('  说明：上游代码里仍保留一代模式的分支（bridge.js 9 处 + mcp-snowluma-safe.js:530），');
    console.log('        本工作区未使用；本工具**不**去清理它们（主人现状就是"preset 没了、代码还在"）。');
    return 0;
  }

  console.log(`  将删：${d.files.length} 个文件 / ${d.bytes} 字节`);
  for (const f of d.files) console.log(`    · ${f.rel}  ${f.size} B`);
  console.log(`  保留：${KEEP_REL}（现役 preset，一字不动）`);

  if (d.action === 'dry-run') {
    console.log('\n（干跑结束）要真删就加 --go —— 会先备份到 backups\\pre-prune-upstream-<时间戳>\\');
    return 0;
  }

  const r = prune(d);
  if (!r.ok) { console.error(`\n✗ ${r.reason}`); return 5; }
  console.log(`\n✓ 已删除 ${TARGET_REL}`);
  console.log(`  备份：${rel(r.backupDir)}（${r.backedCount} 文件 / ${r.backedBytes} B，核对通过）`);
  console.log('  说明：上游代码里的一代模式分支**保持原样**（10 处：bridge.js 9 + mcp-snowluma-safe.js:530）。');
  return 0;
}

// 只有直接跑才执行（被 import 时不跑 —— 回归网要 import 这些纯函数）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
