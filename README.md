# omp-feishu

飞书里直接对话就能用 omp：卡片上流式看输出，运行中标题显示已等待时长，可切模型和思考强度；也能挂到**本机正在跑的 omp TUI**。

- **A**：每条飞书对话懒启动 `omp --mode rpc`。工具在本机跑，卡片上**流式**看输出 / 子代理（CardKit 打字机，飞书客户端 ≥ 7.20）；运行中标题为「运行中 · 1:05」。`/model` `/think` 切模型和思考。`bun run up` 后台常驻，关终端不掉线。
- **B**：`/list` 列出本机正在跑的 TUI。点「接入」或「开启」会创建或复用该 TUI 的独立会话群，原聊天返回「进入会话群」入口。未分享的会先向该 TUI 发送 `/collab`。输出和后续对话都在专用群里，使用同一套卡片。

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
   - `im:chat:delete`（关闭会话时解散群）
   - `im:chat:operate_as_owner`（机器人作为创建者且不再是群主时解散群需要）
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
| `/close`、`/关闭` | 确认后关闭当前会话、解散群，并从列表移除；保留电脑上的 omp 历史文件 |
| `/cwd [目录]` | 不带参数显示当前目录和常用目录按钮；带路径切换当前会话目录 |
| `/model [名称]` | A 列出 / 切换模型（模糊匹配，也可点卡片按钮） |
| `/think [档位]` | A 查看 / 设置思考强度：off, minimal, low, medium, high, xhigh, max, auto |
| `/list` | 列出本机正在跑的 TUI（含未开 collab 的）。卡片按钮最多前 6 个，其余 `/attach N` |
| `/attach 1` | 按序号 / pid / instanceId 接入独立群；未分享的先开启 collab；已有专用群内直接接入当前群 |
| `/view 1` | 同上，但只读接入 TUI |
| `/leave` | 离开 collab，回到 A |
| `/abort` | 打断当前轮 |
| `/status` | 当前绑定 |
| `/help` | 帮助 |

`/list` 每次重新读取会话当前标题，优先使用 omp 的 `title` 记录，因此 `/rename` 后不再显示 `session` 头部残留的旧名；旧版会话仍读取头部标题。已分享会话按 `sessionId` 匹配文件，文件不可读时保留 collab 提供的名称。未分享 TUI 尚无会话 ID，仍按工作目录最近修改的会话推断；同目录多开时请先开启 `/collab`，再 `/list` 以准确区分。

卡片按钮：打断、离开（仅 B）、回答 `ask`/`select` 选项（通栏；文案长时 PC 悬停看全文）。正文里出现 `1. 2.` 选项时也可点选。A 空闲时还有「模型」「思考」。不展示工具过程。

回复卡片使用 `width_mode: "fill"`，随聊天窗口宽度自适应展开，流式卡片与旧版回退卡片一致；普通文字气泡不受影响。旧消息不会批量修改，新发出的卡片使用此设置。

飞书卡片 JSON 大约 30KB。输出超过约 1200 字时，正文留开头，完整内容放在默认展开的「全文」（头尾都保留）；再长会标「已截断」，完整内容仍在 omp 会话里。客户端卡片过高时要点消息上的「展开」。

每条新 prompt 发一张新卡片，避免多轮后要往上翻；新卡片只显示本轮，不会先闪出上一轮输出。运行中标题显示已等待时长。本轮结束（或出现选项）会走飞书原生通知：有加急权限就加急该卡片，否则发一条短文本。每条飞书对话记住自己的 omp 会话文件（`~/.omp-feishu/chats.json`），下次还是接着聊。

## 常用工作目录

在 `OMP_FEISHU_DATA/cwd-presets.json`（默认 `~/.omp-feishu/cwd-presets.json`）配置常用目录：

```json
[
  { "name": "网站项目", "path": "D:\\projects\\website" },
  { "name": "游戏项目", "path": "D:\\projects\\game" }
]
```

`path` 必须是机器人所在电脑上的绝对路径。发送 `/cwd` 显示目录卡片，点击按钮只切换当前飞书会话，也可继续发送 `/cwd 绝对路径`。配置每次显示或点击时读取，增删目录无需重启；被移除或路径已变更的旧按钮会要求重新选择。目录不存在或不是文件夹时不会停止原会话。

切换会停止当前会话的 omp 进程并开启新上下文，其他会话不受影响；原历史文件不会删除。请等当前任务结束后再切换。新目录会持久保存，通过 `/new` 创建的群会继承发起窗口目录。接入电脑 TUI 时先 `/leave`，不能用此命令改变共享 TUI 的目录。未配置常用目录时仍可手动输入路径。目录按钮沿用现有卡片回调，不需要新增飞书权限。

## 多窗口会话群

在机器人私聊中发送：

```text
/new 网站开发
/new 分析日志
/chats
```

每次 `/new` 都创建一个只有你和机器人的私有群。点击返回卡片中的「进入新会话群」，即可在独立窗口聊天。新群继承发起窗口的工作目录（没有则使用 `OMP_CWD`），不复制原会话历史；第一次发送文字时才启动独立 `omp --mode rpc`，无需预先在电脑打开 TUI。Windows 上可在各群发送 `/cwd D:\projects\demo` 切换目录。

`/chats` 每页列出 5 个会话，支持上一页和下一页，包含尚未启动或暂时未运行 omp 的群。点击「打开」直接进入对应群；如果已经退群，点击「重新加入」，成功后再点击返回的「打开会话群」。列表、加入和关闭操作仅面向会话创建者，专用群也只接受创建者的文字和操作。请勿把工作群改为公开群或向他人转发会话内容。

开通 `im:message.group_msg` 并发布应用新版本后，机器人创建的专用会话群可以直接发文字，无需 @。未开通该权限时使用 `@机器人`，也可创建和使用会话；一般群保留原有 @ 规则。创建用户必须处于应用可用范围内。卡片「重新加入」和分页仍需要配置 `card.action.trigger` 长连接回调。

群目录保存在 `OMP_FEISHU_DATA/groups.json`，每个群对应的工作目录和 omp 会话文件仍保存在 `chats.json`。重启桥接后群列表保留，下一次发送消息会恢复对应 omp 会话。列表只覆盖机器人创建的会话群，不扫描电脑上的全部历史会话文件。

在机器人私聊或普通群中点击 `/list` 的「接入」「开启」，或发送 `/attach N`、`/view N`，会为选中的 TUI 创建私有会话群。重复接入同一 TUI 会复用自己的群（退群后自动重新加入），不同用户分别建群；原聊天只显示跳转入口，需要点击「进入会话群」打开，不会把 bot 私聊本身变成新聊天。建群失败会报错，不会退回公共窗口接入。需开通上方列出的建群和成员权限。

已有专用会话群内的接入仍作用于当前群，不额外建群。TUI 绑定会持久保存；重启桥接后，在群内发文字会尝试重新连接，连接尚未就绪时会提示稍后重发，主机离线不会另起 RPC。`/leave` 或 `/reset` 会清除绑定并回到飞书独立会话；`/close` 只断开共享 TUI 的接入，不会终止电脑上的 TUI。

**命令变化**：从旧版升级后，`/new` 改为创建一个新的飞书窗口；原来在当前窗口新开上下文的功能改为 `/reset`。`/sessions` 和 `/会话` 改为列出会话群，查看电脑 TUI 请使用 `/list`。

新增或变更权限后，必须在飞书开放平台发布应用版本并完成审批。若收到「缺少权限」或「加入失败」，检查上面的建群权限、成员权限、应用可用范围，以及群是否被解散或机器人被移出。如果绕过机器人在飞书中手动解散群，本地目录仍会保留记录；可从列表点击关闭，确认后清理记录。

### 关闭会话和群

在专用会话群发送 `/close`（或 `/关闭`），或在 `/chats` 列表点击对应行的「关闭」。机器人会显示包含群名的确认卡片；点击「确认关闭并解散群」才会执行，点击「取消」不会影响会话。确认按钮在 5 分钟内有效，重启机器人后需要重新确认。

确认后会取消当前轮、停止该群的独立 omp RPC 进程、解散飞书群，并从 `/chats` 移除。电脑上的 omp 历史文件及 `chats.json` 中的文件索引保留；`groups.json` 留下关闭标记，避免迟到消息或旧的新建请求重新启动会话。如果此群接入了共享电脑 TUI，只断开 collab 接入，不会终止共享 TUI 本身。

只有创建者能关闭自己的会话群，不能通过 `/close` 解散普通群或机器人私聊。解散群失败时会保留列表记录，可检查权限后再次发起关闭；已经解散的群按成功处理。本功能不会删除工作目录中的项目文件。

飞书应用需开通 `im:chat:delete` 并发布版本。机器人须为群主，或者为群创建者且具有 `im:chat:operate_as_owner` 权限。解散后群聊天记录不再保留，详见[飞书解散群接口](https://open.feishu.cn/document/server-docs/group/chat/delete)。真实解散操作需要在你的飞书应用中联调，本地测试使用 API 替身。

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
