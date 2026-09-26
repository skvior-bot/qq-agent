#!/usr/bin/env node
// AGENT-BOARD 留言板工具（**开发会话侧**）—— 主人 2026-09-23 深夜批准的一环：
// 「给她的反向信道」其实早就有了（`AGENT-BOARD.md` 两栏），她的 preset 也写了用法；
// 缺的一直是**我这边"开工先看她有没有留话"的动作** —— 以前要记路径、记两栏格式、手工追加。
//
// 用法：
//   node tools\board.mjs                  看她最新留言（标题全列 + 最新 2 条全文），并记下"读到哪"
//   node tools\board.mjs -n 5             最新 5 条全文
//   node tools\board.mjs --list           只列标题（最省 token）
//   node tools\board.mjs --all            她的全部条目全文
//   node tools\board.mjs --archive        连归档 AGENT-BOARD-archive.md 一起看
//   node tools\board.mjs --header         额外打印板子开头那段"给双方看的用法说明"
//   node tools\board.mjs --reply "文本"    回信：追加到「开发会话回我」栏末尾（**她下次唤醒会看到【留言板】提示**）
//   node tools\board.mjs --reply-file a.md 同 --reply，正文从文件读（**长正文、带格式的正文一律走这个**）
//     ⚠ --reply 要把正文挤进命令行 argv，而 PowerShell 会在两个地方悄悄改它：
//       ① **ASCII 双引号（"）**：被当成字符串边界 → 引号之后的正文根本进不了 node
//          （2026-09-24 线上实测两次：00:56 那条停在「口径是每」、20:54 那条停在「只会剩一个」，
//          都是断在一个 `"` 前面；600 字的探针也复现了同样的断法）。**现在工具会报错拒收**，
//          不会再往板子上写半截话 —— 但正文还是得改用 --reply-file。
//       ② **反引号（`）**：被 PowerShell 当转义符吃掉（正文照样完整，只是 `` `code` `` 的反引号没了）。
//          这个工具**检测不出来**（字符根本没到 node），所以正文里有反引号时也走 --reply-file。
//   node tools\board.mjs --title "标题"    给 --reply 指定标题（默认取正文第一行）
//   node tools\board.mjs --board <路径>    把板子指到别的文件（演练/测试用；等价的环境变量 AGENT_BOARD_FILE）
//   node tools\board.mjs --json           机器可读
//   node tools\board.mjs --selftest       自检：临时板子上跑一遍解析 + 追加 + 已读位置
//   node tools\board.mjs --peek           只看，不更新"已读位置"
//
// 为什么追加必须走这个工具：桥接是按「开发会话回我」这一栏的**指纹**决定要不要给她一行【留言板】提示的
// （见 qq-bridge\scripts\test-board-notice.mjs），位置或格式写歪了 → 要么她不被告知，要么反复被点亮。
// 工具只在文件**末尾**新起一栏追加，与回归网测过的行为一致；她自己的内容一个字都不动。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const QQ = path.join(ROOT, 'qq-bridge');
const MARK = path.join(QQ, 'state', '_tmp', 'board-lastread.json');
const HER = '我给开发会话';
const DEV = '开发会话回我';

// ── 找板子：config.json 的 sessionCwd 优先，缺省 state\agents（与桥接一致）
function boardDir() {
  let cwd = '';
  try {
    cwd = (JSON.parse(fs.readFileSync(path.join(QQ, 'config.json'), 'utf8')).sessionCwd || '').trim();
  } catch { /* 配置读不到就按默认 */ }
  return cwd ? path.resolve(QQ, cwd) : path.join(QQ, 'state', 'agents');
}
const DIR = boardDir();
const ARCHIVE = path.join(DIR, 'AGENT-BOARD-archive.md');
// 板子路径**可改**：--board <路径> 或环境变量 AGENT_BOARD_FILE（演练与回归网用 —— 板子是两个人的
// 公共信道，测试绝不能往真板子上写）。默认还是桥接认的那一个。
let BOARD = process.env.AGENT_BOARD_FILE ? path.resolve(process.env.AGENT_BOARD_FILE) : path.join(DIR, 'AGENT-BOARD.md');

// ── 解析：按 `##` 分栏（谁写的）、按 `### 时间 标题` 分条目
function parseBoard(text) {
  const out = [];
  let who = null;
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      who = h2[1].includes(HER) ? 'her' : h2[1].includes(DEV) ? 'dev' : null;
      cur = null;
      continue;
    }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) {
      const m = h3[1].match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s*(.*)$/);
      cur = { who, time: m ? m[1] : '', title: (m ? m[2] : h3[1]) || '(无标题)', body: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.body.push(line);
  }
  for (const e of out) {
    while (e.body.length && !e.body[e.body.length - 1].trim()) e.body.pop();
    while (e.body.length && /^---+$/.test(e.body[e.body.length - 1].trim())) e.body.pop();
    while (e.body.length && !e.body[e.body.length - 1].trim()) e.body.pop();
  }
  return out;
}

function readMarker() {
  try {
    const j = JSON.parse(fs.readFileSync(MARK, 'utf8'));
    return { her: Number(j.her) || 0, at: j.at || '' };
  } catch { return null; }
}
function writeMarker(her) {
  fs.mkdirSync(path.dirname(MARK), { recursive: true });
  fs.writeFileSync(MARK, JSON.stringify({ her, at: stamp() }, null, 2), 'utf8');
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function loadFile(file, label) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  return { file, label, text, entries: parseBoard(text) };
}

// ── 回信：正文与标题怎么切（**纯函数**，回归网直接测它，不用起子进程）
// 返回 { title, body, demoted }：demoted=true 表示"首行太长、标题装不下，已整行留在正文里"。
function replyParts(text, title) {
  let body = String(text ?? '').replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '').trim();
  if (!body) throw new Error('回信正文是空的');
  // 作者自己写了 `### 时间 标题` 时别再套一层：2026-09-24 实测套两层会留下一行
  // 「### <stamp> ### <时间> <标题前 60 字>」的鬼影标题，正文里还重复一个标题。
  // 同一天第二次实测：首行只要被当成标题（不管是 `###` 还是普通一行），正文里就必须**删掉它** ——
  // 否则条目长成「### <stamp> 标题 / 空行 / 标题 / 正文」，读起来像写重了。单行留言例外（删了就空了）。
  let auto = title;
  const lines = body.split('\n');
  const firstLine = lines[0].trim();
  const head = /^#{2,4}\s+(.*)$/.exec(firstLine);
  let stripped = false;
  if (head) {
    if (!auto) auto = head[1].trim();
    if (lines.length > 1) { body = lines.slice(1).join('\n').replace(/^\n+/, ''); stripped = true; }
  } else if (!auto) {
    auto = firstLine;
    if (lines.length > 1) { body = lines.slice(1).join('\n').replace(/^\n+/, ''); stripped = true; }
  }
  const full = String(auto || body.split('\n')[0] || '').trim();
  const t = full.slice(0, 60).trim();
  // ★ 标题只放 60 字（板子上是个标题，长了没法看），但**不许因此丢正文**：
  //   老实现到这里直接把首行整行从正文里删掉 —— 首行一旦超过 60 字，超出的那截标题装不下、
  //   正文里也没有，等于**静默吃掉半句话**。2026-09-24 线上实测就是它：20:54 那条的标题正好
  //   停在 60 字的 `+ ` 上，后半句没了（她读到的也是残缺版）。现在只要首行比标题长，就把整行
  //   留在正文开头 —— 去掉 `###` 记号，免得它在板子上又切出一个条目。
  let demoted = false;
  if (stripped && full.length > t.length + 1) {
    const plain = firstLine.replace(/^#{2,4}\s+/, '').trim();
    body = `${plain}\n\n${body}`.trim();
    demoted = true;
  }
  return { title: t || '(无标题)', body, demoted };
}

// ── 命令行解析：**多出来的位置参数一律报错**（2026-09-24 实测的静默截断）
// 形状：正文里带一个 ASCII 双引号 → PowerShell 在引号处把参数切开：
//   node tools\board.mjs --reply "前半句"后半句"   ⇒   argv = ['--reply','前半句','后半句']
// 老实现只取 --reply 后面那一个 token，**引号之后的正文全丢**，还照旧打印"已追加" ——
// 板上留半截话、发信的人以为发出去了。现在：认不出的参数直接拒收，并告诉你改用 --reply-file。
const BOOL_FLAGS = new Set(['--list', '--all', '--archive', '--header', '--json', '--peek', '--selftest']);
const VALUE_FLAGS = new Set(['--reply', '--reply-file', '--title', '--board', '-n']);

function parseArgv(argv) {
  const opts = { rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (BOOL_FLAGS.has(a)) { opts[a] = true; continue; }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} 后面要跟一个值`);
      opts[a] = v; i += 1; continue;
    }
    opts.rest.push(String(a));
  }
  const howTo = '   最常见的原因：正文里有一个 **ASCII 双引号（"）** —— PowerShell 把它当成字符串边界，\n'
    + '   引号**之后**的正文根本没进到 node（这就是"回信只写上去半截"的真凶，2026-09-24 两次线上实测）。\n'
    + '   解决办法：把正文写进一个 .md 文件，再 `node tools\\board.mjs --reply-file 那个文件`；\n'
    + '   顺手也把正文里的 ASCII 双引号换成「」，反引号同样会被 PowerShell 吃掉（那个检测不出来）。';
  if (opts.rest.length) {
    const show = opts.rest.map((s) => JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s)).join('、');
    throw new Error(`命令行里有 ${opts.rest.length} 个认不出的参数：${show}\n${howTo}`);
  }
  // 回信模式**只认四个开关**：正文被切开时，残片有可能恰好长成 `--all` 这种开关的样子，
  // 只查"认不出的参数"会漏掉它 —— 所以这里按"白名单之外一律拒收"再兜一层。
  if (opts['--reply'] !== undefined || opts['--reply-file'] !== undefined) {
    const allowed = new Set(['--reply', '--reply-file', '--title', '--board']);
    const bad = Object.keys(opts).filter((k) => k !== 'rest' && !allowed.has(k));
    if (bad.length) throw new Error(`回信模式下不认识这些开关：${bad.join(' ')}\n${howTo}`);
  }
  return opts;
}

// ── 回信：只在末尾新起一栏追加（= 回归网测过的"会点亮她提示"的写法）
function reply(text, title) {
  const { title: t, body, demoted } = replyParts(text, title);
  let headText = '';
  if (fs.existsSync(BOARD)) {
    headText = fs.readFileSync(BOARD, 'utf8');
    if (headText && !headText.endsWith('\n')) headText += '\n';
  } else {
    fs.mkdirSync(path.dirname(BOARD), { recursive: true });
    headText = `# AGENT-BOARD —— 小鲸鱼（QQ 侧）× 开发会话 留言板\n`;
  }
  const block = `\n## ${DEV}\n\n### ${stamp()} ${t}\n\n${body}\n`;
  fs.appendFileSync(BOARD, block, 'utf8');
  // 写完回读一次：真写进去了多少字符，当场就能对（谁在中间截了都会露馅，不用等对方读到半截话）。
  let verified = false;
  try { verified = fs.readFileSync(BOARD, 'utf8').endsWith(block); } catch { /* 读不回来就当没验上 */ }
  return { block, demoted, verified, chars: body.length };
}

// ── 自检：临时板子上把"解析 / 分类 / 已读位置 / 追加不破坏原文"跑一遍
function selftest() {
  const tmp = fs.mkdtempSync(path.join(ROOT, 'qq-bridge', 'state', '_tmp', 'board-selftest-'));
  const f = path.join(tmp, 'AGENT-BOARD.md');
  const seed = [
    '# AGENT-BOARD —— 测试用', '',
    '## 我给开发会话', '',
    '### 2026-09-23 18:13 她的第一条', '', '- 正文 A', '',
    '## 开发会话回我', '',
    '### 2026-09-23 18:20 我的回信', '', '- 正文 B', '',
    '## 我给开发会话', '',
    '### 2026-09-23 18:39 她在末尾另起一栏（桥接踩过的坑）', '', '- 正文 C', '',
  ].join('\n');
  fs.writeFileSync(f, seed, 'utf8');
  let pass = 0; const fails = [];
  const ok = (c, l) => { if (c) { pass++; console.log('  ✅ ' + l); } else { fails.push(l); console.log('  ❌ ' + l); } };

  const e = parseBoard(fs.readFileSync(f, 'utf8'));
  const her = e.filter((x) => x.who === 'her');
  const dev = e.filter((x) => x.who === 'dev');
  ok(e.length === 3, `解析出 3 条（实测 ${e.length}）`);
  ok(her.length === 2 && dev.length === 1, `归属正确：她的 2 条 / 我的 1 条（实测 ${her.length}/${dev.length}）`);
  ok(her[1].title === '她在末尾另起一栏（桥接踩过的坑）', '末尾另起一栏也算她的（不会被漏掉）');
  ok(her[0].time === '2026-09-23 18:13' && her[0].body.join('\n').trim() === '- 正文 A', '时间与正文切得干净');

  const before = fs.readFileSync(f, 'utf8');
  const savedBoard = BOARD;
  let block;
  try {
    // 直接对临时文件走同一套追加逻辑（绕开真实板子）
    const head = before.endsWith('\n') ? before : before + '\n';
    block = `\n## ${DEV}\n\n### ${stamp()} 自检回信\n\n- 正文 D\n`;
    fs.writeFileSync(f, head + block, 'utf8');
  } finally { void savedBoard; }
  const after = fs.readFileSync(f, 'utf8');
  ok(after.startsWith(before.replace(/\n?$/, '\n')), '追加不动原文（前缀逐字保留）');
  ok(parseBoard(after).filter((x) => x.who === 'dev').length === 2, '追加后我的条目 +1');
  ok(block.includes('## 开发会话回我'), '回信是新起一栏（桥接认这种）');

  // 已读位置：**原样存取**（连 at 一起还原）—— 自检是"验一下写读",不该把开发侧真实的
  // "上次读到哪/什么时候读的"改掉（改掉之后下一个人看到的时间戳是假的）。
  const saved = fs.existsSync(MARK) ? fs.readFileSync(MARK, 'utf8') : null;
  writeMarker(2);
  ok(readMarker().her === 2, '已读位置能存能读');
  if (saved !== null) fs.writeFileSync(MARK, saved, 'utf8'); else fs.rmSync(MARK, { force: true });

  // ── 2026-09-24 补：截断这两条（她报的「长正文只剩前半段」）────────────────────────
  // 注意：这里的长度数字**别写成端口号**（3000/3080/… 会被 self-check 5.13 的端口棘轮当成新增端口字面量）。
  console.log('\n── 长正文 / 标题超长（2026-09-24 实测的静默截断）──');
  const long = '### 2026-09-24 21:05 ' + '标'.repeat(80) + '\n\n' + '正'.repeat(2500);
  const p = replyParts(long);
  ok(p.title.length <= 60, `标题切到 60 字以内（实测 ${p.title.length}）`);
  ok(p.body.includes('标'.repeat(80)), '★ 首行超长时**整行留在正文里**（老实现在这里丢正文）');
  ok(p.demoted === true, '首行超长 → 标记 demoted（命令行会说出来）');
  ok(p.body.includes('正'.repeat(2500)), `2500 字正文一字不少（实测 ${p.body.length} 字）`);
  ok(replyParts('### 短标题\n\n正文').demoted === false, '首行不超长时照旧不当正文（不重复）');
  ok(replyParts('### 短标题\n\n正文').body.trim() === '正文', '首行不超长时正文里没有它');
  const crlf = replyParts('### 标题\r\n\r\n行1\r\n行2  \r\n');
  ok(crlf.body === '行1\n行2', `CRLF 与行尾空白归一化（实测 ${JSON.stringify(crlf.body)}）`);
  ok(replyParts('\uFEFF正文').body === '正文', 'BOM 被吃掉（PS 的 Out-File 会加）');

  console.log('\n── 命令行：被 PowerShell 切开的残片必须报错，不许写半截话 ──');
  const err = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const splitMsg = err(() => parseArgv(['--reply', '前半句', '后半句']));
  ok(Boolean(splitMsg), '★ 正文被切成两段 → 拒收（老实现会把「前半句」写进板子）');
  ok(Boolean(splitMsg) && splitMsg.includes('--reply-file'), '报错里指名 --reply-file 这条出路');
  ok(Boolean(err(() => parseArgv(['--reply', '正文', '--all']))), '残片伪装成开关（--all）也拒收');
  ok(Boolean(err(() => parseArgv(['--nope']))), '不认识的开关拒收');
  ok(err(() => parseArgv(['--reply', '正常正文', '--title', '正常标题'])) === null, '正常写法放行');
  ok(err(() => parseArgv(['--reply-file', 'a.md'])) === null, '--reply-file 放行');
  ok(err(() => parseArgv(['--list', '--json'])) === null, '只读那几个开关照旧放行');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
  return fails.length ? 1 : 0;
}

// ── 主流程（只有"被当脚本直接跑"时才执行；被 import 的回归网不会触发它）
const isMain = (() => {
  try { return Boolean(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url; }
  catch { return false; }
})();

function run() {
  let opts;
  try {
    opts = parseArgv(process.argv.slice(2));
  } catch (err) {
    console.error('❌ ' + err.message);
    return 1;
  }
  if (opts['--board']) BOARD = path.resolve(opts['--board']);

  if (opts['--selftest']) return selftest();

  if (opts['--reply'] !== undefined || opts['--reply-file'] !== undefined) {
    const file = opts['--reply-file'];
    let text = opts['--reply'];
    if (file !== undefined) {
      try {
        text = fs.readFileSync(path.resolve(file), 'utf8');
      } catch (err) {
        console.error(`❌ 读不到 --reply-file 给的文件：${path.resolve(file)}（${err.code || err.message}）`);
        return 1;
      }
    }
    if (!text) { console.error('❌ --reply 后面要跟正文（或改用 --reply-file <路径>）'); return 1; }
    try {
      const r = reply(text, opts['--title']);
      console.log(`✅ 已追加到 ${path.relative(ROOT, BOARD)}（末尾新起「${DEV}」栏，正文 ${r.chars} 字${r.demoted ? '；首行超长已整行留在正文开头' : ''}）：\n${r.block}`);
      console.log(r.verified ? '✅ 回读核对：写进去的与要写的一字不差。' : '⚠️ 回读核对没对上（有别人同时在写板子？）—— 自己再读一眼板尾。');
      console.log('ℹ️  她下次被唤醒时会看到一行【留言板】提示，然后自己来读 —— 不用你去 QQ 里叫她。');
    } catch (err) {
      console.error('❌ 回信失败：' + err.message);
      return 1;
    }
    return 0;
  }

  const boardFile = loadFile(BOARD, '现行板子');
  if (!boardFile) {
    console.error(`❌ 找不到留言板：${BOARD}`);
    console.error(`   （桥接按 config.json 的 sessionCwd 找它，缺省是 qq-bridge\\state\\agents；确认她那边建过 AGENT-BOARD.md）`);
    return 1;
  }
  const arch = opts['--archive'] ? loadFile(ARCHIVE, '归档') : null;
  const her = boardFile.entries.filter((e) => e.who === 'her');
  const mine = boardFile.entries.filter((e) => e.who === 'dev');
  const mark = readMarker();
  const n = Number(opts['-n']) || (opts['--all'] ? her.length : 2);

  if (opts['--json']) {
    console.log(JSON.stringify({
      board: BOARD, total: boardFile.entries.length, her: her.length, dev: mine.length,
      newSinceLastRead: mark ? Math.max(0, her.length - mark.her) : null,
      entries: her.slice(-n).map((e) => ({ time: e.time, title: e.title, body: e.body.join('\n').trim() })),
    }, null, 2));
    if (!opts['--peek']) writeMarker(her.length);
    return 0;
  }

  console.log(`📋 留言板：${path.relative(ROOT, BOARD)}（她 ${her.length} 条 / 我 ${mine.length} 条` + (arch ? `；归档另 ${arch.entries.length} 条` : '') + '）');
  if (mark) {
    const delta = her.length - mark.her;
    if (delta > 0) console.log(`🔔 上次读到（${mark.at}）之后，她又写了 ${delta} 条 —— 下面最后 ${Math.min(n, delta)} 条是新的`);
    else if (delta === 0) console.log(`ℹ️  上次读到（${mark.at}）之后她没有新留言`);
    else console.log(`ℹ️  板子似乎归档过（上次读到第 ${mark.her} 条，现在只剩 ${her.length} 条）—— 旧账在 ${path.basename(ARCHIVE)}`);
  } else {
    console.log('ℹ️  没有已读位置（第一次读 / _tmp 被清过）—— 下面是最近几条');
  }
  if (opts['--header']) {
    const head = boardFile.text.split(/\r?\n/).slice(0, 16).join('\n').trim();
    console.log('\n── 板子开头（给双方看的用法）──\n' + head);
  }
  console.log(`\n她的留言（共 ${her.length} 条，时间正序）：`);
  her.forEach((e, i) => console.log(`  ${String(i + 1).padStart(2)}. ${e.time || '????'}  ${e.title}`));
  console.log(`\n最近 ${Math.min(n, her.length)} 条全文：`);
  for (const e of her.slice(-n)) {
    console.log(`\n【${e.time}】${e.title}`);
    console.log(e.body.join('\n').replace(/^\s*\n/, '').trim() || '(无正文)');
  }
  if (arch) {
    console.log(`\n── 归档（${path.basename(ARCHIVE)}，${arch.entries.length} 条）标题 ──`);
    for (const e of arch.entries.filter((x) => x.who === 'her')) console.log(`  ${e.time || '????'}  ${e.title}`);
  }
  if (!opts['--peek']) writeMarker(her.length);
  console.log(`\nℹ️  回信：node tools\\board.mjs --reply-file 回信.md（长正文/带格式的正文都走这个；会追加到「${DEV}」栏，她下次唤醒就会看到提示）`);
  return 0;
}

if (isMain) process.exit(run());

export { parseBoard, replyParts, parseArgv, reply, selftest, run, BOARD, HER, DEV, DIR };
