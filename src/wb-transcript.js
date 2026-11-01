// CLI 会话 transcript 解析器（控制台「对话过程」的数据源）。
//
// 为什么需要它：`codebuddy -p` 只把会话写进
//   ~/.codebuddy/projects/<编码后的 cwd>/<sessionId>.jsonl
// 不登记到 WorkBuddy 的 sessions 表，所以桌面端侧边栏看不到这些对话。
// 控制台要展示「发起（提示词）→ 思考 → 工具调用 → 回复」，只能直接读这份 transcript。
//
// 设计原则：
//   · 只读、只解析，不做任何业务判断；
//   · 单块文本一律截断，避免 3~4 万字的首轮提示词把页面和 IPC 撑爆；
//   · **令牌类内容必须脱敏**：唤醒提示词与 qq_* 工具参数里都带 agentToken，
//     它是会话级凭据，控制台只用于排障，没有展示原文的必要。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PROJECTS_DIR = path.join(os.homedir(), '.codebuddy', 'projects');
const DEFAULT_MAX_TURNS = 8;
const MAX_BLOCK = 12000;   // 单块文本（提示词 / 回复 / 思考）
const MAX_RESULT = 4000;   // 工具返回
const MAX_EVENTS = 600;    // 单轮事件上限（防御性）

/** 找 sessionId 对应的 transcript。sessionId 全局唯一，不必猜目录编码规则。 */
export function findTranscriptPath(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,}$/.test(sid)) return null;
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS_DIR); } catch { return null; }
  for (const dir of dirs) {
    const file = path.join(PROJECTS_DIR, dir, `${sid}.jsonl`);
    try { if (fs.statSync(file).isFile()) return file; } catch { /* 下一个 */ }
  }
  return null;
}

/** 凭据脱敏：token 字段、会话令牌行、超长十六进制串。 */
export function redactSecrets(input) {
  let s = String(input ?? '');
  // {"token":"…"} / "token": "…"
  s = s.replace(/("token"\s*:\s*")([^"]{6,})(")/gi, '$1***$3');
  s = s.replace(/("token"\s*:\s*')([^']{6,})(')/gi, "$1***$3");
  // 唤醒提示词里的【会话令牌】xxxx
  s = s.replace(/(【会话令牌】\s*)([0-9a-fA-F]{8,})/g, '$1***');
  // 裸的 48+ 位十六进制（agentToken / accessToken 常见形态）
  s = s.replace(/\b[0-9a-fA-F]{48,}\b/g, '***');
  return s;
}

function blockText(value, max = MAX_BLOCK) {
  let text = '';
  if (typeof value === 'string') text = value;
  else if (Array.isArray(value)) {
    text = value.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p === 'object') return String(p.text ?? p.content ?? '');
      return '';
    }).filter(Boolean).join('\n');
  } else if (value && typeof value === 'object') {
    text = String(value.text ?? value.content ?? '');
  }
  const original = text.length;
  if (text.length > max) text = `${text.slice(0, max)}\n…（已截断，原文 ${original} 字）`;
  return { text, chars: original, truncated: original > max };
}

function parseArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return { _raw: String(raw) }; }
}

function shortName(name, args) {
  const n = String(name || '');
  if (n === 'DeferExecuteTool' && args && typeof args.toolName === 'string') {
    return String(args.toolName).replace(/^mcp__snowluma__/, '');
  }
  return n;
}

/**
 * 读取并归一化 transcript。
 *
 * @param {string} sessionId
 * @param {{maxTurns?: number}} [opts]
 * @returns {{exists:boolean, sessionId:string, path:string|null, totalTurns:number,
 *            turns:Array, updatedAt:number|null}}
 */
export function readTranscript(sessionId, { maxTurns = DEFAULT_MAX_TURNS } = {}) {
  const sid = String(sessionId || '').trim();
  const file = findTranscriptPath(sid);
  if (!file) return { exists: false, sessionId: sid, path: null, totalTurns: 0, turns: [], updatedAt: null };

  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) {
    return { exists: false, sessionId: sid, path: file, error: String(error?.message ?? error), totalTurns: 0, turns: [], updatedAt: null };
  }
  const lines = raw.split('\n').filter((l) => l.trim());

  const turns = [];
  let cur = null;
  const byCallId = new Map();

  for (const line of lines) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object') continue;

    // 一条 user message = 一次唤醒 / 发起。
    if (j.type === 'message' && j.role === 'user') {
      const prompt = blockText(j.content);
      cur = {
        index: turns.length,
        startedAt: Number(j.timestamp) || null,
        endedAt: Number(j.timestamp) || null,
        prompt: {
          text: redactSecrets(prompt.text),
          chars: prompt.chars,
          truncated: prompt.truncated,
          // 首轮 = 完整角色卡 + 工具协议；之后是增量唤醒。判断依据是提示词里有没有角色卡段。
          bootstrap: /【角色卡|【当前角色】/.test(prompt.text)
        },
        model: null,
        events: [],
        reply: '',
        toolCount: 0
      };
      turns.push(cur);
      continue;
    }
    if (!cur) continue;
    if (cur.events.length >= MAX_EVENTS) continue;

    const ts = Number(j.timestamp) || null;
    if (ts) cur.endedAt = Math.max(cur.endedAt || 0, ts);
    if (!cur.model && j.providerData?.requestModelId) cur.model = j.providerData.requestModelId;

    if (j.type === 'reasoning') {
      const t = blockText(j.rawContent && Array.isArray(j.rawContent) && j.rawContent.length ? j.rawContent : j.content);
      if (t.text.trim()) cur.events.push({ kind: 'thinking', ts, text: redactSecrets(t.text), chars: t.chars });
      continue;
    }

    if (j.type === 'function_call') {
      const args = parseArgs(j.arguments);
      const ev = {
        kind: 'tool',
        ts,
        name: String(j.name || 'tool'),
        label: shortName(j.name, args),
        args: redactSecrets(typeof args === 'string' ? args : JSON.stringify(args, null, 1)),
        result: '',
        resultChars: 0,
        status: 'running',
        callId: j.callId || null,
        // 模型在调用工具前的那句「为什么」，比参数更能说明它在想什么。
        why: j.providerData?.reasoning ? redactSecrets(String(j.providerData.reasoning)).slice(0, 400) : ''
      };
      cur.events.push(ev);
      cur.toolCount += 1;
      if (ev.callId) byCallId.set(ev.callId, ev);
      continue;
    }

    if (j.type === 'function_call_result') {
      const out = j.output?.text ?? j.output ?? '';
      const text = blockText(out, MAX_RESULT);
      const ev = j.callId ? byCallId.get(j.callId) : null;
      if (ev) {
        ev.result = redactSecrets(text.text);
        ev.resultChars = text.chars;
        ev.status = j.status || 'completed';
      } else {
        cur.events.push({
          kind: 'tool',
          ts,
          name: String(j.name || 'tool'),
          label: shortName(j.name, {}),
          args: '',
          result: redactSecrets(text.text),
          resultChars: text.chars,
          status: j.status || 'completed',
          callId: j.callId || null,
          why: ''
        });
        cur.toolCount += 1;
      }
      continue;
    }

    if (j.type === 'message' && j.role === 'assistant') {
      const t = blockText(j.content);
      if (t.text.trim()) {
        cur.events.push({ kind: 'text', ts, text: redactSecrets(t.text), chars: t.chars });
        cur.reply = cur.reply ? `${cur.reply}\n\n${redactSecrets(t.text)}` : redactSecrets(t.text);
      }
    }
  }

  for (const t of turns) {
    t.durationMs = t.startedAt && t.endedAt ? Math.max(0, t.endedAt - t.startedAt) : null;
    t.reply = t.reply.length > MAX_BLOCK ? `${t.reply.slice(0, MAX_BLOCK)}\n…（已截断）` : t.reply;
  }

  const keep = Math.max(1, Number(maxTurns) || DEFAULT_MAX_TURNS);
  const sliced = turns.slice(-keep).map((t, i) => ({ ...t, index: turns.length - Math.min(keep, turns.length) + i }));

  let updatedAt = null;
  try { updatedAt = fs.statSync(file).mtimeMs; } catch { /* ignore */ }

  return {
    exists: true,
    sessionId: sid,
    path: file,
    totalTurns: turns.length,
    turns: sliced,
    updatedAt
  };
}
