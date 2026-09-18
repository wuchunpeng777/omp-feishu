/** 飞书对话：默认 RPC 会话（A），/attach 挂本机 collab（B）。 */

import { resolve } from "node:path";
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
  timer?: ReturnType<typeof setTimeout>;
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
  private readonly store: ChatStore;

  constructor(
    private readonly config: AppConfig,
    private readonly feishu: FeishuApi,
  ) {
    this.store = new ChatStore(storePath(config.dataDir));
  }

  allowed(openId: string): boolean {
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
    if (group && !msg.mentioned && !text.startsWith("/")) return;

    const command = parseCommand(text);
    if (command) {
      await this.dispatch(msg, command.name, command.arg);
      return;
    }

    const collab = this.collab.get(msg.chatId);
    if (collab) {
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
    switch (action.action) {
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
          collab.guest.sendUiResponse(reqId, value);
          break;
        }
        const rpc = this.rpc.get(action.chatId);
        rpc?.session.sendUiResponse(reqId, value);
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
          "本机没有正在跑的 omp TUI。打开 omp 后再 /list。不挂的话直接发文字走飞书自己的 omp。",
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
      const link = await fetchCollabLink(
        host.instanceId,
        access,
        this.config.ompBin,
      );
      await this.leaveCollab(msg.chatId, false);
      const guest = connectGuest(link.url, this.config.displayName);
      const binding: CollabBinding = {
        kind: "collab",
        host,
        access,
        guest,
        liveGen: 0,
        chain: Promise.resolve(),
      };
      this.collab.set(msg.chatId, binding);
      guest.subscribe((snap) =>
        this.queueCard(
          msg.chatId,
          binding,
          snap,
          true,
          host.sessionName || host.instanceId.slice(0, 8),
        ),
      );
    } catch (err) {
      await this.feishu.sendText(
        msg.chatId,
        `接入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async leaveCollab(chatId: string, notify: boolean): Promise<void> {
    const bound = this.collab.get(chatId);
    if (!bound) {
      if (notify) await this.feishu.sendText(chatId, "当前就是飞书自己的 omp 会话。");
      return;
    }
    this.collab.delete(chatId);
    clearTimeout(bound.timer);
    bound.guest.close();
    if (notify) await this.feishu.sendText(chatId, "已离开 collab，回到飞书 omp。");
  }

  private async newRpc(chatId: string): Promise<void> {
    const rpc = await this.ensureRpc(chatId);
    this.recycleLiveCard(rpc);
    await rpc.session.newSession();
    await this.persistRpc(chatId, rpc);
    await this.feishu.sendText(chatId, "已开新的 omp 会话。");
  }

  private async setCwd(msg: IncomingMessage, arg: string): Promise<void> {
    if (!arg) {
      const rec = await this.store.get(msg.chatId);
      await this.feishu.sendText(
        msg.chatId,
        `当前目录：${rec?.cwd ?? this.config.cwd}`,
      );
      return;
    }
    const cwd = resolve(arg);
    const old = this.rpc.get(msg.chatId);
    if (old) {
      this.rpc.delete(msg.chatId);
      clearTimeout(old.timer);
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
    if (this.collab.has(chatId)) {
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
    const existing = this.rpc.get(chatId);
    if (existing && existing.session.snapshot().status !== "ended") {
      return existing;
    }
    if (existing) {
      this.rpc.delete(chatId);
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
    const view = formatSnapshot(snap, label, {
      showLeave,
      showModelControls: !showLeave,
    });
    const key = `${view.title}\n${view.markdown}\n${view.buttons.map((b) => b.text).join(",")}`;
    if (key === binding.lastKey) return;
    binding.pending = view;
    const endStream = view.streaming !== true && binding.live?.streaming === true;
    if (endStream && binding.timer) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
    }
    if (binding.timer) return;
    const delay = endStream ? 0 : view.streaming ? 180 : 350;
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

  private recycleLiveCard(binding: CardPump): void {
    if (binding.timer) {
      clearTimeout(binding.timer);
      binding.timer = undefined;
    }
    binding.pending = undefined;
    binding.lastKey = undefined;
    binding.live = undefined;
    binding.liveGen += 1;
  }

  private async flushCard(
    chatId: string,
    binding: CardPump,
    view: CardView,
  ): Promise<void> {
    const gen = binding.liveGen;
    const key = `${view.title}\n${view.markdown}\n${view.buttons.map((b) => b.text).join(",")}`;
    const next = await this.feishu.pushLiveCard(chatId, binding.live, view);
    if (binding.liveGen !== gen) return;
    binding.lastKey = key;
    binding.live = next;
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
    sessions: "list",
    会话: "list",
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
    cwd: "cwd",
    model: "model",
    模型: "model",
    think: "think",
    thinking: "think",
    思考: "think",
  };
  return { name: aliases[raw] ?? raw, arg };
}
