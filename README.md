# qq-agent：把 QQ 接到 DSH agent 上

> **一句话**：QQ 群 / 私聊里的人跟 **DSH（DeepSeek Harness）** 的 agent 说话 —— 消息从 QQ 进来变成 agent 的提示，agent 的回复再发回 QQ；同时保留 DSH 自带的 Web GUI 给自己用。
> **状态**：个人项目 · **只支持 Windows** · 目前是"自己用 + 朋友试用"阶段 · **没有支持承诺**（见「已知限制」）。

## 消息怎么走

```
QQ 群 / 私聊（真人）
   │  QQ 协议
   ▼
SnowLuma          ← 第三方 QQ 网关（OneBot v11 实现，自带 node.exe）
   │  WebSocket / HTTP（本机）
   ▼
qq-bridge         ← **第三方**桥接（`Derpyu520/qq-bridge`，本仓库里是**本地改过的副本**）：消息 → agent 提示、回复 → QQ
   │                （权限与白名单、运行模式、分条发送、表情包、画图 / 语音、控制台）
   │  HTTP（本机 DSH Web API）
   ▼
DSH + qq-chat-v2  ← DSH 是上游 npm 包；`qq-chat-v2` preset **来自上游 qq-bridge 作者**（本工作区在其上有本地改动）
   │
   ▼
DeepSeek 模型
```

DSH 自己还带一个 Web GUI（默认 `http://127.0.0.1:3080`），你照常可以在浏览器 / 桌面窗口里用它。

## 哪些是本工作区的、哪些是别人的

| 目录 / 组件 | 归属 | 说明 |
| --- | --- | --- |
| `qq-bridge\` | ★ **第三方项目** [`Derpyu520/qq-bridge`](https://github.com/Derpyu520/qq-bridge)（本工作区用的是 `v0.1.5`） | 桥接本体、控制台、插件。★ **该上游未提供任何许可**（仓库里没有 LICENSE、README 也没有授权声明）⇒ **默认保留所有权利**；本仓库里这份是**照上游作者的教学视频（[B 站 BV1ss8R6zERG](https://www.bilibili.com/video/BV1ss8R6zERG/)）与 README 把桥接 clone 进 DSH 工作区来用、并做过本地裁剪的副本**，**其权利属原作者**。★ **本地改动**（主人自述）：① **重做了控制台页面的 UI**（是**改**不是删 —— 他改成深色面板式，作者原版是浅色五面板）② **删掉**一代扮演模式（`reserved`）：删的是 `qq-bridge\dsh\agent-presets\qq-chat\` **整个目录**（git 有据）；⚠ 上游代码里仍留 **10 处**一代模式分支引用（`bridge.js` 9 处 ＋ `mcp-snowluma-safe.js:530`），本工作区未使用 |
| `qq-bridge\dsh\agent-presets\qq-chat-v2\` · `qq-bridge\roles\小鲸鱼.md`（角色卡） | ★ **上游作者**（随桥接副本一起进来） | **不是本工作区写的** —— 本工作区在其上有**本地改动**（git 有据：这两份随桥接副本一起进来，此后本工作区各改过 2 / 3 个提交） |
| `tools\` | **本工作区** | 启动 / 关闭、自检、运维与安装脚本 |
| `docs\` | **本工作区** | 文档（安装、架构、启动链、文件清单…）；`qq-bridge\docs\` 里另有**上游自己的**文档 |
| `SnowLuma\` | **第三方** | QQ 网关，自带 node.exe；本工作区**只改它的 `config\`**；⚠ **不在本仓库里**（`.gitignore` 排除）⇒ 自己下 zip 放进来，见下面「依赖」 |
| DSH 本体（`@deepseek-ai/dsh`） | **上游** | 全局 npm 包，**不在本仓库里**；换设备要重装它的 preset 与 MCP 挂载 |
| DeepSeek 模型 | **上游服务** | 需要你自己的账号与额度 |

## 依赖

- **Windows 10 / 11** + PowerShell 5.1（启动链是 PowerShell + `.cmd`）
- **Node.js ≥ 22.13**（见 `qq-bridge\package.json` 的 `engines`）
- **DSH 本体**：`npm i -g @deepseek-ai/dsh`
- **第三方 QQ 网关 SnowLuma**：从 <https://github.com/SnowLuma/SnowLuma/releases/latest> 下 **Windows 完整版 zip**，解压后跑 `launcher.bat`
  ⇒ 用启动日志里的初始密码登录 WebUI → 扫码登 QQ → 开 OneBot 的 WebSocket 服务端与 HTTP API，记下端口与访问串
  （⚠ **它不在本仓库里** —— `.gitignore` 排除了，克隆下来**没有这个目录**，必须自己放一份到 `SnowLuma\`；细节 → `qq-bridge\README.md` 第 2 步）
- **一个 QQ 号**（建议小号；网关是扫码登录，扫码的就是它）

## 装起来

> ★ **桥接那一层的安装与配置，本文不重写** —— 那是**第三方项目**的事，而且**上游 README 写得更准更全**：
> **<https://github.com/Derpyu520/qq-bridge>**（SnowLuma 从哪下、`config.json` 逐字段、6 步启动流程、`setup-dsh.mjs` 为什么最容易漏）。
> **本工作区在上游之上加的是**：① 工作区级启动链 `一键启动.cmd` / `只开DSH.cmd` ② `tools\` 那套运维与自检（自检、结构快照、变更日志、打包）
> ③ `docs\` 那套工作区文档 ④ preset `qq-chat-v2` 与角色卡 —— ★ **④ 这两份来自上游作者**，
> 本工作区在其上有**本地改动**（不是本工作区写的，详见下面归属表）。⚠ **桥接本体不是本工作区写的**（同表）。

1. 把**完整工作区**放到本地（`qq-bridge\` ＝ 上游那份的本地副本 ＋ `tools\` ＋ `docs\` ＋ 启动链；**路径别带空格 / 中文更省事**），装依赖：

   > ⚠ **「工作区」与「桥接仓库」不是一回事**：上游那个仓库**只有桥接子项目**（没有 `tools\`、没有根 `docs\`、没有 `一键启动.cmd`）
   > ⇒ 只克隆它跑不了本文的启动那一步。边界与获取方式 → `qq-bridge\docs\DSH_SETUP.md` 第 1 步。

   ```bat
   cd qq-bridge
   npm install
   ```

2. 装 DSH 本体并起一次，确认 Web GUI 能打开（默认 `http://127.0.0.1:3080`）。
3. **按上游 README 装桥接那一层**（SnowLuma、`qq-bridge\config.json`、`setup-dsh.mjs`）—— 上游那份代码用 `git clone` 取（地址见上游 README）。
4. 填**本工作区这一层**的配置（**模板进版本库、真值不进**）：

   ```bat
   copy agent.config.example.json agent.config.json
   ```

   - **身份三件**（管理员 QQ、机器人 QQ、机器人昵称）→ `agent.config.json`（字段旁是 `_note_*` 说明，14 处；换设备只改这一个文件）；
   - 桥接那份 `qq-bridge\config.json` 的字段说明在**上游 README**（本仓库那份模板用的是 `_comment`，6 处、嵌在各子对象里）；
     ⚠ 白名单**至少填一个**，否则谁都不回（刻意的 fail-closed）。

5. 手填嫌麻烦就走向导（一条命令：环境检查 → 依赖 → DSH 端安装 → 配置向导）：

   ```powershell
   powershell -ExecutionPolicy Bypass -File tools\setup-all.ps1
   # 只想写配置： node tools\setup-new.mjs
   ```

6. 起 SnowLuma 扫码登录机器人 QQ（**还没下？** 见上面「依赖」里那个 zip 链接），然后双击 `一键启动.cmd`。

## 跑起来

`一键启动.cmd` —— **启动和关闭都在它身上**：

- 菜单 `1` = 全部启动（DSH + 桥接 + 网关）· `2` = 只登录 · `3` = 关闭
- `一键启动.cmd close` = 关闭全部（加 `-DryRun` 只看会关谁）
- DSH 窗口里随时输 `e` = 关闭全部、`r` = 重起 DSH
- 只想开 DSH 本体：`只开DSH.cmd`

## 已知限制（实话实说）

- **只支持 Windows**；"服务器常开"那条路是**实验性的可选路径**
- QQ 侧依赖**第三方网关**：它的可用性、风控与协议变更都不由本工作区控制
- **换设备要重装 DSH 端**（preset 与 MCP 挂载装在 DSH 环境里，不在仓库里）
- agent 回复**不流式**（回合结束一次性发送）；语音 / 视频等消息类型只是占位文本
- **个人项目**：没有支持承诺、没有 SLA，接口与配置随时可能改
- **许可：MIT**（全文见根目录 `LICENSE`）—— ★ 范围：**只覆盖本项目创作的部分**（`tools\`、`docs\`、根文档、配置示例等）；
  **第三方项目 `Derpyu520/qq-bridge` 不在本许可范围内**（上游无 LICENSE ⇒ 保留所有权利；对外副本也不含它，运行需自行 clone 上游，其授权以上游为准）

## 文档地图

| 想干什么 | 读这个 |
| --- | --- |
| 最短启动路径、桥接鸟瞰 | `qq-bridge\README.md`（**需先 clone 上游 qq-bridge**） |
| 装 / 换 DSH 端（preset + MCP） | `qq-bridge\docs\DSH_SETUP.md`（**需先 clone 上游 qq-bridge**） |
| 架构、数据流、配置全解 | `qq-bridge\docs\PROJECT_GUIDE.md`（**需先 clone 上游 qq-bridge**） |
| 运行模式与权限分层 | `qq-bridge\RULES.md`（**需先 clone 上游 qq-bridge**） |
| 环境层配置模板（照着填） | `agent.config.example.json` |
| 想改这个仓库 / 自己搭一份 | `CONTRIBUTING.md` |
| 启动、关闭、自检、运维脚本 | `tools\`（整目录；自检入口是 `node tools\self-check.mjs`） |

> ★ 这张表**每一条都能在本包里找到** —— 唯一的例外是标了「**需先 clone 上游 qq-bridge**」的那四条：
> 本包**故意不带** `qq-bridge\`（那是别人的开源项目，见上面「哪些是本工作区的」），按 `CONTRIBUTING.md`
> 里那一步自己 clone 上游即可。

## 合规

QQ 侧的自动化使用请自行确认符合《QQ 用户协议》与当地法律；SnowLuma 是独立第三方项目，与腾讯 / QQ 无隶属关系。风险自负。

⚠ **授权提醒（公开 / 再分发前必读）**：本**工作区**包含第三方项目 [`Derpyu520/qq-bridge`](https://github.com/Derpyu520/qq-bridge) 的**本地修改副本**，
而**该上游没有提供任何许可**（无 LICENSE、README 无授权声明）⇒ 默认**保留所有权利**。
⇒ 把这份工作区（**含 `qq-bridge\` 的那一份**）公开或再分发之前，必须先解决这一层的授权（问原作者、或把 `qq-bridge\` 从公开物里剥离）。

★ **如果你手里这份是「对外副本」**（`CONTRIBUTING.md` 里叫 **A 档**）**：它不含 `qq-bridge\`**，所以没有上面那一层问题 ——
要跑起来按 `CONTRIBUTING.md` 那一步**自行 clone 上游**即可，而 **`qq-bridge\` 那一份的授权以上游为准**
（同样是**无许可 ⇒ 保留所有权利**）。本副本自带的代码与文档不因此获得任何上游授权。
