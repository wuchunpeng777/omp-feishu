/** 把 collab 快照压成飞书卡片可读的流程摘要。 */

import type { AgentMessage, GuestSnapshot, SessionEntry } from "../collab/types.ts";

export type CardButton = {
  text: string;
  action: string;
  type?: "primary" | "danger" | "default";
  payload?: Record<string, string>;
};

export type CardView = {
  title: string;
  template: "blue" | "green" | "orange" | "red" | "grey" | "indigo";
  markdown: string;
  buttons: CardButton[];
};

const MAX_MD = 3500;
const MAX_TEXT = 1200;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function modelLabel(state: GuestSnapshot["state"]): string {
  const model = state?.model;
  if (!model) return "";
  if (typeof model === "string") return model;
  if (model.provider && model.id) return `${model.provider}/${model.id}`;
  return model.name ?? model.id ?? "";
}

function blocksText(content: unknown, type: string): string {
  if (typeof content === "string") return type === "text" ? content : "";
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const rec = block as { type?: string; text?: string };
    if (rec.type === type && typeof rec.text === "string") parts.push(rec.text);
  }
  return parts.join("");
}

function messageText(message: AgentMessage | undefined): string {
  if (!message) return "";
  return blocksText(message.content, "text").trim();
}

function thinkingText(message: AgentMessage | undefined): string {
  if (!message) return "";
  return blocksText(message.content, "thinking").trim();
}

function lastOfRole(entries: SessionEntry[], role: string): AgentMessage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === role) {
      return entry.message;
    }
  }
  return undefined;
}

function toolArgSummary(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const rec = args as Record<string, unknown>;
  const preferred = ["command", "path", "file", "query", "pattern", "i", "url"];
  for (const key of preferred) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(value.replaceAll("\n", " "), 80);
    }
  }
  return "";
}

export function formatSnapshot(
  snap: GuestSnapshot,
  hostLabel: string,
): CardView {
  const streaming = snap.state?.isStreaming === true;
  const status = snap.error
    ? "错误"
    : snap.status === "live"
      ? streaming
        ? "运行中"
        : "已接入"
      : snap.status === "waiting"
        ? "等待主机"
        : snap.status === "reconnecting"
          ? "重连中"
          : snap.status === "connecting"
            ? "连接中"
            : "已断开";

  const template: CardView["template"] = snap.error
    ? "red"
    : streaming
      ? "orange"
      : snap.status === "live"
        ? "green"
        : snap.status === "ended"
          ? "grey"
          : "blue";

  const cwd = typeof snap.header?.cwd === "string" ? snap.header.cwd : "";
  const titleName =
    (typeof snap.header?.title === "string" && snap.header.title) || hostLabel;
  const title = `${status} · ${truncate(titleName, 24)}`;

  const lines: string[] = [];
  lines.push(`**会话** ${hostLabel}${snap.readOnly ? " · 只读" : ""}`);
  if (cwd) lines.push(`**目录** \`${truncate(cwd, 80)}\``);
  const model = modelLabel(snap.state);
  if (model) {
    const think = snap.state?.thinkingLevel
      ? ` · think ${snap.state.thinkingLevel}`
      : "";
    lines.push(`**模型** ${model}${think}`);
  }
  const percent = snap.state?.context?.percent;
  if (typeof percent === "number") {
    lines.push(`**上下文** ${(percent * 100).toFixed(1)}%`);
  }

  const lastUser = lastOfRole(snap.entries, "user");
  const userText = messageText(lastUser);
  if (userText) lines.push(`\n**最近指令**\n${truncate(userText, 400)}`);

  if (snap.tools.length > 0) {
    lines.push("\n**进行中的工具**");
    for (const tool of snap.tools) {
      const arg = toolArgSummary(tool.args);
      const intent = tool.intent ? ` · ${truncate(tool.intent, 40)}` : "";
      lines.push(`- \`${tool.toolName}\`${arg ? ` ${arg}` : ""}${intent}`);
    }
  }

  if (snap.subagentLifecycle.length > 0) {
    lines.push("\n**子代理**");
    for (const agent of snap.subagentLifecycle.slice(-8)) {
      const name = agent.name ?? agent.agent ?? agent.id;
      const st = agent.status ?? "";
      lines.push(`- ${name}${st ? ` · ${st}` : ""}`);
    }
  }

  const live = snap.streamingMessage;
  const thinking = thinkingText(live);
  if (thinking) {
    lines.push(`\n**思考**\n${truncate(thinking, 500)}`);
  }
  const liveText = messageText(live);
  const lastAssistant = messageText(lastOfRole(snap.entries, "assistant"));
  const output = liveText || lastAssistant;
  if (output) {
    lines.push(`\n**输出**\n${truncate(output, MAX_TEXT)}`);
  }

  if (snap.uiRequest) {
    const req = snap.uiRequest;
    lines.push(`\n**主机询问** ${req.title ?? req.method ?? ""}`);
    if (req.message) lines.push(String(req.message));
  }

  if (snap.notices.length > 0) {
    const last = snap.notices[snap.notices.length - 1]!;
    lines.push(`\n_${last.level}: ${truncate(last.message, 200)}_`);
  }

  if (snap.error) lines.push(`\n**断开** ${snap.error}`);

  const buttons: CardButton[] = [];
  if (!snap.readOnly && snap.status === "live") {
    buttons.push({ text: "打断", action: "abort", type: "danger" });
  }
  buttons.push({ text: "离开", action: "leave", type: "default" });
  if (snap.uiRequest?.options && !snap.readOnly) {
    for (const option of snap.uiRequest.options.slice(0, 6)) {
      buttons.push({
        text: truncate(option, 20),
        action: "ui",
        type: "primary",
        payload: { reqId: snap.uiRequest.reqId, value: option },
      });
    }
  }

  return {
    title,
    template,
    markdown: truncate(lines.join("\n"), MAX_MD),
    buttons,
  };
}

export function formatHostList(
  hosts: Array<{
    instanceId: string;
    pid?: number;
    sessionName?: string;
    cwd?: string;
    model?: string;
    access?: string;
    relayConnected?: boolean;
    inputRequired?: boolean;
  }>,
): CardView {
  if (hosts.length === 0) {
    return {
      title: "没有 live collab",
      template: "grey",
      markdown:
        "本机没有正在分享的 omp 会话。\n\n在 TUI 里执行 `/collab`，或设置 `collab.autoStart: control`。",
      buttons: [],
    };
  }
  const lines = hosts.map((host, i) => {
    const name = host.sessionName || host.instanceId.slice(0, 8);
    const relay = host.relayConnected === false ? " · 中继未连" : "";
    const ask = host.inputRequired ? " · 等待输入" : "";
    const cwd = host.cwd ? `\n  \`${host.cwd}\`` : "";
    const model = host.model ? ` · ${host.model}` : "";
    return `**#${i + 1}** ${name} · pid ${host.pid ?? "?"}${model}${relay}${ask}${cwd}`;
  });
  return {
    title: `本机会话 ${hosts.length}`,
    template: "indigo",
    markdown: lines.join("\n\n"),
    buttons: hosts.slice(0, 6).map((host, i) => ({
      text: `接入 #${i + 1}`,
      action: "attach",
      type: "primary",
      payload: { instanceId: host.instanceId },
    })),
  };
}

export const HELP_TEXT = `挂到本机正在跑的 omp（形态 B）。

**命令**
- \`/list\` 列出本机 collab 会话
- \`/attach [序号|pid|id]\` 接入（可写）
- \`/view [序号|pid|id]\` 只读接入
- \`/leave\` 离开
- \`/abort\` 打断当前轮
- \`/status\` 当前绑定
- 接入后直接发文字 = 给 omp 的 prompt

先在 omp TUI 执行 \`/collab\`。`;
