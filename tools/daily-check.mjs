#!/usr/bin/env node
// 定期自检 + 告警：跑 tools/self-check.mjs，只在**发现问题**时通过 QQ 推给 owner。
//
// 为什么需要它：自检脚本本身很强（运行时 / 启动链 / preset / 结构不变量 / 日志健康），
// 但它**没人跑就没人知道** —— 工作区状态会一直停留在"上次人工检查时"的样子。
// 典型场景：令牌不同步（QQ 全线 401）、某个 MCP 入口文件被挪走、state\ 里堆了测试残留、
// 结构快照过期…… 这些都不影响"当下能不能跑"，所以不会有人主动去查。
//
// 用法：
//   node tools\daily-check.mjs            # 跑一次；有问题才推 QQ，没问题静默
//   node tools\daily-check.mjs --always   # 无论有没有问题都推一条摘要
//   node tools\daily-check.mjs --print    # 只打印，不推 QQ（调试用）
//
// 每次运行**都会**往 backups\reports\daily-check.log 追加一行（不依赖 QQ、不依赖桥接）——
// 计划任务在后台跑，只 console.log 等于零留痕，"它到底跑没跑"没人答得上来（2026-09-23 实测：
// 从会话里连任务是否存在都查不到）。
//
// 注册成每天 09:00 的计划任务（**用户级即可，不需要管理员**；用 schtasks 会先被沙箱拒，
// 让人误判成"要管理员"——完整命令见 docs\HANDOFF.md 的命令速查）：
//   $a = New-ScheduledTaskAction -Execute (Get-Command node).Source -Argument "D:\hobby\DSH\tools\daily-check.mjs" -WorkingDirectory "D:\hobby\DSH"
//   $t = New-ScheduledTaskTrigger -Daily -At 09:00
//   Register-ScheduledTask -TaskName "DSH-daily-check" -Action $a -Trigger $t -Force
// 删除：Unregister-ScheduledTask -TaskName "DSH-daily-check" -Confirm:$false
//
// ⚠️ 告警链是**自指**的：推 QQ 要经过桥接（:3100）—— 而"桥接挂了"正是最该报警的情况之一，
// 那时推送必然失败。所以落盘先行、推送只是锦上添花；推送失败还会另写一份 ALERT.txt。
//
// ⚠️ 在 DSH 会话的沙箱里直接跑它可能失败（spawnSync + 管道捕获会撞 EPERM，
//    与 scripts\test-setup-dsh-idempotent.mjs 是同一类限制）；计划任务在沙箱外，不受影响。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const ALWAYS = argv.includes('--always');
const PRINT_ONLY = argv.includes('--print');

function readOwnerQQ() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'qq-bridge', 'config.json'), 'utf8').replace(/^\uFEFF/, '');
    return String(JSON.parse(raw).ownerQQ || '').trim();
  } catch { return ''; }
}

// ── 报告落盘（不依赖 QQ / 桥接的那条通道）────────────────────────────────────
const reportDir = path.join(ROOT, 'backups', 'reports');
const reportFile = path.join(reportDir, 'daily-check.log');
const alertFile = path.join(reportDir, 'ALERT.txt');
function writeReport(line) {
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    fs.appendFileSync(reportFile, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    const lines = fs.readFileSync(reportFile, 'utf8').split('\n');
    if (lines.length > 400) fs.writeFileSync(reportFile, lines.slice(-200).join('\n'), 'utf8');
  } catch (error) {
    console.error(`[daily-check] 报告落盘失败：${error.message}`);
  }
}
/** 推送失败时留下的"喊不出来"的证据：下次谁打开工作区都能看到。 */
function writeAlert(text) {
  try {
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(alertFile, `[${new Date().toISOString()}] ${text}\n`, 'utf8');
  } catch {}
}
function clearAlert() {
  try { fs.unlinkSync(alertFile); } catch {}
}

// ── 睡眠/冻结审计（2026-09-25 立；协调线 `a198e601` 15:0x 批准）：**只进留痕行** ──────────
// 为什么挂在这里：在线告警（`socialV2.gatewayWatch.alertOwner` 的断线提醒）只盖得住「**进程还在跑**、
//   只是上游/网关不通」那一类；**机器睡眠 / 整机冻结**那一类要靠**事后审计**（睡眠期间 tick 根本不跑，
//   醒后第一拍探针直接成功 ⇒ 不进 degraded、不发提醒），而 `daily-check` 是唯一每天必跑一次的入口。
// 口径（协调线拍板）：**只写 backups\reports\daily-check.log 的留痕行 + 打屏**，
//   **不参与 `bad`、不新增 QQ 推送**（同一个事实已经有断线提醒那条通道，报两遍就是噪音）。
// 工具本身只读：读 Windows 电源事件 + SnowLuma 日志缺口，不写 state、不发 QQ。
function runStallAudit() {
  const tool = path.join(ROOT, 'tools', 'stall-audit.mjs');
  if (!fs.existsSync(tool)) return '[stall-audit] （没找到 tools\\stall-audit.mjs，跳过）';
  const of = path.join(tmpDir, `stall-audit-${Date.now()}.log`);
  let r;
  try {
    const f = fs.openSync(of, 'w');
    try { r = spawnSync(process.execPath, [tool, '--line'], { stdio: ['ignore', f, 'ignore'], timeout: 150000, cwd: ROOT }); }
    finally { try { fs.closeSync(f); } catch {} }
  } catch (error) {
    return `[stall-audit] （跑不起来：${error.message}）`;
  }
  let out = '';
  try { out = fs.readFileSync(of, 'utf8'); } catch {}
  try { fs.unlinkSync(of); } catch {}
  const line = out.split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
  if (line) return line;
  return `[stall-audit] （审计器没有输出；退出码 ${r?.status ?? '?'}${r?.error ? `：${r.error.message}` : ''}）`;
}

// 跑自检并抓输出。self-check 是脚本（顶层执行），只能用子进程跑。
// 这里刻意用**文件重定向**而不是管道：受限沙箱里 Node 的 spawn + `stdio:'pipe'` 会撞
// EPERM（`inherit`/`ignore` 与文件 fd 都可以），换成文件后脚本在沙箱内外都能跑 ——
// 于是它自己也能被验证，而不是"只能在计划任务里跑、没人验过"。
const selfCheck = path.join(ROOT, 'tools', 'self-check.mjs');
const tmpDir = path.join(ROOT, 'qq-bridge', 'state', '_tmp');
fs.mkdirSync(tmpDir, { recursive: true });
const outFile = path.join(tmpDir, `daily-check-${Date.now()}.log`);
const fd = fs.openSync(outFile, 'w');
let run;
try {
  run = spawnSync(process.execPath, [selfCheck], { stdio: ['ignore', fd, fd], timeout: 180000, cwd: ROOT });
} finally {
  try { fs.closeSync(fd); } catch {}
}
let out = '';
try { out = fs.readFileSync(outFile, 'utf8'); } catch {}
try { fs.unlinkSync(outFile); } catch {}
if (run.error) {
  const msg = `无法运行自检：${run.error.message}（若在 DSH 会话沙箱里跑，这是已知的 EPERM 限制；计划任务在沙箱外不受影响）`;
  console.error(`[daily-check] ${msg}`);
  writeReport(`ERROR ${msg}`);
  writeAlert(`daily-check 没跑起来：${msg}`);
  // 这里用 exit 而不是 exitCode：此时除了刚失败的子进程没有别的句柄，早退更省事。
  process.exit(2);
}
// 解析 "自检结果：N 个失败，M 个警告"
const m = /自检结果：(\d+) 个失败，(\d+) 个警告/.exec(out);
const fails = m ? Number(m[1]) : NaN;
const warns = m ? Number(m[2]) : NaN;
const parseOk = Number.isFinite(fails) && Number.isFinite(warns);
const bad = !parseOk || fails > 0 || warns > 0;

// 摘出所有 ❌ / ⚠️ 行（自检里失败与警告的标记），最多 12 行，方便一眼看问题
const problems = out.split('\n')
  .map((l) => l.trim())
  .filter((l) => /^(❌|⚠️)/.test(l))
  .slice(0, 12);

const stamp = new Date().toLocaleString('zh-CN');
let summary;
if (!parseOk) {
  summary = `⚠️ DSH 自检没跑出结果（退出码 ${run.status ?? '?'}）—— 可能是脚本报错或超时。`;
} else if (bad) {
  summary = `⚠️ DSH 自检发现问题：${fails} 个失败、${warns} 个警告（${stamp}）\n${problems.join('\n')}`;
} else {
  summary = `✅ DSH 自检通过：0 失败 0 警告（${stamp}）`;
}

// 两个分支原来打印的是同一句话（PRINT_ONLY || !bad 与 else 内容一致），合并掉。
console.log(`[daily-check] ${summary}`);
// 每次运行都留痕（首行是单行摘要，方便 grep 历史）
writeReport(summary.split('\n').join(' / '));

// 睡眠/冻结审计：只留痕 + 打屏（不参与 bad、不进 summary ⇒ 不新增推送；见 runStallAudit 的注释）
const auditLine = runStallAudit();
console.log(`[daily-check] ${auditLine}`);
writeReport(auditLine);

if (PRINT_ONLY) process.exit(bad ? 1 : 0);

if (bad || ALWAYS) {
  const owner = readOwnerQQ();
  if (!owner) {
    const why = 'config.json 里没有 ownerQQ，无法推送告警。';
    console.error(`[daily-check] ${why}`);
    writeReport(`ALERT 推送失败：${why}`);
    writeAlert(why);
    process.exit(1);
  }
  // 复用 ops.mjs notify（它处理 UTF-8 与桥接鉴权），比自己拼 HTTP 稳。
  const notify = spawnSync(process.execPath, [
    path.join(ROOT, 'tools', 'ops.mjs'), 'notify', `private:${owner}`, summary
  ], { encoding: 'utf8', timeout: 60000, cwd: ROOT });
  if (notify.status === 0) {
    console.log(`[daily-check] 已把摘要推给 owner（private:${owner}）`);
    writeReport(`推送成功 → private:${owner}`);
    clearAlert();
  } else {
    // 推送要经过桥接 :3100 —— 桥接挂了正是最该报警的情况，所以这里必须留下"喊不出来"的证据。
    const detail = (notify.stderr || notify.stdout || '').trim().slice(0, 300);
    console.error(`[daily-check] 推送失败：${detail}`);
    writeReport(`ALERT 推送失败（QQ 通道不可用）：${detail}`);
    writeAlert(`自检发现问题但推不出去（QQ/桥接通道不可用）：${detail}\n摘要：${summary}`);
  }
} else {
  clearAlert();
}

// 用 exitCode 而不是 exit()：前面可能已经建立了 keep-alive socket，
// Windows + Node 26 下抢着 exit 会撞 libuv 断言（0xC0000409）崩掉。
process.exitCode = bad ? 1 : 0;
