#!/usr/bin/env node
// preset 校验工具：改完 agent preset 后用它验收（不用重启、不动 QQ）。
//   node tools/check-presets.mjs              # 列出 DSH 认到的 preset + 校验本地 YAML
//   node tools/check-presets.mjs mount qq-chat-v2   # 试挂载（建会话→归档），证明 preset 能被组装
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
// 端口单一来源（P2⑦）：默认值只在 qq-bridge\src\config-lib.js 定义一次，
// 这里以前抄了一份 `?? 'http://127.0.0.1:3080'` 兜底（配置读不到就悄悄探 3080）。
import { resolvePorts, loopbackHttp } from '../qq-bridge/src/config-lib.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CONFIG = path.join(ROOT, 'qq-bridge', 'config.json');
const require = createRequire(path.join(ROOT, 'qq-bridge', 'package.json'));
const { NodeApiClient, unwrap, discoverDshLaunchToken, createTurnCollector } = await import(
  new URL('../qq-bridge/src/dsh-client.js', import.meta.url).href
);

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
const cfg = readJson(CONFIG);
// 生效端口（URL 是权威值，端口从它投影回来）；配置读不了时 resolvePorts 会退回环境层并**出声**。
const PORTS = resolvePorts();

// 1) 本地 YAML 自检：源 + 已安装副本（副本是 DSH 真正加载的那份）
const yaml = require('js-yaml');
let bad = 0;
for (const [label, dir] of [
  ['源    ', path.join(ROOT, 'qq-bridge', 'dsh', 'agent-presets')],
  ['已安装', path.join(HOME, '.agent-presets')],
]) {
  for (const name of ['qq-chat-v2']) {
    const file = path.join(dir, name, 'agent.cordis.yml');
    if (!fs.existsSync(file)) { console.log(`${label} ${name}: (不存在) ${file}`); continue; }
    try {
      const doc = yaml.load(fs.readFileSync(file, 'utf8'));
      const ids = Array.isArray(doc) ? doc.map((r) => r?.id).filter(Boolean) : [];
      console.log(`${label} ${name}: YAML OK，${ids.length} 行 → ${ids.join(', ')}`);
    } catch (e) {
      bad++;
      console.log(`${label} ${name}: ❌ YAML 解析失败 ${e.message}`);
    }
  }
}

// 2) DSH 名单（会实际读盘，能看到被替代的代际与健康问题）
const api = new NodeApiClient(cfg.dsh?.baseUrl ?? loopbackHttp(PORTS.dshWeb), undefined, {
  token: cfg.dsh?.authToken || discoverDshLaunchToken(),
  header: cfg.dsh?.authHeader,
  prefix: cfg.dsh?.authPrefix,
});

async function main() {
  const list = unwrap(await api.agentPresets.list({}), 'agentPresets/list');
  const items = Array.isArray(list) ? list : (list?.presets ?? list?.items ?? []);
  console.log(`\nDSH 名单里的 preset（${items.length} 个）:`);
  for (const p of items) {
    const id = p.id ?? p.presetId ?? p.name;
    const extra = JSON.stringify({ ...p, id: undefined, presetId: undefined, name: undefined, description: undefined })
      .replace(/"(undefined|null)",?/g, '').replace(/,}/g, '}');
    console.log(`  - ${id}${extra && extra !== '{}' ? `  ${extra.slice(0, 300)}` : ''}`);
  }

  if (process.argv[2] === 'mount' || process.argv[2] === 'probe') {
    const preset = process.argv[3] || 'qq-chat-v2';
    const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(ROOT, 'qq-bridge', 'state', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    const ws = unwrap(await api.workspace.create({ path: dir }), 'workspace/create');
    const made = unwrap(await api.sessions.create({ workspaceId: ws.workspace.workspaceId, agentPreset: preset }), 'session/create');
    console.log(`\n✅ 已建会话 ${made.sessionId}（preset=${preset}）→ 说明该 preset 能被组装`);
    try {
      if (process.argv[2] === 'probe') {
        const text = process.argv[4] || '只回答两个字：收到';
        const collector = createTurnCollector();
        let opened;
        const ready = new Promise((res) => { opened = res; });
        const stream = api.events.mux({}, undefined, () => opened());
        const done = new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('等待回复超时（120s）')), 120_000);
          (async () => {
            for await (const env of stream) {
              const f = env.payload;
              if (f.type === 'session/event' && f.sessionId === made.sessionId) {
                const ended = collector.push(f.event);
                if (ended) { clearTimeout(timer); resolve(ended); return; }
              }
              if (f.type === 'stream/error') { clearTimeout(timer); reject(new Error(JSON.stringify(f.error))); return; }
            }
          })().catch((e) => { clearTimeout(timer); reject(e); });
        });
        await ready;
        stream.follow(made.sessionId);
        unwrap(await api.sessions.prompt({ sessionId: made.sessionId, mode: 'queue', content: [{ type: 'text', text }] }), 'session/prompt');
        const ended = await done;
        console.log(`🤖（${preset}）回合结束 reason=${ended.reason?.kind}\n${ended.text || '（无文本）'}`);
      }
    } finally {
      await api.workspace.archiveSession({ sessionId: made.sessionId });
      console.log('🧹 测试会话已归档');
    }
  }
  process.exitCode = bad ? 1 : 0;
}

await main();
