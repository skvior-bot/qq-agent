// ============================================================================
// tools/test-self-check-qq-moved.mjs —— 「QQ 已迁服务器」第三态的回归网
//
// 判据（协调线 2026-09-26 放行时点名的 ④ 条 + 我按"口径只一处"补的两条）：
//   ① 三态矩阵（单元）：标记不在 + 端口没听 ⇒ **仍然 ❌**（★ 这条是本次验收核心：
//      第三态不许把"真停摆"一起吞掉）；标记在 + 没听 ⇒ ✅ 预期；
//      标记在 + **在听** ⇒ ❌（方向反过来：本机在抢号）。
//   ② 端到端（第三态开）：`DSH_SELFCHECK_QQ_MOVED_FILE` 指向**存在的**文件 ⇒
//      三个 QQ 侧端口行**全部**落进第三态；非 QQ 侧端口（DSH Web / 桥接控制台）**不许**被牵连。
//   ③ 端到端（反向对照）：覆盖位指向**不存在的**文件 ⇒ 三个端口行**一个都不许**出现
//      "已迁服务器"，且凡是"没在监听"的必须是 ❌ —— 对照成立才说明第三态是"判据"而不是"关闸"。
//   ④ 同路径棘轮：PS 侧（tools\dsh-prompt.ps1 的 Test-QqNotLocal）与本模块指向**同一个**
//      `qq-bridge\qq-moved-to-server`；且 self-check.mjs 自己**不许**再拼这个路径
//      （口径只在 tools\qq-moved.mjs 一处，散成两份就会一边改一边没改）。
//
// ★ 全程**不连网、不起服务、不碰 SnowLuma 端口**：只读源码 + 跑自检 + 拿 os.tmpdir() 的假标记。
//   跑法：node tools\test-self-check-qq-moved.mjs
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judgeQqPort, judgeTokenSync, qqMovedFile, qqMovedToServer, QQ_MOVED_REL, QQ_MOVED_FILE_DEFAULT, ROOT } from './qq-moved.mjs';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; failures.push(name); console.log('❌ ' + name + (detail ? '  ← ' + detail : '')); }
}

console.log('══ 「QQ 已迁服务器」第三态：判据 / 接线 / 反向对照 ══════════════════════\n');

const SELF = path.join(ROOT, 'tools', 'self-check.mjs');
const PS = path.join(ROOT, 'tools', 'dsh-prompt.ps1');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-moved-'));
const MARKER = path.join(DIR, 'fake-qq-moved-to-server');        // 假装"标记在"
const ABSENT = path.join(DIR, 'nope', 'fake-qq-moved-to-server'); // 假装"标记不在"
fs.writeFileSync(MARKER, 'test fixture\n', 'utf8');
const cleanup = () => { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {} };

// ── ① 三态矩阵（纯函数；不依赖本机任何端口的真实状态）────────────────────────
const U = (over) => judgeQqPort({ name: 'X', port: 1, open: false, qqSide: false, moved: false, ...over });
check('① 普通端口没在听 ⇒ ❌（判据没被动过）', U({}).ok === false && U({}).text.includes('没在监听'), U({}).text);
check('① 普通端口在听 ⇒ ✅', U({ open: true }).ok === true && U({ open: true }).text.includes('在监听'), U({ open: true }).text);
const strictClosed = U({ qqSide: true, open: false, moved: false });
check('★① 标记不在 + QQ 端口没听 ⇒ **仍然 ❌**（真停摆不许被吞）', strictClosed.ok === false && strictClosed.text.includes('没在监听'), strictClosed.text);
check('★① 标记不在 + QQ 端口在听 ⇒ ✅（本机就是 QQ 的家）', U({ qqSide: true, open: true, moved: false }).ok === true);
const movedClosed = U({ qqSide: true, open: false, moved: true });
check('① 标记在 + QQ 端口没听 ⇒ ✅ 第三态（未监听是预期）', movedClosed.ok === true && movedClosed.text.includes('已迁服务器'), movedClosed.text);
const movedOpen = U({ qqSide: true, open: true, moved: true });
check('★① 标记在 + QQ 端口**在听** ⇒ ❌ 抢号（方向反过来）', movedOpen.ok === false && movedOpen.text.includes('抢号'), movedOpen.text);
check('① 第三态**不牵连**普通端口：标记在时 DSH Web 照旧按原判据', U({ open: true, moved: true }).ok === true && !U({ open: true, moved: true }).text.includes('已迁服务器'));

// ── ①b 令牌同步那条的三态（第二处同族，走**同一份**口径）────────────────────
// 现场：DSH 每次启动生成新 token，把它同步进 config.json 是 start-all.ps1 的活；
// 「只开 DSH」入口故意不跑它 ⇒ 本地 QQ 已迁服务器时"不同步"是预期，但标记不在时它=401 真问题。
const T = (over) => judgeTokenSync({ synced: false, moved: false, sourceLabel: 'server-x.out.log', latestLabel: 'aaaaaaaa', cfgLabel: 'bbbbbbbb', ...over });
const tSync = T({ synced: true });
check('① 令牌同步 ⇒ ✅（判据没被动过，文案仍带日志文件名）', tSync.ok === true && tSync.text.includes('令牌同步') && tSync.text.includes('server-x.out.log'), tSync.text);
const tStrict = T({});
check('★① 标记不在 + 不同步 ⇒ **仍然 ❌**（401 真问题不许被吞）', tStrict.ok === false && tStrict.text.includes('令牌不同步') && tStrict.text.includes('start-all.ps1'), tStrict.text);
const tMoved = T({ moved: true });
check('① 标记在 + 不同步 ⇒ ✅ 第三态（且**说清为什么**，不是静默放过）',
  tMoved.ok === true && tMoved.text.includes('预期') && tMoved.text.includes('不是活路径') && tMoved.text.includes('只开 DSH'), tMoved.text);
check('① 标记在 + 同步 ⇒ 照旧 ✅（第三态不改变"本来就对"的读数）', T({ synced: true, moved: true }).ok === true);

// ── ② 标记读法与覆盖位（可测性的那一半）─────────────────────────────────────
check('② 覆盖位指向谁就读谁', qqMovedFile({ DSH_SELFCHECK_QQ_MOVED_FILE: ABSENT }) === path.resolve(ABSENT), qqMovedFile({ DSH_SELFCHECK_QQ_MOVED_FILE: ABSENT }));
check('② 没人设覆盖位 ⇒ 默认就是仓库里那个标记', qqMovedFile({}) === QQ_MOVED_FILE_DEFAULT && QQ_MOVED_FILE_DEFAULT.endsWith(QQ_MOVED_REL), qqMovedFile({}));
check('② 不存在的路径 ⇒ 判"不在"', qqMovedToServer({ DSH_SELFCHECK_QQ_MOVED_FILE: ABSENT }) === false);
check('② 存在的路径 ⇒ 判"在"（夹具真的被读到了）', qqMovedToServer({ DSH_SELFCHECK_QQ_MOVED_FILE: MARKER }) === true);

// ── ③ 同路径棘轮（PS 侧 / 口径只一处）───────────────────────────────────────
const psSrc = fs.readFileSync(PS, 'utf8');
check('③ PS 侧那条唯一开关还在（Test-QqNotLocal）', /function\s+Test-QqNotLocal/.test(psSrc));
check(`③ PS 侧与本模块指向同一个 ${QQ_MOVED_REL}`, psSrc.includes(QQ_MOVED_REL));
const selfSrc = fs.readFileSync(SELF, 'utf8');
check('③ self-check.mjs 引用了共享判据（import qq-moved）', /from\s+['"]\.\/qq-moved\.mjs['"]/.test(selfSrc));
// 棘轮只拦**重新派生**（`path.join(… 'qq-moved-to-server')` 之类）—— 把路径写进注释讲给人听是好事，不算违规；
// 真要拦的是"第二处口径"：两处拼路径 ⇒ 迟早一边改一边没改，而失效方式恰好是"静默变绿"。
check('③ self-check.mjs **不再自己派生**那个路径（口径只一处）',
  !/path\.join\([^)]*qq-moved-to-server/.test(selfSrc) && !/QQ_MOVED_FILE_DEFAULT\s*=/.test(selfSrc));

// ── ④⑤ 端到端：真跑自检两次（一次第三态开、一次反向对照）────────────────────
/** 跑自检：**文件重定向**而不是管道（受限沙箱里 spawn + pipe 会 EPERM；见 tools\daily-check.mjs L99-113） */
function runSelfCheck(markerPath) {
  const out = path.join(DIR, `sc-${Math.random().toString(36).slice(2, 8)}.log`);
  const fd = fs.openSync(out, 'w');
  let r;
  try {
    r = spawnSync(process.execPath, [SELF], {
      stdio: ['ignore', fd, fd], timeout: 180000, cwd: ROOT,
      env: { ...process.env, DSH_SELFCHECK_QQ_MOVED_FILE: markerPath },
    });
  } finally { try { fs.closeSync(fd); } catch {} }
  let text = '';
  try { text = fs.readFileSync(out, 'utf8'); } catch {}
  try { fs.unlinkSync(out); } catch {}
  return { text, error: r?.error };
}
const QQ_PORTS = ['SnowLuma WS', 'OneBot HTTP', 'SnowLuma 管理页'];
const OTHER_PORTS = ['DSH Web', '桥接控制台'];
/** 取某个端口那一行（含 ✅/❌ 前缀）；没这行返回 '' */
const lineFor = (text, name) => text.split('\n').map((l) => l.trim()).find((l) => new RegExp(`^[✅❌]\\s+${name} :\\d+`).test(l)) ?? '';
/** 取"令牌"那一行（✅/❌ 前缀）；没这行返回 '' */
const tokenLine = (text) => text.split('\n').map((l) => l.trim()).find((l) => /^[✅❌]\s+令牌(同步|不同步)/.test(l)) ?? '';

const onEff = runSelfCheck(MARKER);
check('④ 自检真的跑起来了（不是 spawn EPERM）', !onEff.error && onEff.text.length > 100, onEff.error?.message ?? `输出 ${onEff.text.length} 字符`);
const onLines = QQ_PORTS.map((n) => lineFor(onEff.text, n));
check('④ 三个 QQ 端口都被判了（正控：行确实存在）', onLines.every(Boolean), JSON.stringify(onLines));
check('④ 标记在 ⇒ 三个 QQ 端口**全部**落进第三态', onLines.every((l) => l.includes('已迁服务器')), JSON.stringify(onLines));
check('④ 第三态下不再出现"没在监听"的红', onLines.every((l) => !(l.startsWith('❌') && l.includes('没在监听'))), JSON.stringify(onLines));
check('④ 非 QQ 端口**不受牵连**（DSH Web / 桥接控制台照旧）', OTHER_PORTS.map((n) => lineFor(onEff.text, n)).every((l) => l && !l.includes('已迁服务器')),
  JSON.stringify(OTHER_PORTS.map((n) => lineFor(onEff.text, n))));
const onTok = tokenLine(onEff.text);
check('④ 正控：令牌那一行确实被打了（"只开 DSH"那条线的接缝）', Boolean(onTok), JSON.stringify(onEff.text.split('\n').filter((l) => l.includes('令牌')).slice(0, 3)));
check('④ 标记在 ⇒ 令牌那条**不许报 ❌**（不同步也算预期）', Boolean(onTok) && !onTok.startsWith('❌'), onTok);
check('④ 标记在 + 不同步 ⇒ 文案点明"预期"（不是静默放过）', !onTok.includes('令牌不同步') || onTok.includes('预期'), onTok);

const offEff = runSelfCheck(ABSENT);
check('⑤ 反向对照那次自检也跑起来了', !offEff.error && offEff.text.length > 100, offEff.error?.message ?? '');
const offLines = QQ_PORTS.map((n) => lineFor(offEff.text, n));
check('⑤ 反向对照：一个端口都不许出现"已迁服务器"', offLines.every((l) => l && !l.includes('已迁服务器')), JSON.stringify(offLines));
const strict = offLines.every((l) => !l.includes('没在监听') || l.startsWith('❌'));
check('★⑤ 反向对照：凡是"没在监听"的**必须是 ❌**（真停摆照样红）', strict, JSON.stringify(offLines));
const offTok = tokenLine(offEff.text);
check('★⑤ 反向对照：标记不在 + 令牌不同步 ⇒ **必须 ❌**（401 真问题照样红）',
  !offTok.includes('令牌不同步') || offTok.startsWith('❌'), offTok);
check('⑤ 反向对照：令牌那条不许出现第三态文案（"已迁服务器"）', !offTok.includes('已迁服务器'), offTok);
const closedCount = offLines.filter((l) => l.includes('没在监听')).length;
console.log(closedCount === QQ_PORTS.length
  ? '\nℹ️  本次观察：本机三个 QQ 端口都关着 ⇒ 反向对照当场拿到 **❌×3**（最强证据）。'
  : `\nℹ️  本次观察：本机有 ${QQ_PORTS.length - closedCount} 个 QQ 端口正开着（有人把本地 QQ 起起来了？）⇒ "❌×3"这一条本次没拿到，但矩阵与"不许出现已迁服务器"两条仍然钉住了判据。`);
console.log(offTok.includes('令牌不同步')
  ? 'ℹ️  令牌那条：反向对照当场拿到 **❌**（本机此刻确实不同步 ⇒ 真红被保住）。'
  : 'ℹ️  令牌那条：本机此刻是同步的（走的是 start-all）⇒ 反向对照只钉住"不许出现第三态文案"。');

cleanup();
console.log(`\n═════ 通过 ${pass} 项，失败 ${fail} 项 ═════`);
if (fail) console.log('失败项：' + failures.join('；'));
process.exit(fail ? 1 : 0);
