#!/usr/bin/env node
// notify-session —— **dev 会话之间互相联系**的唯一通道（主人 2026-09-25 批准："可以放到工具，以后有问题你们可以互相联系"）。
//
// 为什么需要它：桥接的 `/api/console/notify-ai` 只认 `group:群号` / `private:QQ号` 这类 **QQ 会话键**
// （bridge.js:3163 的正则拦死），dev 会话（`~\.dsh\sessions\--D-hobby-DSH--\*`）**没有投递口** ——
// 想在"做启动窗口的会话"和"协调会话"之间传话，以前只能靠主人转述。
//
// 它走的是 **DSH 自己的会话 API**（`api.sessions.prompt`），与桥接唤醒开发会话、投递留言板提示是同一条路：
//   qq-bridge\src\dsh-client.js 的 NodeApiClient + config.json 的 dsh.authToken（令牌只在内存里用，不打印）。
//
// 用法：
//   node tools\notify-session.mjs --whoami                     我是谁（读 DSH_SESSION_ID）
//   node tools\notify-session.mjs --list [--n 20] [--all]      列可投递的会话（默认只列最近 20 条、跳过空会话）
//   node tools\notify-session.mjs <会话id|唯一前缀> <文本文件>
//       把文件正文作为一条提示投进那个会话（`mode: 'steer'`：落在它**下一个 step 边界**，跑长回合时不用等它跑完、
//       也不用主人去点"接收"；不接受时**自动回落** `mode: 'queue'` —— 同桥接 deliverPrompt 的写法。空闲则起一轮）
//       选项：--no-header  不要前缀那行来源标注
//             --dry-run    只打印要投给谁、多长，不真投
//             --force      允许投给自己（默认拦下：那等于给自己的会话排一轮）
//   node tools\notify-session.mjs <会话id> -               正文从 stdin 读（管道用）
//
// ⚠ 三条纪律：
//   ① **单向**：对方收到的只是一条提示，它的回复**不会**回到你这里。所以默认会在正文前加一行
//      `【来自 <你的会话id>（tools\notify-session.mjs 投递；可用同一条路回我）】` —— 让它能回你。
//   ② **花的是对方的上下文**：投一次 = 给它排一轮。别拿它当群发、别为鸡毛蒜皮投。
//   ③ 只投"对方需要知道"的事实与结论，别把过程流水倒给对方。
//
// ④ **归档即只读历史**（2026-09-25 主人硬要求）：投递前先过 `src\session-guard.js` 的
//    `resolveDelivery` —— 目标已归档（本地名单或 DSH 的 workspace.json 命中）就**一个字节都不投**、
//    非 0 退出、原因打 stderr（`--dry-run` 同样会拒，方便先试）。护栏模块本身加载不了时按
//    "读失败不拦"继续并告警 —— 这条纪律与桥接投递链一致，详见 qq-agent-产品设计.md §12.3。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CFG = path.join(ROOT, 'qq-bridge', 'config.json');

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const val = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
// 只把「位置参数」挑出来：带值的开关（--n）要连它的值一起跳过，否则 --n 20 里的 20 会被当成会话 id
// ⚠ 2026-09-25 修一个真 bug：`-` 是**位置参数**（= 正文从 stdin 读，见下面 readFileSync(0)），
//   不是开关 —— 原来 `a.startsWith('-')` 直接 continue 把它吃掉了，于是文档里写的
//   `notify-session.mjs <会话id> -` **从来没生效过**（实测：打用法 + exit 1）。
//   修法就是下面这一行 `&& a !== '-'`；跑 `--self-test` 可复验。
function parseArgs(argv) {
  const VALUE_FLAGS = new Set(['--n']);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a !== '-') { if (VALUE_FLAGS.has(a)) i++; continue; }
    positional.push(a);
  }
  return positional;
}
const positional = parseArgs(argv);

const selfId = String(process.env.DSH_SESSION_ID ?? '').trim();

function usage(code = 0, soft = false) {
  console.log(`用法：
  node tools\\notify-session.mjs --whoami
  node tools\\notify-session.mjs --list [--n 20] [--all]
  node tools\\notify-session.mjs <会话id|唯一前缀> <文本文件> [--no-header] [--dry-run] [--force]
  node tools\\notify-session.mjs <会话id> -            （正文从 stdin 读）

dev 会话之间互相联系走这条（桥接 notify-ai 只认 QQ 会话键）。单向投递：对方的回复不会回到你这里。
目标会话**已归档**（只读历史）会被拒：非 0 退出、原因打 stderr —— --dry-run 一样会拒。`);
  process.exit(code);
}

if (has('--help') || has('-h') || argv.length === 0) usage(0);

if (has('--whoami')) {
  console.log(selfId || '(DSH_SESSION_ID 没设 —— 说明不是从 DSH 会话里跑的)');
  process.exit(0);
}

if (has('--self-test')) {
  // ★ 只读自检（2026-09-25 加）：验"参数怎么认"和"目标标签说的是不是当下语义"这两件最容易悄悄坏掉的事。
  //   跑法：`node tools\notify-session.mjs --self-test` —— **不连 DSH、不投递、不写任何文件**。
  let pass = 0, fail = 0;
  const t = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('✅ ' + name); } else { fail++; console.log('❌ ' + name + (detail ? '  ← ' + detail : '')); }
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  t('`-` 被当成位置参数（正文从 stdin 读），不再被当开关吃掉', eq(parseArgs(['902a8b90', '-']), ['902a8b90', '-']), JSON.stringify(parseArgs(['902a8b90', '-'])));
  t('普通的"会话id + 文件"照旧', eq(parseArgs(['902a8b90', 'msg.md']), ['902a8b90', 'msg.md']));
  t('带值开关 --n 20 的 20 不会被当成会话 id', eq(parseArgs(['--list', '--n', '20']), []) && eq(parseArgs(['--list', '--n', '20', 'abc']), ['abc']));
  t('布尔开关仍然被跳过（--dry-run / --no-header）', eq(parseArgs(['abc', '--dry-run', '--no-header']), ['abc']));
  let me = '';
  try { me = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8'); } catch { /* 读不到就只跑上面几条 */ }
  const m = me.match(/to\.running \? '([^']*)'/);
  t('运行中的目标标签 = steer 语义（消息插到下一个 step 边界），不是过期的"排队"',
    !!m && m[1].includes('step 边界'), m ? m[1] : '(源码里没找到那个标签)');
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail ? 1 : 0);
}

// ── 连 DSH（与 self-check/check-presets 同一套引法）
const { NodeApiClient, unwrap, discoverDshLaunchToken } = await import(new URL('../qq-bridge/src/dsh-client.js', import.meta.url).href);
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
  token: cfg.dsh.authToken, header: cfg.dsh.authHeader, prefix: cfg.dsh.authPrefix
});

// ★ 退出方式（实测坑）：客户端内部有 WebSocket/keep-alive 句柄，**用过它之后再 `process.exit()`**
//   会在 Windows 上打一行 libuv 断言（`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)…`）
//   并把退出码变成 1 —— 调我们的脚本会误判"失败"。所以：只设 exitCode、让事件循环自己排干；
//   万一真有句柄赖着不走，再用下面这个【不保活的】兜底定时器强退。
const done = (code = 0) => { process.exitCode = code; };
setTimeout(() => process.exit(process.exitCode ?? 0), 4000).unref();

async function listSessions() {
  let listed;
  try { listed = unwrap(await api.sessions.list({}), 'session.list'); } catch (e) {
    // 退路：不带 unwrap（形状偶尔是裸信封），并顺手试一次 launch token 自动发现
    listed = await api.sessions.list({});
    if (!listed) throw e;
  }
  const items = Array.isArray(listed) ? listed : (listed?.items ?? listed?.sessions ?? []);
  return items.map((s) => ({
    id: String(s?.sessionId ?? s?.id ?? ''),
    running: s?.running === true,
    blank: s?.blank === true,
    cwd: String(s?.cwd ?? ''),
    at: Number(s?.updatedAt ?? s?.lastActivityAt ?? 0) || 0
  })).filter((s) => s.id);
}

/**
 * 归档名单 = DSH 侧（`~/.dsh/storages/workspace.json` 的 `archivedSessionIds`）∪ 本地名单。
 * ★ 2026-09-25 补：`--list` 原来**不标归档**，于是列表里那些"空闲"的归档会话看着就像能投 ——
 *   协调会话当天就白跑一次（投 `ef4e6b98` 才发现它早归档了）。投递前的硬拒绝本来就有
 *   （`resolveDelivery`），这里补的是"**投之前就能看见**"。判据与 sessions.mjs 的 `archivedIdSet()` 同一套，
 *   别再写第二份：本地名单 + workspace.json 都由 `src\session-guard.js` 提供。
 */
async function archivedIdSet() {
  try {
    const guard = await import(new URL('../qq-bridge/src/session-guard.js', import.meta.url).href);
    const ws = guard.readWorkspaceArchived({});
    return { set: new Set([...ws.raw, ...guard.loadArchived().keys()]), guard };
  } catch (error) {
    console.error(`⚠️ 归档名单读不到（${error?.message ?? error}）—— 下面的「已归档」标注可能不全（投递前仍会硬拦一次）。`);
    return { set: new Set(), guard: null };
  }
}

if (has('--list')) {
  const all = await listSessions();
  const { set: archived, guard } = await archivedIdSet();
  const isArch = (id) => (guard ? guard.isArchived(id, archived) : archived.has(id));
  const rows = all.filter((s) => has('--all') || !s.blank).sort((a, b) => b.at - a.at);
  const n = Math.max(1, Number(val('--n', 20)) || 20);
  const archCount = all.filter((s) => isArch(s.id)).length;
  console.log(`共 ${all.length} 条会话（其中**已归档 ${archCount} 条**；显示 ${Math.min(n, rows.length)} 条，按最后活动倒序${has('--all') ? '，含空会话' : '，已跳过空会话'}）：\n`);
  for (const s of rows.slice(0, n)) {
    const arch = isArch(s.id);
    const mark = s.id === selfId ? ' ← 我自己' : '';
    const ws = s.cwd ? path.basename(s.cwd) : '';
    const when = s.at ? new Date(s.at).toLocaleString('zh-CN', { hour12: false }) : '—';
    console.log(`  ${s.id}${mark}${arch ? '  【已归档·不可投递】' : ''}`);
    console.log(`      ${arch ? '已归档' : (s.running ? '跑着' : '空闲')}  ${when}  ${ws ? ws + '  ' : ''}${s.cwd || ''}`);
  }
  console.log('\n投递：node tools\\notify-session.mjs <上面那个 id 或它的唯一前缀> <文本文件>');
  console.log('⚠ 「空闲」≠ 可投递：已归档的会话是只读历史，投它会被硬拒（非 0 退出）。列表里没有【已归档】标注的才投得进去。');
  done(0);
} else {
  await send();
}

// ── 投递（--list 之外的路径都走这里；用函数是为了能 return，别让「报错之后继续往下投」）
async function send() {
  const target = String(positional[0] ?? '').trim();
  const src = String(positional[1] ?? '').trim();
  if (!target || !src) return usage(2, true);

const all = await listSessions();
const matches = all.filter((s) => s.id === target || s.id.startsWith(target) || s.id.replace(/^session-/, '').startsWith(target.replace(/^session-/, '')));
if (!matches.length) {
  console.error(`❌ 找不到会话「${target}」—— 用 --list 看一眼现成的 id（本机共 ${all.length} 条，可能是别的会话已被归档/删除）。`);
  return done(1);
}
if (matches.length > 1) {
  console.error(`❌ 前缀「${target}」不唯一，命中 ${matches.length} 条，请写全：`);
  for (const m of matches) console.error(`   ${m.id}`);
  return done(1);
}
const to = matches[0];
if (to.id === selfId && !has('--force')) {
  console.error(`❌ 目标是你自己（${selfId}）—— 那等于给自己的会话排一轮。真要这么干加 --force。`);
  return done(1);
}

let body;
if (src === '-') {
  body = fs.readFileSync(0, 'utf8');
} else {
  const p = path.resolve(src);
  if (!fs.existsSync(p)) { console.error(`❌ 正文文件不存在：${p}`); done(1); }
  body = fs.readFileSync(p, 'utf8');
}
body = body.trim();
if (!body) { console.error('❌ 正文是空的'); done(1); }

const header = has('--no-header') ? '' :
  `【来自 ${selfId || '（未设 DSH_SESSION_ID 的会话）'}，由 tools\\notify-session.mjs 投递；可用同一条路回我】\n\n`;
const text = header + body;

console.log(`目标：${to.id}${to.id === selfId ? '（我自己！）' : ''}  ${to.running ? '（正跑着，消息插到下一个 step 边界）' : '（空闲，会起一轮）'}`);
console.log(`正文：${body.length} 字符${header ? '（含来源标注）' : ''}`);

// ── 归档护栏（2026-09-25 主人硬要求：归档的会话 = 只读历史，谁都不许再往里写）──────────
// 放在 --dry-run 之前：试跑也要能看到"会被拒"，不然先 dry-run 再真投的人会被打脸。
// 判据住在 src\session-guard.js（本地名单 + DSH 的 ~\.dsh\storages\workspace.json 的
// global.archivedSessionIds）；这里只负责"问一次、被拒就闭嘴"。
// 模块加载不了 ⇒ 按"读失败不拦"继续（与桥接投递链同一条纪律），但必须告警留痕。
let guardWarned = '';
let delivery = { allow: true, code: 'ok' };
let resolveDeliveryFn = null; // steer 回落成 queue = 第二次写同一条会话 ⇒ 还要再问一次护栏（同桥接 deliverPrompt）
try {
  const { resolveDelivery } = await import(new URL('../qq-bridge/src/session-guard.js', import.meta.url).href);
  resolveDeliveryFn = resolveDelivery;
  delivery = await resolveDelivery(api, to.id);
} catch (error) {
  guardWarned = `⚠️ 归档护栏没跑起来（${error?.message ?? error}）—— 按"读失败不拦"继续投递。`;
  console.error(guardWarned);
}
if (delivery && delivery.allow === false) {
  console.error(`❌ 拒绝投递：目标会话已归档（code=${delivery.code}）—— ${delivery.reason ?? '归档的会话是只读历史，不会再被动'}`);
  console.error(`   会话：${to.id}`);
  console.error('   换个未归档的会话，或让主人重新绑定（归档会话不会被自动复活）。');
  return done(1);
}
if (delivery && delivery.code && delivery.code !== 'ok' && !guardWarned) {
  console.error(`⚠️ 护栏放行但留痕：code=${delivery.code}（归档名单读不到，按"读失败不拦"处理）`);
}

if (has('--dry-run')) {
    console.log('\n--dry-run：没有真投。前 200 字符预览：\n' + text.slice(0, 200));
    return done(0);
  }

// mode: 'steer'（2026-09-25 调研定案；主人原话「排队列表有消息就先停下接收 … 都要我手动去点」）：
// steer 落在对方**下一个 step 边界**（会话正在跑长回合时不用等它跑完、也不用主人去点"接收"），
// 且 **不 abort 任何东西**（不会打断它正在写的文件 / 正在跑的 pwsh）。不被接受时回落 queue ——
// 与桥接 deliverPrompt（qq-bridge\src\bridge.js:9111-9137）同一套写法与纪律。
//
// ★★ 实测踩坑：**给一个「从未起过轮」的全新会话投 steer，会被 API 接受、然后静默丢掉。**
//   实测：steer 投两次都 `accepted:true`，但目标投影 `inbox` 仍空、所有行 `seq` 停在 3、
//   `sessionStats.steps` 仍 0、`sessionListMetadata.blank` 一直 true ⇒ 正文**根本没进去**；
//   又因为 `blank`，**GUI 列表里连它都不显示**（表象是"新开的会话不见了"）。
//   同一份正文改投 `--queue` 后：25 秒内 `7 步 / 1 轮 / 跑着`、`blank=false`、`inbox` 被消费（`seq` 3 → 49）✓
//   ⇒ **全新 / 从未起过轮的会话，投递必须显式 `--queue`**（消息落 `inbox.next-turn`，由 DSH 起轮）。
//   ⚠ 口径（第二次实测后收紧）：**只要目标当时没有在跑的回合，就一律用 `--queue`。**
//     —— 给**已有 80 步历史、当时空闲**的会话投 steer，**同样没起轮**（步骤与时间戳都冻住）✗；
//     而一次真的起了轮的 steer，是在对方**刚跑完、尚未完全落空闲**的窗口里 —— 别指望复现。
//     ⇒ 稳态结论：**steer 只在对方「正在跑回合」时可靠**；空闲 / 全新 / 卡过的一律 `--queue`。
//     **卡死**的会话（`--queue` 复投也不动、投影缓存 mtime 冻住）是另一回事 —— 当"起不来"处理。
//   ★ 补充实测（同一会话）：**空闲久了（~12 分钟）的会话，`--queue` 能把正文写进 `inbox`
//     （`inbox.seq` 前进、`lastPromptAt` 更新）但不会自己起轮**（`steps`/`turns` 不动、缓存 mtime 冻住）——
//     像是进程被卸载了，消息要等它**下次被加载**（在 GUI 里打开它一次 / 有人真发一条）才消费。
//     ⇒ `--queue` **不是万能**：投完没动又不急，就让它排着（下次起轮会读到）；**急**的话请在 GUI 里打开那个会话。
//   ⇒ 判据（投完必须核）：目标的 `steps` 或某行 `seq` 应当变化、`inbox` 应当被消费。
const payload = [{ type: 'text', text }];
let mode = has('--queue') ? 'queue' : 'steer';
let accepted;
try {
  accepted = unwrap(await api.sessions.prompt({ sessionId: to.id, mode, content: payload }), 'session/prompt');
} catch (error) {
  console.error(`⚠️ steering 投递失败（${error?.message ?? error}）—— 回落 queue`);
  // 回落 = 第二次写同一条会话 ⇒ 重新问一次归档护栏（TTL 命中，几乎不花钱）；被拒就一个字节都不发
  if (resolveDeliveryFn) {
    const recheck = await resolveDeliveryFn(api, to.id);
    if (recheck && recheck.allow === false) {
      console.error(`❌ 回落前护栏拒绝：目标会话已归档（code=${recheck.code}）—— 未投递。`);
      return done(1);
    }
  }
  mode = 'queue';
  try {
    accepted = unwrap(await api.sessions.prompt({ sessionId: to.id, mode, content: payload }), 'session/prompt');
  } catch (error2) {
    console.error('\n❌ 投递失败：' + (error2?.message ?? error2));
    console.error(`   排查：DSH 在不在（${cfg.dsh.baseUrl}）、config.json 的 dsh.authToken 有没有过期（重启 DSH 会换 token）、目标会话是否已被删除。`);
    return done(1);
  }
}
console.log(`\n✅ 已投递 → ${to.id}（mode=${mode}）`);
console.log('   DSH 返回：' + JSON.stringify(accepted));
console.log('   （单向：它的回复不会回到你这里 —— 要它回你，让它用同一条命令投回你的 id。）');
}
