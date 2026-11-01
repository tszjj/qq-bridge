// WorkBuddy / CodeBuddy 官方 CLI 会话驱动（替代旧的 automation 推送通道）
//
// 为什么换掉 automation：
//   1. automation 每次 run 都新建 session（实测 171/171 个 conversationId 全唯一），
//      上下文与缓存都无法延续；
//   2. automation 走的是「直写 WorkBuddy 私有 SQLite 表」这条非公开通道，属于对宿主
//      的侵入性操作，升级即断且无版本协商；
//   3. automation 是全局单 worker 串行，导致桥接必须自建三套队列 + 95 秒僵尸租约 +
//      单轮预算来给「串行」打补丁。
//
// CLI 会话模型（官方能力，见 2026-11-01-03-10-29/会话接口调用说明.md）：
//   · `codebuddy -p "<prompt>" --output-format stream-json --resume <session_id>`
//     一问一答即退出，上下文靠 session_id 持久化（transcript 落 ~/.codebuddy/projects/）；
//   · 复用桌面端登录态（system/init 事件里的 apiKeySource=copilot.tencent.com），
//     不需要单独申请 API Key；
//   · 每个 QQ 会话固定一个 sessionId + 独立 cwd，天然支持多群/私聊并行（各自一个进程）。
//
// 两条必须遵守的工程约束（否则会话会串味/抢端口）：
//   ① 子进程环境必须**白名单重建**：桌面端会把当前会话的 SERVER__PORT / CODEBUDDY_SESSION_ID /
//      CODEBUDDY_MCP_CONFIG 注入环境，直接继承会让子进程复用父会话端口与身份
//      （表现为 EADDRINUSE，或串用父会话的 MCP 与鉴权）。这是进程隔离，不是绕过权限。
//   ② cwd 必须每会话固定：--resume 时 cwd 与首次不一致会让文件类工具的相对路径错位。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { findTranscriptPath } from './wb-transcript.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
// --permission-mode 取值（官方开关）：
//   acceptEdits  自动批准工作目录内的文件写入/编辑（推荐默认，不涉及提权）
//   default      逐次询问（-p 模式下无人可问，会卡住）
//   bypassPermissions / -y  全放行（HIGH/CRITICAL 仍询问）——不使用
const DEFAULT_PERMISSION_MODE = 'acceptEdits';

/** key → 文件系统安全名（群/私聊 key 里有冒号，不能直接当目录名）。 */
export function sessionFileKey(key) {
  return String(key).replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'default';
}

/** 白名单重建子进程环境：只保留运行必需项，剔除桌面端会话注入的端口/会话 ID/MCP/代理。 */
export function cleanChildEnv(nodeBin) {
  const keep = [
    'USERPROFILE', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP',
    'SystemRoot', 'SystemDrive', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'USERNAME', 'USERDOMAIN'
  ];
  const env = { PATH: `${path.dirname(nodeBin)};C:\\Windows\\system32;C:\\Windows` };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/**
 * 探测 CodeBuddy CLI 入口。按可靠性从高到低尝试：
 *
 *   1. 环境变量 `QQBOT_CODEBUDDY_CLI`（指向 `bin/codebuddy` 这个 JS 入口）+ 可选 `QQBOT_NODE_BIN`
 *      —— 换机器/多版本共存时最稳，CI 里也好用；
 *   2. WorkBuddy 桌面端内置 Node：`~/.workbuddy/binaries/node/versions/<ver>/`，取版本号最大的一个
 *      —— 装了 WorkBuddy 就一定命中，且和桌面端同一套登录态；
 *   3. npm 全局安装的 `@tencent-ai/codebuddy-code`（`npm i -g @tencent-ai/codebuddy-code`）
 *      —— 没装 WorkBuddy 桌面端、只用 CLI 的人走这条。
 *
 * 三条都失败时返回带 `missing: true` 的对象，由调用方给出可读的报错（而不是 spawn 时报 ENOENT）。
 */
export function discoverCli() {
  const home = process.env.USERPROFILE || process.env.HOME || os.homedir();
  const isWin = process.platform === 'win32';
  const nodeName = isWin ? 'node.exe' : 'node';
  const cliRel = path.join('node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy');

  // 1) 显式指定
  const envCli = process.env.QQBOT_CODEBUDDY_CLI;
  if (envCli && fs.existsSync(envCli)) {
    const nodeBin = process.env.QQBOT_NODE_BIN || process.execPath;
    return { nodeBin, cliEntry: envCli, version: 'env' };
  }

  // 2) WorkBuddy 内置
  const versionsDir = path.join(home, '.workbuddy', 'binaries', 'node', 'versions');
  const candidates = [];
  try {
    for (const name of fs.readdirSync(versionsDir)) {
      const nodeBin = path.join(versionsDir, name, nodeName);
      const cliEntry = path.join(versionsDir, name, cliRel);
      if (fs.existsSync(nodeBin) && fs.existsSync(cliEntry)) {
        // 版本号排序：22.22.2-6 之类，按数字段比较
        const score = name.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
        candidates.push({ name, nodeBin, cliEntry, score });
      }
    }
  } catch { /* 目录不存在时继续下一条 */ }
  candidates.sort((a, b) => {
    for (let i = 0; i < Math.max(a.score.length, b.score.length); i++) {
      const d = (b.score[i] ?? 0) - (a.score[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });
  if (candidates[0]) {
    const b = candidates[0];
    return { nodeBin: b.nodeBin, cliEntry: b.cliEntry, version: b.name };
  }

  // 3) npm 全局（Windows 的 npm 全局根通常是 %APPDATA%\npm 或 Node 安装目录）
  const npmRoots = [
    process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'nodejs'),
    '/usr/local/lib',
    '/usr/lib'
  ].filter(Boolean);
  for (const root of npmRoots) {
    const cliEntry = path.join(root, cliRel);
    if (fs.existsSync(cliEntry)) {
      const nodeBin = process.env.QQBOT_NODE_BIN || process.execPath;
      return { nodeBin, cliEntry, version: `npm:${root}` };
    }
  }

  return { nodeBin: null, cliEntry: null, version: '(not found)', missing: true };
}

/**
 * 创建会话驱动器。
 *
 * @param {object} o
 * @param {object} o.cfg       桥接配置的 workbuddy 段（读取 modelId / reasoningEffort / cli.timeoutMs 等）
 * @param {string} o.stateDir  桥接 state 目录
 * @param {(s:string)=>void} [o.log]
 * @param {string} [o.bridgeRoot]  qq-bridge 根目录（用于定位 mcp-snowluma-safe.js）
 */
export function createWbSessionCli({ cfg = {}, stateDir, log = () => {}, bridgeRoot }) {
  const root = path.join(stateDir, 'wb-sessions');
  fs.mkdirSync(root, { recursive: true });

  const cli = discoverCli();
  const nodeBin = cfg.cli?.nodeBin || cli.nodeBin;
  const cliEntry = cfg.cli?.cliEntry || cli.cliEntry;
  const timeoutMs = Math.max(30_000, Number(cfg.cli?.timeoutMs) || Number(cfg.turnTimeoutMs) || DEFAULT_TIMEOUT_MS);
  const permissionMode = cfg.cli?.permissionMode || DEFAULT_PERMISSION_MODE;
  // 延迟加载工具链：ToolSearch 找工具 + DeferExecuteTool 执行，两个都必须放行。
  const allowedTools = typeof cfg.cli?.allowedTools === 'string' && cfg.cli.allowedTools.trim()
    ? cfg.cli.allowedTools.trim()
    : 'ToolSearch DeferExecuteTool';
  const mcpToolScript = path.join(bridgeRoot || path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..'), 'src', 'mcp-snowluma-safe.js');

  // CLI 找不到时不在这里抛异常：桥接还要继续跑（SnowLuma、控制台都正常），
  // 只是每条消息会拿到一条明确的报错，管理员据此去装环境。
  const cliMissing = !nodeBin || !cliEntry || !fs.existsSync(nodeBin) || !fs.existsSync(cliEntry);
  const CLI_MISSING_HINT = '未找到 CodeBuddy CLI。三种装法任选其一：'
    + '① 装 WorkBuddy 桌面端（自带 ~/.workbuddy/binaries 下的 Node 与 CLI）；'
    + '② npm i -g @tencent-ai/codebuddy-code 后把 npm 全局根加进环境；'
    + '③ 在 config.json 的 workbuddy.cli 里写死 nodeBin 与 cliEntry，'
    + '或设环境变量 QQBOT_CODECBUDDY_CLI=<...>/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy。'
    + '安装后需先执行一次 codebuddy 完成登录。';

  // ── MCP 配置：用 --mcp-config 传独立文件，不动用户全局 ~/.codebuddy/.mcp.json ──
  // 这是官方参数（--mcp-config <fileOrString>），比改用户全局配置侵入性更低。
  const mcpConfigFile = path.join(root, 'mcp-config.json');
  const mcpConfig = {
    mcpServers: {
      snowluma: {
        type: 'stdio',
        command: nodeBin,
        args: [mcpToolScript],
        env: {}
      }
    }
  };
  try {
    fs.writeFileSync(mcpConfigFile, JSON.stringify(mcpConfig, null, 2) + '\n', 'utf8');
  } catch (error) {
    log(`[wb-cli] MCP 配置写入失败（会话将拿不到 qq_* 工具）：${error?.message ?? error}`);
  }

  const sessionsFile = path.join(root, 'sessions.json');
  // 逐轮流水（控制台「对话过程」的统计来源）。transcript 里有完整原文，但没有
  // 「这一轮谁赢谁输、耗时多少」这种结论文；这里只追加一行结论，读的时候 tail 即可。
  const turnLogFile = path.join(root, 'turns.jsonl');
  let sessions = {};
  try {
    sessions = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')) || {};
  } catch { sessions = {}; }

  function saveSessions() {
    try { fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2) + '\n', 'utf8'); } catch {}
  }

  /** 每会话的会话档案 + 独立工作目录。 */
  function sessionFor(key) {
    const fk = sessionFileKey(key);
    const cwd = path.join(root, fk);
    fs.mkdirSync(cwd, { recursive: true });
    const cur = sessions[key] ?? { key, sessionId: null, turns: 0, cwd, createdAt: Date.now(), lastAt: 0, lastOkAt: 0 };
    cur.cwd = cwd;
    sessions[key] = cur;
    return cur;
  }

  /** 同一 key 的连续调用串行化（不同 key 各自独立，天然并行）。 */
  const chains = new Map();
  function withKeyLock(key, fn) {
    const prev = chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // 链尾不保留结果，避免内存增长；失败也不能污染下一条
    chains.set(key, next.catch(() => {}));
    return next;
  }

  /**
   * 跑一轮会话。
   *
   * @param {object} o
   * @param {string} o.key        QQ 会话 key（group:xxx / private:xxx / internal:slang）
   * @param {string} o.prompt     本轮提示词
   * @param {string} [o.model]    模型 ID（缺省用 cfg.modelId；故障转移改的就是它）
   * @param {string} [o.effort]   思考强度
   * @param {number} [o.timeoutMs]
   * @param {boolean} [o.reset]   强制新建会话（会话失效时用一次）
   * @returns {Promise<{ok:boolean, text:string, sessionId:string|null, startedAt:number, durationMs:number,
   *   usage:object|null, toolCalls:Array<{name:string,target:string}>, error:string|null, isNewSession:boolean}>}
   */
  function runTurn(o) {
    return withKeyLock(o.key, () => runTurnInner(o));
  }

  async function runTurnInner({ key, prompt, model, effort, timeoutMs: tmo, reset = false }) {
    // 环境没装好时立刻返回可读错误，而不是 spawn 一个不存在的路径等 30 秒超时。
    if (cliMissing) {
      return { ok: false, key, text: '', toolCalls: 0, durationMs: 0, error: CLI_MISSING_HINT, missingCli: true };
    }
    const s = sessionFor(key);
    if (reset) {
      s.sessionId = null;
      s.turns = 0;
    }
    const isNewSession = !s.sessionId;
    const startedAt = Date.now();

    const args = [
      '-p', String(prompt ?? ''),
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', permissionMode,
      '--mcp-config', mcpConfigFile
    ];
    // 工具白名单（官方 --allowedTools <tools...>，可变参数）：
    // qq_* 工具是延迟加载的，调用链固定为 ToolSearch → DeferExecuteTool。非交互模式下
    // 没有人能点「允许」，不放行这两个工具会被直接拒绝
    // （实测报错：Permission to use DeferExecuteTool has been denied ... non-interactive mode）。
    // 注意必须拆成多个独立参数：把 "ToolSearch DeferExecuteTool" 作为单个字符串传，
    // commander 会当成一个工具名而匹配不上（实测无效）。
    // 放在最后追加：变参会把后面的 token 都当工具名吃掉。
    if (allowedTools) args.push('--allowedTools', ...allowedTools.split(/[,\s]+/).filter(Boolean));
    if (s.sessionId) args.push('--resume', s.sessionId);
    const useModel = model || cfg.modelId || null;
    if (useModel) args.push('--model', useModel);
    const useEffort = effort || cfg.reasoningEffort || 'low';
    if (useEffort) args.push('--effort', useEffort);

    let child;
    try {
      child = spawn(nodeBin, [cliEntry, ...args], {
        cwd: s.cwd,
        env: cleanChildEnv(nodeBin),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      return { ok: false, text: '', sessionId: s.sessionId, startedAt, durationMs: 0, usage: null, toolCalls: [], error: `spawn 失败：${error?.message ?? error}`, isNewSession };
    }

    const texts = [];
    const toolCalls = [];
    let thinkingBlocks = 0;
    let initEvent = null;
    let resultEvent = null;
    let stderrBuf = '';

    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const t = line.trim();
      if (!t) return;
      let evt;
      try { evt = JSON.parse(t); } catch { return; }
      if (evt.type === 'system' && evt.subtype === 'init') { initEvent = evt; return; }
      if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
        for (const b of evt.message.content) {
          if (b.type === 'thinking' || b.type === 'redacted_thinking') thinkingBlocks++;
          else if (b.type === 'text' && b.text) texts.push(b.text);
          else if (b.type === 'tool_use') {
            const target = String(b.input?.file_path || b.input?.path || b.input?.command || b.input?.key || b.input?.text || '').slice(0, 120);
            toolCalls.push({ name: b.name, target });
          }
        }
        return;
      }
      if (evt.type === 'result') resultEvent = evt;
    });
    child.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 16000) stderrBuf = stderrBuf.slice(-16000);
    });

    const timeout = setTimeout(() => { try { child.kill(); } catch {} }, Math.max(30_000, Number(tmo) || timeoutMs));
    const exitCode = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
      child.on('error', (err) => { stderrBuf += `\n[spawn error] ${err.message}`; resolve(-2); });
    });
    clearTimeout(timeout);

    const finalSessionId = resultEvent?.session_id || initEvent?.session_id || s.sessionId || null;
    const text = String(resultEvent?.result ?? texts.join('\n') ?? '').trim();
    const ok = exitCode === 0 && resultEvent && resultEvent.is_error !== true;

    // 会话失效（transcript 被 cleanup 掉 / session 过期）：清掉 id，下一轮自动新建
    const errText = ok ? '' : String(resultEvent?.result || stderrBuf.slice(-4000) || `exit=${exitCode}`);
    const sessionGone = !ok && /session not found|no conversation|session .*not exist|invalid session/i.test(errText);
    if (sessionGone) {
      log(`[wb-cli] ${key} 的会话 ${s.sessionId} 已失效，下一轮将新建`);
      s.sessionId = null;
      s.turns = 0;
    } else if (finalSessionId) {
      s.sessionId = finalSessionId;
      s.turns = (s.turns || 0) + 1;
    }
    s.lastAt = Date.now();
    if (ok) s.lastOkAt = s.lastAt;
    saveSessions();
    // 追加逐轮结论。写失败绝不能影响回合结果（控制台是旁路，不是主链路）。
    try {
      fs.appendFileSync(turnLogFile, `${JSON.stringify({
        ts: s.lastAt,
        key,
        ok,
        durationMs: Date.now() - startedAt,
        toolCalls: toolCalls.length,
        model: initEvent?.model ?? useModel ?? null,
        sessionId: s.sessionId,
        isNewSession
      })}\n`, 'utf8');
    } catch { /* ignore */ }

    if (!ok) {
      log(`[wb-cli] ${key} 本轮失败（exit=${exitCode}${sessionGone ? '，会话失效' : ''}）：${errText.split('\n')[0].slice(0, 200)}`);
    }

    return {
      ok,
      text,
      sessionId: s.sessionId,
      startedAt,
      durationMs: resultEvent?.duration_ms ?? (Date.now() - startedAt),
      usage: resultEvent?.usage ?? null,
      toolCalls,
      thinkingBlocks,
      error: ok ? null : errText.slice(0, 2000),
      isNewSession,
      model: initEvent?.model ?? useModel,
      apiKeySource: initEvent?.apiKeySource ?? null
    };
  }

  /** 会话自检：CLI 入口是否可执行（不做真实调用，避免启动即烧额度）。 */
  function selfCheck() {
    const okNode = !!nodeBin && fs.existsSync(nodeBin);
    const okCli = !!cliEntry && fs.existsSync(cliEntry);
    const okMcp = fs.existsSync(mcpToolScript);
    return {
      ok: okNode && okCli && okMcp,
      nodeBin, cliEntry, mcpToolScript, version: cli.version,
      sessionCount: Object.keys(sessions).length,
      hint: cliMissing ? CLI_MISSING_HINT : ''
    };
  }

  function resetSession(key) {
    if (sessions[key]) {
      sessions[key].sessionId = null;
      sessions[key].turns = 0;
      saveSessions();
    }
  }

  function listSessions() {
    return Object.values(sessions).map((s) => ({
      key: s.key,
      sessionId: s.sessionId,
      turns: s.turns,
      createdAt: s.createdAt ?? null,
      lastAt: s.lastAt ?? null,
      lastOkAt: s.lastOkAt ?? null,
      cwd: s.cwd ?? null,
      hasTranscript: !!findTranscriptPath(s.sessionId)
    }));
  }

  /** 最近 N 条逐轮结论（新的在后）。只读文件尾部，避免历史无限增长拖慢控制台。 */
  function recentTurns({ limit = 500, since = 0 } = {}) {
    let raw = '';
    try { raw = fs.readFileSync(turnLogFile, 'utf8'); } catch { return []; }
    const lines = raw.split('\n').filter(Boolean).slice(-Math.max(1, Math.min(5000, Number(limit) || 500)));
    const out = [];
    for (const line of lines) {
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      if (!j || typeof j !== 'object') continue;
      if (since && Number(j.ts) < since) continue;
      out.push(j);
    }
    return out;
  }

  return {
    runTurn, selfCheck, listSessions, resetSession, sessionFor, recentTurns,
    transcriptPath: (key) => findTranscriptPath(sessions[key]?.sessionId),
    paths: { root, nodeBin, cliEntry, mcpConfigFile, sessionsFile, turnLogFile }
  };
}
