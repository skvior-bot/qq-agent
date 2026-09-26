#!/usr/bin/env node
// ============================================================================
// tools/test-prune-upstream.mjs —— `prune-upstream.mjs` 的回归网（2026-09-26 优化线小锤）
//
// 为什么值得一条网：这个工具**删东西**，而且目标是 `qq-chat`、现役是 `qq-chat-v2` ——
// **名字只差一个 `-v2`**。一次"顺手用前缀匹配 / 指错根"就会把**现役** preset 删掉，
// 而后果（QQ 会话没有可安全使用的 preset ⇒ 拒绝建会话）不一定当场显形。
//
// 钉五件事（每条都有正反两面，别只测顺路）：
//   ① 默认**干跑**：一个字节都不动（目标还在）
//   ② `--go` 真删：目标没了 + **备份额/字节核对通过** + 现役 `qq-chat-v2` **一字未改**（比 hash）
//   ③ **幂等**：再跑一次报"已经是目标状态"，退出码 0（不是错）
//   ④ ★ **fail-closed**：现役 preset 不在 ⇒ **拒绝删**（退 3），目标**还在**
//   ⑤ 真仓库态：在本仓库上跑默认模式 ⇒ `noop`（主人现状就是"preset 没了"）
// 另加源码棘轮：不许碰 `console.html` / 生产代码，目标路径**只有一处**。
//
// 用法：node tools\test-prune-upstream.mjs
// 注意：跑 CLI 一律**文件重定向**而不是管道（受限沙箱里 spawn + pipe 会 EPERM —— 见
//       tools\daily-check.mjs L99-113 与 test-self-check-qq-moved.mjs 的同款处理）。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decide, prune, backupDirFor, TARGET_REL, KEEP_REL, listTree, pruneRoot } from './prune-upstream.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'tools', 'prune-upstream.mjs');

let pass = 0;
let fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  [PASS] ${label} ${extra}`); }
  else { fail += 1; console.log(`  [FAIL] ${label} ${extra}`); }
};
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 12);

/** 造一个夹具根：`qq-bridge\dsh\agent-presets\{qq-chat,qq-chat-v2}` —— 与真仓库同形状。 */
function fixture({ target = true, keep = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prune-upstream-'));
  const presets = path.join(root, 'qq-bridge', 'dsh', 'agent-presets');
  fs.mkdirSync(presets, { recursive: true });
  if (target) {
    fs.mkdirSync(path.join(presets, 'qq-chat', 'nested'), { recursive: true });
    fs.writeFileSync(path.join(presets, 'qq-chat', 'preset.yml'), 'name: 一代扮演模式\nmode: reserved\n');
    fs.writeFileSync(path.join(presets, 'qq-chat', 'nested', 'agent.cordis.yml'), 'x: 1\n');
  }
  if (keep) {
    fs.mkdirSync(path.join(presets, 'qq-chat-v2'), { recursive: true });
    fs.writeFileSync(path.join(presets, 'qq-chat-v2', 'preset.yml'), 'name: 二代仿真\nmode: reserved2\n');
  }
  return root;
}

/** 跑 CLI（文件重定向，不用管道）。 */
function runCli(root, args = []) {
  const out = path.join(os.tmpdir(), `prune-out-${crypto.randomBytes(4).toString('hex')}.log`);
  const fd = fs.openSync(out, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [SCRIPT, ...args], {
      stdio: ['ignore', fd, fd], timeout: 120000, cwd: ROOT,
      env: { ...process.env, DSH_PRUNE_ROOT: root },
    });
  } finally { try { fs.closeSync(fd); } catch {} }
  let text = '';
  try { text = fs.readFileSync(out, 'utf8'); } catch {}
  try { fs.unlinkSync(out); } catch {}
  return { status: r?.status, text };
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 1) 默认干跑：一个字节都不动 ===');
{
  const root = fixture();
  const t = path.join(root, TARGET_REL);
  const keepFile = path.join(root, KEEP_REL, 'preset.yml');
  const before = listTree(t);
  const r = runCli(root, []);
  check('① 干跑退出码 0', r.status === 0, `status=${r.status}`);
  check('① 干跑打屏写明"干跑"', /干跑/.test(r.text));
  check('① ★ 目标**还在**（干跑不许动盘）', fs.existsSync(t) && listTree(t).length === before.length,
    `${listTree(t).length} 文件`);
  check('① 干跑也报清了"将删什么"', before.every((f) => r.text.includes(f.rel)), `${before.length} 个文件名`);
  check('① 现役 preset 被点名"保留"', r.text.includes('保留') && fs.existsSync(keepFile));
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 2) --go 真删：删对了 + 备份核对 + ★ 现役一字未改 ===');
{
  const root = fixture();
  const t = path.join(root, TARGET_REL);
  const keepFile = path.join(root, KEEP_REL, 'preset.yml');
  const keepHashBefore = sha(keepFile);
  const origFiles = listTree(t);
  const origBytes = origFiles.reduce((n, f) => n + f.size, 0);

  const r = runCli(root, ['--go']);
  check('② --go 退出码 0', r.status === 0, `status=${r.status}`);
  check('② ★ 目标已删', !fs.existsSync(t));
  check('② ★ 现役 `qq-chat-v2` **一字未改**（hash 相同）', sha(keepFile) === keepHashBefore, `${keepHashBefore} → ${sha(keepFile)}`);
  check('② 现役目录仍在（没被前缀匹配一起吃进去）', fs.existsSync(path.join(root, KEEP_REL)));

  const bkRoot = path.join(root, 'backups');
  const bks = fs.existsSync(bkRoot) ? fs.readdirSync(bkRoot) : [];
  check('② 备份目录按 `pre-prune-upstream-<时间戳>` 惯例建了 1 个', bks.length === 1 && /^pre-prune-upstream-\d{8}-\d{6}$/.test(bks[0]), bks.join(','));
  const bkTree = bks.length ? listTree(path.join(bkRoot, bks[0], 'qq-chat')) : [];
  check('② ★ 备份内容与原件**逐文件同字节**（文件数 + 总字节都对）',
    bkTree.length === origFiles.length && bkTree.reduce((n, f) => n + f.size, 0) === origBytes,
    `原件 ${origFiles.length}/${origBytes}B vs 备份 ${bkTree.length}/${bkTree.reduce((n, f) => n + f.size, 0)}B`);
  check('② 打屏报了备份路径（可溯源）', /pre-prune-upstream-/.test(r.text) && /核对通过/.test(r.text));
  check('② ★ 打屏**没有回显文件内容**（备份区是敏感目录，只许报数）',
    !/name: 一代扮演模式/.test(r.text) && !/x: 1/.test(r.text));

  // ── ③ 幂等：再来一次 ────────────────────────────────────────────────────
  const r2 = runCli(root, ['--go']);
  check('③ 幂等：第二次退出码 0（不是错）', r2.status === 0, `status=${r2.status}`);
  check('③ 幂等：报"已经是目标状态"', /已经是目标状态/.test(r2.text));
  check('③ 幂等：不重复建备份', fs.readdirSync(bkRoot).length === 1);
  check('③ 幂等：现役仍完好', sha(keepFile) === keepHashBefore);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 3) ★ fail-closed：现役 preset 不在 ⇒ 拒绝动手（反向对照）===');
{
  const root = fixture({ keep: false });
  const t = path.join(root, TARGET_REL);
  const r = runCli(root, ['--go']);
  check('④ 退 3（拒绝，不是静默成功也不是崩溃）', r.status === 3, `status=${r.status}`);
  check('④ ★ 目标**还在**（拒绝就得真的一个字节没删）', fs.existsSync(t), `${listTree(t).length} 文件`);
  check('④ 拒绝理由写清了"指错目录就会删掉现役 preset"', /现役/.test(r.text) && /v2/.test(r.text));
  check('④ 连备份也没建（没走到那一步）', !fs.existsSync(path.join(root, 'backups')));

  // 纯函数面同一条判据（不靠打屏）
  const d = decide({ root, go: true });
  check('④ `decide()` 同口径返回 refuse/code 3', d.action === 'refuse' && d.code === 3);
  fs.rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 4) 真仓库态：主人现状就是 noop（幂等读数）===');
{
  const d = decide({ go: true });     // 用**真** root
  check('⑤ 真仓库上判为 noop（一代 preset 目录已不在）', d.action === 'noop', `action=${d.action}`);
  check('⑤ 真仓库的现役 preset 在（所以护栏没被误触）', fs.existsSync(path.join(pruneRoot(), KEEP_REL)));
  const r = runCli(pruneRoot(), []);
  check('⑤ 真仓库干跑退出码 0 且报"已经是目标状态"', r.status === 0 && /已经是目标状态/.test(r.text), `status=${r.status}`);
  check('⑤ 干跑全程没建备份', !fs.readdirSync(path.join(pruneRoot(), 'backups')).some((n) => /^pre-prune-upstream-\d{8}/.test(n)));
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('=== 5) 源码棘轮：范围只有一代 preset，不许碰生产代码 ===');
{
  const src = fs.readFileSync(SCRIPT, 'utf8');
  // ① 目标路径**只有一处**（口径唯一；别在别处再拼一遍）
  check('⑥ 目标路径只出现一处（`TARGET_REL` 唯一声明）', src.split("export const TARGET_REL =").length === 2);
  check('⑥ 目标末段就是 `qq-chat`（不是 v2）', /'agent-presets', 'qq-chat'\)/.test(src) && !/'agent-presets', 'qq-chat-v2'\);\s*$/.test(src.split('TARGET_REL')[1]?.slice(0, 200) ?? ''));
  // ② 不许出现前缀式匹配（前缀恰好会把 qq-chat-v2 一起吃进去）
  check('⑥ ★ 没有前缀/通配匹配目标（不许 `startsWith(TARGET` / glob）',
    !/startsWith\(\s*TARGET/.test(src) && !/glob/i.test(src));
  // ③ 精确相等护栏在
  check('⑥ ★ 精确相等护栏在（basename 判等 + 目标 ≠ 现役）',
    /path\.basename\(target\) !== 'qq-chat'/.test(src) && /target === keep/.test(src));
  // ④ 不碰 console.html / 不 import 生产代码
  check('⑥ ★ 只读提到 `console.html`（不许有对它写/删的动作）',
    !/(rmSync|unlinkSync|writeFileSync|cpSync)\([^)]*console\.html/.test(src));
  check('⑥ 不 import 桥接/生产模块（只 node: 内置）',
    /^import fs from 'node:fs';$/m.test(src) && /^import path from 'node:path';$/m.test(src)
    && !/from\s+'(?!node:)/.test(src));
  // ⑤ 备份核对必须在删除**之前**（顺序写反 ⇒ 没核对就删了）
  const iVerify = src.indexOf('备份核对不过');
  const iRm = src.indexOf('fs.rmSync(d.target');
  check('⑥ ★ 备份核对排在删除之前（顺序写反=没核对就删）', iVerify > 0 && iRm > iVerify, `核对@${iVerify} < 删@${iRm}`);
  // ⑥ 说明里必须留着"那 10 处引用不动"的话（这是本工具的边界，别被后来人当 TODO 做掉）
  check('⑥ 说明里写清上游仍留 10 处引用且**不动它**', /10 处/.test(src) && /mcp-snowluma-safe\.js/.test(src) && /不\*\*去清理|保持原样/.test(src));
}

console.log(`\n${fail === 0 ? 'ALL OK' : 'FAILED'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
