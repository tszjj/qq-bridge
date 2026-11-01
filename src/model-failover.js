// 模型额度故障转移（model failover）
//
// 背景：WorkBuddy 的会话跑在账号共享的模型额度上。首选模型（deepseek-v4.1-flash）
// 用量耗尽时，每一轮都会以 429 / bizCode 6004 / category=quota 失败，QQ 侧的表现是
// 「AI 完全不回话」。2026-10-31 实测：额度耗尽后 18:49~19:12 连续 10 个回合全灭，
// 429 文案里带明确的重置时间。
//
// 数据源的变化（10-31 → 11-01 改造）：
//   · automation 时代：轮询 workbuddy.db 的 automation_runs 表找 failure_code；
//   · CLI 会话时代：会话失败直接由桥接的 runTurn 返回错误文本，所以改成**被动上报**
//     ——bridge 在回合失败时调 reportFailure()，不需要再扫库。
//
// 行为：
//   1. reportFailure() 命中 429/quota 时，沿 workbuddy.modelFailover 链降级，
//      并把结果写回 config.json（重启后仍是备用模型）。
//   2. 降级后定时器到点（额度重置时间 + 2 分钟）用「首选模型」跑一次探针；
//      探针成功即自动切回首选模型。
//   3. 探针失败则按 failoverProbeMs 间隔重试；首选模型再次耗尽会再次降级（自愈闭环）。
//
// 判定防抖：
//   · 429 带长重置窗口（>10 分钟）→ 立即降级（明显是用量耗尽）；
//   · 无重置信息 / 短窗口 → 5 分钟内同模型 ≥3 次才降级（避免瞬时限流误切）。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 跨模块共享的降级状态。降级期间桥接会暂停主动冒泡与黑话学习等非必要调用，
 * 只保留被动回复（备用模型的跨会话缓存命中率低，成本敏感）。
 */
export const failoverState = { degraded: false, model: null, preferred: null };

/** 从 429 文案里解析额度重置时间。示例：
 *  「429 您的使用量已超出频率限制，将在 2026-11-01 11:13:21 UTC+8 重置」 */
export function parseResetTimeMs(message) {
  const m = /将在\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(message ?? ''));
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0)) - 8 * 3600 * 1000;
  return Number.isFinite(ms) ? ms : null;
}

/** 判定一段错误文本是否属于「额度耗尽」。 */
export function looksLikeQuotaError(text) {
  const s = String(text ?? '');
  if (!s) return false;
  if (/\b429\b/.test(s) && /(quota|频率限制|使用量|额度|rate.?limit)/i.test(s)) return true;
  if (/bizCode["':\s]*6004/.test(s)) return true;
  if (/(category["':\s]*quota|Quota exceeded)/i.test(s)) return true;
  return false;
}

function loadState(stateFile) {
  try {
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 启动模型额度故障转移。
 *
 * @param {object} o
 * @param {object} o.cfg            桥接全局配置（读写 cfg.workbuddy.modelId）
 * @param {string} o.configPath     config.json 路径（降级结果写回这里，重启持久）
 * @param {string} o.stateFile      state/model-failover.json
 * @param {(s:string)=>void} [o.log]
 * @param {() => Promise<{ok:boolean, error?:string}>} [o.runProbe]
 *        用**首选模型**跑一次最小探针；由 bridge 注入（走同一套 CLI 会话驱动）。
 * @returns {{reportFailure:(o:{model?:string,message?:string})=>void, getCurrentModel:()=>string}|null}
 */
export function startModelFailover({ cfg, configPath, stateFile, log = () => {}, runProbe = null }) {
  const wb = cfg.workbuddy;
  if (!wb?.enabled) return null;
  const chain = Array.isArray(wb.modelFailover)
    ? wb.modelFailover.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
    : [];
  if (chain.length < 2) {
    log('模型故障转移未启用：config.json 的 workbuddy.modelFailover 少于 2 个模型');
    return null;
  }
  let preferred = chain[0];
  const probeMs = Math.max(60_000, Number(wb.failoverProbeMs) || 15 * 60_000);

  let degraded = false;
  let resetAt = null;
  let lastProbeAt = 0;
  let recentFailures = []; // { model, at, resetMs }
  let lastChainWarnAt = 0;
  let probing = false;

  // ── 状态恢复：上次降级到哪个模型，启动后立即接管 ──
  const saved = loadState(stateFile);
  // 手动选过的模型会成为新的「首选」：只认 modelId 的话，重启/探针会把用户的选择
  // 改回 chain[0]。所以状态文件里同时记 preferredModel。
  if (saved?.preferredModel && chain.includes(saved.preferredModel)) {
    preferred = saved.preferredModel;
  }
  if (saved?.currentModel && chain.includes(saved.currentModel)) {
    if (wb.modelId === saved.currentModel || wb.modelId === preferred) {
      if (wb.modelId !== saved.currentModel) wb.modelId = saved.currentModel;
      degraded = wb.modelId !== preferred;
      resetAt = Number.isFinite(saved.resetAt) ? saved.resetAt : null;
      if (degraded) {
        log(`模型故障转移：恢复降级状态，当前模型 ${wb.modelId}（首选 ${preferred}${resetAt ? `，额度 ${new Date(resetAt).toLocaleString('zh-CN', { hour12: false })} 重置` : ''}）`);
      }
    }
    // 配置里的 modelId 与状态记录不一致 => 用户手动改过，尊重用户选择
  }
  if (!chain.includes(wb.modelId)) {
    log(`模型故障转移未启用：当前模型 ${wb.modelId} 不在 workbuddy.modelFailover 链上（${chain.join(' → ')}）`);
    failoverState.degraded = false;
    failoverState.model = wb.modelId;
    failoverState.preferred = preferred;
    return { reportFailure: () => {}, setModel: () => ({ ok: false, error: '故障转移未启用' }), getStatus: () => ({ current: wb.modelId, chain, degraded: false }), getCurrentModel: () => wb.modelId };
  }
  failoverState.degraded = degraded;
  failoverState.model = wb.modelId;
  failoverState.preferred = preferred;

  function persistState() {
    failoverState.degraded = degraded;
    failoverState.model = wb.modelId;
    failoverState.preferred = preferred;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(stateFile, JSON.stringify({
        currentModel: wb.modelId,
        preferredModel: preferred,
        degraded,
        degradedAt: degraded ? (saved?.degradedAt ?? Date.now()) : null,
        resetAt,
        updatedAt: Date.now()
      }, null, 2));
    } catch (error) {
      log(`模型故障转移：状态文件写入失败（忽略）：${error?.message ?? error}`);
    }
  }

  function persistConfigModel(modelId) {
    try {
      const file = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      file.workbuddy = { ...(file.workbuddy ?? {}), modelId };
      fs.writeFileSync(configPath, JSON.stringify(file, null, 2) + '\n');
    } catch (error) {
      log(`模型故障转移：⚠️ config.json 写回失败（运行时仍生效，重启后会退回旧模型）：${error?.message ?? error}`);
    }
  }

  /**
   * 控制台手动选模型：直接把所选模型设为新的首选，并清掉降级状态。
   * 不更新 preferred 的话，下一次探针会把用户的设置改回 chain[0]。
   */
  function setModel(modelId) {
    const id = String(modelId || '').trim();
    if (!id) return { ok: false, error: '模型不能为空' };
    const inChain = chain.includes(id);
    wb.modelId = id;
    preferred = id;
    degraded = false;
    resetAt = null;
    recentFailures = [];
    persistConfigModel(id);
    persistState();
    log(`控制台：WorkBuddy 模型已设为 ${id}${inChain ? '' : '（不在故障转移链上，额度不足时不会自动切换）'}`);
    return { ok: true, model: id, preferred, degraded, inChain };
  }

  function getStatus() {
    return {
      current: wb.modelId,
      preferred,
      chain,
      degraded,
      resetAt,
      probing
    };
  }

  function degradeTo(nextModel, reason) {
    const from = wb.modelId;
    wb.modelId = nextModel;
    degraded = true;
    recentFailures = [];
    persistConfigModel(nextModel);
    persistState();
    log(`⚠️ 模型额度故障转移：${from} 额度不足（${reason}），已切换 → ${nextModel}${resetAt ? `（额度 ${new Date(resetAt).toLocaleString('zh-CN', { hour12: false })} 重置，届时自动探针切回）` : ''}`);
  }

  function recover() {
    const from = wb.modelId;
    wb.modelId = preferred;
    degraded = false;
    resetAt = null;
    recentFailures = [];
    persistConfigModel(preferred);
    persistState();
    log(`✅ 模型额度故障转移：探针成功，${from} → 切回首选模型 ${preferred}`);
  }

  /** 桥接在回合失败时调用：命中额度错误就沿链降级。 */
  function reportFailure({ model, message } = {}) {
    if (!looksLikeQuotaError(message)) return;
    const failedModel = String(model || wb.modelId || '');
    const resetMs = parseResetTimeMs(message);
    if (resetMs) resetAt = Math.max(resetAt ?? 0, resetMs);
    const now = Date.now();
    recentFailures = recentFailures.filter((x) => now - x.at <= 10 * 60_000);
    if (failedModel === wb.modelId) recentFailures.push({ model: failedModel, at: now, resetMs });

    const idx = chain.indexOf(wb.modelId);
    if (idx < 0) return; // 当前模型不在链上（用户自定义），不干预
    if (idx >= chain.length - 1) {
      if (now - lastChainWarnAt > 10 * 60_000) {
        lastChainWarnAt = now;
        log(`⚠️ 末位备用模型 ${wb.modelId} 也额度不足，链条已到尽头，保持当前模型等待额度重置`);
      }
      return;
    }
    const longReset = resetMs && resetMs - now > 10 * 60_000;
    const burst = recentFailures.filter((x) => x.model === failedModel).length;
    if (!longReset && burst < 3) return; // 短时限流：等够 3 次再切，避免误判
    degradeTo(chain[idx + 1], longReset ? `429，${new Date(resetMs).toLocaleString('zh-CN', { hour12: false })} 重置` : `5 分钟内 ${burst} 次 429`);
  }

  /** 定时检查：到了重置时间（或超过探针间隔）就用首选模型探一次。 */
  async function tick() {
    if (!degraded || probing) return;
    if (wb.modelId === preferred) { degraded = false; persistState(); return; }
    const now = Date.now();
    const dueAt = resetAt ? resetAt + 2 * 60_000 : 0;
    if (dueAt && now < dueAt) return;
    if (lastProbeAt && now - lastProbeAt < probeMs) return;
    if (!runProbe) return;
    probing = true;
    lastProbeAt = now;
    const prev = wb.modelId;
    wb.modelId = preferred; // 探针必须用首选模型
    let r = { ok: false };
    try {
      r = await runProbe();
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) };
    } finally {
      wb.modelId = prev;
    }
    probing = false;
    if (r.ok) { recover(); return; }
    const resetMs = parseResetTimeMs(r.error);
    if (resetMs) resetAt = Math.max(resetAt ?? 0, resetMs);
    persistState();
    log(`模型故障转移：首选模型探针仍失败（额度未恢复），${Math.round(probeMs / 60_000)} 分钟后重试`);
  }

  const timer = setInterval(() => { tick().catch((e) => log(`模型故障转移：探针异常（忽略）：${e?.message ?? e}`)); }, 60_000);
  timer.unref?.();
  // 启动后延迟 30s 跑第一轮：避开启动尖峰，也给桥接留出连上 SnowLuma 的时间
  const boot = setTimeout(() => { tick().catch(() => {}); }, 30_000);
  boot.unref?.();

  log(`模型额度故障转移已启动：${chain.join(' → ')}（探针间隔 ${Math.round(probeMs / 60_000)}min），当前模型 ${wb.modelId}`);
  return { reportFailure, setModel, getStatus, getCurrentModel: () => wb.modelId };
}
