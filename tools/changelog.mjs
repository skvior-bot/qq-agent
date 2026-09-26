#!/usr/bin/env node
// 变更日志（2026-09-24 主人定的硬规矩："以后所有改动都要对好文档，文档系统是项目的记忆中心，
// 一定要留下记录可以让其他程序查询"）。
//
// 为什么不是只写 Markdown：`docs\规则与踩坑日志.md` 是给人读的散文，**程序不好查**。这里用
// **JSONL**（每行一个 JSON）存一条条改动，既能人读，也能被脚本/session 直接 `list --json` 查。
//
// 存储：docs\变更日志.jsonl（UTF-8 无 BOM，一行一条，只追加）
// 字段：ts(本地 ISO 时间) / commit(短哈希) / kind(feat|fix|docs|chore|refactor) / summary /
//       files(改了哪些文件) / docs(同步了哪些文档) / note(可选补充)
//
// 用法：
//   node tools\changelog.mjs add --kind fix --summary "桥接自愈" --files "tools/ensure-bridge.ps1" --docs "docs/启动与踩坑.md"
//   ★ add 之前必须**先 commit 改动**（顺序闸见下），确实要在大批未提交时记一条才加 `--allow-dirty`
//   node tools\changelog.mjs amend --files "…" [--docs "…"] [--ts 2026-09-24T11:05]   # 给最后一条**追加** files/docs
//   node tools\changelog.mjs list                 # 最近 10 条（人读）
//   node tools\changelog.mjs list --n 30 --kind fix
//   node tools\changelog.mjs list --since 2026-09-24 --json     # 给程序查
//   node tools\changelog.mjs check                # 日志比最新提交旧 ⇒ 提醒（退出码 4）
//
// ★ 顺序（2026-09-26 起**机械**拦，光写注释没用）：① `git commit` 落改动 → ② `changelog add` 条目
//   （此刻 HEAD **就是**那次改动）→ ③ 再单独提交本 jsonl。顺序错了条目 `commit` 记成**父提交**。
//   · 2026-09-26 之前的历史条目 `commit` 为空（有值的也大概率错位一位）；新顺序上线初期同样可能"错位
//     一位" —— **以顺序闸拦下之后写入的条目为准**，更早的**不回填、不重写**（拿时间戳猜提交 = 伪造
//     可追溯性，比空着更坏）。
//   · 判据：条目里的 `dirty:true` / `dirtyWhy` 就是"这条不是照规矩写的"的标记。
//
// amend 的存在理由：常有「先记 changelog、后又改了文档/文件」——那条记录的 --files/--docs 就过期了。
//   它**只允许追加** files/docs（自动去重，默认改最后一条，`--ts` 可指定某一条），
//   summary / kind / ts / commit / note **一个字都不许改** —— 历史要可信，写错了就再记一条新的。
// 退出码：0 正常；2 参数错 / 顺序闸未过（脏树，或判不了顺序且没给 --allow-dirty）；4 check 发现日志落后；
//         5 check 的 `git` 压根没跑成（"判不了"≠"不落后"）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CHANGELOG_FILE：**只给夹具/回归网用**的落盘位置覆盖 —— 否则要验"干净树能正常写"就只能拿真
//   `docs\变更日志.jsonl` 反复备份/还原，那是在赌唯一那份"能被程序查的记录"不出事。
//   默认（生产用法）一个字不变：`docs\变更日志.jsonl`。
const FILE = process.env.CHANGELOG_FILE
  ? path.resolve(process.env.CHANGELOG_FILE)
  : path.join(ROOT, 'docs', '变更日志.jsonl');
const KINDS = ['feat', 'fix', 'docs', 'chore', 'refactor'];

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const hasFlag = (n) => argv.includes('--' + n);
const opt = (n, dflt = '') => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
};
const listOf = (s) => String(s || '').split(/[,，]/).map((x) => x.trim()).filter(Boolean);
const die = (m) => { console.error('✗ ' + m); process.exit(2); };
/** 跑 git，**失败原因要能传出来**。
 *  ★ 2026-09-25 修：旧写法是 `catch { return dflt }`，把一切都吞成"空输出" —— 在 DSH 沙箱里
 *  `execFileSync('git', …)` 是 **EPERM**（Node 用管道 stdio 抓子进程输出会被拒），于是
 *  `check` 打印"（不是 git 仓库或没有提交，跳过检查）"并 **exit 0** ⇒ **假绿灯**（明明在 git 仓库里）。
 *  现在区分：`ok` / `denied`（沙箱拒绝，不是"没有 git"）/ 其它失败。
 *
 *  ★★ 2026-09-26（§2.4 fd 改写）：**彻底不用管道** —— stdout / stderr 各落**一个临时文件**
 *  （`fs.openSync(file,'w')` 拿 fd，`stdio: ['ignore', fdOut, fdErr]`），跑完把文件**读回来**
 *  并 `trim()`（原行为就是 `.trim()`）。
 *  · 为什么不能用管道：本机受限模式下 Node 开**命名管道**会被拒 —— `execFileSync` / `spawnSync`
 *    只要 stdio 里出现 `'pipe'`（**包括默认值**）就必然 **EPERM**（`code='EPERM'`、`status=null`）。
 *  · **探针实测**（`qq-bridge\state\_archive\tmp-20260926\sub22-24\probe-eprem.mjs` —— 跑完从
 *    `state\_tmp\` 归档到这里；同一次运行内四种写法对照）：
 *      A `execFileSync(git, …, pipe)`   ⇒ FAIL  code=EPERM status=null
 *      B `spawnSync(git, …, pipe)`      ⇒ FAIL  code=EPERM
 *      C `spawnSync(git, …, fd,fd)`     ⇒ OK    status=0 stdout="9092065" stderr=""
 *      D `spawnSync(git, …, fd,ignore)` ⇒ OK    status=0 stdout="9092065"
 *    ⇒ 管道不是"偶尔抽风"而是**必然**，fd 法**零 EPERM**：换 fd 之后沙箱内外都能真跑。
 *  · stderr **也收**：失败时说得清为什么（旧写法把 stderr 一起丢，只剩一句"调用失败"）。
 *  · 临时文件：优先 `os.tmpdir()`，写不了才退到仓库内 `qq-bridge\state\_tmp\`（`state\` 是 gitignore
 *    的 ⇒ 不会脏工作树）；**`finally` 里必删**，失败路径也不许留垃圾。
 *  · `ok` / `denied`(EPERM|EACCES) / 其它失败 三态与 `why` 文案保持原样
 *    （"**不是**"没有 git""那句是有血的原因，别删）。
 */
let tmpSeq = 0;
function openTmp(tag) {
  const name = `dsh-changelog-git-${process.pid}-${++tmpSeq}-${tag}.txt`;
  let last = null;
  for (const d of [os.tmpdir(), path.join(ROOT, 'qq-bridge', 'state', '_tmp')]) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const file = path.join(d, name);
      return { fd: fs.openSync(file, 'w'), file };
    } catch (e) { last = e; }
  }
  throw last ?? new Error('没有可写的临时目录');
}
const closeQuiet = (t) => { if (t && t.fd != null) { try { fs.closeSync(t.fd); } catch { /* 已关 */ } t.fd = null; } };
// ★ 读回来**不整体 trim**（原行为是 `.trim()`）：原意是"去掉行尾那个换行"，但那也会吃掉**行首** ——
//   而 `git status --porcelain` 的**行首第一列就是状态列**（` M path`）。整体 trim ⇒ 第一行少一列，
//   打印出来的"porcelain 原文"就不是原文了（push-to-server 那边实测把 CONTRIBUTING.md 报成 ONTRIBUTING.md）。
//   ⇒ 统一成"只去行尾空白"：单行输出（`git log -1 --format=…`）与原来的 `.trim()` **完全等价**。
const readQuiet = (t) => { try { return fs.readFileSync(t.file, 'utf8'); } catch { return ''; } };
const trimEnd = (s) => s.replace(/\s+$/, '');

const gitTry = (args) => {
  const tmps = [];
  try {
    const o = openTmp('out'); tmps.push(o);
    const er = openTmp('err'); tmps.push(er);
    const r = spawnSync('git', args, { cwd: ROOT, stdio: ['ignore', o.fd, er.fd], timeout: 30000 });
    closeQuiet(o); closeQuiet(er);                       // 先关写句柄再读，别在 Windows 上跟自己较劲
    const out = trimEnd(readQuiet(o));                   // 只去行尾（行首是 porcelain 的状态列，别动）
    const err = readQuiet(er).trim();
    const why1 = err ? `：${err.split('\n')[0]}` : '';
    if (r.error) {                                       // 进程压根没起来（EPERM / ENOENT / 超时）
      const code = r.error.code || 'unknown';
      const denied = code === 'EPERM' || code === 'EACCES';
      return {
        ok: false, out: '', err, code,
        why: denied
          ? `被沙箱/权限拒绝（${code}）—— **不是**"没有 git"，而是这个终端不许 Node 抓子进程输出；请在普通终端（或允许 spawn 的会话）里跑`
          : `git 调用失败（${code}）${why1}`,
      };
    }
    if (r.status !== 0) {                                // 起来了但退出码非 0（这时 stderr 就是原因）
      const code = r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
      return { ok: false, out, err, code, why: `git 调用失败（${code}）${why1}` };
    }
    return { ok: true, out, err, why: '' };
  } catch (e) {                                          // 连临时文件都开不出来
    const code = e?.code || 'unknown';
    return { ok: false, out: '', err: '', code, why: `git 调用失败（${code}）${e?.message ? `：${e.message}` : ''}` };
  } finally {
    for (const t of tmps) { closeQuiet(t); try { fs.unlinkSync(t.file); } catch { /* 失败也不能留垃圾 */ } }
  }
};
const git = (args, dflt = '') => { const r = gitTry(args); return r.ok ? r.out : dflt; };

// ★★ 零 spawn 读 HEAD（2026-09-26 21:5x，协调线裁决①；复核线实测打回）：本机两种受限模式下 Node
//   **不许用管道抓子进程输出**（EPERM）⇒ 老写法 `git rev-parse --short HEAD` **永远**读不到 ⇒
//   `commit` 字段长期留空（实测：10:56 之后 83 条里只有 1 条有值、全库 322/377 为空）⇒
//   **"落盘了" ≠ "可追溯"**（`变更日志.jsonl` 是唯一能被程序查的那份，而最关键的"落在哪个提交"是空的）。
//   修法：直接**读文件**拿 HEAD —— `.git\HEAD` ⇒ loose ref ⇒ `packed-refs` ⇒ detached HEAD，
//   **零 spawn、零沙箱依赖**。
//   ★ fail-loud（同一条裁决）：任何一环读不到 ⇒ 明确写 `(读不到 git：<为什么>)`，**不留空** ——
//     空值与"读不到"长得一模一样，那正是这个字段的第二个毛病。
//   ⚠ 短 id 取**前 7 位**：与历史那几十条有值条目同形状（`rev-parse --short` 默认 7）。
//     **不做唯一性延长** —— 这条差别如实写在这里，别把它当成"与 git 完全等价"。
function readHeadShort() {
  try {
    const gitPath = path.join(ROOT, '.git');
    let dir = gitPath;
    if (!fs.existsSync(gitPath)) return { err: `.git 不在（${ROOT} 不是 git 工作树？）` };
    if (fs.statSync(gitPath).isFile()) {           // worktree：.git 是文件，内容 `gitdir: <路径>`
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'));
      if (!m) return { err: '.git 是文件但不是 gitdir 指针' };
      dir = path.resolve(ROOT, m[1].trim());
    }
    const head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim();
    const rm = /^ref:\s*(.+)$/.exec(head);
    let sha = '';
    if (rm) {
      const ref = rm[1].trim();
      const loose = path.join(dir, ref);
      if (fs.existsSync(loose)) sha = fs.readFileSync(loose, 'utf8').trim();
      else {
        const pk = path.join(dir, 'packed-refs');   // clone 之后 refs 会被打包进这一个文件
        if (fs.existsSync(pk)) {
          const line = fs.readFileSync(pk, 'utf8').split('\n').find((l) => l.trim().endsWith(' ' + ref));
          if (line) sha = line.trim().split(/\s+/)[0];
        }
        if (!sha) return { err: `HEAD 指向 ${ref}，但那份 ref 不在（loose 与 packed-refs 都没有）` };
      }
    } else if (/^[0-9a-f]{7,40}$/i.test(head)) sha = head;   // detached HEAD
    else return { err: `HEAD 内容看不懂：${head.slice(0, 40)}` };
    if (!/^[0-9a-f]{7,40}$/i.test(sha)) return { err: `ref 里不是提交 id：${sha.slice(0, 40)}` };
    return { ok: true, short: sha.slice(0, 7), full: sha };
  } catch (e) { return { err: e.message }; }
}
const USAGE = `用法：node tools\\changelog.mjs <命令> [参数]

  add   --kind feat|fix|docs|chore|refactor --summary "…" --files "a,b" --docs "c,d" [--note "…"] [--allow-dirty]
        记一条改动：--files 必填，--docs 也必填（确实不用改文档才显式 --no-docs）
        ★ 顺序闸：add **之前**这批改动必须已经 \`git commit\`（闸会跑
          \`git status --porcelain -- <--files ∪ --docs>\`）；**非空 ⇒ 拒写**（exit 2 + 印出脏路径）。
          理由：条目写在提交之前 ⇒ \`commit\` 记的是**父提交**。跑不成 \`git status\`（EPERM/没有 git…）
          ⇒ 也**拒写**并明说"判不了顺序、commit 可能是父提交"。
        ★ \`--allow-dirty\` = **显式放行**：脏树 / 判不了时才允许写，条目里留 \`dirty:true\`（判不了再加
          \`dirtyWhy\`），输出里也明说。它是出口，不是默认。
  amend --files "a,b" [--docs "c,d"] [--ts 2026-09-24T11:05]
        给**已有**记录**追加** files/docs（自动去重）：默认改最后一条，--ts 可指定（可只给前缀）；
        summary / kind / ts / commit / note 一律不许改 —— 历史要可信，写错了再 add 一条
  list  [--n 10] [--kind fix] [--since 2026-09-24] [--grep 正则] [--json]
  check [--quiet]              日志比最新提交旧就提醒（退出码 4）
  help                         本帮助
落盘：docs\\变更日志.jsonl（UTF-8 无 BOM，一行一条 JSON）。`;

function readAll() {
  if (!fs.existsSync(FILE)) return [];
  const out = [];
  for (const line of fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* 坏行跳过：日志宁可不完整也不能崩 */ }
  }
  return out;
}

if (cmd === 'help' || hasFlag('help') || hasFlag('h')) {
  console.log(USAGE);
  process.exit(0);
}

if (cmd === 'add') {
  const summary = opt('summary');
  if (!summary) die('缺少 --summary "一句话说明这次改了什么"');
  const kind = opt('kind', 'chore');
  if (!KINDS.includes(kind)) die(`--kind 只能是 ${KINDS.join(' / ')}`);
  const files = listOf(opt('files'));
  const docs = listOf(opt('docs'));
  if (files.length === 0) die('缺少 --files "改了哪些文件（逗号分隔）" —— 记录必须说清动了什么');
  if (docs.length === 0 && !hasFlag('no-docs')) {
    die('缺少 --docs "同步了哪些文档"（主人规矩：改动必须对好文档）。确实不需要改文档时显式加 --no-docs');
  }

  // ★★ 前置闸（§2.3②，2026-09-26）：写条目**之前**先确认这批改动**已经提交** —— 顺序错了条目就是废的。
  //   ★ 为什么必须是**机械闸**、而不是只写在头注里：这条顺序**已被当场证伪三次，且三次全部由立规矩的
  //     人本人违反** —— `b536b4b`（第一次）· `44b40c8`（同一小时内第二次）· `cfba2c6`（第三次，就在
  //     刚才）；机制每次一模一样：「改文件 → `changelog add` → 再把两件一起提交」⇒ 条目的 `commit`
  //     记成**父提交**。**写在注释里的规矩拦不住人，只有机器拦得住。**
  //   ★ 路径**原样**交给 git：`--files` / `--docs` 里写的是**仓库相对、正斜杠**（如 `tools/export-a.mjs`），
  //     不许自作主张转绝对路径或反斜杠（转了就不是同一个 pathspec，闸就形同虚设）；对**不存在**的路径
  //     `git status --porcelain -- <paths>` 正常返回空 —— 这没关系，闸只关心"列到的这些有没有脏"。
  const allowDirty = hasFlag('allow-dirty');
  const watch = [...new Set([...files, ...(hasFlag('no-docs') ? [] : docs)])];
  const gate = watch.length ? gitTry(['status', '--porcelain', '--', ...watch]) : { ok: true, out: '' };
  const gateDirty = gate.ok ? gate.out.trim() : '';
  // 三态：clean（闸过了）/ dirty（有未提交改动）/ unknown（跑不成 git status ⇒ 判不了顺序）
  let dirtyState = !gate.ok ? 'unknown' : (gateDirty ? 'dirty' : 'clean');
  if (dirtyState === 'dirty') {
    if (!allowDirty) {
      die('这些改动还没提交 ⇒ 现在写下的 `commit` 会是**父提交**。先 `git commit`，再 `add`。\n'
        + '  还没提交的路径（`git status --porcelain -- <--files ∪ --docs>` 原文）：\n'
        + gateDirty.split('\n').map((l) => '    ' + l).join('\n')
        + '\n  （确实要现在记一条 ⇒ 显式放行：`--allow-dirty`，条目里会留 `dirty:true` 的痕。）');
    }
    console.error('  ⚠ 工作树是脏的 —— 下面这些还没提交：');
    console.error(gateDirty.split('\n').map((l) => '    ' + l).join('\n'));
    console.error('    ⇒ **本次按显式放行写入，`commit` 可能是父提交**（条目里记 `dirty:true`）。');
  } else if (dirtyState === 'unknown') {
    // ★ 判不了 ⇒ **fail-loud**（§2.3③）：不许静默当干净照写，也不许把"我没跑成"说成"顺序没问题"。
    if (!allowDirty) {
      die(`本次无法判断顺序：\`git status\` 跑不成（${gate.why}）\n`
        + '  ⇒ 现在写下的 `commit` **可能是父提交**（也没法确认它就是这次改动）。\n'
        + '  先修好 git（普通终端里复跑本命令），或者**显式放行**：`--allow-dirty`（条目里留痕 + 写明原因）。');
    }
    console.error(`  ⚠ 本次无法判断顺序：\`git status\` 跑不成（${gate.why}）`);
    console.error('    ⇒ **本次按显式放行写入，`commit` 可能是父提交**（条目里记 `dirty:true` + 原因）。');
  }

  const ts = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const localIso = `${ts.getFullYear()}-${pad(ts.getMonth() + 1)}-${pad(ts.getDate())}T${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}+08:00`;
  const headTry = readHeadShort();
  const entry = {
    ts: localIso,
    commit: headTry.ok ? headTry.short : `(读不到 git：${headTry.err})`,
    kind,
    summary,
    files,
    docs: hasFlag('no-docs') ? [] : docs,
  };
  const note = opt('note');
  if (note) entry.note = note;
  // 放行才留痕：**只写 `dirty:true` 是不够的** —— "脏树"和"判不了"是两件事，看条目的人有权知道是哪一种。
  if (dirtyState !== 'clean') {
    entry.dirty = true;
    entry.dirtyWhy = dirtyState === 'dirty'
      ? '写条目时工作树是脏的（--allow-dirty 显式放行）⇒ commit 可能是父提交'
      : `写条目时读不到 git status（${gate.why}）⇒ 无法判断顺序，commit 可能是父提交`;
  }
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.appendFileSync(FILE, JSON.stringify(entry) + '\n', 'utf8');
  console.log(`✓ 已记入 ${path.relative(ROOT, FILE)}：[${entry.kind}] ${entry.summary}`);
  if (!headTry.ok) console.error(`  ⚠ 读不到 git（${headTry.err}）⇒ commit 字段**写明原因**（不再静默留空：空值和"读不到"长得一样）。`);
  if (dirtyState !== 'clean') {
    console.error(`  ⚠ **这条是在${dirtyState === 'dirty' ? '脏树' : '判不了顺序'}的情况下写的**（已记 dirty:true + dirtyWhy）。`);
  }
  console.log(`  ts=${entry.ts} commit=${entry.commit} files=${entry.files.length} docs=${entry.docs.length}`);
  // ★ 用法顺序（2026-09-26 21:5x，协调线裁决②）—— 顺序错了会**错位一位**，修完读法也救不回来：
  //   ① 先 `git commit` 落改动；② 再 `changelog add`（此刻 HEAD **就是**那次改动）；③ 再单独提交本 jsonl。
  //   为什么：条目写在提交**之前** ⇒ 那时 HEAD 只能是**上一次**提交 ⇒ 记下来的是"父提交"，查的人还得再找子提交。
  //   已实现的是"精确可查"；2026-09-26 之前的历史条目 `commit` 为空是**已知缺口**（有值的那几条也大概率
  //   错位一位）—— **不回溯补写**（拿时间戳猜提交 = 伪造可追溯性，比空着更坏；协调线裁决③）。
  //   ★ 上线初期还会有一段"**错位一位**"的存量（规矩是 2026-09-26 才机械化的，此前靠自觉 ⇒ 那几次
  //     `b536b4b` / `44b40c8` / `cfba2c6` 都记成了父提交）：**以本闸拦下之后写入的条目为准**，
  //     更早的**不回填、不重写**（同上：猜 = 伪造）。要查准，用 `dirty` 字段 + `ts` 一起看。
  console.log('  ★ 顺序：先 commit 改动 → 再 add 条目 → 最后单独提交本 jsonl（否则 commit 字段错位一位）');
  process.exit(0);
}

// amend：给**已有**记录追加 files/docs（去重），默认最后一条，`--ts <前缀|全值>` 指定某一条。
// 刻意不给的能力：改 summary / kind / ts / commit / note —— 记录是历史，写错了就 add 一条新的更正。
if (cmd === 'amend') {
  for (const bad of ['summary', 'kind', 'commit', 'note', 'no-docs']) {
    if (hasFlag(bad)) die(`amend 只追加 --files / --docs，不许动 --${bad}（历史要可信：要改就再记一条 add）`);
  }
  const addFiles = listOf(opt('files'));
  const addDocs = listOf(opt('docs'));
  if (!addFiles.length && !addDocs.length) {
    die('用法：node tools\\changelog.mjs amend --files "a,b" [--docs "c,d"] [--ts 2026-09-24T11:05]（至少要给一个）');
  }
  if (!fs.existsSync(FILE)) die(`还没有 ${path.relative(ROOT, FILE)}，先 add 一条再 amend`);
  // 按**原始行**改：坏行（JSON 解析不了的）原样留着 —— 绝不因为重写整个文件把它们悄悄丢掉。
  const raw = fs.readFileSync(FILE, 'utf8').replace(/^\uFEFF/, '');
  const keepEol = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (keepEol) lines.pop();
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const tsArg = opt('ts');
  let idx = -1;
  if (tsArg && tsArg !== 'true') {
    const hits = rows.map((r, i) => (r && String(r.ts || '').startsWith(tsArg) ? i : -1)).filter((i) => i >= 0);
    if (!hits.length) die(`--ts ${tsArg} 没匹配到任何一条（ts 形如 2026-09-24T11:05:00+08:00，可只给前缀）`);
    if (hits.length > 1) die(`--ts ${tsArg} 匹配到 ${hits.length} 条（${hits.map((i) => rows[i].ts).join(' / ')}），请给完整 ts`);
    idx = hits[0];
  } else {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i]) { idx = i; break; }
    if (idx < 0) die(`${path.relative(ROOT, FILE)} 里没有能解析的记录`);
  }
  const before = rows[idx];
  const merge = (arr, add) => {
    const out = Array.isArray(arr) ? arr.slice() : [];
    let added = 0;
    for (const x of add) if (!out.includes(x)) { out.push(x); added++; }
    return { out, added };
  };
  const f = merge(before.files, addFiles);
  const d = merge(before.docs, addDocs);
  lines[idx] = JSON.stringify({ ...before, files: f.out, docs: d.out });
  fs.writeFileSync(FILE, lines.join('\n') + (keepEol ? '\n' : ''), 'utf8');
  const tail = (given, r) => `${given.length > r.added ? `，跳过重复 ${given.length - r.added}` : ''}`;
  console.log(`✓ 已 amend ${tsArg && tsArg !== 'true' ? `ts=${before.ts}` : '最后一条'}：[${before.kind}] ${before.summary}`);
  console.log(`  files +${f.added}（共 ${f.out.length}）${tail(addFiles, f)}  docs +${d.added}（共 ${d.out.length}）${tail(addDocs, d)}`);
  console.log('  summary / kind / ts / commit / note 一字未动（amend 只做追加+去重）。');
  process.exit(0);
}

if (cmd === 'list') {
  let rows = readAll();
  const kind = opt('kind');
  if (kind) rows = rows.filter((r) => r.kind === kind);
  const since = opt('since');
  if (since) rows = rows.filter((r) => String(r.ts || '') >= since);
  const grep = opt('grep');
  if (grep) {
    const re = new RegExp(grep, 'i');
    rows = rows.filter((r) => re.test(JSON.stringify(r)));
  }
  if (hasFlag('json')) { console.log(JSON.stringify(rows, null, 2)); process.exit(0); }
  const n = Number(opt('n', '10')) || 10;
  const tail = rows.slice(-n);
  console.log(`共 ${rows.length} 条，显示最后 ${tail.length} 条：`);
  for (const r of tail) {
    console.log(`  ${r.ts}  [${r.kind}]  ${r.summary}`);
    if (r.files?.length) console.log(`     改：${r.files.join(', ')}`);
    if (r.docs?.length) console.log(`     文档：${r.docs.join(', ')}`);
    if (r.commit) console.log(`     提交：${r.commit}`);
  }
  process.exit(0);
}

if (cmd === 'check') {
  const rows = readAll();
  const gc = gitTry(['log', '-1', '--format=%H|%ad', '--date=format:%Y-%m-%dT%H:%M:%S']);
  if (!gc.ok) {
    // ★ 不许把"我没跑成"说成"通过"：判不了就出声 + 给一个跟"落后"(4) 不同的退出码。
    console.error(`  ✗ 读不到 git 最新提交：${gc.why}`);
    console.error('    ⇒ 这条检查**没有跑成**（别当成"不落后"）：请在普通终端里复跑 `node tools\\changelog.mjs check`。');
    process.exit(5);
  }
  const [hash, when] = gc.out.split('|');
  const newest = rows.length ? rows[rows.length - 1].ts : '';
  const dirty = git(['status', '--porcelain'], '');
  console.log(`  变更日志：${rows.length} 条，最新 ${newest || '(空)'}`);
  console.log(`  最新提交：${hash.slice(0, 7)}  ${when}`);
  if (dirty && !hasFlag('quiet')) console.log('  提示：工作区还有未提交的改动。');
  // 按"天"比：日志条目总是写在提交**之前**，按秒比会永远显示落后。同一天即视为已对齐。
  if (!newest || newest.slice(0, 10) < when.slice(0, 10)) {
    console.error('  ✗ 变更日志落后于最新提交 —— 按规矩补一条：node tools\\changelog.mjs add --kind … --summary "…" --files "…" --docs "…"');
    process.exit(4);
  }
  console.log('  ✓ 变更日志不落后。');
  process.exit(0);
}

console.error('用法：node tools\\changelog.mjs add|amend|list|check …（详见文件头注释）');
process.exit(2);
