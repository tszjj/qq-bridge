#!/usr/bin/env node
// 环境自检：把「跑不起来时该看哪里」一次性列清楚。
// 用法：node scripts/check-env.mjs
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { discoverCli } from '../src/wb-session-cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = [];
const add = (ok, name, detail, hint = '') => rows.push({ ok, name, detail, hint });

// 1) Node 版本
const major = Number(process.versions.node.split('.')[0]);
add(major >= 20, 'Node.js', `${process.version}（${process.execPath}）`,
  major >= 20 ? '' : '需要 Node 20+：装 WorkBuddy 桌面端或从 nodejs.org 安装');

// 2) 项目文件
const needFiles = ['src/bridge.js', 'src/mcp-snowluma-safe.js', 'public/console.html', 'config.example.json'];
for (const f of needFiles) add(fs.existsSync(path.join(ROOT, f)), `文件 ${f}`, fs.existsSync(path.join(ROOT, f)) ? '存在' : '缺失', '仓库不完整，重新 clone');

// 3) config.json
const cfgPath = path.join(ROOT, 'config.json');
let cfg = null;
if (fs.existsSync(cfgPath)) {
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (e) { cfg = null; add(false, 'config.json', 'JSON 解析失败：' + e.message, '检查逗号/括号'); }
  if (cfg) add(true, 'config.json', '已就绪');
} else {
  add(false, 'config.json', '不存在', '复制一份：copy config.example.json config.json');
}

// 4) CLI 入口
const cli = discoverCli();
add(!!(cli.cliEntry && fs.existsSync(cli.cliEntry)), 'CodeBuddy CLI', cli.cliEntry ? `${cli.cliEntry}（${cli.version}）` : '未找到',
  '装 WorkBuddy 桌面端，或 npm i -g @tencent-ai/codebuddy-code 后先跑一次 codebuddy 登录');

// 5) 配置里的关键字段
if (cfg) {
  const allow = cfg.allow || {};
  const n = (allow.private?.length || 0) + (allow.groups?.length || 0);
  add(n > 0, '白名单', n ? `私聊 ${allow.private?.length || 0} 个 / 群 ${allow.groups?.length || 0} 个` : '为空（不会响应任何消息）',
    '在 config.json 的 allow.private / allow.groups 里填 QQ 号');
  add(cfg.ownerQQ ? true : false, 'ownerQQ', cfg.ownerQQ ? String(cfg.ownerQQ) : '未设置', '填你自己的 QQ，用于管理员私聊');
  const wb = cfg.workbuddy || {};
  add(wb.enabled !== false, 'WorkBuddy 后端', wb.enabled !== false ? `启用，模型 ${wb.modelId || '(未设)'}` : '未启用（会走已退役的 DSH）',
    'config.json 里 workbuddy.enabled 设为 true');
}

// 6) SnowLuma 可达性
async function probeHttp() {
  const url = String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
  const token = cfg?.snowluma?.accessToken || '';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${url}/get_status`, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctrl.signal });
    clearTimeout(t);
    const body = await res.text();
    const ok = res.ok && /"status"\s*:\s*"ok"/.test(body);
    add(ok, 'SnowLuma OneBot', `${url} → HTTP ${res.status}`, ok ? '' : 'token 不对或 SnowLuma 未登录 QQ');
  } catch (e) {
    add(false, 'SnowLuma OneBot', `${url} → ${e?.name === 'AbortError' ? '超时' : (e?.message || e)}`, '先启动 SnowLuma 并扫码登录 QQ');
  }
}

// 7) 控制台端口占用
function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

await probeHttp();
const port = Number(cfg?.consolePort) || 3100;
const free = await portFree(port);
add(!free ? true : true, `控制台端口 ${port}`, free ? '未占用（可直接启动）' : '已被占用（可能已有实例在跑）',
  free ? '' : `netstat -ano | findstr :${port} 找到 PID 后结束，或改 consolePort`);

// 输出
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
console.log('\n环境自检 —— ' + ROOT + '\n');
for (const r of rows) {
  console.log(` ${r.ok ? '✅' : '❌'} ${pad(r.name, 18)} ${r.detail}`);
  if (!r.ok && r.hint) console.log(`    → ${r.hint}`);
}
const bad = rows.filter((r) => !r.ok).length;
console.log(`\n${bad === 0 ? '全部通过，可以执行 start.bat' : `有 ${bad} 项需要注意（见上面的 → 提示）`}\n`);
process.exit(0);
