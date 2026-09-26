// 把主人"存为模板"上传的那份排布，烤成控制台的**基础模板**（DEFAULT_ORDER / DEFAULT_SPAN / DEFAULT_H）。
//
// 背景（2026-09-24 主人："布局基础模板就用我的模板就好了"）：控制台的卡片排布只活在浏览器
// localStorage 里，新浏览器打开看到的是代码里的内置默认。他点「存为模板」时，控制台会同时把这份
// 排布 POST 到桥接（state\console-layout-template.json）—— 那个文件就是他真正在用的排布。
// 本工具读它、生成三行默认值、原地替换 console.html 里对应的声明（先备份），再跑一遍布局回归。
//
// 用法：node tools\bake-layout-template.mjs [--dry]
//   --dry  只打印将要写入的内容，不动文件
// 退出码：0 = 烤成功且布局回归**跑成了并且是绿的**（--dry 也是 0）；1 = 回归网**判红**（明细 + 已回滚）；
//         2 = 回归网**没跑成**（EPERM/ENOENT/超时/回归网文件缺席 ⇒ 不是判据红，已回滚）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // 2026-09-24：原来写死 D:/hobby/DSH
const HTML = path.join(ROOT, 'qq-bridge', 'public', 'console.html');
const TPL = path.join(ROOT, 'qq-bridge', 'state', 'console-layout-template.json');
const dry = process.argv.includes('--dry');

if (!fs.existsSync(TPL)) {
  console.error('✗ 还没有模板文件：' + TPL);
  console.error('  先在控制台顶栏按一下「存为模板」（它会同时把这份排布存到服务端），再跑本工具。');
  process.exit(1);
}
const tpl = JSON.parse(fs.readFileSync(TPL, 'utf8'));
if (!Array.isArray(tpl.order) || !tpl.order.length) {
  console.error('✗ 模板里没有 order，拒绝烤（宁可不动，也不要把布局写坏）');
  process.exit(1);
}

const src = fs.readFileSync(HTML, 'utf8');
const orderSrc = src.match(/var DEFAULT_ORDER = \[[^\]]*\];/);
const spanSrc = src.match(/var DEFAULT_SPAN = \{[^}]*\};/);
const hSrc = src.match(/var DEFAULT_H = \{[^}]*\};/);
if (!orderSrc || !spanSrc || !hSrc) {
  console.error('✗ console.html 里找不到 DEFAULT_ORDER / DEFAULT_SPAN / DEFAULT_H 的声明，先手工看看');
  process.exit(1);
}

const q = (s) => `'${String(s).replace(/'/g, "\\'")}'`;
const orderLine = `var DEFAULT_ORDER = [${tpl.order.map(q).join(', ')}];`;
const spanPairs = Object.entries(tpl.span || {}).filter(([, v]) => Number(v) > 0);
const spanLine = `var DEFAULT_SPAN = {${spanPairs.map(([k, v]) => ` ${k}: ${Number(v)}`).join(',')}${spanPairs.length ? ' ' : ''}};`;
const hPairs = Object.entries(tpl.h || {}).filter(([, v]) => Number(v) > 0);
const hLine = `var DEFAULT_H = {${hPairs.map(([k, v]) => ` ${k}: ${Number(v)}`).join(',')}${hPairs.length ? ' ' : ''}};`;

console.log('模板来自：' + TPL + '（存于 ' + new Date(Number(tpl.at) || 0).toLocaleString() + '）');
console.log('  ' + orderLine);
console.log('  ' + spanLine);
console.log('  ' + hLine);
if (dry) { console.log('\n（--dry：没有写文件）'); process.exit(0); }

const backup = path.join(ROOT, 'qq-bridge', 'state', '_tmp', `console.before-bake-${Date.now()}.html`);
fs.mkdirSync(path.dirname(backup), { recursive: true });
fs.writeFileSync(backup, src);
const out = src
  .replace(orderSrc[0], orderLine)
  .replace(spanSrc[0], spanLine)
  .replace(hSrc[0], hLine);
fs.writeFileSync(HTML, out);
console.log('\n✓ 已写入 console.html（备份：' + backup + '）');

// ★ 2026-09-26（§2.4 fd 改写）：**不用管道**收子进程输出 —— stdout / stderr 各落一个临时文件
//   （把 `fs.openSync(…,'w')` 拿到的 fd 传进 `stdio`），跑完读回文件。
//   为什么不能用管道：受限模式下 Node 开**命名管道**会被拒；旧的 `execFileSync(…, {encoding:'utf8'})`
//   （默认管道）**必然 EPERM** ⇒ 布局回归在这类终端里**从来没真跑成过**，而那个 catch 只会把它
//   说成"布局回归没过"（**把"环境不让跑"栽赃给布局**）。
//   **探针实测**（`qq-bridge\state\_archive\tmp-20260926\sub22-24\probe-eprem.mjs` —— 跑完从
//   `state\_tmp\` 归档到这里；同一次运行内四种写法对照）：
//     A `execFileSync(git, …, pipe)`   ⇒ FAIL  code=EPERM status=null
//     B `spawnSync(git, …, pipe)`      ⇒ FAIL  code=EPERM
//     C `spawnSync(git, …, fd,fd)`     ⇒ OK    status=0
//   ⇒ fd 法**零 EPERM**。判红**只看 `status`**（fd 模式下没有 `e.stdout`，旧写法也一起废掉）。
//   ★★ 改写的重点不是 fd，是**必须分清两件事**：
//     · `status` 是数字且 ≠ 0          ⇒ **真红**：回归网真的判了红 ⇒ 打明细 + 回滚 + **exit 1**。
//     · `r.error` 存在 或 `status === null`（EPERM/ENOENT/超时…，进程压根没跑成）⇒ **不是判据红**：
//       明印"**本次没跑成、不是判据红**" + 回滚（没跑过的回归不给这次烤背书）+ **exit 2**（fail-loud，不许静默）。
//     · 回归网文件**不存在** ⇒ 也算"没跑成"（先查存在性）：回归网缺席时 node 会以 1 退出，只看 status
//       会被当成"布局红了" —— **那是栽赃**，所以这条单独判。
//   ⚠ 回滚两种都做：写下去的是一份**没被验证过**的 console.html，留着它才是真危险；但退出码不同
//     （真红 1 / 没跑成 2），谁都分得清是哪一种。
const TMPDIRS = [os.tmpdir(), path.join(ROOT, 'qq-bridge', 'state', '_tmp')];   // 后者 state\ 是 gitignore 的
const openTmp = (tag) => {
  for (const d of TMPDIRS) {
    try {
      fs.mkdirSync(d, { recursive: true });
      const file = path.join(d, `dsh-bake-layout-${process.pid}-${tag}.txt`);
      return { fd: fs.openSync(file, 'w'), file };
    } catch { /* 换下一个目录 */ }
  }
  return null;
};
const readTmp = (t) => { try { return fs.readFileSync(t.file, 'utf8'); } catch { return ''; } };
/** 烤完立刻回滚（真红与"没跑成"共用）—— console.html 恢复成烤之前那份。 */
const rollback = (why) => {
  fs.writeFileSync(HTML, src);
  console.error(`  已回滚到烤之前的内容（备份也留着：${backup}）—— 原因：${why}`);
};

const regression = path.join(ROOT, 'qq-bridge', 'scripts', 'test-console-layout.mjs');
let r = null;
const tOut = openTmp('out');
const tErr = openTmp('err');
try {
  if (!tOut || !tErr) {
    console.error('✗ **本次没跑成、不是判据红**：开不出临时文件（os.tmpdir() 与 qq-bridge\\state\\_tmp 都不行）');
    rollback('回归网压根没跑成');
    process.exit(2);
  }
  if (!fs.existsSync(regression)) {                       // 回归网缺席 ⇒ 不能冒充"布局红了"
    console.error(`✗ **本次没跑成、不是判据红**：布局回归网文件不在（${regression}）——`);
    console.error('  这不是"布局有问题"，而是"这次没验证成"；先确认回归网在不在，再重跑本工具。');
    rollback('回归网缺席');
    process.exit(2);
  }
  r = spawnSync(process.execPath, [regression], { stdio: ['ignore', tOut.fd, tErr.fd], timeout: 300000 });
} finally {
  for (const t of [tOut, tErr]) { if (t) { try { fs.closeSync(t.fd); } catch { /* 已关 */ } } }
}
const regOut = readTmp(tOut);
const regErr = readTmp(tErr);
for (const t of [tOut, tErr]) { try { fs.unlinkSync(t.file); } catch { /* 不留垃圾 */ } }

if (r.error || r.status === null) {                       // ← 没跑成：EPERM / ENOENT / 超时 / 被信号杀
  console.error(`✗ **本次没跑成、不是判据红**：布局回归**没有跑起来**（${r.error ? r.error.code || r.error.message : `status=null signal=${r.signal}`}）。`);
  console.error('  这次烤的**对错无从判断**（既不能说"过了"，也不能说"回归判红"）—— 请在能跑子进程的终端里重跑本工具。');
  const errTail = regErr.trim().split('\n').filter(Boolean).slice(-3).join('\n    ');
  if (errTail) console.error('  子进程留下的 stderr（末 3 行）：\n    ' + errTail);
  rollback('回归网没跑成 ⇒ 不能确认这次烤的对错');
  process.exit(2);
}
if (r.status !== 0) {                                     // ← 真红：回归网真的判了红
  // 失败时把回归里那几条红字打出来 —— 否则只能看到"没过"，没法定位（2026-09-24 第一次烤就吃了这个亏）
  console.error(`✗ 布局回归没过（回归网 exit ${r.status}）—— 立刻回滚！失败明细：`);
  const detail = regOut.split('\n').filter((l) => l.includes('❌') || l.includes('失败')).join('\n');
  console.error(detail || '（回归没吐明细，手工跑 node qq-bridge\\scripts\\test-console-layout.mjs 看看）');
  rollback('回归判红');
  process.exit(1);
}
console.log('布局回归：' + (regOut.trim().split('\n').slice(-3).join(' | ')));
