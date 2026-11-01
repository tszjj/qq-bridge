// 清理脚本：把 DSH 时代 / 无产出的资产备份到 _backup/ 后从仓库移除。
// 用法：node scripts/cleanup-dsh-assets.mjs [--apply]
//   不带 --apply 只打印清单（dry-run）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const WORKSPACE = path.resolve(ROOT, '..');
const BACKUP = path.join(WORKSPACE, '_backup', '2026-11-01-cleanup');
const apply = process.argv.includes('--apply');

// 相对 qq-bridge/ 或根的路径（以 ../ 开头表示工作区根）
const targets = [
  // ── DSH 专用目录 / bundle ──
  'dsh',
  'plugins/qq-agent-presets',
  'plugins/qq-mode-console',
  '../qq-agent-presets',
  '../qq-mode-console',
  // ── 孤儿模块 / 必然失败的脚本 ──
  'src/core',
  'src/self-test.js',
  // ── 当前运行路径上没有产出的模块 ──
  'src/wbipc-client.js',
  'src/mcp-host-server.js',
  'src/mcp-web-search-safe.js',
  'src/web-search.js',
  // ── automation 时代产物（CLI 会话改造后已无引用）──
  'src/workbuddy-backend.js',
  'src/workbuddy-push.js',
  // ── 一次性改造脚本 ──
  'scripts/refactor-slot-block.mjs',
  'scripts/refactor-deliver-block.mjs'
];

// DSH 专用脚本（setup / probe / test / verify）
const scriptsDir = path.join(ROOT, 'scripts');
const dshScriptPatterns = [
  /^setup-dsh\.mjs$/,
  /^dsh-modules\.mjs$/,
  /^dsh-tool-names\.mjs$/,
  /^scan-dsh-tool-names\.mjs$/,
  /^probe-(?!workbuddy|snowluma)(.*)\.mjs$/,
  /^test-dsh-.*\.mjs$/,
  /^test-setup-dsh-.*\.mjs$/,
  /^test-audit-protocol.*\.mjs$/,
  /^verify-dsh-.*\.mjs$/,
  /^verify-agent-presets-.*\.mjs$/,
  /^verify-persona-config\.mjs$/,
  /^test-mcp-host\.mjs$/,
  /^test-mcp-servers-stdio\.mjs$/,
  /^test-workbuddy-push\.mjs$/,
  /^smoke-workbuddy-wake\.mjs$/,
  /^build-agent-preset-patches\.mjs$/
];
try {
  for (const name of fs.readdirSync(scriptsDir)) {
    if (dshScriptPatterns.some((re) => re.test(name))) targets.push(path.join('scripts', name));
  }
} catch { /* scripts 目录不存在则跳过 */ }

const existing = [];
const missing = [];
for (const rel of targets) {
  const abs = path.resolve(ROOT, rel);
  if (fs.existsSync(abs)) existing.push({ rel, abs });
  else missing.push(rel);
}

function sizeOf(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return st.size;
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    total += e.isDirectory() ? sizeOf(path.join(p, e.name)) : fs.statSync(path.join(p, e.name)).size;
  }
  return total;
}

console.log(`待处理 ${existing.length} 项（不存在 ${missing.length} 项）`);
let bytes = 0;
for (const { rel, abs } of existing) {
  const size = sizeOf(abs);
  bytes += size;
  console.log(`  ${(size / 1024).toFixed(0).padStart(7)} KB  ${rel}`);
}
console.log(`合计 ${(bytes / 1024 / 1024).toFixed(2)} MB`);

if (!apply) {
  console.log('\n(dry-run：加 --apply 才会真正备份并删除)');
  process.exit(0);
}

// 备份：保持相对路径结构
fs.mkdirSync(BACKUP, { recursive: true });
for (const { rel, abs } of existing) {
  const dest = path.join(BACKUP, rel.replace(/^\.\.\//, 'workspace-root/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(abs, dest, { recursive: true, force: true });
  console.log(`  备份 → ${path.relative(WORKSPACE, dest)}`);
}

// 删除
for (const { rel, abs } of existing) {
  fs.rmSync(abs, { recursive: true, force: true });
  console.log(`  已移除 ${rel}`);
}

// 清理空目录（plugins / src/core 等）
for (const dir of [path.join(ROOT, 'plugins'), path.join(ROOT, 'src', 'core'), path.join(WORKSPACE, 'qq-agent-presets'), path.join(WORKSPACE, 'qq-mode-console')]) {
  try {
    if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch {}
}

fs.writeFileSync(path.join(BACKUP, 'MANIFEST.txt'),
  [`清理时间：${new Date().toISOString()}`, `备份：${BACKUP}`, '', '移除项：', ...existing.map((x) => `  ${x.rel}`)].join('\n') + '\n', 'utf8');
console.log(`\n完成。备份在 ${BACKUP}`);
