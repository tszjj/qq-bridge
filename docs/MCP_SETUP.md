# MCP 工具安装与配置

本项目所有「操作 QQ」的能力（收发消息、读群成员、记忆、表情、黑话……）都通过一个
**stdio MCP 服务器**提供：`src/mcp-snowluma-safe.js`。它把 SnowLuma 的 OneBot 接口
包装成一组 `qq_*` 工具，交给 AI 在回合内调用。

```
QQ ←→ SnowLuma(OneBot) ←→ mcp-snowluma-safe.js ←→ CodeBuddy CLI 会话 ←→ 模型
                                    ↑
                              桥接的 state/（token、白名单、会话绑定）
```

---

## 一、默认方式：项目自动注入（推荐，零配置）

桥接启动时会在 `state/wb-sessions/mcp-config.json` 生成一份**独立的** MCP 配置，并用官方参数
`--mcp-config` 传给 CLI：

```json
{
  "mcpServers": {
    "snowluma": {
      "type": "stdio",
      "command": "<自动探测到的 node 路径>",
      "args": ["<项目绝对路径>/src/mcp-snowluma-safe.js"],
      "env": {}
    }
  }
}
```

这样做的三个理由：

1. **不动你的全局配置** `~/.codebuddy/.mcp.json`（别人机器上可能已经有自己的 MCP）；
2. 路径随项目位置自动变，换盘符、换用户目录都不用改；
3. 桥接重启后自动重写，不会出现「配置漂移」。

> 你只需要保证 `src/mcp-snowluma-safe.js` 存在（仓库自带），以及 SnowLuma 在
> `config.json` 的 `snowluma.wsUrl / httpUrl` 上可达。

---

## 二、手动方式：写进全局配置

如果希望**自己的** CLI 会话（不经过桥接）也能用这些工具，可以注册到全局：

| 平台 | 文件 |
|---|---|
| Windows | `%USERPROFILE%\.codebuddy\.mcp.json` |
| macOS / Linux | `~/.codebuddy/.mcp.json` |

```json
{
  "mcpServers": {
    "snowluma": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/path/to/qq-bridge/src/mcp-snowluma-safe.js"],
      "env": {
        "SNOWLUMA_HTTP": "http://127.0.0.1:3000",
        "SNOWLUMA_WS": "ws://127.0.0.1:3001",
        "SNOWLUMA_TOKEN": "<SnowLuma 的 accessToken>"
      }
    }
  }
}
```

`command` 写 `node` 时会用 PATH 里的 Node；想固定版本就写绝对路径。

---

## 三、必须放行工具（否则调用会被拒）

CLI 的 `-p`（非交互）模式下**没有审批人**，任何未放行的工具都会直接返回
`Permission to use ... has been denied`。项目默认在 `config.json` 里配好：

```json
"workbuddy": { "cli": { "allowedTools": "ToolSearch DeferExecuteTool" } }
```

为什么是两个而不是 39 个：`qq_*` 工具是**延迟加载**的，模型先 `ToolSearch` 搜到，
再 `DeferExecuteTool` 执行 —— 放行这两个就够了，不必逐个列。

> 语法坑：`--allowedTools` 是**变参**，`--allowedTools "ToolSearch DeferExecuteTool"`
> 作为单个字符串传是无效的，必须拆成两个参数（代码里已按变参传）。

---

## 四、工具清单（39 个）

| 分类 | 工具 |
|---|---|
| 读消息 | `qq_get_unread_messages`、`qq_get_recent_messages`、`qq_get_message_detail`、`qq_get_group_history`、`qq_get_forward_msg`、`qq_get_message_images`、`qq_get_my_recent_messages` |
| 发消息 | `qq_send_message`、`qq_send_group_message`、`qq_send_private_message`、`qq_reply`、`qq_send_burst`、`qq_send_poke`、`qq_send_sticker`、`qq_send_voice` |
| 会话状态 | `qq_get_prompt`、`qq_mark_read`、`qq_set_wake_config`、`qq_wait_for_messages`、`qq_status`、`qq_social_state` |
| 群与人 | `qq_list_groups`、`qq_get_group_members`、`qq_get_active_members` |
| 记忆 | `qq_memory_query`、`qq_memory_append`、`qq_memory_remove`、`qq_memory_clear` |
| 表情 | `qq_list_stickers`、`qq_get_sticker_image`、`qq_collect_sticker`、`qq_sticker_note`、`qq_set_sticker_remark` |
| 语音 | `qq_list_voices` |
| 黑话 | `qq_slang_query`、`qq_slang_submit` |
| 其它 | `qq_get_self_image`、`qq_report_feedback` |

**鉴权**：多数工具要带 `token`（会话令牌）。它不是全局口令，而是**每个会话一把**，
由 `qq_get_prompt` 返回的唤醒提示里下发；服务端用它确认「这个调用只能动这个会话」。
令牌在控制台和日志里都会脱敏显示。

---

## 五、验证

```bash
# 1) 直接问 MCP 服务器要工具清单（不经过模型）
node mcp-call.mjs '{"tool":"qq_status","args":{}}'

# 2) 让 CLI 实际调一次（会真的连 SnowLuma）
codebuddy -p "调用 qq_get_prompt，把返回的角色名告诉我" \
  --mcp-config state/wb-sessions/mcp-config.json \
  --allowedTools ToolSearch DeferExecuteTool
```

第 2 条如果报 `Permission ... denied` → 白名单没生效；报 `Authentication required` →
CLI 没登录（先跑一次 `codebuddy` 走浏览器登录）；报连接错误 → SnowLuma 没起或端口不对。

---

## 六、常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| `ToolSearch` 找不到 `qq_*` | MCP 没加载 | 看 CLI 启动参数里有没有 `--mcp-config`；路径是否存在 |
| 工具调用返回 `未授权` | 没带 `token` 或令牌过期 | 令牌随会话轮换，续轮提示里要带上（见 `buildIncrementalWakePromptV2`） |
| `Authentication required` | CLI 未登录 | 终端执行一次 `codebuddy`，浏览器完成登录 |
| 桥接里 CLI 报认证失败，但终端里正常 | 子进程继承了宿主注入的 `CODEBUDDY_*` 环境变量 | 桥接已白名单重建子进程环境（只保留 PATH/HOME 等），自定义部署时别把宿主变量透传进去 |
| 工具能调但发不出消息 | SnowLuma 掉线 / OneBot 端口不对 | 看 `state/bridge.log` 里的「SnowLuma 已连接」及 `qq_status` |
