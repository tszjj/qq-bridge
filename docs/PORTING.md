# 换一台机器部署（用你自己的 WorkBuddy 账号）

本项目**不绑定任何人的账号或路径**：模型走你自己的 WorkBuddy 登录态，路径在运行时探测。
按下面做，一台干净机器大约 20 分钟能跑起来。

---

## 一、你需要准备

| 依赖 | 说明 | 检查方式 |
|---|---|---|
| **Windows 10/11** | 桥接与 SnowLuma 都按 Windows 写（`icacls`、`start.bat`、路径处理）。macOS/Linux 需自行改启动脚本 | — |
| **Node.js 22+** | WorkBuddy 桌面端自带一份；也可以自己装 | `node -v` |
| **WorkBuddy 桌面端**（推荐） | 提供登录态 + 内置 Node/CLI；装完要**完成一次登录** | 打开 App 能进主界面 |
| 或 **CodeBuddy CLI** | 只想用 CLI 就 `npm i -g @tencent-ai/codebuddy-code`，再跑一次 `codebuddy` 登录 | `codebuddy --version` |
| **SnowLuma** | QQ 协议端，提供 OneBot HTTP(3000)/WS(3001)。不随本项目分发，需自行安装并登录 QQ | 见第四节 |

> **重要**：模型额度、缓存、可用模型都取决于**你自己的账号**。别人的 config 里的模型名在你的
> 账号下不一定可用，启动后用控制台「WorkBuddy 模型与思考强度」挑一个能用的。

---

## 二、部署步骤

```bash
# 1) 取代码
git clone <你的仓库地址> qq-bridge
cd qq-bridge

# 2) 装依赖（只有少量运行时依赖）
npm install --omit=dev

# 3) 生成配置
copy config.example.json config.json      # macOS/Linux: cp
```

```bash
# 4) 改 config.json 四处必填
```

```jsonc
{
  "consolePort": 3100,
  "consoleBind": "127.0.0.1",          // 只想本机用就保持；要远程访问见 docs/guides/REMOTE_ACCESS.md
  "consoleToken": "",                  // 留空=自动生成并写入 state/console-token
  "ownerQQ": 10001,                    // 你自己的 QQ（管理员，可私聊下指令）
  "allow": { "private": [10001], "groups": [] },   // 先只放自己的私聊，跑通再拉群
  "snowluma": {
    "wsUrl": "ws://127.0.0.1:3001",
    "httpUrl": "http://127.0.0.1:3000",
    "accessToken": "<SnowLuma 里配的 accessToken>",
    "homeDir": "C:\\path\\to\\SnowLuma",
    "launcherPath": "C:\\path\\to\\SnowLuma\\launcher.bat"
  },
  "workbuddy": {
    "enabled": true,
    "modelId": "deepseek-v4.1-flash",   // 换成你账号可用的模型
    "reasoningEffort": "low",
    "cli": { "nodeBin": "", "cliEntry": "" }   // 留空=自动探测
  }
}
```

```bash
# 5) 环境自检（会告诉你缺什么）
node scripts/check-env.mjs

# 6) 启动
start.bat          # Windows：带守护循环，退出会自动重启
```

7. 浏览器打开 `http://127.0.0.1:3100/`，输入 `state/console-token` 里的令牌。
8. 私聊机器人（`ownerQQ`）发一句话，控制台「对话过程」应出现一轮：发起 → 工具调用 → 回复。

---

## 三、CLI 是怎么被找到的

`src/wb-session-cli.js` 的 `discoverCli()` 按顺序试三条，命中即用：

1. 环境变量 `QQBOT_CODECBUDDY_CLI`（指向 `…/@tencent-ai/codebuddy-code/bin/codebuddy`），
   配合可选的 `QQBOT_NODE_BIN` —— CI / 多版本共存最稳；
2. `~/.workbuddy/binaries/node/versions/<版本>/` 下版本号最大的一个 —— 装了 WorkBuddy 桌面端必命中；
3. npm 全局（`%APPDATA%\npm`、`Program Files\nodejs`、`/usr/local/lib`）。

也可以在 `config.json` 里写死，优先级最高：

```json
"workbuddy": { "cli": { "nodeBin": "C:\\Program Files\\nodejs\\node.exe", "cliEntry": "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy" } }
```

三条都找不到时，桥接仍会正常启动（SnowLuma、控制台可用），但每条消息会返回一条明确的
「未找到 CodeBuddy CLI」提示，而不是静默超时。

---

## 四、SnowLuma（QQ 协议端）

不随本项目分发，需要自己装一份：

1. 下载并解压 SnowLuma，首次启动用内置 WebUI（默认 `http://127.0.0.1:5099`）扫码登录 QQ；
2. 配置 OneBot：**HTTP 服务端 3000** + **WS 服务端 3001**，都绑 `127.0.0.1`，设一个 `accessToken`；
3. 把该 token 填进 `config.json` 的 `snowluma.accessToken`；
4. 若用 `start-all.bat` 一起拉起，把 `snowluma.homeDir` / `launcherPath` 指对。

> 3000/3001/5099 **不要对公网开放**：前两个等于机器人身份，后者是登录态入口。

---

## 五、验证清单

| 检查 | 期望 |
|---|---|
| `node scripts/check-env.mjs` | 全部 ✅（或明确指出缺哪项） |
| 启动日志 | `CLI 自检通过`、`SnowLuma 已连接`、`本地控制台已启动` |
| 控制台「运行总览」 | AI 后端显示「CLI 会话 · 每会话独立进程」 |
| 私聊发一句 | 20 秒内回复；「对话过程」出现一轮完整记录 |
| `state/wb-sessions/sessions.json` | 该会话 `turns` 递增、`sessionId` 不变（说明是同一会话续跑） |

---

## 六、常见问题

| 现象 | 处理 |
|---|---|
| 启动即退出，日志说端口被占 | 已有实例在跑；`netstat -ano \| findstr :3100` 找到并结束，或改 `consolePort` |
| 消息没人回 | 先看「对话过程」有没有回合；没有 → 白名单/唤醒规则；有回合但没发出去 → 看工具调用返回 |
| 回合报 `Authentication required` | CLI 没登录：终止所有 CLI 子进程，终端手动跑一次 `codebuddy` 完成登录 |
| 控制台一片白 | 老版本会这样（401 文档被浏览器中止渲染）；新版登录页返 200，见 `docs/guides/REMOTE_ACCESS.md` 第八节 |
| 模型不可用 / 额度不足 | 控制台换模型；`workbuddy.modelFailover` 里配一条降级链会自动切换 |
| 代理环境连不上模型 | 桥接子进程环境是白名单重建的，需要代理请在 `workbuddy.cli.env` 之外自行注入（别把宿主 `CODEBUDDY_*` 透传进去） |
