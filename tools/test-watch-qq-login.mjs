// ============================================================================
// tools/test-watch-qq-login.mjs —— watch-qq-login.mjs 的回归网
//
// 判据（协调线 2026-09-26 点名的四条 + 我加的几条）：
//   ① 连续 N 次异常才算掉线（抖一下不报）
//   ② 边沿触发：同一状态**不重复发**
//   ③ 发送失败 ⇒ 记 failed + **有限次**重试（不无限重试、不静默吞）
//   ④ 恢复 ⇒ 发一条
//   ⑤ **这一路不许走 QQ**（源码棘轮：不许出现 send_private_msg / qq-notify 之类）
//   ⑥ 两个通道各自的"受理"判据（Bark 2xx / Server酱 code=0）+ URL 形状
//   ⑦ 文案不声称"他看到了"
//   ⑧ 没配 key ⇒ 仍然记日志（不静默吞）
//   ⑨ DRY_RUN ⇒ 一条都不真发
//
// ★ 全程**注入打桩**：`fetchImpl` 是假的 ⇒ 一个字节都不出网、**绝不真发**。
//   跑法：node tools\test-watch-qq-login.mjs     （不需要任何 key、不连网、不起服务）
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildMessage, notify, nextState, resolveChannel, runOnce } from './watch-qq-login.mjs';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; failures.push(name); console.log('❌ ' + name + (detail ? '  ← ' + detail : '')); }
}
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-qq-'));
let seq = 0;
const freshEnv = (over = {}) => {
  const tag = `n${++seq}`;
  return {
    WATCH_QQ_LOG: path.join(DIR, `${tag}.jsonl`),
    WATCH_QQ_STATE: path.join(DIR, `${tag}.state.json`),
    WATCH_QQ_CHANNEL: 'bark',
    WATCH_QQ_BARK_KEY: 'test-key-not-real',
    WATCH_QQ_RETRY_DELAY_MS: '1',
    ...over,
  };
};
const API = { baseHttp: 'http://127.0.0.1:3000', accessToken: 'test-token', timeoutMs: 1000 };  // port-literal-ok: 假样本 URL 的一部分，测试从不连它
const ONLINE = { json: { status: 'ok', retcode: 0, data: { nickname: '测试机器人' } } };
const OFFLINE = { ok: false, status: 502 };
const logLines = (p) => { try { return fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } };
/** 按 URL 路由的假网络层：get_login_info 走 samples，通知走 notify 队列 */
function fakeNet({ samples = [], notify: notifies = [] } = {}) {
  const calls = { sample: [], notify: [] };
  const mk = (s) => {
    if (s && s.throw) throw new Error(s.throw);
    const status = s?.status ?? 200;
    const body = s?.json ?? (s?.kind === 'online' ? ONLINE.json : {});
    return { ok: s?.ok ?? (status >= 200 && status < 300), status, json: async () => body };
  };
  const f = async (url, init) => {
    if (String(url).includes('get_login_info')) { calls.sample.push(url); return mk(samples.shift() ?? ONLINE); }
    calls.notify.push({ url, init });
    return mk(notifies.shift() ?? { json: { code: 0 } });
  };
  f.calls = calls;
  return f;
}
const run = (env, net) => runOnce({ env, fetchImpl: net, api: API, paths: { log: env.WATCH_QQ_LOG, state: env.WATCH_QQ_STATE }, sleep: async () => {} });

// ── ①②④ 连续两次才判 / 边沿不重复 / 恢复发一条 ─────────────────────────────
console.log('\n① 连续 N 次才判 · ② 边沿触发不重复发 · ④ 恢复发一条');
{
  const env = freshEnv();
  const net = fakeNet({ samples: [OFFLINE, OFFLINE, OFFLINE, ONLINE, ONLINE] });
  const r1 = await run(env, net);
  check('① 第 1 次异常：还没到 2 次 ⇒ 不判掉线、不发任何东西', r1.state !== 'offline' && !r1.notified && net.calls.notify.length === 0, JSON.stringify(r1.state));
  check('① 状态文件记下了连击数（重启不丢）', logLines(env.WATCH_QQ_LOG).some((l) => l.kind === 'sample' && l.badStreak === 1));
  const r2 = await run(env, net);
  check('① 第 2 次异常 ⇒ 判掉线并发一条', r2.state === 'offline' && r2.flip === true && net.calls.notify.length === 1, `state=${r2.state} notify=${net.calls.notify.length}`);
  const r3 = await run(env, net);
  check('② 还掉着 ⇒ **不重复发**（同一个状态只发一次）', r3.flip === false && net.calls.notify.length === 1, `flip=${r3.flip} notify=${net.calls.notify.length}`);
  const r4 = await run(env, net);
  check('④ 第 1 次正常：还没到 2 次 ⇒ 不判恢复', r4.flip === false && net.calls.notify.length === 1);
  const r5 = await run(env, net);
  check('④ 第 2 次正常 ⇒ 判恢复并发一条', r5.state === 'online' && r5.flip === true && net.calls.notify.length === 2, `state=${r5.state} notify=${net.calls.notify.length}`);
  check('④ 恢复那条文案说的是"已恢复"', String(net.calls.notify[1]?.url ?? '').includes(encodeURIComponent('✅ QQ 已恢复')));
}

// ── ③ 失败 ⇒ failed + 有限重试 ──────────────────────────────────────────────
console.log('\n③ 发不出去：记 failed + 有限次重试（不无限、不静默吞）');
{
  const env = freshEnv({ WATCH_QQ_RETRY_N: '2' });   // 总共 1+2 = 3 次
  const net = fakeNet({ samples: [OFFLINE, OFFLINE], notify: [{ throw: 'ECONNRESET' }, { ok: false, status: 500 }, { ok: false, status: 500 }] });
  await run(env, net);
  const r = await run(env, net);
  check('③ 尝试次数 = 1 + RETRY_N（这里是 3）', net.calls.notify.length === 3, `实际 ${net.calls.notify.length}`);
  check('③ 最终如实报失败（ok=false，不假装成功）', r.notified?.ok === false && r.notified?.attempts === 3, JSON.stringify(r.notified));
  const lines = logLines(env.WATCH_QQ_LOG);
  check('③ 每一次尝试都留痕（3 条 notify 行，attempt 1..3）', lines.filter((l) => l.kind === 'notify').length === 3);
  check('③ 失败本身也落一行 alert（**不静默吞**：他要能从日志里看出"没发出去"）',
    lines.some((l) => l.kind === 'alert' && l.ok === false), JSON.stringify(lines.filter((l) => l.kind === 'alert')));
}

// ── ⑤ 不走 QQ（源码棘轮）────────────────────────────────────────────────────
console.log('\n⑤ 硬约束：这一路绝不许走 QQ');
{
  const src = fs.readFileSync(new URL('./watch-qq-login.mjs', import.meta.url), 'utf8');
  check('⑤ 源码里没有 QQ 发送类调用（send_private_msg / send_msg / qq-notify / Send-OwnerQqNotice）',
    !/send_private_msg|send_msg|qq-notify|Send-OwnerQqNotice|send_group_msg/.test(src));
  const hosts = [...src.matchAll(/https?:\/\/([A-Za-z0-9.\-]+)/g)].map((m) => m[1]);
  const allowed = new Set(['api.day.app', 'sctapi.ftqq.com']);
  check('⑤ 出网地址只有 Bark / Server酱两家（其余一律本地回环）',
    hosts.every((h) => allowed.has(h) || h === '127.0.0.1'), hosts.join(','));
  check('⑤ 注释里写清了"不许走 QQ"这条硬约束（给下一个人）', /这一路绝不许走 QQ|不许走 QQ/.test(src));
  // ★ 小镜 2026-09-26 指出的棘轮缺口：上面那条是**字面量扫描** ⇒ 把 host 改成变量
  //   （`https://${process.env.WATCH_QQ_HOST}/…`）它照样全绿。补三条**肯定式**断言。
  check('⑤b 肯定式：两个 host 常量**逐字**等于那两家（改成变量 / 换别家 ⇒ 必红）',
    /const BARK_HOST = 'https:\/\/api\.day\.app\/'/.test(src) && /const SERVERCHAN_HOST = 'https:\/\/sctapi\.ftqq\.com\/'/.test(src));
  check('⑤c 肯定式：两条通知 URL **只由 host 常量拼出来**（不许把 host 放进变量或模板）',
    /const url = BARK_HOST \+ encodeURIComponent\(key\)/.test(src) && /const url = SERVERCHAN_HOST \+ encodeURIComponent\(key\)/.test(src));
  check('⑤d host 常量那一行里不许出现模板/插值（反引号或 ${…}）',
    (() => { const ls = src.match(/const (?:BARK_HOST|SERVERCHAN_HOST) = [^\n]+/g) || []; return ls.length === 2 && ls.every((l) => !l.includes('`') && !l.includes('${')); })());
  // ★★ 变异自检（小镜 2026-09-26 的要求：证明上面几条**不是恒真**）——
  //    把上面那三条判据**作用在变异后的源码文本上**，断言它们必须给出"红"：
  //    只读文本、不落地任何文件 ⇒ 比"临时改真文件再还原"这条路安全得多（那种做法第一版就翻过车）。
  const mutHost = src.replace("const BARK_HOST = 'https://api.day.app/';", 'const BARK_HOST = `https://${process.env.WATCH_QQ_HOST}/`;');
  check('⑤e 变异自检：host 常量被改成环境变量模板 ⇒ ⑤b 与 ⑤d 的判据必须为假',
    mutHost !== src
    && !/const BARK_HOST = 'https:\/\/api\.day\.app\/'/.test(mutHost)
    && !(() => { const ls = mutHost.match(/const (?:BARK_HOST|SERVERCHAN_HOST) = [^\n]+/g) || []; return ls.length === 2 && ls.every((l) => !l.includes('`') && !l.includes('${')); })());
  const mutUrl = src.replace('const url = BARK_HOST + encodeURIComponent(key)', 'const url = `${process.env.WATCH_QQ_HOST}/` + encodeURIComponent(key)');
  check('⑤f 变异自检：URL 改成"模板拼 host" ⇒ ⑤c 的判据必须为假',
    mutUrl !== src && !/const url = BARK_HOST \+ encodeURIComponent\(key\)/.test(mutUrl));
}

// ── ⑥ 两个通道的受理判据 ────────────────────────────────────────────────────
console.log('\n⑥ 通道受理判据：Bark 2xx / Server酱 code=0');
{
  const barkCall = [];
  const okBark = await notify('offline', { title: 'T', body: 'B' }, { channel: 'bark', key: 'K1', fetchImpl: async (url) => { barkCall.push(url); return { ok: true, status: 200, json: async () => ({}) }; }, log: () => {} });
  check('⑥ Bark：2xx ⇒ 受理；URL 形状对（api.day.app/<key>/<title>/<body> 且转义）',
    okBark.ok && barkCall[0] === `https://api.day.app/K1/${encodeURIComponent('T')}/${encodeURIComponent('B')}`, barkCall[0]);
  const badBark = await notify('offline', { title: 'T', body: 'B' }, { channel: 'bark', key: 'K1', retryN: 0, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }), log: () => {} });
  check('⑥ Bark：非 2xx ⇒ 不受理（如实失败，不假装）', badBark.ok === false && badBark.code === '403');
  const scCall = [];
  const okSc = await notify('offline', { title: 'T', body: 'B' }, { channel: 'serverchan', key: 'S1', fetchImpl: async (url) => { scCall.push(url); return { ok: true, status: 200, json: async () => ({ code: 0 }) }; }, log: () => {} });
  check('⑥ Server酱：code=0 ⇒ 受理；URL 形状对（sctapi.ftqq.com/<key>.send?title=&desp=）',
    okSc.ok && scCall[0].startsWith('https://sctapi.ftqq.com/S1.send?title='), scCall[0]);
  const badSc = await notify('offline', { title: 'T', body: 'B' }, { channel: 'serverchan', key: 'S1', retryN: 0, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ code: 40001 }) }), log: () => {} });
  check('⑥ Server酱：HTTP 200 但 code≠0 ⇒ **不受理**（这就是为什么不能只看 HTTP 码）', badSc.ok === false && badSc.code === '40001');
}

// ── ⑦ 文案不声称"他看到了" ─────────────────────────────────────────────────
console.log('\n⑦ 文案：不编因果、不编耗时、不声称已读');
{
  const off = buildMessage('offline', { nickname: '测试机器人', reason: 'HTTP 502' });
  const on = buildMessage('online', { nickname: '测试机器人', reason: 'ok' });
  check('⑦ 掉线文案：题目带 ⚠、说清"问不到状态"、给出下一步', /⚠/.test(off.title) && /没登录|没注入/.test(off.body) && /扫码/.test(off.body));
  check('⑦ 掉线文案**不声称**"已通知到你 / 已送达 / 你一定"（没有已读回执，别骗人）',
    !/已通知到你|已送达|你已经看到|你一定/.test(off.title + off.body));
  check('⑦ 恢复文案说得明白（"已恢复" + 这是机器人在服务器上自己发的）', /已恢复/.test(on.title) && /服务器/.test(off.body));
}

// ── ⑧⑨ 没配 key / DRY_RUN ──────────────────────────────────────────────────
console.log('\n⑧ 没配 key 也不静默吞 · ⑨ DRY_RUN 一条不真发');
{
  check('⑧ resolveChannel：没有 key ⇒ channel=none 并给出原因', (() => { const c = resolveChannel({}); return c.channel === 'none' && /key/.test(c.why); })());
  const env = freshEnv({ WATCH_QQ_CHANNEL: '', WATCH_QQ_BARK_KEY: '', WATCH_QQ_STATE: path.join(DIR, 'nokey.state.json'), WATCH_QQ_LOG: path.join(DIR, 'nokey.jsonl') });
  const net = fakeNet({ samples: [OFFLINE, OFFLINE] });
  await run(env, net); const r = await run(env, net);
  check('⑧ 没通道 ⇒ 不真发（0 次网络通知）', net.calls.notify.length === 0);
  check('⑧ 但状态照样落日志（kind=alert + code=no-channel）——**不静默吞**',
    logLines(env.WATCH_QQ_LOG).some((l) => l.kind === 'alert' && l.code === 'no-channel'), JSON.stringify(logLines(env.WATCH_QQ_LOG).slice(-2)));
  const env2 = freshEnv({ WATCH_QQ_DRY_RUN: '1' });
  const net2 = fakeNet({ samples: [OFFLINE, OFFLINE] });
  await run(env2, net2); const r2 = await run(env2, net2);
  check('⑨ DRY_RUN=1 ⇒ 一条都不真发，日志里写明 dry-run', net2.calls.notify.length === 0 && r2.notified?.code === 'dry-run', JSON.stringify(r2.notified));
}

// ── ⑩ 无效配置 ⇒ 跳过不发（假警报比漏报更坏）· 超长字段 ⇒ 截断 + 留痕 ────────────────────
console.log('\n⑩ baseHttp 无效 ⇒ 跳过；超长字段 ⇒ 截断 + 不静默');
{
  const env = freshEnv();
  const badApi = { baseHttp: '', accessToken: 'x', timeoutMs: 1000 };
  const net = fakeNet({ samples: [OFFLINE, OFFLINE, OFFLINE] });
  const paths = { log: env.WATCH_QQ_LOG, state: env.WATCH_QQ_STATE };
  const r1 = await runOnce({ env, fetchImpl: net, api: badApi, paths, sleep: async () => {} });
  const r2 = await runOnce({ env, fetchImpl: net, api: badApi, paths, sleep: async () => {} });
  const lines = logLines(env.WATCH_QQ_LOG);
  check('⑩ baseHttp 无效 ⇒ 连采样都不做（0 次 get_login_info）', net.calls.sample.length === 0, `${net.calls.sample.length} 次`);
  check('⑩ 状态**不翻转**（跑两轮也不会攒出"连击 2 次"）', r1.state === null && r2.state === null && !r1.flip && !r2.flip, `state=${r1.state}/${r2.state}`);
  check('⑩ 一条通知都不发，且日志留一行 skipped 写明原因（**假警报比漏报更坏**）',
    net.calls.notify.length === 0 && lines.filter((l) => l.kind === 'skipped').length === 2 && /假警报比漏报更坏/.test(lines[0]?.reason ?? ''),
    JSON.stringify(lines[0] ?? {}));
  const long = 'x'.repeat(5000);
  const calls = [];
  const r3 = await notify('offline', { title: 'T'.repeat(3000), body: long }, {  // port-literal-ok: 这是字符串长度，不是端口
    channel: 'bark', key: 'K'.repeat(2000), log: (l) => lines.push(l),
    fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 200, json: async () => ({}) }; },
  });
  check('⑩ 超长 key/title/body ⇒ 截断（URL 长度有界，不把 5 千字符塞进 URL）', r3.ok === true && calls[0].length < 2500, `URL 长度 ${calls[0]?.length}`);
  check('⑩ 截断**不静默**：落一行 truncated（带各自原长）',
    lines.some((l) => l.kind === 'truncated' && l.maxFieldLen > 0 && l.bodyLen === 5000 && l.titleLen === 3000 && l.keyLen === 2000),  // port-literal-ok: 断言的是长度，不是端口
    JSON.stringify(lines.find((l) => l.kind === 'truncated') ?? {}));
}

console.log(`\n═════ 通过 ${pass} 项，失败 ${fail} 项 ═════`);
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* 尽力而为 */ }
if (fail) { console.log('失败项：\n  - ' + failures.join('\n  - ')); process.exit(1); }
