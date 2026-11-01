// 冒烟测试：直接驱动 wb-session-cli 跑一轮，验证
//   ① 白名单环境下 CLI 能复用桌面端登录态
//   ② --mcp-config 能把 snowluma 工具挂进会话
//   ③ 会话 ID 能落地、可续接
import path from 'node:path';
import { createWbSessionCli } from '../src/wb-session-cli.js';

const root = path.resolve('.');
const cli = createWbSessionCli({
  cfg: { modelId: 'deepseek-v4.1-flash', reasoningEffort: 'low' },
  stateDir: path.join(root, 'state'),
  bridgeRoot: root,
  log: (...a) => console.log('[log]', ...a)
});

const chk = cli.selfCheck();
console.log('selfCheck:', JSON.stringify(chk, null, 2));
if (!chk.ok) process.exit(2);

console.log('\n--- 第 1 轮 ---');
const r1 = await cli.runTurn({
  key: 'internal:selftest',
  prompt: '只回复四个字：连接正常。不要调用任何工具，不要写文件。',
  timeoutMs: 180_000
});
console.log(JSON.stringify({
  ok: r1.ok, text: r1.text, sessionId: r1.sessionId, error: r1.error,
  model: r1.model, apiKeySource: r1.apiKeySource, durationMs: r1.durationMs,
  toolCalls: r1.toolCalls
}, null, 2));

if (!r1.ok) process.exit(1);

console.log('\n--- 第 2 轮（同会话续接，验证上下文）---');
const r2 = await cli.runTurn({
  key: 'internal:selftest',
  prompt: '刚才让你回复的四个字是什么？原样复述，不要调用任何工具。',
  timeoutMs: 180_000
});
console.log(JSON.stringify({
  ok: r2.ok, text: r2.text, sessionId: r2.sessionId, sameSession: r2.sessionId === r1.sessionId,
  durationMs: r2.durationMs, error: r2.error
}, null, 2));

console.log('\n会话档案:', JSON.stringify(cli.listSessions(), null, 2));
process.exit(0);
