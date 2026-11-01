# 与上游的同步记录（0.2.1-r1 → 0.2.1-r2）

本仓库 fork 自 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)，但**后端已换成
WorkBuddy / CodeBuddy CLI 会话**，DSH 相关实现整体移除。因此每次同步上游都要区分两类改动：
**与后端无关的（直接吸收）** 和 **DSH 专有的（放弃）**。

最近一次同步：2026-11-01，上游 `main`（v0.2.1-r2）。

---

## 一、吸收了什么

### 安全修复（重点）

| 文件 | 变化 | 为什么重要 |
|---|---|---|
| `src/sensitive.js` | 新增 `normalizeSensitiveText` / `sensitiveTextForms` / `SENSITIVE_PATTERN` | 注入提示词前统一做敏感串归一化，避免变形绕过 |
| `src/qq-model-view.js` | 新增 `sanitizeUntrustedText` | 群里用户的文本进提示词前先清掉控制字符/伪造分隔符，防提示词注入 |
| `src/safe-fetch.js` | 边界收紧 | 出站抓取只允许白名单协议/长度/重定向次数 |
| `src/mcp-snowluma-safe.js` | 工具面收紧 | 会话令牌与准入校验更严格 |
| `src/state-acl.mjs` | 新增 `hasPermissionGrant` | 判断 state/ 是否已经收紧过权限，避免重复 icacls |
| `src/snowluma-conn.js` | 端点自愈与 token 持久化改进 | 重连不再覆盖用户手填的 wsUrl |
| `scripts/stop-bridge-instance.mjs` | 新增 | 只停止**验证过归属**的桥接实例（读锁文件里的 pid+启动时间），而不是按端口盲杀 |

### 提示词侧

- `role.injectEveryNWakes` / `role.injectDedupeWindowMs`：角色卡按节奏注入，避免每轮全量。
- `bridge.js` 里所有「把群友文本拼进提示词」的位置接入 `sanitizeUntrustedText`（话题、想法、印象）。
- `socialV2.privacy.exposeUserId`：agent 调用默认剥掉 `userId` / `isOwner`（`agentMemberView`）。

### 会话隔离

- `normalizeSlangScope` + 黑话研究按会话分批：A 群的候选不会被带进 B 群的研究上下文。
- `ignoredSender`：`ignore.sendQQ` 名单内的消息直接丢弃（不读、不记、不唤醒）。

### 工程化

- `.github/`：CI（`ci.yml`）、PR 模板、Issue 模板、`pr-base-guard.yml`。
- `SECURITY.md`、`CONTRIBUTING.md`、`NOTICE.md`、`.gitattributes`、`LICENSE` 更新。
- `_snowluma-catalog.json` 按 NOTICE 要求**不再随仓库分发**（已加入 `.gitignore`）。
- `package.json`：`@modelcontextprotocol/sdk ^1.32.2`、`zod ^4.6.7`、`engines.node >=22.13.0`。

---

## 二、没有吸收（DSH 专有）

| 上游改动 | 为什么放弃 |
|---|---|
| `src/dsh-endpoint.js` + `rediscoverDshBase()` | 桌面版 DSH 端口随机，本项目不连 DSH |
| `src/preset-sync.js`、`plugins/qq-agent-presets/*` | DSH preset 机制，`dsh/` 与本项目一起移除 |
| 普通聊天投递的「按会话 FIFO 串行化」 | 我们改成「每会话一个 CLI 子进程」，天然并行，队列已删 |
| `dsh/agent-presets/*.yml` 相关测试（`test-audit-setup*`、`test-preset-prompt`、`test-qq-preset-contract`） | 被测对象不存在，已从仓库移除 |
| `test-audit-{protocol,network,runtime,session}-boundaries`、`test-issue-followup-*`、`test-restart-instance`、`test-code-scanning-boundaries`、`test-installed-preset-sync`、`test-role-injection-cadence`、`test-delivery-regressions`、`test-dsh-inbox-projection` | 上游新增的 DSH 专用测试，本仓库没有对应实现 |

---

## 三、合并方式（下次照做）

`bridge.js` 是唯一「双方都改过」的大文件。用三方合并，而不是手工对比：

```bash
# base = 上次同步时的上游快照，ours = 我们的分支，theirs = 上游最新
git merge-file -p --diff3 src/bridge.js <base>/src/bridge.js <upstream>/src/bridge.js > merged.js
```

冲突取舍原则：

1. **架构按我们**：投递、队列、会话创建这些分支不引入 DSH 版本；
2. **安全按上游**：`sanitizeUntrustedText`、隐私分级、准入校验、实例归属，一律吸收；
3. 上游新增但依赖 `dsh/`、`plugins/`、`preset-sync` 的，直接丢，并把对应的 import 一起删掉
   （否则 `node --check` 过、启动时才崩）。

合并后必做：

```bash
node --check src/bridge.js
node scripts/check-env.mjs
node scripts/test-audit.mjs      # 见下节「已知红测」
```

---

## 四、已知红测（4 个，均与 DSH 语义相关）

`node scripts/test-audit.mjs` 当前 **22/26 通过**。剩下 4 个不是回归，是"被测对象不在本分支"：

| 测试 | 失败点 | 说明 |
|---|---|---|
| `test-voice.mjs` / `test-voice-system.mjs` | 读 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 断言工具默认值 | 语音模块本身的断言都通过；失败的是「DSH preset 里 sendVoice 默认值」这一段 |
| `test-audit-regressions.mjs` | R22（挂起提问归属）、R23/R24（表情备注按会话隔离） | R22 需要 harness 导出更多内部映射；R23/R24 断言上游新增的 scope 隔离，本分支的表情写入路径尚未接 scope |
| `test-audit-security-mcp.mjs` | 4/10 用例 | 用例读 `src/mcp-web-search-safe.js`（DSH 时代的 web 搜索 MCP，已被 `safe-fetch.js` 取代并清理），文件不存在即 ENOENT |

> 这些用例保留在仓库里是为了**透明**：看一眼就知道哪些能力在本分支不存在。
> 如果你在后续开发中补上了 scope 隔离（R23/R24），把对应用例改成绿即可。

---

## 五、版本标记

- 上游：`v0.2.1-r2`
- 本仓库：`0.2.1-r2+wb.1`（`+wb.N` 表示基于该上游版本的第 N 次 WorkBuddy 化改造）
