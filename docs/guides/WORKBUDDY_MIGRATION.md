# DSH → WorkBuddy 后端迁移说明

本文记录 QQ 桥接把 AI 后端从 DSH 换成本机 WorkBuddy 的改造内容、开关方式、以及迁移后
行为上的差异。目标是：**关掉 DSH 之后机器人照常工作**，且失败可一键回退。

## 1. 迁移前后对比

| 环节 | DSH 时代 | WorkBuddy 时代 |
| --- | --- | --- |
| AI 会话载体 | DSH 常驻会话（sessionId），事件流回传输出 | 本机 WorkBuddy 一次性 automation 任务，每次唤醒一个新会话 |
| 投递方式 | `api.sessions.prompt({ sessionId })` | 往 `~/.workbuddy/workbuddy.db` 的 `automations` 表写一行 `schedule_type='once'` |
| 结束信号 | DSH 事件流 `turn/end` | AI 调 `qq_mark_read` / `qq_set_wake_config`（超时兜底见 §4） |
| 可用性门禁 | `dshReady`（探活 DSH `settings.describe`） | `backendReady()`：WorkBuddy 模式下恒为 `true` |
| 模式来源 | DSH `qq-mode` 设置 + 本地 `state/mode.json` | 只读本地 `state/mode.json` |
| 黑话学习 | 独立 DSH 学习会话 + 等待 turn 输出 | 一次性 WorkBuddy 任务 + `state/slang-inbox/*.json` 文件回传 |
| 前置依赖 | DSH 必须在跑（否则消息入队、机器人哑掉） | 只依赖 SnowLuma + WorkBuddy 桌面端 |

关键抽象在 `src/bridge.js`：

```js
function workbuddyMode() { return cfg.workbuddy?.enabled === true; }
function backendReady()  { return workbuddyMode() ? true : dshReady; }
```

代码里所有「后端能不能投递」的判断都走 `backendReady()`，**不再直接用 `dshReady`**。
这是迁移最容易漏的地方：DSH 一停，`dshReady` 就是 `false`，若门禁没换，所有消息都会
走「入队等 DSH 恢复」分支，表现成整个机器人哑掉。

## 2. 开关与配置

全部在 `qq-bridge/config.json` 的 `workbuddy` 段。`enabled: false` 即完全回退旧 DSH 行为。

```jsonc
"workbuddy": {
  "enabled": true,              // 总开关；false = 纯 DSH 旧行为
  "dbPath": "",                 // 留空 = 用 WorkBuddy 默认库 ~/.workbuddy/workbuddy.db
  "prefix": "QQBOT",            // automation 任务名前缀，GC 与取消都靠它识别
  "cwds": ["C:\\Users\me\\WorkBuddy\\QQBOT"],
  "skills": ["qq-shuqun"],      // 唤醒时挂载的技能
  "modelId": "",                // 留空 = 用 WorkBuddy 当前模型
  "permissionMode": "fullAccess",
  "leadMs": 0,                  // 唤醒提前量：写入后多久执行
  "gcGraceMs": 600000,          // 过期唤醒回收宽限（10 min）
  "gcIntervalMs": 600000,       // 回收轮询间隔（10 min）
  "promptHeaderFile": "",       // 每次唤醒前置的固定提示词文件
  "turnTimeoutMs": 600000,      // 回合超时兜底（10 min，见 §4）
  "forceReserved2": true,       // 启动时强制把模式钉在 reserved2
  "learner": {                  // 黑话学习任务通道
    "enabled": true,
    "timeoutMs": 240000,        // 等文件回传的超时
    "dir": ""                   // 留空 = state/slang-inbox
  }
}
```

## 3. 投递路径

`deliverPromptNow()` 是统一出口，命中 `workbuddy.enabled` 时走
`deliverToWorkBuddy()`（`src/workbuddy-backend.js` → `src/workbuddy-push.js`），
真正落库的是 `pushWake()`。以下三条路径都会经过它：

1. **二代唤醒**（`reserved2`）：`buildWakePromptV2` + `buildWakeSnapshotV2` 装配后投递；
2. **一代 chat 直投**：`handleMessage` 里的普通投递；
3. **控制台后台提醒**：管理端下发的引导/提醒（同样注入角色提示与黑话表）。

黑话学习走独立通道 `deliverTaskToWorkBuddy()`，任务名前缀 `QQBOT-SLANG`，
与会话唤醒隔离，GC 不会误删。

## 4. 回合生命周期（迁移中最关键的一处）

### 4.0 并发容量：不是 1，是 2

统计 `automation_runs` 的区间重叠，**峰值并发 = 2**（04:05:26、08:58/09:01 两处）。
所以闸门按容量做，而不是「全局单槽」：

```jsonc
"workbuddy": { "maxConcurrent": 2 }   // 满员才在桥接本地排队，管理员私聊可插队
```

单槽会导致「私聊在跑 → 群消息被硬卡住」，即使 WorkBuddy 明明还能再接一个。

`GET /api/status` 的 `workbuddySlots` / `workbuddyQueue` 就是当前占槽与排队情况。

### 4.0.1 槽位必须和 WorkBuddy 的真实运行状态对齐

桥接的槽位是「推了几条」的估算，WorkBuddy 的并发是「实际在跑几个 run」。二者会在
**桥接重启**时严重错位：内存清空、以为槽位全空，但上一轮 run 还在 WorkBuddy 里跑；
于是再推一条同会话唤醒 → 同一个会话吃掉两个并发槽，其他会话被饿死
（真实事故：私聊占了两个槽，群组十几分钟没回话）。

`syncWorkBuddySlots()` 解决这一点：以 `automation_runs.status='IN_PROGRESS'` 为真相
校正本地槽位，**启动时一次 + 每 10 秒一次**，超过 `turnTimeoutMs` 的 run 视为僵尸。

配套的坑：`pushWake` 是「按名字删旧行再插新行」，正在跑的 run 会因此**失去
`automations` 关联**。所以 `listRunningWakes()` 必须用 `LEFT JOIN` 并用
`json_extract(metadata_json,'$.resultTitle')` 兜底取名字 —— 否则跑着的 run 从统计里
凭空消失，又回到上面的饿死场景。

### 4.0.2 同一个会话绝不能并发两个回合

闸门必须分两种「挡」：

| 情况 | 处理 |
| --- | --- |
| 该 key 自己已有在跑的回合 | 直接返回 `queued`，**不进 `wbWaitQueue`**；补发交给回合收尾时的 `replayPendingWakeReasonsV2` |
| 别的 key 占满了容量 | 进 `wbWaitQueue` 排队，管理员私聊优先 |

把「同会话」也塞进等待队列会死循环：补投时又被「自己占着槽」挡回队列，
表现为日志每 10 秒一轮 `执行槽空出 → 排队等待执行槽`，永远投不出去。

对应地，`releaseWorkBuddySlot()` 补投时只挑「自己 key 当前没占槽」的排队项，
找不到就 break —— 否则队头被一个不可投的项堵住，整个队列停摆。

### 4.0.3 回合收尾信号缺失要能自愈

`pendingWakeKeys` 只靠「AI 调 mark_read」和「`turnTimeoutMs` 超时」释放。前者不一定发生
（跑完就沉默、被中断），后者要 15 分钟——这段时间里所有新消息都被判成「会话繁忙」只进
`pendingWakeReasons`，用户在 QQ 上看到的就是**发消息完全没反应**。

所以 `syncWorkBuddySlots()` 每 10 秒做一次回收判定，同时满足四条即判回合结束：

1. 该 key 还有回合定时器（本地认为在跑）；
2. WorkBuddy 里没有它的 `IN_PROGRESS` run；
3. 推出已超过 90 秒（覆盖「已推送、run 还没落库」的空窗）；
4. 它的 automation 没有仍在排队（`next_run_at` 为空，说明不是还没轮到）。

满足就 `finishWorkBuddyTurn(key, {completed:false})`：释放槽位 + 补发积压原因。

### 4.1 结束信号

DSH 有事件流，桥接能收到 `turn/end`；WorkBuddy 没有，桥接**收不到任何结束信号**。
若照旧等 `turn/end`，后果是：

- `pendingWakeKeys` 一直不删 → `isConversationBusyV2` 恒为真 → 之后 30 分钟所有新唤醒
  只进 `pendingWakeReasons`，QQ 上表现为「它不理我了」；
- 繁忙期间暂存的原因永不补发；
- 「AI 忘了设置唤醒条件」的兜底永不触发 → 会话可能永久静默。

所以结束信号换成桥接自己能观测到的两件事：

1. **AI 主动收尾**：调用 `qq_mark_read` 或 `qq_set_wake_config`（这就是二代协议的回合终点），
   命中 `markReadCalledKeys` / `wakeConfigUpdatedKeys`；
2. **超时兜底**：`armWorkBuddyTurn()` 起 `turnTimeoutMs` 定时器，到期按「AI 未收尾」处理
   → `finishWorkBuddyTurn(key, { completed: false })`。

`finishWorkBuddyTurn()` 等价于旧的 `turn/end` 处理：删 `pendingWakeKeys`、撤租约，
若 AI 没收尾就兜底成 `defaultWakeConfigV2()`（保证会话之后仍可被唤醒），最后
`replayPendingWakeReasonsV2()` 补发积压原因。

暂停 / 模式切换 / 重置时，`clearAllWorkBuddyTurns()` 会和在途租约一并清掉。

> 若实际运行里经常看到「WorkBuddy 唤醒超过 N 分钟没有收尾」，说明 WorkBuddy 那一侧的
> agent 回合确实比较长（或应用当时没在跑），把 `turnTimeoutMs` 调大即可；调小则恢复更快。

## 5. 黑话学习的文件回传通道

WorkBuddy 每次唤醒都是全新会话，桥接拿不到模型输出。学习任务用文件回传：

1. 桥接生成 `taskId`，拼出 `state/slang-inbox/<taskId>.json`；
2. 在 prompt 尾部追加「把 JSON 数组原样写入该文件」的指令；
3. `deliverTaskToWorkBuddy()` 推送；
4. 桥接每 2 秒轮询该文件，读到即解析并删除；超过 `learner.timeoutMs` 放弃。

失败（推送失败 / 超时）只记日志，**不影响主流程**，消息窗口保留待下次重试。

## 6. 启动

`start-all.ps1` 不再把 DSH 当作硬依赖：只拉起 SnowLuma 与桥接，DSH 缺失不再阻断。
桥接启动日志里会明确打印当前后端：

```
后端：WorkBuddy（本机 automation 推送，DSH 不再参与投递）prefix=QQBOT
```

`GET /api/status` 与控制台状态接口新增 `backend`（`workbuddy` / `dsh`）与
`backendReady` 两个字段，便于排查。

## 7. 验证清单

- [ ] 启动日志出现「后端：WorkBuddy」，且无 DSH 探活报错；
- [ ] `SnowLuma 已连接：ws://127.0.0.1:3001`；
- [ ] `POST /api/socialV2/wake` 后 `state/bridge.log` 出现「WorkBuddy 唤醒已推送」；
- [ ] `automations` 表出现 `QQBOT <key>` 的一次性任务（`schedule_type='once'`）；
- [ ] WorkBuddy 执行后 bridge.log 出现「控制台/工具标记 … 未读已读」（AI 收尾）；
- [ ] 群里的 `qq_send_message` 返回「工具统一发送 …: 成功 1/1 条」。

查表：

```bash
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('C:/Users/Administrator/.workbuddy/workbuddy.db');console.log(db.prepare(\"SELECT id,name,status,schedule_type,scheduled_at,last_run_at FROM automations WHERE name LIKE 'QQBOT%'\").all());db.close();"
```

## 8. 已知差异与注意

### 8.1 会话无法复用（当前最大的架构限制）

WorkBuddy 的 automation **每次运行都新建一个 session**，跑完置 `status=archived`：

| 观测 | 结论 |
| --- | --- |
| `QQBOT group:111111` 一天内累积 **10 个 session** | 每个唤醒 = 一个新会话 |
| `automations` 表无任何会话/线程关联列 | 没有复用入口 |
| 客户端 asar 里搜不到 automation 的会话复用选项 | 不是没配对，是没这个功能 |
| wbipc `wb.request` 打 `/console/as/*` 全 403 | 外部无法向已有会话投 prompt |
| 本地 agent 在 `WorkBuddy.exe --stdio` 内 | 没有对外 ACP socket |

后果：**每次唤醒都没有上文对话记忆**，且系统提示 + 工具定义（实测约 39k input token）
每轮全价重算，没有前缀缓存可摊薄；模型还得重新「发现」工具，偶尔报工具不存在。

> 缓解手段（已落地）：唤醒提示词自带角色/记忆/黑话/状态快照，行为连贯性靠 `state/` 而不是会话；
> `workbuddy.reasoningEffort=low` 压低思考 token；全局执行槽闸门避免排队。

### 8.2 正解：用内置 CLI 承载会话

安装包里自带完整 agent CLI：

```
C:\Users\me\AppData\Local\Programs\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy
```

它支持本方案需要的全部开关：

```bash
codebuddy -p \
  --session-id "qqbot-private-10001" \
  --resume --resume-create-missing \
  --model deepseek-v4.1-flash --effort low \
  --mcp-config <snowluma MCP 配置> \
  --output-format json \
  "<唤醒提示词>"
```

能做到：

- **一个 QQ 群/私聊固定一个 session id**，`--resume` 在同一会话里追加一轮 → 真上下文；
- `--effort low` / `--model` 精确控制成本；
- `--mcp-config` 显式挂 snowluma MCP → 不再「工具找不到」；
- 进程退出码就是**可靠的回合完成信号** → 可以删掉整套 `turnTimeoutMs` 兜底与执行槽猜测。

**前置条件**：CLI 需单独登录（`cbc` 交互式 `/login`，或提供 `CODEBUDDY_AUTH_TOKEN`）。
未登录时报 `Authentication required`，`~/.codebuddy/sessions` 为空。

### 8.3 其他

- **每次唤醒都是新会话**：跨唤醒的短期记忆依赖提示词与 `state/` 里的持久化状态，
  不要依赖「同一个会话」的连续性。
- **唤醒回收是硬删除**：`gcExpiredWakes()` 直接 `DELETE`，不是软删，查表看不到历史唤醒。
- **DSH 侧的 preset / 会话历史不再参与**：模式、人格、黑话等全部由桥接本地 `state/` 承载。
- 需要完全回到旧行为：把 `workbuddy.enabled` 改回 `false` 并重启桥接即可，
  代码里没有任何地方被删掉，只是走了另一条分支。
