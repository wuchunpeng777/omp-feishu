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
   - `im:chat:create`（创建独立会话群）
   - `im:chat.members:write_only`（退群后点击重新加入）
   - `im:message.group_msg`（可选，接收群内普通消息；专用会话群免 @，普通群仍需 @；敏感权限需要审核）
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
| `/new [名称]`、`/新建 [名称]` | 创建独立会话群，并邀请你加入 |
| `/chats [页码]`、`/sessions`、`/会话` | 分页列出自己创建的全部会话群，点击打开或重新加入 |
| `/reset`、`/重置` | 在当前窗口重置 A 上下文；已接入 TUI 时先退出接入 |
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

## 多窗口会话群

在机器人私聊中发送：

```text
/new 网站开发
/new 分析日志
/chats
```

每次 `/new` 都创建一个只有你和机器人的私有群。点击返回卡片中的「进入新会话群」，即可在独立窗口聊天。新群继承发起窗口的工作目录（没有则使用 `OMP_CWD`），不复制原会话历史；第一次发送文字时才启动独立 `omp --mode rpc`，无需预先在电脑打开 TUI。Windows 上可在各群发送 `/cwd D:\projects\demo` 切换目录。

`/chats` 每页列出 5 个会话，支持上一页和下一页，包含尚未启动或暂时未运行 omp 的群。点击「打开」直接进入对应群；如果已经退群，点击「重新加入」，成功后再点击返回的「打开会话群」。列表和加入操作仅面向会话创建者，专用群也只接受创建者的文字和操作。请勿把工作群改为公开群或向他人转发会话内容。

开通 `im:message.group_msg` 并发布应用新版本后，机器人创建的专用会话群可以直接发文字，无需 @。未开通该权限时使用 `@机器人`，也可创建和使用会话；一般群保留原有 @ 规则。创建用户必须处于应用可用范围内。卡片「重新加入」和分页仍需要配置 `card.action.trigger` 长连接回调。

群目录保存在 `OMP_FEISHU_DATA/groups.json`，每个群对应的工作目录和 omp 会话文件仍保存在 `chats.json`。重启桥接后群列表保留，下一次发送消息会恢复对应 omp 会话。列表只覆盖此功能创建的会话群，不扫描电脑上的全部历史会话文件，也不会给已有 TUI 自动建群；`/list` 继续列出正在运行的电脑 TUI，进入某个群后可 `/attach N` 接入。

**命令变化**：从旧版升级后，`/new` 改为创建一个新的飞书窗口；原来在当前窗口新开上下文的功能改为 `/reset`。`/sessions` 和 `/会话` 改为列出会话群，查看电脑 TUI 请使用 `/list`。

新增或变更权限后，必须在飞书开放平台发布应用版本并完成审批。若收到「缺少权限」或「加入失败」，检查上面的建群权限、成员权限、应用可用范围，以及群是否被解散或机器人被移出。已经解散的群目前仍会保留在本地目录中，打开和加入会失败。

## Windows 更新

在原仓库目录先停止桥接，并保留 `.env`、`OMP_FEISHU_DATA` 数据目录：

```powershell
bun run down
# 更新代码，或在此处应用交付的补丁
bun install --frozen-lockfile
bun run check
bun test
bun run up
```

随后给飞书应用增加建群、成员管理及可选群消息权限，发布新版本，再私聊机器人发送 `/new 测试会话`。本地测试覆盖 API 替身、消息路由、隔离、分页、重试去重和持久化；实际 Windows 进程及飞书建群需要使用你自己的应用凭据联调。

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
