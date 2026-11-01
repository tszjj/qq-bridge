# 控制台「对话过程」页（桥接 ↔ WorkBuddy 收发）

> 面向运维与排障：展示 **桥接 ↔ WorkBuddy** 的每一次往来——发给模型的提示词（发起）、模型返回的思考 / 工具调用 / 文本（接收）。
> 这些会话是 `codebuddy -p` 跑出来的，**只写 transcript、不登记 `workbuddy.db` 的 sessions 表**，所以 WorkBuddy 桌面端侧边栏看不到，控制台是唯一出口。
> QQ 侧的消息不在这里重复（QQ 自己就能看）。

## 一、页面构成

左侧「管理 → 对话过程」，进入后自动拉取：

| 区域 | 内容 | 数据源 |
| --- | --- | --- |
| 顶部四个指标 | 今日发起回合数、完成率、平均耗时、工具调用数 | `state/wb-sessions/turns.jsonl` |
| 左栏会话列表 | 群 / 私聊 / 黑话学习会话，运行中的置顶，带未读数与最近一条预览 | `wb-sessions/sessions.json` + `state/social-v2.json` |
| 「对话过程」标签 | 选中会话的逐轮时间线：发起（提示词）→ 思考 → 工具调用 → 回复 | `~/.codebuddy/projects/<编码 cwd>/<sessionId>.jsonl` |
| 「收发流水」标签 | 跨会话的收发记录（最近 80 次），每行两行：发起摘要 / 接收摘要；点击跳到对应回合 | 同上（多会话合并，8 秒缓存） |

## 二、HTTP 接口（仅控制台，`x-console-token` 鉴权）

| 接口 | 说明 |
| --- | --- |
| `GET /api/console/sessions` | 会话列表 + 今日统计（`stats`） |
| `GET /api/console/transcript?key=<key>&turns=8` | 单会话最近 N 轮（最大 20），`key` 形如 `group:222222` |
| `GET /api/console/exchanges?limit=80` | 跨会话收发流水（新→旧），8 秒缓存 |

三个接口都显式拒绝带 `x-agent-token` 的智能体调用：完整提示词与工具参数属于跨群管理信息。

## 三、transcript 解析规则（`src/wb-transcript.js`）

- `message` + `role=user` → **一轮的开始**，其 `content[].text` 就是「发起」的提示词；
- `reasoning` → 思考块（`rawContent[].text`）；
- `function_call` / `function_call_result` → 工具块（按 `callId` 配对，`DeferExecuteTool` 会自动显示内层工具名）；
- `message` + `role=assistant` → 回复块；
- 首轮判据：提示词里出现 `【角色卡` / `【当前角色】` 即为「完整注入」，否则是「增量唤醒」。

## 四、必须遵守的两个约束

1. **凭据脱敏**：唤醒提示词里的【会话令牌】与 `qq_*` 工具参数里的 `token` 字段一律替换为 `***`，48+ 位十六进制串同样处理。控制台只用于排障，不展示可用的会话凭据。
2. **截断**：单块文本上限 12000 字、工具返回 4000 字、单轮事件 600 条。首轮提示词实测已有 1 万字，不截断会拖垮页面。

## 五、已知限制

- 统计口径是 `turns.jsonl`（部署本功能后开始累计），更早的回合只能在时间线里看；
- 失败回合没有 `function_call_result`，流水里会显示「无响应」；
- 会话滚动（40 轮 / 6 小时）后 transcript 换新，旧 transcript 仍留在 `~/.codebuddy/projects/`，页面只展示当前 sessionId 的那份。
