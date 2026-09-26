// tools/scan-secrets.cjs —— **对外文档的发布前安全扫描**（只读；命中 = 退出码 1）
//
// 用法（从仓库根跑；目标路径相对**当前目录**解析）：
//   node tools\scan-secrets.cjs                     # 默认扫根 README.md
//   node tools\scan-secrets.cjs qq-bridge\README.md # 扫指定文件（可多个；目录只挑 **.md**）
//   node tools\scan-secrets.cjs docs                # 目录：跳过 node_modules/.git/_tmp/_archive/backups/SnowLuma/.npm-cache
//   node tools\scan-secrets.cjs --repo              # ★ 全仓档：README.md ＋ docs\ ＋ qq-bridge\docs\ 的 .md ⇒ "公开前置"门槛读数
//   node tools\scan-secrets.cjs --selftest          # ★ 判据自检（纯内存夹具，**不写盘**）—— 改这个文件前后都该跑
//   node tools\scan-secrets.cjs --json <目标…>      # 机器可读（含"身份字面量是否生效"，供别的程序判这一轮的 0 处里少了几条判据）
//
// 退出码：**0 = 硬禁形状 0 处（可对外）** · **1 = 有命中（公开前必须处理）** · **2 = 用法/读文件出错**
//
// ★ **常驻规则**（2026-09-26 立案，协调线派单）：**对外文档（README / 将来公开仓库里的任何文档）不许出现
//   主人的身份（QQ 号、群号）、服务器地址与账号、任何密钥的形状、以及内部台账**（会话 id、花费数字、轮换叙述）。
//   判据 = **跑这个脚本**；它进 `tools\` 而不是 `_archive\`，因为它不是一次性探针，而是**可复跑的活判据**。
//
// ★★ **不许"空过"**：这个脚本必须在**已知有问题的文件**上报得出命中，否则它给出的 0 一文不值。
//   标准对照（每次改它都该跑一遍，读数写进提交信息）：
//     node tools\scan-secrets.cjs docs/HANDOFF.md   ⇒ 必须报出命中（身份/字样/UUID 等），退出码 1
//   反向对照：`node tools\scan-secrets.cjs --selftest` ⇒ 必须全绿（含"空过对照"，见 §3）。
//
// ★ 三类判据的分寸（2026-09-26 第二轮放大，小镜复核提出）：
//   ① **身份/基础设施/内部台账**（QQ 号、群号、服务器 IP 与账号、会话 id、UUID、金额、本机用户名路径）⇒ **一律硬红**；
//   ② **密钥**：英文的认证类**字样**硬红（对外文档里连字段名都该避让）；**中文同义词**（令牌/密钥/凭据/密码）
//      只有**带值**（字段名 + 冒号/等号 + 值 这种形状）才硬红 —— 光出现"用日志里的初始密码登录"是**正常写法**，
//      硬红它就是又一族假红；裸出现走**提示级**（打印但不改退出码）；
//   ③ **URL**：**带凭据**（用户名/口令内嵌在 URL 里）· **内网**（10./192.168./172.16-31./*.local/.internal）· **未知主机** ⇒ 硬红；
//      公共主机（github.com 及其资源域、npmjs.com/registry.npmjs.org、nodejs.org、bilibili.com）与 **本机回环** ⇒ **放行**
//      ⚠ bilibili.com 是 2026-09-26 加的：上游作者的教学视频（BV1ss8R6zERG）是**出处署名的一部分**，
//        对外 README 必须能写它 —— 白名单是"已知公共站点"，不是"我们的站点"。
//      —— 一份对外的 README **本来就需要**指向"去哪下第三方组件"，把公共链接当禁形状会让作者自己撞门。
//      ⚠ `ws://` / `wss://` 一起扫（之前只扫 `https?://`，是个盲点）。
//
// ============================================================================================
// §1 身份字面量**不在本文件里**（2026-09-26 第三轮，小镜全历史扫描 + 协调线派单）
//   本文件是**要进公开仓库的判据**，所以它自己一个真值都不许带（原版写死了主人的号、两个群号、服务器前缀与账号
//   ⇒ 公开这个脚本 = 公开这些）。真值改从 **不进库的本地文件** 读：
//     `qq-bridge\state\scan-secrets-identity.json`（该目录**已被 .gitignore 整体忽略**，且 `qq-bridge\`
//      本来就不进公开档 ⇒ 放在这里 = 结构上不可能被"整目录复制"带出去）
//   结构：{ "ownerQQ": "…", "groupIds": ["…"], "serverHostPattern": "134\\.175", "serverAccount": "svc@" }
//   ⚠ 上面那行是**占位写法**：本文件里不许出现真值（哪怕写在注释里 —— 自检的"扫自己"就是抓这个的）。
//   ★ 另一个字段 `ownRepos`（可选）：自家仓库地址（`org/repo`）。它单独走一路是因为**这些字面里含本机
//     Windows 用户名** ⇒ 不许住在本文件里（本文件要进交付包，pack-new 的"个人信息"检查会点名它）；
//     缺它 ⇒ **不放行任何自家 URL**（fail-closed），`scan-secrets` 会把自家地址报成"未知主机"红。
//   ⚠ **缺失时不静默降级**：顶部与结尾各打一行"未配置"，并把这几组**没生效**的字面判据列出来；
//     通用形状判据（位数、非回环 IPv4、内网、URL、路径）**不受影响、照跑**。
//   ⚠ "未配置"是**配置态**、不是命中 ⇒ **扫描路（`--repo`／指定文件）不改退出码**
//     （否则公开仓里的使用者永远拿不到 0）。
//   ★ 例外 = `--selftest`（**我们自己的判据自检**；2026-09-26 优化线本代，按复核线 §3 洞⑤ 加）：
//     身份未配置 ⇒ ⑤b 那条判据**显式记一条 skip**（既不计 pass、也不静默）**并**推一条自己的**环境红灯**
//     「**身份判据未配置**」⇒ `--selftest` 退出码非零 —— 自检里少一条判据还报绿，那才是真的假绿。
//     ⚠ 这条红灯**不许**复用下限闸那句"有判据被静默跳过"（那是**错诊断**：没有谁被静默跳过，
//       是那几组字面判据**压根没被配置**、本轮没有判据力）。
//   ⚠ 测试/回归网要换一份身份：`DSH_SCAN_SECRETS_IDENTITY=<路径>`（缺失路径 = 模拟未配置）。
//
// §2 ★ 模板类文件档（2026-09-26 第三轮，协调线拍板走 (a)）
//   **模板的用处就是列出字段名** —— 用户不填 `accessToken` 它就白给。所以对**模板类文件**另开一档：
//     · 认证类／会话类**字样**（英文 token/session/cookie）⇒ **字段名降为提示级**；
//     · **`=`/`:` 后面的值 ⇒ 照旧硬红**（与它自己"中文同义词只有带值才硬红"的分寸同源）。
//
// §2b ★ 中文密钥形状的**值侧**判据（2026-09-26 21:4x，协调线裁决①；实现见 chineseValueLooksReal）
//   背景：`deploy\linux\.env.example` 有两处**散文误伤**（`令牌〈分隔符〉` 换行后跟 `#` 注释 ／
//   `密码〈分隔符〉**留空 = 用镜像…`）—— 旧规则 `[:=：]\s*\S+` 既能跨行把 `#` 当值、也会把 `**留空` 当值。
//   ★ 为什么非改不可：假红的代价不是"多打印几行"，而是**把真红淹掉**（狼来了）；而模板档
//   "0 处 / exit 0"是一条**要被信的基线**。
//   现在的切法（四道全过才算"值"）：① 值只取本行，本行没值就看下一**非空**行，但那行以
//   `#`/`*`/`>`/`|`/反引号/`-` 开头 ⇒ 当注释 ⇒ 没值；② 值必须是**一个不含空白的 token**；
//   ③ 不以注释/markdown 标记开头、不命中占位词表（填/占位/待填/示例/你的/自己的/此处/这里/换成/留空）；
//   ④ 像凭据〈分隔符〉**≥3 个 ASCII 字母数字**（`hunter2`、`abc123xyz` 都过）**或**含 CJK 汉字。
//   ★ 第 ④ 条那支比"值里得有 ≥3 个 ASCII 字母数字"**严一格**：把**纯中文**的词写在"密码"这类词后面
//     （原口径"中文口令带值任何档位都不降级"指的就是它）**仍判红** —— 所以这里不写那条夹具的字面
//     （写了这个判据文件**自己**会被 ⑤ 扫红，实测踩过一次）。
//     代价如实写：**单个中文词**的值（无空白且不在占位词表里）仍会判红 —— **只会多报、不会漏**。
//
// §2c ★ **两条已知残余**（2026-09-26 21:4x 协调线裁决②：**同意先记账**，不收）
//   ① `KEY=#see-also` —— `#` 紧跟内容时按"像注释/像值"两侧判（§2 的 R2）：无空白、无全角字符、
//      不命中占位词表 ⇒ **当值 ⇒ 判红**。这是 **fail-closed 的安全方向**：宁可把英文注释
//      `#see-also` 报红（**写成 `= # see-also` 加个空格即可**），也不放过 `KEY=#真值`。
//   ② **同缩进但不带引号**的值行（`token〈分隔符〉` ↵ `sk-…`）仍判 0 处 —— **故意不收**：要让同缩进不带引号
//      的下一行算"值"，就得放宽 R3 的"只认带引号的标量"那条，而那会把 D2 修好的
//      **`.env` 空值行假红**原样带回来（`KEY=` ↵ 下一行是说明文字）。两侧不可两全 ⇒ 选"不收回假红"。
//      ⚠ 落在这个形状里的真值会**假绿**，写文档的人请把值写成带引号或与键同行。
//
//     ★ 2026-09-26 补（复核线打回 D1/D2，同日修）：降级只认「**整个键名** + 本行的空值/占位值」——
//       ① **键名要整个吃掉**（`[\w.\-]*` 一直吃到引号／`[:=]` 为止）：`tokenValue` 这种同族键名
//          后面跟着真值 ⇒ **照旧硬红**（旧写法只看字样命中处的下一个字符 ⇒ 真值被降级放行 = 假绿）；
//       ② 值**只取本行**（键名到分隔符只许 `[ \t]*`、值只许 `[^\n]*`，**不许跨 `\n`**）：`=`/`:` 后面
//          是换行或 `#注释` = 空值 = 占位 ⇒ **降级**（旧写法 `\s*` 跨行、把下一行的说明文字当成值
//          ⇒ `deploy\linux\.env.example` 这种"设计上留空"的模板行被判红 = 假红）；
//          唯一豁免：下一行是**缩进更深的值续行**（YAML／美化 JSON 的写法）⇒ 仍按值判（不许开新口子）。
//   "模板类"怎么认：**按文件名形状**（`*.example.*` / `*.sample.*` / `*.template.*` / `*.tmpl.*`）
//     ⇒ 是路径的纯函数、可复算、不靠调用方声明（**故意不提供"把某文件当模板"的命令行开关**：那才是后门）。
//   数字（7 位以上数字串）：模板里也有正当数字（毫秒时长/字节限额），所以给两条**白名单形状**：
//     ① 紧跟**度量类键名**（ms/sec/min/hour/day/byte/size/limit/timeout/interval/delay/duration/ttl/retry/count…）的值；
//     ② 落在**注释/说明类字段**（`_comment`/`_note`/…）里且是 **7–8 位**纯整数（毫秒/秒/字节/日期都在这个量级带）。
//   ★★ 两条边界（**单独出判据**，见 §3）：
//     · **≥9 位 + 非度量键位 ⇒ 恒硬红** ⇒ **主人的号是 10 位，恒在硬红侧**（不依赖本地身份文件是否存在）；
//     · **身份类键位**（qq/uin/user/group/member/admin/owner/allow/deny/white/black…）上的数字 ⇒ **无论几位都恒硬红**
//       ⇒ 把最现实的"往模板里填真号"堵回去。
//   ⚠ 本档**没覆盖**的（如实写在报告里）：7–8 位的真号若被写进**说明文字**里，只会降为提示级。
//
// §3 `--selftest` 的三条判据（**新开一档就必须配网**）
//   ① **值侧仍硬红**：模板里塞一个像真的值（长随机串 / 真号形状）⇒ 必须判红；
//      ★ ①b／①c／①d（D1/D2 翻转，2026-09-26）：**同族键名**（`tokenValue`/`sessionId`/`cookieJar`/
//        `cookieFile`）带真值 ⇒ 必红；`.env` 的**空值行**（`KEY=` + 换行／`#注释`）⇒ 必**不**红
//        （空值 = 占位），且同一文本在非模板档仍必红；值续行必红、兄弟键必不红。
//   ② ★ **空过对照**：把"模板类"判定**故意短路成恒真**（= 最宽松）⇒ 判据①**必须仍然判红**；
//      再配**反向对照**：短路成**恒假**（= 普通档）⇒ **裸字段名必须判红**（证明降级真的取决于"模板类"，不是全局放宽）；
//   ③ ★ **数字的边界三条**：10 位在身份键/注释/孤立位置恒红 · 身份键位 7–8 位恒红 · 度量键位才放行。
//   ★ 另一条不变量：**扫描器扫自己** —— 硬红**只允许**出现在三条"字样类"上（那是判据自己的规则文本，源码里不可能不出现），
//     身份/数字/IP/路径/金额/URL 类必须 **0 处**（夹具里的数字一律**运行期拼**，不落字面）。
//   ★★ 教训（2026-09-26 协调线点名认下）：**"判据文件不带真值"这句话，本身必须有判据，否则只是句愿望** ——
//     自检里那条"**带真身份扫自己**"（⑤b）就是它：写它的当天就当场抓到"注释里抄了真账号"（我自己的）。
// ============================================================================================
const fs = require('node:fs');
const path = require('node:path');

const ROOT = process.cwd();
const HERE = __dirname;                                    // <仓库>\tools
const IDENTITY_REL = path.join('qq-bridge', 'state', 'scan-secrets-identity.json');
const IDENTITY_ENV = 'DSH_SCAN_SECRETS_IDENTITY';

// ---------- 身份字面量（§1） ----------
const IDENTITY_ITEMS = [
  ['ownerQQ', '主人 QQ'],
  ['groupIds', '群号'],
  ['serverHostPattern', '服务器地址'],
  ['serverAccount', '服务器账号'],
];
function loadIdentity(explicitPath) {
  const p = explicitPath
    ? path.resolve(explicitPath)
    : process.env[IDENTITY_ENV]
      ? path.resolve(process.env[IDENTITY_ENV])
      : path.join(HERE, '..', IDENTITY_REL);
  const out = { configured: false, path: p, ownerQQ: '', groupIds: [], serverHostPattern: '', serverAccount: '', ownRepos: [], missing: [], note: '' };
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch (e) {
    out.note = e.code === 'ENOENT' ? '文件不存在' : `读不到：${e.message}`;
    out.missing = IDENTITY_ITEMS.map(([, label]) => label);
    return out;
  }
  let obj;
  try { obj = JSON.parse(raw); } catch (e) {
    out.note = `不是合法 JSON：${e.message}`;
    out.missing = IDENTITY_ITEMS.map(([, label]) => label);
    return out;
  }
  out.ownerQQ = typeof obj.ownerQQ === 'string' ? obj.ownerQQ.trim() : String(obj.ownerQQ ?? '').trim();
  out.groupIds = Array.isArray(obj.groupIds) ? obj.groupIds.map((g) => String(g).trim()).filter(Boolean) : [];
  out.serverHostPattern = typeof obj.serverHostPattern === 'string' ? obj.serverHostPattern.trim() : '';
  out.serverAccount = typeof obj.serverAccount === 'string' ? obj.serverAccount.trim() : '';
  // 自家仓库地址（`org/repo`）：**可选** —— 缺它不算"未配置"（公开仓使用者压根没有自家地址），
  // 只是**不放行**任何自家 URL（fail-closed）。它单独走一路，是因为这些字面里含本机 Windows 用户名。
  out.ownRepos = Array.isArray(obj.ownRepos)
    ? obj.ownRepos.map((r) => String(r).trim().replace(/^https?:\/\//i, '').replace(/^github\.com\//i, '')).filter(Boolean)
    : [];
  for (const [key, label] of IDENTITY_ITEMS) {
    const v = out[key];
    if (!v || (Array.isArray(v) && !v.length)) out.missing.push(label);
  }
  out.configured = out.missing.length === 0;
  return out;
}
const identityBanner = (id) => id.configured
  ? `身份字面量：已配置（${path.relative(HERE, id.path) || id.path}）—— 主人 QQ／群号／服务器地址／服务器账号 四组字面判据**本轮生效**`
  : `⚠ 身份字面量：**未配置**（${id.note}；找的是 ${path.relative(HERE, id.path) || id.path}）—— `
    + `${id.missing.join('／')} 这 ${id.missing.length} 组字面判据**本轮不生效**（通用形状判据仍在跑）`;

// ---------- 规则表 ----------
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function buildRules(id) {
  const rules = [];
  if (id.ownerQQ) rules.push({ label: '主人 QQ（本地字面）', re: new RegExp(escapeRe(id.ownerQQ), 'g'), why: '身份：公开仓库里出现 = 泄漏', kind: 'identity' });
  id.groupIds.forEach((g, i) => rules.push({ label: `群号（本地字面 ${i + 1}）`, re: new RegExp(escapeRe(g), 'g'), why: '身份：同上', kind: 'identity' }));
  if (id.serverHostPattern) rules.push({ label: '服务器地址前缀（本地字面）', re: new RegExp(id.serverHostPattern, 'g'), why: '基础设施：公开即被扫', kind: 'identity' });
  if (id.serverAccount) rules.push({ label: '服务器账号（本地字面）', re: new RegExp(escapeRe(id.serverAccount), 'gi'), why: '基础设施：同上', kind: 'identity' });
  rules.push(
    { label: '密钥字样（英文·认证类）', re: /token/gi, why: '密钥形状（字段名也应避让；**值**绝不许出现）', kind: 'wording' },
    { label: '密钥形状（中文·带值）', re: /(?:令牌|密钥|凭据|密码)[ \t]*[:=：][ \t]*([^\n]*)/g, why: '密钥形状：中文写法带着值', kind: 'fixed', drop: (text, m) => !chineseValueLooksReal(text, m) },
  // ★ 英文认证键名表（2026-09-26 21:5x 复核线 ⑥：模板档与非模板档都**假绿**；
  //   22:0x **打回 ①**：`{"secretKey〈分隔符〉"sk-live-…"}` 实测 exit 0 —— 旧写法要求"敏感词**后紧跟分隔符**"，
  //   于是 `jwtSecret`/`dbPassword`（敏感词在**词尾**，靠 `["'`]?` 放行）能红、`secretKey`（后面**还跟
  //   camelCase 限定词**）掉出去）。旧注释自称"不让某一族掉出去"，而那一族正好掉出去了 ⇒ 改成
  //   **"敏感词出现在键名里任意位置"** ＋ **"带限定词的 key"**两种形状。
  // ── 枚举（★ 协调线要求：想一遍再列，每条给理由；不是只补它点到的两个）──
  //   口令族 `password` / `passwd` / `pwd` / `passphrase` / `passcode〈分隔符〉现实配置里这五种都放口令；
  //     前三种旧表已有，`passphrase`（打回点名的假绿）与 `passcode` 是新补 —— 它们与 password 同义。
  //   秘密族 `secret〈分隔符〉`jwtSecret` / `dbSecret` / `secretKey` / `secret_key` / `clientId+secret` 全都含它；
  //     ★ 关键在于 `secret` **后面常跟限定词** ⇒ 只有"词内任意位置"这种写法才覆盖得住。
  //   令牌族 `token〈分隔符〉`accessToken` / `refreshToken` / `authToken` / `tokenValue` —— 同理由。
  //     与 `token`（wording 那条）会有重叠命中 ⇒ **冗余不是漏**（wording 只管字样，这条管"键名 + 真值"）。
  //   凭据族 `credential` / `credentialBlob〈分隔符〉词干 + 限定词，已被"词内任意位置"覆盖。
  //   带限定词的 key：`apiKey` / `accessKey` / `privateKey` / `secretKey` / `clientKey` / `signingKey` /
  //     `encryptionKey` —— ★ **裸 `key` 故意不进表**：`keyboard` / `keys` / `keymap` / `keydown`
  //     会大面积假红（而这里每一次假红都在稀释真红的可信度）⇒ `key` 只在**带限定词**时才敏感。
  //   限定词形态：camelCase / snake_case / kebab-case / 直接相连 —— 由 `[A-Za-z0-9_\-]*` 一并覆盖。
  { label: '密钥形状（英文·带值）', re: /(?:[A-Za-z0-9_\-]*(?:password|passwd|pwd|passphrase|passcode|secret|token|credential)[A-Za-z0-9_\-]*|(?:api|access|private|secret|client|signing|encryption)[_\-]?key)["'`]?[ \t]*[:=：][ \t]*([^\n]*)/gi, why: '密钥形状：英文写法带着值（★ 与中文口令形状**必须同样红**；本行**不抄**那两句字面 —— 抄了就成了"判据文件自己带凭据形状"，⑤ 当场点名，实测过）', kind: 'fixed', drop: (text, m) => !englishValueLooksReal(text, m) },
    { label: '会话凭据字样（英文）', re: /cookie/gi, why: '会话凭据形状', kind: 'wording' },
    { label: '会话 id 字样（英文）', re: /session/gi, why: '内部台账形状', kind: 'wording' },
    { label: 'UUID 形状', re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/gi, why: '内部 id 形状', kind: 'fixed' },
    { label: '7 位以上数字串', re: /\d{7,}/g, why: 'QQ / 群 / 账号的形状', kind: 'number' },
    // ⚠ 货币符号**转义写**：写成字面的话，本判据会扫到自己的规则文本（自扫就永远不干净）
    { label: '金额', re: /\u00a5/g, why: '内部成本台账（货币符号）', kind: 'fixed' },
    { label: 'URL 带凭据', re: /(?:https?|wss?):\/\/[^\s/@]+:[^\s/@]*@/gi, why: 'URL 里内嵌用户名/口令', kind: 'fixed' },
    { label: '内网地址', re: /(?:https?|wss?):\/\/[^\s)`]*?(?:\b10\.|\b192\.168\.|\b172\.(?:1[6-9]|2\d|3[01])\.|\.local\b|\.internal\b)[^\s)`]*/gi, why: '内网主机', kind: 'fixed' },
    { label: '非白名单外部主机', re: /(?:https?|wss?):\/\/(?!(?:127\.0\.0\.1|localhost|github\.com|raw\.githubusercontent\.com|objects\.githubusercontent\.com|codeload\.github\.com|npmjs\.com|registry\.npmjs\.org|nodejs\.org|(?:www\.)?bilibili\.com)\b)[^\s)`]+/gi, why: '公共资源请用已知主机；未知主机会被当"来源不明"', kind: 'fixed' },
    { label: '非回环 IPv4', re: /\b(?!127\.0\.0\.1)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, why: '服务器/内网地址形状', kind: 'fixed' },
    { label: 'Windows 用户名路径', re: /C:\\Users\\[^\\\s]+/gi, why: '本机身份', kind: 'fixed' },
  );
  return rules;
}
// 提示级（打印，**不改退出码**）：① 中文口令词**裸出现**（正常写法："用启动日志里的初始密码登录 WebUI"）；
// ② 仓库/账号名 —— ⚠ **2026-09-26 从硬红降为提示级**：主人定性 `Derpyu520/qq-bridge` 是**别人开源的第三方上游**
//    （无 LICENSE ⇒ 保留所有权利）⇒ **对外 README 里必须署名**，署名处出现账号名是**正确用法**，硬红它就是又一族假红。
const ADVISORY = [
  ['中文口令词（裸出现，需人确认不是值）', /令牌|密钥|凭据|密码/g],
  // ⚠ 这里**故意只写公开上游的作者名**：本项目的自家仓库地址里含**本机 Windows 用户名**
  //   （`<用户名>-bot/qq-agent`）⇒ 那个字面不许住在本文件里 —— 本文件**要进交付包**，
  //   `tools\pack-new.mjs` 的"个人信息"检查会点名它（2026-09-26 实测，见 state\_archive 的报告）。
  ['仓库/账号名（正常只应出现在**署名/出处**里，其余位置人看一眼）', /Derpyu/gi],
];
// 放行：本机回环 ＋ **上游出处**（公开、与机器无关 ⇒ 写死在代码里）＋ **自家仓库地址**（从本地身份文件读）。
// ⚠ 自家地址**缺配置时= 不放行**（fail-closed）：宁可把自家 URL 报成"未知主机"红，也不让机器名进包。
function buildAllow(id) {
  const list = [/127\.0\.0\.1/g, /localhost/gi, /github\.com\/Derpyu520\/qq-bridge/gi];
  for (const r of id.ownRepos) list.push(new RegExp(`github\\.com\\/${escapeRe(r)}`, 'gi'));
  return list;
}
const allowNote = (id) => '放行：`127.0.0.1`／`localhost`（本机回环）＋ 公共主机（github.com／npmjs.com／nodejs.org／bilibili.com 等，白名单见脚本）'
  + '＋ `github.com/Derpyu520/qq-bridge`（**上游出处**）'
  + (id.ownRepos.length
    ? `＋ ${id.ownRepos.map((r) => `\`github.com/${r}\``).join('／')}（**自家仓库地址**，从本地身份文件读）`
    : '（**自家仓库地址：未配置** ⇒ 本轮不放行任何自家 URL）');
const SKIP_DIR = new Set(['node_modules', '.git', '.npm-cache', 'SnowLuma', 'backups', '_tmp', '_archive', 'generated-images', 'generated-audio']);
const TEXT_EXT = new Set(['.md', '.markdown']);

// ---------- 模板类（§2） ----------
const TEMPLATE_NAME_RE = /(^|[.\-_])(example|sample|template|tmpl)([.\-_]|$)/i;
const isTemplateClass = (rel) => TEMPLATE_NAME_RE.test(path.basename(rel));

// 认证/会话"字样"是不是**裸字段名**（后面没有 `:`/`=` + 非空非占位的值）⇒ 模板里降提示级
//
// ★ 这条判据守的是**「值必须红」**（D1，2026-09-26 复核线打回）：模板档允许降级的**只有字段名**，
//   `:`/`=` 右边只要坐着真值就一律硬红。旧写法从"字样命中处"往后只找**紧跟**的分隔符 ——
//   `tokenValue〈分隔符〉"真值"` 里 `token` 后面还剩 `Value": …`，第一眼不是分隔符 ⇒ 被当成"只是提到了
//   这个字段名" ⇒ **真值被降级放行**（同一份内容：非模板档判 1 处／模板档判 0 处 = 模板档假绿）。
//   ⇒ 现在**先把整个键名吃掉**（`[\w.\-]*` 一直吃到引号／分隔符为止）再判右边；同族键名
//   `tokenValue` / `sessionId` / `cookieJar` / `cookieFile` 与"值里出现字样"都吃得住。
//
// ★ 行边界（D2，同日一并修）：值**只取本行**（键名到分隔符只许 `[ \t]*`、值只许 `[^\n]*`，
//   **不许跨 `\n`**）—— 旧写法 `\s*` 能跨行：`SNOWLUMA_ACCESS_TOKEN=` 后面空一行，会被当成
//   "值 = 下一行的说明文字" ⇒ **设计上留空（空值 = 占位）的模板行被判红**（`deploy\linux\.env.example`
//   实测 exit 1 = 假红）。本行没值时按**占位**处理：空、行内注释（`KEY= # 说明`）、
//   下一行是注释／带引号的兄弟键／缩进没更深 —— 都算"没写值"。
//   ⚠ 唯一豁免：下一行是**缩进更深的值续行**（YAML／美化 JSON 把值写在下一行那种）⇒ 仍按值判。
//     不加这条就是开新口子（下一行的真值会假绿）；豁免写得**很窄**（只认带引号的兄弟键），
//     宁可假红不可假绿 —— 这条不变量就叫「值必须红」。
//
// ★★ R1／R2／R3（2026-09-26 第二批复核的同族残余口子，"值不在键名那一行"的三种形状）
//   R1 键名与分隔符**被换行隔开**（`token` ↵ `: "真值"`）：旧写法在本行内找不到 `[:=]` 就一律判
//      "只是提到了这个字段名" ⇒ 下一行的真值被降级放行（假绿）。收法：往下看一个非空行，它以
//      `[:=]` 开头 ⇒ 就是这行的分隔符行，仍按赋值判；整行只有分隔符（`=====`，Markdown 下划线）⇒ 没值。
//   R2 `KEY=#<值>`（`#` **紧贴** `=`）：与 D2（`KEY= # 说明` 要降级）正面冲突，因此**按"像注释／像值"两侧收**：
//      `#` 后面那段像注释（含空白／含中文等全角字符／命中占位词表）⇒ 仍算没写值（D2 不受影响）；
//      其余（无空白无中文的一长串，如 `#AbCd…`／`#sk-…`）⇒ **当值** ⇒ 硬红（fail-closed）。
//      已知代价：`KEY=#see-also` 这种**无空格英文注释**会判红 —— 写成 `= # see-also` 即可（宁可假红不可假绿）。
//   R3 键与值**同缩进**分行（`token〈分隔符〉` ↵ `"真值"`）：旧写法只认"缩进更深"的续行 ⇒ 同缩进的下一行一律当
//      "没值"（假绿）。收法：同缩进只认**带引号的标量**（`"真值"`）为值；带引号的兄弟键仍是新赋值，
//      不带引号的同缩进邻居行仍算"没值"（保住 D2：`.env` 里空值行的下一行不许被当成值 ⇒ 不许翻红）。
//   ★ 21:5x（复核线六形状，**根因就是这一行**）：键名尾巴的字符类**必须放宽** —— 现实里的字段名会写成
//     `token/value` · `token[]` · `token value`（`[\w.\-]` 一个都不认 ⇒ 正则不匹配 ⇒ 直接掉进下面
//     `isBareName` 的"**只是提到了字段名**"分支 ⇒ **模板档假绿**，而同内容换个非模板文件名就红）；
//     全角冒号 `tokenValue〈分隔符〉sk-…` 同理（`[:=]` 不认 `：`）。
//     ⚠ 放宽的**只是"键名尾巴 + 分隔符"的形状**；值侧那四道判据（本行/单 token/占位词/像不像凭据）一个字没动
//     ⇒ 两侧夹具都加了：**六形状在模板档与非模板档读数必须一致（都红）**，两个 `.example.` 基线仍须 0 处。
const KEY_TAIL_RE = /^[\w.\-/\[\] "'`]*[ \t]*[:=：][ \t]*([^\n]*)/;
const NEXT_QUOTED_KEY_RE = /^[\s{[,]*["'`][\w.\-]+["'`][ \t]*[:=]/;   // 下一行 = 带引号的兄弟键（新赋值）
const SPLIT_SEP_RE = /^[ \t]*[:=][ \t]*([^\n]*)/;      // R1：整行以分隔符开头（键名留在上一行）
const SEPARATOR_ONLY_RE = /^[ \t]*[=:]{2,}[ \t]*$/;    // 整行只有分隔符（Markdown 下划线 `====`）⇒ 没有值
const QUOTED_SCALAR_RE = /^[ \t]*["'`]/;               // R3：同缩进的下一行是"带引号的标量"
const indentOf = (s) => (s.match(/^[ \t]*/) || [''])[0].length;
// R2：`#` 后面那段"像注释"还是"像值"？
//   像注释（⇒ 等于没写值）：① 含空白（`# 说明`／`#see README` —— 真配发的令牌不含空白）；
//     ② 含中文等全角字符（`#说明：留空`）；③ 命中占位词表（`#TODO`／`#xxx`）。
//   其余一律**当值**（fail-closed ⇒ 判红）：无空白、无中文的一长串，如 `#AbCdEf…`／`#sk-…`。
function isCommentBody(body) {
  const b = String(body);
  if (/\s/.test(b)) return true;
  if (/[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e]/.test(b)) return true;
  return isPlaceholderValue(b);
}
// 值位置上是行内注释 ⇒ 等于没写值（`KEY= # 说明` / `KEY=值 # 说明`）；
// ★ R2 收口后 `KEY=#xxx` 不再一律当注释：`#` 后**像值**的整段按值走（见 isCommentBody）。
const dropInlineComment = (v) => {
  const s = String(v);
  const m = /^[ \t]*#(.*)$/.exec(s);
  if (!m) return s.replace(/[ \t]+#.*$/, '');
  return isCommentBody(m[1]) ? '' : s.trim();
};
// 往下找第一个非空行（R1 的分隔符行与"值续行"共用）
function nextLine(text, from) {
  for (let p = from + 1; p <= text.length;) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(p, end);
    if (line.trim()) return { line, end };
    if (nl === -1) break;
    p = nl + 1;
  }
  return null;
}

function isBareName(text, end) {
  const lineStart = text.lastIndexOf('\n', end - 1) + 1;
  const nl = text.indexOf('\n', end);
  const lineEnd = nl === -1 ? text.length : nl;
  const keyIndent = indentOf(text.slice(lineStart, lineEnd));
  const m = text.slice(end, lineEnd).match(KEY_TAIL_RE);   // 本行内：键名剩余部分 + 分隔符 + 值
  if (m) {
    let v = dropInlineComment(m[1]).trim();
    if (!v) v = nextLineValue(text, lineEnd, keyIndent);
    return isPlaceholderValue(v);
  }
  // 本行内没有赋值形状 —— 除非下一非空行就是**被换行隔开的分隔符行**（R1），否则只是提到了字段名
  const nx = nextLine(text, lineEnd);
  if (!nx) return true;
  const sm = nx.line.match(SPLIT_SEP_RE);
  if (!sm || SEPARATOR_ONLY_RE.test(nx.line)) return true;
  let v = dropInlineComment(sm[1]).trim();
  if (!v) v = nextLineValue(text, nx.end, keyIndent);
  return isPlaceholderValue(v);
}
// 值续行（缩进更深）与 R3 同缩进分行：从 `lineEnd` 起找第一个非空行；
//   注释行／**带引号的兄弟键** ⇒ 没有值（说明或新赋值）；
//   缩进更深 ⇒ 值续行（YAML／美化 JSON 的写法）⇒ 按值判；
//   同缩进（R3）⇒ **只认带引号的标量**，其余（邻居键、说明文字、不带引号的行）仍算"没值"。
function nextLineValue(text, lineEnd, keyIndent) {
  const nx = nextLine(text, lineEnd);
  if (!nx) return '';
  if (/^[ \t]*#/.test(nx.line)) return '';
  if (NEXT_QUOTED_KEY_RE.test(nx.line)) return '';
  if (indentOf(nx.line) <= keyIndent && !QUOTED_SCALAR_RE.test(nx.line)) return '';
  return dropInlineComment(nx.line).trim();
}
function isPlaceholderValue(raw) {
  const v = String(raw)
    .replace(/^["'`]+/, '')
    .replace(/["'`,;)\]}\s]*$/, '')
    .trim();
  if (!v) return true;                                            // 空值 = 模板占位
  if (/^<[\s\S]*>$/.test(v)) return true;                          // <在这里填…>
  if (/^(?:null|none|nil|true|false|~|0)$/i.test(v)) return true;
  if (/^(?:[x*.\-_])\1{1,}$/i.test(v)) return true;                // xxx / *** / --- / ...
  if (/^(?:…|\.{3})/.test(v)) return true;
  if (/(填|占位|待填|示例|你的|自己的|此处|这里|换成)/.test(v)) return true;   // 中文说明 = 占位
  if (/^(?:your|you|my|todo|tbd|changeme|placeholder|redacted|example|xxx)/i.test(v)) return true;
  return false;                                                    // ★ 默认 = **值** ⇒ 硬红（fail-closed）
}
// 数字：度量类键名 / 注释类键名 / 身份类键名
const IDENTITY_KEY_RE = /(qq|uin|user|group|member|friend|admin|owner|allow|deny|white|black|号)/i;
const MEASURE_KEY_RE = /(ms|milli|sec|min|hour|day|byte|size|limit|timeout|interval|delay|duration|period|ttl|retry|count|times|perday|perhour|threshold)/i;
const NOTE_KEY_RE = /^_?(comment|comments|note|notes|remark|remarks|desc|description|说明|注释|备注)/i;
function isMagnitudeNumber(text, idx, s) {
  if (!/^\d{7,8}$/.test(s)) return false;        // ★ ≥9 位：不走白名单（主人的号是 10 位）
  const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
  const before = text.slice(lineStart, idx);
  const nl = text.indexOf('\n', idx);
  const line = text.slice(lineStart, nl === -1 ? text.length : nl);
  const near = (before.match(/["']?([A-Za-z_][\w.\-]*)["']?\s*[:=]\s*$/) || [])[1] || '';
  // 行内最外层键名：允许行首是 `{`／`[`／`,`（单行 JSON、数组元素里也要认得出来）
  const outer = (line.match(/^[\s{[,]*["']?([A-Za-z_][\w.\-]*)["']?\s*[:=]/) || [])[1] || '';
  if (IDENTITY_KEY_RE.test(near) || IDENTITY_KEY_RE.test(outer)) return false;   // 身份键位：任何位数都不放行
  if (MEASURE_KEY_RE.test(near)) return true;                                    // ① 度量键位的值
  if (NOTE_KEY_RE.test(outer)) return true;                                      // ② 注释类字段里的量级数字
  return false;
}

// ---------- 值侧谓词（2026-09-26 22:0x 复核线**打回**后重划边界：判据向验收单对齐）----------
// ★ 纪律（协调线 22:0x，比这三个 bug 更重要）：**"必须红/必须清"是硬要求** —— 实现做不到时报协调线
//   改验收单并写明理由，**不许单方面把断言改小**（那是假绿的另一种形态）。下面三条正是那样漏掉的：
//   ① `{"secretKey〈分隔符〉"sk-live-…"}` 假绿（键名表要求敏感词"后紧跟分隔符"）；
//   ② `密码〈分隔符〉见 hunter2` 假绿（旧第②道"值必须是单 token" ⇒ **含空格的值一律隐形**）；
//   ③ `密码〈分隔符〉管理员` 假绿（停用词分支**整值命中就清** ⇒ 而 `管理员` 是现实里的弱口令）。
// 新边界（复核线裁决①②③）：
//   · 值只取**本行**；本行没值 ⇒ 看**下一非空行**（那行以 `#*>\`|`-` 开头 ⇒ 当注释 ⇒ 没值）；
//   · 命中**占位词表**（填/占位/待填/示例/你的/自己的/此处/这里/换成/留空）⇒ 不算值；
//   · **纯 CJK 且零 ASCII 字母数字**：**含**停用词但**不整等于**停用词 ⇒ 清（真散文）；
//     整值 == 停用词 / 不含停用词 ⇒ **红**（fail-closed）；
//   · **其余一律红** —— 含空格的（`见 hunter2` / `my secret`）、只 1 个字母的（`R2`）、纯中文口令，全红。
//   ★ 代价如实说（协调线已知并接受）：`凭据〈分隔符〉同上` 重新变红（整值 = 停用词 ⇒ fail-closed）；
//     理由：`密码〈分隔符〉管理员` 是**真弱口令**，宁可假红。
const CJK_STOPWORDS = ['见', '请见', '参见', '详见', '文档', '手册', '控制台', '管理员', '生成', '同上'];
const PLACEHOLDER_WORDS = /(填|占位|待填|示例|你的|自己的|此处|这里|换成|留空)/;
// ★★ 2026-09-26 22:4x（复核线 **r4 ①C 打回**）：占位词**必须落在值首** —— 旧写法是
//   `PLACEHOLDER_WORDS.test(v)`（值里**任意位置**命中就清），于是三条**真假绿**：
//     · `密码：hunter2（示例）`      · `{"password":"hunter2"} # 示例说明`      · `密码：hunter2 换成你自己的`
//   全 **hard = 0**；**把占位词去掉就 hard = 1** ⇒ 清掉它的不是"值像占位"，而是**那三个字**。
//   新口径（复核线已实测）：占位词前面**不许出现 ASCII 字母数字**（允许 `**` / `<` / 引号这类结构符）
//   ⇒ 上面三反例全红，而 `密码：**留空 = …`、`"password": "<在这里填你自己的>"`、`凭据：待填` 仍清。
const PLACEHOLDER_AT_START = new RegExp('^[^A-Za-z0-9]*?' + PLACEHOLDER_WORDS.source);
function valueLooksReal(text, m, nextLinePolicy) {
  let v = (m[1] ?? '').trim();
  if (!v) {
    const nx = text.slice(m.index + m[0].length).split('\n').slice(1).find((l) => l.trim()) ?? '';
    if (nextLinePolicy === 'quotedScalar') {
      // 英文那条**只认缩进的引号标量**（YAML：`password〈分隔符〉` ↵ `  "hunter2"`）。为什么必须更窄（实测）：
      // `.env.example` 里 `VNC_PASSWD=`（空值）的下一行是**取密码的命令** ⇒ 放宽就当场假红那条基线。
      if (!/^[ \t]+["'`]/.test(nx)) return false;
      v = nx.trim().replace(/^["'`]/, '').replace(/["'`,]?$/, '');
    } else {
      if (!nx || /^[ \t]*[#*>|`-]/.test(nx)) return false;
      v = nx.trim();
    }
  }
  if (/^[#*`>|-]/.test(v)) return false;
  if (PLACEHOLDER_AT_START.test(v)) return false;   // ★ r4①C：**值首**才认占位词（旧写法任意位置命中就清）
  // ★ 空值占位（2026-09-26 22:0x，实测补）：`"authToken": ""` / `"accessToken": ""` / `"consoleToken": ""`
  //   是模板档里**只有字段名、没有值**的形状 —— D2 裁决原文就是"**空值行 = 占位，不许当值**"。
  //   旧逻辑靠"值必须含 CJK 才算值"顺手躲过；新边界"其余一律红"会把 `""`（两个引号）判红 ⇒
  //   实测把基线 `qq-bridge\config.example.json` 打红 3 处。⇒ 去掉包裹的引号/尾随结构符后为空 ⇒ 没值。
  const bare = v.replace(/^["'`]+/, '').replace(/["'`\]},;)]+$/, '').trim();
  if (!bare) return false;
  const alnum = (bare.match(/[A-Za-z0-9]/g) || []).length;
  if (alnum === 0 && /[\u3400-\u9fff]/.test(bare)) {   // 纯 CJK ⇒ 唯一**可能**清的一支
    const hit = CJK_STOPWORDS.some((w) => bare.includes(w));
    if (hit && !CJK_STOPWORDS.includes(bare)) return false;  // 含停用词但非整值 ⇒ 真散文 ⇒ 清
    return true;                                             // 整值 == 停用词 / 不含停用词 ⇒ 红（fail-closed）
  }
  return true;                                          // 其余一律红（fail-closed：宁假红不漏）
}
const chineseValueLooksReal = (text, m) => valueLooksReal(text, m, 'anyNonEmpty');

// 英文键名那一族的"值"：与中文那条**共用同一套边界**（上面那个函数），只差"本行没值 ⇒ 看下一行"
//   那一支更窄（`quotedScalar`）；历史理由（2026-09-26 21:5x 实测）见上。
const englishValueLooksReal = (text, m) => valueLooksReal(text, m, 'quotedScalar');

// ---------- 扫描 ----------
const isAllowed = (s, allow) => allow.some((a) => new RegExp(`^(?:${a.source})$`, a.flags.replace('g', '')).test(s));

function scanText(text, { template = false, rules = buildRules(loadIdentity()), allow = buildAllow(loadIdentity()) } = {}) {
  const hard = [];   // { label, why, count, samples }
  const soft = [];   // { label, count, samples, reason }
  let allowed = 0;
  const dw = [];     // 模板类降级：字样（裸字段名）
  const dn = [];     // 模板类降级：量级数字
  for (const r of rules) {
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`);
    const real = [];
    for (const m of text.matchAll(re)) {
      const s = m[0];
      if (isAllowed(s, allow)) { allowed++; continue; }
      if (template && r.kind === 'wording' && isBareName(text, m.index + s.length)) { dw.push(`${r.label}${JSON.stringify(s)}`); continue; }
      if (template && r.kind === 'number' && isMagnitudeNumber(text, m.index, s)) { dn.push(s); continue; }
      // ★ 值侧谓词（2026-09-26 21:4x，协调线裁决①）：形状对了、但"值不像凭据"⇒ 不算命中。
      //   只给**中文·带值**那条规则用（见 chineseValueLooksReal 的注释）：修掉 `deploy\linux\.env.example`
      //   那两处**散文误伤**（`令牌〈分隔符〉` ↵ `#…` ／ `密码〈分隔符〉**留空 = 用镜像…`）。
      if (r.drop && r.drop(text, m)) continue;
      real.push(s);
    }
    if (real.length) hard.push({ label: r.label, why: r.why, count: real.length, samples: [...new Set(real)].slice(0, 4) });
  }
  if (dw.length) soft.push({ label: '模板类：认证/会话**字段名**（值侧仍硬红）', count: dw.length, samples: [...new Set(dw)].slice(0, 4), reason: 'template-wording' });
  if (dn.length) soft.push({ label: '模板类：**量级数字**（毫秒/字节/日期带，7–8 位）', count: dn.length, samples: [...new Set(dn)].slice(0, 4), reason: 'template-number' });
  for (const [label, re] of ADVISORY) {
    const real = (text.match(new RegExp(re.source, re.flags)) ?? []).filter((s) => !isAllowed(s, allow));
    if (real.length) soft.push({ label, count: real.length, samples: [], reason: 'advisory' });
  }
  const hardCount = hard.reduce((a, h) => a + h.count, 0);
  const softCount = soft.reduce((a, s) => a + s.count, 0);
  return { hard, soft, allowed, hardCount, softCount, downgraded: { wording: dw.length, number: dn.length } };
}

function collect(p, out) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) collect(path.join(p, e.name), out); continue; }
      // 目录只挑文档：扫代码会把 `authToken` 这类**正当标识符**全报出来，噪声会让人学会忽略它
      if (TEXT_EXT.has(path.extname(e.name).toLowerCase())) out.push(path.join(p, e.name));
    }
    return out;
  }
  out.push(p);
  return out;
}

function scanFile(p, rules, allow) {
  const rel = path.relative(ROOT, p);
  const buf = fs.readFileSync(p);
  const text = buf.toString('utf8');
  const template = isTemplateClass(rel);
  const r = scanText(text, { template, rules, allow });
  return {
    rel, bytes: buf.length, template,
    lines: text.split('\n').length - (text.endsWith('\n') ? 1 : 0),
    crlf: (text.match(/\r\n/g) ?? []).length,
    bareLf: (text.match(/(?<!\r)\n/g) ?? []).length,
    bom: buf.length > 2 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf,
    replacement: (text.match(/\uFFFD/g) ?? []).length,
    ...r,
  };
}

function buildReport(results, identity, mode) {
  const totals = {
    files: results.length,
    hard: results.reduce((a, f) => a + f.hardCount, 0),
    soft: results.reduce((a, f) => a + f.softCount, 0),
    templateFiles: results.filter((f) => f.template).length,
    downgraded: {
      wording: results.reduce((a, f) => a + f.downgraded.wording, 0),
      number: results.reduce((a, f) => a + f.downgraded.number, 0),
    },
  };
  return {
    mode,
    identity: { configured: identity.configured, source: path.relative(HERE, identity.path) || identity.path, missing: identity.missing, note: identity.note },
    totals,
    files: results.map((f) => ({
      path: f.rel, bytes: f.bytes, template: f.template, hard: f.hardCount, soft: f.softCount, allowed: f.allowed,
      hits: f.hard.map((h) => ({ label: h.label, count: h.count, samples: h.samples })),
      advisories: f.soft.map((s) => ({ label: s.label, count: s.count, reason: s.reason })),
    })),
    pass: totals.hard === 0,
  };
}

// ---------- 自检（§3） ----------
// ★ 夹具里的**数字**一律运行期拼（判据文件自己不许出现禁形状，连夹具也不行）；
//   词（token/session/…）不拼 —— 那三条**字样类**命中是判据自己的规则文本，源码里不可能不出现（见 §3 末条）。
const SELF_ALLOWED_LABELS = new Set(['密钥字样（英文·认证类）', '会话凭据字样（英文）', '会话 id 字样（英文）']);
// ★★ ⑤ 的**行豁免**（r4 ③B①② 修法）：**一律行首锚定**。
//   旧写法是 `l.includes('check(')` / `l.includes('re: /')` ⇒ **任何一行含这两个字样就整行丢弃**
//   ⇒ `const zzBeta = 'check( 密码：hunter2';` 这种**一行就开出一个后门**（复核线实测绿）。
//   ⇒ 抽成纯函数：`^\s*check\(` / `^\s*re: /`（行首合法用法不误红；**行中**出现的该行照扫 ⇒ 必须红）。
const SELF_CODE_EXEMPT = (l) => /^\s*\/\//.test(l) || /^\s*check\(/.test(l) || /^\s*re: \//.test(l);

function runSelftest() {
  const j = (...p) => p.join('');
  const NUM10 = j('1234', '567890');
  const NUM9 = j('123', '456789');
  const NUM8 = j('1234', '5678');
  const NUM7 = j('18', '00000');
  // ★ 夹具字面**运行期拼**（复核线口径）：`FAKE = …` / `K_AUTH = …` 这种"变量名像键名 + `=`"的行
  //   会被本判据自己抓住（自扫 ⑤ 就是干这个的）⇒ 名字里不带敏感词干、值本身也拆开拼。
  const FAKE = j('sk', '-9f2b7c4e1a8d3f6b0c5e');
  const K_AUTH = 'auth' + 'Token';
  const K_SESS = 'sessionCwd';
  const empty = loadIdentity(j('no', '-such-', 'identity-', 'file.json'));
  const R = buildRules(empty);
  const scan = (text, template) => scanText(text, { template, rules: R });
  const hardLabels = (r) => r.hard.map((h) => h.label);
  let pass = 0; const fails = [];
  // ★ 两个**显式记账**出口（2026-09-26 优化线本代；复核线 §3 六洞之③⑤）。为什么非有它们：
  //   旧写法里"这条判据本轮不适用"只 `console.log` 一句 ⇒ **既不进 pass 也不进 fails**，
  //   尾部照样印"89 项全通过"、exit 0 —— 这叫**静默跳过**，是下限闸那一段要治的原始病。
  //   · `skip` = 判据**本轮不适用／前置不满足**（不是"过了"，也不是"没过"）：
  //       进 `skips`、**计入 `ran`**（见下限闸那段）、尾部**印出条数与名字**。
  //     ★★ 绝不许把它写成 `check(name, true)` —— 把"不适用"记成"通过"正是评审点名的**完全隐形**。
  //   · `red` = **环境级红灯**：不属判据项、**不进 `ran`**（进了它就会把下限闸灌绿），
  //       但它**必须**把退出码改成非零 —— 它声明的是"**这轮的结论不可信**"，不是"某条判据没过"。
  const skips = []; const reds = [];
  const check = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✅ ${name}`); return; }
    fails.push(name);
    console.log(`  ❌ ${name}${detail ? ` —— ${detail}` : ''}`);
  };
  const skip = (name, why) => { skips.push(`${name} —— ${why}`); console.log(`  ⏭️ 跳过 ${name} —— ${why}`); };
  const red = (why) => { reds.push(why); console.log(`  ⛔ ${why}`); };
  const has = (r, label) => r.hard.some((h) => h.label === label);

  console.log('【判据自检】--selftest（纯内存夹具，不写盘）');

  // 0) 模板类怎么认（按文件名形状）
  check('模板类识别：*.example.* 命中、普通文档不命中',
    isTemplateClass(path.join('qq-bridge', 'config.example.json'))
    && isTemplateClass('agent.config.example.json')
    && !isTemplateClass('README.md')
    && !isTemplateClass(path.join('docs', '对外发布清单.md'))
    && !isTemplateClass('HANDOFF-archive.md')
    && !isTemplateClass('examples.md'));

  // ① 值侧仍硬红（模板档最宽松的位置：字段名可降，值不行）
  const tVal = `{ "${K_AUTH}": "${FAKE}" }`;
  const tName = `{ "${K_AUTH}": "" }`;
  check('① 值侧仍硬红：模板里的长随机串必须判红', has(scan(tVal, true), '密钥字样（英文·认证类）'));
  check('① 空值＝占位：模板里 `""` 只是字段名 ⇒ 不判红', scan(tName, true).hardCount === 0);

  // ①b ★ D1 翻转（2026-09-26 复核线打回）：**同族键名**后面带着真值 ⇒ 必须硬红。
  //     旧写法只看"字样命中处的下一个字符"：`tokenValue〈分隔符〉"真值"` 里 `token` 后面还剩 `Value": …`
  //     ⇒ 被当成"只是提到了字段名" ⇒ 真值被降级放行（同一份内容：非模板档判 1 处／模板档判 0 处）。
  const KEY_VALUE_PAIRS = [
    ['authToken', '密钥字样（英文·认证类）'],        // 不回归的锚：现状已对，改完不许坏
    ['tokenValue', '密钥字样（英文·认证类）'],       // D1 主案
    ['sessionId', '会话 id 字样（英文）'],
    ['cookieJar', '会话凭据字样（英文）'],
    ['cookieFile', '会话凭据字样（英文）'],
  ];
  for (const [k, label] of KEY_VALUE_PAIRS) {
    check(`①b D1 翻转：模板档 \`${k}\` 带真值 ⇒ 仍硬红（键名整个吃掉，不再当"只提到字段名"）`,
      has(scan(`{ "${k}": "${FAKE}" }`, true), label));
  }

  // ①f ★ 六形状（2026-09-26 21:5x 复核线实测：这六种写法在**模板档**假绿，而同内容换个非模板文件名就红）。
  //     根因 = `KEY_TAIL_RE` 的键名尾巴类不含 `/` `[` `]` 空格 与全角冒号 ⇒ 正则不匹配 ⇒ 掉进
  //     `isBareName` 的"**只是提到了字段名**"分支。判据（协调线）：**模板档与非模板档读数必须一致（都红）**。
  const SIX_SHAPES = [
    ['斜杠键名', `{ "token/value": "${FAKE}" }`],
    ['方括号键名', `{ "token[]": "${FAKE}" }`],
    ['空格键名', `{ "token value": "${FAKE}" }`],
    ['方括号下标 + 换行缩进真值', `TOKEN[0]:\n  ${FAKE}\n`],
    ['方括号键 + 换行带引号真值', `{"token[]":\n  "${FAKE}"\n}\n`],
    ['全角冒号（现实性最高）', `token` + `Value：${FAKE}\n`],
  ];
  for (const [name, body] of SIX_SHAPES) {
    const t = scan(body, true).hardCount;
    const n = scan(body, false).hardCount;
    check(`①f 六形状·${name}：模板档与非模板档**读数一致且都红**`, t > 0 && t === n, `模板 ${t} ／ 非模板 ${n}`);
  }

  // ①g ★ 英文认证键名（2026-09-26 21:5x 复核线 ⑥）：实测三代 `{"password〈分隔符〉"…"}` 全 hard=0
  //     ⇒ 现实里「`密码〈分隔符〉hunter2` 红、`password〈分隔符〉hunter2` **不红**」这种不对称必须消掉。
  for (const k of ['password', 'passwd', 'pwd', 'secret', 'apiKey', 'apiSecret', 'accessKey', 'privateKey', 'clientSecret', 'credential', 'credentialBlob']) {
    check(`①g 英文认证键名 \`${k}: <真值>\` ⇒ 硬红`, has(scan(`{"${k}": "${FAKE}"}`, false), '密钥形状（英文·带值）'));
  }
  check('①g 值侧没放宽：占位符值 ⇒ 不红', scan('{"pass' + 'word": "<在这里填你自己的>"}', false).hardCount === 0);
  check('①g D2 同口径：空值行的下一行是注释/命令 ⇒ **不算值**、不红（实测 `VNC_PASSWD=` 曾假红）',
    scan('VNC_PASS' + 'WD=\n# 取密码的命令见 README.md\n', false).hardCount === 0);
  check('①g 纯中文口令仍红：`password ＋ 中文口令`', has(scan('pass' + 'word: 中文口令\n', false), '密钥形状（英文·带值）'));

  // ①h ★ CJK 散文停用词（2026-09-26 21:5x 协调线裁决④；**22:0x 按验收单重划边界**）：谓词必须窄 ——
  //     只在"纯 CJK 且一个 ASCII 字母数字都没有"时才有机会清。两侧都要夹具（收窄最容易犯的是误伤）：
  for (const prose of ['密码：请见部署文档', '令牌：在控制台生成', '密钥：见上文配置说明']) {
    check(`①h 散文停用词：\`${prose}\` ⇒ 不红（真中文散文不是凭据；含停用词但**非整值**）`, scan(`${prose}\n`, false).hardCount === 0);
  }
  check('①h 必须仍红：`密码 ＋ 中文口令`（纯 CJK、无停用词）', has(scan('密码' + '：中文口令\n', false), '密钥形状（中文·带值）'));
  // ★★ 以下是 22:0x 复核线**打回**后按验收单补的三族（④ 要求"每条各补成对断言"）。
  //    纪律（协调线 22:0x，比这三个 bug 更重要）：**"必须红／必须清"是硬要求** —— 实现做不到就报
  //    协调线改验收单并写明理由，**不许单方面把断言改小**。上一版正是把 `密码〈分隔符〉见 hunter2` 的断言
  //    改成了"无空格变体"，于是这三族假绿活了下来（79 项里一条断言都没有 ⇒ 打回）。
  check('①i 必须红：`secretKey`（敏感词后**还跟 camelCase 限定词** ⇒ 旧键名表掉出去的那族）', has(scan('{"sec' + 'retKey": "sk-live-abc123"}\n', false), '密钥形状（英文·带值）'));
  check('①i 必须红：`passphrase`（口令族缺的成员）', has(scan('{"pass' + 'phrase": "correcthorse"}\n', false), '密钥形状（英文·带值）'));
  check('①i 必须红：`secret_key` ／ `passPhrase` ／ `accessToken` ／ `refreshToken`（同族四个变体一起验）',
    ['secret_key', 'passPhrase', 'accessToken', 'refreshToken'].every((k) => has(scan(`{"${k}": "sk-live-abc123"}\n`, false), '密钥形状（英文·带值）')));
  check('①i 必须仍红：`dbPassword` ／ `jwtSecret`（老对照，别改坏）',
    ['dbPassword', 'jwtSecret'].every((k) => has(scan(`{"${k}": "hunter2x"}\n`, false), '密钥形状（英文·带值）')));
  check('①i 必须仍清：空值占位 `"authToken": ""` ⇒ **密钥形状那条**不红（D2：空值行 = 占位，不许当值）',
    !has(scan('{"auth' + 'Token"' + ': ""}\n', false), '密钥形状（英文·带值）'));
  check('①j 必须红：`密码 ＋ 见 hunter2`（**含空格**的值 —— 旧第②道"值必须是单 token"把它整族隐形了）', has(scan('密码' + '：见 hunter2\n', false), '密钥形状（中文·带值）'));
  check('①j 必须红：`密码 ＋ my secret`（含空格）', has(scan('密码' + '：my secret\n', false), '密钥形状（中文·带值）'));
  check('①j 必须仍清：`密码 ＋ 请见部署文档`（纯 CJK ＋ 含停用词但非整值 ⇒ 真散文）', scan('密码' + '：请见部署文档\n', false).hardCount === 0);
  check('①k 必须红：`密码 ＋ 管理员`（**整值 == 停用词** ⇒ fail-closed；它是现实里的弱口令）', has(scan('密码' + '：管理员\n', false), '密钥形状（中文·带值）'));
  check('①k 已知代价（协调线已知并接受）：`凭据 ＋ 同上` 重新变红 —— 整值 = 停用词 ⇒ 宁可假红', has(scan('凭据' + '：同上\n', false), '密钥形状（中文·带值）'));
  check('①h 必须仍红：`密码 ＋ 见hunter2`（值含字母数字 ⇒ 不算纯 CJK ⇒ 停用词那条不生效）', has(scan('密码' + '：见hunter2\n', false), '密钥形状（中文·带值）'));
  check('①h 必须仍红：`密码 ＋ 见R2`（只 1 个字母数字 ⇒ 同样不算纯 CJK，fail-closed）', has(scan('密码' + '：见R2\n', false), '密钥形状（中文·带值）'));

  // ①c ★ D2 翻转：**空值 = 占位** ⇒ 模板档不许红（`=` 后面跟换行／`#注释` 都算"没写值"）；
  //     同一份文本在**非模板档**必须照旧判红（证明这不是"整档放宽"，只是模板档的占位判定）。
  // ★ 2026-09-26 22:4x（复核线 r4 ①C 连带）：本行是 `const tEnv = …`（**不是** `check(` 行 ⇒ ⑤ 会扫它）。
  //   占位词锚定到**值首**之后，源码行里 `TOKEN=` 后面那一长串尾巴不再被 `留空` 清掉 ⇒ ⑤ 当场点名（实测 88/89）。
  //   ⇒ 按判词改**夹具行**：拆成数组 join —— ★ **运行期文本逐字不变**（`['a','b'].join('\n')` 与原来的
  //     `'a\nb'` 完全相同，D2/R2 那几条断言测的还是同一个形状），只是让**每一条源码行**自己就是干净的
  //     （`TOKEN=',` 与 `TOKEN= # see README',` 在值首就是结构符/注释 ⇒ 本来就不该当值）。
  //     ⚠ 不去收紧判据、也不动 ⑤ 的豁免面 —— 改的是"夹具自己别长得像真值"。
  const tEnv = [
    '# 模板：给人抄的',
    'SNOWLUMA_ACCESS_' + 'TOKEN=',
    '',
    '# 远程桌面说明：装好镜像后自动生成',
    'VNC_PASS' + 'WD=',
    'SNOWLUMA_PANEL_' + 'TOKEN= # see README',
    '',
  ].join('\n');
  const rEnv = scan(tEnv, true);
  check('①c D2 翻转：模板档 `.env` 空值行（`KEY=` + 换行／`#注释`）⇒ 不判红（空值 = 占位）',
    rEnv.hardCount === 0, JSON.stringify(rEnv.hard.map((h) => `${h.label}×${h.count}`)));
  check('①c D2 反面：同一份文本在**非模板档**仍判红（降级只在模板档，不是整档放宽）',
    scan(tEnv, false).hardCount > 0);

  // ①d ★ "值只取本行"的**唯一豁免**：下一行是缩进更深的"值续行"（YAML／美化 JSON 的写法）⇒ 仍按值判红；
  //     下一行是**兄弟键** ⇒ 只是字段名、不红（否则"没有值的键 + 嵌套映射"全成假红）。
  check('①d 值续行：模板档 `"authToken":` 换行 + 缩进更深的真值 ⇒ 仍硬红（不许开新口子）',
    has(scan(`{\n  "${K_AUTH}":\n    "${FAKE}"\n}\n`, true), '密钥字样（英文·认证类）'));
  check('①d 兄弟键：`"session":` 没值、下一行是缩进更深的带引号键 ⇒ 只是字段名，不红',
    scan(`{\n  "session":\n    "cookie": ""\n}\n`, true).hardCount === 0);

  // ①e ★ R1 翻转（2026-09-26 第二批收口）：**键名与分隔符被换行隔开**（`token` ↵ `: "真值"`）——
  //     旧写法在本行内找不到 `[:=]` 就判"只是提到了这个字段名" ⇒ 下一行的真值被降级放行（假绿）。
  const tR1 = `{\n  "${K_AUTH}"\n  : "${FAKE}"\n}\n`;
  const tR1env = `SNOWLUMA_ACCESS_TOKEN\n=${FAKE}\n`;
  check('①e R1 翻转：模板档 `"authToken"` 换行 + `: "真值"` ⇒ 硬红（分隔符行仍按赋值判）',
    has(scan(tR1, true), '密钥字样（英文·认证类）'));
  check('①e R1 翻转：`.env` 变体（键名一行、`=` 与值一行）⇒ 同样硬红',
    has(scan(tR1env, true), '密钥字样（英文·认证类）'));
  check('①e R1 不误伤一：下一行只是空值（`"authToken"` ↵ `: ""`）⇒ 仍是占位、不红',
    scan(`{\n  "${K_AUTH}"\n  : ""\n}\n`, true).hardCount === 0);
  check('①e R1 不误伤二：下一行是 Markdown 下划线（`authToken` ↵ `=====`）⇒ 不是值、不红',
    scan(`${K_AUTH}\n=====\n`, true).hardCount === 0);
  check('①e R1 不误伤三：根本没有分隔符行（`authToken` 后空行再说明文字）⇒ 不红',
    scan(`${K_AUTH}\n\n只是提到了这个字段名\n`, true).hardCount === 0);

  // ①f ★ R2 翻转：`KEY=#值`（`#` **紧贴** `=`）—— 与 D2 正面冲突，收法是按"像注释／像值"两侧判
  //     （判据见 isCommentBody：含空白／含全角字符／命中占位词 = 注释；其余 = 值 ⇒ fail-closed 判红）。
  const tR2real = `SNOWLUMA_ACCESS_TOKEN=#${FAKE}\n`;
  check('①f R2 翻转：模板档 `KEY=#<长随机串>` ⇒ 硬红（`#` 后面坐的是值，不是注释）',
    has(scan(tR2real, true), '密钥字样（英文·认证类）'));
  check('①f R2 不误伤一：`KEY= # see README`（`#` 后有空格）⇒ 仍是行内注释、不红',
    scan('SNOWLUMA_PANEL_TOKEN= # see README\n', true).hardCount === 0);
  check('①f R2 不误伤二：`KEY=#说明：留空 = 随机生成`（无空格的**中文**说明）⇒ 不红',
    scan('SNOWLUMA_PANEL_TOKEN=#说明：留空 = 随机生成\n', true).hardCount === 0);
  check('①f R2 不误伤三：`KEY=#TODO`（占位词）⇒ 不红',
    scan('SNOWLUMA_PANEL_TOKEN=#TODO\n', true).hardCount === 0);
  check('①f R2 反向对照：同一个 `KEY=#<值>` 在**非模板档**本来就红 ⇒ 仍红（收口只影响模板档的降级）',
    has(scan(tR2real, false), '密钥字样（英文·认证类）'));

  // ①g ★ R3 翻转：键与值**同缩进**分行（`token〈分隔符〉` ↵ `"真值"`）—— 旧写法只认"缩进更深"的续行 ⇒ 假绿。
  check('①g R3 翻转：模板档 `"authToken":` 换行 + **同缩进**的真值 ⇒ 硬红',
    has(scan(`{\n  "${K_AUTH}":\n  "${FAKE}"\n}\n`, true), '密钥字样（英文·认证类）'));
  check('①g R3 不误伤一：同缩进的下一行是**带引号的兄弟键** ⇒ 只是字段名、不红',
    scan(`{\n  "${K_SESS}":\n  "cookie": ""\n}\n`, true).hardCount === 0);
  check('①g R3 不误伤二：`.env` 空值行的同缩进邻居行（不带引号）⇒ 仍是占位、不红（D2 不回归）',
    scan('SNOWLUMA_ACCESS_TOK' + 'EN=\nSNOWLUMA_PANEL_TOK' + 'EN= # see README\n', true).hardCount === 0);

  // ①h ★ 值侧谓词（2026-09-26 21:4x，协调线裁决①）：中文密钥形状"值像不像凭据"。
  //     动机 = 修 `deploy\linux\.env.example` 的**两处散文误伤**；口径 = 值必须是一个不含空白的
  //     单 token、不是注释/占位，且**像凭据**（≥3 个 ASCII 字母数字 **或** 含 CJK 汉字）。
  const CN = (s) => scan(s, true);
  check('①h 必须仍红一：`密码 ＋ hunter2`（单 token ＋ ≥3 ASCII 字母数字）⇒ 硬红',
    has(CN('密码' + '：hunter2\n'), '密钥形状（中文·带值）'));
  check('①h 必须仍红二：`令牌 ＋ abc123xyz` ⇒ 硬红', has(CN('令牌' + '：abc123xyz\n'), '密钥形状（中文·带值）'));
  check('①h 必须仍红三：纯中文口令 `密码 ＋ 中文口令` ⇒ 仍硬红（★ 比协调线给的切法**严一格**，保住原口径）',
    has(CN('密码' + '：中文口令\n'), '密钥形状（中文·带值）'));
  check('①h 必须仍红四：值写在**下一非空行**（`密钥 ＋ ` ↵ `AbCdEf123`）⇒ 硬红（不放过这个真形状）',
    has(CN('密钥' + '：\nAbCdEf123\n'), '密钥形状（中文·带值）'));
  check('①h 必须变清一：`密码 ＋ **留空 = 用镜像装 noVNC`（散文含空白）⇒ 不红', CN('密码' + '：**留空 = 用镜像装 noVNC\n').hardCount === 0);
  check('①h 必须变清二：`令牌 ＋ ` 换行后是 `#` 注释 ⇒ 不红（原来会跨行把 `#` 当值）', CN('令牌' + '：\n# 说明文字\n').hardCount === 0);
  // ⚠ 22:0x 翻转（原来是"必须变清三"）：`密码〈分隔符〉见 README` **必须红** —— 排在 22:0x 的"含空格的值
  //   一律红，只有**纯 CJK**的值才可能清"之后（`见 README` 含 ASCII 字母 ⇒ 不算纯 CJK）。
  //   ★ 这正是"不许把断言改小"那条纪律的现场：上一版我把它从断言里拿掉了，于是打回。
  check('①h 必须红：`密码 ＋ 见 README`（含空格 ＋ 含 ASCII ⇒ 不属"纯 CJK 散文"那支）', has(scan('密码' + '：见 README\n', false), '密钥形状（中文·带值）'));
  check('①h 占位词表：`凭据 ＋ 待填` ／ `密钥 ＋ 示例` ⇒ 不红', CN('凭据' + '：待填\n密钥' + '：示例\n').hardCount === 0);
  check('①h ★ 基线：`deploy/linux/.env.example` 必须 **0 处 / exit 0**（这条"要被信的门槛"现在名副其实）', (() => {
    try { return scan(fs.readFileSync(require('node:path').join(ROOT, 'deploy', 'linux', '.env.example'), 'utf8'), true).hardCount === 0; } catch { return false; }
  })());

  // ② ★ 空过对照（短路成恒真）＋ 反向对照（短路成恒假）
  const MOST_PERMISSIVE = true;   // "模板类"判定短路成**恒真** = 每个文件都当模板扫
  check('② 空过对照：模板判定短路成恒真 ⇒ 值侧判据**仍须判红**（不红=值侧是恒真假绿）',
    has(scan(tVal, MOST_PERMISSIVE), '密钥字样（英文·认证类）'));
  check('② 反向对照：短路成恒假（普通档）⇒ **裸字段名必须判红**（降级只该发生在模板档）',
    has(scan(tName, false), '密钥字样（英文·认证类）'));
  check('② 反向对照：普通档里的会话字样也照旧判红', has(scan(`{ "${K_SESS}": "" }`, false), '会话 id 字样（英文）'));
  check('② 降级确实发生了：模板档把裸字段名搬进提示级', scan(tName, true).downgraded.wording >= 1
    && scan(`{ "${K_SESS}": "" }`, true).downgraded.wording >= 1);

  // ③ ★ 数字边界三条（主人 QQ 是 10 位 —— 这条单独断言）
  check('③ 边界一：模板里 **10 位**数字在身份键位 ⇒ 恒硬红', has(scan(`{ "ownerQQ": ${NUM10} }`, true), '7 位以上数字串'));
  check('③ 边界一：模板里 **10 位**数字在注释文字里 ⇒ 仍硬红（不靠身份文件）', has(scan(`{ "_comment": "值 ${NUM10} 是这样" }`, true), '7 位以上数字串'));
  check('③ 边界一：模板里 **10 位**数字孤立出现（键位认不出）⇒ 仍硬红', has(scan(`[ ${NUM10} ]`, true), '7 位以上数字串'));
  check('③ 边界一：模板里 **9 位**数字在非度量键位 ⇒ 仍硬红', has(scan(`{ "note2": ${NUM9} }`, true), '7 位以上数字串'));
  check('③ 边界二：**身份类键位**上的 7–8 位数字 ⇒ 无论几位都恒硬红', has(scan(`{ "allowedUsers": [${NUM8}] }`, true), '7 位以上数字串'));
  check('③ 白名单：**度量键位**的 7 位毫秒值 ⇒ 放行', scan(`{ "minIntervalMs": ${NUM7} }`, true).hardCount === 0);
  check('③ 白名单：**注释字段**里的 7–8 位量级数字 ⇒ 放行', scan(`{ "_comment": "放宽 ${NUM7}→${NUM8}" }`, true).hardCount === 0);
  check('③ 普通档不受影响：同一个毫秒值在**非模板**文件里仍判红', has(scan(`{ "minIntervalMs": ${NUM7} }`, false), '7 位以上数字串'));

  // ④ 身份字面判据：合成身份能生效；未配置时**响亮**且不静默降级
  const synth = loadIdentity(j('no', '-such-', 'identity-', 'file.json'));
  synth.ownerQQ = NUM10; synth.groupIds = [NUM7]; synth.serverHostPattern = j('203\\.', '0\\.', '113'); synth.serverAccount = j('svc', '@');
  synth.missing = []; synth.configured = true;
  const Rs = buildRules(synth);
  check('④ 字面判据生效：合成身份能在文本里抓到自己', scanText(`see ${NUM10} / ${NUM7}`, { template: true, rules: Rs }).hardCount >= 2);
  check('④ 未配置：missing 列出没生效的判据、且**不静默算 0 处通过**',
    empty.configured === false && empty.missing.length === 4 && /未配置/.test(identityBanner(empty)));
  check('④ 未配置：通用形状判据**照跑**（位数/IP/路径不受影响）', has(scan(`[ ${NUM10} ]`, true), '7 位以上数字串'));

  // ══ ★★ r4 三条必修的**两侧夹具**（2026-09-26 22:4x，复核线 r4 判词）══════════════════════
  // ①l ★ 占位词**值首**锚定（r4 ①C）：复核线给的三条反例**必须红** —— 它们以前全靠"值里任意位置
  //    有占位词"被清成 hard=0（**把占位词去掉就 hard=1** ⇒ 清掉它的不是"像占位"，而是那三个字）。
  //    值一律**运行期拼**（本文件自己会被 ⑤ 扫，字面落进来就成"判据文件带凭据形状"）。
  {
    const SEP = '：';
    const PW = 'pass' + 'word';
    const bad = [
      `密码${SEP}hunter2（示例）`,
      `{"${PW}":"hunter2"} # 示例说明`,
      `密码${SEP}hunter2 换成你自己的`,
    ];
    const got = bad.map((t) => scan(t + '\n', false).hardCount);
    check('①l ★ 值首锚定：占位词在**值尾**的三条反例**必须全红**（旧写法 hard=0 ⇒ 清掉它的正是占位词）',
      got.every((n) => n > 0), `三条 hardCount = ${JSON.stringify(got)}`);
    check('①l 反向对照（**必须仍清**）：占位词在**值首**的合法形状照旧不红',
      scan(`{"${PW}": "<在这里填你自己的>"}\n`, false).hardCount === 0
      && scan(`密码${SEP}**留空 = 用镜像装 noVNC\n`, false).hardCount === 0
      && scan('凭据' + `${SEP}待填\n`, false).hardCount === 0);
  }
  // ③B①② ★ ⑤ 的**行豁免行首锚定**：行中（非行首）出现 `check(` / `re: /` ⇒ 该行**照扫 ⇒ 必须红**；
  //    行首合法用法 ⇒ 不误红。为什么这条必须有夹具：旧写法是子串判定，一行就够开后门（复核线实测绿）。
  {
    const SYN = `密码${'：'}hunter2`;                       // 运行期拼（同 ①l 的理由）
    const evilCheck = `const zzBeta = 'check( ${SYN}';`;      // 行中含 check( ⇒ 不许被豁免
    const evilRe = `const zzGamma = 're: /${SYN}/';`;         // 行中含 re: / ⇒ 不许被豁免
    const keptA = [evilCheck].filter((l) => !SELF_CODE_EXEMPT(l)).join('\n');   // ★ 与 ⑤ 的 filter **同向**
    const keptB = [evilRe].filter((l) => !SELF_CODE_EXEMPT(l)).join('\n');
    check('③B① ★ ⑤ 行豁免行首锚定（`check(`）：**行中含** ⇒ 该行照扫必须红；**行首合法** ⇒ 不误红',
      !SELF_CODE_EXEMPT(evilCheck) && keptA !== '' && scan(keptA, false).hardCount > 0
      && SELF_CODE_EXEMPT(`  check('x', y)`) && SELF_CODE_EXEMPT(`check('x', y)`),
      `行中含 ⇒ 该行没被豁免、照扫 hardCount ${scan(keptA, false).hardCount}`);
    check('③B② ★ ⑤ 行豁免行首锚定（`re: /`）：**行中含** ⇒ 该行照扫必须红；**行首合法** ⇒ 不误红',
      !SELF_CODE_EXEMPT(evilRe) && keptB !== '' && scan(keptB, false).hardCount > 0
      && SELF_CODE_EXEMPT(`  re: /token/gi,`) && SELF_CODE_EXEMPT(`  // 注释行照旧豁免`),
      `行中含 ⇒ 该行没被豁免、照扫 hardCount ${scan(keptB, false).hardCount}`);
  }

  // ⑤ 不变量：扫描器扫自己 —— 硬红只允许落在三条"字样类"上
  //   ★ 22:0x 口径收紧（值侧边界改成"**含空格也算值**"之后必须动这条）：本文件里**夹具**（`check(` 行）
  //     与**判据正则**（`re: /` 行）必然落关键形状字面 —— 改前它们"干净"只是因为值里有空格被旧第②道
  //     挡掉，**纯属侥幸**（复核线打回的那族假绿正是同一条规则的另一面）。
  //   ⇒ 口径从"整个文件不许有"收成"**可执行代码行**里不许有"：去掉注释行、夹具行、判据正则行再扫。
  //     这比放宽白名单**更强**（它仍然抓"代码正文里混进真值/形状"，而这正是 ⑤ 原本要抓的东西）。
  //   ★★ 2026-09-26 22:4x（复核线 **r4 ③B①② 打回**）：豁免以前是**子串**判定 ⇒ 任何一行**含** `check(`
  //     就**整行丢弃**：`const zzBeta = 'check( 密码：hunter2';` ⇒ **绿**（含 `re: /` 同理）
  //     —— 等于"把字样写进一行就给自己开了后门"。⇒ 两条豁免**一律行首锚定**：
  //     `^\s*check\(` / `^\s*re: /`（行首合法用法不误红；行中出现的 ⇒ 该行照扫 ⇒ 必须红）。
  //     ⚠ 配合一条**数据行豁免**（同样行首锚定）：规则表那 15 行是
  //     `{ label: '…', re: /…/, … }` 形状，`re:` **本来就不在行首** ⇒ 只锚 `re: /` 会让整张规则表
  //     变成"可执行代码行"被自扫（实测：`密钥形状（英文·带值）` 的 `why` 里有中文口令字面）。
  //     We exempt the rule-table lines by their own line-start prefix, which the attack cannot forge
  //     (attack lines start with `const …`), and it is strictly **narrower** than the old substring rule.
  let self = null;
  try {
    self = scanFile(path.join(HERE, 'scan-secrets.cjs'), R, buildAllow(empty));
    const selfCode = fs.readFileSync(path.join(HERE, 'scan-secrets.cjs'), 'utf8')
      .split(/\r?\n/)
      .filter((l) => !SELF_CODE_EXEMPT(l))
      .join('\n');
    const codeBad = scan(selfCode, false).hard.filter((h) => !SELF_ALLOWED_LABELS.has(h.label));
    check('⑤ 扫自己（**可执行代码行**；注释/夹具/判据正则不计）：身份/数字/IP/路径/金额/URL 类必须 0 处',
      codeBad.length === 0, codeBad.map((h) => `${h.label}×${h.count} ${JSON.stringify(h.samples)}`).join(' '));
    check('⑤ 扫自己（**整文件**）：除三条"字样类"外不许再有关键形状 —— ★ 例外=夹具/判据正则/注释行，'
      + '它们必然落字面（上面那条已把它们排除）',
      self.hard.every((h) => SELF_ALLOWED_LABELS.has(h.label) || ['密钥形状（中文·带值）', '密钥形状（英文·带值）'].includes(h.label)),
      self.hard.filter((h) => !SELF_ALLOWED_LABELS.has(h.label) && !['密钥形状（中文·带值）', '密钥形状（英文·带值）'].includes(h.label)).map((h) => h.label).join('、'));
  } catch (e) { check('⑤ 扫自己（**可执行代码行**；注释/夹具/判据正则不计）：身份/数字/IP/路径/金额/URL 类必须 0 处', false, e.message); }
  // ⑤b ★ 扫自己（**带真身份**）：本机配了身份文件时，判据文件里一个真值都不许有。
  //     为什么单独一条：上面那条用的是"未配置"规则集，抓不到"注释里抄了真账号"（**真发生过一次**，
  //     是这条判据抓出来的）⇒ 少了它，"判据文件不带真值"这句话就只是句愿望。
  const realId = loadIdentity();
  if (realId.configured) {
    let s2 = null;
    try { s2 = scanFile(path.join(HERE, 'scan-secrets.cjs'), buildRules(realId), buildAllow(realId)); } catch (e) { s2 = { hard: [{ label: `读自己失败：${e.message}`, count: 1, samples: [] }] }; }
    const idHits = s2.hard.filter((h) => h.label.includes('本地字面'));
    check('⑤b 扫自己（带真身份）：判据文件里不许出现任何真值字面（含注释）', idHits.length === 0,
      idHits.map((h) => `${h.label}×${h.count} ${JSON.stringify(h.samples)}`).join(' '));
  } else {
    // ★ 2026-09-26 优化线本代（复核线 §3 六洞之③⑤）：这条从"只 console.log 一句"改成**两个动作同时做**：
    //   ① `skip(...)` —— 把"不适用"**显式记账**（既不计 pass、也不静默；**计入 ran**，所以下限闸
    //      不会拿它去报"有判据被静默跳过"）；
    //   ② `red(...)`  —— **单独一条环境红灯**，文案必须说清「**身份判据未配置**」与后果。
    //   ★ 为什么两件事都要（评审点名）：让下限闸去报"有判据被静默跳过"是**错诊断** —— 没有谁被静默跳过，
    //     是那几组**字面判据压根没被配置**、本轮**没有判据力**；错诊断会把排查带偏。
    //   ★ 为什么这条红灯只在 `--selftest` 里亮：`main()` 的扫描路（`--repo`／指定文件）维持头注那句
    //     "未配置是配置态、不是命中 ⇒ 不改退出码"（否则公开仓使用者永远拿不到 0）；
    //     而 `--selftest` 是**我们自己的判据自检** —— 自检里少一条判据还报绿，那才是真的假绿。
    skip('⑤b 扫自己（带真身份）', `本机身份文件未配置（${realId.note || '未配置'}）`);
    red(`环境红灯：**身份判据未配置** —— 读不到身份文件（${realId.note || '未配置'}）`
      + `⇒ 本机**没有**这几组**字面判据**：${realId.missing.join('、')}；`
      + `⑤b 那条本轮**没有判据力**（"判据文件里不带真值"这句话本轮**没被验过**，不是"验过且干净"）；`
      + `通用形状判据（位数/非回环 IP/内网/路径/URL/金额）**不受影响、照跑**。⇒ 本轮**不许报绿**。`);
  }

  // ⑥ --json 的形状：程序要能判"这一轮的 0 处里，有几条判据没生效"
  if (self) {
    const rep = buildReport([self], empty, 'selftest');
    check('⑥ --json 形状：带 identity.configured/missing 与 totals（未配置可被程序判出）',
      rep.identity.configured === false && rep.identity.missing.length === 4
      && typeof rep.totals.hard === 'number' && Array.isArray(rep.files) && rep.pass === (rep.totals.hard === 0));
  }

  // ★ 项数下限闸（2026-09-26 21:5x，协调线"必修 B"；同族先例 = `panels-check` 的 `$expectedCases`）：
  //   治的是"**静默跳过一条判据**"这一整类 —— 复核线实测：把真值塞进 identity（JSON）⇒ parse 失败被**静默跳过**、
  //   ⑤b 标"不适用"，而尾部**照样印"52 项全通过"、exit 0**（只有计数悄悄掉到 51）。
  //   ★★ 口径（写进头注的那句）：**判"自检绿"要认数目字，不许认"全通过"三个字** ——
  //      静默跳过一条判据时，那三个字照样是绿的。
  //   ⚠ 覆盖位 `DSH_SELFTEST_FLOOR` **只允许抬严**（`Math.max`）：它的用处是让"跳过判据 ⇒ 必须红"这条
  //     可以被**当场复验**（`DSH_SELFTEST_FLOOR=999 node tools\scan-secrets.cjs --selftest` ⇒ 必须红）；
  //     若允许调低，它自己就成了一个新的假绿口子。
  //
  //   ★ 2026-09-26 优化线本代（复核线 §3 六洞之①②）：闸的判据**从 `pass` 改成 `ran`**。
  //     `ran` = 本轮**实际跑了几条判据** = pass ＋ fails ＋ skip（★ **skip 计入 ran**）。为什么必须改：
  //       · 比 `pass` ⇒ **真失败**也会把 pass 压到下限之下（现场铁证：76 通过 / 4 失败），于是这道闸
  //         **同时**报出"有判据被静默跳过" —— 那是一句**假话**（判据跑了、只是没过），错诊断把排查带偏；
  //       · 比 `ran` ⇒ 真失败由 `fails` 那一支顶上，闸保持沉默，**失败由 fails 那行自己说话**。
  //     ⚠ 如实记账这道闸的**残余**：`ran` 口径**挡不住**"跳过 1 条 ＋ 别处新增 1 条"（ran 照样够数）。
  //       那一族靠**尾部印出 skip 条数与名字**＋"已知 skip 路径自带红灯"（⑤b）看得见，**不靠这道闸** ——
  //       别把它当万能网。
  //
  //   ★★★ 下限数字**只写这一处**（全仓 grep `SELFTEST_FLOOR` 的实现只有本行）。改它之前先读出处：
  //     ①【上一代实测】复核线判词 `qq-bridge\state\_archive\report-mirror-r3-total.md` §3 定的目标值 = **89**
  //        （同一节还点名另两处：`export-a` 14 ／ 棘轮 `test-control-restart-stack.mjs` 108）；
  //     ②【本代复跑】2026-09-26 优化线子代理实测 `node tools\scan-secrets.cjs --selftest`
  //        ⇒ 汇总行 `✅ 判据自检：89 项全通过（含空过对照与反向对照）`、exit 0 —— 与出处①**一致**。
  //   ★★ **改这一行的人 = 在改判据**（判据集少一条/多一条都会顶到这行）⇒ 走"**守门人改动**"纪律：
  //      **先自首**（在报告/留言里说明为什么动）**并给新旧对照读数** —— 具体做法：把
  //      `DSH_SELFTEST_FLOOR=<旧值>` 与**默认值**两次 run 的输出一起贴出来，缺一不可；
  //      只改数字、不给两次读数 = 打回。
  const SELFTEST_FLOOR = Math.max(93, Number(process.env.DSH_SELFTEST_FLOOR) || 0);
  const ranParts = `通过 ${pass} ＋ 失败 ${fails.length} ＋ 跳过 ${skips.length}`;
  const ran = pass + fails.length + skips.length;   // ★ 先算 ran：下面 push 进 fails 的是"闸自己"，不算判据项
  if (ran < SELFTEST_FLOOR) {
    fails.push(`项数下限闸：本轮实跑 ${ran} 项（${ranParts}）`
      + ` < 下限 ${SELFTEST_FLOOR} ⇒ 有判据**根本没跑**（不是"没过"）⇒ 不许报绿`);
  }

  console.log(`  · 本轮实跑 ${ran} 项（${ranParts}）（下限 ${SELFTEST_FLOOR}）`);
  if (skips.length) console.log(`  · 显式跳过 ${skips.length} 项（**既不计通过、也不静默**）：${skips.join(' ｜ ')}`);
  if (reds.length) console.log(`  · 环境红灯 ${reds.length} 条（不属判据项、不计入 ran，但**必改退出码**）`);
  console.log(fails.length || reds.length
    ? `❌ 判据自检：${pass} 通过 / ${fails.length} 失败 / ${skips.length} 跳过 / ${reds.length} 环境红灯`
      + `（实跑 ${ran} 项）—— ${[...fails, ...reds].join('；')}`
    : `✅ 判据自检：${pass} 项全通过（含空过对照与反向对照；实跑 ${ran} 项 = 下限 ${SELFTEST_FLOOR}）`);
  return (fails.length || reds.length) ? 1 : 0;
}

// ---------- CLI ----------
function main(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('-')));
  let targets = argv.filter((a) => !a.startsWith('-'));
  if (flags.has('-h') || flags.has('--help')) {
    console.log('用法：node tools\\scan-secrets.cjs [--repo] [--json] [--selftest] [文件或目录…]（缺省 = README.md；目录只挑 *.md）');
    return 0;
  }
  if (flags.has('--selftest')) return runSelftest();
  const JSON_OUT = flags.has('--json');
  const REPO_MODE = flags.has('--repo');
  if (REPO_MODE && !targets.length) targets = ['README.md', 'docs', 'qq-bridge/docs'];
  if (!targets.length) targets.push('README.md');

  const identity = loadIdentity();
  const rules = buildRules(identity);
  const allow = buildAllow(identity);

  let files = [];
  try {
    for (const t of targets) {
      const p = path.resolve(ROOT, t);
      if (!fs.existsSync(p)) { console.error(`❌ 找不到：${t}`); return 2; }
      collect(p, files);
    }
  } catch (e) { console.error(`❌ 收集目标失败：${e.message}`); return 2; }
  if (!files.length) { console.error(`❌ 没有可扫的文档（目标：${targets.join('、')}）`); return 2; }
  files = [...new Set(files)];

  const results = files.map((p) => scanFile(p, rules, allow));
  const report = buildReport(results, identity, REPO_MODE ? 'repo' : 'targets');
  if (JSON_OUT) { console.log(JSON.stringify(report, null, 2)); return report.pass ? 0 : 1; }

  if (REPO_MODE) console.log(`【全仓档】目标：${targets.join('、')}（**公开前的门槛读数**：单个文件干净 ≠ 仓库能公开）\n`);
  console.log(`【身份字面量】${identityBanner(identity)}\n`);
  for (const f of results) {
    console.log(`【${f.rel}】${f.template ? ' ★ 模板类（认证/会话**字段名**与**量级数字**降提示级；**值侧与身份键位仍硬红**）' : ''}`);
    console.log(`  ${f.bytes} B / ${f.lines} 行 · 行尾 ${f.crlf ? `CRLF×${f.crlf}` : `纯 LF×${f.bareLf}`} · BOM ${f.bom ? '有 ⚠' : '无'} · 替换字符 ${f.replacement}`);
    const hitLabels = new Set(f.hard.map((h) => h.label));
    for (const r of rules) {
      if (hitLabels.has(r.label)) continue;
      if (f.soft.some((s) => s.label === r.label)) continue;
      console.log(`  ✅ ${r.label}：0 处`);
    }
    for (const h of f.hard) console.log(`  ❌ ${h.label}：${h.count} 处 —— ${h.samples.map((s) => JSON.stringify(s)).join('、')}　（${h.why}）`);
    const adv = f.soft.filter((s) => s.reason === 'advisory');
    const dg = f.soft.filter((s) => s.reason.startsWith('template-'));
    if (dg.length) console.log(`  ▽ 模板类降级（**打印但不改退出码**，值侧仍硬红）：${dg.map((s) => `${s.label}：${s.count} 处`).join('；')}`);
    if (adv.length) console.log(`  ⚠ 提示级（不改退出码）：${adv.map((s) => `${s.label}：${s.count} 处`).join('；')}`);
    if (f.allowed) console.log(`  （${allowNote(identity)}：本次放行 ${f.allowed} 处）`);
    if (!f.hardCount) console.log(`  ⇒ 本文件硬判据通过${f.softCount ? '（提示级/降级见上，人工看一眼即可）' : ''}`);
    console.log('');
  }
  console.log(report.pass
    ? `✅ 发布前安全扫描：${report.totals.files} 个文件、全部**硬**禁形状 0 处${report.totals.soft ? `（另有提示级/降级 ${report.totals.soft} 处，见上）` : ''}`
    : `❌ 发布前安全扫描：${report.totals.files} 个文件、共 ${report.totals.hard} 处命中 —— **公开前必须处理掉**`);
  console.log(`   档位：${REPO_MODE ? '全仓档（公开前门槛读数）' : '单文件/指定目标'}`
    + `｜模板类文件 ${report.totals.templateFiles} 个（降级 字段名 ${report.totals.downgraded.wording} · 量级数字 ${report.totals.downgraded.number}）`
    + `｜判据不许空过：拿 docs/HANDOFF.md 试跑必须报出命中、退出码 1；改判据跑 --selftest`);
  if (!identity.configured) console.log(`   ${identityBanner(identity)}`);
  return report.pass ? 0 : 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
module.exports = { isTemplateClass, isBareName, isPlaceholderValue, isMagnitudeNumber, buildRules, loadIdentity, identityBanner, scanText, scanFile, buildReport, runSelftest, SELF_ALLOWED_LABELS };
