#!/usr/bin/env node
// tools/structure-snapshot.mjs —— DSH 工作区「结构数字」快照生成器
//
// 为什么存在：文档里硬编码的结构数字（bridge.js 行数、scripts\ 文件数、挂了几个 MCP……）
// 会持续过期，新会话一读就被误导。让数字由本脚本重算，文档只引用结果。
//
// 用法：
//   node tools/structure-snapshot.mjs                 打印 Markdown + 覆盖写 docs\结构快照.md
//   node tools/structure-snapshot.mjs --print         只打印，不写文件
//   node tools/structure-snapshot.mjs --json          只输出 JSON（不写文件，保证 stdout 可 JSON.parse）
//   node tools/structure-snapshot.mjs --json --write  输出 JSON 并且同时写 Markdown
//
// 产物：docs\结构快照.md；文件**末尾另有一行** `<!-- snapshot-digest {…} -->` ——
//   机器可读的数字指纹（本脚本已算出的那些数字），供 tools\self-check.mjs 5.1 判断
//   「快照是否过期」。判据是数字而不是 mtime：改了文件但数字没变就不该报过期。
//
// 约束：
//   * 纯 node 内置模块（fs/path/crypto/url/os），零依赖，ESM。
//   * 工作区定位靠 import.meta.url，不依赖 cwd。
//   * 只读：唯一被写入的路径是 docs\结构快照.md（--print/--json 时连它都不写）。
//   * 健壮性：每一段独立 try/catch，失败只在该段输出「不可用：原因」，绝不整体崩。
//   * 输出 UTF-8 无 BOM、LF 换行。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isTransientTopLevel, TRANSIENT_TOP_LEVEL } from './top-level-transient.mjs';

// ---------------------------------------------------------------- 基础定位

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.dirname(path.dirname(SELF)); // tools\.. = 工作区根
const HOME = process.env.USERPROFILE || process.env.HOME || os.homedir() || '';
const DSH_HOME = HOME ? path.join(HOME, '.dsh') : '';
// ★ 展示用遮蔽：把真实的 Windows 用户名换成 `<用户目录>`。
//   `docs\结构快照.md` 是**进版本库**的文档，里面写着 `C:\Users\<真用户名>\…` 就等于把主人的
//   机器用户名连同目录结构一起发出去（交付给别人 / 推到公开仓库时的隐私泄漏）。
//   只作用于 markdown 渲染 —— `--json`、哈希计算、一切比较仍用**真路径**（否则哈希全错）。
const maskHome = (p) => {
  const s = String(p ?? '');
  return HOME && s.startsWith(HOME) ? '<用户目录>' + s.slice(HOME.length) : s;
};
const OUT_FILE = path.join(ROOT, 'docs', '结构快照.md');

const ARGV = new Set(process.argv.slice(2));
const WANT_JSON = ARGV.has('--json');
const WANT_PRINT = ARGV.has('--print');
const FORCE_WRITE = ARGV.has('--write');

// 这三个目录不展开（体积/文件数大且与结构数字无关），只给汇总行。
const EXCLUDE_DIRS = new Set(['node_modules', '.npm-cache', 'SnowLuma']);

const SRC_DIR = path.join(ROOT, 'qq-bridge', 'src');
const SCRIPTS_DIR = path.join(ROOT, 'qq-bridge', 'scripts');
const STATE_DIR = path.join(ROOT, 'qq-bridge', 'state');
const DOCS_DIR = path.join(ROOT, 'docs');
const BRIDGE_DOCS_DIR = path.join(ROOT, 'qq-bridge', 'docs');
const CORDIS_PATCH = DSH_HOME ? path.join(DSH_HOME, 'profiles', 'web', 'cordis.patch.yml') : '';

// 脚本分类前缀（按此顺序取第一个命中）
const PREFIXES = [
  'test-', 'probe-', 'verify-', 'check-', 'audit-', 'setup-',
  'patch-', 'demo-', 'make-', 'send-', 'dsh-', '_smoke-',
];

// ---------------------------------------------------------------- 小工具

function mb(bytes) {
  return (bytes / 1048576).toFixed(2);
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1);
}

function pct(part, whole) {
  if (!whole) return '0.0';
  return ((part / whole) * 100).toFixed(1);
}

/** 本地时间 ISO（带真实 UTC 偏移），用于头部时间戳 */
function localIso(d = new Date()) {
  const p = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const stamp =
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  return `${stamp}${sign}${p(off / 60)}:${p(off % 60)}`;
}

function offsetLabel(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const p = (n) => String(Math.abs(Math.trunc(n))).padStart(2, '0');
  return `${sign}${p(off / 60)}:${p(off % 60)}`;
}

/** 按码点截断，避免劈开代理对 */
function truncate(s, n) {
  const cps = Array.from(String(s));
  return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('');
}

function rel(p) {
  const r = path.relative(ROOT, p);
  return r === '' ? '.' : r.split(path.sep).join('/');
}

/** 统计 LF(\n) 个数——注意这与 Get-Content 的「行数」定义不同 */
function countLf(file) {
  const buf = fs.readFileSync(file);
  let n = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) n++;
  return { lines: n, bytes: buf.length };
}

function sha256_12(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
}

function errText(e) {
  if (!e) return '未知错误';
  const msg = e.message || String(e);
  // Node 的 message 通常已自带 'ENOENT: ' 前缀，别拼成 'ENOENT: ENOENT: ...'
  if (e.code && !msg.startsWith(e.code)) return `${e.code}: ${msg}`;
  return msg;
}

/**
 * 递归扫描目录。
 * @returns {{files:number, bytes:number, skipped:Array, symlinks:Array, errors:Array}}
 */
function scanTree(dir, excludeNames = EXCLUDE_DIRS, acc = null) {
  if (!acc) acc = { files: 0, bytes: 0, skipped: [], symlinks: [], errors: [] };
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    acc.errors.push(`${rel(dir)}: ${errText(e)}`);
    return acc;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch (e) {
      acc.errors.push(`${rel(full)}: ${errText(e)}`);
      continue;
    }
    // 符号链接/junction：不跟随（避免成环），但要记录
    if (st.isSymbolicLink()) {
      acc.symlinks.push(rel(full));
      continue;
    }
    if (st.isDirectory()) {
      if (excludeNames.has(ent.name)) {
        const sub = scanTree(full, new Set());
        acc.skipped.push({ path: rel(full), files: sub.files, bytes: sub.bytes });
        continue;
      }
      scanTree(full, excludeNames, acc);
    } else if (st.isFile()) {
      acc.files++;
      acc.bytes += st.size;
    }
  }
  return acc;
}

/** 每个段落独立隔离：抛错只返回 {ok:false}，不影响其它段 */
function section(name, fn) {
  try {
    return { ok: true, name, data: fn() };
  } catch (e) {
    return { ok: false, name, error: errText(e) };
  }
}

/** 段落失败时的占位：自己带上 `## N.` 标题，否则调用方已经 push 的标题会被丢弃、编号断档 */
function unusable(title, sec) {
  return [`## ${title}`, '', `> 不可用：${sec.error}`, ''];
}

// ---------------------------------------------------------------- 第 2 段：顶层目录概览

function collectTopLevel() {
  const entries = fs.readdirSync(ROOT, { withFileTypes: true });
  const dirs = [];
  const files = [];
  const skipped = [];
  const symlinks = [];
  const errors = [];

  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name, 'zh'))) {
    // ★ 瞬态本地状态**不进一级条目**（也不算进 `topLevelEntries` 数字）：它们由工具在根目录创建、用完即删
    //   ⇒ 计进去会让"结构快照已过期"这条判据自己红绿（daily-check 每天 09:00 把警告推到主人手机）。
    //   名单与理由的唯一口径 = `tools\top-level-transient.mjs`；self-check 复算时调同一个判定。
    //   ⚠ 只按**具名**名单跳，绝不用模式匹配（那会连 `.gitignore` / `.dsh` 这类真条目一起放过）。
    if (isTransientTopLevel(ent.name)) continue;
    const full = path.join(ROOT, ent.name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch (e) {
      errors.push(`${ent.name}: ${errText(e)}`);
      continue;
    }
    if (st.isSymbolicLink()) {
      symlinks.push({ name: ent.name, target: safeReadlink(full) });
      dirs.push({ name: ent.name, kind: '符号链接', files: 0, bytes: 0, note: '未跟随' });
      continue;
    }
    if (st.isDirectory()) {
      const sub = scanTree(full);
      skipped.push(...sub.skipped);
      // 顶层就是 node_modules / .npm-cache / SnowLuma 的，也要进「大体积目录汇总表」——
      // 它们是本次扫描里唯一没被展开的三项，漏进来会让那张表的合计只算一半（踩过）。
      if (EXCLUDE_DIRS.has(ent.name)) {
        skipped.push({ path: rel(full), files: sub.files, bytes: sub.bytes, topLevel: true });
      }
      symlinks.push(...sub.symlinks.map((s) => ({ name: s, target: null })));
      errors.push(...sub.errors);
      dirs.push({ name: ent.name, kind: '目录', files: sub.files, bytes: sub.bytes, note: '' });
    } else {
      files.push({ name: ent.name, bytes: st.size });
    }
  }
  return { dirs, files, skipped, symlinks, errors };
}

function renderTopLevel(sec) {
  const L = [];
  L.push('## 1. 顶层目录概览');
  L.push('');
  if (!sec.ok) return unusable('1. 顶层目录概览', sec);
  const { dirs, files, skipped, symlinks, errors } = sec.data;

  L.push(`工作区根：\`${ROOT}\``);
  L.push('');
  L.push('| 一级条目 | 类型 | 文件数（递归） | 体积 |');
  L.push('| --- | --- | ---: | ---: |');
  for (const d of dirs) {
    L.push(`| \`${d.name}\` | ${d.kind} | ${d.files} | ${mb(d.bytes)} MB |`);
  }
  for (const f of files) {
    L.push(`| \`${f.name}\` | 文件 | 1 | ${kb(f.bytes)} KB |`);
  }

  const totalFiles = dirs.reduce((a, d) => a + d.files, 0) + files.length;
  const totalBytes = dirs.reduce((a, d) => a + d.bytes, 0) + files.reduce((a, f) => a + f.bytes, 0);
  L.push(`| **合计（全部一级条目；嵌套的排除项不计）** | — | **${totalFiles}** | **${mb(totalBytes)} MB** |`);
  L.push('');
  const transientNow = [...TRANSIENT_TOP_LEVEL.keys()].filter((n) => fs.existsSync(path.join(ROOT, n)));
  L.push(`> ★ **瞬态条目不计入**上表与「顶层条目数」：${[...TRANSIENT_TOP_LEVEL.keys()].map((n) => `\`${n}\``).join(' / ')}`
    + ' 是工具在根目录建的**本地一次性状态**、用完/关掉即删（计进去会让「结构快照已过期」这条判据自己红绿，'
    + '而 daily-check 每天 09:00 会把警告推到主人手机）—— 名单与逐条理由见 `tools\\top-level-transient.mjs`，'
    + `自检复算调的是同一个判定。当前在场：${transientNow.length ? transientNow.map((n) => `\`${n}\``).join(' / ') : '无'}。`);
  L.push('');

  L.push('### 1.1 大体积目录汇总（不逐个展开）');
  L.push('');
  L.push('顶层 `.npm-cache` / `SnowLuma` 已经算在上面的一级条目合计里（它们本身就是一级条目，只是不展开子项）；');
  L.push('嵌套的 `node_modules`（如 `qq-bridge/node_modules`）没有算进任何一级条目。下表把它们单独汇总：');
  L.push('');
  if (skipped.length === 0) {
    L.push('未发现 node_modules / .npm-cache / SnowLuma。');
  } else {
    L.push('| 路径 | 层级 | 文件数 | 体积 |');
    L.push('| --- | --- | ---: | ---: |');
    for (const s of skipped.sort((a, b) => b.bytes - a.bytes)) {
      L.push(`| \`${s.path}\` | ${s.topLevel ? '顶层（已计入上方合计）' : '嵌套（未计入）'} | ${s.files} | ${mb(s.bytes)} MB |`);
    }
    const sf = skipped.reduce((a, s) => a + s.files, 0);
    const sb = skipped.reduce((a, s) => a + s.bytes, 0);
    L.push(`| **三者合计** | — | **${sf}** | **${mb(sb)} MB** |`);
  }
  L.push('');

  L.push('### 1.2 顶层一览（代码块视图）');
  L.push('');
  L.push('```text');
  const pad = Math.max(...dirs.map((d) => Array.from(d.name).length + 1), 8);
  const padName = (n) => n + ' '.repeat(Math.max(1, pad - Array.from(n).length));
  for (const d of dirs) {
    L.push(`${padName(d.name + '/')} ${String(d.files).padStart(5)} 文件  ${mb(d.bytes).padStart(8)} MB`);
  }
  for (const f of files) {
    L.push(`${padName(f.name)} ${'1'.padStart(5)} 文件  ${(kb(f.bytes) + ' KB').padStart(8)}`);
  }
  L.push('```');
  L.push('');

  if (symlinks.length) {
    L.push('符号链接/junction（未跟随统计）：');
    L.push('');
    for (const s of symlinks) {
      L.push(`- \`${s.name}\`${s.target ? ' → ' + s.target : ''}`);
    }
    L.push('');
  }
  if (errors.length) {
    L.push(`扫描告警（${errors.length} 条，前 10 条）：`);
    L.push('');
    for (const e of errors.slice(0, 10)) L.push(`- ${e}`);
    L.push('');
  }
  return L;
}

// ---------------------------------------------------------------- 第 3 段：src 逐文件行数

function collectSrc() {
  const names = fs.readdirSync(SRC_DIR, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
  const rows = names.map((n) => {
    const { lines, bytes } = countLf(path.join(SRC_DIR, n));
    return { name: n, lines, bytes };
  });
  rows.sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
  const totalLines = rows.reduce((a, r) => a + r.lines, 0);
  const totalBytes = rows.reduce((a, r) => a + r.bytes, 0);
  return { rows, totalLines, totalBytes };
}

function renderSrc(sec) {
  const L = [];
  L.push('## 2. `qq-bridge/src/` 逐文件行数与体积');
  L.push('');
  if (!sec.ok) return unusable('2. qq-bridge/src/ 逐文件行数与体积', sec);
  const { rows, totalLines, totalBytes } = sec.data;

  L.push(`路径：\`${rel(SRC_DIR)}\`　文件数：**${rows.length}**　合计行数：**${totalLines}**（按 LF 计）　合计体积：**${mb(totalBytes)} MB**`);
  L.push('');
  L.push('> 行数定义：**按 LF 计** —— 统计文件字节中 `\\n`（0x0A）的个数，与 PowerShell `Get-Content` 的「行数」不是同一口径（CRLF 文件的 Get-Content 行数会等于 LF 数，但末行无换行时两者相同；含 CR-only 的文件则不同）。');
  L.push('');
  L.push('| 文件 | 行数（按 LF 计） | 体积 KB | 占 src 行数比 |');
  L.push('| --- | ---: | ---: | ---: |');
  for (const r of rows) {
    L.push(`| \`${r.name}\` | ${r.lines} | ${kb(r.bytes)} | ${pct(r.lines, totalLines)}% |`);
  }
  L.push(`| **合计** | **${totalLines}** | **${kb(totalBytes)}** | 100% |`);
  L.push('');
  return L;
}

// ---------------------------------------------------------------- 第 4 段：scripts 分类计数

function collectScripts() {
  const ents = fs.readdirSync(SCRIPTS_DIR, { withFileTypes: true });
  const all = ents.filter((e) => e.isFile())
    .map((e) => ({ name: e.name, ext: path.extname(e.name).toLowerCase() }));
  const groups = new Map();
  for (const f of all) {
    const pfx = PREFIXES.find((p) => f.name.startsWith(p)) || '其它';
    if (!groups.has(pfx)) groups.set(pfx, []);
    groups.get(pfx).push(f);
  }
  const table = [...groups.entries()]
    .map(([k, v]) => ({ prefix: k, count: v.length, files: v }))
    .sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
  const zeroPrefixes = PREFIXES.filter((p) => !groups.has(p));

  const testFiles = groups.get('test-') || [];
  const byExt = {};
  for (const f of testFiles) byExt[f.ext || '(无扩展名)'] = (byExt[f.ext || '(无扩展名)'] || 0) + 1;

  // 子目录（如 _archive\）不计入上面的「文件总数」，但要显式列出，否则数字对不上别处
  const subdirs = [];
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    const full = path.join(SCRIPTS_DIR, ent.name);
    const sub = scanTree(full, new Set());
    subdirs.push({
      name: ent.name,
      files: sub.files,
      bytes: sub.bytes,
      names: (() => {
        try {
          return fs.readdirSync(full, { withFileTypes: true })
            .filter((e) => e.isFile()).map((e) => e.name).sort();
        } catch {
          return [];
        }
      })(),
    });
  }
  subdirs.sort((a, b) => b.files - a.files || a.name.localeCompare(b.name));

  return { total: all.length, table, byExt, all, subdirs, zeroPrefixes };
}

function renderScripts(sec) {
  const L = [];
  L.push('## 3. `qq-bridge/scripts/` 分类计数');
  L.push('');
  if (!sec.ok) return unusable('3. qq-bridge/scripts/ 分类计数', sec);
  const { total, table, byExt, subdirs, zeroPrefixes } = sec.data;

  L.push(`路径：\`${rel(SCRIPTS_DIR)}\`　顶层文件总数：**${total}**`);
  L.push('');
  L.push('| 前缀分组 | 数量 | 占比 | 示例 |');
  L.push('| --- | ---: | ---: | --- |');
  for (const g of table) {
    const sample = g.files.slice(0, 3).map((f) => f.name).join('、');
    const more = g.files.length > 3 ? `…等 ${g.files.length} 个` : '';
    L.push(`| \`${g.prefix}\` | ${g.count} | ${pct(g.count, total)}% | ${sample}${more} |`);
  }
  L.push(`| **合计** | **${total}** | 100% | — |`);
  L.push('');
  if (zeroPrefixes.length) {
    L.push(`数量为 0 的前缀：${zeroPrefixes.map((p) => '`' + p + '`').join('、')}（前缀判定按此顺序取第一个命中）`);
    L.push('');
  }

  const extList = Object.entries(byExt).sort((a, b) => b[1] - a[1]);
  L.push('`test-` 组的扩展名分布：');
  L.push('');
  for (const [ext, n] of extList) L.push(`- \`${ext}\`：**${n}** 个`);
  L.push('');
  if (extList.length === 0) L.push('- （没有 test- 前缀的脚本）');
  L.push('');

  L.push('### 3.1 子目录（**不计入**上面的「顶层文件总数」）');
  L.push('');
  if (subdirs.length === 0) {
    L.push('无子目录。');
  } else {
    for (const d of subdirs) {
      L.push(`- \`${d.name}/\`：**${d.files}** 文件 / ${mb(d.bytes)} MB${d.name === '_archive' ? '（归档脚本，已从上面的计数里移出）' : ''}`);
      if (d.names.length) L.push(`  - 内含：${d.names.map((n) => '`' + n + '`').join('、')}`);
    }
    const sf = subdirs.reduce((a, d) => a + d.files, 0);
    L.push(`- 子目录合计：**${sf}** 文件；所以 \`${rel(SCRIPTS_DIR)}\` **递归**文件总数 = ${total} + ${sf} = **${total + sf}**`);
  }
  L.push('');
  return L;
}

// ---------------------------------------------------------------- 第 5 段：MCP 挂载与一致性

const HASH_PAIRS = [
  {
    label: 'preset qq-chat-v2',
    src: path.join(ROOT, 'qq-bridge', 'dsh', 'agent-presets', 'qq-chat-v2', 'agent.cordis.yml'),
    dst: DSH_HOME ? path.join(DSH_HOME, '.agent-presets', 'qq-chat-v2', 'agent.cordis.yml') : '',
  },
  {
    label: 'skill draw-image/SKILL.md',
    src: path.join(ROOT, '.dsh', 'skills', 'draw-image', 'SKILL.md'),
    dst: DSH_HOME ? path.join(DSH_HOME, 'skills', 'draw-image', 'SKILL.md') : '',
  },
  {
    label: 'skill draw-image/scripts/draw.mjs',
    src: path.join(ROOT, '.dsh', 'skills', 'draw-image', 'scripts', 'draw.mjs'),
    dst: DSH_HOME ? path.join(DSH_HOME, 'skills', 'draw-image', 'scripts', 'draw.mjs') : '',
  },
  // 密钥副本必须跟着一起比：技能凭据有两份（`~\.dsh` 是权威、工作区那份是副本），换 key 时
  // 只改一份 → 另一份留着旧密钥，谁都不知道（2026-09-23 已经真实发生过一次，当时靠人工记得
  // "两份一起改"）。**只比哈希，不打印内容**：本文件的输出会被人看、被 commit。
  {
    label: 'skill draw-image/credentials.json（密钥，仅比哈希）',
    src: path.join(ROOT, '.dsh', 'skills', 'draw-image', 'credentials.json'),
    dst: DSH_HOME ? path.join(DSH_HOME, 'skills', 'draw-image', 'credentials.json') : '',
    secret: true,
  },
  {
    label: 'skill draw-image/config.json',
    src: path.join(ROOT, '.dsh', 'skills', 'draw-image', 'config.json'),
    dst: DSH_HOME ? path.join(DSH_HOME, 'skills', 'draw-image', 'config.json') : '',
  },
];

const LINK_CHECK = {
  label: 'qq-mode-console 插件',
  installed: DSH_HOME ? path.join(DSH_HOME, 'plugins', 'qq-mode-console') : '',
  expected: path.join(ROOT, 'qq-bridge', 'plugins', 'qq-mode-console'),
};

function safeReadlink(p) {
  try {
    return String(fs.readlinkSync(p));
  } catch (e) {
    return `<readlink 失败: ${errText(e)}>`;
  }
}

/** 解析 cordis.patch.yml 里的每个 `- insert:` 块 */
function parsePatchYml(file) {
  const text = fs.readFileSync(file, 'utf8');
  const blocks = text.split(/^[ \t]*-[ \t]*insert:[ \t]*$/m).slice(1);
  const items = [];
  for (const raw of blocks) {
    // id 是 insert 下的**序列项**（`- id: xxx`），serverName/timeout 是 config 下的映射键（无 `- `）。
    // 缩进一律用 [ \t]* 而不是 \s*：\s* 会跨行吞换行，把匹配挪到别的键上（曾导致 id 全为 null）。
    const idM = raw.match(/^[ \t]*(?:-[ \t]+)?id:[ \t]*(.+?)[ \t]*$/m);
    const snM = raw.match(/^[ \t]*serverName:[ \t]*(.+?)[ \t]*$/m);
    const toM = raw.match(/^[ \t]*toolCallTimeoutMs:[ \t]*(\d+)[ \t]*$/m);
    const jsPaths = [...raw.matchAll(/^[ \t]*-[ \t]*['"]?([^'"\r\n]+\.js)['"]?[ \t]*$/gm)]
      .map((m) => m[1].trim());
    const strip = (s) => (s == null ? null : s.replace(/^['"]|['"]$/g, '').trim());
    items.push({
      id: strip(idM && idM[1]),
      serverName: strip(snM && snM[1]),
      entry: jsPaths[0] || null,
      allJs: jsPaths,
      timeoutMs: toM ? Number(toM[1]) : null,
    });
  }
  const servers = new Set(items.map((i) => i.serverName).filter(Boolean));
  const ids = new Set(items.map((i) => i.id).filter(Boolean));
  // 解析健康度：块数 / 提取到的 id 数 / serverName 数 三者不一致就说明 YAML 结构变了
  const parseOk = ids.size === blocks.length && servers.size === blocks.length;
  return { items, serverCount: servers.size, idCount: ids.size, insertBlocks: blocks.length, parseOk };
}

function collectMcp() {
  const patch = parsePatchYml(CORDIS_PATCH);
  const withExist = patch.items.map((it) => {
    let exists = false;
    let note = '';
    if (!it.entry) {
      note = '未在 args 里找到 .js 路径';
    } else {
      try {
        exists = fs.statSync(it.entry).isFile();
      } catch (e) {
        exists = false;
        note = errText(e);
      }
    }
    return { ...it, exists, note };
  });

  const hashes = HASH_PAIRS.map((p) => {
    const row = { label: p.label, src: p.src, dst: p.dst };
    try {
      const sOk = p.src && fs.statSync(p.src).isFile();
      const dOk = p.dst && fs.statSync(p.dst).isFile();
      row.srcExists = !!sOk;
      row.dstExists = !!dOk;
      row.srcHash = sOk ? sha256_12(p.src) : null;
      row.dstHash = dOk ? sha256_12(p.dst) : null;
      if (sOk && dOk) {
        row.status = row.srcHash === row.dstHash ? '一致' : '不一致';
      } else if (sOk && !dOk) {
        row.status = '单边缺失（仅工作区源）';
      } else if (!sOk && dOk) {
        row.status = '单边缺失（仅已安装副本）';
      } else {
        row.status = '两边都不存在';
      }
    } catch (e) {
      row.status = '无法判定';
      row.note = errText(e);
    }
    return row;
  });

  const link = { ...LINK_CHECK, status: '无法判定', raw: null, resolved: null, note: '' };
  try {
    const st = fs.lstatSync(link.installed);
    if (st.isSymbolicLink()) {
      link.raw = safeReadlink(link.installed);
      const cleaned = String(link.raw).replace(/^\\\\\?\\/, '');
      if (/^\\\\\?\\Volume\{/i.test(String(link.raw))) {
        link.status = '无法判定';
        link.note = 'readlink 返回卷 GUID 形式，无法比对';
      } else {
        link.resolved = path.resolve(path.dirname(link.installed), cleaned);
        const same = link.resolved.toLowerCase() === link.expected.toLowerCase();
        link.isDir = (() => {
          try { return fs.statSync(link.installed).isDirectory(); } catch { return false; }
        })();
        link.status = same ? '是链接，且指向工作区源' : '是链接，但指向别处';
        if (!same) link.note = `期望 ${link.expected}`;
      }
    } else {
      link.status = st.isDirectory() ? '不是链接（独立目录副本）' : '不是链接（普通文件）';
      link.note = '未使用 junction/symlink，改动不会自动同步';
    }
  } catch (e) {
    link.status = '不存在或无法判定';
    link.note = errText(e);
  }

  return { patchPath: CORDIS_PATCH, patch, mcp: withExist, hashes, link };
}

function renderMcp(sec) {
  const L = [];
  L.push('## 4. MCP 挂载与「源 ↔ 已安装」一致性');
  L.push('');
  if (!sec.ok) return unusable('4. MCP 挂载与「源 ↔ 已安装」一致性', sec);
  const { patchPath, patch, mcp, hashes, link } = sec.data;

  L.push(`配置文件：\`${maskHome(patchPath)}\``);
  L.push('');
  L.push(`**MCP 数量：${patch.serverCount}**（\`- insert:\` 块 ${patch.insertBlocks} 个，解析到 id ${patch.idCount} 个${patch.parseOk ? '' : ' ⚠️ 与块数不一致，YAML 结构可能变了'}）`);
  L.push('');
  L.push('| # | id | serverName | 入口文件（args 里的 .js） | 存在 | 超时 ms |');
  L.push('| ---: | --- | --- | --- | :---: | ---: |');
  mcp.forEach((m, i) => {
    const entry = m.entry ? `\`${m.entry}\`` : '（无）';
    const ex = m.exists ? '✅' : `❌${m.note ? ' ' + m.note : ''}`;
    L.push(`| ${i + 1} | \`${m.id}\` | \`${m.serverName}\` | ${entry} | ${ex} | ${m.timeoutMs ?? '—'} |`);
  });
  L.push('');

  const missing = mcp.filter((m) => !m.exists);
  if (missing.length) {
    L.push(`> ⚠️ ${missing.length} 个 MCP 的入口文件不存在：${missing.map((m) => m.id).join('、')}`);
    L.push('');
  }

  L.push('### 4.1 工作区源 ↔ `~\\.dsh\\` 已安装副本（SHA256 前 12 位）');
  L.push('');
  L.push('| 对象 | 工作区源 | src sha256 | 已安装副本 | dst sha256 | 结论 |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const h of hashes) {
    L.push(
      `| ${h.label} | \`${rel(h.src)}\` | ${h.srcHash || '—'} | \`${maskHome(h.dst)}\` | ${h.dstHash || '—'} | ${h.status}${h.note ? '（' + h.note + '）' : ''} |`
    );
  }
  L.push('');

  const bad = hashes.filter((h) => h.status !== '一致');
  if (bad.length) {
    L.push(`> ⚠️ ${bad.length} 项不是「一致」：${bad.map((h) => h.label + '=' + h.status).join('；')}。改完源文件记得跑 \`node qq-bridge\\scripts\\setup-dsh.mjs\` 同步。`);
    L.push('');
  }

  L.push('### 4.2 插件链接检测');
  L.push('');
  L.push(`安装位置：\`${maskHome(link.installed)}\``);
  L.push('');
  L.push(`工作区源：\`${rel(link.expected)}\``);
  L.push('');
  L.push(`- 判定：**${link.status}**${link.note ? `（${link.note}）` : ''}`);
  if (link.raw) L.push(`- readlink 原始返回值：\`${link.raw}\``);
  if (link.resolved) L.push(`- 解析目标：\`${link.resolved}\``);
  L.push('');
  return L;
}

// ---------------------------------------------------------------- 第 6 段：state 清单

function isTestArtifact(name) {
  return name.startsWith('_') || /test/i.test(name);
}

function collectState() {
  const ents = fs.readdirSync(STATE_DIR, { withFileTypes: true });
  const rows = [];
  for (const ent of ents) {
    const full = path.join(STATE_DIR, ent.name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch (e) {
      rows.push({ name: ent.name, kind: '未知', files: 0, bytes: 0, category: '无法读取：' + errText(e) });
      continue;
    }
    const isDir = st.isDirectory();
    const sub = isDir ? scanTree(full, new Set()) : { files: 1, bytes: st.size };
    let category;
    if (isTestArtifact(ent.name)) category = '测试产物（可清理）';
    else if (isDir) category = '运行时目录';
    else category = '生产状态文件';
    rows.push({
      name: ent.name,
      kind: isDir ? '目录' : '文件',
      files: sub.files,
      bytes: sub.bytes,
      category,
    });
  }
  rows.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  const tmpDir = rows.find((r) => r.name === '_tmp');
  const reclaim = rows.filter((r) => r.category === '测试产物（可清理）');
  return {
    rows,
    tmpDirExists: !!tmpDir,
    reclaimFiles: reclaim.reduce((a, r) => a + r.files, 0),
    reclaimBytes: reclaim.reduce((a, r) => a + r.bytes, 0),
  };
}

function renderState(sec) {
  const L = [];
  L.push('## 5. `qq-bridge/state/` 清单');
  L.push('');
  if (!sec.ok) return unusable('5. qq-bridge/state/ 清单', sec);
  const { rows, tmpDirExists, reclaimFiles, reclaimBytes } = sec.data;

  L.push('| 一级条目 | 类型 | 文件数 | 体积 | 分类 |');
  L.push('| --- | --- | ---: | ---: | --- |');
  for (const r of rows) {
    L.push(`| \`${r.name}\` | ${r.kind} | ${r.files} | ${mb(r.bytes)} MB | ${r.category} |`);
  }
  L.push('');
  L.push(`- \`_tmp\\\`：**${tmpDirExists ? '存在（测试产物，可整体清理）' : '当前不存在'}**`);
  L.push(`- 测试产物合计：**${reclaimFiles} 文件 / ${mb(reclaimBytes)} MB**（名字以 \`_\` 开头或含 test 的条目），理论上可清理；生产状态文件（\`sessions.json\`、\`mode.json\`、\`social-v2.json\` 等）**不要删**。`);
  L.push('');
  return L;
}

// ---------------------------------------------------------------- 第 7 段：文档清单

/**
 * 尽力解码文本：先用 fatal 模式判定「是不是合法 UTF-8」，不是再退到 gb18030。
 * 为什么不用「数 U+FFFD」来判定：合法 UTF-8 文件里本来就可能**字面包含** U+FFFD（本快照自己就会，
 * 因为它记录了别的文件的乱码），数法会把好文件误判成坏文件。fatal 模式只对非法字节序列报错，才是正确判据。
 * 这个工作区确实有 GBK 文件（PS 5.1 的 `>>` / Tee-Object 写的，见 docs\restart-report-*.log）。
 */
function decodeExact(buf, enc) {
  // 读取窗口末尾可能截断多字节序列，逐字节回退重试，避免把「截断」误判成「非法编码」
  for (let cut = 0; cut <= 3 && cut < buf.length; cut++) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf.subarray(0, buf.length - cut));
    } catch {
      /* 继续回退 */
    }
  }
  return null;
}

function decodeBest(buf) {
  const utf8 = decodeExact(buf, 'utf-8');
  if (utf8 !== null) return { text: utf8, encoding: 'utf-8', bad: 0, suspect: false };

  const gbk = decodeExact(buf, 'gb18030');
  if (gbk !== null) return { text: gbk, encoding: 'gb18030', bad: 0, suspect: true };

  // 两种都不合法（例如混编码文件）：按坏字符少的那种尽力解，并标注
  let best = null;
  for (const enc of ['utf-8', 'gb18030']) {
    let text;
    try {
      text = new TextDecoder(enc, { fatal: false }).decode(buf);
    } catch {
      continue;
    }
    const core = text.endsWith('\uFFFD') ? text.slice(0, -1) : text;
    const bad = (core.match(/\uFFFD/g) || []).length;
    if (!best || bad < best.bad) best = { text, encoding: enc, bad, suspect: true };
  }
  return best || { text: buf.toString('utf8'), encoding: 'utf-8', bad: 0, suspect: true };
}

function firstHeading(file) {
  let buf;
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(262144); // 文档都远小于 256 KB，够覆盖整个文件，避免截断
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    buf = buf.subarray(0, n);
  } catch (e) {
    return { heading: null, error: errText(e) };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* 关不掉也不影响结果 */ }
    }
  }
  const dec = decodeBest(buf);
  const raw = dec.text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  // 替换字符是「信息已丢失」的痕迹（上游把 GBK 输出按 UTF-8 解过一道），要计数并告警；
  // 同时把标题里的 U+FFFD 换成可读标记，免得本快照自己也带上 U+FFFD、下一轮把自己误判成坏文件。
  const badChars = (raw.match(/\uFFFD/g) || []).length;
  const m = raw.match(/^#\s+(.+?)\s*$/m);
  return {
    heading: m ? truncate(m[1].replace(/^#+\s*/, '').replace(/\uFFFD+/g, '⟨乱码⟩'), 60) : null,
    encoding: dec.encoding,
    badChars,
    suspect: dec.suspect || badChars > 0,
  };
}

function collectDocList() {
  const targets = [];
  const push = (p, tag) => targets.push({ path: p, tag });
  push(path.join(ROOT, 'AGENTS.md'), '根');
  try {
    for (const e of fs.readdirSync(DOCS_DIR, { withFileTypes: true })) {
      if (e.isFile()) push(path.join(DOCS_DIR, e.name), 'docs');
    }
  } catch (e) {
    targets.push({ path: DOCS_DIR, tag: 'docs', listError: errText(e) });
  }
  // README.en.md 已于 2026-09-23 归档进 docs/archive/（非活文档），不再列入清单；
  // 归档目录里的文件由下面的 BRIDGE_DOCS_DIR 扫描自然排除，别在这里硬编码已移动的路径。
  for (const n of ['README.md', 'RULES.md']) {
    push(path.join(ROOT, 'qq-bridge', n), 'qq-bridge');
  }
  try {
    for (const e of fs.readdirSync(BRIDGE_DOCS_DIR, { withFileTypes: true })) {
      if (e.isFile()) push(path.join(BRIDGE_DOCS_DIR, e.name), 'qq-bridge/docs');
    }
  } catch (e) {
    targets.push({ path: BRIDGE_DOCS_DIR, tag: 'qq-bridge/docs', listError: errText(e) });
  }

  return targets.map((t) => {
    if (t.listError) return { ...t, exists: false, error: t.listError };
    try {
      const st = fs.statSync(t.path);
      const h = firstHeading(t.path);
      return {
        ...t,
        exists: true,
        bytes: st.size,
        heading: h.heading,
        encoding: h.encoding,
        badChars: h.badChars,
        suspect: h.suspect,
        error: h.error || null,
      };
    } catch (e) {
      return { ...t, exists: false, error: errText(e) };
    }
  });
}

function renderDocList(sec) {
  const L = [];
  L.push('## 6. 文档清单（KB + 首个 `#` 标题，标题截断 60 字）');
  L.push('');
  if (!sec.ok) return unusable('6. 文档清单', sec);

  L.push('| 位置 | 文件 | KB | 首个 # 标题 |');
  L.push('| --- | --- | ---: | --- |');
  for (const d of sec.data) {
    const where = `\`${rel(path.dirname(d.path))}\``;
    const name = `\`${path.basename(d.path)}\``;
    if (!d.exists) {
      L.push(`| ${where} | ${name} | — | 不可用：${d.error} |`);
      continue;
    }
    const encNote = d.suspect
      ? (d.encoding !== 'utf-8'
        ? ` ⚠️ 非 UTF-8（按 gb18030 尽力解码${d.badChars ? `，${d.badChars} 处仍无法解码` : ''}）`
        : ` ⚠️ 含 ${d.badChars} 处替换字符 U+FFFD（上游把 GBK 输出按 UTF-8 解码过，信息已丢失）`)
      : '';
    L.push(`| ${where} | ${name} | ${kb(d.bytes)} | ${d.heading || '（无 # 标题）'}${encNote} |`);
  }
  L.push('');
  const suspect = sec.data.filter((d) => d.exists && d.suspect);
  if (suspect.length) {
    L.push(`> ⚠️ 有 ${suspect.length} 个文件的编码不是纯 UTF-8：${suspect.map((d) => '`' + path.basename(d.path) + '`').join('、')}。这类文件用 UTF-8 读会满屏替换字符（U+FFFD）或乱码，建议写它的工具统一改成 UTF-8（本工作区红线 #1 就是日志编码坑）。`);
    L.push('');
  }
  return L;
}

// ---------------------------------------------------------------- 汇总

function collectAll() {
  const sections = {
    topLevel: section('topLevel', collectTopLevel),
    src: section('src', collectSrc),
    scripts: section('scripts', collectScripts),
    mcp: section('mcp', collectMcp),
    state: section('state', collectState),
    docs: section('docs', collectDocList),
  };
  const now = new Date();
  return {
    generator: 'tools/structure-snapshot.mjs',
    root: ROOT,
    dshHome: DSH_HOME,
    generatedAt: localIso(now),
    timezoneOffset: offsetLabel(now),
    warnings: [
      `时区偏移 ${offsetLabel(now)}${offsetLabel(now) === '+08:00' ? '' : '（注意：本机不是 +08:00，文档里的 +08:00 假设可能不成立）'}`,
      ...Object.values(sections).filter((s) => !s.ok).map((s) => `段落「${s.name}」不可用：${s.error}`),
    ],
    sections,
    summary: {
      topLevelEntries: sections.topLevel.ok
        ? sections.topLevel.data.dirs.length + sections.topLevel.data.files.length
        : null,
      srcFiles: sections.src.ok ? sections.src.data.rows.length : null,
      srcLines: sections.src.ok ? sections.src.data.totalLines : null,
      bridgeLines: (() => {
        if (!sections.src.ok) return null;
        const b = sections.src.data.rows.find((r) => r.name === 'bridge.js');
        return b ? b.lines : null;
      })(),
      scriptFiles: sections.scripts.ok ? sections.scripts.data.total : null,
      scriptFilesRecursive: sections.scripts.ok
        ? sections.scripts.data.total + sections.scripts.data.subdirs.reduce((a, d) => a + d.files, 0)
        : null,
      mcpCount: sections.mcp.ok ? sections.mcp.data.patch.serverCount : null,
      mcpParseOk: sections.mcp.ok ? sections.mcp.data.patch.parseOk : null,
      mcpIds: sections.mcp.ok ? sections.mcp.data.mcp.map((m) => m.id) : null,
      mcpMissingEntry: sections.mcp.ok
        ? sections.mcp.data.mcp.filter((m) => !m.exists).map((m) => m.id)
        : null,
      hashMismatch: sections.mcp.ok
        ? sections.mcp.data.hashes.filter((h) => h.status !== '一致').map((h) => `${h.label}=${h.status}`)
        : null,
      pluginLink: sections.mcp.ok ? sections.mcp.data.link.status : null,
      stateReclaim: sections.state.ok
        ? { files: sections.state.data.reclaimFiles, bytes: sections.state.data.reclaimBytes }
        : null,
      docCount: sections.docs.ok ? sections.docs.data.filter((d) => d.exists).length : null,
    },
  };
}

/**
 * 结构数字指纹（digest）：渲染进文件末尾的 `<!-- snapshot-digest {…} -->`，`--json` 里也带一份。
 * 全部取自 collectAll() **已经算出来**的 summary / topLevel 段 —— 不另算一套口径
 * （「同一个值两份实现」正是本项目一直在消灭的东西）。
 * 消费方：tools\self-check.mjs 5.1 —— 它复算这几个数字来比对，而不是看 mtime。
 */
function buildDigest(snap) {
  const s = snap.summary;
  const topLevel = snap.sections.topLevel.ok ? snap.sections.topLevel.data : null;
  const pick = (arr, name, field) => (topLevel ? (arr.find((x) => x.name === name)?.[field] ?? null) : null);
  return {
    generatedAt: snap.generatedAt,
    numbers: {
      topLevelEntries: s.topLevelEntries,
      toolsFiles: pick(topLevel?.dirs ?? [], 'tools', 'files'),
      agentsMdBytes: pick(topLevel?.files ?? [], 'AGENTS.md', 'bytes'),
      srcFiles: s.srcFiles,
      srcLines: s.srcLines,
      bridgeLines: s.bridgeLines,
      scriptFiles: s.scriptFiles,
      scriptFilesRecursive: s.scriptFilesRecursive,
    },
  };
}

function renderMarkdown(snap) {
  const L = [];
  L.push('<!-- AUTO-GENERATED by tools/structure-snapshot.mjs — 不要手改，重跑脚本即可 -->');
  L.push('');
  L.push('# DSH 工作区结构快照');
  L.push('');
  L.push(`- 生成时间：\`${snap.generatedAt}\`（本地时间，UTC${snap.timezoneOffset}）`);
  L.push(`- 工作区根：\`${snap.root}\``);
  L.push(`- DSH 用户目录：\`${snap.dshHome ? maskHome(snap.dshHome) : '（未取到 USERPROFILE）'}\``);
  L.push('');
  L.push('> **这份文件是结构数字的唯一权威**：文档（`AGENTS.md`、`docs/文件清单.md` 等）里出现的结构数字应与它一致；不一致时以本文件为准，并重跑脚本刷新。');
  L.push('');

  const s = snap.summary;
  L.push('## 0. 关键数字速查');
  L.push('');
  L.push('| 指标 | 值 |');
  L.push('| --- | ---: |');
  L.push(`| 顶层条目数 | ${s.topLevelEntries ?? '不可用'} |`);
  L.push(`| \`qq-bridge/src/\` 文件数 | ${s.srcFiles ?? '不可用'} |`);
  L.push(`| \`qq-bridge/src/bridge.js\` 行数（按 LF 计） | ${s.bridgeLines ?? '不可用'} |`);
  L.push(`| \`qq-bridge/src/\` 总行数（按 LF 计） | ${s.srcLines ?? '不可用'} |`);
  L.push(`| \`qq-bridge/scripts/\` 顶层文件数 | ${s.scriptFiles ?? '不可用'} |`);
  L.push(`| \`qq-bridge/scripts/\` 递归文件数（含 _archive/） | ${s.scriptFilesRecursive ?? '不可用'} |`);
  L.push(`| 挂载的 MCP 数量 | ${s.mcpCount ?? '不可用'} |`);
  L.push(`| 入口文件缺失的 MCP | ${s.mcpMissingEntry ? (s.mcpMissingEntry.length ? s.mcpMissingEntry.join('、') : '无') : '不可用'} |`);
  L.push(`| 源↔已安装 不一致项 | ${s.hashMismatch ? (s.hashMismatch.length ? s.hashMismatch.join('；') : '无') : '不可用'} |`);
  L.push(`| qq-mode-console 插件链接 | ${s.pluginLink ?? '不可用'} |`);
  L.push(`| 文档数（本清单覆盖） | ${s.docCount ?? '不可用'} |`);
  L.push('');

  L.push(...renderTopLevel(snap.sections.topLevel));
  L.push(...renderSrc(snap.sections.src));
  L.push(...renderScripts(snap.sections.scripts));
  L.push(...renderMcp(snap.sections.mcp));
  L.push(...renderState(snap.sections.state));
  L.push(...renderDocList(snap.sections.docs));

  L.push('## 7. 说明');
  L.push('');
  L.push('- 本文件由脚本全量重算，**不要手工编辑**；改完目录结构/新增 MCP/同步 preset 后重跑即可。');
  L.push('- 脚本只读工作区（唯一写入目标就是本文件），不会删除、不会创建其它文件、不碰 `state\\`。');
  L.push('- 段落级容错：任一段失败会写「不可用：原因」，其余段落照常输出。');
  L.push('- ★ **`顶层条目数` 不计"瞬态条目"**（`.launcher-state.json` / `.panels-state.json`：工具在**工作区根**创建的本地一次性状态，用完/关掉即删）—— 它们来回出现会让这条判据自己红绿；名单、收录标准与逐条出处（文件:行）唯一口径 = `tools\\top-level-transient.mjs`，`tools\\self-check.mjs` 复算时调**同一个**判定。⚠ 名单只按**具名**条目跳过，**不用模式匹配**（否则会连 `.gitignore` / `.dsh` 这类真条目一起放过）。');
  L.push('- 文件**末尾**那行 `snapshot-digest` 注释是给 `tools/self-check.mjs` 用的**数字指纹**：自检比对这些数字判断快照是否过期（**不看 mtime**），所以「改了文件但数字没变」不再报过期；数字真变了它会点名是哪个（旧 → 新）；这行被手改坏也会被自检点名。');
  L.push('- 本文件自身也是 `docs\\` 下的一个文件，会被计入上面的 `docs\\` 文件数与文档清单（所以**首次生成**的那一次，数字会比实际少 1；第二次起自洽）。');
  L.push('');
  L.push('```bash');
  L.push('node tools/structure-snapshot.mjs          # 打印 + 覆盖写本文件');
  L.push('node tools/structure-snapshot.mjs --print  # 只打印');
  L.push('node tools/structure-snapshot.mjs --json   # 机器可读 JSON');
  L.push('```');
  L.push('');
  L.push('---');
  L.push('');
  L.push('重跑：`node tools/structure-snapshot.mjs`');
  L.push('');
  // 数字指纹放最后一行：人读时看不见，程序一眼找得到（self-check 5.1 的判据来源）。
  L.push(`<!-- snapshot-digest ${JSON.stringify(buildDigest(snap))} -->`);
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------- main

function main() {
  const snap = collectAll();
  const md = renderMarkdown(snap);

  let wrote = null;
  let writeError = null;
  if (!WANT_JSON && !WANT_PRINT) {
    try {
      fs.writeFileSync(OUT_FILE, Buffer.from(md, 'utf8')); // UTF-8 无 BOM，LF
      wrote = { path: OUT_FILE, bytes: Buffer.byteLength(md, 'utf8') };
    } catch (e) {
      writeError = errText(e);
    }
  } else if (WANT_JSON && FORCE_WRITE) {
    try {
      fs.writeFileSync(OUT_FILE, Buffer.from(md, 'utf8'));
      wrote = { path: OUT_FILE, bytes: Buffer.byteLength(md, 'utf8') };
    } catch (e) {
      writeError = errText(e);
    }
  }

  if (WANT_JSON) {
    const out = { ...snap, digest: buildDigest(snap), markdown: md, wrote, writeError };
    process.stdout.write(Buffer.from(JSON.stringify(out, null, 2), 'utf8'));
    return 0;
  }

  process.stdout.write(Buffer.from(md, 'utf8'));
  if (wrote) {
    process.stderr.write(Buffer.from(`[structure-snapshot] 已写入 ${wrote.path} (${wrote.bytes} 字节)\n`, 'utf8'));
  }
  if (writeError) {
    process.stderr.write(Buffer.from(`[structure-snapshot] 写文件失败：${writeError}\n`, 'utf8'));
    return 1;
  }
  return 0;
}

process.exitCode = main();
