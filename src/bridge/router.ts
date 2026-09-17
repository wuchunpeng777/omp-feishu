/** 飞书对话绑定本机 collab guest，并把流程卡片持续 patch。 */

import {
  fetchCollabLink,
  listCollabHosts,
  resolveHost,
  type CollabAccess,
  type CollabHost,
} from "../collab/hosts.ts";
import { connectGuest, type CollabGuest } from "../collab/guest.ts";
import type { GuestSnapshot } from "../collab/types.ts";
import type { AppConfig } from "../config.ts";
import type { CardAction, FeishuApi, IncomingMessage } from "../feishu/bot.ts";
import {
  formatHostList,
  formatSnapshot,
  HELP_TEXT,
  type CardView,
} from "./format.ts";

type Binding = {
  host: CollabHost;
  access: CollabAccess;
  guest: CollabGuest;
  cardMessageId?: string;
  lastKey?: string;
  timer?: ReturnType<typeof setTimeout>;
  pending?: CardView;
};

export class Bridge {
  private readonly bindings = new Map<string, Binding>();

  constructor(
    private readonly config: AppConfig,
    private readonly feishu: FeishuApi,
  ) {}

  allowed(openId: string): boolean {
    if (this.config.allowOpenIds.size === 0) return true;
    return this.config.allowOpenIds.has(openId);
  }

  async onMessage(msg: IncomingMessage): Promise<void> {
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
    const bound = this.bindings.get(msg.chatId);
    if (!bound) {
      await this.feishu.sendText(
        msg.chatId,
        "还没接入会话。先发 /list，再 /attach 1",
      );
      return;
    }
    if (bound.access !== "control") {
      await this.feishu.sendText(msg.chatId, "当前是只读接入，不能发 prompt。用 /attach");
      return;
    }
    if (bound.guest.snapshot().status !== "live") {
      await this.feishu.sendText(msg.chatId, "主机还没就绪，稍后再发。");
      return;
    }
    bound.guest.sendPrompt(text);
  }

  async onAction(action: CardAction): Promise<void> {
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
        await this.dispatch(fake, "attach", action.payload.instanceId ?? "");
        break;
      case "leave":
        await this.dispatch(fake, "leave", "");
        break;
      case "abort":
        await this.dispatch(fake, "abort", "");
        break;
      case "ui": {
        const bound = this.bindings.get(action.chatId);
        const reqId = action.payload.reqId;
        const value = action.payload.value;
        if (bound && reqId && value !== undefined) {
          bound.guest.sendUiResponse(reqId, value);
        }
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
      case "sessions":
        await this.sendHostList(msg);
        break;
      case "attach":
        await this.attach(msg, arg, "control");
        break;
      case "view":
        await this.attach(msg, arg, "view");
        break;
      case "leave":
        await this.leave(msg.chatId, true);
        break;
      case "abort":
      case "stop": {
        const bound = this.bindings.get(msg.chatId);
        if (!bound) {
          await this.feishu.sendText(msg.chatId, "没有接入中的会话。");
          break;
        }
        if (bound.access !== "control") {
          await this.feishu.sendText(msg.chatId, "只读接入不能打断。");
          break;
        }
        bound.guest.sendAbort();
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
      const hosts = await listCollabHosts(this.config.ompBin);
      const view = formatHostList(hosts);
      const id = msg.messageId
        ? await this.feishu.replyCard(msg.messageId, view)
        : undefined;
      if (!id) await this.feishu.sendCard(msg.chatId, view);
    } catch (err) {
      await this.feishu.sendText(
        msg.chatId,
        `列出 collab 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async attach(
    msg: IncomingMessage,
    selector: string,
    access: CollabAccess,
  ): Promise<void> {
    try {
      const hosts = await listCollabHosts(this.config.ompBin);
      if (hosts.length === 0) {
        await this.feishu.sendText(
          msg.chatId,
          "本机没有 live collab。在 omp 里执行 /collab。",
        );
        return;
      }
      const host = selector.trim()
        ? resolveHost(hosts, selector)
        : hosts.length === 1
          ? hosts[0]
          : undefined;
      if (!host) {
        await this.sendHostList(msg);
        return;
      }
      if (access === "control" && host.access === "view") {
        access = "view";
      }
      const link = await fetchCollabLink(
        host.instanceId,
        access,
        this.config.ompBin,
      );
      await this.leave(msg.chatId, false);
      const guest = connectGuest(link.url, this.config.displayName);
      const binding: Binding = { host, access, guest };
      this.bindings.set(msg.chatId, binding);
      guest.subscribe((snap) => this.queueCard(msg.chatId, binding, snap));
    } catch (err) {
      await this.feishu.sendText(
        msg.chatId,
        `接入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async leave(chatId: string, notify: boolean): Promise<void> {
    const bound = this.bindings.get(chatId);
    if (!bound) {
      if (notify) await this.feishu.sendText(chatId, "当前没有接入。");
      return;
    }
    this.bindings.delete(chatId);
    clearTimeout(bound.timer);
    bound.guest.close();
    if (notify) await this.feishu.sendText(chatId, "已离开 omp 会话。");
  }

  private async status(chatId: string): Promise<void> {
    const bound = this.bindings.get(chatId);
    if (!bound) {
      await this.feishu.sendText(chatId, "当前没有接入。发 /list");
      return;
    }
    const snap = bound.guest.snapshot();
    await this.feishu.sendCard(
      chatId,
      formatSnapshot(snap, hostLabel(bound.host)),
    );
  }

  private queueCard(chatId: string, binding: Binding, snap: GuestSnapshot): void {
    const view = formatSnapshot(snap, hostLabel(binding.host));
    const key = `${view.title}\n${view.markdown}\n${view.buttons.map((b) => b.text).join(",")}`;
    if (key === binding.lastKey) return;
    binding.pending = view;
    if (binding.timer) return;
    binding.timer = setTimeout(() => {
      binding.timer = undefined;
      const pending = binding.pending;
      binding.pending = undefined;
      if (!pending) return;
      void this.flushCard(chatId, binding, pending);
    }, 400);
  }

  private async flushCard(
    chatId: string,
    binding: Binding,
    view: CardView,
  ): Promise<void> {
    const key = `${view.title}\n${view.markdown}\n${view.buttons.map((b) => b.text).join(",")}`;
    binding.lastKey = key;
    if (binding.cardMessageId) {
      const ok = await this.feishu.patchCard(binding.cardMessageId, view);
      if (ok) return;
      binding.cardMessageId = undefined;
    }
    binding.cardMessageId = await this.feishu.sendCard(chatId, view);
  }
}

function hostLabel(host: CollabHost): string {
  return host.sessionName || host.sessionId || host.instanceId.slice(0, 8);
}

function parseCommand(
  text: string,
): { name: string; arg: string } | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1).trim();
  const space = body.search(/\s/);
  const name = (space === -1 ? body : body.slice(0, space)).toLowerCase();
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
  };
  const mapped = aliases[name];
  if (!mapped) return { name, arg };
  return { name: mapped, arg };
}
