#!/usr/bin/env node
// tools\export-a.mjs —— **A 档「对外版」生成器**（把内部文档里的真值换成可读占位，产出对外副本）
//
//   node tools\export-a.mjs                 # 生成到 generated-export-a\（默认；该目录已被 .gitignore 忽略）
//   node tools\export-a.mjs --dry-run       # 只算不写（打印计划与逐份替换数）
//   node tools\export-a.mjs --json          # 机器可读摘要（给报告/别的程序）
//   node tools\export-a.mjs --selftest      # 判据自检（纯内存夹具 ＋ 少量 %TEMP%/_tmp 夹具；**不写成品、不碰真仓库**）
//   node tools\export-a.mjs --allow-links   # ★ 显式放行"候选树里有链接"（默认 = 拒交付 exit 4，见判据⑦；放行也**仍不跟进**）
//
// ★★ 参数面是**封闭**的（就上面这 5 个）：**不认识的参数 ⇒ 打印用法 ＋ 非零退出**，且跑在**任何动作之前**
//   （2026-09-26 22:xx 复核线 r3 §6-3 立的闸）。立案现场：`--list --no-files` 这个**不存在的参数**被
//   `has()` **静默忽略** ⇒ 以为是干跑，实际**照常写盘**、`✅ 换名完成`、**exit 0**（差点在真树执行）。
//
// ── 它解决什么 ───────────────────────────────────────────────────────────────
// A 档 = 面向**不特定人**的公开产出。`docs\对外发布清单.md` 里原本就写着"真值换成可读占位"
// （号写 `<主人QQ>` / `<群A>`、路径写 `C:\Users\<你>\…`）—— 本工具把那条口径**自动化**：
// 读**本地身份文件**当替换表，机械地把真值替换掉，产出副本。**原件一个字节都不动**（逐份哈希比对）。
//
// ── ★ 分层门槛（L1/L2，2026-09-26 21:1x 协调线拍板）────────────────────────────
// A 档的硬闸**不是**"`scan-secrets` 报 0 处"（那对"技术文档 ＋ 我们自己的脚本"不可达：`token`/`session`
// 这类**词**、日期/端口/退出码这类**形状**都会被点名，而它们不含身份）—— 是 **L1**：
//   · **L1 = 真身份**：命中证据里出现身份文件登记的真值（ownerQQ / groupIds / serverAccount /
//     serverHostPattern 的正则匹配 / 真用户名路径 / 真 IP）⇒ **必须 0 处**，本工具**机械判定**，
//     L1 不为 0 ⇒ **拒交付**（退出码 3 并删掉产物，照 `pack-new.mjs` 的规矩）。
//   · **L2 = 字样/形状**（token/session/cookie 词 · 日期/端口/退出码数字串 · `¥` · 假 UUID ·
//     github/npm/阿里云地址 · `0.0.0.0`）⇒ **不拦，但逐份如实列数**（进报告与清单）。
//   ★ 一句必须跟着读数一起传的话：**「A 档通过 ≠ `scan-secrets` 0 处」** —— L1 才是硬闸，L2 是如实披露。
//   ★ 本工具**不改** `scan-secrets` 的判据（一个字都不改）：L1/L2 是 A 档自己的门槛。
//
// ── 判据（四条；协调线 21:1x 认过）────────────────────────────────────────────
//   ① **幂等**：同一份输入跑第二遍字节不变（占位符里不含真值）
//   ② **原件零改动**：候选逐份哈希前后比对
//   ③ **fail-closed**：替换表推不出（身份文件缺失/为空）⇒ **不产出**，退出码 2 并说清缺什么
//   ④ **逐份取证**：每份副本单独进 `scan-secrets --json`，L1/L2 分开数
//
// ── ★ 2026-09-26 20:5x 复核线打回后的加固（协调线派单；⑤⑥ 是新增的破坏性/正确性防护）──────
//   ⑤ **`--out` 白名单（破坏性防护）**：只允许落在 仓库根的 `generated-*`／`%TEMP%` 之下／
//      `qq-bridge\state\_archive\tmp-*` 之下；**空值 / 仓库根 / 仓库根的祖先 / 被扫描的源目录**
//      一律拒 ⇒ 退出码 2，**一个东西都不删**（拒绝发生在任何删除之前）。
//      为什么必须有：落盘那一步会先清理目标目录，而 `--out docs` / `--out .` 会**先删真源码树**。
//   ⑥ **原子落盘**：先写**同卷暂存目录**（`.<名字>.building-<pid>`）⇒ 逐份取证 ⇒ **过了才整体换名**
//      （旧成品先改名成 `<名字>.old-<pid>`，换名成功后再删）。⇒ 中途失败或被拒时**旧成品原样保留**；
//      旧写法是"先删了再写"，一撞 `EPERM` 就只剩半棵树、却看起来像成品。
//   ★ L1 判定口径（复核线打回 (a)(b) 后收紧 —— 判定侧与替换侧必须同一口径，否则两边都能漏）：
//     · **大小写无关**：原来判定侧 `s.includes(v)` 是大小写敏感的，而 `scan-secrets` 的身份规则是 /gi
//       ⇒ 把用户名**改个大小写**（首字母大写那种）就会**照发**（复核线实测 exit 0 / L1=0 / 那行仍在产物里）；替换侧同样收紧。
//       ★ 顺手一条实证（2026-09-26 20:5x 本工具自己测出来的）：写这段口径注释时**把那个变体抄进了本文件**，
//         于是产物里就带着 2 处身份变体 —— 旧闸（按 label 类算 + 大小写敏感）放行，**新的独立对账当场点名**
//         （`L1exact 明细：tools/export-a.mjs —— 本机用户名×2`）⇒ 注释里也别抄真值/变体，这条不是洁癖。
//     · **逐处看证据串**：L1 =「命中里**真的含真值的证据串**」条数，**不再**按 label × 该类出现总数算
//       —— 那会把同一 label 下不含身份的形状（日期/端口数字串）也算成身份 ⇒ 读数虚高。
//     · 另加一条**独立对账数 `L1exact`**：拿身份表逐份在**产物文本**里数真值的实际出现次数（大小写无关）。
//       硬闸取严 = `L1 > 0 || L1exact > 0`。为什么值得多这一条：`scan-secrets` 的身份规则里**没有"裸用户名"**
//       这一类（只有 `C:\Users\<名>` 那种路径形状）⇒ 只看命中证据会漏掉"裸用户名被带出去"。
//   ⑦ **链接 ⇒ 拒交付**（★ 2026-09-26 21:5x 复核线打回 ＋ 协调线裁决：**推翻** 21:2x 的"链接不判红"）：
//      遍历里遇到 symlink/junction/硬链接 **一律不进 A 档并逐个列出**，而且**默认就是硬闸**（见 ⑧）。
//      ★ 为什么"不判红"是错的（复核线实测）：把 `tools\grp`（3 份真候选）换成 junction 后，那 3 份
//      **从"候选"这一层就不再被枚举**（遍历遇到链接就停，不下钻）⇒ **任何数量算式都看不出少了东西**
//      ⇒ "对账对得上" **≠** "成品是完整的"。⇒ 导出这一步的口径：**链接出现 = 候选树不是它看起来的样子**，
//      必须**人看一眼**才放行 —— `--allow-links` 是那个显式出口（★ 不留出口的话，下一个人会把闸注释掉）。
//      ★★ **本判据的声明范围（2026-09-26 22:xx 收窄；复核线 21:5x 实测出两处盲区之后）**：
//        「**`tools\` 遍历到的条目** ＋ **遍历根（`ROOT\tools` 自己）** ＋ **每一条 DOCS / EXCLUDE 路径**
//        里出现 symlink / junction / 硬链接 ⇒ exit 4」
//        ⚠ 老声明只写"候选树里出现链接"，读起来像全包住了，而实测**有两处漏在范围之外**：
//          (**A**) `ROOT\tools` **整个换成 junction** ⇒ 遍历**从它开始**，没人判这个根 ⇒ `链接 0`、exit 0，
//                而产物里**原样进了夹具外的 canary**；
//          (**B**) `README.md` 做成**硬链接**（DOCS 路径是 `path.join(ROOT,rel)` 直读，主循环只有 `existsSync`）
//                ⇒ `链接 0`、exit 0，canary 原文进产物。
//        ⇒ **声明的范围必须与实现逐条对齐**：覆盖不了就**收窄声明**，别让读的人以为管住了
//          （复核线 r3 §6-2 的原话："判据的声明范围必须与实现一致"）。
//   ⑧ **候选数量守恒**（2026-09-26 21:3x 立；★ 21:5x 修**恒真**）：`候选 = 进包 ＋ 排除 ＋ 链接（逐个列出）`，
//      差值不是 0 ⇒ **拒交付（exit 4）**。★ 复核线 21:5x 源码级打回：第一版的 `total` 写作
//      `list.length + links.length`，而 `cand` / `skipped` 正是 `list` 按 `isSkipped` 的 **filter 分割**
//      （filter 不改原数组 ⇒ 两者相加恒等于 `list.length`）⇒ **`sum ≡ total` 是恒等式** ⇒
//      这条闸 **和自检里那条合取项都是死代码**（自检照旧 11/0 全绿 = **绿在恒真上**）。
//      ⇒ 现在 `total` 由**遍历时独立计数**（`seen`，**分桶之前**数一遍），**不许拿分桶结果反推**；
//      并在自检里另立一条**合成数**断言：对**人为造出的坏数**必须判不守恒（只用真树跑一遍证明不了它不是恒等式）。
//
// ── 边界 ─────────────────────────────────────────────────────────────────────
//   · 只写 `generated-export-a\`（`--out` 可换）；**不 git init、不 push、不出网**
//   · 探针/日志只落 `qq-bridge\state\_tmp\`
//   · 明确**不带**：整个 `qq-bridge\`（上游无许可 ⇒ 使用者自己 clone ＋ 跑裁剪脚本）· `AGENTS.md`
//     （含本机路径口径，待主人拍）· `docs\对外发布清单.md`（那是我们自己的发布台账）
//   · ★ **排除三份带真值/连我们服务器的工具**（协调线裁决；2026-09-26 21:2x 追加第三份）：
//     `tools\novnc-tunnel.cmd` · `tools\push-to-server.mjs` · ★ `tools\push-to-server.cmd`
//     —— 最后那份是**同族包装**：它调用的 `.mjs` 不在包里 ⇒ 对外人是**坏件**，且提到我们 key 的路径约定。
//   ★ **判据⑧ 候选数量守恒**：候选 = 进包 ＋ 排除 ＋ 链接（逐个列出），差值不是 0 ⇒ **拒交付 exit 4**。
//     ★ DOCS 段（2026-09-26 22:xx 修**恒等**）：`seen` 以前起步就是 `DOCS.length`，而那 7 条与 `cand` 里那 7 条
//     **同源** ⇒ 该段**恒等**、等于什么都没验（实测：镜像里 7 条 DOCS 只剩 1 条，仍报"候选 9 = 进包 9"、
//     **零警告**）。⇒ 现在**逐条 lstat**：拿到就按"链接 / 普通文件"分桶，拿不到就进 `missingDocs`
//     ⇒ **任一条 DOCS 不存在 / 路径写错 ⇒ 单独红灯 ＋ 拒交付**。
//   ★ **判据⑦ 链接**：见上（**范围 = tools\ 遍历到的条目 ＋ 遍历根 ＋ 每条 DOCS/EXCLUDE 路径**）；
//     出现链接 ⇒ **exit 4 且一个东西都不写**；确认无误后用 `--allow-links` 显式放行
//     （那时才继续，并打印"已按显式放行处理 N 个链接（**仍不跟进**）"）。
//   ★ **判据⑨ 未知参数**：不在参数面里的一律 ⇒ 打印用法 ＋ exit 2，且**跑在任何动作之前**（见文件头）。
//   ⚠ 残余（**只记不修**，2026-09-26 22:xx）：① 名叫 `state` 的**硬链接文件** —— 跳过名单在硬链接检查
//     **之前** `continue` ⇒ 它看不见，但**也不会进包**（跳过的条目压根不入候选）⇒ **不漏**，低危；
//     ② `qq-bridge\state\_tmp\export-a-scan.json` **从不清理** ⇒ ★ **已修**（2026-09-26 23:5x 第九代派单 ③6②）：
//     口径 = **谁写谁清、一次调用一清、self-check 不看它**（先读进内存再删 ⇒ 失败路径也删）。代码见 `scanPaths()`。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARGV = process.argv.slice(2);
const has = (f) => ARGV.includes(f);

// ── ★★ 判据⑩：**realpath 位移 ⇒ fail-loud**（2026-09-26 22:4x，复核线 r4 ②A 打回）──────────
//   立案现场（复核线实测）：按**文档里的命令形式**跑（`cd op-repo ; node tools\export-a.mjs`，
//   **不带** `--preserve-symlinks-main`）而 `tools\` 是个 junction 时 —— Node 把**主模块**
//   realpath 到 junction 指向的那棵树 ⇒ `import.meta.url` 落在**另一棵树**里 ⇒ ROOT 跟着位移、
//   判据⑦ **一个链接都收不到**，于是印「候选 81 = 78+3+0」＋「✅ A 档对外副本已生成（78 份）—— L1=0」、
//   **exit 0** —— 而**你点名的那棵树根本没被检查**，产物还落在另一棵树里。
//   判据（本机实测 Node 行为，见交付报告）：**主模块的 `import.meta.url` 默认就是 realpath**，
//   而 `process.argv[1]` 是**你敲的那个路径** ⇒ 拿这两条各自推出"仓库根"，**不一致 = 位移**。
//   ★ 为什么比的是这个而不是 `fileURLToPath(import.meta.url) !== realpathSync(...)`：
//     实测那两者**默认就相等**（Node 已经 realpath 过了）⇒ 比它恒为 false，等于没判。
//   ★ 为什么只比"根"不比"路径"：同一个仓库被两种路径指到 ⇒ **没有少检查任何东西**，不该误红；
//     而带 `--preserve-symlinks-main` 时 `import.meta.url` 就是你敲的路径 ⇒ 根相同 ⇒ 该逃生口照旧可用。
function rootShift() {
  const urlPath = fileURLToPath(import.meta.url);              // 真正算 ROOT 的那条路径
  const argvPath = process.argv[1] ? path.resolve(process.argv[1]) : urlPath;   // 你敲的那条
  const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
  const rootOf = (p) => {
    const d = path.resolve(path.dirname(p), '..');
    try { return fs.realpathSync(d); } catch { return d; }
  };
  let real = urlPath;
  try { real = fs.realpathSync(urlPath); } catch { /* 读不到就按原样显示 */ }
  const rootNamed = rootOf(argvPath);
  const rootModule = rootOf(urlPath);
  return { urlPath, argvPath, real, rootNamed, rootModule, shifted: norm(rootNamed) !== norm(rootModule) };
}
{
  const S = rootShift();
  if (S.shifted) {
    console.error('❌ **ROOT 被 realpath 挪走了 ⇒ 你点名的那棵树没被检查**（判据⑩，拒跑：一个东西都没动）');
    console.error(`   你敲的路径：${S.argvPath}　⇒ 从它推出来的仓库根：${S.rootNamed}`);
    console.error(`   实际加载的模块：${S.urlPath}　⇒ 本次真正会检查的仓库根：${S.rootModule}`);
    console.error('   为什么：Node 把**主模块** realpath 到链接（junction/symlink）指向的那棵树 ⇒');
    console.error('           遍历根、DOCS、身份文件全跟着换了一棵树 ⇒ 判据⑦ 一个链接都收不到，却照样 exit 0。');
    console.error('   处置（★ 两条的代价差很远）：① **首选** —— 用**真实路径**调它，别经 junction/symlink 路由；');
    console.error('                  ② 加 `--preserve-symlinks-main`（那时 import.meta.url 才按你敲的路径算，根就一致了）');
    console.error('                     ⚠ **只加这个 flag 往往还不够**（第九代派单 ③4 补全）：你点名的那棵树里通常**就有那条链接**');
    console.error('                     （你正是经它路由过来的）⇒ 接着会撞**判据⑦「候选树里有链接」⇒ exit 4**；');
    console.error('                     要**再加 `--allow-links`** 才 exit 0，而放行**仍不跟进**链接目标');
    console.error('                     ⇒ 进包的只剩你点名那棵树里**真实存在**的那几份（实测：整棵 tools\\ 都是链接时只剩 **7 份**）。');
    console.error('                     ⇒ 只想"先看一眼"就用 `--dry-run`，**别拿这个 flag 去凑绿**。');
    process.exit(2);
  }
}

// ── ★★ 判据⑨：**不认识的参数 ⇒ 打印用法 ＋ 非零退出**（2026-09-26 22:xx，复核线 r3 §6-3 立的闸）──
//   为什么必须有（现场事故，差点在**真树**上执行）：`--list --no-files` 这个**不存在的参数**被 `has()`
//   **静默忽略** ⇒ 命令照常跑完、**照常写盘**、印 `✅ 换名完成`、**exit 0** —— 复核线以为在干跑，
//   实际重写了成品。★ 教训："我没给参数" **≠** "它按我以为的跑"。
//   ⇒ 本工具的参数面是**封闭**的（就这 5 个），"不认识"只可能是打错/记错 ⇒ 必须**响亮地停下**。
//   ⚠ 顺序：跑在**任何**动作之前（含 --selftest、含 --out 护栏、含删任何东西之前）。
const KNOWN_FLAGS = new Set(['--dry-run', '--json', '--selftest', '--allow-links', '--out']);
const USAGE = `用法：node tools\\export-a.mjs [--dry-run] [--json] [--selftest] [--allow-links] [--out <目录>]

  （不带参数）     生成到 generated-export-a\\
  --dry-run       只算不写（打印计划与逐份替换数）
  --json          机器可读摘要
  --selftest      判据自检（纯内存夹具 ＋ 少量 %TEMP%/_tmp 夹具；不写成品、不碰真仓库）
  --allow-links   显式放行"候选树里有链接"（默认 = 拒交付 exit 4；★ 放行也**仍不跟进**链接）
  --out <目录>    换产物目录（白名单：仓库根 generated-* / %TEMP% 之下 / qq-bridge\\state\\_archive\\tmp-*）

不认识的参数 ⇒ 打印本用法 ＋ exit 2（**一个东西都不动**）。`;
// 纯函数：挑出「不在参数面里」的 token。`--out` 的值由它自己吃掉（值缺了也算参数错）。
const unknownArgs = (argv) => {
  const bad = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') { const v = argv[i + 1]; if (!v || v.startsWith('-')) bad.push('--out（缺值）'); i++; continue; }
    if (a.startsWith('-')) { if (!KNOWN_FLAGS.has(a)) bad.push(a); continue; }
    bad.push(a);   // 位置参数：本工具一个都不认（`--out` 的值已在上一步吃掉）
  }
  return bad;
};
{
  const bad = unknownArgs(ARGV);
  if (bad.length) {
    console.error(`❌ 不认识的参数：${bad.join('、')} ⇒ **拒跑：一个东西都没动**（本闸跑在任何动作之前）。`);
    console.error(USAGE);
    process.exit(2);
  }
}

const DRY = has('--dry-run');
const JSON_OUT = has('--json');
const SELFTEST = has('--selftest');
// ★ 判据⑦（2026-09-26 21:5x）：链接默认**硬闸**，这个开关是**显式出口**。
const ALLOW_LINKS = has('--allow-links');
const OUT_REL = (() => { const i = ARGV.indexOf('--out'); return i >= 0 && ARGV[i + 1] ? ARGV[i + 1] : 'generated-export-a'; })();
const OUT = path.isAbsolute(OUT_REL) ? OUT_REL : path.join(ROOT, OUT_REL);
const IDENTITY_REL = path.join('qq-bridge', 'state', 'scan-secrets-identity.json');
const TMP = path.join(ROOT, 'qq-bridge', 'state', '_tmp');
const log = (s) => { if (!JSON_OUT) console.log(s); };

// ── 候选清单（带判据；要改先改 docs\对外发布清单.md §1/§2）──────────────────────
// ★★ 2026-09-26 22:4x **甲案**（主人拍板；协调线"上传前体检"实测 `1197086`）：A 档的 docs
//   **只留** `README.md` ＋ `CONTRIBUTING.md`（＋ `agent.config.example.json`）。立案依据：
//   `node tools\scan-secrets.cjs generated-export-a` ⇒ **❌ 6 个文件、299 处硬命中**；
//   而**只扫 `README.md` ＋ `CONTRIBUTING.md` ⇒ ✅ 0 处** ⇒ 299 处**全部来自下面被去掉的那 4 份**。
//   ★ 那**不是**真值泄漏（匹配到的是 `token=…` 占位 / `dsh.authToken` 字段名 / `¥` / `2592000` 这类数字），
//     而是**它们写的是我们自己**的拓扑、令牌流程、成本台账 ⇒ **属 C 档，不该进公开成品**。
//   ⚠ 这 4 份**留在 C 档，内容一个字不动**：`docs\qq-agent-产品设计.md` · `docs\启动与踩坑.md` ·
//     `docs\目录地图.md` · `docs\部署到服务器.md`。⇒ 成品份数 78 → **74**（71 tools ＋ 这 3 份）。
const DOCS = [
  ['README.md', '对外主文档（根）'],
  ['CONTRIBUTING.md', '★ 贡献/自建说明（对外版；与 README 同级，2026-09-26 主人批准）'],
  ['LICENSE', '★ MIT 许可全文（根；2026-09-26 主人拍板"许可定为 MIT"，与 README/CONTRIBUTING 同级）'],
  ['.gitattributes', '★ 行尾写死（.cmd/.bat = CRLF，其余 LF；2026-09-26 加，与根文档同级）'],
  ['docs/安装.md', '★ **对外安装文档**（面向使用者；2026-09-26 协调线第九代派单 ① —— 从内部 4 份改写、去掉令牌链/端口/台账/花费）'],
  ['docs/工具一览.md', '★ **对外工具一览**（面向使用者；同上。⚠ 只列脚本与"什么时候用"，不抄易过期说明）'],
  ['docs/省词元与稳定性.md', '★ **对外策略文档**（为什么做这个 ＋ 省钱口径 ＋ 稳定性踩坑；2026-09-27 协调线批次 C，主人已批"只要不涉及我的账号信息"；该批微调改名以避开硬禁字样）'],
  ['agent.config.example.json', '环境层模板（纯占位）'],
];
const EXCLUDE_A = [
  ['tools/novnc-tunnel.cmd', '▲ 带我们的服务器地址/账号；对外人没用（协调线裁决：A 档不带）'],
  ['tools/push-to-server.mjs', '▲ 同上（"推代码到我们服务器"的工具）'],
  ['tools/push-to-server.cmd', '▲ **上面的同族包装**：它调用的 .mjs 不在包里 ⇒ 对外人是**坏件**，且提到我们 key 的路径约定。★ 2026-09-26 21:2x 复核发现＋协调线裁决：**一对一起走**（成品 77→76）'],
];
// ★ 跳过区（2026-09-26 22:xx **口径对齐**，复核线 r3 §5 备案②）：以前这里是 `_tmp|_archive`，**没有裸 `archive`**，
//   而 `self-check` 5.5c 的 `PS1_RECORD` 是 `archive|_archive|_tmp` ⇒ 同一个"记录/草稿区"两个工具两套口径
//   —— 症状：ROOT 含 `\…\archive\mirror-d` 时本工具**不印** fail-loud、照旧 exit 0（假绿的另一副面孔）。
//   ⇒ 对齐成 `archive|_archive|_tmp`（**理由**：三处都是"记录/草稿区"，判据力口径必须一致；
//   `self-check` 那条已经因为同一件事踩过一次）。★ 实测今天真树 `tools\archive` **不存在**
//   ⇒ 这次对齐对**当前读数零影响**（候选仍是 81），但下一棵树就不会再漏。
const WALK_SKIP = /[\\/](node_modules|SnowLuma|\.npm-cache|backups|\.git|state|_tmp|_archive|archive|qq-bridge)[\\/]/i;

// ★ 硬链接判定（追加②，2026-09-26 21:5x）：`mklink /H` 造的硬链接在 Node 里**不是** symlink
//   （`isSymbolicLink() === false`）⇒ 结构上完全不可见，可内容就是同一个文件（指向夹具外的 canary 时，
//   内容照进产物）。判据 = `statSync().nlink > 1`。⚠ 读数先摆着：真仓库实测 **0 个**（--selftest ⑩b 明细里报）。
//   若哪天某个文件系统天然报 `nlink > 1`，正确处置是**如实报出来 ＋ 在这里记残余**，不是把判据删掉
//   —— 假绿比误报贵得多（本线今天的教训就是"绿在不该绿的地方"）。
function isHardLink(p) {
  try { const st = fs.statSync(p); return st.isFile() && st.nlink > 1; } catch { return false; }
}
// ★★ **链接判定统一入口**（2026-09-26 22:xx 收窄判据⑦ 声明后新立）：给一个路径，回一个**类名**或空串。
//   为什么要统一：以前只有 `walk()` 内部判链接 ⇒ **遍历根自己**与**每条 DOCS/EXCLUDE 路径**没人判
//   （复核线实测的两处盲区 A/B：canary 原样进产物）。现在这三段走**同一个**函数，口径不可能再分叉。
function linkKindOf(p, st = null) {
  try {
    const s = st || fs.lstatSync(p);
    if (s.isSymbolicLink()) return '符号链接/junction';
    return isHardLink(p) ? '硬链接' : '';
  } catch { return ''; }
}

// ★ ③「本次没有判据力」（2026-09-26 21:5x 复核线实测打回）：镜像 ROOT 若落在**本工具自己的跳过区**里
//   （复核线用的规定落点 `…\qq-bridge\state\_archive\tmp-20260926\…` 正好命中 `WALK_SKIP` 里的 `_archive`）
//   ⇒ 整棵 `tools\` 被静默跳过、候选只剩 DOCS **6 份**、`6 = 6 + 0 + 0` **对账还"绿"**、**exit 0、零警告**
//   —— 而镜像里明明摆着 3 个 junction ⇒ **下一个复核员必然拿到假绿**。
//   ⇒ 照 `self-check` 5.5c 那条口径 **fail-loud**：**没有判据力就别报绿、也别产出**。
//   ★★ 处置**只有一条有效**（2026-09-26 22:xx 复核线 r3 §3 实测更正）：**把 ROOT 挪出跳过区**。
//      ⚠ **`--preserve-symlinks-main` 治不了这条**：它只影响"脚本自身路径怎么解析"，而 `NO_JUDGE`
//      判的是 **ROOT 的路径字符串**里有没有 `archive/_archive/_tmp` ⇒ 实测**只加 flag 仍然 exit 4**
//      （复核线实测原话：**flag 必须配「干净路径字符串」才管用**）。★ 别再让人照那句错的试。
const NO_JUDGE = WALK_SKIP.test(ROOT + path.sep);

// ── 候选枚举（`root` 可换 ⇒ 自检能拿**假仓库**打它，见 --selftest ⑫）────────────────
function candidates(root = ROOT) {
  const list = [];
  const links = [];
  const missingDocs = [];      // ★ DOCS 声明了但盘上没有（单独红灯，见主流程）
  const excludeProblems = [];  // ★ EXCLUDE 名单项的链接判定与遍历结果不一致（fail-loud）
  let seen = 0;                // ★ 判据⑧：**遍历时独立数出来的原始条目数**（**分桶之前**数一遍）
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).replace(/\\/g, '/');
      // ★★ **顺序就是判据**（2026-09-26 21:5x 复核线实测打回）：链接/硬链接**必须在跳过名单之前**判 ——
      //   名叫 `qq-bridge` 的 junction 会被 `WALK_SKIP` 在 `isSymbolicLink()` **之前** `continue` 掉
      //   ⇒ **三桶一个都不占**（地面真值 13 条目、只算到 12）⇒ 对账"绿"却对不上地面。
      //   名单管的是"**别往下钻**"，而链接本来就不钻 ⇒ 先收链接**不会**把跳过区的**内容**带进来
      //   （跳过区里的链接仍然收不到：那个**目录**在第 3 步就被 continue 了，压根没进它的 readdir）。
      if (e.isSymbolicLink()) { seen++; links.push(rel); continue; }
      if (WALK_SKIP.test(p + path.sep)) continue;
      if (e.isDirectory()) { walk(p); continue; }
      // ★ 硬链接（`mklink /H`）**结构性不可见**（追加②，2026-09-26 21:5x）：`isSymbolicLink()` 为 false、
      //   `isDirectory()` 也为 false ⇒ 老写法把它当普通文件收下、**内容照进产物**，而"链接"清单上
      //   一个字都没有（复核线实测：指向夹具外 canary 的硬链接 ⇒ canary 命中 1、`L1 = 0` 照过）。
      if (isHardLink(p)) { seen++; links.push(rel + '（硬链接）'); continue; }
      seen++;
      list.push({ rel, why: 'tools\\ 整目录' });
    }
  };
  // ── ① DOCS 候选路径：**逐条独立判定**（2026-09-26 22:xx 修恒等 ＋ 堵盲区 B）──────────────
  //   老写法 `seen` 起步 = `DOCS.length`，而那 7 条与 `cand` 里那 7 条**同源** ⇒ 该段**恒等**
  //   （实测：镜像里 7 条 DOCS 只剩 1 条，仍报"候选 9 = 进包 9"、**零警告**）。
  //   老写法还**从没判过链接**（路径是 `path.join(ROOT,rel)` 直读，主循环只有 `existsSync`）
  //   ⇒ `README.md` 做成硬链接就能把夹具外的 canary **原样**带进产物（盲区 B）。
  //   ⇒ 现在：**先 lstat 每一条** —— 拿不到 ⇒ `missingDocs`（红灯）；拿到 ⇒ 按"链接/普通文件"分桶。
  for (const [rel, why] of DOCS) {
    const abs = path.join(root, rel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { missingDocs.push(rel); continue; }
    seen++;
    const kind = linkKindOf(abs, st);
    if (kind) { links.push(`${rel}（DOCS 路径·${kind}）`); continue; }
    list.push({ rel, why });
  }
  // ── ② **遍历根自己**（2026-09-26 22:xx 堵盲区 A）────────────────────────────────────
  //   老写法只判 `ROOT\tools` **里面**的条目 ⇒ 把整个 `tools\` 换成 junction，遍历就**从链接开始**、
  //   没人判这个根 ⇒ `链接 0`、exit 0，而产物里**原样**进了夹具外的 canary（复核线实测）。
  //   ★ 口径与"链接不下钻"一致：根是链接 ⇒ 只记链接、**不进它**（`--allow-links` 也仍不跟进）。
  //   ⚠ 分桶守恒：**普通目录不进 `seen`**（walk 只数叶子条目，子目录也不算）⇒ 干净的根计数不变，
  //     链接的根 +1 且落在 `links` 桶 ⇒ 等式两边同时对得上。
  const toolsRoot = path.join(root, 'tools');
  const rootKind = linkKindOf(toolsRoot);
  if (rootKind) { seen++; links.push(`tools（遍历根·${rootKind}）`); }
  else walk(toolsRoot);
  // ── ③ EXCLUDE 路径的链接判定：**独立复核**（判据⑦ 收窄声明里点名的第三段）──────────────
  //   为什么不重复入桶：`tools\` 下的 EXCLUDE 条目本来就由 walk 收（链接在跳过名单**之前**判），
  //   再入一次桶会让守恒式当场破掉（同一条目进两个桶）。⇒ 这里做的是**核对**：
  //   "名单上这一条，本趟到底看没看到？盘上它是不是链接？"对不上就 fail-loud。
  for (const [rel] of EXCLUDE_A) {
    const abs = path.join(root, rel);
    let st = null;
    try { st = fs.lstatSync(abs); } catch { continue; }        // 名单项在树里不存在：另有"命中数"提示，不算错
    const kind = linkKindOf(abs, st);
    if (!kind) continue;
    const norm = rel.replace(/\\/g, '/');
    if (!links.includes(norm) && !links.includes(`${norm}（硬链接）`)) {
      excludeProblems.push(`${norm}：盘上是${kind}，但本趟的链接清单里没有它 ⇒ 判据⑦ 没覆盖到它`);
    }
  }
  // ★ 排除名单必须**真生效**（2026-09-26 21:3x 修：第一版只打印不筛 ⇒ 干跑里那 4 处替换全落在被排除的两份上）
  // ★ 判据⑧（2026-09-26 21:3x 立，21:5x 修恒真）：**候选数量必须对账** ——
  //   「候选 = 进包 ＋ 排除 ＋ 链接（逐个列出）」，差值不是 0 ⇒ **拒交付（exit 4）**。
  //   ⚠ 这条对账**抓不到**"`tools\grp` 被换成 junction"那一例（那 3 份从**发现**这一层就没了 ⇒
  //   两边一起变小、照样相等）—— 那一例靠判据⑦的**硬闸**堵，别把两条的作用搞混。
  const skip = new Set(EXCLUDE_A.map(([f]) => f));
  const isSkipped = (c) => skip.has(c.rel) || skip.has(c.rel.replace(/\\/g, '/'));
  const list2 = list.filter((c) => !isSkipped(c));
  const skipped = list.filter(isSkipped);
  return { list: list2, links, skipped, seen, missingDocs, excludeProblems };
}

// ★ 判据⑧ 的**纯函数**形式：给四个数就判 —— 自检拿**合成数**打它，才证明得了"它不是恒等式"。
//   （拿真树跑一遍只是**读数**：真树恒等时它照样绿，证明不了任何事 —— 复核线打回的就是这一点。）
function conserved({ seen, cand, skipped, links }) { return cand + skipped + links === seen; }

// ── 替换表（真值一律来自身份文件；脚本里**不写**任何真值）────────────────────────
// ⚠ fail-closed 的判据 = **身份文件有没有登记真值**（`registered`），**不是**"rules 空不空" ——
//   本机用户名可能从 `os.userInfo()` 兜底拿到，那会让"空身份文件"看起来不空（自检第⑥项就是抓这个的）。
function buildRules(idPath = path.join(ROOT, IDENTITY_REL)) {
  const p = idPath;
  if (!fs.existsSync(p)) return { err: `身份文件不在：${IDENTITY_REL}（真值只住那儿；本工具 fail-closed 不产出）` };
  let id;
  try { id = JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return { err: `身份文件不是合法 JSON：${e.message}` }; }
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [];
  const values = [];   // 给 L1 判定用（真值＋正则）
  let registered = 0;
  // ★ 替换侧与判定侧**同一口径：大小写无关**（`gi`）。为什么：只收紧判定侧 = 变体留在产物里被拒交付；
  //   只收紧替换侧 = 判不出来 ⇒ 放行。两边一起收紧，才是"替换机械 + 硬闸"各自都能兜住。
  //   ⚠ **例外如实说**（2026-09-26 21:5x 复核线点名的"注释过度声明"）：**本机用户名**那条替换正则只带
  //   `g`、**没有** `i`（见下面 `user` 那行）⇒ 用户名换个大小写**不会被替换掉**；但它在**判定侧**
  //   （`idRe` 强制带 `i`）**会被 L1 / L1exact 当场逮住并拒交付** ⇒ 是 **fail-closed**，不是放行。
  //   所以这里写"同一口径"要限定为"**判定侧与替换侧都按 `gi` 发力**"，而**不是**"每条规则都带 `i` 替换"。
  if (id.ownerQQ) { rules.push([`主人QQ`, new RegExp(`(?<!\\d)${esc(id.ownerQQ)}(?!\\d)`, 'gi'), '<主人QQ>']); values.push(['主人QQ', String(id.ownerQQ)]); registered++; }
  (id.groupIds || []).forEach((g, i) => { rules.push([`群号${i + 1}`, new RegExp(`(?<!\\d)${esc(g)}(?!\\d)`, 'gi'), `<群${String.fromCharCode(65 + i)}>`]); values.push([`群号${i + 1}`, String(g)]); registered++; });
  if (id.serverAccount) { rules.push(['服务器账号', new RegExp(esc(id.serverAccount), 'gi'), '<账号>@']); values.push(['服务器账号', String(id.serverAccount)]); registered++; }
  if (id.serverHostPattern) { rules.push(['服务器地址', new RegExp(id.serverHostPattern, 'gi'), '<服务器IP>']); values.push(['服务器地址', new RegExp(id.serverHostPattern)]); registered++; }
  // 本机用户名：优先身份文件显式字段，其次从 ownRepos 派生，最后回退 os.userInfo()
  const fromRepos = (id.ownRepos || []).map((r) => String(r).split('/')[0].replace(/-bot$/i, '')).filter(Boolean);
  const user = id.windowsUser || fromRepos[0] || (() => { try { return os.userInfo().username; } catch { return ''; } })();
  if (user) { rules.push(['本机用户名', new RegExp(esc(user), 'g'), '<你>']); values.push(['本机用户名', String(user)]); if (id.windowsUser || fromRepos[0]) registered++; }
  if (registered === 0) return { err: '身份文件里一条真值都没登记（ownerQQ / groupIds / serverAccount / serverHostPattern 全空）⇒ 拒产出（fail-closed：宁可不产出，也不产出"以为替换了其实没替换"的东西）' };
  if (!rules.length) return { err: '替换表为 0 条 ⇒ 拒产出' };
  return { rules, values, user, id, registered };
}
const applyRules = (text, rules) => {
  let t = text; const hits = {};
  for (const [name, re, rep] of rules) { const m = t.match(re); if (m) { hits[name] = (hits[name] || 0) + m.length; t = t.replace(re, rep); } }
  return { t, hits };
};
// L1 判定：命中证据里是否出现身份真值/正则
// ★ 2026-09-26 20:5x 复核线打回 (a)：两个**静默 fail-open** 一起堵上 ——
//   ① 原 `s.includes(v)` **大小写敏感**（而扫描器的身份规则是 /gi ⇒ 用户名改个大小写就照发，实测 exit 0 / L1=0）；
//   ② 原 `v.test(s)` 直接吃带 /g 的正则 ⇒ `.test()` 会在同一实例上推进 `lastIndex` ⇒ **交替返回真假**。
//   这里每次重建一个**不带 /g、强制带 /i** 的正则：身份比对（判定侧与替换侧）一律大小写无关。
const idRe = (v, keepG = false) => new RegExp(v.source, v.flags.replace(/g/g, '') + (v.flags.includes('i') ? '' : 'i') + (keepG ? 'g' : ''));
const sampleHasId = (s, values) => values.some(([, v]) => (v instanceof RegExp
  ? idRe(v).test(String(s))
  : String(s).toLowerCase().includes(String(v).toLowerCase())));
const isL1 = (samples, values) => samples.some((s) => sampleHasId(s, values));
// ★ 独立对账数 L1exact：真值在**文本**里实际出现几次（大小写无关；字符串按子串、正则按 match）
//   ★ 非零时**必须点得出名**（哪条真值 × 出现在哪一份）—— 一个 fail-closed 的读数不能只说"有 2 处"。
const idCountsInText = (text, values) => {
  const low = String(text).toLowerCase();
  const out = [];
  for (const [name, v] of values) {
    let c = 0;
    if (v instanceof RegExp) c = (String(text).match(idRe(v, true)) || []).length;
    else {
      const needle = String(v).toLowerCase();
      if (needle) { let i = low.indexOf(needle); while (i >= 0) { c++; i = low.indexOf(needle, i + needle.length); } }
    }
    if (c) out.push([name, c]);
  }
  return out;
};
const countIdsInText = (text, values) => idCountsInText(text, values).reduce((a, [, c]) => a + c, 0);
// ★ 判据⑤ `--out` 白名单护栏（**只判路径、不动盘**）：拒 ⇒ 调用方退出码 2，且此时还没删过任何东西
function guardOut(outAbs) {
  const raw = String(outAbs ?? '');
  if (!raw.trim()) return { err: '--out 是空的' };
  const norm = path.resolve(raw);
  const rel = path.relative(ROOT, norm);
  const tmpAbs = (() => { try { return fs.realpathSync(os.tmpdir()); } catch { return os.tmpdir(); } })();
  const inTmp = (abs) => { const r = path.relative(tmpAbs, abs); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
  if (rel === '') return { err: `--out 指向仓库根（${ROOT}）—— 它会先删掉整个源码树` };
  if (path.isAbsolute(rel) || rel.startsWith('..')) {
    return inTmp(norm) ? { ok: norm } : { err: `--out（${norm}）在仓库外，且不在 %TEMP%（${tmpAbs}）之下` };
  }
  const parts = rel.split(path.sep);
  const top = parts[0].toLowerCase();
  if (/^generated[-_]/.test(top)) return { ok: norm };
  if (top === 'qq-bridge') {
    const p = parts.map((s) => s.toLowerCase());
    if (p[1] === 'state' && p.includes('_archive') && /^tmp[-_]/.test(p[p.indexOf('_archive') + 1] || '')) return { ok: norm };
    return { err: `--out 落在 qq-bridge\\ 里，但不是状态归档临时区（只允许 qq-bridge\\state\\_archive\\tmp-*\\）` };
  }
  return { err: `--out（${rel}）落在被扫描/受保护的目录里 —— 拒绝（它会先删真源码或我们自己的台账）` };
}

function scanPaths(paths) {
  if (!paths.length) return { files: [] };
  fs.mkdirSync(TMP, { recursive: true });
  const f = path.join(TMP, 'export-a-scan.json');
  const fd = fs.openSync(f, 'w');   // ⚠ 文件 fd（沙箱里管道 EPERD/EPERM；PS 的 `>` 是 UTF-16）
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'scan-secrets.cjs'), '--json', ...paths], { cwd: ROOT, stdio: ['ignore', fd, fd] });
  fs.closeSync(fd);
  // ★★ 2026-09-26 23:5x（第九代派单 ③6②）：**用完即清**。清理口径（可执行的那一版就是这段代码）：
  //   · **谁清**：写它的那一方 —— 就是本函数（同一个函数内闭环，不留给人记）。
  //   · **什么时候**：**每次调用结束时**，且**先读进内存再删** ⇒ 子进程失败/JSON 读不动时也照删。
  //   · **self-check 看不看它**：**不看**。它的生命周期 = 一次调用，是**瞬态中间产物**；`state\_tmp\` 整体
  //     属于"可整清"目录，自检只盯 `state\` 里的生产残留（它的存在与否都不该影响任何判据）。
  //   · A 档里**永远不会有它**（既不在 DOCS 也不在候选目录里）。
  let txt = '';
  try { txt = fs.readFileSync(f, 'utf8'); } catch { txt = ''; }
  try { fs.rmSync(f, { force: true }); } catch { /* 删不掉不影响本次结果；下次会被覆盖 */ }
  try { return JSON.parse(txt.replace(/^\uFEFF/, '')); } catch (e) { return { err: `扫描结果读不动（退出码 ${r.status}）：${e.message}`, files: [] }; }
}

function runSelftest() {
  const R = buildRules();
  if (R.err) { console.log(`  ❌ 自检前置失败：${R.err}`); return 1; }
  let pass = 0; const fails = [];
  const ck = (n, c, d = '') => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fails.push(n); console.log(`  ❌ ${n}${d ? ' —— ' + d : ''}`); } };
  // ★ "不适用"**显式记账**（2026-09-26 22:xx，复核线 r3 §3 洞③）：既**不计通过**、也**不静默**。
  //   为什么不能写成 `ck(name, true)`：那样它**完全隐形**（评审原话）；而"跳过路径恰好不记账"
  //   只是**约定**、不是**强制** ⇒ 下一个人加一条 `if (…) return` 就把它变成新的假绿口子。
  //   有了它，下限闸才能按 `ran`（＝ pass ＋ fails ＋ skip）判 —— 跳过**不会**让 `ran` 变小。
  //   ⚠ 如实交代：本套件**目前没有**真正的"不适用"路径（③ 那条"没有判据力"是**必须红**、不是 skip）
  //     ⇒ `skip()` 现在是**记账入口**，`skipCount` 恒为 0。留着它是为了让下一个人**有地方**记，
  //     而不是顺手写 `ck(name, true)` 把它变得完全隐形（那正是评审点名的洞③）。
  let skipCount = 0; const skips = [];
  const skip = (n, why) => { skipCount++; skips.push(`${n}（${why}）`); console.log(`  ⏭ ${n} —— ${why}`); };
  // ⚠ ③ 这条**不许**走 skip：ROOT 落在跳过区是"本次没有判据力"，必须**红**（⑩ 段的反面教材就在这儿）。
  // ★ ③（追加，2026-09-26 21:5x）：ROOT 落在本工具的跳过区 ⇒ **本次没有判据力**（报绿也不算数）。
  //   必须让它**红**：否则镜像跑法会印出"全过"，而它一个字都没验到。
  ck('③ ROOT **不在**本工具的跳过区里（否则本次没有判据力、报绿也不算数）', !NO_JUDGE,
    `ROOT = ${ROOT}（★ 处置只有一条有效：把镜像**挪出跳过区**；--preserve-symlinks-main 治不了这条）`);
  const qq = R.values.find(([n]) => n === '主人QQ')?.[1] || '';
  const body = `号：${qq} 结束\n`;
  const one = applyRules(body, R.rules);
  ck('① 真值被换掉（替换表生效）', qq && !one.t.includes(qq) && one.t.includes('<主人QQ>'), one.t.slice(0, 40));
  ck('② 幂等：跑第二遍字节不变', applyRules(one.t, R.rules).t === one.t);
  ck('③ 边界：更长的数字串里的 QQ 子串**不许**被换（前后挨着数字时不匹配）',
    qq ? applyRules(`x${'9'}${qq}9y`, R.rules).hits['主人QQ'] === undefined : true);
  const l1 = R.values.find(([n]) => n === '主人QQ');
  ck('④ L1 判定器认得出真值', !!l1 && isL1([`证据里带 ${l1[1]} 的东西`], R.values));
  ck('⑤ L1 判定器**不**把普通词/形状当真值', !isL1(['token', '20260923', '0.0.0.0'], R.values));
  ck('⑥ fail-closed：身份表为空 ⇒ 明确拒产出（错误信息里说清缺什么）',
    !!buildRulesEmptyProbe());
  // ⑦ ★ 大小写变体必须被判成 L1 —— **真扫描**（夹具落 `_tmp`、走真 `scan-secrets`、再看逐处证据），
  //    并**同时**验证旧公式在同一批证据上认不出来（那就是复核线实测到的缺口，改成"旧=false / 新=true"）
  const variant = R.user ? (R.user !== R.user.toUpperCase() ? R.user.toUpperCase() : R.user.toLowerCase()) : '';
  const fx = path.join(TMP, 'export-a-case-probe.md');
  let ev = [];
  if (R.user) {
    fs.mkdirSync(TMP, { recursive: true });
    fs.writeFileSync(fx, `路径 C:\\Users\\${variant}\\proj\n`, 'utf8');
    try {
      const jj = scanPaths([fx]);
      ev = (jj.files || []).flatMap((f) => f.hits || []).flatMap((h) => h.samples || []);
    } finally { try { fs.rmSync(fx, { force: true }); } catch { } }
  }
  const oldFormulaHit = ev.some((s) => R.values.some(([, v]) => !(v instanceof RegExp) && s.includes(v)));
  ck('⑦ ★ 大小写变体被判成 L1（旧公式在同一批证据上认不出来 ⇒ 这正是那个 fail-open）',
    !!R.user && ev.length > 0 && ev.some((s) => isL1([s], R.values)) && !oldFormulaHit,
    `证据串 ${ev.length} 条${ev.length ? '：' + JSON.stringify(ev.slice(0, 2)) : '（一条都没扫到）'}`);
  ck('⑧ ★ `--out` 护栏：仓库根 / 仓库根的祖先 / 空值 / 源目录（docs、tools）一律拒',
    !!guardOut(ROOT).err && !!guardOut(path.dirname(ROOT)).err && !!guardOut('').err
    && !!guardOut(path.join(ROOT, 'docs')).err && !!guardOut(path.join(ROOT, 'tools')).err);
  ck('⑧b `--out` 护栏：generated-* / %TEMP% 之下 / 状态归档 tmp-* 放行',
    !guardOut(path.join(ROOT, 'generated-export-a')).err && !guardOut(path.join(os.tmpdir(), 'export-a-selftest')).err
    && !guardOut(path.join(ROOT, 'qq-bridge', 'state', '_archive', 'tmp-20260926', 'out')).err);
  ck('⑨ 独立对账数 L1exact：含真值（含大小写变体）> 0、干净文本 = 0',
    !!R.user && countIdsInText(`x ${variant} y`, R.values) > 0 && countIdsInText('干净的一行 <主人QQ>', R.values) === 0);
  // ★ ⑩（2026-09-26 21:3x 立；★ 21:5x 修**恒真**）：候选数量守恒。
  //   ⚠ 复核线源码级打回的原样：拿**真树**跑一条 `sum === total` —— 两边都由同一批桶算出 ⇒ **恒真**，
  //   11/0 全绿只能证明"算式没写错"，**证明不了"漏了会红"**。⇒ 证明改由 ⑩a 的**合成数**断言承担；
  //   真树那条降级成 ⑩b **读数**（分母照写，别拿它当证明）。
  ck('⑩a ★ 候选守恒判据**不是恒等式**：人为造出的坏数必须判不守恒',
    conserved({ seen: 14, cand: 11, skipped: 3, links: 0 }) === true
    && conserved({ seen: 15, cand: 11, skipped: 3, links: 1 }) === true
    && conserved({ seen: 14, cand: 8, skipped: 3, links: 0 }) === false   // 桶里少了 3 份
    && conserved({ seen: 14, cand: 11, skipped: 2, links: 0 }) === false  // 排除桶漏记 1
    && conserved({ seen: 14, cand: 12, skipped: 3, links: 0 }) === false, // 进包桶多算 1（= 重叠）
    '守恒：14 vs 11+3+0、15 vs 11+3+1 ｜ 必须红：14 vs 8+3+0（桶少记）、14 vs 11+2+0（排除漏记）、14 vs 12+3+0（重叠多算）');
  // ★ ⑩c：**这条对账本身抓不到 junction 顶掉子树** —— 那 3 份从"发现"这一层就没了 ⇒ 两边**一起变小**、
  //   照样守恒。⇒ 这正是 21:5x 把判据⑦ 从"不判红"改成**硬闸**的理由；两条作用**别搞混**。
  ck('⑩c ★ 守恒对账**抓不到 junction 顶掉子树**（同一份坏树在它眼里是"守恒"的）',
    conserved({ seen: 12, cand: 8, skipped: 3, links: 1 }) === true,
    'junction 例（合成数）：3 份候选消失 ⇒ seen 14→12、进包 11→8、链接 0→1 ⇒ 8+3+1 == 12 照样"守恒"');
  const C = candidates(ROOT);
  const dupes = C.list.filter((c) => C.skipped.some((s) => s.rel === c.rel)).length;
  ck('⑩b 真树**读数**（不是证明）：三桶互不重叠 ＋ 桶和 == **独立数出来**的候选 ＋ 排除名单全命中 ＋ DOCS 一条不缺',
    conserved({ seen: C.seen, cand: C.list.length, skipped: C.skipped.length, links: C.links.length })
    && dupes === 0 && C.skipped.length === EXCLUDE_A.length
    && C.missingDocs.length === 0 && C.excludeProblems.length === 0,
    `候选 ${C.seen} = 进包 ${C.list.length} ＋ 排除 ${C.skipped.length} ＋ 链接 ${C.links.length}（重叠 ${dupes}；DOCS 缺 ${C.missingDocs.length} 条；EXCLUDE 判据不合 ${C.excludeProblems.length} 条；链接那只桶随仓库里有没有 junction 变）`);

  // ══ ★ 2026-09-26 22:xx 新增（复核线 r3 §6-3 ＋ §5 备案① ＋ §2 两盲区）══════════════════
  // ★ ⑪ **未知参数 ⇒ 必须非零且不许写盘**（⑪a 纯函数 ＋ ⑪b 真跑一次的行为夹具）
  //   为什么必须有：`--list --no-files` 被 `has()` 静默忽略 ⇒ 以为在干跑、实际**照常写盘**＋ exit 0。
  ck('⑪a ★ 未知参数被识别出来（`has()` 那种"静默忽略"的老行为正是立案现场）',
    unknownArgs(['--list', '--no-files']).length === 2
    && unknownArgs(['--out']).length === 1                 // --out 缺值
    && unknownArgs(['foo']).length === 1                   // 位置参数也不认
    && unknownArgs(['--dry-run', '--out', 'x', '--json', '--selftest', '--allow-links']).length === 0,
    `--list/--no-files ⇒ ${JSON.stringify(unknownArgs(['--list', '--no-files']))}`);
  let argBehavior = { ok: false, detail: '(夹具没跑)' };
  {
    const outDir = path.join(os.tmpdir(), `export-a-unknownarg-${process.pid}`);
    const lg = path.join(TMP, 'export-a-unknownarg.log');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
    const fdx = fs.openSync(lg, 'w');
    // ⚠ stdio 走**文件 fd**（受限沙箱里 pipe 会 EPERM —— 本族已知的坑）
    const rr = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--list', '--no-files', '--out', outDir],
      { cwd: ROOT, stdio: ['ignore', fdx, fdx] });
    fs.closeSync(fdx);
    const txt = fs.readFileSync(lg, 'utf8');
    const wrote = fs.existsSync(outDir);
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(lg, { force: true });
    argBehavior = {
      ok: rr.status !== 0 && !wrote && /不认识的参数/.test(txt) && /^用法：/m.test(txt),
      detail: `exit ${rr.status} · 写盘 ${wrote} · ${(txt.match(/不认识的参数[^\n]*/) || ['(没印)'])[0]}`,
    };
  }
  ck('⑪b ★ **行为**夹具：真的跑一次未知参数 ⇒ 非零退出 ＋ 打印用法 ＋ **一个东西都不写**',
    argBehavior.ok, argBehavior.detail);
  // ★ ⑫ **DOCS 段独立计数 ＋ 任一条不存在/写错路径 ⇒ 必须红**（纯函数：拿**假仓库**打 `candidates(root)`）
  //   老写法该段**恒等**（seen 起步 = DOCS.length，与 cand 同源）⇒ 实测镜像里 7 条只剩 1 条仍报"候选 9 = 进包 9"。
  {
    const fx = path.join(TMP, 'export-a-docs-fixture');
    let det = '';
    let good = null, miss = null, hard = null;
    try {
      fs.rmSync(fx, { recursive: true, force: true });
      fs.mkdirSync(path.join(fx, 'tools'), { recursive: true });
      for (const [rel] of DOCS) { const q = path.join(fx, rel); fs.mkdirSync(path.dirname(q), { recursive: true }); fs.writeFileSync(q, '夹具\n'); }
      good = candidates(fx);
      fs.rmSync(path.join(fx, DOCS[0][0]), { force: true });
      miss = candidates(fx);
      // 盲区 B 的纯函数版：把 DOCS[1] 换成指向夹具外 canary 的**硬链接**
      const canary = path.join(fx, 'outside-canary.txt');
      fs.writeFileSync(canary, '夹具外的内容\n');
      fs.rmSync(path.join(fx, DOCS[1][0]), { force: true });
      fs.linkSync(canary, path.join(fx, DOCS[1][0]));
      hard = candidates(fx);
      det = `干净镜像 候选 ${good.seen}=${good.list.length}+0+0 · 缺 1 条 ⇒ missingDocs ${JSON.stringify(miss.missingDocs)} · 硬链接那条 ⇒ ${JSON.stringify(hard.links)}`;
    } catch (e) { det = '夹具准备失败：' + e.message; }
    finally { fs.rmSync(fx, { recursive: true, force: true }); }
    ck('⑫ ★ DOCS 段**独立计数**：干净镜像一条不缺、候选数 == DOCS 条数（老写法这段恒等，等于没验）',
      !!good && good.missingDocs.length === 0 && good.seen === DOCS.length && good.list.length === DOCS.length && good.links.length === 0,
      det);
    ck('⑫b ★ **DOCS 任一条不存在 ⇒ 必须红**（老行为：照报"候选 9 = 进包 9"、零警告）',
      !!miss && miss.missingDocs.length === 1 && miss.missingDocs[0] === DOCS[0][0] && !miss.list.some((c) => c.rel === DOCS[0][0]),
      det);
    ck('⑫c ★ **盲区 B**：DOCS 路径是硬链接 ⇒ 进链接桶、**不进包**（老行为：canary 原文照进产物）',
      !!hard && hard.links.some((l) => l.startsWith(DOCS[1][0] + '（DOCS 路径·硬链接）')) && !hard.list.some((c) => c.rel === DOCS[1][0]),
      det);
  }
  // ★ ⑬ 降级路径的**判据**（2026-09-27 微批 3）：只有"换名类"错误码才许走降级。
  //   立案现场：本机 `renameSync(成品目录 → .old-<pid>)` 稳定 EPERM，而**删同一个目录成功** ⇒
  //   没有降级路径时成品会**停在旧字节**，而"绿"读数照旧打出来（假绿的典型形状；主人差点据此 push）。
  //   ⚠ **边界如实说**：本项只打"哪个错误码算换名被拒"这条**判据**；"换名被拒 ⇒ 删旧目录再落盘"这个
  //     **动作**由**真机反向对照**验证（拿住成品目录 ⇒ 工具必须非零退出 ＋ 印出"没有换盘"自曝行 ＋ 成品 mtime 一字未动）。
  //   ★ 断言**两边都有**（三个码必须真、三个别的必须假）⇒ 判据被写成恒真或恒假都过不了。
  ck('⑬ ★ 降级只在"换名被拒"的错误码上走（EPERM/EACCES/EBUSY 真；ENOENT/EXDEV/无码 假）',
    isRenameDenied('EPERM') === true && isRenameDenied('EACCES') === true && isRenameDenied('EBUSY') === true
    && isRenameDenied('ENOENT') === false && isRenameDenied('EXDEV') === false && isRenameDenied(undefined) === false,
    `EPERM/EACCES/EBUSY ⇒ ${['EPERM', 'EACCES', 'EBUSY'].map((c) => isRenameDenied(c)).join('/')} · ENOENT/EXDEV/无码 ⇒ ${['ENOENT', 'EXDEV', undefined].map((c) => String(isRenameDenied(c))).join('/')}`);
  // ★ 项数下限闸（2026-09-26 21:5x 立；★ 22:xx 按复核线 r3 §3 **改口径**）：治"**静默跳过一条判据**"这一整类。
  //   ★★ 口径（六条发现里的第①⑤条）：**比 `ran`（本轮实际跑了几条），不比 `pass`（过了几条）** ——
  //      比 `pass` 时**真失败**（例如 76 通过/4 失败）也会触发它，并给出**错误诊断**"有判据被静默跳过"
  //      （那是假话：一条都没跳过）；而且跳过 1 条、别处 +1 条新判据 ⇒ `pass` 回填到 ≥ 下限 ⇒ 看不见。
  //   ★ `ran` = pass ＋ fails ＋ skip；"不适用"**显式记一条 skip**（既不计 pass 也不静默），
  //     所以本套件目前**没有 skip 路径** ⇒ `ran === pass + fails`，但记账入口留着（见 `skip()`）。
  //   ⚠ 覆盖位 `DSH_SELFTEST_FLOOR` **只允许抬严**（`Math.max`）：用处是"跳过判据 ⇒ 必须红"能当场复验；
  //     允许调低的话，它自己就成新的假绿口子。
  //   ★ 下限数字**只写一处**（就这一行）；**来源** = 本批 `--selftest` 的实测项数。
  //     ★★ **改这一行 = 改判据**：动它必须走"守门人改动"纪律 —— **先自首 ＋ 给新旧对照读数**
  //     （`DSH_SELFTEST_FLOOR=<旧值>` 与默认值各跑一次，把两次的输出贴在一起）。别默默往下调。
  const SELFTEST_FLOOR = Math.max(20, Number(process.env.DSH_SELFTEST_FLOOR) || 0);
  //   ★ 2026-09-27 微批 3 自首：19 → **20**（新增 ⑬ 一条）⇒ 按纪律**抬严**，并附新旧对照读数：
  //     改前 `--selftest` = **19 项全通过**（floor 19）；改后 = **20 项全通过**（floor 20）。
  const ran = pass + fails.length + skipCount;
  if (ran < SELFTEST_FLOOR) fails.push(`项数下限闸：本轮只跑了 ${ran} 项 < 下限 ${SELFTEST_FLOOR}（有判据被静默跳过 ⇒ 不许报绿）`);
  if (skipCount) console.log(`  ⏭ 本轮有 ${skipCount} 条"不适用"（已显式记账，既不计通过也不静默）：${skips.join('；')}`);
  console.log(`\n${fails.length ? `❌ ${fails.length} 项没过${fails.length ? ` —— ${fails.join('；')}` : ''}` : `✅ 判据自检：${pass} 项全通过（本轮共跑 ${ran} 项${skipCount ? `，其中跳过 ${skipCount}` : ''}）`}`);
  return fails.length ? 1 : 0;
}
// 用一个**空身份文件**探 fail-closed —— ⚠ 写在 `_tmp` 里、用参数传进去，**绝不碰真身份文件**
function buildRulesEmptyProbe() {
  fs.mkdirSync(TMP, { recursive: true });
  const p = path.join(TMP, 'export-a-empty-identity.json');
  fs.writeFileSync(p, '{}\n');
  try { return buildRules(p).err || ''; } finally { fs.rmSync(p, { force: true }); }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────
if (SELFTEST) process.exit(runSelftest());
// ★ 判据⑤：`--out` 白名单护栏 —— 在**任何删除之前**拒掉（拒绝时一个东西都不删，退出码 2）
const OUT_GUARD = guardOut(OUT);
if (OUT_GUARD.err) { console.error(`❌ --out 被拒（**未删任何东西**）：${OUT_GUARD.err}`); process.exit(2); }
// ★ ③（追加，2026-09-26 21:5x）fail-loud：ROOT 落在本工具自己的跳过区 ⇒ 这一趟**没有判据力**。
//   为什么必须拦住而不是只警告：这种跑法**照样 exit 0**（候选 6 = 6 + 0 + 0 对账"绿"），
//   而产物会被当成"验过了"的成品 —— 正是本线今天连踩四个的"绿在不该绿的地方"。
if (NO_JUDGE) {
  console.error('⚠ 本次**没有判据力**、报绿也不算数：仓库根落在本工具自己的跳过区（WALK_SKIP）里。');
  console.error(`   ROOT = ${ROOT}`);
  console.error('   症状：整棵 tools\\ 会被静默跳过（候选只剩 DOCS 那几份），对账照样"绿"、exit 0 ⇒ 假绿。');
  console.error('   处置（**只有这一条有效**）：把镜像/副本**挪到跳过区之外**（archive ／ _archive ／ _tmp 三处都算）。');
  console.error('   ⚠ `--preserve-symlinks-main` **治不了这条**：它只管"脚本自身路径怎么解析"，而本条判的是');
  console.error('      ROOT 的**路径字符串** —— 实测只加 flag 仍然 exit 4。它必须配**干净路径字符串**才管用。');
  process.exit(4);
}
const R = buildRules();
if (R.err) { console.error(`❌ ${R.err}`); process.exit(2); }
const { list: cand, links, skipped, seen, missingDocs, excludeProblems } = candidates();
// ★★ 判据⑦＋DOCS 独立计数（2026-09-26 22:xx）：**DOCS 任一条不存在/路径写错 ⇒ 拒交付**。
//   为什么单立：老写法 `seen` 起步 = `DOCS.length`（与 cand 同源）⇒ 该段**恒等**，实测镜像里
//   7 条 DOCS 只剩 1 条仍报"候选 9 = 进包 9"、**零警告** ⇒ 单条 DOCS 被删/写错路径根本抓不到。
if (missingDocs.length) {
  console.error(`❌ DOCS 候选清单里这 ${missingDocs.length} 条**在树里找不到**：${missingDocs.join('、')}`);
  console.error(`   （声明 ${DOCS.length} 条、盘上只有 ${DOCS.length - missingDocs.length} 条）⇒ 拒交付，**未写任何东西**。`);
  console.error('   为什么这是硬闸：DOCS 是**声明式**清单，少一条成品就少一份，而数量对账看不出来（都少）。');
  process.exit(4);
}
if (excludeProblems.length) {
  console.error(`❌ EXCLUDE 名单的链接判定与遍历结果对不上（${excludeProblems.length} 条）⇒ 拒交付，**未写任何东西**：`);
  for (const p of excludeProblems) console.error(`   · ${p}`);
  process.exit(4);
}
// ★ 判据⑦（21:5x 硬闸）：链接 = 候选树不是它看起来的样子 ⇒ **默认拒交付**（exit 4、一个东西都不写）。
if (links.length) {
  log(`【链接】发现 ${links.length} 个链接（逐个列出）⇒ 候选集可能被子树之外的实体换掉；确认无误后用 --allow-links 显式放行：${links.join('、')}`);
}
// ★ 判据⑧：候选数量守恒对账（差值不是 0 ⇒ 拒交付 exit 4，且**一个东西都不写**）
{
  const sum = cand.length + skipped.length + links.length;
  // ★★ 2026-09-27 微批 3：**读数口径自曝** —— 下面这几行"绿"读数**都算在暂存目录上**，
  //   而"有没有真的换盘"是**另一件事**（换盘失败时它们照样是绿的 —— 实测踩过，详见文件末判据⑥）。
  //   ⇒ 把作用域印在读数**前面**，并把判读口收到**末行【落盘】**。
  if (!DRY) log('★ 口径：下面这些读数（**候选守恒 / L1 / L1exact / L2 / 份数**）**全部算在暂存目录上** —— 是否真的换盘、成品是不是新的，**只看末行【落盘】**。');
  log(`【候选对账】候选 ${seen} 项 = 进包 ${cand.length} ＋ 排除 ${skipped.length}${skipped.length ? '（' + skipped.map((s) => s.rel).join('、') + '）' : ''} ＋ 链接 ${links.length}${links.length ? '（' + links.join('、') + '）' : ''}`);
  if (!conserved({ seen, cand: cand.length, skipped: skipped.length, links: links.length })) {
    console.error(`❌ 候选对账不上：进包 ${cand.length} ＋ 排除 ${skipped.length} ＋ 链接 ${links.length} = ${sum} ≠ 候选 ${seen} ⇒ 拒交付（说明有人把某一类漏掉了）`);
    process.exit(4);
  }
  if (links.length && !ALLOW_LINKS) {
    console.error(`❌ 候选树里有 ${links.length} 个链接（${links.join('、')}）⇒ 拒交付，**未写任何东西**。`);
    console.error('   ★ 本判据的范围 = **tools\\ 遍历到的条目 ＋ 遍历根（tools\\ 自己）＋ 每条 DOCS/EXCLUDE 路径**。');
    console.error('   为什么这是硬闸：链接顶掉一个子树后，那几份候选**从"发现"这一层就消失了** ⇒');
    console.error('   任何数量对账（判据⑧）都看不出少了东西 —— 对账对得上 ≠ 成品是完整的。');
    console.error('   确认这些链接没顶掉该进包的路径、且确实不该进包 ⇒ 用 --allow-links 显式放行（★ 放行也仍不跟进）。');
    process.exit(4);
  }
  if (links.length && ALLOW_LINKS) log(`【链接】已按**显式放行**处理 ${links.length} 个链接（--allow-links；★ **仍不跟进**链接目标）`);
  if (skipped.length !== EXCLUDE_A.length) log(`【提示】排除名单 ${EXCLUDE_A.length} 条，本趟只命中 ${skipped.length} 条（有名单项在仓库里已不存在 ⇒ 名单该更新了）`);
}
const before = new Map();
let replaced = 0;
const rows = [];
const writes = [];
for (const c of cand) {
  const src = path.join(ROOT, c.rel);
  if (!fs.existsSync(src)) continue;
  before.set(c.rel, crypto.createHash('sha256').update(fs.readFileSync(src)).digest('hex'));
  const raw = fs.readFileSync(src, 'utf8');
  const { t, hits } = applyRules(raw, R.rules);
  const n = Object.values(hits).reduce((a, b) => a + b, 0);
  replaced += n;
  if (applyRules(t, R.rules).t !== t) { console.error(`❌ 不幂等：${c.rel}`); process.exit(1); }
  rows.push({ rel: c.rel.replace(/\\/g, '/'), why: c.why, bytes: Buffer.byteLength(t), replaced: n, kinds: hits });
  writes.push({ rel: c.rel.replace(/\\/g, '/'), text: t });
}
log(`【替换表】主人QQ→<主人QQ> · 群号 ${(R.id.groupIds || []).length} 个→<群A/B> · 账号→<账号>@ · 服务器前缀→<服务器IP> · 用户名(${R.user})→<你>`);
log(`【候选】${writes.length} 份（带：README＋CONTRIBUTING＋LICENSE＋示例配置＋tools\\ 整目录）· 排除 ${EXCLUDE_A.length} 份：${EXCLUDE_A.map(([f]) => f.split('/').pop()).join('、')}`);
log(`【替换】共 ${replaced} 处${replaced ? '' : '（这个仓库的对外候选里没有身份真值）'}`);
for (const r of rows.filter((x) => x.replaced)) log(`  ${r.rel}：${r.replaced} 处 —— ${Object.entries(r.kinds).map(([k, v]) => `${k}×${v}`).join('、')}`);

// ★ 判据⑥：**原子落盘** —— 先写**同卷**暂存目录（`.<名字>.building-<pid>`）⇒ 取证 ⇒ 过了才整体换名。
const STAGE = path.join(path.dirname(OUT), `.${path.basename(OUT)}.building-${process.pid}`);
const rmTree = (p) => {
  try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); return true; }
  catch (e) { console.error(`⚠ 删不掉 ${path.relative(ROOT, p)}：${e.message}`); return false; }
};
if (!DRY) {
  rmTree(STAGE);
  for (const w of writes) { const p = path.join(STAGE, w.rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, w.text); }
  log(`\n【写盘·暂存】${path.relative(ROOT, STAGE)}\\ —— ${writes.length} 份（过了取证才换名成 ${path.relative(ROOT, OUT)}\\）`);
}
// 判据②：原件零改动
let touched = 0;
for (const [rel, h] of before) if (crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, rel))).digest('hex') !== h) { console.error(`❌ 原件被改了：${rel}`); touched++; }
log(`【原件】${touched === 0 ? '一个字节都没动 ✓' : `${touched} 份被改 ❌`}`);

// 判据④：逐份取证（L1/L2 分开数；★ L1 = **逐处证据**，另给独立对账数 L1exact）
let l1 = 0, l2 = 0, soft = 0, l1exact = 0, perFile = [];
if (!DRY) {
  const files = writes.map((w) => path.join(STAGE, w.rel));
  const j = scanPaths(files);
  if (j.err) { console.error(`⚠ ${j.err}`); }
  const relOf = new Map(writes.map((w) => [path.resolve(path.join(STAGE, w.rel)), w.rel]));
  for (const f of j.files || []) {
    const idN = (h) => (h.samples || []).filter((s) => sampleHasId(s, R.values)).length;
    const h1 = (f.hits || []).filter((h) => idN(h) > 0);
    const h2 = (f.hits || []).filter((h) => idN(h) === 0);
    const n1 = h1.reduce((a, h) => a + idN(h), 0);   // ★ 只数"真的含真值的那几条证据串"（不再按 label 整类 × 出现数）
    const n2 = h2.reduce((a, h) => a + h.count, 0);
    l1 += n1; l2 += n2; soft += f.soft || 0;
    perFile.push({
      path: path.relative(ROOT, path.join(OUT, relOf.get(path.resolve(f.path)) || path.basename(f.path))),
      bytes: f.bytes, L1: n1, L2: n2, soft: f.soft || 0,
      L1kinds: h1.map((h) => `${h.label}×身份证据${idN(h)}（该类共 ${h.count} 处）`),
    });
  }
  l1exact = writes.reduce((a, w) => a + countIdsInText(w.text, R.values), 0);
  log(`\n【L1/L2 双读数】L1（真身份·逐处证据）= **${l1}** ${l1 === 0 ? '✅ 硬闸通过' : '❌ 必须 0'} · L1exact（独立对账：真值在产物文本里的实际出现数）= **${l1exact}** ${l1exact === 0 ? '✅' : '❌ 必须 0'} · L2（字样/形状）= ${l2} · 提示级 ${soft}`);
  for (const r of perFile.filter((x) => x.L1 > 0)) log(`  ❌ L1 非零：${r.path} —— ${r.L1kinds.join('、')}`);
  // ★ L1exact 非零 ⇒ 逐份点名（哪条真值 × 哪一份 × 几处）—— 不给"有 2 处"这种查不下去的读数
  if (l1exact > 0) {
    for (const w of writes) {
      const det = idCountsInText(w.text, R.values);
      if (det.length) log(`  ❌ L1exact 明细：${w.rel} —— ${det.map(([n, c]) => `${n}×${c}`).join('、')}`);
    }
  }
  log(`  ★ 一句要跟着读数传的话：**A 档通过 ≠ \`scan-secrets\` 0 处**（L1 是硬闸；L2 如实披露）`);
}
// 判据：L1（或独立对账数）不为 0 ⇒ 拒交付 —— ★ 只删**暂存目录**，旧成品原样保留（判据⑥）
if (!DRY && (l1 > 0 || l1exact > 0)) {
  rmTree(STAGE);
  console.error(`❌ L1 不为 0（逐处证据 ${l1} / 独立对账 ${l1exact}）⇒ **拒交付** —— 暂存目录已删，**旧成品原样保留**`);
  process.exit(3);
}
if (!DRY && touched) { rmTree(STAGE); console.error('❌ 原件被改过 ⇒ 不换名（暂存目录已删）'); process.exit(3); }
// ★ 判据⑥的第二半：**换名**（旧成品先改名成 .old-<pid> ⇒ 暂存目录改名成目标 ⇒ 删掉旧的）
//   ★★ 2026-09-27 微批 3 加**降级路径**（立案现场）：本机实测 `fs.renameSync(OUT, old)` 会**稳定**报
//      `EPERM`（PowerShell 的 `Rename-Item` 对同一件事也是 Access denied），而**删掉同一个目录却成功**
//      ⇒ 换名被拒时**不再放弃**：删旧目录（那些字节本来就要被换掉）→ 再把暂存目录改名成目标。
//      ⚠ **只在"换名类"错误码上降级**（EPERM / EACCES / EBUSY）；别的错误照旧失败 —— 降级不许掩盖真问题。
//      ⚠ 降级再失败 ⇒ **一个"绿"字都不许留**：把人卡在哪一步、旧成品还在不在、新成品在哪，全部印清楚。
//   ★ 本判据的**纯函数**部分可被 `--selftest` 直接打（⑬）；**动作**部分靠真机反向对照验（见 ⑬ 注释）。
/** 这个错误码算不算"换名被拒"（函数声明 ⇒ 提升，`--selftest` 能在主流程之前打它）。 */
function isRenameDenied(code) { return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'; }
if (!DRY) {
  const old = `${OUT}.old-${process.pid}`;
  const outExisted = fs.existsSync(OUT);
  const oldMtime = outExisted ? fs.statSync(OUT).mtime.toISOString() : null;
  const oldWhat = outExisted ? `**成品仍是旧的（mtime=${oldMtime}）**` : '**成品目录本来就不存在**';
  rmTree(old);
  let how = '换名';
  try {
    if (outExisted) fs.renameSync(OUT, old);
    fs.renameSync(STAGE, OUT);
  } catch (e) {
    // ① 老行为：先把"已经让位"的旧成品换回来（换名可能失败在第二步）
    if (!fs.existsSync(OUT) && fs.existsSync(old)) { try { fs.renameSync(old, OUT); } catch { } }
    if (!isRenameDenied(e.code)) {
      console.error(`❌ 换名失败（${e.code || '无错误码'}）：${e.message}`);
      console.error(`⚠ **本次没有换盘 ⇒ ${oldWhat}**；上面那些"绿"读数**全部算在暂存目录上**，**不代表已发布**。`);
      console.error('   处置：这是"换名类"以外的错误 ⇒ 按原样失败，先查清再重跑（别拿降级去凑绿）。');
      rmTree(STAGE);
      process.exit(3);
    }
    // ② 降级：删旧目录 → 落盘（本机实测：换名被拒时删除往往还成功）
    how = '降级（换名被拒 ⇒ 删旧目录再落盘）';
    log(`⚠ 换名被拒（${e.code}）⇒ 走**降级路径**：先删旧成品目录，再把暂存目录落盘`);
    if (fs.existsSync(OUT) && !rmTree(OUT)) {
      console.error(`❌ 换名被拒（${e.code}）、降级**也删不掉**旧成品 ⇒ **本次没有换盘 ⇒ ${oldWhat}**。`);
      console.error(`   上面那些"绿"读数**全部算在暂存目录上**（${path.relative(ROOT, STAGE)}），**不代表已发布**。`);
      console.error('   处置：确认没有别的进程占着成品目录（它的当前目录就是那里 / 里面还有文件被打开）后重跑本工具。');
      rmTree(STAGE);
      process.exit(3);
    }
    try { fs.renameSync(STAGE, OUT); }
    catch (e2) {
      console.error(`❌ 降级路径的最后一步也失败（${e2.code || '无错误码'}）：${e2.message}`);
      console.error(`⚠ **旧成品已被删除、新成品没能落盘** ⇒ 现在 ${path.relative(ROOT, OUT)} 不存在。`);
      console.error(`   新成品**完好在暂存目录**：${path.relative(ROOT, STAGE)} —— 确认后手工改名成 ${path.basename(OUT)} 即可（本次**不删它**）。`);
      process.exit(3);
    }
  }
  rmTree(old);
  log(`✅ 落盘完成【${how}】：${path.relative(ROOT, OUT)}（${writes.length} 份）`);
  log(`   ★ 成品 mtime = ${fs.statSync(OUT).mtime.toISOString()}`);
}

if (JSON_OUT) console.log(JSON.stringify({ out: path.relative(ROOT, OUT), dryRun: DRY, files: writes.length, replaced, l1, l1exact, l2, soft, links, excluded: EXCLUDE_A.map(([f, w]) => ({ file: f, why: w })), perFile, manifest: rows }, null, 2));
else log(`\n${DRY ? '（干跑，没写盘）' : `✅ A 档对外副本已生成：${path.relative(ROOT, OUT)}\\（${writes.length} 份）—— L1=0`}`);
