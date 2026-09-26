// control-actions.mjs —— 控制面**动作目录**（tools\control-actions.json）的读取器 + 校验器 + 纯函数断言。
//
// 为什么要有这个文件（2026-09-24，为"搬到 Linux 服务器"铺路那一批）：
//   动作白名单原来是**两处定义**：tools\control-server.mjs 的 `const VERBS` 与 tools\control.ps1 的
//   ValidateSet + switch 分支 —— 正是本项目一直在消灭的『同一个值两处定义』。这一次不是在两个地方
//   各改一遍，而是把"有哪些动作"收进**一份数据**（control-actions.json），两个消费方都读它：
//     · tools\control-server.mjs（HTTP 载波，node ⇒ 本来就跨平台）
//     · tools\control.ps1（外观，Windows 那半）
//   然后加一层**平台驱动缝合层**（tools\control-driver.mjs）：win32 = 调现成的 .ps1；
//   linux = systemctl / docker compose / journalctl（单元文件在 deploy\linux\，2026-09-24 第二批落地）；
//   darwin = 老实抛人话错误（未实现，见 docs\部署到服务器.md §10.5）。
//
// 本文件自己**不含动作清单**（那是 data 的事），只做四件事：
//   ① loadCatalog —— 读 + 校验，**校验不过就抛**（宁可当场不可用，也不按一份猜的白名单收请求）；
//   ② 纯函数查询 —— 动作表 / 参数枚举 / 要不要 confirm / 拼 argv；
//   ③ validateCatalog / checkScripts —— 结构性校验（不碰文件系统）与执行体存在性（碰文件系统，给自检用）；
//   ④ runSelfTest —— **钉住契约的纯函数断言**（离线、不起子进程）。
//
// ★ 关于 runSelfTest 里那些"写死的期望值"：那不是第二份定义，是**测试预言（oracle）**——
//   本仓库已有先例：qq-bridge\scripts\test-env-config.mjs 里的端口字面量正是被测对象，self-check 的
//   端口棘轮专门给它开了白名单（注释原话："那一份就是『钉默认值』的回归测试"）。这里的期望值同理：
//   它们的存在**就是为了在目录被人改动时当场叫出来**，而不是被谁 import 去当数据源。
//
// 用法：
//   node tools\control-actions.mjs --json        # 打印"人能看懂的"目录（每个动作 + 各平台能不能跑）
//   node tools\control-actions.mjs --check       # 只校验目录（含执行体文件是否存在）
//   node tools\control-actions.mjs --self-test   # 跑纯函数断言（离线，0 = 全过）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 端口名（{port:<名>} 占位符要按它对账）——**不在这里抄一份端口名单**：唯一来源是 config-lib 的默认表。
import { DEFAULT_PORTS } from '../qq-bridge/src/config-lib.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');
export const CATALOG_FILE = path.join(__dirname, 'control-actions.json');

// 有实现驱动的平台：**这一张表 = "哪些平台真有驱动"的判据**（tools\control-driver.mjs 的 DRIVERS 与它一一对应，
// 目录里 platforms.<名>.supported 也必须与它一致；自检 5.14 把三处一起看）。
//   2026-09-24 第一批：只有 win32（执行体 = tools\*.ps1）。
//   2026-09-24 第二批：加 linux（执行体 = systemctl / docker compose / journalctl + deploy\linux\ 里的单元文件）。
export const PLATFORM_SPECS = {
  // cmd：2026-09-25 加（restart-stack 的真工人是**启动器 一键启动.cmd** ——
  //   它是主人双击的那同一个入口，说成 ps1/node 都是假话；渲染在 control-driver.mjs 里同步支持）。
  win32: { driver: 'control-ps1', runners: ['ps1', 'node', 'cmd'], facadeScript: true },
  linux: { driver: 'control-linux', runners: ['systemctl', 'docker', 'journalctl', 'node', 'print'], facadeScript: false },
};
export const IMPLEMENTED_PLATFORMS = Object.keys(PLATFORM_SPECS);
const CONFIRM_MODES = ['never', 'always', 'targets'];
// `{port:<名>}` 里允许出现的名字：配置层的六个端口 + 一个例外。
// 例外 = novnc：它是**上游 SnowLuma 镜像自己的端口**（容器里的 noVNC），不属于本仓库配置层，
// 值写在 deploy/linux/.env（驱动从那里读，读不到就把 ${NOVNC_PORT} 原样打出来给人看）。
const EXTRA_PORTS = { novnc: '上游镜像的 noVNC 端口（deploy/linux/.env 里的 NOVNC_PORT，不在仓库配置层）' };
export const PORT_PLACEHOLDER_NAMES = [...Object.keys(DEFAULT_PORTS), ...Object.keys(EXTRA_PORTS)];
const ID_RE = /^[a-z][a-z0-9-]*$/;

// ── ① 读 + 校验 ──────────────────────────────────────────────────────────────
export function loadCatalog(file = CATALOG_FILE) {
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`动作目录读不了（${file}）：${e.message}`);
  }
  const errors = validateCatalog(doc);
  if (errors.length) {
    throw new Error(`动作目录校验不过（${file}）—— 它是控制面白名单的唯一来源，不能带着错往下走：\n  - ${errors.join('\n  - ')}`);
  }
  return doc;
}

// 结构性校验（**不碰文件系统** —— 所以能在任何地方跑，包括服务启动时）。返回错误数组（空 = 过）。
export function validateCatalog(doc) {
  const errs = [];
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return ['根节点必须是一个 JSON 对象'];
  if (!Number.isInteger(doc.version) || doc.version < 1) errs.push('version 必须是正整数');
  if (typeof doc._README !== 'string' || !doc._README.trim()) errs.push('_README 不能为空（这份数据是给人和程序一起看的）');

  // 平台表：实现得了的要写 supported:true + driver；实现不了的要写 supported:false + 非空 reason。
  const platforms = doc.platforms;
  if (!platforms || typeof platforms !== 'object') {
    errs.push('缺 platforms（每个平台能不能跑、不能跑的原因都要写清楚）');
  } else {
    for (const [name, p] of Object.entries(platforms)) {
      if (!p || typeof p !== 'object') { errs.push(`platforms.${name} 必须是对象`); continue; }
      if (p.supported === true) {
        if (typeof p.driver !== 'string' || !p.driver.trim()) errs.push(`platforms.${name}.supported=true 就必须写 driver`);
        if (!IMPLEMENTED_PLATFORMS.includes(name)) errs.push(`platforms.${name} 说 supported=true，但本文件只认实现过的 ${IMPLEMENTED_PLATFORMS.join('/')}`);
        else if (p.driver !== PLATFORM_SPECS[name].driver) errs.push(`platforms.${name}.driver 必须是 '${PLATFORM_SPECS[name].driver}'（与 tools\\control-driver.mjs 的驱动表对不上）`);
      } else if (p.supported === false) {
        if (p.driver !== null) errs.push(`platforms.${name} 没实现 ⇒ driver 必须显式写 null（不许留空、不许写个名字假装有）`);
        if (typeof p.reason !== 'string' || p.reason.trim().length < 8 || !/未实现/.test(p.reason)) {
          errs.push(`platforms.${name}.reason 要一句人话，且必须点明"未实现"（现在：${JSON.stringify(p.reason)}）`);
        }
      } else {
        errs.push(`platforms.${name}.supported 必须是 true/false（别的值是含糊，含糊就是坑）`);
      }
    }
    for (const want of ['win32', 'linux']) if (!platforms[want]) errs.push(`platforms 缺 ${want}（linux 那格哪怕未实现也要显式写出来，好让人一眼看到差距）`);
  }

  const acts = doc.actions;
  if (!Array.isArray(acts) || acts.length === 0) return [...errs, 'actions 必须是非空数组'];
  const seen = new Set();
  acts.forEach((a, i) => {
    const at = `actions[${i}]${a && a.id ? `(${a.id})` : ''}`;
    if (!a || typeof a !== 'object') return errs.push(`${at} 必须是对象`);
    if (typeof a.id !== 'string' || !ID_RE.test(a.id)) errs.push(`${at}.id 必须是 ^[a-z][a-z0-9-]*$`);
    else if (seen.has(a.id)) errs.push(`${at}.id 重复了（动作 id 是主键）`);
    else seen.add(a.id);
    if (typeof a.label !== 'string' || !/[\u4e00-\u9fff]/.test(a.label)) errs.push(`${at}.label 要中文显示名（面板与用法屏直接用）`);
    if (typeof a.summary !== 'string' || a.summary.trim().length < 8) errs.push(`${at}.summary 要一句话说明这个动作干什么`);
    if (typeof a.mutates !== 'boolean') errs.push(`${at}.mutates 必须是 true/false（会不会改状态）`);
    if (typeof a.supportsJson !== 'boolean') errs.push(`${at}.supportsJson 必须是 true/false`);

    // usage 两行清单：要么给字符串 + usageRow，要么显式 null（= 不进清单）。
    const hasUsage = typeof a.usage === 'string' && a.usage.trim();
    if (hasUsage && ![1, 2].includes(a.usageRow)) errs.push(`${at}.usageRow 必须是 1 或 2（它就是给人看的两行排版）`);
    if (!hasUsage && a.usage !== null) errs.push(`${at}.usage 要么是用法字符串，要么显式写 null`);
    if (!hasUsage && a.usageRow !== null) errs.push(`${at}.usageRow 要与 usage 一起为 null`);

    // HTTP 面
    const h = a.http;
    if (!h || typeof h !== 'object') errs.push(`${at} 缺 http（能不能 GET/POST、要不要 confirm）`);
    else {
      if (typeof h.get !== 'boolean' || typeof h.post !== 'boolean') errs.push(`${at}.http.get/post 必须是 true/false`);
      const c = h.confirm;
      if (!c || typeof c !== 'object' || !CONFIRM_MODES.includes(c.mode)) errs.push(`${at}.http.confirm.mode 必须是 ${CONFIRM_MODES.join('/')}`);
      else {
        if (c.mode === 'targets') {
          const vals = paramValues(a, 'target');
          if (!Array.isArray(c.targets) || c.targets.length === 0) errs.push(`${at}.http.confirm.targets 在 mode=targets 时不能为空`);
          else {
            for (const t of c.targets) if (!vals || !vals.includes(t)) errs.push(`${at}.http.confirm.targets 里的「${t}」不是它 target 参数的白名单值`);
          }
        }
        // mode=never 且 mutates=true 是允许的：up / pages / login 就是"点了才动、不用二次确认"的那批。
        if (c.mode !== 'never' && a.mutates !== true) errs.push(`${at} 不改状态却要 confirm —— 要么 mutates 写错了，要么 confirm 写错了`);
      }
      // 发起即返回的那种动作（restart-stack）回执里那句计划：写在这里，发起方别自己编。
      if (h.receipt !== undefined) {
        const r = h.receipt;
        if (!r || typeof r !== 'object' || typeof r.plan !== 'string' || !r.plan.trim()) {
          errs.push(`${at}.http.receipt.plan 要一句非空计划（回执里给发起方看的那句话）`);
        }
      }
      // single-flight 的盘上标记（控制面自己会被这次重启杀掉 ⇒ 记账只能落在盘上）。
      if (h.busyGuard !== undefined) {
        const g = h.busyGuard;
        if (!g || typeof g !== 'object') errs.push(`${at}.http.busyGuard 必须是对象`);
        else {
          if (typeof g.marker !== 'string' || !g.marker.trim()) errs.push(`${at}.http.busyGuard.marker 要写一个状态文件路径（并发闸的盘上标记）`);
          // 只许落在生产状态文件的家（self-check 5.5 的白名单盯着 state\ 这一层，别往别处写）。
          else if (!/^qq-bridge[\\/]state[\\/][^\\/\\]+$/.test(g.marker)) errs.push(`${at}.http.busyGuard.marker 只许是 qq-bridge\\state\\<文件>（现在：${g.marker}）`);
          if (!Number.isInteger(g.maxAgeMs) || g.maxAgeMs <= 0) errs.push(`${at}.http.busyGuard.maxAgeMs 要是正整数毫秒（过期就当没有，别把入口永久锁死）`);
        }
      }
      if (h.tailClamp) {
        const tc = h.tailClamp;
        if (!Number.isInteger(tc.min) || !Number.isInteger(tc.max) || tc.min < 1 || tc.max < tc.min) errs.push(`${at}.http.tailClamp 的 min/max 不合法`);
        if (!Number.isInteger(tc.default) || tc.default < tc.min || tc.default > tc.max) errs.push(`${at}.http.tailClamp.default 必须落在 min~max 内`);
      }
    }

    // 参数（名字 + 允许值枚举）
    if (!Array.isArray(a.params)) { errs.push(`${at}.params 必须是数组（没有参数就写 []）`); }
    else a.params.forEach((p, j) => {
      const pt = `${at}.params[${j}]`;
      if (!p || typeof p !== 'object') return errs.push(`${pt} 必须是对象`);
      if (typeof p.name !== 'string' || !ID_RE.test(p.name)) errs.push(`${pt}.name 必须是 ^[a-z][a-z0-9-]*$`);
      if (typeof p.required !== 'boolean') errs.push(`${pt}.required 必须是 true/false`);
      const hasValues = Array.isArray(p.values);
      const isInt = p.type === 'int';
      if (hasValues === isInt) errs.push(`${pt} 要么给 values 枚举、要么给 type=int（二选一，且不能都不给）`);
      if (hasValues) {
        if (p.values.length === 0) errs.push(`${pt}.values 不能是空枚举（那等于没有白名单）`);
        p.values.forEach((v) => { if (typeof v !== 'string' || v !== v.toLowerCase() || !v.trim()) errs.push(`${pt}.values 里的小写字符串才认（现在：${JSON.stringify(v)}）`); });
        if (new Set(p.values).size !== p.values.length) errs.push(`${pt}.values 有重复值`);
      }
      if (isInt) {
        if (!Number.isInteger(p.min) || !Number.isInteger(p.max) || p.min > p.max) errs.push(`${pt} 的 min/max 不合法`);
        if (!Number.isInteger(p.default) || p.default < p.min || p.default > p.max) errs.push(`${pt}.default 必须落在 min~max 内`);
      }
    });

    // 各平台执行体：**没实现的平台必须显式 null**（绝不假装能用）
    const pf = a.platform;
    if (!pf || typeof pf !== 'object') errs.push(`${at} 缺 platform（win32 怎么跑 / 其它平台为什么不能跑）`);
    else {
      for (const name of Object.keys(platforms || {})) {
        if (!(name in pf)) { errs.push(`${at}.platform 缺 ${name} 这一格（没实现就显式写 null）`); continue; }
        const impl = platforms[name]?.supported === true;
        if (!impl && pf[name] !== null) errs.push(`${at}.platform.${name} 必须是 null —— ${name} 驱动还没写，**绝不许假装能用**`);
        if (impl) validatePlatformAction(a, name, pf[name], errs, at, platforms);
      }
    }
  });
  return errs;
}

// 一个动作在某个**已实现**平台上的执行体（按平台各自的形状校验）。
//   win32：driver=control-ps1，script=外观脚本（tools\control.ps1），args=拼给它的 argv，steps=真正干活的 .ps1/.mjs
//   linux：driver=control-linux，没有外观脚本（驱动自己就是外观），steps=要跑的命令（systemctl/docker/journalctl/node/print）
//          applicable:false = **整段不适用**（无桌面服务器上的 pages）—— 这时必须写 notApplicableReason 且 steps 为空。
function validatePlatformAction(a, name, entry, errs, at, platforms) {
  const spec = PLATFORM_SPECS[name];
  const where = `${at}.platform.${name}`;
  if (!entry || typeof entry !== 'object') return errs.push(`${where} 必须是一个对象（${name} 的执行体）`);
  if (entry.driver !== spec.driver) errs.push(`${where}.driver 只认 '${spec.driver}'（别的名字说明有人加了个不存在的驱动）`);
  if (entry.applicable !== undefined && typeof entry.applicable !== 'boolean') errs.push(`${where}.applicable 只能是 true/false`);
  const names = (a.params || []).map((p) => p.name);
  const okFile = (f) => typeof f === 'string' && f.trim();

  if (name === 'win32') {
    if (!okFile(entry.script)) errs.push(`${where}.script 要写外观脚本路径`);
    if (!Array.isArray(entry.args)) errs.push(`${where}.args 必须是数组`);
    else for (const arg of entry.args) {
      if (typeof arg !== 'string') { errs.push(`${where}.args 里只许字符串（不许把用户输入拼进来）`); continue; }
      for (const m of arg.matchAll(/\{([a-z][a-z0-9-]*)\}/g)) {
        if (!names.includes(m[1])) errs.push(`${where}.args 里的占位符 {${m[1]}} 不是这个动作的参数（拼出来会是个空串）`);
      }
    }
  }

  const steps = entry.steps;
  if (!Array.isArray(steps)) return errs.push(`${where}.steps 必须是数组（真跑的是哪些东西）`);
  if (entry.applicable === false) {
    if (typeof entry.notApplicableReason !== 'string' || entry.notApplicableReason.trim().length < 20) {
      errs.push(`${where} 标了 applicable:false ⇒ 必须写清楚 notApplicableReason（"整段不适用"跟"还没实现"是两件事，得说清为什么）`);
    }
    if (steps.length) errs.push(`${where} 标了 applicable:false ⇒ steps 必须是空的（不适用就没有执行体）`);
  }
  if (steps.length === 0) {
    if (typeof entry.stepsNote !== 'string' || !entry.stepsNote.trim()) errs.push(`${where}.steps 为空时必须写 stepsNote 说明为什么（别让人以为是漏写）`);
  }
  const unitKeys = Object.keys(platforms?.[name]?.units ?? {});
  steps.forEach((s, k) => {
    const st = `${where}.steps[${k}]`;
    if (!s || typeof s !== 'object') return errs.push(`${st} 必须是对象`);
    if (typeof s.label !== 'string' || !s.label.trim()) errs.push(`${st}.label 要一句话说明这一步干什么`);
    if (!spec.runners.includes(s.runner)) errs.push(`${st}.runner 必须是 ${spec.runners.join('/')}`);
    // `when`：win32 那半是**给人看的条件描述**（真正的分支在 control.ps1 里，如 "target=all"）；
    // linux 这半必须是**机器可读的数组**（驱动按它筛 step）—— 两种形状各按各的校验。
    if (s.when !== undefined) {
      if (name === 'win32') {
        if (typeof s.when !== 'string' || !s.when.trim()) errs.push(`${st}.when 要么不写、要么写一句人话条件（Windows 那半的分支在 control.ps1 里）`);
      } else {
        const vals = paramValues(a, 'target') ?? [];
        if (!Array.isArray(s.when) || s.when.length === 0) errs.push(`${st}.when 必须是非空数组（写这个动作 target 白名单里的值）`);
        else for (const w of s.when) if (!vals.includes(w)) errs.push(`${st}.when 里的「${w}」不是这个动作 target 参数的白名单值`);
      }
    }
    if (s.runner === 'node' && !okFile(s.script)) errs.push(`${st}（node）要写 script（跑哪个脚本）`);
    if (name === 'win32') {
      if (!okFile(s.script)) errs.push(`${st}.script 要写执行体路径`);
    } else if (s.runner === 'print') {
      if (!Array.isArray(s.lines) || s.lines.length === 0 || s.lines.some((l) => typeof l !== 'string' || !l.trim())) {
        errs.push(`${st}（print = 只打印不执行）必须给非空的 lines`);
      }
    } else if (!Array.isArray(s.args)) {
      errs.push(`${st}.args 必须是数组`);
    }
    // 占位符：只许"动作参数 + 平台级那几样"（{port:名} / {unit:键} / {compose} / {envfile}）
    for (const text of [...(Array.isArray(s.args) ? s.args : []), ...(Array.isArray(s.lines) ? s.lines : [])]) {
      if (typeof text !== 'string') { errs.push(`${st} 的 args/lines 里只许字符串`); continue; }
      for (const m of text.matchAll(/\{port:([a-zA-Z][a-zA-Z0-9]*)\}/g)) {
        if (!PORT_PLACEHOLDER_NAMES.includes(m[1])) {
          errs.push(`${st} 的 {port:${m[1]}} 不是配置层的端口名（有的是 ${PORT_PLACEHOLDER_NAMES.join('/')}）`);
        }
      }
      for (const m of text.matchAll(/\{unit:([a-z][a-z0-9-]*)\}/g)) {
        if (!unitKeys.includes(m[1])) errs.push(`${st} 的 {unit:${m[1]}} 不在 platforms.${name}.units 里（有的是 ${unitKeys.join('/')}）`);
      }
      for (const m of text.matchAll(/\{([a-z][a-z0-9-]*)\}/g)) {
        if (names.includes(m[1]) || m[1] === 'compose' || m[1] === 'envfile') continue;
        errs.push(`${st} 里的占位符 {${m[1]}} 不认识（参数只有 ${names.join('/') || '（无）'}，平台级只有 compose/envfile）`);
      }
    }
  });
}

// 执行体文件是否存在（碰文件系统 ⇒ 单独一个函数，服务启动不必依赖它；self-check 会调）。
export function checkScripts(doc, root = ROOT) {
  const errs = [];
  // 归一成 `/` 再拼：目录里的路径按 **Windows 写法**登记（反斜杠），但**这道检查本身要能在 Linux 上跑**
  // （服务器 / CI / WSL）：`path.join(root, 'tools\\control.ps1')` 在 Linux 上拼出的是"文件名里带反斜杠"
  // 的路径 ⇒ 22 条假失败（2026-09-24 WSL 实测）。所以先归一：Windows 也认正斜杠，两端都对。
  const exists = (f) => fs.existsSync(path.join(root, String(f).replace(/\\/g, '/')));
  for (const a of doc.actions || []) {
    for (const name of IMPLEMENTED_PLATFORMS) {
      const entry = a.platform?.[name];
      if (!entry || typeof entry !== 'object') continue;
      const files = [];
      if (typeof entry.script === 'string') files.push(entry.script);            // win32 的外观脚本
      for (const s of entry.steps || []) if (typeof s.script === 'string') files.push(s.script);
      for (const f of new Set(files)) {
        if (!exists(f)) errs.push(`${a.id}.platform.${name}：目录里写的执行体不存在 —— ${f}`);
      }
    }
  }
  // 平台级文件（2026-09-24 第二批）：linux 的 compose / 单元文件 / .env 示例 —— 驱动要靠它们，
  // 缺一个就是"空驱动"（命令拼得出来、跑起来必失败）。**故意不查 deploy/linux/.env**：那是每台机器
  // 自己生成的（不进 git），驱动会在预检里点名让它补。
  for (const name of IMPLEMENTED_PLATFORMS) {
    const spec = doc.platforms?.[name] ?? {};
    if (spec.supported !== true) continue;
    const files = [spec.compose, spec.envExample, spec.installScript].filter((f) => typeof f === 'string' && f);
    for (const u of Object.values(spec.units ?? {})) if (u && typeof u.file === 'string') files.push(u.file);
    for (const f of files) {
      if (!exists(f)) errs.push(`platforms.${name} 里登记的文件不存在 —— ${f}（驱动要靠它跑，缺了就是空驱动）`);
    }
  }
  return errs;
}

// ── ② 纯函数查询 ─────────────────────────────────────────────────────────────
export function actionIds(doc) { return doc.actions.map((a) => a.id); }
export function findAction(doc, id) {
  const k = String(id ?? '').toLowerCase();
  return doc.actions.find((a) => a.id === k) ?? null;
}
export function postActions(doc) { return doc.actions.filter((a) => a.http?.post === true); }
export function getActions(doc) { return doc.actions.filter((a) => a.http?.get === true); }
export function postActionIds(doc) { return postActions(doc).map((a) => a.id); }
export function getActionIds(doc) { return getActions(doc).map((a) => a.id); }
export function paramSpec(action, name) { return (action?.params ?? []).find((p) => p.name === name) ?? null; }
export function paramValues(action, name) {
  const p = paramSpec(action, name);
  return Array.isArray(p?.values) ? p.values.slice() : null;
}
export function usageParts(doc) { return doc.actions.filter((a) => typeof a.usage === 'string' && a.usage).map((a) => a.usage); }
export function usageRow(doc, row) { return doc.actions.filter((a) => typeof a.usage === 'string' && a.usage && a.usageRow === row).map((a) => a.usage); }
export function jsonActionIds(doc) { return doc.actions.filter((a) => a.supportsJson === true).map((a) => a.id); }

// 要不要 {confirm:true}（§3.1 的自毁按钮）：数据说，消费方不自己判断。
export function needsConfirm(action, target = '') {
  const c = action?.http?.confirm;
  if (!c) return false;
  if (c.mode === 'always') return true;
  if (c.mode === 'targets') return (c.targets ?? []).includes(String(target ?? '').toLowerCase());
  return false;
}

// 「发起即返回」的回执里那句计划（没写就 null）。发起方（页面 / 脚本 / 别的会话）照抄它，
// 不自己编一句 —— 编出来的那句一定会跟目录漂移。
export function receiptPlan(action) {
  const p = action?.http?.receipt?.plan;
  return typeof p === 'string' && p.trim() ? p : null;
}

// single-flight 的**盘上**标记（没写 = 这条动作没有并发闸）。返回 null 表示"闸不成立"，
// 调用方（control-server.mjs 的 HTTP 面 / control.ps1 的 CLI 面）一律按"没有闸"走 ——
// 判不准时宁可放行一次，也不能因为一份读不动的标记把入口永久锁死。
export function busyGuardSpec(action) {
  const g = action?.http?.busyGuard;
  if (!g || typeof g !== 'object') return null;
  if (typeof g.marker !== 'string' || !g.marker.trim()) return null;
  if (!Number.isInteger(g.maxAgeMs) || g.maxAgeMs <= 0) return null;
  return { marker: g.marker, maxAgeMs: g.maxAgeMs };
}

// 某个平台为什么不能跑（能跑则返回 null）。给"人话错误"与 /api/control/actions 用。
export function unsupportedReason(doc, platform) {
  const p = doc.platforms?.[platform];
  if (!p || p.supported === true) return null;
  return p.reason || '未实现（目录里没写原因 —— 这本身就该被自检拦下）';
}

// 把 action + win32.args 模板拼成**给外观脚本的 argv**。占位符只许来自本动作的参数名（validateCatalog 已保）。
export function controlArgs(action, { target = '', tail = null, json = false } = {}) {
  const w = action?.platform?.win32;
  if (!w || w.driver !== 'control-ps1') throw new Error(`动作「${action?.id}」在 win32 上没有 control-ps1 执行体`);
  const args = (w.args ?? []).map((a) => a.replace(/\{target\}/g, String(target ?? '')).replace(/\{tail\}/g, String(tail ?? '')));
  if (json) {
    if (action.supportsJson !== true) throw new Error(`动作「${action.id}」不支持 -Json`);
    args.push('-Json');
  }
  return args;
}

// 给面板 / 未来平台看的目录视图：每条都能看懂"Windows 上跑什么、别的平台为什么还不能跑"。
export function describeCatalog(doc) {
  return {
    version: doc.version,
    platforms: Object.fromEntries(Object.entries(doc.platforms ?? {}).map(([k, v]) => [k, {
      supported: v.supported === true,
      driver: v.driver ?? null,
      reason: v.reason ?? null,
      note: v.note ?? null,
    }])),
    actions: doc.actions.map((a) => ({
      id: a.id,
      label: a.label,
      summary: a.summary,
      mutates: a.mutates,
      supportsJson: a.supportsJson,
      usage: a.usage ?? null,
      http: a.http,
      params: a.params,
      platform: Object.fromEntries(Object.keys(doc.platforms ?? {}).map((name) => {
        const impl = doc.platforms[name]?.supported === true;
        if (!impl) return [name, { supported: false, reason: doc.platforms[name]?.reason ?? null, action: null }];
        return [name, {
          supported: true,
          reason: null,
          action: {
            driver: a.platform?.[name]?.driver ?? null,
            script: a.platform?.[name]?.script ?? null,
            args: a.platform?.[name]?.args ?? null,
            steps: a.platform?.[name]?.steps ?? null,
            stepsNote: a.platform?.[name]?.stepsNote ?? null,
            // 2026-09-24 第二批（linux）：`applicable:false` = 这个动作在这个平台上**整段不适用**
            // （无桌面服务器上的 pages）—— 与"没实现"（整个平台是 null）不是一件事，得让消费方看得出来。
            applicable: a.platform?.[name]?.applicable !== false,
            notApplicableReason: a.platform?.[name]?.notApplicableReason ?? null,
          },
        }];
      })),
    })),
  };
}

// ── ④ 纯函数断言（测试预言：钉住契约，不是数据源）──────────────────────────────
export function runSelfTest(doc = loadCatalog()) {
  const fails = [];
  const eq = (label, got, want) => {
    const g = JSON.stringify(got); const w = JSON.stringify(want);
    if (g !== w) fails.push(`${label}：期望 ${w}，实际 ${g}`);
  };
  const byId = (id) => findAction(doc, id);

  // 动作表本身（顺序也钉住：403 的 allowed 数组就是按这个顺序输出的，面板/脚本读它）
  eq('动作表', actionIds(doc), ['status', 'up', 'down', 'restart', 'pages', 'login', 'logs', 'doctor', 'help', 'restart-stack']);
  eq('HTTP POST 动作表', postActionIds(doc), ['up', 'down', 'restart', 'pages', 'login', 'doctor', 'restart-stack']);
  eq('HTTP GET 动作表', getActionIds(doc), ['status', 'logs']);
  eq('支持 -Json 的动作', jsonActionIds(doc), ['status', 'logs', 'restart-stack']);

  // 参数枚举（四个带子参数的动作，一个字都不能变）
  eq('restart target 枚举', paramValues(byId('restart'), 'target'), ['all', 'dsh', 'bridge', 'snowluma', 'control']);
  eq('pages target 枚举', paramValues(byId('pages'), 'target'), ['open', 'close', 'wake']);
  eq('login target 枚举', paramValues(byId('login'), 'target'), ['qq', 'console']);
  eq('logs target 枚举', paramValues(byId('logs'), 'target'), ['dsh', 'bridge', 'snowluma']);
  eq('up 没有子参数', paramValues(byId('up'), 'target'), null);
  eq('logs tail 区间', [paramSpec(byId('logs'), 'tail').min, paramSpec(byId('logs'), 'tail').max, paramSpec(byId('logs'), 'tail').default], [1, 2000, 40]);
  eq('logs HTTP 夹取', byId('logs').http.tailClamp, { min: 1, max: 200, default: 20 });

  // 二次确认（自毁按钮）：down 永远要，restart dsh/all 要，其余不要
  eq('down 要 confirm', needsConfirm(byId('down'), ''), true);
  eq('restart dsh 要 confirm', needsConfirm(byId('restart'), 'dsh'), true);
  eq('restart ALL 要 confirm（大小写不敏感）', needsConfirm(byId('restart'), 'ALL'), true);
  eq('restart all 要 confirm', needsConfirm(byId('restart'), 'all'), true);
  eq('restart bridge 不要 confirm', needsConfirm(byId('restart'), 'bridge'), false);
  eq('restart snowluma 不要 confirm', needsConfirm(byId('restart'), 'snowluma'), false);
  eq('restart control 不要 confirm（它不打断 DSH 会话，只是面板灰十几秒）', needsConfirm(byId('restart'), 'control'), false);
  eq('up 不要 confirm', needsConfirm(byId('up'), ''), false);
  eq('pages 不要 confirm', needsConfirm(byId('pages'), 'open'), false);
  eq('login 不要 confirm', needsConfirm(byId('login'), 'qq'), false);
  eq('doctor 不要 confirm', needsConfirm(byId('doctor'), ''), false);

  // argv 形状（= tools\control-server.mjs 旧代码里那份 A 表，逐字对齐）
  eq('status argv', controlArgs(byId('status'), { json: true }), ['status', '-Json']);
  eq('logs argv', controlArgs(byId('logs'), { target: 'bridge', tail: 20, json: true }), ['logs', 'bridge', '-Tail', '20', '-Json']);
  eq('up argv', controlArgs(byId('up')), ['up']);
  eq('down argv', controlArgs(byId('down')), ['down', '-Yes']);
  eq('restart argv', controlArgs(byId('restart'), { target: 'dsh' }), ['restart', 'dsh']);
  eq('pages argv', controlArgs(byId('pages'), { target: 'open' }), ['pages', 'open']);
  eq('login argv', controlArgs(byId('login'), { target: 'qq' }), ['login', 'qq']);
  eq('doctor argv', controlArgs(byId('doctor')), ['doctor']);
  eq('help argv', controlArgs(byId('help')), ['help']);

  // 用法清单（cmd 面板那两行 + `[用法错误]` 后面那行，逐字钉住）
  eq('用法清单', usageParts(doc).join(' | '), 'status | up | down | restart <all|dsh|bridge|snowluma|control> | pages <open|close|wake> | login <qq|console> | logs <dsh|bridge|snowluma> [-Tail N] | doctor | restart-stack');
  eq('用法清单第 1 行', usageRow(doc, 1).join(' | '), 'status | up | down | restart <all|dsh|bridge|snowluma|control> | pages <open|close|wake>');
  eq('用法清单第 2 行', usageRow(doc, 2).join(' | '), 'login <qq|console> | logs <dsh|bridge|snowluma> [-Tail N] | doctor | restart-stack');
  eq('help 不进用法清单', byId('help').usage, null);

  // ★ 受令重启入口（2026-09-25 主人：「首先是全量启动你们要能自己来做」）：
  //   会话/脚本发一条 HTTP 就能让控制面去重启整套 —— 契约逐条钉住，别让它悄悄退化。
  eq('restart-stack 走 POST（且只走 POST）', [byId('restart-stack').http.get, byId('restart-stack').http.post], [false, true]);
  eq('restart-stack 要 confirm（它会断掉正在用的会话）', needsConfirm(byId('restart-stack'), ''), true);
  eq('restart-stack 的 argv（外观只给一个词）', controlArgs(byId('restart-stack')), ['restart-stack']);
  eq('restart-stack 没有子参数', paramValues(byId('restart-stack'), 'target'), null);
  eq('restart-stack 支持 -Json（回执是机器可读的）', byId('restart-stack').supportsJson, true);
  eq('restart-stack 的回执计划', receiptPlan(byId('restart-stack')), 'stop-all → start-all');
  eq('restart-stack 的 single-flight 标记', busyGuardSpec(byId('restart-stack')), { marker: 'qq-bridge\\state\\restart-stack.json', maxAgeMs: 300000 });
  eq('全表只有 restart-stack 有并发闸', actionIds(doc).filter((i) => busyGuardSpec(byId(i))), ['restart-stack']);
  eq('restart-stack 的 win32 真工人 = 启动器（分离进程那条路的载体）',
    byId('restart-stack').platform.win32.steps.map((s) => `${s.runner}:${s.script}`), ['cmd:一键启动.cmd']);
  eq('restart-stack 在 linux 上不是"不适用"（有等价执行体）',
    byId('restart-stack').platform.linux.applicable !== false && byId('restart-stack').platform.linux.steps.length > 0, true);

  // 平台落地状态：**没实现的平台，每条动作都必须显式 null**（绝不许假装能用）；
  // 已实现的平台每条动作都要有那个驱动的执行体。
  for (const a of doc.actions) {
    for (const [name, p] of Object.entries(doc.platforms)) {
      const impl = p.supported === true;
      if (!impl && a.platform?.[name] !== null) fails.push(`动作 ${a.id} 在 ${name} 上不是显式 null（未实现的平台必须写 null）`);
      if (impl && (!a.platform?.[name] || a.platform[name].driver !== PLATFORM_SPECS[name].driver)) {
        fails.push(`动作 ${a.id} 在 ${name} 上没有 ${PLATFORM_SPECS[name].driver} 执行体`);
      }
    }
  }
  eq('win32 是已实现平台', unsupportedReason(doc, 'win32'), null);
  eq('linux 是已实现平台（2026-09-24 第二批）', unsupportedReason(doc, 'linux'), null);
  eq('darwin 仍未实现、且原因点明"未实现"', /未实现/.test(unsupportedReason(doc, 'darwin') || ''), true);
  eq('已实现平台表', IMPLEMENTED_PLATFORMS, ['win32', 'linux']);

  // Linux 侧：每个动作要么有执行体、要么**显式**标注"整段不适用 + 原因"——
  // 后者专给无桌面服务器上的 pages：它与"没实现"（null）是两件事，绝不许留空让人猜。
  for (const a of doc.actions) {
    const L = a.platform?.linux;
    if (!L || typeof L !== 'object') { fails.push(`动作 ${a.id} 在 linux 上既没有执行体、也没标"整段不适用"`); continue; }
    if (L.applicable === false) {
      if (!(L.notApplicableReason ?? '').trim()) fails.push(`动作 ${a.id} 标了 applicable:false 却没写 notApplicableReason`);
      if ((L.steps ?? []).length) fails.push(`动作 ${a.id} 标了 applicable:false 却还有 steps`);
    } else if ((L.steps ?? []).length === 0) {
      if (!(L.stepsNote ?? '').trim()) fails.push(`动作 ${a.id} 的 linux 步骤为空却没有 stepsNote`);
    }
  }
  eq('linux 上唯一不适用的动作是 pages（无桌面服务器）', doc.actions.filter((a) => a.platform?.linux?.applicable === false).map((a) => a.id), ['pages']);

  // 每条动作都得说得清"在 Windows 上干什么"
  for (const a of doc.actions) {
    const w = a.platform?.win32;
    if (!w) { fails.push(`动作 ${a.id} 没有 win32 执行体`); continue; }
    const steps = w.steps ?? [];
    if (steps.length === 0 && !(w.stepsNote || '').trim()) fails.push(`动作 ${a.id} 的 win32.steps 为空却没有 stepsNote`);
    for (const s of steps) if (!(s.label || '').trim()) fails.push(`动作 ${a.id} 有一步没写 label`);
  }
  return { passed: fails.length === 0, fails };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
export function main(argv = process.argv.slice(2)) {
  const flag = (n) => argv.includes(n);
  let doc;
  try { doc = loadCatalog(); } catch (e) { process.stderr.write(`${e.message}\n`); return 1; }
  if (flag('--self-test')) {
    const { passed, fails } = runSelfTest(doc);
    for (const f of fails) process.stdout.write(`  ❌ ${f}\n`);
    process.stdout.write(passed ? '  ✅ 动作目录纯函数断言全过\n' : `  ❌ ${fails.length} 项不过\n`);
    return passed ? 0 : 1;
  }
  if (flag('--check')) {
    const errs = [...validateCatalog(doc), ...checkScripts(doc)];
    for (const e of errs) process.stdout.write(`  ❌ ${e}\n`);
    process.stdout.write(errs.length ? `  ❌ ${errs.length} 项不过\n` : `  ✅ 目录 OK（${doc.actions.length} 个动作；执行体文件都在）\n`);
    return errs.length ? 1 : 0;
  }
  if (flag('--clear-busy')) {
    // 撤掉某条动作的并发闸标记（restart-stack 跑完了 ⇒ 入口立刻重新可用）。
    // ★ 路径**只从目录里读**（http.busyGuard.marker）—— 启动器不该另抄一份路径。
    const id = String(argv[argv.indexOf('--clear-busy') + 1] ?? '').trim();
    const guard = busyGuardSpec(findAction(doc, id));
    if (!guard) {
      process.stdout.write(`  [撤闸] ${id || '(没给动作 id)'} 没有并发闸（http.busyGuard）—— 什么都不用做\n`);
      return 0;
    }
    const file = path.join(ROOT, guard.marker);
    try {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
        process.stdout.write(`  [撤闸] 已撤 ${guard.marker}（这一次跑完了 ⇒ 入口重新可用）\n`);
      } else {
        process.stdout.write(`  [撤闸] ${guard.marker} 本来就不在 —— 不用撤\n`);
      }
    } catch (e) {
      process.stdout.write(`  [撤闸] 撤不掉 ${guard.marker}：${e.message}（过期后自己失效，不影响启动）\n`);
    }
    return 0;
  }
  // 默认 / --json：给人看的目录
  const view = describeCatalog(doc);
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(main());
}
