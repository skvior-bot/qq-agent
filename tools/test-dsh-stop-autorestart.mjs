#!/usr/bin/env node
// tools\test-dsh-stop-autorestart.mjs —— "DSH 真停 ⇒ 自动拉起"这条链的**接线 / 契约 / 真做一次**测试
//
// 为什么单独有它（2026-09-25 主人真机反馈）：
//   真机上 DSH 掉线时**自动拉起一次都没发生**（记账文件 `state\_tmp\dsh-autorestart.json` 不存在）✗。
//   查清的原因不是逻辑错，而是**长驻进程只加载一次代码**：那一代窗口（guard 日志
//   `server-20260925-010112`）比我的代码落盘时刻（01:09:25）**早 8 分钟**起来 ⇒ 它根本
//   没有那段代码。⇒ 教训："探针过了" ≠ "真机过了"：探针只能证明**判定**对，证明不了
//   ①循环真的调它（接线）②`exit 1` 在外层 `.cmd` 里真的会立刻重起（契约）③记账真的写得进
//   并被下一代替读得到（真做一次）。这个文件就把这三样钉住，并且**报告**"活着的这一代是不是
//   比代码旧"（就是这次漏掉的那个陷阱）。
//
// 只读边界：① 只**读**源码；② 跑 `tools\dsh-prompt.ps1 -CheckStopOnce`（该入口自证"不碰任何窗口、
//   不拉任何进程"）；③ 记账那一步写的是**注入到 %TEMP% 的临时文件**，真文件
//   `qq-bridge\state\_tmp\dsh-autorestart.json` 一个字都不碰（末尾有断言钉这一点）。
// 跑法：`node tools\test-dsh-stop-autorestart.mjs`

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(TOOLS);
const PS1 = path.join(TOOLS, 'dsh-prompt.ps1');
const WINDOW_CMD = path.join(TOOLS, 'dsh-window.cmd');
const REAL_STATE = path.join(REPO, 'qq-bridge', 'state', '_tmp', 'dsh-autorestart.json');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(name); console.log(`  ❌ ${name}${detail ? `\n       ${detail}` : ''}`); }
}
const src = fs.readFileSync(PS1, 'utf8');
const cmd = fs.readFileSync(WINDOW_CMD, 'utf8');
const ps1Bytes = fs.readFileSync(PS1);
const HAS_BOM = ps1Bytes[0] === 0xef && ps1Bytes[1] === 0xbb && ps1Bytes[2] === 0xbf;

// ── 只读跑一次探针（注入见下）──────────────────────────────────────────────
// ⚠ 这里**不能用管道**：本工作区的沙箱禁止用管道 stdio 捕获子进程输出（实测 `spawnSync … EPERM`）。
//   改成把子进程 stdout **重定向到文件**（stdio 给一个 fd，不是 pipe）⇒ 沙箱内也能跑。
//   `[Console]::OutputEncoding` 显式设 UTF-8，否则 PS 5.1 会按 GBK 写文件、中文全成乱码。
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ar-probe-'));
let probeSeq = 0;
// ★ 判死闸的"文件开关"在**整个测试进程**里统一指到一个不存在的路径（= 开关开着）——
//   否则测试结果会受真机上那个 `qq-bridge\state\dsh-autorestart-off` 的当前状态影响（它 20:3x 被删过）。
process.env.DSH_WINDOW_AUTORESTART_OFF_FILE = path.join(os.tmpdir(), `dsh-ar-off-${process.pid}.txt`);
// ★ 同理，「有没有会话在跑」也必须**注入成确定值**：真环境下它依据 `~\.dsh\sessions` 的流水 mtime，
//   而**跑测试的时刻往往正好有别的会话（甚至我自己）在写** ⇒ 判死那几态会全塌成 hold（"宁可不拉"），
//   旧矩阵（0/1/2 次 ⇒ auto-restart、3 次 ⇒ alarm）就会假红。要验"忙"的那一态自己显式传 '1'。
process.env.DSH_WINDOW_SESSIONS_BUSY = '0';
/** 用给定的只读开关跑一次脚本，返回它的 stdout（重定向到文件，不用管道） */
function probeSwitch(flag, env = {}) {
  const outFile = path.join(SCRATCH, `probe-${++probeSeq}.txt`);
  const fd = fs.openSync(outFile, 'w');
  try {
    const r = spawnSync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; & '${PS1}' ${flag}`,
    ], { env: { ...process.env, ...env }, stdio: ['ignore', fd, 'ignore'], windowsHide: true });
    if (r.error) throw r.error;
  } finally { fs.closeSync(fd); }
  return fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '');
}
const probe = (env = {}) => probeSwitch('-CheckStopOnce', env);
function cleanup() { try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* 尽力而为 */ } }
function line(out, needle) {
  return out.split(/\r?\n/).find((l) => l.includes(needle)) || '';
}
/** 那一行里 `自动拉起：` 后面的动作名（keep-running / adopt / auto-restart / alarm） */
function actOf(out) {
  const m = line(out, '自动拉起：').match(/自动拉起：([a-z-]+)/);
  return m ? m[1] : '(读不到)';
}
/** 真停时"本来会用的"红色告警那段（#3 起的所有行都算 —— 措辞断言看整段，别只挑几行） */
function alarmText(out) {
  return out;
}

console.log('══ DSH 真停 ⇒ 自动拉起：接线 / 契约 / 真做一次 ══════════════════════════\n');

// ── ⓪ 前置：这个 .ps1 必须带 BOM（红线 2）────────────────────────────────
// 不带 BOM 时 PS 5.1 按 GBK 解码 ⇒ 中文全乱、脚本根本解析不了 ⇒ 下面所有"真跑一次"都会变成
// 假失败（实测：编辑工具每次写都会剥掉 BOM）。所以先把它钉成一条断言，出错时能一眼看出原因。
check('★ tools\\dsh-prompt.ps1 带 UTF-8 BOM（没带：跑 node tools\\self-check.mjs --fix-bom）', HAS_BOM,
  'BOM 掉了 ⇒ 下面的探针全是假失败（PS 5.1 会按 GBK 解码这个文件）');
if (!HAS_BOM) {
  console.log('\n⚠️  BOM 不在，探针结果不可信 ⇒ 直接退出（先修 BOM 再跑）');
  console.log(`\n═════ 通过 ${pass} 项，失败 ${fail} 项 ═════`);
  cleanup();
  process.exit(1);
}

// ── ① 接线：真循环里到底调了什么（静态钉源码，防"改回老路"）─────────────────
console.log('① 接线（真循环那一处）');
check('判定收在一个共用函数里（Resolve-StopHandling）', /function Resolve-StopHandling\s*\{/.test(src));
const loopIdx = src.indexOf('$h = Resolve-StopHandling -ChildExited $true -DshAlive (Test-DshAliveSettled)');
check('★ 真循环调用的就是它（不是又抄一份判定）', loopIdx > 0,
  '在 run 循环里找不到 `$h = Resolve-StopHandling -ChildExited $true -DshAlive (Test-DshAliveSettled)`');
check('★ 判死这一路喂进去的是"耐心探针 + 有没有会话在跑"（判据①的两个输入）',
  /-SessionsBusy \$sessionsBusy/.test(src) && /Resolve-DeathAction -Act \$h\.act -SwitchOff/.test(src));
check('循环里不再直接调 Resolve-AutoRestart（唯一入口）',
  src.indexOf('Resolve-AutoRestart -DshAlive $false -Attempts (Read-AutoRestartAttempts)') < 0);
if (loopIdx > 0) {
  const rest = src.slice(loopIdx);
  const branch = rest.slice(rest.indexOf("if ($h.act -eq 'auto-restart')"), rest.indexOf("if ($h.act -eq 'alarm')"));
  const alarmBranch = rest.slice(rest.indexOf("if ($h.act -eq 'alarm')"), rest.indexOf("if (-not $adopted)"));
  // ⚠ 比的是**真语句**的位置，不是关键字第一次出现的位置（注释里也写着 `exit 1`，会被误判）
  const iRec = branch.search(/(^|\n)\s*\$rec = Add-AutoRestartAttempt/);
  const iExit = branch.search(/(^|\n)\s*exit 1\s*$/m);
  check('auto-restart 分支里：**先记账**再 exit 1',
    iRec > 0 && iExit > iRec,
    `记账@${iRec} exit@${iExit}（记账必须在 exit 1 之前 —— 万一这一代自己崩了，计数不丢）`);
  check('auto-restart 分支里：真的 exit 1（= 外层 .cmd 的重起路）', iExit > 0);
  check('★ 记账失败 ⇒ 不敢自动拉、转红告警（不许静默、不许无限重启）',
    branch.includes('$rec -lt 1') && /Red/.test(branch));
  check('两条路**互斥**：auto-restart 分支里不打印红色告警', !branch.includes('Write-DshStopAlarm'));
  check('两条路**互斥**：alarm 分支里不 exit 1（它是"印完等输入"）',
    alarmBranch.length > 0 && !/(^|\n)\s*exit 1\s*$/m.test(alarmBranch));
  check('alarm 分支确实设置了升级原因并跳出循环',
    alarmBranch.includes('$script:StopEscalated') && alarmBranch.includes('break'));
  // ★ 主人的设计指令（2026-09-25）：**单次自动拉起不弹窗**（"只要有日志就行了"），只有"短时间连着
  //   好几次"才值得打扰 ⇒ 拉起那条路里**不许**有弹窗动作（弹窗只属于频率告警那条路）。
  check('★ 拉起那条路**不弹窗**（主人的设计：单次修复只留日志，别打扰）',
    !/Invoke-WindowPop/.test(branch) && !/Test-ShouldPopOnRestart/.test(branch));
  check('  ↑ 并且把"为什么不弹"写给他看（免得他以为又是静默失败）',
    /不弹窗/.test(branch) && /留日志就行/.test(branch));
}
check('判断是否真停**不看子进程句柄**（Test-DshAlive 真探端口/判定源）',
  /function Test-DshAlive\s*\{/.test(src) && src.includes('if (Test-PortQuick $DshPort) { return $true }'));

// ── ② 契约：exit 1 在 dsh-window.cmd 里 = 立刻重起、**不用人敲任何键**────────
console.log('\n② 契约（dsh-window.cmd：exit 1 之后会发生什么）');
// ⚠ 按**整行标签**切块（`goto :restart` / `call :decide` 也会命中 indexOf(':restart')，不能拿 indexOf 切）
const cmdLines = cmd.split(/\r?\n/);
const labelAt = (name) => cmdLines.findIndex((l) => new RegExp(`^${name}\\s*$`).test(l.trim()));
const blockOf = (name) => {
  const i = labelAt(name);
  if (i < 0) return '';
  let j = i + 1;
  while (j < cmdLines.length && !/^:[a-z]/i.test(cmdLines[j].trim())) j++;
  return cmdLines.slice(i, j).join('\n');
};
const restartBlock = blockOf(':restart');
check('退出码 1 ⇒ DECISION=restart', /if "%~1"=="1" set "DECISION=restart"/.test(cmd));
check('DECISION=restart ⇒ goto :restart（循环里每处都有）',
  (cmd.match(/%DECISION%"=="restart" goto :restart/g) || []).length >= 2);
check(':restart ⇒ 换新日志 ⇒ 回到 :loop（同一个窗口重起）',
  /:restart[\s\S]*?call :newlog[\s\S]*?goto :loop/.test(cmd));
check('★ :restart 段里**没有任何等待输入**的语句（所以自动拉起不需要主人按键）',
  restartBlock.length > 0 && !/set\s+\/p/i.test(restartBlock), `:restart 段 = ${JSON.stringify(restartBlock)}`);
check('退出码 2（stdin 用尽）不走 restart（不会自己转圈）',
  !/if "%~1"=="2" set "DECISION=restart"/.test(cmd));

// ── ③ 真做一次：记账真的写得进、下一代替读得到、第 4 次停手 ────────────────
console.log('\n③ 真做一次（判定矩阵 + 记账真的落盘，写的都是 %TEMP% 的文件）');
const realBefore = fs.existsSync(REAL_STATE);
const tmp = path.join(os.tmpdir(), `dsh-ar-test-${process.pid}.json`);
if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
const envTmp = { DSH_WINDOW_AUTORESTART_FILE: tmp };

// 判定矩阵：DSH 活着 ⇒ 一次都不拉（子进程还在 = keep-running；子进程退了但 DSH 在 = adopt）
check('子进程还在 + DSH 活着 ⇒ keep-running（照常守着，什么都不做）',
  actOf(probe({ ...envTmp, DSH_WINDOW_DSH_ALIVE: '1' })) === 'keep-running');
check('子进程退了但 DSH 真在跑 ⇒ adopt（不喊停、不弹窗、不自动拉）',
  actOf(probe({ ...envTmp, DSH_WINDOW_CHILD_EXITED: '1', DSH_WINDOW_DSH_ALIVE: '1' })) === 'adopt');
// 真停 + 计数矩阵：0/1/2 ⇒ auto-restart；3 ⇒ alarm（上限 3 次）
for (const [n, want] of [[0, 'auto-restart'], [1, 'auto-restart'], [2, 'auto-restart'], [3, 'alarm']]) {
  const out = probe({ ...envTmp, DSH_WINDOW_CHILD_EXITED: '1', DSH_WINDOW_DSH_ALIVE: '0', DSH_WINDOW_AUTORESTART_ATTEMPTS: String(n) });
  check(`真停 + 10 分钟内已拉 ${n} 次 ⇒ ${want}`, actOf(out) === want, `实际：${actOf(out)}`);
  if (want === 'alarm') {
    check('  ↑ 这条路打出的是**红色告警**（含"我试了 N 次"），不是黄字自动修',
      /已经自动拉过 3 次/.test(line(out, '自动拉起：')) && /颜色 = Red|⛔/.test(out));
  }
  if (want === 'auto-restart' && n === 0) {
    check('  ↑ 这条路说清"本来会：先记账 → 第 N 次 → exit 1（不用他敲键）"',
      /本来会：\*\*先记账\*\*/.test(line(out, '本来会')) && /不用他敲任何键/.test(line(out, '本来会')));
  }
}
// （弹窗决策的验收挪到 ⑥ 频率告警：单次拉起不弹，只有"连着好几次"才弹 —— 主人的设计）
// 记账**真做一次**：写 → 读回 → 再写一次 → 读回（证明跨代际的计数真的会累加）
const rec1 = probe({ ...envTmp, DSH_WINDOW_CHILD_EXITED: '1', DSH_WINDOW_DSH_ALIVE: '0', DSH_WINDOW_AUTORESTART_RECORD: '1' });
check('★ 记账真的写出了文件（不是"本来会写"）', fs.existsSync(tmp), `没写出 ${tmp}`);
if (fs.existsSync(tmp)) {
  const raw = fs.readFileSync(tmp);
  const body = raw.toString('utf8');
  check('  写的是**不带 BOM** 的合法 JSON、带 ev 事件数组且**带来源**（严格读取者不会炸）',
    raw[0] !== 0xef && (() => {
      try { const o = JSON.parse(body); return Array.isArray(o.ev) && o.ev.length > 0 && !!o.ev[0].by && !!o.ev[0].t; } catch { return false; }
    })(), body.trim());
  check('  记的来源是 auto（自动拉起那条路）', (() => { try { return JSON.parse(body).ev.every((e) => e.by === 'auto'); } catch { return false; } })());
  check('  同一代里立刻读回 = 1 次（读的路径与下一代替读的是同一条）', /再读回 = 1 次/.test(rec1));
  const rec2 = probe({ ...envTmp, DSH_WINDOW_CHILD_EXITED: '1', DSH_WINDOW_DSH_ALIVE: '0', DSH_WINDOW_AUTORESTART_RECORD: '1' });
  const n2 = JSON.parse(fs.readFileSync(tmp, 'utf8')).ev.length;
  check('★ 第二次记账把计数**累加**到 2（= 跨代际封顶真的会生效）',
    n2 === 2 && /再读回 = 2 次/.test(rec2), `文件里 ${n2} 条；探针那句：${line(rec2, '再读回').trim()}`);
  // 到上限之后：即使记账文件里已经有 3 条，判定也必须是停手
  const rec3 = probe({ ...envTmp, DSH_WINDOW_CHILD_EXITED: '1', DSH_WINDOW_DSH_ALIVE: '0', DSH_WINDOW_AUTORESTART_ATTEMPTS: '3', DSH_WINDOW_AUTORESTART_RECORD: '1' });
  check('  到 3 次之后：判定停手（alarm）—— 不会因为"又能记一次"就再拉',
    actOf(rec3) === 'alarm');
}
check('★ 这个测试**没有**碰真记账文件（' + path.relative(REPO, REAL_STATE) + '）',
  fs.existsSync(REAL_STATE) === realBefore,
  '真文件的存在状态被这次测试改变了 ✗ 越界了');
if (fs.existsSync(tmp)) fs.unlinkSync(tmp);

// ── ⑥ 频率告警：短时间连着拉起好几次 ⇒ 主动报错（主人的设计指令 2026-09-25）────────
//    「如果是自动重启修复的话只要有日志就行了；弹不弹出主要看频率 —— 如果一段时间内连续重启了
//      很多次，说明系统可能出问题了，就可以给我发消息报错」
//    ⇒ 单次不弹（不打扰）、到阈值才红字报错 + 弹一次；阈值**与自动拉起上限同一套数**（10 分钟 3 次）。
console.log('\n⑥ 频率告警（连着好几次才报错；阈值与自动拉起上限同一套数）');
const flapLedger = path.join(os.tmpdir(), `dsh-flap-${process.pid}.json`);
/** 写账本：`by` 数组（'auto' = 看守自己拉的，'manual' = 主人按 r）；agoMin = 整批往前推多少分钟 */
const writeEvents = (bys, agoMin = 0) => {
  const ev = bys.map((by, i) => ({ t: new Date(Date.now() - agoMin * 60_000 + i * 1000).toISOString(), by }));
  fs.writeFileSync(flapLedger, JSON.stringify({ ev }), 'utf8');
};
const writeLedger = (n, agoMin = 0) => writeEvents(Array.from({ length: n }, () => 'auto'), agoMin);
const flapOf = (env) => probeSwitch('-FlapOnce', { DSH_WINDOW_AUTORESTART_FILE: flapLedger, ...env });
const flapDecision = (out) => ((/决定：([^\n]*)/.exec(out) || [])[1] || '(读不到)').trim();
const srcOf = (env) => probeSwitch('-RestartSourceOnce', { DSH_WINDOW_AUTORESTART_FILE: flapLedger, ...env });
const autoCountOf = (out) => { const m = /自动拉起\*\*次数：(\d+)/.exec(out); return m ? Number(m[1]) : -1; };
writeLedger(0);
check('0 次 ⇒ 不报（它没掉过）', /^不报/.test(flapDecision(flapOf({}))));
writeLedger(1, 1);
check('★ 1 次 ⇒ 不报（一次抖动而已，不打扰他 —— 这正是"只留日志"那条）',
  /^不报/.test(flapDecision(flapOf({}))), flapDecision(flapOf({})));
writeLedger(2, 2);
check('2 次 ⇒ 不报（没到阈值）', /^不报/.test(flapDecision(flapOf({}))));
writeLedger(3, 3);
const out3 = flapOf({ DSH_WINDOW_CONSOLE_MINIMIZED: '1' });
check('★ 3 次（10 分钟内）⇒ **报错**（红字 + 打扰他一次）', /报错/.test(flapDecision(out3)), flapDecision(out3));
check('  ↑ 文案说清"这不是一次抖动、像系统有问题、不是你没操作对"',
  /自己起来 3 次/.test(out3) && /不是你没操作对/.test(out3) && /系统层面有问题/.test(out3));
check('  ↑ 文案给了下一步（按 r / 想想别的东西在吃资源 / 按 ?）',
  /按 r 手动重起/.test(out3) && /吃资源/.test(out3) && /按 \? 看全部键位/.test(out3));
check('  ↑ 并且说清"我停手了，下次掉线不再自动拉"', /停手/.test(out3) && /不会再自动拉/.test(out3));
check('  ↑ 窗口缩着 ⇒ 打扰一次（发 QQ + 弹窗）', /打扰一次/.test(out3));
const out3v = flapOf({ DSH_WINDOW_CONSOLE_MINIMIZED: '0' });
check('  ↑ 窗口就在眼前 ⇒ 不弹（红字他自己看得见，不抢前台）', /打扰不打扰他：不打扰/.test(out3v));
// 冷却：刚打扰过 ⇒ 即便到了阈值也不再打扰（同一轮别反复抢前台/发消息）
fs.writeFileSync(flapLedger, JSON.stringify({ at: [new Date().toISOString(), new Date().toISOString(), new Date().toISOString()], popAt: new Date(Date.now() - 30_000).toISOString() }), 'utf8');
check('  ↑ 30 秒前刚打扰过 ⇒ 不再打扰（5 分钟冷却）', /打扰不打扰他：不打扰/.test(flapOf({ DSH_WINDOW_CONSOLE_MINIMIZED: '1' })));
writeLedger(3, 25);
check('★ 3 次但都在 25 分钟前（跨窗口）⇒ 计数归零 ⇒ 不报（不会拿旧账吓人）',
  /^不报/.test(flapDecision(flapOf({}))), flapDecision(flapOf({})));

// ★ 主通道 = 桥接转 QQ 私聊（协调会话更正：桥接是独立进程 + 有自己的守护 ⇒ DSH 停着也能发）。
//   用**假 relay 钩子**证明"真的调了、内容对、失败如实记"，**不真发 QQ** ✗。
console.log('  ── 主通道（QQ relay）：真调一次，但不真发 ──');
const hookLog = path.join(SCRATCH, 'relay-calls.log');
const hookPs1 = path.join(SCRATCH, 'fake-relay.ps1');
// ⚠ 别用模板字符串拼 Windows 路径：`\U` / `\s` 这类会被 JS 当转义吃掉（实测踩过两次：钩子写到别处，
//   表现成"根本没调用"）。一律用字符串拼接；钩子用 .ps1（还能保住 UTF-8：cmd 的 `%*` 会变乱码）。
const appendLine = "[System.IO.File]::AppendAllText('" + hookLog + "', $line + \"`n\", (New-Object System.Text.UTF8Encoding($false)))";
fs.writeFileSync(hookPs1, [
  "$line = ($args -join ' ')",
  appendLine,
  '$code = 0',
  'if ($env:FAKE_RELAY_EXIT) { $code = [int]$env:FAKE_RELAY_EXIT }',
  'exit $code',
].join('\r\n') + '\r\n', 'utf8');
// ⚠ 钩子 env 里**必须**带上账本注入（否则探针去读真账本 = 0 次 ⇒ 告警根本不触发、钩子当然不会被调）
const hookEnv = { DSH_WINDOW_AUTORESTART_FILE: flapLedger, DSH_WINDOW_RELAY_HOOK: hookPs1 };
const hookCalls = () => (fs.existsSync(hookLog) ? fs.readFileSync(hookLog, 'utf8').split(/\r?\n/).filter(Boolean) : []);
writeLedger(1, 1);
probeSwitch('-FlapOnce', { ...hookEnv, DSH_WINDOW_FLAP_SEND: '1' });
check('★ 阈值未到 ⇒ **不发**（1 次是正常抖动，不打扰）', hookCalls().length === 0, `实际 ${hookCalls().length} 次`);
writeLedger(3, 3);
const outSend = probeSwitch('-FlapOnce', { ...hookEnv, DSH_WINDOW_FLAP_SEND: '1' });
const calls = hookCalls();
check('★ 阈值到了 ⇒ **真的调了 relay**（假钩子记录到 1 次调用）', calls.length === 1, `实际 ${calls.length} 次`);
const ownerQQ = JSON.parse(fs.readFileSync(path.join(REPO, 'agent.config.json'), 'utf8')).ownerQQ || '';
check('  ↑ 收信人 = `private:<环境层的 ownerQQ>`（不是写死的号）',
  /^private:\d+$/.test((calls[0] || '').split(' ')[0]) && (calls[0] || '').includes(`private:${ownerQQ}`),
  `实际：${calls[0] || '(无)'}（环境层 ownerQQ=${ownerQQ}）`);
check('  ↑ 消息内容对（说清次数、不正常、让他看一眼）且**不含**令牌/路径/端口',
  /自己起来 3 次/.test(calls[0] || '') && /不太正常/.test(calls[0] || '') && /黑窗口/.test(calls[0] || '') &&
  !/token|Bearer|[A-Z]:\\|:3\d{3}/.test(calls[0] || ''), `实际：${calls[0] || '(无)'}`);
check('  ↑ 探针报告 ok=True', /真做一次\] 结果：ok=True/.test(outSend));
// 反例：relay 失败 ⇒ 如实报 ok=False + 原因（绝不假装发出去）
if (fs.existsSync(hookLog)) fs.unlinkSync(hookLog);
const outFail = probeSwitch('-FlapOnce', { ...hookEnv, DSH_WINDOW_FLAP_SEND: '1', FAKE_RELAY_EXIT: '3' });
check('★ relay 失败（退出码 3）⇒ 如实报 ok=False + 原因，不假装发出去',
  /真做一次\] 结果：ok=False/.test(outFail) && /假 relay 返回 3/.test(outFail));
// 反例：没挂假钩子时，探针**拒绝**真发（免得误发 QQ）
const outNoHook = probeSwitch('-FlapOnce', { DSH_WINDOW_AUTORESTART_FILE: flapLedger, DSH_WINDOW_FLAP_SEND: '1' });
check('★ 没挂假钩子 ⇒ 探针**拒绝**真发 QQ（要验必须挂钩子）',
  /拒绝：没设 DSH_WINDOW_RELAY_HOOK/.test(outNoHook));
check('  ↑ 正常流程（不加 FLAP_SEND）时探针只"本来会"，不调任何东西',
  /本来会：node tools\\ops\.mjs relay private:\d+/.test(out3) && !/真做一次/.test(out3));
check('  ↑ 窗口里明说"发不出去会写主通道没成、绝不假装"', /绝不假装发出去了/.test(out3));

// ── ⑥b ★★ 主 bug：**手动按 r 不许计入自动拉起次数**（主人 2026-09-25 实测发现）──────────
//    「自动修会弹一下出来然后就回去；**按 r 的话这个自动修好像也计入次数**」
//    ⇒ 账本按来源分开记：只有 by='auto' 算自动拉起；新代那句"我已经把它拉回来了"只在**确实是自己
//      拉起来的那一代**印（手动 r 之后印那句 = 假信息，而且他手动重起 3 次会收到假报警）。
console.log('\n⑥b 手动按 r 不计入自动拉起次数（四条反例，全部真跑）');
// ① 手动重起 3 次 ⇒ 计数 0、不报警
writeEvents(['manual', 'manual', 'manual'], 3);
const outM3 = srcOf({});
check('★ ① 手动重起 3 次 ⇒ 自动拉起计数 = **0**', autoCountOf(outM3) === 0, `实际 ${autoCountOf(outM3)}`);
check('  ↑ 判定"不是自动拉起"（不印那句"我已经把它拉回来了"）', /不是自动拉起/.test(outM3));
check('  ↑ 改印中性说明：这一次是你自己按 r 重起的、**没算进自动拉起次数**',
  /这一次是你自己按 r 重起的/.test(outM3) && /没算进自动拉起次数/.test(outM3));
check('★ ① 手动 3 次 ⇒ 频率告警**不报**（不会拿他正常的操作吓他）',
  /^不报/.test(flapDecision(flapOf({}))), flapDecision(flapOf({})));
// ② 自动拉起 3 次 ⇒ 计数 3、报警、且这一代确实会说"我把它拉回来了"
writeEvents(['auto', 'auto', 'auto'], 3);
const outA3 = srcOf({});
check('★ ② 自动拉起 3 次 ⇒ 计数 = 3', autoCountOf(outA3) === 3, `实际 ${autoCountOf(outA3)}`);
check('  ↑ 判定"是它拉起来的这一代"（该如实说"我把它拉回来了"）',
  /是它拉起来的这一代/.test(outA3) && /我已经把它拉回来了/.test(outA3));
check('★ ② 自动 3 次 ⇒ 频率告警**报错**', /报错/.test(flapDecision(flapOf({}))));
// ③ 混着来（1 自动 + 2 手动）⇒ 计数 1、不报警；最近一次是手动 ⇒ 不印那句
writeEvents(['auto', 'manual', 'manual'], 3);
const outMix = srcOf({});
check('★ ③ 1 自动 + 2 手动 ⇒ 计数 = **1**（只数自动那次）', autoCountOf(outMix) === 1, `实际 ${autoCountOf(outMix)}`);
check('  ↑ 最近一次是手动 ⇒ 不印"我把它拉回来了"，改印中性说明',
  /不是自动拉起/.test(outMix) && /这一次是你自己按 r 重起的/.test(outMix));
check('★ ③ 混着来 ⇒ 频率告警**不报**（没到 3 次自动）', /^不报/.test(flapDecision(flapOf({}))));
// ④ 真记一次 manual：**auto 计数必须不变**（这就是这个 bug 的核心证据）
writeEvents(['auto'], 1);
const outRec = srcOf({ DSH_WINDOW_RECORD_MANUAL: '1' });
check('★ ④ 真记一条 manual 事件 ⇒ auto 条数 **1 → 1 不变**（修的就是这个）',
  /记账.*auto 条数 1 → 1/.test(outRec) || /auto 条数 1 → 1/.test(outRec), (line(outRec, '真做一次') || '').trim());
check('  ↑ 记完最近一条的来源是 manual', /记完最近一条 = .*（来源=manual）/.test(outRec), (line(outRec, '记完最近一条') || '').trim());
// ⑤ 旧格式（没有来源的 `at` 数组）当 auto 读 —— 向后兼容，不炸
fs.writeFileSync(flapLedger, JSON.stringify({ at: [new Date(Date.now() - 60_000).toISOString()] }), 'utf8');
check('⑤ 旧格式账本（`at` 里没有来源）当 auto 读 ⇒ 计数 1（向后兼容，不炸）',
  autoCountOf(srcOf({})) === 1, `实际 ${autoCountOf(srcOf({}))}`);

// ── ⑦ "别刷屏"：一次真启动他到底会看到几行（主人："等待的时间会刷屏、一直弹消息"）────
console.log('\n⑦ 刷屏治理（一次完整启动的行数 + 反例）');
const st = (dsh, bridge, snow, qq, text, allGreen) => ({ allGreen, nextAction: { text }, lights: { dsh, bridge, snowluma: snow, qq } });
const stPath = (o, name) => { const p = path.join(SCRATCH, name); fs.writeFileSync(p, JSON.stringify(o), 'utf8'); return p; };
const seqStep = (prev, now, lastPrintMs) => probeSwitch('-StatusOnce', {
  DSH_WINDOW_STATUS_JSON_PREV: stPath(prev, `prev-${++probeSeq}.json`),
  DSH_WINDOW_STATUS_JSON_NOW: stPath(now, `now-${probeSeq}.json`),
  ...(lastPrintMs != null ? { DSH_WINDOW_STATUS_LAST_PRINT_MS: String(lastPrintMs) } : {}),
});
const printedLines = (out) => { const m = /会重印这 (\d+) 行/.exec(out); return m ? Number(m[1]) : 0; };
// 真实启动序列（每步间隔 5 秒；起点是他按下一键启动前那一屏）
const S0 = st(false, false, false, false, 'DSH 没在跑', false);
const S1 = st(false, true, false, false, 'DSH 正在起（令牌已同步）', false);
const S2 = st(true, true, false, false, 'SnowLuma 还没起来', false);
const S3 = st(true, true, true, false, 'QQ 还没登录', false);
const S4 = st(true, true, true, true, '一切正常', true);
// 第 1 步：还没印过 ⇒ 印一行（之后才有"变了"可比）
const p1 = seqStep(S0, S1, 10 * 60_000);
check('第 1 步（第一次拿到状态）⇒ 印 1 行', printedLines(p1) === 1, `实际 ${printedLines(p1)} 行`);
check('  它现在是**一行**（原来是 6 行：框+状态+灯+刚才+框+空行）',
  /会重印这 1 行/.test(p1) && /灯 /.test(p1) && /刚才/.test(p1), (line(p1, '灯 ') || '').trim());
// 第 2 步：5 秒后 DSH 灯翻 ✗→✓ ⇒ 这是"能不能用"，必须立刻印（哪怕没到合并窗口）
const p2 = seqStep(S1, S2, 5_000);
check('★ 第 2 步（DSH 灯 ✗→✓，5 秒后）⇒ 立刻印（"能不能用"变了，不等合并窗口）',
  printedLines(p2) === 1 && /DSH 那一盏/.test(p2), `实际 ${printedLines(p2)} 行；理由：${(line(p2, '理由') || '').trim()}`);
// 第 3 步：又 5 秒，只有 SnowLuma 灯亮（不碰"能不能用"）⇒ 攒着，不印
const p3 = seqStep(S2, S3, 5_000);
check('★ 第 3 步（只是 SnowLuma 亮了，5 秒后）⇒ **不印**（攒着，跟后面的变化合并）',
  printedLines(p3) === 0 && /攒着/.test(p3), `实际 ${printedLines(p3)} 行；${(line(p3, '[状态行]') || '').trim()}`);
// 第 4 步：50 秒后全绿 ⇒ "可以用了" ⇒ 立刻印，而且**把第 3 步攒下的一起说完**
const p4 = seqStep(S2, S4, 50_000);
check('★ 第 4 步（变全绿）⇒ 立刻印，并把攒下的变化一次说完（一行里含多件事）',
  printedLines(p4) === 1 && /全绿/.test(p4), `实际 ${printedLines(p4)} 行`);
check('  ↑ 一行里同时有：全绿 + 灯 + "刚才：…"（不再分 6 行）',
  /灯 /.test(p4) && /刚才：/.test(p4));
// 反例：一直没变化 ⇒ 一行都不印（不许恒真）
const pSame = seqStep(S4, S4, 5_000);
check('★ 反例：状态没变 ⇒ 一行都不印', printedLines(pSame) === 0 && /一模一样/.test(pSame));
// 反例：只有"那句话"变了、且距上次印 5 秒 ⇒ 也不印（不许拿这类变化刷屏）
const pText = seqStep(S3, { ...S3, nextAction: { text: '那句话换了个说法' } }, 5_000);
check('★ 反例：只是那句话变了、距上次印 5 秒 ⇒ 不印', printedLines(pText) === 0, `实际 ${printedLines(pText)} 行`);
const pText61 = seqStep(S3, { ...S3, nextAction: { text: '那句话换了个说法' } }, 61_000);
check('  同一种变化、距上次印 61 秒 ⇒ 印（一分钟内的多次变化合并成一次）', printedLines(pText61) === 1);
// 合计：一次完整冷启动他会看到几行
const total = [p1, p2, p3, p4].reduce((a, o) => a + printedLines(o), 0);
console.log(`  ℹ️  **一次完整冷启动合计 ${total} 行**（改动前：一变就印 6 行 × 4~6 次 ≈ 24~36 行）`);
check('★ 一次完整冷启动 ≤ 4 行（改动前的 1/6 以下）', total <= 4, `实际 ${total} 行`);
// ★ "已知启动窗口内（…还剩 N 秒）"那句**同一个窗口只说一遍**（协调会话定位：它原来每轮都印 ✗）
const graceSrc = (src.match(/elseif \(\$starting -and -not \$green\) \{[\s\S]*?\n            \} elseif/) || [''])[0];
check('★ 启动窗口那句倒数句加了"同一个窗口只说一遍"的闸（原来每轮都印 ⇒ 刷屏）',
  /graceSaidFor/.test(graceSrc) && /graceSaidFor -ne \$what/.test(graceSrc), graceSrc.slice(0, 120));
check('  ↑ 而且明确写了"这句同一个启动窗口只说一遍"', /同一个启动窗口只说一遍/.test(graceSrc));
if (fs.existsSync(flapLedger)) fs.unlinkSync(flapLedger);

// ── ④ 告警措辞：不许出现"猜的原因"（主人 2026-09-25 用任务管理器反驳了"内存吃紧"）──
console.log('\n④ 告警措辞（假原因和假告警一样有害）');
const stopped = probe({ ...envTmp, DSH_WINDOW_CHILD_EXITED: '1', DSH_WINDOW_DSH_ALIVE: '0', DSH_WINDOW_AUTORESTART_ATTEMPTS: '0' });
const alarm = alarmText(stopped);
const whyBody = (src.match(/function Get-DshStopWhy\s*\{[\s\S]*?\n\}/) || [''])[0];
check('告警里保留了"不是你按错了"', /不是你按错了/.test(alarm));
check('★ 告警里**不再**出现"内存吃紧"这种没实测过的原因',
  !/内存吃紧/.test(alarm) && whyBody.length > 0 && !/内存吃紧/.test(whyBody),
  '（注意：源码注释里可以写"为什么删掉它"，但**打给人的那句话**与 Get-DshStopWhy 的正文里不许出现）');
check('  改成如实说"什么原因我还不知道"', /什么原因我还不知道/.test(alarm));
check('  并且给出下一步（按 r / 回车）', /输入 r|直接回车/.test(alarm));

// ── ⑧ 启动器收尾那一步：本轮新起了 SnowLuma ⇒ 必须带 -ForcePage snowluma ──────────
// 背景（2026-09-25 主人报「没刷新页面 + SnowLuma 令牌没更新」）：72cfd22 把**有条件**的那行删成了
// "永远不传" ⇒ 去重把死标签当成"已开着" ⇒ 既不刷新页面、也不写新令牌。这里钉死两半：
//   ① 启动器：`$SnowLumaStarted` 为真时必须把 -ForcePage snowluma 加进参数（**有条件**，不是无条件）；
//   ② 补缺路（按 r）：只有 by=manual 那一代才不传 -NoOpen（自动拉起必须保持 -NoOpen，绝不弹页面）。
const START_ALL = fs.readFileSync(path.join(TOOLS, 'start-all.ps1'), 'utf8');
check('⑧ 启动器：本轮新起了 SnowLuma 时必须 `$panelArgs += @(\'-ForcePage\', \'snowluma\')`（有条件）',
  /if\s*\(\s*\$SnowLumaStarted\s*\)\s*\{\s*\$panelArgs\s*\+=\s*@\('-ForcePage'\s*,\s*'snowluma'\)\s*\}/.test(START_ALL));
check('⑧ 启动器：不许回到"无条件强制重开"的老路（-Pages all 里直接塞 -ForcePage）',
  !/\$panelArgs\s*=\s*@\('open'\s*,\s*'-Pages'\s*,\s*'all'\s*,\s*'-ForcePage'/.test(START_ALL));
check('⑧ 补缺路：`Invoke-MissingServices` 用 `Resolve-MissingServiceOpenFlag` 决定要不要 -NoOpen',
  src.includes('Resolve-MissingServiceOpenFlag') && /function Invoke-MissingServices[\s\S]{0,2600}Resolve-MissingServiceOpenFlag[\s\S]{0,400}\$missingSvcArgs/.test(src));
check('⑧ 补缺路：只有 by=manual 才 noOpen=false（自动拉起 / 无账本 ⇒ 保持 -NoOpen）',
  /function Resolve-MissingServiceOpenFlag[\s\S]{0,900}by -eq 'manual'[\s\S]{0,300}noOpen = \$false/.test(src));

// ── ⑤ 报告（不是断言，是"这次漏掉的那个陷阱"）────────────────────────────
// 判据：**现在活着的那一代窗口是什么时候起来的**。guard 日志名就是那一刻（dsh-window.cmd :newlog
// 用当时的时刻命名，`:restart` 时换一个新的 ⇒ 最新那个日志名 = 当前这一代的起点）。
// ⚠ 这里**不能用 `Get-CimInstance Win32_Process`**：本沙箱里它返回 0 条（实测），会得出"没在跑"的假结论。
console.log('\n⑤ 时效报告：现在活着的这一代窗口**有没有**这段代码');
try {
  const outFile = path.join(SCRATCH, 'status.txt');
  const fd = fs.openSync(outFile, 'w');
  try {
    spawnSync(process.execPath, [path.join(TOOLS, 'ops.mjs'), 'status'],
      { cwd: REPO, stdio: ['ignore', fd, 'ignore'], windowsHide: true });
  } finally { fs.closeSync(fd); }
  const status = fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '');
  const m = status.match(/server-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.out\.log/);
  const mtime = fs.statSync(PS1).mtime;
  if (!m) {
    console.log('  ℹ️  读不到最新 guard 日志名（DSH 没在跑？）⇒ 无法判断时效');
  } else {
    const started = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    const fmt = (d) => d.toLocaleString('zh-CN', { hour12: false });
    console.log(`  ℹ️  活着的这一代起于 ${fmt(started)}（${m[0]}）`);
    console.log(`  ℹ️  tools\\dsh-prompt.ps1 最后改动  ${fmt(mtime)}`);
    if (started < mtime) {
      console.log('  ⚠️  **这一代比代码旧** ⇒ 它跑的是旧代码：这次改动要等他按 r（或重开窗口/重新开机）才生效。');
      console.log('      （2026-09-25 真机"没自动拉起"就是这个原因 —— 长驻进程只加载一次代码，不是逻辑错。）');
    } else {
      console.log('  ✅ 这一代比代码新 ⇒ 现在活着的窗口已经带着这段代码。');
    }
  }
} catch (e) {
  console.log(`  ℹ️  时效报告拿不到信息（${e.message.split('\n')[0]}）—— 不影响上面的断言`);
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑨ 行为探针："r 之后页面要不要一起开"（2026-09-25 20:0x，优化线小锤）
//   为什么必须**行为层**钉：源码棘轮钉的是**字面**（`if ($SnowLumaStarted)` 那种），挡不住**语义写反**
//   （manual/auto 判反、-NoOpen 拼到错的一支）。这四条断言真跑 `-EnsureOnce`（只读入口、不起服务），
//   看它**印出来的参数**；并且要求三种输入**恰好产出两种**结果 —— 任何"恒印一句"的实现当场红。
console.log('\n⑨ 行为探针：r 之后"页面要不要一起开"（manual/auto 语义写反 ⇒ 必须红）');
{
  const ensureLog = path.join(REPO, 'qq-bridge', 'state', '_tmp', 'ensure-services.out.log');
  const logMtime = () => (fs.existsSync(ensureLog) ? fs.statSync(ensureLog).mtimeMs : -1);
  const before = logMtime();
  // ★ 2026-09-26（小扳）：这里必须**强装 QQ 在本机**（`DSH_WINDOW_QQ_MOVED_FILE` 指向不存在的文件）——
  //   本机标记文件 qq-bridge\qq-moved-to-server 是在的，而「QQ 不在本机」那条路**不再走启动器**
  //   （改走 tools\control-plane.ps1 只补控制面）⇒ 不装的话这四条断言抓不到 start-all 那行（假红）。
  const ensureOf = () => probeSwitch('-EnsureOnce', {
    DSH_WINDOW_AUTORESTART_FILE: flapLedger, DSH_WINDOW_DSH_ALIVE: '1', DSH_WINDOW_CONTROL_ALIVE: '0',
    DSH_WINDOW_QQ_MOVED_FILE: path.join(SCRATCH, 'no-such-qq-moved-marker'),
  });
  // ⚠ 提取必须钉在**那行命令行**上（以 powershell 开头）：`[补缺] <why>` 的散文里也会出现 `start-all.ps1 …`
  //   （L1008 的 why 文案就是），按第一个 `start-all.ps1` 去抓会抓到散文 ⇒ manual 那条会**假通过**。
  const argsOf = (out) => ((/powershell[^\n]*start-all\.ps1([^\n]*)/.exec(out) || [])[1] || '(读不到)').trim();
  try { fs.rmSync(flapLedger, { force: true }); } catch { /* 没有就没有 */ }
  const outNone = ensureOf();
  // ⚠ 账本窗口 = **600 秒**（`$script:AutoRestartWindowSec`）：fixture **必须落在窗口内**，否则就落进
  //   "没有账本"那一支、三例会塌成同一种输出。我第一版写成 12 分钟，被下面的"不恒真守卫"当场抓住 ——
  //   那正是这条守卫的用处（先证明断言本身是活的，再拿它去咬代码）。
  writeEvents(['auto'], 1);
  const outAuto = ensureOf();
  writeEvents(['manual'], 1);
  const outManual = ensureOf();
  // 窗口语义（钉住 `docs\启动与踩坑.md` 写下的口径）：**超窗口的旧 manual 会被忘掉** ⇒ 仍按自动处理。
  writeEvents(['manual'], 12);
  const outStale = ensureOf();
  const aNone = argsOf(outNone); const aAuto = argsOf(outAuto); const aManual = argsOf(outManual); const aStale = argsOf(outStale);
  check('无账本 ⇒ 参数里带 -NoOpen（保守：首次启动 / 夜里不弹他一脸页面）', /-NoOpen/.test(aNone), aNone);
  check('最后一条是 auto ⇒ 带 -NoOpen（自动拉起不打扰）', /-NoOpen/.test(aAuto), aAuto);
  check('★ 最后一条是 manual ⇒ **不带** -NoOpen（他就在机器前，页面这一环一起做）', !/-NoOpen/.test(aManual), aManual);
  check('★ 窗口语义：超窗口（>600s）的旧 manual 会被忘掉 ⇒ 仍带 -NoOpen（同一条口径也写在 docs\启动与踩坑.md 里）',
    /-NoOpen/.test(aStale), aStale);
  const uniq = new Set([aNone, aAuto, aManual].map((s) => s.replace(/\s+/g, ' ')));
  check('★ 不恒真守卫：三种输入必须恰好产出两种参数（恒印一句 / 恒带 -NoOpen 的实现当场红）', uniq.size === 2, `不同输出 ${uniq.size} 种`);
  check('只读入口仍然不起服务（输出带 [只读探针] 标记）', /\[只读探针\]/.test(outNone));
  check('★ 零副作用：没真去拉服务（ensure-services.out.log 的 mtime 未变）', logMtime() === before);
  // ★ 2026-09-26（小扳）：**QQ 不在本机那一支**（搬家之后 / 只开DSH）—— 主人报「总控的灯不见了」的正解。
  //   不装 QQ 在本机 ⇒ 走的必须是「只补控制面」那一份唯一起法，且**绝不经过启动器**（-NoRestart 会抢号）。
  const outNotLocal = probeSwitch('-EnsureOnce', { DSH_WINDOW_DSH_ALIVE: '1', DSH_WINDOW_CONTROL_ALIVE: '0' });
  check('★ QQ 不在本机 ⇒ **只补控制面**（走 tools\\control-plane.ps1 的 Start-ControlPlane 那一份唯一起法）',
    /control-plane\.ps1[\s\S]{0,120}Start-ControlPlane/.test(outNotLocal), '（探针输出里没有 control-plane.ps1 / Start-ControlPlane）');
  check('★ QQ 不在本机 ⇒ **绝不经过 start-all**（-NoRestart 会把 SnowLuma / 桥接一起起出来 ⇒ 抢号）',
    !/powershell[^\n]*start-all\.ps1/.test(outNotLocal));
  check('★ 反向：装成 QQ 在本机 ⇒ 仍是启动器那一条（这一支没被改坏）',
    /powershell[^\n]*start-all\.ps1/.test(ensureOf()));
  const callSites = (src.match(/Resolve-MissingServiceOpenDecision/g) || []).length;
  check('★ 唯一口径：判定函数"定义 1 次 + 两处调用"（-EnsureOnce 与 Invoke-MissingServices 共用）', callSites >= 3, `出现 ${callSites} 次`);
  const ensureBlock = (src.match(/if \(\$EnsureOnce\) \{[\s\S]*?\n\}/) || [''])[0];
  // 棘轮只钉 `-EnsureOnce` **那一支**（整份 src 里还有别处会出现这个参数串的散文描述 —— 我第一版就是这样误报的：
  // 它反而逮出了 Resolve-MissingServices 的 why 文案里也写死了 -NoOpen，那条已修）。
  check('★ 老硬编码已消灭：-EnsureOnce 分支里不再写死那条命令行（改用共用判定）',
    /Resolve-MissingServiceOpenDecision/.test(ensureBlock) && !/start-all\.ps1 -NoRestart -NoOpen -KeepWindow/.test(ensureBlock));
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑩ 状态行精简（2026-09-25 主人嫌啰嗦；优化线 63889df1）：**档位进签名** ⇒ 步数每涨一步不再重印
console.log('\n⑩ 状态行精简：档位进签名（步数每涨一步不再重印）');
{
  const wj = (o, name) => { const p = path.join(SCRATCH, name); fs.writeFileSync(p, JSON.stringify(o), 'utf8'); return p; };
  const lightsOk = { dsh: true, bridge: true, snowluma: true, qq: true };
  const sess = (steps, extra = {}) => ({
    allGreen: true, nextAction: { text: '一切正常' }, lights: { ...lightsOk },
    current: { id: 's1', shortId: 's1', steps, turns: 3, cost: 1.2, ...extra },
  });
  const nOf = (out) => { const m = /会重印这 (\d+) 行/.exec(out); return m ? Number(m[1]) : 0; };
  const once = (prevObj, nowObj) => probeSwitch('-StatusOnce', {
    DSH_WINDOW_STATUS_JSON_PREV: wj(prevObj, 'st-prev.json'),
    DSH_WINDOW_STATUS_JSON_NOW: wj(nowObj, 'st-now.json'),
    DSH_WINDOW_STATUS_LAST_PRINT_MS: '600000',
  });
  const oCross = once(sess(199), sess(205));
  check('★ 跨档（199 → 205 步）⇒ 必须重印（那一格冒出来提醒归档）', nOf(oCross) > 0, `重印 ${nOf(oCross)} 行`);
  const oSame = once(sess(205), sess(260));
  check('★★ 同档（205 → 260 步）⇒ **不重印**（这正是主人嫌啰嗦的根因：原来一步一变就重印一行）', nOf(oSame) === 0, `重印 ${nOf(oSame)} 行`);
  const oLow = once(sess(12), sess(37));
  check('同档（12 → 37 步，都没到档）⇒ 不重印', nOf(oLow) === 0, `重印 ${nOf(oLow)} 行`);
  const oArmed = once(sess(205), sess(205, { armed: true }));
  check('★ 已授权归档那一刻 ⇒ 必须重印（那一格的话翻成"跑完自动归档"，不能让他一直看旧的）', nOf(oArmed) > 0, `重印 ${nOf(oArmed)} 行`);
  const oLights = once(sess(205), { ...sess(205), lights: { dsh: true, bridge: false, snowluma: true, qq: true } });
  check('灯态变了 ⇒ 照旧重印（精简不许把"能不能用"的变化也吞掉）', nOf(oLights) > 0, `重印 ${nOf(oLights)} 行`);
  const oText = once(sess(205), { ...sess(205), nextAction: { text: '那句话换了个说法' } });
  check('那句话变了 ⇒ 照旧重印', nOf(oText) > 0, `重印 ${nOf(oText)} 行`);
  const steady = once(sess(205), sess(205));
  check('完全没变 ⇒ 不重印（稳态不刷屏）', nOf(steady) === 0, `重印 ${nOf(steady)} 行`);
  check('★ 源码棘轮：签名只放档位（#tier=）、精确数不再进签名（#steps= / #turns= / #cost= 都消失）',
    /#tier=/.test(src) && !/#steps=/.test(src) && !/#turns=/.test(src) && !/#cost=/.test(src));
  check('★ 源码棘轮：档位只看 200 那一档（Get-StepsTier 用 StepsWarnAt，与"建议归档"同一判据）',
    /function Get-StepsTier[\s\S]{0,220}StepsWarnAt/.test(src));
  check('★ 那一格的文案不带精确数（否则又变成一步一变、每变一次重印一行）',
    /本对话已到建议归档档（≥\{0\} 步）/.test(src) && !/本对话 \{0\} · 建议归档/.test(src));
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑪ 补缺流水静默 + 窗口默认最小化（2026-09-25 主人亲口提的两件；优化线 63889df1）
console.log('\n⑪ 补缺流水默认静默 + 补缺那条不再强制留桌面');
{
  // ① 默认静默：判定开关 + 打印开关两处都得对（缺一处就等于没静默）
  check('★ 静默开关默认开（只有 DSH_WINDOW_REPAIR_VERBOSE=1 才啰嗦）',
    /\$script:RepairQuiet = -not \(\$env:DSH_WINDOW_REPAIR_VERBOSE -eq '1'\)/.test(src));
  check('★ 打印口只在「要求详情」或「-Always」时出声',
    /if \(\$Always -or -not \$script:RepairQuiet\) \{ Write-Host/.test(src));
  check('细节仍落日志（别丢）：launcher-repair.log + Add-Content',
    /launcher-repair\.log/.test(src) && /Add-Content -Path \$log/.test(src));

  // ② 运行路径的流水都改走 Write-RepairNote（旧的裸 Write-Host 不许残留）
  const barePrints = (src.match(/Write-Host \('   \[补缺\] ' \+ \$plan\.why\)/g) || []).length;
  check('★★ 运行路径里不再有裸打印的补缺流水（旧写法残留 0 处）', barePrints === 0, `残留 ${barePrints} 处`);
  const notes = (src.match(/Write-RepairNote/g) || []).length;
  check('成功/无事可做的流水都走 Write-RepairNote（≥5 处：skip/repair/页面/已起来/下一步）', notes >= 5, `${notes} 处`);

  // ③ ★ 反向守卫（不恒真）：失败与「判不准」**必须**照打 —— 谁把 -Always 删了当场红
  const always = (src.match(/Write-RepairNote [^\n]*-Always/g) || []).length;
  check('★★ 失败/判不准四处照打（-Always ≥ 4：找不到启动器 / 拉启动器失败 / 还是没起来 / 出错）',
    always >= 4, `-Always ${always} 处`);
  check('★ 静默不等于把失败也吞了：⚠ 那几条仍在源码里（含 -Always）',
    /Write-RepairNote '⚠ 控制面\*\*还是没起来\*\*/.test(src) && /Write-RepairNote \('⚠ 拉启动器失败/.test(src));

  // ④ 窗口：补缺那条不再传 -KeepWindow（根因），真路径与只读探针两边都不许有
  const keepInSpawn = /'-NoRestart', '-KeepWindow'/.test(src);
  check('★★ 补缺的 spawn 不再带 -KeepWindow（= 别名 -NoMinimize ⇒ 强制留桌面，正是主人看到的那个现象）', !keepInSpawn);
  const svcArgsKeep = /\$svcArgs \+= '-KeepWindow'/.test(src);
  check('★ 只读探针那行也同步去掉（否则「验收看到的」≠「真跑的」）', !svcArgsKeep);
  check('补缺那条仍然带 -NoRestart（在跑的一律不动）', /'-NoRestart'\) \+ \$missingSvcArgs/.test(src));
  check('口径写进注释，别让下一个人重新推一遍',
    /不再带 `-KeepWindow`/.test(src) && /正常启动 \/ 掉线自愈 \/ 补缺一律最小化/.test(src));
  check('帮助里也写了（主人按 ? 能查到：默认不打屏 + 日志路径 + 详细开关）',
    /补缺（"控制面没在监听/.test(src) && /DSH_WINDOW_REPAIR_VERBOSE=1/.test(src));
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑫ 止血：判死前先记证据 + 文件开关（2026-09-25 19:4x 主人现场报「又掉了」）
console.log('\n⑫ 自动重起止血：先记证据 + 文件开关');
{
  check('★ 判死之前先写证据（顺序在同一分支内：证据行在记账/重起之前）',
    /Write-AutoRestartEvidence \(Get-AutoRestartEvidence \$h\)[\s\S]{0,900}\$rec = Add-AutoRestartAttempt/.test(src));
  check('证据四要素齐全（端口探活 / 控制面问不问得到 / lights.dsh / 当时会话）',
    /端口 :\{0\} 探活=\{1\}/.test(src) && /控制面问得到=\{2\}/.test(src) && /lights\.dsh=\{3\}/.test(src) && /当时会话=\{4\}/.test(src));
  check('证据落 state\\dsh-autorestart-evidence.log（只追加，不改状态）',
    /dsh-autorestart-evidence\.log/.test(src) && /Add-Content -Path \$f -Encoding UTF8/.test(src));
  check('★ 文件开关：state\\dsh-autorestart-off 存在 ⇒ 不拉',
    /dsh-autorestart-off/.test(src) && /function Test-AutoRestartDisabled/.test(src) && /Test-AutoRestartDisabled\) \{/.test(src));
  check('★★ 开关命中时不是静默吞掉：红字叫人 + **发一条 QQ** + break（不 exit 1 ⇒ 不重起）',
    /escalate-switch-off'\) \{[\s\S]{0,900}\$script:StopEscalated[\s\S]{0,400}ForegroundColor Red[\s\S]{0,400}Send-OwnerQqNotice[\s\S]{0,200}break/.test(src));
  check('★ 纯函数没被污染（止血只发生在判定路，Resolve-StopHandling / Resolve-AutoRestart 签名不变）',
    /function Resolve-StopHandling \{/.test(src) && /function Resolve-AutoRestart \{/.test(src) && !/function Resolve-StopHandling \{[\s\S]{0,200}Test-AutoRestartDisabled/.test(src));
}

// ── ⑨ 判死闸（2026-09-25 判据①②）：有会话在跑 ⇒ 宁可不拉；真死 ⇒ 必出一条 QQ ──────────────
console.log('\n⑨ 判死闸：判据①"忙就不拉" + 判据②"真死也发 QQ"');
check('★ 判死用的是"耐心探针"（连续 N 次都问不到才算死，默认 3 次 / 每次 1.5s）',
  /function Test-DshAliveSettled \{/.test(src) && /\$Tries = 3, \[int\]\$TimeoutMs = 1500/.test(src) && /for \(\$i = 1; \$i -le \$Tries; \$i\+\+\)/.test(src));
check('★ 判据①的旁证只读会话流水 mtime（不依赖 DSH 响应 —— 忙着的 DSH 恰恰不响应）',
  /function Get-SessionBusyHint \{/.test(src) && /LastWriteTime -gt \$cut/.test(src));
check('★ 有会话在跑 ⇒ hold：宁可不拉（不记账、不发 QQ、不 exit 1）',
  /if \(\$SessionsBusy\) \{[\s\S]{0,200}act = 'hold'/.test(src) && !/act = 'hold'[\s\S]{0,300}exit 1/.test(src));
check('★ "动不动手 / 要不要发 QQ"收在一个纯函数里（Resolve-DeathAction）',
  /function Resolve-DeathAction \{/.test(src) && /escalate-switch-off/.test(src) && /escalate-ledger/.test(src) && /escalate-max/.test(src));
check('★ 判据②：三条"不拉"的路各有一条 QQ（开关关着 / 记账失败 / 到上限）',
  (src.match(/Send-OwnerQqNotice -Text/g) || []).length >= 3 && /function Send-OwnerQqNotice \{/.test(src));
check('★ QQ 发法复用现成的 tools\\qq-notify.mjs（OneBot 直连、不经桥接；那个文件归执行线，本批没碰它）',
  /Join-Path \$PSScriptRoot 'qq-notify\.mjs'/.test(src));
check('★ 判据①的另一半：重起只碰 DSH —— Stop-DshChild 只杀自己那个子进程的进程树',
  (() => { const i = src.indexOf('function Stop-DshChild {'); if (i < 0) return false; const seg = src.slice(i, i + 900);
    return /taskkill \/PID ' \+ \$c\.Id/.test(seg) && !/3100|3101|stop-all|start-all/.test(seg); })());  // port-literal-ok: 反向断言（这段不许碰桥接那两个端口），不是配置
check('★ 判据②之补：**每一次自动拉起**都给他一条 QQ（发在 Stop-DshChild / exit 1 之前）',
  (() => {
    // ⚠ 别拿"拉起那条文案"或 `if ($h.act -eq 'auto-restart')` 当锚点：它们**都先在探针里出现一次**
    //    （`-CheckDeathGate` / `-CheckStopOnce`），从那儿切会先撞上 `function Stop-DshChild {` 的定义
    //    与别的注释里的端口号 ⇒ 假红（本轮实测踩了两次）。锚点改用**只有 run 循环那条**才有的尾巴。
    const iQ = src.indexOf("-f $rec) -Tag 'dsh-restart'");
    if (iQ < 0) return false;
    const iStop = src.indexOf('Stop-DshChild', iQ);
    if (iStop < 0 || iStop - iQ > 500) return false;
    return /\n\s*exit 1/.test(src.slice(iStop, iStop + 120));
  })());
check('★ 重起走 exit 1（外层 .cmd 的 :restart），这条路上不出现桥接/网关端口',
  /Stop-DshChild\s*\n\s*exit 1/.test(src) && (() => {
    const iQ = src.indexOf("-f $rec) -Tag 'dsh-restart'");
    const iStop = src.indexOf('Stop-DshChild', iQ);
    if (!(iQ > 0 && iStop > iQ)) return false;
    return !/3100|3101|stop-all|start-all/.test(src.slice(iQ, iStop + 120));  // port-literal-ok: 反向断言（同上），不是配置
  })());
// 注入式验收 ①：-CheckDeathGate 全表（五态）
const gate = probeSwitch('-CheckDeathGate', {});
for (const [label, wantAct, wantPull, wantQQ] of [
  ['A 子进程还在', 'keep-running', '否', '否'],
  ['B 判死 + 有会话在跑', 'hold', '否', '否'],
  // ★ C 的 QQ 不在 Resolve-DeathAction 里（它只管"三条不拉的路"）—— 拉起那条的 QQ 由 run 循环
  //   在 `Stop-DshChild` **之前**发（tag=dsh-restart）。表必须说"是"，否则读表的人会以为"拉起了但不通知"，
  //   而主人今晚最气的恰恰就是"它被拉回来了、我一个字没收到"。
  ['C 判死 + 没会话在跑', 'auto-restart', '是', '是'],
  ['D 判死 + 开关关着', 'auto-restart', '否', '是'],
  ['E 判死 + 已到上限', 'alarm', '否', '是'],
]) {
  const ln = (gate.split('\n').find((l) => l.includes(label)) || '').trim();
  check(`  ${label} ⇒ 判定=${wantAct} / 拉=${wantPull} / 发QQ=${wantQQ}`,
    ln.includes(`判定=${wantAct}`) && ln.includes(`拉=${wantPull}`) && ln.includes(`发QQ=${wantQQ}`), ln.slice(0, 120));
}
check('★ C 格（pull）的 QQ 口径写清楚：run 循环在 Stop-DshChild 之前发、tag=dsh-restart',
  /tag=dsh-restart/.test(gate) && /Stop-DshChild/.test(gate));
check('★ 探针里 QQ 只印不真发（不打扰主人）', /\[QQ 通报\] \[只读探针\]/.test(gate));
// 注入式验收 ②：-CheckStopOnce 的"忙就不拉" + 开关关着时那条 QQ
const busyOut = probe({ ...envTmp, DSH_WINDOW_CHILD_EXITED: '1', DSH_WINDOW_DSH_ALIVE: '0', DSH_WINDOW_SESSIONS_BUSY: '1' });
check('★ 注入"有会话在跑" ⇒ 判定 hold（自动拉起那格）', actOf(busyOut) === 'hold', `实际 ${actOf(busyOut)}`);
check('  ↑ 并且如实说清"宁可不拉"', /宁可不拉/.test(busyOut));
const offExists = path.join(os.tmpdir(), `dsh-ar-off-exists-${process.pid}.txt`);
fs.writeFileSync(offExists, 'x');
const offOut = probe({ ...envTmp, DSH_WINDOW_CHILD_EXITED: '1', DSH_WINDOW_DSH_ALIVE: '0', DSH_WINDOW_AUTORESTART_OFF_FILE: offExists });
check('★ 开关关着 ⇒ 最终动作 = escalate-switch-off 且**会发一条 QQ**',
  /最终动作[：=]escalate-switch-off/.test(offOut) && /\[QQ 通报\] \[只读探针\]/.test(offOut),
  (offOut.split('\n').filter((l) => /最终动作|QQ/.test(l)).join(' ｜ ') || '(探针没打出相关行)').slice(0, 200));
try { fs.unlinkSync(offExists); } catch { /* 尽力而为 */ }

// ── ⑩ 状态行那一格（"建议归档"字段）的两条网眼：不许假读数、平时不许出字 ──────────────────────
console.log('\n⑩ 状态行那一格：armed 不许假读数 + 平时返回空');
const iFSF = src.indexOf('function Format-StepsField(');
const fsf = iFSF < 0 ? '' : src.slice(iFSF, src.indexOf('\n}', iFSF));
const rets = [...fsf.matchAll(/return\s+(.+)/g)].map((m) => m[1].trim());
const armedRet = (fsf.match(/if \(\[bool\]\$Armed\) \{ return '([^']*)' \}/) || [])[1] || '';
check('★ armed 那一格**不许**声称"已到建议归档档"（armed 与档位是两回事：步数很低也能已授权 ⇒ 那就是假读数）',
  armedRet.length > 0 && !/已到建议归档档/.test(armedRet) && !/[≥><]|\d/.test(armedRet), armedRet);
check('★ armed 判据排在步数档**前面**（排后面会被"建议归档"顶掉 ⇒ 又变成劝他按 a 了）',
  (() => { const iA = fsf.indexOf('if ([bool]$Armed)'); const iW = fsf.indexOf('$script:StepsWarnAt'); return iA > 0 && iW > iA; })());
check('★ 那一格**平时返回空**：非空返回只有两处（已授权 / 到档），最后一行是 return \'\'（小镜变异 M3：改成平时也显示精确数 ⇒ 这条必须红）',
  rets.length === 3 && rets[2] === "''" && rets[0].includes('已授权归档') && rets[1].includes('已到建议归档档'),
  rets.join(' ｜ ').slice(0, 160));
check('★ 带不带"建议归档"只看步数：轮数 / 金额一个判据都不参与',
  /\$null -ne \$Steps -and \[int\]\$Steps -ge \$script:StepsWarnAt/.test(fsf) && !/\$Turns|\$Cost/.test(fsf.slice(fsf.indexOf('$script:StepsWarnAt'))));

// ── ⑪ QQ 未登录提示（2026-09-26 主人点名「qq 我之前忘记登录了 … 要加个提示才行」）────────────
//    两头都要有网眼：**出现**（标题带 ⚠）与**消失**（标题回无 ⚠ 的基线）—— 只做出现就是新的狼来了。
console.log('\n⑪ QQ 未登录提示：出现带 ⚠ / 恢复回基线 / 不走 QQ 通道');
const qqOut = probeSwitch('-CheckQqAlert', {});
const qqOff = (qqOut.split('\n').find((l) => l.includes('QQ未登录')) || '').trim();
const qqOn = (qqOut.split('\n').find((l) => l.includes('QQ在线')) || '').trim();
const iQQF = src.indexOf('function Resolve-QqAlert(');
const qqFn = iQQF < 0 ? '' : src.slice(iQQF, src.indexOf('\n}', iQQF));
// ⚠ 取"那一行文案"要挑**对的**那条：三态之后函数里有三条 `line = '…'`（迁走 / 在线空串 / 未登录），
//   用 match(...)[1] 或"第一条非空"都会拿错 ⇒ 2026-09-26 又踩了一次假红。判据：未登录那条带 ⚠，迁走那条带「服务器」。
const qqLines = [...qqFn.matchAll(/line\s+= '([^']*)'/g)].map((m) => m[1]).filter((s) => s.length > 0);
const qqLine = qqLines.find((s) => s.includes('⚠')) || '';
const qqMovedLine = qqLines.find((s) => s.includes('服务器')) || '';
check('★ 判据①：QQ ✗ ⇒ 提示=要、标题带 ⚠（标题是"缩在任务栏里也看得见"的那条通道）',
  qqOff.includes('提示=要') && qqOff.includes('带⚠=是') && qqOff.includes('⚠QQ 未登录'), qqOff.slice(0, 120));
check('★ 判据①的另一半：QQ ✓（恢复）⇒ 标题回**无 ⚠ 的基线** `DSH-Web`',
  qqOn.includes('提示=不要') && qqOn.includes('带⚠=否') && /标题="DSH-Web"/.test(qqOn), qqOn.slice(0, 120));
check('★ 判据②：这一路**不走 QQ 通道**（QQ 没登录时 QQ 私聊根本发不出去 ⇒ 那是对着空气喊）',
  /这一路绝不能依赖 QQ 通道/.test(src) && qqFn.length > 0 && !/Send-OwnerQqNotice|Invoke-FlapRelay|qq-notify/.test(qqFn));
check('★ 恢复即撤：状态归零 + 标题写回基线（下次再掉还能再提醒一次）',
  /\$w\.qqAlert = \$false[\s\S]{0,240}\$w\.qqPopped = \$false[\s\S]{0,240}\[Console\]::Title = \$qa\.title/.test(src));
check('★ 提示态期间轮询收紧到 15 秒（否则"恢复了标题还挂着 60 秒"＝第二次假警告）',
  /\$fullMs = if \(\$w\.qqAlert\) \{ \$script:WatchIntervalMs \} else \{ \$script:WatchFullMs \}/.test(src));
check('★ 文案不编因果/耗时：写得进"约 1–2 分钟"与"按 s 登录"，写不进"因为…"',
  /1–2 分钟/.test(qqLine) && /按 s 登录/.test(qqLine) && !/因为|桥接|秒（|60 秒|30 秒/.test(qqLine), qqLine.slice(0, 140));

// ── ⑪b 第三态：QQ 已迁至服务器 / 只开 DSH（2026-09-26 搬家之后；主人要的"只开 DSH 入口"靠它）──
console.log('\n⑪b 「QQ 不在本机」：说明态 / 不补缺 / 只看 DSH 那盏灯（判据实读，不是复述源码）');
check('★ 第三态：**不报⚠**、不劝按 s、"掉线推手机"那句在（他得知道去哪看）',
  qqOut.includes('QQ已迁走') && qqOut.includes('提示=不要') && qqOut.includes('带⚠=否') &&
  /QQ 已迁至服务器/.test(qqOut) && /服务器/.test(qqMovedLine) && /推你手机|Server酱/.test(qqMovedLine) &&
  !/按 s/.test(qqMovedLine), qqMovedLine.slice(0, 150));
check('★ 判据两条开关都在：标记文件（搬家）+ 环境变量（只开 DSH 入口用它）',
  /function Test-QqNotLocal/.test(src) && /DSH_WINDOW_NO_SERVICES/.test(src) && /qq-moved-to-server/.test(src));
check('★ 开关**真读**：不挂（且**没有**标记文件）⇒ QQ 在本机；DSH_WINDOW_NO_SERVICES=1 ⇒ QQ 不在本机',
  (() => {
    // ★ 必须把标记路径注入成一个**不存在的**文件：真机上 `qq-bridge\qq-moved-to-server` 现在**是存在的**
    //   （搬家已验完，本地第二态已切）—— 不注入的话"没挂开关"那半边会读到真标记 ⇒ 假红
    //   （与 L48-50 那个 autorestart-off 开关同一个道理）。
    const NO_MARKER = path.join(SCRATCH, 'no-such-marker');
    const off = probeSwitch('-CheckQqAlert', { DSH_WINDOW_QQ_MOVED_FILE: NO_MARKER }).includes('结论=QQ 在本机');
    const on = probeSwitch('-CheckQqAlert', { DSH_WINDOW_QQ_MOVED_FILE: NO_MARKER, DSH_WINDOW_NO_SERVICES: '1' }).includes('结论=QQ 不在本机');
    return off && on;
  })());
check('★ 标记文件**真读**：指着存在的文件 ⇒ QQ 不在本机；指着不存在的文件 ⇒ QQ 在本机',
  (() => {
    const marker = path.join(SCRATCH, 'qq-moved-marker.txt');
    fs.writeFileSync(marker, 'x');
    const on = probeSwitch('-CheckQqAlert', { DSH_WINDOW_QQ_MOVED_FILE: marker }).includes('结论=QQ 不在本机');
    const gone = probeSwitch('-CheckQqAlert', { DSH_WINDOW_QQ_MOVED_FILE: path.join(SCRATCH, 'nope-file') }).includes('结论=QQ 在本机');
    fs.unlinkSync(marker);
    return on && gone;
  })());
// ★ 2026-09-26（小扳）口径订正：原来这条钉的是「不在本机 ⇒ **整段跳过补缺**」—— 那正是主人
//   「总控的灯不见了」的根因（跳过的同时把**控制面**的补缺也短路了，按 r 之后 :3101 死了没人管）。
//   新口径：QQ 那两只**不补**（不许走启动器 ⇒ 抢号），但**控制面照补**（它跟 QQ 毫无关系）。
check('★ 不在本机 ⇒ 只补控制面、**绝不走启动器**（旧写法「整段跳过」已被消灭）',
  /Resolve-MissingServices[\s\S]{0,400}QqNotLocal[\s\S]{0,700}mode = 'control-only'/.test(src) &&
  /Test-QqNotLocal[\s\S]{0,200}Resolve-MissingServices[\s\S]{0,220}-QqNotLocal \$notLocal/.test(src) &&
  !/if \(Test-QqNotLocal\) \{[\s\S]{0,240}跳过补缺/.test(src));
check('★ 不在本机 ⇒ 灯只认 DSH 那盏 + 触发器只探 3080（否则"永远在报警"+ 每 15 秒白问一次 control）',  // port-literal-ok: 文案里点名的就是 DSH 端口本身
  /\$green = if \(\$notLocalNow\) \{ \$dshLamp \} else \{ \[bool\]\$Status\.allGreen \}/.test(src) &&
  /\$cheapUp = if \(Test-QqNotLocal\) \{ Test-PortQuick \$DshPort \} else \{ Test-CheapTriggerAllUp \}/.test(src));
check('★ 红色与抢焦点照旧只给"DSH 真停"：QQ 这一格用黄字 + 一次跳出来',
  (() => {
    const i = src.indexOf('# ── QQ 未登录 / 没注入的提示');
    const j = src.indexOf('# ★ 状态变了就', i);
    if (!(i > 0 && j > i)) return false;
    const seg = src.slice(i, j);
    return !/StopColor/.test(seg) && /Invoke-WindowPop/.test(seg) && /qqPopped/.test(seg);
  })());
check('★ 一个提示期只打扰一次（qqPopped），且与 DSH 红那条路共用同一轮的一个弹窗额度',
  /\$w\.qqPopped -and -not \$poppedNow/.test(src) && /\$poppedNow = \$true/.test(src));
check('★ 已知启动窗口内 / 读不到状态时**不提示**（刚起服务那几十秒 SnowLuma 没起来是预期内的）',
  /\$qa\.alert -and -not \$starting -and \$dshOn/.test(src));

// ── ⑫ 「只开 DSH」入口（2026-09-26 主人：「弄一个只开 dsh web 页面的就行了」）───────────────
//    小舵给的判据：双击后**只有 DSH 起来**（:3080 在听）**且 :3001/:5099 没有被起**。
//    ⚠ 服务不能由测试来起（边界：跑服务要先问）⇒ 这里钉**可机器判的那几条**：入口只拼 DSH 窗口那一条
//    命令、绝不经过 start-all（那会把 SnowLuma+桥接一起起出来 ⇒ 抢号）、开关在起窗口**之前**挂上、
//    页面只开 DSH 那一页、`.cmd` 是纯 ASCII+CRLF。
console.log('\n⑫ 「只开 DSH」入口：命令里只有 DSH 窗口 / 不碰三件套 / .cmd 合规');
const ONLY = path.join(TOOLS, 'dsh-only.ps1');
const ONLY_CMD = path.join(REPO, '只开DSH.cmd');
const onlySrc = fs.existsSync(ONLY) ? fs.readFileSync(ONLY, 'utf8').replace(/^\uFEFF/, '') : '';
/** 按 -File 跑任意 .ps1，stdout 重定向到文件（不用管道 ⇒ 沙箱内也能跑） */
function runPsFile(args, env = {}) {
  const outFile = path.join(SCRATCH, `run-${++probeSeq}.txt`);
  const fd = fs.openSync(outFile, 'w');
  try {
    const r = spawnSync('powershell.exe',
      ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args],
      { env: { ...process.env, ...env }, stdio: ['ignore', fd, 'ignore'], windowsHide: true });
    if (r.error) throw r.error;
  } finally { fs.closeSync(fd); }
  return fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '');
}
const dry = (() => {
  try { return runPsFile([ONLY, '-DryRun', '-Port', '3999']); } catch (e) { return 'ERR ' + e.message; }
})();
const dryCmd = dry.split(/\r?\n/).find((l) => l.includes('cmd.exe')) || '';
check('★ 干跑（假装 DSH 没在跑）拼出的就是**只有 DSH 窗口**那一条命令',
  /dsh-window\.cmd/.test(dryCmd) && /title DSH-Web/.test(dryCmd) && /bin\.js/.test(dryCmd) &&
  /server-\d{8}-\d{6}\.out\.log/.test(dry), dryCmd.slice(0, 150));
check('★ 这条命令**绝不经过 start-all.ps1**（那会把 SnowLuma + 桥接一起起出来 ⇒ 抢号）',
  !/-File[^\n]*start-all\.ps1/.test(onlySrc) && !/-File[^\n]*start-all\.ps1/.test(dry));
check('★ 开关在**起窗口之前**挂上（子进程继承环境变量；顺序反了等于没挂）',
  (() => {
    const set = onlySrc.indexOf("$env:DSH_WINDOW_NO_SERVICES = '1'");
    // ⚠ 必须锚在"起窗口"那一条（`cmd.exe`）上：`Start-Process -FilePath` 的第一处是 Open-DshPage
    //   里的 powershell.exe，用它比大小会**永远假红**（2026-09-26 实测踩到，又是"首处匹配"这一族）。
    const spawn = onlySrc.indexOf("Start-Process -FilePath 'cmd.exe'");
    return set > 0 && spawn > 0 && set < spawn;
  })());
check('★ 页面只开 DSH 那一页（panels.ps1 open -DshOnly），且 -NoOpen 能不弹',
  /'open', '-DshOnly'/.test(onlySrc) && /\$NoOpen/.test(onlySrc));
check('★ 只开DSH.cmd 合规：纯 ASCII / 无 BOM / 全 CRLF（红线 2）',
  (() => {
    const r = spawnSync(process.execPath,
      [path.join(TOOLS, 'cmd-bytes.mjs'), ONLY_CMD],
      { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    return r.status === 0;
  })());

console.log(`\n═════ 通过 ${pass} 项，失败 ${fail} 项 ═════`);
cleanup();
if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
