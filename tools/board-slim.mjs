#!/usr/bin/env node
/**
 * tools\board-slim.mjs —— 留言板瘦身：只留最近 N 段栏目，更早的**按原样追加**进归档。
 *
 * 为什么要瘦：`qq-bridge\state\agents\AGENT-BOARD.md` 是小鲸鱼与开发会话的公共留言板，
 * 双方每次"看板子"都要读它 —— 越厚越费 token（她的每一次唤醒都是真金白银）。归档文件
 * `AGENT-BOARD-archive.md` 只在翻旧账时 grep，不进任何人的固定成本。
 *
 * 板子的结构（2026-09-23 实测，别再猜）：**一对一对的 `## ` 栏目** —— 每轮往来各写一段
 * `## 我给开发会话` 与一段 `## 开发会话回我`（整份 15 段 = 7 轮多），每段里通常一两条 `### `。
 * 所以瘦身的最小单位是**段**（`--keep` 指"保留最近几段"，偶数 = 整轮）。
 *
 * 用法：
 *   node tools\board-slim.mjs --dry             # 干跑：只报告会挪走什么，不写盘
 *   node tools\board-slim.mjs                   # 保留最近 8 段（默认，= 最近 4 轮）
 *   node tools\board-slim.mjs --keep 6          # 自定义保留段数
 *
 * 安全设计：① 先备份到 `state\_tmp\AGENT-BOARD.before-slim<时间戳>.md`（主人要求修改记录可溯源）；
 *           ② 归档是**追加**，正文一字不改；③ 只挪整段、`## ` 标题一律保留（第一版这里写错过，
 *           干跑里"47010→46981"就是标题被吃掉的迹象）；④ 干跑一个字节都不写；
 *           ⑤ 跑完打印前后字节数 + 新的「我给开发会话」指纹（桥接 dev-relay watcher 靠它判断
 *           "有没有新内容"，换了指纹要同步 state\dev-relay.json，否则会白叫醒开发会话一次）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const AGENTS_DIR = path.join(ROOT, 'qq-bridge', 'state', 'agents');
const BOARD = path.join(AGENTS_DIR, 'AGENT-BOARD.md');
const ARCHIVE = path.join(AGENTS_DIR, 'AGENT-BOARD-archive.md');
const TMP = path.join(ROOT, 'qq-bridge', 'state', '_tmp');

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const keepIdx = argv.indexOf('--keep');
const KEEP = keepIdx >= 0 ? Math.max(1, Number(argv[keepIdx + 1]) || 6) : 6;

const COLUMNS = ['\u6211\u7ed9\u5f00\u53d1\u4f1a\u8bdd', '\u5f00\u53d1\u4f1a\u8bdd\u56de\u6211']; // 我给开发会话 / 开发会话回我

/** 与桥接 boardSectionStampV2() 完全同构：切片 → 去首行 → trim → 剥掉尾部水平线 → sha1 前 12 位。 */
function sectionStamp(text, title) {
  const bodies = text
    .split(/^## /m)
    .filter((s) => s.startsWith(title))
    .map((s) => { const i = s.indexOf('\n'); return i >= 0 ? s.slice(i + 1) : ''; })
    .map((b) => b.trim().replace(/(?:\r?\n\s*(?:-{3,}|\*{3,}|_{3,})\s*)+$/, '').trim());
  if (!bodies.length) return '';
  return crypto.createHash('sha1').update(bodies.join('\n')).digest('hex').slice(0, 12);
}

/** 把一段正文切成 [前言, 条目…]：条目以行首 `### ` 开头。 */
function splitEntries(body) {
  const parts = body.split(/\r?\n(?=### )/);
  const head = parts[0];
  const entries = parts.slice(1);
  return { head, entries };
}

function main() {
  const text = fs.readFileSync(BOARD, 'utf8');
  const sizeBefore = Buffer.byteLength(text, 'utf8');

  // 按 `## ` 切片，保住文件头（第一个 `## ` 之前的一切）
  const firstCol = text.indexOf('\n## ');
  const header = firstCol >= 0 ? text.slice(0, firstCol + 1) : text;
  const rest = firstCol >= 0 ? text.slice(firstCol + 1) : '';
  const sections = rest.split(/^## /m).filter((s) => s.length); // 每段=「标题行 + 正文」（`## ` 已被切掉）
  const keepFrom = Math.max(0, sections.length - KEEP);
  const dropped = sections.slice(0, keepFrom);
  const kept = sections.slice(keepFrom);
  // 重建时**必须把 `## ` 补回去** —— 漏了就是"标题消失、指纹算不出来"（第一版实测的坑）。
  const newBoard = header + kept.map((s) => '## ' + s.trimEnd() + '\n').join('\n');

  console.log(`留言板：${sizeBefore} 字节 → ${Buffer.byteLength(newBoard, 'utf8')} 字节（保留最近 ${KEEP} 段 / 共 ${sections.length} 段，挪走 ${dropped.length} 段）`);
  for (const s of dropped) {
    const title = s.split(/\r?\n/)[0];
    const first = (s.match(/^### (.{0,44})/m) || [, '?'])[1];
    console.log(`  挪走：${title} —— ${first}`);
  }
  const stamp = sectionStamp(newBoard, COLUMNS[0]);
  console.log(`  新的「${COLUMNS[0]}」指纹 = ${stamp || '(算不出来！别写盘)'}`);
  console.log(`  当前 state\\dev-relay.json 里的指纹 = ${(() => { try { return (JSON.parse(fs.readFileSync(path.join(ROOT, 'qq-bridge', 'state', 'dev-relay.json'), 'utf8')) || {}).stamp || '(无)'; } catch { return '(读不到)'; } })()}`);

  if (!dropped.length) { console.log('  没有需要挪走的段落，未写盘。'); return; }
  if (dry) { console.log('  --dry：没有写盘。'); return; }
  if (!stamp) { console.log('  指纹算不出来 → 拒绝写盘（保护板子）。'); process.exitCode = 1; return; }

  const stampTag = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  fs.mkdirSync(TMP, { recursive: true });
  const backup = path.join(TMP, `AGENT-BOARD.before-slim${stampTag}.md`);
  fs.writeFileSync(backup, text, 'utf8');
  const archiveOld = fs.existsSync(ARCHIVE) ? fs.readFileSync(ARCHIVE, 'utf8') : '';
  const appendix = `\n\n<!-- 以下 ${dropped.length} 段由 tools\\board-slim.mjs 于 ${new Date().toISOString()} 从 AGENT-BOARD.md 移入 -->\n\n`
    + dropped.map((s) => '## ' + s.trimEnd()).join('\n\n');
  fs.writeFileSync(ARCHIVE, archiveOld.replace(/\s*$/, '') + appendix + '\n', 'utf8');
  fs.writeFileSync(BOARD, newBoard, 'utf8');
  console.log(`  已备份 ${path.relative(ROOT, backup)}；归档 ${path.relative(ROOT, ARCHIVE)}（${fs.statSync(ARCHIVE).size} 字节）`);
  // 顺手把桥接记的指纹改成新的：不然 dev-relay watcher 会以为"她刚写了新内容"，白叫醒开发会话一次。
  const relayFile = path.join(ROOT, 'qq-bridge', 'state', 'dev-relay.json');
  try {
    if (fs.existsSync(relayFile)) {
      const st = JSON.parse(fs.readFileSync(relayFile, 'utf8')) || {};
      if (st.stamp !== stamp) {
        st.stamp = stamp;
        fs.writeFileSync(relayFile, JSON.stringify(st), 'utf8');
        console.log(`  已同步 state\\dev-relay.json 的指纹 → ${stamp}（避免白叫醒开发会话一次）`);
      }
    }
  } catch (error) {
    console.log(`  ⚠ 指纹同步失败（不影响板子）：${error?.message ?? error}`);
  }
  console.log('  写盘完成。');
}

main();
