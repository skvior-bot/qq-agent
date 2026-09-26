# 贡献 / 自建说明（CONTRIBUTING）

这份文件给**想改这个仓库、或者想自己搭一份的人**。只想把它跑起来的话，先看 `README.md`。

<!--
★ 写这份文件时的「绝不含」清单（下一位也请别加回来 —— 这份文件是要发出去的）：
  1. 本机路径：任何盘符绝对路径、任何用户主目录形状的路径；
  2. 任何身份：QQ 号、群号、服务器地址／账号、任何口令与登录态；
  3. 我们自己的工作方式：会话、投递、轮换、归档之类的内部流程与纪律；
  4. 只对本机成立的约定（例如"不要以某个账号发言"这类）；
  5. 内部台账／交接文档的**文件名** —— 它们是内部记账，对外文档一律**不引用**（要讲通则，不点名）。
  6. ★ **（硬约束，不是风格）本清单、以及本文件的写法，一律按「通则」来写 —— 不列举被禁的字面。**
     把禁用词一个个列出来 = **自曝**：清单本身就成了那些字面的一份拷贝（照抄一遍并不等于"标了不许"）。
  ⇒ 所以第 1~5 条说的都是「哪一类」，而不是「长什么样」；真要判，用下面那条判据跑扫描器，别靠肉眼背词。
  判据（改完自己跑一遍）：`node tools\scan-secrets.cjs CONTRIBUTING.md`
  ⇒ **身份真值必须 0 处**（"字样／形状"类命中会如实列数，那是允许的）。
-->

## 1. 文档路由

| 想干什么 | 读这个 |
| --- | --- |
| 最短启动路径、桥接鸟瞰 | `qq-bridge\README.md`（**需先 clone 上游 qq-bridge**） |
| 装 / 换 DSH 端（preset + MCP） | `qq-bridge\docs\DSH_SETUP.md`（**需先 clone 上游 qq-bridge**） |
| 架构、数据流、配置全解 | `qq-bridge\docs\PROJECT_GUIDE.md`（**需先 clone 上游 qq-bridge**） |
| 运行模式与权限分层 | `qq-bridge\RULES.md`（**需先 clone 上游 qq-bridge**） |
| 某个路径是什么、什么时候才进 | `docs\仓库导览.md` |
| 搬到服务器上跑 | `docs\服务器部署.md` |
| 环境层配置模板（照着填） | `agent.config.example.json` |
| 启动、关闭、自检、运维脚本 | `tools\`（整目录；自检入口 `node tools\self-check.mjs`） |

★ 本包**故意不带** `qq-bridge\`（那是别人的开源项目，见 `README.md` 的「哪些是本工作区的」）⇒
表里标了「需先 clone 上游 qq-bridge」的四条，要先自己 clone 上游那份才有。

## 2. 会踩的坑（都是从真实事故里抄下来的，不是理论）

- **`.ps1` 必须是 UTF-8 带 BOM ＋ 纯 LF；`.cmd` / `.bat` 必须纯 ASCII ＋ CRLF。**
  很多编辑器（包括各种 AI 改代码的工具）保存时会**剥掉 BOM** ⇒ 症状是 PowerShell 满屏**假语法错**。
  补回来：`node tools\self-check.mjs --fix-bom`。
- **改了 `qq-bridge\src\mcp-*.js`、装了/删了 DSH 插件、换了启动配置 ⇒ 必须重启 DSH。**
  ESM 模块**不热更**；只有 YAML 一类配置能靠新一代际生效。
- **启动日志那条链不能换写法**：`tools\log-run.ps1` 不能删、也不能改用 `Tee-Object` ——
  Windows PowerShell 5.1 的 `Tee-Object` 写出来是 **UTF-16LE**，读回来拿不到启动口令 ⇒ 整条链路 **401**。
- ★ **改中文文本，别用 PowerShell 的 `Get-Content` / `Set-Content` 裸往返。**
  PS 5.1 对**无 BOM 的 UTF-8** 按 ANSI（简体中文机器上是 GBK）解码，汉字与后续字节错位配对会
  **吞掉换行与引号** ⇒ 文件当场不可解析。要么用能选编码的编辑器，要么显式指定编码
  （注意：5.1 的 `-Encoding UTF8` 会**加上 BOM**，写完要核前 3 字节）。
- **端口只在一处定义**（`qq-bridge\src\config-lib.js` 里的默认表）：别在任何脚本里再抄一份数字 ——
  `node tools\self-check.mjs` 里有一条棘轮专门抓这种硬编码。
- **探针 / 临时产物别落在会被判的目录里**：测试写文件请写进项目自己的临时目录，跑完清掉；
  留在共享暂存区里会让别人的自检报出**假红的命中**。

## 3. 维护约定

- **改完同步受影响的文档。** 文档是这个项目的记忆中心；不写下来，下一个人会再踩一遍同一个坑。
- **易过期数字别手改**：跑 `node tools\structure-snapshot.mjs` 刷新（自检会查出过期）。
- **改动留一条结构化记录**：
  `node tools\changelog.mjs add --kind fix|feat|docs|chore|refactor --summary "…" --files "a,b" --docs "c,d"`
  —— `--docs` 必填（没同步文档的改动会被工具拒收）。
- **交之前跑一遍**：`node tools\self-check.mjs`（期望 **0 失败 / 0 警告**）
  ＋ 相关回归网（`node qq-bridge\scripts\test-all.mjs` 是总入口）。
- **提交信息写清"为什么"**，别只写一个 `fix`；一个提交只做一件事，方便别人回退。

## 4. 许可

**本项目创作的部分**（`tools\`、根文档、配置示例等）以 **MIT** 许可发布 —— 全文见根目录 `LICENSE`。

★ **第三方项目 `qq-bridge` 不在本许可范围内**：本仓库对它**只做本地修改**；再分发前请先读 `README.md`
的「授权提醒」一节 —— 上游**没有 LICENSE**（默认保留所有权利），这也是本包**不带** `qq-bridge\` 的原因。
