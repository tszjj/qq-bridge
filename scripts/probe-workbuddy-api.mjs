// 诊断脚本：验证本机 WorkBuddy IPC 是否可用，并探测可调用的后端接口路径。
// 用法：node scripts/probe-workbuddy-api.mjs [额外路径...]
import { connectWbipc, backendFetch } from '../src/wbipc-client.js';

const conn = await connectWbipc({ clientId: 'qq-bridge-probe' });
console.log('[wbipc] 已连接，pipes =', await conn.listPipes());

const tries = [
  ['GET', '/im/api/buddy/session/acp-credential', undefined],
  ['GET', '/im/api/buddy/tasks', undefined],
  ['POST', '/im/api/buddy/tasks', {}],
  ['GET', '/console/as/conversations', undefined],
  ['GET', '/console/as/tasks', undefined],
  ['POST', '/console/as/tasks', {}],
  ...(process.argv.slice(2).map((p) => ['GET', p, undefined]))
];

for (const [m, p, body] of tries) {
  try {
    const r = await backendFetch(conn, { method: m, path: p, body });
    console.log(`OK  ${m} ${p} ->`, JSON.stringify(r).slice(0, 500));
  } catch (e) {
    console.log(`ERR ${m} ${p} ->`, e.code ?? '', e.message);
  }
}
conn.close();
process.exit(0);
