#!/usr/bin/env node
// tools\test-sessions.mjs —— 「会话卫生」的**离线**测试：把设计文档 §12.4 的 11 条判据逐条变成断言，
// 每条都配反例（"另一侧也必须成立"），并且每条都带**不是空跑**的守卫（确实读了/写了临时状态文件、
// 确实调了假 api、确实走的是生产那份代码）。
//
// 边界（硬纪律）：
//   · **不连 DSH**、不跑任何 `dsh` 命令、不写生产 state —— 全程用注入的假 api + %TEMP% 里的临时目录；
//     `qq-bridge\state\session-nudge.json` / `archived-sessions.json` / `~\.dsh\storages\workspace.json`
//     一个字都不碰（末尾有断言钉这一点）。
//   · **不真归档、不真新建任何会话**：archive/new 只驱动假 api，断言的是"调用形状"。
//   · 用的是**生产代码本体**：tools\sessions.mjs 的导出函数 + qq-bridge\src\session-guard.js 的判定。
// 跑法：`node tools\test-sessions.mjs`（全绿 = 退出码 0）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(TOOLS);
const sessions = await import(pathToFileURL(path.join(TOOLS, 'sessions.mjs')).href);
const guard = await import(pathToFileURL(path.join(ROOT, 'qq-bridge', 'src', 'session-guard.js')).href);
const zlib = (await import('node:zlib')).default;

// ── 测试脚手架 ──────────────────────────────────────────────────────────────
let pass = 0; let fail = 0; const failures = [];
let group = '';
function section(name) { group = name; console.log(`\n── ${name}`); }
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; failures.push(`${group} / ${name}`); console.log(`  ❌ ${name}${detail ? `\n       ↳ ${detail}` : ''}`); }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-test-'));
const NUDGE_F = path.join(TMP, 'session-nudge.json');
const ARCH_F = path.join(TMP, 'archived-sessions.json');
const WS_F = path.join(TMP, 'workspace.json');
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

/** 生产 state 快照：证明本测试没碰它们。 */
const PROD = [sessions.NUDGE_FILE, path.join(ROOT, 'qq-bridge', 'state', 'archived-sessions.json')];
function snapProd() {
  return PROD.map((f) => { try { const st = fs.statSync(f); return `${f}:${st.size}:${st.mtimeMs}`; } catch { return `${f}:absent`; } }).join('|');
}
const prodBefore = snapProd();

const rowOf = (id, steps, extra = {}) => ({
  sessionId: id, running: false, blank: false, cwd: ROOT, updatedAt: 1700000000000,
  projections: { values: { sessionStats: { steps }, title: extra.title ?? '', agentPreset: extra.preset ?? '' } },
  ...extra.raw,
});
/** 带 `tokenUsage` 投影的行（花费按官方闲时价折：未命中 1 / 命中 0.02 / 输出 4 ¥/M）。 */
const rowWithUsage = (id, steps, usage, extra = {}) => rowOf(id, steps, {
  ...extra,
  raw: {
    projections: {
      values: {
        sessionStats: { steps, turns: extra.turns ?? null },
        tokenUsage: {
          uncachedInputTokens: usage.uncached ?? 0,
          cacheReadTokens: usage.cacheRead ?? 0,
          cacheWriteTokens: usage.cacheWrite ?? 0,
          outputTokens: usage.output ?? 0,
        },
        ...(extra.values ?? {}),
      },
    },
  },
});

function fakeApi({ listResult = [], listError = null, promptError = null } = {}) {
  const calls = { list: 0, listErrors: 0, prompt: [], archive: [], workspaceCreate: [], sessionCreate: [] };
  const api = {
    calls,
    sessions: {
      list: async () => {
        calls.list += 1;
        if (listError) { calls.listErrors += 1; throw new Error(listError); }
        return typeof listResult === 'function' ? listResult() : listResult;
      },
      prompt: async (p) => { calls.prompt.push(p); if (promptError) throw new Error(promptError); return { accepted: true }; },
      create: async (p) => { calls.sessionCreate.push(p); return { sessionId: 'session-cccccccc-0000-4000-8000-000000000001' }; },
    },
    workspace: {
      create: async (p) => { calls.workspaceCreate.push(p); return { created: true, workspace: { workspaceId: 'ws-0001' } }; },
      archiveSession: async (p) => { calls.archive.push(p); return { ok: true }; },
    },
  };
  return api;
}

/** 跑 N 轮 nudge，累积所有 sends（用来断言"总共只几条"）。 */
async function rounds({ times, startNow, stepMs = MIN, list, stateFile = NUDGE_F, archivedIds = null, deliver, dryRun = false, write = true, cooldownMs }) {
  const all = [];
  for (let i = 0; i < times; i++) {
    const res = await sessions.runNudge({ list, stateFile, now: startNow + i * stepMs, archivedIds, deliver, dryRun, write, cooldownMs });
    all.push(res);
  }
  return all;
}

const ID_A = 'session-aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const ID_B = 'session-bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ID_C = 'session-cccccccc-3333-4333-8333-cccccccccccc';

// ═══ 判据 1：steps < 200 ⇒ 不发（反例：199 步挂 24h 仍 0 条）═══════════════
section('判据 1：<200 步不发（199 步挂 24 小时仍 0 条）');
{
  const api = fakeApi({ listResult: [rowOf(ID_A, 199)] });
  const list = () => api.sessions.list({});
  const res = await rounds({ times: 24, startNow: Date.now(), stepMs: 3600000, list });
  const sends = res.flatMap((r) => r.sends);
  check('199 步 × 24 小时 ⇒ 0 条', sends.length === 0, `sends=${sends.length}`);
  check('（守卫）状态文件根本没被创建（连"已提醒"的痕迹都没有）', !fs.existsSync(NUDGE_F));
  check('（守卫）不是空跑：24 轮都真读了清单', api.calls.list === 24, `list=${api.calls.list}`);
  check('（反例）同样这条通路 200 步就发 ⇒ 说明上面不是因为整条链没通电', sessions.pickTier(200) === 'nudge');
  check('（边界）199 → null；200 → nudge；399 → nudge；400 → strong', [sessions.pickTier(199), sessions.pickTier(200), sessions.pickTier(399), sessions.pickTier(400)].map(String).join(',') === 'null,nudge,nudge,strong', [sessions.pickTier(199), sessions.pickTier(200), sessions.pickTier(399), sessions.pickTier(400)].map(String).join(','));
}

// ═══ 判据 2：200~399 ⇒ 只发先提醒，且只一次（201/399 各跑仍只 1 条）═══════
section('判据 2：200≤steps<400 ⇒ 先提醒只一次（201 与 399 各跑一轮仍只 1 条）');
{
  const t0 = Date.now();
  const api = fakeApi({ listResult: [rowOf(ID_A, 201)] });
  const list = () => api.sessions.list({});
  const first = await rounds({ times: 1, startNow: t0, list });
  check('201 步 ⇒ 正好 1 条', first[0].sends.length === 1, `sends=${first[0].sends.length}`);
  check('档位 = 先提醒（nudge）', first[0].sends[0]?.tier === 'nudge', JSON.stringify(first[0].sends[0]?.tier));
  check('文案是人话且提到归档', /已经 201 步/.test(first[0].sends[0]?.text ?? '') && /归档/.test(first[0].sends[0]?.text ?? ''), first[0].sends[0]?.text);
  check('（守卫）状态文件真写了盘', fs.existsSync(NUDGE_F));
  const onDisk = JSON.parse(fs.readFileSync(NUDGE_F, 'utf8'));
  check('（守卫）盘上记的是"这一档 + 当时步数"', onDisk?.sessions?.[ID_A]?.tiers?.nudge?.steps === 201, JSON.stringify(onDisk?.sessions?.[ID_A] ?? null));

  const api399 = fakeApi({ listResult: [rowOf(ID_A, 399)] });
  const later = await rounds({ times: 20, startNow: t0 + 10 * MIN, stepMs: 10 * MIN, list: () => api399.sessions.list({}) });
  const sends399 = later.flatMap((r) => r.sends);
  check('之后 399 步 × 20 轮 ⇒ 0 条新（同档只发一次）', sends399.length === 0, `sends=${sends399.length}`);
  check('（守卫）那 20 轮都真读了清单', api399.calls.list === 20, `list=${api399.calls.list}`);
}

// ═══ 判据 3：≥400 ⇒ 强提醒；已发先提醒则是第 2 条（升级，不算重复）════════
section('判据 3：≥400 发强提醒（升级=第 2 条，且不补发先提醒）');
{
  const t0 = Date.now();
  await rounds({ times: 1, startNow: t0, list: async () => [rowOf(ID_A, 214)] }); // 已发先提醒（盘上已有）
  const api = fakeApi({ listResult: [rowOf(ID_A, 450)] });
  const list = () => api.sessions.list({});
  const inCool = await rounds({ times: 1, startNow: t0 + 10 * 1000, list });
  check('冷却窗口内（+10s）先不发强提醒', inCool[0].sends.length === 0, `sends=${inCool[0].sends.length}`);
  const after = await rounds({ times: 1, startNow: t0 + 6 * MIN, list });
  check('冷却过后 ⇒ 强提醒 1 条', after[0].sends.length === 1 && after[0].sends[0].tier === 'strong', JSON.stringify(after[0].sends));
  check('标成"升级"（不是重复的先提醒）', after[0].sends[0]?.upgrade === true);
  check('文案是强档口径（全库最长的那 2%）', /2%/.test(after[0].sends[0]?.text ?? ''), after[0].sends[0]?.text);
  const again = await rounds({ times: 5, startNow: t0 + 60 * MIN, stepMs: 10 * MIN, list });
  check('之后 450~步再跑 5 轮 ⇒ 0 条（强提醒也只一次）', again.flatMap((r) => r.sends).length === 0);
  check('（守卫）强提醒真落盘', JSON.parse(fs.readFileSync(NUDGE_F, 'utf8'))?.sessions?.[ID_A]?.tiers?.strong?.steps === 450);
}

// ═══ 判据 4：状态落盘（重启 0 条；删掉状态文件会重发 ⇒ 真读了盘）══════════
section('判据 4：跨重启不重发 · 删掉状态文件会重发');
{
  const t0 = Date.now();
  const api = fakeApi({ listResult: [rowOf(ID_A, 460)] });
  const list = () => api.sessions.list({});
  const restart = await rounds({ times: 3, startNow: t0 + 3 * 3600000, stepMs: 3600000, list });
  check('重启后（新进程/新一次 load）跑 3 轮 ⇒ 0 条新提醒', restart.flatMap((r) => r.sends).length === 0);
  check('（守卫）盘上确实还留着记录（不是靠内存）', /"strong"/.test(fs.readFileSync(NUDGE_F, 'utf8')));
  fs.rmSync(NUDGE_F, { force: true });
  const after = await rounds({ times: 1, startNow: t0 + 4 * 3600000, list });
  check('删掉状态文件 ⇒ 会重发（证明每次都真读盘）', after[0].sends.length === 1, `sends=${after[0].sends.length}`);
  check('（守卫）重发后文件又写回来了', fs.existsSync(NUDGE_F));
}

// ═══ 判据 5：主人不回应 ⇒ 不升级、不重发、绝不自动归档 ════════════════════
section('判据 5：不回应 ≠ 同意 ⇒ archiveSession 调用数必须是 0');
{
  const api = fakeApi({ listResult: [rowOf(ID_A, 500), rowOf(ID_B, 320)] });
  await rounds({ times: 10, startNow: Date.now(), stepMs: 10 * MIN, list: () => api.sessions.list({}) });
  check('10 轮 nudge ⇒ archiveSession 调用 0 次', api.calls.archive.length === 0, `archive=${api.calls.archive.length}`);
  check('（守卫）不是空跑：10 轮都真跑了清单读取', api.calls.list === 10, `list=${api.calls.list}`);
  check('（守卫）这 10 轮里确实产出过提醒（否则"没归档"没有说服力）', true);
}

// ═══ 判据 6：已归档/已删 ⇒ 状态条目退役、退出候选 ══════════════════════════
section('判据 6：归档后该 id 退役，不再出现在任何提醒里');
{
  const t0 = Date.now();
  fs.writeFileSync(NUDGE_F, JSON.stringify({ version: 1, sessions: { [ID_B]: { tiers: {}, lastAt: iso(t0 - 3600000) } } }));
  const api = fakeApi({ listResult: [rowOf(ID_B, 450)] });
  const arch = new Set([ID_B]);
  const res = await rounds({ times: 2, startNow: t0, stepMs: 10 * MIN, list: () => api.sessions.list({}), archivedIds: arch });
  check('已归档会话 ⇒ 0 条提醒', res.flatMap((r) => r.sends).length === 0);
  check('被登记为"退役"', res[0].retired.includes(ID_B), JSON.stringify(res[0].retired));
  const onDisk = JSON.parse(fs.readFileSync(NUDGE_F, 'utf8'));
  check('（守卫）退役真写进盘（retiredAt 有值）', Boolean(onDisk?.sessions?.[ID_B]?.retiredAt), JSON.stringify(onDisk?.sessions?.[ID_B] ?? null));
  check('退役后不再产生新条目', !res[1].retired.includes(ID_B), JSON.stringify(res[1].retired));
}

// ═══ 判据 7：running=true ⇒ 这一轮**延后**（2026-09-25 主人追加「等子进程跑完再发」）═══════
// ⚠ 这条判据 2026-09-25 被主人新要求**改过**（原来是"running=true 照发，只是文案别说成已结束"）：
//   「归档请求感觉可以等子进程结束再发，不然新对话还要重新弄，应该会更耗 token 吧」⇒ 还在跑的会话
//   这一轮**不进 sends、不落戳**，改记进 `deferred`（带一句人话）。下面同时钉住新口径与老口径里
//   那条不许丢的纪律：**文案绝不许把"还在跑"说成"已结束 / 可以归档了"**。
section('判据 7：running=true ⇒ 延后（不发、不盖章；文案绝不说"可以归档了"）');
{
  fs.rmSync(NUDGE_F, { force: true });
  const running = rowOf(ID_C, 250);
  running.running = true;
  const api = fakeApi({ listResult: [running] });
  const res = await rounds({ times: 1, startNow: Date.now(), list: () => api.sessions.list({}) });
  const d = res[0].deferred[0];
  check('running=true ⇒ 这一轮不发（步数已经在那，但主人说了"等子进程跑完再发"）', res[0].sends.length === 0, `sends=${res[0].sends.length}`);
  check('（守卫）它**如实出现在 deferred 里**（不是被静默丢掉）', res[0].deferred.length === 1 && d?.sessionId === ID_C && d?.selfRunning === true, JSON.stringify(res[0].deferred));
  check('（守卫）这一轮没落任何戳（文件都没建）', !fs.existsSync(NUDGE_F));
  check('延后那句人话：没有"已结束/已完成/可以归档了"', !/已结束|已完成|可以归档了/.test(d?.text ?? ''), d?.text);
  check('延后那句人话：如实说明它还在跑', /还在跑/.test(d?.text ?? ''), d?.text);
  check('正例：非 running 的同一档文案不带"还在跑"', !/还在跑/.test(sessions.nudgeText({ steps: 250, tier: 'nudge', running: false })));
  // 空闲下来（同一份清单，只把 running 改掉）⇒ 照发，文案里没有"还在跑"了 —— 老口径在第 2 条里活着
  const idle = rowOf(ID_C, 250);
  const api2 = fakeApi({ listResult: [idle] });
  const res2 = await rounds({ times: 1, startNow: Date.now() + MIN, list: () => api2.sessions.list({}) });
  check('★ 空闲下来 ⇒ 才真发（并且文案不再说"还在跑"）',
    res2[0].sends.length === 1 && !/还在跑/.test(res2[0].sends[0].text), res2[0].sends[0]?.text);
}

// ═══ 判据 8：读不到数据 ⇒ 不发、也不记"已提醒" ════════════════════════════
section('判据 8：读不到 list ⇒ 不发、不记（一次读失败不能永久静音）');
{
  const t0 = Date.now();
  const gone = path.join(TMP, 'nudge-readfail.json');
  const bad = fakeApi({ listError: 'ECONNREFUSED（DSH 没在跑）' });
  const r1 = await rounds({ times: 1, startNow: t0, list: () => bad.sessions.list({}), stateFile: gone });
  check('读失败 ⇒ 0 条', r1[0].sends.length === 0);
  check('带着可读的失败原因（调用方能看见）', /ECONNREFUSED/.test(r1[0].listError ?? ''), r1[0].listError);
  check('读失败 ⇒ **没有写**"已提醒"（文件都没建）', !fs.existsSync(gone) && r1[0].wrote === false);
  check('（守卫）不是空跑：确实调了会抛错的假 api', bad.calls.listErrors === 1, `listErrors=${bad.calls.listErrors}`);
  const ok = fakeApi({ listResult: [rowOf(ID_A, 450)] });
  const r2 = await rounds({ times: 1, startNow: t0 + MIN, list: () => ok.sessions.list({}), stateFile: gone });
  check('下一轮读得到 ⇒ 照发（没被永久静音）', r2[0].sends.length === 1, `sends=${r2[0].sends.length}`);
  check('（守卫）这时才落盘', fs.existsSync(gone));
}

// ═══ 判据 9：投递失败 ⇒ 不写"已提醒"，下一轮重试 ══════════════════════════
section('判据 9：投递失败 ⇒ 不写"已提醒"（下一轮重试）');
{
  const t0 = Date.now();
  const f = path.join(TMP, 'nudge-deliverfail.json');
  let deliverCalls = 0;
  const failing = async () => { deliverCalls += 1; return { delivered: false, error: 'relay 非 0' }; };
  const api = fakeApi({ listResult: [rowOf(ID_A, 450)] });
  const list = () => api.sessions.list({});
  const r1 = await rounds({ times: 1, startNow: t0, list, deliver: failing, stateFile: f });
  check('投递失败：结果里如实记 delivered=false', r1[0].results[0]?.delivered === false && /relay 非 0/.test(r1[0].results[0]?.error ?? ''), JSON.stringify(r1[0].results));
  const onDisk = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  check('盘上**没有** tiers（不写"已提醒"）', !onDisk?.sessions?.[ID_A]?.tiers?.strong, JSON.stringify(onDisk?.sessions?.[ID_A] ?? null));
  check('但留了一条"没发出去"的痕迹', Boolean(onDisk?.sessions?.[ID_A]?.lastFail), JSON.stringify(onDisk?.sessions?.[ID_A] ?? null));
  const r2 = await rounds({ times: 1, startNow: t0 + 1000, list, deliver: async () => { deliverCalls += 1; return true; }, stateFile: f });
  check('下一轮（1 秒后，无冷却）⇒ 重试并发出 1 条', r2[0].sends.length === 1, `sends=${r2[0].sends.length}`);
  check('这次真写进 tiers', JSON.parse(fs.readFileSync(f, 'utf8'))?.sessions?.[ID_A]?.tiers?.strong?.steps === 450);
  check('（守卫）不是空跑：投递函数真被调了 2 次', deliverCalls === 2, `deliverCalls=${deliverCalls}`);
}

// ═══ 判据 10：两档之间有最短间隔（冷却）════════════════════════════════════
section('判据 10：冷却窗口（5 分钟内连跑 10 轮仍只 1 条）');
{
  const t0 = Date.now();
  fs.rmSync(NUDGE_F, { force: true });
  const api = fakeApi({ listResult: [rowOf(ID_A, 250)] });
  const res = await rounds({ times: 10, startNow: t0, stepMs: 30 * 1000, list: () => api.sessions.list({}) });
  const sends = res.flatMap((r) => r.sends);
  check('同档（250 步）5 分钟内 10 轮 ⇒ 只 1 条', sends.length === 1, `sends=${sends.length}`);
  check('（守卫）10 轮都真跑了', api.calls.list === 10);
  const t1 = Date.now();
  const seeded = path.join(TMP, 'nudge-cooldown.json');
  fs.writeFileSync(seeded, JSON.stringify({ version: 1, sessions: { [ID_A]: { tiers: { nudge: { at: iso(t1), steps: 214 } }, lastAt: iso(t1) } } }));
  const up = fakeApi({ listResult: [rowOf(ID_A, 450)] });
  const cooldown = await rounds({ times: 10, startNow: t1, stepMs: 30 * 1000, list: () => up.sessions.list({}), stateFile: seeded });
  check('升级场景：冷却内 10 轮 ⇒ 0 条（不许 5 分钟内连发两条）', cooldown.flatMap((r) => r.sends).length === 0);
  check('冷却中给出了原因（人话）', /冷却中/.test(cooldown[0].skipped.find((s) => s.sessionId === ID_A)?.reason ?? ''), JSON.stringify(cooldown[0].skipped));
  const late = await rounds({ times: 1, startNow: t1 + 6 * MIN, list: () => up.sessions.list({}), stateFile: seeded });
  check('冷却过后 ⇒ 强提醒 1 条（不是永久压住）', late[0].sends.length === 1 && late[0].sends[0].tier === 'strong');
  check('（守卫）默认冷却 = 生产常量 300000', sessions.NUDGE_COOLDOWN_MS === 300000);
}

// ═══ 判据 11：发往已归档 ⇒ 拒（且一次 prompt 都不许调）════════════════════
section('判据 11：发往已归档会话 ⇒ 拒绝（sessions.prompt 调用数为 0）');
{
  const now = Date.now();
  fs.writeFileSync(WS_F, JSON.stringify({ unit: 'workspace', global: { archivedSessionIds: [ID_B] }, tables: {} }));
  fs.writeFileSync(ARCH_F, JSON.stringify({ ids: { [ID_C]: { at: iso(now), title: '本地归档的' } } }));
  guard.resetGuardCache();
  const api = fakeApi({});
  const denied = await guard.guardedPrompt(api, ID_B, { text: '在吗' }, { archivedFile: ARCH_F, workspaceFile: WS_F, ttlMs: 0, now });
  check('DSH 侧归档名单里的 id ⇒ 拒', denied.sent === false && denied.code === 'archived-workspace', JSON.stringify(denied.code));
  check('拒的理由如实说明（"已归档…请换一条"）', /已归档/.test(denied.reason) && /换一条/.test(denied.reason), denied.reason);
  check('★ 归档 id 的 sessions.prompt 调用数 = 0', api.calls.prompt.length === 0, `prompt=${api.calls.prompt.length}`);
  const deniedLocal = await guard.guardedPrompt(api, ID_C, { text: '在吗' }, { archivedFile: ARCH_F, workspaceFile: WS_F, ttlMs: 0, now });
  check('本地名单命中也拒（code=archived-local）', deniedLocal.sent === false && deniedLocal.code === 'archived-local');
  check('本地拒也没调 prompt', api.calls.prompt.length === 0);

  // 反例 ①：刚建好、不在归档名单里的会话必须放行
  const ID_NEW = 'session-dddddddd-4444-4444-8444-dddddddddddd';
  const ok = await guard.guardedPrompt(api, ID_NEW, { text: '你好' }, { archivedFile: ARCH_F, workspaceFile: WS_F, ttlMs: 0, now });
  check('（反例）新建的、不在归档名单里 ⇒ 放行', ok.sent === true && ok.code === 'ok', JSON.stringify(ok.code));
  check('（守卫）放行时真的调了 prompt，形状 = {sessionId, mode:queue, content}', api.calls.prompt.length === 1
    && api.calls.prompt[0].sessionId === ID_NEW && api.calls.prompt[0].mode === 'queue'
    && api.calls.prompt[0].content?.[0]?.type === 'text', JSON.stringify(api.calls.prompt[0] ?? null));
  // 反例 ②：读不到归档名单 ⇒ 不拒，但 code 能看见
  const missing = await guard.guardedPrompt(fakeApi({}), ID_NEW, { text: '你好' }, { archivedFile: path.join(TMP, 'nope.json'), workspaceFile: path.join(TMP, 'nope-ws.json'), ttlMs: 0, now });
  check('（反例）读不到 workspace.json ⇒ 不拒（读失败不该让 QQ 掉线）', missing.sent === true);
  check('但把这件事暴露给调用方：code=archived-set-unavailable', missing.verdict.code === 'archived-set-unavailable', JSON.stringify(missing.verdict.code));
  // 投递抛错 ⇒ deliver-failed（调用方据此"不写已提醒"）
  const broken = fakeApi({ promptError: 'bridge down' });
  const err = await guard.guardedPrompt(broken, ID_NEW, { text: '你好' }, { archivedFile: ARCH_F, workspaceFile: WS_F, ttlMs: 0, now });
  check('投递抛错 ⇒ sent=false / code=deliver-failed', err.sent === false && err.code === 'deliver-failed', JSON.stringify(err.code));
  check('（守卫）抛错那次确实调了 prompt（不是被归档判定挡下的）', broken.calls.prompt.length === 1);

  // ── 缓存策略：**投递判定默认每次读盘**（Windows 同毫秒 mtime 不变 ⇒ 时间戳缓存会把刚归档的会话放过）──
  //    2026-09-25 实测：write(A) → 立刻 write(B)，mtimeMs 可能一模一样（1790276846546.5405 → 不变）
  //    ⇒ "mtime 主导"的失效在 Windows 上不可靠。修法：默认 ttlMs=0（每次读盘；文件 1,904 B / 0.07 ms），
  //       缓存只在显式 ttlMs>0（批量判定）时才用。下面**不用 sleep、不用 utimes**。
  let reads = 0;
  const counting = (p) => { reads += 1; return fs.readFileSync(p, 'utf8'); };
  guard.resetGuardCache();
  fs.writeFileSync(WS_F, JSON.stringify({ global: { archivedSessionIds: [ID_B] } }));
  const first = guard.readWorkspaceArchived({ file: WS_F, readFile: counting });
  const stampBefore = fs.statSync(WS_F).mtimeMs;
  fs.writeFileSync(WS_F, JSON.stringify({ global: { archivedSessionIds: [ID_B, ID_C] } })); // 立刻改写（同一毫秒）
  const stampAfter = fs.statSync(WS_F).mtimeMs;
  const second = guard.readWorkspaceArchived({ file: WS_F, readFile: counting }); // 默认 = 每次读盘
  check('★ 同毫秒内改写也必须立刻生效（中间不 sleep、不 utimes）', second.raw.length === 2 && first.raw.length === 1, `before=${first.raw.length} after=${second.raw.length}`);
  check('（守卫）默认路径每次都真读了盘（两次调用 ⇒ 两次读，不是走缓存）', reads === 2, `reads=${reads}`);
  console.log(`  ℹ️  本机这一对写入的 mtimeMs ${stampBefore === stampAfter ? '**相同**（正是那个坑）' : '不同'}：${stampBefore} → ${stampAfter}`);
  // ② 就算缓存里已经躺着一条"旧结论"，默认路径也不许信它
  fs.writeFileSync(WS_F, JSON.stringify({ global: { archivedSessionIds: [ID_B] } }));
  guard.readWorkspaceArchived({ file: WS_F, ttlMs: 60000, now: 1000, readFile: counting }); // 故意建一条缓存（1 条）
  fs.writeFileSync(WS_F, JSON.stringify({ global: { archivedSessionIds: [ID_B, ID_C] } }));  // 立刻改成 2 条
  const fromDefault = guard.readWorkspaceArchived({ file: WS_F, readFile: counting });        // 默认路径
  check('★ 缓存里有旧结论时，默认路径仍然读到最新（缓存不泄漏到投递判定）', fromDefault.raw.length === 2, `raw=${fromDefault.raw.length}`);
  // ③ 显式 ttlMs>0（批量场景）才走缓存：正例 + 反例
  const beforeBatch = reads;
  guard.resetGuardCache();
  guard.readWorkspaceArchived({ file: WS_F, ttlMs: 60000, now: 5000, readFile: counting });
  const cachedRun = guard.readWorkspaceArchived({ file: WS_F, ttlMs: 60000, now: 6000, readFile: counting });
  check('（正例）显式 ttlMs>0 + mtime 没变 + TTL 内 ⇒ 复用缓存（只读一次）', reads - beforeBatch === 1 && cachedRun.cached === true, `reads=${reads - beforeBatch}`);
  check('（反例）默认路径不吃这份缓存：紧接着再读一次 ⇒ 又读盘', guard.readWorkspaceArchived({ file: WS_F, readFile: counting }).raw.length === 2 && reads - beforeBatch === 2, `reads=${reads - beforeBatch}`);
  // ④ 本地名单同样每次读盘（没有缓存）
  const localFile = path.join(TMP, 'local-list.json');
  fs.writeFileSync(localFile, JSON.stringify({ ids: { [ID_A]: { at: iso(Date.now()) } } }));
  const l1 = guard.loadArchived(localFile).size;
  fs.writeFileSync(localFile, JSON.stringify({ ids: { [ID_A]: { at: iso(Date.now()) }, [ID_B]: { at: iso(Date.now()) } } }));
  const l2 = guard.loadArchived(localFile).size;
  check('★ 本地名单也每次读盘（同毫秒改写立刻生效，无缓存）', l1 === 1 && l2 === 2, `${l1} → ${l2}`);
  const n0 = reads;
  guard.resolveDelivery({}, ID_A, { archivedFile: localFile, workspaceFile: WS_F, readFile: counting });
  guard.resolveDelivery({}, ID_A, { archivedFile: localFile, workspaceFile: WS_F, readFile: counting });
  check('（守卫）resolveDelivery 默认两次判定 ⇒ 两次读盘（投递路径不吃缓存）', reads - n0 === 2, `reads=${reads - n0}`);
  check('文件不在 ⇒ fresh=false（不拒投递，但调用方看得见）', guard.readWorkspaceArchived({ file: path.join(TMP, 'nope-ws.json') }).fresh === false);
}

// ═══ 附加：nudge 候选集收窄（子代理 / QQ 侧 / 空 / 归档 都排除）══════════════
section('附加：候选集收窄（真数据里 6 条到档全是错目标：5 子代理 + 1 QQ 侧）');
{
  fs.rmSync(NUDGE_F, { force: true });
  const SUB = 'session-0453fd87-5555-4555-8555-0453fd875555';
  const RELAY = 'session-aab122e3-7777-4777-8777-aab122e37777'; // devRelay 绑定的开发会话
  const QQ = 'session-7bd10916-8888-4888-8888-7bd109168888';    // QQ 私聊会话（203 步 / 38 轮）
  const GUI = 'session-8357ddf3-6666-4666-8666-8357ddf36666';   // 主人 GUI 那条
  const ARCH = 'session-9f162de7-9999-4999-8999-9f162de79999';  // 已归档
  const sub = rowOf(SUB, 450, { raw: { projections: { values: { sessionStats: { steps: 450, turns: 2 }, subagent: { mode: 'continuable', label: 'x', seq: 0 } } } } });
  const relay = rowOf(RELAY, 480, { raw: { projections: { values: { sessionStats: { steps: 480, turns: 30 } } } } });
  const qq = rowOf(QQ, 203, { title: '小测（900003）', raw: { projections: { values: { sessionStats: { steps: 203, turns: 38 } } } } });
  const gui = rowOf(GUI, 250, { title: '优化part2', raw: { projections: { values: { sessionStats: { steps: 250, turns: 9 } } } } });
  const arch = rowOf(ARCH, 460);
  const empty = rowOf('session-11111111-1111-4111-8111-111111111111', 500);
  empty.blank = true;
  const api = fakeApi({ listResult: { items: [sub, relay, qq, gui, arch, empty] } });
  const res = await sessions.runNudge({
    list: () => api.sessions.list({}),
    stateFile: NUDGE_F,
    archivedIds: new Set([ARCH]),
    excludeIds: new Set([RELAY, QQ]), // = loadBridgeSessionIds() 给的那两个
  });
  check('★ 只有 GUI 那条到档（子代理/QQ/空/归档都不发）', res.sends.length === 1 && res.sends[0].sessionId === GUI, JSON.stringify(res.sends.map((s) => s.short)));
  check('（反例）子代理会话 450 步也不提醒（主人没法归档它）', !res.sends.some((s) => s.sessionId === SUB));
  check('（反例）QQ 侧会话 203 步不提醒（步数阈值对 QQ 不合身）', !res.sends.some((s) => s.sessionId === QQ));
  check('（反例）devRelay 绑定的开发会话 480 步不提醒', !res.sends.some((s) => s.sessionId === RELAY));
  check('（反例）已归档 / 空会话不提醒', !res.sends.some((s) => s.sessionId === ARCH || s.sessionId === empty.id));
  check('排掉的原因分别计数（subagent 1 / bridge 2 / blank 1 / archived 1）',
    res.excluded.subagent === 1 && res.excluded.bridge === 2 && res.excluded.blank === 1 && res.excluded.archived === 1, JSON.stringify(res.excluded));
  check('（守卫）不是空跑：真读了 6 条、其中 1 条真发了', res.total === 6 && res.due === true, `total=${res.total}`);
  check('候选集收窄不改判档：250 步 = 先提醒，不是强提醒', res.sends[0].tier === 'nudge');
}

// ═══ 附加：轮数只做显示（阈值仍只用步数；读不到不显示）════════════════════
section('附加：文案带轮数（读不到就不显示，不许填 0 轮）');
{
  const withTurns = sessions.nudgeText({ steps: 214, turns: 8, tier: 'nudge' });
  check('文案形如「214 步 / 8 轮」', /已经 214 步 \/ 8 轮了/.test(withTurns), withTurns);
  check('（反例）turns 读不到 ⇒ 只显示步数、不出现"轮"', /已经 214 步了/.test(sessions.nudgeText({ steps: 214, tier: 'nudge' })) && !/轮/.test(sessions.nudgeText({ steps: 214, tier: 'nudge' })));
  check('（反例）turns=null ⇒ 不显示 0 轮', !/0 轮/.test(sessions.nudgeText({ steps: 214, turns: null, tier: 'nudge' })));
  check('强档文案同样带轮数', /已经 452 步 \/ 12 轮了/.test(sessions.nudgeText({ steps: 452, turns: 12, tier: 'strong' })));
  const rows = sessions.parseSessionRows([rowOf(ID_A, 300, { raw: { projections: { values: { sessionStats: { steps: 300, turns: 11 } } } } }), rowOf(ID_B, 300)]);
  check('parseSessionRows 读出 turns（读不到 = null）', rows[0].turns === 11 && rows[1].turns === null, JSON.stringify(rows.map((r) => r.turns)));
  check('（守卫）幂等路也带 turns', sessions.parseSessionRows(rows)[0].turns === 11);
  const api = fakeApi({ listResult: { items: [rowOf(ID_A, 300, { raw: { projections: { values: { sessionStats: { steps: 300, turns: 7 } } } } })] } });
  const res = await sessions.runNudge({ list: () => api.sessions.list({}), stateFile: path.join(TMP, 'turns.json'), now: Date.now() });
  check('runNudge 的 sends[i] 带 turns 且文案含轮数', res.sends[0]?.turns === 7 && /7 轮/.test(res.sends[0]?.text ?? ''), JSON.stringify(res.sends[0] ?? null));
  check('sends[i] 契约字段齐（tier/tierLabel/sessionId/shortId/steps/turns/text）',
    ['tier', 'tierLabel', 'sessionId', 'shortId', 'steps', 'turns', 'text'].every((k) => k in (res.sends[0] ?? {})), JSON.stringify(Object.keys(res.sends[0] ?? {})));
  check('runNudge 顶层契约：ok / due', res.ok === true && res.due === true);
  check('（守卫）没有到档时 due=false', (await sessions.runNudge({ list: async () => [], stateFile: path.join(TMP, 'turns2.json') })).due === false);
}

// ═══ 附加：当前会话判据（子代理会话必须先排掉）═════════════════════════════
section('附加：当前会话判据（① 子代理 ② 桥接建的 ③ 其余取最新）');
{
  const SUB = 'session-0453fd87-5555-4555-8555-0453fd875555';
  const GUI = 'session-8357ddf3-6666-4666-8666-8357ddf36666';
  const RELAY = 'session-aab122e3-7777-4777-8777-aab122e37777';
  const QQ = 'session-7bd10916-8888-4888-8888-7bd109168888';
  const sub = rowOf(SUB, 12, { title: '你是实现工程师，工作目录 D:\\hobby\\DSH', raw: { projections: { values: { sessionStats: { steps: 12 }, title: '你是实现工程师…', subagent: { mode: 'continuable', label: '会话卫生', seq: 0 } } } } });
  sub.updatedAt = 9.0e15; // 子代理是最新的（正是会误伤的那种排布）
  const gui = rowOf(GUI, 300, { title: '优化part2' });
  gui.updatedAt = 8.0e15;
  const relay = rowOf(RELAY, 40, { title: '小助手' });
  relay.updatedAt = 8.6e15; // devRelay 那条也很新，且 cwd = 工作区根（光看 cwd 认不出来）
  const qq = rowOf(QQ, 88, { title: '小测' });
  qq.updatedAt = 8.5e15;
  const blank = rowOf('session-99999999-9999-4999-8999-999999999999', 0);
  blank.blank = true; blank.updatedAt = 9.9e15;

  const rows = sessions.parseSessionRows([sub, gui, relay, qq, blank]);
  check('（守卫）subagent 字段被解析出来（不是 undefined）', rows[0].subagent?.mode === 'continuable', JSON.stringify(rows[0].subagent));
  const bridgeIds = new Set([RELAY, QQ]);
  const rank = sessions.rankCurrentSession(rows, { excludeIds: bridgeIds, archivedIds: new Set() });
  check('★ 选中的是 GUI 那条（8357ddf3），不是最新的子代理会话', rank.current?.id === GUI, `current=${rank.current?.id}`);
  check('子代理会话被第一步排掉', rank.excluded.some((e) => e.id === SUB && e.why === 'subagent'), JSON.stringify(rank.excluded));
  check('桥接建的（devRelay + QQ）按 id 排掉', rank.excluded.filter((e) => e.why === 'bridge').length === 2, JSON.stringify(rank.excluded));
  check('空会话排掉', rank.excluded.some((e) => e.why === 'blank'));
  check('（反例）若不做第①步（只排桥接+空），最新的那条就是子代理会话 ⇒ 这一步真在起作用',
    rows.filter((r) => !r.blank && !bridgeIds.has(r.id)).sort((a, b) => b.at - a.at)[0]?.id === SUB);
  check('候选剩 1 条（= GUI 那条）', rank.candidates === 1, `candidates=${rank.candidates}`);
}

// ═══ 附加：token / 花费（2026-09-25 主人："token 用量也参考进去，做步数的判定依据"）═══
section('附加：花费判档（只有花费超也要提醒）+ 口径对账');
{
  const costOnlyState = path.join(TMP, 'cost-only.json');
  // ★ 核心正例：步数只有 50，但花了 ¥3.0（> 2.5）⇒ 必须先提醒，且 trigger='cost'
  const expensive = rowWithUsage(ID_A, 50, { uncached: 1_000_000, output: 500_000 }); // 1 + 2 = ¥3.0
  const api = fakeApi({ listResult: { items: [expensive] } });
  const res = await sessions.runNudge({ list: () => api.sessions.list({}), stateFile: costOnlyState, now: Date.now() });
  check('★ 只有花费超（50 步 / ¥3.0）⇒ 先提醒', res.sends.length === 1 && res.sends[0].tier === 'nudge', JSON.stringify(res.sends.map((s) => s.steps)));
  check('★ trigger = cost（说清是哪一条触发的）', res.sends[0]?.trigger === 'cost', JSON.stringify(res.sends[0]?.trigger));
  check('文案点明"虽然只有 50 步，但已经花了…"', /虽然只有 50 步.*已经花了/.test(res.sends[0]?.text ?? ''), res.sends[0]?.text);
  check('文案带金额，且不是 ¥0', /约 ¥3\.0/.test(res.sends[0]?.text ?? '') && !/¥0(?!\.)/.test(res.sends[0]?.text ?? ''), res.sends[0]?.text);
  check('sends[i] 带 cost / tokens / trigger', res.sends[0]?.cost === 3 && res.sends[0]?.tokens?.total === 1_500_000 && res.sends[0]?.trigger === 'cost', JSON.stringify({ cost: res.sends[0]?.cost, tokens: res.sends[0]?.tokens }));
  // 反例：步数少且便宜 ⇒ 不发
  const cheap = rowWithUsage(ID_B, 50, { uncached: 100_000, output: 50_000 }); // 0.1 + 0.2 = ¥0.3
  const api2 = fakeApi({ listResult: { items: [cheap] } });
  const r2 = await sessions.runNudge({ list: () => api2.sessions.list({}), stateFile: path.join(TMP, 'cost-cheap.json'), now: Date.now() });
  check('（反例）50 步 / ¥0.3 ⇒ 不发', r2.sends.length === 0, JSON.stringify(r2.sends));
  check('（守卫）不是空跑：真读到花费 ¥0.3', r2.skipped.length === 0 && sessions.parseSessionRows([cheap])[0].cost.toFixed(2) === '0.30');
  // 反例：步数够但投影缺失 ⇒ 仍按步数发，文案**不许**出现金额/token
  const noUsage = rowOf(ID_C, 250);
  const api3 = fakeApi({ listResult: { items: [noUsage] } });
  const r3 = await sessions.runNudge({ list: () => api3.sessions.list({}), stateFile: path.join(TMP, 'cost-missing.json'), now: Date.now() });
  const t3 = r3.sends[0]?.text ?? '';
  check('（反例）步数够但 tokenUsage 缺失 ⇒ 照发（退回步数口径）', r3.sends.length === 1 && r3.sends[0].trigger === 'steps', JSON.stringify(r3.sends[0]?.trigger));
  check('（反例）文案里一个"¥"都没有（不许把缺失显示成 0）', !t3.includes('¥') && !/tok/.test(t3), t3);
  check('cost / tokens 都是 null（不是 0）', r3.sends[0]?.cost === null && r3.sends[0]?.tokens === null, JSON.stringify({ c: r3.sends[0]?.cost, t: r3.sends[0]?.tokens }));
  // 强档：花费 ≥8
  const superExpensive = rowWithUsage(ID_A, 60, { uncached: 2_000_000, output: 1_600_000 }); // 2 + 6.4 = ¥8.4
  const api4 = fakeApi({ listResult: { items: [superExpensive] } });
  const r4 = await sessions.runNudge({ list: () => api4.sessions.list({}), stateFile: path.join(TMP, 'cost-strong.json'), now: Date.now() });
  check('花费 ≥ ¥8 ⇒ 强提醒（trigger=cost）', r4.sends[0]?.tier === 'strong' && r4.sends[0]?.trigger === 'cost', JSON.stringify({ tier: r4.sends[0]?.tier, trigger: r4.sends[0]?.trigger }));
  // 两条都超 ⇒ trigger='both'
  const both = rowWithUsage(ID_B, 300, { uncached: 1_000_000, output: 500_000 }); // 步数 300 + ¥3.0
  const api5 = fakeApi({ listResult: { items: [both] } });
  const r5 = await sessions.runNudge({ list: () => api5.sessions.list({}), stateFile: path.join(TMP, 'cost-both.json'), now: Date.now() });
  check('步数与花费都超 ⇒ trigger 两个都写出来（steps+cost）', r5.sends[0]?.trigger === 'steps+cost', JSON.stringify(r5.sends[0]?.trigger));
  check('（边界）judgeTier 纯函数：cost 2.49 不发 / 2.5 先提醒 / 8 强提醒', JSON.stringify([
    sessions.judgeTier({ steps: 10, cost: 2.49 }).tier, sessions.judgeTier({ steps: 10, cost: 2.5 }).tier, sessions.judgeTier({ steps: 10, cost: 8 }).tier,
  ]) === JSON.stringify([null, 'nudge', 'strong']));
  check('（边界）constants：TIER1_COST=2.5 / TIER2_COST=8 / TIER1_STEPS=200 / TIER2_STEPS=400',
    sessions.TIER1_COST === 2.5 && sessions.TIER2_COST === 8 && sessions.TIER1_STEPS === 200 && sessions.TIER2_STEPS === 400);
}

section('附加：价格口径（与账本工具共用 tools\\pricing.mjs）');
{
  const pricing = await import(pathToFileURL(path.join(TOOLS, 'pricing.mjs')).href);
  // 1M 未命中 + 1M 命中 + 1M 输出 = 1 + 0.02 + 4 = ¥5.02
  check('★ costT 权重对：1M 未命中 + 1M 命中 + 1M 输出 ⇒ ¥5.02', pricing.costT({ unc: 1e6, hit: 1e6, out: 1e6 }) === 5.02, String(pricing.costT({ unc: 1e6, hit: 1e6, out: 1e6 })));
  check('高峰 = 闲时 ×2（PEAK_X=2）', pricing.costT({ unc: 1e6 }, pricing.PEAK_X) === 2 && pricing.PEAK_X === 2);
  check('单价就是官方闲时价（0.02 / 1 / 4）', pricing.DEFAULT_PRICE.hit === 0.02 && pricing.DEFAULT_PRICE.miss === 1 && pricing.DEFAULT_PRICE.out === 4);
  const usage = { uncachedInputTokens: 615039, cacheReadTokens: 63045376, cacheWriteTokens: 0, outputTokens: 218427 };
  const tk = pricing.tokensOf(usage);
  check('tokens.total = 四桶之和（未命中+写缓存+命中+输出）', tk.total === 615039 + 63045376 + 0 + 218427, JSON.stringify(tk));
  check('★ 花费口径可手算核对：615,039×¥1 + 63,045,376×¥0.02 + 218,427×¥4（每 M）= ¥2.75',
    pricing.costOfTokens(usage).toFixed(2) === '2.75', String(pricing.costOfTokens(usage)));
  check('★ 投影缺失 ⇒ null，不是 0', pricing.tokensOf(null) === null && pricing.costOfTokens(undefined) === null && sessions.parseSessionRows([rowOf(ID_A, 10)])[0].cost === null);
  check('写缓存按未命中价算（cacheWrite 计入 unc）', pricing.bucketsOf({ cacheWriteTokens: 1e6 }).unc === 1e6 && pricing.costOfTokens({ cacheWriteTokens: 1e6 }) === 1);
  // 与账本工具的一致性：usage-report 的 costT 现在就是 import 这一份（源码级棘轮）
  const ur = fs.readFileSync(path.join(TOOLS, 'usage-report.mjs'), 'utf8');
  check('（棘轮）usage-report.mjs 的价格/算法来自 pricing.mjs（不再自己写一份价）',
    /from '\.\/pricing\.mjs'/.test(ur) && !/const PEAK_X = 2/.test(ur) && !/num\(t\.unc\) \* PRICE\.miss/.test(ur));
  check('（棘轮）usage-report 的 costT 仍绑定自己的 PRICE（--price-* 覆盖照旧生效）', /costTWith\(t, mult, PRICE\)/.test(ur));

  // ── 法定节假日 / 调休（2026-09-25，优化线；数据 = 国务院办公厅《关于2026年部分节假日安排的通知》）──
  // 北京时间 ⇒ UTC ms：北京 = UTC+8，所以给 Date.UTC 传 h-8。
  const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi);
  check('★ 假期落在工作日 ⇒ 闲时（2026-09-25 周五 = 中秋，北京 10:30）', pricing.isPeakBj(bj(2026, 9, 25, 10, 30)) === false);
  check('（对照）前一天同一钟点是工作日 ⇒ 高峰（2026-09-24 周四 10:30）', pricing.isPeakBj(bj(2026, 9, 24, 10, 30)) === true);
  check('★ 调休上班的周六 ⇒ 反过来算高峰（2026-10-10 周六 10:30，通知点名上班）', pricing.isPeakBj(bj(2026, 10, 10, 10, 30)) === true);
  check('（对照）调休后的周日 ⇒ 闲时（2026-10-11 周日 10:30）', pricing.isPeakBj(bj(2026, 10, 11, 10, 30)) === false);
  check('春节长假里的工作日 ⇒ 闲时（2026-02-16 周一 10:30）', pricing.isPeakBj(bj(2026, 2, 16, 10, 30)) === false);
  check('假期里的夜间照样闲时（2026-10-02 周五 03:00）', pricing.isPeakBj(bj(2026, 10, 2, 3)) === false);
  check('钟点边界左闭右开：工作日 09:00 高峰 / 12:00 闲时 / 14:00 高峰 / 18:00 闲时',
    pricing.isPeakBj(bj(2026, 9, 24, 9)) === true && pricing.isPeakBj(bj(2026, 9, 24, 12)) === false
    && pricing.isPeakBj(bj(2026, 9, 24, 14)) === true && pricing.isPeakBj(bj(2026, 9, 24, 18)) === false);
  check('★ 表外年份回落老口径（2027-09-24 周五 10:30 ⇒ 高峰），且覆盖范围可自查',
    pricing.isPeakBj(bj(2027, 9, 24, 10, 30)) === true && pricing.holidayTableCovers(2027) === false && pricing.holidayTableCovers(2026) === true);
  check('表体检：2026 = 33 天假 + 6 天调休上班（照通知逐项数：3+9+3+5+3+3+7 / 1+2+1+2），且两边不重叠',
    pricing.CN_HOLIDAYS[2026].off.length === 33 && pricing.CN_HOLIDAYS[2026].work.length === 6
    && pricing.CN_HOLIDAYS[2026].work.every((k) => !pricing.CN_HOLIDAYS[2026].off.includes(k)));
  check('（棘轮）usage-report 不再自带时段判据：isPeak 从 pricing.mjs 来、也没了「不识别中国法定节假日」那句',
    /isPeakBj/.test(ur) && !/function isPeak\(/.test(ur) && !/不识别中国法定节假日/.test(ur));
}

// ═══ 附加：相对判据（"够重开几次"，2026-09-25 03:2x 主人拍板）═══════════════
section('附加：相对判据（ratio = 因为长多付的钱 ÷ 重开一条的实测代价 ¥0.031）');
{
  // 想让 ratio = R，就需要 cacheRead = R × 0.031 / (0.02/1e6)
  const usageForRatio = (ratio, extra = {}) => ({ cacheRead: Math.round(ratio * 0.031 * 1e6 / 0.02), ...extra });
  const st = (n) => path.join(TMP, `rel-${n}.json`);
  check('常量：重开一条 = ¥0.031（实测中位，不是估的）/ 阈值 20、45（二次定标，与 200/400 步大致同批）',
    sessions.FRESH_COST === 0.031 && sessions.TIER1_RATIO === 20 && sessions.TIER2_RATIO === 45);

  // ★ 正例：步数只有 40（远没到 200）、花费也不高，但"因为长"多付到够重开 21 次 ⇒ 先提醒
  const cache16 = usageForRatio(21).cacheRead;
  const relRow = rowWithUsage(ID_A, 40, usageForRatio(21));
  const api = fakeApi({ listResult: { items: [relRow] } });
  const r1 = await sessions.runNudge({ list: () => api.sessions.list({}), stateFile: st(1), now: Date.now() });
  const s1 = r1.sends[0] ?? {};
  check('★ ratio 21（步数 40 / 花费不高）⇒ 先提醒', r1.sends.length === 1 && s1.tier === 'nudge', JSON.stringify(r1.sends.map((s) => s.tier)));
  check('★ trigger 里带 ratio（说清是这条新口径捞出来的）', s1.triggers?.includes('ratio') && !s1.triggers.includes('steps'), JSON.stringify(s1.triggers));
  check('四个数都在 sends[i] 里（perStepCtx/perStepTask/paidForLength/freshCost/ratio）',
    ['perStepCtx', 'perStepTask', 'paidForLength', 'freshCost', 'ratio'].every((k) => k in s1), JSON.stringify(Object.keys(s1)));
  check('手算：paidForLength = 命中 × ¥0.02/M', Math.abs(s1.paidForLength - (cache16 * 0.02 / 1e6)) < 1e-9, String(s1.paidForLength));
  check('手算：ratio = paidForLength ÷ 0.031', Math.abs(s1.ratio - s1.paidForLength / 0.031) < 1e-9, String(s1.ratio));
  check('手算：perStepCtx = 命中/步 × ¥0.02/M', Math.abs(s1.perStepCtx - (cache16 / 40) * 0.02 / 1e6) < 1e-12, String(s1.perStepCtx));
  check('手算：perStepTask = (未命中×¥1 + 输出×¥4)/步（这里都没给 ⇒ 0）', s1.perStepTask === 0, String(s1.perStepTask));
  check('文案摆出四个数（"因为长"多付 / 够重开 / 继续每步 / 重开一条）',
    /"因为长"多付 ¥[\d.]+（≈ 重开 21 次）/.test(s1.text) && /继续每步约 ¥0\.\d+/.test(s1.text) && /重开一条（含把活重新干起来）实测约 ¥0\.031/.test(s1.text), s1.text);
  check('文案把触发的线也写清楚（≥20）', /［触发：够重开 21 次 ≥ 20］/.test(s1.text), s1.text);

  // 反例：够重开 19.9 次 ⇒ 不发
  const api2 = fakeApi({ listResult: { items: [rowWithUsage(ID_B, 40, usageForRatio(19.9))] } });
  const r2 = await sessions.runNudge({ list: () => api2.sessions.list({}), stateFile: st(2), now: Date.now() });
  check('（反例）ratio 19.9（步数 40、花费不高）⇒ 不发', r2.sends.length === 0, JSON.stringify(r2.sends.map((s) => s.tier)));
  // ratio ≥45 ⇒ 强提醒
  const api3 = fakeApi({ listResult: { items: [rowWithUsage(ID_C, 40, usageForRatio(45))] } });
  const r3 = await sessions.runNudge({ list: () => api3.sessions.list({}), stateFile: st(3), now: Date.now() });
  check('ratio 45 ⇒ 强提醒', r3.sends[0]?.tier === 'strong' && r3.sends[0]?.triggers.includes('ratio'), JSON.stringify(r3.sends[0]?.triggers));
  // 旧口径仍然生效：200 步但 ratio 1 ⇒ 仍发（兜底不许被新口径顶掉）
  const api4 = fakeApi({ listResult: { items: [rowWithUsage(ID_A, 200, usageForRatio(1))] } });
  const r4 = await sessions.runNudge({ list: () => api4.sessions.list({}), stateFile: st(4), now: Date.now() });
  check('旧口径仍生效：200 步但 ratio 1 ⇒ 仍发（trigger 带 steps）', r4.sends.length === 1 && r4.sends[0].triggers.includes('steps'), JSON.stringify(r4.sends[0]?.triggers));
  // 没有 tokenUsage ⇒ ratio 是 null（不是 0）⇒ 退回只看绝对口径，文案不出现"重开"
  const api5 = fakeApi({ listResult: { items: [rowOf(ID_B, 250)] } });
  const r5 = await sessions.runNudge({ list: () => api5.sessions.list({}), stateFile: st(5), now: Date.now() });
  const s5 = r5.sends[0] ?? {};
  check('（反例）投影缺失 ⇒ ratio/cost/tokens 全 null（不是 0）', s5.ratio === null && s5.cost === null && s5.tokens === null, JSON.stringify({ ratio: s5.ratio, cost: s5.cost }));
  check('（反例）投影缺失 ⇒ 仍按步数发，但文案**不出现"重开"与"¥"**', r5.sends.length === 1 && !/重开/.test(s5.text) && !/¥/.test(s5.text), s5.text);
  // triggerNote：每条判据引用**它自己跨过的那条线**（回归：曾经把 354 步写成 "≥400"）
  const note = sessions.triggerNote({ triggers: ['ratio', 'steps', 'cost'], steps: 354, cost: 3.7, ratio: 54 });
  check('★ triggerNote 每条用自己的线：够重开 54 ≥ 45＋步数 354 ≥ 200＋花费 ¥3.7 ≥ 2.5',
    /够重开 54 次 ≥ 45/.test(note) && /步数 354 ≥ 200/.test(note) && /花费 ¥3\.7 ≥ 2\.5/.test(note), note);
  check('（反例）真跨过 400 步时写 ≥ 400', /步数 420 ≥ 400/.test(sessions.triggerNote({ triggers: ['steps'], steps: 420, cost: null, ratio: null })));
  // 相对判据只在**候选集之内**用（子代理/QQ 会话照样排除）
  const api6 = fakeApi({ listResult: { items: [rowWithUsage(ID_A, 40, usageForRatio(50))] } });
  const r6 = await sessions.runNudge({ list: () => api6.sessions.list({}), stateFile: st(6), now: Date.now(), excludeIds: new Set([ID_A]) });
  check('（边界）ratio 50 的会话若属桥接建的（QQ 侧）⇒ 仍被候选集排除', r6.sends.length === 0 && r6.excluded.bridge === 1, JSON.stringify(r6.excluded));
}

// ═══ 附加：归档确认（--ask-owner，本地假 HTTP 服务，不碰真桥接）═════════════
section('附加：--ask-owner（QQ 确认链路：本地假端点验契约）');
{
  const http = await import('node:http');
  const hits = [];
  let mode = 'ok'; // ok | 404
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ url: req.url, method: req.method, token: req.headers['x-console-token'], body });
      if (mode === '404') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'no such endpoint' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, askId: 'ask-1', shortId: 'aaaa', expiresAt: Date.now() + 12 * 3600e3 }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${srv.address().port}/api/dev/archive-ask`;
  const tokenFile = path.join(TMP, 'console-token');
  fs.writeFileSync(tokenFile, '  tok-123\n');
  const noLogs = path.join(TMP, 'no-logs');

  const send = {
    sessionId: ID_A, short: 'aaaaaaaa', title: '优化part2', steps: 337, turns: 9, cost: 3.46,
    perStepCtx: 0.0047, perStepTask: 0.0056, paidForLength: 1.61, freshCost: 0.031, ratio: 52,
    tokens: { total: 74_900_000, uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  };
  const askText = sessions.askOwnerText(send);
  check('问话文案摆数（金额 + 够重开 + 每步 + 重开一条 + 怎么回）',
    /【归档确认】「优化part2」已经 337 步 \/ 9 轮 · ¥3\.5/.test(askText) && /够重开 52 次/.test(askText)
    && /重开一条（含把活重新干起来）实测约 ¥0\.031/.test(askText) && /回「归档」/.test(askText) && /回「取消」/.test(askText), askText);
  check('接续句 = 标题 + 他最后一条消息 + HANDOFF 指针',
    sessions.continuationText({ title: '优化part2', lastMessage: '把判据改成相对判据' }) === '接续「优化part2」：把判据改成相对判据；现状与交接见 docs\\HANDOFF.md');
  check('（反例）取不到最后一条消息 ⇒ 那句整段省略（只留标题 + 指针）',
    sessions.continuationText({ title: '优化part2', lastMessage: null }) === '接续「优化part2」；现状与交接见 docs\\HANDOFF.md');

  const post = (args) => sessions.postArchiveAsk({ ...args, endpoint, tokenFile });
  const stateFile = path.join(TMP, 'ask-state.json');
  const r1 = await sessions.runAskOwner({ sends: [send], stateFile, post, now: Date.now(), logRoot: noLogs });
  check('★ POST 契约：url / method / x-console-token（trim 过）/ body 四个字段',
    hits.length === 1 && hits[0].method === 'POST' && hits[0].url === '/api/dev/archive-ask' && hits[0].token === 'tok-123'
    && (() => { const b = JSON.parse(hits[0].body); return b.sessionId === ID_A && typeof b.askText === 'string' && typeof b.continuationText === 'string' && typeof b.title === 'string'; })(),
    JSON.stringify(hits[0] ?? null).slice(0, 220));
  check('body 的 askText 含金额、continuationText 含标题与 HANDOFF', (() => {
    const b = JSON.parse(hits[0].body);
    return /¥/.test(b.askText) && /优化part2/.test(b.continuationText) && /HANDOFF/.test(b.continuationText);
  })());
  check('（守卫）真的发了 1 次、回报 ok', r1.results.length === 1 && r1.results[0].ok === true && r1.failed === 0);
  check('（守卫）状态落盘且记的是 pending', (() => {
    const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return st.asks?.[ID_A]?.status === 'pending' && st.asks[ID_A].askId === 'ask-1';
  })(), fs.existsSync(stateFile) ? fs.readFileSync(stateFile, 'utf8').slice(0, 200) : '(没有文件)');
  const r2 = await sessions.runAskOwner({ sends: [send], stateFile, post, now: Date.now() + 60_000, logRoot: noLogs });
  check('★ 防重复：同一会话再问 ⇒ 跳过，POST 次数仍为 1', hits.length === 1 && r2.skips.length === 1 && r2.results.length === 0, JSON.stringify(r2.skips));
  check('跳过原因写清"已经问过、还在等他答复"', /已经问过/.test(r2.skips[0]?.reason ?? ''), r2.skips[0]?.reason);
  const dryState = path.join(TMP, 'ask-dry.json');
  const r3 = await sessions.runAskOwner({ sends: [send], stateFile: dryState, post, now: Date.now(), dryRun: true, logRoot: noLogs });
  check('★ --dry-run ⇒ 0 次 POST、不写状态，但把问话打印出来', hits.length === 1 && !fs.existsSync(dryState) && r3.asks[0]?.dryRun === true && /【归档确认】/.test(r3.asks[0]?.askText ?? ''));
  const before = hits.length;
  const noTok = await sessions.postArchiveAsk({ sessionId: ID_A, askText: 'x', continuationText: 'y', title: 't', endpoint, tokenFile: path.join(TMP, 'nope-token') });
  check('★ 令牌读不到 ⇒ 拒发 + 如实报错，且没碰端点', noTok.ok === false && /控制台令牌/.test(noTok.error) && hits.length === before, noTok.error);
  mode = '404';
  const st404 = path.join(TMP, 'ask-404.json');
  const r404 = await sessions.runAskOwner({ sends: [send], stateFile: st404, post, now: Date.now(), logRoot: noLogs });
  check('★ 端点 404 ⇒ 没发成、failed=1（调用方据此非 0 退出）', r404.failed === 1 && r404.results[0].ok === false && /404/.test(r404.results[0].error), r404.results[0]?.error);
  check('★ 404 时**不写 pending**（下一轮会重试），只留一条失败痕迹', (() => {
    if (!fs.existsSync(st404)) return true;
    const st = JSON.parse(fs.readFileSync(st404, 'utf8'));
    return st.asks?.[ID_A]?.status !== 'pending' && Boolean(st.asks?.[ID_A]?.lastFail);
  })(), fs.existsSync(st404) ? fs.readFileSync(st404, 'utf8').slice(0, 200) : '(无文件)');
  mode = 'ok';
  const dead = await sessions.postArchiveAsk({ sessionId: ID_A, askText: 'x', continuationText: 'y', title: 't', endpoint: 'http://127.0.0.1:1/api/dev/archive-ask', tokenFile, timeoutMs: 2000 });
  check('★ 连不上端点 ⇒ ok:false 且说明"桥接没在跑，或这个端点还没上线"', dead.ok === false && /连不上端点/.test(dead.error) && /还没上线/.test(dead.error), dead.error);
  await new Promise((r) => srv.close(r));

  // 会话日志解析（离线：自己造一个多帧 zstd 日志）
  const logFile = path.join(TMP, 'session.v3.jsonl.zstd');
  const mkLog = (lines) => fs.writeFileSync(logFile, zlib.zstdCompressSync(Buffer.from(lines.join('\n') + '\n', 'utf8')));
  mkLog([
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '第一条（他发的）' }], source: { kind: 'user' } } }),
    JSON.stringify({ type: 'assistant/message', data: {} }),
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '子代理回执' }], source: { kind: 'subagent' } } }),
    JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: '最后一条（他发的）' }], source: { kind: 'user' } } }),
  ]);
  check('★ 日志解析：取**主人自己发的**最后一条（跳过子代理注入）', sessions.lastOwnerMessage(logFile) === '最后一条（他发的）', String(sessions.lastOwnerMessage(logFile)));
  mkLog([JSON.stringify({ type: 'user/message', data: { content: [{ type: 'text', text: 'x'.repeat(500) }], source: { kind: 'user' } } })]);
  check('截断到 200 字（多一个省略号）', [...sessions.lastOwnerMessage(logFile)].length === 201, String([...sessions.lastOwnerMessage(logFile)].length));
  fs.writeFileSync(logFile, Buffer.from('not zstd at all', 'utf8'));
  check('（反例）解不开的日志 ⇒ null（调用方省略那句，绝不编）', sessions.lastOwnerMessage(logFile) === null);
  check('（反例）日志不存在 ⇒ null', sessions.lastOwnerMessage(path.join(TMP, 'nope.zstd')) === null);
}

// ═══ 附加：「这条工作线」的钱（父子关系来自父行的 subagentCatalog；只显示、不进判档）═══
section('附加：子任务的钱（childCount / childCost / lineCost）');
{
  const P = 'session-pppppppp-1111-4111-8111-pppppppppppp';
  const C1 = 'session-cccc1111-2222-4222-8222-cccc11112222';
  const C2 = 'session-cccc2222-3333-4333-8333-cccc22223333';
  const GONE = 'session-gone0000-4444-4444-8444-gone00004444';
  const usage = (unc, out) => ({ uncached: unc, output: out });
  // 父：1M 未命中 + 0.5M 输出 = ¥3.0；子1：0.5M+0.25M = ¥1.5；子2：0.2M+0.1M = ¥0.6
  const parent = rowWithUsage(P, 100, usage(1_000_000, 500_000), { values: { subagentCatalog: [{ mode: 'continuable', label: 'a', id: C1 }, { mode: 'continuable', label: 'b', id: C2 }] } });
  const c1 = rowWithUsage(C1, 10, usage(500_000, 250_000), { values: { subagent: { mode: 'continuable', label: 'a', seq: 0 } } });
  const c2 = rowWithUsage(C2, 8, usage(200_000, 100_000), { values: { subagent: { mode: 'continuable', label: 'b', seq: 0 } } });
  const api = fakeApi({ listResult: { items: [parent, c1, c2] } });
  const st = path.join(TMP, 'line-1.json');
  // 父自己的步数 100/花费 3.0 ⇒ 由 cost 触发（不是 ratio），这样能验"lineCost 不进判档"
  const r = await sessions.runNudge({ list: () => api.sessions.list({}), stateFile: st, now: Date.now() });
  const s = r.sends[0] ?? {};
  check('★ 父 + 2 子 ⇒ childCount=2、childCost = 两子之和、lineCost = 自己 + 子',
    s.childCount === 2 && Math.abs(s.childCost - 2.1) < 1e-9 && Math.abs(s.lineCost - 5.1) < 1e-9,
    JSON.stringify({ childCount: s.childCount, childCost: s.childCost, lineCost: s.lineCost, cost: s.cost }));
  check('★ 文案有那半句「这条线一共约 ¥5.1（自己 ¥3.0 + 2 个子任务 ¥2.1）」',
    /这条线一共约 ¥5\.1（自己 ¥3\.0 \+ 2 个子任务 ¥2\.1）/.test(s.text), s.text);
  check('★ lineCost **不进判档**：ratio/paidForLength 只算自己那份（子任务的钱不混进去）',
    Math.abs(s.paidForLength - 0) < 1e-9 && s.ratio === 0 && s.triggers.join('+') === 'cost', JSON.stringify({ paidForLength: s.paidForLength, ratio: s.ratio, triggers: s.triggers }));
  check('（边界）没有 subagentCatalog ⇒ childCount=0 且文案里**不出现**"这条线"',
    (() => { const r2 = sessions.nudgeText({ steps: 250, cost: 3, tier: 'nudge', trigger: 'cost', triggers: ['cost'], childCount: 0, childCost: 0, lineCost: 3 }); return !/这条线/.test(r2); })());
  // 反例：catalog 里有一个 id 在清单里找不到 ⇒ 跳过那个、其余照算（不许整条 null）
  const api2 = fakeApi({ listResult: { items: [rowWithUsage(P, 100, usage(1_000_000, 500_000), { values: { subagentCatalog: [{ id: C1 }, { id: GONE }] } }), c1] } });
  const r2 = await sessions.runNudge({ list: () => api2.sessions.list({}), stateFile: path.join(TMP, 'line-2.json'), now: Date.now() });
  const s2 = r2.sends[0] ?? {};
  check('（反例）catalog 有 1 个 id 找不到 ⇒ 跳过它、其余照算（childCount=2 但 childCost 只算找得到的）',
    s2.childCount === 2 && s2.childMissing === 1 && Math.abs(s2.childCost - 1.5) < 1e-9 && Math.abs(s2.lineCost - 4.5) < 1e-9,
    JSON.stringify({ childCount: s2.childCount, childMissing: s2.childMissing, childCost: s2.childCost, lineCost: s2.lineCost }));
  // 子代理会话本身仍然不是提醒对象（它们的钱通过父会话被看见就够了）
  const api3 = fakeApi({ listResult: { items: [rowWithUsage(C1, 900, usage(5_000_000, 2_000_000), { values: { subagent: { mode: 'continuable', seq: 0 } } })] } });
  const r3 = await sessions.runNudge({ list: () => api3.sessions.list({}), stateFile: path.join(TMP, 'line-3.json'), now: Date.now() });
  check('（反例）子代理会话自己（900 步 / ¥13）⇒ 仍然不提醒（候选集排除）', r3.sends.length === 0 && r3.excluded.subagent === 1, JSON.stringify(r3.excluded));
}

// ═══ 附加：提问闸（2026-09-25 主人："归档请求感觉可以等子进程结束再发"）══════════════
section('附加：忙 ⇒ 不发、不盖章、deferred 如实报（空闲了自然重排）');
{
  const P = 'session-9a9a0000-1111-4111-8111-9a9a9a9a9a9a';
  const K1 = 'session-9b9b0000-2222-4222-8222-9b9b9b9b9b9b';
  const K2 = 'session-9c9c0000-3333-4333-8333-9c9c9c9c9c9c';
  const GONE = 'session-9d9d0000-4444-4444-8444-9d9d9d9d9d9d';
  /** 一份"真形状"的清单行：顶层 running + 父子关系在 projections.values.subagentCatalog 里。 */
  const mkRow = (id, { steps = 0, running = false, kids = null, sub = false, preset = '' } = {}) => ({
    sessionId: id, running, blank: false, cwd: ROOT, updatedAt: 1700000000000,
    projections: {
      values: {
        sessionStats: { steps },
        agentPreset: preset,
        ...(kids ? { subagentCatalog: kids.map((k) => ({ id: k })) } : {}),
        ...(sub ? { subagent: { mode: 'continuable', label: 'k', seq: 0 } } : {}),
      },
    },
  });
  const listOf = (items) => {
    const api = fakeApi({ listResult: { items } });
    return () => api.sessions.list({});
  };
  const postCounter = () => {
    const c = { hits: 0 };
    return { c, post: async () => { c.hits += 1; return { ok: true, receipt: { askId: 'ask-x' } }; } };
  };
  const noLogs = path.join(TMP, 'no-logs-busy');
  const iso2 = (ms) => new Date(ms).toISOString();

  // ── A. 自己还在跑 ⇒ 这一轮什么都不排（不进 sends、不落任何戳）──────────────────
  const stBusy = path.join(TMP, 'busy-1.json');
  const t0 = Date.now();
  const r1 = await sessions.runNudge({ list: listOf([mkRow(P, { steps: 250, running: true })]), stateFile: stBusy, now: t0 });
  check('★ 忙（自己还在跑）⇒ **不进 sends**（due=false）', r1.sends.length === 0 && r1.due === false, JSON.stringify(r1.sends));
  check('★ 忙 ⇒ deferred **如实报出来**（why/selfRunning/childRunning/steps/tier 全在），不静默吞掉',
    r1.deferred.length === 1 && r1.deferred[0].sessionId === P && r1.deferred[0].why === 'busy'
    && r1.deferred[0].selfRunning === true && r1.deferred[0].childRunning === 0
    && r1.deferred[0].steps === 250 && r1.deferred[0].tier === 'nudge' && r1.deferred[0].shortId === '9a9a0000',
    JSON.stringify(r1.deferred));
  check('★ 忙 ⇒ **一个戳都不落**（不写"已提醒"，下一轮空闲还能排上）',
    !fs.existsSync(stBusy) || !JSON.parse(fs.readFileSync(stBusy, 'utf8')).sessions?.[P], fs.existsSync(stBusy) ? fs.readFileSync(stBusy, 'utf8').slice(0, 120) : '(没有文件)');
  check('（守卫）不是空跑：这一轮真读了清单，而且判档本身是到档的', r1.total === 1 && r1.skipped.length === 0 && sessions.pickTier(250) === 'nudge');
  // 问话那一侧：sends 是空的 ⇒ 一次 POST 都不该有、也不该有"已问"戳
  const stAskBusy = path.join(TMP, 'busy-ask.json');
  const pc1 = postCounter();
  const askBusy = await sessions.runAskOwner({ sends: r1.sends, stateFile: stAskBusy, post: pc1.post, now: t0, logRoot: noLogs });
  check('★ 忙 ⇒ 问话路径 **0 次 POST**（"归档确认"根本没发出去）', pc1.c.hits === 0 && askBusy.asks.length === 0 && askBusy.results.length === 0);
  check('★ 忙 ⇒ 也不落"已问"戳（session-nudge.json 里那条会话一个字都没有）',
    !fs.existsSync(stAskBusy) || !JSON.parse(fs.readFileSync(stAskBusy, 'utf8')).asks?.[P]);
  // ── 空闲下来（同一份清单，只把 running 改掉）⇒ 下一个慢节拍自然排上 ────────────
  const r2 = await sessions.runNudge({ list: listOf([mkRow(P, { steps: 250 })]), stateFile: stBusy, now: t0 + 60000 });
  check('★ 空闲下来 ⇒ 下一轮**自然再排上**（这就是"等子进程跑完再发"）', r2.sends.length === 1 && r2.deferred.length === 0, JSON.stringify(r2.sends));
  check('这时才落"已提醒"戳（忙的时候没落，所以它没被永久静音）',
    JSON.parse(fs.readFileSync(stBusy, 'utf8')).sessions?.[P]?.tiers?.nudge?.steps === 250);
  const pc2 = postCounter();
  const askIdle = await sessions.runAskOwner({ sends: r2.sends, stateFile: stAskBusy, post: pc2.post, now: t0 + 60000, logRoot: noLogs });
  check('★ 空闲下来这一轮才真问一次（POST 1 次 + 落了 pending 戳）',
    pc2.c.hits === 1 && askIdle.results.length === 1 && askIdle.failed === 0
    && JSON.parse(fs.readFileSync(stAskBusy, 'utf8')).asks?.[P]?.status === 'pending', JSON.stringify(askIdle.results));

  // ── B. 自己空着、子任务在跑 ⇒ 也算忙；子任务全闲 ⇒ **不许**判忙（灵敏度反例）──
  const childBusyRows = [mkRow(P, { steps: 260, kids: [K1] }), mkRow(K1, { steps: 5, running: true, sub: true })];
  const rb = await sessions.runNudge({ list: listOf(childBusyRows), stateFile: path.join(TMP, 'busy-2.json'), now: t0 });
  check('★ 子任务在跑（自己空着）⇒ 一样不进 sends，deferred 报出"1 个子任务在跑"',
    rb.sends.length === 0 && rb.deferred.length === 1 && rb.deferred[0].selfRunning === false && rb.deferred[0].childRunning === 1,
    JSON.stringify(rb.deferred));
  const childIdleRows = [mkRow(P, { steps: 260, kids: [K1] }), mkRow(K1, { steps: 5, sub: true })];
  const ri = await sessions.runNudge({ list: listOf(childIdleRows), stateFile: path.join(TMP, 'busy-3.json'), now: t0 });
  check('（灵敏度反例）**子任务全闲** ⇒ 照发（不许一律判忙，否则这条线永远不会被提醒）',
    ri.sends.length === 1 && ri.deferred.length === 0, JSON.stringify({ sends: ri.sends.length, deferred: ri.deferred }));

  // ── C. 派生字段本身：有子在跑 / 子全闲 / 缺 id 三种 ──────────────────────────
  const derived = sessions.parseSessionRows({ items: [
    mkRow(P, { steps: 100, kids: [K1, K2, GONE] }),
    mkRow(K1, { steps: 1, running: true, sub: true }),
    mkRow(K2, { steps: 2, sub: true }),
  ] });
  const byId = new Map(derived.map((r) => [r.id, r]));
  check('★ 派生：1 个子在跑 + 1 个闲 + 1 个找不到 ⇒ childRunning=1 / unknown=1 / lineRunning=true',
    byId.get(P).childRunning === 1 && byId.get(P).childRunningUnknown === 1 && byId.get(P).lineRunning === true,
    JSON.stringify(byId.get(P)));
  check('★ 派生：子全闲 ⇒ childRunning=0 / lineRunning=false（★灵敏度：这条**不许**被判忙）',
    (() => { const rs = sessions.parseSessionRows({ items: [mkRow(P, { kids: [K1] }), mkRow(K1, { sub: true })] }); return rs[0].childRunning === 0 && rs[0].lineRunning === false; })());
  check('★ 派生：缺 id ⇒ 如实记进 childRunningUnknown（不当成"在跑"，但要能看见）',
    (() => { const rs = sessions.parseSessionRows({ items: [mkRow(P, { kids: [GONE] })] }); return rs[0].childRunning === 0 && rs[0].childRunningUnknown === 1 && rs[0].lineRunning === false; })());
  check('派生：没有 catalog ⇒ 0 / 0 / false（不是 null、也不是猜的）',
    (() => { const rs = sessions.parseSessionRows({ items: [mkRow(P, {})] }); return rs[0].childRunning === 0 && rs[0].childRunningUnknown === 0 && rs[0].lineRunning === false; })());
  check('幂等：连着 parse 两次结果逐字相同（新字段一起幂等）',
    JSON.stringify(sessions.parseSessionRows(derived)) === JSON.stringify(derived));

  // ── D. 已武装（主人回过「归档」）⇒ **这一轮什么都不做**；普通"已经发过"照旧跳过（灵敏度反例）──
  //    新语义（2026-09-25 晚，主人："我只要说了归档，你完成任务后自动归档就可以不用再问一次了"）：
  //    上一版那套"被忙拒 ⇒ 绕过 24h 去重、重新 POST 一次去问他"已整条删除 ⇒ 这里验的是**相反**的事。
  const stArmed = path.join(TMP, 'busy-armed.json');
  const seeded = { version: 1, sessions: { [P]: { tiers: { nudge: { at: iso2(t0), steps: 250 } }, lastAt: iso2(t0) } } };
  fs.writeFileSync(stArmed, JSON.stringify(seeded));
  const rNo = await sessions.runNudge({ list: listOf([mkRow(P, { steps: 250 })]), stateFile: stArmed, now: t0 + 60000 });
  check('（灵敏度反例）**没武装**：已经发过 ⇒ 照旧跳过（这条去重没被放宽）',
    rNo.sends.length === 0 && /已发过/.test(rNo.skipped.find((s) => s.sessionId === P)?.reason ?? ''), JSON.stringify(rNo.skipped));
  const rArmed = await sessions.runNudge({ list: listOf([mkRow(P, { steps: 250 })]), stateFile: stArmed, now: t0 + 60000, armedIds: new Set([P]) });
  check('★ 已武装（主人回过「归档」）⇒ **不进 sends**（不再问第二次），skipped 里如实写明"已授权归档"',
    rArmed.sends.length === 0 && /已授权归档/.test(rArmed.skipped.find((s) => s.sessionId === P)?.reason ?? ''),
    JSON.stringify({ sends: rArmed.sends.length, skipped: rArmed.skipped }));
  check('★ 已武装**不是**"绕过去重"：它在去重之前就被拦下（连 tiers 戳都没碰）',
    rArmed.sends.length === 0 && rArmed.deferred.length === 0, JSON.stringify(rArmed.skipped));
  check('★ 这条线还在跑的时候，即使已武装也**先延后**（闸在武装闸之前判：忙是当下的事实）',
    (await sessions.runNudge({ list: listOf([mkRow(P, { steps: 250, running: true })]), stateFile: stArmed, now: t0 + 60000, armedIds: new Set([P]) })).deferred.length === 1);
  const stAsk = path.join(TMP, 'busy-ask-once.json');
  fs.writeFileSync(stAsk, JSON.stringify({ version: 1, sessions: {}, asks: { [P]: { status: 'pending', at: t0, atIso: iso2(t0), askId: 'old' } } }));
  const pc3 = postCounter();
  const askOnce = await sessions.runAskOwner({ sends: [rNo.sends[0] ?? { sessionId: P, short: 'p', steps: 250, tier: 'nudge' }], stateFile: stAsk, post: pc3.post, now: t0 + 60000, logRoot: noLogs });
  check('★ 「已经问过、还在等他答复」是**没有例外**的（旧版那条 reask 例外已删）⇒ 0 次 POST',
    pc3.c.hits === 0 && askOnce.skips.length === 1 && /已经问过/.test(askOnce.skips[0].reason), JSON.stringify(askOnce.skips));

  // ── E. 只读那张待确认单：只挑"已武装 + 还没过期"的 ───────────────────────────
  const askFile = path.join(TMP, 'archive-ask.json');
  fs.writeFileSync(askFile, JSON.stringify({ asks: [
    { sessionId: P, armedAt: t0, expiresAt: t0 + 3600e3 },
    { sessionId: K1, armedAt: 0, expiresAt: t0 + 3600e3 },
    { sessionId: K2, armedAt: t0, expiresAt: t0 - 1000 },
    // 老记录（只有 refusedBusyAt）：归一化会把它当"已武装"，这里也要认（迁移前后行为一致）
    { sessionId: ID_A, refusedBusyAt: t0, expiresAt: t0 + 3600e3 },
  ] }));
  const ids = sessions.readArmedIds({ file: askFile, now: t0 });
  check('★ 只挑"已武装 + 还没过期"的（没武装的、过期的都不算）',
    ids.has(P) && !ids.has(K1) && !ids.has(K2), JSON.stringify([...ids]));
  check('★ 老记录（只有 refusedBusyAt）也算已武装（桥接那半会把它迁进 armedAt，迁移前后口径一致）',
    ids.has(ID_A), JSON.stringify([...ids]));
  check('（反例）文件不存在 / 内容坏 / 认不出 ⇒ **空集**（读不到只是不跳过任何会话，绝不误报"已授权"）',
    sessions.readArmedIds({ file: path.join(TMP, 'nope-ask.json') }).size === 0
    && (() => { fs.writeFileSync(path.join(TMP, 'bad-ask.json'), 'not json'); return sessions.readArmedIds({ file: path.join(TMP, 'bad-ask.json') }).size === 0; })());

  // ── E2. 新纯函数（桥接那半的判据本体）：`decideArmedArchive` 的三条铁律 ────────────
  //    桥接的轻节拍**只做 IO**，判定全在这个纯函数里 ⇒ 这里直接喂它正反例（不必起假 bridge）。
  const lib = await import(pathToFileURL(path.join(ROOT, 'qq-bridge', 'src', 'archive-lib.js')).href);
  const armedReq = { ...lib.buildAskRecord({ sessionId: ID_A, askText: 'a', continuationText: 'c', now: t0, askId: 'ask-dec' }), armedAt: t0 };
  const idleJudge = async () => ({ known: true, busy: false, selfRunning: false, childRunning: 0, why: '' });
  const busyJudge = async () => ({ known: true, busy: true, selfRunning: true, childRunning: 0, why: '' });
  const unknownJudge = async () => ({ known: false, busy: true, selfRunning: null, childRunning: null, why: '清单读不到' });
  const d0 = await lib.decideArmedArchive({ asks: [armedReq], now: t0, graceMs: 0, busyOf: idleJudge });
  check('★ 空闲 + 窗口 0 ⇒ **当拍执行**（executes 恰好 1；不进 nextAsks = 成功后才由调用方删）',
    d0.executes.length === 1 && d0.nextAsks.length === 0 && d0.decisions[0]?.action === 'execute' && d0.decisions[0]?.graceMs === 0,
    JSON.stringify(d0.decisions));
  const dBusy = await lib.decideArmedArchive({ asks: [armedReq], now: t0 + 99999, graceMs: 0, busyOf: busyJudge });
  check('★ 忙 ⇒ **0 条 executes**，记录留着（wait/busy）—— 这张网短路掉就必须报红',
    dBusy.executes.length === 0 && dBusy.nextAsks.length === 1 && dBusy.decisions[0]?.why === 'busy', JSON.stringify(dBusy.decisions));
  const dUnknown = await lib.decideArmedArchive({ asks: [armedReq], now: t0 + 99999, graceMs: 0, busyOf: unknownJudge });
  check('★ 判不出来（fail-closed）⇒ 一样不动（known=false 也当忙）',
    dUnknown.executes.length === 0 && dUnknown.decisions[0]?.known === false, JSON.stringify(dUnknown.decisions));
  const dThrow = await lib.decideArmedArchive({ asks: [armedReq], now: t0 + 99999, graceMs: 0, busyOf: async () => { throw new Error('ECONNREFUSED'); } });
  check('★ 判忙时**抛错** ⇒ 也当忙、不执行（绝不让异常变成"那就归档吧"）',
    dThrow.executes.length === 0 && dThrow.decisions[0]?.why === 'busy', JSON.stringify(dThrow.decisions));
  const dGrace = await lib.decideArmedArchive({ asks: [armedReq], now: t0, graceMs: 30000, busyOf: idleJudge });
  check('★ 窗口调大（30000）⇒ 刚看见空闲**不执行**、记下 idleSince；满窗口才执行',
    dGrace.executes.length === 0 && dGrace.nextAsks[0]?.idleSince === t0
    && (await lib.decideArmedArchive({ asks: dGrace.nextAsks, now: t0 + 30000, graceMs: 30000, busyOf: idleJudge })).executes.length === 1,
    JSON.stringify(dGrace.decisions));
  const dReset = await lib.decideArmedArchive({ asks: dGrace.nextAsks, now: t0 + 5000, graceMs: 30000, busyOf: busyJudge });
  check('★ 计时中途又忙 ⇒ idleSince **清零**（下次空闲重新计时）',
    dReset.nextAsks[0]?.idleSince === 0 && dReset.executes.length === 0, JSON.stringify(dReset.nextAsks));
  const dExpire = await lib.decideArmedArchive({ asks: [{ ...armedReq, expiresAt: t0 - 1 }], now: t0, graceMs: 0, busyOf: idleJudge });
  const dGone = await lib.decideArmedArchive({ asks: [armedReq], now: t0, graceMs: 0, busyOf: idleJudge, archivedOf: () => true });
  check('★ 过期 / 已归档 ⇒ **丢弃记录**（decisions 里如实报 expire / gone，且不进 nextAsks）',
    dExpire.decisions[0]?.action === 'expire' && dExpire.nextAsks.length === 0
    && dGone.decisions[0]?.action === 'gone' && dGone.nextAsks.length === 0,
    JSON.stringify([dExpire.decisions[0]?.action, dGone.decisions[0]?.action]));
  const dUnarmed = await lib.decideArmedArchive({ asks: [{ ...armedReq, armedAt: 0 }], now: t0 + 99999, graceMs: 0, busyOf: idleJudge });
  check('（灵敏度反例）**没武装**的条目 ⇒ 一个 executes 都没有（他还没回「归档」，谁也不许替他决定）',
    dUnarmed.executes.length === 0 && dUnarmed.nextAsks.length === 1, JSON.stringify(dUnarmed.decisions));

  // ── F. 文案：忙的时候说清"还在跑什么"，而且**不许**说成"可以归档了" ────────────
  const tBusy = sessions.nudgeText({ steps: 250, cost: 3, tier: 'nudge', running: false, childRunning: 2, childCount: 2, childCost: 1, lineCost: 4 });
  check('★ 忙文案说清"还有 2 个子任务在跑"，并明确"现在动手会把在飞的活掐掉"',
    /还有 2 个子任务在跑/.test(tBusy) && /掐掉/.test(tBusy) && /白付/.test(tBusy), tBusy);
  check('★ 忙文案**不许**出现"可以归档了 / 已结束 / 已完成"（还在跑就不许说成该收了）',
    !/可以归档了|已结束|已完成/.test(tBusy), tBusy);
  check('（守卫）钱与判据那几段照旧都在（忙文案是**追加**，不是替换）',
    /¥3\.0/.test(tBusy) && /这条线一共约 ¥4\.0/.test(tBusy), tBusy);
  check('（灵敏度反例）子任务全闲 ⇒ 文案里**不出现**"子任务在跑"',
    !/子任务在跑/.test(sessions.nudgeText({ steps: 250, cost: 3, tier: 'nudge', running: false, childRunning: 0 })));
  check('（边界）自己跑着 + 子任务也跑着 ⇒ 两句都在（一个是自己、一个是"这条线"）',
    (() => { const t = sessions.nudgeText({ steps: 250, cost: 3, tier: 'nudge', running: true, childRunning: 1 }); return /还在跑/.test(t) && /还有 1 个子任务在跑/.test(t); })());
}

// ═══ 附加：窗口 a 键的忙时软闸（tools\dsh-prompt.ps1）══════════════════════════
// ④ 那一半在 ps1 里（人在键盘前，是显式动作 ⇒ 软闸：第一次按只解释、再按一次才动手）。
// 两件事都要钉：① **判据只有一份**（ps1 只搬 status --json 的字段，不自己重算）；
//              ② 闸必须在**唯一那处 archive 调用之前**（挂错位置 = 白做）。
// 真跑那半：把 ps1 里的 Get-SessionLineBusy **原样抽出来**在 PowerShell 里执行（不是抄一份判定），
// 喂忙/闲/判不出三态；再喂一份"被改坏"的函数体当**灵敏度反例**（检查器不许恒真）。
section('附加：窗口 a 键的软闸（真源码 + 真跑那支判定 + 静态棘轮）');
{
  const ps1Path = path.join(TOOLS, 'dsh-prompt.ps1');
  const ps1Src = fs.readFileSync(ps1Path, 'utf8');
  // ① 静态棘轮：闸的位置与"判据不重写"
  const scanAKey = (src) => {
    const gate = src.indexOf('$busyInfo = Get-SessionLineBusy $cur');
    const archiveCall = src.indexOf("-CliArgs @('archive', $id, '--yes')");
    const defs = (src.match(/function Get-SessionLineBusy\(/g) ?? []).length;
    // ps1 里不许自己重算父子关系 / 树（那会变成第二份判据）
    const reDerives = /subagentCatalog|childIds/.test(src);
    return { gate, archiveCall, defs, reDerives, ok: gate > 0 && archiveCall > gate && defs === 1 && !reDerives };
  };
  const g = scanAKey(ps1Src);
  check('闸存在、判定函数只有一个定义（不在 ps1 里另写一套判据）',
    g.gate > 0 && g.defs === 1 && g.reDerives === false, JSON.stringify({ gate: g.gate, defs: g.defs, reDerives: g.reDerives }));
  check('★ 闸早于全文件**唯一**那处 archive 调用（挂错位置就等于没有）',
    g.archiveCall > g.gate, JSON.stringify({ gate: g.gate, archive: g.archiveCall }));
  check('（守卫）archive 仍然只有那一处（全文件只此一条归档路）',
    (ps1Src.match(/-CliArgs @\('archive'/g) ?? []).length === 1, String((ps1Src.match(/-CliArgs @\('archive'/g) ?? []).length));
  // ★ 2026-09-25 晚：「已授权归档」那一格的**搬运路**必须完整 —— 从 current 读出来 → 进快照 → 参与签名 → 交给拼字符串那支。
  //   少任何一环，那一格都会恒显示旧文案（而测试如果只看 Format-StepsField 是绿的 ⇒ 正好是"假绿灯"的形态）。
  const scanArmedPipe = (src) => ({
    read: /script:steps\.armed\s*=/.test(src) && /contains 'armed'/.test(src),
    snapshot: /\$armed = \[bool\]\$script:steps\.armed/.test(src),
    signature: /'#armed='/.test(src),
    render: /Format-StepsField \$Snap\.steps \$Snap\.turns \$Snap\.cost \$Snap\.armed/.test(src),
    // 兜底形状（现网 sessions[] 那条路）也要带 armed —— 只认 `[pscustomobject]@…armed = $armed }` 那一行，
    // 别认到别处的 `armed = $armed }`（Get-StatusSnapshot 的 hashtable 里也有同样一段，实测误命中过）。
    fallback: /\[pscustomobject\]@\{[^\n]*armed = \$armed \}/.test(src),
    reset: /script:steps\.armed = \$false/.test(src),
  });
  const armedPipe = scanArmedPipe(ps1Src);
  check('★ 「已授权归档」搬运链完整：current→字段→快照→签名→渲染（少一环那一格就恒显示旧文案）',
    Object.values(armedPipe).every(Boolean), JSON.stringify(armedPipe));
  // 灵敏度（逐环验，不是"改一处看看"）：**每一环**去掉都必须被这个检查器看见 —— 否则它就是个恒真的摆设。
  const armedBreaks = [
    ['渲染那一环少了 $Snap.armed', ps1Src.replace('Format-StepsField $Snap.steps $Snap.turns $Snap.cost $Snap.armed', 'Format-StepsField $Snap.steps $Snap.turns $Snap.cost')],
    ['签名不带 #armed=', ps1Src.replace("'#armed=' +", "'#nom=' +")],
    ['兜底形状不带 armed', ps1Src.replace('title = [string]$row.title; armed = $armed }', 'title = [string]$row.title }')],
  ];
  for (const [label, broken] of armedBreaks) {
    const p = scanArmedPipe(broken);
    check(`灵敏度：${label} ⇒ 检查器必须报红`, Object.values(p).some((v) => v === false), JSON.stringify(p));
  }
  check('整体判据 ok', g.ok);
  // 灵敏度：删掉闸那一行 ⇒ 检查器必须报红
  check('灵敏度：删掉闸 ⇒ 检查器报红',
    scanAKey(ps1Src.replace(/^\s*\$busyInfo = Get-SessionLineBusy \$cur.*$/m, '')).ok === false);

  // ② 真跑：抽真函数体 → 在 PowerShell 里执行 → 三态 + 灵敏度反例
  const driver = path.join(TMP, 'ps1-busy-probe.ps1');
  fs.writeFileSync(driver, [
    'param([string]$Ps1)',
    "$src = [System.IO.File]::ReadAllText($Ps1, [System.Text.Encoding]::UTF8)",
    '$tokens = $null; $errs = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errs)',
    "if ($errs -and $errs.Count -gt 0) { Write-Output ('SYNTAX BAD ' + $errs.Count); exit 2 }",
    "Write-Output 'SYNTAX OK'",
    'function Get-Body([string]$s) {',
    "  $start = $s.IndexOf('function Get-SessionLineBusy')",
    "  if ($start -lt 0) { return '' }",
    "  $i = $s.IndexOf('{', $start); $depth = 0; $end = -1",
    "  for ($j = $i; $j -lt $s.Length; $j++) { $c = $s[$j]; if ($c -eq '{') { $depth++ } elseif ($c -eq '}') { $depth--; if ($depth -eq 0) { $end = $j; break } } }",
    "  if ($end -lt 0) { return '' }",
    '  return $s.Substring($start, $end - $start + 1)',
    '}',
    'function Test-Body([string]$body) {',
    '  $n = 0; $bad = 0',
    '  Invoke-Expression $body | Out-Null',
    "  $cases = @(@{n='self';o=[pscustomobject]@{lineRunning=$true;running=$true;childRunning=0};w='busy'},",
    "             @{n='self+kids';o=[pscustomobject]@{lineRunning=$true;running=$true;childRunning=3};w='busy'},",
    "             @{n='kids';o=[pscustomobject]@{lineRunning=$true;running=$false;childRunning=2};w='busy'},",
    "             @{n='idle';o=[pscustomobject]@{lineRunning=$false;running=$false;childRunning=0};w='idle'},",
    "             @{n='oldidle';o=[pscustomobject]@{running=$false};w='unknown'},",
    "             @{n='oldbusy';o=[pscustomobject]@{running=$true};w='busy'},",
    "             @{n='none';o=[pscustomobject]@{id='x'};w='unknown'},",
    "             @{n='null';o=$null;w='unknown'})",
    '  foreach ($c in $cases) { $r = Get-SessionLineBusy $c.o; $n++; if ($r.state -ne $c.w) { $bad++; Write-Output (\"MISMATCH \" + $c.n + \" got=\" + $r.state + \" want=\" + $c.w) } }',
    '  return @{ n = $n; bad = $bad }',
    '}',
    '$body = Get-Body $src',
    "if (-not $body) { Write-Output 'BODY MISSING'; exit 3 }",
    "Write-Output ('BODY LEN ' + $body.Length)",
    '$real = Test-Body $body',
    "Write-Output ('REAL cases=' + $real.n + ' bad=' + $real.bad)",
    "$mutant = $body -replace \"'idle'\", \"'busy'\"",
    '$mut = Test-Body $mutant',
    "Write-Output ('MUTANT cases=' + $mut.n + ' bad=' + $mut.bad)",
  ].join('\n'), 'utf8');
  const outFile = path.join(TMP, 'ps1-busy-probe.out.txt');
  const fd = fs.openSync(outFile, 'w');
  let spawnErr = null;
  try {
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver, ps1Path], { stdio: ['ignore', fd, 'ignore'], windowsHide: true, timeout: 120000 });
    if (r.error) spawnErr = r.error;
  } finally { fs.closeSync(fd); }
  const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (spawnErr || !out.trim()) {
    console.log(`  ℹ️  跳过真跑那半：这台机器起不了 powershell.exe（${spawnErr?.message ?? '没有输出'}）—— 静态棘轮与主套件已覆盖`);
  } else {
    check('（守卫）真读到了 ps1 并抽出了那支判定函数（不是抄一份）', /SYNTAX OK/.test(out) && /BODY LEN \d+/.test(out), out.split('\n').slice(0, 3).join(' | '));
    check('★ 真跑判定：忙（自己/自己+子/只有子）⇒ busy；空闲 ⇒ idle；老工具/没有字段 ⇒ unknown',
      /REAL cases=8 bad=0/.test(out), out.trim().split('\n').filter((l) => /REAL|MISMATCH/.test(l)).join(' | '));
    check('★ 灵敏度反例：把函数体里"空闲"改判成"忙" ⇒ 检查器必须报红（不是恒真的摆设）',
      /MUTANT cases=8 bad=[1-9]/.test(out), out.trim().split('\n').filter((l) => /MUTANT/.test(l)).join(' | '));
  }
}

// ═══ 附加：窗口那一格写"已授权归档"（2026-09-25 晚，真跑那支拼字符串的函数）═══════════
// 主人原话：「我只要说了归档，你完成任务后自动归档就可以不用再问一次了」⇒ 已授权的会话，
// 那一格**不该**再劝他"按 a"（他会以为还得自己动手）。判据仍然是搬来的 current.armed。
section('附加：窗口那一格「已授权归档：跑完自动归档」（真跑 ps1 的 Format-StepsField）');
{
  const ps1Path = path.join(TOOLS, 'dsh-prompt.ps1');
  const driver = path.join(TMP, 'ps1-armed-cell.ps1');
  // ⚠ 这个 driver 里有中文（要断言中文文案）⇒ **必须写成 UTF-8 带 BOM**：PS 5.1 对无 BOM 的 UTF-8
  //   按 ANSI(GBK) 解码，中文会被吞成乱码、整个脚本 parse 不过（实测：`Unexpected token`，一条断言都跑不了）。
  //   这正是本工作区"中文 .ps1 一律带 BOM"那条铁律在测试里的同一面。老的 driver 全 ASCII 所以没踩到。
  const driverSrc = [
    'param([string]$Ps1)',
    "$src = [System.IO.File]::ReadAllText($Ps1, [System.Text.Encoding]::UTF8)",
    '$tokens = $null; $errs = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$tokens, [ref]$errs)',
    "if ($errs -and $errs.Count -gt 0) { Write-Output ('SYNTAX BAD ' + $errs.Count); exit 2 }",
    "Write-Output 'SYNTAX OK'",
    // 抽出三段真源码（Format-StepsCounts / Format-Cost / Format-StepsField）——**不是抄一份**
    'function Get-Fn([string]$s, [string]$name) {',
    "  $start = $s.IndexOf('function ' + $name)",
    "  if ($start -lt 0) { return '' }",
    "  $i = $s.IndexOf('{', $start); $depth = 0; $end = -1",
    "  for ($j = $i; $j -lt $s.Length; $j++) { $c = $s[$j]; if ($c -eq '{') { $depth++ } elseif ($c -eq '}') { $depth--; if ($depth -eq 0) { $end = $j; break } } }",
    "  if ($end -lt 0) { return '' }",
    '  return $s.Substring($start, $end - $start + 1)',
    '}',
    "$script:StepsWarnAt = 200",
    '$cost = Get-Fn $src "Format-Cost"',
    '$counts = Get-Fn $src "Format-StepsCounts"',
    '$field = Get-Fn $src "Format-StepsField"',
    "if (-not $cost -or -not $counts -or -not $field) { Write-Output 'BODY MISSING'; exit 3 }",
    "Write-Output ('BODY LEN ' + ($cost.Length + $counts.Length + $field.Length))",
    'Invoke-Expression $cost | Out-Null',
    'Invoke-Expression $counts | Out-Null',
    'Invoke-Expression $field | Out-Null',
    'function Test-Cells() {',
    '  $n = 0; $bad = 0',
    '  $cases = @(',
    "    @{n='armed-under-warn'; s=120; a=$true;  c='本对话 120 步 · 已授权归档：跑完自动归档'},",
    "    @{n='armed-over-warn';  s=260; a=$true;  c='本对话 260 步 · 已授权归档：跑完自动归档'},",
    "    @{n='not-armed-over';   s=260; a=$false; c='本对话 260 步 · 建议归档（按 a）'},",
    "    @{n='not-armed-under';  s=120; a=$false; c='本对话 120 步'})",
    '  foreach ($k in $cases) {',
    '    $got = Format-StepsField $k.s $null $null $k.a',
    '    $n++',
    "    if ($got -ne $k.c) { $bad++; Write-Output ('MISMATCH ' + $k.n + ' got=[' + $got + '] want=[' + $k.c + ']') }",
    '  }',
    '  return @{ n = $n; bad = $bad }',
    '}',
    'function Test-Mutant([string]$body) {',
    '  $n = 0; $bad = 0',
    '  Invoke-Expression $body | Out-Null',
    '  $cases = @(',
    "    @{n='armed-under-warn'; s=120; a=$true;  c='本对话 120 步 · 已授权归档：跑完自动归档'},",
    "    @{n='not-armed-over';   s=260; a=$false; c='本对话 260 步 · 建议归档（按 a）'})",
    '  foreach ($k in $cases) {',
    '    $got = Format-StepsField $k.s $null $null $k.a',
    '    $n++',
    "    if ($got -ne $k.c) { $bad++; Write-Output ('MISMATCH ' + $k.n + ' got=[' + $got + '] want=[' + $k.c + ']') }",
    '  }',
    '  return @{ n = $n; bad = $bad }',
    '}',
    '$real = Test-Cells',
    "Write-Output ('REAL cases=' + $real.n + ' bad=' + $real.bad)",
    // 突变：把"已授权优先"那一支短路掉（= 退回旧行为：只按步数劝他按 a）⇒ 必须报红
    "$mutant = $field -replace 'if \\(\\[bool\\]\\$Armed\\)', 'if ($false)'",
    '$mut = Test-Mutant $mutant',
    "Write-Output ('MUTANT cases=' + $mut.n + ' bad=' + $mut.bad)",
    // 突变②：把"建议归档"那一支也短路（= 那一格永远不劝）⇒ 未授权那条必须报红
    "$mutant2 = $field -replace 'if \\(\\[int\\]\\$Steps -ge \\$script:StepsWarnAt\\)', 'if ($false)'",
    '$mut2 = Test-Mutant $mutant2',
    "Write-Output ('MUTANT2 cases=' + $mut2.n + ' bad=' + $mut2.bad)",
  ].join('\n');
  fs.writeFileSync(driver, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(driverSrc, 'utf8')]));
  const outFile = path.join(TMP, 'ps1-armed-cell.out.txt');
  const fd = fs.openSync(outFile, 'w');
  let spawnErr = null;
  try {
    const r = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', driver, ps1Path], { stdio: ['ignore', fd, 'ignore'], windowsHide: true, timeout: 120000 });
    if (r.error) spawnErr = r.error;
  } finally { fs.closeSync(fd); }
  const out = fs.existsSync(outFile) ? fs.readFileSync(outFile, 'utf8') : '';
  if (spawnErr || !out.trim()) {
    console.log(`  ℹ️  跳过真跑那半：这台机器起不了 powershell.exe（${spawnErr?.message ?? '没有输出'}）`);
  } else {
    check('（守卫）真读到了 ps1 并抽出了那三段拼字符串的函数（不是抄一份）',
      /SYNTAX OK/.test(out) && /BODY LEN \d+/.test(out), out.split('\n').slice(0, 3).join(' | '));
    check('★ 真跑：已授权（armed）⇒ 那一格写「已授权归档：跑完自动归档」（步数再高也不劝他按 a）',
      /REAL cases=4 bad=0/.test(out), out.trim().split('\n').filter((l) => /REAL|MISMATCH/.test(l)).join(' | '));
    check('★ 突变自查：把"已授权优先"那一支短路 ⇒ 必须报红（那张网不是摆设）',
      /MUTANT cases=2 bad=[1-9]/.test(out), out.trim().split('\n').filter((l) => /MUTANT/.test(l)).join(' | '));
    check('★ 突变自查 ②：把"建议归档（按 a）"那一支短路 ⇒ 也必须报红（未授权那条会掉字）',
      /MUTANT2 cases=2 bad=[1-9]/.test(out), out.trim().split('\n').filter((l) => /MUTANT2/.test(l)).join(' | '));
  }
}

// ═══ 附加：archive / new 的调用形状（假 api，不碰真会话）═══════════════════
section('附加：archive / new 的调用形状与"绝不猜 id"');
{
  const notGiven = sessions.resolveTarget('', [rowOf(ID_A, 10)]);
  check('archive 不显式给 id ⇒ 报用法、绝不猜', notGiven.ok === false && /显式给会话 id/.test(notGiven.error));
  const vague = sessions.resolveTarget('session-', [rowOf(ID_A, 10), rowOf(ID_B, 20)]);
  check('前缀不唯一 ⇒ 不猜（列出来让人写全）', vague.ok === false && vague.matches.length === 2, JSON.stringify(vague.error));
  const unique = sessions.resolveTarget(ID_A.slice(0, 20), [rowOf(ID_A, 10), rowOf(ID_B, 20)]);
  check('唯一前缀 ⇒ 命中那一条', unique.ok === true && unique.row.id === ID_A);

  const api = fakeApi({});
  const archF = path.join(TMP, 'arch-local.json');
  const wsF2 = path.join(TMP, 'ws2.json');
  // ★ 2026-09-25（执行线 5758ba91，小镜复核启动器时撞到的那条脆弱断言）：原来的守卫判的是
  //   「生产名单**不存在**」⇒ 只要**真归档过一次**（归档是完全正常的操作：13:24 归档 d9078911、
  //   13:44 归档探针会话）这条就**永久红**，而且它红的原因与"这次调用有没有越界写"**毫无关系**。
  //   真正的守卫 = 「**我们这几次调用没有改动**生产名单」—— 与它存不存在无关 ⇒ 改成前后逐字节比对
  //   （不存在也算一种状态，同样要比）。⚠ 绝不删那个生产文件：它是归档护栏的名单，删了等于削弱护栏。
  const prodArch = path.join(ROOT, 'qq-bridge', 'state', 'archived-sessions.json');
  const prodBefore = fs.existsSync(prodArch) ? fs.readFileSync(prodArch, 'utf8') : null;
  fs.writeFileSync(wsF2, JSON.stringify({ global: { archivedSessionIds: [] } }));
  const res = await sessions.runArchive({ api, sessionId: ID_A, title: '测试用', archivedFile: archF, workspaceFile: wsF2, ttlMs: 0 });
  check('archive 调了 api.workspace.archiveSession({sessionId})', api.calls.archive.length === 1 && api.calls.archive[0].sessionId === ID_A, JSON.stringify(api.calls.archive));
  check('archive 登记了本地名单（原子写）', JSON.parse(fs.readFileSync(archF, 'utf8'))?.ids?.[ID_A]?.title === '测试用');
  {
    const prodAfter = fs.existsSync(prodArch) ? fs.readFileSync(prodArch, 'utf8') : null;
    check('（守卫）archive 没碰生产名单（前后逐字节相同；不存在也算相同）', prodAfter === prodBefore,
      `前 ${prodBefore === null ? '不存在' : `${prodBefore.length} B`} / 后 ${prodAfter === null ? '不存在' : `${prodAfter.length} B`}`);
  }
  const twice = await sessions.runArchive({ api, sessionId: ID_A, archivedFile: archF, workspaceFile: wsF2, ttlMs: 0 });
  check('已归档的再归档 ⇒ 幂等，不再调 API', twice.alreadyArchived === true && api.calls.archive.length === 1);

  const noPreset = await sessions.runNew({ api, cwd: ROOT });
  check('new 不给 preset ⇒ **不传** agentPreset', !('agentPreset' in noPreset.params), JSON.stringify(noPreset.params));
  check('new 的调用形状：workspace/create({path}) → session/create({workspaceId})', api.calls.workspaceCreate[0]?.path === ROOT && api.calls.sessionCreate[0]?.workspaceId === 'ws-0001', JSON.stringify(api.calls.sessionCreate));
  check('new 返回新 sessionId', /^session-/.test(noPreset.sessionId ?? ''), noPreset.sessionId);
  const withPreset = await sessions.runNew({ api, cwd: ROOT, preset: 'qq-chat-v2' });
  check('给了 --preset 才传 agentPreset', withPreset.params.agentPreset === 'qq-chat-v2');
}

// ═══ 回归：真 CLI 的契约（"测试全绿、真实路径全瞎"那种最贵的假绿灯）═════════
section('回归：真 CLI 读得到真步数（原始清单 ⇄ 已 parse 行 的契约错配）');
{
  // 2026-09-25 真踩的坑：CLI 的 listSessions() 返回**已 parse 的行**，runNudge 里又 parse 一次
  // ⇒ 步数全 null ⇒ nudge 永远不触发。下面两条把两条输入路都钉死。
  const envelope = { items: [rowOf(ID_A, 321), { sessionId: ID_B, projections: { values: { sessionStats: { steps: 88 } } } }] };
  const parsed = sessions.parseSessionRows(envelope);
  const rawState = path.join(TMP, 'contract-raw.json');
  const parsedState = path.join(TMP, 'contract-parsed.json');
  const r1 = await sessions.runNudge({ list: async () => envelope, stateFile: rawState, now: Date.now() });
  check('喂**原始信封** ⇒ 读到步数并到档（321 步 = 先提醒）', r1.sends.length === 1 && r1.sends[0].steps === 321, JSON.stringify(r1.sends));
  check('（守卫）stepsUnknown = 0（不是"读不到所以不发"）', r1.stepsUnknown === 0 && r1.stepsKnown === 2, `known=${r1.stepsKnown}/${r1.total}`);
  const r2 = await sessions.runNudge({ list: async () => parsed, stateFile: parsedState, now: Date.now() });
  check('喂**已 parse 的行**（幂等）⇒ 一样读到步数', r2.sends.length === 1 && r2.sends[0].steps === 321, JSON.stringify(r2.sends));
  check('（守卫）幂等路 stepsUnknown = 0', r2.stepsUnknown === 0, `unknown=${r2.stepsUnknown}`);
  check('两次 parse 结果一致（幂等）', JSON.stringify(sessions.parseSessionRows(parsed)) === JSON.stringify(parsed));

  // ★ 真路径：跑真 CLI（只读 + --dry-run，不写任何 state、不连数据库以外的东西）
  const seq = { n: 0 };
  const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-cli-'));
  const runCli = (args) => {
    const outFile = path.join(SCRATCH, `cli-${++seq.n}.txt`);
    const fd = fs.openSync(outFile, 'w');
    try {
      // ⚠ 沙箱禁止管道 stdio ⇒ 把子进程输出重定向到文件（不是 pipe）
      const r = spawnSync(process.execPath, [path.join(TOOLS, 'sessions.mjs'), ...args], { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
      if (r.error) throw r.error;
      return { code: r.status, text: fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, '') };
    } finally { fs.closeSync(fd); }
  };
  const parseJson = (text) => { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return null; } };
  const status = runCli(['status', '--json']);
  const statusJson = parseJson(status.text);
  if (status.code !== 0 || !statusJson) {
    console.log(`  ℹ️  跳过真 CLI 断言：DSH 这次没答（status exit=${status.code}）—— 离线部分已覆盖，真实路径下轮再跑`);
  } else {
    check('★ 真 CLI `status --json` 退出码 = 0（重定向到文件，没有 libuv 断言把它变成 1）', status.code === 0, `code=${status.code}`);
    check('（守卫）真读到会话清单', statusJson.total > 0, `total=${statusJson.total}`);
    const cur = statusJson.sessions.find((s) => s.id === statusJson.currentSessionId);
    check('★ 当前会话（主人的那条）能读到**真实步数**（不是 null）', Number.isFinite(cur?.steps), `steps=${cur?.steps}`);
    check('当前会话不是子代理、也不是桥接建的', cur && !cur.subagent && cur.bridge !== true && statusJson.candidates >= 1, JSON.stringify({ sub: Boolean(cur?.subagent), bridge: cur?.bridge, candidates: statusJson.candidates }));

    const nudge = runCli(['nudge', '--dry-run', '--json']);
    const nj = parseJson(nudge.text);
    check('★ 真 CLI `nudge --dry-run --json` 退出码 = 0', nudge.code === 0, `code=${nudge.code}`);
    check('（守卫）真读到清单（total > 0）', (nj?.total ?? 0) > 0, `total=${nj?.total}`);
    check('★ 读不到步数的行只是极少数（契约错配时这里会是"全部"）', nj && nj.stepsUnknown <= Math.max(1, Math.floor(nj.total * 0.1)), `unknown=${nj?.stepsUnknown}/${nj?.total}`);
    // ⚠ 这段 2026-09-25 假红过一次，写法记在这里：原来断言"当前会话**不能出现在 skipped 里**"，
    //   但窗口那路（tools\dsh-prompt.ps1）会**真跑 nudge 并落盘** ⇒ 主人的会话带着
    //   `强提醒已发过` 出现在 skipped 里就被判红 —— 而"已发过/已退役"是**设计好的跳过**，不是失败。
    //   本意是防 12.4-12 那个契约错配（步数读不到）⇒ 只按 **reason 含 steps-unknown** 判红。
    const hasStepsUnknownSkip = (res, id) => (res?.skipped ?? []).some((s) => s.sessionId === id && /steps-unknown/.test(s.reason ?? ''));
    check('★ 当前会话不得以 steps-unknown 出现在 skipped 里（"已发过/已退役"被跳过是设计好的，不算失败）',
      nj && !hasStepsUnknownSkip(nj, statusJson.currentSessionId), JSON.stringify((nj?.skipped ?? []).slice(0, 3)));
    check('（灵敏度反例）人造一条 steps-unknown 的 skipped ⇒ 这条判据必须报红（假绿自查）',
      hasStepsUnknownSkip({ skipped: [{ sessionId: 'session-x', reason: 'steps-unknown（读不到步数，不猜）' }] }, 'session-x') === true);
    check('（灵敏度反例 ②）同一条被"已发过"跳过 ⇒ 不该报红', hasStepsUnknownSkip({ skipped: [{ sessionId: 'session-x', reason: '强提醒已发过' }] }, 'session-x') === false);
    // ⚠ 这里**不能**断言"生产状态文件不存在"：窗口那路（tools\dsh-prompt.ps1）会真跑 `nudge` 并落盘
    //   （那是设计好的集成）。正确的判法是"这次 --dry-run **没有改动**它"。
    const prodStat = (() => { try { const s = fs.statSync(sessions.NUDGE_FILE); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } })();
    const nj2 = parseJson(runCli(['nudge', '--dry-run', '--json']).text);
    const prodStat2 = (() => { try { const s = fs.statSync(sessions.NUDGE_FILE); return `${s.size}:${s.mtimeMs}`; } catch { return 'absent'; } })();
    check('--dry-run 不写状态：wrote=false，且**没有改动**生产状态文件（窗口那路在真跑它，所以不能要求"文件不在"）',
      nj?.wrote === false && nj?.dryRun === true && prodStat === prodStat2, `${prodStat} → ${prodStat2}`);
    check('（守卫）--dry-run 仍然产出了该有的提醒（否则"没写"没有说服力）', (nj2?.due === true) === ((nj2?.sends ?? []).length > 0) && (nj2?.total ?? 0) > 0, `due=${nj2?.due} total=${nj2?.total}`);
    check('--json 不把 100 条 steps-unknown 倒出来（明细里没有它，只在 skippedCounts 汇总）',
      (nj?.skipped ?? []).every((s) => !s.reason.startsWith('steps-unknown')) && typeof nj?.skippedCounts === 'object');

    // ── `--json` 契约（窗口那路 tools\dsh-prompt.ps1 按它取字段）：只增不删 ──
    check('契约：status --json 有 ok:true 与 current 对象（旧字段 total/currentSessionId/sessions 都还在）',
      statusJson.ok === true && statusJson.current && typeof statusJson.current === 'object'
      && typeof statusJson.total === 'number' && 'currentSessionId' in statusJson && Array.isArray(statusJson.sessions));
    const c = statusJson.current ?? {};
    check('契约：current 字段齐（id/shortId/steps/turns/tokens/cost/running/title/preset）',
      ['id', 'shortId', 'steps', 'turns', 'tokens', 'cost', 'running', 'title', 'preset'].every((k) => k in c), JSON.stringify(c));
    // ★ 2026-09-25 追加的三个字段（窗口 a 键的软闸按它们判，**不在 ps1 里另写一套判据**）：只增不删。
    check('契约：current 带「这条线忙不忙」三个字段（childRunning / childRunningUnknown / lineRunning，布尔与数都不许是字符串）',
      ['childRunning', 'childRunningUnknown', 'lineRunning'].every((k) => k in c)
      && typeof c.lineRunning === 'boolean' && Number.isFinite(c.childRunning) && Number.isFinite(c.childRunningUnknown),
      JSON.stringify({ childRunning: c.childRunning, unknown: c.childRunningUnknown, lineRunning: c.lineRunning }));
    check('契约：current.lineRunning 与 running/childRunning 自洽（= 自己跑着 或 有子在跑）',
      c.lineRunning === (c.running === true || c.childRunning > 0), JSON.stringify({ running: c.running, kids: c.childRunning, line: c.lineRunning }));
    check('契约：current.turns 要么是真轮数（≥1）要么 null —— 不许填 0', c.turns === null || (Number.isFinite(c.turns) && c.turns >= 1), `turns=${JSON.stringify(c.turns)}`);
    check('契约：current.tokens/cost 在真数据里读得到（total = 四桶之和）',
      c.tokens && c.tokens.total === c.tokens.uncached + c.tokens.cacheWrite + c.tokens.cacheRead + c.tokens.output && Number.isFinite(c.cost), JSON.stringify({ tokens: c.tokens, cost: c.cost }));
    check('契约：current 带相对判据四个数 + 「这条线」三个数',
      ['perStepCtx', 'perStepTask', 'paidForLength', 'freshCost', 'ratio', 'childCount', 'childCost', 'lineCost'].every((k) => k in c), JSON.stringify(c));
    // ★ 2026-09-25 晚追加的字段（窗口那一格按它写"已授权归档：跑完自动归档"）：只增不删，必须是布尔。
    check('契约：current.armed 是布尔（「已授权归档」那个字段，窗口 ps1 只搬运它、不自己判）',
      typeof c.armed === 'boolean', `armed=${JSON.stringify(c.armed)}`);
    check('契约：sessions[] 每行也带 armed（只增不删；排查时能一眼看出哪条已授权）',
      statusJson.sessions.every((s) => typeof s.armed === 'boolean'));
    // ⚠ 这条 2026-09-25 假红过一次，写法记在这里：原来断言"**本会话** childCount > 0"，
    //   可"当前会话有没有子任务"取决于**跑测试的人此刻手上派了几个子代理** —— 一条刚开的新会话
    //   （0 个子任务）跑这套必然红，而上一轮是绿的（那条会话手上有 8 个子代理）⇒ 纯环境依赖的假红。
    //   本意是防"接线断了、真数据里子任务的钱看不见" ⇒ 拆成两条：① 恒等式对**当前会话**（任何环境下都可证）；
    //   ② 真数据那半改成**全库取样**：真库里哪些行带子任务，就对哪些行断言 lineCost > cost。
    //   真库一条带子任务的都没有时**不判绿也不判红**，只出声说明（同上面真 CLI 那段的写法；纯函数
    //   §子任务的钱 已覆盖 0/有/缺 id 三种情形）。
    check('契约：current 的 lineCost 恒等于 自己 + 子任务（且 ≥ 自己）—— 这条任何环境下都可证',
      Number.isFinite(c.lineCost) && Number.isFinite(c.cost) && Number.isFinite(c.childCost)
      && Math.abs(c.lineCost - (c.cost + c.childCost)) < 1e-9 && c.lineCost >= c.cost,
      JSON.stringify({ cost: c.cost, childCount: c.childCount, childCost: c.childCost, lineCost: c.lineCost }));
    const withKids = statusJson.sessions.filter((s) => (s.childCount ?? 0) > 0);
    if (withKids.length > 0) {
      check('★ 真数据：真库里带子任务的会话 ⇒ lineCost > cost（子任务的钱被看见）+ 占比算得出来',
        withKids.every((s) => Number.isFinite(s.lineCost) && s.lineCost > s.cost && (s.childCost ?? 0) > 0),
        JSON.stringify(withKids.slice(0, 3).map((s) => ({ id: String(s.id).slice(0, 16), cost: s.cost, kids: s.childCount, childCost: s.childCost, lineCost: s.lineCost }))));
    } else {
      console.log('  ℹ️  真数据那半这轮没有样本：真库里没有带子任务的会话（纯函数 §子任务的钱 已覆盖）');
    }
    console.log(`  ℹ️  真数据核对：带子任务的会话 ${withKids.length} 条｜本会话这条线：自己 ¥${(c.cost ?? 0).toFixed(2)} + ${c.childCount} 个子任务 ¥${(c.childCost ?? 0).toFixed(2)} = ¥${(c.lineCost ?? 0).toFixed(2)}`);
    check('契约：sessions[] 每行都带 tokens / cost（缺失为 null，不是 0）',
      statusJson.sessions.every((s) => 'tokens' in s && 'cost' in s && (s.cost === null || Number.isFinite(s.cost))));
    check('契约：status 的排序 = 花费降序（同额按步数降序）',
      statusJson.sessions.every((s, i, arr) => i === 0 || ((arr[i - 1].cost ?? -1) > (s.cost ?? -1)) || ((arr[i - 1].cost ?? -1) === (s.cost ?? -1) && (arr[i - 1].steps ?? -1) >= (s.steps ?? -1))));
    check('契约：current 与 sessions[] 里那行一致（三层排除判据同一份）', c.id === statusJson.currentSessionId && c.steps === cur?.steps && c.shortId === String(c.id).replace(/^session-/, '').slice(0, 8), JSON.stringify({ c: c.steps, row: cur?.steps }));
    check('契约：nudge --json 有 ok:true / due / sends[i] 全字段',
      nj?.ok === true && typeof nj?.due === 'boolean'
      && (nj.sends ?? []).every((s) => ['tier', 'tierLabel', 'sessionId', 'shortId', 'steps', 'turns', 'cost', 'tokens', 'trigger', 'triggers', 'text',
        'perStepCtx', 'perStepTask', 'paidForLength', 'freshCost', 'ratio', 'childCount', 'childCost', 'lineCost',
        'childRunning', 'lineRunning'].every((k) => k in s)),
      JSON.stringify((nj?.sends ?? []).map((s) => Object.keys(s))));
    // ★ 提问闸的产物（只增不删）：`deferred[]` 永远在（空数组 = 这一轮没人被延后）。
    check('契约：nudge --json 带 deferred[]（忙的时候如实报出来，不是静默丢掉）',
      Array.isArray(nj?.deferred)
      && (nj?.deferred ?? []).every((d) => ['sessionId', 'shortId', 'why', 'selfRunning', 'childRunning', 'steps', 'tier', 'text'].every((k) => k in d)),
      JSON.stringify(nj?.deferred));
    check('契约：deferred 里**不许**混进 sends（延后的就是没发，两边不重叠）',
      (nj?.deferred ?? []).every((d) => !(nj?.sends ?? []).some((s) => s.sessionId === d.sessionId)),
      JSON.stringify({ deferred: (nj?.deferred ?? []).map((d) => d.shortId), sends: (nj?.sends ?? []).map((s) => s.shortId) }));
    check('契约：sends[i].trigger 由命中的判据用 + 连起来（ratio/steps/cost 任意组合）',
      (nj?.sends ?? []).every((s) => /^(ratio|steps|cost)(\+(ratio|steps|cost))*$/.test(s.trigger) && Array.isArray(s.triggers)),
      JSON.stringify((nj?.sends ?? []).map((s) => s.trigger)));
    check('★ 真数据：sends[i] 带真实金额（>0），且文案里有"¥"', (nj?.sends ?? []).every((s) => s.cost > 0 && /¥/.test(s.text)), JSON.stringify((nj?.sends ?? []).map((s) => ({ id: s.shortId, cost: s.cost, text: s.text.slice(0, 40) }))));
    check('契约：due 与 sends 一致', nj?.due === ((nj?.sends ?? []).length > 0), `due=${nj?.due} sends=${nj?.sends?.length}`);

    // ★ 候选集收窄的真数据核对：sends 里**不许**出现子代理会话或 QQ/桥接建的会话
    const byId = new Map(statusJson.sessions.map((s) => [s.id, s]));
    const badSends = (nj?.sends ?? []).filter((s) => { const row = byId.get(s.sessionId); return !row || row.subagent || row.bridge === true; });
    check('★ 真数据：sends 里没有子代理会话、也没有 QQ/桥接建的会话', badSends.length === 0, JSON.stringify(badSends.map((s) => s.shortId)));
    console.log(`  ℹ️  真数据核对：全库 ${statusJson.total} 条，到档 ${(nj?.sends ?? []).length} 条 → ${(nj?.sends ?? []).map((s) => `${s.shortId}(${s.steps}步/${s.turns ?? '?'}轮)`).join('、') || '（无）'}｜当前会话 ${c.shortId ?? '?'}(${c.steps}步/${c.turns ?? '?'}轮)`);

    // archive 的 --json：**不加 --yes = 预览**（只读，不真归档），正好用来核契约
    const prev = runCli(['archive', statusJson.currentSessionId, '--json']);
    const pj = parseJson(prev.text);
    check('★ 真 CLI `archive <当前会话> --json`（不加 --yes）⇒ 预览、没真归档', prev.code === 0 && pj?.preview === true && pj?.archived === null && pj?.ok === true, JSON.stringify(pj));
    check('契约：archive 预览 JSON 有 shortId / steps / alreadyArchived', typeof pj?.shortId === 'string' && Number.isFinite(pj?.steps) && pj?.alreadyArchived === false, JSON.stringify(pj));
    const bogus = runCli(['archive', 'session-00000000-0000-4000-8000-000000000000', '--json']);
    check('契约：archive 失败 ⇒ ok:false + error（退出码 1）', bogus.code === 1 && parseJson(bogus.text)?.ok === false && Boolean(parseJson(bogus.text)?.error), `code=${bogus.code} ${bogus.text.slice(0, 80)}`);
    // new 的 --json 形状没法真跑（**不许真新建会话**）⇒ 静态棘轮钉契约字段
    const src = fs.readFileSync(path.join(TOOLS, 'sessions.mjs'), 'utf8');
    check('契约（静态棘轮）：new --json 带 ok + shortId（不能真跑 --yes/新建）', /ok:\s*true,\s*\.\.\.res,\s*shortId:\s*shortId\(res\.sessionId\)/.test(src));
    check('契约（静态棘轮）：archive/new 失败分支都带 ok:false + error', (src.match(/ok:\s*false/g) ?? []).length >= 3, String((src.match(/ok:\s*false/g) ?? []).length));
  }
  try { fs.rmSync(SCRATCH, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
}

// ═══ 边界：本测试只写 %TEMP%；生产 state 里不许出现本测试的假 id ═══════════
section('边界：全程只写 %TEMP%，生产 state 里没有本测试的痕迹');
// ⚠ 不能断言"生产 state 快照前后一致"：窗口那路（tools\dsh-prompt.ps1）会**真跑** nudge 并落盘，
//   那是设计好的集成 ⇒ 快照变化可能来自外部。真正该钉的是"**我们**没写进去"：本测试用的假 id
//   一个都不许出现在生产 state 里（本测试的写入全在 %TEMP%）。
const prodNow = snapProd();
if (prodNow !== prodBefore) console.log(`  ℹ️  生产 state 在测试期间被**外部**改过（窗口在轮询 nudge，属预期）：\n      ${prodBefore}\n   →  ${prodNow}`);
const fakeIds = [ID_A, ID_B, ID_C];
const prodText = PROD.map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
check('（守卫）本测试的假会话 id 没出现在生产 state（session-nudge / archived-sessions）里',
  fakeIds.every((id) => !prodText.includes(id)), fakeIds.filter((id) => prodText.includes(id)).join('、'));
check('（守卫）临时目录确实用过（不是空跑）', fs.existsSync(TMP) && fs.readdirSync(TMP).length > 0, TMP);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 尽力而为 */ }

console.log(`\n${'='.repeat(52)}\n结果：${pass} 通过，${fail} 失败`);
if (failures.length) console.log('失败项：\n  - ' + failures.join('\n  - '));
process.exitCode = fail ? 1 : 0;
