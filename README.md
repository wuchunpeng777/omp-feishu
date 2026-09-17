# omp-feishu

飞书里挂到**本机正在跑的 omp TUI 会话**（形态 B）。

在飞书发 `/list` → `/attach 1`，之后这条对话就是那个 omp：能 prompt、能打断、卡片上能看到工具 / 子代理 / 流式输出。

本机执行工具。飞书只是遥控和流程窗口。

## 要求

- Bun ≥ 1.1
- 本机已装 [omp](https://github.com/badlogic/pi-mono)（验证过 18.2.4）
- 飞书**企业自建应用**（长连接不支持商店应用）

## 安装

```bash
git clone https://github.com/wuchunpeng777/omp-feishu.git
cd omp-feishu
bun install
cp .env.example .env
```

## 飞书应用

1. [开放平台](https://open.feishu.cn/app) 创建企业自建应用，打开「机器人」。
2. 权限（至少）：
   - `im:message`
   - `im:message.send_as_bot`
   - `im:message.p2p_msg:readonly`（收私聊）
   - `im:message.group_at_msg:readonly`（收群 @）
   - `im:resource`（发卡片）
3. 事件订阅：选择 **使用长连接接收事件**（不用填公网 URL）。
   - `im.message.receive_v1`
   - 卡片回传 `card.action.trigger`
4. 发布版本，把机器人拉进私聊或群。
5. 把 App ID / Secret 写入 `.env`。

群里建议配 `FEISHU_ALLOW_OPEN_IDS`，否则谁 @ 都能驱动你这台机器。

## 跑

本机 omp 先分享会话：

```
# TUI 里
/collab
```

或 settings 里 `collab.autoStart: control`，每个交互会话自动上册。

然后：

```bash
bun start
```

飞书命令：

| 命令 | 作用 |
| --- | --- |
| `/list` | 列出本机 live collab |
| `/attach 1` | 按序号 / pid / instanceId 接入（可写） |
| `/view 1` | 只读接入 |
| 普通文字 | 发给已接入的 omp |
| `/abort` | 打断当前轮 |
| `/leave` | 断开 |
| `/status` | 当前绑定 |
| `/help` | 帮助 |

卡片按钮：接入、打断、离开、回答主机 `ask`。

## 不经过飞书自测

```bash
bun run list
bun src/index.ts attach 1          # 终端里看流程，stdin 当 prompt
bun test
```

## 形态

当前只做 **B：挂已有 TUI**。A（飞书里新开 `omp --mode rpc` 会话）还没做。

接入走官方口子：`omp collab list --json` + `omp collab link`，guest 协议与 [my.omp.sh](https://my.omp.sh/) 相同（AES-256-GCM，proto 3）。
