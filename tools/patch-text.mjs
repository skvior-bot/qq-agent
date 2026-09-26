#!/usr/bin/env node
/**
 * tools\patch-text.mjs —— 「精确文本补丁」：一份补丁描述（JSON）⇒ 按**字面**替换多个文件里的片段。
 *
 * 为什么要有它（2026-09-25 立；主人原话「不要重复造轮子」）：
 *   改这个仓库里的中文文本（`docs\*.md`、`*.mjs`）**不能用 PowerShell 裸往返** —— PS 5.1 对无 BOM 的
 *   UTF-8 按 ANSI(GBK) 解码，3 字节汉字与后续字节错位配对会**吞掉换行与引号**（AGENTS.md 红线 4）。
 *   开发会话于是各自手抄一份"读 utf8 → 断言每处**恰好命中一次** → 原子写回、保 BOM/行尾"的脚本 ——
 *   2026-09-25 一天之内抄了 5 遍（`qq-bridge\state\agents\_apply-docs.mjs` / `_finish-docs.mjs` /
 *   `_fix-cwd.mjs` / `_fix-holidays.mjs` / `_file-stall-bug.mjs`）。**这个工具就是那个轮子**：
 *   以后要改文档/源码里的片段，写一份 JSON 补丁喂给它，别再抄脚本。
 *
 * 用法：
 *   node tools\patch-text.mjs <补丁.json>            # 干跑：只报告每处命中几次，一个字节都不写
 *   node tools\patch-text.mjs <补丁.json> --write    # 真写（全有或全无）
 *   node tools\patch-text.mjs <补丁.json> --json     # 机器可读报告
 *   node tools\patch-text.mjs --selftest             # 自检（临时目录里跑一遍，不碰仓库）
 *
 * 补丁格式：
 *   { "edits": [ { "file": "docs\\优化清单.md", "old": "原文片段", "new": "新片段", "expect": 1 } ] }
 *   · `file` 相对**仓库根**（也接受绝对路径）；JSON 里反斜杠要写两个。
 *   · `old`/`new` 里的 `\n` 会**按目标文件自己的行尾**展开（CRLF 文件里就落成 CRLF，不会混进 LF）。
 *   · `expect` 默认 **1**（"恰好命中一次"）；写 `0` = "必须一处都没有"（防重复插入）。
 *
 * 安全设计：① **全有或全无** —— 任何一处命中数 ≠ expect ⇒ 一个文件都不写；
 *           ② 保原文件的 **BOM 与行尾**；③ **不经过 PowerShell**（中文安全）；④ 干跑默认、写盘前打印前后字符数。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 读文件 + 认行尾（BOM 由 `utf8` 读进来就是 `\uFEFF`，写回原样 ⇒ 不用特殊处理）。 */
function load(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return { raw, eol: raw.includes('\r\n') ? '\r\n' : '\n' };
}

/** 按目标文件行尾展开片段里的 `\n`。 */
const expand = (s, eol) => String(s).split('\n').join(eol);

const countOf = (hay, needle) => (needle ? hay.split(needle).length - 1 : 0);

/**
 * 核心：算出每个文件的新内容（**不写盘**）。
 * @returns {{ok:boolean, files:Array, problems:Array}}
 */
export function planEdits(edits, { root = ROOT } = {}) {
  const byFile = new Map();
  const problems = [];
  for (const [i, e] of (edits ?? []).entries()) {
    const at = `edits[${i}]`;
    if (!e || typeof e !== 'object') { problems.push(`${at} 不是对象`); continue; }
    const file = path.isAbsolute(String(e.file ?? '')) ? String(e.file) : path.join(root, String(e.file ?? ''));
    if (!e.file) { problems.push(`${at} 缺 file`); continue; }
    if (typeof e.old !== 'string' || typeof e.new !== 'string') { problems.push(`${at}（${e.file}）old/new 必须是字符串`); continue; }
    const expect = e.expect === undefined ? 1 : Number(e.expect);
    if (!Number.isInteger(expect) || expect < 0) { problems.push(`${at}（${e.file}）expect 必须是非负整数`); continue; }
    let slot = byFile.get(file);
    if (!slot) {
      let src;
      try { src = load(file); } catch (err) { problems.push(`${at}（${e.file}）读不到：${err.code || err.message}`); continue; }
      slot = { file, eol: src.eol, before: src.raw, out: src.raw, hits: [], applied: 0 };
      byFile.set(file, slot);
    }
    const oldS = expand(e.old, slot.eol);
    const n = countOf(slot.out, oldS);
    slot.hits.push({ index: i, expect, found: n, ok: n === expect, head: oldS.split(slot.eol)[0].slice(0, 60) });
    if (n !== expect) { problems.push(`${e.file} 第 ${i + 1} 处：命中 ${n} 次（要求 ${expect}）`); continue; }
    if (expect > 0) { slot.out = slot.out.split(oldS).join(expand(e.new, slot.eol)); slot.applied += 1; }
  }
  return { ok: problems.length === 0, files: [...byFile.values()], problems };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) return selftest();
  const file = argv.find((a) => !a.startsWith('--'));
  const write = argv.includes('--write');
  const asJson = argv.includes('--json');
  if (!file) {
    console.error('用法：node tools\\patch-text.mjs <补丁.json> [--write] [--json] ｜ node tools\\patch-text.mjs --selftest');
    return 2;
  }
  let patch;
  try { patch = JSON.parse(fs.readFileSync(path.isAbsolute(file) ? file : path.join(process.cwd(), file), 'utf8')); }
  catch (err) { console.error(`❌ 读不到/解析不了补丁文件：${err.message}`); return 2; }
  const edits = Array.isArray(patch) ? patch : patch.edits;
  if (!Array.isArray(edits) || !edits.length) { console.error('❌ 补丁里没有 edits[]'); return 2; }

  const plan = planEdits(edits);
  if (asJson) console.log(JSON.stringify({ ok: plan.ok, write, files: plan.files.map((f) => ({ file: path.relative(ROOT, f.file), before: f.before.length, after: f.out.length, applied: f.applied, hits: f.hits })), problems: plan.problems }, null, 2));
  else {
    for (const f of plan.files) {
      console.log(`${plan.ok && write ? '✍️ ' : '· '}${path.relative(ROOT, f.file)}  ${f.before.length} → ${f.out.length} 字符（命中 ${f.hits.filter((h) => h.ok).length}/${f.hits.length} 处）`);
      for (const h of f.hits) if (!h.ok) console.log(`    ❌ 第 ${h.index + 1} 处：命中 ${h.found} 次（要求 ${h.expect}）：${h.head}…`);
    }
  }
  if (!plan.ok) { console.error(`\n❌ 有 ${plan.problems.length} 处不满足 expect ⇒ **一个字节都没写**：`); for (const p of plan.problems) console.error('   - ' + p); return 1; }
  if (!write) { console.log('\n（干跑：没写盘。要落盘加 --write）'); return 0; }
  for (const f of plan.files) { fs.writeFileSync(f.file, f.out, 'utf8'); console.log(`✅ 已写 ${path.relative(ROOT, f.file)}`); }
  return 0;
}

/** 自检：临时目录里造一份「CRLF + BOM + 中文」的文件，跑一遍 planEdits + 写回，逐条断言。 */
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-text-selftest-'));
  const target = path.join(tmp, 'sample.md');
  const original = '\uFEFF# 标题\r\n\r\n- 旧的一句中文\r\n- 另一行\r\n';
  fs.writeFileSync(target, original, 'utf8');
  const cases = [];
  const t = (name, cond, detail = '') => cases.push({ name, ok: !!cond, detail });

  // ① 命中一次 ⇒ 能算出新内容，且保留 BOM 与 CRLF
  const p1 = planEdits([{ file: target, old: '- 旧的一句中文', new: '- 新的一句中文（改过了）' }]);
  t('命中一次 ⇒ ok', p1.ok, JSON.stringify(p1.problems));
  t('保留 BOM', p1.files[0].out.startsWith('\uFEFF'));
  t('保留 CRLF（新内容也按 CRLF 落）', p1.files[0].out.includes('新的一句中文（改过了）\r\n') && !/[^\r]\n/.test(p1.files[0].out));
  t('按字面替换（其余内容一字不动）', p1.files[0].out === original.replace('- 旧的一句中文', '- 新的一句中文（改过了）'));
  t('干跑不写盘', fs.readFileSync(target, 'utf8') === original);

  // ② 命中 0 次 ⇒ 报问题、且**不写任何文件**（哪怕同批里还有一处是好的）
  const p2 = planEdits([{ file: target, old: '- 旧的一句中文', new: '- A' }, { file: target, old: '这句压根没有', new: '- B' }]);
  t('有一处不命中 ⇒ ok=false', p2.ok === false && p2.problems.length === 1, JSON.stringify(p2.problems));
  const p2b = planEdits([{ file: target, old: '- 旧的一句中文', new: '- A' }, { file: target, old: '这句压根没有', new: '- B' }]);
  if (p2b.ok) fs.writeFileSync(target, p2b.files[0].out, 'utf8');
  t('不满足 expect ⇒ 一个字节都没写（全有或全无）', fs.readFileSync(target, 'utf8') === original);

  // ③ 命中两次 + expect:2 ⇒ 两处都换；expect:1 ⇒ 拒
  const twice = path.join(tmp, 'twice.txt');
  fs.writeFileSync(twice, '甲\n乙\n甲\n', 'utf8');
  const p3 = planEdits([{ file: twice, old: '甲', new: '丙', expect: 2 }]);
  t('expect:2 + 命中 2 次 ⇒ 通过且两处都换', p3.ok && p3.files[0].out === '丙\n乙\n丙\n', p3.files[0]?.out);
  const p4 = planEdits([{ file: twice, old: '甲', new: '丙', expect: 1 }]);
  t('expect:1 + 命中 2 次 ⇒ 拒（防"以为只改一处"）', p4.ok === false);

  // ④ expect:0 = "必须不存在"（防重复插入）
  const p5 = planEdits([{ file: twice, old: '丁', new: '戊', expect: 0 }]);
  t('expect:0 ⇒ 不存在才算过', p5.ok === true && p5.files[0].out === '甲\n乙\n甲\n');
  const p6 = planEdits([{ file: twice, old: '甲', new: '戊', expect: 0 }]);
  t('expect:0 ⇒ 存在就拒', p6.ok === false);

  // ⑤ 多文件、一处坏 ⇒ 全批不写
  const other = path.join(tmp, 'other.txt');
  fs.writeFileSync(other, '好行\n', 'utf8');
  const p7 = planEdits([{ file: other, old: '好行', new: '改过的好行' }, { file: twice, old: '不存在', new: 'x' }]);
  t('多文件里有坏锚点 ⇒ 整批拒绝（含本来能改的文件）', p7.ok === false && fs.readFileSync(other, 'utf8') === '好行\n');

  let bad = 0;
  for (const c of cases) { console.log(`  ${c.ok ? '[PASS]' : '[FAIL]'} ${c.name}${c.ok ? '' : '  ' + c.detail}`); if (!c.ok) bad += 1; }
  console.log(`\n===== patch-text 自检：${cases.length - bad} 通过，${bad} 失败 =====`);
  fs.rmSync(tmp, { recursive: true, force: true });
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) process.exit(main());
