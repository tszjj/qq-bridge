// 临时：直连 mcp-snowluma-safe.js 的 stdio MCP 客户端
// 用法：node mcp-call.mjs '<json>'   json = {tool, args}
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'src', 'mcp-snowluma-safe.js');
// 用「当前正在跑这个脚本的 node」而不是写死的绝对路径，
// 这样换机器 / 换 WorkBuddy 版本都不用改文件。
const NODE = process.env.QQBOT_NODE_BIN || process.execPath;

const req = JSON.parse(process.argv[2] || '{}');

const child = spawn(NODE, [SERVER], { cwd: __dirname, stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {}
  }
});
child.stderr.on('data', (d) => process.stderr.write(d));

function send(method, params) {
  const id = nextId++;
  const p = new Promise((res) => pending.set(id, res));
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return p;
}

const init = await send('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'wb-direct-call', version: '1.0' }
});
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

if (req.listTools) {
  const r = await send('tools/list', {});
  for (const t of r.result.tools) console.log(t.name);
} else if (req.tool) {
  const r = await send('tools/call', { name: req.tool, arguments: req.args || {} });
  console.log(JSON.stringify(r.result ?? r.error, null, 1));
} else {
  console.log(JSON.stringify(init.result?.serverInfo ?? init, null, 1));
}
child.kill();
process.exit(0);
