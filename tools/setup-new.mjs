#!/usr/bin/env node
// 新机器 / 交付给别人时的**配置向导**（2026-09-24，可交付部署包 Goal round 2）。
//
// 为什么需要它：只读审计（结论见 docs\部署到服务器.md 的「参数清单（换人即换）」一节）表明
// 「必改的其实只有 4 项」—— ownerQQ、私聊白名单、群白名单、snowluma.accessToken；其余
// （DSH 令牌、控制台令牌、机器人 UIN）全是自动的。但新用户不知道这 4 项在哪，也最容易踩
// 「空白名单 + allowAllWhenEmpty:false = 谁都不回」这个坑（第一次跑必然不响应）。
// 这个脚本就只问这几件事，其余原样保留模板里的值。
//
// 用法：
//   node tools\setup-new.mjs                          # 交互式，问 5 个问题
//   node tools\setup-new.mjs --owner 123 --private 123 --groups 456,789 --token xxx --console-token <48位十六进制> --yes
//   node tools\setup-new.mjs --dry-run                # 只打印会写什么，不动文件
//   node tools\setup-new.mjs --config <路径>          # 指定要写的配置文件（测试用）
// 退出码：0 成功；2 参数/配置不合法；3 写文件失败。
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = path.join(ROOT, 'qq-bridge');
const EXAMPLE = path.join(BRIDGE, 'config.example.json');
const argv = process.argv.slice(2);
const hasFlag = (n) => argv.includes('--' + n);
const opt = (n, dflt = '') => {
  const i = argv.indexOf('--' + n);
  if (i < 0) return dflt;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : 'true';
};
const say = (s = '') => console.log(s);
const bad = (s) => { console.error('✗ ' + s); process.exit(2); };

const dryRun = hasFlag('dry-run');
const assumeYes = hasFlag('yes') || hasFlag('y');
const cfgPath = opt('config') || path.join(BRIDGE, 'config.json');
const isCustomCfg = Boolean(opt('config'));

// ── 读模板 / 现有配置 ──────────────────────────────────────────────────────
if (!fs.existsSync(EXAMPLE)) bad(`找不到模板 ${EXAMPLE}`);
const template = JSON.parse(fs.readFileSync(EXAMPLE, 'utf8'));
const existed = fs.existsSync(cfgPath);
const cfg = existed ? JSON.parse(fs.readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')) : JSON.parse(JSON.stringify(template));

// ── 收集答案 ───────────────────────────────────────────────────────────────
const ask = async (rl, q, dflt) => {
  const hint = dflt ? `（默认 ${dflt}）` : '';
  const a = (await rl.question(`${q} ${hint}\n> `)).trim();
  return a || dflt;
};
const toList = (s) => String(s || '').split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);

let ownerQQ = opt('owner') || String(cfg.ownerQQ || '');
let priv = opt('private') || (Array.isArray(cfg.allow?.private) ? cfg.allow.private.join(',') : '');
let groups = opt('groups') || (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.join(',') : '');
let token = opt('token') || String(cfg.snowluma?.accessToken || '');
// 2026-09-24 主人点头："生成并打印控制台令牌这个可以"。
// 控制台令牌本来是"未配置时自动生成并持久化到 state\console-token"（也不会变），但对**新用户**来说
// 他永远不知道那串东西是什么、在哪儿。这里就把它变成向导的第 5 问：默认给一个随机值、写进 config.json
// 固定下来，并**完整打印**（连同带令牌的控制台地址），让他一开始就存进密码管理器。
const suggestedConsoleToken = randomBytes(24).toString('hex');   // 48 位十六进制，跟 state\console-token 同格式
let consoleToken = opt('console-token') || String(cfg.consoleToken || '');

if (!assumeYes && !ownerQQ) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  say('');
  say('=== DSH × QQ 机器人：配置向导 ===');
  say('只会改这几项，其它原样保留（改端口/换模型请直接编辑 config.json，见文档的参数清单）。');
  say('');
  ownerQQ = await ask(rl, '1) 你的 QQ 号（管理员，唯一）', ownerQQ);
  priv = await ask(rl, '2) 允许私聊机器人的 QQ 号（逗号分隔；留空 = 跟管理员相同）', priv);
  groups = await ask(rl, '3) 允许的群号（逗号分隔；可以留空，之后在控制台加）', groups);
  token = await ask(rl, '4) SnowLuma OneBot 的 accessToken（还没建就先回车留空，之后填）', token);
  consoleToken = await ask(rl, '5) 控制台访问令牌（回车 = 用随机生成的；写进 config.json 后固定不变，请存好）', consoleToken || suggestedConsoleToken);
  rl.close();
}
if (!priv) priv = ownerQQ; // 最常见的用法：只让自己私聊

// ── 校验（新装最容易踩的坑都在这里拦住）──────────────────────────────────
const problems = [];
const warns = [];
if (!/^[1-9]\d{4,11}$/.test(String(ownerQQ))) problems.push(`ownerQQ「${ownerQQ}」不像 QQ 号（应为 5~12 位正整数）`);
for (const g of toList(groups)) if (!/^[1-9]\d{4,11}$/.test(g)) problems.push(`群号「${g}」不像群号`);
for (const p of toList(priv)) if (!/^[1-9]\d{4,11}$/.test(p)) problems.push(`私聊号「${p}」不像 QQ 号`);
if (toList(priv).length === 0 && toList(groups).length === 0) {
  problems.push('私聊和群白名单都是空的 —— 配上 allowAllWhenEmpty=false 就是「谁都不回」（第一次跑必然不响应）');
}
if (!token) warns.push('没填 snowluma.accessToken：桥接连不上 QQ，等你在 SnowLuma 里建好 OneBot 再填进 config.json');
if (!consoleToken) consoleToken = suggestedConsoleToken;   // --yes 等非交互路径也钉一个，别留空
if (String(consoleToken).length < 16) problems.push('控制台令牌太短（至少 16 位）—— 它是打开控制台的钥匙');
if (!dryRun && !isCustomCfg && existed) warns.push('config.json 已存在 —— 只覆盖上面这几项，其它键原样保留');
if (problems.length) { problems.forEach((p) => console.error('✗ ' + p)); process.exit(2); }

// ── 写入（只动这几个键；不带 BOM，避免 JSON.parse 挑食）───────────────────
cfg.ownerQQ = Number(ownerQQ);
cfg.allow = { ...(cfg.allow || {}), private: toList(priv).map(Number), groups: toList(groups).map(Number) };
cfg.snowluma = { ...(cfg.snowluma || {}), accessToken: String(token || '') };
cfg.consoleToken = String(consoleToken);   // 固定住：桥接会优先用它（config-lib 读 file.consoleToken）
if (cfg.allow.allowAllWhenEmpty === undefined) cfg.allow.allowAllWhenEmpty = false;

say('');
say('将要写入 ' + cfgPath + (existed ? '（已存在，只改这几项）' : '（新文件，来自 config.example.json）'));
say('  ownerQQ            = ' + cfg.ownerQQ);
say('  allow.private      = [' + cfg.allow.private.join(', ') + ']');
say('  allow.groups       = [' + cfg.allow.groups.join(', ') + ']');
say('  snowluma.accessToken = ' + (cfg.snowluma.accessToken ? cfg.snowluma.accessToken.slice(0, 4) + '…（' + cfg.snowluma.accessToken.length + ' 字符）' : '（空）'));
warns.forEach((w) => say('  ⚠ ' + w));
say('');
say('  ┌─ 控制台访问令牌（请存进密码管理器）────────────────────────────');
say('  │ ' + cfg.consoleToken);
say('  │ 打开控制台时带上它（存成书签最省事）：');
say('  │   http://127.0.0.1:3100/?token=' + cfg.consoleToken);   // port-literal-ok: 向导要在 npm install 之前就能跑，config-lib 那时 import 不了（它依赖 DSH 的包）
say('  └──────────────────────────────────────────────────────────────');
if (dryRun) { say(''); say('（--dry-run：没有写文件）'); process.exit(0); }

try {
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
} catch (e) { console.error('✗ 写文件失败：' + e.message); process.exit(3); }
say('');
say('✓ 已写入。接下来（完整步骤见 qq-bridge\\docs\\DSH_SETUP.md）：');
say('  1) cd qq-bridge && npm install');
say('  2) node scripts\\setup-dsh.mjs        # 装 preset + MCP + 控制台插件 + 页面面板（面板可选，装不上只警告），然后重启 DSH');
say('  3) 起 SnowLuma，在它 WebUI 里扫码登 QQ 并开 OneBot（HTTP 3000 / WS 3001，两端 token 要一致）');   // port-literal-ok: 同上；印的是新包内置默认表的值（交付包不含 agent.config.json）
say('  4) 一键启动.cmd（家用）/ 服务器见 docs\\部署到服务器.md');
say('  5) node tools\\self-check.mjs --deep  # 验收：应 0 失败');
say('');
say('以后打开控制台就用上面那个带 token 的地址（令牌只存在你本机 config.json 里，别发给别人）。');
