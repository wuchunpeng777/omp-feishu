# omp-feishu

飞书里直接对话就能用 omp：卡片上流式看输出，运行中标题显示已等待时长，可切模型和思考强度；也能挂到**本机正在跑的 omp TUI**。

- **A**：每条飞书对话懒启动 `omp --mode rpc`。工具在本机跑，卡片上**流式**看输出 / 子代理（CardKit 打字机，飞书客户端 ≥ 7.20）；运行中标题为「运行中 · 1:05」。`/model` `/think` 切模型和思考。`bun run up` 后台常驻，关终端不掉线。
- **B**：`/list` 列出本机正在跑的 TUI。已 `/collab` 的点「接入」；未分享的点「开启」会向该 TUI 发送 `/collab` 并自动加入。同一套卡片。

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
   - `cardkit:card:write`（JSON 2.0 流式卡片；没有的话会退回整卡 patch，看起来不像打字机）
   - `im:message.urgent`（可选。本轮结束或出现选项时用**应用内加急**通知；没有则发一条「本轮已完成」文本）
3. **事件订阅**（「事件与回调」→ **事件配置**）：选择 **使用长连接接收事件**（不用填公网 URL）。
   - `im.message.receive_v1`
4. **回调配置**（同一页 → **回调配置**，和事件是两回事）：
   - 先本机 `bun start`，长连接必须在线，否则保存会失败。
   - 订阅方式选 **使用长连接接收回调**（不要选「将回调发送至开发者服务器」，也没有公网 URL 可填）。
   - 已订阅的回调 → 添加回调 → **卡片回传交互** `card.action.trigger`（新版）。不要订旧版 `card.action.trigger_v1`，旧版不支持长连接。
5. 发布版本，把机器人拉进私聊或群。
6. 把 App ID / Secret 写入 `.env`。

点卡片上的「接入 #N」若弹出「该应用尚未配置卡片回调」：不要点「立即配置」去填 HTTP 地址。按上面第 4 步在后台配长连接回调，再发一版即可。

群里要 @机器人 或打 `/`。建议配 `FEISHU_ALLOW_OPEN_IDS`，否则谁 @ 都能驱动你这台机器。

可选：

```
FEISHU_DOMAIN=feishu           # feishu 国内；lark 国际
OMP_BIN=omp                    # 本机 omp 可执行文件
OMP_DISPLAY_NAME=飞书          # collab guest 显示名
OMP_CWD=/path/to/repo          # A 默认工作目录，也可用 /cwd 换
OMP_FEISHU_DATA=~/.omp-feishu  # 飞书 chat → 会话文件映射
```

## 跑

```bash
bun start          # 前台，关终端就停
bun run up         # 后台，关终端还在
bun run down       # 停后台
bun run running    # 看是否在跑
```

日志：`~/.omp-feishu/bot.log`（可用 `OMP_FEISHU_DATA` 改目录）。

飞书命令：

| 命令 | 作用 |
| --- | --- |
| 普通文字 | A：发给这条对话的 `omp --mode rpc`；若已 `/attach` 则发给 TUI |
| `/new` | A 新开会话 |
| `/cwd [目录]` | A 查看 / 换工作目录 |
| `/model [名称]` | A 列出 / 切换模型（模糊匹配，也可点卡片按钮） |
| `/think [档位]` | A 查看 / 设置思考强度：off, minimal, low, medium, high, xhigh, max, auto |
| `/list` | 列出本机正在跑的 TUI（含未开 collab 的）。卡片按钮最多前 6 个，其余 `/attach N` |
| `/attach 1` | 按序号 / pid / instanceId 接入；未分享的会先开启 collab |
| `/view 1` | 只读接入 TUI |
| `/leave` | 离开 collab，回到 A |
| `/abort` | 打断当前轮 |
| `/status` | 当前绑定 |
| `/help` | 帮助 |

卡片按钮：打断、离开（仅 B）、回答 `ask`/`select` 选项（通栏；文案长时 PC 悬停看全文）。正文里出现 `1. 2.` 选项时也可点选。A 空闲时还有「模型」「思考」。不展示工具过程。

飞书卡片 JSON 大约 30KB。输出超过约 1200 字时，正文留开头，完整内容放在默认展开的「全文」（头尾都保留）；再长会标「已截断」，完整内容仍在 omp 会话里。客户端卡片过高时要点消息上的「展开」。

每条新 prompt 发一张新卡片，避免多轮后要往上翻；新卡片只显示本轮，不会先闪出上一轮输出。运行中标题显示已等待时长。本轮结束（或出现选项）会走飞书原生通知：有加急权限就加急该卡片，否则发一条短文本。每条飞书对话记住自己的 omp 会话文件（`~/.omp-feishu/chats.json`），下次还是接着聊。

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
               本机执行工具，CardKit 流式刷新卡片
```

接入 B：扫本机交互式 TUI 进程 + `omp collab list --json`。Windows 上 collab pid 是 `bun pi-coding-agent`，不是包装进程 `omp.exe`。未分享的向该 TUI 注入 `/collab`，再 `omp collab link`。guest 协议与 [my.omp.sh](https://my.omp.sh/) 相同。
