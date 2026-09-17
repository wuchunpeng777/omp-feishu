/** 飞书收发：长连接事件 + 卡片消息。 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { AppConfig } from "../config.ts";
import type { CardView } from "../bridge/format.ts";
import { cardContent as encodeCard } from "./cards.ts";

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

export type MessageHandler = (msg: IncomingMessage) => Promise<void> | void;
export type ActionHandler = (action: CardAction) => Promise<void> | void;

export type FeishuApi = {
  sendCard: (chatId: string, view: CardView) => Promise<string | undefined>;
  replyCard: (messageId: string, view: CardView) => Promise<string | undefined>;
  patchCard: (messageId: string, view: CardView) => Promise<boolean>;
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

export function createFeishu(config: AppConfig): FeishuApi {
  const domain =
    config.domain === "lark" ? Lark.Domain.Lark : Lark.Domain.Feishu;
  const client = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
  });
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain,
    loggerLevel: Lark.LoggerLevel.info,
  });

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

  function start(onMessage: MessageHandler, onAction: ActionHandler): Promise<void> {
    return wsClient.start({
      eventDispatcher: new Lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data) => {
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
          void onMessage({
            chatId: message.chat_id,
            messageId: message.message_id,
            chatType: message.chat_type ?? "p2p",
            openId: sender?.sender_id?.open_id ?? "",
            text,
            mentioned: Array.isArray(message.mentions) && message.mentions.length > 0,
          });
        },
        "card.action.trigger": async (data) => {
          const rec = data as {
            operator?: { open_id?: string };
            action?: { value?: Record<string, string> };
            context?: { open_chat_id?: string; chat_id?: string };
          };
          const value = rec.action?.value ?? {};
          const chatId = rec.context?.open_chat_id ?? rec.context?.chat_id ?? "";
          if (!chatId || !value.action) return;
          void onAction({
            chatId,
            openId: rec.operator?.open_id ?? "",
            action: value.action,
            payload: value,
          });
        },
      }),
    });
  }

  return { sendCard, replyCard, patchCard, sendText, start };
}


