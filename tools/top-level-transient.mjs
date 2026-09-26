// tools/top-level-transient.mjs —— 「顶层条目数」判据里**不算数**的瞬态条目：**唯一口径**
//
// 谁在用：`tools\self-check.mjs`（复算快照数字、比对）、`tools\structure-snapshot.mjs`（生成快照的数字与「顶层一览」表）。
//
// 为什么要有这份名单：`顶层条目数` 是 `docs\结构快照.md` 末尾数字指纹的一项，self-check 复算不一致就报
//   **「结构快照已过期」**，而 `tools\daily-check.mjs` 每天 09:00 会把红/警告**推到主人手机**上
//   ⇒ **一条假警告 = 白叫醒他一次**（2026-09-26 那轮"假红清理"就是被这类假警告逼出来的）。
// 判据本体是"根目录下有几个条目"（`readdirSync(根).length`）⇒ 根目录里只要有**跑一次就出现/消失**的本地状态文件，
//   这条判据就会**自己红绿**：2026-09-26 实测 `.launcher-state.json` 缺席时 `18 → 17`，
//   同族还有"探针文件留在根目录把条目数顶高 ⇒ 凭空造出过期警告"（小镜与小锤各自独立复现过）。
//
// ⚠⚠ **只收"逐个具名"的条目，绝不写成模式**（例如"忽略所有 `.` 开头的"）：那会**同时放过** `.gitignore` /
//    `AGENTS.md` / `.dsh` / `agent.config.json` 这类**真条目** —— 等于把"假红"直接翻成"漏判"（协调线 2026-09-26 明令）。
// ⚠ `.dsh\`（工作区根那个）**不是瞬态**：它有 4 个 **git 跟踪**的文件（`git ls-files .dsh`：
//    `skills/draw-image/{SKILL.md,config.json,references/api.md,scripts/draw.mjs}`；只有 `credentials.json` 被忽略）
//    ⇒ 它是工作区内容的一部分，**必须照旧计入**。
//
// 收录标准（三条**都**满足才收）：
//   ① 由本仓库的工具在**工作区根**创建；② 用完/关掉就被删（⇒ 会来回出现）；③ 已在 `.gitignore` 里明列为"本地一次性状态"。
import fs from 'node:fs';

export const TRANSIENT_TOP_LEVEL = new Map([
  ['.launcher-state.json', {
    why: '启动器状态（记录窗口句柄，供 stop-all.ps1 精确关闭）：'
      + '`tools\\start-all.ps1:1000`（$statePath）+ `:1019` 写；`tools\\stop-all.ps1:483-495` **关完即删**'
      + '（留着只会在下一轮被系统回收、复用到别的窗口上 ⇒ 可能把启动器自己掐死）；`.gitignore:37`。',
  }],
  ['.panels-state.json', {
    why: '面板页状态（窗口句柄，本地一次性）：'
      + '`tools\\panels.ps1:1343` 写；`:835` / `:844` / `:850` / `:1145` 删；`.gitignore:32`（原话"本地一次性状态，别提交"）。',
  }],
]);

/** 这个名字算不算"瞬态顶层条目"。 */
export const isTransientTopLevel = (name) => TRANSIENT_TOP_LEVEL.has(name);

/** 按同一口径列出当前**在场**的瞬态条目（给文档/探针用；顺序按名单顺序）。 */
export const presentTransientTopLevel = (root) =>
  [...TRANSIENT_TOP_LEVEL.keys()].filter((n) => fs.existsSync(`${root}${process.platform === 'win32' ? '\\' : '/'}${n}`));

/**
 * 顶层条目数 = 根目录条目数 **减去**瞬态条目。
 * ★ 两边（生成器与自检）**必须**都调这一个函数 —— 只改一边会让两种状态下各红一次（口径漂移）。
 */
export function countTopLevelEntries(root) {
  return fs.readdirSync(root).filter((n) => !isTransientTopLevel(n)).length;
}
