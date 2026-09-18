/** 飞书收发：长连接事件 + CardKit 流式卡片。 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../config.ts";
import type { CardView } from "../bridge/format.ts";
import {
  canTypewriter,
  cardContent as encodeCard,
  cardContentV2,
  cardStructure,
  STREAM_MD_ID,
} from "./cards.ts";

export type IncomingMessage = {
  chatId: string;
  messageId: string;
  chatType: string;
  openId: string;
  text: string;
  mentioned: boolean;
};

export type CardAction = {
  chatId: string;
  openId: string;
  action: string;
  payload: Record<string, string>;
};

export type LiveCard = {
  cardId?: string;
  messageId?: string;
  sequence: number;
  streaming: boolean;
  markdown: string;
  structure: string;
};

export type MessageHandler = (msg: IncomingMessage) => Promise<void> | void;
export type ActionHandler = (action: CardAction) => Promise<void> | void;

export type FeishuApi = {
  sendCard: (chatId: string, view: CardView) => Promise<string | undefined>;
  replyCard: (messageId: string, view: CardView) => Promise<string | undefined>;
  patchCard: (messageId: string, view: CardView) => Promise<boolean>;
  pushLiveCard: (
    chatId: string,
    live: LiveCard | undefined,
    view: CardView,
  ) => Promise<LiveCard>;
  sendText: (chatId: string, text: string) => Promise<void>;
  start: (onMessage: MessageHandler, onAction: ActionHandler) => Promise<void>;
};

function extractText(msgType: string, content: string): string {
  try {
    const parsed = JSON.parse(content) as {
      text?: string;
      content?: Array<Array<{ tag?: string; text?: string }>>;
    };
    if (msgType === "text") return parsed.text ?? "";
    if (msgType === "post" && Array.isArray(parsed.content)) {
      const parts: string[] = [];
      for (const row of parsed.content) {
        for (const span of row) {
          if (span.tag === "text" && span.text) parts.push(span.text);
        }
      }
      return parts.join("");
    }
  } catch {
    return content;
  }
  return "";
}

function stripMentions(text: string): string {
  return text.replace(/@_user_\d+/g, "").replace(/@\S+/g, "").trim();
}

function kitFailed(res: { code?: number; msg?: string }, label: string): boolean {
  if (!res.code) return false;
  console.error(label, res.code, res.msg);
  return true;
}

function kitDenied(res: { code?: number }): boolean {
  return res.code === 300311 || res.code === 99991663;
}

function parseCardValue(raw: unknown): Record<string, string> {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return parseCardValue(JSON.parse(raw) as unknown);
    } catch {
      return {};
    }
  }
  if (typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}


export function createFeishu(config: AppConfig): FeishuApi {
  const domain =
    config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
  });
  const wsOpts = {
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.info,
  };
  let kitDisabled = false;

  async function sendCard(chatId: string, view: CardView): Promise<string | undefined> {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: encodeCard(view),
      },
    });
    if (res.code !== 0) {
      console.error("飞书发卡片失败", res.code, res.msg);
      return undefined;
    }
    return res.data?.message_id;
  }

  async function replyCard(
    messageId: string,
    view: CardView,
  ): Promise<string | undefined> {
    const res = await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: encodeCard(view),
      },
    });
    if (res.code !== 0) {
      console.error("飞书回复卡片失败", res.code, res.msg);
      return undefined;
    }
    return res.data?.message_id;
  }

  async function patchCard(messageId: string, view: CardView): Promise<boolean> {
    const res = await client.im.v1.message.patch({
      path: { message_id: messageId },
      data: { content: encodeCard(view) },
    });
    if (res.code !== 0) {
      console.error("飞书更新卡片失败", res.code, res.msg);
      return false;
    }
    return true;
  }

  async function sendText(chatId: string, text: string): Promise<void> {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
    });
    if (res.code !== 0) console.error("飞书发文本失败", res.code, res.msg);
  }

  async function fallbackPatchOrSend(
    chatId: string,
    messageId: string | undefined,
    view: CardView,
  ): Promise<string | undefined> {
    if (messageId && (await patchCard(messageId, view))) return messageId;
    return sendCard(chatId, view);
  }

  function snapshot(view: CardView, extra: Partial<LiveCard>): LiveCard {
    return {
      sequence: 0,
      streaming: view.streaming === true,
      markdown: view.markdown,
      structure: cardStructure(view),
      ...extra,
    };
  }

  async function createKitCard(view: CardView): Promise<string | undefined> {
    const res = await client.cardkit.v1.card.create({
      data: { type: "card_json", data: cardContentV2(view) },
    });
    if (kitDenied(res)) kitDisabled = true;
    if (kitFailed(res, "CardKit 创建失败")) return undefined;
    return res.data?.card_id;
  }
  async function sendKitCard(
    chatId: string,
    cardId: string,
  ): Promise<string | undefined> {
    const res = await client.im.v1.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
      },
    });
    if (res.code !== 0) {
      console.error("飞书发送 CardKit 失败", res.code, res.msg);
      return undefined;
    }
    return res.data?.message_id;
  }

  async function streamMarkdown(
    cardId: string,
    markdown: string,
    sequence: number,
  ): Promise<boolean> {
    const res = await client.cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: STREAM_MD_ID },
      data: { content: markdown || "…", sequence },
    });
    if (kitDenied(res)) kitDisabled = true;
    return !kitFailed(res, "CardKit 流式失败");
  }

  async function updateKitCard(
    cardId: string,
    view: CardView,
    sequence: number,
  ): Promise<boolean> {
    const res = await client.cardkit.v1.card.update({
      path: { card_id: cardId },
      data: {
        sequence,
        card: { type: "card_json", data: cardContentV2(view) },
      },
    });
    if (kitDenied(res)) kitDisabled = true;
    return !kitFailed(res, "CardKit 全量更新失败");
  }

  async function setStreamingMode(
    cardId: string,
    streaming: boolean,
    sequence: number,
  ): Promise<boolean> {
    const res = await client.cardkit.v1.card.settings({
      path: { card_id: cardId },
      data: {
        sequence,
        settings: JSON.stringify({ config: { streaming_mode: streaming } }),
      },
    });
    if (kitDenied(res)) kitDisabled = true;
    return !kitFailed(res, "CardKit 切换流式失败");
  }

  async function pushLiveCard(
    chatId: string,
    live: LiveCard | undefined,
    view: CardView,
  ): Promise<LiveCard> {
    if (kitDisabled) {
      const messageId = await fallbackPatchOrSend(chatId, live?.messageId, view);
      return snapshot(view, { messageId, sequence: live?.sequence ?? 0 });
    }

    if (!live?.cardId) {
      const cardId = await createKitCard(view);
      if (!cardId) {
        const messageId = await fallbackPatchOrSend(chatId, live?.messageId, view);
        return snapshot(view, { messageId });
      }
      const messageId = await sendKitCard(chatId, cardId);
      if (!messageId) {
        const fallbackId = await fallbackPatchOrSend(chatId, live?.messageId, view);
        return snapshot(view, { messageId: fallbackId });
      }
      return snapshot(view, { cardId, messageId, sequence: 1 });
    }

    let sequence = live.sequence;
    if (canTypewriter(live, view)) {
      sequence += 1;
      if (await streamMarkdown(live.cardId, view.markdown, sequence)) {
        return snapshot(view, {
          cardId: live.cardId,
          messageId: live.messageId,
          sequence,
        });
      }
    }
    if (live.streaming !== (view.streaming === true)) {
      sequence += 1;
      await setStreamingMode(live.cardId, view.streaming === true, sequence);
    }
    sequence += 1;
    if (await updateKitCard(live.cardId, view, sequence)) {
      return snapshot(view, {
        cardId: live.cardId,
        messageId: live.messageId,
        sequence,
      });
    }

    const messageId = await fallbackPatchOrSend(chatId, live.messageId, view);
    return snapshot(view, { messageId, sequence });
  }

  async function start(onMessage: MessageHandler, onAction: ActionHandler): Promise<void> {
    const eventDispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        try {
          const sender = data.sender as {
            sender_type?: string;
            sender_id?: { open_id?: string };
          };
          if (sender?.sender_type === "app") return;
          const message = data.message as {
            chat_id?: string;
            message_id?: string;
            chat_type?: string;
            message_type?: string;
            content?: string;
            mentions?: unknown[];
          };
          if (!message?.chat_id || !message.message_id) return;
          const text = stripMentions(
            extractText(message.message_type ?? "text", message.content ?? ""),
          );
          console.log(
            "收到消息",
            message.chat_type ?? "p2p",
            message.chat_id,
            text.slice(0, 80),
          );
          await onMessage({
            chatId: message.chat_id,
            messageId: message.message_id,
            chatType: message.chat_type ?? "p2p",
            openId: sender?.sender_id?.open_id ?? "",
            text,
            mentioned: Array.isArray(message.mentions) && message.mentions.length > 0,
          });
        } catch (err) {
          console.error("处理消息失败", err);
        }
      },
      "card.action.trigger": async (data) => {
        try {
          const rec = data as {
            operator?: { open_id?: string };
            action?: { value?: unknown };
            context?: { open_chat_id?: string; chat_id?: string };
          };
          const value = parseCardValue(rec.action?.value);
          const chatId = rec.context?.open_chat_id ?? rec.context?.chat_id ?? "";
          if (!chatId || !value.action) {
            console.error("卡片回调缺字段", rec.context, value);
            return { toast: { type: "error", content: "回调数据不完整" } };
          }
          console.log("收到卡片", chatId, value.action);
          await onAction({
            chatId,
            openId: rec.operator?.open_id ?? "",
            action: value.action,
            payload: value,
          });
          return {
            toast: {
              type: "info",
              content: value.action === "leave" ? "已离开" : "已处理",
            },
          };
        } catch (err) {
          console.error("处理卡片失败", err);
          return { toast: { type: "error", content: "处理失败" } };
        }
      },
    });

    for (;;) {
      const wsClient = new Lark.WSClient(wsOpts);
      try {
        await wsClient.start({ eventDispatcher });
        await Promise.withResolvers<void>().promise;
      } catch (err) {
        console.error("飞书长连接失败，3s 后重连", err);
        await Bun.sleep(3000);
      }
    }
  }

  return { sendCard, replyCard, patchCard, pushLiveCard, sendText, start };
}
