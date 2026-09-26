#!/usr/bin/env node
// Red line 2 checker for .cmd / .bat files: pure ASCII + CRLF line endings, no BOM.
//   node tools\cmd-bytes.mjs <file.cmd> [--fix]
// Why: cmd.exe parses .cmd with the OEM code page, so CJK text is mangled; a .cmd that
// carries a BOM or bare-LF endings also trips editors/reviewers. Chinese wording belongs
// in a .ps1 next to it, never in the .cmd itself.
// --fix rewrites line endings only (LF -> CRLF); it never touches bytes >0x7F and never
// adds a BOM -- if either of those is wrong it reports a failure instead of "fixing" it.
import { readFileSync, writeFileSync } from 'node:fs';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('用法: node tools\\cmd-bytes.mjs <file.cmd> [--fix]');
  process.exit(2);
}
const fix = flags.includes('--fix');
const buf = readFileSync(file);

const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
const nonAscii = [];
for (let i = 0; i < buf.length; i++) {
  if (buf[i] > 0x7f) nonAscii.push({ offset: i, byte: buf[i] });
}
let bareLf = 0;
let crlf = 0;
for (let i = 0; i < buf.length; i++) {
  if (buf[i] === 0x0a) {
    if (i > 0 && buf[i - 1] === 0x0d) crlf++;
    else bareLf++;
  }
}

console.log(`文件 ${file}`);
console.log(`  ${buf.length} B ｜ BOM=${hasBom ? '有' : '无'} ｜ 非 ASCII 字节=${nonAscii.length} ｜ CRLF=${crlf} ｜ 裸 LF=${bareLf}`);

let remainingLf = bareLf;
if (fix && bareLf > 0) {
  const out = Buffer.alloc(buf.length + bareLf);
  let o = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a && (i === 0 || buf[i - 1] !== 0x0d)) out[o++] = 0x0d;
    out[o++] = buf[i];
  }
  writeFileSync(file, out.subarray(0, o));
  console.log(`  ✅ 已把 ${bareLf} 个裸 LF 换成 CRLF ⇒ ${o} B（其它字节一个没动，只插了 0x0D）`);
  remainingLf = 0;
}

const bad = hasBom || nonAscii.length > 0 || remainingLf > 0;
if (bad) {
  if (nonAscii.length) console.log(`  ❌ 有非 ASCII 字节（第一处 offset ${nonAscii[0].offset} = 0x${nonAscii[0].byte.toString(16)}）—— 中文文案请放 .ps1 里`);
  if (hasBom) console.log('  ❌ 不该有 BOM（.cmd 要纯 ASCII）');
  if (remainingLf > 0) console.log(`  ❌ 还有 ${remainingLf} 个裸 LF（加 --fix 修）`);
  console.log('  ⇒ ❌ 不过');
  process.exit(1);
}
console.log('  ⇒ ✅ 过（纯 ASCII / 无 BOM / 全 CRLF）');
