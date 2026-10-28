/** 飞书对话：默认 RPC 会话（A），/attach 挂本机 collab（B）。 */

import { resolve, join, isAbsolute } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { GroupStore, groupListCard, groupUrl } from "../rpc/groups.ts";
import {
  ensureCollabHost,
  fetchCollabLink,
  listLiveConversations,
  resolveConversation,
  type CollabAccess,
  type CollabHost,
} from "../collab/hosts.ts";
import { connectGuest, type CollabGuest } from "../collab/guest.ts";
import type { GuestSnapshot } from "../collab/types.ts";
import type { AppConfig } from "../config.ts";
import type { CardAction, FeishuApi, IncomingMessage, LiveCard } from "../feishu/bot.ts";
import { RpcSession } from "../rpc/session.ts";
import { ChatStore, storePath } from "../rpc/store.ts";
import {
  formatHostList,
  formatModelList,
  formatSnapshot,
  formatThinkCard,
  HELP_TEXT,
  type CardView,
} from "./format.ts";
import { matchModels, parseThinkLevel } from "./select.ts";

type CardPump = {
  live?: LiveCard;
  liveGen: number;
  lastKey?: string;
  lastOpenId?: string;
  lastSnap?: GuestSnapshot;
  lastShowLeave?: boolean;
  lastLabel?: string;
  timer?: ReturnType<typeof setTimeout>;
  tick?: ReturnType<typeof setInterval>;
  pending?: CardView;
  chain: Promise<void>;
};

type CollabBinding = CardPump & {
  kind: "collab";
  host: CollabHost;
  access: CollabAccess;
  guest: CollabGuest;
};

type RpcBinding = CardPump & {
  kind: "rpc";
  session: RpcSession;
};

export class Bridge {
  private readonly collab = new Map<string, CollabBinding>();
  private readonly rpc = new Map<string, RpcBinding>();
  private readonly startingRpc = new Map<string, Promise<RpcBinding>>();
  private readonly store: ChatStore;
  private readonly groups: GroupStore;
  private readonly closing = new Set<string>();
  private readonly closed = new Set<string>();
  private readonly closeRequests = new Map<string, {
    sourceChatId: string; groupId: string; ownerOpenId: string; expiresAt: number;
  }>();
  private readonly creating = new Map<string, Promise<void>>();
  private readonly attachingGroups = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AppConfig,
    private readonly feishu: FeishuApi,
  ) {
    this.store = new ChatStore(storePath(config.dataDir));
    this.groups = new GroupStore(join(config.dataDir, "groups.json"));
  }

  allowed(openId: string): boolean {
    if (!openId) return false;
    if (this.config.allowOpenIds.size === 0) return true;
    return this.config.allowOpenIds.has(openId);
  }

  async onMessage(msg: IncomingMessage): Promise<void> {
    try {
      await this.handleMessage(msg);
    } catch (err) {
      console.error("onMessage", err);
      await this.feishu
        .sendText(
          msg.chatId,
          `处理失败：${err instanceof Error ? err.message : String(err)}`,
        )
        .catch(() => {});
    }
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    if (!this.allowed(msg.openId)) {
      await this.feishu.sendText(msg.chatId, "你不在白名单里。");
      return;
    }
    const group = msg.chatType !== "p2p";
    const text = msg.text.trim();
    if (!text) return;
    const managed = group ? await this.groups.get(msg.chatId) : undefined;
    if (managed?.closedAt || this.closing.has(msg.chatId) || this.closed.has(msg.chatId)) return;
    if (managed && managed.ownerOpenId !== msg.openId) {
      await this.feishu.sendText(msg.chatId, "这个会话群只接受创建者的指令。");
      return;
    }
    if (group && !managed && !msg.mentioned && !text.startsWith("/")) return;

    const command = parseCommand(text);
    if (command) {
      await this.dispatch(msg, command.name, command.arg);
      return;
    }

    if (managed?.collab && !this.collab.has(msg.chatId)) {
      await this.attach(msg, managed.collab.instanceId, managed.collab.access);
      // 恢复失败时不能把发给共享 TUI 的文字误发到新的 RPC 上下文。
      if (!this.collab.has(msg.chatId)) return;
    }
    const collab = this.collab.get(msg.chatId);
    if (collab) {
      collab.lastOpenId = msg.openId;
      const ui = collab.guest.snapshot().uiRequest;
      if (ui) {
        collab.guest.sendUiResponse(ui.reqId, text);
        return;
      }
      if (collab.access !== "control") {
        await this.feishu.sendText(msg.chatId, "当前是只读接入，不能发 prompt。用 /attach");
        return;
      }
      if (collab.guest.snapshot().status !== "live") {
        await this.feishu.sendText(msg.chatId, "主机还没就绪，稍后再发。");
        return;
      }
      this.recycleLiveCard(collab);
      collab.guest.sendPrompt(text);
      return;
    }

    let rpc: RpcBinding;
    try {
      rpc = await this.ensureRpc(msg.chatId);
    } catch (err) {
      await this.feishu.sendText(
        msg.chatId,
        `无法启动 omp：${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    rpc.lastOpenId = msg.openId;
    const ui = rpc.session.snapshot().uiRequest;
    if (ui) {
      rpc.session.sendUiResponse(ui.reqId, text);
      return;
    }
    this.recycleLiveCard(rpc);
    try {
      await rpc.session.prompt(text);
    } catch (err) {
      await this.feishu.sendText(
        msg.chatId,
        `prompt 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async onAction(action: CardAction): Promise<void> {
    try {
      await this.handleAction(action);
    } catch (err) {
      console.error("onAction", err);
      await this.feishu.sendText(action.chatId,
        `操作失败：${err instanceof Error ? err.message : String(err)}`).catch(() => {});
    }
  }

  private async handleAction(action: CardAction): Promise<void> {
    if (!this.allowed(action.openId)) return;
    const fake: IncomingMessage = {
      chatId: action.chatId,
      messageId: "",
      chatType: "p2p",
      openId: action.openId,
      text: "",
      mentioned: true,
    };
    const managed = await this.groups.get(action.chatId);
    if (managed?.closedAt || this.closing.has(action.chatId) || this.closed.has(action.chatId)) return;
    if (managed && managed.ownerOpenId !== action.openId) return;
    switch (action.action) {
      case "close_group":
        await this.requestClose(fake, action.payload.groupId ?? "");
        break;
      case "close_confirm":
        await this.confirmClose(fake, action.payload.token ?? "", false);
        break;
      case "close_cancel":
        await this.confirmClose(fake, action.payload.token ?? "", true);
        break;
      case "groups":
        await this.sendGroups(fake, action.payload.page ?? "1");
        break;
      case "join_group":
        await this.joinGroup(fake, action.payload.groupId ?? "");
        break;
      case "set_cwd": {
        const presets = await this.cwdPresets();
        const preset = presets.find((item) => item.id === action.payload.presetId);
        if (!preset) throw new Error("常用目录已变更，请重新发送 /cwd 选择。");
        await this.setCwd(fake, preset.path);
        break;
      }
      case "attach":
        await this.dispatch(
          fake,
          "attach",
          action.payload.selector ?? action.payload.instanceId ?? action.payload.pid ?? "",
        );
        break;
      case "leave":
        await this.dispatch(fake, "leave", "");
        break;
      case "abort":
        await this.dispatch(fake, "abort", "");
        break;
      case "models":
        await this.dispatch(fake, "model", "");
        break;
      case "think":
        await this.dispatch(fake, "think", "");
        break;
      case "set_model":
        await this.applyModel(
          action.chatId,
          action.payload.provider ?? "",
          action.payload.modelId ?? "",
        );
        break;
      case "set_think":
        await this.applyThink(action.chatId, action.payload.level ?? "");
        break;
      case "ui": {
        const reqId = action.payload.reqId;
        const value = action.payload.value;
        if (!reqId || value === undefined) break;
        const collab = this.collab.get(action.chatId);
        if (collab) {
          collab.lastOpenId = action.openId;
          collab.guest.sendUiResponse(reqId, value);
          break;
        }
        const rpc = this.rpc.get(action.chatId);
        if (rpc) rpc.lastOpenId = action.openId;
        rpc?.session.sendUiResponse(reqId, value);
        break;
      }
      case "pick": {
        const value = action.payload.value;
        if (!value) break;
        await this.handleMessage({ ...fake, text: value });
        break;
      }
      default:
        break;
    }
  }

  private async dispatch(
    msg: IncomingMessage,
    name: string,
    arg: string,
  ): Promise<void> {
    switch (name) {
      case "help":
        await this.feishu.sendText(msg.chatId, HELP_TEXT);
        break;
      case "list":
        await this.sendHostList(msg);
        break;
      case "attach":
        await this.attach(msg, arg, "control");
        break;
      case "view":
        await this.attach(msg, arg, "view");
        break;
      case "leave":
        await this.leaveCollab(msg.chatId, true);
        break;
      case "new":
        await this.createGroup(msg, arg);
        break;
      case "chats":
        await this.sendGroups(msg, arg);
        break;
      case "close":
        await this.requestClose(msg, msg.chatId);
        break;
      case "reset":
        await this.newRpc(msg.chatId);
        break;
      case "cwd":
        await this.setCwd(msg, arg);
        break;
      case "model":
        await this.setModelCommand(msg, arg);
        break;
      case "think":
        await this.setThinkCommand(msg, arg);
        break;
      case "abort": {
        const collab = this.collab.get(msg.chatId);
        if (collab) {
          if (collab.access !== "control") {
            await this.feishu.sendText(msg.chatId, "只读接入不能打断。");
            break;
          }
          collab.guest.sendAbort();
          break;
        }
        const rpc = this.rpc.get(msg.chatId);
        if (!rpc) {
          await this.feishu.sendText(msg.chatId, "没有进行中的会话。");
          break;
        }
        rpc.session.abort();
        break;
      }
      case "status":
        await this.status(msg.chatId);
        break;
      default:
        await this.feishu.sendText(msg.chatId, `未知命令 /${name}。发 /help`);
        break;
    }
  }

  private async sendHostList(msg: IncomingMessage): Promise<void> {
    try {
      const conversations = await listLiveConversations(this.config.ompBin);
      const view = formatHostList(conversations);
      const id = msg.messageId
        ? await this.feishu.replyCard(msg.messageId, view)
        : undefined;
      if (!id) await this.feishu.sendCard(msg.chatId, view);
    } catch (err) {
      await this.feishu.sendText(
        msg.chatId,
        `列出会话失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async attach(
    msg: IncomingMessage,
    selector: string,
    access: CollabAccess,
  ): Promise<void> {
    try {
      const conversations = await listLiveConversations(this.config.ompBin);
      if (conversations.length === 0) {
        await this.feishu.sendText(
          msg.chatId,
          "本机没有正在跑的 omp TUI。打开 omp 后再 /list。",
        );
        return;
      }
      const conversation = selector.trim()
        ? resolveConversation(conversations, selector)
        : conversations.length === 1
          ? conversations[0]
          : undefined;
      if (!conversation) {
        await this.sendHostList(msg);
        return;
      }
      if (!conversation.sharing) {
        await this.feishu.sendText(
          msg.chatId,
          `正在为 pid ${conversation.pid ?? "?"} 开启 collab…`,
        );
      }
      const host = await ensureCollabHost(conversation, this.config.ompBin);
      if (access === "control" && host.access === "view") access = "view";
      const managed = await this.groups.get(msg.chatId);
      if (managed) {
        await this.bindCollab(msg, host, access);
      } else {
        const key = `${msg.openId}:${host.instanceId}`;
        let operation = this.attachingGroups.get(key);
        if (!operation) {
          operation = this.attachGroup(msg, host, access);
          this.attachingGroups.set(key, operation);
        }
        let chatId: string;
        try { chatId = await operation; } finally {
          if (this.attachingGroups.get(key) === operation) this.attachingGroups.delete(key);
        }
        // 升级前在公共窗口留下的绑定也必须移走，后续输出只发到专用群。
        await this.leaveCollab(msg.chatId, false);
        await this.feishu.sendCard(msg.chatId, {
          title: "TUI 独立会话已准备", template: "green",
          markdown: "输出和后续对话都在独立会话群中，不再占用当前聊天。点击下方按钮进入；未开通群普通消息权限时请 @机器人。",
          buttons: [{ text: "进入会话群", action: "open_group", url: groupUrl(chatId, this.config.domain) }],
        });
      }
    } catch (err) {
      await this.feishu.sendText(
        msg.chatId,
        `接入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async attachGroup(msg: IncomingMessage, host: CollabHost, access: CollabAccess): Promise<string> {
    let record = (await this.groups.list(msg.openId)).find(group =>
      group.collab?.instanceId === host.instanceId && !this.closing.has(group.chatId));
    if (!record) {
      const name = `omp · ${(host.sessionName || host.instanceId.slice(0, 8)).replace(/[\r\n]/g, " ").slice(0, 60)}`;
      const requestId = randomUUID().replaceAll("-", "");
      const chatId = await this.feishu.createSessionGroup(name, msg.openId, requestId);
      record = { chatId, name, ownerOpenId: msg.openId, requestId, createdAt: new Date().toISOString(),
        collab: { instanceId: host.instanceId, access } };
      await this.groups.put(record);
      await this.store.set(chatId, { cwd: host.cwd ?? this.config.cwd });
    } else {
      await this.feishu.joinSessionGroup(record.chatId, msg.openId);
    }
    const existing = this.collab.get(record.chatId);
    if (!existing || existing.access !== access || ["ended", "left"].includes(existing.guest.snapshot().status)) {
      await this.bindCollab({ ...msg, chatId: record.chatId, chatType: "group" }, host, access);
    }
    return record.chatId;
  }

  private async bindCollab(msg: IncomingMessage, host: CollabHost, access: CollabAccess): Promise<void> {
    const link = await fetchCollabLink(host.instanceId, access, this.config.ompBin);
    const record = await this.groups.get(msg.chatId);
    if (record?.closedAt || this.closing.has(msg.chatId) || this.closed.has(msg.chatId)) {
      throw new Error("会话正在关闭或已关闭。");
    }
    await this.leaveCollab(msg.chatId, false, false);
    if (record) await this.groups.put({ ...record, collab: { instanceId: host.instanceId, access } });
    if (this.closing.has(msg.chatId) || this.closed.has(msg.chatId)) throw new Error("会话正在关闭或已关闭。");
    const guest = connectGuest(link.url, this.config.displayName);
    const binding: CollabBinding = {
      kind: "collab", host, access, guest, liveGen: 0, lastOpenId: msg.openId, chain: Promise.resolve(),
    };
    this.collab.set(msg.chatId, binding);
    guest.subscribe((snap) => this.queueCard(
      msg.chatId, binding, snap, true, host.sessionName || host.instanceId.slice(0, 8),
    ));
  }

  private async leaveCollab(chatId: string, notify: boolean, forget = true): Promise<void> {
    let hadTarget = false;
    if (forget) {
      const record = await this.groups.get(chatId);
      if (record?.collab) {
        hadTarget = true;
        const { collab: _, ...rest } = record;
        await this.groups.put(rest);
      }
    }
    const bound = this.collab.get(chatId);
    if (!bound) {
      if (notify) await this.feishu.sendText(chatId, hadTarget
        ? "已离开 collab，回到飞书 omp。" : "当前就是飞书自己的 omp 会话。");
      return;
    }
    this.collab.delete(chatId);
    this.stopPump(bound);
    bound.guest.close();
    if (notify) await this.feishu.sendText(chatId, "已离开 collab，回到飞书 omp。");
  }

  private async sendGroups(msg: IncomingMessage, arg: string): Promise<void> {
    const page = arg ? Number(arg) : 1;
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("页码必须是正整数，例如 /chats 2");
    const groups = await this.groups.list(msg.openId);
    await this.feishu.sendCard(msg.chatId, groupListCard(groups, page, this.config.domain));
  }

  private async joinGroup(msg: IncomingMessage, groupId: string): Promise<void> {
    const group = await this.groups.get(groupId);
    if (!group || group.closedAt || this.closing.has(groupId) || group.ownerOpenId !== msg.openId) throw new Error("找不到你创建的可用会话群。");
    await this.feishu.joinSessionGroup(group.chatId, msg.openId);
    await this.feishu.sendCard(msg.chatId, {
      title: "已加入会话群", template: "green", markdown: "点击下方按钮打开会话。",
      buttons: [{ text: "打开会话群", action: "open_group", url: groupUrl(group.chatId, this.config.domain) }],
    });
  }

  private async requestClose(msg: IncomingMessage, groupId: string): Promise<void> {
    const group = await this.groups.get(groupId);
    if (!group || group.closedAt || group.ownerOpenId !== msg.openId) {
      throw new Error("只能关闭自己通过机器人创建的会话群；私聊或普通群不能解散。");
    }
    for (const [token, request] of this.closeRequests) {
      if (request.expiresAt < Date.now() || request.groupId === groupId) this.closeRequests.delete(token);
    }
    const token = randomUUID();
    this.closeRequests.set(token, {
      sourceChatId: msg.chatId, groupId, ownerOpenId: msg.openId, expiresAt: Date.now() + 5 * 60_000,
    });
    await this.feishu.sendCard(msg.chatId, {
      title: `确认关闭 ${group.name} 并解散群？`, template: "red",
      markdown: "确认后将停止这个群的 omp 会话进程，解散飞书群并从会话列表移除。群聊天记录不会保留，电脑上的 omp 历史文件保留。若已接入电脑 TUI，只断开接入，不终止共享的 TUI。确认按钮 5 分钟内有效。",
      buttons: [
        { text: "确认关闭并解散群", action: "close_confirm", type: "danger", payload: { token } },
        { text: "取消", action: "close_cancel", payload: { token } },
      ],
    });
  }

  private async confirmClose(msg: IncomingMessage, token: string, cancel: boolean): Promise<void> {
    const request = this.closeRequests.get(token);
    if (!request || request.expiresAt < Date.now() || request.sourceChatId !== msg.chatId || request.ownerOpenId !== msg.openId) {
      throw new Error("关闭确认已失效，请重新发送 /close 或点击列表中的关闭按钮。");
    }
    this.closeRequests.delete(token);
    if (cancel) {
      await this.feishu.sendText(msg.chatId, "已取消关闭。");
      return;
    }
    const group = await this.groups.get(request.groupId);
    if (!group || group.closedAt || group.ownerOpenId !== msg.openId || this.closing.has(group.chatId)) return;
    this.closing.add(group.chatId);
    try {
      // 等待正在启动的 RPC 完成，避免解散群后留下无人管理的进程。
      await this.startingRpc.get(group.chatId)?.catch(() => {});
      await this.leaveCollab(group.chatId, false);
      const rpc = this.rpc.get(group.chatId);
      if (rpc) {
        this.stopPump(rpc);
        // 先通知 omp 取消当前轮，再关闭 RPC 进程；已退出时仍继续清理。
        try { rpc.session.abort(); } catch {}
        await rpc.session.dispose();
        this.rpc.delete(group.chatId);
      }
      await this.feishu.dissolveSessionGroup(group.chatId);
      this.closed.add(group.chatId);
      // 留下关闭标记防止迟到消息重新启动会话；chats.json 保留历史文件索引。
      await this.groups.close(group.chatId);
      if (msg.chatId !== group.chatId) await this.feishu.sendText(msg.chatId, "会话已关闭，群已解散。");
    } catch (err) {
      throw new Error(`关闭未全部完成：${err instanceof Error ? err.message : String(err)}。群未成功解散时会保留在列表中，可重新确认关闭。`);
    } finally {
      this.closing.delete(group.chatId);
    }
  }

  private async createGroup(msg: IncomingMessage, arg: string): Promise<void> {
    if (!msg.openId) throw new Error("缺少用户 open_id，无法创建会话群。");
    const requestId = createHash("sha256").update(`${msg.openId}:${msg.messageId || randomUUID()}`).digest("hex").slice(0, 32);
    const active = this.creating.get(requestId);
    if (active) return active;
    const operation = this.doCreateGroup(msg, arg, requestId);
    this.creating.set(requestId, operation);
    try { await operation; } finally { this.creating.delete(requestId); }
  }

  private async doCreateGroup(msg: IncomingMessage, arg: string, requestId: string): Promise<void> {
    let record = await this.groups.findRequest(msg.openId, requestId);
    if (record?.closedAt) throw new Error("这条新建请求对应的会话已经关闭，请发送新的 /new 命令。");
    if (!record) {
      const title = arg.trim() || "新会话";
      if (title.length > 60 || /[\r\n]/.test(title)) throw new Error("会话名称请使用不超过 60 字的单行文字。");
      const name = `omp · ${title}`;
      const chatId = await this.feishu.createSessionGroup(name, msg.openId, requestId);
      record = { chatId, name, ownerOpenId: msg.openId, requestId, createdAt: new Date().toISOString() };
      // 先记录群，后续配置失败也能通过 /chats 找回，重试不会另建一个群。
      await this.groups.put(record);
    }
    if (!(await this.store.get(record.chatId))) {
      const source = await this.store.get(msg.chatId);
      await this.store.set(record.chatId, { cwd: source?.cwd ?? this.config.cwd });
    }
    await this.feishu.sendText(record.chatId,
      "这是独立的 omp 会话群。直接发送文字即可开始；/cwd 目录 设置 Windows 工作目录，/reset 重置当前上下文，/chats 查看我的所有会话。首次发送文字时启动 omp，重启机器人后可恢复历史。未配置群普通消息权限时请 @机器人。");
    await this.feishu.sendCard(msg.chatId, {
      title: "会话群已创建", template: "green", markdown: "新会话已准备好，点击进入群聊。",
      buttons: [{ text: "进入新会话群", action: "open_group", url: groupUrl(record.chatId, this.config.domain) }],
    });
  }

  private async newRpc(chatId: string): Promise<void> {
    await this.leaveCollab(chatId, false);
    const rpc = await this.ensureRpc(chatId);
    this.recycleLiveCard(rpc);
    await rpc.session.newSession();
    await this.persistRpc(chatId, rpc);
    await this.feishu.sendText(chatId, "已开新的 omp 会话。");
  }

  private async cwdPresets(): Promise<Array<{ name: string; path: string; id: string }>> {
    const file = join(this.config.dataDir, "cwd-presets.json");
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const entries: unknown = JSON.parse(raw);
    if (!Array.isArray(entries)) throw new Error("cwd-presets.json 必须是目录数组。");
    return entries.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || !("path" in entry) ||
          typeof entry.name !== "string" || !entry.name.trim() ||
          typeof entry.path !== "string" || !isAbsolute(entry.path)) {
        throw new Error("cwd-presets.json 每项需要 name 和绝对路径 path。");
      }
      const path = resolve(entry.path);
      return { name: entry.name.trim(), path, id: createHash("sha256").update(path).digest("hex") };
    });
  }

  private async setCwd(msg: IncomingMessage, arg: string): Promise<void> {
    if (this.collab.has(msg.chatId) || (await this.groups.get(msg.chatId))?.collab) {
      await this.feishu.sendText(msg.chatId, "当前接入电脑 TUI，请先 /leave，再选择飞书会话的工作目录。");
      return;
    }
    if (!arg) {
      const rec = await this.store.get(msg.chatId);
      const current = rec?.cwd ?? this.config.cwd;
      const presets = await this.cwdPresets();
      await this.feishu.sendCard(msg.chatId, {
        title: "选择工作目录", template: "indigo",
        markdown: [
          `当前目录：\`${current}\``,
          ...presets.map((item) => `**${item.name}**：\`${item.path}\``),
          "",
          presets.length ? "点击按钮切换当前会话，也可发送 `/cwd 绝对路径`。" : "尚未预置常用目录，可发送 `/cwd 绝对路径`。",
          "切换会停止当前会话进程并开启新上下文；其他会话不受影响。",
        ].join("\n"),
        buttons: presets.map((item) => ({
          text: item.name, action: "set_cwd", width: "fill",
          type: item.path === current ? "primary" : "default",
          payload: { presetId: item.id },
        })),
      });
      return;
    }
    const cwd = resolve(arg);
    if (!(await stat(cwd)).isDirectory()) throw new Error(`不是文件夹：${cwd}`);
    await this.startingRpc.get(msg.chatId);
    const old = this.rpc.get(msg.chatId);
    if (old) {
      this.rpc.delete(msg.chatId);
      this.stopPump(old);
      await old.session.dispose();
    }
    await this.store.set(msg.chatId, { cwd });
    await this.ensureRpc(msg.chatId);
    await this.feishu.sendText(msg.chatId, `工作目录：${cwd}`);
  }
  private async status(chatId: string): Promise<void> {
    const collab = this.collab.get(chatId);
    if (collab) {
      await this.feishu.sendCard(
        chatId,
        formatSnapshot(
          collab.guest.snapshot(),
          collab.host.sessionName || collab.host.instanceId.slice(0, 8),
        ),
      );
      return;
    }
    const target = (await this.groups.get(chatId))?.collab;
    if (target) {
      await this.feishu.sendText(chatId, `此群绑定电脑 TUI ${target.instanceId}，发送文字会尝试恢复接入；/leave 可解除绑定。`);
      return;
    }
    const rpc = this.rpc.get(chatId);
    if (!rpc) {
      await this.feishu.sendText(
        chatId,
        `还没开 omp。直接发文字会在 ${this.config.cwd} 起会话。`,
      );
      return;
    }
    await this.feishu.sendCard(
      chatId,
      formatSnapshot(rpc.session.snapshot(), "omp", {
        showLeave: false,
        showModelControls: true,
      }),
    );
  }

  private async rpcOrExplain(chatId: string): Promise<RpcBinding | undefined> {
    if (this.collab.has(chatId) || (await this.groups.get(chatId))?.collab) {
      await this.feishu.sendText(
        chatId,
        "接入 TUI 时请在主机上切模型和思考。/leave 后可用 /model /think。",
      );
      return undefined;
    }
    return this.ensureRpc(chatId);
  }

  private currentModel(rpc: RpcBinding) {
    const model = rpc.session.snapshot().state?.model;
    if (!model || typeof model === "string" || !model.provider || !model.id) {
      return undefined;
    }
    return { provider: model.provider, id: model.id, name: model.name };
  }

  private async sendView(msg: IncomingMessage, view: CardView): Promise<void> {
    const id = msg.messageId
      ? await this.feishu.replyCard(msg.messageId, view)
      : undefined;
    if (!id) await this.feishu.sendCard(msg.chatId, view);
  }

  private async setModelCommand(msg: IncomingMessage, arg: string): Promise<void> {
    const rpc = await this.rpcOrExplain(msg.chatId);
    if (!rpc) return;
    try {
      const models = await rpc.session.listModels();
      const current = this.currentModel(rpc);
      if (!arg.trim()) {
        await this.sendView(msg, formatModelList(models, current));
        return;
      }
      const hits = matchModels(models, arg);
      if (hits.length === 0) {
        await this.feishu.sendText(
          msg.chatId,
          `没有匹配「${arg}」的模型。发 /model 看列表。`,
        );
        return;
      }
      if (hits.length > 1) {
        await this.sendView(msg, formatModelList(hits, current, arg));
        return;
      }
      await this.applyModel(msg.chatId, hits[0].provider, hits[0].id, rpc);
    } catch (err) {
      await this.feishu.sendText(
        msg.chatId,
        `列/切模型失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async applyModel(
    chatId: string,
    provider: string,
    modelId: string,
    existing?: RpcBinding,
  ): Promise<void> {
    if (!provider || !modelId) return;
    const rpc = existing ?? (await this.rpcOrExplain(chatId));
    if (!rpc) return;
    try {
      const model = await rpc.session.setModel(provider, modelId);
      await this.feishu.sendText(chatId, `模型：${model.provider}/${model.id}`);
    } catch (err) {
      await this.feishu.sendText(
        chatId,
        `切换模型失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async setThinkCommand(msg: IncomingMessage, arg: string): Promise<void> {
    const rpc = await this.rpcOrExplain(msg.chatId);
    if (!rpc) return;
    if (!arg.trim()) {
      await this.sendView(
        msg,
        formatThinkCard(rpc.session.snapshot().state?.thinkingLevel),
      );
      return;
    }
    const level = parseThinkLevel(arg);
    if (!level) {
      await this.sendView(
        msg,
        formatThinkCard(rpc.session.snapshot().state?.thinkingLevel),
      );
      await this.feishu.sendText(
        msg.chatId,
        `未知思考强度「${arg}」。用 off / low / medium / high / max / auto。`,
      );
      return;
    }
    await this.applyThink(msg.chatId, level, rpc);
  }

  private async applyThink(
    chatId: string,
    level: string,
    existing?: RpcBinding,
  ): Promise<void> {
    const parsed = parseThinkLevel(level);
    if (!parsed) return;
    const rpc = existing ?? (await this.rpcOrExplain(chatId));
    if (!rpc) return;
    try {
      await rpc.session.setThinkingLevel(parsed);
      const now = rpc.session.snapshot().state?.thinkingLevel ?? parsed;
      await this.feishu.sendText(chatId, `思考强度：${now}`);
    } catch (err) {
      await this.feishu.sendText(
        chatId,
        `设置思考失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async ensureRpc(chatId: string): Promise<RpcBinding> {
    if (this.closing.has(chatId) || this.closed.has(chatId)) throw new Error("会话正在关闭或已关闭。");
    if ((await this.groups.get(chatId))?.collab) {
      throw new Error("此群绑定了电脑 TUI；请先 /leave，再使用飞书独立 omp 会话。");
    }
    const pending = this.startingRpc.get(chatId);
    if (pending) return pending;
    const operation = this.startRpc(chatId);
    this.startingRpc.set(chatId, operation);
    try { return await operation; } finally { this.startingRpc.delete(chatId); }
  }

  private async startRpc(chatId: string): Promise<RpcBinding> {
    const existing = this.rpc.get(chatId);
    if (existing && existing.session.snapshot().status !== "ended") {
      return existing;
    }
    if (existing) {
      this.rpc.delete(chatId);
      this.stopPump(existing);
      void existing.session.dispose().catch(() => {});
    }
    const rec = await this.store.get(chatId);
    const cwd = rec?.cwd ?? this.config.cwd;
    const session = await RpcSession.start({
      ompBin: this.config.ompBin,
      cwd,
      sessionFile: rec?.sessionFile,
    });
    const binding: RpcBinding = { kind: "rpc", session, liveGen: 0, chain: Promise.resolve() };
    this.rpc.set(chatId, binding);
    session.subscribe((snap) =>
      this.queueCard(chatId, binding, snap, false, "omp"),
    );
    this.recycleLiveCard(binding);
    await this.persistRpc(chatId, binding);
    return binding;
  }

  private async persistRpc(chatId: string, binding: RpcBinding): Promise<void> {
    await this.store.set(chatId, {
      cwd: binding.session.getCwd(),
      sessionFile: binding.session.getSessionFile(),
    });
  }

  private queueCard(
    chatId: string,
    binding: CardPump,
    snap: GuestSnapshot,
    showLeave: boolean,
    label: string,
  ): void {
    if (this.closing.has(chatId) || this.closed.has(chatId)) return;
    binding.lastSnap = snap;
    binding.lastShowLeave = showLeave;
    binding.lastLabel = label;
    const view = formatSnapshot(snap, label, {
      showLeave,
      showModelControls: !showLeave,
    });
    this.armTick(chatId, binding, view.streaming === true);
    const key = `${view.title}\n${view.markdown}\n${view.buttons.map((b) => b.text).join(",")}`;
    if (key === binding.lastKey) return;
    binding.pending = view;
    const endStream = view.streaming !== true && binding.live?.streaming === true;
    if (endStream && binding.timer) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
    }
    if (binding.timer) return;
    const delay = !binding.live || endStream ? 0 : view.streaming ? 180 : 350;
    binding.timer = setTimeout(() => {
      binding.timer = undefined;
      const pending = binding.pending;
      binding.pending = undefined;
      if (!pending) return;
      this.scheduleFlush(chatId, binding, pending);
    }, delay);
  }

  private scheduleFlush(chatId: string, binding: CardPump, view: CardView): void {
    binding.chain = binding.chain
      .then(() => this.flushCard(chatId, binding, view))
      .catch((err) => {
        console.error("刷新卡片失败", err);
      });
  }

  private stopPump(binding: CardPump): void {
    if (binding.timer) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
    }
    if (binding.tick) {
      clearInterval(binding.tick);
      binding.tick = undefined;
    }
    binding.pending = undefined;
  }

  private armTick(chatId: string, binding: CardPump, streaming: boolean): void {
    if (!streaming) {
      if (binding.tick) {
        clearInterval(binding.tick);
        binding.tick = undefined;
      }
      return;
    }
    if (binding.tick) return;
    binding.tick = setInterval(() => {
      const snap = binding.lastSnap;
      if (!snap) return;
      this.queueCard(
        chatId,
        binding,
        snap,
        binding.lastShowLeave === true,
        binding.lastLabel ?? "",
      );
    }, 1000);
  }

  private recycleLiveCard(binding: CardPump): void {
    this.stopPump(binding);
    binding.lastKey = undefined;
    binding.live = undefined;
    binding.lastSnap = undefined;
    binding.liveGen += 1;
  }

  private async flushCard(
    chatId: string,
    binding: CardPump,
    view: CardView,
  ): Promise<void> {
    if (this.closing.has(chatId) || this.closed.has(chatId)) return;
    const gen = binding.liveGen;
    const wasStreaming = binding.live?.streaming === true;
    const key = `${view.title}\n${view.markdown}\n${view.buttons.map((b) => b.text).join(",")}`;
    const next = await this.feishu.pushLiveCard(chatId, binding.live, view);
    if (binding.liveGen !== gen) return;
    binding.lastKey = key;
    binding.live = next;
    if (
      wasStreaming &&
      view.streaming !== true &&
      (view.notify === "done" || view.notify === "ask")
    ) {
      await this.feishu.notifyDone(
        chatId,
        next.messageId,
        binding.lastOpenId,
        view.notify,
      );
    }
  }

}

function parseCommand(
  text: string,
): { name: string; arg: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1).trim();
  const space = body.search(/\s/);
  const raw = (space === -1 ? body : body.slice(0, space)).toLowerCase();
  const arg = space === -1 ? "" : body.slice(space).trim();
  const aliases: Record<string, string> = {
    help: "help",
    帮助: "help",
    list: "list",
    sessions: "chats",
    chats: "chats",
    会话: "chats",
    对话: "chats",
    attach: "attach",
    接入: "attach",
    view: "view",
    leave: "leave",
    离开: "leave",
    abort: "abort",
    stop: "abort",
    打断: "abort",
    status: "status",
    状态: "status",
    new: "new",
    新开: "new",
    新建: "new",
    close: "close",
    关闭: "close",
    reset: "reset",
    重置: "reset",
    cwd: "cwd",
    model: "model",
    模型: "model",
    think: "think",
    thinking: "think",
    思考: "think",
  };
  return { name: aliases[raw] ?? raw, arg };
}
