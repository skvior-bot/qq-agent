#!/usr/bin/env node
// panels-refresh —— 「面板页」的**真刷新**引擎（CDP），零依赖。
//
// 为什么需要它（主人 2026-09-26 早上的原话，五步顺序）：
//   「检查无浏览器运行 → 打开浏览器 → 检查是否存在页面 → 打开不存在的页面 → **刷新一下重置页面**」
// 现实：`panels.ps1` 判定"这一页还开着吗"靠的是 **socket 层证据**（netstat ESTABLISHED / 控制台心跳），
//   而**重启之后那些旧标签的 socket 早没了** ⇒ 看不见 ⇒ 被判"缺页" ⇒ 又开一张（他今早看到 DSH ×2、
//   SnowLuma ×2 就是这么来的）。而"把已经开着的那一页刷新一下"在浏览器外面**只有 CDP 一条真路**：
//   `GET /json/list` 给的是**权威标签页清单**（挂起/失联的旧标签**照样列得出来**），
//   `Page.reload` 就是真刷新（顺带把令牌过期的旧标签救回来 —— 这正是以前 `-ForcePage` 重开一张的活）。
//
// 用法（输出**单行 JSON**，给 PowerShell 解析；令牌在输出里一律打码 —— 红线 3）：
//   node tools\panels-refresh.mjs list   --port 9223
//   node tools\panels-refresh.mjs probe  --port 9223 --match 127.0.0.1:3080     # 只读：location.href/document.title
//   node tools\panels-refresh.mjs reload --port 9223 --match 127.0.0.1:3080 [--match 127.0.0.1:3100]
//   node tools\panels-refresh.mjs reload --port 9223 --all      # 把清单里属于我们端口的页全刷一遍
//   node tools\panels-refresh.mjs close  --port 9310            # ★ 优雅关掉"自己起的那个实例"（Browser.close）
//
// 退出码（调用方按这个分流，**别把"没有调试口"当错误**）：
//   0 = 成功（list 拿到了清单 / reload 至少刷新了一页或明确"没有这个标签"）
//   2 = 连不上调试口（没有 CDP ⇒ 调用方退回"提示按 F5"那条老实路）
//   3 = 参数错
//
// ⚠ 只连回环地址；只在"我们自己带 --remote-debugging-port 起浏览器"或"那个端口本来就在听"时可用。

const argv = process.argv.slice(2);
const cmd = (argv[0] ?? '').toLowerCase();
const val = (name, dflt = '') => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt;
};
const all = (name) => argv.reduce((acc, a, i) => (a === name && i + 1 < argv.length ? [...acc, argv[i + 1]] : acc), []);

const port = Number(val('--port', '9223'));
const timeoutMs = Number(val('--timeout', '4000'));

// 输出里不许出现令牌（红线 3）：query 里的 token/secret 之类一律换成 ***
function mask(s) {
  return String(s ?? '').replace(/([?&;](?:access_token|api_token|auth_token|refresh_token|token|secret|password|passwd)=)[^&;\s"']*/gi, '$1***');
}

function out(obj, code) {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
}

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr)) throw new Error('调试口返回的不是数组');
  return arr.filter((t) => t && t.type === 'page').map((t) => ({ id: t.id, url: mask(t.url), ws: t.webSocketDebuggerUrl ?? '', title: mask(t.title) }));
}

// ★★ 优雅关闭自己起的那个实例（2026-09-26，协调线裁定）。
// 为什么必须有它：`taskkill /F` / `Stop-Process -Force` 杀 Chromium **必然弹框**
//   （`msedge.exe - 应用程序错误 · unknown software exception (0x80000003)`，还会拉起
//    `Choose Just-In-Time Debugger`）—— 主人被这个骚扰了两次。⇒ **关浏览器只许走 CDP**：
//   `GET /json/version` 拿**浏览器级** webSocketDebuggerUrl ⇒ 发 `Browser.close` ⇒ 它自己退。
//   这是浏览器自己支持的退出路径（等于点了关闭），不会走崩溃处理器。
async function browserClose() {
  const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const info = await res.json();
  const wsUrl = info?.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('调试口没给浏览器级 webSocketDebuggerUrl');
  return await new Promise((resolve) => {
    let settled = false;
    let sock = null;
    let timer = null;
    const settle = (ok, why) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve({ ok, why }); };
    const closeThen = (ok, why) => {
      if (!sock || sock.readyState === 3) return settle(ok, why);
      const t = setTimeout(() => settle(ok, why), 500);
      sock.addEventListener('close', () => { clearTimeout(t); settle(ok, why); }, { once: true });
      try { sock.close(); } catch { settle(ok, why); }
    };
    try { sock = new WebSocket(wsUrl); } catch (e) { return settle(false, `WebSocket 建不起来：${e?.message ?? e}`); }
    timer = setTimeout(() => closeThen(true, '已发 Browser.close（等回执超时，按已发出算）'), timeoutMs);
    sock.addEventListener('open', () => {
      try { sock.send(JSON.stringify({ id: 1, method: 'Browser.close' })); }
      catch (e) { closeThen(false, `发送失败：${e?.message ?? e}`); }
    });
    sock.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { }
      if (msg && msg.id === 1) closeThen(!msg.error, msg.error ? JSON.stringify(msg.error) : 'ok（浏览器回执：正在退）');
    });
    sock.addEventListener('error', () => closeThen(false, 'WebSocket 出错（调试口拒了？）'));
  });
}

// 一页一连接：发 Page.reload，等回执（或超时），**等连接真关掉**再交回控制权。
// ⚠ 为什么必须等它关干净：句柄还在关的时候 `process.exit()` 会让 Node 在 `src\win\async.c` 上断言
//   （实测退出码 0xC0000409 —— JSON 明明已经打对了，进程却在收尾时崩）。调用方只看退出码，会误判。
function reloadOne(wsUrl) {
  return new Promise((resolve) => {
    let settled = false;
    let sock = null;
    let timer = null;
    const settle = (ok, why) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve({ ok, why }); };
    const closeThen = (ok, why) => {
      if (!sock || sock.readyState === 3) return settle(ok, why);      // 3 = CLOSED
      const t = setTimeout(() => settle(ok, why), 500);
      sock.addEventListener('close', () => { clearTimeout(t); settle(ok, why); }, { once: true });
      try { sock.close(); } catch { settle(ok, why); }
    };
    try { sock = new WebSocket(wsUrl); } catch (e) { return settle(false, `WebSocket 建不起来：${e?.message ?? e}`); }
    timer = setTimeout(() => closeThen(false, `等回执超时（${timeoutMs}ms）`), timeoutMs);
    sock.addEventListener('open', () => {
      try { sock.send(JSON.stringify({ id: 1, method: 'Page.reload', params: { ignoreCache: true } })); }
      catch (e) { closeThen(false, `发送失败：${e?.message ?? e}`); }
    });
    sock.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { }
      if (msg && msg.id === 1) closeThen(!msg.error, msg.error ? JSON.stringify(msg.error) : 'ok');
    });
    sock.addEventListener('error', () => closeThen(false, 'WebSocket 出错（调试口拒了？）'));
  });
}

// 一页一连接：问它"这个标签**真到了没有**"——取 `location.href` ＋ `document.title`。
// 为什么要它（2026-09-26，实测校正过两次）：
//   · **打不开的地址**在 Chromium 里 CDP 清单**照样列得出来**，`/json/list` 给的 `title` 是**空的**
//     ⇒ 光看"清单里有这个 URL"会把错误页当成"到了"；
//   · ⚠ 但"`document.title` 空"**也不能**当判据 —— 实测**主人那个真实的 DSH 页面**的
//     `document.title` **同样是空的**（它是 SPA，`/json/list` 里那个标题只是 URL 兜底）⇒ 那样会误杀真页面；
//   · ★ 权威信号是 **`location.href`**：错误页的 href 会变成 `chrome-error://chromewebdata/`
//     （再也不会以 http 开头）⇒ "href 不是 http(s)"才是"到了但没成"。
// 只读、不外传内容（只取 href/title 两个字面量），不引入通用 eval。
function probeOne(wsUrl, expression) {
  return new Promise((resolve) => {
    let settled = false;
    let sock = null;
    let timer = null;
    const settle = (ok, val, err) => { if (settled) return; settled = true; if (timer) clearTimeout(timer); resolve({ ok, val, err }); };
    const closeThen = (ok, val, err) => {
      if (!sock || sock.readyState === 3) return settle(ok, val, err);
      const t = setTimeout(() => settle(ok, val, err), 500);
      sock.addEventListener('close', () => { clearTimeout(t); settle(ok, val, err); }, { once: true });
      try { sock.close(); } catch { settle(ok, val, err); }
    };
    try { sock = new WebSocket(wsUrl); } catch (e) { return settle(false, null, `WebSocket 建不起来：${e?.message ?? e}`); }
    timer = setTimeout(() => closeThen(false, null, `等回执超时（${timeoutMs}ms）`), timeoutMs);
    sock.addEventListener('open', () => {
      try { sock.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); }
      catch (e) { closeThen(false, null, `发送失败：${e?.message ?? e}`); }
    });
    sock.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ''); } catch { }
      if (msg && msg.id === 1) {
        if (msg.error) return closeThen(false, null, JSON.stringify(msg.error));
        return closeThen(true, msg.result?.result?.value ?? null, null);
      }
    });
    sock.addEventListener('error', () => closeThen(false, null, 'WebSocket 出错（调试口拒了？）'));
  });
}

if (cmd === 'list') {
  try {
    const targets = await listTargets();
    out({ ok: true, port, count: targets.length, targets }, 0);
  } catch (e) {
    out({ ok: false, port, reason: `连不上调试口：${e?.message ?? e}`, hint: '没有 CDP ⇒ 退回"提示按 F5"那条路' }, 2);
  }
} else if (cmd === 'probe') {
  // 用法：probe --port 9223 --match 127.0.0.1:3080 [--match …]
  // 输出：{ ok, port, count, probed:[{url, href, title, err}] }；连不上调试口 ⇒ 退 2（与 list 同口径）
  const matches = all('--match');
  if (!matches.length) out({ ok: false, reason: '要 --match <url 片段>（可多次）' }, 3);
  let targets;
  try {
    targets = await listTargets();
  } catch (e) {
    out({ ok: false, port, reason: `连不上调试口：${e?.message ?? e}`, hint: '没有 CDP ⇒ 退回"提示按 F5"那条路' }, 2);
  }
  const hit = targets.filter((t) => matches.some((m) => t.url.includes(m)));
  const probed = [];
  for (const t of hit) {
    if (!t.ws) { probed.push({ url: t.url, href: null, title: null, err: '调试口没给 webSocketDebuggerUrl' }); continue; }
    const r = await probeOne(t.ws, 'JSON.stringify({h:location.href,t:document.title})');
    if (!r.ok) { probed.push({ url: t.url, href: null, title: null, err: r.err ?? '探针失败' }); continue; }
    let v = null;
    try { v = JSON.parse(r.val); } catch { }
    // ⚠ 这里**不打码**：`location.href` 是我们自己构造的地址（令牌在 query 里，本来就要比对），
    //   而且只进 PowerShell 的内存判断、不落盘、不回显整条 URL（只回显 host:port 与结论）。
    probed.push({ url: t.url, href: v?.h ?? null, title: v?.t ?? null, err: null });
  }
  out({ ok: true, port, count: probed.length, probed }, 0);
} else if (cmd === 'close') {
  // 用法：close --port 9310
  // ★ 关闭**自己起的那个实例**的唯一正路（见 browserClose 的注释：强杀 Chromium 必弹框）。
  //   连不上调试口 ⇒ 退 2（调用方据此判定"这个实例已经不在跑了"或"压根不是可优雅关的实例"）。
  try {
    const r = await browserClose();
    out({ ok: r.ok, port, closed: r.ok, why: r.why, hint: r.ok ? '已请浏览器自己退出（不走崩溃处理器、不弹框）' : '优雅关闭没成 ⇒ 调用方降级：先 `taskkill`（不带 /F），最后才考虑 /F' }, r.ok ? 0 : 1);
  } catch (e) {
    out({ ok: false, port, closed: false, reason: `连不上调试口：${e?.message ?? e}`, hint: '连不上 = 它可能已经退了；要确认请看端口/进程，别强杀' }, 2);
  }
} else if (cmd === 'reload') {
  const matches = all('--match');
  const reloadAll = argv.includes('--all');
  if (!matches.length && !reloadAll) out({ ok: false, reason: '要 --match <url 片段>（可多次）或 --all' }, 3);
  let targets;
  try {
    targets = await listTargets();
  } catch (e) {
    out({ ok: false, port, reason: `连不上调试口：${e?.message ?? e}`, hint: '没有 CDP ⇒ 退回"提示按 F5"那条路' }, 2);
  }
  const hit = targets.filter((t) => reloadAll || matches.some((m) => t.url.includes(m)));
  const reloaded = [];
  const failed = [];
  for (const t of hit) {
    if (!t.ws) { failed.push({ url: t.url, why: '调试口没给 webSocketDebuggerUrl' }); continue; }
    const r = await reloadOne(t.ws);
    if (r.ok) reloaded.push(t.url); else failed.push({ url: t.url, why: r.why });
  }
  out({ ok: failed.length === 0, port, matched: hit.length, reloaded, failed, absent: hit.length === 0 }, 0);
} else {
  out({ ok: false, reason: '用法：panels-refresh.mjs list|probe|reload|close --port <n> [--match <片段>]… [--all]' }, 3);
}
