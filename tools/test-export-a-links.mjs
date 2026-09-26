#!/usr/bin/env node
// tools\test-export-a-links.mjs —— 守住 `tools\export-a.mjs` 的**链接 / 硬链接 / 判据力**三条。
//
// 跑法：`node tools\test-export-a-links.mjs`（夹具全在 %TEMP%\export-a-linkgate\ 下，跑完自清；真仓库一个字节不动）
//
// 为什么单立一张网（不是塞进 export-a 的 --selftest）：这三条**验不了** —— selftest 的 ROOT 钉死在真仓库、
// 而且不许在真树里造链接。它们偏偏是"悄悄少一份 / 假绿"那一族（复核线 2026-09-26 21:5x 源码级打回）：
//   ① **顺序就是判据**：名叫 `qq-bridge` 的 junction 会被跳过名单先 `continue` 掉 ⇒ 三桶一个都不占；
//   ② **硬链接**（`mklink /H`）`isSymbolicLink()` 为 false ⇒ 结构上不可见，而内容就是同一份文件；
//   ③ **判据力**：镜像 ROOT 落在工具自己的跳过区里 ⇒ 整棵 tools\ 被静默跳过、对账照样"绿"。
// 断言分两侧：**必须红的**（坏树要拒交付）＋ **必须仍清的**（干净树不许被误伤）—— 收窄判据最容易犯的是误伤。
//
// ★ 2026-09-26 22:xx 扩到 **30 项**（复核线 r3 §2/§3/§5/§6 判词逐条落夹具）：
//   ⑥ **盲区 A**：`ROOT\tools` **整个换成 junction** ⇒ 必须 exit 4 ＋ 点名"遍历根" ＋ **不写盘**
//      （老行为：`链接 0`、exit 0、夹具外 canary 原样进产物）；另附**旧版同夹具**的反向对照。
//   ⑦ **盲区 B**：`README.md` 做成**硬链接**（DOCS 路径）⇒ 必须 exit 4 ＋ 点名"DOCS 路径·硬链接" ＋ 不写盘。
//   ⑧ **DOCS 段独立计数**：声明了但盘上没有的那条 ⇒ 必须红（老行为：照报"候选 9 = 进包 9"、零警告）。
//   ⑨ **未知参数**（`--list --no-files`）⇒ 非零退出 ＋ 打印用法 ＋ **不写盘**（老行为：静默忽略、exit 0、照写）。
//   ⑩ **跳过区口径对齐**：ROOT 落在**裸 `archive`** 里也必须 fail-loud（与 `self-check` 5.5c 同口径）。
//   ⑪ `--allow-links` 文案补「**仍不跟进**」。
//   ★ 另：`mkRepo` 现在把 **DOCS 七条一条不少**地造出来 —— 新闸"DOCS 缺一条 ⇒ 拒交付"上线后，
//     老夹具（只造 README ＋ 一份 docs）会**因为缺 DOCS 而红**，那不是这些断言要测的东西。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BASE = path.join(os.tmpdir(), 'export-a-linkgate');
const LOG = path.join(BASE, 'out.log');

let pass = 0; const fails = [];
const check = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✅ ${n}`); return; }
  fails.push(n); console.log(`  ❌ ${n}${d ? ' —— ' + d : ''}`);
};
const read = (p) => fs.readFileSync(p, 'utf8');

// 跑一个夹具里的 export-a。stdio 走**文件 fd**（受限沙箱里 pipe 会 EPERM，本族已知的坑）。
// ★ 2026-09-26 22:4x：加 `nodeFlags` —— `--preserve-symlinks-main` 是 **node 的**开关，必须在脚本**之前**。
const run = (script, args = [], nodeFlags = []) => {
  const fd = fs.openSync(LOG, 'w');
  const r = spawnSync(process.execPath, [...nodeFlags, script, ...args], { stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  return { code: r.status, text: fs.existsSync(LOG) ? read(LOG) : '' };
};

// 造一个最小仓库：tools\ 几个文件 ＋ 一份**假**身份文件（绝不复制真身份；值一眼假）
// ★ 2026-09-26 22:xx：**DOCS 七条一条不少地造出来** —— 新闸"DOCS 任一条不存在 ⇒ 拒交付 exit 4"
//   一上线，老夹具（只造 README ＋ 一份 docs）就会**因为缺 DOCS 而红**，而那不是这些断言要测的东西
//   （评审原话：判据的声明范围必须与实现一致；夹具也要跟着"干净树"的定义走）。
function mkRepo(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'qq-bridge', 'state'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'outside'), { recursive: true });   // 链接目标 —— **永远落在夹具内部**
  // ★ DOCS 清单（与 export-a.mjs 的 DOCS **逐条对应**；改了那边这里也要跟）
  //   ⚠ 2026-09-26 22:5x 甲案：那边的 docs 收到 **3 份**（README/CONTRIBUTING/LICENSE）＋示例配置
  //     ⇒ 这里同步（原来造的 4 份内部文档已不在清单里，留着会让夹具与清单对不上）。
  for (const rel of ['README.md', 'CONTRIBUTING.md', 'LICENSE', 'agent.config.example.json']) {
    const q = path.join(dir, rel);
    fs.mkdirSync(path.dirname(q), { recursive: true });
    fs.writeFileSync(q, '夹具：对外文档\n');
  }
  // ★ EXCLUDE 名单那三条也造出来（不是判据，只是让"排除桶命中数"这句提示不刷噪音）
  for (const rel of ['tools/novnc-tunnel.cmd', 'tools/push-to-server.mjs', 'tools/push-to-server.cmd']) {
    fs.writeFileSync(path.join(dir, rel), '夹具：被排除的一份\n');
  }
  fs.writeFileSync(path.join(dir, 'tools', 'aa.mjs'), '// 夹具候选 A\n');
  fs.writeFileSync(path.join(dir, 'tools', 'bb.mjs'), '// 夹具候选 B\n');
  fs.writeFileSync(path.join(dir, 'outside', 'canary.txt'), '夹具外的内容（若被带出去就是泄漏）\n');
  fs.writeFileSync(path.join(dir, 'qq-bridge', 'state', 'scan-secrets-identity.json'),
    JSON.stringify({ ownerQQ: '10001', windowsUser: 'fixture-user' }) + '\n');
  for (const name of ['export-a-new.mjs']) {
    fs.copyFileSync(path.join(REPO, 'tools', 'export-a.mjs'), path.join(dir, 'tools', name));
  }
  return dir;
}

// ★ "改前那一版"必须来自 **git 里的 blob**，不能拿当前源码复制一份 —— 那样两边是同一份代码，
//   对照就成了"自己跟自己比"（我第一版就是这么写的，三条对照全假红）。这里钉 `e5ecb64:tools/export-a.mjs`
//   （＝复核线 21:5x 打回时的 HEAD），它**永远**是改前行为。
const OLD_PIN = 'e5ecb64';
function writeOldVersion(dir) {
  const dest = path.join(dir, 'tools', 'export-a-old.mjs');
  const fd = fs.openSync(dest, 'w');
  // ⚠ stdio 走文件 fd：受限沙箱里 pipe 会 EPERM（本族已知的坑）
  const r = spawnSync('git', ['show', `${OLD_PIN}:tools/export-a.mjs`], { cwd: REPO, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  return r.status === 0 && fs.statSync(dest).size > 1000;
}

console.log('【链接/硬链接/判据力】export-a 翻转夹具（真仓库不动；夹具落在 %TEMP%\\export-a-linkgate\\）');
try {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(BASE, { recursive: true });

  // ── ① 名叫 `qq-bridge` 的 junction：跳过名单**之前**必须被收进"链接"桶 ────────────────────
  const fx1 = mkRepo(path.join(BASE, 'fx-hidden-link'));
  check(`0 前置：改前那一版（${OLD_PIN}:tools/export-a.mjs）取到了`, writeOldVersion(fx1));
  check('0 前置：新的一版**没有**把两份源码写成同一份（旧版里不含 --allow-links）',
    !/allow-links/.test(read(path.join(fx1, 'tools', 'export-a-old.mjs'))));
  fs.symlinkSync(path.join(fx1, 'outside'), path.join(fx1, 'tools', 'qq-bridge'), 'junction');
  const rNew = run(path.join(fx1, 'tools', 'export-a-new.mjs'), ['--dry-run', '--out', path.join(BASE, 'out1')]);
  check('① 新：**藏在跳过名单里的 junction** ⇒ 拒交付 exit 4', rNew.code === 4, `退出码 ${rNew.code}`);
  check('① 新：它被**点名**（不是静默少一份）', /【链接】发现 1 个链接/.test(rNew.text) && /tools\/qq-bridge/.test(rNew.text));
  check('① 新：对账把链接**算进了候选**（分母里看得到它）', /候选 \d+ 项 .*链接 1/.test(rNew.text), (rNew.text.match(/【候选对账】[^\n]*/) || ['(没印)'])[0]);
  const rOld = run(path.join(fx1, 'tools', 'export-a-old.mjs'), ['--dry-run', '--out', path.join(BASE, 'out1')]);
  check('① 旧（HEAD 版）**同一夹具**：exit 0 且**一个字都不提**那个链接（＝复核线实测的静默旁路）',
    rOld.code === 0 && !/【链接】/.test(rOld.text), `旧 exit ${rOld.code}／提到链接=${/【链接】/.test(rOld.text)}`);

  // ── ② 硬链接：`isSymbolicLink()` 为 false ⇒ 老写法完全看不见它 ─────────────────────────
  const fx2 = mkRepo(path.join(BASE, 'fx-hardlink'));
  writeOldVersion(fx2);
  fs.linkSync(path.join(fx2, 'outside', 'canary.txt'), path.join(fx2, 'tools', 'hard.txt'));
  check('② 前提：硬链接在 Node 眼里**不是** symlink', !fs.lstatSync(path.join(fx2, 'tools', 'hard.txt')).isSymbolicLink());
  const rHard = run(path.join(fx2, 'tools', 'export-a-new.mjs'), ['--dry-run', '--out', path.join(BASE, 'out2')]);
  check('② 新：硬链接 ⇒ 拒交付 exit 4', rHard.code === 4, `退出码 ${rHard.code}`);
  check('② 新：硬链接被点名（写明"硬链接"）', /硬链接/.test(rHard.text) && /tools\/hard\.txt/.test(rHard.text));
  const rHardOld = run(path.join(fx2, 'tools', 'export-a-old.mjs'), ['--dry-run', '--out', path.join(BASE, 'out2')]);
  check('② 旧（HEAD 版）：硬链接 exit 0（结构性看不见 ⇒ 内容照进产物）', rHardOld.code === 0, `旧 exit ${rHardOld.code}`);

  // ── 放行出口 ＋ 必须仍清（反向对照）────────────────────────────────────────────────
  const rAllow = run(path.join(fx1, 'tools', 'export-a-new.mjs'), ['--dry-run', '--out', path.join(BASE, 'out1'), '--allow-links']);
  check('③ `--allow-links` 显式放行 ⇒ 不再拦（exit 0）且打印"已按显式放行处理"',
    rAllow.code === 0 && /显式放行/.test(rAllow.text), `退出码 ${rAllow.code}`);
  const fxClean = mkRepo(path.join(BASE, 'fx-clean'));
  const rClean = run(path.join(fxClean, 'tools', 'export-a-new.mjs'), ['--dry-run', '--out', path.join(BASE, 'out3')]);
  check('④ ★ 必须仍清：干净树 ⇒ exit 0（这条闸**不许**误伤正常候选树）', rClean.code === 0, `退出码 ${rClean.code}`);
  check('④ 干净树读数：链接 0', /链接 0/.test(rClean.text));

  // ── ⑤ 判据力：ROOT 落在工具自己的跳过区里 ⇒ fail-loud ＋ 拒交付 ────────────────────────
  const fxSkip = mkRepo(path.join(BASE, 'state', '_archive', 'fx-in-skipzone'));
  writeOldVersion(fxSkip);
  const rSkip = run(path.join(fxSkip, 'tools', 'export-a-new.mjs'), ['--dry-run', '--out', path.join(BASE, 'out4')]);
  check('⑤ ROOT 落在跳过区 ⇒ **拒交付 exit 4**（旧行为：候选 6 = 6+0+0、exit 0、零警告 = 假绿）',
    rSkip.code === 4, `退出码 ${rSkip.code}`);
  check('⑤ 且**说清**"本次没有判据力、报绿也不算数"', /没有判据力/.test(rSkip.text) && /报绿也不算数/.test(rSkip.text));
  check('⑤ 逃生口写进了提示（--preserve-symlinks-main）', /preserve-symlinks-main/.test(rSkip.text));
  const rSkipOld = run(path.join(fxSkip, 'tools', 'export-a-old.mjs'), ['--dry-run', '--out', path.join(BASE, 'out4')]);
  check('⑤ 旧（HEAD 版）同一夹具：exit 0 且零警告（＝下一个复核员会拿到的假绿）',
    rSkipOld.code === 0 && !/没有判据力/.test(rSkipOld.text), `旧 exit ${rSkipOld.code}`);

  // ══ ★ 2026-09-26 22:xx 新增：复核线 r3 §2 的两处**盲区**（夹具外内容原样进产物）══════════════
  // ── 盲区 A：**遍历根自己**（`ROOT\tools` 整个换成 junction）──────────────────────────────
  //   ⚠ 夹具要点：`tools\` 一旦变成 junction，**脚本自己也得能从别处跑到** —— 否则 node 直接
  //     "Cannot find module"（exit 1），测的就不是链接闸了（第一版就死在这儿）。
  //     ⇒ 把两份脚本同样放一份进 junction 的**目标目录**里，从目标目录那条路跑；
  //       `import.meta.url` 解析到真实路径 ⇒ ROOT 仍是夹具根（若哪天 `--preserve-symlinks-main` 生效，
  //       ROOT 会变成"假路径"，那时③那条 fail-loud 会响 —— 两种都**不假绿**）。
  const fxRootLink = mkRepo(path.join(BASE, 'fx-rootlink'));
  writeOldVersion(fxRootLink);
  for (const n of ['export-a-new.mjs', 'export-a-old.mjs']) {
    fs.copyFileSync(path.join(fxRootLink, 'tools', n), path.join(fxRootLink, 'outside', n));
  }
  fs.rmSync(path.join(fxRootLink, 'tools'), { recursive: true, force: true });
  fs.symlinkSync(path.join(fxRootLink, 'outside'), path.join(fxRootLink, 'tools'), 'junction');
  const outA = path.join(BASE, 'outA');
  const rRootNew = run(path.join(fxRootLink, 'outside', 'export-a-new.mjs'), ['--out', outA]);   // ★ 不给 --dry-run：要验"不写盘"
  check('⑥ 盲区A：**遍历根 `tools\\` 自己是 junction** ⇒ 拒交付 exit 4', rRootNew.code === 4, `退出码 ${rRootNew.code}`);
  check('⑥ 且它被**点名**（写明"遍历根"，不是静默少一份）',
    /tools（遍历根·/.test(rRootNew.text), (rRootNew.text.match(/【链接】[^\n]*/) || ['(没印)'])[0]);
  check('⑥ 且**一个东西都不写**（产物目录没被创建 = 夹具外 canary 没被带出去）', !fs.existsSync(outA));
  const rRootOld = run(path.join(fxRootLink, 'outside', 'export-a-old.mjs'), ['--dry-run', '--out', path.join(BASE, 'outA')]);
  check('⑥ 旧（HEAD 版）同一夹具：`链接 0`、exit 0（＝复核线实测的"原样带走"）',
    rRootOld.code === 0 && /链接 0/.test(rRootOld.text), `旧 exit ${rRootOld.code}`);

  // ── 盲区 B：**DOCS 路径**（`README.md` 做成指向夹具外 canary 的硬链接）────────────────────
  const fxDocsLink = mkRepo(path.join(BASE, 'fx-docslink'));
  writeOldVersion(fxDocsLink);
  fs.rmSync(path.join(fxDocsLink, 'README.md'), { force: true });
  fs.linkSync(path.join(fxDocsLink, 'outside', 'canary.txt'), path.join(fxDocsLink, 'README.md'));
  const outB = path.join(BASE, 'outB');
  const rDocsNew = run(path.join(fxDocsLink, 'tools', 'export-a-new.mjs'), ['--out', outB]);
  check('⑦ 盲区B：**DOCS 路径是硬链接** ⇒ 拒交付 exit 4', rDocsNew.code === 4, `退出码 ${rDocsNew.code}`);
  check('⑦ 且它被**点名**（写明"DOCS 路径·硬链接"）',
    /README\.md（DOCS 路径·硬链接）/.test(rDocsNew.text), (rDocsNew.text.match(/【链接】[^\n]*/) || ['(没印)'])[0]);
  check('⑦ 且**一个东西都不写**', !fs.existsSync(outB));

  // ── ★ DOCS 任一条不存在/写错路径 ⇒ 必须红（评审 §5 备案①：老行为照报"候选 9 = 进包 9"、零警告）──
  //   ⚠ 2026-09-26 22:5x：删的必须是**当前 DOCS 里真有的一条**（原来删的是 `docs\目录地图.md`，
  //     甲案之后它已不在清单里 ⇒ 什么都不缺 ⇒ 这条断言会假红。夹具要跟着清单走。）
  const fxDocsMiss = mkRepo(path.join(BASE, 'fx-docsmiss'));
  fs.rmSync(path.join(fxDocsMiss, 'LICENSE'), { force: true });
  const rDocsMiss = run(path.join(fxDocsMiss, 'tools', 'export-a-new.mjs'), ['--dry-run', '--out', path.join(BASE, 'outD')]);
  check('⑧ DOCS 声明了但盘上没有的那条 ⇒ 必须红（exit 4 ＋ 点名那条路径）',
    rDocsMiss.code === 4 && /DOCS 候选清单里这 1 条/.test(rDocsMiss.text) && /LICENSE/.test(rDocsMiss.text),
    `exit ${rDocsMiss.code} · ${(rDocsMiss.text.match(/❌ DOCS[^\n]*/) || ['(没印)'])[0]}`);

  // ── ★ 未知参数 ⇒ **非零退出且不许写盘**（评审 §6-3：差点在真树执行的那一次）──────────────
  const outU = path.join(BASE, 'outU');
  const rUnknown = run(path.join(BASE, 'fx-clean', 'tools', 'export-a-new.mjs'), ['--list', '--no-files', '--out', outU]);
  check('⑨ 未知参数（`--list --no-files`）⇒ 非零退出', rUnknown.code !== 0, `退出码 ${rUnknown.code}`);
  check('⑨ 且打印用法 ＋ 说清"拒跑"', /不认识的参数/.test(rUnknown.text) && /^用法：/m.test(rUnknown.text));
  check('⑨ 且**一个东西都不写**（老行为：静默忽略、exit 0、照常"✅ 换名完成"）', !fs.existsSync(outU));

  // ── ★ 跳过区口径对齐（顺手②）：ROOT 含**裸 `archive`** 也必须 fail-loud ──────────────────
  const fxArchive = mkRepo(path.join(BASE, 'archive', 'fx-in-archive'));
  const rArchive = run(path.join(fxArchive, 'tools', 'export-a-new.mjs'), ['--dry-run', '--out', path.join(BASE, 'outE')]);
  check('⑩ ROOT 落在**裸 `archive`** 里 ⇒ 与 `_archive` 同口径 fail-loud ＋ exit 4（口径已对齐 self-check 5.5c）',
    rArchive.code === 4 && /没有判据力/.test(rArchive.text), `退出码 ${rArchive.code}`);

  // ── ★ r4 ②A：**realpath 位移**（"你点名的那棵树根本没被检查"）────────────────────────────
  //   ⑥ 是从 junction 的**目标**目录那条路跑的（刻意保住 ROOT）⇒ 它**结构上测不到**这一条。
  //   这一条走**文档里的命令形式**：`node <mirror>\tools\export-a.mjs`（不经目标目录、不带 flag）
  //   ⇒ Node 把**主模块** realpath 到另一棵树 ⇒ 必须 fail-loud。
  const fxShift = mkRepo(path.join(BASE, 'fx-shift'));
  // junction 目标 = **另一棵完整的镜像**（复核线的现场就是"ROOT 位移到另一棵树"，那棵树什么都有 ⇒ 旧版照跑）
  const otherTree = mkRepo(path.join(BASE, 'other-tree'));
  writeOldVersion(otherTree);
  fs.rmSync(path.join(fxShift, 'tools'), { recursive: true, force: true });
  fs.symlinkSync(path.join(otherTree, 'tools'), path.join(fxShift, 'tools'), 'junction');   // → **另一棵树**
  const outS = path.join(BASE, 'outS');
  const rShift = run(path.join(fxShift, 'tools', 'export-a-new.mjs'), ['--out', outS]);   // ★ 不给 --dry-run
  check('⑫ ★ realpath 位移：按**文档形式**（junction 路由、不带 flag）跑 ⇒ 必须 fail-loud',
    rShift.code !== 0, `退出码 ${rShift.code}`);
  check('⑫ 且说清"**ROOT 被 realpath 挪走了 ⇒ 你点名的那棵树没被检查**"',
    /ROOT 被 realpath 挪走/.test(rShift.text) && /没被检查/.test(rShift.text),
    (rShift.text.match(/❌ \*\*ROOT[^\n]*/) || ['(没印)'])[0]);
  check('⑫ 且**一个东西都不写**（点名的那棵树没被检查时也不许产出）', !fs.existsSync(outS));
  check('⑫ 逃生口：`--preserve-symlinks-main` ⇒ 根按你敲的路径算 ⇒ **不**被这条闸拦（照旧走判据⑦）',
    !/ROOT 被 realpath 挪走/.test(run(path.join(fxShift, 'tools', 'export-a-new.mjs'),
      ['--dry-run', '--out', path.join(BASE, 'outS')], ['--preserve-symlinks-main']).text));
  const rShiftOld = run(path.join(fxShift, 'tools', 'export-a-old.mjs'), ['--dry-run', '--out', path.join(BASE, 'outS')]);
  check('⑫ 旧（HEAD 版）同一夹具：exit 0（＝复核线实测的"点名那棵树没被检查却报绿"）',
    rShiftOld.code === 0, `旧 exit ${rShiftOld.code}`);

  // ── ★ `--allow-links` 文案补「仍不跟进」（行为本来就对，只是文案）─────────────────────
  check('⑪ `--allow-links` 的放行文案写明"**仍不跟进**"（别让人以为放行 = 跟进链接目标）',
    /仍不跟进/.test(rAllow.text), (rAllow.text.match(/【链接】已按[^\n]*/) || ['(没印)'])[0]);
} catch (e) {
  check('夹具准备 / 跑子进程', false, e.message);
}
// 自清：junction 先用 `cmd /c rmdir`（**不带 /s**）摘掉，再递归删整个夹具区
//   ★ 本线铁律：`rmSync(recursive)` 对 junction 的行为不值得赌；先摘链接再删目录才是稳的。
for (const j of [path.join(BASE, 'fx-hidden-link', 'tools', 'qq-bridge'), path.join(BASE, 'fx-rootlink', 'tools'), path.join(BASE, 'fx-shift', 'tools')]) {
  try { if (fs.existsSync(j)) spawnSync('cmd', ['/c', 'rmdir', j], { stdio: 'ignore' }); } catch { /* 已不在 */ }
}
fs.rmSync(BASE, { recursive: true, force: true });
// ── ★ 项数下限闸（2026-09-26 22:xx 补；口径与三件套**逐字一致**）──────────────────────────
//   治"**静默跳过一条判据**"这一整类。★★ 比 **`ran`（本轮实际跑了几条）**，不比 `pass`：
//   比 `pass` 时真失败也会触发它、并给出**错误诊断**"有判据被静默跳过"；跳过 1 条、别处 +1 条 ⇒ 也看不见。
//   ⚠ 本网**没有** skip 路径（夹具造不出来时一律 `check(…, false)` **记红**）⇒ `skipCount` 恒为 0；
//     记账入口留着，是为了让人**有地方**记，而不是顺手写 `check(name, true)` 把它变得完全隐形。
//   ★ 下限数字**只写一处**；来源 = 本批实测项数。★★ **改它 = 改判据**：走"守门人改动"纪律
//     （先自首 ＋ 给 `DSH_SELFTEST_FLOOR=<旧值>` 与默认值的**新旧对照**读数）。
const SELFTEST_FLOOR = Math.max(35, Number(process.env.DSH_SELFTEST_FLOOR) || 0);
const ran = pass + fails.length;
if (ran < SELFTEST_FLOOR) fails.push(`项数下限闸：本轮只跑了 ${ran} 项 < 下限 ${SELFTEST_FLOOR}（有判据被静默跳过 ⇒ 不许报绿）`);
console.log(fails.length
  ? `❌ 链接网：${pass} 通过 / ${fails.length} 失败（共跑 ${ran} 项）—— ${fails.join('；')}`
  : `✅ 链接网：${pass} 项全通过（共跑 ${ran} 项；两侧夹具：必须红 ＋ 必须仍清）`);
process.exit(fails.length ? 1 : 0);
