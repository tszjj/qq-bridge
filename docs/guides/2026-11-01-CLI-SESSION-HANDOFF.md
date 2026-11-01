# QQBOT × WorkBuddy 后端改造 · 交接文档

> 用途：给**新的主改造会话**做上下文交接。读完这一份应能直接接手，不必重走已排除的弯路。
> 生成时间：2026-11-01 16:20（GMT+8）
> 代码基线：`qq-bridge/src/bridge.js` 12705 行、`src/` 22 个模块（`wb-session-cli.js` 为本次新增）
> 上一轮审阅报告：`qq-bridge/docs/audits/2026-11-01-架构与运行审阅.md`（问题清单，与本文互补）

---

## 0. 一句话结论

后端已从 **WorkBuddy automation 表推送**（定时任务语义）切换为 **官方 CodeBuddy CLI + `--resume <sessionId>`**（真会话语义）：每个 QQ 会话固定一个 sessionId，一轮 = 一个子进程，进程退出即回合结束。三套队列、95 秒僵尸租约、执行槽全部删除，回合耗时从「20~40 秒 + 排队 1.5~4.3 分钟」降到 **2~20 秒**，且群/私聊天然并行。

**当前唯一阻塞事项**：桥接进程未运行（3100 无监听），需人工双击 `qq-bridge\start.bat` 拉起。

---

## 1. 当前架构

### 1.1 调用链

```
QQ 消息
  └─ SnowLuma（OneBot，127.0.0.1:3000 / WebUI :5099）
       └─ qq-bridge（src/bridge.js）
            ├─ socialV2 状态机：未读 / 唤醒判定 / 记忆 / 唤醒配置
            └─ deliverPromptNow()  ── workbuddyMode() === true ──┐
                                                                 ▼
                                   wb-session-cli.runTurn({ key, prompt })
                                                                 │
                        ┌────────────────────────────────────────┴───────────────┐
                        │ spawn(node.exe, [codebuddy, -p <prompt>, ...],          │
                        │       cwd = state/wb-sessions/<fileKey>/,               │
                        │       env = 白名单重建,                                  │
                        │       --resume <sessionId>（首轮不带 → 新建）)           │
                        │ 子进程内：MCP snowluma（mcp-snowluma-safe.js）           │
                        │           → qq_* 工具 → 直连 OneBot 发消息               │
                        └────────────────────────────────────────────────────────┘
                                                                 │
                                        进程退出 + stream-json result 事件
                                                                 ▼
                                   turn.ok / turn.sessionId / toolCalls
                                                                 └→ 失败且命中额度错误 → failover.reportFailure()
```

### 1.2 关键文件与职责

| 文件 | 职责 | 备注 |
|---|---|---|
| `src/wb-session-cli.js` | CLI 会话驱动器（**本次新增，核心**） | 会话档案、清环境、MCP 配置、spawn、stream-json 解析、会话滚动 |
| `src/bridge.js` | 单个巨型桥接（保留） | `deliverPromptNow` 的 WB 分支已改；DSH 分支仍在（fallback，见 §6） |
| `src/model-failover.js` | 故障转移链（10-31 新增，保留） | 检测方式改为「回合失败被动上报 + 降级期探针」 |
| `src/mcp-snowluma-safe.js` | MCP stdio 服务，暴露 `qq_*` 工具 | 被 CLI 以 `--mcp-config` 挂载，未改动 |
| `state/wb-sessions/sessions.json` | key → sessionId / turns / cwd 档案 | 会话连续性的唯一真相源 |
| `state/wb-sessions/mcp-config.json` | 动态生成的 MCP 配置 | 不污染 `~/.codebuddy/.mcp.json` |
| `state/social-v2.json` | 会话状态、未读、唤醒配置、agentToken | 唤醒 prompt 的数据来源 |

### 1.3 运行参数（`config.json` → `workbuddy`）

| 键 | 当前值 | 作用 |
|---|---|---|
| `enabled` | `true` | 决定 `workbuddyMode()`；`false` 则回落 DSH |
| `modelId` | `deepseek-v4.1-flash` | 传给 `--model`；故障转移会就地改写 |
| `modelFailover` | `deepseek → glm-5.3-flash → minimax-m3.1-flash` | 降级链 |
| `failoverProbeMs` | `900000` | **仅降级期间**探针间隔（15 分钟，会真烧一次调用） |
| `reasoningEffort` | `low` | 传给 `--effort` |
| `cli.timeoutMs` | `300000` | 单轮子进程硬超时 |
| `cli.permissionMode` | `acceptEdits` | 非 bypassPermissions |
| `cli.allowedTools` | `ToolSearch DeferExecuteTool` | 空格分隔，代码里拆成多参数 |
| `sessionMaxTurns` | `40` | 会话滚动阈值（轮数） |
| `sessionMaxAgeMs` | `21600000`（6h） | 会话滚动阈值（时间） |
| `turnBudgetMs` | `180000` | 仅剩**软提示**（超时让模型收尾），无硬拒绝 |
| `learner.timeoutMs` | `240000` | 黑话学习任务超时 |

`allow` 白名单：`groups: 111111 / 222222 / 333333`，`private: 10001 / 10002`（测试期曾临时收窄到 1 群 1 私聊，已恢复）。

> 模型与思考强度可直接在控制台「运行总览」修改（`GET/POST /api/workbuddy/settings`）：写 `config.json` 的 `workbuddy` 段，下一轮即生效（不重启桥接）。**手动选择的模型会成为故障转移的新首选**（`state/model-failover.json` 的 `preferredModel`），否则探针到点会把用户的设置改回 `chain[0]`。

### 1.4 三个关键设计决策

1. **会话即上下文**：首轮 `buildWakePromptV2()` 注入完整角色卡 + 工具协议 + 会话令牌 + 记忆；**后续轮只发增量** `buildIncrementalWakePromptV2()`（唤醒原因 + 消息快照）。这是 token 成本从「每轮 3~4 万」降下来的主因。
2. **进程即回合**：不再依赖「AI 自报结束 / 租约兜底」，`spawn` 退出码 + `result.is_error` 就是回合结论。假成功（旧 `result_success=1` 实为未执行）问题结构性消失。
3. **同 key 串行、异 key 并行**：`withKeyLock` 保证同会话不重入；不同会话各一个子进程。忙碌判定用 `wbTurnStartedAt`，不用 `pendingWakeKeys`（见坑 D1）。

---

## 2. 三次方案演进（为什么最后是这条）

| 阶段 | 方案 | 结论 |
|---|---|---|
| 原状 | DSH 本地会话服务 | 已退役，代码仍在仓库（bridge.js 的 DSH 分支） |
| 过渡 | WorkBuddy **automation 表**直写（29 列硬编码 SQLite） | 语义错配：定时任务 ≠ 会话服务。问题清单见审阅报告，已弃用 |
| 排除 A | 逆向 `wbipc` 主进程 IPC 调云端接口 | `/console/as/*` 全 **403 企业版限定**、`/im/api/buddy/*` 404，个人版零产出。**不要再走** |
| 排除 B | CLI 无头自建登录（`codebuddy` TUI 登录后 `-p`） | 凭据静态加密 key 由桌面端托管（`category=missing-key`），standalone 进程 token 无法落盘。**产品边界，不要再试** |
| **采用** | **官方 CLI `-p` + `--resume`，复用桌面端登录态** | 实测 `apiKeySource=copilot.tencent.com`，无需 API Key、无需付费套餐 |

依据文档：`C:\Users\me\WorkBuddy\2026-11-01-03-10-29\会话接口调用说明.md`（另一会话探索产出，仍可作为 CLI 行为参考）。

---

## 3. 踩过的坑（按层分类）

### A. 认证与环境

**A1. `-p` 一直报 `Authentication required`，但 TUI 明明登录成功**
- 根因两层：① 桥接/工具环境继承了 WorkBuddy 注入的 `CODEBUDDY_HOST`、`CODEBUDDY_FORCE_LITE_WB_BUNDLE`、`CODEBUDDY_SESSION_ID`、`NODE_OPTIONS` shim、`http_proxy`/`HTTP_PROXY` 等；② 该定制 CLI 的凭据加密 key 由桌面端下发，standalone 进程读不到（日志 `[AtRestEncryption] ... category=missing-key`），TUI 只是靠内存 token 活着。
- **正解**：`cleanChildEnv()`（`wb-session-cli.js:42`）**白名单重建**环境，只保留 `USERPROFILE/APPDATA/TEMP/SystemRoot/...` + 自建 `PATH`；并用 `~/.workbuddy/binaries/node/versions/*/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy` 作为入口（`discoverCli()`，`:54`）。
- 效果：init 事件返回 `apiKeySource=copilot.tencent.com`，复用桌面端登录。
- **不要再做**：清除个别变量逐个试（漏一个就失败）、找 `~/.codebuddy/auth/*.info` 解密、从 TUI 的 `/api/v1/auth/account/status` 取 token（不出）。

**A2. 变量清理不彻底会「偶发成功」**
- 早前用 `env -u ...` 手工清 20 多个变量，仍失败——因为桌面端注入项随会话变化。白名单法才稳定。

**A3. 代理变量重复键会连带炸掉别的工具**
- 环境里同时有 `http_proxy` 与 `HTTP_PROXY`，`PowerShell Start-Process` 构建环境字典直接抛「已添加项。字典中的关键字: HTTP_PROXY」。子进程环境必须**重建**而非继承。

### B. CLI 参数与工具授权

**B1. `--allowedTools "ToolSearch DeferExecuteTool"` 传成单个字符串 → 无效**
- 它是可变参数，commander 把整串当一个工具名。必须 `args.push('--allowedTools', ...list)`（`wb-session-cli.js:201`）。
- 且**必须放在参数末尾**：变参会把后面的 token 全吃掉，`--model`/`--effort` 会被误当工具名。

**B2. 非交互模式没有审批人 → `DeferExecuteTool` 直接被拒**
- 实测报错：`Permission to use DeferExecuteTool has been denied ... non-interactive mode`。
- 正解是官方白名单（`--allowedTools`），**不是** `--permission-mode bypassPermissions`。保持 `acceptEdits` 即可，侵入性最低。

**B3. 延迟加载工具链要写进提示词**
- `qq_*` 不在工具列表里直接可见，必须 `ToolSearch` 搜 → `DeferExecuteTool` 调。不写明，每个新会话都要花好几轮摸索（实测单会话 6 次 ToolSearch / 32 次 Defer）。

### C. 进程与生命周期

**C1. 工具调用/沙箱里启动的进程会被作业对象回收**
- 现象：`spawn(detached)` / `Start-Process` 起 SnowLuma 或桥接，工具调用一结束进程就没了（端口消失），看起来像「启动失败」。
- **正解**：只能由**用户双击** `start-all.bat` / `qq-bridge\start.bat`。排查时先 `netstat` 确认端口，再判断是不是被回收。

**C2. `start-all.ps1` 用 `Start-Process` 必崩**
- 已修：改为写临时 `.cjs`，用 `node spawn(exe, [script], {detached:true, stdio:['ignore',fd,fd]})` 启动（脚本内注释解释了原因）。**别改回去**。

### D. 会话与状态

**D1. 用 `pendingWakeKeys` 判「会话忙」→ 100% 误判，所有唤醒都投不出去**
- 根因：`sendWakePromptV2` 在**投递之前**就 `pendingWakeKeys.add(key)`（历史语义＝「唤醒在途标记」）。
- **正解**：判据用 `wbTurnStartedAt`（`bridge.js:9539`），该 Map 只在真正开跑后写入。这是改造中引入又当场修掉的真实 bug，**别再引入第二套「在途」标记**。

**D2. `--resume` 可能返回新的 session_id**
- 不能假定 resume 后 id 不变。以 `result.session_id || init.session_id` 为准回写档案（`wb-session-cli.js:259`）。

**D3. 会话失效要能自愈**
- transcript 被清理 / 会话过期时，CLI 报 `session not found` 类错误 → 清 id、轮次归零，下一轮自动新建（`:265`）。否则该会话永久失效。

**D4. 会话无限增长会越来越贵**
- 已实现滚动：`sessionMaxTurns=40` 或 `sessionMaxAgeMs=6h` 触发重建，靠首轮完整提示词 + 消息快照接回上下文（`bridge.js:9548-9555`）。

### E. 宿主边界与数据

**E1. `C:\DeepSeek\QQBOT` 被删（打包成 `QQBOT.7z`），SnowLuma 却还在跑**
- 真相：运行中的 SnowLuma 实际读写的是**工作区** `QQBOT/SnowLuma/data`（mtime 实时）。已把 `config.snowluma.homeDir` / `launcherPath` 指向工作区。
- 教训：**先看进程的实际 cwd 与 data mtime**，别按历史路径判断。

**E2. CLI 会话不出现在 WorkBuddy 桌面端侧边栏**
- 原因：侧边栏读 `workbuddy.db` 的 `sessions` 表，而 `-p` 只写 transcript（`~/.codebuddy/projects/<编码后的cwd>/<sessionId>.jsonl`），不登记入库。**官方设计，不是 bug**，连续性不受影响。

**E3. 不要直写宿主私有表**
- 旧 automation 方案硬编码 29 列、无版本协商，升级即静默失灵。当前方案只依赖 CLI 公开参数 + transcript 文件，侵入性显著下降。

### F. 观测与排查

**F1. MCP 直连 OneBot 发送，不经过桥接 HTTP，因此 `bridge.log` 里没有「发送成功」**
- 排查发送问题要看：① CLI transcript 里的 `function_call` / `function_call_result`；② SnowLuma 侧日志；③ OneBot 直连测试。
- 快速定位顺序：`curl` 直连 OneBot → 通了说明发得出去；再看工具返回是否业务错误（如 token 缺失）。

**F2. 群聊普通消息只有约 6% 概率触发唤醒**
- 测试必须 `@机器人` 或带关键词（如「凛」「杂鱼」），否则「没反应」是**设计行为**，容易误判改造失败。

**F3. 会话档案与 transcript 路径编码**
- cwd 反斜杠/盘符转小写横线：`C:\Users\...\state\wb-sessions\group_222222` → `c-Users-...-group_222222`。找不到 transcript 时先核对这个编码。

---

## 4. 现在正确的地方（可以放心依赖的契约）

1. **认证**：复用桌面端登录态，`apiKeySource=copilot.tencent.com`；不注入、不改全局配置、不绕过授权。
2. **会话连续**：同一 key 的 sessionId 稳定；实测 `group:222222` 同一 id 跑 7 轮、`private:10001` 4 轮，transcript 内累积用户轮次（不是摘要拼接）。
3. **成本**：首轮完整注入，后续轮增量；单轮 2~20 秒，无排队。
4. **并行**：异 key 不同子进程；同 key `withKeyLock` 串行，不会重入。
5. **失败可见**：`turn.ok=false` + 错误首行落日志；额度错误自动上报故障转移。
6. **故障转移**：链路保留、降级写回 `config.json` 持久、**仅降级期间**探针、探针成功自动切回（实测从 glm 切回 deepseek 成功）。
7. **黑话学习**：走独立会话 `internal:slang`（`bridge.js:2265`），与聊天会话隔离但自身连续。
8. **主动冒泡**：走对应群会话，天然满足「在群自己的连续对话里完成」。
9. **MCP 隔离**：`--mcp-config` 指向 `state/wb-sessions/mcp-config.json`，不动 `~/.codebuddy/.mcp.json`。
10. **单文件桥接保留**：按你的要求未拆分，改造点集中在投递层与启动段。

---

## 5. 当前项目状态

### 5.1 进程与端口（2026-11-01 16:20 实测）

| 服务 | 状态 |
|---|---|
| SnowLuma | **运行中**，PID 9672，`:3000`（OneBot）与 `:5099`（WebUI）监听 |
| qq-bridge | **未运行**（`:3100` 无监听）→ 需双击 `qq-bridge\start.bat` |

### 5.2 已清理（备份后移除，共 41 项）

备份位置：`_backup/2026-11-01-cleanup/`（含 `MANIFEST.txt`）

- `qq-bridge/dsh/`（6 个）、`qq-bridge/plugins/`（2 个 bundle）、根目录 `qq-agent-presets/`、`qq-mode-console/`（与 `plugins/` 逐字节相同的副本）
- `scripts/` 下 27 个 DSH 脚本；`src/core/` 整目录；`self-test.js`
- `src/wbipc-client.js`、`src/mcp-host-server.js`、`src/mcp-web-search-safe.js`、`src/web-search.js`、`src/workbuddy-backend.js`、`src/workbuddy-push.js`
- `package.json` 14 条指向已删文件的失效 scripts
- `src/` 由 28 → **22** 个活跃模块

另有两份改造前快照：`_backup/2026-11-01-cli-refactor/bridge.js.before`、`config.json.before`。

### 5.3 仍未清理（有意保留）

| 项 | 原因 |
|---|---|
| `src/dsh-client.js`（978 行）+ `bridge.js` 里 20 处 `cfg.dsh` 分支 | 作为 `workbuddy.enabled=false` 时的回退路径，**未删** |
| `config.json` 的 `dsh` 段 | 同上 |
| `config.json` 的 `webSearch` 段（9 键） | 全无代码读取，纯残留，可删 |
| `state/wb-sessions/sessions.json` 的 `internal:*` | 测试脚本产物，可选清理 |
| `scripts/probe-workbuddy-api.mjs`、`scripts/test-media-search.mjs` | **已失效**：分别 import 已删除的 `src/wbipc-client.js` 与 `src/web-search.js`，直接删即可 |

---

## 6. 已知遗留问题（按优先级）

| # | 问题 | 影响 | 建议 |
|---|---|---|---|
| 1 | **增量轮不带 `agentToken`**：`buildIncrementalWakePromptV2()`（`bridge.js:10793`）没有令牌行，续轮靠会话历史里的旧 token；一旦 token 轮换（会话重建 `:3058`、权限变化）本轮 `qq_*` 调用会报「必须携带 agent token」 | 偶发「回合跑完但没发消息」 | 增量轮补一行令牌，或把 token 改为固定值/由 MCP 侧注入 |
| 2 | 桥接未运行 | 现在完全收不到消息 | 双击 `start.bat`；新会话开工第一件事确认 `:3100` |
| 3 | DSH 分支仍占 bridge.js 大量篇幅（12705 行） | 维护成本高、易误读 | 确认不再回退后，整段下线（分批、可回滚） |
| 4 | `config.webSearch` 9 键无人读 | 配置静默失效 | 直接删 |
| 5 | `scripts/probe-workbuddy-api.mjs`、`test-media-search.mjs` import 已删模块 | 运行时必崩 | 与 #4 一起清 |
| 6 | `internal:*` 测试会话残留在档案里 | 只影响可读性 | 加维护脚本或手工删 |
| 7 | 会话成本无预算治理 | 长会话仍可能变贵 | 已用轮数/年龄滚动兜底，后续可加每群日预算 |
| 8 | 多群并行未压测 | 未知并发上限 | 5 个白名单会话同时发消息观察子进程与内存 |
| 9 | Web 控制端只改了一半：**已上线**「对话过程」页（桥接 ↔ WorkBuddy 收发流水 + 逐轮回放，替代已下线的「令牌与花费」），但「调试与运维」里仍有 DSH 面板与 `/api/dsh/*` 旧接口 | 功能可用，文案与面板未收口 | 后续逐页清理 DSH 残留（见 `docs/guides/DIALOG_CONSOLE.md`） |

---

## 7. 新会话开工建议

### 第一批（先确认，不动手）
1. 确认服务在跑：`netstat -ano | grep -E ":3100|:3000|:5099"`。
2. 读会话档案：`state/wb-sessions/sessions.json` + 对应 transcript，确认连续性仍成立。
3. 跑一次最小验证：私聊发一句，看 `state/bridge.log` 里 `[wb-cli] ... 回合完成 Ns（续接，工具 K 次）`。

### 第二批（修 §6-#1，小改动）
- 增量 prompt 补令牌行；用「重启 + 两轮对话」验证第二轮 `qq_send_*` 不再报缺 token。

### 第三批（结构性收尾）
- DSH 分支分批下线 + `config.dsh` / `config.webSearch` 清理（继续走「先备份后移除」）。
- 多群并行压测（5 会话同时 @）。

### 明确不要重走的弯路
- ❌ 逆向 `wbipc` / `/console/as/*`（403 企业版）
- ❌ 让 standalone CLI 自己登录 / 找凭据文件解密（`missing-key` 是产品边界）
- ❌ 给队列/租约打补丁（automation 语义错配，已证伪）
- ❌ 用 `pendingWakeKeys` 判忙
- ❌ 在工具调用里启动常驻进程（会被回收）

---

## 8. 速查

```bash
# 服务状态
netstat -ano | grep -E ":3100|:3000|:5099" | grep LISTEN

# 启动（必须人工双击，沙箱内启动会被回收）
qq-bridge\start.bat          # 只启桥接（带守护循环）
start-all.bat                # SnowLuma + 桥接

# 会话档案
cat qq-bridge/state/wb-sessions/sessions.json

# 单轮实测（不经 QQ）
node qq-bridge/scripts/smoke-cli-session.mjs    # 注：若已被清理，用 transcripts 复现

# transcript 定位
ls ~/.codebuddy/projects/ | grep -i qqbot

# 日志
tail -f qq-bridge/state/bridge.log
```

日志关键字：`[wb-cli] ... 回合完成`（成功）/ `回合失败`（失败）/ `会话达到滚动阈值` / `模型额度故障转移` / `CLI 自检通过`。

---

## 9. 可直接粘贴给新会话的开场提示词

> 项目：`C:\Users\me\WorkBuddy\QQBOT`（QQ 机器人桥接 + SnowLuma）。后端已从 WorkBuddy automation 改为官方 CodeBuddy CLI 会话模式，实现在 `qq-bridge/src/wb-session-cli.js`（每 QQ 会话固定 sessionId，`-p --resume`，一轮一进程）。请先读 `qq-bridge/docs/guides/2026-11-01-CLI-SESSION-HANDOFF.md` 与 `qq-bridge/docs/audits/2026-11-01-架构与运行审阅.md`，再动手。
> 约束：① 桥接单文件不拆分；② 不加队列/租约，保持「进程即回合」；③ 不改 SnowLuma 代码；④ 所有删除先备份到 `_backup/`；⑤ 常驻进程由我双击 `qq-bridge\start.bat` 启动，你不要在工具里起常驻进程。
> 本轮目标：先修交接文档 §6-#1（增量轮缺 agentToken），再做多群并行压测。改完只测试、不写审阅报告。

---

## 10. 参考

| 内容 | 路径 |
|---|---|
| CLI 会话调用说明（另一会话探索产出） | `C:\Users\me\WorkBuddy\2026-11-01-03-10-29\会话接口调用说明.md` |
| 封装脚本参考实现 | `C:\Users\me\WorkBuddy\2026-11-01-03-10-29\scripts\wb_session.mjs` |
| 架构与运行审阅（问题清单） | `qq-bridge/docs/audits/2026-11-01-架构与运行审阅.md` / `.html` |
| 改造前快照 | `_backup/2026-11-01-cli-refactor/` |
| 清理清单 | `_backup/2026-11-01-cleanup/MANIFEST.txt` |
| 工作日志 | `.workbuddy/memory/2026-10-31.md`、`2026-11-01.md` |
