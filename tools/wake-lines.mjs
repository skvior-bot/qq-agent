#!/usr/bin/env node
// wake-lines —— 启动器把三件套起齐之后，**一次性**把各条开发线叫起来。
//
// 为什么要有它（主人 2026-09-25 原话）：「停机之后要我给你们发消息你们才会动起来，不然就会全部停摆」
//   —— 全量重启会打断在途的回合，各条线（协调 / 优化 / 执行）接着就静静地躺着，等人来戳。
//   所以：起齐 = 主动叫一次。这一条也顺手把"重启窗口里丢掉的投递"补上：被叫起来的线会自己去
//   看留言板 / 收件箱 / 现场读数（全局规则 6 的"先同步再动手"）。
//
// 目标会话**只在 docs\HANDOFF.md 的「会话 id 台账」里取**（不许另存一份名单！）：
//   轮换是常态（今天已经换过好几次），任何抄出来的名单都会在下次轮换后变成"投给已归档的旧 id"
//   —— 那正是全局规则 16/17 说的静默失效。解析口径：
//     · 只认「会话 id 台账」那一节里的表格行；
//     · 取该行**第二格**（"会话 id（当前投递目标）"）里出现的**第一个** session-<uuid>；
//     · 第一格含「历史」或第二格含「全已归档 / 只读」的行跳过（那些是只读历史，投了必被拒）。
//   投递本身走 tools\notify-session.mjs —— 它自己会过「归档即只读历史」护栏（投不进去会非 0 退出）。
//
// 用法：
//   node tools\wake-lines.mjs --stamp 20260925-201500 [--reason "三件套起齐"] [--dry-run] [--force]
//
// 去重：`qq-bridge\state\_tmp\.woke-<stamp>`（stamp 由启动器给 = 这一次启动的时间戳）。
//   ⚠ **故意不用 bootCount**：那是桥接起来之后才写的，启动器收尾时读到的可能还是**上一代**的数字，
//     拿上一代去重会把这一次的唤醒整批吞掉 —— 而"吞掉唤醒"正是这条线要治的病。宁可多叫一次。
// 成本口径：一次唤醒 = 给每条线排一轮（用户手册里的 ¥0.03 量级）。全量重启本来就不频繁，值。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HANDOFF = path.join(ROOT, 'docs', 'HANDOFF.md');
const NOTIFY = path.join(ROOT, 'tools', 'notify-session.mjs');
const TMP = path.join(ROOT, 'qq-bridge', 'state', '_tmp');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const dryRun = has('--dry-run');
const force = has('--force');
const stamp = String(val('--stamp', '') || '').trim() || nowStamp();
const reason = String(val('--reason', '三件套起齐') || '三件套起齐').trim();

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function localTime() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ── 从台账里取各线的当前投递目标 ────────────────────────────────────────────────
export function parseLedger(md) {
  const lines = String(md).split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s*会话 id 台账/.test(l));
  if (start < 0) return { targets: [], why: 'docs\\HANDOFF.md 里找不到「会话 id 台账」那一节' };
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;                 // 下一节开始
    if (!lines[i].startsWith('|')) continue;           // 只认表格行
    const cells = lines[i].split('|').map((c) => c.trim());
    if (cells.length < 4) continue;
    const role = cells[1] ?? '';
    const idCell = cells[2] ?? '';
    if (/^-+$/.test(role.replace(/[\s:-]/g, '')) || /^线 \/ 角色/.test(role)) continue;   // 表头 / 分隔行
    if (/历史|已归档（只读|只读、投不进/.test(role)) continue;
    if (/全已归档|投不进/.test(idCell)) continue;
    const m = idCell.match(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    if (!m) continue;
    rows.push({ role: role.replace(/\*\*/g, '').slice(0, 40), id: m[0] });
  }
  return { targets: rows, why: '' };
}

const md = (() => { try { return fs.readFileSync(HANDOFF, 'utf8'); } catch { return ''; } })();
// ★ 只有**直接跑**（node tools\wake-lines.mjs）才走下面的流程；被 import 时只导出 parseLedger。
//   2026-09-25 踩到过：回归测试 import 这个文件拿解析器，结果把"整条唤醒流程"跑了一遍 ——
//   真的给三条线各投了一条提示（护栏挡住了"投给自己"那条）。工具被 import 不该有副作用。
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) main();
function main() {
  const { targets, why } = parseLedger(md);
  if (!targets.length) {
    process.stdout.write(`  [唤醒] 一个目标都没取到（${why || '台账里没有可投递的行'}）—— 不叫任何人。\n`);
    return;
  }

  const marker = path.join(TMP, `.woke-${stamp}`);
  if (fs.existsSync(marker) && !force) {
    process.stdout.write(`  [唤醒] 这一轮（stamp=${stamp}）已经叫过（去重命中 ${path.relative(ROOT, marker)}）—— 不重复打扰。\n`);
    return;
  }

  const text = `【自动唤醒 · 启动器】${reason} —— DSH Web / 桥接控制台 / 控制面都通了（${localTime()}，stamp=${stamp}）。

你上一轮如果是在一次全量重启里被打断的，这条就是"接着干"的信号：
- 现场读数：node tools\\sessions.mjs status（带"已归档"标注）/ git log -3 / git status
- 留言板：node tools\\board.mjs
- ⚠ 停机窗口里发给你的投递可能丢了（重启会断掉在途的东西）—— 别把"我没收到"当成"对方没说"。

这条是启动器自动投的，发起者不是某条会话，不用回到我这里。`;

  fs.mkdirSync(TMP, { recursive: true });
  const textFile = path.join(TMP, `boot-wake-${stamp}.md`);
  if (dryRun) {
    process.stdout.write(`  [DryRun] 会投给 ${targets.length} 条线：\n`);
    for (const t of targets) process.stdout.write(`    · ${t.role} -> ${t.id}\n`);
    process.stdout.write(`  正文文件会是 ${path.relative(ROOT, textFile)}，去重标记 ${path.relative(ROOT, marker)}\n`);
    return;
  }
  fs.writeFileSync(textFile, text, 'utf8');

  let ok = 0;
  const results = [];
  const rows = [];
  for (const t of targets) {
    // stdio: 'inherit' —— 让 notify-session 的话原样进启动器的流水（它自己会打印"投给谁 / 被拒原因"）。
    const r = spawnSync(process.execPath, [NOTIFY, t.id, textFile, '--no-header'], { cwd: ROOT, stdio: 'inherit' });
    const code = r.status ?? -1;
    if (code === 0) ok++;
    // ★ 每一条都留痕（短 id + 结果 + 原因码），别静默吞（协调线 2026-09-25 点名）：
    //   失败最常见的两种是"目标已归档"与"目标就是我自己"（notify-session 的护栏，都是 exit 1）。
    const why = code === 0 ? 'ok'
      : code === 1 ? '被 notify-session 拒（已归档 / 就是我自己 / 目标不存在 —— 上面那行有原话）'
        : `异常退出码 ${code}`;
    const short = t.id.replace('session-', '').slice(0, 8);
    rows.push({ at: new Date().toISOString(), stamp, target: short, role: t.role, exit: code, why });
    results.push(`${short}=${code === 0 ? 'ok' : `exit ${code}`}`);
  }
  try {
    fs.mkdirSync(TMP, { recursive: true });
    fs.appendFileSync(path.join(TMP, 'wake-lines.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  } catch { /* 记不上不影响唤醒本身 */ }
  try { fs.writeFileSync(marker, `${localTime()} targets=${targets.length} ok=${ok}\n`, 'utf8'); } catch { }
  process.stdout.write(`  [唤醒] ${ok}/${targets.length} 条投出去了（${results.join('、')}）—— 明细见 state\\_tmp\\wake-lines.jsonl\n`);
  for (const r of rows) if (r.exit !== 0) process.stdout.write(`         · ${r.target}（${r.role.slice(0, 20)}）：${r.why}\n`);
}
