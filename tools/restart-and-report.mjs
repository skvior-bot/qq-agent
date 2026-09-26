#!/usr/bin/env node
// 重启 DSH 并自检：给「脱离进程树」的独立进程用（我自己的进程会在 DSH 重启时一起死，
// 所以这个脚本必须由外部进程拉起，见 docs/启动与踩坑.md）。
// 全过程写入 backups/reports/restart-report-<时间戳>.log（以前写在 docs\ 下，把文档目录当产出目录用了），
// 任何一步失败都能从报告里看出来。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// 端口单一来源（P2⑦）：默认值只在 qq-bridge\src\config-lib.js 定义一次；
// 报告里那句"如果 <端口> 没起来"以前写死 3080，改端口后就会写成错的那个。
import { resolvePorts } from '../qq-bridge/src/config-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTS = resolvePorts();
// --delay <秒>：先等一会儿再动手。DSH 一被重启，发起这个脚本的会话就没了，
// 所以要留出时间让"我马上要重启了"这条消息送到界面上。
const delayArg = process.argv.indexOf('--delay');
const delaySec = delayArg >= 0 ? Number(process.argv[delayArg + 1] || 0) : 0;
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const report = path.join(ROOT, 'backups', 'reports', `restart-report-${stamp}.log`);
fs.mkdirSync(path.dirname(report), { recursive: true });
const w = (line) => {
  const text = typeof line === 'string' ? line : '';
  fs.appendFileSync(report, `${text}\n`, 'utf8');
  process.stdout.write(`${text}\n`);
};

w(`=== DSH 重启 + 自检报告 ${new Date().toLocaleString()}（pid ${process.pid}）===`);
w(`报告文件：${report}`);
if (delaySec > 0) {
  w(`等待 ${delaySec} 秒后开始重启（给界面留时间把消息显示出来）…`);
  await new Promise((r) => setTimeout(r, delaySec * 1000));
  w('开始。');
}

// 1) 走正规启动器（它自己会：停旧 DSH → 起新 DSH → 抓令牌写桥接配置 → 起/重启另两个服务 → 自检端口 → 开页面）
w('\n===== [1/2] 启动器 tools\\start-all.ps1 =====');
// PS 5.1 在 stdout 被重定向时按 **OEM 代码页（936/GBK）** 输出，Node 按 UTF-8 解码就是乱码，
// 而且是**不可恢复**的：GBK 字节被解成 U+FFFD 之后信息就没了——docs\restart-report-2026-09-22T16-18-02.log
// 里 401 处 � 就是这么来的（注意 GBK 的「一」= D2 BB 恰好是合法 UTF-8，所以"是不是合法 UTF-8"这种检查会误判通过）。
// 光设 [Console]::OutputEncoding 不够（管不住重定向流），必须先把子进程的代码页也换成 65001。
const psScript = `chcp 65001 > $null; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; & '${path.join(ROOT, 'tools', 'start-all.ps1')}'`;
const launch = spawnSync('powershell.exe',
  ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
  { encoding: 'utf8', timeout: 300_000, windowsHide: true });
w(launch.stdout ?? '');
if (launch.stderr) w(`[stderr] ${launch.stderr}`);
w(`启动器退出码 = ${launch.status}${launch.error ? ` / ${launch.error.message}` : ''}`);

// 2) 重启后自检（--deep 会真建一个 qq-chat-v2 会话问一句，确认 preset 与指令注入都活着）
w('\n===== [2/2] 自检 tools\\self-check.mjs --deep =====');
const check = spawnSync(process.execPath,
  [path.join(ROOT, 'tools', 'self-check.mjs'), '--deep'],
  { encoding: 'utf8', timeout: 300_000, windowsHide: true });
w(check.stdout ?? '');
if (check.stderr) w(`[stderr] ${check.stderr}`);
w(`自检退出码 = ${check.status}`);

w(`\n=== 结论：${check.status === 0 ? '全部通过 ✅' : '有失败项 ❌，看上面 ❌ 行'} ===`);
w(`如果 ${PORTS.dshWeb} 没起来：手动双击 D:\\hobby\\DSH\\一键启动.cmd`);
