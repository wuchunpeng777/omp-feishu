# omp-feishu

飞书里直接对话就能用 omp，也能挂到**本机正在跑的 omp TUI**。

- **A**：每条飞书对话懒启动 `omp --mode rpc`。工具在本机跑，卡片上流式看输出 / 工具 / 子代理。
- **B**：`/list` → `/attach 1` 接到已经 `/collab` 的 TUI。同一套卡片。

飞书只是遥控和流程窗口，不经过公网 URL。

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

可选：

```
OMP_CWD=/path/to/repo          # A 默认工作目录，也可用 /cwd 换
OMP_FEISHU_DATA=~/.omp-feishu  # 飞书 chat → 会话文件映射
```

## 跑

```bash
bun start
```

飞书命令：

| 命令 | 作用 |
| --- | --- |
| 普通文字 | A：发给这条对话的 `omp --mode rpc`；若已 `/attach` 则发给 TUI |
| `/new` | A 新开会话 |
| `/cwd [目录]` | A 查看 / 换工作目录 |
| `/list` | 列出本机 live collab |
| `/attach 1` | 按序号 / pid / instanceId 接入 TUI（可写） |
| `/view 1` | 只读接入 TUI |
| `/leave` | 离开 collab，回到 A |
| `/abort` | 打断当前轮 |
| `/status` | 当前绑定 |
| `/help` | 帮助 |

卡片按钮：打断、离开（仅 B）、回答主机 `ask`。

每条飞书对话记住自己的 omp 会话文件（`~/.omp-feishu/chats.json`），下次还是接着聊。

## 不经过飞书自测

```bash
bun test
bun src/index.ts list
bun src/index.ts attach 1          # 终端里看 B，stdin 当 prompt
bun src/index.ts rpc               # 终端里看 A
bun src/index.ts prompt "只回 ping"
```

## 形态

```
飞书文字 ──► omp-feishu
               ├─ 默认 A：本机 `omp --mode rpc`（JSONL）
               └─ /attach B：collab guest（AES-256-GCM, proto 3）
                      │
                      ▼
               本机执行工具，卡片 patch 流程
```

接入 B 走官方口子：`omp collab list --json` + `omp collab link`，guest 协议与 [my.omp.sh](https://my.omp.sh/) 相同。
