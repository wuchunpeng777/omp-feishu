/** 把 collab 快照压成飞书卡片可读的流程摘要。 */

import type { AgentMessage, GuestSnapshot, SessionEntry } from "../collab/types.ts";
import {
  modelRef,
  THINK_LEVELS,
  type ModelPick,
} from "./select.ts";

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
  streaming?: boolean;
};

export type FormatSnapshotOpts = {
  showLeave?: boolean;
  showModelControls?: boolean;
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

function brief(value: unknown, max: number): string {
  if (value == null) return "";
  if (typeof value === "string") return truncate(value.replaceAll("\n", " ").trim(), max);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return truncate(JSON.stringify(value), max);
  } catch {
    return "";
  }
}

export function formatSnapshot(
  snap: GuestSnapshot,
  hostLabel: string,
  opts?: FormatSnapshotOpts,
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
    lines.push("\n**过程**");
    for (const tool of snap.tools.slice(-12)) {
      const running = tool.status !== "done";
      const mark = running ? "进行中" : "完成";
      const arg = toolArgSummary(tool.args);
      const intent = tool.intent ? ` · ${truncate(tool.intent, 40)}` : "";
      lines.push(
        `- ${mark} \`${tool.toolName}\`${arg ? ` ${arg}` : ""}${intent}`,
      );
      const detail = brief(tool.partialResult, running ? 160 : 80);
      if (detail) lines.push(`  ${detail}`);
    }
  }

  if (snap.subagentLifecycle.length > 0 || snap.subagentProgress.length > 0) {
    lines.push("\n**子代理**");
    for (const agent of snap.subagentLifecycle.slice(-8)) {
      const name = agent.name ?? agent.agent ?? agent.id;
      const st = agent.status ?? "";
      lines.push(`- ${name}${st ? ` · ${st}` : ""}`);
    }
    for (const item of snap.subagentProgress.slice(-8)) {
      const p = item.progress;
      if (!p) continue;
      const label = p.label ?? p.id ?? "subagent";
      const pct =
        typeof p.percent === "number"
          ? p.percent <= 1
            ? ` ${(p.percent * 100).toFixed(0)}%`
            : ` ${p.percent.toFixed(0)}%`
          : "";
      lines.push(`- ${label}${pct}`);
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
    lines.push("");
    for (const notice of snap.notices.slice(-3)) {
      lines.push(`_${notice.level}: ${truncate(notice.message, 200)}_`);
    }
  }


  if (snap.error) lines.push(`\n**断开** ${snap.error}`);

  const buttons: CardButton[] = [];
  if (!snap.readOnly && snap.status === "live") {
    buttons.push({ text: "打断", action: "abort", type: "danger" });
  }
  if (opts?.showModelControls && !snap.readOnly && snap.status === "live" && !streaming) {
    buttons.push({ text: "模型", action: "models", type: "default" });
    buttons.push({ text: "思考", action: "think", type: "default" });
  }
  if (opts?.showLeave !== false) {
    buttons.push({ text: "离开", action: "leave", type: "default" });
  }
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
    streaming,
  };
}

export function formatHostList(
  hosts: Array<{
    instanceId?: string;
    pid?: number;
    sessionName?: string;
    cwd?: string;
    model?: string;
    access?: string;
    relayConnected?: boolean;
    inputRequired?: boolean;
    sharing?: boolean;
  }>,
): CardView {
  if (hosts.length === 0) {
    return {
      title: "没有本机 TUI",
      template: "grey",
      markdown:
        "本机没有正在跑的 omp TUI。\n\n打开一个 omp 终端后再 `/list`。未分享的会话可以点「开启」自动 `/collab` 并接入。",
      buttons: [],
    };
  }
  const lines = hosts.map((host, i) => {
    const name = host.sessionName || host.instanceId?.slice(0, 8) || `pid ${host.pid ?? "?"}`;
    const sharing = host.sharing === false ? " · 未分享" : " · 已分享";
    const relay = host.sharing !== false && host.relayConnected === false ? " · 中继未连" : "";
    const ask = host.inputRequired ? " · 等待输入" : "";
    const cwd = host.cwd ? `\n  \`${host.cwd}\`` : "";
    const model = host.model ? ` · ${host.model}` : "";
    return `**#${i + 1}** ${name} · pid ${host.pid ?? "?"}${model}${sharing}${relay}${ask}${cwd}`;
  });
  return {
    title: `本机 TUI ${hosts.length}`,
    template: "indigo",
    markdown: `${lines.join("\n\n")}\n\n未分享的会话会先向该 TUI 发送 \`/collab\`，成功后再接入。`,
    buttons: hosts.slice(0, 6).map((host, i) => {
      const selector = host.instanceId || (host.pid != null ? String(host.pid) : "");
      const sharing = host.sharing !== false;
      return {
        text: sharing ? `接入 #${i + 1}` : `开启 #${i + 1}`,
        action: "attach",
        type: sharing ? "primary" : "default",
        payload: { instanceId: selector, selector },
      };
    }),
  };
}

export function formatModelList(
  models: ModelPick[],
  current?: ModelPick | string,
  query?: string,
): CardView {
  const currentRef =
    typeof current === "string"
      ? current
      : current
        ? modelRef(current)
        : "";
  const shown = models.slice(0, 40);
  const lines =
    shown.length === 0
      ? ["没有匹配的模型。换个关键词，或发 `/model` 看全部。"]
      : shown.map((model, i) => {
          const ref = modelRef(model);
          const mark = ref === currentRef ? " · 当前" : "";
          const name = model.name && model.name !== model.id ? ` ${model.name}` : "";
          return `**#${i + 1}** \`${ref}\`${name}${mark}`;
        });
  if (models.length > shown.length) {
    lines.push(`\n还有 ${models.length - shown.length} 个。发 \`/model 关键词\` 缩小。`);
  }
  const q = query?.trim();
  return {
    title: q ? `模型 · ${truncate(q, 16)} ${models.length}` : `模型 ${models.length}`,
    template: "indigo",
    markdown: truncate(
      [`当前 \`${currentRef || "未知"}\``, "", ...lines].join("\n"),
      MAX_MD,
    ),
    buttons: shown.slice(0, 6).map((model, i) => ({
      text: truncate(`#${i + 1} ${model.id}`, 20),
      action: "set_model",
      type: modelRef(model) === currentRef ? "primary" : "default",
      payload: { provider: model.provider, modelId: model.id },
    })),
  };
}

export function formatThinkCard(current?: string): CardView {
  const now = (current ?? "").trim() || "未知";
  return {
    title: `思考 · ${now}`,
    template: "indigo",
    markdown: `当前 **${now}**\n\n点按钮，或发 \`/think high\`。可用：${THINK_LEVELS.join(" / ")}`,
    buttons: THINK_LEVELS.map((level) => ({
      text: level,
      action: "set_think",
      type: level === now ? "primary" : "default",
      payload: { level },
    })),
  };
}

export const HELP_TEXT = `飞书里直接用 omp（A），也可以挂本机 TUI（B）。

**A · 飞书会话**
- 直接发文字：开/续这条对话的 \`omp --mode rpc\`
- \`/new\` 新开会话
- \`/cwd <目录>\` 换工作目录
- \`/model [名称]\` 查看 / 切换模型
- \`/think [off|low|medium|high|max|auto]\` 思考强度
- \`/abort\` 打断

**B · 挂已有 TUI**
- \`/list\` 列出本机正在跑的 TUI（含未开 collab 的）
- \`/attach [序号|pid|id]\` 接入；未分享的会先开启 collab
- \`/view [序号]\` 只读
- \`/leave\` 离开 collab，回到 A

\`/status\` 当前绑定。群里要 @机器人 或打 \`/\`。`;
